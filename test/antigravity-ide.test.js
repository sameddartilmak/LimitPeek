'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  readAntigravityIdeQuota,
  clearDecodeCache,
} = require('../src/core/antigravity/ide-quota');
const {
  antigravityIdeCandidates,
  resolveAntigravityIdeStore,
} = require('../src/core/antigravity/install');
const { buildSnapshot } = require('../src/core/snapshot');
const { MAX_AGE_MS } = require('../src/core/ratelimits');
const { IDE_MAX_AGE_MS } = require('../src/core/antigravity/ide-quota');
const { isAntigravityRunning, anyAntigravityImage } = require('../src/core/antigravity/process');
const { Collector, DEBOUNCE_MS } = require('../src/core/collector');
const { buildTooltip } = require('../src/core/tray-tooltip');
const store = require('./helpers/agy-store');

/**
 * The Antigravity IDE state store — the one undocumented interface this
 * codebase reads, and the guards that were the condition of reading it.
 *
 * The failure that produced those guards happened to us. The product renamed
 * its install directory from `Antigravity` to `Antigravity IDE`; a hard-coded
 * path kept resolving to the abandoned one; and the read returned a
 * 112-day-old snapshot AS IF IT WERE CURRENT. Everything below is either a
 * guard against that class of defect or a check that the guard did not cost us
 * a legitimate reading.
 *
 * Nothing here touches the real %APPDATA%. Every store is synthesised into a
 * temp directory by `helpers/agy-store.js`, which is a hand-written protobuf
 * ENCODER precisely so the drift cases — a renumbered field, a second float, a
 * double where a float32 belongs — can be produced at all.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-09T09:00:00.000Z');
const RESET = Math.floor((NOW + 4.8 * HOUR) / 1000);

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-agyide-'));
}

/** One model with a quota, shaped like the live store's entries. */
function model(name, fraction, resetSeconds = RESET, over = {}) {
  return { name, fraction, resetSeconds, ...over };
}

/** An AppData-like directory holding one install. */
function appData(installs) {
  const base = tmpdir();
  for (const [name, spec] of Object.entries(installs)) {
    store.writeInstall(path.join(base, name), spec.models, spec);
  }
  return base;
}

function read(base, over = {}) {
  clearDecodeCache();
  return readAntigravityIdeQuota({ appDataDir: base, now: NOW, ...over });
}

function agRow(ide, cli) {
  const snap = buildSnapshot({
    now: NOW,
    events: [],
    rateLimits: { state: 'missing' },
    scanOk: true,
    antigravityQuota: cli || { state: 'missing', fiveHour: null, sevenDay: null },
    antigravityIde: ide,
  });
  return snap.providers.find((p) => p.id === 'antigravity');
}

/* ------------------------------------------------- GUARD 1: which install */

test.describe('GUARD 1 — the install is resolved, never named', () => {
  test('the newest store wins, and the abandoned one is ignored', () => {
    // The exact defect, reproduced: two installs, the older one bearing the
    // name a hard-coded path would have used, and a nearly-exhausted quota
    // sitting in it. Reading the wrong one would put "%60 used" on the row
    // out of a store nobody has written since May.
    const base = appData({
      Antigravity: { models: [model('Gemini 3.1 Pro (High)', 0.4)], mtimeMs: NOW - 112 * DAY },
      'Antigravity IDE': { models: [model('Gemini 3.1 Pro (High)', 1)], mtimeMs: NOW - 60 * 1000 },
    });

    const chosen = resolveAntigravityIdeStore(base);
    assert.equal(chosen.name, 'Antigravity IDE');
    assert.equal(chosen.candidates.length, 2, 'both were seen; one was preferred');

    const q = read(base);
    assert.equal(q.state, 'fresh');
    assert.equal(q.fiveHour.usedPercentage, 0, 'the live store, not the abandoned one');
    assert.equal(q.install.name, 'Antigravity IDE');
  });

  test('a future rename is a no-op, because no directory name is trusted', () => {
    // The point of the guard: the next rename must not need a code change.
    const base = appData({
      'Antigravity IDE': { models: [model('A', 1)], mtimeMs: NOW - 30 * DAY },
      'Antigravity Studio 3': { models: [model('A', 0.5)], mtimeMs: NOW - 60 * 1000 },
    });
    const q = read(base);
    assert.equal(q.install.name, 'Antigravity Studio 3');
    assert.equal(q.fiveHour.usedPercentage, 50);
  });

  test('a directory with no store is not a candidate', () => {
    const base = tmpdir();
    fs.mkdirSync(path.join(base, 'Antigravity IDE', 'User', 'globalStorage'), { recursive: true });
    fs.mkdirSync(path.join(base, 'Antigravity Leftovers'), { recursive: true });
    assert.deepEqual(antigravityIdeCandidates(base), []);
    assert.equal(read(base).state, 'missing');
  });

  test('no install at all is `missing`, and the row offers setup rather than an error', () => {
    const q = read(tmpdir());
    assert.equal(q.state, 'missing');
    assert.equal(q.reason, 'no-install');
    const ag = agRow(q);
    assert.equal(ag.status, 'passive');
    assert.equal(ag.setupAction.kind, 'install-bridge');
  });

  test('the candidate order is total, so two runs cannot disagree', () => {
    const base = appData({
      'Antigravity A': { models: [model('A', 1)], mtimeMs: NOW - 1000 },
      'Antigravity B': { models: [model('B', 1)], mtimeMs: NOW - 1000 },
    });
    const first = antigravityIdeCandidates(base).map((c) => c.name);
    const second = antigravityIdeCandidates(base).map((c) => c.name);
    assert.deepEqual(first, second);
    assert.deepEqual(first, ['Antigravity A', 'Antigravity B'], 'name breaks an mtime tie');
  });
});

