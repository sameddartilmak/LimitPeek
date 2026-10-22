'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { LAYOUTS, DEFAULT_LAYOUT, LEGACY_LAYOUTS, isLayout, sanitizeLayout } = require('../src/core/layout');
const { createSetLayoutHandler } = require('../src/main/layout-ipc');
const { createPreferences } = require('../src/main/language-ipc');
const settingsStore = require('../src/main/settings');
const { formatModule } = require('./helpers/load-format');
const { FakeElement, installDom, mirrorRenderer, walk } = require('./helpers/fake-dom');

const ROOT = path.join(__dirname, '..');

/**
 * Settings → Genel → Görünüm → "Düzen": "Sade liste" (the default) or "Halka
 * kutuları" (the minimal redesign, 2026-10-22). The value, its sanitising at
 * every boundary — including the migration of the three layouts that came
 * before ('list' and 'focus' read as 'sade', 'tiles' as 'halka') — the
 * handler index.js registers over recorded fakes, the renderer's frame-one
 * write of `html[data-layout]`, and the optimistic pick with its revert,
 * driven through the real `mountApp` on the fake DOM.
 */

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-layout-'));
}

test.describe('the value', () => {
  test('two literals, the short list by default', () => {
    assert.deepEqual(LAYOUTS, ['sade', 'halka']);
    assert.equal(DEFAULT_LAYOUT, 'sade');
    for (const good of LAYOUTS) {
      assert.equal(isLayout(good), true);
      assert.equal(sanitizeLayout(good), good);
    }
    for (const bad of ['Sade', 'HALKA', 'grid', 'odak', '', null, undefined, 1, true, {}, ['halka']]) {
      assert.equal(isLayout(bad), false, JSON.stringify(bad));
      assert.equal(sanitizeLayout(bad), 'sade', JSON.stringify(bad));
    }
  });

  test('the old layouts migrate: the two lists to the short list, the tiles to the ring tiles', () => {
    assert.deepEqual({ ...LEGACY_LAYOUTS }, { list: 'sade', focus: 'sade', tiles: 'halka' });
    assert.equal(sanitizeLayout('list'), 'sade');
    assert.equal(sanitizeLayout('focus'), 'sade');
    assert.equal(sanitizeLayout('tiles'), 'halka');
    // Migrated, never accepted: an old value is a settings file's, not a pick.
    for (const old of ['list', 'focus', 'tiles']) assert.equal(isLayout(old), false, old);
    // Not a prototype lookup: an inherited name is a typo like any other.
    for (const odd of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      assert.equal(sanitizeLayout(odd), 'sade', odd);
    }
  });

  test('settings: a new file and a file from before the layouts both read as the short list', () => {
    assert.equal(settingsStore.DEFAULTS.layout, 'sade');
    assert.equal(settingsStore.load(tmpDir()).layout, 'sade');
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ autostart: false, gauge: 'ring' }));
    assert.equal(settingsStore.load(dir).layout, 'sade');
  });

  test('settings: a file written by 0.6.38 or earlier keeps the user\'s list or grid', () => {
    const dir = tmpDir();
    for (const [old, now] of [['list', 'sade'], ['focus', 'sade'], ['tiles', 'halka']]) {
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ layout: old, theme: 'light' }));
      const s = settingsStore.load(dir);
      assert.equal(s.layout, now, old);
      assert.equal(s.theme, 'light', 'the rest of the file is untouched');
    }
  });

  test('settings: "sade" and "halka" survive a round trip; a typo or a future value is the short list', () => {
    const dir = tmpDir();
    for (const layout of ['halka', 'sade']) {
      const s = settingsStore.load(dir);
      s.layout = layout;
      assert.equal(settingsStore.save(dir, s), true);
      assert.equal(settingsStore.load(dir).layout, layout);
    }
    for (const bad of ['HALKA', 'cards', 3, null, { v: 'halka' }]) {
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ layout: bad }));
      assert.equal(settingsStore.load(dir).layout, 'sade', JSON.stringify(bad));
    }
  });

  test('preferences carry the layout re-sanitised, an old value as its successor', () => {
    const base = { currentLocale: () => ({ language: 'tr', resolvedLanguage: 'tr', formatLocale: 'tr-TR' }), readOs: () => ({}) };
    const p = (settings) => createPreferences({ ...base, getSettings: () => settings })();
    assert.equal(p({ layout: 'halka' }).layout, 'halka');
    assert.equal(p({ layout: 'sade' }).layout, 'sade');
    assert.equal(p({ layout: 'tiles' }).layout, 'halka');
    assert.equal(p({ layout: 'focus' }).layout, 'sade');
    assert.equal(p({ layout: 'kutucuk' }).layout, 'sade');
    assert.equal(p({}).layout, 'sade');
    assert.equal(p(null).layout, 'sade');
  });
});

