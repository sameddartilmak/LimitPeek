'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildSnapshot, loadingSnapshot } = require('../src/core/snapshot');
const { readClaudeRateLimits } = require('../src/core/ratelimits');
const { PROVIDER_IDS, PROVIDERS } = require('../src/core/providers');

/**
 * The providers this app cannot collect anything for. Derived from the
 * registry rather than listed, because the list changes every time a row is
 * wired and a hard-coded copy of it silently stops testing the new one.
 */
// A provider we cannot collect, OR a local-log provider (Gemini, Kimi) whose tool
// is not installed: buildSnapshot is given no `gemini`/`kimi` input here, which
// is exactly the not-installed state (ADR-003 A6).
const PASSIVE_IDS = PROVIDERS.filter((p) => p.live !== true || p.id === 'gemini' || p.id === 'kimi').map((p) => p.id);

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-09-08T12:00:00.000Z');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-test-'));
}

function ev(over) {
  return {
    f: 'f1', ts: NOW - HOUR, model: 'claude-opus-5',
    input: 0, output: 0, cacheWrite: 0, cacheRead: 0, key: 'k', ...over,
  };
}

function claude(snapshot) {
  return snapshot.providers.find((p) => p.id === 'claude');
}

test.describe('no rate-limit file -> certainty unknown', () => {
  test('a missing capture file yields unknown, null percentage, null resetsAt', () => {
    const dir = tmpdir();
    const rl = readClaudeRateLimits({ file: path.join(dir, 'does-not-exist.json'), now: NOW });
    assert.equal(rl.state, 'missing');

    const snap = buildSnapshot({ now: NOW, events: [ev({ output: 1000 })], rateLimits: rl, scanOk: true });
    const c = claude(snap);
    assert.equal(c.fiveHour.certainty, 'unknown');
    assert.equal(c.fiveHour.usedPercentage, null);
    assert.equal(c.fiveHour.resetsAt, null);
    assert.equal(c.sevenDay.certainty, 'unknown');
    assert.equal(c.sevenDay.usedPercentage, null);
  });

  test('absolute tokens and burn rate are still reported when the percentage is unknown', () => {
    const rl = readClaudeRateLimits({ file: path.join(tmpdir(), 'nope.json'), now: NOW });
    const snap = buildSnapshot({
      now: NOW,
      events: [ev({ ts: NOW - HOUR, output: 1000, cacheWrite: 500, cacheRead: 9_000_000 })],
      rateLimits: rl,
      scanOk: true,
    });
    const c = claude(snap);
    assert.equal(c.tokens.billable, 1500);
    assert.equal(c.tokens.cacheRead, 9_000_000);
    assert.equal(typeof c.burnRatePerHour, 'number');
  });

  test('an unconnected Claude row is passive and offers the bridge install', () => {
    const rl = readClaudeRateLimits({ file: path.join(tmpdir(), 'nope.json'), now: NOW });
    const c = claude(buildSnapshot({ now: NOW, events: [], rateLimits: rl, scanOk: true }));
    assert.equal(c.connected, false);
    assert.equal(c.status, 'passive');
    assert.equal(c.setupAction.kind, 'install-bridge');
  });

  test('a stale capture whose windows have ALL reset is equivalent to a missing one', () => {
    // Per ADR-001 amendment 2 this is the only case where staleness alone
    // removes the figure: both windows rolled over after the capture, so both
    // percentages describe windows that no longer exist.
    const file = path.join(tmpdir(), 'claude-rate-limits.json');
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      capturedAt: new Date(NOW - 45 * 60 * 1000).toISOString(),
      present: true,
      fiveHour: { usedPercentage: 6, resetsAt: (NOW - 30 * 60 * 1000) / 1000 },
      sevenDay: { usedPercentage: 10, resetsAt: (NOW - 10 * 60 * 1000) / 1000 },
    }));
    const rl = readClaudeRateLimits({ file, now: NOW });
    assert.equal(rl.state, 'stale');

    const c = claude(buildSnapshot({ now: NOW, events: [], rateLimits: rl, scanOk: true }));
    assert.equal(c.fiveHour.certainty, 'unknown');
    assert.equal(c.fiveHour.usedPercentage, null, 'a figure about a window that has reset is never shown');
    assert.equal(c.sevenDay.usedPercentage, null);
    assert.equal(c.status, 'stale');
    assert.equal(c.connected, true, 'the bridge is installed, it is just quiet');
  });

  test('present:false means the bridge ran but Claude sent no rate_limits', () => {
    const file = path.join(tmpdir(), 'rl.json');
    fs.writeFileSync(file, JSON.stringify({ capturedAt: new Date(NOW).toISOString(), present: false }));
    const rl = readClaudeRateLimits({ file, now: NOW });
    assert.equal(rl.state, 'absent');
    const c = claude(buildSnapshot({ now: NOW, events: [], rateLimits: rl, scanOk: true }));
    assert.equal(c.fiveHour.usedPercentage, null);
    assert.equal(c.errorCode, 'RATE_LIMITS_UNAVAILABLE');
  });

  test('a corrupt capture file never produces a number', () => {
    const file = path.join(tmpdir(), 'rl.json');
    fs.writeFileSync(file, '{ this is not json');
    const rl = readClaudeRateLimits({ file, now: NOW });
    assert.equal(rl.state, 'invalid');
    const c = claude(buildSnapshot({ now: NOW, events: [], rateLimits: rl, scanOk: true }));
    assert.equal(c.fiveHour.usedPercentage, null);
    assert.equal(c.fiveHour.certainty, 'unknown');
  });

  test('an out-of-range percentage is rejected rather than clamped', () => {
    const file = path.join(tmpdir(), 'rl.json');
    fs.writeFileSync(file, JSON.stringify({
      capturedAt: new Date(NOW).toISOString(),
      present: true,
      fiveHour: { usedPercentage: 4200, resetsAt: (NOW + HOUR) / 1000 },
      sevenDay: null,
    }));
    const rl = readClaudeRateLimits({ file, now: NOW });
    const c = claude(buildSnapshot({ now: NOW, events: [], rateLimits: rl, scanOk: true }));
    assert.equal(c.fiveHour.usedPercentage, null);
    assert.equal(c.fiveHour.certainty, 'unknown');
  });
});