/* ---------------------------------------------------- GUARD 2: staleness */

test.describe('GUARD 2 — a stale store keeps its figure; an abandoned one shows nothing', () => {
  // The rule this block used to state was "a stale store yields no percentage,
  // ever". That overstated it in the direction that costs the user something
  // real: with the IDE closed, the last five-hour figure is still a TRUE
  // statement about its window until that window resets, and refusing to show
  // it threw away the only number they had. What must never happen is an
  // ABANDONED install being read as current — which is a different thing, and
  // is what the age ceiling and the newest-store resolver are for.

  test('the 112-day-old store is refused outright, figure and all', () => {
    // The original defect: a real figure, correctly decoded, from a window
    // that closed sixteen weeks ago. Past the ceiling nothing is shown — not
    // the figure, not a stale label, nothing to reason about.
    const base = appData({
      Antigravity: { models: [model('Gemini 3.1 Pro (High)', 0.4, Math.floor((NOW - 112 * DAY + 4 * HOUR) / 1000))], mtimeMs: NOW - 112 * DAY },
    });
    const q = read(base);
    assert.equal(q.state, 'absent');
    assert.equal(q.reason, 'abandoned');
    assert.equal(q.fiveHour, null, 'the reader does not even carry it');
    assert.deepEqual(q.groups, []);

    const ag = agRow(q);
    assert.equal(ag.fiveHour.usedPercentage, null, 'no number reaches the row');
    assert.equal(ag.fiveHour.certainty, 'unknown');
    assert.equal(ag.modelQuotas, null, 'nor does the detail block smuggle the same numbers back in');
  });

  test('the ceiling is a week, which no five-hour window can reach', () => {
    // Sized so that nothing inside it could still be describing an open
    // window by accident: the longest window this source has is five hours.
    assert.ok(IDE_MAX_AGE_MS > 5 * HOUR * 2, `${IDE_MAX_AGE_MS} must dwarf the window it guards`);

    const justInside = appData({
      'Antigravity IDE': {
        models: [model('A', 0.25, Math.floor((NOW + HOUR) / 1000))],
        mtimeMs: NOW - (IDE_MAX_AGE_MS - HOUR),
      },
    });
    assert.equal(read(justInside).state, 'stale', 'inside the ceiling it is merely old');

    const justOutside = appData({
      'Antigravity IDE': {
        models: [model('A', 0.25, Math.floor((NOW + HOUR) / 1000))],
        mtimeMs: NOW - (IDE_MAX_AGE_MS + HOUR),
      },
    });
    const out = read(justOutside);
    assert.equal(out.state, 'absent');
    assert.equal(out.reason, 'abandoned');
  });

  test('a clock that jumped backwards cannot resurrect an old store', () => {
    // A capture from the far future is as untrustworthy as one from the far
    // past, and the ceiling is applied in both directions for that reason.
    const base = appData({
      'Antigravity IDE': { models: [model('A', 0.25)], mtimeMs: NOW + IDE_MAX_AGE_MS + HOUR },
    });
    const q = read(base);
    assert.equal(q.state, 'absent');
    assert.equal(q.reason, 'abandoned');
  });

  test('IDE closed for hours: the last figure is kept, labelled with its age', () => {
    // What the user asked for, and the condition under which it is honest.
    // The IDE is shut, so nothing is writing the store; the window it
    // describes is still open, so the number is still true of it.
    const captured = NOW - 3 * HOUR;
    const base = appData({
      'Antigravity IDE': {
        models: [model('Claude Opus 4.6 (Thinking)', 0.35, Math.floor((NOW + 90 * 60 * 1000) / 1000))],
        mtimeMs: captured,
      },
    });
    const q = read(base);
    assert.equal(q.state, 'stale');

    const ag = agRow(q);
    assert.equal(ag.fiveHour.usedPercentage, 65, 'the last known figure survives');
    assert.equal(ag.fiveHour.certainty, 'known');
    assert.equal(ag.status, 'stale', 'never presented as current');
    assert.equal(
      ag.fiveHour.capturedAt, new Date(captured).toISOString(),
      'and it says WHEN, which is what the row prints as "… önce güncellendi"',
    );
    // The per-model block is the same reading seen a second way, so it rides
    // along — with the same capturedAt, not a fresher-looking one.
    assert.equal(ag.modelQuotas.capturedAt, new Date(captured).toISOString());
  });

  test('IDE closed past the reset: the old figure is dropped, not re-printed', () => {
    // The moment it stops being true. An hour after the window closed, the
    // number describes a window that no longer exists.
    const base = appData({
      'Antigravity IDE': {
        models: [model('A', 0.35, Math.floor((NOW - HOUR) / 1000))],
        mtimeMs: NOW - 3 * HOUR,
      },
    });
    const ag = agRow(read(base));
    assert.equal(ag.fiveHour.usedPercentage, null);
    assert.equal(ag.fiveHour.absence, 'rolled-over', 'the window reset; say so');
    assert.equal(ag.modelQuotas, null);
  });

  test('the store mtime IS the capture instant, so there is one staleness rule', () => {
    const base = appData({ 'Antigravity IDE': { models: [model('A', 0.5)], mtimeMs: NOW - 5000 } });
    const q = read(base);
    assert.equal(q.capturedAt, new Date(NOW - 5000).toISOString());
    assert.equal(q.ageMs, 5000);
  });

  test('a store just past the freshness budget is stale but still true of its window', () => {
    // The other half of ADR-001 amendment 2: staleness alone does not delete a
    // reading about a window that has not reset. The IDE is simply closed.
    const base = appData({
      'Antigravity IDE': { models: [model('A', 0.25)], mtimeMs: NOW - (MAX_AGE_MS + HOUR) },
    });
    const q = read(base);
    assert.equal(q.state, 'stale');
    const ag = agRow(q);
    assert.equal(ag.fiveHour.usedPercentage, 75, 'the window is still open, so the figure stands');
    assert.equal(ag.status, 'stale');
    assert.equal(ag.fiveHour.capturedAt, new Date(NOW - (MAX_AGE_MS + HOUR)).toISOString());
  });

  test('a fresh store whose window has already reset shows nothing', () => {
    // Rollover dominates freshness, exactly as it does for Claude.
    const base = appData({
      'Antigravity IDE': {
        models: [model('A', 0.02, Math.floor((NOW - 30 * 1000) / 1000))],
        mtimeMs: NOW - 60 * 1000,
      },
    });
    const q = read(base);
    assert.equal(q.state, 'fresh');
    const ag = agRow(q);
    assert.equal(ag.fiveHour.usedPercentage, null);
    assert.equal(ag.fiveHour.absence, 'rolled-over');
    assert.equal(ag.status, 'stale');
  });
});

