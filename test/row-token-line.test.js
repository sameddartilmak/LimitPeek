'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { installDom, mirrorRenderer, walk } = require('./helpers/fake-dom');

/**
 * THE ROW'S VISIBLE TOKEN LINE (src/renderer/src/components/row.ts).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The weekly-token change put FOUR independent presence rules on one line of
 * text — the 5-hour count, the weekly count, that count's window label, and its
 * cause list — each with its own null state, and every one of them decided in
 * `row.ts`, which `npm test` did not load at all. Measured by mutation on the
 * predecessor of this design: breaking the A3.19 no-figure rule so an unread
 * week read "en az 0 token", relabelling the five-hour compatibility figure as
 * weekly, and folding the settings subtotal out of the capped `byModel` rows
 * ALL left the suite fully green. The only net was the electron render suite,
 * which is a separate GUI run.
 *
 * So the line is asserted here, in Node, against the REAL component mounted on
 * the shared DOM shim (`test/helpers/fake-dom.js`, as `app-preferences.test.js`
 * does). Pixels, clipping and wrapping stay with the render suite — those need a
 * compositor. WORDS are decided by branches, and branches need no browser.
 *
 * Expectations are built from the catalog through the same `t()` the component
 * uses, so each assertion pins WHICH KEY the row chose — the actual decision —
 * and survives a copy edit (ADR-004).
 */

const NOW = Date.parse('2026-09-14T12:00:00.000Z');
const HOUR = 3600e3;

let mirror;
let restoreDom;
let rowMod;
let i18n;
let fmt;
let causesMod;

test.before(async () => {
  restoreDom = installDom();
  mirror = mirrorRenderer();
  rowMod = await mirror.load('components', 'row.js');
  i18n = await mirror.load('i18n.js');
  fmt = await mirror.load('format.js');
  causesMod = await mirror.load('floor-causes.js');
  i18n.setLocale('tr', 'tr-TR');
});

test.after(() => {
  if (restoreDom) restoreDom();
  if (mirror) mirror.cleanup();
});

const tk = (billable, over = {}) => ({
  input: billable, output: 0, cacheWrite: 0, cacheRead: 9_000_000, billable, ...over,
});
const ZERO = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, billable: 0 };

