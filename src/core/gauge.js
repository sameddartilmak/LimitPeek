'use strict';

/**
 * How the panel draws a tool's two usage windows (Settings → Genel →
 * Görünüm, "Gösterge"):
 *
 *   'bar'   two bars side by side, one per window. The default, and the look
 *           every earlier version had.
 *   'ring'  two concentric activity rings, five-hour outside and weekly
 *           inside (row.css, `html[data-gauge="ring"]`).
 *
 * The panel's list layout only ('focus' and 'tiles' always draw rings, see
 * layout.js); the tray donut and the taskbar strip (strip-style.js) are not
 * affected. A sibling
 * of `theme.js` and `tray-view.js`, for the same reason: the value comes out
 * of a hand-editable settings file, so a typo, a future value or a non-string
 * all land on the default here and nothing downstream has to decide what an
 * unknown gauge looks like.
 */

const GAUGES = Object.freeze(['bar', 'ring']);

const DEFAULT_GAUGE = 'bar';

/** Exactly one of the two? No coercion, no case folding. */
function isGauge(value) {
  return typeof value === 'string' && GAUGES.includes(value);
}

/** Untrusted value -> a real Gauge, always. */
function sanitizeGauge(raw) {
  return isGauge(raw) ? raw : DEFAULT_GAUGE;
}

module.exports = { GAUGES, DEFAULT_GAUGE, isGauge, sanitizeGauge };
