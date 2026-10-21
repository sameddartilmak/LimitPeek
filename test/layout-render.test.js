'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { FakeElement, installDom, mirrorRenderer, walk } = require('./helpers/fake-dom');

const ROOT = path.join(__dirname, '..');

/**
 * Görünüm → Düzen, drawn: "Öne çıkan" and "Kutucuklar" through the REAL
 * `mountApp` on test/helpers/fake-dom.js (no layout, no CSS: the DOM facts
 * the layouts promise), plus guards on the stylesheets that hold the rest.
 *
 *   - the hero: the tool closest to its limit, by its highest window, ties
 *     in the user's order, moved to the top of the DOM and never written
 *     back as an order;
 *   - the same cards in every layout: meters keep their values and
 *     sentences, states keep their words;
 *   - outside the list a card cannot be dragged, a click on it opens its
 *     details as a sheet, and "Tüm araçlar", the card's own control and Esc
 *     all lead back, focus on the tool it was opened from;
 *   - "Kutucuklar"'s quick tiles drive the app's own setters, and its
 *     "Yenile" is the one refresh on screen.
 */

let mirror;
let restoreDom;
let appMod;
let layoutsMod;
let i18n;

test.before(async () => {
  restoreDom = installDom();
  mirror = mirrorRenderer();
  appMod = await mirror.load('app.js');
  layoutsMod = await mirror.load('components', 'layouts.js');
  i18n = await mirror.load('i18n.js');
});

test.after(() => {
  if (restoreDom) restoreDom();
  if (mirror) mirror.cleanup();
});

const tick = () => new Promise((r) => setTimeout(r, 15));
const cls = (n) => (n.getAttribute('class') || '').split(/\s+/);
const visible = (node) => {
  for (let n = node; n; n = n.parentNode) if (n.hidden) return false;
  return true;
};

const NOW = Date.now();
const later = (h) => new Date(NOW + h * 3600_000).toISOString();
const win = (pct, h, extra = {}) => ({ usedPercentage: pct, certainty: 'known', resetsAt: later(h), ...extra });
function provider(id, name, five, week, extra = {}) {
  return {
    id, displayName: name, accent: '#D97757', enabled: true, connected: true, status: 'ok', planLabel: null,
    fiveHour: five, sevenDay: week, tokens: null, weeklyTokens: null, burnRatePerHour: null, weeklyCost: null,
    setupAction: null, ...extra,
  };
}
const SNAP = () => ({
  generatedAt: new Date().toISOString(),
  providers: [
    provider('claude', 'Claude Code', win(62, 2), win(41, 50), { planLabel: 'Max 20x' }),
    provider('codex', 'Codex', win(30, 4), win(88, 90)),
    provider('antigravity', 'Antigravity', win(84, 1), win(23, 120)),
  ],
});

function mount(prefs = {}, snapshot = SNAP()) {
  i18n.setLocale('tr', 'tr-TR');
  document.documentElement = new FakeElement('html');
  const calls = [];
  let keydown = null;
  const addListener = document.addEventListener;
  document.addEventListener = (type, fn) => {
    if (type === 'keydown') keydown = fn;
    addListener(type, fn);
  };
  const base = { theme: 'dark', language: 'tr', resolvedLanguage: 'tr', formatLocale: 'tr-TR', trayView: 'tray', ...prefs };
  const bridge = {
    available: true,
    initialPreferences: () => ({ ...base }),
    initialSnapshot: () => snapshot,
    onSnapshot: () => () => {},
    onAnchor: () => () => {},
    onPanelVisibility: () => () => {},
    onPreferences: () => () => {},
    panelOpened() {},
    pin() {},
    close() { calls.push('close'); },
    setPointerOverPanel() {},
    requestRefresh: async () => { calls.push('refresh'); return null; },
    setOrder: async (ids) => { calls.push(`order:${ids.join(',')}`); return true; },
    setTheme: async (v) => { calls.push(`theme:${v}`); return true; },
    setTrayView: async (v) => { calls.push(`trayView:${v}`); return true; },
    setLayout: async (v) => { calls.push(`layout:${v}`); return true; },
  };
  const container = new FakeElement('div');
  document.body.replaceChildren(container);
  const handle = appMod.mountApp(container, bridge);
  document.addEventListener = addListener;
  const find = (pred) => walk(container).find(pred) || null;
  const all = (pred) => walk(container).filter(pred);
  const list = () => find((n) => n.tagName === 'UL' && cls(n).includes('rows') && n.getAttribute('aria-busy') !== 'true');
  const rows = () => list().children;
  const row = (id) => rows().find((r) => r.getAttribute('data-provider') === id);
  const esc = () => keydown({ key: 'Escape', preventDefault() {} });
  return { handle, container, calls, find, all, list, rows, row, esc };
}

