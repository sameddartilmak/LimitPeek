'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { sanitizeEnabled, resolveEnabled, withEnabled } = require('../src/core/enabled');
const { PROVIDER_IDS, DEFAULT_ENABLED } = require('../src/core/providers');
const { buildSnapshot, loadingSnapshot } = require('../src/core/snapshot');
const {
  leadProvider, traySpecFromSnapshot, trayIconKey, drawablePercentage,
} = require('../src/core/tray-spec');
const settingsStore = require('../src/main/settings');

/**
 * `enabled` is the user's answer to "do I want to SEE this row", and it is
 * read from a file that survives upgrades. The whole risk surface is that a
 * bad file empties the panel: every row gone, no meter, no error, on a machine
 * where the data was collected perfectly. So the tests below are mostly about
 * degradation, not about the happy path.
 */

/* --------------------------------------------------------------- defaults */

test.describe('shipped enablement', () => {
  test('claude is added by default and the other four are not', () => {
    const resolved = resolveEnabled(undefined);
    assert.equal(resolved.claude, true);
    for (const id of PROVIDER_IDS.filter((p) => p !== 'claude')) {
      assert.equal(resolved[id], false, `${id} must not appear in the panel unasked`);
    }
    // Every known id gets an answer, so nothing downstream has to guess.
    assert.deepEqual(Object.keys(resolved).sort(), [...PROVIDER_IDS].sort());
  });

  test('the registry default and the resolver agree', () => {
    assert.deepEqual(resolveEnabled({}), { ...DEFAULT_ENABLED });
  });

  test('an id the file never mentions falls back to its default, not to false', () => {
    // This is what makes a settings file written before a provider existed
    // harmless: the new provider arrives with ITS default rather than
    // inheriting a `false` the user could never have meant.
    const resolved = resolveEnabled({ kimi: true });
    assert.equal(resolved.kimi, true);
    assert.equal(resolved.claude, true, 'unmentioned claude keeps its default');
    assert.equal(resolved.codex, false);
  });

  test('the user really can turn everything off', () => {
    const all = {};
    for (const id of PROVIDER_IDS) all[id] = false;
    const resolved = resolveEnabled(all);
    assert.equal(Object.values(resolved).some(Boolean), false);
  });
});

/* ------------------------------------------------------- untrusted input */

test.describe('a corrupt or hostile enablement value', () => {
  test('an unknown id is ignored rather than carried through', () => {
    assert.deepEqual(sanitizeEnabled({ 'not-a-provider': true, kimi: true }), { kimi: true });
    assert.deepEqual(sanitizeEnabled({ __proto__: true }), {});
    // Prototype keys must not leak in through the own-property check either.
    const resolved = resolveEnabled({ 'not-a-provider': true });
    assert.equal(Object.prototype.hasOwnProperty.call(resolved, 'not-a-provider'), false);
  });

  test('a non-boolean value leaves that id on its default', () => {
    for (const bad of ['true', 1, 0, null, undefined, {}, []]) {
      assert.deepEqual(sanitizeEnabled({ kimi: bad }), {}, `kimi: ${JSON.stringify(bad)}`);
      assert.equal(resolveEnabled({ claude: bad }).claude, true, 'claude must not vanish');
    }
  });

  test('a value that is not an object at all degrades to defaults', () => {
    for (const bad of [null, undefined, 0, 42, 'claude', true, [], ['claude'], NaN]) {
      assert.deepEqual(sanitizeEnabled(bad), {}, `input ${JSON.stringify(bad)}`);
      assert.deepEqual(
        resolveEnabled(bad), { ...DEFAULT_ENABLED },
        'a corrupt value must never mean "nothing is enabled"',
      );
    }
  });

  test('withEnabled never mutates its input and refuses an unknown id', () => {
    const before = { kimi: true };
    const after = withEnabled(before, 'codex', true);
    assert.deepEqual(before, { kimi: true }, 'input was mutated');
    assert.deepEqual(after, { kimi: true, codex: true });
    assert.deepEqual(withEnabled(before, 'not-a-provider', true), { kimi: true });
    assert.deepEqual(withEnabled('garbage', 'claude', false), { claude: false });
  });
});

/* ------------------------------------------------------------- settings */

