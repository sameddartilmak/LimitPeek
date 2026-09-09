'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

/**
 * `targetIndexFor` in `src/renderer/src/reorder.ts` — which slot a dragged row
 * lands in.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A user reported that they could drag a row DOWN but not UP: "it throws it
 * back down". The cause was that the old `targetIndex` mixed two coordinate
 * systems — the dragged row's centre came from the ORIGINAL layout while the
 * thresholds were accumulated over the COMPACTED one, the list as if the row
 * had already been lifted out. Those agree only when every row is the same
 * height. This panel's rows are not: a connected row is 64px and a passive one
 * 44px, so on the real six-row shape [64, 64, 44, 44, 44, 44] picking up row 1
 * computed a target of 2 before the pointer moved at all.
 *
 * WHY THE EXISTING TESTS DID NOT CATCH IT
 * ---------------------------------------
 * `test/render/panel.js` drives real OS mouse input and passed throughout. Its
 * fixture uses UNIFORM row heights, and with uniform heights the broken
 * algorithm is accidentally correct — both versions agree on [64, 64]. The bug
 * needs mixed heights to exist at all, so no amount of mouse input against
 * that fixture would ever have found it.
 *
 * It also needed no window. The invariant that broke — "picking a row up does
 * not already move it" — is a property of four numbers, and this file runs in
 * plain `node --test` in milliseconds. That is the lesson worth keeping: the
 * expensive suite was not too weak, it was pointed at the wrong thing.
 *
 * Loaded from the TypeScript source — `reorder.ts` imports `integer` from
 * `format.ts`, so the two are stripped into a throwaway mirror of the `src/`
 * layout where that relative specifier resolves, exactly as
 * `test/helpers/load-format.js` does and for the same reason.
 */
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const strip = (file) => stripTypeScriptTypes(fs.readFileSync(file, 'utf8'), { mode: 'strip' });

let dir = null;
let R;
test.before(async () => {
  const os = require('node:os');
  const { pathToFileURL } = require('node:url');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-reorder-'));
  const files = [
    ['package.json', '{"type":"module"}'],
    [path.join('shared', 'contract.js'), strip(path.join(SRC, 'shared', 'contract.ts'))],
    [
      path.join('renderer', 'src', 'format.js'),
      strip(path.join(SRC, 'renderer', 'src', 'format.ts')),
    ],
    [
      path.join('renderer', 'src', 'reorder.js'),
      strip(path.join(SRC, 'renderer', 'src', 'reorder.ts')),
    ],
  ];
  for (const [rel, body] of files) {
    const out = path.join(dir, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, body, 'utf8');
  }
  R = await import(pathToFileURL(path.join(dir, 'renderer', 'src', 'reorder.js')).href);
});
test.after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/** Contiguous rows, as the panel lays them out. */
function topsOf(heights) {
  const tops = [];
  let acc = 0;
  for (const h of heights) {
    tops.push(acc);
    acc += h;
  }
  return tops;
}
const at = (heights, from, dy) => R.targetIndexFor(topsOf(heights), heights, from, dy);

/** The shape the bug was reported on: two connected rows, four passive. */
const LIVE = [64, 64, 44, 44, 44, 44];
/** What the render fixture uses. The old algorithm is correct here by luck. */
const UNIFORM = [64, 64];
/** A passive row above a connected one — reachable by reordering. */
const MIXED_TOP = [44, 64, 44, 64];
const SHAPES = { LIVE, UNIFORM, MIXED_TOP, TALL_LAST: [44, 44, 64], SINGLE_TALL: [120, 44, 44] };

// -------------------------------------------------------------------------
// 1. The invariant that actually broke
// -------------------------------------------------------------------------

