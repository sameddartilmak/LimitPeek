'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const history = require('../src/core/history');
const pricing = require('../src/core/pricing');
const { buildSnapshot } = require('../src/core/snapshot');

/**
 * Per-period usage history (src/core/history.js).
 *
 * The boundaries are LOCAL-calendar, so these tests never hard-code a
 * timezone-specific instant. Instead they compute the boundary WITH the module
 * under test and place events relative to it — which is exactly the property
 * that matters: that a record falls in the right bucket for the half-open
 * window, whatever the runner's timezone.
 */

const HOUR = 60 * 60 * 1000;

function ev(over) {
  return {
    f: 'f1',
    ts: 0,
    model: 'claude-opus-5',
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
    cw5: 0,
    cw1h: 0,
    key: 'k',
    ...over,
  };
}

/** A fixed "now": local noon on a Wednesday. Boundaries are derived from it by
 *  the module, so the concrete value only has to be stable, not UTC-aligned. */
const NOW = new Date(2026, 8, 9, 12, 0, 0).getTime(); // 2026-09-09 12:00 local

function weeksBack(ms, n) {
  let t = history.weekStartMs(ms);
  for (let i = 0; i < n; i += 1) {
    const d = new Date(t);
    d.setDate(d.getDate() - 7);
    t = d.getTime();
  }
  return t;
}

test.describe('week boundaries are half-open (start inclusive, end exclusive)', () => {
  test('an event exactly on the Monday boundary belongs to the NEW week', () => {
    const wStart = history.weekStartMs(NOW);
    const atStart = ev({ ts: wStart, key: 'atStart', output: 1000 });
    const justBefore = ev({ ts: wStart - 1, key: 'before', output: 2000 });

    const { weeks } = history.usageHistory([atStart, justBefore], NOW);
    // Two calendar weeks are spanned: the one containing NOW and the previous.
    assert.equal(weeks.length, 2);

    // Newest first. The boundary event is in the current (newest) week; the
    // ms-before event is in the previous one.
    const current = weeks[0];
    const previous = weeks[1];
    assert.equal(current.startsAt, new Date(wStart).toISOString());
    assert.equal(current.hasUsage, true);
    assert.equal(previous.hasUsage, true);

    // The two events carry different token counts, so each bucket's cost is a
    // fingerprint of which event landed in it. The 2000-output event (previous
    // week) costs strictly more than the 1000-output one (current week).
    assert.ok(previous.costUsd > current.costUsd);
  });

  test('every event on one side of the boundary lands in exactly one bucket', () => {
    const wStart = history.weekStartMs(NOW);
    const only = ev({ ts: wStart, key: 'x', output: 1000 });
    const { weeks } = history.usageHistory([only], NOW);
    assert.equal(weeks.length, 1);
    assert.equal(weeks[0].hasUsage, true);
    assert.equal(weeks[0].costUsd, pricing.weeklyCost([only], wStart, history.nextWeekStartMs(wStart), false).totalUsd);
  });
});

test.describe('month boundaries are half-open too', () => {
  test('an event on the 1st-of-month boundary belongs to the NEW month', () => {
    const mStart = history.monthStartMs(NOW);
    const atStart = ev({ ts: mStart, key: 'atStart', output: 1000 });
    const justBefore = ev({ ts: mStart - 1, key: 'before', output: 5000 });

    const { months } = history.usageHistory([atStart, justBefore], NOW);
    assert.ok(months.length >= 2);
    const current = months[0];
    assert.equal(current.startsAt, new Date(mStart).toISOString());
    assert.equal(current.hasUsage, true);
    // The ms-before event is in the previous month, not this one.
    const previous = months[1];
    assert.equal(previous.hasUsage, true);
    assert.ok(previous.costUsd > current.costUsd);
  });
});

test.describe('empty periods are stated honestly, never invented and never dropped', () => {
  test('quiet weeks between the first usage and now are zeros, not gaps', () => {
    const wk0 = history.weekStartMs(NOW);
    const wk3 = weeksBack(NOW, 3);
    const events = [
      ev({ ts: wk3 + HOUR, key: 'old', output: 1000 }),
      ev({ ts: wk0 + HOUR, key: 'new', output: 1000 }),
    ];
    const { weeks } = history.usageHistory(events, NOW);
    // wk-3, wk-2, wk-1, wk-0 => four contiguous buckets, newest first.
    assert.equal(weeks.length, 4);
    assert.equal(weeks[0].hasUsage, true); // current week
    assert.equal(weeks[1].hasUsage, false); // empty
    assert.equal(weeks[2].hasUsage, false); // empty
    assert.equal(weeks[3].hasUsage, true); // three weeks ago

    for (const empty of [weeks[1], weeks[2]]) {
      assert.equal(empty.costUsd, 0);
      assert.equal(empty.unpricedModels.length, 0);
      assert.equal(empty.isFloor, false);
      // The empty period still names its range.
      assert.equal(typeof empty.startsAt, 'string');
      assert.equal(typeof empty.endsAt, 'string');
    }
  });

  test('no events at all yields empty lists, not a fabricated period', () => {
    const h = history.usageHistory([], NOW);
    assert.deepEqual(h.weeks, []);
    assert.deepEqual(h.months, []);
    assert.equal(h.pricesAsOf, pricing.PRICES_AS_OF);
  });
});

test.describe('the honesty constraint: no single merged token total crosses the boundary', () => {
  test('a period carries cost and a per-class split, never a summed token count', () => {
    const wStart = history.weekStartMs(NOW);
    const { weeks } = history.usageHistory(
      [ev({ ts: wStart + HOUR, output: 1000, input: 50, cacheRead: 9_000_000 })],
      NOW,
    );
    const period = weeks[0];
    const keys = Object.keys(period);

    // The forbidden shapes: any single merged token figure.
    for (const banned of ['billable', 'tokens', 'tokensUsed', 'totalTokens']) {
      assert.equal(keys.includes(banned), false, `period must not carry "${banned}"`);
    }

    // What it DOES carry: a cost and a per-class USD split.
    assert.equal(typeof period.costUsd, 'number');
    assert.deepEqual(
      Object.keys(period.byClass).sort(),
      ['cacheRead', 'cacheWrite1h', 'cacheWrite5m', 'input', 'output'],
    );
    // byClass is dollars per class, and carries no merged total of its own.
    assert.equal('billable' in period.byClass, false);
  });
});

