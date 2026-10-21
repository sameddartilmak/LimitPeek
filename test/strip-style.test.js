'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { STRIP_STYLES, DEFAULT_STRIP_STYLE, isStripStyle, sanitizeStripStyle } = require('../src/core/strip-style');
const { createSetStripStyleHandler } = require('../src/main/strip-style-ipc');
const { createPreferences } = require('../src/main/language-ipc');
const settingsStore = require('../src/main/settings');
const { formatModule } = require('./helpers/load-format');

const ROOT = path.join(__dirname, '..');

/**
 * Settings → Genel → Görünüm → "Şerit stili": "Sade" (default), "Halkalı" or
 * "Dolgulu". The value, its sanitising at every boundary, and the handler
 * index.js registers over recorded fakes. The strip's side (the same window
 * re-sent, never rebuilt) is in taskbar-strip.test.js; the page's drawing and
 * its contrast are in strip-styles.test.js.
 */

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-strip-style-'));
}

test.describe('the value', () => {
  test('three literals, the plain bars by default', () => {
    assert.deepEqual(STRIP_STYLES, ['plain', 'rings', 'fill']);
    assert.equal(DEFAULT_STRIP_STYLE, 'plain');
    for (const good of STRIP_STYLES) assert.equal(isStripStyle(good), true);
    for (const bad of ['Rings', 'ring', 'halkali', '', null, undefined, 1, true, {}, ['fill']]) {
      assert.equal(isStripStyle(bad), false, JSON.stringify(bad));
      assert.equal(sanitizeStripStyle(bad), 'plain', JSON.stringify(bad));
    }
  });

  test('settings: a new file and an old file (no key) both read as plain', () => {
    assert.equal(settingsStore.DEFAULTS.stripStyle, 'plain');
    assert.equal(settingsStore.load(tmpDir()).stripStyle, 'plain');
    const dir = tmpDir();
    // An old file whose gauge was "ring": that no longer reaches the strip.
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ trayView: 'strip', gauge: 'ring' }));
    assert.equal(settingsStore.load(dir).stripStyle, 'plain');
  });

  test('settings: "rings" and "fill" survive a round trip; anything else is plain', () => {
    const dir = tmpDir();
    for (const style of ['rings', 'fill']) {
      const s = settingsStore.load(dir);
      s.stripStyle = style;
      assert.equal(settingsStore.save(dir, s), true);
      assert.equal(settingsStore.load(dir).stripStyle, style);
    }
    for (const bad of ['FILL', 'bars', 3, null, { v: 'rings' }]) {
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ stripStyle: bad }));
      assert.equal(settingsStore.load(dir).stripStyle, 'plain', JSON.stringify(bad));
    }
  });

  test('preferences carry the style re-sanitised', () => {
    const base = { currentLocale: () => ({ language: 'tr', resolvedLanguage: 'tr', formatLocale: 'tr-TR' }), readOs: () => ({}) };
    const p = (settings) => createPreferences({ ...base, getSettings: () => settings })();
    assert.equal(p({ stripStyle: 'rings' }).stripStyle, 'rings');
    assert.equal(p({ stripStyle: 'fill' }).stripStyle, 'fill');
    assert.equal(p({ stripStyle: 'dolgulu' }).stripStyle, 'plain');
    assert.equal(p({}).stripStyle, 'plain');
    assert.equal(p(null).stripStyle, 'plain');
  });
});

