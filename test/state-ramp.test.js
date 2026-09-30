'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { formatModule } = require('./helpers/load-format');
const { STATE_THRESHOLDS } = require('../src/shared/contract.js');

/**
 * THE CONTINUOUS STATE RAMP (src/renderer/src/format.ts, `mixWithin`).
 *
 * The bar's colour used to hold one value across a whole band — everything
 * below 60% was the same green — so "the colour changes as usage rises" was
 * true only three times in the range. It now mixes between the anchors it
 * already had.
 *
 * Two properties make that honest rather than decorative, and both are here:
 *
 *   1. It says ONLY what the number says. The position is derived from the
 *      ROUNDED percentage, the same input `stateFor` uses, so the colour cannot
 *      be a step ahead of the printed figure. Anything else — a rate, a
 *      prediction, a "you are about to run out" — would be colour making a
 *      claim the panel has no basis for.
 *   2. The anchors do not move. Every contrast ratio measured in tokens.css is
 *      a property of a step's own colour, and each one is still hit exactly at
 *      its threshold; interpolation only fills the gaps.
 *
 * The CSS half — mixing in OKLAB, and desaturating rather than holding neutral
 * for uncertain readings — is asserted below by reading the stylesheet, because
 * a computed colour needs a compositor and the rule does not.
 */

let fmt;
const mod = formatModule();
test.before(async () => { fmt = await mod.load(); });
test.after(() => mod.cleanup());

test.describe('the mix position is derived from the printed number, and nothing else', () => {
  test('each step starts at 0 at its own anchor', () => {
    assert.equal(fmt.mixWithin(0), 0);
    assert.equal(fmt.mixWithin(STATE_THRESHOLDS.watch), 0);
    assert.equal(fmt.mixWithin(STATE_THRESHOLDS.ember), 0);
  });

  test('and approaches 1 as it reaches the next one', () => {
    assert.ok(fmt.mixWithin(STATE_THRESHOLDS.watch - 1) > 0.97);
    assert.ok(fmt.mixWithin(STATE_THRESHOLDS.ember - 1) > 0.95);
    assert.ok(fmt.mixWithin(STATE_THRESHOLDS.spent - 1) > 0.9);
  });

  test('it moves at EVERY percent below the first threshold, which is the whole point', () => {
    // The band that used to be flat. If this ever returns the same value twice
    // in a row, the owner's request is unimplemented again.
    const seen = new Set();
    for (let p = 0; p < STATE_THRESHOLDS.watch; p += 1) seen.add(fmt.mixWithin(p));
    assert.equal(seen.size, STATE_THRESHOLDS.watch, 'the sub-60 band is flat again');
  });

  test('spent does not mix: there is no anchor beyond it', () => {
    assert.equal(fmt.mixWithin(STATE_THRESHOLDS.spent), 0);
    assert.equal(fmt.mixWithin(140), 0);
  });

  test('it is driven by the ROUNDED value, like the step and the printed figure', () => {
    // 59.6 prints as %60 and is already `watch`; the mix must be reading the
    // watch segment too, or the colour is a step behind the number beside it.
    assert.equal(fmt.stateFor(59.6), 'watch');
    assert.equal(fmt.mixWithin(59.6), fmt.mixWithin(60));
    assert.equal(fmt.mixWithin(59.4), fmt.mixWithin(59));
  });

  test('it never leaves 0..1, including on impossible input', () => {
    for (const p of [-40, -0.4, 0, 33.3, 99.9, 100, 1e6]) {
      const m = fmt.mixWithin(p);
      assert.ok(m >= 0 && m <= 1, `${p} -> ${m}`);
    }
  });
});

/* ------------------------------------------------- the rule, read from CSS */

const css = (name) => fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles', name), 'utf8');

test.describe('the ramp is mixed the way the design requires', () => {
  const ROW = () => css('row.css');

  test('every step but the last mixes toward the NEXT anchor', () => {
    const body = ROW();
    for (const [step, next] of [['calm', 'watch'], ['watch', 'ember'], ['ember', 'spent']]) {
      const rule = new RegExp(
        `\\.win\\[data-state="${step}"\\][^}]*color-mix\\(in oklab, var\\(--${step}\\),\\s*var\\(--${next}\\)`,
      );
      assert.match(body, rule, `.win ${step} does not mix toward ${next}`);
    }
    assert.match(body, /\.win\[data-state="spent"\]\s*\{\s*--state: var\(--spent\);/,
      'spent must not mix: there is no anchor past it');
  });

  test('the mix happens in OKLAB, not sRGB', () => {
    // A straight sRGB blend between two saturated hues dips through a muddy,
    // darker midpoint — and the midpoint is where most readings sit. OKLAB also
    // keeps LUMINANCE moving along the ramp, which is what makes it readable as
    // a ramp without hue.
    // Only the RAMP's mixes. The brand-accent tints elsewhere in this file are
    // deliberately `in srgb` — they tint a ground toward a hex the provider
    // chose, which is a different job from walking a perceptual scale.
    const ramp = (ROW().match(/--state: color-mix\([^;]*/g) || []);
    assert.ok(ramp.length >= 9, `expected the ramp rules, found ${ramp.length}`);
    for (const m of ramp) assert.match(m, /in oklab/, m);
  });

  test('the row, its window blocks and the quota head all take the same ramp', () => {
    // Two renderers of one number drifting apart is the defect tray-spec.js
    // records; the same hazard exists inside the panel.
    const body = ROW();
    for (const sel of ['\\.win', '\\.row', '\\.quota__head']) {
      assert.match(body, new RegExp(`${sel}\\[data-state="calm"\\][^}]*color-mix`), `${sel} is not on the ramp`);
    }
  });
});

test.describe('an uncertain reading never gets a more confident colour', () => {
  test('estimated desaturates toward the meta ink', () => {
    // An estimate says "about" in words; a saturated colour beside it would be
    // the colour contradicting the sentence.
    const body = css('row.css');
    const block = body.slice(body.lastIndexOf('.rail__fill--estimated {'));
    const rule = block.slice(0, block.indexOf('}') + 1);
    assert.match(rule, /color-mix\(in oklab/, rule);
    assert.match(rule, /var\(--state/, rule);
    assert.match(rule, /var\(--ink-400\)/, rule);
  });

  test('a stale figure drops to neutral ink, and its bar keeps the position at 45% under a hatch', () => {
    // UI plan 2026-09-29: a stale figure is still TRUE but not current. The
    // figure loses the ramp colour entirely; the bar keeps it faded and
    // hatched, so the position survives but no longer reads as a live gauge.
    const body = css('row.css');
    assert.match(body, /\.row\[data-status="stale"\] \.win__pct \{ color: var\(--ink-300\); \}/);
    const block = body.slice(body.indexOf('.row[data-status="stale"] .rail__fill,'));
    const rule = block.slice(0, block.indexOf('}') + 1);
    assert.match(rule, /opacity: \.45/, rule);
    assert.match(rule, /repeating-linear-gradient/, rule);
  });

  test('error is drained entirely, which is the stronger form of the same idea', () => {
    assert.match(css('row.css'), /\.row\[data-status="error"\] \.rail__fill \{ background-color: var\(--ink-400\)/);
  });

  test('a window with no step takes no ramp colour at all', () => {
    // "We cannot say" is not a level on the ramp, so there is no --state to
    // mix and the fallback ink is what shows.
    const body = css('row.css');
    assert.match(body, /\.win__pct \{[^}]*color: var\(--state, var\(--ink-100\)\)/);
    assert.match(body, /\.rail__fill \{[\s\S]{0,200}background: var\(--state, var\(--calm\)\)/);
  });
});