test.describe('the per-model breakdown of a period', () => {
  const wStart = history.weekStartMs(NOW);
  const endEx = history.nextWeekStartMs(wStart);
  const at = wStart + HOUR;
  // The notional cost of one model's own events, priced the same way the
  // period is — never hard-coded dollars, so a price-table change moves the
  // expectation with the code.
  const costOf = (events) => pricing.weeklyCost(events, wStart, endEx, false);

  test('groups by model and prices each model exactly as the period is priced', () => {
    const opus = ev({ ts: at, key: 'o1', model: 'claude-opus-5', output: 100000 });
    const sonnet = ev({ ts: at, key: 's1', model: 'claude-sonnet-5', output: 100000 });
    const { weeks } = history.usageHistory([opus, sonnet], NOW);
    const byModel = weeks[0].byModel;

    assert.equal(byModel.length, 2);
    const find = (m) => byModel.find((e) => e.model === m);
    // Each entry's cost is that model's own slice priced through pricing.js.
    assert.equal(find('claude-opus-5').costUsd, costOf([opus]).totalUsd);
    assert.equal(find('claude-sonnet-5').costUsd, costOf([sonnet]).totalUsd);
    // Priced entries partition the period total (rounding aside — here exact).
    assert.equal(
      find('claude-opus-5').costUsd + find('claude-sonnet-5').costUsd,
      weeks[0].costUsd,
    );
  });

  test('is sorted largest priced cost first, unpriced models last', () => {
    const opus = ev({ ts: at, key: 'o1', model: 'claude-opus-5', output: 100000 }); // 25/M out
    const sonnet = ev({ ts: at, key: 's1', model: 'claude-sonnet-5', output: 100000 }); // 10/M out
    const haiku = ev({ ts: at, key: 'h1', model: 'claude-haiku-4-5', output: 100000 }); // 5/M out
    const mystery = ev({ ts: at, key: 'm1', model: 'mystery-model-9', output: 100000 });
    const { weeks } = history.usageHistory([haiku, mystery, sonnet, opus], NOW);
    const order = weeks[0].byModel.map((e) => e.model);
    assert.deepEqual(order, [
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-haiku-4-5',
      'mystery-model-9', // unpriced, always last
    ]);
    // Descending by cost among the priced ones.
    const priced = weeks[0].byModel.filter((e) => e.costUsd !== null);
    for (let i = 1; i < priced.length; i += 1) {
      assert.ok(priced[i - 1].costUsd >= priced[i].costUsd);
    }
  });

  test('a model with no published price is null, never $0 — the "fiyatlanamadı" signal', () => {
    const mystery = ev({ ts: at, key: 'm1', model: 'mystery-model-9', output: 100000 });
    const { weeks } = history.usageHistory([mystery], NOW);
    const entry = weeks[0].byModel.find((e) => e.model === 'mystery-model-9');
    assert.equal(entry.costUsd, null); // NOT 0
    // The period total excluded it, and the period is a floor because of it.
    assert.equal(weeks[0].costUsd, 0);
    assert.equal(weeks[0].isFloor, true);
  });

  test('a model whose cache write has no TTL split is its own floor (1.25x, not up to 2x)', () => {
    const opus = ev({ ts: at, key: 'o1', model: 'claude-opus-5', cacheWrite: 10000, cw5: 0, cw1h: 0 });
    const { weeks } = history.usageHistory([opus], NOW);
    const entry = weeks[0].byModel.find((e) => e.model === 'claude-opus-5');
    assert.equal(entry.isFloor, true);
    assert.ok(entry.costUsd > 0);
  });

  test('a model priced at one speed and unpriced at another is a floor, with the priced portion as cost', () => {
    // claude-opus-4-8 is priced at standard, but has NO fast row (ADR-002).
    const std = ev({ ts: at, key: 'a', model: 'claude-opus-4-8', speed: 'standard', output: 100000 });
    const fast = ev({ ts: at, key: 'b', model: 'claude-opus-4-8', speed: 'fast', output: 100000 });
    const { weeks } = history.usageHistory([std, fast], NOW);
    // One entry: grouping is by MODEL, so the two speeds fold together.
    const entry = weeks[0].byModel.find((e) => e.model === 'claude-opus-4-8');
    assert.ok(entry);
    // Cost is the PRICED (standard) portion only; the fast portion is excluded.
    assert.equal(entry.costUsd, costOf([std]).totalUsd);
    assert.equal(entry.isFloor, true); // a lower bound: fast usage was excluded
  });

  test('a fully-priced model is not framed as a floor', () => {
    const opus = ev({ ts: at, key: 'o1', model: 'claude-opus-5', output: 100000, cacheWrite: 4000, cw5: 4000, cw1h: 0 });
    const { weeks } = history.usageHistory([opus], NOW);
    const entry = weeks[0].byModel.find((e) => e.model === 'claude-opus-5');
    assert.equal(entry.isFloor, false);
    assert.ok(entry.costUsd > 0);
  });

  test('honesty invariant: a per-model entry carries a per-class breakdown, never a merged token total', () => {
    const opus = ev({ ts: at, key: 'o1', model: 'claude-opus-5', output: 1000, input: 50, cacheRead: 9_000_000 });
    const { weeks } = history.usageHistory([opus], NOW);
    const entry = weeks[0].byModel[0];
    // Exactly the four honest fields plus the per-class token breakdown.
    assert.deepEqual(Object.keys(entry).sort(), ['costUsd', 'isFloor', 'model', 'provider', 'tokens']);
    // No scalar "tokens used" anywhere on the entry, at either level.
    for (const banned of ['billable', 'tokensUsed', 'totalTokens', 'byClass', 'total']) {
      assert.equal(banned in entry, false, `per-model entry must not carry "${banned}"`);
    }
    // The breakdown is the five declared classes and nothing else.
    assert.deepEqual(Object.keys(entry.tokens).sort(), ['billable', 'cacheRead', 'cacheWrite', 'input', 'output']);
    assert.deepEqual(entry.tokens, {
      input: 50, output: 1000, cacheWrite: 0, cacheRead: 9_000_000, billable: 1050,
    });
    // The whole point of the ban: cacheRead is 99.99% of this event's raw
    // volume and is NOT in `billable`. A merged total would read 9,001,050.
    assert.equal(entry.tokens.billable, entry.tokens.input + entry.tokens.output + entry.tokens.cacheWrite);
    assert.ok(entry.tokens.cacheRead > entry.tokens.billable * 1000);
  });

  test('an empty period carries an empty byModel, not a fabricated row', () => {
    const wk0 = history.weekStartMs(NOW);
    const wk2 = weeksBack(NOW, 2);
    const { weeks } = history.usageHistory(
      [ev({ ts: wk2 + HOUR, key: 'old', output: 1000 }), ev({ ts: wk0 + HOUR, key: 'new', output: 1000 })],
      NOW,
    );
    // weeks[1] is the quiet week between the two.
    assert.equal(weeks[1].hasUsage, false);
    assert.deepEqual(weeks[1].byModel, []);
  });

  test('the same corpus reflects in months as in weeks (this machine: all data is this week)', () => {
    // Mirrors the note on the real data: with everything in the current week,
    // week and month buckets summarise the same events, so the per-model split
    // matches. claude-opus-5 dominates, exactly as on the reference machine.
    const events = [
      ev({ ts: at, key: 'o1', model: 'claude-opus-5', output: 500000 }),
      ev({ ts: at, key: 's1', model: 'claude-sonnet-5', output: 100000 }),
    ];
    const { weeks, months } = history.usageHistory(events, NOW);
    assert.equal(weeks[0].byModel[0].model, 'claude-opus-5');
    assert.deepEqual(
      weeks[0].byModel.map((e) => [e.model, e.costUsd]),
      months[0].byModel.map((e) => [e.model, e.costUsd]),
    );
  });
});

