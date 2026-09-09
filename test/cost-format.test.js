'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatModule } = require('./helpers/load-format');

/**
 * The money and share formatters of `src/renderer/src/format.ts` (ADR-002).
 *
 * `format.test.js` pins the duration and percentage boundaries; nothing pinned
 * the four functions the cost block is built out of. They matter for one
 * reason: this project's recurring defect is a value that cannot be defended
 * rendered as though it could, and every instance so far has been a rounding
 * step that turned a real quantity into a round number — a stale percentage
 * shown as live, no-data drawn as 0%, and a sub-cent amount printed "$0,00".
 * `usd()` grew a guard for the third one; `usdWithUnit()` and `share()` have
 * since grown the matching ones, and the tests that recorded those two defects
 * now pin the fixes.
 *
 * The TypeScript SOURCE is loaded, not `dist/`, on the same reasoning as
 * format.test.js: a stale build must not make these pass.
 */
let f;
const mod = formatModule();
test.before(async () => { f = await mod.load(); });
test.after(() => mod.cleanup());

/* --------------------------------------------------------------- usd() */

test.describe('a notional dollar figure', () => {
  test('a real amount under a cent is an upper bound, never "$0,00"', () => {
    // ADR-002 rule 2 in miniature: a priced amount printed as nothing reads as
    // free. Everything strictly inside (0, half a cent) must say so.
    for (const value of [1e-6, 0.0001, 0.004, 0.0049]) {
      assert.equal(f.usd(value), '<$0,01', `usd(${value})`);
    }
  });

  test('half a cent is the first amount that can be printed as a figure', () => {
    assert.equal(f.usd(0.005), '$0,01');
    assert.equal(f.usd(0.0049), '<$0,01');
  });

  test('an exact zero is a figure, because a priced zero is a real reading', () => {
    // Distinct from the case above on purpose: nothing was rounded away here.
    assert.equal(f.usd(0), '$0,00');
  });

  test('a non-finite amount is a dash, never a number', () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      assert.equal(f.usd(value), '—', String(value));
    }
    assert.equal(f.usdWithUnit(NaN), '—');
  });

  test('Turkish separators: dot groups thousands, comma marks the decimal', () => {
    assert.equal(f.usd(1234.5), '$1.234,50');
    assert.equal(f.usd(210.34), '$210,34');
  });

  test('the named form spells the currency out, so "$" cannot be misread', () => {
    const named = f.usdWithUnit(210.34);
    assert.match(named, /ABD doları$/, named);
    assert.ok(named.includes('210,34'), named);
  });

  test('every amount is rendered to exactly two decimals', () => {
    assert.equal(f.usd(5), '$5,00');
    assert.equal(f.usd(5.006), '$5,01');
  });
});

/* ------------------------------------------------------------- share() */

test.describe('a share of a whole', () => {
  test('the percent sign precedes the number, as everywhere else in the panel', () => {
    assert.equal(f.share(0.62), '%62');
    assert.equal(f.share(0.5), '%50');
  });

  test('a fraction outside the unit interval is pinned, never wrapped', () => {
    assert.equal(f.share(1.5), '%100');
    assert.equal(f.share(-1), '%0');
  });

  test('a non-finite fraction renders nothing at all rather than a number', () => {
    assert.equal(f.share(NaN), '');
    assert.equal(f.share(Infinity), '');
  });

  test('a real, non-zero share below half a percent is a bound, never "%0"', () => {
    // Was a DEFECT test; fixed in the same round it was raised.
    // Reachable on the reference week of ADR-002 itself: input is $0.02 of
    // $210.34, a 0.0095% share, and the expanded table read
    // "Girdi  $0,02  %0" — a priced amount beside a zero share.
    // Also reachable in the fallback caveat, which read
    // "7 / 1.724 önbellek yazma kaydında (%0)" for 7 events out of 1,724.
    // Same convention as usd()'s "<$0,01": one spelling for one idea.
    assert.equal(f.share(0.02 / 210.34), '<%1');
    assert.equal(f.share(7 / 1724), '<%1');
    assert.equal(f.share(1e-9), '<%1');
    assert.notEqual(f.share(1e-9), f.share(0), 'a zero share and a tiny share must differ');
  });

  test('a share strictly below the whole is a bound, never "%100"', () => {
    // The mirror of the case above, and the same class as the tray's rounded
    // sweep: 99.6% and 100% must not be indistinguishable once printed.
    assert.equal(f.share(0.996), '>%99');
    assert.equal(f.share(0.995), '>%99');
    assert.notEqual(f.share(0.996), f.share(1), 'nearly all and all must differ');
  });

  test('the exact endpoints stay exact: nothing is 0, everything is 100', () => {
    // The bounds exist for values that ROUND to an endpoint, not for values
    // that ARE one. A genuinely empty class is "%0", not "<%1".
    assert.equal(f.share(0), '%0');
    assert.equal(f.share(-1), '%0');
    assert.equal(f.share(1), '%100');
    assert.equal(f.share(2), '%100');
  });
});

/* ------------------------------------------- price date and window range */

test.describe('the provenance strings', () => {
  test('a price-list date renders the day that was written down, not the day before', () => {
    // "2026-06-24" is a calendar date, not an instant. Parsed as UTC midnight
    // and formatted west of Greenwich it would render 23 June.
    assert.equal(f.priceDate('2026-06-24'), '24 Haziran 2026');
  });

  test('an unparseable price date is echoed verbatim, never "Invalid Date"', () => {
    assert.equal(f.priceDate('nope'), 'nope');
  });

  test('the not-reported sentinel yields an empty string, so the caller can branch', () => {
    // sanitize.ts stores '' when main did not report a date. The cost block
    // branches on falsiness and prints "Fiyat listesinin tarihi bildirilmedi";
    // this asserts the sentinel never becomes a rendered date.
    assert.equal(f.priceDate(''), '');
  });

  test('a window range is joined with an en dash, because it is a range', () => {
    const range = f.dayRange('2026-09-03T12:00:00Z', '2026-09-10T12:00:00Z');
    assert.ok(range.includes(' – '), range);
    assert.ok(!range.includes(' - '), range);
  });

  test('an empty or unparseable window degrades to no range, never to "Invalid Date"', () => {
    assert.equal(f.dayRange('', ''), '');
    assert.equal(f.dayRange('nope', '2026-09-10T12:00:00Z'), '');
  });
});
