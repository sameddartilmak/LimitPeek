'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const plan = require('../src/core/plan-labels');
const settingsStore = require('../src/main/settings');
const { buildSnapshot, loadingSnapshot } = require('../src/core/snapshot');
const { PROVIDER_IDS } = require('../src/core/providers');

/**
 * The plan label the user tells us they are on, per tool.
 *
 * Two properties carry the whole feature and neither is enforceable by types:
 * it is never DERIVED (nothing we read states a plan, and ADR-001 security F1
 * forbids the one file that does), and it never touches a NUMBER (it is an
 * unverified string a person typed, so no quota, price or floor may read it).
 * Everything below tests one of those two, or the untrusted-text handling that
 * lets a hand-edited settings file reach the panel safely.
 */

const NOW = Date.parse('2026-09-08T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function tmpdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-labels-'));
  test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

const ev = (over) => ({
  f: 'f1', ts: NOW - HOUR, model: 'claude-opus-5',
  input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cw5: 0, cw1h: 0, key: 'k', ...over,
});
const rowOf = (snap, id) => snap.providers.find((p) => p.id === id);

test.describe('one untrusted value -> a clean label or nothing', () => {
  test('a plain plan name survives unchanged', () => {
    for (const name of ['Max 20x', 'Pro+', 'Business', 'Teams Premium', '20x']) {
      assert.equal(plan.sanitizePlanLabel(name), name);
    }
  });

  test('surrounding whitespace is trimmed, so " Max 20x " and "Max 20x" are one value', () => {
    assert.equal(plan.sanitizePlanLabel('  Max 20x  '), 'Max 20x');
    assert.equal(plan.sanitizePlanLabel('\tMax 20x\n'), 'Max 20x');
  });

  test('inner whitespace collapses, so a pasted label cannot become two visual lines', () => {
    assert.equal(plan.sanitizePlanLabel('Max    20x'), 'Max 20x');
    assert.equal(plan.sanitizePlanLabel('Max\n20x'), 'Max 20x');
    assert.equal(plan.sanitizePlanLabel('Max\u000920x'), 'Max 20x');
  });

  test('it is capped at 24 characters, counted AFTER trimming', () => {
    assert.equal(plan.MAX_PLAN_LABEL, 24);
    assert.equal(plan.sanitizePlanLabel('x'.repeat(100)).length, 24);
    // The cap must not be spent on whitespace the user cannot see.
    const padded = `${' '.repeat(20)}${'y'.repeat(24)}${' '.repeat(20)}`;
    assert.equal(plan.sanitizePlanLabel(padded), 'y'.repeat(24));
  });

  test('empty, blank and invisible-only labels are absent, never an empty string', () => {
    for (const raw of ['', '   ', '\t\n', '\u200b', '\ufeff\u200b']) {
      assert.equal(plan.sanitizePlanLabel(raw), null, JSON.stringify(raw));
    }
  });

  test('anything that is not a string is rejected outright', () => {
    for (const raw of [0, 1, true, false, null, undefined, {}, [], ['Max 20x'], () => 'Max 20x']) {
      assert.equal(plan.sanitizePlanLabel(raw), null, String(raw));
    }
  });

  test('control and line-separator characters are stripped, not passed through', () => {
    // A label pasted out of a terminal can carry these. They must not survive
    // into the DOM, and they must not cost the user their whole plan either.
    assert.equal(plan.sanitizePlanLabel('Max\u000020x'), 'Max 20x');
    assert.equal(plan.sanitizePlanLabel('Max\u001b[0m 20x'), 'Max [0m 20x');
    assert.equal(plan.sanitizePlanLabel('Max\u202820x'), 'Max 20x');
    assert.equal(plan.sanitizePlanLabel('Max\u202920x'), 'Max 20x');
    assert.equal(plan.sanitizePlanLabel('Max\u200b20x'), 'Max 20x');
    const cleaned = plan.sanitizePlanLabel('Max 20x\u0007');
    assert.equal(cleaned, 'Max 20x');
    assert.equal(/[\u0000-\u001f]/.test(cleaned), false, 'no control byte may survive');
  });
});

