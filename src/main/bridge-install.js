'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app, dialog } = require('electron');
const { installClaudeStatusLine, statusLineState } = require('../core/setup/claude-bridge');
const {
  installAntigravityStatusLine,
  antigravityStatusLineState,
} = require('../core/setup/antigravity-bridge');
const { claudeSettingsPath, antigravitySettingsPath, antigravityHome } = require('../core/paths');
const messages = require('../core/setup/messages');
const log = require('../core/log');

/**
 * Materialises the bridge script somewhere Claude Code can actually run it and
 * then wires it in, behind a native consent prompt.
 *
 * Why the copy: when packaged, `bridge/claude-statusline.mjs` lives inside
 * `app.asar`, which `node` cannot execute. A copy under userData is a real
 * file on disk in both dev and packaged builds, and it stays valid if the app
 * directory later moves.
 */
const BRIDGE_SCRIPTS = {
  claude: 'claude-statusline.mjs',
  antigravity: 'antigravity-statusline.mjs',
};

function bridgeSourcePath(script = BRIDGE_SCRIPTS.claude) {
  return path.join(app.getAppPath(), 'bridge', script);
}

function bridgeInstallPath(script = BRIDGE_SCRIPTS.claude) {
  return path.join(app.getPath('userData'), 'bridge', script);
}

/**
 * @param {string} [script] file name under `bridge/`. Defaults to the Claude
 *   bridge so the existing call sites read unchanged.
 * @returns {string|null} the runnable path, or null if it could not be placed.
 */