test.describe('the cost figure is framed as a floor exactly when it is one', () => {
  test('a fully-priced period is not a floor', () => {
    const wStart = history.weekStartMs(NOW);
    const { weeks } = history.usageHistory([ev({ ts: wStart + HOUR, output: 1000 })], NOW);
    assert.equal(weeks[0].isFloor, false);
    assert.ok(weeks[0].costUsd > 0);
  });

  test('an unpriced model makes the period a floor and names the model, cost excluded', () => {
    const wStart = history.weekStartMs(NOW);
    const { weeks } = history.usageHistory(
      [ev({ ts: wStart + HOUR, model: 'some-unknown-model', output: 1000 })],
      NOW,
    );
    const period = weeks[0];
    assert.equal(period.hasUsage, true); // usage happened
    assert.equal(period.costUsd, 0); // but none of it could be priced
    assert.equal(period.isFloor, true);
    assert.ok(period.unpricedModels.includes('some-unknown-model'));
  });

  test('a cache write with no TTL split is a floor (charged at 1.25x, not up to 2x)', () => {
    const wStart = history.weekStartMs(NOW);
    // cacheWrite present, but cw5/cw1h do not sum to it => fallback path.
    const { weeks } = history.usageHistory(
      [ev({ ts: wStart + HOUR, cacheWrite: 10000, cw5: 0, cw1h: 0 })],
      NOW,
    );
    assert.equal(weeks[0].isFloor, true);
    assert.ok(weeks[0].costUsd > 0);
  });
});

test.describe('ordering and caps', () => {
  test('periods are newest first', () => {
    const wk0 = history.weekStartMs(NOW);
    const wk2 = weeksBack(NOW, 2);
    const { weeks } = history.usageHistory(
      [ev({ ts: wk2 + HOUR, output: 10 }), ev({ ts: wk0 + HOUR, output: 10 })],
      NOW,
    );
    for (let i = 1; i < weeks.length; i += 1) {
      assert.ok(
        Date.parse(weeks[i - 1].startsAt) > Date.parse(weeks[i].startsAt),
        'weeks must descend in time',
      );
    }
  });

  test('only the most recent maxWeeks buckets are kept', () => {
    const wk0 = history.weekStartMs(NOW);
    const wkFar = weeksBack(NOW, 30);
    const { weeks } = history.usageHistory(
      [ev({ ts: wkFar + HOUR, output: 10 }), ev({ ts: wk0 + HOUR, output: 10 })],
      NOW,
      { maxWeeks: 5 },
    );
    assert.equal(weeks.length, 5);
    // The newest kept bucket is the current week.
    assert.equal(weeks[0].startsAt, new Date(wk0).toISOString());
  });
});

test('the endsAt is the inclusive last day of the period, not the exclusive boundary', () => {
  const wStart = history.weekStartMs(NOW);
  const { weeks } = history.usageHistory([ev({ ts: wStart + HOUR, output: 10 })], NOW);
  const end = new Date(weeks[0].endsAt);
  const start = new Date(weeks[0].startsAt);
  // A Mon–Sun week: the inclusive end is 6 days after the Monday start (Sunday),
  // never the next Monday.
  const spanDays = Math.round((end.getTime() - start.getTime()) / (24 * HOUR));
  assert.equal(spanDays, 6);
});

test('buildSnapshot attaches a usageHistory built from the deduped corpus', () => {
  const wStart = history.weekStartMs(NOW);
  const snap = buildSnapshot({
    now: NOW,
    events: [
      ev({ ts: wStart + HOUR, key: 'a', output: 1000 }),
      // A replayed duplicate (same key): dedup must keep the history honest.
      ev({ ts: wStart + HOUR, key: 'a', output: 1000 }),
    ],
    rateLimits: { state: 'missing', fiveHour: null, sevenDay: null },
    scanOk: true,
  });
  assert.ok(snap.usageHistory, 'snapshot carries usageHistory');
  assert.ok(Array.isArray(snap.usageHistory.weeks));
  assert.ok(Array.isArray(snap.usageHistory.months));
  assert.equal(snap.usageHistory.pricesAsOf, pricing.PRICES_AS_OF);

  // The duplicate did not double the cost: same as a single event priced once.
  const single = pricing.weeklyCost(
    [ev({ ts: wStart + HOUR, key: 'a', output: 1000 })],
    wStart,
    history.nextWeekStartMs(wStart),
    false,
  ).totalUsd;
  assert.equal(snap.usageHistory.weeks[0].costUsd, single);
});

test('loadingSnapshot reports null history — "not looked yet" is not "used nothing"', () => {
  const { loadingSnapshot } = require('../src/core/snapshot');
  assert.equal(loadingSnapshot(NOW).usageHistory, null);
});

/* ------------------------------------------------ Claude and Codex, one list */