test.describe("a renewed window awaits its report, and only when connected", () => {
  // Claude Code renews the five-hour window and only writes the new number the
  // next time it runs. In between the bridge holds a FRESH, valid capture whose
  // five-hour figure is null while the weekly one is still a live reading.
  function freshCapture(over) {
    const file = path.join(tmpdir(), 'rl.json');
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      capturedAt: new Date(NOW).toISOString(),
      present: true,
      // No usedPercentage on the five-hour window -> the reader reports it null.
      fiveHour: { resetsAt: (NOW + HOUR) / 1000 },
      sevenDay: { usedPercentage: 10, resetsAt: (NOW + 3 * 24 * HOUR) / 1000 },
      ...over,
    }));
    return readClaudeRateLimits({ file, now: NOW });
  }

  test("a fresh capture with a null current-window figure says 'yeni veri bekleniyor', not 'bilinmiyor'", () => {
    const rl = freshCapture();
    assert.equal(rl.state, 'fresh');
    const c = claude(buildSnapshot({ now: NOW, events: [], rateLimits: rl, scanOk: true }));
    assert.equal(c.connected, true);
    assert.equal(c.fiveHour.usedPercentage, null);
    assert.equal(c.fiveHour.certainty, 'unknown');
    assert.equal(c.fiveHour.absence, 'awaiting-report', 'connected + current + null == awaiting a report');
    // The weekly reading is still live, so the row draws its meter and the
    // five-hour block renders this absence copy rather than the whole-row
    // "Kullanım oranı bilinmiyor" fallback.
    assert.equal(c.sevenDay.usedPercentage, 10);
  });

  test('the awaiting-report word is used even when the current window has no reset instant', () => {
    const rl = freshCapture({ fiveHour: {} });
    const c = claude(buildSnapshot({ now: NOW, events: [], rateLimits: rl, scanOk: true }));
    assert.equal(c.fiveHour.absence, 'awaiting-report');
    assert.equal(c.fiveHour.resetsAt, null);
  });

  test('a figure whose window has ALREADY rolled over still says rolled-over, not awaiting-report', () => {
    // Fresh file, but the five-hour window it describes reset ten minutes ago.
    // windowFrom decides this on the non-null percentage and never consults the
    // awaiting-report stamp, so the two states stay distinct.
    const rl = freshCapture({ fiveHour: { usedPercentage: 6, resetsAt: (NOW - 10 * 60 * 1000) / 1000 } });
    assert.equal(rl.state, 'fresh');
    const c = claude(buildSnapshot({ now: NOW, events: [], rateLimits: rl, scanOk: true }));
    assert.equal(c.fiveHour.usedPercentage, null);
    assert.equal(c.fiveHour.absence, 'rolled-over');
  });

  test('a NEVER-connected row never claims to be awaiting a report', () => {
    // The first-run user: no bridge at all. The row is passive and shows the
    // setup path; its windows must not read "yeni veri bekleniyor".
    const rl = readClaudeRateLimits({ file: path.join(tmpdir(), 'nope.json'), now: NOW });
    assert.equal(rl.state, 'missing');
    const c = claude(buildSnapshot({ now: NOW, events: [], rateLimits: rl, scanOk: true }));
    assert.equal(c.connected, false);
    assert.equal(c.setupAction.kind, 'install-bridge');
    assert.equal(c.fiveHour.absence, 'no-capture');
    assert.equal(c.sevenDay.absence, 'no-capture');
  });

  test('a bridge that ran but sent no rate_limits is absent, not awaiting a report', () => {
    const file = path.join(tmpdir(), 'rl.json');
    fs.writeFileSync(file, JSON.stringify({ capturedAt: new Date(NOW).toISOString(), present: false }));
    const rl = readClaudeRateLimits({ file, now: NOW });
    assert.equal(rl.state, 'absent');
    const c = claude(buildSnapshot({ now: NOW, events: [], rateLimits: rl, scanOk: true }));
    assert.equal(c.fiveHour.absence, 'no-capture');
  });

  test('a STALE capture that never carried a figure stays bilinmiyor, not awaiting-report', () => {
    // Old, not fresh: the number is not "about to land", the capture is simply
    // stale, so the honest general default is kept.
    const rl = freshCapture({ capturedAt: new Date(NOW - 45 * 60 * 1000).toISOString() });
    assert.equal(rl.state, 'stale');
    const c = claude(buildSnapshot({ now: NOW, events: [], rateLimits: rl, scanOk: true }));
    assert.equal(c.fiveHour.absence, 'no-capture');
  });
});

test.describe('fresh capture -> certainty known, verbatim', () => {
  // The real payload the orchestrator captured from the bridge on this machine.
  const REAL = {
    schemaVersion: 1,
    present: true,
    fiveHour: { usedPercentage: 6, resetsAt: 1788865800 },
    sevenDay: { usedPercentage: 10, resetsAt: 1789009200 },
  };
  const at = 1788865800 * 1000 - 2 * HOUR; // two hours before the 5h reset

  function freshFile() {
    const file = path.join(tmpdir(), 'claude-rate-limits.json');
    fs.writeFileSync(file, JSON.stringify({ ...REAL, capturedAt: new Date(at).toISOString() }));
    return file;
  }

  test('the percentage is passed through untouched and resetsAt becomes ISO', () => {
    const rl = readClaudeRateLimits({ file: freshFile(), now: at });
    assert.equal(rl.state, 'fresh');
    const c = claude(buildSnapshot({ now: at, events: [], rateLimits: rl, scanOk: true }));
    assert.equal(c.fiveHour.certainty, 'known');
    assert.equal(c.fiveHour.usedPercentage, 6);
    assert.equal(c.fiveHour.resetsAt, new Date(1788865800 * 1000).toISOString());
    assert.equal(c.sevenDay.usedPercentage, 10);
    assert.equal(c.status, 'ok');
    assert.equal(c.connected, true);
    assert.equal(c.setupAction, null);
  });

  test('the token window is anchored to the real reset instant', () => {
    const resetsAtMs = 1788865800 * 1000;
    const rl = readClaudeRateLimits({ file: freshFile(), now: at });
    const snap = buildSnapshot({
      now: at,
      events: [
        ev({ ts: resetsAtMs - 5 * HOUR - 1, key: 'previousWindow', output: 999999 }),
        ev({ ts: resetsAtMs - 5 * HOUR, key: 'firstOfWindow', output: 100 }),
        ev({ ts: at, key: 'now', output: 200 }),
      ],
      rateLimits: rl,
      scanOk: true,
    });
    assert.equal(claude(snap).tokens.billable, 300, 'the previous window must not leak in');
  });

  test('no branch computes a percentage from tokens', () => {
    const rl = readClaudeRateLimits({ file: freshFile(), now: at });
    const huge = [ev({ ts: at, key: 'x', output: 500_000_000, cacheRead: 9_000_000_000 })];
    const c = claude(buildSnapshot({ now: at, events: huge, rateLimits: rl, scanOk: true }));
    assert.equal(c.fiveHour.usedPercentage, 6, 'token volume must not move the gauge');
  });
});

