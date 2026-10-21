'use strict';

/**
 * How the taskbar strip draws each tile (Settings → Genel → Görünüm, "Şerit
 * stili", shown while the strip is the chosen view):
 *
 *   'plain'  per row: label, a mini bar, the figure, the time left. The
 *            default, and the look the strip had before the styles existed.
 *   'rings'  "Halkalı": a thick double ring (five-hour outside, weekly
 *            inside), the outer ring's figure large in its state colour and
 *            its time left under it.
 *   'fill'   "Dolgulu": the tile's own ground fills to the first row's figure
 *            in the state colour, that figure and its time left on top, and
 *            the weekly figure in a small chip at the right.
 *
 * Strip-only: the panel's gauge (bars or rings) no longer reaches the strip.
 * A sibling of `gauge.js`, for the same reason: the value comes out of a
 * hand-editable settings file, so anything that is not one of the three
 * literals lands on the default here and the strip page never has to guess.
 */

const STRIP_STYLES = Object.freeze(['plain', 'rings', 'fill']);

const DEFAULT_STRIP_STYLE = 'plain';

/** Exactly one of the three? No coercion, no case folding. */
function isStripStyle(value) {
  return typeof value === 'string' && STRIP_STYLES.includes(value);
}

/** Untrusted value -> a real StripStyle, always. */
function sanitizeStripStyle(raw) {
  return isStripStyle(raw) ? raw : DEFAULT_STRIP_STYLE;
}

module.exports = { STRIP_STYLES, DEFAULT_STRIP_STYLE, isStripStyle, sanitizeStripStyle };
