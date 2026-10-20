'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  readAntigravityQuota,
  usedFromRemaining,
  MAX_AGE_MS,
} = require('../src/core/ratelimits');
const {
  installAntigravityStatusLine,
  antigravityStatusLineState,
} = require('../src/core/setup/antigravity-bridge');
const { antigravityDefaultHome, antigravityHomeOverridden } = require('../src/core/paths');
const messages = require('../src/core/setup/messages');
const { NOTICE_MAX } = messages;
const { Collector } = require('../src/core/collector');
const log = require('../src/core/log');
const { buildSnapshot } = require('../src/core/snapshot');

/**
 * Antigravity is wired through the `agy` CLI's documented statusline hook
 * (https://antigravity.google/docs/cli/statusline/): the CLI runs a command on
 * every agent state change and pipes it a state JSON payload whose `quota`
 * object maps bucket ids to `{ remaining_fraction, reset_time,
 * reset_in_seconds }`.
 *
 * Two facts about that shape drive everything below.
 *
 *   1. `remaining_fraction` is REMAINING and this app displays USED. The
 *      conversion is a single line in `ratelimits.js`, and it is the one place
 *      a sign error could put "%6 used" on screen for a nearly-exhausted quota
 *      or the reverse. It is tested directly rather than through the snapshot.
 *
 *   2. It is the ONLY defensible denominator available. ADR-001 Decision 1
 *      forbids deriving a percentage any other way, so every path where the
 *      fraction is missing, out of range, or unparseable must end in "unknown"
 *      — never in a number computed from something else.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-08T12:00:00.000Z');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-agy-'));
}

/** Writes a capture in exactly the shape `antigravity-statusline.mjs` emits. */
function captureFile(body) {
  const file = path.join(tmpdir(), 'antigravity-quota.json');
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
}

/** The doc's own example bucket, verbatim, translated to the bridge's field
 *  names: 93.78% remaining, resetting 6.5 days out. */
function weeklyBucket(capturedAtMs, over = {}) {
  return {
    remainingFraction: 0.9378,
    resetTime: new Date(capturedAtMs + 6.5 * DAY).toISOString(),
    resetInSeconds: 6.5 * DAY / 1000,
    ...over,
  };
}

function freshCapture(over = {}) {
  return captureFile({
    schemaVersion: 1,
    capturedAt: new Date(NOW).toISOString(),
    present: true,
    quota: { 'gemini-weekly': weeklyBucket(NOW) },
    payloadKeys: ['quota'],
    ...over,
  });
}

/* ------------------------------------------------ remaining -> used */

test.describe('remaining_fraction is REMAINING; the app shows USED', () => {
  test('the conversion is 1 - fraction, at the one site that performs it', () => {
    // Directions first, because a sign error here is invisible in a snapshot
    // test that only checks "some number arrived".
    assert.equal(usedFromRemaining(1), 0, 'nothing spent');
    assert.equal(usedFromRemaining(0), 100, 'everything spent');
    assert.equal(usedFromRemaining(0.25), 75);
    // The doc's own example. 6.22, not 93.78 — and not 6.219999999999999,
    // which is what the bare subtraction produces.
    assert.equal(usedFromRemaining(0.9378), 6.22);
  });

  test('a fraction outside 0..1 is rejected, not clamped', () => {
    // 1.4 remaining is proof the producer is wrong. Clamping it to 1 would
    // turn that proof into a confident "%0 used".
    for (const bad of [-0.1, 1.4, NaN, Infinity, '0.5', null, undefined, {}]) {
      assert.equal(usedFromRemaining(bad), null, String(bad));
    }
  });

  test('the reader carries the converted figure into the sevenDay slot', () => {
    const q = readAntigravityQuota({ file: freshCapture(), now: NOW });
    assert.equal(q.state, 'fresh');
    assert.equal(q.sevenDay.usedPercentage, 6.22);
    assert.equal(q.fiveHour, null, 'nothing in the payload described a five-hour window');
    assert.equal(q.bucketsMapped, 1);
  });

  test('a `5h` bucket takes the five-hour slot, with its live forward reset', () => {
    // Observed from a live agy session: it emits `gemini-5h`/`3p-5h` beside the
    // weekly buckets, each carrying a forward `reset_time` the IDE store never
    // persists. `5h` in a name is a real label now, so it maps.
    const q = readAntigravityQuota({
      file: freshCapture({ quota: {
        'gemini-5h': { remainingFraction: 0.9, resetTime: new Date(NOW + 3 * HOUR).toISOString(), resetInSeconds: 3 * HOUR / 1000 },
        'gemini-weekly': weeklyBucket(NOW),
      } }),
      now: NOW,
    });
    assert.equal(q.fiveHour.usedPercentage, 10, 'the 5h bucket maps to the five-hour slot');
    assert.equal(q.fiveHour.resetsAtMs, NOW + 3 * HOUR, 'carrying the CLI\'s live forward reset');
    assert.equal(q.sevenDay.usedPercentage, 6.22, 'and the weekly still maps');
    assert.equal(q.bucketsMapped, 2);
  });

  test('two five-hour buckets: the MORE consumed one binds, as with the weekly slot', () => {
    const q = readAntigravityQuota({
      file: freshCapture({ quota: {
        '3p-5h': { remainingFraction: 1, resetTime: new Date(NOW + 3 * HOUR).toISOString(), resetInSeconds: 3 * HOUR / 1000 },
        'gemini-5h': { remainingFraction: 0.8, resetTime: new Date(NOW + 3 * HOUR).toISOString(), resetInSeconds: 3 * HOUR / 1000 },
      } }),
      now: NOW,
    });
    assert.equal(q.fiveHour.usedPercentage, 20, 'gemini-5h (20% used) is the binding constraint over 3p-5h (0%)');
  });

  test('the snapshot never restates the fraction anywhere', () => {
    // The failure this guards against is a second conversion site: a row that
    // says 6 in one place and 94 in another. `usedPercentage` is the only
    // percentage the row carries, and nothing recomputes it.
    const q = readAntigravityQuota({ file: freshCapture(), now: NOW });
    const snap = buildSnapshot({ now: NOW, events: [], rateLimits: { state: 'missing' }, scanOk: true, antigravityQuota: q });
    const ag = snap.providers.find((p) => p.id === 'antigravity');
    assert.equal(ag.status, 'ok');
    assert.equal(ag.connected, true);
    assert.equal(ag.sevenDay.usedPercentage, 6.22);
    assert.equal(ag.sevenDay.certainty, 'known');
    assert.equal(JSON.stringify(ag).includes('0.9378'), false, 'the raw fraction must not leak into the row');
  });
});

