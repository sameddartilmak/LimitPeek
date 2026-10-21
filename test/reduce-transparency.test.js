'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_REDUCE_TRANSPARENCY, isReduceTransparency, sanitizeReduceTransparency,
} = require('../src/core/reduce-transparency');
const { createSetReduceTransparencyHandler } = require('../src/main/reduce-transparency-ipc');
const { createPreferences } = require('../src/main/language-ipc');
const settingsStore = require('../src/main/settings');
const { formatModule } = require('./helpers/load-format');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

/**
 * Settings → Genel → Görünüm → "Saydamlığı azalt": the panel's glass (the
 * header and the settings tab band) drawn opaque. The value, its sanitising
 * at every boundary, the handler index.js registers over recorded fakes,
 * Windows' own half (nativeTheme), the renderer's frame-one write of
 * `html[data-reduce-transparency]`, and the CSS that answers it.
 */

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-glass-'));
}

test.describe('the value', () => {
  test('a real boolean, off by default; only `true` is on', () => {
    assert.equal(DEFAULT_REDUCE_TRANSPARENCY, false);
    assert.equal(isReduceTransparency(true), true);
    assert.equal(isReduceTransparency(false), true);
    assert.equal(sanitizeReduceTransparency(true), true);
    for (const bad of ['true', 1, 'yes', null, undefined, {}, [true], 0, '']) {
      assert.equal(isReduceTransparency(bad), false, JSON.stringify(bad));
      assert.equal(sanitizeReduceTransparency(bad), false, JSON.stringify(bad));
    }
  });

  test('settings: a new file and an old file (no key) both read as the glass', () => {
    assert.equal(settingsStore.DEFAULTS.reduceTransparency, false);
    assert.equal(settingsStore.load(tmpDir()).reduceTransparency, false);
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ gauge: 'ring' }));
    assert.equal(settingsStore.load(dir).reduceTransparency, false);
  });

  test('settings: `true` survives a round trip; anything else is off', () => {
    const dir = tmpDir();
    const s = settingsStore.load(dir);
    s.reduceTransparency = true;
    assert.equal(settingsStore.save(dir, s), true);
    assert.equal(settingsStore.load(dir).reduceTransparency, true);
    for (const bad of ['true', 1, null, { on: true }]) {
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ reduceTransparency: bad }));
      assert.equal(settingsStore.load(dir).reduceTransparency, false, JSON.stringify(bad));
    }
  });

  test('preferences carry the choice re-sanitised, and Windows\' half only as a real `true`', () => {
    const base = { currentLocale: () => ({ language: 'tr', resolvedLanguage: 'tr', formatLocale: 'tr-TR' }), readOs: () => ({}) };
    const p = (settings, system) => createPreferences({ ...base, getSettings: () => settings, systemReducedTransparency: system })();
    assert.equal(p({ reduceTransparency: true }).reduceTransparency, true);
    assert.equal(p({ reduceTransparency: 'true' }).reduceTransparency, false);
    assert.equal(p({}).reduceTransparency, false);
    assert.equal(p(null).reduceTransparency, false);
    assert.equal(p({}, () => true).systemReducedTransparency, true);
    assert.equal(p({}, () => 1).systemReducedTransparency, false);
    assert.equal(p({}).systemReducedTransparency, false, 'no reader: not asked');
  });
});

