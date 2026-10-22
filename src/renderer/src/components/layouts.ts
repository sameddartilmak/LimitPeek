/**
 * What "Sade liste" and "Halka kutuları" add to the panel (Görünüm → Düzen).
 * The cards themselves are NOT forked: both layouts draw the same row
 * component (row.ts, with its meter, states, details, tooltips and meters'
 * aria), and the layouts are its CSS (styles/layout-sade.css,
 * layout-halka.css) plus the one thing here: the way back from a tool's
 * details, which in both layouts are a sheet over the other tools rather than
 * a card that grew.
 *
 * WHAT WENT WITH THE OLD LAYOUTS (minimal redesign, owner 2026-10-22)
 * ------------------------------------------------------------------
 * "Öne çıkan" picked a hero (the tool closest to its limit, moved to the top)
 * and "Kutucuklar" drew four quick tiles (Tema / Şerit / Ayarlar / Yenile)
 * under its grid. Both went with their layouts: the short list keeps the
 * user's own order, and the header's small refresh and settings icons are the
 * quick actions now, in every layout.
 */

import { el, on, svg } from '../dom.js';
import { t } from '../i18n.js';

function backIcon(): SVGElement {
  return svg(
    'svg',
    { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
    svg('path', {
      d: 'M10 4l-4 4 4 4',
      stroke: 'currentColor',
      'stroke-width': '1.6',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }),
  );
}

/**
 * "‹ Tüm araçlar": shown above a tool's details while they are a sheet. The
 * card's own "Ayrıntıları gizle" and Esc do the same; this one is where the
 * eye looks for a way back, at the top.
 */
export function createSheetBack(onBack: () => void): HTMLButtonElement {
  const button = el(
    'button',
    { type: 'button', class: 'sheet-back', 'aria-label': t('layout.sheet.backLabel') },
    backIcon(),
    el('span', { class: 'sheet-back__label' }, t('layout.sheet.back')),
  ) as HTMLButtonElement;
  on(button, 'click', () => onBack());
  button.hidden = true;
  return button;
}
