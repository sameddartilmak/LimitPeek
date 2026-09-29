'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  LANGUAGES, DEFAULT_LANGUAGE, isLanguage, sanitizeLanguage, resolveLanguage,
} = require('../src/core/language');
const settingsStore = require('../src/main/settings');

const ROOT = path.join(__dirname, '..');

/**
 * Source with every comment removed, strings kept. For the few assertions that
 * can only be made on the text of index.js (it requires `electron`), so that a
 * needle cannot be satisfied by a comment that merely names it. Enough of a
 * lexer for the main process: '...', "...", `...`, line and block comments.
 * index.js holds no regex literals; if one ever carries a quote, the needles
 * below fail loudly rather than pass silently.
 */
function codeOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      out += ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

const mainCode = () => codeOf(path.join(ROOT, 'src', 'main', 'index.js'));

/**
 * The language preference, main side (ADR-004 and its Amendment 1).
 *
 * Built like `theme.test.js`, with one addition the theme does not need: the
 * resolution from 'system' to a language and a format locale happens in main,
 * so it is pinned here — by INJECTING the OS signals, never by reading this
 * machine's Windows. The developer's machine is Turkish; a test that read it
 * would only ever exercise one branch.
 */

const TURKISH_MACHINE = { preferredLanguages: ['tr', 'en-US', 'ar-AE'], systemLocale: 'tr-TR' };
const US_MACHINE = { preferredLanguages: ['en-US'], systemLocale: 'en-US' };
const UK_MACHINE = { preferredLanguages: ['en-GB'], systemLocale: 'en-GB' };

test.describe('the three literals', () => {
  test('they are exactly the ones contract.ts declares, in its order', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'contract.ts'), 'utf8');
    const m = /export type LanguageChoice =([^;]+);/.exec(src);
    assert.ok(m, 'contract.ts no longer declares LanguageChoice');
    const declared = [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
    assert.deepEqual([...LANGUAGES], declared);
  });

  test("the default is 'system'", () => {
    assert.equal(DEFAULT_LANGUAGE, 'system');
  });

  test('isLanguage accepts the three and nothing else', () => {
    for (const l of LANGUAGES) assert.equal(isLanguage(l), true, l);
    for (const bad of ['TR', 'En', ' en', 'tr-TR', 'en-US', 'de', '', null, undefined, 0, true, {}, [], ['en']]) {
      assert.equal(isLanguage(bad), false, JSON.stringify(bad));
    }
  });

  test('sanitizeLanguage never returns anything but a real LanguageChoice', () => {
    for (const l of LANGUAGES) assert.equal(sanitizeLanguage(l), l);
    for (const bad of ['TR', 'de', '', null, undefined, 42, {}, []]) {
      assert.equal(sanitizeLanguage(bad), DEFAULT_LANGUAGE, JSON.stringify(bad));
    }
  });
});

/* -------------------------------------------------------------- resolution */

