'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { installDom, mirrorRenderer, walk } = require('./helpers/fake-dom');

/**
 * "TOPLAM KULLANIM" — THE PER-TOOL TOKEN SUBTOTALS
 * (src/renderer/src/components/settings.ts, `renderTokenSubtotals`).
 *
 * The owner asked for token counts in this panel. The honest shape is one
 * figure per tool and no total, and TWO rules make that true rather than just
 * intended:
 *
 *   1. Each tool's subtotal is read from `PeriodUsage.tokensByProvider`, NOT
 *      folded from the model rows above it. `byModel` is capped at 24 entries,
 *      so a sum over what is displayed silently understates a busy period —
 *      which is the whole reason main sends the map. Measured by mutation on the
 *      predecessor design: replacing the map read with a fold over `byModel`
 *      left `npm test` fully green, because no node test loaded this file.
 *   2. Nothing is ever added ACROSS tools. `test/token-merge-scan.test.js`
 *      guards the source text; this guards the rendered output — that the list
 *      holds exactly one row per tool with a count and no row that is a total.
 *
 * Mounted on the shared DOM shim (`test/helpers/fake-dom.js`) exactly as
 * `settings-accordion.test.js` mounts the same component. Geometry and clipping
 * stay with the electron render suite.
 */

const NOW = Date.parse('2026-09-14T12:00:00.000Z');

let mirror;
let restoreDom;
let settingsMod;
let storeMod;
let i18n;
let fmt;

test.before(async () => {
  restoreDom = installDom();
  mirror = mirrorRenderer();
  settingsMod = await mirror.load('components', 'settings.js');
  storeMod = await mirror.load('store.js');
  i18n = await mirror.load('i18n.js');
  fmt = await mirror.load('format.js');
  i18n.setLocale('tr', 'tr-TR');
});

test.after(() => {
  if (restoreDom) restoreDom();
  if (mirror) mirror.cleanup();
});

const tk = (billable, over = {}) => ({
  input: billable, output: 0, cacheWrite: 0, cacheRead: 1_000_000, billable, ...over,
});

const modelEntry = (provider, model, billable, over = {}) => ({
  provider, model, costUsd: 1.5, isFloor: false, tokens: tk(billable), ...over,
});

/**
 * One period. `tokensByProvider` is deliberately LARGER than the sum of the
 * `byModel` rows, which is the real shape whenever a tool has more than 24
 * models in a period: main caps the list and sends the true subtotal separately.
 */
function period(over = {}) {
  return {
    key: '2026-09', startsAt: '2026-09-01T00:00:00.000Z', endsAt: '2026-09-30T00:00:00.000Z',
    costUsd: 12.5,
    byClass: { input: 1, output: 2, cacheWrite5m: 3, cacheWrite1h: 4, cacheRead: 2.5 },
    tokensByProvider: { claude: tk(10_480_000), codex: tk(2_050_000) },
    tokenFloorCausesByProvider: {},
    byModel: [
      modelEntry('claude', 'claude-opus-5', 9_600_000),
      modelEntry('claude', 'claude-haiku-4-5', 820_000),
      modelEntry('codex', 'gpt-5.6-sol', 2_050_000),
    ],
    isFloor: false, unpricedModels: [], hasUsage: true,
    ...over,
  };
}

function history(over = {}) {
  return {
    weeks: [], months: [period()],
    usageProviders: ['claude', 'codex'],
    incompleteProviders: [],
    floorCausesByProvider: {},
    pricesAsOfByProvider: { claude: '2026-06-24', codex: '2026-09-16' },
    ...over,
  };
}

const prov = (id, displayName) => ({
  id, displayName, accent: '#888', experimental: false,
  enabled: true, connected: true, status: 'ok', planLabel: null,
  fiveHour: null, sevenDay: null, tokens: null,
  weeklyTokens: null, weeklyTokensWindowAnchored: null, weeklyTokenFloorCauses: [],
  burnRatePerHour: null, byModel: [], weeklyCost: null, setupAction: null, lastGoodAt: null,
});

const PROVIDERS = [prov('claude', 'Claude Code'), prov('codex', 'Codex'), prov('kimi', 'Kimi'), prov('qwen', 'Qwen Code')];

