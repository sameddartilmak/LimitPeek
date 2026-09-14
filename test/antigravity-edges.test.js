'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { readAntigravityQuota } = require('../src/core/ratelimits');
const { buildSnapshot } = require('../src/core/snapshot');

/**
 * Adversarial coverage for the Antigravity lane, in the same spirit as
 * `window-expiry.test.js` is for Claude's.
 *
 * `antigravity.test.js` walks the documented payload down its happy paths and
 * the obviously-broken ones. This file attacks the inputs in between: a
 * fraction whose value is falsy but true, a payload where one bucket is
 * unusable and another is not, a capture written by a schema this reader has
 * never seen, and a hook firing several times at once.
 *
 * `agy` is NOT installed on the machine this was written on. Nothing here
 * touches `~/.gemini` or the real `%LOCALAPPDATA%`: the bridge is always run
 * with `LOCALAPPDATA` pointed at a temp directory, and every capture is read
 * from an explicit `file` option.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-08T12:00:00.000Z');
const BRIDGE = path.join(__dirname, '..', 'bridge', 'antigravity-statusline.mjs');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-agy-edge-'));
}

function captureFile(body) {
  const file = path.join(tmpdir(), 'antigravity-quota.json');
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
}

/** A capture in the bridge's own shape, stamped fresh relative to NOW. */
function capture(quota, over = {}) {
  return captureFile({
    schemaVersion: 1,
    capturedAt: new Date(NOW).toISOString(),
    present: true,
    quota,
    payloadKeys: ['quota'],
    ...over,
  });
}

function weekly(over = {}) {
  return {
    remainingFraction: 0.5,
    resetTime: new Date(NOW + 6.5 * DAY).toISOString(),
    resetInSeconds: 6.5 * DAY / 1000,
    ...over,
  };
}

function agRow(quotaResult, now = NOW) {
  const snap = buildSnapshot({
    now, events: [], rateLimits: { state: 'missing' }, scanOk: true, antigravityQuota: quotaResult,
  });
  return snap.providers.find((p) => p.id === 'antigravity');
}

/* ------------------------------------------- fractions at the exact bounds */

test.describe('a fraction at the exact bound is a reading, not an absence', () => {
  test('an untouched quota reaches the row as 0 used, not as unknown', () => {
    // remaining_fraction === 1 converts to usedPercentage === 0, and 0 is
    // falsy. Every guard between here and the renderer has to be a `=== null`
    // check; a truthiness check anywhere on that path deletes this reading and
    // the row silently claims it knows nothing about a quota it knows exactly.
    const q = readAntigravityQuota({ file: capture({ 'gemini-weekly': weekly({ remainingFraction: 1 }) }), now: NOW });
    assert.equal(q.state, 'fresh');
    assert.equal(q.bucketsMapped, 1);
    assert.equal(q.sevenDay.usedPercentage, 0);

    const ag = agRow(q);
    assert.equal(ag.status, 'ok');
    assert.equal(ag.sevenDay.usedPercentage, 0);
    assert.equal(ag.sevenDay.certainty, 'known');
  });

  test('an exhausted quota reaches the row as 100 used', () => {
    const q = readAntigravityQuota({ file: capture({ 'gemini-weekly': weekly({ remainingFraction: 0 }) }), now: NOW });
    assert.equal(q.sevenDay.usedPercentage, 100);
    assert.equal(agRow(q).sevenDay.usedPercentage, 100);
  });

  test('two buckets tied at 0 used still leave a reading behind', () => {
    // The "keep the more consumed one" comparison is a strict `>`. A tie must
    // not fall through both branches and empty the slot.
    const q = readAntigravityQuota({
      file: capture({
        'a-weekly': weekly({ remainingFraction: 1 }),
        'b-weekly': weekly({ remainingFraction: 1 }),
      }),
      now: NOW,
    });
    assert.equal(q.bucketsMapped, 2);
    assert.equal(q.sevenDay.usedPercentage, 0);
  });
});

/* -------------------------------- one bad bucket must not silence a good one */

