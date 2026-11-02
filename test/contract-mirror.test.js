'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { IPC } = require('../src/shared/contract');
const { usageNotchApiMethods } = require('./helpers/contract-api');

/**
 * `src/shared/contract.ts` is orchestrator-owned and cannot be edited by this
 * lane, and it cannot be required at runtime from a CommonJS main process or
 * from a sandboxed preload. Two places therefore restate its channel names:
 * `src/shared/contract.js` and `src/main/preload.js`.
 *
 * These tests are the only thing standing between that arrangement and silent
 * drift, where a renamed channel would show up as a panel that simply never
 * updates.
 */
const ROOT = path.join(__dirname, '..');

function contractSource() {
  return fs.readFileSync(path.join(ROOT, 'src', 'shared', 'contract.ts'), 'utf8');
}

/** Parses the `export const IPC = { ... } as const;` block. */
function channelsFromContract() {
  const src = contractSource();
  const start = src.indexOf('export const IPC');
  assert.notEqual(start, -1, 'contract.ts no longer declares `export const IPC`');
  const block = src.slice(start, src.indexOf('} as const;', start));
  const out = {};
  const re = /^\s*([A-Z_]+):\s*'([^']+)'/gm;
  let m;
  while ((m = re.exec(block)) !== null) out[m[1]] = m[2];
  return out;
}

test('the runtime mirror matches contract.ts exactly', () => {
  const expected = channelsFromContract();
  assert.ok(Object.keys(expected).length >= 6, 'parsed too few channels; the parser is wrong');
  assert.deepEqual(IPC, expected);
});

test('the preload exposes the same channel strings', () => {
  const expected = channelsFromContract();
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8');
  for (const [name, channel] of Object.entries(expected)) {
    assert.ok(
      preload.includes(`${name}: '${channel}'`),
      `preload.js is missing or has renamed ${name} ('${channel}')`,
    );
  }
});

test('the preload exposes no generic invoke passthrough', () => {
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8');
  assert.equal(/invoke:\s*\(/.test(preload), false, 'a generic invoke() would hand the renderer the whole IPC surface');
  assert.equal(/send:\s*\(/.test(preload), false, 'same for a generic send()');
  assert.equal(preload.includes('exposeInMainWorld'), true);
  assert.equal(preload.includes('ipcRenderer,'), false, 'ipcRenderer itself must never be exposed');
});

test('the extension channels do not collide with a contract channel', () => {
  const { IPC_EXT } = require('../src/shared/contract');
  assert.deepEqual(Object.keys(IPC_EXT), ['INITIAL_SNAPSHOT', 'INITIAL_PREFERENCES']);
  for (const value of Object.values(IPC_EXT)) {
    assert.equal(Object.values(IPC).includes(value), false);
  }
});

test('the preload uses the same INITIAL_* literals as the main process', () => {
  // Neither is in contract.ts, so the channel-name loop above never sees them.
  // Renaming one on a single side would make its getter silently return null
  // for ever — skeleton rows on every warm start for the snapshot, the default
  // theme over the user's choice for the preferences — with nothing failing.
  const { IPC_EXT } = require('../src/shared/contract');
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8');
  for (const name of ['INITIAL_SNAPSHOT', 'INITIAL_PREFERENCES']) {
    assert.ok(
      preload.includes(`${name}: '${IPC_EXT[name]}'`),
      `preload.js does not declare the ${name} literal`,
    );
    assert.ok(
      preload.includes(`sendSync(CH.${name})`),
      `preload.js must call ${name} synchronously, or it cannot paint frame one`,
    );
    assert.ok(
      main.includes(`IPC_EXT.${name}`),
      `src/main/index.js must register a listener for ${name}`,
    );
  }
});

test('every sendSync channel main serves sets returnValue on all paths', () => {
  // An ipcMain listener that returns without setting `returnValue` blocks the
  // calling renderer indefinitely. On the preferences channel that would be a
  // panel that never paints at all, because the renderer asks for the theme
  // before its first frame.
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8');
  for (const name of ['IPC_EXT.INITIAL_SNAPSHOT', 'IPC_EXT.INITIAL_PREFERENCES']) {
    const start = main.indexOf(name);
    assert.notEqual(start, -1, `${name} has no listener`);
    const body = main.slice(start, main.indexOf('});', start));
    assert.ok(body.includes('event.returnValue ='), `${name} must assign returnValue`);
    assert.equal(
      /return;/.test(body), false,
      `an early return in ${name} would leave returnValue unset and hang the renderer`,
    );
  }
});

test('the anchor channel now comes from the contract, not from our extension', () => {
  assert.equal(IPC.ANCHOR, 'panel:anchor');
  assert.equal(channelsFromContract().ANCHOR, 'panel:anchor');
});

test('the preload exposes exactly the UsageNotchApi surface declared in contract.ts', () => {
  // The same parser the Electron smoke uses, so the two cannot disagree about
  // what the contract declares (test/helpers/contract-api.js).
  const declared = new Set(usageNotchApiMethods(contractSource()));
  assert.ok(declared.has('initialSnapshot'), 'parser failed to find the methods');

  const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8');
  const exposed = preload.slice(preload.indexOf('exposeInMainWorld'));
  for (const name of declared) {
    assert.ok(
      new RegExp(`(^|[\\s{,])${name}\\s*:`, 'm').test(exposed),
      `preload.js does not expose ${name}()`,
    );
  }
  assert.ok(declared.has('setOrder'), 'contract.ts should declare setOrder()');
  assert.ok(declared.has('setEnabled'), 'contract.ts should declare setEnabled()');
  assert.ok(declared.has('initialPreferences'), 'contract.ts should declare initialPreferences()');
  assert.ok(declared.has('setTheme'), 'contract.ts should declare setTheme()');
  assert.ok(declared.has('onPanelVisibility'), 'contract.ts should declare onPanelVisibility()');
  assert.ok(declared.has('setLanguage'), 'contract.ts should declare setLanguage()');
  // The plan the user says they are on, per tool. Write-only like the rest;
  // the value comes BACK on the snapshot as `ProviderSnapshot.planLabel`, not
  // from a getter here.
  assert.ok(declared.has('setPlanLabel'), 'contract.ts should declare setPlanLabel()');
  // "Start with Windows" in the settings screen, the value the tray checkbox
  // already had. A setter; it comes back on `Preferences.autostart`.
  assert.ok(declared.has('setAutostart'), 'contract.ts should declare setAutostart()');
  // The way back from the setup's statusLine hook. Main raises the
  // confirmation and answers {ok, message}.
  assert.ok(declared.has('disconnectProvider'), 'contract.ts should declare disconnectProvider()');
  // "Şimdi değil" on the first-run card (UI plan 2026-09-29): a local write,
  // no network.
  assert.ok(declared.has('setSetupCoachDismissed'), 'contract.ts should declare setSetupCoachDismissed()');
  // 18 since the optional API key was removed (2026-09-28), 19 with the
  // first-run card's setter (2026-09-29), 20 with setPointerOverPanel, the
  // click-through report (2026-10-01; local window state, no network). The
  // count is asserted so a new channel — above all one that reaches the
  // network — cannot arrive unnoticed.
  assert.ok(declared.has('setPointerOverPanel'), 'contract.ts should declare setPointerOverPanel()');
  // 21 with setTrayView (2026-10-20): Görünüm, tray icon or taskbar strip. A
  // local settings write; the strip itself speaks only IPC_STRIP, below.
  assert.ok(declared.has('setTrayView'), 'contract.ts should declare setTrayView()');
  // 22 with setGauge (2026-10-21), and 21 again without it (2026-10-22): the
  // Gösterge choice went with the old layouts.
  assert.equal(declared.has('setGauge'), false, 'setGauge() belonged to the removed Gösterge setting');
  for (const gone of ['requestKeyEntry', 'removeKey', 'openTokenPage', 'refreshKey']) {
    assert.equal(declared.has(gone), false, `${gone}() belonged to the removed key feature`);
  }
  // 23 with setReduceTransparency (2026-10-21), the switch that became the
  // "Saydamlık" slider's setTransparency (2026-10-22): a level 0–100. A local
  // settings write; no network.
  assert.ok(declared.has('setTransparency'), 'contract.ts should declare setTransparency()');
  assert.equal(declared.has('setReduceTransparency'), false, 'setReduceTransparency() became setTransparency()');
  // 24 with setPanelHeight (2026-10-21): a fitted Windows 11 window is the
  // panel, so main sizes it to the panel's height. Fire-and-forget, local.
  assert.ok(declared.has('setPanelHeight'), 'contract.ts should declare setPanelHeight()');
  // 25 with setLayout and setStripStyle (2026-10-21), and 24 again without
  // setLayout (2026-11-02): the one list left is THE panel, so there is no
  // Düzen to choose. Şerit stili (plain, rings, fill) is a local settings
  // write; no network.
  assert.equal(declared.has('setLayout'), false, 'setLayout() belonged to the removed Düzen setting');
  assert.ok(declared.has('setStripStyle'), 'contract.ts should declare setStripStyle()');
  assert.equal(declared.size, 24, `expected the 24 declared methods, saw ${[...declared].join(',')}`);
});

/** Parses `export const IPC_STRIP = { ... } as const;`. */
function stripChannelsFromContract() {
  const src = contractSource();
  const start = src.indexOf('export const IPC_STRIP');
  assert.notEqual(start, -1, 'contract.ts no longer declares `export const IPC_STRIP`');
  const block = src.slice(start, src.indexOf('} as const;', start));
  const out = {};
  const re = /^\s*([A-Z_]+):\s*'([^']+)'/gm;
  let m;
  while ((m = re.exec(block)) !== null) out[m[1]] = m[2];
  return out;
}

