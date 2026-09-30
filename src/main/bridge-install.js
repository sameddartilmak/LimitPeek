'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app, dialog } = require('electron');
const { installClaudeStatusLine, removeClaudeStatusLine, statusLineState } = require('../core/setup/claude-bridge');
const {
  installAntigravityStatusLine,
  removeAntigravityStatusLine,
  antigravityStatusLineState,
} = require('../core/setup/antigravity-bridge');
const { installAgy, isAgyInstalled } = require('../core/antigravity/cli-install');
const { claudeSettingsPath, antigravitySettingsPath } = require('../core/paths');
const messages = require('../core/setup/messages');
const log = require('../core/log');
const { isStoreBuild, bridgeDirFor } = require('./packaging');
const { t } = require('../core/i18n');

/**
 * Materialises the bridge script somewhere Claude Code can actually run it and
 * then wires it in, behind the panel's own consent box (and, for the agy
 * download only, a native one).
 *
 * Why the copy: when packaged, `bridge/claude-statusline.mjs` lives inside
 * `app.asar`, which `node` cannot execute. A copy under userData is a real
 * file on disk in both dev and packaged builds, and it stays valid if the app
 * directory later moves. A Microsoft Store build keeps it under the home
 * directory instead, because MSIX redirects a fresh userData into a private
 * folder Claude Code cannot see (packaging.js).
 */
const BRIDGE_SCRIPTS = {
  claude: 'claude-statusline.mjs',
  antigravity: 'antigravity-statusline.mjs',
};

function bridgeSourcePath(script = BRIDGE_SCRIPTS.claude) {
  return path.join(app.getAppPath(), 'bridge', script);
}

function bridgeInstallPath(script = BRIDGE_SCRIPTS.claude) {
  return path.join(bridgeDirFor({ store: isStoreBuild(), userData: app.getPath('userData') }), script);
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
 * The gate before anything is written outside userData: `confirmed === true`
 * must arrive on the IPC call, and the renderer sends it only from the confirm
 * button of its own consent box, which shows the whole question first
 * (SetupAction.consent: the file, the backup, what the bridge reads, that the
 * user's own line is kept). That box replaced a second, native modal (owner,
 * 2026-09-30: the system dialog after the panel's own question looked foreign
 * and asked twice). The panel is click-opened now, not a hover surface, so a
 * confirm there is a deliberate press.
 */
async function runClaudeSetup({ confirmed }) {
  if (confirmed !== true) {
    return { ok: false, message: t('setup.notConfirmed', { tool: 'Claude Code' }) };
  }

  const state = statusLineState();
  if (state === 'ours') {
    return {
      ok: false,
      message: t('setup.alreadyInstalled', { tool: 'Claude Code' }),
    };
  }
  // A status line of the user's own is kept and chained, and the consent says so.
  const chainExisting = state === 'foreign';
  if (state === 'unreadable' || state === 'invalid') {
    return {
      ok: false,
      message: t('setup.settingsUnreadableOrInvalid', { tool: 'Claude Code' }),
    };
  }

  const settingsFile = claudeSettingsPath();
  const bridgePath = materialiseBridge();
  if (!bridgePath) {
    return { ok: false, message: t('setup.bridgePrepareFailed') };
  }

  const result = installClaudeStatusLine({ confirmed: true, bridgePath, settingsPath: settingsFile, chainExisting });
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
    return { ok: false, message: t('setup.notConfirmed', { tool: 'Antigravity' }) };
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
      message: t('setup.alreadyInstalled', { tool: 'Antigravity CLI' }),
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
      message: t('setup.settingsUnreadableOrInvalid', { tool: 'Antigravity' }),
    };
  }

  // Same gate as the Claude setup: the panel's own consent box, which named
  // this file and the bridge's promise (SetupAction.consent), sent
  // `confirmed`. The one native dialog left in setup is the agy DOWNLOAD
  // below: running a vendor install script is a different order of consent.
  return configureAntigravityBridge();
}

/**
 * Materialises the bridge and writes the statusLine hook. The shared tail of
 * both the "agy already installed" path and the one-click install path.
 */
function configureAntigravityBridge() {
  const bridgePath = materialiseBridge(BRIDGE_SCRIPTS.antigravity);
  if (!bridgePath) {
    return { ok: false, message: t('setup.bridgePrepareFailed') };
  }
  return installAntigravityStatusLine({
    confirmed: true,
    bridgePath,
    settingsPath: antigravitySettingsPath(),
  });
}

/**
 * Fits the 160-char notice budget the renderer trims at, in both languages
 * (`setup.test.js` measures it). A function, not a constant: the language is
 * the one current when the install finishes.
 */
