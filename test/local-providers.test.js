'use strict';

/**
 * Gemini CLI and Kimi Code as providers (ADR-003 A6): rows, pending state,
 * experimental marker, history and the collector's worker channels.
 * Hermetic: fixed NOW, temp homes, no real ~/.gemini or ~/.kimi-code.
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

const gemEv = (over) => ({ ts: NOW - HOUR, model: 'gemini-2.5-pro', input: 6000, cached: 4000, output: 500, thoughts: 200, tool: 0, longPrompt: false, ...over });
const kimiEv = (over) => ({ ts: NOW - HOUR, model: 'kimi-code/kimi-for-coding', input: 1200, output: 300, cacheRead: 5000, cacheWrite: 100, ...over });

function snap(extra = {}) {
  return buildSnapshot({ now: NOW, events: [], rateLimits: null, codexEvents: [], scanOk: true, ...extra });
}
const row = (s, id) => s.providers.find((p) => p.id === id);

test.describe('the experimental marker (ADR-003 A6 decision 4)', () => {
  test('true for Gemini, Kimi and Copilot, false for every other provider, on every snapshot kind', () => {
    // Copilot: its AI-credit item fields are docs-only until a real, non-empty
    // reply has been read (2026-09-24).
    const expected = { claude: false, codex: false, gemini: true, copilot: true, antigravity: false, kimi: true };
    const installed = { installed: true, events: [], readFailed: false, resultAtMs: NOW, unreadRange: null };
    for (const s of [snap(), snap({ gemini: installed, kimi: installed }), loadingSnapshot(NOW)]) {
      const got = Object.fromEntries(s.providers.map((p) => [p.id, p.experimental]));
      assert.deepEqual(got, expected);
    }
    assert.deepEqual(Object.fromEntries(PROVIDERS.map((p) => [p.id, p.experimental])), expected);
  });
});

test.describe('Gemini and Kimi rows', () => {
  test('not installed: the passive "not installed" row, never pending, no figures', () => {
    const s = snap({ gemini: { installed: false, events: null }, kimi: undefined });
    for (const id of ['gemini', 'kimi']) {
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
    const s = snap({ gemini: pending, kimi: pending, codexEvents: null });
    assert.deepEqual(s.pendingUsage, ['codex', 'gemini', 'kimi']);
    for (const id of ['gemini', 'kimi']) {
      const r = row(s, id);
      assert.equal(r.connected, true);
      assert.equal(r.tokens, null);
      assert.equal(r.weeklyCost, null);
      assert.equal(r.lastGoodAt, null);
      assert.equal(r.setupAction, null);
    }
    assert.equal(s.usageHistory.usageProviders.length, 0, 'unread tools are not in the history');
  });

  test('installed Gemini: no invented windows, trailing-5h tokens, trailing-7d cost that is always a floor', () => {
    const s = snap({
      gemini: {
        installed: true,
        events: [gemEv({}), gemEv({ ts: NOW - 6 * HOUR, input: 1000000, cached: 0, output: 0, thoughts: 0 }), gemEv({ ts: NOW - 8 * DAY })],
        readFailed: false,
        resultAtMs: NOW - 1000,
        unreadRange: null,
      },
    });
    const r = row(s, 'gemini');
    assert.equal(r.status, 'ok');
    for (const w of [r.fiveHour, r.sevenDay]) {
      assert.deepEqual({ used: w.usedPercentage, certainty: w.certainty, absence: w.absence }, { used: null, certainty: 'unknown', absence: 'not-supplied' });
    }
    assert.deepEqual(r.tokens, { input: 6000, output: 700, cacheWrite: 0, cacheRead: 4000, billable: 6700 }, 'only the last 5 hours');
    assert.equal(r.weeklyCost.windowAnchored, false);
    assert.equal(r.weeklyCost.windowStart, new Date(NOW - 7 * DAY).toISOString());
    assert.equal(r.weeklyCost.totalUsd, 0.015 + 1.25, 'the 8-day-old message is outside the trailing week');
    assert.equal(r.weeklyCost.unrecordedCalls, true);
    assert.equal(r.weeklyCost.sourceIncomplete, false);
    assert.equal(r.lastGoodAt, new Date(NOW - 1000).toISOString());
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
      gemini: { installed: true, events: [gemEv({})], readFailed: true, resultAtMs: NOW - 10 * 60 * 1000, unreadRange: null },
      kimi: { installed: true, events: [], readFailed: false, resultAtMs: NOW, unreadRange: { fromMs: NOW - DAY, throughMs: NOW - DAY } },
    });
    assert.equal(row(s, 'gemini').weeklyCost.sourceIncomplete, true);
    assert.equal(row(s, 'gemini').status, 'ok', 'completeness never drives the row status');
    const k = row(s, 'kimi').weeklyCost;
    assert.equal(k.sourceIncomplete, true);
    assert.equal(k.totalUsd, 0);
    assert.equal(k.pricesAsOf, '');
    assert.deepEqual(s.usageHistory.incompleteProviders, ['gemini', 'kimi']);
  });
});

test.describe('history with Gemini and Kimi (Toplam Kullanım)', () => {
  const at = history.weekStartMs(NOW) + HOUR;

  test('each tool is tagged, Gemini dollars join the total, Kimi adds none, and the floors are OR-ed', () => {
    const out = history.usageHistory([], NOW, {
      codexEvents: [{ ts: at, model: 'gpt-5.6-sol', tier: 'standard', inputUncached: 10, cachedInput: 90, cacheWrite: 0, output: 10 }],
      geminiEvents: [gemEv({ ts: at }), gemEv({ ts: at, model: 'gemini-3-flash', input: 5 })],
      kimiEvents: [kimiEv({ ts: at })],
    });
    const week = out.weeks[0];
    assert.equal(week.isFloor, true);
    assert.deepEqual([...new Set(week.byModel.map((m) => m.provider))].sort(), ['codex', 'gemini', 'kimi']);
    const gem = week.byModel.find((m) => m.model === 'gemini-2.5-pro');
    assert.deepEqual({ cost: gem.costUsd, floor: gem.isFloor }, { cost: 0.015, floor: true });
    const kimi = week.byModel.find((m) => m.provider === 'kimi');
    assert.deepEqual({ cost: kimi.costUsd, floor: kimi.isFloor }, { cost: null, floor: false });
    const codex = week.byModel.find((m) => m.provider === 'codex');
    assert.ok(Math.abs(week.costUsd - (codex.costUsd + 0.015)) < 1e-9, 'Kimi and the unpriced Gemini alias add no dollars');
    assert.ok(week.unpricedModels.includes('kimi-code/kimi-for-coding') && week.unpricedModels.includes('gemini-3-flash'));

    assert.deepEqual(Object.keys(out.pricesAsOfByProvider).sort(), ['codex', 'gemini'], 'Kimi has no price date');
    assert.equal(out.pricesAsOfByProvider.gemini, '2026-09-16');
    assert.deepEqual(out.usageProviders, ['codex', 'gemini', 'kimi']);
    // Codex's cached read with 0 recorded writes is priced as an upper bound
    // since 2026-09-23, not a floor, so Codex names no cause.
    assert.equal(codex.isFloor, false);
    assert.deepEqual(out.floorCausesByProvider, {
      gemini: ['unpriced', 'unrecorded-calls'],
      kimi: ['unpriced'],
    });
  });

  test('Gemini long-prompt and tool causes are named; no Gemini usage, no Gemini date', () => {
    const out = history.usageHistory([], NOW, { geminiEvents: [gemEv({ ts: at, longPrompt: true, tool: 5 })] });
    assert.deepEqual(out.floorCausesByProvider, { gemini: ['unrecorded-calls', 'long-prompt', 'tool-tokens'] });
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

test.describe('the collector runs Gemini and Kimi scans off the main thread', () => {
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
      geminiHome: path.join(dir, 'gemini-home'),
      kimiHome: path.join(dir, 'kimi-home'),
      ...over,
    });
  }

  test('a tool that is not installed is never pending and never gets a worker', (t) => {
    const c = collector(tmpDir());
    t.after(() => c.stop());
    c._codexEvents = [];
    c._gemini.auto = true;
    c._kimi.auto = true;
    const s = c.rebuild();
    assert.deepEqual(s.pendingUsage, []);
    assert.equal(c._gemini.worker, null);
    assert.equal(c._kimi.worker, null);
    assert.equal(s.providers.find((p) => p.id === 'gemini').status, 'passive');
  });

  test('an installed tool is pending until its worker\'s first result, which rebuilds with its figures', { timeout: 20000 }, async (t) => {
    const dir = tmpDir();
    const now = Date.now();
    // Gemini: one chat (fixture shapes as in test/gemini-usage.test.js).
    const chats = path.join(dir, 'gemini-home', 'tmp', 'proj', 'chats');
    fs.mkdirSync(chats, { recursive: true });
    fs.writeFileSync(path.join(chats, 'session-2026-09-14T10-00-5f0c2a1e.jsonl'), [
      JSON.stringify({ sessionId: 's', projectHash: 'h', startTime: new Date(now).toISOString(), lastUpdated: new Date(now).toISOString() }),
      JSON.stringify({ id: 'm-1', timestamp: new Date(now - HOUR).toISOString(), type: 'gemini', content: 'x', thoughts: [], tokens: { input: 1000, output: 10, cached: 0, thoughts: 0, tool: 0, total: 1010 }, model: 'gemini-2.5-flash' }),
    ].join('\n') + '\n');
    // Kimi: one wire journal.
    const wire = path.join(dir, 'kimi-home', 'sessions', 'ws', 'session_1', 'agents', 'main', 'wire.jsonl');
    fs.mkdirSync(path.dirname(wire), { recursive: true });
    fs.writeFileSync(wire, JSON.stringify({ type: 'usage.record', agentId: 'main', model: 'kimi-code/k2', usage: { inputOther: 5, output: 5, inputCacheRead: 0, inputCacheCreation: 0 }, usageScope: 'turn', time: now - HOUR }) + '\n');

    const c = collector(dir);
    t.after(() => c.stop());
    c._codexEvents = [];
    c._dispatchCodexScan = () => {};
    assert.deepEqual(c.rebuild().pendingUsage, ['gemini', 'kimi'], 'installed, not read yet');

    const gem = new Promise((resolve) => c.once('gemini-scan', resolve));
    const kimi = new Promise((resolve) => c.once('kimi-scan', resolve));
    c._gemini.auto = true;
    c._kimi.auto = true;
    c._localTick(Date.now());
    assert.notEqual(c._gemini.worker, null, 'the scan runs in a worker');
    const [gs, ks] = await Promise.all([gem, kimi]);
    assert.equal(gs.files, 1);
    assert.equal(ks.files, 1);
    const s = c.snapshot;
    assert.deepEqual(s.pendingUsage, []);
    assert.equal(s.providers.find((p) => p.id === 'gemini').tokens.input, 1000);
    assert.equal(s.providers.find((p) => p.id === 'kimi').tokens.output, 5);
    assert.ok(s.usageHistory.usageProviders.includes('gemini') && s.usageHistory.usageProviders.includes('kimi'));

    // An unchanged rescan: the worker posts no events and the held array keeps
    // its identity, so the snapshot's history memo is reused (F3).
    const held = c._gemini.events;
    const history0 = c.snapshot.usageHistory;
    c._gemini.dispatchedAt = 0;
    const again = new Promise((resolve) => c.once('gemini-scan', resolve));
    c._gemini.request(Date.now());
    await again;
    assert.equal(c._gemini.events, held);
    assert.equal(c.snapshot.usageHistory, history0);

    c._gemini.stopWorker();
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
    const gem = { installed: true, events: [gemEv({})], resultAtMs: NOW, unreadRange: null };
    const input = (over = {}) => ({ now: NOW, events, rateLimits: null, codexEvents: codex, scanOk: true, gemini: gem, ...over });

    const first = buildSnapshot(input());
    const again = buildSnapshot(input({ now: NOW + 60 * 1000 }));
    assert.equal(calls(), 1, 'same arrays, same unread ranges, same week and month: reused');
    assert.equal(again.usageHistory, first.usageHistory);

    // 2026-09-14 is a Monday; a week later is the next local week.
    buildSnapshot(input({ now: history.weekStartMs(NOW) + 7 * DAY + HOUR }));
    assert.equal(calls(), 2, 'a new week invalidates');

    buildSnapshot(input({ gemini: { ...gem, events: [gemEv({}), gemEv({ ts: NOW - 2 * HOUR })] } }));
    assert.equal(calls(), 3, 'a new event array invalidates');

    buildSnapshot(input({ gemini: { ...gem, events: [gemEv({}), gemEv({ ts: NOW - 2 * HOUR })], unreadRange: { fromMs: NOW - DAY, throughMs: NOW - DAY } } }));
    assert.equal(calls(), 4, 'a new unread range invalidates');
  });

  test('sameEvents compares values in order, so an unchanged scan keeps its array identity', () => {
    const a = [gemEv({}), kimiEv({})];
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
    const events = Array.from({ length: 30 }, (_, i) => gemEv({ ts: NOW - HOUR + i, model: `unpriced-${String(i).padStart(2, '0')}` }));
    const s = snap({ gemini: { installed: true, events, resultAtMs: NOW } });
    const cost = row(s, 'gemini').weeklyCost;
    assert.equal(cost.byModel.length, 24);
    assert.equal(cost.unpricedModels.length, 24);
    const week = s.usageHistory.weeks[0];
    assert.equal(week.byModel.length, 24);
    assert.equal(week.unpricedModels.length, 24);
  });

  test('security F4: the Gemini, Kimi and Codex scan workers run with a bounded old generation', () => {
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
 * `ProviderSnapshot.weeklyTokens` on the two local-log rows.
 *
 * Neither tool publishes a weekly reset to us, so this window is always
 * trailing — and it must match the cost block on the same row, which already
 * says so through `windowAnchored: false`.
 */
