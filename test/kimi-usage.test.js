'use strict';

/**
 * Kimi Code reader (ADR-003 Amendments 3 and 6).
 *
 * The owner has no Kimi Code install, so these fixtures are the only test data.
 * Every record mirrors the writer in the cto's vendor clone (kimi-code 86e0820,
 * 2026-09-17, scratchpad/k0917/packages/...), and each builder cites the
 * file:line it copies. Records serialise `type` first and `time` last
 * (agent-core-v2/src/app/event/event2.ts:38-46), one per line
 * (persistence/backends/node-fs/appendLogStore.ts:301-304).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createKimiUsageScanner, kimiUsageEvents, sumKimiTokens, kimiHome } = require('../src/core/kimi/usage');
const { kimiCost } = require('../src/core/kimi/cost');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-14T12:00:00.000Z');
const WEEK_START = NOW - 7 * DAY;
const T0 = NOW - 3 * HOUR;

function tmpDir(prefix = 'kimi-usage-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

/* ------------------------------------------------------------ vendor-shaped records */

/** The journal's first line. wire/record.ts:38-44 ({type:'metadata',
 *  protocol_version, created_at}); version '1.5' at wire/migration/migration.ts:19. */
function metadataLine(ms) {
  return JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: ms });
}

/** A usage record. agent/usage/usageOps.ts:13-24 (agentId, model, usage, usageScope),
 *  emitted by session/usage/usageAgentModel.ts:37-44; TokenUsage keys from
 *  human/llm/usage.ts:1-7; flat on disk as test/agent/usage/usage.test.ts:233-247
 *  asserts. `model` is the request's model ALIAS (llmRequesterService.ts:477-482). */
function usageLine(ms, model, { inputOther = 0, output = 0, inputCacheRead = 0, inputCacheCreation = 0 }, scope = 'turn', agentId = 'main') {
  return JSON.stringify({
    type: 'usage.record',
    agentId,
    model,
    usage: { inputOther, output, inputCacheRead, inputCacheCreation },
    usageScope: scope,
    time: ms,
  });
}

/** The same usage repeated inside a loop event. agent/loop/loopService.ts:1782-1790
 *  (appendLoopEvent({type:'step.end', ..., usage})), persisted as
 *  context.append_loop_event (agent/contextMemory/contextEvents.ts:29-40). */
function stepEndLine(ms, usage) {
  return JSON.stringify({
    type: 'context.append_loop_event',
    agentId: 'main',
    event: { type: 'step.end', uuid: 'u-1', turnId: '1', step: 1, finishReason: 'stop', usage },
    time: ms,
  });
}

/** A message record, content only (docs/wire-manifest.d.ts:124-).
 *  The text mentions a forked marker and a usage record to prove head matching. */
function messageLine(ms) {
  return JSON.stringify({
    type: 'context.append_message',
    agentId: 'main',
    message: { role: 'user', content: [{ type: 'text', text: '{"type":"forked"} {"type":"usage.record"}' }] },
    time: ms,
  });
}

/** sessionLifecycleService.ts:907-908: {type:'forked', agentId, time: Date.now()}. */
function forkedLine(ms, agentId = 'main') {
  return JSON.stringify({ type: 'forked', agentId, time: ms });
}

/** <home>/sessions/<workspaceId>/<sessionId>/agents/<agentId>/wire.jsonl
 *  (bootstrapService.ts:45; workspaceInstanceManagerService.ts:201;
 *  sessionLifecycle/internal/addressing.ts:7-17; wire/record.ts:3). */
function wirePath(home, sessionId, agentId = 'main', workspaceId = 'ws_0123abcd') {
  return path.join(home, 'sessions', workspaceId, sessionId, 'agents', agentId, 'wire.jsonl');
}

