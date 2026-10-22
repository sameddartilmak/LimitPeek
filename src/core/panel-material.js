'use strict';

/**
 * What the panel WINDOW is made of (concept "A · Gerçek Windows camı",
 * 2026-10-21; the slider, 2026-10-22): Windows' own glass behind it, frosted
 * or clear, or a plain opaque base.
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
 *   material  'acrylic' DWM's accent backdrop behind a fitted window
 *                       (SetWindowCompositionAttribute, win32 setAccent): the
 *                       frosted acrylic blur or the clear gradient, tinted by
 *                       the GradientColor `panelAccent` picks from the
 *                       "Saydamlık" level. The name is the contract's
 *                       (Preferences.material): "the window is see-through".
 *             'none'    the opaque panel base.
 *             Live: the slider (0 is 'none'), Windows' "Saydamlık efektleri"
 *             off and high contrast all move it while the panel is open.
 *
 * Why the accent policy and not Electron's `backgroundMaterial: 'acrylic'`
 * (DWMSBT_TRANSIENTWINDOW, 0.6.41 and earlier): the system backdrop has ONE
 * strength, and it falls back while the window is inactive — the panel
 * changed colour every time the user clicked outside it ("panel dışı bir yere
 * tıklayınca renk değişiyor"). Measured on Windows 11 26200 (scratch spike,
 * 2026-10-22), the accent backdrop looks the same inactive as active, and
 * its strength is ours: the GradientColor's alpha is the tint.
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
 * The colour of the glass, per theme: the GradientColor's RGB, which DWM lays
 * over the blur (frosted) or over the window behind (clear) at the level's
 * alpha. The same two colours the page's own tint over the system acrylic
 * used to be (rgba(30, 30, 34) / rgba(246, 246, 248), tokens.css until
 * 0.6.41); the page is transparent over the glass now, so the tint is here.
 */
const PANEL_TINT = Object.freeze({ dark: '#1E1E22', light: '#F6F6F8' });

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
 * SetWindowCompositionAttribute's ACCENT_POLICY, the values measured on
 * Windows 11 26200 (scratch spike, 2026-10-22) on the fitted window itself:
 *
 *   ACCENT_ENABLE_ACRYLICBLURBEHIND (4)  frosted glass; colours behind come
 *        through vivid, no grey wash, the SAME while the window is inactive.
 *        Below about 0x30 of alpha it renders BLACK, so 0x30 is its floor.
 *   ACCENT_ENABLE_TRANSPARENTGRADIENT (2)  clear glass, no blur; at alpha 0
 *        the window behind is fully visible, inactive or not.
 *   ACCENT_ENABLE_BLURBEHIND (3) rendered black and is never used.
 *
 * Both need AccentFlags 2 (the gradient colour is drawn): with 0, state 2 is
 * a flat grey.
 */
const ACCENT_DISABLED = 0;
const ACCENT_CLEAR = 2;
const ACCENT_FROSTED = 4;
const ACCENT_FLAGS = 2;

/**
 * The slider's three bands (src/core/transparency.js) and the alpha each end
 * of a band gives the tint. 1 is nearly the opaque panel, frosted; 55 the
 * thinnest frosted tint that still renders; 56 a clear pane with a light
 * tint, 100 nothing at all. Linear inside a band.
 */
const FROSTED_LEVELS = Object.freeze({ from: 1, to: 55 });
const FROSTED_ALPHA = Object.freeze({ from: 0xE6, to: 0x30 });
const CLEAR_LEVELS = Object.freeze({ from: 56, to: 100 });
const CLEAR_ALPHA = Object.freeze({ from: 0x70, to: 0x00 });

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
 * How see-through the window should be right now, 0 (opaque) to 100. Only a
 * fitted window has glass at all (a transparent canvas would put the backdrop
 * behind its empty margins too), and Windows asking for less transparency
 * wins over the slider.
 *
 * @param {{frame: string, transparency?: unknown, systemReduced?: boolean}} input
 */
function effectiveTransparency({ frame, transparency, systemReduced }) {
  if (frame !== 'fitted' || systemReduced === true) return 0;
  return sanitizeTransparency(transparency);
}

/** Linear from `alpha.from` at `levels.from` to `alpha.to` at `levels.to`. */
function along(level, levels, alpha) {
  const t = (level - levels.from) / (levels.to - levels.from);
  return Math.round(alpha.from + (alpha.to - alpha.from) * t);
}

/**
 * THE RULE: a level and a theme -> the accent the window gets. Pure, and
 * total: the level is re-sanitised (a NaN or a string is the default, 150 is
 * 100), so whatever arrives, the answer is one the spike measured.
 *
 *   0       { mode: 'opaque',  state: 0 }                the base, no glass
 *   1–55    { mode: 'frosted', state: 4, alpha 0xE6→0x30 }
 *   56–100  { mode: 'clear',   state: 2, alpha 0x70→0x00 }
 *
 * `color` is the GradientColor, 0xAABBGGRR: the theme's PANEL_TINT at
 * `alpha`.
 *
 * @param {unknown} level
 * @param {boolean} dark
 * @returns {{mode: 'opaque'|'frosted'|'clear', state: number, flags: number, alpha: number, color: number}}
 */
function panelAccent(level, dark) {
  const n = sanitizeTransparency(level);
  if (n === 0) return { mode: 'opaque', state: ACCENT_DISABLED, flags: 0, alpha: 0, color: 0 };
  const frosted = n <= FROSTED_LEVELS.to;
  const alpha = frosted ? along(n, FROSTED_LEVELS, FROSTED_ALPHA) : along(n, CLEAR_LEVELS, CLEAR_ALPHA);
  return {
    mode: frosted ? 'frosted' : 'clear',
    state: frosted ? ACCENT_FROSTED : ACCENT_CLEAR,
    flags: ACCENT_FLAGS,
    alpha,
    color: gradientColor(PANEL_TINT[dark === false ? 'light' : 'dark'], alpha),
  };
}

/** `#RRGGBB` and an alpha byte -> 0xAABBGGRR, unsigned. */
function gradientColor(hex, alpha) {
  // Nothing at all is 0x00000000, the exact value the spike measured clear.
  if ((alpha & 0xFF) === 0) return 0;
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex));
  const [r, g, b] = m ? [m[1], m[2], m[3]].map((h) => parseInt(h, 16)) : [0, 0, 0];
  return ((((alpha & 0xFF) << 24) | (b << 16) | (g << 8) | r) >>> 0);
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
  PANEL_TINT,
  PANEL_EDGE,
  FITTED_MIN_BUILD,
  ACCENT_DISABLED,
  ACCENT_CLEAR,
  ACCENT_FROSTED,
  ACCENT_FLAGS,
  windowsBuild,
  panelFrameFor,
  effectiveTransparency,
  panelAccent,
  gradientColor,
  panelDark,
  createPanelLook,
  isPanelMaterial,
  isPanelFrame,
};