// ------------------------------------------------------------------ the hero

test.describe('pickHero', () => {
  const p = (id, five, week, extra) => provider(id, id, five, week, extra);

  test('the highest window of any tool wins, and says which window it was', () => {
    const hero = layoutsMod.pickHero([p('a', win(62, 2), win(41, 9)), p('b', win(30, 2), win(88, 9)), p('c', win(84, 2), null)], NOW);
    assert.deepEqual(hero, { id: 'b', lead: '7d' });
    assert.deepEqual(layoutsMod.pickHero([p('a', win(70, 2), win(70, 9))], NOW), { id: 'a', lead: '5h' }, 'a tie inside a tool: the five-hour window');
  });

  test('ties keep the user\'s order, compared on the figure the meter prints', () => {
    assert.equal(layoutsMod.pickHero([p('a', win(50, 2), null), p('b', null, win(50, 9))], NOW).id, 'a');
    assert.equal(layoutsMod.pickHero([p('a', win(49.6, 2), null), p('b', win(50.4, 2), null)], NOW).id, 'a', '%50 and %50 on screen');
  });

  test('only a figure the meter would draw counts: not unknown, not rolled over, not a passive or unconnected tool', () => {
    const rolled = { usedPercentage: 99, certainty: 'known', resetsAt: later(-1), capturedAt: later(-3) };
    const hero = layoutsMod.pickHero([
      p('unknown', { usedPercentage: 99, certainty: 'unknown', resetsAt: later(1) }, null),
      p('rolled', rolled, null),
      p('passive', win(99, 1), null, { status: 'passive' }),
      p('offline', win(99, 1), null, { connected: false }),
      p('loading', win(99, 1), null, { status: 'loading' }),
      p('real', win(12, 1), null),
    ], NOW);
    assert.equal(hero.id, 'real');
    assert.equal(layoutsMod.pickHero([p('none', null, null), p('unknown', { usedPercentage: null, certainty: 'unknown' }, null)], NOW), null);
    // Stale and erroring tools keep their last good figure, and stay in the race.
    assert.equal(layoutsMod.pickHero([p('a', win(40, 1), null), p('b', win(90, 1), null, { status: 'error' })], NOW).id, 'b');
  });
});

