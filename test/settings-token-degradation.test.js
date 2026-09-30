'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { installDom, mirrorRenderer, walk } = require('./helpers/fake-dom');

/**
 * THE TOKEN COUNTS SURVIVE AN UNUSABLE MODEL LIST
 * (src/renderer/src/components/settings.ts, `renderRow` / `renderDisclosure`).
 *
 * Two independent things hang under a period in Toplam Kullanım — the per-model
 * cost split, and the per-tool token counts. `renderTokenSubtotals` used to be
 * built INSIDE `renderDisclosure`, which is only reached when
 * `period.byModel.length > 0`, so a period with real `tokensByProvider` and an
 * empty `byModel` rendered its cost and NO counts at all, with no statement that
 * anything was missing.
 *
 * WHY THAT IS REACHABLE, and not a hypothetical. Main never emits it
 * (`src/core/history.js` always produces a non-empty `byModel` when the pricer
 * returned a cost), but this renderer's own boundary can: `periodModelCost` in
 * `sanitize.ts` DROPS any entry whose `model` name or `provider` id fails
 * validation, so a payload whose entries all fail arrives here as
 * `byModel: []` with the token map intact. Deleting the owner's headline figure
 * for this feature over an unrelated validation failure is the opposite of the
 * degradation rule the rest of that file follows: one bad field must not delete
 * something the user could still have been shown truthfully.
 *
 * Failure mode without this test: silent. The figure is simply absent, which is
 * indistinguishable from a period that had no usage — so it needed a test that
 * asserts PRESENCE, not one that asserts a value.
 *
 * Mounted on the shared DOM shim, the same way `settings-accordion.test.js` and
 * `settings-token-subtotals.test.js` mount this component. Geometry stays with
 * the electron render suite.
 */

const NOW = Date.parse('2026-09-14T12:00:00.000Z');

let mirror;
let restoreDom;
let settingsMod;
let storeMod;
let i18n;
let fmt;

test.before(async () => {
  restoreDom = installDom();
  mirror = mirrorRenderer();
  settingsMod = await mirror.load('components', 'settings.js');
  storeMod = await mirror.load('store.js');
  i18n = await mirror.load('i18n.js');
  fmt = await mirror.load('format.js');
  i18n.setLocale('tr', 'tr-TR');
});

test.after(() => {
  if (restoreDom) restoreDom();
  if (mirror) mirror.cleanup();
});

const tk = (billable) => ({
  input: billable, output: 0, cacheWrite: 0, cacheRead: 1_000_000, billable,
});

function period(over = {}) {
  return {
    key: '2026-09',
    startsAt: '2026-09-01T00:00:00.000Z',
    endsAt: '2026-09-30T00:00:00.000Z',
    costUsd: 12.5,
    byClass: { input: 1, output: 2, cacheWrite5m: 3, cacheWrite1h: 4, cacheRead: 2.5 },
    tokensByProvider: { claude: tk(10_480_000), codex: tk(2_050_000) },
    tokenFloorCausesByProvider: {},
    byModel: [
      { provider: 'claude', model: 'claude-opus-5', costUsd: 9, isFloor: false, tokens: tk(9_600_000) },
      { provider: 'codex', model: 'gpt-5.6-sol', costUsd: 3.5, isFloor: false, tokens: tk(2_050_000) },
    ],
    isFloor: false,
    unpricedModels: [],
    hasUsage: true,
    ...over,
  };
}

function history(over = {}, histOver = {}) {
  return {
    weeks: [],
    months: [period(over)],
    usageProviders: ['claude', 'codex'],
    incompleteProviders: [],
    floorCausesByProvider: {},
    pricesAsOfByProvider: { claude: '2026-06-24', codex: '2026-09-16' },
    ...histOver,
  };
}

const prov = (id, displayName) => ({
  id, displayName, accent: '#888', experimental: false,
  enabled: true, connected: true, status: 'ok', planLabel: null,
  fiveHour: null, sevenDay: null, tokens: null,
  weeklyTokens: null, weeklyTokensWindowAnchored: null, weeklyTokenFloorCauses: [],
  burnRatePerHour: null, byModel: [], weeklyCost: null, setupAction: null, lastGoodAt: null,
});

const PROVIDERS = [prov('claude', 'Claude Code'), prov('codex', 'Codex')];

