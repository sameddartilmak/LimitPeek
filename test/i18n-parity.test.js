'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { formatModule } = require('./helpers/load-format');
const main = require('../src/core/i18n');
const log = require('../src/core/log');

/**
 * `t()` is implemented twice — `src/renderer/src/i18n.ts` for the sandboxed
 * ES-module panel, `src/core/i18n.js` for the CommonJS main process — because
 * the two cannot share a module (ADR-004 Amendment 1). This test is the ONLY
 * thing holding them identical. A comment saying "same rules" is not.
 *
 * It runs both over every key both of them load (`common.json`), in both
 * languages and in every format locale main can hand out, with sample params
 * chosen where the implementations could plausibly drift:
 *
 *   - `count` 0, 1 and 2, plus 21 and 1234 (grouping separators in the format
 *     locale). Not because the plural RULES differ: for whole numbers
 *     `Intl.PluralRules('tr')` and `('en')` select the same category (1 ->
 *     "one", everything else -> "other"). The printed forms differ because the
 *     CATALOGS differ — Turkish records carry only `other`, English ones carry
 *     `one` — so these counts exercise the `one` -> `other` fallback;
 *   - number params AND string params for the same placeholder, because one
 *     is formatted and the other is inserted verbatim;
 *   - the failure paths: a missing key, a missing param, a plural with no
 *     count or a non-numeric one, and an unusable format locale;
 *   - throw mode, where both must throw an Error starting `i18n: `.
 *
 * The renderer side is loaded from SOURCE through `formatModule()`, the same
 * loader the catalog and format suites use, so a stale `dist/` cannot make
 * this pass.
 */

const COMMON = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'src', 'shared', 'i18n', 'tr', 'common.json'), 'utf8',
));
const KEYS = Object.keys(COMMON);

const LOCALES = [
  ['tr', 'tr-TR'],
  ['en', 'en-US'],
  ['en', 'en-GB'],
  // Language and format locale disagreeing is allowed: main decided it.
  ['tr', 'en-US'],
  // Unusable: both must fall back to the language default, not throw.
  ['en', 'not a locale!!'],
  ['tr', ''],
];

const COUNTS = [0, 1, 2, 21, 1234];

function placeholdersOf(entry) {
  const texts = typeof entry === 'string' ? [entry] : Object.values(entry);
  const names = new Set();
  for (const text of texts) {
    for (const m of text.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)) names.add(m[1]);
  }
  return [...names];
}

/** Every param set worth comparing for one key. */
function paramSets(key) {
  const names = placeholdersOf(COMMON[key]);
  const sets = [];
  for (const count of COUNTS) {
    const numbers = {};
    const strings = {};
    for (const name of names) {
      numbers[name] = count;
      strings[name] = `«${name} ${count}»`;
    }
    sets.push({ ...numbers, count });
    sets.push({ ...strings, count });
  }
  return sets;
}

const loader = formatModule();
let renderer = null;

test.before(async () => {
  await loader.load();
  renderer = await loader.i18n();
});

test.after(() => {
  main.setLocale('tr', 'tr-TR');
  main.setMissingMode('report');
  if (renderer) {
    renderer.setLocale('tr', 'tr-TR');
    renderer.setMissingMode('report');
  }
  loader.cleanup();
});

/** Both on one locale; reports silenced, because misses are compared on purpose. */
function both(language, locale, body) {
  const originalError = console.error;
  console.error = () => {};
  log.setSink(() => {});
  main.setLocale(language, locale);
  renderer.setLocale(language, locale);
  try {
    body();
  } finally {
    console.error = originalError;
    log.setSink(null);
    main.setLocale('tr', 'tr-TR');
    renderer.setLocale('tr', 'tr-TR');
  }
}

/** Outcome of a call: its string, or the fact that it threw and with what. */
function outcome(fn) {
  try {
    return { value: fn() };
  } catch (err) {
    return { threw: err instanceof Error, message: String(err && err.message) };
  }
}