test('the taskbar strip channels: one mirror, one preload, and none of them on the panel', () => {
  const expected = stripChannelsFromContract();
  assert.deepEqual(Object.keys(expected), ['DATA', 'OPEN', 'MENU', 'HOVER']);
  const { IPC_STRIP, IPC_EXT } = require('../src/shared/contract');
  assert.deepEqual(IPC_STRIP, expected);
  for (const value of Object.values(IPC_STRIP)) {
    assert.equal(Object.values(IPC).includes(value), false, `${value} collides with a panel channel`);
    assert.equal(Object.values(IPC_EXT).includes(value), false, `${value} collides with an extension channel`);
  }
  const stripPreload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'strip-preload.js'), 'utf8');
  for (const [name, channel] of Object.entries(expected)) {
    assert.ok(stripPreload.includes(`${name}: '${channel}'`), `strip-preload.js is missing ${name} ('${channel}')`);
  }
  // The strip page can subscribe and click, and nothing else: no panel
  // channel, no generic passthrough, never ipcRenderer itself.
  const exposed = stripPreload.slice(stripPreload.indexOf('exposeInMainWorld'));
  const methods = [...exposed.matchAll(/^ {2}([A-Za-z]+):/gm)].map((m) => m[1]);
  assert.deepEqual(methods, ['onData', 'open', 'menu', 'hover']);
  for (const channel of Object.values(IPC)) assert.equal(stripPreload.includes(`'${channel}'`), false, channel);
  assert.equal(/invoke\(/.test(stripPreload), false, 'the strip invokes nothing');
  assert.equal(stripPreload.includes('ipcRenderer,'), false);
  // And the panel's preload carries none of the strip's channels.
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8');
  for (const channel of Object.values(IPC_STRIP)) assert.equal(preload.includes(channel), false, channel);
  // Main takes a strip click only from the strip's own page.
  const main = codeOf(path.join(ROOT, 'src', 'main', 'index.js'));
  for (const name of ['OPEN', 'MENU', 'HOVER']) {
    const at = main.indexOf(`ipcMain.on(IPC_STRIP.${name}`);
    assert.notEqual(at, -1, `index.js does not listen on IPC_STRIP.${name}`);
    assert.ok(main.slice(at, at + 120).includes('if (!fromStrip(event)) return;'), `IPC_STRIP.${name} checks its sender`);
  }
});

/** Parses `export const STATE_THRESHOLDS = { ... } as const;`. */
function thresholdsFromContract() {
  const src = contractSource();
  const start = src.indexOf('export const STATE_THRESHOLDS');
  assert.notEqual(start, -1, 'contract.ts no longer declares STATE_THRESHOLDS');
  const block = src.slice(start, src.indexOf('}', start));
  const out = {};
  const re = /([a-z]+):\s*(\d+)/g;
  let m;
  while ((m = re.exec(block)) !== null) out[m[1]] = Number(m[2]);
  return out;
}

