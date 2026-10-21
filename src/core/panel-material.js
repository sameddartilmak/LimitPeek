'use strict';

/**
 * What the panel WINDOW is made of (concept "A · Gerçek Windows camı",
 * 2026-10-21): the real Windows 11 acrylic behind it, or a plain opaque base.
 *
 * Two separate questions, because they change on different clocks:
 *
 *   frame     'fitted'  the window IS the panel: Windows rounds its corners,
 *                       draws its shadow and its backdrop (Windows 11, build
 *                       22000 and up: DWM rounds and shadows a frameless,
 *                       non-transparent window).
 *             'canvas'  the window is a transparent frame larger than the
 *                       panel, which draws its own corners, shadow and tail
 *                       (Windows 10, and the shape every earlier version had).
 *             Decided ONCE, from the OS build: a transparent window cannot
 *             become an opaque one after it was created.
 *
 *   material  'acrylic' DWM's flyout acrylic (DWMSBT_TRANSIENTWINDOW, through
 *                       Electron's `backgroundMaterial`), build 22621 (22H2)
 *                       and up — Electron's own gate for it.
 *             'none'    the opaque panel base.
 *             Live: "Saydamlığı azalt", Windows' "Saydamlık efektleri" off and
 *             high contrast all turn it to 'none' while the panel is open.
 *
 * Pure, so the rule is tested without a window (test/panel-material.test.js).
 */

const PANEL_FRAMES = Object.freeze(['fitted', 'canvas']);
const PANEL_MATERIALS = Object.freeze(['acrylic', 'none']);

/** Windows 11: DWM rounds the corners of, and shadows, a frameless window. */
const FITTED_MIN_BUILD = 22000;
/** Windows 11 22H2: DWMWA_SYSTEMBACKDROP_TYPE, and Electron's backgroundMaterial. */
const ACRYLIC_MIN_BUILD = 22621;

/**
 * The opaque panel base, per theme: the window's own background whenever the
 * material is 'none', so a resize or the first frame never shows another
 * colour. Mirrors --ink-900 in tokens.css (test/panel-material.test.js).
 */
const PANEL_BASE = Object.freeze({ dark: '#1C1C1E', light: '#F2F2F7' });

/**
 * The hairline Windows draws around a fitted window (DWMWA_BORDER_COLOR).
 * Set rather than left to Windows, which paints the ACCENT colour there on an
 * active window when "Başlık çubuklarında ve pencere kenarlıklarında vurgu
 * rengini göster" is on — a coloured frame the moment the panel is clicked.
 * The values are the sheet's own edge (rgba white .14 / black .10) flattened
 * over the panel base, because DWM takes an opaque colour.
 */
const PANEL_EDGE = Object.freeze({ dark: '#454548', light: '#D9D9DE' });

/** "10.0.26200" -> 26200; 0 for anything that is not a Windows NT 10 release. */
function windowsBuild(release) {
  const m = /^10\.0\.(\d+)/.exec(String(release || ''));
  return m ? Number(m[1]) : 0;
}

/** @returns {'fitted'|'canvas'} */
function panelFrameFor(platform, release) {
  return platform === 'win32' && windowsBuild(release) >= FITTED_MIN_BUILD ? 'fitted' : 'canvas';
}

/** Can this OS draw acrylic behind a window at all? */
function acrylicAvailable(platform, release) {
  return platform === 'win32' && windowsBuild(release) >= ACRYLIC_MIN_BUILD;
}

/**
 * Should the window be acrylic right now? Only a fitted window can be (a
 * transparent canvas would put the backdrop behind its empty margins too), and
 * every request for less transparency wins.
 *
 * @param {{frame: string, available: boolean, reduceTransparency?: boolean, systemReduced?: boolean}} input
 */
function wantsAcrylic({ frame, available, reduceTransparency, systemReduced }) {
  return frame === 'fitted' && available === true && reduceTransparency !== true && systemReduced !== true;
}

/**
 * The theme the panel is drawn in, resolved the way the renderer resolves it:
 * 'system' follows Windows' app mode, which is what `prefers-color-scheme`
 * and `nativeTheme.shouldUseDarkColors` both report.
 */
function panelDark(theme, systemDark) {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return systemDark !== false;
}

function isPanelMaterial(value) {
  return typeof value === 'string' && PANEL_MATERIALS.includes(value);
}

function isPanelFrame(value) {
  return typeof value === 'string' && PANEL_FRAMES.includes(value);
}

module.exports = {
  PANEL_FRAMES,
  PANEL_MATERIALS,
  PANEL_BASE,
  PANEL_EDGE,
  FITTED_MIN_BUILD,
  ACRYLIC_MIN_BUILD,
  windowsBuild,
  panelFrameFor,
  acrylicAvailable,
  wantsAcrylic,
  panelDark,
  isPanelMaterial,
  isPanelFrame,
};
