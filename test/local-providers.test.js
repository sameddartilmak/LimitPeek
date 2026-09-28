'use strict';

/**
 * Kimi Code, Qwen Code and Grok Build as providers (ADR-003 A6): rows,
 * pending state, experimental marker, history and the collector's worker
 * channels. Hermetic: fixed NOW, temp homes, no real ~/.kimi-code, ~/.qwen or
 * ~/.grok.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildSnapshot, loadingSnapshot } = require('../src/core/snapshot');
const history = require('../src/core/history');
const { PROVIDERS } = require('../src/core/providers');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-14T12:00:00.000Z');

function tmpDir(prefix = 'local-providers-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

/** A Qwen Code response, the shape qwen/usage.js emits. $0.0099 at tier 0. */
const qwEv = (over) => ({ ts: NOW - HOUR, model: 'qwen3-coder-plus', tier: 0, input: 6000, cached: 4000, output: 700, ...over });
/** A Grok Build turn, the shape grok/usage.js emits. */
const gkEv = (over) => ({ ts: NOW - HOUR, model: 'grok-4.6', input: 800, cacheRead: 3000, cacheWrite: 200, output: 400, usd: 0.0123, partial: false, incomplete: false, ...over });
const kimiEv = (over) => ({ ts: NOW - HOUR, model: 'kimi-code/kimi-for-coding', input: 1200, output: 300, cacheRead: 5000, cacheWrite: 100, ...over });

function snap(extra = {}) {
  return buildSnapshot({ now: NOW, events: [], rateLimits: null, codexEvents: [], scanOk: true, ...extra });
}
const row = (s, id) => s.providers.find((p) => p.id === id);

test.describe('the experimental marker (ADR-003 A6 decision 4)', () => {
  test('true for Kimi, Qwen and Grok, false for every other provider, on every snapshot kind', () => {
    const expected = { claude: false, codex: false, antigravity: false, kimi: true, qwen: true, grok: true };
    const installed = { installed: true, events: [], readFailed: false, resultAtMs: NOW, unreadRange: null };
    for (const s of [snap(), snap({ kimi: installed, qwen: installed, grok: installed }), loadingSnapshot(NOW)]) {
      const got = Object.fromEntries(s.providers.map((p) => [p.id, p.experimental]));
      assert.deepEqual(got, expected);
    }
    assert.deepEqual(Object.fromEntries(PROVIDERS.map((p) => [p.id, p.experimental])), expected);
  });
});