/* --------------------------------------------- missing / garbage quota */

test.describe('no defensible denominator means no number', () => {
  test('a capture file that was never written is `missing`, and the row offers setup', () => {
    const q = readAntigravityQuota({ file: path.join(tmpdir(), 'nope.json'), now: NOW });
    assert.equal(q.state, 'missing');
    const snap = buildSnapshot({ now: NOW, events: [], rateLimits: { state: 'missing' }, scanOk: true, antigravityQuota: q });
    const ag = snap.providers.find((p) => p.id === 'antigravity');
    assert.equal(ag.status, 'passive');
    assert.equal(ag.setupAction.kind, 'install-bridge');
    assert.equal(ag.sevenDay.usedPercentage, null);
  });

  test('a payload with no `quota` key at all is `absent`, not zero', () => {
    // The doc marks `quota` optional. A hook that fired before the first API
    // call has nothing to say, and "nothing to say" is not "0% used".
    const file = captureFile({ capturedAt: new Date(NOW).toISOString(), present: false, quota: {} });
    const q = readAntigravityQuota({ file, now: NOW });
    assert.equal(q.state, 'absent');
    assert.equal(q.sevenDay, null);
    assert.equal(q.fiveHour, null);
  });

  test('garbage in the quota object yields `absent`, never a computed figure', () => {
    const garbage = [
      { 'gemini-weekly': null },
      { 'gemini-weekly': 'yes' },
      { 'gemini-weekly': [] },
      { 'gemini-weekly': {} },
      { 'gemini-weekly': { remainingFraction: 'lots', resetTime: new Date(NOW + DAY * 2).toISOString() } },
      { 'gemini-weekly': { remainingFraction: 42, resetTime: new Date(NOW + DAY * 2).toISOString() } },
      { 'gemini-weekly': { resetTime: new Date(NOW + DAY * 2).toISOString(), resetInSeconds: DAY * 2 / 1000 } },
    ];
    for (const quota of garbage) {
      const file = captureFile({ capturedAt: new Date(NOW).toISOString(), present: true, quota });
      const q = readAntigravityQuota({ file, now: NOW });
      assert.equal(q.state, 'absent', JSON.stringify(quota));
      assert.equal(q.fiveHour, null, JSON.stringify(quota));
      assert.equal(q.sevenDay, null, JSON.stringify(quota));
    }
  });

  test('a good fraction with an unusable reset instant is still a reading', () => {
    // Not garbage: the percentage is the server's and it is in range. What is
    // missing is only the instant, and `snapshot.windowFrom` already knows
    // that such a reading may be shown while fresh and must not outlive its
    // freshness budget. Identical to Claude's `windowOf` on the same input.
    const file = captureFile({
      capturedAt: new Date(NOW).toISOString(),
      present: true,
      quota: { 'gemini-weekly': { remainingFraction: 0.5, resetTime: 'not a date', resetInSeconds: null } },
    });
    const q = readAntigravityQuota({ file, now: NOW });
    assert.equal(q.state, 'fresh');
    assert.equal(q.sevenDay.usedPercentage, 50);
    assert.equal(q.sevenDay.resetsAtMs, null);

    const stale = readAntigravityQuota({ file, now: NOW + MAX_AGE_MS + HOUR });
    const snap = buildSnapshot({
      now: NOW + MAX_AGE_MS + HOUR, events: [], rateLimits: { state: 'missing' }, scanOk: true, antigravityQuota: stale,
    });
    const ag = snap.providers.find((p) => p.id === 'antigravity');
    assert.equal(ag.sevenDay.usedPercentage, null, 'gone once stale, because nothing says the window is still open');
  });

  test('an unparseable capture file is `invalid` and the row says so', () => {
    const file = path.join(tmpdir(), 'antigravity-quota.json');
    fs.writeFileSync(file, '{ "quota": oops');
    const q = readAntigravityQuota({ file, now: NOW });
    assert.equal(q.state, 'invalid');

    const snap = buildSnapshot({ now: NOW, events: [], rateLimits: { state: 'missing' }, scanOk: true, antigravityQuota: q });
    const ag = snap.providers.find((p) => p.id === 'antigravity');
    assert.equal(ag.status, 'error');
    assert.equal(ag.errorCode, 'ANTIGRAVITY_CAPTURE_INVALID');
    assert.equal(ag.sevenDay.usedPercentage, null, 'an error row still shows no invented number');
  });

  test('a bucket whose name the two window labels cannot describe is dropped', () => {
    // The contract has two slots, which the renderer labels "5 saatlik
    // pencere" and the weekly one. A bucket the CLI calls `gemini-daily` is a
    // real reading, but calling it either of those is a false statement — so
    // it is counted and dropped rather than shown under the wrong name.
    const file = captureFile({
      capturedAt: new Date(NOW).toISOString(),
      present: true,
      quota: { 'gemini-daily': { remainingFraction: 0.5, resetTime: new Date(NOW + 12 * HOUR).toISOString() } },
    });
    const q = readAntigravityQuota({ file, now: NOW });
    assert.equal(q.state, 'absent');
    assert.equal(q.bucketsSeen, 1);
    assert.equal(q.bucketsMapped, 0);
  });

  test('the slot is chosen by the bucket NAME, never by how soon it resets', () => {
    // The regression this pins. Reset horizon is time-until-reset, not window
    // length: a weekly bucket read thirty minutes before it rolls over has a
    // thirty-minute horizon. An earlier version classified on that number and
    // would have filed this reading under "5 saatlik pencere".
    const file = captureFile({
      capturedAt: new Date(NOW).toISOString(),
      present: true,
      quota: { 'gemini-weekly': { remainingFraction: 0.03, resetTime: new Date(NOW + 30 * 60 * 1000).toISOString() } },
    });
    const q = readAntigravityQuota({ file, now: NOW });
    assert.equal(q.fiveHour, null, 'a weekly bucket is never a five-hour one');
    assert.equal(q.sevenDay.usedPercentage, 97);
    assert.equal(q.sevenDay.resetsAtMs, NOW + 30 * 60 * 1000);
  });

  test('two buckets in one slot: the more consumed one wins', () => {
    // Both are weekly. The user is bound by whichever runs out first, and
    // showing the roomier one would err optimistic — the single direction
    // ADR-001 exists to prevent.
    const file = captureFile({
      capturedAt: new Date(NOW).toISOString(),
      present: true,
      quota: {
        'gemini-weekly': weeklyBucket(NOW, { remainingFraction: 0.9 }),   // 10% used
        'other-weekly': weeklyBucket(NOW, { remainingFraction: 0.2 }),    // 80% used
      },
    });
    const q = readAntigravityQuota({ file, now: NOW });
    assert.equal(q.bucketsMapped, 2);
    assert.equal(q.sevenDay.usedPercentage, 80);
  });
});

