'use strict';
const { isTransparency } = require('../core/transparency');

/**
 * The SET_TRANSPARENCY handler: Settings → Genel → Görünüm, the "Saydamlık"
 * slider. Split out of `index.js` so `test/transparency.test.js` can drive
 * this exact function.
 *
 * Persist-then-push, synchronous end to end like SET_STRIP_STYLE, so two rapid
 * steps cannot interleave two read-modify-write cycles over one settings
 * object and one file — and the slider sends a step every few tens of
 * milliseconds while it is dragged. The value must be an integer from 0 to
 * 100, never coerced: anything else is a bug or a hostile message.
 *
 * The push is also what applies it: index.js re-applies the window's look
 * (PanelWindow.setLook) before every PREFERENCES push, so the glass follows
 * the slider while it moves.
 *
 * `{ok:false}` means the value changed NOWHERE and the renderer must revert.
 *
 * @param {object} deps
 * @param {(event: object) => boolean} deps.fromPanel
 * @param {() => object} deps.getSettings   the live settings object, mutated in place
 * @param {(settings: object) => boolean} deps.save
 * @param {() => void} deps.push
 * @param {{warn: Function}} deps.log
 */
function createSetTransparencyHandler({ fromPanel, getSettings, save, push, log }) {
  return (event, level) => {
    if (!fromPanel(event)) return { ok: false };
    if (!isTransparency(level)) return { ok: false };

    const settings = getSettings();
    const previous = settings.transparency;
    settings.transparency = level;
    if (!save(settings)) {
      settings.transparency = previous;
      log.warn('transparency could not be persisted; nothing changed');
      return { ok: false };
    }
    // Best effort, like SET_STRIP_STYLE's: the renderer already shows the change,
    // so a push that fails costs an echo, not a disagreement.
    try { push(); } catch (err) {
      log.warn(`transparency push failed: code=${(err && err.code) || 'UNKNOWN'}`);
    }
    return { ok: true };
  };
}

module.exports = { createSetTransparencyHandler };
