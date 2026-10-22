'use strict';
const { isStripStyle } = require('../core/strip-style');

/**
 * The SET_STRIP_STYLE handler: Settings → Genel → Görünüm, "Şerit stili:
 * Sade / Halkalı / Dolgulu". Split out of `index.js` so
 * `test/strip-style.test.js` can drive this exact function.
 *
 * Persist-then-push, synchronous end to end like SET_LAYOUT, so two rapid
 * picks cannot interleave two read-modify-write cycles over one settings
 * object and one file. The value is checked against the three literals, never
 * coerced: anything else is a bug or a hostile message.
 *
 * After the write, `apply()` hands the style to the taskbar strip, which
 * re-sends its tiles to the same window (best effort, like SET_TRAY_VIEW's
 * apply: the choice is stored either way), and `push()` sends PREFERENCES.
 *
 * `{ok:false}` means the value changed NOWHERE and the renderer must revert.
 *
 * @param {object} deps
 * @param {(event: object) => boolean} deps.fromPanel
 * @param {() => object} deps.getSettings   the live settings object, mutated in place
 * @param {(settings: object) => boolean} deps.save
 * @param {(style: 'plain'|'rings'|'fill') => void} [deps.apply]  the strip's redraw
 * @param {() => void} deps.push
 * @param {{warn: Function}} deps.log
 */
function createSetStripStyleHandler({ fromPanel, getSettings, save, apply = () => {}, push, log }) {
  return (event, style) => {
    if (!fromPanel(event)) return { ok: false };
    if (!isStripStyle(style)) return { ok: false };

    const settings = getSettings();
    const previous = settings.stripStyle;
    settings.stripStyle = style;
    if (!save(settings)) {
      settings.stripStyle = previous;
      log.warn('strip style could not be persisted; nothing changed');
      return { ok: false };
    }
    try { apply(style); } catch (err) {
      log.warn(`strip style could not be applied: code=${(err && err.code) || 'UNKNOWN'}`);
    }
    // Best effort, like SET_LAYOUT's: the renderer already shows the new
    // choice, so a push that fails costs an echo, not a disagreement.
    try { push(); } catch (err) {
      log.warn(`strip style push failed: code=${(err && err.code) || 'UNKNOWN'}`);
    }
    return { ok: true };
  };
}

module.exports = { createSetStripStyleHandler };