/* ------------------------------------------------ the window has rolled over */

test.describe('a capture can outlive the window it describes', () => {
  test('a reset_time already in the past is never presented as current', () => {
    // Deliberately a FRESH capture: the file is seconds old and its number was
    // true when written. It is still not true NOW, because the window it
    // describes has reset. Rollover dominates freshness — the same rule
    // `snapshot.js` applies to Claude, reached through the same code path.
    const captured = NOW - 60 * 1000;
    const file = captureFile({
      capturedAt: new Date(captured).toISOString(),
      present: true,
      quota: {
        'gemini-weekly': {
          remainingFraction: 0.02,                                  // 98% used
          resetTime: new Date(NOW - 30 * 1000).toISOString(),       // reset 30s ago
          resetInSeconds: 30,
        },
      },
    });


    const q = readAntigravityQuota({ file, now: NOW });
    assert.equal(q.state, 'fresh', 'the FILE is fresh');
    assert.equal(q.sevenDay.usedPercentage, 98, 'and the reader still carries the reading');

    const snap = buildSnapshot({ now: NOW, events: [], rateLimits: { state: 'missing' }, scanOk: true, antigravityQuota: q });
    const ag = snap.providers.find((p) => p.id === 'antigravity');
    assert.equal(ag.sevenDay.usedPercentage, null, 'but the row refuses to show it');
    assert.equal(ag.sevenDay.certainty, 'unknown');
    assert.equal(ag.status, 'stale', 'and the chrome matches the content, rather than reading as healthy');
  });

  test('a stale capture whose window is still open survives, labelled with its age', () => {
    // The other half of ADR-001 amendment 2: staleness alone does not delete a
    // true statement about a window that has not reset.
    const captured = NOW - (MAX_AGE_MS + HOUR);
    const file = captureFile({
      capturedAt: new Date(captured).toISOString(),
      present: true,
      quota: { 'gemini-weekly': weeklyBucket(captured, { remainingFraction: 0.4 }) },
    });
    const q = readAntigravityQuota({ file, now: NOW });
    assert.equal(q.state, 'stale');

    const snap = buildSnapshot({ now: NOW, events: [], rateLimits: { state: 'missing' }, scanOk: true, antigravityQuota: q });
    const ag = snap.providers.find((p) => p.id === 'antigravity');
    assert.equal(ag.sevenDay.usedPercentage, 60);
    assert.equal(ag.status, 'stale');
    assert.equal(ag.sevenDay.capturedAt, new Date(captured).toISOString());
    // Claude answers a stale figure with billable tokens observed since. There
    // are no Antigravity transcripts on this machine, so there is no measured
    // floor to offer — and borrowing Claude's would describe the wrong tool.
    assert.equal(ag.sevenDay.billableSinceCapture, null);
  });

  test('an implausible reset instant is discarded, and takes the figure with it once stale', () => {
    // A weekly window claiming to reset a month out. Keeping it would mean
    // `now >= resetsAt` never becomes true and the figure never expires, so
    // the instant is dropped — exactly what Claude's `resetInstant` does.
    const body = (capturedAtMs) => ({
      capturedAt: new Date(capturedAtMs).toISOString(),
      present: true,
      quota: { 'gemini-weekly': { remainingFraction: 0.1, resetTime: new Date(NOW + 30 * DAY).toISOString() } },
    });

    // Fresh: the reading itself is still true, and survives without an instant.
    const fresh = readAntigravityQuota({ file: captureFile(body(NOW)), now: NOW });
    assert.equal(fresh.state, 'fresh');
    assert.equal(fresh.sevenDay.usedPercentage, 90);
    assert.equal(fresh.sevenDay.resetsAtMs, null, 'the bogus instant did not survive');

    // Stale: with no instant there is no way to tell whether the window it
    // describes is still open, so it is unusable rather than optimistic.
    const staleAt = NOW + MAX_AGE_MS + HOUR;
    const stale = readAntigravityQuota({ file: captureFile(body(NOW)), now: staleAt });
    assert.equal(stale.state, 'stale');
    const snap = buildSnapshot({ now: staleAt, events: [], rateLimits: { state: 'missing' }, scanOk: true, antigravityQuota: stale });
    const ag = snap.providers.find((p) => p.id === 'antigravity');
    assert.equal(ag.sevenDay.usedPercentage, null);
    assert.equal(ag.sevenDay.certainty, 'unknown');
  });

  test('reset_in_seconds is the fallback when reset_time will not parse', () => {
    const file = captureFile({
      capturedAt: new Date(NOW).toISOString(),
      present: true,
      quota: { 'gemini-weekly': { remainingFraction: 0.5, resetTime: null, resetInSeconds: 5 * DAY / 1000 } },
    });
    const q = readAntigravityQuota({ file, now: NOW });
    assert.equal(q.sevenDay.usedPercentage, 50);
    assert.equal(q.sevenDay.resetsAtMs, NOW + 5 * DAY);
  });
});