test.describe('the per-tool map', () => {
  test('known ids with usable labels are kept and nothing else is', () => {
    const got = plan.sanitizePlanLabels({
      claude: 'Max 20x',
      codex: '  Plus  ',
      gemini: '',
      kimi: 42,
      notATool: 'Enterprise',
      __proto__: 'hostile',
    });
    assert.deepEqual(got, { claude: 'Max 20x', codex: 'Plus' });
  });

  test('a value that is not a plain object degrades to an empty map, never to a label', () => {
    for (const raw of [undefined, null, 'Max 20x', 42, true, ['Max 20x'], [['claude', 'Max 20x']]]) {
      assert.deepEqual(plan.sanitizePlanLabels(raw), {}, String(raw));
    }
  });

  test('a tool the map does not mention is ABSENT, not an empty string', () => {
    const got = plan.sanitizePlanLabels({ claude: 'Max 20x' });
    assert.deepEqual(Object.keys(got), ['claude']);
    for (const id of PROVIDER_IDS) {
      if (id === 'claude') continue;
      assert.equal(Object.prototype.hasOwnProperty.call(got, id), false, id);
    }
  });

  test('no tool has a default label — an unstated plan is silence, not "Free"', () => {
    assert.deepEqual(plan.sanitizePlanLabels({}), {});
    assert.deepEqual(plan.sanitizePlanLabels({ claude: null }), {});
  });

  test('withPlanLabel sets one tool without mutating its input', () => {
    const before = { claude: 'Max 20x' };
    const after = plan.withPlanLabel(before, 'codex', ' Plus ');
    assert.deepEqual(after, { claude: 'Max 20x', codex: 'Plus' });
    assert.deepEqual(before, { claude: 'Max 20x' }, 'the caller’s object is untouched');
  });

  test('clearing a label DELETES the key, so the row goes back to saying nothing', () => {
    for (const cleared of ['', '   ', null, undefined, 42]) {
      const after = plan.withPlanLabel({ claude: 'Max 20x', codex: 'Plus' }, 'claude', cleared);
      assert.deepEqual(after, { codex: 'Plus' }, JSON.stringify(cleared));
      assert.equal(Object.prototype.hasOwnProperty.call(after, 'claude'), false);
    }
  });

  test('withPlanLabel refuses an unknown id rather than storing it', () => {
    const after = plan.withPlanLabel({ claude: 'Max 20x' }, 'notATool', 'Enterprise');
    assert.deepEqual(after, { claude: 'Max 20x' });
  });
});

test.describe('migrating the legacy single planLabel', () => {
  test("the old string lands on the claude key, because that is the only row that ever showed it", () => {
    assert.deepEqual(plan.migratePlanLabels(undefined, 'Max 20x'), { claude: 'Max 20x' });
    assert.deepEqual(plan.migratePlanLabels(null, '  Max 20x  '), { claude: 'Max 20x' });
  });

  test('it is not copied onto any other tool', () => {
    const got = plan.migratePlanLabels(undefined, 'Max 20x');
    assert.deepEqual(Object.keys(got), ['claude']);
  });

  test('an existing map wins, so a stale legacy field cannot overwrite a newer answer', () => {
    assert.deepEqual(
      plan.migratePlanLabels({ claude: 'Max 5x' }, 'Max 20x'),
      { claude: 'Max 5x' },
    );
  });

  test('a legacy value fills a map that states other tools but not claude', () => {
    assert.deepEqual(
      plan.migratePlanLabels({ codex: 'Plus' }, 'Max 20x'),
      { codex: 'Plus', claude: 'Max 20x' },
    );
  });

  test('an unusable legacy value migrates to nothing', () => {
    for (const legacy of [null, undefined, '', '   ', 42, {}, ['Max 20x']]) {
      assert.deepEqual(plan.migratePlanLabels(undefined, legacy), {}, String(legacy));
    }
  });

  test('settings.load() performs the migration, so an upgrade keeps the user’s plan', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ autostart: false, planLabel: 'Max 20x' }));
    const loaded = settingsStore.load(dir);
    assert.deepEqual(loaded.planLabels, { claude: 'Max 20x' });
    assert.equal(loaded.autostart, false, 'and the rest of the file is untouched');
  });

  test('settings.load() caps and trims what it reads from a hand-edited file', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
      planLabels: { claude: `  ${'z'.repeat(80)}  `, codex: '', notATool: 'x', gemini: 7 },
    }));
    assert.deepEqual(settingsStore.load(dir).planLabels, { claude: 'z'.repeat(24) });
  });

  test('a missing or corrupt settings file yields an empty map, never undefined', () => {
    const dir = tmpdir();
    assert.deepEqual(settingsStore.load(dir).planLabels, {}, 'missing');
    fs.writeFileSync(path.join(dir, 'settings.json'), '{ not json');
    assert.deepEqual(settingsStore.load(dir).planLabels, {}, 'corrupt');
  });

  test('defaults() hands out a fresh map, so one caller cannot mutate another’s', () => {
    const a = settingsStore.load(tmpdir());
    const b = settingsStore.load(tmpdir());
    a.planLabels.claude = 'Max 20x';
    assert.deepEqual(b.planLabels, {}, 'the frozen DEFAULTS object must not be shared');
  });
});

