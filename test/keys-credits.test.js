'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  creditUsageFrom, toContractShape, keyStateForStatus, utcMonthBounds, MAX_USAGE_ITEMS,
} = require('../src/core/keys/credits');

/**
 * The credit reader (ADR-003 Amendment 6 decision 3, Amendment 8): all or
 * nothing, no percentage, and a fixed code for every failure.
 *
 * The reply-mutation block below is the load-bearing one. Every mutation is a
 * plausible shape for a reply we have misread — a missing field, a string where
 * a number belongs, a negative, a NaN, a mixed list — and every one of them must
 * produce NO FIGURE rather than a partial sum. A partial sum would look exactly
 * like a real number, which is the failure ADR-001 exists to prevent.
 */

const AT = Date.parse('2026-09-22T10:30:00Z');

function reply(items, extra) {
  return { usageItems: items, ...(extra || {}) };
}

const QUANTITY_ITEM = { grossQuantity: 12.5, discountQuantity: 10, netQuantity: 2.5 };
const AMOUNT_ITEM = { grossAmount: 4, discountAmount: 3, netAmount: 1 };

/**
 * One item exactly as GitHub documents it (docs.github.com/en/rest/billing/
 * usage, AI credit report for a user): the credit triple AND the dollar triple
 * side by side. Values chosen so a dollar sum would be visibly different.
 */
const DOCUMENTED_ITEM = {
  product: 'copilot', sku: 'copilot_ai_credit', model: 'gpt-5.6-sol', unitType: 'ai-credits',
  pricePerUnit: 0.04,
  grossQuantity: 300, grossAmount: 12, discountQuantity: 250, discountAmount: 10,
  netQuantity: 50, netAmount: 2,
};

test('a reply in the documented shape is read as CREDITS, never dollars', () => {
  const usage = creditUsageFrom({
    timePeriod: { year: 2026, month: 9 }, user: 'octocat',
    usageItems: [DOCUMENTED_ITEM, DOCUMENTED_ITEM],
  }, AT);
  assert.ok(usage);
  assert.deepEqual([usage.grossCredits, usage.includedCredits, usage.billedCredits], [600, 500, 100]);
  // Its stated month is the period.
  assert.equal(usage.periodStart, '2026-09-01T00:00:00.000Z');
  assert.equal(usage.periodEnd, '2026-10-01T00:00:00.000Z');
});

test('the dollar triple alone is NOT read: dollars would print under the word credits', () => {
  assert.equal(creditUsageFrom(reply([AMOUNT_ITEM]), AT), null);
});

test('an item in a unit other than AI credits discards the reading', () => {
  assert.equal(creditUsageFrom(reply([{ ...QUANTITY_ITEM, unitType: 'minutes' }]), AT), null);
  assert.ok(creditUsageFrom(reply([{ ...QUANTITY_ITEM, unitType: 'AI-Credits' }]), AT));
});

test('a stated month wins over the fetch month; a year alone does not', () => {
  const aug = creditUsageFrom(reply([QUANTITY_ITEM], { timePeriod: { year: 2026, month: 8 } }), AT);
  assert.equal(aug.periodStart, '2026-08-01T00:00:00.000Z');
  assert.equal(aug.periodEnd, '2026-09-01T00:00:00.000Z');
  const yearOnly = creditUsageFrom(reply([QUANTITY_ITEM], { timePeriod: { year: 2026 } }), AT);
  assert.equal(yearOnly.periodStart, '2026-09-01T00:00:00.000Z');
  const nonsense = creditUsageFrom(reply([QUANTITY_ITEM], { timePeriod: { year: 2026, month: 13 } }), AT);
  assert.equal(nonsense.periodStart, '2026-09-01T00:00:00.000Z');
});

test('the quantity triple is summed across items', () => {
  const usage = creditUsageFrom(reply([QUANTITY_ITEM, QUANTITY_ITEM]), AT);
  assert.ok(usage);
  assert.equal(usage.grossCredits, 25);
  assert.equal(usage.includedCredits, 20);
  assert.equal(usage.billedCredits, 5);
  assert.equal(usage.fields, 'quantity');
  assert.equal(usage.fetchedAt, '2026-09-22T10:30:00.000Z');
});

test('the period defaults to the UTC calendar month of the fetch, and the reply can override it', () => {
  const derived = creditUsageFrom(reply([QUANTITY_ITEM]), AT);
  assert.equal(derived.periodStart, '2026-09-01T00:00:00.000Z');
  assert.equal(derived.periodEnd, '2026-10-01T00:00:00.000Z');

  const stated = creditUsageFrom(
    reply([QUANTITY_ITEM], { periodStart: '2026-08-01T00:00:00Z', periodEnd: '2026-09-01T00:00:00Z' }),
    AT,
  );
  assert.equal(stated.periodStart, '2026-08-01T00:00:00.000Z');
  assert.equal(stated.periodEnd, '2026-09-01T00:00:00.000Z');

  // A period that makes no sense is ignored rather than passed through.
  const backwards = creditUsageFrom(
    reply([QUANTITY_ITEM], { periodStart: '2026-10-01T00:00:00Z', periodEnd: '2026-09-01T00:00:00Z' }),
    AT,
  );
  assert.equal(backwards.periodStart, '2026-09-01T00:00:00.000Z');

  assert.deepEqual(utcMonthBounds(Date.parse('2026-12-31T23:59:59Z')), {
    start: Date.parse('2026-12-01T00:00:00Z'),
    end: Date.parse('2027-01-01T00:00:00Z'),
  });
});