test.describe('provider registry shape', () => {
  test('all six providers are present, in order, exactly once', () => {
    const snap = buildSnapshot({ now: NOW, events: [], rateLimits: { state: 'missing' }, scanOk: true });
    assert.deepEqual(snap.providers.map((p) => p.id), PROVIDER_IDS);
    assert.deepEqual(PROVIDER_IDS, ['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'kimi']);
  });

  test('the passive providers show no numbers at all', () => {
    // Was "the five passive providers". Antigravity left this set when its
    // documented `agy` statusline hook was wired, and Codex left it when its
    // session-rollout rate limits were read; the set is now read off the
    // registry's `live` flag, so the assertions below are unchanged. Gemini and
    // Kimi are live since ADR-003 A6 but stay in this set while not installed.
    assert.deepEqual(PASSIVE_IDS, ['gemini', 'copilot', 'kimi']);
    const snap = buildSnapshot({ now: NOW, events: [ev({ output: 100 })], rateLimits: { state: 'missing' }, scanOk: true });
    for (const p of snap.providers.filter((x) => PASSIVE_IDS.includes(x.id))) {
      assert.equal(p.status, 'passive');
      assert.equal(p.connected, false);
      assert.equal(p.fiveHour, null);
      assert.equal(p.sevenDay, null);
      assert.equal(p.tokens, null);
      assert.equal(p.burnRatePerHour, null);
      // Copilot's source is a key the user adds, so its "Add" opens the key
      // window ('add-api-key'); the other two are simply not on this machine.
      assert.equal(p.setupAction.kind, p.id === 'copilot' ? 'add-api-key' : 'not-installed', p.id);
      assert.equal(p.planLabel, null);
    }
  });

  test('a wired provider with no capture is passive, and still shows no numbers', () => {
    // The difference between "we cannot collect this tool" and "we can, but
    // nobody has installed the hook yet" is the setup action offered, and
    // nothing else. Neither state may put a figure on screen.
    const snap = buildSnapshot({ now: NOW, events: [ev({ output: 100 })], rateLimits: { state: 'missing' }, scanOk: true });
    const ag = snap.providers.find((p) => p.id === 'antigravity');
    assert.equal(ag.status, 'passive');
    assert.equal(ag.connected, false);
    assert.equal(ag.setupAction.kind, 'install-bridge');
    assert.equal(ag.fiveHour.certainty, 'unknown');
    assert.equal(ag.sevenDay.certainty, 'unknown');
    assert.equal(ag.fiveHour.usedPercentage, null);
    assert.equal(ag.sevenDay.usedPercentage, null);
    // Claude's transcripts are on this machine and Antigravity's are not. A
    // token count borrowed from the neighbouring row would be a lie about
    // whose usage it is.
    assert.equal(ag.tokens, null);
    assert.equal(ag.burnRatePerHour, null);
    assert.equal(ag.weeklyCost, null);
    assert.equal(ag.lastGoodAt, null);
  });

  test('accents match the brand list', () => {
    const snap = buildSnapshot({ now: NOW, events: [], rateLimits: { state: 'missing' }, scanOk: true });
    const accents = Object.fromEntries(snap.providers.map((p) => [p.id, p.accent]));
    assert.deepEqual(accents, {
      claude: '#C96442',
      codex: '#10A37F',
      gemini: '#4386F5',
      copilot: '#8B5CF6',
      antigravity: '#E8B84B',
      kimi: '#2B6BE8',
    });
  });

  test('planLabel is null unless app settings supplied one; never inferred', () => {
    // A billion output tokens is the strongest hint a plan could have, and it
    // still produces nothing: the plan is not derived from usage volume.
    const a = claude(buildSnapshot({ now: NOW, events: [ev({ output: 1e9 })], rateLimits: { state: 'missing' }, scanOk: true }));
    assert.equal(a.planLabel, null);
    const b = claude(buildSnapshot({
      now: NOW, events: [], rateLimits: { state: 'missing' }, scanOk: true,
      planLabels: { claude: 'Max 20x' },
    }));
    assert.equal(b.planLabel, 'Max 20x');
  });

  test('generatedAt is an ISO instant', () => {
    const snap = buildSnapshot({ now: NOW, events: [], rateLimits: { state: 'missing' }, scanOk: true });
    assert.equal(snap.generatedAt, '2026-09-08T12:00:00.000Z');
  });

  test('loadingSnapshot never carries a percentage', () => {
    const snap = loadingSnapshot(NOW);
    assert.equal(claude(snap).status, 'loading');
    assert.equal(claude(snap).fiveHour.usedPercentage, null);
  });

  test('a failed scan is surfaced as an error code, not as a wrong number', () => {
    const file = path.join(tmpdir(), 'rl.json');
    fs.writeFileSync(file, JSON.stringify({
      capturedAt: new Date(NOW).toISOString(),
      present: true,
      fiveHour: { usedPercentage: 6, resetsAt: (NOW + HOUR) / 1000 },
      sevenDay: null,
    }));
    const rl = readClaudeRateLimits({ file, now: NOW });
    const c = claude(buildSnapshot({ now: NOW, events: [], rateLimits: rl, scanOk: false }));
    assert.equal(c.status, 'error');
    assert.equal(c.errorCode, 'TRANSCRIPT_SCAN_FAILED');
    assert.equal(c.fiveHour.usedPercentage, 6, 'server truth survives a local scan failure');
  });
});

test.describe('ADR-001 amendment 2 — a stale capture survives until its window resets', () => {
  const CAPTURED = Date.parse('2026-09-08T09:00:00.000Z');
  const STALE_NOW = CAPTURED + 3 * HOUR;          // capture is 3h old
  const FRESH_NOW = CAPTURED + 5 * 60 * 1000;     // capture is 5min old

  function captureFile(opts) {
    const file = path.join(tmpdir(), 'claude-rate-limits.json');
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      capturedAt: new Date(CAPTURED).toISOString(),
      present: true,
      fiveHour: { usedPercentage: 6, resetsAt: opts.fiveResetsAt / 1000 },
      sevenDay: { usedPercentage: 10, resetsAt: opts.sevenResetsAt / 1000 },
    }));
    return file;
  }

  function build(now, opts = {}) {
    const file = captureFile({
      fiveResetsAt: opts.fiveResetsAt ?? (CAPTURED + 4 * HOUR),
      sevenResetsAt: opts.sevenResetsAt ?? (CAPTURED + 5 * 24 * HOUR),
    });
    const rl = readClaudeRateLimits({ file, now });
    return claude(buildSnapshot({
      now, events: opts.events || [], rateLimits: rl, scanOk: true, scanGoodAtMs: now,
    }));
  }

  test('state 1 — a fresh capture is exact, with no delta attached', () => {
    const c = build(FRESH_NOW);
    assert.equal(c.status, 'ok');
    assert.equal(c.fiveHour.certainty, 'known');
    assert.equal(c.fiveHour.usedPercentage, 6);
    assert.equal(c.fiveHour.capturedAt, new Date(CAPTURED).toISOString());
    assert.equal(c.fiveHour.billableSinceCapture, null, 'a fresh figure needs no caveat');
  });

  test('state 2 — an old capture whose window has NOT reset is still shown', () => {
    // now = CAPTURED + 3h; the 5h window resets at CAPTURED + 4h.
    const c = build(STALE_NOW);
    assert.equal(c.fiveHour.certainty, 'known', 'the window has not rolled over, so the figure is still true');
    assert.equal(c.fiveHour.usedPercentage, 6);
    assert.equal(c.status, 'stale', 'dimmed and labelled "as of", not hidden');
    assert.equal(c.connected, true);
    assert.equal(c.fiveHour.capturedAt, new Date(CAPTURED).toISOString());
  });

  test('state 2 — the optimistic bias is answered with a measured floor, not a new percentage', () => {
    const events = [
      ev({ ts: CAPTURED - 60 * 1000, key: 'beforeCapture', output: 500000 }),
      ev({ ts: CAPTURED, key: 'atCapture', output: 1000 }),
      ev({ ts: CAPTURED + HOUR, key: 'afterCapture', output: 2000, cacheWrite: 500, cacheRead: 900000000 }),
      ev({ ts: STALE_NOW + HOUR, key: 'future', output: 777 }),
    ];
    const c = build(STALE_NOW, { events });
    // [capturedAt, now): atCapture + afterCapture. cacheRead excluded.
    assert.equal(c.fiveHour.billableSinceCapture, 1000 + 2000 + 500);
    assert.equal(c.fiveHour.usedPercentage, 6, 'the percentage is never recomputed from the delta');
    assert.equal(c.sevenDay.billableSinceCapture, 3500, 'both windows share the one capture instant');
  });

  test('state 3 — once the window resets the figure is provably wrong and disappears', () => {
    // The 5h window reset an hour ago; the 7d window has not.
    const c = build(STALE_NOW, { fiveResetsAt: CAPTURED + 2 * HOUR });
    assert.equal(c.fiveHour.certainty, 'unknown');
    assert.equal(c.fiveHour.usedPercentage, null);
    assert.equal(c.fiveHour.resetsAt, null);
    assert.equal(c.fiveHour.billableSinceCapture, null);
    assert.equal(c.sevenDay.certainty, 'known', 'the 7d window is decided independently');
    assert.equal(c.sevenDay.usedPercentage, 10);
  });

  test('state 3 — a capture with no resetsAt at all cannot be aged, so it is dropped', () => {
    const file = path.join(tmpdir(), 'rl.json');
    fs.writeFileSync(file, JSON.stringify({
      capturedAt: new Date(CAPTURED).toISOString(),
      present: true,
      fiveHour: { usedPercentage: 6, resetsAt: null },
      sevenDay: null,
    }));
    const rl = readClaudeRateLimits({ file, now: STALE_NOW });
    const c = claude(buildSnapshot({ now: STALE_NOW, events: [], rateLimits: rl, scanOk: true }));
    assert.equal(c.fiveHour.certainty, 'unknown');
  });

  test('a stale capture still anchors the token window to the real reset instant', () => {
    const fiveResetsAt = CAPTURED + 4 * HOUR;
    const events = [
      ev({ ts: fiveResetsAt - 5 * HOUR - 1, key: 'previousWindow', output: 900000 }),
      ev({ ts: fiveResetsAt - 5 * HOUR, key: 'firstOfWindow', output: 40 }),
      ev({ ts: STALE_NOW, key: 'now', output: 60 }),
    ];
    const c = build(STALE_NOW, { events });
    assert.equal(c.tokens.billable, 100, 'the previous window must not leak in');
  });

  test('the freshness budget is a boundary for the label, not a cliff for the figure', () => {
    const justOver = CAPTURED + 30 * 60 * 1000 + 1000;
    const c = build(justOver);
    assert.equal(c.status, 'stale');
    assert.equal(c.fiveHour.usedPercentage, 6, 'one second past the budget must not blank the meter');
  });
});