test.describe('Kimi, Qwen and Grok rows', () => {
  test('not installed: the passive "not installed" row, never pending, no figures', () => {
    const s = snap({ qwen: { installed: false, events: null }, kimi: undefined, grok: undefined });
    for (const id of ['kimi', 'qwen', 'grok']) {
      const r = row(s, id);
      assert.equal(r.connected, false);
      assert.equal(r.status, 'passive');
      assert.equal(r.fiveHour, null);
      assert.equal(r.tokens, null);
      assert.equal(r.weeklyCost, null);
      assert.equal(r.setupAction.kind, 'not-installed');
    }
    assert.deepEqual(s.pendingUsage, []);
  });

  test('installed and not scanned yet: pending, with null (not zero) figures', () => {
    const pending = { installed: true, events: null, readFailed: false, resultAtMs: null, unreadRange: null };
    const s = snap({ kimi: pending, qwen: pending, grok: pending, codexEvents: null });
    assert.deepEqual(s.pendingUsage, ['codex', 'kimi', 'qwen', 'grok']);
    for (const id of ['kimi', 'qwen', 'grok']) {
      const r = row(s, id);
      assert.equal(r.connected, true);
      assert.equal(r.tokens, null);
      assert.equal(r.weeklyCost, null);
      assert.equal(r.lastGoodAt, null);
      assert.equal(r.setupAction, null);
    }
    assert.equal(s.usageHistory.usageProviders.length, 0, 'unread tools are not in the history');
  });

  test('installed Qwen: no invented windows, trailing-5h tokens, trailing-7d cost that is always a floor', () => {
    const s = snap({
      qwen: {
        installed: true,
        // The second is a 1M-token request: tier class 3, $6/M input.
        events: [qwEv({}), qwEv({ ts: NOW - 6 * HOUR, tier: 3, input: 1000000, cached: 0, output: 0 }), qwEv({ ts: NOW - 8 * DAY })],
        readFailed: false,
        resultAtMs: NOW - 1000,
        unreadRange: null,
      },
    });
    const r = row(s, 'qwen');
    assert.equal(r.status, 'ok');
    for (const w of [r.fiveHour, r.sevenDay]) {
      assert.deepEqual({ used: w.usedPercentage, certainty: w.certainty, absence: w.absence }, { used: null, certainty: 'unknown', absence: 'not-supplied' });
    }
    assert.deepEqual(r.tokens, { input: 6000, output: 700, cacheWrite: 0, cacheRead: 4000, billable: 6700 }, 'only the last 5 hours');
    assert.equal(r.weeklyCost.windowAnchored, false);
    assert.equal(r.weeklyCost.windowStart, new Date(NOW - 7 * DAY).toISOString());
    assert.ok(Math.abs(r.weeklyCost.totalUsd - (0.0099 + 6)) < 1e-9, 'the 8-day-old response is outside the trailing week');
    assert.equal(r.weeklyCost.unrecordedCalls, true);
    assert.equal(r.weeklyCost.pricesAsOf, '2026-09-28');
    assert.equal(r.weeklyCost.sourceIncomplete, false);
    assert.equal(r.lastGoodAt, new Date(NOW - 1000).toISOString());
    assert.equal(r.usageLogAbsent, undefined, 'only a Qwen with no log at all says so');
  });

  test('installed Qwen with no usage log at all: connected, no figures, and the row says why', () => {
    const s = snap({ qwen: { installed: true, events: [], readFailed: false, resultAtMs: NOW, unreadRange: null, usageLogAbsent: true } });
    const r = row(s, 'qwen');
    assert.equal(r.connected, true);
    assert.equal(r.status, 'ok');
    assert.equal(r.usageLogAbsent, true);
    assert.equal(r.weeklyTokens, null, 'no log, no week to measure: not a zero');
    assert.equal(r.tokens, null);
    assert.equal(r.weeklyCost, null);
    assert.deepEqual(s.pendingUsage, [], 'scanned, not pending');
    assert.equal(s.usageHistory.usageProviders.includes('qwen'), false);
  });

  test('installed Grok: the amount xAI reported, no price date, and a partial turn is counted as a floor', () => {
    const s = snap({
      grok: {
        installed: true,
        events: [gkEv({}), gkEv({ ts: NOW - 2 * DAY, usd: 0.5, partial: true, incomplete: true }), gkEv({ ts: NOW - 3 * DAY, usd: null })],
        readFailed: false,
        resultAtMs: NOW,
        unreadRange: null,
      },
    });
    const r = row(s, 'grok');
    assert.equal(r.fiveHour.absence, 'not-supplied');
    assert.deepEqual(r.tokens, { input: 800, output: 400, cacheWrite: 200, cacheRead: 3000, billable: 1400 });
    const c = r.weeklyCost;
    assert.ok(Math.abs(c.totalUsd - 0.5123) < 1e-9, 'reported amounts, the unreported turn adds nothing');
    assert.equal(c.pricesAsOf, '', 'no price list, so no date');
    assert.equal(c.partialUsageEvents, 1);
    assert.deepEqual(c.byClass, { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 }, 'xAI reports no class split');
    assert.deepEqual(c.byModel.map((m) => [m.speed, m.usd === null]), [['reported', false], ['no-reported-cost', true]]);
    assert.deepEqual(r.weeklyTokenFloorCauses, ['partial-usage'], 'an incomplete turn makes the COUNT a floor too');
  });

  test('installed Kimi: tokens by alias, unpriced, no price date', () => {
    const s = snap({ kimi: { installed: true, events: [kimiEv({}), kimiEv({ model: 'openai/gpt-5.5', input: 10 })], readFailed: false, resultAtMs: NOW, unreadRange: null } });
    const r = row(s, 'kimi');
    assert.equal(r.fiveHour.absence, 'not-supplied');
    assert.equal(r.tokens.billable, 1200 + 300 + 100 + 10 + 300 + 100);
    assert.equal(r.weeklyCost.totalUsd, 0);
    assert.equal(r.weeklyCost.pricesAsOf, '');
    assert.deepEqual(r.weeklyCost.byModel.map((m) => m.speed), ['no-published-price', 'other-model-alias']);
  });

  test('a failed scan serving an older result marks the cost incomplete, and with nothing in the window still delivers an empty cost (A3.15, A3.19)', () => {
    const s = snap({
      qwen: { installed: true, events: [qwEv({})], readFailed: true, resultAtMs: NOW - 10 * 60 * 1000, unreadRange: null },
      kimi: { installed: true, events: [], readFailed: false, resultAtMs: NOW, unreadRange: { fromMs: NOW - DAY, throughMs: NOW - DAY } },
      grok: { installed: true, events: [], readFailed: false, resultAtMs: NOW, unreadRange: { fromMs: NOW - DAY, throughMs: NOW - DAY } },
    });
    assert.equal(row(s, 'qwen').weeklyCost.sourceIncomplete, true);
    assert.equal(row(s, 'qwen').status, 'ok', 'completeness never drives the row status');
    for (const id of ['kimi', 'grok']) {
      const k = row(s, id).weeklyCost;
      assert.equal(k.sourceIncomplete, true, id);
      assert.equal(k.totalUsd, 0, id);
      assert.equal(k.pricesAsOf, '', id);
    }
    assert.deepEqual(s.usageHistory.incompleteProviders, ['kimi', 'qwen', 'grok']);
  });
});