/** A weekly cost carrying only what the token line reads off it. */
const cost = (over = {}) => ({
  totalUsd: 12.4,
  byClass: { input: 0, output: 12.4, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
  byModel: [], unpricedModels: [],
  fallbackWriteEvents: 0, cacheWriteEvents: 0, unrecordedWriteEvents: 0,
  assumedTierEvents: 0, fastRequestedEvents: 0, unrecordedCalls: false,
  longPromptFloorEvents: 0, toolTokenEvents: 0,
  sourceIncomplete: false,
  pricesAsOf: '2026-06-24',
  windowStart: new Date(NOW - 7 * 24 * HOUR).toISOString(),
  windowEnd: new Date(NOW).toISOString(),
  windowAnchored: false,
  ...over,
});

const win = (resetsAt) => ({
  usedPercentage: 24, certainty: 'known', resetsAt, capturedAt: null, billableSinceCapture: null, absence: null,
});

function provider(over = {}) {
  return {
    id: 'codex', displayName: 'Codex', accent: '#10A37F', experimental: false,
    keyCapable: false, keyState: 'none', keyStoredAt: null, creditUsage: null,
    enabled: true, connected: true, status: 'ok', planLabel: null,
    fiveHour: null, sevenDay: null,
    tokens: null,
    weeklyTokens: null,
    weeklyTokensWindowAnchored: null,
    weeklyTokenFloorCauses: [],
    burnRatePerHour: null, byModel: [], weeklyCost: null, setupAction: null, lastGoodAt: null,
    ...over,
  };
}

const ctx = () => ({
  onRetry() {}, onSetup() {}, onAddKey() {}, onOpenTokenPage() {},
  isBusy: () => false, attachGrip() {}, isTrayRow: () => false, isPending: () => false,
  generatedAt: new Date(NOW).toISOString(), staleOverride: false,
});

/** The row's meta line as the user reads it. */
function metaOf(over) {
  const handle = rowMod.createRow(provider(over), ctx(), NOW);
  const meta = walk(handle.el).find((n) => (n.getAttribute('class') || '').includes('row__meta'));
  assert.ok(meta, 'the row grew no meta line at all');
  return meta.textContent;
}

/** The weekly line as the component composes it, for exact-match expectations. */
const labelled = (key, value) => i18n.t(key, { value });
const withCause = (line, cause) => i18n.t('row.tokens.floorCause', { value: line, cause: causesMod.floorCauseClause(cause) });

/* ------------------------------------------------- the window label's source */

test.describe('the weekly count names its window, and reads that from ONE field', () => {
  test('anchored true is a quota week', () => {
    const text = metaOf({ weeklyTokens: tk(2_050_000), weeklyTokensWindowAnchored: true });
    assert.equal(text, labelled('row.tokens.quotaWeek', fmt.tokens(2_050_000)));
  });

  test('anchored false is the trailing seven days', () => {
    const text = metaOf({ weeklyTokens: tk(2_050_000), weeklyTokensWindowAnchored: false });
    assert.equal(text, labelled('row.tokens.last7', fmt.tokens(2_050_000)));
  });

  test('a QUIET week still names its window, with no cost block to read it from', () => {
    // The state that killed `weeklyCost.windowAnchored` as the source: nothing
    // priced, so there is no cost object, while a present count still has to say
    // which seven days it covers.
    const text = metaOf({ weeklyTokens: tk(2_050_000), weeklyTokensWindowAnchored: true, weeklyCost: null });
    assert.equal(text, labelled('row.tokens.quotaWeek', fmt.tokens(2_050_000)));
  });

  test('a blanked seven-day window does not downgrade an anchored label', () => {
    // The reachable divergence: `windowFrom` returns an unknown window (so
    // `resetsAt` is null) whenever the capture carries no percentage, while the
    // anchor is computed from the raw reading and does not consult it. A label
    // derived from `resetsAt` would under-claim a real quota week here.
    const text = metaOf({
      weeklyTokens: tk(2_050_000),
      weeklyTokensWindowAnchored: true,
      sevenDay: { usedPercentage: null, certainty: 'unknown', resetsAt: null, capturedAt: null, absence: 'not-supplied' },
    });
    assert.equal(text, labelled('row.tokens.quotaWeek', fmt.tokens(2_050_000)));
  });

  test('and a stated reset instant does not promote a trailing label', () => {
    const text = metaOf({
      weeklyTokens: tk(2_050_000),
      weeklyTokensWindowAnchored: false,
      sevenDay: win(new Date(NOW + 3 * 24 * HOUR).toISOString()),
    });
    assert.equal(text, labelled('row.tokens.last7', fmt.tokens(2_050_000)));
  });

  test('null (unscanned window) states the SPAN and claims nothing about its edges', () => {
    const text = metaOf({ weeklyTokens: tk(2_050_000), weeklyTokensWindowAnchored: null });
    assert.equal(text, labelled('row.tokens.weekly', fmt.tokens(2_050_000)));
  });

  test('the visible figure is the WEEK\'s, never the five hours beside it', () => {
    const text = metaOf({ tokens: tk(410_000), weeklyTokens: tk(2_050_000), weeklyTokensWindowAnchored: true });
    assert.ok(text.includes(fmt.tokens(2_050_000)), text);
    assert.ok(!text.includes(fmt.tokens(410_000)), text);
  });
});

/* ------------------------------------------------------------ the three states */

test.describe('three states, three renderings: counted, unread, unscanned', () => {
  test('a MEASURED zero prints as a zero, under its own window label', () => {
    // Our reading succeeded and its answer was zero. Hiding it would make the
    // row indistinguishable from a tool we never scanned.
    const text = metaOf({ weeklyTokens: { ...ZERO }, weeklyTokensWindowAnchored: true });
    assert.equal(text, labelled('row.tokens.quotaWeek', fmt.tokens(0)));
  });

  test('an UNREAD week reads "could not be counted" instead', () => {
    const text = metaOf({
      weeklyTokens: { ...ZERO },
      weeklyTokensWindowAnchored: true,
      weeklyCost: cost({ sourceIncomplete: true }),
    });
    assert.equal(text, i18n.t('row.tokens.uncounted'));
  });

  test('the two are told apart by sourceIncomplete alone, not by the zero', () => {
    const base = { weeklyTokens: { ...ZERO }, weeklyTokensWindowAnchored: false };
    assert.notEqual(
      metaOf({ ...base, weeklyCost: cost({ sourceIncomplete: false }) }),
      metaOf({ ...base, weeklyCost: cost({ sourceIncomplete: true }) }),
      'a read zero and an unread zero must not render identically',
    );
  });

  test('an unread week never prints "en az 0"', () => {
    const text = metaOf({
      weeklyTokens: { ...ZERO },
      weeklyTokenFloorCauses: ['unread-range'],
      weeklyCost: cost({ sourceIncomplete: true }),
    });
    assert.equal(text, i18n.t('row.tokens.uncounted'));
    assert.equal(/\b0\b/.test(text), false, text);
  });

  test('an unscanned week shows no weekly figure at all', () => {
    const text = metaOf({ weeklyTokens: null, weeklyTokensWindowAnchored: null, tokens: null });
    for (const key of ['row.tokens.quotaWeek', 'row.tokens.last7', 'row.tokens.weekly']) {
      assert.equal(text.includes(i18n.t(key, { value: fmt.tokens(0) })), false, `${key} in: ${text}`);
    }
    assert.equal(text.includes(i18n.t('row.tokens.uncounted')), false, text);
  });

  test('a cache-read-only week keeps its figure — billable zero is not "no count"', () => {
    const tkCR = { ...ZERO, cacheRead: 9_000_000 };
    const text = metaOf({ weeklyTokens: tkCR, weeklyTokensWindowAnchored: false });
    assert.equal(text, labelled('row.tokens.last7', fmt.tokens(0)));
  });
});

/* ------------------------------------------------------------------- "en az" */

test.describe('"en az" is main\'s statement, and never appears without its cause (A3.16)', () => {
  test('a cause with a positive figure prints the bound AND the cause', () => {
    const text = metaOf({
      weeklyTokens: tk(2_050_000),
      weeklyTokensWindowAnchored: false,
      weeklyTokenFloorCauses: ['unread-range'],
    });
    assert.equal(text, withCause(labelled('row.tokens.last7', fmt.atLeast(fmt.tokens(2_050_000))), 'unread-range'));
  });

  test('no causes means no bound and no cause clause', () => {
    const text = metaOf({ weeklyTokens: tk(2_050_000), weeklyTokensWindowAnchored: false, weeklyTokenFloorCauses: [] });
    assert.equal(text, labelled('row.tokens.last7', fmt.tokens(2_050_000)));
  });

  test('a cost that is a floor does NOT make the COUNT one', () => {
    // The pairing the contract calls the point: an unpriced model counted every
    // token it saw, so the money can read "en az" over an exact count.
    const text = metaOf({
      weeklyTokens: tk(2_050_000),
      weeklyTokensWindowAnchored: false,
      weeklyTokenFloorCauses: [],
      weeklyCost: cost({ unpricedModels: ['claude-opus-4-8'], unrecordedWriteEvents: 419, unrecordedCalls: true }),
    });
    assert.equal(text, labelled('row.tokens.last7', fmt.tokens(2_050_000)));
  });

  test('a malformed cause list adds no claim', () => {
    for (const bad of [null, undefined, 'unread-range', 1, {}]) {
      const text = metaOf({ weeklyTokens: tk(2_050_000), weeklyTokensWindowAnchored: false, weeklyTokenFloorCauses: bad });
      assert.equal(text, labelled('row.tokens.last7', fmt.tokens(2_050_000)), JSON.stringify(bad));
    }
  });

  test('a zero figure with a cause shows the cause but never a bound of zero', () => {
    // "en az 0 token" is a lower bound on a figure that says nothing.
    const text = metaOf({
      weeklyTokens: { ...ZERO },
      weeklyTokensWindowAnchored: false,
      weeklyTokenFloorCauses: ['unread-range'],
      weeklyCost: cost({ sourceIncomplete: false }),
    });
    assert.equal(text.includes(fmt.atLeast(fmt.tokens(0))), false, text);
    assert.ok(text.includes(causesMod.floorCauseClause('unread-range')), text);
  });
});

/* -------------------------------------------------------- the five-hour path */

test.describe('a main process that predates weeklyTokens', () => {
  test('its five-hour count is still shown, AS a five-hour count', () => {
    const text = metaOf({ tokens: tk(410_000), weeklyTokens: null, weeklyTokensWindowAnchored: null });
    assert.equal(text, i18n.t('row.tokens.fiveHour', { value: fmt.tokens(410_000) }));
  });

  test('it is never given a weekly label, whatever the anchor field says', () => {
    for (const anchored of [true, false, null]) {
      const text = metaOf({ tokens: tk(410_000), weeklyTokens: null, weeklyTokensWindowAnchored: anchored });
      for (const key of ['row.tokens.quotaWeek', 'row.tokens.last7', 'row.tokens.weekly']) {
        const prefix = i18n.t(key, { value: '' }).trim();
        assert.equal(text.startsWith(prefix), false, `${key} leaked onto a five-hour figure: ${text}`);
      }
    }
  });

  test('and it never borrows the weekly cause list', () => {
    const text = metaOf({
      tokens: tk(410_000), weeklyTokens: null,
      weeklyTokenFloorCauses: ['unread-range'],
    });
    assert.equal(text, i18n.t('row.tokens.fiveHour', { value: fmt.tokens(410_000) }));
  });
});

/* ------------------------------------------------------------ the title, burn */

test.describe('the five-hour figure is not deleted — it moves into the title, labelled', () => {
  function titleOf(over) {
    const handle = rowMod.createRow(provider(over), ctx(), NOW);
    const node = walk(handle.el).find((n) => {
      const title = n.getAttribute('title');
      return title && (title.includes(i18n.t('meter.window7d.label')) || title.includes(i18n.t('meter.window5h.label')));
    });
    return node ? node.getAttribute('title') : null;
  }

  test('both windows are named in it, so two identical breakdowns cannot be confused', () => {
    const title = titleOf({ tokens: tk(410_000), weeklyTokens: tk(2_050_000), weeklyTokensWindowAnchored: true });
    assert.ok(title, 'no token title at all');
    assert.ok(title.includes(i18n.t('meter.window7d.label')), title);
    assert.ok(title.includes(i18n.t('meter.window5h.label')), title);
  });

  test('EVERY cause is carried in it, not only the one the visible line has room for', () => {
    // The reachable multi-cause row: Gemini's unrecorded utility calls are
    // unconditional, so a Gemini week inside a known-unread range has two. The
    // visible line prints the first; losing the rest to brevity would leave a
    // bound whose full reason is nowhere on screen (ADR-002 A3.16). This is also
    // the only place a renderer that rebuilt the cause list from
    // `weeklyCost.sourceIncomplete` instead of reading the field would differ
    // from main: it would produce one cause where main sent two.
    const title = titleOf({
      id: 'gemini',
      displayName: 'Gemini',
      weeklyTokens: tk(600_000),
      weeklyTokensWindowAnchored: false,
      weeklyTokenFloorCauses: ['unread-range', 'unrecorded-calls'],
      weeklyCost: cost({ sourceIncomplete: true }),
    });
    assert.ok(title, 'no token title at all');
    for (const cause of ['unread-range', 'unrecorded-calls']) {
      assert.ok(title.includes(causesMod.floorCauseClause(cause)), `${cause} missing from: ${title}`);
    }
  });
});

test.describe('the burn rate beside the count stays a five-hour figure', () => {
  test('it names its own window, so the two numbers are not read as one', () => {
    const text = metaOf({
      tokens: tk(410_000), weeklyTokens: tk(2_050_000), weeklyTokensWindowAnchored: true,
      burnRatePerHour: 90_000,
    });
    assert.ok(text.includes(i18n.t('row.burn.fiveHour', { rate: fmt.burnRate(90_000) })), text);
  });
});

test.describe('Gemini CLI and Kimi Code are never labelled a quota week (ADR-003 A6)', () => {
  test('main reports a trailing window for them once scanned, and the row says so', () => {
    for (const id of ['gemini', 'kimi']) {
      const text = metaOf({ id, displayName: id, weeklyTokens: tk(600_000), weeklyTokensWindowAnchored: false });
      assert.equal(text, labelled('row.tokens.last7', fmt.tokens(600_000)), id);
    }
  });
});

/* ------------------------------------------------- the row's chrome hooks
 *
 * Added during the certification of a rebuilt `row.ts` (the file was discarded
 * by `git checkout --` on a dirty tree and reconstructed from the build
 * artifact). The reconstruction turned out to be faithful, but auditing it
 * showed that FOUR attributes this component sets had no test anywhere — not
 * here, not in `test/render/` — so their loss would have been invisible to the
 * suite and the recovery could only be certified from a copy of the source that
 * happened to exist outside the repository. They are styling and
 * assistive-technology contracts, not decoration: `data-tray` is the row's
 * claim that it drives the tray icon, `data-since` carries the instant the "as
 * of" line is rendered from, `data-state` selects the meter's colour step and
 * `aria-busy` marks a row the user is waiting on.
 */

test.describe('the row states its chrome in attributes, and each one is a claim', () => {
  function rootOf(over, ctxOver = {}) {
    return rowMod.createRow(provider(over), { ...ctx(), ...ctxOver }, NOW).el;
  }
  const gripOf = (root) => walk(root).find((n) => (n.getAttribute('class') || '').includes('grip'));

  test('data-tray marks the row whose five-hour window drives the tray icon', () => {
    const on = gripOf(rootOf({ weeklyTokens: tk(1000) }, { isTrayRow: () => true }));
    const off = gripOf(rootOf({ weeklyTokens: tk(1000) }, { isTrayRow: () => false }));
    assert.equal(on.getAttribute('data-tray'), 'true');
    assert.equal(off.getAttribute('data-tray'), null, 'absent, not "false" — only the tray row claims it');
  });

  test('data-connected carries the account state as a string both ways', () => {
    assert.equal(rootOf({ connected: true }).getAttribute('data-connected'), 'true');
    assert.equal(rootOf({ connected: false, status: 'passive' }).getAttribute('data-connected'), 'false');
  });

  test('aria-busy and a naming label appear together on a loading row, and only there', () => {
    const loading = rootOf({ status: 'loading' });
    assert.equal(loading.getAttribute('aria-busy'), 'true');
    assert.ok(loading.getAttribute('aria-label'), 'a busy row must name what is loading');
    const ok = rootOf({ status: 'ok', weeklyTokens: tk(1000) });
    assert.equal(ok.getAttribute('aria-busy'), null);
    assert.equal(ok.getAttribute('aria-label'), null, 'a settled row adds no label of its own');
  });

  test('data-state names a meter step, so colour is never the only carrier', () => {
    const root = rootOf({
      weeklyTokens: tk(1000),
      fiveHour: win(new Date(NOW + 2 * HOUR).toISOString()),
    });
    const step = root.getAttribute('data-state');
    assert.ok(step, 'the row must always state a step');
    assert.equal(typeof step, 'string');
  });

  test('data-since carries the instant the "as of" line is rendered from', () => {
    // A stale row with no capture instant falls back to its own age; the line
    // is drawn from this attribute, so losing it would silently blank it.
    const lastGoodAt = new Date(NOW - 40 * 60_000).toISOString();
    const root = rootOf({
      status: 'stale', weeklyTokens: tk(1000), lastGoodAt,
      fiveHour: { usedPercentage: 62, certainty: 'known', resetsAt: new Date(NOW + HOUR).toISOString(), capturedAt: null },
    });
    const since = walk(root).find((n) => n.getAttribute('data-since'));
    assert.ok(since, 'a stale row with no capture instant must carry data-since');
    assert.equal(since.getAttribute('data-since'), lastGoodAt);
  });
});

/* -------------------------------------- the row's wiring of other blocks
 *
 * Also added during the `row.ts` certification, and for a sharper reason than
 * the chrome hooks above: deleting `refs.keys.update(p)` from this file broke
 * NOTHING in the suite — not `keys-entry-flow`, not `keys-credits`, not
 * `keys-validation`. Those suites exercise `keys.ts` directly and the key-entry
 * window; none of them mounts a ROW, so the row's wiring of the block was
 * untested. That wiring is exactly the ADR-003 A8 work a `git checkout --` on a
 * dirty tree discarded, which means the suite could not have told anyone whether
 * the recovery put it back.
 */

test.describe('a key-capable row wires up the optional key block', () => {
  const keyRow = (over = {}) => rowMod.createRow(
    provider({ id: 'copilot', displayName: 'GitHub Copilot', keyCapable: true, keyState: 'none', ...over }),
    ctx(),
    NOW,
  ).el;

  const keyBlockOf = (root) => walk(root).find((n) => (n.getAttribute('class') || '').includes('key')
    && (n.getAttribute('class') || '').split(/\s+/).includes('key'));

  test('the block is attached to the row and shown for a key-capable provider', () => {
    const block = keyBlockOf(keyRow());
    assert.ok(block, 'no key block in the row at all — the row never created or appended it');
    assert.equal(block.hidden, false, 'the block exists but was never updated, so it stayed hidden');
  });

  test('it carries the key state main sent, so the row reflects a stored key', () => {
    assert.equal(keyBlockOf(keyRow({ keyState: 'none' })).getAttribute('data-key-state'), 'none');
    assert.equal(keyBlockOf(keyRow({ keyState: 'stored' })).getAttribute('data-key-state'), 'stored');
  });

  test('a provider that cannot take a key never shows one', () => {
    const block = keyBlockOf(rowMod.createRow(provider({ keyCapable: false }), ctx(), NOW).el);
    if (block) assert.equal(block.hidden, true, 'a non-key-capable row must keep the block hidden');
  });
});

test.describe('the meta line reads as separate items, not one glued word', () => {
  test('adjacent items are separated in the TEXT stream, not only by CSS', () => {
    // The visible separator is a `::after` pseudo-element (row.css), and
    // pseudo-element content is not part of `textContent` — so without a real
    // text node between the spans the line reads "…token5 saat: …" to anything
    // consuming it as a string, assistive technology included.
    const text = metaOf({
      tokens: tk(410_000),
      weeklyTokens: tk(2_050_000),
      weeklyTokensWindowAnchored: true,
      burnRatePerHour: 90_000,
    });
    const weekly = labelled('row.tokens.quotaWeek', fmt.tokens(2_050_000));
    const burn = i18n.t('row.burn.fiveHour', { rate: fmt.burnRate(90_000) });
    assert.ok(text.includes(weekly), text);
    assert.ok(text.includes(burn), text);
    assert.equal(text.includes(weekly + burn), false, 'the two items are glued into one word');
    assert.ok(/\s/.test(text.slice(text.indexOf(weekly) + weekly.length, text.indexOf(burn))),
      `no whitespace between the items: ${JSON.stringify(text)}`);
  });
});
