'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  STATE_THRESHOLDS,
  stateForPercentage,
  drawablePercentage,
  traySpecFromSnapshot,
  trayIconKey,
} = require('../src/core/tray-spec');
const {
  drawDonut, parseHex, inNoDataGap, dotColour,
  rampFor, trackFor, noDataRingFor, neutralAccentFor,
  RAMP, RAMPS, TRACK, TRACKS, NO_DATA_RINGS, NEUTRAL_ACCENTS, GEOMETRY,
} = require('../src/core/donut');
const { FALLBACK_ACCENT: NEUTRAL_SENTINEL } = require('../src/core/tray-spec');

const ROOT = path.join(__dirname, '..');

/* ------------------------------------------------------------- helpers */

function provider(over = {}) {
  return {
    id: 'claude',
    displayName: 'Claude Code',
    accent: '#C96442',
    connected: true,
    status: 'ok',
    fiveHour: { usedPercentage: 50, certainty: 'known', resetsAt: null },
    ...over,
  };
}

function snapshot(providers) {
  return { generatedAt: new Date().toISOString(), providers };
}

/**
 * An Antigravity-shaped row: a headline `fiveHour` (the SELECTED model) plus a
 * `modelQuotas` breakdown whose `groups[0]` is the most-consumed one. F7 made
 * these diverge, and the tray must read the breakdown's most-consumed group,
 * never the headline.
 */
function antigravityRow(over = {}) {
  return {
    id: 'antigravity',
    displayName: 'Antigravity',
    accent: '#E8B84B',
    connected: true,
    status: 'ok',
    fiveHour: { usedPercentage: 5, certainty: 'known', resetsAt: null },
    sevenDay: null,
    modelQuotas: {
      groups: [
        { usedPercentage: 92, resetsAt: null, members: ['Claude Opus 4.6'] },
        { usedPercentage: 5, resetsAt: null, members: ['Gemini 3.1 Pro'] },
      ],
      diverged: true,
      selectedModel: 'Gemini 3.1 Pro',
      selectedGroupIndex: 1,
      source: 'antigravity.ide.quota_info.remaining_fraction',
      provenance: 'derived',
      capturedAt: new Date().toISOString(),
    },
    ...over,
  };
}

/** Reads one pixel as { r, g, b, a } out of the premultiplied BGRA buffer. */
function pixel(buf, size, x, y) {
  const i = (y * size + x) * 4;
  return { b: buf[i], g: buf[i + 1], r: buf[i + 2], a: buf[i + 3] };
}

/**
 * Samples the middle of the ring at an angle measured from 12 o'clock,
 * clockwise — the same convention the renderer draws in.
 */
function ringPixel(buf, size, degrees) {
  const centre = (size - 1) / 2;
  const rOut = (size / 2) * GEOMETRY.outerRatio;
  const rMid = (rOut + rOut * GEOMETRY.innerRatio) / 2;
  const rad = (degrees / 180) * Math.PI;
  const x = Math.round(centre + rMid * Math.sin(rad));
  const y = Math.round(centre - rMid * Math.cos(rad));
  return pixel(buf, size, x, y);
}

function isColour(px, hex) {
  const [r, g, b] = parseHex(hex);
  // Fully covered interior pixels are opaque, so premultiplied == straight.
  return px.a === 255 && px.r === r && px.g === g && px.b === b;
}

/* -------------------------------------------- state from ROUNDED percent */

test.describe('the tray follows the most-consumed model, not the selected one', () => {
  // F7 split the surfaces: the panel headline names the selected model, the
  // 16px tray cannot, so the tray shows the binding constraint — the worst
  // group. These assert the tray reads the breakdown, not the headline.
  test('the donut draws the most-consumed group, not the headline', () => {
    const spec = traySpecFromSnapshot(snapshot([antigravityRow()]));
    assert.equal(spec.usedPercentage, 92, 'the worst group, not the selected 5');
    assert.equal(spec.state, 'ember', '92 is ember; spent is 100');
  });

  test('drawablePercentage ignores the selected headline for a provider with a breakdown', () => {
    assert.equal(drawablePercentage(antigravityRow()), 92);
  });

  test('a provider WITHOUT a breakdown still uses its own fiveHour', () => {
    // Claude has no modelQuotas: the tray must not regress for it.
    assert.equal(drawablePercentage(provider({ fiveHour: { usedPercentage: 40, certainty: 'known', resetsAt: null } })), 40);
  });

  test('an empty breakdown falls through to fiveHour rather than blanking', () => {
    const row = antigravityRow({ modelQuotas: { groups: [], diverged: false, selectedModel: null, selectedGroupIndex: null, source: 'antigravity.ide.quota_info.remaining_fraction', provenance: 'derived', capturedAt: new Date().toISOString() } });
    assert.equal(drawablePercentage(row), 5, 'no groups -> the headline window is all there is');
  });

  test('the most-consumed group obeys the same reject-do-not-clamp rule', () => {
    const row = antigravityRow();
    row.modelQuotas.groups[0].usedPercentage = 250;
    assert.equal(drawablePercentage(row), null, 'an impossible worst figure draws the no-data ring, not a full one');
  });

  test('a disconnected antigravity row draws no sweep from its breakdown either', () => {
    assert.equal(drawablePercentage(antigravityRow({ connected: false })), null);
  });
});

