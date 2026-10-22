'use strict';
const { isReduceTransparency } = require('../core/reduce-transparency');

/**
 * The SET_REDUCE_TRANSPARENCY handler: Settings → Genel → Görünüm,
 * "Saydamlığı azalt". Split out of `index.js` so
 * `test/reduce-transparency.test.js` can drive this exact function.
 *
 * Persist-then-push, synchronous end to end like SET_LAYOUT, so two rapid
 * flips cannot interleave two read-modify-write cycles over one settings
 * object and one file. The value must be a real boolean, never coerced:
 * anything else is a bug or a hostile message.
 *
 * Nothing is applied in main: the glass is drawn by the renderer alone, so
 * after the write there is only the PREFERENCES push.
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
function createSetReduceTransparencyHandler({ fromPanel, getSettings, save, push, log }) {
  return (event, reduce) => {
    if (!fromPanel(event)) return { ok: false };
    if (!isReduceTransparency(reduce)) return { ok: false };

    const settings = getSettings();
    const previous = settings.reduceTransparency;
    settings.reduceTransparency = reduce;
    if (!save(settings)) {
      settings.reduceTransparency = previous;
      log.warn('reduce transparency could not be persisted; nothing changed');
      return { ok: false };
    }
    // Best effort, like SET_LAYOUT's: the renderer already shows the change,
    // so a push that fails costs an echo, not a disagreement.
    try { push(); } catch (err) {
      log.warn(`reduce transparency push failed: code=${(err && err.code) || 'UNKNOWN'}`);
    }
    return { ok: true };
  };
}

module.exports = { createSetReduceTransparencyHandler };
