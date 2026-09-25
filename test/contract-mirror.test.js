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

  // The key-entry window's sync channel lives in the key service, and the stake
  // is the same: an unset `returnValue` would be a consent page that never
  // paints, on the one screen where a secret is typed.
  const service = fs.readFileSync(path.join(ROOT, 'src', 'main', 'keys', 'service.js'), 'utf8');
  const start = service.indexOf('IPC_KEY_ENTRY.ENTRY_INFO');
  assert.notEqual(start, -1, 'the entry-info listener is gone');
  const body = service.slice(start, service.indexOf('});', start));
  assert.ok(body.includes('event.returnValue ='), 'ENTRY_INFO must assign returnValue');
  assert.equal(/return;/.test(body), false, 'an early return would hang the entry page');
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
  // ADR-003 Amendment 8 added the three optional-key channels. They are
  // write-only by construction: there is no getter in this set, and a method
  // that returned a key — or its length, or a mask of it — would be K3's
  // violation, which is why the count is asserted rather than left open.
  assert.ok(declared.has('requestKeyEntry'), 'contract.ts should declare requestKeyEntry()');
  assert.ok(declared.has('removeKey'), 'contract.ts should declare removeKey()');
  assert.ok(declared.has('openTokenPage'), 'contract.ts should declare openTokenPage()');
  for (const forbidden of ['getKey', 'readKey', 'keyPreview', 'maskedKey']) {
    assert.equal(declared.has(forbidden), false, `${forbidden}() would be a key getter (K3)`);
  }
  // 19 since setPlanLabel() joined the setters: the plan the user says they are
  // on, per tool. Write-only like the rest; the value comes BACK on the snapshot
  // as `ProviderSnapshot.planLabel`, not from a getter here. The count stays
  // asserted so a key getter still cannot arrive unnoticed (K3).
  assert.ok(declared.has('setPlanLabel'), 'contract.ts should declare setPlanLabel()');
  // 20 since refreshKey() (2026-09-24): "refresh now" for the credit figure.
  // It answers {ok} only; the figure arrives on the snapshot.
  assert.ok(declared.has('refreshKey'), 'contract.ts should declare refreshKey()');
  // 21 since setAutostart() (2026-09-24): "start with Windows" in the settings
  // screen, the value the tray checkbox already had. A setter; it comes back on
  // `Preferences.autostart`.
  assert.ok(declared.has('setAutostart'), 'contract.ts should declare setAutostart()');
  assert.equal(declared.size, 21, `expected the 21 declared methods, saw ${[...declared].join(',')}`);
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
      geminiEvents: [{ ts: at, model: 'gemini-2.5-pro', input: 10, cached: 0, output: 1, thoughts: 0, tool: 1, longPrompt: true }],
      kimiEvents: [{ ts: at, model: 'kimi-code/k2', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }],
    },
  );
  assert.deepEqual(Object.keys(four).sort(), interfaceFields('UsageHistory'));
  assert.deepEqual(Object.keys(four.weeks[0]).sort(), interfaceFields('PeriodUsage'));
  for (const entry of four.weeks[0].byModel) assert.deepEqual(Object.keys(entry).sort(), interfaceFields('PeriodModelCost'));
  assert.deepEqual(four.usageProviders, ['claude', 'codex', 'gemini', 'kimi']);
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