/* -------------------------------------------- GUARD 3a: strict decoding */

test.describe('GUARD 3a — structural drift fails closed', () => {
  function refuses(spec, why) {
    const base = appData({ 'Antigravity IDE': { ...spec, mtimeMs: NOW - 1000 } });
    const q = read(base);
    assert.equal(q.state, 'absent', why);
    assert.equal(q.reason, 'schema', why);
    assert.equal(q.fiveHour, null, why);
    return q;
  }

  test('a renumbered fraction field is refused, not read from wherever it lands', () => {
    // THE case this guard exists for. A documented JSON field fails closed
    // when it is renamed; a field-numbered wire format fails OPEN, because
    // some other value decodes in its place, lands in [0,1], and passes every
    // range guard we have. Refusing is the only thing that can catch it.
    const q = refuses({ models: [model('A', 0.5, RESET, { fractionField: 4 })] }, 'renumbered fraction');
    assert.match(q.schemaError, /shape/);
  });

  test('a second float beside the fraction is refused rather than guessed between', () => {
    // A `used_fraction` appearing next to `remaining_fraction` is the shape
    // where picking one would be a coin flip presented as a fact.
    refuses({ models: [model('A', 0.5, RESET, { extraFloat: 0.5 })] }, 'extra float');
  });

  test('a double where a float32 belongs is refused', () => {
    // Same bytes, different wire type: silently accepting it would mean the
    // decoder no longer knows what it is looking at.
    refuses({ models: [model('A', 0.5, RESET, { asDouble: true })] }, 'wrong wire type');
  });

  test('a renumbered model container is refused', () => {
    refuses({ models: [model('A', 0.5)], listField: 34 }, 'renumbered container');
  });

  test('a missing model container is refused', () => {
    refuses({ models: [model('A', 0.5)], omitList: true }, 'missing container');
  });

  test('a renamed sentinel key is refused', () => {
    refuses({ models: [model('A', 0.5)], sentinel: 'somethingElseSentinelKey' }, 'renamed sentinel');
  });

  test('a refusal is a stated absence, not an error with a useless retry', () => {
    const base = appData({
      'Antigravity IDE': { models: [model('A', 0.5, RESET, { fractionField: 4 })], mtimeMs: NOW - 1000 },
    });
    const ag = agRow(read(base));
    assert.equal(ag.status, 'ok', 'nothing failed');
    assert.equal(ag.errorCode, undefined, 'and retrying cannot change a shape we do not recognise');
    assert.equal(ag.fiveHour.usedPercentage, null);
    assert.equal(ag.fiveHour.absence, 'unreadable');
  });

  test('a fraction outside 0..1 is refused, never clamped', () => {
    refuses({ models: [model('A', 1.4)] }, 'fraction over 1');
  });

  test('a reset instant that is not a plausible unix second is refused', () => {
    // Milliseconds pasted into a seconds field is the classic version of this,
    // and it lands 50,000 years out where every horizon check passes.
    refuses({ models: [model('A', 0.5, NOW)] }, 'milliseconds in a seconds field');
  });

  test('fields the decoder does not read do not make it refuse', () => {
    // Strictness must not mean brittleness: the account envelope and the model
    // entries carry siblings we ignore, and they change without notice.
    const base = appData({ 'Antigravity IDE': { models: [model('A', 0.5, RESET, { tier: 'Fast' })], mtimeMs: NOW - 1000 } });
    const q = read(base);
    assert.equal(q.state, 'fresh');
    assert.equal(q.fiveHour.usedPercentage, 50);
  });

  test('a model with no quota block is skipped, not refused', () => {
    const base = appData({
      'Antigravity IDE': {
        models: [{ name: 'No quota', noQuota: true }, model('Has quota', 0.5)],
        mtimeMs: NOW - 1000,
      },
    });
    const q = read(base);
    assert.equal(q.state, 'fresh');
    assert.equal(q.modelsSeen, 1);
    assert.deepEqual(q.groups[0].members, ['Has quota']);
  });

  test('a store with no models carrying a quota states an absence', () => {
    const base = appData({
      'Antigravity IDE': { models: [{ name: 'No quota', noQuota: true }], mtimeMs: NOW - 1000 },
    });
    const q = read(base);
    assert.equal(q.state, 'absent');
    assert.equal(q.reason, 'no-quota');
    assert.equal(agRow(q).status, 'ok');
  });

  test('a store missing the key entirely is an absence, not a crash', () => {
    const base = tmpdir();
    store.writeStore(path.join(base, 'Antigravity IDE'), null, { mtimeMs: NOW - 1000 });
    const q = read(base);
    assert.equal(q.state, 'absent');
    assert.equal(q.reason, 'no-key');
  });

  test('a file that is not a database at all is invalid, not a partial reading', () => {
    const base = tmpdir();
    const dir = path.join(base, 'Antigravity IDE', 'User', 'globalStorage');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.vscdb'), 'this is not sqlite');
    const q = read(base);
    assert.equal(q.state, 'invalid');
    assert.equal(q.fiveHour, null);
  });
});

