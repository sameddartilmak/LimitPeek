'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const settingsStore = require('../src/main/settings');
const { createSetSetupCoachDismissedHandler } = require('../src/main/autostart-ipc');
const { installDom, mirrorRenderer, walk } = require('./helpers/fake-dom');

/**
 * The UI plan of 2026-09-29: the first-run card's persisted answer, the card's
 * conditions, and the provider card's closed/open rules.
 */

const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-ui-'));
}

/* ---------------------------------------------- "Şimdi değil", persisted */

test.describe('setupCoachDismissed: a fresh install sees the card, an update does not', () => {
  test('no settings file at all: a fresh install, the card is offered', () => {
    assert.equal(settingsStore.load(tmpDir()).setupCoachDismissed, false);
  });

  test('a settings file from before the card existed reads as already answered', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ autostart: true, theme: 'dark' }));
    assert.equal(settingsStore.load(dir).setupCoachDismissed, true);
  });

  test('a stored answer is kept either way', () => {
    for (const value of [true, false]) {
      const dir = tmpDir();
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ setupCoachDismissed: value }));
      assert.equal(settingsStore.load(dir).setupCoachDismissed, value);
    }
  });

  test('a value that is not a boolean is treated as answered, never as "show it"', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ setupCoachDismissed: 'no' }));
    assert.equal(settingsStore.load(dir).setupCoachDismissed, true);
  });

  test('"Şimdi değil" survives a restart', () => {
    const dir = tmpDir();
    const s = settingsStore.load(dir);
    const handler = createSetSetupCoachDismissedHandler({
      fromPanel: () => true,
      getSettings: () => s,
      save: (next) => settingsStore.save(dir, next),
      push() {},
      log: { warn() {} },
    });
    assert.deepEqual(handler({}, true), { ok: true });
    assert.equal(settingsStore.load(dir).setupCoachDismissed, true);
  });
});

test.describe('the SET_SETUP_COACH_DISMISSED handler', () => {
  function rig(saveOk = true) {
    const settings = { setupCoachDismissed: false };
    const calls = [];
    const handler = createSetSetupCoachDismissedHandler({
      fromPanel: (event) => event && event.fromPanel !== false,
      getSettings: () => settings,
      save: () => { calls.push('save'); return saveOk; },
      push: () => calls.push('push'),
      log: { warn: () => calls.push('warn') },
    });
    return { settings, calls, handler };
  }

  test('persists, then pushes', () => {
    const r = rig();
    assert.deepEqual(r.handler({}, true), { ok: true });
    assert.equal(r.settings.setupCoachDismissed, true);
    assert.deepEqual(r.calls, ['save', 'push']);
  });

  test('refuses anything but a real boolean, and anything not from the panel', () => {
    for (const value of ['true', 1, null, undefined]) {
      const r = rig();
      assert.deepEqual(r.handler({}, value), { ok: false });
      assert.equal(r.settings.setupCoachDismissed, false);
      assert.deepEqual(r.calls, []);
    }
    const r = rig();
    assert.deepEqual(r.handler({ fromPanel: false }, true), { ok: false });
    assert.deepEqual(r.calls, []);
  });

  test('a failed write changes nothing and pushes nothing', () => {
    const r = rig(false);
    assert.deepEqual(r.handler({}, true), { ok: false });
    assert.equal(r.settings.setupCoachDismissed, false);
    assert.deepEqual(r.calls, ['save', 'warn']);
  });
});

/* ------------------------------------------------------------- renderer */

let mirror;
let restoreDom;
let rowMod;
let panelMod;
let i18n;

test.before(async () => {
  restoreDom = installDom();
  mirror = mirrorRenderer();
  rowMod = await mirror.load('components', 'row.js');
  panelMod = await mirror.load('components', 'panel.js');
  i18n = await mirror.load('i18n.js');
  i18n.setLocale('tr', 'tr-TR');
});

test.after(() => {
  if (restoreDom) restoreDom();
  if (mirror) mirror.cleanup();
});

const cls = (n) => (n.getAttribute('class') || '').split(/\s+/);
const byClass = (root, name) => walk(root).filter((n) => cls(n).includes(name));

const tk = (billable) => ({ input: billable, output: 0, cacheWrite: 0, cacheRead: 5_000_000, billable });
const win = (pct, over = {}) => ({
  usedPercentage: pct, certainty: 'known', resetsAt: new Date(NOW + 2 * HOUR).toISOString(),
  capturedAt: null, billableSinceCapture: null, absence: null, ...over,
});

