/**
 * Absolute token counts, renderer side — what may be read, and the three things
 * that may never be done with them.
 *
 * NEVER SUMMED ACROSS TOOLS (ADR-001; contract `PeriodUsage.tokensByProvider`).
 * Dollars add because both sides are USD at published rates. Token counts do
 * not: each vendor counts and bills its classes its own way, and `cacheRead`
 * (~98% of raw volume, billed at 0.1x) sits in a different proportion in each.
 * `tokensByProvider` is a map, and a map is trivially summable — an
 * `Object.values(...).reduce(...)` here would produce exactly the merged
 * cross-tool total the ADR bans and nothing would fail. So this module gives
 * the renderer ONE accessor, `tokensFor(period, id)`, which can only ever
 * return one tool's own figure, and there is no function here that takes a
 * period and returns a number.
 *
 * NEVER DIVIDED BY ANYTHING. These are absolute measurements. They feed no
 * percentage, no bar and no meter (ADR-001 Decision 1): there is no published
 * denominator to divide by, and inventing one is the fabrication that ADR
 * rejects.
 *
 * NEVER TREATED AS ABSENT BECAUSE THEY ARE ZERO. This was a real defect: the
 * presence test used to be "some class is non-zero", so a quota week with no
 * usage — which Claude's reader reports as an all-zero breakdown — rendered
 * "could not be counted". We HAD counted; the answer was zero. Presence is
 * `null` vs non-null and nothing else. A zero is a measurement and prints as
 * one; `allZero()` exists only so the ONE state that really is a no-figure
 * state (ADR-002 A3.19, a week whose records could not be read) can be told
 * apart from it, and that state is identified by `weeklyCost.sourceIncomplete`,
 * not by the zero.
 *
 * `billable` (input + output + cacheWrite) EXCLUDES `cacheRead`. It is the
 * headline; `cacheRead` is reported beside it as its own number. A single
 * figure folding all four classes together is banned — it would be ~98%
 * cacheRead and would say nothing.
 */

import type {
  HistoryFloorCause,
  PeriodModelCost,
  PeriodUsage,
  ProviderSnapshot,
  TokenBreakdown,
} from '../../shared/contract.js';

/**
 * Whether there is a BILLABLE figure to print — the quantity every caller
 * actually renders.
 *
 * This is deliberately a different question from `hasTokenCount`, and the
 * difference was a defect: the guard used to test "any class non-zero" while
 * every caller printed `billable`, so a breakdown whose only non-zero class was
 * `cacheRead` (a fully cached Gemini turn; a Codex delta with cached input and
 * no output) passed the guard and rendered "en az 0 token" — a no-figure state
 * dressed as a measured floor, which is the exact thing this feature exists to
 * prevent. Test the quantity you print.
 *
 * A zero is still PRINTED (see the header): what this gates is the "en az"
 * marker, because a lower bound of zero qualifies nothing.
 */
export function hasBillableCount(tk: TokenBreakdown | null | undefined): boolean {
  return !!tk && tk.billable > 0;
}

/**
 * Whether the class breakdown is worth attaching at all — any class non-zero.
 *
 * Used ONLY to decide whether a four-class title/tooltip has anything to say.
 * Never to decide whether a figure prints, and never as a presence test: that
 * is `null` vs non-null, nothing else.
 */
export function hasTokenCount(tk: TokenBreakdown | null | undefined): boolean {
  return (
    !!tk &&
    (tk.billable > 0 || tk.cacheRead > 0 || tk.input > 0 || tk.output > 0 || tk.cacheWrite > 0)
  );
}

/**
 * Whether every class is zero.
 *
 * NOT a presence test — see the header. It exists for exactly one caller: the
 * A3.19 state, where main sends a zero count for a week whose records it knows
 * it could not read. That state is recognised by `sourceIncomplete` AND a zero
 * count together; a zero on its own is a measured empty week.
 */
