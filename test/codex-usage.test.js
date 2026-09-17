'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { codexUsageEvents, sumCodexTokens } = require('../src/core/codex/usage');
const { codexCost, codexCostDetail, priceFor } = require('../src/core/codex/pricing');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-14T12:00:00.000Z');

function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-'));
  test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

/** A `thread_settings_applied` record, the shape Codex writes, stating a tier. */
function settingsLine(tier, model = 'gpt-5.6-sol') {
  return JSON.stringify({
    type: 'event_msg',
    payload: { type: 'thread_settings_applied', thread_id: 't', thread_settings: { model, service_tier: tier } },
  });
}

/** A rollout whose first line is session_meta (carrying the model) followed by
 *  token_count events with the given per-turn usage deltas. */
function writeRollout(home, { day = '2026/09/14', name = 'rollout-a.jsonl', model = 'gpt-5.6-sol', tier = 'default', turns }) {
  const dir = path.join(home, 'sessions', ...day.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const lines = [JSON.stringify({ type: 'session_meta', payload: { model, model_provider: 'openai' } })];
  // The tier is part of the price key (ADR-002 A3 rule 1). `null` writes no
  // settings record at all: the tier is then undeterminable.
  if (tier !== null) lines.push(settingsLine(tier));
  // Codex records the CUMULATIVE `total_token_usage` (monotonic) alongside the
  // per-turn `last_token_usage`; the reader derives deltas from the cumulative.
  const cum = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
  for (const t of turns) {
    for (const k of Object.keys(cum)) cum[k] += t.usage[k] || 0;
    lines.push(JSON.stringify({
      timestamp: new Date(t.ts).toISOString(),
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { ...cum }, last_token_usage: t.usage } },
    }));
  }
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

/** input_tokens INCLUDES cached and write; reasoning is a subset of output. */
function usage({ input, cached = 0, write = 0, output = 0, reasoning = 0 }) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: write,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

test.describe('codex usage extraction', () => {
  test('splits input into uncached/cached/write, and does NOT add reasoning to output', () => {
    const home = tmpHome();
    writeRollout(home, { turns: [
      { ts: NOW - HOUR, usage: usage({ input: 1000, cached: 600, write: 100, output: 50, reasoning: 20 }) },
    ] });
    const evs = codexUsageEvents({ now: NOW, startMs: NOW - DAY, home });
    assert.equal(evs.length, 1);
    const e = evs[0];
    assert.equal(e.inputUncached, 300, 'input - cached - write');
    assert.equal(e.cachedInput, 600);
    assert.equal(e.cacheWrite, 100);
    assert.equal(e.output, 50, 'reasoning (20) is a subset of output, never added');
    assert.equal(e.model, 'gpt-5.6-sol');
  });

  test('keeps only the turns whose timestamp is in the window', () => {
    const home = tmpHome();
    writeRollout(home, { turns: [
      { ts: NOW - 10 * DAY, usage: usage({ input: 999 }) }, // before the week
      { ts: NOW - 2 * HOUR, usage: usage({ input: 100, output: 10 }) }, // in
      { ts: NOW + HOUR, usage: usage({ input: 5 }) }, // after now
    ] });
    const evs = codexUsageEvents({ now: NOW, startMs: NOW - 7 * DAY, home });
    // The 10-days-ago turn is filtered by ts even though the file is scanned.
    assert.equal(evs.length, 1);
    assert.equal(evs[0].inputUncached, 100);
  });

  test('sumCodexTokens totals a window, and billable excludes cacheRead', () => {
    const home = tmpHome();
    writeRollout(home, { turns: [
      { ts: NOW - 3 * HOUR, usage: usage({ input: 1000, cached: 400, output: 100 }) },
      { ts: NOW - HOUR, usage: usage({ input: 500, cached: 500, output: 50 }) },
    ] });
    const evs = codexUsageEvents({ now: NOW, startMs: NOW - 7 * DAY, home });
    const { tokens } = sumCodexTokens(evs, NOW - 5 * HOUR, NOW);
    assert.equal(tokens.input, 600 + 0, 'uncached: (1000-400) + (500-500)');
    assert.equal(tokens.cacheRead, 400 + 500);
    assert.equal(tokens.output, 150);
    assert.equal(tokens.cacheWrite, 0);
    assert.equal(tokens.billable, 600 + 150 + 0, 'input + output + cacheWrite, cacheRead excluded');
  });
});

test.describe('codex cost (OpenAI published prices)', () => {
  test('prices gpt-5.6-sol by class: input $4, cached $0.40, output $20 per 1M', () => {
    const home = tmpHome();
    // 1M uncached input, 1M cached, 1M output -> $4 + $0.40 + $20 = $24.40.
    // Spread over 10 turns of 200K prompt each: one 2M-token prompt would now be
    // a long-context event, which is unpriced (ADR-002 A3 rule 4).
    const turns = [];
    for (let i = 0; i < 10; i += 1) {
      turns.push({ ts: NOW - HOUR + i, usage: usage({ input: 200_000, cached: 100_000, output: 100_000 }) });
    }
    writeRollout(home, { model: 'gpt-5.6-sol', turns });
    const evs = codexUsageEvents({ now: NOW, startMs: NOW - DAY, home });
    const cost = codexCost(evs, NOW - DAY, NOW, false);
    assert.equal(cost.byClass.input, 4, '1M uncached x $4');
    assert.equal(cost.byClass.cacheRead, 0.4, '1M cached x $0.40');
    assert.equal(cost.byClass.output, 20, '1M output x $20');
    assert.equal(cost.totalUsd, 24.4);
    assert.equal(cost.pricesAsOf, '2026-09-14');
    assert.equal(cost.byModel[0].model, 'gpt-5.6-sol');
    assert.equal(cost.byModel[0].usd, 24.4);
    assert.deepEqual(cost.unpricedModels, []);
    assert.equal(cost.fallbackWriteEvents, 0, 'the Claude TTL fallback is never taken by Codex');
    // ...but cached reads with 0 RECORDED writes on a model that charges for
    // writes make the figure a floor (A3 rule 3), carried beside the cost.
    assert.equal(codexCostDetail(evs, NOW - DAY, NOW, false).writeFloorEvents, 10);
  });

  test('gpt-5.6 charges cache WRITES at 1.25x input; the tier lands in cacheWrite5m', () => {
    const home = tmpHome();
    const turns = [];
    for (let i = 0; i < 5; i += 1) {
      turns.push({ ts: NOW - HOUR + i, usage: usage({ input: 200_000, write: 200_000 }) }); // all write
    }
    writeRollout(home, { model: 'gpt-5.6-sol', turns });
    const cost = codexCost(codexUsageEvents({ now: NOW, startMs: NOW - DAY, home }), NOW - DAY, NOW, false);
    assert.equal(cost.byClass.cacheWrite5m, 5, '1M write x $5.00 (1.25 x $4)');
    assert.equal(cost.byClass.cacheWrite1h, 0);
    assert.equal(cost.byClass.input, 0, 'the write tokens are not also billed as input');
  });

  test('a pre-5.6 model has no write charge — writes bill at the input rate', () => {
    const home = tmpHome();
    writeRollout(home, { model: 'gpt-5', turns: [
      { ts: NOW - HOUR, usage: usage({ input: 1_000_000, write: 1_000_000 }) },
    ] });
    const cost = codexCost(codexUsageEvents({ now: NOW, startMs: NOW - DAY, home }), NOW - DAY, NOW, false);
    assert.equal(cost.byClass.cacheWrite5m, 1.25, '1M write x $1.25 (gpt-5 input rate)');
  });

  test('an unknown model accrues tokens but never dollars', () => {
    const home = tmpHome();
    writeRollout(home, { model: 'gpt-9-imaginary', turns: [
      { ts: NOW - HOUR, usage: usage({ input: 1_000_000, output: 1_000_000 }) },
    ] });
    const cost = codexCost(codexUsageEvents({ now: NOW, startMs: NOW - DAY, home }), NOW - DAY, NOW, false);
    assert.equal(cost.totalUsd, 0, 'no invented price');
    assert.deepEqual(cost.unpricedModels, ['gpt-9-imaginary']);
    assert.equal(cost.byModel[0].usd, null);
    assert.ok(cost.byModel[0].tokens.billable > 0, 'the tokens are still counted, so the usage is visible');
  });

  test('priceFor resolves an exact id at a tier, and nothing else', () => {
    assert.equal(priceFor('gpt-5.6-sol', 'standard').input, 4.00);
    assert.equal(priceFor('gpt-5.6-sol', 'fast').input, 8.00);
    assert.equal(priceFor('gpt-5.6-sol'), null, 'no tier, no price');
    assert.equal(priceFor('nope', 'standard'), null);
  });
});