test.describe('an unusable bucket must not take a usable one down with it', () => {
  test('an unknown bucket id alongside a weekly one leaves the weekly reading intact', () => {
    const q = readAntigravityQuota({
      file: capture({
        'gemini-daily': { remainingFraction: 0.1, resetTime: new Date(NOW + 12 * HOUR).toISOString() },
        'gemini-weekly': weekly({ remainingFraction: 0.25 }),
      }),
      now: NOW,
    });
    assert.equal(q.state, 'fresh');
    assert.equal(q.bucketsSeen, 2);
    assert.equal(q.bucketsMapped, 1, 'the daily bucket is counted but not shown');
    assert.equal(q.sevenDay.usedPercentage, 75);
    assert.equal(q.fiveHour, null, 'the unlabelled bucket did not fall into the other slot');
  });

  test('a weekly bucket with no fraction does not suppress the weekly bucket that has one', () => {
    // Sorted first on purpose, so the unusable one is seen before the usable
    // one: an early `return` instead of a `continue` would lose the reading.
    const q = readAntigravityQuota({
      file: capture({
        'a-weekly': weekly({ remainingFraction: null }),
        'z-weekly': weekly({ remainingFraction: 0.2 }),
      }),
      now: NOW,
    });
    assert.equal(q.bucketsSeen, 2);
    assert.equal(q.bucketsMapped, 1);
    assert.equal(q.sevenDay.usedPercentage, 80);
  });

  test('an out-of-range fraction is discarded without poisoning its neighbour', () => {
    const q = readAntigravityQuota({
      file: capture({
        'a-weekly': weekly({ remainingFraction: 1.4 }),
        'z-weekly': weekly({ remainingFraction: 0.6 }),
      }),
      now: NOW,
    });
    assert.equal(q.bucketsMapped, 1);
    assert.equal(q.sevenDay.usedPercentage, 40, 'the rejected 1.4 did not clamp to a 0% reading and win the slot');
  });
});

/* ----------------------------------------------- captures from another era */

test.describe('a capture this reader did not write', () => {
  test('an unfamiliar schemaVersion is read on its field names alone', () => {
    // Pins the current contract: the reader does not gate on the version
    // stamp. If that ever changes, this test is the one that has to be
    // rewritten deliberately rather than a reading disappearing in the field.
    const q = readAntigravityQuota({
      file: capture({ 'gemini-weekly': weekly({ remainingFraction: 0.5 }) }, { schemaVersion: 99 }),
      now: NOW,
    });
    assert.equal(q.state, 'fresh');
    assert.equal(q.sevenDay.usedPercentage, 50);
  });

  test('a capture that renamed the fraction field degrades to words, never to a number', () => {
    // What a future bridge revision looks like from an older reader's side:
    // the file parses, the bucket is there, and nothing in it is a fraction
    // this reader understands. The answer must be "unavailable", not 0.
    const q = readAntigravityQuota({
      file: capture(
        { 'gemini-weekly': { remaining_fraction: 0.5, reset_time: new Date(NOW + 6.5 * DAY).toISOString() } },
        { schemaVersion: 2 },
      ),
      now: NOW,
    });
    assert.equal(q.state, 'absent');
    assert.equal(q.bucketsSeen, 1);
    assert.equal(q.bucketsMapped, 0);

    const ag = agRow(q);
    // CHANGED, on an explicit ruling, not weakened. This row used to be
    // `status:'error'` with `ANTIGRAVITY_QUOTA_UNAVAILABLE`, which the panel
    // renders as "Güncellenemedi" beside a "Yeniden dene" button. Both were
    // false: nothing failed, and retrying cannot change a shape we do not
    // recognise. A capture we cannot interpret is a STATED ABSENCE — the row
    // is fine, the window says why in words. `error` is now reserved for a
    // capture we could not open or parse at all, where a retry is meaningful.
    assert.equal(ag.status, 'ok');
    assert.equal(ag.errorCode, undefined, 'no error code, and therefore no retry button');
    assert.equal(ag.sevenDay.usedPercentage, null);
    assert.equal(ag.fiveHour.usedPercentage, null);
    // The assertion that replaces the old one: the cause is still machine
    // readable, it just is not dressed as a failure.
    assert.equal(ag.sevenDay.absence, 'unreadable');
  });

  test('a capture truncated mid-write is invalid, not a partial reading', () => {
    const good = fs.readFileSync(capture({ 'gemini-weekly': weekly({ remainingFraction: 0.5 }) }), 'utf8');
    const file = path.join(tmpdir(), 'antigravity-quota.json');
    fs.writeFileSync(file, good.slice(0, Math.floor(good.length / 2)));

    const q = readAntigravityQuota({ file, now: NOW });
    assert.equal(q.state, 'invalid');
    assert.equal(agRow(q).sevenDay.usedPercentage, null);
  });

  test('a capture with no capturedAt stamp cannot be aged, so it is invalid', () => {
    const file = captureFile({ schemaVersion: 1, present: true, quota: { 'gemini-weekly': weekly() } });
    const q = readAntigravityQuota({ file, now: NOW });
    assert.equal(q.state, 'invalid');
    assert.equal(agRow(q).sevenDay.usedPercentage, null);
  });
});

