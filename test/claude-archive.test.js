'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scan } = require('../src/core/scan/scanner');
const archiveMod = require('../src/core/scan/archive');
const { extractEvents } = require('../src/core/scan/parse');
const { walkJsonlFiles } = require('../src/core/scan/walk');
const agg = require('../src/core/aggregate');
const pricing = require('../src/core/pricing');
const history = require('../src/core/history');
const store = require('../src/core/store');
const { buildSnapshot, _resetHistoryMemoForTests } = require('../src/core/snapshot');

// The archive keeps what the week/month history needs from records older than
// the raw 8-day retention (owner, 2026-09-28: July and August showed nothing,
// and the month total shrank every day as its first days left the store).

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 8, 28, 12, 0, 0).getTime(); // local noon, 28 Sep

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-archive-'));
}

function write(root, rel, records, mtimeMs) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  if (mtimeMs) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

function rec(at, requestId, over = {}) {
  return {
    timestamp: new Date(at).toISOString(),
    requestId,
    sessionId: 's', uuid: `u-${requestId}-${over.output ?? 100}`,
    message: {
      model: over.model || 'claude-opus-5',
      usage: {
        input_tokens: over.input ?? 1000,
        output_tokens: over.output ?? 100,
        cache_creation_input_tokens: over.cacheWrite ?? 2000,
        cache_read_input_tokens: over.cacheRead ?? 50000,
        ...(over.noSplit ? {} : { cache_creation: { ephemeral_5m_input_tokens: over.cw5 ?? 500, ephemeral_1h_input_tokens: over.cw1h ?? 1500 } }),
      },
    },
  };
}

/** Every record in the tree, deduped: what the history SHOULD say. */
async function truthEvents(root) {
  const { files } = await walkJsonlFiles(root, {});
  const all = [];
  for (const f of files) for (const ev of extractEvents(fs.readFileSync(f.path, 'utf8'), f.id).events) all.push(ev);
  return agg.dedupe(all);
}

/** What the snapshot hands the history: archive rows before the frontier, raw records after. */
function historyEvents(result) {
  const hot = agg.dedupe(result.events);
  if (!result.archive) return hot;
  return result.archive.rows.concat(hot.filter((ev) => ev.ts >= result.archive.frontierMs));
}

function monthly(events, now) {
  return history.usageHistory(events, now, {}).months.map((m) => ({ key: m.key, usd: m.costUsd, floor: m.isFloor }));
}

function weekly(events, now) {
  return history.usageHistory(events, now, {}).weeks.map((w) => ({ key: w.key, usd: w.costUsd, floor: w.isFloor }));
}

function oldAndNew(root) {
  write(root, 'p/july.jsonl', [rec(new Date(2026, 6, 20, 10).getTime(), 'j1'), rec(new Date(2026, 6, 21, 23, 30).getTime(), 'j2', { model: 'claude-sonnet-5' })], new Date(2026, 6, 21, 23, 31).getTime());
  write(root, 'p/aug.jsonl', [rec(new Date(2026, 7, 5, 9).getTime(), 'a1', { output: 7000 })], new Date(2026, 7, 5, 9, 1).getTime());
  write(root, 'p/sep-early.jsonl', [rec(new Date(2026, 8, 3, 9).getTime(), 's1')], new Date(2026, 8, 3, 9, 1).getTime());
  write(root, 'p/recent.jsonl', [rec(NOW - 2 * DAY, 'r1'), rec(NOW - 60 * 60 * 1000, 'r2')], NOW - 60 * 60 * 1000);
}

test('first build reads every transcript once: the months match the whole corpus', async () => {
  const root = fixture();
  oldAndNew(root);
  const res = await scan({ root, cursors: {}, priorEvents: [], archive: null, now: NOW });
  assert.equal(res.ok, true);
  assert.equal(res.archiveChanged, true);
  assert.equal(res.archive.frontierMs, new Date(2026, 8, 20).getTime(), 'a local midnight, 8 days back');
  assert.ok(res.events.every((ev) => ev.ts >= res.archive.frontierMs), 'the raw store holds nothing before the frontier');
  assert.ok(res.archive.rows.every((r) => r.ts < res.archive.frontierMs));

  const truth = await truthEvents(root);
  assert.deepEqual(monthly(historyEvents(res), NOW), monthly(truth, NOW));
  assert.deepEqual(weekly(historyEvents(res), NOW), weekly(truth, NOW));
  const months = monthly(historyEvents(res), NOW);
  assert.deepEqual(months.map((m) => m.key), ['2026-09', '2026-08', '2026-07']);
  assert.ok(months.every((m) => m.usd > 0), 'July and August are not empty');
});