/* ------------------------------------------------ real-shape records, cached scan */

const { createCodexUsageScanner } = require('../src/core/codex/usage');

/** Raw rollout lines in the shape current Codex writes: session_meta with NO
 *  top-level model, a turn_context carrying the model, then token_counts. */
function metaLine(extra = {}) {
  return JSON.stringify({ type: 'session_meta', payload: { id: 's', model_provider: 'openai', ...extra } });
}
function turnLine(model) {
  return JSON.stringify({ type: 'turn_context', payload: { turn_id: 't', model } });
}
function countLine(ts, cum, last = cum) {
  return JSON.stringify({
    timestamp: new Date(ts).toISOString(),
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: cum, last_token_usage: last } },
  });
}
function cumOf(input, output, cached = 0) {
  return { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output };
}
function rolloutPath(home, name = 'rollout-b.jsonl', day = '2026/09/14') {
  const dir = path.join(home, 'sessions', ...day.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

test.describe('codex usage on the record shapes Codex actually writes', () => {
  test('the model comes from turn_context, per turn, so a mid-session switch prices each turn at its own model', () => {
    const home = tmpHome();
    fs.writeFileSync(rolloutPath(home), [
      metaLine(),
      turnLine('gpt-5.6-sol'),
      countLine(NOW - 2 * HOUR, cumOf(100, 10)),
      turnLine('gpt-5.5'),
      countLine(NOW - HOUR, cumOf(300, 30)),
    ].join('\n') + '\n');
    const evs = codexUsageEvents({ now: NOW, startMs: NOW - DAY, home });
    assert.deepEqual(evs.map((e) => [e.model, e.inputUncached, e.output]), [
      ['gpt-5.6-sol', 100, 10],
      ['gpt-5.5', 200, 20],
    ]);
  });

  test('with no turn_context yet, the session header is the fallback; with neither, "unknown" (unpriced, not $0)', () => {
    const home = tmpHome();
    fs.writeFileSync(rolloutPath(home, 'rollout-meta.jsonl'), [
      metaLine({ base_instructions: { provenance: { model: 'gpt-5.6-sol' } } }),
      settingsLine('default'),
      countLine(NOW - HOUR, cumOf(100, 10)),
    ].join('\n') + '\n');
    fs.writeFileSync(rolloutPath(home, 'rollout-none.jsonl'), [
      metaLine(),
      settingsLine('default'),
      countLine(NOW - HOUR, cumOf(50, 5)),
    ].join('\n') + '\n');
    const evs = codexUsageEvents({ now: NOW, startMs: NOW - DAY, home });
    assert.deepEqual(evs.map((e) => e.model).sort(), ['gpt-5.6-sol', 'unknown']);
    const cost = codexCost(evs, NOW - DAY, NOW, false);
    assert.deepEqual(cost.unpricedModels, ['unknown']);
  });

  test('a re-emitted token_count with an unchanged total adds nothing (no double charge)', () => {
    const home = tmpHome();
    const c = cumOf(1000, 100);
    fs.writeFileSync(rolloutPath(home), [
      metaLine(), turnLine('gpt-5.6-sol'),
      countLine(NOW - 2 * HOUR, c),
      countLine(NOW - HOUR, c, cumOf(1000, 100)), // same total, last repeated
    ].join('\n') + '\n');
    const { tokens } = sumCodexTokens(codexUsageEvents({ now: NOW, startMs: NOW - DAY, home }), NOW - DAY, NOW);
    assert.equal(tokens.input, 1000);
    assert.equal(tokens.output, 100);
  });

  test('a line that merely MENTIONS a marker is never mistaken for a record', () => {
    const home = tmpHome();
    fs.writeFileSync(rolloutPath(home), [
      metaLine(), turnLine('gpt-5.6-sol'),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', content: 'token_count turn_context "model":"gpt-9"' } }),
      countLine(NOW - HOUR, cumOf(10, 1)),
      '{ not json token_count',
    ].join('\n') + '\n');
    const evs = codexUsageEvents({ now: NOW, startMs: NOW - DAY, home });
    assert.deepEqual(evs.map((e) => [e.model, e.inputUncached]), [['gpt-5.6-sol', 10]]);
  });
});

test.describe('the cached scanner', () => {
  test('an unchanged rollout is not read again', () => {
    const home = tmpHome();
    fs.writeFileSync(rolloutPath(home), [metaLine(), turnLine('gpt-5.6-sol'), countLine(NOW - HOUR, cumOf(10, 1))].join('\n') + '\n');
    const scanner = createCodexUsageScanner();
    assert.equal(scanner.scan({ now: NOW, startMs: NOW - DAY, home }).length, 1);
    assert.equal(scanner.stats().parsed, 1);
    assert.equal(scanner.scan({ now: NOW, startMs: NOW - DAY, home }).length, 1);
    assert.equal(scanner.stats().bytesRead, 0, 'warm scan reads no bytes');
    assert.equal(scanner.stats().files, 1);
  });

  test('an appended rollout is read from where the last scan stopped, keeping the running total', () => {
    const home = tmpHome();
    const file = rolloutPath(home);
    const head = [metaLine(), turnLine('gpt-5.6-sol'), countLine(NOW - 2 * HOUR, cumOf(100, 10))].join('\n') + '\n';
    fs.writeFileSync(file, head);
    const scanner = createCodexUsageScanner();
    scanner.scan({ now: NOW, startMs: NOW - DAY, home });

    const more = countLine(NOW - HOUR, cumOf(250, 25)) + '\n';
    fs.appendFileSync(file, more);
    const evs = scanner.scan({ now: NOW, startMs: NOW - DAY, home });
    assert.equal(scanner.stats().appended, 1);
    assert.equal(scanner.stats().bytesRead, Buffer.byteLength(more), 'only the appended bytes were read');
    assert.deepEqual(evs.map((e) => e.inputUncached), [100, 150], 'delta against the cached cumulative total');
    assert.deepEqual(evs.map((e) => e.model), ['gpt-5.6-sol', 'gpt-5.6-sol'], 'the turn model carried across reads');
  });

  test('a half-written last line is left for the next scan, not dropped or double counted', () => {
    const home = tmpHome();
    const file = rolloutPath(home);
    const line = countLine(NOW - HOUR, cumOf(40, 4));
    fs.writeFileSync(file, [metaLine(), turnLine('gpt-5.6-sol')].join('\n') + '\n' + line.slice(0, 20));
    const scanner = createCodexUsageScanner();
    assert.equal(scanner.scan({ now: NOW, startMs: NOW - DAY, home }).length, 0);
    fs.appendFileSync(file, line.slice(20) + '\n');
    const evs = scanner.scan({ now: NOW, startMs: NOW - DAY, home });
    assert.deepEqual(evs.map((e) => e.inputUncached), [40]);
    assert.equal(scanner.scan({ now: NOW, startMs: NOW - DAY, home }).length, 1);
  });

  test('a rewritten (shrunk) rollout is re-read from the start', () => {
    const home = tmpHome();
    const file = rolloutPath(home);
    fs.writeFileSync(file, [metaLine(), turnLine('gpt-5.6-sol'), countLine(NOW - 2 * HOUR, cumOf(100, 10)), countLine(NOW - HOUR, cumOf(900, 90))].join('\n') + '\n');
    const scanner = createCodexUsageScanner();
    scanner.scan({ now: NOW, startMs: NOW - DAY, home });
    fs.writeFileSync(file, [metaLine(), turnLine('gpt-5'), countLine(NOW - HOUR, cumOf(7, 1))].join('\n') + '\n');
    const evs = scanner.scan({ now: NOW, startMs: NOW - DAY, home });
    assert.equal(scanner.stats().parsed, 1);
    assert.deepEqual(evs.map((e) => [e.model, e.inputUncached]), [['gpt-5', 7]]);
  });

  test('a deleted rollout leaves the cache and the results', () => {
    const home = tmpHome();
    const file = rolloutPath(home);
    fs.writeFileSync(file, [metaLine(), turnLine('gpt-5.6-sol'), countLine(NOW - HOUR, cumOf(10, 1))].join('\n') + '\n');
    const scanner = createCodexUsageScanner();
    assert.equal(scanner.scan({ now: NOW, startMs: NOW - DAY, home }).length, 1);
    fs.rmSync(file);
    assert.equal(scanner.scan({ now: NOW, startMs: NOW - DAY, home }).length, 0);
  });

  test('day-folders older than the range (less the slack) are not read at all', () => {
    const home = tmpHome();
    // 60 days before NOW's folder: far outside a one-day range plus 14 days slack.
    fs.writeFileSync(rolloutPath(home, 'rollout-old.jsonl', '2026/07/16'), [metaLine(), turnLine('gpt-5.6-sol'), countLine(NOW - HOUR, cumOf(10, 1))].join('\n') + '\n');
    const scanner = createCodexUsageScanner();
    assert.equal(scanner.scan({ now: NOW, startMs: NOW - DAY, home }).length, 0);
    assert.equal(scanner.stats().files, 0);
    // A long enough range reaches it.
    assert.equal(scanner.scan({ now: NOW, startMs: NOW - 90 * DAY, home }).length, 1);
  });

  test('nothing read from a rollout is ever logged', () => {
    const log = require('../src/core/log');
    const lines = [];
    log.setSink((level, msg) => { lines.push(msg); });
    try {
      const home = tmpHome();
      fs.writeFileSync(rolloutPath(home), [
        metaLine(), turnLine('gpt-5.6-sol'),
        JSON.stringify({ type: 'response_item', payload: { type: 'message', content: 'SECRET-PROMPT token_count' } }),
        '{"broken": token_count SECRET-PROMPT',
        countLine(NOW - HOUR, cumOf(10, 1)),
      ].join('\n') + '\n');
      createCodexUsageScanner().scan({ now: NOW, startMs: NOW - DAY, home });
    } finally {
      log.setSink(null);
    }
    assert.equal(lines.some((l) => String(l).includes('SECRET-PROMPT')), false);
  });

  test('a missing sessions directory is an empty result, not a throw', () => {
    const home = tmpHome();
    assert.deepEqual(createCodexUsageScanner().scan({ now: NOW, startMs: NOW - DAY, home }), []);
  });
});

/* ------------------------------------------ ADR-002 Amendment 3: the accounting */

test.describe('Codex accounting rules (ADR-002 Amendment 3)', () => {
  const history = require('../src/core/history');
  // Every turn is placed relative to a LOCAL week start, so the history
  // assertions find the same period in every time zone (review F8).
  const T = history.weekStartMs(NOW - 2 * DAY) + 12 * HOUR;
  const SINCE = NOW - 10 * DAY;
  const weekOf = (weeks) => weeks.find((w) => w.startsAt === new Date(history.weekStartMs(T)).toISOString());

  function lines(home, rows, name = 'rollout-a3.jsonl') {
    fs.writeFileSync(rolloutPath(home, name), rows.join('\n') + '\n');
    return codexUsageEvents({ now: NOW, startMs: SINCE, home, rawSinceMs: 0 });
  }
  const r6 = (x) => Math.round(x * 1e6) / 1e6;

  test('a priority -> default change prices each turn at its own tier (priority is the Fast row)', () => {
    const home = tmpHome();
    const evs = lines(home, [
      metaLine(), turnLine('gpt-5.6-sol'),
      settingsLine('priority'),
      countLine(T + HOUR, cumOf(100000, 10000)),
      settingsLine('default'),
      countLine(T + 2 * HOUR, cumOf(200000, 20000)),
    ]);
    assert.deepEqual(evs.map((e) => e.tier), ['fast', 'standard']);
    const cost = codexCost(evs, SINCE, NOW, false);
    const fast = cost.byModel.find((m) => m.speed === 'fast');
    const std = cost.byModel.find((m) => m.speed === 'standard');
    assert.equal(fast.usd, r6(0.1 * 8 + 0.01 * 40), '100K in x $8 + 10K out x $40 (Fast)');
    assert.equal(std.usd, r6(0.1 * 4 + 0.01 * 20), '100K in x $4 + 10K out x $20 (Standard)');
    assert.equal(cost.totalUsd, r6(fast.usd + std.usd));
    assert.deepEqual(cost.unpricedModels, []);
  });

  test('a tier that cannot be determined is unpriced, never assumed Standard', () => {
    const home = tmpHome();
    const evs = lines(home, [
      metaLine(), turnLine('gpt-5.6-sol'),
      countLine(T, cumOf(1000, 100)), // before any settings record
      JSON.stringify({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { service_tier: null } } }),
      countLine(T + HOUR, cumOf(2000, 200)), // tier stated as non-string
    ]);
    assert.deepEqual(evs.map((e) => e.tier), [null, null]);
    const cost = codexCost(evs, SINCE, NOW, false);
    assert.equal(cost.totalUsd, 0);
    assert.deepEqual(cost.byModel.map((m) => [m.speed, m.usd]), [['unknown-tier', null]]);
    assert.deepEqual(cost.unpricedModels, ['gpt-5.6-sol']);
    // And in the history: null, never $0, and the period is a floor.
    const { weeks } = history.usageHistory([], NOW, { codexEvents: evs });
    const entry = weekOf(weeks).byModel.find((e) => e.model === 'gpt-5.6-sol');
    assert.equal(entry.costUsd, null);
    assert.equal(weekOf(weeks).isFloor, true);
  });

  test('a tier with no published row (flex) is unpriced', () => {
    const home = tmpHome();
    const evs = lines(home, [metaLine(), turnLine('gpt-5.6-sol'), settingsLine('flex'), countLine(T + 2 * HOUR, cumOf(1000, 100))]);
    assert.equal(codexCost(evs, SINCE, NOW, false).byModel[0].usd, null);
  });

  test('zero recorded writes with cached reads on GPT-5.6 is a floor; on a model without a write price it is not', () => {
    const home = tmpHome();
    const sol = lines(home, [
      metaLine(), turnLine('gpt-5.6-sol'), settingsLine('default'),
      countLine(T + 2 * HOUR, cumOf(100000, 1000, 90000)),
    ], 'rollout-sol.jsonl');
    const detail = codexCostDetail(sol, SINCE, NOW, false);
    assert.equal(detail.writeFloorEvents, 1);
    assert.ok(detail.cost.totalUsd > 0, 'still priced: no write count is estimated');
    assert.equal(detail.cost.byClass.cacheWrite5m, 0, 'no invented write dollars');
    const { weeks } = history.usageHistory([], NOW, { codexEvents: sol });
    assert.equal(weekOf(weeks).isFloor, true, 'the period reads "en az"');
    assert.equal(weekOf(weeks).byModel[0].isFloor, true, 'and so does the model entry');

    const home2 = tmpHome();
    const gpt5 = lines(home2, [
      metaLine(), turnLine('gpt-5'), settingsLine('default'),
      countLine(T + 2 * HOUR, cumOf(100000, 1000, 90000)),
    ], 'rollout-gpt5.jsonl');
    assert.equal(codexCostDetail(gpt5, SINCE, NOW, false).writeFloorEvents, 0);
    assert.equal(history.usageHistory([], NOW, { codexEvents: gpt5 }).weeks.find((w) => w.hasUsage).isFloor, false);
  });

  test('recorded writes on a model without a write price bill at the input rate, not free', () => {
    const home = tmpHome();
    const evs = lines(home, [
      metaLine(), turnLine('gpt-5'), settingsLine('priority'),
      countLine(T + 2 * HOUR, { ...cumOf(100000, 0), cache_write_input_tokens: 100000 }),
    ]);
    assert.equal(codexCost(evs, SINCE, NOW, false).byClass.cacheWrite5m, r6(0.1 * 2.5), 'Fast gpt-5 input $2.50');
  });

  test('gpt-5-codex has no Fast row: unpriced at Fast, priced at Standard', () => {
    const home = tmpHome();
    const evs = lines(home, [
      metaLine(), turnLine('gpt-5-codex'),
      settingsLine('fast'), countLine(T + HOUR, cumOf(1000, 100)),
      settingsLine('default'), countLine(T + 2 * HOUR, cumOf(2000, 200)),
    ]);
    const cost = codexCost(evs, SINCE, NOW, false);
    assert.equal(cost.byModel.find((m) => m.speed === 'fast').usd, null);
    assert.ok(cost.byModel.find((m) => m.speed === 'standard').usd > 0);
    // History folds the tiers: priced part as the figure, and a floor.
    const entry = history.usageHistory([], NOW, { codexEvents: evs }).weeks.find((w) => w.hasUsage).byModel[0];
    assert.equal(entry.costUsd, cost.byModel.find((m) => m.speed === 'standard').usd);
    assert.equal(entry.isFloor, true);
  });

  test('a prompt over 272,000 tokens on a long-context model is unpriced; the same prompt on gpt-5 is priced', () => {
    const home = tmpHome();
    const sol = lines(home, [
      metaLine(), turnLine('gpt-5.6-sol'), settingsLine('default'),
      countLine(T + HOUR, cumOf(272000, 10)), // exactly the limit: priced
      countLine(T + 2 * HOUR, cumOf(272000 + 272001, 20)), // delta 272,001: unpriced
    ], 'rollout-long.jsonl');
    const cost = codexCost(sol, SINCE, NOW, false);
    assert.equal(cost.byModel.find((m) => m.speed === 'standard').usd > 0, true);
    assert.equal(cost.byModel.find((m) => m.speed === 'standard-long-context').usd, null);

    const home2 = tmpHome();
    const gpt5 = lines(home2, [metaLine(), turnLine('gpt-5'), settingsLine('default'), countLine(T + 2 * HOUR, cumOf(300000, 10))], 'rollout-g5.jsonl');
    assert.ok(codexCost(gpt5, SINCE, NOW, false).totalUsd > 0);
  });

  test('a dated model id is unpriced: no suffix stripping', () => {
    const home = tmpHome();
    const evs = lines(home, [metaLine(), turnLine('gpt-5.5-2026-04-23'), settingsLine('default'), countLine(T + 2 * HOUR, cumOf(1000, 100))]);
    const cost = codexCost(evs, SINCE, NOW, false);
    assert.deepEqual(cost.unpricedModels, ['gpt-5.5-2026-04-23']);
    assert.equal(priceFor('gpt-5-codex-20260901', 'standard'), null);
  });

  test('a mid-session model switch prices each turn at its own model and tier', () => {
    const home = tmpHome();
    const evs = lines(home, [
      metaLine(), settingsLine('priority'),
      turnLine('gpt-5.6-sol'), countLine(T + HOUR, cumOf(100000, 0)),
      turnLine('gpt-6-astra'), countLine(T + 2 * HOUR, cumOf(200000, 0)),
    ]);
    const cost = codexCost(evs, SINCE, NOW, false);
    assert.equal(cost.byModel.find((m) => m.model === 'gpt-5.6-sol').usd, r6(0.1 * 8));
    assert.equal(cost.byModel.find((m) => m.model === 'gpt-6-astra').usd, r6(0.1 * 20));
  });
});

/* ---------------------------------------- A3.10: trusting the cumulative total */

test.describe('the running total is trusted only while it is monotonic (ADR-002 A3.10)', () => {
  function counts(home, rows) {
    fs.writeFileSync(rolloutPath(home, 'rollout-mono.jsonl'), [metaLine(), turnLine('gpt-5.6-sol'), settingsLine('default'), ...rows].join('\n') + '\n');
    return codexUsageEvents({ now: NOW, startMs: NOW - DAY, home }).map((e) => [e.inputUncached, e.output]);
  }

  test('a total that DROPS is a reset: that record counts its own last usage', () => {
    const home = tmpHome();
    assert.deepEqual(counts(home, [
      countLine(NOW - 3 * HOUR, cumOf(1000, 100)),
      // Reset (compaction, restart): last (120) differs from the new total (300),
      // pinning that the LAST usage is what counts (review F9).
      countLine(NOW - 2 * HOUR, cumOf(300, 30), cumOf(120, 12)),
      countLine(NOW - HOUR, cumOf(500, 50), cumOf(200, 20)),
    ]), [[1000, 100], [120, 12], [200, 20]]);
  });

  test('a PARTIAL total between two full ones is skipped, and nothing is counted twice (review F6)', () => {
    const home = tmpHome();
    const partial = { input_tokens: 5000, output_tokens: 500 }; // no cached_input_tokens
    assert.deepEqual(counts(home, [
      countLine(NOW - 3 * HOUR, cumOf(1000, 100)),
      JSON.stringify({
        timestamp: new Date(NOW - 2 * HOUR).toISOString(),
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: partial, last_token_usage: partial } },
      }),
      countLine(NOW - HOUR, cumOf(1300, 130), cumOf(300, 30)),
    ]), [[1000, 100], [300, 30]], 'read as zeros, the partial would look like a reset and the next total would count 1,300 again');
  });

  test('only cache_write_input_tokens may be absent (it reads as 0)', () => {
    const home = tmpHome();
    const noWrite = (i, o) => { const u = cumOf(i, o); delete u.cache_write_input_tokens; return u; };
    assert.deepEqual(counts(home, [
      countLine(NOW - 2 * HOUR, noWrite(1000, 100)),
      countLine(NOW - HOUR, noWrite(1500, 150)),
    ]), [[1000, 100], [500, 50]]);
  });

  test('a FIRST record whose total exceeds its last usage counts the last usage (inherited total)', () => {
    const home = tmpHome();
    assert.deepEqual(counts(home, [
      countLine(NOW - 2 * HOUR, cumOf(900000, 9000), cumOf(1000, 100)), // resumed: 900K was spent elsewhere
      countLine(NOW - HOUR, cumOf(901500, 9150), cumOf(1500, 150)),
    ]), [[1000, 100], [1500, 150]]);
  });

  test('a record with a non-integer or unsafe count is skipped and does not move the running total', () => {
    const home = tmpHome();
    for (const bad of [1.5, -1, 1e300, '100', Number.MAX_SAFE_INTEGER + 2]) {
      assert.deepEqual(counts(home, [
        countLine(NOW - 3 * HOUR, cumOf(1000, 100)),
        countLine(NOW - 2 * HOUR, { ...cumOf(5000, 500), output_tokens: bad }),
        countLine(NOW - HOUR, cumOf(1200, 120)),
      ]), [[1000, 100], [200, 20]], JSON.stringify(bad));
    }
  });

  test('an invalid last usage beside a valid total skips the record too', () => {
    const home = tmpHome();
    assert.deepEqual(counts(home, [
      countLine(NOW - 3 * HOUR, cumOf(1000, 100)),
      countLine(NOW - 2 * HOUR, cumOf(2000, 200), { ...cumOf(1000, 100), input_tokens: 0.5 }),
      countLine(NOW - HOUR, cumOf(2500, 250)),
    ]), [[1000, 100], [1500, 150]]);
  });
});