test.describe('a period covers Claude Code and Codex together', () => {
  const codexPricing = require('../src/core/codex/pricing');
  const wStart = history.weekStartMs(NOW);
  const endEx = history.nextWeekStartMs(wStart);
  const at = wStart + HOUR;
  const r6 = (x) => Math.round(x * 1e6) / 1e6;

  /** A Codex turn delta, the shape codex/usage.js emits. */
  function cx(over) {
    return { ts: at, model: 'gpt-5.6-sol', tier: 'standard', inputUncached: 0, cachedInput: 0, cacheWrite: 0, output: 0, ...over };
  }

  test('costUsd is the sum of both tools, each priced by its own table', () => {
    const claude = [ev({ ts: at, key: 'o1', model: 'claude-opus-5', output: 100000 })];
    const codex = [cx({ output: 100000, inputUncached: 50000, cacheWrite: 1000, cachedInput: 200000 })];
    const { weeks } = history.usageHistory(claude, NOW, { codexEvents: codex });
    const claudeUsd = pricing.weeklyCost(claude, wStart, endEx, false).totalUsd;
    const codexUsd = codexPricing.codexCost(codex, wStart, endEx, false).totalUsd;
    assert.ok(claudeUsd > 0 && codexUsd > 0);
    assert.equal(weeks[0].costUsd, r6(claudeUsd + codexUsd));
    assert.equal(weeks[0].hasUsage, true);
    assert.equal(weeks[0].isFloor, false, 'both sides fully priced: not a floor');
  });

  test('every per-model entry names its provider, and both tools share one order', () => {
    const claude = [
      ev({ ts: at, key: 'o1', model: 'claude-opus-5', output: 100000 }),
      ev({ ts: at, key: 'h1', model: 'claude-haiku-4-5', output: 1000 }),
    ];
    const codex = [cx({ output: 200000 })];
    const { weeks } = history.usageHistory(claude, NOW, { codexEvents: codex });
    const byModel = weeks[0].byModel;
    assert.deepEqual(byModel.map((e) => e.provider).sort(), ['claude', 'claude', 'codex']);
    for (const entry of byModel) {
      assert.deepEqual(Object.keys(entry).sort(), ['costUsd', 'isFloor', 'model', 'provider', 'tokens']);
    }
    for (let i = 1; i < byModel.length; i += 1) {
      assert.ok(byModel[i - 1].costUsd >= byModel[i].costUsd, 'largest priced cost first across both tools');
    }
    const codexEntry = byModel.find((e) => e.provider === 'codex');
    assert.equal(codexEntry.model, 'gpt-5.6-sol');
    assert.equal(codexEntry.costUsd, codexPricing.codexCost(codex, wStart, endEx, false).totalUsd);
  });

  test('an unpriced Codex model is null (never $0), sorts last, and makes the period a floor', () => {
    const claude = [ev({ ts: at, key: 'o1', model: 'claude-opus-5', output: 100000 })];
    const codex = [cx({ model: 'gpt-9-imaginary', output: 1000000 })];
    const { weeks } = history.usageHistory(claude, NOW, { codexEvents: codex });
    const period = weeks[0];
    const entry = period.byModel.find((e) => e.model === 'gpt-9-imaginary');
    assert.equal(entry.provider, 'codex');
    assert.equal(entry.costUsd, null);
    assert.equal(period.byModel[period.byModel.length - 1], entry, 'unpriced last');
    assert.equal(period.isFloor, true, 'Codex usage was excluded, so the total is a lower bound');
    assert.deepEqual(period.unpricedModels, ['gpt-9-imaginary']);
    assert.equal(period.costUsd, pricing.weeklyCost(claude, wStart, endEx, false).totalUsd, 'nothing added for it');
  });

  test('a Claude-side floor still floors a period that also has priced Codex usage', () => {
    // No TTL split on the cache write: priced at 1.25x, a floor (ADR-002 rule 1).
    const claude = [ev({ ts: at, key: 'o1', model: 'claude-opus-5', cacheWrite: 10000, cw5: 0, cw1h: 0 })];
    const codex = [cx({ output: 100000 })];
    const { weeks } = history.usageHistory(claude, NOW, { codexEvents: codex });
    assert.equal(weeks[0].isFloor, true);
    assert.equal(weeks[0].byModel.find((e) => e.provider === 'codex').isFloor, false);
  });

  test('a Codex-only period has usage, a figure and a Codex price date', () => {
    const out = history.usageHistory([], NOW, { codexEvents: [cx({ output: 100000 })] });
    assert.equal(out.weeks.length, 1);
    assert.equal(out.weeks[0].hasUsage, true);
    assert.ok(out.weeks[0].costUsd > 0);
    // Only the tables that priced something are named (A3 review F10); the
    // compatibility field still carries Claude's date.
    assert.deepEqual(out.pricesAsOfByProvider, { codex: codexPricing.PRICES_AS_OF });
    assert.equal(out.pricesAsOf, pricing.PRICES_AS_OF, 'pricesAsOf keeps meaning the Claude table');
  });

  test('without Codex usage there is no Codex price date to state', () => {
    const out = history.usageHistory([ev({ ts: at, output: 1000 })], NOW);
    assert.deepEqual(out.pricesAsOfByProvider, { claude: pricing.PRICES_AS_OF });
  });

  test('with no usage at all no price date is stated, but pricesAsOf stays for compatibility', () => {
    const out = history.usageHistory([], NOW, { codexEvents: [] });
    assert.deepEqual(out.pricesAsOfByProvider, {});
    assert.equal(out.pricesAsOf, pricing.PRICES_AS_OF);
  });

  test('byClass adds dollars per class across tools; no token figure appears on the period', () => {
    const claude = [ev({ ts: at, key: 'o1', model: 'claude-opus-5', output: 100000 })];
    const codex = [cx({ output: 100000, cacheWrite: 1000, cachedInput: 200000 })];
    const { weeks } = history.usageHistory(claude, NOW, { codexEvents: codex });
    const c1 = pricing.weeklyCost(claude, wStart, endEx, false).byClass;
    const c2 = codexPricing.codexCost(codex, wStart, endEx, false).byClass;
    for (const k of Object.keys(c1)) {
      assert.equal(weeks[0].byClass[k], r6(c1[k] + c2[k]), k);
    }
    for (const banned of ['billable', 'tokens', 'tokensUsed', 'totalTokens']) {
      assert.equal(banned in weeks[0], false);
    }
  });

  test('historyStartMs is exactly the older of the oldest kept month and the oldest kept week', () => {
    const oldestMonth = new Date(history.monthStartMs(NOW));
    oldestMonth.setMonth(oldestMonth.getMonth() - (history.DEFAULT_MAX_MONTHS - 1));
    const oldestWeek = weeksBack(NOW, history.DEFAULT_MAX_WEEKS - 1);
    assert.equal(history.historyStartMs(NOW), Math.min(oldestMonth.getTime(), oldestWeek));
  });

  test('buildSnapshot feeds the scanned Codex events into the history', () => {
    const snap = buildSnapshot({
      now: NOW,
      events: [],
      rateLimits: { state: 'missing', fiveHour: null, sevenDay: null },
      codexEvents: [cx({ output: 100000 })],
      scanOk: true,
    });
    const week = snap.usageHistory.weeks[0];
    assert.ok(week.byModel.some((e) => e.provider === 'codex' && e.model === 'gpt-5.6-sol'));
    assert.equal(snap.usageHistory.pricesAsOfByProvider.codex, codexPricing.PRICES_AS_OF);
  });
});

test('the Codex weekly cost is anchored to the Codex seven-day reset while it is ahead, trailing otherwise', () => {
  const at = NOW - 2 * HOUR;
  const codexEvents = [{ ts: at, model: 'gpt-5.6-sol', tier: 'standard', inputUncached: 1000, cachedInput: 0, cacheWrite: 1000, output: 100 }];
  const base = { now: NOW, events: [], rateLimits: { state: 'missing', fiveHour: null, sevenDay: null }, codexEvents, scanOk: true };
  const resetsAtMs = NOW + 3 * 24 * HOUR;
  const anchored = buildSnapshot({
    ...base,
    codexRateLimits: { state: 'fresh', capturedAtMs: NOW - 60000, fiveHour: null, sevenDay: { usedPercentage: 10, resetsAtMs } },
  }).providers.find((p) => p.id === 'codex').weeklyCost;
  assert.equal(anchored.windowAnchored, true);
  assert.equal(anchored.windowEnd, new Date(resetsAtMs).toISOString());
  assert.equal(anchored.windowStart, new Date(resetsAtMs - 7 * 24 * HOUR).toISOString());

  const trailing = buildSnapshot({
    ...base,
    codexRateLimits: { state: 'fresh', capturedAtMs: NOW - 60000, fiveHour: null, sevenDay: { usedPercentage: 10, resetsAtMs: NOW - HOUR } },
  }).providers.find((p) => p.id === 'codex').weeklyCost;
  assert.equal(trailing.windowAnchored, false, 'a reset already passed does not anchor');
  assert.equal(trailing.windowEnd, new Date(NOW).toISOString());
});

