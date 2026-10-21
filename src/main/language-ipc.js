'use strict';
const { isLanguage, resolveLanguage } = require('../core/language');
const { sanitizeTheme, DEFAULT_THEME } = require('../core/theme');
const { sanitizeAutostart, DEFAULT_AUTOSTART } = require('./autostart-ipc');
const { sanitizeTrayView } = require('../core/tray-view');
const { sanitizeGauge } = require('../core/gauge');

/**
 * The main-process half of the language preference that talks to Electron and
 * to IPC, split out of `index.js` so the code that runs in the app is the code
 * that is tested: `test/language.test.js` drives the handler in plain Node, and
 * `scripts/smoke-ipc.js` registers this same handler in a real Electron process.
 * A smoke that re-implemented the handler would prove only its own copy.
 *
 * Nothing here requires `electron`; `app` and every side effect are passed in.
 */

/**
 * What Windows says about language, read through the two Electron 44 APIs that
 * actually report it. Measured, not taken from the docs:
 *
 *   - `app.getPreferredSystemLanguages()` returned the Windows language list
 *     verbatim (= `Get-WinUserLanguageList`), works BEFORE `ready`, and was
 *     unmoved by `--lang` and `LANG`. Its first entry is the display language.
 *   - `app.getSystemLocale()` returned the regional format (= `Get-Culture`),
 *     and THROWS before `ready`.
 *   - `app.getLocale()` is deliberately absent: it is Chromium's UI locale, ''
 *     before ready, and `--lang=en-GB` turned it into en-GB on a Turkish
 *     machine — a command-line switch is not the OS.
 *
 * Each read is guarded on its own, so a throw from one costs that signal only.
 * Safe to call before `ready`, which is what lets the startup-failure dialog
 * speak the user's language.
 *
 * @param {{getPreferredSystemLanguages?: Function, getSystemLocale?: Function}} app
 */
function osLocale(app) {
  let preferredLanguages = [];
  let systemLocale = null;
  try { preferredLanguages = app.getPreferredSystemLanguages() || []; } catch { /* absent signal */ }
  try { systemLocale = app.getSystemLocale() || null; } catch { /* before ready, or absent */ }
  return { preferredLanguages, systemLocale };
}

/**
 * The SET_LANGUAGE handler.
 *
 * Persist-then-apply, like SET_THEME, but with real work on the apply side and
 * therefore SET_ORDER's rollback rather than SET_THEME's best effort.
 *
 * After the write: `apply()` re-resolves and re-renders every main-owned
 * surface (tray menu, tooltip, the snapshot's setup text), THEN `push()` sends
 * PREFERENCES. The renderer is not optimistic here — it switches language only
 * on that push — so the push is last, and it goes out only once main already
 * speaks the new language.
 *
 * If applying throws after the file was written, the old value is restored in
 * memory, on disk and on screen, and `{ok:false}` is returned with no push.
 * Leaving the file on the new language while the renderer stayed on the old
 * one would disagree until the next launch.
 *
 * Synchronous end to end: main runs it to completion before the next message,
 * so two rapid changes cannot interleave two read-modify-write cycles.
 *
 * @param {object} deps
 * @param {(event: object) => boolean} deps.fromPanel
 * @param {() => object} deps.getSettings   the live settings object, mutated in place
 * @param {(settings: object) => boolean} deps.save
 * @param {() => void} deps.apply
 * @param {() => void} deps.push
 * @param {{warn: Function}} deps.log
 */
function createSetLanguageHandler({ fromPanel, getSettings, save, apply, push, log }) {
  return (event, language) => {
    if (!fromPanel(event)) return { ok: false };
    if (!isLanguage(language)) return { ok: false };

    const settings = getSettings();
    const previous = settings.language;
    settings.language = language;
    if (!save(settings)) {
      settings.language = previous;
      log.warn('language could not be persisted; nothing changed');
      return { ok: false };
    }
    try {
      apply();
    } catch (err) {
      settings.language = previous;
      if (!save(settings)) {
        log.warn('language rollback could not be persisted; settings.json still holds the rejected value');
      }
      try { apply(); } catch { /* already reported below */ }
      log.warn(`language could not be applied: code=${(err && err.code) || 'UNKNOWN'}`);
      return { ok: false };
    }
    push();
    return { ok: true };
  };
}

/**
 * Re-reads the OS and the stored choice, hands the answer to main's `t()`, and
 * returns it. `index.js` keeps the returned value as its one current locale:
 * the tray tooltip, the menu and the snapshot are all built from it, and they
 * must be built from the same answer the renderer is pushed.
 *
 * @param {object} deps
 * @param {() => object|null} deps.getSettings   null before settings loaded
 * @param {() => {preferredLanguages?: string[], systemLocale?: string|null}} deps.readOs
 * @param {(language: string, formatLocale: string) => void} deps.setLocale
 * @param {{info: Function}} deps.log
 */
