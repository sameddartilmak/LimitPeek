'use strict';
const { stateForPercentage, FALLBACK_ACCENT: NEUTRAL_SENTINEL } = require('./tray-spec');

/**
 * The tray donut, rasterised into raw BGRA with ZERO dependencies.
 *
 * No canvas, no image library: ADR-001 / security F11 keeps the runtime
 * dependency tree empty, and a tray glyph is not worth an operational
 * commitment. The buffer this produces is handed straight to
 * `nativeImage.createFromBitmap(buf, { width, height })` in
 * `src/main/tray-icon.js`; nothing here imports `electron`, so the geometry is
 * testable under plain `node --test`.
 *
 * Two things about the pixel format that are easy to get wrong:
 *
 *   - byte order is B, G, R, A. Not RGBA.
 *   - the bitmap is treated as PREMULTIPLIED. A half-covered edge pixel must
 *     be written as `colour * alpha`, not as the full colour with alpha=128,
 *     or every anti-aliased edge comes out too bright. The accumulator below
 *     therefore sums premultiplied contributions and never divides them back
 *     out.
 *
 * Angles are measured from 12 o'clock, increasing clockwise, which is what
 * `atan2(dx, -dy)` gives directly.
 */

const TAU = Math.PI * 2;

/**
 * Ratios, in one place, because the frontend lane owns the visual spec and
 * will refine them. Everything is expressed relative to the box so the same
 * numbers hold at 16, 20, 24 and 32 px.
 */
const GEOMETRY = Object.freeze({
  /** Outer radius as a fraction of the half-box. */
  outerRatio: 0.93,
  /** Inner radius as a fraction of the OUTER radius. */
  innerRatio: 0.59,
  /** Identity dot radius as a fraction of the OUTER radius. */
  dotRatio: 0.24,
  /**
   * NxN samples per pixel. Raised 3 -> 4 when the ring was thinned to D3.
   *
   * The old note said 4 cost ~78% more work for no visible gain, measured
   * against the THICKER ring at 16 px. Coverage sampling quantises the edge
   * alpha to N*N+1 levels, so 3x3 gave ten; on a 3.05 px stroke, and at the
   * 20 px representation the owner's taskbar actually shows, ten levels is
   * most visible exactly where a ring is judged — the two arc ends and the
   * inner and outer boundaries. 4x4 gives seventeen. The cost is 16 x 16 x 16
   * samples for the smallest icon, redrawn only when a snapshot changes.
   */
  supersample: 4,
  /**
   * Clear pixels the dot must keep between itself and the ring. Frontend
   * measured 1.86 px at S=16 and set the floor at 1.5: below that the two
   * shapes fuse into a blob and the donut stops reading as a donut. When the
   * box is too small to hold the gap the dot is DROPPED, never shrunk — a
   * two-pixel dot is noise, and the ring is the part carrying the number.
   */
  minDotGapPx: 1.5,
  /**
   * Half-width, in radians, of each gap in the no-data ring: 0.1222 rad = 7°,
   * so each of the four gaps spans 14°, centred on 0/90/180/270.
   */
  noDataGapHalfWidth: 0.1222,
});

/**
 * The state ramp, byte-identical to `src/renderer/styles/tokens.css` — BOTH
 * of its themes, because the tray icon has two grounds and the panel does not.
 * Each set below names the SELECTOR it mirrors, because the previous wording
 * ("byte-identical to tokens.css", with one unnamed set) is exactly what let a
 * divergence look correct to a reader: it asserted a guarantee, named no
 * source precisely enough to check, and had nothing enforcing it.
 *
 * The panel always sits on `--ink-900`, so one ramp is enough for it. The tray
 * icon sits on the WINDOWS TASKBAR, which follows the OS light/dark setting
 * independently of anything this app decides, so the dark ramp was being
 * painted onto a near-white surface half the time. The light theme's steps are
 * not a brightness tweak of the dark ones — frontend re-picked each for a
 * light ground rather than flipping it, because a flipped #E0A845 is navy and
 * stops meaning "watch" — so using the wrong column is a legibility failure at
 * every step, not only at the loudest one.
 *
 * Both columns are frontend's, transcribed rather than derived: that lane owns
 * the palette and measured the ratios. `test/tray-icon.test.js` parses
 * tokens.css and fails the build if either column drifts, which is how the
 * dark `spent` change from #7A3A28 to #E4404E was caught here rather than
 * shipping as a tray icon that disagreed with the meter beside it.
 *
 * 2026-10-21: both columns moved to the Apple system colours the panel adopted
 * (the graphite ramp was #22F58C/#E0A845/#E2653F/#E4404E dark and
 * #00803A/#8A5A0B/#A83512/#7C160A light). Against the taskbars every dark step
 * rose to 4.78:1 or better on #202020 and every light step stays at 4.74:1 or
 * better on #F3F3F3; tokens.css carries the table. The taskbar strip
 * (strip-tiles.js) takes the same columns through `rampFor`.
 */