/* ------------------------------------- what the hook copies out of a payload */

test.describe('the bridge bounds what it copies out of a hostile payload', () => {
  /** Runs the real hook as the CLI would, with LOCALAPPDATA redirected. */
  function runBridge(payload) {
    const out = tmpdir();
    const res = spawnSync(process.execPath, [BRIDGE], {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, LOCALAPPDATA: out },
    });
    const file = path.join(out, 'UsageNotch', 'antigravity-quota.json');
    return {
      status: res.status,
      stdout: res.stdout,
      file,
      snapshot: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null,
    };
  }

  test('an absurdly long bucket id is dropped and its neighbour survives', () => {
    const long = `${'w'.repeat(65)}-weekly`;
    const r = runBridge({
      quota: {
        [long]: { remaining_fraction: 0.5 },
        'gemini-weekly': { remaining_fraction: 0.25 },
      },
    });
    assert.equal(r.status, 0);
    assert.deepEqual(Object.keys(r.snapshot.quota), ['gemini-weekly']);
  });

  test('a payload with more buckets than the cap is truncated, not refused', () => {
    const many = {};
    for (let i = 0; i < 17; i += 1) many[`b${String(i).padStart(2, '0')}-weekly`] = { remaining_fraction: i / 100 };
    const r = runBridge({ quota: many });
    assert.equal(r.status, 0);
    const kept = Object.keys(r.snapshot.quota);
    assert.equal(kept.length, 16, 'the cap holds');
    assert.equal(kept.includes('b16-weekly'), false, 'the cap is applied after a deterministic sort');
    assert.equal(r.snapshot.present, true);
  });

  test('a bucket named __proto__ neither crashes the hook nor reaches the capture', () => {
    const r = runBridge({
      quota: {
        __proto__: { remaining_fraction: 0.5 },
        'gemini-weekly': { remaining_fraction: 0.25 },
      },
    });
    assert.equal(r.status, 0);
    assert.deepEqual(Object.keys(r.snapshot.quota), ['gemini-weekly']);
    assert.equal(r.snapshot.quota['gemini-weekly'].remainingFraction, 0.25);
  });

  test('reading a capture that carries a __proto__ bucket pollutes nothing', () => {
    // The bridge will not write one, but the capture file is a plaintext file
    // in the user's profile and anything may put one there.
    const file = path.join(tmpdir(), 'antigravity-quota.json');
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      capturedAt: new Date(NOW).toISOString(),
      present: true,
      quota: { __proto__: { remainingFraction: 0.5, usedPercentage: 99 }, 'gemini-weekly': weekly({ remainingFraction: 0.5 }) },
    }));

    const q = readAntigravityQuota({ file, now: NOW });
    assert.equal(q.sevenDay.usedPercentage, 50);
    assert.equal({}.usedPercentage, undefined, 'Object.prototype was not extended');
    assert.equal({}.remainingFraction, undefined);
  });

  test('two hooks firing at once leave one whole capture, never a spliced one', async () => {
    // The CLI runs this on every agent state change, and two sessions can be
    // open. A non-atomic writer would leave a file that is half one payload
    // and half the other — which the reader would report as `invalid`, and the
    // row would flash an error for a reason the user cannot act on.
    const out = tmpdir();
    const file = path.join(out, 'UsageNotch', 'antigravity-quota.json');
    const fire = (fraction) => new Promise((resolve) => {
      const p = spawn(process.execPath, [BRIDGE], {
        env: { ...process.env, LOCALAPPDATA: out },
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      p.on('exit', (code) => resolve(code));
      p.stdin.end(JSON.stringify({
        quota: { 'gemini-weekly': { remaining_fraction: fraction, reset_time: new Date(NOW + 6.5 * DAY).toISOString() } },
      }));
    });

    const codes = await Promise.all([fire(0.9), fire(0.1), fire(0.5), fire(0.3)]);
    assert.deepEqual(codes, [0, 0, 0, 0]);

    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.present, true);
    assert.ok(
      [0.9, 0.1, 0.5, 0.3].includes(raw.quota['gemini-weekly'].remainingFraction),
      'the surviving capture is exactly one writer\'s, not a blend',
    );
    // And no writer left its temp file behind.
    assert.deepEqual(
      fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp')),
      [],
    );
  });
});

