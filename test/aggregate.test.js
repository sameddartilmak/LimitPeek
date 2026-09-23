'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const agg = require('../src/core/aggregate');

const HOUR = 60 * 60 * 1000;

function ev(over) {
  return {
    f: 'file1',
    ts: 0,
    model: 'claude-opus-5',
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
    key: 'k',
    ...over,
  };
}

test('billable excludes cacheRead', () => {
  const e = ev({ input: 10, output: 20, cacheWrite: 30, cacheRead: 900000 });
  assert.equal(agg.billableOf(e), 60);
});

test('billable of a pure cache-read record is zero', () => {
  assert.equal(agg.billableOf(ev({ cacheRead: 123456 })), 0);
});

test('sumWindow keeps cacheRead visible but out of billable', () => {
  const { tokens } = agg.sumWindow([ev({ ts: 5, input: 1, output: 2, cacheWrite: 3, cacheRead: 4 })], 0, 10);
  assert.deepEqual(tokens, { input: 1, output: 2, cacheWrite: 3, cacheRead: 4, billable: 6 });
});

test.describe('global dedup on requestId', () => {
  test('the same requestId replayed into another file is counted once', () => {
    // This is the session-resume / compact case: the identical assistant
    // record is written again into a NEW transcript file.
    const events = [
      ev({ f: 'fileA', ts: 100, key: 'req_1', output: 500 }),
      ev({ f: 'fileB', ts: 100, key: 'req_1', output: 500 }),
      ev({ f: 'fileB', ts: 200, key: 'req_2', output: 700 }),
    ];
    const out = agg.dedupe(events);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((e) => e.key), ['req_1', 'req_2']);
    assert.equal(out.reduce((s, e) => s + agg.billableOf(e), 0), 1200);
  });

  test('dedup is global, not per file', () => {
    const perFileOnly = [
      ...agg.dedupe([ev({ f: 'A', key: 'req_1', output: 10 })]),
      ...agg.dedupe([ev({ f: 'B', key: 'req_1', output: 10 })]),
    ];
    assert.equal(perFileOnly.length, 2, 'per-file dedup double counts by construction');

    const global = agg.dedupe([
      ev({ f: 'A', key: 'req_1', output: 10 }),
      ev({ f: 'B', key: 'req_1', output: 10 }),
    ]);
    assert.equal(global.length, 1);
  });

  test('survivor is deterministic regardless of input order', () => {
    const a = ev({ f: 'A', ts: 100, key: 'req_1', output: 1 });
    const b = ev({ f: 'B', ts: 50, key: 'req_1', output: 2 });
    assert.equal(agg.dedupe([a, b])[0].ts, 50);
    assert.equal(agg.dedupe([b, a])[0].ts, 50);
  });

  test('one response written as several lines keeps the FINAL output count', () => {
    // Claude Code writes a line per content block; output grows line by line,
    // input and cache stay the same.
    const lines = [
      ev({ ts: 100, key: 'req_1', input: 5, output: 12, cacheRead: 900 }),
      ev({ ts: 101, key: 'req_1', input: 5, output: 40, cacheRead: 900 }),
      ev({ ts: 102, key: 'req_1', input: 5, output: 377, cacheRead: 900 }),
    ];
    const out = agg.dedupe(lines);
    assert.equal(out.length, 1);
    assert.equal(out[0].output, 377);
    assert.equal(out[0].ts, 100, 'the response is still placed at its first line');
    assert.equal(out[0].input, 5);
    assert.equal(out[0].cacheRead, 900);
    // Order of arrival does not matter, and the inputs are not mutated.
    assert.equal(agg.dedupe(lines.slice().reverse())[0].output, 377);
    assert.equal(lines[0].output, 12);
  });

  test('distinct keys are never merged', () => {
    const out = agg.dedupe([
      ev({ ts: 1, key: 'req_1' }),
      ev({ ts: 1, key: 'msg_1' }),
      ev({ ts: 1, key: 'sess:uuid' }),
    ]);
    assert.equal(out.length, 3);
  });

  test('empty input', () => {
    assert.deepEqual(agg.dedupe([]), []);
  });
});