test('the archive-less scan keeps the old behaviour: history before the retention is empty', async () => {
  const root = fixture();
  oldAndNew(root);
  const res = await scan({ root, cursors: {}, priorEvents: [], now: NOW });
  assert.equal(res.archive, null);
  assert.deepEqual(monthly(agg.dedupe(res.events), NOW).map((m) => m.key), ['2026-09']);
});

test('an unchanged rescan reads nothing and keeps the same archive object', async () => {
  const root = fixture();
  oldAndNew(root);
  const first = await scan({ root, cursors: {}, priorEvents: [], archive: null, now: NOW });
  const again = await scan({ root, cursors: first.cursors, priorEvents: first.events, archive: first.archive, now: NOW + 60 * 1000 });
  assert.equal(again.stats.filesParsed, 0);
  assert.equal(again.archiveChanged, false);
  assert.equal(again.archive, first.archive);
});

test('as days pass, records leaving the raw store move into the archive and no total changes', async () => {
  const root = fixture();
  oldAndNew(root);
  const first = await scan({ root, cursors: {}, priorEvents: [], archive: null, now: NOW });
  const later = NOW + 8 * DAY;
  const next = await scan({ root, cursors: first.cursors, priorEvents: first.events, archive: first.archive, now: later });
  assert.equal(next.stats.filesParsed, 0, 'the fold works from carried records, not by re-reading');
  assert.equal(next.archiveChanged, true);
  assert.equal(next.archive.frontierMs, new Date(2026, 8, 28).getTime());
  assert.ok(next.events.some((ev) => ev.key === 'r2'), 'r2 (28 Sep) is still raw');
  assert.ok(!next.events.some((ev) => ev.key === 'r1'), 'r1 (26 Sep) left the raw store...');
  assert.ok(next.archive.rows.some((r) => r.ts === new Date(2026, 8, 26).getTime()), '...and is in the archive');
  const truth = await truthEvents(root);
  assert.deepEqual(monthly(historyEvents(next), later), monthly(truth, later));
  assert.deepEqual(weekly(historyEvents(next), later), weekly(truth, later));
});

test('the app closed for weeks: a transcript written meanwhile is still archived', async () => {
  const root = fixture();
  write(root, 'p/a.jsonl', [rec(NOW - DAY, 'a')], NOW - DAY);
  const first = await scan({ root, cursors: {}, priorEvents: [], archive: null, now: NOW });
  // Written 3 days later, while the app was closed; the app comes back 20 days on.
  const at = NOW + 3 * DAY;
  write(root, 'p/while-closed.jsonl', [rec(at, 'closed', { output: 9000 })], at);
  const later = NOW + 20 * DAY;
  const next = await scan({ root, cursors: first.cursors, priorEvents: first.events, archive: first.archive, now: later });
  assert.ok(next.archive.rows.some((r) => r.ts === archiveMod.dayStartMs(at) && r.output === 9000));
  const truth = await truthEvents(root);
  assert.deepEqual(monthly(historyEvents(next), later), monthly(truth, later));
});

test('Claude Code deleting an old transcript does not erase its history', async () => {
  const root = fixture();
  oldAndNew(root);
  const first = await scan({ root, cursors: {}, priorEvents: [], archive: null, now: NOW });
  const before = monthly(historyEvents(first), NOW);
  fs.unlinkSync(path.join(root, 'p/july.jsonl'));
  fs.unlinkSync(path.join(root, 'p/aug.jsonl'));
  const next = await scan({ root, cursors: first.cursors, priorEvents: first.events, archive: first.archive, now: NOW + 60 * 1000 });
  assert.deepEqual(monthly(historyEvents(next), NOW + 60 * 1000), before);
});

test('a replayed record is archived once, with the largest output any copy reports', async () => {
  const root = fixture();
  const at = new Date(2026, 7, 10, 15).getTime();
  write(root, 'p/orig.jsonl', [rec(at, 'dup', { output: 10 })], at);
  write(root, 'p/resumed.jsonl', [rec(at, 'dup', { output: 4000 }), rec(at + 1000, 'other')], at + 1000);
  const res = await scan({ root, cursors: {}, priorEvents: [], archive: null, now: NOW });
  const rows = res.archive.rows.filter((r) => r.ts === archiveMod.dayStartMs(at));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].n, 2);
  assert.equal(rows[0].output, 4000 + 100);
  assert.equal(rows[0].input, 2000);
});

