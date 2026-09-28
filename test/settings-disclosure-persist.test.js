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

/** The chart's columns, oldest first, as the eye reads them. */
function columns(handle) {
  return walk(handle.el).filter((n) => hasClass(n, 'usage__col'));
}

/** The period on screen, by its disclosure's key. */
function shown(handle) {
  const t = toggles(handle);
  assert.equal(t.length, 1, 'exactly one period is on screen');
  return t[0].getAttribute('data-open-key').split('|')[1];
}

function step(handle, which) {
  return walk(handle.el).find((n) => hasClass(n, `usage__step--${which}`));
}

// ---- one period at a time (owner, 2026-09-28: the list grew by a screen a month)

test('only the newest period is shown, under a chart of all of them, oldest first', () => {
  const { handle, push } = mount();
  push([W39, W38, W37]);
  assert.equal(shown(handle), '2026-W39');
  const cols = columns(handle);
  assert.equal(cols.length, 3);
  assert.deepEqual(cols.map((c) => c.getAttribute('aria-pressed')), ['false', 'false', 'true'], 'the newest, on the right, is chosen');
  assert.deepEqual(cols.map((c) => c.getAttribute('tabindex')), ['-1', '-1', '0'], 'one tab stop for the whole chart');
  assert.match(cols[0].getAttribute('aria-label'), /\$3,50/, 'each column names its period and amount');
});

test('a column, the arrows and the keys choose a period', () => {
  const { handle, push } = mount();
  push([W39, W38, W37]);
  columns(handle)[0].click();
  assert.equal(shown(handle), '2026-W37');
  assert.equal(step(handle, 'prev').getAttribute('disabled'), '', 'nothing older than the oldest');
  step(handle, 'next').click();
  assert.equal(shown(handle), '2026-W38');
  step(handle, 'prev').click();
  assert.equal(shown(handle), '2026-W37');
  const chosenCol = columns(handle).find((c) => c.getAttribute('aria-pressed') === 'true');
  chosenCol.dispatch('keydown', { key: 'End' });
  assert.equal(shown(handle), '2026-W39');
  assert.equal(step(handle, 'next').getAttribute('disabled'), '', 'nothing newer than the newest');
  columns(handle)[2].dispatch('keydown', { key: 'ArrowLeft' });
  assert.equal(shown(handle), '2026-W38');
});

test('a chosen period survives the pushes that rebuild the section', () => {
  const { handle, push } = mount();
  push([W39, W38, W37]);
  columns(handle)[1].click();
  push([W39, W38, W37]);
  assert.equal(shown(handle), '2026-W38');
});

test('a new week sliding in keeps the period the user chose, and follows it otherwise', () => {
  const chosenCase = mount();
  chosenCase.push([W38, W37]);
  columns(chosenCase.handle)[0].click(); // W37
  chosenCase.push([W39, W38, W37]);
  assert.equal(shown(chosenCase.handle), '2026-W37', 'the week the user chose, not the same index');

  const followCase = mount();
  followCase.push([W38, W37]);
  followCase.push([W39, W38, W37]);
  assert.equal(shown(followCase.handle), '2026-W39', 'with no choice made, the new week is the current one');
});

test('the chosen period\'s models start open, and a close survives the push', () => {
  const { handle, push } = mount();
  push([W38, W37]);
  assert.equal(isOpen(handle, '2026-W38'), true, 'starts open: it is the only period on screen');
  toggleFor(handle, '2026-W38').click();
  assert.equal(isOpen(handle, '2026-W38'), false);
  push([W38, W37]);
  assert.equal(isOpen(handle, '2026-W38'), false, 'a snapshot push must not reopen what the user closed');
  push([W38, W37]);
  assert.equal(isOpen(handle, '2026-W38'), false, 'nor the one after it');
  toggleFor(handle, '2026-W38').click();
  push([W38, W37]);
  assert.equal(isOpen(handle, '2026-W38'), true, 'and reopened stays open');
});

test('keyboard focus on a toggle, a column or an arrow survives the rebuild', () => {
  const { handle, push } = mount();
  push([W39, W38, W37]);
  const before = toggleFor(handle, '2026-W39');
  before.focus();
  push([W39, W38, W37]);
  const after = toggleFor(handle, '2026-W39');
  assert.notEqual(after, before, 'the node really was replaced, or this test proves nothing');
  assert.equal(globalThis.document.activeElement, after, 'focus moved to the replacement, not lost');

  const col = columns(handle)[2];
  col.focus();
  push([W39, W38, W37]);
  assert.equal(globalThis.document.activeElement, columns(handle)[2], 'the chosen column keeps focus');

  columns(handle)[1].click();
  step(handle, 'prev').focus();
  push([W39, W38, W37]);
  assert.equal(globalThis.document.activeElement, step(handle, 'prev'));

  // Clicking a column moves focus with the choice.
  columns(handle)[0].click();
  assert.equal(globalThis.document.activeElement, columns(handle)[0]);
});