test('the Codex row tokens use the Codex five-hour reset window while it is ahead, trailing 5h otherwise', () => {
  const ev = (ts, input) => ({ ts, model: 'gpt-5.6-sol', tier: 'standard', inputUncached: input, cachedInput: 0, cacheWrite: 0, output: 0 });
  // Reset in 1h: the window is [now-4h, now+1h). A turn 4.5h ago is OUTSIDE it
  // although it is inside a trailing 5h.
  const codexEvents = [ev(NOW - 4.5 * HOUR, 7), ev(NOW - 3 * HOUR, 100)];
  const base = { now: NOW, events: [], rateLimits: { state: 'missing', fiveHour: null, sevenDay: null }, codexEvents, scanOk: true };
  const rl = (resetsAtMs) => ({ state: 'fresh', capturedAtMs: NOW - 60000, fiveHour: { usedPercentage: 5, resetsAtMs }, sevenDay: null });
  const tokensWith = (limits) => buildSnapshot({ ...base, codexRateLimits: limits }).providers.find((p) => p.id === 'codex').tokens;

  assert.equal(tokensWith(rl(NOW + HOUR)).input, 100, 'anchored: the 4.5h-old turn belongs to the previous window');
  assert.equal(tokensWith(rl(NOW - HOUR)).input, 107, 'a passed reset does not anchor: trailing 5h');
  assert.equal(tokensWith(undefined).input, 107, 'no rate limits: trailing 5h');
});

/* ------------------------------------------- tokens per period, per tool ---- */

/**
 * `PeriodUsage.tokensByProvider` and `PeriodModelCost.tokens`.
 *
 * The rule these pin is the one the module header states: token counts are
 * emitted per tool and per class, NEVER merged. Dollars cross tools; tokens do
 * not. And a count must be folded from the same events its neighbouring
 * `costUsd` was priced from, so the two can never disagree.
 */
test.describe('per-period token counts stay per tool and per class', () => {
  const codexPricing = require('../src/core/codex/pricing');
  const wStart = history.weekStartMs(NOW);
  const endEx = history.nextWeekStartMs(wStart);
  const at = wStart + HOUR;
  const cx = (over) => ({ ts: at, model: 'gpt-5.6-sol', tier: 'standard', inputUncached: 0, cachedInput: 0, cacheWrite: 0, output: 0, ...over });
  const qw = (over) => ({ ts: at, model: 'qwen3-coder-plus', tier: 0, input: 0, cached: 0, output: 0, ...over });
  const km = (over) => ({ ts: at, model: 'kimi-code/k2', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...over });

  test('two tools in one period keep two entries and are never added together', () => {
    const claude = [ev({ ts: at, key: 'o1', model: 'claude-opus-5', output: 1000, cacheRead: 50 })];
    const codex = [cx({ output: 7, inputUncached: 3, cachedInput: 900 })];
    const { weeks } = history.usageHistory(claude, NOW, { codexEvents: codex });
    const period = weeks[0];
    assert.deepEqual(Object.keys(period.tokensByProvider).sort(), ['claude', 'codex']);
    assert.equal(period.tokensByProvider.claude.billable, 1000);
    assert.equal(period.tokensByProvider.claude.cacheRead, 50);
    assert.equal(period.tokensByProvider.codex.billable, 10);
    assert.equal(period.tokensByProvider.codex.cacheRead, 900);
    // Dollars DO combine across tools; tokens must not, so no field anywhere on
    // the period equals the merged count.
    const merged = 1000 + 10;
    for (const [k, v] of Object.entries(period)) {
      assert.notEqual(v, merged, `period.${k} must not be a merged token total`);
    }
    assert.ok(period.costUsd > 0, 'the dollars, by contrast, are one figure');
  });

  test('a tool with no usage in the period has no entry at all', () => {
    const { weeks } = history.usageHistory([ev({ ts: at, key: 'o1', output: 1000 })], NOW);
    assert.deepEqual(Object.keys(weeks[0].tokensByProvider), ['claude']);
  });

  test('an empty period carries an empty map, not a fabricated zero for every tool', () => {
    const wk2 = weeksBack(NOW, 2);
    const { weeks } = history.usageHistory(
      [ev({ ts: wk2 + HOUR, key: 'old', output: 1000 }), ev({ ts: wStart + HOUR, key: 'new', output: 1000 })],
      NOW,
    );
    assert.equal(weeks[1].hasUsage, false);
    assert.deepEqual(weeks[1].tokensByProvider, {});
  });

  test('all four tools each get their own entry, and cacheRead never enters billable', () => {
    const { weeks } = history.usageHistory([ev({ ts: at, key: 'o1', output: 11, cacheRead: 9000000 })], NOW, {
      codexEvents: [cx({ output: 22, cachedInput: 8000000 })],
      qwenEvents: [qw({ output: 33, cached: 7000000 })],
      kimiEvents: [km({ output: 44, cacheRead: 6000000 })],
    });
    const t = weeks[0].tokensByProvider;
    assert.deepEqual(Object.keys(t).sort(), ['claude', 'codex', 'kimi', 'qwen']);
    assert.deepEqual([t.claude.billable, t.codex.billable, t.qwen.billable, t.kimi.billable], [11, 22, 33, 44]);
    assert.deepEqual(
      [t.claude.cacheRead, t.codex.cacheRead, t.qwen.cacheRead, t.kimi.cacheRead],
      [9000000, 8000000, 7000000, 6000000],
      'reported per tool, and out of every billable above',
    );
  });

  test('a tool entry equals the sum of that tool own byModel entries, and only those', () => {
    const claude = [
      ev({ ts: at, key: 'o1', model: 'claude-opus-5', output: 1000, input: 5, cacheWrite: 2, cacheRead: 700 }),
      ev({ ts: at, key: 's1', model: 'claude-sonnet-5', output: 200, input: 1, cacheRead: 30 }),
    ];
    const codex = [cx({ output: 9, cachedInput: 4 })];
    const { weeks } = history.usageHistory(claude, NOW, { codexEvents: codex });
    const period = weeks[0];
    for (const provider of ['claude', 'codex']) {
      const rows = period.byModel.filter((e) => e.provider === provider);
      const summed = rows.reduce((acc, e) => ({
        input: acc.input + e.tokens.input,
        output: acc.output + e.tokens.output,
        cacheWrite: acc.cacheWrite + e.tokens.cacheWrite,
        cacheRead: acc.cacheRead + e.tokens.cacheRead,
        billable: acc.billable + e.tokens.billable,
      }), { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, billable: 0 });
      assert.deepEqual(summed, period.tokensByProvider[provider], provider);
    }
  });

  test('an entry tokens are the events behind its own costUsd — same window, same model', () => {
    const inWindow = ev({ ts: at, key: 'in', model: 'claude-opus-5', output: 1000, input: 5, cacheWrite: 2, cacheRead: 700 });
    const before = ev({ ts: wStart - 1, key: 'before', model: 'claude-opus-5', output: 999999 });
    const { weeks } = history.usageHistory([inWindow, before], NOW);
    const entry = weeks[0].byModel.find((e) => e.model === 'claude-opus-5');
    // The reference figures come straight from the pricer over the same window.
    const priced = pricing.weeklyCost([inWindow, before], wStart, endEx, false);
    assert.equal(entry.costUsd, priced.totalUsd);
    assert.deepEqual(entry.tokens, priced.byModel[0].tokens, 'same events as the cost beside it');
    assert.equal(entry.tokens.output, 1000, 'the ms-before event is in neither figure');
  });

  test('an unpriced model has costUsd null and a real token count — usage is a fact, price is not', () => {
    const claude = [ev({ ts: at, key: 'o1', model: 'claude-opus-5', output: 1000 })];
    const codex = [cx({ model: 'gpt-9-imaginary', output: 1234, inputUncached: 6, cachedInput: 500 })];
    const { weeks } = history.usageHistory(claude, NOW, { codexEvents: codex });
    const entry = weeks[0].byModel.find((e) => e.model === 'gpt-9-imaginary');
    assert.equal(entry.costUsd, null, 'never $0,00 for "we have no price"');
    assert.equal(entry.tokens.billable, 1240);
    assert.equal(entry.tokens.cacheRead, 500);
    // ...and the unpriced tokens are still in that tool subtotal.
    assert.equal(weeks[0].tokensByProvider.codex.billable, 1240);
  });

  test('Kimi is unpriced end to end and still reports every token it saw', () => {
    const { weeks } = history.usageHistory([], NOW, {
      kimiEvents: [km({ input: 1200, output: 300, cacheRead: 5000, cacheWrite: 100 })],
    });
    const period = weeks[0];
    assert.equal(period.costUsd, 0, 'no dollars anywhere');
    const entry = period.byModel.find((e) => e.provider === 'kimi');
    assert.equal(entry.costUsd, null);
    assert.equal(entry.tokens.billable, 1600);
    assert.deepEqual(period.tokensByProvider.kimi, entry.tokens);
  });

  test('half-open at both period ends, exactly as the cost is', () => {
    const events = [
      ev({ ts: wStart - 1, key: 'prev', output: 3 }),
      ev({ ts: wStart, key: 'atStart', output: 5 }),
      ev({ ts: endEx - 1, key: 'lastMs', output: 7 }),
    ];
    // `now` has to be inside the period for its bucket to exist, so read the
    // history at the period's last millisecond.
    const { weeks } = history.usageHistory(events, endEx - 1);
    assert.equal(weeks[0].tokensByProvider.claude.output, 12, 'start inclusive, end exclusive');
    assert.equal(weeks[1].tokensByProvider.claude.output, 3, 'the ms before belongs to the previous week');
  });

  test('the months list carries the same per-tool shape as the weeks list', () => {
    const { months } = history.usageHistory([ev({ ts: at, key: 'o1', output: 1000 })], NOW, {
      codexEvents: [cx({ output: 7 })],
    });
    assert.deepEqual(Object.keys(months[0].tokensByProvider).sort(), ['claude', 'codex']);
    assert.equal(months[0].tokensByProvider.codex.billable, 7);
  });

  test('a Codex tier that cannot be priced still contributes its tokens to the subtotal', () => {
    const codex = [
      cx({ output: 100 }),
      cx({ tier: 'ultrafast', output: 50 }), // no published row for that tier
    ];
    const { weeks } = history.usageHistory([], NOW, { codexEvents: codex });
    const period = weeks[0];
    assert.equal(period.tokensByProvider.codex.billable, 150, 'both turns counted');
    const entry = period.byModel.find((e) => e.provider === 'codex');
    assert.equal(entry.isFloor, true, 'part of the model was excluded from the price');
    assert.equal(entry.tokens.billable, 150, 'but not from the count');
    assert.equal(entry.costUsd, codexPricing.codexCost(codex, wStart, endEx, false).totalUsd);
  });
});