test('the state ramp mirror matches contract.ts exactly', () => {
  // This value has TWO independent consumers — the panel meter and the tray
  // donut. They shipped with different ramps once (60/85 vs 70/90), which put
  // a green icon next to an amber row at 62%. Same treatment as the channel
  // names: one declaration, and a test that fails on drift.
  const expected = thresholdsFromContract();
  assert.deepEqual(expected, { watch: 60, ember: 85, spent: 100 });
  const { STATE_THRESHOLDS } = require('../src/shared/contract');
  assert.deepEqual(STATE_THRESHOLDS, expected);
});

test('the tray donut reads the ramp from the contract rather than copying it', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'core', 'tray-spec.js'), 'utf8');
  assert.ok(
    /require\('\.\.\/shared\/contract'\)/.test(src),
    'tray-spec.js must consume the shared constant, not redeclare one',
  );
  const { STATE_THRESHOLDS, stateForPercentage } = require('../src/core/tray-spec');
  assert.deepEqual(STATE_THRESHOLDS, thresholdsFromContract());
  // The behaviour the constant exists for, at the value that exposed the bug.
  assert.equal(stateForPercentage(62), 'watch');
});

test('the panel meter has not drifted from the same ramp', () => {
  // The other consumer. It may either import the shared constant or keep its
  // literals, but if it keeps them they must be these.
  const file = path.join(ROOT, 'src', 'renderer', 'src', 'format.ts');
  if (!fs.existsSync(file)) return;
  const src = fs.readFileSync(file, 'utf8');
  const start = src.indexOf('export function stateFor');
  if (start === -1) return;
  const body = src.slice(start, src.indexOf('\n}', start));
  if (body.includes('STATE_THRESHOLDS')) return; // imports the shared value
  const literals = [...body.matchAll(/shown >= (\d+)/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
  const expected = thresholdsFromContract();
  assert.deepEqual(
    literals, [expected.watch, expected.ember, expected.spent],
    'src/renderer/src/format.ts stateFor() no longer matches contract.ts STATE_THRESHOLDS',
  );
});

/** Top-level field names of `export interface <name> { ... }` in contract.ts. */
function interfaceFields(name) {
  const src = contractSource().replace(/\r\n/g, '\n');
  const start = src.indexOf(`export interface ${name} {`);
  assert.notEqual(start, -1, `contract.ts no longer declares ${name}`);
  const body = src.slice(src.indexOf('{', start) + 1, src.indexOf('\n}', start));
  // Strip comments, then take `name:` / `name?:` at the interface's own indent.
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return [...code.matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*)\??:/gm)].map((m) => m[1]).sort();
}

test('the usage history main produces has exactly the shape contract.ts declares', () => {
  // The history crosses to the renderer through sanitize.ts, which drops what
  // the contract does not name. A field main adds without the contract (or the
  // reverse) is a figure that silently never reaches the settings section.
  const history = require('../src/core/history');
  const HOUR = 60 * 60 * 1000;
  const now = new Date(2026, 8, 9, 12, 0, 0).getTime();
  const at = history.weekStartMs(now) + HOUR;
  const out = history.usageHistory(
    [{ f: 'f', key: 'k', ts: at, model: 'claude-opus-5', input: 0, output: 1000, cacheWrite: 0, cacheRead: 0, cw5: 0, cw1h: 0 }],
    now,
    { codexEvents: [{ ts: at, model: 'gpt-5.6-sol', tier: 'standard', inputUncached: 10, cachedInput: 0, cacheWrite: 0, output: 10 }] },
  );
  assert.deepEqual(Object.keys(out).sort(), interfaceFields('UsageHistory'));
  assert.deepEqual(Object.keys(out.weeks[0]).sort(), interfaceFields('PeriodUsage'));
  const providers = new Set();
  for (const entry of out.weeks[0].byModel) {
    assert.deepEqual(Object.keys(entry).sort(), interfaceFields('PeriodModelCost'));
    providers.add(entry.provider);
  }
  assert.deepEqual([...providers].sort(), ['claude', 'codex']);
  assert.deepEqual(Object.keys(out.pricesAsOfByProvider).sort(), ['claude', 'codex']);
  // ADR-003 A6: always present; the facts a composed price note needs.
  assert.deepEqual(out.usageProviders, ['claude', 'codex']);
  assert.deepEqual(out.floorCausesByProvider, {});
  // With all four tools: every entry keeps the PeriodModelCost shape, and each
  // cause code is one the contract's HistoryFloorCause union declares.
  const four = history.usageHistory(
    [{ f: 'f', key: 'k', ts: at, model: 'claude-opus-5', input: 0, output: 1000, cacheWrite: 0, cacheRead: 0, cw5: 0, cw1h: 0 }],
    now,
    {
      codexEvents: [{ ts: at, model: 'gpt-5.6-sol', tier: 'standard', inputUncached: 10, cachedInput: 0, cacheWrite: 0, output: 10 }],
      kimiEvents: [{ ts: at, model: 'kimi-code/k2', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }],
      qwenEvents: [{ ts: at, model: 'qwen3-coder-plus', tier: 0, input: 10, cached: 0, output: 1 }],
      grokEvents: [{ ts: at, model: 'grok-4.6', input: 10, cacheRead: 0, cacheWrite: 0, output: 1, usd: 0.01, partial: true, incomplete: true }],
    },
  );
  assert.deepEqual(Object.keys(four).sort(), interfaceFields('UsageHistory'));
  assert.deepEqual(Object.keys(four.weeks[0]).sort(), interfaceFields('PeriodUsage'));
  for (const entry of four.weeks[0].byModel) assert.deepEqual(Object.keys(entry).sort(), interfaceFields('PeriodModelCost'));
  assert.deepEqual(four.usageProviders, ['claude', 'codex', 'kimi', 'qwen', 'grok']);
  const declaredCauses = stringUnion('HistoryFloorCause');
  assert.deepEqual([...history.FLOOR_CAUSE_ORDER].sort(), [...declaredCauses].sort(), 'the producer and the contract list the same codes');
  for (const causes of Object.values(four.floorCausesByProvider)) {
    for (const c of causes) assert.ok(declaredCauses.includes(c), `undeclared cause ${c}`);
  }
  // ADR-002 A3.20: always present, a list of tool ids, empty for complete sources.
  assert.ok(interfaceFields('UsageHistory').includes('incompleteProviders'), 'contract.ts declares incompleteProviders');
  assert.deepEqual(out.incompleteProviders, []);
  const affected = history.usageHistory([], now, {
    codexEvents: [{ ts: at, model: 'gpt-5.6-sol', tier: 'standard', inputUncached: 10, cachedInput: 0, cacheWrite: 0, output: 10 }],
    unreadRanges: { codex: [{ fromMs: at, throughMs: at }] },
  });
  assert.deepEqual(Object.keys(affected).sort(), interfaceFields('UsageHistory'));
  assert.deepEqual(affected.incompleteProviders, ['codex']);
});

