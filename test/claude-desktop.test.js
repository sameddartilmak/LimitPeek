'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const desktop = require('../src/core/claude-desktop');
const { mergeDesktopReading } = require('../src/core/ratelimits');
const { scan } = require('../src/core/scan/scanner');
const archiveMod = require('../src/core/scan/archive');
const agg = require('../src/core/aggregate');

// Owner, 2026-09-29: the panel only knew Claude usage through Claude Code.
// The desktop app's plan-usage samples and its Cowork transcripts are read too.
// Every fixture is a temp directory: the real desktop app is never touched.

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = new Date(2026, 8, 29, 12, 0, 0).getTime();
const ORG = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-2222-3333-4444-555555555555';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `usage-notch-desktop-${prefix}-`));
}

function history(dir, samples) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plan-usage-history.json'), JSON.stringify({ version: 2, samples }));
}

function sample(t, fh, sd, org = ORG) {
  return { t, org, u: { fh, sd } };
}

/* ------------------------------------------------------ plan-usage history */

test('the newest sample is the reading, whatever the file order', () => {
  const dir = tmp('hist');
  history(dir, [sample(NOW - 10 * 60000, 44, 18), sample(NOW - 40 * 60000, 20, 15), sample(NOW - 25 * 60000, 30, 16)]);
  assert.deepEqual(desktop.readDesktopPlanUsage({ dirs: [dir], now: NOW }),
    { atMs: NOW - 10 * 60000, fiveHour: 44, sevenDay: 18 });
});

test('a sample for another organization never stands in for Claude Code\'s account', () => {
  const dir = tmp('org');
  history(dir, [sample(NOW - 5 * 60000, 90, 90, OTHER), sample(NOW - 20 * 60000, 10, 12, ORG)]);
  assert.equal(desktop.readDesktopPlanUsage({ dirs: [dir], now: NOW, org: ORG }).fiveHour, 10);
  // Unknown Claude Code account (no Claude Code at all): the newest is taken.
  assert.equal(desktop.readDesktopPlanUsage({ dirs: [dir], now: NOW, org: null }).fiveHour, 90);
});

test('samples from the future, out of range or malformed are skipped', () => {
  const dir = tmp('bad');
  history(dir, [
    sample(NOW + HOUR, 5, 5),
    sample(NOW - 1000, 140, -3),
    { t: 'yesterday', u: { fh: 1, sd: 1 } },
    null,
    sample(NOW - 2000, 33, 12),
  ]);
  assert.deepEqual(desktop.readDesktopPlanUsage({ dirs: [dir], now: NOW }), { atMs: NOW - 2000, fiveHour: 33, sevenDay: 12 });
});

test('no file, a torn file or an oversized file is no reading, never a throw', () => {
  const none = tmp('none');
  assert.equal(desktop.readDesktopPlanUsage({ dirs: [none], now: NOW }), null);
  const torn = tmp('torn');
  fs.writeFileSync(path.join(torn, 'plan-usage-history.json'), '{"version":2,"samples":[{"t":1');
  assert.equal(desktop.readDesktopPlanUsage({ dirs: [torn], now: NOW }), null);
  const big = tmp('big');
  fs.writeFileSync(path.join(big, 'plan-usage-history.json'), ' '.repeat(desktop.MAX_HISTORY_BYTES + 1));
  assert.equal(desktop.readDesktopPlanUsage({ dirs: [big], now: NOW }), null);
});

test('Claude Code\'s organization comes from ~/.claude.json, and nothing else of it', () => {
  const dir = tmp('cj');
  const file = path.join(dir, '.claude.json');
  fs.writeFileSync(file, JSON.stringify({ oauthAccount: { organizationUuid: ORG, emailAddress: 'x@example.com' }, projects: {} }));
  assert.equal(desktop.claudeCodeOrg(file), ORG);
  assert.equal(desktop.claudeCodeOrg(path.join(dir, 'missing.json')), null);
});