function mount(hist, providers = PROVIDERS) {
  const handle = settingsMod.createSettings({
    onToggle() {}, onTheme() {}, onBack() {}, onLanguage() {}, onGrain() {},
  });
  const store = new storeMod.Store();
  store.set({
    hasData: true,
    snapshot: {
      generatedAt: new Date(NOW).toISOString(),
      providers,
      usageHistory: hist,
      pendingUsage: [],
    },
  });
  handle.render(store.get(), providers);
  return handle;
}

/**
 * EXACT class-token match, not `includes`. `usage__toggle` is a prefix of
 * `usage__toggle-label`, so a substring test counts the label as a second
 * toggle and the control case fails for the wrong reason.
 */
const hasClass = (node, cls) => (node.getAttribute('class') || '').split(/\s+/).includes(cls);

function read(hist, histOver) {
  if (histOver) Object.assign(hist, histOver);
  const nodes = walk(mount(hist).el);
  const block = nodes.find((n) => hasClass(n, 'usage__tokens') && n.getAttribute('role') === 'list');
  const rows = block
    ? walk(block).filter((n) => hasClass(n, 'usage__tokens-row'))
    : [];
  const textIn = (node, cls) => {
    const hit = walk(node).find((n) => hasClass(n, cls));
    return hit ? hit.textContent : null;
  };
  return {
    // Present at all? This is the assertion the missing state needed.
    present: !!block,
    // Visible, or waiting behind a disclosure?
    hidden: block ? block.hidden === true : null,
    toggles: nodes.filter((n) => hasClass(n, 'usage__toggle')).length,
    modelRows: nodes.filter((n) => hasClass(n, 'usage__model')).length,
    amounts: nodes.filter((n) => hasClass(n, 'usage__amount')).map((n) => n.textContent),
    counts: rows.map((r) => [r.getAttribute('data-provider'), textIn(r, 'usage__tokens-count')]),
    // The removed glosses of "en az" and the "why" toggle (owner, 2026-09-23).
    leads: nodes
      .filter((n) => hasClass(n, 'usage__note-lead') && n.hidden !== true)
      .map((n) => n.textContent),
    whys: nodes.filter((n) => hasClass(n, 'usage__why') || hasClass(n, 'cost__why')).length,
    lead: (() => {
      const n = nodes.find((x) => hasClass(x, 'usage__tokens-lead'));
      return n ? n.textContent : null;
    })(),
    rowTitles: rows.map((r) => r.getAttribute('title')),
    // Every visible text in the section, for the marker scan.
    text: nodes.filter((n) => n.hidden !== true).map((n) => n.textContent).join('\n'),
  };
}

