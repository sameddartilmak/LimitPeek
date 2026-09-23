'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const pricing = require('../src/core/pricing');
const { extractEvents } = require('../src/core/scan/parse');
const { buildSnapshot } = require('../src/core/snapshot');
const agg = require('../src/core/aggregate');

/**
 * ADR-002. Every figure here is money-shaped, which means a silent zero or a
 * missed multiplier is a wrong number that looks exactly like a right one.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-08T12:00:00.000Z');
const MTOK = 1e6;

function ev(over = {}) {
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
    key: `k${Math.random()}`,
    ...over,
  };
}

/** Trailing 7 days, the unanchored case. */
function week(events) {
  return pricing.weeklyCost(events, NOW - 7 * DAY, NOW, false);
}

const close = (actual, expected, msg) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${msg}: got ${actual}, want ${expected}`);

/* ------------------------------------------------------- price lookup */

test.describe('the price table is a lookup, never a branch', () => {
  test('an exact model id', () => {
    const price = pricing.priceFor('claude-opus-5', 'standard');
    assert.equal(price.key, 'claude-opus-5|standard');
    assert.equal(price.input, 5);
    assert.equal(price.output, 25);
  });

  test('a dated id matches by prefix', () => {
    const price = pricing.priceFor('claude-haiku-4-5-20251001', 'standard');
    assert.equal(price.key, 'claude-haiku-4-5|standard');
    assert.equal(price.input, 1);
    assert.equal(price.output, 5);
  });

  test('the LONGEST prefix wins', () => {
    // Both 'claude-opus-4-7' and 'claude-opus-4-8' are table keys; a shorter
    // accidental prefix must never win the match.
    assert.equal(pricing.modelKeyFor('claude-opus-4-8-20260101'), 'claude-opus-4-8');
    assert.equal(pricing.modelKeyFor('claude-opus-4-7-20260101'), 'claude-opus-4-7');
  });

  test('a point release is UNPRICED, not billed at the previous model rate', () => {
    // The table itself writes Opus 4.8 as `claude-opus-4-8`, so a minor
    // version has exactly the shape of a suffix. Accepting any `-` segment
    // would price `claude-opus-5-1` at Opus 5's rate and put it in totalUsd
    // looking sourced — ADR-002 rule 2 defeated by the most likely form of
    // unknown model there is.
    assert.equal(pricing.modelKeyFor('claude-opus-5-1-20260401'), null);
    assert.equal(pricing.modelKeyFor('claude-opus-5-1'), null);
    assert.equal(pricing.priceFor('claude-opus-5-1-20260401', 'standard'), null);
    // ...and it shows up as a gap rather than as dollars.
    const cost = week([ev({ model: 'claude-opus-5-1-20260401', output: MTOK })]);
    assert.equal(cost.totalUsd, 0);
    assert.deepEqual(cost.unpricedModels, ['claude-opus-5-1-20260401']);
  });

  test('only an 8-digit date suffix is accepted', () => {
    assert.equal(pricing.modelKeyFor('claude-opus-5-20250101'), 'claude-opus-5');
    assert.equal(pricing.modelKeyFor('claude-opus-5'), 'claude-opus-5');
    // Anything else falls to unpriced, which is the safe direction.
    assert.equal(pricing.modelKeyFor('claude-opus-5-preview'), null);
    assert.equal(pricing.modelKeyFor('claude-opus-5-2026040'), null);
    assert.equal(pricing.modelKeyFor('claude-opus-5-202604011'), null);
    assert.equal(pricing.modelKeyFor('claude-opus-5-latest'), null);
  });

  test('a prefix only matches at a segment break, never mid-token', () => {
    // Otherwise a future 'claude-sonnet-50' would silently bill at Sonnet 5's
    // price — an unknown model priced from a neighbour's table row.
    assert.equal(pricing.modelKeyFor('claude-sonnet-50'), null);
    assert.equal(pricing.modelKeyFor('claude-opus-55'), null);
    assert.equal(pricing.modelKeyFor('claude-sonnet-5'), 'claude-sonnet-5');
    assert.equal(pricing.modelKeyFor('claude-sonnet-5-20260101'), 'claude-sonnet-5');
  });

  test('an unknown model has no price at all', () => {
    for (const model of ['gpt-5', 'claude-opus-3', '', null, undefined, 42, 'claude']) {
      assert.equal(pricing.priceFor(model, 'standard'), null, `${model} should be unpriced`);
    }
  });

  test('fast is a second ROW, at double the standard rate', () => {
    const fast = pricing.priceFor('claude-opus-5', 'fast');
    assert.equal(fast.key, 'claude-opus-5|fast');
    assert.equal(fast.input, 10);
    assert.equal(fast.output, 50);
    assert.equal(fast.input, pricing.priceFor('claude-opus-5', 'standard').input * 2);
  });

  test('a model with no fast row is unpriced at fast speed, not priced as standard', () => {
    assert.equal(pricing.priceFor('claude-sonnet-5', 'fast'), null);
    assert.equal(pricing.priceFor('claude-haiku-4-5', 'fast'), null);
    assert.equal(pricing.priceFor('claude-opus-4-7', 'fast'), null);
  });

  test('opus 4.8 has NO fast price, because none is published', () => {
    // Fast mode is available on 4.8, but the source table prices it for Opus 5
    // only. Extrapolating 5's $10/$50 onto 4.8 would be a guess wearing a
    // sourced number's clothes — precisely ADR-002 rule 2 (amendment 2).
    assert.equal(pricing.priceFor('claude-opus-4-8', 'fast'), null);
    assert.equal(pricing.priceFor('claude-opus-4-8-20260101', 'fast'), null);
    // The standard row is sourced and stays.
    assert.equal(pricing.priceFor('claude-opus-4-8', 'standard').input, 5);
  });

  test('opus 5.5 is its own row, not Opus 5, and reads cache at 0.05x', () => {
    assert.equal(pricing.modelKeyFor('claude-opus-5-5'), 'claude-opus-5-5');
    assert.equal(pricing.modelKeyFor('claude-opus-5-5-20260901'), 'claude-opus-5-5');
    assert.equal(pricing.modelKeyFor('claude-opus-5'), 'claude-opus-5', 'Opus 5 is untouched');
    const price = pricing.priceFor('claude-opus-5-5', 'standard');
    assert.equal(price.input, 4);
    assert.equal(price.output, 20);
    // One million of each class, against the published per-MTok prices:
    // input $4, output $20, 5m write $5, 1h write $8, cache read $0.20.
    const cost = week([ev({
      model: 'claude-opus-5-5', input: MTOK, output: MTOK, cacheRead: MTOK,
      cacheWrite: 2 * MTOK, cw5: MTOK, cw1h: MTOK,
    })]);
    close(cost.totalUsd, 4 + 20 + 5 + 8 + 0.2, 'opus 5.5 total');
    assert.deepEqual(cost.unpricedModels, []);
    // Its fast price is not final yet, so fast usage stays a visible gap.
    assert.equal(pricing.priceFor('claude-opus-5-5', 'fast'), null);
    // Every other row keeps the standard 0.1x read.
    close(week([ev({ model: 'claude-opus-5', cacheRead: MTOK })]).totalUsd, 0.5, 'opus 5 read');
  });

  test('the price table contains exactly the sourced rows', () => {
    assert.deepEqual(Object.keys(pricing.PRICES).sort(), [
      'claude-haiku-4-5|standard',
      'claude-opus-4-7|standard',
      'claude-opus-4-8|standard',
      'claude-opus-5-5|standard',
      'claude-opus-5|fast',
      'claude-opus-5|standard',
      'claude-sonnet-5|standard',
    ]);
  });

  test('an absent or empty speed is standard; anything else is taken verbatim', () => {
    assert.equal(pricing.speedOf({}), 'standard');
    assert.equal(pricing.speedOf({ speed: '' }), 'standard');
    assert.equal(pricing.speedOf({ speed: 'fast' }), 'fast');
    assert.equal(pricing.speedOf({ speed: 'turbo' }), 'turbo');
    assert.equal(pricing.priceFor('claude-opus-5', 'turbo'), null);
  });

  test('the table carries the date its prices were current', () => {
    assert.equal(pricing.PRICES_AS_OF, '2026-06-24');
    assert.deepEqual({ ...pricing.CACHE_MULTIPLIER }, { read: 0.1, write5m: 1.25, write1h: 2.0 });
  });
});

/* --------------------------------------------------- cache TTL split */

test.describe('cache writes are priced by TTL', () => {
  test('the per-TTL counters are used when they sum to the total', () => {
    const split = pricing.cacheWriteSplit(ev({ cacheWrite: 1000, cw5: 400, cw1h: 600 }));
    assert.deepEqual(split, { write5m: 400, write1h: 600, fromBreakdown: true });
  });

  test('1h bills at 2.0x input and 5m at 1.25x', () => {
    const cost = week([ev({ cacheWrite: 2 * MTOK, cw5: MTOK, cw1h: MTOK })]);
    close(cost.byClass.cacheWrite5m, 5 * 1.25, '5m at 1.25x the $5 input rate');
    close(cost.byClass.cacheWrite1h, 5 * 2.0, '1h at 2.0x the $5 input rate');
    close(cost.totalUsd, 6.25 + 10, 'total');
  });

  test('an absent breakdown falls back to the whole amount at 1.25x', () => {
    // A record from before the per-TTL counters existed: 0 + 0 against a
    // non-zero total fails the sum identity, so no flag has to be stored.
    const split = pricing.cacheWriteSplit(ev({ cacheWrite: 1000, cw5: 0, cw1h: 0 }));
    assert.deepEqual(split, { write5m: 1000, write1h: 0, fromBreakdown: false });
    const cost = week([ev({ cacheWrite: MTOK, cw5: 0, cw1h: 0 })]);
    close(cost.byClass.cacheWrite5m, 6.25, 'fallback prices everything at 1.25x');
    close(cost.byClass.cacheWrite1h, 0, 'nothing is attributed to 1h it did not observe');
  });

  test('per-TTL counters with a zero top-level total are NOT priced at zero', () => {
    // Measured on the real corpus: 3 of 20,674 records carry
    // `cache_creation_input_tokens: 0` alongside a genuine 1-hour write of
    // 1,280-1,592 tokens. Reconciling against the bare total made those two
    // thousand tokens cost nothing and raise no caveat — a silent zero.
    const split = pricing.cacheWriteSplit(ev({ cacheWrite: 0, cw5: 0, cw1h: 1592 }));
    assert.deepEqual(split, { write5m: 0, write1h: 1592, fromBreakdown: true });

    const cost = week([ev({ cacheWrite: 0, cw5: MTOK, cw1h: MTOK })]);
    close(cost.byClass.cacheWrite5m, 6.25, '5m must be priced');
    close(cost.byClass.cacheWrite1h, 10, '1h must be priced at 2.0x, not dropped');
    assert.equal(cost.cacheWriteEvents, 1, 'the event has cache writes and must be counted');
    assert.equal(cost.fallbackWriteEvents, 0, 'the breakdown was present and usable');
  });

  test('taking the larger reading moves nothing where the identity already holds', () => {
    const agreeing = pricing.cacheWriteSplit(ev({ cacheWrite: 1000, cw5: 400, cw1h: 600 }));
    assert.deepEqual(agreeing, { write5m: 400, write1h: 600, fromBreakdown: true });
    // And an absent breakdown still takes the documented 1.25x floor.
    const absent = pricing.cacheWriteSplit(ev({ cacheWrite: 1000, cw5: 0, cw1h: 0 }));
    assert.deepEqual(absent, { write5m: 1000, write1h: 0, fromBreakdown: false });
  });

  test('the parser keeps a record whose only tokens are in the TTL counters', () => {
    // Before this, the all-zero guard dropped it and the tokens vanished from
    // the breakdown as well as from the cost.
    const record = {
      type: 'assistant',
      timestamp: new Date(NOW - DAY).toISOString(),
      requestId: 'req_zero_total',
      message: {
        model: 'claude-opus-4-8',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1592 },
        },
      },
    };
    const { events } = extractEvents(`${JSON.stringify(record)}\n`, 'fid');
    assert.equal(events.length, 1, 'the record must not be dropped');
    assert.equal(events[0].cacheWrite, 1592);
    assert.equal(events[0].cw1h, 1592);
    // A genuinely empty record is still skipped.
    const empty = { ...record, message: { model: 'claude-opus-4-8', usage: { input_tokens: 0, output_tokens: 0 } } };
    assert.equal(extractEvents(`${JSON.stringify(empty)}\n`, 'fid').events.length, 0);
  });

  test('a breakdown that does not reconcile falls back rather than guessing', () => {
    // Partial data is not a licence to invent the remainder's TTL.
    const split = pricing.cacheWriteSplit(ev({ cacheWrite: 1000, cw5: 100, cw1h: 100 }));
    assert.deepEqual(split, { write5m: 1000, write1h: 0, fromBreakdown: false });
  });

  test('fallbackWriteEvents counts the events priced at the 1.25x floor', () => {
    const cost = week([
      ev({ cacheWrite: MTOK, cw5: MTOK, cw1h: 0 }),          // exact breakdown
      ev({ cacheWrite: MTOK, cw5: 0, cw1h: 0 }),             // breakdown absent
      ev({ cacheWrite: MTOK, cw5: 100, cw1h: 100 }),         // does not reconcile
    ]);
    assert.equal(cost.fallbackWriteEvents, 2);
  });

  test('fallbackWriteEvents is 0 when every record carries a usable breakdown', () => {
    assert.equal(week([ev({ cacheWrite: 1000, cw5: 400, cw1h: 600 })]).fallbackWriteEvents, 0);
  });

  test('cacheWriteEvents is the denominator, under the SAME scope as the numerator', () => {
    // A bare numerator cannot tell 1-of-1413 from 1413-of-1413. Scoping the
    // denominator differently from the numerator would make the ratio read
    // better than the truth, which is the direction that matters here.
    const cost = week([
      ev({ cacheWrite: MTOK, cw5: MTOK, cw1h: 0 }),   // has writes, split usable
      ev({ cacheWrite: MTOK, cw5: 0, cw1h: 0 }),      // has writes, fell back
      ev({ output: MTOK }),                            // no writes: in neither
    ]);
    assert.equal(cost.cacheWriteEvents, 2);
    assert.equal(cost.fallbackWriteEvents, 1);
    assert.ok(cost.fallbackWriteEvents <= cost.cacheWriteEvents, 'the ratio must never exceed 1');
  });

  test('an unpriced model is in neither the numerator nor the denominator', () => {
    // It contributes no dollars, so it cannot qualify how much of a floor the
    // total is. Counting it in the denominator only would understate the
    // caveat; counting it in both would attach it to a total it is not in.
    const cost = week([
      ev({ cacheWrite: MTOK, cw5: 0, cw1h: 0 }),
      ev({ model: 'claude-unknown-9', cacheWrite: MTOK, cw5: MTOK, cw1h: 0 }),
      ev({ model: 'claude-unknown-9', cacheWrite: MTOK, cw5: 0, cw1h: 0 }),
    ]);
    assert.equal(cost.cacheWriteEvents, 1);
    assert.equal(cost.fallbackWriteEvents, 1);
  });

  test('a window with no cache writes at all reports 0/0, not a division trap', () => {
    const cost = week([ev({ output: MTOK })]);
    assert.equal(cost.cacheWriteEvents, 0);
    assert.equal(cost.fallbackWriteEvents, 0);
  });

  test('an event with no cache writes took no fallback and is not counted', () => {
    assert.equal(week([ev({ output: MTOK })]).fallbackWriteEvents, 0);
  });

  test('the fallback on an UNPRICED model is not counted, because it qualifies totalUsd', () => {
    const cost = week([ev({ model: 'claude-unknown-9', cacheWrite: MTOK, cw5: 0, cw1h: 0 })]);
    assert.equal(cost.fallbackWriteEvents, 0);
    assert.deepEqual(cost.unpricedModels, ['claude-unknown-9']);
  });

  test('no cache writes at all is not a fallback case', () => {
    assert.deepEqual(pricing.cacheWriteSplit(ev({})), { write5m: 0, write1h: 0, fromBreakdown: false });
    assert.equal(week([ev({ output: 1 })]).byClass.cacheWrite5m, 0);
  });

  test('the parser records both counters verbatim from cache_creation', () => {
    const record = {
      type: 'assistant',
      timestamp: new Date(NOW - DAY).toISOString(),
      requestId: 'req_ttl',
      message: {
        model: 'claude-opus-5',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 5815280,
          cache_read_input_tokens: 0,
          cache_creation: {
            ephemeral_5m_input_tokens: 2901576,
            ephemeral_1h_input_tokens: 2913704,
          },
        },
      },
    };
    const { events } = extractEvents(`${JSON.stringify(record)}\n`, 'fid');
    assert.equal(events[0].cw5, 2901576);
    assert.equal(events[0].cw1h, 2913704);
    // The identity ADR-002 measured on the real corpus.
    assert.equal(events[0].cw5 + events[0].cw1h, events[0].cacheWrite);
    assert.equal(pricing.cacheWriteSplit(events[0]).fromBreakdown, true);
  });

  test('a record with no cache_creation object yields zeroes, not undefined', () => {
    const record = {
      type: 'assistant',
      timestamp: new Date(NOW - DAY).toISOString(),
      requestId: 'req_none',
      message: { model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 10 } },
    };
    const { events } = extractEvents(`${JSON.stringify(record)}\n`, 'fid');
    assert.equal(events[0].cw5, 0);
    assert.equal(events[0].cw1h, 0);
  });

  test('speed is recorded only when it is not standard, and only if it is enum-shaped', () => {
    const make = (speed) => {
      const record = {
        type: 'assistant',
        timestamp: new Date(NOW - DAY).toISOString(),
        requestId: `req_${String(speed)}`,
        message: { model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1, speed } },
      };
      return extractEvents(`${JSON.stringify(record)}\n`, 'fid').events[0];
    };
    assert.equal('speed' in make('standard'), false, 'the default is an absent field');
    assert.equal(make('fast').speed, 'fast');
    // Not an enum token: rejected at the boundary rather than carried into a
    // price-table key.
    assert.equal('speed' in make('a very long free text value'), false);
    assert.equal('speed' in make({ nested: true }), false);
  });
});

/* ------------------------------------------------- unpriced models */

test.describe('an unknown model is never priced at zero', () => {
  const events = [
    ev({ model: 'claude-opus-5', output: MTOK }),
    ev({ model: 'claude-omega-9-20270101', output: MTOK, input: 5, cacheRead: 7 }),
  ];

  test('it is excluded from the total, which counts only priced models', () => {
    const cost = week(events);
    close(cost.totalUsd, 25, 'only the opus row may contribute');
  });

  test('its usd is null, not 0', () => {
    const row = week(events).byModel.find((m) => m.model === 'claude-omega-9-20270101');
    assert.equal(row.usd, null);
    assert.equal(row.pricedAs, null);
  });

  test('its TOKENS are still reported, so the row is not invisible', () => {
    const row = week(events).byModel.find((m) => m.model === 'claude-omega-9-20270101');
    assert.equal(row.tokens.output, MTOK);
    assert.equal(row.tokens.input, 5);
    assert.equal(row.tokens.cacheRead, 7);
    assert.equal(row.tokens.billable, MTOK + 5);
  });

  test('it is named in unpricedModels for the UI to surface', () => {
    assert.deepEqual(week(events).unpricedModels, ['claude-omega-9-20270101']);
  });

  test('it contributes nothing to byClass either, so the classes sum to the total', () => {
    const cost = week(events);
    const classSum = Object.values(cost.byClass).reduce((a, b) => a + b, 0);
    close(classSum, cost.totalUsd, 'byClass must reconcile with totalUsd');
  });

  test('unpriced rows sort last, priced rows by spend', () => {
    const cost = week([
      ev({ model: 'claude-unknown-1', output: MTOK }),
      ev({ model: 'claude-haiku-4-5', output: MTOK }),
      ev({ model: 'claude-opus-5', output: MTOK }),
    ]);
    assert.deepEqual(cost.byModel.map((m) => m.model), ['claude-opus-5', 'claude-haiku-4-5', 'claude-unknown-1']);
  });

  test('a fast record on a model with no fast row is unpriced, not silently standard', () => {
    const cost = week([ev({ model: 'claude-sonnet-5', speed: 'fast', output: MTOK })]);
    assert.equal(cost.totalUsd, 0);
    assert.deepEqual(cost.unpricedModels, ['claude-sonnet-5']);
    assert.equal(cost.byModel[0].usd, null);
    assert.equal(cost.byModel[0].speed, 'fast');
  });

  test('opus 4.8 at fast speed lands in unpricedModels rather than in the total', () => {
    const cost = week([
      ev({ model: 'claude-opus-4-8-20260101', output: MTOK }),
      ev({ model: 'claude-opus-4-8-20260101', output: MTOK, speed: 'fast' }),
    ]);
    close(cost.totalUsd, 25, 'only the standard row is priced');
    assert.deepEqual(cost.unpricedModels, ['claude-opus-4-8-20260101']);
    const fast = cost.byModel.find((m) => m.speed === 'fast');
    assert.equal(fast.usd, null);
    assert.equal(fast.pricedAs, null);
    // The reason the contract added `speed`: without it these two rows are
    // indistinguishable, and unpricedModels appears to contradict the priced
    // row beside it.
    const standard = cost.byModel.find((m) => m.speed === 'standard');
    assert.equal(standard.model, fast.model);
    assert.equal(standard.pricedAs, 'claude-opus-4-8|standard');
  });

  test('every ModelCost carries the speed it was billed at', () => {
    const cost = week([ev({ output: MTOK }), ev({ model: 'claude-haiku-4-5', output: MTOK })]);
    for (const row of cost.byModel) assert.equal(row.speed, 'standard');
  });

  test('the same model at two speeds is two rows, because it is two prices', () => {
    const cost = week([
      ev({ model: 'claude-opus-5', output: MTOK }),
      ev({ model: 'claude-opus-5', output: MTOK, speed: 'fast' }),
    ]);
    assert.equal(cost.byModel.length, 2);
    assert.deepEqual(cost.byModel.map((m) => m.pricedAs).sort(),
      ['claude-opus-5|fast', 'claude-opus-5|standard']);
    close(cost.totalUsd, 25 + 50, 'fast bills double');
  });
});

/* ------------------------------------------------- arithmetic oracle */

test.describe('the arithmetic', () => {
  test('one million tokens of each class, hand-computed', () => {
    const cost = week([ev({
      model: 'claude-opus-5',
      input: MTOK,
      output: MTOK,
      cacheWrite: MTOK,
      cw5: MTOK,
      cw1h: 0,
      cacheRead: MTOK,
    })]);
    close(cost.byClass.input, 5, 'input at $5/MTok');
    close(cost.byClass.output, 25, 'output at $25/MTok');
    close(cost.byClass.cacheWrite5m, 6.25, '5m write at 1.25 x $5');
    close(cost.byClass.cacheRead, 0.5, 'cache read at 0.1 x $5');
    close(cost.totalUsd, 36.75, 'total');
  });

  test('haiku is priced from its own row, not opus', () => {
    const cost = week([ev({ model: 'claude-haiku-4-5-20251001', output: MTOK, cacheRead: MTOK })]);
    close(cost.totalUsd, 5 + 0.1, '$5 output + 0.1x of $1 input');
  });

  test('cost is derived from the DEDUPED set, like every other figure', () => {
    // Session resume and /compact replay the same assistant record into a new
    // file. Counting the replay would land the 115% inflation on the money.
    const one = ev({ model: 'claude-opus-5', output: MTOK, key: 'req_same' });
    const replay = { ...one, f: 'f2' };
    const cost = week(agg.dedupe([one, replay]));
    close(cost.totalUsd, 25, 'the replayed record must not be billed twice');
  });
});

/* ---------------------------------------------------- window anchoring */

test.describe('the window', () => {
  test('trailing 7 days when there is no reset instant', () => {
    const cost = week([ev({ output: MTOK })]);
    assert.equal(cost.windowAnchored, false);
    assert.equal(cost.windowStart, new Date(NOW - 7 * DAY).toISOString());
    assert.equal(cost.windowEnd, new Date(NOW).toISOString());
  });

  test('is half-open: a record on the end instant belongs to the next window', () => {
    const end = NOW;
    const cost = pricing.weeklyCost(
      [ev({ ts: end - 1, output: MTOK }), ev({ ts: end, output: MTOK })],
      end - 7 * DAY, end, true,
    );
    close(cost.totalUsd, 25, 'exactly one of the two records is inside');
    assert.equal(cost.windowAnchored, true);
  });

  test('a record before the start is out', () => {
    assert.equal(week([ev({ ts: NOW - 8 * DAY, output: MTOK })]), null);
  });

  test('no usage in the window is null, never a $0 total', () => {
    assert.equal(week([]), null);
    assert.equal(pricing.weeklyCost(null, NOW - 7 * DAY, NOW, false), null);
  });

  test('buildSnapshot anchors to sevenDay.resetsAt when it is still ahead', () => {
    const resetsAtMs = NOW + 2 * DAY;
    const snap = buildSnapshot({
      now: NOW,
      events: [ev({ output: MTOK })],
      rateLimits: {
        state: 'fresh',
        capturedAtMs: NOW - 1000,
        fiveHour: { usedPercentage: 10, resetsAtMs: NOW + 3600000 },
        sevenDay: { usedPercentage: 20, resetsAtMs },
      },
      scanOk: true,
    });
    const cost = snap.providers.find((p) => p.id === 'claude').weeklyCost;
    assert.equal(cost.windowAnchored, true);
    assert.equal(cost.windowEnd, new Date(resetsAtMs).toISOString());
    assert.equal(cost.windowStart, new Date(resetsAtMs - 7 * DAY).toISOString());
  });

  test('a reset instant that has already passed is NOT used as an anchor', () => {
    // Anchoring to a window that closed would exclude everything spent since
    // it closed and report a confidently wrong, always-shrinking figure.
    const snap = buildSnapshot({
      now: NOW,
      events: [ev({ ts: NOW - 60000, output: MTOK })],
      rateLimits: {
        state: 'fresh',
        capturedAtMs: NOW - 1000,
        fiveHour: null,
        sevenDay: { usedPercentage: 20, resetsAtMs: NOW - DAY },
      },
      scanOk: true,
    });
    const cost = snap.providers.find((p) => p.id === 'claude').weeklyCost;
    assert.equal(cost.windowAnchored, false);
    assert.equal(cost.windowEnd, new Date(NOW).toISOString());
    close(cost.totalUsd, 25, 'usage since the stale reset instant must still count');
  });
});

/* -------------------------------------------------- snapshot wiring */

test.describe('the snapshot carries it', () => {
  test('claude gets a WeeklyCost with every contract field', () => {
    const snap = buildSnapshot({ now: NOW, events: [ev({ output: MTOK })], rateLimits: null, scanOk: true });
    const cost = snap.providers.find((p) => p.id === 'claude').weeklyCost;
    assert.deepEqual(Object.keys(cost).sort(), [
      'byClass', 'byModel', 'cacheWriteEvents', 'fallbackWriteEvents',
      'assumedTierEvents', 'fastRequestedEvents', 'pricesAsOf', 'sourceIncomplete', 'totalUsd', 'unpricedModels', 'unrecordedWriteEvents', 'windowAnchored',
      'unrecordedCalls', 'longPromptFloorEvents', 'toolTokenEvents',
      'windowEnd', 'windowStart',
    ].sort());
    assert.deepEqual(Object.keys(cost.byModel[0]).sort(),
      ['model', 'pricedAs', 'speed', 'tokens', 'usd'].sort());
    assert.deepEqual(Object.keys(cost.byClass).sort(),
      ['cacheRead', 'cacheWrite1h', 'cacheWrite5m', 'input', 'output'].sort());
    assert.equal(cost.pricesAsOf, '2026-06-24');
  });

  test('a provider with no usage reports null, not a zero total', () => {
    const snap = buildSnapshot({ now: NOW, events: [], rateLimits: null, scanOk: true });
    for (const provider of snap.providers) {
      assert.equal(provider.weeklyCost, null, `${provider.id} should have no cost object`);
    }
  });

  test('the five unconnected providers never carry a cost', () => {
    const snap = buildSnapshot({ now: NOW, events: [ev({ output: MTOK })], rateLimits: null, scanOk: true });
    for (const provider of snap.providers.filter((p) => p.id !== 'claude')) {
      assert.equal(provider.weeklyCost, null);
    }
  });
});
