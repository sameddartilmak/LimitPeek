'use strict';
/**
 * ADR-002 A3.15: `WeeklyCost.sourceIncomplete` is the cost reader's OWN
 * statement that it knows it could not read usage records in the window. It is
 * never derived from the rate-limit capture — a stale or rolled-over 5h/weekly
 * reading, or simply no recent use, leaves it false.
 *
 * Hermetic: temp directories only, fs failures injected with mocks.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const log = require('../src/core/log');
const { buildSnapshot } = require('../src/core/snapshot');
const { scan, TORN_WRITE_GRACE_MS } = require('../src/core/scan/scanner');
const { walkJsonlFiles } = require('../src/core/scan/walk');
const { extractEvents } = require('../src/core/scan/parse');
const { createCodexUsageScanner } = require('../src/core/codex/usage');
const rollout = require('../src/core/codex/rollout');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-14T12:00:00.000Z');

function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

function quiet(t) {
  log.setSink(() => {});
  t.after(() => log.setSink(null));
}

function errno(code) {
  return Object.assign(new Error(code), { code });
}

/* ------------------------------------------------------------ snapshot */

const claudeEvent = (ts = NOW - 2 * HOUR) => ({
  f: 'f', key: `k${ts}`, ts, model: 'claude-opus-5', input: 0, output: 1000, cacheWrite: 0, cacheRead: 0, cw5: 0, cw1h: 0,
});
const codexEvent = (ts = NOW - 2 * HOUR) => ({
  ts, model: 'gpt-5.6-sol', tier: 'standard', inputUncached: 10, cachedInput: 0, cacheWrite: 0, output: 10,
});

/** A capture whose windows ROLLED OVER a day ago, captured two days ago. */
function rolledOverCapture() {
  return {
    state: 'stale',
    capturedAt: new Date(NOW - 2 * DAY).toISOString(),
    capturedAtMs: NOW - 2 * DAY,
    ageMs: 2 * DAY,
    fiveHour: { usedPercentage: 80, resetsAtMs: NOW - DAY },
    sevenDay: { usedPercentage: 40, resetsAtMs: NOW - DAY },
  };
}

/** A capture past the freshness budget whose windows are still open. */
function agedCapture() {
  return {
    state: 'stale',
    capturedAt: new Date(NOW - 3 * HOUR).toISOString(),
    capturedAtMs: NOW - 3 * HOUR,
    ageMs: 3 * HOUR,
    fiveHour: { usedPercentage: 30, resetsAtMs: NOW + HOUR },
    sevenDay: { usedPercentage: 20, resetsAtMs: NOW + 3 * DAY },
  };
}

const range = (fromMs, throughMs) => ({ fromMs, throughMs });

function build(over = {}) {
  return buildSnapshot({
    now: NOW,
    events: [claudeEvent()],
    rateLimits: null,
    codexEvents: [codexEvent()],
    scanOk: true,
    ...over,
  });
}
const row = (snap, id) => snap.providers.find((p) => p.id === id);

test.describe('snapshot: sourceIncomplete is independent of limit freshness', () => {
  for (const [name, capture] of [['rolled over', rolledOverCapture], ['aged', agedCapture]]) {
    test(`a ${name} rate-limit capture with fully read logs is NOT incomplete`, () => {
      const snap = build({ rateLimits: capture(), codexRateLimits: capture() });
      for (const id of ['claude', 'codex']) {
        assert.equal(row(snap, id).status, 'stale', `${id}: the row IS stale — that is the point of the test`);
        assert.equal(row(snap, id).weeklyCost.sourceIncomplete, false, `${id}: the logs were read in full`);
      }
    });
  }

  test('no recent use at all (only old events, nothing in the last days) is not incomplete', () => {
    const snap = build({
      events: [claudeEvent(NOW - 6 * DAY)],
      codexEvents: [codexEvent(NOW - 6 * DAY)],
      rateLimits: rolledOverCapture(),
      codexRateLimits: rolledOverCapture(),
    });
    assert.equal(row(snap, 'claude').weeklyCost.sourceIncomplete, false);
    assert.equal(row(snap, 'codex').weeklyCost.sourceIncomplete, false);
  });

  test('Claude: a failed transcript scan serving the older store is incomplete', () => {
    const snap = build({ scanOk: false });
    assert.equal(row(snap, 'claude').weeklyCost.sourceIncomplete, true);
    assert.equal(row(snap, 'codex').weeklyCost.sourceIncomplete, false, 'one tool\'s failure is not the other\'s');
  });

  test('Claude: known-unread records inside the week are incomplete; before the week they are not', () => {
    assert.equal(row(build({ scanUnreadRange: range(NOW - 2 * DAY, NOW - DAY) }), 'claude').weeklyCost.sourceIncomplete, true);
    assert.equal(row(build({ scanUnreadRange: range(NOW - 9 * DAY, NOW - 8 * DAY) }), 'claude').weeklyCost.sourceIncomplete, false);
    assert.equal(row(build({ scanUnreadRange: null }), 'claude').weeklyCost.sourceIncomplete, false);
  });

  test('Codex: a failed or timed-out rollout scan serving the previous result is incomplete', () => {
    const snap = build({ codexReadFailed: true });
    assert.equal(row(snap, 'codex').weeklyCost.sourceIncomplete, true);
    assert.equal(row(snap, 'claude').weeklyCost.sourceIncomplete, false);
  });

  test('Codex: known-unread turns inside the week are incomplete; before the week they are not', () => {
    assert.equal(row(build({ codexUnreadRange: range(NOW - 2 * HOUR, NOW - HOUR) }), 'codex').weeklyCost.sourceIncomplete, true);
    assert.equal(row(build({ codexUnreadRange: range(NOW - 10 * DAY, NOW - 9 * DAY) }), 'codex').weeklyCost.sourceIncomplete, false);
  });

  test('the window is the ANCHORED week when the capture has a forward weekly reset', () => {
    // Anchored week: [NOW + 3d - 7d, NOW + 3d) = starts NOW - 4d.
    const aged = agedCapture();
    assert.equal(row(build({ codexRateLimits: aged, codexUnreadRange: range(NOW - 6 * DAY, NOW - 5 * DAY) }), 'codex')
      .weeklyCost.sourceIncomplete, false, 'before the anchored start');
    assert.equal(row(build({ codexRateLimits: aged, codexUnreadRange: range(NOW - 6 * DAY, NOW - 3 * DAY) }), 'codex')
      .weeklyCost.sourceIncomplete, true, 'inside the anchored week');
  });
});

