'use strict';
/**
 * Fixture preload for the render suites. Implements `UsageNotchApi` exactly as
 * contract.ts declares it, plus a `__probe` channel the suites drive.
 *
 * The cost fixtures are the ones that matter: the LIVE numbers measured on a
 * real machine, and then every state that is zero or absent there and would
 * therefore never be looked at — an all-unpriced week, a partly-broken
 * payload, a sub-cent total and both caveats.
 */
const { contextBridge } = require('electron');

const now = new Date();
const iso = (ms) => new Date(now.getTime() + ms).toISOString();

function win(pct, certainty) {
  return { usedPercentage: pct, certainty, resetsAt: iso(90 * 60000), capturedAt: null };
}
function tok(b) {
  return { input: b * 0.2, output: b * 0.1, cacheWrite: b * 0.7, cacheRead: b * 12, billable: b };
}
const ADD = {
  kind: 'not-installed',
  label: 'Ekle',
  detail: 'Bu araç bu makinede bulunamadı.',
};

function p(id, name, accent, connected, status, extra) {
  return Object.assign(
    {
      id,
      displayName: name,
      accent,
      // ADR-003 A6.4: the registry fact main sends for every provider.
      experimental: id === 'gemini' || id === 'kimi',
      // ADR-003 A8 (Phase B): only Copilot can use an optional key, and it
      // starts with none stored — the state that shows the calm offer.
      keyCapable: id === 'copilot',
      keyState: 'none',
      keyStoredAt: null,
      creditUsage: null,
      // Every fixture row starts ADDED; the settings checks flip these at
      // runtime through __probe so the earlier structural checks still see
      // all six rows.
      enabled: true,
      connected,
      status,
      planLabel: null,
      fiveHour: null,
      sevenDay: null,
      tokens: null,
      // The row headline is the WEEKLY count; `tokens` is the 5h detail
      // beside it. Null together, as the contract states.
      weeklyTokens: null,
      weeklyTokensWindowAnchored: null,
      weeklyTokenFloorCauses: [],
      burnRatePerHour: null,
      byModel: [],
      weeklyCost: null,
      setupAction: null,
    },
    extra || {},
  );
}


const LIVE_COST = {
  totalUsd: 226.8116,
  byClass: { input: 0.0172, output: 32.8177, cacheWrite5m: 20.2495, cacheWrite1h: 26.6909, cacheRead: 147.0362 },
  byModel: [
    { model: 'claude-opus-5', speed: 'standard', pricedAs: 'claude-opus-5|standard', usd: 226.7641,
      tokens: { input: 3438, output: 1312553, cacheWrite: 5904684, cacheRead: 294059426, billable: 7220675 } },
    { model: 'claude-haiku-4-5-20251001', speed: 'standard', pricedAs: 'claude-haiku-4-5|standard', usd: 0.0475,
      tokens: { input: 39, output: 768, cacheWrite: 21664, cacheRead: 65260, billable: 22471 } },
  ],
  unpricedModels: [],
  fallbackWriteEvents: 0,
  cacheWriteEvents: 1781,
  // ADR-002 A3.15: every log in the window was read. Spread into the costs
  // below, so the stale gemini row carries false too — its limit capture is
  // old, its logs are not incomplete, and the cost block must not say so.
  sourceIncomplete: false,
  assumedTierEvents: 0,
  fastRequestedEvents: 0,
  pricesAsOf: '2026-06-24',
  windowStart: iso(-4 * 864e5),
  windowEnd: iso(3 * 864e5),
  windowAnchored: true,
};
const CAVEAT_COST = {
  ...LIVE_COST,
  byModel: [
    LIVE_COST.byModel[0],
    { model: 'claude-opus-4-8', speed: 'standard', pricedAs: 'claude-opus-4-8|standard', usd: 12.4,
      tokens: { input: 10, output: 900, cacheWrite: 4000, cacheRead: 900000, billable: 480000 } },
    { model: 'claude-opus-4-8', speed: 'fast', pricedAs: null, usd: null,
      tokens: { input: 20, output: 1800, cacheWrite: 9000, cacheRead: 1800000, billable: 1180000 } },
  ],
  unpricedModels: ['claude-opus-4-8'],
  fallbackWriteEvents: 1412,
  cacheWriteEvents: 1781,
  windowAnchored: false,
  windowStart: new Date(Date.now() - 7 * 864e5).toISOString(),
  windowEnd: new Date(Date.now() - 1000).toISOString(),
};
/**
 * A Codex-shaped week (ADR-002 Amendment 3), swapped onto the codex row by
 * `__probe.setCostDirect('codex', 'codexTier')` so the Claude-shaped caveat
 * checks above keep their own fixture.
 *
 * 38 records read from the cache with 0 recorded writes on a model that bills
 * writes, so the figure is a floor with its OWN caveat (not the TTL one). The
 * unpriced rows carry every group-label shape src/core/codex/pricing.js emits:
 * an undeterminable tier, a long-context exclusion, and a tier with no
 * published row ('flex'), none of which may be printed raw.
 */
