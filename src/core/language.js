'use strict';

/**
 * The user's language preference, and the one place it is resolved (ADR-004).
 *
 * Sibling of `theme.js`, and the stored word is just as UNTRUSTED: it comes out
 * of a settings file that survives upgrades and is hand-editable. So
 * `sanitizeLanguage()` never returns anything but one of the three literals,
 * and main calls it on the way out of the settings file AND on the way into
 * every Preferences push.
 *
 * Unlike the theme, 'system' is resolved HERE, in main, not in the renderer.
 * Main writes user-facing text itself — the tray tooltip, the tray menu, the
 * consent dialogs, the setup labels carried in the snapshot — so a second
 * resolver in the renderer could disagree with this one, and the tooltip would
 * speak a different language from the panel. The renderer receives the answer
 * (`resolvedLanguage`, `formatLocale`) and never re-derives it.
 *
 * Main stores the WORD, never the resolved language: persisting 'en' because
 * the OS happened to be English when the user picked 'system' would break that
 * binding on the next machine or the next OS change.
 *
 * Everything below `sanitizeLanguage` is pure. The OS signals are passed in, so
 * `en-US`, `en-GB` and a Turkish machine are all pinned by injection rather
 * than by whatever the developer's own Windows happens to say.
 */

/** The three literals `LanguageChoice` declares, in the contract's own order. */
const LANGUAGES = Object.freeze(['tr', 'en', 'system']);

const DEFAULT_LANGUAGE = 'system';

/** Used when an English user's OS gives no usable English region. */
const FALLBACK_EN_LOCALE = 'en-US';
const TR_LOCALE = 'tr-TR';

/** Is this exactly one of the three? No coercion, no case folding. */
function isLanguage(value) {
  return typeof value === 'string' && LANGUAGES.includes(value);
}

/** Untrusted value -> a real LanguageChoice, always. */
function sanitizeLanguage(raw) {
  return isLanguage(raw) ? raw : DEFAULT_LANGUAGE;
}

/**
 * A BCP 47 tag from the OS, parsed, or null. Windows hands back tags such as
 * `tr`, `en-US`, `en-150`; anything Intl cannot parse is treated as absent
 * rather than guessed at.
 */
function parseTag(tag) {
  if (typeof tag !== 'string' || tag.length === 0 || tag.length > 64) return null;
  try {
    return new Intl.Locale(tag);
  } catch {
    return null;
  }
}

/**
 * The OS display language: the first entry of the Windows language list.
 *
 * Measured on Electron 44.2.0 (see ADR-004 report): `app.getPreferredSystemLanguages()`
 * returned exactly `Get-WinUserLanguageList` ("tr, en-US, ar-AE"), was
 * available before `ready`, and ignored both `--lang` and `LANG`.
 * `app.getLocale()` is NOT used — it returned `en-GB` under `--lang=en-GB` on a
 * Turkish machine, and '' before ready. The regional-format locale
 * (`app.getSystemLocale()`) is only the fallback when the list is empty.
 */
function displayTag(os) {
  const list = os && Array.isArray(os.preferredLanguages) ? os.preferredLanguages : [];
  for (const tag of list) {
    if (parseTag(tag)) return tag;
  }
  const sys = os && os.systemLocale;
  return parseTag(sys) ? sys : null;
}

/** `tr*` in ADR-004 means the primary language subtag, not a string prefix. */
function osLanguage(os) {
  const parsed = parseTag(displayTag(os));
  return parsed && parsed.language === 'tr' ? 'tr' : 'en';
}

/**
 * `en-<REGION>` when the tag is English with a region Intl can format for,
 * else null. Script and extension subtags are dropped: the format locale
 * should say "British English", not carry a calendar override from the OS.
 */
function englishWithRegion(tag) {
  const parsed = parseTag(tag);
  if (!parsed || parsed.language !== 'en' || !parsed.region) return null;
  const candidate = `en-${parsed.region}`;
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([candidate]).length ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * ADR-004 Amendment 1, ruling 1: tr -> tr-TR; en -> the OS region if the OS
 * locale is en-*, otherwise en-US.
 *
 * "The OS locale" is read in this order: the regional format first (that is
 * the setting a user changes to get British dates), then the display
 * language. A Turkish machine whose user picked English gets en-US, one
 * predictable English, rather than an English variant nobody chose.
 */
function formatLocaleFor(resolvedLanguage, os) {
  if (resolvedLanguage === 'tr') return TR_LOCALE;
  return englishWithRegion(os && os.systemLocale)
    || englishWithRegion(displayTag(os))
    || FALLBACK_EN_LOCALE;
}

/**
 * @param {unknown} choice  the stored preference; sanitised here
 * @param {{preferredLanguages?: string[], systemLocale?: string|null}} [os]
 * @returns {{language:'tr'|'en'|'system', resolvedLanguage:'tr'|'en', formatLocale:string}}
 */
function resolveLanguage(choice, os) {
  const language = sanitizeLanguage(choice);
  const resolvedLanguage = language === 'system' ? osLanguage(os) : language;
  return { language, resolvedLanguage, formatLocale: formatLocaleFor(resolvedLanguage, os) };
}

module.exports = {
  LANGUAGES,
  DEFAULT_LANGUAGE,
  isLanguage,
  sanitizeLanguage,
  resolveLanguage,
};