/* ------------------------------------------------------ Claude scanner */

/** A Claude scan result's known-unread upper bound, or null. */
const through = (res) => (res.unreadRange ? res.unreadRange.throughMs : null);

function claudeRecord(requestId, at) {
  return JSON.stringify({
    timestamp: new Date(at).toISOString(),
    requestId,
    message: { model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  });
}

function writeTranscript(root, rel, text, mtimeMs) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

test.describe('Claude transcript scan: what it knows it did not read', () => {
  test('a complete corpus reports nothing unread', async (t) => {
    quiet(t);
    const root = tmp('src-incomplete-claude-');
    writeTranscript(root, 'p/a.jsonl', `${claudeRecord('a', NOW - HOUR)}\n`, NOW - HOUR);
    const res = await scan({ root, cursors: {}, priorEvents: [], now: NOW });
    assert.equal(res.ok, true);
    assert.equal(through(res), null);
  });

  test('a usage line that fails to parse is unread through the file\'s mtime, and stays so on an unchanged rescan', async (t) => {
    quiet(t);
    const root = tmp('src-incomplete-claude-');
    const mtime = NOW - 2 * HOUR;
    writeTranscript(root, 'p/a.jsonl',
      `${claudeRecord('a', NOW - 3 * HOUR)}\n{"message":{"usage":{"input_tokens": broken, "output_tokens": 1}}}\n`, mtime);
    const first = await scan({ root, cursors: {}, priorEvents: [], now: NOW });
    assert.equal(Math.round(through(first)), mtime);
    assert.equal(first.stats.filesParsed, 1);

    const second = await scan({ root, cursors: first.cursors, priorEvents: first.events, now: NOW });
    assert.equal(second.stats.filesParsed, 0, 'unchanged: carried, not re-read');
    assert.equal(Math.round(through(second)), mtime, 'the loss rides on the cursor');
  });

  test('a torn final line in a file written moments ago is a write in progress; in an old file it is a lost record', async (t) => {
    quiet(t);
    const root = tmp('src-incomplete-claude-');
    const whole = claudeRecord('b', NOW - HOUR);
    const text = `${claudeRecord('a', NOW - 2 * HOUR)}\n${whole.slice(0, whole.length - 20)}`;
    writeTranscript(root, 'p/a.jsonl', text, NOW - 60 * 1000);
    const res = await scan({ root, cursors: {}, priorEvents: [], now: NOW });
    assert.equal(res.stats.failedLines, 1, 'it did fail to parse');
    assert.equal(through(res), null, 'but the next scan reads it once written');

    const oldRoot = tmp('src-incomplete-claude-');
    const oldMtime = NOW - TORN_WRITE_GRACE_MS - 60 * 1000;
    writeTranscript(oldRoot, 'p/a.jsonl', text, oldMtime);
    const old = await scan({ root: oldRoot, cursors: {}, priorEvents: [], now: NOW });
    assert.equal(Math.round(through(old)), oldMtime, 'nobody is still writing it: the record is lost');
    const torn = whole.slice(0, whole.length - 20);
    assert.equal(extractEvents(torn, 'f').failedUnterminated, 1);
    const terminated = extractEvents(`${torn}\n`, 'f');
    assert.equal(terminated.failed, 1);
    assert.equal(terminated.failedUnterminated, 0, 'a newline-terminated corrupt line IS a lost record');
  });

  test('a transcript that exists but cannot be read (locked) is unread through its mtime; a vanished one is not', async (t) => {
    quiet(t);
    const root = tmp('src-incomplete-claude-');
    const mtime = NOW - 90 * 60 * 1000;
    const locked = writeTranscript(root, 'p/locked.jsonl', `${claudeRecord('a', NOW - 2 * HOUR)}\n`, mtime);
    const gone = writeTranscript(root, 'p/gone.jsonl', `${claudeRecord('b', NOW - 2 * HOUR)}\n`, NOW - 3 * HOUR);
    const readFile = fs.promises.readFile.bind(fs.promises);
    t.mock.method(fs.promises, 'readFile', async (p, ...rest) => {
      if (p === locked) throw errno('EBUSY');
      if (p === gone) throw errno('ENOENT');
      return readFile(p, ...rest);
    });
    const res = await scan({ root, cursors: {}, priorEvents: [], now: NOW });
    assert.equal(res.stats.filesFailed, 2);
    assert.equal(Math.round(through(res)), mtime, 'only the locked file counts');
  });

  test('a subdirectory that cannot be listed is unread through now (no bound is known)', async (t) => {
    quiet(t);
    const root = tmp('src-incomplete-claude-');
    writeTranscript(root, 'p/a.jsonl', `${claudeRecord('a', NOW - HOUR)}\n`, NOW - HOUR);
    writeTranscript(root, 'q/b.jsonl', `${claudeRecord('b', NOW - HOUR)}\n`, NOW - HOUR);
    const readdir = fs.promises.readdir.bind(fs.promises);
    t.mock.method(fs.promises, 'readdir', async (p, ...rest) => {
      if (path.basename(p) === 'q') throw errno('EACCES');
      return readdir(p, ...rest);
    });
    const walked = await walkJsonlFiles(root, {});
    assert.equal(walked.unreadable, 1);
    const res = await scan({ root, cursors: {}, priorEvents: [], now: NOW });
    assert.equal(through(res), NOW);
  });

  test('a walk truncated at its file cap is unread through now', async (t) => {
    quiet(t);
    const root = tmp('src-incomplete-claude-');
    writeTranscript(root, 'p/a.jsonl', `${claudeRecord('a', NOW - HOUR)}\n`, NOW - HOUR);
    writeTranscript(root, 'p/b.jsonl', `${claudeRecord('b', NOW - HOUR)}\n`, NOW - HOUR);
    const walk = require('../src/core/scan/walk');
    const real = walk.walkJsonlFiles;
    const truncated = await real(root, { maxFiles: 1 });
    assert.equal(truncated.truncated, true);
    // The scanner's own walk has no cap option; feed it the truncated result.
    t.mock.method(walk, 'walkJsonlFiles', async () => truncated);
    delete require.cache[require.resolve('../src/core/scan/scanner')];
    const { scan: scanWithMock } = require('../src/core/scan/scanner');
    t.after(() => { delete require.cache[require.resolve('../src/core/scan/scanner')]; });
    const res = await scanWithMock({ root, cursors: {}, priorEvents: [], now: NOW });
    assert.equal(through(res), NOW);
  });
});

/* ------------------------------------------------------- Codex scanner */

const DAY_DIR = ['2026', '09', '14'];

function tokenCountLine(ts, total, last = total) {
  return JSON.stringify({
    timestamp: new Date(ts).toISOString(),
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } },
  });
}
const counts = (input, output) => ({
  input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output,
});
const header = () => [
  JSON.stringify({ type: 'session_meta', payload: { model: 'gpt-5.6-sol' } }),
  JSON.stringify({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { service_tier: 'default' } } }),
];