test('an empty list is a real reading of a month with no usage', () => {
  const usage = creditUsageFrom(reply([]), AT);
  assert.ok(usage);
  assert.deepEqual([usage.grossCredits, usage.includedCredits, usage.billedCredits], [0, 0, 0]);
});

test('reply-mutation fixtures produce NO figure', () => {
  const cases = [
    ['no body', null],
    ['a string body', 'usage'],
    ['an array body', [QUANTITY_ITEM]],
    ['no usageItems', {}],
    ['usageItems is not an array', reply({ 0: QUANTITY_ITEM })],
    ['usageItems is a string', reply('lots')],
    ['an item that is null', reply([QUANTITY_ITEM, null])],
    ['an item that is a string', reply([QUANTITY_ITEM, 'x'])],
    ['an item that is an array', reply([[1, 2, 3]])],
    ['a missing third field', reply([{ grossQuantity: 1, discountQuantity: 1 }])],
    ['a numeric string', reply([{ grossQuantity: '12.5', discountQuantity: 10, netQuantity: 2.5 }])],
    ['a negative', reply([{ grossQuantity: -1, discountQuantity: 0, netQuantity: 0 }])],
    ['a NaN', reply([{ grossQuantity: Number.NaN, discountQuantity: 0, netQuantity: 0 }])],
    ['an Infinity', reply([{ grossQuantity: Number.POSITIVE_INFINITY, discountQuantity: 0, netQuantity: 0 }])],
    ['null where a number belongs', reply([{ grossQuantity: null, discountQuantity: 0, netQuantity: 0 }])],
    ['a boolean where a number belongs', reply([{ grossQuantity: true, discountQuantity: 0, netQuantity: 0 }])],
    ['a mixed list', reply([QUANTITY_ITEM, AMOUNT_ITEM])],
    ['a list past the cap', reply(new Array(MAX_USAGE_ITEMS + 1).fill(QUANTITY_ITEM))],
    ['GitHub’s field names renamed', reply([{ credits: 12, included: 10, billed: 2 }])],
    ['a percentage instead of counts', reply([{ usedPercentage: 62 }])],
  ];
  for (const [label, body] of cases) {
    assert.equal(creditUsageFrom(body, AT), null, label);
  }
  // And a fetch instant we cannot stamp is refused too.
  assert.equal(creditUsageFrom(reply([QUANTITY_ITEM]), Number.NaN), null);
  assert.equal(creditUsageFrom(reply([QUANTITY_ITEM]), undefined), null);
});

test('no percentage and no allowance exists in the contract shape (A6.3)', () => {
  const usage = toContractShape(creditUsageFrom(reply([QUANTITY_ITEM]), AT));
  assert.deepEqual(Object.keys(usage).sort(), [
    'billedCredits', 'fetchedAt', 'grossCredits', 'includedCredits', 'periodEnd', 'periodStart',
  ]);
  const text = JSON.stringify(usage);
  for (const word of ['percent', 'Percentage', 'allowance', 'limit', 'quota', 'remaining']) {
    assert.equal(text.includes(word), false, word);
  }
  // The diagnostic field never reaches the contract shape.
  assert.equal('fields' in usage, false);
  assert.equal(toContractShape(null), null);
});

test('HTTP status maps to the contract’s fixed codes and nothing else (K19)', () => {
  assert.equal(keyStateForStatus(401, null), 'key-rejected');
  assert.equal(keyStateForStatus(403, null), 'key-lacks-permission');
  // GitHub's secondary rate limit is a 403 that asks us to come back later.
  assert.equal(keyStateForStatus(403, 900000), 'rate-limited');
  // …and its PRIMARY one is a 403 with NO Retry-After and no quota left
  // (security review of Phase B, F2). Calling that 'key-lacks-permission' told
  // the user to fix a permission that was already correct.
  assert.equal(keyStateForStatus(403, null, '0'), 'rate-limited');
  // Any other value leaves the 403 meaning what it says. Compared as a string:
  // a header value is never coerced.
  assert.equal(keyStateForStatus(403, null, '1'), 'key-lacks-permission');
  assert.equal(keyStateForStatus(403, null, '4999'), 'key-lacks-permission');
  assert.equal(keyStateForStatus(403, null, ''), 'key-lacks-permission');
  assert.equal(keyStateForStatus(403, null, null), 'key-lacks-permission');
  assert.equal(keyStateForStatus(403, null, undefined), 'key-lacks-permission');
  assert.equal(keyStateForStatus(403, null, 0), 'key-lacks-permission');
  // The header does not turn any OTHER status into a rate limit.
  assert.equal(keyStateForStatus(401, null, '0'), 'key-rejected');
  assert.equal(keyStateForStatus(404, null, '0'), 'not-available');
  assert.equal(keyStateForStatus(500, null, '0'), 'unreachable');
  assert.equal(keyStateForStatus(404, null), 'not-available');
  assert.equal(keyStateForStatus(429, null), 'rate-limited');
  for (const status of [0, 301, 302, 307, 400, 402, 418, 500, 502, 503, 504]) {
    assert.equal(keyStateForStatus(status, null), 'unreachable', String(status));
  }
});
