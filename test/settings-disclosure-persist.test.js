'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { installDom, mirrorRenderer, walk } = require('./helpers/fake-dom');

/**
 * A per-period disclosure in Toplam Kullanım stays the way the USER left it.
 *
 * The owner reported it (2026-09-23): "genişletme okuna tıkladığımda bazen kendi
 * kendine o genişletme kapanıyor". The cause: the period list is rebuilt from
 * scratch on every snapshot — every 15 s while the panel is open — and each
 * rebuilt disclosure started closed, so an open one snapped shut on the next
 * push. "Bazen" was whenever a push landed.
 *
 * Mounted on the shared DOM shim like the other settings tests. Each test
 * re-renders with a FRESH snapshot object, which is what a real push does.
 */

const NOW = Date.parse('2026-09-23T12:00:00.000Z');

let mirror;
let restoreDom;
let settingsMod;
let storeMod;
let i18n;

test.before(async () => {
  restoreDom = installDom();
  mirror = mirrorRenderer();
  settingsMod = await mirror.load('components', 'settings.js');
  storeMod = await mirror.load('store.js');
  i18n = await mirror.load('i18n.js');
  i18n.setLocale('tr', 'tr-TR');
});

test.after(() => {
  if (restoreDom) restoreDom();
  if (mirror) mirror.cleanup();
});

const tk = (billable) => ({ input: billable, output: 0, cacheWrite: 0, cacheRead: 0, billable });

function period(key, startsAt, endsAt) {
  return {
    key, startsAt, endsAt,
    costUsd: 3.5,
    byClass: { input: 1, output: 1, cacheWrite5m: 1, cacheWrite1h: 0, cacheRead: 0.5 },
    tokensByProvider: { claude: tk(1_200_000) },
    tokenFloorCausesByProvider: {},
    byModel: [{ provider: 'claude', model: 'claude-opus-5', costUsd: 3.5, isFloor: false, tokens: tk(1_200_000) }],
    isFloor: false, unpricedModels: [], hasUsage: true,
  };
}

const W38 = period('2026-W38', '2026-09-14T00:00:00.000Z', '2026-09-21T00:00:00.000Z');
const W37 = period('2026-W37', '2026-09-07T00:00:00.000Z', '2026-09-14T00:00:00.000Z');
const W39 = period('2026-W39', '2026-09-21T00:00:00.000Z', '2026-09-28T00:00:00.000Z');

// The same periods under both grains, so the test does not depend on which
// grain the component opens with.
const history = (periods) => ({
  weeks: periods, months: periods,
  usageProviders: ['claude'], incompleteProviders: [],
  floorCausesByProvider: {}, pricesAsOfByProvider: { claude: '2026-06-24' },
});

const prov = {
  id: 'claude', displayName: 'Claude Code', accent: '#888', experimental: false,
  keyCapable: false, keyState: 'none', keyStoredAt: null, creditUsage: null,
  enabled: true, connected: true, status: 'ok', planLabel: null,
  fiveHour: null, sevenDay: null, tokens: null,
  weeklyTokens: null, weeklyTokensWindowAnchored: null, weeklyTokenFloorCauses: [],
  burnRatePerHour: null, byModel: [], weeklyCost: null, setupAction: null, lastGoodAt: null,
};

function mount() {
  const handle = settingsMod.createSettings({
    onToggle() {}, onTheme() {}, onBack() {}, onLanguage() {}, onGrain() {},
    onAddKey() {}, onOpenTokenPage() {}, onRemoveKey() {}, onPlanLabel() {},
  });
  const store = new storeMod.Store();
  const push = (periods) => {
    // A new object every time, exactly like a snapshot arriving over IPC.
    store.set({ hasData: true, snapshot: {
      generatedAt: new Date(NOW).toISOString(), providers: [prov],
      usageHistory: history(periods.map((p) => ({ ...p }))), pendingUsage: [],
    } });
    handle.render(store.get(), [prov]);
  };
  return { handle, push };
}

// Class tokens, not substrings: `usage__toggle` is a prefix of `usage__toggle-label`.
const hasClass = (n, c) => (n.getAttribute('class') || '').split(/\s+/).includes(c);

function toggles(handle) {
  return walk(handle.el).filter((n) => hasClass(n, 'usage__toggle'));
}

function toggleFor(handle, key) {
  return toggles(handle).find((n) => (n.getAttribute('data-open-key') || '').includes(`|${key}|`));
}

function isOpen(handle, key) {
  const t = toggleFor(handle, key);
  assert.ok(t, `no toggle for ${key}`);
  const region = walk(handle.el).find((n) => n.getAttribute('id') === t.getAttribute('aria-controls'));
  assert.ok(region, `no region for ${key}`);
  const expanded = t.getAttribute('aria-expanded') === 'true';
  // The attribute and the region must agree, or a screen reader and the eye disagree.
  assert.equal(expanded, !region.hidden, `aria-expanded and the region disagree for ${key}`);
  return expanded;
}

test('an opened period stays open when the next snapshot rebuilds the list', () => {
  const { handle, push } = mount();
  push([W38, W37]);
  assert.equal(isOpen(handle, '2026-W38'), false, 'starts closed');

  toggleFor(handle, '2026-W38').click();
  assert.equal(isOpen(handle, '2026-W38'), true);

  push([W38, W37]);
  assert.equal(isOpen(handle, '2026-W38'), true, 'a snapshot push must not close what the user opened');
  push([W38, W37]);
  assert.equal(isOpen(handle, '2026-W38'), true, 'nor the one after it');
  assert.equal(isOpen(handle, '2026-W37'), false, 'and it opens nothing the user did not');
});

test('a period the user closed again stays closed across a push', () => {
  const { handle, push } = mount();
  push([W38, W37]);
  toggleFor(handle, '2026-W38').click();
  toggleFor(handle, '2026-W38').click();
  push([W38, W37]);
  assert.equal(isOpen(handle, '2026-W38'), false);
});

test('a new week sliding in at the top keeps the SAME period open, not the same row index', () => {
  const { handle, push } = mount();
  push([W38, W37]);
  toggleFor(handle, '2026-W38').click();

  // Monday: W39 appears at the top, so W38 moves from index 0 to index 1.
  push([W39, W38, W37]);
  assert.equal(isOpen(handle, '2026-W38'), true, 'the week the user opened is still open');
  assert.equal(isOpen(handle, '2026-W39'), false, 'the new week is not opened just because it took index 0');
});

test('keyboard focus on a toggle survives the rebuild', () => {
  const { handle, push } = mount();
  push([W38, W37]);
  const before = toggleFor(handle, '2026-W37');
  before.focus();
  assert.equal(globalThis.document.activeElement, before);

  push([W38, W37]);
  const after = toggleFor(handle, '2026-W37');
  assert.notEqual(after, before, 'the node really was replaced, or this test proves nothing');
  assert.equal(globalThis.document.activeElement, after, 'focus moved to the replacement, not lost');
});