const CODEX_TIER_COST = {
  totalUsd: 226.8116,
  byClass: { input: 21.4, output: 60.2, cacheWrite5m: 18.1, cacheWrite1h: 0, cacheRead: 127.1116 },
  byModel: [
    { model: 'gpt-5.6-sol', speed: 'standard', pricedAs: 'gpt-5.6-sol|standard', usd: 226.8116,
      tokens: { input: 5350000, output: 3010000, cacheWrite: 3620000, cacheRead: 317779000, billable: 11980000 } },
    { model: 'gpt-5.6-sol', speed: 'unknown-tier', pricedAs: null, usd: null,
      tokens: { input: 60000, output: 21000, cacheWrite: 0, cacheRead: 36000, billable: 117000 } },
    { model: 'gpt-5.5', speed: 'unknown-tier-long-context', pricedAs: null, usd: null,
      tokens: { input: 300000, output: 12000, cacheWrite: 0, cacheRead: 100000, billable: 412000 } },
    { model: 'gpt-5.6-terra', speed: 'flex', pricedAs: null, usd: null,
      tokens: { input: 5000, output: 4000, cacheWrite: 0, cacheRead: 0, billable: 9000 } },
    // An event whose model could not be resolved: usage.js writes exactly
    // 'unknown', which must read as "model belirlenemedi", not as a model id.
    { model: 'unknown', speed: 'unknown-tier', pricedAs: null, usd: null,
      tokens: { input: 3000, output: 1000, cacheWrite: 0, cacheRead: 0, billable: 4000 } },
  ],
  unpricedModels: ['gpt-5.5', 'gpt-5.6-terra'],
  fallbackWriteEvents: 0,
  cacheWriteEvents: 0,
  unrecordedWriteEvents: 38,
  sourceIncomplete: false,
  assumedTierEvents: 0,
  fastRequestedEvents: 0,
  pricesAsOf: '2026-09-14',
  windowStart: iso(-4 * 864e5),
  windowEnd: iso(3 * 864e5),
  windowAnchored: true,
};
/**
 * qa F3: the zero-recorded-writes floor as the ONLY floor cause. Everything is
 * priced, no TTL fallback, no unpriced model — so "en az" here can only come
 * from `unrecordedWriteEvents`. CODEX_TIER_COST cannot prove that: its
 * unpriced rows would floor the figure on their own.
 */
const CODEX_UNRECORDED_ONLY_COST = {
  ...CODEX_TIER_COST,
  byModel: [CODEX_TIER_COST.byModel[0]],
  unpricedModels: [],
  fallbackWriteEvents: 0,
  cacheWriteEvents: 0,
  unrecordedWriteEvents: 1,
};
/**
 * ADR-002 A3.15: the cost reader KNOWS it missed events, and that is the ONLY
 * floor cause. Everything else is LIVE_COST's clean week, so "en az" and the
 * "could not be read" line can only come from `sourceIncomplete`.
 */
const SOURCE_INCOMPLETE_COST = {
  ...LIVE_COST,
  sourceIncomplete: true,
};
/**
 * The owner's screenshot (2026-09-17), shape for shape: one unpriced Codex
 * entry with an undeterminable tier and 202 records with unrecorded writes.
 * `sourceIncomplete` is false: the logs were read, and the old third
 * paragraph ("veriler güncel değil") was the false claim this replaces.
 */
const OWNER_CODEX_COST = {
  ...CODEX_TIER_COST,
  byModel: [
    CODEX_TIER_COST.byModel[0],
    { model: 'gpt-5.6-sol', speed: 'unknown-tier', pricedAs: null, usd: null,
      tokens: { input: 120000, output: 19800, cacheWrite: 0, cacheRead: 30000, billable: 169800 } },
  ],
  unpricedModels: [],
  unrecordedWriteEvents: 202,
  sourceIncomplete: false,
};
/** Every compact cause at once, with a Claude-shaped TTL fallback beside the
 *  Codex causes, so all four short lines can be measured together. */
const ALL_CAUSES_COST = {
  ...CODEX_TIER_COST,
  fallbackWriteEvents: 1412,
  cacheWriteEvents: 1781,
  assumedTierEvents: 30,
  fastRequestedEvents: 23,
  sourceIncomplete: true,
};
/** ADR-004 A3, the owner's screenshot: 235 unrecorded writes, 30 records with no
 *  recorded tier and 23 with Fast requested. Nothing unpriced, logs read. */
const OWNER_TIERS_COST = {
  ...CODEX_UNRECORDED_ONLY_COST,
  unrecordedWriteEvents: 235,
  assumedTierEvents: 30,
  fastRequestedEvents: 23,
};
/**
 * F5: the reader missed records and priced nothing. Must NOT hide the block
 * (hidden reads as "no usage") and must not say "not in the price list".
 */