test.describe('"Öne çıkan"', () => {
  test('the hero leads the DOM, marked with its window and its kicker; the others keep the user\'s order', async () => {
    const app = mount({ layout: 'focus' });
    try {
      await tick();
      assert.deepEqual(app.rows().map((r) => r.getAttribute('data-provider')), ['codex', 'claude', 'antigravity']);
      const hero = app.row('codex');
      assert.equal(hero.getAttribute('data-hero'), 'true');
      assert.equal(hero.getAttribute('data-lead'), '7d');
      assert.equal(hero.getAttribute('data-kicker'), 'Limite en yakın');
      assert.equal(app.row('claude').getAttribute('data-hero'), null);
      assert.deepEqual(app.rows().map((r) => r.getAttribute('aria-posinset')), ['1', '2', '3'], 'positions follow what is read');
      assert.match(app.list().getAttribute('aria-label'), /limite en yakın olan en üstte/);
      // A display order, never a stored one.
      assert.equal(app.calls.filter((c) => c.startsWith('order:')).length, 0);
    } finally {
      app.handle.destroy();
    }
  });

  test('no tool with a figure: no hero, and the list keeps its tray-order name', async () => {
    const snap = SNAP();
    for (const p of snap.providers) { p.fiveHour = null; p.sevenDay = null; }
    const app = mount({ layout: 'focus' }, snap);
    try {
      await tick();
      assert.equal(app.rows().filter((r) => r.getAttribute('data-hero')).length, 0);
      assert.equal(app.list().getAttribute('aria-label'), i18n.t('panel.rowsLabel'));
    } finally {
      app.handle.destroy();
    }
  });

  test('in the list nothing is marked and the order is the user\'s', async () => {
    const app = mount({ layout: 'list' });
    try {
      await tick();
      assert.deepEqual(app.rows().map((r) => r.getAttribute('data-provider')), ['claude', 'codex', 'antigravity']);
      assert.equal(app.rows().filter((r) => r.getAttribute('data-hero')).length, 0);
    } finally {
      app.handle.destroy();
    }
  });
});

// --------------------------------------------------- the same cards everywhere

test.describe('the same cards in every layout', () => {
  for (const layout of ['list', 'focus', 'tiles']) {
    test(`${layout}: every window is still a meter with its value and its sentence`, async () => {
      const app = mount({ layout });
      try {
        await tick();
        const meters = app.all((n) => n.getAttribute('role') === 'meter');
        assert.equal(meters.length, 6);
        for (const m of meters) {
          assert.match(m.getAttribute('aria-valuenow'), /^\d+$/);
          assert.ok(m.getAttribute('aria-valuetext').includes(m.getAttribute('aria-valuenow')));
        }
        assert.ok(app.find((n) => cls(n).includes('row__plan') && n.textContent.includes('Max 20x')), 'the plan label');
      } finally {
        app.handle.destroy();
      }
    });
  }

  test('a stale, an estimated, an erroring and a not-connected card keep their words in the tiles', async () => {
    const snap = SNAP();
    snap.providers[0].status = 'stale';
    snap.providers[0].fiveHour.capturedAt = later(-0.5);
    snap.providers[1].fiveHour.certainty = 'estimated';
    snap.providers[2].status = 'error';
    snap.providers[2].errorCode = 'parse-failed';
    snap.providers.push(provider('kimi', 'Kimi Code', null, null, {
      status: 'passive', connected: false, setupAction: { kind: 'enable', label: 'Ekle', detail: 'Bu makinede bulunamadı.' },
    }));
    const app = mount({ layout: 'tiles' }, snap);
    try {
      await tick();
      assert.ok(app.find((n) => cls(n).includes('row__chip--stale')), 'the stale chip');
      assert.ok(app.find((n) => cls(n).includes('win__asof') && !n.hidden), 'the "itibarıyla" line');
      assert.ok(app.find((n) => cls(n).includes('win__pct') && n.textContent.startsWith('≈')), 'the estimate sign');
      assert.ok(app.find((n) => cls(n).includes('row__err')), 'the error and its retry');
      const kimi = app.row('kimi');
      assert.ok(walk(kimi).some((n) => n.tagName === 'BUTTON' && n.textContent === 'Ekle'), '"Ekle" on the passive tile');
    } finally {
      app.handle.destroy();
    }
  });
});

// ---------------------------------------------------------- the grip, the click

