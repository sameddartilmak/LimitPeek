'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSnapshot, windowFrom } = require('../src/core/snapshot');

/**
 * Adversarial coverage of the single rule ADR-001 rests on: the app must never
 * show a percentage it cannot defend, and must never drop one it can.
 *
 * `snapshot.test.js` walks the three states down their happy paths. This file
 * attacks the seams between them — in particular the one input the three-state
 * machine does not consider jointly: a capture that is FRESH but whose window
 * has nevertheless already reset.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-09-08T15:00:00.000Z');

function capture({ state, capturedAtMs, five, seven }) {
  return {
    state,
    capturedAt: capturedAtMs === null ? null : new Date(capturedAtMs).toISOString(),
    capturedAtMs,
    ageMs: capturedAtMs === null ? null : NOW - capturedAtMs,
    fiveHour: five ?? null,
    sevenDay: seven ?? null,
  };
}

function claudeOf(snapshot) {
  return snapshot.providers.find((p) => p.id === 'claude');
}

function build(rateLimits, over = {}) {
  return buildSnapshot({
    now: NOW,
    events: [],
    rateLimits,
    scanOk: true,
    planLabel: null,
    ...over,
  });
}

/**
 * The contract's own words: a percentage may exist only while the window it
 * describes is still running. Applied to every window in a snapshot at once,
 * this is the whole product invariant in four lines.
 */
function assertNoIndefensibleNumber(snapshot, now) {
  for (const p of snapshot.providers) {
    for (const [name, w] of [['fiveHour', p.fiveHour], ['sevenDay', p.sevenDay]]) {
      if (!w) continue;
      if (w.usedPercentage === null) {
        assert.equal(w.certainty, 'unknown', `${p.id}.${name}: null percentage must be 'unknown'`);
        continue;
      }
      assert.notEqual(w.certainty, 'unknown', `${p.id}.${name}: a number cannot be 'unknown'`);
      assert.ok(w.capturedAt, `${p.id}.${name}: a percentage must carry its capture instant`);
      assert.ok(
        w.resetsAt !== null && now < Date.parse(w.resetsAt),
        `${p.id}.${name}: showed ${w.usedPercentage}% for a window that resets at `
          + `${w.resetsAt}, which is not in the future — the figure describes a window `
          + 'that no longer exists (ADR-001 amendment 2, state 3)',
      );
    }
  }
}

// ------------------------------------------------- the boundary at resetsAt

test.describe('the transition at resetsAt', () => {
  test('a stale capture one millisecond before its reset is still shown', () => {
    const rl = capture({
      state: 'stale',
      capturedAtMs: NOW - 90 * MIN,
      five: { usedPercentage: 82, resetsAtMs: NOW + 1 },
    });
    const claude = claudeOf(build(rl));
    assert.equal(claude.fiveHour.usedPercentage, 82);
    assert.equal(claude.fiveHour.certainty, 'known');
    assert.equal(claude.status, 'stale');
  });

  test('a stale capture exactly at its reset instant is gone', () => {
    const rl = capture({
      state: 'stale',
      capturedAtMs: NOW - 90 * MIN,
      five: { usedPercentage: 82, resetsAtMs: NOW },
    });
    const claude = claudeOf(build(rl));
    assert.equal(claude.fiveHour.usedPercentage, null);
    assert.equal(claude.fiveHour.certainty, 'unknown');
    assert.equal(claude.fiveHour.resetsAt, null, 'a dead window advertises no reset instant');
    assert.equal(claude.fiveHour.billableSinceCapture, null, 'no delta without a figure to attach it to');
  });

  test('the two windows expire independently of one another', () => {
    // The 5h window has rolled over; the weekly one has not. Losing the weekly
    // figure with the 5h one would be dropping a number we can still defend.
    const rl = capture({
      state: 'stale',
      capturedAtMs: NOW - 2 * HOUR,
      five: { usedPercentage: 97, resetsAtMs: NOW - MIN },
      seven: { usedPercentage: 44, resetsAtMs: NOW + 3 * 24 * HOUR },
    });
    const claude = claudeOf(build(rl));
    assert.equal(claude.fiveHour.usedPercentage, null);
    assert.equal(claude.sevenDay.usedPercentage, 44);
    assert.equal(claude.sevenDay.certainty, 'known');
  });

  test('windowFrom is total: every input lands in exactly one of the three states', () => {
    const cases = [
      // [win, captureFresh, capturedAtMs, expectPercentage]
      [null, true, NOW, null],
      [{ usedPercentage: null, resetsAtMs: NOW + HOUR }, true, NOW, null],
      [{ usedPercentage: 10, resetsAtMs: NOW + HOUR }, true, NOW, 10],
      [{ usedPercentage: 10, resetsAtMs: NOW + HOUR }, false, NOW - HOUR, 10],
      [{ usedPercentage: 10, resetsAtMs: NOW }, false, NOW - HOUR, null],
      [{ usedPercentage: 10, resetsAtMs: NOW - 1 }, false, NOW - HOUR, null],
      [{ usedPercentage: 10, resetsAtMs: null }, false, NOW - HOUR, null],
    ];
    for (const [win, fresh, capMs, expected] of cases) {
      const out = windowFrom(win, fresh, capMs, NOW, 1234);
      assert.equal(out.usedPercentage, expected, JSON.stringify({ win, fresh }));
      assert.equal(
        out.certainty === 'unknown',
        expected === null,
        `certainty must agree with the percentage for ${JSON.stringify({ win, fresh })}`,
      );
    }
  });
});

