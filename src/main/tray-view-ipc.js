'use strict';
const { isTrayView } = require('../core/tray-view');

/**
 * The SET_TRAY_VIEW handler: Settings → Genel → Görünüm, "Tepsi simgesi" or
 * "Görev çubuğu şeridi". Split out of `index.js` for the reason
 * `autostart-ipc.js` is: `test/tray-view.test.js` drives this exact function.
 *
 * Persist-then-apply, synchronous end to end like SET_THEME, so two rapid
 * picks cannot interleave two read-modify-write cycles over one settings
 * object and one file. The value is checked against the two literals, never
 * coerced: anything else is a bug or a hostile message.
 *
 * After the write, `apply()` shows or removes the taskbar strip and `push()`
 * sends PREFERENCES, whose `stripAvailable` tells the settings screen whether
 * the strip could actually be shown. A strip that cannot be shown is NOT a
 * refusal: the choice is stored (the user made it, and a later version or a
 * repaired install may honour it), the app behaves as 'tray', and the screen
 * says why under the option. So apply is best effort, like SET_AUTOSTART's,
 * and `{ok:true}` still follows.
 *
 * `{ok:false}` means the value changed NOWHERE and the renderer must revert.
 *
 * @param {object} deps
 * @param {(event: object) => boolean} deps.fromPanel
 * @param {() => object} deps.getSettings   the live settings object, mutated in place
 * @param {(settings: object) => boolean} deps.save
 * @param {(view: 'tray'|'strip') => void} deps.apply
 * @param {() => void} deps.push
 * @param {{warn: Function}} deps.log
 */
function createSetTrayViewHandler({ fromPanel, getSettings, save, apply, push, log }) {
  return (event, view) => {
    if (!fromPanel(event)) return { ok: false };
    if (!isTrayView(view)) return { ok: false };

    const settings = getSettings();
    const previous = settings.trayView;
    settings.trayView = view;
    if (!save(settings)) {
      settings.trayView = previous;
      log.warn('tray view could not be persisted; nothing changed');
      return { ok: false };
    }
    try { apply(view); } catch (err) {
      log.warn(`tray view could not be applied: code=${(err && err.code) || 'UNKNOWN'}`);
    }
    push();
    return { ok: true };
  };
}

module.exports = { createSetTrayViewHandler };
