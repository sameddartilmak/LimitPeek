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

test.describe('GUARD 2 — a stale store yields no percentage, ever', () => {
  test('the 112-day-old store produces words, not a number', () => {
    // Read on its own, as if it were the only install. This is the precise
    // shape of the original defect: a real figure, correctly decoded, from a
    // window that closed sixteen weeks ago.
    const base = appData({
      Antigravity: { models: [model('Gemini 3.1 Pro (High)', 0.4, Math.floor((NOW - 112 * DAY + 4 * HOUR) / 1000))], mtimeMs: NOW - 112 * DAY },
    });
    const q = read(base);
    assert.equal(q.state, 'stale');
    // The reader still carries what the file said — it is a faithful reading
    // of an old file — and the row is where the refusal happens.
    assert.equal(q.fiveHour.usedPercentage, 60);
    assert.equal(q.fiveHour.resetsAtMs, null, 'a 112-day-old reset instant is not credible');

    const ag = agRow(q);
    assert.equal(ag.fiveHour.usedPercentage, null, 'no number reaches the row');
    assert.equal(ag.fiveHour.certainty, 'unknown');
    assert.equal(ag.fiveHour.absence, 'stale');
    assert.equal(ag.status, 'stale', 'and the chrome does not read as a current, healthy row');
    assert.equal(ag.modelQuotas, null, 'nor does the detail block smuggle the same numbers back in');
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
