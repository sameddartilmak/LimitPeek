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
 *      that opened the view is hidden, and the keyboard meets back, refresh,
 *      pin, then the tabs (the header has no close since the minimal redesign). Closing the view puts the brand and the button
 *      back, and focus on the button.
 *   2. The "Saydamlık" switch is optimistic: the store and the document
 *      follow the press, main is asked afterwards, a refusal puts main's
 *      value back and says so, and Windows' own request
 *      (systemReducedTransparency) keeps the panel opaque and the switch
 *      disabled whatever it says.
 *   3. Two small accessibility details from the report: the refresh names what
 *      it is doing while it does it, and the list keeps the meters' values.
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

function mount(prefs = {}, { snapshot = null, requestRefresh = async () => null } = {}) {
  i18n.setLocale('tr', 'tr-TR');
  document.documentElement = new FakeElement('html');
  const glassReplies = [];
  let prefsListener = null;
  const base = { theme: 'dark', language: 'tr', resolvedLanguage: 'tr', formatLocale: 'tr-TR', ...prefs };
  const bridge = {
    available: true,
    initialPreferences: () => ({ ...base }),
    initialSnapshot: () => snapshot,
    onSnapshot: () => () => {},
    onAnchor: () => () => {},
    onPanelVisibility: () => () => {},
    onPreferences: (cb) => { prefsListener = cb; return () => { prefsListener = null; }; },
    panelOpened() {},
    pin() {},
    close() {},
    requestRefresh,
    setTransparency: (v) => { const d = deferred(); glassReplies.push({ value: v, ...d }); return d.promise; },
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

      // Keyboard order inside the header: back, then the refresh and the pin.
      const order = walk(app.header).filter((n) => n.tagName === 'BUTTON' && visible(n));
      assert.deepEqual(order.map((n) => n === back ? 'back' : cls(n).includes('iconbtn--pin') ? 'pin' : cls(n).includes('iconbtn--refresh') ? 'refresh' : 'other'), ['back', 'refresh', 'pin']);
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

test.describe('"Saydamlık": the slider on the document', () => {
  const html = () => document.documentElement.dataset.reduceTransparency;
  const sliderOf = (app) => app.find((n) => n.tagName === 'INPUT' && n.getAttribute('aria-labelledby') === 'settings-glass-name');
  const figureOf = (app) => app.find((n) => cls(n).includes('glass-slider__value'));
  const step = (input, value, type = 'input') => { input.value = String(value); input.dispatch(type); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function openGeneral(app) {
    app.settingsButton.click();
    await tick();
    const input = sliderOf(app);
    assert.ok(input, 'no slider');
    return input;
  }

  test('painted in frame one: opaque at 0 or when Windows asks, glass otherwise', () => {
    let app = mount({ transparency: 0 });
    assert.equal(html(), 'true');
    app.handle.destroy();
    app = mount({ systemReducedTransparency: true });
    assert.equal(html(), 'true');
    app.handle.destroy();
    app = mount({ transparency: 100 });
    assert.equal(html(), undefined);
    app.handle.destroy();
    app = mount({});
    assert.equal(html(), undefined, 'the default is glass');
    app.handle.destroy();
  });

  test('the slider starts at main\'s level and every step moves the figure at once', async () => {
    const app = mount({ transparency: 70 });
    try {
      const input = await openGeneral(app);
      assert.equal(input.value, '70');
      assert.equal(figureOf(app).textContent, '%70');
      assert.equal(input.getAttribute('aria-valuetext'), '%70');
      step(input, 35);
      await tick();
      assert.equal(figureOf(app).textContent, '%35');
      assert.equal(input.style.getPropertyValue('--fill'), '35%');
    } finally {
      app.handle.destroy();
    }
  });

  test('a drag is throttled: the first step at once, the rest held back, the newest sent last', async () => {
    const app = mount({ transparency: 45 });
    try {
      const input = await openGeneral(app);
      step(input, 50);
      step(input, 55);
      step(input, 60);
      assert.deepEqual(app.glassReplies.map((r) => r.value), [50], 'only the first step went straight out');
      await wait(120);
      assert.deepEqual(app.glassReplies.map((r) => r.value), [50, 60], 'the held step goes out when the throttle runs out');
      // Letting go on the value already sent asks nothing more.
      step(input, 60, 'change');
      assert.deepEqual(app.glassReplies.map((r) => r.value), [50, 60]);
      for (const r of app.glassReplies) r.resolve(true);
      await tick();
    } finally {
      app.handle.destroy();
    }
  });

  test('\'change\' (let go, or a key) is sent at once, without waiting for the throttle', async () => {
    const app = mount({ transparency: 45 });
    try {
      const input = await openGeneral(app);
      step(input, 50);
      step(input, 40);
      step(input, 0, 'change');
      assert.deepEqual(app.glassReplies.map((r) => r.value), [50, 0]);
      assert.equal(html(), 'true', '0 is opaque on the gesture');
      await wait(120);
      assert.deepEqual(app.glassReplies.map((r) => r.value), [50, 0], 'nothing held back after the final value');
      for (const r of app.glassReplies) r.resolve(true);
      await tick();
    } finally {
      app.handle.destroy();
    }
  });

  test('a refusal puts main\'s value back on the slider and the document, and says so', async () => {
    const app = mount({ transparency: 45 });
    try {
      const input = await openGeneral(app);
      step(input, 30, 'change');
      app.glassReplies[0].resolve(true);
      await tick();
      step(input, 0, 'change');
      assert.equal(html(), 'true', 'not optimistic');
      app.glassReplies[1].resolve(false);
      await tick();
      assert.equal(html(), undefined, 'the refused value stayed on the document');
      assert.equal(input.value, '30', 'the slider is back on the last level main kept');
      assert.equal(figureOf(app).textContent, '%30');
      assert.ok(walk(app.container).some((n) => n.textContent === i18n.t('app.transparencyNotSaved')));
    } finally {
      app.handle.destroy();
    }
  });

  test('a push that crosses a drag does not pull the slider back under the hand', async () => {
    const app = mount({ transparency: 45 });
    try {
      const input = await openGeneral(app);
      step(input, 50);
      app.glassReplies[0].resolve(true);
      await tick();
      step(input, 65);
      // Main's echo of the 50 arrives while the 65 is still held back.
      app.push({ transparency: 50 });
      await tick();
      assert.equal(input.value, '65');
      await wait(120);
      assert.deepEqual(app.glassReplies.map((r) => r.value), [50, 65]);
      app.glassReplies[1].resolve(true);
      await tick();
      // Nothing in flight any more: main's word is adopted again.
      app.push({ transparency: 80 });
      await tick();
      assert.equal(input.value, '80');
    } finally {
      app.handle.destroy();
    }
  });

  test('Windows asking keeps the panel opaque and the slider disabled; a push that drops it brings both back', async () => {
    const app = mount({ transparency: 70 });
    try {
      const input = await openGeneral(app);
      app.push({ transparency: 70, systemReducedTransparency: true });
      await tick();
      assert.equal(html(), 'true');
      assert.equal(input.getAttribute('disabled'), '');
      // A step that still arrives changes nothing and asks nothing.
      step(input, 20, 'change');
      assert.deepEqual(app.glassReplies, []);
      app.push({ transparency: 70, systemReducedTransparency: false });
      await tick();
      assert.equal(html(), undefined);
      assert.equal(input.getAttribute('disabled'), null);
      assert.equal(input.value, '70');
    } finally {
      app.handle.destroy();
    }
  });
  test('the level is the glass\'s two dials on <html>: frost towards "Düz", a thinner tint towards "Saydam"', async () => {
    const dial = (name) => document.documentElement.style.getPropertyValue(name);
    const app = mount({ transparency: 80 });
    try {
      assert.equal(dial('--glass-frost'), '0.000', 'the approved glass: no frost');
      assert.equal(dial('--glass-tint-amount'), '1.000', 'and the whole tint');
      const input = await openGeneral(app);
      step(input, 100);
      assert.equal(dial('--glass-frost'), '0.000');
      assert.equal(dial('--glass-tint-amount'), '0.400', 'the clearest glass keeps a little tint');
      step(input, 40);
      assert.equal(dial('--glass-frost'), '0.500');
      assert.equal(dial('--glass-tint-amount'), '1.000');
      step(input, 5);
      assert.equal(dial('--glass-frost'), '0.938', 'almost solid at the first step');
      for (const r of app.glassReplies) r.resolve(true);
      await tick();
    } finally {
      app.handle.destroy();
    }
  });
});

test.describe('small details', () => {
  const later = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  const SNAP = {
    generatedAt: new Date().toISOString(),
    providers: [{
      id: 'claude', displayName: 'Claude Code', accent: '#D97757', enabled: true, connected: true,
      status: 'ok', planLabel: null,
      fiveHour: { usedPercentage: 62, certainty: 'known', resetsAt: later(2) },
      sevenDay: { usedPercentage: 41, certainty: 'known', resetsAt: later(50) },
      tokens: null, weeklyTokens: null, burnRatePerHour: null, weeklyCost: null, setupAction: null,
    }],
  };

  test('"Yenile" says "Taranıyor" / "Yenileniyor" to a screen reader too, and is busy while it is', async () => {
    let finish = null;
    const app = mount({}, { requestRefresh: () => new Promise((r) => { finish = r; }) });
    try {
      const button = app.find((n) => cls(n).includes('iconbtn--refresh'));
      await tick();
      assert.equal(button.getAttribute('aria-label'), i18n.t('panel.scanning'), 'the first scan');
      assert.equal(button.getAttribute('aria-busy'), 'true');
      app.handle.applySnapshot(SNAP);
      await tick();
      // At rest it says what it does and when the last scan landed.
      assert.match(button.getAttribute('aria-label'), /^Şimdi yenile, son tarama \d{2}[:.]\d{2}$/);
      assert.equal(button.getAttribute('aria-busy'), null);
      button.click();
      await tick();
      assert.equal(button.getAttribute('aria-label'), i18n.t('panel.refreshing'));
      assert.equal(button.getAttribute('aria-busy'), 'true');
      finish(SNAP);
      await tick();
      assert.match(button.getAttribute('aria-label'), /^Şimdi yenile, son tarama /);
      assert.equal(button.getAttribute('aria-busy'), null);
    } finally {
      app.handle.destroy();
    }
  });

  test('every window is still a meter with its value and its sentence', async () => {
    const app = mount({}, { snapshot: SNAP });
    try {
      app.handle.applySnapshot(SNAP);
      await tick();
      assert.equal(document.documentElement.dataset.layout, undefined, 'no layout on the document any more');
      assert.equal(document.documentElement.dataset.gauge, undefined, 'no gauge on the document any more');
      const meters = walk(app.container).filter((n) => n.getAttribute('role') === 'meter');
      assert.deepEqual(meters.map((m) => m.getAttribute('aria-valuenow')), ['62', '41']);
      for (const m of meters) {
        assert.equal(m.getAttribute('aria-valuemin'), '0');
        assert.equal(m.getAttribute('aria-valuemax'), '100');
        // The spoken sentence names the window and carries the same figure.
        assert.ok(m.getAttribute('aria-valuetext').includes(m.getAttribute('aria-valuenow')), m.getAttribute('aria-valuetext'));
        assert.match(m.getAttribute('aria-valuetext'), /pencere/);
      }
    } finally {
      app.handle.destroy();
    }
  });
});