/** The string literals of `export type <name> = 'a' | 'b' ...;` in contract.ts. */
function stringUnion(name) {
  const src = contractSource().replace(/\r\n/g, '\n');
  const start = src.indexOf(`export type ${name} =`);
  assert.notEqual(start, -1, `contract.ts no longer declares ${name}`);
  const body = src.slice(start, src.indexOf(';', start));
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('Kimi, Qwen and Grok weekly costs have exactly the WeeklyCost shape, and their unpriced codes are declared', () => {
  const { buildSnapshot } = require('../src/core/snapshot');
  const now = new Date(2026, 8, 9, 12, 0, 0).getTime();
  const at = now - 60 * 60 * 1000;
  const snap = buildSnapshot({
    now,
    events: [],
    rateLimits: null,
    codexEvents: [],
    kimi: { installed: true, events: [{ ts: at, model: 'kimi-code/k2', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, { ts: at, model: 'x/y', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }], resultAtMs: now },
    qwen: { installed: true, events: [{ ts: at, model: 'qwen3-coder-plus', tier: 0, input: 1000, cached: 0, output: 10 }, { ts: at, model: 'glm-5', tier: 0, input: 10, cached: 0, output: 1 }], resultAtMs: now },
    grok: { installed: true, events: [{ ts: at, model: 'grok-4.6', input: 10, cacheRead: 0, cacheWrite: 0, output: 1, usd: 0.5, partial: true, incomplete: false }, { ts: at, model: 'grok-4.6', input: 10, cacheRead: 0, cacheWrite: 0, output: 1, usd: null, partial: false, incomplete: false }], resultAtMs: now },
    scanOk: true,
  });
  const fields = interfaceFields('WeeklyCost');
  for (const key of ['unrecordedCalls', 'longPromptFloorEvents', 'toolTokenEvents', 'partialUsageEvents']) assert.ok(fields.includes(key), `contract.ts declares ${key}`);
  const kimi = snap.providers.find((p) => p.id === 'kimi').weeklyCost;
  const qwen = snap.providers.find((p) => p.id === 'qwen').weeklyCost;
  const grok = snap.providers.find((p) => p.id === 'grok').weeklyCost;
  for (const cost of [kimi, qwen, grok]) assert.deepEqual(Object.keys(cost).sort(), fields);
  assert.equal(qwen.unrecordedCalls, true);
  assert.equal(kimi.unrecordedCalls, false);
  assert.equal(grok.partialUsageEvents, 1);
  const codes = stringUnion('UnpricedReasonCode');
  assert.deepEqual([...codes].sort(), ['no-model', 'no-published-price', 'no-reported-cost', 'other-model-alias']);
  // Tier and price-source codes, not reasons: 'standard' and Qwen's over-tier
  // group ('standard-long-context', Codex's naming), Grok's 'reported'.
  const TIERS = new Set(['standard', 'standard-long-context', 'reported']);
  const emitted = [...kimi.byModel, ...qwen.byModel, ...grok.byModel].map((m) => m.speed).filter((s) => !TIERS.has(s));
  // 'no-model' has had no producer since Gemini CLI was removed; it stays
  // declared so the renderer's wording for it stays reachable.
  assert.deepEqual([...new Set(emitted)].sort(), codes.filter((c) => c !== 'no-model').sort(), 'every emitted non-tier code is declared');
});

test('every provider row declares experimental, true only for Kimi, Qwen and Grok, and carries no undeclared key', () => {
  const { buildSnapshot, loadingSnapshot } = require('../src/core/snapshot');
  const fields = interfaceFields('ProviderSnapshot');
  assert.ok(fields.includes('experimental'), 'contract.ts declares ProviderSnapshot.experimental');
  const now = new Date(2026, 8, 9, 12, 0, 0).getTime();
  const installed = { installed: true, events: [], resultAtMs: now };
  const noLog = { ...installed, usageLogAbsent: true };
  for (const s of [buildSnapshot({ now, events: [], rateLimits: null, scanOk: true, kimi: installed, qwen: noLog, grok: installed }), loadingSnapshot(now)]) {
    for (const p of s.providers) {
      for (const key of Object.keys(p)) assert.ok(fields.includes(key), `${p.id}: undeclared key "${key}"`);
      assert.equal(p.experimental, p.id === 'kimi' || p.id === 'qwen' || p.id === 'grok', p.id);
    }
  }
});

test('both weekly costs main produces have exactly the WeeklyCost shape contract.ts declares', () => {
  // `unrecordedWriteEvents` is always present (0 for Claude): a field the
  // renderer's floor check reads must not be missing on one provider.
  const { buildSnapshot } = require('../src/core/snapshot');
  const now = new Date(2026, 8, 9, 12, 0, 0).getTime();
  const at = now - 60 * 60 * 1000;
  const snap = buildSnapshot({
    now,
    events: [{ f: 'f', key: 'k', ts: at, model: 'claude-opus-5', input: 0, output: 1000, cacheWrite: 0, cacheRead: 0, cw5: 0, cw1h: 0 }],
    rateLimits: null,
    codexEvents: [{ ts: at, model: 'gpt-5.6-sol', tier: 'standard', inputUncached: 10, cachedInput: 90, cacheWrite: 0, output: 10 }],
    scanOk: true,
  });
  const fields = interfaceFields('WeeklyCost');
  assert.ok(fields.includes('unrecordedWriteEvents'), 'contract.ts declares unrecordedWriteEvents');
  const claude = snap.providers.find((p) => p.id === 'claude').weeklyCost;
  const codex = snap.providers.find((p) => p.id === 'codex').weeklyCost;
  assert.deepEqual(Object.keys(claude).sort(), fields);
  assert.deepEqual(Object.keys(codex).sort(), fields);
  assert.equal(claude.unrecordedWriteEvents, 0);
  // Present but 0 since 2026-09-23: a cached read with 0 recorded writes on a
  // write-priced model is priced as an upper bound, no longer counted as a floor.
  assert.equal(codex.unrecordedWriteEvents, 0, 'cached read, 0 recorded writes: an upper bound, not a floor');
  // ADR-002 A3.15: always present on both, a boolean, and false for a fully
  // read corpus — the renderer's degraded caveat and floor read only this.
  assert.ok(fields.includes('sourceIncomplete'), 'contract.ts declares sourceIncomplete');
  // ADR-002 A3.17-18: always present, 0 for Claude.
  for (const key of ['assumedTierEvents', 'fastRequestedEvents']) {
    assert.ok(fields.includes(key), `contract.ts declares ${key}`);
    assert.equal(claude[key], 0);
    assert.equal(codex[key], 0, 'tier recorded as standard: no tier floor');
  }
  assert.equal(claude.sourceIncomplete, false);
  assert.equal(codex.sourceIncomplete, false);
  const failed = buildSnapshot({
    now,
    events: [{ f: 'f', key: 'k', ts: at, model: 'claude-opus-5', input: 0, output: 1000, cacheWrite: 0, cacheRead: 0, cw5: 0, cw1h: 0 }],
    rateLimits: null,
    codexEvents: [{ ts: at, model: 'gpt-5.6-sol', tier: 'standard', inputUncached: 10, cachedInput: 90, cacheWrite: 0, output: 10 }],
    codexReadFailed: true,
    scanOk: false,
  });
  for (const id of ['claude', 'codex']) {
    const cost = failed.providers.find((p) => p.id === id).weeklyCost;
    assert.deepEqual(Object.keys(cost).sort(), fields);
    assert.equal(cost.sourceIncomplete, true, `${id}: a failed scan is a known-incomplete source`);
  }
});

test('every snapshot main emits carries pendingUsage, and no key contract.ts does not declare', () => {
  const { buildSnapshot, loadingSnapshot } = require('../src/core/snapshot');
  const fields = interfaceFields('Snapshot');
  assert.ok(fields.includes('pendingUsage'), 'contract.ts declares Snapshot.pendingUsage');
  const now = new Date(2026, 8, 9, 12, 0, 0).getTime();
  const pending = buildSnapshot({ now, events: [], rateLimits: null, codexEvents: null, scanOk: true });
  const scanned = buildSnapshot({ now, events: [], rateLimits: null, codexEvents: [], scanOk: true });
  const loading = loadingSnapshot(now);
  for (const snap of [pending, scanned, loading]) {
    for (const key of Object.keys(snap)) assert.ok(fields.includes(key), `undeclared Snapshot key "${key}"`);
    assert.ok(Array.isArray(snap.pendingUsage), 'always present');
  }
  assert.deepEqual(pending.pendingUsage, ['codex'], 'no Codex result yet');
  assert.deepEqual(scanned.pendingUsage, [], 'empty when nothing is pending');
  assert.deepEqual(loading.pendingUsage, ['codex']);
  // ADR-003 A6: an INSTALLED local-log tool with no scan result yet is pending too.
  const localPending = buildSnapshot({
    now, events: [], rateLimits: null, codexEvents: [], scanOk: true,
    kimi: { installed: true, events: null }, qwen: { installed: true, events: null }, grok: { installed: true, events: null },
  });
  assert.deepEqual(localPending.pendingUsage, ['kimi', 'qwen', 'grok']);
});

test('the push cadence main implements matches the one the contract advertises', () => {
  const src = contractSource();
  const openMs = /OPEN_MS:\s*([\d_]+)/.exec(src);
  const idleMs = /IDLE_MS:\s*([\d_]+)/.exec(src);
  assert.ok(openMs && idleMs, 'contract.ts no longer declares CADENCE');
  const collector = require('../src/core/collector');
  assert.equal(collector.SWEEP_OPEN_MS, Number(openMs[1].replace(/_/g, '')));
  assert.equal(collector.SWEEP_IDLE_MS, Number(idleMs[1].replace(/_/g, '')));
});

test('window hardening flags are set on every window with a preload: the panel and the taskbar strip', () => {
  for (const file of ['panel-window.js', 'taskbar-strip.js', 'taskbar-display.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'main', file), 'utf8');
    for (const required of [
      'contextIsolation: true',
      'nodeIntegration: false',
      'sandbox: true',
      'webSecurity: true',
      'webviewTag: false',
    ]) {
      assert.ok(src.includes(required), `${file} must set ${required}`);
    }
    assert.equal(/loadURL\s*\(\s*['"`]https?:/.test(src), false, `${file} must never load a remote URL`);
    assert.ok(src.includes('loadFile('), `${file} is loaded from a local file`);
  }
  // The strip never offers devtools, packaged or not: it lives in the taskbar.
  for (const file of ['taskbar-strip.js', 'taskbar-display.js']) {
    assert.ok(fs.readFileSync(path.join(ROOT, 'src', 'main', file), 'utf8').includes('devTools: false'), file);
  }
});

test('navigation and window-open are blocked process wide', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'security.js'), 'utf8');
  assert.ok(src.includes("'will-navigate'"));
  assert.ok(src.includes('setWindowOpenHandler'));
  assert.ok(src.includes("action: 'deny'"));
});

/**
 * Structural guards over the main and core source. Each is a property of the
 * SHAPE of the codebase, not of any one call, so a comment cannot hold it and a
 * review holds it only until the next edit.
 *
 * Comment lines are stripped before every scan, exactly as the network scan
 * below does: the prose that NAMES an API in order to say it is never called is
 * documentation, and turning it into a failure would push the reasoning out of
 * the file.
 */
function codeOf(file) {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n');
}

/** Every main/core source file, as `{ rel, code }`. */
function mainAndCore() {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|mjs|cjs)$/.test(entry.name)) continue;
      out.push({ rel: path.relative(ROOT, full).split(path.sep).join('/'), code: codeOf(full) });
    }
  };
  walk(path.join(ROOT, 'src', 'main'));
  walk(path.join(ROOT, 'src', 'core'));
  return out;
}