/**
 * `PeriodUsage.tokenFloorCausesByProvider`.
 *
 * Narrower than `isFloor` on purpose: `isFloor` answers the money question, and
 * a period can be a cost floor with every token count exact. What sets this is
 * source behaviour only — the recorder did not record, or the reader could not
 * read.
 */
test.describe('tokenFloorCausesByProvider marks missing counts, with causes, not missing prices', () => {
  const wStart = history.weekStartMs(NOW);
  const at = wStart + HOUR;
  const cx = (over) => ({ ts: at, model: 'gpt-5.6-sol', tier: 'standard', inputUncached: 0, cachedInput: 0, cacheWrite: 0, output: 0, ...over });
  const qw = (over) => ({ ts: at, model: 'qwen3-coder-plus', tier: 0, input: 0, cached: 0, output: 0, ...over });
  const km = (over) => ({ ts: at, model: 'kimi-code/k2', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...over });

  test('a fully read, fully priced Claude week marks nothing', () => {
    const { weeks } = history.usageHistory([ev({ ts: at, key: 'o1', output: 1000 })], NOW);
    assert.deepEqual(weeks[0].tokenFloorCausesByProvider, {});
    assert.equal(weeks[0].isFloor, false);
  });

  test('an unpriced model makes the period a cost floor and leaves every count exact', () => {
    const { weeks } = history.usageHistory([ev({ ts: at, key: 'x', model: 'claude-not-real', output: 1000 })], NOW);
    assert.equal(weeks[0].isFloor, true, 'the DOLLARS are a lower bound');
    assert.deepEqual(weeks[0].tokenFloorCausesByProvider, {}, 'the TOKENS are not');
    assert.equal(weeks[0].tokensByProvider.claude.output, 1000);
  });

  test('Qwen is marked whenever it has usage, priced or not', () => {
    const priced = history.usageHistory([], NOW, { qwenEvents: [qw({ output: 100 })] });
    assert.deepEqual(priced.weeks[0].tokenFloorCausesByProvider, { qwen: ['unrecorded-calls'] });
    // Nothing priced: floorCausesByProvider carries no 'unrecorded-calls', and
    // the mark must not be derived from it.
    const unpriced = history.usageHistory([], NOW, {
      qwenEvents: [qw({ model: 'glm-5', output: 100 })],
    });
    assert.equal((unpriced.floorCausesByProvider.qwen || []).includes('unrecorded-calls'), false);
    assert.deepEqual(unpriced.weeks[0].tokenFloorCausesByProvider, { qwen: ['unrecorded-calls'] },
      'the cost note has no cause to lend, so the token side states its own');
  });

  test('Codex is NOT marked on the zero-recorded-write pattern, priced or unpriced (2026-09-23)', () => {
    // An unrecorded write is part of the prompt already counted in input, so
    // the count is not short; only the input/write split is unknown.
    const priced = history.usageHistory([], NOW, { codexEvents: [cx({ output: 10, cachedInput: 5000 })] });
    assert.deepEqual(priced.weeks[0].tokenFloorCausesByProvider, {});
    assert.equal((priced.floorCausesByProvider.codex || []).includes('unrecorded-writes'), false,
      'and no cost cause either: the writes are priced as an upper bound');
    const unpriced = history.usageHistory([], NOW, {
      codexEvents: [cx({ model: 'gpt-9-imaginary', output: 10, cachedInput: 5000 })],
    });
    assert.deepEqual(unpriced.weeks[0].tokenFloorCausesByProvider, {}, 'whatever the price');
  });

  test('a Codex week that recorded its writes is exact', () => {
    const { weeks } = history.usageHistory([], NOW, {
      codexEvents: [cx({ output: 10, inputUncached: 4000, cacheWrite: 2000 })],
    });
    assert.deepEqual(weeks[0].tokenFloorCausesByProvider, {});
  });

  test('a Fast-requested tier is a cost cause and never a token one', () => {
    const { weeks, floorCausesByProvider } = history.usageHistory([], NOW, {
      codexEvents: [cx({ tier: 'fast', output: 10, inputUncached: 8 })],
    });
    assert.deepEqual(floorCausesByProvider.codex, ['fast-requested']);
    assert.equal(weeks[0].isFloor, true);
    assert.deepEqual(weeks[0].tokenFloorCausesByProvider, {});
  });

  test('a known-unread range marks only the tool it belongs to', () => {
    const { weeks } = history.usageHistory([ev({ ts: at, key: 'o1', output: 1000 })], NOW, {
      codexEvents: [cx({ output: 10, inputUncached: 8 })],
      unreadRanges: { claude: [{ fromMs: at, throughMs: at }] },
    });
    assert.deepEqual(weeks[0].tokenFloorCausesByProvider, { claude: ['unread-range'] }, 'Codex read its own week fine');
  });

  test('it is always a subset of the tools that actually have a count', () => {
    // Claude is known-incomplete but has NO usage in the period, so there is no
    // count for "en az" to qualify. The period is still a cost floor, and
    // incompleteProviders still names the gap.
    const { weeks, incompleteProviders } = history.usageHistory([], NOW, {
      codexEvents: [cx({ output: 10, inputUncached: 8 })],
      unreadRanges: { claude: [{ fromMs: at, throughMs: at }] },
    });
    assert.deepEqual(Object.keys(weeks[0].tokensByProvider), ['codex']);
    assert.deepEqual(weeks[0].tokenFloorCausesByProvider, {});
    assert.equal(weeks[0].isFloor, true, 'the period-level floor still says it');
    assert.deepEqual(incompleteProviders, ['claude'], 'and the gap is still named');
  });

  test('an empty period marks nothing', () => {
    const wk2 = weeksBack(NOW, 2);
    const { weeks } = history.usageHistory(
      [ev({ ts: wk2 + HOUR, key: 'old', output: 1000 }), ev({ ts: wStart + HOUR, key: 'new', output: 1000 })],
      NOW,
    );
    assert.equal(weeks[1].hasUsage, false);
    assert.deepEqual(weeks[1].tokenFloorCausesByProvider, {});
  });

  test('several tools marked at once keep the fixed claude, codex, kimi, qwen order', () => {
    // Codex is marked by its own unread range: the zero-write pattern is no
    // longer a token cause (2026-09-23), so the cached-read turn adds nothing.
    const { weeks, usageProviders } = history.usageHistory([ev({ ts: at, key: 'o1', output: 1000 })], NOW, {
      codexEvents: [cx({ output: 10, cachedInput: 5000 })],
      qwenEvents: [qw({ output: 100 })],
      kimiEvents: [km({ output: 5 })],
      unreadRanges: {
        kimi: [{ fromMs: at, throughMs: at }], codex: [{ fromMs: at, throughMs: at }], claude: [{ fromMs: at, throughMs: at }],
      },
    });
    assert.deepEqual(Object.keys(weeks[0].tokenFloorCausesByProvider), ['claude', 'codex', 'kimi', 'qwen']);
    assert.deepEqual(Object.keys(weeks[0].tokenFloorCausesByProvider), usageProviders, 'same order as usageProviders');
    // Each tool states its OWN causes, in HistoryFloorCause order.
    assert.deepEqual(weeks[0].tokenFloorCausesByProvider, {
      claude: ['unread-range'],
      codex: ['unread-range'],
      kimi: ['unread-range'],
      qwen: ['unrecorded-calls'],
    });
  });

  test('the months list carries it too', () => {
    const { months } = history.usageHistory([], NOW, { qwenEvents: [qw({ output: 100 })] });
    assert.deepEqual(months[0].tokenFloorCausesByProvider, { qwen: ['unrecorded-calls'] });
  });
});