/* -------------------------------------------- divergence and the groups */

test.describe('per-model detail: de-duplication, never a claim about models', () => {
  const DIVERGED = [
    model('Claude Opus 4.6 (Thinking)', 0.4),
    model('Claude Sonnet 4.6 (Thinking)', 0.4),
    model('Gemini 3.1 Pro (High)', 1),
    model('Gemini 3.6 Flash (Low)', 1),
  ];

  test('identical (fraction, reset) pairs collapse into one group', () => {
    const base = appData({ 'Antigravity IDE': { models: DIVERGED, mtimeMs: NOW - 1000 } });
    const q = read(base);
    assert.equal(q.groups.length, 2);
    assert.deepEqual(q.groups.map((g) => g.usedPercentage), [60, 0], 'most consumed first');
    assert.deepEqual(q.groups[0].members, ['Claude Opus 4.6 (Thinking)', 'Claude Sonnet 4.6 (Thinking)']);
    assert.deepEqual(q.groups[1].members, ['Gemini 3.1 Pro (High)', 'Gemini 3.6 Flash (Low)']);
  });

  test('divergence is computed in main, because the renderer may not compare figures', () => {
    const base = appData({ 'Antigravity IDE': { models: DIVERGED, mtimeMs: NOW - 1000 } });
    assert.equal(read(base).diverged, true);

    const same = appData({
      'Antigravity IDE': { models: [model('A', 1), model('B', 1), model('C', 1)], mtimeMs: NOW - 1000 },
    });
    const q = read(same);
    assert.equal(q.diverged, false);
    assert.equal(q.groups.length, 1);
    assert.equal(q.groups[0].members.length, 3);
  });

  test('the same fraction at a different reset is a different group', () => {
    // Grouping is on the PAIR. Two models at 50% whose windows close at
    // different instants are two facts, not one.
    const base = appData({
      'Antigravity IDE': {
        models: [model('A', 0.5, RESET), model('B', 0.5, RESET + 600)],
        mtimeMs: NOW - 1000,
      },
    });
    const q = read(base);
    assert.equal(q.groups.length, 2);
    assert.equal(q.diverged, true);
  });

  test('the row figure is the MOST consumed group, which errs pessimistic', () => {
    const base = appData({ 'Antigravity IDE': { models: DIVERGED, mtimeMs: NOW - 1000 } });
    const ag = agRow(read(base));
    assert.equal(ag.fiveHour.usedPercentage, 60, 'not the roomier 0%');
  });

  test('no structure pairs a model name with a percentage', () => {
    // The rule is enforced by SHAPE, not by a styling convention: the figure
    // lives on the group and members are bare strings. That is what makes
    // "Claude Opus 4.6 · %60" unconstructible — a string that would sit
    // directly beneath the user's real Claude Code row and read as a statement
    // about Claude's own quota.
    const base = appData({ 'Antigravity IDE': { models: DIVERGED, mtimeMs: NOW - 1000 } });
    const ag = agRow(read(base));
    for (const group of ag.modelQuotas.groups) {
      assert.equal(typeof group.usedPercentage, 'number');
      for (const member of group.members) {
        assert.equal(typeof member, 'string');
        assert.equal(/[0-9]+\s*%|%\s*[0-9]+/.test(member), false, `member carries a figure: ${member}`);
      }
    }
    assert.equal(ag.modelQuotas.diverged, true);
    assert.equal(ag.modelQuotas.provenance, 'derived');
    assert.equal(ag.modelQuotas.source, 'antigravity.ide.quota_info.remaining_fraction');
  });

  test('model names are stripped of control and bidi characters', () => {
    const base = appData({
      'Antigravity IDE': { models: [model('Gem‮ini 3.1 Pro', 0.5)], mtimeMs: NOW - 1000 },
    });
    const q = read(base);
    assert.deepEqual(q.groups[0].members, ['Gemini 3.1 Pro']);
  });
});

/* ------------------------------------------ what the row says about trust */

