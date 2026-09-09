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
    // UPDATED for the "carry it all the way over" rule. These numbers moved on
    // purpose; the invariants above did not.
    //
    // Row 1 and row 0 are both 64 tall, so leading-edge alignment and the
    // midpoint are the same point and the distance is unchanged in substance —
    // only the boundary is now exclusive on the release side, which is what
    // moves 64 to 65.
    assert.equal(at(LIVE, 1, -65), 0);
    assert.equal(at(LIVE, 1, -64), 1, 'one pixel short must not cross');
    // Row 2 is 44 tall and row 1 is 64. Half-and-half would have been 54, and
    // at 54 the short row has covered barely half of the tall one. It now has
    // to be carried until its top edge reaches row 1's top edge: 65.
    assert.equal(at(LIVE, 2, -65), 1);
    assert.equal(at(LIVE, 2, -64), 2);
  });

  test('and a drag down does too, at a comparable distance', () => {
    // Unchanged from the midpoint rule: dragging DOWN past a row that is not
    // taller than you, you have already covered it at the midpoint, so asking
    // for more travel would mean overshooting the slot being aimed at.
    assert.equal(at(LIVE, 1, 55), 2);
    assert.equal(at(LIVE, 1, 54), 1);
    assert.equal(at(LIVE, 2, 45), 3);
    assert.equal(at(LIVE, 2, 44), 2);
  });

  test('a short row dragged over a tall one must cover it, not halve it', () => {
    // The case the "later than half" change exists for, stated on its own.
    // A 42px row passing a 139px one used to swap after 91px having covered
    // less than a third of it; it now swaps at 140, its top edge level with
    // the tall row's top edge.
    // Row 1 is the 42px row; the 139px row sits above it.
    const SHORT_OVER_TALL = [139, 42];
    assert.equal(at(SHORT_OVER_TALL, 1, -139), 1, 'not yet carried over');
    assert.equal(at(SHORT_OVER_TALL, 1, -140), 0, 'carried over');
    // Half-and-half would have committed at 91, a third of the way up a row
    // the user has not visibly cleared.
    assert.equal(at(SHORT_OVER_TALL, 1, -91), 1, 'the old midpoint commit point');
  });

  test('but a tall row over a short one is not made to overshoot', () => {
    // The mirror case, and the reason the rule takes min() rather than always
    // demanding full coverage: a 139px row has already swallowed a 42px one by
    // the midpoint. Requiring more would drag it past where it will land.
    const TALL_OVER_SHORT = [42, 139];
    assert.equal(at(TALL_OVER_SHORT, 1, -91), 0);
    assert.equal(at(TALL_OVER_SHORT, 1, -90), 1);
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

  test('each threshold is half my height plus as much of theirs as I can cover', () => {
    // UPDATED. The old closed form was "half mine plus half theirs" — the
    // midpoint rule. The commit point is now the LATER of the midpoint and
    // leading-edge alignment, which is the same arithmetic with `theirs / 2`
    // replaced by `theirs - min(mine, theirs) / 2`:
    //
    //   equal heights      -> identical to before (their half)
    //   they are taller    -> more of them must be covered
    //   they are shorter   -> unchanged, because they are already covered
    //
    // Still not a magic number: it is the distance at which my leading edge
    // reaches theirs, or my centre reaches their middle, whichever is later.
    const depth = (mine, theirs) => theirs - Math.min(mine, theirs) / 2;
    for (const [name, heights] of Object.entries(SHAPES)) {
      for (let from = 0; from < heights.length; from++) {
        const { down, up } = thresholds(heights, from);
        const mine = heights[from];
        if (down !== null) {
          const exact = mine / 2 + depth(mine, heights[from + 1]);
          assert.equal(down, Math.floor(exact) + 1, `${name} down ${from}`);
        }
        if (up !== null) {
          const exact = mine / 2 + depth(mine, heights[from - 1]);
          assert.equal(up, -(Math.floor(exact) + 1), `${name} up ${from}`);
        }
      }
    }
  });
});

// -------------------------------------------------------------------------
// 3b. Stickiness: a decision, once made, resists being undone
// -------------------------------------------------------------------------

