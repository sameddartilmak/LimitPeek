'use strict';
/**
 * Edge cases of the Codex token reader and pricer that the main suite
 * (codex-usage.test.js) does not reach, each one pinned by a mutation that
 * otherwise passed green (qa review of the Codex cost merge), plus the rules
 * ADR-002 Amendment 3 added at the review gate (A3.9, A3.10).
 *
 * Only the PUBLIC module APIs are exercised: `codexUsageEvents` /
 * `createCodexUsageScanner` from src/core/codex/usage.js, `codexCost` /
 * `codexCostDetail` from src/core/codex/pricing.js, and `sanitizeSnapshot` from
 * the renderer gate. No collector internals.
 *
 * Hermetic: every scan reads a fresh temp home, never ~/.codex; the clock is a
 * fixed LOCAL instant and every event is placed relative to the LOCAL start of
 * its week, and the day-folder is that week's local Monday — so the result does
 * not depend on the machine's time zone or on today's date.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { codexUsageEvents } = require('../src/core/codex/usage');
const { codexCost, codexCostDetail } = require('../src/core/codex/pricing');
const { formatModule } = require('./helpers/load-format');

const HOUR = 60 * 60 * 1000;
/** Monday 2026-09-14 00:00 LOCAL: the week every event below lives in. */
const WEEK_START = new Date(2026, 8, 14, 0, 0, 0, 0).getTime();
const WEEK_FOLDER = ['2026', '09', '14'];
/** Wednesday 12:00 local of that week. */
const NOW = new Date(2026, 8, 16, 12, 0, 0, 0).getTime();
const MiB = 1024 * 1024;

/* ------------------------------------------------------------------ helpers */

function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-edges-'));
  test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

function rolloutFile(home, name = 'rollout-edge.jsonl') {
  const dir = path.join(home, 'sessions', ...WEEK_FOLDER);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

/** Every event of the week so far. */
function scanWeek(home) {
  return codexUsageEvents({ now: NOW, startMs: WEEK_START, home });
}

function at(hoursIntoWeek) {
  return WEEK_START + hoursIntoWeek * HOUR;
}

function metaLine(extra = {}) {
  return JSON.stringify({ type: 'session_meta', payload: { id: 's', model_provider: 'openai', ...extra } });
}
function turnLine(model) {
  return JSON.stringify({ type: 'turn_context', payload: { turn_id: 't', model } });
}
function settingsLine(settings) {
  return JSON.stringify({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: 't', thread_settings: settings } });
}
function usage(input, output, { cached = 0, write = 0, reasoning = 0 } = {}) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: write,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}
/** A token_count record. `total` / `last` may be omitted to leave the field out. */
function countLine(ts, { total, last }) {
  const info = {};
  if (total !== undefined) info.total_token_usage = total;
  if (last !== undefined) info.last_token_usage = last;
  return JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'event_msg', payload: { type: 'token_count', info } });
}
/** A non-record line of exactly `bytes` bytes (JSON, no newline). */
function fillerLine(bytes) {
  const empty = JSON.stringify({ type: 'response_item', payload: { type: 'message', content: '' } });
  const pad = bytes - Buffer.byteLength(empty);
  assert.ok(pad >= 0, 'filler too small');
  return JSON.stringify({ type: 'response_item', payload: { type: 'message', content: 'x'.repeat(pad) } });
}

const HEAD = [metaLine(), turnLine('gpt-5.6-sol'), settingsLine({ service_tier: 'default' })];

/* ---------------------------------------------------- reading the rollout */