test.describe('the row carries where each figure came from', () => {
  test('the IDE figure is `derived` and names the field it was decoded from', () => {
    const base = appData({ 'Antigravity IDE': { models: [model('A', 0.25)], mtimeMs: NOW - 1000 } });
    const ag = agRow(read(base));
    assert.equal(ag.fiveHour.usedPercentage, 75);
    assert.equal(ag.fiveHour.certainty, 'known');
    // `known` and `derived` are orthogonal: the number is server-computed, and
    // the interface it came through can change without telling anyone.
    assert.equal(ag.fiveHour.provenance, 'derived');
    assert.equal(ag.fiveHour.source, 'antigravity.ide.quota_info.remaining_fraction');
  });

  test('a documented CLI figure sits beside a derived one without averaging their trust', () => {
    const base = appData({ 'Antigravity IDE': { models: [model('A', 0.25)], mtimeMs: NOW - 1000 } });
    const cli = {
      state: 'fresh',
      capturedAt: new Date(NOW - 1000).toISOString(),
      capturedAtMs: NOW - 1000,
      ageMs: 1000,
      fiveHour: null,
      sevenDay: { usedPercentage: 10, resetsAtMs: NOW + 5 * DAY },
    };
    const ag = agRow(read(base), cli);
    assert.equal(ag.fiveHour.provenance, 'derived');
    assert.equal(ag.sevenDay.provenance, 'documented');
    assert.equal(ag.sevenDay.source, 'antigravity.cli.quota.remaining_fraction');
    assert.equal(ag.status, 'ok');
  });

  test('sevenDay is an unknown window, never null, and says it is not reported', () => {
    // null would assert this provider HAS no weekly limit. The user can see
    // one in Antigravity's own UI, so that claim is falsifiable on their
    // screen — the worst kind of wrong. "There is one and this source does not
    // carry it" is true, and it is what `not-supplied` means.
    const base = appData({ 'Antigravity IDE': { models: [model('A', 0.25)], mtimeMs: NOW - 1000 } });
    const ag = agRow(read(base));
    assert.notEqual(ag.sevenDay, null);
    assert.equal(ag.sevenDay.usedPercentage, null);
    assert.equal(ag.sevenDay.certainty, 'unknown');
    assert.equal(ag.sevenDay.absence, 'not-supplied');
  });

  test('the tooltip says "bildirilmiyor" for a window nobody reports', () => {
    // Distinct from `bilinmiyor`. Saying "unknown" about a limit the user can
    // see on another screen makes every honest "unknown" less believable.
    const base = appData({ 'Antigravity IDE': { models: [model('A', 0.25)], mtimeMs: NOW - 1000 } });
    const snap = {
      generatedAt: new Date(NOW).toISOString(),
      providers: [{ ...agRow(read(base)), enabled: true }],
    };
    const tip = buildTooltip(snap, NOW);
    assert.match(tip, /Haftalık limit: bildirilmiyor/);
    assert.match(tip, /5 saatlik limit: %75/);
  });
});

/* --------------------------------------------------------- housekeeping */

test.describe('the reader is cheap and reads exactly one key', () => {
  test('a second read of an unchanged store does not re-decode', () => {
    // `rebuild()` runs on a 15s sweep while the panel is open. Re-opening
    // SQLite and walking two levels of protobuf every fifteen seconds, for a
    // file that changes minutes apart, is a cost with no reading behind it.
    const base = appData({ 'Antigravity IDE': { models: [model('A', 0.25)], mtimeMs: NOW - 1000 } });
    const file = resolveAntigravityIdeStore(base).file;

    clearDecodeCache();
    const first = readAntigravityIdeQuota({ appDataDir: base, now: NOW });
    assert.equal(first.fiveHour.usedPercentage, 75);

    // Break the file. A cached read still answers; a re-read could not.
    fs.writeFileSync(file, 'no longer a database');
    const when = new Date(NOW - 1000);
    fs.utimesSync(file, when, when);
    const second = readAntigravityIdeQuota({ appDataDir: base, now: NOW });
    assert.equal(second.fiveHour.usedPercentage, 75, 'served from the mtime-keyed cache');

    // A changed mtime must never be served from cache, or a real update would
    // be invisible until restart.
    const later = new Date(NOW - 500);
    fs.utimesSync(file, later, later);
    const third = readAntigravityIdeQuota({ appDataDir: base, now: NOW });
    assert.equal(third.state, 'invalid', 'the cache did not hide the change');
  });

  test('the oauth token in the same table is never selected', () => {
    // The fixture writes `antigravityUnifiedStateSync.oauthToken` beside the
    // status key precisely so this can be asserted rather than asserted about.
    const base = appData({ 'Antigravity IDE': { models: [model('A', 0.25)], mtimeMs: NOW - 1000 } });
    const q = read(base);
    const serialised = JSON.stringify(q);
    assert.equal(serialised.includes('ya29.'), false);
    assert.equal(serialised.includes('oauthToken'), false);

    // And the source names one key and never enumerates the table.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'antigravity', 'ide-quota.js'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    assert.equal(/SELECT\s+\*/i.test(code), false, 'no SELECT *');
    assert.equal(code.includes('oauthToken'), false);
    assert.equal(code.includes('WHERE key = ?'), true, 'one key, by parameter');
  });

  test('nothing in this lane opens a network connection or writes to the store', () => {
    const dir = path.join(__dirname, '..', 'src', 'core', 'antigravity');
    for (const name of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, name), 'utf8');
      const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
      for (const forbidden of ['node:http', 'node:https', 'node:net', 'fetch(', 'writeFileSync', 'INSERT', 'UPDATE', 'DELETE']) {
        assert.equal(code.includes(forbidden), false, `${name} references ${forbidden}`);
      }
    }
  });

  test('the ExperimentalWarning from node:sqlite never reaches the console', () => {
    // A tray app printing Node internals into a user's console is noise they
    // cannot act on. Scoped to that one warning: everything else must survive.
    const res = require('node:child_process').spawnSync(
      process.execPath,
      ['-e', "require('./src/core/antigravity/sqlite').loadSqlite(); process.emitWarning('keep me', 'ExperimentalWarning');"],
      { cwd: path.join(__dirname, '..'), encoding: 'utf8' },
    );
    assert.equal(res.status, 0);
    assert.equal(/SQLite is an experimental feature/.test(res.stderr), false, res.stderr);
    assert.match(res.stderr, /keep me/, 'the filter is scoped, not a blanket --no-warnings');
  });
});