/**
 * The row and the period must not disagree about a tool.
 *
 * They compute over different windows on purpose — a quota week versus a local
 * calendar week — but the rule that turns facts into causes is ONE function
 * (`history.tokenFloorCauses`). Nothing else in the suite asserts the two
 * producers agree, so this does: one corpus, placed inside both windows, and the
 * row's `weeklyTokenFloorCauses` compared against the period's
 * `tokenFloorCausesByProvider` entry, tool by tool.
 */
test.describe('the panel row and the history period agree about every tool', () => {
  const wStart = history.weekStartMs(NOW);
  // Monday 01:00 of the current calendar week. NOW is Wednesday noon, so a
  // trailing 7-day quota window also contains it: both sides see this event.
  const at = wStart + HOUR;
  const installed = (events) => ({ installed: true, events, readFailed: false, resultAtMs: NOW, unreadRange: null });

  function bothSides(extra) {
    const snap = buildSnapshot({
      now: NOW, rateLimits: { state: 'missing', fiveHour: null, sevenDay: null }, scanOk: true,
      events: [], codexEvents: [], ...extra,
    });
    const period = snap.usageHistory.weeks[0];
    const out = {};
    for (const id of ['claude', 'codex', 'kimi', 'qwen', 'grok']) {
      const row = snap.providers.find((p) => p.id === id);
      out[id] = {
        row: row.weeklyTokenFloorCauses,
        period: period.tokenFloorCausesByProvider[id] || [],
        counted: row.weeklyTokens !== null && period.tokensByProvider[id] !== undefined,
      };
    }
    return out;
  }

  test('Qwen: both sides say unrecorded-calls, and neither says anything else', () => {
    const sides = bothSides({
      qwen: installed([{ ts: at, model: 'qwen3-coder-plus', tier: 0, input: 500, cached: 0, output: 100 }]),
    });
    assert.equal(sides.qwen.counted, true, 'the fixture has to reach both windows or this proves nothing');
    assert.deepEqual(sides.qwen.row, ['unrecorded-calls']);
    assert.deepEqual(sides.qwen.period, sides.qwen.row);
  });

  test('Codex: neither side says unrecorded-writes off the zero-recorded-write pattern', () => {
    const sides = bothSides({
      codexEvents: [{ ts: at, model: 'gpt-5.6-sol', tier: 'standard', inputUncached: 10, cachedInput: 5000, cacheWrite: 0, output: 20 }],
    });
    assert.equal(sides.codex.counted, true);
    assert.deepEqual(sides.codex.row, []);
    assert.deepEqual(sides.codex.period, sides.codex.row);
  });

  test('Claude: a recorded, fully read week is exact on both sides', () => {
    const sides = bothSides({ events: [ev({ ts: at, key: 'o1', output: 1000 })] });
    assert.equal(sides.claude.counted, true);
    assert.deepEqual(sides.claude.row, []);
    assert.deepEqual(sides.claude.period, []);
  });

  test('Kimi: unpriced end to end, and still exact on both sides', () => {
    const sides = bothSides({
      kimi: installed([{ ts: at, model: 'kimi-code/k2', input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }]),
    });
    assert.equal(sides.kimi.counted, true);
    assert.deepEqual(sides.kimi.row, [], 'no published price is not a missing token');
    assert.deepEqual(sides.kimi.period, []);
  });

  test('Grok: an incomplete turn is partial-usage on both sides; a partial cost alone is on neither', () => {
    const turn = (over) => ({ ts: at, model: 'grok-4.6', input: 100, cacheRead: 0, cacheWrite: 0, output: 50, usd: 0.01, partial: false, incomplete: false, ...over });
    const incomplete = bothSides({ grok: installed([turn({ partial: true, incomplete: true })]) });
    assert.equal(incomplete.grok.counted, true);
    assert.deepEqual(incomplete.grok.row, ['partial-usage']);
    assert.deepEqual(incomplete.grok.period, incomplete.grok.row);
    const costOnly = bothSides({ grok: installed([turn({ partial: true })]) });
    assert.deepEqual(costOnly.grok.row, []);
    assert.deepEqual(costOnly.grok.period, []);
  });

  test('all four at once: every tool matches its own row, and none borrows another tool’s cause', () => {
    const sides = bothSides({
      events: [ev({ ts: at, key: 'o1', output: 1000 })],
      codexEvents: [{ ts: at, model: 'gpt-5.6-sol', tier: 'standard', inputUncached: 10, cachedInput: 5000, cacheWrite: 0, output: 20 }],
      qwen: installed([{ ts: at, model: 'qwen3-coder-plus', tier: 0, input: 500, cached: 0, output: 100 }]),
      kimi: installed([{ ts: at, model: 'kimi-code/k2', input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }]),
    });
    for (const id of ['claude', 'codex', 'kimi', 'qwen']) {
      assert.equal(sides[id].counted, true, id);
      assert.deepEqual(sides[id].period, sides[id].row, `${id}: the two producers disagree`);
    }
    assert.deepEqual(sides.claude.row, []);
    assert.deepEqual(sides.codex.row, []);
    assert.deepEqual(sides.qwen.row, ['unrecorded-calls']);
    assert.deepEqual(sides.kimi.row, []);
  });

  test('the shared rule is one function, and it rejects a monetary cause by construction', () => {
    // There is no input by which a caller could pass "unpriced" or a tier cause
    // in: the function takes three source-behaviour facts and nothing else.
    assert.deepEqual(history.tokenFloorCauses('claude', { hasCount: true, sourceIncomplete: true }), ['unread-range']);
    assert.deepEqual(history.tokenFloorCauses('qwen', { hasCount: true }), ['unrecorded-calls']);
    assert.deepEqual(history.tokenFloorCauses('codex', { hasCount: true, unrecordedWrites: true }), ['unrecorded-writes']);
    assert.deepEqual(history.tokenFloorCauses('claude', { hasCount: true, unrecordedWrites: true }), [],
      'the Codex write pattern is Codex-only');
    assert.deepEqual(history.tokenFloorCauses('qwen', { hasCount: false, sourceIncomplete: true }), [],
      'no amount, no bound — whatever the facts');
    assert.deepEqual(
      history.tokenFloorCauses('codex', { hasCount: true, sourceIncomplete: true, unrecordedWrites: true }),
      ['unread-range', 'unrecorded-writes'],
      'and the order is the one HistoryFloorCause lists',
    );
  });

  test('hasAnyTokens counts a cache-read-only week as a real measurement', () => {
    // `billable` excludes cacheRead, so gating on it would call a week of pure
    // cache reads "no amount" and drop a legitimate floor cause.
    assert.equal(history.hasAnyTokens({ input: 0, output: 0, cacheWrite: 0, cacheRead: 9000, billable: 0 }), true);
    assert.equal(history.hasAnyTokens({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, billable: 0 }), false);
    assert.equal(history.hasAnyTokens(null), false);
  });
});