function provider(over = {}) {
  return {
    id: 'claude', displayName: 'Claude Code', accent: '#D97757', experimental: false,
    enabled: true, connected: true, status: 'ok', planLabel: null,
    fiveHour: null, sevenDay: null, tokens: null, weeklyTokens: null,
    weeklyTokensWindowAnchored: null, weeklyTokenFloorCauses: [],
    burnRatePerHour: null, byModel: [], weeklyCost: null, setupAction: null, lastGoodAt: null,
    ...over,
  };
}

function ctx(over = {}) {
  return {
    onRetry() {}, onSetup() {},
    isBusy: () => false, attachGrip() {}, isTrayRow: () => false, isPending: () => false,
    generatedAt: new Date(NOW).toISOString(), staleOverride: false,
    ...over,
  };
}

test.describe('the closed card answers "how close am I to my limit"', () => {
  test('a tool with a quota gets its two windows as columns, and no token line outside the details', () => {
    const row = rowMod.createRow(provider({ fiveHour: win(62), sevenDay: win(41), weeklyTokens: tk(6_200_000) }), ctx(), NOW);
    const meter = byClass(row.el, 'meter')[0];
    assert.ok(meter, 'no meter');
    assert.equal(byClass(meter, 'win').length, 2);
    const detail = byClass(row.el, 'row__detail')[0];
    assert.equal(detail.hidden, true, 'details start closed');
    const meta = byClass(row.el, 'row__meta')[0];
    assert.ok(detail.contains ? detail.contains(meta) : walk(detail).includes(meta), 'the token line lives in the details');
  });

  test('a tool with NO quota gets its main measure, never an empty rail', () => {
    const row = rowMod.createRow(provider({ id: 'qwen', displayName: 'Qwen Code', weeklyTokens: tk(1_234_000), weeklyTokensWindowAnchored: false }), ctx(), NOW);
    assert.equal(byClass(row.el, 'rail').length, 0, 'a rail was drawn for a tool with no quota');
    assert.equal(byClass(row.el, 'meter').length, 0);
    const measure = byClass(row.el, 'row__primary')[0];
    assert.ok(measure, 'no main measure');
    assert.equal(measure.getAttribute('data-kind'), 'tokens');
    assert.match(measure.textContent, /token/);
    assert.match(measure.textContent, /Son 7 gün/);
    assert.doesNotMatch(measure.textContent, /%/);
  });

  test('with nothing to show, the main measure states why — never a zero or a blank', () => {
    const absent = rowMod.createRow(provider({ id: 'qwen', displayName: 'Qwen Code', usageLogAbsent: true }), ctx(), NOW);
    assert.equal(byClass(absent.el, 'row__primary')[0].textContent, i18n.t('row.usageLogAbsent'));
    const pending = rowMod.createRow(provider({ id: 'kimi', displayName: 'Kimi' }), ctx({ isPending: () => true }), NOW);
    assert.equal(byClass(pending.el, 'row__primary')[0].getAttribute('data-kind'), 'pending');
    assert.doesNotMatch(byClass(pending.el, 'row__primary')[0].textContent, /\b0\b|\$/);
  });

  test('a reported cost as the main measure is never a bare amount', () => {
    const cost = {
      totalUsd: 1.5, byClass: { input: 1.5, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
      byModel: [], unpricedModels: [], sourceIncomplete: false, pricesAsOf: null,
      windowStart: new Date(NOW - 7 * 24 * HOUR).toISOString(), windowEnd: new Date(NOW).toISOString(), windowAnchored: false,
    };
    const row = rowMod.createRow(provider({ id: 'grok', displayName: 'Grok Build', weeklyCost: cost }), ctx(), NOW);
    const measure = byClass(row.el, 'row__primary')[0];
    assert.equal(measure.getAttribute('data-kind'), 'cost');
    assert.match(measure.textContent, /fatura değil/);
  });
});

test.describe('"Ayrıntılar"', () => {
  test('the card opens its details only when the panel says it is the open one', () => {
    let open = null;
    const c = ctx({ isExpanded: (id) => id === open, onToggleExpand: (id) => { open = open === id ? null : id; } });
    const p = provider({ fiveHour: win(62), sevenDay: win(41) });
    const row = rowMod.createRow(p, c, NOW);
    const detail = byClass(row.el, 'row__detail')[0];
    assert.equal(row.moreButton.getAttribute('aria-expanded'), 'false');
    row.moreButton.click();
    row.update(p, c, NOW);
    assert.equal(detail.hidden, false);
    assert.equal(row.moreButton.getAttribute('aria-expanded'), 'true');
    assert.equal(row.moreButton.getAttribute('aria-controls'), detail.getAttribute('id'));
    row.moreButton.click();
    row.update(p, c, NOW);
    assert.equal(detail.hidden, true);
  });

  test('a passive or loading card has no "Ayrıntılar" at all', () => {
    for (const status of ['passive', 'loading']) {
      const row = rowMod.createRow(provider({ status, connected: false }), ctx({ isExpanded: () => true }), NOW);
      assert.equal(row.moreButton.hidden, true, status);
      assert.equal(byClass(row.el, 'row__detail')[0].hidden, true, status);
    }
  });

  test('the cost block opens with "Bu bir fatura değil" whenever it shows a figure', () => {
    const cost = {
      totalUsd: 12.4, byClass: { input: 0, output: 12.4, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
      byModel: [], unpricedModels: [], sourceIncomplete: false, pricesAsOf: '2026-06-24',
      windowStart: new Date(NOW - 7 * 24 * HOUR).toISOString(), windowEnd: new Date(NOW).toISOString(), windowAnchored: false,
    };
    const row = rowMod.createRow(provider({ fiveHour: win(10), sevenDay: win(20), weeklyCost: cost }), ctx(), NOW);
    const block = byClass(row.el, 'cost')[0];
    const firstShown = block.childNodes.find((n) => n.nodeType === 1 && !n.hidden);
    assert.ok(cls(firstShown).includes('cost__frame'), 'the frame is not the first thing shown');
    assert.equal(firstShown.textContent, i18n.t('cost.notABill'));
  });

  test('the closed block names the week the figure covers', () => {
    const start = Date.parse('2026-09-24T10:00:00Z');
    const cost = {
      totalUsd: 12.4, byClass: { input: 0, output: 12.4, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
      byModel: [], unpricedModels: [], sourceIncomplete: false, pricesAsOf: '2026-06-24',
      windowStart: new Date(start).toISOString(), windowEnd: new Date(start + 7 * 24 * HOUR).toISOString(), windowAnchored: true,
    };
    const row = rowMod.createRow(provider({ fiveHour: win(10), sevenDay: win(20), weeklyCost: cost }), ctx(), NOW);
    const block = byClass(row.el, 'cost')[0];
    const period = byClass(block, 'cost__period')[0];
    assert.equal(period.hidden, false, 'the period is behind the disclosure');
    assert.equal(byClass(block, 'cost__detail')[0].hidden, true, 'the block is not closed');
    assert.match(period.textContent, /kota haftası/i);
    const shown = block.childNodes.filter((n) => n.nodeType === 1 && !n.hidden);
    assert.ok(cls(shown[1]).includes('cost__period'), 'the period is not right under the frame');
  });
});

test.describe('a stale card says so in words, not only in colour', () => {
  test('the title line carries "Güncel değil · <age>"', () => {
    const capturedAt = new Date(NOW - 22 * 60_000).toISOString();
    const row = rowMod.createRow(provider({ status: 'stale', fiveHour: win(62, { capturedAt }), sevenDay: win(41, { capturedAt }) }), ctx(), NOW);
    const chip = byClass(row.el, 'row__chip--stale')[0];
    assert.ok(chip, 'no stale chip');
    assert.equal(chip.textContent, i18n.t('row.staleChip', { age: i18n.t('dur.minutes', { m: 22 }) }));
    const line = byClass(row.el, 'row__line')[0];
    assert.ok(walk(line).includes(chip), 'the chip is not in the title line');
  });

  test('a fresh card has no chip', () => {
    const row = rowMod.createRow(provider({ fiveHour: win(62), sevenDay: win(41) }), ctx(), NOW);
    assert.equal(byClass(row.el, 'row__chip--stale').length, 0);
  });
});

test.describe('the first-run introduction (onboarding, 2026-09-30)', () => {
  let onb;
  test.before(async () => { onb = await mirror.load('components', 'onboarding.js'); });

  const claudeUnconnected = () => provider({
    connected: false, status: 'passive',
    setupAction: { kind: 'install-bridge', label: 'Bağla', detail: 'x' },
  });
  const state = (providers, over = {}) => ({
    setupCoachDismissed: false, hasData: true, view: 'main', onboardingStep: 0, consent: null,
    coachMessage: null, busy: [], enabledOverride: {}, enabledPending: [],
    snapshot: { providers }, ...over,
  });
  function mount() {
    const calls = [];
    const handle = onb.createOnboarding({
      onStep: (s) => calls.push(['step', s]),
      onDone: () => calls.push(['done']),
      onToggle: (id, on) => calls.push(['toggle', id, on]),
      onConnect: (id) => calls.push(['connect', id]),
    });
    const shown = (n) => { for (let x = n; x; x = x.parentNode) if (x.hidden) return false; return true; };
    const buttons = () => walk(handle.el).filter((n) => n.tagName === 'BUTTON' && shown(n) && cls(n).includes('btn'));
    const press = (label) => buttons().find((b) => b.textContent === label).click();
    return { handle, calls, buttons, press };
  }

  test('shown on a fresh install only, and never inside Settings', () => {
    assert.equal(onb.onboardingActive(state([])), true);
    assert.equal(onb.onboardingActive(state([], { setupCoachDismissed: true })), false);
    assert.equal(onb.onboardingActive(state([], { view: 'settings' })), false);
  });

  test('step 1 welcomes and makes the privacy promise; "İleri" moves on, "Atla" ends it', () => {
    const m = mount();
    m.handle.update(state([claudeUnconnected()]));
    assert.equal(m.handle.el.hidden, false);
    assert.match(m.handle.el.textContent, new RegExp(i18n.t('onboarding.welcome.privacyTitle')));
    m.press(i18n.t('onboarding.next'));
    m.press(i18n.t('onboarding.skip'));
    assert.deepEqual(m.calls, [['step', 1], ['done']]);
  });

  test('step 2 lists the tools found here with a switch each, and names the missing ones', () => {
    const codex = provider({ id: 'codex', displayName: 'Codex', connected: true, status: 'ok', enabled: false });
    const kimi = provider({ id: 'kimi', displayName: 'Kimi', connected: false, status: 'passive',
      setupAction: { kind: 'not-installed', label: 'Ekle', detail: 'x' } });
    const m = mount();
    m.handle.update(state([claudeUnconnected(), codex, kimi], { onboardingStep: 1 }));
    const tools = walk(m.handle.el).filter((n) => cls(n).includes('onb__tool') && n.tagName === 'LI');
    assert.deepEqual(tools.map((n) => n.getAttribute('data-provider')), ['claude', 'codex']);
    const codexSwitch = walk(tools[1]).find((n) => n.getAttribute('role') === 'switch');
    assert.equal(codexSwitch.getAttribute('aria-checked'), 'false');
    codexSwitch.click();
    assert.deepEqual(m.calls, [['toggle', 'codex', true]]);
    assert.match(m.handle.el.textContent, /Kimi/);
    // Updated in place: the switch the user pressed is the same element afterwards.
    m.handle.update(state([claudeUnconnected(), codex, kimi], { onboardingStep: 1, enabledOverride: { codex: true } }));
    const again = walk(m.handle.el).find((n) => n.getAttribute('role') === 'switch' && n === codexSwitch);
    assert.ok(again, 'the switch was rebuilt under the user');
    assert.equal(codexSwitch.getAttribute('aria-checked'), 'true');
  });

  test('step 3 offers "Bağla" while Claude Code is not connected, and "Başla" once it is', () => {
    const m = mount();
    m.handle.update(state([claudeUnconnected()], { onboardingStep: 2 }));
    m.press(i18n.t('coach.connect'));
    assert.deepEqual(m.calls, [['connect', 'claude']]);
    const connected = provider({ connected: true, status: 'ok', fiveHour: win(10), sevenDay: win(20) });
    const m2 = mount();
    m2.handle.update(state([connected], { onboardingStep: 2 }));
    assert.match(m2.handle.el.textContent, new RegExp(i18n.t('onboarding.ready.title')));
    m2.press(i18n.t('onboarding.finish'));
    assert.deepEqual(m2.calls, [['done']]);
  });

  test('while the consent question is open, it alone asks', () => {
    const m = mount();
    m.handle.update(state([claudeUnconnected()], {
      onboardingStep: 2,
      consent: { providerId: 'claude', providerName: 'Claude Code', label: 'Bağla', detail: 'x', origin: 'coach' },
    }));
    assert.equal(m.buttons().length, 0, 'the step buttons compete with the consent box');
  });

  test('the panel no longer shows cards under the introduction', () => {
    assert.equal(typeof panelMod.createPanel, 'function');
    assert.equal(panelMod.coachProviderOf, undefined, 'the old single first-run card is gone');
  });
});