test.describe('the state ramp reads the ROUNDED percentage', () => {
  test('the thresholds come from the contract, not from a local copy', () => {
    // The tray and the panel meter are two renderers of one number. This value
    // is declared once, in contract.ts, and contract-mirror.test.js fails on
    // drift; this pin is the behavioural half of the same guarantee.
    assert.deepEqual({ ...STATE_THRESHOLDS }, { watch: 60, ember: 85, spent: 100 });
  });

  test('each band', () => {
    assert.equal(stateForPercentage(0), 'calm');
    assert.equal(stateForPercentage(59), 'calm');
    assert.equal(stateForPercentage(60), 'watch');
    assert.equal(stateForPercentage(84), 'watch');
    assert.equal(stateForPercentage(85), 'ember');
    assert.equal(stateForPercentage(99), 'ember');
    assert.equal(stateForPercentage(100), 'spent');
    assert.equal(stateForPercentage(140), 'spent');
  });

  test('it steps exactly where the printed number does, not where the raw one does', () => {
    // The panel prints Math.round(value). 59.5 prints as %60, so the icon must
    // already be watch; 59.4 prints as %59 and must still be calm. Comparing
    // the raw value would put the icon one step behind the number beside it —
    // the renderer's F9, reintroduced on the tray.
    assert.equal(stateForPercentage(59.4), 'calm');
    assert.equal(stateForPercentage(59.5), 'watch');
    assert.equal(stateForPercentage(84.5), 'ember');
    assert.equal(stateForPercentage(99.5), 'spent');
    assert.equal(stateForPercentage(99.49), 'ember');
  });

  test('a non-number is no state at all', () => {
    for (const bad of [null, undefined, NaN, Infinity, '80']) {
      assert.equal(stateForPercentage(bad), 'none');
    }
  });
});

/* ------------------------------------------------------------- no-data */

