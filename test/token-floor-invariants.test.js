'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSnapshot } = require('../src/core/snapshot');
const history = require('../src/core/history');

/**
 * TWO PRODUCER INVARIANTS THE RENDERER NOW DEPENDS ON, ASSERTED WHERE THEY ARE
 * PRODUCED.
 *
 * Both exist because a token floor and a cost floor are different claims with
 * different causes, and the renderer was given exactly one field to read for
 * each. That only stays safe while main keeps two promises it does not state in
 * a type.
 *
 * INVARIANT 1 — the "could not be counted" state always has a cost object.
 * ADR-002 A3.19 / the three-state rule: a present count prints (a measured zero
 * included), a null count shows no figure, and an all-zero count whose source
 * was incomplete reads "sayılamadı". The renderer decides the third from
 * `weeklyCost.sourceIncomplete` (row.ts), NOT from the token causes — by
 * design, since `weeklyTokenFloorCauses` is deliberately empty for a zero count
 * ("no amount, no bound", src/core/history.js `tokenFloorCauses`). So the
 * sentence is only reachable while main guarantees a non-null `weeklyCost` with
 * `sourceIncomplete: true` on exactly that path, which today it does only
 * because `snapshot.js` synthesises `emptyWeeklyCost`. If that ever lapses the
 * row prints "0 token" for a week nobody could read — a measured-zero claim
 * over a no-figure state, which is the bug the rule exists to prevent, in a new
 * place. The same shape as reading the window label from
 * `weeklyCost.windowAnchored`, which was unreadable on a quiet week.
 *
 * INVARIANT 2 — 'unread-range' is a TOKEN cause and never a COST cause.
 * On the cost side a known-unread range already has its own field
 * (`UsageHistory.incompleteProviders`) and its own note, and ADR-002 A3.20 rules
 * that the price notes do not grow a clause for it. The token side has no such
 * field, so there the gap must be nameable. The panel no longer prints any
 * cause (the floor marker was removed, 2026-09-23), but the contract still
 * carries them, and main emitting the code on the wrong side would still be a
 * false statement in the payload. Nothing else checks that direction.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Fixed instant for the snapshot half (UTC-stable: no calendar bucketing). */
const NOW = Date.parse('2026-09-14T12:00:00.000Z');
/** Local noon for the history half, whose buckets are LOCAL-calendar. */
const LOCAL_NOW = new Date(2026, 8, 9, 12, 0, 0).getTime();

const row = (snap, id) => snap.providers.find((p) => p.id === id);
const range = (fromMs, throughMs) => ({ fromMs, throughMs });

const claudeEv = (over) => ({
  f: 'f1', key: 'k', ts: NOW - 2 * HOUR, model: 'claude-opus-5',
  input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cw5: 0, cw1h: 0,
  ...over,
});

/* ------------------------------------------------------------ invariant 1 */

test.describe('an all-zero weekly count that is KNOWN incomplete always carries the cost object that says so', () => {
  /**
   * The canonical A3.19 state: the transcript scan failed, so the store it fell
   * back to holds nothing in the window and the reader KNOWS it could not read.
   */
  test('a failed Claude scan with nothing readable: zero count, and a cost that states the gap', () => {
    const r = row(buildSnapshot({
      now: NOW, events: [], rateLimits: null, codexEvents: [], scanOk: false,
    }), 'claude');

    // The count exists and is entirely zero — the state the row must NOT print
    // as a figure.
    assert.notEqual(r.weeklyTokens, null, 'a scanned row always has a weekly count object');
    assert.deepEqual(
      r.weeklyTokens,
      { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, billable: 0 },
      'nothing was readable, so every class is zero',
    );
    // ...and this is what makes "sayılamadı" reachable instead of "0 token".
    assert.notEqual(r.weeklyCost, null, 'A3.19: the cost object must exist to carry the gap');
    assert.equal(r.weeklyCost.sourceIncomplete, true);
  });

  test('and it is NOT a floor: with no amount there is nothing for a cause to qualify', () => {
    // The distinction the whole causes design rests on. "en az 0 token" is a
    // lower bound on a figure that does not exist.
    const r = row(buildSnapshot({
      now: NOW, events: [], rateLimits: null, codexEvents: [], scanOk: false,
    }), 'claude');
    assert.deepEqual(r.weeklyTokenFloorCauses, []);
  });

  test('a known-unread RANGE inside the week reaches the same state', () => {
    // The other route to A3.19: the scan succeeded but names a range it could
    // not read, and nothing else landed in the window.
    const r = row(buildSnapshot({
      now: NOW, events: [], rateLimits: null, codexEvents: [], scanOk: true,
      scanUnreadRange: range(NOW - 2 * DAY, NOW - DAY),
    }), 'claude');
    assert.deepEqual(r.weeklyTokens, { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, billable: 0 });
    assert.notEqual(r.weeklyCost, null, 'the gap needs an object to be stated on');
    assert.equal(r.weeklyCost.sourceIncomplete, true);
    assert.deepEqual(r.weeklyTokenFloorCauses, [], 'still no amount, so still not a floor');
  });

  test('the inverse: a fully read empty week states no gap, so its zero is a real measurement', () => {
    // This is the state that must print "0 token" rather than "sayılamadı", and
    // it is told apart from the one above by `sourceIncomplete` alone.
    const r = row(buildSnapshot({
      now: NOW, events: [], rateLimits: null, codexEvents: [], scanOk: true,
    }), 'claude');
    assert.deepEqual(r.weeklyTokens, { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, billable: 0 });
    assert.equal(r.weeklyCost, null, 'nothing priced and nothing unread: no cost object at all');
    assert.deepEqual(r.weeklyTokenFloorCauses, []);
  });

  test('a count that is a real floor keeps its causes — the gate is the amount, not the cause', () => {
    const r = row(buildSnapshot({
      now: NOW, events: [claudeEv({ output: 1000 })], rateLimits: null, codexEvents: [], scanOk: true,
      scanUnreadRange: range(NOW - 2 * DAY, NOW - DAY),
    }), 'claude');
    assert.equal(r.weeklyTokens.billable, 1000);
    assert.deepEqual(r.weeklyTokenFloorCauses, ['unread-range']);
    assert.equal(r.weeklyCost.sourceIncomplete, true);
  });
});