test.describe('"Gösterge" is gone with the old layouts, end to end', () => {
  const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

  test('no module, no channel, no preload method, no preference', () => {
    assert.equal(fs.existsSync(path.join(ROOT, 'src', 'core', 'gauge.js')), false);
    assert.equal(fs.existsSync(path.join(ROOT, 'src', 'main', 'gauge-ipc.js')), false);
    for (const file of [['src', 'shared', 'contract.ts'], ['src', 'shared', 'contract.js'], ['src', 'main', 'preload.js'], ['src', 'main', 'index.js']]) {
      assert.doesNotMatch(read(...file), /SET_GAUGE|setGauge|prefs:set-gauge/, file.join('/'));
    }
    assert.doesNotMatch(read('src', 'shared', 'contract.ts'), /export type Gauge\b|^\s*gauge: Gauge;/m);
  });

  test('an old settings file that still says "gauge" loads without it, and the preferences carry none', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ gauge: 'ring', layout: 'tiles' }));
    const s = settingsStore.load(dir);
    assert.equal('gauge' in s, false);
    assert.equal(s.layout, 'halka');
    assert.equal('gauge' in settingsStore.DEFAULTS, false);
    const base = { currentLocale: () => ({ language: 'tr', resolvedLanguage: 'tr', formatLocale: 'tr-TR' }), readOs: () => ({}) };
    assert.equal('gauge' in createPreferences({ ...base, getSettings: () => ({ gauge: 'ring' }) })(), false);
  });

  test('the renderer writes no html[data-gauge] and styles nothing by it', () => {
    assert.doesNotMatch(read('src', 'renderer', 'src', 'app.ts'), /dataset\.gauge\s*=/);
    for (const f of fs.readdirSync(path.join(ROOT, 'src', 'renderer', 'styles'))) {
      assert.doesNotMatch(read('src', 'renderer', 'styles', f), /data-gauge/, f);
    }
    for (const lang of ['tr', 'en', 'zh']) {
      assert.doesNotMatch(read('src', 'shared', 'i18n', lang, 'renderer.json'), /"settings\.gauge\.|"app\.gaugeNotSaved"/, lang);
    }
  });
});

