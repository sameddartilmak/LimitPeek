'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/**
 * The uninstall question, asked in the app's own look (owner, 2026-10-01).
 *
 * WHY THE APP AND NOT THE UNINSTALLER
 * -----------------------------------
 * electron-builder's one-click uninstaller asks with a fixed system message
 * box ("… kaldırılsın mı?") in un.onInit, before any hook of ours can run. So
 * the Windows "Kaldır" entry is pointed at the app instead
 * (build/installer.nsh, customInstall rewrites UninstallString to
 * `"Usage Notch.exe" --uninstall`). This window says what will go and what is
 * never touched; "Kaldır" then starts the real uninstaller SILENTLY, so the
 * system box never appears, with `--delete-app-data` unless the user ticked
 * "keep". QuietUninstallString is left as electron-builder wrote it, so scripts
 * and `winget` still uninstall without any window.
 *
 * The page has no preload and no IPC: the translated words go in through the
 * URL hash, and the answer comes back as the document title.
 */

/** electron-builder's uninstaller, next to the app's exe. */
function uninstallerPath(exePath) {
  return path.join(path.dirname(exePath), 'Uninstall Usage Notch.exe');
}

/** Silent, per-user; app data goes unless the user asked to keep it. */
function uninstallerArgs(keepData) {
  return ['/S', '/currentuser', ...(keepData ? [] : ['--delete-app-data'])];
}

const TITLE_PREFIX = 'usage-notch-uninstall:';

/** `usage-notch-uninstall:remove:delete` -> { action, keepData }, or null. */
function parseAnswer(title) {
  if (typeof title !== 'string' || !title.startsWith(TITLE_PREFIX)) return null;
  const [action, data] = title.slice(TITLE_PREFIX.length).split(':');
  if (action !== 'remove' && action !== 'cancel') return null;
  return { action, keepData: data === 'keep' };
}

/**
 * The language and theme for the window, from the stored settings and the OS,
 * by the same resolver bootstrap uses (core/language.js), applied to main's
 * i18n so `t()` speaks it. This process never reaches bootstrap.
 */
function promptLook(stored, os, osDark) {
  const { resolveLanguage } = require('../core/language');
  const i18n = require('../core/i18n');
  const locale = resolveLanguage(stored && stored.language, os);
  i18n.setLocale(locale.resolvedLanguage, locale.formatLocale);
  const theme = stored && (stored.theme === 'light' || stored.theme === 'dark')
    ? stored.theme
    : (osDark ? 'dark' : 'light');
  return { lang: locale.resolvedLanguage, theme };
}

/** The words, in the language main resolved. */
function promptText(t) {
  return {
    title: t('uninstall.title'),
    lead: t('uninstall.lead'),
    items: [t('uninstall.item.app'), t('uninstall.item.data'), t('uninstall.item.bridge')],
    untouched: t('uninstall.untouched'),
    keepData: t('uninstall.keepData'),
    cancel: t('uninstall.cancel'),
    remove: t('uninstall.remove'),
  };
}

/**
 * Show the question and act on the answer. Resolves when the app may exit.
 * @param {{ BrowserWindow: any, t: Function, lang: string, theme: 'dark'|'light',
 *           exePath: string, log: { info: Function, warn: Function },
 *           spawnFn?: Function }} deps
 */
function runUninstallPrompt(deps) {
  const { BrowserWindow, t, lang, theme, exePath, log } = deps;
  const spawnFn = deps.spawnFn || spawn;
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 460,
      height: 430,
      useContentSize: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      frame: false,
      show: false,
      center: true,
      title: t('uninstall.windowTitle'),
      // --ink-900 of each theme (tokens.css), so the first frame is not white.
      backgroundColor: theme === 'light' ? '#F4F7F6' : '#0E1211',
      // spellcheck: false is a NETWORK control, not typography: Electron
      // downloads hunspell dictionaries the first time a field takes focus.
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, spellcheck: false },
    });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (!win.isDestroyed()) win.destroy();
      resolve();
    };
    win.on('page-title-updated', (event, title) => {
      event.preventDefault();
      const answer = parseAnswer(title);
      if (!answer) return;
      if (answer.action === 'cancel') {
        log.info('uninstall: cancelled in the prompt');
        finish();
        return;
      }
      const exe = uninstallerPath(exePath);
      if (!fs.existsSync(exe)) {
        log.warn('uninstall: uninstaller not found next to the app');
        finish();
        return;
      }
      // Detached and not waited for: the uninstaller closes every running
      // copy of the app, this one included.
      const child = spawnFn(exe, uninstallerArgs(answer.keepData), { detached: true, stdio: 'ignore', windowsHide: true });
      if (child && typeof child.unref === 'function') child.unref();
      log.info(`uninstall: started (keepData=${answer.keepData})`);
      finish();
    });
    win.on('closed', finish);
    // Fitted to the words before it is shown: the height differs by language.
    // Read-only script on our own local page; any failure keeps the default.
    win.once('ready-to-show', () => {
      Promise.resolve()
        .then(() => win.webContents.executeJavaScript("Math.ceil(document.querySelector('.un').getBoundingClientRect().height)"))
        .then((h) => {
          if (Number.isFinite(h) && h > 200 && h < 900 && !win.isDestroyed()) {
            win.setContentSize(460, h);
            win.center();
          }
        })
        .catch(() => {})
        .then(() => { if (!win.isDestroyed()) win.show(); });
    });
    const hash = encodeURIComponent(JSON.stringify({ lang, theme, text: promptText(t) }));
    win.loadFile(path.join(__dirname, 'uninstall', 'prompt.html'), { hash });
  });
}

module.exports = { runUninstallPrompt, uninstallerPath, uninstallerArgs, parseAnswer, promptText, promptLook };
