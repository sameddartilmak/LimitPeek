'use strict';

/**
 * The user's light/dark preference.
 *
 * Sibling of `order.js` and `enabled.js`, and it exists for the same reason:
 * this value comes out of a file on disk that survives upgrades, so it is
 * UNTRUSTED input. It will eventually be a hand-edited typo, a value from a
 * future version, `null`, or a number.
 *
 * Every degraded path lands on the shipped default rather than on nothing. A
 * theme is the one preference whose failure mode is TOTAL: an unrecognised
 * value that reached the renderer would match no palette, and the panel would
 * paint with neither — a blank window on a machine where everything else
 * works. So `sanitizeTheme()` never returns anything but one of the three
 * literals, and main calls it on the way out of the settings file AND on the
 * way into the IPC push, not only at load.
 *
 * 'system' is the default and is a LIVE binding, not a one-time read: the
 * renderer follows `prefers-color-scheme` for as long as it is chosen
 * (contract.ts, `ThemeChoice`). Main stores the word, never the resolved
 * colour scheme — persisting "dark" because the OS happened to be dark at the
 * moment the user picked "system" would silently break that binding.
 */

/** The three literals `ThemeChoice` declares, in the contract's own order. */
const THEMES = Object.freeze(['dark', 'light', 'system']);

const DEFAULT_THEME = 'system';

/** Is this exactly one of the three? No coercion, no case folding. */
function isTheme(value) {
  return typeof value === 'string' && THEMES.includes(value);
}

/** Untrusted value -> a real ThemeChoice, always. */
function sanitizeTheme(raw) {
  return isTheme(raw) ? raw : DEFAULT_THEME;
}

module.exports = { THEMES, DEFAULT_THEME, isTheme, sanitizeTheme };