function writeRollout(home, lines, name = 'rollout-a.jsonl') {
  const dir = path.join(home, 'sessions', ...DAY_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function codexScan(scanner, home, extra = {}) {
  const events = scanner.scan({ now: NOW, startMs: NOW - 7 * DAY, home, ...extra });
  return { events, unreadRange: scanner.unreadRange(), unreadThroughMs: scanner.unreadThroughMs() };
}

test.describe('Codex rollout scan: what it knows it did not read', () => {
  test.beforeEach(() => rollout._resetPathGuardForTests());
  test.after(() => rollout._resetPathGuardForTests());

  test('a complete corpus reports nothing unread', () => {
    const home = tmp('src-incomplete-codex-');
    writeRollout(home, [...header(), tokenCountLine(NOW - HOUR, counts(100, 10))]);
    const res = codexScan(createCodexUsageScanner(), home);
    assert.equal(res.events.length, 1);
    assert.equal(through(res), null);
  });

  test('a corrupt token_count line is unread through its own timestamp', () => {
    const home = tmp('src-incomplete-codex-');
    const at = NOW - 3 * HOUR;
    const corrupt = tokenCountLine(at, counts(100, 10)).slice(0, -12) + ',,}';
    writeRollout(home, [...header(), corrupt, tokenCountLine(NOW - HOUR, counts(200, 20))]);
    const res = codexScan(createCodexUsageScanner(), home);
    assert.equal(through(res), at);
  });

  test('a corrupt line that only MENTIONS token_count in its body is not a lost record', () => {
    const home = tmp('src-incomplete-codex-');
    const mention = `{"timestamp":"${new Date(NOW - HOUR).toISOString()}","type":"response_item","payload":{"type":"message","text":"${'x'.repeat(400)} token_count" broken`;
    writeRollout(home, [...header(), mention, tokenCountLine(NOW - HOUR, counts(100, 10))]);
    assert.equal(codexScan(createCodexUsageScanner(), home).unreadThroughMs, null);
  });

  test('a token_count record with invalid counts (skipped per A3.10) is unread through its timestamp', () => {
    const home = tmp('src-incomplete-codex-');
    const at = NOW - 2 * HOUR;
    writeRollout(home, [
      ...header(),
      tokenCountLine(NOW - 4 * HOUR, counts(100, 10)),
      tokenCountLine(at, { ...counts(150, 15), output_tokens: 1.5 }),
      tokenCountLine(NOW - HOUR, counts(200, 20)),
    ]);
    assert.equal(codexScan(createCodexUsageScanner(), home).unreadThroughMs, at);
  });

  test('an over-cap line whose head names token_count is unread', () => {
    const home = tmp('src-incomplete-codex-');
    const at = NOW - 2 * HOUR;
    const huge = `{"timestamp":"${new Date(at).toISOString()}","type":"event_msg","payload":{"type":"token_count","pad":"${'a'.repeat(4 * 1024 * 1024 + 10)}"}}`;
    writeRollout(home, [...header(), huge, tokenCountLine(NOW - HOUR, counts(100, 10))]);
    assert.equal(codexScan(createCodexUsageScanner(), home).unreadThroughMs, at);
  });

  test('an over-cap tool output is not a lost record', () => {
    const home = tmp('src-incomplete-codex-');
    const huge = `{"timestamp":"${new Date(NOW - 2 * HOUR).toISOString()}","type":"response_item","payload":{"type":"function_call_output","output":"token_count ${'a'.repeat(4 * 1024 * 1024 + 10)}"}}`;
    writeRollout(home, [...header(), huge, tokenCountLine(NOW - HOUR, counts(100, 10))]);
    assert.equal(codexScan(createCodexUsageScanner(), home).unreadThroughMs, null);
  });

  test('a rollout that exists but cannot be opened is unread; once readable again it clears', (t) => {
    const home = tmp('src-incomplete-codex-');
    const file = writeRollout(home, [...header(), tokenCountLine(NOW - HOUR, counts(100, 10))]);
    const scanner = createCodexUsageScanner();
    const openSync = fs.openSync;
    let locked = true;
    t.mock.method(fs, 'openSync', (p, ...rest) => {
      if (locked && path.basename(String(p)) === path.basename(file)) throw errno('EBUSY');
      return openSync(p, ...rest);
    });
    const blocked = codexScan(scanner, home);
    assert.equal(blocked.events.length, 0);
    assert.equal(blocked.unreadThroughMs, NOW, 'a file started today can carry turns through now');

    locked = false;
    const healed = codexScan(scanner, home);
    assert.equal(healed.events.length, 1);
    assert.equal(healed.unreadThroughMs, null);
  });

  test('a changed-files scan keeps an unread rollout it did not re-examine, and clears one it read', (t) => {
    const home = tmp('src-incomplete-codex-');
    writeRollout(home, [...header(), tokenCountLine(NOW - HOUR, counts(100, 10))], 'rollout-a.jsonl');
    writeRollout(home, [...header(), tokenCountLine(NOW - HOUR, counts(50, 5))], 'rollout-b.jsonl');
    const scanner = createCodexUsageScanner();
    const openSync = fs.openSync;
    let locked = true;
    t.mock.method(fs, 'openSync', (p, ...rest) => {
      if (locked && path.basename(String(p)) === 'rollout-a.jsonl') throw errno('EACCES');
      return openSync(p, ...rest);
    });
    assert.equal(codexScan(scanner, home).unreadThroughMs, NOW);
    const rel = (name) => path.join(...DAY_DIR, name);
    assert.equal(codexScan(scanner, home, { changed: [rel('rollout-b.jsonl')] }).unreadThroughMs, NOW, 'a untouched: still unread');
    locked = false;
    assert.equal(codexScan(scanner, home, { changed: [rel('rollout-a.jsonl')] }).unreadThroughMs, null);
  });

  test('an old unreadable rollout beyond the scanner\'s reach of the week does not reach the week', (t) => {
    const home = tmp('src-incomplete-codex-');
    const dir = path.join(home, 'sessions', '2026', '08', '20');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'rollout-old.jsonl');
    fs.writeFileSync(file, [...header(), tokenCountLine(Date.parse('2026-08-20T12:00:00Z'), counts(1, 1))].join('\n') + '\n');
    const openSync = fs.openSync;
    t.mock.method(fs, 'openSync', (p, ...rest) => {
      if (path.basename(String(p)) === 'rollout-old.jsonl') throw errno('EBUSY');
      return openSync(p, ...rest);
    });
    const scanner = createCodexUsageScanner();
    scanner.scan({ now: NOW, startMs: NOW - 60 * DAY, home });
    const unread = scanner.unreadRange();
    assert.ok(unread && Number.isFinite(unread.throughMs), 'it is known unread');
    const snap = build({ codexUnreadRange: unread });
    assert.equal(row(snap, 'codex').weeklyCost.sourceIncomplete, false, 'started 25 days ago: past the 14-day reach');
  });

  test('a day folder refused as a network target is unread', (t) => {
    quiet(t);
    const home = tmp('src-incomplete-codex-');
    writeRollout(home, [...header(), tokenCountLine(NOW - HOUR, counts(100, 10))]);
    const real = fs.realpathSync.native;
    fs.realpathSync.native = (q) => (String(q).endsWith(`09${path.sep}14`) ? String.raw`\\fileserver\share\codex\14` : real(q));
    t.after(() => { fs.realpathSync.native = real; });
    const res = codexScan(createCodexUsageScanner(), home);
    assert.equal(res.events.length, 0);
    assert.equal(through(res), NOW);
  });
});

/* ----------------------------------------------------------- collector */

test.describe('collector: a failed scan serves an older result and says so', () => {
  const { Collector } = require('../src/core/collector');

  function collector(dir) {
    return new Collector({
      userDataDir: dir,
      projectsRoot: path.join(dir, 'projects'),
      rateLimitsFile: path.join(dir, 'claude-rate-limits.json'),
      rateLimitsDir: dir,
      antigravityQuotaFile: path.join(dir, 'antigravity-quota.json'),
      ideAppDataDir: path.join(dir, 'ide'),
      codexHome: path.join(dir, 'codex'),
      antigravityUsageHome: path.join(dir, 'antigravity-home'),
    });
  }
  const codexCost = (c) => row(c.rebuild(), 'codex').weeklyCost;

  test('Codex: a worker error, then a timeout, mark the held result incomplete; the next result clears it', (t) => {
    quiet(t);
    const c = collector(tmp('src-incomplete-collector-'));
    t.after(() => c.stop());
    // No follow-up dispatch: a full scan counts as just done before each step.
    const settle = () => { c._codexFullAt = Date.now(); c._codexDispatchedAt = Date.now(); };
    const fakeWorker = () => ({ terminate() {}, postMessage() { throw new Error('no dispatch expected'); } });
    const worker = fakeWorker();
    c._codexWorker = worker;
    c._codexEvents = [codexEvent(Date.now() - HOUR)];
    assert.equal(codexCost(c).sourceIncomplete, false);

    settle();
    c._codexInFlight = { id: 1, full: false, timer: null };
    c._onCodexMessage(worker, { type: 'error', id: 1, code: 'ESCAN' });
    assert.equal(codexCost(c).sourceIncomplete, true, 'scan error');

    settle();
    c._codexInFlight = { id: 2, full: false, timer: null };
    c._onCodexMessage(worker, { type: 'result', id: 2, events: [codexEvent(Date.now() - HOUR)], stats: null, unreadRange: null });
    assert.equal(codexCost(c).sourceIncomplete, false, 'a completed result clears it');

    c._codexInFlight = { id: 3, full: true, timer: null };
    c._onCodexWorkerGone(worker); // what the timeout does, via _stopCodexWorker
    assert.equal(codexCost(c).sourceIncomplete, true, 'timeout / crash');

    const next = fakeWorker();
    c._codexWorker = next;
    settle();
    c._codexInFlight = { id: 4, full: true, timer: null };
    c._onCodexMessage(next, { type: 'result', id: 4, events: [codexEvent(Date.now() - HOUR)], stats: null, unreadRange: { fromMs: Date.now() - 3 * HOUR, throughMs: Date.now() - 2 * HOUR } });
    assert.equal(codexCost(c).sourceIncomplete, true, 'the result itself knows of an unread rollout');
  });

  test('Claude: a failed scan marks the store incomplete; a clean scan clears it; a scan with unread files sets it', async (t) => {
    quiet(t);
    const c = collector(tmp('src-incomplete-collector-'));
    t.after(() => c.stop());
    const ts = Date.now() - HOUR;
    const events = [claudeEvent(ts)];
    const ok = (unreadRange) => ({ ok: true, cursors: {}, events, unreadRange, stats: { filesParsed: 0 } });
    const claudeCost = () => row(c.snapshot, 'claude').weeklyCost;

    c._spawnScan = async () => ok(null);
    await c._runScan();
    assert.equal(claudeCost().sourceIncomplete, false);

    c._spawnScan = async () => { throw errno('ETIMEDOUT'); };
    await c._runScan();
    assert.equal(claudeCost().sourceIncomplete, true, 'scan timed out: the store is older than the logs');

    c._spawnScan = async () => ok(null);
    await c._runScan();
    assert.equal(claudeCost().sourceIncomplete, false);

    c._spawnScan = async () => ok({ fromMs: Date.now() - 2 * HOUR, throughMs: Date.now() - 30 * 60 * 1000 });
    await c._runScan();
    assert.equal(claudeCost().sourceIncomplete, true);
  });
});

/* ------------------------------------------------ review round (A3.19-20) */

test.describe('A3.19: a known-incomplete source with nothing readable still delivers a WeeklyCost', () => {
  test.beforeEach(() => rollout._resetPathGuardForTests());

  const FIELDS = [
    'assumedTierEvents', 'byClass', 'byModel', 'cacheWriteEvents', 'fallbackWriteEvents', 'fastRequestedEvents',
    'pricesAsOf', 'sourceIncomplete', 'totalUsd', 'unpricedModels', 'unrecordedWriteEvents', 'windowAnchored',
    'windowEnd', 'windowStart', 'unrecordedCalls', 'longPromptFloorEvents', 'toolTokenEvents',
  ].sort();

  test('Codex: the only rollout is locked, so the scan has no turns — the block says incomplete, not "no token data"', (t) => {
    const home = tmp('src-incomplete-empty-');
    const file = writeRollout(home, [...header(), tokenCountLine(NOW - HOUR, counts(100, 10))]);
    const openSync = fs.openSync;
    t.mock.method(fs, 'openSync', (p, ...rest) => {
      if (path.basename(String(p)) === path.basename(file)) throw errno('EBUSY');
      return openSync(p, ...rest);
    });
    const scanner = createCodexUsageScanner();
    const events = scanner.scan({ now: NOW, startMs: NOW - 7 * DAY, home });
    assert.deepEqual(events, []);
    const snap = build({ events: [], codexEvents: events, codexUnreadRange: scanner.unreadRange() });
    const cost = row(snap, 'codex').weeklyCost;
    assert.ok(cost, 'delivered, not null');
    assert.equal(cost.sourceIncomplete, true);
    assert.equal(cost.totalUsd, 0);
    assert.deepEqual(cost.byModel, []);
    assert.deepEqual(Object.keys(cost).sort(), FIELDS);
    assert.equal(row(snap, 'claude').weeklyCost, null, 'a COMPLETE empty source still reports null');
  });

  test('Claude: a failed scan over an empty store window delivers the empty cost too', () => {
    const snap = build({ events: [], codexEvents: [], scanOk: false });
    const cost = row(snap, 'claude').weeklyCost;
    assert.equal(cost.sourceIncomplete, true);
    assert.equal(cost.totalUsd, 0);
    assert.deepEqual(Object.keys(cost).sort(), FIELDS);
    assert.equal(row(snap, 'codex').weeklyCost, null);
  });

  test('while Codex is pending there is no result to be incomplete: still null', () => {
    const snap = build({ events: [], codexEvents: null, codexReadFailed: true });
    assert.equal(row(snap, 'codex').weeklyCost, null);
  });
});

test.describe('review F2/F5: silent drops are known drops, bounded by the folder date', () => {
  test.beforeEach(() => rollout._resetPathGuardForTests());

  test('Codex: a token_count with an unusable timestamp is unread within its folder\'s reach, not unbounded', () => {
    const home = tmp('src-incomplete-f5-');
    const bad = JSON.stringify({ timestamp: 'not a time', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: counts(150, 15), last_token_usage: counts(50, 5) } } });
    writeRollout(home, [...header(), tokenCountLine(NOW - 3 * HOUR, counts(100, 10)), bad, tokenCountLine(NOW - HOUR, counts(200, 20))]);
    const scanner = createCodexUsageScanner();
    const events = scanner.scan({ now: NOW, startMs: NOW - 7 * DAY, home });
    assert.equal(events.length, 2, 'the turns around it still count');
    const r = scanner.unreadRange();
    const day = new Date(2026, 8, 14).getTime();
    assert.equal(r.fromMs, day, 'from the folder date');
    assert.equal(r.throughMs, NOW, 'through min(now, folder date + 15 days)');
  });

  test('Codex: an untimed over-cap token_count is bounded by the NEXT timestamped record, or now when it is the last', () => {
    const huge = `{"type":"event_msg","payload":{"type":"token_count","pad":"${'a'.repeat(4 * 1024 * 1024 + 10)}"}}`;
    const day = new Date(2026, 7, 20).getTime();
    const write = (lines) => {
      const home = tmp('src-incomplete-f2-');
      const dir = path.join(home, 'sessions', '2026', '08', '20');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'rollout-old.jsonl'), lines.join('\n') + '\n');
      const scanner = createCodexUsageScanner();
      scanner.scan({ now: NOW, startMs: NOW - 60 * DAY, home });
      return scanner.unreadRange();
    };

    // Followed by a turn on Aug 21: no later than that, and the folder span wins.
    const followed = write([...header(), huge, tokenCountLine(day + DAY, counts(100, 10))]);
    assert.deepEqual(followed, { fromMs: day, throughMs: day + 15 * DAY });
    assert.equal(row(build({ codexUnreadRange: followed }), 'codex').weeklyCost.sourceIncomplete, false, 'out of the week');

    // Followed by a turn in the current week (a resumed session): through that turn.
    const resumed = write([...header(), huge, tokenCountLine(NOW - HOUR, counts(100, 10))]);
    assert.deepEqual(resumed, { fromMs: day, throughMs: NOW - HOUR });

    // The last record: it may be as late as now.
    const last = write([...header(), tokenCountLine(day + DAY, counts(100, 10)), huge]);
    assert.equal(last.throughMs, NOW);
    assert.equal(row(build({ codexUnreadRange: last }), 'codex').weeklyCost.sourceIncomplete, true);
  });

  test('Codex: a total that drops with no last_token_usage is a known loss at that record', () => {
    const home = tmp('src-incomplete-f5-');
    const at = NOW - 2 * HOUR;
    const reset = JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: counts(10, 1) } } });
    writeRollout(home, [...header(), tokenCountLine(NOW - 3 * HOUR, counts(100, 10)), reset]);
    const scanner = createCodexUsageScanner();
    scanner.scan({ now: NOW, startMs: NOW - 7 * DAY, home });
    assert.deepEqual(scanner.unreadRange(), { fromMs: at, throughMs: at });
  });

  test('Claude: a usage record with an unusable timestamp is a known loss', async (t) => {
    quiet(t);
    const root = tmp('src-incomplete-f5-');
    const bad = JSON.parse(claudeRecord('x', NOW - HOUR));
    bad.timestamp = 'yesterday-ish';
    const mtime = NOW - 2 * HOUR;
    writeTranscript(root, 'p/a.jsonl', `${claudeRecord('a', NOW - 3 * HOUR)}\n${JSON.stringify(bad)}\n`, mtime);
    const res = await scan({ root, cursors: {}, priorEvents: [], now: NOW });
    assert.equal(res.events.length, 1);
    assert.equal(Math.round(through(res)), mtime);
    assert.equal(extractEvents(`${JSON.stringify(bad)}\n`, 'f').droppedRecords, 1);
  });
});

