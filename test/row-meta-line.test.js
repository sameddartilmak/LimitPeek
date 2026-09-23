'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { installDom, mirrorRenderer, walk } = require('./helpers/fake-dom');

/**
 * THE META LINE SEPARATES ITS ITEMS IN TEXT, NOT ONLY IN PIXELS
 * (src/renderer/src/components/row.ts, the `.row__meta` build).
 *
 * The separator between the items on this line has always been a CSS
 * pseudo-element, and pseudo-element content is NOT part of `textContent`. So
 * anything reading the line as a string — a test, a tooltip built from it,
 * assistive technology that concatenates adjacent inline nodes — saw the two
 * figures glued:
 *
 *     "Kota haftası: 6,2 Mn token5 saat: 240 B token/sa"
 *
 * That predates the window labels; it was survivable while the items were bare
 * numbers and it stopped being survivable when each item became a sentence,
 * because "token5" is not a word in either language. The owner's render run
 * surfaced it verbatim.
 *
 * The fix is a real whitespace text node between items. It is invisible to
 * layout (a whitespace-only anonymous flex item is not rendered, so the visible
 * separator stays the CSS one and the `column-gap` keeps doing the spacing) and
 * it cannot come back as a stray leading dot on a wrapped line, which is what
 * killed the previous `span + span::before` rule.
 *
 * Pixels stay with the render suite. This asserts only the property that suite
 * cannot: that the TEXT has a boundary where the layout has one.
 */

const NOW = Date.parse('2026-09-14T12:00:00.000Z');

let mirror;
let restoreDom;
let rowMod;
let i18n;

test.before(async () => {
  restoreDom = installDom();
  mirror = mirrorRenderer();
  rowMod = await mirror.load('components', 'row.js');
  i18n = await mirror.load('i18n.js');
  i18n.setLocale('tr', 'tr-TR');
});

test.after(() => {
  if (restoreDom) restoreDom();
  if (mirror) mirror.cleanup();
});

const tk = (billable) => ({
  input: billable, output: 0, cacheWrite: 0, cacheRead: 9_000_000, billable,
});

function provider(over = {}) {
  return {
    id: 'codex', displayName: 'Codex', accent: '#10A37F', experimental: false,
    keyCapable: false, keyState: 'none', keyStoredAt: null, creditUsage: null,
    enabled: true, connected: true, status: 'ok', planLabel: null,
    fiveHour: null, sevenDay: null,
    tokens: null, weeklyTokens: null, weeklyTokensWindowAnchored: null,
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

function metaOf(over) {
  const handle = rowMod.createRow(provider(over), ctx(), NOW);
  const meta = walk(handle.el).find((n) => (n.getAttribute('class') || '').split(/\s+/).includes('row__meta'));
  assert.ok(meta, 'the row grew no meta line at all');
  return meta;
}

/** The item spans of the line, in order. */
const itemsOf = (meta) => [...meta.childNodes].filter((n) => n.nodeType === 1);

test.describe("the plan label is the user's own statement, shown as a label and nothing more", () => {
  const headerOf = (over) => {
    const handle = rowMod.createRow(provider(over), ctx(), NOW);
    const line = walk(handle.el).find((n) => (n.getAttribute('class') || '').split(/\s+/).includes('row__line'));
    const plan = line && walk(line).find((n) => (n.getAttribute('class') || '').split(/\s+/).includes('row__plan'));
    return { line, plan };
  };

  test('null renders NOTHING — no placeholder, no "bilinmiyor"', () => {
    const { line, plan } = headerOf({ planLabel: null });
    assert.equal(plan, undefined, 'a null plan grew an element');
    assert.doesNotMatch(line.textContent, /bilinmiyor|unknown|—/i, line.textContent);
  });

  test('a label is shown beside the name, verbatim', () => {
    const { plan } = headerOf({ planLabel: 'Max 20x' });
    assert.ok(plan, 'no plan element');
    assert.match(plan.textContent, /Max 20x/);
  });

  test('it carries its provenance for a screen reader, so it cannot be heard as the tool reporting it', () => {
    const { plan } = headerOf({ planLabel: 'Max 20x' });
    const sr = walk(plan).find((n) => (n.getAttribute('class') || '').split(/\s+/).includes('u-sr'));
    assert.ok(sr, 'the plan pill has no screen-reader provenance');
    assert.equal(sr.textContent.trim(), i18n.t('row.planSpoken'));
  });

  test('a row with no reading shows no plan, even when one is set', () => {
    // A plan qualifies a reading. An unconnected row has none, so the label
    // would be annotating a tool the user is not using — noise that looks
    // like data, beside "this tool was not found on this machine".
    const { plan } = headerOf({ planLabel: 'Max 20x', connected: false, status: 'passive' });
    assert.equal(plan, undefined);
  });

  test('it sits outside every usage claim: the header holds no figure', () => {
    // The rule this pins: a label the USER typed may never sit inside a
    // sentence the app is making about usage.
    const { line } = headerOf({ planLabel: 'Max 20x', weeklyTokens: tk(6_180_000) });
    assert.doesNotMatch(line.textContent, /token|%/i, line.textContent);
  });
});

test.describe('two figures on one line never run together in the text stream', () => {
  const TWO_ITEMS = { weeklyTokens: tk(6_180_000), weeklyTokensWindowAnchored: true, burnRatePerHour: 240_000 };

  test('the count and the burn rate are separated in textContent', () => {
    const text = metaOf(TWO_ITEMS).textContent;
    assert.equal(itemsOf(metaOf(TWO_ITEMS)).length, 2, 'expected exactly the two items this case is about');
    // The exact defect, as the render run printed it: "…token5 saat…".
    assert.doesNotMatch(text, /token5/, `the two items are glued: ${text}`);
    // A boundary exists between the end of one item and the start of the next.
    assert.match(text, /token\s+5 saat/, text);
  });

  test('the separator is whitespace, not a character the reader has to parse', () => {
    // The visible "·" is CSS. Putting a literal one in the text as well would
    // have a screen reader announce "dot" between every pair of figures.
    const text = metaOf(TWO_ITEMS).textContent;
    assert.doesNotMatch(text, /·/, 'a literal middle dot reached the text stream');
  });

  test('a single-item line gains no leading or trailing padding', () => {
    // The separator is inserted BETWEEN items, so a line with one item must be
    // exactly that item — qa's row tests compare this line by exact equality.
    const meta = metaOf({ weeklyTokens: tk(2_050_000), weeklyTokensWindowAnchored: false });
    assert.equal(itemsOf(meta).length, 1);
    assert.equal(meta.textContent, meta.textContent.trim());
  });

  test('three items are separated at both joins', () => {
    // A stale row can carry a delta as well; every join needs the boundary, not
    // just the first.
    const meta = metaOf({
      status: 'stale',
      weeklyTokens: tk(6_180_000),
      weeklyTokensWindowAnchored: true,
      burnRatePerHour: 240_000,
      lastGoodAt: new Date(NOW - 40 * 60_000).toISOString(),
    });
    const items = itemsOf(meta);
    const text = meta.textContent;
    for (const item of items) {
      const own = item.textContent;
      if (!own) continue;
      const at = text.indexOf(own);
      const before = at > 0 ? text[at - 1] : ' ';
      const after = at + own.length < text.length ? text[at + own.length] : ' ';
      assert.match(before, /\s/, `no boundary before "${own}" in "${text}"`);
      assert.match(after, /\s/, `no boundary after "${own}" in "${text}"`);
    }
  });
});
