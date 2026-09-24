'use strict';
/**
 * End-to-end smoke test of the main<->renderer surface, in a real Electron
 * process. Drives the hardened window against `src/main/placeholder.html`
 * (a page this lane owns) so it does not depend on the renderer lane's build.
 *
 *   npx electron scripts/smoke-ipc.js
 *
 * Exits 0 on pass, 1 on failure, and prints one line per check. Set SMOKE_OUT
 * to also append the lines to a file: Electron's stdout does not reliably
 * reach a pipe on Windows.
 */
const fs = require('node:fs');
const path = require('node:path');
const { app, ipcMain, screen } = require('electron');

const { IPC, IPC_EXT } = require('../src/shared/contract');
const { Collector } = require('../src/core/collector');
const { PanelWindow, isPlausibleDipRect } = require('../src/main/panel-window');
const { isProviderId } = require('../src/core/providers');
const { withEnabled } = require('../src/core/enabled');
const { isTheme } = require('../src/core/theme');
const i18n = require('../src/core/i18n');
const { usageNotchApiMethods } = require('../test/helpers/contract-api');
const {
  osLocale, createSetLanguageHandler, createLocaleResolver, createApplyLanguage, createPreferences,
} = require('../src/main/language-ipc');
const { createSetPlanLabelHandler } = require('../src/main/plan-label-ipc');
const { createSetAutostartHandler } = require('../src/main/autostart-ipc');
const { createRefreshHandler } = require('../src/main/refresh-ipc');
const settingsStore = require('../src/main/settings');
const security = require('../src/main/security');

security.applyAll();

const OUT = process.env.SMOKE_OUT || path.join(require('node:os').tmpdir(), 'usage-notch-smoke.txt');
try { fs.writeFileSync(OUT, ''); } catch { /* best effort */ }

function say(line) {
  process.stdout.write(line + '\n');
  try { fs.appendFileSync(OUT, line + '\n'); } catch { /* best effort */ }
}

// A smoke test that hangs is a failed smoke test.
setTimeout(() => {
  say('FAIL  watchdog: a check never settled');
  app.exit(1);
}, 60000).unref();

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok) });
  say(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  (${detail})` : ''}`);
}

/** Bounds every await so a hang points at one specific step. */
function within(label, promise, ms = 15000) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error(`timed out: ${label}`)), ms).unref();
    }),
  ]);
}