export function allZero(tk: TokenBreakdown | null | undefined): boolean {
  return (
    !!tk &&
    tk.billable === 0 &&
    tk.cacheRead === 0 &&
    tk.input === 0 &&
    tk.output === 0 &&
    tk.cacheWrite === 0
  );
}

/**
 * Why THIS ROW's weekly count is a lower bound — empty when it is not one.
 *
 * Causes, not a boolean, because ADR-002 A3.16 forbids showing a floor without
 * a visible reason, and there is a real state with no cost cause to borrow: a
 * Gemini week where nothing could be priced marks the token floor (its utility
 * calls went unrecorded regardless) while `unrecordedCalls`, a COST cause,
 * stays false.
 *
 * Read only from this field. The renderer must not re-derive it from
 * `weeklyCost.sourceIncomplete`, `unrecordedCalls` or `unrecordedWriteEvents`,
 * and must not special-case a provider by id: those signals are individually
 * incomplete, and provider-specific honesty knowledge kept in the renderer is
 * knowledge the next surface will not carry.
 */
export function weeklyTokenFloorCauses(provider: ProviderSnapshot): HistoryFloorCause[] {
  const causes = provider.weeklyTokenFloorCauses;
  return Array.isArray(causes) ? causes : [];
}

/**
 * Why one tool's count is a lower bound in THIS period — empty when it is not.
 *
 * Never `PeriodUsage.isFloor` and never a model's own `isFloor`: both are
 * statements about DOLLARS, and the monetary causes (an unpriced model, an
 * assumed or Fast tier, Claude's cache-write TTL fallback) counted every token
 * they saw. A period can read "en az $301,12" beside an exact count, and one
 * tool's dollars being a floor never marks another tool's tokens.
 */
export function tokenFloorCausesFor(
  period: PeriodUsage,
  id: ProviderSnapshot['id'],
): HistoryFloorCause[] {
  const byProvider = period.tokenFloorCausesByProvider;
  if (byProvider && typeof byProvider === 'object') {
    const causes = byProvider[id];
    if (Array.isArray(causes)) return causes;
  }
  return [];
}

/**
 * One model entry's own count, or null when none arrived.
 *
 * `null` and an all-zero breakdown are different states here too: null is "no
 * count", zero is a count of zero. Only the first hides the figure.
 */
export function modelTokens(model: PeriodModelCost): TokenBreakdown | null {
  return model.tokens ?? null;
}

/**
 * Whether "en az" may be printed on a figure: main says the count is a lower
 * bound AND there is a positive figure for that bound to qualify.
 *
 * "en az 0 token" is banned in both directions it can arise — an entirely zero
 * count (the contract already empties the causes for that one) and a count whose
 * only non-zero class is `cacheRead`, which the contract does NOT exempt because
 * it is not entirely zero. The causes are still shown when they exist, so the
 * fact that the count understates is never lost — only the vacuous bound is.
 */
export function marksFloor(tk: TokenBreakdown | null, causes: readonly HistoryFloorCause[]): boolean {
  return causes.length > 0 && hasBillableCount(tk);
}

/** One tool's own count in a period, or null when it has none here. */
export function tokensFor(period: PeriodUsage, id: ProviderSnapshot['id']): TokenBreakdown | null {
  const map = period.tokensByProvider ?? {};
  return map[id] ?? null;
}

/**
 * The tools with a count in this period, in the order `usageProviders` lists
 * them so the panel's tool order is one order everywhere. Returns IDS, never
 * figures: a caller that wants numbers has to ask for one tool at a time.
 */
export function providersWithTokens(
  period: PeriodUsage,
  order: readonly ProviderSnapshot['id'][],
): ProviderSnapshot['id'][] {
  const present = Object.keys(period.tokensByProvider ?? {}) as ProviderSnapshot['id'][];
  const ranked = order.filter((id) => present.includes(id));
  // A tool main did not list still gets shown rather than silently dropped.
  for (const id of present) if (!ranked.includes(id)) ranked.push(id);
  return ranked.filter((id) => tokensFor(period, id) !== null);
}
