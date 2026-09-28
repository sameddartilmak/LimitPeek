'use strict';

/**
 * Grok Build reader and its reported-cost module.
 *
 * Nobody here has a Grok Build install, so these fixtures are the only test
 * data. Every file mirrors the writer at xai-org/grok-build main f0e3be11
 * (2026-09-23, crate 1.0.41): `<home>/sessions/<encoded-cwd>/<session-id>/usage.json`
 * from xai-grok-shell/src/session/usage_file.rs, rewritten after every turn,
 * with per-turn counts, per-model splits and the server-reported cost in
 * ticks (1e10 per USD).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const grok = require('../src/core/grok/usage');
const { createGrokUsageScanner, grokUsageEvents, sumGrokTokens, grokUsageIncomplete, grokHome, TICKS_PER_USD } = grok;
const { grokCost } = require('../src/core/grok/cost');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-14T12:00:00.000Z');
const WEEK_START = NOW - 7 * DAY;
const T0 = NOW - 3 * HOUR;
const CWD = 'Users%2Fdev%2Fproject';
const SLUG = 'project-0123456789abcdef';

function tmpDir(prefix = 'grok-usage-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

/** One turn as usage_file.rs writes it. `usd` becomes costUsdTicks. */
function turn(n, ms, over = {}) {
  const { usd = 0.01, ...rest } = over;
  return {
    turnNumber: n,
    startedAt: new Date(ms - 5000).toISOString(),
    endedAt: new Date(ms).toISOString(),
    inputTokens: 10000,
    outputTokens: 500,
    cachedReadTokens: 8000,
    cacheCreationTokens: 1000,
    reasoningTokens: 200,
    totalTokens: 10500,
    modelCalls: 2,
    costUsdTicks: Math.round(usd * TICKS_PER_USD),
    costIsPartial: false,
    usageIsIncomplete: false,
    ...rest,
  };
}

function usageDoc(sessionId, turns, over = {}) {
  return {
    sessionId,
    updatedAt: new Date(NOW - HOUR).toISOString(),
    session: { turns: turns.length, primaryModelId: 'grok-4.6', modelUsage: { 'grok-4.6': {} } },
    turns,
    ...over,
  };
}

