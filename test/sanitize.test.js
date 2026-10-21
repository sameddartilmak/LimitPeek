'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

/**
 * `src/renderer/src/sanitize.ts` is the renderer's only gate on IPC input and
 * had no tests. It carries two jobs that fail silently when they regress:
 * keeping CSS injection out of the `--accent` custom property, and refusing to
 * let a malformed window drive a meter.
 *
 * Loaded from the TypeScript source (its only imports are type-only, so type
 * stripping leaves a standalone module) — no new dependency, no DOM needed.
 */
const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'src', 'renderer', 'src', 'sanitize.ts');

let s;
test.before(async () => {
  const js = stripTypeScriptTypes(fs.readFileSync(SOURCE, 'utf8'), { mode: 'strip' });
  s = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
});

function snapshotWith(claude) {
  return {
    generatedAt: '2026-09-08T15:00:00.000Z',
    providers: [{
      id: 'claude',
      displayName: 'Claude Code',
      accent: '#D97757',
      connected: true,
      status: 'ok',
      planLabel: null,
      fiveHour: null,
      sevenDay: null,
      tokens: null,
      burnRatePerHour: null,
      setupAction: null,
      ...claude,
    }],
  };
}

const claudeOf = (out) => out.providers.find((p) => p.id === 'claude');

test.describe('accent is a CSS custom property, so it is not free text', () => {
  test('a valid hex passes through unchanged', () => {
    for (const hex of ['#D97757', '#fff', '#ABCDEF']) {
      assert.equal(claudeOf(s.sanitizeSnapshot(snapshotWith({ accent: hex }))).accent, hex);
    }
  });

  test('anything that is not a bare hex falls back to the neutral ink', () => {
    const attacks = [
      '#fff; background: url(https://evil/x)',
      'red',
      'var(--x)',
      'expression(1)',
      '#12345',
      '',
      null,
      42,
    ];
    for (const attack of attacks) {
      const accent = claudeOf(s.sanitizeSnapshot(snapshotWith({ accent: attack }))).accent;
      assert.equal(accent, '#98989F', JSON.stringify(attack));
    }
  });
});

test.describe('a window must not drive a meter it cannot justify', () => {
  test("certainty 'unknown' always erases the percentage, whatever was sent", () => {
    const out = claudeOf(s.sanitizeSnapshot(snapshotWith({
      fiveHour: { usedPercentage: 62, certainty: 'unknown', resetsAt: '2026-09-08T20:00:00.000Z' },
    })));
    assert.equal(out.fiveHour.usedPercentage, null);
    assert.equal(out.fiveHour.certainty, 'unknown');
  });

  test("a 'known' window with no number is demoted to unknown, not drawn as zero", () => {
    for (const bad of [null, undefined, NaN, Infinity, 'sixty', {}]) {
      const out = claudeOf(s.sanitizeSnapshot(snapshotWith({
        fiveHour: { usedPercentage: bad, certainty: 'known', resetsAt: null },
      })));
      assert.equal(out.fiveHour.usedPercentage, null, JSON.stringify(bad));
      assert.equal(out.fiveHour.certainty, 'unknown', JSON.stringify(bad));
    }
  });

  test('an unrecognised certainty degrades to unknown rather than being trusted', () => {
    const out = claudeOf(s.sanitizeSnapshot(snapshotWith({
      fiveHour: { usedPercentage: 62, certainty: 'definitely', resetsAt: null },
    })));
    assert.equal(out.fiveHour.certainty, 'unknown');
    assert.equal(out.fiveHour.usedPercentage, null);
  });

  test("the 'awaiting-report' absence is a known cause and passes through as itself", () => {
    // A window with no figure but a stated absence: the sanitizer keeps the
    // cause so the renderer can print "yeni veri bekleniyor" rather than
    // degrading it to "bilinmiyor".
    const out = claudeOf(s.sanitizeSnapshot(snapshotWith({
      fiveHour: {
        usedPercentage: null,
        certainty: 'unknown',
        absence: 'awaiting-report',
        resetsAt: '2026-09-08T20:00:00.000Z',
      },
    })));
    assert.equal(out.fiveHour.usedPercentage, null);
    assert.equal(out.fiveHour.absence, 'awaiting-report');
  });

  test("an unrecognised absence still degrades to 'no-capture', the claim that asserts least", () => {
    const out = claudeOf(s.sanitizeSnapshot(snapshotWith({
      fiveHour: { usedPercentage: null, certainty: 'unknown', absence: 'uydurma', resetsAt: null },
    })));
    assert.equal(out.fiveHour.absence, 'no-capture');
  });

  test('an unparseable resetsAt becomes null instead of a NaN countdown', () => {
    const out = claudeOf(s.sanitizeSnapshot(snapshotWith({
      fiveHour: { usedPercentage: 62, certainty: 'known', resetsAt: 'yarın', capturedAt: 'dün' },
    })));
    assert.equal(out.fiveHour.resetsAt, null);
    assert.equal(out.fiveHour.capturedAt, null);
  });

  test('a negative billableSinceCapture is dropped, never shown as a negative delta', () => {
    const out = claudeOf(s.sanitizeSnapshot(snapshotWith({
      fiveHour: {
        usedPercentage: 62,
        certainty: 'known',
        resetsAt: '2026-09-08T20:00:00.000Z',
        capturedAt: '2026-09-08T14:00:00.000Z',
        billableSinceCapture: -500,
      },
    })));
    assert.equal(out.fiveHour.billableSinceCapture, null);
  });

  test('zero percent survives; it is a reading, not a missing value', () => {
    const out = claudeOf(s.sanitizeSnapshot(snapshotWith({
      fiveHour: { usedPercentage: 0, certainty: 'known', resetsAt: '2026-09-08T20:00:00.000Z' },
    })));
    assert.equal(out.fiveHour.usedPercentage, 0);
    assert.equal(out.fiveHour.certainty, 'known');
  });

  test('an out-of-range percentage is REJECTED and demotes the window to unknown', () => {
    // Was: clamped to 100 (qa F4). Clamping turned a nonsense 250 into a
    // confident, meter-drawing "%100" and defeated the defence-in-depth this
    // module claims. Rejecting lets the existing
    // `usedPercentage === null && certainty !== 'unknown'` branch demote the
    // window, and the renderer then draws no bar at all.
    for (const bad of [250, 101, -1, -0.5]) {
      const out = claudeOf(s.sanitizeSnapshot(snapshotWith({
        fiveHour: { usedPercentage: bad, certainty: 'known', resetsAt: '2026-08-08T20:00:00.000Z' },
      })));
      assert.equal(out.fiveHour.usedPercentage, null, String(bad));
      assert.equal(out.fiveHour.certainty, 'unknown', String(bad));
    }
  });

  test('the in-range boundaries survive rejection of everything outside them', () => {
    for (const good of [0, 0.5, 50, 99.6, 100]) {
      const out = claudeOf(s.sanitizeSnapshot(snapshotWith({
        fiveHour: { usedPercentage: good, certainty: 'known', resetsAt: '2026-08-08T20:00:00.000Z' },
      })));
      assert.equal(out.fiveHour.usedPercentage, good, String(good));
      assert.equal(out.fiveHour.certainty, 'known', String(good));
    }
  });
});

