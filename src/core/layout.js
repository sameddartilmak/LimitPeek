'use strict';

/**
 * How the panel lays out the tools (Settings → Genel → Görünüm, "Düzen"):
 *
 *   'list'   one card per tool, the look every earlier version had. The
 *            default, and the only layout the gauge (bars or rings) applies to.
 *   'focus'  "Öne çıkan": the tool closest to its limit as a large double
 *            ring at the top, one compact row per other tool under it
 *            (styles/layout-focus.css, `html[data-layout="focus"]`).
 *   'tiles'  "Kutucuklar": a two-column grid of tiles, each a double ring
 *            with the five-hour figure in it, and quick tiles under the grid
 *            (styles/layout-tiles.css, `html[data-layout="tiles"]`).
 *
 * Panel-only: the tray donut and the taskbar strip are not affected. A sibling
 * of `gauge.js`, for the same reason: the value comes out of a hand-editable
 * settings file, so a typo, a future value or a non-string all land on the
 * default here and nothing downstream has to decide what an unknown layout
 * looks like.
 */

const LAYOUTS = Object.freeze(['list', 'focus', 'tiles']);

const DEFAULT_LAYOUT = 'list';

/** Exactly one of the three? No coercion, no case folding. */
function isLayout(value) {
  return typeof value === 'string' && LAYOUTS.includes(value);
}

/** Untrusted value -> a real Layout, always. */
function sanitizeLayout(raw) {
  return isLayout(raw) ? raw : DEFAULT_LAYOUT;
}

module.exports = { LAYOUTS, DEFAULT_LAYOUT, isLayout, sanitizeLayout };