/* ------------------------------------------- A3.9: the broadened write floor */

test('a first turn with no cache read but a cacheable prompt on GPT-5.6 is a write floor (A3.9)', () => {
  const home = tmpHome();
  const at = (i) => NOW - HOUR + i;
  const evs = [];
  fs.writeFileSync(rolloutPath(home, 'rollout-first.jsonl'), [
    metaLine(), turnLine('gpt-5.6-sol'), settingsLine('default'),
    countLine(at(0), cumOf(1024, 10)), // uncached 1,024: cacheable -> floor
  ].join('\n') + '\n');
  fs.writeFileSync(rolloutPath(home, 'rollout-small.jsonl'), [
    metaLine(), turnLine('gpt-5.6-sol'), settingsLine('default'),
    countLine(at(1), cumOf(1023, 10)), // below the cacheable minimum -> not a floor
  ].join('\n') + '\n');
  evs.push(...codexUsageEvents({ now: NOW, startMs: NOW - DAY, home }));
  const floorOf = (i) => codexCostDetail(evs.filter((e) => e.ts === at(i)), NOW - DAY, NOW, false).writeFloorEvents;
  assert.equal(floorOf(0), 1);
  assert.equal(floorOf(1), 0);
  assert.equal(codexCost(evs, NOW - DAY, NOW, false).unrecordedWriteEvents, 1);
});