/* ------------------------------------------------------- the setup path */

test.describe('installing the hook into the agy CLI settings', () => {
  function sandbox({ withCliDir = true } = {}) {
    const root = tmpdir();
    const bridge = path.join(root, 'antigravity-statusline.mjs');
    fs.writeFileSync(bridge, '// bridge\n');
    const home = path.join(root, 'antigravity-cli');
    if (withCliDir) fs.mkdirSync(home);
    // Where the agy binary would be. Never created: left to its default the
    // probe reads the real %LOCALAPPDATA%, and these tests would pass or fail
    // depending on whether the developer's machine has agy installed.
    const binary = path.join(root, 'no-agy', 'agy.exe');
    return { root, home, bridge, binary, settings: path.join(home, 'settings.json') };
  }

  function backupsIn(dir) {
    return fs.readdirSync(dir).filter((f) => f.includes('usagenotch-backup'));
  }

  test('an absent agy install is a stated outcome, and creates nothing', () => {
    // Neither the binary nor the config dir exists. It must not crash, must
    // not mkdir ~/.gemini, and must not leave a settings.json for a program
    // that is not there — a file nothing would ever read.
    const s = sandbox({ withCliDir: false });
    assert.equal(fs.existsSync(s.home), false);

    assert.equal(antigravityStatusLineState(s.settings, s.home, s.binary), 'not-installed');

    const res = installAntigravityStatusLine({ confirmed: true, bridgePath: s.bridge, settingsPath: s.settings, homeDir: s.home, binaryPath: s.binary });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'CLI_NOT_FOUND');
    assert.match(res.message, /Antigravity CLI \(agy\) bulunamadı/);
    assert.match(res.message, /hiçbir dosya oluşturulmadı/);
    // The absolute path used to sit in this sentence and pushed it to 172
    // characters, past the renderer's 160-character notice cap — so the half
    // that told the user what to do was the half that got cut. It lives in the
    // log now, where there is no budget.
    assert.equal(res.message.includes(s.home), false, 'no absolute path in a one-line notice');
    assert.ok(res.message.length <= NOTICE_MAX, `${res.message.length} chars`);
    // And the framing: without `agy` this row still shows a five-hour figure
    // from the IDE store, so "not installed" must not read as "does not work".
    assert.match(res.message, /haftalık limit/);

    assert.equal(fs.existsSync(s.home), false, 'the CLI config folder was not created');
    assert.equal(fs.existsSync(s.settings), false);
  });

  test('refuses to clobber an existing statusLine and tells the user how to chain', () => {
    const s = sandbox();
    const existing = { statusLine: { type: 'command', command: 'my-own-statusline.sh' } };
    fs.writeFileSync(s.settings, JSON.stringify(existing));

    const res = installAntigravityStatusLine({ confirmed: true, bridgePath: s.bridge, settingsPath: s.settings, homeDir: s.home, binaryPath: s.binary });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'STATUSLINE_EXISTS');
    assert.match(res.message, /zincirleyin/);
    assert.match(res.message, /antigravity-statusline\.mjs/);
    // The command IS the payload here, so it is the clause that must survive
    // the budget; the explanation is the one that gives way.
    assert.ok(res.message.length <= NOTICE_MAX, `${res.message.length} chars`);

    assert.deepEqual(JSON.parse(fs.readFileSync(s.settings, 'utf8')), existing, 'untouched');
    assert.deepEqual(backupsIn(s.home), [], 'no backup, because nothing was going to be written');
  });

  test('refuses without an explicit confirmation flag', () => {
    const s = sandbox();
    for (const confirmed of [undefined, false, 'true', 1, null]) {
      const res = installAntigravityStatusLine({ confirmed, bridgePath: s.bridge, settingsPath: s.settings, homeDir: s.home, binaryPath: s.binary });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'NOT_CONFIRMED');
      assert.match(res.message, /Onay/);
    }
    assert.equal(fs.existsSync(s.settings), false);
  });

  test('installs beside the CLI keys it does not understand, after a timestamped backup', () => {
    const s = sandbox();
    // Deliberately includes keys we have never heard of. We own exactly one
    // key in this file and must round-trip the rest untouched.
    const original = JSON.stringify({ theme: 'dark', vim: { mode: 'NORMAL' }, sandbox: { enabled: true } });
    fs.writeFileSync(s.settings, original);

    const res = installAntigravityStatusLine({
      confirmed: true, bridgePath: s.bridge, settingsPath: s.settings, homeDir: s.home, binaryPath: s.binary,
      now: Date.parse('2026-09-08T12:00:00Z'),
    });
    assert.equal(res.ok, true);

    const after = JSON.parse(fs.readFileSync(s.settings, 'utf8'));
    assert.equal(after.theme, 'dark');
    assert.deepEqual(after.vim, { mode: 'NORMAL' });
    assert.deepEqual(after.sandbox, { enabled: true });
    assert.equal(after.statusLine.type, 'command');
    // NO quotes around the path. agy keeps quote characters as part of the
    // argument, so a quoted path reaches node as a literal, unresolvable module
    // id (see statusLineEntry). The path has forward slashes and no backslashes.
    assert.match(after.statusLine.command, /^node \S.*antigravity-statusline\.mjs$/);
    assert.equal(after.statusLine.command.includes('"'), false, 'no quotes: agy passes them to node verbatim');
    assert.equal(after.statusLine.command.includes('\\'), false, 'forward slashes survive a shell');

    const backups = backupsIn(s.home);
    assert.equal(backups.length, 1);
    assert.match(backups[0], /settings\.json\.usagenotch-backup-2026-09-08T12-00-00-000Z/);
    assert.equal(fs.readFileSync(path.join(s.home, backups[0]), 'utf8'), original);
  });

  test('never overwrites a settings file it could not parse', () => {
    const s = sandbox();
    const broken = '{ "theme": "dark", oops';
    fs.writeFileSync(s.settings, broken);
    const res = installAntigravityStatusLine({ confirmed: true, bridgePath: s.bridge, settingsPath: s.settings, homeDir: s.home, binaryPath: s.binary });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'SETTINGS_INVALID');
    assert.equal(fs.readFileSync(s.settings, 'utf8'), broken);
  });

  test('the probe distinguishes not-installed from no-settings from ours', () => {
    const s = sandbox({ withCliDir: false });
    assert.equal(antigravityStatusLineState(s.settings, s.home, s.binary), 'not-installed');

    fs.mkdirSync(s.home);
    assert.equal(antigravityStatusLineState(s.settings, s.home, s.binary), 'no-settings');

    fs.writeFileSync(s.settings, JSON.stringify({ theme: 'dark' }));
    assert.equal(antigravityStatusLineState(s.settings, s.home, s.binary), 'none');

    fs.writeFileSync(s.settings, JSON.stringify({ statusLine: { command: './statusline.sh' } }));
    assert.equal(antigravityStatusLineState(s.settings, s.home, s.binary), 'foreign');

    fs.writeFileSync(s.settings, JSON.stringify({ statusLine: { command: 'node "C:/x/antigravity-statusline.mjs"' } }));
    assert.equal(antigravityStatusLineState(s.settings, s.home, s.binary), 'ours');

    fs.writeFileSync(s.settings, 'nope');
    assert.equal(antigravityStatusLineState(s.settings, s.home, s.binary), 'invalid');
  });
});

