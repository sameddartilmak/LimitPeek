'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { FakeElement, installDom, mirrorRenderer, walk } = require('./helpers/fake-dom');

/**
 * App-level preference rules in src/renderer/src/app.ts, driven through the
 * REAL `mountApp` with a fake Bridge whose replies the test resolves by hand.
 *
 *   1. Two quick picks that both FAIL revert to the last value main CONFIRMED,
 *      not to the first pick (theme and language alike).
 *   2. The language is not optimistic: an ok reply from setLanguage changes
 *      nothing on screen; main's PREFERENCES push does (ADR-004).
 *   3. An open consent prompt is cleared — not rebuilt — by a real language
 *      change, and survives a push that changes nothing.
 *
 * DOM limits are those of test/helpers/fake-dom.js: no layout, no real focus,
 * no CSS. What is asserted here is state reflected into attributes, radio
 * `checked` properties and text, which the shim models faithfully.
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

/** A reply the test settles later. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// Renders are scheduled on animation frames (setTimeout 0 in the shim).
const tick = () => new Promise((r) => setTimeout(r, 15));

const TR_PREFS = { theme: 'dark', language: 'tr', resolvedLanguage: 'tr', formatLocale: 'tr-TR' };

function snapshotWithConsentAction() {
  return {
    generatedAt: new Date().toISOString(),
    providers: [{
      id: 'claude',
      displayName: 'Claude Code',
      accent: '#d97757',
      enabled: true,
      connected: false,
      status: 'passive',
      planLabel: null,
      fiveHour: null,
      sevenDay: null,
      tokens: null,
      burnRatePerHour: null,
      weeklyCost: null,
      setupAction: { kind: 'install-bridge', label: 'Bağlan', detail: 'Köprü eklenir.' },
    }],
  };
}

function mount({ snapshot = null } = {}) {
  i18n.setLocale('tr', 'tr-TR');
  document.documentElement = new FakeElement('html');
  const replies = { theme: [], language: [] };
  let prefsListener = null;
  const bridge = {
    available: true,
    initialPreferences: () => ({ ...TR_PREFS }),
    initialSnapshot: () => snapshot,
    onSnapshot: () => () => {},
    onAnchor: () => () => {},
    onPanelVisibility: () => () => {},
    onPreferences: (cb) => { prefsListener = cb; return () => { prefsListener = null; }; },
    panelOpened() {},
    pin() {},
    close() {},
    requestRefresh: async () => null,
    runSetup: async () => ({ ok: true }),
    setOrder: async () => true,
    setEnabled: async () => true,
    setTheme: (v) => { const d = deferred(); replies.theme.push({ value: v, ...d }); return d.promise; },
    setLanguage: (v) => { const d = deferred(); replies.language.push({ value: v, ...d }); return d.promise; },
  };
  const container = new FakeElement('div');
  document.body.replaceChildren(container);
  const handle = appMod.mountApp(container, bridge);
  if (snapshot) handle.applySnapshot(snapshot);
  // The radios are painted only while the settings view is open (panel.ts
  // renders settings when state.view === 'settings'), as for a real user.
  const openSettings = () => {
    const button = walk(container).find((n) => n.tagName === 'BUTTON' && n.getAttribute('aria-label') === i18n.t('header.settings'));
    assert.ok(button, 'no settings button in the header');
    button.click();
  };
  const byId = (id) => walk(container).find((n) => n.getAttribute('id') === id) || null;
  const pick = (id) => {
    const input = byId(id);
    assert.ok(input, `no control #${id}`);
    // A radio group unchecks its siblings; the shim does not, so do it here.
    const name = input.getAttribute('name');
    for (const other of walk(container)) {
      if (other.tagName === 'INPUT' && name && other.getAttribute('name') === name) other.checked = false;
    }
    input.checked = true;
    input.dispatch('change');
  };
  const checked = (prefix) => walk(container)
    .filter((n) => n.tagName === 'INPUT' && n.id.startsWith(prefix) && n.checked)
    .map((n) => n.id);
  const push = (prefs) => { assert.ok(prefsListener, 'app did not subscribe to PREFERENCES'); prefsListener(prefs); };
  return { handle, container, replies, pick, checked, push, byId, openSettings };
}

test.describe('two quick picks that both fail revert to the last CONFIRMED value', () => {
  test('theme: dark -> light -> system, both refused, lands on dark', async () => {
    const app = mount();
    try {
      app.openSettings();
      await tick();
      app.pick('theme-light');
      app.pick('theme-system');
      assert.deepEqual(app.replies.theme.map((r) => r.value), ['light', 'system']);
      app.replies.theme[0].resolve(false);
      await tick();
      app.replies.theme[1].resolve(false);
      await tick();
      assert.deepEqual(app.checked('theme-'), ['theme-dark']);
      assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');
    } finally {
      app.handle.destroy();
    }
  });

  test('theme: the first pick confirmed, the second refused, lands on the first', async () => {
    const app = mount();
    try {
      app.openSettings();
      await tick();
      app.pick('theme-light');
      app.pick('theme-system');
      app.replies.theme[0].resolve(true);
      await tick();
      app.replies.theme[1].resolve(false);
      await tick();
      assert.deepEqual(app.checked('theme-'), ['theme-light']);
      assert.equal(document.documentElement.getAttribute('data-theme'), 'light');
    } finally {
      app.handle.destroy();
    }
  });

  test('language: tr -> en -> system, both refused, lands on tr', async () => {
    const app = mount();
    try {
      app.openSettings();
      await tick();
      app.pick('language-en');
      app.pick('language-system');
      assert.deepEqual(app.replies.language.map((r) => r.value), ['en', 'system']);
      app.replies.language[0].resolve(false);
      await tick();
      app.replies.language[1].resolve(false);
      await tick();
      assert.deepEqual(app.checked('language-'), ['language-tr']);
    } finally {
      app.handle.destroy();
    }
  });

  test('language: the first pick confirmed, the second refused, lands on the first', async () => {
    const app = mount();
    try {
      app.openSettings();
      await tick();
      app.pick('language-en');
      app.pick('language-system');
      app.replies.language[0].resolve(true);
      await tick();
      app.replies.language[1].resolve(false);
      await tick();
      assert.deepEqual(app.checked('language-'), ['language-en']);
    } finally {
      app.handle.destroy();
    }
  });
});

test.describe('the language switches on main\'s push, not on the reply', () => {
  test('an ok reply leaves the words, the locale and <html lang> alone; the push switches them', async () => {
    const app = mount();
    try {
      assert.equal(document.documentElement.getAttribute('lang'), 'tr');
      app.openSettings();
      await tick();
      app.pick('language-en');
      app.replies.language[0].resolve(true);
      await tick();
      assert.equal(i18n.language(), 'tr', 'switched on the reply, before main re-resolved');
      assert.equal(i18n.formatLocale(), 'tr-TR');
      assert.equal(document.documentElement.getAttribute('lang'), 'tr');

      app.push({ theme: 'dark', language: 'en', resolvedLanguage: 'en', formatLocale: 'en-GB' });
      await tick();
      assert.equal(i18n.language(), 'en');
      assert.equal(i18n.formatLocale(), 'en-GB');
      assert.equal(document.documentElement.getAttribute('lang'), 'en');
      assert.deepEqual(app.checked('language-'), ['language-en']);
    } finally {
      app.handle.destroy();
      i18n.setLocale('tr', 'tr-TR');
    }
  });
});

test.describe('an open consent prompt does not survive a language change', () => {
  const consentBox = (container) => walk(container).find((n) => n.classList.contains('consent')) || null;
  const openConsent = (app) => {
    const button = walk(app.container).find((n) => n.tagName === 'BUTTON' && n.getAttribute('aria-label') === 'Claude Code: Bağlan');
    assert.ok(button, 'no setup button on the Claude row');
    button.click();
    const box = consentBox(app.container);
    assert.ok(box && box.hidden === false, 'the consent prompt did not open');
  };

  test('a push that changes the resolved language clears it and says so in the new language', async () => {
    const app = mount({ snapshot: snapshotWithConsentAction() });
    try {
      openConsent(app);
      app.push({ theme: 'dark', language: 'en', resolvedLanguage: 'en', formatLocale: 'en-US' });
      await tick();
      const box = consentBox(app.container);
      assert.ok(!box || box.hidden === true, 'the consent prompt survived the language change');
      const cancelled = i18n.t('app.setupCancelled');
      assert.equal(cancelled, 'Setup cancelled. No files were changed.');
      assert.ok(app.container.textContent.includes(cancelled), 'the cancellation is not stated in the new language');
    } finally {
      app.handle.destroy();
      i18n.setLocale('tr', 'tr-TR');
    }
  });

  test('a push that changes nothing leaves the prompt open', async () => {
    const app = mount({ snapshot: snapshotWithConsentAction() });
    try {
      openConsent(app);
      app.push({ ...TR_PREFS });
      await tick();
      const box = consentBox(app.container);
      assert.ok(box && box.hidden === false, 'a no-op push closed the consent prompt');
    } finally {
      app.handle.destroy();
    }
  });
});