test.describe('SET_LAYOUT', () => {
  function rig({ fromPanel = true, saves = [], stored = 'sade', pushThrows = false } = {}) {
    const calls = [];
    const warnings = [];
    const settings = { theme: 'dark', layout: stored };
    let n = 0;
    const handler = createSetLayoutHandler({
      fromPanel: () => fromPanel,
      getSettings: () => settings,
      save: (s) => { calls.push(`persist:${s.layout}`); const ok = saves[n] !== false; n += 1; return ok; },
      push: () => { calls.push('push'); if (pushThrows) throw Object.assign(new Error('x'), { code: 'EPUSH' }); },
      log: { warn: (m) => warnings.push(m) },
    });
    return { handler, calls, warnings, settings };
  }

  test('persist, then push', () => {
    const r = rig();
    assert.deepEqual(r.handler({}, 'halka'), { ok: true });
    assert.deepEqual(r.calls, ['persist:halka', 'push']);
    assert.equal(r.settings.layout, 'halka');
    assert.deepEqual(r.handler({}, 'sade'), { ok: true });
    assert.equal(r.settings.layout, 'sade');
  });

  test('anything but the two literals — the old three included — or a sender that is not the panel, changes nothing', () => {
    for (const bad of ['list', 'focus', 'tiles', 'HALKA', 'grid', '', null, 1, true, {}, ['halka']]) {
      const r = rig();
      assert.deepEqual(r.handler({}, bad), { ok: false }, JSON.stringify(bad));
      assert.deepEqual(r.calls, []);
      assert.equal(r.settings.layout, 'sade');
    }
    const r = rig({ fromPanel: false });
    assert.deepEqual(r.handler({}, 'halka'), { ok: false });
    assert.deepEqual(r.calls, []);
  });

  test('a failed write puts the value back and pushes nothing', () => {
    const r = rig({ saves: [false] });
    assert.deepEqual(r.handler({}, 'halka'), { ok: false });
    assert.deepEqual(r.calls, ['persist:halka']);
    assert.equal(r.settings.layout, 'sade');
    assert.ok(r.warnings.some((w) => w.includes('could not be persisted')));
  });

  test('a push that throws is logged, and the stored choice still stands', () => {
    const r = rig({ pushThrows: true });
    assert.deepEqual(r.handler({}, 'halka'), { ok: true });
    assert.equal(r.settings.layout, 'halka');
    assert.ok(r.warnings.some((w) => w.includes('EPUSH')));
  });

  test('index.js registers this handler once, and the preload passes a string over its own channel', () => {
    const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8').replace(/\s+/g, ' ');
    assert.ok(main.includes('ipcMain.handle(IPC.SET_LAYOUT, createSetLayoutHandler({ fromPanel, getSettings: () => settings, save: (s) => settingsStore.save(userDataDir(), s), push: pushPreferences, log, }))'));
    assert.equal(main.split('IPC.SET_LAYOUT').length - 1, 1);
    const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8');
    assert.match(preload, /setLayout: \(layout\) => ipcRenderer\.invoke\(CH\.SET_LAYOUT, String\(layout\)\)/);
    assert.ok(preload.includes("SET_LAYOUT: 'prefs:set-layout'"));
  });

  test('the contract names the two layouts, in contract.ts', () => {
    const contract = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'contract.ts'), 'utf8');
    assert.match(contract, /export type Layout = 'sade' \| 'halka';/);
  });
});

