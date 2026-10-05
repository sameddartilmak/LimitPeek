'use strict';
const path = require('node:path');

/**
 * The uninstall question, asked in the app's own look (owner, 2026-10-01).
 *
 * WHO ASKS, AND HOW THE ANSWER TRAVELS
 * ------------------------------------
 * electron-builder's one-click uninstaller asks with a fixed system message
 * box in un.onInit unless it runs with /S. So Windows' "Kaldır" entry runs the
 * REAL uninstaller silently with one extra flag (`/S --ask`, written by
 * build/installer.nsh customInstall), and the uninstaller's customUnInit, on
 * seeing --ask, starts this app as `Usage Notch.exe --uninstall-ask`, WAITS,
 * and reads the answer from the exit code:
 *
 *   0  remove, and delete the app's data (the default)
 *   1  remove, keep the data ("Ayarlarımı ve kullanım geçmişimi sakla")
 *   2  cancel: the uninstaller quits, nothing is removed
 *
 * The entry must keep naming the uninstaller: an update finds the old version's
 * uninstaller by reading that very value (installUtil.nsh uninstallOldVersion).
 * Pointing it at the app instead — the first version of this, 0.6.11 — made
 * every update fail ("Failed to uninstall old application files").
 *
 * The page has no preload and no IPC: the translated words go in through the
 * URL hash, and the answer comes back as the document title.
 */

const EXIT = Object.freeze({ REMOVE_DELETE: 0, REMOVE_KEEP: 1, CANCEL: 2 });

const TITLE_PREFIX = 'usage-notch-uninstall:';

/** `usage-notch-uninstall:remove:delete` -> { action, keepData }, or null. */
function parseAnswer(title) {
  if (typeof title !== 'string' || !title.startsWith(TITLE_PREFIX)) return null;
  const [action, data] = title.slice(TITLE_PREFIX.length).split(':');
  if (action !== 'remove' && action !== 'cancel') return null;
  return { action, keepData: data === 'keep' };
}

/** The exit code the uninstaller reads for an answer (null = closed = cancel). */
function exitCodeFor(answer) {
  if (!answer || answer.action === 'cancel') return EXIT.CANCEL;
  return answer.keepData ? EXIT.REMOVE_KEEP : EXIT.REMOVE_DELETE;
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
 * Show the question; resolves with the exit code for the uninstaller.
 * @param {{ BrowserWindow: any, t: Function, lang: string, theme: 'dark'|'light',
 *           log: { info: Function } }} deps
 * @returns {Promise<number>}
 */
function runUninstallPrompt(deps) {
  const { BrowserWindow, t, lang, theme, log } = deps;
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
      alwaysOnTop: true,
      title: t('uninstall.windowTitle'),
      // --ink-900 of each theme (tokens.css), so the first frame is not white.
      backgroundColor: theme === 'light' ? '#F4F7F6' : '#0E1211',
      // spellcheck: false is a NETWORK control, not typography: Electron
      // downloads hunspell dictionaries the first time a field takes focus.
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, spellcheck: false },
    });
    let answered = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const code = exitCodeFor(answered);
      log.info(`uninstall prompt: exit ${code}`);
      if (!win.isDestroyed()) win.destroy();
      resolve(code);
    };
    win.on('page-title-updated', (event, title) => {
      event.preventDefault();
      const answer = parseAnswer(title);
      if (!answer) return;
      answered = answer;
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

module.exports = { runUninstallPrompt, parseAnswer, exitCodeFor, promptText, promptLook, EXIT };
