'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { GAUGES, DEFAULT_GAUGE, isGauge, sanitizeGauge } = require('../src/core/gauge');
const { createSetGaugeHandler } = require('../src/main/gauge-ipc');
const { createPreferences } = require('../src/main/language-ipc');
const settingsStore = require('../src/main/settings');
const { formatModule } = require('./helpers/load-format');

const ROOT = path.join(__dirname, '..');

/**
 * Settings → Genel → Görünüm → "Gösterge": "Çubuk" (default) or "Halka". The
 * value, its sanitising at every boundary, the handler index.js registers over
 * recorded fakes, and the renderer's frame-one write of `html[data-gauge]`.
 */

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-gauge-'));
}

test.describe('the value', () => {
  test('two literals, bars by default', () => {
    assert.deepEqual(GAUGES, ['bar', 'ring']);
    assert.equal(DEFAULT_GAUGE, 'bar');
    assert.equal(isGauge('ring'), true);
    assert.equal(isGauge('bar'), true);
    for (const bad of ['Ring', 'rings', 'donut', '', null, undefined, 1, true, {}, ['ring']]) {
      assert.equal(isGauge(bad), false, JSON.stringify(bad));
      assert.equal(sanitizeGauge(bad), 'bar', JSON.stringify(bad));
    }
  });

  test('settings: a new file and an old file (no key) both read as the bars', () => {
    assert.equal(settingsStore.DEFAULTS.gauge, 'bar');
    assert.equal(settingsStore.load(tmpDir()).gauge, 'bar');
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ autostart: false, trayView: 'strip' }));
    assert.equal(settingsStore.load(dir).gauge, 'bar');
  });

  test('settings: "ring" survives a round trip; a typo or a future value is the bars', () => {
    const dir = tmpDir();
    const s = settingsStore.load(dir);
    s.gauge = 'ring';
    assert.equal(settingsStore.save(dir, s), true);
    assert.equal(settingsStore.load(dir).gauge, 'ring');
    for (const bad of ['RING', 'gauge', 3, null, { v: 'ring' }]) {
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ gauge: bad }));
      assert.equal(settingsStore.load(dir).gauge, 'bar', JSON.stringify(bad));
    }
  });

  test('preferences carry the gauge re-sanitised', () => {
    const base = { currentLocale: () => ({ language: 'tr', resolvedLanguage: 'tr', formatLocale: 'tr-TR' }), readOs: () => ({}) };
    const p = (settings) => createPreferences({ ...base, getSettings: () => settings })();
    assert.equal(p({ gauge: 'ring' }).gauge, 'ring');
    assert.equal(p({ gauge: 'bar' }).gauge, 'bar');
    assert.equal(p({ gauge: 'halka' }).gauge, 'bar');
    assert.equal(p({}).gauge, 'bar');
    assert.equal(p(null).gauge, 'bar');
  });
});

