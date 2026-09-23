'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const history = require('../src/core/history');

/**
 * THE HALF-OPEN PERIOD BOUNDARY, FOR EVERY TOOL AND FOR THE TOKEN COUNTS.
 *
 * `[start, next period)` is stated in the header of `src/core/history.js` and in
 * the contract for `PeriodUsage.tokensByProvider` and
 * `PeriodModelCost.tokens`: a record on the boundary belongs to the NEW period,
 * and it belongs to EXACTLY ONE. Get it wrong in one direction and an event is
 * counted twice — in the week that ends and the week that starts — which lands
 * on both the money and the token figures; get it wrong in the other and the
 * event vanishes from both.
 *
 * WHY THIS FILE, WHEN history.test.js ALREADY TESTS A BOUNDARY
 * -----------------------------------------------------------
 * It tests ONE: the Claude period TOTAL, fingerprinted by cost. Measured by
 * mutation, four other in-window filters had no test at all — flipping
 * `ev.ts >= endMs` to `> endMs` (or `< startMs` to `<=`) in
 * `codex/pricing.js`, `gemini/pricing.js`, `kimi/cost.js` and in
 * `history.js`'s own `byModelUsageFrom` each left the suite fully green. The
 * last one is the worst of the four: `byModelUsageFrom` feeds the per-model
 * rows while `pricing.weeklyCost` feeds the period total and
 * `tokensByProvider`, so a boundary that differs between them breaks the
 * contract's central pairing claim — that an entry's `tokens` describes exactly
 * the events behind its `costUsd`, over the same window — while every total
 * stays right.
 *
 * Boundaries are LOCAL-calendar, so nothing here hard-codes an instant: the
 * boundary is computed WITH the module under test and events are placed
 * relative to it, exactly as `history.test.js` does.
 */

const HOUR = 60 * 60 * 1000;
/** Local noon on a Wednesday. Only stability matters, not UTC alignment. */
const NOW = new Date(2026, 8, 9, 12, 0, 0).getTime();
const W_START = history.weekStartMs(NOW);

/** A Claude transcript event, the shape `aggregate.dedupe` emits. */
const claudeEv = (over) => ({
  f: 'f1', ts: 0, model: 'claude-opus-5',
  input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cw5: 0, cw1h: 0, key: 'k',
  ...over,
});
/** A Codex per-turn delta, the shape `codex/usage.js` emits. */
const codexEv = (over) => ({
  ts: 0, model: 'gpt-5.6-sol', tier: 'standard',
  inputUncached: 0, cachedInput: 0, cacheWrite: 0, output: 0,
  ...over,
});
/** A Gemini message, the shape `gemini/usage.js` emits. */
const geminiEv = (over) => ({
  ts: 0, model: 'gemini-2.5-pro',
  input: 0, cached: 0, output: 0, thoughts: 0, tool: 0, longPrompt: false,
  ...over,
});
/** A Kimi event, the shape `kimi/usage.js` emits. */
const kimiEv = (over) => ({
  ts: 0, model: 'kimi-code/kimi-for-coding',
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
  ...over,
});

/** The two weeks a boundary pair spans: [newest, previous]. */
function weeksFor(opts) {
  const { weeks } = history.usageHistory(opts.claude || [], NOW, {
    codexEvents: opts.codex || [],
    geminiEvents: opts.gemini || [],
    kimiEvents: opts.kimi || [],
  });
  assert.equal(weeks.length, 2, 'the pair must span exactly two calendar weeks');
  return weeks;
}

const countFor = (period, id) => (period.tokensByProvider || {})[id] || null;

/**
 * One tool, one distinguishable token value per side of the boundary.
 *
 * `onBoundary` carries 1,000 output tokens and `justBefore` carries 2,000, so
 * each week's count is a fingerprint of which event landed in it. Anything that
 * double-counts shows up as 3,000.
 */