const installedAndLogin = () => t('setup.agy.installedAndLogin');

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
    return { ok: false, message: t('setup.agy.noDownloadWithoutConsent') };
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
    buttons: [t('dialog.cancel'), t('dialog.downloadAndInstall')],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
    title: t('dialog.agyInstall.title'),
    message: t('dialog.agyInstall.message'),
    // Explicit about the MECHANISM, not just the destination. This step is
    // deliberate remote-code-execution and the app's sole network egress, so
    // the consent surface names it as plainly as the README does: it fetches
    // and runs the vendor's install script via PowerShell.
    detail: t('dialog.agyInstall.detail'),
  });
  if (choice.response !== 1) {
    return { ok: false, message: t('setup.cancelled') };
  }

  const install = await (installFn || installAgy)();
  if (!install.ok && install.code !== 'already') {
    log.warn(`agy install failed: code=${install.code}${install.detail ? ` detail=${install.detail}` : ''}`);
    if (install.code === 'unsupported') {
      return { ok: false, message: t('setup.agy.windowsOnly') };
    }
    return {
      ok: false,
      message: t('setup.agy.installFailed'),
    };
  }

  const configured = configureAntigravityBridge();
  if (!configured.ok) {
    // The binary is installed but the hook write failed. Honest: the install
    // half happened, the configure half did not.
    log.warn(`agy installed but hook config failed: code=${configured.code || 'UNKNOWN'}`);
    return {
      ok: false,
      message: t('setup.agy.installedBridgeFailed'),
    };
  }

  return { ok: true, message: installedAndLogin() };
}

/**
 * The "way back": remove the statusLine hook we installed. Reversible half of
 * the one-click setup. Leaves the agy binary in place — uninstalling a program
 * the user may use elsewhere is not ours to do; disconnecting our hook is.
 */
async function runAntigravityDisconnect({ confirmed }) {
  if (confirmed !== true) {
    return { ok: false, message: t('setup.agy.noTouchWithoutConsent') };
  }
  const result = removeAntigravityStatusLine({ settingsPath: antigravitySettingsPath() });
  return { ok: result.ok, message: result.message };
}

const DISCONNECT = {
  claude: { tool: 'Claude Code', state: () => statusLineState(), remove: () => removeClaudeStatusLine() },
  antigravity: {
    tool: 'Antigravity',
    state: () => antigravityStatusLineState(),
    remove: () => removeAntigravityStatusLine({ settingsPath: antigravitySettingsPath() }),
  },
};

/**
 * Whether our hook is in the tool's settings right now: what decides if the
 * settings screen offers "Bağlantıyı kaldır". Read-only, and false on any
 * doubt (unreadable or invalid settings, a line that is not ours).
 */
function hookInstalled(providerId) {
  const d = DISCONNECT[providerId];
  if (!d) return false;
  try { return d.state() === 'ours'; } catch { return false; }
}

/**
 * The DISCONNECT_PROVIDER implementation: takes our line out of the tool's
 * settings (and puts the user's own line back when the setup kept one).
 *
 * The question is asked in the panel, by the app's own confirmation box
 * (owner, 2026-09-30: the system message box looked foreign), and only its
 * confirm button sends `confirmed: true`. Anything else changes nothing. No
 * native dialog here: removing our own line, after a backup, is the one write
 * that only ever undoes what this app did.
 */
async function runDisconnect({ providerId, confirmed }) {
  const d = DISCONNECT[providerId];
  if (!d) return { ok: false, message: t('ipc.actionUnsupported') };
  if (confirmed !== true) return { ok: false, message: t('setup.cancelled') };
  if (!hookInstalled(providerId)) return { ok: true, message: t('setup.alreadyAbsent') };
  const result = d.remove();
  return { ok: result.ok, message: result.message };
}

/**
 * Uninstall: the NSIS uninstaller runs the app once with
 * `--cleanup-integrations` before it deletes the files, so no tool is left
 * running a bridge that belongs to an app that is gone. Removing the app is the
 * user's consent; nothing is asked. Each tool is independent and best effort.
 */
function cleanupIntegrations() {
  const out = {};
  for (const id of Object.keys(DISCONNECT)) {
    try {
      out[id] = hookInstalled(id) ? DISCONNECT[id].remove().code : 'NOT_OURS';
    } catch (err) {
      out[id] = `FAILED:${(err && err.code) || 'UNKNOWN'}`;
    }
  }
  return out;
}

module.exports = {
  runClaudeSetup,
  runDisconnect,
  hookInstalled,
  cleanupIntegrations,
  runAntigravitySetup,
  runAntigravityInstall,
  runAntigravityDisconnect,
  configureAntigravityBridge,
  materialiseBridge,
  bridgeInstallPath,
  bridgeSourcePath,
  BRIDGE_SCRIPTS,
};