/* ------------------------------------------------------- the bridge itself */

test.describe('the bridge writes numbers and nothing else', () => {
  /** Runs the real hook exactly as the CLI would: payload on stdin. */
  function runBridge(payload) {
    const out = tmpdir();
    const res = spawnSync(
      process.execPath,
      [path.join(__dirname, '..', 'bridge', 'antigravity-statusline.mjs')],
      {
        input: typeof payload === 'string' ? payload : JSON.stringify(payload),
        encoding: 'utf8',
        env: { ...process.env, LOCALAPPDATA: out },
      },
    );
    const file = path.join(out, 'UsageNotch', 'antigravity-quota.json');
    return {
      status: res.status,
      stdout: res.stdout,
      exists: fs.existsSync(file),
      text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null,
      file,
    };
  }

  /** The doc's own sanitized example payload, trimmed to the fields that
   *  matter here plus every field that must NOT survive the trip. */
  const DOC_PAYLOAD = {
    cwd: '/home/user/my-project',
    session_id: '12345678-abcd-ef01-2345-6789abcdef01',
    conversation_id: '12345678-abcd-ef01-2345-6789abcdef01',
    transcript_path: '/home/user/.gemini/antigravity/brain/12345678/.system_generated/logs/transcript.jsonl',
    model: { id: 'Gemini 3.5 Flash (High)', display_name: 'Gemini 3.5 Flash (High)' },
    workspace: { current_dir: '/home/user/my-project', project_dir: '/home/user/my-project' },
    context_window: { total_input_tokens: 88244, used_percentage: 14.24 },
    product: 'antigravity',
    quota: {
      'gemini-weekly': {
        remaining_fraction: 0.9378,
        reset_time: '2026-07-06T07:50:32Z',
        reset_in_seconds: 560580,
      },
    },
    vcs: { type: 'git', branch: 'secret-project-codename', dirty: false },
    plan_tier: 'Pro',
    email: 'developer@email.com',
  };

  test('captures the quota numbers from the documented payload', () => {
    const r = runBridge(DOC_PAYLOAD);
    assert.equal(r.status, 0);
    assert.ok(r.exists, 'the capture file was written');
    const snap = JSON.parse(r.text);
    assert.equal(snap.present, true);
    assert.deepEqual(snap.quota['gemini-weekly'], {
      remainingFraction: 0.9378,
      resetTime: '2026-07-06T07:50:32.000Z',
      resetInSeconds: 560580,
    });
    // Verbatim, NOT converted. The remaining -> used conversion has exactly
    // one home and it is not this file.
    assert.equal(snap.quota['gemini-weekly'].remainingFraction, 0.9378);
  });

  test('persists no chat content, path, branch, e-mail or identifier', () => {
    // The payload carries all of these. None of them is any of our business,
    // and a capture file is a plaintext file in the user's profile.
    const r = runBridge(DOC_PAYLOAD);
    for (const forbidden of [
      '/home/user/my-project',
      'transcript.jsonl',
      'secret-project-codename',
      'developer@email.com',
      '12345678-abcd-ef01',
      'Gemini 3.5 Flash',
      'Pro',
      '88244',
    ]) {
      assert.equal(r.text.includes(forbidden), false, `capture leaked ${forbidden}`);
    }
    // Top-level KEY NAMES are kept as a diagnostic; their values are not.
    assert.ok(JSON.parse(r.text).payloadKeys.includes('email'));
  });

  test('a payload with no quota, or no payload at all, still exits clean', () => {
    // The hook runs on every agent state change. A crash here breaks the
    // user's status line, which is a worse outcome than showing nothing.
    for (const input of ['', 'not json at all', '{}', '{"quota":null}', '{"quota":[]}']) {
      const r = runBridge(input);
      assert.equal(r.status, 0, JSON.stringify(input));
      if (r.exists) {
        assert.equal(JSON.parse(r.text).present, false, JSON.stringify(input));
      }
    }
  });

  test('what the bridge writes is what the reader reads', () => {
    // End to end, with no hand-written fixture in between: a fixture that
    // drifts from the real writer is how a reader passes its tests and still
    // sees nothing in production.
    const now = Date.parse('2026-07-01T00:00:00Z');
    const r = runBridge(DOC_PAYLOAD);
    // Rewrite only capturedAt, so the capture is fresh relative to `now`.
    const raw = JSON.parse(r.text);
    raw.capturedAt = new Date(now).toISOString();
    fs.writeFileSync(r.file, JSON.stringify(raw));

    const q = readAntigravityQuota({ file: r.file, now });
    assert.equal(q.state, 'fresh');
    assert.equal(q.sevenDay.usedPercentage, 6.22);
    assert.equal(q.sevenDay.resetsAtMs, Date.parse('2026-07-06T07:50:32Z'));
  });

  test('the bridge and the setup code never touch a credential store', () => {
    // The `agy` CLI keeps its auth material under ~/.gemini. The only file
    // named anywhere in this lane is settings.json, and only its statusLine
    // key is read or written.
    const sources = [
      'bridge/antigravity-statusline.mjs',
      'src/core/setup/antigravity-bridge.js',
      'src/core/paths.js',
      'src/core/ratelimits.js',
    ];
    for (const rel of sources) {
      const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      const inCode = text
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join('\n');
      for (const forbidden of ['credentials', 'oauth', 'access_token', 'api_key', 'apiKey']) {
        assert.equal(inCode.toLowerCase().includes(forbidden.toLowerCase()), false, `${rel} references ${forbidden}`);
      }
    }
  });

  test('nothing in this lane opens a network connection', () => {
    const sources = [
      'bridge/antigravity-statusline.mjs',
      'src/core/setup/antigravity-bridge.js',
      'src/core/ratelimits.js',
      'src/core/snapshot.js',
    ];
    for (const rel of sources) {
      const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      const inCode = text
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join('\n');
      for (const forbidden of ['node:http', 'node:https', 'node:net', 'fetch(', 'XMLHttpRequest']) {
        assert.equal(inCode.includes(forbidden), false, `${rel} references ${forbidden}`);
      }
    }
  });
});