const RAMPS = Object.freeze({
  /** Mirrors `:root { }` in tokens.css. */
  dark: Object.freeze({
    calm: '#30D158',
    watch: '#FFD60A',
    ember: '#FF9F0A',
    spent: '#FF453A',
  }),
  /** Mirrors `:root[data-theme="light"] { }` in tokens.css. */
  light: Object.freeze({
    calm: '#1F7C36',
    watch: '#9C5700',
    ember: '#B62E00',
    spent: '#B90010',
  }),
});

/**
 * The dark ramp, still exported under its old name because it is the DEFAULT
 * ground and most callers never name one.
 */
const RAMP = RAMPS.dark;

/**
 * Which taskbar the icon is being drawn for.
 *
 * A string rather than a boolean so a call site reads `'light'` instead of
 * `false`, and so an unrecognised value degrades to the dark ramp — the one
 * that has shipped — rather than to whichever branch `!value` happens to pick.
 */
function rampFor(ground) {
  return ground === 'light' ? RAMPS.light : RAMPS.dark;
}

/**
 * The three greys, and why the mapping is NOT the same token in both themes.
 *
 * This started as one constant serving all three jobs, on the strength of a
 * comment saying `--ink-400` was "legible against both taskbars". That is true
 * of the ink against the taskbar and says nothing about the two other
 * constraints, which is how one value came to answer three questions.
 *
 * The asymmetry is structural, and it is a consequence of the light ramp being
 * RE-PICKED rather than inverted. Dark ramp steps are brighter than their
 * ground, so the track sits BELOW them; light ramp steps are all darker than
 * their ground, so the track has to sit ABOVE them. Frontend measured light
 * `--ink-400` under the light ramp at 1.02:1 against the calm of the day — a
 * healthy donut indistinguishable from the no-data ring, which is the meaning
 * collision `inNoDataGap()` exists to prevent, arriving from the track side
 * instead of the sweep side. `--ink-500` gives 2.01 / 2.35 / 2.62 / 4.23 across
 * the four steps, above the dark theme's own worst case of 1.10.
 *
 * Re-measured when calm moved to the vivid green (2026-09-22): light calm
 * 2.09 -> 2.01 against `--ink-500`, dark calm 1.83 -> 3.10 against `--ink-400`.
 * The light figure is the one to watch — it is the tightest pair in the icon,
 * and thinning the ring shortens the boundary that contrast has to be read
 * across.
 *
 *   TRACKS           dark --tray-track-dark   light --tray-track-light
 *   NO_DATA_RINGS    dark --ink-400   light --ink-300
 *   NEUTRAL_ACCENTS  dark --ink-400   light --ink-400
 *
 * Apple palette (2026-10-21): the no-data ring and the identity dot follow
 * the panel's new greys (#98989F dark; #545458 / #6C6C70 light), which are
 * further from the taskbar than the graphite ones were (dark no-data ring
 * 3.63 -> 5.68 on #202020). The two tracks did not move: against the new
 * ramp their worst pair is 1.06 dark (as before) and 2.24 light (was 2.16).
 *
 * They are three constants because they have three different jobs, and one
 * value cannot serve them at once on a light ground:
 *
 *   - TRACK is drawn UNDER a sweep, so it must separate from the SWEEP.
 *   - NO_DATA_RING is drawn alone, so it must separate from the TASKBAR. The
 *     recommended light track is 2.27:1 against a #F3F3F3 taskbar, and the
 *     squeeze is arithmetic rather than a preference: with this ramp, a value
 *     that clears 3:1 against the taskbar cannot also separate from the calm
 *     sweep. Collapsing the two back into one constant re-creates exactly one
 *     of the two failures, silently.
 *   - NEUTRAL_ACCENT is the identity dot, which has only the taskbar
 *     constraint — `GEOMETRY.minDotGapPx` guarantees clear pixels between it
 *     and the ring, so it never has to separate from either. It is therefore
 *     deliberately NOT made asymmetric to match the track.
 *
 * The dark column is unchanged in all three: the dark ground was never the
 * complaint, and every dark-theme buffer this file produces is byte-identical
 * to what shipped.
 *
 * All nine values (these six plus the eight ramp steps) are parsed out of
 * tokens.css by `test/tray-icon.test.js` per selector. The comment above the
 * old single constant asserted the same guarantee and had nothing behind it,
 * which is how it stopped being true without anything failing.
 */