/**
 * `PeriodModelCost.tokens` is typed nullable so the boundary can say "absent",
 * but main must never actually send that: an entry exists only where usage
 * produced it. The invariant is tested rather than typed.
 */
test('every byModel entry main emits carries a real count, never null', () => {
  const wStart = history.weekStartMs(NOW);
  const at = wStart + HOUR;
  const out = history.usageHistory(
    [
      ev({ ts: at, key: 'o1', model: 'claude-opus-5', output: 1000 }),
      ev({ ts: at, key: 'u1', model: 'claude-not-a-real-model', output: 7 }),
    ],
    NOW,
    {
      codexEvents: [
        { ts: at, model: 'gpt-5.6-sol', tier: 'standard', inputUncached: 10, cachedInput: 0, cacheWrite: 0, output: 20 },
        { ts: at, model: 'gpt-9-imaginary', tier: 'standard', inputUncached: 5, cachedInput: 0, cacheWrite: 0, output: 5 },
      ],
      qwenEvents: [
        { ts: at, model: 'qwen3-coder-plus', tier: 0, input: 10, cached: 0, output: 1 },
        { ts: at, model: 'glm-5', tier: 0, input: 3, cached: 0, output: 1 },
      ],
      kimiEvents: [{ ts: at, model: 'kimi-code/k2', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }],
    },
  );
  let entries = 0;
  let unpriced = 0;
  for (const period of [...out.weeks, ...out.months]) {
    for (const entry of period.byModel) {
      entries += 1;
      if (entry.costUsd === null) unpriced += 1;
      assert.notEqual(entry.tokens, null, `${entry.provider}/${entry.model}: tokens must never be null`);
      assert.deepEqual(
        Object.keys(entry.tokens).sort(),
        ['billable', 'cacheRead', 'cacheWrite', 'input', 'output'],
        `${entry.provider}/${entry.model}`,
      );
      assert.equal(entry.tokens.billable, entry.tokens.input + entry.tokens.output + entry.tokens.cacheWrite);
      assert.ok(
        history.hasAnyTokens(entry.tokens),
        `${entry.provider}/${entry.model}: an entry exists only where usage produced it`,
      );
    }
  }
  assert.ok(entries >= 14, `too few entries to prove anything (${entries})`);
  assert.ok(unpriced >= 6, `the fixture must include unpriced entries, which is where null would hide (${unpriced})`);
});