test.describe("the row's weekly token count crosses the boundary on its own terms", () => {
  const good = { input: 10, output: 20, cacheWrite: 30, cacheRead: 9000, billable: 60 };

  test('a well-formed weekly breakdown passes through, cacheRead kept as its own class', () => {
    const out = claudeOf(s.sanitizeSnapshot(snapshotWith({ weeklyTokens: good })));
    assert.deepEqual(out.weeklyTokens, good);
    assert.equal(out.weeklyTokens.cacheRead, 9000, 'never folded into billable');
  });

  test('a malformed weekly breakdown becomes null — the no-figure state, never a zero', () => {
    for (const bad of [{ billable: 'çok' }, { billable: -1 }, {}, 'yes', 7, null]) {
      const out = claudeOf(s.sanitizeSnapshot(snapshotWith({ weeklyTokens: bad })));
      assert.equal(out.weeklyTokens, null, JSON.stringify(bad));
    }
  });

  test('the two windows are validated independently: one bad field never relabels the other', () => {
    // Main states that `tokens` and `weeklyTokens` are null together. A producer
    // that breaks the invariant must lose the field it got wrong — the five-hour
    // count must not be promoted into a window it does not describe.
    const out = claudeOf(s.sanitizeSnapshot(snapshotWith({
      tokens: good,
      weeklyTokens: { billable: -5 },
    })));
    assert.deepEqual(out.tokens, good);
    assert.equal(out.weeklyTokens, null);
  });

  test('weeklyTokenFloorCauses carries main CAUSES, known codes only, never inferred here', () => {
    const out = claudeOf(s.sanitizeSnapshot(snapshotWith({
      weeklyTokens: good,
      weeklyTokenFloorCauses: ['unread-range', 'unread-range', 'nonsense'],
    })));
    assert.deepEqual(out.weeklyTokenFloorCauses, ['unread-range']);
  });

  test('anything that is not a list of known causes adds no floor claim', () => {
    // A floor is a claim; an older main that sends nothing must make none. And
    // because it is causes rather than a boolean, "a floor with no reason" — the
    // bare hedge ADR-002 A3.16 forbids — has no representation at all.
    for (const value of [undefined, null, true, 1, 'unread-range', {}, ['nope']]) {
      const out = claudeOf(s.sanitizeSnapshot(snapshotWith({ weeklyTokens: good, weeklyTokenFloorCauses: value })));
      assert.deepEqual(out.weeklyTokenFloorCauses, [], JSON.stringify(value));
    }
  });

  test('a measured ZERO week is carried as a zero, not turned into an absence', () => {
    // The defect this pins: an all-zero breakdown is our own successful reading
    // of a week with no usage. Dropping it to null here would make the panel say
    // "could not be counted" about a week we counted.
    const zero = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, billable: 0 };
    const out = claudeOf(s.sanitizeSnapshot(snapshotWith({ weeklyTokens: zero })));
    assert.deepEqual(out.weeklyTokens, zero);
    assert.notEqual(out.weeklyTokens, null);
  });
});

