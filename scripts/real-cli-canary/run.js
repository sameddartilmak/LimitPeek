'use strict';
/**
 * Real-CLI canary (dev tooling, never shipped; needs internet to download).
 *
 * For each third-party coding CLI this app reads: fetch its LATEST version
 * into a cache under %LOCALAPPDATA%\UsageNotch-canary\, run it headless ONCE
 * in a fresh throwaway home against the local fake model server
 * (mock-server.js), then run OUR readers over the files the real tool wrote
 * and check the numbers. A vendor that moves or reshapes its usage files
 * shows up here as a FAIL before a customer sees an empty row.
 *
 *   npm run canary:cli
 *   npm run canary:cli -- --only=qwen,kimi --keep
 *   npm run canary:cli -- --update-fixtures
 *
 * Flags
 *   --only=<ids>          comma-separated subset of: qwen, kimi, grok, codex, claude
 *   --keep                keep the throwaway homes (default: deleted after the run)
 *   --update-fixtures     copy the fresh output of each PASSING tool the fixture
 *                         test covers (qwen, kimi, grok) into test/fixtures/real-cli/
 *   --lenient-claude-home see "Claude Code isolation" below
 *   --verbose             print every request the mock served
 *
 * What is checked
 * ---------------
 * The mock answers every model call with prompt 1234 (1000 cached),
 * completion 56 (7 reasoning) and xAI cost 12345678 ticks. A tool may make
 * background calls it never records (title generation, memory extraction),
 * and may fold several calls into one record (a Grok turn), so the check is
 * not "N events" but: the reader's totals are EXACTLY k model calls' worth
 * (uncached input 234k, cache read 1000k, cache write 0, output 56k) for one
 * k with 1 <= k <= the calls the mock served that tool. Then the per-tool
 * contract of test/real-cli-output.test.js (model ids, plan alias, cost).
 * When the files our reader looks for are missing, the reason says where it
 * looked and the report lists every file the tool DID write in its home,
 * with the ones carrying the mock's counts first (where the usage went).
 *
 * Isolation
 * ---------
 * Nothing is installed globally: npm packages go to <cache>\tools\<id>\<ver>
 * through `npm install --prefix`, the Grok binary is downloaded there and its
 * Authenticode signature checked before every run. Each tool runs with
 * USERPROFILE / HOME / APPDATA / LOCALAPPDATA / TEMP and its own *_HOME all
 * pointing inside <cache>\runs\<stamp>\<id>\home, with every inherited
 * CLAUDE* / ANTHROPIC* / OPENAI* / CODEX* / QWEN* / KIMI* / GROK* / XAI* /
 * npm_* variable removed (the parent Claude Code session's messaging socket
 * among them). Auto-updaters are switched off where the tool has a switch.
 * Stragglers the tools leave running are found by their executable or
 * command line (it names the tools cache or this run's directory) and
 * stopped; no other process is touched, and the canary never runs any
 * tool's update command.
 *
 * Claude Code isolation: on top of the above it gets CLAUDE_CONFIG_DIR in the
 * throwaway home. The real `~/.claude.json`, `~/.claude` (three levels) and a
 * user-set CLAUDE_CONFIG_DIR are snapshotted by mtime + size right before
 * and after the run. A change whose path or content carries this run's random
 * marker (it is in the prompt and the run directory) is proof the canary
 * leaked: FAIL and exit code 3, always. Any other change also fails it by
 * default; with --lenient-claude-home such changes are only listed, for when
 * the canary is launched from inside a Claude Code session that keeps writing
 * there. Only CHANGED files are opened, only to search for the marker, and
 * nothing in them is logged; credential files are never opened.
 *
 * Output: a table on stdout, and JSON at <cache>\reports\canary-<stamp>.json
 * (plus last-report.json). Exit 0 all PASS, 1 any FAIL, 2 setup error,
 * 3 real Claude config touched.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const { createMockServer, USAGE, UNCACHED } = require('./mock-server');
const qwenUsage = require('../../src/core/qwen/usage');
const { qwenCost } = require('../../src/core/qwen/pricing');
const kimiUsage = require('../../src/core/kimi/usage');
const grokUsage = require('../../src/core/grok/usage');
const { grokCost } = require('../../src/core/grok/cost');
const codexUsage = require('../../src/core/codex/usage');
const { scan: claudeScan } = require('../../src/core/scan/scanner');
const claudeAgg = require('../../src/core/aggregate');
const { SYNTHETIC_MODEL } = require('../../src/core/scan/parse');

const REPO = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(REPO, 'test', 'fixtures', 'real-cli');
const CACHE = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'UsageNotch-canary');
const TOOLS_DIR = path.join(CACHE, 'tools');
const RUNS_DIR = path.join(CACHE, 'runs');
const REPORTS_DIR = path.join(CACHE, 'reports');
const NPM_CACHE = path.join(CACHE, 'npm-cache');

const RUN_TIMEOUT_MS = 5 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
/** Installed versions kept per tool (the current one and the one before). */
const KEEP_VERSIONS = 2;
const PROMPT = 'Reply with the single word OK.';
const MIN_MS = 60 * 1000;

const GROK_BUCKET = 'https://storage.googleapis.com/grok-build-public-artifacts/cli';
/**
 * Accepted Authenticode signers (the certificate's O=) of the Grok binary.
 * 1.0.44 (2026-09-29) was signed by X.AI LLC; 1.0.62 (2026-10-20) by
 * X Corp. A signer outside this list is refused, never run.
 */
const GROK_SIGNERS = ['X.AI LLC', 'X Corp.'];