test.describe('review F4a: a cursor from before the loss accounting is re-read once', () => {
  test('an unchanged file inside retention with a marker-less cursor is parsed again, and its old loss is counted', async (t) => {
    quiet(t);
    const root = tmp('src-incomplete-f4-');
    const mtime = NOW - 2 * HOUR;
    writeTranscript(root, 'p/a.jsonl', `${claudeRecord('a', NOW - 3 * HOUR)}\n{"message":{"usage":{"input_tokens": broken}}}\n`, mtime);
    const fresh = await scan({ root, cursors: {}, priorEvents: [], now: NOW });
    const id = Object.keys(fresh.cursors)[0];
    // What a store written before this change holds: no droppedLines.
    const legacy = { [id]: { size: fresh.cursors[id].size, mtimeMs: fresh.cursors[id].mtimeMs } };
    const res = await scan({ root, cursors: legacy, priorEvents: fresh.events, now: NOW });
    assert.equal(res.stats.filesParsed, 1, 're-read once');
    assert.equal(Math.round(through(res)), mtime);
    assert.equal(res.cursors[id].droppedLines, 1, 'and now accounted');
    const again = await scan({ root, cursors: res.cursors, priorEvents: res.events, now: NOW });
    assert.equal(again.stats.filesParsed, 0, 'only once');
  });

  test('a marker-less cursor for a file older than retention is not re-read', async (t) => {
    quiet(t);
    const root = tmp('src-incomplete-f4-');
    writeTranscript(root, 'p/old.jsonl', `${claudeRecord('a', NOW - 20 * DAY)}\n`, NOW - 20 * DAY);
    const first = await scan({ root, cursors: {}, priorEvents: [], now: NOW });
    const id = Object.keys(first.cursors)[0];
    const res = await scan({ root, cursors: { [id]: { ...first.cursors[id] } }, priorEvents: [], now: NOW });
    assert.equal(res.stats.filesParsed, 0);
    assert.equal(res.unreadRange, null);
  });
});

