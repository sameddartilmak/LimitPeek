'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { formatModule } = require('./helpers/load-format');

/**
 * ADR-004 and Amendment 1: the shared catalogs, the renderer's `t()`, and the
 * formatters in both languages.
 *
 * Three kinds of guard live here, and each exists because a comment could not
 * hold the claim it makes:
 *
 *   1. SHAPE. tr and en carry the same files, the same keys and the same
 *      placeholders. A key present in one language only is a string that falls
 *      back to the other language at runtime — an English user reading Turkish.
 *   2. HONESTY. Several strings exist to stop the app claiming more than it
 *      knows (ADR-001/002). Their force is pinned as PAIRED PATTERNS applied to
 *      EVERY key: if the Turkish says "en az", the English must say "at least",
 *      whichever file and key it lives in. A key added next month is covered on
 *      the day it is added, without anyone remembering to list it.
 *   3. FORMATTING. The same numbers in tr-TR, en-US and en-GB. The locale is
 *      injected through `setLocale`, as main injects it at runtime.
 *
 * The parity of the renderer's `t()` with `src/core/i18n.js` is a separate test
 * owned by the main-process lane; it reuses `formatModule().i18n()` from here.
 */

const ROOT = path.join(__dirname, '..');
const CATALOG_ROOT = path.join(ROOT, 'src', 'shared', 'i18n');
const LANGS = ['tr', 'en'];
const PLURAL_CATEGORIES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);

function readCatalogs() {
  const out = {};
  for (const lang of LANGS) {
    out[lang] = {};
    const dir = path.join(CATALOG_ROOT, lang);
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      out[lang][file] = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    }
  }
  return out;
}

/** Every text variant of an entry: the string itself, or each plural form. */
function variants(entry) {
  return typeof entry === 'string' ? [entry] : Object.values(entry);
}

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * Turkish words that are pure ASCII and not also English (ADR-004 A1.8): the
 * Turkish-letter regex cannot see them. Shared by the renderer-literal scan and
 * the English-catalog scan. Plus the ASCII-folded spellings a hurried edit
 * produces ("Bagla" for "Bağla") and the unit abbreviations.
 */
const ASCII_TURKISH = [
  'Tamam', 'Ekle', 'Yenile', 'Ayarlar', 'Koyu', 'Sistem', 'Girdi', 'Onayla', 'Geri',
  'Kapat', 'Kaydet', 'Kaldir', 'standart', 'sa', 'dk', 'sn', 'Anladim', 'Bagla',
  'bagli', 'kaldi', 'simdi', 'yok', 'ile', 've', 'bir', 'bu', 'Bu', 'hepsi', 'panelde',
];
// A word boundary that treats CSS-class and identifier characters as part of
// the word, so "quota__model" or "--ink-700" can never match.
const DENIED_ASCII_TURKISH = new RegExp(`(^|[^A-Za-z0-9_-])(${ASCII_TURKISH.join('|')})(?=$|[^A-Za-z0-9_-])`);

function placeholders(entry) {
  const names = new Set();
  for (const text of variants(entry)) {
    for (const m of text.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)) names.add(m[1]);
  }
  return [...names].sort();
}

const catalogs = readCatalogs();

/* ------------------------------------------------------------------ shape */