/** Inherited variables that could point a tool at a real account or home. */
const STRIP_ENV = /^(CLAUDE|ANTHROPIC|OPENAI|CODEX|QWEN|KIMI|MOONSHOT|GROK|XAI|DASHSCOPE|GEMINI|GOOGLE_|VERTEX|AWS_|BEDROCK|OTEL_|MCP_|npm_)/i;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { only: null, keep: false, updateFixtures: false, lenientClaudeHome: false, verbose: false };
  for (const a of argv) {
    if (a === '--keep') out.keep = true;
    else if (a === '--update-fixtures') out.updateFixtures = true;
    else if (a === '--lenient-claude-home') out.lenientClaudeHome = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a.startsWith('--only=')) out.only = a.slice(7).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown flag ${a}`);
  }
  return out;
}

function stamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    return true;
  } catch {
    return false;
  }
}

/** GET a URL (redirects followed); resolves to the body as a Buffer. */
function httpsGet(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'usage-notch-canary' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(httpsGet(new URL(res.headers.location, url).toString(), redirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.setTimeout(INSTALL_TIMEOUT_MS, () => req.destroy(new Error(`GET ${url} timed out`)));
    req.on('error', reject);
  });
}

/** Stream a URL to `dest` through `dest.part`, so a cut download never looks complete. */
function download(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'usage-notch-canary' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(download(new URL(res.headers.location, url).toString(), dest, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`));
        return;
      }
      const part = `${dest}.part`;
      const out = fs.createWriteStream(part);
      res.pipe(out);
      out.on('finish', () => out.close(() => {
        try {
          fs.renameSync(part, dest);
          resolve();
        } catch (err) {
          reject(err);
        }
      }));
      res.on('error', reject);
      out.on('error', reject);
    });
    req.setTimeout(INSTALL_TIMEOUT_MS, () => req.destroy(new Error(`GET ${url} timed out`)));
    req.on('error', reject);
  });
}

/** The process environment minus anything that could reach a real account. */
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!STRIP_ENV.test(k)) env[k] = v;
  env.NO_PROXY = ['127.0.0.1', 'localhost', env.NO_PROXY].filter(Boolean).join(',');
  env.no_proxy = env.NO_PROXY;
  return env;
}

/** Every per-user location a tool could fall back to, inside `home`. */
function homeEnv(home) {
  const dirs = {
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    TEMP: path.join(home, 'AppData', 'Local', 'Temp'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const parsed = path.parse(home);
  return {
    ...dirs,
    TMP: dirs.TEMP,
    USERPROFILE: home,
    HOME: home,
    HOMEDRIVE: parsed.root.replace(/[\\/]+$/, ''),
    HOMEPATH: home.slice(parsed.root.length - 1),
  };
}

/**
 * Run a command, never through a shell; stdin is closed (Codex otherwise
 * waits for more input). Resolves with exit code, output tails and timing.
 */
function runProcess(cmd, args, { cwd, env, timeoutMs = RUN_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ code: null, error: err.message, stdout: '', stderr: '', timedOut: false, ms: 0 });
      return;
    }
    const cap = (s, c) => (s.length > 200000 ? s : s + c);
    child.stdout.on('data', (c) => { stdout = cap(stdout, c.toString('utf8')); });
    child.stderr.on('data', (c) => { stderr = cap(stderr, c.toString('utf8')); });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, error: err.message, stdout, stderr, timedOut, ms: Date.now() - started });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, ms: Date.now() - started });
    });
  });
}

/**
 * Environment for Windows PowerShell 5.1. A PSModulePath inherited from
 * PowerShell 7 makes 5.1 fail to load its own modules
 * (Get-AuthenticodeSignature, Get-CimInstance), so it is dropped and 5.1
 * rebuilds its default.
 */
function psEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (k.toLowerCase() !== 'psmodulepath') env[k] = v;
  return env;
}

/** Stop one process tree WE started, by its pid. */
function killTree(pid) {
  if (!pid) return;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch {
    // Already gone.
  }
}

/**
 * Processes left running by a tool (a leader, a background server): those
 * whose executable lives in our tools cache, or whose command line names the
 * tools cache or this run's directory (a node-based tool runs as node.exe).
 * The user's own installs are elsewhere and never match, and this process
 * and its ancestors (the shell that launched the canary) are always spared.
 */
function reapStragglers(runDir) {
  const tools = TOOLS_DIR.toLowerCase();
  const run = runDir.toLowerCase();
  let list = [];
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
    ], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: psEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    list = JSON.parse(out || '[]');
    if (!Array.isArray(list)) list = [list];
  } catch {
    return [];
  }
  const parentOf = new Map(list.filter(Boolean).map((p) => [p.ProcessId, p.ParentProcessId]));
  const spared = new Set();
  for (let pid = process.pid, hops = 0; pid && !spared.has(pid) && hops < 64; pid = parentOf.get(pid), hops += 1) spared.add(pid);
  const reaped = [];
  for (const p of list) {
    if (!p || spared.has(p.ProcessId)) continue;
    const exe = String(p.ExecutablePath || '').toLowerCase();
    const cmdLine = String(p.CommandLine || '').toLowerCase();
    if (!exe.startsWith(tools) && !cmdLine.includes(tools) && !cmdLine.includes(run)) continue;
    killTree(p.ProcessId);
    reaped.push(String(p.Name));
  }
  return reaped;
}

/** Directories that are bulk noise in a 'files written' list, never usage. */
const NOISE_DIRS = new Set(['node-compile-cache', '.git', 'node_modules']);

/** Relative paths (with sizes) of every file under `root`, capped; noise directories skipped. */
function listFiles(root, cap = 400) {
  const out = [];
  let more = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!NOISE_DIRS.has(e.name)) walk(full);
        continue;
      }
      if (out.length >= cap) { more += 1; continue; }
      let size = 0;
      try { size = fs.statSync(full).size; } catch { /* vanished */ }
      out.push(`${path.relative(root, full).split(path.sep).join('/')} (${size} B)`);
    }
  };
  walk(root);
  if (more) out.push(`... and ${more} more`);
  return out;
}

/**
 * Files in a tool's home that mention all three of the mock's per-call counts
 * (1234 or 234, 1000, 56): where the usage most likely went when it is not
 * where our reader looks. Text files up to 8 MB; never part of a PASS.
 */