test('a row prices exactly as its records did, fallback floor included', () => {
  const at = new Date(2026, 6, 1, 12).getTime();
  const events = [
    { ts: at, model: 'claude-opus-5', key: 'a', f: 'x', input: 100, output: 200, cacheWrite: 3000, cacheRead: 9000, cw5: 1000, cw1h: 2000 },
    // No TTL breakdown: the whole write at the 5-minute rate, and a floor.
    { ts: at + 1000, model: 'claude-opus-5', key: 'b', f: 'x', input: 50, output: 60, cacheWrite: 4000, cacheRead: 0, cw5: 0, cw1h: 0 },
    { ts: at + 2000, model: 'claude-opus-5', key: 'c', f: 'x', input: 10, output: 10, cacheWrite: 0, cacheRead: 100, cw5: 0, cw1h: 0 },
    { ts: at + 3000, model: 'claude-opus-5', key: 'd', f: 'x', input: 1, output: 1, cacheWrite: 0, cacheRead: 0, cw5: 0, cw1h: 0, speed: 'fast' },
  ];
  const rows = archiveMod.fold([], events);
  assert.equal(rows.length, 2, 'standard and fast are two rows');
  const start = archiveMod.dayStartMs(at);
  const fromRecords = pricing.weeklyCost(events, start, start + DAY, false);
  const fromRows = pricing.weeklyCost(rows, start, start + DAY, false);
  // Summing tokens before pricing, instead of dollars after, moves only the
  // last rounded digit (float order), never a real amount.
  const near = (a, b, what) => assert.ok(Math.abs(a - b) <= 0.0002, `${what}: ${a} vs ${b}`);
  near(fromRows.totalUsd, fromRecords.totalUsd, 'total');
  for (const cls of Object.keys(fromRecords.byClass)) near(fromRows.byClass[cls], fromRecords.byClass[cls], cls);
  assert.equal(fromRows.byModel.length, fromRecords.byModel.length);
  fromRecords.byModel.forEach((m, i) => {
    const r = fromRows.byModel[i];
    assert.deepEqual({ ...r, usd: 0 }, { ...m, usd: 0 });
    near(r.usd, m.usd, m.model);
  });
  assert.equal(fromRows.fallbackWriteEvents, 1);
  assert.equal(fromRows.cacheWriteEvents, 2);
});

test('a frontier saved while the clock ran ahead is rewound, and nothing is lost or counted twice (review F2)', async () => {
  const root = fixture();
  oldAndNew(root);
  // One scan with the clock 12 days ahead, then the clock is put right.
  const ahead = await scan({ root, cursors: {}, priorEvents: [], archive: null, now: NOW + 12 * DAY });
  assert.ok(ahead.archive.frontierMs > NOW, 'the saved frontier is in the future');
  // A new session while the clock is right again.
  write(root, 'p/new-session.jsonl', [rec(NOW - 30 * 60 * 1000, 'fresh')], NOW - 30 * 60 * 1000);
  const next = await scan({ root, cursors: ahead.cursors, priorEvents: ahead.events, archive: ahead.archive, now: NOW });
  assert.equal(next.archive.frontierMs, new Date(2026, 8, 20).getTime());
  assert.equal(next.archiveChanged, true);
  assert.ok(next.archive.rows.every((r) => r.ts < next.archive.frontierMs));
  assert.ok(next.events.some((ev) => ev.key === 'fresh'), 'the new session is read, not skipped as too old');
  assert.ok(next.events.some((ev) => ev.key === 'r1'), 'the days taken back from the archive are raw again');
  const truth = await truthEvents(root);
  assert.deepEqual(monthly(historyEvents(next), NOW), monthly(truth, NOW));
  assert.deepEqual(weekly(historyEvents(next), NOW), weekly(truth, NOW));
});

test('the clock going back less than a day changes nothing', async () => {
  const root = fixture();
  oldAndNew(root);
  const first = await scan({ root, cursors: {}, priorEvents: [], archive: null, now: NOW });
  const next = await scan({ root, cursors: first.cursors, priorEvents: first.events, archive: first.archive, now: NOW - 60 * 60 * 1000 });
  assert.equal(next.archive, first.archive);
  assert.equal(next.stats.filesParsed, 0);
});