test.describe('the label reaches the right row and only that row', () => {
  const base = { now: NOW, events: [], rateLimits: { state: 'missing' }, scanOk: true };
  const installed = { installed: true, events: [], readFailed: false, resultAtMs: NOW, unreadRange: null };

  test('every provider can carry its own, and each row shows only its own', () => {
    const labels = {
      claude: 'Max 20x', codex: 'Plus', gemini: 'AI Pro',
      kimi: 'Coding', copilot: 'Business', antigravity: 'Ultra',
    };
    const snap = buildSnapshot({
      ...base, planLabels: labels, codexEvents: [], gemini: installed, kimi: installed,
      enabled: Object.fromEntries(PROVIDER_IDS.map((id) => [id, true])),
    });
    for (const id of PROVIDER_IDS) {
      assert.equal(rowOf(snap, id).planLabel, labels[id], id);
    }
  });

  test('a tool with no stated plan is null while its neighbour shows one', () => {
    const snap = buildSnapshot({ ...base, planLabels: { claude: 'Max 20x' }, codexEvents: [] });
    assert.equal(rowOf(snap, 'claude').planLabel, 'Max 20x');
    for (const id of PROVIDER_IDS) {
      if (id === 'claude') continue;
      assert.equal(rowOf(snap, id).planLabel, null, `${id}: an unstated plan renders as nothing`);
    }
  });

  test('every row declares the field, and only ever as a string or null', () => {
    const snap = buildSnapshot({ ...base, planLabels: { claude: 'Max 20x' }, codexEvents: [] });
    for (const s of [snap, loadingSnapshot(NOW, undefined, undefined, undefined, undefined, { claude: 'Max 20x' })]) {
      for (const p of s.providers) {
        assert.ok(p.planLabel === null || typeof p.planLabel === 'string', p.id);
      }
    }
  });

  test('the loading skeleton carries it, so the row header does not shift when data lands', () => {
    // Same reason the skeleton carries the key fields: the plan sits in the row
    // HEADER, and it is a setting already known at cold start.
    const skeleton = loadingSnapshot(NOW, undefined, undefined, undefined, undefined, { claude: 'Max 20x', codex: 'Plus' });
    assert.equal(rowOf(skeleton, 'claude').planLabel, 'Max 20x');
    assert.equal(rowOf(skeleton, 'codex').planLabel, 'Plus');
    assert.equal(rowOf(skeleton, 'kimi').planLabel, null);
    // And with nothing passed it is null everywhere rather than undefined.
    for (const p of loadingSnapshot(NOW).providers) assert.equal(p.planLabel, null, p.id);
  });

  test('the snapshot re-validates what it is handed, so a bad caller cannot reach the row', () => {
    const snap = buildSnapshot({
      ...base, codexEvents: [],
      planLabels: { claude: `  ${'q'.repeat(60)}  `, codex: 42, notATool: 'x' },
    });
    assert.equal(rowOf(snap, 'claude').planLabel, 'q'.repeat(24), 'trimmed and capped again at this boundary');
    assert.equal(rowOf(snap, 'codex').planLabel, null);
    for (const raw of ['Max 20x', 42, null, [], true]) {
      const s = buildSnapshot({ ...base, codexEvents: [], planLabels: raw });
      for (const p of s.providers) assert.equal(p.planLabel, null, `${String(raw)} / ${p.id}`);
    }
  });

  test('the legacy single input no longer leaks in under its old name', () => {
    // buildSnapshot once read `input.planLabel`. Main now sends `planLabels`; a
    // caller still sending the old field must get silence, not a Claude label,
    // so the two shapes cannot both be half-supported.
    const snap = buildSnapshot({ ...base, codexEvents: [], planLabel: 'Max 20x' });
    for (const p of snap.providers) assert.equal(p.planLabel, null, p.id);
  });
});