function usageSuspects(home) {
  const hits = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!NOISE_DIRS.has(e.name)) walk(full);
        continue;
      }
      if (hits.length >= 20) return;
      try {
        if (fs.statSync(full).size > 8 * 1024 * 1024) continue;
        const text = fs.readFileSync(full, 'utf8');
        if (/\b(1234|234)\b/.test(text) && /\b1000\b/.test(text) && /\b56\b/.test(text)) {
          hits.push(path.relative(home, full).split(path.sep).join('/'));
        }
      } catch { /* unreadable */ }
    }
  };
  walk(home);
  return hits;
}

/**
 * Files matching a path pattern under `root`. Each segment is a literal, `*`
 * (any one name) or a /regex/ for the last segment.
 */
function findFiles(root, segments) {
  let level = [root];
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const last = i === segments.length - 1;
    const next = [];
    for (const dir of level) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const ok = seg === '*' ? true : seg instanceof RegExp ? seg.test(e.name) : e.name === seg;
        if (!ok) continue;
        if (last ? e.isFile() : e.isDirectory()) next.push(path.join(dir, e.name));
      }
    }
    level = next;
  }
  return level.sort();
}

/** Text safe for the report: the throwaway home and the real profile path replaced. */
function scrub(text, home) {
  let t = String(text || '');
  const swaps = [[home, '<home>'], [CACHE, '<cache>'], [os.homedir(), '~']];
  for (const [from, to] of swaps) {
    if (!from) continue;
    for (const v of [from, from.split(path.sep).join('/'), JSON.stringify(from).slice(1, -1)]) {
      t = t.split(v).join(to);
    }
  }
  return t;
}

function tail(text, lines = 12) {
  return String(text || '').replace(/\r/g, '').trim().split('\n').slice(-lines).join('\n');
}

// ---------------------------------------------------------------------------
// Installing the tools
// ---------------------------------------------------------------------------

/** `[node, npm-cli.js]`, never a shell: npm.cmd needs one on Windows. */
function npmCommand() {
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    process.env.npm_execpath,
  ].filter((p) => p && /\.c?js$/.test(p) && fs.existsSync(p));
  if (!candidates.length) throw new Error('npm-cli.js not found next to node; run with the node that ships npm');
  return [process.execPath, candidates[0]];
}

async function npmLatest(pkg) {
  const body = await httpsGet(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}/latest`);
  const v = JSON.parse(body.toString('utf8')).version;
  if (typeof v !== 'string' || !/^\d+\.\d+\.\d+/.test(v)) throw new Error(`npm registry gave no version for ${pkg}`);
  return v;
}

/** Drop all but the newest KEEP_VERSIONS installs of one tool. */
function pruneVersions(toolDir, current) {
  let names = [];
  try {
    names = fs.readdirSync(toolDir).filter((n) => n !== current);
  } catch {
    return;
  }
  const byAge = names
    .map((n) => ({ n, t: (() => { try { return fs.statSync(path.join(toolDir, n)).mtimeMs; } catch { return 0; } })() }))
    .sort((a, b) => b.t - a.t);
  for (const { n } of byAge.slice(KEEP_VERSIONS - 1)) rmrf(path.join(toolDir, n));
}

/** `npm install --prefix` into the cache (once per version); resolves to how to run the bin. */
async function ensureNpm(tool, version) {
  const toolDir = path.join(TOOLS_DIR, tool.id);
  const dir = path.join(toolDir, version);
  const marker = path.join(dir, '.canary-complete');
  if (!fs.existsSync(marker)) {
    rmrf(dir);
    fs.mkdirSync(dir, { recursive: true });
    // A package.json of its own, so npm never walks up looking for a project root.
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `canary-${tool.id}`, private: true }, null, 2));
    const [node, cli] = npmCommand();
    const env = cleanEnv();
    const res = await runProcess(node, [
      cli, 'install', `${tool.pkg}@${version}`,
      '--prefix', dir, '--cache', NPM_CACHE,
      '--no-audit', '--no-fund', '--no-update-notifier', '--save-exact',
    ], { cwd: dir, env, timeoutMs: INSTALL_TIMEOUT_MS });
    if (res.code !== 0) throw new Error(`npm install ${tool.pkg}@${version} failed (exit ${res.code}): ${tail(res.stderr, 6)}`);
    fs.writeFileSync(marker, new Date().toISOString());
  }
  try { fs.utimesSync(dir, new Date(), new Date()); } catch { /* best effort */ }
  pruneVersions(toolDir, version);
  const pkgDir = path.join(dir, 'node_modules', ...tool.pkg.split('/'));
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && pkg.bin[tool.bin];
  if (!rel) throw new Error(`${tool.pkg} has no "${tool.bin}" bin`);
  const bin = path.join(pkgDir, rel);
  if (!fs.existsSync(bin)) throw new Error(`${tool.pkg} bin ${rel} is missing after install`);
  const viaNode = /\.(c|m)?js$/.test(bin);
  return { version: pkg.version, cmd: viaNode ? process.execPath : bin, pre: viaNode ? [bin] : [] };
}

/** The Authenticode status and signer of a file, via PowerShell. */
function signatureOf(file) {
  const lit = file.replace(/'/g, "''");
  const out = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference = 'Stop'; $s = Get-AuthenticodeSignature -LiteralPath '${lit}'; [pscustomobject]@{ Status = [string]$s.Status; Subject = [string]$s.SignerCertificate.Subject } | ConvertTo-Json -Compress`,
  ], { encoding: 'utf8', windowsHide: true, env: psEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  const sig = JSON.parse(out);
  const org = /(?:^|,\s*)O=("?)([^",]+(?:,[^=,]+(?=,|$))?)\1/.exec(sig.Subject || '');
  return { status: sig.Status, subject: sig.Subject, org: org ? org[2].trim() : null };
}

async function grokLatest() {
  const v = (await httpsGet(`${GROK_BUCKET}/stable`)).toString('utf8').trim();
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`Grok stable channel gave an odd version: ${JSON.stringify(v.slice(0, 40))}`);
  return v;
}

