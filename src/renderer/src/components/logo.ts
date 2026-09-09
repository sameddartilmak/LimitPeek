/**
 * Provider identity marks.
 *
 * Six inline SVG glyphs, drawn by hand in this file. There is no network
 * fetch and no external asset: `connect-src 'none'` would block one, and the
 * app is required to work fully offline. Every node is built with
 * `createElementNS` through `svg()` in dom.ts — never from a markup string,
 * so no `innerHTML` path exists here.
 *
 * ONE GRID, ONE WEIGHT
 * --------------------
 * Every mark is drawn on a 24x24 viewBox, centred on (12,12), with its extreme
 * points on a radius-8..8.5 circle, stroked in `currentColor` with round caps
 * and joins and no fill. `stroke-width` is NOT set here; it is inherited from
 * CSS (`.mark`), which is what lets the connected/unconnected treatment change
 * the optical weight without touching the geometry. Total stroke length across
 * the set sits in a 43..72 unit band, so no mark reads heavier than its
 * neighbours in the column.
 *
 * These are simplified glyphs in the SPIRIT of each vendor's mark, drawn from
 * primitives — not traced outlines of a trademarked logo.
 *
 * `antigravity` and `kimi` are drawn from the product/brand idea (lift; the
 * moon of Moonshot AI) rather than from a mark this lane could verify. See the
 * frontend report: they are the two glyphs a designer should review first.
 */

import type { ProviderSnapshot } from '../../../shared/contract.js';
import { svg } from '../dom.js';

type Shape =
  | { t: 'path'; d: string }
  | { t: 'circle'; cx: number; cy: number; r: number };

export type ProviderId = ProviderSnapshot['id'];

/**
 * Radial burst, six spokes on a radius-8 circle. Three crossing strokes at
 * 30 / 90 / 150 degrees. Reads at 16px because it is pure line and has no
 * enclosed counter to fill in.
 */
const CLAUDE: Shape[] = [
  { t: 'path', d: 'M12 4V20' },
  { t: 'path', d: 'M18.93 8L5.07 16' },
  { t: 'path', d: 'M5.07 8L18.93 16' },
];

/**
 * Pointy-top hexagon on a radius-8 circle, with three spokes on alternating
 * axes: the three-fold symmetry of the knot, without the knot's overlaps,
 * which turn to mud below 20px.
 */
const CODEX: Shape[] = [
  { t: 'path', d: 'M12 4L18.93 8V16L12 20L5.07 16V8Z' },
  { t: 'path', d: 'M12 12V8.6' },
  { t: 'path', d: 'M12 12L9.06 13.7' },
  { t: 'path', d: 'M12 12L14.94 13.7' },
];

/**
 * Four-point spark, concave sides, tips on a radius-8.5 circle. Drawn as an
 * outline rather than a fill so it carries the same weight as the rest of the
 * set; the cusps close into solid points at small sizes, which is what makes
 * a spark read.
 */
const GEMINI: Shape[] = [
  {
    t: 'path',
    d:
      'M12 3.5C12.55 8.9 15.1 11.45 20.5 12C15.1 12.55 12.55 15.1 12 20.5' +
      'C11.45 15.1 8.9 12.55 3.5 12C8.9 11.45 11.45 8.9 12 3.5Z',
  },
];

/**
 * Twin lenses under a brow: the goggled head, reduced to three primitives.
 * The lenses touch rather than overlap, because two 2px strokes crossing at a
 * shallow angle fill in at 16px.
 */
const COPILOT: Shape[] = [
  { t: 'circle', cx: 8.2, cy: 13.4, r: 3.6 },
  { t: 'circle', cx: 15.8, cy: 13.4, r: 3.6 },
  { t: 'path', d: 'M6.2 8.7Q12 5.2 17.8 8.7' },
];

/**
 * An orb with the lift taken off it: a wide rising chevron, well clear of the
 * mass below. The gap is the whole point — closed up, the pair reads as a
 * circumflex over a letter rather than as an object leaving the ground.
 */
const ANTIGRAVITY: Shape[] = [
  { t: 'path', d: 'M5 7.8L12 3.2L19 7.8' },
  { t: 'circle', cx: 12, cy: 15.9, r: 4.3 },
];

/**
 * Crescent, outer edge on a radius-8 circle, inner edge on a radius-9.6 circle
 * offset right. The horns are what makes it a moon; a thinner crescent loses
 * them first, so the waist is kept at ~7.5 units.
 */
const KIMI: Shape[] = [
  { t: 'path', d: 'M15.6 4.6A8 8 0 1 0 15.6 19.4A9.6 9.6 0 0 1 15.6 4.6Z' },
];

/** Neutral fallback: a plain ring. Never a letter — a letter is not a mark. */
const FALLBACK: Shape[] = [{ t: 'circle', cx: 12, cy: 12, r: 7.5 }];

const MARKS: Record<ProviderId, Shape[]> = {
  claude: CLAUDE,
  codex: CODEX,
  gemini: GEMINI,
  copilot: COPILOT,
  antigravity: ANTIGRAVITY,
  kimi: KIMI,
};

function shapeNode(shape: Shape): SVGElement {
  if (shape.t === 'circle') {
    return svg('circle', { cx: shape.cx, cy: shape.cy, r: shape.r });
  }
  return svg('path', { d: shape.d });
}

/**
 * The mark for a provider, as an `aria-hidden` SVG. Colour and stroke weight
 * come from CSS so the same element serves both the brand-colour (connected)
 * and the monochrome (unconnected) treatments with no rebuild.
 */
export function providerMark(id: string): SVGElement {
  const shapes = MARKS[id as ProviderId] ?? FALLBACK;
  return svg(
    'svg',
    {
      class: 'mark',
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    ...shapes.map(shapeNode),
  );
}

/** Six dots: the grip texture shown on hover, so the tile reads as draggable. */
export function gripDots(): SVGElement {
  return svg(
    'svg',
    {
      class: 'grip__dots',
      viewBox: '0 0 6 16',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    ...[3, 8, 13].flatMap((y) =>
      [1.5, 4.5].map((x) => svg('circle', { cx: x, cy: y, r: 0.9, fill: 'currentColor' })),
    ),
  );
}
