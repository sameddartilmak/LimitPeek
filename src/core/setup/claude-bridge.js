'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { claudeSettingsPath } = require('../paths');
const messages = require('./messages');
const { t } = require('../i18n');
const log = require('../log');

/**
 * Installs the statusline bridge into the user's Claude Code settings.
 *
 * This is the only code in the app that writes outside the app's own userData,
 * so it obeys three rules from ADR-001 ("consent, not clobbering"):
 *
 *   1. It never runs without an explicit confirmation flag from the caller.
 *   2. If a `statusLine` already exists it REFUSES, unless the caller passes
 *      `chainExisting: true` (the user was told their own line is kept). Then
 *      that entry is saved as-is in CHAIN_FILE beside the bridge, which runs it
 *      with the same stdin and prints its output, so the user's line looks
 *      exactly as before. It is never silently replaced.
 *   3. It takes a timestamped backup and writes tmp+rename, so a failure
 *      cannot leave a half-written settings.json — which would break the
 *      user's Claude Code entirely.
 */

function backupName(file, now) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  return `${file}.usagenotch-backup-${stamp}`;
}

/** The user's own status line, kept beside the bridge that runs it. */
const CHAIN_FILE_NAME = 'claude-chain.json';

function chainFileFor(bridgePath) {
  return path.join(path.dirname(bridgePath), CHAIN_FILE_NAME);
}

function statusLineEntry(bridgePath) {
  return {
    type: 'command',
    command: `node "${bridgePath.split(path.sep).join('/')}"`,
    padding: 0,
  };
}

/**
 * @param {object} opts
 * @param {boolean} opts.confirmed   must be strictly true
 * @param {string}  opts.bridgePath  absolute path to claude-statusline.mjs
 * @param {string} [opts.settingsPath]
 * @param {boolean} [opts.chainExisting] keep an existing statusLine by chaining it
 * @returns {{ok:boolean, message:string, code:string}}
 */