test.describe('the Gemini and Kimi weekly token figure', () => {
  const installed = (events) => ({ installed: true, events, readFailed: false, resultAtMs: NOW, unreadRange: null });

  test('a trailing 7 days, half-open at the start, over the same window the cost block prices', () => {
    const s = snap({
      gemini: installed([
        gemEv({ ts: NOW - 7 * DAY - 1, output: 1_000_000 }),
        gemEv({ ts: NOW - 7 * DAY, output: 5, thoughts: 0, input: 0, cached: 0 }),
        gemEv({ ts: NOW - DAY, output: 6, thoughts: 0, input: 0, cached: 0 }),
      ]),
    });
    const g = row(s, 'gemini');
    assert.equal(g.weeklyTokens.output, 11, 'the ms before the start is out');
    assert.equal(g.weeklyCost.windowAnchored, false, 'Gemini publishes no weekly reset');
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
    assert.equal(row(snap(), 'gemini').weeklyTokens, null, 'not installed: no corpus');
    assert.equal(row(snap(), 'kimi').weeklyTokens, null, 'not installed: no corpus');
    const pending = snap({ gemini: { installed: true, events: null, resultAtMs: null } });
    assert.equal(row(pending, 'gemini').weeklyTokens, null, 'pending');
    assert.deepEqual(pending.pendingUsage, ['gemini'], 'and the snapshot says why it is null');
    // The state that used to read "could not be counted": installed, scanned,
    // and the user simply did not use the tool.
    const empty = snap({ gemini: installed([]) });
    assert.deepEqual(row(empty, 'gemini').weeklyTokens, { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, billable: 0 });
    assert.deepEqual(row(empty, 'gemini').weeklyTokenFloorCauses, [], 'a measured zero is not a floor');
    assert.equal(row(empty, 'gemini').tokens, null, 'the 5-hour field keeps its own shipped rule');
  });
});