test.describe('lastGoodAt is per row, not snapshot-wide', () => {
  const CAPTURED = Date.parse('2026-09-08T09:00:00.000Z');
  const NOW2 = CAPTURED + 2 * HOUR;

  function staleCapture() {
    const file = path.join(tmpdir(), 'rl.json');
    fs.writeFileSync(file, JSON.stringify({
      capturedAt: new Date(CAPTURED).toISOString(),
      present: true,
      fiveHour: { usedPercentage: 6, resetsAt: (CAPTURED + 4 * HOUR) / 1000 },
      sevenDay: { usedPercentage: 10, resetsAt: (CAPTURED + 5 * 24 * HOUR) / 1000 },
    }));
    return readClaudeRateLimits({ file, now: NOW2 });
  }

  test('a row is only as fresh as its stalest component', () => {
    // The scan succeeded this instant, but the percentage is two hours old.
    // Reporting the scan time would let the row claim it updated "simdi".
    const c = claude(buildSnapshot({
      now: NOW2, events: [], rateLimits: staleCapture(), scanOk: true, scanGoodAtMs: NOW2,
    }));
    assert.equal(c.lastGoodAt, new Date(CAPTURED).toISOString());
    assert.notEqual(c.lastGoodAt, new Date(NOW2).toISOString());
  });

  test('a stale scan with a fresh capture reports the scan time', () => {
    const file = path.join(tmpdir(), 'rl.json');
    fs.writeFileSync(file, JSON.stringify({
      capturedAt: new Date(NOW2).toISOString(),
      present: true,
      fiveHour: { usedPercentage: 6, resetsAt: (NOW2 + HOUR) / 1000 },
      sevenDay: null,
    }));
    const rl = readClaudeRateLimits({ file, now: NOW2 });
    const staleScanAt = NOW2 - 6 * HOUR;
    const c = claude(buildSnapshot({
      now: NOW2, events: [], rateLimits: rl, scanOk: true, scanGoodAtMs: staleScanAt,
    }));
    assert.equal(c.lastGoodAt, new Date(staleScanAt).toISOString());
  });

  test('with no bridge installed the row is aged by the scan alone', () => {
    const rl = readClaudeRateLimits({ file: path.join(tmpdir(), 'nope.json'), now: NOW2 });
    const c = claude(buildSnapshot({
      now: NOW2, events: [], rateLimits: rl, scanOk: true, scanGoodAtMs: NOW2,
    }));
    assert.equal(c.lastGoodAt, new Date(NOW2).toISOString());
  });

  test('the five passive rows report null, never a borrowed generatedAt', () => {
    const snap = buildSnapshot({
      now: NOW2, events: [], rateLimits: staleCapture(), scanOk: true, scanGoodAtMs: NOW2,
    });
    for (const p of snap.providers.filter((x) => x.id !== 'claude')) {
      assert.equal(p.lastGoodAt, null, `${p.id} must not imply it was ever updated`);
    }
  });

  test('a cold start reports when the store was written, not now', () => {
    const builtAt = NOW2 - 30 * HOUR;
    const rl = readClaudeRateLimits({ file: path.join(tmpdir(), 'nope.json'), now: NOW2 });
    const c = claude(buildSnapshot({
      now: NOW2, events: [], rateLimits: rl, scanOk: true, scanGoodAtMs: builtAt,
    }));
    assert.equal(c.lastGoodAt, new Date(builtAt).toISOString());
  });
});