test.describe('the rollout reader at line and chunk boundaries', () => {
  test('a token_count line that straddles the 1 MiB read-chunk boundary is counted exactly once', () => {
    const home = tmpHome();
    const head = [...HEAD, countLine(at(1), { total: usage(100, 10), last: usage(100, 10) })].join('\n') + '\n';
    // The second token_count starts 40 bytes before the 1 MiB chunk boundary.
    const fillerBytes = MiB - 40 - Buffer.byteLength(head) - 1;
    const body = head + fillerLine(fillerBytes) + '\n';
    assert.equal(Buffer.byteLength(body), MiB - 40);
    const straddling = countLine(at(2), { total: usage(300, 30), last: usage(200, 20) });
    assert.ok(Buffer.byteLength(straddling) > 40, 'the line really crosses the boundary');
    fs.writeFileSync(rolloutFile(home), body + straddling + '\n');

    const evs = scanWeek(home);
    assert.deepEqual(evs.map((e) => [e.inputUncached, e.output]), [[100, 10], [200, 20]]);
  });

  test('a line over the 4 MiB cap is skipped, and the valid line after it is still counted', () => {
    const home = tmpHome();
    // Two oversized lines, both mentioning a marker, so each must be skipped
    // unparsed without swallowing the record after it. Just over the cap, the
    // line ends inside the chunk that crosses it; at 6 MiB a whole chunk passes
    // with no newline, so the reader is in its skip-to-newline state.
    const hugeLine = (bytes) => JSON.stringify({ type: 'response_item', payload: { content: 'token_count ' + 'y'.repeat(bytes) } });
    const justOver = hugeLine(4 * MiB + 1000);
    const wellOver = hugeLine(6 * MiB);
    assert.ok(Buffer.byteLength(justOver) > 4 * MiB);
    fs.writeFileSync(rolloutFile(home), [
      ...HEAD,
      countLine(at(1), { total: usage(100, 10), last: usage(100, 10) }),
      justOver,
      countLine(at(2), { total: usage(250, 25), last: usage(150, 15) }),
      wellOver,
      countLine(at(3), { total: usage(300, 30), last: usage(50, 5) }),
    ].join('\n') + '\n');

    const evs = scanWeek(home);
    assert.deepEqual(evs.map((e) => [e.inputUncached, e.output]), [[100, 10], [150, 15], [50, 5]]);
  });

  test('a CRLF rollout reads the same records as an LF one', () => {
    const home = tmpHome();
    fs.writeFileSync(rolloutFile(home), [
      ...HEAD,
      countLine(at(1), { total: usage(100, 10), last: usage(100, 10) }),
      turnLine('gpt-5.5'),
      countLine(at(2), { total: usage(300, 30), last: usage(200, 20) }),
    ].join('\r\n') + '\r\n');

    const evs = scanWeek(home);
    assert.deepEqual(evs.map((e) => [e.model, e.tier, e.inputUncached, e.output]), [
      ['gpt-5.6-sol', 'standard', 100, 10],
      ['gpt-5.5', 'standard', 200, 20],
    ]);
  });
});

/* ---------------------------------------------------- model, tier, reasoning */

test.describe('what each turn is priced as', () => {
  test('when session_meta names one model and turn_context another, the turn wins', () => {
    const home = tmpHome();
    fs.writeFileSync(rolloutFile(home), [
      metaLine({ model: 'gpt-5', base_instructions: { provenance: { model: 'gpt-5' } } }),
      turnLine('gpt-5.6-sol'),
      settingsLine({ service_tier: 'default' }),
      countLine(at(1), { total: usage(100, 10), last: usage(100, 10) }),
    ].join('\n') + '\n');
    assert.deepEqual(scanWeek(home).map((e) => e.model), ['gpt-5.6-sol']);
  });

  test('reasoning is not added to output on the last_token_usage-only path either', () => {
    const home = tmpHome();
    fs.writeFileSync(rolloutFile(home), [
      ...HEAD,
      countLine(at(1), { last: usage(100, 50, { reasoning: 20 }) }),
    ].join('\n') + '\n');
    assert.deepEqual(scanWeek(home).map((e) => e.output), [50]);
  });

  test('a settings record that does not state service_tier leaves the tier in effect', () => {
    const home = tmpHome();
    fs.writeFileSync(rolloutFile(home), [
      metaLine(), turnLine('gpt-5.6-sol'),
      settingsLine({ model: 'gpt-5.6-sol', service_tier: 'priority' }),
      settingsLine({ model: 'gpt-5.6-sol', approval_policy: 'on-request' }), // no tier key
      countLine(at(1), { total: usage(100, 10), last: usage(100, 10) }),
    ].join('\n') + '\n');
    assert.deepEqual(scanWeek(home).map((e) => e.tier), ['fast']);
  });
});

