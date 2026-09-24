'use strict';

/**
 * The GitHub AI-credit reply reader (ADR-003 Amendment 6 decision 3, Amendment 8).
 *
 * WHAT IT PRODUCES
 * ----------------
 * `CreditUsage { grossCredits, includedCredits, billedCredits, periodStart,
 * periodEnd, fetchedAt }` — credits consumed in the current calendar month, the
 * part the plan covered, and the billed overage. NO percentage and NO
 * allowance: the reply carries no denominator (A6.3), and a guessed plan
 * allowance would be a fabricated one, which is the exact failure ADR-001
 * exists to prevent. There is no field in this shape a percentage could be
 * built from downstream either, which is deliberate.
 *
 * ALL OR NOTHING
 * --------------
 * Amendment 2's C12 discipline, applied to a different reply: a figure is
 * either fully validated or absent. Never clamped, never partially filled,
 * never defaulted to zero. One bad item discards the whole reading, because a
 * sum over a list we only partly understood is a number with no meaning — and
 * it would look exactly like a real one.
 *
 * WHICH FIELDS ARE SUMMED
 * -----------------------
 * GitHub documents each `usageItems` element as carrying BOTH a credit
 * quantity triple and a dollar amount triple (docs.github.com/en/rest/billing/
 * usage, "Get billing AI credit usage report for a user", checked 2026-09-23):
 *
 *   grossQuantity / discountQuantity / netQuantity   credits (unitType ai-credits)
 *   grossAmount   / discountAmount   / netAmount      US dollars
 *
 * `discount` is the part the plan's included allowance covered and `net` is
 * the billed overage. Only the QUANTITY triple is read: the row says
 * "credits", and summing the dollar triple would print dollars under that
 * word. An earlier reader expected `includedQuantity` / `billedQuantity`,
 * which GitHub never sends, and then fell back to the dollar triple. That is
 * exactly the dollars-as-credits error, so the dollar fields are not a
 * fallback any more.
 *
 * An item whose `unitType` is stated and is not AI credits is a unit we do not
 * understand, and discards the reading. ALL OR NOTHING still holds: a missing
 * or malformed number anywhere means no figure, never a partial one.
 */

/** Bound on the list we will walk, well under the 256 KiB body cap. */
const MAX_USAGE_ITEMS = 5000;

/** The credit quantity triple GitHub documents on every usage item. */
const QUANTITY = Object.freeze({ name: 'quantity', gross: 'grossQuantity', included: 'discountQuantity', billed: 'netQuantity' });

/** GitHub's documented unit for this report, compared loosely ("ai-credits"). */
const CREDIT_UNIT = /^ai[-_ ]?credits?$/i;

/** A number we are willing to sum: a real, finite, non-negative one. */
function usable(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Does the item carry a full credit triple in a unit we understand? */
function readable(item) {
  if (item.unitType !== undefined && !(typeof item.unitType === 'string' && CREDIT_UNIT.test(item.unitType))) return false;
  return usable(item[QUANTITY.gross]) && usable(item[QUANTITY.included]) && usable(item[QUANTITY.billed]);
}

/**
 * The month the reply says it covers, from `timePeriod: {year, month}`, or
 * null. A year alone is not a month, so it is not used.
 */
function statedMonth(timePeriod) {
  if (!timePeriod || typeof timePeriod !== 'object') return null;
  const { year, month } = timePeriod;
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12 || year < 2000 || year > 2200) return null;
  return { start: Date.UTC(year, month - 1, 1), end: Date.UTC(year, month, 1) };
}

/** An ISO instant from a reply field, or null. Never a guess. */
function instantOf(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 40) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The UTC calendar month containing `ms`.
 *
 * Used only when the reply states no period of its own. It is arithmetic on a
 * DOCUMENTED reset schedule, not an invented figure: Copilot moved to monthly
 * AI credits that reset at 00:00 UTC on the 1st (A6), and the endpoint reports
 * the current month when asked for no month. Stating the month we asked about
 * is therefore a true statement; stating a *usage number* we had not read
 * would not be.
 */
function utcMonthBounds(ms) {
  const d = new Date(ms);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0);
  return { start, end };
}

/**
 * @param {unknown} body   the parsed JSON reply
 * @param {number} fetchedAtMs
 * @returns {{grossCredits:number, includedCredits:number, billedCredits:number,
 *           periodStart:string, periodEnd:string, fetchedAt:string, fields:string}|null}
 *   `fields` names the triple that was summed. It is diagnostic only and is
 *   stripped before the value reaches the snapshot.
 */