/** Download the signed Windows binary once per version; verify it before every run. */
async function ensureGrok(tool, version) {
  const toolDir = path.join(TOOLS_DIR, tool.id);
  const dir = path.join(toolDir, version);
  const exe = path.join(dir, 'grok.exe');
  if (!fs.existsSync(exe)) {
    fs.mkdirSync(dir, { recursive: true });
    await download(`${GROK_BUCKET}/grok-${version}-windows-x86_64.exe`, exe);
  }
  try { fs.utimesSync(dir, new Date(), new Date()); } catch { /* best effort */ }
  pruneVersions(toolDir, version);
  let sig;
  try {
    sig = signatureOf(exe);
  } catch (err) {
    // Could not CHECK (PowerShell trouble): not run, but kept for the next try.
    throw new Error(`could not verify grok.exe's signature, not run: ${tail(err.message, 2)}`);
  }
  if (sig.status !== 'Valid' || !GROK_SIGNERS.includes(sig.org)) {
    rmrf(dir);
    throw new Error(`grok.exe signature refused (status ${sig.status}, signer ${sig.subject || 'none'}); deleted, not run`);
  }
  return { version, cmd: exe, pre: [], signer: sig.subject };
}

// ---------------------------------------------------------------------------
// The check every tool shares
// ---------------------------------------------------------------------------

/**
 * Totals must be exactly k model calls' worth, 1 <= k <= calls served.
 * `tokens` is the reader's TokenBreakdown.
 */
function checkTotals(tokens, served, reasons) {
  const k = tokens.output / USAGE.completion;
  if (!Number.isInteger(k) || k < 1) {
    reasons.push(`output ${tokens.output} is not a whole multiple of ${USAGE.completion} (k>=1)`);
    return 0;
  }
  const want = { input: UNCACHED * k, cacheRead: USAGE.cached * k, cacheWrite: 0, output: USAGE.completion * k };
  for (const f of Object.keys(want)) {
    if (tokens[f] !== want[f]) reasons.push(`${f} ${tokens[f]}, expected ${want[f]} for ${k} call(s)`);
  }
  if (tokens.billable !== tokens.input + tokens.output + tokens.cacheWrite) reasons.push('billable != input + output + cacheWrite');
  if (k > served) reasons.push(`reader counted ${k} calls but the mock served only ${served}: double count`);
  return k;
}

function eventsOf(res) {
  return Array.isArray(res) ? res : (res && res.events) || [];
}