test.describe('it never touches a number', () => {
  const base = { now: NOW, events: [], rateLimits: { state: 'missing' }, scanOk: true };

  test('no core module outside the snapshot assembly can even reach it', () => {
    // A structural check, because the honesty rule is "no figure reads the
    // plan" and a comment cannot hold that. Exactly one core module requires
    // plan-labels (the snapshot, which copies it onto the row) plus the module
    // itself; no pricer, aggregator or history module may.
    const root = path.join(__dirname, '..', 'src', 'core');
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]
    ));
    const importers = walk(root)
      .filter((f) => f.endsWith('.js'))
      .filter((f) => /require\(['"][^'"]*plan-labels['"]\)/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(root, f).split(path.sep).join('/'));
    assert.deepEqual(importers, ['collector.js', 'snapshot.js'],
      'only snapshot assembly may read the plan label; a pricer or aggregator must not');
  });

  test('the pricing, aggregate and history modules never mention it at all', () => {
    for (const rel of ['pricing.js', 'aggregate.js', 'history.js', 'codex/pricing.js',
      'gemini/pricing.js', 'kimi/cost.js', 'donut.js', 'ratelimits.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', rel), 'utf8');
      assert.equal(/planLabel/.test(src), false, `${rel} must not reference planLabel`);
    }
  });

  test('changing the label changes NO figure on the row', () => {
    const events = [ev({ key: 'a', input: 100, output: 2000, cacheWrite: 50, cacheRead: 900000 })];
    const shot = (planLabels) => {
      const row = rowOf(buildSnapshot({ ...base, events, codexEvents: [], planLabels }), 'claude');
      const { planLabel, ...rest } = row;
      return JSON.stringify(rest);
    };
    const none = shot(undefined);
    for (const label of [{ claude: 'Max 20x' }, { claude: 'Free' }, { claude: 'Pro' }, { claude: '20x' }]) {
      assert.equal(shot(label), none, `${JSON.stringify(label)} moved a figure`);
    }
  });

  test('and no figure anywhere in the snapshot moves either', () => {
    const events = [ev({ key: 'a', input: 100, output: 2000, cacheWrite: 50, cacheRead: 900000 })];
    const strip = (snap) => JSON.stringify({
      ...snap,
      providers: snap.providers.map(({ planLabel, ...rest }) => rest),
    });
    const withLabels = buildSnapshot({
      ...base, events, codexEvents: [],
      planLabels: { claude: 'Max 20x', codex: 'Plus', copilot: 'Business' },
    });
    const without = buildSnapshot({ ...base, events, codexEvents: [] });
    assert.equal(strip(withLabels), strip(without),
      'the plan label is a label: removing it must leave every other value identical');
  });
});

/**
 * The SET_PLAN_LABEL handler (`src/main/plan-label-ipc.js`).
 *
 * This is the validation boundary: the renderer's control accepts arbitrary
 * typed text, and nothing arriving over IPC may be assumed to have been checked
 * on the other side. The contract the renderer relies on is that `{ok:false}`
 * means main wrote NOTHING — so every rejection path is asserted against the
 * settings object as well as the return value.
 */