test.describe('a week of nothing but cache reads is a real count, never a zero to hide', () => {
  // cacheRead is ~98% of raw volume and is excluded from `billable`, so a gate
  // on `billable > 0` would erase a true measurement. The decision is made on
  // the four RAW classes (`hasAnyTokens`), not on the derived total — which is
  // also what makes "en az 0 token" unreachable in the data.
  const cacheReadOnly = { input: 0, output: 0, cacheWrite: 0, cacheRead: 9_000_000, billable: 0 };

  test('Claude keeps the figure, with billable legitimately zero', () => {
    const r = row(buildSnapshot({
      now: NOW, events: [claudeEv({ ts: NOW - 2 * DAY, cacheRead: 9_000_000 })],
      rateLimits: null, codexEvents: [], scanOk: true,
    }), 'claude');
    assert.deepEqual(r.weeklyTokens, cacheReadOnly);
  });

  test('a local-log row keeps it too, rather than nulling on a zero billable', () => {
    const r = row(buildSnapshot({
      now: NOW, events: [], rateLimits: null, codexEvents: [], scanOk: true,
      kimi: {
        installed: true,
        events: [{ ts: NOW - 2 * DAY, model: 'kimi-code/kimi-for-coding', input: 0, output: 0, cacheRead: 9_000_000, cacheWrite: 0 }],
        readFailed: false, resultAtMs: NOW, unreadRange: null,
      },
    }), 'kimi');
    assert.deepEqual(r.weeklyTokens, cacheReadOnly);
  });

  test('and such a week IS eligible to be a floor, unlike an all-zero one', () => {
    const r = row(buildSnapshot({
      now: NOW, events: [claudeEv({ ts: NOW - 2 * DAY, cacheRead: 9_000_000 })],
      rateLimits: null, codexEvents: [], scanOk: true,
      scanUnreadRange: range(NOW - 3 * DAY, NOW - 2.5 * DAY),
    }), 'claude');
    assert.deepEqual(r.weeklyTokenFloorCauses, ['unread-range'], 'cache reads are an amount');
  });
});

/* ------------------------------------------------------------ invariant 2 */

test.describe("'unread-range' is a token cause and is never emitted as a cost cause (A3.20)", () => {
  const W_START = history.weekStartMs(LOCAL_NOW);
  const AT = W_START + HOUR;
  const priced = () => [{
    f: 'f1', key: 'k', ts: AT, model: 'claude-opus-5',
    input: 0, output: 1000, cacheWrite: 0, cacheRead: 0, cw5: 0, cw1h: 0,
  }];

  test('the token side names the gap, because it has no other field for it', () => {
    const { weeks } = history.usageHistory(priced(), LOCAL_NOW, {
      unreadRanges: { claude: [range(AT, AT)] },
    });
    assert.deepEqual(weeks[0].tokenFloorCausesByProvider.claude, ['unread-range']);
  });

  test('the COST side does not, because the price note may not grow that clause', () => {
    const out = history.usageHistory(priced(), LOCAL_NOW, {
      unreadRanges: { claude: [range(AT, AT)] },
    });
    const costCauses = out.floorCausesByProvider.claude || [];
    assert.equal(
      costCauses.includes('unread-range'),
      false,
      'ADR-002 A3.20: on the cost side the gap has its own field and its own note; a clause here '
      + 'would state it twice, in a sentence the ADR rules out',
    );
  });

  test('the gap is still named on the cost side — by its own field, not by a cause', () => {
    // The asymmetry is only honest because nothing is lost: the money still
    // says it is a lower bound, and the unread range is still reported.
    const out = history.usageHistory(priced(), LOCAL_NOW, {
      unreadRanges: { claude: [range(AT, AT)] },
    });
    assert.deepEqual(out.incompleteProviders, ['claude']);
    assert.equal(out.weeks[0].isFloor, true, 'the dollars are a floor for the unread range');
  });

  test('no tool ever carries the code on the cost side, whichever tool has the gap', () => {
    for (const id of ['claude', 'codex', 'gemini', 'kimi']) {
      const out = history.usageHistory(priced(), LOCAL_NOW, {
        codexEvents: [{ ts: AT, model: 'gpt-5.6-sol', tier: 'standard', inputUncached: 1000, cachedInput: 0, cacheWrite: 0, output: 100 }],
        geminiEvents: [{ ts: AT, model: 'gemini-2.5-pro', input: 1000, cached: 0, output: 100, thoughts: 0, tool: 0, longPrompt: false }],
        kimiEvents: [{ ts: AT, model: 'kimi-code/kimi-for-coding', input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 }],
        unreadRanges: { [id]: [range(AT, AT)] },
      });
      for (const [tool, causes] of Object.entries(out.floorCausesByProvider)) {
        assert.equal(causes.includes('unread-range'), false, `${tool} carries it while ${id} has the gap`);
      }
      // `includes`, not a deep equal: Gemini also carries its unconditional
      // 'unrecorded-calls' (ADR-003 A6), which is correct and unrelated.
      assert.equal(
        (out.weeks[0].tokenFloorCausesByProvider[id] || []).includes('unread-range'),
        true,
        `${id}: the token side must still name it`,
      );
    }
  });
});
