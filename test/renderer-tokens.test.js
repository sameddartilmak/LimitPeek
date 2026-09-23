'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

/**
 * `src/renderer/src/tokens.ts` — the renderer's only reader for absolute token
 * counts. Two rules live in it and each one fails SILENTLY when it regresses,
 * which is why they are tested at this level rather than only in the panel:
 *
 *   1. An all-zero breakdown is "no count", never a zero to print. It is what
 *      an unreadable count degrades to at the IPC boundary AND what main sends
 *      for a week whose records could not be read (ADR-002 A3.19), and printing
 *      it would present a no-figure state as a measured zero.
 *   2. Counts are never summed across tools (ADR-001). The module deliberately
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
    assert.equal(m.hasTokenCount(tk()), false, 'no classes worth a tooltip');
  });

  test('a cacheRead-only breakdown still has classes to show, and is not the A3.19 zero', () => {
    const cachedOnly = tk({ cacheRead: 9_000_000 });
    assert.equal(m.hasTokenCount(cachedOnly), true, 'the class breakdown still has something to say');
    assert.equal(m.allZero(cachedOnly), false, 'and it is not the A3.19 zero either');
  });

  test('null and undefined are the only absent states', () => {
    for (const absent of [null, undefined]) {
      assert.equal(m.hasTokenCount(absent), false, String(absent));
      assert.equal(m.allZero(absent), false, 'absent is not "all zero" - it is absent');
    }
  });

});

test.describe('the floor marker is gone from the renderer, not just hidden', () => {
  test('no helper that decides "en az" or reads a floor cause is left to call', () => {
    // The owner removed the marker (2026-09-23). Main still sends the cause
    // fields; a helper that read them would be a way back in for the marker.
    for (const name of ['marksFloor', 'hasBillableCount', 'weeklyTokenFloorCauses', 'tokenFloorCausesFor']) {
      assert.equal(name in m, false, name);
    }
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
      'hasTokenCount',
      'modelTokens',
      'providersWithTokens',
      'tokensFor',
    ]);
    for (const name of exported) {
      const source = fs.readFileSync(SOURCE, 'utf8');
      assert.doesNotMatch(source, /Object\.values\([^)]*tokensByProvider/, 'no reduce over the map');
      assert.equal(typeof m[name], 'function', name);
    }
  });
});
