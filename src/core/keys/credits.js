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
 * Each element of `usageItems` must carry ONE of these two documented triples,
 * and every element must carry the SAME one:
 *
 *   A. `grossQuantity` / `includedQuantity` / `billedQuantity`
 *   B. `grossAmount`   / `discountAmount`   / `netAmount`
 *
 * B is the shape of GitHub's enhanced-billing usage report, where
 * `discountAmount` is the part covered by the included allowance and
 * `netAmount` is what is billed. A is the credit-quantity spelling of the same
 * three numbers.
 *
 * UNVERIFIED, AND SAFE WHEN WRONG: this lane has no GitHub PAT and no network
 * access, so neither spelling has been confirmed against a live reply. That is
 * why the reader is all-or-nothing and additive-only: if GitHub's field names
 * are neither of these, `creditUsageFrom` returns null, the row reports
 * 'not-available' and NO figure is shown. A wrong name can cost the user a
 * figure; it cannot invent one.
 */

/** Bound on the list we will walk, well under the 256 KiB body cap. */
const MAX_USAGE_ITEMS = 5000;

const FIELD_SHAPES = Object.freeze([
  Object.freeze({ name: 'quantity', gross: 'grossQuantity', included: 'includedQuantity', billed: 'billedQuantity' }),
  Object.freeze({ name: 'amount', gross: 'grossAmount', included: 'discountAmount', billed: 'netAmount' }),
]);

/** A number we are willing to sum: a real, finite, non-negative one. */
function usable(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** The shape an item carries, or null when it carries neither completely. */
function shapeOf(item) {
  for (const shape of FIELD_SHAPES) {
    if (usable(item[shape.gross]) && usable(item[shape.included]) && usable(item[shape.billed])) {
      return shape;
    }
  }
  return null;
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

  let shape = null;
  let gross = 0;
  let included = 0;
  let billed = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const itemShape = shapeOf(item);
    if (itemShape === null) return null;
    // One reply, one spelling. A list that mixes them is a list we have
    // misread, and summing across both would double-count.
    if (shape === null) shape = itemShape;
    else if (shape !== itemShape) return null;
    gross += item[shape.gross];
    included += item[shape.included];
    billed += item[shape.billed];
  }
  // An EMPTY list is a legitimate reading: a month with no AI-credit usage.
  // Zero here is a true statement about a reply we fully understood, which is
  // categorically different from the zero a partial parse would produce — and
  // that path returns null above rather than reaching this line.
  if (shape === null) shape = FIELD_SHAPES[0];

  // Float addition can drift a hair past the guard above; a sum that is not a
  // usable number is discarded rather than repaired.
  if (!usable(gross) || !usable(included) || !usable(billed)) return null;

  const statedStart = instantOf(body.periodStart);
  const statedEnd = instantOf(body.periodEnd);
  let startMs;
  let endMs;
  if (statedStart !== null && statedEnd !== null && statedStart <= statedEnd) {
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
  keyStateForStatus,
  utcMonthBounds,
  MAX_USAGE_ITEMS,
  FIELD_SHAPES,
};