test.describe('provider identity cannot be invented by the payload', () => {
  test('an unknown provider id is dropped from the list entirely', () => {
    const out = s.sanitizeSnapshot({
      generatedAt: '2026-09-08T15:00:00.000Z',
      providers: [{ id: 'openai', displayName: 'OpenAI', accent: '#000' }],
    });
    assert.deepEqual(out.providers, []);
  });

  test('a bidi override in a display name is stripped before it reaches the DOM', () => {
    const out = claudeOf(s.sanitizeSnapshot(snapshotWith({ displayName: 'Cla‮ude' })));
    assert.equal(out.displayName, 'Claude');
  });

  test('a payload that is not a snapshot at all yields null, not a half-built one', () => {
    for (const bad of [null, undefined, 42, 'snapshot', [], { providers: 'many' }]) {
      assert.equal(s.sanitizeSnapshot(bad), null, JSON.stringify(bad));
    }
  });
});

test.describe('anchor geometry is all-or-nothing', () => {
  const okAnchor = {
    tray: { x: 1800, y: 1040, width: 24, height: 24 },
    anchorSource: 'tray',
    display: {
      id: 1,
      scaleFactor: 1.5,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    },
    window: { x: 1600, y: 700, width: 320, height: 340 },
    edge: 'bottom',
    mode: 'hover',
  };

  test('a complete anchor round-trips', () => {
    assert.deepEqual(s.sanitizeAnchor(okAnchor), okAnchor);
  });

  test('an absent or unrecognised anchorSource falls back to cursor, never tray', () => {
    // Failing toward 'cursor' makes the tail render dimmed. Defaulting to
    // 'tray' would silently claim we are pointing at a real icon when we were
    // never told that we are.
    for (const bad of [undefined, null, 'taskbar', 42]) {
      const { anchorSource, ...withoutSource } = okAnchor;
      const out = s.sanitizeAnchor(
        bad === undefined ? withoutSource : { ...okAnchor, anchorSource: bad },
      );
      assert.equal(out.anchorSource, 'cursor', JSON.stringify(bad));
    }
    assert.equal(s.sanitizeAnchor(okAnchor).anchorSource, 'tray');
  });

  test('a missing or non-finite rect rejects the whole anchor', () => {
    for (const key of ['tray', 'window']) {
      assert.equal(s.sanitizeAnchor({ ...okAnchor, [key]: undefined }), null, key);
      assert.equal(s.sanitizeAnchor({ ...okAnchor, [key]: { x: NaN, y: 0, width: 1, height: 1 } }), null, key);
    }
  });

  test('a zero or negative scaleFactor falls back to 1 rather than dividing by zero', () => {
    for (const bad of [0, -2, NaN, 'two', undefined]) {
      const out = s.sanitizeAnchor({ ...okAnchor, display: { ...okAnchor.display, scaleFactor: bad } });
      assert.equal(out.display.scaleFactor, 1, JSON.stringify(bad));
    }
  });

  test('an unrecognised edge or mode falls back rather than positioning off-screen', () => {
    const out = s.sanitizeAnchor({ ...okAnchor, edge: 'diagonal', mode: 'peek' });
    assert.equal(out.edge, 'bottom');
    assert.equal(out.mode, 'hover');
  });
});

/* --------------------------------------------------------------- enabled */

/**
 * `ProviderSnapshot.enabled` decides whether a row exists in the main panel at
 * all, so it is the one boolean in the payload whose wrong value costs the
 * user the whole list. The renderer's rule is deliberately asymmetric —
 * `source.enabled !== false` — and the asymmetry is the safety property: only
 * the exact boolean `false` may hide a row, because everything else (a main
 * process that predates the field, a string, a null) has to degrade to the
 * previous behaviour rather than to an empty panel that is indistinguishable
 * from "this machine has no tools".
 */