test('Gemini and Kimi weekly costs have exactly the WeeklyCost shape, and their unpriced codes are declared', () => {
  const { buildSnapshot } = require('../src/core/snapshot');
  const now = new Date(2026, 8, 9, 12, 0, 0).getTime();
  const at = now - 60 * 60 * 1000;
  const snap = buildSnapshot({
    now,
    events: [],
    rateLimits: null,
    codexEvents: [],
    gemini: { installed: true, events: [{ ts: at, input: 10, cached: 0, output: 1, thoughts: 0, tool: 2, longPrompt: false, model: 'unknown', noModel: true }, { ts: at, input: 1000, cached: 0, output: 10, thoughts: 0, tool: 0, longPrompt: false, model: 'gemini-2.5-pro' }], resultAtMs: now },
    kimi: { installed: true, events: [{ ts: at, model: 'kimi-code/k2', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, { ts: at, model: 'x/y', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }], resultAtMs: now },
    scanOk: true,
  });
  const fields = interfaceFields('WeeklyCost');
  for (const key of ['unrecordedCalls', 'longPromptFloorEvents', 'toolTokenEvents']) assert.ok(fields.includes(key), `contract.ts declares ${key}`);
  const gemini = snap.providers.find((p) => p.id === 'gemini').weeklyCost;
  const kimi = snap.providers.find((p) => p.id === 'kimi').weeklyCost;
  assert.deepEqual(Object.keys(gemini).sort(), fields);
  assert.deepEqual(Object.keys(kimi).sort(), fields);
  assert.equal(gemini.unrecordedCalls, true);
  assert.equal(gemini.toolTokenEvents, 1);
  assert.equal(kimi.unrecordedCalls, false);
  const codes = stringUnion('UnpricedReasonCode');
  assert.deepEqual([...codes].sort(), ['no-model', 'no-published-price', 'other-model-alias']);
  const emitted = [...gemini.byModel, ...kimi.byModel].map((m) => m.speed).filter((s) => s !== 'standard');
  assert.deepEqual([...new Set(emitted)].sort(), [...codes].sort(), 'every emitted non-tier code is declared');
});

test('every provider row declares experimental, true only for Gemini, Kimi and Copilot, and carries no undeclared key', () => {
  const { buildSnapshot, loadingSnapshot } = require('../src/core/snapshot');
  const fields = interfaceFields('ProviderSnapshot');
  assert.ok(fields.includes('experimental'), 'contract.ts declares ProviderSnapshot.experimental');
  const now = new Date(2026, 8, 9, 12, 0, 0).getTime();
  const installed = { installed: true, events: [], resultAtMs: now };
  for (const s of [buildSnapshot({ now, events: [], rateLimits: null, scanOk: true, gemini: installed, kimi: installed }), loadingSnapshot(now)]) {
    for (const p of s.providers) {
      for (const key of Object.keys(p)) assert.ok(fields.includes(key), `${p.id}: undeclared key "${key}"`);
      assert.equal(p.experimental, p.id === 'gemini' || p.id === 'kimi' || p.id === 'copilot', p.id);
    }
  }
});

test('every provider row carries the key fields, and only Copilot is key-capable (A8, K24)', () => {
  const { buildSnapshot, loadingSnapshot } = require('../src/core/snapshot');
  const fields = interfaceFields('ProviderSnapshot');
  for (const key of ['keyCapable', 'keyState', 'keyStoredAt', 'creditUsage']) {
    assert.ok(fields.includes(key), `contract.ts declares ProviderSnapshot.${key}`);
  }
  assert.ok(contractSource().includes('export interface CreditUsage'), 'contract.ts declares CreditUsage');
  assert.ok(contractSource().includes('export type KeyState'), 'contract.ts declares KeyState');

  const now = new Date(2026, 8, 9, 12, 0, 0).getTime();
  const installed = { installed: true, events: [], resultAtMs: now };
  const keys = {
    copilot: {
      keyState: 'stored',
      keyStoredAt: '2026-09-09T09:00:00.000Z',
      creditUsage: {
        grossCredits: 10,
        includedCredits: 8,
        billedCredits: 2,
        periodStart: '2026-09-01T00:00:00.000Z',
        periodEnd: '2026-10-01T00:00:00.000Z',
        fetchedAt: '2026-09-09T11:00:00.000Z',
      },
    },
  };
  const creditFields = interfaceFields('CreditUsage');
  // The reply carries no allowance, so the shape carries no denominator: there
  // must be nothing here a percentage could be built from (A6.3).
  for (const forbidden of ['usedPercentage', 'allowance', 'entitlement', 'remaining', 'limit']) {
    assert.equal(creditFields.includes(forbidden), false, `CreditUsage must not declare ${forbidden}`);
  }

  for (const s of [
    buildSnapshot({ now, events: [], rateLimits: null, scanOk: true, gemini: installed, kimi: installed, keys }),
    loadingSnapshot(now, undefined, undefined, undefined, keys),
  ]) {
    for (const p of s.providers) {
      for (const key of Object.keys(p)) assert.ok(fields.includes(key), `${p.id}: undeclared key "${key}"`);
      assert.equal(p.keyCapable, p.id === 'copilot', p.id);
      if (p.id === 'copilot') {
        assert.equal(p.keyState, 'stored');
        assert.equal(p.keyStoredAt, '2026-09-09T09:00:00.000Z');
        assert.deepEqual(Object.keys(p.creditUsage).sort(), creditFields.slice().sort());
      } else {
        // A provider that is not key-capable reads as "no key", whatever a
        // caller passes: the offer itself would be a claim that a key helps.
        assert.equal(p.keyState, 'none', p.id);
        assert.equal(p.keyStoredAt, null, p.id);
        assert.equal(p.creditUsage, null, p.id);
      }
    }
  }

  // With no service at all (an older main, or a collector in a test) every row
  // reads as "no key" rather than throwing or inventing a state.
  for (const p of buildSnapshot({ now, events: [], rateLimits: null, scanOk: true }).providers) {
    assert.equal(p.keyState, 'none', p.id);
    assert.equal(p.creditUsage, null, p.id);
  }
});

test('the key-entry window’s channels are mirrored exactly, and are not on the panel’s surface', () => {
  const { IPC_KEY_ENTRY } = require('../src/shared/contract');
  const src = contractSource();
  const start = src.indexOf('export const IPC_KEY_ENTRY');
  assert.notEqual(start, -1, 'contract.ts no longer declares IPC_KEY_ENTRY');
  const block = src.slice(start, src.indexOf('} as const;', start));
  const expected = {};
  for (const m of block.matchAll(/^\s*([A-Z_]+):\s*'([^']+)'/gm)) expected[m[1]] = m[2];
  assert.deepEqual(IPC_KEY_ENTRY, expected);
  // Five channels, all under the same prefix, and none of them in `IPC` — the
  // panel's bridge must not be able to reach the entry window's surface.
  assert.equal(Object.keys(expected).length, 5);
  for (const channel of Object.values(expected)) {
    assert.ok(channel.startsWith('keys:'), channel);
    assert.equal(Object.values(IPC).includes(channel), false, `${channel} is also a panel channel`);
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
  // ADR-003 A6: an INSTALLED Gemini / Kimi with no scan result yet is pending too.
  const localPending = buildSnapshot({
    now, events: [], rateLimits: null, codexEvents: [], scanOk: true,
    gemini: { installed: true, events: null }, kimi: { installed: true, events: null },
  });
  assert.deepEqual(localPending.pendingUsage, ['gemini', 'kimi']);
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

test('window hardening flags are set on the only BrowserWindow we create', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'panel-window.js'), 'utf8');
  for (const required of [
    'contextIsolation: true',
    'nodeIntegration: false',
    'sandbox: true',
    'webSecurity: true',
    'webviewTag: false',
  ]) {
    assert.ok(src.includes(required), `panel-window.js must set ${required}`);
  }
  assert.equal(/loadURL\s*\(\s*['"`]https?:/.test(src), false, 'the panel must never load a remote URL');
  assert.ok(src.includes('loadFile('), 'the panel is loaded from a local file');
});

test('navigation and window-open are blocked process wide', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'security.js'), 'utf8');
  assert.ok(src.includes("'will-navigate'"));
  assert.ok(src.includes('setWindowOpenHandler'));
  assert.ok(src.includes("action: 'deny'"));
});

/**
 * Ways a process can put bytes on a wire or spawn something that will.
 *
 * Grown for ADR-003 Amendment 5 (Phase B): once ONE module is allowed to make a
 * request, the list has to name every OTHER way a key could leave — `fetch`, a
 * socket, a websocket, a child process, http2, UDP, and DNS or TLS reached
 * directly. Both quote styles, because a single-quote-only list is one
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
];

/**
 * The exceptions, each with the condition that justifies it. Anything not listed
 * here is an offender wherever it appears.
 *
 * `src/main/keys/keyed-net.js` is the ONE module ADR-003 Amendment 5 K13 permits
 * to make a request. It is exempt from this list as a whole and guarded instead
 * by `test/keys-source-scan.test.js`, which asserts the stronger property: that
 * it is the only file in main or core that takes `net` from electron, that it
 * calls `net.request(` exactly once, and that no Node network module appears in
 * it at all.
 *
 * The two Antigravity files predate Phase B and spawn `tasklist.exe` and the
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
const NETWORK_EXEMPT_FILES = ['src/main/keys/keyed-net.js'];

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
      if (NETWORK_EXEMPT_FILES.includes(rel)) continue;
      const text = fs.readFileSync(full, 'utf8');
      const code = text.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
      for (const needle of NETWORK_NEEDLES) {
        const allowed = NEEDLE_EXCEPTIONS[needle] || [];
        if (allowed.includes(rel)) continue;
        if (code.includes(needle)) offenders.push(`${rel}: ${needle}`);
      }
    }
  };
  walk(dir);
  return offenders;
}

test('the network scan has teeth: every needle and every exception is reachable', () => {
  // A scan that matches nothing proves nothing. The exempt file and the two
  // named exceptions must all still exist, or the exception list is stale and is
  // silently widening the scan's blind spot.
  for (const rel of [...NETWORK_EXEMPT_FILES, ...Object.values(NEEDLE_EXCEPTIONS).flat()]) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} no longer exists; drop its exception`);
  }
  // And the exempt file really is the one that makes the request.
  const keyed = fs.readFileSync(path.join(ROOT, NETWORK_EXEMPT_FILES[0]), 'utf8');
  assert.ok(keyed.includes('net.request('), 'the exemption belongs to the module that makes the request');
  assert.ok(NETWORK_NEEDLES.includes('fetch('));
  assert.ok(NETWORK_NEEDLES.includes('child_process'));
  assert.ok(NETWORK_NEEDLES.includes("'node:tls'"));
});

test('no HTTP client and no listening socket in the collector, main process or bridge', () => {
  // The Gemini and Kimi readers (ADR-003 A6) are named explicitly: they are
  // rung 1 only, and a network module there would contradict the ADR outright.
  for (const dir of ['gemini', 'kimi', 'scan']) {
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

test('package.json declares no runtime dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies || {}, {}, 'a runtime dependency is an operational commitment; there are none');
  // Build-time only: none of these ships in the package, and nothing at runtime
  // requires any of them. electron-builder is the packager, added on purpose
  // for the NSIS installer; it runs at `npm run dist` and is never loaded by
  // the app.
  assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ['electron', 'electron-builder', 'typescript']);
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