test.describe('billableSinceCapture shares TokenBreakdown.billable basis', () => {
  const CAPTURED = Date.parse('2026-09-08T09:00:00.000Z');
  const NOW3 = CAPTURED + 2 * HOUR;

  function staleRl(fiveResetsAt) {
    const file = path.join(tmpdir(), 'rl.json');
    fs.writeFileSync(file, JSON.stringify({
      capturedAt: new Date(CAPTURED).toISOString(),
      present: true,
      fiveHour: { usedPercentage: 6, resetsAt: (fiveResetsAt ?? (CAPTURED + 6 * HOUR)) / 1000 },
      sevenDay: { usedPercentage: 10, resetsAt: (CAPTURED + 5 * 24 * HOUR) / 1000 },
    }));
    return readClaudeRateLimits({ file, now: NOW3 });
  }

  test('it is input + output + cacheWrite, and excludes cacheRead', () => {
    const events = [
      ev({ ts: CAPTURED + HOUR, key: 'a', input: 7, output: 11, cacheWrite: 13, cacheRead: 999999999 }),
    ];
    const c = claude(buildSnapshot({ now: NOW3, events, rateLimits: staleRl(), scanOk: true }));
    assert.equal(c.fiveHour.billableSinceCapture, 7 + 11 + 13);
  });

  test('a pure cache-read burst since the capture adds nothing, exactly like tokens.billable', () => {
    const events = [ev({ ts: CAPTURED + HOUR, key: 'cacheOnly', cacheRead: 2400000000 })];
    const c = claude(buildSnapshot({ now: NOW3, events, rateLimits: staleRl(), scanOk: true }));
    assert.equal(c.fiveHour.billableSinceCapture, 0);
  });

  test('when the whole window sits after the capture the two figures are identical', () => {
    // Anchor the 5h window so it starts exactly at the capture instant: the
    // row token figure and the delta then cover the same events, which is the
    // strongest possible check that they share a basis.
    const fiveResetsAt = CAPTURED + 5 * HOUR;
    const events = [
      ev({ ts: CAPTURED, key: 'x', input: 1, output: 2, cacheWrite: 4, cacheRead: 800 }),
      ev({ ts: CAPTURED + HOUR, key: 'y', input: 8, output: 16, cacheWrite: 32, cacheRead: 900 }),
    ];
    const c = claude(buildSnapshot({ now: NOW3, events, rateLimits: staleRl(fiveResetsAt), scanOk: true }));
    assert.equal(c.tokens.billable, 63);
    assert.equal(c.fiveHour.billableSinceCapture, 63, 'same basis, so the renderer can print them side by side');
  });

  test('the delta is a plain token count, never a percentage', () => {
    const events = [ev({ ts: CAPTURED + HOUR, key: 'a', output: 5000000 })];
    const c = claude(buildSnapshot({ now: NOW3, events, rateLimits: staleRl(), scanOk: true }));
    assert.equal(c.fiveHour.billableSinceCapture, 5000000);
    assert.ok(c.fiveHour.billableSinceCapture > 100, 'not clamped into a 0-100 range');
    assert.equal(c.fiveHour.usedPercentage, 6, 'and the percentage is untouched by it');
  });

  test('events before the capture are excluded from the delta', () => {
    const events = [
      ev({ ts: CAPTURED - 1, key: 'before', output: 1000000 }),
      ev({ ts: CAPTURED, key: 'at', output: 5 }),
    ];
    const c = claude(buildSnapshot({ now: NOW3, events, rateLimits: staleRl(), scanOk: true }));
    assert.equal(c.fiveHour.billableSinceCapture, 5, 'half-open [capturedAt, now)');
  });
});

/**
 * `ProviderSnapshot.weeklyTokens` — the row's headline token figure.
 *
 * The one property that matters and that nothing else enforces: it covers
 * EXACTLY the window `sevenDay` describes and `weeklyCost` is priced over. The
 * figure is read beside the 7-day percentage, so a window even slightly
 * different would pair a count with a percentage describing two different
 * weeks. Every assertion below is about that identity, about the half-open
 * bounds, or about a row that must stay silent.
 */
