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
      assert.equal(accent, '#6B7A77', JSON.stringify(attack));
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
      providers: ['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'kimi'].map((id, i) => ({
        id,
        displayName: id,
        accent: '#6B7A77',
        enabled: [undefined, null, 'false', 0, {}, NaN][i],
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
        accent: '#6B7A77',
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
        accent: '#6B7A77',
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
