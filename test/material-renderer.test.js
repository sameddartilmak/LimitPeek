'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { FakeElement, installDom, mirrorRenderer, walk } = require('./helpers/fake-dom');

/**
 * The renderer's half of the window material (concept "A · Gerçek Windows
 * camı"), driven through the REAL `mountApp` on test/helpers/fake-dom.js:
 *
 *   1. `html[data-material]` and `html[data-frame]` are painted in frame one
 *      from initialPreferences(), like the layout, and follow every push —
 *      main states what the window IS, so a push is adopted at once.
 *   2. A fitted window is the panel: the panel sits at the window's edge
 *      nearest the taskbar, and its height goes to main (setPanelHeight). A
 *      canvas window is never told a height.
 */

const ROOT = path.join(__dirname, '..');
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
const cls = (n) => (n.getAttribute('class') || '').split(/\s+/);

const ANCHOR = {
  tray: { x: 1800, y: 1040, width: 24, height: 40 },
  anchorSource: 'tray',
  display: { id: 1, scaleFactor: 1.25, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1032 } },
  window: { x: 1508, y: 600, width: 400, height: 420 },
  maxHeight: 680,
  edge: 'bottom',
  mode: 'hover',
};

function mount(prefs = {}) {
  i18n.setLocale('tr', 'tr-TR');
  document.documentElement = new FakeElement('html');
  const heights = [];
  let prefsListener = null;
  let anchorListener = null;
  const base = { theme: 'dark', language: 'tr', resolvedLanguage: 'tr', formatLocale: 'tr-TR', ...prefs };
  const bridge = {
    available: true,
    initialPreferences: () => ({ ...base }),
    initialSnapshot: () => null,
    onSnapshot: () => () => {},
    onAnchor: (cb) => { anchorListener = cb; return () => {}; },
    onPanelVisibility: () => () => {},
    onPreferences: (cb) => { prefsListener = cb; return () => { prefsListener = null; }; },
    panelOpened() {},
    pin() {},
    close() {},
    requestRefresh: async () => null,
    setPointerOverPanel() {},
    setPanelHeight: (h) => heights.push(h),
  };
  const container = new FakeElement('div');
  document.body.replaceChildren(container);
  const handle = appMod.mountApp(container, bridge);
  const find = (pred) => walk(container).find(pred) || null;
  const push = (p) => prefsListener({ ...base, ...p });
  const anchor = (a) => anchorListener({ ...ANCHOR, ...a });
  return { handle, container, find, heights, push, anchor };
}

const html = () => document.documentElement.dataset;

test.describe('the material on the document', () => {
  test('frame one: what main said, and the opaque canvas when it said nothing', () => {
    let app = mount({ material: 'acrylic', frame: 'fitted' });
    try {
      assert.equal(html().material, 'acrylic');
      assert.equal(html().frame, 'fitted');
    } finally {
      app.handle.destroy();
    }
    app = mount({});
    try {
      assert.equal(html().material, 'none', 'a main from before the material');
      assert.equal(html().frame, 'canvas');
    } finally {
      app.handle.destroy();
    }
  });

  test('a push switches the material live, e.g. "Saydamlık" at 0 or Windows turning transparency off', async () => {
    const app = mount({ material: 'acrylic', frame: 'fitted' });
    try {
      app.push({ material: 'none', frame: 'fitted', systemReducedTransparency: true });
      await tick();
      assert.equal(html().material, 'none');
      app.push({ material: 'acrylic', frame: 'fitted' });
      await tick();
      assert.equal(html().material, 'acrylic');
    } finally {
      app.handle.destroy();
    }
  });

  test('app.ts paints it before the store or the panel exist', () => {
    const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'app.ts'), 'utf8');
    const first = app.indexOf("paintMaterial(initialPrefs?.material ?? 'none', initialPrefs?.frame ?? 'canvas');");
    assert.notEqual(first, -1, 'the frame-one paint is missing');
    assert.ok(first < app.search(/store\.set\(\{\s+theme: theme\.choice\(\)/), 'painted before the first store write');
    assert.ok(first < app.indexOf('createPanel('), 'painted before the panel is built');
  });
});

