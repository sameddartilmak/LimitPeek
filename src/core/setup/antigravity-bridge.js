'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {
  antigravityHome,
  antigravityDefaultHome,
  antigravityHomeOverridden,
  antigravitySettingsPath,
} = require('../paths');
const { isAgyInstalled } = require('../antigravity/cli-install');
const messages = require('./messages');
const log = require('../log');

/**
 * Installs the statusline bridge into the user's Antigravity CLI settings.
 *
 * The structural twin of `claude-bridge.js`, obeying the same three rules from
 * ADR-001 ("consent, not clobbering"):
 *
 *   1. It never runs without an explicit confirmation flag from the caller.
 *   2. If a `statusLine` already exists it REFUSES. Chaining another user's
 *      status line command correctly is not something we can do blind, and
 *      silently replacing it would take away a feature they configured.
 *   3. It takes a timestamped backup and writes tmp+rename, so a failure
 *      cannot leave a half-written settings.json — which would break the
 *      user's `agy` CLI entirely.
 *
 * One rule this file has that the Claude one does not:
 *
 *   4. If the CLI is not installed, we CREATE NOTHING. `claude-bridge.js`
 *      happily mkdirs `~/.claude` because a missing settings.json there is the
 *      normal first-run state of a tool the user demonstrably has. Here the
 *      absence of `~/.gemini/antigravity-cli/` means `agy` is not on this
 *      machine at all, and writing a settings file for a program that does not
 *      exist would leave litter in the user's home directory that nothing will
 *      ever read. That case gets its own outcome and its own sentence.
 *
 * Only the `statusLine` key is ever read or written. `~/.gemini` also holds
 * the CLI's auth material; nothing here goes near it.
 */

function backupName(file, now) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  return `${file}.usagenotch-backup-${stamp}`;
}

/**
 * The block the doc specifies: `{ type: 'command', command: '<cmd>' }`.
 * `padding: 0` is one of the three optional keys the doc lists, and it keeps
 * the CLI from inserting blank lines above our single-line output.
 *
 * NO quotes around the path. agy runs the command through a parser that splits
 * on whitespace and keeps the quote characters as part of the argument, so
 * `node "C:/…/x.mjs"` reaches node as the literal token `"C:/…/x.mjs"` — quotes
 * and all — which node then treats as a RELATIVE module id and resolves against
 * the agy session's cwd, failing with "Cannot find module …\"C:/…/x.mjs\"".
 * (Observed on Windows; the log line is `statusline_runner.go … exit status 1`.)
 * An unquoted absolute path splits cleanly into `node` + the path. The residual
 * limitation — a bridge path containing a SPACE — has no fix on agy's side:
 * quoted, the quotes leak; unquoted, the space splits it. userData lives under
 * `%APPDATA%\usage-notch`, so this only bites a Windows username with a space,
 * and there is no command string that agy's splitter would accept for it.
 */
function statusLineEntry(bridgePath) {
  return {
    type: 'command',
    command: `node ${bridgePath.split(path.sep).join('/')}`,
    padding: 0,
  };
}

/**
 * True when the `agy` CLI is on this machine.
 *
 * Answered by the BINARY first, then by the config directory. The binary is
 * the real proof of installation — a freshly installed CLI has `agy.exe` but
 * not yet `~/.gemini/antigravity-cli/`, which agy creates the first time it
 * runs. Checking only the config dir (as this once did) meant a one-click
 * install left the row still saying "not installed" until the user happened to
 * run agy by hand.
 *
 * The config dir is still accepted on its own, so a machine where agy has run
 * at least once — and therefore has the dir but where the binary probe might
 * be pointed elsewhere by a custom `homeDir` in a test — still reads as
 * installed.
 */
