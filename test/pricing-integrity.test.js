'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const pricing = require('../src/core/pricing');

/**
 * The arithmetic invariants of `src/core/pricing.js`, and the two seams where
 * the money can go quiet.
 *
 * `pricing.test.js` walks the price table, the TTL split and the unpriced
 * model down their stated paths. This file attacks the identities that must
 * hold ACROSS those paths — byClass against the total, byModel against the
 * total, the fallback numerator against its denominator — and the two shapes
 * the reference corpus has never produced, so nothing has ever exercised them
 * on this machine: an event whose TTL counters are present without their
 * total, and a window in which NOTHING was priceable.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-08T12:00:00.000Z');
const MTOK = 1e6;

let seq = 0;
function ev(over = {}) {
  seq += 1;
  return {
    f: 'f1',
    ts: NOW - DAY,
    model: 'claude-opus-5',
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
    cw5: 0,
    cw1h: 0,
    key: `k${seq}`,
    ...over,
  };
}

const week = (events) => pricing.weeklyCost(events, NOW - 7 * DAY, NOW, false);

/** Half a cent: the finest distinction the renderer can print. */
const CENT = 0.005;

/* ------------------------------------------------- reconciliation */

test.describe('the total is the sum of its parts, at the precision it is shown', () => {
  /** 60 events across two models, five classes and both cache TTLs. */
  function mixedCorpus() {
    const events = [];
    for (let i = 0; i < 60; i++) {
      events.push(ev({
        ts: NOW - DAY + i * 1000,
        model: i % 2 ? 'claude-sonnet-5-20260101' : 'claude-opus-5-20260101',
        input: 12_345 + i,
        output: 6_789 + i,
        cacheWrite: 100_000 + i,
        cw5: 40_000,
        cw1h: 60_000 + i,
        cacheRead: 5_000_000 + i,
      }));
    }
    return events;
  }

  test('byClass reconciles with totalUsd to inside half a cent', () => {
    // Each class is rounded independently at 4 decimals, so an exact identity
    // is not available — but the two figures are printed side by side, and a
    // visible disagreement between them would be a defect.
    const cost = week(mixedCorpus());
    const classSum = Object.values(cost.byClass).reduce((a, b) => a + b, 0);
    assert.ok(
      Math.abs(classSum - cost.totalUsd) < CENT,
      `byClass sums to ${classSum}, totalUsd is ${cost.totalUsd}`,
    );
  });

  test('byModel reconciles with totalUsd to inside half a cent', () => {
    const cost = week(mixedCorpus());
    const modelSum = cost.byModel.reduce((a, m) => a + (m.usd === null ? 0 : m.usd), 0);
    assert.ok(
      Math.abs(modelSum - cost.totalUsd) < CENT,
      `byModel sums to ${modelSum}, totalUsd is ${cost.totalUsd}`,
    );
  });

  test('an unpriced model is excluded from BOTH the classes and the total', () => {
    // Not one and not the other: contributing zero to byClass while owning a
    // row in byModel would make the composition claim to explain a total the
    // model was never part of.
    const priced = week([ev({ model: 'claude-opus-5', output: MTOK })]);
    const mixed = week([
      ev({ model: 'claude-opus-5', output: MTOK }),
      ev({ model: 'claude-opus-9-20991231', output: 40 * MTOK, cacheRead: 900 * MTOK }),
    ]);
    assert.equal(mixed.totalUsd, priced.totalUsd);
    assert.deepEqual(mixed.byClass, priced.byClass);
    assert.deepEqual(mixed.unpricedModels, ['claude-opus-9-20991231']);
  });

  test('the fallback numerator never exceeds its denominator', () => {
    const cost = week([
      ev({ cacheWrite: MTOK, cw5: MTOK }),
      ev({ cacheWrite: MTOK }),
      ev({ cacheWrite: MTOK, cw5: 1, cw1h: 1 }),
      ev({ output: MTOK }),
      ev({ model: 'claude-opus-9-20991231', cacheWrite: MTOK }),
    ]);
    assert.ok(
      cost.fallbackWriteEvents <= cost.cacheWriteEvents,
      `${cost.fallbackWriteEvents} of ${cost.cacheWriteEvents}`,
    );
    // 2 of 3 priced events took the floor; the unpriced one is in neither.
    assert.equal(cost.cacheWriteEvents, 3);
    assert.equal(cost.fallbackWriteEvents, 2);
  });
});

/* ------------------------------------------- the never-exercised shapes */

