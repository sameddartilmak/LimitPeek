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
    claude.caption === 'Önbellek okuma %65 · Çıktı %14', claude.caption);
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
  check('all five token classes are broken out, largest first',
    detail.claude.rows.length === 5 && detail.claude.rows[0].k === 'Önbellek okuma',
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
    after.expanded === 'true' && after.rows === 5, after);

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