/**
 * `weeklyTokenFloorCauses` on the two local-log rows (ADR-003 A6).
 *
 * Gemini CLI never records its utility calls or failed streams, so ANY Gemini
 * token figure is a lower bound — unconditionally, and in particular whether or
 * not the recorded messages could be priced. That last clause is the whole
 * point: `weeklyCost.unrecordedCalls` is a COST cause and goes false when
 * nothing priced, which would have left an all-unpriced Gemini week looking
 * exact. Kimi's recorder drops nothing, so only an unread range moves it.
 */
test.describe('the Gemini token floor cause is unconditional, and Kimi has none of its own', () => {
  const installed = (events, extra) => ({ installed: true, events, readFailed: false, resultAtMs: NOW, unreadRange: null, ...extra });

  test('Gemini with priced usage is a floor', () => {
    const g = row(snap({ gemini: installed([gemEv({ ts: NOW - DAY })]) }), 'gemini');
    assert.equal(g.weeklyCost.unrecordedCalls, true);
    assert.deepEqual(g.weeklyTokenFloorCauses, ['unrecorded-calls']);
  });

  test('Gemini whose week could not be priced AT ALL is still a floor — the gap F1 named', () => {
    // A message with tokens but no model: unpriced, so `unrecordedCalls` stays
    // false. The unrecorded utility calls happened all the same.
    const noModel = gemEv({ ts: NOW - DAY, model: 'unknown', noModel: true, input: 600, cached: 0, output: 400, thoughts: 0 });
    const g = row(snap({ gemini: installed([noModel]) }), 'gemini');
    assert.equal(g.weeklyCost.totalUsd, 0, 'nothing priced');
    assert.equal(g.weeklyCost.unrecordedCalls, false, 'the COST cause is off, unchanged');
    assert.equal(g.weeklyTokens.billable, 1000);
    assert.deepEqual(g.weeklyTokenFloorCauses, ['unrecorded-calls'], 'and the count is still a lower bound');
  });

  test('Gemini with no amount is not a floor — a zero count has no bound to be lower than', () => {
    assert.deepEqual(row(snap({ gemini: installed([]) }), 'gemini').weeklyTokenFloorCauses, [], 'scanned, zero');
    assert.deepEqual(row(snap(), 'gemini').weeklyTokenFloorCauses, [], 'not installed');
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