test.describe('picking a row up does not already move it', () => {
  test('dy = 0 lands every row back in its own slot, in every shape', () => {
    for (const [name, heights] of Object.entries(SHAPES)) {
      for (let from = 0; from < heights.length; from++) {
        assert.equal(at(heights, from, 0), from, `${name} row ${from}`);
      }
    }
  });

  test('the reported case specifically: row 1 of [64,64,44,44,44,44] stays at 1', () => {
    // This returned 2 before the fix. Row 1 is Claude Code when the user has
    // put Antigravity on top, and a target of 2 at zero travel is the whole
    // reported bug: the row drops a slot on pick-up, then fights every attempt
    // to drag it back up.
    assert.equal(at(LIVE, 1, 0), 1);
  });

  test('a sub-threshold twitch does not move anything either', () => {
    // The drag does not even start until DRAG_THRESHOLD (4px), so anything
    // inside that must be inert. It was not: the old algorithm flipped row 1
    // at -1px and every row at +1px.
    for (const [name, heights] of Object.entries(SHAPES)) {
      for (let from = 0; from < heights.length; from++) {
        for (const dy of [-3, -1, 1, 3]) {
          assert.equal(at(heights, from, dy), from, `${name} row ${from} dy ${dy}`);
        }
      }
    }
  });
});

// -------------------------------------------------------------------------
// 2. Dragging up works, one boundary at a time
// -------------------------------------------------------------------------

test.describe('a drag up crosses one boundary at a time', () => {
  test('one row up lands exactly one slot higher', () => {
    // Crossing row 0's midpoint means travelling half of my own height plus
    // half of theirs. Row 1 is 64 tall, row 0 is 64 tall: 64px.
    assert.equal(at(LIVE, 1, -64), 0);
    assert.equal(at(LIVE, 1, -63), 1, 'one pixel short must not cross');
    // Row 2 is 44 tall and row 1 is 64: 22 + 32 = 54.
    assert.equal(at(LIVE, 2, -54), 1);
    assert.equal(at(LIVE, 2, -53), 2);
  });

  test('and a drag down does too, at a comparable distance', () => {
    assert.equal(at(LIVE, 1, 55), 2);
    assert.equal(at(LIVE, 1, 54), 1);
    assert.equal(at(LIVE, 2, 45), 3);
    assert.equal(at(LIVE, 2, 44), 2);
  });

  test('a long drag up reaches the top from anywhere', () => {
    for (const [name, heights] of Object.entries(SHAPES)) {
      for (let from = 0; from < heights.length; from++) {
        assert.equal(at(heights, from, -10_000), 0, `${name} row ${from}`);
      }
    }
  });

  test('and a long drag down reaches the bottom', () => {
    for (const [name, heights] of Object.entries(SHAPES)) {
      for (let from = 0; from < heights.length; from++) {
        assert.equal(at(heights, from, 10_000), heights.length - 1, `${name} row ${from}`);
      }
    }
  });
});

// -------------------------------------------------------------------------
// 3. The asymmetry itself
// -------------------------------------------------------------------------

/** Smallest |dy| in each direction that moves the row out of its own slot. */
function thresholds(heights, from) {
  let down = null;
  let up = null;
  for (let dy = 1; dy <= 5000; dy++) {
    if (down === null && at(heights, from, dy) !== from) down = dy;
    if (up === null && at(heights, from, -dy) !== from) up = -dy;
    if (down !== null && up !== null) break;
  }
  return { down, up };
}

test.describe('the two directions cost roughly the same', () => {
  test('no row switches slots on a single pixel of travel', () => {
    // The old algorithm switched at +1px for EVERY row, because the compacted
    // accumulator started at tops[0] while the centre started at tops[from].
    for (const [name, heights] of Object.entries(SHAPES)) {
      for (let from = 0; from < heights.length; from++) {
        const { down, up } = thresholds(heights, from);
        if (down !== null) assert.ok(down > 4, `${name} row ${from} down ${down}`);
        if (up !== null) assert.ok(up < -4, `${name} row ${from} up ${up}`);
      }
    }
  });

  test('up and down are within one row height of each other', () => {
    // The reported symptom stated as a number: it took 1px to go down and a
    // whole row height to come back up.
    const tallest = Math.max(...LIVE);
    for (let from = 0; from < LIVE.length; from++) {
      const { down, up } = thresholds(LIVE, from);
      if (down === null || up === null) continue; // an end row has one side only
      assert.ok(Math.abs(down - Math.abs(up)) <= tallest, `row ${from}: ${down} vs ${up}`);
    }
  });

  test('each threshold is half my height plus half my neighbour’s', () => {
    // Not a magic number: it is the distance at which my centre reaches their
    // midpoint, which is the whole rule stated as arithmetic.
    for (const [name, heights] of Object.entries(SHAPES)) {
      for (let from = 0; from < heights.length; from++) {
        const { down, up } = thresholds(heights, from);
        if (down !== null) {
          assert.equal(down, heights[from] / 2 + heights[from + 1] / 2 + 1, `${name} down ${from}`);
        }
        if (up !== null) {
          assert.equal(up, -(heights[from] / 2 + heights[from - 1] / 2), `${name} up ${from}`);
        }
      }
    }
  });
});

