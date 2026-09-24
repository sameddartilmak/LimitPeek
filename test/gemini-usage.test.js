'use strict';

/**
 * Gemini CLI reader (ADR-003 Amendments 3 and 6).
 *
 * The owner has no Gemini CLI install, so these fixtures are the only test
 * data. Every record mirrors the writer in the cto's vendor clone
 * (gemini-cli 6a466a7, 2026-09-15, scratchpad/g0917/packages/core/src/...), and
 * each builder cites the file:line it copies. Key ORDER matters to the reader's
 * byte pre-filter, so builders construct objects in the order the vendor's
 * code assigns keys.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createGeminiUsageScanner, geminiUsageEvents, sumGeminiTokens, geminiDir } = require('../src/core/gemini/usage');
const { geminiCost, PRICES_AS_OF } = require('../src/core/gemini/pricing');
const rollout = require('../src/core/codex/rollout');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-14T12:00:00.000Z');
const WEEK_START = NOW - 7 * DAY;

function tmpDir(prefix = 'gemini-usage-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

const iso = (ms) => new Date(ms).toISOString();

/* ------------------------------------------------------------ vendor-shaped records */

/** First line of a new session file.
 *  chatRecordingService.ts:530-539 ({sessionId, projectHash, startTime, lastUpdated,
 *  kind, directories}; `kind`/`directories` undefined for a main session and so
 *  omitted by JSON.stringify), appended at :539. */
function metaLine(sessionId, startMs, kind) {
  const meta = { sessionId, projectHash: 'a1b2c3d4e5f6', startTime: iso(startMs), lastUpdated: iso(startMs) };
  if (kind === 'subagent') {
    meta.kind = 'subagent';
    meta.directories = ['/work/project'];
  }
  return JSON.stringify(meta);
}

/** A user message. chatRecordingService.ts:671-684 (newMessage: id, timestamp,
 *  type, content; displayContent undefined -> omitted), pushed at :710 via :648-652. */
function userLine(id, ms, text = 'fixture prompt') {
  return JSON.stringify({ id, timestamp: iso(ms), type: 'user', content: [{ text }] });
}

/** The tokens object. chatRecordingService.ts:750-757 (key order input, output,
 *  cached, thoughts, tool, total; values from GenerateContentResponseUsageMetadata). */
function tokens({ input, output, cached = 0, thoughts = 0, tool = 0 }) {
  return { input, output, cached, thoughts, tool, total: input + output + thoughts + tool };
}

/** A gemini response message. chatRecordingService.ts:697-709: newMessage keys,
 *  then `thoughts`, `tokens` (the queued tokens, or null), `model` assigned in
 *  that order; `model` undefined -> omitted by JSON.stringify (:723-734,
 *  geminiChat.ts:1659-1662 synthetic message). */
function geminiLine(id, ms, { tok = null, model, content = 'fixture response' } = {}) {
  const msg = { id, timestamp: iso(ms), type: 'gemini', content, thoughts: [], tokens: tok };
  if (model !== undefined) msg.model = model;
  return JSON.stringify(msg);
}

/** The same message re-appended with tool calls added after its tokens.
 *  chatRecordingService.ts:813-835 (lastMsg.toolCalls set, pushMessage at :835). */
function geminiWithToolCallsLine(id, ms, tok, model) {
  return JSON.stringify({
    id, timestamp: iso(ms), type: 'gemini', content: '', thoughts: [], tokens: tok, model,
    toolCalls: [{ id: 'call-1', name: 'read_file', args: { tokens: { input: 999999 } }, status: 'success', timestamp: iso(ms) }],
  });
}

/** chatRecordingService.ts:711 + :642-646 -> {"$set": {lastUpdated}}. */
function setLastUpdatedLine(ms) {
  return JSON.stringify({ $set: { lastUpdated: iso(ms) } });
}

/** chatRecordingService.ts:949 -> {"$rewindTo": messageId}. */
function rewindLine(id) {
  return JSON.stringify({ $rewindTo: id });
}

/** chatRecordingService.ts:1026-1029 -> {"$set": {messages, lastUpdated}} checkpoint. */
function setMessagesLine(messages, ms) {
  return JSON.stringify({ $set: { messages, lastUpdated: iso(ms) } });
}

