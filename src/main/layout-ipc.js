'use strict';
const { isLayout } = require('../core/layout');

/**
 * The SET_LAYOUT handler: Settings → Genel → Görünüm, "Düzen: Sade liste /
 * Halka kutuları". Split out of `index.js` so `test/layout.test.js` can drive
 * this exact function.
 *
 * Persist-then-push, synchronous end to end, so two rapid picks cannot
 * interleave two read-modify-write cycles over one settings object and one
 * file. The value is checked against the two literals, never coerced and
 * never migrated: the old 'list' / 'focus' / 'tiles' are a settings file's
 * business (src/core/layout.js), and a renderer that sends one is a bug or a
 * hostile message.
 *
 * Nothing is applied in main: the layout is drawn by the renderer alone (the
 * tray donut and the strip do not change), so after the write there is only
 * the PREFERENCES push, which other listeners and a later reload read.
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
function createSetLayoutHandler({ fromPanel, getSettings, save, push, log }) {
  return (event, layout) => {
    if (!fromPanel(event)) return { ok: false };
    if (!isLayout(layout)) return { ok: false };

    const settings = getSettings();
    const previous = settings.layout;
    settings.layout = layout;
    if (!save(settings)) {
      settings.layout = previous;
      log.warn('layout could not be persisted; nothing changed');
      return { ok: false };
    }
    // Best effort: the renderer already shows the new layout, so a push that
    // fails costs an echo, not a disagreement.
    try { push(); } catch (err) {
      log.warn(`layout push failed: code=${(err && err.code) || 'UNKNOWN'}`);
    }
    return { ok: true };
  };
}

module.exports = { createSetLayoutHandler };
