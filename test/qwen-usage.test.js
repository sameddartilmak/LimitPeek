'use strict';

/**
 * Qwen Code reader and pricer.
 *
 * Nobody here has a Qwen Code install, so these fixtures are the only test
 * data. Every record mirrors the writer at tag v0.24.6
 * (github.com/QwenLM/qwen-code, packages/core/src/services/tokenUsageService.ts:
 * one schema-v1 JSON line per successful API response, appended to
 * `<runtime>/usage/token-usage-<local YYYY-MM>.jsonl`; the runtime directory
 * from packages/core/src/config/storage.ts).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const qwen = require('../src/core/qwen/usage');
const { createQwenUsageScanner, qwenUsageEvents, sumQwenTokens, qwenHome, qwenUsageDir } = qwen;
const { qwenCost, priceFor, PRICES_AS_OF, CACHED_SHARE } = require('../src/core/qwen/pricing');
const { tierClassOf } = require('../src/core/qwen/tiers');
const rollout = require('../src/core/codex/rollout');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-14T12:00:00.000Z');
const WEEK_START = NOW - 7 * DAY;
const T0 = NOW - 3 * HOUR;

function tmpDir(prefix = 'qwen-usage-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

function pad(n) {
  return String(n).padStart(2, '0');
}
/** The writer's LOCAL month and date (tokenUsageService.ts: local, not UTC). */
function localMonth(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
function localDate(ms) {
  const d = new Date(ms);
  return `${localMonth(ms)}-${pad(d.getDate())}`;
}

let seq = 0;
/** One schema-v1 record, exactly the writer's field set. */
function record(ms, over = {}) {
  seq += 1;
  return {
    schemaVersion: 1,
    id: `0f3c9a52-7d1e-4b8a-9c21-${String(seq).padStart(12, '0')}`,
    timestamp: new Date(ms).toISOString(),
    localDate: localDate(ms),
    localMonth: localMonth(ms),
    sessionId: '6b1e2f40-1c3d-4e5f-8a9b-0c1d2e3f4a5b',
    model: 'qwen3-coder-plus',
    authType: 'openai',
    source: 'main',
    inputTokens: 48211,
    outputTokens: 812,
    cachedTokens: 40960,
    thoughtsTokens: 0,
    totalTokens: 49023,
    apiDurationMs: 6120,
    ...over,
  };
}

/** `<home>/usage/token-usage-<month>.jsonl` (with a `home` override the runtime dir IS the home). */
function usageFile(home, month) {
  return path.join(home, 'usage', `token-usage-${month}.jsonl`);
}

function writeRecords(home, records, month = localMonth(T0)) {
  const file = usageFile(home, month);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
  return file;
}

const scan = (home, over = {}) => {
  const scanner = createQwenUsageScanner();
  const events = scanner.scan({ now: NOW, startMs: WEEK_START, home, ...over });
  return { events, scanner };
};

test.describe('what the Qwen Code reader counts', () => {
  test('inputTokens includes the cached part, and thoughts are part of output, never added again', () => {
    const home = tmpDir();
    writeRecords(home, [record(T0, { inputTokens: 48211, cachedTokens: 40960, outputTokens: 812, thoughtsTokens: 300 })]);
    const { events } = scan(home);
    assert.equal(events.length, 1);
    assert.deepEqual({ input: events[0].input, cached: events[0].cached, output: events[0].output }, { input: 7251, cached: 40960, output: 812 });
    const { tokens } = sumQwenTokens(events, WEEK_START, NOW);
    assert.deepEqual(tokens, { input: 7251, output: 812, cacheWrite: 0, cacheRead: 40960, billable: 8063 });
  });

  test('every line is its own response: identical counts with different ids are both counted', () => {
    const home = tmpDir();
    writeRecords(home, [record(T0, { inputTokens: 100, cachedTokens: 0, outputTokens: 10 }), record(T0, { inputTokens: 100, cachedTokens: 0, outputTokens: 10 })]);
    assert.equal(scan(home).events.length, 2);
  });

  test('a record whose every count is 0 carries no usage', () => {
    const home = tmpDir();
    writeRecords(home, [record(T0, { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0 })]);
    const { events, scanner } = scan(home);
    assert.deepEqual(events, []);
    assert.equal(scanner.unreadRange(), null);
  });

  test('a model that is not id-shaped is counted as unknown, and unknown is unpriced', () => {
    const home = tmpDir();
    writeRecords(home, [record(T0, { model: 'qwen 3 <coder>' })]);
    const { events } = scan(home);
    assert.equal(events[0].model, 'unknown');
    assert.equal(qwenCost(events, WEEK_START, NOW, false).byModel[0].usd, null);
  });
});

test.describe('every field of a v1 record is checked; a line that is not v1 is a known gap', () => {
  const bad = [
    ['a later schema version', { schemaVersion: 2 }],
    ['no schema version', { schemaVersion: undefined }],
    ['a negative count', { outputTokens: -1 }],
    ['a fractional count', { inputTokens: 10.5 }],
    ['a count given as text', { cachedTokens: '40960' }],
    ['an unsafe integer', { inputTokens: 2 ** 53 }],
    ['thoughts missing', { thoughtsTokens: undefined }],
    ['more cached than input', { inputTokens: 10, cachedTokens: 11 }],
    ['no id', { id: undefined }],
    ['an id that is not bounded printable text', { id: 'x'.repeat(200) }],
    ['no session id', { sessionId: 42 }],
    ['an unparseable timestamp', { timestamp: 'yesterday' }],
    ['a localDate of the wrong shape', { localDate: '14.09.2026' }],
    ['a localMonth of the wrong shape', { localMonth: 2026 }],
    ['an authType that is not text', { authType: { kind: 'openai' } }],
    ['a source that is not text', { source: null }],
    ['a model that is not text', { model: 7 }],
    ['a negative duration', { apiDurationMs: -5 }],
  ];
  for (const [name, over] of bad) {
    test(`${name}: dropped, and its instant marked unread`, () => {
      const home = tmpDir();
      const r = record(T0 + 5, over);
      for (const [k, v] of Object.entries(over)) if (v === undefined) delete r[k];
      writeRecords(home, [record(T0), r]);
      const { events, scanner } = scan(home);
      assert.equal(events.length, 1, 'the good line still counts');
      const range = scanner.unreadRange();
      assert.ok(range, 'the bad line is a known gap');
      if (Number.isFinite(Date.parse(r.timestamp))) assert.deepEqual(range, { fromMs: T0 + 5, throughMs: T0 + 5 });
    });
  }

  test('a line that is not JSON is a known gap at the time it names', () => {
    const home = tmpDir();
    const torn = JSON.stringify(record(T0 + 7)).slice(0, 120);
    writeRecords(home, [record(T0), torn, record(T0 + 9)]);
    const { events, scanner } = scan(home);
    assert.equal(events.length, 2);
    assert.deepEqual(scanner.unreadRange(), { fromMs: T0 + 7, throughMs: T0 + 7 });
  });

  test('the record\'s all-class total is never needed: a total that disagrees changes nothing', () => {
    const home = tmpDir();
    writeRecords(home, [record(T0, { totalTokens: 1 })]);
    const { events, scanner } = scan(home);
    assert.equal(events.length, 1);
    assert.equal(scanner.unreadRange(), null);
  });
});

test.describe('the Qwen Code reader reads only the usage log', () => {
  test('chat recordings, tmp/, usage_record.jsonl and the settings file are never opened, listed or stat-ed', (t) => {
    const home = tmpDir();
    const secret = path.join(home, 'settings.json');
    fs.writeFileSync(secret, JSON.stringify({ security: { auth: { apiKey: 'fixture-not-a-secret' } }, advanced: { runtimeOutputDir: '/elsewhere' } }));
    const chat = path.join(home, 'projects', 'p1', 'chats', 'session-1.jsonl');
    fs.mkdirSync(path.dirname(chat), { recursive: true });
    fs.writeFileSync(chat, JSON.stringify(record(T0, { inputTokens: 999999 })) + '\n');
    fs.mkdirSync(path.join(home, 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(home, 'usage_record.jsonl'), JSON.stringify(record(T0, { inputTokens: 999999 })) + '\n');
    writeRecords(home, [record(T0, { inputTokens: 100, cachedTokens: 0 })]);
    // Other names in usage/ are not the log.
    fs.writeFileSync(path.join(home, 'usage', 'token-usage-2026-09.jsonl.bak'), JSON.stringify(record(T0, { inputTokens: 999999 })) + '\n');
    fs.writeFileSync(path.join(home, 'usage', 'token-usage.jsonl'), JSON.stringify(record(T0, { inputTokens: 999999 })) + '\n');
    const seen = [];
    for (const name of ['openSync', 'readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'readlinkSync']) {
      const orig = fs[name];
      fs[name] = function spied(...args) { seen.push(`${name}:${String(args[0])}`); return orig.apply(this, args); };
      t.after(() => { fs[name] = orig; });
    }
    const { events } = scan(home);
    assert.deepEqual(events.map((e) => e.input), [100]);
    assert.ok(seen.some((c) => c.startsWith('openSync:') && c.endsWith('.jsonl')), 'the spy observes the real read');
    assert.deepEqual(seen.filter((c) => /settings\.json|chats|usage_record|[\\/]tmp\b|\.bak$/.test(c)), []);
    assert.deepEqual(seen.filter((c) => c.startsWith('readdirSync:') && path.resolve(c.slice('readdirSync:'.length)) === path.resolve(home)), [],
      'the Qwen home itself is never listed');
  });

  test('only the month files that overlap the history span are read (one month of slack each side)', (t) => {
    const home = tmpDir();
    writeRecords(home, [record(T0)]);
    const far = usageFile(home, '2025-01');
    fs.writeFileSync(far, JSON.stringify(record(Date.parse('2025-01-10T12:00:00Z'))) + '\n');
    const opened = [];
    const orig = fs.openSync;
    fs.openSync = function spied(...args) { opened.push(String(args[0])); return orig.apply(this, args); };
    t.after(() => { fs.openSync = orig; });
    scan(home, { startMs: WEEK_START });
    assert.equal(opened.some((p) => p.endsWith('token-usage-2025-01.jsonl')), false);
  });

  test('a usage log that is a symbolic link is skipped', (t) => {
    const outside = tmpDir();
    const target = path.join(outside, 'log.jsonl');
    fs.writeFileSync(target, JSON.stringify(record(T0)) + '\n');
    const home = tmpDir();
    const link = usageFile(home, localMonth(T0));
    fs.mkdirSync(path.dirname(link), { recursive: true });
    try {
      fs.symlinkSync(target, link, 'file');
    } catch (err) {
      t.skip(`file symlink not permitted here: ${err.code}`);
      return;
    }
    assert.deepEqual(scan(home).events, []);
  });
});

test.describe('where the log is: QWEN_HOME, QWEN_RUNTIME_DIR, and no log at all', () => {
  function withEnv(t, vars) {
    const prev = {};
    for (const [k, v] of Object.entries(vars)) {
      prev[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    t.after(() => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
    qwen._resetForTests();
    rollout._resetPathGuardForTests();
  }

  test('the global dir is QWEN_HOME when set, with Qwen\'s own ~ expansion, else ~/.qwen', (t) => {
    withEnv(t, { QWEN_HOME: undefined, QWEN_RUNTIME_DIR: undefined });
    assert.equal(qwenHome(), path.join(os.homedir(), '.qwen'));
    process.env.QWEN_HOME = path.join(os.tmpdir(), 'qwen-home-x');
    assert.equal(qwenHome(), path.join(os.tmpdir(), 'qwen-home-x'));
    process.env.QWEN_HOME = '~/qwen-elsewhere';
    assert.equal(qwenHome(), path.join(os.homedir(), 'qwen-elsewhere'));
  });

  test('a RELATIVE QWEN_HOME is resolved by Qwen against a directory we cannot know, so it reads as not found', (t) => {
    withEnv(t, { QWEN_HOME: 'relative\\qwen', QWEN_RUNTIME_DIR: undefined });
    assert.equal(qwenHome(), null);
  });

  test('QWEN_RUNTIME_DIR moves the usage log; the global dir still decides "installed"', (t) => {
    const global = tmpDir();
    const runtime = tmpDir();
    withEnv(t, { QWEN_HOME: global, QWEN_RUNTIME_DIR: runtime });
    assert.equal(qwenUsageDir().dir, path.join(runtime, 'usage'));
    writeRecords(runtime, [record(T0, { inputTokens: 55, cachedTokens: 0 })]);
    writeRecords(global, [record(T0, { inputTokens: 999, cachedTokens: 0 })]);
    const events = createQwenUsageScanner().scan({ now: NOW, startMs: WEEK_START });
    assert.deepEqual(events.map((e) => e.input), [55], 'only the runtime log is read');
  });

  test('a RELATIVE QWEN_RUNTIME_DIR is a log we know exists but cannot name: all of it is unread', (t) => {
    const global = tmpDir();
    withEnv(t, { QWEN_HOME: global, QWEN_RUNTIME_DIR: 'out/qwen' });
    const scanner = createQwenUsageScanner();
    assert.deepEqual(scanner.scan({ now: NOW, startMs: WEEK_START }), []);
    assert.deepEqual(scanner.unreadRange(), { fromMs: 0, throughMs: NOW });
    assert.equal(scanner.stats().usageLogAbsent, false, 'not "no log": a log we could not read');
  });

  test('a home override is the runtime dir too, so a developer\'s own QWEN_RUNTIME_DIR never reaches a test', (t) => {
    const home = tmpDir();
    withEnv(t, { QWEN_RUNTIME_DIR: tmpDir() });
    assert.equal(qwenUsageDir(home).dir, path.join(home, 'usage'));
  });

  test('a network QWEN_HOME or QWEN_RUNTIME_DIR is refused without being opened or logged', (t) => {
    const lines = [];
    const log = require('../src/core/log');
    log.setSink((level, msg) => { lines.push(String(msg)); });
    t.after(() => log.setSink(null));
    withEnv(t, { QWEN_HOME: String.raw`\\fileserver\share\.qwen`, QWEN_RUNTIME_DIR: undefined });
    assert.equal(qwenHome(), null);
    assert.deepEqual(qwenUsageEvents({ now: NOW, startMs: WEEK_START }), []);
    process.env.QWEN_HOME = tmpDir();
    process.env.QWEN_RUNTIME_DIR = String.raw`\\fileserver\share\runtime`;
    qwen._resetForTests();
    assert.equal(qwenUsageDir().dir, null);
    assert.deepEqual(qwenUsageEvents({ now: NOW, startMs: WEEK_START }), []);
    assert.equal(lines.some((l) => l.includes('fileserver')), false, 'no path in any log line');
  });

  test('installed with no usage log at all (older than v0.18.4, or statistics off) says so; a log, even empty, does not', () => {
    const home = tmpDir();
    const none = createQwenUsageScanner();
    assert.deepEqual(none.scan({ now: NOW, startMs: WEEK_START, home }), []);
    assert.equal(none.stats().usageLogAbsent, true);
    fs.mkdirSync(path.join(home, 'usage'));
    none.scan({ now: NOW, startMs: WEEK_START, home });
    assert.equal(none.stats().usageLogAbsent, true, 'an empty usage folder is still no log');
    writeRecords(home, [], '2026-01');
    none.scan({ now: NOW, startMs: WEEK_START, home });
    assert.equal(none.stats().usageLogAbsent, false, 'a log exists, even one outside the span');
  });
});

test.describe('Alibaba Cloud Model Studio prices (2026-09-28, international)', () => {
  const ev = (over) => ({ ts: T0, model: 'qwen3-coder-plus', tier: 0, input: 0, cached: 0, output: 0, ...over });
  const cost = (events) => qwenCost(events, WEEK_START, NOW, false);

  test('the tier is chosen by the WHOLE input (K = 1,000), cached part included', () => {
    assert.equal(tierClassOf(32000), 0);
    assert.equal(tierClassOf(32001), 1);
    assert.equal(tierClassOf(128000), 1);
    assert.equal(tierClassOf(256001), 3);
    assert.equal(tierClassOf(1000001), 4);
    const home = tmpDir();
    // 32,001 input of which 30,000 cached: tier 1 although the uncached part is small.
    writeRecords(home, [record(T0, { inputTokens: 32001, cachedTokens: 30000, outputTokens: 0 })]);
    const events = scan(home).events;
    assert.equal(events[0].tier, 1);
    assert.equal(cost(events).totalUsd, Math.round((2001 * 1.8 + 30000 * 1.8 * CACHED_SHARE) / 1e6 * 1e6) / 1e6);
  });

  test('every published tier of every priced model, input and output', () => {
    const table = {
      'qwen3-coder-plus': [[1, 5], [1.8, 9], [3, 15], [6, 60]],
      'qwen3-coder-next': [[0.3, 1.5], [0.5, 2.5], [0.8, 4]],
      'qwen3.5-plus': [[0.4, 2.4], [0.4, 2.4], [0.4, 2.4], [0.5, 3]],
      'qwen3.6-plus': [[0.5, 3], [0.5, 3], [0.5, 3], [2, 6]],
      'qwen3-max': [[1.2, 6], [2.4, 12], [3, 15]],
    };
    for (const [model, tiers] of Object.entries(table)) {
      tiers.forEach(([input, output], cls) => {
        const p = priceFor(model, cls);
        assert.deepEqual([p.input, p.output], [input, output], `${model} class ${cls}`);
      });
    }
  });

  test('cached input is priced at 10% of the tier\'s input rate (the explicit-cache hit rate, the lower of the two)', () => {
    assert.equal(CACHED_SHARE, 0.10);
    const c = cost([ev({ tier: 0, cached: 1000000 })]);
    assert.equal(c.totalUsd, 0.1);
    assert.equal(c.byClass.cacheRead, 0.1);
  });

  test('a request above the model\'s last published tier has no rate: unpriced, beside the priced part', () => {
    const c = cost([ev({ model: 'qwen3-coder-next', tier: 3, input: 300000 }), ev({ model: 'qwen3-coder-next', tier: 0, input: 1000000 })]);
    assert.deepEqual(c.byModel.map((m) => [m.model, m.speed, m.usd]), [
      ['qwen3-coder-next', 'standard', 0.3],
      ['qwen3-coder-next', 'standard-long-context', null],
    ]);
    assert.deepEqual(c.unpricedModels, ['qwen3-coder-next']);
    assert.equal(priceFor('qwen3-coder-plus', 4), 'over', 'above 1M on any model');
  });

  test('exact ids only: other vendors\' Coding Plan models, a promotional price and a dated id are unpriced, never $0', () => {
    for (const model of ['glm-5', 'glm-4.7', 'kimi-k2.5', 'MiniMax-M2.5', 'qwen3.7-plus', 'qwen3-coder-plus-2026-07-22', 'Qwen3-Coder-Plus']) {
      assert.equal(priceFor(model, 0), null, model);
    }
    const c = cost([ev({ model: 'glm-5', input: 1000, output: 10 })]);
    assert.equal(c.totalUsd, 0);
    assert.equal(c.byModel[0].usd, null);
    assert.deepEqual(c.byModel[0].tokens, { input: 1000, output: 10, cacheWrite: 0, cacheRead: 0, billable: 1010 }, 'its tokens are still counted');
    assert.equal(c.unrecordedCalls, false, 'nothing priced: no amount for the cause to qualify');
  });

  test('a priced figure is always a floor (unrecorded calls) and states the price date', () => {
    const c = cost([ev({ input: 1000000, output: 100000 })]);
    assert.equal(c.totalUsd, 1 + 0.5);
    assert.equal(c.unrecordedCalls, true);
    assert.equal(c.pricesAsOf, PRICES_AS_OF);
    assert.equal(PRICES_AS_OF, '2026-09-28');
    for (const k of ['fallbackWriteEvents', 'cacheWriteEvents', 'longPromptFloorEvents', 'toolTokenEvents', 'partialUsageEvents']) assert.equal(c[k], 0, k);
  });

  test('no event in the window: no cost at all, not a $0 one', () => {
    assert.equal(cost([ev({ ts: WEEK_START - 1, input: 5 })]), null);
  });
});

test.describe('the cached Qwen Code scanner', () => {
  test('unchanged files are not re-read, appends are read incrementally, and folding keeps tiers apart', () => {
    const home = tmpDir();
    const old = NOW - 40 * DAY;
    const start = NOW - 60 * DAY;
    // The old records sit in their own month file; one small and one large request in one bucket.
    writeRecords(home, [
      record(old, { inputTokens: 1000, cachedTokens: 0, outputTokens: 10 }),
      record(old + 60000, { inputTokens: 200000, cachedTokens: 0, outputTokens: 10 }),
      record(old + 120000, { inputTokens: 2000, cachedTokens: 500, outputTokens: 20 }),
    ], localMonth(old));
    const file = writeRecords(home, [record(T0, { inputTokens: 40, cachedTokens: 0, outputTokens: 4 })]);
    const scanner = createQwenUsageScanner();
    const folded = scanner.scan({ now: NOW, startMs: start, home });
    scanner.scan({ now: NOW, startMs: start, home });
    assert.equal(scanner.stats().bytesRead, 0, 'nothing changed, nothing read');
    const raw = qwenUsageEvents({ now: NOW, startMs: start, home, rawSinceMs: 0 });
    assert.equal(raw.length, 4);
    assert.equal(folded.length, 3, 'the two tier-0 old records share a bucket; the tier-2 one does not');
    assert.deepEqual(qwenCost(folded, start, NOW, false), qwenCost(raw, start, NOW, false));

    fs.appendFileSync(file, `${JSON.stringify(record(T0 + 1, { inputTokens: 7, cachedTokens: 0, outputTokens: 1 }))}\n`);
    const again = scanner.scan({ now: NOW, startMs: start, home });
    assert.equal(scanner.stats().appended, 1, 'read from the last complete line');
    assert.equal(again.length, 4);
  });
});