const TRACKS = Object.freeze({ dark: '#7A8A86', light: '#A0ACA7' });
const NO_DATA_RINGS = Object.freeze({ dark: '#98989F', light: '#545458' });
const NEUTRAL_ACCENTS = Object.freeze({ dark: '#98989F', light: '#6C6C70' });

/** Dark is the default ground, so the old names still resolve to it. */
const TRACK = TRACKS.dark;
const FALLBACK_ACCENT = NEUTRAL_ACCENTS.dark;

const trackFor = (ground) => (ground === 'light' ? TRACKS.light : TRACKS.dark);
const noDataRingFor = (ground) => (ground === 'light' ? NO_DATA_RINGS.light : NO_DATA_RINGS.dark);
const neutralAccentFor = (ground) => (ground === 'light' ? NEUTRAL_ACCENTS.light : NEUTRAL_ACCENTS.dark);

/** '#rgb' or '#rrggbb' -> [r,g,b], or null. */
function parseHex(hex) {
  if (typeof hex !== 'string') return null;
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const body = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return [
    parseInt(body.slice(0, 2), 16),
    parseInt(body.slice(2, 4), 16),
    parseInt(body.slice(4, 6), 16),
  ];
}

/**
 * The colour the sweep is drawn in, re-derived from the rounded percentage.
 *
 * `spec.state` is accepted only as a veto ('none' => no sweep at all); the
 * colour itself is never taken on trust. The renderer shipped exactly this bug
 * (its F9) by colouring from a value it had not rounded, and a spec assembled
 * by some future caller must not be able to reintroduce it here.
 */
function sweepColour(spec, ground = 'dark') {
  if (!spec || spec.state === 'none') return null;
  const pct = spec.usedPercentage;
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  // `stateForPercentage` returns 'none' only for a non-finite input, which the
  // line above already rejected, so the ramp lookup below always resolves. No
  // second guard here on purpose: a branch that cannot fire reads as another
  // safety net where there is only one, and the next reader trusts it.
  return parseHex(rampFor(ground)[stateForPercentage(pct)]);
}

/**
 * The identity dot's colour, resolved for the ground.
 *
 * `spec.accent` is a hex string (contract.ts, `TrayIconSpec`), and
 * `accentOf()` in tray-spec.js puts the NEUTRAL SENTINEL there when there is
 * no brand colour to show — an unparsable accent, no provider, or a provider
 * the panel has greyed out because it is disconnected. That sentinel is not a
 * colour the caller chose; it is the absence of one, so it resolves per ground
 * like the other two inks instead of staying at the dark theme's grey on a
 * light taskbar.
 *
 * The sentinel is imported from tray-spec rather than re-declared, because two
 * copies of one hex in two files is the shape this whole round has been about.
 *
 * A real brand accent that happened to equal the sentinel would take the same
 * path. It would then render as the light grey on a light taskbar rather than
 * the dark one, which is the more legible of the two — so the collision costs
 * nothing, and no provider in the registry is that grey.
 */
function dotColour(spec, ground) {
  const accent = spec && spec.accent;
  if (accent === NEUTRAL_SENTINEL) return parseHex(neutralAccentFor(ground));
  return parseHex(accent) || parseHex(neutralAccentFor(ground));
}

/**
 * True for a sample inside one of the four gaps in the no-data ring.
 *
 * The gaps are what stop no-data from being read as a magnitude. A CONTINUOUS
 * track ring is exactly the picture a 0% reading produces, so "we have no
 * defensible percentage" and "you have used nothing" would be the same icon —
 * and a user whose bridge broke would read the optimistic one. That is the
 * failure ADR-001 exists to prevent, and TrayIconSpec's comment was written to
 * protect this component from it specifically. A broken ring cannot be read as
 * an arc of any length.
 *
 * Gaps sit at 0/90/180/270 by folding the angle into one quadrant.
 */
function inNoDataGap(theta) {
  const quadrant = Math.PI / 2;
  const m = theta % quadrant;
  return Math.min(m, quadrant - m) < GEOMETRY.noDataGapHalfWidth;
}

/**
 * Draws one square icon.
 *
 * @param {number} size  edge length in device pixels
 * @param {{usedPercentage:number|null, accent:string, state:string}} spec
 * @param {'dark'|'light'} [ground] which taskbar the icon will sit on. NOT a
 *   field on `spec`: `TrayIconSpec` is orchestrator-owned (contract.ts) and
 *   describes the READING, while this describes the surface. Keeping them
 *   apart is also what stops the resolved OS theme from silently becoming part
 *   of a shape the renderer receives.
 * @returns {Buffer} size*size*4 bytes of premultiplied BGRA
 */
