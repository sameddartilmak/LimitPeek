'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { claudeSettingsPath } = require('../paths');
const messages = require('./messages');
const log = require('../log');

/**
 * Installs the statusline bridge into the user's Claude Code settings.
 *
 * This is the only code in the app that writes outside the app's own userData,
 * so it obeys three rules from ADR-001 ("consent, not clobbering"):
 *
 *   1. It never runs without an explicit confirmation flag from the caller.
 *   2. If a `statusLine` already exists it REFUSES. Chaining another user's
 *      status line command correctly is not something we can do blind, and
 *      silently replacing it would take away a feature they configured.
 *   3. It takes a timestamped backup and writes tmp+rename, so a failure
 *      cannot leave a half-written settings.json — which would break the
 *      user's Claude Code entirely.
 */

function backupName(file, now) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  return `${file}.usagenotch-backup-${stamp}`;
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
      message: 'Onayınız olmadan Claude Code ayar dosyanıza yazmıyoruz.',
    };
  }
  if (typeof bridgePath !== 'string' || bridgePath.length === 0) {
    return { ok: false, code: 'NO_BRIDGE', message: 'Köprü betiği bulunamadı.' };
  }
  if (!fs.existsSync(bridgePath)) {
    return { ok: false, code: 'NO_BRIDGE', message: 'Köprü betiği bulunamadı.' };
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
        message: 'Claude Code ayar dosyası okunamadı. Dosya izinlerini kontrol edin.',
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
        message: 'Claude Code ayar dosyası geçerli JSON değil. Düzeltip tekrar deneyin.',
      };
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return {
        ok: false,
        code: 'SETTINGS_INVALID',
        message: 'Claude Code ayar dosyası beklenen biçimde değil.',
      };
    }
    if (settings.statusLine != null) {
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
    return { ok: false, code: 'MKDIR_FAILED', message: 'Ayar klasörü oluşturulamadı.' };
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
        message: 'Ayar dosyasının yedeği alınamadı; hiçbir değişiklik yapılmadı.',
      };
    }
  }

  /** An abort must leave no trace in the user's ~/.claude directory. */
  const discardBackup = () => {
    if (!backupFile) return;
    try { fs.unlinkSync(backupFile); } catch { /* best effort */ }
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
        return {
          ok: false,
          code: 'SETTINGS_CHANGED',
          message: 'Ayar dosyası bu sırada başka bir işlem tarafından değiştirildi; '
            + 'hiçbir değişiklik yapılmadı. Tekrar deneyin.',
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
    log.warn(`statusline install failed: code=${(err && err.code) || 'UNKNOWN'}`);
    return {
      ok: false,
      code: 'WRITE_FAILED',
      message: 'Ayar dosyası yazılamadı; hiçbir değişiklik yapılmadı.',
    };
  }

  return {
    ok: true,
    code: 'INSTALLED',
    message: 'Bağlandı. Claude Code oturumunu yeniden başlatın; yüzde birkaç saniye içinde görünür.',
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

module.exports = { installClaudeStatusLine, statusLineState, statusLineEntry, backupName };