test.describe('a committed swap does not come undone by a tremor', () => {
  /** Drag until the slot first changes; return the offset and the new slot. */
  function firstSwap(heights, from, direction) {
    let to = from;
    for (let step = 1; step <= 5000; step++) {
      const dy = direction * step;
      const next = R.targetIndexFor(topsOf(heights), heights, from, dy, to);
      if (next !== to) return { dy, to: next };
      to = next;
    }
    return null;
  }

  test('holding a swapped row still, with hand tremor, does not flip it back', () => {
    // The reported "it looks bad": one pixel of tremble on a boundary flipped
    // the target, and paint() slides a neighbour a full row height with a
    // transition on every flip. Simulated here as 40 frames of +/-2px.
    for (const [name, heights] of Object.entries(SHAPES)) {
      for (let from = 0; from < heights.length; from++) {
        for (const direction of [1, -1]) {
          const swap = firstSwap(heights, from, direction);
          if (swap === null) continue;
          let to = swap.to;
          const seen = new Set([to]);
          for (let frame = 0; frame < 40; frame++) {
            const dy = swap.dy + (frame % 2 === 0 ? -2 : 2);
            to = R.targetIndexFor(topsOf(heights), heights, from, dy, to);
            seen.add(to);
          }
          assert.equal(seen.size, 1, `${name} row ${from} dir ${direction}: flipped ${[...seen]}`);
        }
      }
    }
  });

  test('undoing costs real travel, scaled to the rows involved', () => {
    // Stickiness is a fraction of the SMALLER of the two rows, so it is always
    // a visible distance and never wider than the smaller row can afford.
    for (const [name, heights] of Object.entries(SHAPES)) {
      for (let from = 0; from < heights.length; from++) {
        const swap = firstSwap(heights, from, -1);
        if (swap === null) continue;
        const shared = Math.min(heights[from], heights[from - 1]);
        const owed = Math.floor(R.STICK * shared);
        let to = swap.to;
        for (let back = 1; back <= owed; back++) {
          to = R.targetIndexFor(topsOf(heights), heights, from, swap.dy + back, to);
          assert.equal(to, swap.to, `${name} row ${from} reverted after only ${back}px`);
        }
      }
    }
  });

  test('but the FIRST swap is not made sluggish by the stickiness', () => {
    // The asymmetry that matters. A row still sitting where the gesture found
    // it transitions at the plain commit point; only a row that has already
    // given way asks for more. A symmetric deadband would have pushed the
    // first commit past the natural landing point, which is overshoot.
    const depth = (mine, theirs) => theirs - Math.min(mine, theirs) / 2;
    for (const [name, heights] of Object.entries(SHAPES)) {
      for (let from = 1; from < heights.length; from++) {
        const swap = firstSwap(heights, from, -1);
        const exact = heights[from] / 2 + depth(heights[from], heights[from - 1]);
        assert.equal(swap.dy, -(Math.floor(exact) + 1), `${name} row ${from}`);
      }
    }
  });

  test('stickiness never lets a threshold escape the row it belongs to', () => {
    // The prefix property is what makes counting rows a valid INDEX rather
    // than a tally of unrelated tests. It survives only while every threshold
    // stays inside its own row's band, which bounds STICK against `reach`.
    assert.ok(R.STICK <= 0.5, 'STICK must not exceed half a row');
    for (const heights of [LIVE, MIXED_TOP, [42, 139], [139, 42], [200, 20]]) {
      for (let from = 0; from < heights.length; from++) {
        for (let i = 0; i < heights.length; i++) {
          if (i === from) continue;
          const shared = Math.min(heights[from], heights[i]);
          assert.ok(R.STICK * shared <= shared / 2, `${heights[from]} vs ${heights[i]}`);
        }
      }
    }
  });
});

// -------------------------------------------------------------------------
// 3c. The feedback loop paint() actually runs
// -------------------------------------------------------------------------

test.describe('an iterated drag, the way the session drives it', () => {
  /** Replay a whole gesture, feeding each frame's answer into the next. */
  function gesture(heights, from, offsets) {
    let to = from;
    const path = [];
    for (const dy of offsets) {
      to = R.targetIndexFor(topsOf(heights), heights, from, dy, to);
      path.push(to);
    }
    return path;
  }

  const ramp = (endDy, steps = 400) =>
    Array.from({ length: steps }, (_, i) => Math.round((endDy * (i + 1)) / steps));

  test('a steady drag down never moves the row backwards', () => {
    for (const [name, heights] of Object.entries(SHAPES)) {
      for (let from = 0; from < heights.length; from++) {
        const path = gesture(heights, from, ramp(1200));
        for (let i = 1; i < path.length; i++) {
          assert.ok(path[i] >= path[i - 1], `${name} row ${from} went backwards`);
        }
        assert.equal(path[path.length - 1], heights.length - 1, `${name} row ${from} end`);
      }
    }
  });

  test('a steady drag up never moves the row forwards', () => {
    for (const [name, heights] of Object.entries(SHAPES)) {
      for (let from = 0; from < heights.length; from++) {
        const path = gesture(heights, from, ramp(-1200));
        for (let i = 1; i < path.length; i++) {
          assert.ok(path[i] <= path[i - 1], `${name} row ${from} went forwards`);
        }
        assert.equal(path[path.length - 1], 0, `${name} row ${from} end`);
      }
    }
  });

  test('a drag out and back returns the row to where it started', () => {
    // Hysteresis must not be a ratchet: going far and coming all the way home
    // has to end where it began, or a user who changes their mind mid-drag is
    // left holding a move they cancelled.
    for (const [name, heights] of Object.entries(SHAPES)) {
      for (let from = 0; from < heights.length; from++) {
        const out = ramp(900, 200);
        const path = gesture(heights, from, [...out, ...out.slice().reverse(), 0]);
        assert.equal(path[path.length - 1], from, `${name} row ${from}`);
      }
    }
  });

  test('releasing without moving is a no-op however the pointer wandered', () => {
    // A gesture that jitters around zero and lets go must not reorder. This is
    // the pick-up invariant carried through the real feedback loop rather than
    // asserted at a single offset.
    const wander = [0, 3, -3, 2, -1, 4, -4, 1, 0];
    for (const [name, heights] of Object.entries(SHAPES)) {
      for (let from = 0; from < heights.length; from++) {
        const path = gesture(heights, from, wander);
        assert.equal(path[path.length - 1], from, `${name} row ${from}`);
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
    const to = at(LIVE, 1, -65);
    assert.equal(to, 0);
    assert.deepEqual(R.moveId(IDS, 'claude', to)[0], 'claude');
    // And the neighbour holds its ground until the carry is complete, which is
    // the whole of the second report: "it should move down only after you have
    // carried Claude all the way up".
    assert.equal(at(LIVE, 1, -1), 1);
    assert.equal(at(LIVE, 1, -32), 1);
    assert.equal(at(LIVE, 1, -64), 1);
  });

  test('dragging the top row to the bottom leaves it last', () => {
    const to = at(LIVE, 0, 10_000);
    assert.equal(R.moveId(IDS, 'antigravity', to).indexOf('antigravity'), IDS.length - 1);
  });
});