/** One line with the record kinds a journal holds, for a FAIL report. */
function shapeOf(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const kinds = new Map();
    for (const l of lines.slice(0, 2000)) {
      let k = '?';
      try {
        const o = JSON.parse(l);
        k = o.type || Object.keys(o).slice(0, 4).join('+');
      } catch { k = 'unparsable'; }
      kinds.set(k, (kinds.get(k) || 0) + 1);
    }
    return Array.from(kinds, ([k, n]) => `${k}x${n}`).join(' ');
  } catch {
    return 'unreadable';
  }
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    id: 'qwen',
    name: 'Qwen Code',
    pkg: '@qwen-code/qwen-code',
    bin: 'qwen',
    fixtureVersion: '0.24.6',
    latest: () => npmLatest('@qwen-code/qwen-code'),
    install: ensureNpm,
    runs: (ctx) => [{
      label: 'openai',
      args: ['--auth-type', 'openai', '-p', PROMPT],
      env: {
        QWEN_HOME: path.join(ctx.home, '.qwen'),
        OPENAI_BASE_URL: `${ctx.base}/v1`,
        OPENAI_API_KEY: 'sk-canary',
        OPENAI_MODEL: 'qwen3-coder-plus',
      },
    }],
    where: '.qwen/usage/token-usage-YYYY-MM.jsonl',
    locate: (home) => findFiles(path.join(home, '.qwen'), ['usage', /^token-usage-\d{4}-\d{2}\.jsonl$/]),
    async read(ctx) {
      const evs = eventsOf(qwenUsage.qwenUsageEvents({ home: path.join(ctx.home, '.qwen'), now: ctx.to }));
      const { tokens, byModel } = qwenUsage.sumQwenTokens(evs, ctx.from, ctx.to);
      const reasons = [];
      const models = byModel.map((m) => m.model);
      if (JSON.stringify(models) !== JSON.stringify(['qwen3-coder-plus'])) reasons.push(`models ${JSON.stringify(models)}, expected ["qwen3-coder-plus"]`);
      if (!(qwenCost(evs, ctx.from, ctx.to, false).totalUsd > 0)) reasons.push('qwenCost priced it at $0');
      return { evs, tokens, models, reasons, fixtureEvents: 2 };
    },
    fixture(ctx, dest) {
      const usage = path.join(dest, 'usage');
      fs.mkdirSync(usage, { recursive: true });
      // Byte for byte, as the test header promises.
      for (const f of this.locate(ctx.home)) fs.copyFileSync(f, path.join(usage, path.basename(f)));
    },
  },
  {
    id: 'kimi',
    name: 'Kimi Code',
    pkg: '@moonshot-ai/kimi-code',
    bin: 'kimi',
    fixtureVersion: '2.1.1',
    latest: () => npmLatest('@moonshot-ai/kimi-code'),
    install: ensureNpm,
    setup(ctx) {
      const kh = path.join(ctx.home, '.kimi-code');
      fs.mkdirSync(kh, { recursive: true });
      fs.writeFileSync(path.join(kh, 'config.toml'), [
        'default_model = "kimi-code/kimi-for-coding"',
        '',
        '[providers.mock]',
        'type = "kimi"',
        `base_url = "${ctx.base}/v1"`,
        'api_key = "sk-canary"',
        '',
        '[models."kimi-code/kimi-for-coding"]',
        'provider = "mock"',
        'model = "kimi-for-coding"',
        'max_context_size = 262144',
        '',
      ].join('\n'));
    },
    runs(ctx) {
      const common = {
        KIMI_CODE_HOME: path.join(ctx.home, '.kimi-code'),
        KIMI_CODE_NO_AUTO_UPDATE: '1',
        KIMI_CLI_NO_AUTO_UPDATE: '1',
        KIMI_DISABLE_TELEMETRY: '1',
      };
      return [
        // The plan alias, from config.toml.
        { label: 'config.toml', args: ['-p', PROMPT], env: common },
        // The env-var model, which records the alias `__kimi_env_model__`.
        {
          label: 'KIMI_MODEL_*',
          args: ['-p', PROMPT],
          env: {
            ...common,
            KIMI_MODEL_NAME: 'kimi-for-coding',
            KIMI_MODEL_BASE_URL: `${ctx.base}/v1`,
            KIMI_MODEL_API_KEY: 'sk-canary',
            KIMI_MODEL_PROVIDER_TYPE: 'kimi',
            KIMI_MODEL_MAX_CONTEXT_SIZE: '262144',
          },
        },
      ];
    },
    where: '.kimi-code/sessions/<workspace>/<session>/agents/<agent>/wire.jsonl',
    locate: (home) => findFiles(path.join(home, '.kimi-code'), ['sessions', '*', '*', 'agents', '*', 'wire.jsonl']),
    async read(ctx) {
      const evs = eventsOf(kimiUsage.kimiUsageEvents({ home: path.join(ctx.home, '.kimi-code'), now: ctx.to }));
      const { tokens, byModel } = kimiUsage.sumKimiTokens(evs, ctx.from, ctx.to);
      const reasons = [];
      const models = byModel.map((m) => m.model).sort();
      const want = ['kimi-code/kimi-for-coding', 'unknown'];
      if (JSON.stringify(models) !== JSON.stringify(want)) reasons.push(`models ${JSON.stringify(models)}, expected ${JSON.stringify(want)}`);
      if (!kimiUsage.isKimiPlanAlias('kimi-code/kimi-for-coding')) reasons.push('isKimiPlanAlias no longer accepts kimi-code/kimi-for-coding');
      return { evs, tokens, models, reasons, fixtureEvents: 2 };
    },
    /**
     * Journals trimmed to their usage, fork and metadata records; every other
     * line becomes `{type, trimmed, time}` (`type` only when it is the
     * record's first key, as the reader's head check sees it).
     */
    fixture(ctx, dest) {
      const kh = path.join(ctx.home, '.kimi-code');
      for (const f of this.locate(ctx.home)) {
        const out = [];
        for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          let o;
          try { o = JSON.parse(line); } catch { continue; }
          if (o.type === 'usage.record' || o.type === 'forked' || o.type === 'metadata') {
            out.push(scrub(JSON.stringify(o), ctx.home));
            continue;
          }
          const t = {};
          if (Object.keys(o)[0] === 'type') t.type = o.type;
          t.trimmed = true;
          if (o.time !== undefined) t.time = o.time;
          out.push(JSON.stringify(t));
        }
        const target = path.join(dest, path.relative(kh, f));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `${out.join('\n')}\n`);
      }
    },
  },
  {
    id: 'grok',
    name: 'Grok Build',
    bin: 'grok',
    fixtureVersion: '1.0.44',
    latest: grokLatest,
    install: ensureGrok,
    runs: (ctx) => [{
      label: 'xai',
      // Since 1.0.5x `-p` (`--single`) takes the prompt as its value.
      args: ['--output-format', 'plain', '-p', PROMPT],
      env: {
        GROK_HOME: path.join(ctx.home, '.grok'),
        XAI_API_KEY: 'xai-canary',
        GROK_XAI_API_BASE_URL: `${ctx.base}/v1`,
        GROK_PRODUCTION_CLI_CHAT_PROXY_BASE_URL: `${ctx.base}/v1`,
      },
    }],
    where: '.grok/sessions/<encoded-cwd>/<session>/usage.json',
    locate: (home) => findFiles(path.join(home, '.grok'), ['sessions', '*', '*', 'usage.json']),
    async read(ctx) {
      const evs = eventsOf(grokUsage.grokUsageEvents({ home: path.join(ctx.home, '.grok'), now: ctx.to }));
      const { tokens, byModel } = grokUsage.sumGrokTokens(evs, ctx.from, ctx.to);
      const reasons = [];
      const models = byModel.map((m) => m.model);
      if (JSON.stringify(models) !== JSON.stringify(['mock-model'])) reasons.push(`models ${JSON.stringify(models)}, expected ["mock-model"]`);
      const k = tokens.output / USAGE.completion;
      const usd = evs.reduce((s, e) => s + (e.usd || 0), 0);
      const wantUsd = (k * USAGE.costTicks) / 1e10;
      if (Math.abs(usd - wantUsd) > 1e-12) reasons.push(`reported cost $${usd}, expected $${wantUsd}`);
      const cost = grokCost(evs, ctx.from, ctx.to, false).totalUsd;
      if (Math.abs(cost - Math.round(wantUsd * 1e6) / 1e6) > 1e-9) reasons.push(`grokCost $${cost}, expected $${wantUsd.toFixed(6)}`);
      return { evs, tokens, models, reasons, fixtureEvents: 1 };
    },
    /** usage.json byte for byte; the `<encoded-cwd>` directory renamed to a neutral path. */
    fixture(ctx, dest) {
      for (const f of this.locate(ctx.home)) {
        const session = path.basename(path.dirname(f));
        const target = path.join(dest, 'sessions', 'C%3A%5Cwork', session, 'usage.json');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(f, target);
      }
    },
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    pkg: '@openai/codex',
    bin: 'codex',
    stretch: true,
    latest: () => npmLatest('@openai/codex'),
    install: ensureNpm,
    setup(ctx) {
      const ch = path.join(ctx.home, '.codex');
      fs.mkdirSync(ch, { recursive: true });
      fs.writeFileSync(path.join(ch, 'config.toml'), [
        'model = "gpt-5.5"',
        'model_provider = "canary"',
        '',
        '[model_providers.canary]',
        'name = "Canary mock"',
        `base_url = "${ctx.base}/v1"`,
        'env_key = "CANARY_API_KEY"',
        'wire_api = "responses"',
        '',
      ].join('\n'));
    },
    runs: (ctx) => [{
      label: 'exec',
      args: ['exec', '--skip-git-repo-check', PROMPT],
      env: { CODEX_HOME: path.join(ctx.home, '.codex'), CANARY_API_KEY: 'sk-canary' },
    }],
    where: '.codex/sessions/YYYY/MM/DD/rollout-*.jsonl',
    locate: (home) => findFiles(path.join(home, '.codex'), ['sessions', '*', '*', '*', /^rollout-.*\.jsonl$/]),
    async read(ctx) {
      const evs = eventsOf(codexUsage.codexUsageEvents({ home: path.join(ctx.home, '.codex'), now: ctx.to, startMs: ctx.from }));
      const { tokens, byModel } = codexUsage.sumCodexTokens(evs, ctx.from, ctx.to);
      const reasons = [];
      const models = byModel.map((m) => m.model);
      if (JSON.stringify(models) !== JSON.stringify(['gpt-5.5'])) reasons.push(`models ${JSON.stringify(models)}, expected ["gpt-5.5"]`);
      return { evs, tokens, models, reasons, fixtureEvents: null };
    },
  },
  {
    id: 'claude',
    name: 'Claude Code',
    pkg: '@anthropic-ai/claude-code',
    bin: 'claude',
    stretch: true,
    guardsRealClaude: true,
    latest: () => npmLatest('@anthropic-ai/claude-code'),
    install: ensureNpm,
    runs: (ctx) => [{
      label: 'print',
      args: ['-p', `${PROMPT} (${ctx.nonce})`, '--output-format', 'text'],
      env: {
        CLAUDE_CONFIG_DIR: path.join(ctx.home, '.claude'),
        ANTHROPIC_BASE_URL: ctx.base,
        ANTHROPIC_API_KEY: 'sk-ant-canary',
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
      },
    }],
    where: '.claude/projects/<encoded-cwd>/<session>.jsonl',
    locate: (home) => findFiles(path.join(home, '.claude'), ['projects', '*', /\.jsonl$/]),
    async read(ctx) {
      const res = await claudeScan({ root: path.join(ctx.home, '.claude', 'projects'), cursors: {}, priorEvents: [], now: ctx.to });
      const evs = claudeAgg.dedupe(res.events || []).filter((e) => e.model !== SYNTHETIC_MODEL);
      const { tokens, byModel } = claudeAgg.sumWindow(evs, ctx.from, ctx.to);
      const reasons = [];
      if (!res.ok) reasons.push(`scan not ok (${res.errorCode})`);
      const models = byModel.map((m) => m.model);
      if (!models.length || models.some((m) => !/^claude-/.test(m))) reasons.push(`models ${JSON.stringify(models)}, expected claude-*`);
      return { evs, tokens, models, reasons, fixtureEvents: null };
    },
  },
];