function writeLines(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

const PLAN = 'kimi-code/kimi-for-coding';

test.describe('what the Kimi reader counts', () => {
  test('only usage.record: step.end loop events and message text are never counted', () => {
    const home = tmpDir();
    const u = { inputOther: 1200, output: 300, inputCacheRead: 5000, inputCacheCreation: 100 };
    writeLines(wirePath(home, 'session_a'), [
      metadataLine(T0),
      messageLine(T0),
      stepEndLine(T0 + 1, u),
      usageLine(T0 + 2, PLAN, u),
    ]);
    const events = kimiUsageEvents({ now: NOW, startMs: WEEK_START, home });
    assert.equal(events.length, 1);
    const { tokens } = sumKimiTokens(events, WEEK_START, NOW);
    assert.deepEqual(tokens, { input: 1200, output: 300, cacheWrite: 100, cacheRead: 5000, billable: 1600 });
  });

  test('a forked session counts only records after its LAST forked marker, so copied parent history is not doubled', () => {
    const home = tmpDir();
    const parent = [
      metadataLine(T0),
      usageLine(T0 + 1, PLAN, { inputOther: 1000, output: 100 }),
      usageLine(T0 + 2, PLAN, { inputOther: 2000, output: 200 }),
    ];
    writeLines(wirePath(home, 'session_parent'), parent);
    // Full fork: session files copied (sessionLifecycleService.ts:579-583), then a
    // marker appended per agent (:614, :738-756); a turn-sliced fork rewrites the
    // records and pushes the marker last (:720-735). Either way: copy, then marker.
    writeLines(wirePath(home, 'session_child'), [
      ...parent,
      forkedLine(T0 + 10),
      usageLine(T0 + 20, PLAN, { inputOther: 7, output: 3 }),
    ]);
    // A fork of the fork carries BOTH markers; only after the last counts.
    writeLines(wirePath(home, 'session_grandchild'), [
      ...parent,
      forkedLine(T0 + 10),
      usageLine(T0 + 20, PLAN, { inputOther: 7, output: 3 }),
      forkedLine(T0 + 30),
      usageLine(T0 + 40, PLAN, { inputOther: 50000, output: 5 }),
    ]);
    const events = kimiUsageEvents({ now: NOW, startMs: WEEK_START, home });
    const { tokens } = sumKimiTokens(events, WEEK_START, NOW);
    assert.equal(tokens.input, 1000 + 2000 + 7 + 50000);
    assert.equal(tokens.output, 100 + 200 + 3 + 5);
  });

  test('a forked marker APPENDED to a file already scanned discards what that file held before it', () => {
    const home = tmpDir();
    const file = writeLines(wirePath(home, 'session_c'), [
      metadataLine(T0),
      usageLine(T0 + 1, PLAN, { inputOther: 1000, output: 1 }),
    ]);
    const scanner = createKimiUsageScanner();
    assert.equal(scanner.scan({ now: NOW, startMs: WEEK_START, home }).length, 1);
    fs.appendFileSync(file, `${forkedLine(T0 + 5)}\n${usageLine(T0 + 6, PLAN, { inputOther: 9, output: 1 })}\n`);
    const out = scanner.scan({ now: NOW, startMs: WEEK_START, home });
    assert.equal(scanner.stats().appended, 1, 'read incrementally');
    assert.deepEqual(out.map((e) => e.input), [9]);
  });

  test('kimi-code/* aliases are the Kimi plan; any other alias is another model via Kimi Code; all unpriced, no price date', () => {
    const home = tmpDir();
    writeLines(wirePath(home, 'session_d'), [
      metadataLine(T0),
      // managed-kimi-code.ts:11 KIMI_CODE_PLATFORM_ID, :224 `${platform}/${modelId}`.
      usageLine(T0 + 1, PLAN, { inputOther: 100, output: 10 }),
      // A user-configured provider alias, e.g. `${providerId}/...` (managed-kimi-code.ts:659).
      usageLine(T0 + 2, 'anthropic/claude-sonnet-5', { inputOther: 50, output: 5 }),
    ]);
    const events = kimiUsageEvents({ now: NOW, startMs: WEEK_START, home });
    const cost = kimiCost(events, WEEK_START, NOW, false);
    assert.equal(cost.totalUsd, 0);
    assert.equal(cost.pricesAsOf, '', 'no price table, so no date');
    assert.deepEqual(cost.byModel.map((m) => [m.model, m.speed, m.usd, m.pricedAs]), [
      [PLAN, 'no-published-price', null, null],
      ['anthropic/claude-sonnet-5', 'other-model-alias', null, null],
    ]);
    assert.deepEqual(cost.unpricedModels, ['anthropic/claude-sonnet-5', PLAN]);
    for (const k of ['unrecordedCalls', 'longPromptFloorEvents', 'toolTokenEvents']) assert.ok(!cost[k], k);
  });

  test('wire.jsonl.bak and every other name are ignored; files outside the session shape are not read', () => {
    const home = tmpDir();
    const line = usageLine(T0, PLAN, { inputOther: 12345, output: 1 });
    writeLines(wirePath(home, 'session_e'), [metadataLine(T0), usageLine(T0, PLAN, { inputOther: 1, output: 1 })]);
    // wire/repair.ts:16-18, :36-39: the original is kept as `wire.jsonl.bak`.
    writeLines(`${wirePath(home, 'session_e')}.bak`, [line]);
    writeLines(path.join(path.dirname(wirePath(home, 'session_e')), 'wire.jsonl.tmp'), [line]);
    writeLines(path.join(home, 'sessions', 'ws_0123abcd', 'session_e', 'wire.jsonl'), [line]);
    writeLines(path.join(home, 'sessions', 'wire.jsonl'), [line]);
    const events = kimiUsageEvents({ now: NOW, startMs: WEEK_START, home });
    assert.deepEqual(events.map((e) => e.input), [1]);
  });

  test('a corrupt usage.record is a known gap at its time; a corrupt message line is not', () => {
    const home = tmpDir();
    const broken = usageLine(T0 + 2, PLAN, { inputOther: 5, output: 5 }).replace('"usage":{', '"usage":{"inputOther":');
    writeLines(wirePath(home, 'session_f'), [
      metadataLine(T0),
      messageLine(T0).slice(0, 40),
      broken,
      usageLine(T0 + 3, PLAN, { inputOther: 1, output: 1 }),
    ]);
    const scanner = createKimiUsageScanner();
    assert.equal(scanner.scan({ now: NOW, startMs: WEEK_START, home }).length, 1);
    assert.deepEqual(scanner.unreadRange(), { fromMs: T0 + 2, throughMs: T0 + 2 });
  });
});

test.describe('the Kimi reader never leaves sessions/**/agents/*/wire.jsonl', () => {
  test('config.toml is never opened, stat-ed or listed, and the home directory itself is never listed', (t) => {
    const home = tmpDir();
    // app/bootstrap/bootstrap.ts:116, :180 config path; docs config-files.md:125 plaintext api_key.
    fs.writeFileSync(path.join(home, 'config.toml'), 'api_key = "fixture-not-a-secret"\n');
    fs.writeFileSync(path.join(home, 'server.token'), 'fixture');
    writeLines(wirePath(home, 'session_g'), [metadataLine(T0), usageLine(T0, PLAN, { inputOther: 3, output: 3 })]);
    const seen = [];
    const wrap = (name) => {
      const orig = fs[name];
      fs[name] = function spied(...args) { seen.push(`${name}:${String(args[0])}`); return orig.apply(this, args); };
      t.after(() => { fs[name] = orig; });
    };
    for (const name of ['openSync', 'readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'readlinkSync']) wrap(name);
    assert.equal(kimiUsageEvents({ now: NOW, startMs: WEEK_START, home }).length, 1);
    assert.ok(seen.some((c) => c.startsWith('openSync:') && c.endsWith('wire.jsonl')), 'the spy observes the real read');
    assert.deepEqual(seen.filter((c) => /config\.toml|server\.token/.test(c)), []);
    assert.deepEqual(seen.filter((c) => c.startsWith('readdirSync:') && path.resolve(c.slice('readdirSync:'.length)) === path.resolve(home)), []);
  });

  test('a wire.jsonl that is a symbolic link is skipped', (t) => {
    const outside = tmpDir();
    const target = writeLines(path.join(outside, 'wire.jsonl'), [usageLine(T0, PLAN, { inputOther: 1, output: 1 })]);
    const home = tmpDir();
    const link = wirePath(home, 'session_h');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    try {
      fs.symlinkSync(target, link, 'file');
    } catch (err) {
      t.skip(`file symlink not permitted here: ${err.code}`);
      return;
    }
    assert.deepEqual(kimiUsageEvents({ now: NOW, startMs: WEEK_START, home }), []);
  });

  test('KIMI_CODE_HOME is honoured (bootstrap.ts:173), and a network home is not found without being logged', (t) => {
    const prev = process.env.KIMI_CODE_HOME;
    t.after(() => { if (prev === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = prev; });
    process.env.KIMI_CODE_HOME = path.join(os.tmpdir(), 'kimi-home-x');
    assert.equal(kimiHome(), path.join(os.tmpdir(), 'kimi-home-x'));
    const log = require('../src/core/log');
    const lines = [];
    log.setSink((level, msg) => { lines.push(String(msg)); });
    t.after(() => log.setSink(null));
    require('../src/core/kimi/usage')._resetForTests();
    process.env.KIMI_CODE_HOME = String.raw`\\fileserver\share\.kimi-code`;
    assert.equal(kimiHome(), null);
    assert.deepEqual(kimiUsageEvents({ now: NOW, startMs: WEEK_START }), []);
    assert.equal(lines.some((l) => l.includes('fileserver')), false);
  });
});

test.describe('the cached Kimi scanner', () => {
  test('unchanged files are not re-read, and old records fold into buckets without changing a figure', () => {
    const home = tmpDir();
    const old = NOW - 40 * DAY;
    writeLines(wirePath(home, 'session_i'), [
      metadataLine(old),
      usageLine(old, PLAN, { inputOther: 10, output: 1, inputCacheRead: 100 }),
      usageLine(old + 60000, PLAN, { inputOther: 20, output: 2, inputCacheCreation: 5 }),
      usageLine(old + 120000, 'openai/gpt-5.5', { inputOther: 30, output: 3 }),
      usageLine(T0, PLAN, { inputOther: 40, output: 4 }),
    ]);
    const start = NOW - 60 * DAY;
    const scanner = createKimiUsageScanner();
    const folded = scanner.scan({ now: NOW, startMs: start, home });
    scanner.scan({ now: NOW, startMs: start, home });
    assert.equal(scanner.stats().bytesRead, 0);
    const raw = kimiUsageEvents({ now: NOW, startMs: start, home, rawSinceMs: 0 });
    assert.equal(raw.length, 4);
    assert.equal(folded.length, 3, 'the two old plan records share a bucket');
    assert.deepEqual(kimiCost(folded, start, NOW, false).byModel, kimiCost(raw, start, NOW, false).byModel);
  });
});

test.describe('the warm Kimi walk (ADR-003 A6 Phase A, F5)', () => {
  test('unchanged sessions are not listed again, appends are still read, and new sessions and agents are found', () => {
    const home = tmpDir();
    const a = writeLines(wirePath(home, 'session_a'), [metadataLine(T0), usageLine(T0, PLAN, { inputOther: 1, output: 1 })]);
    writeLines(wirePath(home, 'session_b'), [metadataLine(T0), usageLine(T0, PLAN, { inputOther: 2, output: 1 })]);
    const scanner = createKimiUsageScanner();
    const scan = (now = NOW) => scanner.scan({ now, startMs: WEEK_START, home });
    assert.equal(scan().length, 2);
    assert.equal(scanner.stats().sessionsListed, 2);

    assert.equal(scan(NOW + 1000).length, 2);
    assert.deepEqual({ listed: scanner.stats().sessionsListed, full: scanner.stats().fullWalk, bytes: scanner.stats().bytesRead }, { listed: 0, full: false, bytes: 0 });

    // An append to a known file is read, and that active session is listed again,
    // which finds a subagent created in it.
    fs.appendFileSync(a, `${usageLine(T0 + 5, PLAN, { inputOther: 4, output: 1 })}\n`);
    writeLines(wirePath(home, 'session_a', 'agent_sub'), [metadataLine(T0), usageLine(T0 + 6, PLAN, { inputOther: 8, output: 1 })]);
    // A brand-new session is found through the workspace listing.
    writeLines(wirePath(home, 'session_c'), [metadataLine(T0), usageLine(T0 + 7, PLAN, { inputOther: 16, output: 1 })]);
    const out = scan(NOW + 2000);
    assert.deepEqual(out.map((e) => e.input).sort((x, y) => x - y), [1, 2, 4, 8, 16]);
    assert.equal(scanner.stats().sessionsListed, 2, 'the active session and the new one only');

    // A subagent added to an IDLE session is found by the periodic full walk.
    writeLines(wirePath(home, 'session_b', 'agent_late'), [metadataLine(T0), usageLine(T0 + 9, PLAN, { inputOther: 32, output: 1 })]);
    assert.equal(scan(NOW + 3000).length, 5, 'not yet: session_b had no activity');
    const later = scan(NOW + 3000 + 5 * 60 * 1000);
    assert.equal(scanner.stats().fullWalk, true);
    assert.equal(later.length, 6);
  });
});

test.describe('Phase A review fixes (ADR-003 A6 review rulings)', () => {
  test('review F9: a fork scanned after the copy but before its marker is corrected by the next scan', () => {
    const home = tmpDir();
    const parent = [metadataLine(T0), usageLine(T0 + 1, PLAN, { inputOther: 1000, output: 1 })];
    writeLines(wirePath(home, 'session_parent'), parent);
    const child = writeLines(wirePath(home, 'session_child'), parent); // copied, marker not yet appended
    const scanner = createKimiUsageScanner();
    const total = (evs) => evs.reduce((s, e) => s + e.input, 0);
    assert.equal(total(scanner.scan({ now: NOW, startMs: WEEK_START, home })), 2000, 'transiently double');
    fs.appendFileSync(child, `${forkedLine(T0 + 10)}\n${usageLine(T0 + 11, PLAN, { inputOther: 5, output: 1 })}\n`);
    assert.equal(total(scanner.scan({ now: NOW + 1000, startMs: WEEK_START, home })), 1005);
  });

  test('review F4: an atomic rewrite that GREW with a newline at the old offset is re-read, not appended (no double count)', () => {
    const home = tmpDir();
    const a = usageLine(T0 + 1, PLAN, { inputOther: 1111, output: 1 });
    const b = usageLine(T0 + 2, PLAN, { inputOther: 2222, output: 1 });
    const file = writeLines(wirePath(home, 'session_r'), [a, b]);
    const scanner = createKimiUsageScanner();
    const total = (evs) => evs.reduce((s, e) => s + e.input, 0);
    assert.equal(total(scanner.scan({ now: NOW, startMs: WEEK_START, home })), 3333);
    // Same length as `b`, so the byte before the old offset is a newline again.
    const z = usageLine(T0 + 3, PLAN, { inputOther: 3333, output: 1 });
    assert.equal(z.length, b.length);
    fs.writeFileSync(`${file}.tmp`, [z, a, b, usageLine(T0 + 4, PLAN, { inputOther: 4444, output: 1 })].join('\n') + '\n');
    fs.renameSync(`${file}.tmp`, file);
    assert.equal(total(scanner.scan({ now: NOW + 1000, startMs: WEEK_START, home })), 3333 + 1111 + 2222 + 4444);
    assert.equal(scanner.stats().appended, 0);
  });

  test('review F5: an oversize line that is not a usage record is not lost usage', () => {
    const home = tmpDir();
    const huge = JSON.stringify({ type: 'context.append_message', agentId: 'main', message: { role: 'user', content: [{ type: 'text', text: 'x'.repeat(4 * 1024 * 1024 + 10) }] }, time: T0 });
    writeLines(wirePath(home, 'session_o'), [metadataLine(T0), huge, usageLine(T0 + 1, PLAN, { inputOther: 1, output: 1 })]);
    const scanner = createKimiUsageScanner();
    assert.equal(scanner.scan({ now: NOW, startMs: WEEK_START, home }).length, 1);
    assert.equal(scanner.unreadRange(), null);
  });

  test('a junction inside sessions/ is never followed, and config.toml is never opened', (t) => {
    const home = tmpDir();
    fs.writeFileSync(path.join(home, 'config.toml'), 'api_key = "fixture-not-a-secret"\n');
    writeLines(path.join(home, 'agents', 'main', 'wire.jsonl'), [usageLine(T0, PLAN, { inputOther: 77, output: 1 })]);
    writeLines(wirePath(home, 'session_ok'), [usageLine(T0, PLAN, { inputOther: 1, output: 1 })]);
    try {
      fs.symlinkSync(home, path.join(home, 'sessions', 'ws_0123abcd', 'session_link'), 'junction');
    } catch (err) {
      t.skip(`cannot create a junction here: ${err.code}`);
      return;
    }
    const seen = [];
    for (const name of ['openSync', 'readdirSync', 'lstatSync']) {
      const orig = fs[name];
      fs[name] = function spied(...args) { seen.push(String(args[0])); return orig.apply(this, args); };
      t.after(() => { fs[name] = orig; });
    }
    assert.deepEqual(kimiUsageEvents({ now: NOW, startMs: WEEK_START, home }).map((e) => e.input), [1]);
    assert.deepEqual(seen.filter((p) => p.includes('config.toml') || p.includes('session_link')), []);
  });
});