test.describe('enabled decides whether a row exists at all', () => {
  test('a payload with no enabled field at all still shows the row', () => {
    // The upgrade path: an older main process that never learnt the field.
    assert.equal(claudeOf(s.sanitizeSnapshot(snapshotWith({}))).enabled, true);
  });

  test('an explicit false is honoured, because that is the user saying so', () => {
    assert.equal(claudeOf(s.sanitizeSnapshot(snapshotWith({ enabled: false }))).enabled, false);
  });

  test('an explicit true is honoured', () => {
    assert.equal(claudeOf(s.sanitizeSnapshot(snapshotWith({ enabled: true }))).enabled, true);
  });

  test('nothing that is not the boolean false may hide a row', () => {
    // Every one of these is a producer bug. The failure direction has to be
    // "the row is still there", never "the panel is blank".
    const notFalse = [undefined, null, 0, '', 'false', 'no', NaN, [], {}, -0, 'FALSE'];
    for (const value of notFalse) {
      assert.equal(
        claudeOf(s.sanitizeSnapshot(snapshotWith({ enabled: value }))).enabled,
        true,
        `${JSON.stringify(value)} hid the row`,
      );
    }
  });

  test('a whole snapshot of malformed flags still renders something', () => {
    const raw = {
      generatedAt: '2026-09-08T15:00:00.000Z',
      providers: ['claude', 'codex', 'antigravity', 'kimi', 'qwen', 'grok'].map((id, i) => ({
        id,
        displayName: id,
        accent: '#98989F',
        enabled: [undefined, null, 'false', 0, NaN, ''][i],
        connected: false,
        status: 'passive',
        planLabel: null,
        fiveHour: null,
        sevenDay: null,
        tokens: null,
        burnRatePerHour: null,
        setupAction: null,
      })),
    };
    const out = s.sanitizeSnapshot(raw);
    assert.equal(out.providers.length, 6);
    assert.equal(out.providers.every((p) => p.enabled === true), true,
      'a corrupt producer must not be able to empty the panel');
  });

  test('main and the renderer cannot disagree about the shipped defaults', () => {
    // Main resolves enablement from settings and states a real boolean for
    // every id; the renderer re-reads it with a different rule. The two rules
    // only have to agree on the values main can actually emit, and this is
    // that set: booleans, for every provider in the registry.
    const { resolveEnabled } = require('../src/core/enabled');
    const { PROVIDER_IDS } = require('../src/core/providers');
    const resolved = resolveEnabled({});
    const raw = {
      generatedAt: '2026-09-08T15:00:00.000Z',
      providers: PROVIDER_IDS.map((id) => ({
        id,
        displayName: id,
        accent: '#98989F',
        enabled: resolved[id],
        connected: false,
        status: 'passive',
        planLabel: null,
        fiveHour: null,
        sevenDay: null,
        tokens: null,
        burnRatePerHour: null,
        setupAction: null,
      })),
    };
    const out = s.sanitizeSnapshot(raw);
    for (const provider of out.providers) {
      assert.equal(provider.enabled, resolved[provider.id],
        `${provider.id} survived the boundary with a different answer`);
    }
    assert.equal(out.providers.filter((p) => p.enabled).length, 1,
      'the shipped default is exactly one added provider');
  });

  test('a user who really turned everything off is not overridden', () => {
    // The other direction of the same rule: the sanitiser must not "repair" a
    // legitimately empty panel, or the settings view would stop working.
    const { resolveEnabled } = require('../src/core/enabled');
    const { PROVIDER_IDS } = require('../src/core/providers');
    const off = Object.fromEntries(PROVIDER_IDS.map((id) => [id, false]));
    const resolved = resolveEnabled(off);
    const raw = {
      generatedAt: '2026-09-08T15:00:00.000Z',
      providers: PROVIDER_IDS.map((id) => ({
        id,
        displayName: id,
        accent: '#98989F',
        enabled: resolved[id],
        connected: false,
        status: 'passive',
        planLabel: null,
        fiveHour: null,
        sevenDay: null,
        tokens: null,
        burnRatePerHour: null,
        setupAction: null,
      })),
    };
    const out = s.sanitizeSnapshot(raw);
    assert.equal(out.providers.length, 6, 'settings still needs every row');
    assert.equal(out.providers.some((p) => p.enabled), false);
  });
});

/* ----------------------------------------------------------- usage history */

/**
 * `usageHistory` is a new top-level field, and the renderer only ever sees the
 * OUTPUT of sanitizeSnapshot (bridge.ts sanitises every ingress). So the
 * sanitiser is the one thing standing between main's per-period figures and the
 * settings section — a field it does not carry is a section that never fills.
 */
function period(over) {
  return {
    key: '2026-09-07',
    startsAt: '2026-09-07T00:00:00.000Z',
    endsAt: '2026-09-13T00:00:00.000Z',
    costUsd: 12.34,
    byClass: { input: 1, output: 2, cacheWrite5m: 3, cacheWrite1h: 4, cacheRead: 5 },
    isFloor: false,
    unpricedModels: [],
    hasUsage: true,
    ...over,
  };
}
function historyWith(history) {
  return { generatedAt: '2026-09-09T15:00:00.000Z', providers: [], usageHistory: history };
}