test.describe('outside the list', () => {
  const grip = (r) => walk(r).find((n) => cls(n).includes('grip'));

  test('the mark is a logo, not a drag handle: disabled, out of the accessibility tree, no reorder help', async () => {
    for (const layout of ['focus', 'tiles']) {
      const app = mount({ layout });
      try {
        await tick();
        const g = grip(app.row('claude'));
        assert.equal(g.disabled, true, layout);
        assert.equal(g.getAttribute('aria-hidden'), 'true');
        assert.equal(g.getAttribute('aria-describedby'), null);
        assert.equal(g.getAttribute('title'), null, 'no "drag to move" tooltip');
      } finally {
        app.handle.destroy();
      }
    }
    const app = mount({ layout: 'list' });
    try {
      await tick();
      const g = grip(app.row('claude'));
      assert.equal(g.disabled, false);
      assert.equal(g.getAttribute('aria-hidden'), null);
      assert.equal(g.getAttribute('aria-describedby'), 'reorder-help');
    } finally {
      app.handle.destroy();
    }
  });

  test('a click on the card opens its details as a sheet; the back control, the card\'s own and Esc lead back', async () => {
    const app = mount({ layout: 'tiles' });
    try {
      await tick();
      const tile = app.row('codex');
      assert.equal(tile.getAttribute('data-opens'), 'true');
      tile.click();
      await tick();
      assert.equal(tile.getAttribute('data-expanded'), 'true');
      assert.equal(app.list().getAttribute('data-sheet'), 'true');
      const back = app.find((n) => cls(n).includes('sheet-back'));
      assert.equal(back.hidden, false);
      assert.equal(back.getAttribute('aria-label'), i18n.t('layout.sheet.backLabel'));
      assert.equal(tile.getAttribute('data-opens'), null, 'an open card does not toggle on a click inside it');
      tile.click();
      await tick();
      assert.equal(tile.getAttribute('data-expanded'), 'true');

      const more = walk(tile).find((n) => cls(n).includes('row__more'));
      back.click();
      await tick();
      assert.equal(tile.getAttribute('data-expanded'), null);
      assert.equal(app.list().getAttribute('data-sheet'), null);
      assert.equal(back.hidden, true);
      assert.equal(document.activeElement, more, 'focus back on the tool it was opened from');

      // Enter or Space on "Ayrıntılar" is the keyboard's way in; Esc the way out.
      more.click();
      await tick();
      assert.equal(app.list().getAttribute('data-sheet'), 'true');
      app.esc();
      await tick();
      assert.equal(app.list().getAttribute('data-sheet'), null);
      assert.equal(document.activeElement, more);
      assert.equal(app.calls.includes('close'), false, 'Esc closed the sheet, not the panel');
    } finally {
      app.handle.destroy();
    }
  });

  test('a control on the card keeps its own action and opens nothing', async () => {
    const snap = SNAP();
    snap.providers[1].status = 'error';
    snap.providers[1].errorCode = 'timeout';
    const app = mount({ layout: 'focus' }, snap);
    try {
      await tick();
      const retry = walk(app.row('codex')).find((n) => n.tagName === 'BUTTON' && n.textContent === i18n.t('row.retry'));
      // The click bubbles to the card, which must leave it alone.
      retry.click();
      app.row('codex').dispatch('click', { target: retry });
      await tick();
      assert.equal(app.row('codex').getAttribute('data-expanded'), null);
      assert.ok(app.calls.includes('refresh'), 'the retry ran');
    } finally {
      app.handle.destroy();
    }
  });

  test('a click inside the setup question drawn in a tile does not open the tile', async () => {
    const snap = SNAP();
    snap.providers[0].setupAction = { kind: 'install-bridge', label: 'Bağla', detail: 'Claude Code ayarlarına bir satır ekler.' };
    const app = mount({ layout: 'tiles' }, snap);
    try {
      await tick();
      const tile = app.row('claude');
      walk(tile).find((n) => n.tagName === 'BUTTON' && n.textContent === 'Bağla').click();
      await tick();
      const consent = walk(tile).find((n) => cls(n).includes('consent'));
      assert.ok(consent && !consent.hidden, 'the question is drawn in the tile');
      const para = walk(consent).find((n) => cls(n).includes('consent__para'));
      tile.dispatch('click', { target: para });
      await tick();
      assert.equal(tile.getAttribute('data-expanded'), null);
    } finally {
      app.handle.destroy();
    }
  });

  test('in the list a click on the card does nothing; only "Ayrıntılar" opens, and Esc closes the panel', async () => {
    const app = mount({ layout: 'list' });
    try {
      await tick();
      const card = app.row('claude');
      assert.equal(card.getAttribute('data-opens'), null);
      card.click();
      await tick();
      assert.equal(card.getAttribute('data-expanded'), null);
      walk(card).find((n) => cls(n).includes('row__more')).click();
      await tick();
      assert.equal(card.getAttribute('data-expanded'), 'true');
      assert.equal(app.list().getAttribute('data-sheet'), null, 'a card that grew, not a sheet');
      app.esc();
      await new Promise((r) => setTimeout(r, 180));
      assert.ok(app.calls.includes('close'));
    } finally {
      app.handle.destroy();
    }
  });
});