test.describe('the two t() implementations say the same thing', () => {
  test('the shared catalog is non-trivial, so this test is not vacuous', () => {
    assert.ok(KEYS.length >= 20, `only ${KEYS.length} shared keys`);
    assert.ok(KEYS.some((k) => typeof COMMON[k] === 'object'), 'no plural entry to exercise');
    for (const key of KEYS) assert.ok(main.keys('tr').includes(key), `main does not load ${key}`);
  });

  test('before anyone calls setLocale, both default to Turkish and tr-TR', () => {
    assert.equal(main.language(), renderer.language());
    assert.equal(main.formatLocale(), renderer.formatLocale());
    assert.equal(main.t('absence.unknown'), renderer.t('absence.unknown'));
  });

  test('every shared key, every locale, every sample param: identical output', () => {
    let compared = 0;
    for (const [language, locale] of LOCALES) {
      both(language, locale, () => {
        assert.equal(main.language(), renderer.language(), `${language}/${locale}: language`);
        assert.equal(main.formatLocale(), renderer.formatLocale(), `${language}/${locale}: format locale`);
        for (const key of KEYS) {
          for (const params of paramSets(key)) {
            const a = main.t(key, params);
            const b = renderer.t(key, params);
            assert.equal(a, b, `${language}/${locale} "${key}" ${JSON.stringify(params)}`);
            assert.notEqual(a, '', `${key} rendered empty`);
            compared += 1;
          }
        }
      });
    }
    assert.ok(compared > KEYS.length * LOCALES.length, `${compared} comparisons`);
  });

  test('plural output diverges between the languages exactly where the catalogs do', () => {
    // A guard on the test's own samples: if Turkish and English PRINTED the
    // same form for 0, 1 and 2, the loop above would prove less than it says.
    // The divergence is the catalogs' (Turkish has no `one`), not
    // Intl.PluralRules', which agrees on integers in both languages.
    both('en', 'en-US', () => {
      assert.equal(main.t('duration.long.hours', { count: 1 }), '1 hour');
      assert.equal(main.t('duration.long.hours', { count: 0 }), '0 hours');
      assert.equal(main.t('duration.long.hours', { count: 2 }), renderer.t('duration.long.hours', { count: 2 }));
    });
    both('tr', 'tr-TR', () => {
      assert.equal(main.t('duration.long.hours', { count: 1 }), '1 saat');
    });
  });

  test('the failure paths degrade identically in report mode', () => {
    const calls = [
      ['no.such.key', undefined],
      ['ago.minutes', undefined],
      ['ago.minutes', {}],
      ['ago.minutes', { m: null }],
      ['ago.minutes', { m: true }],
      ['duration.long.hours', undefined],
      ['duration.long.hours', { count: '2' }],
      ['duration.long.hours', { count: NaN }],
      ['duration.long.hours', { count: Infinity }],
      ['tokens.sinceCapture', { count: 1 }],
    ];
    for (const [language, locale] of LOCALES) {
      both(language, locale, () => {
        for (const [key, params] of calls) {
          const a = outcome(() => main.t(key, params));
          const b = outcome(() => renderer.t(key, params));
          assert.deepEqual(a, b, `${language}/${locale} ${key} ${JSON.stringify(params)}`);
          assert.ok(a.value !== undefined && a.value !== '', `${key} degraded to nothing`);
        }
      });
    }
  });

  test('in throw mode both throw, with the same i18n: message', () => {
    const calls = [
      ['no.such.key', undefined],
      ['ago.minutes', undefined],
      ['duration.long.hours', undefined],
      ['duration.long.hours', { count: 'many' }],
    ];
    main.setMissingMode('throw');
    renderer.setMissingMode('throw');
    try {
      for (const [language, locale] of [['tr', 'tr-TR'], ['en', 'en-US']]) {
        both(language, locale, () => {
          for (const [key, params] of calls) {
            const a = outcome(() => main.t(key, params));
            const b = outcome(() => renderer.t(key, params));
            assert.equal(a.threw, true, `main did not throw for ${key}`);
            assert.ok(a.message.startsWith('i18n: '), a.message);
            assert.deepEqual(a, b, `${language} ${key}`);
          }
          // And a clean call does not throw at all.
          assert.equal(main.t('ago.minutes', { m: 3 }), renderer.t('ago.minutes', { m: 3 }));
        });
      }
    } finally {
      main.setMissingMode('report');
      renderer.setMissingMode('report');
    }
  });

  /**
   * The fallback ladder, proved on injected catalogs through the test-only
   * `__setCatalogsForTest({tr, en}) => restore` both implementations export.
   * Without injection, deleting rung 2 (the other language) passed green:
   * the real catalogs have identical key sets, so no real key ever reaches it.
   */
  function withCatalogs(catalogs, body) {
    assert.equal(typeof main.__setCatalogsForTest, 'function', 'src/core/i18n.js has no __setCatalogsForTest');
    assert.equal(typeof renderer.__setCatalogsForTest, 'function', 'src/renderer/src/i18n.ts has no __setCatalogsForTest');
    const restoreMain = main.__setCatalogsForTest(catalogs);
    let restoreRenderer = null;
    try {
      restoreRenderer = renderer.__setCatalogsForTest(catalogs);
      body();
    } finally {
      if (restoreRenderer) restoreRenderer();
      restoreMain();
    }
  }

  test('a key only the OTHER language has is answered from it, by both implementations', () => {
    const catalogs = {
      tr: { 'only.tr': 'x', 'only.tr.plural': { other: '{count} öğe' } },
      en: { 'only.en': 'y' },
    };
    withCatalogs(catalogs, () => {
      both('en', 'en-US', () => {
        assert.equal(main.t('only.tr'), 'x', 'main skipped the other-language rung');
        assert.equal(renderer.t('only.tr'), 'x', 'renderer skipped the other-language rung');
        assert.equal(main.t('only.tr.plural', { count: 2 }), '2 öğe');
        assert.equal(renderer.t('only.tr.plural', { count: 2 }), '2 öğe');
        assert.equal(main.t('nowhere'), 'nowhere');
        assert.equal(renderer.t('nowhere'), 'nowhere');
      });
      both('tr', 'tr-TR', () => {
        assert.equal(main.t('only.en'), 'y');
        assert.equal(renderer.t('only.en'), 'y');
      });
    });
    // And restore really restores: the real catalog answers again.
    both('en', 'en-US', () => {
      assert.equal(main.t('absence.unknown'), 'unknown');
      assert.equal(renderer.t('absence.unknown'), 'unknown');
    });
  });

  test('the injection hook has one contract in both implementations', () => {
    // Both catalogs required, both non-array objects, else a TypeError whose
    // message starts "i18n: "; both swapped at once; restore() undoes it.
    for (const [name, impl] of [['main', main], ['renderer', renderer]]) {
      for (const bad of [undefined, null, {}, { tr: {} }, { en: {} }, { tr: [], en: {} }, { tr: {}, en: null }, { tr: 'x', en: {} }]) {
        assert.throws(() => impl.__setCatalogsForTest(bad), (err) => err instanceof TypeError && err.message.startsWith('i18n: '),
          `${name} accepted ${JSON.stringify(bad)}`);
      }
      const restore = impl.__setCatalogsForTest({ tr: { k: 'tr-k' }, en: { k: 'en-k' } });
      const originalError = console.error;
      console.error = () => {};
      log.setSink(() => {});
      try {
        impl.setLocale('en', 'en-US');
        assert.equal(impl.t('k'), 'en-k', `${name}: en not swapped`);
        assert.equal(impl.t('absence.unknown'), 'absence.unknown', `${name}: the real catalog is still visible`);
        impl.setLocale('tr', 'tr-TR');
        assert.equal(impl.t('k'), 'tr-k', `${name}: tr not swapped`);
      } finally {
        restore();
        console.error = originalError;
        log.setSink(null);
        impl.setLocale('tr', 'tr-TR');
      }
      assert.equal(impl.t('absence.unknown'), 'bilinmiyor', `${name}: restore() did not restore`);
    }
  });

  test('a key missing from the current language falls back to the other one, then to the key', () => {
    // Also checked on the REAL catalogs against a key only one side loads:
    // main loads main.json and the renderer does not. The renderer answers
    // with the key (its third rung), main with the translation (its first) —
    // which is the documented split, and the reason the parity loop above is
    // restricted to common.json.
    both('en', 'en-US', () => {
      assert.equal(renderer.t('tray.menu.quit'), 'tray.menu.quit');
      assert.equal(main.t('tray.menu.quit'), 'Quit');
    });
  });
});