test.describe('the per-period usage history survives the boundary', () => {
  test('an absent history is null, indistinguishable from an older main process', () => {
    const out = s.sanitizeSnapshot({ generatedAt: '2026-09-09T15:00:00.000Z', providers: [] });
    assert.equal(out.usageHistory, null);
  });

  test('a well-formed history passes through with its figures intact', () => {
    const out = s.sanitizeSnapshot(historyWith({
      weeks: [period({ costUsd: 12.34, isFloor: true })],
      months: [period({ key: '2026-09', costUsd: 40 })],
      pricesAsOf: '2026-06-24',
    }));
    assert.equal(out.usageHistory.weeks.length, 1);
    assert.equal(out.usageHistory.weeks[0].costUsd, 12.34);
    assert.equal(out.usageHistory.weeks[0].isFloor, true);
    assert.equal(out.usageHistory.months[0].costUsd, 40);
    assert.equal(out.usageHistory.pricesAsOf, '2026-06-24');
  });

  test('a period with no usable date range is dropped, not zeroed', () => {
    const out = s.sanitizeSnapshot(historyWith({
      weeks: [period({ startsAt: 'yarın' }), period({ endsAt: null }), period()],
      months: [],
      pricesAsOf: '2026-06-24',
    }));
    // Only the fully-dated period survives; an unlabelled range is not this shape.
    assert.equal(out.usageHistory.weeks.length, 1);
  });

  test('a negative cost is floored to zero, never shown as a credit', () => {
    const out = s.sanitizeSnapshot(historyWith({
      weeks: [period({ costUsd: -5 })],
      months: [],
      pricesAsOf: '2026-06-24',
    }));
    assert.equal(out.usageHistory.weeks[0].costUsd, 0);
  });

  test('isFloor and hasUsage admit only the boolean true, like every other flag here', () => {
    for (const truthy of ['true', 1, {}, 'yes']) {
      const out = s.sanitizeSnapshot(historyWith({
        weeks: [period({ isFloor: truthy, hasUsage: truthy })],
        months: [],
        pricesAsOf: '2026-06-24',
      }));
      assert.equal(out.usageHistory.weeks[0].isFloor, false, JSON.stringify(truthy));
      assert.equal(out.usageHistory.weeks[0].hasUsage, false, JSON.stringify(truthy));
    }
  });

  test('no merged token total can be smuggled in — the shape has nowhere to put one', () => {
    const out = s.sanitizeSnapshot(historyWith({
      weeks: [period({ billable: 999999, tokens: { billable: 999999 } })],
      months: [],
      pricesAsOf: '2026-06-24',
    }));
    const p = out.usageHistory.weeks[0];
    assert.equal('billable' in p, false);
    assert.equal('tokens' in p, false);
    // byClass carries dollars per class and no merged total.
    assert.equal('billable' in p.byClass, false);
  });

  test('an unparseable pricesAsOf becomes the "" not-reported sentinel, not a bad date', () => {
    const out = s.sanitizeSnapshot(historyWith({ weeks: [], months: [], pricesAsOf: 'dün' }));
    assert.equal(out.usageHistory.pricesAsOf, '');
  });

  test('pricesAsOfByProvider carries each known tool date that parses, and nothing else', () => {
    const out = s.sanitizeSnapshot(historyWith({
      weeks: [], months: [], pricesAsOf: '2026-06-24',
      pricesAsOfByProvider: { claude: '2026-06-24', codex: '2026-09-14', openai: '2026-01-01', kimi: 'dün' },
    }));
    assert.deepEqual(out.usageHistory.pricesAsOfByProvider, { claude: '2026-06-24', codex: '2026-09-14' });
  });

  test('a missing or malformed pricesAsOfByProvider is an empty map, not a dropped history', () => {
    for (const bad of [undefined, null, 'x', 42, ['2026-06-24']]) {
      const out = s.sanitizeSnapshot(historyWith({ weeks: [], months: [], pricesAsOf: '2026-06-24', pricesAsOfByProvider: bad }));
      assert.deepEqual(out.usageHistory.pricesAsOfByProvider, {}, JSON.stringify(bad));
      assert.equal(out.usageHistory.pricesAsOf, '2026-06-24');
    }
  });

  test('a garbage history collapses to null rather than half-rendering', () => {
    for (const bad of [42, 'history', true]) {
      assert.equal(s.sanitizeSnapshot(historyWith(bad)).usageHistory, null, JSON.stringify(bad));
    }
  });
});