test.describe('review F7: a Codex read failure repaints at once', () => {
  const { Collector } = require('../src/core/collector');

  test('false -> true rebuilds once; a repeated failure does not rebuild again', (t) => {
    quiet(t);
    const dir = tmp('src-incomplete-f7-');
    const c = new Collector({
      userDataDir: dir,
      projectsRoot: path.join(dir, 'projects'),
      rateLimitsFile: path.join(dir, 'claude-rate-limits.json'),
      rateLimitsDir: dir,
      antigravityQuotaFile: path.join(dir, 'antigravity-quota.json'),
      ideAppDataDir: path.join(dir, 'ide'),
      codexHome: path.join(dir, 'codex'),
      antigravityUsageHome: path.join(dir, 'antigravity-home'),
    });
    t.after(() => c.stop());
    const worker = { terminate() {}, postMessage() { throw new Error('no dispatch expected'); } };
    c._codexWorker = worker;
    c._codexEvents = [codexEvent(Date.now() - HOUR)];
    const snapshots = [];
    c.on('snapshot', (snap) => snapshots.push(snap));
    const settle = () => { c._codexFullAt = Date.now(); c._codexDispatchedAt = Date.now(); };

    settle();
    c._codexInFlight = { id: 1, full: false, timer: null };
    c._onCodexMessage(worker, { type: 'error', id: 1, code: 'ESCAN' });
    assert.equal(snapshots.length, 1, 'rebuilt on the transition');
    assert.equal(row(snapshots[0], 'codex').weeklyCost.sourceIncomplete, true);

    settle();
    c._codexInFlight = { id: 2, full: false, timer: null };
    c._onCodexMessage(worker, { type: 'error', id: 2, code: 'ESCAN' });
    assert.equal(snapshots.length, 1, 'already flagged: no second rebuild');
  });
});