test.describe('weeklyTokens covers exactly the sevenDay window', () => {
  const DAY = 24 * HOUR;

  /** A fresh capture whose weekly reset is `sevenResetsAtMs` (null = none). */
  function rl(sevenResetsAtMs) {
    return {
      state: 'fresh',
      capturedAtMs: NOW,
      fiveHour: { usedPercentage: 5, resetsAtMs: NOW + HOUR },
      sevenDay: { usedPercentage: 10, resetsAtMs: sevenResetsAtMs },
    };
  }

  test('anchored: the window is [resetsAt - 7d, resetsAt), half-open at both ends', () => {
    const resetsAt = NOW + 2 * DAY;
    const start = resetsAt - 7 * DAY;
    const events = [
      ev({ ts: start - 1, key: 'justBefore', output: 1_000_000 }),
      ev({ ts: start, key: 'atStart', output: 7 }),
      ev({ ts: NOW - HOUR, key: 'inside', output: 11 }),
    ];
    const c = claude(buildSnapshot({ now: NOW, events, rateLimits: rl(resetsAt), scanOk: true }));
    assert.equal(c.weeklyTokens.output, 18, 'start is inclusive, the ms before it is not');
    assert.equal(c.weeklyTokens.billable, 18);
  });

  test('anchored: it is the SAME window the weekly cost block reports', () => {
    const resetsAt = NOW + 2 * DAY;
    const events = [ev({ ts: NOW - 3 * DAY, key: 'a', input: 5, output: 9, cacheWrite: 3, cacheRead: 77 })];
    const c = claude(buildSnapshot({ now: NOW, events, rateLimits: rl(resetsAt), scanOk: true }));
    assert.equal(c.weeklyCost.windowAnchored, true);
    assert.equal(c.weeklyCost.windowStart, new Date(resetsAt - 7 * DAY).toISOString());
    assert.equal(c.weeklyCost.windowEnd, new Date(resetsAt).toISOString());
    // The cost's own per-model token rows are folded over that same window, so
    // the two figures cannot be describing different events.
    const priced = c.weeklyCost.byModel.reduce((n, m) => n + m.tokens.billable, 0);
    assert.equal(c.weeklyTokens.billable, priced);
  });

  test('rolling: with no weekly reset the window is a trailing 7 days', () => {
    const events = [
      ev({ ts: NOW - 7 * DAY - 1, key: 'tooOld', output: 1_000_000 }),
      ev({ ts: NOW - 7 * DAY, key: 'atStart', output: 4 }),
      ev({ ts: NOW - DAY, key: 'inside', output: 6 }),
    ];
    const c = claude(buildSnapshot({ now: NOW, events, rateLimits: rl(null), scanOk: true }));
    assert.equal(c.weeklyCost.windowAnchored, false, 'no anchor, so the block says trailing');
    assert.equal(c.weeklyTokens.output, 10);
  });

  test('a reset already behind us is NOT anchored to: the dead window would exclude everything since', () => {
    const resetsAt = NOW - HOUR; // rolled over
    const events = [ev({ ts: NOW - 30 * 60 * 1000, key: 'sinceReset', output: 500 })];
    const c = claude(buildSnapshot({ now: NOW, events, rateLimits: rl(resetsAt), scanOk: true }));
    assert.equal(c.weeklyCost.windowAnchored, false, 'the dead reset is not anchored to');
    assert.equal(c.weeklyCost.windowEnd, new Date(NOW).toISOString(), 'trailing, ending now');
    assert.equal(c.weeklyTokens.output, 500, 'so usage since the reset is still counted');
  });

  test('it is the WEEK, not the five hours: the two figures differ and both are present', () => {
    const events = [
      ev({ ts: NOW - 4 * DAY, key: 'old', output: 1000 }),
      ev({ ts: NOW - 30 * 60 * 1000, key: 'recent', output: 7 }),
    ];
    const c = claude(buildSnapshot({ now: NOW, events, rateLimits: rl(null), scanOk: true }));
    assert.equal(c.tokens.billable, 7, 'the 5-hour breakdown is untouched');
    assert.equal(c.weeklyTokens.billable, 1007);
  });

  test('cacheRead is excluded from billable here exactly as it is in tokens', () => {
    const events = [ev({ ts: NOW - DAY, key: 'a', input: 7, output: 11, cacheWrite: 13, cacheRead: 2_400_000_000 })];
    const c = claude(buildSnapshot({ now: NOW, events, rateLimits: rl(null), scanOk: true }));
    assert.equal(c.weeklyTokens.billable, 31);
    assert.equal(c.weeklyTokens.cacheRead, 2_400_000_000, 'reported, never folded in');
  });

  test('when a cost block exists the two window labels agree, because one window produced both', () => {
    const anchored = claude(buildSnapshot({
      now: NOW, events: [ev({ ts: NOW - DAY, key: 'a', output: 1000 })],
      rateLimits: rl(NOW + 2 * DAY), scanOk: true,
    }));
    assert.equal(anchored.weeklyTokensWindowAnchored, true);
    assert.equal(anchored.weeklyCost.windowAnchored, anchored.weeklyTokensWindowAnchored);

    const trailing = claude(buildSnapshot({
      now: NOW, events: [ev({ ts: NOW - DAY, key: 'a', output: 1000 })],
      rateLimits: rl(null), scanOk: true,
    }));
    assert.equal(trailing.weeklyTokensWindowAnchored, false);
    assert.equal(trailing.weeklyCost.windowAnchored, trailing.weeklyTokensWindowAnchored);
  });

  test('no local corpus means no figure: every such row is null on both windows', () => {
    const s = buildSnapshot({ now: NOW, events: [], rateLimits: rl(null), scanOk: true });
    for (const p of s.providers) {
      if (p.id === 'claude') continue;
      assert.equal(p.weeklyTokens, null, `${p.id} has no local corpus here`);
      assert.equal(p.tokens, null, `${p.id}: the pair is null together`);
    }
    for (const p of loadingSnapshot(NOW).providers) {
      assert.equal(p.weeklyTokens, null, `${p.id}: nothing scanned yet is not a zero week`);
    }
  });
});

/**
 * `ProviderSnapshot.weeklyTokenFloorCauses`.
 *
 * The flag exists so that no surface has to carry a provider-specific honesty
 * rule. What these tests pin is the line it draws: SOURCE behaviour sets it
 * (something was not recorded, or could not be read); PRICE never does.
 */