test.describe('SET_REDUCE_TRANSPARENCY', () => {
  function rig({ fromPanel = true, saves = [], stored = false, pushThrows = false } = {}) {
    const calls = [];
    const warnings = [];
    const settings = { theme: 'dark', reduceTransparency: stored };
    let n = 0;
    const handler = createSetReduceTransparencyHandler({
      fromPanel: () => fromPanel,
      getSettings: () => settings,
      save: (s) => { calls.push(`persist:${s.reduceTransparency}`); const ok = saves[n] !== false; n += 1; return ok; },
      push: () => { calls.push('push'); if (pushThrows) throw Object.assign(new Error('x'), { code: 'EPUSH' }); },
      log: { warn: (m) => warnings.push(m) },
    });
    return { handler, calls, warnings, settings };
  }

  test('persist, then push', () => {
    const r = rig();
    assert.deepEqual(r.handler({}, true), { ok: true });
    assert.deepEqual(r.calls, ['persist:true', 'push']);
    assert.equal(r.settings.reduceTransparency, true);
    assert.deepEqual(r.handler({}, false), { ok: true });
    assert.equal(r.settings.reduceTransparency, false);
  });

  test('anything but a real boolean, or a sender that is not the panel, changes nothing', () => {
    for (const bad of ['true', 1, 0, null, undefined, {}, [true]]) {
      const r = rig();
      assert.deepEqual(r.handler({}, bad), { ok: false }, JSON.stringify(bad));
      assert.deepEqual(r.calls, []);
      assert.equal(r.settings.reduceTransparency, false);
    }
    const r = rig({ fromPanel: false });
    assert.deepEqual(r.handler({}, true), { ok: false });
    assert.deepEqual(r.calls, []);
  });

  test('a failed write puts the value back and pushes nothing', () => {
    const r = rig({ saves: [false] });
    assert.deepEqual(r.handler({}, true), { ok: false });
    assert.deepEqual(r.calls, ['persist:true']);
    assert.equal(r.settings.reduceTransparency, false);
    assert.ok(r.warnings.some((w) => w.includes('could not be persisted')));
  });

  test('a push that throws is logged, and the stored choice still stands', () => {
    const r = rig({ pushThrows: true });
    assert.deepEqual(r.handler({}, true), { ok: true });
    assert.equal(r.settings.reduceTransparency, true);
    assert.ok(r.warnings.some((w) => w.includes('EPUSH')));
  });

  test('index.js registers this handler once, reads Windows\' half from nativeTheme, and the preload passes a boolean', () => {
    const main = read('src', 'main', 'index.js').replace(/\s+/g, ' ');
    assert.ok(main.includes('ipcMain.handle(IPC.SET_REDUCE_TRANSPARENCY, createSetReduceTransparencyHandler({ fromPanel, getSettings: () => settings, save: (s) => settingsStore.save(userDataDir(), s), push: pushPreferences, log, }))'));
    assert.equal(main.split('IPC.SET_REDUCE_TRANSPARENCY').length - 1, 1);
    assert.ok(main.includes('nativeTheme.prefersReducedTransparency === true || nativeTheme.inForcedColorsMode === true'));
    // A change of Windows' half is pushed from the existing nativeTheme listener.
    assert.match(main, /nativeTheme\.on\('updated', \(\) => \{.*const glassOff = systemReducedTransparency\(\); if \(glassOff !== systemGlassOff\) \{ systemGlassOff = glassOff; pushPreferences\(\); \}/);
    const preload = read('src', 'main', 'preload.js');
    assert.match(preload, /setReduceTransparency: \(reduce\) => ipcRenderer\.invoke\(CH\.SET_REDUCE_TRANSPARENCY, reduce === true\)/);
    assert.ok(preload.includes("SET_REDUCE_TRANSPARENCY: 'prefs:set-reduce-transparency'"));
  });
});

test.describe('the renderer', () => {
  const loader = formatModule();
  let s = null;
  test.before(async () => {
    await loader.load();
    s = await loader.sanitize();
  });
  test.after(() => loader.cleanup());

  const GOOD = { theme: 'dark', language: 'en', resolvedLanguage: 'en', formatLocale: 'en-GB', autostart: true, autostartByWindows: false, setupCoachDismissed: true };

  test('sanitizePreferences: only a real `true` turns either half on', () => {
    assert.equal(s.sanitizePreferences({ ...GOOD, reduceTransparency: true }).reduceTransparency, true);
    assert.equal(s.sanitizePreferences({ ...GOOD, systemReducedTransparency: true }).systemReducedTransparency, true);
    const old = s.sanitizePreferences(GOOD);
    assert.equal(old.reduceTransparency, false, 'a main from before the glass');
    assert.equal(old.systemReducedTransparency, false);
    for (const bad of ['true', 1, {}, null]) {
      assert.equal(s.sanitizePreferences({ ...GOOD, reduceTransparency: bad }).reduceTransparency, false, JSON.stringify(bad));
      assert.equal(s.sanitizePreferences({ ...GOOD, systemReducedTransparency: bad }).systemReducedTransparency, false);
    }
  });

  test('app.ts writes html[data-reduce-transparency] in frame one, and puts the old value back on a refusal', () => {
    const app = read('src', 'renderer', 'src', 'app.ts');
    assert.match(app, /document\.documentElement\.dataset\.reduceTransparency = 'true';/);
    assert.match(app, /delete document\.documentElement\.dataset\.reduceTransparency;/);
    const first = app.indexOf('paintGlass(initialPrefs?.reduceTransparency === true, initialPrefs?.systemReducedTransparency === true);');
    assert.notEqual(first, -1, 'the frame-one paint is missing');
    assert.ok(first < app.search(/store\.set\(\{\s+theme: theme\.choice\(\)/), 'painted before the first store write');
    assert.ok(first < app.indexOf('createPanel('), 'painted before the panel is built');
    assert.match(app, /paintGlass\(confirmedReduce, store\.get\(\)\.systemReducedTransparency\);/);
    assert.match(app, /say\(t\('app\.reduceTransparencyNotSaved'\), 'error'\);/);
  });

  test('the CSS: every glass token goes opaque for the switch, Windows\' reduced transparency and high contrast', () => {
    const tokens = read('src', 'renderer', 'styles', 'tokens.css');
    const opaque = /\{\s*--glass: var\(--ink-900\);\s*--glass-filter: none;\s*--glass-ctl: var\(--ink-850\);\s*\}/;
    const own = tokens.indexOf(':root[data-reduce-transparency] {');
    assert.notEqual(own, -1);
    assert.match(tokens.slice(own, own + 200), opaque);
    const media = tokens.indexOf('@media (prefers-reduced-transparency: reduce), (forced-colors: active) {');
    assert.notEqual(media, -1);
    assert.match(tokens.slice(media, media + 260), opaque);
    // Every glass surface draws from those tokens and nothing else.
    const panel = read('src', 'renderer', 'styles', 'panel.css');
    assert.match(panel, /\.hdr \{[^}]*background: var\(--glass\);[^}]*backdrop-filter: var\(--glass-filter\);/);
  });
});
