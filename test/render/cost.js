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
  check('[tr] and no cause is printed beside it (the floor marker is gone)',
    !/kaydedilmemiş|\(/.test(zeroWeek.meta || ''), zeroWeek.meta);
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

  // The owner removed the floor marker (2026-09-23): a count main marks as a
  // lower bound prints exactly like one it does not — no "en az", no cause in
  // brackets. Main still sends the causes; the row just does not draw them.
  await js(`window.__probe.restore()`);
  await js(`window.__probe.setPendingDirect([], { codex: { weeklyTokenFloorCauses: ['unrecorded-writes'] } })`);
  await sleep(220);
  const floored = await js(readRowTokens('codex'));
  say('row tokens, floor count (tr): ' + JSON.stringify(floored));
  await js(`window.__probe.setPendingDirect([], { codex: { weeklyTokenFloorCauses: [] } })`);
  await sleep(220);
  const exact = await js(readRowTokens('codex'));
  check('[tr] a weekly count main marks as a lower bound prints no "en az" and no cause',
    /token/.test(floored.meta || '') && !/en az|~|kaydedilmemiş|\(/.test(floored.meta || ''), floored.meta);
  check('[tr] and it reads exactly like the same count with no causes',
    floored.meta === exact.meta, [floored.meta, exact.meta]);
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
    const b = document.querySelector('.iconbtn--refresh');
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
    framing.qwen && framing.qwen.summary.includes('<$0,01')
      && !framing.qwen.summary.includes('$0,00'),
    framing.qwen && framing.qwen.summary);

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
  // all been read. The qwen row is stale with sourceIncomplete: false.
  const staleRow = framing.qwen;
  const staleCost = await js(`(() => {
    const row = ${q('qwen')};
    const c = row.querySelector('.cost');
    return {
      rowStatus: row.getAttribute('data-status'),
      floorUi: c.querySelectorAll('.cost__cause-block, .cost__why, .cost__why-lead, .cost__causes, .cost__cause, .cost__caveat').length,
      text: c.innerText,
    };
  })()`);
  say('stale row cost: ' + JSON.stringify(staleCost));
  check('control: the qwen row really is stale, so the check below is not vacuous',
    staleCost.rowStatus === 'stale', staleCost.rowStatus);
  check('a stale row with sourceIncomplete false prints NO floor from its status',
    !/en az/.test(staleRow.summary), staleRow.summary);
  check('and no cause line, no "why" disclosure and no degraded sentence at all',
    staleCost.floorUi === 0 && !/okunamadı/.test(staleCost.text), staleCost);

  // ---- a floored week prints its figure plainly (owner, 2026-09-23) ------
  // The codex row carries unpriced usage and the TTL fallback — two causes
  // that used to make it "en az". The floor marker is gone: the same figure,
  // no bound word.
  const codex = framing.codex;
  check('a week main marks as a floor prints its figure with no "en az"',
    /^Yayımlanan API fiyatlarıyla \$226,81 tutardı$/.test(codex.summary), codex.summary);

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
        floorUi: c.querySelectorAll('.cost__cause-block, .cost__why, .cost__why-lead, .cost__causes, .cost__cause, .cost__caveat').length,
        text: c.innerText,
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
  // is also the check the old fixture could not make: it gave the local-log row an
  // anchored cost, a state main cannot produce for a tool that publishes no
  // weekly reset, so the contradiction was baked into the fixture itself.
  const windowAgreement = await js(`(() => {
    const out = {};
    for (const id of ['claude', 'codex', 'qwen']) {
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
    detail.claude.floorUi === 0, detail.claude);

  // ---- a floored week draws no cause, open or closed ---------------------
  // Unpriced usage and the TTL fallback used to be two cause lines with two
  // explanations. Expanded, the block now shows the breakdown and nothing else.
  check('expanded, a floored week shows no cause line, no explanation and no "why"',
    detail.codex.floorUi === 0 && !/en az|Fiyatlanamadı|kaydedilmemiş/.test(detail.codex.text),
    detail.codex);
  check('and its expanded lead carries the plain figure',
    /\$226,81 ABD doları/.test(detail.codex.lead) && !/en az/.test(detail.codex.lead), detail.codex.lead);
  check('a non-anchored window is labelled as a trailing seven days',
    /^Son 7 gün/.test(detail.codex.prov[0]), detail.codex.prov[0]);

  // ---- the all-unpriced expanded state ---------------------------------
  await js(`${q('antigravity')}.querySelector('.cost__toggle').click()`);
  await js(`${q('qwen')}.querySelector('.cost__toggle').click()`);
  await sleep(150);
  const noPrice = await js(`(() => {
    const pick = (id) => {
      const c = document.querySelector('li.row[data-provider="'+id+'"] .cost');
      return {
        lead: c.querySelector('.cost__lead').textContent,
        denialHidden: c.querySelector('.cost__denial').hidden,
        rows: c.querySelectorAll('.cost__row').length,
        floorUi: c.querySelectorAll('.cost__cause-block, .cost__why, .cost__why-lead, .cost__causes, .cost__cause, .cost__caveat').length,
        text: c.innerText,
        aria: c.querySelector('.cost__toggle').getAttribute('aria-label'),
        meta: (document.querySelector('li.row[data-provider="'+id+'"] .row__meta') || {}).textContent || '',
        flag: c.dataset.unpriced || null,
      };
    };
    return { anti: pick('antigravity'), gem: pick('qwen') };
  })()`);
  say('noPrice: ' + JSON.stringify(noPrice, null, 1));
  check('the expanded all-unpriced lead carries no figure',
    !/\$/.test(noPrice.anti.lead) && /hesaplanamadı/.test(noPrice.anti.lead), noPrice.anti.lead);
  check('the bill denial is suppressed when there is no amount to deny',
    noPrice.anti.denialHidden === true);
  check('the all-unpriced week draws no cause line, no explanation and no "why"',
    noPrice.anti.floorUi === 0 && !/Fiyatlanamadı|Neden|alt sınır/.test(noPrice.anti.text), noPrice.anti);
  check('its spoken name promises the details, not a model list the block no longer draws',
    /Ayrıntıları açmak için etkinleştirin\.$/.test(noPrice.anti.aria || '')
      && !/modelleri görmek/.test(noPrice.anti.aria || ''), noPrice.anti.aria);
  check('the row is flagged as unpriced for styling', noPrice.anti.flag === 'true');
  check('a stale row with sourceIncomplete false does not claim records could not be read',
    noPrice.gem.floorUi === 0 && !/okunamadı/.test(noPrice.gem.text), noPrice.gem);

  // ---- a partial payload degrades, it does not vanish -------------------
  // Swapped onto the passive Kimi row, which carries no cost of its own until
  // the Kimi checks below give it one.
  check('the fixture swapped the partial week onto the kimi row',
    (await js(`window.__probe.setCostDirect('kimi', 'partial')`)) === true);
  await sleep(200);
  await js(`${q('kimi')}.querySelector('.cost__toggle').click()`);
  await sleep(120);
  const partial = await js(`(() => {
    const c = document.querySelector('li.row[data-provider="kimi"] .cost');
    if (!c || c.hidden) return null;
    return {
      summary: c.querySelector('.cost__summary').textContent,
      barHidden: c.querySelector('.cost__bar').hidden,
      captionHidden: c.querySelector('.cost__caption').hidden,
      rows: c.querySelectorAll('.cost__row').length,
      floorUi: c.querySelectorAll('.cost__cause-block, .cost__why, .cost__why-lead, .cost__causes, .cost__cause, .cost__caveat').length,
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
    partial.floorUi === 0, partial);

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

  // ---- the floor marker is gone, whatever the week (owner, 2026-09-23) ----
  //
  // Every fixture week that used to read "en az" with cause lines and a "why"
  // disclosure — Codex tiers, unrecorded writes, unreadable records, tier
  // floors, ten unpriced entries, every cause at once — is swapped onto the
  // codex row in turn. Main still sends all of those fields. None of them may
  // draw anything: the figure prints as it is, in every language and format.
  const readFloorUi = `(() => {
    const row = ${q('codex')};
    const c = row.querySelector('.cost');
    const t = c.querySelector('.cost__toggle');
    if (t.getAttribute('aria-expanded') !== 'true') t.click();
    return {
      lang: document.documentElement.getAttribute('lang'),
      shown: !c.hidden,
      summary: c.querySelector('.cost__summary').textContent,
      aria: t.getAttribute('aria-label'),
      lead: c.querySelector('.cost__lead').textContent,
      floorUi: c.querySelectorAll('.cost__cause-block, .cost__why, .cost__why-lead, .cost__causes, .cost__cause, .cost__caveat').length,
      text: c.hidden ? '' : c.innerText,
      meta: (row.querySelector('.row__meta') || {}).textContent || '',
    };
  })()`;
  // Words the removed UI printed. "~" too: no approximation sign replaces it.
  const FLOOR_WORDS = /\ben az\b|\bat least\b|Neden|\bWhy\b|alt sınır|lower bound|Fiyatlanamadı|Could not be priced|~/i;
  const FLOORED_WEEKS = ['codexTier', 'codexUnrecordedOnly', 'sourceIncomplete', 'owner', 'tierFloor', 'manyUnpriced', 'allCauses', 'ownerTiers', 'caveat'];
  for (const week of FLOORED_WEEKS) {
    check(`the fixture swapped the ${week} week onto the codex row`,
      (await js(`window.__probe.setCostDirect('codex', '${week}')`)) === true);
    await sleep(200);
    const r = await js(readFloorUi);
    say(`floor ui, ${week} (tr): ` + JSON.stringify(r));
    check(`[tr] ${week}: the figure prints plainly — no floor word, no cause line, no "why"`,
      r.shown && r.summary === 'Yayımlanan API fiyatlarıyla $226,81 tutardı' && r.floorUi === 0
        && !FLOOR_WORDS.test(r.text) && !FLOOR_WORDS.test(r.aria || '') && !FLOOR_WORDS.test(r.meta), r);
  }
  // No figure and nothing unpriced — records the reader could not open. The
  // block used to show its cause line alone; with nothing true left to print
  // it is hidden, and the row's own line says the week could not be counted.
  check('the fixture swapped the incomplete, unpriced-nothing week onto the codex row',
    (await js(`window.__probe.setCostDirect('codex', 'incompleteNoFigure')`)) === true);
  await js(`window.__probe.setPendingDirect([], { codex: { tokens: null, weeklyTokens: null, burnRatePerHour: null } })`);
  await sleep(250);
  const noFigure = await js(`(() => {
    const row = ${q('codex')};
    const c = row.querySelector('.cost');
    return { shown: !!c && !c.hidden, meta: (row.querySelector('.row__meta') || {}).textContent || '' };
  })()`);
  say('floor ui, incompleteNoFigure (tr): ' + JSON.stringify(noFigure));
  check('unreadable records with no figure hide the block, and the row line says the week could not be counted',
    noFigure.shown === false && noFigure.meta === 'Haftalık: sayılamadı', noFigure);
  await js(`window.__probe.setPendingDirect([])`);

  for (const [lang, locale] of [['en', 'en-US'], ['en', 'en-GB']]) {
    await js(`window.__probe.setLocaleDirect('${lang}', '${locale}')`);
    await js(`window.__probe.setCostDirect('codex', 'allCauses')`);
    await sleep(300);
    const r = await js(readFloorUi);
    say(`floor ui, allCauses (${locale}): ` + JSON.stringify(r));
    check(`[${locale}] the every-cause week prints its plain figure in English, and nothing about bounds`,
      r.lang === 'en' && /^Would have cost (US)?\$226\.81 at published API prices$/.test(r.summary)
        && r.floorUi === 0 && !FLOOR_WORDS.test(r.text) && !FLOOR_WORDS.test(r.aria || ''), r);
  }
  await js(`window.__probe.setLocaleDirect('tr', 'tr-TR')`);
  await sleep(300);
  await js(`window.__probe.setCostDirect('codex', 'caveat')`);
  await sleep(250);

  // ---- ADR-003 A6: Qwen Code, Grok Build and Kimi Code rows --------------
  const RAW_CODES_A6 = /no-model|no-published-price|other-model-alias|no-reported-cost|standard-long-context|unknown-tier|unrecordedCalls|longPrompt|toolToken|partialUsage/;
  const readLocalRow = (id) => `(async () => {
    const row = ${q(id)};
    const c = row.querySelector('.cost');
    const pill = row.querySelector('.row__line .tag-experimental');
    const t = c.querySelector('.cost__toggle');
    if (!t.hidden && t.getAttribute('aria-expanded') !== 'true') t.click();
    await new Promise((r) => setTimeout(r, 80));
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
      floorUi: c.querySelectorAll('.cost__cause-block, .cost__why, .cost__why-lead, .cost__causes, .cost__cause, .cost__caveat').length,
      prov: [...c.querySelectorAll('.cost__prov span')].map((s) => s.textContent),
      text: c.textContent + ' ' + row.querySelector('.row__line').textContent,
      watch: (() => { const s = document.createElement('span'); s.style.color = 'var(--watch)'; c.appendChild(s); const v = getComputedStyle(s).color; s.remove(); return v; })(),
    };
    return out;
  })()`;
  await js(`window.__probe.setPendingDirect([], {
    qwen: { status: 'ok', connected: true, lastGoodAt: null,
      tokens: { input: 904000, output: 120800, cacheWrite: 0, cacheRead: 400000, billable: 1024800 } },
    kimi: { status: 'ok', connected: true, setupAction: null,
      tokens: { input: 320000, output: 45000, cacheWrite: 0, cacheRead: 120000, billable: 365000 } },
    grok: { status: 'ok', connected: true, setupAction: null,
      tokens: { input: 80000, output: 12000, cacheWrite: 6000, cacheRead: 300000, billable: 98000 } },
  })`);
  await js(`window.__probe.setCostDirect('qwen', 'qwen')`);
  await js(`window.__probe.setCostDirect('kimi', 'kimi')`);
  await js(`window.__probe.setCostDirect('grok', 'grok')`);
  await sleep(300);
  const gemTr = await js(readLocalRow('qwen'));
  say('qwen row (tr): ' + JSON.stringify(gemTr));
  check('[tr] Qwen carries the calm "deneysel" pill with its explanation on hover and for a screen reader',
    !!gemTr.pill && gemTr.pill.text === 'deneysel'
      && gemTr.pill.title === 'Bu aracın kayıt biçimi gerçek bir kurulumda henüz doğrulanmadı.'
      && /Bu aracın kayıt biçimi gerçek bir kurulumda henüz doğrulanmadı\./.test(gemTr.pill.spoken || '')
      && gemTr.pill.color !== gemTr.watch && gemTr.pill.border !== gemTr.watch, gemTr.pill);
  check('[tr] Qwen shows its tokens like Codex does',
    /token/.test(gemTr.meta) && !/Token bilgisi yok/.test(gemTr.meta), gemTr.meta);
  check('[tr] the Qwen figure prints plainly: no "en az", no cause line, no "why"',
    gemTr.summary === 'Alibaba Cloud Model Studio fiyatlarıyla $12,34 tutardı' && gemTr.floorUi === 0
      && !/en az|Kaydedilmeyen|Uzun istem|Araç tokenları|Neden/.test(gemTr.text), [gemTr.summary, gemTr.floorUi]);
  check('[tr] Qwen names its price source in the summary, the spoken name and the provenance line',
    /Alibaba Cloud Model Studio fiyatlarıyla \$?12,34 ABD doları tutardı/.test(gemTr.aria || '')
      && gemTr.prov.includes('Alibaba Cloud Model Studio uluslararası fiyatları, 28 Eylül 2026 tarihli listeye göre')
      && gemTr.summaryLines <= 2 && gemTr.summaryClipped === false, [gemTr.aria, gemTr.prov, gemTr.summaryLines]);
  check('[tr] no raw producer code reaches the Qwen row',
    !RAW_CODES_A6.test(gemTr.text), gemTr.text);

  const grokTr = await js(readLocalRow('grok'));
  say('grok row (tr): ' + JSON.stringify(grokTr));
  check('[tr] Grok carries the pill and names xAI as the source of its amount, with no date and no gap',
    !!grokTr.pill && grokTr.pill.text === 'deneysel'
      && grokTr.summary === "xAI'nin bildirdiğine göre $0,51 tutardı"
      && /xAI'nin bildirdiğine göre \$?0,51 ABD doları tutardı/.test(grokTr.aria || '')
      && grokTr.prov.includes("Tutarlar, xAI'nin oturum dosyalarında bildirdiği gibidir")
      && !grokTr.prov.some((p) => /tarihi bildirilmedi|tarihli listeye/.test(p))
      && grokTr.floorUi === 0 && !/en az/.test(grokTr.text),
    [grokTr.summary, grokTr.aria, grokTr.prov]);
  check('[tr] Grok\'s reported amount has no class split, so no composition bar or caption is drawn',
    (await js(`(() => { const c = ${q('grok')}.querySelector('.cost'); return c.querySelector('.cost__bar').hidden && c.querySelector('.cost__caption').hidden; })()`)) === true);
  check('[tr] no raw producer code reaches the Grok row', !RAW_CODES_A6.test(grokTr.text), grokTr.text);
  await js(`window.__probe.setCostDirect('grok', 'grokNone')`);
  await sleep(250);
  const grokNone = await js(readLocalRow('grok'));
  say('grok row, nothing reported (tr): ' + JSON.stringify(grokNone));
  check('[tr] a Grok week xAI reported no cost for: no amount, never $0, and not "not in the price list"',
    grokNone.summary === 'Grok Build bu kullanım için tutar bildirmedi; tutar yok.'
      && !/\$/.test(grokNone.text) && !/fiyat listesinde/.test(grokNone.summary + ' ' + (grokNone.aria || ''))
      && grokNone.aria === 'Grok Build: bu kullanım için tutar bildirilmedi, bu yüzden tutar yok. Ayrıntıları açmak için etkinleştirin.',
    [grokNone.summary, grokNone.aria]);
  await js(`window.__probe.setCostDirect('grok', 'grok')`);
  await sleep(250);

  const kimiTr = await js(readLocalRow('kimi'));
  say('kimi row (tr): ' + JSON.stringify(kimiTr));
  check('[tr] Kimi carries the pill and shows its tokens',
    !!kimiTr.pill && kimiTr.pill.text === 'deneysel' && /token/.test(kimiTr.meta), [kimiTr.pill, kimiTr.meta]);
  check('[tr] Kimi\'s usage is all unpriced: no amount anywhere, never $0',
    !/\$/.test(kimiTr.text) && !/0,00/.test(kimiTr.text) && !/en az/.test(kimiTr.summary)
      && kimiTr.summary === 'Kimi token başına fiyat yayımlamıyor; tutar yok.'
      && !/fiyat listesinde/.test(kimiTr.summary + ' ' + (kimiTr.aria || ''))
      && kimiTr.aria === 'Kimi: token başına fiyat yayımlamıyor, bu yüzden tutar yok. Ayrıntıları açmak için etkinleştirin.',
    [kimiTr.summary, kimiTr.aria]);
  check('[tr] Kimi draws no cause line, no explanation and no "why", and no raw code',
    kimiTr.floorUi === 0 && !/Fiyatlanamadı|Neden/.test(kimiTr.text) && !RAW_CODES_A6.test(kimiTr.text), kimiTr);
  check('[tr] the provenance says Kimi publishes no prices, not that a list date is missing',
    kimiTr.prov.includes('Kimi fiyat yayımlamıyor') && !kimiTr.prov.some((p) => /tarihi bildirilmedi/.test(p)), kimiTr.prov);

  for (const [lang, locale] of [['tr', 'tr-TR'], ['en', 'en-US'], ['en', 'en-GB']]) {
    await js(`window.__probe.setLocaleDirect('${lang}', '${locale}')`);
    await sleep(300);
    const g = await js(readLocalRow('qwen'));
    const k = await js(readLocalRow('kimi'));
    const x = await js(readLocalRow('grok'));
    say(`qwen/kimi/grok (${locale}): ` + JSON.stringify([g.summary, k.summary, x.summary]));
    check(`[${locale}] no local-log row draws floor UI`,
      g.floorUi === 0 && k.floorUi === 0 && x.floorUi === 0, [g.floorUi, k.floorUi, x.floorUi]);
    check(`[${locale}] no raw code on any of them`,
      !RAW_CODES_A6.test(g.text) && !RAW_CODES_A6.test(k.text) && !RAW_CODES_A6.test(x.text), [g.text, k.text, x.text]);
    if (lang === 'en') {
      check(`[${locale}] the English pill, summaries and Kimi provenance`,
        g.pill && g.pill.text === 'experimental'
          && g.pill.title === "This tool's log format has not yet been verified on a real install."
          && k.prov.includes('Kimi does not publish prices')
          && k.summary === 'Kimi does not publish per-token prices, so there is no amount.'
          && /^Would have cost (US)?\$12\.34 at Alibaba Cloud Model Studio rates$/.test(g.summary)
          && g.prov.some((p) => /^Alibaba Cloud Model Studio international rates, from the list dated /.test(p))
          && g.summaryLines <= 2 && g.summaryClipped === false
          && /^Would have cost (US)?\$0\.51 as reported by xAI$/.test(x.summary)
          && x.prov.includes('Amounts as reported by xAI in the session files'),
        [g.pill, g.summary, k.summary, k.prov, x.summary, x.prov]);
    }
  }
  await js(`window.__probe.setLocaleDirect('tr', 'tr-TR')`);
  await sleep(300);

  // Qwen Code installed with no usage log at all: one honest line, no figure.
  await js(`window.__probe.setPendingDirect([], {
    qwen: { usageLogAbsent: true, tokens: null, weeklyTokens: null, weeklyTokensWindowAnchored: null, weeklyCost: null },
  })`);
  await sleep(250);
  const noLog = await js(`(() => {
    const row = ${q('qwen')};
    const hint = row.querySelector('.row__meta .row__hint');
    const c = row.querySelector('.cost');
    return { meta: row.querySelector('.row__meta').textContent, title: hint ? hint.getAttribute('title') : null,
             costHidden: !c || c.hidden };
  })()`);
  say('qwen, no usage log (tr): ' + JSON.stringify(noLog));
  check('[tr] a Qwen Code with no usage log says so, not "Token bilgisi yok", and shows no cost',
    noLog.meta === 'Henüz kullanım kaydı yok' && /0\.18\.4/.test(noLog.title || '') && /Qwen Code/.test(noLog.title || '')
      && noLog.costHidden === true, noLog);

  // Settings → Model Yönetimi carries the same pill for Qwen, Grok and Kimi only.
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
  check('Settings → Model Yönetimi shows "deneysel" on Qwen, Grok and Kimi, and on no other tool',
    settingsPills.length >= 6
      && settingsPills.every((s) => (s.id === 'qwen' || s.id === 'kimi' || s.id === 'grok')
        ? s.pill === 'deneysel' && /doğrulanmadı/.test(s.title || '') && s.clipped === false
        : s.pill === null), settingsPills);
  check('the Claude row has no pill',
    (await js(`${q('claude')}.querySelector('.tag-experimental') === null`)) === true);
  await js(`window.__probe.restore()`);
  await sleep(300);

  // ---- Settings: "Bağlantıyı kaldır" ------------------------------------
  // "Bağlantıyı kaldır": offered only while main reports our hook is in.
  const disc = await js(`(async () => {
    const view = document.getElementById('settings-view');
    const wasOpen = !view.hidden;
    if (!wasOpen) document.querySelector('.iconbtn--settings').click();
    await new Promise((r) => setTimeout(r, 150));
    const btn = () => view.querySelector('.settings__item[data-provider="claude"] .settings__disconnect');
    const before = btn() ? btn().hidden : 'missing';
    window.__probe.setHookDirect('claude', true);
    await new Promise((r) => setTimeout(r, 200));
    const shown = btn() && !btn().hidden;
    const label = btn() ? btn().textContent : null;
    const aria = btn() ? btn().getAttribute('aria-label') : null;
    const others = [...view.querySelectorAll('.settings__disconnect')].filter((b) => !b.hidden).length;
    btn().click();
    await new Promise((r) => setTimeout(r, 200));
    const calls = window.__probe.disconnectCalls();
    window.__probe.setHookDirect('claude', false);
    await new Promise((r) => setTimeout(r, 200));
    const after = btn().hidden;
    if (!wasOpen) document.querySelector('.iconbtn--settings').click();
    await new Promise((r) => setTimeout(r, 150));
    return { before, shown, label, aria, others, calls, after };
  })()`);
  check('[tr] "Bağlantıyı kaldır" appears only while the hook is in, and asks main with the id only',
    disc.before === true && disc.shown === true && disc.label === 'Bağlantıyı kaldır'
      && /Claude Code: bağlantıyı kaldır/.test(disc.aria || '') && disc.others === 1
      && JSON.stringify(disc.calls) === '["claude"]' && disc.after === true, disc);

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
    // One period is on screen at a time (owner, 2026-09-28): visit each through
    // its chart column, newest first like the history, read the row, and
    // leave the newest chosen again.
    const eachPeriod = async (read) => {
      const out = [];
      const count = view.querySelectorAll('.usage__col').length;
      for (let i = Math.max(count, 1) - 1; i >= 0; i -= 1) {
        const col = view.querySelectorAll('.usage__col')[i];
        if (col) { col.click(); await new Promise((r) => setTimeout(r, 20)); }
        const row = view.querySelector('.usage__row');
        if (row) out.push(read(row));
      }
      const cols = view.querySelectorAll('.usage__col');
      if (cols.length) cols[cols.length - 1].click();
      return out;
    };
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
      amounts: await eachPeriod((r) => ({
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

  // ---- ADR-003 A6: the price note, one source line per tool ----------------
  //
  // One short source line per tool, and nothing else: the "en az" leads and
  // the per-tool causes behind "Neden en az?" were removed (owner, 2026-09-23)
  // even though main still sends the cause map read below.
  const readNote = `(async () => {
    const view = document.getElementById('settings-view');
    document.querySelector('.iconbtn--settings').click();
    await new Promise((r) => setTimeout(r, 120));
    view.querySelector('.acc__trigger[data-acc="usage"]').click();
    await new Promise((r) => setTimeout(r, 80));
    const n = view.querySelector('.usage__note');
    const clip = (e) => e.scrollWidth > e.clientWidth + 0.5;
    const linesOf = (e) => Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight));
    const sources = [...n.querySelectorAll('.usage__source')];
    const out = {
      text: n.textContent,
      introSources: (view.querySelector('.usage__intro-sources') || {}).textContent || null,
      floorUi: view.querySelectorAll('.usage__note-lead, .usage__why, .usage__why-block, .usage__why-line, .cost__why').length,
      sources: sources.map((e) => e.textContent),
      sourceLines: sources.map(linesOf),
      sourcesClipped: sources.map(clip),
      width: Math.round(n.getBoundingClientRect().width),
    };
    view.querySelector('.acc__trigger[data-acc="models"]').click();
    await new Promise((r) => setTimeout(r, 60));
    document.querySelector('.iconbtn--settings').click();
    await new Promise((r) => setTimeout(r, 120));
    return out;
  })()`;
  const RAW_CAUSE_CODES = /unrecorded-calls|long-prompt|tool-tokens|partial-usage|cache-write-ttl-fallback|unrecorded-writes|assumed-tier|fast-requested|no-model|no-published-price|other-model-alias|no-reported-cost/;
  const ALL_TOOLS = [
    `{ claude: '2026-08-01', codex: '2026-08-15', qwen: '2026-09-28' }`,
    `'2026-08-01'`,
    `['claude', 'codex', 'qwen', 'kimi', 'grok']`,
    `{ claude: ['unpriced', 'cache-write-ttl-fallback'], codex: ['unrecorded-writes', 'assumed-tier', 'fast-requested'], qwen: ['unrecorded-calls'], kimi: ['unpriced'], grok: ['unpriced', 'partial-usage'], bogus: ['unpriced'] }`,
  ].join(', ');
  await js(`window.__probe.setHistoryPricesDirect(${ALL_TOOLS})`);
  await sleep(200);
  const noteAll = await js(readNote);
  say('compact note, five tools (tr): ' + JSON.stringify(noteAll));
  check('[tr] one short source line per tool, in order, and no lead, "why" or cause line',
    noteAll.floorUi === 0
      && JSON.stringify(noteAll.sources) === JSON.stringify([
        'Claude Code · 1 Ağu 2026 fiyatları',
        'Codex · 15 Ağu 2026 fiyatları',
        'Qwen Code · Alibaba Cloud Model Studio fiyatları, 28 Eyl 2026',
        'Kimi · fiyat yayımlamıyor',
        "Grok Build · xAI'nin bildirdiği tutar",
      ]) && !/en az|Neden|alt sınır/i.test(noteAll.text), [noteAll.floorUi, noteAll.sources]);
  check('[tr] each source is one line, never clipped',
    noteAll.sourceLines.every((n) => n === 1) && noteAll.sourcesClipped.every((v) => v === false),
    [noteAll.width, noteAll.sourceLines]);
  check('[tr] F1: the source sentence names the tools in the history, and keeps "only local"',
    noteAll.introSources === 'Yalnızca bu bilgisayardaki Claude Code, Codex, Qwen Code, Kimi ve Grok Build kayıtlarından hesaplanır.',
    noteAll.introSources);
  check('[tr] no raw cause code and no unknown tool anywhere in the note',
    !RAW_CAUSE_CODES.test(noteAll.text) && !/bogus/.test(noteAll.text), noteAll.text);
  for (const locale of ['en-US', 'en-GB']) {
    await js(`window.__probe.setLocaleDirect('en', '${locale}')`);
    await sleep(300);
    const n = await js(readNote);
    say(`compact note, five tools (${locale}): ` + JSON.stringify(n));
    const gb = locale === 'en-GB';
    check(`[${locale}] the note reads in English, one line per source, nothing clipped, nothing about bounds`,
      n.floorUi === 0
        && n.sources[0] === (gb ? 'Claude Code · 1 Aug 2026 prices' : 'Claude Code · Aug 1, 2026 prices')
        && n.sources[2] === (gb ? 'Qwen Code · Alibaba Cloud Model Studio rates, 28 Sept 2026' : 'Qwen Code · Alibaba Cloud Model Studio rates, Sep 28, 2026')
        && n.sources[3] === 'Kimi · does not publish prices'
        && n.sources[4] === 'Grok Build · as reported by xAI'
        && n.introSources === 'Calculated only from local Claude Code, Codex, Qwen Code, Kimi, and Grok Build logs.'
        && n.sourceLines.every((x) => x === 1) && n.sourcesClipped.every((v) => v === false)
        && !/at least|lower bound|Why/i.test(n.text) && !RAW_CAUSE_CODES.test(n.text),
      [n.sources, n.floorUi]);
  }
  await js(`window.__probe.setLocaleDirect('tr', 'tr-TR')`);
  await sleep(300);

  // Qwen only: its source line, nothing about Claude or Codex.
  await js(`window.__probe.setHistoryPricesDirect({ qwen: '2026-09-28' }, '2026-08-01', ['qwen'], { qwen: ['unrecorded-calls'] })`);
  await sleep(200);
  const noteGem = await js(readNote);
  say('compact note, qwen only (tr): ' + JSON.stringify(noteGem));
  check('[tr] a Qwen-only history: its source line only, nothing about Claude or Codex',
    noteGem.floorUi === 0 && JSON.stringify(noteGem.sources) === JSON.stringify(['Qwen Code · Alibaba Cloud Model Studio fiyatları, 28 Eyl 2026'])
      && !/Claude|Codex/.test(noteGem.text), noteGem);

  // Kimi only.
  await js(`window.__probe.setHistoryPricesDirect({}, '2026-08-01', ['kimi'], { kimi: ['unpriced'] })`);
  await sleep(200);
  const noteKimi = await js(readNote);
  say('compact note, kimi only (tr): ' + JSON.stringify(noteKimi));
  check('[tr] a Kimi-only history: "Kimi · fiyat yayımlamıyor" and nothing else',
    noteKimi.floorUi === 0 && JSON.stringify(noteKimi.sources) === JSON.stringify(['Kimi · fiyat yayımlamıyor']), noteKimi);

  // Claude with no cause plus Kimi.
  await js(`window.__probe.setHistoryPricesDirect({ claude: '2026-08-01' }, '2026-08-01', ['claude', 'kimi'], { kimi: ['unpriced'] })`);
  await sleep(200);
  const noteCK = await js(readNote);
  say('compact note, claude (no causes) + kimi (tr): ' + JSON.stringify(noteCK));
  check('[tr] Claude plus Kimi: two source lines, and no lead or "why" from Kimi\'s cause',
    noteCK.floorUi === 0
      && JSON.stringify(noteCK.sources) === JSON.stringify(['Claude Code · 1 Ağu 2026 fiyatları', 'Kimi · fiyat yayımlamıyor'])
      && noteCK.introSources === 'Yalnızca bu bilgisayardaki Claude Code ve Kimi kayıtlarından hesaplanır.', noteCK);

  // An older main: no per-tool data at all, so the legacy (Claude) date is used.
  await js(`window.__probe.setHistoryPricesDirect({}, '2026-08-01', [], {})`);
  await sleep(200);
  const legacyNote = await js(readNote);
  say('legacy note (tr): ' + JSON.stringify(legacyNote));
  check('with no per-tool data (older main) the legacy Claude date still shows, and no causes',
    JSON.stringify(legacyNote.sources) === JSON.stringify(['Claude Code · 1 Ağu 2026 fiyatları'])
      && legacyNote.floorUi === 0 && !/Codex/.test(legacyNote.text)
      && legacyNote.introSources === 'Yalnızca yerel kayıtlardan hesaplanır.', legacyNote);
  await js(`window.__probe.setHistoryPricesDirect()`);
  await sleep(200);

  // The two-date note wraps whole in every format, beside the unread-records note.
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
  check('[tr] the fixture\'s note has Codex\'s source line, whole, and no cause line',
    /Codex · 15 Ağu 2026 fiyatları/.test(notesTr.note || '')
      && !/Codex: /.test(notesTr.note || '')
      && notesTr.noteClipped === false && notesTr.noteTov !== 'ellipsis', notesTr);
  check('no incomplete note while no tool is incomplete', notesTr.incomplete === null, notesTr.incomplete);

  await js(`window.__probe.setHistoryIncompleteDirect(['codex', 'bogus', 'codex'])`);
  await sleep(200);
  const incTr = await js(readUsageNotes);
  say('usage incomplete (tr): ' + JSON.stringify(incTr));
  check('[tr] an incomplete tool gets ONE note above the list, known ids only, named once',
    incTr.incomplete === 'Codex için bazı yerel kayıtlar okunamadı; bu dönemlerde sayım eksik olabilir.'
      && incTr.incompleteCount === 1 && incTr.incompleteBeforeList === true
      && incTr.incompleteDrawn === true && incTr.incompleteClipped === false, incTr);
  await js(`window.__probe.setLocaleDirect('en', 'en-US')`);
  await sleep(300);
  const incEn = await js(readUsageNotes);
  say('usage incomplete (en-US): ' + JSON.stringify(incEn));
  check('[en-US] the incomplete note and the source line read in English, whole',
    incEn.incomplete === 'Some local records for Codex could not be read; these periods may be undercounted.'
      && incEn.incompleteClipped === false
      && /Codex · Aug 15, 2026 prices/.test(incEn.note || '')
      && !/Codex: /.test(incEn.note || '')
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
    // One period is on screen at a time (owner, 2026-09-28): visit each through
    // its chart column, newest first like the history, read the row, and
    // leave the newest chosen again.
    const eachPeriod = async (read) => {
      const out = [];
      const count = view.querySelectorAll('.usage__col').length;
      for (let i = Math.max(count, 1) - 1; i >= 0; i -= 1) {
        const col = view.querySelectorAll('.usage__col')[i];
        if (col) { col.click(); await new Promise((r) => setTimeout(r, 20)); }
        const row = view.querySelector('.usage__row');
        if (row) out.push(read(row));
      }
      const cols = view.querySelectorAll('.usage__col');
      if (cols.length) cols[cols.length - 1].click();
      return out;
    };
    const e = view.querySelector('.usage__empty');
    const inc = view.querySelector('.usage__incomplete');
    const out = {
      amounts: await eachPeriod((r) => ({
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
      && histNone.incomplete === 'Codex için bazı yerel kayıtlar okunamadı; bu dönemlerde sayım eksik olabilir.', histNone);
  await js(`window.__probe.setHistoryShapeDirect('restore')`);
  await sleep(250);
  const histBack = await js(readHistory);
  check('control: the fixture history is restored, with no incomplete note',
    histBack.incomplete === null && histBack.amounts.length === 3, histBack);

  // Row: "Token bilgisi yok" must not state an unread gap as a fact about the
  // tool. The cost block's cause line used to say it; now the row line does.
  const readMeta = `(() => {
    const row = ${q('codex')};
    const meta = row.querySelector('.row__meta');
    const cost = row.querySelector('.cost');
    return {
      meta: meta ? meta.textContent : null,
      costShown: !!cost && !cost.hidden,
      floorUi: cost ? cost.querySelectorAll('.cost__cause-block, .cost__why, .cost__why-lead, .cost__causes, .cost__cause, .cost__caveat').length : 0,
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
  check('with sourceIncomplete the row says "sayılamadı" instead of "Token bilgisi yok", and no cause line is drawn',
    !/Token bilgisi yok/.test(metaInc.meta || '') && /Haftalık: sayılamadı/.test(metaInc.meta || '')
      && metaInc.costShown === false && metaInc.floorUi === 0, metaInc);
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
    (await js(`document.querySelector('.toast').hidden`)) === true);

  await js(`window.__probe.push()`);
  await sleep(120);
  check('a background push never raises it',
    (await js(`document.querySelector('.toast').hidden`)) === true);

  await js(`window.__probe.setRefreshNotices(['ANTIGRAVITY_NOT_RUNNING'])`);
  await js(`document.querySelector('.iconbtn--refresh').click()`);
  await sleep(220);
  const bubble = await js(`(() => {
    const b = document.querySelector('.toast');
    const r = b.getBoundingClientRect();
    return {
      hidden: b.hidden,
      role: b.getAttribute('role'),
      title: (b.querySelector('.toast__title') || {}).textContent || '',
      text: (b.querySelector('.toast__text') || {}).textContent || '',
      mark: !!b.querySelector('.mark[data-logo="antigravity"]'),
      close: (b.querySelector('.toast__close') || {}).getAttribute
        ? b.querySelector('.toast__close').getAttribute('aria-label') : null,
      height: r.height, right: r.right,
    };
  })()`);
  say('refresh toast: ' + JSON.stringify(bubble));
  check('an explicit refresh with the IDE closed raises the toast',
    bubble.hidden === false && bubble.title === 'Antigravity kapalı' && /Açtığınızda/.test(bubble.text), bubble);
  check('it is calm, short and carries the tool mark',
    !/hata|bozuk|sorun var/i.test(bubble.text) && bubble.mark === true && bubble.height <= 90, bubble);
  check('it is a polite status region, not an alarm', bubble.role === 'status', bubble.role);
  check('it has a labelled close control', bubble.close === 'Bu mesajı kapat', bubble.close);

  await js(`document.querySelector('.toast__close').click()`);
  await sleep(120);
  check('dismiss clears the bubble',
    (await js(`document.querySelector('.toast').hidden`)) === true);

  await js(`window.__probe.setRefreshNotices(null)`);
  await js(`document.querySelector('.iconbtn--refresh').click()`);
  await sleep(220);
  check('a clean refresh leaves it down',
    (await js(`document.querySelector('.toast').hidden`)) === true);

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
  // English the summary ("Would have cost $226.81 at published API prices")
  // is close to the line width at 360px, and an ellipsis there would cut the
  // claim. Reached the way main does it: the
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
  check('the English summary carries the counterfactual, and no floor word',
    /^Would have cost \$/.test(enSummary.text) && /at published API prices$/.test(enSummary.text)
      && !/at least/.test(enSummary.text),
    enSummary.text);
  check('the English summary is not clipped',
    enSummary.scrollW <= enSummary.clientW, enSummary);
  // Without the floor word the sentence fits one line at this width today.
  // The rule is unchanged for a longer figure: wherever the one-line form
  // would clip (the nowrap control), the summary must wrap instead.
  check('and it is not ellipsized: it fits one line, or it wraps where one line would clip',
    enSummary.textOverflow !== 'ellipsis'
      && (enSummary.nowrapScrollW > enSummary.nowrapClientW ? enSummary.lines >= 2 : enSummary.lines === 1),
    enSummary);

  // Back to Turkish, so the closing state is the one this suite always ended in.
  await js(`window.usageNotch.setLanguage('tr')`);
  await sleep(300);

  await js(`${q('claude')}.querySelector('.cost__toggle').click()`);
  await js(`document.querySelector('.panel__band--list').scrollTop = 220`);
  await sleep(250);
  say(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}  (${lines.filter(l => l.startsWith('PASS')).length} pass)`);
  app.exit(failures === 0 ? 0 : 1);
}).catch((e) => { say('THREW: ' + (e && e.stack ? e.stack : e)); app.exit(1); });