test.describe('SET_STRIP_STYLE', () => {
  function rig({ fromPanel = true, saves = [], stored = 'plain', pushThrows = false, applyThrows = false } = {}) {
    const calls = [];
    const warnings = [];
    const settings = { theme: 'dark', stripStyle: stored };
    let n = 0;
    const handler = createSetStripStyleHandler({
      fromPanel: () => fromPanel,
      getSettings: () => settings,
      save: (s) => { calls.push(`persist:${s.stripStyle}`); const ok = saves[n] !== false; n += 1; return ok; },
      apply: (v) => { calls.push(`apply:${v}`); if (applyThrows) throw Object.assign(new Error('x'), { code: 'ESTRIP' }); },
      push: () => { calls.push('push'); if (pushThrows) throw Object.assign(new Error('x'), { code: 'EPUSH' }); },
      log: { warn: (m) => warnings.push(m) },
    });
    return { handler, calls, warnings, settings };
  }

  test('persist, hand it to the strip, then push', () => {
    const r = rig();
    assert.deepEqual(r.handler({}, 'rings'), { ok: true });
    assert.deepEqual(r.calls, ['persist:rings', 'apply:rings', 'push']);
    assert.equal(r.settings.stripStyle, 'rings');
    assert.deepEqual(r.handler({}, 'fill'), { ok: true });
    assert.equal(r.settings.stripStyle, 'fill');
  });

  test('anything but the three literals, or a sender that is not the panel, changes nothing', () => {
    for (const bad of ['RINGS', 'ring', '', null, 1, true, {}, ['fill']]) {
      const r = rig();
      assert.deepEqual(r.handler({}, bad), { ok: false }, JSON.stringify(bad));
      assert.deepEqual(r.calls, []);
      assert.equal(r.settings.stripStyle, 'plain');
    }
    const r = rig({ fromPanel: false });
    assert.deepEqual(r.handler({}, 'rings'), { ok: false });
    assert.deepEqual(r.calls, []);
  });

  test('a failed write puts the value back, and neither the strip nor the panel hears of it', () => {
    const r = rig({ saves: [false] });
    assert.deepEqual(r.handler({}, 'fill'), { ok: false });
    assert.deepEqual(r.calls, ['persist:fill']);
    assert.equal(r.settings.stripStyle, 'plain');
    assert.ok(r.warnings.some((w) => w.includes('could not be persisted')));
  });

  test('a strip that throws is logged; the choice is stored and still pushed', () => {
    const r = rig({ applyThrows: true });
    assert.deepEqual(r.handler({}, 'rings'), { ok: true });
    assert.deepEqual(r.calls, ['persist:rings', 'apply:rings', 'push']);
    assert.equal(r.settings.stripStyle, 'rings');
    assert.ok(r.warnings.some((w) => w.includes('ESTRIP')));
  });

  test('a push that throws is logged, and the stored choice still stands', () => {
    const r = rig({ pushThrows: true });
    assert.deepEqual(r.handler({}, 'fill'), { ok: true });
    assert.equal(r.settings.stripStyle, 'fill');
    assert.ok(r.warnings.some((w) => w.includes('EPUSH')));
  });

  test('index.js registers this handler once, and the preload passes a string over its own channel', () => {
    const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8').replace(/\s+/g, ' ');
    assert.ok(main.includes('ipcMain.handle(IPC.SET_STRIP_STYLE, createSetStripStyleHandler({ fromPanel, getSettings: () => settings, save: (s) => settingsStore.save(userDataDir(), s), apply: (style) => { if (strip) strip.setStyle(style); }, push: pushPreferences, log, }))'));
    assert.equal(main.split('IPC.SET_STRIP_STYLE').length - 1, 1);
    const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8');
    assert.match(preload, /setStripStyle: \(style\) => ipcRenderer\.invoke\(CH\.SET_STRIP_STYLE, String\(style\)\)/);
    assert.ok(preload.includes("SET_STRIP_STYLE: 'prefs:set-strip-style'"));
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

  test('sanitizePreferences: "rings" and "fill" pass, anything else (or nothing) is plain', () => {
    assert.equal(s.sanitizePreferences({ ...GOOD, stripStyle: 'rings' }).stripStyle, 'rings');
    assert.equal(s.sanitizePreferences({ ...GOOD, stripStyle: 'fill' }).stripStyle, 'fill');
    assert.equal(s.sanitizePreferences(GOOD).stripStyle, 'plain', 'a main from before the styles');
    for (const bad of ['RINGS', 'ring', 1, null, {}, true]) {
      assert.equal(s.sanitizePreferences({ ...GOOD, stripStyle: bad }).stripStyle, 'plain', JSON.stringify(bad));
    }
  });

  test('app.ts: optimistic, reverted on a refusal, adopted from a push unless a pick is in flight', () => {
    const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'app.ts'), 'utf8');
    assert.match(app, /const ok = await bridge\.setStripStyle\(next\);/);
    assert.match(app, /store\.set\(\{ stripStyle: confirmedStripStyle, stripStyleReverted: true \}\);/);
    assert.match(app, /if \(stripStyleRequest !== null\) return;/);
    assert.match(app, /stripStyle: initialPrefs\?\.stripStyle \?\? 'plain',/);
  });
});