test('a response written across midnight is counted once, however the frontier moves (review F1)', async () => {
  const root = fixture();
  // Three lines of ONE response (one per content block), across 22/23 Sep.
  const a = new Date(2026, 8, 22, 23, 59, 50).getTime();
  write(root, 'p/midnight.jsonl', [
    rec(a, 'mid', { output: 10 }),
    rec(a + 15 * 1000, 'mid', { output: 400 }),
    rec(a + 40 * 1000, 'mid', { output: 900 }),
  ], a + 40 * 1000);
  write(root, 'p/recent.jsonl', [rec(NOW - 60 * 60 * 1000, 'r')], NOW - 60 * 60 * 1000);
  let res = await scan({ root, cursors: {}, priorEvents: [], archive: null, now: NOW });
  // Day by day until both days have crossed the frontier.
  for (let d = 1; d <= 4; d += 1) {
    const at = NOW + d * DAY;
    res = await scan({ root, cursors: res.cursors, priorEvents: res.events, archive: res.archive, now: at });
    const truth = await truthEvents(root);
    assert.deepEqual(weekly(historyEvents(res), at), weekly(truth, at), `day +${d}`);
    const lines = res.archive.rows.reduce((n, r) => n + r.n, 0);
    assert.ok(lines <= 1, `day +${d}: the response is in the archive at most once`);
  }
  const row = res.archive.rows.find((r) => r.n === 1 && r.output === 900);
  assert.ok(row, 'archived once, with its final output');
  assert.equal(row.ts, new Date(2026, 8, 22).getTime(), 'on the day it started');
});

test('an unchanged file with a known loss keeps its archived days "at least" (review F4)', async () => {
  const root = fixture();
  oldAndNew(root);
  const first = await scan({ root, cursors: {}, priorEvents: [], archive: null, now: NOW });
  assert.equal(first.archive.unread, null);
  // A recent transcript with a lost usage line in the middle, read while the
  // frontier does not move: only the raw side knows of the loss so far.
  const at = NOW - 2 * DAY;
  const file = path.join(root, 'p/lossy.jsonl');
  fs.writeFileSync(file, [JSON.stringify(rec(at, 'ok')), `{"type":"assistant","message":{"usage":{"input_tokens":1${' '.repeat(40)}`, JSON.stringify(rec(at + 1000, 'ok2')), ''].join('\n'));
  fs.utimesSync(file, (at + 1000) / 1000, (at + 1000) / 1000);
  const second = await scan({ root, cursors: first.cursors, priorEvents: first.events, archive: first.archive, now: NOW + 60 * 1000 });
  assert.ok(second.unreadRange, 'the raw side knows');
  assert.equal(second.archive.unread, null, 'no archived day is affected yet');
  const later = NOW + 8 * DAY;
  const next = await scan({ root, cursors: second.cursors, priorEvents: second.events, archive: second.archive, now: later });
  assert.equal(next.stats.filesParsed, 0, 'the file is unchanged');
  assert.ok(next.archive.unread, 'its loss follows its days into the archive');
  const h = history.usageHistory(historyEvents(next), later, { unreadRanges: { claude: [next.archive.unread] } });
  assert.equal(h.weeks.find((w) => w.key === '2026-09-21').isFloor, true);
});

test('a torn last line in a recent transcript does not make old months "at least" (review F5)', async () => {
  const root = fixture();
  oldAndNew(root);
  const at = NOW - 60 * 60 * 1000;
  const file = path.join(root, 'p/torn.jsonl');
  fs.writeFileSync(file, [JSON.stringify(rec(at, 't1')), `{"type":"assistant","message":{"usage":{"input_tokens":1${' '.repeat(40)}`].join('\n'));
  fs.utimesSync(file, at / 1000, at / 1000);
  const res = await scan({ root, cursors: {}, priorEvents: [], archive: null, now: NOW });
  assert.ok(res.unreadRange, 'the raw side still says it lost a line');
  assert.equal(res.archive.unread, null, 'the archived days are complete');
});

