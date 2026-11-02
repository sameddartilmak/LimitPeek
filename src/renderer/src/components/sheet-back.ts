/**
 * The way back from a tool's details. The panel draws every tool as one
 * short line (row.ts, laid out by styles/list.css), and a click on one opens
 * its details as a sheet over the other tools rather than a card that grew;
 * this is the "‹ Tüm araçlar" above that sheet.
 *
 * The panel had other layouts once ("Öne çıkan", "Kutucuklar", then "Halka
 * kutuları"); the owner removed the last of them on 2026-11-02 ("Bu düzen hiç
 * olmasın"), and with one layout left there is no "Düzen" setting either.
 * The list keeps the user's own order, and the header's small refresh and
 * settings icons are the quick actions.
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
    { type: 'button', class: 'sheet-back', 'aria-label': t('sheet.backLabel') },
    backIcon(),
    el('span', { class: 'sheet-back__label' }, t('sheet.back')),
  ) as HTMLButtonElement;
  on(button, 'click', () => onBack());
  button.hidden = true;
  return button;
}