test.describe('the no-data path (contract.ts, TrayIconSpec)', () => {
  const noData = [
    ['fiveHour is null', { fiveHour: null }],
    ['certainty is unknown', { fiveHour: { usedPercentage: null, certainty: 'unknown' } }],
    ['unknown WITH a percentage still present', { fiveHour: { usedPercentage: 91, certainty: 'unknown' } }],
    ['usedPercentage is null', { fiveHour: { usedPercentage: null, certainty: 'known' } }],
    ['usedPercentage is not a number', { fiveHour: { usedPercentage: '80', certainty: 'known' } }],
    ['fiveHour is absent entirely', { fiveHour: undefined }],
  ];

  for (const [name, over] of noData) {
    test(`${name} -> no percentage, state 'none'`, () => {
      assert.equal(drawablePercentage(provider(over)), null);
      const spec = traySpecFromSnapshot(snapshot([provider(over)]));
      assert.equal(spec.usedPercentage, null);
      assert.equal(spec.state, 'none');
    });
  }

  test('a weekly-only provider draws its weekly figure, not the no-data ring', () => {
    // Antigravity publishes a weekly quota and no five-hour one. Before the
    // fallback, `traySpecFromSnapshot` returned null here while `buildTooltip`
    // on the SAME snapshot said `Haftalık limit: %98`: a blank glanceable
    // surface beside a real 98%, which errs optimistic, and two surfaces
    // disagreeing about one number.
    const weeklyOnly = provider({
      id: 'antigravity',
      displayName: 'Antigravity',
      accent: '#E8B84B',
      fiveHour: { usedPercentage: null, certainty: 'unknown', resetsAt: null },
      sevenDay: { usedPercentage: 98, certainty: 'known', resetsAt: null },
    });
    assert.equal(drawablePercentage(weeklyOnly), 98);
    const spec = traySpecFromSnapshot(snapshot([weeklyOnly]));
    assert.equal(spec.usedPercentage, 98);
    assert.equal(spec.state, 'ember');
  });

  test('the fallback is second, never first: a five-hour figure always wins', () => {
    // The order matters when both exist. The five-hour window is the shorter
    // and the more urgent one, and it is what the icon has always meant.
    const both = provider({
      fiveHour: { usedPercentage: 20, certainty: 'known', resetsAt: null },
      sevenDay: { usedPercentage: 95, certainty: 'known', resetsAt: null },
    });
    assert.equal(drawablePercentage(both), 20);
  });

  test('the fallback obeys every rule the five-hour path does', () => {
    // It routes through the same `windowPercentage`, so a disconnected row, an
    // unknown certainty, an out-of-range value and an imminent reset must all
    // still produce the no-data ring rather than a weekly figure sneaking past.
    const cases = [
      ['disconnected', { connected: false, sevenDay: { usedPercentage: 98, certainty: 'known' } }],
      ['unknown certainty', { sevenDay: { usedPercentage: 98, certainty: 'unknown' } }],
      ['out of range', { sevenDay: { usedPercentage: 250, certainty: 'known' } }],
      ['resetting now', { sevenDay: { usedPercentage: 98, certainty: 'known', resetsAt: new Date(Date.now() + 1000).toISOString() } }],
    ];
    for (const [name, over] of cases) {
      const p = provider({ fiveHour: { usedPercentage: null, certainty: 'unknown' }, ...over });
      assert.equal(drawablePercentage(p), null, name);
      assert.equal(traySpecFromSnapshot(snapshot([p])).state, 'none', name);
    }
  });

  test('a disconnected provider draws NO sweep, not just a neutral dot', () => {
    // One predicate governs both halves. Previously accentOf() checked
    // `connected` and drawablePercentage() did not, so a disconnected row
    // could in principle show a grey dot inside a fully ramped coloured arc.
    const disconnected = provider({
      connected: false,
      fiveHour: { usedPercentage: 91, certainty: 'known' },
    });
    assert.equal(drawablePercentage(disconnected), null);
    const spec = traySpecFromSnapshot(snapshot([disconnected]));
    assert.equal(spec.state, 'none');
    assert.equal(spec.accent, '#6B7A77');
    const size = 32;
    const buf = drawDonut(size, spec);
    assert.ok(isColour(ringPixel(buf, size, 45), TRACK), 'no ramp colour may be drawn');
    assert.equal(ringPixel(buf, size, 0).a, 0, 'and it must be the broken no-data ring');
  });

  test('a disconnected provider gets the neutral dot, not its brand colour', () => {
    // The panel renders a disconnected row monochrome; the tray must not be
    // the one surface still claiming that provider is live.
    const spec = traySpecFromSnapshot(snapshot([provider({ connected: false, fiveHour: null })]));
    assert.equal(spec.accent, '#6B7A77');
    assert.equal(traySpecFromSnapshot(snapshot([provider({ connected: true })])).accent, '#C96442');
  });

  test('the lead provider is NOT swapped for one that still has data', () => {
    // The user dragged that row to the top; retargeting the icon to another
    // provider would be a lie they cannot see. The broken ring is the honest
    // answer and it is legible, so honesty costs nothing here.
    const snap = snapshot([
      provider({ id: 'kimi', displayName: 'Kimi', accent: '#2B6BE8', connected: false, fiveHour: null }),
      provider({ fiveHour: { usedPercentage: 80, certainty: 'known' } }),
    ]);
    const spec = traySpecFromSnapshot(snap);
    assert.equal(spec.usedPercentage, null, 'the icon must describe providers[0], not the first drawable row');
    assert.equal(spec.state, 'none');
    assert.ok(trayIconKey(snap).startsWith('kimi|'));
  });

  test('an empty snapshot is no-data, not a throw', () => {
    for (const bad of [null, undefined, {}, { providers: [] }, { providers: null }, { providers: [null] }]) {
      const spec = traySpecFromSnapshot(bad);
      assert.equal(spec.usedPercentage, null);
      assert.equal(spec.state, 'none');
    }
  });

  test("a 'stale' row is NOT no-data: its percentage is still true of an open window", () => {
    const stale = provider({
      status: 'stale',
      fiveHour: { usedPercentage: 62, certainty: 'known', capturedAt: '2026-09-08T10:00:00.000Z' },
    });
    assert.equal(drawablePercentage(stale), 62);
    assert.equal(traySpecFromSnapshot(snapshot([stale])).state, 'watch');
  });

  test('no-data draws the ring and NO sweep', () => {
    const size = 32;
    const buf = drawDonut(size, traySpecFromSnapshot(snapshot([provider({ fiveHour: null })])));
    // Mid-quadrant, i.e. between the four gaps.
    for (const deg of [45, 135, 225, 315]) {
      const px = ringPixel(buf, size, deg);
      assert.ok(isColour(px, TRACK), `ring at ${deg} deg is not the track colour`);
    }
    // ...and not one pixel anywhere carries a ramp colour.
    for (const hex of Object.values(RAMP)) {
      const [r, g, b] = parseHex(hex);
      for (let i = 0; i < buf.length; i += 4) {
        assert.ok(
          !(buf[i + 3] === 255 && buf[i + 2] === r && buf[i + 1] === g && buf[i] === b),
          `a ${hex} pixel was drawn in the no-data icon`,
        );
      }
    }
  });

  test('the no-data ring is BROKEN, so it cannot be read as a magnitude', () => {
    // The defect this fixes: at no-data the sweep is empty, and at 0% the
    // sweep is empty, so both drew the same continuous ring. "No defensible
    // percentage" and "you have used nothing" were one icon, and a user whose
    // bridge broke would read the optimistic one.
    const size = 32;
    const buf = drawDonut(size, traySpecFromSnapshot(snapshot([provider({ fiveHour: null })])));
    for (const deg of [0, 90, 180, 270]) {
      assert.equal(ringPixel(buf, size, deg).a, 0, `the gap at ${deg} deg is not clear`);
    }
  });

  test('no-data and 0% are visibly different pictures at 16px', () => {
    const size = 16;
    const noData = drawDonut(size, traySpecFromSnapshot(snapshot([provider({ fiveHour: null })])));
    const zero = drawDonut(size, traySpecFromSnapshot(snapshot([provider({
      fiveHour: { usedPercentage: 0, certainty: 'known' },
    })])));
    let differing = 0;
    for (let i = 0; i < noData.length; i += 4) if (noData[i + 3] !== zero[i + 3]) differing += 1;
    assert.ok(differing >= 16, `only ${differing} pixels differ at 16px; the two states look alike`);
  });

  test('the four gaps sit at 0/90/180/270 and span 14 degrees each', () => {
    const rad = (d) => (d / 180) * Math.PI;
    for (const centre of [0, 90, 180, 270]) {
      assert.equal(inNoDataGap(rad(centre + 0.001)), true, `no gap at ${centre}`);
      assert.equal(inNoDataGap(rad(centre + 6.9)), true, `gap ends early at ${centre}`);
      assert.equal(inNoDataGap(rad(centre + 7.1)), false, `gap runs long at ${centre}`);
    }
    assert.equal(inNoDataGap(rad(45)), false, 'mid-quadrant must be solid ring');
  });

  test('the identity dot is still drawn when there is no data', () => {
    const size = 32;
    const buf = drawDonut(size, traySpecFromSnapshot(snapshot([provider({ fiveHour: null })])));
    assert.ok(isColour(pixel(buf, size, 16, 16), '#C96442'));
  });
});