// ----------------------------------------------------------------- quick tiles

test.describe('"Kutucuklar"\'s quick tiles', () => {
  const quick = (app, kind) => app.find((n) => cls(n).includes(`quick--${kind}`));

  test('in the footer\'s place, a named group of four, and "Yenile" the one refresh on screen', async () => {
    const app = mount({ layout: 'tiles' });
    try {
      await tick();
      const group = app.find((n) => cls(n).includes('quicks'));
      assert.equal(visible(group), true);
      assert.equal(group.getAttribute('role'), 'group');
      assert.equal(group.getAttribute('aria-label'), 'Hızlı ayarlar');
      assert.deepEqual(group.children.map((b) => b.tagName), ['BUTTON', 'BUTTON', 'BUTTON', 'BUTTON']);
      const foot = app.find((n) => cls(n).includes('foot'));
      assert.equal(foot.hidden, true, 'the footer stepped aside');
      const refreshes = app.all((n) => n.tagName === 'BUTTON' && visible(n) && (cls(n).includes('foot__refresh') || cls(n).includes('quick--refresh')));
      assert.equal(refreshes.length, 1);
      assert.match(quick(app, 'refresh').textContent, /Yenile\d{2}[:.]\d{2}/, 'the last scan time on it');
    } finally {
      app.handle.destroy();
    }
  });

  test('Tema cycles Açık, Koyu, Sistem through the app\'s own setter; Şerit toggles; Ayarlar opens; Yenile refreshes', async () => {
    const app = mount({ layout: 'tiles', theme: 'light' });
    try {
      await tick();
      assert.equal(quick(app, 'theme').getAttribute('aria-label'), 'Tema: Açık');
      quick(app, 'theme').click();
      await tick();
      quick(app, 'theme').click();
      await tick();
      quick(app, 'theme').click();
      await tick();
      assert.deepEqual(app.calls.filter((c) => c.startsWith('theme:')), ['theme:dark', 'theme:system', 'theme:light']);

      const strip = quick(app, 'strip');
      assert.equal(strip.getAttribute('aria-pressed'), 'false');
      strip.click();
      await tick();
      assert.deepEqual(app.calls.filter((c) => c.startsWith('trayView:')), ['trayView:strip']);
      assert.equal(strip.getAttribute('aria-pressed'), 'true');

      quick(app, 'refresh').click();
      await tick();
      assert.ok(app.calls.includes('refresh'));

      quick(app, 'settings').click();
      await tick();
      assert.equal(visible(app.find((n) => n.getAttribute('id') === 'settings-view')), true);
      assert.equal(visible(app.find((n) => cls(n).includes('quicks'))), false, 'settings has the usual footer');
      assert.equal(app.find((n) => cls(n).includes('foot')).hidden, false);
    } finally {
      app.handle.destroy();
    }
  });

  test('not in the list or in "Öne çıkan": there the footer is the footer', async () => {
    for (const layout of ['list', 'focus']) {
      const app = mount({ layout });
      try {
        await tick();
        assert.equal(app.find((n) => cls(n).includes('quicks')).hidden, true, layout);
        assert.equal(app.find((n) => cls(n).includes('foot')).hidden, false, layout);
      } finally {
        app.handle.destroy();
      }
    }
  });
});

