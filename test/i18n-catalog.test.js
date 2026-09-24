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
// 'a floor stays a floor' is gone (2026-09-23): the owner decided the UI shows
// no floor marker at all, so no catalog string says "en az" / "alt sınır" and
// the row would have nothing to guard. A missing-records sentence now says
// plainly that a period may be undercounted (settings.usage.incomplete).
const HONESTY = [
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
    // ADR-002 A3.20: a history amount cell whose records could not be read (guarded below: no figure)
    { file: 'renderer.json', key: 'settings.amount.incomplete', en: [/\bcould not be read\b/], tr: [/okunamadı/] },
    // unreadable records in the history: affected periods are a floor
    { file: 'renderer.json', key: 'settings.usage.incomplete', en: [/\{tools\}/, /\bcould not be read\b/, /\bundercounted\b/i], tr: [/\{tools\}/, /okunamadı/, /eksik olabilir/] },
    // cache reads are outside the billable total
    { file: 'renderer.json', key: 'row.tokens.cacheRead', en: [/\bnot included in the billable total\b/i], tr: [/dahil değil/] },
    // decoded, undocumented source
    { file: 'renderer.json', key: 'quota.derived', en: [/\bnot a documented interface\b/i], tr: [/belgelenmiş bir arayüz değil/i] },
    // usage history is computed locally, from local files only (A2.2, Codex merge)
    // `sources` is the no-tool fallback; the tool list is composed into
    // `sourcesTools` (guarded below: neither hard-codes a tool name)
    { file: 'renderer.json', key: 'settings.usage.sources', en: [/\bonly from local\b/i], tr: [/^Yalnızca yerel\b/] },
    { file: 'renderer.json', key: 'settings.usage.sourcesTools', en: [/\bonly from local\b/i, /\{tools\}/], tr: [/Yalnızca/, /\{tools\}/] },
    // a tool with no published per-token price: no amount, and NOT "not in the price list"
    { file: 'renderer.json', key: 'cost.unpricedSummaryNoTable', en: [/\bdoes not publish\b/, /\bno amount\b/], tr: [/yayımlamıyor/, /tutar yok/] },
    { file: 'renderer.json', key: 'cost.unpricedToggleLabelNoTable', en: [/\bdoes not publish\b/, /\bno amount\b/], tr: [/yayımlamıyor/, /tutar yok/] },
    { file: 'renderer.json', key: 'cost.unpricedSummaryNoModel', en: [/\bNo model was recorded\b/i], tr: [/Model kaydı olmadığı/i] },
    { file: 'renderer.json', key: 'cost.unpricedToggleLabelNoModel', en: [/\bNo model was recorded\b/i], tr: [/Model kaydı olmadığı/i] },
    // Gemini is priced at its API's standard rates, and says so
    { file: 'renderer.json', key: 'cost.summaryGemini', en: [/\bwould have cost\b/i, /\bGemini API standard\b/], tr: [/tutardı/, /Gemini API standart/] },
    { file: 'renderer.json', key: 'cost.toggleLabelGemini', en: [/\bwould have cost\b/i, /\bGemini API standard\b/, /\bnot a bill\b/], tr: [/tutardı/, /Gemini API standart/, /fatura değil/] },
    { file: 'renderer.json', key: 'cost.pricesAsOfGemini', en: [/\bGemini API standard\b/, /\{date\}/], tr: [/Gemini API standart/, /\{date\}/] },
    // The composed per-tool price note (ADR-003 A6): one source line per tool.
    { file: 'renderer.json', key: 'settings.usage.source.date', en: [/\{tool\}/, /\{date\}/], tr: [/\{tool\}/, /\{date\}/] },
    { file: 'renderer.json', key: 'settings.usage.source.dateMissing', en: [/\{tool\}/, /\bnot reported\b/], tr: [/\{tool\}/, /bildirilmedi/] },
    { file: 'renderer.json', key: 'settings.usage.source.gemini', en: [/Gemini API/, /\bstandard\b/, /\{date\}/], tr: [/Gemini API/, /standart/, /\{date\}/] },
    { file: 'renderer.json', key: 'settings.usage.source.geminiNoDate', en: [/Gemini API/, /\bstandard\b/], tr: [/Gemini API/, /standart/] },
    { file: 'renderer.json', key: 'settings.usage.source.none', en: [/\{tool\}/, /\bdoes not publish\b/], tr: [/\{tool\}/, /yayımlamıyor/] },
    // experimental local-file providers (ADR-003 A6): the log format is unverified
    { file: 'renderer.json', key: 'provider.experimental', en: [/\bexperimental\b/], tr: [/deneysel/] },
    { file: 'renderer.json', key: 'provider.experimentalDetail', en: [/\bnot (yet )?(been )?verified\b/, /\breal install\b/], tr: [/doğrulanmadı/, /gerçek bir kurulum/] },
    // a tool that publishes no price says so where the price date would be
    { file: 'renderer.json', key: 'cost.pricesNotPublished', en: [/\{provider\}/, /\bdoes not publish\b/], tr: [/\{provider\}/, /yayımlamıyor/] },
    // an absent tool is "not found", never "not supported"
    { file: 'main.json', key: 'provider.gemini.notFound', en: [/Gemini CLI/, /\bnot found\b/], tr: [/Gemini CLI/, /bulunamadı/] },
    { file: 'main.json', key: 'provider.kimi.notFound', en: [/Kimi Code/, /\bnot found\b/], tr: [/Kimi Code/, /bulunamadı/] },
    // pending state (ADR-002 A3.12): the totals are still being computed —
    // incomplete, which is neither zero nor a floor
    { file: 'renderer.json', key: 'row.tokens.pending', en: [/\bcalculating\b/i], tr: [/hesaplanıyor/] },
    // The row's token figure is the WEEK's and every form of it names its own
    // window. An unlabelled count under two meters is read as whichever one the
    // eye came from, and the burn rate beside it is a five-hour figure — so the
    // five-hour label is pinned too, on both the count and the rate.
    { file: 'renderer.json', key: 'row.tokens.quotaWeek', en: [/\{value\}/, /\bquota week\b/i], tr: [/\{value\}/, /kota haftası/i] },
    { file: 'renderer.json', key: 'row.tokens.last7', en: [/\{value\}/, /\b7 days\b/i], tr: [/\{value\}/, /7 gün/] },
    { file: 'renderer.json', key: 'row.tokens.weekly', en: [/\{value\}/, /\bweek/i], tr: [/\{value\}/, /[Hh]aftalık/] },
    { file: 'renderer.json', key: 'row.tokens.fiveHour', en: [/\{value\}/, /\b5 hours?\b/i], tr: [/\{value\}/, /5 saat/] },
    { file: 'renderer.json', key: 'row.burn.fiveHour', en: [/\{rate\}/, /\b5 hours?\b/i], tr: [/\{rate\}/, /5 saat/] },
    // ADR-002 A3.19: a week whose records could not be read is "could not be
    // counted", NEVER "at least 0 tokens" — a no-figure state presented as a
    // measured floor of zero.
    { file: 'renderer.json', key: 'row.tokens.uncounted', en: [/\bcould not be counted\b/i], tr: [/sayılamadı/] },
    // The plan label is the USER'S OWN STATEMENT — nothing local reports a plan
    // and no vendor tells us. The hint is what stops the select reading as
    // something we verified: it says the value is their note and that we cannot
    // read it from the tool. Short on purpose (owner, 2026-09-23).
    { file: 'renderer.json', key: 'settings.plan.hint', en: [/\byour own\b/i, /\bcannot read it\b/i], tr: [/[Kk]endi notunuz/, /okuyamıyoruz/] },
    // Never a default and never a guess: the empty option says 'not set',
    // which is a fact about us, not a prompt that something is missing.
    { file: 'renderer.json', key: 'settings.plan.placeholder', en: [/\bnot set\b/i], tr: [/[Bb]elirtilmedi/] },
    { file: 'renderer.json', key: 'cost.pending', en: [/\bcalculating\b/i, /\blocal\b/i], tr: [/hesaplanıyor/, /yerel/] },
    { file: 'renderer.json', key: 'settings.usage.pending', en: [/\{tools\}/, /\bincomplete\b/i], tr: [/\{tools\}/, /eksik/] },
    { file: 'renderer.json', key: 'settings.amount.pending', en: [/\bcalculating\b/i], tr: [/hesaplanıyor/] },
    // consent dialogs: no network, and the one network access is consented
    { file: 'main.json', key: 'dialog.claude.promise', en: [/\bno network connection\b/i], tr: [/hiçbir ağ bağlantısı açmaz/] },
    { file: 'main.json', key: 'dialog.agy.promise', en: [/\bno network connection\b/i], tr: [/hiçbir ağ bağlantısı açmaz/] },
    // The Antigravity install is no longer the app's ONLY network access: a
    // stored Copilot key adds requests (ADR-003 A5 K21, A8). The consent detail
    // still names what runs, from where, with whose consent — and now states the
    // key exception itself, with the host and the interval.
    { file: 'main.json', key: 'dialog.agyInstall.detail', en: [/install\.ps1/, /antigravity\.google/, /PowerShell/, /\bwith your consent\b/i, /\bno network requests of its own\b/, /api\.github\.com/, /15 minutes/], tr: [/install\.ps1/, /antigravity\.google/, /PowerShell/, /onayınızla/, /hiçbir ağ isteği yapmaz/, /api\.github\.com/, /15 dakikada bir/] },
    // The optional Copilot key (ADR-003 A5 K21, A8). Consent copy first: what is
    // sent, to which single host, what is kept, what the storage does NOT
    // protect against, that removal is not revocation, and that declining costs
    // the user nothing.
    { file: 'renderer.json', key: 'keyEntry.optional', en: [/\bentirely optional\b/i, /\bnothing changes\b/i], tr: [/tamamen isteğe bağlı/, /hiçbir şey değişmez/] },
    // The exclusivity claim is about REQUESTS, not connections: resolving
    // api.github.com emits DNS datagrams to the configured resolver from this
    // process, so "connects to no other address" claimed more than the kernel
    // supports. Both surfaces now say what is requested and name the resolver
    // (guarded again, as a pair, below).
    { file: 'renderer.json', key: 'keyEntry.what', en: [/\ba single request\b/i, /api\.github\.com/, /\bno other address\b/i, /Windows DNS/], tr: [/tek bir istek/, /api\.github\.com/, /Başka hiçbir adrese/, /Windows'un kendi DNS/] },
    // There is no `keyEntry.host` key: the page states the single host inside
    // `keyEntry.what` and its interval in `keyEntry.frequency`, both pinned here.
    { file: 'renderer.json', key: 'keyEntry.frequency', en: [/15 minutes/], tr: [/15 dakikada bir/] },
    // The proxy limit, stated BEFORE the user creates a credential that could
    // never return a number. Our own limit, conditional, and it says what still
    // works — never a diagnosis of the reader's network.
    { file: 'renderer.json', key: 'keyEntry.proxy', en: [/\b(does not use|never uses|no)\b[^.]*\bsystem proxy\b/i, /\bunavailable\b|\bcannot complete\b/i, /\blocal files\b/i], tr: [/vekil sunucusu(nu)?[^.;]*kullan(maz|mıyor)/i, /gösterilemez|tamamlanamaz/, /yerel dosyalar/] },
    { file: 'renderer.json', key: 'keyEntry.kept', en: [/\bOnly numbers are kept\b/i], tr: [/yalnızca sayılar tutulur/] },
    { file: 'renderer.json', key: 'keyEntry.storage', en: [/\bencrypted for this Windows user\b/i, /\bnot protect it from programs running as this user\b/], tr: [/şifrelenip saklanır/, /çalışan programlara karşı korumaz/] },
    { file: 'renderer.json', key: 'keyEntry.selfPaid', en: [/\bpay for yourself\b/i, /\bnot returned\b/i], tr: [/kendi ödediğiniz/, /gelmez/] },
    { file: 'renderer.json', key: 'keyEntry.removeNote', en: [/\bonly the copy on this computer\b/i, /\brevoke the key at GitHub\b/i], tr: [/yalnızca bu bilgisayardaki kopyayı siler/, /GitHub’da iptal etmeniz gerekir/] },
    { file: 'renderer.json', key: 'key.remove.confirm', en: [/\bOnly the local copy\b/i, /\buntil you revoke it at GitHub\b/i], tr: [/Yalnızca bu bilgisayardaki kopya silinir/, /GitHub’da iptal edilene kadar/] },
    // A deletion the app promised and could not perform must SAY SO, and must
    // name the remedy that works whether or not the file went. The confirm step
    // above promises "only the local copy is deleted"; this is what is shown
    // when that did not happen.
    { file: 'renderer.json', key: 'app.keyRemoveFailed', en: [/\bcould not be deleted\b/i, /\brevoke the token at GitHub\b/i], tr: [/silinemedi/, /GitHub'dan iptal/] },
    // The steps name the one permission and the GitHub button by their on-screen labels.
    { file: 'renderer.json', key: 'keyEntry.steps.1', en: [/Plan: Read-only/, /30-day/], tr: [/Plan: Read-only/, /30 günlük/] },
    { file: 'renderer.json', key: 'keyEntry.steps.2', en: [/Generate token/, /add permissions/i], tr: [/Generate token/, /izin eklemeyin/] },
    { file: 'renderer.json', key: 'keyEntry.steps.3', en: [/github_pat_/, /only once/], tr: [/github_pat_/, /yalnızca bir kez/] },
    { file: 'renderer.json', key: 'keyEntry.keyHint', en: [/\bnever shown\b/i, /\bnever written to logs\b/i], tr: [/gösterilmez/, /günlüklere yazılmaz/] },
    // The row's figures are COUNTS of credits GitHub reported, never a share of
    // an allowance (guarded below: no percentage, limit or quota word).
    { file: 'renderer.json', key: 'key.credits.used', en: [/\{credits\}/, /\bthis month\b/i], tr: [/\{credits\}/, /^Bu ay/] },
    { file: 'renderer.json', key: 'key.credits.split', en: [/\{included\}/, /\{billed\}/, /\bbilled\b/i], tr: [/\{included\}/, /\{billed\}/, /faturalanan/] },
    { file: 'renderer.json', key: 'key.storedAt', en: [/\{date\}/, /\bon this computer\b/i], tr: [/\{date\}/, /bu bilgisayara kaydedildi/] },
    { file: 'renderer.json', key: 'key.state.stored', en: [/\bnot been read yet\b/i], tr: [/henüz okunmadı/] },
    { file: 'renderer.json', key: 'key.state.rejected', en: [/\bnot accepted\b/i], tr: [/kabul edilmedi/] },
    { file: 'renderer.json', key: 'key.state.lacksPermission', en: [/Plan: read/], tr: [/Plan: read/] },
    { file: 'renderer.json', key: 'key.state.rateLimited', en: [/\bGitHub\b/, /\blater\b/i], tr: [/GitHub/, /sonra okunacak/] },
    { file: 'renderer.json', key: 'key.state.notAvailable', en: [/\bpay for yourself\b/i], tr: [/kendi ödediğiniz/i] },
    // 'unreachable' must name the cause that is OURS (ADR-001 A2026-09-22
    // ruling 2: the app resolves DIRECT and never uses a system proxy). A user
    // behind a proxy would otherwise read a permanent limit of this app as a
    // broken key and go and remove it. Two claims, not one sentence: the figure
    // did not arrive, AND we are a reason it cannot.
    // ATTRIBUTION IS THE CLAIM THIS LINE MUST CARRY, and it is pinned by NAME.
    // A proxied network reaches api.github.com perfectly well — the user's own
    // browser does it hourly — so an unattributed "could not be reached" points
    // at their network or at GitHub for a limit WE chose. Naming Usage Notch is
    // what makes the sentence true about the right party. The permanence and the
    // "removing the key will not change that" clause live one surface away, in
    // `key.unreachable.cause`, which is visible in Settings and is this row's
    // title; they are actionability, not attribution.
    { file: 'renderer.json', key: 'key.state.unreachable', en: [/api\.github\.com/, /\bcould not be reached\b/i, /\bUsage Notch\b/, /\bproxy\b/i], tr: [/api\.github\.com/, /ulaşılamadı/, /\bUsage Notch\b/, /vekil/i] },
    // The full cause, where there is room for it (Settings, beside "Remove
    // key"): a proxied network never gets this figure, removing the key does
    // not change that, and everything else on the row is local.
    { file: 'renderer.json', key: 'key.unreachable.cause', en: [/\bdoes not use a system proxy\b/i, /\bnever arrives\b|\bunavailable\b/i, /\bremoving the key\b/i, /\blocal files\b/i], tr: [/vekil sunucusunu kullanmaz/, /hiç gelmez|gösterilemez/, /kaldırmak/, /yerel dosyalar/] },
    { file: 'renderer.json', key: 'key.state.unreadable', en: [/\bcould not be read\b/i, /\bremove it\b/i], tr: [/okunamadı/, /Kaldırıp/] },
    { file: 'renderer.json', key: 'key.state.secureStorageUnavailable', en: [/\bWindows encrypted storage is unavailable\b/i, /\bcould not be read\b/i], tr: [/Windows şifreli depolama kullanılamıyor/, /okunamadı/] },
    // the five entry-window error codes: each says what went wrong, never "try again" alone
    { file: 'renderer.json', key: 'keyEntry.error.invalidUsername', en: [/\bnot valid\b/i, /39 characters/], tr: [/geçersiz/, /39 karakter/] },
    { file: 'renderer.json', key: 'keyEntry.error.storeFailed', en: [/\bcould not be saved\b/i, /\bon this computer\b/i], tr: [/kaydedilemedi/, /bu bilgisayara/] },
    { file: 'renderer.json', key: 'keyEntry.error.noEntry', en: [/\bnot found\b/i, /\bopen it again\b/i], tr: [/bulunamadı/, /yeniden açın/] },
    { file: 'renderer.json', key: 'keyEntry.error.expired', en: [/\btimed out\b/i, /\bOpen it again\b/i], tr: [/zaman aşımına uğradı/, /Yeniden açıp/] },
    { file: 'renderer.json', key: 'keyEntry.error.rejected', en: [/\bnot accepted\b/i, /\bopen it again\b/i], tr: [/kabul edilmedi/, /yeniden açın/] },
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

  test('the floor marker\'s copy is gone from both catalogs (owner, 2026-09-23)', () => {
    // The owner removed "en az", the "Neden en az?" disclosure and every cause
    // line from the panel. A key left behind is copy a later change could wire
    // back in without anyone deciding to; its absence is the decision.
    const REMOVED = /^(cost\.(cause|why|caveat|speed)\.|settings\.usage\.(cause\.|why\.|noteLead)|settings\.usage\.tokens\.lead$|row\.tokens\.floorCause$)/;
    for (const lang of LANGS) {
      const renderer = Object.keys(catalogs[lang]['renderer.json'] || {});
      assert.deepEqual(renderer.filter((key) => REMOVED.test(key)), [], `${lang}: floor copy is back`);
      assert.equal(has(catalogs[lang]['common.json'] || {}, 'amount.atLeast'), false, `${lang}: amount.atLeast is back`);
    }
    // No renderer string prints the floor word or asks why. The one sentence
    // that still says "alt sınır"/"lower bound" is the unread-records note
    // (settings.usage.incomplete), which states a fact about missing records
    // rather than marking a figure.
    for (const lang of LANGS) {
      for (const [key, entry] of Object.entries(catalogs[lang]['renderer.json'] || {})) {
        for (const text of variants(entry)) {
          assert.doesNotMatch(text, /\ben az\b|\bat least\b|Neden en az|Why at least/i, `${lang} "${key}": ${text}`);
        }
      }
    }
  });

  test('every short cost caveat line is short and does not hedge or reassure (ADR-004 A3)', () => {
    // One-line summaries stay one line. The cause and caveat lines this used to
    // cover were removed with the floor marker (owner, 2026-09-23).
    const MAX_CHARS = 100;
    // The cause-line list minus "only"/"yalnızca"/"sadece": in a caveat such as
    // "covers only what was read" it sharpens the incompleteness, not softens it.
    const SOFTENING = /yaklaşık|approximate|\broughly\b|\babout\b|\bjust\b|\bmerely\b|\bminor\b|\bsmall\b|\bnegligible\b|\bslight(ly)?\b|worry|\bno problem\b|küçük|önemsiz|ihmal edilebilir|endişe|merak etme|sorun değil|\bbiraz\b/i;
    let seen = 0;
    for (const lang of LANGS) {
      const entries = catalogs[lang]['renderer.json'] || {};
      for (const [key, entry] of Object.entries(entries)) {
        // The one-line cost summaries for a tool with no price table, no
        // recorded model, or Gemini's standard rates.
        if (!/^(cost\.unpricedSummaryNo(Table|Model)$|cost\.(summary|pricesAsOf)Gemini$)/.test(key)) continue;
        seen += 1;
        for (const text of variants(entry)) {
          assert.ok(text.length <= MAX_CHARS, `${lang} "${key}" is ${text.length} characters (max ${MAX_CHARS}): ${text}`);
          assert.doesNotMatch(text, SOFTENING, `${lang} "${key}" softens its claim: ${text}`);
        }
      }
    }
    // Per language: the 4 one-line summaries, measured 2026-09-23.
    assert.ok(seen >= 8, `the short-line keys exist in both languages (saw ${seen})`);
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

  test('the per-tool price source line names the tool by placeholder only (ADR-003 A6)', () => {
    for (const lang of LANGS) {
      const entries = catalogs[lang]['renderer.json'];
      for (const key of ['settings.usage.source.date', 'settings.usage.source.dateMissing', 'settings.usage.source.none']) {
        assert.deepEqual(placeholders(entries[key]).includes('tool'), true, `${lang}: ${key} names the tool by placeholder`);
        for (const text of variants(entries[key])) {
          assert.doesNotMatch(text, /Claude|Codex|Kimi|Antigravity/, `${lang}: ${key} hard-codes a tool`);
        }
      }
    }
  });

  test('the usage-source sentence never hard-codes a tool list (review HIGH: false provenance)', () => {
    for (const lang of LANGS) {
      const entries = catalogs[lang]['renderer.json'] || {};
      for (const key of ['settings.usage.sources', 'settings.usage.sourcesTools']) {
        assert.ok(has(entries, key), `${lang}: ${key} exists`);
        for (const text of variants(entries[key])) {
          assert.doesNotMatch(text, /Claude|Codex|Gemini|Kimi|Antigravity/, `${lang} "${key}" hard-codes a tool: ${text}`);
        }
      }
    }
  });

  test('a tool that publishes no price is never said to be missing from a price list (review HIGH: false Kimi reason)', () => {
    for (const lang of LANGS) {
      const entries = catalogs[lang]['renderer.json'] || {};
      for (const key of ['cost.unpricedSummaryNoTable', 'cost.unpricedToggleLabelNoTable', 'settings.usage.source.none']) {
        assert.ok(has(entries, key), `${lang}: ${key} exists`);
        for (const text of variants(entries[key])) {
          assert.doesNotMatch(text, /price list|fiyat listesi/i, `${lang} "${key}" blames a price list that does not exist: ${text}`);
        }
      }
    }
  });

  test('a claim that the app makes no network requests always carries the stored-key exception (ADR-003 A5 K21)', () => {
    // The bridge promises ("the bridge … opens no network connection") are about
    // the BRIDGE and stay true. What must never stand unqualified is a claim
    // about the APP, because a stored Copilot key makes requests.
    const NO_NETWORK = /no network (requests?|connection)|hiçbir ağ (isteği|bağlantısı)/i;
    const ABOUT_THE_APP = /\bthe app\b|\bthis app\b|\buygulama/i;
    const QUALIFIER = /unless (you store|a key is stored)|\bwith a .{0,20}key\b|anahtar kaydetme|anahtar saklan|anahtar vermezseniz/i;
    let checked = 0;
    for (const lang of LANGS) {
      for (const [file, entries] of Object.entries(catalogs[lang])) {
        for (const [key, entry] of Object.entries(entries)) {
          for (const text of variants(entry)) {
            // Clause by clause: the qualifier has to sit with the claim, not
            // three sentences away where a reader will not join them.
            for (const clause of text.split(/(?<=[.;])\s+/)) {
              if (!NO_NETWORK.test(clause) || !ABOUT_THE_APP.test(clause)) continue;
              checked += 1;
              assert.match(clause, QUALIFIER,
                `${lang}/${file} "${key}" claims the app makes no network requests with no stored-key exception: ${clause}`);
            }
          }
        }
      }
    }
    assert.ok(checked >= 2, `the app-level no-network claim exists in both languages (saw ${checked})`);
  });

  test("the key consent screen states host, DNS, storage and removal (ADR-003 A8, A9)", () => {
    // Amendment 9 dropped the native box that repeated these facts. The page's
    // consent screen is now the ONLY place they are stated, so each is pinned.
    const FACTS = {
      host: { en: /api\.github\.com/, tr: /api\.github\.com/ },
      // Naming the host is not enough: reaching it resolves the name first, and
      // that leaves this process.
      dns: { en: /Windows DNS/, tr: /Windows'un kendi DNS/ },
      storage: { en: /\bnot protect it from programs running as this user\b/, tr: /çalışan programlara karşı korumaz/ },
      removal: { en: /\brevoke the key at GitHub\b/i, tr: /GitHub’da iptal etmeniz gerekir/ },
    };
    const SURFACES = {
      host: [['renderer.json', 'keyEntry.what']],
      dns: [['renderer.json', 'keyEntry.what']],
      storage: [['renderer.json', 'keyEntry.storage']],
      removal: [['renderer.json', 'keyEntry.removeNote']],
    };
    for (const lang of LANGS) {
      for (const [fact, places] of Object.entries(SURFACES)) {
        for (const [file, key] of places) {
          const entries = catalogs[lang][file] || {};
          assert.ok(has(entries, key), `${lang}/${file} has no "${key}"`);
          for (const text of variants(entries[key])) {
            assert.match(text, FACTS[fact][lang], `${lang}/${file} "${key}" dropped the ${fact} fact`);
          }
        }
      }
    }
  });

  test('the single-destination claim is about what is REQUESTED, never what is connected to (F7)', () => {
    // The WPAD defect was this exact shape: copy that claimed more than the
    // kernel supports. Resolving api.github.com emits UDP/53 to the configured
    // resolver from this process, so an exclusivity claim worded as "contacted"
    // or "connects to" is false as measured, while "requested" is true. This
    // pins the DISTINCTION, so a future edit cannot quietly restore the
    // stronger verb.
    const SURFACES = [['renderer.json', 'keyEntry.what']];
    const OVERCLAIM = /no other address is contacted|connects to no other address|contacts no other address|Başka hiçbir adrese bağlan/i;
    const CLAIM = { en: /no other address is requested|requests no other address/i, tr: /Başka hiçbir adrese istek yap/i };
    let seen = 0;
    for (const lang of LANGS) {
      for (const [file, key] of SURFACES) {
        const entries = catalogs[lang][file] || {};
        assert.ok(has(entries, key), `${lang}/${file} has no "${key}"`);
        for (const text of variants(entries[key])) {
          seen += 1;
          assert.doesNotMatch(text, OVERCLAIM, `${lang}/${file} "${key}" claims exclusivity about connections, which DNS makes false: ${text}`);
          assert.match(text, CLAIM[lang], `${lang}/${file} "${key}" dropped the requests-only claim: ${text}`);
        }
      }
    }
    assert.equal(seen, 2, `the consent screen in both languages (saw ${seen})`);
  });

  test('no credit or key-state line claims a percentage, limit or quota (ADR-003 A5 K21)', () => {
    // GitHub reports credits USED, never an allowance. A percentage or a quota
    // word would be a denominator the app was never given.
    const FORBIDDEN = /%|yüzde|percent|\blimit\b|\bkota\b|\bquota\b/i;
    let seen = 0;
    for (const lang of LANGS) {
      for (const [key, entry] of Object.entries(catalogs[lang]['renderer.json'] || {})) {
        // Every `key.*` line, not just the figure and state ones: the proxy
        // cause line is also copy about a number GitHub reports no allowance for.
        if (!/^key\./.test(key)) continue;
        seen += 1;
        for (const text of variants(entry)) {
          assert.doesNotMatch(text, FORBIDDEN, `${lang} "${key}" claims an allowance: ${text}`);
        }
      }
    }
    // Two credits keys and eight states, per language, measured 2026-09-22.
    assert.ok(seen >= 20, `the credit and key-state lines exist in both languages (saw ${seen})`);
  });

  test('every key state and entry error is one short line that does not hedge (ADR-004 A3)', () => {
    // Measured 2026-09-22: longest is 111 characters (tr keyEntry.error.wrongTokenType).
    const MAX_CHARS = 120;
    const SOFTENING = /yaklaşık|approximate|\broughly\b|\babout\b|\bmerely\b|\bminor\b|\bnegligible\b|\bslight(ly)?\b|worry|\bno problem\b|önemsiz|ihmal edilebilir|endişe|merak etme|sorun değil/i;
    let seen = 0;
    for (const lang of LANGS) {
      for (const [key, entry] of Object.entries(catalogs[lang]['renderer.json'] || {})) {
        if (!/^(key\.state\.|key\.credits\.|keyEntry\.error\.)/.test(key)) continue;
        seen += 1;
        for (const text of variants(entry)) {
          assert.ok(text.length <= MAX_CHARS, `${lang} "${key}" is ${text.length} characters (max ${MAX_CHARS}): ${text}`);
          assert.doesNotMatch(text, SOFTENING, `${lang} "${key}" softens its claim: ${text}`);
        }
      }
    }
    // 23 keys per language, measured 2026-09-22.
    assert.ok(seen >= 46, `the key state and error lines exist in both languages (saw ${seen})`);
  });

  test('a tool that is absent is "not found", never "not supported" (ADR-003 A6)', () => {
    let seen = 0;
    for (const lang of LANGS) {
      for (const [key, entry] of Object.entries(catalogs[lang]['main.json'] || {})) {
        if (!/^provider\.[a-z]+\.notFound$/.test(key)) continue;
        seen += 1;
        for (const text of variants(entry)) {
          assert.doesNotMatch(text, /not supported|unsupported|desteklenmiyor|desteklenmez/i, `${lang} "${key}": ${text}`);
        }
      }
    }
    assert.ok(seen >= 4, `gemini and kimi notFound exist in both languages (saw ${seen})`);
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

  test('there is no formatter left that prints the floor word', () => {
    // atLeast() was removed with the floor marker (owner, 2026-09-23).
    assert.equal('atLeast' in f, false);
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
      mustInclude: ['components/cost.ts cost.pending', 'format.ts cost.model.unknown'],
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