test.describe('the per-model breakdown survives the boundary', () => {
  test('a well-formed byModel passes through, each entry with provider, model, cost and floor', () => {
    const out = s.sanitizeSnapshot(historyWith({
      weeks: [period({ byModel: [
        { provider: 'claude', model: 'claude-opus-5', costUsd: 200.5, isFloor: false },
        { provider: 'claude', model: 'claude-sonnet-5', costUsd: 12.25, isFloor: true },
      ] })],
      months: [],
      pricesAsOf: '2026-06-24',
    }));
    const byModel = out.usageHistory.weeks[0].byModel;
    assert.equal(byModel.length, 2);
    // `tokens` is NULL when no count arrived. The boundary type can express
    // "absent", so nothing has to mint an all-zero datum main never sends — and
    // the entry keeps its cost line, which is a true figure.
    assert.deepEqual(byModel[0], { provider: 'claude', model: 'claude-opus-5', costUsd: 200.5, isFloor: false, tokens: null });
    assert.deepEqual(byModel[1], { provider: 'claude', model: 'claude-sonnet-5', costUsd: 12.25, isFloor: true, tokens: null });
  });

  test('a per-model entry carries its own token breakdown, and a null cost does not blank it', () => {
    const out = s.sanitizeSnapshot(historyWith({
      weeks: [period({ byModel: [
        { provider: 'codex', model: 'codex-mini', costUsd: null, isFloor: false,
          tokens: { input: 10, output: 20, cacheWrite: 5, cacheRead: 900, billable: 35 } },
      ] })],
      months: [],
      pricesAsOf: '2026-06-24',
    }));
    const entry = out.usageHistory.weeks[0].byModel[0];
    // The asymmetry the contract is explicit about: the tokens were used
    // whether or not a price exists for them.
    assert.equal(entry.costUsd, null);
    assert.deepEqual(entry.tokens, { input: 10, output: 20, cacheWrite: 5, cacheRead: 900, billable: 35 });
  });

  test('an unreadable per-model breakdown becomes null, never a zero that would print', () => {
    const out = s.sanitizeSnapshot(historyWith({
      weeks: [period({ byModel: [
        { provider: 'claude', model: 'm1', costUsd: 5, isFloor: false, tokens: { billable: 'çok' } },
        { provider: 'claude', model: 'm2', costUsd: 5, isFloor: false, tokens: { billable: -4 } },
        { provider: 'claude', model: 'm3', costUsd: 5, isFloor: false },
      ] })],
      months: [],
      pricesAsOf: '2026-06-24',
    }));
    const entries = out.usageHistory.weeks[0].byModel;
    // All three keep their cost line — a missing count must not delete a true
    // figure — and all three say "no count" the only way that cannot be
    // confused with a measured zero.
    assert.equal(entries.length, 3);
    for (const entry of entries) {
      assert.equal(entry.tokens, null);
      assert.equal(entry.costUsd, 5);
    }
  });

  test('Claude and Codex entries share one list, each keeping its provider', () => {
    const out = s.sanitizeSnapshot(historyWith({
      weeks: [period({ byModel: [
        { provider: 'claude', model: 'claude-opus-5', costUsd: 20, isFloor: false },
        { provider: 'codex', model: 'gpt-5.6-sol', costUsd: 7.5, isFloor: false },
        { provider: 'codex', model: 'gpt-9-imaginary', costUsd: null, isFloor: false },
      ] })],
      months: [],
      pricesAsOf: '2026-06-24',
    }));
    const byModel = out.usageHistory.weeks[0].byModel;
    assert.deepEqual(byModel.map((e) => [e.provider, e.model, e.costUsd]), [
      ['claude', 'claude-opus-5', 20],
      ['codex', 'gpt-5.6-sol', 7.5],
      ['codex', 'gpt-9-imaginary', null],
    ]);
  });

  test('an entry with a missing or unknown provider is dropped, not guessed', () => {
    const out = s.sanitizeSnapshot(historyWith({
      weeks: [period({ byModel: [
        { model: 'no-provider', costUsd: 5, isFloor: false },
        { provider: 'openai', model: 'not-an-id', costUsd: 5, isFloor: false },
        { provider: 42, model: 'numeric', costUsd: 5, isFloor: false },
        { provider: 'codex', model: 'gpt-5.6-sol', costUsd: 5, isFloor: false },
      ] })],
      months: [],
      pricesAsOf: '2026-06-24',
    }));
    const byModel = out.usageHistory.weeks[0].byModel;
    assert.deepEqual(byModel.map((e) => e.model), ['gpt-5.6-sol']);
  });

  test('byModel defaults to an empty array when main omits it', () => {
    const out = s.sanitizeSnapshot(historyWith({
      weeks: [period()], months: [], pricesAsOf: '2026-06-24',
    }));
    assert.deepEqual(out.usageHistory.weeks[0].byModel, []);
  });

  test('a null cost survives as null — the "fiyatlanamadı" signal, never coerced to 0', () => {
    const out = s.sanitizeSnapshot(historyWith({
      weeks: [period({ byModel: [{ provider: 'claude', model: 'mystery-9', costUsd: null, isFloor: true }] })],
      months: [], pricesAsOf: '2026-06-24',
    }));
    assert.equal(out.usageHistory.weeks[0].byModel[0].costUsd, null);
  });

  test('a negative or non-finite cost becomes null (unpriced), never a shown figure', () => {
    for (const bad of [-5, NaN, Infinity, 'lots', undefined]) {
      const out = s.sanitizeSnapshot(historyWith({
        weeks: [period({ byModel: [{ provider: 'claude', model: 'm', costUsd: bad, isFloor: false }] })],
        months: [], pricesAsOf: '2026-06-24',
      }));
      assert.equal(out.usageHistory.weeks[0].byModel[0].costUsd, null, JSON.stringify(bad));
    }
  });

  test('an entry with no usable model name is dropped, not shown unlabelled', () => {
    const out = s.sanitizeSnapshot(historyWith({
      weeks: [period({ byModel: [
        { provider: 'claude', model: '', costUsd: 5, isFloor: false },
        { provider: 'claude', model: 42, costUsd: 5, isFloor: false },
        { provider: 'claude', model: 'claude-opus-5', costUsd: 5, isFloor: false },
      ] })],
      months: [], pricesAsOf: '2026-06-24',
    }));
    const byModel = out.usageHistory.weeks[0].byModel;
    assert.equal(byModel.length, 1);
    assert.equal(byModel[0].model, 'claude-opus-5');
  });

  test('isFloor on a per-model entry admits only the boolean true', () => {
    for (const truthy of ['true', 1, {}, 'yes']) {
      const out = s.sanitizeSnapshot(historyWith({
        weeks: [period({ byModel: [{ provider: 'claude', model: 'm', costUsd: 5, isFloor: truthy }] })],
        months: [], pricesAsOf: '2026-06-24',
      }));
      assert.equal(out.usageHistory.weeks[0].byModel[0].isFloor, false, JSON.stringify(truthy));
    }
  });

  test('a per-model count of ZERO survives as a measurement, not as an absence', () => {
    const zero = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, billable: 0 };
    const out = s.sanitizeSnapshot(historyWith({
      weeks: [period({ byModel: [
        { provider: 'claude', model: 'quiet', costUsd: 0, isFloor: false, tokens: zero },
      ] })],
      months: [], pricesAsOf: '2026-06-24',
    }));
    // Null and all-zero are different states and the boundary keeps them apart.
    assert.deepEqual(out.usageHistory.weeks[0].byModel[0].tokens, zero);
  });

  test('a per-model entry carries a BREAKDOWN and never a bare merged scalar', () => {
    // `tokens` is now a declared field, but it is a four-class breakdown with
    // `billable` computed by main — never a loose number on the entry itself.
    // A scalar `billable` beside it is exactly the merged shape the ADR bans,
    // and it still has nowhere to land.
    const out = s.sanitizeSnapshot(historyWith({
      weeks: [period({ byModel: [
        { provider: 'claude', model: 'm', costUsd: 5, isFloor: false,
          tokens: { input: 1, output: 2, cacheWrite: 3, cacheRead: 4, billable: 6 }, billable: 999 },
      ] })],
      months: [], pricesAsOf: '2026-06-24',
    }));
    const entry = out.usageHistory.weeks[0].byModel[0];
    assert.deepEqual(Object.keys(entry).sort(), ['costUsd', 'isFloor', 'model', 'provider', 'tokens']);
    assert.equal('billable' in entry, false);
    assert.equal(entry.tokens.billable, 6);
    // cacheRead is carried as its own class and is never folded into billable.
    assert.equal(entry.tokens.cacheRead, 4);
  });

  test('tokensByProvider is carried per tool, unknown keys dropped, and nothing is merged', () => {
    const out = s.sanitizeSnapshot(historyWith({
      weeks: [period({
        tokensByProvider: {
          claude: { input: 1, output: 1, cacheWrite: 1, cacheRead: 90, billable: 3 },
          codex: { input: 2, output: 2, cacheWrite: 2, cacheRead: 80, billable: 6 },
          // Not a provider this panel knows: it labels no row, so it is dropped.
          openai: { input: 9, output: 9, cacheWrite: 9, cacheRead: 9, billable: 27 },
          // Unreadable: DROPPED, not zeroed. No entry reads as "nothing to
          // show"; a zero would read as "this tool used nothing".
          qwen: { billable: 'çok' },
        },
      })],
      months: [], pricesAsOf: '2026-06-24',
    }));
    const p = out.usageHistory.weeks[0];
    assert.deepEqual(Object.keys(p.tokensByProvider).sort(), ['claude', 'codex']);
    assert.equal(p.tokensByProvider.claude.billable, 3);
    assert.equal(p.tokensByProvider.codex.billable, 6);
    // Still no merged total anywhere on the period.
    assert.equal('tokens' in p, false);
    assert.equal('billable' in p, false);
  });

  test('tokenFloorCausesByProvider is per tool, known codes only, and never inferred from isFloor', () => {
    const out = s.sanitizeSnapshot(historyWith({
      weeks: [
        period({ isFloor: true, tokenFloorCausesByProvider: {
          codex: ['unrecorded-writes', 'unrecorded-writes', 'not-a-cause'],
          openai: ['unread-range'],
          // A floor with NO reason is the bare hedge A3.16 forbids, so it must
          // not be representable: an empty list drops the tool entirely.
          claude: [],
        } }),
        period({ isFloor: true }),
      ],
      months: [], pricesAsOf: '2026-06-24',
    }));
    const first = out.usageHistory.weeks[0].tokenFloorCausesByProvider;
    assert.deepEqual(Object.keys(first), ['codex']);
    assert.deepEqual(first.codex, ['unrecorded-writes'], 'de-duplicated, unknown codes dropped');
    // A MONETARY cause is not a legal reason for a short COUNT: it counted every
    // token it saw. Offering one would be a false explanation, which is worse
    // than none, because A3.16 exists to make the reason trustworthy.
    const monetary = s.sanitizeSnapshot(historyWith({
      weeks: [period({ tokenFloorCausesByProvider: {
        claude: ['cache-write-ttl-fallback', 'unpriced', 'assumed-tier', 'fast-requested'],
        codex: ['unpriced', 'unrecorded-writes'],
      } })],
      months: [], pricesAsOf: '2026-06-24',
    }));
    const map = monetary.usageHistory.weeks[0].tokenFloorCausesByProvider;
    assert.deepEqual(Object.keys(map), ['codex'], 'a tool left with only monetary causes is dropped');
    assert.deepEqual(map.codex, ['unrecorded-writes']);
    // A period whose DOLLARS are a floor says nothing about its token counts.
    assert.deepEqual(out.usageHistory.weeks[1].tokenFloorCausesByProvider, {});
  });

  test('a byModel that is not an array degrades to empty, it does not drop the period', () => {
    const out = s.sanitizeSnapshot(historyWith({
      weeks: [period({ byModel: 'claude-opus-5' })],
      months: [], pricesAsOf: '2026-06-24',
    }));
    assert.equal(out.usageHistory.weeks.length, 1);
    assert.deepEqual(out.usageHistory.weeks[0].byModel, []);
  });
});