function cliInstalled(homeDir) {
  if (isAgyInstalled()) return true;
  const dir = homeDir || antigravityHome();
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {object} opts
 * @param {boolean} opts.confirmed   must be strictly true
 * @param {string}  opts.bridgePath  absolute path to antigravity-statusline.mjs
 * @param {string} [opts.settingsPath]
 * @param {string} [opts.homeDir]    the CLI config dir; defaults to the real one
 * @returns {{ok:boolean, message:string, code:string}}
 */
function installAntigravityStatusLine(opts) {
  const now = opts.now ?? Date.now();
  const settingsFile = opts.settingsPath || antigravitySettingsPath();
  const homeDir = opts.homeDir || path.dirname(settingsFile);
  const bridgePath = opts.bridgePath;

  if (opts.confirmed !== true) {
    return {
      ok: false,
      code: 'NOT_CONFIRMED',
      message: 'Onayınız olmadan Antigravity ayar dosyanıza yazmıyoruz.',
    };
  }
  if (typeof bridgePath !== 'string' || bridgePath.length === 0) {
    return { ok: false, code: 'NO_BRIDGE', message: 'Köprü betiği bulunamadı.' };
  }
  if (!fs.existsSync(bridgePath)) {
    return { ok: false, code: 'NO_BRIDGE', message: 'Köprü betiği bulunamadı.' };
  }

  if (antigravityHomeOverridden(homeDir)) {
    // The FULL paths go here, where there is no character budget and where a
    // "why is my percentage missing" report can find them.
    log.warn(
      `antigravity home overridden by ANTIGRAVITY_CLI_DIR: using ${homeDir} `
      + `instead of ${antigravityDefaultHome()}`,
    );
  }

  // Checked BEFORE anything is read or created. See rule 4 above.
  if (!cliInstalled(homeDir)) {
    log.info(`antigravity cli not found under ${homeDir}`);
    return { ok: false, code: 'CLI_NOT_FOUND', message: messages.cliNotFound(homeDir) };
  }

  // agy is installed (binary present) but may not have run yet, so its config
  // directory can be missing. Create it now — this is not "writing settings
  // for a CLI that is not there", the guard above already proved it is there;
  // it is giving the hook a directory to live in. mkdir is recursive and a
  // no-op when the directory already exists.
  try {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  } catch (err) {
    return {
      ok: false,
      code: 'MKDIR_FAILED',
      message: 'Antigravity ayar klasörü oluşturulamadı; hiçbir değişiklik yapılmadı.',
    };
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
        message: 'Antigravity ayar dosyası okunamadı. Dosya izinlerini kontrol edin.',
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
        message: 'Antigravity ayar dosyası geçerli JSON değil. Düzeltip tekrar deneyin.',
      };
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return {
        ok: false,
        code: 'SETTINGS_INVALID',
        message: 'Antigravity ayar dosyası beklenen biçimde değil.',
      };
    }
    if (settings.statusLine != null) {
      const cmd = statusLineEntry(bridgePath).command;
      // The full command also goes to the log: the notice has a 160-character
      // budget and a long enough install path could still push it out.
      log.info(`antigravity statusLine already set; chain manually: ${cmd}`);
      return {
        ok: false,
        code: 'STATUSLINE_EXISTS',
        message: messages.statusLineExists(cmd),
      };
    }
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

  /** An abort must leave no trace in the user's ~/.gemini directory. */
  const discardBackup = () => {
    if (!backupFile) return;
    try { fs.unlinkSync(backupFile); } catch { /* best effort */ }
  };

  settings.statusLine = statusLineEntry(bridgePath);

  const tmp = `${settingsFile}.${process.pid}.usagenotch.tmp`;
  try {
    // The CLI owns this file too and can rewrite it at any moment. Between our
    // read and our rename there is a window where its change would be silently
    // reverted, so we re-check the file did not move under us. Not a lock —
    // the filesystem gives us none — but it closes the realistic gap.
    if (existed) {
      const now2 = fs.statSync(settingsFile);
      if (now2.size !== readStamp.size || now2.mtimeMs !== readStamp.mtimeMs) {
        // We wrote nothing, so the backup is of a file that still exists
        // unchanged. Leaving it would litter the CLI's config directory with a
        // stale copy of the user's settings on every aborted attempt.
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
    log.warn(`antigravity statusline install failed: code=${(err && err.code) || 'UNKNOWN'}`);
    return {
      ok: false,
      code: 'WRITE_FAILED',
      message: 'Ayar dosyası yazılamadı; hiçbir değişiklik yapılmadı.',
    };
  }

  return { ok: true, code: 'INSTALLED', message: messages.installed(homeDir) };
}

/**
 * Removes the Usage Notch statusLine hook — the "way back" for the one-click
 * setup.
 *
 * Reversible by construction, and conservative: it only ever removes a
 * statusLine that is OURS (its command names our bridge script). A foreign or
 * absent one is left exactly as found, so a user who chained their own command
 * cannot lose it here. A timestamped backup is taken before the write, the
 * same as the install path.
 *
 * @returns {{ok:boolean, code:string, message:string}}
 */
function removeAntigravityStatusLine(opts = {}) {
  const now = opts.now ?? Date.now();
  const settingsFile = opts.settingsPath || antigravitySettingsPath();

  let original;
  try {
    original = fs.readFileSync(settingsFile, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ok: true, code: 'ALREADY_ABSENT', message: 'Köprü zaten kurulu değil.' };
    }
    return { ok: false, code: 'SETTINGS_UNREADABLE', message: 'Antigravity ayar dosyası okunamadı.' };
  }

  let settings;
  try {
    settings = JSON.parse(original);
  } catch {
    return { ok: false, code: 'SETTINGS_INVALID', message: 'Antigravity ayar dosyası geçerli JSON değil.' };
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return { ok: false, code: 'SETTINGS_INVALID', message: 'Antigravity ayar dosyası beklenen biçimde değil.' };
  }

  const cmd = settings.statusLine && settings.statusLine.command;
  const ours = typeof cmd === 'string' && cmd.includes('antigravity-statusline.mjs');
  if (settings.statusLine == null) {
    return { ok: true, code: 'ALREADY_ABSENT', message: 'Köprü zaten kurulu değil.' };
  }
  if (!ours) {
    // Never touch a statusLine we did not write.
    return { ok: false, code: 'STATUSLINE_FOREIGN', message: 'Bu statusLine bize ait değil; kaldırmıyoruz.' };
  }

  const backupFile = backupName(settingsFile, now);
  try {
    fs.writeFileSync(backupFile, original, { encoding: 'utf8', flag: 'wx' });
  } catch {
    return { ok: false, code: 'BACKUP_FAILED', message: 'Ayar dosyasının yedeği alınamadı; hiçbir değişiklik yapılmadı.' };
  }

  delete settings.statusLine;
  const tmp = `${settingsFile}.${process.pid}.usagenotch.tmp`;
  try {
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
    try { fs.unlinkSync(backupFile); } catch { /* best effort */ }
    log.warn(`antigravity statusline removal failed: code=${(err && err.code) || 'UNKNOWN'}`);
    return { ok: false, code: 'WRITE_FAILED', message: 'Ayar dosyası yazılamadı; hiçbir değişiklik yapılmadı.' };
  }
  return { ok: true, code: 'REMOVED', message: 'Bağlantı kaldırıldı. Haftalık limit artık okunmayacak.' };
}

/**
 * Read-only probe used to decide what the row's button should say.
 *
 * `not-installed` comes first and is checked against the DIRECTORY, not the
 * settings file: a user without `agy` and a user with `agy` but no settings.json
 * yet need different sentences, and only the directory tells them apart.
 */
function antigravityStatusLineState(settingsPath, homeDir) {
  const file = settingsPath || antigravitySettingsPath();
  const dir = homeDir || path.dirname(file);
  if (!cliInstalled(dir)) return 'not-installed';

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
  if (typeof cmd === 'string' && cmd.includes('antigravity-statusline.mjs')) return 'ours';
  return 'foreign';
}

module.exports = {
  installAntigravityStatusLine,
  removeAntigravityStatusLine,
  antigravityStatusLineState,
  statusLineEntry,
  cliInstalled,
  backupName,
};
