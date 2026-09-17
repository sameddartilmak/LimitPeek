/**
 * The "experimental" marker (ADR-003 Amendment 6, decision 4).
 *
 * A provider whose local reader was written from the vendor's source but has
 * not been confirmed against a real install carries this pill wherever its
 * name appears as a row: the panel row and Settings → Model Yönetimi. It is a
 * statement about the READER, not about the user's data, so it is calm: ink,
 * no warning colour, no icon.
 *
 * The explanation is the pill's hover title for a pointer, and the same text
 * sits inside the pill for a screen reader (visually hidden), so the spoken and
 * the hovered description never diverge.
 */

import type { ProviderSnapshot } from '../../../shared/contract.js';
import { el } from '../dom.js';
import { t } from '../i18n.js';

/** The pill for an experimental provider, or null for every other one. */
export function experimentalTag(provider: Pick<ProviderSnapshot, 'experimental'>): HTMLElement | null {
  if (!provider.experimental) return null;
  const detail = t('provider.experimentalDetail');
  return el(
    'span',
    { class: 'tag-experimental', title: detail, 'data-experimental': 'true' },
    t('provider.experimental'),
    el('span', { class: 'u-sr' }, ` (${detail})`),
  );
}