test('every session gets the block-all request filter, with no exemption', () => {
  // The optional-key feature once created one session that skipped the filter.
  // With no request left for the app to make, no session may: the
  // `session-created` handler hardens every one except the default session,
  // which `applyAll()` hardens once itself.
  const code = codeOf(path.join(ROOT, 'src', 'main', 'security.js'));
  for (const needle of ['createExemptSession', 'EXEMPT_PARTITION', 'exemptSessions', 'fromPartition(']) {
    assert.equal(code.includes(needle), false, needle);
  }
  const handler = code.slice(code.indexOf("app.on('session-created'"));
  assert.ok(handler.includes('applySessionHardening(sess)'), 'a new session is hardened');
  const security = require('../src/main/security');
  assert.equal(security.isAllowed('https://api.github.com/'), false);
  assert.equal(security.isAllowed('http://127.0.0.1/'), false);
  assert.equal(security.isAllowed('file://server/share/x'), false);
});

test('no TLS override and no plaintext-storage escape hatch exists anywhere', () => {
  const forbidden = [
    'setCertificateVerifyProc',
    'rejectUnauthorized',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'setUsePlainTextEncryption',
    'allowNTLMCredentialsForDomains',
    'ignore-certificate-errors',
  ];
  const offenders = [];
  for (const { rel, code } of mainAndCore()) {
    for (const needle of forbidden) {
      if (code.includes(needle)) offenders.push(`${rel}: ${needle}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the proxy mode is a literal DIRECT, in one place, and never the system proxy (ADR-001 A2026-09-22)', () => {
  const callers = mainAndCore().filter(({ code }) => code.includes('setProxy(')).map((o) => o.rel);
  assert.deepEqual(callers, ['src/main/security.js'], 'one module decides the proxy mode');

  const code = codeOf(path.join(ROOT, 'src', 'main', 'security.js'));
  const calls = code.match(/setProxy\([^)]*\)/g) || [];
  assert.equal(calls.length, 1, 'one call, not two');
  // A literal object with a literal mode: no variable, so which mode ships
  // cannot depend on a caller, a setting or a stored value.
  assert.equal(calls[0], "setProxy({ mode: 'direct' })");

  // `mode: 'system'` would put WPAD back on every machine that runs the app.
  // It is not shipped anywhere, and this is what says so.
  for (const { rel, code: body } of mainAndCore()) {
    assert.equal(body.includes("mode: 'system'"), false, rel);
    assert.equal(body.includes('proxyRules'), false, rel);
    assert.equal(body.includes('pacScript'), false, rel);
  }

  // And the process-global control, which is the one devops measured at zero.
  assert.ok(code.includes("appendSwitch('no-proxy-server')"));
});

test('DNS-over-HTTPS and the built-in resolver are pinned off, in one place (security F9)', () => {
  // The pin exists, exactly once, in the module that owns network hardening.
  const callers = mainAndCore().filter(({ code }) => code.includes('configureHostResolver(')).map((o) => o.rel);
  assert.deepEqual(callers, ['src/main/security.js'], 'one module decides the resolver mode');

  const code = codeOf(path.join(ROOT, 'src', 'main', 'security.js'));
  const calls = code.match(/configureHostResolver\([^)]*\)/g) || [];
  assert.equal(calls.length, 1, 'one call, not two');
  // Literal values, both of them: a DoH lookup is a host resolution and not a
  // URLRequest, so if an Electron default ever flips, the block-all filter would
  // not see it and no in-process test could. This line is what says no.
  assert.equal(
    calls[0],
    "configureHostResolver({ enableBuiltInResolver: false, secureDnsMode: 'off' })",
  );

  // And the modes that would undo it are nowhere.
  for (const { rel, code: body } of mainAndCore()) {
    assert.equal(body.includes('enableBuiltInResolver: true'), false, rel);
    assert.equal(body.includes("secureDnsMode: 'automatic'"), false, rel);
    assert.equal(body.includes("secureDnsMode: 'secure'"), false, rel);
  }
});

test('spellcheck is off on every window, because the dictionary is a download (security F11)', () => {
  /**
   * NOT typography. Electron downloads hunspell dictionaries from a Google host
   * the first time a spellcheckable field takes focus, through a browser-process
   * loader that no session `onBeforeRequest` sees — the same class of blind spot
   * as the `wpad` lookups. Any text field a window ever gains can trigger it,
   * so this flag is a network control and cannot be dropped as cosmetic.
   */
  const withWindows = mainAndCore().filter(({ code }) => code.includes('webPreferences'));
  assert.deepEqual(withWindows.map((o) => o.rel).sort(), ['src/main/panel-window.js', 'src/main/taskbar-display.js', 'src/main/taskbar-strip.js', 'src/main/uninstall-prompt.js']);
  for (const { rel, code } of withWindows) {
    assert.ok(code.includes('spellcheck: false'), `${rel} must keep spellcheck: false`);
  }
  // No spelling of the opposite, anywhere, including the loader switch that
  // would fetch a dictionary without a webPreferences block at all.
  for (const { rel, code } of mainAndCore()) {
    assert.equal(code.includes('spellcheck: true'), false, rel);
    assert.equal(code.includes('setSpellCheckerEnabled'), false, rel);
    assert.equal(code.includes('setSpellCheckerLanguages'), false, rel);
  }
});

/**
 * Ways a process can put bytes on a wire or spawn something that will.
 *
 * The app makes NO network request of its own, anywhere: since the optional
 * GitHub API key was removed (2026-09-28) there is no module that may, so there
 * is no exempt file either. The list names every way a request could still be
 * written — `fetch`, a socket, a websocket, a child process, http2, UDP, DNS or
 * TLS reached directly, Electron's own `net`, and handing a URL to the default
 * browser. Both quote styles, because a single-quote-only list is one
 * autoformatter away from being blind.
 */
const NETWORK_NEEDLES = [
  'axios', 'node-fetch', 'undici', "require('got')", "from 'got'",
  "require('node:http')", "require('http')", "require('node:https')", "require('https')",
  "require('node:net')", "require('net')", "require('node:dgram')",
  "from 'node:http'", "from 'node:https'", "from 'node:net'",
  'createServer', 'crashReporter.start', 'setUploadToServer',
  'fetch(', 'WebSocket', 'child_process', 'http2', 'dgram',
  "'node:tls'", '"node:tls"', "'tls'", '"tls"',
  "'node:dns'", '"node:dns"', "'dns'", '"dns"',
  '"node:http"', '"node:https"', '"node:net"', '"node:dgram"',
  '"http"', '"https"', '"net"',
  'XMLHttpRequest', 'sendBeacon', 'EventSource', 'openExternal',
];

/**
 * Electron's `net` module, in every spelling that reaches it: destructured from
 * `require('electron')` in any order, taken as a property of it, imported, or
 * called. Patterns rather than needles, because `net` alone is a substring of
 * too many ordinary words to be a needle.
 */
const NETWORK_PATTERNS = [
  /\{[^}]*\bnet\b[^}]*\}\s*=\s*require\(['"](?:node:)?electron['"]\)/,
  /require\(['"](?:node:)?electron['"]\)\.net\b/,
  /import\s*\{[^}]*\bnet\b[^}]*\}\s*from\s*['"]electron['"]/,
  /\bnet\.(?:request|fetch)\(/,
];

/**
 * The exceptions, each with the condition that justifies it. Anything not listed
 * here is an offender wherever it appears.
 *
 * The two Antigravity files spawn `tasklist.exe` and the
 * installer by ABSOLUTE PATH through `execFile` (ADR-003 Amendment 2 C3-C5):
 * no shell, no PATH lookup, no network. They are named one by one so a third
 * `child_process` import anywhere is a failure.
 *
 * `bridge/claude-statusline.mjs` runs the user's OWN status line command, the
 * one Claude Code was already running before the setup kept it (claude-chain
 * .json), so the user's line keeps showing. It runs inside Claude Code's
 * process tree, not the app's, and adds no network of its own.
 */
const NEEDLE_EXCEPTIONS = {
  child_process: [
    'src/core/antigravity/cli-install.js',
    'src/core/antigravity/process.js',
    'bridge/claude-statusline.mjs',
  ],
};

function scanForNetwork(dir, skip = () => false) {
  const offenders = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(d, entry.name);
      if (skip(path.relative(ROOT, full))) continue;
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|mjs|cjs|ts|html)$/.test(entry.name)) continue;
      const rel = path.relative(ROOT, full).split(path.sep).join('/');
      const text = fs.readFileSync(full, 'utf8');
      const code = text.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
      for (const needle of NETWORK_NEEDLES) {
        const allowed = NEEDLE_EXCEPTIONS[needle] || [];
        if (allowed.includes(rel)) continue;
        if (code.includes(needle)) offenders.push(`${rel}: ${needle}`);
      }
      for (const pattern of NETWORK_PATTERNS) {
        if (pattern.test(code)) offenders.push(`${rel}: ${pattern}`);
      }
    }
  };
  walk(dir);
  return offenders;
}

test('the network scan has teeth: every needle and every exception is reachable', () => {
  // A scan that matches nothing proves nothing. The named exceptions must all
  // still exist, or the exception list is stale and is silently widening the
  // scan's blind spot.
  for (const rel of Object.values(NEEDLE_EXCEPTIONS).flat()) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} no longer exists; drop its exception`);
  }
  // Every spelling of Electron's `net` that the patterns exist for is caught,
  // and an ordinary word containing "net" is not.
  const caught = (code) => NETWORK_PATTERNS.some((p) => p.test(code));
  for (const code of [
    "const { net } = require('electron');",
    "const { app, net, session } = require('electron');",
    "const net = require('electron').net;",
    "import { net } from 'electron';",
    "net.request({ url });",
    "await net.fetch(url);",
  ]) {
    assert.ok(caught(code), code);
  }
  for (const code of ["const planet = 'net';", "const { app } = require('electron');", 'internet.request()']) {
    assert.equal(caught(code), false, code);
  }
  assert.ok(NETWORK_NEEDLES.includes('fetch('));
  assert.ok(NETWORK_NEEDLES.includes('child_process'));
  assert.ok(NETWORK_NEEDLES.includes("'node:tls'"));
});

test('no HTTP client and no listening socket in the collector, main process or bridge', () => {
  // The local-log readers (ADR-003 A6) are named explicitly: they are rung 1
  // only, and a network module there would contradict the ADR outright.
  for (const dir of ['kimi', 'qwen', 'grok', 'antigravity', 'scan']) {
    const full = path.join(ROOT, 'src', 'core', dir);
    assert.ok(fs.existsSync(full) && fs.readdirSync(full).some((n) => n.endsWith('.js')), `src/core/${dir} exists and is scanned`);
    assert.deepEqual(scanForNetwork(full), [], `src/core/${dir}`);
  }
  const offenders = [
    ...scanForNetwork(path.join(ROOT, 'src', 'core')),
    ...scanForNetwork(path.join(ROOT, 'src', 'main')),
    ...scanForNetwork(path.join(ROOT, 'src', 'shared')),
    ...scanForNetwork(path.join(ROOT, 'bridge')),
  ];
  assert.deepEqual(offenders, []);
});

test('nothing the packaged app loads opens a socket', () => {
  // `src/renderer/dev/` is a build-time harness owned by the frontend lane and
  // is excluded from the package (see package.json `build.files`). Everything
  // that actually ships must be socket-free.
  const rendererDir = path.join(ROOT, 'src', 'renderer');
  if (!fs.existsSync(rendererDir)) return;
  const offenders = scanForNetwork(rendererDir, (rel) => rel.split(path.sep).includes('dev'));
  assert.deepEqual(offenders, []);
});

/**
 * THE ONE RUNTIME DEPENDENCY, AND WHY IT IS ALLOWED (2026-10-20)
 *
 * A runtime dependency is an operational commitment, and until the taskbar
 * strip there were none. koffi is the single, justified exception:
 *
 *   - Windows 11 offers no API for content on the taskbar. Electron can
 *     neither read the taskbar's geometry nor style a window as a topmost,
 *     never-activating tool window, and only UI Automation knows where the
 *     XAML task buttons end — so user32, gdi32 and UIA (ole32/oleaut32) have
 *     to be called directly. win32.js says which techniques were measured
 *     and rejected (a child gets no input; an owned window couples input
 *     queues with Explorer).
 *   - koffi is loaded by three modules only — src/main/win32.js (main
 *     thread), src/main/taskbar-icons-worker.js (a worker, for UI Automation)
 *     and src/main/taskbar-display-worker.js (a worker that owns the strip's
 *     drawing window inside the taskbar) — lazily: a user on the tray icon
 *     loads it only for the panel's own window attributes on Windows 11
 *     (win32.loadDwm: the corners, a light/dark frame, a neutral hairline and
 *     the glass behind it). A load failure only makes the strip "unavailable"
 *     and leaves the panel opaque, with Windows' defaults.
 *   - Its runtime JavaScript requires node:fs, node:util and node:module and
 *     nothing that reaches a network (grepped 2026-10-20, and scanned below;
 *     its install-time builder cnoke.cjs uses child_process and is excluded
 *     from the package).
 *   - It ships a prebuilt N-API binary, so nothing is compiled on install and
 *     the binary is ABI-stable across Electron versions. Only win32-x64's
 *     ships; every other platform's is excluded (next test).
 *
 * Pinned EXACTLY, so an update is a reviewed change, not a resolution.
 */
const KOFFI_VERSION = '3.3.3';

test('package.json declares exactly one runtime dependency: koffi, pinned exactly', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies || {}, { koffi: KOFFI_VERSION }, 'a runtime dependency is an operational commitment; koffi is the only one');
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages[''].dependencies.koffi, KOFFI_VERSION, 'package-lock.json agrees');
  assert.equal(lock.packages['node_modules/koffi'].version, KOFFI_VERSION);
  assert.equal(lock.packages['node_modules/@koromix/koffi-win32-x64'].version, KOFFI_VERSION);
  // The only files that load it.
  const loaders = mainAndCore().filter(({ code }) => /require\(['"]koffi['"]\)/.test(code)).map((o) => o.rel).sort();
  assert.deepEqual(loaders, ['src/main/taskbar-display-worker.js', 'src/main/taskbar-icons-worker.js', 'src/main/win32.js']);
  // Lazily: inside a function, never at the top of the module.
  const win32 = codeOf(path.join(ROOT, 'src', 'main', 'win32.js'));
  assert.equal(/^const koffi = require/m.test(win32), false, 'koffi must not load at require time');
  // Build-time only: none of these ships in the package, and nothing at runtime
  // requires any of them. electron-builder is the packager, added on purpose
  // for the NSIS installer; it runs at `npm run dist` and is never loaded by
  // the app.
  assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ['electron', 'electron-builder', 'typescript']);
});

