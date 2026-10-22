'use strict';

/**
 * How the panel lays out the tools (Settings → Genel → Görünüm, "Düzen").
 * Two, since the minimal redesign (owner, 2026-10-22: "panel çok büyük"):
 *
 *   'sade'   "Sade liste": one 36px line per tool, its logo, its name and
 *            "5sa %62 · 7g %41" on the right, no bars, no cards. The default
 *            (styles/layout-sade.css, `html[data-layout="sade"]`).
 *   'halka'  "Halka kutuları": small tiles in a three-column grid, each a
 *            ring for the five-hour window with the tool's logo in it and the
 *            two figures under it (styles/layout-halka.css).
 *
 * In both, a click on a tool opens its details as a sheet over the others.
 *
 * THE OLD VALUES MIGRATE. 'list', 'focus' and 'tiles' were the three layouts
 * before; a settings file written by those versions still says one of them.
 * They are read as the layout closest to what the user picked — the two
 * lists ('list', 'focus') as the list, the tiles as the tiles — rather than
 * dropped to the default, so an update keeps the user's choice of grid. Only
 * the sanitizer maps them: SET_LAYOUT takes the two current literals and
 * nothing else (`isLayout`), because a renderer that sends an old value is a
 * bug, not a settings file from last month.
 *
 * Panel-only: the tray donut and the taskbar strip are not affected. The value
 * comes out of a hand-editable settings file, so a typo, a future value or a
 * non-string all land on the default here and nothing downstream has to
 * decide what an unknown layout looks like.
 */

const LAYOUTS = Object.freeze(['sade', 'halka']);

const DEFAULT_LAYOUT = 'sade';

/** The layouts of 0.6.38 and earlier, and the one each now reads as. */
const LEGACY_LAYOUTS = Object.freeze({ list: 'sade', focus: 'sade', tiles: 'halka' });

/** Exactly one of the two? No coercion, no case folding, no old values. */
function isLayout(value) {
  return typeof value === 'string' && LAYOUTS.includes(value);
}

/** Untrusted value -> a real Layout, always; an old one -> its successor. */
function sanitizeLayout(raw) {
  if (isLayout(raw)) return raw;
  if (typeof raw === 'string' && Object.prototype.hasOwnProperty.call(LEGACY_LAYOUTS, raw)) {
    return LEGACY_LAYOUTS[raw];
  }
  return DEFAULT_LAYOUT;
}

module.exports = { LAYOUTS, DEFAULT_LAYOUT, LEGACY_LAYOUTS, isLayout, sanitizeLayout };