/* ------------------------------------------------------------- geometry */

test.describe('the donut bitmap', () => {
  const spec = { usedPercentage: 50, accent: '#C96442', state: 'calm' };

  test('is BGRA, 4 bytes per pixel, at every tray size', () => {
    for (const size of [16, 20, 24, 32]) {
      assert.equal(drawDonut(size, spec).length, size * size * 4);
    }
  });

  test('the corners are fully transparent', () => {
    const size = 32;
    const buf = drawDonut(size, spec);
    for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) {
      assert.equal(pixel(buf, size, x, y).a, 0, `corner ${x},${y} is not transparent`);
    }
  });

  test('the hole between the dot and the ring is transparent', () => {
    const size = 32;
    const buf = drawDonut(size, spec);
    const centre = (size - 1) / 2;
    const rOut = (size / 2) * GEOMETRY.outerRatio;
    const gap = (rOut * GEOMETRY.dotRatio + rOut * GEOMETRY.innerRatio) / 2;
    assert.equal(pixel(buf, size, Math.round(centre + gap), Math.round(centre)).a, 0);
  });

  test('the sweep runs from 12 o\'clock clockwise', () => {
    const size = 32;
    const buf = drawDonut(size, { usedPercentage: 50, accent: '#C96442', state: 'calm' });
    // 50% covers 12 -> 6 going clockwise: the right half is swept, the left is not.
    assert.ok(isColour(ringPixel(buf, size, 45), RAMP.calm), 'the 1:30 position should be swept');
    assert.ok(isColour(ringPixel(buf, size, 90), RAMP.calm), 'the 3:00 position should be swept');
    assert.ok(isColour(ringPixel(buf, size, 270), TRACK), 'the 9:00 position should still be track');
  });

  test('the track ring is drawn under an incomplete sweep', () => {
    const size = 32;
    const buf = drawDonut(size, { usedPercentage: 10, accent: '#C96442', state: 'calm' });
    assert.ok(isColour(ringPixel(buf, size, 180), TRACK));
  });

  test('100% sweeps the whole ring', () => {
    const size = 32;
    const buf = drawDonut(size, { usedPercentage: 100, accent: '#C96442', state: 'spent' });
    for (const deg of [1, 90, 180, 270, 359]) {
      assert.ok(isColour(ringPixel(buf, size, deg), RAMP.spent), `${deg} deg is not swept`);
    }
  });

  test('the sweep colour comes from the ramp, per band', () => {
    const size = 32;
    const cases = [[10, RAMP.calm], [62, RAMP.watch], [95, RAMP.ember], [100, RAMP.spent]];
    for (const [pct, hex] of cases) {
      const buf = drawDonut(size, { usedPercentage: pct, accent: '#C96442', state: 'calm' });
      assert.ok(isColour(ringPixel(buf, size, 2), hex), `${pct}% did not draw ${hex}`);
    }
  });

  test('a spec whose state contradicts its percentage cannot mislead the icon', () => {
    // The colour is re-derived from the rounded value here, so a caller that
    // assembled the spec wrongly gets the honest colour anyway.
    const size = 32;
    const buf = drawDonut(size, { usedPercentage: 95, accent: '#C96442', state: 'calm' });
    assert.ok(isColour(ringPixel(buf, size, 2), RAMP.ember));
  });

  test("state 'none' vetoes the sweep even when a percentage is present", () => {
    const size = 32;
    const buf = drawDonut(size, { usedPercentage: 95, accent: '#C96442', state: 'none' });
    // 45 deg, not 2 deg: 2 deg now falls inside a no-data gap.
    assert.ok(isColour(ringPixel(buf, size, 45), TRACK));
  });

  test('the arc length comes from the ROUNDED percentage, like the colour', () => {
    // 99.6 prints as "%100" and is spent-coloured; an arc driven by the raw
    // value would stop 1.4 degrees short of closing the ring beside it.
    const size = 32;
    const buf = drawDonut(size, { usedPercentage: 99.6, accent: '#C96442', state: 'spent' });
    for (const deg of [0.5, 90, 180, 270, 358, 359.5]) {
      assert.ok(isColour(ringPixel(buf, size, deg), RAMP.spent), `${deg} deg is not swept`);
    }
  });

  test('99.4 still leaves the ring open, because it prints as %99', () => {
    // Counted rather than point-sampled: the unswept wedge is 3.6 degrees,
    // which at 32px is thinner than the rounding of a single pixel centre.
    const size = 32;
    const trackPixels = (buf) => {
      const [r, g, b] = parseHex(TRACK);
      let n = 0;
      for (let i = 0; i < buf.length; i += 4) {
        if (buf[i + 3] === 255 && buf[i + 2] === r && buf[i + 1] === g && buf[i] === b) n += 1;
      }
      return n;
    };
    const open = drawDonut(size, { usedPercentage: 99.4, accent: '#C96442', state: 'ember' });
    const closed = drawDonut(size, { usedPercentage: 99.6, accent: '#C96442', state: 'ember' });
    assert.ok(trackPixels(open) > 0, 'the last percent must still show track');
    assert.equal(trackPixels(closed), 0, '99.6 prints as %100 and must close the ring');
  });

  test('a complete sweep has no seam at the 12 o clock join', () => {
    const size = 32;
    const buf = drawDonut(size, { usedPercentage: 100, accent: '#C96442', state: 'spent' });
    for (const deg of [359.9, 0, 0.1]) {
      assert.ok(isColour(ringPixel(buf, size, deg), RAMP.spent), `seam at ${deg} deg`);
    }
  });

  test('the dot is dropped, never shrunk, when the box cannot hold the clearance', () => {
    // Frontend's invariant: R_in - R_dot >= 1.5px, which holds at 1.86px for
    // S=16. Below that the dot fuses with the ring and the donut stops reading
    // as a donut.
    const gapAt = (s) => {
      const rOut = (s / 2) * GEOMETRY.outerRatio;
      return rOut * GEOMETRY.innerRatio - rOut * GEOMETRY.dotRatio;
    };
    assert.ok(gapAt(16) >= GEOMETRY.minDotGapPx, `S=16 must keep the dot; gap is ${gapAt(16)}`);
    assert.ok(gapAt(12) < GEOMETRY.minDotGapPx, 'S=12 is the case the rule exists for');

    const centreAlpha = (s) => {
      const buf = drawDonut(s, { usedPercentage: 50, accent: '#C96442', state: 'calm' });
      const c = Math.round((s - 1) / 2);
      return buf[(c * s + c) * 4 + 3];
    };
    assert.equal(centreAlpha(16), 255, 'the dot must survive at the tray default size');
    assert.equal(centreAlpha(12), 0, 'the dot must be dropped, not drawn fused');
  });

  test('an unparsable accent falls back instead of throwing', () => {
    const size = 32;
    for (const accent of [null, undefined, 'red', '#12345', 42]) {
      const buf = drawDonut(size, { usedPercentage: 10, accent, state: 'calm' });
      assert.equal(pixel(buf, size, 16, 16).a, 255);
    }
  });

  test('edge pixels are premultiplied: no channel may exceed its alpha', () => {
    const size = 16;
    const buf = drawDonut(size, { usedPercentage: 50, accent: '#FFFFFF', state: 'calm' });
    for (let i = 0; i < buf.length; i += 4) {
      const a = buf[i + 3];
      for (const c of [buf[i], buf[i + 1], buf[i + 2]]) {
        assert.ok(c <= a, `channel ${c} exceeds alpha ${a} at byte ${i}`);
      }
    }
  });
});