/* ---------------------------------------------------- long context (A3.4) */

test.describe('the 272K long-context rule counts the whole prompt (ADR-002 A3.4)', () => {
  const LONG_CONTEXT = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra', 'gpt-5.5', 'gpt-5.4'];

  /** One Standard-tier event whose prompt is `uncached + cached` tokens. */
  function ev(model, uncached, cached) {
    return { ts: at(1), model, tier: 'standard', inputUncached: uncached, cachedInput: cached, cacheWrite: 0, output: 10 };
  }

  for (const model of LONG_CONTEXT) {
    test(`${model}: a 272,001-token prompt, mostly cached, is unpriced`, () => {
      const cost = codexCost([ev(model, 1, 272000)], WEEK_START, NOW, false);
      assert.deepEqual(cost.byModel.map((m) => [m.speed, m.usd]), [['standard-long-context', null]]);
      assert.equal(cost.totalUsd, 0);
    });

    test(`${model}: a prompt of exactly 272,000 tokens is priced`, () => {
      const cost = codexCost([ev(model, 2000, 270000)], WEEK_START, NOW, false);
      assert.equal(cost.byModel.length, 1);
      assert.equal(cost.byModel[0].speed, 'standard');
      assert.ok(cost.byModel[0].usd > 0, `${model} at 272,000 has a price`);
    });
  }
});

/* ------------------------------------ the renderer gate keeps the floor count */

test.describe('sanitize keeps unrecordedWriteEvents as a record count (ADR-002 A3.8)', () => {
  const loader = formatModule();
  let s = null;
  test.before(async () => {
    await loader.load();
    s = await loader.sanitize();
  });
  test.after(() => loader.cleanup());

  function snapshotWithCount(value) {
    return {
      generatedAt: '2026-09-16T12:00:00.000Z',
      providers: [{
        id: 'codex', displayName: 'Codex', accent: '#10A37F', connected: true, status: 'ok',
        planLabel: null, fiveHour: null, sevenDay: null, tokens: null, burnRatePerHour: null, setupAction: null,
        weeklyCost: {
          totalUsd: 26.45,
          byClass: { input: 1, output: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 1 },
          byModel: [],
          unpricedModels: [],
          fallbackWriteEvents: 0,
          cacheWriteEvents: 0,
          unrecordedWriteEvents: value,
          pricesAsOf: '2026-09-14',
          windowStart: '2026-09-10T00:00:00.000Z',
          windowEnd: '2026-09-17T00:00:00.000Z',
          windowAnchored: true,
        },
      }],
    };
  }
  const countOf = (value) => s.sanitizeSnapshot(snapshotWithCount(value))
    .providers.find((p) => p.id === 'codex').weeklyCost.unrecordedWriteEvents;

  test('a non-negative integer count survives unchanged', () => {
    assert.equal(countOf(38), 38);
    assert.equal(countOf(0), 0);
  });

  test('anything that is not a non-negative integer reads as 0', () => {
    for (const bad of [-1, 1.5, 'x', '38', NaN, Infinity, null, undefined]) {
      assert.equal(countOf(bad), 0, JSON.stringify(bad));
    }
  });
});

/* ------------------------------------------------ ADR-002 A3.9: the write floor */

