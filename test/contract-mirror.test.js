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
  assert.equal(declared.size, 15, `expected the 15 declared methods, saw ${[...declared].join(',')}`);
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
  assert.equal(codex.unrecordedWriteEvents, 1, 'cached read, 0 recorded writes, on a model with a write price');
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

const NETWORK_NEEDLES = [
  'axios', 'node-fetch', 'undici', "require('got')", "from 'got'",
  "require('node:http')", "require('http')", "require('node:https')", "require('https')",
  "require('node:net')", "require('net')", "require('node:dgram')",
  "from 'node:http'", "from 'node:https'", "from 'node:net'",
  'createServer', 'crashReporter.start', 'setUploadToServer',
];

function scanForNetwork(dir, skip = () => false) {
  const offenders = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(d, entry.name);
      if (skip(path.relative(ROOT, full))) continue;
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|mjs|cjs|ts|html)$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      const code = text.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
      for (const needle of NETWORK_NEEDLES) {
        if (code.includes(needle)) offenders.push(`${path.relative(ROOT, full)}: ${needle}`);
      }
    }
  };
  walk(dir);
  return offenders;
}

test('no HTTP client and no listening socket in the collector, main process or bridge', () => {
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