/* ------------------------------------------------- redraw discipline */

test.describe('the redraw key', () => {
  const at = (pct, over) => snapshot([provider({ fiveHour: { usedPercentage: pct, certainty: 'known' }, ...over })]);

  test('a percentage that rounds to the same number is not a redraw', () => {
    assert.equal(trayIconKey(at(61.2)), trayIconKey(at(61.4)));
  });

  test('a change in the rounded number is a redraw', () => {
    assert.notEqual(trayIconKey(at(61.4)), trayIconKey(at(61.6)));
  });

  test('crossing a state boundary is a redraw', () => {
    assert.notEqual(trayIconKey(at(59.4)), trayIconKey(at(59.5)));
  });

  test('a different provider on top is a redraw even at the same number', () => {
    const a = snapshot([provider({ fiveHour: { usedPercentage: 40, certainty: 'known' } })]);
    const b = snapshot([provider({
      id: 'kimi', displayName: 'Kimi', accent: '#2B6BE8',
      fiveHour: { usedPercentage: 40, certainty: 'known' },
    })]);
    assert.notEqual(trayIconKey(a), trayIconKey(b));
  });

  test('losing the data is a redraw', () => {
    assert.notEqual(trayIconKey(at(40)), trayIconKey(snapshot([provider({ fiveHour: null })])));
  });

  test('everything the icon does not draw is not a redraw', () => {
    const base = provider({ fiveHour: { usedPercentage: 40, certainty: 'known' } });
    const noisy = {
      ...base,
      burnRatePerHour: 999999,
      tokens: { input: 1, output: 2, cacheWrite: 3, cacheRead: 4, billable: 6 },
      lastGoodAt: new Date().toISOString(),
      byModel: [{ model: 'claude-opus-5', billable: 12 }],
    };
    assert.equal(trayIconKey(snapshot([base])), trayIconKey(snapshot([noisy])));
    // generatedAt moves on every single push and must not repaint the tray.
    assert.equal(
      trayIconKey({ generatedAt: '2026-01-01T00:00:00.000Z', providers: [base] }),
      trayIconKey({ generatedAt: '2026-09-08T12:00:00.000Z', providers: [base] }),
    );
  });
});