// --------------------------------------------------- the attack on state 1

test.describe('a capture can be fresh and still describe a dead window', () => {
  test('DEFECT: a two-minute-old capture whose 5h window reset a minute ago is still shown', () => {
    // Entirely ordinary: the user prompts at 14:58, the 5h window rolls over at
    // 14:59, they glance at the tray at 15:00. The capture is two minutes old,
    // so `state` is 'fresh' and windowFrom returns early — before the
    // `now >= resetsAt` test that state 3 of the ADR makes unconditional.
    const rl = capture({
      state: 'fresh',
      capturedAtMs: NOW - 2 * MIN,
      five: { usedPercentage: 96, resetsAtMs: NOW - MIN },
      seven: { usedPercentage: 71, resetsAtMs: NOW + 3 * 24 * HOUR },
    });
    const snapshot = build(rl);
    assertNoIndefensibleNumber(snapshot, NOW);
  });

  test('DEFECT: the same row is labelled ok, so nothing downstream is warned either', () => {
    const rl = capture({
      state: 'fresh',
      capturedAtMs: NOW - 2 * MIN,
      five: { usedPercentage: 96, resetsAtMs: NOW - MIN },
    });
    const claude = claudeOf(build(rl));
    // Whatever the row ends up showing, it must not present a window that has
    // already rolled over as a current, exact reading.
    assert.ok(
      claude.fiveHour.usedPercentage === null || claude.status !== 'ok',
      `status 'ok' with usedPercentage ${claude.fiveHour.usedPercentage} and `
        + `resetsAt ${claude.fiveHour.resetsAt}, which is in the past`,
    );
  });
});

// ------------------------------------------------------------- clock skew

test.describe('clock skew in both directions', () => {
  test('a capture timestamped in the future never produces a negative delta', () => {
    const rl = capture({
      state: 'fresh',
      capturedAtMs: NOW + 10 * MIN,
      five: { usedPercentage: 30, resetsAtMs: NOW + 3 * HOUR },
    });
    const claude = claudeOf(build(rl));
    assert.equal(claude.fiveHour.billableSinceCapture, null);
    assert.equal(claude.fiveHour.usedPercentage, 30);
  });

  test('a far-future capture is stale, and its window rule still applies', () => {
    const rl = capture({
      state: 'stale',
      capturedAtMs: NOW + 6 * HOUR,
      five: { usedPercentage: 30, resetsAtMs: NOW - MIN },
    });
    const claude = claudeOf(build(rl));
    assert.equal(claude.fiveHour.usedPercentage, null, 'a dead window stays dead however skewed the clock');
  });

  test('a capture that predates its own window still reports a non-negative delta', () => {
    const events = [
      { ts: NOW - 10 * MIN, model: 'sonnet', input: 100, output: 50, cacheWrite: 25, cacheRead: 9_000, key: 'a' },
    ];
    const rl = capture({
      state: 'stale',
      capturedAtMs: NOW - 40 * MIN,
      five: { usedPercentage: 30, resetsAtMs: NOW + HOUR },
    });
    const claude = claudeOf(build(rl, { events }));
    assert.equal(claude.fiveHour.billableSinceCapture, 175);
    assert.ok(claude.fiveHour.billableSinceCapture >= 0);
  });
});

// ------------------------------------------------------- degenerate values