test.describe('a period with counts shows them even when its model list is unusable', () => {
  test('control: with a model list, the counts exist and sit inside the disclosure', () => {
    const out = read(history());
    assert.equal(out.present, true);
    assert.equal(out.toggles, 1, 'a period with models offers its per-model disclosure');
    // Open by default since only the chosen period is on screen (owner, 2026-09-28).
    assert.equal(out.hidden, false, 'open by default, with the rows it summarises');
    assert.deepEqual(out.counts, [['claude', fmt.tokens(10_480_000)], ['codex', fmt.tokens(2_050_000)]]);
  });

  test('with byModel empty, the counts are still rendered — and VISIBLE', () => {
    // The defect: this state used to render the cost and no counts at all.
    const out = read(history({ byModel: [] }));
    assert.equal(out.present, true, 'the counts must not disappear with the model list');
    assert.deepEqual(out.counts, [['claude', fmt.tokens(10_480_000)], ['codex', fmt.tokens(2_050_000)]]);
    // Nothing to expand, so nothing is hidden behind a toggle that would not
    // exist: a "0 model" disclosure would invite the reader to open nothing.
    assert.equal(out.hidden, false);
    assert.equal(out.toggles, 0);
    assert.equal(out.modelRows, 0);
  });

  test('the cost figure is unaffected either way — the two are independent', () => {
    const withModels = read(history());
    const without = read(history({ byModel: [] }));
    assert.deepEqual(without.amounts, withModels.amounts);
  });

  test('a period with neither models nor counts grows nothing at all', () => {
    // The empty period must not gain an empty heading or a dangling toggle.
    const out = read(history({ byModel: [], tokensByProvider: {}, costUsd: 0, hasUsage: false }));
    assert.equal(out.present, false);
    assert.equal(out.toggles, 0);
  });

  test('no "en az" gloss, "why" toggle or floor word appears, whatever floors main sends', () => {
    // The owner removed the floor marker (2026-09-23). Every combination the
    // old glosses keyed on — neither floor, a cost floor, a token floor, both —
    // must now read the same way: the figures, and no sentence about bounds.
    const cases = [
      read(history()),
      read(history(), { floorCausesByProvider: { codex: ['unpriced'] } }),
      read(history({ tokenFloorCausesByProvider: { codex: ['unrecorded-writes'] } })),
      read(
        history({ isFloor: true, tokenFloorCausesByProvider: { codex: ['unrecorded-writes'] } }),
        { floorCausesByProvider: { codex: ['unpriced'] } },
      ),
    ];
    for (const out of cases) {
      assert.deepEqual(out.leads, []);
      assert.equal(out.whys, 0, 'a "Neden en az?" toggle came back');
      assert.doesNotMatch(out.text, /\ben az\b/i);
      assert.doesNotMatch(out.text, /alt sınır/);
      assert.doesNotMatch(out.text, /~/);
    }
  });

  test('the grey lead line is gone; the cache-read split stays in each row title', () => {
    // The lead ("faturalanan token, önbellek okuma hariç; toplanmaz · takvim
    // haftası") was removed at the owner's request. What it stated about cache
    // reads is not lost: each count's title names cache reads as their own
    // class, marked as outside the billable total.
    const out = read(history());
    assert.equal(out.lead, null, 'the lead line is back');
    assert.equal(out.rowTitles.length, 2);
    for (const title of out.rowTitles) {
      assert.ok(title, 'a count lost its class breakdown');
      assert.match(title, /Önbellek okuma/);
      assert.match(title, /faturalanan toplama dahil değil/);
    }
  });

  test('a tool absent from usageProviders still has its count shown, not dropped', () => {
    // Order comes from `usageProviders`; membership must not gate PRESENCE, or a
    // main that forgot to list a tool would silently lose its figure.
    const hist = history();
    hist.usageProviders = ['claude'];
    const out = read(hist);
    assert.deepEqual(out.counts.map(([id]) => id), ['claude', 'codex']);
  });
});

/* ------------------------------------------------ the plan the user tells us */

/**
 * `settings.plan.*` — the control that sets `ProviderSnapshot.planLabel`.
 *
 * The value is the USER'S OWN STATEMENT: nothing local reports a plan and no
 * vendor tells us, so the whole feature rests on not dressing that statement up
 * as something we verified. Since 2026-09-23 it is a CLOSED list (the owner's
 * call), and the rules that keep it honest are structural:
 *
 *   - nothing is preselected and no tool has a default: the first option is
 *     "Belirtilmedi", the empty value. A filled-in "Max 20x" is a guess with
 *     our name on it.
 *   - a tool we know no plans for gets no control at all.
 *   - a stored label that is not in the list (typed into the old free-text
 *     field) is still offered while it is stored, so it is never silently
 *     dropped.
 *   - it commits on `change` through the same IPC (`onPlanLabel`).
 */