/* --------------------------------------------------- the model they picked */

test.describe('the selected model, read from the preferences key', () => {
  /** Ids taken from the live store, so the fixtures match reality. */
  const OPUS = 1026;
  const SONNET = 1035;
  const GEM_HIGH = 1016;

  function withIds(over = {}) {
    return {
      models: [
        { ...model('Claude Opus 4.6 (Thinking)', 0.4), id: OPUS },
        { ...model('Claude Sonnet 4.6 (Thinking)', 0.4), id: SONNET },
        { ...model('Gemini 3.1 Pro (High)', 1), id: GEM_HIGH },
      ],
      mtimeMs: NOW - 1000,
      ...over,
    };
  }

  test('names the model the preferences key points at, and its group', () => {
    // 1026 is what the live store had selected, and it decoded to Claude Opus
    // 4.6 (Thinking) — the same answer this fixture asserts.
    const base = appData({ 'Antigravity IDE': withIds({ selectedId: OPUS }) });
    const q = read(base);
    assert.equal(q.selectedModel, 'Claude Opus 4.6 (Thinking)');
    // Group 0 is the most consumed one, which is where both Claude entries sit.
    assert.equal(q.selectedGroupIndex, 0);
    assert.deepEqual(q.groups[q.selectedGroupIndex].members, [
      'Claude Opus 4.6 (Thinking)', 'Claude Sonnet 4.6 (Thinking)',
    ]);
  });

  test('switching model moves the selection to the other group', () => {
    // "It updates when they switch model": the same store, one id different.
    const base = appData({ 'Antigravity IDE': withIds({ selectedId: GEM_HIGH }) });
    const q = read(base);
    assert.equal(q.selectedModel, 'Gemini 3.1 Pro (High)');
    assert.equal(q.selectedGroupIndex, 1, 'the roomier group, which is where it lives');
    assert.equal(q.groups[1].usedPercentage, 0);
  });

  test('the row carries the selection, and no member carries a figure', () => {
    // The contract's pairing rule survives the addition: the figure is on the
    // group, the selection is an index plus a name. Nothing here can be joined
    // into "Claude Opus 4.6 (Thinking) · %60" without the renderer choosing to.
    const base = appData({ 'Antigravity IDE': withIds({ selectedId: OPUS }) });
    const ag = agRow(read(base));
    assert.equal(ag.modelQuotas.selectedModel, 'Claude Opus 4.6 (Thinking)');
    assert.equal(ag.modelQuotas.selectedGroupIndex, 0);
    for (const group of ag.modelQuotas.groups) {
      for (const member of group.members) {
        assert.equal(/[0-9]+\s*%|%\s*[0-9]+/.test(member), false, member);
      }
    }
  });

  test('F7: the row HEADLINE is the selected model group, not the most-consumed one', () => {
    // The user has Gemini selected (0% used), while the Claude models sit at
    // 60%. The renderer labels the headline "the selected model", so it must
    // BE that model's figure or the label lies. The most-consumed group still
    // leads `groups`, for the tray and for the breakdown.
    const base = appData({
      'Antigravity IDE': {
        models: [
          { ...model('Claude Opus 4.6 (Thinking)', 0.4), id: OPUS },
          { ...model('Gemini 3.1 Pro (High)', 1), id: GEM_HIGH },
        ],
        mtimeMs: NOW - 1000,
        selectedId: GEM_HIGH,
      },
    });
    const ag = agRow(read(base));
    assert.equal(ag.modelQuotas.selectedModel, 'Gemini 3.1 Pro (High)');
    assert.equal(ag.modelQuotas.selectedGroupIndex, 1, 'selected sits in the roomier group');
    assert.equal(ag.fiveHour.usedPercentage, 0, 'the headline is the SELECTED figure');
    assert.equal(ag.modelQuotas.groups[0].usedPercentage, 60, 'most-consumed still leads the breakdown');
  });

  test('F7: a refused selection falls the headline back to most-consumed, never blank', () => {
    // The safety rule: a bad preferences read must cost only the highlight,
    // never the number. Selected id names no listed model -> no selection ->
    // headline is the most-consumed group, and the row still reads.
    const base = appData({
      'Antigravity IDE': {
        models: [
          { ...model('Claude Opus 4.6 (Thinking)', 0.4), id: OPUS },
          { ...model('Gemini 3.1 Pro (High)', 1), id: GEM_HIGH },
        ],
        mtimeMs: NOW - 1000,
        selectedId: 999999,
      },
    });
    const ag = agRow(read(base));
    assert.equal(ag.modelQuotas.selectedGroupIndex, null, 'no selection');
    assert.equal(ag.fiveHour.usedPercentage, 60, 'headline falls back to most-consumed');
  });

  test('a store with no preferences key has no selection, and still has quota', () => {
    // A user who has never switched model. Missing is not broken.
    const base = appData({ 'Antigravity IDE': withIds({ selectedId: null }) });
    const q = read(base);
    assert.equal(q.selectedModel, null);
    assert.equal(q.selectedGroupIndex, null);
    assert.equal(q.fiveHour.usedPercentage, 60, 'the figures are untouched');
  });

  test('an id that matches no listed model is refused, not guessed at', () => {
    // A stale preference, or an id space that moved under us. Naming the
    // nearest model would be inventing the answer.
    const base = appData({ 'Antigravity IDE': withIds({ selectedId: 999999 }) });
    const q = read(base);
    assert.equal(q.selectedModel, null);
    assert.equal(q.fiveHour.usedPercentage, 60, 'and the quota is unaffected');
  });

  test('an id shared by two models is refused: it is not an identifier', () => {
    const base = appData({
      'Antigravity IDE': {
        models: [
          { ...model('One', 0.4), id: OPUS },
          { ...model('Two', 0.4), id: OPUS },
        ],
        mtimeMs: NOW - 1000,
        selectedId: OPUS,
      },
    });
    assert.equal(read(base).selectedModel, null);
  });

  test('a preferences payload with an unexpected shape refuses the selection only', () => {
    // Same strictness as the quota: full expected shape or nothing. The blast
    // radius is deliberately the selection — a store whose preferences moved
    // is still a store whose figures we can read.
    const base = appData({ 'Antigravity IDE': withIds({ selectedId: OPUS, selectedField: 4 }) });
    const q = read(base);
    assert.equal(q.selectedModel, null);
    assert.match(q.selectionError, /schema/);
    assert.equal(q.fiveHour.usedPercentage, 60, 'the quota is not taken down with it');
    assert.equal(q.groups.length, 2);
  });

  test('a renamed preferences sentinel refuses the selection only', () => {
    const base = appData({
      'Antigravity IDE': withIds({ selectedId: OPUS, prefsSentinel: 'something_else_key' }),
    });
    const q = read(base);
    assert.equal(q.selectedModel, null);
    assert.equal(q.fiveHour.usedPercentage, 60);
  });

  test('a malformed model id block refuses the selection, never the figures', () => {
    // An extra field inside the id block: the id space is no longer one we can
    // match against, so no selection is claimed — but the quota is untouched.
    const base = appData({
      'Antigravity IDE': {
        models: [{ ...model('Claude Opus 4.6 (Thinking)', 0.4), id: OPUS, idExtra: 7 }],
        mtimeMs: NOW - 1000,
        selectedId: OPUS,
      },
    });
    const q = read(base);
    assert.equal(q.selectedModel, null);
    assert.match(q.selectionError, /model id/);
    assert.equal(q.fiveHour.usedPercentage, 60);
  });

  test('models with no id at all are still quoted, just never selected', () => {
    const base = appData({
      'Antigravity IDE': { models: [model('No id', 0.4)], mtimeMs: NOW - 1000, selectedId: OPUS },
    });
    const q = read(base);
    assert.equal(q.selectedModel, null);
    assert.equal(q.fiveHour.usedPercentage, 60);
  });

  test('a selection survives the mtime cache, and changes with the store', () => {
    // The cache is keyed by mtime and now holds the selection too; a switch
    // that rewrites the store must not be served the previous answer.
    const dirA = appData({ 'Antigravity IDE': withIds({ selectedId: OPUS }) });
    assert.equal(read(dirA).selectedModel, 'Claude Opus 4.6 (Thinking)');
    const dirB = appData({ 'Antigravity IDE': withIds({ selectedId: GEM_HIGH, mtimeMs: NOW - 2000 }) });
    assert.equal(read(dirB).selectedModel, 'Gemini 3.1 Pro (High)');
  });
});