/* ----------------------------------- old turns are folded, prices are not changed */

test('turns older than the raw window fold into UTC 15-minute buckets without changing any figure', () => {
  const home = tmpHome();
  const WEEK = history_weekStart();
  const rows = [metaLine(), turnLine('gpt-5.6-sol'), settingsLine('priority')];
  // Within one local day, three kinds of turn, spread over several 15-minute
  // slots (review F9):
  //   kind 0: cached > 0, writes 0              -> write floor
  //   kind 1: cached 0, uncached 500 (< 1,024)  -> NOT a floor
  //   kind 2: recorded writes > 0               -> a cacheWriteEvent, not a floor
  const cum = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
  for (let i = 0; i < 12; i += 1) {
    const kind = i % 3;
    const turn = kind === 0 ? { in: 6000, cached: 5000, write: 0 }
      : kind === 1 ? { in: 500, cached: 0, write: 0 }
        : { in: 4000, cached: 0, write: 3000 };
    cum.input_tokens += turn.in;
    cum.cached_input_tokens += turn.cached;
    cum.cache_write_input_tokens += turn.write;
    cum.output_tokens += 100;
    rows.push(countLine(WEEK + 10 * HOUR + i * 2 * 60000, { ...cum })); // 24 minutes: two or more slots
  }
  fs.writeFileSync(rolloutPath(home, 'rollout-fold.jsonl'), rows.join('\n') + '\n');
  const start = WEEK - 7 * DAY;
  const raw = codexUsageEvents({ now: NOW, startMs: start, home, rawSinceMs: 0 });
  const folded = codexUsageEvents({ now: NOW, startMs: start, home, rawSinceMs: NOW });
  assert.equal(raw.length, 12);
  assert.ok(folded.length < raw.length, 'folded into buckets');
  assert.ok(new Set(folded.map((b) => b.ts)).size > 1, 'across more than one 15-minute slot');
  for (const b of folded) {
    assert.equal(b.ts % (15 * 60 * 1000), 0, 'a bucket starts on a UTC 15-minute boundary');
    assert.ok(Number.isSafeInteger(b.count));
  }
  const a = codexCostDetail(raw, start, NOW, false);
  const b = codexCostDetail(folded, start, NOW, false);
  assert.equal(a.writeFloorEvents, 4, 'only the cached turns are floors');
  assert.equal(a.cost.cacheWriteEvents, 4);
  assert.deepEqual(b.cost.byClass, a.cost.byClass);
  assert.equal(b.cost.totalUsd, a.cost.totalUsd);
  assert.equal(b.writeFloorEvents, a.writeFloorEvents);
  assert.equal(b.cost.cacheWriteEvents, a.cost.cacheWriteEvents);
});