test.describe('A3.20: history periods overlapping a known-unread range are floors', () => {
  const history = require('../src/core/history');
  // Placed relative to NOW and to the LOCAL week of T, so every time zone finds
  // the same two periods (T's week, and the week before it).
  const T = NOW - HOUR;
  const prevWeek = history.weekStartMs(T) - DAY;
  const weekOf = (out, ms) => out.weeks.find((w) => w.startsAt === new Date(history.weekStartMs(ms)).toISOString());
  const claude = [claudeEvent(prevWeek), claudeEvent(T)];
  const codex = [codexEvent(prevWeek), codexEvent(T)];

  test('only the overlapping period is a floor, and incompleteProviders names the tool', () => {
    const out = history.usageHistory(claude, NOW, {
      codexEvents: codex,
      unreadRanges: { codex: [{ fromMs: T - 1000, throughMs: T }] },
    });
    assert.equal(weekOf(out, T).isFloor, true);
    assert.equal(weekOf(out, prevWeek).isFloor, false);
    assert.deepEqual(out.incompleteProviders, ['codex']);
  });

  test('complete sources: no floors, empty list (always present)', () => {
    const out = history.usageHistory(claude, NOW, { codexEvents: codex });
    assert.ok(out.weeks.every((w) => w.isFloor === false));
    assert.deepEqual(out.incompleteProviders, []);
  });

  test('a range before every listed period affects nothing', () => {
    const out = history.usageHistory(claude, NOW, {
      codexEvents: codex,
      unreadRanges: { claude: [{ fromMs: 0, throughMs: 1000 }] },
    });
    assert.deepEqual(out.incompleteProviders, []);
  });

  test('the snapshot passes both tools\' ranges: a failed Claude scan marks the periods since its last good scan', () => {
    const snap = build({ events: claude, codexEvents: codex, scanOk: false, scanGoodAtMs: T - 1000 });
    assert.deepEqual(snap.usageHistory.incompleteProviders, ['claude']);
    assert.equal(weekOf(snap.usageHistory, T).isFloor, true);
    assert.equal(weekOf(snap.usageHistory, prevWeek).isFloor, false, 'the store was read fine up to the last good scan');
  });
});

test.describe('the renderer gate accepts what main now sends (A3.19, A3.20, A3.17-18)', () => {
  const { formatModule } = require('./helpers/load-format');
  const loader = formatModule();
  let s = null;
  test.before(async () => {
    await loader.load();
    s = await loader.sanitize();
  });
  test.after(() => loader.cleanup());

  test('an empty known-incomplete WeeklyCost, the tier counts and incompleteProviders survive sanitize', () => {
    const history = require('../src/core/history');
    const snap = build({ events: [], codexEvents: [], scanOk: false, codexReadFailed: true });
    snap.usageHistory = history.usageHistory([claudeEvent(NOW - HOUR)], NOW, {
      unreadRanges: { claude: [{ fromMs: NOW - 2 * HOUR, throughMs: NOW }] },
    });
    const out = s.sanitizeSnapshot(JSON.parse(JSON.stringify(snap)));
    assert.ok(out, 'accepted');
    const claude = out.providers.find((p) => p.id === 'claude').weeklyCost;
    assert.equal(claude.sourceIncomplete, true);
    assert.equal(claude.totalUsd, 0);
    assert.equal(claude.assumedTierEvents, 0);
    assert.equal(claude.fastRequestedEvents, 0);
    assert.equal(out.providers.find((p) => p.id === 'codex').weeklyCost.sourceIncomplete, true, 'failed read over an empty result');
    assert.deepEqual(out.usageHistory.incompleteProviders, ['claude']);
  });
});