test.describe('settings.json survives a hand-edited enablement map', () => {
  function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-enabled-'));
  }

  test('a round trip preserves what the user chose', () => {
    const dir = tmpDir();
    const settings = settingsStore.load(dir);
    assert.deepEqual(settings.enabledProviders, {}, 'a missing file means "all defaults"');
    settings.enabledProviders = { kimi: true, claude: false };
    assert.equal(settingsStore.save(dir, settings), true);
    assert.deepEqual(settingsStore.load(dir).enabledProviders, { kimi: true, claude: false });
  });

  test('a corrupt enabledProviders costs the preference, never the panel', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'settings.json');
    for (const bad of ['"claude"', '42', 'null', '["claude"]', '{"nope":true}', '{"kimi":"yes"}']) {
      fs.writeFileSync(file, `{"autostart":true,"enabledProviders":${bad}}`, 'utf8');
      const loaded = settingsStore.load(dir);
      const resolved = resolveEnabled(loaded.enabledProviders);
      assert.equal(resolved.claude, true, `claude disappeared for ${bad}`);
      assert.equal(
        Object.keys(resolved).length, PROVIDER_IDS.length,
        `the settings view lost providers for ${bad}`,
      );
    }
  });

  test('a truncated settings file degrades to defaults, not to an empty panel', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"enabledProvide', 'utf8');
    assert.deepEqual(resolveEnabled(settingsStore.load(dir).enabledProviders), { ...DEFAULT_ENABLED });
  });

  test('a settings file naming a removed provider loads cleanly, and the id is dropped', () => {
    // Migration: 0.4.3 and earlier shipped GitHub Copilot and saved its id in
    // all three per-provider settings. The provider is gone, so the id is an
    // unknown one — dropped silently, costing no other provider its setting.
    const removed = 'copilot';
    const dir = tmpDir();
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({
      providerOrder: ['kimi', removed, 'claude'],
      enabledProviders: { [removed]: true, kimi: true, claude: false },
      planLabels: { [removed]: 'Business', claude: 'Max 20x' },
    }), 'utf8');
    const loaded = settingsStore.load(dir);
    assert.deepEqual(loaded.providerOrder, ['kimi', 'claude']);
    assert.deepEqual(loaded.enabledProviders, { claude: false, kimi: true });
    assert.deepEqual(loaded.planLabels, { claude: 'Max 20x' });

    // Saving writes the cleaned values back, so the id does not outlive the
    // first change the user makes.
    assert.equal(settingsStore.save(dir, loaded), true);
    assert.equal(fs.readFileSync(file, 'utf8').includes(removed), false);

    // And the snapshot built from it has every current row and nothing else.
    const s = buildSnapshot({
      now: Date.now(), events: [], rateLimits: null,
      order: loaded.providerOrder, enabled: loaded.enabledProviders, planLabels: loaded.planLabels,
    });
    const rest = PROVIDER_IDS.filter((id) => id !== 'kimi' && id !== 'claude');
    assert.deepEqual(s.providers.map((p) => p.id), ['kimi', 'claude', ...rest]);
    assert.deepEqual(s.providers.filter((p) => p.enabled).map((p) => p.id), ['kimi']);
  });

  test('a 0.4.3 settings file naming Gemini CLI loads cleanly, and the new tools take their shipped defaults', () => {
    // Migration: 0.4.3 shipped a 'gemini' row (Gemini CLI, removed 2026-09-28:
    // Google retired it for consumers; Antigravity CLI replaces it and has its
    // own row). A user who added it, moved it and typed a plan for it has the
    // id in all three settings. It is dropped; nothing else moves; Qwen Code
    // and Grok Build, which that file cannot name, are offered but not added.
    const dir = tmpDir();
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({
      providerOrder: ['gemini', 'antigravity', 'claude', 'codex', 'kimi'],
      enabledProviders: { claude: true, codex: false, gemini: true, antigravity: true, kimi: false },
      planLabels: { gemini: 'Google AI Pro', claude: 'Max 5x' },
    }), 'utf8');
    const loaded = settingsStore.load(dir);
    assert.deepEqual(loaded.providerOrder, ['antigravity', 'claude', 'codex', 'kimi']);
    assert.deepEqual(loaded.enabledProviders, { claude: true, codex: false, antigravity: true, kimi: false });
    assert.deepEqual(loaded.planLabels, { claude: 'Max 5x' });

    assert.equal(settingsStore.save(dir, loaded), true);
    assert.equal(fs.readFileSync(file, 'utf8').includes('gemini'), false, 'the id does not outlive the first save');

    const s = buildSnapshot({
      now: Date.now(), events: [], rateLimits: null,
      order: loaded.providerOrder, enabled: loaded.enabledProviders, planLabels: loaded.planLabels,
    });
    assert.deepEqual(s.providers.map((p) => p.id), ['antigravity', 'claude', 'codex', 'kimi', 'qwen', 'grok'],
      'the new rows join after the stored order, in registry order');
    assert.deepEqual(s.providers.filter((p) => p.enabled).map((p) => p.id), ['antigravity', 'claude']);
    assert.equal(s.providers.some((p) => p.id === 'gemini'), false);
  });
});