/** Mount the component and read the subtotal list of the first period. */
function subtotalsOf(hist, providers = PROVIDERS) {
  const handle = settingsMod.createSettings({
    onToggle() {}, onTheme() {}, onBack() {}, onLanguage() {}, onGrain() {},
  });
  const store = new storeMod.Store();
  store.set({ hasData: true, snapshot: { generatedAt: new Date(NOW).toISOString(), providers, usageHistory: hist, pendingUsage: [] } });
  handle.render(store.get(), providers);

  const nodes = walk(handle.el);
  const block = nodes.find((n) => (n.getAttribute('class') || '').includes('usage__tokens')
    && (n.getAttribute('role') === 'list'));
  if (!block) return null;
  const rowNodes = walk(block).filter((n) => (n.getAttribute('class') || '').includes('usage__tokens-row'));
  const textIn = (node, cls) => {
    const hit = walk(node).find((n) => (n.getAttribute('class') || '').includes(cls));
    return hit ? hit.textContent : null;
  };
  return {
    lead: textIn(block, 'usage__tokens-lead'),
    rows: rowNodes.map((r) => ({
      provider: r.getAttribute('data-provider'),
      tool: textIn(r, 'usage__tokens-tool'),
      count: textIn(r, 'usage__tokens-count'),
      cause: textIn(r, 'usage__tokens-cause'),
      floor: r.getAttribute('data-token-floor'),
    })),
  };
}

/* ----------------------------------------- the subtotal is main's own figure */

test.describe('the subtotal is read from tokensByProvider, never folded from the rows', () => {
  test('a tool whose byModel rows fall short of its subtotal still shows the subtotal', () => {
    // Claude's rows sum to 10.42M; its true subtotal is 10.48M. Folding the rows
    // would print the smaller figure and nothing else would notice.
    const s = subtotalsOf(history());
    assert.ok(s, 'no subtotal block rendered');
    const claude = s.rows.find((r) => r.provider === 'claude');
    assert.equal(claude.count, fmt.tokens(10_480_000));
    assert.notEqual(claude.count, fmt.tokens(9_600_000 + 820_000), 'this is the folded figure, and it is wrong');
  });

  test('a tool with a subtotal but NO model rows at all is still counted', () => {
    // A fold over `byModel` would drop this tool entirely.
    const s = subtotalsOf(history({
      months: [period({
        tokensByProvider: { claude: tk(10_480_000), codex: tk(2_050_000) },
        byModel: [modelEntry('claude', 'claude-opus-5', 9_600_000)],
      })],
    }));
    const codex = s.rows.find((r) => r.provider === 'codex');
    assert.ok(codex, 'the tool vanished with its model rows');
    assert.equal(codex.count, fmt.tokens(2_050_000));
  });

  test('a tool with model rows but NO subtotal entry shows no subtotal line', () => {
    // The inverse: the map is the source of truth for presence too.
    const s = subtotalsOf(history({
      months: [period({ tokensByProvider: { claude: tk(10_480_000) } })],
    }));
    assert.deepEqual(s.rows.map((r) => r.provider), ['claude']);
  });
});

/* ------------------------------------------------------- never merged, never a total */

test.describe('one row per tool, and no row that is a total', () => {
  test('two tools produce exactly two rows, in the order main listed them', () => {
    const s = subtotalsOf(history());
    assert.deepEqual(s.rows.map((r) => r.provider), ['claude', 'codex']);
  });

  test('no rendered figure equals the cross-tool sum', () => {
    // The banned figure, checked on the output rather than on the source text.
    const merged = fmt.tokens(10_480_000 + 2_050_000);
    for (const r of s0().rows) assert.notEqual(r.count, merged, `${r.provider} carries the merged total`);
  });
  const s0 = () => subtotalsOf(history());

  test('four tools produce four separate rows and still no total', () => {
    const s = subtotalsOf(history({
      usageProviders: ['claude', 'codex', 'kimi', 'qwen'],
      months: [period({
        tokensByProvider: { claude: tk(1000), codex: tk(1000), kimi: tk(1000), qwen: tk(1000) },
        byModel: [modelEntry('claude', 'claude-opus-5', 1000)],
      })],
    }));
    assert.equal(s.rows.length, 4);
    for (const r of s.rows) assert.equal(r.count, fmt.tokens(1000), `${r.provider}`);
    assert.equal(s.rows.some((r) => r.count === fmt.tokens(4000)), false, 'a merged total appeared');
  });

  test('the grey lead line above the counts is gone (owner, 2026-09-23)', () => {
    // It read "Araç başına faturalanan token, önbellek okuma hariç; toplanmaz ·
    // takvim haftası, Pzt–Paz" under every period. The per-row title still
    // carries the four classes, cache reads named on their own.
    const s = subtotalsOf(history());
    assert.equal(s.lead, null);
    assert.equal(s.rows.length, 2, 'the counts themselves stay');
  });

  test('an empty period grows no subtotal block at all', () => {
    const s = subtotalsOf(history({
      months: [period({ tokensByProvider: {}, byModel: [], hasUsage: false, costUsd: 0 })],
    }));
    assert.equal(s, null);
  });
});

