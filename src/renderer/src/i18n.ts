/**
 * Translation, renderer side. ADR-004 and its Amendment 1.
 *
 * ONE SOURCE OF WORDS, TWO IMPLEMENTATIONS OF `t()`
 * -------------------------------------------------
 * The words live in `src/shared/i18n/{tr,en,zh}/*.json` and nowhere else. Main
 * `require()`s the same files; this module imports them, and `build.mjs`
 * inlines them into the emitted JS (see `inline-json.cjs` — a JSON-module
 * import would be a fetch, and `connect-src 'none'` stays exactly as it is).
 *
 * The lookup below is restated in `src/core/i18n.js`, because a sandboxed
 * ES-module renderer and a CommonJS main process cannot share a module. The
 * two are held identical by a parity test that runs both over every key, both
 * languages and several counts — not by this comment. The rules both obey:
 *
 *   1. Lookup: current language, then English (Turkish when the current one
 *      is English), then the key itself. A miss is reported (once per key)
 *      and is never an empty string.
 *   2. A value is a string or a plural record `{ one?, other, ... }`. The
 *      category comes from `Intl.PluralRules(language)` applied to the NUMBER
 *      param `count`; a category the record does not carry falls back to
 *      `other`. Turkish records carry only `other`.
 *   3. `{name}` is replaced by `params.name`. A number is formatted as an
 *      integer in the format locale (so `{d}` in "{d} gün" gets tr-TR digits);
 *      a string is inserted verbatim. A missing param leaves `{name}` visible
 *      and is reported — a visible bug, never a silently dropped figure.
 *   4. In 'throw' mode (tests) every report above is an exception instead.
 *
 * Language and format locale are decided in MAIN (`Preferences.resolvedLanguage`
 * / `formatLocale`) and handed in through `setLocale`. This module never looks
 * at the OS on its own; `sanitizePreferences` covers the one case where main
 * sent no language, with the same tr* -> tr rule main applies.
 */

import trCommon from '../../shared/i18n/tr/common.json' with { type: 'json' };
import enCommon from '../../shared/i18n/en/common.json' with { type: 'json' };
import trRenderer from '../../shared/i18n/tr/renderer.json' with { type: 'json' };
import enRenderer from '../../shared/i18n/en/renderer.json' with { type: 'json' };
import zhCommon from '../../shared/i18n/zh/common.json' with { type: 'json' };
import zhRenderer from '../../shared/i18n/zh/renderer.json' with { type: 'json' };
// Validation lives with the rest of the IPC input gate, as isThemeChoice does,
// so what sanitize accepts and what this module applies cannot diverge.
import { defaultFormatLocale, isResolvedLanguage, isUsableLocale } from './sanitize.js';

export type Language = 'tr' | 'en' | 'zh';

type PluralRecord = { [category: string]: string | undefined; other: string };
type Entry = string | PluralRecord;
type Catalog = Readonly<Record<string, Entry>>;

/**
 * Keys are typed from the English catalogs; the catalog test pins tr to the same
 * set and forbids a key appearing in two files. main.json is main's and is not
 * loaded here: the panel never prints main's own text by key (main sends it
 * already translated, e.g. setup labels in the snapshot).
 */
export type MessageKey = keyof typeof enCommon | keyof typeof enRenderer;
export type Params = Readonly<Record<string, string | number>>;

let CATALOGS: Readonly<Record<Language, Catalog>> = {
  tr: { ...(trCommon as Catalog), ...(trRenderer as Catalog) },
  en: { ...(enCommon as Catalog), ...(enRenderer as Catalog) },
  zh: { ...(zhCommon as Catalog), ...(zhRenderer as Catalog) },
};

/**
 * TEST-ONLY. Replace both catalogs and get back a function that restores the
 * previous ones. Exists so the parity test can prove the other-language
 * fallback with a key that is deliberately missing from one side — something
 * the real catalogs, held complete by the catalog test, can never show.
 * `src/core/i18n.js` exports the identical signature. Nothing in the app calls it.
 */