function drawDonut(size, spec, ground = 'dark') {
  const s = Math.max(8, Math.round(Number.isFinite(size) ? size : 16));
  const buf = Buffer.alloc(s * s * 4);

  const centre = (s - 1) / 2;
  const rOut = (s / 2) * GEOMETRY.outerRatio;
  const rIn = rOut * GEOMETRY.innerRatio;
  const rDot = rOut * GEOMETRY.dotRatio;

  const track = parseHex(trackFor(ground));
  const noDataRing = parseHex(noDataRingFor(ground));
  const dot = dotColour(spec, ground);
  const sweep = sweepColour(spec, ground);
  /**
   * The arc length comes from the ROUNDED percentage, exactly like the colour.
   * Driving the geometry from the raw value and the colour from the rounded
   * one puts them a step out of phase: at 99.6 the icon is spent-coloured but
   * the arc stops 1.4 degrees short, beside a panel printing "%100". Same
   * defect class as the renderer's F9, entering through a third surface.
   */
  const shown = sweep ? Math.round(Math.min(100, Math.max(0, spec.usedPercentage))) : 0;
  const sweepEnd = (shown / 100) * TAU;
  /**
   * At 100% the annulus is filled without an angle test at all. Comparing
   * against TAU leaves a hairline seam at 12 o'clock where floating-point
   * rounding puts a sample fractionally past the end — a visible nick in the
   * one state where the ring must read as closed.
   */
  const sweepComplete = Boolean(sweep) && shown >= 100;

  // Dot geometry is decided once, not per pixel: below the minimum clearance
  // the dot is dropped rather than drawn fused to the ring.
  const drawDot = rIn - rDot >= GEOMETRY.minDotGapPx;

  const SS = GEOMETRY.supersample;
  const samples = SS * SS;

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      let hits = 0;
      let accR = 0;
      let accG = 0;
      let accB = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS - 0.5;
          const py = y + (sy + 0.5) / SS - 0.5;
          const dx = px - centre;
          const dy = py - centre;
          const d = Math.hypot(dx, dy);

          let colour = null;
          if (drawDot && d <= rDot) {
            colour = dot;
          } else if (d >= rIn && d <= rOut) {
            if (sweepComplete) {
              colour = sweep;
            } else if (sweep) {
              let a = Math.atan2(dx, -dy);
              if (a < 0) a += TAU;
              colour = a <= sweepEnd ? sweep : track;
            } else {
              // No-data: a broken ring, never a continuous one. Its own
              // colour, because with nothing drawn over it the only thing it
              // has to separate from is the taskbar — a different constraint
              // from the track's, and unsatisfiable by the same value.
              let a = Math.atan2(dx, -dy);
              if (a < 0) a += TAU;
              colour = inNoDataGap(a) ? null : noDataRing;
            }
          }
          if (!colour) continue;
          hits++;
          accR += colour[0];
          accG += colour[1];
          accB += colour[2];
        }
      }
      if (hits === 0) continue;

      // Coverage IS the alpha, and the colour sum is already the premultiplied
      // numerator: dividing by `samples` (not by `hits`) yields colour*alpha.
      //
      // THIS SUMS sRGB BYTES ON PURPOSE. It looks like the classic averaging
      // mistake — average in linear light, not in gamma-encoded space — and it
      // is not, because what is being averaged is COVERAGE, not two colours:
      // every sample that hits contributes the same value and misses
      // contribute nothing, so the result is colour x alpha. That is
      // premultiplied sRGB, which is exactly what `nativeImage.createFromBitmap`
      // takes and what the Windows compositor blends. Converting to linear
      // light and back here would DOUBLE-CORRECT against the platform and make
      // every anti-aliased edge lighter than it should be.
      //
      // The one place the objection does apply is a boundary between two
      // OPAQUE colours — the sweep/track seam and the dot/ring seam — where the
      // sRGB midpoint lands a shade dark. That is a one-pixel internal line,
      // not the perimeter, and it is deliberately left alone: fixing it means
      // converting every pixel to buy a shade on two seams.
      const i = (y * s + x) * 4;
      buf[i] = Math.round(accB / samples);
      buf[i + 1] = Math.round(accG / samples);
      buf[i + 2] = Math.round(accR / samples);
      buf[i + 3] = Math.round((hits / samples) * 255);
    }
  }
  return buf;
}

module.exports = {
  drawDonut, parseHex, sweepColour, inNoDataGap, dotColour,
  rampFor, trackFor, noDataRingFor, neutralAccentFor,
  GEOMETRY, RAMP, RAMPS, TRACK, TRACKS, NO_DATA_RINGS,
  FALLBACK_ACCENT, NEUTRAL_ACCENTS,
};