test.describe('the plan control is a closed list that makes no claim', () => {
  const PLAN_PROVIDERS = [
    prov('claude', 'Claude Code'),
    prov('codex', 'Codex'),
    prov('kimi', 'Kimi'),
    prov('antigravity', 'Antigravity'),
  ];

  const itemsOf = (providers = PLAN_PROVIDERS, ctxOver = {}) => {
    const handle = settingsMod.createSettings({
      onToggle() {}, onTheme() {}, onBack() {}, onLanguage() {}, onGrain() {},
      onPlanLabel() {},
      ...ctxOver,
    });
    const store = new storeMod.Store();
    store.set({
      hasData: true,
      snapshot: { generatedAt: new Date(NOW).toISOString(), providers, usageHistory: history(), pendingUsage: [] },
    });
    handle.render(store.get(), providers);
    return walk(handle.el).filter((n) => hasClass(n, 'settings__item'));
  };

  const planIn = (item) => {
    const block = walk(item).find((n) => hasClass(n, 'settings__plan'));
    const select = walk(item).find((n) => hasClass(n, 'settings__plan-select'));
    const options = select ? walk(select).filter((n) => n.tagName === 'OPTION') : [];
    return {
      block,
      select,
      shown: !!block && block.hidden !== true,
      values: options.map((o) => o.getAttribute('value')),
      labels: options.map((o) => o.textContent),
    };
  };
  const byId = (items, id) => items.find((n) => n.getAttribute('data-provider') === id);

  test('it is a <select>, and the free-text field and its datalist are gone', () => {
    const item = byId(itemsOf(), 'claude');
    const { select } = planIn(item);
    assert.ok(select, 'no plan control');
    assert.equal(select.tagName, 'SELECT');
    assert.equal(walk(item).some((n) => n.tagName === 'DATALIST'), false);
    assert.equal(walk(item).some((n) => n.tagName === 'INPUT' && n.getAttribute('type') === 'text'), false);
  });

  test('the first option is "Belirtilmedi" with the empty value, then the known plans', () => {
    const { values, labels } = planIn(byId(itemsOf(), 'claude'));
    assert.equal(values[0], '');
    assert.equal(labels[0], i18n.t('settings.plan.placeholder'));
    assert.deepEqual(values.slice(1), ['Pro', 'Max 5x', 'Max 20x']);
    assert.deepEqual(labels.slice(1), values.slice(1), 'a plan name is shown as itself');
  });

  test('nothing is preselected, for any tool', () => {
    for (const item of itemsOf()) {
      const { select, shown } = planIn(item);
      if (!shown) continue;
      assert.equal(select.value, '', 'a plan was chosen for the user');
    }
  });

  test('a tool with no known plans gets no control at all', () => {
    const items = itemsOf();
    assert.equal(planIn(byId(items, 'claude')).shown, true);
    assert.equal(planIn(byId(items, 'codex')).shown, true);
    assert.equal(planIn(byId(items, 'kimi')).shown, false, 'Kimi shows a plan control');
    assert.equal(planIn(byId(items, 'antigravity')).shown, false, 'Antigravity shows a plan control');
  });

  test('a stored label from the list is selected', () => {
    const providers = PLAN_PROVIDERS.map((p) => (p.id === 'claude' ? { ...p, planLabel: 'Max 20x' } : p));
    const { select, values } = planIn(byId(itemsOf(providers), 'claude'));
    assert.equal(select.value, 'Max 20x');
    assert.deepEqual(values, ['', 'Pro', 'Max 5x', 'Max 20x'], 'no extra option for a known plan');
  });

  test('a stored label NOT in the list is kept as an extra option, not dropped', () => {
    const providers = PLAN_PROVIDERS.map((p) => (p.id === 'claude' ? { ...p, planLabel: 'Team Premium' } : p));
    const { select, values } = planIn(byId(itemsOf(providers), 'claude'));
    assert.equal(select.value, 'Team Premium');
    assert.deepEqual(values, ['', 'Pro', 'Max 5x', 'Max 20x', 'Team Premium']);
  });

  test('a label stored for a tool with no known plans keeps the control, so it can be cleared', () => {
    const providers = PLAN_PROVIDERS.map((p) => (p.id === 'kimi' ? { ...p, planLabel: 'Andante' } : p));
    const { shown, select, values } = planIn(byId(itemsOf(providers), 'kimi'));
    assert.equal(shown, true);
    assert.equal(select.value, 'Andante');
    assert.deepEqual(values, ['', 'Andante']);
  });

  test('a change commits the chosen value through onPlanLabel, once', () => {
    const calls = [];
    const item = byId(itemsOf(PLAN_PROVIDERS, { onPlanLabel: (id, label) => calls.push([id, label]) }), 'codex');
    const { select } = planIn(item);
    select.value = 'Pro';
    select.dispatch('change');
    select.dispatch('change');
    assert.deepEqual(calls, [['codex', 'Pro']], 'the same value was written twice');
    select.value = '';
    select.dispatch('change');
    assert.deepEqual(calls, [['codex', 'Pro'], ['codex', '']], '"Belirtilmedi" must clear the label');
  });

  test('the hint says what "Otomatik" means and that the user may choose', () => {
    // 2026-09-30: the plan is read from the tool's own record when there is
    // one; the hint says so, and that the user's choice overrides it.
    const item = byId(itemsOf(), 'claude');
    const hint = walk(item).find((n) => hasClass(n, 'settings__plan-hint'));
    assert.ok(hint, 'no hint');
    assert.match(hint.textContent, /Otomatik/, 'it does not explain the automatic value');
    assert.match(hint.textContent, /kendiniz seçebilirsiniz/i, 'it does not say the user may choose');
    assert.doesNotMatch(hint.textContent, /kendiniz yaz/i, 'the hint still offers free text');
    assert.ok(hint.textContent.length <= 110, hint.textContent);
    const { select } = planIn(item);
    assert.equal(select.getAttribute('aria-describedby'), hint.getAttribute('id'));
  });
});