/* ------------------------------------------- the status line the user sees */

test.describe('the bridge stdout is a surface, not a debug print', () => {
  function runBridge(payload) {
    const out = tmpdir();
    const res = spawnSync(
      process.execPath,
      [path.join(__dirname, '..', 'bridge', 'antigravity-statusline.mjs')],
      {
        input: typeof payload === 'string' ? payload : JSON.stringify(payload),
        encoding: 'utf8',
        env: { ...process.env, LOCALAPPDATA: out },
      },
    );
    const file = path.join(out, 'UsageNotch', 'antigravity-quota.json');
    return {
      status: res.status,
      stdout: res.stdout,
      snapshot: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null,
    };
  }

  test('a bidi override in a bucket id cannot reverse the figure beside it', () => {
    // U+202E reverses everything printed after it, so a 64-character id is
    // more than enough to render `10% left` as `tfel %01` in the user's terminal —
    // a false statement about remaining quota, produced by the one component
    // whose entire purpose is not to make those. Same character class as
    // `CONTROL_CHARS` in src/renderer/src/sanitize.ts.
    const r = runBridge({
      quota: { 'gemini\u202E-weekly': { remaining_fraction: 0.1 } },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.includes('\u202E'), false, 'stdout carries no bidi override');
    assert.equal(JSON.stringify(r.snapshot).includes('\u202E'), false, 'and neither does the capture');
    // Stripped, not dropped: the id is otherwise legitimate and losing the
    // bucket over its spelling would cost a real reading.
    assert.deepEqual(Object.keys(r.snapshot.quota), ['gemini-weekly']);
    assert.match(r.stdout, /gemini-weekly 10% left/);
  });

  test('control and zero-width characters go the same way', () => {
    const r = runBridge({
      quota: { 'a\u0000b\u200Bc-weekly': { remaining_fraction: 0.5 } },
    });
    assert.deepEqual(Object.keys(r.snapshot.quota), ['abc-weekly']);
  });

  test('an id that is nothing BUT control characters is dropped', () => {
    const r = runBridge({
      quota: { '\u200B\u200B': { remaining_fraction: 0.5 }, 'gemini-weekly': { remaining_fraction: 0.5 } },
    });
    assert.deepEqual(Object.keys(r.snapshot.quota), ['gemini-weekly']);
  });

  test('an out-of-range fraction is never printed as a percentage', () => {
    // `usedFromRemaining` rejects these as proof the producer is wrong. The
    // status line must apply the identical test, or it prints `140% left`
    // beside a panel row that shows nothing at all — two surfaces disagreeing
    // about when one number is unusable.
    const r = runBridge({
      quota: {
        'bad-high-weekly': { remaining_fraction: 1.4 },
        'bad-low-weekly': { remaining_fraction: -0.2 },
        'good-weekly': { remaining_fraction: 0.25 },
      },
    });
    assert.equal(r.stdout.includes('140%'), false);
    assert.equal(r.stdout.includes('-20%'), false);
    // Remaining, unconverted, and said so: 25% LEFT, not 75% and not a bare 25%.
    assert.equal(r.stdout, 'good-weekly 25% left');
    // Still written to the capture verbatim: the file is a faithful copy of
    // what the CLI said, and the reader is where values are judged.
    assert.equal(r.snapshot.quota['bad-high-weekly'].remainingFraction, 1.4);
  });

  test('a payload whose every fraction is unusable falls back to the plain label', () => {
    const r = runBridge({ quota: { 'x-weekly': { remaining_fraction: 9 } } });
    // The product name only: the bridge cannot know the user's language.
    assert.equal(r.stdout, 'LimitPeek');
  });
});

/* ------------------------------------------ the size guard cannot be optimistic */

test.describe('a truncated capture yields no figure at all', () => {
  test('the bridge records that the cap bit', () => {
    const many = {};
    for (let i = 0; i < 20; i += 1) many[`b${String(i).padStart(2, '0')}-weekly`] = { remaining_fraction: 0.9 };
    const out = tmpdir();
    spawnSync(process.execPath, [path.join(__dirname, '..', 'bridge', 'antigravity-statusline.mjs')], {
      input: JSON.stringify({ quota: many }),
      encoding: 'utf8',
      env: { ...process.env, LOCALAPPDATA: out },
    });
    const snap = JSON.parse(fs.readFileSync(path.join(out, 'UsageNotch', 'antigravity-quota.json'), 'utf8'));
    assert.equal(snap.truncated, true);
    assert.equal(Object.keys(snap.quota).length, 16);
  });

  test('an untruncated capture says so, and is read normally', () => {
    const q = readAntigravityQuota({ file: freshCapture({ truncated: false }), now: NOW });
    assert.equal(q.state, 'fresh');
    assert.equal(q.sevenDay.usedPercentage, 6.22);
    assert.equal(q.reason, null);
  });

  test('the reader refuses a maximum it has been told may be incomplete', () => {
    // The cap drops alphabetically last, which is arbitrary with respect to
    // consumption. The slot keeps the MOST consumed bucket, so a dropped
    // bucket may have been the binding one — and reporting the roomiest
    // survivor would be an OPTIMISTIC figure manufactured by a size guard,
    // the single direction this project exists to prevent.
    const file = captureFile({
      capturedAt: new Date(NOW).toISOString(),
      present: true,
      truncated: true,
      quota: { 'a-weekly': { remainingFraction: 0.9, resetTime: new Date(NOW + 6.5 * DAY).toISOString() } },
    });
    const q = readAntigravityQuota({ file, now: NOW });
    assert.equal(q.state, 'absent');
    assert.equal(q.reason, 'truncated');
    assert.equal(q.sevenDay, null, 'the surviving 10%-used bucket is NOT presented as the maximum');

    const snap = buildSnapshot({ now: NOW, events: [], rateLimits: { state: 'missing' }, scanOk: true, antigravityQuota: q });
    const ag = snap.providers.find((p) => p.id === 'antigravity');
    assert.equal(ag.sevenDay.usedPercentage, null);
  });
});

/* ---------------------------------------- naming the likeliest field failure */

test.describe('an unreadable quota is nameable, not just "Güncellenemedi"', () => {
  test('the reader separates "nothing said" from "said something we cannot read"', () => {
    const nothing = readAntigravityQuota({
      file: captureFile({ capturedAt: new Date(NOW).toISOString(), present: false, quota: {} }),
      now: NOW,
    });
    assert.equal(nothing.reason, 'no-quota');
    assert.deepEqual(nothing.unmappedIds, []);

    const unreadable = readAntigravityQuota({
      file: captureFile({
        capturedAt: new Date(NOW).toISOString(),
        present: true,
        quota: {
          'gemini-daily': { remainingFraction: 0.5 },
          'flash-hourly': { remainingFraction: 0.5 },
        },
      }),
      now: NOW,
    });
    assert.equal(unreadable.reason, 'unrecognised');
    assert.equal(unreadable.bucketsSeen, 2);
    assert.equal(unreadable.bucketsMapped, 0);
    // The ids are the whole point: the bucket id space is undocumented, so
    // "which names did we not recognise" is the only actionable fact here.
    assert.deepEqual(unreadable.unmappedIds, ['flash-hourly', 'gemini-daily']);
  });

  test('unmappedIds are stripped and bounded before anyone logs them', () => {
    const q = readAntigravityQuota({
      file: captureFile({
        capturedAt: new Date(NOW).toISOString(),
        present: true,
        quota: { 'ev\u202Eil-daily': { remainingFraction: 0.5 } },
      }),
      now: NOW,
    });
    assert.deepEqual(q.unmappedIds, ['evil-daily']);
  });

  test('the collector names the ids once, not on every rebuild', () => {
    // `rebuild()` runs on every watcher event and on a 15s sweep. An
    // unconditional warn would print the same line hundreds of times an hour
    // and bury everything else, so it speaks on a TRANSITION.
    const dir = tmpdir();
    const quotaFile = path.join(dir, 'antigravity-quota.json');
    fs.writeFileSync(quotaFile, JSON.stringify({
      capturedAt: new Date().toISOString(),
      present: true,
      quota: { 'gemini-daily': { remainingFraction: 0.5 } },
    }));

    const lines = [];
    log.setSink((level, msg) => { if (level === 'warn') lines.push(msg); });
    try {
      const c = new Collector({
        userDataDir: dir,
        projectsRoot: path.join(dir, 'projects'),
        rateLimitsFile: path.join(dir, 'claude-rate-limits.json'),
        // An empty Codex home, so the rollout scan never reads the developer's own ~/.codex.
        codexHome: path.join(dir, 'codex'),
        antigravityUsageHome: path.join(dir, 'antigravity-home'),
        rateLimitsDir: dir,
        antigravityQuotaFile: quotaFile,
      });
      c.rebuild();
      c.rebuild();
      c.rebuild();
    } finally {
      log.setSink(null);
    }

    const warns = lines.filter((l) => l.includes('antigravity quota unusable'));
    assert.equal(warns.length, 1, 'once, not three times');
    assert.match(warns[0], /reason=unrecognised/);
    assert.match(warns[0], /seen=1 mapped=0/);
    assert.match(warns[0], /ids=gemini-daily/);
  });

  test('a plain missing capture is silent: not installed is not a fault', () => {
    const dir = tmpdir();
    const lines = [];
    log.setSink((level, msg) => { if (level === 'warn') lines.push(msg); });
    try {
      const c = new Collector({
        userDataDir: dir,
        projectsRoot: path.join(dir, 'projects'),
        rateLimitsFile: path.join(dir, 'claude-rate-limits.json'),
        // An empty Codex home, so the rollout scan never reads the developer's own ~/.codex.
        codexHome: path.join(dir, 'codex'),
        antigravityUsageHome: path.join(dir, 'antigravity-home'),
        rateLimitsDir: dir,
        antigravityQuotaFile: path.join(dir, 'nope.json'),
      });
      c.rebuild();
    } finally {
      log.setSink(null);
    }
    assert.deepEqual(lines.filter((l) => l.includes('antigravity quota unusable')), []);
  });
});

/* --------------------------------------- the escape hatch may not be silent */

test.describe('ANTIGRAVITY_CLI_DIR is kept, but never silent', () => {
  /** Runs `fn` with the escape hatch actually set, and always restores it. */
  function withOverride(dir, fn) {
    const previous = process.env.ANTIGRAVITY_CLI_DIR;
    process.env.ANTIGRAVITY_CLI_DIR = dir;
    try {
      return fn();
    } finally {
      if (previous === undefined) delete process.env.ANTIGRAVITY_CLI_DIR;
      else process.env.ANTIGRAVITY_CLI_DIR = previous;
    }
  }

  test('a non-default CLI home is named in the result the user reads', () => {
    // The override stays: if the documented directory name is ever wrong it
    // is the only one-constant fix in the field. What must not happen is a
    // "Bağlandı" for a statusLine written where `agy` never looks, leaving the
    // user waiting for a percentage that cannot arrive.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-agy-ovr-'));
    const home = path.join(root, 'somewhere-else');
    fs.mkdirSync(home);
    const bridge = path.join(root, 'antigravity-statusline.mjs');
    fs.writeFileSync(bridge, '// bridge\n');

    const res = withOverride(home, () => {
      assert.equal(antigravityHomeOverridden(home), true);
      return installAntigravityStatusLine({
        confirmed: true, bridgePath: bridge, settingsPath: path.join(home, 'settings.json'), homeDir: home,
        binaryPath: path.join(root, 'no-agy', 'agy.exe'),
      });
    });
    assert.equal(res.ok, true);
    assert.match(res.message, /Bağlandı/);
    assert.match(res.message, /ANTIGRAVITY_CLI_DIR/, 'the success message says the path is not the documented one');
    // Shortened from the LEFT: the tail is what identifies a path, and the
    // whole notice still has to fit the renderer's cap.
    assert.ok(res.message.includes('somewhere-else'), 'and names which folder');
    assert.ok(res.message.length <= NOTICE_MAX, `${res.message.length} chars`);
    // The documented path is a log fact, not a notice fact.
    assert.equal(res.message.includes(antigravityDefaultHome()), false);
  });

  test('the documented path adds no notice at all', () => {
    assert.equal(antigravityHomeOverridden(antigravityDefaultHome()), false);
  });

  test('an explicit directory that is not the escape hatch raises no warning', () => {
    // The warning is about ANTIGRAVITY_CLI_DIR being active, not about any
    // path that happens to differ from the default. Keying it on the path
    // alone fired it at every test sandbox and at any future multi-install
    // resolver — a warning that cries wolf is a warning nobody reads.
    assert.equal(antigravityHomeOverridden(path.join(os.tmpdir(), 'anywhere')), false);
    assert.equal(messages.overrideClause(path.join(os.tmpdir(), 'anywhere')), '');
  });

  test('a not-found result under an override says both things', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-agy-ovr2-'));
    const home = path.join(root, 'absent');
    const bridge = path.join(root, 'antigravity-statusline.mjs');
    fs.writeFileSync(bridge, '// bridge\n');

    const res = withOverride(home, () => installAntigravityStatusLine({
      confirmed: true, bridgePath: bridge, settingsPath: path.join(home, 'settings.json'), homeDir: home,
      binaryPath: path.join(root, 'no-agy', 'agy.exe'),
    }));
    assert.equal(res.code, 'CLI_NOT_FOUND');
    assert.match(res.message, /Antigravity CLI \(agy\) bulunamadı/);
    assert.match(res.message, /ANTIGRAVITY_CLI_DIR/);
    assert.ok(res.message.length <= NOTICE_MAX, `${res.message.length} chars`);
  });

  test('every setup notice this lane produces fits the renderer cap', () => {
    // The cap is not a safety net to be relied on — it cuts mid-word, and the
    // instruction is what lives at the end. These strings fit by construction,
    // including under a pathologically long override path.
    const longHome = `C:\\Users\\someone\\${'nested\\'.repeat(20)}antigravity-cli`;
    const longCmd = `node "C:/Users/someone/${'nested/'.repeat(20)}antigravity-statusline.mjs"`;
    const i18n = require('../src/core/i18n');
    // ADR-004: in both languages. The override warning goes under the same
    // pathological path in each, and English is not always the shorter one.
    try {
      for (const [language, locale] of [['tr', 'tr-TR'], ['en', 'en-US']]) {
        i18n.setLocale(language, locale);
        const notices = [
          messages.cliNotFound(antigravityDefaultHome()),
          messages.cliNotFound(longHome),
          messages.installed(antigravityDefaultHome()),
          messages.installed(longHome),
          messages.statusLineExists('node "C:/x/antigravity-statusline.mjs"'),
          messages.statusLineExists(longCmd),
        ];
        for (const notice of notices) {
          // The one exception is a pathological command, which is required and
          // therefore emitted whole; it is asserted separately below.
          if (!notice.includes(longCmd)) {
            assert.ok(notice.length <= NOTICE_MAX, `${language} ${notice.length} chars: ${notice}`);
          }
          assert.equal(notice.endsWith('…'), false, 'never truncated, only shortened by whole clauses');
          assert.ok(notice.length > 0, 'and never emptied');
        }
        // The command is the REQUIRED clause: it is what the user has to copy, so
        // it survives and the explanation gives way. An earlier version had this
        // backwards and dropped the command on a long install path.
        assert.ok(messages.statusLineExists(longCmd).includes(longCmd), 'the command is never sliced');
        assert.equal(messages.statusLineExists(longCmd).includes(i18n.t('setup.noOverwrite')), false);
      }
    } finally {
      i18n.setLocale('tr', 'tr-TR');
    }
  });
});