test.describe('history with Kimi, Qwen and Grok (Toplam Kullanım)', () => {
  const at = history.weekStartMs(NOW) + HOUR;

  test('each tool is tagged, Qwen and Grok dollars join the total, Kimi adds none, and the floors are OR-ed', () => {
    const out = history.usageHistory([], NOW, {
      codexEvents: [{ ts: at, model: 'gpt-5.6-sol', tier: 'standard', inputUncached: 10, cachedInput: 90, cacheWrite: 0, output: 10 }],
      qwenEvents: [qwEv({ ts: at }), qwEv({ ts: at, model: 'glm-5', input: 5 })],
      kimiEvents: [kimiEv({ ts: at })],
      grokEvents: [gkEv({ ts: at })],
    });
    const week = out.weeks[0];
    assert.equal(week.isFloor, true);
    assert.deepEqual([...new Set(week.byModel.map((m) => m.provider))].sort(), ['codex', 'grok', 'kimi', 'qwen']);
    const qwen = week.byModel.find((m) => m.model === 'qwen3-coder-plus');
    assert.deepEqual({ cost: qwen.costUsd, floor: qwen.isFloor }, { cost: 0.0099, floor: true });
    const grok = week.byModel.find((m) => m.provider === 'grok');
    assert.deepEqual({ cost: grok.costUsd, floor: grok.isFloor }, { cost: 0.0123, floor: false });
    const kimi = week.byModel.find((m) => m.provider === 'kimi');
    assert.deepEqual({ cost: kimi.costUsd, floor: kimi.isFloor }, { cost: null, floor: false });
    const codex = week.byModel.find((m) => m.provider === 'codex');
    assert.ok(Math.abs(week.costUsd - (codex.costUsd + 0.0099 + 0.0123)) < 1e-9, 'Kimi and the unpriced glm-5 add no dollars');
    assert.ok(week.unpricedModels.includes('kimi-code/kimi-for-coding') && week.unpricedModels.includes('glm-5'));

    assert.deepEqual(Object.keys(out.pricesAsOfByProvider).sort(), ['codex', 'qwen'], 'Kimi and Grok have no price date');
    assert.equal(out.pricesAsOfByProvider.qwen, '2026-09-28');
    assert.deepEqual(out.usageProviders, ['codex', 'kimi', 'qwen', 'grok']);
    // Codex's cached read with 0 recorded writes is priced as an upper bound
    // since 2026-09-23, not a floor, so Codex names no cause.
    assert.equal(codex.isFloor, false);
    assert.deepEqual(out.floorCausesByProvider, {
      kimi: ['unpriced'],
      qwen: ['unpriced', 'unrecorded-calls'],
    });
  });

  test('Grok partial and unreported turns are named; no Grok date ever', () => {
    const out = history.usageHistory([], NOW, { grokEvents: [gkEv({ ts: at, partial: true, incomplete: true }), gkEv({ ts: at, usd: null, model: 'grok-code' })] });
    assert.deepEqual(out.floorCausesByProvider, { grok: ['unpriced', 'partial-usage'] });
    assert.deepEqual(out.pricesAsOfByProvider, {});
    assert.deepEqual(out.weeks[0].tokenFloorCausesByProvider, { grok: ['partial-usage'] });
    const entry = out.weeks[0].byModel.find((m) => m.model === 'grok-4.6');
    assert.equal(entry.isFloor, true, 'a partial turn makes the priced entry a floor');
    const none = history.usageHistory([], NOW, { kimiEvents: [kimiEv({ ts: at })] });
    assert.deepEqual(none.pricesAsOfByProvider, {});
    assert.deepEqual(none.usageProviders, ['kimi']);
    assert.equal(none.weeks[0].hasUsage, true);
    assert.equal(none.weeks[0].costUsd, 0);
    assert.equal(none.weeks[0].isFloor, true, 'unpriced usage is never a silent $0');
  });

  test('Claude-only history: the new fields are present and describe Claude alone', () => {
    const out = history.usageHistory(
      [{ f: 'f', key: 'k', ts: at, model: 'claude-opus-5', input: 0, output: 1000, cacheWrite: 0, cacheRead: 0, cw5: 0, cw1h: 0 }],
      NOW,
    );
    assert.deepEqual(out.usageProviders, ['claude']);
    assert.deepEqual(out.floorCausesByProvider, {});
  });
});

