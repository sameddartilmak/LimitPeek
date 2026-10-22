'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { FakeElement, installDom, mirrorRenderer, walk } = require('./helpers/fake-dom');

const ROOT = path.join(__dirname, '..');

/**
 * Görünüm → Düzen, drawn: "Sade liste" and "Halka kutuları" (the minimal
 * redesign, 2026-10-22) through the REAL `mountApp` on test/helpers/fake-dom.js
 * (no layout, no CSS: the DOM facts the layouts promise), plus guards on the
 * stylesheets that hold the rest.
 *
 *   - the same cards in both layouts: every window is still a meter with its
 *     value and its sentence, and carries its compact tag ("5sa", "7g");
 *   - every state keeps its words: stale, estimated, error and retry, not
 *     connected and its action, a window with no figure, one window, a tool
 *     with no quota, the first scan, the setup question;
 *   - a closed tool carries its hover line (who, and when each window resets);
 *   - a click on a tool opens its details as a sheet, and "Tüm araçlar", the
 *     card's own control and Esc all lead back, focus on the tool;
 *   - only the short list can be dragged;
 *   - the header is the brand and three icons: refresh (the one refresh, its
 *     name and tooltip saying the last scan), pin, settings. No close, no
 *     footer.
 */

let mirror;
let restoreDom;
let appMod;
let i18n;