test.describe('a missing price tier is not a claim of the standard tier', () => {
  const costWith = (entry) => ({
    totalUsd: 1,
    byModel: [entry],
    unpricedModels: [],
    fallbackWriteEvents: 0,
    cacheWriteEvents: 0,
    unrecordedWriteEvents: 0,
    windowAnchored: false,
  });
  const tokens = { input: 1, output: 1, cacheWrite: 0, cacheRead: 0, billable: 2 };

  test("a missing or unusable ModelCost.speed becomes the neutral 'other', never 'standard'", () => {
    for (const speed of [undefined, null, '', '   ', 42]) {
      const out = s.sanitizeSnapshot(snapshotWith({
        weeklyCost: costWith({ model: 'gpt-5.6-sol', speed, pricedAs: null, usd: null, tokens }),
      }));
      const row = claudeOf(out).weeklyCost.byModel[0];
      assert.equal(row.speed, 'other', `speed ${JSON.stringify(speed)}`);
    }
  });

  test('a long-context tier code survives whole, so its reason is not cut off', () => {
    const out = s.sanitizeSnapshot(snapshotWith({
      weeklyCost: costWith({ model: 'gpt-5.5', speed: 'unknown-tier-long-context', pricedAs: null, usd: null, tokens }),
    }));
    assert.equal(claudeOf(out).weeklyCost.byModel[0].speed, 'unknown-tier-long-context');
  });
});

