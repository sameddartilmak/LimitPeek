'use strict';
/**
 * RENDER SUITE — the panel: identity marks, the connected/monochrome rule, and
 * drag-and-drop reordering with its keyboard path.
 *
 * Deliberately NOT part of `npm test`. It boots a real Electron GUI process,
 * loads `src/renderer/index.html` against a fixture preload, and asserts on
 * COMPUTED DOM and computed styles — colours, stroke weights, focus, aria and
 * OS-level mouse input. `node --test` has no window to do that in.
 *
 *   npm run verify:render
 *
 * Exits 0 on pass, 1 on failure, one line per check.
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow, nativeTheme } = require('electron');

const HERE = __dirname;
const ROOT = path.join(HERE, '..', '..');
const OUT = process.env.RENDER_OUT || path.join(os.tmpdir(), 'usage-notch-render-panel.txt');
const lines = [];
function say(s) {
  lines.push(s);
  try {
    fs.writeFileSync(OUT, lines.join('\n') + '\n');
  } catch {}
}

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  say(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  :: ' + JSON.stringify(detail)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 420,
    height: 700,
    show: true,
    x: 20,
    y: 20,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(HERE, 'preload-fixture.js'),
    },
  });

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) say(`console[${level}]: ${message}`);
  });

  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(700);

  const js = (code) => win.webContents.executeJavaScript(code, true);

  /**
   * A real contrast calculator, in the page.
   *
   * The theme checks below assert LEGIBILITY, not literal hex values. A test
   * that pinned "the light watch is #8A5A0B" would pass for any hex someone
   * typed and would never notice that it had become unreadable on the ground
   * it is drawn on — which is the one thing a second palette can get wrong.
   * WCAG relative luminance, so 4.5 means the text threshold and 3.0 means the
   * non-text one.
   */
  await js(String.raw`
    window.__rgb = (s) => {
      s = String(s).trim();
      if (s[0] === '#') {
        let h = s.slice(1);
        if (h.length === 3) h = h.split('').map((c) => c + c).join('');
        return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
      }
      const m = s.match(/-?[\d.]+/g) || [];
      const v = [Number(m[0]) || 0, Number(m[1]) || 0, Number(m[2]) || 0];
      // color-mix() serialises as color(srgb 0.79 0.39 0.26) — 0..1 channels,
      // not 0..255. Reading those as bytes makes every colour black, which is
      // a contrast check that passes for the wrong reason.
      return s.indexOf('color(') === 0 ? v.map((n) => n * 255) : v;
    };
    window.__lum = (c) => {
      const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      const [r, g, b] = c.map(f);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    window.__cr = (a, b) => {
      const l1 = window.__lum(window.__rgb(a));
      const l2 = window.__lum(window.__rgb(b));
      return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
    };
    window.__tok = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    // Hue, in degrees. The ramp's meaning is carried by hue as well as by
    // luminance, and "redder than the step below it" is the property that keeps
    // the last two steps apart once both of them are bright.
    window.__hue = (c) => {
      const [r, g, b] = window.__rgb(c).map((v) => v / 255);
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      if (d === 0) return 0;
      let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
      return h < 0 ? h + 360 : h;
    };
    // Shortest angular distance, so 355 and 14 are 19 apart and not 341.
    window.__hueGap = (a, b) => {
      const d = Math.abs(window.__hue(a) - window.__hue(b)) % 360;
      return d > 180 ? 360 - d : d;
    };
    window.__ramp = () => {
      const T = window.__tok;
      const ramp = ['--calm', '--watch', '--ember', '--spent'].map(T);
      return {
        onBase: ramp.map((c) => window.__cr(c, T('--ink-900'))),
        onTrack: ramp.map((c) => window.__cr(c, T('--ink-600'))),
        tickOnFills: ramp.map((c) => window.__cr(T('--tick'), c)),
        spentEmberHueGap: Math.round(window.__hueGap(ramp[3], ramp[2])),
        lum: ramp.map((c) => Math.round(window.__lum(window.__rgb(c)) * 10000) / 10000),
      };
    };
    true;
  `);

  // ---- structure -------------------------------------------------------
  const structure = await js(`(() => {
    const rows = [...document.querySelectorAll('.rows:not([hidden]) li.row[data-provider]')];
    return {
      lists: document.querySelectorAll('ul.rows:not([hidden])').length,
      ids: rows.map(r => r.dataset.provider),
      connected: rows.map(r => r.dataset.connected),
      posinset: rows.map(r => r.getAttribute('aria-posinset')),
      setsize: rows.map(r => r.getAttribute('aria-setsize')),
      grips: rows.map(r => !!r.querySelector('button.grip')),
      marks: rows.map(r => r.querySelectorAll('svg.mark path, svg.mark circle').length),
      spines: document.querySelectorAll('.row__spine').length,
      monos: document.querySelectorAll('.mono').length,
      meters: rows.map(r => r.querySelectorAll('.rail').length),
      trayDots: rows.map(r => r.querySelector('.grip')?.dataset.tray || null),
      gripLabels: rows.map(r => r.querySelector('.grip')?.getAttribute('aria-label')),
      describedby: rows.map(r => r.querySelector('.grip')?.getAttribute('aria-describedby')),
      helpText: (document.getElementById('reorder-help')||{}).textContent || null,
      liveRegion: !!document.querySelector('p.rows__live[role="status"][aria-live="polite"]'),
    };
  })()`);

  check('one row list, not two', structure.lists === 1, structure.lists);
  check('all six providers rendered in snapshot order',
    JSON.stringify(structure.ids) === JSON.stringify(['claude','codex','gemini','copilot','antigravity','kimi']),
    structure.ids);
  check('data-connected reflects the contract flag',
    JSON.stringify(structure.connected) === JSON.stringify(['true','true','false','false','false','false']),
    structure.connected);
  check('aria-posinset is 1..6', JSON.stringify(structure.posinset) === JSON.stringify(['1','2','3','4','5','6']), structure.posinset);
  check('aria-setsize is 6 everywhere', structure.setsize.every(v => v === '6'), structure.setsize);
  check('every row has a grip button', structure.grips.every(Boolean));
  check('every row has a drawn mark (>=1 shape)', structure.marks.every(n => n >= 1), structure.marks);
  check('the brand spine element is gone', structure.spines === 0, structure.spines);
  check('the monogram tile is gone', structure.monos === 0, structure.monos);
  check('unconnected rows draw no meter', structure.meters.slice(2).every(n => n === 0), structure.meters);
  check('connected rows draw a meter', structure.meters.slice(0,2).every(n => n >= 1), structure.meters);
  check('only row 0 is marked as the tray row',
    structure.trayDots[0] === 'true' && structure.trayDots.slice(1).every(v => !v), structure.trayDots);
  check('grip aria-labels are Turkish and name the provider',
    structure.gripLabels[0] === 'Claude Code: sırayı değiştir', structure.gripLabels[0]);
  check('grips are described by the reorder help', structure.describedby.every(v => v === 'reorder-help'));
  check('reorder help mentions the Alt keys', /Alt/.test(structure.helpText || ''), structure.helpText);
  check('a polite live region exists', structure.liveRegion);

  // ---- colour treatment -------------------------------------------------
  const colours = await js(`(() => {
    const pick = (id) => {
      const row = document.querySelector('li.row[data-provider="' + id + '"]');
      const grip = row.querySelector('.grip');
      const mark = row.querySelector('svg.mark');
      const cs = getComputedStyle(mark);
      const gs = getComputedStyle(grip);
      return { color: cs.color, strokeWidth: cs.strokeWidth, opacity: cs.opacity,
               tile: gs.backgroundColor, border: gs.borderTopColor,
               w: mark.getBoundingClientRect().width };
    };
    return { claude: pick('claude'), codex: pick('codex'), gemini: pick('gemini'), kimi: pick('kimi') };
  })()`);
  say('colours: ' + JSON.stringify(colours));
  check('connected claude mark is its brand hex', colours.claude.color === 'rgb(201, 100, 66)', colours.claude.color);
  check('connected codex mark is its brand hex', colours.codex.color === 'rgb(16, 163, 127)', colours.codex.color);
  check('unconnected gemini mark is ink, not brand', colours.gemini.color === 'rgb(107, 122, 119)', colours.gemini.color);
  check('unconnected kimi mark is ink, not brand', colours.kimi.color === 'rgb(107, 122, 119)', colours.kimi.color);
  check('connected stroke is heavier than unconnected',
    parseFloat(colours.claude.strokeWidth) > parseFloat(colours.gemini.strokeWidth),
    [colours.claude.strokeWidth, colours.gemini.strokeWidth]);
  check('connected mark is at full opacity, unconnected is not',
    parseFloat(colours.claude.opacity) === 1 && parseFloat(colours.gemini.opacity) < 1,
    [colours.claude.opacity, colours.gemini.opacity]);
  check('connected tile has a ground, unconnected does not',
    colours.claude.tile !== 'rgba(0, 0, 0, 0)' && colours.gemini.tile === 'rgba(0, 0, 0, 0)',
    [colours.claude.tile, colours.gemini.tile]);
  check('marks render at 20-24px', colours.claude.w === 24 && colours.gemini.w === 20,
    [colours.claude.w, colours.gemini.w]);

  // ---- the weekly window is a first-class figure -------------------------
  // It used to be a 2px hairline under the five-hour rail with no percentage
  // and no reset time anywhere, and the user's report was that the app did not
  // show weekly usage at all. Everything below asserts the two windows are
  // drawn to the SAME spec: same bar, same figure size, same countdown.
  const wins = await js(`(() => {
    const blocks = (id) => [...document.querySelectorAll(
      'li.row[data-provider="' + id + '"] .win')];
    const read = (b) => {
      const rail = b.querySelector('.rail');
      const pct = b.querySelector('.win__pct');
      const cs = getComputedStyle(pct);
      return {
        kind: b.dataset.win,
        state: b.dataset.state || null,
        label: b.querySelector('.win__label').textContent,
        pct: pct.textContent,
        pctSize: cs.fontSize,
        pctWeight: cs.fontWeight,
        pctColor: cs.color,
        hasRail: !!rail,
        railH: rail ? Math.round(rail.getBoundingClientRect().height) : null,
        fill: rail ? getComputedStyle(rail.querySelector('.rail__fill')).backgroundColor : null,
        f: rail ? rail.querySelector('.rail__fill').style.getPropertyValue('--f') : null,
        reset: (b.querySelector('.win__reset') || {}).textContent || null,
        valuetext: rail ? rail.getAttribute('aria-valuetext') : null,
      };
    };
    return {
      claude: blocks('claude').map(read),
      codex: blocks('codex').map(read),
      namePct: document.querySelectorAll('li.row[data-provider="claude"] .row__line .row__pct').length,
    };
  })()`);
  say('windows: ' + JSON.stringify(win));

  check('the weekly window gets a block of its own, beside the five-hour one',
    JSON.stringify(wins.claude.map(b => b.kind)) === JSON.stringify(['5h', '7d']),
    wins.claude.map(b => b.kind));
  check('both blocks name their window in Turkish, with no uppercasing',
    wins.claude[0].label === '5 saatlik pencere' && wins.claude[1].label === 'Haftalık pencere',
    wins.claude.map(b => b.label));
  check('the weekly block prints its own percentage, sign first',
    wins.claude[1].pct === '%24' && wins.claude[0].pct === '%62',
    wins.claude.map(b => b.pct));
  check('the weekly figure is set at the same size and weight as the five-hour one',
    wins.claude[0].pctSize === wins.claude[1].pctSize &&
    wins.claude[0].pctWeight === wins.claude[1].pctWeight,
    wins.claude.map(b => [b.pctSize, b.pctWeight]));
  check('the weekly bar is the same height as the five-hour bar, not a hairline',
    wins.claude[0].railH === wins.claude[1].railH && wins.claude[1].railH >= 6,
    wins.claude.map(b => b.railH));
  check('each bar is filled to its own value',
    wins.claude[0].f === '0.6200' && wins.claude[1].f === '0.2400',
    wins.claude.map(b => b.f));
  check('the weekly block prints its own reset countdown',
    /kald/.test(wins.claude[1].reset || ''), wins.claude[1].reset);

  // The ramp is per window, from the ROUNDED value. 62 is watch, 24 is calm;
  // one row-wide colour would have painted the weekly bar amber for pressure
  // that belongs to a different window.
  check('the state ramp is derived per window, not once per row',
    wins.claude[0].state === 'watch' && wins.claude[1].state === 'calm',
    wins.claude.map(b => b.state));
  check('and the two bars therefore resolve to different ramp colours',
    wins.claude[0].fill === 'rgb(224, 168, 69)' && wins.claude[1].fill === 'rgb(63, 184, 158)',
    wins.claude.map(b => b.fill));
  check('the figure takes the same ramp colour as its own bar',
    wins.claude[0].pctColor === wins.claude[0].fill && wins.claude[1].pctColor === wins.claude[1].fill,
    wins.claude.map(b => [b.pctColor, b.fill]));

  check('a provider that reports no weekly window draws no weekly block',
    wins.codex.length === 1 && wins.codex[0].kind === '5h', wins.codex.map(b => b.kind));
  check('the name line no longer carries a percentage of its own',
    wins.namePct === 0, wins.namePct);
  check('each bar still speaks its own window to a screen reader',
    /Beş saatlik/.test(wins.claude[0].valuetext || '') &&
    /Haftalık/.test(wins.claude[1].valuetext || ''),
    wins.claude.map(b => b.valuetext));

  // ---- a window we cannot measure says so; it does not disappear ---------
  // The reference layout this composition came from has no vocabulary for "we
  // cannot say". Ours must keep it, and it must keep it VISIBLY: an omitted
  // line is what made the weekly window read as an unimplemented feature.
  const original = await js(`window.__probe.windowsOf('claude')`);
  await js(`window.__probe.setWindowsDirect('claude', { sevenDay: {
    usedPercentage: null, certainty: 'unknown',
    resetsAt: ${JSON.stringify(original.sevenDay.resetsAt)}, capturedAt: null } })`);
  await sleep(160);
  const unknown = await js(`(() => {
    const row = document.querySelector('li.row[data-provider="claude"]');
    const blocks = [...row.querySelectorAll('.win')];
    const weekly = blocks[1];
    return {
      blocks: blocks.map(b => b.dataset.win),
      label: weekly.querySelector('.win__label').textContent,
      pct: weekly.querySelector('.win__pct').textContent,
      none: weekly.querySelector('.win__pct').classList.contains('win__pct--none'),
      pctColor: getComputedStyle(weekly.querySelector('.win__pct')).color,
      rails: weekly.querySelectorAll('.rail').length,
      meters: weekly.querySelectorAll('[role="meter"]').length,
      state: weekly.dataset.state || null,
      reset: (weekly.querySelector('.win__reset') || {}).textContent || null,
      spoken: weekly.getAttribute('aria-label'),
      fiveStillDrawn: blocks[0].querySelectorAll('.rail').length,
    };
  })()`);
  say('unknown weekly: ' + JSON.stringify(unknown));

  check('an unknown weekly window still gets a block, so it is not read as absent',
    JSON.stringify(unknown.blocks) === JSON.stringify(['5h', '7d']), unknown.blocks);
  check('it names the window and says it cannot say',
    unknown.label === 'Haftalık pencere' && unknown.pct === 'bilinmiyor', unknown);
  check('it draws NO bar and NO meter role', unknown.rails === 0 && unknown.meters === 0, unknown);
  check('it takes no state-ramp colour, because "unknown" is not a level',
    unknown.state === null && unknown.pctColor === 'rgb(107, 122, 119)',
    [unknown.state, unknown.pctColor]);
  check('the reset instant survives: when it rolls over is knowable even when the share is not',
    /kald/.test(unknown.reset || ''), unknown.reset);
  check('a screen reader hears the gap stated, not silence',
    /bilinmiyor/.test(unknown.spoken || ''), unknown.spoken);
  check('the five-hour window beside it is untouched', unknown.fiveStillDrawn === 1, unknown);

  await js(`window.__probe.setWindowsDirect('claude', ${JSON.stringify(original)})`);
  await sleep(160);
  check('the fixture is back at the state the next section expects',
    (await js(`document.querySelector('li.row[data-provider="claude"] .win--7d .win__pct').textContent`)) === '%24');

  // ---- "we cannot say" and "it is not published" are different claims ----
  //
  // The contract carries five machine-readable reasons a window has no figure.
  // The panel deliberately collapses them to THREE wordings — five
  // near-synonyms in an 11px slot would be five things to learn and four of
  // them would say the same thing about what to do next. What earns a split is
  // a difference the user can act on, or catch us being wrong about.
  //
  // 'not-supplied' is the one that had to be split. The Antigravity IDE store
  // carries no weekly figure while Antigravity's own UI shows the user a
  // weekly limit, so "bilinmiyor" is falsifiable on their own screen. The tray
  // tooltip already said "bildirilmiyor" for this state and the panel said
  // "bilinmiyor", so the two surfaces disagreed about one fact.
  await js(`window.__probe.setWindowsDirect('claude', { sevenDay: {
    usedPercentage: null, certainty: 'unknown', absence: 'not-supplied',
    resetsAt: null, capturedAt: null } })`);
  await sleep(160);
  const notSupplied = await js(`(() => {
    const row = document.querySelector('li.row[data-provider="claude"]');
    const blocks = [...row.querySelectorAll('.win')];
    const weekly = blocks[1];
    const foot = weekly.querySelector('.win__foot');
    const reason = weekly.querySelector('.win__reason');
    return {
      label: weekly.querySelector('.win__label').textContent,
      pct: weekly.querySelector('.win__pct').textContent,
      none: weekly.querySelector('.win__pct').classList.contains('win__pct--none'),
      rails: weekly.querySelectorAll('.rail').length,
      state: weekly.dataset.state || null,
      footHidden: foot.hidden,
      resetHidden: weekly.querySelector('.win__reset').hidden,
      reason: reason ? reason.textContent : null,
      reasonHidden: reason ? reason.hidden : null,
      reasonVisible: reason ? getComputedStyle(reason).display !== 'none' : null,
      spoken: weekly.getAttribute('aria-label'),
      fiveStillDrawn: blocks[0].querySelectorAll('.rail').length,
    };
  })()`);
  say('not-supplied: ' + JSON.stringify(notSupplied));

  check('a window the tool does not publish reads "bildirilmiyor", not "bilinmiyor"',
    notSupplied.pct === 'bildirilmiyor', notSupplied.pct);
  check('and the panel now says the same word the tray tooltip does',
    notSupplied.pct === 'bildirilmiyor', notSupplied.pct);
  check('the window is still named, so the absence is stated and not a missing line',
    notSupplied.label === 'Haftalık pencere', notSupplied.label);
  check('it still draws no bar and takes no ramp colour',
    notSupplied.rails === 0 && notSupplied.state === null, notSupplied);

  // The cause is the point. An absence with no stated cause is
  // indistinguishable from the app being broken, which is the collision this
  // project keeps finding.
  check('the cause is printed under the block',
    /yayımlamıyor/.test(notSupplied.reason || ''), notSupplied.reason);
  check('the reason line is actually on screen, not merely in the DOM',
    notSupplied.reasonHidden === false && notSupplied.reasonVisible === true, notSupplied);
  // The old foot-collapse predicate named `reset` and `asOf` explicitly, so a
  // third child would have been swallowed whenever the first two were hidden —
  // which is EXACTLY this state: no figure and no reset instant.
  check('the foot survives with no countdown in it, which is the case it exists for',
    notSupplied.footHidden === false && notSupplied.resetHidden === true, notSupplied);
  check('and a screen reader hears the cause too, not just the gap',
    /yayımlamıyor/.test(notSupplied.spoken || ''), notSupplied.spoken);
  check('the five-hour window beside it is untouched',
    notSupplied.fiveStillDrawn === 1, notSupplied);

  // 'rolled-over' follows the tray tooltip's existing precedent: it chose
  // "yenileniyor" over "bilinmiyor" because the cause is known and is the
  // thing the user is most likely checking. No reason line — the countdown
  // beside it already carries the whole answer.
  await js(`window.__probe.setWindowsDirect('claude', { sevenDay: {
    usedPercentage: null, certainty: 'unknown', absence: 'rolled-over',
    resetsAt: null, capturedAt: null } })`);
  await sleep(160);
  const rolled = await js(`(() => {
    const weekly = [...document.querySelectorAll('li.row[data-provider="claude"] .win')][1];
    const reason = weekly.querySelector('.win__reason');
    return {
      pct: weekly.querySelector('.win__pct').textContent,
      reasonHidden: reason ? reason.hidden : null,
      footHidden: weekly.querySelector('.win__foot').hidden,
      spoken: weekly.getAttribute('aria-label'),
    };
  })()`);
  say('rolled-over: ' + JSON.stringify(rolled));
  check('a window that has already reset says so, following the tooltip precedent',
    rolled.pct === 'yenileniyor', rolled.pct);
  check('it carries no reason line: the word already is the reason',
    rolled.reasonHidden === true && rolled.footHidden === true, rolled);
  check('the spoken sentence matches the printed word rather than drifting from it',
    /yenileniyor/.test(rolled.spoken || ''), rolled.spoken);

  // The other three collapse to today's wording. 'stale' in particular does
  // NOT get its own line: the row already states it, better, one line down —
  // `row__stale` prints "112 gün önce güncellendi", with the real duration,
  // repainted every second. A second word for it in the figure slot would be
  // the same fact twice and the worse copy of the two.
  for (const absence of ['stale', 'unreadable', 'no-capture']) {
    await js(`window.__probe.setWindowsDirect('claude', { sevenDay: {
      usedPercentage: null, certainty: 'unknown', absence: ${JSON.stringify(absence)},
      resetsAt: null, capturedAt: null } })`);
    await sleep(140);
    const collapsed = await js(`(() => {
      const weekly = [...document.querySelectorAll('li.row[data-provider="claude"] .win')][1];
      const reason = weekly.querySelector('.win__reason');
      return { pct: weekly.querySelector('.win__pct').textContent,
               reasonHidden: reason ? reason.hidden : null };
    })()`);
    check('"' + absence + '" keeps the existing wording rather than minting a synonym',
      collapsed.pct === 'bilinmiyor' && collapsed.reasonHidden === true, [absence, collapsed]);
  }

  // A reason main never sent must not become the strongest claim available.
  // 'not-supplied' asserts "this tool does not publish this limit", which the
  // user can disprove by opening the tool; the fallback has to be the value
  // that asserts least.
  await js(`window.__probe.setWindowsDirect('claude', { sevenDay: {
    usedPercentage: null, certainty: 'unknown', absence: 'uydurma',
    resetsAt: null, capturedAt: null } })`);
  await sleep(140);
  check('an unrecognised reason degrades to "bilinmiyor", never to "bildirilmiyor"',
    (await js(`document.querySelector('li.row[data-provider="claude"] .win--7d .win__pct').textContent`))
      === 'bilinmiyor');

  await js(`window.__probe.setWindowsDirect('claude', ${JSON.stringify(original)})`);
  await sleep(160);
  check('the fixture is back where the next section expects it',
    (await js(`document.querySelector('li.row[data-provider="claude"] .win--7d .win__pct').textContent`)) === '%24');

  // ---- a stale capture still names the instant it was true ---------------
  // ADR-001 amendment 2. The "as of" label used to sit on the row's name line,
  // where it qualified whichever window happened to be primary and said nothing
  // about the other. It now sits in the foot of the block it belongs to.
  await js(`window.__probe.setWindowsDirect('claude', { status: 'stale', fiveHour: {
    usedPercentage: 62, certainty: 'known',
    resetsAt: ${JSON.stringify(original.fiveHour.resetsAt)},
    capturedAt: new Date(Date.now() - 47 * 60000).toISOString() } })`);
  await sleep(160);
  const staleCap = await js(`(() => {
    const b = document.querySelector('li.row[data-provider="claude"] .win--5h');
    const asOf = b.querySelector('.win__asof');
    return {
      pct: b.querySelector('.win__pct').textContent,
      asOf: asOf ? asOf.textContent : null,
      asOfOpacity: asOf ? getComputedStyle(asOf).opacity : null,
      pctOpacity: getComputedStyle(b.querySelector('.win__pct')).opacity,
      inFoot: !!(asOf && asOf.closest('.win__foot')),
      onNameLine: document.querySelectorAll('li.row[data-provider="claude"] .row__line .row__asof').length,
    };
  })()`);
  say('stale capture: ' + JSON.stringify(staleCap));
  check('a stale capture keeps its figure', staleCap.pct === '%62', staleCap.pct);
  check('and never shows it without the instant it was measured',
    /itibarıyla/.test(staleCap.asOf || ''), staleCap.asOf);
  check('the instant sits in that window block, not on the row name line',
    staleCap.inFoot === true && staleCap.onNameLine === 0, staleCap);
  check('the figure dims but the instant qualifying it does not',
    parseFloat(staleCap.pctOpacity) < 1 && parseFloat(staleCap.asOfOpacity) === 1,
    [staleCap.pctOpacity, staleCap.asOfOpacity]);

  await js(`window.__probe.setWindowsDirect('claude', Object.assign({ status: 'ok' }, ${JSON.stringify(original)}))`);
  await sleep(160);

  // ---- the layout has to survive six added providers --------------------
  // Two window blocks per provider is a lot taller than the twin-track meter
  // was. What keeps that from turning the panel into a scroll tunnel is that
  // row height tracks what the row actually REPORTS, and that the list — not
  // the window — absorbs the overflow.
  const heights = await js(`(() => {
    const band = document.querySelector('.panel__band--list');
    const cs = getComputedStyle(band);
    const h = (id) => Math.round(document.querySelector(
      'li.row[data-provider="' + id + '"]').getBoundingClientRect().height);
    const panel = document.querySelector('.panel').getBoundingClientRect();
    return {
      two: h('claude'), one: h('codex'), none: h('gemini'),
      maxHeight: cs.maxHeight, overflow: cs.overflowY,
      panelTop: panel.top, panelBottom: panel.bottom,
      canvas: document.documentElement.clientHeight,
    };
  })()`);
  say('heights: ' + JSON.stringify(heights));
  check('a row is exactly as tall as what it reports: two windows > one > none',
    heights.two > heights.one && heights.one > heights.none,
    [heights.two, heights.one, heights.none]);
  check('the list is a bounded scroller, so rows never push the panel off screen',
    /px$/.test(heights.maxHeight) && heights.overflow === 'auto',
    [heights.maxHeight, heights.overflow]);
  check('and the panel itself stays inside the canvas with all six added',
    heights.panelTop >= 0 && heights.panelBottom <= heights.canvas,
    [heights.panelTop, heights.panelBottom, heights.canvas]);

  // ---- keyboard reorder -------------------------------------------------
  const kb = await js(`(() => {
    const grip = document.querySelector('li.row[data-provider="codex"] .grip');
    grip.focus();
    const focused = document.activeElement === grip;
    grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }));
    return { focused };
  })()`);
  check('the grip takes focus', kb.focused);
  await sleep(250);
  let probe = await js('window.__probe.calls()');
  check('Alt+ArrowUp called setOrder with codex first',
    probe.setOrder.length === 1 && probe.setOrder[0][0] === 'codex', probe.setOrder);
  let after = await js(`(() => ({
    ids: [...document.querySelectorAll('li.row[data-provider]')].map(r=>r.dataset.provider),
    live: document.querySelector('p.rows__live[role="status"][aria-live="polite"]').textContent,
    tray: [...document.querySelectorAll('ul.rows:not([hidden]) .grip')].map(g=>g.dataset.tray||null),
    focus: document.activeElement.getAttribute('aria-label'),
  }))()`);
  check('the DOM moved codex to the top', after.ids[0] === 'codex', after.ids);
  check('the move was announced with position and tray consequence',
    /1\. sıraya taşındı/.test(after.live) && /Tepsi/.test(after.live), after.live);
  check('the tray marker followed the move', after.tray[0] === 'true' && !after.tray[1], after.tray);
  check('focus stayed on the moved row grip', after.focus === 'Codex: sırayı değiştir', after.focus);

  const edge = await js(`(() => {
    const grip = document.querySelector('li.row[data-provider="codex"] .grip');
    grip.focus();
    grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }));
    return document.querySelector('p.rows__live[role="status"][aria-live="polite"]').textContent;
  })()`);
  check('a move past the top is refused and announced', /zaten en üstte/.test(edge), edge);

  const noAlt = await js(`(() => {
    const before = [...document.querySelectorAll('li.row[data-provider]')].map(r=>r.dataset.provider).join(',');
    const grip = document.querySelector('li.row[data-provider="claude"] .grip');
    grip.focus();
    grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    return { before, after: [...document.querySelectorAll('li.row[data-provider]')].map(r=>r.dataset.provider).join(',') };
  })()`);
  check('a bare ArrowDown does not reorder', noAlt.before === noAlt.after, noAlt);

  // ---- passive rows are draggable too -----------------------------------
  const passiveMove = await js(`(() => {
    const grip = document.querySelector('li.row[data-provider="kimi"] .grip');
    grip.focus();
    grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', altKey: true, bubbles: true, cancelable: true }));
    return document.querySelector('p.rows__live[role="status"][aria-live="polite"]').textContent;
  })()`);
  await sleep(250);
  const passiveAfter = await js(`[...document.querySelectorAll('li.row[data-provider]')].map(r=>r.dataset.provider)`);
  check('a passive row can be moved to the top', passiveAfter[0] === 'kimi', passiveAfter);
  check('the passive move announced the tray consequence', /Tepsi/.test(passiveMove), passiveMove);
  const trayGrip = await js(`document.querySelector('li.row[data-provider="kimi"] .grip').getAttribute('title')`);
  check('the tray title is honest about a disconnected top row',
    /veri çizilmiyor/.test(trayGrip), trayGrip);

  // ---- failure reverts visibly ------------------------------------------
  await js('window.__probe.setFailOrder(true)');
  const beforeFail = await js(`[...document.querySelectorAll('li.row[data-provider]')].map(r=>r.dataset.provider)`);
  await js(`(() => {
    const grip = document.querySelector('li.row[data-provider="claude"] .grip');
    grip.focus();
    grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', altKey: true, bubbles: true, cancelable: true }));
  })()`);
  await sleep(60);
  const optimistic = await js(`[...document.querySelectorAll('li.row[data-provider]')].map(r=>r.dataset.provider)`);
  check('the row moves optimistically before main answers', optimistic[0] === 'claude', optimistic);
  // The fixture's failing setOrder resolves after 400ms. A 500ms wait left
  // 100ms of margin, and under load that ran out — the revert had not landed,
  // this check failed, and the drag session, the switch states and the pin
  // colours below it all failed with it. The extra margin is free: what is
  // being waited on is the mock's own delay, not a render.
  await sleep(900);
  const reverted = await js(`(() => ({
    ids: [...document.querySelectorAll('li.row[data-provider]')].map(r=>r.dataset.provider),
    notice: (document.querySelector('.notice:not([hidden])')||{}).textContent || null,
  }))()`);
  check('a failed setOrder reverts the order',
    JSON.stringify(reverted.ids) === JSON.stringify(beforeFail), [beforeFail, reverted.ids]);
  check('a failed setOrder says so, it does not fail silently',
    /kaydedilemedi/.test(reverted.notice || ''), reverted.notice);
  await js('window.__probe.setFailOrder(false)');

  // ---- pointer drag, via real OS-level input ---------------------------
  const geom = await js(`(() => {
    const rows = [...document.querySelectorAll('li.row[data-provider]')];
    const g = rows[0].querySelector('.grip').getBoundingClientRect();
    const listTop = rows[0].getBoundingClientRect().top;
    return { ids: rows.map(r=>r.dataset.provider),
             x: Math.round(g.left + g.width/2), y: Math.round(g.top + g.height/2),
             t: rows.map(r => Math.round(r.getBoundingClientRect().top - listTop)),
             h: rows.map(r => Math.round(r.getBoundingClientRect().height)) };
  })()`);
  const wc = win.webContents;
  const move = (x, y) => wc.sendInputEvent({ type: 'mouseMove', x, y, button: 'left', buttons: 1 });
  wc.sendInputEvent({ type: 'mouseMove', x: geom.x, y: geom.y });
  await sleep(40);
  wc.sendInputEvent({ type: 'mouseDown', x: geom.x, y: geom.y, button: 'left', clickCount: 1 });
  await sleep(40);

  // Two places down means the dragged row's CENTRE has to clear the MIDPOINT OF
  // ROW 2 AS IT IS DRAWN. Rows are not uniform — measured here as
  // [88, 42, 139, 42, 42, 42] — so the distance is derived from the layout
  // rather than assumed to be "two rows".
  //
  // This used to be `h[1] + h[2]/2 - h[0]/2`, which is the distance in the
  // COMPACTED layout: the list as if the dragged row had already been lifted
  // out. That is the same coordinate-system confusion that produced the bug in
  // `targetIndex`, encoded a second time in the test that was supposed to
  // catch it — which is why the check passed against the broken algorithm and
  // would have failed against the correct one. The distance is now the plain
  // difference between two midpoints in one coordinate system.
  const drop = Math.round(geom.t[2] + geom.h[2] / 2 - (geom.t[0] + geom.h[0] / 2)) + 8;
  for (let i = 1; i <= 8; i++) {
    move(geom.x, geom.y + Math.round((drop * i) / 8));
    await sleep(25);
  }
  const mid = await js(`(() => {
    const rows=[...document.querySelectorAll('li.row[data-provider]')];
    return { dragging: document.querySelector('ul.rows:not([hidden])').getAttribute('data-dragging'),
             lifted: rows[0].classList.contains('is-dragging'),
             transforms: rows.map(r => r.style.transform || '') };
  })()`);
  check('a real mouse drag starts a drag session', mid.dragging === 'true' && mid.lifted, mid);
  check('rows below the dragged one shift out of the way',
    mid.transforms.slice(1, 3).some(t => t.includes('translateY')), mid.transforms);
  wc.sendInputEvent({ type: 'mouseUp', x: geom.x, y: geom.y + drop, button: 'left', clickCount: 1 });
  await sleep(400);
  probe = await js('window.__probe.calls()');
  const dropped = await js(`(() => ({
    ids: [...document.querySelectorAll('li.row[data-provider]')].map(r=>r.dataset.provider),
    transforms: [...document.querySelectorAll('li.row[data-provider]')].map(r => r.style.transform || ''),
    live: document.querySelector('p.rows__live[role="status"][aria-live="polite"]').textContent,
    dragging: document.querySelector('ul.rows:not([hidden])').getAttribute('data-dragging'),
  }))()`);
  check('the drop moved the row two places down',
    dropped.ids[2] === geom.ids[0], [geom.ids, dropped.ids]);
  check('the drop persisted through setOrder',
    probe.setOrder.length >= 2 && JSON.stringify(probe.setOrder[probe.setOrder.length-1]) === JSON.stringify(dropped.ids),
    probe.setOrder[probe.setOrder.length-1]);
  check('every transform is cleared after the drop', dropped.transforms.every(t => t === ''), dropped.transforms);
  check('the dragging flag is cleared', dropped.dragging === null, dropped.dragging);
  check('the drop was announced', /sıraya taşındı/.test(dropped.live), dropped.live);
  check('panelOpened was re-sent during the interaction (auto-hide keep-alive)',
    probe.panelOpened > 1, probe.panelOpened);

  // ---- Escape during a drag aborts the drag, not the panel --------------
  const before2 = await js(`[...document.querySelectorAll('li.row[data-provider]')].map(r=>r.dataset.provider)`);
  const g2 = await js(`(() => { const g = document.querySelector('li.row[data-provider]').querySelector('.grip').getBoundingClientRect();
    return { x: Math.round(g.left+g.width/2), y: Math.round(g.top+g.height/2) }; })()`);
  wc.sendInputEvent({ type: 'mouseMove', x: g2.x, y: g2.y });
  wc.sendInputEvent({ type: 'mouseDown', x: g2.x, y: g2.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 5; i++) { move(g2.x, g2.y + i * 14); await sleep(25); }
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
  await sleep(200);
  wc.sendInputEvent({ type: 'mouseUp', x: g2.x, y: g2.y + 70, button: 'left', clickCount: 1 });
  await sleep(300);
  const esc = await js(`(() => ({
    ids: [...document.querySelectorAll('li.row[data-provider]')].map(r=>r.dataset.provider),
    live: document.querySelector('p.rows__live[role="status"][aria-live="polite"]').textContent,
  }))()`);
  probe = await js('window.__probe.calls()');
  check('Escape aborts the drag without reordering',
    JSON.stringify(esc.ids) === JSON.stringify(before2), [before2, esc.ids]);
  check('Escape during a drag does not close the panel', probe.close === 0, probe.close);
  check('the abort was announced', /iptal edildi/.test(esc.live), esc.live);

  // ---- dragging UP, across a boundary between rows of different heights --
  //
  // The user's report was directional: "I can drag Antigravity down and get
  // Claude to the top, but when Claude is lower down I can't drag it up — it
  // throws it back down." Every drag check above this line drags DOWN, which
  // is the half that worked, so the whole suite passed through the bug.
  //
  // The cause was `targetIndex` mixing an original-layout centre with
  // compacted-layout thresholds. Those agree only when rows are all the same
  // height, so the first thing asserted here is that the fixture is NOT
  // uniform — otherwise this section would pass against the broken algorithm
  // too, which is exactly how the defect survived.
  await js(`window.__probe.setOrderDirect(${JSON.stringify(before2)})`);
  await sleep(200);
  const shape = await js(`(() => {
    const rows = [...document.querySelectorAll('li.row[data-provider]')];
    return { ids: rows.map(r => r.dataset.provider),
             h: rows.map(r => Math.round(r.getBoundingClientRect().height)) };
  })()`);
  say('row shape: ' + JSON.stringify(shape));
  check('the fixture has rows of DIFFERENT heights, or this section proves nothing',
    new Set(shape.h).size > 1, shape.h);

  // Pick the second row up and put it down again without crossing anything.
  // `targetIndex(dy = 0) === from` is the invariant that actually broke: row 1
  // of a [64, 64, 44, ...] panel computed a target of 2 before the pointer had
  // moved, so the row fell a slot on pick-up. Through real input that shows up
  // as an order change from a gesture that went nowhere.
  const g3 = await js(`(() => {
    const g = [...document.querySelectorAll('li.row[data-provider]')][1]
      .querySelector('.grip').getBoundingClientRect();
    return { x: Math.round(g.left + g.width / 2), y: Math.round(g.top + g.height / 2) };
  })()`);
  wc.sendInputEvent({ type: 'mouseMove', x: g3.x, y: g3.y });
  await sleep(40);
  wc.sendInputEvent({ type: 'mouseDown', x: g3.x, y: g3.y, button: 'left', clickCount: 1 });
  await sleep(40);
  // Past DRAG_THRESHOLD so a real drag starts, but nowhere near a midpoint.
  for (const step of [6, 8, 6]) { move(g3.x, g3.y + step); await sleep(30); }
  wc.sendInputEvent({ type: 'mouseUp', x: g3.x, y: g3.y + 6, button: 'left', clickCount: 1 });
  await sleep(400);
  const nudged = await js(`[...document.querySelectorAll('li.row[data-provider]')].map(r=>r.dataset.provider)`);
  check('picking a row up and setting it back down does not reorder anything',
    JSON.stringify(nudged) === JSON.stringify(shape.ids), [shape.ids, nudged]);

  // Now the reported gesture: the second row, dragged up over the first.
  // The distance is half my own height plus half of the row above me — the
  // point at which my centre reaches their midpoint — derived from the
  // measured heights rather than assumed, because they differ.
  const up = Math.round(shape.h[1] / 2 + shape.h[0] / 2) + 8;
  const g4 = await js(`(() => {
    const g = [...document.querySelectorAll('li.row[data-provider]')][1]
      .querySelector('.grip').getBoundingClientRect();
    return { x: Math.round(g.left + g.width / 2), y: Math.round(g.top + g.height / 2) };
  })()`);
  wc.sendInputEvent({ type: 'mouseMove', x: g4.x, y: g4.y });
  await sleep(40);
  wc.sendInputEvent({ type: 'mouseDown', x: g4.x, y: g4.y, button: 'left', clickCount: 1 });
  await sleep(40);
  for (let i = 1; i <= 8; i++) { move(g4.x, g4.y - Math.round((up * i) / 8)); await sleep(25); }
  const upMid = await js(`(() => {
    const rows = [...document.querySelectorAll('li.row[data-provider]')];
    return { dragging: document.querySelector('ul.rows:not([hidden])').getAttribute('data-dragging'),
             lifted: rows[1].classList.contains('is-dragging'),
             topShifted: /translateY/.test(rows[0].style.transform || '') };
  })()`);
  check('an upward drag starts a session too', upMid.dragging === 'true' && upMid.lifted, upMid);
  check('the row above moves DOWN out of the way, which is the half that never worked',
    upMid.topShifted === true, upMid);
  wc.sendInputEvent({ type: 'mouseUp', x: g4.x, y: g4.y - up, button: 'left', clickCount: 1 });
  await sleep(400);
  const upDropped = await js(`(() => ({
    ids: [...document.querySelectorAll('li.row[data-provider]')].map(r=>r.dataset.provider),
    live: document.querySelector('p.rows__live[role="status"][aria-live="polite"]').textContent,
  }))()`);
  say('up-drag: ' + JSON.stringify([shape.ids, upDropped.ids]));
  check('a drag up of one boundary lands the row exactly one slot higher',
    upDropped.ids[0] === shape.ids[1] && upDropped.ids[1] === shape.ids[0],
    [shape.ids, upDropped.ids]);
  check('and it is announced as reaching the top, which the tray follows',
    /1\. sıraya taşındı/.test(upDropped.live) && /Tepsi/.test(upDropped.live), upDropped.live);

  await js(`window.__probe.setOrderDirect(${JSON.stringify(before2)})`);
  await sleep(200);

  // ---- the settings view -----------------------------------------------
  // A user can add or remove PROVIDER ROWS here. Adding is not connecting:
  // an added-but-unconnected provider still belongs in the main panel with
  // its setup action, and this view must never imply otherwise.
  const gear = await js(`(() => {
    const b = document.querySelector('.hdr__actions .iconbtn--settings');
    return b ? { label: b.getAttribute('aria-label'), expanded: b.getAttribute('aria-expanded'),
                 controls: b.getAttribute('aria-controls'), shapes: b.querySelectorAll('svg path, svg circle').length }
             : null;
  })()`);
  check('a settings button sits in the header', gear !== null && gear.label === 'Ayarlar', gear);
  check('the settings button is described as a view switch, not a toggle button',
    gear && gear.expanded === 'false' && gear.controls === 'settings-view', gear);
  check('the settings button has a drawn mark', gear && gear.shapes >= 3, gear && gear.shapes);

  await js(`document.querySelector('.iconbtn--settings').click()`);
  await sleep(120);
  const settings = await js(`(() => {
    const view = document.getElementById('settings-view');
    const items = [...view.querySelectorAll('li.settings__item')];
    return {
      visible: !!view && !view.hidden,
      rowsHidden: document.querySelector('ul.rows.rows, ul.rows') ? [...document.querySelectorAll('ul.rows')].every(l => l.hidden) : null,
      expanded: document.querySelector('.iconbtn--settings').getAttribute('aria-expanded'),
      ids: items.map(i => i.dataset.provider),
      marks: items.map(i => i.querySelectorAll('svg.mark path, svg.mark circle').length),
      switches: items.map(i => {
        const s = i.querySelector('button.switch');
        return s ? { role: s.getAttribute('role'), checked: s.getAttribute('aria-checked'),
                     labelledby: s.getAttribute('aria-labelledby') } : null;
      }),
      names: items.map(i => (i.querySelector('.settings__name') || {}).textContent),
      metas: items.map(i => (i.querySelector('.settings__meta') || {}).textContent),
      focus: document.activeElement.getAttribute('aria-label'),
      titled: !!view.querySelector('h2.settings__title'),
    };
  })()`);
  check('the settings view opens inside the panel', settings.visible && settings.expanded === 'true', settings.visible);
  check('the usage list is hidden while settings is open', settings.rowsHidden === true, settings.rowsHidden);
  check('settings lists every provider, added or not', settings.ids.length === 6, settings.ids);
  check('every settings row draws the provider mark', settings.marks.every(n => n >= 1), settings.marks);
  check('every settings row offers a real switch',
    settings.switches.every(s => s && s.role === 'switch' && s.checked === 'true'), settings.switches);
  check('each switch is labelled by the provider name, not by its own state',
    settings.switches.every((s, i) => s.labelledby === 'settings-name-' + settings.ids[i]), settings.switches[0]);
  check('the settings view has a heading', settings.titled);
  check('focus moved into the settings view', /Ayarlardan/.test(settings.focus || ''), settings.focus);
  check('the added/not-added state is stated in words as well as in the switch',
    /Ana panelde/.test(settings.metas[0] || ''), settings.metas[0]);

  // Keyboard reachability: Tab from the way-out control lands on the first switch.
  await js(`document.querySelector('#settings-view .iconbtn').focus()`);
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
  await sleep(120);
  const tabbed = await js(`(() => {
    const a = document.activeElement;
    return { cls: a.className, role: a.getAttribute('role'), tag: a.tagName };
  })()`);
  check('Tab reaches the first switch from the back control',
    tabbed.role === 'switch' && tabbed.tag === 'BUTTON', tabbed);

  // ---- un-added providers leave the main panel --------------------------
  await js(`window.__probe.setEnabledDirect({ gemini: false, copilot: false, antigravity: false, kimi: false })`);
  await sleep(150);
  const split = await js(`(() => ({
    settingsIds: [...document.querySelectorAll('#settings-view li.settings__item')].map(i => i.dataset.provider),
    checked: [...document.querySelectorAll('#settings-view button.switch')].map(s => s.getAttribute('aria-checked')),
    metas: [...document.querySelectorAll('#settings-view .settings__meta')].map(m => m.textContent),
  }))()`);
  check('settings still lists all six after four are removed', split.settingsIds.length === 6, split.settingsIds);
  check('the switches follow the snapshot',
    JSON.stringify(split.checked) === JSON.stringify(['true','true','false','false','false','false']), split.checked);
  check('a removed provider says it is not in the main panel',
    /Ana panelde de/.test(split.metas[2] || ''), split.metas[2]);

  await js(`document.querySelector('.iconbtn--settings').click()`);
  await sleep(120);
  const filtered = await js(`(() => ({
    ids: [...document.querySelectorAll('ul.rows:not([hidden]) li.row[data-provider]')].map(r => r.dataset.provider),
    setsize: [...document.querySelectorAll('ul.rows:not([hidden]) li.row')].map(r => r.getAttribute('aria-setsize')),
    tray: [...document.querySelectorAll('ul.rows:not([hidden]) .grip')].map(g => g.dataset.tray || null),
    settingsHidden: document.getElementById('settings-view').hidden,
  }))()`);
  check('the main panel shows only added providers', filtered.ids.length === 2, filtered.ids);
  check('the position count describes the visible list, not the snapshot',
    filtered.setsize.every(v => v === '2'), filtered.setsize);
  check('the tray marker sits on the first ADDED provider',
    filtered.tray[0] === 'true' && filtered.tray.slice(1).every(v => !v), filtered.tray);
  check('leaving settings hides the settings view', filtered.settingsHidden === true);

  // Reordering a FILTERED list must still persist a full order. Sending only
  // the two visible ids would tell main the other four no longer exist.
  await js(`(() => {
    const grip = document.querySelector('ul.rows:not([hidden]) li.row[data-provider] .grip');
    grip.focus();
    grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));
  })()`);
  await sleep(300);
  probe = await js('window.__probe.calls()');
  const partial = probe.setOrder[probe.setOrder.length - 1];
  check('a drag in the filtered list still persists all six providers',
    Array.isArray(partial) && partial.length === 6, partial);
  check('the un-added providers keep their positions in the persisted order',
    Array.isArray(partial) && partial.slice(2).join(',') === 'kimi,gemini,copilot,antigravity', partial);

  // ---- the expansion must be a PERMUTATION, not just the right length -----
  // The case above happens to have both added providers at the front. The
  // interesting one is a set that is NOT contiguous: expandOrder() has to
  // leave every un-added provider at its own absolute index and pour the
  // visible order into the gaps between them.
  await js(`window.__probe.setEnabledDirect({ claude: true, codex: false, gemini: false, copilot: true, antigravity: true, kimi: false })`);
  await sleep(180);
  const gapped = await js(`(() => ({
    all: window.__probe.providers(),
    visible: [...document.querySelectorAll('ul.rows:not([hidden]) li.row[data-provider]')].map(r => r.dataset.provider),
  }))()`);
  check('a non-contiguous added set draws exactly the added rows',
    JSON.stringify(gapped.visible) === JSON.stringify(gapped.all.filter(id => ['claude','copilot','antigravity'].includes(id))),
    gapped);

  // Move the LAST visible row to the top. Alt+Home is the keyboard equivalent
  // of the longest possible drag, and it crosses every un-added row on the way.
  await js(`(() => {
    const rows = [...document.querySelectorAll('ul.rows:not([hidden]) li.row[data-provider]')];
    const grip = rows[rows.length - 1].querySelector('.grip');
    grip.focus();
    grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', altKey: true, bubbles: true, cancelable: true }));
  })()`);
  await sleep(300);
  probe = await js('window.__probe.calls()');
  const expanded = probe.setOrder[probe.setOrder.length - 1];
  const expectVisible = [gapped.visible[gapped.visible.length - 1], ...gapped.visible.slice(0, -1)];
  const disabledIds = gapped.all.filter(id => !gapped.visible.includes(id));
  say('expand: ' + JSON.stringify({ all: gapped.all, visible: gapped.visible, expanded }));
  check('the expanded order is the same length as the full provider list',
    Array.isArray(expanded) && expanded.length === gapped.all.length, expanded);
  check('it drops nothing and duplicates nothing: a true permutation',
    Array.isArray(expanded) && new Set(expanded).size === expanded.length
      && [...expanded].sort().join(',') === [...gapped.all].sort().join(','), expanded);
  check('every un-added provider keeps the exact index it had',
    disabledIds.every(id => expanded.indexOf(id) === gapped.all.indexOf(id)),
    { disabledIds, before: disabledIds.map(id => gapped.all.indexOf(id)), after: disabledIds.map(id => expanded.indexOf(id)) });
  check('the added providers fill the remaining slots in their NEW order',
    JSON.stringify(expanded.filter(id => gapped.visible.includes(id))) === JSON.stringify(expectVisible),
    [expanded.filter(id => gapped.visible.includes(id)), expectVisible]);
  check('and the panel draws what it persisted',
    JSON.stringify(await js(`[...document.querySelectorAll('ul.rows:not([hidden]) li.row[data-provider]')].map(r => r.dataset.provider)`))
      === JSON.stringify(expectVisible), expectVisible);

  // A provider REMOVED while a drag is in flight is not checked here, and the
  // omission is deliberate. panel.ts now prunes vanished handles INSIDE the
  // `else` branch of the `isDragging()` guard, so the row survives the gesture
  // — but exercising that from this harness needs `executeJavaScript` round
  // trips between the moves and the mouseUp, and a control run with the
  // removal replaced by `void 0` loses the pointerup just the same. A test
  // that wedges the session for reasons of its own would freeze every check
  // below it, so the scenario is left to a human with a real mouse.

  // Put the fixture back exactly where this section found it, so the sections
  // below still start from the state they were written against.
  await js(`window.__probe.setOrderDirect(${JSON.stringify(partial)})`);
  await js(`window.__probe.setEnabledDirect({ claude: true, codex: true, gemini: false, copilot: false, antigravity: false, kimi: false })`);
  await sleep(200);
  check('the fixture is back at the state the next section expects',
    JSON.stringify(await js('window.__probe.providers()')) === JSON.stringify(partial), partial);

  // ---- adding is optimistic, and a refusal is visibly reverted ----------
  await js(`document.querySelector('.iconbtn--settings').click()`);
  await sleep(120);
  // Clicked and read in ONE evaluation: the optimistic write is synchronous,
  // and a second round trip would let the mock's answer land first and hide
  // the very state this asserts.
  const optimisticAdd = await js(`(() => {
    const i = document.querySelector('#settings-view li[data-provider="gemini"]');
    const s = i.querySelector('button.switch');
    s.click();
    return { checked: s.getAttribute('aria-checked'), busy: s.getAttribute('aria-busy') };
  })()`);
  check('the switch moves on the gesture, before main answers',
    optimisticAdd.checked === 'true', optimisticAdd);
  check('a switch waiting on main says so', optimisticAdd.busy === 'true', optimisticAdd);
  await sleep(350);
  probe = await js('window.__probe.calls()');
  check('setEnabled was called with the provider and the new value',
    probe.setEnabled.length === 1 && probe.setEnabled[0][0] === 'gemini' && probe.setEnabled[0][1] === true,
    probe.setEnabled);
  const settledAdd = await js(`(() => {
    const i = document.querySelector('#settings-view li[data-provider="gemini"]');
    return { checked: i.querySelector('button.switch').getAttribute('aria-checked'),
             busy: i.querySelector('button.switch').getAttribute('aria-busy') };
  })()`);
  check('the pending flag clears once main agrees',
    settledAdd.checked === 'true' && settledAdd.busy === null, settledAdd);

  await js('window.__probe.setFailEnabled(true)');
  await js(`document.querySelector('#settings-view li[data-provider="gemini"] button.switch').click()`);
  await sleep(60);
  const optimisticFail = await js(
    `document.querySelector('#settings-view li[data-provider="gemini"] button.switch').getAttribute('aria-checked')`,
  );
  check('a removal also moves optimistically', optimisticFail === 'false', optimisticFail);
  await sleep(500);
  const reverted2 = await js(`(() => {
    const i = document.querySelector('#settings-view li[data-provider="gemini"]');
    return { checked: i.querySelector('button.switch').getAttribute('aria-checked'),
             flash: i.getAttribute('data-revert'),
             notice: (document.querySelector('.notice:not([hidden])') || {}).textContent || null };
  })()`);
  check('a refused setEnabled puts the switch back', reverted2.checked === 'true', reverted2);
  check('the revert is flagged on the row, not only described', reverted2.flash === 'true', reverted2.flash);
  check('the revert says so in words too', /kaydedilemedi/.test(reverted2.notice || ''), reverted2.notice);
  await js('window.__probe.setFailEnabled(false)');

  // ---- Escape backs out of settings, it does not close the panel --------
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
  await sleep(150);
  probe = await js('window.__probe.calls()');
  const escaped = await js(`(() => ({
    settingsHidden: document.getElementById('settings-view').hidden,
    focus: document.activeElement.getAttribute('aria-label'),
  }))()`);
  check('Escape leaves the settings view', escaped.settingsHidden === true, escaped);
  check('Escape in settings does not close the panel', probe.close === 0, probe.close);
  check('focus returns to the control that opened settings',
    escaped.focus === 'Ayarlar', escaped.focus);

  // ---- the freshness marker: quiet when current, loud when not ----------
  // The old chip was a bordered pill that read "şimdi güncellendi" almost all
  // of the time — a status whose normal state is a sentence saying "fine",
  // which is how a user learns to stop reading it. What replaced it says
  // nothing while the panel is current and takes over the header when it is
  // not. The obligation it must NOT drop is answering "is what I am looking at
  // current", so every level below is checked for that answer somewhere.
  const calmColor = await js(`(() => {
    const d = document.createElement('i');
    d.style.color = window.__tok('--calm');
    document.body.appendChild(d);
    const c = getComputedStyle(d).color;
    d.remove();
    return c;
  })()`);
  const freshLive = await js(`(() => {
    const f = document.querySelector('.hdr .fresh');
    if (!f) return null;
    const txt = f.querySelector('.fresh__text');
    const dot = f.querySelector('.fresh__dot');
    return {
      level: f.dataset.fresh,
      text: txt.textContent,
      textDrawn: getComputedStyle(txt).display !== 'none',
      dotColor: getComputedStyle(dot).backgroundColor,
      bg: getComputedStyle(f).backgroundColor,
      title: f.getAttribute('title'),
      spoken: (f.querySelector('[role="status"]') || {}).textContent,
      width: Math.round(f.getBoundingClientRect().width),
      oldChips: document.querySelectorAll('.chip').length,
      leadNodes: document.querySelectorAll('.lead, .lead__fig, .lead__v, .lead__name').length,
    };
  })()`);
  say('fresh live: ' + JSON.stringify(freshLive));
  check('the header lead readout is gone, figures and all',
    freshLive !== null && freshLive.leadNodes === 0, freshLive && freshLive.leadNodes);
  check('and so is the always-on chip that used to say "şimdi güncellendi"',
    freshLive.oldChips === 0, freshLive.oldChips);
  check('a current panel spends no words on being current',
    freshLive.level === 'live' && freshLive.text === '' && freshLive.textDrawn === false,
    freshLive);
  check('the quiet marker is a dot, not a pill', freshLive.width <= 20, freshLive.width);
  check('it still carries the answer in colour, on the state ramp',
    freshLive.dotColor === calmColor, [freshLive.dotColor, calmColor]);
  check('and in words, on hover, without occupying the header to do it',
    /güncel/.test(freshLive.title || '') && /Son güncelleme/.test(freshLive.title || ''),
    freshLive.title);
  check('a screen reader is told the same thing, once, not once a second',
    /güncel/.test(freshLive.spoken || ''), freshLive.spoken);

  // Aging: past the cadence main publishes, still inside the stale budget.
  await js('window.__probe.setGeneratedAgo(95000)');
  await sleep(240);
  const freshAging = await js(`(() => {
    const f = document.querySelector('.hdr .fresh');
    return { level: f.dataset.fresh, text: f.querySelector('.fresh__text').textContent,
             dot: getComputedStyle(f.querySelector('.fresh__dot')).backgroundColor,
             bg: getComputedStyle(f).backgroundColor };
  })()`);
  say('fresh aging: ' + JSON.stringify(freshAging));
  check('once the numbers age past the published cadence the words come back',
    freshAging.level === 'aging' && /dk önce/.test(freshAging.text || ''), freshAging);
  check('the aging marker is still a marker, not yet an alarm',
    freshAging.bg === 'rgba(0, 0, 0, 0)' && freshAging.dot !== freshLive.dotColor, freshAging);

  // Stale: past CADENCE.STALE_AFTER_MS. The rows dim at the same instant; this
  // is the surface that says why.
  await js('window.__probe.setGeneratedAgo(240000)');
  await sleep(240);
  const freshStale = await js(`(() => {
    const f = document.querySelector('.hdr .fresh');
    const cs = getComputedStyle(f);
    return { level: f.dataset.fresh, text: f.querySelector('.fresh__text').textContent,
             bg: cs.backgroundColor, color: cs.color,
             contrast: window.__cr(cs.color, cs.backgroundColor),
             groundVsPanel: window.__cr(cs.backgroundColor, window.__tok('--ink-900')),
             spoken: (f.querySelector('[role="status"]') || {}).textContent,
             rowsDimmed: [...document.querySelectorAll('ul.rows:not([hidden]) li.row')]
               .map((r) => r.dataset.status) };
  })()`);
  say('fresh stale: ' + JSON.stringify(freshStale));
  check('a stale panel says so in words, and says it is not current',
    freshStale.level === 'stale' && /güncel değil/.test(freshStale.text || ''), freshStale.text);
  check('the alarm is a filled block, not one more shade of grey',
    freshStale.bg !== 'rgba(0, 0, 0, 0)' && freshStale.groundVsPanel >= 3, freshStale);
  check('the alarm text is legible on its own ground', freshStale.contrast >= 4.5, freshStale.contrast);
  check('the row list degrades with it, so the alarm is not the only signal',
    freshStale.rowsDimmed.length > 0 && freshStale.rowsDimmed.indexOf('ok') === -1
      && freshStale.rowsDimmed.indexOf('stale') !== -1, freshStale.rowsDimmed);
  check('and the transition is announced, not left to be noticed',
    /güncel değil/.test(freshStale.spoken || ''), freshStale.spoken);

  await js('window.__probe.setGeneratedAgo(0)');
  await sleep(240);
  check('a fresh push puts the marker back to quiet',
    (await js(`document.querySelector('.hdr .fresh').dataset.fresh`)) === 'live');

  // `offline` and `pending` cannot be reached from inside a running window:
  // bridgeAvailable is decided once, at mount, by whether the preload exposed
  // anything, and `pending` only exists before the first snapshot lands. What
  // CAN be verified is the claim the design makes about them — that offline
  // sits in the SAME alarm tier as stale rather than inventing a competing
  // second one, and that pending is not a silent marker.
  const tiers = await js(`(() => {
    const f = document.querySelector('.hdr .fresh');
    const dot = f.querySelector('.fresh__dot');
    const was = f.dataset.fresh;
    const read = (level) => {
      f.dataset.fresh = level;
      const cs = getComputedStyle(f);
      return { bg: cs.backgroundColor, contrast: window.__cr(cs.color, cs.backgroundColor),
               anim: getComputedStyle(dot).animationName };
    };
    const out = { offline: read('offline'), pending: read('pending') };
    f.dataset.fresh = was;
    return out;
  })()`);
  say('tiers: ' + JSON.stringify(tiers));
  check('offline is drawn as the same alarm as stale, not a competing one',
    tiers.offline.bg === freshStale.bg && tiers.offline.contrast >= 4.5, tiers.offline);
  check('a first scan in progress is never a silent marker',
    tiers.pending.anim !== 'none', tiers.pending);

  // Refreshing: the third state that matters, and the one the old chip never
  // represented at all.
  await js('window.__probe.setRefreshDelay(900)');
  await js(`document.querySelector('.foot button.btn').click()`);
  await sleep(260);
  const refreshing = await js(`(() => {
    const f = document.querySelector('.hdr .fresh');
    return { busy: f.dataset.busy || null, level: f.dataset.fresh,
             text: f.querySelector('.fresh__text').textContent,
             anim: getComputedStyle(f.querySelector('.fresh__dot')).animationName,
             button: document.querySelector('.foot button.btn').textContent };
  })()`);
  say('refreshing: ' + JSON.stringify(refreshing));
  check('a refresh in flight is visible in the header', refreshing.busy === 'true', refreshing);
  check('it pulses rather than repeating the footer sentence',
    refreshing.anim !== 'none' && refreshing.text === '' && /Yenileniyor/.test(refreshing.button),
    refreshing);
  check('and it never claims the data is newer than it is',
    refreshing.level === 'live', refreshing.level);
  await sleep(1000);
  check('the pulse stops when the refresh lands',
    (await js(`document.querySelector('.hdr .fresh').dataset.busy || null`)) === null);
  await js('window.__probe.setRefreshDelay(0)');

  // ---- the lead provider is named by the LIST now, not by the header -----
  // This is what makes dropping the readout safe: the row that drives the tray
  // icon is the first one, it carries a marker, and the marker explains itself.
  const leadInList = await js(`(() => {
    const grips = [...document.querySelectorAll('ul.rows:not([hidden]) .grip')];
    const first = grips[0];
    return {
      tray: grips.map((g) => g.dataset.tray || null),
      title: first.getAttribute('title'),
      name: document.querySelector('ul.rows:not([hidden]) .row__name').textContent,
      help: (document.getElementById(first.getAttribute('aria-describedby')) || {}).textContent,
    };
  })()`);
  say('lead in list: ' + JSON.stringify(leadInList));
  check('the lead is the first row and it is marked as such',
    leadInList.tray[0] === 'true' && leadInList.tray.slice(1).every((v) => !v), leadInList.tray);
  check('the marker names the consequence on the control that owns it',
    /Tepsi simgesi/.test(leadInList.title || '')
      && leadInList.title.indexOf(leadInList.name) === 0, leadInList.title);
  check('and the rule is stated in words for anyone who cannot see a 6px dot',
    /üstteki/.test(leadInList.help || '') && /epsi/.test(leadInList.help || ''),
    leadInList.help);

  // ---- theme: light and dark are both first-class -----------------------
  const themeBoot = await js(`(() => {
    const r = window.usageNotch.initialPreferences();
    return {
      isPromise: !!r && typeof r.then === 'function',
      said: r && r.theme,
      attr: document.documentElement.getAttribute('data-theme'),
      choice: document.documentElement.getAttribute('data-theme-choice'),
      scheme: getComputedStyle(document.documentElement).colorScheme,
    };
  })()`);
  say('theme boot: ' + JSON.stringify(themeBoot));
  check('initialPreferences() is synchronous, which is what makes frame one possible',
    themeBoot.isPromise === false && themeBoot.said === 'dark', themeBoot);
  check('and the theme it named is already on the document',
    themeBoot.attr === 'dark' && themeBoot.choice === 'dark', themeBoot);
  check('the UA is told which scheme it is painting', themeBoot.scheme === 'dark', themeBoot.scheme);

  // The DARK ramp, measured on the theme that ships by default. `spent` used
  // to be #7A3A28: 2.21:1 on the panel base and 1.51:1 on the meter track it
  // is drawn on, which made a %100 bar — the reading a user most needs to
  // catch — the least visible thing on the ramp. Both ratios are asserted,
  // because the track is what a bar is actually read against and the base is
  // what the figure beside it is.
  const darkRamp = await js('window.__ramp()');
  say('dark ramp: ' + JSON.stringify(darkRamp));
  check('every dark state-ramp step is readable AS TEXT on the panel base',
    darkRamp.onBase.every((v) => v >= 4.5), darkRamp.onBase);
  check('and every one is readable AS A BAR against the meter track',
    darkRamp.onTrack.every((v) => v >= 3), darkRamp.onTrack);
  check('the top step is not the least visible one: a full bar is the loudest',
    darkRamp.onTrack[3] >= 3 && darkRamp.onBase[3] >= 4.5,
    [darkRamp.onBase[3], darkRamp.onTrack[3]]);
  check('the top step is REDDER than the one below it, not merely brighter',
    darkRamp.spentEmberHueGap >= 12 && darkRamp.lum[3] < darkRamp.lum[2],
    [darkRamp.spentEmberHueGap, darkRamp.lum]);
  check('the certainty tick still reads on top of a spent fill',
    darkRamp.tickOnFills[3] >= 3, darkRamp.tickOnFills);

  await js(`document.querySelector('.iconbtn--settings').click()`);
  await sleep(180);
  const themeGroup = await js(`(() => {
    const f = document.querySelector('#settings-view fieldset.theme');
    if (!f) return null;
    const radios = [...f.querySelectorAll('input[type=radio]')];
    const uniqueNames = radios.map((r) => r.name).filter((n, i, a) => a.indexOf(n) === i);
    return {
      legend: (f.querySelector('legend') || {}).textContent,
      values: radios.map((r) => r.value),
      names: uniqueNames,
      checked: radios.filter((r) => r.checked).map((r) => r.value),
      labels: radios.map((r) => (f.querySelector('label[for="' + r.id + '"]') || {}).textContent),
      inFlow: radios.every((r) => getComputedStyle(r).display !== 'none' && !r.disabled),
      help: (f.querySelector('.theme__help') || {}).textContent,
      headings: [...document.querySelectorAll('#settings-view h2, #settings-view h3, #settings-view legend')]
        .map((h) => h.textContent),
      order: [...document.querySelectorAll('#settings-view .settings__list, #settings-view fieldset.theme')]
        .map((n) => n.className.split(' ')[0]),
    };
  })()`);
  say('theme group: ' + JSON.stringify(themeGroup));
  check('settings offers a theme control',
    themeGroup !== null && themeGroup.legend === 'Görünüm', themeGroup && themeGroup.legend);
  check('three choices, one selection: a real radio group sharing one name',
    JSON.stringify(themeGroup.values) === JSON.stringify(['light', 'dark', 'system'])
      && themeGroup.names.length === 1, themeGroup);
  check('exactly one is selected, and it is the one main persisted',
    JSON.stringify(themeGroup.checked) === JSON.stringify(['dark']), themeGroup.checked);
  check('the labels are Turkish and nothing is uppercased',
    JSON.stringify(themeGroup.labels) === JSON.stringify(['Açık', 'Koyu', 'Sistem']), themeGroup.labels);
  check('the radios stay in the focus order rather than being display:none',
    themeGroup.inFlow === true, themeGroup.inFlow);
  check('the view has a heading per section, not one that covers only half of it',
    themeGroup.headings[0] === 'Ayarlar' && themeGroup.headings.indexOf('Araçlar') !== -1
      && themeGroup.headings.indexOf('Görünüm') !== -1, themeGroup.headings);
  check('the theme control comes after the provider list, so the tab path is unchanged',
    themeGroup.order[0] === 'settings__list', themeGroup.order);

  await js(`document.querySelector('#settings-view label[for="theme-light"]').click()`);
  await sleep(280);
  probe = await js('window.__probe.calls()');
  const light = await js(`(() => {
    const T = window.__tok;
    const ramp = ['--calm', '--watch', '--ember', '--spent'].map(T);
    return {
      attr: document.documentElement.getAttribute('data-theme'),
      choice: document.documentElement.getAttribute('data-theme-choice'),
      scheme: getComputedStyle(document.documentElement).colorScheme,
      baseLum: Math.round(window.__lum(window.__rgb(T('--ink-900'))) * 100) / 100,
      ink100: window.__cr(T('--ink-100'), T('--ink-900')),
      ink400: window.__cr(T('--ink-400'), T('--ink-900')),
      ink300onRow: window.__cr(T('--ink-300'), T('--ink-800')),
      trackVsBase: window.__cr(T('--ink-600'), T('--ink-900')),
      rampOnBase: ramp.map((c) => window.__cr(c, T('--ink-900'))),
      rampOnTrack: ramp.map((c) => window.__cr(c, T('--ink-600'))),
      rampLum: ramp.map((c) => Math.round(window.__lum(window.__rgb(c)) * 10000) / 10000),
      checked: [...document.querySelectorAll('#settings-view input[type=radio]')]
        .filter((r) => r.checked).map((r) => r.value),
    };
  })()`);
  say('light: ' + JSON.stringify(light));
  check('picking Açık flips the document immediately, before main answers',
    light.attr === 'light' && light.choice === 'light', light);
  check('and it is a light palette, not a relabelled dark one', light.baseLum > 0.7, light.baseLum);
  check('the UA follows the theme too', light.scheme === 'light', light.scheme);
  check('main was asked to persist it',
    probe.setTheme[probe.setTheme.length - 1] === 'light', probe.setTheme);
  check('the radio group reflects the new choice',
    JSON.stringify(light.checked) === JSON.stringify(['light']), light.checked);
  check('the ink scale keeps its hierarchy and its legibility in light',
    light.ink100 >= 12 && light.ink400 >= 4.5 && light.ink300onRow >= 4.5, light);
  check('an empty meter still reads as a bar, not as nothing',
    light.trackVsBase >= 1.4, light.trackVsBase);
  check('every state-ramp step is readable AS TEXT on the light ground',
    light.rampOnBase.every((v) => v >= 4.5), light.rampOnBase);
  check('and every one is readable AS A BAR against the meter track',
    light.rampOnTrack.every((v) => v >= 3), light.rampOnTrack);
  check('the ramp keeps its urgency ordering: each step is darker than the last',
    light.rampLum[0] > light.rampLum[1] && light.rampLum[1] > light.rampLum[2]
      && light.rampLum[2] > light.rampLum[3], light.rampLum);
  const lightRamp = await js('window.__ramp()');
  say('light ramp: ' + JSON.stringify(lightRamp));
  check('and in light too the top step is redder than the one below it',
    lightRamp.spentEmberHueGap >= 5, lightRamp.spentEmberHueGap);
  check('the certainty tick reads on EVERY fill in light, not only the pale ones',
    lightRamp.tickOnFills.every((v) => v >= 3), lightRamp.tickOnFills);

  // The brand accents are fixed hexes chosen against a dark ground. Four of the
  // six are illegible on a light one, so the light theme shades the same hue.
  const marks = await js(`(() => {
    const rows = [...document.querySelectorAll('#settings-view li.settings__item[data-connected="true"]')];
    return rows.map((r) => {
      const m = r.querySelector('.settings__mark');
      const cs = getComputedStyle(m);
      const brand = r.style.getPropertyValue('--accent').trim();
      return { id: r.dataset.provider, brand, ink: cs.color, tile: cs.backgroundColor,
               vsTile: window.__cr(cs.color, cs.backgroundColor),
               vsBrand: window.__cr(cs.color, brand) };
    });
  })()`);
  say('light marks: ' + JSON.stringify(marks));
  check('the light theme shades the brand hex rather than using it raw',
    marks.length >= 2 && marks.every((m) => m.vsBrand > 1.05), marks);
  check('and every identity mark clears the 3:1 non-text threshold on light',
    marks.every((m) => m.vsTile >= 3), marks.map((m) => [m.id, m.vsTile]));

  // A failed write must put the PALETTE back too, not just the radio: leaving
  // the new theme on screen would show a setting that dies at the next launch.
  await js('window.__probe.setFailTheme(true)');
  await js(`document.querySelector('#settings-view label[for="theme-dark"]').click()`);
  await sleep(120);
  const themeOptimistic = await js(`document.documentElement.getAttribute('data-theme')`);
  await sleep(600);
  const themeReverted = await js(`(() => ({
    attr: document.documentElement.getAttribute('data-theme'),
    checked: [...document.querySelectorAll('#settings-view input[type=radio]')]
      .filter((r) => r.checked).map((r) => r.value),
    flash: document.querySelector('#settings-view fieldset.theme').dataset.revert || null,
    notice: (document.querySelector('.notice') || {}).textContent,
  }))()`);
  const themeStored = (await js('window.__probe.prefs()')).theme;
  say('theme revert: ' + JSON.stringify([themeOptimistic, themeReverted, themeStored]));
  check('the theme flips on the gesture, before main answers',
    themeOptimistic === 'dark', themeOptimistic);
  check('a refused write puts the palette back, not only the radio',
    themeReverted.attr === 'light' && JSON.stringify(themeReverted.checked) === JSON.stringify(['light']),
    themeReverted);
  check('the revert is flagged so it is seen, not only described',
    themeReverted.flash === 'true', themeReverted.flash);
  check('and it says so in words', /kaydedilemedi/.test(themeReverted.notice || ''), themeReverted.notice);
  check('main really did keep the old value', themeStored === 'light', themeStored);
  await js('window.__probe.setFailTheme(false)');

  // 'system' is a LIVE binding, not a one-time read. nativeTheme is what
  // actually drives prefers-color-scheme in a renderer, so this is the real
  // signal and not a simulated one.
  await js(`document.querySelector('#settings-view label[for="theme-system"]').click()`);
  await sleep(280);
  nativeTheme.themeSource = 'light';
  await sleep(260);
  const sysLight = await js(`(() => ({
    attr: document.documentElement.getAttribute('data-theme'),
    choice: document.documentElement.getAttribute('data-theme-choice'),
    help: (document.querySelector('#settings-view .theme__help') || {}).textContent,
  }))()`);
  nativeTheme.themeSource = 'dark';
  await sleep(260);
  const sysDark = await js(`(() => ({
    attr: document.documentElement.getAttribute('data-theme'),
    choice: document.documentElement.getAttribute('data-theme-choice'),
    help: (document.querySelector('#settings-view .theme__help') || {}).textContent,
  }))()`);
  say('system: ' + JSON.stringify([sysLight, sysDark]));
  check('Sistem follows prefers-color-scheme when the OS says light',
    sysLight.attr === 'light' && sysLight.choice === 'system', sysLight);
  check('and keeps following it when the OS changes again',
    sysDark.attr === 'dark' && sysDark.choice === 'system', sysDark);
  check('the copy names what Sistem currently resolves to, so the choice is not silent',
    /açık/.test(sysLight.help || '') && /koyu/.test(sysDark.help || ''),
    [sysLight.help, sysDark.help]);

  // An explicit choice must NOT follow the OS. That is the whole point of it.
  await js(`document.querySelector('#settings-view label[for="theme-light"]').click()`);
  await sleep(280);
  nativeTheme.themeSource = 'dark';
  await sleep(260);
  check('an explicit Açık survives the OS flipping to dark',
    (await js(`document.documentElement.getAttribute('data-theme')`)) === 'light');

  // Back to dark for the remaining checks, which read dark-theme values.
  nativeTheme.themeSource = 'system';
  await js(`document.querySelector('#settings-view label[for="theme-dark"]').click()`);
  await sleep(300);
  check('and picking Koyu again restores the dark palette',
    (await js(`document.documentElement.getAttribute('data-theme')`)) === 'dark');
  await js(`document.querySelector('.iconbtn--settings').click()`);
  await sleep(160);

  // ---- the empty panel says WHICH empty it is ---------------------------
  await js(`window.__probe.setEnabledDirect({ claude: false, codex: false, gemini: false })`);
  await sleep(160);
  const emptyAdded = await js(`(() => {
    const box = document.querySelector('.empty');
    return {
      hidden: box.hidden,
      rowsHidden: [...document.querySelectorAll('ul.rows')].every(l => l.hidden),
      title: (box.querySelector('.empty__title') || {}).textContent,
      detail: (box.querySelector('.empty__detail') || {}).textContent,
      action: (() => { const b = box.querySelector('button'); return b && !b.hidden ? b.textContent : null; })(),
    };
  })()`);
  check('with nothing added the row list is replaced, not left blank',
    emptyAdded.hidden === false && emptyAdded.rowsHidden === true, emptyAdded);
  check('the empty panel names the cause: no rows were added',
    /Ana panelde hi/.test(emptyAdded.title || ''), emptyAdded.title);
  check('the empty panel counts what it found, so zero is not read as no data',
    /6/.test(emptyAdded.detail || ''), emptyAdded.detail);
  check('the empty panel offers the way to fix it', emptyAdded.action === 'Ayarları aç', emptyAdded.action);

  await js(`document.querySelector('.empty button').click()`);
  await sleep(120);
  check('the empty state button opens settings',
    (await js(`!document.getElementById('settings-view').hidden`)) === true);
  await js(`document.querySelector('.iconbtn--settings').click()`);
  await sleep(120);


  await js('window.__probe.setEmpty()');
  await sleep(160);
  const emptyNone = await js(`(() => {
    const box = document.querySelector('.empty');
    const b = box.querySelector('button');
    return { title: (box.querySelector('.empty__title') || {}).textContent,
             hidden: box.hidden, actionHidden: b.hidden };
  })()`);
  check('a machine with no known tools says THAT instead',
    emptyNone.hidden === false && /bulunamad/.test(emptyNone.title || ''), emptyNone);
  check('and offers no settings button, because settings would be empty too',
    emptyNone.actionHidden === true, emptyNone);

  // The settings view has the SAME collision one level down: with no providers
  // its list is empty too, and a blank form under a heading reads as a broken
  // screen rather than as an answer. The header gear still reaches it.
  await js(`document.querySelector('.iconbtn--settings').click()`);
  await sleep(160);
  const settingsEmpty = await js(`(() => {
    const v = document.getElementById('settings-view');
    const st = v.querySelector('.settings__status');
    return { hidden: v.hidden, listHidden: v.querySelector('.settings__list').hidden,
             items: v.querySelectorAll('li.settings__item').length,
             status: st.hidden ? null : st.textContent, busy: st.getAttribute('aria-busy') };
  })()`);
  check('settings with no providers states the reason instead of showing a blank list',
    settingsEmpty.hidden === false && settingsEmpty.listHidden === true
      && /bulunamad/.test(settingsEmpty.status || ''), settingsEmpty);
  check('and it does not claim to still be scanning', settingsEmpty.busy === null, settingsEmpty);
  // The empty branch of createSettings.render() returns BEFORE the reconcile,
  // so the six <li> from the previous provider list are still in the DOM. That
  // is only harmless while the list stays hidden, which is what is asserted
  // here rather than the absence: an item that survives must not be reachable.
  check('no stale switch survives for a provider that is gone',
    settingsEmpty.items === 0, settingsEmpty);
  await js(`document.querySelector('.iconbtn--settings').click()`);
  await sleep(140);

  // ---- pin means "stays on screen", and it must LOOK different ----------
  // The mode is main's to own; it announces it with an anchor. Both states are
  // asserted because a control the user cannot read is wrong in both.
  const pinOff = await js(`(() => {
    const b = document.querySelector('.iconbtn--pin');
    const cs = getComputedStyle(b);
    return { pressed: b.getAttribute('aria-pressed'), label: b.getAttribute('aria-label'),
             title: b.getAttribute('title'), bg: cs.backgroundColor, color: cs.color,
             tilt: b.querySelector('svg path').getAttribute('transform'),
             foot: (document.querySelector('.foot__mode') || {}).textContent };
  })()`);
  check('the panel starts unpinned', pinOff.pressed === 'false', pinOff.pressed);
  check('the unpinned name promises the panel stays, it does not mention focus',
    /ekranda/.test(pinOff.label || '') && !/odak|focus/i.test(pinOff.label || ''), pinOff.label);
  check('the unpinned tooltip says what happens instead: it closes on leave',
    /kapan/.test(pinOff.title || ''), pinOff.title);
  check('the unpinned glyph is tilted out of the board', /rotate/.test(pinOff.tilt || ''), pinOff.tilt);
  check('the footer states the unpinned promise in words',
    /kapan/.test(pinOff.foot || ''), pinOff.foot);

  await js(`window.__probe.setMode('pin')`);
  await sleep(160);
  const pinOn = await js(`(() => {
    const b = document.querySelector('.iconbtn--pin');
    const cs = getComputedStyle(b);
    return { pressed: b.getAttribute('aria-pressed'), label: b.getAttribute('aria-label'),
             title: b.getAttribute('title'), bg: cs.backgroundColor, color: cs.color,
             tilt: b.querySelector('svg path').getAttribute('transform'),
             foot: (document.querySelector('.foot__mode') || {}).textContent };
  })()`);
  say('pin: ' + JSON.stringify([pinOff, pinOn]));
  check('an anchor with mode:pin puts the control in its pressed state',
    pinOn.pressed === 'true', pinOn.pressed);
  check('the pinned name says the panel stays on screen',
    /ekranda/.test(pinOn.label || '') && !/odak|focus/i.test(pinOn.label || ''), pinOn.label);
  check('the pinned tooltip promises it survives switching apps',
    /uygulama/.test(pinOn.title || ''), pinOn.title);
  check('pinned and unpinned are different at a glance, not one shade apart',
    pinOn.bg !== pinOff.bg && pinOn.color !== pinOff.color, [pinOff.bg, pinOn.bg]);
  check('pinned inverts to the brightest ink, so it survives greyscale',
    pinOn.bg === 'rgb(237, 242, 240)', pinOn.bg);
  check('the pinned glyph stands upright', pinOn.tilt === null, pinOn.tilt);
  check('the footer states the pinned promise in words',
    /kal/.test(pinOn.foot || '') && pinOn.foot !== pinOff.foot, pinOn.foot);

  await js(`window.__probe.setMode('hover')`);
  await sleep(160);
  const pinBack = await js(`document.querySelector('.iconbtn--pin').getAttribute('aria-pressed')`);
  check('unpinning is reflected too, so the control never lies about the mode',
    pinBack === 'false', pinBack);

  // The button must work in BOTH directions. It only ever pinned before, which
  // was survivable when pinned armed a hide-on-blur; now that pinned is sticky,
  // a one-way door traps the panel on screen.
  await js(`document.querySelector('.iconbtn--pin').click()`);
  await sleep(200);
  const pressed = await js(`(() => ({
    pressed: document.querySelector('.iconbtn--pin').getAttribute('aria-pressed'),
    foot: (document.querySelector('.foot__mode') || {}).textContent,
  }))()`);
  check('pressing the pin button pins the panel', pressed.pressed === 'true', pressed);
  await js(`document.querySelector('.iconbtn--pin').click()`);
  await sleep(200);
  probe = await js('window.__probe.calls()');
  const unpressed = await js(`(() => ({
    pressed: document.querySelector('.iconbtn--pin').getAttribute('aria-pressed'),
    foot: (document.querySelector('.foot__mode') || {}).textContent,
    panelOpen: document.querySelector('.anchor').getAttribute('data-open'),
  }))()`);
  check('pressing it again un-pins, so the panel is never trapped on screen',
    unpressed.pressed === 'false', unpressed);
  check('un-pinning leaves the panel open; only close closes it',
    unpressed.panelOpen === 'true' && probe.close === 0, unpressed);
  check('the footer follows the mode both ways', unpressed.foot !== pressed.foot,
    [pressed.foot, unpressed.foot]);
  check('the renderer asked main twice and never flipped its own state',
    probe.pin === 2, probe.pin);

  // ---- tray coaching, shown only when we are NOT on a measured icon -----
  const coachHidden = await js(`document.querySelector('.coach').hidden`);
  check('no coaching while the anchor is a real tray rect', coachHidden === true, coachHidden);
  await js(`window.__probe.setMode('hover', 'cursor')`);
  await sleep(160);
  const coach = await js(`(() => {
    const c = document.querySelector('.coach');
    return { hidden: c.hidden, text: (c.querySelector('.coach__text') || {}).textContent,
             dismiss: (c.querySelector('button') || {}).textContent };
  })()`);
  check('a cursor-sourced anchor coaches the user to the overflow flyout',
    coach.hidden === false && /gizli simgeler/.test(coach.text || ''), coach);
  check('the coaching also says the panel is now opened by a click',
    /tıklayınca/.test(coach.text || ''), coach.text);
  check('the coaching can be dismissed', coach.dismiss === 'Anladım', coach.dismiss);
  await js(`document.querySelector('.coach button').click()`);
  await sleep(80);
  await js(`window.__probe.setMode('hover', 'cursor')`);
  await sleep(160);
  check('a dismissed hint does not come back on the next anchor',
    (await js(`document.querySelector('.coach').hidden`)) === true);

  // ---- the notice can be closed, and closing it does not strand focus ---
  //
  // The message that produced this section was correct and undismissable: the
  // user pressed a connect button, was told the CLI is not installed, and the
  // box then sat there. A correct message with no way out reads as a stuck
  // error, so the control is checked as a control (name, ink, focus) and the
  // box is checked as a live region (the button must not be inside it).
  await js(`window.__probe.restore()`);
  await sleep(200);

  const noticeIdle = await js(`(() => {
    const n = document.querySelector('.notice');
    return { hidden: n.hidden, closeHidden: n.querySelector('.notice__close').hidden };
  })()`);
  check('no notice, no close control', noticeIdle.hidden === true, noticeIdle);

  // 186 characters: over the 160-character cap, with the ACTIONABLE half of
  // the message in the second sentence. The old slice(0, 159) cut inside a
  // word and took that half with it.
  const LONG_SETUP = 'Bu makinede Antigravity CLI bulunamadı. Kurulum için önce Antigravity '
    + 'CLI uygulamasını kurun, ardından bu düğmeye yeniden basın; hiçbir dosya '
    + 'oluşturulmadı ve hiçbir ayar değiştirilmedi.';
  await js(`window.__probe.setSetupResult({ ok: false, message: ${JSON.stringify(LONG_SETUP)} })`);
  await js(`document.querySelector('.row[data-provider="kimi"] button.btn').click()`);
  await sleep(260);

  const notice = await js(`(() => {
    const n = document.querySelector('.notice');
    const t = n.querySelector('.notice__text');
    const b = n.querySelector('.notice__close');
    const cs = getComputedStyle(b);
    const T = window.__tok;
    const svgEl = b.querySelector('svg');
    return {
      hidden: n.hidden,
      role: n.getAttribute('role'),
      textRole: t.getAttribute('role'),
      text: t.textContent,
      closeHidden: b.hidden,
      closeInLiveRegion: t.contains(b),
      tag: b.tagName,
      type: b.getAttribute('type'),
      name: b.getAttribute('aria-label'),
      title: b.getAttribute('title'),
      glyphText: b.textContent,
      glyphHidden: svgEl ? svgEl.getAttribute('aria-hidden') : null,
      color: cs.color,
      textColor: getComputedStyle(t).color,
      ground: getComputedStyle(n).backgroundColor,
      onGround: window.__cr(cs.color, getComputedStyle(n).backgroundColor),
      textOnGround: window.__cr(getComputedStyle(t).color, getComputedStyle(n).backgroundColor),
      isGreyToken: window.__cr(cs.color, T('--ink-400')) === 1,
      // offsetWidth/Height, not getBoundingClientRect: the panel carries a
      // scale transform during its open/close animation, and a rect measured
      // through it reports 19 for a 20px box. Layout size is what the rule sets.
      w: b.offsetWidth,
      h: b.offsetHeight,
      // The control belongs in the corner of the box, not floating in it.
      // Expressed against the control's OWN measured width, so the check is
      // invariant under whatever transform the panel happens to be carrying.
      rightGap: (n.getBoundingClientRect().right - b.getBoundingClientRect().right)
        / b.getBoundingClientRect().width,
      topGap: (b.getBoundingClientRect().top - n.getBoundingClientRect().top)
        / b.getBoundingClientRect().width,
    };
  })()`);
  say('notice: ' + JSON.stringify(notice));

  check('a failed setup puts its message on screen',
    notice.hidden === false && /Antigravity CLI bulunamad/.test(notice.text || ''), notice.text);
  check('the message carries a close control', notice.closeHidden === false, notice);
  check('it is a real button, so it is tab-reachable and Enter/Space work',
    notice.tag === 'BUTTON' && notice.type === 'button', notice);
  check('the bare glyph is not the accessible name; a Turkish label is',
    notice.name === 'Bu bildirimi kapat' && notice.glyphText === '', notice);
  check('the cross itself is hidden from the reader', notice.glyphHidden === 'true', notice);
  check('it is pointed at by a tooltip too, for the mouse user',
    notice.title === 'Bu bildirimi kapat', notice.title);

  // The live region moved off the wrapper and onto the paragraph. If the
  // button were inside it, every message would be re-announced with the
  // control's name attached, and rewriting the region's text under a focused
  // child is how focus gets dropped to <body>.
  check('the live region is the message, not the whole box',
    notice.role === null && notice.textRole === 'status', notice);
  check('and the close control sits outside it, so it is never announced',
    notice.closeInLiveRegion === false, notice);

  check('the control is grey from the token palette, not a hard-coded hex',
    notice.isGreyToken === true, [notice.color]);
  check('it is quieter than the message it sits beside',
    notice.onGround < notice.textOnGround, [notice.onGround, notice.textOnGround]);
  check('but still readable as a control on the notice ground',
    notice.onGround >= 3, notice.onGround);
  check('it is a small target in a text box, not a header-sized one',
    notice.w === 20 && notice.h === 20, [notice.w, notice.h]);
  check('and it sits in the corner of the box, not indented into the text column',
    notice.rightGap <= 0.3 && notice.topGap <= 0.3
      && Math.abs(notice.rightGap - notice.topGap) <= 0.1,
    [notice.rightGap, notice.topGap]);

  // ---- the truncation cuts where the language does, not at index 159 ----
  check('a message over the cap is trimmed', notice.text.length <= 161, notice.text.length);
  check('the cut lands on a word boundary, never inside a word',
    (() => {
      const body = notice.text.replace(/…$/, '');
      const last = body.split(/\s+/).filter(Boolean).pop() || '';
      return new RegExp('(^|\\s)' + last.replace(/[.*+?^${}()|[\]\\]/g, '\\  // ---- no innerHTML anywhere in shipped renderer ------------------------') + '($|\\s)')
        .test(LONG_SETUP);
    })(), notice.text);
  check('and the instruction survives it, which is the half the old cut dropped',
    /kurun/.test(notice.text), notice.text);
  check('a clause boundary keeps its ellipsis, so nothing claims to be complete',
    !/[:;]$/.test(notice.text) && notice.text.endsWith('…'), notice.text);

  // ---- the grey has to be grey in both palettes -------------------------
  //
  // Entering settings CLEARS the notice on purpose (app.ts toggleSettings: a
  // reorder failure must not follow the user into a view whose controls did
  // not cause it), so the theme is flipped FIRST and the message raised again
  // afterwards. Measuring a box that is `display:none` would have "passed"
  // while looking at nothing.
  await js(`document.querySelector('.iconbtn--settings').click()`);
  await sleep(140);
  await js(`document.querySelector('#settings-view label[for="theme-light"]').click()`);
  await sleep(280);
  await js(`document.querySelector('.iconbtn--settings').click()`);
  await sleep(160);
  await js(`document.querySelector('.row[data-provider="kimi"] button.btn').click()`);
  await sleep(240);
  const noticeLight = await js(`(() => {
    const n = document.querySelector('.notice');
    const b = n.querySelector('.notice__close');
    const T = window.__tok;
    return {
      visible: !n.hidden && getComputedStyle(b).display !== 'none',
      onGround: window.__cr(getComputedStyle(b).color, getComputedStyle(n).backgroundColor),
      textOnGround: window.__cr(getComputedStyle(n.querySelector('.notice__text')).color,
        getComputedStyle(n).backgroundColor),
      isGreyToken: window.__cr(getComputedStyle(b).color, T('--ink-400')) === 1,
    };
  })()`);
  say('notice light: ' + JSON.stringify(noticeLight));
  check('the notice and its control are actually on screen in light',
    noticeLight.visible === true, noticeLight);
  check('the close tracks the light palette through the same token',
    noticeLight.isGreyToken === true, noticeLight);
  check('and it is still readable on the light notice ground',
    noticeLight.onGround >= 3, noticeLight.onGround);
  check('still the quieter of the two in light as well',
    noticeLight.onGround < noticeLight.textOnGround, noticeLight);

  await js(`document.querySelector('.iconbtn--settings').click()`);
  await sleep(140);
  await js(`document.querySelector('#settings-view label[for="theme-dark"]').click()`);
  await sleep(280);
  await js(`document.querySelector('.iconbtn--settings').click()`);
  await sleep(160);
  await js(`document.querySelector('.row[data-provider="kimi"] button.btn').click()`);
  await sleep(240);

  // ---- pressing it clears the message, and focus goes somewhere ---------
  const dismissed = await js(`(() => {
    const b = document.querySelector('.notice__close');
    b.focus();
    const focusedBefore = document.activeElement === b;
    b.click();
    const n = document.querySelector('.notice');
    const active = document.activeElement;
    return {
      focusedBefore,
      hidden: n.hidden,
      text: n.querySelector('.notice__text').textContent,
      activeTag: active ? active.tagName : null,
      inPanel: !!(active && active.closest && active.closest('.panel')),
      isPanel: !!(active && active.classList && active.classList.contains('panel')),
    };
  })()`);
  say('dismiss: ' + JSON.stringify(dismissed));
  check('the control takes focus at all', dismissed.focusedBefore === true, dismissed);
  check('pressing it clears the message',
    dismissed.hidden === true && dismissed.text === '', dismissed);
  check('focus is not stranded on <body> when the control removes itself',
    dismissed.activeTag !== 'BODY', dismissed);
  check('it lands on the panel, so the next Tab continues inside the dialog',
    dismissed.inPanel === true && dismissed.isPanel === true, dismissed);

  // ---- a mouse dismissal must not yank focus from wherever it was -------
  await js(`window.__probe.setSetupResult({ ok: false, message: 'Kurulum tamamlanamadı.' })`);
  await js(`document.querySelector('.row[data-provider="kimi"] button.btn').click()`);
  await sleep(240);
  const noSteal = await js(`(() => {
    const refresh = [...document.querySelectorAll('.foot button')].pop();
    refresh.focus();
    document.querySelector('.notice__close').click();
    return {
      hidden: document.querySelector('.notice').hidden,
      stillOnRefresh: document.activeElement === refresh,
    };
  })()`);
  check('a click from elsewhere still clears the message', noSteal.hidden === true, noSteal);
  check('and does not move focus the user never put there',
    noSteal.stillOnRefresh === true, noSteal);

  // ---- Esc is left alone: it still closes the panel with a notice up ----
  //
  // Deliberately NOT bound to the notice. A notice appears after almost every
  // action, so consuming Esc here would silently break "Esc closes the panel"
  // at exactly the moment the user is most likely to press it - and the notice
  // is not modal, takes no focus and blocks nothing.
  await js(`window.__probe.setSetupResult({ ok: false, message: 'Kurulum tamamlanamadı.' })`);
  await js(`document.querySelector('.row[data-provider="kimi"] button.btn').click()`);
  await sleep(240);
  const closesBefore = (await js('window.__probe.calls()')).close;
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(60);
  const escNotice = await js(`(() => {
    const n = document.querySelector('.notice');
    return { hidden: n.hidden, text: n.querySelector('.notice__text').textContent };
  })()`);
  await sleep(240);
  const closesAfter = (await js('window.__probe.calls()')).close;
  check('Esc does not quietly eat itself on the notice',
    escNotice.hidden === false && escNotice.text.length > 0, escNotice);
  check('Esc still closes the panel while a notice is on screen',
    closesAfter === closesBefore + 1, [closesBefore, closesAfter]);

  // ---- no innerHTML anywhere in shipped renderer ------------------------
  say(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}  (${lines.filter(l=>l.startsWith('PASS')).length} pass)`);
  app.exit(failures === 0 ? 0 : 1);
}).catch((err) => {
  say('THREW: ' + (err && err.stack ? err.stack : err));
  app.exit(1);
});
