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
  PeriodModelCost,
  PeriodUsage,
  ProviderSnapshot,
  TokenBreakdown,
} from '../../shared/contract.js';

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
 * One model entry's own count, or null when none arrived.
 *
 * `null` and an all-zero breakdown are different states here too: null is "no
 * count", zero is a count of zero. Only the first hides the figure.
 */
export function modelTokens(model: PeriodModelCost): TokenBreakdown | null {
  return model.tokens ?? null;
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
