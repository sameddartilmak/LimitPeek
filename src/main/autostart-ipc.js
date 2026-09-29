'use strict';

/**
 * The main-process half of "start with Windows" that talks to IPC, split out
 * of `index.js` for the reason `language-ipc.js` is: `test/autostart.test.js`
 * drives this exact handler in plain Node, so the code that runs in the app is
 * the code that is tested.
 *
 * One value, two controls. The tray menu's checkbox and the settings screen's
 * switch both read and write `settings.autostart`; whichever one moves it, the
 * other is brought along — the settings screen by a PREFERENCES push, the tray
 * by rebuilding its menu (Electron keeps no live binding to a menu item).
 *
 * Nothing here requires `electron`; every side effect is passed in.
 */

/** Shipped default, the same as `settings.js` DEFAULTS.autostart. */
const DEFAULT_AUTOSTART = true;

/** Untrusted value -> a real boolean, always. Anything else is the default. */
function sanitizeAutostart(raw) {
  return typeof raw === 'boolean' ? raw : DEFAULT_AUTOSTART;
}

/**
 * The SET_AUTOSTART handler.
 *
 * Persist-then-apply, like SET_THEME, and synchronous for the same reason:
 * main runs it to completion before the next message, so two rapid taps on
 * the switch cannot interleave two read-modify-write cycles over one settings
 * object and one file.
 *
 * The flag is checked with `typeof 'boolean'` rather than coerced, as
 * SET_ENABLED does. A string or a number here is a bug or a hostile message,
 * and `Boolean('false')` is `true`.
 *
 * After the write: `apply()` updates the Windows login item, `rebuildTrayMenu()`
 * makes the menu's checkbox show the new value, then `push()` sends
 * PREFERENCES. The apply side is best effort and deliberately NOT a rollback
 * trigger, like SET_THEME's push: `applyAutostart` already logs and swallows
 * its own failure, the file is the truth that the next launch re-applies, and
 * a failing menu rebuild costs a stale checkbox, not a disagreement with the
 * file. So each step is guarded on its own and `{ok:true}` still follows.
 *
 * `{ok:false}` means the value changed NOWHERE and the renderer must revert.
 *
 * @param {object} deps
 * @param {(event: object) => boolean} deps.fromPanel
 * @param {() => object} deps.getSettings   the live settings object, mutated in place
 * @param {(settings: object) => boolean} deps.save
 * @param {(enabled: boolean) => void} deps.apply
 * @param {() => void} deps.rebuildTrayMenu
 * @param {() => void} deps.push
 * @param {{warn: Function}} deps.log
 */
function createSetAutostartHandler({ fromPanel, getSettings, save, apply, rebuildTrayMenu, push, log }) {
  return (event, enabled) => {
    if (!fromPanel(event)) return { ok: false };
    if (typeof enabled !== 'boolean') return { ok: false };

    const settings = getSettings();
    const previous = settings.autostart;
    settings.autostart = enabled;
    if (!save(settings)) {
      settings.autostart = previous;
      log.warn('autostart could not be persisted; nothing changed');
      return { ok: false };
    }
    try { apply(enabled); } catch (err) {
      log.warn(`autostart could not be applied: code=${(err && err.code) || 'UNKNOWN'}`);
    }
    try { rebuildTrayMenu(); } catch (err) {
      log.warn(`tray menu could not be rebuilt: code=${(err && err.code) || 'UNKNOWN'}`);
    }
    push();
    return { ok: true };
  };
}

/**
 * The SET_SETUP_COACH_DISMISSED handler: "Şimdi değil" on the first-run card,
 * persisted so the card does not come back after a restart.
 *
 * Persist-then-push, refused (nothing changed) on a non-boolean or a failed
 * write, exactly like SET_AUTOSTART minus the login-item and tray steps, which
 * this value has no part in.
 *
 * @param {object} deps
 * @param {(event: object) => boolean} deps.fromPanel
 * @param {() => object} deps.getSettings
 * @param {(settings: object) => boolean} deps.save
 * @param {() => void} deps.push
 * @param {{warn: Function}} deps.log
 */
function createSetSetupCoachDismissedHandler({ fromPanel, getSettings, save, push, log }) {
  return (event, dismissed) => {
    if (!fromPanel(event)) return { ok: false };
    if (typeof dismissed !== 'boolean') return { ok: false };
    const settings = getSettings();
    const previous = settings.setupCoachDismissed;
    settings.setupCoachDismissed = dismissed;
    if (!save(settings)) {
      settings.setupCoachDismissed = previous;
      log.warn('setup coach state could not be persisted; nothing changed');
      return { ok: false };
    }
    push();
    return { ok: true };
  };
}

module.exports = {
  createSetSetupCoachDismissedHandler,
  DEFAULT_AUTOSTART,
  sanitizeAutostart,
  createSetAutostartHandler,
};