function writeSession(home, sessionId, doc, cwd = CWD) {
  const file = path.join(home, 'sessions', cwd, sessionId, 'usage.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc));
  return file;
}

const scan = (home, over = {}) => {
  const scanner = createGrokUsageScanner();
  const events = scanner.scan({ now: NOW, startMs: WEEK_START, home, ...over });
  return { events, scanner };
};

test.describe('what the Grok Build reader counts', () => {
  test('the turns at their endedAt; input is the whole prompt, so cache reads and writes come out of it', () => {
    const home = tmpDir();
    writeSession(home, 's1', usageDoc('s1', [turn(1, T0)]));
    const { events } = scan(home);
    assert.equal(events.length, 1);
    assert.equal(events[0].ts, T0);
    const { tokens } = sumGrokTokens(events, WEEK_START, NOW);
    assert.deepEqual(tokens, { input: 1000, output: 500, cacheWrite: 1000, cacheRead: 8000, billable: 2500 },
      'reasoning is part of output and is never added again');
  });

  test('uncached input is floored at 0 when the cache counts exceed the prompt', () => {
    const home = tmpDir();
    writeSession(home, 's1', usageDoc('s1', [turn(1, T0, { inputTokens: 100, cachedReadTokens: 90, cacheCreationTokens: 50 })]));
    assert.equal(scan(home).events[0].input, 0);
  });

  test('a turn is split by its own modelUsage; without one it goes to the session\'s primary model, else unknown', () => {
    const home = tmpDir();
    const split = turn(1, T0, {
      modelUsage: {
        'grok-4.6': { inputTokens: 6000, outputTokens: 300, cachedReadTokens: 5000, cacheCreationTokens: 0, reasoningTokens: 100, totalTokens: 6300, modelCalls: 1, costUsdTicks: 0.006 * TICKS_PER_USD },
        'grok-code-fast-2': { inputTokens: 4000, outputTokens: 200, cachedReadTokens: 3000, cacheCreationTokens: 1000, reasoningTokens: 0, totalTokens: 4200, modelCalls: 1, costUsdTicks: 0.004 * TICKS_PER_USD },
      },
    });
    writeSession(home, 's1', usageDoc('s1', [split, turn(2, T0 + 1000)]));
    writeSession(home, 's2', usageDoc('s2', [turn(1, T0 + 2000, { inputTokens: 7, cachedReadTokens: 0, cacheCreationTokens: 0 })], { session: {} }));
    const { events } = scan(home);
    assert.deepEqual(events.map((e) => [e.model, e.input]), [
      ['grok-4.6', 1000],
      ['grok-code-fast-2', 0],
      ['grok-4.6', 1000],
      ['unknown', 7],
    ]);
    const c = grokCost(events, WEEK_START, NOW, false);
    assert.deepEqual(c.byModel.map((m) => [m.model, m.usd]), [['grok-4.6', 0.016], ['unknown', 0.01], ['grok-code-fast-2', 0.004]]);
  });

  test('the walk never descends into subagents/: the parent totals already include them', () => {
    const home = tmpDir();
    writeSession(home, 's1', usageDoc('s1', [turn(1, T0)]));
    const sub = path.join(home, 'sessions', CWD, 's1', 'subagents', 'a1', 'usage.json');
    fs.mkdirSync(path.dirname(sub), { recursive: true });
    fs.writeFileSync(sub, JSON.stringify(usageDoc('a1', [turn(1, T0 + 5, { inputTokens: 99999 })])));
    assert.equal(scan(home).events.length, 1);
  });

  test('both encoded-cwd shapes are walked, and neither name is ever decoded', () => {
    const home = tmpDir();
    writeSession(home, 's1', usageDoc('s1', [turn(1, T0)]), CWD);
    writeSession(home, 's2', usageDoc('s2', [turn(1, T0 + 1)]), SLUG);
    assert.equal(scan(home).events.length, 2);
  });
});

test.describe('forked sessions: a copied turn is taken once', () => {
  test('a fork starts from a verbatim copy of the parent; the copied turns are dropped by content', () => {
    const home = tmpDir();
    const parent = [turn(1, T0), turn(2, T0 + 60000, { usd: 0.02 })];
    writeSession(home, 'parent', usageDoc('parent', parent));
    // The fork's usage.json: the parent's, then its own turns.
    writeSession(home, 'fork', usageDoc('fork', [...parent, turn(3, T0 + 120000, { usd: 0.03, inputTokens: 1234, cachedReadTokens: 0, cacheCreationTokens: 0 })]));
    // A fork of the fork, in another project directory.
    writeSession(home, 'fork2', usageDoc('fork2', [...parent, turn(3, T0 + 120000, { usd: 0.03, inputTokens: 1234, cachedReadTokens: 0, cacheCreationTokens: 0 }), turn(4, T0 + 180000, { usd: 0.04 })]), SLUG);
    const { events, scanner } = scan(home);
    assert.equal(events.length, 4, 'four distinct turns');
    assert.equal(grokCost(events, WEEK_START, NOW, false).totalUsd, 0.1);
    assert.equal(scanner.stats().duplicateTurns, 5);
  });

  test('two different turns never collide: a different instant, number, count or tick is a different turn', () => {
    const home = tmpDir();
    writeSession(home, 'a', usageDoc('a', [turn(1, T0)]));
    writeSession(home, 'b', usageDoc('b', [turn(1, T0 + 1)]));
    writeSession(home, 'c', usageDoc('c', [turn(2, T0)]));
    writeSession(home, 'd', usageDoc('d', [turn(1, T0, { outputTokens: 501 })]));
    writeSession(home, 'e', usageDoc('e', [turn(1, T0, { usd: 0.0100000001 })]));
    assert.equal(scan(home).events.length, 5);
  });
});

test.describe('the reported cost', () => {
  test('costUsdTicks is xAI\'s own amount, 1e10 ticks per USD, with no price table and no date', () => {
    const home = tmpDir();
    writeSession(home, 's1', usageDoc('s1', [turn(1, T0, { usd: 0.1234 })]));
    const c = grokCost(scan(home).events, WEEK_START, NOW, false);
    assert.equal(c.totalUsd, 0.1234);
    assert.equal(c.pricesAsOf, '');
    assert.deepEqual(c.byModel.map((m) => [m.model, m.speed, m.pricedAs]), [['grok-4.6', 'reported', 'grok-4.6']]);
    assert.deepEqual(c.byClass, { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 }, 'no class split is reported');
    assert.equal(c.unrecordedCalls, false);
  });

  test('a turn with no reported cost, or 0, is unpriced — never $0 — and keeps its tokens', () => {
    const home = tmpDir();
    const none = turn(2, T0 + 1, { outputTokens: 7 });
    delete none.costUsdTicks;
    writeSession(home, 's1', usageDoc('s1', [turn(1, T0, { usd: 0 }), none, turn(3, T0 + 2, { costUsdTicks: null })]));
    const c = grokCost(scan(home).events, WEEK_START, NOW, false);
    assert.equal(c.totalUsd, 0);
    assert.deepEqual(c.byModel.map((m) => [m.speed, m.usd]), [['no-reported-cost', null]]);
    assert.deepEqual(c.unpricedModels, ['grok-4.6']);
    assert.equal(c.byModel[0].tokens.output, 500 + 7 + 500);
  });

  test('costIsPartial or usageIsIncomplete keeps the amount and makes it a floor; only the latter makes the count one', () => {
    const home = tmpDir();
    writeSession(home, 's1', usageDoc('s1', [
      turn(1, T0, { usd: 0.5, costIsPartial: true }),
      turn(2, T0 + 1, { usd: 0.25, usageIsIncomplete: true }),
      turn(3, T0 + 2, { usd: 0.125 }),
    ]));
    const { events } = scan(home);
    const c = grokCost(events, WEEK_START, NOW, false);
    assert.equal(c.totalUsd, 0.875, 'every reported amount is counted');
    assert.equal(c.partialUsageEvents, 2);
    assert.equal(grokUsageIncomplete(events, WEEK_START, NOW), true);
    assert.equal(grokUsageIncomplete(events.filter((e) => !e.incomplete), WEEK_START, NOW), false);
  });

  test('a per-model entry\'s own flags count as well as the turn\'s', () => {
    const home = tmpDir();
    writeSession(home, 's1', usageDoc('s1', [turn(1, T0, {
      modelUsage: {
        'grok-4.6': { inputTokens: 10, outputTokens: 1, costUsdTicks: 1e8, costIsPartial: true },
        'grok-code-fast-2': { inputTokens: 10, outputTokens: 1, costUsdTicks: 1e8 },
      },
    })]));
    const c = grokCost(scan(home).events, WEEK_START, NOW, false);
    assert.equal(c.partialUsageEvents, 1);
  });
});

test.describe('every field is checked; a shape the writer does not produce is a known gap', () => {
  const badTurns = [
    ['a negative count', { outputTokens: -1 }],
    ['a count given as text', { inputTokens: '10000' }],
    ['a fractional tick count', { costUsdTicks: 12.5 }],
    ['ticks given as text', { costUsdTicks: '100' }],
    ['a flag that is not a boolean', { costIsPartial: 'yes' }],
    ['an incomplete flag that is not a boolean', { usageIsIncomplete: 1 }],
    ['a negative turn number', { turnNumber: -1 }],
    ['modelUsage that is a list', { modelUsage: [] }],
    ['a per-model entry that is not usage', { modelUsage: { 'grok-4.6': { inputTokens: 'lots' } } }],
  ];
  for (const [name, over] of badTurns) {
    test(`${name}: the turn is dropped and its instant marked unread`, () => {
      const home = tmpDir();
      writeSession(home, 's1', usageDoc('s1', [turn(1, T0), turn(2, T0 + 9, over)]));
      const { events, scanner } = scan(home);
      assert.equal(events.length, 1, 'the good turn still counts');
      assert.deepEqual(scanner.unreadRange(), { fromMs: T0 + 9, throughMs: T0 + 9 });
    });
  }

  test('a turn with no parseable endedAt is dropped as an untimed gap', () => {
    const home = tmpDir();
    writeSession(home, 's1', usageDoc('s1', [turn(1, T0), turn(2, T0, { endedAt: 'soon' })]));
    const { events, scanner } = scan(home);
    assert.equal(events.length, 1);
    assert.ok(scanner.unreadRange(), 'still a known gap');
  });

  const badFiles = [
    ['not JSON (caught mid-rewrite)', '{"sessionId":"s1","turns":[{"turnNumber":1,'],
    ['no turns array', JSON.stringify({ sessionId: 's1', session: {} })],
    ['no session id', JSON.stringify({ turns: [] })],
    ['a session block that is not an object', JSON.stringify({ sessionId: 's1', session: 'x', turns: [] })],
    ['a primary model that is not text', JSON.stringify({ sessionId: 's1', session: { primaryModelId: 4 }, turns: [] })],
  ];
  for (const [name, text] of badFiles) {
    test(`a file with ${name} is not guessed at: unread, and retried next scan`, () => {
      const home = tmpDir();
      const file = writeSession(home, 's1', text);
      writeSession(home, 's2', usageDoc('s2', [turn(1, T0)]));
      const { events, scanner } = scan(home);
      assert.equal(events.length, 1);
      assert.ok(scanner.unreadRange(), 'a known gap');
      fs.writeFileSync(file, JSON.stringify(usageDoc('s1', [turn(5, T0 + 50)])));
      assert.equal(scanner.scan({ now: NOW, startMs: WEEK_START, home }).length, 2, 'the rewritten file is read');
      assert.equal(scanner.unreadRange(), null);
    });
  }

  test('a model id that is not id-shaped is counted as unknown', () => {
    const home = tmpDir();
    writeSession(home, 's1', usageDoc('s1', [turn(1, T0, { modelUsage: { 'grok <4.6>': { inputTokens: 10, outputTokens: 1 } } })]));
    assert.equal(scan(home).events[0].model, 'unknown');
  });

  test('a turn with nothing in it is not usage', () => {
    const home = tmpDir();
    writeSession(home, 's1', usageDoc('s1', [turn(1, T0, { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cacheCreationTokens: 0, usd: 0 })]));
    const { events, scanner } = scan(home);
    assert.deepEqual(events, []);
    assert.equal(scanner.unreadRange(), null);
  });
});

test.describe('the Grok Build reader opens usage.json and nothing else', () => {
  test('chat history, updates, prompt history, plan and summary are never opened or stat-ed, and the home is never listed', (t) => {
    const home = tmpDir();
    writeSession(home, 's1', usageDoc('s1', [turn(1, T0)]));
    const dir = path.join(home, 'sessions', CWD, 's1');
    for (const name of ['chat_history.jsonl', 'updates.jsonl', 'prompt_history.jsonl', 'plan.json', 'summary.json']) {
      fs.writeFileSync(path.join(dir, name), '{"secret":"fixture"}\n');
    }
    fs.writeFileSync(path.join(home, 'auth.json'), '{"token":"fixture-not-a-secret"}');
    const seen = [];
    for (const name of ['openSync', 'readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'readlinkSync']) {
      const orig = fs[name];
      fs[name] = function spied(...args) { seen.push(`${name}:${String(args[0])}`); return orig.apply(this, args); };
      t.after(() => { fs[name] = orig; });
    }
    assert.equal(scan(home).events.length, 1);
    assert.ok(seen.some((c) => c.startsWith('readFileSync:') && c.endsWith('usage.json')), 'the spy observes the real read');
    assert.deepEqual(seen.filter((c) => /chat_history|updates\.jsonl|prompt_history|plan\.json|summary\.json|auth\.json/.test(c)), []);
    assert.deepEqual(seen.filter((c) => c.startsWith('readdirSync:') && path.resolve(c.slice('readdirSync:'.length)) === path.resolve(home)), []);
    assert.deepEqual(seen.filter((c) => c.startsWith('readdirSync:') && path.resolve(c.slice('readdirSync:'.length)) === path.resolve(dir)), [],
      'the session directory itself is never listed');
  });

  test('a usage.json that is a symbolic link is skipped', (t) => {
    const outside = tmpDir();
    const target = path.join(outside, 'usage.json');
    fs.writeFileSync(target, JSON.stringify(usageDoc('x', [turn(1, T0)])));
    const home = tmpDir();
    const link = path.join(home, 'sessions', CWD, 's1', 'usage.json');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    try {
      fs.symlinkSync(target, link, 'file');
    } catch (err) {
      t.skip(`file symlink not permitted here: ${err.code}`);
      return;
    }
    assert.deepEqual(scan(home).events, []);
  });

  test('a junction inside sessions/ is never followed', (t) => {
    const home = tmpDir();
    const elsewhere = tmpDir();
    writeSession(elsewhere, 'far', usageDoc('far', [turn(1, T0, { inputTokens: 77777 })]));
    writeSession(home, 's1', usageDoc('s1', [turn(1, T0)]));
    try {
      fs.symlinkSync(path.join(elsewhere, 'sessions', CWD), path.join(home, 'sessions', 'linked'), 'junction');
    } catch (err) {
      t.skip(`cannot create a junction here: ${err.code}`);
      return;
    }
    assert.equal(scan(home).events.length, 1);
  });

  test('GROK_HOME is honoured when non-empty, else ~/.grok; a network home is not found and never logged', (t) => {
    const prev = process.env.GROK_HOME;
    t.after(() => { if (prev === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = prev; });
    process.env.GROK_HOME = '';
    assert.equal(grokHome(), path.join(os.homedir(), '.grok'));
    process.env.GROK_HOME = path.join(os.tmpdir(), 'grok-home-x');
    assert.equal(grokHome(), path.join(os.tmpdir(), 'grok-home-x'));
    const log = require('../src/core/log');
    const lines = [];
    log.setSink((level, msg) => { lines.push(String(msg)); });
    t.after(() => log.setSink(null));
    grok._resetForTests();
    process.env.GROK_HOME = String.raw`\\fileserver\share\.grok`;
    assert.equal(grokHome(), null);
    assert.deepEqual(grokUsageEvents({ now: NOW, startMs: WEEK_START }), []);
    assert.equal(lines.some((l) => l.includes('fileserver')), false);
  });

  test('installed with no session yet reads as nothing, not as a gap', () => {
    const home = tmpDir();
    fs.mkdirSync(path.join(home, 'sessions', CWD, 's-new'), { recursive: true });
    const { events, scanner } = scan(home);
    assert.deepEqual(events, []);
    assert.equal(scanner.unreadRange(), null);
  });
});

test.describe('the cached Grok Build scanner', () => {
  test('unchanged files are not re-read, a rewrite is re-read whole, and old turns fold without changing a figure', () => {
    const home = tmpDir();
    const old = NOW - 40 * DAY;
    const start = NOW - 60 * DAY;
    const file = writeSession(home, 's1', usageDoc('s1', [
      turn(1, old, { usd: 0.01 }),
      turn(2, old + 60000, { usd: 0.02 }),
      turn(3, old + 120000, { usd: 0.04, costIsPartial: true }),
      turn(4, T0, { usd: 0.08 }),
    ]));
    const scanner = createGrokUsageScanner();
    const folded = scanner.scan({ now: NOW, startMs: start, home });
    scanner.scan({ now: NOW, startMs: start, home });
    assert.equal(scanner.stats().bytesRead, 0);
    const raw = grokUsageEvents({ now: NOW, startMs: start, home, rawSinceMs: 0 });
    assert.equal(raw.length, 4);
    assert.equal(folded.length, 3, 'the two plain old turns share a bucket; the partial one keeps its own');
    assert.deepEqual(grokCost(folded, start, NOW, false), grokCost(raw, start, NOW, false));

    fs.writeFileSync(file, JSON.stringify(usageDoc('s1', [turn(1, old, { usd: 0.01 }), turn(2, old + 60000, { usd: 0.02 }), turn(3, old + 120000, { usd: 0.04, costIsPartial: true }), turn(4, T0, { usd: 0.08 }), turn(5, T0 + 1000, { usd: 0.16 })])));
    const again = scanner.scan({ now: NOW, startMs: start, home });
    assert.equal(scanner.stats().parsed, 1);
    assert.equal(grokCost(again, start, NOW, false).totalUsd, 0.31, 'rewritten, not appended: no turn counted twice');
  });
});