/* ------------------------------------------------ is the IDE even running */

test.describe('the process probe behind the refresh notice', () => {
  const REAL = [
    '"Antigravity IDE.exe","24716","Console","1","195.440 K"',
    '"language_server_windows_x64.exe","3080","Console","1","125.068 K"',
    '"chrome.exe","999","Console","1","10 K"',
  ].join('\r\n');

  function exec(stdout, err) {
    return (file, args, opts, cb) => cb(err || null, stdout, '');
  }

  test('says running when an Antigravity image is in the list', async () => {
    assert.equal(await isAntigravityRunning({ exec: exec(REAL) }), 'running');
  });

  test('the language server alone is not the IDE', async () => {
    // It outlives the editor. Treating it as "the IDE is up" would suppress
    // the one message this probe exists to produce.
    const only = '"language_server_windows_x64.exe","3080","Console","1","125.068 K"';
    assert.equal(await isAntigravityRunning({ exec: exec(only) }), 'not-running');
  });

  test('a localised "no tasks" reply reads as not-running, not as an error', async () => {
    // tasklist's own message is translated; the CSV rows are not. Matching on
    // quoted image names instead of on prose is what makes this locale-proof.
    assert.equal(await isAntigravityRunning({ exec: exec('BİLGİ: Ölçütlere uyan görev çalışmıyor.\r\n') }), 'not-running');
  });

  test('every failure lands on unknown, never on a confident wrong answer', async () => {
    // Telling users their editor is closed while it is open is a false
    // statement; saying nothing is merely unhelpful.
    assert.equal(await isAntigravityRunning({ exec: exec('', new Error('timeout')) }), 'unknown');
    assert.equal(await isAntigravityRunning({ exec: exec('') }), 'unknown');
    assert.equal(await isAntigravityRunning({ exec: exec(null) }), 'unknown');
    assert.equal(await isAntigravityRunning({
      exec: () => { throw new Error('spawn refused'); },
    }), 'unknown');
  });

  test('it never rejects, whatever the callback does', async () => {
    await assert.doesNotReject(() => isAntigravityRunning({ exec: exec(undefined, new Error('x')) }));
  });

  test('tasklist is invoked by absolute path, with no shell', async () => {
    // A bare "tasklist" would resolve through PATH, which is writable by the
    // user and by anything running as them.
    let seen = null;
    await isAntigravityRunning({
      exec: (file, args, opts, cb) => { seen = { file, args, opts }; cb(null, REAL, ''); },
    });
    assert.match(seen.file, /^[A-Za-z]:\\/, 'absolute');
    assert.match(seen.file, /System32[\\/]tasklist\.exe$/i);
    assert.deepEqual(seen.args, ['/FO', 'CSV', '/NH'], 'arguments are a list, not a command string');
    assert.equal(seen.opts.windowsHide, true);
    assert.ok(seen.opts.timeout > 0, 'a probe that can hang is a refresh that can hang');
  });

  test('the CSV parser only ever looks at the first field', () => {
    // A process whose WINDOW TITLE mentions Antigravity must not count.
    assert.equal(anyAntigravityImage('"notepad.exe","1","Console","1","Antigravity notes"'), false);
    assert.equal(anyAntigravityImage('"Antigravity.exe","1","Console","1","x"'), true, 'the old name still counts');
  });
});

