'use strict';

/**
 * What the panel WINDOW is made of (concept "A · Gerçek Windows camı",
 * 2026-10-21; Liquid Glass, 2026-11-02): see-through, with the glass drawn by
 * the page itself, or a plain opaque base.
 *
 * Two separate questions, because they change on different clocks:
 *
 *   frame     'fitted'  the window IS the panel (Windows 11, build 22000 and
 *                       up: DWM rounds and shadows a frameless,
 *                       non-transparent window, and clears it on request).
 *             'canvas'  the window is a transparent frame larger than the
 *                       panel, which draws its own corners, shadow and tail
 *                       (Windows 10, and the shape every earlier version had).
 *             Decided ONCE, from the OS build: a transparent window cannot
 *             become an opaque one after it was created.
 *
 *   material  'acrylic' the window is CLEAR (DWM's accent policy, the
 *                       transparent gradient at alpha 0: win32 setAccent) and
 *                       the page draws the glass over a picture of the screen
 *                       behind the panel, taken as it opens (win32
 *                       captureScreen, panel-window.js, renderer glass.ts).
 *                       The name is the contract's (Preferences.material):
 *                       "the window is see-through".
 *             'none'    the opaque panel base.
 *             Live: the "Saydamlık" slider, Windows' "Saydamlık efektleri"
 *             off and high contrast all move it while the panel is open.
 *
 * WHY THE PAGE DRAWS THE GLASS. Windows offers two glasses, and the owner
 * turned both down (2026-10-22 to 11-02): the system acrylic (one heavy
 * frosted strength, and it falls back to a flat colour while the window is
 * inactive — "panel dışı bir yere tıklayınca renk değişiyor") and the accent
 * policy's own (frosted, black below a thick tint, or clear with no blur at
 * all: "%0'dan %50'ye kadar sadece renk açılıyor, ondan sonra tamamen arkasını
 * gösteriyor"). What was asked for is Apple's Liquid Glass: the screen behind
 * softened a little, bent like a lens towards the edges, a bright rim. No
 * Windows backdrop bends anything, so the page needs the pixels: main copies
 * the region the panel is about to cover (a GDI BitBlt, about 7 ms) before
 * the panel moves on screen, and the page draws the glass from that picture.
 * The window itself is cleared, so its corners can be the glass's own.
 *
 * Pure, so the rule is tested without a window (test/panel-material.test.js).
 */

const { sanitizeTheme } = require('./theme');
const { sanitizeTransparency } = require('./transparency');

const PANEL_FRAMES = Object.freeze(['fitted', 'canvas']);
const PANEL_MATERIALS = Object.freeze(['acrylic', 'none']);

/**
 * Windows 11: DWM rounds the corners of, and shadows, a frameless window. The
 * accent backdrop is older than that (Windows 10 1803), so every fitted window
 * can have the glass; a canvas never does (it would fill the margins too).
 */
const FITTED_MIN_BUILD = 22000;

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

/**
 * SetWindowCompositionAttribute's ACCENT_POLICY, measured on Windows 11 26200
 * (scratch spike, 2026-10-22): ACCENT_ENABLE_TRANSPARENTGRADIENT (2) with
 * AccentFlags 2 and a GradientColor of 0 clears the window — the desktop
 * shows wherever the page is transparent, the same while the window is
 * inactive. (Flags 0 makes it a flat grey; the frosted state 4 and the blur
 * state 3 are Windows' glasses the owner did not want, see above.)
 */
const ACCENT_DISABLED = 0;
const ACCENT_CLEAR = 2;
const ACCENT_FLAGS = 2;

/** "10.0.26200" -> 26200; 0 for anything that is not a Windows NT 10 release. */
function windowsBuild(release) {
  const m = /^10\.0\.(\d+)/.exec(String(release || ''));
  return m ? Number(m[1]) : 0;
}

/** @returns {'fitted'|'canvas'} */
function panelFrameFor(platform, release) {
  return platform === 'win32' && windowsBuild(release) >= FITTED_MIN_BUILD ? 'fitted' : 'canvas';
}

/**
 * The "Saydamlık" level that holds right now, 0 (opaque) or more (the glass).
 * Only a fitted window has glass at all (a transparent canvas would put it
 * behind its empty margins too), and Windows asking for less transparency
 * wins over the switch.
 *
 * @param {{frame: string, transparency?: unknown, systemReduced?: boolean}} input
 */
function effectiveTransparency({ frame, transparency, systemReduced }) {
  if (frame !== 'fitted' || systemReduced === true) return 0;
  return sanitizeTransparency(transparency);
}

/**
 * THE RULE: a level -> the accent the window gets. Pure and total (the level
 * is re-sanitised: a NaN or a string is the default).
 *
 *   0      { mode: 'opaque', state: 0 }                    the base, no glass
 *   1–100  { mode: 'liquid', state: 2, flags: 2, color: 0 } a clear window;
 *          the page draws the glass
 *
 * @param {unknown} level
 * @returns {{mode: 'opaque'|'liquid', state: number, flags: number, color: number}}
 */
function panelAccent(level) {
  if (sanitizeTransparency(level) === 0) return { mode: 'opaque', state: ACCENT_DISABLED, flags: 0, color: 0 };
  return { mode: 'liquid', state: ACCENT_CLEAR, flags: ACCENT_FLAGS, color: 0 };
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

/**
 * The look main hands the panel window (PanelWindow.setLook), rebuilt on
 * every call from what is true NOW: the settings file (theme and
 * "Saydamlık", both re-sanitised — they came off disk), Windows' own
 * requests and app mode. index.js calls it before every PREFERENCES push and
 * after every nativeTheme change.
 *
 * @param {object} deps
 * @param {'fitted'|'canvas'} deps.frame
 * @param {() => object|null} deps.getSettings
 * @param {() => boolean} deps.systemReduced  Windows: transparency off, or high contrast
 * @param {() => boolean} deps.systemDark     nativeTheme.shouldUseDarkColors
 * @returns {() => {transparency: number, dark: boolean}}
 */
function createPanelLook({ frame, getSettings, systemReduced, systemDark }) {
  return () => {
    const settings = getSettings() || {};
    return {
      transparency: effectiveTransparency({
        frame,
        transparency: settings.transparency,
        systemReduced: systemReduced() === true,
      }),
      dark: panelDark(sanitizeTheme(settings.theme), systemDark() !== false),
    };
  };
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
  ACCENT_DISABLED,
  ACCENT_CLEAR,
  ACCENT_FLAGS,
  windowsBuild,
  panelFrameFor,
  effectiveTransparency,
  panelAccent,
  panelDark,
  createPanelLook,
  isPanelMaterial,
  isPanelFrame,
};