test.describe('WeeklyCost.sourceIncomplete (ADR-002 A3.15)', () => {
  const cost = (extra) => ({
    totalUsd: 1,
    byModel: [],
    unpricedModels: [],
    fallbackWriteEvents: 0,
    cacheWriteEvents: 0,
    unrecordedWriteEvents: 0,
    windowAnchored: false,
    ...extra,
  });

  test('a literal true survives: the reader stated it missed events', () => {
    const out = s.sanitizeSnapshot(snapshotWith({ weeklyCost: cost({ sourceIncomplete: true }) }));
    assert.equal(claudeOf(out).weeklyCost.sourceIncomplete, true);
  });

  test('absent (an older main) or anything but true reads as false, never as a floor', () => {
    for (const value of [undefined, false, null, 'true', 1, {}]) {
      const out = s.sanitizeSnapshot(snapshotWith({ weeklyCost: cost({ sourceIncomplete: value }) }));
      assert.equal(claudeOf(out).weeklyCost.sourceIncomplete, false, JSON.stringify(value));
    }
  });

  test('a stale row status does not make the cost source incomplete', () => {
    const out = s.sanitizeSnapshot(snapshotWith({ status: 'stale', weeklyCost: cost({}) }));
    assert.equal(claudeOf(out).status, 'stale');
    assert.equal(claudeOf(out).weeklyCost.sourceIncomplete, false);
  });
});

test.describe('Codex tier floors and history incompleteness (ADR-002 A3.20-21)', () => {
  const cost = (extra) => ({
    totalUsd: 1, byModel: [], unpricedModels: [], fallbackWriteEvents: 0,
    cacheWriteEvents: 0, unrecordedWriteEvents: 0, windowAnchored: false, ...extra,
  });

  test('assumedTierEvents and fastRequestedEvents survive as non-negative integers', () => {
    const out = s.sanitizeSnapshot(snapshotWith({ weeklyCost: cost({ assumedTierEvents: 24, fastRequestedEvents: 1 }) }));
    assert.equal(claudeOf(out).weeklyCost.assumedTierEvents, 24);
    assert.equal(claudeOf(out).weeklyCost.fastRequestedEvents, 1);
  });

  test('anything but a non-negative integer count reads as 0, never inventing a floor', () => {
    for (const value of [undefined, null, -1, 1.5, '3', NaN, Infinity]) {
      const out = s.sanitizeSnapshot(snapshotWith({ weeklyCost: cost({ assumedTierEvents: value, fastRequestedEvents: value }) }));
      assert.equal(claudeOf(out).weeklyCost.assumedTierEvents, 0, String(value));
      assert.equal(claudeOf(out).weeklyCost.fastRequestedEvents, 0, String(value));
    }
  });

  test('incompleteProviders keeps known ids only, each once; absent is []', () => {
    const base = { weeks: [], months: [], pricesAsOf: '2026-06-24' };
    const out = s.sanitizeSnapshot(historyWith({ ...base, incompleteProviders: ['codex', 'bogus', 'codex', 42, 'claude'] }));
    assert.deepEqual(out.usageHistory.incompleteProviders, ['codex', 'claude']);
    for (const bad of [undefined, null, 'codex', {}]) {
      const o = s.sanitizeSnapshot(historyWith({ ...base, incompleteProviders: bad }));
      assert.deepEqual(o.usageHistory.incompleteProviders, [], JSON.stringify(bad));
    }
  });
});
