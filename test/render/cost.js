'use strict';
/**
 * RENDER SUITE — the notional weekly cost block (ADR-002).
 *
 * This is the only coverage of cost.ts's honesty logic as it actually renders:
 * that the figure never appears without its framing sentence, that both
 * caveats turn it into "en az", that an all-unpriced week shows NO currency
 * figure at all, and that a partial payload degrades instead of vanishing.
 * Those are properties of composed DOM, not of a function, so they cannot live
 * in `node --test`.
 *
 *   npm run verify:render
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');

const HERE = __dirname;
const ROOT = path.join(HERE, '..', '..');
const OUT = process.env.RENDER_OUT || path.join(os.tmpdir(), 'usage-notch-render-cost.txt');
const lines = [];
const say = (s) => { lines.push(s); try { fs.writeFileSync(OUT, lines.join('\n') + '\n'); } catch {} };
let failures = 0;
const check = (n, ok, d) => { if (!ok) failures++; say(`${ok ? 'PASS' : 'FAIL'}  ${n}${d === undefined ? '' : '  :: ' + JSON.stringify(d)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 420, height: 900, show: true, x: 20, y: 20,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false,
      preload: path.join(HERE, 'preload-fixture.js') },
  });
  win.webContents.on('console-message', (_e, l, m) => { if (l >= 2) say(`console[${l}]: ${m}`); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(800);
  const js = (c) => win.webContents.executeJavaScript(c, true);

  const q = (id) => `document.querySelector('li.row[data-provider="${id}"]')`;

  // ---- no white frame around the panel on open --------------------------
  //
  // User report: "when it opens there is a white frame around it". Measured on
  // a real tray-click capture as a 2px line at brightness 240 around the whole
  // window — the global :focus-visible outline (2px --ink-100, offset 2px)
  // drawn on the dialog ROOT, which app.ts focuses programmatically on every
  // open. The tray click happens outside the document, so Chromium sees no
  // pointer interaction and treats that focus as keyboard-origin.
  //
  // This suite drives no pointer input at all before this point, which is
  // precisely the condition of a real open. So the first check proves the
  // condition is reproduced — without it the outline check would pass
  // vacuously — and the second proves the root no longer draws in it.
  const ring = await js(`(() => {
    const root = document.querySelector('.panel');
    const cs = getComputedStyle(root);
    return {
      open: root.getAttribute('data-open'),
      focused: document.activeElement === root,
      visibleMatch: root.matches(':focus-visible'),
      outlineStyle: cs.outlineStyle,
      outlineWidth: cs.outlineWidth,
      border: cs.borderTopWidth,
    };
  })()`);
  say('root ring on open: ' + JSON.stringify(ring));
  check('the panel opened and took focus, as app.ts does on every open',
    ring.open === 'true' && ring.focused === true, ring);
  check('the condition that painted the white frame is reproduced here',
    ring.visibleMatch === true, ring);
  check('and in it the dialog root draws no outline at all',
    ring.outlineStyle === 'none', ring);
  // Measured as a RATIO, not in pixels. This window renders at a non-1 scale
  // (0.8 as measured), so a 1px border computes to "0.8px" and the 2px ring to
  // "1.6px". Pinning literals here would assert the test environment's zoom,
  // not the design. The design intent is scale-free: the ring is twice the
  // panel's own border.
  check('its own border is untouched — that is the edge the design intends',
    parseFloat(ring.border) > 0, ring.border);

  // The accessibility half. The fix must be scoped to the root: a real control
  // focused in the SAME state must still show the ring, or keyboard users lose
  // sight of where they are.
  const ctl = await js(`(() => {
    const b = [...document.querySelectorAll('.foot button')].pop();
    b.focus();
    const cs = getComputedStyle(b);
    return {
      label: b.getAttribute('aria-label'),
      focused: document.activeElement === b,
      visibleMatch: b.matches(':focus-visible'),
      outlineStyle: cs.outlineStyle,
      outlineWidth: cs.outlineWidth,
    };
  })()`);
  say('control ring: ' + JSON.stringify(ctl));
  check('a real control focused in the same state still shows the ring',
    ctl.focused === true && ctl.visibleMatch === true && ctl.outlineStyle === 'solid'
      && Math.abs(parseFloat(ctl.outlineWidth) / parseFloat(ring.border) - 2) < 0.1,
    [ctl, ring.border]);

  // The second call site: pinning re-focuses the root when nothing inside the
  // panel holds focus (app.ts onAnchor). Same element, same rule, but a
  // different path to it, and the one a pinned user sees.
  await js(`document.activeElement && document.activeElement.blur()`);
  await js(`window.__probe.setMode('pin')`);
  await sleep(160);
  const pinRing = await js(`(() => {
    const root = document.querySelector('.panel');
    const cs = getComputedStyle(root);
    return {
      focused: document.activeElement === root,
      visibleMatch: root.matches(':focus-visible'),
      outlineStyle: cs.outlineStyle,
    };
  })()`);
  say('root ring on pin: ' + JSON.stringify(pinRing));
  check('pinning re-focuses the root, and that path draws no frame either',
    pinRing.focused === true && pinRing.outlineStyle === 'none', pinRing);
  await js(`window.__probe.setMode('hover')`);
  await sleep(120);

  // ---- the figure never appears without its frame ----------------------
  const framing = await js(`(() => {
    const rows = [...document.querySelectorAll('li.row[data-provider]')];
    const out = {};
    for (const r of rows) {
      const c = r.querySelector('.cost');
      out[r.dataset.provider] = c && !c.hidden ? {
        summary: c.querySelector('.cost__summary').textContent,
        caption: c.querySelector('.cost__caption').textContent,
        captionHidden: c.querySelector('.cost__caption').hidden,
        aria: c.querySelector('.cost__toggle').getAttribute('aria-label'),
        expanded: c.querySelector('.cost__toggle').getAttribute('aria-expanded'),
        detailHidden: c.querySelector('.cost__detail').hidden,
        segs: [...c.querySelectorAll('.cost__seg')].map(s => s.style.flexGrow),
      } : null;
    }
    return out;
  })()`);
  say('framing: ' + JSON.stringify(framing, null, 1));

  const claude = framing.claude;
  check('the cost block renders for a provider with weeklyCost', !!claude);
  check('the amount is inside a framing sentence, never alone',
    /^Yayımlanan API fiyatlarıyla \$226,81 tutardı$/.test(claude.summary), claude.summary);
  check('tr-TR renders USD with a decimal comma', claude.summary.includes('$226,81'), claude.summary);
  check('no caveats means no "en az" floor wording', !claude.summary.includes('en az'), claude.summary);
  check('the accessible name carries the frame AND the denial',
    /API fiyatlarıyla/.test(claude.aria) && /fatura değildir/.test(claude.aria)
    && /ABD doları/.test(claude.aria), claude.aria);
  check('the breakdown is visible without expanding',
    claude.captionHidden === false && claude.segs.length >= 4, [claude.caption, claude.segs]);
  check('the caption names the two largest classes, largest first',
    claude.caption === 'Önbellek okuma %65 · Önbellek yazma %21', claude.caption);
  check('the composition bar is largest-first',
    claude.segs.map(Number).every((v, i, a) => i === 0 || a[i - 1] >= v), claude.segs);
  check('the detail starts collapsed', claude.expanded === 'false' && claude.detailHidden === true);
  check('a provider with no weeklyCost renders no cost block',
    framing.kimi === null, framing.kimi);

  // ---- a sub-cent total is not printed as $0,00 -------------------------
  check('a non-zero total under a cent is an upper bound, not "$0,00"',
    framing.gemini && framing.gemini.summary.includes('<$0,01')
      && !framing.gemini.summary.includes('$0,00'),
    framing.gemini && framing.gemini.summary);

  // ---- qa F1: an all-unpriced week shows NO currency figure -------------
  const unpricedWeek = framing.antigravity;
  check('an all-unpriced week is SHOWN, not hidden', unpricedWeek !== null);
  check('an all-unpriced week prints no currency figure at all — not zero, not a bound',
    !/\$/.test(unpricedWeek.summary) && !/0,00/.test(unpricedWeek.summary)
      && !/en az/.test(unpricedWeek.summary),
    unpricedWeek.summary);
  check('it says instead that the usage could not be priced',
    /fiyat listesinde bulunamadı/.test(unpricedWeek.summary), unpricedWeek.summary);
  check('the spoken name carries no figure either',
    !/\$/.test(unpricedWeek.aria) && !/ABD doları/.test(unpricedWeek.aria)
      && /hesaplanamıyor/.test(unpricedWeek.aria),
    unpricedWeek.aria);
  check('no composition is drawn for a week with nothing priced',
    unpricedWeek.captionHidden === true && unpricedWeek.segs.length === 0, unpricedWeek.segs);

  // ---- code-reviewer F2: a stale row's figure is a floor ----------------
  const staleRow = framing.gemini;
  check('a stale row states its figure as a lower bound',
    /^Yayımlanan API fiyatlarıyla en az /.test(staleRow.summary), staleRow.summary);

  // ---- caveats make the figure a floor ---------------------------------
  const codex = framing.codex;
  check('any excluded or floored usage turns the figure into a lower bound',
    /^Yayımlanan API fiyatlarıyla en az \$/.test(codex.summary), codex.summary);

  // ---- expand ----------------------------------------------------------
  await js(`${q('claude')}.querySelector('.cost__toggle').click()`);
  await js(`${q('codex')}.querySelector('.cost__toggle').click()`);
  await sleep(150);
  const detail = await js(`(() => {
    const pick = (id) => {
      const c = document.querySelector('li.row[data-provider="'+id+'"] .cost');
      return {
        expanded: c.querySelector('.cost__toggle').getAttribute('aria-expanded'),
        hidden: c.querySelector('.cost__detail').hidden,
        lead: c.querySelector('.cost__lead').textContent,
        denial: c.querySelector('.cost__denial').textContent,
        rows: [...c.querySelectorAll('.cost__row')].map(r => ({
          k: r.querySelector('.cost__k').textContent,
          v: r.querySelector('.cost__v').textContent,
          p: r.querySelector('.cost__p').textContent,
          w: r.querySelector('.cost__rowbar').style.getPropertyValue('--w'),
        })),
        caveats: [...c.querySelectorAll('.cost__caveat')].map(p => p.textContent),
        unpriced: [...c.querySelectorAll('.cost__unpriced li')].map(li => li.textContent),
        caveatsHidden: c.querySelector('.cost__caveats').hidden,
        prov: [...c.querySelectorAll('.cost__prov span')].map(s => s.textContent),
      };
    };
    return { claude: pick('claude'), codex: pick('codex') };
  })()`);
  say('detail: ' + JSON.stringify(detail, null, 1));

  check('the toggle expands and reports it', detail.claude.expanded === 'true' && detail.claude.hidden === false);
  check('the expanded lead names the currency outright, once',
    /ABD doları/.test(detail.claude.lead), detail.claude.lead);
  check('the denial is present and unambiguous',
    /fatura değil/.test(detail.claude.denial) && /ödenmiyor/.test(detail.claude.denial),
    detail.claude.denial);
  check('the four token classes are broken out, largest first (the two cache-write tiers are one row)',
    detail.claude.rows.length === 4 && detail.claude.rows[0].k === 'Önbellek okuma'
    && detail.claude.rows.some(r => r.k === 'Önbellek yazma'),
    detail.claude.rows.map(r => r.k));
  check('cache read is the dominant class at ~65%',
    detail.claude.rows[0].p === '%65' && detail.claude.rows[0].v === '$147,04',
    [detail.claude.rows[0].v, detail.claude.rows[0].p]);
  check('the shares add to 100%',
    detail.claude.rows.reduce((a, r) => a + Number(r.w), 0).toFixed(3) === '1.000',
    detail.claude.rows.map(r => r.w));
  check('an anchored, future-ending window says it is in progress',
    /kota haftası/.test(detail.claude.prov[0]) && /sürüyor/.test(detail.claude.prov[0]),
    detail.claude.prov[0]);
  check('the anchored label is NOT "son 7 gün"', !/Son 7 gün/.test(detail.claude.prov[0]), detail.claude.prov[0]);
  check('the price list date is shown, as a calendar date',
    detail.claude.prov[1] === 'Fiyatlar 24 Haziran 2026 tarihli listeye göre', detail.claude.prov[1]);
  check('no caveats means no caveat block', detail.claude.caveatsHidden === true);

  // ---- the two caveats are separate statements -------------------------
  check('both caveats render, as two separate sentences', detail.codex.caveats.length === 2,
    detail.codex.caveats);
  check('the unpriced caveat says the usage was EXCLUDED from the total',
    /toplama katılmadı/.test(detail.codex.caveats[0]), detail.codex.caveats[0]);
  check('the fallback caveat says the total is a FLOOR, and counts events',
    /alt sınır/.test(detail.codex.caveats[1]) && /1\.412/.test(detail.codex.caveats[1])
      && /önbellek yazma kaydında/.test(detail.codex.caveats[1]), detail.codex.caveats[1]);
  check('the fallback caveat carries the denominator and the proportion',
    /1\.412 \/ 1\.781 önbellek yazma kaydında \(%79\)/.test(detail.codex.caveats[1]),
    detail.codex.caveats[1]);
  check('the two caveats are not merged into one sentence',
    detail.codex.caveats[0] !== detail.codex.caveats[1]);
  check('unpriced usage is named as a (model, speed) pair, not a bare model',
    detail.codex.unpriced.length === 1 && /claude-opus-4-8/.test(detail.codex.unpriced[0])
      && /hızlı/.test(detail.codex.unpriced[0]), detail.codex.unpriced);
  check('the priced standard-speed row for the SAME model is not called unpriced',
    !detail.codex.unpriced.some(u => /standart/.test(u)), detail.codex.unpriced);
  check('a non-anchored window is labelled as a trailing seven days',
    /^Son 7 gün/.test(detail.codex.prov[0]), detail.codex.prov[0]);

  // ---- the all-unpriced expanded state ---------------------------------
  await js(`${q('antigravity')}.querySelector('.cost__toggle').click()`);
  await js(`${q('gemini')}.querySelector('.cost__toggle').click()`);
  await sleep(150);
  const noPrice = await js(`(() => {
    const pick = (id) => {
      const c = document.querySelector('li.row[data-provider="'+id+'"] .cost');
      return {
        lead: c.querySelector('.cost__lead').textContent,
        denialHidden: c.querySelector('.cost__denial').hidden,
        rows: c.querySelectorAll('.cost__row').length,
        caveats: [...c.querySelectorAll('.cost__caveat')].map(p => p.textContent),
        unpriced: [...c.querySelectorAll('.cost__unpriced li')].map(li => li.textContent),
        flag: c.dataset.unpriced || null,
      };
    };
    return { anti: pick('antigravity'), gem: pick('gemini') };
  })()`);
  say('noPrice: ' + JSON.stringify(noPrice, null, 1));
  check('the expanded all-unpriced lead carries no figure',
    !/\$/.test(noPrice.anti.lead) && /hesaplanamadı/.test(noPrice.anti.lead), noPrice.anti.lead);
  check('the bill denial is suppressed when there is no amount to deny',
    noPrice.anti.denialHidden === true);
  check('the caveat says ALL of it, not "bir bölümü"',
    /tamamı/.test(noPrice.anti.caveats[0]) && !/bir bölümü/.test(noPrice.anti.caveats[0]),
    noPrice.anti.caveats[0]);
  check('the models and their token counts are named, so the usage is visible',
    noPrice.anti.unpriced.length === 2
      && noPrice.anti.unpriced.every(u => /claude-opus-6/.test(u) && /token/.test(u))
      && noPrice.anti.unpriced.some(u => /standart/.test(u))
      && noPrice.anti.unpriced.some(u => /hızlı/.test(u)),
    noPrice.anti.unpriced);
  check('the row is flagged as unpriced for styling', noPrice.anti.flag === 'true');
  check('a stale row explains WHY its figure is a bound',
    noPrice.gem.caveats.some(t => /güncel değil/.test(t)), noPrice.gem.caveats);

  // ---- a partial payload degrades, it does not vanish -------------------
  await js(`${q('copilot')}.querySelector('.cost__toggle').click()`);
  await sleep(120);
  const partial = await js(`(() => {
    const c = document.querySelector('li.row[data-provider="copilot"] .cost');
    if (!c || c.hidden) return null;
    return {
      summary: c.querySelector('.cost__summary').textContent,
      barHidden: c.querySelector('.cost__bar').hidden,
      captionHidden: c.querySelector('.cost__caption').hidden,
      rows: c.querySelectorAll('.cost__row').length,
      caveats: c.querySelector('.cost__caveats').hidden,
      prov: [...c.querySelectorAll('.cost__prov span')].map(s => s.textContent),
      gap: !!c.querySelector('.cost__gap'),
    };
  })()`);
  say('partial: ' + JSON.stringify(partial));
  check('a payload missing byClass and provenance still renders the figure',
    partial !== null && /Yayımlanan API fiyatlarıyla \$41,50 tutardı/.test(partial.summary),
    partial && partial.summary);
  check('the composition is suppressed rather than drawn empty',
    partial.barHidden === true && partial.captionHidden === true && partial.rows === 0, partial);
  check('a missing price-list date is STATED, not silently omitted',
    partial.gap === true && partial.prov.some(t => /tarihi bildirilmedi/.test(t)), partial.prov);
  check('a missing window range falls back to the un-dated label',
    /kota haftası/.test(partial.prov[0]) && !/–/.test(partial.prov[0]), partial.prov[0]);
  check('no floor caveat when nothing took the fallback', partial.caveats === true);

  // ---- survives a snapshot push ----------------------------------------
  await js(`window.__probe.push()`);
  await sleep(200);
  const after = await js(`(() => {
    const c = document.querySelector('li.row[data-provider="claude"] .cost');
    return { expanded: c.querySelector('.cost__toggle').getAttribute('aria-expanded'),
             rows: c.querySelectorAll('.cost__row').length };
  })()`);
  check('the disclosure survives a pushed snapshot',
    after.expanded === 'true' && after.rows === 4, after);

  // ---- per-model quota detail ------------------------------------------
  //
  // The user asked to see Antigravity's usage broken down with "Claude and GPT
  // usage visible separately inside". The load-bearing rule is that the figure
  // lives on the GROUP and members carry names only: an Antigravity row lists
  // "Claude Opus 4.6" directly beneath the user's real Claude Code row, and
  // "Claude Opus 4.6 · %60" would read as a claim about their Claude
  // subscription in every screenshot and every screen-reader pass.
  const quotaCollapsed = await js(`(() => {
    const b = ${q('antigravity')}.querySelector('.quota');
    const t = b.querySelector('.quota__toggle');
    return {
      present: !b.hidden,
      expanded: t.getAttribute('aria-expanded'),
      detailHidden: b.querySelector('.quota__detail').hidden,
      summary: b.querySelector('.quota__summary').textContent,
      name: t.getAttribute('aria-label'),
      controls: t.getAttribute('aria-controls'),
      controlsExists: !!document.getElementById(t.getAttribute('aria-controls')),
      // Nothing in the collapsed state may show a percentage: the meter above
      // owns the row's reading and a second figure here competes with it.
      percentInCollapsed: /%/.test(t.textContent),
    };
  })()`);
  say('quota collapsed: ' + JSON.stringify(quotaCollapsed));
  check('a provider reporting per-model quota gets the block',
    quotaCollapsed.present === true, quotaCollapsed);
  check('it starts collapsed, so the hover panel stays quiet',
    quotaCollapsed.expanded === 'false' && quotaCollapsed.detailHidden === true, quotaCollapsed);
  check('the collapsed line counts models and shows no figure at all',
    /8 model/.test(quotaCollapsed.summary) && quotaCollapsed.percentInCollapsed === false,
    quotaCollapsed.summary);
  check('with one shared figure it does not claim a spread',
    /farklı oran/.test(quotaCollapsed.summary) === false, quotaCollapsed.summary);
  check('the toggle names the provider for a reader with no surrounding layout',
    /^Antigravity:/.test(quotaCollapsed.name || ''), quotaCollapsed.name);
  check('and it points at a panel that exists',
    quotaCollapsed.controlsExists === true, quotaCollapsed.controls);

  await js(`${q('antigravity')}.querySelector('.quota__toggle').click()`);
  await sleep(160);
  const quotaOpen = await js(`(() => {
    const b = ${q('antigravity')}.querySelector('.quota');
    const groups = [...b.querySelectorAll('.quota__group')];
    return {
      expanded: b.querySelector('.quota__toggle').getAttribute('aria-expanded'),
      lead: (b.querySelector('.quota__lead') || {}).textContent,
      denial: (b.querySelector('.quota__denial') || {}).textContent,
      groups: groups.length,
      heads: groups.map(g => g.querySelector('.quota__head').textContent),
      headStates: groups.map(g => g.querySelector('.quota__head').dataset.state),
      members: groups.map(g => [...g.querySelectorAll('.quota__models > li')].map(li => li.textContent)),
      notes: [...b.querySelectorAll('.quota__note')].map(n => n.textContent),
      // The denial must come BEFORE any model name in document order: a caveat
      // placed after the thing it qualifies has already been misread.
      denialFirst: (() => {
        const d = b.querySelector('.quota__denial');
        const first = b.querySelector('.quota__models > li');
        return !!(d && first) &&
          (d.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      })(),
    };
  })()`);
  say('quota open: ' + JSON.stringify(quotaOpen));
  check('expanding shows the group and its models', quotaOpen.expanded === 'true'
    && quotaOpen.groups === 1 && quotaOpen.members[0].length === 8, quotaOpen);
  check('the figure sits on the GROUP heading, once',
    /%0 kullanıldı/.test(quotaOpen.heads[0]) && /8 model/.test(quotaOpen.heads[0]),
    quotaOpen.heads);
  check('the group figure takes the state ramp, like the meter above it',
    quotaOpen.headStates[0] === 'calm', quotaOpen.headStates);
  check('Claude and GPT appear by name, which is what was asked for',
    quotaOpen.members[0].some(m => /Claude Opus/.test(m))
      && quotaOpen.members[0].some(m => /GPT-OSS/.test(m)), quotaOpen.members[0]);
  check('the denial is present and names the confusion it prevents',
    /kendi satırı olan araçların kotasıyla ilgileri yoktur/.test(quotaOpen.denial || ''),
    quotaOpen.denial);
  check('and it is rendered above the model names, not under them',
    quotaOpen.denialFirst === true, quotaOpen.denialFirst);
  check('a derived figure says so: it came from an undocumented local store',
    quotaOpen.notes.some(n => /Belgelenmiş bir arayüz değil/.test(n)), quotaOpen.notes);
  check('and it never appears without the instant it was measured',
    quotaOpen.notes.some(n => /itibarıyla/.test(n)), quotaOpen.notes);

  // ---- the selected model is marked, with no figure beside its name ------
  const selected = await js(`(() => {
    const b = ${q('antigravity')}.querySelector('.quota');
    const firstGroup = b.querySelector('.quota__group');
    const marked = [...b.querySelectorAll('.quota__models > li.quota__model--selected')];
    const one = marked[0] || null;
    return {
      markedCount: marked.length,
      name: one ? (one.querySelector('.quota__model-name') || {}).textContent : null,
      tag: one ? (one.querySelector('.quota__sel') || {}).textContent : null,
      hasPercent: one ? /%/.test(one.textContent) : null,
      aria: one ? one.getAttribute('aria-label') : null,
      inPointedGroup: one ? one.closest('.quota__group') === firstGroup : null,
    };
  })()`);
  say('selected marker: ' + JSON.stringify(selected));
  check('exactly one member is marked selected', selected.markedCount === 1, selected);
  check('it is the model the user picked in Antigravity',
    selected.name === 'Claude Opus 4.6 (Thinking)', selected.name);
  check('the mark is the label "seçili" and carries NO percentage',
    selected.tag === 'seçili' && selected.hasPercent === false, selected);
  check('a screen reader hears "seçili model" with no figure in the phrase',
    /seçili model/.test(selected.aria || '') && !/%/.test(selected.aria || ''), selected.aria);
  check('the mark sits in the group the contract pointed at',
    selected.inPointedGroup === true, selected);

  // ---- the row headline says the figure is the SELECTED model's ----------
  // Main ties the five-hour figure to the selected model's group, so the number
  // shifts when the user switches model. The label makes that cause visible —
  // and it is a ROLE ("seçili model"), never a model name, so nothing reads as
  // a claim about the Claude Code row above.
  const headline = await js(`(() => {
    const row = ${q('antigravity')};
    const label = row.querySelector('.win--5h .win__label');
    const rail = row.querySelector('.win--5h [role="meter"]');
    return {
      label: label ? label.textContent : null,
      spoken: rail ? rail.getAttribute('aria-label') : null,
      hasName: label ? /Claude|Opus|Sonnet|Gemini|GPT|Flash/.test(label.textContent) : null,
    };
  })()`);
  say('headline label: ' + JSON.stringify(headline));
  check('the five-hour label is qualified as the selected model',
    /5 saatlik pencere/.test(headline.label || '') && /seçili model/.test(headline.label || ''),
    headline.label);
  check('the qualifier is a role, never the model name',
    headline.hasName === false, headline.label);
  check('the meter speaks the qualifier too',
    /seçili model/.test(headline.spoken || ''), headline.spoken);

  // THE CHECK THIS WHOLE COMPONENT EXISTS FOR.
  const pairing = await js(`(() => {
    const b = ${q('antigravity')}.querySelector('.quota');
    // Any element whose text contains BOTH a model name and a percentage,
    // other than an ancestor that legitimately holds a group heading and its
    // list. Leaf-level pairing is what must not exist.
    return [...b.querySelectorAll('.quota__models > li')]
      .filter(li => /%/.test(li.textContent))
      .map(li => li.textContent);
  })()`);
  check('NO model name is ever rendered next to a percentage',
    pairing.length === 0, pairing);

  // Divergence: the same block, two groups. Antigravity's own UI splits these
  // as "Gemini models" and "Claude and GPT models", and the decode clusters
  // them exactly that way.
  await js(`window.__probe.setWindowsDirect('antigravity', { modelQuotas: {
    groups: [
      { usedPercentage: 60, resetsAt: null,
        members: ['Claude Opus 4.6 (Thinking)', 'Claude Sonnet 4.6 (Thinking)', 'GPT-OSS 120B (Medium)'] },
      { usedPercentage: 0, resetsAt: null,
        members: ['Gemini 3.1 Pro (High)', 'Gemini 3.1 Pro (Low)'] }
    ],
    diverged: true,
    source: 'antigravity.ide.quota_info.remaining_fraction',
    provenance: 'derived',
    capturedAt: new Date().toISOString(),
  } })`);
  await sleep(200);
  const diverged = await js(`(() => {
    const b = ${q('antigravity')}.querySelector('.quota');
    const groups = [...b.querySelectorAll('.quota__group')];
    return {
      summary: b.querySelector('.quota__summary').textContent,
      expanded: b.querySelector('.quota__toggle').getAttribute('aria-expanded'),
      groups: groups.length,
      heads: groups.map(g => g.querySelector('.quota__head').textContent),
      states: groups.map(g => g.querySelector('.quota__head').dataset.state),
      claudeLine: [...b.querySelectorAll('.quota__models > li')]
        .map(li => li.textContent).filter(t => /Claude Opus/.test(t)),
      anyPaired: [...b.querySelectorAll('.quota__models > li')].some(li => /%/.test(li.textContent)),
    };
  })()`);
  say('quota diverged: ' + JSON.stringify(diverged));
  check('when the figures differ the groups separate on their own',
    diverged.groups === 2, diverged);
  check('and the collapsed line says so, still without a figure',
    /2 farklı oran/.test(diverged.summary) && !/%/.test(diverged.summary), diverged.summary);
  check('each group carries its own figure and its own ramp step',
    /%60/.test(diverged.heads[0]) && /%0/.test(diverged.heads[1])
      && diverged.states[0] === 'watch' && diverged.states[1] === 'calm', diverged);
  check('the disclosure stays open across a pushed snapshot',
    diverged.expanded === 'true', diverged.expanded);
  check('"Claude Opus 4.6" is on screen and still carries no number of its own',
    diverged.claudeLine.length === 1 && diverged.anyPaired === false, diverged.claudeLine);

  // A provider with no per-model detail must show no block at all — an empty
  // disclosure is indistinguishable from a broken one.
  const noQuota = await js(`${q('claude')}.querySelector('.quota') === null
    || ${q('claude')}.querySelector('.quota').hidden`);
  check('a provider that reports no per-model detail gets no block',
    noQuota === true, noQuota);

  await js(`${q('antigravity')}.querySelector('.quota__toggle').click()`);
  await sleep(120);


  // ---- the "Antigravity açık değil" bubble -------------------------------
  // Only on an explicit refresh whose reply carries the notice, never on a
  // push, and calm rather than the error row.
  check('no refresh bubble on a normal load',
    (await js(`document.querySelector('.coach--calm').hidden`)) === true);

  await js(`window.__probe.push()`);
  await sleep(120);
  check('a background push never raises it',
    (await js(`document.querySelector('.coach--calm').hidden`)) === true);

  await js(`window.__probe.setRefreshNotices(['ANTIGRAVITY_NOT_RUNNING'])`);
  await js(`[...document.querySelectorAll('.foot button')].pop().click()`);
  await sleep(220);
  const bubble = await js(`(() => {
    const b = document.querySelector('.coach--calm');
    const plain = document.querySelector('.coach:not(.coach--calm)');
    const text = (b.querySelector('.coach__text') || {}).textContent || '';
    const calmAccent = getComputedStyle(b).borderLeftColor;
    return {
      hidden: b.hidden,
      role: b.getAttribute('role'),
      text,
      dismiss: (b.querySelector('button') || {}).textContent,
      calmAccent,
      plainAccent: plain ? getComputedStyle(plain).borderLeftColor : null,
      accentReal: /^rgb/.test(calmAccent) && calmAccent !== 'rgba(0, 0, 0, 0)',
    };
  })()`);
  say('refresh bubble: ' + JSON.stringify(bubble));
  check('an explicit refresh with the IDE closed raises the bubble',
    bubble.hidden === false && /Antigravity açık değil/.test(bubble.text), bubble);
  check('it is calm — nothing broke — and no longer promises values a rolled-over row cannot show',
    !/hata|bozuk|sorun var/i.test(bubble.text)
      && /hâlâ geçerli olan son ölçümler/.test(bubble.text)
      && !/açtığınızdaki ölçüm/.test(bubble.text),
    bubble.text);
  check('it is a polite status region, not an alarm', bubble.role === 'status', bubble.role);
  check('it can be dismissed', bubble.dismiss === 'Tamam', bubble.dismiss);
  check('its left accent is a real colour and distinct from the neutral coach note',
    bubble.accentReal === true && bubble.calmAccent !== bubble.plainAccent,
    [bubble.calmAccent, bubble.plainAccent]);

  await js(`document.querySelector('.coach--calm button').click()`);
  await sleep(120);
  check('dismiss clears the bubble',
    (await js(`document.querySelector('.coach--calm').hidden`)) === true);

  await js(`window.__probe.setRefreshNotices(null)`);
  await js(`[...document.querySelectorAll('.foot button')].pop().click()`);
  await sleep(220);
  check('a clean refresh leaves it down',
    (await js(`document.querySelector('.coach--calm').hidden`)) === true);

  // ---- item 4: nothing assumed the window was activated on open ----------
  // The core lane opens the window inactive (showInactive, no focus()). The
  // keyboard path must survive the user's FIRST click granting focus, and the
  // only way that fails is if the path depended on focus arriving on open.
  //
  // This is asserted STRUCTURALLY, not by calling .focus(): once the always-on-
  // top Usage Notch app takes foreground, element.focus() no-ops in this test
  // window (the same environmental steal that breaks the pointer suite). What
  // is deterministic — and is the actual property — is that Tab from <body>
  // lands inside the panel because index.html mounts #app and nothing else,
  // and that the first tab stop is a real, enabled control. Nothing here runs
  // on open; it all waits for the click that grants focus.
  const kb = await js(`(() => {
    // Everything Tab can reach, in document order.
    const focusables = [...document.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter((e) => e.offsetParent !== null || e === document.activeElement);
    const first = focusables[0] || null;
    // A REAL row grip, not the skeleton row's aria-hidden .grip--empty span.
    const grip = document.querySelector('li.row[data-provider] button.grip');
    return {
      // The dialog root is the only tabindex=-1 element: reachable by script on
      // open, never a Tab stop, so it cannot swallow the first Tab.
      rootIsSkipped: document.querySelector('.panel').getAttribute('tabindex') === '-1',
      firstInsidePanel: !!(first && first.closest && first.closest('.panel')),
      firstTag: first ? first.tagName : null,
      gripIsButton: !!grip && grip.tagName === 'BUTTON' && !grip.disabled,
      gripTabbable: !!grip && grip.tabIndex >= 0,
    };
  })()`);
  say('keyboard path: ' + JSON.stringify(kb));
  check('the dialog root is tabindex=-1, so it never eats the first Tab',
    kb.rootIsSkipped === true, kb);
  check('the first Tab stop is a real control inside the panel',
    kb.firstInsidePanel === true && kb.firstTag === 'BUTTON', kb);
  check('the drag grip is a genuine, tabbable button — the keyboard reorder path',
    kb.gripIsButton === true && kb.gripTabbable === true, kb);

  // ---- no bare total anywhere in the rendered text ---------------------
  const bare = await js(`(() => {
    const RE = /^~?(en az )?<?\$[\d.,]+$/;
    const isBare = (n) => n.children.length === 0 && RE.test(n.textContent.trim());
    // Every bare amount must sit in a breakdown-table value cell, where the
    // row's own label supplies the frame. Anywhere else is a naked total.
    return [...document.querySelectorAll('.cost *')].filter(isBare)
      .filter(n => !(n.classList.contains('cost__v') && n.closest('.cost__table')))
      .map(n => n.className + ':' + n.textContent.trim());
  })()`);
  check('no leaf node is a bare currency amount outside the breakdown table',
    bare.length === 0, bare);

  await js(`${q('claude')}.querySelector('.cost__toggle').click()`);
  await js(`document.querySelector('.panel__band--list').scrollTop = 220`);
  await sleep(250);
  say(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}  (${lines.filter(l => l.startsWith('PASS')).length} pass)`);
  app.exit(failures === 0 ? 0 : 1);
}).catch((e) => { say('THREW: ' + (e && e.stack ? e.stack : e)); app.exit(1); });
