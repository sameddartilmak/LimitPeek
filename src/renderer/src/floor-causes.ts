/**
 * One short clause per floor cause — the single vocabulary for "why is this a
 * lower bound", shared by the panel row and by Toplam Kullanım.
 *
 * It lives here rather than inside one component because ADR-002 A3.16 says a
 * floor is never shown without a visible cause, and that rule now applies on
 * two surfaces at once: the row's weekly token count and the history section's
 * per-model and per-tool counts. Two copies of this map would drift, and the
 * drift would show as one surface naming a cause and the other printing a bare
 * "en az" — which is the state A3.16 forbids.
 *
 * ADR-004 Amendment 3 governs the wording: ONE short clause per cause, no
 * hedging, and the justification (why Codex cannot record a cache write, what
 * the 1,024-token minimum is) stays in README/ADR where it has room.
 *
 * `cache-write-ttl-fallback` is the one clause that takes a parameter, and it
 * is supplied here so no caller has to know that. It is a MONETARY cause and
 * therefore never appears on a token figure, but the map covers every code so
 * the cost note can use the same source.
 */

import type { HistoryFloorCause } from '../../shared/contract.js';
import { multiplier } from './format.js';
import { t, type MessageKey } from './i18n.js';

export const CAUSE_CLAUSE: Record<HistoryFloorCause, MessageKey> = {
  // TOKEN-side only (contract, HistoryFloorCause): on the cost side a
  // known-unread range has its own field and note, and ADR-002 A3.20 rules that
  // the price notes do not grow a clause for it. A token floor has no such
  // field to lean on, so on that side the gap must be nameable.
  'unread-range': 'settings.usage.cause.unreadRange',
  unpriced: 'settings.usage.cause.unpriced',
  'cache-write-ttl-fallback': 'settings.usage.cause.ttl',
  'unrecorded-writes': 'settings.usage.cause.unrecordedWrites',
  'assumed-tier': 'settings.usage.cause.assumedTier',
  'fast-requested': 'settings.usage.cause.fastRequested',
  'unrecorded-calls': 'settings.usage.cause.unrecordedCalls',
  'long-prompt': 'settings.usage.cause.longPrompt',
  'tool-tokens': 'settings.usage.cause.toolTokens',
};

/** The clause for one cause, with its parameter already supplied. */
export function floorCauseClause(cause: HistoryFloorCause): string {
  return cause === 'cache-write-ttl-fallback'
    ? t(CAUSE_CLAUSE[cause], { low: multiplier(1.25) })
    : t(CAUSE_CLAUSE[cause]);
}