test.before(async () => {
  restoreDom = installDom();
  mirror = mirrorRenderer();
  appMod = await mirror.load('app.js');
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
// Thirty seconds of slack, so a countdown read a few milliseconds after NOW
// still prints the whole minutes the fixture names.
const later = (h) => new Date(NOW + h * 3600_000 + 30_000).toISOString();
const win = (pct, h, extra = {}) => ({ usedPercentage: pct, certainty: 'known', resetsAt: later(h), ...extra });
function provider(id, name, five, week, extra = {}) {
  return {
    id, displayName: name, accent: '#D97757', enabled: true, connected: true, status: 'ok', planLabel: null,
    fiveHour: five, sevenDay: week, tokens: null, weeklyTokens: null, burnRatePerHour: null, weeklyCost: null,
    setupAction: null, ...extra,
  };
}
const SNAP = () => ({
  generatedAt: new Date(NOW - 60_000).toISOString(),
  providers: [
    provider('claude', 'Claude Code', win(62, 2.25), win(41, 76), { planLabel: 'Max 20x' }),
    provider('codex', 'Codex CLI', win(18, 4), win(57, 90)),
    provider('antigravity', 'Antigravity', win(84, 1), win(23, 120)),
  ],
});
/** Every state at once. */
const STATES = () => ({
  generatedAt: new Date().toISOString(),
  providers: [
    provider('claude', 'Claude Code', win(62, 2, { certainty: 'estimated', capturedAt: later(-0.5) }), win(41, 50, { capturedAt: later(-0.5) }), { status: 'stale', planLabel: 'Max 20x' }),
    provider('codex', 'Codex CLI', win(30, 4), { usedPercentage: null, certainty: 'unknown', resetsAt: null, absence: 'not-supplied' }),
    provider('antigravity', 'Antigravity', null, win(23, 120)),
    provider('grok', 'Grok Build', win(70, 1), win(50, 20), { status: 'error', errorCode: 'parse-failed' }),
    provider('kimi', 'Kimi Code', null, null, {
      status: 'passive', connected: false, setupAction: { kind: 'enable', label: 'Ekle', detail: 'Bu makinede bulunamadı.' },
    }),
    provider('qwen', 'Qwen Code', null, null, { status: 'loading' }),
    provider('qwenlive', 'Qwen Live', null, null, {
      weeklyTokens: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0, billable: 6_200_000 }, weeklyTokensWindowAnchored: false, experimental: true,
    }),
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
    pin() { calls.push('pin'); },
    close() { calls.push('close'); },
    setPointerOverPanel() {},
    requestRefresh: async () => { calls.push('refresh'); return null; },
    setOrder: async (ids) => { calls.push(`order:${ids.join(',')}`); return true; },
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

const LAYOUTS = ['sade', 'halka'];

// --------------------------------------------------- the same cards everywhere

test.describe('the same cards in both layouts', () => {
  for (const layout of LAYOUTS) {
    test(`${layout}: every window is still a meter with its value, its sentence and its compact tag`, async () => {
      const app = mount({ layout });
      try {
        await tick();
        assert.equal(document.documentElement.dataset.layout, layout);
        const meters = app.all((n) => n.getAttribute('role') === 'meter');
        assert.equal(meters.length, 6);
        for (const m of meters) {
          assert.match(m.getAttribute('aria-valuenow'), /^\d+$/);
          assert.ok(m.getAttribute('aria-valuetext').includes(m.getAttribute('aria-valuenow')));
        }
        // "5sa %62 · 7g %41": the tag beside each figure, in the head a
        // screen reader skips (the meter's sentence names the window in full).
        const claude = app.row('claude');
        const tags = walk(claude).filter((n) => cls(n).includes('win__tag'));
        assert.deepEqual(tags.map((n) => n.textContent), ['5sa', '7g']);
        for (const tag of tags) assert.equal(tag.parentNode.getAttribute('aria-hidden'), 'true');
        assert.deepEqual(walk(claude).filter((n) => cls(n).includes('win__pct')).map((n) => n.textContent), ['%62', '%41']);
        // The plan stays in the card (CSS shows it in the details only).
        assert.ok(app.find((n) => cls(n).includes('row__plan') && n.textContent.includes('Max 20x')));
      } finally {
        app.handle.destroy();
      }
    });

    test(`${layout}: every state keeps its words, its meters and its actions`, async () => {
      const app = mount({ layout }, STATES());
      try {
        await tick();
        const meters = app.all((n) => n.getAttribute('role') === 'meter');
        assert.equal(meters.length, 6, 'claude 2, codex 1, antigravity 1, grok 2');
        // Estimated and stale, both said.
        const claude = app.row('claude');
        assert.ok(walk(claude).some((n) => cls(n).includes('win__pct') && n.textContent.startsWith('≈')), 'the estimate sign');
        assert.ok(walk(claude).some((n) => cls(n).includes('row__chip--stale')), 'the stale chip');
        // A window with no figure: its words, no bar, its own sentence.
        const none = walk(app.row('codex')).filter((n) => cls(n).includes('win--7d'));
        assert.equal(none.length, 1);
        assert.equal(walk(none[0]).find((n) => cls(n).includes('win__pct--none')).textContent, i18n.t('absence.notReported'));
        assert.equal(walk(none[0]).some((n) => cls(n).includes('rail')), false);
        assert.equal(none[0].getAttribute('role'), 'group');
        assert.ok(none[0].getAttribute('aria-label'));
        // One window: one block, one tag.
        const one = app.row('antigravity');
        assert.deepEqual(walk(one).filter((n) => /\bwin--/.test(n.getAttribute('class') || '')).map((n) => n.getAttribute('data-win')), ['7d']);
        assert.deepEqual(walk(one).filter((n) => cls(n).includes('win__tag')).map((n) => n.textContent), ['7g']);
        // The error and its retry, in the card.
        const grok = app.row('grok');
        assert.ok(walk(grok).some((n) => cls(n).includes('row__err')));
        assert.ok(walk(grok).some((n) => n.tagName === 'BUTTON' && n.textContent === i18n.t('row.retry')));
        // Not connected: its action and its reason.
        const kimi = app.row('kimi');
        assert.ok(walk(kimi).some((n) => n.tagName === 'BUTTON' && n.textContent === 'Ekle'));
        assert.ok(walk(kimi).some((n) => cls(n).includes('row__meta-detail') && n.textContent === 'Bu makinede bulunamadı.'));
        // Loading: its placeholders, busy.
        const qwen = app.row('qwen');
        assert.equal(qwen.getAttribute('aria-busy'), 'true');
        assert.equal(walk(qwen).filter((n) => cls(n).includes('sk--rail')).length, 2);
        // No quota: the main measure, its window named.
        const measure = walk(app.row('qwenlive')).find((n) => cls(n).includes('row__primary'));
        assert.ok(measure && /6,2\sMn/.test(measure.textContent), measure && measure.textContent);
      } finally {
        app.handle.destroy();
      }
    });
  }

  test('the first scan: the skeleton list, in both layouts', async () => {
    for (const layout of LAYOUTS) {
      const app = mount({ layout }, null);
      try {
        await tick();
        const busy = app.find((n) => n.tagName === 'UL' && n.getAttribute('aria-busy') === 'true');
        assert.ok(busy && visible(busy), `${layout}: no skeleton list`);
        assert.ok(walk(busy).filter((n) => cls(n).includes('sk--rail')).length >= 2);
      } finally {
        app.handle.destroy();
      }
    }
  });
});

// ------------------------------------------------------------ the hover line

test.describe('the hover line', () => {
  for (const layout of LAYOUTS) {
    test(`${layout}: a closed tool names itself and when each window resets`, async () => {
      const app = mount({ layout });
      try {
        await tick();
        const tip = app.row('claude').getAttribute('data-tip');
        assert.equal(tip, 'Claude Code\n5 saatlik 2 sa 15 dk sonra sıfırlanır\nHaftalık 3 gün 4 sa sonra sıfırlanır');
        // A data-tip, never a title: the list item gets no description that
        // would repeat every meter's sentence.
        assert.equal(app.row('claude').getAttribute('title'), null);
        assert.equal(app.row('claude').getAttribute('aria-description'), null);
      } finally {
        app.handle.destroy();
      }
    });
  }

  test('a window with no reset says its figure or its word; a tool not connected says why', async () => {
    const app = mount({ layout: 'halka' }, STATES());
    try {
      await tick();
      assert.equal(app.row('codex').getAttribute('data-tip'), 'Codex CLI\n5 saatlik 4 sa sonra sıfırlanır\nHaftalık bildirilmiyor');
      assert.equal(app.row('kimi').getAttribute('data-tip'), 'Kimi Code\nBu makinede bulunamadı.');
      // The experimental pill is not drawn on the tile; the hover line says it.
      assert.match(app.row('qwenlive').getAttribute('data-tip'), /^Qwen Live\n6,2\sMn token Son 7 gün\nDeneysel: Bu aracın kayıt biçimi/);
      assert.ok(walk(app.row('qwenlive')).some((n) => n.getAttribute('data-experimental') === 'true'), 'the pill is still in the card');
      assert.equal(app.row('qwen').getAttribute('data-tip'), null, 'nothing to say while it loads');
    } finally {
      app.handle.destroy();
    }
  });

  test('an open tool has no hover line: its details say all of it', async () => {
    const app = mount({ layout: 'sade' });
    try {
      await tick();
      app.row('codex').click();
      await tick();
      assert.equal(app.row('codex').getAttribute('data-expanded'), 'true');
      assert.equal(app.row('codex').getAttribute('data-tip'), null);
    } finally {
      app.handle.destroy();
    }
  });
});

// ---------------------------------------------------------- the grip, the click

test.describe('a tool and its details', () => {
  const grip = (r) => walk(r).find((n) => cls(n).includes('grip'));

  test('the short list can be dragged; in the ring tiles the mark is a logo, not a handle', async () => {
    let app = mount({ layout: 'sade' });
    try {
      await tick();
      const g = grip(app.row('claude'));
      assert.equal(g.disabled, false);
      assert.equal(g.getAttribute('aria-hidden'), null);
      assert.equal(g.getAttribute('aria-describedby'), 'reorder-help');
    } finally {
      app.handle.destroy();
    }
    app = mount({ layout: 'halka' });
    try {
      await tick();
      const g = grip(app.row('claude'));
      assert.equal(g.disabled, true);
      assert.equal(g.getAttribute('aria-hidden'), 'true');
      assert.equal(g.getAttribute('aria-describedby'), null);
      assert.equal(g.getAttribute('title'), null, 'no "drag to move" tooltip');
    } finally {
      app.handle.destroy();
    }
  });

  for (const layout of LAYOUTS) {
    test(`${layout}: a click opens the details as a sheet; the back control, the card's own and Esc lead back`, async () => {
      const app = mount({ layout });
      try {
        await tick();
        const tool = app.row('codex');
        assert.equal(tool.getAttribute('data-opens'), 'true');
        tool.click();
        await tick();
        assert.equal(tool.getAttribute('data-expanded'), 'true');
        assert.equal(app.list().getAttribute('data-sheet'), 'true');
        const back = app.find((n) => cls(n).includes('sheet-back'));
        assert.equal(back.hidden, false);
        assert.equal(back.getAttribute('aria-label'), i18n.t('layout.sheet.backLabel'));
        assert.equal(tool.getAttribute('data-opens'), null, 'an open card does not toggle on a click inside it');
        tool.click();
        await tick();
        assert.equal(tool.getAttribute('data-expanded'), 'true');

        const more = walk(tool).find((n) => cls(n).includes('row__more'));
        back.click();
        await tick();
        assert.equal(tool.getAttribute('data-expanded'), null);
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

        // The card's own "Ayrıntıları gizle" closes it too.
        tool.click();
        await tick();
        more.click();
        await tick();
        assert.equal(app.list().getAttribute('data-sheet'), null);

        // With no sheet open, Esc closes the panel: the header has no close.
        app.esc();
        await new Promise((r) => setTimeout(r, 180));
        assert.ok(app.calls.includes('close'));
      } finally {
        app.handle.destroy();
      }
    });
  }

  test('a control on a tool keeps its own action and opens nothing', async () => {
    const snap = SNAP();
    snap.providers[1].status = 'error';
    snap.providers[1].errorCode = 'timeout';
    for (const layout of LAYOUTS) {
      const app = mount({ layout }, snap);
      try {
        await tick();
        const retry = walk(app.row('codex')).find((n) => n.tagName === 'BUTTON' && n.textContent === i18n.t('row.retry'));
        retry.click();
        app.row('codex').dispatch('click', { target: retry });
        await tick();
        assert.equal(app.row('codex').getAttribute('data-expanded'), null, layout);
        assert.ok(app.calls.includes('refresh'), 'the retry ran');
      } finally {
        app.handle.destroy();
      }
    }
  });

  test('a click inside the setup question drawn in a tool does not open it', async () => {
    const snap = SNAP();
    snap.providers[0].setupAction = { kind: 'install-bridge', label: 'Bağla', detail: 'Claude Code ayarlarına bir satır ekler.' };
    for (const layout of LAYOUTS) {
      const app = mount({ layout }, snap);
      try {
        await tick();
        const tool = app.row('claude');
        walk(tool).find((n) => n.tagName === 'BUTTON' && n.textContent === 'Bağla').click();
        await tick();
        const consent = walk(tool).find((n) => cls(n).includes('consent'));
        assert.ok(consent && !consent.hidden, `${layout}: the question is drawn in the tool`);
        const para = walk(consent).find((n) => cls(n).includes('consent__para'));
        tool.dispatch('click', { target: para });
        await tick();
        assert.equal(tool.getAttribute('data-expanded'), null);
      } finally {
        app.handle.destroy();
      }
    }
  });

  test('a new layout closes an open sheet', async () => {
    const app = mount({ layout: 'sade' });
    try {
      await tick();
      app.row('codex').click();
      await tick();
      assert.equal(app.list().getAttribute('data-sheet'), 'true');
      const radio = app.find((n) => n.tagName === 'INPUT' && n.getAttribute('value') === 'halka');
      radio.checked = true;
      radio.dispatch('change');
      await tick();
      assert.equal(document.documentElement.dataset.layout, 'halka');
      assert.equal(app.row('codex').getAttribute('data-expanded'), null);
      assert.deepEqual(app.calls.filter((c) => c.startsWith('layout:')), ['layout:halka']);
    } finally {
      app.handle.destroy();
    }
  });
});

// ---------------------------------------------------------------- the header

test.describe('the minimal header', () => {
  const iconbtns = (app) => walk(app.find((n) => n.tagName === 'HEADER')).filter((n) => n.tagName === 'BUTTON' && visible(n));

  test('the brand and three icons: refresh, pin, settings; no close, no footer', async () => {
    const app = mount({ layout: 'sade' });
    try {
      await tick();
      const order = iconbtns(app).map((n) => (cls(n).includes('iconbtn--refresh') ? 'refresh' : cls(n).includes('iconbtn--pin') ? 'pin' : cls(n).includes('iconbtn--settings') ? 'settings' : 'other'));
      assert.deepEqual(order, ['refresh', 'pin', 'settings']);
      assert.equal(app.find((n) => n.getAttribute('aria-label') === 'Paneli kapat'), null, 'the close is gone');
      assert.equal(app.find((n) => cls(n).includes('foot')), null, 'the footer is gone');
      assert.equal(app.find((n) => cls(n).includes('quicks')), null, 'the quick tiles are gone');
      // The one refresh control on screen.
      const refreshes = app.all((n) => n.tagName === 'BUTTON' && visible(n) && /yenile/i.test(n.getAttribute('aria-label') || ''));
      assert.equal(refreshes.length, 1);
    } finally {
      app.handle.destroy();
    }
  });

  test('the refresh says the last scan in its name and its tooltip, and refreshes', async () => {
    const app = mount({ layout: 'halka' });
    try {
      await tick();
      const refresh = app.find((n) => cls(n).includes('iconbtn--refresh'));
      assert.match(refresh.getAttribute('aria-label'), /^Şimdi yenile, son tarama \d{2}[:.]\d{2}$/);
      // The title is lifted into the panel's own tooltip (tooltip.ts) when one
      // is installed; either way the words are the same.
      const tip = refresh.getAttribute('title') ?? refresh.getAttribute('data-tip');
      assert.match(tip, /^Yenile · son tarama \d{2}[:.]\d{2}$/);
      refresh.click();
      await tick();
      assert.ok(app.calls.includes('refresh'));
    } finally {
      app.handle.destroy();
    }
  });

  test('the pin stays, a small icon with its promise', async () => {
    const app = mount({ layout: 'sade' });
    try {
      await tick();
      const pin = app.find((n) => cls(n).includes('iconbtn--pin'));
      assert.equal(pin.getAttribute('aria-pressed'), 'false');
      assert.equal(pin.getAttribute('aria-label'), i18n.t('header.pin.labelOff'));
      pin.click();
      assert.ok(app.calls.includes('pin'));
    } finally {
      app.handle.destroy();
    }
  });

  test('in an empty state the refresh steps aside for the state\'s own action', async () => {
    const app = mount({ layout: 'sade' }, { generatedAt: new Date().toISOString(), providers: [] });
    try {
      await tick();
      assert.equal(app.find((n) => cls(n).includes('iconbtn--refresh')).hidden, true);
      assert.ok(app.all((n) => cls(n).includes('empty')).some(visible));
    } finally {
      app.handle.destroy();
    }
  });

  test('the live freshness dot is not drawn; the alarm still is (panel.css)', () => {
    const css = fs.readFileSync(path.join(ROOT, 'src/renderer/styles/panel.css'), 'utf8');
    assert.match(css, /\.fresh\[data-fresh="live"\] \.fresh__dot \{ display: none; \}/);
    assert.match(css, /\.fresh\[data-fresh="stale"\],\s*\.fresh\[data-fresh="offline"\] \{/);
  });
});

// ------------------------------------------------------------------ the CSS

test.describe('the stylesheets', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const FILES = ['layouts.css', 'layout-sade.css', 'layout-halka.css'];
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
  const body = (list, selector) => {
    const found = list.find(([selectors]) => selectors.includes(selector));
    assert.ok(found, `no rule for ${selector}`);
    return found[1];
  };

  test('the panel and the harness load the two layouts, after row.css; the old three are gone', () => {
    for (const [page, prefix] of [['src/renderer/index.html', './styles/'], ['src/renderer/dev/harness.html', '../styles/']]) {
      const html = read(page);
      const at = (f) => html.indexOf(`href="${prefix}${f}"`);
      assert.notEqual(at('row.css'), -1);
      for (const f of FILES) assert.ok(at(f) > at('row.css'), `${page}: ${f}`);
      assert.equal(at('layout-focus.css'), -1);
      assert.equal(at('layout-tiles.css'), -1);
    }
    for (const gone of ['layout-focus.css', 'layout-tiles.css']) {
      assert.equal(fs.existsSync(path.join(ROOT, 'src/renderer/styles', gone)), false, gone);
    }
  });

  test('no :has() inside a :has() (Chromium drops the whole rule), and every rule is scoped to its layout', () => {
    for (const f of FILES) {
      const css = read(`src/renderer/styles/${f}`).replace(/\/\*[\s\S]*?\*\//g, '');
      assert.doesNotMatch(css, /:has\((?:[^()]|\([^()]*\))*:has\(/, `${f}: a nested :has()`);
    }
    for (const [f, layout] of [['layout-sade.css', 'sade'], ['layout-halka.css', 'halka']]) {
      for (const [selectors] of rules(read(`src/renderer/styles/${f}`))) {
        for (const s of selectors) {
          if (s === 'from' || s.startsWith('@property')) continue; // the sweep's keyframe and its number
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
    assert.match(read('src/renderer/styles/layout-sade.css'), /html\[data-layout="sade"\] \.rows:not\(\[data-sheet="true"\]\) \{ border: 1px solid CanvasText; \}/, 'the plate is outlined');
  });

  test('"Sade liste": one 36px line on one plate in the card token, the figures in their own columns', () => {
    const sade = rules(read('src/renderer/styles/layout-sade.css'));
    const S = 'html[data-layout="sade"]';
    assert.match(body(sade, `${S} .rows:not([data-sheet="true"])`), /background: var\(--ink-800\);/, 'the plate is the card surface');
    const line = body(sade, `${S} .row:not([data-expanded])`);
    assert.match(line, /min-height: 36px;/);
    assert.match(line, /background: transparent;/, 'a line is drawn on the plate, not as a card');
    assert.match(body(sade, `${S} .row:not([data-expanded]) .win--5h .win__pct`), /grid-column: 6;/);
    assert.match(body(sade, `${S} .row:not([data-expanded]) .win--7d .win__pct`), /grid-column: 8;/);
    assert.match(body(sade, `${S} .row:not([data-expanded]) .win--5h ~ .win--7d .win__tag::before`), /content: "·";/);
  });

  test('"Halka kutuları": three 96px tiles to a line, centred; a 58px ring for the five-hour window; the tile keeps the card surface', () => {
    const halka = rules(read('src/renderer/styles/layout-halka.css'));
    const H = 'html[data-layout="halka"]';
    const grid = body(halka, `${H} .rows:not([data-sheet="true"])`);
    assert.match(grid, /grid-template-columns: repeat\(auto-fit, minmax\(0, 96px\)\);/);
    assert.match(grid, /justify-content: center;/);
    assert.match(body(halka, `${H} .row:not([data-expanded]) .win--5h .rail`), /--ring: 58px;/);
    // A rule whose subject is the tile itself never paints it: the tiles are
    // cards (row.css), so a window material restyles them.
    const card = /\.row(\[[^\]]*\]|:not\([^)]*\)|:has\(.*\))*$/;
    for (const [selectors, b] of halka) {
      if (!selectors.some((s) => card.test(s))) continue;
      assert.doesNotMatch(b, /background(-color)?:/, `${selectors.join(', ')} paints the tile`);
    }
  });

  test('a bar and a countdown a screen reader needs are hidden from sight, never from the tree', () => {
    const shared = rules(read('src/renderer/styles/layouts.css'));
    const hidden = body(shared, ':is(html[data-layout="sade"], html[data-layout="halka"]) .row:not([data-expanded]) .meter .win__foot');
    assert.match(hidden, /clip-path: inset\(50%\);/);
    assert.doesNotMatch(hidden, /display: none/);
    for (const f of FILES) {
      for (const [selectors, b] of rules(read(`src/renderer/styles/${f}`))) {
        if (!selectors.some((s) => /\.rail$|\.win__foot$/.test(s) && !s.includes('sk--'))) continue;
        assert.doesNotMatch(b, /display: none/, `${f}: ${selectors[0]} takes a meter out of the tree`);
      }
    }
  });

  test('reduced motion: the ring runs on --dur-ring, which tokens.css collapses', () => {
    const halka = read('src/renderer/styles/layout-halka.css');
    assert.match(halka, /animation: halka-sweep var\(--dur-ring\)/);
    assert.match(halka, /transition: --halka-f var\(--dur-ring\)/);
    const tokens = read('src/renderer/styles/tokens.css');
    assert.match(tokens, /prefers-reduced-motion: reduce[\s\S]*--dur-ring: 1ms/);
  });
});