/* ----------------------------------------------------- wiring guards */

/* ------------------------------------------------- the taskbar it sits on */

/**
 * The tray icon has two grounds; the panel has one.
 *
 * The panel always sits on `--ink-900`, so one ramp serves it. The icon sits
 * on the WINDOWS TASKBAR, which follows the OS light/dark setting regardless
 * of the user's in-app theme choice — so on a light taskbar the dark ramp's
 * `spent` (#7A3A28) was 1.51:1 against the surface, effectively invisible in
 * the one state that most needs to be seen.
 *
 * The light values belong to the frontend lane and are transcribed here, not
 * derived. These tests are what stops the transcription from drifting.
 */
function cssVars(block) {
  const out = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{3,8})\s*;/g)) out[m[1]] = m[2];
  return out;
}

function themeBlock(selector) {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles', 'tokens.css'), 'utf8');
  const start = css.indexOf(selector);
  assert.notEqual(start, -1, `tokens.css no longer declares ${selector}`);
  return cssVars(css.slice(start, css.indexOf('\n}', start)));
}

test.describe('the icon follows the taskbar, not the panel', () => {
  /**
   * Every value donut.js mirrors, and the tokens.css variable it mirrors, per
   * theme. The mapping is deliberately NOT the same index in both — see the
   * note above RAMPS in donut.js — so it is spelled out rather than derived.
   */
  const MIRRORED = [
    ['RAMPS', 'calm', (g) => RAMPS[g].calm, { dark: 'calm', light: 'calm' }],
    ['RAMPS', 'watch', (g) => RAMPS[g].watch, { dark: 'watch', light: 'watch' }],
    ['RAMPS', 'ember', (g) => RAMPS[g].ember, { dark: 'ember', light: 'ember' }],
    ['RAMPS', 'spent', (g) => RAMPS[g].spent, { dark: 'spent', light: 'spent' }],
    ['TRACKS', '', (g) => TRACKS[g], { dark: 'ink-400', light: 'ink-500' }],
    ['NO_DATA_RINGS', '', (g) => NO_DATA_RINGS[g], { dark: 'ink-400', light: 'ink-300' }],
    ['NEUTRAL_ACCENTS', '', (g) => NEUTRAL_ACCENTS[g], { dark: 'ink-400', light: 'ink-400' }],
  ];

  test('every colour donut.js mirrors is byte-identical to tokens.css, per theme', () => {
    // The whole point of the exercise. donut.js says it mirrors tokens.css;
    // before this test that was a comment, and it had already stopped being
    // true (dark --spent moved to #E4404E and nothing failed). Fourteen values
    // across two selectors, each named so a failure says which one moved.
    for (const [ground, selector] of [['dark', ':root {'], ['light', ':root[data-theme="light"] {']]) {
      const vars = themeBlock(selector);
      for (const [name, key, read, token] of MIRRORED) {
        const variable = token[ground];
        assert.ok(vars[variable], `tokens.css ${selector} no longer declares --${variable}`);
        assert.equal(
          read(ground), vars[variable],
          `donut.js ${name}.${ground}${key ? '.' + key : ''} has drifted from `
          + `tokens.css ${selector} --${variable}`,
        );
      }
    }
  });

  test('the tray-spec neutral sentinel is the dark --ink-400 it claims to be', () => {
    // The other copy of that hex. `accentOf()` returns it as `spec.accent`,
    // and donut.js compares against it to decide "no brand colour" — so a
    // silent move here would stop the neutral dot resolving per ground, with
    // nothing else failing.
    assert.equal(NEUTRAL_SENTINEL, themeBlock(':root {')['ink-400']);
    assert.equal(NEUTRAL_SENTINEL, NEUTRAL_ACCENTS.dark);
  });

  test('the mapping is asymmetric on purpose, and the test knows it', () => {
    // If someone "simplifies" MIRRORED to one token per row, this fails. The
    // asymmetry is the finding: dark sweeps are brighter than the ground so
    // the track sits below them; light sweeps are darker so it must sit above.
    const track = MIRRORED.find(([n]) => n === 'TRACKS')[3];
    assert.notEqual(track.dark, track.light, 'the track uses a different token per theme');
    const dot = MIRRORED.find(([n]) => n === 'NEUTRAL_ACCENTS')[3];
    assert.equal(dot.dark, dot.light, 'the identity dot uses the same token in both');
  });

  test('the two ramps differ at every step, so the choice is never cosmetic', () => {
    for (const step of ['calm', 'watch', 'ember', 'spent']) {
      assert.notEqual(RAMPS.dark[step], RAMPS.light[step], step);
    }
  });

  test('RAMP is still the dark ramp, because dark is the default ground', () => {
    assert.deepEqual({ ...RAMP }, { ...RAMPS.dark });
    assert.deepEqual({ ...rampFor(undefined) }, { ...RAMPS.dark });
    assert.deepEqual({ ...rampFor('light') }, { ...RAMPS.light });
  });

  test('an unrecognised ground degrades to the ramp that has shipped', () => {
    for (const bad of [null, '', 'Light', 'sepia', 0, 1, true, {}]) {
      assert.deepEqual({ ...rampFor(bad) }, { ...RAMPS.dark }, JSON.stringify(bad));
    }
  });

  test('the sweep is actually painted in the light ramp when the ground is light', () => {
    // The whole point: the pixels change, not just a constant.
    const size = 32;
    const spec = { usedPercentage: 100, accent: '#C96442', state: 'spent' };
    const onDark = drawDonut(size, spec);
    const onLight = drawDonut(size, spec, 'light');
    assert.ok(isColour(ringPixel(onDark, size, 45), RAMPS.dark.spent), 'dark ground');
    assert.ok(isColour(ringPixel(onLight, size, 45), RAMPS.light.spent), 'light ground');
    assert.notDeepEqual(onDark, onLight, 'the buffers must actually differ');
  });

  test('every state steps to its light counterpart, not only spent', () => {
    const size = 32;
    for (const [pct, step] of [[10, 'calm'], [62, 'watch'], [95, 'ember'], [100, 'spent']]) {
      const buf = drawDonut(size, { usedPercentage: pct, accent: '#C96442', state: 'calm' }, 'light');
      assert.ok(isColour(ringPixel(buf, size, 2), RAMPS.light[step]), `${pct}% -> ${step}`);
    }
  });

  test('the no-data ring gets its OWN colour, not the track colour', () => {
    // The track is drawn under a sweep, so it must separate from the SWEEP.
    // The no-data ring is drawn alone, so it must separate from the TASKBAR.
    // With this ramp those two cannot be the same value on a light ground —
    // the squeeze is arithmetic, not a preference — so they are two constants.
    assert.equal(noDataRingFor('dark'), trackFor('dark'), 'dark never needed to split');
    assert.notEqual(noDataRingFor('light'), trackFor('light'), 'light does');

    const size = 32;
    const spec = traySpecFromSnapshot(snapshot([provider({ fiveHour: null })]));
    const onDark = drawDonut(size, spec);
    const onLight = drawDonut(size, spec, 'light');
    assert.ok(isColour(ringPixel(onDark, size, 45), NO_DATA_RINGS.dark));
    assert.ok(isColour(ringPixel(onLight, size, 45), NO_DATA_RINGS.light));
    assert.notDeepEqual(onDark, onLight);
    // And it is still BROKEN, whichever ground it is on: an unbroken ring is
    // readable as a 0% arc, which is the collision this shape exists to stop.
    assert.equal(ringPixel(onLight, size, 0).a, 0, 'the gaps must survive the recolour');
  });

  test('the light track is not the light no-data ring, which is what 1.02:1 would have been', () => {
    // Frontend measured light --ink-400 at 1.02:1 against the calm sweep: a
    // healthy donut indistinguishable from the no-data ring. That is the same
    // meaning collision `inNoDataGap` exists to prevent, reached from the
    // track side. Guard the property, not the ratio — this lane cannot measure
    // contrast, but it can assert the two greys never collapse into one.
    assert.notEqual(TRACKS.light, NEUTRAL_ACCENTS.light, 'the track must not be --ink-400');
    for (const step of Object.values(RAMPS.light)) {
      assert.notEqual(TRACKS.light, step, 'the track must never equal a sweep colour');
    }
  });

  test('every dark-ground buffer is byte-identical to what shipped', () => {
    // The dark ground was never the complaint. Splitting one grey into three
    // must not have moved a single dark pixel.
    const size = 32;
    for (const over of [{ fiveHour: null }, {}, { connected: false }]) {
      const spec = traySpecFromSnapshot(snapshot([provider(over)]));
      assert.deepEqual(drawDonut(size, spec), drawDonut(size, spec, 'dark'));
    }
    assert.equal(TRACK, TRACKS.dark);
    assert.equal(TRACK, '#6B7A77');
  });

  test('the neutral identity dot follows the ground, the brand accent does not', () => {
    // `accentOf()` puts the sentinel in `spec.accent` when there is no brand
    // colour to show. That is the ABSENCE of a choice, so it resolves per
    // ground; a real brand hex is the caller's choice and is left alone.
    assert.deepEqual(dotColour({ accent: NEUTRAL_SENTINEL }, 'light'), parseHex(NEUTRAL_ACCENTS.light));
    assert.deepEqual(dotColour({ accent: NEUTRAL_SENTINEL }, 'dark'), parseHex(NEUTRAL_ACCENTS.dark));
    assert.deepEqual(dotColour({ accent: '#C96442' }, 'light'), parseHex('#C96442'));
    // An unparsable accent lands on the ground's neutral too, never on null.
    for (const bad of [undefined, null, '', 'red', '#GGG', 42]) {
      assert.deepEqual(dotColour({ accent: bad }, 'light'), parseHex(NEUTRAL_ACCENTS.light), String(bad));
    }
  });

  test('a disconnected provider draws the ground-appropriate neutral dot', () => {
    // The end-to-end path: tray-spec neutralises the accent, donut resolves it.
    const size = 32;
    const spec = traySpecFromSnapshot(snapshot([provider({ connected: false })]));
    assert.equal(spec.accent, NEUTRAL_SENTINEL);
    const centre = (size - 1) / 2;
    const px = (buf) => {
      const i = (Math.round(centre) * size + Math.round(centre)) * 4;
      return { r: buf[i + 2], g: buf[i + 1], b: buf[i] };
    };
    const light = px(drawDonut(size, spec, 'light'));
    const [r, g, b] = parseHex(NEUTRAL_ACCENTS.light);
    assert.deepEqual(light, { r, g, b });
  });

  test('the ground is part of the icon key, or a theme flip would not repaint', () => {
    // An OS theme change moves no snapshot field at all, so without this the
    // key would match, `updateTray`'s early return would fire, and the dark
    // ramp would sit on a light taskbar until the percentage happened to move.
    const snap = snapshot([provider()]);
    assert.notEqual(trayIconKey(snap, Date.now(), 'light'), trayIconKey(snap, Date.now(), 'dark'));
    assert.equal(trayIconKey(snap, 1e12), trayIconKey(snap, 1e12, 'dark'), 'dark is the default');
    assert.ok(trayIconKey(snap, 1e12, 'light').endsWith('|light'));
  });

  test('main derives the ground from nativeTheme, never from the user preference', () => {
    // The ruling: the icon lives in the taskbar, so it matches what it sits
    // on. A user on a light taskbar who prefers a dark panel still needs a
    // legible icon, so `settings.theme` must not reach this decision.
    const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8');
    const start = main.indexOf('function trayGround()');
    assert.notEqual(start, -1, 'no trayGround()');
    const body = main.slice(start, main.indexOf('\n}', start));
    assert.ok(body.includes('nativeTheme.shouldUseDarkColors'), body);
    assert.equal(/settings\.theme|preferences\(\)/.test(body), false,
      'the icon must not follow the in-app theme choice');
    assert.ok(body.includes("return 'dark';"), 'an unreadable OS setting must not throw');
  });

  test('main repaints when the OS theme changes', () => {
    const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8');
    const start = main.indexOf("nativeTheme.on('updated'");
    assert.notEqual(start, -1, 'nothing subscribes to the OS theme');
    const body = main.slice(start, main.indexOf('\n  });', start));
    assert.ok(body.includes('updateTray('), 'the subscription must actually repaint');
  });

  test('main passes the ground to both the key and the builder', () => {
    // Passing it to one and not the other is the shape that silently half
    // works: the right key with the wrong pixels, or the reverse.
    const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8');
    assert.ok(/trayIconKey\(snapshot, now, ground\)/.test(main), main.includes('trayIconKey'));
    assert.ok(/buildTrayImage\(traySpecFromSnapshot\(snapshot, now\), ground\)/.test(main));
  });
});

