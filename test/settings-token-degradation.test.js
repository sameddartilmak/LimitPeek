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
  keyCapable: false, keyState: 'none', keyStoredAt: null, creditUsage: null,
  enabled: true, connected: true, status: 'ok', planLabel: null,
  fiveHour: null, sevenDay: null, tokens: null,
  weeklyTokens: null, weeklyTokensWindowAnchored: null, weeklyTokenFloorCauses: [],
  burnRatePerHour: null, byModel: [], weeklyCost: null, setupAction: null, lastGoodAt: null,
});

const PROVIDERS = [prov('claude', 'Claude Code'), prov('codex', 'Codex')];

function mount(hist, providers = PROVIDERS) {
  const handle = settingsMod.createSettings({
    onToggle() {}, onTheme() {}, onBack() {}, onLanguage() {}, onGrain() {},
    onAddKey() {}, onOpenTokenPage() {}, onRemoveKey() {},
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
    // The glosses of "en az". One is about the amount, one about the count.
    leads: nodes
      .filter((n) => hasClass(n, 'usage__note-lead') && n.hidden !== true)
      .map((n) => n.textContent),
    lead: (() => {
      const n = nodes.find((x) => hasClass(x, 'usage__tokens-lead'));
      return n ? n.textContent : null;
    })(),
  };
}

test.describe('a period with counts shows them even when its model list is unusable', () => {
  test('control: with a model list, the counts exist and sit behind the disclosure', () => {
    const out = read(history());
    assert.equal(out.present, true);
    assert.equal(out.toggles, 1, 'a period with models offers its per-model disclosure');
    assert.equal(out.hidden, true, 'collapsed by default, with the rows it summarises');
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

  test('the COUNT gloss appears only when a token floor is actually on screen', () => {
    // "En az" does two jobs on this screen — a bounded amount and a bounded
    // count — and the cost sentence ("the real cost may be higher") is not true
    // of a token figure. The second gloss is therefore conditional: without it
    // the pair would be a standing wall of text, and asserting "two leads"
    // unconditionally would let that regress unnoticed.
    // Neither kind of floor: neither gloss. An explanation with nothing on
    // screen to explain is the wall of text the owner objected to.
    const none = read(history());
    assert.deepEqual(none.leads, []);

    // A COST floor alone brings the cost sentence only.
    const costOnly = read(history(), { floorCausesByProvider: { codex: ['unpriced'] } });
    assert.equal(costOnly.leads.length, 1);
    assert.match(costOnly.leads[0], /maliyet/, 'the cost gloss is about the amount');

    // A TOKEN floor alone brings the count sentence only — the two are
    // independent claims and neither may stand in for the other.
    const tokenOnly = read(history({ tokenFloorCausesByProvider: { codex: ['unrecorded-writes'] } }));
    assert.equal(tokenOnly.leads.length, 1);
    assert.match(tokenOnly.leads[0], /sayı/, 'the count gloss is about the count');

    const both = read(
      history({ tokenFloorCausesByProvider: { codex: ['unrecorded-writes'] } }),
      { floorCausesByProvider: { codex: ['unpriced'] } },
    );
    assert.equal(both.leads.length, 2);
  });

  test('the cache-read exclusion is VISIBLE text, not only a title attribute', () => {
    // The defect this pins: `row.tokens.cacheRead` carries the claim that the
    // headline figure excludes cache reads — ~98% of raw volume — and it was
    // rendered ONLY inside `tokensTitle()`, i.e. only into a `title`, on both
    // the row and this panel. A hover affordance is not a channel: on the panel
    // surface it is not even established that Chromium paints a tooltip, and a
    // catalog pin that passes on a string nobody can read is a dead guard.
    //
    // So this reads the RENDERED TEXT of the lead that sits directly above every
    // count, and it deliberately does not look at any attribute.
    const out = read(history());
    assert.ok(out.lead, 'the subtotal list grew no lead line');
    assert.match(out.lead, /faturalanan/, 'the counts are not said to be billable-only');
    assert.match(out.lead, /önbellek okuma hariç/, 'the cache-read exclusion is not stated visibly');
    // And the other three claims on the same line survive the addition.
    assert.match(out.lead, /[Aa]raç başına/);
    assert.match(out.lead, /toplanmaz/);
    assert.match(out.lead, /takvim haftası|Pzt/);
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
 * as something we verified. The rules that keeps are structural, which is why
 * they are asserted here rather than left to review:
 *
 *   - nothing is preselected and no tool has a default. A filled-in "Max 20x"
 *     is a guess with our name on it.
 *   - the field accepts free text, so a plan we have never heard of is still
 *     sayable. Suggestions go stale every time a vendor renames a tier.
 *   - it follows main's stored value whenever the user is not typing, which is
 *     how normalisation (trim, collapse, cap at 24) becomes visible without a
 *     message — and how a refused write puts the old value back.
 */
test.describe('the plan control offers help without making a claim', () => {
  const itemOf = (hist, providers) => {
    const handle = mount(hist, providers);
    return walk(handle.el).filter((n) => hasClass(n, 'settings__item'));
  };

  const planIn = (item) => {
    const input = walk(item).find((n) => hasClass(n, 'settings__plan-input'));
    const list = walk(item).find((n) => n.tagName === 'DATALIST');
    return {
      input,
      list,
      options: list ? walk(list).filter((n) => n.tagName === 'OPTION').map((o) => o.getAttribute('value')) : [],
    };
  };

  test('every tool gets a control, not Claude alone', () => {
    const items = itemOf(history());
    assert.equal(items.length, PROVIDERS.length);
    for (const item of items) assert.ok(planIn(item).input, 'a tool has no plan control');
  });

  test('nothing is preselected, for any tool', () => {
    for (const item of itemOf(history())) {
      const { input } = planIn(item);
      assert.equal(input.value ?? '', '', 'a plan was filled in for the user');
      assert.equal(input.getAttribute('value'), null);
    }
  });

  test('it is a free-text field with suggestions, never a closed list', () => {
    const { input, list, options } = planIn(itemOf(history())[0]);
    assert.equal(input.tagName, 'INPUT', 'a <select> would deny a plan we have not heard of');
    assert.ok(list, 'no datalist to suggest from');
    assert.equal(input.getAttribute('list'), list.getAttribute('id'));
    assert.ok(options.length > 0, 'Claude has known plans and should suggest them');
  });

  test('a stored label is shown back, and the cap main enforces is declared', () => {
    const withPlan = PROVIDERS.map((p) => (p.id === 'claude' ? { ...p, planLabel: 'Max 20x' } : p));
    const { input } = planIn(itemOf(history(), withPlan)[0]);
    assert.equal(input.value, 'Max 20x');
    assert.equal(input.getAttribute('maxlength'), '24');
  });

  test('the hint keeps the free-text path open and says we cannot read it', () => {
    const item = itemOf(history())[0];
    const hint = walk(item).find((n) => hasClass(n, 'settings__plan-hint'));
    assert.ok(hint, 'no hint');
    assert.match(hint.textContent, /kendiniz yaz/i, 'the free-text path is not stated');
    assert.match(hint.textContent, /okuyamıyoruz/i, 'it does not say the plan cannot be read from the tool');
  });
});
