'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { applyOrder, mergeOrder, sanitizeOrder } = require('../src/core/order');
const { PROVIDER_IDS } = require('../src/core/providers');

/**
 * `src/core/order.js` claims applyOrder "provably cannot drop or duplicate a
 * row". `order.test.js` checks that claim against hand-picked inputs; this
 * file checks it against inputs nobody picked.
 *
 * The claim matters because the stored order is a file on disk that survives
 * upgrades: it will eventually name a provider that no longer exists, omit one
 * added after it was written, or be a hand-edited fragment. Losing a row to any
 * of those would remove a provider from the panel with nothing on screen
 * saying why.
 *
 * The generator is seeded, so a failure reproduces from the printed seed
 * rather than "it went red once on CI".
 */

/** mulberry32 — 4 lines, no dependency, and the same sequence every run. */
function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Real ids, ids that were real once, and shapes that are not ids at all. */
const POOL = [...PROVIDER_IDS, 'ghost', 'claude ', '', 'CLAUDE', '__proto__', 'constructor'];

function generate(next) {
  const rows = [];
  const rowCount = 1 + Math.floor(next() * 8);
  for (let i = 0; i < rowCount; i++) {
    const roll = next();
    const id =
      roll < 0.08 ? undefined
        : roll < 0.14 ? null
          : roll < 0.18 ? 7
            : POOL[Math.floor(next() * POOL.length)];
    // `tag` is unique per row, so the multiset check cannot be satisfied by a
    // different row that merely looks the same.
    rows.push({ id, tag: i });
  }
  const stored = [];
  const storedCount = Math.floor(next() * 7);
  for (let i = 0; i < storedCount; i++) stored.push(POOL[Math.floor(next() * POOL.length)]);
  return { rows, stored: next() < 0.1 ? null : stored };
}

test.describe('applyOrder is a permutation under arbitrary input', () => {
  const ITERATIONS = 20_000;

  test('the row count is never changed', () => {
    const next = rng(0x5eed);
    for (let i = 0; i < ITERATIONS; i++) {
      const { rows, stored } = generate(next);
      const out = applyOrder(rows, stored);
      assert.equal(
        out.length,
        rows.length,
        `seed 0x5eed iteration ${i}: rows=${JSON.stringify(rows)} order=${JSON.stringify(stored)}`,
      );
    }
  });

  test('the multiset of rows is never changed, only its order', () => {
    const next = rng(0xc0ffee);
    for (let i = 0; i < ITERATIONS; i++) {
      const { rows, stored } = generate(next);
      const out = applyOrder(rows, stored);
      const before = rows.map((r) => r.tag).sort((a, b) => a - b).join(',');
      const after = out.map((r) => r.tag).sort((a, b) => a - b).join(',');
      assert.equal(
        after,
        before,
        `seed 0xc0ffee iteration ${i}: order=${JSON.stringify(stored)}`,
      );
    }
  });

  test('object identity is preserved, so nothing is rebuilt from an id', () => {
    const next = rng(0xbeef);
    for (let i = 0; i < 5_000; i++) {
      const { rows, stored } = generate(next);
      const out = applyOrder(rows, stored);
      for (const row of rows) {
        assert.ok(out.includes(row), `seed 0xbeef iteration ${i}: a row was replaced, not moved`);
      }
    }
  });
});

test.describe('the stored order cannot inject an id the registry does not have', () => {
  test('a prototype key is not a provider', () => {
    // `mergeOrder` builds a Map from the sanitized list, and `sanitizeOrder`
    // filters against the registry array, so neither can be reached through
    // Object.prototype.
    assert.deepEqual(sanitizeOrder(['__proto__', 'constructor', 'toString']), []);
    assert.deepEqual(mergeOrder(['__proto__']), [...PROVIDER_IDS]);
  });

  test('an id that differs only by case or whitespace is not the provider', () => {
    assert.deepEqual(sanitizeOrder(['CLAUDE', ' claude', 'claude ']), []);
  });

  test('a duplicated id in the stored order is honoured once, at its first position', () => {
    const out = applyOrder(PROVIDER_IDS.map((id) => ({ id })), ['kimi', 'claude', 'kimi']);
    assert.deepEqual(out.map((p) => p.id), ['kimi', 'claude', 'codex', 'gemini', 'antigravity']);
  });

  test('a provider that disappeared between sessions costs no other row its place', () => {
    // The order was written when 'ghost' existed. Every surviving provider is
    // still present, and the ones the order named keep their relative order.
    const out = applyOrder(PROVIDER_IDS.map((id) => ({ id })), ['ghost', 'kimi', 'ghost', 'claude']);
    assert.deepEqual(out.map((p) => p.id).slice(0, 2), ['kimi', 'claude']);
    assert.deepEqual([...out.map((p) => p.id)].sort(), [...PROVIDER_IDS].sort());
  });

  test('a provider added after the order was written lands last, never nowhere', () => {
    // Rule 3 of the module: this is the worst a stale order file can do.
    const withNew = [...PROVIDER_IDS, 'claude'].map((id) => ({ id }));
    const out = applyOrder(PROVIDER_IDS.map((id) => ({ id })), ['kimi']);
    assert.equal(out.length, PROVIDER_IDS.length);
    assert.equal(out[0].id, 'kimi');
    assert.ok(out.some((p) => p.id === 'antigravity'));
    // And a snapshot carrying the same id twice keeps both rows.
    assert.equal(applyOrder(withNew, ['kimi']).length, withNew.length);
  });
});