function boundaryCase(id, build) {
  test(`${id}: the event ON the boundary is counted in the NEW week only`, () => {
    const weeks = weeksFor(build(1000, 2000));
    const current = countFor(weeks[0], id);
    const previous = countFor(weeks[1], id);
    assert.ok(current, `${id} has no count in the new week`);
    assert.ok(previous, `${id} has no count in the previous week`);
    assert.equal(current.output, 1000, 'the boundary event belongs to the new week');
    assert.equal(previous.output, 2000, 'and only the earlier event to the previous one');
  });

  test(`${id}: neither week counts the other's event — no event is counted twice`, () => {
    const weeks = weeksFor(build(1000, 2000));
    const current = countFor(weeks[0], id);
    const previous = countFor(weeks[1], id);
    assert.equal(current.output + previous.output, 3000, 'the two events, each once');
    assert.notEqual(current.output, 3000, 'the new week swallowed the previous week\'s event');
    assert.notEqual(previous.output, 3000, 'the previous week reached past its exclusive end');
  });

  test(`${id}: the per-model rows describe the same events as the period's own count`, () => {
    // The pairing the contract calls the point. `byModel` and the subtotal are
    // built by different passes, so a boundary that differs between them is
    // invisible in either figure on its own.
    for (const period of weeksFor(build(1000, 2000))) {
      const count = countFor(period, id);
      if (!count) continue;
      const rows = period.byModel.filter((entry) => entry.provider === id);
      assert.ok(rows.length > 0, `${id} has a count but no per-model row`);
      const summed = rows.reduce((n, entry) => n + ((entry.tokens && entry.tokens.output) || 0), 0);
      assert.equal(
        summed,
        count.output,
        `${id}: byModel and tokensByProvider disagree in ${period.key} — one of the two `
        + 'is reading a different window',
      );
    }
  });
}

test.describe('every tool\'s period boundary is half-open', () => {
  boundaryCase('claude', (onBoundary, before) => ({
    claude: [
      claudeEv({ ts: W_START, key: 'on', output: onBoundary }),
      claudeEv({ ts: W_START - 1, key: 'before', output: before }),
    ],
  }));

  boundaryCase('codex', (onBoundary, before) => ({
    codex: [
      codexEv({ ts: W_START, output: onBoundary }),
      codexEv({ ts: W_START - 1, output: before }),
    ],
  }));

  boundaryCase('gemini', (onBoundary, before) => ({
    gemini: [
      geminiEv({ ts: W_START, output: onBoundary }),
      geminiEv({ ts: W_START - 1, output: before }),
    ],
  }));

  boundaryCase('kimi', (onBoundary, before) => ({
    kimi: [
      kimiEv({ ts: W_START, output: onBoundary }),
      kimiEv({ ts: W_START - 1, output: before }),
    ],
  }));
});

test.describe('the boundary holds when all four tools cross it at once', () => {
  const build = () => ({
    claude: [claudeEv({ ts: W_START, key: 'on', output: 1000 }), claudeEv({ ts: W_START - 1, key: 'b', output: 2000 })],
    codex: [codexEv({ ts: W_START, output: 1000 }), codexEv({ ts: W_START - 1, output: 2000 })],
    gemini: [geminiEv({ ts: W_START, output: 1000 }), geminiEv({ ts: W_START - 1, output: 2000 })],
    kimi: [kimiEv({ ts: W_START, output: 1000 }), kimiEv({ ts: W_START - 1, output: 2000 })],
  });

  test('each tool keeps its own count on its own side, and none is merged', () => {
    const weeks = weeksFor(build());
    for (const id of ['claude', 'codex', 'gemini', 'kimi']) {
      assert.equal(countFor(weeks[0], id).output, 1000, `${id}, new week`);
      assert.equal(countFor(weeks[1], id).output, 2000, `${id}, previous week`);
    }
  });

  test('four tools with identical usage produce four separate entries, never one total', () => {
    const period = weeksFor(build())[0];
    assert.deepEqual(
      Object.keys(period.tokensByProvider).sort(),
      ['claude', 'codex', 'gemini', 'kimi'],
      'one entry per tool, and nothing else',
    );
    // 4 x 1000 would be the banned merged figure; no entry may hold it.
    for (const [id, tk] of Object.entries(period.tokensByProvider)) {
      assert.equal(tk.output, 1000, `${id} carries another tool's tokens`);
    }
  });
});

test.describe('the counts a period reports are that period\'s own', () => {
  test('a quiet week between two busy ones counts nothing at all', () => {
    // Half-open in both directions: neighbouring weeks must not bleed in.
    const twoWeeksBack = (() => {
      const d = new Date(W_START);
      d.setDate(d.getDate() - 14);
      return d.getTime();
    })();
    const { weeks } = history.usageHistory(
      [
        claudeEv({ ts: W_START + HOUR, key: 'now', output: 1000 }),
        claudeEv({ ts: twoWeeksBack + HOUR, key: 'old', output: 2000 }),
      ],
      NOW,
      {},
    );
    assert.equal(weeks.length, 3, 'the empty week between is emitted, not omitted');
    const middle = weeks[1];
    assert.equal(middle.hasUsage, false);
    assert.deepEqual(middle.tokensByProvider, {}, 'an empty period states no count at all');
    assert.deepEqual(middle.byModel, []);
  });
});