test.describe('main-process wiring', () => {
  test('the static PNG fallback is still shipped and still referenced', () => {
    for (const file of ['tray-icon.png', 'tray-icon@2x.png', 'tray-icon@4x.png']) {
      assert.ok(fs.existsSync(path.join(ROOT, 'assets', file)), `assets/${file} is missing`);
    }
    const tray = fs.readFileSync(path.join(ROOT, 'src', 'main', 'tray.js'), 'utf8');
    assert.ok(tray.includes("'tray-icon.png'"), 'tray.js no longer falls back to the PNG');
    const panel = fs.readFileSync(path.join(ROOT, 'src', 'main', 'panel-window.js'), 'utf8');
    assert.ok(panel.includes('tray-icon@4x.png'), 'the window icon still comes from the PNG');
  });

  test('the tray icon is redrawn behind a key guard, not on every snapshot', () => {
    const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8');
    assert.ok(main.includes('trayIconKey('), 'main must compute the key');
    assert.ok(
      /if \(key === trayIconDrawnKey\) return;/.test(main),
      'main must skip the rebuild when nothing visible changed',
    );
  });

  test('the drawing code pulls in no dependency at all', () => {
    const donut = fs.readFileSync(path.join(ROOT, 'src', 'core', 'donut.js'), 'utf8');
    const requires = [...donut.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
    assert.deepEqual(requires, ['./tray-spec'], 'the donut must stay dependency-free');
    const trayIcon = fs.readFileSync(path.join(ROOT, 'src', 'main', 'tray-icon.js'), 'utf8');
    const assembled = [...trayIcon.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
    assert.deepEqual(
      assembled.sort(),
      ['../core/donut', '../core/log', 'electron'],
      'the tray image may use electron and nothing else',
    );
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.deepEqual(pkg.dependencies || {}, {}, 'the tray icon added a runtime dependency');
  });

  test('the preload exposes setOrder and main handles it', () => {
    const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8');
    const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8');
    assert.ok(/setOrder:\s*\(/.test(preload), 'preload.js must expose setOrder()');
    assert.ok(preload.includes('CH.SET_ORDER'), 'setOrder must use the SET_ORDER channel');
    assert.ok(main.includes('ipcMain.handle(IPC.SET_ORDER'), 'main must register the SET_ORDER handler');
    assert.ok(
      main.slice(main.indexOf('ipcMain.handle(IPC.SET_ORDER')).includes('fromPanel(event)'),
      'the handler must reject senders that are not our panel',
    );
  });
});