test.describe("resolving 'system' and the format locale", () => {
  test('a Turkish display language resolves to tr and tr-TR', () => {
    assert.deepEqual(resolveLanguage('system', TURKISH_MACHINE),
      { language: 'system', resolvedLanguage: 'tr', formatLocale: 'tr-TR' });
  });

  test('tr* is the primary subtag, so tr-CY is Turkish and trv is not', () => {
    assert.equal(resolveLanguage('system', { preferredLanguages: ['tr-CY'] }).resolvedLanguage, 'tr');
    assert.equal(resolveLanguage('system', { preferredLanguages: ['trv'] }).resolvedLanguage, 'en');
  });

  test('anything that is not Turkish resolves to en', () => {
    for (const tag of ['en-US', 'de-DE', 'ar-AE', 'ja']) {
      assert.equal(resolveLanguage('system', { preferredLanguages: [tag] }).resolvedLanguage, 'en', tag);
    }
  });

  test('the display language is the FIRST of the language list, not any entry', () => {
    // This machine's own list: Turkish first, English second. Picking "any
    // English entry" would put a Turkish user in English.
    assert.equal(resolveLanguage('system', TURKISH_MACHINE).resolvedLanguage, 'tr');
    assert.equal(resolveLanguage('system', { preferredLanguages: ['en-US', 'tr'] }).resolvedLanguage, 'en');
  });

  test('en-US and en-GB machines each get their own format locale', () => {
    assert.equal(resolveLanguage('system', US_MACHINE).formatLocale, 'en-US');
    assert.equal(resolveLanguage('system', UK_MACHINE).formatLocale, 'en-GB');
  });

  test('the regional format decides the English region before the display language', () => {
    // A US-English Windows set to British formats is a user asking for British dates.
    assert.equal(resolveLanguage('system', { preferredLanguages: ['en-US'], systemLocale: 'en-GB' }).formatLocale, 'en-GB');
  });

  test('English chosen on a Turkish machine is en-US, one predictable English', () => {
    assert.deepEqual(resolveLanguage('en', TURKISH_MACHINE),
      { language: 'en', resolvedLanguage: 'en', formatLocale: 'en-US' });
  });

  test('Turkish chosen on a British machine is tr-TR, not a blend', () => {
    assert.deepEqual(resolveLanguage('tr', UK_MACHINE),
      { language: 'tr', resolvedLanguage: 'tr', formatLocale: 'tr-TR' });
  });

  test('extension and script subtags do not leak into the format locale', () => {
    assert.equal(resolveLanguage('system', { preferredLanguages: ['en-Latn-IN-u-ca-buddhist'] }).formatLocale, 'en-IN');
  });

  test('no OS signal at all is English, en-US, and never a throw', () => {
    for (const signals of [undefined, null, {}, { preferredLanguages: null, systemLocale: null },
      { preferredLanguages: ['', null, 42, 'not a tag!'] }, { preferredLanguages: 'tr' }]) {
      assert.deepEqual(resolveLanguage('system', signals),
        { language: 'system', resolvedLanguage: 'en', formatLocale: 'en-US' }, JSON.stringify(signals));
    }
  });

  test('display language and regional format in DIFFERENT languages: the display language decides', () => {
    // Turkish Windows UI with US regional formats: the user reads Turkish.
    assert.deepEqual(resolveLanguage('system', { preferredLanguages: ['tr'], systemLocale: 'en-US' }),
      { language: 'system', resolvedLanguage: 'tr', formatLocale: 'tr-TR' });
    // English Windows UI with Turkish regional formats: English, and since the
    // regional format is not en-*, the region comes from the English display
    // language (A1 ruling 1) — never Turkish-formatted English.
    assert.deepEqual(resolveLanguage('system', { preferredLanguages: ['en-US'], systemLocale: 'tr-TR' }),
      { language: 'system', resolvedLanguage: 'en', formatLocale: 'en-US' });
  });

  test('an unusable first entry is skipped rather than read as not-Turkish', () => {
    assert.equal(resolveLanguage('system', { preferredLanguages: ['', 'tr'] }).resolvedLanguage, 'tr');
  });

  test('an unrecognised stored choice resolves as system', () => {
    assert.deepEqual(resolveLanguage('klingon', TURKISH_MACHINE),
      { language: 'system', resolvedLanguage: 'tr', formatLocale: 'tr-TR' });
  });
});

/* ------------------------------------------------------------- persistence */

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-lang-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const write = (dir, text) => fs.writeFileSync(path.join(dir, 'settings.json'), text, 'utf8');

test.describe('it lives in settings.json beside the theme', () => {
  test('a fresh install defaults to system', (t) => {
    assert.equal(settingsStore.load(tempDir(t)).language, 'system');
    assert.equal(settingsStore.DEFAULTS.language, DEFAULT_LANGUAGE);
  });

  test('every language round trips, and the theme is left alone', (t) => {
    const dir = tempDir(t);
    const s = settingsStore.load(dir);
    s.theme = 'light';
    settingsStore.save(dir, s);
    for (const language of LANGUAGES) {
      const settings = settingsStore.load(dir);
      settings.language = language;
      assert.equal(settingsStore.save(dir, settings), true);
      assert.equal(settingsStore.load(dir).language, language);
      assert.equal(settingsStore.load(dir).theme, 'light');
    }
  });

  test('an unrecognised value falls back to system', (t) => {
    const dir = tempDir(t);
    for (const bad of ['"de"', '"TR"', '"en-US"', 'null', '42', 'true', '{}', '[]', '""']) {
      write(dir, `{ "language": ${bad} }`);
      assert.equal(settingsStore.load(dir).language, DEFAULT_LANGUAGE, bad);
    }
  });

  test('a corrupt file costs the preference, never the panel', (t) => {
    const dir = tempDir(t);
    for (const raw of ['', '{', 'not json', '[]', 'null']) {
      write(dir, raw);
      assert.equal(settingsStore.load(dir).language, DEFAULT_LANGUAGE, JSON.stringify(raw));
    }
  });

  test('a file written before the language existed keeps its other choices', (t) => {
    const dir = tempDir(t);
    write(dir, JSON.stringify({ theme: 'dark', autostart: false, providerOrder: ['kimi', 'claude'] }));
    const loaded = settingsStore.load(dir);
    assert.equal(loaded.language, DEFAULT_LANGUAGE);
    assert.equal(loaded.theme, 'dark');
    assert.equal(loaded.autostart, false);
    assert.deepEqual(loaded.providerOrder, ['kimi', 'claude']);
  });
});

/* --------------------------------------------------------------- the wiring */