/* ------------------------------------------------------------ floors and causes */

/**
 * The floor marker was removed from the panel (owner, 2026-09-23): no "en az",
 * no cause under the count, no quieter ink for a bounded count. Main still
 * sends `tokenFloorCausesByProvider`; none of it may reach the screen.
 */
const FLOOR_MARKERS = [/\ben az\b/i, /\bat least\b/i, /~/];

test.describe('a subtotal is printed as it is, whatever floor causes main sends', () => {
  test('a tool main marks as a lower bound reads exactly like one it does not', () => {
    const s = subtotalsOf(history({
      months: [period({ tokenFloorCausesByProvider: { codex: ['unrecorded-writes'] } })],
    }));
    const codex = s.rows.find((r) => r.provider === 'codex');
    const claude = s.rows.find((r) => r.provider === 'claude');
    assert.equal(codex.count, fmt.tokens(2_050_000));
    assert.equal(claude.count, fmt.tokens(10_480_000));
    for (const r of s.rows) {
      for (const marker of FLOOR_MARKERS) assert.doesNotMatch(r.count, marker, r.count);
      assert.equal(r.cause, null, `${r.provider} grew a cause line`);
      assert.equal(r.floor, null, `${r.provider} carries a floor hook`);
    }
  });

  test('a period whose DOLLARS are a floor adds nothing to any count', () => {
    const s = subtotalsOf(history({
      months: [period({ isFloor: true, unpricedModels: ['claude-opus-4-8'], tokenFloorCausesByProvider: {} })],
    }));
    for (const r of s.rows) {
      assert.equal(r.floor, null, r.provider);
      for (const marker of FLOOR_MARKERS) assert.doesNotMatch(r.count, marker, r.count);
    }
  });

  test('a zero count with a cause is a plain zero, with no cause beside it', () => {
    const s = subtotalsOf(history({
      usageProviders: ['codex'],
      months: [period({
        tokensByProvider: { codex: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, billable: 0 } },
        tokenFloorCausesByProvider: { codex: ['unread-range'] },
        byModel: [modelEntry('codex', 'gpt-5.6-sol', 0, { tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, billable: 0 } })],
      })],
    }));
    const codex = s.rows.find((r) => r.provider === 'codex');
    assert.equal(codex.count, fmt.tokens(0), 'a measured zero prints as zero');
    assert.equal(codex.cause, null);
  });

  test('a malformed cause map is still accepted without a claim', () => {
    for (const bad of [null, undefined, 'codex', 7, { codex: 'unrecorded-writes' }]) {
      const s = subtotalsOf(history({ months: [period({ tokenFloorCausesByProvider: bad })] }));
      for (const r of s.rows) assert.equal(r.floor, null, JSON.stringify(bad) + ' / ' + r.provider);
    }
  });
});

/* ------------------------------------------------- the boundary state main cannot send */

test.describe('a count that never arrived is rendered safely, not as a zero', () => {
  test('a null PeriodModelCost.tokens prints nothing and does not crash the list', () => {
    // Strictly the sanitiser's "did not arrive" — main never sends null for an
    // entry it created. It must still render without inventing a figure.
    const s = subtotalsOf(history({
      months: [period({
        byModel: [modelEntry('claude', 'claude-opus-5', 9_600_000, { tokens: null })],
      })],
    }));
    assert.ok(s, 'the list must survive a null count');
    assert.equal(s.rows.find((r) => r.provider === 'claude').count, fmt.tokens(10_480_000));
  });

  test('an unreadable subtotal entry drops the tool rather than showing a zero', () => {
    const s = subtotalsOf(history({
      months: [period({ tokensByProvider: { claude: tk(10_480_000), codex: null } })],
    }));
    assert.deepEqual(s.rows.map((r) => r.provider), ['claude']);
  });
});
