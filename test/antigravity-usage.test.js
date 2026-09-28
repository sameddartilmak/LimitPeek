'use strict';

/**
 * Antigravity token usage (src/core/antigravity/usage.js, cost.js) and its
 * wiring into the Antigravity row.
 *
 * Every store here is SYNTHETIC: written by this file through the project's own
 * SQLite loader, with protobuf bytes built by the hand-written encoder in
 * helpers/agy-store.js. The field numbers mirror the shapes seen on a live
 * machine (2026-09-24); no real conversation data is in the repository.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { lenField, varintField } = require('./helpers/agy-store');
const { loadSqlite } = require('../src/core/antigravity/sqlite');
const {
  createAntigravityUsageScanner, antigravityUsageEvents, sumAntigravityTokens, antigravityUsageInstallDir,
} = require('../src/core/antigravity/usage');
const { antigravityCost, priceFor } = require('../src/core/antigravity/cost');
const geminiPricing = require('../src/core/antigravity/gemini-pricing');
const { buildSnapshot, _resetHistoryMemoForTests } = require('../src/core/snapshot');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const WEEK_START = NOW - 7 * DAY;
const MTOK = 1e6;

const SESSION_MARKER = 'SESSION-KEY-MARKER-f8';
const BLOB_MARKER = 'ENCRYPTED-BLOB-MARKER-g8';
const TEXT_MARKER = 'CONVERSATION-TEXT-MARKER';

function tmpDir(prefix = 'agy-usage-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

/* ------------------------------------------------------------ protobuf fixtures */

/** The usage message (steps.metadata field 9). Zero counts are omitted, as proto3 does. */
function usageMsg(o) {
  const parts = [];
  const put = (field, v) => { if (v) parts.push(varintField(field, v)); };
  put(1, o.model ?? 1318);
  put(2, o.input);
  put(3, o.output);
  put(4, o.cacheWrite);
  put(5, o.cacheRead);
  put(6, o.provider ?? 24);
  parts.push(lenField(7, 'msg-id'));
  // A key/value the reader must never decode or keep.
  parts.push(lenField(8, Buffer.concat([lenField(1, 'sessionID'), lenField(2, SESSION_MARKER)])));
  put(9, o.thinking);
  put(10, o.response);
  if (o.id !== null) parts.push(lenField(11, o.id));
  for (const extra of o.extra || []) parts.push(extra);
  return Buffer.concat(parts);
}

/** A steps.metadata blob. `usage` omitted means a step that is not a model call. */
function stepMeta(ms, usage, over = {}) {
  const seconds = Math.floor(ms / 1000);
  const nanos = (ms % 1000) * 1e6;
  const parts = [lenField(1, Buffer.concat([varintField(1, seconds), ...(nanos ? [varintField(2, nanos)] : [])]))];
  // Unknown siblings the reader must skip.
  parts.push(varintField(3, 7), lenField(12, 'sibling'), lenField(20, Buffer.from([0x08, 0x01])));
  if (usage) parts.push(lenField(9, usage));
  if (over.twice) parts.push(lenField(9, usage));
  return Buffer.concat(parts);
}

/** A gen_metadata blob naming the model of one response. */
function genMeta(id, name, modelEnum = 1318) {
  const inner = Buffer.concat([
    varintField(3, 1),
    lenField(4, Buffer.concat([varintField(1, modelEnum), lenField(11, id)])),
    lenField(8, BLOB_MARKER),
    lenField(19, name),
  ]);
  return Buffer.concat([lenField(2, 'x'), lenField(4, 'y'), lenField(8, BLOB_MARKER), lenField(1, inner)]);
}

/** A call record: step + optional name. */
function call(id, ms, o = {}) {
  return { id, ms, name: o.name, usage: usageMsg({ id, ...o }) };
}

/* ------------------------------------------------------------ stores */

const SCHEMA = `
  CREATE TABLE steps (idx INTEGER PRIMARY KEY, content TEXT, metadata BLOB);
  CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
`;

