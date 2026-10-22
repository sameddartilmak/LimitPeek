'use strict';

/**
 * Settings → Genel → Görünüm, "Saydamlığı azalt": the panel's glass surfaces
 * (the header and the settings tab band, tokens.css) drawn opaque instead.
 *
 *   false  the glass, the default.
 *   true   every glass surface is the plain panel base; nothing else changes.
 *
 * Panel-only, and only the user's own half of the rule: Windows' reduced
 * transparency and high contrast turn the glass off as well, whatever this
 * says (CSS media features, and `systemReducedTransparency` in the
 * Preferences). A sibling of `layout.js` for the same reason: the value comes
 * out of a hand-editable settings file, so anything that is not a real `true`
 * lands on the default here and nothing downstream has to decide.
 */

const DEFAULT_REDUCE_TRANSPARENCY = false;

/** A real boolean? No coercion: "true", 1 and "yes" are not booleans. */
function isReduceTransparency(value) {
  return value === true || value === false;
}

/** Untrusted value -> a real boolean, always; only `true` is true. */
function sanitizeReduceTransparency(raw) {
  return raw === true;
}

module.exports = { DEFAULT_REDUCE_TRANSPARENCY, isReduceTransparency, sanitizeReduceTransparency };