test.describe('weeklyTokenFloorCauses separates a missing count from a missing price', () => {
  const DAY = 24 * HOUR;
  const range = (fromMs, throughMs) => ({ fromMs, throughMs });
  const rl = {
    state: 'fresh',
    capturedAtMs: NOW,
    fiveHour: { usedPercentage: 5, resetsAtMs: NOW + HOUR },
    sevenDay: { usedPercentage: 10, resetsAtMs: null },
  };
  const build = (extra) => claude(buildSnapshot({
    now: NOW, events: [ev({ ts: NOW - DAY, key: 'a', output: 1000 })], rateLimits: rl, scanOk: true, ...extra,
  }));

  test('a known-unread range inside the week names its cause (A3.16: never a bare floor)', () => {
    const c = build({ scanUnreadRange: range(NOW - 2 * DAY, NOW - DAY) });
    assert.equal(c.weeklyCost.sourceIncomplete, true);
    assert.deepEqual(c.weeklyTokenFloorCauses, ['unread-range'], 'events are missing from the count itself');
  });

  test('an unread range OUTSIDE the week does not', () => {
    const c = build({ scanUnreadRange: range(NOW - 20 * DAY, NOW - 19 * DAY) });
    assert.deepEqual(c.weeklyTokenFloorCauses, []);
  });

  test('a fully read week is exact', () => {
    assert.deepEqual(build({}).weeklyTokenFloorCauses, []);
  });

  test('an UNPRICED model makes the cost a floor and leaves the count exact', () => {
    const c = build({ events: [ev({ ts: NOW - DAY, key: 'x', model: 'claude-not-a-real-model', output: 1000 })] });
    assert.deepEqual(c.weeklyCost.unpricedModels, ['claude-not-a-real-model']);
    assert.equal(c.weeklyTokens.output, 1000, 'the tokens were counted all the same');
    assert.deepEqual(c.weeklyTokenFloorCauses, [], 'no published price is not a missing token');
  });

  test("Claude's cache-write TTL fallback prices at a floor but loses no write token", () => {
    // cw5 + cw1h = 0 against a non-zero total: the TTL split is absent, so the
    // writes are priced at 1.25x (a cost floor) while every token is counted.
    const c = build({ events: [ev({ ts: NOW - DAY, key: 'ttl', output: 10, cacheWrite: 4000, cw5: 0, cw1h: 0 })] });
    assert.ok(c.weeklyCost.fallbackWriteEvents > 0, 'the cost really is on the fallback path');
    assert.equal(c.weeklyTokens.cacheWrite, 4000, 'and the write tokens are all there');
    assert.deepEqual(c.weeklyTokenFloorCauses, []);
  });

  test('a row with no figure is never a floor — there is no bound without an amount', () => {
    const s = buildSnapshot({ now: NOW, events: [], rateLimits: rl, scanOk: true });
    for (const p of s.providers) {
      if (p.weeklyTokens === null) assert.deepEqual(p.weeklyTokenFloorCauses, [], p.id);
    }
    for (const p of loadingSnapshot(NOW).providers) assert.deepEqual(p.weeklyTokenFloorCauses, [], p.id);
  });

  test('a zero count is never a floor either, even with a known-unread range (A3.19)', () => {
    // Claude's figure is present-but-zero here. "sayilamadi" is that state's own
    // sentence, driven by sourceIncomplete; it must never read "en az 0".
    const c = claude(buildSnapshot({
      now: NOW, events: [], rateLimits: rl, scanOk: true,
      scanUnreadRange: range(NOW - 2 * DAY, NOW - DAY),
    }));
    assert.equal(c.weeklyTokens.billable, 0, 'present, and a measured zero');
    assert.equal(c.weeklyCost.sourceIncomplete, true, 'the A3.19 signal is the one to read');
    assert.deepEqual(c.weeklyTokenFloorCauses, [], 'no amount, so nothing for a cause to qualify');
  });

  test('every row declares the causes as an array, on both snapshot kinds', () => {
    for (const s of [buildSnapshot({ now: NOW, events: [], rateLimits: rl, scanOk: true }), loadingSnapshot(NOW)]) {
      for (const p of s.providers) assert.ok(Array.isArray(p.weeklyTokenFloorCauses), p.id);
    }
  });

  test('weeklyTokensWindowAnchored is null exactly when there is no count, on both snapshot kinds', () => {
    for (const s of [buildSnapshot({ now: NOW, events: [], rateLimits: rl, scanOk: true }), loadingSnapshot(NOW)]) {
      for (const p of s.providers) {
        assert.equal(
          p.weeklyTokensWindowAnchored === null, p.weeklyTokens === null,
          `${p.id}: the label must be present exactly when the figure is`,
        );
        if (p.weeklyTokens !== null) assert.equal(typeof p.weeklyTokensWindowAnchored, 'boolean', p.id);
      }
    }
  });

});

/**
 * The state a user is most likely to see and least likely to forgive: the first
 * minutes after a WEEKLY quota reset.
 *
 * Claude Code then reports a reset seven days ahead, so the anchored window is
 * `[resetsAt - 7d, resetsAt)` = roughly `[now, now + 7d)`. Usage from three
 * hours ago falls OUTSIDE it, and the weekly count is legitimately zero while
 * the five-hour meter still shows real consumption. Under the old
 * "all-zero reads as absent" rule that state printed "could not be counted" —
 * a false claim about our own successful reading, next to a five-hour figure
 * visibly contradicting it.
 */