// ------------------------------------------------------------------ the CSS

test.describe('the stylesheets', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const FILES = ['layouts.css', 'layout-focus.css', 'layout-tiles.css'];
  /** Every rule as [selectors, body], comments out, selector lists split at depth 0. */
  const rules = (css) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => {
    const out = [];
    let depth = 0;
    let cur = '';
    for (const ch of m[1].replace(/^[\s\S]*\{/, '')) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    out.push(cur.trim());
    return [out.filter(Boolean), m[2]];
  });

  test('the panel and the harness load all three, after row.css', () => {
    for (const [page, prefix] of [['src/renderer/index.html', './styles/'], ['src/renderer/dev/harness.html', '../styles/']]) {
      const html = read(page);
      const at = (f) => html.indexOf(`href="${prefix}${f}"`);
      assert.notEqual(at('row.css'), -1);
      for (const f of FILES) assert.ok(at(f) > at('row.css'), `${page}: ${f}`);
    }
  });

  test('no :has() inside a :has() (Chromium drops the whole rule), and every rule is scoped to its layout', () => {
    for (const f of FILES) {
      const css = read(`src/renderer/styles/${f}`).replace(/\/\*[\s\S]*?\*\//g, '');
      assert.doesNotMatch(css, /:has\((?:[^()]|\([^()]*\))*:has\(/, `${f}: a nested :has()`);
    }
    for (const [f, layout] of [['layout-focus.css', 'focus'], ['layout-tiles.css', 'tiles']]) {
      for (const [selectors] of rules(read(`src/renderer/styles/${f}`))) {
        for (const s of selectors) {
          if (/^\.quick/.test(s)) continue;
          assert.ok(s.startsWith(`html[data-layout="${layout}"]`), `${f}: "${s}" is not scoped to ${layout}`);
        }
      }
    }
  });

  test('each file carries its high-contrast pass, in system colours', () => {
    for (const f of FILES) {
      const css = read(`src/renderer/styles/${f}`);
      const at = css.indexOf('@media (forced-colors: active) {');
      assert.notEqual(at, -1, `${f}: no forced-colors pass`);
      const block = css.slice(at);
      assert.doesNotMatch(block, /#[0-9A-Fa-f]{3,8}\b|rgba?\(/, `${f}: a literal colour in high contrast`);
    }
    assert.match(read('src/renderer/styles/layout-tiles.css'), /\.quick--strip\[data-on="true"\] \.quick__icon \{ background: Highlight; color: HighlightText;/);
  });

  test('the cards keep the card surface, so a window material restyles the tiles and the hero too', () => {
    // A rule whose subject is the card itself (not a pseudo-element on it,
    // not something inside it) never sets a background.
    const card = /\.row(\[[^\]]*\]|:not\([^)]*\)|:has\(.*\)|:first-child|:last-child)*$/;
    for (const f of ['layout-focus.css', 'layout-tiles.css']) {
      for (const [selectors, body] of rules(read(`src/renderer/styles/${f}`))) {
        if (!selectors.some((s) => card.test(s))) continue;
        assert.doesNotMatch(body, /background(-color)?:/, `${f}: ${selectors.join(', ')} paints the card`);
      }
    }
    assert.match(read('src/renderer/styles/layout-tiles.css'), /\.quick \{[^}]*background: var\(--ink-800\);/, 'the quick tiles on the card token');
  });

  test('reduced motion: the rings run on --dur-ring (row.css), the quick refresh stops turning', () => {
    const tiles = read('src/renderer/styles/layout-tiles.css');
    assert.match(tiles, /@media \(prefers-reduced-motion: reduce\) \{\s*\.quick\[data-busy="true"\] \.quick__icon svg \{ animation: none; \}/);
    for (const f of FILES) assert.doesNotMatch(read(`src/renderer/styles/${f}`), /animation: ring-sweep|transition: --ring-f/, `${f} re-times the rings`);
  });
});