test.describe('the stylesheets: acrylic tokens over an opaque fallback', () => {
  const css = (f) => fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles', f), 'utf8');
  const block = (text, selector) => {
    const start = text.indexOf(selector);
    assert.notEqual(start, -1, `missing ${selector}`);
    return text.slice(start, text.indexOf('\n}', start));
  };

  test('the transparent sheet and translucent cards exist only over live glass, and step aside at 0', () => {
    const tokens = css('tokens.css');
    const dark = block(tokens, ':root[data-material="acrylic"]:not([data-reduce-transparency]) {');
    // The tint is the window's GradientColor now (panel-material.js): the page adds none.
    assert.match(dark, /--panel-base: transparent;/);
    assert.match(dark, /--ink-800: rgba\(255, 255, 255, \.\d+\)/);
    assert.match(dark, /--glass-filter: none;/, 'no in-app blur over the real acrylic');
    assert.equal(block(tokens, ':root[data-material="acrylic"][data-theme="light"]:not([data-reduce-transparency]) {').includes('--panel-base'), false, 'light inherits the transparent sheet');
    // The opaque palette stays the fallback.
    assert.match(block(tokens, ':root {'), /--ink-800: #2C2C2E;/);
    assert.match(block(tokens, ':root {'), /--panel-base: var\(--ink-900\);/);
    assert.match(css('panel.css'), /\.panel \{[\s\S]*?background: var\(--panel-base\);/);
  });

  test('a fitted window draws no corner, edge, shadow or tail of its own', () => {
    const panel = css('panel.css');
    const sheet = block(panel, 'html[data-frame="fitted"] .panel {');
    assert.match(sheet, /border: 0;/);
    assert.match(sheet, /border-radius: 0;/);
    assert.match(sheet, /box-shadow: none;/);
    assert.match(panel, /html\[data-frame="fitted"\] \.panel__tail \{ display: none; \}/);
  });

  test('the figures are 650 in the state colour, and the refresh is a header icon that turns while it works', () => {
    const pct = block(css('row.css'), '.win__pct {');
    assert.match(pct, /font-weight: 650;/);
    assert.match(pct, /color: var\(--state, var\(--ink-100\)\);/);
    // The footer's filled "Yenile" capsule went with the footer (2026-10-22).
    const panel = css('panel.css');
    assert.doesNotMatch(panel, /\.foot__refresh/);
    assert.match(panel, /\.iconbtn\[data-busy="true"\] \.iconbtn__spin \{ animation: spin 900ms linear infinite; \}/);
  });
});

test.describe('a fitted window is the panel', () => {
  const anchorEl = (app) => app.find((n) => cls(n).includes('anchor'));

  test('the panel sits on the window edge nearest the taskbar, with no offsets to aim a tail', async () => {
    const app = mount({ material: 'acrylic', frame: 'fitted' });
    try {
      app.anchor({ edge: 'bottom' });
      await tick();
      const el = anchorEl(app);
      assert.equal(el.style.left, '0px');
      assert.equal(el.style.bottom, '0px');
      assert.equal(el.style.top, '');
      assert.equal(el.getAttribute('data-tail'), 'bottom', 'the entrance slides from the taskbar');
      app.anchor({ edge: 'top' });
      await tick();
      assert.equal(el.style.top, '0px');
      assert.equal(el.style.bottom, '');
      app.anchor({ edge: 'left' });
      await tick();
      assert.equal(el.style.top, '0px');
      assert.equal(el.getAttribute('data-axis'), 'horizontal');
    } finally {
      app.handle.destroy();
    }
  });

  test('its height goes to main, once per change', async () => {
    const app = mount({ material: 'acrylic', frame: 'fitted' });
    try {
      await tick();
      assert.ok(app.heights.length >= 1, 'never reported');
      assert.equal(app.heights[0], 40, "the fake DOM's offsetHeight");
      const n = app.heights.length;
      app.anchor({});
      await tick();
      assert.equal(app.heights.length, n, 'the same height is not sent twice');
    } finally {
      app.handle.destroy();
    }
  });

  test('the list budget is maxHeight edge to edge, not the canvas minus its margins', async () => {
    const fittedApp = mount({ material: 'acrylic', frame: 'fitted' });
    let fittedMax;
    try {
      fittedApp.anchor({ maxHeight: 600 });
      await tick();
      fittedMax = fittedApp.find((n) => cls(n).includes('panel__band--list')).style.getPropertyValue('--list-max');
    } finally {
      fittedApp.handle.destroy();
    }
    const canvasApp = mount({});
    try {
      canvasApp.anchor({ maxHeight: 600, window: { ...ANCHOR.window, height: 600 } });
      await tick();
      const canvasMax = canvasApp.find((n) => cls(n).includes('panel__band--list')).style.getPropertyValue('--list-max');
      assert.equal(parseInt(fittedMax, 10) - parseInt(canvasMax, 10), 2 * 12 + 8 + 2);
    } finally {
      canvasApp.handle.destroy();
    }
  });

  test('a canvas window is never told a height', async () => {
    const app = mount({});
    try {
      app.anchor({});
      await tick();
      assert.deepEqual(app.heights, []);
    } finally {
      app.handle.destroy();
    }
  });
});