/* ------------------------------ the two live rows are sourced independently */

test.describe('the antigravity row is sourced only from its own capture', () => {
  const claudeStates = [
    { state: 'missing', capturedAtMs: null, fiveHour: null, sevenDay: null },
    { state: 'invalid', capturedAtMs: null, fiveHour: null, sevenDay: null },
    {
      state: 'fresh',
      capturedAt: new Date(NOW).toISOString(),
      capturedAtMs: NOW,
      ageMs: 0,
      fiveHour: { usedPercentage: 99, resetsAtMs: NOW + HOUR },
      sevenDay: { usedPercentage: 97, resetsAtMs: NOW + 3 * DAY },
    },
    {
      state: 'stale',
      capturedAt: new Date(NOW - 3 * HOUR).toISOString(),
      capturedAtMs: NOW - 3 * HOUR,
      ageMs: 3 * HOUR,
      fiveHour: { usedPercentage: 99, resetsAtMs: NOW + HOUR },
      sevenDay: { usedPercentage: 97, resetsAtMs: NOW + 3 * DAY },
    },
  ];

  test('no Claude capture state puts a figure on the antigravity row', () => {
    // `window-expiry.test.js` used to assert this for all five non-Claude rows
    // and now skips antigravity, because a wired row carries window OBJECTS
    // rather than nulls. The shape changed; the independence did not, and the
    // failure it guarded against — the two live rows fed from one capture —
    // is the one a copy-paste in `buildSnapshot` would actually produce.
    for (const rateLimits of claudeStates) {
      const snap = buildSnapshot({ now: NOW, events: [], rateLimits, scanOk: true });
      const ag = snap.providers.find((p) => p.id === 'antigravity');
      const where = `claude=${rateLimits.state}`;
      assert.equal(ag.fiveHour.usedPercentage, null, where);
      assert.equal(ag.sevenDay.usedPercentage, null, where);
      assert.equal(ag.fiveHour.certainty, 'unknown', where);
      assert.equal(ag.sevenDay.certainty, 'unknown', where);
      assert.equal(ag.tokens, null, where);
      assert.equal(ag.burnRatePerHour, null, where);
      assert.equal(ag.weeklyCost, null, where);
      assert.equal(ag.planLabel, null, where);
      assert.equal(ag.connected, false, where);
      assert.equal(ag.status, 'passive', where);
      assert.equal(ag.lastGoodAt, null, where);
    }
  });

  test('an antigravity capture puts no figure on the Claude row', () => {
    const q = readAntigravityQuota({ file: capture({ 'gemini-weekly': weekly({ remainingFraction: 0.02 }) }), now: NOW });
    const snap = buildSnapshot({
      now: NOW, events: [], rateLimits: { state: 'missing' }, scanOk: true, antigravityQuota: q,
    });
    const claude = snap.providers.find((p) => p.id === 'claude');
    assert.equal(claude.sevenDay.usedPercentage, null);
    assert.equal(claude.fiveHour.usedPercentage, null);
    assert.equal(claude.status, 'passive');
    assert.equal(snap.providers.find((p) => p.id === 'antigravity').sevenDay.usedPercentage, 98);
  });

  test('the passive rows are unaffected by an antigravity reading', () => {
    const q = readAntigravityQuota({ file: capture({ 'gemini-weekly': weekly({ remainingFraction: 0.02 }) }), now: NOW });
    const snap = buildSnapshot({
      now: NOW, events: [], rateLimits: { state: 'missing' }, scanOk: true, antigravityQuota: q,
    });
    // Codex joins claude/antigravity on the wired side (its rollout rate
    // limits), so it too shows an unknown window rather than a null one and is
    // excluded here; a Codex-only input drives it in the codex reader tests.
    for (const p of snap.providers.filter((x) => !['claude', 'antigravity', 'codex'].includes(x.id))) {
      assert.equal(p.fiveHour, null, p.id);
      assert.equal(p.sevenDay, null, p.id);
      assert.equal(p.status, 'passive', p.id);
    }
  });
});