const INCOMPLETE_NO_FIGURE_COST = {
  ...LIVE_COST,
  totalUsd: 0,
  byClass: { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
  byModel: [],
  unpricedModels: [],
  fallbackWriteEvents: 0,
  cacheWriteEvents: 0,
  unrecordedWriteEvents: 0,
  sourceIncomplete: true,
};
/**
 * ADR-002 A3.17/A3.18/A3.21: the two tier floors as the ONLY causes. 24 events
 * before Codex recorded a tier, 1 event where Fast was only requested (the
 * singular, so the plural forms are both exercised across the two lines).
 */
const TIER_FLOOR_COST = {
  ...CODEX_UNRECORDED_ONLY_COST,
  unrecordedWriteEvents: 0,
  assumedTierEvents: 24,
  fastRequestedEvents: 1,
};
/** Ten unpriced entries: the "why" list names eight and counts two. */
const MANY_UNPRICED_COST = {
  ...CODEX_TIER_COST,
  byModel: [
    CODEX_TIER_COST.byModel[0],
    ...Array.from({ length: 10 }, (_, i) => ({
      model: `gpt-5.${i}-probe`, speed: 'unknown-tier', pricedAs: null, usd: null,
      tokens: { input: 1000 * (i + 1), output: 100, cacheWrite: 0, cacheRead: 0, billable: 1100 * (i + 1) },
    })),
  ],
  unpricedModels: [],
  unrecordedWriteEvents: 0,
};
/**
 * ADR-003 A6: a Gemini CLI week. Priced at Gemini API standard rates, always a
 * floor (unrecorded calls), with long-prompt and tool-token counts and one
 * usage group that recorded no model ('no-model', never printed raw).
 */
const GEMINI_COST = {
  totalUsd: 12.34,
  byClass: { input: 5.1, output: 6.2, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 1.04 },
  byModel: [
    { model: 'gemini-2.5-pro', speed: 'standard', pricedAs: 'gemini-2.5-pro|standard', usd: 12.34,
      tokens: { input: 900000, output: 120000, cacheWrite: 0, cacheRead: 400000, billable: 1020000 } },
    { model: 'unknown', speed: 'no-model', pricedAs: null, usd: null,
      tokens: { input: 4000, output: 800, cacheWrite: 0, cacheRead: 0, billable: 4800 } },
  ],
  unpricedModels: [],
  fallbackWriteEvents: 0,
  cacheWriteEvents: 0,
  unrecordedWriteEvents: 0,
  sourceIncomplete: false,
  assumedTierEvents: 0,
  fastRequestedEvents: 0,
  unrecordedCalls: true,
  longPromptFloorEvents: 3,
  toolTokenEvents: 7,
  pricesAsOf: '2026-09-10',
  windowStart: iso(-6 * 864e5),
  windowEnd: iso(-1000),
  windowAnchored: false,
};
/** ADR-003 A6: a Kimi Code week. No price table: every row unpriced, pricesAsOf ''. */
const KIMI_COST = {
  totalUsd: 0,
  byClass: { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
  byModel: [
    { model: 'kimi-code/kimi-for-coding', speed: 'no-published-price', pricedAs: null, usd: null,
      tokens: { input: 300000, output: 40000, cacheWrite: 0, cacheRead: 120000, billable: 340000 } },
    { model: 'openrouter/claude-sonnet', speed: 'other-model-alias', pricedAs: null, usd: null,
      tokens: { input: 20000, output: 5000, cacheWrite: 0, cacheRead: 0, billable: 25000 } },
  ],
  unpricedModels: ['kimi-code/kimi-for-coding', 'openrouter/claude-sonnet'],
  fallbackWriteEvents: 0,
  cacheWriteEvents: 0,
  unrecordedWriteEvents: 0,
  sourceIncomplete: false,
  assumedTierEvents: 0,
  fastRequestedEvents: 0,
  unrecordedCalls: false,
  longPromptFloorEvents: 0,
  toolTokenEvents: 0,
  pricesAsOf: '',
  windowStart: iso(-6 * 864e5),
  windowEnd: iso(-1000),
  windowAnchored: false,
};
const NAMED_COSTS = {
  gemini: GEMINI_COST,
  kimi: KIMI_COST,
  ownerTiers: OWNER_TIERS_COST,
  tierFloor: TIER_FLOOR_COST,
  manyUnpriced: MANY_UNPRICED_COST,
  incompleteNoFigure: INCOMPLETE_NO_FIGURE_COST,
  codexTier: CODEX_TIER_COST,
  codexUnrecordedOnly: CODEX_UNRECORDED_ONLY_COST,
  caveat: CAVEAT_COST,
  sourceIncomplete: SOURCE_INCOMPLETE_COST,
  owner: OWNER_CODEX_COST,
  allCauses: ALL_CAUSES_COST,
};
// An older or partly-broken main: the figure is there, everything ABOUT the
// figure is missing. Must degrade, never vanish.
const PARTIAL_COST = {
  totalUsd: 41.5,
  byModel: [],
  unpricedModels: [],
  fallbackWriteEvents: 0,
  cacheWriteEvents: 0,
  windowAnchored: true,
};
// qa F1. Every model unpriced: totalUsd is 0 and byClass is all zeros, which
// is a truthful "nothing could be priced" — and used to render "en az $0,00".
// Reachable the first time Claude Code ships a model family the hand-copied
// 2026-06-24 price table does not name.
const ALL_UNPRICED_COST = {
  totalUsd: 0,
  byClass: { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
  byModel: [
    { model: 'claude-opus-6-20270105', speed: 'standard', pricedAs: null, usd: null,
      tokens: { input: 4100, output: 980000, cacheWrite: 3100000, cacheRead: 88000000, billable: 4084100 } },
    { model: 'claude-opus-6-20270105', speed: 'fast', pricedAs: null, usd: null,
      tokens: { input: 200, output: 41000, cacheWrite: 90000, cacheRead: 2100000, billable: 131200 } },
  ],
  unpricedModels: ['claude-opus-6-20270105'],
  fallbackWriteEvents: 0,
  cacheWriteEvents: 902,
  pricesAsOf: '2026-06-24',
  windowStart: iso(-4 * 864e5),
  windowEnd: iso(3 * 864e5),
  windowAnchored: true,
};
/**
 * The per-model quota block, as measured live: eight models, one figure, one
 * reset. `diverged: false` is the common case and the one the collapsed line
 * has to stay quiet about.
 *
 * Two of the eight are Claude models. That is the whole reason this block is
 * shaped the way it is: an Antigravity row lists them directly beneath the
 * user's real Claude Code row, so no rendered string may pair one of these
 * names with a percentage.
 */
const LIVE_QUOTAS = {
  groups: [
    {
      usedPercentage: 0,
      resetsAt: iso(5 * 3600000),
      members: [
        'Claude Opus 4.6 (Thinking)',
        'Claude Sonnet 4.6 (Thinking)',
        'GPT-OSS 120B (Medium)',
        'Gemini 3.1 Pro (High)',
        'Gemini 3.1 Pro (Low)',
        'Gemini 3.6 Flash (High)',
        'Gemini 3.6 Flash (Low)',
        'Gemini 3.6 Flash (Medium)',
      ],
    },
  ],
  diverged: false,
  source: 'antigravity.ide.quota_info.remaining_fraction',
  provenance: 'derived',
  capturedAt: new Date(now.getTime() - 12 * 60000).toISOString(),
  // The model the user has selected in Antigravity — the real one, per the
  // brief. In the single-group shape it lives in group 0. The headline
  // five-hour figure follows this group, which is why the row labels it.
  selectedModel: 'Claude Opus 4.6 (Thinking)',
  selectedGroupIndex: 0,
};

const TINY_COST = {
  ...LIVE_COST,
  totalUsd: 0.004,
  byClass: { input: 0.0009, output: 0.002, cacheWrite5m: 0.0006, cacheWrite1h: 0.0004, cacheRead: 0.0001 },
  byModel: [LIVE_COST.byModel[1]],
  // This cost sits on the GEMINI row, and Gemini CLI publishes no weekly reset,
  // so main can only ever price it over a trailing seven days
  // (`localUsageRow` passes anchored=false unconditionally). Inheriting
  // LIVE_COST's `windowAnchored: true` made the fixture a state main cannot
  // produce, and a contradictory one: the cost block would say "kota haftası"
  // while the row's own token line on the SAME row says "Son 7 gün", because
  // that line reads `weeklyTokensWindowAnchored`. A fixture that shows an
  // impossible pairing cannot catch a real one.
  windowAnchored: false,
  windowStart: iso(-7 * 864e5),
  windowEnd: iso(0),
};

/**
 * The Copilot row as main builds it for each key situation (snapshot.js, the
 * non-claude passive branch). A stored key is the row's source, so main drops
 * the setup offer; a reading makes the row connected; it stays 'passive'
 * because GitHub reports monthly AI credits, not a five-hour or weekly window.
 * Patches, merged onto the fixture's own Copilot row by `setCopilotKeyDirect`.
 */
const COPILOT_KEY = {
  // No key: exactly the fixture's own row — the unsupported passive row with
  // its "Ekle" and the calm offer to add a key.
  none: () => ({ keyState: 'none', keyStoredAt: null, creditUsage: null, connected: false, setupAction: ADD }),
  credits: () => ({
    keyState: 'stored',
    keyStoredAt: '2026-09-20T09:15:00.000Z',
    creditUsage: {
      grossCredits: 1234, includedCredits: 900, billedCredits: 334,
      periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-09-30T23:59:59.000Z',
      fetchedAt: new Date(Date.now() - 12 * 60000).toISOString(),
    },
    connected: true,
    setupAction: null,
  }),
  'key-rejected': () => ({
    keyState: 'key-rejected', keyStoredAt: '2026-09-20T09:15:00.000Z', creditUsage: null,
    connected: false, setupAction: null,
  }),
};

/**
 * Two fixtures, selected by RENDER_FIXTURE.
 *
 * They are separate on purpose. The panel suite drives OS-level mouse input at
 * measured pixel coordinates, so it needs SHORT rows and a list that does not
 * scroll; the cost suite needs rows carrying every cost state, which makes them
 * four times taller. One shared fixture made each suite's geometry depend on
 * the other's data, and the drag tests failed for reasons that had nothing to
 * do with dragging.
 */
const FIXTURES = {
  // Identity marks and reordering: two connected, four passive, no cost blocks.
  panel: () => [
    p('claude', 'Claude Code', '#C96442', true, 'ok', {
      planLabel: 'Max 20x',
      fiveHour: win(62, 'known'),
      sevenDay: win(24, 'known'),
      tokens: tok(1240000),
      weeklyTokens: tok(6200000),
      weeklyTokensWindowAnchored: true,
      burnRatePerHour: 240_000,
    }),
    p('codex', 'Codex', '#10A37F', true, 'ok', {
      fiveHour: win(91, 'known'),
      tokens: tok(410000),
      weeklyTokens: tok(2050000),
      // Codex publishes no weekly reset to us, so its window is trailing.
      weeklyTokensWindowAnchored: false,
      burnRatePerHour: 90_000,
    }),
    p('gemini', 'Gemini', '#4386F5', false, 'passive', { setupAction: ADD }),
    p('copilot', 'Copilot', '#8B5CF6', false, 'passive', { setupAction: ADD }),
    p('antigravity', 'Antigravity', '#E8B84B', false, 'passive', { setupAction: ADD }),
    p('kimi', 'Kimi', '#2B6BE8', false, 'passive', { setupAction: ADD }),
  ],

  // Every cost state at once. Each of these is zero, absent or impossible on a
  // real machine today, which is exactly why they need a fixture.
  cost: () => [
    p('claude', 'Claude Code', '#C96442', true, 'ok', {
      planLabel: 'Max 20x',
      weeklyCost: LIVE_COST,
      fiveHour: win(62, 'known'),
      sevenDay: win(24, 'known'),
      tokens: tok(1240000),
      weeklyTokens: tok(6200000),
      weeklyTokensWindowAnchored: true,
      burnRatePerHour: 240_000,
    }),
    p('codex', 'Codex', '#10A37F', true, 'ok', {
      weeklyCost: CAVEAT_COST,
      fiveHour: win(91, 'known'),
      tokens: tok(410000),
      weeklyTokens: tok(2050000),
      // Codex publishes no weekly reset to us, so its window is trailing.
      weeklyTokensWindowAnchored: false,
      burnRatePerHour: 90_000,
    }),
    // A stale row: the meter dims, and the cost figure must become a bound.
    p('gemini', 'Gemini', '#4386F5', true, 'stale', {
      weeklyCost: TINY_COST,
      fiveHour: win(31, 'known'),
      tokens: tok(120000),
      weeklyTokens: tok(600000),
      // Gemini CLI is ALWAYS trailing (contract): it publishes no weekly reset.
      weeklyTokensWindowAnchored: false,
      lastGoodAt: new Date(Date.now() - 40 * 60_000).toISOString(),
    }),
    // A payload from a main process that produced the figure and nothing else.
    p('copilot', 'Copilot', '#8B5CF6', false, 'passive', {
      weeklyCost: PARTIAL_COST,
      setupAction: ADD,
    }),
    // Nothing in the window could be priced at all.
    p('antigravity', 'Antigravity', '#E8B84B', true, 'ok', {
      weeklyCost: ALL_UNPRICED_COST,
      fiveHour: win(12, 'known'),
      tokens: tok(4215300),
      weeklyTokens: tok(21076500),
      // No weekly window on this row, so the count cannot be anchored to one.
      weeklyTokensWindowAnchored: false,
      modelQuotas: LIVE_QUOTAS,
    }),
    p('kimi', 'Kimi', '#2B6BE8', false, 'passive', { setupAction: ADD }),
  ],
};

/**
 * A small `usageHistory` for the settings "Toplam Kullanım" section, shared by
 * both fixtures (it lives in the settings view, so it moves no row geometry).
 *
 * The newest month lists a Claude Code AND a Codex model, because the section's
 * point since the Codex merge is that one period mixes both tools and each
 * model row has to say which tool it belongs to. One floor and one unpriced
 * entry keep the framing rules ("en az", "fiyatlanamadı") in view. Both price
 * dates are present, so the two-date note is the one rendered.
 */
function localMidnight(y, m, d) {
  return new Date(y, m, d).toISOString();
}
function usageHistoryFixture() {
  const y = now.getFullYear();
  const m = now.getMonth();
  const zero = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
  const month = (offset, costUsd, byModel, extra) => ({
    key: `${new Date(y, m - offset, 1).getFullYear()}-${String(new Date(y, m - offset, 1).getMonth() + 1).padStart(2, '0')}`,
    startsAt: localMidnight(y, m - offset, 1),
    endsAt: localMidnight(y, m - offset + 1, 0),
    costUsd,
    byClass: costUsd > 0 ? { input: 1.2, output: costUsd * 0.2, cacheWrite5m: costUsd * 0.1, cacheWrite1h: 0, cacheRead: costUsd * 0.7 - 1.2 } : zero,
    byModel,
    tokensByProvider: {},
    tokenFloorCausesByProvider: {},
    isFloor: false,
    unpricedModels: [],
    hasUsage: costUsd > 0,
    ...extra,
  });
  const months = [
    month(0, 412.37, [
      { provider: 'claude', model: 'claude-opus-5', costUsd: 301.12, isFloor: true, tokens: tok(9_600_000) },
      { provider: 'codex', model: 'gpt-5-codex', costUsd: 98.4, isFloor: false, tokens: tok(3_100_000) },
      { provider: 'claude', model: 'claude-haiku-4-5-20251001', costUsd: 12.85, isFloor: false, tokens: tok(820_000) },
      // Unpriced, and still counted: the tokens were used whether or not a
      // price exists for them, so the count must NOT be blanked to match.
      { provider: 'codex', model: 'codex-mini-preview', costUsd: null, isFloor: false, tokens: tok(240_000) },
      // No resolvable model: shown as "model belirlenemedi", never as "unknown".
      { provider: 'codex', model: 'unknown', costUsd: null, isFloor: false, tokens: tok(55_000) },
    ], {
      isFloor: true,
      unpricedModels: ['codex-mini-preview', 'unknown'],
      // NOT the sum of the rows above: the list is capped at 24 entries, so
      // the subtotal is main's own and the renderer must read it from here.
      tokensByProvider: { claude: tok(10_480_000), codex: tok(3_420_000) },
      // Codex records 0 cache writes, so its COUNT is a floor AND carries the
      // reason that has to be on screen with it (A3.16). Claude's dollars are a
      // floor in this month and its token count is still exact — the two claims
      // are deliberately different.
      tokenFloorCausesByProvider: { codex: ['unrecorded-writes'] },
    }),
    month(1, 87.5, [
      { provider: 'claude', model: 'claude-opus-5', costUsd: 87.5, isFloor: false, tokens: tok(2_900_000) },
    ], { tokensByProvider: { claude: tok(2_900_000) }, tokenFloorCausesByProvider: {} }),
    // An empty month. With Codex still being counted it must NOT read "—":
    // its Codex usage has simply not been read yet (ADR-002 A3.12).
    month(2, 0, []),
  ];
  return {
    weeks: [],
    months,
    pricesAsOf: '2026-08-01',
    pricesAsOfByProvider: { claude: '2026-08-01', codex: '2026-08-15' },
    // ADR-003 A6: the tools in these figures and each one's floor causes.
    usageProviders: ['claude', 'codex'],
    floorCausesByProvider: { claude: ['unpriced'], codex: ['unpriced', 'unrecorded-writes'] },
  };
}

const which = process.env.RENDER_FIXTURE === 'cost' ? 'cost' : 'panel';
const snapshot = {
  generatedAt: now.toISOString(),
  providers: FIXTURES[which](),
  usageHistory: usageHistoryFixture(),
  // ADR-002 A3.12. Always present, [] once every tool's first scan answered.
  pendingUsage: [],
};

const calls = { setOrder: [], setEnabled: [], setTheme: [], setLanguage: [], setAutostart: [], panelOpened: 0, pin: 0, close: 0 };
let snapshotCb = null;
let anchorCb = null;
let failOrder = false;
let failEnabled = false;
let failTheme = false;
let failAutostart = false;
/** How long requestRefresh() takes, so the in-flight state can be observed. */
let refreshDelay = 0;
/**
 * What the NEXT refresh reply carries in `refreshNotices` — the field main
 * builds onto the invoke reply alone, never onto a push. The suite drives it
 * to exercise the "Antigravity açık değil" bubble.
 */
let refreshNotices = null;
/**
 * What a setup attempt answers with.
 *
 * The notice box is the only surface that renders these, and the message that
 * exposed both of its defects — no way to dismiss it, and a cut that landed
 * mid-word — was a real `runSetup` failure. So the suite has to be able to
 * hand the renderer an arbitrary message, including one over the 160-character
 * notice cap.
 */
let setupResult = { ok: false, message: '' };
/**
 * Main's persisted preferences. 'dark' rather than 'system' so the suite's
 * baseline does not depend on whatever the machine running it is set to.
 */
let prefs = { theme: 'dark', language: 'tr', resolvedLanguage: 'tr', formatLocale: 'tr-TR', autostart: true };
let prefsCb = null;
/**
 * When true, setLanguage persists and answers {ok:true} but HOLDS the
 * PREFERENCES push until `__probe.flushPrefs()`. Main pushes before it replies,
 * so in the real order the two are indistinguishable from the renderer; held
 * apart here, the suite can prove the words follow the PUSH and not the reply
 * (ADR-004 A1.7: the renderer is not optimistic about the language).
 */
let deferPrefs = false;
let heldPrefs = null;
/** Main owns the mode; the renderer only asks. Mirrored here. */
let mode = 'hover';
/** Every key-channel ask the panel made (ADR-003 A8). Ids only: no key ever
 *  crosses this boundary in either direction. */
const keyCalls = { requestKeyEntry: [], removeKey: [], openTokenPage: [], refreshKey: [] };

/** Geometry good enough to place the panel inside the 420x700 test window. */
function anchorPayload(mode, anchorSource) {
  return {
    tray: { x: 200, y: 660, width: 24, height: 24 },
    anchorSource: anchorSource || 'tray',
    display: {
      id: 1,
      scaleFactor: 1,
      bounds: { x: 0, y: 0, width: 420, height: 700 },
      workArea: { x: 0, y: 0, width: 420, height: 700 },
    },
    window: { x: 0, y: 0, width: 420, height: 700 },
    edge: 'bottom',
    mode,
  };
}

contextBridge.exposeInMainWorld('usageNotch', {
  initialSnapshot: () => snapshot,
  onSnapshot: (cb) => {
    snapshotCb = cb;
    return () => {
      snapshotCb = null;
    };
  },
  onAnchor: (cb) => {
    anchorCb = cb;
    return () => {
      anchorCb = null;
    };
  },
  panelOpened: () => {
    calls.panelOpened++;
  },
  /** Main's reveal/conceal push. The suite never drives it; present so the
   *  fixture matches UsageNotchApi and bridge.ts reports nothing missing. */
  onPanelVisibility: () => () => {},
  requestRefresh: async () => {
    if (refreshDelay > 0) await new Promise((r) => setTimeout(r, refreshDelay));
    // A COPY carries refreshNotices, so the notice rides only this reply and
    // never the pushed object — exactly as main is specified to build it.
    return refreshNotices ? { ...snapshot, refreshNotices: refreshNotices.slice() } : snapshot;
  },
  runSetup: async () => ({ ...setupResult }),
  setOrder: async (ids) => {
    calls.setOrder.push(ids.slice());
    if (failOrder) {
      await new Promise((r) => setTimeout(r, 400));
      return { ok: false };
    }
    const byId = new Map(snapshot.providers.map((x) => [x.id, x]));
    snapshot.providers = ids.map((id) => byId.get(id));
    snapshot.generatedAt = new Date(Date.now() + 1000).toISOString();
    if (snapshotCb) snapshotCb(JSON.parse(JSON.stringify(snapshot)));
    return { ok: true };
  },
  setEnabled: async (id, enabled) => {
    calls.setEnabled.push([id, enabled]);
    if (failEnabled) {
      await new Promise((r) => setTimeout(r, 300));
      return { ok: false };
    }
    snapshot.providers = snapshot.providers.map((p) =>
      p.id === id ? { ...p, enabled } : p,
    );
    snapshot.generatedAt = new Date(Date.now() + 1000).toISOString();
    if (snapshotCb) snapshotCb(JSON.parse(JSON.stringify(snapshot)));
    return { ok: true };
  },
  /** Synchronous, exactly as the contract requires: the theme has to be on
   *  the document in frame one. */
  initialPreferences: () => prefs,
  onPreferences: (cb) => {
    prefsCb = cb;
    return () => {
      prefsCb = null;
    };
  },
  setTheme: async (theme) => {
    calls.setTheme.push(theme);
    if (failTheme) {
      await new Promise((r) => setTimeout(r, 300));
      return { ok: false };
    }
    prefs = { ...prefs, theme };
    if (prefsCb) prefsCb({ ...prefs });
    return { ok: true };
  },
  /** Same shape as setTheme: persist, push, answer; `failAutostart` refuses. */
  setAutostart: async (enabled) => {
    calls.setAutostart.push(enabled);
    if (failAutostart) {
      await new Promise((r) => setTimeout(r, 300));
      return { ok: false };
    }
    prefs = { ...prefs, autostart: enabled };
    if (prefsCb) prefsCb({ ...prefs });
    return { ok: true };
  },
  /**
   * Main's order of events for a language change (contract.ts SET_LANGUAGE):
   * persist, re-resolve, push PREFERENCES. The suite pins Turkish as its
   * baseline (its checks read Turkish copy), so 'system' resolves to tr here.
   */
  setLanguage: async (language) => {
    calls.setLanguage.push(language);
    const resolvedLanguage = language === 'en' ? 'en' : 'tr';
    prefs = {
      ...prefs,
      language,
      resolvedLanguage,
      formatLocale: resolvedLanguage === 'en' ? 'en-US' : 'tr-TR',
    };
    if (deferPrefs) heldPrefs = { ...prefs };
    else if (prefsCb) prefsCb({ ...prefs });
    return { ok: true };
  },
  close: () => {
    calls.close++;
  },
  /**
   * ADR-003 A8: the three key channels. Write-only, and each answers only
   * whether main accepted the ask — there is no getter to mirror, because
   * there is none to expose (K3).
   */
  requestKeyEntry: async (id) => {
    keyCalls.requestKeyEntry.push(id);
    return { ok: true };
  },
  removeKey: async (id) => {
    keyCalls.removeKey.push(id);
    return { ok: true };
  },
  openTokenPage: async (id) => {
    keyCalls.openTokenPage.push(id);
    return { ok: true };
  },
  refreshKey: async (id) => {
    keyCalls.refreshKey.push(id);
    return { ok: true };
  },
  /**
   * A real TOGGLE, as main is. Pressing while pinned unpins and pushes
   * mode:'hover' with the panel still open — the direction that had never
   * been exercised, and the one that traps the panel on screen if the button
   * cannot make it.
   */
  pin: () => {
    calls.pin++;
    mode = mode === 'pin' ? 'hover' : 'pin';
    if (anchorCb) anchorCb(anchorPayload(mode));
  },
});

contextBridge.exposeInMainWorld('__probe', {
  calls: () => JSON.parse(JSON.stringify(calls)),
  /**
   * The FULL provider order main currently holds, added or not.
   *
   * The panel only draws the added ones, so a suite checking that a reorder of
   * the visible subset was expanded back into a whole permutation cannot read
   * its own expectation off the DOM.
   */
  providers: () => snapshot.providers.map((x) => x.id),
  /** Put the fixture back where a section found it, without logging a call. */
  setOrderDirect: (ids) => {
    const byId = new Map(snapshot.providers.map((x) => [x.id, x]));
    snapshot.providers = ids.map((id) => byId.get(id)).filter(Boolean);
    snapshot.generatedAt = new Date().toISOString();
    if (snapshotCb) snapshotCb(JSON.parse(JSON.stringify(snapshot)));
  },
  /** The answer the next setup attempt gets. See `setupResult` above. */
  setSetupResult: (r) => {
    setupResult = { ok: !!r.ok, message: String(r.message || '') };
  },
  setFailOrder: (v) => {
    failOrder = v;
  },
  setFailEnabled: (v) => {
    failEnabled = v;
  },
  setFailTheme: (v) => {
    failTheme = v;
  },
  setFailAutostart: (v) => {
    failAutostart = v;
  },
  /** Main's value moved by the TRAY menu: a push with no request behind it. */
  setAutostartDirect: (v) => {
    prefs = { ...prefs, autostart: !!v };
    if (prefsCb) prefsCb({ ...prefs });
  },
  /** Hold the next language PREFERENCES push until flushPrefs(). */
  setDeferPrefs: (v) => {
    deferPrefs = !!v;
  },
  /** Deliver a held PREFERENCES push. Returns whether one was held. */
  flushPrefs: () => {
    const held = heldPrefs;
    heldPrefs = null;
    if (held && prefsCb) prefsCb(held);
    return held !== null;
  },
  /** What main currently holds, so a revert can be checked against it. */
  prefs: () => ({ ...prefs }),
  /**
   * Push a resolved language and format locale directly, as main would after
   * resolving one. `setLanguage('en')` always resolves en-US; this is how the
   * suite reaches en-GB (same words, different number and date formatting).
   */
  setLocaleDirect: (resolvedLanguage, formatLocale) => {
    prefs = { ...prefs, language: resolvedLanguage, resolvedLanguage, formatLocale };
    if (prefsCb) prefsCb({ ...prefs });
    return true;
  },
  setRefreshDelay: (ms) => {
    refreshDelay = ms;
  },
  /** What the next requestRefresh() reply carries in refreshNotices. */
  setRefreshNotices: (n) => {
    refreshNotices = n;
  },
  /**
   * Re-stamp the snapshot as if it had been generated `ms` ago and push it.
   *
   * The renderer derives staleness from `Snapshot.generatedAt` and a local
   * clock — deliberately, so a main process that stops pushing degrades
   * visibly instead of freezing a confident number on screen. That means the
   * only way to exercise the aging/stale marker is to hand it an old stamp,
   * which is exactly what a wedged collector looks like.
   */
  setGeneratedAgo: (ms) => {
    snapshot.generatedAt = new Date(Date.now() - ms).toISOString();
    if (snapshotCb) snapshotCb(JSON.parse(JSON.stringify(snapshot)));
  },
  /** Main owns pinned mode and announces it with an anchor. Mirror that. */
  setMode: (next, source) => {
    mode = next;
    if (anchorCb) anchorCb(anchorPayload(next, source));
  },
  /**
   * Put the whole fixture back, exactly as the suite found it.
   *
   * `setEmpty()` and `setEnabledDirect()` are one-way: they leave
   * `snapshot.providers` empty or all-disabled, so any section running AFTER
   * them has no row to act on. `setOrderDirect` cannot undo that — it maps ids
   * onto the providers that are still there, and there are none.
   */
  /**
   * Main's pending state (Snapshot.pendingUsage): the tools whose first local
   * usage scan has not answered. `patches` reshapes those rows the way a real
   * pending tool looks — no tokens, no cost yet — so "calculating" is tested
   * against the data it replaces, not beside a figure that is already there.
   */
  setPendingDirect: (ids, patches) => {
    snapshot.pendingUsage = Array.isArray(ids) ? ids.slice() : [];
    if (patches) {
      snapshot.providers = snapshot.providers.map((x) =>
        patches[x.id] ? { ...x, ...patches[x.id] } : x,
      );
    }
    snapshot.generatedAt = new Date().toISOString();
    if (snapshotCb) snapshotCb(JSON.parse(JSON.stringify(snapshot)));
  },
  /**
   * Replace the history's price dates, and push. `byProvider` is the
   * `pricesAsOfByProvider` map main sends; {} with a `pricesAsOf` mimics an
   * older main. Pass nothing to put the fixture's own dates back.
   */
  setHistoryPricesDirect: (byProvider, pricesAsOf, usageProviders, floorCauses) => {
    const fresh = usageHistoryFixture();
    snapshot.usageHistory = {
      ...snapshot.usageHistory,
      pricesAsOfByProvider: byProvider === undefined ? fresh.pricesAsOfByProvider : byProvider,
      pricesAsOf: pricesAsOf === undefined ? fresh.pricesAsOf : pricesAsOf,
      usageProviders: usageProviders === undefined ? fresh.usageProviders : usageProviders,
      floorCausesByProvider: floorCauses === undefined ? fresh.floorCausesByProvider : floorCauses,
    };
    snapshot.generatedAt = new Date().toISOString();
    if (snapshotCb) snapshotCb(JSON.parse(JSON.stringify(snapshot)));
  },
  /**
   * Reshape the history for the A3.20 "no data" cases, and push:
   * 'emptyFloor'  the empty month becomes a floor (records in it were unread);
   * 'noPeriods'   no periods at all, with Codex known to be incomplete.
   * Anything else puts the fixture's own history back.
   */
  setHistoryShapeDirect: (name) => {
    const fresh = usageHistoryFixture();
    if (name === 'emptyFloor') {
      fresh.months = fresh.months.map((m, i) => (i === 2 ? { ...m, isFloor: true } : m));
      fresh.incompleteProviders = ['codex'];
    } else if (name === 'noPeriods') {
      fresh.months = [];
      fresh.weeks = [];
      fresh.incompleteProviders = ['codex'];
    }
    snapshot.usageHistory = fresh;
    snapshot.generatedAt = new Date().toISOString();
    if (snapshotCb) snapshotCb(JSON.parse(JSON.stringify(snapshot)));
    return true;
  },
  /**
   * ADR-003 A8: put a provider into a key state, with or without a reading,
   * and push. `patch` is merged onto the row, so a check can drive one state
   * at a time without rebuilding the fixture.
   */
  setKeyDirect: (id, patch) => {
    snapshot.providers = snapshot.providers.map((x) =>
      x.id === id ? { ...x, ...(patch || {}) } : x,
    );
    snapshot.generatedAt = new Date().toISOString();
    if (snapshotCb) snapshotCb(JSON.parse(JSON.stringify(snapshot)));
    return true;
  },
  /**
   * Put the Copilot row into one of the COPILOT_KEY shapes above — the whole
   * row as main builds it, setup offer and `connected` included — and push.
   */
  setCopilotKeyDirect: (name) => {
    const make = COPILOT_KEY[name];
    if (!make) return false;
    snapshot.providers = snapshot.providers.map((x) =>
      x.id === 'copilot' ? { ...x, ...make() } : x,
    );
    snapshot.generatedAt = new Date().toISOString();
    if (snapshotCb) snapshotCb(JSON.parse(JSON.stringify(snapshot)));
    return true;
  },
  /** What the panel asked of the key channels, so a check can prove a control
   *  actually reached main rather than only looking pressed. */
  keyCalls: () => JSON.parse(JSON.stringify(keyCalls)),
  /** Set `usageHistory.incompleteProviders` (ADR-002 A3.20), and push. */
  setHistoryIncompleteDirect: (ids) => {
    snapshot.usageHistory = { ...snapshot.usageHistory, incompleteProviders: Array.isArray(ids) ? ids.slice() : [] };
    snapshot.generatedAt = new Date().toISOString();
    if (snapshotCb) snapshotCb(JSON.parse(JSON.stringify(snapshot)));
  },
  restore: () => {
    snapshot.providers = FIXTURES[which]();
    snapshot.generatedAt = new Date().toISOString();
    if (snapshotCb) snapshotCb(JSON.parse(JSON.stringify(snapshot)));
  },
  /** No providers at all — the OTHER empty panel. */
  setEmpty: () => {
    snapshot.providers = [];
    snapshot.generatedAt = new Date().toISOString();
    if (snapshotCb) snapshotCb(JSON.parse(JSON.stringify(snapshot)));
  },
  /**
   * The usage windows a provider currently reports, so a suite that swaps one
   * out for an unknown-certainty window can put the exact original back rather
   * than rebuild it from a remembered literal.
   */
  windowsOf: (id) => {
    const found = snapshot.providers.find((x) => x.id === id);
    return found ? JSON.parse(JSON.stringify({ fiveHour: found.fiveHour, sevenDay: found.sevenDay })) : null;
  },
  /** Swap a provider's usage windows, without logging a call. */
  setWindowsDirect: (id, windows) => {
    snapshot.providers = snapshot.providers.map((x) =>
      x.id === id ? { ...x, ...windows } : x,
    );
    snapshot.generatedAt = new Date().toISOString();
    if (snapshotCb) snapshotCb(JSON.parse(JSON.stringify(snapshot)));
  },
  /** Swap a provider's weeklyCost for a named fixture cost, and push. */
  setCostDirect: (id, name) => {
    const cost = NAMED_COSTS[name];
    if (!cost) return false;
    snapshot.providers = snapshot.providers.map((x) =>
      x.id === id ? { ...x, weeklyCost: JSON.parse(JSON.stringify(cost)) } : x,
    );
    snapshot.generatedAt = new Date().toISOString();
    if (snapshotCb) snapshotCb(JSON.parse(JSON.stringify(snapshot)));
    return true;
  },
  /** Set `enabled` on the fixture directly, without going through setEnabled. */
  setEnabledDirect: (map) => {
    snapshot.providers = snapshot.providers.map((p) =>
      Object.prototype.hasOwnProperty.call(map, p.id) ? { ...p, enabled: map[p.id] } : p,
    );
    snapshot.generatedAt = new Date().toISOString();
    if (snapshotCb) snapshotCb(JSON.parse(JSON.stringify(snapshot)));
  },
  push: () => {
    snapshot.generatedAt = new Date().toISOString();
    if (snapshotCb) snapshotCb(JSON.parse(JSON.stringify(snapshot)));
  },
});
