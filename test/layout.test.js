'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { LAYOUTS, DEFAULT_LAYOUT, isLayout, sanitizeLayout } = require('../src/core/layout');
const { createSetLayoutHandler } = require('../src/main/layout-ipc');
const { createPreferences } = require('../src/main/language-ipc');
const settingsStore = require('../src/main/settings');
const { formatModule } = require('./helpers/load-format');
const { FakeElement, installDom, mirrorRenderer, walk } = require('./helpers/fake-dom');

const ROOT = path.join(__dirname, '..');

/**
 * Settings → Genel → Görünüm → "Düzen": "Liste" (default), "Öne çıkan" or
 * "Kutucuklar". The value, its sanitising at every boundary, the handler
 * index.js registers over recorded fakes, the renderer's frame-one write of
 * `html[data-layout]` (with the user's own gauge, in every layout), and the optimistic pick
 * with its revert, driven through the real `mountApp` on the fake DOM.
 */

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-layout-'));
}

test.describe('the value', () => {
  test('three literals, the list by default', () => {
    assert.deepEqual(LAYOUTS, ['list', 'focus', 'tiles']);
    assert.equal(DEFAULT_LAYOUT, 'list');
    for (const good of LAYOUTS) assert.equal(isLayout(good), true);
    for (const bad of ['Tiles', 'grid', 'odak', '', null, undefined, 1, true, {}, ['tiles']]) {
      assert.equal(isLayout(bad), false, JSON.stringify(bad));
      assert.equal(sanitizeLayout(bad), 'list', JSON.stringify(bad));
    }
  });

  test('settings: a new file and an old file (no key) both read as the list', () => {
    assert.equal(settingsStore.DEFAULTS.layout, 'list');
    assert.equal(settingsStore.load(tmpDir()).layout, 'list');
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ autostart: false, gauge: 'ring' }));
    assert.equal(settingsStore.load(dir).layout, 'list');
  });

  test('settings: "focus" and "tiles" survive a round trip; a typo or a future value is the list', () => {
    const dir = tmpDir();
    for (const layout of ['focus', 'tiles']) {
      const s = settingsStore.load(dir);
      s.layout = layout;
      assert.equal(settingsStore.save(dir, s), true);
      assert.equal(settingsStore.load(dir).layout, layout);
    }
    for (const bad of ['TILES', 'cards', 3, null, { v: 'tiles' }]) {
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ layout: bad }));
      assert.equal(settingsStore.load(dir).layout, 'list', JSON.stringify(bad));
    }
  });

  test('preferences carry the layout re-sanitised', () => {
    const base = { currentLocale: () => ({ language: 'tr', resolvedLanguage: 'tr', formatLocale: 'tr-TR' }), readOs: () => ({}) };
    const p = (settings) => createPreferences({ ...base, getSettings: () => settings })();
    assert.equal(p({ layout: 'focus' }).layout, 'focus');
    assert.equal(p({ layout: 'tiles' }).layout, 'tiles');
    assert.equal(p({ layout: 'kutucuk' }).layout, 'list');
    assert.equal(p({}).layout, 'list');
    assert.equal(p(null).layout, 'list');
  });
});