function createLocaleResolver({ getSettings, readOs, setLocale, log }) {
  return () => {
    const settings = getSettings();
    const locale = resolveLanguage(settings && settings.language, readOs());
    setLocale(locale.resolvedLanguage, locale.formatLocale);
    log.info(`language: ${locale.language} -> ${locale.resolvedLanguage}, format ${locale.formatLocale}`);
    return locale;
  };
}

/**
 * The `apply` half of SET_LANGUAGE: re-resolve, then re-render every surface
 * MAIN writes text on — the tray menu, the tray tooltip, and the snapshot
 * (whose setup text main translates). Throws are left to the handler above,
 * which owns the rollback.
 *
 * The tooltip cache is reset BEFORE the re-publish, or the snapshot listener
 * would compare the new text against a string that has not changed yet and
 * skip the repaint. The re-publish goes through the collector's ordinary
 * 'snapshot' event, so the panel push and the tooltip both follow from it.
 *
 * @param {object} deps
 * @param {() => object} deps.refreshLocale
 * @param {() => ({setMenu: Function}|null)} deps.getTray
 * @param {() => object} deps.trayMenuOptions
 * @param {() => void} deps.resetTooltip
 * @param {() => ({rebuild: Function}|null)} deps.getCollector
 */
function createApplyLanguage({ refreshLocale, getTray, trayMenuOptions, resetTooltip, getCollector }) {
  return () => {
    refreshLocale();
    const tray = getTray();
    if (tray) tray.setMenu(trayMenuOptions());
    resetTooltip();
    const collector = getCollector();
    if (collector) collector.rebuild();
  };
}

/**
 * The Preferences object the renderer is entitled to see.
 *
 * Re-sanitised on the way out rather than trusted from `settings`: the value
 * came off disk, and an unrecognised one has to reach the renderer as the
 * DEFAULT, never as itself. A renderer handed `theme: 'nocturne'` would match
 * no palette and paint nothing.
 *
 * The language fields are the current resolved locale, verbatim — `en-GB`
 * stays `en-GB` — so the panel formats exactly as the tray does. Before the
 * first resolve (no current locale yet) it resolves on the spot.
 *
 * `autostart` is re-sanitised for the same reason the theme is: a switch
 * handed `"yes"` would show whatever its truthiness said, not the file.
 *
 * @param {object} deps
 * @param {() => object|null} deps.getSettings
 * @param {() => object|null} deps.currentLocale
 * @param {() => {preferredLanguages?: string[], systemLocale?: string|null}} deps.readOs
 * @param {() => boolean} [deps.storeBuild]
 * @param {() => boolean} [deps.stripAvailable]  false once the taskbar strip failed here
 * @param {() => boolean} [deps.stripNoRoom]  true while the strip finds no room on the taskbar
 */
function createPreferences({
  getSettings, currentLocale, readOs, storeBuild = () => false, stripAvailable = () => true, stripNoRoom = () => false,
}) {
  return () => {
    const settings = getSettings();
    const lang = currentLocale() || resolveLanguage(settings && settings.language, readOs());
    return {
      theme: settings ? sanitizeTheme(settings.theme) : DEFAULT_THEME,
      language: lang.language,
      resolvedLanguage: lang.resolvedLanguage,
      formatLocale: lang.formatLocale,
      autostart: settings ? sanitizeAutostart(settings.autostart) : DEFAULT_AUTOSTART,
      // A Store package: Windows owns start-at-sign-in (packaging.js).
      autostartByWindows: storeBuild() === true,
      // Only a real `false` shows the first-run card; anything else keeps it
      // closed, the safe side for a value that only ever hides a suggestion.
      setupCoachDismissed: !(settings && settings.setupCoachDismissed === false),
      trayView: sanitizeTrayView(settings && settings.trayView),
      // Only a real `false` (tried here and failed) says the strip cannot be
      // shown; until it is tried, nothing is known against it.
      stripAvailable: stripAvailable() !== false,
      // Only a real `true`: the strip is wanted but the taskbar has no room.
      stripNoRoom: stripNoRoom() === true,
      // Görünüm → Gösterge, re-sanitised: anything but 'ring' is the bars.
      gauge: sanitizeGauge(settings && settings.gauge),
    };
  };
}

module.exports = {
  osLocale,
  createSetLanguageHandler,
  createLocaleResolver,
  createApplyLanguage,
  createPreferences,
};