test.describe('window boundary math', () => {
  const now = Date.parse('2026-09-08T12:00:00.000Z');

  test('the window is half open: start inclusive, end exclusive', () => {
    const events = [
      ev({ ts: 999, key: 'before', output: 1 }),
      ev({ ts: 1000, key: 'atStart', output: 2 }),
      ev({ ts: 1500, key: 'inside', output: 4 }),
      ev({ ts: 2000, key: 'atEnd', output: 8 }),
      ev({ ts: 2001, key: 'after', output: 16 }),
    ];
    const { tokens, count } = agg.sumWindow(events, 1000, 2000);
    // `atStart` and `inside` only: a record landing exactly on the reset
    // instant belongs to the NEW window, not to the one that just closed.
    assert.equal(count, 2);
    assert.equal(tokens.billable, 2 + 4);
  });

  test('a known resetsAt anchors the window to [resetsAt - 5h, resetsAt)', () => {
    const resetsAt = now + 2 * HOUR;
    const w = agg.fiveHourWindow(now, resetsAt);
    assert.equal(w.anchored, true);
    assert.equal(w.end, resetsAt);
    assert.equal(w.start, resetsAt - 5 * HOUR);
    assert.equal(w.end - w.start, 5 * HOUR);
    // Only the part that has actually happened counts as elapsed.
    assert.equal(w.elapsedMs, 3 * HOUR);
  });

  test('an unknown resetsAt falls back to a trailing 5h window', () => {
    const w = agg.fiveHourWindow(now, null);
    assert.equal(w.anchored, false);
    assert.equal(w.end, now);
    assert.equal(w.start, now - 5 * HOUR);
    assert.equal(w.elapsedMs, 5 * HOUR);
  });

  test('a window that already closed reports the full 5h as elapsed', () => {
    const w = agg.fiveHourWindow(now, now - HOUR);
    assert.equal(w.elapsedMs, 5 * HOUR);
  });

  test('a window that just opened reports ~0 elapsed', () => {
    const w = agg.fiveHourWindow(now, now + 5 * HOUR);
    assert.equal(w.elapsedMs, 0);
  });

  test('seven day window spans exactly 7 days', () => {
    const resetsAt = now + 3 * HOUR;
    const w = agg.sevenDayWindow(now, resetsAt);
    assert.equal(w.end - w.start, 7 * 24 * HOUR);
  });

  test('records outside an anchored window are excluded', () => {
    const resetsAt = now + 2 * HOUR;
    const w = agg.fiveHourWindow(now, resetsAt);
    const events = [
      ev({ ts: w.start - 1, key: 'previousWindow', output: 100 }),
      ev({ ts: w.start, key: 'firstOfWindow', output: 7 }),
      ev({ ts: now, key: 'justNow', output: 11 }),
    ];
    const { tokens } = agg.sumWindow(events, w.start, w.end);
    assert.equal(tokens.billable, 18);
  });
});

test.describe('burn rate', () => {
  test('billable per hour over the elapsed part of the window', () => {
    assert.equal(agg.burnRatePerHour(300000, 3 * HOUR), 100000);
  });

  test('is null rather than a spike when the window just reset', () => {
    assert.equal(agg.burnRatePerHour(50000, 1000), null);
  });

  test('is zero when nothing was spent', () => {
    assert.equal(agg.burnRatePerHour(0, 3 * HOUR), 0);
  });
});

test('byModel is sorted by billable, largest first', () => {
  const events = [
    ev({ ts: 1, key: 'a', model: 'claude-haiku-4-5', output: 10 }),
    ev({ ts: 2, key: 'b', model: 'claude-opus-5', output: 900 }),
    ev({ ts: 3, key: 'c', model: 'claude-haiku-4-5', output: 5 }),
  ];
  const { byModel } = agg.sumWindow(events, 0, 10);
  assert.deepEqual(byModel, [
    { model: 'claude-opus-5', billable: 900 },
    { model: 'claude-haiku-4-5', billable: 15 },
  ]);
});
