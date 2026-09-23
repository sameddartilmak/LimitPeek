/**
 * The optional API key, renderer side (ADR-003 Amendment 5 + Amendment 8).
 *
 * WHAT THIS FILE IS ALLOWED TO KNOW
 * ---------------------------------
 * A key state, the instant it was stored, and numbers. Never the key, never a
 * length, never a mask (K23): there is no getter for a key anywhere in the
 * renderer, and nothing here can construct one. A "•••• 1234" affordance is
 * exactly what K23 forbids, so the only thing this lane renders about the
 * secret itself is WHETHER one is stored.
 *
 * WHY THERE IS NO PERCENTAGE
 * --------------------------
 * GitHub's AI-credit reply carries no allowance (ADR-003 A6.3): gross,
 * included and billed credits, and nothing to divide by. A bar, a ring or a
 * "%" here would need a denominator we would have to invent, which is the same
 * fabrication ADR-001 forbids for a quota with no published limit. So the
 * credit figure is three counts and a fetch time — never a gauge.
 *
 * The types come from `shared/contract.ts` (Amendment 8 landed). They are read
 * through `keyFieldsOf()`, which still tolerates a main process that predates
 * them: every field absent reads as "not key-capable", the state that renders
 * nothing at all.
 */

import type { CreditUsage, KeyState, ProviderSnapshot } from '../../shared/contract.js';
import type { MessageKey } from './i18n.js';

export type { CreditUsage, KeyState };

/** The four key fields of a row, as the contract declares them. */
export type KeyFields = Pick<
  ProviderSnapshot,
  'keyCapable' | 'keyState' | 'keyStoredAt' | 'creditUsage'
>;

const KEY_STATES: readonly KeyState[] = [
  'none',
  'stored',
  'key-rejected',
  'key-lacks-permission',
  'rate-limited',
  'not-available',
  'unreachable',
  'unreadable',
  'secure-storage-unavailable',
];

const DEFAULTS: KeyFields = {
  keyCapable: false,
  keyState: 'none',
  keyStoredAt: null,
  creditUsage: null,
};

/**
 * The key fields of a provider row. Sanitised at the IPC boundary
 * (`sanitize.ts`), so this only reads them; an older main that sends none
 * reads as a provider with no key option at all, which is the state that
 * renders nothing.
 */
export function keyFieldsOf(provider: ProviderSnapshot): KeyFields {
  const p = provider as Partial<KeyFields>;
  return {
    keyCapable: p.keyCapable === true,
    keyState: p.keyState && KEY_STATES.includes(p.keyState) ? p.keyState : DEFAULTS.keyState,
    keyStoredAt: typeof p.keyStoredAt === 'string' && p.keyStoredAt !== '' ? p.keyStoredAt : null,
    creditUsage: p.creditUsage ?? null,
  };
}

/**
 * The one short sentence a state other than 'none' prints. 'stored' with a
 * figure prints the figure instead, so its sentence covers only the gap
 * between storing a key and the first reading.
 */
const STATE_SENTENCE: Record<Exclude<KeyState, 'none'>, MessageKey> = {
  stored: 'key.state.stored',
  'key-rejected': 'key.state.rejected',
  'key-lacks-permission': 'key.state.lacksPermission',
  'rate-limited': 'key.state.rateLimited',
  'not-available': 'key.state.notAvailable',
  unreachable: 'key.state.unreachable',
  unreadable: 'key.state.unreadable',
  'secure-storage-unavailable': 'key.state.secureStorageUnavailable',
};

export function keyStateSentence(state: KeyState): MessageKey | null {
  return state === 'none' ? null : STATE_SENTENCE[state];
}

/**
 * The two states a new key fixes, so the panel offers the token page beside
 * them (owner's Amendment 8 addendum). Never offered with no key stored: with
 * nothing to replace, the affordance would be an unsolicited push to create a
 * credential (K2's "never pushed on the user").
 */
export function offersTokenPage(state: KeyState): boolean {
  return state === 'key-rejected' || state === 'key-lacks-permission';
}