test.describe('the renderer: the value', () => {
  const loader = formatModule();
  let s = null;
  test.before(async () => {
    await loader.load();
    s = await loader.sanitize();
  });
  test.after(() => loader.cleanup());

  const GOOD = { theme: 'dark', language: 'en', resolvedLanguage: 'en', formatLocale: 'en-GB', autostart: true, autostartByWindows: false, setupCoachDismissed: true };

  test('sanitizePreferences: "halka" passes, an old "tiles" is "halka", anything else (or nothing) is the short list', () => {
    assert.equal(s.sanitizePreferences({ ...GOOD, layout: 'halka' }).layout, 'halka');
    assert.equal(s.sanitizePreferences({ ...GOOD, layout: 'sade' }).layout, 'sade');
    assert.equal(s.sanitizePreferences({ ...GOOD, layout: 'tiles' }).layout, 'halka', 'a main from before the two layouts');
    assert.equal(s.sanitizePreferences({ ...GOOD, layout: 'list' }).layout, 'sade');
    assert.equal(s.sanitizePreferences({ ...GOOD, layout: 'focus' }).layout, 'sade');
    assert.equal(s.sanitizePreferences(GOOD).layout, 'sade', 'a main from before the layouts');
    for (const bad of ['HALKA', 'kutucuk', 1, null, {}, true]) {
      assert.equal(s.sanitizePreferences({ ...GOOD, layout: bad }).layout, 'sade', JSON.stringify(bad));
    }
  });

  test('app.ts writes html[data-layout] in frame one, before the store or the panel exist', () => {
    const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'app.ts'), 'utf8');
    assert.match(app, /document\.documentElement\.dataset\.layout = layout;/);
    const first = app.search(/paintLayout\(initialPrefs\?\.layout \?\? 'sade'/);
    assert.notEqual(first, -1, 'the frame-one paint is missing');
    assert.ok(first < app.search(/store\.set\(\{\s+theme: theme\.choice\(\)/), 'painted before the first store write');
    assert.ok(first < app.indexOf('createPanel('), 'painted before the panel is built');
    assert.match(app, /paintLayout\(confirmedLayout\b/, 'a refusal repaints the old layout');
  });
});

test.describe('the renderer: mounted', () => {
  let mirror;
  let restoreDom;
  let appMod;
  let i18n;

  test.before(async () => {
    restoreDom = installDom();
    mirror = mirrorRenderer();
    appMod = await mirror.load('app.js');
    i18n = await mirror.load('i18n.js');
  });
  test.after(() => {
    if (restoreDom) restoreDom();
    if (mirror) mirror.cleanup();
  });

  const tick = () => new Promise((r) => setTimeout(r, 15));

  function mount(prefs = {}) {
    i18n.setLocale('tr', 'tr-TR');
    document.documentElement = new FakeElement('html');
    const replies = [];
    const base = { theme: 'dark', language: 'tr', resolvedLanguage: 'tr', formatLocale: 'tr-TR', ...prefs };
    let prefsListener = null;
    const bridge = {
      available: true,
      initialPreferences: () => ({ ...base }),
      initialSnapshot: () => null,
      onSnapshot: () => () => {},
      onAnchor: () => () => {},
      onPanelVisibility: () => () => {},
      onPreferences: (cb) => { prefsListener = cb; return () => { prefsListener = null; }; },
      panelOpened() {},
      pin() {},
      close() {},
      requestRefresh: async () => null,
      setLayout: (v) => new Promise((resolve) => replies.push({ value: v, resolve })),
    };
    const container = new FakeElement('div');
    document.body.replaceChildren(container);
    const handle = appMod.mountApp(container, bridge);
    const push = (p) => prefsListener({ ...base, ...p });
    return { handle, container, replies, push };
  }

  const html = () => document.documentElement.dataset;

  test('frame one: the layout main says, the short list when it says nothing', () => {
    let app = mount({});
    assert.equal(html().layout, 'sade');
    app.handle.destroy();
    for (const layout of ['sade', 'halka']) {
      app = mount({ layout });
      assert.equal(html().layout, layout);
      app.handle.destroy();
    }
  });

  test('a pick is optimistic; a refusal puts the old layout back and says so', async () => {
    const app = mount({ layout: 'sade' });
    try {
      await tick();
      const radio = walk(app.container).find((n) => n.tagName === 'INPUT' && n.getAttribute('value') === 'halka');
      assert.ok(radio, 'no "Halka kutuları" radio');
      radio.checked = true;
      radio.dispatch('change');
      assert.equal(html().layout, 'halka', 'not optimistic');
      assert.deepEqual(app.replies.map((r) => r.value), ['halka']);
      app.replies[0].resolve(false);
      await tick();
      assert.equal(html().layout, 'sade', 'the refused layout stayed on the document');
      assert.ok(walk(app.container).some((n) => n.textContent === i18n.t('app.layoutNotSaved')));
    } finally {
      app.handle.destroy();
    }
  });

  test('a push from main is adopted', async () => {
    const app = mount({ layout: 'halka' });
    try {
      app.push({ layout: 'sade' });
      await tick();
      assert.equal(html().layout, 'sade');
      app.push({ layout: 'halka' });
      await tick();
      assert.equal(html().layout, 'halka');
    } finally {
      app.handle.destroy();
    }
  });
});