test('a raw cutoff that moves BACKWARDS (clock jumped forward, then back) drops the cache and re-reads (review F5)', () => {
  const home = tmpHome();
  const at = NOW - 2 * HOUR;
  fs.writeFileSync(rolloutPath(home, 'rollout-clock.jsonl'), [
    metaLine(), turnLine('gpt-5.6-sol'), settingsLine('default'), countLine(at, cumOf(1000, 100)),
  ].join('\n') + '\n');
  const scanner = createCodexUsageScanner();
  // A clock a month ahead folds the turn into a bucket.
  const ahead = NOW + 30 * DAY;
  scanner.scan({ now: ahead, startMs: NOW - DAY, home });
  assert.equal(scanner.stats().cacheReset, false);
  // Back to the real time: the turn must be RAW again, or the five-hour window misses it.
  const evs = scanner.scan({ now: NOW, startMs: NOW - DAY, home });
  assert.equal(scanner.stats().cacheReset, true);
  assert.equal(scanner.stats().mode, 'full');
  assert.ok(scanner.stats().bytesRead > 0, 're-read from disk');
  assert.deepEqual(evs.map((e) => [e.ts, e.inputUncached, e.count]), [[at, 1000, undefined]]);
  // A cutoff that only moves forward keeps the cache.
  scanner.scan({ now: NOW + HOUR, startMs: NOW - DAY, home });
  assert.equal(scanner.stats().cacheReset, false);
  assert.equal(scanner.stats().bytesRead, 0);
});

function history_weekStart() {
  return require('../src/core/history').weekStartMs(NOW - 2 * DAY);
}

/* --------------------------------------------- the collector's Codex scan worker */