// ---------------------------------------------------------------------------
// Real Claude config guard
// ---------------------------------------------------------------------------

function protectedClaudePaths() {
  const real = os.homedir();
  const roots = [path.join(real, '.claude.json'), path.join(real, '.claude')];
  if (process.env.CLAUDE_CONFIG_DIR) roots.push(path.resolve(process.env.CLAUDE_CONFIG_DIR));
  return roots;
}

/** path -> "mtime:size" for each root and its entries, three levels down. Nothing is opened. */
function snapshotClaude(roots) {
  const snap = new Map();
  const visit = (p, depth) => {
    let st;
    try { st = fs.lstatSync(p); } catch { return; }
    snap.set(p, `${st.mtimeMs}:${st.isDirectory() ? 'd' : st.size}`);
    if (!st.isDirectory() || depth >= 3 || snap.size > 50000) return;
    let names = [];
    try { names = fs.readdirSync(p); } catch { return; }
    for (const n of names) visit(path.join(p, n), depth + 1);
  };
  for (const r of roots) visit(r, 0);
  return snap;
}

/**
 * The entries that differ, and whether any carries `nonce` in its path or
 * (for a changed regular file, credentials excepted) in its bytes.
 */
function diffClaude(before, after, nonce) {
  const changed = [];
  for (const [p, v] of after) if (before.get(p) !== v) changed.push({ p, how: before.has(p) ? 'changed' : 'added' });
  for (const p of before.keys()) if (!after.has(p)) changed.push({ p, how: 'removed' });
  let marked = false;
  const needle = Buffer.from(nonce);
  for (const c of changed) {
    if (c.p.includes(nonce)) { c.marker = true; marked = true; continue; }
    if (c.how === 'removed' || /credential/i.test(path.basename(c.p))) continue;
    try {
      const st = fs.statSync(c.p);
      if (!st.isFile() || st.size > 64 * 1024 * 1024) continue;
      // Searched, never logged or kept.
      if (fs.readFileSync(c.p).includes(needle)) { c.marker = true; marked = true; }
    } catch { /* vanished */ }
  }
  return { changed, marked };
}

// ---------------------------------------------------------------------------
// One tool
// ---------------------------------------------------------------------------

/** On a FAIL: every file the tool wrote, and the ones that look like its usage. */
function noteFiles(result, home) {
  result.filesWritten = listFiles(home).map((f) => scrub(f, home));
  result.usageSuspects = usageSuspects(home).map((f) => scrub(f, home));
}