test.describe('zero recorded writes on a write-priced model (ADR-002 A3.9)', () => {
  function ev(model, uncached, cached) {
    return { ts: at(1), model, tier: 'standard', inputUncached: uncached, cachedInput: cached, cacheWrite: 0, output: 10 };
  }

  test('a first turn with no cache read but a cacheable prompt (>= 1024 uncached) is a floor', () => {
    const d = codexCostDetail([ev('gpt-5.6-sol', 1024, 0)], WEEK_START, NOW, false);
    assert.equal(d.writeFloorEvents, 1);
    assert.equal(d.cost.unrecordedWriteEvents, 1);
    assert.ok(d.cost.totalUsd > 0, 'still priced: no write count is estimated');
    assert.equal(d.cost.byClass.cacheWrite5m, 0, 'no invented write dollars');
  });

  test('a 1023-token uncached prompt with no cache read is below the cacheable minimum: not a floor', () => {
    const d = codexCostDetail([ev('gpt-5.6-sol', 1023, 0)], WEEK_START, NOW, false);
    assert.equal(d.writeFloorEvents, 0);
    assert.equal(d.cost.unrecordedWriteEvents, 0);
  });

  test('cached reads still make it a floor at any prompt size', () => {
    assert.equal(codexCostDetail([ev('gpt-5.6-sol', 10, 5)], WEEK_START, NOW, false).cost.unrecordedWriteEvents, 1);
  });

  test('a model with no write price is never a write floor, however large the prompt', () => {
    assert.equal(codexCostDetail([ev('gpt-5', 100000, 0)], WEEK_START, NOW, false).cost.unrecordedWriteEvents, 0);
  });
});

/* ----------------------------------- ADR-002 A3.10: trusting cumulative totals */

test.describe('cumulative totals are trusted only while monotonic (ADR-002 A3.10)', () => {
  const pairs = (evs) => evs.map((e) => [e.inputUncached, e.output]);

  test("a total that drops below the previous one counts that record's last_token_usage", () => {
    const home = tmpHome();
    fs.writeFileSync(rolloutFile(home), [
      ...HEAD,
      countLine(at(1), { total: usage(1000, 100), last: usage(1000, 100) }),
      // Reset: the total drops. The last usage differs from the new total, so
      // the assertion pins WHICH of the two is counted (review F9).
      countLine(at(2), { total: usage(300, 30), last: usage(120, 12) }),
    ].join('\n') + '\n');
    assert.deepEqual(pairs(scanWeek(home)), [[1000, 100], [120, 12]]);
  });

  test("a file's first record whose total exceeds its last counts last, not the inherited total", () => {
    const home = tmpHome();
    fs.writeFileSync(rolloutFile(home), [
      ...HEAD,
      // Resumed / forked session: the running total carries the parent's usage.
      countLine(at(1), { total: usage(50000, 5000), last: usage(100, 10) }),
      countLine(at(2), { total: usage(50200, 5020), last: usage(200, 20) }),
    ].join('\n') + '\n');
    assert.deepEqual(pairs(scanWeek(home)), [[100, 10], [200, 20]]);
  });

  for (const [label, bad] of [
    ['a fractional count', 1.5],
    ['a count beyond Number.MAX_SAFE_INTEGER', 2 ** 53],
    ['a negative count', -5],
    ['a numeric string', '1200'],
  ]) {
    test(`a record with ${label} is skipped and does not move the running total`, () => {
      const home = tmpHome();
      fs.writeFileSync(rolloutFile(home), [
        ...HEAD,
        countLine(at(1), { total: usage(1000, 100), last: usage(1000, 100) }),
        countLine(at(2), { total: { ...usage(1200, 120), input_tokens: bad }, last: { ...usage(200, 20), input_tokens: bad } }),
        countLine(at(3), { total: usage(1500, 150), last: usage(300, 30) }),
      ].join('\n') + '\n');
      assert.deepEqual(pairs(scanWeek(home)), [[1000, 100], [500, 50]]);
    });
  }
});
