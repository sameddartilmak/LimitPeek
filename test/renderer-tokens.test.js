'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

/**
 * `src/renderer/src/tokens.ts` — the renderer's only reader for absolute token
 * counts. Three rules live in it and each one fails SILENTLY when it regresses,
 * which is why they are tested at this level rather than only in the panel:
 *
 *   1. An all-zero breakdown is "no count", never a zero to print. It is what
 *      an unreadable count degrades to at the IPC boundary AND what main sends
 *      for a week whose records could not be read (ADR-002 A3.19), and printing
 *      it would present a no-figure state as a measured zero.
 *   2. Whether a COUNT is a lower bound comes from main's own flags and from
 *      nothing else — never from `PeriodUsage.isFloor`, which is a statement
 *      about dollars.
 *   3. Counts are never summed across tools (ADR-001). The module deliberately
 *      exposes no function that takes a period and returns a number.
 *
 * Loaded from the TypeScript source: its only imports are type-only, so type
 * stripping leaves a standalone module. No DOM, no new dependency.
 */
const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'src', 'renderer', 'src', 'tokens.ts');

let m;
test.before(async () => {
  const js = stripTypeScriptTypes(fs.readFileSync(SOURCE, 'utf8'), { mode: 'strip' });
  m = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
});

const tk = (patch = {}) => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, billable: 0, ...patch });

test.describe('presence is null vs non-null; a zero is a measurement', () => {
  test('an all-zero breakdown is NOT absent - it is a counted zero', () => {
    // The defect this replaces: the presence test used to be "any class
    // non-zero", so a quota week with no usage rendered "could not be counted"
    // although we had counted it and the answer was zero.
    assert.equal(m.allZero(tk()), true);
    assert.equal(m.hasBillableCount(tk()), false, 'no positive figure for a bound to qualify');
    assert.equal(m.hasTokenCount(tk()), false, 'and no classes worth a tooltip');
  });

  test('hasBillableCount tests the quantity every caller actually PRINTS', () => {
    // The second defect, found in review: the guard tested "any class non-zero"
    // while every caller printed `billable`, so a cacheRead-only breakdown
    // passed and rendered "en az 0 token".
    const cachedOnly = tk({ cacheRead: 9_000_000 });
    assert.equal(m.hasBillableCount(cachedOnly), false, 'billable is what gets printed, and it is 0');
    assert.equal(m.hasTokenCount(cachedOnly), true, 'but the class breakdown still has something to say');
    assert.equal(m.allZero(cachedOnly), false, 'and it is not the A3.19 zero either');
  });

  test('a positive billable figure has a count to bound', () => {
    assert.equal(m.hasBillableCount(tk({ billable: 1 })), true);
  });

  test('null and undefined are the only absent states', () => {
    for (const absent of [null, undefined]) {
      assert.equal(m.hasBillableCount(absent), false, String(absent));
      assert.equal(m.hasTokenCount(absent), false, String(absent));
      assert.equal(m.allZero(absent), false, 'absent is not "all zero" - it is absent');
    }
  });

  test('"en az" is never printed without a positive figure for it to qualify', () => {
    // Both routes to "en az 0 token" are closed: an entirely zero count, and a
    // count whose only non-zero class is cacheRead (which the contract does NOT
    // exempt, because it is not entirely zero).
    assert.equal(m.marksFloor(tk(), ['unread-range']), false);
    assert.equal(m.marksFloor(tk({ cacheRead: 9_000_000 }), ['unrecorded-writes']), false);
    assert.equal(m.marksFloor(tk({ billable: 10 }), ['unrecorded-writes']), true);
    // No causes, no marker, whatever the figure.
    assert.equal(m.marksFloor(tk({ billable: 10 }), []), false);
  });
});

