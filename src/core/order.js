'use strict';
const { PROVIDER_IDS } = require('./providers');

/**
 * User-chosen provider order.
 *
 * The user drags rows in the panel; main persists the resulting id list in its
 * own settings file and applies it before every emit (contract.ts,
 * `Snapshot.providers` — "IN USER ORDER"). The renderer never re-sorts.
 *
 * The whole point of this module is that a stored order is UNTRUSTED input: it
 * is a file on disk that survives upgrades, so it will eventually name a
 * provider that no longer exists, omit one that was added after it was
 * written, or be a hand-edited fragment. None of those may cost the user a row
 * in the panel. The rules, in order of precedence:
 *
 *   1. ids that are not real providers are ignored (never rendered)
 *   2. a duplicate id is honoured once, at its first position
 *   3. providers the order omits are kept, in registry order, AFTER the ones
 *      it names
 *
 * Rule 3 is what makes a stale order file harmless: the worst it can do is put
 * a new provider last.
 */

/** Untrusted list -> the known, deduped ids it names, in its own order. */
function sanitizeOrder(raw, known = PROVIDER_IDS) {
  if (!Array.isArray(raw)) return [];
  const allowed = Array.isArray(known) ? known : [];
  const out = [];
  const seen = new Set();
  for (const id of raw) {
    if (typeof id !== 'string') continue;
    if (!allowed.includes(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Sanitized order, then every remaining known id in its registry order. */
function mergeOrder(raw, known = PROVIDER_IDS) {
  const allowed = Array.isArray(known) ? known : [];
  const named = sanitizeOrder(raw, allowed);
  const seen = new Set(named);
  return [...named, ...allowed.filter((id) => !seen.has(id))];
}

/**
 * Reorders a provider-snapshot array in place-safe fashion.
 *
 * Implemented as a rank sort with the original index as the tiebreak rather
 * than as a lookup-and-rebuild: a rebuild driven by the id list can drop an
 * entry whose id is missing or malformed, and this array is what the panel
 * renders. A sort cannot change the multiset of rows, only their order, which
 * is exactly the guarantee we want here.
 */
function applyOrder(providers, raw) {
  if (!Array.isArray(providers)) return [];
  const present = [];
  for (const p of providers) {
    const id = p && typeof p.id === 'string' ? p.id : null;
    if (id && !present.includes(id)) present.push(id);
  }
  const rank = new Map(mergeOrder(raw, present).map((id, i) => [id, i]));
  return providers
    .map((provider, index) => ({
      provider,
      index,
      // An entry with no usable id keeps its position at the end rather than
      // being discarded.
      rank: rank.has(provider && provider.id) ? rank.get(provider.id) : Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
    .map((entry) => entry.provider);
}

module.exports = { sanitizeOrder, mergeOrder, applyOrder };