/** tmp/<project>/chats, as core/config/storage.ts:230-234 + :416. */
function chatsDir(home, project = 'my-project') {
  const dir = path.join(home, 'tmp', project, 'chats');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A main session file name: chatRecordingService.ts:499-518
 *  `session-${ISO.slice(0,16) with ':'->'-'}-${sessionId.slice(0,8)}.jsonl`. */
function sessionName(startMs, sessionId, ext = '.jsonl') {
  return `session-${iso(startMs).slice(0, 16).replace(/:/g, '-')}-${sessionId.slice(0, 8)}${ext}`;
}

function writeLines(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

const SID = '5f0c2a1e-7b3d-4c9a-9e21-0d6f1b2c3a4b';
const T0 = NOW - 2 * HOUR;

test.describe('what the Gemini reader counts', () => {
  test('a gemini message with tokens and a model is counted, priced by the exact formula, and always a floor', () => {
    const home = tmpDir();
    writeLines(path.join(chatsDir(home), sessionName(T0, SID)), [
      metaLine(SID, T0),
      userLine('u-1', T0),
      geminiLine('m-1', T0 + 1000, { tok: tokens({ input: 10000, cached: 4000, output: 500, thoughts: 200 }), model: 'gemini-2.5-pro' }),
      setLastUpdatedLine(T0 + 1000),
    ]);
    const events = geminiUsageEvents({ now: NOW, startMs: WEEK_START, home });
    assert.equal(events.length, 1);
    assert.deepEqual(
      { input: events[0].input, cached: events[0].cached, output: events[0].output, thoughts: events[0].thoughts, model: events[0].model },
      { input: 6000, cached: 4000, output: 500, thoughts: 200, model: 'gemini-2.5-pro' },
      'input is promptTokenCount INCLUDING cached, so the uncached share is input - cached',
    );
    const cost = geminiCost(events, WEEK_START, NOW, false);
    // (10000-4000) x 1.25 + 4000 x 0.125 + (500+200) x 10.00, per 1M
    assert.equal(cost.totalUsd, 0.015);
    assert.equal(cost.byClass.output, 0.007, 'thinking tokens are billed as output');
    assert.equal(cost.unrecordedCalls, true, 'ADR-003 A6: every Gemini figure is a floor');
    assert.equal(cost.pricesAsOf, PRICES_AS_OF);
    assert.equal(cost.pricesAsOf, '2026-09-16');
    const { tokens: t } = sumGeminiTokens(events, WEEK_START, NOW);
    assert.deepEqual(t, { input: 6000, output: 700, cacheWrite: 0, cacheRead: 4000, billable: 6700 });
  });

  test('re-appends of one message id are counted ONCE: without tokens, with tokens, then with tool calls (whose args mention tokens)', () => {
    const home = tmpDir();
    const tok = tokens({ input: 2000, output: 100 });
    writeLines(path.join(chatsDir(home), sessionName(T0, SID)), [
      metaLine(SID, T0),
      // recordMessage with no queued tokens (:703-706) -> tokens: null.
      geminiLine('m-1', T0, { tok: null, model: 'gemini-2.5-flash' }),
      // recordMessageTokens attaches them to the last message and re-pushes it (:758-762).
      geminiLine('m-1', T0, { tok, model: 'gemini-2.5-flash' }),
      // recordToolCalls updates the same message (:813-835).
      geminiWithToolCallsLine('m-1', T0, tok, 'gemini-2.5-flash'),
    ]);
    const events = geminiUsageEvents({ now: NOW, startMs: WEEK_START, home });
    assert.equal(events.length, 1);
    assert.equal(events[0].input, 2000, 'the nested args.tokens object is never read as usage');
  });

  test('a legacy .json left beside its migrated .jsonl is deduped by message id, globally', () => {
    const home = tmpDir();
    const dir = chatsDir(home);
    const tok = tokens({ input: 3000, cached: 1000, output: 300 });
    const legacyMessages = [
      { id: 'u-1', timestamp: iso(T0), type: 'user', content: [{ text: 'fixture' }] },
      { id: 'm-1', timestamp: iso(T0 + 500), type: 'gemini', content: 'fixture', thoughts: [], tokens: tok, model: 'gemini-2.5-pro' },
    ];
    // Legacy whole-file ConversationRecord (chatRecordingTypes.ts:92-104), read by
    // parseLegacyRecordFallback (chatRecordingService.ts:1041-1060). Its exact
    // formatting (pretty vs compact) is not in the current source: unverified.
    fs.writeFileSync(path.join(dir, sessionName(T0, SID, '.json')), JSON.stringify({
      sessionId: SID, projectHash: 'a1b2c3d4e5f6', startTime: iso(T0), lastUpdated: iso(T0 + 500), messages: legacyMessages,
    }, null, 2));
    // On resume the CLI appends metadata + every message to `<file>.jsonl` and
    // never deletes the .json (chatRecordingService.ts:436-460), then continues there.
    writeLines(path.join(dir, sessionName(T0, SID, '.jsonl')), [
      metaLine(SID, T0),
      JSON.stringify(legacyMessages[0]),
      JSON.stringify(legacyMessages[1]),
      JSON.stringify({ $set: { sessionId: SID } }), // :463
      geminiLine('m-2', T0 + HOUR, { tok: tokens({ input: 100, output: 10 }), model: 'gemini-2.5-pro' }),
    ]);
    const scanner = createGeminiUsageScanner();
    const events = scanner.scan({ now: NOW, startMs: WEEK_START, home });
    assert.deepEqual(events.map((e) => e.input + e.cached).sort((a, b) => a - b), [100, 3000], 'm-1 once, m-2 once');

    // Deleting the legacy file hands its ids to the .jsonl copy: still once.
    fs.rmSync(path.join(dir, sessionName(T0, SID, '.json')));
    const after = scanner.scan({ now: NOW, startMs: WEEK_START, home });
    assert.deepEqual(after.map((e) => e.input + e.cached).sort((a, b) => a - b), [100, 3000]);
  });

  test('subagent chats at depth 2 are counted; deeper files, backups and other names are not', () => {
    const home = tmpDir();
    const dir = chatsDir(home);
    const SUB = '9a8b7c6d-1111-2222-3333-444455556666';
    writeLines(path.join(dir, sessionName(T0, SID)), [
      metaLine(SID, T0),
      geminiLine('m-main', T0, { tok: tokens({ input: 1000, output: 10 }), model: 'gemini-2.5-pro' }),
    ]);
    // chatRecordingService.ts:484-518: subagents at chats/<safeParentId>/<safeSessionId>.jsonl.
    writeLines(path.join(dir, SID, `${SUB}.jsonl`), [
      metaLine(SUB, T0, 'subagent'),
      geminiLine('m-sub', T0 + 1000, { tok: tokens({ input: 2000, output: 20 }), model: 'gemini-2.5-flash' }),
    ]);
    const line = geminiLine('m-x', T0, { tok: tokens({ input: 99999, output: 1 }), model: 'gemini-2.5-pro' });
    writeLines(path.join(dir, SID, 'deeper', 'x.jsonl'), [line]);
    // :604-605 unreadable backup, :619 temp file; neither ends in .json/.jsonl.
    writeLines(path.join(dir, `${sessionName(T0, SID)}.unreadable-1757800000000`), [line]);
    writeLines(path.join(dir, `${sessionName(T0, SID)}.tmp-4242`), [line]);
    writeLines(path.join(dir, 'notes.txt'), [line]);
    // Outside tmp/*/chats entirely.
    writeLines(path.join(home, 'tmp', 'my-project', 'logs.jsonl'), [line]);
    writeLines(path.join(home, 'history', 'x.jsonl'), [line]);

    const events = geminiUsageEvents({ now: NOW, startMs: WEEK_START, home });
    assert.deepEqual(events.map((e) => e.input).sort((a, b) => a - b), [1000, 2000]);
  });

  test('a $rewindTo does not delete usage, and $set checkpoints are never counted', () => {
    const home = tmpDir();
    const tok = tokens({ input: 5000, output: 50 });
    writeLines(path.join(chatsDir(home), sessionName(T0, SID)), [
      metaLine(SID, T0),
      userLine('u-1', T0),
      geminiLine('m-1', T0 + 100, { tok, model: 'gemini-2.5-pro' }),
      rewindLine('u-1'),
      userLine('u-2', T0 + 200),
      geminiLine('m-2', T0 + 300, { tok, model: 'gemini-2.5-pro' }),
      // A checkpoint that re-lists m-2 AND names a message recorded nowhere else.
      setMessagesLine([
        { id: 'u-2', timestamp: iso(T0 + 200), type: 'user', content: [{ text: 'x' }] },
        { id: 'm-2', timestamp: iso(T0 + 300), type: 'gemini', content: 'x', thoughts: [], tokens: tok, model: 'gemini-2.5-pro' },
        { id: 'm-only-in-set', timestamp: iso(T0 + 400), type: 'gemini', content: 'x', thoughts: [], tokens: tok, model: 'gemini-2.5-pro' },
      ], T0 + 400),
    ]);
    const events = geminiUsageEvents({ now: NOW, startMs: WEEK_START, home });
    assert.equal(events.length, 2, 'm-1 (rewound, but really sent) and m-2; nothing from $set');
  });
});

test.describe('Gemini pricing rules (ADR-003 A6)', () => {
  const ev = (over) => ({ ts: NOW - HOUR, model: 'gemini-2.5-pro', input: 0, cached: 0, output: 0, thoughts: 0, tool: 0, longPrompt: false, ...over });

  test('a prompt over 200k on a model with a >200k row is priced at the <=200k rate and counted as a floor', () => {
    const home = tmpDir();
    writeLines(path.join(chatsDir(home), sessionName(T0, SID)), [
      metaLine(SID, T0),
      geminiLine('m-long', T0, { tok: tokens({ input: 250000, output: 1000 }), model: 'gemini-2.5-pro' }),
      geminiLine('m-flash', T0 + 1, { tok: tokens({ input: 250000, output: 1000 }), model: 'gemini-2.5-flash' }),
      geminiLine('m-short', T0 + 2, { tok: tokens({ input: 200000, output: 0 }), model: 'gemini-3.1-pro-preview' }),
    ]);
    const events = geminiUsageEvents({ now: NOW, startMs: WEEK_START, home });
    const cost = geminiCost(events, WEEK_START, NOW, false);
    assert.equal(cost.longPromptFloorEvents, 1, 'only 2.5-pro publishes a >200k row; exactly 200k is not over');
    const pro = cost.byModel.find((m) => m.model === 'gemini-2.5-pro');
    // 250000 x 1.25 + 1000 x 10.00 per 1M: the <=200k rate, never the >200k one.
    assert.equal(pro.usd, 0.3225);
  });

  test('tool-use prompt tokens are their own counted cause and are not priced', () => {
    const cost = geminiCost([
      ev({ input: 1000, output: 100, tool: 300 }),
      ev({ input: 1000, output: 100 }),
      ev({ model: 'gemini-3-flash', input: 1000, tool: 5 }),
    ], WEEK_START, NOW, false);
    assert.equal(cost.toolTokenEvents, 2, 'priced or not');
    assert.equal(cost.byModel.find((m) => m.model === 'gemini-2.5-pro').usd, 0.0045, 'tool tokens add no dollars');
  });

  test('an unknown or alias model id is unpriced, never $0; tokens with no model carry the no-model code', () => {
    const home = tmpDir();
    writeLines(path.join(chatsDir(home), sessionName(T0, SID)), [
      metaLine(SID, T0),
      // 'gemini-3-flash' is a backend alias (config/models.ts:70-73), not on the price page.
      geminiLine('m-alias', T0, { tok: tokens({ input: 1000, output: 10 }), model: 'gemini-3-flash' }),
      // geminiChat.ts:1659-1662 -> recordSyntheticMessage (chatRecordingService.ts:723-734): model undefined.
      geminiLine('m-synthetic', T0 + 1, { tok: tokens({ input: 700, output: 7 }) }),
      geminiLine('m-priced', T0 + 2, { tok: tokens({ input: 1000000, output: 0 }), model: 'gemini-3.5-flash' }),
    ]);
    const events = geminiUsageEvents({ now: NOW, startMs: WEEK_START, home });
    const cost = geminiCost(events, WEEK_START, NOW, false);
    assert.equal(cost.totalUsd, 1.5, 'only the exact id is priced');
    const alias = cost.byModel.find((m) => m.model === 'gemini-3-flash');
    assert.deepEqual({ usd: alias.usd, pricedAs: alias.pricedAs, speed: alias.speed }, { usd: null, pricedAs: null, speed: 'standard' });
    const none = cost.byModel.find((m) => m.speed === 'no-model');
    assert.deepEqual({ model: none.model, usd: none.usd, input: none.tokens.input }, { model: 'unknown', usd: null, input: 700 });
    assert.deepEqual(cost.unpricedModels, ['gemini-3-flash', 'unknown']);
    assert.equal(cost.byModel[cost.byModel.length - 1].usd, null, 'unpriced rows sort last');
  });

  test('the seven verified rows, and nothing else', () => {
    const { PRICES } = require('../src/core/gemini/pricing');
    assert.deepEqual(Object.keys(PRICES).sort(), [
      'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview', 'gemini-3.5-flash',
      'gemini-3.8-flash',
    ]);
    // Transcribed 2026-09-24, with the published 2027-01-01 rate change.
    assert.deepEqual(PRICES['gemini-3.8-flash'], {
      input: 0.75, output: 3.75, cached: 0.075, long: null,
      changes: [{ from: '2027-01-01', input: 1.50, output: 7.50, cached: 0.15 }],
    });
    assert.deepEqual(PRICES['gemini-3.1-pro-preview'], { input: 2.00, output: 12.00, cached: 0.20, long: { input: 4.00, output: 18.00, cached: 0.40 } });
    assert.deepEqual(PRICES['gemini-2.5-pro'].long, { input: 2.50, output: 15.00, cached: 0.25 });
    assert.equal(PRICES['gemini-3.1-flash-lite'].cached, 0.025);
  });
});

test.describe('the Gemini reader never leaves tmp/*/chats', () => {
  test('a chat file that is a symbolic link is skipped', (t) => {
    const outside = tmpDir();
    const target = writeLines(path.join(outside, 'elsewhere.jsonl'), [
      metaLine(SID, T0),
      geminiLine('m-link', T0, { tok: tokens({ input: 1000, output: 1 }), model: 'gemini-2.5-pro' }),
    ]);
    const home = tmpDir();
    const dir = chatsDir(home);
    try {
      fs.symlinkSync(target, path.join(dir, sessionName(T0, SID)), 'file');
    } catch (err) {
      t.skip(`file symlink not permitted here: ${err.code}`);
      return;
    }
    assert.deepEqual(geminiUsageEvents({ now: NOW, startMs: WEEK_START, home }), []);
  });

  test('oauth_creds.json (and every other file in ~/.gemini) is never opened, stat-ed or listed', (t) => {
    const home = tmpDir();
    // storage.ts:22 OAUTH_FILE, :255-256 getOAuthCredsPath -> <gemini dir>/oauth_creds.json.
    fs.writeFileSync(path.join(home, 'oauth_creds.json'), '{"access_token":"fixture-not-a-secret"}');
    fs.writeFileSync(path.join(home, 'google_accounts.json'), '{}');
    // Antigravity shares ~/.gemini on real machines (ADR-003 A1).
    writeLines(path.join(home, 'antigravity', 'tmp', 'p', 'chats', 'x.jsonl'), [
      geminiLine('m-agy', T0, { tok: tokens({ input: 5, output: 5 }), model: 'gemini-2.5-pro' }),
    ]);
    writeLines(path.join(chatsDir(home), sessionName(T0, SID)), [
      metaLine(SID, T0),
      geminiLine('m-1', T0, { tok: tokens({ input: 1000, output: 1 }), model: 'gemini-2.5-pro' }),
    ]);
    const seen = [];
    const wrap = (name) => {
      const orig = fs[name];
      fs[name] = function spied(...args) { seen.push(`${name}:${String(args[0])}`); return orig.apply(this, args); };
      t.after(() => { fs[name] = orig; });
    };
    for (const name of ['openSync', 'readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'readlinkSync']) wrap(name);
    const events = geminiUsageEvents({ now: NOW, startMs: WEEK_START, home });
    assert.equal(events.length, 1, 'the real chat is still read (the spy observes a working scan)');
    assert.ok(seen.some((c) => c.startsWith('openSync:') && c.includes('chats')), 'the spy sees chat opens');
    assert.deepEqual(seen.filter((c) => /oauth_creds|google_accounts|antigravity/.test(c)), []);
    assert.deepEqual(seen.filter((c) => c.startsWith('readdirSync:') && path.resolve(c.slice('readdirSync:'.length)) === path.resolve(home)), [],
      'the .gemini directory itself is never listed');
  });

  test('a Gemini home on a network path is not found, untouched, and the path is never logged', () => {
    const log = require('../src/core/log');
    const lines = [];
    log.setSink((level, msg) => { lines.push(String(msg)); });
    try {
      require('../src/core/gemini/usage')._resetForTests();
      assert.deepEqual(geminiUsageEvents({ now: NOW, startMs: WEEK_START, home: String.raw`\\fileserver\share\.gemini` }), []);
      assert.equal(geminiDir('//fileserver/share/.gemini'), null);
    } finally {
      log.setSink(null);
    }
    assert.equal(lines.some((l) => l.includes('fileserver')), false);
  });

  test('a tmp directory that links to a share is refused before it is opened, and the scan reports it unread', (t) => {
    rollout._resetPathGuardForTests();
    const home = tmpDir();
    try {
      fs.symlinkSync(String.raw`\\unreachable-gemini-share\share\tmp`, path.join(home, 'tmp'), 'dir');
    } catch (err) {
      t.skip(`cannot create a directory symlink here: ${err.code}`);
      return;
    }
    const log = require('../src/core/log');
    const lines = [];
    log.setSink((level, msg) => { lines.push(String(msg)); });
    t.after(() => log.setSink(null));
    const scanner = createGeminiUsageScanner();
    assert.deepEqual(scanner.scan({ now: NOW, startMs: WEEK_START, home }), []);
    assert.deepEqual(scanner.unreadRange(), { fromMs: 0, throughMs: NOW }, 'a refused tree is a known gap, not "no usage"');
    assert.deepEqual(lines.filter((l) => l.includes('refused')), ['gemini chats directory refused: code=NETWORK_TARGET']);
    assert.equal(lines.some((l) => l.includes('unreachable')), false);
  });

  test('GEMINI_CLI_HOME replaces the OS home, as core/utils/paths.ts:22-28 does', (t) => {
    const prev = process.env.GEMINI_CLI_HOME;
    t.after(() => { if (prev === undefined) delete process.env.GEMINI_CLI_HOME; else process.env.GEMINI_CLI_HOME = prev; });
    process.env.GEMINI_CLI_HOME = path.join(os.tmpdir(), 'gemini-cli-home-x');
    assert.equal(geminiDir(), path.join(os.tmpdir(), 'gemini-cli-home-x', '.gemini'));
  });
});

test.describe('the cached Gemini scanner', () => {
  test('an unchanged file is not read again; an appended one is read from its last line', () => {
    const home = tmpDir();
    const file = writeLines(path.join(chatsDir(home), sessionName(T0, SID)), [
      metaLine(SID, T0),
      geminiLine('m-1', T0, { tok: tokens({ input: 1000, output: 1 }), model: 'gemini-2.5-pro' }),
    ]);
    const scanner = createGeminiUsageScanner();
    assert.equal(scanner.scan({ now: NOW, startMs: WEEK_START, home }).length, 1);
    scanner.scan({ now: NOW, startMs: WEEK_START, home });
    assert.equal(scanner.stats().bytesRead, 0);
    const before = fs.statSync(file).size;
    const added = geminiLine('m-2', T0 + 10, { tok: tokens({ input: 2000, output: 2 }), model: 'gemini-2.5-pro' }) + '\n';
    fs.appendFileSync(file, added);
    const out = scanner.scan({ now: NOW, startMs: WEEK_START, home });
    assert.equal(out.length, 2);
    assert.equal(scanner.stats().appended, 1);
    assert.equal(scanner.stats().bytesRead, fs.statSync(file).size - before);
  });

  test('old messages fold into UTC 15-minute buckets without changing the cost or the floor counts', () => {
    const home = tmpDir();
    const old = NOW - 30 * DAY;
    writeLines(path.join(chatsDir(home), sessionName(old, SID)), [
      metaLine(SID, old),
      geminiLine('a', old, { tok: tokens({ input: 250000, cached: 1000, output: 100, thoughts: 10, tool: 3 }), model: 'gemini-2.5-pro' }),
      geminiLine('b', old + 60000, { tok: tokens({ input: 1000, output: 100 }), model: 'gemini-2.5-pro' }),
      geminiLine('c', old + 120000, { tok: tokens({ input: 10, output: 1 }) }),
      geminiLine('d', old + 180000, { tok: tokens({ input: 2000, cached: 500, output: 50 }), model: 'gemini-2.5-pro' }),
    ]);
    const start = NOW - 60 * DAY;
    const raw = geminiUsageEvents({ now: NOW, startMs: start, home, rawSinceMs: 0 });
    const folded = geminiUsageEvents({ now: NOW, startMs: start, home });
    assert.equal(raw.length, 4);
    assert.ok(folded.length < raw.length && folded.every((e) => Number.isInteger(e.count)));
    const a = geminiCost(raw, start, NOW, false);
    const b = geminiCost(folded, start, NOW, false);
    // Folding sums tokens before multiplying: dollars agree to rounding (1e-6).
    assert.ok(Math.abs(b.totalUsd - a.totalUsd) <= 2e-6, 'totalUsd');
    for (const k of ['longPromptFloorEvents', 'toolTokenEvents']) assert.equal(b[k], a[k], k);
    assert.deepEqual(b.byModel.map((m) => ({ ...m, usd: null })), a.byModel.map((m) => ({ ...m, usd: null })));
    b.byModel.forEach((m, i) => assert.ok(m.usd === a.byModel[i].usd || Math.abs(m.usd - a.byModel[i].usd) <= 2e-6));
  });

  test('a corrupt gemini message line is a known gap at its timestamp, and nothing read is logged', () => {
    const home = tmpDir();
    const log = require('../src/core/log');
    const lines = [];
    log.setSink((level, msg) => { lines.push(String(msg)); });
    try {
      const good = geminiLine('m-1', T0, { tok: tokens({ input: 1000, output: 1 }), model: 'gemini-2.5-pro', content: 'SECRET-CONTENT' });
      const broken = geminiLine('m-2', T0 + 5000, { tok: tokens({ input: 1000, output: 1 }), model: 'gemini-2.5-pro', content: 'SECRET-CONTENT' }).slice(0, -3);
      writeLines(path.join(chatsDir(home), sessionName(T0, SID)), [metaLine(SID, T0), good, broken, setLastUpdatedLine(T0 + 6000)]);
      const scanner = createGeminiUsageScanner();
      assert.equal(scanner.scan({ now: NOW, startMs: WEEK_START, home }).length, 1);
      assert.deepEqual(scanner.unreadRange(), { fromMs: T0 + 5000, throughMs: T0 + 5000 });
    } finally {
      log.setSink(null);
    }
    assert.equal(lines.some((l) => l.includes('SECRET')), false);
  });
});

test('message ids are keyed by a 53-bit hash: deterministic, in range, no collision over 200,000 UUIDs (ADR-003 A6 Phase A, F2)', () => {
  const { hashId } = require('../src/core/gemini/usage');
  const { randomUUID } = require('node:crypto');
  assert.equal(hashId('m-1'), hashId('m-1'));
  assert.notEqual(hashId('m-1'), hashId('m-2'));
  const seen = new Set();
  for (let i = 0; i < 200000; i += 1) {
    const h = hashId(randomUUID());
    assert.ok(Number.isSafeInteger(h) && h >= 0);
    seen.add(h);
  }
  assert.equal(seen.size, 200000);
});

test.describe('Phase A review fixes (ADR-003 A6 review rulings)', () => {
  const { isInside } = require('../src/core/scan/local-tree');
  const tok1 = tokens({ input: 1000, output: 10 });

  function spyPaths(t) {
    const seen = [];
    for (const name of ['openSync', 'readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'readlinkSync']) {
      const orig = fs[name];
      fs[name] = function spied(...args) { seen.push({ call: name, p: String(args[0]) }); return orig.apply(this, args); };
      t.after(() => { fs[name] = orig; });
    }
    return seen;
  }

  test('security F1: a junction INSIDE the tree to ~/.gemini is never followed, and oauth_creds.json is never opened', (t) => {
    const home = tmpDir();
    fs.writeFileSync(path.join(home, 'oauth_creds.json'), '{"access_token":"fixture-not-a-secret"}');
    // Shaped like a chat so that only the link rule, not the name rule, keeps it out.
    writeLines(path.join(home, 'chats', 'session-2026-09-14T10-00-deadbeef.jsonl'), [geminiLine('m-home', T0, { tok: tok1, model: 'gemini-2.5-pro' })]);
    const dir = chatsDir(home);
    writeLines(path.join(dir, sessionName(T0, SID)), [metaLine(SID, T0), geminiLine('m-1', T0, { tok: tok1, model: 'gemini-2.5-pro' })]);
    try {
      fs.symlinkSync(home, path.join(dir, 'aaaa-parent'), 'junction'); // chats/<parentId>/ slot
      fs.symlinkSync(home, path.join(home, 'tmp', 'linked-project'), 'junction'); // tmp/<project>/ slot
    } catch (err) {
      t.skip(`cannot create a junction here: ${err.code}`);
      return;
    }
    const seen = spyPaths(t);
    const events = geminiUsageEvents({ now: NOW, startMs: WEEK_START, home });
    assert.deepEqual(events.map((e) => e.input), [1000], 'only the real chat');
    assert.deepEqual(seen.filter((c) => /oauth_creds/.test(c.p)), []);
    const root = fs.realpathSync.native(path.join(home, 'tmp'));
    const opens = seen.filter((x) => x.call === 'openSync');
    assert.ok(opens.length > 0);
    for (const c of opens) assert.ok(isInside(root, c.p), `opened outside the resolved root: ${c.p}`);
  });

  test('the ROOT may still be a junction (a tmp tree moved to another drive)', (t) => {
    const elsewhere = tmpDir();
    const moved = path.join(elsewhere, 'tmp');
    writeLines(path.join(moved, 'proj', 'chats', sessionName(T0, SID)), [metaLine(SID, T0), geminiLine('m-1', T0, { tok: tok1, model: 'gemini-2.5-pro' })]);
    const home = tmpDir();
    try {
      fs.symlinkSync(moved, path.join(home, 'tmp'), 'junction');
    } catch (err) {
      t.skip(`cannot create a junction here: ${err.code}`);
      return;
    }
    assert.equal(geminiUsageEvents({ now: NOW, startMs: WEEK_START, home }).length, 1);
  });

  test('only the names the CLI writes are read: a non-chat .json in chats/ and a .json in a subagent folder are ignored', () => {
    const home = tmpDir();
    const dir = chatsDir(home);
    const legacy = JSON.stringify({ sessionId: SID, projectHash: 'h', startTime: iso(T0), lastUpdated: iso(T0), messages: [
      { id: 'x-1', timestamp: iso(T0), type: 'gemini', content: 'x', thoughts: [], tokens: tok1, model: 'gemini-2.5-pro' },
    ] });
    fs.writeFileSync(path.join(dir, 'settings.json'), legacy);
    fs.writeFileSync(path.join(dir, 'checkpoint-tag.json'), legacy);
    writeLines(path.join(dir, 'notes.jsonl'), [geminiLine('x-2', T0, { tok: tok1, model: 'gemini-2.5-pro' })]);
    fs.mkdirSync(path.join(dir, SID), { recursive: true });
    fs.writeFileSync(path.join(dir, SID, 'sub.json'), legacy);
    writeLines(path.join(dir, 'bad name', 'x.jsonl'), [geminiLine('x-3', T0, { tok: tok1, model: 'gemini-2.5-pro' })]);
    writeLines(path.join(dir, SID, 'real-sub.jsonl'), [geminiLine('ok-sub', T0, { tok: tok1, model: 'gemini-2.5-pro' })]);
    assert.equal(geminiUsageEvents({ now: NOW, startMs: WEEK_START, home }).length, 1, 'only the subagent .jsonl');
  });

  test('review F6/F8: an all-zero message is skipped; unrecordedCalls is true only when there is an amount', () => {
    const home = tmpDir();
    writeLines(path.join(chatsDir(home), sessionName(T0, SID)), [
      metaLine(SID, T0),
      geminiLine('z', T0, { tok: tokens({ input: 0, output: 0 }), model: 'gemini-2.5-pro' }),
      geminiLine('u', T0 + 1, { tok: tok1, model: 'gemini-9-unknown' }),
    ]);
    const events = geminiUsageEvents({ now: NOW, startMs: WEEK_START, home });
    assert.deepEqual(events.map((e) => e.model), ['gemini-9-unknown']);
    const cost = geminiCost(events, WEEK_START, NOW, false);
    assert.equal(cost.totalUsd, 0);
    assert.equal(cost.unrecordedCalls, false, 'nothing priced: no amount for the cause to qualify');
  });

  test('review F9: the owner of a deduped id fails to read; every id is counted exactly once on that scan and the next', (t) => {
    const home = tmpDir();
    const dir = chatsDir(home);
    const msgs = [
      { id: 'm-a', timestamp: iso(T0), type: 'gemini', content: 'x', thoughts: [], tokens: tokens({ input: 100, output: 1 }), model: 'gemini-2.5-pro' },
      { id: 'm-b', timestamp: iso(T0 + 1), type: 'gemini', content: 'x', thoughts: [], tokens: tokens({ input: 200, output: 1 }), model: 'gemini-2.5-pro' },
    ];
    const legacy = path.join(dir, sessionName(T0, SID, '.json'));
    fs.writeFileSync(legacy, JSON.stringify({ sessionId: SID, projectHash: 'h', startTime: iso(T0), lastUpdated: iso(T0), messages: msgs }));
    writeLines(path.join(dir, sessionName(T0, SID, '.jsonl')), [metaLine(SID, T0), ...msgs.map((m) => JSON.stringify(m))]);
    const scanner = createGeminiUsageScanner();
    const total = (evs) => evs.reduce((s, e) => s + e.input, 0);
    assert.equal(total(scanner.scan({ now: NOW, startMs: WEEK_START, home })), 300);

    // The owner (.json, read first) changes and then cannot be read.
    fs.utimesSync(legacy, new Date(NOW), new Date(NOW - 1000));
    const orig = fs.readFileSync;
    fs.readFileSync = function failing(p, ...rest) {
      if (String(p) === legacy) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
      return orig.call(this, p, ...rest);
    };
    t.after(() => { fs.readFileSync = orig; });
    assert.equal(total(scanner.scan({ now: NOW, startMs: WEEK_START, home })), 300, 'handed to the .jsonl copy at once');
    assert.ok(scanner.unreadRange(), 'and the unreadable owner is a known gap');
    fs.readFileSync = orig;
    assert.equal(total(scanner.scan({ now: NOW, startMs: WEEK_START, home })), 300, 'readable again: still once');
    assert.equal(total(scanner.scan({ now: NOW, startMs: WEEK_START, home })), 300);
  });

  test('review F9: the same message id in two projects is counted once (global dedupe)', () => {
    const home = tmpDir();
    const line = geminiLine('shared-id', T0, { tok: tok1, model: 'gemini-2.5-pro' });
    writeLines(path.join(chatsDir(home, 'project-a'), sessionName(T0, SID)), [metaLine(SID, T0), line]);
    writeLines(path.join(chatsDir(home, 'project-b'), sessionName(T0, SID)), [metaLine(SID, T0), line]);
    assert.equal(geminiUsageEvents({ now: NOW, startMs: WEEK_START, home }).length, 1);
  });

  test('security F4: more than 64 distinct model ids fold into unknown and the scan reports a known gap', () => {
    const home = tmpDir();
    const lines = [metaLine(SID, T0)];
    for (let i = 0; i < 70; i += 1) lines.push(geminiLine(`m-${i}`, T0 + i, { tok: tok1, model: `model-${String(i).padStart(2, '0')}` }));
    writeLines(path.join(chatsDir(home), sessionName(T0, SID)), lines);
    const scanner = createGeminiUsageScanner();
    const events = scanner.scan({ now: NOW, startMs: WEEK_START, home });
    const models = new Set(events.map((e) => e.model));
    assert.equal(models.size, 65, '64 kept plus unknown');
    assert.equal(events.filter((e) => e.model === 'unknown').length, 6);
    assert.deepEqual(scanner.unreadRange(), { fromMs: T0 + 64, throughMs: T0 + 69 });
  });
});