function materialiseBridge(script = BRIDGE_SCRIPTS.claude) {
  const src = bridgeSourcePath(script);
  const dest = bridgeInstallPath(script);
  try {
    const contents = fs.readFileSync(src, 'utf8');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let current = null;
    try { current = fs.readFileSync(dest, 'utf8'); } catch { /* not there yet */ }
    if (current !== contents) {
      const tmp = `${dest}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, contents, 'utf8');
      fs.renameSync(tmp, dest);
    }
    return dest;
  } catch (err) {
    log.warn(`bridge copy failed (${script}): code=${(err && err.code) || 'UNKNOWN'}`);
    return null;
  }
}

/**
 * The RUN_SETUP implementation for the `claude` row.
 *
 * Two independent gates before anything is written outside userData:
 *   1. `confirmed === true` must arrive on the IPC call (the renderer showed
 *      the SetupAction.detail text first);
 *   2. a native modal, because the renderer is a transparent hover panel and
 *      an accidental click there must not be able to edit the user's Claude
 *      Code configuration.
 */
async function runClaudeSetup({ confirmed, parentWindow, beforePrompt }) {
  if (confirmed !== true) {
    return { ok: false, message: 'Onayınız olmadan Claude Code ayar dosyanıza yazmıyoruz.' };
  }

  const state = statusLineState();
  if (state === 'ours') {
    return {
      ok: false,
      message: 'Köprü zaten kurulu. Yüzde görünmüyorsa Claude Code oturumunu yeniden başlatın.',
    };
  }
  if (state === 'foreign') {
    const bridgePath = bridgeInstallPath();
    const cmd = `node "${bridgePath.split(path.sep).join('/')}"`;
    log.info(`claude statusLine already set; chain manually: ${cmd}`);
    return { ok: false, message: messages.statusLineExists(cmd) };
  }
  if (state === 'unreadable' || state === 'invalid') {
    return {
      ok: false,
      message: 'Claude Code ayar dosyası okunamadı veya geçerli JSON değil. Düzeltip tekrar deneyin.',
    };
  }

  const settingsFile = claudeSettingsPath();
  // Called ONLY on the path that actually raises a modal. Every branch above
  // returns without showing one, and the caller uses this hook to pin the
  // panel — a state the user did not choose, so it must not be entered for a
  // setup that turns out to be a no-op.
  if (typeof beforePrompt === 'function') beforePrompt();
  const choice = await dialog.showMessageBox(parentWindow || undefined, {
    type: 'question',
    buttons: ['Vazgeç', 'Ekle'],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
    title: 'Claude Code ayarına yazılsın mı?',
    message: 'Claude Code durum satırına Usage Notch köprüsü eklensin mi?',
    detail: `Şu dosya güncellenecek:\n${settingsFile}\n\n`
      + 'Önce zaman damgalı bir yedek alınır. Köprü yalnızca kullanım yüzdesini ve '
      + 'sıfırlanma zamanını okur; hiçbir metin, dosya yolu veya kimlik bilgisi kaydetmez '
      + 've hiçbir ağ bağlantısı açmaz.',
  });
  if (choice.response !== 1) {
    return { ok: false, message: 'İşlem iptal edildi. Hiçbir değişiklik yapılmadı.' };
  }

  const bridgePath = materialiseBridge();
  if (!bridgePath) {
    return { ok: false, message: 'Köprü betiği hazırlanamadı.' };
  }

  const result = installClaudeStatusLine({ confirmed: true, bridgePath, settingsPath: settingsFile });
  return { ok: result.ok, message: result.message };
}

/**
 * The RUN_SETUP implementation for the `antigravity` row.
 *
 * The Claude twin, with one branch it does not have: `agy` may simply not be
 * installed. That is a first-class outcome here — the user gets a sentence
 * naming the folder we looked in, and NOTHING is created. Writing a
 * settings.json for a CLI that is not on the machine would leave a file in the
 * user's home directory that nothing will ever read.
 */
async function runAntigravitySetup({ confirmed, parentWindow, beforePrompt }) {
  if (confirmed !== true) {
    return { ok: false, message: 'Onayınız olmadan Antigravity ayar dosyanıza yazmıyoruz.' };
  }

  const state = antigravityStatusLineState();
  if (state === 'not-installed') {
    // ONE source for this sentence. It previously existed here and in
    // `setup/antigravity-bridge.js`, which meant a fix to either left the
    // other one wrong — and this is the copy the user actually sees, because
    // this branch returns before the installer is ever called.
    log.info(`antigravity cli not found under ${antigravityHome()}`);
    return { ok: false, message: messages.cliNotFound(antigravityHome()) };
  }
  if (state === 'ours') {
    return {
      ok: false,
      message: 'Köprü zaten kurulu. Yüzde görünmüyorsa Antigravity CLI oturumunu yeniden başlatın.',
    };
  }
  if (state === 'foreign') {
    const bridgePath = bridgeInstallPath(BRIDGE_SCRIPTS.antigravity);
    const cmd = `node "${bridgePath.split(path.sep).join('/')}"`;
    log.info(`antigravity statusLine already set; chain manually: ${cmd}`);
    return { ok: false, message: messages.statusLineExists(cmd) };
  }
  if (state === 'unreadable' || state === 'invalid') {
    return {
      ok: false,
      message: 'Antigravity ayar dosyası okunamadı veya geçerli JSON değil. Düzeltip tekrar deneyin.',
    };
  }

  const settingsFile = antigravitySettingsPath();
  // Same rule as the Claude setup: called ONLY on the path that raises a
  // modal, because every branch above returns without showing one and the
  // caller uses this hook to pin the panel.
  if (typeof beforePrompt === 'function') beforePrompt();
  const choice = await dialog.showMessageBox(parentWindow || undefined, {
    type: 'question',
    buttons: ['Vazgeç', 'Ekle'],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
    title: 'Antigravity ayarına yazılsın mı?',
    message: 'Antigravity CLI durum satırına Usage Notch köprüsü eklensin mi?',
    detail: `Şu dosya güncellenecek:\n${settingsFile}\n\n`
      + 'Önce zaman damgalı bir yedek alınır. Köprü yalnızca kalan kota oranını ve '
      + 'sıfırlanma zamanını okur; hiçbir metin, dosya yolu, e-posta veya kimlik bilgisi '
      + 'kaydetmez ve hiçbir ağ bağlantısı açmaz.',
  });
  if (choice.response !== 1) {
    return { ok: false, message: 'İşlem iptal edildi. Hiçbir değişiklik yapılmadı.' };
  }

  const bridgePath = materialiseBridge(BRIDGE_SCRIPTS.antigravity);
  if (!bridgePath) {
    return { ok: false, message: 'Köprü betiği hazırlanamadı.' };
  }

  const result = installAntigravityStatusLine({
    confirmed: true,
    bridgePath,
    settingsPath: settingsFile,
  });
  return { ok: result.ok, message: result.message };
}

module.exports = {
  runClaudeSetup,
  runAntigravitySetup,
  materialiseBridge,
  bridgeInstallPath,
  bridgeSourcePath,
  BRIDGE_SCRIPTS,
};