/* ---------------------------------------------- final round (review F1-F8) */

test.describe('review F1: a torn last line whose writer died is counted once the grace passes', () => {
  test.beforeEach(() => rollout._resetPathGuardForTests());

  test('Claude: excused while fresh (kept on the cursor as tornLines), a loss on the unchanged rescan after the grace', async (t) => {
    quiet(t);
    const root = tmp('src-incomplete-final-');
    const whole = claudeRecord('b', NOW - 2 * 60 * 1000);
    const mtime = NOW - 60 * 1000;
    writeTranscript(root, 'p/a.jsonl', `${claudeRecord('a', NOW - HOUR)}\n${whole.slice(0, whole.length - 20)}`, mtime);
    const first = await scan({ root, cursors: {}, priorEvents: [], now: NOW });
    const id = Object.keys(first.cursors)[0];
    assert.equal(first.unreadRange, null, 'a write in progress');
    assert.equal(first.cursors[id].tornLines, 1);
    assert.equal(first.cursors[id].droppedLines, 0);

    const soon = await scan({ root, cursors: first.cursors, priorEvents: first.events, now: NOW + 60 * 1000 });
    assert.equal(soon.stats.filesParsed, 0);
    assert.equal(soon.unreadRange, null, 'still inside the grace');

    const later = NOW + TORN_WRITE_GRACE_MS;
    const dead = await scan({ root, cursors: soon.cursors, priorEvents: soon.events, now: later });
    assert.equal(dead.stats.filesParsed, 0, 'unchanged: not re-read');
    assert.equal(Math.round(through(dead)), mtime, 'the writer is gone: a lost record');
    assert.equal(dead.cursors[id].droppedLines, 1);
    assert.equal(dead.cursors[id].tornLines, undefined, 'folded into droppedLines');
    const again = await scan({ root, cursors: dead.cursors, priorEvents: dead.events, now: later + HOUR });
    assert.equal(Math.round(through(again)), mtime, 'and it stays counted');
  });

  test('Claude F3: an unchanged file older than retention reports no unread range, even with dropped lines', async (t) => {
    quiet(t);
    const root = tmp('src-incomplete-final-');
    const mtime = NOW - 20 * DAY;
    writeTranscript(root, 'p/old.jsonl', `${claudeRecord('a', mtime)}\n`, mtime);
    const first = await scan({ root, cursors: {}, priorEvents: [], now: NOW });
    const id = Object.keys(first.cursors)[0];
    const cursors = { [id]: { ...first.cursors[id], droppedLines: 3 } };
    const res = await scan({ root, cursors, priorEvents: [], now: NOW });
    assert.equal(res.unreadRange, null, 'nothing of it is in the store, so nothing of it is missing from the store');
  });

  function codexTailHome(tail, mtimeMs) {
    const home = tmp('src-incomplete-final-');
    const file = writeRollout(home, [...header(), tokenCountLine(NOW - 3 * HOUR, counts(100, 10))]);
    fs.appendFileSync(file, tail); // no newline after it
    fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
    return { home, file };
  }

  test('Codex: a truncated token_count tail is left alone while fresh, a loss once the file has been idle past the grace', () => {
    const at = NOW - 2 * HOUR;
    const torn = tokenCountLine(at, counts(200, 20)).slice(0, -15);
    const fresh = codexTailHome(torn, NOW - 60 * 1000);
    assert.equal(codexScan(createCodexUsageScanner(), fresh.home).unreadRange, null, 'a write in progress');

    const idle = codexTailHome(torn, NOW - TORN_WRITE_GRACE_MS - 60 * 1000);
    const res = codexScan(createCodexUsageScanner(), idle.home);
    assert.deepEqual(res.unreadRange, { fromMs: at, throughMs: at });
    assert.equal(res.events.length, 1, 'the complete turn before it still counts');
  });

  test('Codex: an idle tail that is a whole record is counted; if the writer comes back the file is re-read, never counted twice', () => {
    const tail = tokenCountLine(NOW - 2 * HOUR, counts(200, 20));
    const { home, file } = codexTailHome(tail, NOW - TORN_WRITE_GRACE_MS - 60 * 1000);
    const scanner = createCodexUsageScanner();
    const first = codexScan(scanner, home);
    assert.equal(first.events.length, 2);
    assert.equal(first.unreadRange, null);
    assert.equal(codexScan(scanner, home).events.length, 2, 'unchanged: nothing more');

    fs.appendFileSync(file, `\n${tokenCountLine(NOW - HOUR, counts(300, 30))}\n`);
    fs.utimesSync(file, NOW / 1000, NOW / 1000);
    const again = codexScan(scanner, home);
    assert.equal(again.events.length, 3);
    const out = again.events.reduce((a, e) => a + e.output, 0);
    assert.equal(out, 30, 'deltas 10 + 10 + 10: the tail turn counted once');
  });
});

test.describe('review F2: an unreadable rollout reaches as far as the turns already read from it', () => {
  test.beforeEach(() => rollout._resetPathGuardForTests());

  test('a rollout in an August folder with September turns fails to read: the September week is a floor', (t) => {
    const home = tmp('src-incomplete-final-');
    const dir = path.join(home, 'sessions', '2026', '08', '10');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'rollout-resumed.jsonl');
    const late = NOW - 2 * HOUR; // September, 35 days after the folder date
    fs.writeFileSync(file, [...header(), tokenCountLine(Date.parse('2026-08-10T12:00:00Z'), counts(100, 10)), tokenCountLine(late, counts(200, 20))].join('\n') + '\n');
    fs.utimesSync(file, late / 1000, late / 1000);
    const scanner = createCodexUsageScanner();
    const opts = { now: NOW, startMs: NOW - 30 * DAY, home };
    assert.equal(scanner.scan(opts).length, 1, 'the September turn (the August one is before startMs)');

    // Changed (new mtime, same size) and now unreadable.
    fs.utimesSync(file, (late + 1000) / 1000, (late + 1000) / 1000);
    const openSync = fs.openSync;
    t.mock.method(fs, 'openSync', (p, ...rest) => {
      if (path.basename(String(p)) === 'rollout-resumed.jsonl') throw errno('EBUSY');
      return openSync(p, ...rest);
    });
    scanner.scan(opts);
    const r = scanner.unreadRange();
    assert.equal(r.throughMs, late, 'the latest turn already read, not folder date + 15 days');
    assert.equal(row(build({ codexUnreadRange: r }), 'codex').weeklyCost.sourceIncomplete, true);
  });

  test('a rollout that GREW since its last read and then fails reaches through now', (t) => {
    const home = tmp('src-incomplete-final-');
    const dir = path.join(home, 'sessions', '2026', '08', '10');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'rollout-grew.jsonl');
    fs.writeFileSync(file, [...header(), tokenCountLine(Date.parse('2026-08-10T12:00:00Z'), counts(100, 10))].join('\n') + '\n');
    const scanner = createCodexUsageScanner();
    const opts = { now: NOW, startMs: NOW - 60 * DAY, home };
    scanner.scan(opts);
    fs.appendFileSync(file, tokenCountLine(NOW - HOUR, counts(200, 20)) + '\n');
    const openSync = fs.openSync;
    t.mock.method(fs, 'openSync', (p, ...rest) => {
      if (path.basename(String(p)) === 'rollout-grew.jsonl') throw errno('EACCES');
      return openSync(p, ...rest);
    });
    scanner.scan(opts);
    assert.equal(scanner.unreadRange().throughMs, NOW);
  });
});