test.describe('SET_GAUGE', () => {
  function rig({ fromPanel = true, saves = [], stored = 'bar', pushThrows = false } = {}) {
    const calls = [];
    const warnings = [];
    const settings = { theme: 'dark', gauge: stored };
    let n = 0;
    const handler = createSetGaugeHandler({
      fromPanel: () => fromPanel,
      getSettings: () => settings,
      save: (s) => { calls.push(`persist:${s.gauge}`); const ok = saves[n] !== false; n += 1; return ok; },
      push: () => { calls.push('push'); if (pushThrows) throw Object.assign(new Error('x'), { code: 'EPUSH' }); },
      log: { warn: (m) => warnings.push(m) },
    });
    return { handler, calls, warnings, settings };
  }

  test('persist, then push: the strip is not told (it has its own style now)', () => {
    const r = rig();
    assert.deepEqual(r.handler({}, 'ring'), { ok: true });
    assert.deepEqual(r.calls, ['persist:ring', 'push']);
    assert.equal(r.settings.gauge, 'ring');
    assert.deepEqual(r.handler({}, 'bar'), { ok: true });
    assert.equal(r.settings.gauge, 'bar');
  });

  test('anything but the two literals, or a sender that is not the panel, changes nothing', () => {
    for (const bad of ['RING', 'rings', '', null, 1, true, {}, ['ring']]) {
      const r = rig();
      assert.deepEqual(r.handler({}, bad), { ok: false }, JSON.stringify(bad));
      assert.deepEqual(r.calls, []);
      assert.equal(r.settings.gauge, 'bar');
    }
    const r = rig({ fromPanel: false });
    assert.deepEqual(r.handler({}, 'ring'), { ok: false });
    assert.deepEqual(r.calls, []);
  });

  test('a failed write puts the value back and pushes nothing', () => {
    const r = rig({ saves: [false] });
    assert.deepEqual(r.handler({}, 'ring'), { ok: false });
    assert.deepEqual(r.calls, ['persist:ring']);
    assert.equal(r.settings.gauge, 'bar');
    assert.ok(r.warnings.some((w) => w.includes('could not be persisted')));
  });

  test('a push that throws is logged, and the stored choice still stands', () => {
    const r = rig({ pushThrows: true });
    assert.deepEqual(r.handler({}, 'ring'), { ok: true });
    assert.equal(r.settings.gauge, 'ring');
    assert.ok(r.warnings.some((w) => w.includes('EPUSH')));
  });

  test('index.js registers this handler once, and the preload passes a string over its own channel', () => {
    const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8').replace(/\s+/g, ' ');
    assert.ok(main.includes('ipcMain.handle(IPC.SET_GAUGE, createSetGaugeHandler({ fromPanel, getSettings: () => settings, save: (s) => settingsStore.save(userDataDir(), s), push: pushPreferences, log, }))'));
    assert.equal(main.split('IPC.SET_GAUGE').length - 1, 1);
    assert.doesNotMatch(main, /strip\.setGauge/, 'the gauge no longer reaches the strip');
    const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8');
    assert.match(preload, /setGauge: \(gauge\) => ipcRenderer\.invoke\(CH\.SET_GAUGE, String\(gauge\)\)/);
    assert.ok(preload.includes("SET_GAUGE: 'prefs:set-gauge'"));
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

  test('sanitizePreferences: "ring" passes, anything else (or nothing) is the bars', () => {
    assert.equal(s.sanitizePreferences({ ...GOOD, gauge: 'ring' }).gauge, 'ring');
    assert.equal(s.sanitizePreferences({ ...GOOD, gauge: 'bar' }).gauge, 'bar');
    assert.equal(s.sanitizePreferences(GOOD).gauge, 'bar', 'a main from before the rings');
    for (const bad of ['RING', 'halka', 1, null, {}, true]) {
      assert.equal(s.sanitizePreferences({ ...GOOD, gauge: bad }).gauge, 'bar', JSON.stringify(bad));
    }
  });

  test('app.ts writes html[data-gauge] in frame one, before the store or the panel exist', () => {
    const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'app.ts'), 'utf8');
    // The user's own, in every layout: nothing forces the rings any more.
    assert.match(app, /document\.documentElement\.dataset\.gauge = gauge;/);
    assert.doesNotMatch(app, /dataset\.gauge = [^;]*'ring'/, 'a layout forces a gauge');
    const first = app.indexOf("paintLayout(initialPrefs?.layout ?? 'sade', initialPrefs?.gauge ?? 'bar');");
    assert.notEqual(first, -1, 'the frame-one paint is missing');
    assert.ok(first < app.search(/store\.set\(\{\s+theme: theme\.choice\(\)/), 'painted before the first store write');
    assert.ok(first < app.indexOf('createPanel('), 'painted before the panel is built');
    // A refusal puts the old gauge back on the document, not only in the radios.
    assert.match(app, /paintGauge\(confirmedGauge\);/);
  });

  test('the ring styles hang off the same attribute, and the sweep respects reduced motion', () => {
    const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles', 'row.css'), 'utf8');
    assert.match(css, /html\[data-gauge="ring"\] \.meter \.rail \{/);
    assert.match(css, /@property --ring-f \{/);
    assert.match(css, /animation: ring-sweep var\(--dur-ring\)/);
    const tokens = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles', 'tokens.css'), 'utf8');
    const reduced = tokens.slice(tokens.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    assert.match(reduced, /--dur-ring: 1ms/);
    const harness = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'dev', 'harness.css'), 'utf8');
    assert.match(harness.slice(0, harness.indexOf('}')), /--dur-ring: 1ms/, 'data-reduce-motion collapses it too');
  });
});

test.describe('the rings\' harder states (row.css)', () => {
  const row = () => fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles', 'row.css'), 'utf8');
  const rule = (body, selector) => {
    const at = body.indexOf(`${selector} {`);
    assert.notEqual(at, -1, `no rule for ${selector}`);
    return body.slice(at, body.indexOf('}', at) + 1);
  };

  test('an estimate fades its tail instead of breaking it into teeth', () => {
    const body = row();
    const est = rule(body, 'html[data-gauge="ring"] .meter .rail__fill.rail__fill--estimated');
    assert.match(est, /--ring-fade: conic-gradient\(from -12deg,\s*#000000 calc\(var\(--ring-f\) \* \.64turn \+ 12deg\),\s*rgba\(0, 0, 0, \.2\) calc\(var\(--ring-f\) \* 1turn \+ 12deg\),\s*transparent 0\);/);
    assert.match(est, /\bmask: var\(--ring-fade\);/);
    assert.doesNotMatch(body, /repeating-conic-gradient/, 'the dashed "gear teeth" tail is back');
  });

  test('estimated and stale together keep both cues: the fade intersected with the hatch', () => {
    const both = rule(row(), 'html[data-gauge="ring"] .row[data-status="stale"] .rail__fill--estimated.rail__fill');
    assert.match(both, /\bmask: var\(--ring-fade\), var\(--ring-hatch\);/);
    assert.match(both, /\bmask-composite: intersect;/);
  });

  test('a window with no figure lights neither ring of its glyph', () => {
    const none = rule(row(), 'html[data-gauge="ring"] .meter:has(.rail) .win:not(:has(.rail))');
    assert.match(none, /--glyph-out: var\(--glyph-dim\);\s*--glyph-in: var\(--glyph-dim\);/);
  });

  test('the loading skeleton is two concentric grooves, at the rings\' sizes', () => {
    const body = row();
    const outer = rule(body, 'html[data-gauge="ring"] .row[data-status="loading"] .sk--rail');
    assert.match(outer, /--ring: 84px;/);
    assert.match(outer, /mask: radial-gradient\(farthest-side, transparent calc\(100% - 10px\)/);
    assert.match(rule(body, 'html[data-gauge="ring"] .row[data-status="loading"] .win + .win .sk--rail'), /--ring: 60px;\s*left: 16px;/);
    assert.match(rule(body, 'html[data-gauge="ring"] .meter .rail--7d'), /--ring: 60px;\s*left: 16px;/, 'the skeleton and the real inner ring disagree');
  });
});