test('the only koffi binary that ships is win32-x64, unpacked from the asar', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const files = pkg.build.files;
  // A .node file cannot be loaded from inside an asar archive.
  assert.ok(pkg.build.asarUnpack.includes('node_modules/@koromix/koffi-win32-x64/**'));
  // Every other platform's prebuilt package is excluded by name pattern, and
  // the import library, the C++ sources and the install-time builder too.
  for (const pattern of [
    '!node_modules/@koromix/koffi-!(win32-x64)/**',
    '!node_modules/@koromix/koffi-win32-x64/**/*.lib',
    '!node_modules/koffi/{doc,lib,vendor}/**',
    '!node_modules/koffi/src/koffi/src/abi/**',
    '!node_modules/koffi/build/**',
  ]) {
    assert.ok(files.includes(pattern), `build.files must include ${pattern}`);
  }
  assert.ok(files.some((f) => f.startsWith('!node_modules/koffi/{cnoke.cjs')), 'the install-time builder (child_process) is excluded');
  // On this machine npm installed only the one optional binary package.
  const koromix = path.join(ROOT, 'node_modules', '@koromix');
  if (fs.existsSync(koromix)) {
    assert.deepEqual(fs.readdirSync(koromix), ['koffi-win32-x64']);
  }
  // A packaged build, when one is on disk and has the strip: exactly one
  // .node file of koffi's, and it is win32-x64's.
  const unpacked = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar.unpacked', 'node_modules');
  if (fs.existsSync(path.join(unpacked, '@koromix'))) {
    const found = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.node')) found.push(path.relative(unpacked, full).split(path.sep).join('/'));
      }
    };
    walk(unpacked);
    assert.deepEqual(found, ['@koromix/koffi-win32-x64/win32_x64/koffi.node']);
  }
});