// -------------------------------------------------------------------------
// 4. Properties that must hold whatever the panel looks like
// -------------------------------------------------------------------------

test.describe('properties, over randomised mixed-height panels', () => {
  const shapes = [];
  // Deterministic: a seeded walk rather than Math.random, so a failure names a
  // shape that can be reproduced.
  let seed = 20260909;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const STEPS = [44, 64, 88, 120, 152];
  for (let i = 0; i < 400; i++) {
    const len = 2 + Math.floor(next() * 7);
    shapes.push(Array.from({ length: len }, () => STEPS[Math.floor(next() * STEPS.length)]));
  }

  test('the index never decreases as the row is dragged further down', () => {
    // Monotonicity is what stops a row flickering between two slots while the
    // pointer moves steadily in one direction.
    for (const heights of shapes.slice(0, 60)) {
      for (let from = 0; from < heights.length; from++) {
        let prev = -1;
        for (let dy = -900; dy <= 900; dy += 3) {
          const value = at(heights, from, dy);
          assert.ok(value >= prev, `${JSON.stringify(heights)} row ${from} at ${dy}`);
          prev = value;
        }
      }
    }
  });

  test('the result is always a valid slot', () => {
    for (const heights of shapes) {
      for (let from = 0; from < heights.length; from++) {
        for (const dy of [-1e6, -100, 0, 100, 1e6]) {
          const value = at(heights, from, dy);
          assert.ok(
            Number.isInteger(value) && value >= 0 && value <= heights.length - 1,
            `${JSON.stringify(heights)} row ${from} dy ${dy} -> ${value}`,
          );
        }
      }
    }
  });

  test('every slot is reachable from every row', () => {
    // The property the first proposed fix quietly broke: it held the pick-up
    // invariant but, fed the CLAMPED offset the way paint() used to, left the
    // end slots unreachable — on [64, 64] the top row could not be dragged
    // down at all. paint() now passes the raw offset for exactly this reason.
    for (const heights of shapes) {
      for (let from = 0; from < heights.length; from++) {
        const seen = new Set();
        for (let dy = -2000; dy <= 2000; dy += 1) seen.add(at(heights, from, dy));
        assert.equal(
          seen.size,
          heights.length,
          `${JSON.stringify(heights)} row ${from} reached ${[...seen].sort().join(',')}`,
        );
      }
    }
  });

  test('the pick-up invariant holds for every shape', () => {
    for (const heights of shapes) {
      for (let from = 0; from < heights.length; from++) {
        assert.equal(at(heights, from, 0), from, JSON.stringify(heights));
      }
    }
  });
});

// -------------------------------------------------------------------------
// 5. It composes with moveId, which is what actually reorders
// -------------------------------------------------------------------------

test.describe('the index means what moveId thinks it means', () => {
  const IDS = ['antigravity', 'claude', 'codex', 'gemini', 'copilot', 'kimi'];

  test('a zero-travel drag is a no-op end to end', () => {
    for (let from = 0; from < LIVE.length; from++) {
      const to = at(LIVE, from, 0);
      assert.deepEqual(R.moveId(IDS, IDS[from], to), IDS);
    }
  });

  test('dragging Claude up one slot puts Claude on top', () => {
    // The user's sentence, as a test: Antigravity is first, Claude is second,
    // and dragging Claude up must make Claude first.
    const to = at(LIVE, 1, -64);
    assert.equal(to, 0);
    assert.deepEqual(R.moveId(IDS, 'claude', to)[0], 'claude');
  });

  test('dragging the top row to the bottom leaves it last', () => {
    const to = at(LIVE, 0, 10_000);
    assert.equal(R.moveId(IDS, 'antigravity', to).indexOf('antigravity'), IDS.length - 1);
  });
});