test.describe('the SET_LANGUAGE handler, driven for real', () => {
  const { createSetLanguageHandler, osLocale } = require('../src/main/language-ipc');

  /** A handler over recorded fakes. `calls` is the order things happened in. */
  function rig({ fromPanel = true, saves = [], applies = [] } = {}) {
    const calls = [];
    const settings = { theme: 'dark', language: 'tr' };
    const warnings = [];
    let saveN = 0;
    let applyN = 0;
    const handler = createSetLanguageHandler({
      fromPanel: () => fromPanel,
      getSettings: () => settings,
      save: (s) => {
        calls.push(`save:${s.language}`);
        const ok = saves[saveN++];
        return ok === undefined ? true : ok;
      },
      apply: () => {
        calls.push(`apply:${settings.language}`);
        if (applies[applyN++]) throw Object.assign(new Error('x'), { code: 'EBOOM' });
      },
      push: () => calls.push(`push:${settings.language}`),
      log: { warn: (m) => warnings.push(m) },
    });
    return { handler, calls, settings, warnings };
  }

  test('a valid change persists, then applies, then pushes', () => {
    const r = rig();
    assert.deepEqual(r.handler({}, 'en'), { ok: true });
    assert.deepEqual(r.calls, ['save:en', 'apply:en', 'push:en']);
    assert.equal(r.settings.language, 'en');
  });

  test('a message from anything but our panel changes nothing', () => {
    const r = rig({ fromPanel: false });
    assert.deepEqual(r.handler({}, 'en'), { ok: false });
    assert.deepEqual(r.calls, []);
    assert.equal(r.settings.language, 'tr');
  });

  test('a value outside the three literals is refused before anything runs', () => {
    for (const bad of ['de', 'EN', 'en-US', '', null, undefined, 1, {}]) {
      const r = rig();
      assert.deepEqual(r.handler({}, bad), { ok: false }, JSON.stringify(bad));
      assert.deepEqual(r.calls, []);
      assert.equal(r.settings.language, 'tr');
    }
  });

  test('a failed write restores memory, applies nothing and pushes nothing', () => {
    const r = rig({ saves: [false] });
    assert.deepEqual(r.handler({}, 'en'), { ok: false });
    assert.deepEqual(r.calls, ['save:en']);
    assert.equal(r.settings.language, 'tr');
    assert.equal(r.warnings.length, 1);
  });

  test('a failed apply rolls back on disk and on screen, and pushes nothing', () => {
    const r = rig({ applies: [true] });
    assert.deepEqual(r.handler({}, 'en'), { ok: false });
    assert.deepEqual(r.calls, ['save:en', 'apply:en', 'save:tr', 'apply:tr']);
    assert.equal(r.settings.language, 'tr');
    assert.equal(r.calls.some((c) => c.startsWith('push')), false, 'a rejected change must not be pushed');
    assert.ok(r.warnings.some((w) => w.includes('EBOOM')), r.warnings.join('|'));
  });

  test('a rollback write that also fails is said out loud', () => {
    const r = rig({ saves: [true, false], applies: [true] });
    assert.deepEqual(r.handler({}, 'en'), { ok: false });
    assert.ok(r.warnings.some((w) => w.includes('rollback could not be persisted')), r.warnings.join('|'));
  });

  test('osLocale reads the two measured APIs and survives either one throwing', () => {
    assert.deepEqual(
      osLocale({ getPreferredSystemLanguages: () => ['tr', 'en-US'], getSystemLocale: () => 'tr-TR' }),
      { preferredLanguages: ['tr', 'en-US'], systemLocale: 'tr-TR' },
    );
    const boom = () => { throw new Error('before ready'); };
    assert.deepEqual(osLocale({ getPreferredSystemLanguages: () => ['en-GB'], getSystemLocale: boom }),
      { preferredLanguages: ['en-GB'], systemLocale: null });
    assert.deepEqual(osLocale({ getPreferredSystemLanguages: boom, getSystemLocale: boom }),
      { preferredLanguages: [], systemLocale: null });
  });

  test('neither main nor the handler module reads getLocale(): it follows --lang, not the OS', () => {
    for (const file of ['index.js', 'language-ipc.js']) {
      // Comments stripped: the one that explains why it is not used names it.
      const code = codeOf(path.join(ROOT, 'src', 'main', file));
      assert.equal(/\bgetLocale\s*\(/.test(code), false, file);
    }
  });
});

test.describe('applyLanguage and preferences(), driven for real', () => {
  const {
    createSetLanguageHandler, createLocaleResolver, createApplyLanguage, createPreferences,
  } = require('../src/main/language-ipc');

  /**
   * The wiring index.js builds, over recorded fakes: one settings object, a
   * settings store, a tray, a collector whose rebuild emits to a listener that
   * pushes the panel and repaints the tooltip (as index.js's 'snapshot'
   * listener does), and a panel. `calls` is the order things happened in.
   */
  function rig({ os = UK_MACHINE, stored = 'tr', saves = [], menuThrows = [] } = {}) {
    const calls = [];
    const warnings = [];
    const settings = { theme: 'nocturne', language: stored };
    let locale = null;
    let tooltipShown = null;
    let saveN = 0;
    let menuN = 0;

    const resolveLocale = createLocaleResolver({
      getSettings: () => settings,
      readOs: () => os,
      setLocale: (lang, fmt) => calls.push(`setLocale:${lang}/${fmt}`),
      log: { info: () => {} },
    });
    const refreshLocale = () => {
      locale = resolveLocale();
      calls.push(`resolve:${locale.resolvedLanguage}`);
      return locale;
    };
    const preferences = createPreferences({
      getSettings: () => settings, currentLocale: () => locale, readOs: () => os,
    });
    const tray = {
      setMenu: () => {
        calls.push(`menu:${locale.resolvedLanguage}`);
        if (menuThrows[menuN++]) throw Object.assign(new Error('menu'), { code: 'EMENU' });
      },
    };
    const collector = {
      rebuild: () => {
        calls.push(`snapshot:${locale.resolvedLanguage}`);
        const text = `tip-${locale.resolvedLanguage}`;
        if (text !== tooltipShown) {
          calls.push(`tooltip:${text}`);
          tooltipShown = text;
        }
      },
    };
    const applyLanguage = createApplyLanguage({
      refreshLocale,
      getTray: () => tray,
      trayMenuOptions: () => ({}),
      resetTooltip: () => { calls.push('resetTooltip'); tooltipShown = null; },
      getCollector: () => collector,
    });
    const handler = createSetLanguageHandler({
      fromPanel: () => true,
      getSettings: () => settings,
      save: (s) => {
        calls.push(`persist:${s.language}`);
        const ok = saves[saveN++];
        return ok === undefined ? true : ok;
      },
      apply: applyLanguage,
      push: () => calls.push(`preferences:${JSON.stringify(preferences())}`),
      log: { warn: (m) => warnings.push(m) },
    });
    // bootstrap: resolved once, tooltip already on screen.
    refreshLocale();
    tooltipShown = `tip-${locale.resolvedLanguage}`;
    calls.length = 0;
    return { handler, calls, settings, warnings, preferences, currentLocale: () => locale };
  }

  test('order: persist, re-resolve, tray menu and tooltip, snapshot re-publish, PREFERENCES push', () => {
    const r = rig({ os: US_MACHINE, stored: 'tr' });
    assert.deepEqual(r.handler({}, 'en'), { ok: true });
    assert.deepEqual(r.calls, [
      'persist:en',
      'setLocale:en/en-US',
      'resolve:en',
      'menu:en',
      'resetTooltip',
      'snapshot:en',
      'tooltip:tip-en',
      'preferences:{"theme":"system","language":"en","resolvedLanguage":"en","formatLocale":"en-US","autostart":true,"autostartByWindows":false,"setupCoachDismissed":true}',
    ]);
  });

  test('the tooltip cache is reset, so an unchanged tooltip text is still re-set', () => {
    const r = rig({ os: US_MACHINE, stored: 'en' });
    assert.deepEqual(r.handler({}, 'system'), { ok: true });
    assert.ok(r.calls.includes('tooltip:tip-en'), r.calls.join(' | '));
  });

  test('when applying fails, memory, disk and every surface go back, and nothing is pushed', () => {
    const r = rig({ os: US_MACHINE, stored: 'tr', menuThrows: [true] });
    assert.deepEqual(r.handler({}, 'en'), { ok: false });
    assert.equal(r.settings.language, 'tr');
    assert.equal(r.currentLocale().resolvedLanguage, 'tr');
    assert.deepEqual(r.calls, [
      'persist:en', 'setLocale:en/en-US', 'resolve:en', 'menu:en',
      'persist:tr', 'setLocale:tr/tr-TR', 'resolve:tr', 'menu:tr', 'resetTooltip', 'snapshot:tr', 'tooltip:tip-tr',
    ]);
    assert.equal(r.calls.some((c) => c.startsWith('preferences')), false, 'a rejected change must not be pushed');
    assert.ok(r.warnings.some((w) => w.includes('EMENU')), r.warnings.join('|'));
  });

  test('a failed write re-resolves nothing, re-renders nothing and pushes nothing', () => {
    const r = rig({ os: US_MACHINE, stored: 'tr', saves: [false] });
    assert.deepEqual(r.handler({}, 'en'), { ok: false });
    assert.deepEqual(r.calls, ['persist:en']);
    assert.equal(r.currentLocale().resolvedLanguage, 'tr');
  });

  test('preferences() passes formatLocale through: en-GB stays en-GB, in main t() and in the push', () => {
    const r = rig({ os: UK_MACHINE, stored: 'tr' });
    assert.deepEqual(r.handler({}, 'system'), { ok: true });
    assert.deepEqual(r.preferences(),
      { theme: 'system', language: 'system', resolvedLanguage: 'en', formatLocale: 'en-GB', autostart: true, autostartByWindows: false, setupCoachDismissed: true });
    assert.ok(r.calls.includes('setLocale:en/en-GB'), r.calls.join(' | '));
    assert.ok(r.calls.includes('preferences:{"theme":"system","language":"system","resolvedLanguage":"en","formatLocale":"en-GB","autostart":true,"autostartByWindows":false,"setupCoachDismissed":true}'),
      r.calls.join(' | '));
  });

  test('preferences() re-sanitises the theme, and resolves on the spot before any locale exists', () => {
    const early = createPreferences({
      getSettings: () => ({ theme: 'nocturne', language: 'en' }),
      currentLocale: () => null,
      readOs: () => UK_MACHINE,
    });
    assert.deepEqual(early(), { theme: 'system', language: 'en', resolvedLanguage: 'en', formatLocale: 'en-GB', autostart: true, autostartByWindows: false, setupCoachDismissed: true });
    const noSettings = createPreferences({
      getSettings: () => null, currentLocale: () => null, readOs: () => TURKISH_MACHINE,
    });
    assert.deepEqual(noSettings(), { theme: 'system', language: 'system', resolvedLanguage: 'tr', formatLocale: 'tr-TR', autostart: true, autostartByWindows: false, setupCoachDismissed: true });
    const kept = createPreferences({
      getSettings: () => ({ theme: 'dark', language: 'tr' }),
      currentLocale: () => ({ language: 'en', resolvedLanguage: 'en', formatLocale: 'en-AU' }),
      readOs: () => { throw new Error('the OS must not be re-read when a locale is current'); },
    });
    assert.deepEqual(kept(), { theme: 'dark', language: 'en', resolvedLanguage: 'en', formatLocale: 'en-AU', autostart: true, autostartByWindows: false, setupCoachDismissed: true });
  });

  test('applyLanguage tolerates a tray and a collector that do not exist yet', () => {
    const calls = [];
    const apply = createApplyLanguage({
      refreshLocale: () => calls.push('resolve'),
      getTray: () => null,
      trayMenuOptions: () => { throw new Error('menu options built with no tray'); },
      resetTooltip: () => calls.push('resetTooltip'),
      getCollector: () => null,
    });
    apply();
    assert.deepEqual(calls, ['resolve', 'resetTooltip']);
  });
});

test.describe('REQUEST_REFRESH: the reply and its notice describe ONE snapshot', () => {
  const { createRefreshHandler, antigravityRowIsStale } = require('../src/main/refresh-ipc');

  /** A snapshot whose Antigravity row is in `status`, tagged for identity. */
  const snap = (tag, status = 'stale', { lang = 'tr', enabled = true } = {}) => ({
    generatedAt: tag, lang, providers: [{ id: 'claude', enabled: true, status: 'ok' }, { id: 'antigravity', enabled, status }],
  });

  /**
   * The probe wait is held open so a re-publish can land inside it. `scanTo`
   * is what the scan's own rebuild publishes (null: the scan throws).
   */
  function rig({ before = snap('T0'), scanTo = snap('T1'), answer = 'not-running' } = {}) {
    const collector = { snapshot: before };
    const calls = [];
    let releaseProbe;
    const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
    let markWaiting;
    const waiting = new Promise((resolve) => { markWaiting = resolve; });
    const warnings = [];
    const handler = createRefreshHandler({
      fromPanel: (e) => e.ours === true,
      startProbe: () => { calls.push('probe'); return 'probe'; },
      refresh: async () => {
        calls.push('scan');
        if (!scanTo) throw Object.assign(new Error('scan'), { code: 'ESCAN' });
        collector.snapshot = scanTo;
        return collector.snapshot;
      },
      awaitProbe: async (probe) => {
        assert.equal(probe, 'probe');
        calls.push('wait');
        markWaiting();
        await probeGate;
        return answer;
      },
      latestSnapshot: () => collector.snapshot,
      log: { warn: (m) => warnings.push(m) },
    });
    return { handler, collector, calls, releaseProbe, waiting, warnings };
  }

  test('a language re-publish while the probe is pending is what the reply carries, notice included', async () => {
    const r = rig();
    const reply = r.handler({ ours: true });
    await r.waiting;
    // SET_LANGUAGE lands here: collector.rebuild() replaces the snapshot, row still stale.
    const english = snap('T2', 'stale', { lang: 'en' });
    r.collector.snapshot = english;
    r.releaseProbe();
    assert.deepEqual(await reply, { ...english, refreshNotices: ['ANTIGRAVITY_NOT_RUNNING'] });
    assert.equal(r.collector.snapshot.refreshNotices, undefined, 'the notice rides the reply only');
  });

  test('a row re-published as LIVE during the probe wait ships with NO notice', async () => {
    // ADR-001: "its values are not updating" beside values that are updating.
    const r = rig();
    const reply = r.handler({ ours: true });
    await r.waiting;
    const live = snap('T2', 'ok');
    r.collector.snapshot = live; // an agy capture or IDE store write, debounced rebuild
    r.releaseProbe();
    const got = await reply;
    assert.equal(got, live, 'the reply is the live snapshot itself');
    assert.equal(got.refreshNotices, undefined);
  });

  test('a scan that finds the row live skips the wait and the notice', async () => {
    const r = rig({ scanTo: snap('T1', 'ok') });
    const got = await r.handler({ ours: true });
    assert.deepEqual(r.calls, ['probe', 'scan']);
    assert.equal(got.refreshNotices, undefined);
  });

  test('a live or absent row is never probed at all', async () => {
    for (const before of [snap('T0', 'ok'), snap('T0', 'stale', { enabled: false }), { generatedAt: 'T0', providers: [] }]) {
      const r = rig({ before, scanTo: before });
      const got = await r.handler({ ours: true });
      assert.deepEqual(r.calls, ['scan'], JSON.stringify(before));
      assert.equal(got.refreshNotices, undefined);
    }
  });

  test("only 'not-running' becomes a notice; 'running' and 'unknown' say nothing", async () => {
    for (const answer of ['running', 'unknown']) {
      const r = rig({ answer });
      const reply = r.handler({ ours: true });
      await r.waiting;
      r.releaseProbe();
      assert.equal((await reply).refreshNotices, undefined, answer);
    }
  });

  test('with no notice and no re-publish, the reply is the scanned snapshot itself', async () => {
    const r = rig({ answer: 'running' });
    const reply = r.handler({ ours: true });
    await r.waiting;
    r.releaseProbe();
    const got = await reply;
    assert.equal(got, r.collector.snapshot);
    assert.equal(got.generatedAt, 'T1');
    assert.deepEqual(r.calls, ['probe', 'scan', 'wait']);
  });

  test('a failed scan still answers with the current snapshot, and says so in the log', async () => {
    const r = rig({ scanTo: null, answer: 'running' });
    const reply = r.handler({ ours: true });
    await r.waiting;
    const english = snap('T2', 'stale', { lang: 'en' });
    r.collector.snapshot = english;
    r.releaseProbe();
    assert.equal(await reply, english);
    assert.ok(r.warnings.some((w) => w.includes('ESCAN')), r.warnings.join('|'));
  });

  test('a message from anything but our panel gets null and starts nothing', async () => {
    const r = rig();
    assert.equal(await r.handler({}), null);
    assert.deepEqual(r.calls, []);
  });

  test('antigravityRowIsStale reads only an enabled, stale Antigravity row', () => {
    assert.equal(antigravityRowIsStale(snap('x', 'stale')), true);
    for (const s of [snap('x', 'ok'), snap('x', 'stale', { enabled: false }), null, {}, { providers: null }, { providers: [null] }]) {
      assert.equal(antigravityRowIsStale(s), false, JSON.stringify(s));
    }
  });
});

test.describe('what can only be read off index.js (it requires electron), comments stripped', () => {
  test('index.js wires the tested factories with the real dependencies', () => {
    const code = mainCode().replace(/\s+/g, ' ');
    for (const needle of [
      'ipcMain.handle(IPC.SET_LANGUAGE, createSetLanguageHandler({ fromPanel, getSettings: () => settings, save: (s) => settingsStore.save(userDataDir(), s), apply: applyLanguage, push: pushPreferences, log, }))',
      'const applyLanguage = createApplyLanguage({ refreshLocale, getTray: () => tray, trayMenuOptions, resetTooltip: () => { trayTooltipShown = null; }, getCollector: () => collector, })',
      'const preferences = createPreferences({ getSettings: () => settings, currentLocale: () => locale, readOs: () => osLocale(app), storeBuild: () => isStoreBuild(), })',
      'const resolveLocale = createLocaleResolver({ getSettings: () => settings, readOs: () => osLocale(app), setLocale: i18n.setLocale, log, })',
      'function refreshLocale() { locale = resolveLocale(); return locale; }',
      'function pushPreferences() { if (panel) panel.send(IPC.PREFERENCES, preferences()); }',
      'ipcMain.handle(IPC.REQUEST_REFRESH, createRefreshHandler({ fromPanel, startProbe: () => isAntigravityRunning(), refresh: () => collector.refreshNow(), awaitProbe: awaitAntigravityProbe, latestSnapshot: () => collector.snapshot, log, }))',
    ]) {
      assert.ok(code.includes(needle), `index.js no longer wires: ${needle}`);
    }
    // No second, untested copy beside the wired one.
    for (const absent of ['function applyLanguage', 'function preferences', 'resolveLanguage(', 'i18n.setLocale(', 'antigravityRowIsStale', 'refreshNotices']) {
      assert.equal(code.includes(absent), false, `index.js has its own ${absent}`);
    }
    for (const channel of ['IPC.REQUEST_REFRESH', 'IPC.SET_LANGUAGE']) {
      assert.equal(code.split(channel).length - 1, 1, `${channel} is registered more than once`);
    }
  });

  test('the language is resolved in bootstrap before anything builds text', () => {
    const code = mainCode();
    const body = code.slice(code.indexOf('function bootstrap()'));
    const resolved = body.indexOf('refreshLocale()');
    assert.ok(resolved !== -1 && resolved < body.indexOf('new Collector('), 'resolved after the collector was built');
    assert.ok(resolved > body.indexOf('settingsStore.load('), 'resolved before settings were loaded');
  });

  test('the startup-failure dialog is translated, after resolving the language itself', () => {
    const code = mainCode();
    const start = code.indexOf('app.whenReady().then(bootstrap).catch(');
    assert.notEqual(start, -1);
    const body = code.slice(start);
    const resolved = body.indexOf('refreshLocale()');
    const shown = body.indexOf("i18n.t('app.startupFailed')");
    assert.ok(resolved !== -1 && shown !== -1 && resolved < shown, body);
  });

  test('the preload exposes setLanguage over its own channel', () => {
    const preload = codeOf(path.join(ROOT, 'src', 'main', 'preload.js'));
    assert.ok(/setLanguage:\s*\(language\) => ipcRenderer\.invoke\(CH\.SET_LANGUAGE, String\(language\)\)/.test(preload));
  });
});

/* ------------------------------------------------ the bridges speak no language */

test.describe('the Claude statusline bridge shows nothing of its own', () => {
  const BRIDGE = path.join(ROOT, 'bridge', 'claude-statusline.mjs');
  const PAYLOAD = {
    model: { display_name: 'Opus 5.5' },
    context_window: { used_percentage: 41 },
    rate_limits: { five_hour: { used_percentage: 24.4 }, seven_day: { used_percentage: 41 } },
  };
  /** Runs a copy of the bridge in its own folder, optionally with a kept line. */
  function run(payload, chain) {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-lang-bridge-'));
    try {
      const dir = path.join(out, 'bridge');
      fs.mkdirSync(dir);
      const script = path.join(dir, 'claude-statusline.mjs');
      fs.copyFileSync(BRIDGE, script);
      if (chain !== undefined) fs.writeFileSync(path.join(dir, 'claude-chain.json'), JSON.stringify(chain));
      const r = spawnSync(process.execPath, [script], {
        input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, LOCALAPPDATA: out },
      });
      const snap = path.join(out, 'UsageNotch', 'claude-rate-limits.json');
      return { ...r, snapshot: fs.existsSync(snap) ? JSON.parse(fs.readFileSync(snap, 'utf8')) : null };
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }
  const echoLine = (text) => ({ statusLine: { type: 'command', command: `node -e "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('${text}'))"` } });

  test('with no line of its own the user sees nothing, and the limits are still captured', () => {
    const r = run(PAYLOAD);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.snapshot.fiveHour.usedPercentage, 24.4);
    assert.equal(r.snapshot.sevenDay.usedPercentage, 41);
  });

  test('the kept line of the user is run and printed unchanged', () => {
    const r = run(PAYLOAD, echoLine('my own line'));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'my own line');
    assert.equal(r.snapshot.fiveHour.usedPercentage, 24.4, 'the capture still happens');
  });

  test('the kept line receives the same payload Claude Code sent', () => {
    const r = run(PAYLOAD, { statusLine: { type: 'command', command: `node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).model.display_name))"` } });
    assert.equal(r.stdout, 'Opus 5.5');
  });

  test('a kept line that names the bridge itself, or is not a command, is ignored', () => {
    for (const chain of [
      { statusLine: { type: 'command', command: 'node "C:/x/claude-statusline.mjs"' } },
      { statusLine: { type: 'static', command: 'echo hi' } },
      { statusLine: { type: 'command', command: '   ' } },
      'not json at all',
    ]) {
      const r = run(PAYLOAD, chain);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '', JSON.stringify(chain));
    }
  });

  test('nothing from the payload but the limits reaches the snapshot', () => {
    const text = JSON.stringify(run(PAYLOAD).snapshot);
    for (const leak of ['Opus', 'used_percentage":41,']) assert.equal(text.includes(leak), false, leak);
  });

  test('neither bridge source carries the old Turkish tokens', () => {
    const claude = fs.readFileSync(BRIDGE, 'utf8');
    for (const token of ['5sa %', '7g %', 'bagli']) {
      assert.equal(claude.includes(token), false, `claude bridge still prints ${token}`);
    }
    const agy = fs.readFileSync(path.join(ROOT, 'bridge', 'antigravity-statusline.mjs'), 'utf8');
    assert.equal(agy.includes("'Usage Notch bagli'"), false);
    assert.equal(/\bkalan\b/.test(agy), false, 'agy bridge still says kalan');
  });

  test('the Antigravity line states REMAINING in the same vocabulary, unconverted', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-lang-agy-'));
    try {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'bridge', 'antigravity-statusline.mjs')], {
        input: JSON.stringify({ quota: { 'gemini-5h': { remaining_fraction: 0.76 }, 'gemini-weekly': { remaining_fraction: 0.94 } } }),
        encoding: 'utf8',
        env: { ...process.env, LOCALAPPDATA: out },
      });
      assert.equal(r.status, 0);
      // 94% LEFT: the fraction as the CLI stated it, never converted to 6% used,
      // and never a bare 94% that would read as used beside Claude's line.
      assert.equal(r.stdout, 'gemini-5h 76% left · gemini-weekly 94% left');
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------ main speaks through the catalogs */

