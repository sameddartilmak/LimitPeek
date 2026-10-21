'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { RAMPS } = require('../src/core/donut');
const { stripTiles } = require('../src/core/strip-tiles');
const { FakeElement, installDom, walk } = require('./helpers/fake-dom');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Görünüm → Şerit stili on the strip page (src/main/strip/strip.js and
 * strip.css): "Sade", "Halkalı" (D1, a thick double ring and a large
 * coloured figure) and "Dolgulu" (D2, the tile's ground filled to the
 * figure, the weekly figure in a chip).
 *
 *   1. CONTRAST, recomputed from strip.css on a #202020 and a #F3F3F3
 *      taskbar, like the plain strip's own test in taskbar-strip.test.js:
 *      every coloured word on the tile at rest and lit, every word on the
 *      fill at its worst, the chip's figure on the chip.
 *   2. THE DRAWING, by running the real page on test/helpers/fake-dom.js and
 *      handing it a payload, as main's IPC_STRIP.DATA does.
 */

// ------------------------------------------------------------ contrast

const css = () => read('src/main/strip/strip.css').replace(/\r/g, '');
const block = (body, sel) => {
  const at = body.indexOf(`\n${sel} {`);
  assert.notEqual(at, -1, sel);
  return body.slice(at, body.indexOf('}', at));
};
const varOf = (body, name) => {
  const m = new RegExp(`--${name}: ([^;]+);`).exec(body);
  assert.ok(m, name);
  return m[1].trim();
};
const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lum = (hex) => {
  const c = channels(hex).map((v) => v / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
const hex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
/** An rgba() or a #hex at `alpha`, composited over an opaque ground. */
const over = (colour, ground, alpha) => {
  let rgb;
  let a = alpha;
  if (colour.startsWith('rgba')) {
    const v = colour.match(/[\d.]+/g).map(Number);
    rgb = v.slice(0, 3);
    a = v[3];
  } else {
    rgb = channels(colour);
  }
  const g = channels(ground);
  return hex(rgb.map((v, i) => v * a + g[i] * (1 - a)));
};

const GROUNDS = [
  { sel: 'body', ground: '#202020', ramp: RAMPS.dark, name: 'dark' },
  { sel: 'body[data-ground="light"]', ground: '#F3F3F3', ramp: RAMPS.light, name: 'light' },
];
const STEPS = ['calm', 'watch', 'ember', 'spent'];

test.describe('contrast: 4.5:1 for every word in "Halkalı" and "Dolgulu", on both taskbars', () => {
  const report = [];
  test.after(() => {
    // The figures the strip.css comment carries, for a reviewer to compare.
    if (process.env.STRIP_CONTRAST) console.log(report.join('\n'));
  });

  for (const g of GROUNDS) {
    test(`${g.name}: the coloured figure, on the ground, the tile and the lit tile`, () => {
      const b = block(css(), g.sel);
      const surfaces = [g.ground, over(varOf(b, 'tile'), g.ground), over(varOf(b, 'tile-hover'), g.ground)];
      for (const step of STEPS) {
        const ink = varOf(b, `ink-${step}`);
        assert.match(ink, /^#[0-9A-F]{6}$/);
        const r = surfaces.map((s) => ratio(ink, s));
        report.push(`${g.name} ring ${step} ${ink}: ${r.map((x) => x.toFixed(2)).join(' / ')}`);
        for (const [i, x] of r.entries()) assert.ok(x >= 4.5, `${g.name} --ink-${step} ${ink} on ${surfaces[i]}: ${x.toFixed(2)}`);
      }
    });

    test(`${g.name}: the figure and the time left on the fill, every step, at rest and lit`, () => {
      const b = block(css(), g.sel === 'body' ? 'body' : g.sel);
      const base = block(css(), 'body');
      const alpha = Number(varOf(base, 'fill-alpha'));
      assert.ok(alpha >= 0.2 && alpha <= 0.35, `the fill alpha ${alpha} is not "about 28%"`);
      const tiles = [over(varOf(b, 'tile'), g.ground), over(varOf(b, 'tile-hover'), g.ground)];
      let worst = { figure: Infinity, label: Infinity };
      for (const step of STEPS) {
        for (const tile of tiles) {
          const fill = over(g.ramp[step], tile, alpha);
          worst.figure = Math.min(worst.figure, ratio(varOf(b, 'fill-figure'), fill));
          worst.label = Math.min(worst.label, ratio(varOf(b, 'fill-label'), fill));
          // Where the fill has not reached, the words are on the tile itself.
          worst.figure = Math.min(worst.figure, ratio(varOf(b, 'fill-figure'), tile));
          worst.label = Math.min(worst.label, ratio(varOf(b, 'fill-label'), tile));
        }
      }
      report.push(`${g.name} fill figure ${worst.figure.toFixed(2)} label ${worst.label.toFixed(2)}`);
      assert.ok(worst.figure >= 4.5, `${g.name} fill figure ${worst.figure.toFixed(2)}`);
      assert.ok(worst.label >= 4.5, `${g.name} fill label ${worst.label.toFixed(2)}`);
    });

    test(`${g.name}: the weekly chip is opaque and its coloured figure reads on it`, () => {
      const b = block(css(), g.sel);
      const chip = varOf(b, 'chip');
      assert.match(chip, /^#[0-9A-F]{6}$/, 'a translucent chip would put the figure on the fill again');
      let worst = Infinity;
      for (const step of STEPS) worst = Math.min(worst, ratio(varOf(b, `ink-${step}`), chip));
      report.push(`${g.name} chip ${worst.toFixed(2)}`);
      assert.ok(worst >= 4.5, `${g.name} chip ${worst.toFixed(2)}`);
    });
  }

  test('the words take the text steps, never the ramp the rings and the fill are painted in', () => {
    const body = css();
    for (const step of STEPS) {
      assert.match(body, new RegExp(`\\.tile__big\\[data-state="${step}"\\],\\s+\\.tile__chip\\[data-state="${step}"\\] +\\{ color: var\\(--ink-${step}\\); \\}`));
    }
    assert.match(body, /body\[data-style="fill"\] \.tile__big \{ color: var\(--fill-figure\); \}/);
    assert.match(body, /body\[data-style="fill"\] \.tile__sub \{ color: var\(--fill-label\); \}/);
    assert.match(body, /\.tile__ground \{[^}]*opacity: var\(--fill-alpha\);/);
    // 15px, 700: the mockup's figure.
    assert.match(block(body, '.tile__big'), /font-size: 15px;[\s\S]*font-weight: 700;/);
  });
});

// ------------------------------------------------------------ the drawing

test.describe('the page draws each style from the same payload', () => {
  let restore;
  let draw;
  let root;
  const sent = [];

  test.before(() => {
    restore = installDom();
    root = new FakeElement('main');
    document.getElementById = () => root;
    window.usageNotchStrip = {
      onData(cb) { draw = cb; return () => {}; },
      open() { sent.push('open'); },
      menu() { sent.push('menu'); },
      hover(i) { sent.push(`hover:${i}`); },
    };
    vm.runInThisContext(read('src/main/strip/strip.js'), { filename: 'strip.js' });
    assert.equal(typeof draw, 'function');
  });
  test.after(() => restore && restore());

  const NOW = Date.parse('2026-10-21T10:00:00Z');
  const at = (h) => new Date(NOW + h * 3600_000).toISOString();
  const w = (pct, h) => ({ usedPercentage: pct, certainty: 'known', resetsAt: at(h) });
  const SNAP = {
    providers: [
      { id: 'claude', displayName: 'Claude Code', enabled: true, connected: true, fiveHour: w(62, 2.2), sevenDay: w(91, 76) },
      { id: 'codex', displayName: 'Codex', enabled: true, connected: true, fiveHour: null, sevenDay: w(41, 121) },
    ],
  };
  const tiles = (ground = 'dark') => stripTiles(SNAP, NOW, ground);
  const cls = (n) => (n.getAttribute('class') || '').split(/\s+/);
  const find = (node, c) => walk(node).filter((n) => cls(n).includes(c));

  test('the rows carry their state step, for the coloured words', () => {
    const t = tiles();
    assert.deepEqual(t[0].rows.map((r) => [r.kind, r.state]), [['fiveHour', 'watch'], ['sevenDay', 'ember']]);
    assert.deepEqual(t[1].rows.map((r) => [r.kind, r.state]), [['sevenDay', 'calm']]);
  });

  test('"Halkalı": a 32px double ring, five-hour outside; the lead figure large in its state; its time left under it', () => {
    draw({ layer: 'display', ground: 'dark', style: 'rings', tileWidth: 180, tiles: tiles(), hover: -1, scale: 1 });
    assert.equal(document.body.getAttribute('data-style'), 'rings');
    const [claude, codex] = root.children;
    const svg = find(claude, 'tile__rings')[0];
    assert.equal(svg.getAttribute('viewBox'), '0 0 32 32');
    const sweeps = find(claude, 'tile__sweep');
    assert.deepEqual(sweeps.map((c) => c.getAttribute('r')), ['13.5', '6.5'], 'outer then inner');
    assert.deepEqual(sweeps.map((c) => c.getAttribute('stroke-width')), ['5', '5']);
    assert.deepEqual(sweeps.map((c) => c.getAttribute('stroke')), [RAMPS.dark.watch, RAMPS.dark.ember], 'the ramp, for the rings');
    assert.deepEqual(sweeps.map((c) => c.getAttribute('stroke-dasharray')), ['62 100', '91 100']);
    const big = find(claude, 'tile__big')[0];
    assert.equal(big.textContent, '%62');
    assert.equal(big.getAttribute('data-state'), 'watch', 'the text step, not a hex');
    assert.match(find(claude, 'tile__sub')[0].textContent, /^2sa 12dk$/);
    assert.equal(find(claude, 'tile__bar').length, 0, 'no bars in this style');
    // Every lead figure names its window beside it; one window: one ring, at
    // the outer size, and that weekly lead says so.
    assert.equal(find(claude, 'tile__tag')[0].textContent, '5sa');
    assert.deepEqual(find(codex, 'tile__sweep').map((c) => c.getAttribute('r')), ['13.5']);
    assert.equal(find(codex, 'tile__tag')[0].textContent, '7g');
    assert.equal(claude.style.width, '176px', 'the same 180px tile, gap included');
  });

  test('"Dolgulu": the ground fills to the lead figure in its ramp colour, the weekly figure in a chip', () => {
    draw({ layer: 'display', ground: 'light', style: 'fill', tileWidth: 180, tiles: tiles('light'), hover: 0, scale: 1.5 });
    assert.equal(document.body.getAttribute('data-style'), 'fill');
    const [claude, codex] = root.children;
    assert.ok(cls(claude).includes('tile--hover'), 'the lit tile is still lit');
    const ground = find(claude, 'tile__ground')[0];
    assert.equal(claude.childNodes[0], ground, 'under everything else');
    assert.equal(ground.style.width, '62%');
    assert.equal(ground.style.background, RAMPS.light.watch);
    assert.equal(find(claude, 'tile__big')[0].textContent, '%62');
    assert.equal(find(claude, 'tile__big')[0].getAttribute('data-state'), null, 'the figure on the fill is the neutral ink');
    const chip = find(claude, 'tile__chip')[0];
    // The chip names its window too: "7g %91".
    assert.equal(chip.textContent, '7g%91');
    assert.equal(find(chip, 'tile__tag')[0].textContent, '7g');
    assert.equal(chip.getAttribute('data-state'), 'ember');
    // One window: the fill is that window's, and there is no chip to repeat it.
    assert.equal(find(codex, 'tile__ground')[0].style.width, '41%');
    assert.equal(find(codex, 'tile__chip').length, 0);
    assert.equal(document.documentElement.style.zoom, '1.5');
  });

  test('"Sade", or anything else: the rows with their bars, as before', () => {
    for (const style of ['plain', 'Rings', undefined, 42]) {
      draw({ layer: 'full', ground: 'dark', style, tileWidth: 180, tiles: tiles() });
      assert.equal(document.body.getAttribute('data-style'), 'plain');
      assert.equal(find(root, 'tile__bar').length, 3);
      assert.equal(find(root, 'tile__rings').length + find(root, 'tile__ground').length + find(root, 'tile__chip').length, 0);
    }
  });

  test('a colour or a state that is not one of ours is dropped, never written', () => {
    const t = tiles();
    t[0].rows[0].colour = 'red; background: url(x)';
    t[0].rows[0].state = 'evil';
    t[0].rows[1].state = { toString: () => 'calm' };
    draw({ layer: 'full', ground: 'dark', style: 'rings', tileWidth: 180, tiles: t });
    const claude = root.children[0];
    assert.equal(find(claude, 'tile__sweep')[0].getAttribute('stroke'), null);
    assert.equal(find(claude, 'tile__big')[0].getAttribute('data-state'), null);
    draw({ layer: 'full', ground: 'dark', style: 'fill', tileWidth: 180, tiles: t });
    assert.equal(find(root.children[0], 'tile__ground')[0].style.background, undefined);
    assert.equal(find(root.children[0], 'tile__chip')[0].getAttribute('data-state'), null);
  });
});