function creditUsageFrom(body, fetchedAtMs) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (!Number.isFinite(fetchedAtMs)) return null;

  const items = body.usageItems;
  if (!Array.isArray(items) || items.length > MAX_USAGE_ITEMS) return null;

  let gross = 0;
  let included = 0;
  let billed = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    if (!readable(item)) return null;
    gross += item[QUANTITY.gross];
    included += item[QUANTITY.included];
    billed += item[QUANTITY.billed];
  }
  // An EMPTY list is a legitimate reading: a month with no AI-credit usage.
  // Zero here is a true statement about a reply we fully understood, which is
  // categorically different from the zero a partial parse would produce — and
  // that path returns null above rather than reaching this line.
  const shape = QUANTITY;

  // Float addition can drift a hair past the guard above; a sum that is not a
  // usable number is discarded rather than repaired.
  if (!usable(gross) || !usable(included) || !usable(billed)) return null;

  // The documented reply states its period as `timePeriod: {year, month}`.
  // `periodStart` / `periodEnd` are kept as a second spelling.
  const month = statedMonth(body.timePeriod);
  const statedStart = instantOf(body.periodStart);
  const statedEnd = instantOf(body.periodEnd);
  let startMs;
  let endMs;
  if (month) {
    startMs = month.start;
    endMs = month.end;
  } else if (statedStart !== null && statedEnd !== null && statedStart <= statedEnd) {
    startMs = statedStart;
    endMs = statedEnd;
  } else {
    const bounds = utcMonthBounds(fetchedAtMs);
    startMs = bounds.start;
    endMs = bounds.end;
  }

  return {
    grossCredits: gross,
    includedCredits: included,
    billedCredits: billed,
    periodStart: new Date(startMs).toISOString(),
    periodEnd: new Date(endMs).toISOString(),
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    fields: shape.name,
  };
}

/** The snapshot-facing value: the same object without the diagnostic field. */
function toContractShape(usage) {
  if (!usage) return null;
  return {
    grossCredits: usage.grossCredits,
    includedCredits: usage.includedCredits,
    billedCredits: usage.billedCredits,
    periodStart: usage.periodStart,
    periodEnd: usage.periodEnd,
    fetchedAt: usage.fetchedAt,
  };
}

/**
 * A figure read back from disk, reduced to the contract shape or null. The
 * file is ours, but it is still input: a hand-edited or truncated one must not
 * put a negative count, a missing period or a reading from the future on
 * screen.
 *
 * @param {unknown} raw
 * @param {number} now
 */
function sanitizeFigure(raw, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!usable(raw.grossCredits) || !usable(raw.includedCredits) || !usable(raw.billedCredits)) return null;
  const start = instantOf(raw.periodStart);
  const end = instantOf(raw.periodEnd);
  const fetched = instantOf(raw.fetchedAt);
  if (start === null || end === null || fetched === null || start > end) return null;
  // A reading dated in the future is a clock that moved or a tampered file.
  if (Number.isFinite(now) && fetched > now + 60 * 1000) return null;
  return {
    grossCredits: raw.grossCredits,
    includedCredits: raw.includedCredits,
    billedCredits: raw.billedCredits,
    periodStart: new Date(start).toISOString(),
    periodEnd: new Date(end).toISOString(),
    fetchedAt: new Date(fetched).toISOString(),
  };
}

/**
 * HTTP status -> the fixed `keyState` code the contract allows (A8, K19).
 *
 * Provider text never travels: not the body, not a header, not a URL, not an
 * `err.message`. The renderer prints its own sentence per code, so GitHub's
 * wording — which may name a repository, an organisation or an account — cannot
 * reach a surface, a log or the snapshot.
 *
 *  401 -> 'key-rejected'          the key is wrong, revoked or expired
 *  403 -> 'key-lacks-permission'  authenticated but not allowed to read the plan,
 *                                 UNLESS the reply says it is a rate limit
 *  404 -> 'not-available'         no such user, or no AI-credit report for them
 *                                 (GitHub's answer for a plan this does not cover)
 *  429 -> 'rate-limited'
 *  anything else (incl. 3xx under `redirect:'error'`, 5xx, and every transport
 *  failure) -> 'unreachable'
 *
 * GitHub SPENDS 403 ON BOTH MEANINGS, which is why the third argument exists
 * (security review of Phase B, F2). Its SECONDARY rate limit is a 403 carrying
 * `Retry-After`; its PRIMARY one is a 403 carrying no `Retry-After` at all and
 * `x-ratelimit-remaining: 0`. Reading only the first left the second telling the
 * user to fix a permission that was already correct — a confidently wrong
 * instruction, which is the class of statement ADR-001 exists to prevent. Both
 * shapes are rate limits and both wait.
 *
 * `x-ratelimit-remaining` is compared as the STRING '0': it is a header value,
 * never coerced, and any other value (including an absent one) leaves the 403
 * meaning what it says.
 *
 * @param {number} status
 * @param {number|null} retryAfterMs already-parsed Retry-After, or null
 * @param {string|null} [rateLimitRemaining] the `x-ratelimit-remaining` header
 */
function keyStateForStatus(status, retryAfterMs, rateLimitRemaining) {
  if (status === 401) return 'key-rejected';
  if (status === 403) {
    if (retryAfterMs !== null && retryAfterMs !== undefined) return 'rate-limited';
    return rateLimitRemaining === '0' ? 'rate-limited' : 'key-lacks-permission';
  }
  if (status === 404) return 'not-available';
  if (status === 429) return 'rate-limited';
  return 'unreachable';
}

module.exports = {
  creditUsageFrom,
  toContractShape,
  sanitizeFigure,
  keyStateForStatus,
  utcMonthBounds,
  MAX_USAGE_ITEMS,
  QUANTITY,
};