function installClaudeStatusLine(opts) {
  const now = opts.now ?? Date.now();
  const settingsFile = opts.settingsPath || claudeSettingsPath();
  const bridgePath = opts.bridgePath;

  if (opts.confirmed !== true) {
    return {
      ok: false,
      code: 'NOT_CONFIRMED',
      message: t('setup.notConfirmed', { tool: 'Claude Code' }),
    };
  }
  if (typeof bridgePath !== 'string' || bridgePath.length === 0) {
    return { ok: false, code: 'NO_BRIDGE', message: t('setup.noBridge') };
  }
  if (!fs.existsSync(bridgePath)) {
    return { ok: false, code: 'NO_BRIDGE', message: t('setup.noBridge') };
  }

  let settings = {};
  let existed = false;
  let original = null;
  let readStamp = null;
  try {
    original = fs.readFileSync(settingsFile, 'utf8');
    const st = fs.statSync(settingsFile);
    readStamp = { size: st.size, mtimeMs: st.mtimeMs };
    existed = true;
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      return {
        ok: false,
        code: 'SETTINGS_UNREADABLE',
        message: t('setup.settingsUnreadable', { tool: 'Claude Code' }),
      };
    }
  }

  if (existed) {
    try {
      settings = JSON.parse(original);
    } catch {
      // Never overwrite a file we could not parse: we would lose its contents.
      return {
        ok: false,
        code: 'SETTINGS_INVALID',
        message: t('setup.settingsInvalidJson', { tool: 'Claude Code' }),
      };
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return {
        ok: false,
        code: 'SETTINGS_INVALID',
        message: t('setup.settingsUnexpected', { tool: 'Claude Code' }),
      };
    }
    if (settings.statusLine != null && opts.chainExisting !== true) {
      const cmd = statusLineEntry(bridgePath).command;
      // The full command also goes to the log. This notice measured 194
      // characters with a real packaged bridge path against a 160-character
      // cap, so the cut landed inside the path and handed the user a command
      // that looks runnable and is not.
      log.info(`claude statusLine already set; chain manually: ${cmd}`);
      return {
        ok: false,
        code: 'STATUSLINE_EXISTS',
        message: messages.statusLineExists(cmd),
      };
    }
  }

  const dir = path.dirname(settingsFile);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, code: 'MKDIR_FAILED', message: t('setup.mkdirFailed') };
  }

  // Backup first. If we cannot back up an existing file, we do not touch it.
  let backupFile = null;
  if (existed) {
    backupFile = backupName(settingsFile, now);
    try {
      fs.writeFileSync(backupFile, original, { encoding: 'utf8', flag: 'wx' });
    } catch (err) {
      return {
        ok: false,
        code: 'BACKUP_FAILED',
        message: t('setup.backupFailed'),
      };
    }
  }

  /** An abort must leave no trace in the user's ~/.claude directory. */
  const discardBackup = () => {
    if (!backupFile) return;
    try { fs.unlinkSync(backupFile); } catch { /* best effort */ }
  };

  // The user's own line, kept before ours replaces it in settings.json.
  const chainFile = chainFileFor(bridgePath);
  let chained = false;
  if (existed && settings.statusLine != null) {
    try {
      fs.writeFileSync(chainFile, `${JSON.stringify({ schemaVersion: 1, statusLine: settings.statusLine }, null, 2)}
`, 'utf8');
      chained = true;
    } catch (err) {
      discardBackup();
      log.warn(`statusline chain could not be kept: code=${(err && err.code) || 'UNKNOWN'}`);
      return { ok: false, code: 'WRITE_FAILED', message: t('setup.writeFailed') };
    }
  }
  const discardChain = () => {
    if (!chained) return;
    try { fs.unlinkSync(chainFile); } catch { /* best effort */ }
  };

  settings.statusLine = statusLineEntry(bridgePath);

  const tmp = `${settingsFile}.${process.pid}.usagenotch.tmp`;
  try {
    // Claude Code owns this file too and can rewrite it at any moment. Between
    // our read and our rename there is a window where its change would be
    // silently reverted, so we re-check the file did not move under us. Not a
    // lock — the filesystem gives us none — but it closes the realistic gap.
    if (existed) {
      const now2 = fs.statSync(settingsFile);
      if (now2.size !== readStamp.size || now2.mtimeMs !== readStamp.mtimeMs) {
        // We wrote nothing, so the backup is of a file that still exists
        // unchanged. Leaving it would litter ~/.claude with a stale copy of
        // the user's settings on every aborted attempt.
        discardBackup();
        discardChain();
        return {
          ok: false,
          code: 'SETTINGS_CHANGED',
          message: t('setup.changedDuringWrite'),
        };
      }
    }

    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, settingsFile);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    discardBackup();
    discardChain();
    log.warn(`statusline install failed: code=${(err && err.code) || 'UNKNOWN'}`);
    return {
      ok: false,
      code: 'WRITE_FAILED',
      message: t('setup.writeFailed'),
    };
  }

  return {
    ok: true,
    code: 'INSTALLED',
    message: t('setup.claude.connected'),
  };
}

/** Read-only probe used to decide what the row's button should say. */
function statusLineState(settingsPath) {
  const file = settingsPath || claudeSettingsPath();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return (err && err.code === 'ENOENT') ? 'no-settings' : 'unreadable';
  }
  let json;
  try { json = JSON.parse(text); } catch { return 'invalid'; }
  if (!json || typeof json !== 'object') return 'invalid';
  if (json.statusLine == null) return 'none';
  const cmd = json.statusLine && json.statusLine.command;
  if (typeof cmd === 'string' && cmd.includes('claude-statusline.mjs')) return 'ours';
  return 'foreign';
}

/** The bridge path inside our own statusLine command, or null. */
function bridgePathFromCommand(cmd) {
  const m = typeof cmd === 'string' ? /"([^"]*claude-statusline\.mjs)"/.exec(cmd) : null;
  return m ? m[1] : null;
}