test.describe('the catalogs have one shape in both languages', () => {
  test('the same catalog files exist for tr and en', () => {
    assert.ok(Object.keys(catalogs.tr).includes('common.json'), 'common.json is missing');
    assert.deepEqual(Object.keys(catalogs.en), Object.keys(catalogs.tr));
  });

  test('every file carries the same keys in both languages', () => {
    for (const file of Object.keys(catalogs.tr)) {
      assert.deepEqual(
        Object.keys(catalogs.en[file]).sort(),
        Object.keys(catalogs.tr[file]).sort(),
        `${file}: key sets differ`,
      );
    }
  });

  test('no key is declared in two files of one language (a later file would shadow it)', () => {
    for (const lang of LANGS) {
      const seen = new Map();
      for (const [file, entries] of Object.entries(catalogs[lang])) {
        for (const key of Object.keys(entries)) {
          assert.ok(!seen.has(key), `${lang}: "${key}" is in both ${seen.get(key)} and ${file}`);
          seen.set(key, file);
        }
      }
    }
  });

  test('every value is a non-empty string or a plural record with "other"', () => {
    for (const lang of LANGS) {
      for (const [file, entries] of Object.entries(catalogs[lang])) {
        for (const [key, entry] of Object.entries(entries)) {
          const where = `${lang}/${file} "${key}"`;
          if (typeof entry === 'string') {
            assert.ok(entry.trim().length > 0, `${where} is empty`);
            continue;
          }
          assert.ok(entry && typeof entry === 'object' && !Array.isArray(entry), `${where} has a bad shape`);
          assert.equal(typeof entry.other, 'string', `${where} has no "other" form`);
          for (const [category, text] of Object.entries(entry)) {
            assert.ok(PLURAL_CATEGORIES.has(category), `${where}: "${category}" is not a plural category`);
            assert.ok(typeof text === 'string' && text.trim().length > 0, `${where}.${category} is empty`);
          }
        }
      }
    }
  });

  test('English plural records carry "one": "1 tokens" is the bug this prevents', () => {
    for (const [file, entries] of Object.entries(catalogs.en)) {
      for (const [key, entry] of Object.entries(entries)) {
        const trEntry = catalogs.tr[file][key];
        if (typeof entry === 'string' && typeof trEntry === 'string') continue;
        assert.equal(typeof entry, 'object', `en/${file} "${key}" must be plural where tr is`);
        assert.equal(typeof entry.one, 'string', `en/${file} "${key}" has no "one" form`);
      }
    }
  });

  test('every key uses the same placeholders in both languages', () => {
    for (const file of Object.keys(catalogs.tr)) {
      for (const key of Object.keys(catalogs.tr[file])) {
        assert.deepEqual(
          placeholders(catalogs.en[file][key]),
          placeholders(catalogs.tr[file][key]),
          `${file} "${key}": placeholders differ`,
        );
      }
    }
  });

  test('English carries no Turkish letters', () => {
    // The one exception is a language's own name: the language picker offers
    // "Türkçe" to an English reader, because that is the word a Turkish reader
    // looks for. It is an exact-value exemption, not a pattern.
    const ENDONYMS = { 'language.endonym.tr': 'Türkçe' };
    for (const [file, entries] of Object.entries(catalogs.en)) {
      for (const [key, entry] of Object.entries(entries)) {
        if (ENDONYMS[key] !== undefined && entry === ENDONYMS[key]) continue;
        for (const text of variants(entry)) {
          assert.doesNotMatch(text, /[çğıöşüÇĞİÖŞÜ]/, `en/${file} "${key}": ${text}`);
        }
      }
    }
  });

  test('English carries no ASCII-only Turkish word either ("Tamam" has no Turkish letter)', () => {
    const offenders = [];
    for (const [file, entries] of Object.entries(catalogs.en)) {
      for (const [key, entry] of Object.entries(entries)) {
        for (const text of variants(entry)) {
          if (DENIED_ASCII_TURKISH.test(text)) offenders.push(`en/${file} "${key}": ${text}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  test('no English entry is the Turkish entry verbatim, outside an explicit allow-list', () => {
    // A value identical in both languages is an untranslated string in one of
    // them — Turkish left in English, or English pasted into Turkish. Allowed:
    // the endonyms (a language's own name is the same word for every reader),
    // words that are the same in both ("OK", the product name), and values that
    // are only placeholders and separators.
    const SAME_KEYS = new Set(['language.endonym.tr', 'language.endonym.en']);
    const SAME_VALUES = new Set(['OK', 'Usage Notch']);
    const onlyPlaceholders = (text) => !/\p{L}/u.test(text.replace(/\{[A-Za-z][A-Za-z0-9]*\}/g, ''));
    // Plural records are compared category by category: English "one" may
    // legitimately equal Turkish "other" ("{value} token" is both).
    const byCategory = (entry) => (typeof entry === 'string' ? { other: entry } : entry);
    const offenders = [];
    for (const file of Object.keys(catalogs.en)) {
      for (const [key, enEntry] of Object.entries(catalogs.en[file])) {
        if (SAME_KEYS.has(key)) continue;
        const trEntry = catalogs.tr[file] && catalogs.tr[file][key];
        if (trEntry === undefined) continue; // the key-set test reports this
        const trForms = byCategory(trEntry);
        for (const [category, text] of Object.entries(byCategory(enEntry))) {
          if (trForms[category] !== text || SAME_VALUES.has(text) || onlyPlaceholders(text)) continue;
          offenders.push(`${file} "${key}".${category}: ${JSON.stringify(text)}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });
});

/* ---------------------------------------------------------------- honesty */

/**
 * Paired claims. When a Turkish variant matches `tr`, the English variant with
 * the same key must match `en` and must match none of `enNot`.
 *
 * Each row is a claim ADR-001/002 depends on. The `enNot` lists are the known
 * ways a translation softens it: a floor turned into an estimate, a "not
 * reported" turned into "no limit", a stated absence turned into a dash.
 */
const HONESTY = [
  {
    claim: 'a floor stays a floor',
    tr: /\ben az\b|alt sınır/i,
    en: /\bat least\b|lower bound/i,
    enNot: /\babout\b|approx|around|roughly|~|≈|\bup to\b|\bestimated?\b/i,
  },
  {
    claim: 'the figure is denied as a bill',
    liveIn: 'renderer.json',
    tr: /fatura değil/i,
    en: /\bnot a bill\b/i,
    // "not a bill, but you may be charged" keeps the words and takes back the
    // claim. None of these occur in the legitimate copy (cost.denial,
    // cost.toggleLabel, settings.usage.intro); the named-key test below pins
    // that those three still pass this row.
    enNot: /\bmay not\b|\bmight not\b|\bprobably\b|\bcharged\b|\bbilled\b|\bmay be\b|\bmight be\b|\bcould be\b/i,
  },
  {
    claim: 'an unknown value is called unknown',
    tr: /bilinmiyor/i,
    en: /\bunknown\b/i,
  },
  {
    claim: 'a limit the source does not publish is not denied',
    tr: /bildirilmiyor|yayımlamıyor/i,
    en: /\bnot reported\b|\bdoes not publish\b/i,
    enNot: /\bno limit\b|\bunlimited\b|\bnone\b/i,
  },
  {
    claim: 'a stale figure names the instant it was true',
    tr: /itibarıyla/i,
    en: /\bas of\b|\bmeasured at\b/i,
    enNot: /\bupdated\b/i,
  },
  {
    claim: 'a reset is called a reset, never a renewal of anything billable',
    // Case-SENSITIVE on purpose. Turkish uses one verb for two facts:
    // lower-case "yenileniyor" is a window resetting, while the button and the
    // spoken suffix "Yenileniyor" mean the app is refreshing, which is not a
    // reset claim at all.
    tr: /[sS]ıfırlan|yenileniyor|yenilenme/,
    en: /\breset/i,
    enNot: /\brenew/i,
  },
  {
    claim: 'unpriced usage is said to be unpriced, never zero',
    liveIn: 'renderer.json',
    tr: /fiyatlanama|fiyat listesinde bulunamadı/i,
    en: /could not be priced|not in the price list|no price could/i,
    enNot: /\bfree\b|\$0\b|\bzero\b/i,
  },
  {
    claim: 'a measured delta since a capture stays a measured addition',
    tr: /o zamandan beri/i,
    en: /since then/i,
  },
];

test.describe('the honesty copy makes the same claim with the same force (ADR-004)', () => {
  for (const row of HONESTY) {
    test(row.claim, () => {
      let matched = 0;
      for (const file of Object.keys(catalogs.tr)) {
        for (const [key, trEntry] of Object.entries(catalogs.tr[file])) {
          if (!variants(trEntry).some((text) => row.tr.test(text))) continue;
          matched += 1;
          for (const text of variants(catalogs.en[file][key])) {
            assert.match(text, row.en, `${file} "${key}" lost its claim in English: ${text}`);
            if (row.enNot) {
              assert.doesNotMatch(text, row.enNot, `${file} "${key}" was softened in English: ${text}`);
            }
          }
        }
      }
      // A pattern that matches nothing guards nothing. A row names the catalog
      // its claim lives in (`liveIn`, default common.json); once that file
      // exists, the row MUST match something in it, so deleting or rewording
      // the claim cannot quietly retire its guard.
      // A renamed or split home file FAILS here rather than quietly retiring
      // the row (it used to be skipped when the file was absent).
      const home = row.liveIn || 'common.json';
      assert.ok(catalogs.tr[home] && catalogs.en[home], `${home} is gone; move "${row.claim}" to its new home`);
      assert.ok(matched > 0, `no Turkish string matches ${row.tr}; the guard is dead`);
    });
  }

  test('the bill row still accepts the legitimate denials, so its forbidden list is not overbroad', () => {
    const bill = HONESTY.find((row) => row.claim === 'the figure is denied as a bill');
    for (const key of ['cost.denial', 'cost.toggleLabel', 'settings.usage.intro']) {
      const text = catalogs.en['renderer.json'][key];
      assert.equal(typeof text, 'string', `${key} is missing`);
      assert.match(text, bill.en, key);
      assert.doesNotMatch(text, bill.enNot, key);
    }
    for (const softened of [
      'This is not a bill, but you may be charged this amount.',
      'This is not a bill; you could be billed for it.',
      'This may not be a bill.',
    ]) {
      assert.ok(!bill.en.test(softened) || bill.enNot.test(softened), softened);
    }
  });

  /**
   * ADR-004 Amendment 2.2: the signed-off claim-bearing keys, each pinned to
   * the claim it makes IN BOTH LANGUAGES. The paired table above is keyed on
   * the Turkish, so an English-only softening of a key whose Turkish matches
   * no row passed green (11 such mutations did), and a softening made in both
   * languages at once drops the key out of that table without failing it.
   * Here the key is named: it must exist, in the file named, and both texts
   * must still carry the claim. Adding a claim-bearing string means adding a
   * row here (the ADR says so).
   */
  const NAMED_CLAIMS = [
    // counterfactual at published API prices
    { file: 'renderer.json', key: 'cost.summary', en: [/\bwould have cost\b/i], tr: [/API fiyatlarıyla/, /tutardı/] },
    { file: 'renderer.json', key: 'cost.detailLead', en: [/\bat published API prices\b/i], tr: [/API fiyatlarıyla/] },
    { file: 'renderer.json', key: 'cost.toggleLabel', en: [/\bat published API prices\b/i, /\bnot a bill\b/i], tr: [/API fiyatlarıyla/i, /tutardı/, /fatura değil/] },
    { file: 'renderer.json', key: 'settings.usage.intro', en: [/\bat published API prices\b/i, /\bnot a bill\b/i], tr: [/API fiyatlarıyla/i, /fatura değil/] },
    // not a bill
    { file: 'renderer.json', key: 'cost.denial', en: [/\bnot a bill\b/i], tr: [/fatura değil/] },
    // an estimate says so
    { file: 'renderer.json', key: 'meter.value.estimated', en: [/\babout\b/i], tr: [/yaklaşık/] },
    { file: 'renderer.json', key: 'meter.value.range', en: [/\bestimated\b/i], tr: [/tahmini/i] },
    { file: 'renderer.json', key: 'meter.value.estimatedOnly', en: [/\bestimated\b/i], tr: [/tahmini/i] },
    // stale data says it is not current
    { file: 'renderer.json', key: 'header.fresh.stale', en: [/\bnot current\b/i], tr: [/güncel değil/] },
    { file: 'renderer.json', key: 'header.spoken.stale', en: [/\bnot current\b/i], tr: [/güncel değil/] },
    { file: 'renderer.json', key: 'quota.degraded', en: [/\bnot current\b/i], tr: [/güncel değil/] },
    // the cost block's degraded caveat is driven by WeeklyCost.sourceIncomplete,
    // not by limit freshness: records could not be read, so the amount is a
    // lower bound (ADR-002 A3.15-16)
    { file: 'renderer.json', key: 'cost.caveat.degraded', en: [/\bcould not be read\b/, /\blower bound\b/i], tr: [/okunamadı/, /alt sınır/] },
    // the short cause lines each name their cause, and the "why" toggles ask
    // about the claim without softening it (ADR-002 A3.15-16)
    { file: 'renderer.json', key: 'cost.cause.unpriced', en: [/^Could not be priced\b/, /\{item\}/], tr: [/^Fiyatlanamadı:/, /\{item\}/] },
    { file: 'renderer.json', key: 'cost.cause.unpricedMore', en: [/^Could not be priced\b/, /\{count\}/], tr: [/^Fiyatlanamadı:/, /\{count\}/] },
    { file: 'renderer.json', key: 'cost.cause.ttl', en: [/\bwithout a recorded TTL\b/, /\{count\}/], tr: [/kaydedilmemiş/, /\{count\}/] },
    { file: 'renderer.json', key: 'cost.cause.unrecordedWrites', en: [/^Unrecorded cache writes\b/, /\{count\}/], tr: [/^Kaydedilmemiş önbellek yazması:/, /\{count\}/] },
    { file: 'renderer.json', key: 'cost.cause.sourceIncomplete', en: [/\bcould not be read\b/], tr: [/okunamayan/i] },
    { file: 'renderer.json', key: 'cost.why.toggle', en: [/\bat least\b/i, /\?$/], tr: [/\ben az\b/i, /\?$/] },
    { file: 'renderer.json', key: 'cost.why.toggleUnpriced', en: [/\bno amount\b/i, /\?$/], tr: [/tutar yok/i, /\?$/] },
    // ADR-002 A3.17-21. Unreadable records with NO figure (A3.19): says why there
    // is no amount (and, by the guard below, never calls a missing amount a floor).
    { file: 'renderer.json', key: 'cost.caveat.degradedNoFigure', en: [/\bcould not be read\b/, /\bno amount can be given\b/], tr: [/okunamadı/, /tutar verilemiyor/] },
    // a history amount cell whose records could not be read (guarded below: no figure)
    { file: 'renderer.json', key: 'settings.amount.incomplete', en: [/\bcould not be read\b/], tr: [/okunamadı/] },
    // a tier Codex did not record is priced at Standard, the cheapest it can send: a floor
    { file: 'renderer.json', key: 'cost.cause.assumedTier', en: [/\bStandard\b/, /\{count\}/], tr: [/Standart/, /\{count\}/] },
    { file: 'renderer.json', key: 'cost.caveat.assumedTier', en: [/\bStandard\b/, /\blower bound\b/i, /\{count\}/], tr: [/Standart/, /alt sınır/, /\{count\}/] },
    // Fast requested but not shown applied: priced at Standard, the real cost may be higher
    { file: 'renderer.json', key: 'cost.cause.fastRequested', en: [/\bFast\b/, /\brequested\b/, /\bStandard\b/, /\{count\}/], tr: [/Fast/, /istendi/, /Standart/, /\{count\}/] },
    { file: 'renderer.json', key: 'cost.caveat.fastRequested', en: [/\bFast\b/, /\brequested\b/, /\bStandard\b/, /\bhigher\b/, /\{count\}/], tr: [/Fast/, /istendi/, /Standart/, /daha yüksek/, /\{count\}/] },
    { file: 'renderer.json', key: 'cost.caveat.unpricedMore', en: [/\{count\}/], tr: [/\{count\}/] },
    // unreadable records in the history: affected periods are a floor
    { file: 'renderer.json', key: 'settings.usage.incomplete', en: [/\{tools\}/, /\bcould not be read\b/, /\blower bound\b/i], tr: [/\{tools\}/, /okunamadı/, /alt sınır/] },
    // cache reads are outside the billable total
    { file: 'renderer.json', key: 'row.tokens.cacheRead', en: [/\bnot included in the billable total\b/i], tr: [/dahil değil/] },
    // decoded, undocumented source
    { file: 'renderer.json', key: 'quota.derived', en: [/\bnot a documented interface\b/i], tr: [/belgelenmiş bir arayüz değil/i] },
    // cache reads with zero recorded writes on a model that bills writes: the
    // total is a floor (A2.2). Every plural form is checked (variants()).
    { file: 'renderer.json', key: 'cost.caveat.unrecordedWrites', en: [/\brecorded 0 cache writes\b/i, /\blower bound\b/i, /read from the cache/, /1,024\+ tokens/], tr: [/önbellek yazması 0 kaydedilmiş/, /alt sınır/, /önbellekten okumuş/, /1\.024\+ token/] },
    // usage history is computed locally, from local files only (A2.2, Codex merge)
    { file: 'renderer.json', key: 'settings.usage.sources', en: [/\bonly from local\b/i, /\bClaude Code transcripts\b/, /\bCodex session logs\b/], tr: [/^Yalnızca yerel\b/, /Claude Code transkriptlerinden/, /Codex oturum kayıtlarından/] },
    // per-provider price dates, and "at least" still means a lower bound — for
    // BOTH causes: unpriced usage, and cache writes Codex did not record on a
    // model that bills them (ADR-002 A3.8-9)
    // Each price note names EVERY floor cause of the tools it covers: unpriced
    // usage (both), a cache write without a TTL split (Claude Code), and cache
    // writes Codex did not record (Codex).
    { file: 'renderer.json', key: 'settings.usage.note', en: [/\bat least\b/i, /\blower bound\b/i, /\bnot included in the total\b/i, /\bdid not record its TTL\b/, /\{low\}/, /\{high\}/], tr: [/\ben az\b/i, /alt sınır/, /toplama katılmadığı/, /TTL ayrımı olmayan/, /\{low\}/, /\{high\}/] },
    { file: 'renderer.json', key: 'settings.usage.noteByProvider', en: [/\{claude\}/, /\{codex\}/, /\bat least\b/i, /\blower bound\b/i, /\bnot included in the total\b/i, /\bdid not record its TTL\b/, /\{low\}/, /\{high\}/, /\bcache write/i, /\bnot record/i, /\bservice tier could not be verified\b/], tr: [/\{claude\}/, /\{codex\}/, /\ben az\b/i, /alt sınır/, /toplama katılmadığı/, /TTL ayrımı olmayan/, /\{low\}/, /\{high\}/, /önbellek yazma/, /kaydetmediği|kaydedilmemiş/, /hizmet katmanı doğrulanamadı/] },
    { file: 'renderer.json', key: 'settings.usage.noteCodexOnly', en: [/\{codex\}/, /\bat least\b/i, /\blower bound\b/i, /\bnot included in the total\b/i, /\bcache write/i, /\bnot record/i, /\bservice tier could not be verified\b/], tr: [/\{codex\}/, /\ben az\b/i, /alt sınır/, /toplama katılmadığı/, /önbellek yazma/, /kaydetmediği|kaydedilmemiş/, /hizmet katmanı doğrulanamadı/] },
    // pending state (ADR-002 A3.12): the totals are still being computed —
    // incomplete, which is neither zero nor a floor
    { file: 'renderer.json', key: 'row.tokens.pending', en: [/\bcalculating\b/i], tr: [/hesaplanıyor/] },
    { file: 'renderer.json', key: 'cost.pending', en: [/\bcalculating\b/i, /\blocal\b/i], tr: [/hesaplanıyor/, /yerel/] },
    { file: 'renderer.json', key: 'settings.usage.pending', en: [/\{tools\}/, /\bincomplete\b/i], tr: [/\{tools\}/, /eksik/] },
    { file: 'renderer.json', key: 'settings.amount.pending', en: [/\bcalculating\b/i], tr: [/hesaplanıyor/] },
    // consent dialogs: no network, and the one network access is consented
    { file: 'main.json', key: 'dialog.claude.promise', en: [/\bno network connection\b/i], tr: [/hiçbir ağ bağlantısı açmaz/] },
    { file: 'main.json', key: 'dialog.agy.promise', en: [/\bno network connection\b/i], tr: [/hiçbir ağ bağlantısı açmaz/] },
    { file: 'main.json', key: 'dialog.agyInstall.detail', en: [/\bonly network access\b/i, /\bwith your consent\b/i], tr: [/tek ağ erişimi/, /onayınızla/] },
  ];

  test('every signed-off honesty key exists and keeps its claim in both languages (ADR-004 A2.2)', () => {
    const failures = [];
    for (const { file, key, en, tr } of NAMED_CLAIMS) {
      for (const [lang, patterns] of [['en', en], ['tr', tr]]) {
        const entries = catalogs[lang][file];
        if (!entries) {
          failures.push(`${lang}/${file} does not exist (renamed?); "${key}" is unguarded`);
          continue;
        }
        if (!has(entries, key)) {
          failures.push(`${lang}/${file} has no "${key}"`);
          continue;
        }
        for (const text of variants(entries[key])) {
          for (const pattern of patterns) {
            if (!pattern.test(text)) failures.push(`${lang}/${file} "${key}" lost ${pattern}: ${text}`);
          }
        }
      }
    }
    assert.deepEqual(failures, []);
  });

  test('no cost cause line or "why" toggle hedges or reassures (ADR-002 A3.15-16)', () => {
    // A cause line states WHY the figure is a floor or missing. An estimate
    // word turns a one-sided floor into a two-sided guess; a minimiser or a
    // reassurance talks the reader out of the claim the line exists to make.
    const SOFTENING = /yaklaşık|approximate|\broughly\b|\babout\b|\bonly\b|\bjust\b|\bmerely\b|\bminor\b|\bsmall\b|\bnegligible\b|\bslight(ly)?\b|worry|\bno problem\b|sadece|yalnızca|\bkücük\b|küçük|önemsiz|ihmal edilebilir|endişe|merak etme|sorun değil|\bbiraz\b/i;
    let seen = 0;
    for (const lang of LANGS) {
      const entries = catalogs[lang]['renderer.json'] || {};
      for (const [key, entry] of Object.entries(entries)) {
        if (!/^cost\.(cause|why)\./.test(key)) continue;
        seen += 1;
        for (const text of variants(entry)) {
          assert.doesNotMatch(text, SOFTENING, `${lang} "${key}" softens its claim: ${text}`);
        }
      }
    }
    // Nine cause/why keys per language today (unpriced, unpricedMore, ttl,
    // unrecordedWrites, sourceIncomplete, assumedTier, fastRequested, and the two
    // toggles). A renamed key would silently leave the guard; more keys are fine.
    assert.ok(seen >= 18, `the nine cause/why keys exist in both languages (saw ${seen})`);
  });

  test('the unreadable history amount shows no figure: no dash, no zero, no currency (ADR-002 A3.19)', () => {
    for (const lang of LANGS) {
      const entries = catalogs[lang]['renderer.json'] || {};
      assert.ok(has(entries, 'settings.amount.incomplete'), `${lang}: settings.amount.incomplete exists`);
      for (const text of variants(entries['settings.amount.incomplete'])) {
        assert.doesNotMatch(text, /[—–]|\d|[$€£₺¢]|\b(USD|TL|TRY|dolar|dollars?)\b/i, `${lang}: an unreadable amount must not read as a figure: ${text}`);
      }
    }
  });

  test('an amount that cannot be given is never called a floor (ADR-002 A3.19)', () => {
    for (const lang of LANGS) {
      const entries = catalogs[lang]['renderer.json'] || {};
      assert.ok(has(entries, 'cost.caveat.degradedNoFigure'), `${lang}: cost.caveat.degradedNoFigure exists`);
      for (const text of variants(entries['cost.caveat.degradedNoFigure'])) {
        assert.doesNotMatch(text, /alt sınır|lower bound|\ben az\b|\bat least\b/i, `${lang}: no amount is not a lower bound: ${text}`);
      }
    }
  });

  test('a requested Fast tier is never claimed as applied, nor priced as Fast (ADR-002 A3.18)', () => {
    // Affirmative forms only: "does not show that Fast was applied" and "if
    // Fast was applied" are the honest conditional and stay allowed.
    const CLAIMS_APPLIED = {
      en: /(^|[.;:]\s*)Fast (was|is|has been) (actually )?applied\b|\bpriced at Fast\b|\bFast was used\b|\bat Fast prices?\b/i,
      tr: /(^|[.;:]\s*)Fast( gerçekten)? uygulandı(?!ğ|ys)|Fast fiyat(ın)?dan|Fast olarak (fiyatlandı|hesaplandı)/i,
    };
    for (const lang of LANGS) {
      const entries = catalogs[lang]['renderer.json'] || {};
      for (const key of ['cost.cause.fastRequested', 'cost.caveat.fastRequested']) {
        assert.ok(has(entries, key), `${lang}: ${key} exists`);
        for (const text of variants(entries[key])) {
          assert.doesNotMatch(text, CLAIMS_APPLIED[lang], `${lang} "${key}" claims Fast was applied: ${text}`);
        }
      }
    }
  });

  test('the Codex-only price note never names Claude or a Claude price date', () => {
    for (const lang of LANGS) {
      const entries = catalogs[lang]['renderer.json'];
      assert.ok(entries && has(entries, 'settings.usage.noteCodexOnly'), `${lang}: settings.usage.noteCodexOnly exists`);
      for (const text of variants(entries['settings.usage.noteCodexOnly'])) {
        assert.doesNotMatch(text, /\{claude\}|Claude/, `${lang}: a Codex-only note must not mention Claude`);
      }
    }
  });

  test('no pending-state copy reads as a floor: never "en az" / "at least" (ADR-002 A3.12)', () => {
    let seen = 0;
    for (const lang of LANGS) {
      for (const [file, entries] of Object.entries(catalogs[lang])) {
        for (const [key, entry] of Object.entries(entries)) {
          if (!/(^|\.)pending$/.test(key)) continue;
          seen += 1;
          for (const text of variants(entry)) {
            assert.doesNotMatch(text, /\ben az\b|\bat least\b/i,
              `${lang}/${file} "${key}": pending means incomplete, not a lower bound`);
          }
        }
      }
    }
    assert.ok(seen >= 8, `the four A3.12 pending keys exist in both languages (saw ${seen})`);
  });

  test('"approximate cost" is gone in both languages (ADR-004 A1.6)', () => {
    for (const lang of LANGS) {
      for (const [file, entries] of Object.entries(catalogs[lang])) {
        for (const [key, entry] of Object.entries(entries)) {
          for (const text of variants(entry)) {
            assert.doesNotMatch(
              text,
              /yaklaşık maliyet|approximate(ly)? cost/i,
              `${lang}/${file} "${key}": a two-sided error claim beside one-sided floors`,
            );
          }
        }
      }
    }
  });

  test('the floor word is bound to its amount, not left to sentence order', () => {
    // `atLeast()` attaches the bound to the figure, so no sentence can place
    // "{amount}" away from it. The catalog entry must therefore be the bound
    // and the amount and nothing else.
    assert.equal(catalogs.tr['common.json']['amount.atLeast'], 'en az {amount}');
    assert.equal(catalogs.en['common.json']['amount.atLeast'], 'at least {amount}');
  });
});

/* ------------------------------------------------------ t() and formatting */

const fmt = formatModule();
let f = null;
let i18n = null;

test.before(async () => {
  f = await fmt.load();
  i18n = await fmt.i18n();
});
test.after(() => fmt.cleanup());

function inLocale(language, formatLocale, body) {
  i18n.setLocale(language, formatLocale);
  try {
    body();
  } finally {
    i18n.setLocale('tr', 'tr-TR');
  }
}

/** ICU puts U+202F (or U+00A0) before AM/PM; the digits are what is pinned. */
const norm = (s) => s.replace(/[  ]/g, ' ');

test.describe('t()', () => {
  test('defaults to Turkish before main says anything', () => {
    assert.equal(i18n.language(), 'tr');
    assert.equal(i18n.formatLocale(), 'tr-TR');
    assert.equal(i18n.t('absence.unknown'), 'bilinmiyor');
  });

  test('numbers are integers in the format locale; strings are verbatim', () => {
    inLocale('en', 'en-US', () => {
      assert.equal(i18n.t('ago.minutes', { m: 1234 }), '1,234m ago');
      assert.equal(i18n.t('time.asOf', { time: '{not a placeholder}' }), 'as of {not a placeholder}');
    });
    assert.equal(i18n.t('ago.minutes', { m: 1234 }), '1.234 dk önce');
  });

  test('plural forms follow the language; Turkish records fall back to "other"', () => {
    inLocale('en', 'en-US', () => {
      assert.equal(i18n.t('duration.long.hours', { count: 1 }), '1 hour');
      assert.equal(i18n.t('duration.long.hours', { count: 2 }), '2 hours');
      assert.equal(i18n.t('duration.long.hours', { count: 0 }), '0 hours');
    });
    assert.equal(i18n.t('duration.long.hours', { count: 1 }), '1 saat');
  });

  test('in throw mode a missing key, param or count is an exception', () => {
    i18n.setMissingMode('throw');
    try {
      assert.throws(() => i18n.t('no.such.key'), /missing key/);
      assert.throws(() => i18n.t('ago.minutes'), /missing param "m"/);
      assert.throws(() => i18n.t('duration.long.hours'), /needs a numeric "count"/);
    } finally {
      i18n.setMissingMode('report');
    }
  });

  test('in report mode a miss degrades visibly, never to an empty string', () => {
    const original = console.error;
    const logged = [];
    console.error = (message) => logged.push(message);
    try {
      assert.equal(i18n.t('no.such.key'), 'no.such.key');
      assert.equal(i18n.t('ago.minutes'), '{m} dk önce');
      assert.ok(logged.length >= 2);
    } finally {
      console.error = original;
    }
  });

  test('an unusable format locale falls back to the language default instead of throwing', () => {
    inLocale('en', 'not a locale!!', () => {
      assert.equal(i18n.formatLocale(), 'en-US');
      assert.equal(f.percent(62), '62%');
    });
  });
});

test.describe('formatting follows the locale main resolved', () => {
  test('percent sign placement: %62 in Turkish, 62% in English', () => {
    assert.equal(f.percent(62), '%62');
    inLocale('en', 'en-US', () => assert.equal(f.percent(62), '62%'));
    inLocale('en', 'en-GB', () => assert.equal(f.percent(62), '62%'));
  });

  test('rounding is language-independent: the printed integer is Math.round in every locale', () => {
    const digits = (s) => Number(s.replace(/\D/g, ''));
    for (let v = 0; v <= 1000; v += 1) {
      const value = v / 10;
      const tr = digits(f.percent(value));
      inLocale('en', 'en-US', () => {
        assert.equal(digits(f.percent(value)), tr, String(value));
        assert.equal(tr, Math.round(value), String(value));
        assert.equal(f.stateFor(value), f.stateFor(value));
      });
    }
  });

  test('share bounds are built from the formatter, so the sign moves with the locale', () => {
    assert.equal(f.share(0.001), '<%1');
    assert.equal(f.share(0.999), '>%99');
    inLocale('en', 'en-US', () => {
      assert.equal(f.share(0.001), '<1%');
      assert.equal(f.share(0.999), '>99%');
      assert.equal(f.share(0.65), '65%');
    });
  });

  test('currency: separators and symbol from the locale; the sub-cent bound survives', () => {
    assert.equal(f.usd(226.81), '$226,81');
    assert.equal(f.usd(0.001), '<$0,01');
    inLocale('en', 'en-US', () => {
      assert.equal(f.usd(226.81), '$226.81');
      assert.equal(f.usd(1234.5), '$1,234.50');
      assert.equal(f.usd(0.001), '<$0.01');
      assert.equal(f.usdWithUnit(226.81), '226.81 US dollars');
      assert.match(f.usdWithUnit(0.001), /^<0\.01 US dollars?$/);
    });
    inLocale('en', 'en-GB', () => assert.equal(f.usd(226.81), 'US$226.81'));
  });

  test('compact units: B/Mn in Turkish, K/M in English', () => {
    assert.equal(norm(f.compact(1240)), '1,2 B');
    assert.equal(norm(f.compact(1_240_000)), '1,2 Mn');
    inLocale('en', 'en-US', () => {
      assert.equal(f.compact(1240), '1.2K');
      assert.equal(f.compact(1_240_000), '1.2M');
    });
  });

  test('tokens pluralise in English and not in Turkish', () => {
    assert.equal(f.tokens(1), '1 token');
    assert.equal(norm(f.tokens(1240)), '1,2 B token');
    inLocale('en', 'en-US', () => {
      assert.equal(f.tokens(1), '1 token');
      assert.equal(f.tokens(1240), '1.2K tokens');
      assert.equal(f.burnRate(1240), '1.2K tokens/h');
      assert.equal(f.sinceCapture(1240), '+1.2K tokens since then');
    });
  });

  test('countdowns: same boundaries and dropped zeros in English', () => {
    const SEC = 1000;
    const MIN = 60 * SEC;
    const HR = 60 * MIN;
    const DAY = 24 * HR;
    inLocale('en', 'en-US', () => {
      assert.equal(f.countdown(SEC - 1), 'resetting');
      assert.equal(f.countdownRemaining(0), 'resetting');
      assert.doesNotMatch(f.countdownRemaining(0), /left/);
      assert.equal(f.countdown(SEC), '1s');
      assert.equal(f.countdown(MIN), '1m');
      assert.equal(f.countdown(HR), '1h');
      assert.equal(f.countdown(2 * HR + 14 * MIN), '2h 14m');
      assert.equal(f.countdown(2 * DAY), '2d');
      assert.equal(f.countdown(2 * DAY + HR), '2d 1h');
      assert.equal(f.countdownRemaining(2 * HR + 14 * MIN), '2h 14m left');
      assert.equal(f.countdownSpoken(0), 'resetting now');
      assert.equal(f.countdownSpoken(SEC), '1 second');
      assert.equal(f.countdownSpoken(HR + MIN), '1 hour 1 minute');
      assert.equal(f.countdownSpoken(2 * HR + 14 * MIN), '2 hours 14 minutes');
      assert.equal(f.countdownSpoken(2 * DAY), '2 days');
      assert.equal(f.countdownSpoken(3 * DAY + 4 * HR), '3 days 4 hours');
    });
  });

  test('elapsed time in English', () => {
    inLocale('en', 'en-US', () => {
      assert.equal(f.ago(0), 'now');
      assert.equal(f.ago(3 * 60_000), '3m ago');
      assert.equal(f.ago(2 * 3_600_000), '2h ago');
      assert.equal(f.ago(3 * 86_400_000), '3d ago');
      assert.equal(f.agoSpoken(0), 'just now');
      assert.equal(f.agoSpoken(60_000), '1 minute ago');
      assert.equal(f.agoSpoken(2 * 3_600_000), '2 hours ago');
    });
  });

  test('clocks: Turkish keeps two digits; English uses the numeric hour and its own cycle', () => {
    const at = new Date(2026, 8, 3, 9, 5);
    assert.equal(f.clockTime(at), '09:05');
    assert.equal(f.asOf(at.toISOString()), '09:05 itibarıyla');
    inLocale('en', 'en-US', () => {
      assert.equal(norm(f.clockTime(at)), '9:05 AM');
      assert.equal(norm(f.asOf(at.toISOString())), 'as of 9:05 AM');
    });
    // A British reader keeps a 24-hour clock: following the OS region is the
    // point of ADR-004 A1.1.
    inLocale('en', 'en-GB', () => assert.equal(norm(f.clockTime(at)), '9:05'));
  });

  test('dates: short months in English ranges, long in Turkish', () => {
    const a = new Date(2026, 8, 3, 12).toISOString();
    const b = new Date(2026, 8, 10, 12).toISOString();
    assert.equal(f.dayRange(a, b), '3 Eylül – 10 Eylül');
    assert.equal(f.priceDate('2026-06-24'), '24 Haziran 2026');
    inLocale('en', 'en-US', () => {
      assert.equal(f.dayRange(a, b), 'Sep 3 – Sep 10');
      assert.equal(f.priceDate('2026-06-24'), 'June 24, 2026');
    });
    inLocale('en', 'en-GB', () => {
      assert.match(f.dayRange(a, b), /^3 Sept? – 10 Sept?$/);
      assert.equal(f.priceDate('2026-06-24'), '24 June 2026');
    });
  });

  test('the floor word stays attached to its amount in both languages', () => {
    assert.equal(f.atLeast(f.usd(12.4)), 'en az $12,40');
    inLocale('en', 'en-US', () => assert.equal(f.atLeast(f.usd(12.4)), 'at least $12.40'));
  });

  test('lowerFirst uses the resolved language, so English "I" never becomes "ı" (A1.7)', () => {
    assert.equal(f.lowerFirst('Işık'), 'ışık');
    assert.equal(f.lowerFirst('İzmir'), 'izmir');
    inLocale('en', 'en-US', () => {
      assert.equal(f.lowerFirst('It is not connected'), 'it is not connected');
      assert.equal(f.lowerFirst('Installed'), 'installed');
    });
  });
});

/* ------------------------------------------------ the renderer carries no copy */

/**
 * Every user-facing word in the shipped renderer comes from a catalog.
 *
 * The check walks STRING LITERALS with the TypeScript scanner (the compiler the
 * typecheck step already requires), so comments — which legitimately quote the
 * Turkish they explain — are not literals and are not flagged.
 *
 * Two nets, because one is not enough:
 *   1. a Turkish letter anywhere in a literal;
 *   2. a DENY-LIST of Turkish words that are pure ASCII (ADR-004 A1.8), which
 *      the letter test cannot see: "Tamam", "Ekle", "Yenile" were all shipped
 *      literals before this change. Matched as whole, case-sensitive words so
 *      CSS classes and identifiers do not trip it.
 */
test.describe('no user-facing copy is left in the renderer source (ADR-004 A1.8)', () => {
  const ts = require('typescript');
  const SRC = path.join(ROOT, 'src', 'renderer', 'src');
  // Words that are Turkish and NOT also English (so "model" and "Panel" are
  // out); the list is ASCII_TURKISH at the top of this file. Unit
  // abbreviations are in because "2 sa 14 dk" is exactly the kind of string
  // that used to be hand-built outside the catalog.
  const denied = DENIED_ASCII_TURKISH;

  function tsFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return tsFiles(full);
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [full] : [];
    });
  }

  /** [line, text] for every string and template-literal chunk in a file. */
  function literals(file) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const out = [];
    const visit = (node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
      const chunks = [];
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) chunks.push(node.text);
      if (ts.isTemplateExpression(node)) {
        chunks.push(node.head.text, ...node.templateSpans.map((span) => span.literal.text));
      }
      for (const text of chunks) {
        out.push([source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return out;
  }

  const files = tsFiles(SRC);

  test('the walk actually finds the renderer', () => {
    assert.ok(files.length >= 15, `only ${files.length} files; the walk is wrong`);
    assert.ok(files.some((f) => f.endsWith(path.join('components', 'panel.ts'))));
  });

  test('no literal contains a Turkish letter or an ASCII-only Turkish word', () => {
    const offenders = [];
    for (const file of files) {
      for (const [line, text] of literals(file)) {
        if (/[çğıöşüÇĞİÖŞÜ]/.test(text) || denied.test(text)) {
          offenders.push(`${path.relative(ROOT, file)}:${line}: ${JSON.stringify(text)}`);
        }
      }
    }
    assert.deepEqual(offenders, [], 'move these into src/shared/i18n/{tr,en}/renderer.json');
  });

  test('the deny-list is live: it catches the words it names', () => {
    for (const sample of ['Tamam', 'Yenile', 'Ekle', '2 sa', '5 dk', 'Ayarlar']) {
      assert.ok(denied.test(sample), sample);
    }
    for (const sample of ['btn btn--primary', 'settings-view', 'tr-TR', 'aria-label', 'sk sk--name']) {
      assert.equal(denied.test(sample), false, sample);
    }
  });

  test('every renderer.json key is used by the renderer, so the catalog holds no dead copy', () => {
    const code = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    const unused = Object.keys(catalogs.en['renderer.json']).filter(
      (key) => !code.includes(`'${key}'`),
    );
    assert.deepEqual(unused, []);
  });
});

/* ------------------------------------- call sites supply the catalog's params */

/**
 * `t('key', { a, b })` must pass exactly the placeholders the catalog entry
 * names. The shape test above holds tr and en to the same placeholders, but a
 * placeholder renamed in BOTH catalogs while the code still passes the old name
 * passed green — and printed a literal "{tool}" on screen, because report mode
 * leaves a missing param visible.
 *
 * WHAT THE SCANNER SEES, AND WHAT IT DOES NOT. It walks the TypeScript AST of
 * src/renderer/src/**\/*.ts (checked against common + renderer.json) and of
 * src/core + src/main **\/*.js (checked against common + main.json), and looks
 * at calls `t(...)` or `<anything>.t(...)` whose FIRST argument is a string
 * literal naming a key that catalog has. It then reads the SECOND argument
 * only if it is absent or an object literal of plain / shorthand properties.
 * It skips, silently and by design:
 *   - dynamic keys (`t(CLASS_LABEL[k])`, `t(key as MessageKey)`);
 *   - params passed as a variable, or containing a spread or computed name;
 *   - wrappers that call t() on a caller's behalf (`setup(kind, labelKey,
 *     detailKey, params)` in providers/index.js) — the key is not at the call.
 * The count of checked calls is asserted so a scanner that stops matching
 * fails instead of passing on nothing.
 */
test.describe('every literal t() call passes exactly the placeholders its entry names', () => {
  const ts = require('typescript');

  function sourceFiles(dir, ext) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full, ext);
      return entry.name.endsWith(ext) && !entry.name.endsWith('.d.ts') ? [full] : [];
    });
  }

  function merged(lang, files) {
    return Object.assign({}, ...files.map((file) => catalogs[lang][file] || {}));
  }

  /** [{file, line, key, params: string[] | null}] ; params null = not an inspectable literal. */
  function calls(file) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const out = [];
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const isT = (ts.isIdentifier(callee) && callee.text === 't')
          || (ts.isPropertyAccessExpression(callee) && callee.name.text === 't');
        const [first, second] = node.arguments;
        if (isT && first && ts.isStringLiteral(first)) {
          let params = null;
          if (!second) {
            params = [];
          } else if (ts.isObjectLiteralExpression(second)) {
            const names = [];
            let plain = true;
            for (const prop of second.properties) {
              if (ts.isShorthandPropertyAssignment(prop)) names.push(prop.name.text);
              else if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) names.push(prop.name.text);
              else plain = false;
            }
            if (plain) params = names;
          }
          out.push({
            file: path.relative(ROOT, file),
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            key: first.text,
            params,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return out;
  }

  /**
   * Checks every inspectable literal call against BOTH languages, and counts
   * each call SITE once (not once per language), so the floors below are real
   * call-site counts. `mustInclude` names call sites ("file-suffix key") that
   * must be among those checked: a scanner that silently stops recognising a
   * call shape fails on them before it fails on the floor.
   */
  function check(files, catalogFiles, { minimum, mustInclude = [] }) {
    const problems = [];
    const sites = files.flatMap(calls).filter((call) => call.params !== null
      && LANGS.every((lang) => has(merged(lang, catalogFiles), call.key)));
    for (const lang of LANGS) {
      const catalog = merged(lang, catalogFiles);
      for (const call of sites) {
        const entry = catalog[call.key];
        const wanted = placeholders(entry);
        const allowed = new Set(typeof entry === 'string' ? wanted : [...wanted, 'count']);
        const given = new Set(call.params);
        const missing = wanted.filter((name) => !given.has(name));
        const extra = call.params.filter((name) => !allowed.has(name));
        if (typeof entry !== 'string' && !given.has('count')) missing.push('count (plural)');
        if (missing.length || extra.length) {
          problems.push(`${call.file}:${call.line} ${lang} "${call.key}" missing [${missing}] unexpected [${extra}]`);
        }
      }
    }
    assert.ok(sites.length >= minimum, `only ${sites.length} call sites checked (floor ${minimum}); the scanner is broken`);
    for (const wanted of mustInclude) {
      const [suffix, key] = wanted.split(' ');
      assert.ok(
        sites.some((call) => call.file.split(path.sep).join('/').endsWith(suffix) && call.key === key),
        `${wanted} was not among the checked call sites; the scanner is broken`,
      );
    }
    return { problems, sites: sites.length };
  }

  // Measured 2026-09-16: renderer 236, main 95 distinct inspectable
  // call sites. Floors sit a little below, so deleting a few calls does not
  // trip them but a scanner that skips most calls does.
  test('renderer: src/renderer/src against common.json + renderer.json', () => {
    const files = sourceFiles(path.join(ROOT, 'src', 'renderer', 'src'), '.ts');
    const { problems } = check(files, ['common.json', 'renderer.json'], {
      minimum: 220,
      mustInclude: ['components/cost.ts cost.caveat.ttlScope', 'format.ts amount.atLeast'],
    });
    assert.deepEqual(problems, []);
  });

  test('main: src/core and src/main against common.json + main.json', () => {
    const files = [
      ...sourceFiles(path.join(ROOT, 'src', 'core'), '.js'),
      ...sourceFiles(path.join(ROOT, 'src', 'main'), '.js'),
    ];
    const { problems } = check(files, ['common.json', 'main.json'], {
      minimum: 85,
      // The second is a MEMBER call (`i18n.t(...)`), the shape index.js uses.
      mustInclude: ['core/tray-tooltip.js countdown.remaining', 'main/index.js app.startupFailed'],
    });
    assert.deepEqual(problems, []);
  });

  test('the scanner is live: it flags a renamed placeholder and a missing count', () => {
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'usage-notch-tcalls-'));
    try {
      const file = path.join(tmp, 'probe.ts');
      fs.writeFileSync(file, [
        "t('ago.minutes', { minutes: 3 });",
        "i18n.t('duration.long.hours', { h: 2 });",
        "t('ago.minutes', { m: 3 });",
        't(dynamicKey, { anything: 1 });',
      ].join('\n'));
      const { problems } = check([file], ['common.json'], { minimum: 1 });
      assert.equal(problems.filter((p) => p.includes('"ago.minutes" missing [m] unexpected [minutes]')).length, 2);
      assert.equal(problems.filter((p) => p.includes('"duration.long.hours"') && p.includes('count')).length, 2);
      assert.equal(problems.length, 4, problems.join('\n'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
