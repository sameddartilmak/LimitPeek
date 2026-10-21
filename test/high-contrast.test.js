'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Windows high contrast (`@media (forced-colors: active)`, panel.css and
 * row.css). Chromium repaints every author colour with the system palette,
 * so anything told apart by a fill step alone disappears into one Canvas:
 * the meters, the selected segment, the switch. These pin the rules that
 * keep each of them on screen, in system colours only. The pixels were
 * checked by eye under Chrome's forced-colors emulation; this keeps the rules
 * from being lost in an edit.
 */

const ROOT = path.join(__dirname, '..');
const css = (name) => fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles', name), 'utf8');

/** The body of the (single) forced-colors block in a stylesheet. */
function forcedBlock(text) {
  const start = text.indexOf('@media (forced-colors: active) {');
  assert.notEqual(start, -1, 'no forced-colors block');
  let depth = 0;
  for (let i = text.indexOf('{', start); i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error('unterminated forced-colors block');
}

const SYSTEM = /^(Canvas|CanvasText|ButtonText|Highlight|HighlightText|GrayText|LinkText|transparent|none|0|1px|2px|-1px|1|var\(--[a-z-]+\)|color-mix\(in srgb, CanvasText 30%, Canvas\))$/;

test('every colour in the high-contrast blocks is a system colour', () => {
  // The layouts' own passes too (Görünüm → Düzen).
  for (const file of ['panel.css', 'row.css', 'layouts.css', 'layout-focus.css', 'layout-tiles.css']) {
    const block = forcedBlock(css(file));
    assert.doesNotMatch(block, /#[0-9A-Fa-f]{3,8}\b|rgba?\(/, `${file}: a literal colour in high contrast`);
    for (const m of block.matchAll(/(?:^|[;{]\s*)(background(?:-color)?|color|border-color|--state|--ring-ink|--glyph-dim):\s*([^;]+);/gm)) {
      assert.match(m[2].trim(), SYSTEM, `${file}: ${m[1]}: ${m[2]}`);
    }
  }
});

test('the meters opt out of the forcing and draw the reading in Highlight on an outlined track', () => {
  const block = forcedBlock(css('row.css'));
  assert.match(block, /\.rail \{\s*forced-color-adjust: none;\s*background: Canvas;\s*box-shadow: inset 0 0 0 1px CanvasText;/);
  assert.match(block, /\.rail__fill \{ --state: Highlight; background-color: Highlight; \}/);
  assert.match(block, /--ring-ink: Highlight;/);
  assert.match(block, /\.row \{ border: 1px solid CanvasText; \}/);
});

test('the layouts\' bars are row.css\'s meters: no layout rule paints a bar, so its high-contrast pass holds', () => {
  // "Öne çıkan" and "Kutucuklar" in bars only place and size the .rail; a
  // colour set there would outrank row.css's forced-colors rules (a media
  // query adds no specificity) and put the ramp back on an outlined track.
  for (const file of ['layouts.css', 'layout-focus.css', 'layout-tiles.css']) {
    const text = css(file).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      // Split the list at top-level commas only, not inside :has(a, b).
      const selectors = [];
      let depth = 0;
      let cur = '';
      for (const ch of m[1]) {
        if (ch === '(') depth += 1;
        if (ch === ')') depth -= 1;
        if (ch === ',' && depth === 0) { selectors.push(cur.trim()); cur = ''; } else cur += ch;
      }
      selectors.push(cur.trim());
      const paintsMeter = selectors.some((s) => /\.(rail|sk)\b|\.rail__/.test(s.split(/\s+/).pop()));
      if (!paintsMeter) continue;
      assert.doesNotMatch(m[2], /\b(background(-color|-image)?|box-shadow|color|opacity|forced-color-adjust)\s*:/, `${file}: ${selectors[0]}`);
    }
  }
});

test('a selected segment and an "on" switch keep their fill, in Highlight', () => {
  const block = forcedBlock(css('panel.css'));
  assert.match(block, /\.tabs__tab\[aria-selected="true"\],\s*\.theme__radio:checked \+ \.theme__opt,\s*\.seg__radio:checked \+ \.seg__opt \{\s*forced-color-adjust: none;\s*background: Highlight;\s*color: HighlightText;/);
  assert.match(block, /\.switch\[aria-checked="true"\] \.switch__track \{ background: Highlight;/);
  assert.match(block, /:focus-visible \{ outline: 2px solid Highlight;/);
});
