'use strict';

/**
 * Where the usage is shown outside the panel (Settings → Genel → Görünüm):
 *
 *   'tray'   the tray icon's donut, as always. The default.
 *   'strip'  a small strip inside the taskbar, left of the tray, one tile per
 *            tool (src/main/taskbar-strip.js). While the strip is shown the
 *            tray icon is removed (index.js syncTrayPresence); it comes back
 *            whenever the strip is not shown, so one of the two is always there.
 *
 * A sibling of `theme.js`, for the same reason: the value comes out of a
 * hand-editable settings file, so a typo, a future value or a non-string all
 * land on the default here and nothing downstream has to decide what an
 * unknown view looks like.
 */

const TRAY_VIEWS = Object.freeze(['tray', 'strip']);

const DEFAULT_TRAY_VIEW = 'tray';

/** Exactly one of the two? No coercion, no case folding. */
function isTrayView(value) {
  return typeof value === 'string' && TRAY_VIEWS.includes(value);
}

/** Untrusted value -> a real TrayView, always. */
function sanitizeTrayView(raw) {
  return isTrayView(raw) ? raw : DEFAULT_TRAY_VIEW;
}

module.exports = { TRAY_VIEWS, DEFAULT_TRAY_VIEW, isTrayView, sanitizeTrayView };