app.whenReady().then(async () => {
  // Same order as bootstrap(): the store is loaded before the window exists,
  // so `initialSnapshot()` has something to return in the renderer's first
  // frame.
  const collector = new Collector({
    userDataDir: app.getPath('userData'),
    workerPath: path.join(__dirname, '..', 'src', 'core', 'scan', 'worker.js'),
  });
  let panel = null;
  collector.on('snapshot', (snapshot) => { if (panel) panel.send(IPC.SNAPSHOT, snapshot); });
  collector.start();

  panel = new PanelWindow({ entry: path.join(__dirname, '..', 'src', 'main', 'placeholder.html') });
  panel.create();

  let panelOpenedSeen = false;
  ipcMain.on(IPC.PANEL_OPENED, () => {
    panelOpenedSeen = true;
    // Mirrors src/main/index.js: the message is a hint, and main only believes
    // it when the window is actually on screen.
    if (panel && panel.isVisible()) collector.setPanelOpen(true);
  });
  ipcMain.on(IPC_EXT.INITIAL_SNAPSHOT, (e) => {
    // Mirrors src/main/index.js exactly, sender check included: if that
    // predicate were wrong the renderer would silently get null and fall back
    // to skeleton rows on every warm start.
    const ours = Boolean(panel && panel.win && !panel.win.isDestroyed() && e.sender === panel.win.webContents);
    e.returnValue = ours && collector ? (collector.snapshot || null) : null;
  });
  // Mirrors src/main/index.js, sender check included. A `returnValue` left
  // unset on this channel hangs the renderer before its first paint, which is
  // the failure the synchronous getter exists to trade against.
  let theme = 'system';
  // The language half runs the REAL SET_LANGUAGE handler from language-ipc.js,
  // the one index.js registers, with the real settings store. Persistence goes
  // to a throwaway directory, never the user's settings file.
  const langDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'usage-notch-smoke-lang-'));
  const langSettings = settingsStore.load(langDir);
  const planApplies = [];
  // The same factories index.js builds its resolver, apply and preferences()
  // from, so the smoke runs that code rather than a re-typed copy of it.
  const resolveLocale = createLocaleResolver({
    getSettings: () => langSettings,
    readOs: () => osLocale(app),
    setLocale: i18n.setLocale,
    log: { info: () => {} },
  });
  let locale = resolveLocale();
  let languagePushes = 0;
  let languageApplies = 0;
  const currentPrefs = createPreferences({
    getSettings: () => ({ ...langSettings, theme }),
    currentLocale: () => locale,
    readOs: () => osLocale(app),
  });
  const applyLanguage = createApplyLanguage({
    refreshLocale: () => { languageApplies += 1; locale = resolveLocale(); return locale; },
    getTray: () => null, // no tray in the smoke, so no menu rebuild
    trayMenuOptions: () => ({}),
    resetTooltip: () => {},
    getCollector: () => collector,
  });
  const ours = (e) => Boolean(panel && panel.win && !panel.win.isDestroyed() && e.sender === panel.win.webContents);
  ipcMain.on(IPC_EXT.INITIAL_PREFERENCES, (e) => {
    e.returnValue = ours(e) ? currentPrefs() : null;
  });
  ipcMain.handle(IPC.SET_LANGUAGE, createSetLanguageHandler({
    fromPanel: ours,
    getSettings: () => langSettings,
    save: (next) => settingsStore.save(langDir, next),
    // Re-resolve, switch main's t(), and RE-PUBLISH the snapshot through the
    // collector — the step that reaches the panel.
    apply: applyLanguage,
    push: () => { languagePushes += 1; panel.send(IPC.PREFERENCES, currentPrefs()); },
    log: { warn: (m) => say(`warn: ${m}`) },
  }));
  // The plan label runs the REAL handler from plan-label-ipc.js, against the
  // smoke's own temp settings dir, so the validation the panel depends on is
  // exercised in a real Electron process rather than in a copy of it.
  ipcMain.handle(IPC.SET_PLAN_LABEL, createSetPlanLabelHandler({
    fromPanel: ours,
    getSettings: () => langSettings,
    save: (next) => settingsStore.save(langDir, next),
    apply: (id, label) => { planApplies.push(`${id}=${label}`); },
    log: { warn: (m) => say(`warn: ${m}`) },
  }));
  // "Start with Windows" runs the REAL handler from autostart-ipc.js, against
  // the smoke's temp settings dir. The login item is NEVER touched here: apply
  // is a no-op, so a smoke run cannot register a Run key on this machine.
  ipcMain.handle(IPC.SET_AUTOSTART, createSetAutostartHandler({
    fromPanel: ours,
    getSettings: () => langSettings,
    save: (next) => settingsStore.save(langDir, next),
    apply: () => {},
    rebuildTrayMenu: () => {}, // no tray in the smoke
    push: () => panel.send(IPC.PREFERENCES, currentPrefs()),
    log: { warn: (m) => say(`warn: ${m}`) },
  }));
  ipcMain.handle(IPC.SET_THEME, (_event, value) => {
    // Mirrors src/main/index.js: validated against the three literals, then
    // applied. Persistence is skipped so the smoke run never writes the real
    // user's settings file.
    if (!isTheme(value)) return { ok: false };
    theme = value;
    panel.send(IPC.PREFERENCES, currentPrefs());
    return { ok: true };
  });

  // The real handler from refresh-ipc.js. No process is spawned here: the probe
  // answers 'unknown', which never produces a notice; what is exercised is the
  // scan and the reply read after it.
  ipcMain.handle(IPC.REQUEST_REFRESH, createRefreshHandler({
    fromPanel: ours,
    startProbe: async () => 'unknown',
    refresh: () => collector.refreshNow(),
    awaitProbe: (probe) => probe,
    latestSnapshot: () => collector.snapshot,
    log: { warn: (m) => say(`warn: ${m}`) },
  }));
  ipcMain.handle(IPC.RUN_SETUP, async (_event, id) => ({ ok: false, message: `stub:${id}` }));
  let enabledSeen = null;
  ipcMain.handle(IPC.SET_ENABLED, (_event, id, enabled) => {
    // Mirrors src/main/index.js: validate, then apply. Persistence is skipped
    // here so the smoke run never writes the real user's settings file.
    if (!isProviderId(id) || typeof enabled !== 'boolean') return { ok: false };
    enabledSeen = collector.setEnabled(withEnabled(collector.enabled, id, enabled));
    return { ok: true };
  });
  let orderSeen = null;
  ipcMain.handle(IPC.SET_ORDER, (_event, ids) => {
    // Mirrors src/main/index.js: validate, then apply. Persistence is skipped
    // here so the smoke run never writes the real user's settings file.
    orderSeen = collector.setOrder(ids);
    return { ok: true };
  });

  await within('did-finish-load', new Promise((r) => panel.win.webContents.once('did-finish-load', r)));
  say('step: renderer loaded');
  await within('first scan', new Promise((r) => collector.once('scan-settled', r)), 40000);
  say('step: first scan settled');

  const wc = panel.win.webContents;
  const ev = (js) => within(js.slice(0, 44), wc.executeJavaScript(js, true));

  check('contextBridge exposes usageNotch', await ev('typeof window.usageNotch === "object"'));
  check('raw ipcRenderer / require are not reachable',
    await ev('typeof window.ipcRenderer === "undefined" && typeof window.require === "undefined"'));
  check('node globals are absent (sandbox on, nodeIntegration off)',
    await ev('typeof window.process === "undefined" && typeof window.Buffer === "undefined"'));
  check('no generic passthrough on the bridge',
    await ev('typeof window.usageNotch.invoke === "undefined" && typeof window.usageNotch.send === "undefined"'));

  // Derived from contract.ts through the same parser contract-mirror.test.js
  // uses. This list was hand-typed here and drifted twice (onPanelVisibility,
  // then setLanguage) while the unit test that parsed the contract stayed green.
  const api = await ev('Object.keys(window.usageNotch).sort().join(",")');
  const declaredApi = usageNotchApiMethods().join(',');
  check('bridge surface is exactly UsageNotchApi, as parsed from contract.ts',
    api === declaredApi, api === declaredApi ? api : `exposed=${api} declared=${declaredApi}`);

  // The whole point of initialSnapshot: real data, synchronously, frame one.
  const sync = await ev('(function () { var s = window.usageNotch.initialSnapshot(); return s === null ? "null" : (typeof s.generatedAt) + ":" + s.providers.length; })()');
  check('initialSnapshot() returns a real Snapshot synchronously', sync === 'string:6', sync);

  const rows = await ev('document.getElementById("rows").children.length');
  check('SNAPSHOT reached the renderer and rendered a row per provider', rows === 6, `rows=${rows}`);

  const providers = await ev('window.usageNotch.requestRefresh().then(s => s.providers.length)');
  check('REQUEST_REFRESH round-trips a Snapshot', providers === 6, `providers=${providers}`);

  const setup = await ev('window.usageNotch.runSetup("gemini", true).then(r => r.ok + ":" + r.message)');
  check('RUN_SETUP round-trips without throwing', setup === 'false:stub:gemini', setup);

  // Drag order: the renderer sends ids, main validates them against the real
  // registry and re-emits a snapshot whose providers[0] is what the tray draws.
  const ordered = await ev('window.usageNotch.setOrder(["kimi", "not-a-provider"]).then(function (r) { return r.ok; })');
  check('SET_ORDER round-trips and main drops the id that is not a provider',
    ordered === true && JSON.stringify(orderSeen) === '["kimi"]', `ok=${ordered} applied=${JSON.stringify(orderSeen)}`);
  check('the re-emitted snapshot is in user order and still has every provider',
    collector.snapshot.providers[0].id === 'kimi' && collector.snapshot.providers.length === 6,
    `first=${collector.snapshot.providers[0].id} count=${collector.snapshot.providers.length}`);
  await ev('window.usageNotch.setOrder([])');

  // Enablement: the snapshot still carries ALL providers (the settings view
  // needs the full list), and `enabled` is what tells the panel and the tray
  // which of them the user actually added.
  const defaults = collector.snapshot.providers
    .map(function (p) { return p.id + '=' + p.enabled; }).join(',');
  check('every provider ships with its default enablement',
    /claude=true/.test(defaults) && !/kimi=true/.test(defaults), defaults);

  const added = await ev('window.usageNotch.setEnabled("kimi", true).then(function (r) { return r.ok; })');
  check('SET_ENABLED round-trips and reaches the snapshot',
    added === true && collector.snapshot.providers.find(function (p) { return p.id === 'kimi'; }).enabled === true,
    `ok=${added} applied=${JSON.stringify(enabledSeen)}`);

  const bogus = await ev('window.usageNotch.setEnabled("not-a-provider", true).then(function (r) { return r.ok; })');
  check('an id that is not a provider is refused, and nothing changed',
    bogus === false && collector.snapshot.providers.length === 6, `ok=${bogus}`);
  await ev('window.usageNotch.setEnabled("kimi", false)');

  // ---- preferences ------------------------------------------------------
  // The synchronous half is the whole point: a theme applied after first paint
  // is a visible flash of the wrong one, and only sendSync can beat the frame.
  const prefs = await ev('(function () { var p = window.usageNotch.initialPreferences(); return p === null ? "null" : p.theme; })()');
  check('initialPreferences() returns a real Preferences synchronously', prefs === 'system', prefs);

  const pushed = ev('new Promise(function (res) { var off = window.usageNotch.onPreferences(function (p) { off(); res(p.theme); }); })');
  await new Promise((r) => setTimeout(r, 100));
  const themed = await ev('window.usageNotch.setTheme("light").then(function (r) { return r.ok; })');
  check('setTheme() persists a real ThemeChoice', themed === true && theme === 'light', `ok=${themed} theme=${theme}`);
  check('the accepted theme is pushed back on PREFERENCES', (await pushed) === 'light');

  const badTheme = await ev('window.usageNotch.setTheme("nocturne").then(function (r) { return r.ok; })');
  check('a theme outside the three literals is rejected and changes nothing',
    badTheme === false && theme === 'light', `ok=${badTheme} theme=${theme}`);
  await ev('window.usageNotch.setTheme("system")');

  // ---- plan label ---------------------------------------------------------
  // The REAL SET_PLAN_LABEL handler, over the real preload, in a real Electron
  // process. The renderer reverts its control on {ok:false}, so every rejection
  // has to leave the stored map untouched, not merely answer false.
  const planned = await ev('window.usageNotch.setPlanLabel("claude", "  Max 20x  ").then(function (r) { return r.ok; })');
  check('setPlanLabel() accepts free text and trims it',
    planned === true && langSettings.planLabels.claude === 'Max 20x',
    `ok=${planned} stored=${JSON.stringify(langSettings.planLabels)}`);
  check('the accepted label is applied after the write', planApplies.includes('claude=  Max 20x  '));

  const capped = await ev(`window.usageNotch.setPlanLabel("codex", "${'v'.repeat(90)}").then(function (r) { return r.ok; })`);
  check('a very long label is capped at 24 characters, not stored whole',
    capped === true && langSettings.planLabels.codex === 'v'.repeat(24),
    `ok=${capped} len=${(langSettings.planLabels.codex || '').length}`);

  const badId = await ev('window.usageNotch.setPlanLabel("notATool", "Enterprise").then(function (r) { return r.ok; })');
  check('an unknown provider id is rejected and stores nothing',
    badId === false && langSettings.planLabels.notATool === undefined,
    `ok=${badId} stored=${JSON.stringify(langSettings.planLabels)}`);

  const cleared = await ev('window.usageNotch.setPlanLabel("claude", "   ").then(function (r) { return r.ok; })');
  check('a blank label clears the setting rather than storing an empty string',
    cleared === true && !Object.prototype.hasOwnProperty.call(langSettings.planLabels, 'claude'),
    `ok=${cleared} stored=${JSON.stringify(langSettings.planLabels)}`);

  const persisted = settingsStore.load(langDir).planLabels;
  check('what the channel wrote is what the next launch reads',
    persisted.codex === 'v'.repeat(24) && persisted.claude === undefined,
    JSON.stringify(persisted));

  // ---- hidden means hidden --------------------------------------------------
  // Since c388115 the OS window is composited ONCE in create() and never hidden
  // again: "hidden" is `panel.isVisible() === false` (the logical flag) plus a
  // window rect that lies on no display. `win.isVisible()` is true for the
  // whole process life and says nothing about what the user sees, so it is not
  // read here. These are PRECONDITIONS for the checks below; a broken one
  // reports as itself rather than as a failure of whatever runs next.
  const onNoDisplay = () => {
    const b = panel.win.getBounds();
    return screen.getAllDisplays().every((d) => {
      const r = d.bounds;
      return b.x + b.width <= r.x || b.x >= r.x + r.width || b.y + b.height <= r.y || b.y >= r.y + r.height;
    });
  };
  const hiddenState = () => `logical=${panel.isVisible()} onNoDisplay=${onNoDisplay()} bounds=${JSON.stringify(panel.win.getBounds())}`;
  const isHidden = () => panel.isVisible() === false && onNoDisplay();
  check('precondition: the panel is hidden before the language checks', isHidden(), hiddenState());

  // A plain re-publish with no language change: the snapshot emit path alone
  // must not bring a hidden panel on screen.
  collector.rebuild();
  await new Promise((r) => setTimeout(r, 200));
  check('a plain collector.rebuild() leaves a hidden panel hidden', isHidden(), hiddenState());

  // ---- language -----------------------------------------------------------
  // SET_LANGUAGE through the real handler. Not optimistic: the renderer learns
  // the language only from the PREFERENCES push, so the push is checked, not
  // just the reply. Set tr first so the switch to en is a real change on any
  // machine, whatever its OS language.
  const initialLang = await ev('(function () { var p = window.usageNotch.initialPreferences(); return p && p.language + "/" + p.resolvedLanguage + "/" + p.formatLocale; })()');
  check('initialPreferences() carries language, resolvedLanguage and formatLocale',
    typeof initialLang === 'string' && /^system\/(tr|en)\/[a-z]{2}-[A-Z0-9]+$/.test(initialLang), initialLang);

  const toTr = await ev('window.usageNotch.setLanguage("tr").then(function (r) { return r.ok; })');
  check('setLanguage("tr") is accepted and resolves to Turkish',
    toTr === true && locale.resolvedLanguage === 'tr' && locale.formatLocale === 'tr-TR',
    `ok=${toTr} resolved=${locale.resolvedLanguage} format=${locale.formatLocale}`);

  const langPushed = ev('new Promise(function (res) { var off = window.usageNotch.onPreferences(function (p) { off(); res(p.language + "/" + p.resolvedLanguage + "/" + p.formatLocale); }); })');
  await new Promise((r) => setTimeout(r, 100));
  const pushesBefore = languagePushes;
  const toEn = await ev('window.usageNotch.setLanguage("en").then(function (r) { return r.ok; })');
  check('setLanguage("en") persists to settings.json',
    toEn === true && settingsStore.load(langDir).language === 'en', `ok=${toEn} onDisk=${settingsStore.load(langDir).language}`);
  check('resolvedLanguage changed from tr to en in main', locale.resolvedLanguage === 'en', locale.resolvedLanguage);
  const pushedLang = await langPushed;
  check('the new language is pushed on PREFERENCES, after it was applied',
    languagePushes === pushesBefore + 1 && /^en\/en\/en-/.test(pushedLang), `pushed=${pushedLang}`);

  const applyBefore = languageApplies;
  const pushBefore = languagePushes;
  const fileBefore = fs.readFileSync(path.join(langDir, 'settings.json'), 'utf8');
  const badLang = await ev('window.usageNotch.setLanguage("de").then(function (r) { return JSON.stringify(r); })');
  await new Promise((r) => setTimeout(r, 200));
  check('a language outside the three literals is {ok:false} and changes nothing',
    badLang === '{"ok":false}'
      && fs.readFileSync(path.join(langDir, 'settings.json'), 'utf8') === fileBefore
      && languageApplies === applyBefore && languagePushes === pushBefore
      && locale.resolvedLanguage === 'en' && langSettings.language === 'en',
    `reply=${badLang} applies=+${languageApplies - applyBefore} pushes=+${languagePushes - pushBefore}`);
  try { fs.rmSync(langDir, { recursive: true, force: true }); } catch { /* best effort */ }
  // Two language switches, each re-publishing the snapshot, and the panel is
  // still where it was: off every display, logically closed.
  check('changing the language leaves a hidden panel hidden', isHidden(), hiddenState());
  i18n.setLocale('tr', 'tr-TR');

  check('precondition: the panel is hidden before PANEL_OPENED is sent', isHidden(), hiddenState());
  await ev('window.usageNotch.panelOpened()');
  await new Promise((r) => setTimeout(r, 300));
  check('PANEL_OPENED reached main', panelOpenedSeen);
  // The renderer sends panelOpened() while mounting, which happens with the
  // window still hidden. Believing it there would pin the collector at the
  // 15s open cadence for the whole session and disable the watcher gating.
  // Hidden is the LOGICAL state plus an off-display rect — see above.
  check('a hidden panel is not treated as open, however loudly it announces itself',
    collector.panelOpen === false && isHidden(),
    `panelOpen=${collector.panelOpen} ${hiddenState()}`);

  // Anchoring: the renderer needs the scale factor of the display that owns
  // the tray icon, not the primary display.
  const anchorSeen = ev('new Promise(function (res) { var off = window.usageNotch.onAnchor(function (a) { off(); res(JSON.stringify(a)); }); })');
  await new Promise((r) => setTimeout(r, 200));
  // A realistic DIP tray rect for THIS display: sitting on the taskbar strip
  // at the bottom right, the shape `Tray.getBounds()` actually returns.
  const home = screen.getPrimaryDisplay();
  const taskbarThickness = Math.max(1, home.bounds.height - home.workArea.height) || 48;
  const trayRect = {
    x: home.workArea.x + home.workArea.width - 120,
    y: home.workArea.y + home.workArea.height,
    width: 33,
    height: taskbarThickness,
  };
  panel.showInactive(trayRect, (a) => panel.sendAnchor(a));
  const anchor = JSON.parse(await anchorSeen);
  check('ANCHOR carries tray rect, owning-display scale factor and window rect',
    Boolean(anchor.tray && anchor.window && typeof anchor.display.scaleFactor === 'number' && anchor.display.workArea),
    `scaleFactor=${anchor.display.scaleFactor} edge=${anchor.edge}`);
  check('anchor edge and mode use the contract vocabulary',
    ['bottom', 'top', 'left', 'right'].includes(anchor.edge) && ['hover', 'pin'].includes(anchor.mode),
    `edge=${anchor.edge} mode=${anchor.mode}`);
  check('hover open shows the panel without taking focus',
    panel.win.isVisible() && !panel.win.isFocused());

  // ---- coordinate space -------------------------------------------------
  // The renderer computes its tail as `tray.x + tray.width/2 - window.x` with
  // NO scale multiplication. That is correct only while Tray, BrowserWindow
  // and Display all report DIP. If one ever switched to physical pixels the
  // tail would silently land a quarter-panel away at 1.25x, so assert it.
  check('a DIP tray rect survives the plausibility guard', anchor.tray !== null,
    `tray=${JSON.stringify(anchor.tray)}`);
  check('a real tray rect is reported as anchorSource "tray"', anchor.anchorSource === 'tray',
    `anchorSource=${anchor.anchorSource}`);

  // Windows 11 puts new tray icons in the hidden-icons overflow, where
  // getBounds() reports zero size and TrayController.bounds() returns null.
  // `tray` is non-nullable in the contract, so main must synthesise a rect
  // rather than send null and have the renderer discard `edge` and `mode`
  // along with it.
  const noTray = panel.positionFor(null);
  check('an unavailable tray rect still yields a complete, non-null anchor',
    noTray.tray !== null
      && Number.isFinite(noTray.tray.x) && noTray.tray.width > 0
      && noTray.anchorSource === 'cursor'
      && ['bottom', 'top', 'left', 'right'].includes(noTray.edge),
    `tray=${JSON.stringify(noTray.tray)} anchorSource=${noTray.anchorSource} edge=${noTray.edge}`);

  const implausible = panel.positionFor({ x: 999999, y: 999999, width: 24, height: 24 });
  check('an implausible tray rect degrades to the cursor anchor, not to null',
    implausible.tray !== null && implausible.anchorSource === 'cursor',
    `anchorSource=${implausible.anchorSource}`);

  const disp = screen.getDisplayNearestPoint({ x: trayRect.x, y: trayRect.y });
  const inside = (r, b) => r.x >= b.x && r.y >= b.y
    && r.x + r.width <= b.x + b.width && r.y + r.height <= b.y + b.height;
  check('tray rect lies inside its display bounds, i.e. both are the same space',
    anchor.tray && inside(anchor.tray, disp.bounds),
    `tray=${JSON.stringify(anchor.tray)} bounds=${JSON.stringify(disp.bounds)}`);

  // The failure this guards against is silent: a physical-pixel rect looks
  // perfectly well formed, it just points a quarter-panel away at 1.25x.
  const physicalLooking = {
    x: Math.round(trayRect.x * disp.scaleFactor),
    y: Math.round(trayRect.y * disp.scaleFactor),
    width: Math.round(trayRect.width * disp.scaleFactor),
    height: Math.round(trayRect.height * disp.scaleFactor),
  };
  const rejected = disp.scaleFactor === 1 || isPlausibleDipRect(physicalLooking) === false;
  check('a physical-pixel tray rect is rejected rather than silently mispositioned',
    rejected,
    disp.scaleFactor === 1 ? 'skipped: display is 1.0x' : `physical=${JSON.stringify(physicalLooking)}`);

  if (typeof screen.dipToScreenRect === 'function') {
    const phys = screen.dipToScreenRect(null, disp.bounds);
    check('display.bounds is DIP: scaling it up gives the physical rect',
      Math.round(disp.bounds.width * disp.scaleFactor) === phys.width,
      `dip=${disp.bounds.width} x${disp.scaleFactor} -> physical=${phys.width}`);
  }

  const probe = { x: disp.workArea.x + 40, y: disp.workArea.y + 40, width: 300, height: 200 };
  panel.win.setBounds(probe);
  const readBack = panel.win.getBounds();
  check('window bounds round-trip in DIP (x,y exact)',
    readBack.x === probe.x && readBack.y === probe.y,
    `set=${probe.x},${probe.y} got=${readBack.x},${readBack.y}`);

  // Re-anchor and let the renderer reflow before reading its viewport, so the
  // comparison below is against the window's real current size.
  const reAnchor = panel.positionFor(trayRect);
  await new Promise((r) => setTimeout(r, 250));
  const viewport = await ev('window.innerWidth + "x" + window.innerHeight');
  check('anchor.window reports the OS rect the renderer must clamp against',
    reAnchor.window.width > 0 && `${reAnchor.window.width}x${reAnchor.window.height}` === viewport,
    `anchor.window=${reAnchor.window.width}x${reAnchor.window.height} cssViewport=${viewport}`);

  // Clamping: a tray icon in the extreme bottom-right corner is exactly where
  // centring the panel on the icon would push half of it off-screen.
  const corner = {
    x: home.workArea.x + home.workArea.width - 8,
    y: home.workArea.y + home.workArea.height,
    width: 8,
    height: taskbarThickness,
  };
  const clamped = panel.positionFor(corner);
  const w = home.workArea;
  const fits = clamped.window.x >= w.x
    && clamped.window.y >= w.y
    && clamped.window.x + clamped.window.width <= w.x + w.width
    && clamped.window.y + clamped.window.height <= w.y + w.height;
  check('the panel is clamped into the work area at a corner, not centred off-screen',
    fits,
    `window=${JSON.stringify(clamped.window)} workArea=${JSON.stringify(w)}`);

  // Activation: hover must not steal focus, pin must take it. The renderer
  // keys its keyboard path on `mode !== 'hover'`, so these must agree.
  let pinMode = null;
  panel.pin(trayRect, (a) => { pinMode = a.mode; });
  await new Promise((r) => setTimeout(r, 300));
  check('pin activates the window and reports mode "pin"',
    panel.win.isVisible() && panel.win.isFocused() && pinMode === 'pin',
    `visible=${panel.win.isVisible()} focused=${panel.win.isFocused()} mode=${pinMode}`);
  panel.hide();

  const blocked = await ev('fetch("https://example.com").then(function () { return "reached"; }).catch(function () { return "blocked"; })');
  check('outbound HTTPS from the renderer is blocked at the session layer', blocked === 'blocked', blocked);

  collector.stop();
  const failed = checks.filter((c) => !c.ok).length;
  say(`${checks.length - failed}/${checks.length} checks passed`);
  app.exit(failed === 0 ? 0 : 1);
}).catch((err) => {
  say(`FAIL  smoke crashed: ${err && err.message}`);
  app.exit(1);
});
