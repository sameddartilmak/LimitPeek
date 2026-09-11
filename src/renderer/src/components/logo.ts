/**
 * Provider identity marks.
 *
 * Each mark is the vendor's REAL brand logo, shipped as a trusted build-time
 * asset under `src/renderer/assets/logos/` (lobe-icons, `viewBox="0 0 24 24"`).
 * There is no network fetch — `connect-src 'none'` would block one and the app
 * must work fully offline — and no runtime `innerHTML`: the mark is a plain
 * `<span>` and the SVG is referenced from CSS through `url(...)`, which the CSP
 * (`img-src 'self'`) permits and which never turns file-sourced text into
 * markup. So no parser and no `innerHTML` path exists here, exactly as before.
 *
 * TWO PAINTING TECHNIQUES, ONE ELEMENT
 * ------------------------------------
 * Which mechanism CSS uses is decided by what art the vendor ships (see
 * assets/logos/):
 *
 *   background-image  the multi-colour `<name>-color.svg` painted as-is, so the
 *                     ACTIVE mark carries the vendor's own colours. Greyed for
 *                     the inactive state with `filter: grayscale(1)` — the same
 *                     SVG, desaturated. Used for claude, codex, gemini,
 *                     antigravity and kimi.
 *   mask-image        github-copilot ships only a monochrome `currentColor`
 *                     mark, which renders black inside an <img> (invisible on a
 *                     dark ground). It is instead used as a MASK and filled with
 *                     a colour we control — the provider accent when active, an
 *                     ink token when not. Marked `.mark--mono`.
 *
 * ACTIVE vs INACTIVE
 * ------------------
 * "Active" means the provider's account is wired up and reporting, i.e.
 * `ProviderSnapshot.connected`. An active mark shows in full brand colour; an
 * inactive one shows the SAME logo in grey. The switch is carried two ways that
 * cannot disagree because they are the same fact:
 *   - the mark's own `data-active`, set from the `active` argument the row
 *     passes (`provider.connected`); and
 *   - a `[data-connected="true"]` ancestor, which the row and the settings list
 *     already set — this is what colours the settings marks, whose caller does
 *     not pass the flag.
 * All the colour/grey rules live in styles/row.css.
 *
 * The mark stays `aria-hidden`: it is decorative. Its provider is already named
 * by the control it lives in — the grip `<button>`'s `aria-label` in the row,
 * and the `aria-hidden` `.settings__mark` wrapper's labelled row in settings —
 * so a second label here would announce the same name twice.
 */

import type { ProviderSnapshot } from '../../../shared/contract.js';
import { el, svg } from '../dom.js';

export type ProviderId = ProviderSnapshot['id'];

/**
 * The provider ids that ship a brand logo. Kept in sync with assets/logos/ BY
 * HAND — a new provider without an asset must be added here only once its file
 * exists, or its mark would be an empty box.
 */
const HAS_LOGO: ReadonlySet<string> = new Set<ProviderId>([
  'claude',
  'codex',
  'gemini',
  'copilot',
  'antigravity',
  'kimi',
]);

/**
 * The mark for a provider, as an `aria-hidden` `<span>`. Its brand SVG and the
 * connected/grey treatment come from CSS keyed off `data-logo` and the active
 * state; see styles/row.css.
 *
 * @param active whether the provider is connected (its account is wired up).
 *   Omit it — as the settings list does — to let a `[data-connected]` ancestor
 *   decide instead.
 */
export function providerMark(id: string, active?: boolean): HTMLSpanElement {
  const known = HAS_LOGO.has(id);
  // Copilot ships only a monochrome mark, so it is painted via a CSS mask in a
  // colour we control rather than shown as flat art.
  const classes = ['mark'];
  if (id === 'copilot') classes.push('mark--mono');
  if (!known) classes.push('mark--fallback');

  const span = el('span', {
    class: classes.join(' '),
    // The logo geometry itself is the identity; the id selects the art in CSS.
    // Unknown ids get no art and fall back to a neutral ring (.mark--fallback).
    'data-logo': known ? id : null,
    // Decorative: the provider is named by the control that owns this mark.
    'aria-hidden': 'true',
  });

  // The row knows whether the account is wired up; the settings list does not
  // and leaves this unset, deferring to its [data-connected] ancestor.
  if (active !== undefined) span.setAttribute('data-active', active ? 'true' : 'false');

  return span;
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
