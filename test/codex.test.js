'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readCodexRateLimits } = require('../src/core/codex/rollout');
const { buildSnapshot } = require('../src/core/snapshot');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-14T12:00:00.000Z');

function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));
  test.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  return dir;
}

/** Write a rollout-*.jsonl under sessions/YYYY/MM/DD, return its path. */
function writeRollout(home, { day = '2026/09/14', name = 'rollout-a.jsonl', lines }) {
  const dir = path.join(home, 'sessions', ...day.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

/** A token_count event carrying a rate_limits object. */
function tokenCount(rateLimits, ts = '2026-09-14T11:59:00.000Z') {
  return { timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: {}, rate_limits: rateLimits } };
}

/** The shape Codex's app-server writes: resets_at as epoch seconds. */
function limits(over = {}) {
  return {
    limit_id: 'codex',
    primary: { used_percent: 12, window_minutes: 300, resets_at: Math.floor((NOW + 2 * HOUR) / 1000) },
    secondary: { used_percent: 34, window_minutes: 10080, resets_at: Math.floor((NOW + 3 * DAY) / 1000) },
    plan_type: 'plus',
    ...over,
  };
}

test.describe('the codex rollout reader', () => {
  test('maps primary to the 5-hour window and secondary to the weekly one', () => {
    const home = tmpHome();
    writeRollout(home, { lines: [tokenCount(limits())] });
    const r = readCodexRateLimits({ now: NOW, home });
    assert.equal(r.state, 'fresh');
    assert.equal(r.planType, 'plus');
    assert.equal(r.fiveHour.usedPercentage, 12, 'primary (300 min) is the five-hour window');
    assert.equal(r.fiveHour.resetsAtMs, NOW + 2 * HOUR);
    assert.equal(r.sevenDay.usedPercentage, 34, 'secondary (10080 min) is the weekly window');
    assert.equal(r.sevenDay.resetsAtMs, NOW + 3 * DAY);
  });

  test('classifies by window_minutes BAND, so 299/10079 still map', () => {
    const home = tmpHome();
    writeRollout(home, { lines: [tokenCount(limits({
      primary: { used_percent: 5, window_minutes: 299, resets_at: Math.floor((NOW + HOUR) / 1000) },
      secondary: { used_percent: 6, window_minutes: 10079, resets_at: Math.floor((NOW + DAY) / 1000) },
    }))] });
    const r = readCodexRateLimits({ now: NOW, home });
    assert.equal(r.fiveHour.usedPercentage, 5);
    assert.equal(r.sevenDay.usedPercentage, 6);
  });

  test('accepts resets_in_seconds as well as resets_at', () => {
    const home = tmpHome();
    writeRollout(home, { lines: [tokenCount({
      primary: { used_percent: 7, window_minutes: 300, resets_in_seconds: 2 * HOUR / 1000 },
      secondary: { used_percent: 8, window_minutes: 10080, resets_in_seconds: 3 * DAY / 1000 },
      plan_type: 'pro',
    })] });
    const r = readCodexRateLimits({ now: NOW, home });
    assert.equal(r.fiveHour.resetsAtMs, NOW + 2 * HOUR, 'countdown resolved against now');
    assert.equal(r.sevenDay.resetsAtMs, NOW + 3 * DAY);
    assert.equal(r.planType, 'pro');
  });

  test('takes the LAST rate_limits in the file, not the first', () => {
    const home = tmpHome();
    writeRollout(home, { lines: [
      tokenCount(limits({ primary: { used_percent: 1, window_minutes: 300, resets_at: Math.floor((NOW + HOUR) / 1000) } }), '2026-09-14T10:00:00.000Z'),
      { type: 'response_item', payload: { type: 'message' } },
      tokenCount(limits({ primary: { used_percent: 88, window_minutes: 300, resets_at: Math.floor((NOW + HOUR) / 1000) } }), '2026-09-14T11:59:00.000Z'),
    ] });
    const r = readCodexRateLimits({ now: NOW, home });
    assert.equal(r.fiveHour.usedPercentage, 88, 'the most recent turn wins');
  });

  test('a used_percent outside 0..100 is dropped, never shown', () => {
    const home = tmpHome();
    writeRollout(home, { lines: [tokenCount(limits({
      primary: { used_percent: 140, window_minutes: 300, resets_at: Math.floor((NOW + HOUR) / 1000) },
      secondary: { used_percent: 20, window_minutes: 10080, resets_at: Math.floor((NOW + DAY) / 1000) },
    }))] });
    const r = readCodexRateLimits({ now: NOW, home });
    assert.equal(r.fiveHour, null, 'the impossible figure is refused');
    assert.equal(r.sevenDay.usedPercentage, 20, 'the good one survives');
  });

  test('a reset instant far outside the window keeps the figure but nulls the countdown', () => {
    const home = tmpHome();
    writeRollout(home, { lines: [tokenCount(limits({
      primary: { used_percent: 50, window_minutes: 300, resets_at: Math.floor((NOW + 30 * DAY) / 1000) },
    }))] });
    const r = readCodexRateLimits({ now: NOW, home });
    assert.equal(r.fiveHour.usedPercentage, 50);
    assert.equal(r.fiveHour.resetsAtMs, null, '30 days out is not a credible five-hour reset');
  });

  test('no sessions directory reads as `missing`, not an error', () => {
    const r = readCodexRateLimits({ now: NOW, home: tmpHome() });
    assert.equal(r.state, 'missing');
    assert.equal(r.fiveHour, null);
    assert.equal(r.sevenDay, null);
  });

  test('a rollout with no rate_limits reads as `absent`', () => {
    const home = tmpHome();
    writeRollout(home, { lines: [{ type: 'response_item', payload: { type: 'message' } }] });
    assert.equal(readCodexRateLimits({ now: NOW, home }).state, 'absent');
  });

  test('a capture past the freshness budget is `stale`', () => {
    const home = tmpHome();
    writeRollout(home, { lines: [tokenCount(limits(), '2026-09-14T10:00:00.000Z')] }); // 2h old vs NOW
    const r = readCodexRateLimits({ now: NOW, home });
    assert.equal(r.state, 'stale');
    assert.equal(r.fiveHour.usedPercentage, 12, 'the last figure is still shown, just dimmed');
  });

  test('the newest rollout by mtime wins across two files', () => {
    const home = tmpHome();
    const older = writeRollout(home, { name: 'rollout-old.jsonl', lines: [tokenCount(limits({ primary: { used_percent: 10, window_minutes: 300, resets_at: Math.floor((NOW + HOUR) / 1000) } }))] });
    const newer = writeRollout(home, { name: 'rollout-new.jsonl', lines: [tokenCount(limits({ primary: { used_percent: 77, window_minutes: 300, resets_at: Math.floor((NOW + HOUR) / 1000) } }))] });
    // Force mtimes: older strictly before newer.
    fs.utimesSync(older, new Date(NOW - HOUR), new Date(NOW - HOUR));
    fs.utimesSync(newer, new Date(NOW), new Date(NOW));
    assert.equal(readCodexRateLimits({ now: NOW, home }).fiveHour.usedPercentage, 77);
  });
});

test.describe('the codex row in the snapshot', () => {
  function codexRow(cx) {
    return buildSnapshot({
      now: NOW, events: [], rateLimits: { state: 'missing' }, scanOk: true,
      codexRateLimits: cx, enabled: { codex: true },
    }).providers.find((p) => p.id === 'codex');
  }

  test('a fresh reading is a live, connected row with both figures', () => {
    const home = tmpHome();
    writeRollout(home, { lines: [tokenCount(limits())] });
    const row = codexRow(readCodexRateLimits({ now: NOW, home }));
    assert.equal(row.connected, true);
    assert.equal(row.status, 'ok');
    assert.equal(row.setupAction, null, 'nothing to install — Codex writes its own rollout');
    assert.equal(row.fiveHour.usedPercentage, 12);
    assert.equal(row.fiveHour.source, 'codex.rate_limits.primary.used_percent');
    assert.equal(row.fiveHour.provenance, 'documented');
    assert.equal(row.sevenDay.usedPercentage, 34);
  });

  test('Codex absent from the machine is a passive row with the "not found" chip', () => {
    const row = codexRow(readCodexRateLimits({ now: NOW, home: tmpHome() }));
    assert.equal(row.connected, false);
    assert.equal(row.status, 'passive');
    assert.ok(row.setupAction);
    assert.equal(row.setupAction.kind, 'not-installed');
    assert.equal(row.fiveHour.usedPercentage, null, 'an unknown window, not an invented zero');
  });

  test('a rollout with no rate_limits yet is connected and awaiting, not "not supplied"', () => {
    const home = tmpHome();
    writeRollout(home, { lines: [{ type: 'response_item', payload: { type: 'message' } }] });
    const row = codexRow(readCodexRateLimits({ now: NOW, home }));
    assert.equal(row.connected, true);
    assert.equal(row.setupAction, null);
    assert.equal(row.fiveHour.usedPercentage, null);
    // A subscription session that has not taken a priced turn yet WILL get a
    // figure; that is "awaiting", not "this tool does not publish it".
    assert.equal(row.fiveHour.absence, 'awaiting-report');
  });

  test('a fresh reading whose only window has rolled over is dimmed, not shown healthy', () => {
    // The row must not read "ok" at the instant a limit resets. The reader
    // keeps the (past) reset within skew; the row rolls it over to a null
    // figure, and the status has to follow the content, like claude/antigravity.
    const home = tmpHome();
    writeRollout(home, { lines: [tokenCount({
      // primary reset 5 minutes AGO (still within the 6h skew, so not dropped),
      // no secondary — the sole window has expired.
      primary: { used_percent: 90, window_minutes: 300, resets_at: Math.floor((NOW - 5 * 60 * 1000) / 1000) },
      plan_type: 'plus',
    }, new Date(NOW - 60 * 1000).toISOString())] });
    const row = codexRow(readCodexRateLimits({ now: NOW, home }));
    assert.equal(row.status, 'stale', 'a rolled-over sole window dims the row');
    assert.equal(row.fiveHour.absence, 'rolled-over');
    assert.equal(row.fiveHour.usedPercentage, null, 'no stale 90% at the moment of reset');
  });
});

test.describe('codex reader — robustness', () => {
  test('the active file wins even across a month boundary', () => {
    const home = tmpHome();
    // A session still appending in last month's folder, and a fresh session in
    // the new month whose file is OLDER by mtime. The active (newer-mtime) one
    // in the previous month must still win.
    const prev = writeRollout(home, { day: '2026/08/31', name: 'rollout-prev.jsonl', lines: [tokenCount(limits({ primary: { used_percent: 55, window_minutes: 300, resets_at: Math.floor((NOW + HOUR) / 1000) } }))] });
    const curr = writeRollout(home, { day: '2026/09/01', name: 'rollout-curr.jsonl', lines: [tokenCount(limits({ primary: { used_percent: 9, window_minutes: 300, resets_at: Math.floor((NOW + HOUR) / 1000) } }))] });
    fs.utimesSync(curr, new Date(NOW - HOUR), new Date(NOW - HOUR)); // new-month file is OLDER
    fs.utimesSync(prev, new Date(NOW), new Date(NOW));               // old-month file is the active one
    assert.equal(readCodexRateLimits({ now: NOW, home }).fiveHour.usedPercentage, 55);
  });

  test('a used_percent a hair over 100 (server rounding) clamps to 100', () => {
    const home = tmpHome();
    writeRollout(home, { lines: [tokenCount(limits({
      primary: { used_percent: 100.4, window_minutes: 300, resets_at: Math.floor((NOW + HOUR) / 1000) },
    }))] });
    assert.equal(readCodexRateLimits({ now: NOW, home }).fiveHour.usedPercentage, 100);
  });
});
