'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_TRANSPARENCY, isTransparency, sanitizeTransparency, transparencyFromSettings,
} = require('../src/core/transparency');
const { createSetTransparencyHandler } = require('../src/main/transparency-ipc');
const { createPreferences } = require('../src/main/language-ipc');
const settingsStore = require('../src/main/settings');
const { formatModule } = require('./helpers/load-format');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

/**
 * Settings → Genel → Görünüm → "Saydamlık": a slider from 0 (the opaque
 * panel) to 100 (clear glass), which replaced the "Saydamlığı azalt" switch.
 * The value, its sanitising at every boundary, the migration from the old
 * boolean, the handler index.js registers over recorded fakes, Windows' own
 * half (nativeTheme), the renderer's frame-one write of
 * `html[data-reduce-transparency]` at 0, and the CSS that answers it. What a
 * level does to the window is test/panel-material.test.js.
 */

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-glass-'));
}

test.describe('the value', () => {
  test('an integer from 0 to 100, 45 by default; nothing is coerced at the IPC check', () => {
    assert.equal(DEFAULT_TRANSPARENCY, 45);
    for (const good of [0, 1, 45, 55, 56, 100]) assert.equal(isTransparency(good), true, String(good));
    for (const bad of [-1, 101, 45.5, NaN, Infinity, '45', null, undefined, true, {}, [45]]) {
      assert.equal(isTransparency(bad), false, String(bad));
    }
  });

  test('sanitising: a finite number rounded and clamped, anything else the default', () => {
    assert.equal(sanitizeTransparency(0), 0);
    assert.equal(sanitizeTransparency(100), 100);
    assert.equal(sanitizeTransparency(47.4), 47);
    assert.equal(sanitizeTransparency(150), 100);
    assert.equal(sanitizeTransparency(-20), 0);
    for (const bad of [NaN, Infinity, -Infinity, '45', null, undefined, true, {}]) {
      assert.equal(sanitizeTransparency(bad), DEFAULT_TRANSPARENCY, String(bad));
    }
  });

  test('migration: the old switch\'s `reduceTransparency: true` is 0; anything else the default; a level wins', () => {
    assert.equal(transparencyFromSettings({ reduceTransparency: true }), 0);
    assert.equal(transparencyFromSettings({ reduceTransparency: false }), DEFAULT_TRANSPARENCY);
    assert.equal(transparencyFromSettings({ reduceTransparency: 'true' }), DEFAULT_TRANSPARENCY);
    assert.equal(transparencyFromSettings({}), DEFAULT_TRANSPARENCY);
    assert.equal(transparencyFromSettings(null), DEFAULT_TRANSPARENCY);
    assert.equal(transparencyFromSettings({ transparency: 70, reduceTransparency: true }), 70);
    assert.equal(transparencyFromSettings({ transparency: 0 }), 0);
    assert.equal(transparencyFromSettings({ transparency: '70', reduceTransparency: true }), 0, 'a string is not a level');
  });

  test('settings: a new file and an old file both read as a level; the old key is not carried on', () => {
    assert.equal(settingsStore.DEFAULTS.transparency, DEFAULT_TRANSPARENCY);
    assert.equal('reduceTransparency' in settingsStore.DEFAULTS, false);
    assert.equal(settingsStore.load(tmpDir()).transparency, DEFAULT_TRANSPARENCY);
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ gauge: 'ring' }));
    assert.equal(settingsStore.load(dir).transparency, DEFAULT_TRANSPARENCY);
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ reduceTransparency: true }));
    const migrated = settingsStore.load(dir);
    assert.equal(migrated.transparency, 0, '"Saydamlığı azalt" on stays opaque after the update');
    assert.equal('reduceTransparency' in migrated, false);
    assert.equal(settingsStore.save(dir, migrated), true);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    assert.equal(onDisk.transparency, 0);
    assert.equal('reduceTransparency' in onDisk, false, 'the next save drops the old key');
  });

  test('settings: a level survives a round trip; an odd one is clamped or defaulted', () => {
    const dir = tmpDir();
    const s = settingsStore.load(dir);
    s.transparency = 80;
    assert.equal(settingsStore.save(dir, s), true);
    assert.equal(settingsStore.load(dir).transparency, 80);
    for (const [raw, want] of [[250, 100], [-5, 0], [33.3, 33], ['80', DEFAULT_TRANSPARENCY], [null, DEFAULT_TRANSPARENCY]]) {
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ transparency: raw }));
      assert.equal(settingsStore.load(dir).transparency, want, JSON.stringify(raw));
    }
  });

  test('preferences carry the level re-sanitised, and Windows\' half only as a real `true`', () => {
    const base = { currentLocale: () => ({ language: 'tr', resolvedLanguage: 'tr', formatLocale: 'tr-TR' }), readOs: () => ({}) };
    const p = (settings, system) => createPreferences({ ...base, getSettings: () => settings, systemReducedTransparency: system })();
    assert.equal(p({ transparency: 0 }).transparency, 0);
    assert.equal(p({ transparency: 90 }).transparency, 90);
    assert.equal(p({ transparency: '90' }).transparency, DEFAULT_TRANSPARENCY);
    assert.equal(p({}).transparency, DEFAULT_TRANSPARENCY);
    assert.equal(p(null).transparency, DEFAULT_TRANSPARENCY);
    assert.equal('reduceTransparency' in p({}), false);
    assert.equal(p({}, () => true).systemReducedTransparency, true);
    assert.equal(p({}, () => 1).systemReducedTransparency, false);
    assert.equal(p({}).systemReducedTransparency, false, 'no reader: not asked');
  });
});