/* ------------------------------------------------------------- snapshot */

test.describe('the snapshot carries enablement for every provider', () => {
  function snap(over = {}) {
    return buildSnapshot({ now: Date.now(), events: [], rateLimits: null, ...over });
  }

  test('every row is present whatever is enabled, because settings needs them', () => {
    const s = snap({ enabled: { claude: false } });
    assert.equal(s.providers.length, PROVIDER_IDS.length);
    assert.equal(s.providers.every((p) => typeof p.enabled === 'boolean'), true);
    assert.equal(s.providers.find((p) => p.id === 'claude').enabled, false);
  });

  test('the default snapshot shows claude and nothing else', () => {
    const enabled = snap().providers.filter((p) => p.enabled).map((p) => p.id);
    assert.deepEqual(enabled, ['claude']);
  });

  test('the loading skeleton agrees with the first real snapshot', () => {
    // Otherwise the panel visibly drops or gains rows the moment data lands.
    const opts = { enabled: { kimi: true, claude: false }, order: ['kimi'] };
    const skeleton = loadingSnapshot(Date.now(), opts.order, opts.enabled);
    const real = snap(opts);
    assert.deepEqual(
      skeleton.providers.map((p) => `${p.id}:${p.enabled}`),
      real.providers.map((p) => `${p.id}:${p.enabled}`),
    );
  });

  test('enablement and connection are different questions', () => {
    // An added-but-unconnected provider still gets a row, with its setup
    // action; that is the whole "Ekle" affordance.
    const row = snap({ enabled: { kimi: true } }).providers.find((p) => p.id === 'kimi');
    assert.equal(row.enabled, true);
    assert.equal(row.connected, false);
    assert.ok(row.setupAction, 'an added provider must still offer its setup action');
  });
});

/* ----------------------------------------------------------------- tray */

test.describe('the tray icon is driven by the first ENABLED provider', () => {
  function row(id, over = {}) {
    return {
      id,
      displayName: id,
      accent: '#C96442',
      enabled: true,
      connected: true,
      status: 'ok',
      fiveHour: { usedPercentage: 50, certainty: 'known', resetsAt: null },
      ...over,
    };
  }
  const snapshot = (providers) => ({ generatedAt: new Date().toISOString(), providers });

  test('an un-added provider at the top does not drive the icon', () => {
    // The user cannot see the row it comes from, so an icon describing it
    // would be a claim with nothing on screen to check it against.
    const s = snapshot([
      row('kimi', { enabled: false, fiveHour: { usedPercentage: 91, certainty: 'known' } }),
      row('claude', { fiveHour: { usedPercentage: 20, certainty: 'known' } }),
    ]);
    assert.equal(leadProvider(s).id, 'claude');
    assert.equal(traySpecFromSnapshot(s).usedPercentage, 20);
  });

  test('nothing enabled means the no-data ring, not the first row', () => {
    const s = snapshot([
      row('claude', { enabled: false, fiveHour: { usedPercentage: 91, certainty: 'known' } }),
      row('kimi', { enabled: false, fiveHour: { usedPercentage: 12, certainty: 'known' } }),
    ]);
    assert.equal(leadProvider(s), null);
    const spec = traySpecFromSnapshot(s);
    assert.equal(spec.usedPercentage, null, 'no enabled row means nothing to describe');
    assert.equal(spec.state, 'none');
    assert.equal(spec.accent, '#98989F');
  });

  test('a snapshot built with the shipped defaults leads with claude', () => {
    const s = buildSnapshot({ now: Date.now(), events: [], rateLimits: null, order: ['kimi'] });
    assert.equal(s.providers[0].id, 'kimi', 'user order is still applied to every row');
    assert.equal(leadProvider(s).id, 'claude', 'but an un-added row cannot lead the tray');
  });

  test('a payload with no `enabled` field at all still shows something', () => {
    // Loose on purpose: `enabled !== false`. Every snapshot this codebase
    // builds sets the field, and a hand-built one must degrade to "shown"
    // rather than silently blanking the icon.
    const s = snapshot([{ id: 'claude', displayName: 'Claude Code', accent: '#C96442', connected: true, fiveHour: { usedPercentage: 40, certainty: 'known' } }]);
    assert.equal(leadProvider(s).id, 'claude');
    assert.equal(traySpecFromSnapshot(s).usedPercentage, 40);
  });

  test('an unusable entry is skipped rather than blanking the icon', () => {
    assert.equal(leadProvider({ providers: [null] }), null);
    assert.equal(leadProvider({ providers: [null, row('claude')] }).id, 'claude');
  });
});