async function runTool(tool, { mock, base, runDir, nonce, opts }) {
  const result = {
    id: tool.id, tool: tool.name, version: null, status: 'FAIL', reasons: [], notes: [],
    runs: [], mock: null, filesWritten: null, usageFiles: [], totals: null, events: 0, models: [],
  };
  const started = Date.now();
  let home = null;
  try {
    result.version = await tool.latest();
    const bin = await tool.install(tool, result.version);
    result.version = bin.version || result.version;
    if (bin.signer) result.notes.push(`signed by ${bin.signer}`);
    if (tool.fixtureVersion && tool.fixtureVersion !== result.version) result.notes.push(`fixture was ${tool.fixtureVersion}`);

    home = path.join(runDir, tool.id, 'home');
    const cwd = path.join(home, 'work');
    fs.mkdirSync(cwd, { recursive: true });
    const ctx = { home, cwd, base, nonce };
    if (tool.setup) tool.setup(ctx);
    const baseEnv = { ...cleanEnv(), ...homeEnv(home) };

    mock.setTag(tool.id);
    const claudeRoots = tool.guardsRealClaude ? protectedClaudePaths() : null;
    for (const run of tool.runs(ctx)) {
      const env = { ...baseEnv, ...run.env };
      if (tool.guardsRealClaude) {
        // Belt and braces: refuse to start unless every home it could use is ours.
        for (const k of ['USERPROFILE', 'HOME', 'CLAUDE_CONFIG_DIR', 'APPDATA', 'LOCALAPPDATA']) {
          if (!env[k] || !path.resolve(env[k]).startsWith(home)) throw new Error(`refusing to run: ${k} is not inside the throwaway home`);
        }
      }
      const before = claudeRoots ? snapshotClaude(claudeRoots) : null;
      const res = await runProcess(bin.cmd, [...bin.pre, ...run.args], { cwd, env });
      const reaped = reapStragglers(runDir);
      if (claudeRoots) {
        const { changed, marked } = diffClaude(before, snapshotClaude(claudeRoots), nonce);
        const list = changed.slice(0, 20).map((c) => `${c.how} ${scrub(c.p, home)}${c.marker ? ' [CANARY MARKER]' : ''}`);
        if (marked) {
          result.touchedRealClaude = true;
          result.reasons.push(`REAL Claude config touched by the canary run: ${list.join('; ')}`);
        } else if (changed.length && !opts.lenientClaudeHome) {
          result.touchedRealClaude = true;
          result.reasons.push(`real Claude config changed during the run (no canary marker in it; rerun outside a Claude Code session or with --lenient-claude-home): ${list.join('; ')}`);
        } else if (changed.length) {
          result.notes.push(`real Claude config changed during the run without the canary marker (another Claude Code session?): ${list.join('; ')}`);
        } else {
          result.notes.push('real ~/.claude and ~/.claude.json unchanged');
        }
      }
      result.runs.push({
        label: run.label,
        exit: res.code,
        timedOut: res.timedOut,
        ms: res.ms,
        error: res.error || null,
        stdoutTail: scrub(tail(res.stdout, 6), home),
        stderrTail: scrub(tail(res.stderr, 12), home),
        reaped,
      });
      if (res.timedOut) result.notes.push(`${run.label}: timed out after ${RUN_TIMEOUT_MS / 1000}s`);
      else if (res.code !== 0) result.notes.push(`${run.label}: exit ${res.code}${res.error ? ` (${res.error})` : ''}`);
      if (reaped.length) result.notes.push(`${run.label}: stopped leftover ${reaped.join(', ')}`);
      // Abort: no further run of a tool that reached the real config.
      if (result.touchedRealClaude) break;
    }
    result.mock = mock.stats(tool.id);
    if (result.mock.unknown.length) {
      const routes = Array.from(new Set(result.mock.unknown.map((u) => `${u.method} ${u.path || '/'}`)));
      result.notes.push(`mock had no route for: ${routes.join(', ')}`);
    }
    if (result.touchedRealClaude) return result;

    const files = tool.locate(home);
    result.usageFiles = files.map((f) => scrub(f, home));
    if (!files.length) {
      noteFiles(result, home);
      const ran = result.runs.map((r) => `${r.label} exit ${r.exit}`).join(', ');
      result.reasons.push(`NO usage file where our reader looks (${tool.where}); the tool ran (${ran}), served ${result.mock.calls} model call(s); see filesWritten`);
      if (!result.mock.calls) {
        const err = result.runs.map((r) => r.stderrTail || r.stdoutTail).filter(Boolean).join(' | ');
        result.reasons.push(`the mock was never called: the tool did not reach it. ${tail(err, 3)}`);
      }
      return result;
    }

    const rctx = { home, from: started - 5 * MIN_MS, to: Date.now() + 5 * MIN_MS };
    const read = await tool.read(rctx);
    result.events = read.evs.length;
    result.totals = read.tokens;
    result.models = read.models;
    if (!read.evs.length) {
      result.reasons.push(`reader found 0 events in ${files.length} file(s) at ${tool.where}: format changed? shape: ${files.map(shapeOf).join(' / ')}`);
      noteFiles(result, home);
      return result;
    }
    const k = checkTotals(read.tokens, result.mock.calls, result.reasons);
    result.calls = k;
    result.reasons.push(...read.reasons);
    if (read.fixtureEvents != null && read.evs.length !== read.fixtureEvents) {
      result.notes.push(`${read.evs.length} event(s); the fixture has ${read.fixtureEvents}`);
    }
    result.notes.push(`${read.evs.length} event(s), ${k} call(s) counted of ${result.mock.calls} served`);
    if (!result.reasons.length) result.status = 'PASS';
    else noteFiles(result, home);
    result.ctx = ctx;
    return result;
  } catch (err) {
    result.reasons.push(scrub(err && err.message ? err.message : String(err), home || ''));
    if (home && fs.existsSync(home)) noteFiles(result, home);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Fixtures, report, main
// ---------------------------------------------------------------------------

function updateFixtures(results) {
  const done = [];
  for (const r of results) {
    const tool = TOOLS.find((t) => t.id === r.id);
    if (!tool.fixture) continue;
    if (r.status !== 'PASS') {
      console.log(`  fixtures: ${r.id} left as is (it did not pass)`);
      continue;
    }
    const dest = path.join(FIXTURES, r.id);
    rmrf(dest);
    fs.mkdirSync(dest, { recursive: true });
    tool.fixture(r.ctx, dest);
    // Nothing personal may ride along: no profile path, no cache path.
    for (const f of listFiles(dest, 10000)) {
      const rel = f.replace(/ \(\d+ B\)$/, '');
      const text = fs.readFileSync(path.join(dest, rel), 'utf8');
      for (const bad of [os.homedir(), os.homedir().split(path.sep).join('/'), JSON.stringify(os.homedir()).slice(1, -1), os.userInfo().username]) {
        if (bad && bad.length > 2 && (text.includes(bad) || rel.includes(bad))) {
          throw new Error(`fixture ${r.id}/${rel} would carry a personal path; not written`);
        }
      }
    }
    done.push(r);
  }
  if (done.length) {
    console.log('\nFixtures replaced in test/fixtures/real-cli/: ' + done.map((r) => `${r.id} ${r.version}`).join(', '));
    console.log('The fixture test pins the old run, so update test/real-cli-output.test.js by hand:');
    console.log('  - the versions in the header comment and test names;');
    console.log('  - NOW (the files are dated by this run): e.g. ' + new Date(Date.now()).toISOString());
    for (const r of done) {
      if (r.id === 'grok') {
        const ev = r.ctx && grokUsage.grokUsageEvents({ home: path.join(r.ctx.home, '.grok'), now: Date.now() + 5 * MIN_MS });
        const first = eventsOf(ev)[0];
        if (first) console.log(`  - Grok's evs[0].ts: ${new Date(first.ts).toISOString()}`);
      }
      if (r.events) console.log(`  - ${r.id}: ${r.events} event(s), totals ${JSON.stringify(r.totals)}`);
    }
    console.log('Then run npm test.');
  }
}

function printTable(results) {
  const rows = results.map((r) => [r.tool, r.version || '?', r.status, r.status === 'PASS' ? (r.notes.find((n) => /call\(s\) counted/.test(n)) || '') : (r.reasons[0] || '')]);
  const head = ['Tool', 'Version', 'Result', 'Reason'];
  const w = [0, 1, 2].map((i) => Math.max(head[i].length, ...rows.map((r) => r[i].length)));
  const line = (r) => `${r[0].padEnd(w[0])}  ${r[1].padEnd(w[1])}  ${r[2].padEnd(w[2])}  ${r[3]}`;
  console.log('');
  console.log(line(head));
  console.log(line(w.map((n) => '-'.repeat(n)).concat(['-'.repeat(6)])));
  for (const r of rows) console.log(line(r));
  for (const r of results) {
    const extra = [...r.reasons.slice(r.status === 'PASS' ? 0 : 1).map((x) => `FAIL: ${x}`), ...r.notes.map((x) => `note: ${x}`)];
    if (!extra.length && !r.filesWritten) continue;
    console.log(`\n[${r.id}]`);
    for (const x of extra) console.log(`  ${x}`);
    if (r.status !== 'PASS') {
      for (const run of r.runs) {
        if (run.exit !== 0 && (run.stderrTail || run.stdoutTail)) console.log(`  ${run.label} output:\n    ${(run.stderrTail || run.stdoutTail).split('\n').join('\n    ')}`);
      }
      if (r.usageSuspects && r.usageSuspects.length) {
        console.log("  files that carry the mock's token counts (where the usage likely went):");
        for (const f of r.usageSuspects) console.log(`    ${f}`);
      }
      if (r.filesWritten) {
        console.log('  files the tool wrote in its home:');
        for (const f of r.filesWritten.slice(0, 60)) console.log(`    ${f}`);
        if (r.filesWritten.length > 60) console.log(`    ... ${r.filesWritten.length - 60} more in the JSON report`);
      }
    }
  }
}

const HELP = `Usage: node scripts/real-cli-canary/run.js [--only=qwen,kimi,grok,codex,claude] [--keep] [--update-fixtures] [--lenient-claude-home] [--verbose]`;

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n${HELP}`);
    return 2;
  }
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  if (process.platform !== 'win32') {
    console.error('The canary targets the Windows builds of the tools; run it on Windows.');
    return 2;
  }
  const selected = opts.only ? TOOLS.filter((t) => opts.only.includes(t.id)) : TOOLS;
  const unknown = (opts.only || []).filter((id) => !TOOLS.some((t) => t.id === id));
  if (unknown.length || !selected.length) {
    console.error(`unknown tool id(s): ${unknown.join(', ') || '(none selected)'}\n${HELP}`);
    return 2;
  }
  // Claude Code last: its guard compares the real config right around its own run.
  selected.sort((a, b) => Number(Boolean(a.guardsRealClaude)) - Number(Boolean(b.guardsRealClaude)));

  const startedAt = Date.now();
  const nonce = `canary${crypto.randomBytes(6).toString('hex')}`;
  const runDir = path.join(RUNS_DIR, `${stamp(startedAt)}-${nonce}`);
  for (const d of [TOOLS_DIR, runDir, REPORTS_DIR, NPM_CACHE]) fs.mkdirSync(d, { recursive: true });

  const mockLog = [];
  const mock = createMockServer({ log: (l) => { mockLog.push(l); if (opts.verbose) console.log(l); } });
  const base = await mock.start();
  console.log(`Real-CLI canary ${new Date(startedAt).toISOString()}  mock ${base}  cache ${CACHE}`);

  const results = [];
  for (const tool of selected) {
    process.stdout.write(`- ${tool.name}${tool.stretch ? ' (stretch)' : ''} ... `);
    const r = await runTool(tool, { mock, base, runDir, nonce, opts });
    console.log(`${r.version || '?'} ${r.status}`);
    results.push(r);
  }
  await mock.stop();

  printTable(results);
  const touched = results.some((r) => r.touchedRealClaude);
  if (opts.updateFixtures && !touched) {
    try {
      updateFixtures(results);
    } catch (err) {
      console.error(`\nFixture update stopped: ${err.message}`);
    }
  }

  const report = {
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    node: process.version,
    mockUsage: USAGE,
    results: results.map(({ ctx, ...r }) => r),
    mockLog: mockLog.map((l) => scrub(l, runDir)),
    kept: opts.keep ? runDir : null,
  };
  const reportPath = path.join(REPORTS_DIR, `canary-${stamp(startedAt)}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(REPORTS_DIR, 'last-report.json'), JSON.stringify(report, null, 2));
  console.log(`\nReport: ${reportPath}`);

  if (opts.keep) console.log(`Homes kept: ${runDir}`);
  else if (!rmrf(runDir)) console.log(`Could not delete ${runDir} (a tool may still hold a file); delete it by hand.`);

  if (touched) return 3;
  return results.every((r) => r.status === 'PASS') ? 0 : 1;
}

module.exports = { main, TOOLS, checkTotals, diffClaude, snapshotClaude };

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  }, (err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 2;
  });
}
