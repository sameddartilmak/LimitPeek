'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { FakeElement, installDom, mirrorRenderer, walk } = require('./helpers/fake-dom');

/**
 * The header in the glass trial (design report 2026-10-21), driven through the
 * REAL `mountApp` on test/helpers/fake-dom.js:
 *
 *   1. While Settings is open the view has ONE top row: its back button and
 *      "Ayarlar" take the brand's place in the header, the settings button
 *      that opened the view is hidden, and the keyboard meets back, pin,
 *      close, then the tabs. Closing the view puts the brand and the button
 *      back, and focus on the button.
 *   2. "Saydamlığı azalt" is optimistic like the gauge: the document flips on
 *      the gesture, a refusal puts the old value back and says so, and
 *      Windows' own request (systemReducedTransparency) keeps the glass off
 *      whatever the switch says.
 */

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

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function mount(prefs = {}) {
  i18n.setLocale('tr', 'tr-TR');
  document.documentElement = new FakeElement('html');
  const glassReplies = [];
  let prefsListener = null;
  const base = { theme: 'dark', language: 'tr', resolvedLanguage: 'tr', formatLocale: 'tr-TR', ...prefs };
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
    setReduceTransparency: (v) => { const d = deferred(); glassReplies.push({ value: v, ...d }); return d.promise; },
  };
  const container = new FakeElement('div');
  document.body.replaceChildren(container);
  const handle = appMod.mountApp(container, bridge);
  const header = walk(container).find((n) => n.tagName === 'HEADER');
  const find = (pred) => walk(container).find(pred) || null;
  const settingsButton = find((n) => cls(n).includes('iconbtn--settings'));
  const push = (p) => prefsListener({ ...base, ...p });
  return { handle, container, header, find, settingsButton, glassReplies, push };
}

const visible = (node) => {
  for (let n = node; n; n = n.parentNode) if (n.hidden) return false;
  return true;
};

test.describe('Settings has one top row', () => {
  test('back and "Ayarlar" replace the brand in the header; the settings button is hidden', async () => {
    const app = mount();
    try {
      const brand = app.find((n) => cls(n).includes('hdr__title'));
      const back = app.find((n) => n.tagName === 'BUTTON' && n.getAttribute('aria-label') === i18n.t('settings.back'));
      const title = app.find((n) => n.tagName === 'H2' && cls(n).includes('settings__title'));
      assert.ok(back && title, 'no back button or view title');
      // Mounted in the header, not in the settings view.
      assert.ok(app.header.contains(back) && app.header.contains(title));
      const view = app.find((n) => n.getAttribute('id') === 'settings-view');
      assert.equal(view.contains(back), false);
      assert.equal(view.getAttribute('aria-labelledby'), title.getAttribute('id'));

      assert.equal(visible(brand), true);
      assert.equal(visible(back), false);
      assert.equal(visible(app.settingsButton), true);

      // Past the open's own focus move onto the panel root.
      await tick();
      app.settingsButton.click();
      await tick();
      assert.equal(visible(brand), false, 'the brand still shows beside "Ayarlar"');
      assert.equal(visible(back), true);
      assert.equal(visible(title), true);
      assert.equal(visible(app.settingsButton), false, 'a second way out still shows');
      assert.equal(document.activeElement, back, 'focus did not land on the way out');

      // Keyboard order inside the header: back, then the pin and the close.
      const order = walk(app.header).filter((n) => n.tagName === 'BUTTON' && visible(n));
      assert.deepEqual(order.map((n) => n === back ? 'back' : cls(n).includes('iconbtn--pin') ? 'pin' : 'other'), ['back', 'pin', 'other']);
      // ...and the tabs come after the header.
      const tab = app.find((n) => n.getAttribute('role') === 'tab');
      const all = walk(app.container);
      assert.ok(all.indexOf(order[order.length - 1]) < all.indexOf(tab));

      back.click();
      await tick();
      assert.equal(visible(brand), true);
      assert.equal(visible(back), false);
      assert.equal(visible(app.settingsButton), true);
      assert.equal(document.activeElement, app.settingsButton, 'focus did not come back to the button');
    } finally {
      app.handle.destroy();
    }
  });
});

test.describe('"Saydamlığı azalt" on the document', () => {
  const html = () => document.documentElement.dataset.reduceTransparency;
  const switchOf = (app) => app.find((n) => n.getAttribute('role') === 'switch' && n.getAttribute('aria-labelledby') === 'settings-glass-name');

  test('painted in frame one from either half', () => {
    let app = mount({ reduceTransparency: true });
    assert.equal(html(), 'true');
    app.handle.destroy();
    app = mount({ systemReducedTransparency: true });
    assert.equal(html(), 'true');
    app.handle.destroy();
    app = mount({});
    assert.equal(html(), undefined);
    app.handle.destroy();
  });

  test('a flip is optimistic; a refusal puts the glass back and says so', async () => {
    const app = mount();
    try {
      app.settingsButton.click();
      await tick();
      const control = switchOf(app);
      assert.ok(control, 'no switch');
      control.click();
      assert.equal(html(), 'true', 'not optimistic');
      assert.deepEqual(app.glassReplies.map((r) => r.value), [true]);
      app.glassReplies[0].resolve(false);
      await tick();
      assert.equal(html(), undefined, 'the refused value stayed on the document');
      assert.equal(control.getAttribute('aria-checked'), 'false');
      assert.ok(walk(app.container).some((n) => n.textContent === i18n.t('app.reduceTransparencyNotSaved')));
    } finally {
      app.handle.destroy();
    }
  });

  test('Windows asking keeps the glass off with the switch off, and a push that drops it brings the glass back', async () => {
    const app = mount();
    try {
      app.push({ systemReducedTransparency: true });
      await tick();
      assert.equal(html(), 'true');
      app.push({ systemReducedTransparency: false });
      await tick();
      assert.equal(html(), undefined);
    } finally {
      app.handle.destroy();
    }
  });
});