test.describe('the tray rejects a percentage it cannot defend, and does not clamp it', () => {
  function row(pct) {
    return {
      id: 'claude',
      displayName: 'Claude Code',
      accent: '#C96442',
      enabled: true,
      connected: true,
      status: 'ok',
      fiveHour: { usedPercentage: pct, certainty: 'known', resetsAt: null },
    };
  }
  const snapshot = (p) => ({ generatedAt: new Date().toISOString(), providers: [p] });

  test('out of range means no reading, the same answer the renderer gives', () => {
    // `percentage()` in src/renderer/src/sanitize.ts REJECTS rather than
    // clamps, on the reasoning that clamping 250 to 100 draws a confident full
    // meter out of a value proving the producer is wrong. The tray drew a full
    // ring for the same input, so the icon and the row disagreed about whether
    // the number was usable at all.
    for (const bad of [140, 250, 100.5, -1, -0.5, 1e9]) {
      assert.equal(drawablePercentage(row(bad)), null, `${bad} must not be drawable`);
      const spec = traySpecFromSnapshot(snapshot(row(bad)));
      assert.equal(spec.usedPercentage, null);
      assert.equal(spec.state, 'none', 'and it must be the no-data ring');
    }
  });

  test('the legitimate endpoints still draw', () => {
    for (const good of [0, 0.5, 50, 99.9, 100]) {
      assert.equal(drawablePercentage(row(good)), good, `${good} is a valid reading`);
    }
  });

  test('a rejected value is not silently rounded into range', () => {
    // 100.4 rounds to 100 and would have printed as a legitimate "%100".
    assert.equal(drawablePercentage(row(100.4)), null);
  });
});

test.describe('the redraw key follows the lead provider', () => {
  function two(claudeEnabled, kimiEnabled) {
    return {
      generatedAt: new Date().toISOString(),
      providers: [
        {
          id: 'claude', displayName: 'Claude Code', accent: '#C96442', enabled: claudeEnabled,
          connected: true, status: 'ok', fiveHour: { usedPercentage: 40, certainty: 'known' },
        },
        {
          id: 'kimi', displayName: 'Kimi', accent: '#2B6BE8', enabled: kimiEnabled,
          connected: true, status: 'ok', fiveHour: { usedPercentage: 40, certainty: 'known' },
        },
      ],
    };
  }

  test('toggling the lead provider off changes the key, so the icon repaints', () => {
    // Both rows sit at the same rounded percentage and the same state on
    // purpose: if the key did not name the LEADING provider, these two would
    // hash identically and updateTray() would skip the redraw, leaving a donut
    // on screen describing a row the panel no longer shows.
    const before = trayIconKey(two(true, true));
    const after = trayIconKey(two(false, true));
    assert.notEqual(before, after);
    assert.ok(before.startsWith('claude|'));
    assert.ok(after.startsWith('kimi|'));
  });

  test('turning everything off is its own key, distinct from a lead with no data', () => {
    const nothing = trayIconKey(two(false, false));
    assert.ok(nothing.startsWith('none|'), nothing);
    const leadNoData = trayIconKey({
      generatedAt: new Date().toISOString(),
      providers: [{ id: 'claude', displayName: 'Claude Code', accent: '#C96442', enabled: true, connected: true, fiveHour: null }],
    });
    assert.notEqual(nothing, leadNoData);
  });

  test('a change that touches neither the lead nor the number is not a redraw', () => {
    const a = two(true, true);
    const b = two(true, false);
    assert.equal(trayIconKey(a), trayIconKey(b), 'disabling a row below the lead cannot repaint');
  });
});