test('the desktop directories are the classic and the Store install locations', () => {
  const root = tmp('dirs');
  const env = { APPDATA: path.join(root, 'Roaming'), LOCALAPPDATA: path.join(root, 'Local') };
  const classic = path.join(env.APPDATA, 'Claude');
  const store = path.join(env.LOCALAPPDATA, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude');
  fs.mkdirSync(classic, { recursive: true });
  fs.mkdirSync(store, { recursive: true });
  fs.mkdirSync(path.join(env.LOCALAPPDATA, 'Packages', 'SomethingElse_abc', 'LocalCache', 'Roaming', 'Claude'), { recursive: true });
  assert.deepEqual(desktop.claudeDesktopDirs(env).sort(), [classic, store].sort());
});

test('the Store package\'s moved data folder (%LOCALAPPDATA%\\Claude-Data\\claude_<publisher>) is found too', () => {
  const root = tmp('dirs-moved');
  const env = { APPDATA: path.join(root, 'Roaming'), LOCALAPPDATA: path.join(root, 'Local') };
  // The old Store folder is left with only a marker file after the move.
  const oldStore = path.join(env.LOCALAPPDATA, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude');
  fs.mkdirSync(oldStore, { recursive: true });
  fs.writeFileSync(path.join(oldStore, '.user-data-left.claude_pzs8sxrjxfjjc'), '');
  const moved = path.join(env.LOCALAPPDATA, 'Claude-Data', 'claude_pzs8sxrjxfjjc');
  fs.mkdirSync(moved, { recursive: true });
  fs.mkdirSync(path.join(env.LOCALAPPDATA, 'Claude-Data', 'other-thing'), { recursive: true });
  const dirs = desktop.claudeDesktopDirs(env);
  assert.ok(dirs.includes(moved), 'the new location');
  assert.ok(!dirs.some((d) => d.endsWith('other-thing')), 'only claude_<publisher> folders');
});

/* ----------------------------------------------------------------- merging */

const H5 = NOW + 2 * HOUR;
const D7 = NOW + 3 * DAY;

function bridge(capturedAtMs, five, seven, state = 'fresh') {
  return {
    state, capturedAt: new Date(capturedAtMs).toISOString(), capturedAtMs, ageMs: NOW - capturedAtMs,
    fiveHour: { usedPercentage: five, resetsAtMs: H5 }, sevenDay: { usedPercentage: seven, resetsAtMs: D7 },
  };
}

test('a bridge capture with the higher figure stands', () => {
  const rl = bridge(NOW - 60000, 40, 20);
  assert.equal(mergeDesktopReading(rl, { atMs: NOW - 10 * 60000, fiveHour: 30, sevenDay: 19 }, NOW), rl);
});

test('an idle session re-render never hides a higher desktop figure for the same window', () => {
  // Owner, 2026-09-29: an idle Claude Code session re-rendered its last
  // request's 25% at 11:05; the desktop app had written 67% at 11:00.
  const out = mergeDesktopReading(bridge(NOW - 60000, 25, 35), { atMs: NOW - 6 * 60000, fiveHour: 67, sevenDay: 44 }, NOW);
  assert.equal(out.state, 'fresh');
  assert.equal(out.capturedAtMs, NOW - 60000);
  assert.deepEqual(out.fiveHour, { usedPercentage: 67, resetsAtMs: H5 });
  assert.deepEqual(out.sevenDay, { usedPercentage: 44, resetsAtMs: D7 });
});

test('a newer desktop sample in the same windows keeps their reset instants', () => {
  const out = mergeDesktopReading(bridge(NOW - 3 * HOUR, 10, 15, 'stale'), { atMs: NOW - 60000, fiveHour: 37, sevenDay: 17 }, NOW);
  assert.equal(out.state, 'fresh');
  assert.equal(out.source, 'desktop');
  assert.equal(out.capturedAtMs, NOW - 60000);
  assert.deepEqual(out.fiveHour, { usedPercentage: 37, resetsAtMs: H5 });
  assert.deepEqual(out.sevenDay, { usedPercentage: 17, resetsAtMs: D7 });
});

test('a desktop sample from before the bridge window says nothing about it', () => {
  const rl = bridge(NOW - 60000, 5, 35);
  const out = mergeDesktopReading(rl, { atMs: H5 - 6 * HOUR, fiveHour: 90, sevenDay: 30 }, NOW);
  assert.equal(out, rl);
});

test('a desktop sample past the bridge\'s reset is a new window with no known reset', () => {
  const rl = bridge(NOW - 6 * HOUR, 80, 15, 'stale');
  rl.fiveHour.resetsAtMs = NOW - HOUR;
  const out = mergeDesktopReading(rl, { atMs: NOW - 60000, fiveHour: 4, sevenDay: 22 }, NOW);
  assert.deepEqual(out.fiveHour, { usedPercentage: 4, resetsAtMs: null });
  assert.deepEqual(out.sevenDay, { usedPercentage: 22, resetsAtMs: D7 });
});

test('with no Claude Code capture at all, the desktop sample is the reading', () => {
  const out = mergeDesktopReading({ state: 'missing', fiveHour: null, sevenDay: null }, { atMs: NOW - 5 * 60000, fiveHour: 12, sevenDay: 30 }, NOW);
  assert.equal(out.state, 'fresh');
  assert.deepEqual(out.fiveHour, { usedPercentage: 12, resetsAtMs: null });
  // An old sample is only "as of", and with no reset instant `windowFrom` drops it.
  const old = mergeDesktopReading({ state: 'missing', fiveHour: null, sevenDay: null }, { atMs: NOW - 2 * HOUR, fiveHour: 12, sevenDay: 30 }, NOW);
  assert.equal(old.state, 'stale');
});

test('no desktop sample leaves the bridge reading untouched', () => {
  const rl = bridge(NOW - HOUR, 10, 10, 'stale');
  assert.equal(mergeDesktopReading(rl, null, NOW), rl);
});

/* ------------------------------------------------------------------ Cowork */

function rec(at, requestId, output = 100) {
  return {
    timestamp: new Date(at).toISOString(), requestId, sessionId: 's', uuid: `u-${requestId}`,
    message: { id: `m-${requestId}`, model: 'claude-opus-5', usage: { input_tokens: 1000, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  };
}

function write(file, records, mtimeMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

function coworkTree() {
  const dir = tmp('cowork');
  const projects = path.join(dir, 'local-agent-mode-sessions', 'a', 'b', 'local_c', '.claude', 'projects');
  // Not a transcript root: outputs and uploads beside it are never listed.
  fs.mkdirSync(path.join(dir, 'local-agent-mode-sessions', 'a', 'b', 'local_c', 'outputs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'local-agent-mode-sessions', 'a', 'b', 'other', '.claude', 'projects'), { recursive: true });
  return { dir, projects };
}

test('Cowork transcript roots are found at the depth the desktop app writes them', () => {
  const { dir, projects } = coworkTree();
  fs.mkdirSync(projects, { recursive: true });
  assert.deepEqual(desktop.coworkProjectRoots([dir]), [projects]);
  assert.deepEqual(desktop.coworkProjectRoots([tmp('empty')]), []);
});

test('Cowork records are counted beside Claude Code\'s', async () => {
  const main = tmp('main');
  const { projects } = coworkTree();
  write(path.join(main, 'p', 'x.jsonl'), [rec(NOW - HOUR, 'r1')], NOW - HOUR);
  write(path.join(projects, 'q', 'y.jsonl'), [rec(NOW - 2 * HOUR, 'c1')], NOW - 2 * HOUR);
  const res = await scan({ root: main, extraRoots: [projects], cursors: {}, priorEvents: [], now: NOW });
  assert.equal(res.ok, true);
  assert.deepEqual(agg.dedupe(res.events).map((e) => e.key).sort(), ['c1', 'r1']);
});

test('an existing archive takes in the Cowork history before its frontier exactly once', async () => {
  const main = tmp('main2');
  const { projects } = coworkTree();
  const july = new Date(2026, 6, 10, 10).getTime();
  write(path.join(main, 'p', 'old.jsonl'), [rec(new Date(2026, 6, 5, 10).getTime(), 'o1')], new Date(2026, 6, 5, 11).getTime());
  write(path.join(main, 'p', 'new.jsonl'), [rec(NOW - HOUR, 'n1')], NOW - HOUR);
  // The archive as it was built before Cowork was read.
  const first = await scan({ root: main, cursors: {}, priorEvents: [], archive: null, now: NOW });
  assert.equal(archiveMod.hasSource(first.archive, 'cowork'), false);
  const rowsBefore = first.archive.rows.reduce((n, r) => n + r.n, 0);

  write(path.join(projects, 'q', 'july.jsonl'), [rec(july, 'c1', 500), rec(july + 1000, 'c2', 700)], july + 2000);
  write(path.join(projects, 'q', 'now.jsonl'), [rec(NOW - 30 * 60000, 'c3')], NOW - 30 * 60000);
  const second = await scan({
    root: main, extraRoots: [projects], cursors: first.cursors, priorEvents: first.events, archive: first.archive, now: NOW,
  });
  assert.equal(second.archiveChanged, true);
  assert.equal(archiveMod.hasSource(second.archive, 'cowork'), true);
  assert.equal(second.archive.rows.reduce((n, r) => n + r.n, 0), rowsBefore + 2);
  assert.equal(second.archive.rows.reduce((n, r) => n + r.output, 0), 100 + 500 + 700);
  // The recent Cowork record is in the raw store, not the archive.
  assert.ok(second.events.some((e) => e.key === 'c3'));

  const third = await scan({
    root: main, extraRoots: [projects], cursors: second.cursors, priorEvents: second.events, archive: second.archive, now: NOW + 60000,
  });
  assert.equal(third.archive, second.archive);
  assert.equal(agg.dedupe(third.events).filter((e) => e.key === 'c3').length, 1);
});

test('a first build with Cowork roots records them as already held', async () => {
  const main = tmp('main3');
  const { projects } = coworkTree();
  write(path.join(projects, 'q', 'july.jsonl'), [rec(new Date(2026, 6, 10, 10).getTime(), 'c1')], new Date(2026, 6, 10, 11).getTime());
  const res = await scan({ root: main, extraRoots: [projects], cursors: {}, priorEvents: [], archive: null, now: NOW });
  assert.equal(archiveMod.hasSource(res.archive, 'cowork'), true);
  assert.equal(res.archive.rows.reduce((n, r) => n + r.n, 0), 1);
});

test('an archive\'s sources survive a save and a load', () => {
  const stored = archiveMod.withSource({ ...archiveMod.emptyArchive(), frontierMs: NOW }, 'cowork');
  assert.equal(archiveMod.hasSource(archiveMod.fromStored(JSON.parse(JSON.stringify(stored))), 'cowork'), true);
  const advanced = archiveMod.advance(archiveMod.fromStored(stored), NOW + DAY, [], null);
  assert.equal(archiveMod.hasSource(advanced, 'cowork'), true);
});

test('a Cowork root that vanished is not a failed scan', async () => {
  const main = tmp('main4');
  write(path.join(main, 'p', 'x.jsonl'), [rec(NOW - HOUR, 'r1')], NOW - HOUR);
  const res = await scan({ root: main, extraRoots: [path.join(main, 'gone')], cursors: {}, priorEvents: [], now: NOW });
  assert.equal(res.ok, true);
  assert.equal(res.unreadRange, null);
});