test.describe('a token floor arrives as CAUSES, never derived from dollars', () => {
  test('the row causes are read from weeklyTokenFloorCauses and nowhere else', () => {
    assert.deepEqual(m.weeklyTokenFloorCauses({ weeklyTokenFloorCauses: ['unrecorded-writes'] }), ['unrecorded-writes']);
    for (const value of [undefined, null, 'unread-range', 7, {}]) {
      assert.deepEqual(m.weeklyTokenFloorCauses({ weeklyTokenFloorCauses: value }), [], JSON.stringify(value));
    }
  });

  test('a row whose COST is a floor does not thereby have a floor COUNT', () => {
    // The monetary causes counted every token they saw. A3.16 also means the
    // renderer cannot borrow a cost cause to explain a token bound: a Gemini week
    // where nothing priced is a token floor while unrecordedCalls is false.
    const row = {
      weeklyTokenFloorCauses: [],
      weeklyCost: { sourceIncomplete: true, unrecordedCalls: true, unrecordedWriteEvents: 12 },
    };
    assert.deepEqual(m.weeklyTokenFloorCauses(row), []);
  });

  test('the period causes are read per tool, and never from isFloor', () => {
    const period = {
      tokensByProvider: {},
      tokenFloorCausesByProvider: { codex: ['unrecorded-writes'] },
      isFloor: true,
    };
    assert.deepEqual(m.tokenFloorCausesFor(period, 'codex'), ['unrecorded-writes']);
    assert.deepEqual(m.tokenFloorCausesFor(period, 'claude'), []);
  });

  test('a missing or malformed cause map adds no claim', () => {
    for (const map of [undefined, null, 'codex', 7, [], { codex: 'unrecorded-writes' }]) {
      assert.deepEqual(m.tokenFloorCausesFor({ tokensByProvider: {}, tokenFloorCausesByProvider: map }, 'codex'), [], JSON.stringify(map));
    }
  });

  test('a floor can never be represented without a reason', () => {
    // The point of causes over a boolean: no value of this field means
    // "a floor, reason unknown", so ADR-002 A3.16 cannot be violated by data.
    assert.equal(m.marksFloor(tk({ billable: 5 }), m.weeklyTokenFloorCauses({ weeklyTokenFloorCauses: [] })), false);
  });
});

test.describe('counts are read one tool at a time and never merged', () => {
  const period = {
    tokensByProvider: {
      claude: tk({ billable: 1000, cacheRead: 90_000 }),
      codex: tk({ billable: 250 }),
      gemini: tk(),
    },
    tokenFloorCausesByProvider: {},
  };

  test('one tool\'s figure comes back whole', () => {
    assert.equal(m.tokensFor(period, 'claude').billable, 1000);
    assert.equal(m.tokensFor(period, 'codex').billable, 250);
  });

  test('a tool with no entry reads as absent; a tool with a zero entry reads as ZERO', () => {
    assert.equal(m.tokensFor(period, 'kimi'), null, 'no entry: nothing to show');
    // A counted zero is a measurement and must survive to the screen. Treating
    // it as absent is the defect this rule exists to prevent.
    assert.notEqual(m.tokensFor(period, 'gemini'), null);
    assert.equal(m.tokensFor(period, 'gemini').billable, 0);
  });

  test('providersWithTokens returns IDS, in the order main listed the tools', () => {
    const ids = m.providersWithTokens(period, ['claude', 'codex', 'gemini', 'kimi']);
    // Gemini is listed: it has a counted zero, which is a figure, not an absence.
    assert.deepEqual(ids, ['claude', 'codex', 'gemini']);
    // A tool main forgot to list is still shown rather than silently dropped.
    assert.deepEqual(m.providersWithTokens(period, ['codex']), ['codex', 'claude', 'gemini']);
  });

  test('the module exposes no function that turns a period into one number', () => {
    // The merged cross-tool total is the figure ADR-001 bans, and
    // `tokensByProvider` is a map, so one reduce would produce it. The guard is
    // that no such accessor exists: every numeric path needs a provider id.
    const exported = Object.keys(m).sort();
    assert.deepEqual(exported, [
      'allZero',
      'hasBillableCount',
      'hasTokenCount',
      'marksFloor',
      'modelTokens',
      'providersWithTokens',
      'tokenFloorCausesFor',
      'tokensFor',
      'weeklyTokenFloorCauses',
    ]);
    for (const name of exported) {
      const source = fs.readFileSync(SOURCE, 'utf8');
      assert.doesNotMatch(source, /Object\.values\([^)]*tokensByProvider/, 'no reduce over the map');
      assert.equal(typeof m[name], 'function', name);
    }
  });
});