test.describe('degenerate but legitimate captures', () => {
  test('zero percent is a real reading and must survive the null checks', () => {
    const rl = capture({
      state: 'fresh',
      capturedAtMs: NOW - MIN,
      five: { usedPercentage: 0, resetsAtMs: NOW + 5 * HOUR },
    });
    const claude = claudeOf(build(rl));
    assert.equal(claude.fiveHour.usedPercentage, 0);
    assert.equal(claude.fiveHour.certainty, 'known');
  });

  test('one hundred percent is a real reading, not an overflow to be dropped', () => {
    const rl = capture({
      state: 'fresh',
      capturedAtMs: NOW - MIN,
      five: { usedPercentage: 100, resetsAtMs: NOW + HOUR },
    });
    assert.equal(claudeOf(build(rl)).fiveHour.usedPercentage, 100);
  });

  test('a percentage with no resetsAt at all is never carried past its freshness budget', () => {
    const fresh = capture({
      state: 'fresh',
      capturedAtMs: NOW - MIN,
      five: { usedPercentage: 55, resetsAtMs: null },
    });
    const stale = capture({
      state: 'stale',
      capturedAtMs: NOW - 2 * HOUR,
      five: { usedPercentage: 55, resetsAtMs: null },
    });
    // With no reset instant there is nothing to age the figure against, so the
    // moment it stops being fresh it stops being defensible.
    assert.equal(claudeOf(build(stale)).fiveHour.usedPercentage, null);
    assert.equal(claudeOf(build(stale)).fiveHour.certainty, 'unknown');
    // While fresh it is the server's own current statement, so it is shown.
    assert.equal(claudeOf(build(fresh)).fiveHour.usedPercentage, 55);
  });

  test('an empty corpus never turns a percentage into a delta of NaN', () => {
    const rl = capture({
      state: 'stale',
      capturedAtMs: NOW - 2 * HOUR,
      five: { usedPercentage: 40, resetsAtMs: NOW + HOUR },
    });
    const claude = claudeOf(build(rl, { events: [] }));
    assert.equal(claude.fiveHour.billableSinceCapture, 0);
    assert.equal(claude.tokens.billable, 0);
    assert.equal(claude.burnRatePerHour, 0);
  });

  test('a corpus holding only out-of-window records contributes nothing', () => {
    const events = [
      { ts: NOW - 30 * HOUR, model: 'sonnet', input: 1e6, output: 1e6, cacheWrite: 1e6, cacheRead: 0, key: 'old' },
    ];
    const rl = capture({
      state: 'stale',
      capturedAtMs: NOW - 2 * HOUR,
      five: { usedPercentage: 40, resetsAtMs: NOW + HOUR },
    });
    const claude = claudeOf(build(rl, { events }));
    assert.equal(claude.tokens.billable, 0);
    assert.equal(claude.fiveHour.billableSinceCapture, 0);
    assert.deepEqual(claude.byModel, []);
  });
});

// ------------------------------------------------- the five silent providers

test.describe('the unconnected providers stay silent under every input', () => {
  test('no percentage, no tokens, no burn rate, whatever Claude reports', () => {
    const inputs = [
      capture({ state: 'missing', capturedAtMs: null }),
      capture({ state: 'invalid', capturedAtMs: null }),
      capture({ state: 'fresh', capturedAtMs: NOW, five: { usedPercentage: 99, resetsAtMs: NOW + HOUR } }),
      capture({ state: 'stale', capturedAtMs: NOW - 3 * HOUR, five: { usedPercentage: 99, resetsAtMs: NOW + HOUR } }),
    ];
    for (const rl of inputs) {
      for (const p of build(rl).providers) {
        // Antigravity joined `claude` on the wired side when its `agy`
        // statusline hook was implemented, and Codex joined it when its
        // session-rollout rate limits were read. Their silence under a
        // Claude-only input (an unknown window, not a null one) is asserted in
        // snapshot.test.js / the codex reader tests, where the reason — a
        // source of their own that nothing has written — can be stated.
        if (p.id === 'claude' || p.id === 'antigravity' || p.id === 'codex') continue;
        assert.equal(p.fiveHour, null, `${p.id} (${rl.state})`);
        assert.equal(p.sevenDay, null, `${p.id} (${rl.state})`);
        assert.equal(p.tokens, null, `${p.id} (${rl.state})`);
        assert.equal(p.burnRatePerHour, null, `${p.id} (${rl.state})`);
        assert.equal(p.planLabel, null, `${p.id} (${rl.state})`);
        assert.equal(p.connected, false, `${p.id} (${rl.state})`);
        assert.equal(p.status, 'passive', `${p.id} (${rl.state})`);
      }
    }
  });
});