function storePath(home, root, uuid) {
  const dir = path.join(home, root, 'conversations');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${uuid}.db`);
}

function insertCalls(db, calls, plain = []) {
  const step = db.prepare('INSERT INTO steps (content, metadata) VALUES (?, ?)');
  const gen = db.prepare('INSERT INTO gen_metadata (data) VALUES (?)');
  for (const c of calls) {
    step.run(TEXT_MARKER, c.raw || stepMeta(c.ms, c.usage));
    if (c.name) gen.run(genMeta(c.id, c.name, c.genEnum));
  }
  for (const ms of plain) step.run(TEXT_MARKER, stepMeta(ms, null));
}

/** A closed store in the default rollback-journal mode. */
function writeStore(file, calls, plain = []) {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  insertCalls(db, calls, plain);
  db.close();
  return file;
}

let uuidSeq = 0;
function uuid() {
  uuidSeq += 1;
  return `00000000-0000-4000-8000-${String(uuidSeq).padStart(12, '0')}`;
}

function scan(home, over = {}) {
  const scanner = over.scanner || createAntigravityUsageScanner();
  const events = scanner.scan({ now: NOW, startMs: WEEK_START, home, ...over.options });
  return { scanner, events, stats: scanner.stats(), unread: scanner.unreadRange() };
}

/* ------------------------------------------------------------ the reader */

test.describe('the Antigravity conversation-store reader', () => {
  test('decodes a model call: time, named model, counts; steps without usage are skipped', () => {
    const home = tmpDir();
    writeStore(storePath(home, 'antigravity-cli', uuid()), [
      call('resp-a', NOW - HOUR, { name: 'gemini-3.8-flash', input: 11675, output: 169, thinking: 100, response: 69 }),
      call('resp-b', NOW - 2 * HOUR, { name: 'gemini-3.8-flash', input: 11912, output: 300, cacheRead: 50 }),
    ], [NOW - 3 * HOUR]);
    const { events, stats, unread } = scan(home);
    assert.equal(stats.files, 1);
    assert.equal(stats.refused, 0);
    assert.equal(unread, null);
    assert.deepEqual(events.map((e) => [e.ts, e.model, e.input, e.output, e.cacheRead, e.cacheWrite]), [
      [NOW - 2 * HOUR, 'gemini-3.8-flash', 11912, 300, 50, 0],
      [NOW - HOUR, 'gemini-3.8-flash', 11675, 169, 0, 0],
    ]);
    const sum = sumAntigravityTokens(events, WEEK_START, NOW);
    assert.deepEqual(sum.tokens, { input: 23587, output: 469, cacheWrite: 0, cacheRead: 50, billable: 24056 });
    assert.deepEqual(sum.byModel, [{ model: 'gemini-3.8-flash', billable: 24056 }]);
  });

  test('a response gen_metadata does not name falls back to the enum table; an unknown enum reads unknown', () => {
    const home = tmpDir();
    writeStore(storePath(home, 'antigravity-ide', uuid()), [
      call('r1', NOW - HOUR, { model: 1026, provider: 26, input: 10, output: 5 }),
      call('r2', NOW - HOUR, { model: 1050, input: 7, output: 3 }),
      call('r3', NOW - HOUR, { model: 1318, input: 1, output: 1, name: 'not a model id!' }),
    ]);
    const models = scan(home).events.map((e) => e.model).sort();
    assert.deepEqual(models, ['claude-opus-4-6-thinking', 'gemini-3.8-flash', 'unknown']);
  });

  test('a response id is counted once across every store and every root', () => {
    const home = tmpDir();
    const shared = call('same-response', NOW - HOUR, { name: 'gemini-3.8-flash', input: 1000, output: 10 });
    writeStore(storePath(home, 'antigravity-cli', uuid()), [shared, call('only-cli', NOW - HOUR, { input: 1, output: 1 })]);
    writeStore(storePath(home, 'antigravity-ide', uuid()), [shared]);
    writeStore(storePath(home, 'antigravity', uuid()), [shared, call('only-old', NOW - HOUR, { input: 2, output: 2 })]);
    const { events, stats } = scan(home);
    assert.equal(stats.files, 3);
    assert.equal(stats.ids, 3);
    assert.equal(sumAntigravityTokens(events, WEEK_START, NOW).tokens.input, 1003);
  });

  test('steps that live only in the -wal are read', () => {
    const home = tmpDir();
    const file = storePath(home, 'antigravity-cli', uuid());
    const { DatabaseSync } = loadSqlite();
    const writer = new DatabaseSync(file);
    try {
      writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
      writer.exec(SCHEMA);
      writer.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      insertCalls(writer, [call('wal-only', NOW - HOUR, { name: 'gemini-3.8-flash', input: 500, output: 5 })]);
      assert.ok(fs.statSync(`${file}-wal`).size > 0, 'the call is in the WAL, not yet in the .db');
      const { events } = scan(home);
      assert.deepEqual(events.map((e) => [e.model, e.input]), [['gemini-3.8-flash', 500]]);
    } finally {
      writer.close();
    }
  });

  test('a store with no -wal on disk is opened without creating one (nothing is left beside it)', () => {
    const home = tmpDir();
    const file = storePath(home, 'antigravity-cli', uuid());
    const { DatabaseSync } = loadSqlite();
    // A WAL-mode store whose writer closed cleanly: SQLite removed its -wal and
    // -shm, and a plain read-only open would create both again.
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode=WAL;');
    db.exec(SCHEMA);
    insertCalls(db, [call('r', NOW - HOUR, { input: 3, output: 3 })]);
    db.close();
    const before = fs.readdirSync(path.dirname(file)).sort();
    assert.deepEqual(before, [path.basename(file)]);
    assert.equal(scan(home).events.length, 1);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), before);
  });

  test('output that is not thinking + response is refused and reported unread, never counted', () => {
    const home = tmpDir();
    writeStore(storePath(home, 'antigravity-cli', uuid()), [
      call('bad', NOW - 2 * HOUR, { input: 100, output: 50, thinking: 10, response: 30 }),
      call('good', NOW - HOUR, { input: 100, output: 40, thinking: 10, response: 30 }),
    ]);
    const { events, stats, unread } = scan(home);
    assert.deepEqual(events.map((e) => e.output), [40]);
    assert.equal(stats.refused, 1);
    assert.deepEqual(unread, { fromMs: NOW - 2 * HOUR, throughMs: NOW - 2 * HOUR });
  });

  test('structural surprises in the fields read are refused; unknown step siblings are not', () => {
    const home = tmpDir();
    const withExtra = usageMsg({ id: 'x1', input: 1, output: 1, extra: [varintField(12, 5)] });
    writeStore(storePath(home, 'antigravity-cli', uuid()), [
      { id: 'x1', raw: stepMeta(NOW - HOUR, withExtra) },
      { id: 'x2', raw: stepMeta(NOW - HOUR, usageMsg({ id: 'x2', input: 1, output: 1 }), { twice: true }) },
      { id: 'x3', raw: stepMeta(NOW - HOUR, usageMsg({ id: null, input: 1, output: 1 })) },
      { id: 'x4', raw: Buffer.concat([stepMeta(NOW - HOUR, usageMsg({ id: 'x4', input: 1, output: 1 })), Buffer.from([0x0a])]) },
      call('ok', NOW - HOUR, { input: 9, output: 9 }),
    ]);
    const { events, stats, unread } = scan(home);
    assert.deepEqual(events.map((e) => e.input), [9], 'only the well-formed call (whose step carries unknown siblings)');
    assert.equal(stats.refused, 4);
    assert.ok(unread !== null);
  });

  test('a store that cannot be opened is reported unread and does not take the others down', () => {
    const home = tmpDir();
    const bad = storePath(home, 'antigravity-ide', uuid());
    fs.writeFileSync(bad, 'this is not sqlite');
    writeStore(storePath(home, 'antigravity-cli', uuid()), [call('ok', NOW - HOUR, { input: 4, output: 4 })]);
    // An encrypted .pb beside them is never opened.
    fs.writeFileSync(path.join(home, 'antigravity-ide', 'conversations', `${uuid()}.pb`), Buffer.from([0xff, 0xfe]));
    const { events, stats, unread } = scan(home);
    assert.equal(events.length, 1);
    assert.equal(stats.files, 2);
    assert.equal(stats.unreadable, 1);
    assert.ok(unread && unread.throughMs <= NOW);
  });

  test('an unchanged store is not re-read; a change to the .db or its -wal is', () => {
    const home = tmpDir();
    const file = writeStore(storePath(home, 'antigravity-cli', uuid()), [call('r1', NOW - HOUR, { input: 1, output: 1 })]);
    const first = scan(home);
    assert.equal(first.stats.parsed, 1);
    const again = scan(home, { scanner: first.scanner });
    assert.deepEqual([again.stats.parsed, again.stats.reused], [0, 1]);
    assert.deepEqual(again.events, first.events);

    const { DatabaseSync } = loadSqlite();
    const db = new DatabaseSync(file);
    insertCalls(db, [call('r2', NOW - HOUR, { input: 2, output: 2 })]);
    db.close();
    fs.utimesSync(file, new Date(NOW + 1000), new Date(NOW + 1000));
    const changed = scan(home, { scanner: first.scanner });
    assert.equal(changed.stats.parsed, 1);
    assert.equal(sumAntigravityTokens(changed.events, WEEK_START, NOW).tokens.input, 3);

    // A -wal appearing (or changing) beside an unchanged .db is a change too.
    fs.writeFileSync(`${file}-wal`, '');
    assert.equal(scan(home, { scanner: first.scanner }).stats.parsed, 1);
    assert.equal(scan(home, { scanner: first.scanner }).stats.parsed, 0);
  });

  test('the session key, the encrypted blob, the text and the response ids never surface', () => {
    const home = tmpDir();
    writeStore(storePath(home, 'antigravity-cli', uuid()), [
      call('resp-secret-id', NOW - HOUR, { name: 'gemini-3.8-flash', input: 1, output: 1 }),
    ]);
    const { events, stats, unread } = scan(home);
    const out = JSON.stringify({ events, stats, unread });
    for (const needle of [SESSION_MARKER, BLOB_MARKER, TEXT_MARKER, 'sessionID', 'resp-secret-id', 'msg-id']) {
      assert.equal(out.includes(needle), false, needle);
    }
  });

  test('the source reads two named columns and nothing else', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'antigravity', 'usage.js'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    assert.equal(/SELECT\s+\*/i.test(code), false);
    const queries = code.match(/SELECT [^']+/g);
    assert.deepEqual(queries, ['SELECT metadata FROM steps', 'SELECT data FROM gen_metadata']);
    // Usage field 8 is named twice: its number, and its wire type in the shape
    // check. No line reads its value.
    assert.equal(code.match(/U_SESSION/g).length, 2);
  });

  test('no conversation directory: not installed, nothing read', () => {
    const home = tmpDir();
    assert.equal(antigravityUsageInstallDir(home), null);
    assert.deepEqual(antigravityUsageEvents({ now: NOW, home }), []);
    fs.mkdirSync(path.join(home, 'antigravity-ide', 'conversations'), { recursive: true });
    assert.equal(antigravityUsageInstallDir(home), path.join(home, 'antigravity-ide', 'conversations'));
  });

  test('calls older than the raw window fold into 15-minute buckets with a count', () => {
    const home = tmpDir();
    const old = NOW - 10 * DAY;
    writeStore(storePath(home, 'antigravity-cli', uuid()), [
      call('o1', old + 1000, { input: 1, output: 1 }),
      call('o2', old + 2000, { input: 2, output: 2 }),
    ]);
    const { events } = scan(home, { options: { startMs: NOW - 30 * DAY } });
    assert.equal(events.length, 1);
    assert.equal(events[0].count, 2);
    assert.equal(events[0].input, 3);
  });
});

/* ------------------------------------------------------------ pricing */

test.describe('Antigravity notional cost', () => {
  const ev = (over) => ({ ts: NOW - HOUR, model: 'gemini-3.8-flash', input: 0, cacheWrite: 0, cacheRead: 0, output: 0, longPrompt: false, ...over });
  const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);

  test('gemini-3.8-flash is priced at the rate in effect on each call\'s own UTC date', () => {
    const before = Date.parse('2026-12-31T23:59:59.000Z');
    const after = Date.parse('2027-01-01T00:00:00.000Z');
    const events = [
      ev({ ts: before, input: MTOK, output: MTOK, cacheRead: MTOK }),
      ev({ ts: after, input: MTOK, output: MTOK, cacheRead: MTOK }),
    ];
    close(antigravityCost(events, before, before + 1, false).totalUsd, 0.75 + 3.75 + 0.075, 'through 2026-12-31');
    close(antigravityCost(events, after, after + 1, false).totalUsd, 1.50 + 7.50 + 0.15, 'from 2027-01-01');
    const both = antigravityCost(events, before, after + 1, false);
    close(both.totalUsd, 4.575 + 9.15, 'each at its own rate');
    assert.equal(both.byModel[0].pricedAs, 'gemini-3.8-flash');
    // The table itself answers the same date rule for any caller.
    assert.equal(geminiPricing.priceFor('gemini-3.8-flash', before).input, 0.75);
    assert.equal(geminiPricing.priceFor('gemini-3.8-flash', after).input, 1.50);
  });

  test('the real-data week: two gemini-3.8-flash calls', () => {
    const cost = antigravityCost([ev({ input: 11675, output: 169 }), ev({ input: 11912, output: 300 })], WEEK_START, NOW, false);
    close(cost.totalUsd, (23587 * 0.75 + 469 * 3.75) / MTOK, 'input + output');
    assert.equal(cost.pricesAsOf, geminiPricing.PRICES_AS_OF);
    assert.deepEqual(cost.unpricedModels, []);
  });

  test('claude-opus-4-6-thinking is priced as Opus 4.6: $5 / $25, cache reads at 0.1x', () => {
    const cost = antigravityCost([
      ev({ model: 'claude-opus-4-6-thinking', input: MTOK, output: MTOK, cacheRead: 2 * MTOK }),
    ], WEEK_START, NOW, false);
    close(cost.totalUsd, 5 + 25 + 1.0, 'total');
    close(cost.byClass.cacheRead, 1.0, '2M cache reads at $0.50');
    assert.equal(cost.byModel[0].pricedAs, 'claude-opus-4-6|standard');
    assert.equal(priceFor('claude-opus-4-6-thinking').key, 'claude-opus-4-6|standard');
  });

  test('a Claude cache write takes the 5-minute rate, and says it did', () => {
    const cost = antigravityCost([ev({ model: 'claude-opus-4-6-thinking', cacheWrite: MTOK })], WEEK_START, NOW, false);
    close(cost.byClass.cacheWrite5m, 6.25, '1.25x input');
    assert.deepEqual([cost.cacheWriteEvents, cost.fallbackWriteEvents], [1, 1]);
  });

  test('an unknown enum and an unconfirmed name are unpriced, never $0 and never guessed', () => {
    const cost = antigravityCost([
      ev({ model: 'unknown', input: 100, output: 10 }),
      ev({ model: 'gemini-pro-default', input: 100, output: 10 }),
      ev({ input: MTOK }),
    ], WEEK_START, NOW, false);
    assert.deepEqual(cost.unpricedModels, ['gemini-pro-default', 'unknown']);
    const unknown = cost.byModel.find((m) => m.model === 'unknown');
    assert.deepEqual([unknown.usd, unknown.pricedAs, unknown.tokens.input], [null, null, 100]);
    close(cost.totalUsd, 0.75, 'only the priced model');
    assert.equal(cost.byModel[cost.byModel.length - 1].usd, null, 'unpriced rows sort last');
    assert.equal(priceFor('claude-opus-4-6-extended'), null, 'a suffix that is not a date is not a price');
  });
});

/* ------------------------------------------------------------ the row */

test.describe('the Antigravity row carries tokens and the weekly cost', () => {
  const ideFresh = (resetsAtMs) => ({
    state: 'fresh', capturedAtMs: NOW - 60 * 1000, fiveHour: { usedPercentage: 40, resetsAtMs }, sevenDay: null, groups: [],
  });
  const row = (snap) => snap.providers.find((p) => p.id === 'antigravity');
  const events = [
    { ts: NOW - HOUR, model: 'gemini-3.8-flash', input: 11675, cacheWrite: 0, cacheRead: 0, output: 169, longPrompt: false },
    { ts: NOW - 3 * DAY, model: 'unknown', input: 100, cacheWrite: 0, cacheRead: 0, output: 1, longPrompt: false },
  ];
  const build = (usage, ide) => {
    _resetHistoryMemoForTests();
    return buildSnapshot({ now: NOW, events: [], scanOk: true, antigravityIde: ide || ideFresh(NOW + HOUR), antigravityUsage: usage });
  };

  test('scanned: five-hour tokens anchored to the five-hour reset, a trailing week, and its cost', () => {
    const snap = build({ installed: true, events, readFailed: false, resultAtMs: NOW, unreadRange: null });
    const r = row(snap);
    assert.equal(r.tokens.input, 11675, 'the call inside [reset - 5h, now)');
    assert.equal(r.weeklyTokens.input, 11775);
    assert.equal(r.weeklyTokensWindowAnchored, false);
    assert.deepEqual(r.weeklyTokenFloorCauses, []);
    assert.equal(r.weeklyCost.windowAnchored, false);
    assert.equal(r.weeklyCost.sourceIncomplete, false);
    assert.ok(r.weeklyCost.totalUsd > 0);
    assert.deepEqual(r.weeklyCost.unpricedModels, ['unknown']);
    assert.deepEqual(snap.pendingUsage.includes('antigravity'), false);

    // The five-hour window ends at the reset: a call before reset - 5h is outside it.
    const early = build({ installed: true, events, readFailed: false, resultAtMs: NOW, unreadRange: null }, ideFresh(NOW + 4.5 * HOUR));
    assert.equal(row(early).tokens, null, 'window [now - 30min, now + 4.5h) holds nothing yet');
  });

  test('pending until the first scan answers; nothing when no store exists', () => {
    const pending = build({ installed: true, events: null, readFailed: false, resultAtMs: null, unreadRange: null });
    assert.ok(pending.pendingUsage.includes('antigravity'));
    assert.deepEqual([row(pending).tokens, row(pending).weeklyTokens, row(pending).weeklyCost], [null, null, null]);
    const none = build({ installed: false, events: null });
    assert.equal(none.pendingUsage.includes('antigravity'), false);
    assert.deepEqual([row(none).tokens, row(none).weeklyTokens, row(none).weeklyCost], [null, null, null]);
  });

  test('a known-unread range in the week marks the cost incomplete and the count a floor', () => {
    const snap = build({ installed: true, events, readFailed: false, resultAtMs: NOW, unreadRange: { fromMs: NOW - DAY, throughMs: NOW - DAY } });
    assert.equal(row(snap).weeklyCost.sourceIncomplete, true);
    assert.deepEqual(row(snap).weeklyTokenFloorCauses, ['unread-range']);
  });
});

/* ------------------------------------------------------------ the collector */

test.describe('the collector reads Antigravity usage off the main thread', () => {
  const { Collector } = require('../src/core/collector');

  test('an installed store is pending until its worker answers, then fills the row', { timeout: 20000 }, async (t) => {
    const dir = tmpDir();
    const home = path.join(dir, 'antigravity-home');
    const now = Date.now();
    writeStore(storePath(home, 'antigravity-cli', uuid()), [call('c1', now - HOUR, { name: 'gemini-3.8-flash', input: 1234, output: 5 })]);
    const c = new Collector({
      userDataDir: dir,
      projectsRoot: path.join(dir, 'projects'),
      rateLimitsFile: path.join(dir, 'claude-rate-limits.json'),
      rateLimitsDir: dir,
      antigravityQuotaFile: path.join(dir, 'antigravity-quota.json'),
      ideAppDataDir: path.join(dir, 'ide'),
      codexHome: path.join(dir, 'codex'),
      qwenHome: path.join(dir, 'qwen-home'),
      grokHome: path.join(dir, 'grok-home'),
      kimiHome: path.join(dir, 'kimi-home'),
      antigravityUsageHome: home,
    });
    t.after(() => c.stop());
    c._codexEvents = [];
    c._dispatchCodexScan = () => {};
    assert.deepEqual(c.rebuild().pendingUsage, ['antigravity']);
    const done = new Promise((resolve) => c.once('antigravity-scan', resolve));
    c._antigravityUsage.auto = true;
    c._localTick(Date.now());
    assert.notEqual(c._antigravityUsage.worker, null, 'the scan runs in a worker');
    const stats = await done;
    assert.equal(stats.files, 1);
    assert.deepEqual(c.snapshot.pendingUsage, []);
    const r = c.snapshot.providers.find((p) => p.id === 'antigravity');
    assert.equal(r.weeklyTokens.input, 1234);
    assert.equal(r.weeklyCost.byModel[0].pricedAs, 'gemini-3.8-flash');
  });
});

test.describe('Antigravity joins the Settings usage history (Toplam Kullanım)', () => {
  const history = require('../src/core/history');
  const agCostMod = require('../src/core/antigravity/cost');
  const events = [
    { ts: NOW - HOUR, model: 'gemini-3.8-flash', input: 11675, cacheWrite: 0, cacheRead: 0, output: 169, longPrompt: false },
    { ts: NOW - 40 * DAY, model: 'claude-opus-4-6-thinking', input: 1000, cacheWrite: 0, cacheRead: 0, output: 2000, longPrompt: false },
    { ts: NOW - 2 * HOUR, model: 'unknown', input: 100, cacheWrite: 0, cacheRead: 0, output: 1, longPrompt: false },
  ];

  test('each period carries its own Antigravity cost, tokens and models, with the price date named', () => {
    const out = history.usageHistory([], NOW, { antigravityEvents: events });
    assert.deepEqual(out.usageProviders, ['antigravity']);
    assert.equal(out.pricesAsOfByProvider.antigravity, agCostMod.PRICES_AS_OF);
    const month = out.months[0];
    const expected = antigravityCost(events, history.monthStartMs(NOW), NOW + DAY, false);
    assert.equal(month.costUsd, expected.totalUsd);
    assert.ok(month.costUsd > 0);
    assert.equal(month.tokensByProvider.antigravity.input, 11775);
    assert.deepEqual(month.unpricedModels, ['unknown']);
    assert.equal(month.isFloor, true, 'an unpriced model makes the figure a floor, never a silent $0');
    assert.deepEqual(out.floorCausesByProvider.antigravity, ['unpriced']);
    const models = month.byModel.filter((m) => m.provider === 'antigravity').map((m) => m.model).sort();
    assert.deepEqual(models, ['gemini-3.8-flash', 'unknown']);
    // The Opus call 40 days back lands in an older month, priced as Opus 4.6.
    const older = out.months.find((m) => m.byModel.some((e) => e.model === 'claude-opus-4-6-thinking'));
    assert.ok(older && older.costUsd > 0 && older.key !== month.key);
  });

  test('the snapshot passes the scanned events and their unread ranges through', () => {
    _resetHistoryMemoForTests();
    const snap = buildSnapshot({
      now: NOW, events: [], scanOk: true,
      antigravityUsage: { installed: true, events, readFailed: false, resultAtMs: NOW, unreadRange: { fromMs: NOW - DAY, throughMs: NOW - DAY } },
    });
    assert.ok(snap.usageHistory.usageProviders.includes('antigravity'));
    assert.ok(snap.usageHistory.incompleteProviders.includes('antigravity'));
    _resetHistoryMemoForTests();
    const none = buildSnapshot({ now: NOW, events: [], scanOk: true, antigravityUsage: { installed: false, events: null } });
    assert.equal(none.usageHistory.usageProviders.includes('antigravity'), false);
  });
});