test.describe('the collector runs the local-log scans off the main thread', () => {
  const { Collector } = require('../src/core/collector');

  function collector(dir, over = {}) {
    return new Collector({
      userDataDir: dir,
      projectsRoot: path.join(dir, 'projects'),
      rateLimitsFile: path.join(dir, 'claude-rate-limits.json'),
      rateLimitsDir: dir,
      antigravityQuotaFile: path.join(dir, 'antigravity-quota.json'),
      ideAppDataDir: path.join(dir, 'ide'),
      codexHome: path.join(dir, 'codex'),
      antigravityUsageHome: path.join(dir, 'antigravity-home'),
      kimiHome: path.join(dir, 'kimi-home'),
      qwenHome: path.join(dir, 'qwen-home'),
      grokHome: path.join(dir, 'grok-home'),
      ...over,
    });
  }

  test('a tool that is not installed is never pending and never gets a worker', (t) => {
    const c = collector(tmpDir());
    t.after(() => c.stop());
    c._codexEvents = [];
    for (const ch of [c._kimi, c._qwen, c._grok]) ch.auto = true;
    const s = c.rebuild();
    assert.deepEqual(s.pendingUsage, []);
    for (const ch of [c._kimi, c._qwen, c._grok]) assert.equal(ch.worker, null, ch.id);
    for (const id of ['qwen', 'grok']) assert.equal(s.providers.find((p) => p.id === id).status, 'passive', id);
  });

  test('an installed tool is pending until its worker\'s first result, which rebuilds with its figures', { timeout: 20000 }, async (t) => {
    const dir = tmpDir();
    const now = Date.now();
    // Qwen Code: one usage-log line (fixture shapes as in test/qwen-usage.test.js).
    const at = new Date(now - HOUR);
    const month = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`;
    const usage = path.join(dir, 'qwen-home', 'usage');
    fs.mkdirSync(usage, { recursive: true });
    fs.writeFileSync(path.join(usage, `token-usage-${month}.jsonl`), JSON.stringify({
      schemaVersion: 1, id: 'u-1', timestamp: at.toISOString(), localDate: `${month}-01`, localMonth: month,
      sessionId: 's-1', model: 'qwen3-coder-plus', authType: 'openai', source: 'main',
      inputTokens: 1000, outputTokens: 10, cachedTokens: 0, thoughtsTokens: 0, totalTokens: 1010, apiDurationMs: 100,
    }) + '\n');
    // Grok Build: one session usage file (fixture shapes as in test/grok-usage.test.js).
    const session = path.join(dir, 'grok-home', 'sessions', 'proj-0123456789abcdef', 'sess-1');
    fs.mkdirSync(session, { recursive: true });
    fs.writeFileSync(path.join(session, 'usage.json'), JSON.stringify({
      sessionId: 'sess-1', updatedAt: at.toISOString(), session: { primaryModelId: 'grok-4.6' },
      turns: [{ turnNumber: 1, endedAt: at.toISOString(), inputTokens: 300, outputTokens: 7, cachedReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0, totalTokens: 307, modelCalls: 1, costUsdTicks: 12300000, costIsPartial: false, usageIsIncomplete: false }],
    }));
    // Kimi: one wire journal.
    const wire = path.join(dir, 'kimi-home', 'sessions', 'ws', 'session_1', 'agents', 'main', 'wire.jsonl');
    fs.mkdirSync(path.dirname(wire), { recursive: true });
    fs.writeFileSync(wire, JSON.stringify({ type: 'usage.record', agentId: 'main', model: 'kimi-code/k2', usage: { inputOther: 5, output: 5, inputCacheRead: 0, inputCacheCreation: 0 }, usageScope: 'turn', time: now - HOUR }) + '\n');

    const c = collector(dir);
    t.after(() => c.stop());
    c._codexEvents = [];
    c._dispatchCodexScan = () => {};
    assert.deepEqual(c.rebuild().pendingUsage, ['kimi', 'qwen', 'grok'], 'installed, not read yet');

    const scans = ['qwen', 'kimi', 'grok'].map((id) => new Promise((resolve) => c.once(`${id}-scan`, resolve)));
    for (const ch of [c._kimi, c._qwen, c._grok]) ch.auto = true;
    c._localTick(Date.now());
    assert.notEqual(c._qwen.worker, null, 'the scan runs in a worker');
    const [qs, ks, gs] = await Promise.all(scans);
    assert.equal(qs.files, 1);
    assert.equal(ks.files, 1);
    assert.equal(gs.files, 1);
    const s = c.snapshot;
    assert.deepEqual(s.pendingUsage, []);
    assert.equal(s.providers.find((p) => p.id === 'qwen').tokens.input, 1000);
    assert.equal(s.providers.find((p) => p.id === 'kimi').tokens.output, 5);
    assert.equal(s.providers.find((p) => p.id === 'grok').tokens.input, 300);
    assert.equal(s.providers.find((p) => p.id === 'grok').weeklyCost.totalUsd, 0.00123);
    assert.deepEqual(s.usageHistory.usageProviders, ['kimi', 'qwen', 'grok']);

    // An unchanged rescan: the worker posts no events and the held array keeps
    // its identity, so the snapshot's history memo is reused (F3).
    const held = c._qwen.events;
    const history0 = c.snapshot.usageHistory;
    c._qwen.dispatchedAt = 0;
    const again = new Promise((resolve) => c.once('qwen-scan', resolve));
    c._qwen.request(Date.now());
    await again;
    assert.equal(c._qwen.events, held);
    assert.equal(c.snapshot.usageHistory, history0);

    c._qwen.stopWorker();
    assert.deepEqual(c.rebuild().pendingUsage, [], 'a worker restart does not re-enter pending');
  });
});

test.describe('the usage history is memoised (ADR-003 A6 Phase A, F3)', () => {
  const snapshotMod = require('../src/core/snapshot');
  const { sameEvents } = require('../src/core/same-events');

  function counting(t) {
    const real = history.usageHistory;
    let calls = 0;
    history.usageHistory = (...args) => { calls += 1; return real(...args); };
    t.after(() => { history.usageHistory = real; });
    snapshotMod._resetHistoryMemoForTests();
    return () => calls;
  }

  test('an identical rebuild does not re-price; a period boundary, new events or a new unread range do', (t) => {
    const calls = counting(t);
    const events = [];
    const codex = [{ ts: NOW - HOUR, model: 'gpt-5.6-sol', tier: 'standard', inputUncached: 10, cachedInput: 0, cacheWrite: 0, output: 10 }];
    const qw = { installed: true, events: [qwEv({})], resultAtMs: NOW, unreadRange: null };
    const input = (over = {}) => ({ now: NOW, events, rateLimits: null, codexEvents: codex, scanOk: true, qwen: qw, ...over });

    const first = buildSnapshot(input());
    const again = buildSnapshot(input({ now: NOW + 60 * 1000 }));
    assert.equal(calls(), 1, 'same arrays, same unread ranges, same week and month: reused');
    assert.equal(again.usageHistory, first.usageHistory);

    // 2026-09-14 is a Monday; a week later is the next local week.
    buildSnapshot(input({ now: history.weekStartMs(NOW) + 7 * DAY + HOUR }));
    assert.equal(calls(), 2, 'a new week invalidates');

    buildSnapshot(input({ qwen: { ...qw, events: [qwEv({}), qwEv({ ts: NOW - 2 * HOUR })] } }));
    assert.equal(calls(), 3, 'a new event array invalidates');

    buildSnapshot(input({ qwen: { ...qw, events: [qwEv({}), qwEv({ ts: NOW - 2 * HOUR })], unreadRange: { fromMs: NOW - DAY, throughMs: NOW - DAY } } }));
    assert.equal(calls(), 4, 'a new unread range invalidates');

    buildSnapshot(input({ qwen: { ...qw, events: [qwEv({}), qwEv({ ts: NOW - 2 * HOUR })], unreadRange: { fromMs: NOW - DAY, throughMs: NOW - DAY } }, grok: { installed: true, events: [gkEv({})], resultAtMs: NOW } }));
    assert.equal(calls(), 5, 'a new Grok array invalidates');
  });

  test('sameEvents compares values in order, so an unchanged scan keeps its array identity', () => {
    const a = [qwEv({}), kimiEv({})];
    assert.equal(sameEvents(a, a.map((e) => ({ ...e }))), true);
    assert.equal(sameEvents(a, [a[0], { ...a[1], output: 301 }]), false);
    assert.equal(sameEvents(a, [a[1], a[0]]), false);
    assert.equal(sameEvents(a, [a[0], { ...a[1], extra: 1 }]), false);
    assert.equal(sameEvents(null, []), false);
  });
});

test.describe('Phase A review fixes: bounds, future records, path allowlist', () => {
  const rollout = require('../src/core/codex/rollout');
  const snapshotMod = require('../src/core/snapshot');

  test('security F3: only drive-letter, long drive-letter and volume GUID forms are local; others are refused before any lstat', (t) => {
    rollout._resetPathGuardForTests();
    for (const p of [String.raw`\\.\pipe\x`, String.raw`\\?\GLOBALROOT\Device\HarddiskVolume1\x`, String.raw`\\?\UNC\s\x`, 'relative\\x']) {
      assert.equal(rollout.isNetworkResolved(p), true, p);
    }
    for (const p of [String.raw`C:\x`, String.raw`\\?\C:\x`, String.raw`\\?\Volume{0a1b-2c}\x`]) {
      assert.equal(rollout.isNetworkResolved(p), false, p);
    }
    const lstats = [];
    const orig = fs.lstatSync;
    fs.lstatSync = function spied(...args) { lstats.push(String(args[0])); return orig.apply(this, args); };
    t.after(() => { fs.lstatSync = orig; });
    const log = require('../src/core/log');
    log.setSink(() => {});
    t.after(() => log.setSink(null));
    assert.equal(rollout.resolveLocalDir(String.raw`\\.\pipe\usage-notch-test`), null);
    assert.equal(rollout.resolveLocalDir(String.raw`\\?\GLOBALROOT\Device\x`), null);
    assert.deepEqual(lstats, []);
  });

  test('security F5: one resolution follows at most 64 links in total', (t) => {
    // Windows itself stops at 63 reparse points per path, so the budget is
    // exercised with a stubbed tree: every component under the fake root is a
    // link to a plain directory, so hops grow while each target stays shallow.
    rollout._resetPathGuardForTests();
    const fakeRoot = path.join(path.parse(os.tmpdir()).root, 'usage-notch-hops-fake');
    const target = path.join(fakeRoot, 'plain');
    const origL = fs.lstatSync;
    const origR = fs.readlinkSync;
    const under = (p) => String(p).toLowerCase().startsWith(fakeRoot.toLowerCase());
    fs.lstatSync = function stub(p, ...rest) {
      if (!under(p)) return origL.call(this, p, ...rest);
      const link = /^l[0-9]+$/.test(path.basename(String(p)));
      return { isSymbolicLink: () => link, isDirectory: () => true, isFile: () => false };
    };
    fs.readlinkSync = function stub(p, ...rest) { return under(p) ? target : origR.call(this, p, ...rest); };
    t.after(() => { fs.lstatSync = origL; fs.readlinkSync = origR; });
    const chain = (n) => path.join(fakeRoot, `c${n}`, ...Array.from({ length: n }, (_, i) => `l${i}`));
    assert.equal(rollout.resolveLocalDir(chain(64)), null, 'does not exist, so null either way');
    assert.equal(rollout.isRefusedDir(chain(64)), false, '64 hops are within the budget');
    assert.equal(rollout.resolveLocalDir(chain(65)), null);
    assert.equal(rollout.isRefusedDir(chain(65)), true, 'the 65th hop is refused (LINK_DEPTH)');
  });

  test('security F4: per-model lists in a WeeklyCost and a history period are capped at 24', () => {
    snapshotMod._resetHistoryMemoForTests();
    const events = Array.from({ length: 30 }, (_, i) => qwEv({ ts: NOW - HOUR + i, model: `unpriced-${String(i).padStart(2, '0')}` }));
    const s = snap({ qwen: { installed: true, events, resultAtMs: NOW } });
    const cost = row(s, 'qwen').weeklyCost;
    assert.equal(cost.byModel.length, 24);
    assert.equal(cost.unpricedModels.length, 24);
    const week = s.usageHistory.weeks[0];
    assert.equal(week.byModel.length, 24);
    assert.equal(week.unpricedModels.length, 24);
  });

  test('security F4: the local-log and Codex scan workers run with a bounded old generation', () => {
    const { WORKER_MAX_OLD_GEN_MB } = require('../src/core/usage-channel');
    assert.equal(WORKER_MAX_OLD_GEN_MB, 512);
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'collector.js'), 'utf8');
    assert.ok(/new Worker\(this\.codexWorkerPath, \{ resourceLimits: \{ maxOldGenerationSizeMb: 512 \} \}\)/.test(src));
  });

  test('review F10: a Claude record stamped in the future joins the history only when its time comes', () => {
    snapshotMod._resetHistoryMemoForTests();
    const future = { f: 'f', key: 'k-future', ts: NOW + 2 * HOUR, model: 'claude-opus-5', input: 0, output: 1000000, cacheWrite: 0, cacheRead: 0, cw5: 0, cw1h: 0 };
    const events = [future];
    const before = buildSnapshot({ now: NOW, events, rateLimits: null, codexEvents: [], scanOk: true });
    assert.equal(before.usageHistory.weeks.length, 0, 'not yet');
    const after = buildSnapshot({ now: NOW + 3 * HOUR, events, rateLimits: null, codexEvents: [], scanOk: true });
    assert.equal(after.usageHistory.weeks[0].costUsd, 25, 'same array identity, but the memo key moved');
  });
});

/**
 * `ProviderSnapshot.weeklyTokens` on the local-log rows.
 *
 * No such tool publishes a weekly reset to us, so this window is always
 * trailing — and it must match the cost block on the same row, which already
 * says so through `windowAnchored: false`.
 */
test.describe('the Kimi, Qwen and Grok weekly token figure', () => {
  const installed = (events) => ({ installed: true, events, readFailed: false, resultAtMs: NOW, unreadRange: null });

  test('a trailing 7 days, half-open at the start, over the same window the cost block prices', () => {
    const s = snap({
      qwen: installed([
        qwEv({ ts: NOW - 7 * DAY - 1, output: 1_000_000 }),
        qwEv({ ts: NOW - 7 * DAY, output: 5, input: 0, cached: 0 }),
        qwEv({ ts: NOW - DAY, output: 6, input: 0, cached: 0 }),
      ]),
    });
    const g = row(s, 'qwen');
    assert.equal(g.weeklyTokens.output, 11, 'the ms before the start is out');
    assert.equal(g.weeklyCost.windowAnchored, false, 'Qwen Code publishes no weekly reset');
    assert.equal(g.weeklyCost.windowEnd, new Date(NOW).toISOString());
  });

  test('Kimi has no price at all and still has a token count', () => {
    const s = snap({ kimi: installed([kimiEv({ ts: NOW - 3 * DAY })]) });
    const k = row(s, 'kimi');
    assert.equal(k.weeklyCost.totalUsd, 0, 'nothing priced');
    assert.deepEqual(k.weeklyCost.unpricedModels, ['kimi-code/kimi-for-coding']);
    assert.equal(k.weeklyTokens.billable, 1200 + 300 + 100, 'usage is a fact even where price is not');
    assert.equal(k.weeklyTokens.cacheRead, 5000, 'reported on its own, never in billable');
  });

  test('the week is not the five hours', () => {
    const s = snap({ kimi: installed([kimiEv({ ts: NOW - 3 * DAY }), kimiEv({ ts: NOW - HOUR, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })]) });
    const k = row(s, 'kimi');
    assert.equal(k.tokens.billable, 2, 'only the recent event is in the five hours');
    assert.equal(k.weeklyTokens.billable, 1602);
  });

  test('null means only "not scanned"; a scanned empty week is a PRESENT zero', () => {
    for (const id of ['qwen', 'kimi', 'grok']) assert.equal(row(snap(), id).weeklyTokens, null, `${id} not installed: no corpus`);
    const pending = snap({ qwen: { installed: true, events: null, resultAtMs: null } });
    assert.equal(row(pending, 'qwen').weeklyTokens, null, 'pending');
    assert.deepEqual(pending.pendingUsage, ['qwen'], 'and the snapshot says why it is null');
    // The state that used to read "could not be counted": installed, scanned,
    // and the user simply did not use the tool.
    const empty = snap({ qwen: installed([]), grok: installed([]) });
    for (const id of ['qwen', 'grok']) {
      assert.deepEqual(row(empty, id).weeklyTokens, { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, billable: 0 }, id);
      assert.deepEqual(row(empty, id).weeklyTokenFloorCauses, [], 'a measured zero is not a floor');
      assert.equal(row(empty, id).tokens, null, 'the 5-hour field keeps its own shipped rule');
    }
  });
});

/**
 * `weeklyTokenFloorCauses` on the local-log rows (ADR-003 A6).
 *
 * Qwen Code never writes its failed calls or side queries, so ANY Qwen token
 * figure is a lower bound — unconditionally, and in particular whether or not
 * the recorded responses could be priced. That last clause is the whole point:
 * `weeklyCost.unrecordedCalls` is a COST cause and goes false when nothing
 * priced, which would have left an all-unpriced Qwen week looking exact.
 * Kimi's recorder drops nothing, so only an unread range moves it; Grok's
 * count is a floor only where xAI itself marked a turn's usage incomplete.
 */
test.describe('the Qwen token floor cause is unconditional, and Kimi has none of its own', () => {
  const installed = (events, extra) => ({ installed: true, events, readFailed: false, resultAtMs: NOW, unreadRange: null, ...extra });

  test('Qwen with priced usage is a floor', () => {
    const g = row(snap({ qwen: installed([qwEv({ ts: NOW - DAY })]) }), 'qwen');
    assert.equal(g.weeklyCost.unrecordedCalls, true);
    assert.deepEqual(g.weeklyTokenFloorCauses, ['unrecorded-calls']);
  });

  test('Qwen whose week could not be priced AT ALL is still a floor', () => {
    // Another vendor's model served through the Coding Plan: unpriced, so
    // `unrecordedCalls` stays false. The unrecorded calls happened all the same.
    const other = qwEv({ ts: NOW - DAY, model: 'glm-5', input: 600, cached: 0, output: 400 });
    const g = row(snap({ qwen: installed([other]) }), 'qwen');
    assert.equal(g.weeklyCost.totalUsd, 0, 'nothing priced');
    assert.equal(g.weeklyCost.unrecordedCalls, false, 'the COST cause is off, unchanged');
    assert.equal(g.weeklyTokens.billable, 1000);
    assert.deepEqual(g.weeklyTokenFloorCauses, ['unrecorded-calls'], 'and the count is still a lower bound');
  });

  test('Qwen with no amount is not a floor — a zero count has no bound to be lower than', () => {
    assert.deepEqual(row(snap({ qwen: installed([]) }), 'qwen').weeklyTokenFloorCauses, [], 'scanned, zero');
    assert.deepEqual(row(snap(), 'qwen').weeklyTokenFloorCauses, [], 'not installed');
  });

  test('Grok is exact unless xAI marked a turn incomplete; a partial COST alone moves only the cost', () => {
    const exact = row(snap({ grok: installed([gkEv({ ts: NOW - DAY })]) }), 'grok');
    assert.deepEqual(exact.weeklyTokenFloorCauses, []);
    const costOnly = row(snap({ grok: installed([gkEv({ ts: NOW - DAY, partial: true })]) }), 'grok');
    assert.deepEqual(costOnly.weeklyTokenFloorCauses, [], 'the tokens were all recorded');
    assert.equal(costOnly.weeklyCost.partialUsageEvents, 1);
    const incomplete = row(snap({ grok: installed([gkEv({ ts: NOW - DAY, partial: true, incomplete: true })]) }), 'grok');
    assert.deepEqual(incomplete.weeklyTokenFloorCauses, ['partial-usage']);
  });

  test('Kimi is exact although every one of its models is unpriced', () => {
    const k = row(snap({ kimi: installed([kimiEv({ ts: NOW - DAY })]) }), 'kimi');
    assert.deepEqual(k.weeklyCost.unpricedModels, ['kimi-code/kimi-for-coding']);
    assert.deepEqual(k.weeklyTokenFloorCauses, [], 'no published price is not a missing token');
  });

  test('a known-unread range is the one thing that makes a Kimi count a floor', () => {
    const k = row(snap({
      kimi: installed([kimiEv({ ts: NOW - DAY })], { unreadRange: { fromMs: NOW - 3 * DAY, throughMs: NOW - 2 * DAY } }),
    }), 'kimi');
    assert.equal(k.weeklyCost.sourceIncomplete, true);
    assert.deepEqual(k.weeklyTokenFloorCauses, ['unread-range']);
  });
});