test.describe('review F4: a failure range meets a window ending at now', () => {
  test('a failed Codex read whose last good read is "now" still marks the week', () => {
    const snap = build({ codexReadFailed: true, codexReadGoodAtMs: NOW });
    assert.equal(row(snap, 'codex').weeklyCost.sourceIncomplete, true);
  });
});

test.describe('review F6: history per-model floors and the no-period case', () => {
  const history = require('../src/core/history');

  test('every model entry of an affected tool is a floor; the other tool entries are not', () => {
    const T = NOW - HOUR;
    const out = history.usageHistory([claudeEvent(T)], NOW, {
      codexEvents: [codexEvent(T)],
      unreadRanges: { codex: [{ fromMs: T - 1000, throughMs: T }] },
    });
    const week = out.weeks.find((w) => w.startsAt === new Date(history.weekStartMs(T)).toISOString());
    assert.equal(week.byModel.find((e) => e.provider === 'codex').isFloor, true);
    assert.equal(week.byModel.find((e) => e.provider === 'claude').isFloor, false);
  });

  test('with no periods at all, a known gap is still named', () => {
    const out = history.usageHistory([], NOW, {
      unreadRanges: { codex: [{ fromMs: NOW - DAY, throughMs: NOW }] },
    });
    assert.deepEqual(out.weeks, []);
    assert.deepEqual(out.incompleteProviders, ['codex']);
    assert.deepEqual(history.usageHistory([], NOW, {}).incompleteProviders, []);
  });
});

test.describe('review F7: a failed dispatch repaints through the same transition', () => {
  const { Collector } = require('../src/core/collector');

  test('worker creation throws: flagged, rebuilt once', (t) => {
    quiet(t);
    const dir = tmp('src-incomplete-final-');
    const c = new Collector({
      userDataDir: dir,
      projectsRoot: path.join(dir, 'projects'),
      rateLimitsFile: path.join(dir, 'claude-rate-limits.json'),
      rateLimitsDir: dir,
      antigravityQuotaFile: path.join(dir, 'antigravity-quota.json'),
      ideAppDataDir: path.join(dir, 'ide'),
      codexHome: path.join(dir, 'codex'),
      antigravityUsageHome: path.join(dir, 'antigravity-home'),
    });
    t.after(() => c.stop());
    c._codexEvents = [codexEvent(Date.now() - HOUR)];
    c._ensureCodexWorker = () => { throw errno('ENOMEM'); };
    const snapshots = [];
    c.on('snapshot', (snap) => snapshots.push(snap));
    c._requestCodexScan({ full: true }, Date.now());
    assert.equal(c._codexReadFailed, true);
    assert.equal(snapshots.length, 1);
    assert.equal(row(snapshots[0], 'codex').weeklyCost.sourceIncomplete, true);
  });
});

test.describe('review F8: eligibility inside one folded 15-minute slot', () => {
  const { codexCost } = require('../src/core/codex/pricing');

  test('a pre- and a post-settings turn in the SAME slot: the pre-settings one is backfilled, and an appended flex unprices only it', () => {
    const home = tmp('src-incomplete-final-');
    const slot = Math.floor((NOW - 2 * DAY) / (15 * 60 * 1000)) * 15 * 60 * 1000;
    const settings = (tier) => JSON.stringify({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { service_tier: tier } } });
    const file = writeRollout(home, [
      JSON.stringify({ type: 'session_meta', payload: { model: 'gpt-5.6-sol' } }),
      tokenCountLine(slot + 60 * 1000, counts(100000, 10000)), // before any settings record
      settings('default'),
      tokenCountLine(slot + 5 * 60 * 1000, counts(200000, 20000)), // same 15-minute slot
    ]);
    const scanner = createCodexUsageScanner();
    const opts = { now: NOW, startMs: NOW - 7 * DAY, home, rawSinceMs: NOW };
    const first = scanner.scan(opts);
    assert.equal(first.length, 2, 'two buckets for one slot: pre-settings kept apart');
    assert.ok(first.every((e) => e.count === 1 && e.ts === slot));
    // The pre-settings bucket takes the first record's tier (backfill, 2026-09-23).
    assert.deepEqual(first.map((e) => [e.tier, e.preSettings, e.tierAssumable]),
      [['standard', undefined, undefined], ['standard', undefined, undefined]]);
    // 100K uncached with 0 recorded writes: priced at the $5 write rate (upper bound).
    const one = Math.round((0.1 * 5 + 0.01 * 20) * 1e6) / 1e6;
    const before = codexCost(first, NOW - 7 * DAY, NOW, false);
    assert.equal(before.assumedTierEvents, 0, 'backfilled, not assumed');
    assert.equal(before.totalUsd, Math.round(2 * one * 1e6) / 1e6);

    fs.appendFileSync(file, settings('flex') + '\n');
    const after = codexCost(scanner.scan(opts), NOW - 7 * DAY, NOW, false);
    assert.equal(after.assumedTierEvents, 0);
    assert.equal(after.totalUsd, one, 'the post-settings (default) turn stays priced');
    assert.deepEqual(after.byModel.map((m) => [m.speed, m.usd === null]).sort(), [['standard', false], ['unknown-tier', true]]);
  });
});
