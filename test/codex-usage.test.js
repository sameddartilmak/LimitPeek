'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { codexUsageEvents, sumCodexTokens } = require('../src/core/codex/usage');
const { codexCost, priceFor } = require('../src/core/codex/pricing');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-14T12:00:00.000Z');

function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-'));
  test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

/** A rollout whose first line is session_meta (carrying the model) followed by
 *  token_count events with the given per-turn usage deltas. */
function writeRollout(home, { day = '2026/09/14', name = 'rollout-a.jsonl', model = 'gpt-5.6-sol', turns }) {
  const dir = path.join(home, 'sessions', ...day.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const lines = [JSON.stringify({ type: 'session_meta', payload: { model, model_provider: 'openai' } })];
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
    // 1M uncached input, 1M cached, 1M output -> $4 + $0.40 + $20 = $24.40
    writeRollout(home, { model: 'gpt-5.6-sol', turns: [
      { ts: NOW - HOUR, usage: usage({ input: 2_000_000, cached: 1_000_000, output: 1_000_000 }) },
    ] });
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
    assert.equal(cost.fallbackWriteEvents, 0, 'a single, known write tier is never a floor');
  });

  test('gpt-5.6 charges cache WRITES at 1.25x input; the tier lands in cacheWrite5m', () => {
    const home = tmpHome();
    writeRollout(home, { model: 'gpt-5.6-sol', turns: [
      { ts: NOW - HOUR, usage: usage({ input: 1_000_000, write: 1_000_000 }) }, // all write
    ] });
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

  test('priceFor resolves an exact id and a date-suffixed one', () => {
    assert.equal(priceFor('gpt-5.6-sol').input, 4.00);
    assert.equal(priceFor('gpt-5-codex-20260901').input, 1.25, 'date suffix stripped');
    assert.equal(priceFor('nope'), null);
  });
});
