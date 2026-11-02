'use strict';

/**
 * Settings → Genel → Görünüm, "Saydamlık": a slider from 0 to 100.
 *
 *   0       opaque: the plain panel base, and the in-app glass (the header,
 *           the settings tab band) drawn opaque too.
 *   1–100   the Liquid Glass (owner, 2026-11-02: "apple'daki liquid glass
 *           varya onu istiyorum"): a clear window and the glass the page
 *           draws over the screen behind it (panel-material.js). The level
 *           is how see-through that glass is (renderer app.ts glassLook):
 *           frosted near the left end, the approved look at 80, clearest at
 *           100.
 *
 * It was a slider over Windows' own glasses first (2026-10-22), a switch
 * writing 0 or 100 when the Liquid Glass came, and a slider again over the
 * Liquid Glass (owner, 2026-11-02: "saydamlığı ayarlama yapmamız lazım
 * ayarlarda yine"). Every one of those wrote a level here, so no file needs
 * a migration.
 *
 * What the value does to the WINDOW is `panelAccent` in panel-material.js;
 * this file only says which values exist. Panel-only, and only the user's own
 * half of the rule: Windows' reduced transparency and high contrast make the
 * panel opaque whatever this says (`systemReducedTransparency` in the
 * Preferences).
 *
 * Replaces the boolean `reduceTransparency` of 0.6.41 and earlier: a file that
 * asked for less transparency (`true`) reads as 0, the same opaque panel; any
 * other file gets the default. A sibling of `strip-style.js` for the same reason:
 * the value comes out of a hand-editable settings file, so anything odd lands
 * on a real level here and nothing downstream has to decide.
 */

/** The glass on and a little frosted, for a panel nobody has set yet. */
const DEFAULT_TRANSPARENCY = 45;
const MIN_TRANSPARENCY = 0;
const MAX_TRANSPARENCY = 100;

/**
 * A level the renderer may ask for: an integer from 0 to 100, no coercion.
 * "45", 45.5 and NaN are not levels — over IPC they are a bug or a hostile
 * message, not a value to round.
 */
function isTransparency(value) {
  return Number.isInteger(value) && value >= MIN_TRANSPARENCY && value <= MAX_TRANSPARENCY;
}

/**
 * Untrusted value (a settings file, a push) -> a real level, always. A finite
 * number is rounded and clamped, so a hand-edited 47.4 or 150 still means what
 * it plainly meant; anything else (a string, NaN, null) is the default.
 */
function sanitizeTransparency(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_TRANSPARENCY;
  return Math.min(MAX_TRANSPARENCY, Math.max(MIN_TRANSPARENCY, Math.round(raw)));
}

/**
 * The level a settings file asks for. A file written since 0.6.42 has
 * `transparency`; one written before it may have `reduceTransparency: true`,
 * the old "less transparency" switch, which was the opaque panel: 0. A real
 * `transparency` wins over the old key, which the next save drops.
 */
function transparencyFromSettings(raw) {
  if (!raw || typeof raw !== 'object') return DEFAULT_TRANSPARENCY;
  if (typeof raw.transparency === 'number') return sanitizeTransparency(raw.transparency);
  return raw.reduceTransparency === true ? MIN_TRANSPARENCY : DEFAULT_TRANSPARENCY;
}

module.exports = {
  DEFAULT_TRANSPARENCY,
  MIN_TRANSPARENCY,
  MAX_TRANSPARENCY,
  isTransparency,
  sanitizeTransparency,
  transparencyFromSettings,
};