test.describe('the collector runs the Codex scan in a worker (ADR-002 A3.11)', () => {
  const { Collector, CODEX_MIN_GAP_MS } = require('../src/core/collector');
  const historyMod = require('../src/core/history');

  function collector(dir) {
    return new Collector({
      userDataDir: dir,
      projectsRoot: path.join(dir, 'projects'),
      rateLimitsFile: path.join(dir, 'claude-rate-limits.json'),
      rateLimitsDir: dir,
      antigravityQuotaFile: path.join(dir, 'antigravity-quota.json'),
      ideAppDataDir: path.join(dir, 'ide'),
      codexHome: path.join(dir, 'codex'),
    });
  }

  test('a request inside the gap schedules exactly one follow-up dispatch', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const c = collector(tmpHome());
    t.after(() => c.stop());
    let dispatched = 0;
    c._dispatchCodexScan = () => { dispatched += 1; };
    c._codexFullAt = 1; // a full scan has completed
    c._codexDispatchedAt = Date.now();
    const rel = path.join('2026', '09', '14', 'rollout-a.jsonl');
    c._requestCodexScan({ changed: [rel] }, c._codexDispatchedAt + 500);
    c._requestCodexScan({ changed: [rel] }, c._codexDispatchedAt + 900);
    assert.notEqual(c._codexFollowUp, null, 'the follow-up is scheduled');
    assert.equal(dispatched, 0);
    t.mock.timers.tick(CODEX_MIN_GAP_MS - 501);
    assert.equal(dispatched, 0, 'not before the gap has passed');
    t.mock.timers.tick(1);
    assert.equal(dispatched, 1, 'one dispatch once the gap has passed');
    t.mock.timers.tick(60000);
    assert.equal(dispatched, 1, 'and only one');
  });

  test('stop() cancels a scheduled follow-up', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const c = collector(tmpHome());
    let dispatched = 0;
    c._dispatchCodexScan = () => { dispatched += 1; };
    c._codexFullAt = 1;
    c._codexDispatchedAt = Date.now();
    c._requestCodexScan({ full: true }, c._codexDispatchedAt + 500);
    assert.notEqual(c._codexFollowUp, null, 'scheduled before stop()');
    c.stop();
    assert.equal(c._codexFollowUp, null);
    t.mock.timers.tick(60000);
    assert.equal(dispatched, 0);
  });

  test('a clock that went backwards expires the gap and the full-scan TTL instead of freezing them', (t) => {
    const c = collector(tmpHome());
    t.after(() => c.stop());
    let dispatched = 0;
    c._dispatchCodexScan = () => { dispatched += 1; };
    c._codexFullAt = 1;
    c._codexEvents = [];
    c._codexDispatchedAt = 5_000_000;
    c._requestCodexScan({ full: true }, 1_000_000); // age < 0
    assert.equal(dispatched, 1);
    assert.equal(c._codexFollowUp, null);

    c._codexAuto = true;
    c._codexFullAt = 5_000_000;
    c._codexDispatchedAt = 0;
    const before = dispatched;
    c._codexTick(1_000_000); // full scan "from the future": expired
    assert.equal(dispatched, before + 1);
  });

  test('a tick while a FULL scan is in flight asks for nothing more (review F11)', (t) => {
    const c = collector(tmpHome());
    t.after(() => c.stop());
    let dispatched = 0;
    c._dispatchCodexScan = () => { dispatched += 1; };
    c._codexAuto = true;
    c._codexInFlight = { id: 1, now: 1_000_000, full: true, timer: null };
    c._codexTick(1_000_000);
    assert.equal(dispatched, 0);
    assert.equal(c._codexWant.full, false, 'nothing queued behind the running full scan');
  });

  test('start() dispatches the first Codex scan itself, before any Claude scan result (review F12)', (t) => {
    const c = collector(tmpHome());
    t.after(() => c.stop());
    const order = [];
    c._dispatchCodexScan = () => { order.push('codex'); };
    c.requestScan = () => { order.push('claude-scan'); };
    c._startWatchers = () => {};
    c._scheduleSweep = () => {};
    c.start();
    assert.equal(order[0], 'codex', 'the Codex scan is asked for first');
    assert.equal(order.filter((x) => x === 'codex').length, 1, 'exactly once');
  });

  test('on an empty store, a Codex result during Claude\'s first scan keeps the LOADING snapshot; Claude\'s settle then carries both (A3.14)', async (t) => {
    const dir = tmpHome();
    const c = collector(dir);
    t.after(() => c.stop());
    c._startWatchers = () => {};
    c._scheduleSweep = () => {};
    c.requestScan = () => {}; // Claude's first scan: still running
    c._dispatchCodexScan = () => {};
    const emitted = [];
    c.on('snapshot', (snap) => emitted.push(snap));

    c.start();
    const isLoading = (snap) => snap.usageHistory === null
      && snap.providers.find((p) => p.id === 'claude').status === 'loading';
    assert.ok(isLoading(c.snapshot), 'empty store: loading');
    assert.deepEqual(c.snapshot.pendingUsage, ['codex']);

    // The Codex worker answers first (it takes milliseconds).
    const fakeWorker = {};
    c._codexWorker = fakeWorker;
    c._codexInFlight = { id: 7, now: Date.now(), full: true, timer: null };
    const at = Date.now() - HOUR;
    c._onCodexMessage(fakeWorker, {
      type: 'result', id: 7, stats: {},
      events: [{ ts: at, model: 'gpt-5.6-sol', tier: 'standard', inputUncached: 2000, cachedInput: 0, cacheWrite: 100, output: 100 }],
    });
    for (const snap of emitted) assert.ok(isLoading(snap), 'no snapshot built from an empty Claude store was emitted');
    assert.ok(isLoading(c.snapshot));
    // Any other rebuild path (panel open, order change) stays loading too.
    assert.ok(isLoading(c.rebuild()));
    assert.deepEqual(c.snapshot.pendingUsage, [], 'Codex is no longer pending once its result is in');

    // Claude's first scan settles with one event.
    c._spawnScan = async () => ({
      ok: true,
      cursors: {},
      stats: { filesParsed: 1 },
      events: [{ f: 'f', key: 'k1', ts: at, model: 'claude-opus-5', input: 0, output: 1000, cacheWrite: 0, cacheRead: 0, cw5: 0, cw1h: 0 }],
    });
    await c._runScan();
    const snap = c.snapshot;
    assert.equal(isLoading(snap), false, 'the settle ends the loading state');
    const models = snap.usageHistory.weeks.flatMap((w) => w.byModel).map((m) => m.provider);
    assert.ok(models.includes('claude') && models.includes('codex'), 'the settled snapshot carries both tools');
    assert.ok(snap.providers.find((p) => p.id === 'codex').weeklyCost, 'including the Codex row cost that arrived earlier');
    assert.deepEqual(snap.pendingUsage, []);
  });

  test('a store that already has data is settled at start(): a Codex result rebuilds immediately (A3.14)', (t) => {
    const dir = tmpHome();
    require('../src/core/store').save(dir, {
      schemaVersion: require('../src/core/store').SCHEMA_VERSION,
      cursors: {},
      events: [{ f: 'f', key: 'k1', ts: Date.now() - HOUR, model: 'claude-opus-5', input: 0, output: 1000, cacheWrite: 0, cacheRead: 0, cw5: 0, cw1h: 0 }],
      builtAt: new Date().toISOString(),
    });
    const c = collector(dir);
    t.after(() => c.stop());
    c._startWatchers = () => {};
    c._scheduleSweep = () => {};
    c.requestScan = () => {};
    c._dispatchCodexScan = () => {};
    c.start();
    assert.notEqual(c.snapshot.usageHistory, null, 'persisted store: not loading');
    let rebuilds = 0;
    const real = c.rebuild.bind(c);
    c.rebuild = () => { rebuilds += 1; return real(); };
    const fakeWorker = {};
    c._codexWorker = fakeWorker;
    c._codexInFlight = { id: 3, now: Date.now(), full: true, timer: null };
    c._onCodexMessage(fakeWorker, { type: 'result', id: 3, stats: {}, events: [] });
    assert.equal(rebuilds, 1);
  });

  test('until a full scan has completed, a changed-file request is widened to a full scan', (t) => {
    const c = collector(tmpHome());
    t.after(() => c.stop());
    let want = null;
    c._dispatchCodexScan = () => { want = c._codexWant; };
    c._requestCodexScan({ changed: [path.join('2026', '09', '14', 'rollout-a.jsonl')] }, 1_000_000);
    assert.equal(want.full, true);
  });

  test('Codex is pending until the first worker result, and a worker restart does not re-enter pending', { timeout: 20000 }, async (t) => {
    const c = collector(tmpHome()); // an empty Codex home: the scan returns nothing
    t.after(() => c.stop());
    assert.deepEqual(c.rebuild().pendingUsage, ['codex'], 'before the first result');

    const first = new Promise((resolve) => c.once('codex-scan', resolve));
    c._requestCodexScan({ full: true });
    await first;
    assert.deepEqual(c.snapshot.pendingUsage, [], 'cleared by the first result, even an empty one');

    c._stopCodexWorker(); // e.g. a timeout restart: the cache in the worker is gone
    assert.equal(c._codexWorker, null);
    assert.deepEqual(c.rebuild().pendingUsage, [], 'the previous result is still valid');
    c._codexDispatchedAt = 0;
    const again = new Promise((resolve) => c.once('codex-scan', resolve));
    c._requestCodexScan({ changed: [path.join('2026', '09', '14', 'rollout-a.jsonl')] });
    assert.notEqual(c._codexWorker, null, 'a new worker was started');
    assert.equal(c._codexInFlight.full, true, 'and, its cache being empty, it scans in full');
    assert.deepEqual(c.rebuild().pendingUsage, [], 'not pending while the new worker runs');
    await again;
    assert.deepEqual(c.snapshot.pendingUsage, []);
  });

  test('the worker scans from historyStartMs, keeps its cache across reads, and each result rebuilds', { timeout: 20000 }, async (t) => {
    const dir = tmpHome();
    const c = collector(dir);
    t.after(() => c.stop());
    const now = Date.now();
    const day = (ms) => {
      const d = new Date(ms);
      return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    };
    const old = now - 40 * DAY;
    const recent = now - HOUR;
    const write = (ts, name) => {
      const dirPath = path.join(dir, 'codex', 'sessions', ...day(ts).split('/'));
      fs.mkdirSync(dirPath, { recursive: true });
      fs.writeFileSync(path.join(dirPath, name), [
        metaLine(), turnLine('gpt-5.6-sol'), settingsLine('default'), countLine(ts, cumOf(1000, 100, 500)),
      ].join('\n') + '\n');
      return path.join(...day(ts).split('/'), name);
    };
    write(old, 'rollout-old.jsonl');
    const recentRel = write(recent, 'rollout-new.jsonl');
    assert.ok(old >= historyMod.historyStartMs(now), 'the 40-day-old turn is inside the history range');

    let rebuilds = 0;
    const realRebuild = c.rebuild.bind(c);
    c.rebuild = () => { rebuilds += 1; return realRebuild(); };
    const result = () => new Promise((resolve) => c.once('codex-scan', resolve));

    let pending = result();
    c._requestCodexScan({ full: true });
    const first = await pending;
    assert.equal(first.mode, 'full');
    assert.equal(first.files, 2);
    assert.ok(first.bytesRead > 0);
    assert.ok(c._codexEvents.some((e) => e.ts < now - 30 * DAY), 'the old turn is in the result (as a UTC 15-minute bucket)');
    assert.ok(c._codexEvents.some((e) => e.ts === recent), 'the recent turn is raw');
    assert.ok(rebuilds >= 1, 'a result triggers a rebuild');
    assert.ok(c.snapshot.providers.find((p) => p.id === 'codex').weeklyCost, 'and the rebuild carries the Codex cost');

    c._codexDispatchedAt = 0; // skip the gap for the test
    pending = result();
    c._requestCodexScan({ changed: [recentRel] });
    const second = await pending;
    assert.equal(second.mode, 'changed');
    assert.equal(second.bytesRead, 0, 'the worker reused its cache: nothing re-read');
    assert.ok(c._codexEvents.some((e) => e.ts < now - 30 * DAY), 'a changed-file scan keeps the other rollouts');

    c._codexDispatchedAt = 0;
    pending = result();
    c._requestCodexScan({ full: true });
    assert.equal((await pending).bytesRead, 0, 'a full walk over unchanged files reads nothing either');
  });
});