test.describe('SET_TRANSPARENCY', () => {
  function rig({ fromPanel = true, saves = [], stored = DEFAULT_TRANSPARENCY, pushThrows = false } = {}) {
    const calls = [];
    const warnings = [];
    const settings = { theme: 'dark', transparency: stored };
    let n = 0;
    const handler = createSetTransparencyHandler({
      fromPanel: () => fromPanel,
      getSettings: () => settings,
      save: (s) => { calls.push(`persist:${s.transparency}`); const ok = saves[n] !== false; n += 1; return ok; },
      push: () => { calls.push('push'); if (pushThrows) throw Object.assign(new Error('x'), { code: 'EPUSH' }); },
      log: { warn: (m) => warnings.push(m) },
    });
    return { handler, calls, warnings, settings };
  }

  test('persist, then push, for every level from 0 to 100', () => {
    const r = rig();
    assert.deepEqual(r.handler({}, 70), { ok: true });
    assert.deepEqual(r.calls, ['persist:70', 'push']);
    assert.equal(r.settings.transparency, 70);
    for (const level of [0, 1, 55, 56, 100]) {
      assert.deepEqual(r.handler({}, level), { ok: true }, String(level));
      assert.equal(r.settings.transparency, level);
    }
  });

  test('untrusted input: anything but an integer from 0 to 100, or a sender that is not the panel, changes nothing', () => {
    for (const bad of [-1, 101, 45.5, NaN, Infinity, '45', null, undefined, true, {}, [45]]) {
      const r = rig();
      assert.deepEqual(r.handler({}, bad), { ok: false }, String(bad));
      assert.deepEqual(r.calls, []);
      assert.equal(r.settings.transparency, DEFAULT_TRANSPARENCY);
    }
    const r = rig({ fromPanel: false });
    assert.deepEqual(r.handler({}, 70), { ok: false });
    assert.deepEqual(r.calls, []);
  });

  test('a failed write puts the value back and pushes nothing', () => {
    const r = rig({ saves: [false] });
    assert.deepEqual(r.handler({}, 0), { ok: false });
    assert.deepEqual(r.calls, ['persist:0']);
    assert.equal(r.settings.transparency, DEFAULT_TRANSPARENCY);
    assert.ok(r.warnings.some((w) => w.includes('could not be persisted')));
  });

  test('a push that throws is logged, and the stored choice still stands', () => {
    const r = rig({ pushThrows: true });
    assert.deepEqual(r.handler({}, 90), { ok: true });
    assert.equal(r.settings.transparency, 90);
    assert.ok(r.warnings.some((w) => w.includes('EPUSH')));
  });

  test('index.js registers this handler once, reads Windows\' half from nativeTheme, and the preload passes only a number', () => {
    const main = read('src', 'main', 'index.js').replace(/\s+/g, ' ');
    assert.ok(main.includes('ipcMain.handle(IPC.SET_TRANSPARENCY, createSetTransparencyHandler({ fromPanel, getSettings: () => settings, save: (s) => settingsStore.save(userDataDir(), s), push: pushPreferences, log, }))'));
    assert.equal(main.split('IPC.SET_TRANSPARENCY').length - 1, 1);
    assert.equal(main.includes('SET_REDUCE_TRANSPARENCY'), false);
    assert.ok(main.includes('nativeTheme.prefersReducedTransparency === true || nativeTheme.inForcedColorsMode === true'));
    // A change of Windows' half is pushed from the existing nativeTheme listener.
    assert.match(main, /nativeTheme\.on\('updated', \(\) => \{.*const glassOff = systemReducedTransparency\(\); if \(glassOff !== systemGlassOff\) \{ systemGlassOff = glassOff; pushPreferences\(\); \}/);
    // The push re-applies the window's look first, so the glass follows each step.
    assert.match(main, /function pushPreferences\(\) \{ if \(!panel\) return; panel\.setLook\(panelLook\(\)\); panel\.send\(IPC\.PREFERENCES, preferences\(\)\); \}/);
    const preload = read('src', 'main', 'preload.js');
    assert.match(preload, /setTransparency: \(level\) => ipcRenderer\.invoke\(CH\.SET_TRANSPARENCY, typeof level === 'number' \? level : null\)/);
    assert.ok(preload.includes("SET_TRANSPARENCY: 'prefs:set-transparency'"));
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

  test('sanitizePreferences: the level rounded and clamped, the default otherwise; Windows\' half only as a real `true`', () => {
    const level = (v, extra = {}) => s.sanitizePreferences({ ...GOOD, transparency: v, ...extra }).transparency;
    assert.equal(level(0), 0);
    assert.equal(level(100), 100);
    assert.equal(level(62.6), 63);
    assert.equal(level(400), 100);
    assert.equal(level(-1), 0);
    for (const bad of ['45', NaN, null, {}, true]) assert.equal(level(bad), 45, String(bad));
    assert.equal(s.DEFAULT_TRANSPARENCY, DEFAULT_TRANSPARENCY, 'the renderer and main agree on the default');
    const old = s.sanitizePreferences(GOOD);
    assert.equal(old.transparency, 45, 'a main from before the slider, switch off');
    assert.equal(s.sanitizePreferences({ ...GOOD, reduceTransparency: true }).transparency, 0, 'a main from before the slider, switch on');
    assert.equal('reduceTransparency' in old, false);
    assert.equal(s.sanitizePreferences({ ...GOOD, systemReducedTransparency: true }).systemReducedTransparency, true);
    for (const bad of ['true', 1, {}, null]) {
      assert.equal(s.sanitizePreferences({ ...GOOD, systemReducedTransparency: bad }).systemReducedTransparency, false);
    }
  });

  test('app.ts writes html[data-reduce-transparency] in frame one at 0, and puts main\'s value back on a refusal', () => {
    const app = read('src', 'renderer', 'src', 'app.ts');
    assert.match(app, /document\.documentElement\.dataset\.reduceTransparency = 'true';/);
    assert.match(app, /delete document\.documentElement\.dataset\.reduceTransparency;/);
    const first = app.indexOf('paintGlass(initialPrefs?.transparency === 0, initialPrefs?.systemReducedTransparency === true);');
    assert.notEqual(first, -1, 'the frame-one paint is missing');
    assert.ok(first < app.search(/store\.set\(\{\s+theme: theme\.choice\(\)/), 'painted before the first store write');
    assert.ok(first < app.indexOf('createPanel('), 'painted before the panel is built');
    assert.match(app, /paintGlass\(confirmedLevel === 0, store\.get\(\)\.systemReducedTransparency\);/);
    assert.match(app, /say\(t\('app\.transparencyNotSaved'\), 'error'\);/);
  });

  test('the CSS: every glass token goes opaque at 0, for Windows\' reduced transparency and for high contrast', () => {
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
