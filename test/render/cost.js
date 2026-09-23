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

  // ---- the row's token figure is the WEEK's, and every figure names its window ----
  //
  // The owner's ask: the panel row showed the FIVE-HOUR count, which is not the
  // number anyone means by "how many tokens have I used". It now shows the
  // week's. The five-hour figure is not deleted — it moves into the tooltip,
  // labelled — and the burn rate beside it is still a five-hour rate, so it
  // says so on the visible line. Two numbers describing two different windows
  // with only one of them labelled is the misreading this whole change exists
  // to remove.
  const readRowTokens = (id) => `(() => {
    const row = ${q(id)};
    const meta = row.querySelector('.row__meta');
    const spans = meta ? [...meta.querySelectorAll(':scope > span')] : [];
    return {
      meta: meta ? meta.textContent : null,
      spans: spans.map((s) => ({
        text: s.textContent,
        title: s.getAttribute('title'),
        clipped: s.scrollWidth > s.clientWidth + 0.5,
      })),
      lines: meta ? Math.round(meta.getBoundingClientRect().height / parseFloat(getComputedStyle(meta).lineHeight)) : 0,
    };
  })()`;
  const claudeTokens = await js(readRowTokens('claude'));
  say('row tokens (tr): ' + JSON.stringify(claudeTokens));
  check('[tr] the row prints the WEEKLY count, not the five-hour one',
    // The fixture's week is 5x its 5h window, so the two are never confusable.
    // Digits + a tolerant unit: tr renders 6.18M as "6,2 Mn" and en as "6.2M",
    // and hand-writing either is how a live check turns into a brittle one.
    /6[.,]2\s*M/.test(claudeTokens.meta || '') && !/1[.,]2\s*M/.test(claudeTokens.meta || ''),
    claudeTokens.meta);
  check('[tr] the count names its own window, and the fixture week is an anchored quota week',
    /Kota haftası: /.test(claudeTokens.meta || ''), claudeTokens.meta);
  check('[tr] the burn rate names the five-hour window it is actually measured over',
    /5 saat: .*token\/sa/.test(claudeTokens.meta || ''), claudeTokens.meta);
  check('[tr] the five-hour breakdown is kept, in the tooltip, with both windows labelled',
    claudeTokens.spans.some((s) => s.title
      && /Haftalık pencere/.test(s.title) && /5 saatlik pencere/.test(s.title)
      && /Önbellek okuma/.test(s.title)),
    claudeTokens.spans.map((s) => s.title));
  // The labels are the claim, so the line WRAPS before anything is cut
  // (ADR-004 A2.3). Two lines is acceptable; an ellipsized label is not.
  check('[tr] nothing on the meta line is ellipsized away, and it takes at most two lines',
    claudeTokens.spans.every((s) => s.clipped === false) && claudeTokens.lines <= 2,
    [claudeTokens.lines, claudeTokens.spans.map((s) => [s.text, s.clipped])]);

  // A MEASURED ZERO WEEK. The defect this pins: an all-zero breakdown is our own
  // successful reading of a week with no usage, and reading it as "absent" made
  // the row say "could not be counted" about a week we had counted. It prints
  // the measurement, and it takes NO "en az" — a lower bound of zero qualifies
  // nothing.
  const ZERO_TK = '{ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, billable: 0 }';
  await js(`window.__probe.setPendingDirect([], { codex: { weeklyTokens: ${ZERO_TK}, weeklyTokenFloorCauses: ['unrecorded-writes'], weeklyCost: null } })`);
  await sleep(220);
  const zeroWeek = await js(readRowTokens('codex'));
  say('row tokens, measured zero week (tr): ' + JSON.stringify(zeroWeek));
  check('[tr] a counted zero week prints the measurement, not "sayılamadı"',
    /0 token/.test(zeroWeek.meta || '') && !/sayılamadı/.test(zeroWeek.meta || ''), zeroWeek.meta);
  check('[tr] and it never prints "en az 0", whatever causes main sent',
    !/en az 0/.test(zeroWeek.meta || ''), zeroWeek.meta);
  check('[tr] the cause is still shown, because the count still understates',
    /kaydedilmemiş/.test(zeroWeek.meta || ''), zeroWeek.meta);
  check('[tr] "Token bilgisi yok" is unreachable while we have the data',
    !/Token bilgisi yok/.test(zeroWeek.meta || ''), zeroWeek.meta);

  // The ONE state that reads "could not be counted": a zero count on a week the
  // reader KNOWS it could not read (ADR-002 A3.19) — recognised by
  // sourceIncomplete, never by the zero alone.
  await js(`window.__probe.setPendingDirect([], { codex: { weeklyTokens: ${ZERO_TK}, weeklyTokenFloorCauses: [] } })`);
  await js(`window.__probe.setCostDirect('codex', 'incompleteNoFigure')`);
  await sleep(250);
  const uncounted = await js(readRowTokens('codex'));
  say('row tokens, unread week (tr): ' + JSON.stringify(uncounted));
  check('[tr] an unread week reads "sayılamadı", never "en az 0 token"',
    /Haftalık: sayılamadı/.test(uncounted.meta || '')
      && !/en az 0/.test(uncounted.meta || '') && !/0 token/.test(uncounted.meta || ''),
    uncounted.meta);

  // A floor COUNT is marked from the CAUSES alone, and the cause is visible with
  // it — a bare "en az" is what ADR-002 A3.16 forbids.
  await js(`window.__probe.restore()`);
  await js(`window.__probe.setPendingDirect([], { codex: { weeklyTokenFloorCauses: ['unrecorded-writes'] } })`);
  await sleep(220);
  const floored = await js(readRowTokens('codex'));
  say('row tokens, floor count (tr): ' + JSON.stringify(floored));
  check('[tr] a weekly count main marks as a lower bound prints "en az"',
    /en az .*token/.test(floored.meta || ''), floored.meta);
  check('[tr] and never bare: the reason is on the line with it (A3.16)',
    /kaydedilmemiş önbellek yazmaları/.test(floored.meta || ''), floored.meta);

  // No causes, no marker — an exact count is not hedged.
  await js(`window.__probe.setPendingDirect([], { codex: { weeklyTokenFloorCauses: [] } })`);
  await sleep(220);
  const exact = await js(readRowTokens('codex'));
  check('[tr] a count with no causes is printed exactly, with no "en az" and no parenthetical',
    !/en az/.test(exact.meta || '') && !/\(/.test(exact.meta || '') && /token/.test(exact.meta || ''),
    exact.meta);
  await js(`window.__probe.setPendingDirect([])`);
  await js(`window.__probe.restore()`);
  await sleep(250);

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
  // As OPENED: the root holds focus because app.ts focused it (app.ts:698).
  // Measured before anything below touches modality, so this stays a statement
  // about the open path.
  const opened = await js(`(() => {
    const root = document.querySelector('.panel');
    return { open: root.getAttribute('data-open'), focused: document.activeElement === root };
  })()`);
  say('root on open: ' + JSON.stringify(opened));
  check('the panel opened and took focus, as app.ts does on every open',
    opened.open === 'true' && opened.focused === true, opened);

  // DETERMINISM, and why this is not a relaxation.
  //
  // `:focus-visible` is MODALITY-dependent: the same programmatic `.focus()`
  // matches or does not match depending on what Chromium last saw as input. This
  // check used to rely on the suite having driven no pointer input yet, which
  // made its outcome depend on how much unrelated script had run before it —
  // every probe call here goes through `executeJavaScript(code, true)`, i.e.
  // flagged as a user gesture. It passed, then failed on a later run with no
  // change to any outline or focus rule, which is the signature of an
  // order-dependent check rather than a regression.
  //
  // So the modality is now ESTABLISHED rather than assumed: a real Tab keypress
  // puts Chromium in keyboard modality, and the programmatic focus that follows
  // is then keyboard-origin — exactly the condition a real tray-click open
  // produces, where the click lands outside the document and Chromium sees no
  // pointer interaction in it. The assertion itself is unchanged and still
  // strict: if `:focus-visible` does NOT match after this, the outline check
  // below is vacuous and both must fail.
  win.focus();
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
  await sleep(150);

  const ring = await js(`(() => {
    const root = document.querySelector('.panel');
    root.focus();
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
  say('root ring, keyboard modality: ' + JSON.stringify(ring));
  check('the condition that painted the white frame is reproduced here',
    ring.focused === true && ring.visibleMatch === true, ring);
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
  // focused in the SAME state — the keyboard modality established above — must
  // still show the ring, or keyboard users lose sight of where they are. This is
  // the half that makes the white-frame fix a scoping decision rather than a
  // blanket `outline: none`, so it may never be softened.
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
  await js(`document.querySelector('.panel').focus()`);
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
  // Since the one-row cache-write design there are FOUR classes, and input
  // ($0,02 of $226,81, <0.5%) is below renderBar's sub-pixel floor, so the bar
  // draws three segments: cache read, cache write, output.
  check('the breakdown is visible without expanding',
    claude.captionHidden === false && claude.segs.length === 3, [claude.caption, claude.segs]);
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

  // ---- ADR-002 A3.15: a stale LIMIT reading is not an incomplete log read ----
  //
  // Supersedes code-reviewer F2. The row status says the rate-limit capture is
  // old; it says nothing about whether the token logs were read. Owner's
  // screenshot 2026-09-17: "veriler güncel değil" under a figure whose logs had
  // all been read. The gemini row is stale with sourceIncomplete: false.
  const staleRow = framing.gemini;
  const staleCost = await js(`(() => {
    const row = ${q('gemini')};
    const c = row.querySelector('.cost');
    return {
      rowStatus: row.getAttribute('data-status'),
      causeBlockHidden: c.querySelector('.cost__cause-block').hidden,
      causes: [...c.querySelectorAll('.cost__cause')].map((li) => li.textContent),
      caveats: [...c.querySelectorAll('.cost__caveat')].map((p) => p.textContent),
    };
  })()`);
  say('stale row cost: ' + JSON.stringify(staleCost));
  check('control: the gemini row really is stale, so the check below is not vacuous',
    staleCost.rowStatus === 'stale', staleCost.rowStatus);
  check('a stale row with sourceIncomplete false prints NO floor from its status',
    !/en az/.test(staleRow.summary), staleRow.summary);
  check('and no cause line, no "why" disclosure and no degraded sentence at all',
    staleCost.causeBlockHidden === true && staleCost.causes.length === 0
      && !staleCost.caveats.some((t) => /okunamadı/.test(t)), staleCost);

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
        unpriced: [...c.querySelectorAll('[data-cause="unpriced"] .cost__cause:not(.cost__cause--more)')].map(li => li.textContent.replace(/^(Fiyatlanamadı|Could not be priced): /, '')),
        causeBlockHidden: c.querySelector('.cost__cause-block').hidden,
        causes: [...c.querySelectorAll('.cost__cause')].map(li => li.textContent),
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

  // ---- the two windows on ONE row must not contradict each other ----------
  //
  // The row's token line names its window from `weeklyTokensWindowAnchored`
  // and the cost block names the same window from `weeklyCost.windowAnchored`.
  // Main derives both from one window object, so they always agree — but they
  // are two fields read by two components, and a row that says "kota haftası"
  // above "Son 7 gün" is a self-contradiction the user sees before we do. This
  // is also the check the old fixture could not make: it gave the Gemini row an
  // anchored cost, a state main cannot produce for a tool that publishes no
  // weekly reset, so the contradiction was baked into the fixture itself.
  const windowAgreement = await js(`(() => {
    const out = {};
    for (const id of ['claude', 'codex', 'gemini']) {
      const row = document.querySelector('li.row[data-provider="' + id + '"]');
      if (!row) continue;
      const meta = row.querySelector('.row__meta');
      const prov = row.querySelector('.cost .cost__prov span');
      out[id] = { meta: meta ? meta.textContent : null, prov: prov ? prov.textContent : null };
    }
    return out;
  })()`);
  say('window agreement: ' + JSON.stringify(windowAgreement));
  for (const [id, seen] of Object.entries(windowAgreement)) {
    if (!seen.prov || !seen.meta) continue;
    const costQuota = /kota haftası/i.test(seen.prov);
    const rowQuota = /Kota haftası:/.test(seen.meta);
    const rowTrailing = /Son 7 gün:/.test(seen.meta);
    // Only assert when the row actually states a window (a "sayılamadı" or
    // five-hour line states none, and claims nothing to contradict).
    if (!rowQuota && !rowTrailing) continue;
    check(`[${id}] the token line and the cost block name the SAME weekly window`,
      costQuota === rowQuota, [seen.meta, seen.prov]);
  }
  check('the price list date is shown, as a calendar date',
    detail.claude.prov[1] === 'Fiyatlar 24 Haziran 2026 tarihli listeye göre', detail.claude.prov[1]);
  check('no caveats means no cause list and no "why" disclosure',
    detail.claude.causeBlockHidden === true && detail.claude.caveats.length === 0, detail.claude);

  // ---- the two caveats are separate statements -------------------------
  check('the compact causes name the unpriced entry and the TTL fallback, one line each',
    detail.codex.causes.length === 2
      && /^Fiyatlanamadı: claude-opus-4-8 · hızlı · /.test(detail.codex.causes[0])
      && detail.codex.causes[1] === 'Süresi kaydedilmemiş önbellek yazması: 1.412 kayıt',
    detail.codex.causes);
  check('both causes get their own short explanation', detail.codex.caveats.length === 2,
    detail.codex.caveats);
  check('the unpriced explanation says the usage was EXCLUDED from the total',
    detail.codex.caveats[0] === 'Fiyat listesinde olmadığı için toplama katılmadı.', detail.codex.caveats[0]);
  check('the TTL explanation says how the writes were counted, with both rates',
    detail.codex.caveats[1] === 'Yazma süresi kaydedilmemiş; düşük olan 1,25× fiyattan sayıldı (1 saatlik yazma 2×).',
    detail.codex.caveats[1]);
  check('counts stay on the cause line, never repeated in the explanation (ADR-004 A3.2)',
    /1\.412/.test(detail.codex.causes[1]) && !detail.codex.caveats.some((t) => /\d{3}/.test(t)),
    [detail.codex.causes, detail.codex.caveats]);
  check('the two explanations are not merged into one sentence',
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
        unpriced: [...c.querySelectorAll('[data-cause="unpriced"] .cost__cause:not(.cost__cause--more)')].map(li => li.textContent.replace(/^(Fiyatlanamadı|Could not be priced): /, '')),
        causes: [...c.querySelectorAll('.cost__cause')].map(li => li.textContent),
        why: c.querySelector('.cost__whytext').textContent,
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
  check('the all-unpriced explanation says why, and states no lower bound (there is no amount)',
    noPrice.anti.caveats.length === 1
      && noPrice.anti.caveats[0] === 'Fiyat listesinde olmadığı için toplama katılmadı.'
      && !/alt sınır/.test(noPrice.anti.caveats.join(' ')), noPrice.anti.caveats);
  check('the models and their token counts are named, so the usage is visible',
    noPrice.anti.unpriced.length === 2
      && noPrice.anti.unpriced.every(u => /claude-opus-6/.test(u) && /token/.test(u))
      && noPrice.anti.unpriced.some(u => /standart/.test(u))
      && noPrice.anti.unpriced.some(u => /hızlı/.test(u)),
    noPrice.anti.unpriced);
  check('the row is flagged as unpriced for styling', noPrice.anti.flag === 'true');
  check('an all-unpriced week still has visible causes, and its disclosure does not say "en az"',
    noPrice.anti.causes.length === 2 && noPrice.anti.causes.every(u => /^Fiyatlanamadı: claude-opus-6/.test(u))
      && noPrice.anti.why === 'Neden tutar yok?', noPrice.anti);
  check('a stale row with sourceIncomplete false does not claim records could not be read',
    !noPrice.gem.caveats.some(t => /okunamadı/.test(t)), noPrice.gem.caveats);

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
      causeBlockHidden: c.querySelector('.cost__cause-block').hidden,
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
  check('no cause list when nothing took the fallback (and an older main without sourceIncomplete adds none)',
    partial.causeBlockHidden === true, partial);

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

  // ---- Codex tier-aware pricing (ADR-002 Amendment 3) ---------------------
  //
  // The codex row is swapped to a Codex-shaped week for this section only:
  // 38 records with cached reads and 0 RECORDED writes on a model that bills
  // writes (a floor with its own caveat, never the TTL one), and unpriced rows
  // under every group label src/core/codex/pricing.js emits. A producer code
  // ("unknown-tier", "…-long-context", "flex") must never reach the screen.
  const readCodexCost = `(async () => {
    const c = ${q('codex')}.querySelector('.cost');
    const t = c.querySelector('.cost__toggle');
    if (t.getAttribute('aria-expanded') !== 'true') t.click();
    // The full sentences live behind "why" (ADR-002 A3.16). Open it, or the
    // clip measurements below read 0 > 0 on undrawn nodes and pass vacuously.
    const w = c.querySelector('.cost__why');
    if (w && !w.closest('[hidden]') && w.getAttribute('aria-expanded') !== 'true') w.click();
    await new Promise((r) => setTimeout(r, 80));
    const clip = (n) => n.scrollWidth > n.clientWidth;
    const unrec = c.querySelector('.cost__caveat[data-caveat="unrecorded-writes"]');
    return {
      lang: document.documentElement.getAttribute('lang'),
      summary: c.querySelector('.cost__summary').textContent,
      caveats: [...c.querySelectorAll('.cost__caveat')].map((p) => p.textContent),
      unrecorded: unrec ? unrec.textContent : null,
      unrecordedClipped: unrec ? clip(unrec) : null,
      unrecordedTov: unrec ? getComputedStyle(unrec).textOverflow : null,
      unpriced: [...c.querySelectorAll('[data-cause="unpriced"] .cost__cause:not(.cost__cause--more)')].map((li) => li.textContent.replace(/^(Fiyatlanamadı|Could not be priced): /, '')),
      unpricedClipped: [...c.querySelectorAll('[data-cause="unpriced"] .cost__cause:not(.cost__cause--more)')].map(clip),
      unpricedTov: [...c.querySelectorAll('[data-cause="unpriced"] .cost__cause:not(.cost__cause--more)')].map((li) => getComputedStyle(li).textOverflow),
      causes: [...c.querySelectorAll('.cost__cause')].map((li) => li.textContent),
      unrecordedDrawn: unrec ? unrec.getClientRects().length > 0 : null,
    };
  })()`;
  const RAW_CODES = /unknown-tier|long-context|\bflex\b/;
  check('the fixture swapped a Codex-shaped week onto the codex row',
    (await js(`window.__probe.setCostDirect('codex', 'codexTier')`)) === true);
  await sleep(250);
  const codexTr = await js(readCodexCost);
  say('codex tier (tr): ' + JSON.stringify(codexTr));
  check('unrecorded cache writes make the Codex figure a floor: "en az"',
    /^Yayımlanan API fiyatlarıyla en az \$/.test(codexTr.summary), codexTr.summary);
  check('and the unrecorded-writes explanation says why, short',
    codexTr.unrecorded === 'Codex bu yazmaları kaydetmedi; bu modelde ücretli oldukları hâlde toplamda yoklar.',
    codexTr.unrecorded);
  check('the Claude TTL caveat is NOT shown for Codex: no 5m/1h split was missing',
    !codexTr.caveats.some((p) => /TTL/.test(p)), codexTr.caveats);
  check('an unknown-tier unpriced entry shows the Turkish label, not the code',
    codexTr.unpriced.some((u) => /^gpt-5\.6-sol · katman belirlenemedi · /.test(u)), codexTr.unpriced);
  check('a long-context exclusion names both the tier and the reason',
    codexTr.unpriced.some((u) => /^gpt-5\.5 · katman belirlenemedi, uzun bağlam \(272K üstü\) · /.test(u)),
    codexTr.unpriced);
  check('a tier with no published row degrades to a neutral label, even a well-formed one',
    codexTr.unpriced.some((u) => /^gpt-5\.6-terra · tanınmayan fiyat katmanı · /.test(u)), codexTr.unpriced);
  check('no raw producer code is printed anywhere in the unpriced list',
    codexTr.unpriced.length === 4 && !codexTr.unpriced.some((u) => RAW_CODES.test(u)), codexTr.unpriced);
  check('an unresolved model is named as unresolved, never as a model called "unknown"',
    codexTr.unpriced.some((u) => /^model belirlenemedi · katman belirlenemedi · /.test(u))
      && !codexTr.unpriced.some((u) => /^unknown\b/.test(u)), codexTr.unpriced);
  check('the full sentences were actually drawn when measured (why is open)',
    codexTr.unrecordedDrawn === true, codexTr.unrecordedDrawn);
  check('open, all four unpriced entries are named (no more than eight), then the unrecorded-writes line',
    codexTr.causes.length === 5
      && /^Fiyatlanamadı: gpt-5\.6-sol · katman belirlenemedi · /.test(codexTr.causes[0])
      && /^Fiyatlanamadı: gpt-5\.5 · /.test(codexTr.causes[1])
      && !codexTr.causes.some((t) => /kalem daha/.test(t))
      && codexTr.causes[4] === 'Kaydedilmemiş önbellek yazması: 38 kayıt',
    codexTr.causes);
  check('the unpriced lines wrap, they are never cut',
    codexTr.unpricedClipped.every((c) => c === false) && codexTr.unpricedTov.every((v) => v !== 'ellipsis'),
    [codexTr.unpricedClipped, codexTr.unpricedTov]);

  // English: reached the way main does it, persisted then pushed.
  await js('window.__probe.setDeferPrefs(true)');
  await js(`window.usageNotch.setLanguage('en')`);
  await js('window.__probe.flushPrefs()');
  await js('window.__probe.setDeferPrefs(false)');
  await sleep(300);
  const codexEn = await js(readCodexCost);
  say('codex tier (en): ' + JSON.stringify(codexEn));
  check('[en] the unrecorded-writes explanation is the short English line',
    codexEn.lang === 'en'
      && codexEn.unrecorded === "Codex didn't record these writes; the model charges for them, but they aren't in the total.",
    codexEn.unrecorded);
  check('[en] the caveat wraps and is not clipped',
    codexEn.unrecordedClipped === false && codexEn.unrecordedTov !== 'ellipsis', codexEn);
  check('[en] tier labels are English and no raw code is printed',
    codexEn.unpriced.some((u) => /· tier not determinable, long context \(over 272K\) ·/.test(u))
      && codexEn.unpriced.some((u) => /^model not determinable · tier not determinable · /.test(u))
      && !codexEn.unpriced.some((u) => RAW_CODES.test(u) || /^unknown\b/.test(u)), codexEn.unpriced);
  check('[en] the causes are English and plural-aware',
    codexEn.causes.length === 5 && /^Could not be priced: gpt-5\.6-sol · tier not determinable · /.test(codexEn.causes[0])
      && codexEn.causes[4] === 'Unrecorded cache writes: 38 records', codexEn.causes);
  check('[en] the unpriced lines are not clipped either',
    codexEn.unpricedClipped.every((c) => c === false), codexEn.unpricedClipped);

  // Put the suite back: Turkish, and the codex row's own Claude-shaped caveats.
  await js(`window.usageNotch.setLanguage('tr')`);
  await sleep(300);

  // qa F3: unrecorded writes as the ONLY floor cause. Nothing unpriced, no TTL
  // fallback, not degraded — so if isFloor ignored unrecordedWriteEvents, this
  // summary would print a bare "$226,81" and the check fails.
  check('the fixture swapped the unrecorded-writes-only week onto the codex row',
    (await js(`window.__probe.setCostDirect('codex', 'codexUnrecordedOnly')`)) === true);
  await sleep(250);
  const onlyUnrec = await js(readCodexCost);
  say('codex unrecorded-only (tr): ' + JSON.stringify(onlyUnrec));
  check('with no other floor cause, unrecorded cache writes alone make the figure "en az"',
    /^Yayımlanan API fiyatlarıyla en az \$/.test(onlyUnrec.summary)
      && onlyUnrec.unpriced.length === 0
      && onlyUnrec.caveats.length === 1, onlyUnrec);
  check('and exactly one cause line says so, with its count',
    onlyUnrec.causes.length === 1 && onlyUnrec.causes[0] === 'Kaydedilmemiş önbellek yazması: 1 kayıt',
    onlyUnrec.causes);
  check('and the one explanation is the unrecorded-writes line; the count is only on the cause',
    onlyUnrec.unrecorded === 'Codex bu yazmaları kaydetmedi; bu modelde ücretli oldukları hâlde toplamda yoklar.',
    onlyUnrec.unrecorded);

  // ---- ADR-002 A3.15/A3.16: sourceIncomplete, the compact causes, "why" ----
  //
  // One reader for every state below. It measures what is DRAWN: the "why"
  // panel is read collapsed first (aria wiring), then opened for the clip
  // measurements, so a hidden node's 0 > 0 cannot pass a clip check.
  const readCauses = `(async () => {
    const c = ${q('codex')}.querySelector('.cost');
    const block = c.querySelector('.cost__cause-block');
    const why = c.querySelector('.cost__why');
    const panelId = why.getAttribute('aria-controls');
    const panel = panelId ? document.getElementById(panelId) : null;
    const listId = why.getAttribute('aria-describedby');
    const list = listId ? document.getElementById(listId) : null;
    if (why.getAttribute('aria-expanded') === 'true') why.click();
    await new Promise((r) => setTimeout(r, 60));
    // The carets rotate with a 120ms transition. Finish any running one before
    // reading, or the reading depends on how far a transition got.
    const settled = (n) => { for (const x of n.getAnimations()) x.finish(); return getComputedStyle(n).transform; };
    const mainChev = () => settled(c.querySelector('.cost__toggle .cost__chev'));
    const closed = {
      mainChev: mainChev(),
      mainExpanded: c.querySelector('.cost__toggle').getAttribute('aria-expanded'),
      whyChev: settled(why.querySelector('.cost__chev')),
      expanded: why.getAttribute('aria-expanded'),
      explanationsHidden: [...c.querySelectorAll('.cost__caveat')].every((n) => n.hidden && n.getClientRects().length === 0),
      leadDrawn: [...c.querySelectorAll('.cost__why-lead')].some((n) => n.getClientRects().length > 0),
    };
    why.click();
    await new Promise((r) => setTimeout(r, 80));
    const clip = (n) => n.scrollWidth > n.clientWidth + 0.5;
    const causeNodes = [...c.querySelectorAll('.cost__cause')];
    const caveatNodes = [...c.querySelectorAll('.cost__caveat')];
    const out = {
      lang: document.documentElement.getAttribute('lang'),
      summary: c.querySelector('.cost__summary').textContent,
      blockHidden: block.hidden,
      causes: causeNodes.map((n) => n.textContent),
      causesDrawn: causeNodes.every((n) => n.getClientRects().length > 0),
      causesClipped: causeNodes.map(clip),
      causesTov: causeNodes.map((n) => getComputedStyle(n).textOverflow),
      whyText: why.textContent,
      whyTag: why.tagName,
      whyType: why.getAttribute('type'),
      whyName: why.getAttribute('aria-label'),
      whyTabbable: why.tabIndex >= 0 && !why.disabled,
      panelIsControlled: !!panel && panel.contains(caveatNodes[0] || null) && !panel.hidden,
      // Each explanation sits inside its own cause's list item, after its line.
      explanationsTied: caveatNodes.every((n) => {
        const g = n.closest('.cost__group');
        const line = g ? g.querySelector('.cost__cause') : null;
        return !!line && g.getAttribute('data-cause') === n.getAttribute('data-caveat')
          && (line.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      }),
      leads: [...c.querySelectorAll('.cost__why-lead')].filter((n) => !n.hidden && n.getClientRects().length > 0).map((n) => n.textContent),
      leadFirst: (() => {
        const l = c.querySelector('.cost__why-lead');
        const first = c.querySelector('.cost__cause');
        return !!(l && first) && (l.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      })(),
      columnWidth: Math.round(c.querySelector('.cost__causes').getBoundingClientRect().width),
      // Rendered line count of each explanation at the ADR-004 A3 reference
      // column: the cause list is pinned to 264px for the measurement (the test
      // window draws it at its own width), then released.
      explanationLines: (() => {
        const list = c.querySelector('.cost__causes');
        const keep = list.style.width;
        list.style.width = '264px';
        const out = caveatNodes.map((n) => {
          const lh = parseFloat(getComputedStyle(n).lineHeight);
          return Math.round(n.getBoundingClientRect().height / lh);
        });
        list.style.width = keep;
        return out;
      })(),
      describedByList: !!list && list.tagName === 'UL' && list.contains(causeNodes[0] || null),
      closed,
      open: {
        expanded: why.getAttribute('aria-expanded'),
        panelDrawn: caveatNodes.length > 0 && caveatNodes.every((n) => !n.hidden && n.getClientRects().length > 0),
      },
      caveats: caveatNodes.map((n) => n.textContent),
      caveatsClipped: caveatNodes.map(clip),
      caveatsTov: caveatNodes.map((n) => getComputedStyle(n).textOverflow),
      sourceSentence: (c.querySelector('.cost__caveat[data-caveat="source-incomplete"]') || {}).textContent || null,
      unpricedClipped: [...c.querySelectorAll('[data-cause="unpriced"] .cost__cause:not(.cost__cause--more)')].map(clip),
      leadClipped: [...c.querySelectorAll('.cost__why-lead')].map(clip),
      // The main toggle's caret must not move when only "why" opens.
      mainChevMoved: mainChev() !== closed.mainChev,
      // Calm, measurement-first: no warning accent on the caveat panel.
      panelBorder: caveatNodes[0] ? getComputedStyle(caveatNodes[0]).borderLeftColor : null,
      watch: (() => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--watch)';
        c.appendChild(probe);
        const v = getComputedStyle(probe).color;
        probe.remove();
        return v;
      })(),
    };
    why.click();
    await new Promise((r) => setTimeout(r, 40));
    return out;
  })()`;

  // sourceIncomplete as the ONLY cause: LIVE_COST's clean week plus the flag.
  check('the fixture swapped the source-incomplete week onto the codex row',
    (await js(`window.__probe.setCostDirect('codex', 'sourceIncomplete')`)) === true);
  await sleep(250);
  const incomplete = await js(readCauses);
  say('source incomplete (tr): ' + JSON.stringify(incomplete));
  check('sourceIncomplete alone makes the figure "en az"',
    /^Yayımlanan API fiyatlarıyla en az \$226,81 tutardı$/.test(incomplete.summary), incomplete.summary);
  check('and the floor has its visible cause line',
    incomplete.blockHidden === false && incomplete.causesDrawn === true
      && incomplete.causes.length === 1 && incomplete.causes[0] === 'Okunamayan kayıtlar var',
    incomplete.causes);
  check('the explanation and the lead are one click away, and only there',
    incomplete.closed.explanationsHidden === true && incomplete.closed.leadDrawn === false
      && incomplete.open.panelDrawn === true
      && incomplete.sourceSentence === 'Bazı yerel kayıtlar okunamadı; tutar yalnızca okunanları kapsıyor.'
      && incomplete.caveats.length === 1,
    [incomplete.closed, incomplete.open, incomplete.caveats]);
  check('open, the shared lead appears exactly once, before the causes',
    incomplete.leads.length === 1
      && incomplete.leads[0] === 'Bu yüzden tutar bir alt sınır; gerçek maliyet daha yüksek olabilir.'
      && incomplete.leadFirst === true, [incomplete.leads, incomplete.leadFirst]);
  check('each explanation is tied to its own cause line, directly after it',
    incomplete.explanationsTied === true, incomplete.explanationsTied);
  check('"why" is a real, tabbable button whose name is its visible text',
    incomplete.whyTag === 'BUTTON' && incomplete.whyType === 'button' && incomplete.whyTabbable === true
      && incomplete.whyText === 'Neden en az?' && incomplete.whyName === null, incomplete);
  check('aria-expanded follows the state, and aria-controls points at the region holding the explanations',
    incomplete.closed.expanded === 'false' && incomplete.open.expanded === 'true'
      && incomplete.panelIsControlled === true, incomplete);
  check('aria-describedby points at the visible cause list, so the spoken causes match the screen',
    incomplete.describedByList === true, incomplete);
  check('the two carets are independent: "why" does not move the breakdown caret, nor vice versa',
    incomplete.mainChevMoved === false
      && incomplete.closed.mainExpanded === 'true' && incomplete.closed.whyChev === 'none',
    [incomplete.mainChevMoved, incomplete.closed]);
  check('the explanations carry no warning accent',
    !!incomplete.panelBorder && !!incomplete.watch && incomplete.panelBorder !== incomplete.watch,
    [incomplete.panelBorder, incomplete.watch]);

  // The owner's week: one unpriced tier and 202 unrecorded writes, logs read.
  check('the fixture swapped the owner\'s week onto the codex row',
    (await js(`window.__probe.setCostDirect('codex', 'owner')`)) === true);
  await sleep(250);
  const owner = await js(readCauses);
  say('owner week (tr): ' + JSON.stringify(owner));
  check('the owner\'s week: two short cause lines instead of three paragraphs',
    owner.causes.length === 2
      && /^Fiyatlanamadı: gpt-5\.6-sol · katman belirlenemedi · 169,8\sB token$/.test(owner.causes[0])
      && owner.causes[1] === 'Kaydedilmemiş önbellek yazması: 202 kayıt', owner.causes);
  check('and no "could not be read" sentence: its logs were read',
    !owner.caveats.some((t) => /okunamadı/.test(t)) && owner.sourceSentence === null, owner.caveats);

  // F5: records missed and nothing priced. Shown, with no amount and no
  // "not in the price list" claim: the cause line and its "why" alone.
  check('the fixture swapped the incomplete, unpriced-nothing week onto the codex row',
    (await js(`window.__probe.setCostDirect('codex', 'incompleteNoFigure')`)) === true);
  await sleep(250);
  const noFig = await js(readCauses);
  const noFigShape = await js(`(() => {
    const c = ${q('codex')}.querySelector('.cost');
    return {
      hidden: c.hidden,
      toggleHidden: c.querySelector('.cost__toggle').hidden,
      barHidden: c.querySelector('.cost__bar').hidden,
      captionHidden: c.querySelector('.cost__caption').hidden,
      detailHidden: c.querySelector('.cost__detail').hidden,
      text: c.innerText,
    };
  })()`);
  say('incomplete, no figure (tr): ' + JSON.stringify([noFig, noFigShape]));
  check('a week with unreadable records and no priced figure is SHOWN, not hidden',
    noFigShape.hidden === false && noFig.blockHidden === false, noFigShape);
  check('it shows the cause line alone: no amount, no toggle, no breakdown, no price-list claim',
    noFig.causes.length === 1 && noFig.causes[0] === 'Okunamayan kayıtlar var'
      && noFigShape.toggleHidden === true && noFigShape.barHidden === true
      && noFigShape.captionHidden === true && noFigShape.detailHidden === true
      && !/\$|en az|fiyat listesinde/.test(noFigShape.text), [noFig.causes, noFigShape]);
  check('and its "why" carries the reworded sentence, with working aria wiring',
    noFig.whyText === 'Neden tutar yok?' && noFig.closed.expanded === 'false' && noFig.open.expanded === 'true'
      && noFig.open.panelDrawn === true && noFig.panelIsControlled === true
      && noFig.caveatsClipped.every((v) => v === false),
    noFig);
  check('with no amount there is no lower-bound lead at all',
    noFig.leads.length === 0, noFig.leads);
  check('with no amount, the sentence says no amount can be given, never "the amount is a lower bound"',
    noFig.sourceSentence === 'Bu araca ait bazı yerel kayıtlar okunamadı, bu yüzden bir tutar verilemiyor.'
      && !/alt sınır|Tutar/.test(noFig.sourceSentence || ''), noFig.sourceSentence);

  // ADR-002 A3.17/A3.18/A3.21: the two tier floors, each its own line and sentence.
  check('the fixture swapped the tier-floor week onto the codex row',
    (await js(`window.__probe.setCostDirect('codex', 'tierFloor')`)) === true);
  await sleep(250);
  const tierTr = await js(readCauses);
  const tierSentences = await js(`(() => {
    const c = ${q('codex')}.querySelector('.cost');
    const pick = (k) => (c.querySelector('.cost__caveat[data-caveat="' + k + '"]') || {}).textContent || null;
    return { assumed: pick('assumed-tier'), fast: pick('fast-requested') };
  })()`);
  say('tier floor (tr): ' + JSON.stringify([tierTr, tierSentences]));
  check('the tier floors alone make the figure "en az"',
    /^Yayımlanan API fiyatlarıyla en az \$/.test(tierTr.summary), tierTr.summary);
  check('each tier floor has its own cause line, with its count',
    tierTr.causes.length === 2
      && tierTr.causes[0] === 'Katmanı kaydedilmemiş istek (Standart fiyattan): 24 kayıt'
      && tierTr.causes[1] === 'Fast istendi (Standart fiyattan): 1 kayıt', tierTr.causes);
  check('and its own short explanation: counted at Standard; Fast possibly higher',
    tierSentences.assumed === 'Katman kaydı yoktu; en ucuz katman olan Standart’tan sayıldı.'
      && tierSentences.fast === 'Fast’in uygulandığı kayıtlı değil; Standart’tan sayıldı. Uygulandıysa gerçek tutar daha yüksek.',
    tierSentences);
  check('[tr] the tier lines and sentences are not clipped',
    tierTr.causesClipped.every((v) => v === false) && tierTr.caveatsClipped.every((v) => v === false)
      && tierTr.open.panelDrawn === true, tierTr);
  await js(`window.__probe.setLocaleDirect('en', 'en-US')`);
  await sleep(300);
  const tierEn = await js(readCauses);
  say('tier floor (en): ' + JSON.stringify(tierEn));
  check('[en] the tier lines are English and plural-aware',
    tierEn.causes[0] === 'Requests with no recorded tier (priced at Standard): 24 records'
      && tierEn.causes[1] === 'Fast requested (priced at Standard): 1 record', tierEn.causes);
  check('[en] the tier explanations keep their claims, whole',
    tierEn.caveats[0] === 'No tier was recorded; counted at Standard, the cheapest tier.'
      && tierEn.caveats[1] === "Fast isn't recorded as applied; counted at Standard. If it was, the real cost is higher."
      && tierEn.leads[0] === 'So the amount is a lower bound; the real cost may be higher.'
      && tierEn.caveatsClipped.every((v) => v === false), [tierEn.caveats, tierEn.leads]);
  await js(`window.__probe.setLocaleDirect('tr', 'tr-TR')`);
  await sleep(300);

  // Review F9: more than eight unpriced entries. Named up to eight, then counted.
  check('the fixture swapped the ten-unpriced week onto the codex row',
    (await js(`window.__probe.setCostDirect('codex', 'manyUnpriced')`)) === true);
  await sleep(250);
  const many = await js(readCauses);
  // readCauses closes "why" again on its way out: this is the collapsed list.
  const manyClosed = await js(`(() => [...${q('codex')}.querySelectorAll('.cost__cause')].map((n) => n.textContent))()`);
  say('many unpriced (tr): ' + JSON.stringify([many.causes, manyClosed]));
  check('open, "why" names eight unpriced entries and counts the other two',
    many.causes.length === 9 && many.causes.slice(0, 8).every((u) => /^Fiyatlanamadı: gpt-5\.\d-probe · katman belirlenemedi · /.test(u))
      && many.causes[8] === 'Fiyatlanamadı: 2 kalem daha' && many.caveats.length === 1, many);
  check('and collapsed, the list shows two lines plus a counted line',
    manyClosed.length === 3 && manyClosed[2] === 'Fiyatlanamadı: 8 kalem daha', manyClosed);

  // Every cause at once, in all three formats: nothing is cut.
  check('the fixture swapped the every-cause week onto the codex row',
    (await js(`window.__probe.setCostDirect('codex', 'allCauses')`)) === true);
  await sleep(250);
  const clipCheck = (label, r) => {
    check(`[${label}] all six kinds of cause render, in order, one explanation each`,
      r.causes.length === 9 && r.caveats.length === 6, [r.causes, r.caveats.length]);
    check(`[${label}] the lead appears exactly once and is not clipped`,
      r.leads.length === 1 && r.leadClipped.every((v) => v === false), [r.leads, r.leadClipped]);
    check(`[${label}] every explanation is at most 2 lines at 264px (drawn column ${r.columnWidth}px)`,
      r.explanationLines.length === 6 && r.explanationLines.every((n) => n >= 1 && n <= 2),
      [r.columnWidth, r.explanationLines, r.caveats]);
    check(`[${label}] every explanation sits under its own cause`, r.explanationsTied === true, r.explanationsTied);
    check(`[${label}] no cause line is clipped or ellipsized`,
      r.causesDrawn === true && r.causesClipped.every((v) => v === false)
        && r.causesTov.every((v) => v !== 'ellipsis'), [r.causesClipped, r.causesTov]);
    check(`[${label}] no full sentence is clipped or ellipsized`,
      r.open.panelDrawn === true && r.caveatsClipped.every((v) => v === false)
        && r.caveatsTov.every((v) => v !== 'ellipsis') && r.unpricedClipped.every((v) => v === false),
      [r.caveatsClipped, r.caveatsTov, r.unpricedClipped]);
  };
  const allTr = await js(readCauses);
  say('all causes (tr): ' + JSON.stringify(allTr));
  clipCheck('tr', allTr);
  check('[tr] the TTL, unrecorded-writes, tier and unreadable lines are the short labels',
    allTr.causes[4] === 'Süresi kaydedilmemiş önbellek yazması: 1.412 kayıt'
      && allTr.causes[5] === 'Kaydedilmemiş önbellek yazması: 38 kayıt'
      && allTr.causes[6] === 'Katmanı kaydedilmemiş istek (Standart fiyattan): 30 kayıt'
      && allTr.causes[7] === 'Fast istendi (Standart fiyattan): 23 kayıt'
      && allTr.causes[8] === 'Okunamayan kayıtlar var', allTr.causes);

  await js(`window.__probe.setLocaleDirect('en', 'en-US')`);
  await sleep(300);
  const allUs = await js(readCauses);
  say('all causes (en-US): ' + JSON.stringify(allUs));
  check('[en-US] reached', allUs.lang === 'en', allUs.lang);
  clipCheck('en-US', allUs);
  check('[en-US] the short labels are English, with en-US digits',
    allUs.causes[4] === 'Cache writes without a recorded TTL: 1,412 records'
      && allUs.causes[5] === 'Unrecorded cache writes: 38 records'
      && allUs.causes[8] === 'Some records could not be read'
      && allUs.whyText === 'Why at least?', allUs);

  await js(`window.__probe.setLocaleDirect('en', 'en-GB')`);
  await sleep(300);
  const allGb = await js(readCauses);
  say('all causes (en-GB): ' + JSON.stringify(allGb));
  clipCheck('en-GB', allGb);
  check('[en-GB] the figure keeps its floor in the en-GB currency form',
    /^Would have cost at least US\$/.test(allGb.summary), allGb.summary);

  // ADR-004 A3, the owner's case: three causes, one lead, three short lines.
  await js(`window.__probe.setLocaleDirect('tr', 'tr-TR')`);
  await js(`window.__probe.setCostDirect('codex', 'ownerTiers')`);
  await sleep(300);
  const ownerTiers = await js(readCauses);
  say('owner tiers (tr): ' + JSON.stringify(ownerTiers));
  check('the owner\'s case opens to one lead and three short explanations, no paragraphs',
    ownerTiers.leads.length === 1 && ownerTiers.causes.length === 3 && ownerTiers.caveats.length === 3
      && ownerTiers.causes[0] === 'Kaydedilmemiş önbellek yazması: 235 kayıt'
      && ownerTiers.causes[1] === 'Katmanı kaydedilmemiş istek (Standart fiyattan): 30 kayıt'
      && ownerTiers.causes[2] === 'Fast istendi (Standart fiyattan): 23 kayıt'
      && ownerTiers.explanationLines.every((n) => n <= 2) && ownerTiers.explanationsTied === true,
    ownerTiers);

  await js(`window.__probe.setLocaleDirect('tr', 'tr-TR')`);
  await sleep(300);
  await js(`window.__probe.setCostDirect('codex', 'caveat')`);
  await sleep(250);

  // ---- ADR-003 A6: Gemini CLI and Kimi Code rows --------------------------
  const RAW_CODES_A6 = /no-model|no-published-price|other-model-alias|unknown-tier|unrecordedCalls|longPrompt|toolToken/;
  const readLocalRow = (id) => `(async () => {
    const row = ${q(id)};
    const c = row.querySelector('.cost');
    const pill = row.querySelector('.row__line .tag-experimental');
    const t = c.querySelector('.cost__toggle');
    if (!t.hidden && t.getAttribute('aria-expanded') !== 'true') t.click();
    const w = c.querySelector('.cost__why');
    if (w.getAttribute('aria-expanded') !== 'true') w.click();
    await new Promise((r) => setTimeout(r, 80));
    const list = c.querySelector('.cost__causes');
    const keep = list.style.width;
    list.style.width = '264px';
    const caveatNodes = [...c.querySelectorAll('.cost__caveat')];
    const lines = caveatNodes.map((n) => Math.round(n.getBoundingClientRect().height / parseFloat(getComputedStyle(n).lineHeight)));
    list.style.width = keep;
    const out = {
      lang: document.documentElement.getAttribute('lang'),
      pill: pill ? { text: pill.firstChild.textContent, title: pill.getAttribute('title'),
                     spoken: (pill.querySelector('.u-sr') || {}).textContent || null,
                     color: getComputedStyle(pill).color, border: getComputedStyle(pill).borderTopColor } : null,
      meta: (row.querySelector('.row__meta') || {}).textContent || '',
      summary: c.querySelector('.cost__summary').textContent,
      summaryLines: (() => { const s = c.querySelector('.cost__summary'); return Math.round(s.getBoundingClientRect().height / parseFloat(getComputedStyle(s).lineHeight)); })(),
      summaryClipped: (() => { const s = c.querySelector('.cost__summary'); return s.scrollWidth > s.clientWidth + 0.5; })(),
      aria: t.getAttribute('aria-label'),
      toggleHidden: t.hidden,
      causes: [...c.querySelectorAll('.cost__cause')].map((n) => n.textContent),
      caveats: caveatNodes.map((n) => [n.getAttribute('data-caveat'), n.textContent]),
      caveatLines: lines,
      caveatsClipped: caveatNodes.map((n) => n.scrollWidth > n.clientWidth + 0.5),
      prov: [...c.querySelectorAll('.cost__prov span')].map((s) => s.textContent),
      text: c.textContent + ' ' + row.querySelector('.row__line').textContent,
      watch: (() => { const s = document.createElement('span'); s.style.color = 'var(--watch)'; c.appendChild(s); const v = getComputedStyle(s).color; s.remove(); return v; })(),
    };
    w.click();
    return out;
  })()`;
  await js(`window.__probe.setPendingDirect([], {
    gemini: { status: 'ok', connected: true, lastGoodAt: null,
      tokens: { input: 904000, output: 120800, cacheWrite: 0, cacheRead: 400000, billable: 1024800 } },
    kimi: { status: 'ok', connected: true, setupAction: null,
      tokens: { input: 320000, output: 45000, cacheWrite: 0, cacheRead: 120000, billable: 365000 } },
  })`);
  await js(`window.__probe.setCostDirect('gemini', 'gemini')`);
  await js(`window.__probe.setCostDirect('kimi', 'kimi')`);
  await sleep(300);
  const gemTr = await js(readLocalRow('gemini'));
  say('gemini row (tr): ' + JSON.stringify(gemTr));
  check('[tr] Gemini carries the calm "deneysel" pill with its explanation on hover and for a screen reader',
    !!gemTr.pill && gemTr.pill.text === 'deneysel'
      && gemTr.pill.title === 'Bu aracın kayıt biçimi gerçek bir kurulumda henüz doğrulanmadı.'
      && /Bu aracın kayıt biçimi gerçek bir kurulumda henüz doğrulanmadı\./.test(gemTr.pill.spoken || '')
      && gemTr.pill.color !== gemTr.watch && gemTr.pill.border !== gemTr.watch, gemTr.pill);
  check('[tr] Gemini shows its tokens like Codex does',
    /token/.test(gemTr.meta) && !/Token bilgisi yok/.test(gemTr.meta), gemTr.meta);
  check('[tr] the Gemini figure is always "en az", with unrecorded calls, long prompts and tool tokens as causes',
    gemTr.summary === 'Gemini API standart fiyatlarıyla en az $12,34 tutardı'
      && gemTr.causes.includes('Kaydedilmeyen çağrılar')
      && gemTr.causes.includes('Uzun istem (200K üstü): 3 kayıt')
      && gemTr.causes.includes('Araç tokenları: 7 kayıt'), [gemTr.summary, gemTr.causes]);
  check('[tr] Gemini names its price source in the summary, the spoken name and the provenance line',
    /Gemini API standart fiyatlarıyla en az \$?12,34 ABD doları tutardı/.test(gemTr.aria || '')
      && gemTr.prov.includes('Gemini API standart fiyatları, 10 Eylül 2026 tarihli listeye göre')
      && gemTr.summaryLines <= 2 && gemTr.summaryClipped === false, [gemTr.aria, gemTr.prov, gemTr.summaryLines]);
  check('[tr] each Gemini cause has its short "why" line',
    gemTr.caveats.some(([k, v]) => k === 'unrecorded-calls' && v === 'Gemini CLI bazı yardımcı çağrıları ve başarısız denemeleri kaydetmez; toplamda yoklar.')
      && gemTr.caveats.some(([k, v]) => k === 'long-prompt' && v === 'Uzun istemler daha yüksek ücretlendirilir; burada düşük fiyattan sayıldı.')
      && gemTr.caveats.some(([k, v]) => k === 'tool-tokens' && v === 'Araç kullanım tokenlarının fiyatı yayımlanmıyor; toplama katılmadı.'),
    gemTr.caveats);
  check('[tr] tokens with no model get their own explanation, not "not in the price list"',
    gemTr.caveats.some(([k, v]) => k === 'unpriced' && v === 'Model kaydı olmadığı için fiyatlanamadı.')
      && !gemTr.caveats.some(([, v]) => v === 'Fiyat listesinde olmadığı için toplama katılmadı.'), gemTr.caveats);
  check('[tr] tokens with no model are labelled, never "no-model"',
    gemTr.causes.some((c) => /^Fiyatlanamadı: model belirlenemedi · model kaydı yok · /.test(c))
      && !RAW_CODES_A6.test(gemTr.text), gemTr.causes);

  const kimiTr = await js(readLocalRow('kimi'));
  say('kimi row (tr): ' + JSON.stringify(kimiTr));
  check('[tr] Kimi carries the pill and shows its tokens',
    !!kimiTr.pill && kimiTr.pill.text === 'deneysel' && /token/.test(kimiTr.meta), [kimiTr.pill, kimiTr.meta]);
  check('[tr] Kimi\'s usage is all unpriced: no amount anywhere, never $0',
    !/\$/.test(kimiTr.text) && !/0,00/.test(kimiTr.text) && !/en az/.test(kimiTr.summary)
      && kimiTr.summary === 'Kimi token başına fiyat yayımlamıyor; tutar yok.'
      && !/fiyat listesinde/.test(kimiTr.summary + ' ' + (kimiTr.aria || ''))
      && kimiTr.aria === 'Kimi: token başına fiyat yayımlamıyor, bu yüzden tutar yok. Kullanılan modelleri görmek için etkinleştirin.',
    [kimiTr.summary, kimiTr.aria]);
  check('[tr] each Kimi model says why it is unpriced, by label',
    kimiTr.causes.some((c) => /^Fiyatlanamadı: kimi-code\/kimi-for-coding · fiyat yayımlanmıyor · /.test(c))
      && kimiTr.causes.some((c) => /^Fiyatlanamadı: openrouter\/claude-sonnet · Kimi Code üzerinden başka model · /.test(c))
      && !RAW_CODES_A6.test(kimiTr.text), kimiTr.causes);
  check('[tr] each Kimi reason has its own explanation, directly under its line',
    JSON.stringify(kimiTr.caveats) === JSON.stringify([
      ['unpriced', 'Bu araç token başına fiyat yayımlamıyor.'],
      ['unpriced', 'Kimi Code üzerinden kullanılan başka bir model; fiyatı bilinmiyor.'],
    ]) && kimiTr.caveatLines.every((n) => n >= 1 && n <= 2), [kimiTr.caveats, kimiTr.caveatLines]);
  check('[tr] the provenance says Kimi publishes no prices, not that a list date is missing',
    kimiTr.prov.includes('Kimi fiyat yayımlamıyor') && !kimiTr.prov.some((p) => /tarihi bildirilmedi/.test(p)), kimiTr.prov);

  for (const [lang, locale] of [['tr', 'tr-TR'], ['en', 'en-US'], ['en', 'en-GB']]) {
    await js(`window.__probe.setLocaleDirect('${lang}', '${locale}')`);
    await sleep(300);
    const g = await js(readLocalRow('gemini'));
    const k = await js(readLocalRow('kimi'));
    say(`gemini/kimi why lines (${locale}): ` + JSON.stringify([g.caveatLines, k.caveatLines, g.caveats]));
    check(`[${locale}] Gemini and Kimi "why" lines are at most 2 lines at 264px and never clipped`,
      g.caveatLines.length >= 4 && [...g.caveatLines, ...k.caveatLines].every((n) => n >= 1 && n <= 2)
        && [...g.caveatsClipped, ...k.caveatsClipped].every((v) => v === false),
      [g.caveatLines, k.caveatLines]);
    check(`[${locale}] no raw code on either row`,
      !RAW_CODES_A6.test(g.text) && !RAW_CODES_A6.test(k.text), [g.causes, k.causes]);
    if (lang === 'en') {
      check(`[${locale}] the English pill, causes and Kimi provenance`,
        g.pill && g.pill.text === 'experimental'
          && g.pill.title === "This tool's log format has not yet been verified on a real install."
          && g.causes.includes('Unrecorded calls') && g.causes.includes('Long prompts (over 200K): 3 records')
          && g.causes.includes('Tool tokens: 7 records')
          && k.causes.some((c) => /· no published price ·/.test(c)) && k.causes.some((c) => /· other model via Kimi Code ·/.test(c))
          && k.prov.includes('Kimi does not publish prices')
          && k.summary === 'Kimi does not publish per-token prices, so there is no amount.'
          && /^Would have cost at least (US)?\$12\.34 at Gemini API standard rates$/.test(g.summary)
          && g.prov.some((p) => /^Gemini API standard rates, from the list dated /.test(p))
          && g.summaryLines <= 2 && g.summaryClipped === false
          && g.caveats.some(([, v]) => v === 'No model was recorded, so it could not be priced.')
          && k.caveats.some(([, v]) => v === 'This tool does not publish a per-token price.')
          && k.caveats.some(([, v]) => v === 'Another model used through Kimi Code; its price is unknown.'),
        [g.pill, g.causes, k.causes, k.prov, g.caveats, k.caveats]);
    }
  }
  await js(`window.__probe.setLocaleDirect('tr', 'tr-TR')`);
  await sleep(300);

  // Settings → Model Yönetimi carries the same pill for Gemini and Kimi only.
  const settingsPills = await js(`(async () => {
    const view = document.getElementById('settings-view');
    document.querySelector('.iconbtn--settings').click();
    await new Promise((r) => setTimeout(r, 150));
    const out = [...view.querySelectorAll('.settings__item')].map((li) => ({
      id: li.getAttribute('data-provider'),
      pill: (li.querySelector('.tag-experimental') || { firstChild: null }).firstChild ? li.querySelector('.tag-experimental').firstChild.textContent : null,
      title: li.querySelector('.tag-experimental') ? li.querySelector('.tag-experimental').getAttribute('title') : null,
      clipped: li.querySelector('.tag-experimental') ? li.querySelector('.tag-experimental').scrollWidth > li.querySelector('.tag-experimental').clientWidth + 0.5 : null,
    }));
    document.querySelector('.iconbtn--settings').click();
    await new Promise((r) => setTimeout(r, 120));
    return out;
  })()`);
  say('settings pills: ' + JSON.stringify(settingsPills));
  check('Settings → Model Yönetimi shows "deneysel" on Gemini and Kimi, and on no other tool',
    settingsPills.length >= 6
      && settingsPills.every((s) => (s.id === 'gemini' || s.id === 'kimi')
        ? s.pill === 'deneysel' && /doğrulanmadı/.test(s.title || '') && s.clipped === false
        : s.pill === null), settingsPills);
  check('the Claude row has no pill',
    (await js(`${q('claude')}.querySelector('.tag-experimental') === null`)) === true);
  await js(`window.__probe.restore()`);
  await sleep(300);

  // ---- ADR-003 A8 (Phase B): the optional API key --------------------------
  //
  // Copilot is the only key-capable provider. Everything here is about STATE
  // and numbers: the checks below also prove what is NOT rendered — no key, no
  // length, no mask (K23), and no percentage, bar or ring for a figure whose
  // reply carries no allowance (A6.3).
  const KEY_FIXTURE = 'github_pat_TESTONLYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const readKeyRow = (id) => `(() => {
    const row = ${q(id)};
    const block = row.querySelector('.key');
    const clip = (n) => n.scrollWidth > n.clientWidth + 0.5;
    const linesOf = (n) => Math.round(n.getBoundingClientRect().height / parseFloat(getComputedStyle(n).lineHeight));
    const vis = (sel) => { const n = block ? block.querySelector(sel) : null; return n && !n.hidden ? n : null; };
    const add = vis('.key__add');
    const token = vis('.key__token');
    const figure = vis('.key__figure');
    const split = vis('.key__split');
    const asof = vis('.key__asof');
    const state = vis('.key__state');
    const shown = [figure, split, asof, state].filter(Boolean);
    return {
      present: !!block && !block.hidden,
      stateAttr: block ? block.getAttribute('data-key-state') : null,
      add: add ? { text: add.textContent, tag: add.tagName, title: add.getAttribute('title'),
                   aria: add.getAttribute('aria-label'), tabbable: add.tabIndex >= 0 && !add.disabled } : null,
      token: token ? { text: token.textContent, tag: token.tagName, tabbable: token.tabIndex >= 0 } : null,
      figure: figure ? figure.textContent : null,
      split: split ? split.textContent : null,
      asof: asof ? asof.textContent : null,
      state: state ? state.textContent : null,
      lines: shown.map(linesOf),
      clipped: shown.map(clip),
      // Anything that could read as a gauge: a percent sign, a rail, a fill, a
      // progress role, or an element whose width is driven by a --w variable.
      percent: /%/.test(block ? block.textContent : ''),
      gauge: block
        ? [...block.querySelectorAll('*')].filter((n) =>
            /bar|rail|fill|ring|gauge|progress/i.test(n.className || '')
            || n.getAttribute('role') === 'progressbar' || n.getAttribute('role') === 'meter'
            || n.style.getPropertyValue('--w') !== '').length
        : -1,
      text: row.textContent,
    };
  })()`;

  // 1. no key stored: one calm offer, nothing else.
  const keyNone = await js(readKeyRow('copilot'));
  say('key none (tr): ' + JSON.stringify(keyNone));
  check('[tr] a key-capable provider with no key offers to add one, calmly and optionally',
    keyNone.present === true && keyNone.stateAttr === 'none'
      && keyNone.add && keyNone.add.tag === 'BUTTON' && keyNone.add.tabbable === true
      && keyNone.add.text === 'Daha fazla ayrıntı için API anahtarı ekle'
      && /İsteğe bağlı/.test(keyNone.add.title || '')
      && /isteğe bağlı API anahtarı ekle/.test(keyNone.add.aria || ''), keyNone.add);
  check('[tr] with no key there is no figure, no state sentence and no token-page action',
    keyNone.figure === null && keyNone.split === null && keyNone.state === null
      && keyNone.token === null, keyNone);
  check('a provider that cannot use a key has no key block at all',
    (await js(`(() => { const b = ${q('claude')}.querySelector('.key'); return b === null || b.hidden; })()`)) === true);

  check('pressing the offer asks main to open the entry window, with the provider id only',
    (await js(`(async () => {
      ${q('copilot')}.querySelector('.key__add').click();
      await new Promise((r) => setTimeout(r, 80));
      return JSON.stringify(window.__probe.keyCalls());
    })()`)) === JSON.stringify({ requestKeyEntry: ['copilot'], removeKey: [], openTokenPage: [] }));

  // 2. a key stored, with a reading: three counts and a time. No gauge.
  const CREDITS = `{ keyState: 'stored', keyStoredAt: '2026-09-20T09:15:00.000Z', creditUsage: {
    grossCredits: 1234, includedCredits: 900, billedCredits: 334,
    periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-09-30T23:59:59.000Z',
    fetchedAt: new Date(Date.now() - 12 * 60000).toISOString() } }`;
  await js(`window.__probe.setKeyDirect('copilot', ${CREDITS})`);
  await sleep(250);
  const keyFigure = await js(readKeyRow('copilot'));
  say('key figure (tr): ' + JSON.stringify(keyFigure));
  check('[tr] a stored key with a reading shows the credits used, the included part and the billed part',
    keyFigure.figure === 'Bu ay 1.234 AI kredisi kullanıldı'
      && keyFigure.split === 'Plan kapsamında 900 · faturalanan 334', [keyFigure.figure, keyFigure.split]);
  check('[tr] and the instant the reading was true, with no state sentence beside it',
    /itibarıyla/.test(keyFigure.asof || '') && keyFigure.state === null && keyFigure.add === null,
    [keyFigure.asof, keyFigure.state]);
  check('[tr] NO percentage and NO bar, ring or progress element anywhere in the block',
    keyFigure.percent === false && keyFigure.gauge === 0, [keyFigure.percent, keyFigure.gauge]);
  check('[tr] the key figure lines are at most 2 lines and never clipped',
    keyFigure.lines.every((n) => n >= 1 && n <= 2) && keyFigure.clipped.every((v) => v === false),
    [keyFigure.lines, keyFigure.clipped]);

  // 3. every other state: one short fixed sentence, and the token page only
  //    where a new key is the fix.
  const STATES = [
    ['stored', 'Anahtar kayıtlı; kredi sayıları henüz okunmadı.', false],
    ['key-rejected', 'Anahtar kabul edilmedi. Ayarlar’dan kaldırıp yenisini ekleyebilirsiniz.', true],
    ['key-lacks-permission', 'Anahtarda Plan: read yetkisi yok.', true],
    ['rate-limited', 'GitHub şu an istek sınırı uyguluyor; sayılar sonra okunacak.', false],
    ['not-available', 'Kendi ödediğiniz bir Copilot planına ait kullanım bulunamadı.', false],
    ['unreachable', 'api.github.com adresine ulaşılamadı. Usage Notch sistem vekil sunucusu kullanmaz.', false],
    ['unreadable', 'Kayıtlı anahtar okunamadı. Kaldırıp yeniden ekleyebilirsiniz.', false],
    ['secure-storage-unavailable', 'Windows şifreli depolama kullanılamıyor; anahtar okunamadı.', false],
  ];
  for (const [state, expected, offersToken] of STATES) {
    await js(`window.__probe.setKeyDirect('copilot', { keyState: ${JSON.stringify(state)}, creditUsage: null })`);
    await sleep(160);
    const seen = await js(readKeyRow('copilot'));
    check(`[tr] ${state}: its own short sentence, with no figure and no percentage`,
      seen.state === expected && seen.figure === null && seen.percent === false
        && seen.lines.every((n) => n <= 2) && seen.clipped.every((v) => v === false),
      [seen.state, seen.lines]);
    check(`[tr] ${state}: the token-page action is ${offersToken ? 'offered' : 'not offered'}`,
      (seen.token !== null) === offersToken
        && (!offersToken || (seen.token.tag === 'BUTTON' && seen.token.tabbable === true
          && seen.token.text === 'GitHub’da anahtar oluştur')),
      seen.token);
  }

  // A reading main KEPT through an error state (ADR-001 stale-but-true, Phase B
  // ruling): shown, dimmed, with its age AND the error sentence — never as a
  // current figure.
  await js(`window.__probe.setKeyDirect('copilot', { keyState: 'unreachable', keyStoredAt: '2026-09-20T09:15:00.000Z', creditUsage: {
    grossCredits: 1234, includedCredits: 900, billedCredits: 334,
    periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-09-30T23:59:59.000Z',
    fetchedAt: new Date(Date.now() - 3 * 3600000).toISOString() } })`);
  await sleep(220);
  const kept = await js(`(() => {
    const block = ${q('copilot')}.querySelector('.key');
    const figure = block.querySelector('.key__figure');
    const state = block.querySelector('.key__state');
    const asof = block.querySelector('.key__asof');
    return {
      stale: block.getAttribute('data-stale'),
      figure: figure && !figure.hidden ? figure.textContent : null,
      figureColour: getComputedStyle(figure).color,
      inkFigure: (() => { const s = document.createElement('span'); s.style.color = 'var(--ink-100)'; block.appendChild(s); const v = getComputedStyle(s).color; s.remove(); return v; })(),
      asof: asof && !asof.hidden ? asof.textContent : null,
      state: state && !state.hidden ? state.textContent : null,
      percent: /%/.test(block.textContent),
    };
  })()`);
  say('kept reading through an error (tr): ' + JSON.stringify(kept));
  check('[tr] a kept reading is still shown, with its age and the error sentence together',
    kept.figure === 'Bu ay 1.234 AI kredisi kullanıldı'
      && /itibarıyla/.test(kept.asof || '')
      && kept.state === 'api.github.com adresine ulaşılamadı. Usage Notch sistem vekil sunucusu kullanmaz.'
      && kept.percent === false, kept);
  check('[tr] and it is dimmed, so it cannot be read as the current figure',
    kept.stale === 'true' && kept.figureColour !== kept.inkFigure, [kept.stale, kept.figureColour, kept.inkFigure]);

  // 'unreadable' comes with keyStoredAt null (backend): no copy may depend on a
  // stored-at date, on the row or in Settings.
  await js(`window.__probe.setKeyDirect('copilot', { keyState: 'unreadable', keyStoredAt: null, creditUsage: null })`);
  await sleep(220);
  const unreadable = await js(`(async () => {
    const block = ${q('copilot')}.querySelector('.key');
    const rowState = (() => { const n = block.querySelector('.key__state'); return n && !n.hidden ? n.textContent : null; })();
    const view = document.getElementById('settings-view');
    document.querySelector('.iconbtn--settings').click();
    await new Promise((r) => setTimeout(r, 150));
    const item = view.querySelector('.settings__item[data-provider="copilot"]');
    const key = item.querySelector('.settings__key');
    const out = {
      rowState,
      rowFigure: (() => { const n = block.querySelector('.key__figure'); return n && !n.hidden ? n.textContent : null; })(),
      settingsHidden: key.hidden,
      storedHidden: key.querySelector('.settings__key-stored').hidden,
      settingsState: (() => { const n = key.querySelector('.settings__key-state'); return n && !n.hidden ? n.textContent : null; })(),
      settingsText: key.textContent,
      removeShown: !key.querySelector('.settings__key-remove').hidden,
    };
    document.querySelector('.iconbtn--settings').click();
    await new Promise((r) => setTimeout(r, 120));
    return out;
  })()`);
  say('unreadable, no stored-at (tr): ' + JSON.stringify(unreadable));
  check('[tr] an unreadable key says so without depending on a stored-at date',
    unreadable.rowState === 'Kayıtlı anahtar okunamadı. Kaldırıp yeniden ekleyebilirsiniz.'
      && unreadable.rowFigure === null
      && unreadable.settingsHidden === false && unreadable.storedHidden === true
      && unreadable.settingsState === unreadable.rowState
      && !/tarihinde|Invalid|NaN|undefined|null/.test(unreadable.settingsText)
      && unreadable.removeShown === true, unreadable);

  // 'unreachable' is the one state with a cause the user cannot clear, because
  // the cause is ours: the app never uses a system proxy. The row carries the
  // short true line; Settings carries the full cause, ABOVE the Remove button,
  // and it must not be dressed as a warning the user can act on.
  await js(`window.__probe.setKeyDirect('copilot', { keyState: 'unreachable', keyStoredAt: '2026-09-20T09:15:00.000Z', creditUsage: null })`);
  await sleep(220);
  const proxied = await js(`(async () => {
    const block = ${q('copilot')}.querySelector('.key');
    const rowSentence = block.querySelector('.key__state');
    const view = document.getElementById('settings-view');
    document.querySelector('.iconbtn--settings').click();
    await new Promise((r) => setTimeout(r, 150));
    const item = view.querySelector('.settings__item[data-provider="copilot"]');
    const key = item.querySelector('.settings__key');
    const cause = key.querySelector('.settings__key-cause');
    const style = getComputedStyle(cause);
    const stateStyle = getComputedStyle(key.querySelector('.settings__key-state'));
    const out = {
      rowState: rowSentence && !rowSentence.hidden ? rowSentence.textContent : null,
      rowTitle: rowSentence ? rowSentence.getAttribute('title') : null,
      rowToken: (() => { const n = block.querySelector('.key__token'); return n && !n.hidden; })(),
      causeShown: !!cause && !cause.hidden,
      causeText: cause ? cause.textContent : null,
      // Same ink as every other line in the block: a stated limit, not an alert.
      calm: !!cause && style.color === stateStyle.color
        && style.borderLeftWidth === '0px' && style.borderTopWidth === '0px',
      // The cause sits before the action it is meant to stop.
      beforeRemove: !!cause && (cause.compareDocumentPosition(key.querySelector('.settings__key-remove'))
        & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      causeWhole: !!cause && cause.scrollHeight <= cause.clientHeight + 0.5,
    };
    document.querySelector('.iconbtn--settings').click();
    await new Promise((r) => setTimeout(r, 120));
    return out;
  })()`);
  say('unreachable, proxied (tr): ' + JSON.stringify(proxied));
  // Claim-based here too, for the same reason as the cause line below: the ROW
  // line's job is ATTRIBUTION — the host, that it was not reached, and that WE
  // are named as the reason, because a proxied network reaches api.github.com
  // fine and an unattributed failure points at the user's network or at GitHub.
  check('[tr] unreachable names our own cause on the row and offers no key to re-create',
    /api\.github\.com/.test(proxied.rowState || '')
      && /ulaşılamadı/.test(proxied.rowState || '')
      && /Usage Notch/.test(proxied.rowState || '')
      && /vekil/i.test(proxied.rowState || '')
      && proxied.rowToken === false
      && /vekil/.test(proxied.rowTitle || ''), proxied);
  // The CLAIMS, not the phrasings. This check has now been broken twice by
  // wording that stayed true — first "sistem vekil sunucusunu kullanmaz", then
  // "hiç gelmez" for "gösterilemez" — so it asserts the four things the line has
  // to say and tolerates how it says them: who is responsible, that the figure
  // never arrives on such a network, that removing the key changes nothing, and
  // that the rest of the row is read locally.
  check('[tr] Settings carries the full cause, calmly, above the Remove button and not truncated',
    proxied.causeShown === true
      && /vekil sunucusu(nu)?[^.;]*kullanmaz/.test(proxied.causeText || '')
      && /(hiç gelmez|gösterilemez|ulaşılamaz)/.test(proxied.causeText || '')
      && /kaldırmak[^.;]*değiştirmez/.test(proxied.causeText || '')
      && /yerel dosyalardan okunur/.test(proxied.causeText || '')
      && proxied.calm === true && proxied.beforeRemove === true
      && proxied.causeWhole === true, proxied);

  await js(`window.__probe.setKeyDirect('copilot', { keyState: 'key-rejected', keyStoredAt: '2026-09-20T09:15:00.000Z', creditUsage: null })`);
  await sleep(200);
  check('the token-page action reaches main with the provider id only',
    (await js(`(async () => {
      ${q('copilot')}.querySelector('.key__token').click();
      await new Promise((r) => setTimeout(r, 80));
      return JSON.stringify(window.__probe.keyCalls().openTokenPage);
    })()`)) === JSON.stringify(['copilot']));

  // 4. nothing about the secret itself is rendered (K23). A main process that
  //    sends a key field anyway must not put it on screen: sanitize drops
  //    every field the contract does not declare, and this proves it.
  await js(`window.__probe.setKeyDirect('copilot', { keyState: 'stored', apiKey: ${JSON.stringify(KEY_FIXTURE)}, token: ${JSON.stringify(KEY_FIXTURE)} })`);
  await sleep(200);
  const leak = await js(`(() => {
    const needles = [];
    const secret = ${JSON.stringify(KEY_FIXTURE)};
    const page = document.body.innerText || '';
    const attrs = [...document.querySelectorAll('*')].flatMap((n) => [...n.attributes].map((a) => a.name + '=' + a.value)).join(String.fromCharCode(10));
    for (let i = 0; i + 4 <= secret.length; i += 1) {
      const piece = secret.slice(i, i + 4);
      if (!needles.includes(piece)) needles.push(piece);
    }
    const hay = page + String.fromCharCode(10) + attrs;
    return {
      needles: needles.length,
      leaked: needles.filter((n) => hay.includes(n)).slice(0, 5),
      // The snapshot the renderer holds must not carry the field either.
      onRow: Object.keys(window.__probe.providers ? {} : {}).length,
    };
  })()`);
  say('key leak probe: ' + JSON.stringify(leak));
  check('no 4-character piece of a key ever appears in the panel, even when main sends one',
    leak.needles > 20 && leak.leaked.length === 0, leak);
  check('and no rendered text names a key length or a mask',
    !/•|\u2022|\*{3,}|\bkarakter\b|\bcharacters\b/.test(await js(`${q('copilot')}.querySelector('.key').textContent`)));

  // 5. Settings: the state, the stored date, and removing the local copy.
  const readKeySettings = `(async () => {
    const view = document.getElementById('settings-view');
    document.querySelector('.iconbtn--settings').click();
    await new Promise((r) => setTimeout(r, 150));
    const item = view.querySelector('.settings__item[data-provider="copilot"]');
    const block = item.querySelector('.settings__key');
    const vis = (sel) => { const n = block.querySelector(sel); return n && !n.hidden ? n : null; };
    const out = {
      hidden: block.hidden,
      stored: (vis('.settings__key-stored') || {}).textContent || null,
      state: (vis('.settings__key-state') || {}).textContent || null,
      remove: (vis('.settings__key-remove') || {}).textContent || null,
      removeExpanded: block.querySelector('.settings__key-remove').getAttribute('aria-expanded'),
      token: (vis('.settings__key-token') || {}).textContent || null,
      confirmHidden: block.querySelector('.settings__key-confirm').hidden,
      claudeHasKeyBlock: (() => {
        const c = view.querySelector('.settings__item[data-provider="claude"] .settings__key');
        return !!c && !c.hidden;
      })(),
      text: block.textContent,
    };
    document.querySelector('.iconbtn--settings').click();
    await new Promise((r) => setTimeout(r, 120));
    return out;
  })()`;
  await js(`window.__probe.setKeyDirect('copilot', { keyState: 'stored', keyStoredAt: '2026-09-20T09:15:00.000Z', creditUsage: null })`);
  await sleep(200);
  const keySettings = await js(readKeySettings);
  say('key settings (tr): ' + JSON.stringify(keySettings));
  check('[tr] Settings shows the key state and the day it was stored, and a way to remove it',
    keySettings.hidden === false
      && keySettings.stored === 'Anahtar 20 Eyl 2026 tarihinde bu bilgisayara kaydedildi.'
      && keySettings.state === 'Anahtar kayıtlı; kredi sayıları henüz okunmadı.'
      && keySettings.remove === 'Anahtarı kaldır' && keySettings.confirmHidden === true
      && keySettings.removeExpanded === 'false', keySettings);
  check('[tr] Settings names no key, no length and no mask, and offers no token page with a working key',
    !/•|\*{3,}|karakter/.test(keySettings.text) && keySettings.token === null, keySettings.text);
  check('a provider that cannot use a key has no key section in Settings',
    keySettings.claudeHasKeyBlock === false, keySettings.claudeHasKeyBlock);

  const removeFlow = await js(`(async () => {
    const view = document.getElementById('settings-view');
    document.querySelector('.iconbtn--settings').click();
    await new Promise((r) => setTimeout(r, 150));
    const item = view.querySelector('.settings__item[data-provider="copilot"]');
    const remove = item.querySelector('.settings__key-remove');
    const confirm = item.querySelector('.settings__key-confirm');
    remove.click();
    await new Promise((r) => setTimeout(r, 60));
    const asked = {
      confirmShown: !confirm.hidden,
      expanded: remove.getAttribute('aria-expanded'),
      confirmText: confirm.querySelector('.settings__key-confirm-text').textContent,
      focusOnYes: document.activeElement === item.querySelector('.settings__key-confirm-yes'),
      callsBefore: window.__probe.keyCalls().removeKey.length,
    };
    // Backing out of the confirm must not remove anything.
    item.querySelector('.settings__key-confirm-no').click();
    await new Promise((r) => setTimeout(r, 60));
    asked.afterCancel = { hidden: confirm.hidden, calls: window.__probe.keyCalls().removeKey.length };
    remove.click();
    await new Promise((r) => setTimeout(r, 60));
    item.querySelector('.settings__key-confirm-yes').click();
    await new Promise((r) => setTimeout(r, 120));
    asked.afterYes = { hidden: confirm.hidden, calls: window.__probe.keyCalls().removeKey.slice() };
    document.querySelector('.iconbtn--settings').click();
    await new Promise((r) => setTimeout(r, 120));
    return asked;
  })()`);
  say('key remove flow: ' + JSON.stringify(removeFlow));
  check('[tr] removing asks first, and says the local copy is not a revocation',
    removeFlow.confirmShown === true && removeFlow.expanded === 'true'
      && /Yalnızca bu bilgisayardaki kopya silinir/.test(removeFlow.confirmText)
      && /GitHub’da iptal edilene kadar geçerli kalır/.test(removeFlow.confirmText)
      && removeFlow.focusOnYes === true && removeFlow.callsBefore === 0, removeFlow);
  check('backing out removes nothing; confirming removes the local copy once',
    removeFlow.afterCancel.hidden === true && removeFlow.afterCancel.calls === 0
      && removeFlow.afterYes.hidden === true
      && JSON.stringify(removeFlow.afterYes.calls) === JSON.stringify(['copilot']), removeFlow);

  // 6. The same states in English, in both English formats: nothing clipped.
  await js(`window.__probe.setKeyDirect('copilot', ${CREDITS})`);
  for (const locale of ['en-US', 'en-GB']) {
    await js(`window.__probe.setLocaleDirect('en', '${locale}')`);
    await sleep(300);
    const en = await js(readKeyRow('copilot'));
    say(`key figure (${locale}): ` + JSON.stringify(en));
    check(`[${locale}] the credit figure reads in English, with no percentage and no gauge`,
      /^1,234 AI credits used this month$/.test(en.figure || '')
        && en.split === '900 included · 334 billed'
        && en.percent === false && en.gauge === 0
        && en.lines.every((n) => n <= 2) && en.clipped.every((v) => v === false), en);
    await js(`window.__probe.setKeyDirect('copilot', { keyState: 'key-rejected', creditUsage: null })`);
    await sleep(200);
    const enState = await js(readKeyRow('copilot'));
    check(`[${locale}] a rejected key reads in English and offers the token page`,
      enState.state === 'The key was not accepted. You can remove it in Settings and add a new one.'
        && enState.token && enState.token.text === 'Create the key on GitHub'
        && enState.lines.every((n) => n <= 2) && enState.clipped.every((v) => v === false), enState);
    const enNone = await js(`(async () => {
      window.__probe.setKeyDirect('copilot', { keyState: 'none', creditUsage: null, keyStoredAt: null });
      await new Promise((r) => setTimeout(r, 200));
      const b = ${q('copilot')}.querySelector('.key');
      const add = b.querySelector('.key__add');
      return { add: add && !add.hidden ? add.textContent : null,
               token: (() => { const t = b.querySelector('.key__token'); return t && !t.hidden ? t.textContent : null; })() };
    })()`);
    check(`[${locale}] the offer reads in English, and no token page is offered with no key`,
      enNone.add === 'Add API key for more detail' && enNone.token === null, enNone);
    await js(`window.__probe.setKeyDirect('copilot', ${CREDITS})`);
    await sleep(160);
  }
  await js(`window.__probe.setLocaleDirect('tr', 'tr-TR')`);
  await js(`window.__probe.setKeyDirect('copilot', { keyState: 'none', keyStoredAt: null, creditUsage: null })`);
  await sleep(300);

  // ---- pending: a tool whose first usage scan has not answered -----------
  //
  // ADR-002 A3.12. Codex's scan runs in a worker, so its first snapshot carries
  // pendingUsage: ['codex'] with no tokens and no cost. Every surface must say
  // "still calculating" — not "Token bilgisi yok", not a hidden cost block
  // (which reads as no usage), not "—" for a period that may hold Codex usage.
  const readPending = `(async () => {
    const row = ${q('codex')};
    const cost = row.querySelector('.cost');
    const pendingLine = cost ? cost.querySelector('.cost__pending') : null;
    // Read BEFORE opening settings: the row list is display:none in that view,
    // and innerText of an undrawn subtree falls back to every text node.
    const costText = cost && !cost.hidden ? cost.innerText : '';
    const view = document.getElementById('settings-view');
    document.querySelector('.iconbtn--settings').click();
    await new Promise((r) => setTimeout(r, 120));
    view.querySelector('.acc__trigger[data-acc="usage"]').click();
    await new Promise((r) => setTimeout(r, 80));
    const note = view.querySelector('.usage__pending');
    const out = {
      meta: (row.querySelector('.row__meta') || {}).textContent || '',
      rowPending: !!row.querySelector('.row__meta .row__pending'),
      costHidden: cost ? cost.hidden : null,
      costPendingText: pendingLine && !pendingLine.hidden ? pendingLine.textContent : null,
      costToggleHidden: cost ? cost.querySelector('.cost__toggle').hidden : null,
      // innerText, not textContent: what is RENDERED (and so what a screen
      // reader reads). The hidden toggle may still hold the previous figure.
      costText,
      note: note && !note.hidden ? note.textContent : null,
      noteRole: note ? note.getAttribute('role') : null,
      amounts: [...view.querySelectorAll('.usage__row')].map((r) => ({
        text: r.querySelector('.usage__amount').textContent,
        pending: r.getAttribute('data-pending'),
      })),
      emptyText: (() => { const e = view.querySelector('.usage__empty'); return e && !e.hidden ? e.textContent : null; })(),
    };
    view.querySelector('.acc__trigger[data-acc="models"]').click();
    await new Promise((r) => setTimeout(r, 60));
    document.querySelector('.iconbtn--settings').click();
    await new Promise((r) => setTimeout(r, 120));
    return out;
  })()`;
  await js(`window.__probe.setPendingDirect(['codex'], { codex: { tokens: null, weeklyTokens: null, weeklyCost: null, burnRatePerHour: null } })`);
  await sleep(250);
  const pend = await js(readPending);
  say('pending (tr): ' + JSON.stringify(pend));
  check('a pending tool says its usage is being calculated, not that there is no token data',
    pend.rowPending === true && /Kullanım hesaplanıyor…/.test(pend.meta) && !/Token bilgisi yok/.test(pend.meta),
    pend.meta);
  check('a pending tool shows a cost line instead of hiding the block (hidden reads as "no usage")',
    pend.costHidden === false && pend.costPendingText === 'Maliyet hesaplanıyor — yerel kayıtlar okunuyor.',
    pend);
  check('and that line carries no figure and offers no disclosure: nothing is known yet',
    pend.costToggleHidden === true && !/\$/.test(pend.costText), pend);
  check('Toplam Kullanım names the tool still being counted, as a live status',
    pend.note === 'Codex kullanımı hâlâ hesaplanıyor; toplamlar henüz eksik.' && pend.noteRole === 'status',
    pend.note);
  check('an empty period is not shown as "—" while a tool is pending',
    pend.amounts.length > 0 && !pend.amounts.some((a) => a.text === '—')
      && pend.amounts.some((a) => a.text === 'hesaplanıyor…' && a.pending === 'true'), pend.amounts);

  // Main's first result lands: pendingUsage is [] and the row has its data.
  await js(`window.__probe.setPendingDirect([])`);
  await js(`window.__probe.restore()`);
  await sleep(300);
  const done = await js(readPending);
  say('pending cleared (tr): ' + JSON.stringify(done));
  check('after a push with pendingUsage [] every pending text is gone',
    done.rowPending === false && !/hesaplanıyor/.test(done.meta)
      && done.costPendingText === null && done.costToggleHidden === false
      && done.note === null && !done.amounts.some((a) => a.pending === 'true' || /hesaplanıyor/.test(a.text)),
    done);
  check('and the period that was pending reads as the empty period it is',
    done.amounts.some((a) => a.text === '—'), done.amounts);

  // A pending tool that already carries token figures (a partial read) must
  // still say "calculating": pending is checked FIRST, so no token count or
  // burn rate is presented as complete while the first scan is running.
  await js(`window.__probe.setPendingDirect(['codex'], { codex: { weeklyCost: null } })`);
  await sleep(250);
  const pendWithTokens = await js(`(() => {
    const row = ${q('codex')};
    return {
      meta: (row.querySelector('.row__meta') || {}).innerText || '',
      pending: !!row.querySelector('.row__meta .row__pending'),
    };
  })()`);
  say('pending with tokens (tr): ' + JSON.stringify(pendWithTokens));
  check('pending wins over tokens that are already present: no figure is shown as complete',
    pendWithTokens.pending === true && /^Kullanım hesaplanıyor…$/.test(pendWithTokens.meta.trim())
      && !/token/.test(pendWithTokens.meta), pendWithTokens);
  await js(`window.__probe.setPendingDirect([])`);
  await js(`window.__probe.restore()`);
  await sleep(250);

  // ---- ADR-003 A6 / ADR-004 A3: the price note, compact per tool -----------
  //
  // Always visible: an optional lead and one short source line per tool.
  // Behind "Neden en az?": one short cause line per tool. The reader opens the
  // disclosure itself, measures every line at the drawn settings width, then
  // closes it again, so each check sees both states.
  const readNote = `(async () => {
    const view = document.getElementById('settings-view');
    document.querySelector('.iconbtn--settings').click();
    await new Promise((r) => setTimeout(r, 120));
    view.querySelector('.acc__trigger[data-acc="usage"]').click();
    await new Promise((r) => setTimeout(r, 80));
    const n = view.querySelector('.usage__note');
    const lead = n.querySelector('.usage__note-lead');
    const why = n.querySelector('.usage__why');
    const block = n.querySelector('.usage__why-block');
    const listId = why ? why.getAttribute('aria-controls') : null;
    const list = listId ? document.getElementById(listId) : null;
    const clip = (e) => e.scrollWidth > e.clientWidth + 0.5;
    const linesOf = (e) => Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight));
    const sources = [...n.querySelectorAll('.usage__source')];
    const introSources = (view.querySelector('.usage__intro-sources') || {}).textContent || null;
    const closed = {
      expanded: why ? why.getAttribute('aria-expanded') : null,
      listHidden: list ? list.hidden : null,
      whyDrawn: list ? list.getClientRects().length > 0 : null,
    };
    if (why && !block.hidden) why.click();
    await new Promise((r) => setTimeout(r, 60));
    const whyLines = [...n.querySelectorAll('.usage__why-line')];
    const out = {
      text: n.textContent,
      introSources,
      lead: lead && !lead.hidden ? lead.textContent : null,
      leadCount: [...n.querySelectorAll('.usage__note-lead')].filter((e) => !e.hidden).length,
      sources: sources.map((e) => e.textContent),
      sourceLines: sources.map(linesOf),
      sourcesClipped: sources.map(clip),
      whyHidden: block ? block.hidden : null,
      whyText: why ? why.textContent : null,
      whyTag: why ? why.tagName : null,
      closed,
      open: {
        expanded: why ? why.getAttribute('aria-expanded') : null,
        listHidden: list ? list.hidden : null,
        controlsList: !!list && list.classList.contains('usage__why-list'),
      },
      why: whyLines.map((e) => e.textContent),
      whyLines: whyLines.map(linesOf),
      whyClipped: whyLines.map(clip),
      width: Math.round(n.getBoundingClientRect().width),
      watch: (() => { const s = document.createElement('span'); s.style.color = 'var(--watch)'; n.appendChild(s); const v = getComputedStyle(s).color; s.remove(); return v; })(),
      whyBorder: whyLines[0] ? getComputedStyle(whyLines[0]).borderLeftColor : null,
    };
    if (why && why.getAttribute('aria-expanded') === 'true') why.click();
    view.querySelector('.acc__trigger[data-acc="models"]').click();
    await new Promise((r) => setTimeout(r, 60));
    document.querySelector('.iconbtn--settings').click();
    await new Promise((r) => setTimeout(r, 120));
    return out;
  })()`;
  const RAW_CAUSE_CODES = /unrecorded-calls|long-prompt|tool-tokens|cache-write-ttl-fallback|unrecorded-writes|assumed-tier|fast-requested|no-model|no-published-price|other-model-alias/;
  const ALL_TOOLS = [
    `{ claude: '2026-08-01', codex: '2026-08-15', gemini: '2026-09-10' }`,
    `'2026-08-01'`,
    `['claude', 'codex', 'gemini', 'kimi']`,
    `{ claude: ['unpriced', 'cache-write-ttl-fallback'], codex: ['unrecorded-writes', 'assumed-tier', 'fast-requested'], gemini: ['unrecorded-calls', 'long-prompt', 'tool-tokens'], kimi: ['unpriced'], bogus: ['unpriced'] }`,
  ].join(', ');
  await js(`window.__probe.setHistoryPricesDirect(${ALL_TOOLS})`);
  await sleep(200);
  const noteAll = await js(readNote);
  say('compact note, four tools (tr): ' + JSON.stringify(noteAll));
  check('[tr] always visible: one lead and one short source line per tool, in order',
    // TWO leads: the cost gloss and the count gloss. They are different claims
    // about different quantities, and each appears only when a floor of that
    // kind is on screen — see the count-gloss checks below.
    noteAll.leadCount === 2
      && noteAll.lead === '“En az” alt sınır demektir; gerçek maliyet daha yüksek olabilir.'
      && JSON.stringify(noteAll.sources) === JSON.stringify([
        'Claude Code · 1 Ağu 2026 fiyatları',
        'Codex · 15 Ağu 2026 fiyatları',
        'Gemini · Gemini API standart, 10 Eyl 2026',
        'Kimi · fiyat yayımlamıyor',
      ]), [noteAll.lead, noteAll.sources]);
  check('[tr] each source is one line, never clipped',
    noteAll.sourceLines.every((n) => n === 1) && noteAll.sourcesClipped.every((v) => v === false),
    [noteAll.width, noteAll.sourceLines]);
  check('[tr] the causes sit behind "Neden en az?", a real button with working aria wiring',
    noteAll.whyTag === 'BUTTON' && noteAll.whyText === 'Neden en az?'
      && noteAll.closed.expanded === 'false' && noteAll.closed.listHidden === true && noteAll.closed.whyDrawn === false
      && noteAll.open.expanded === 'true' && noteAll.open.listHidden === false && noteAll.open.controlsList === true,
    [noteAll.closed, noteAll.open]);
  check('[tr] one short cause line per tool with causes, Kimi included',
    JSON.stringify(noteAll.why) === JSON.stringify([
      'Claude Code: fiyatlanamayan kullanım ve süresi kaydedilmemiş önbellek yazmaları (1,25× ile)',
      'Codex: kaydedilmemiş önbellek yazmaları, katmanı kaydedilmemiş istekler (Standart’tan) ve Fast istenen kayıtlar (Standart’tan)',
      'Gemini: kaydedilmeyen çağrılar, uzun istemler (200K üstü) ve araç tokenları',
      'Kimi: fiyat yayımlamıyor',
    ]), noteAll.why);
  check('[tr] F1: the source sentence names the tools in the history, and keeps "only local"',
    noteAll.introSources === 'Yalnızca bu bilgisayardaki Claude Code, Codex, Gemini ve Kimi kayıtlarından hesaplanır.',
    noteAll.introSources);
  check(`[tr] every cause line is at most 2 lines at the settings width (${noteAll.width}px), never clipped, no warning colour`,
    noteAll.whyLines.length === 4 && noteAll.whyLines.every((n) => n >= 1 && n <= 2)
      && noteAll.whyClipped.every((v) => v === false) && noteAll.whyBorder !== noteAll.watch,
    [noteAll.width, noteAll.whyLines]);
  check('[tr] no raw cause code and no unknown tool anywhere in the note',
    !RAW_CAUSE_CODES.test(noteAll.text) && !/bogus/.test(noteAll.text), noteAll.text);
  for (const locale of ['en-US', 'en-GB']) {
    await js(`window.__probe.setLocaleDirect('en', '${locale}')`);
    await sleep(300);
    const n = await js(readNote);
    say(`compact note, four tools (${locale}): ` + JSON.stringify(n));
    const gb = locale === 'en-GB';
    check(`[${locale}] the compact note reads in English, one line per source, why lines at most 2 lines, nothing clipped`,
      n.lead === '“At least” means a lower bound; the real cost may be higher.'
        && n.sources[0] === (gb ? 'Claude Code · 1 Aug 2026 prices' : 'Claude Code · Aug 1, 2026 prices')
        && n.sources[2] === (gb ? 'Gemini · Gemini API standard, 10 Sept 2026' : 'Gemini · Gemini API standard, Sep 10, 2026')
        && n.sources[3] === 'Kimi · does not publish prices'
        && n.why[2] === 'Gemini: unrecorded calls, long prompts (over 200K), and tool tokens'
        && n.whyText === 'Why at least?'
        && n.why[3] === 'Kimi: does not publish prices'
        && n.introSources === 'Calculated only from local Claude Code, Codex, Gemini, and Kimi logs.'
        && n.sourceLines.every((x) => x === 1) && n.sourcesClipped.every((v) => v === false)
        && n.whyLines.every((x) => x >= 1 && x <= 2) && n.whyClipped.every((v) => v === false)
        && !RAW_CAUSE_CODES.test(n.text),
      [n.sources, n.why, n.whyLines]);
  }
  await js(`window.__probe.setLocaleDirect('tr', 'tr-TR')`);
  await sleep(300);

  // Gemini only: its source and its one cause, nothing about Claude or Codex.
  await js(`window.__probe.setHistoryPricesDirect({ gemini: '2026-09-10' }, '2026-08-01', ['gemini'], { gemini: ['unrecorded-calls'] })`);
  await sleep(200);
  const noteGem = await js(readNote);
  say('compact note, gemini only (tr): ' + JSON.stringify(noteGem));
  check('[tr] a Gemini-only history: its source line, its one cause, nothing about Claude or Codex',
    noteGem.leadCount === 2 && JSON.stringify(noteGem.sources) === JSON.stringify(['Gemini · Gemini API standart, 10 Eyl 2026'])
      && JSON.stringify(noteGem.why) === JSON.stringify(['Gemini: kaydedilmeyen çağrılar'])
      && !/Claude|Codex/.test(noteGem.text), noteGem);

  // Kimi only: no cause, so no lead and no "why" at all.
  await js(`window.__probe.setHistoryPricesDirect({}, '2026-08-01', ['kimi'], { kimi: ['unpriced'] })`);
  await sleep(200);
  const noteKimi = await js(readNote);
  say('compact note, kimi only (tr): ' + JSON.stringify(noteKimi));
  check('[tr] a Kimi-only history: its source line, the lead, and "Kimi: fiyat yayımlamıyor" behind why',
    noteKimi.leadCount === 2 && noteKimi.whyHidden === false
      && JSON.stringify(noteKimi.sources) === JSON.stringify(['Kimi · fiyat yayımlamıyor'])
      && JSON.stringify(noteKimi.why) === JSON.stringify(['Kimi: fiyat yayımlamıyor']), noteKimi);

  // F3: Claude with no cause plus Kimi. The period reads "en az" because of
  // Kimi alone, so the lead and the explanation must still be there.
  await js(`window.__probe.setHistoryPricesDirect({ claude: '2026-08-01' }, '2026-08-01', ['claude', 'kimi'], { kimi: ['unpriced'] })`);
  await sleep(200);
  const noteCK = await js(readNote);
  say('compact note, claude (no causes) + kimi (tr): ' + JSON.stringify(noteCK));
  check('[tr] F3: Claude with no cause plus Kimi still shows the lead and says why',
    noteCK.leadCount === 2 && noteCK.whyHidden === false
      && JSON.stringify(noteCK.sources) === JSON.stringify(['Claude Code · 1 Ağu 2026 fiyatları', 'Kimi · fiyat yayımlamıyor'])
      && JSON.stringify(noteCK.why) === JSON.stringify(['Kimi: fiyat yayımlamıyor'])
      && noteCK.introSources === 'Yalnızca bu bilgisayardaki Claude Code ve Kimi kayıtlarından hesaplanır.', noteCK);

  // An older main: no per-tool data at all, so the legacy (Claude) date is used.
  await js(`window.__probe.setHistoryPricesDirect({}, '2026-08-01', [], {})`);
  await sleep(200);
  const legacyNote = await js(readNote);
  say('legacy note (tr): ' + JSON.stringify(legacyNote));
  check('with no per-tool data (older main) the legacy Claude date and both Claude causes still show',
    JSON.stringify(legacyNote.sources) === JSON.stringify(['Claude Code · 1 Ağu 2026 fiyatları'])
      && legacyNote.why[0] === 'Claude Code: fiyatlanamayan kullanım ve süresi kaydedilmemiş önbellek yazmaları (1,25× ile)'
      && !/Codex/.test(legacyNote.text)
      && legacyNote.introSources === 'Yalnızca yerel kayıtlardan hesaplanır.', legacyNote);
  await js(`window.__probe.setHistoryPricesDirect()`);
  await sleep(200);

  // ADR-002 A3.21: the two-date note names tier uncertainty in the Codex clause,
  // and still wraps whole in every format.
  const readUsageNotes = `(async () => {
    const view = document.getElementById('settings-view');
    document.querySelector('.iconbtn--settings').click();
    await new Promise((r) => setTimeout(r, 120));
    view.querySelector('.acc__trigger[data-acc="usage"]').click();
    await new Promise((r) => setTimeout(r, 80));
    const n = view.querySelector('.usage__note');
    const inc = view.querySelector('.usage__incomplete');
    const list = view.querySelector('.usage__list');
    const out = {
      note: n && !n.hidden ? n.textContent : null,
      noteClipped: n ? n.scrollWidth > n.clientWidth : null,
      noteTov: n ? getComputedStyle(n).textOverflow : null,
      incomplete: inc && !inc.hidden ? inc.textContent : null,
      incompleteDrawn: inc ? inc.getClientRects().length > 0 : null,
      incompleteClipped: inc ? inc.scrollWidth > inc.clientWidth : null,
      incompleteBeforeList: !!(inc && list) && (inc.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      incompleteCount: view.querySelectorAll('.usage__incomplete').length,
    };
    view.querySelector('.acc__trigger[data-acc="models"]').click();
    await new Promise((r) => setTimeout(r, 60));
    document.querySelector('.iconbtn--settings').click();
    await new Promise((r) => setTimeout(r, 120));
    return out;
  })()`;
  const notesTr = await js(readUsageNotes);
  say('usage notes (tr): ' + JSON.stringify(notesTr));
  check('[tr] the fixture\'s note has Codex\'s source line and its causes, whole',
    /Codex · 15 Ağu 2026 fiyatları/.test(notesTr.note || '')
      && /Codex: fiyatlanamayan kullanım ve kaydedilmemiş önbellek yazmaları/.test(notesTr.note || '')
      && notesTr.noteClipped === false && notesTr.noteTov !== 'ellipsis', notesTr);
  check('no incomplete note while no tool is incomplete', notesTr.incomplete === null, notesTr.incomplete);

  await js(`window.__probe.setHistoryIncompleteDirect(['codex', 'bogus', 'codex'])`);
  await sleep(200);
  const incTr = await js(readUsageNotes);
  say('usage incomplete (tr): ' + JSON.stringify(incTr));
  check('[tr] an incomplete tool gets ONE note above the list, known ids only, named once',
    incTr.incomplete === 'Codex için bazı yerel kayıtlar okunamadı; etkilenen dönemler bir alt sınırdır.'
      && incTr.incompleteCount === 1 && incTr.incompleteBeforeList === true
      && incTr.incompleteDrawn === true && incTr.incompleteClipped === false, incTr);
  await js(`window.__probe.setLocaleDirect('en', 'en-US')`);
  await sleep(300);
  const incEn = await js(readUsageNotes);
  say('usage incomplete (en-US): ' + JSON.stringify(incEn));
  check('[en-US] the incomplete note and the tier clause read in English, whole',
    incEn.incomplete === 'Some local records for Codex could not be read; affected periods are a lower bound.'
      && incEn.incompleteClipped === false
      && /Codex · Aug 15, 2026 prices/.test(incEn.note || '')
      && /Codex: usage that could not be priced and unrecorded cache writes/.test(incEn.note || '')
      && incEn.noteClipped === false, incEn);
  await js(`window.__probe.setLocaleDirect('en', 'en-GB')`);
  await sleep(300);
  const incGb = await js(readUsageNotes);
  say('usage incomplete (en-GB): ' + JSON.stringify(incGb));
  check('[en-GB] nothing in the notes is clipped',
    incGb.incompleteClipped === false && incGb.noteClipped === false && incGb.incomplete !== null, incGb);
  await js(`window.__probe.setLocaleDirect('tr', 'tr-TR')`);
  await js(`window.__probe.setHistoryIncompleteDirect([])`);
  await sleep(300);

  // ---- F6: nothing says "no data" when records are known to be unread -----
  const readHistory = `(async () => {
    const view = document.getElementById('settings-view');
    document.querySelector('.iconbtn--settings').click();
    await new Promise((r) => setTimeout(r, 120));
    view.querySelector('.acc__trigger[data-acc="usage"]').click();
    await new Promise((r) => setTimeout(r, 80));
    const e = view.querySelector('.usage__empty');
    const inc = view.querySelector('.usage__incomplete');
    const out = {
      amounts: [...view.querySelectorAll('.usage__row')].map((r) => ({
        text: r.querySelector('.usage__amount').textContent,
        incomplete: r.getAttribute('data-incomplete'),
        empty: r.getAttribute('data-empty'),
      })),
      emptyText: e && !e.hidden ? e.textContent : null,
      incomplete: inc && !inc.hidden ? inc.textContent : null,
    };
    view.querySelector('.acc__trigger[data-acc="models"]').click();
    await new Promise((r) => setTimeout(r, 60));
    document.querySelector('.iconbtn--settings').click();
    await new Promise((r) => setTimeout(r, 120));
    return out;
  })()`;
  // Control first: the fixture's empty month reads "—" when nothing is unread.
  const histBase = await js(readHistory);
  say('history base (tr): ' + JSON.stringify(histBase));
  check('control: a genuinely empty period still reads "—" and carries no incomplete mark',
    histBase.amounts.some((a) => a.text === '—' && a.empty === 'true' && a.incomplete === null), histBase.amounts);
  await js(`window.__probe.setHistoryShapeDirect('emptyFloor')`);
  await sleep(250);
  const histFloor = await js(readHistory);
  say('history empty floor (tr): ' + JSON.stringify(histFloor));
  check('a floored period with no usage reads "okunamadı", not "—", and is marked data-incomplete',
    histFloor.amounts.length === 3 && !histFloor.amounts.some((a) => a.text === '—')
      && histFloor.amounts[2].text === 'okunamadı' && histFloor.amounts[2].incomplete === 'true'
      && histFloor.amounts[2].empty === null, histFloor.amounts);
  await js(`window.__probe.setLocaleDirect('en', 'en-US')`);
  await sleep(300);
  const histFloorEn = await js(readHistory);
  check('[en] and "could not be read" in English',
    histFloorEn.amounts[2] && histFloorEn.amounts[2].text === 'could not be read', histFloorEn.amounts);
  await js(`window.__probe.setLocaleDirect('tr', 'tr-TR')`);
  await sleep(300);
  await js(`window.__probe.setHistoryShapeDirect('noPeriods')`);
  await sleep(250);
  const histNone = await js(readHistory);
  say('history no periods, incomplete (tr): ' + JSON.stringify(histNone));
  check('no periods with a tool known incomplete: no "no records found", only the incomplete note',
    histNone.emptyText === null && histNone.amounts.length === 0
      && histNone.incomplete === 'Codex için bazı yerel kayıtlar okunamadı; etkilenen dönemler bir alt sınırdır.', histNone);
  await js(`window.__probe.setHistoryShapeDirect('restore')`);
  await sleep(250);
  const histBack = await js(readHistory);
  check('control: the fixture history is restored, with no incomplete note',
    histBack.incomplete === null && histBack.amounts.length === 3, histBack);

  // Row: the causes-only cost block states the gap; "Token bilgisi yok" must not.
  const readMeta = `(() => {
    const row = ${q('codex')};
    const meta = row.querySelector('.row__meta');
    const cost = row.querySelector('.cost');
    return {
      meta: meta ? meta.textContent : null,
      costShown: !!cost && !cost.hidden,
      causes: cost ? [...cost.querySelectorAll('.cost__cause')].map((n) => n.textContent) : [],
    };
  })()`;
  await js(`window.__probe.setPendingDirect([], { codex: { tokens: null, weeklyTokens: null, burnRatePerHour: null } })`);
  await js(`window.__probe.setCostDirect('codex', 'codexUnrecordedOnly')`);
  await sleep(250);
  const metaControl = await js(readMeta);
  say('row meta, logs read (tr): ' + JSON.stringify(metaControl));
  check('control: a row with no tokens and a fully read source still says "Token bilgisi yok"',
    /Token bilgisi yok/.test(metaControl.meta || ''), metaControl);
  await js(`window.__probe.setCostDirect('codex', 'incompleteNoFigure')`);
  await sleep(250);
  const metaInc = await js(readMeta);
  say('row meta, source incomplete (tr): ' + JSON.stringify(metaInc));
  check('with sourceIncomplete the row drops "Token bilgisi yok" and the cost block states the gap',
    !/Token bilgisi yok/.test(metaInc.meta || '') && metaInc.costShown === true
      && metaInc.causes.length === 1 && metaInc.causes[0] === 'Okunamayan kayıtlar var', metaInc);
  await js(`window.__probe.restore()`);
  await sleep(250);

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

  // ---- English: the collapsed claim wraps, it is never cut -------------
  //
  // ADR-004 Amendment 2.3 as ruled: honesty copy is never truncated to fit. In
  // English a floored summary cannot fit one line at 360px ("Would have cost
  // at least $226.81 at published API prices" is wider than the line), and an
  // ellipsis there cuts the claim itself. Reached the way main does it: the
  // language is persisted, then PREFERENCES is pushed.
  await js('window.__probe.setDeferPrefs(true)');
  await js(`window.usageNotch.setLanguage('en')`);
  await js('window.__probe.flushPrefs()');
  await js('window.__probe.setDeferPrefs(false)');
  await sleep(300);
  const enSummary = await js(`(() => {
    const s = ${q('codex')}.querySelector('.cost__summary');
    const cs = getComputedStyle(s);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
    const out = {
      lang: document.documentElement.getAttribute('lang'),
      text: s.textContent,
      scrollW: s.scrollWidth,
      clientW: s.clientWidth,
      textOverflow: cs.textOverflow,
      lines: Math.round(s.getBoundingClientRect().height / lh),
    };
    // Control: the pre-ruling CSS, restored inline for one measurement. If
    // this does NOT clip, the check above it is vacuous — the text would have
    // fitted anyway and the wrap would be untested.
    const keep = s.style.cssText;
    s.style.whiteSpace = 'nowrap';
    s.style.overflow = 'hidden';
    s.style.textOverflow = 'ellipsis';
    out.nowrapScrollW = s.scrollWidth;
    out.nowrapClientW = s.clientWidth;
    s.style.cssText = keep;
    return out;
  })()`);
  say('english summary: ' + JSON.stringify(enSummary));
  check('the English panel is reached through the PREFERENCES push',
    enSummary.lang === 'en', enSummary.lang);
  check('the floored English summary carries the counterfactual and the floor',
    /^Would have cost at least \$/.test(enSummary.text) && /at published API prices$/.test(enSummary.text),
    enSummary.text);
  check('the floored English summary is not clipped',
    enSummary.scrollW <= enSummary.clientW, enSummary);
  check('and it is not ellipsized: it wraps onto a second line instead',
    enSummary.textOverflow !== 'ellipsis' && enSummary.lines >= 2, enSummary);
  check('control: under the old nowrap+ellipsis rule the same text WOULD clip',
    enSummary.nowrapScrollW > enSummary.nowrapClientW, enSummary);

  // Back to Turkish, so the closing state is the one this suite always ended in.
  await js(`window.usageNotch.setLanguage('tr')`);
  await sleep(300);

  await js(`${q('claude')}.querySelector('.cost__toggle').click()`);
  await js(`document.querySelector('.panel__band--list').scrollTop = 220`);
  await sleep(250);
  say(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}  (${lines.filter(l => l.startsWith('PASS')).length} pass)`);
  app.exit(failures === 0 ? 0 : 1);
}).catch((e) => { say('THREW: ' + (e && e.stack ? e.stack : e)); app.exit(1); });