/* ----------------------------------------------- security F3/F4: no links, no shares */

test.describe('the Codex readers never leave the local sessions tree', () => {
  const rollout = require('../src/core/codex/rollout');

  test('a LOCAL junction is followed for a day folder and for the whole sessions root, and a changed-file scan hits the same cache entry', (t) => {
    rollout._resetPathGuardForTests();
    const outside = tmpHome();
    const realDir = path.join(outside, 'elsewhere');
    fs.mkdirSync(realDir, { recursive: true });
    const content = [metaLine(), turnLine('gpt-5.6-sol'), settingsLine('default'), countLine(NOW - HOUR, cumOf(10, 1))].join('\n') + '\n';
    fs.writeFileSync(path.join(realDir, 'rollout-x.jsonl'), content);

    // A day folder that is a junction.
    const home = tmpHome();
    const month = path.join(home, 'sessions', '2026', '09');
    fs.mkdirSync(month, { recursive: true });
    try {
      fs.symlinkSync(realDir, path.join(month, '14'), 'junction');
    } catch (err) {
      t.skip(`cannot create a junction here: ${err.code}`);
      return;
    }
    assert.equal(codexUsageEvents({ now: NOW, startMs: NOW - DAY, home }).length, 1, 'junctioned day folder followed');
    assert.ok(rollout.newestRollout(path.join(home, 'sessions')), 'and by the rate-limit reader');

    // The whole sessions root junctioned to another place (e.g. another drive).
    const moved = path.join(outside, 'moved-sessions');
    fs.mkdirSync(path.join(moved, '2026', '09', '14'), { recursive: true });
    fs.writeFileSync(path.join(moved, '2026', '09', '14', 'rollout-y.jsonl'), content);
    const home3 = tmpHome();
    fs.symlinkSync(moved, path.join(home3, 'sessions'), 'junction');
    const scanner = createCodexUsageScanner();
    assert.equal(scanner.scan({ now: NOW, startMs: NOW - DAY, home: home3 }).length, 1, 'junctioned root followed');
    // A watcher-named change resolves to the same cache entry as the full walk.
    scanner.scan({ now: NOW, startMs: NOW - DAY, home: home3, changed: [path.join('2026', '09', '14', 'rollout-y.jsonl')] });
    assert.equal(scanner.stats().bytesRead, 0, 'same resolved path in both modes: nothing re-read');
    assert.equal(scanner.stats().files, 1);
  });

  test('a rollout FILE that is a symbolic link is skipped by the usage scanner and by newestRollout', (t) => {
    const outside = tmpHome();
    const target = path.join(outside, 'rollout-x.jsonl');
    fs.writeFileSync(target, [metaLine(), turnLine('gpt-5.6-sol'), settingsLine('default'), countLine(NOW - HOUR, cumOf(10, 1))].join('\n') + '\n');

    const home2 = tmpHome();
    const day = path.join(home2, 'sessions', '2026', '09', '14');
    fs.mkdirSync(day, { recursive: true });
    try {
      fs.symlinkSync(target, path.join(day, 'rollout-link.jsonl'), 'file');
    } catch (err) {
      t.skip(`file symlink not permitted here: ${err.code}`);
      return;
    }
    assert.deepEqual(codexUsageEvents({ now: NOW, startMs: NOW - DAY, home: home2 }), [], 'linked rollout skipped');
    assert.equal(rollout.newestRollout(path.join(home2, 'sessions')), null);
  });

  const REFUSED_LINE = 'codex sessions directory refused: code=NETWORK_TARGET';

  /** Records every path argument the guarded fs calls receive. */
  function spyFs(t) {
    const seen = [];
    const wrap = (obj, name) => {
      const orig = obj[name];
      obj[name] = function spied(...args) { seen.push(`${name}:${String(args[0])}`); return orig.apply(this, args); };
      t.after(() => { obj[name] = orig; });
    };
    // realpathSync.native is patched on the ORIGINAL function object, before
    // anything replaces fs.realpathSync, so restoring is exact.
    const nativeOrig = fs.realpathSync.native;
    const realpathObj = fs.realpathSync;
    realpathObj.native = function spiedNative(...args) { seen.push(`realpath.native:${String(args[0])}`); return nativeOrig.apply(this, args); };
    t.after(() => { realpathObj.native = nativeOrig; });
    for (const name of ['readdirSync', 'openSync', 'statSync', 'watch']) wrap(fs, name);
    return seen;
  }

  function captureLog(t) {
    const log = require('../src/core/log');
    const lines = [];
    log.setSink((level, msg) => { lines.push(String(msg)); });
    t.after(() => log.setSink(null));
    return lines;
  }

  test('a link whose TARGET is a share is refused by readlink before any readdir, open, stat, realpath or watch touches it (ADR-003 A3.1)', (t) => {
    rollout._resetPathGuardForTests();
    const share = String.raw`\\unreachable-codex-share\share\sessions`;
    const home = tmpHome();
    try {
      fs.symlinkSync(share, path.join(home, 'sessions'), 'dir');
    } catch (err) {
      t.skip(`cannot create a directory symlink here: ${err.code}`);
      return;
    }
    const lines = captureLog(t);
    const seen = spyFs(t);
    assert.equal(rollout.resolveLocalDir(path.join(home, 'sessions')), null);
    assert.deepEqual(codexUsageEvents({ now: NOW, startMs: NOW - DAY, home }), []);
    assert.equal(rollout.newestRollout(path.join(home, 'sessions')), null);
    assert.equal(rollout.readCodexRateLimits({ now: NOW, home }).state, 'missing');
    assert.deepEqual(seen.filter((c) => c.includes('unreachable-codex-share')), [],
      'no guarded fs call received the share path');
    // Nor the LINK itself: opening, stat-ing or resolving the link follows it to the share.
    const link = path.join(home, 'sessions');
    assert.deepEqual(seen.filter((c) => c.slice(c.indexOf(':') + 1).startsWith(link)), [],
      'no follow-through call on the link path either');
    assert.equal(lines.filter((l) => l === REFUSED_LINE).length, 1, 'the fixed line is logged, exactly once');
    assert.equal(lines.some((l) => l.includes('unreachable-codex-share')), false, 'the path is never logged');
  });

  test('a refused path is remembered for the process: the link is not re-examined on the next read (ADR-003 A3.3)', (t) => {
    rollout._resetPathGuardForTests();
    const home = tmpHome();
    try {
      fs.symlinkSync(String.raw`\\unreachable-codex-share\share\x`, path.join(home, 'sessions'), 'dir');
    } catch (err) {
      t.skip(`cannot create a directory symlink here: ${err.code}`);
      return;
    }
    captureLog(t);
    assert.equal(rollout.resolveLocalDir(path.join(home, 'sessions')), null);
    const readlinks = [];
    const orig = fs.readlinkSync;
    fs.readlinkSync = function spied(...args) { readlinks.push(String(args[0])); return orig.apply(this, args); };
    t.after(() => { fs.readlinkSync = orig; });
    assert.equal(rollout.resolveLocalDir(path.join(home, 'sessions')), null);
    assert.deepEqual(readlinks, [], 'answered from memory');
  });

  test('positive control, unstubbed: a local junction resolves to its target, through the same spied calls', (t) => {
    rollout._resetPathGuardForTests();
    const target = path.join(tmpHome(), 'real-sessions');
    fs.mkdirSync(target, { recursive: true });
    const home = tmpHome();
    try {
      fs.symlinkSync(target, path.join(home, 'sessions'), 'junction');
    } catch (err) {
      t.skip(`cannot create a junction here: ${err.code}`);
      return;
    }
    const seen = spyFs(t);
    assert.equal(rollout.resolveLocalDir(path.join(home, 'sessions')), fs.realpathSync.native(target));
    assert.ok(seen.some((c) => c.startsWith('realpath.native:')), 'the spy does observe the calls it guards');
  });

  test('a directory whose RESOLVED path is a share is refused after realpath, logging the fixed line once and never the path', (t) => {
    rollout._resetPathGuardForTests();
    const lines = captureLog(t);
    const real = fs.realpathSync.native;
    const home = tmpHome();
    fs.mkdirSync(path.join(home, 'sessions', '2026', '09', '14'), { recursive: true });
    fs.writeFileSync(path.join(home, 'sessions', '2026', '09', '14', 'rollout-x.jsonl'),
      [metaLine(), turnLine('gpt-5.6-sol'), settingsLine('default'), countLine(NOW - HOUR, cumOf(10, 1))].join('\n') + '\n');
    // A resolution that lands on a share (e.g. a mapped/redirected location).
    fs.realpathSync.native = (q) => (String(q).endsWith('14') ? String.raw`\\fileserver\share\codex\14` : real(q));
    t.after(() => { fs.realpathSync.native = real; });
    assert.deepEqual(codexUsageEvents({ now: NOW, startMs: NOW - DAY, home }), []);
    assert.equal(rollout.newestRollout(path.join(home, 'sessions')), null);
    fs.realpathSync.native = real;
    assert.equal(lines.filter((l) => l === REFUSED_LINE).length, 1, 'the fixed line is present, once');
    assert.equal(lines.some((l) => l.includes('fileserver') || l.includes('share\\')), false, 'the path is never logged');
  });

  test('newestDayDirs skips a newest day that links to a share and returns the next local day', (t) => {
    rollout._resetPathGuardForTests();
    captureLog(t);
    const home = tmpHome();
    const month = path.join(home, 'sessions', '2026', '09');
    fs.mkdirSync(path.join(month, '14'), { recursive: true });
    fs.mkdirSync(path.join(month, '13'), { recursive: true });
    fs.writeFileSync(path.join(month, '14', 'rollout-a.jsonl'), '{}\n');
    try {
      fs.symlinkSync(String.raw`\\unreachable-codex-share\share\15`, path.join(month, '15'), 'dir');
    } catch (err) {
      t.skip(`cannot create a directory symlink here: ${err.code}`);
      return;
    }
    const days = rollout.newestDayDirs(path.join(home, 'sessions'), 2);
    assert.deepEqual(days.map((d) => d.key), ['2026/09/14', '2026/09/13']);
    assert.equal(path.basename(rollout.newestRollout(path.join(home, 'sessions')).file), 'rollout-a.jsonl');
  });

  test('the network classifier refuses UNC, long UNC and // forms, and allows local long and volume paths', () => {
    for (const p of [String.raw`\\server\share`, String.raw`\\?\UNC\server\share`, String.raw`\\?\unc\server`, '//host/share']) {
      assert.equal(rollout.isNetworkResolved(p), true, p);
    }
    for (const p of [String.raw`C:\Users\x`, String.raw`\\?\C:\Users\x`, String.raw`\\?\Volume{0a1b}\x`, 'D:/codex']) {
      assert.equal(rollout.isNetworkResolved(p), false, p);
    }
  });

  test('a Codex home given as a UNC, \\\\?\\ or // string is treated as not found without touching it, and the path is never logged', () => {
    const log = require('../src/core/log');
    const lines = [];
    log.setSink((level, msg) => { lines.push(String(msg)); });
    try {
      for (const home of [String.raw`\\server\share\codex`, String.raw`\\?\C:\codex`, '//server/share/codex']) {
        assert.equal(rollout.codexSessionsDir(home), null, home);
        assert.deepEqual(codexUsageEvents({ now: NOW, startMs: NOW - DAY, home }), [], home);
        assert.equal(rollout.readCodexRateLimits({ now: NOW, home }).state, 'missing', home);
      }
    } finally {
      log.setSink(null);
    }
    assert.equal(lines.some((l) => l.includes('server') || l.includes('share')), false, 'the path is never logged');
    assert.equal(rollout.codexSessionsDir(String.raw`C:\Users\x\.codex`), path.join(String.raw`C:\Users\x\.codex`, 'sessions'));
  });

  test('CODEX_HOME pointing at a share makes codexHome() null', (t) => {
    const prev = process.env.CODEX_HOME;
    t.after(() => { if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev; });
    process.env.CODEX_HOME = String.raw`\\server\share\codex`;
    assert.equal(rollout.codexHome(), null);
    assert.equal(rollout.codexSessionsDir(), null);
  });
});