test.describe('the cache-write split under a producer that changes shape', () => {
  test('a breakdown that reconciles is used, and reports itself as a breakdown', () => {
    const split = pricing.cacheWriteSplit({ cacheWrite: 300, cw5: 100, cw1h: 200 });
    assert.deepEqual(split, { write5m: 100, write1h: 200, fromBreakdown: true });
  });

  test('an absent breakdown prices the whole amount at the 5-minute floor', () => {
    const split = pricing.cacheWriteSplit({ cacheWrite: 300, cw5: 0, cw1h: 0 });
    assert.deepEqual(split, { write5m: 300, write1h: 0, fromBreakdown: false });
  });

  test('FIXED: a breakdown with no top-level total is priced, not silently zeroed', () => {
    // This was the defect qa recorded here: the reconciliation identity was
    // run against the top-level total alone, so 0 + 0 === 0 passed for an
    // event carrying 2M tokens in its per-TTL counters, and those tokens were
    // priced at nothing and reported as nothing.
    //
    // qa noted the producer could not emit this shape. Measured on the real
    // corpus afterwards, it can and does: 3 of 20,674 records carry
    // `cache_creation_input_tokens: 0` alongside a genuine
    // `ephemeral_1h_input_tokens` of 1,280-1,592 and no other tokens at all.
    // parse.js dropped those records entirely on its all-zero guard, so the
    // tokens vanished from the breakdown as well as from the cost.
    //
    // Both halves are fixed: the identity now runs against the larger of the
    // two readings (src/core/pricing.js cacheWriteSplit) and the parser takes
    // the same maximum before its all-zero guard.
    const split = pricing.cacheWriteSplit({ cacheWrite: 0, cw5: MTOK, cw1h: MTOK });
    assert.deepEqual(split, { write5m: MTOK, write1h: MTOK, fromBreakdown: true });

    const cost = week([ev({ cacheWrite: 0, cw5: MTOK, cw1h: MTOK })]);
    assert.ok(cost.totalUsd > 0, 'two million cache-write tokens must cost something');
    assert.equal(cost.byModel[0].tokens.cacheWrite, 2 * MTOK, 'and must be reported');
    assert.equal(cost.cacheWriteEvents, 1, 'and must count toward the floor denominator');
    assert.equal(cost.fallbackWriteEvents, 0, 'the breakdown was present and usable');
  });

  test('a negative token count is floored at zero rather than crediting the total', () => {
    const cost = week([ev({ output: MTOK, input: -50 * MTOK })]);
    assert.equal(cost.totalUsd, 25);
    assert.equal(cost.byClass.input, 0);
  });
});

test.describe('a window in which nothing could be priced', () => {
  // The price table is a hand-transcribed snapshot dated 2026-06-24 holding
  // five model families. Claude Code follows whatever model it ships with, so
  // one release naming a family the table does not know makes EVERY event in
  // the week unpriced.
  const allUnpriced = () => week([
    ev({ model: 'claude-opus-6-20260901', input: 500_000, output: 200_000, cacheRead: 250 * MTOK }),
    ev({ model: 'claude-opus-6-20260901', cacheWrite: 3 * MTOK, cw5: MTOK, cw1h: 2 * MTOK }),
  ]);

  test('the window is not null: there WAS usage, it just could not be priced', () => {
    const cost = allUnpriced();
    assert.notEqual(cost, null);
    assert.equal(cost.byModel.length, 1);
  });

  test('its total is zero, so the total alone cannot carry the figure', () => {
    assert.equal(allUnpriced().totalUsd, 0);
    assert.deepEqual(allUnpriced().byClass, {
      input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0,
    });
  });

  test('it is nevertheless distinguishable from a priced week that cost nothing', () => {
    // This is the property any renderer fix has to key off: an all-unpriced
    // week has byModel rows and every one of them has usd === null, whereas a
    // priced week that rounds to zero has rows with usd === 0. Without this
    // distinction "$0,00" is the only thing either state can say.
    const unpriced = allUnpriced();
    assert.ok(unpriced.byModel.length > 0);
    assert.ok(unpriced.byModel.every((m) => m.usd === null));
    assert.ok(unpriced.unpricedModels.length > 0);

    const pricedButTiny = week([ev({ model: 'claude-haiku-4-5', output: 1 })]);
    assert.equal(pricedButTiny.totalUsd, 0);
    assert.ok(pricedButTiny.byModel.every((m) => m.usd === 0));
    assert.deepEqual(pricedButTiny.unpricedModels, []);
  });

  test('the tokens are still reported in full, so the usage is not invisible', () => {
    const row = allUnpriced().byModel[0];
    assert.equal(row.tokens.input, 500_000);
    assert.equal(row.tokens.cacheRead, 250 * MTOK);
    assert.equal(row.tokens.cacheWrite, 3 * MTOK);
  });

  test('a speed that is neither standard nor fast is unpriced, never priced as standard', () => {
    // `speedOf` takes an unrecognised value verbatim, so the (model, speed)
    // lookup misses and the row is excluded rather than guessed at.
    const cost = week([ev({ model: 'claude-opus-5', speed: 'turbo', input: MTOK })]);
    assert.equal(cost.totalUsd, 0);
    assert.equal(cost.byModel[0].speed, 'turbo');
    assert.equal(cost.byModel[0].usd, null);
    assert.equal(cost.byModel[0].pricedAs, null);
  });

  test('an empty window is null, which is a different claim from a zero total', () => {
    assert.equal(week([]), null);
    assert.equal(pricing.weeklyCost(null, NOW - 7 * DAY, NOW, false), null);
    // Every event outside the window is the same as no events at all.
    assert.equal(week([ev({ ts: NOW - 30 * DAY, output: MTOK })]), null);
  });
});
