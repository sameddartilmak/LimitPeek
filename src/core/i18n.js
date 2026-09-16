'use strict';
const log = require('./log');

/**
 * Translation, main side. ADR-004 and its Amendment 1.
 *
 * The CommonJS twin of `src/renderer/src/i18n.ts`. The two cannot share a
 * module — a sandboxed ES-module renderer and a CommonJS main process — so the
 * lookup is restated here and held identical by `test/i18n-parity.test.js`,
 * which runs both over every key both load, both languages and the counts
 * where plural rules diverge. Not by this comment. The rules both obey:
 *
 *   1. Lookup: current language, then the other language, then the key itself.
 *      A miss is reported (once per message) and is never an empty string.
 *   2. A value is a string or a plural record `{ one?, other, ... }`. The
 *      category comes from `Intl.PluralRules(language)` applied to the NUMBER
 *      param `count`; a category the record lacks falls back to `other`; a
 *      missing or non-numeric `count` is reported and uses `other`.
 *   3. `{name}` (`/\{([A-Za-z][A-Za-z0-9]*)\}/g`) is replaced by `params.name`.
 *      A number is formatted as an integer in the format locale; a string is
 *      inserted verbatim. A missing param leaves `{name}` visible and is
 *      reported.
 *   4. In 'throw' mode (tests) every report is an Error whose message starts
 *      with `i18n: `.
 *   5. An unusable format locale falls back to tr-TR or en-US.
 *
 * Main loads `common.json` (shared with the renderer) and `main.json` (the
 * tray, the dialogs, the setup notices). Language and format locale are
 * decided by `core/language.js` and applied through `setLocale` from
 * `main/index.js`; this module never looks at the OS.
 *
 * Module-level state, as in the renderer: every main-process surface that
 * writes text must speak the SAME language at the same moment, and a single
 * current locale is what guarantees it. `index.js` re-renders the tray and
 * re-publishes the snapshot after changing it.
 */

const LANGUAGE_FILES = ['common.json', 'main.json'];

function loadCatalog(language) {
  const out = {};
  for (const file of LANGUAGE_FILES) {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    Object.assign(out, require(`../shared/i18n/${language}/${file}`));
  }
  return Object.freeze(out);
}

const LOADED = Object.freeze({ tr: loadCatalog('tr'), en: loadCatalog('en') });

/** What `t()` reads. Only `__setCatalogsForTest` ever points it elsewhere. */
let catalogs = LOADED;

const DEFAULT_LANGUAGE = 'tr';
const DEFAULT_FORMAT_LOCALE = 'tr-TR';

function isResolvedLanguage(value) {
  return value === 'tr' || value === 'en';
}

function defaultFormatLocale(language) {
  return language === 'tr' ? 'tr-TR' : 'en-US';
}

/** Same test as `isUsableLocale` in `src/renderer/src/sanitize.ts`. */
function isUsableLocale(tag) {
  if (typeof tag !== 'string' || tag.length === 0 || tag.length > 35) return false;
  try {
    return Intl.getCanonicalLocales(tag).length === 1;
  } catch {
    return false;
  }
}

let currentLanguage = DEFAULT_LANGUAGE;
let currentFormatLocale = DEFAULT_FORMAT_LOCALE;
let missingMode = 'report';
const reported = new Set();

let integerFormat = new Intl.NumberFormat(DEFAULT_FORMAT_LOCALE, { maximumFractionDigits: 0 });
let pluralRules = new Intl.PluralRules(DEFAULT_LANGUAGE);

/**
 * Apply the language main resolved. An unusable format locale falls back to
 * the language's default rather than throwing.
 */
function setLocale(language, formatLocale) {
  currentLanguage = isResolvedLanguage(language) ? language : DEFAULT_LANGUAGE;
  currentFormatLocale = isUsableLocale(formatLocale)
    ? formatLocale
    : defaultFormatLocale(currentLanguage);
  integerFormat = new Intl.NumberFormat(currentFormatLocale, { maximumFractionDigits: 0 });
  pluralRules = new Intl.PluralRules(currentLanguage);
}

function language() {
  return currentLanguage;
}

function formatLocale() {
  return currentFormatLocale;
}

/** Tests: 'throw' turns every miss into an exception. */
function setMissingMode(mode) {
  missingMode = mode === 'throw' ? 'throw' : 'report';
}

function miss(message) {
  if (missingMode === 'throw') throw new Error(`i18n: ${message}`);
  if (reported.has(message)) return;
  reported.add(message);
  log.warn(`i18n: ${message}`);
}

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

function pick(entry, key, params) {
  if (typeof entry === 'string') return entry;
  const count = params ? params.count : undefined;
  if (typeof count !== 'number' || !Number.isFinite(count)) {
    miss(`"${key}" is plural and needs a numeric "count"`);
    return entry.other;
  }
  const form = entry[pluralRules.select(count)];
  return form !== undefined && form !== null ? form : entry.other;
}

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * @param {string} key
 * @param {Record<string, string|number>} [params]
 * @returns {string}
 */
function t(key, params) {
  const id = String(key);
  let entry = has(catalogs[currentLanguage], id) ? catalogs[currentLanguage][id] : undefined;
  if (entry === undefined) {
    miss(`missing key "${id}" in ${currentLanguage}`);
    const other = catalogs[currentLanguage === 'tr' ? 'en' : 'tr'];
    entry = has(other, id) ? other[id] : undefined;
    if (entry === undefined) return id;
  }
  const template = pick(entry, id, params);
  return template.replace(PLACEHOLDER, (whole, name) => {
    const value = params && has(params, name) ? params[name] : undefined;
    if (typeof value === 'number') return integerFormat.format(value);
    if (typeof value === 'string') return value;
    miss(`"${id}" is missing param "${name}"`);
    return whole;
  });
}

/** Every key main can translate, per language. For tests. */
function keys(lang = currentLanguage) {
  return Object.keys(catalogs[isResolvedLanguage(lang) ? lang : DEFAULT_LANGUAGE]);
}

/**
 * TEST ONLY. Replaces both catalogs `t()` reads with the two given objects and
 * returns a function that restores the loaded ones. Exists so the parity test
 * can prove the other-language fallback on a key that one catalog lacks, in
 * this module and in its renderer twin (`__setCatalogsForTest` in
 * `src/renderer/src/i18n.ts`) alike. Nothing is loaded here: the files on disk
 * are still only ever required by the two literal languages above.
 *
 * @param {{tr: object, en: object}} next  both required
 * @returns {() => void}
 */
function __setCatalogsForTest(next) {
  const isCatalog = (c) => c !== null && typeof c === 'object' && !Array.isArray(c);
  if (!next || !isCatalog(next.tr) || !isCatalog(next.en)) {
    throw new TypeError('i18n: __setCatalogsForTest needs { tr, en } catalog objects');
  }
  const previous = catalogs;
  catalogs = Object.freeze({ tr: next.tr, en: next.en });
  return () => { catalogs = previous; };
}

module.exports = {
  t,
  setLocale,
  language,
  formatLocale,
  setMissingMode,
  keys,
  isUsableLocale,
  defaultFormatLocale,
  DEFAULT_LANGUAGE,
  DEFAULT_FORMAT_LOCALE,
  __setCatalogsForTest,
};