test.describe('just after a weekly reset, a zero week is a measurement and says so', () => {
  const DAY = 24 * HOUR;
  const justReset = {
    state: 'fresh',
    capturedAtMs: NOW,
    // The 5-hour window is still mid-flight; only the weekly one rolled over.
    fiveHour: { usedPercentage: 40, resetsAtMs: NOW + 2 * HOUR },
    sevenDay: { usedPercentage: 0, resetsAtMs: NOW + 7 * DAY },
  };
  // Three hours ago: inside the five-hour window, outside the fresh quota week.
  const events = [ev({ ts: NOW - 3 * HOUR, key: 'recent', input: 10, output: 900, cacheWrite: 90, cacheRead: 50000 })];

  test('the weekly count is PRESENT and zero, and carries no floor cause', () => {
    const c = claude(buildSnapshot({ now: NOW, events, rateLimits: justReset, scanOk: true }));
    assert.notEqual(c.weeklyTokens, null, 'never "we did not look" — we looked, and the new week is empty');
    assert.deepEqual(c.weeklyTokens, { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, billable: 0 });
    assert.deepEqual(c.weeklyTokenFloorCauses, [], 'nothing is missing; the window simply just opened');
  });

  test('the window really is the fresh one, so the zero is not an accident of the fixture', () => {
    // Proved without reading weeklyCost, which is null in this state (below):
    // an event exactly ON the new reset instant IS counted, the one three hours
    // before it is not. That is the half-open window opening at `now`.
    const c = claude(buildSnapshot({
      now: NOW, rateLimits: justReset, scanOk: true,
      events: [...events, ev({ ts: NOW, key: 'atOpen', output: 5 })],
    }));
    assert.equal(c.weeklyTokens.output, 5, 'start inclusive, and the older turn is outside');
    assert.equal(c.weeklyCost.windowAnchored, true);
    assert.equal(c.weeklyCost.windowStart, new Date(NOW).toISOString(), 'the week opens at now');
    assert.equal(c.weeklyCost.windowEnd, new Date(NOW + 7 * DAY).toISOString());
  });

  test('WHY weeklyTokensWindowAnchored exists: here the count is present and weeklyCost is NOT', () => {
    // This is the state the field was added for. Nothing priced, so there is no
    // cost block to take a window label from - and an unlabelled "0 token" beside
    // a five-hour figure reads as "nothing in the last five hours".
    const c = claude(buildSnapshot({ now: NOW, events, rateLimits: justReset, scanOk: true }));
    assert.notEqual(c.weeklyTokens, null, 'the count is present');
    assert.equal(c.weeklyCost, null, 'and there is no cost block to read a label off');
    assert.equal(c.weeklyTokensWindowAnchored, true, 'so the row states the window itself');

    // The label must still not be RE-DERIVED from sevenDay.resetsAt. Measured
    // below: the two facts coincide on every reachable state today, so the
    // derivation would happen to be right - but only because windowFrom nulls a
    // ROLLED-OVER window, which is a rule about displaying a PERCENTAGE
    // (ADR-001 Amd 2 state 3), not about the token window. Two independent rules
    // that agree. This assertion is the tripwire: if either moves, it fails here
    // instead of silently inverting a label in the panel.
    const rolledOver = claude(buildSnapshot({
      now: NOW, events: [], rateLimits: {
        state: 'fresh', capturedAtMs: NOW,
        fiveHour: { usedPercentage: 1, resetsAtMs: NOW + HOUR },
        sevenDay: { usedPercentage: 90, resetsAtMs: NOW - HOUR },
      }, scanOk: true,
    }));
    assert.equal(rolledOver.sevenDay.resetsAt, null, 'a rolled-over window publishes no reset');
    assert.equal(rolledOver.weeklyTokensWindowAnchored, false, 'and the token window is trailing');

    // A3.19 is unaffected: whenever the source IS known incomplete, main
    // synthesizes an empty cost, so `sourceIncomplete` is always readable when true.
    const incomplete = claude(buildSnapshot({
      now: NOW, events, rateLimits: justReset, scanOk: true,
      scanUnreadRange: { fromMs: NOW + HOUR, throughMs: NOW + 2 * HOUR },
    }));
    assert.equal(incomplete.weeklyCost.sourceIncomplete, true);
  });

  test('the five-hour figure still shows the usage, and the two do not contradict', () => {
    const c = claude(buildSnapshot({ now: NOW, events, rateLimits: justReset, scanOk: true }));
    assert.equal(c.tokens.billable, 1000, 'the 5-hour window still contains the turn');
    assert.equal(c.weeklyTokens.billable, 0);
    // The pairing the user reads: 0% of the weekly quota, 0 tokens in that week.
    assert.equal(c.sevenDay.usedPercentage, 0, 'and the percentage beside it agrees');
    assert.equal(c.fiveHour.usedPercentage, 40);
  });

  test('a genuinely unread week is still distinguishable from this one', () => {
    // Same zero count, but the scan KNOWS it missed events: that is the A3.19
    // "could not be counted" state, and `sourceIncomplete` is what says so.
    const c = claude(buildSnapshot({
      now: NOW, events, rateLimits: justReset, scanOk: true,
      scanUnreadRange: { fromMs: NOW + HOUR, throughMs: NOW + 2 * HOUR },
    }));
    assert.equal(c.weeklyTokens.billable, 0);
    assert.equal(c.weeklyCost.sourceIncomplete, true, 'the one signal that separates the two states');
    assert.deepEqual(c.weeklyTokenFloorCauses, [], 'still not "en az 0"');
  });

  test('every local-log row reads the same way just after its own reset', () => {
    // Codex anchors to its OWN weekly reset; Gemini and Kimi never anchor.
    const s = buildSnapshot({
      now: NOW, events, rateLimits: justReset, scanOk: true,
      codexEvents: [{ ts: NOW - 3 * HOUR, model: 'gpt-5.6-sol', tier: 'standard', inputUncached: 10, cachedInput: 0, cacheWrite: 0, output: 20 }],
      codexRateLimits: {
        state: 'fresh', capturedAtMs: NOW,
        fiveHour: { usedPercentage: 5, resetsAtMs: NOW + 2 * HOUR },
        sevenDay: { usedPercentage: 0, resetsAtMs: NOW + 7 * DAY },
      },
    });
    const cx = s.providers.find((p) => p.id === 'codex');
    assert.notEqual(cx.weeklyTokens, null, 'scanned, so present');
    assert.equal(cx.weeklyTokens.billable, 0, 'and the fresh quota week is empty');
    assert.deepEqual(cx.weeklyTokenFloorCauses, [], 'no write pattern can fire on zero events');
  });
});

/**
 * A stored Copilot key IS that row's source (the key-backed passive row). With
 * it, "not supported yet" and "Add" would contradict the credits the key just
 * read, so the setup offer goes; the row counts as connected once a reading
 * exists; and it stays 'passive' because GitHub reports monthly AI credits, not
 * a five-hour or weekly window.
 */
test.describe('copilot row with an optional key', () => {
  const USAGE = {
    grossCredits: 1234, includedCredits: 900, billedCredits: 334,
    periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-09-30T23:59:59.000Z',
    fetchedAt: '2026-09-08T11:48:00.000Z',
  };
  const copilotWith = (keys) =>
    buildSnapshot({ now: NOW, events: [], scanOk: true, keys }).providers.find((p) => p.id === 'copilot');

  test.it('no key stored: the row is exactly the unsupported passive row, with its offer', () => {
    const row = copilotWith(undefined);
    assert.equal(row.keyCapable, true);
    assert.equal(row.keyState, 'none');
    assert.equal(row.status, 'passive');
    assert.equal(row.connected, false);
    assert.ok(row.setupAction && typeof row.setupAction.label === 'string');
  });

  test.it('a key with a reading: connected, no setup offer, still passive and windowless', () => {
    const row = copilotWith({ copilot: { keyState: 'stored', keyStoredAt: '2026-09-01T09:00:00.000Z', creditUsage: USAGE } });
    assert.equal(row.setupAction, null);
    assert.equal(row.connected, true);
    assert.equal(row.status, 'passive');
    assert.equal(row.fiveHour, null);
    assert.equal(row.sevenDay, null);
    assert.deepEqual(row.creditUsage, USAGE);
  });

  for (const state of ['stored', 'key-rejected', 'key-lacks-permission', 'rate-limited', 'not-available', 'unreachable', 'unreadable']) {
    test.it(`a key in state ${state} with no reading: no setup offer, not connected`, () => {
      const row = copilotWith({ copilot: { keyState: state, keyStoredAt: null, creditUsage: null } });
      assert.equal(row.keyState, state);
      assert.equal(row.setupAction, null);
      assert.equal(row.connected, false);
      assert.equal(row.status, 'passive');
    });
  }

  test.it('a reading kept through an error state still counts as connected', () => {
    const row = copilotWith({ copilot: { keyState: 'unreachable', keyStoredAt: null, creditUsage: USAGE } });
    assert.equal(row.setupAction, null);
    assert.equal(row.connected, true);
  });

  test.it('secure storage unavailable: no key can be read, so the offer stays', () => {
    const row = copilotWith({ copilot: { keyState: 'secure-storage-unavailable', keyStoredAt: null, creditUsage: null } });
    assert.ok(row.setupAction);
    assert.equal(row.connected, false);
  });

  test.it('a key entry for a provider that cannot use one changes nothing on that row', () => {
    const snap = buildSnapshot({ now: NOW, events: [], scanOk: true,
      keys: { kimi: { keyState: 'stored', keyStoredAt: null, creditUsage: USAGE } } });
    const kimi = snap.providers.find((p) => p.id === 'kimi');
    assert.equal(kimi.keyCapable, false);
    assert.equal(kimi.creditUsage, null);
    assert.equal(kimi.connected, false);
    assert.ok(kimi.setupAction);
  });
});