test.describe('SET_LAYOUT', () => {
  function rig({ fromPanel = true, saves = [], stored = 'list', pushThrows = false } = {}) {
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
    assert.deepEqual(r.handler({}, 'tiles'), { ok: true });
    assert.deepEqual(r.calls, ['persist:tiles', 'push']);
    assert.equal(r.settings.layout, 'tiles');
    assert.deepEqual(r.handler({}, 'focus'), { ok: true });
    assert.equal(r.settings.layout, 'focus');
  });

  test('anything but the three literals, or a sender that is not the panel, changes nothing', () => {
    for (const bad of ['TILES', 'grid', '', null, 1, true, {}, ['tiles']]) {
      const r = rig();
      assert.deepEqual(r.handler({}, bad), { ok: false }, JSON.stringify(bad));
      assert.deepEqual(r.calls, []);
      assert.equal(r.settings.layout, 'list');
    }
    const r = rig({ fromPanel: false });
    assert.deepEqual(r.handler({}, 'tiles'), { ok: false });
    assert.deepEqual(r.calls, []);
  });

  test('a failed write puts the value back and pushes nothing', () => {
    const r = rig({ saves: [false] });
    assert.deepEqual(r.handler({}, 'focus'), { ok: false });
    assert.deepEqual(r.calls, ['persist:focus']);
    assert.equal(r.settings.layout, 'list');
    assert.ok(r.warnings.some((w) => w.includes('could not be persisted')));
  });

  test('a push that throws is logged, and the stored choice still stands', () => {
    const r = rig({ pushThrows: true });
    assert.deepEqual(r.handler({}, 'tiles'), { ok: true });
    assert.equal(r.settings.layout, 'tiles');
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

  test('sanitizePreferences: "focus" and "tiles" pass, anything else (or nothing) is the list', () => {
    assert.equal(s.sanitizePreferences({ ...GOOD, layout: 'focus' }).layout, 'focus');
    assert.equal(s.sanitizePreferences({ ...GOOD, layout: 'tiles' }).layout, 'tiles');
    assert.equal(s.sanitizePreferences(GOOD).layout, 'list', 'a main from before the layouts');
    for (const bad of ['TILES', 'kutucuk', 1, null, {}, true]) {
      assert.equal(s.sanitizePreferences({ ...GOOD, layout: bad }).layout, 'list', JSON.stringify(bad));
    }
  });

  test('app.ts writes html[data-layout] in frame one, before the store or the panel exist', () => {
    const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'app.ts'), 'utf8');
    assert.match(app, /document\.documentElement\.dataset\.layout = layout;/);
    const first = app.indexOf("paintLayout(initialPrefs?.layout ?? 'list', initialPrefs?.gauge ?? 'bar');");
    assert.notEqual(first, -1, 'the frame-one paint is missing');
    assert.ok(first < app.search(/store\.set\(\{\s+theme: theme\.choice\(\)/), 'painted before the first store write');
    assert.ok(first < app.indexOf('createPanel('), 'painted before the panel is built');
    assert.match(app, /paintLayout\(confirmedLayout, store\.get\(\)\.gauge\);/, 'a refusal repaints the old layout');
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

  test('frame one: the layout, and the user\'s own gauge in every layout', () => {
    let app = mount({});
    assert.equal(html().layout, 'list');
    assert.equal(html().gauge, 'bar');
    app.handle.destroy();
    for (const layout of ['list', 'focus', 'tiles']) {
      for (const gauge of ['bar', 'ring']) {
        app = mount({ layout, gauge });
        assert.equal(html().layout, layout);
        assert.equal(html().gauge, gauge, `${layout} draws the ${gauge} the user chose`);
        app.handle.destroy();
      }
    }
  });

  test('a pick is optimistic and keeps the gauge; a refusal puts the old layout back and says so', async () => {
    const app = mount({ layout: 'list', gauge: 'bar' });
    try {
      await tick();
      const radio = walk(app.container).find((n) => n.tagName === 'INPUT' && n.getAttribute('value') === 'tiles');
      assert.ok(radio, 'no "Kutucuklar" radio');
      radio.checked = true;
      radio.dispatch('change');
      assert.equal(html().layout, 'tiles', 'not optimistic');
      assert.equal(html().gauge, 'bar', 'the tiles in the user\'s bars');
      assert.deepEqual(app.replies.map((r) => r.value), ['tiles']);
      app.replies[0].resolve(false);
      await tick();
      assert.equal(html().layout, 'list', 'the refused layout stayed on the document');
      assert.equal(html().gauge, 'bar');
      assert.ok(walk(app.container).some((n) => n.textContent === i18n.t('app.layoutNotSaved')));
    } finally {
      app.handle.destroy();
    }
  });

  test('a push from main is adopted, the layout and the gauge each as main says', async () => {
    const app = mount({ layout: 'tiles', gauge: 'bar' });
    try {
      app.push({ layout: 'focus', gauge: 'bar' });
      await tick();
      assert.equal(html().layout, 'focus');
      assert.equal(html().gauge, 'bar');
      app.push({ layout: 'focus', gauge: 'ring' });
      await tick();
      assert.equal(html().layout, 'focus');
      assert.equal(html().gauge, 'ring');
      app.push({ layout: 'list', gauge: 'ring' });
      await tick();
      assert.equal(html().layout, 'list');
      assert.equal(html().gauge, 'ring');
    } finally {
      app.handle.destroy();
    }
  });
});
