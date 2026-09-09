'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { sanitizeOrder, mergeOrder, applyOrder } = require('../src/core/order');
const { PROVIDER_IDS } = require('../src/core/providers');
const { buildSnapshot, loadingSnapshot } = require('../src/core/snapshot');
const settingsStore = require('../src/main/settings');

/**
 * The stored provider order is untrusted input that outlives the app version
 * that wrote it. The one thing it must never do is cost the user a row.
 */

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-order-'));
}

const ids = (list) => list.map((p) => p.id).join(',');

test.describe('sanitizeOrder', () => {
  test('keeps only real provider ids, in the given order', () => {
    assert.deepEqual(sanitizeOrder(['kimi', 'claude']), ['kimi', 'claude']);
  });

  test('ignores ids that are not providers', () => {
    assert.deepEqual(sanitizeOrder(['kimi', 'openai', '__proto__', 'claude']), ['kimi', 'claude']);
  });

  test('ignores non-strings without throwing', () => {
    assert.deepEqual(sanitizeOrder(['kimi', 42, null, undefined, {}, ['claude']]), ['kimi']);
  });

  test('honours a duplicate once, at its first position', () => {
    assert.deepEqual(sanitizeOrder(['kimi', 'claude', 'kimi']), ['kimi', 'claude']);
  });

  test('a non-array is an empty order, never a throw', () => {
    for (const bad of [null, undefined, 'claude', 7, {}, { 0: 'claude' }]) {
      assert.deepEqual(sanitizeOrder(bad), []);
    }
  });
});

test.describe('mergeOrder', () => {
  test('an empty order is registry order', () => {
    assert.deepEqual(mergeOrder([]), PROVIDER_IDS);
  });

  test('providers the order omits are kept, in registry order, after the named ones', () => {
    const merged = mergeOrder(['kimi', 'gemini']);
    assert.deepEqual(merged.slice(0, 2), ['kimi', 'gemini']);
    assert.deepEqual(merged.slice(2), PROVIDER_IDS.filter((id) => id !== 'kimi' && id !== 'gemini'));
  });

  test('every provider appears exactly once, whatever the input', () => {
    const inputs = [[], ['kimi'], ['nope'], ['claude', 'claude'], 'garbage', null,
      [...PROVIDER_IDS].reverse()];
    for (const input of inputs) {
      const merged = mergeOrder(input);
      assert.deepEqual([...merged].sort(), [...PROVIDER_IDS].sort(), `input: ${JSON.stringify(input)}`);
    }
  });
});

test.describe('applyOrder', () => {
  const rows = () => PROVIDER_IDS.map((id) => ({ id, tag: id }));

  test('reorders without dropping or duplicating a row', () => {
    const out = applyOrder(rows(), ['kimi', 'gemini']);
    const rest = PROVIDER_IDS.filter((i) => i !== 'kimi' && i !== 'gemini');
    assert.equal(out.length, PROVIDER_IDS.length);
    assert.equal(ids(out), ['kimi', 'gemini', ...rest].join(','));
  });

  test('an order naming only unknown ids leaves the array untouched', () => {
    assert.equal(ids(applyOrder(rows(), ['openai', 'llama'])), PROVIDER_IDS.join(','));
  });

  test('a row whose id is missing keeps its place at the end rather than vanishing', () => {
    const withBroken = [...rows(), { id: null }];
    const out = applyOrder(withBroken, ['kimi']);
    assert.equal(out.length, PROVIDER_IDS.length + 1);
    assert.equal(out[out.length - 1].id, null);
  });

  test('the same array back for a non-array order', () => {
    assert.equal(ids(applyOrder(rows(), undefined)), PROVIDER_IDS.join(','));
    assert.deepEqual(applyOrder(null, ['kimi']), []);
  });

  test('it is a permutation, never a rebuild: identities are preserved', () => {
    const input = rows();
    const out = applyOrder(input, ['kimi', 'claude']);
    for (const row of input) assert.ok(out.includes(row), `${row.id} lost its object identity`);
  });
});

test.describe('the order reaches the snapshot', () => {
  test('buildSnapshot emits providers in user order', () => {
    const snap = buildSnapshot({ now: Date.now(), events: [], rateLimits: null, order: ['kimi', 'gemini'] });
    assert.equal(snap.providers[0].id, 'kimi');
    assert.equal(snap.providers[1].id, 'gemini');
    assert.equal(snap.providers.length, PROVIDER_IDS.length);
  });

  test('a stale order file never drops a provider from the panel', () => {
    // A provider renamed away, one that never existed, and a duplicate.
    const snap = buildSnapshot({
      now: Date.now(),
      events: [],
      rateLimits: null,
      order: ['claude-code', 'kimi', 'kimi', 'openai'],
    });
    assert.deepEqual([...snap.providers.map((p) => p.id)].sort(), [...PROVIDER_IDS].sort());
    assert.equal(snap.providers[0].id, 'kimi');
  });

  test('the loading skeleton is ordered too, so rows do not jump on first data', () => {
    const skeleton = loadingSnapshot(Date.now(), ['kimi']);
    const real = buildSnapshot({ now: Date.now(), events: [], rateLimits: null, order: ['kimi'] });
    assert.equal(ids(skeleton.providers), ids(real.providers));
  });

  test('no order at all is registry order', () => {
    const snap = buildSnapshot({ now: Date.now(), events: [], rateLimits: null });
    assert.equal(ids(snap.providers), PROVIDER_IDS.join(','));
  });
});

test.describe('order persistence in settings', () => {
  test('round-trips through the settings file', () => {
    const dir = tmpdir();
    const saved = { autostart: false, planLabel: null, providerOrder: ['kimi', 'claude'] };
    assert.equal(settingsStore.save(dir, saved), true);
    assert.deepEqual(settingsStore.load(dir).providerOrder, ['kimi', 'claude']);
  });

  test('a corrupt settings file yields the default order, not a throw', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"providerOrder": ["kimi",', 'utf8');
    assert.deepEqual(settingsStore.load(dir).providerOrder, []);
  });

  test('a hand-edited order is validated on read', () => {
    const dir = tmpdir();
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ providerOrder: ['kimi', 'not-a-provider', 5, 'kimi'] }),
      'utf8',
    );
    assert.deepEqual(settingsStore.load(dir).providerOrder, ['kimi']);
  });

  test('providerOrder of the wrong type degrades to empty', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ providerOrder: 'kimi' }), 'utf8');
    assert.deepEqual(settingsStore.load(dir).providerOrder, []);
  });

  test('a missing file is the default order', () => {
    assert.deepEqual(settingsStore.load(path.join(tmpdir(), 'no-such-dir')).providerOrder, []);
  });

  test('the defaults are not shared mutable state between two loads', () => {
    const a = settingsStore.load(path.join(tmpdir(), 'gone'));
    a.providerOrder.push('kimi');
    assert.deepEqual(settingsStore.load(path.join(tmpdir(), 'gone-too')).providerOrder, []);
  });
});