/* -------------------------------------------- the store is watched, not polled */

test.describe('the collector follows the IDE store', () => {
  function collectorOn(base, t) {
    const dir = tmpdir();
    const c = new Collector({
      userDataDir: dir,
      projectsRoot: path.join(dir, 'projects'),
      rateLimitsDir: dir,
      rateLimitsFile: path.join(dir, 'claude-rate-limits.json'),
      antigravityQuotaFile: path.join(dir, 'antigravity-quota.json'),
      ideAppDataDir: base,
    });
    t.after(() => c.stop());
    return c;
  }

  test('a rebuild points the watcher at the chosen store directory', (t) => {
    const base = appData({ 'Antigravity IDE': { models: [model('A', 0.5)], mtimeMs: NOW - 1000 } });
    const c = collectorOn(base, t);
    c.rebuild();
    assert.equal(
      c._ideWatchDir,
      path.join(base, 'Antigravity IDE', 'User', 'globalStorage'),
      'watching the directory, because the store file is replaced rather than appended to',
    );
  });

  test('when a newer install appears the watcher moves to it', (t) => {
    // GUARD 1 chooses by mtime and can change its mind. A watcher pinned to
    // the first answer would quietly stop reporting changes.
    const base = appData({ 'Antigravity IDE': { models: [model('A', 0.5)], mtimeMs: NOW - 10 * DAY } });
    const c = collectorOn(base, t);
    c.rebuild();
    const first = c._ideWatchDir;

    store.writeInstall(path.join(base, 'Antigravity Next'), [model('B', 0.5)], { mtimeMs: NOW - 1000 });
    c.rebuild();
    assert.notEqual(c._ideWatchDir, first);
    assert.equal(c._ideWatchDir, path.join(base, 'Antigravity Next', 'User', 'globalStorage'));
  });

  test('a burst of store writes coalesces into one rebuild', (t) => {
    // The IDE rewrites this file whenever it syncs. Rebuilding per event would
    // redraw the tray icon and re-push a snapshot several times a second.
    //
    // The DEBOUNCE is what is asserted here, not `fs.watch` itself: whether
    // the OS delivers an event, and how many, is the platform's business and
    // not something a unit test should pretend to pin.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const base = appData({ 'Antigravity IDE': { models: [model('A', 0.5)], mtimeMs: NOW - 1000 } });
    const c = collectorOn(base, t);
    let rebuilds = 0;
    const real = c.rebuild.bind(c);
    c.rebuild = () => { rebuilds += 1; return real(); };

    c._onIdeStoreChange();
    c._onIdeStoreChange();
    c._onIdeStoreChange();
    assert.equal(rebuilds, 0, 'nothing happens until the burst settles');
    t.mock.timers.tick(DEBOUNCE_MS);
    assert.equal(rebuilds, 1, 'and then exactly once');
  });

  test('a stopped collector does not rebuild on a late store event', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const base = appData({ 'Antigravity IDE': { models: [model('A', 0.5)], mtimeMs: NOW - 1000 } });
    const c = collectorOn(base, t);
    let rebuilds = 0;
    const real = c.rebuild.bind(c);
    c.rebuild = () => { rebuilds += 1; return real(); };
    c._onIdeStoreChange();
    c.stop();
    t.mock.timers.tick(DEBOUNCE_MS * 4);
    assert.equal(rebuilds, 0);
    assert.equal(c._ideWatchDir, null, 'and it forgets what it was watching');
  });

  test('the collector reads the store it was pointed at, not the real one', (t) => {
    // The seam this test exists to hold: without `ideAppDataDir` every
    // Collector built in this suite would read the developer's own install.
    // Stamped against the REAL clock, not the suite's fixed NOW: the collector
    // reads with `Date.now()`, so a fixture frozen in the past would be judged
    // stale for a reason that has nothing to do with what is being tested.
    const liveNow = Date.now();
    const base = appData({
      'Antigravity IDE': {
        models: [model('Only', 0.75, Math.floor((liveNow + 3 * HOUR) / 1000))],
        mtimeMs: liveNow - 1000,
      },
    });
    const c = collectorOn(base, t);
    c.rebuild();
    assert.equal(c.antigravityIde.state, 'fresh');
    assert.deepEqual(c.antigravityIde.groups[0].members, ['Only']);
    assert.equal(c.antigravityIde.fiveHour.usedPercentage, 25);
  });
});