export function __setCatalogsForTest(catalogs: {
  tr: Record<string, unknown>;
  en: Record<string, unknown>;
  zh?: Record<string, unknown>;
}): () => void {
  // Same contract as main's twin, rule for rule: both required, both plain
  // objects, a TypeError prefixed "i18n: " otherwise, both swapped at once.
  const isCatalog = (c: unknown): boolean =>
    c !== null && typeof c === 'object' && !Array.isArray(c);
  if (!catalogs || !isCatalog(catalogs.tr) || !isCatalog(catalogs.en)) {
    throw new TypeError('i18n: __setCatalogsForTest needs { tr, en } catalog objects');
  }
  const previous = CATALOGS;
  CATALOGS = Object.freeze({
    tr: catalogs.tr as Catalog,
    en: catalogs.en as Catalog,
    zh: isCatalog(catalogs.zh) ? (catalogs.zh as Catalog) : previous.zh,
  });
  return () => {
    CATALOGS = previous;
  };
}

/** Own keys only: a key like "constructor" must not resolve through the prototype. */
function lookup(language: Language, key: string): Entry | undefined {
  const catalog = CATALOGS[language];
  return Object.hasOwn(catalog, key) ? catalog[key] : undefined;
}

/** Before main says anything: the app's historical language, and tests' default. */
export const DEFAULT_LANGUAGE: Language = 'tr';
export const DEFAULT_FORMAT_LOCALE = 'tr-TR';

let currentLanguage: Language = DEFAULT_LANGUAGE;
let currentFormatLocale: string = DEFAULT_FORMAT_LOCALE;
let missingMode: 'report' | 'throw' = 'report';
const reported = new Set<string>();

let integerFormat = new Intl.NumberFormat(DEFAULT_FORMAT_LOCALE, { maximumFractionDigits: 0 });
let pluralRules = new Intl.PluralRules(DEFAULT_LANGUAGE);

/**
 * Apply the language main resolved. An unusable format locale falls back to
 * the language's default rather than throwing, and a format locale whose
 * language disagrees is still honoured: main decided it, and main also
 * formats the tooltip with it.
 */
export function setLocale(language: Language, formatLocale: string): void {
  currentLanguage = isResolvedLanguage(language) ? language : DEFAULT_LANGUAGE;
  currentFormatLocale = isUsableLocale(formatLocale)
    ? formatLocale
    : defaultFormatLocale(currentLanguage);
  integerFormat = new Intl.NumberFormat(currentFormatLocale, { maximumFractionDigits: 0 });
  pluralRules = new Intl.PluralRules(currentLanguage);
}

export function language(): Language {
  return currentLanguage;
}

export function formatLocale(): string {
  return currentFormatLocale;
}

/** Tests: 'throw' turns every miss into an exception. */
export function setMissingMode(mode: 'report' | 'throw'): void {
  missingMode = mode;
}

function miss(message: string): void {
  if (missingMode === 'throw') throw new Error(`i18n: ${message}`);
  if (reported.has(message)) return;
  reported.add(message);
  console.error(`i18n: ${message}`);
}

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

function pick(entry: Entry, key: string, params: Params | undefined): string {
  if (typeof entry === 'string') return entry;
  const count = params?.count;
  if (typeof count !== 'number' || !Number.isFinite(count)) {
    miss(`"${key}" is plural and needs a numeric "count"`);
    return entry.other;
  }
  return entry[pluralRules.select(count)] ?? entry.other;
}

export function t(key: MessageKey, params?: Params): string {
  const id = key as string;
  let entry = lookup(currentLanguage, id);
  if (entry === undefined) {
    miss(`missing key "${id}" in ${currentLanguage}`);
    entry = lookup(currentLanguage === 'en' ? 'tr' : 'en', id);
    if (entry === undefined) return id;
  }
  const template = pick(entry, id, params);
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = params?.[name];
    if (typeof value === 'number') return integerFormat.format(value);
    if (typeof value === 'string') return value;
    miss(`"${id}" is missing param "${name}"`);
    return whole;
  });
}
