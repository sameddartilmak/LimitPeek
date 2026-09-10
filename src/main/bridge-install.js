'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app, dialog } = require('electron');
const { installClaudeStatusLine, statusLineState } = require('../core/setup/claude-bridge');
const {
  installAntigravityStatusLine,
  removeAntigravityStatusLine,
  antigravityStatusLineState,
} = require('../core/setup/antigravity-bridge');
const { installAgy, isAgyInstalled } = require('../core/antigravity/cli-install');
const { claudeSettingsPath, antigravitySettingsPath } = require('../core/paths');
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
async function runAntigravitySetup({ confirmed, parentWindow, beforePrompt, installFn }) {
  if (confirmed !== true) {
    return { ok: false, message: 'Onayınız olmadan Antigravity ayar dosyanıza yazmıyoruz.' };
  }

  const state = antigravityStatusLineState();
  if (state === 'not-installed') {
    // The one-click path. Where this used to hand the user a manual install
    // command, it now offers to download and install agy for them — behind an
    // explicit consent dialog that says so — and then configures the hook.
    return runAntigravityInstall({ confirmed, parentWindow, beforePrompt, installFn });
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

  return configureAntigravityBridge();
}

/**
 * Materialises the bridge and writes the statusLine hook. The shared tail of
 * both the "agy already installed" path and the one-click install path.
 */
function configureAntigravityBridge() {
  const bridgePath = materialiseBridge(BRIDGE_SCRIPTS.antigravity);
  if (!bridgePath) {
    return { ok: false, message: 'Köprü betiği hazırlanamadı.' };
  }
  return installAntigravityStatusLine({
    confirmed: true,
    bridgePath,
    settingsPath: antigravitySettingsPath(),
  });
}

/** Fits the 160-char notice budget the renderer trims at. */
const INSTALLED_AND_LOGIN =
  'Antigravity CLI kuruldu ve köprü eklendi. Haftalık limit için CLI\'ı bir kez '
  + 'çalıştırıp oturum açın.';

/**
 * One-click install of the `agy` CLI, then configure the statusline hook.
 *
 * The consent gate is the dialog raised here, and the SINGLE network operation
 * in the whole app sits immediately after it, in
 * `core/antigravity/cli-install.js`. The dialog states plainly that a download
 * from antigravity.google will run — this is a consented, one-time setup step,
 * not a runtime call.
 *
 * Fail-safe throughout: a decline, a failed download or a failed install all
 * leave the machine as it was and say so. Only a genuinely installed binary
 * proceeds to the hook.
 *
 * `installFn` is injected in tests so the suite never reaches the network.
 *
 * A known, honest limitation: agy authenticates SEPARATELY from the IDE (its
 * own keyring / browser sign-in, per the vendor docs), and its login state
 * cannot be read without touching a credential store — which this app never
 * does. So the flow cannot verify sign-in; it installs, configures, and tells
 * the user to run agy once and sign in. The weekly figure appears after that.
 */
async function runAntigravityInstall({ confirmed, parentWindow, beforePrompt, installFn }) {
  if (confirmed !== true) {
    return { ok: false, message: 'Onayınız olmadan indirme yapmıyoruz.' };
  }

  // Idempotent: if the binary is somehow already here, skip the download and
  // go straight to configuring the hook.
  //
  // Security residual (reviewed, INFO): a binary or symlink PLANTED at the agy
  // path only makes this skip the download and configure the hook — it is
  // never executed. Nothing in this app runs agy.exe; the only process it ever
  // launches is tasklist.exe (core/antigravity/process.js). A planted file is a
  // no-op here, not a code-execution vector.
  if (isAgyInstalled()) {
    log.info('antigravity cli already installed; skipping download');
    if (typeof beforePrompt === 'function') beforePrompt();
    const configured = configureAntigravityBridge();
    return { ok: configured.ok, message: configured.message };
  }

  if (typeof beforePrompt === 'function') beforePrompt();
  const choice = await dialog.showMessageBox(parentWindow || undefined, {
    type: 'question',
    buttons: ['Vazgeç', 'İndir ve kur'],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
    title: 'Antigravity CLI kurulsun mu?',
    message: 'Antigravity CLI (agy) indirilip kurulsun mu?',
    // Explicit about the MECHANISM, not just the destination. This step is
    // deliberate remote-code-execution and the app's sole network egress, so
    // the consent surface names it as plainly as the README does: it fetches
    // and runs the vendor's install script via PowerShell.
    detail: 'Bu adım, Antigravity\'nin resmi kurulum betiğini (install.ps1) '
      + 'antigravity.google adresinden indirip PowerShell ile çalıştırır — uygulamanın tek '
      + 'ağ erişimi budur ve yalnızca şimdi, sizin onayınızla olur. Kurulumdan sonra durum '
      + 'satırı köprüsü eklenir; köprü yalnızca kalan kota oranını ve sıfırlanma '
      + 'zamanını okur.',
  });
  if (choice.response !== 1) {
    return { ok: false, message: 'İşlem iptal edildi. Hiçbir değişiklik yapılmadı.' };
  }

  const install = await (installFn || installAgy)();
  if (!install.ok && install.code !== 'already') {
    log.warn(`agy install failed: code=${install.code}${install.detail ? ` detail=${install.detail}` : ''}`);
    if (install.code === 'unsupported') {
      return { ok: false, message: 'Otomatik kurulum yalnızca Windows\'ta destekleniyor.' };
    }
    return {
      ok: false,
      message: 'Antigravity CLI indirilemedi veya kurulamadı; hiçbir değişiklik yapılmadı. '
        + 'İnternet bağlantınızı kontrol edip tekrar deneyin.',
    };
  }

  const configured = configureAntigravityBridge();
  if (!configured.ok) {
    // The binary is installed but the hook write failed. Honest: the install
    // half happened, the configure half did not.
    log.warn(`agy installed but hook config failed: code=${configured.code || 'UNKNOWN'}`);
    return {
      ok: false,
      message: 'Antigravity CLI kuruldu ama köprü eklenemedi. Panelden tekrar deneyin.',
    };
  }

  return { ok: true, message: INSTALLED_AND_LOGIN };
}

/**
 * The "way back": remove the statusLine hook we installed. Reversible half of
 * the one-click setup. Leaves the agy binary in place — uninstalling a program
 * the user may use elsewhere is not ours to do; disconnecting our hook is.
 */
async function runAntigravityDisconnect({ confirmed }) {
  if (confirmed !== true) {
    return { ok: false, message: 'Onayınız olmadan ayar dosyanıza dokunmuyoruz.' };
  }
  const result = removeAntigravityStatusLine({ settingsPath: antigravitySettingsPath() });
  return { ok: result.ok, message: result.message };
}

module.exports = {
  runClaudeSetup,
  runAntigravitySetup,
  runAntigravityInstall,
  runAntigravityDisconnect,
  configureAntigravityBridge,
  materialiseBridge,
  bridgeInstallPath,
  bridgeSourcePath,
  BRIDGE_SCRIPTS,
};