/**
 * The way back: takes our statusLine out of Claude Code's settings.
 *
 * Only a statusLine that is OURS is touched. If the setup kept the user's own
 * line (CHAIN_FILE beside the bridge), that entry is put back exactly as it
 * was; otherwise the key is removed and Claude Code shows no status line, as
 * before Usage Notch. A timestamped backup first, tmp+rename, and the same
 * moved-under-us check as the install. The kept file is deleted only after
 * the settings write succeeded, so a failure leaves nothing lost.
 *
 * @param {{settingsPath?:string, chainFile?:string, now?:number}} [opts]
 * @returns {{ok:boolean, code:string, message:string}}
 */
function removeClaudeStatusLine(opts = {}) {
  const now = opts.now ?? Date.now();
  const settingsFile = opts.settingsPath || claudeSettingsPath();

  let original;
  let readStamp;
  try {
    original = fs.readFileSync(settingsFile, 'utf8');
    const st = fs.statSync(settingsFile);
    readStamp = { size: st.size, mtimeMs: st.mtimeMs };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, code: 'ALREADY_ABSENT', message: t('setup.alreadyAbsent') };
    return { ok: false, code: 'SETTINGS_UNREADABLE', message: t('setup.settingsUnreadableShort', { tool: 'Claude Code' }) };
  }
  let settings;
  try {
    settings = JSON.parse(original);
  } catch {
    return { ok: false, code: 'SETTINGS_INVALID', message: t('setup.settingsInvalidJsonShort', { tool: 'Claude Code' }) };
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return { ok: false, code: 'SETTINGS_INVALID', message: t('setup.settingsUnexpected', { tool: 'Claude Code' }) };
  }
  if (settings.statusLine == null) return { ok: true, code: 'ALREADY_ABSENT', message: t('setup.alreadyAbsent') };
  const cmd = settings.statusLine.command;
  if (typeof cmd !== 'string' || !cmd.includes('claude-statusline.mjs')) {
    return { ok: false, code: 'STATUSLINE_FOREIGN', message: t('setup.statusLineForeign') };
  }

  const bridgePath = bridgePathFromCommand(cmd);
  const chainFile = opts.chainFile || (bridgePath ? chainFileFor(bridgePath) : null);
  let kept = null;
  if (chainFile) {
    try {
      const parsed = JSON.parse(fs.readFileSync(chainFile, 'utf8'));
      const line = parsed && parsed.statusLine;
      if (line && typeof line === 'object' && !Array.isArray(line)) kept = line;
    } catch { /* no kept line: the key is removed */ }
  }

  const backupFile = backupName(settingsFile, now);
  try {
    fs.writeFileSync(backupFile, original, { encoding: 'utf8', flag: 'wx' });
  } catch {
    return { ok: false, code: 'BACKUP_FAILED', message: t('setup.backupFailed') };
  }
  const discardBackup = () => { try { fs.unlinkSync(backupFile); } catch { /* best effort */ } };

  if (kept) settings.statusLine = kept;
  else delete settings.statusLine;

  const tmp = `${settingsFile}.${process.pid}.usagenotch.tmp`;
  try {
    const now2 = fs.statSync(settingsFile);
    if (now2.size !== readStamp.size || now2.mtimeMs !== readStamp.mtimeMs) {
      discardBackup();
      return { ok: false, code: 'SETTINGS_CHANGED', message: t('setup.changedDuringWrite') };
    }
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, settingsFile);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    discardBackup();
    log.warn(`claude statusline removal failed: code=${(err && err.code) || 'UNKNOWN'}`);
    return { ok: false, code: 'WRITE_FAILED', message: t('setup.writeFailed') };
  }
  if (kept) {
    try { fs.unlinkSync(chainFile); } catch { /* the line is restored; a stale copy is harmless */ }
    return { ok: true, code: 'RESTORED', message: t('setup.claude.restored') };
  }
  return { ok: true, code: 'REMOVED', message: t('setup.claude.removed') };
}

module.exports = {
  installClaudeStatusLine,
  removeClaudeStatusLine,
  statusLineState,
  statusLineEntry,
  backupName,
  chainFileFor,
  bridgePathFromCommand,
  CHAIN_FILE_NAME,
};