test.describe('the SET_PLAN_LABEL handler', () => {
  const { createSetPlanLabelHandler } = require('../src/main/plan-label-ipc');

  function harness(over = {}) {
    const state = {
      settings: { planLabels: { claude: 'Max 20x' }, ...(over.settings || {}) },
      saved: 0,
      applied: [],
      warned: [],
    };
    const handler = createSetPlanLabelHandler({
      fromPanel: over.fromPanel || (() => true),
      getSettings: () => state.settings,
      save: over.save || (() => { state.saved += 1; return true; }),
      apply: over.apply || ((id, label) => { state.applied.push([id, label]); }),
      log: { warn: (m) => state.warned.push(m) },
    });
    return { handler, state };
  }

  test('a valid label is persisted and then applied, in that order', () => {
    const order = [];
    const { handler, state } = harness({
      save: () => { order.push('save'); return true; },
      apply: (id, label) => { order.push(`apply:${id}:${label}`); },
    });
    assert.deepEqual(handler({}, 'codex', 'Plus'), { ok: true });
    assert.deepEqual(state.settings.planLabels, { claude: 'Max 20x', codex: 'Plus' });
    assert.deepEqual(order, ['save', 'apply:codex:Plus'], 'persist THEN apply, never the reverse');
  });

  test('free text is trimmed and capped by the handler, not trusted from the renderer', () => {
    const { handler, state } = harness();
    assert.deepEqual(handler({}, 'codex', `   ${'w'.repeat(90)}   `), { ok: true });
    assert.equal(state.settings.planLabels.codex, 'w'.repeat(24));

    const two = harness();
    assert.deepEqual(two.handler({}, 'codex', 'Pro\u0000 \u200b Plan'), { ok: true });
    assert.equal(two.state.settings.planLabels.codex, 'Pro Plan', 'control and zero-width characters stripped');
  });

  test('an empty or blank label CLEARS the setting rather than storing an empty string', () => {
    for (const blank of ['', '   ', '\t', '\u200b']) {
      const { handler, state } = harness();
      assert.deepEqual(handler({}, 'claude', blank), { ok: true }, JSON.stringify(blank));
      assert.deepEqual(state.settings.planLabels, {});
      assert.equal(Object.prototype.hasOwnProperty.call(state.settings.planLabels, 'claude'), false);
    }
  });

  test('an unknown provider id writes nothing and answers false', () => {
    for (const id of ['notATool', '', '__proto__', 'CLAUDE']) {
      const { handler, state } = harness();
      assert.deepEqual(handler({}, id, 'Enterprise'), { ok: false }, id);
      assert.equal(state.saved, 0, 'nothing was written');
      assert.deepEqual(state.settings.planLabels, { claude: 'Max 20x' }, 'and nothing changed');
    }
  });

  test('a non-string id writes nothing', () => {
    for (const id of [null, undefined, 42, {}, ['claude']]) {
      const { handler, state } = harness();
      assert.deepEqual(handler({}, id, 'Plus'), { ok: false }, String(id));
      assert.equal(state.saved, 0);
    }
  });

  test('a non-string label is REFUSED, not treated as a clear', () => {
    // A caller bug must not silently delete a label the user still wants.
    for (const label of [null, undefined, 42, {}, ['Plus'], true]) {
      const { handler, state } = harness();
      assert.deepEqual(handler({}, 'claude', label), { ok: false }, String(label));
      assert.equal(state.saved, 0);
      assert.deepEqual(state.settings.planLabels, { claude: 'Max 20x' }, 'the existing label survives');
    }
  });

  test('a message that did not come from the panel is refused before anything else', () => {
    const { handler, state } = harness({ fromPanel: () => false });
    assert.deepEqual(handler({}, 'claude', 'Pro'), { ok: false });
    assert.equal(state.saved, 0);
    assert.deepEqual(state.settings.planLabels, { claude: 'Max 20x' });
  });

  test('a failed write rolls back in memory, applies nothing and answers false', () => {
    const { handler, state } = harness({ save: () => false });
    assert.deepEqual(handler({}, 'codex', 'Plus'), { ok: false });
    assert.deepEqual(state.settings.planLabels, { claude: 'Max 20x' }, 'the in-memory value is restored');
    assert.deepEqual(state.applied, [], 'nothing was applied');
    assert.equal(state.warned.length, 1, 'and it is reported');
  });

  test('the previous map is never mutated, so the rollback restores a real value', () => {
    const before = { claude: 'Max 20x' };
    const { handler, state } = harness({ settings: { planLabels: before }, save: () => false });
    handler({}, 'codex', 'Plus');
    assert.deepEqual(before, { claude: 'Max 20x' }, 'withPlanLabel must not write through to the caller');
    assert.equal(state.settings.planLabels, before, 'and the rollback puts the same object back');
  });

  test('a throw while APPLYING keeps the successful write rather than discarding it', () => {
    // The file is right and the next launch reads it; only this session's
    // snapshot is stale. Reverting the file would throw away a value the user
    // saved because a repaint failed.
    const { handler, state } = harness({ apply: () => { throw new Error('rebuild failed'); } });
    assert.deepEqual(handler({}, 'codex', 'Plus'), { ok: true });
    assert.deepEqual(state.settings.planLabels, { claude: 'Max 20x', codex: 'Plus' });
    assert.equal(state.warned.length, 1);
  });

  test('main registers this exact handler, so the tests above are not testing a copy', () => {
    const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf8');
    assert.ok(/IPC\.SET_PLAN_LABEL,\s*createSetPlanLabelHandler\(/.test(index),
      'index.js must register the extracted handler, not an inline re-implementation');
  });

  test('the channel is declared in the contract and mirrored for the runtime', () => {
    const { IPC } = require('../src/shared/contract');
    assert.equal(IPC.SET_PLAN_LABEL, 'prefs:set-plan-label');
    const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.js'), 'utf8');
    assert.ok(/setPlanLabel:\s*\(/.test(preload), 'the preload exposes setPlanLabel()');
    assert.ok(preload.includes("SET_PLAN_LABEL: 'prefs:set-plan-label'"), 'and pins the same channel string');
  });
});