test("koffi's shipped JavaScript reaches no network and spawns nothing", () => {
  // The scan above skips node_modules, so the one dependency is scanned here,
  // over the JavaScript that ships (build.files keeps the CommonJS loader, the
  // static table and the platform package's index.js).
  const shipped = [
    'node_modules/koffi/index.cjs',
    'node_modules/koffi/indirect.cjs',
    'node_modules/koffi/src/koffi/index.cjs',
    'node_modules/koffi/src/koffi/indirect.cjs',
    'node_modules/koffi/src/koffi/src/static.cjs',
    'node_modules/koffi/src/koffi/src/trampolines.cjs',
    'node_modules/@koromix/koffi-win32-x64/index.js',
  ];
  let scanned = 0;
  for (const rel of shipped) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) continue;
    scanned += 1;
    const code = fs.readFileSync(full, 'utf8');
    for (const needle of NETWORK_NEEDLES) assert.equal(code.includes(needle), false, `${rel}: ${needle}`);
    for (const pattern of NETWORK_PATTERNS) assert.equal(pattern.test(code), false, `${rel}: ${pattern}`);
  }
  if (fs.existsSync(path.join(ROOT, 'node_modules', 'koffi'))) assert.ok(scanned >= 3, 'the scan found koffi\'s loader');
});

test('the packaged app excludes both the harness source and its compiled output', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const files = pkg.build.files;
  // The source exclusion alone let the COMPILED harness ship, which is the
  // copy that would actually run.
  assert.ok(files.includes('!src/renderer/dev/**'), 'harness source must be excluded');
  assert.ok(
    files.some((f) => f.startsWith('!') && f.includes('dist') && f.includes('dev')),
    'the compiled harness under dist/ must be excluded too',
  );
});
