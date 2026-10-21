'use strict';
const { isGauge } = require('../core/gauge');

/**
 * The SET_GAUGE handler: Settings → Genel → Görünüm, "Gösterge: Çubuk /
 * Halka". Split out of `index.js` for the reason `tray-view-ipc.js` is:
 * `test/gauge.test.js` drives this exact function.
 *
 * Persist-then-push, synchronous end to end like SET_THEME, so two rapid
 * picks cannot interleave two read-modify-write cycles over one settings
 * object and one file. The value is checked against the two literals, never
 * coerced: anything else is a bug or a hostile message.
 *
 * After the write, `apply()` hands the gauge to the taskbar strip (its tiles
 * draw mini rings for 'ring'; best effort, like SET_TRAY_VIEW's apply: the
 * choice is stored either way) and `push()` sends PREFERENCES. The tray donut
 * does not change.
 *
 * `{ok:false}` means the value changed NOWHERE and the renderer must revert.
 *
 * @param {object} deps
 * @param {(event: object) => boolean} deps.fromPanel
 * @param {() => object} deps.getSettings   the live settings object, mutated in place
 * @param {(settings: object) => boolean} deps.save
 * @param {(gauge: 'bar'|'ring') => void} [deps.apply]  the strip's redraw
 * @param {() => void} deps.push
 * @param {{warn: Function}} deps.log
 */
function createSetGaugeHandler({ fromPanel, getSettings, save, apply = () => {}, push, log }) {
  return (event, gauge) => {
    if (!fromPanel(event)) return { ok: false };
    if (!isGauge(gauge)) return { ok: false };

    const settings = getSettings();
    const previous = settings.gauge;
    settings.gauge = gauge;
    if (!save(settings)) {
      settings.gauge = previous;
      log.warn('gauge could not be persisted; nothing changed');
      return { ok: false };
    }
    try { apply(gauge); } catch (err) {
      log.warn(`gauge could not be applied: code=${(err && err.code) || 'UNKNOWN'}`);
    }
    // Best effort, like SET_THEME's: the renderer already shows the new
    // gauge, so a push that fails costs an echo, not a disagreement.
    try { push(); } catch (err) {
      log.warn(`gauge push failed: code=${(err && err.code) || 'UNKNOWN'}`);
    }
    return { ok: true };
  };
}

module.exports = { createSetGaugeHandler };