test.describe('every main-process surface speaks the resolved language (ADR-004 Part 2)', () => {
  const i18n = require('../src/core/i18n');
  const { buildSnapshot } = require('../src/core/snapshot');
  const { PROVIDERS } = require('../src/core/providers');

  function inEnglish(body) {
    i18n.setLocale('en', 'en-US');
    try {
      body();
    } finally {
      i18n.setLocale('tr', 'tr-TR');
    }
  }

  test('the setup text carried in the snapshot is re-translated by a rebuild, not frozen at load', () => {
    const build = () => buildSnapshot({
      now: Date.parse('2026-09-08T12:00:00Z'), events: [], rateLimits: { state: 'missing' }, scanOk: true,
    });
    const trRow = build().providers.find((p) => p.id === 'qwen');
    let enRow = null;
    inEnglish(() => { enRow = build().providers.find((p) => p.id === 'qwen'); });
    assert.equal(trRow.setupAction.label, 'Ekle');
    assert.equal(enRow.setupAction.label, 'Add');
    assert.equal(enRow.setupAction.detail, 'Qwen Code was not found on this computer.');
    assert.equal(trRow.setupAction.detail, 'Qwen Code bu bilgisayarda bulunamadı.');
    assert.equal(enRow.setupAction.kind, trRow.setupAction.kind, 'kind is not text and never changes');
  });

  test('every registry setup action has English label and detail with no Turkish in them', () => {
    inEnglish(() => {
      for (const p of PROVIDERS) {
        const { label, detail } = p.setupAction;
        assert.doesNotMatch(`${label} ${detail}`, /[çğıöşüÇĞİÖŞÜ]|\b(Ekle|Bağla|Bagla)\b/, p.id);
        assert.ok(label.length <= 24, `${p.id} label is ${label.length} chars; sanitize caps it at 24`);
        assert.ok(detail.length <= 160, `${p.id} detail is ${detail.length} chars; sanitize caps it at 160`);
      }
    });
  });

  test('no user-facing Turkish literal is left anywhere in src/core or src/main', () => {
    // The Turkish-letter check alone misses ASCII-only words (ADR-004 A1.8),
    // so a deny-list of the ones this lane has actually shipped rides with it.
    const TURKISH = /[çğıöşüÇĞİÖŞÜ]|\b(Tamam|Ekle|Yenile|Bagla|bagli|Cikis|Kapat|kurulu|degil|saat|dakika|gun|hafta|kaldi)\b/;
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      return /\.(js|html)$/.test(e.name) ? [full] : [];
    });
    const offenders = [];
    for (const file of [...walk(path.join(ROOT, 'src', 'core')), ...walk(path.join(ROOT, 'src', 'main'))]) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (/^\s*(\*|\/\/|\/\*|<!--)/.test(line)) return;
        const code = line.replace(/\s\/\/.*$/, '');
        const literals = code.match(/'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|>[^<]+</g) || [];
        for (const lit of literals) {
          if (TURKISH.test(lit)) offenders.push(`${path.relative(ROOT, file)}:${i + 1} ${lit.slice(0, 60)}`);
        }
      });
    }
    assert.deepEqual(offenders, []);
  });

  test('the catalogs main loads cover every key main asks for', () => {
    // A key typed in code but absent from main.json falls through to the key
    // itself on screen. Collected from the source rather than listed by hand.
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      return e.name.endsWith('.js') ? [full] : [];
    });
    const asked = new Set();
    for (const file of [...walk(path.join(ROOT, 'src', 'core')), ...walk(path.join(ROOT, 'src', 'main'))]) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z][\w.]*)'/g)) asked.add(m[1]);
      for (const m of src.matchAll(/\bsetup\(\s*'[^']+',\s*'([\w.]+)',\s*'([\w.]+)'/g)) { asked.add(m[1]); asked.add(m[2]); }
    }
    assert.ok(asked.size >= 40, `only ${asked.size} keys found; the scan is broken`);
    for (const language of ['tr', 'en']) {
      const known = new Set(i18n.keys(language));
      const missing = [...asked].filter((k) => !known.has(k));
      assert.deepEqual(missing, [], `${language}: keys used in code but absent from the catalogs`);
    }
  });
});