test('a deleted recent transcript is kept until its days are archived (review F6)', async () => {
  const root = fixture();
  oldAndNew(root);
  const first = await scan({ root, cursors: {}, priorEvents: [], archive: null, now: NOW });
  fs.unlinkSync(path.join(root, 'p/recent.jsonl'));
  const gone = await scan({ root, cursors: first.cursors, priorEvents: first.events, archive: first.archive, now: NOW + 60 * 1000 });
  assert.ok(gone.events.some((ev) => ev.key === 'r1'), 'still in the raw store');
  const later = NOW + 10 * DAY;
  const next = await scan({ root, cursors: gone.cursors, priorEvents: gone.events, archive: gone.archive, now: later });
  assert.ok(!next.events.some((ev) => ev.key === 'r1' || ev.key === 'r2'), 'left the raw store...');
  assert.equal(
    next.archive.rows.filter((r) => r.ts >= new Date(2026, 8, 26).getTime()).reduce((n, r) => n + r.n, 0),
    2,
    '...into the archive',
  );
});

test('rows older than the history can show are let go', () => {
  const old = new Date(2025, 0, 1, 12).getTime();
  const ev = { ts: old, model: 'claude-opus-5', key: 'o', f: 'x', input: 1, output: 1, cacheWrite: 0, cacheRead: 0, cw5: 0, cw1h: 0 };
  const a = archiveMod.advance(null, new Date(2025, 0, 10).getTime(), [ev], null);
  assert.equal(a.rows.length, 1);
  const b = archiveMod.advance(a, new Date(2026, 8, 20).getTime(), [], null);
  assert.equal(b.rows.length, 0);
});

test('an old transcript that cannot be read makes the archive say so, and its months are floors', async (t) => {
  const root = fixture();
  oldAndNew(root);
  const bad = path.join(root, 'p/aug.jsonl');
  const realRead = fs.promises.readFile;
  t.mock.method(fs.promises, 'readFile', async (file, ...rest) => {
    if (path.resolve(String(file)) === path.resolve(bad)) {
      const err = new Error('denied');
      err.code = 'EACCES';
      throw err;
    }
    return realRead.call(fs.promises, file, ...rest);
  });
  const res = await scan({ root, cursors: {}, priorEvents: [], archive: null, now: NOW });
  assert.ok(res.archive.unread, 'a known gap is recorded');
  assert.equal(res.archive.unread.throughMs, fs.statSync(bad).mtimeMs);
  const h = history.usageHistory(historyEvents(res), NOW, { unreadRanges: { claude: [res.archive.unread] } });
  const aug = h.months.find((m) => m.key === '2026-08');
  assert.equal(aug.isFloor, true, 'August is "at least", never a confident figure');
});

test('the store keeps the archive across a restart, and drops a malformed one', () => {
  const dir = fixture();
  const archive = {
    version: archiveMod.ARCHIVE_VERSION,
    frontierMs: new Date(2026, 8, 20).getTime(),
    rows: archiveMod.fold([], [{ ts: new Date(2026, 6, 1, 9).getTime(), model: 'claude-opus-5', key: 'k', f: 'x', input: 1, output: 2, cacheWrite: 0, cacheRead: 0, cw5: 0, cw1h: 0 }]),
    unread: null,
  };
  assert.equal(store.save(dir, { cursors: {}, events: [], archive }), true);
  assert.deepEqual(store.load(dir).archive, archive);

  const file = store.storePath(dir);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.archive.rows[0].input = -5;
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.equal(store.load(dir).archive, null, 'rebuilt from the transcripts, never misread');

  delete raw.archive;
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.equal(store.load(dir).archive, null, 'a store from before the archive');
});

test('the snapshot history joins archive and raw records without counting the frontier day twice', async () => {
  const root = fixture();
  oldAndNew(root);
  // A raw record on the frontier's own day: it must come from the raw side only.
  const frontierDay = new Date(2026, 8, 20, 8).getTime();
  write(root, 'p/edge.jsonl', [rec(frontierDay, 'edge', { output: 12345 })], frontierDay);
  const res = await scan({ root, cursors: {}, priorEvents: [], archive: null, now: NOW });
  _resetHistoryMemoForTests();
  const snap = buildSnapshot({ now: NOW, events: res.events, claudeArchive: res.archive, rateLimits: { state: 'missing' }, scanOk: true });
  const truth = await truthEvents(root);
  const expect = history.usageHistory(truth, NOW, {});
  assert.deepEqual(snap.usageHistory.months.map((m) => m.costUsd), expect.months.map((m) => m.costUsd));
  assert.deepEqual(snap.usageHistory.weeks.map((w) => w.costUsd), expect.weeks.map((w) => w.costUsd));
});
