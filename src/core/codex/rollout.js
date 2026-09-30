'use strict';
/**
 * Reads Codex's server-computed rate limits from its session rollout logs.
 *
 * WHY THIS SOURCE, AND WHY IT IS HONEST
 * -------------------------------------
 * Codex (the CLI and the Desktop app, which share one engine) writes a
 * per-session JSONL "rollout" under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
 * On the turns where OpenAI's backend returns rate-limit headers, Codex records
 * an `event_msg` whose `payload.type === "token_count"` carries a `rate_limits`
 * object copied VERBATIM from those headers:
 *
 *   rate_limits: {
 *     primary:   { used_percent, window_minutes: 300,   resets_at },   // 5 hours
 *     secondary: { used_percent, window_minutes: 10080, resets_at },   // 7 days
 *     plan_type: "plus", ...
 *   }
 *
 * `used_percent` is computed by the server (the `x-codex-*-used-percent`
 * headers), so relaying it invents no denominator — the same rule the Claude
 * reader lives by. We only PULL it: Codex has no statusline/notify hook that
 * carries usage, so there is nothing to install; the rollout file is written
 * automatically as the user works.
 *
 * WHAT WE DO NOT TOUCH
 * --------------------
 * `~/.codex/auth.json` holds the OAuth tokens. This reader never opens it and
 * never calls the network. The only alternative sources of a live figure are
 * an authenticated backend call or `codex exec`, both of which need those
 * tokens; neither is used, and neither is needed.
 *
 * FRESHNESS
 * ---------
 * The figure is a "last-seen snapshot": true only as of the turn that produced
 * it, and stale once the user stops running Codex — exactly Claude's model. A
 * capture older than `MAX_AGE_MS` reports `stale`; the caller dims it.
 *
 * SCHEMA VARIANCE (parsed defensively)
 * ------------------------------------
 *  - The reset instant arrives as `resets_at` (absolute unix SECONDS) in the
 *    current app-server rollout, or as `resets_in_seconds` (a countdown) in the
 *    older `codex exec` JSONL. Either is accepted.
 *  - `window_minutes` has shipped as 300/10080 and as 299/10079. Windows are
 *    classified by BAND, not equality, so the off-by-one does not drop a window.
 *  - A model/tier with no server figure (API-key sessions) simply carries no
 *    `rate_limits`; that reads as `absent`, never as an invented zero.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const log = require('../log');

/** A capture older than this is `stale`. Same budget as the Claude reader. */
const MAX_AGE_MS = 30 * 60 * 1000;

/**
 * A reset instant is only credible within roughly one window's length of now.
 * Past that, `windowFrom` in the snapshot could keep a dead percentage alive
 * forever, so an out-of-range instant is dropped to null (the figure stays, the
 * countdown does not). Mirrors `RESET_SKEW_MS` in ratelimits.js.
 */
const RESET_SKEW_MS = {
  fiveHour: 6 * 60 * 60 * 1000,
  sevenDay: 8 * 24 * 60 * 60 * 1000,
};

/** Plausibility fence for an absolute unix-second reset. */
const RESET_MIN_MS = Date.parse('2020-01-01T00:00:00Z');
const RESET_MAX_MS = Date.parse('2100-01-01T00:00:00Z');

/**
 * A UNC (`\\server\share`), device (`\\?\`, `\\.\`) or `//host` path. Reading
 * one is a network round-trip (SMB) or a raw-device path, and this app makes
 * zero outbound connections (ADR-001, security F11). So such a Codex home is
 * treated as "Codex not found".
 */
function isNetworkPath(p) {
  return typeof p === 'string' && /^[\\/]{2}/.test(p);
}

let networkHomeWarned = false;
function warnNetworkHome() {
  if (networkHomeWarned) return;
  networkHomeWarned = true;
  // A fixed message: the path itself is never logged.
  log.warn('codex home is a network or device path; Codex is treated as not found');
}

/** `CODEX_HOME` or `~/.codex`, or null when that is a network/device path. */
function codexHome() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  if (isNetworkPath(home)) {
    warnNetworkHome();
    return null;
  }
  return home;
}

/** The sessions root, or null when there is no usable (local) Codex home. */
function codexSessionsDir(home) {
  const base = home || codexHome();
  if (!base) return null;
  if (isNetworkPath(base)) {
    warnNetworkHome();
    return null;
  }
  return path.join(base, 'sessions');
}

/**
 * The absolute LOCAL path forms the guard accepts (ADR-003 A6 review rulings,
 * security F3: an allowlist, not a denylist). On Windows: a drive letter
 * (`C:\`), the long form of one (`\\?\C:\`) and a volume GUID path
 * (`\\?\Volume{…}\`). Everything else is refused before any lstat: UNC
 * (`\\server\share`, `\\?\UNC\…`, `//host`), device paths (`\\.\pipe\…`),
 * `\\?\GLOBALROOT\…`, and relative paths. Elsewhere (tests on POSIX): an
 * absolute path that does not start with `//`.
 */
const LOCAL_FORMS = [
  /^[A-Za-z]:[\\/]/,
  /^[\\/]{2}\?[\\/][A-Za-z]:[\\/]/,
  /^[\\/]{2}\?[\\/]Volume\{[0-9A-Fa-f-]+\}[\\/]/,
];

function isLocalAbsolute(p) {
  if (typeof p !== 'string') return false;
  if (process.platform === 'win32') return LOCAL_FORMS.some((re) => re.test(p));
  return p.startsWith('/') && !p.startsWith('//');
}

/**
 * Is a RESOLVED path outside the local allowlist? The name is historical: true
 * for a network path, and equally for a device, GLOBALROOT or relative path.
 */
function isNetworkResolved(p) {
  return !isLocalAbsolute(p);
}

/** The fixed refusal code for a path outside the allowlist. */
function refusalCode(p) {
  return typeof p === 'string' && /^[\\/]{2}/.test(p) ? 'NETWORK_TARGET' : 'NOT_LOCAL_PATH';
}

/** Labels whose network refusal has been logged (once per process each). */
const refusedDirWarned = new Set();

/**
 * Paths refused (network) or whose resolution FAILED for a reason other than
 * "not there yet", remembered for the life of the process (ADR-003 A3.3): a
 * stalled share must not be retried on the main thread on every rebuild.
 * ENOENT/ENOTDIR are not remembered — a day folder that does not exist yet
 * will exist tomorrow.
 * @type {Map<string, string>} path -> fixed reason code
 */
const refusedPaths = new Map();

/**
 * `label` names the tree in the fixed log line ('codex sessions', 'qwen usage',
 * 'kimi sessions'). It is a code-chosen constant, never a path.
 */
function refuse(key, code, label = 'codex sessions') {
  refusedPaths.set(key, code);
  if (code === 'NETWORK_TARGET' && !refusedDirWarned.has(label)) {
    refusedDirWarned.add(label);
    log.warn(`${label} directory refused: code=NETWORK_TARGET`);
  }
  return null;
}

const MAX_LINK_DEPTH = 16;
/** Links followed in total by one `resolveLocalDir` (security F5): a tree of
 *  links that fans out cannot make one resolution do unbounded lstat work. */
const MAX_LINK_HOPS = 64;

/**
 * Walk every component of an absolute path with lstat — which never follows
 * the component itself — and, for each symbolic link or junction, read its
 * target with readlink (also not followed). A target on the network refuses
 * the whole path BEFORE anything opens, resolves or watches it (ADR-003 A3.1).
 * A local target is itself pre-checked (a local link can point at another
 * local link that points at a share), up to MAX_LINK_DEPTH.
 *
 * Returns null when the path is safe to resolve, else a fixed reason code.
 *
 * ACCEPTED RESIDUAL (ADR-003 A3.4): a MAPPED network drive letter (Z: -> a
 * share) looks exactly like a local drive to pure Node before it is opened.
 * If the user keeps their Codex home on one, the first lstat contacts the
 * share. That is the user's own configuration of their own tool, not a
 * connection this app initiates, and it is deliberately not detected.
 */
function precheck(abs, depth = 0, budget = { hops: MAX_LINK_HOPS }) {
  if (!isLocalAbsolute(abs)) return refusalCode(abs);
  if (depth > MAX_LINK_DEPTH) return 'LINK_DEPTH';
  const parsed = path.parse(abs);
  const parts = abs.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);
  let cur = parsed.root;
  for (const part of parts) {
    cur = path.join(cur, part);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch (err) {
      return (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) ? 'ENOENT' : 'LSTAT_FAILED';
    }
    if (!st.isSymbolicLink()) continue;
    budget.hops -= 1;
    if (budget.hops < 0) return 'LINK_DEPTH';
    let target;
    try {
      target = fs.readlinkSync(cur);
    } catch {
      return 'READLINK_FAILED';
    }
    // A `\\` target is judged as written (never resolved); a relative one is
    // made absolute and judged by the allowlist in the recursive call.
    if (/^[\\/]{2}/.test(target) && !isLocalAbsolute(target)) return refusalCode(target);
    const targetAbs = path.isAbsolute(target) ? target : path.resolve(path.dirname(cur), target);
    const inner = precheck(targetAbs, depth + 1, budget);
    if (inner) return inner;
  }
  return null;
}

/**
 * A directory under the Codex sessions tree, RESOLVED through links and
 * junctions, or null (review F7, ADR-003 Amendment 3).
 *
 *  1. The path string and every link target along it are checked WITHOUT
 *     following (`precheck`); a network target is refused before any open,
 *     realpath or watch.
 *  2. Only then is it resolved, and the resolved path is checked again.
 *  3. Refusals and non-ENOENT failures are remembered for the process.
 *
 * Users junction `~/.codex/sessions` to another local drive, so local links
 * are followed. Refusals log one fixed code, never the path. Rollout FILES are
 * separately required to be regular files by lstat.
 *
 * The same guard serves every local reader (Kimi sessions, Qwen usage logs, Grok sessions);
 * `label` only changes which tree the fixed refusal line names.
 */
function resolveLocalDir(p, label = 'codex sessions') {
  if (typeof p !== 'string' || p.length === 0) return null;
  if (/^[\\/]{2}/.test(p) && !isLocalAbsolute(p)) return refuse(p, refusalCode(p), label);
  const abs = path.resolve(p);
  if (refusedPaths.has(abs)) return null;
  // Allowlist before any lstat (security F3).
  if (!isLocalAbsolute(abs)) return refuse(abs, refusalCode(abs), label);
  const pre = precheck(abs);
  if (pre === 'ENOENT') return null;
  if (pre) return refuse(abs, pre, label);
  let real;
  try {
    real = fs.realpathSync.native(abs);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    return refuse(abs, 'REALPATH_FAILED', label);
  }
  if (!isLocalAbsolute(real)) return refuse(abs, refusalCode(real), label);
  try {
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Was `p` refused by `resolveLocalDir` (a network target, or a resolution that
 * failed for a reason other than "not there")? Lets a caller that got `null`
 * tell "this directory exists and was not read" (ADR-002 A3.15) from "there is
 * no such directory". Reads the remembered set only; touches no filesystem.
 */
function isRefusedDir(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  return refusedPaths.has(p) || refusedPaths.has(path.resolve(p));
}

/** Test seam: forget remembered refusals and the once-per-process log flag. */
function _resetPathGuardForTests() {
  refusedPaths.clear();
  refusedDirWarned.clear();
}

/** Names in `dir` that are all digits of length `len`, or [] (readdir only). */
function digitNames(dir, len) {
  try {
    return fs.readdirSync(dir).filter((n) => n.length === len && /^\d+$/.test(n));
  } catch {
    return [];
  }
}

/**
 * `primary` is the five-hour window and `secondary` the weekly one, but we
 * confirm it from `window_minutes` rather than trusting the key name: ~300
 * minutes is the five-hour window, ~10080 (7 days) the weekly. Anything else is
 * a window we do not model and is ignored, never mislabelled.
 */
function classifyWindow(minutes) {
  if (!Number.isFinite(minutes)) return null;
  if (minutes >= 250 && minutes <= 360) return 'fiveHour';
  if (minutes >= 9000 && minutes <= 11000) return 'sevenDay';
  return null;
}

/**
 * Every `YYYY/MM/DD` day-folder under `sessions/`, keyed by its date string so
 * they sort chronologically ACROSS month and year boundaries. Only directory
 * NAMES are listed here (cheap); the day-folders themselves are not opened
 * until the caller has narrowed to the newest few.
 */
function newestDayDirs(sessionsDir, wanted) {
  const root = sessionsDir ? resolveLocalDir(sessionsDir) : null;
  if (!root) return [];
  // Names only (review F8): this runs on the main thread on every rebuild, and
  // only the newest folders are used, so only those — and their parents — are
  // resolved and checked.
  const out = [];
  const years = digitNames(root, 4).sort().reverse();
  for (const y of years) {
    const yDir = resolveLocalDir(path.join(root, y));
    if (!yDir) continue;
    for (const m of digitNames(yDir, 2).sort().reverse()) {
      const mDir = resolveLocalDir(path.join(yDir, m));
      if (!mDir) continue;
      for (const d of digitNames(mDir, 2).sort().reverse()) {
        const dDir = resolveLocalDir(path.join(mDir, d));
        if (!dDir) continue;
        out.push({ dir: dDir, key: `${y}/${m}/${d}` });
        if (out.length >= wanted) return out;
      }
    }
  }
  return out;
}

/** The rollout files of one day-folder, as full paths. */
function rolloutsIn(dir) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return files.filter((f) => /^rollout-.*\.jsonl$/.test(f)).map((f) => path.join(dir, f));
}

/** A regular (non-link) file's mtime, or null. */
function mtimeOf(full) {
  try {
    const stat = fs.lstatSync(full);
    return stat.isFile() && !stat.isSymbolicLink() ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}

/**
 * How often every day-folder is re-listed, and how much of it is kept.
 *
 * A Codex session writes to the rollout in the folder of the day it STARTED,
 * for as long as it runs or whenever it is resumed. Owner, 2026-09-30: a
 * session opened on 09-23 was still taking turns a week later, and a reader
 * that looked only at the two newest day-folders (09-26, 09-24) showed that
 * week-old 09-26 session instead — its windows long rolled over, so the row
 * had no figure at all while Codex was writing 2% / 21% every turn.
 *
 * So every folder counts, but walking all of them on the main thread every
 * rebuild would not scale with months of history. The full walk runs at most
 * once a minute and keeps the few most recently written files ("hot"); each
 * read then stats only those plus the two newest folders, where a brand-new
 * session always lands. A resumed old session is picked up within a minute.
 */
const HOT_LIST_TTL_MS = 60 * 1000;
const HOT_FILES = 3;
const MAX_LISTED_DAYS = 800;
const hotCache = new Map();

function hotRollouts(sessionsDir, now) {
  const key = String(sessionsDir);
  const cached = hotCache.get(key);
  if (cached && now >= cached.atMs && now - cached.atMs < HOT_LIST_TTL_MS) return cached.files;
  const ranked = [];
  for (const { dir } of newestDayDirs(sessionsDir, MAX_LISTED_DAYS)) {
    for (const full of rolloutsIn(dir)) {
      const ms = mtimeOf(full);
      if (ms !== null) ranked.push({ full, ms });
    }
  }
  ranked.sort((a, b) => b.ms - a.ms);
  const files = ranked.slice(0, HOT_FILES).map((r) => r.full);
  hotCache.set(key, { atMs: now, files });
  return files;
}

/**
 * The most recently WRITTEN `rollout-*.jsonl`, chosen by mtime — i.e. by which
 * session last took a turn — among the two newest day-folders (computed across
 * month/year boundaries) and the most recently written files of ALL folders
 * (see `hotRollouts`).
 */
function newestRollout(sessionsDir, now = Date.now()) {
  const candidates = new Set();
  for (const { dir } of newestDayDirs(sessionsDir, 2)) {
    for (const full of rolloutsIn(dir)) candidates.add(full);
  }
  for (const full of hotRollouts(sessionsDir, now)) candidates.add(full);
  let best = null;
  let bestMs = -1;
  for (const full of candidates) {
    const ms = mtimeOf(full);
    if (ms !== null && ms > bestMs) {
      bestMs = ms;
      best = { file: full, mtimeMs: ms };
    }
  }
  return best;
}

/** Test seam: forget the once-a-minute listing. */
function _resetRolloutCacheForTests() {
  hotCache.clear();
}

/** At most this much of a rollout is read: the last `rate_limits` sits at the
 *  tail, and a rollout is an append-only conversation log that can run to tens
 *  of MB — reading it whole on the main thread every rebuild would jank the UI. */
const TAIL_BYTES = 4 * 1024 * 1024;

/** The tail of a file as text, dropping a partial first line when the read
 *  started mid-file. Bounded to `TAIL_BYTES`; never loads a whole large log. */
function readTail(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = size > TAIL_BYTES ? size - TAIL_BYTES : 0;
    const len = size - start;
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const n = fs.readSync(fd, buf, read, len - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    let text = buf.toString('utf8', 0, read);
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * A used_percent to display, or null. Codex ships a float in [0, 100]; a value
 * a hair over 100 is server rounding at the cap and is clamped, while a clearly
 * impossible one (the producer is wrong) is refused rather than shown.
 */
function usedPercent(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  if (v > 100) return v <= 105 ? 100 : null;
  return v;
}

/**
 * Resolve a window's reset to an absolute ms instant, or null when it is
 * missing or not credible for a window of this length. Accepts either an
 * absolute `resets_at` (unix seconds) or a `resets_in_seconds` countdown.
 */
function resetMsOf(win, slot, now, capturedAtMs) {
  let ms = null;
  if (typeof win.resets_at === 'number' && Number.isFinite(win.resets_at)) {
    ms = win.resets_at * 1000;
    if (ms < RESET_MIN_MS || ms > RESET_MAX_MS) return null;
  } else if (typeof win.resets_in_seconds === 'number' && Number.isFinite(win.resets_in_seconds)) {
    // A countdown runs from the moment it was WRITTEN, not from when we read
    // it: adding it to the read time pushed a stale capture's reset (and the
    // week anchored to it) into the future by the capture's age.
    ms = capturedAtMs + win.resets_in_seconds * 1000;
  } else {
    return null;
  }
  return Math.abs(ms - now) <= RESET_SKEW_MS[slot] ? ms : null;
}

/** Does this `rate_limits` object carry at least one window to read? */
function hasWindow(rl) {
  return ['primary', 'secondary'].some((key) => rl[key] && typeof rl[key] === 'object');
}

/**
 * The plan's own limits, as opposed to a separate bucket such as `premium`.
 * Older Codex builds wrote no `limit_id` at all, and those were the plan's.
 */
function isPlanLimit(rl) {
  return rl.limit_id === undefined || rl.limit_id === null || rl.limit_id === 'codex';
}

/**
 * The newest `rate_limits` object in a rollout that can fill the row, with the
 * instant it was seen.
 *
 * NOT simply the last one. Codex also writes records for other buckets, e.g.
 * `{limit_id:"premium", primary:null, secondary:null}`, right after the plan's
 * own `limit_id:"codex"` record. Taking that empty record made the row say
 * "awaiting report" while the real 5-hour figure was 99%. So: the newest plan
 * record that has a window wins. If the tail holds none, the newest record of
 * any bucket that has a window does.
 */
function lastRateLimits(text) {
  let fallback = null;
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || line.indexOf('rate_limits') === -1) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = obj && obj.payload;
    if (
      payload
      && payload.type === 'token_count'
      && payload.rate_limits
      && typeof payload.rate_limits === 'object'
    ) {
      const rl = payload.rate_limits;
      if (!hasWindow(rl)) continue;
      const stampMs = Date.parse(obj.timestamp);
      const found = { rl, stampMs: Number.isFinite(stampMs) ? stampMs : null };
      if (isPlanLimit(rl)) return found;
      if (!fallback) fallback = found;
    }
  }
  return fallback;
}

/**
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {string} [options.home]     override `~/.codex` (tests, CODEX_HOME)
 * @param {string} [options.file]     read this rollout directly (tests)
 * @param {number} [options.maxAgeMs]
 * @returns {{state:'missing'|'invalid'|'absent'|'stale'|'fresh',
 *            capturedAt:string|null, capturedAtMs:number|null, ageMs:number|null,
 *            fiveHour:{usedPercentage:number,resetsAtMs:number|null}|null,
 *            sevenDay:{usedPercentage:number,resetsAtMs:number|null}|null,
 *            planType:string|null}}
 */
function readCodexRateLimits(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const maxAgeMs = options.maxAgeMs ?? MAX_AGE_MS;
  const empty = { capturedAt: null, capturedAtMs: null, ageMs: null, fiveHour: null, sevenDay: null, planType: null };

  let file = options.file || null;
  let mtimeMs = null;
  if (!file) {
    const found = newestRollout(codexSessionsDir(options.home), now);
    if (!found) return { state: 'missing', ...empty };
    file = found.file;
    mtimeMs = found.mtimeMs;
  }

  let text;
  try {
    text = readTail(file);
  } catch (err) {
    return { state: (err && err.code) === 'ENOENT' ? 'missing' : 'invalid', ...empty };
  }

  const found = lastRateLimits(text);
  if (!found) return { state: 'absent', ...empty };

  const { rl } = found;
  // The instant the figure was true: the record's own timestamp, else the
  // file's mtime. Never `now` — a figure with no age cannot be aged out.
  const capturedAtMs = found.stampMs
    ?? (Number.isFinite(mtimeMs) ? mtimeMs : (() => {
      try { return fs.statSync(file).mtimeMs; } catch { return null; }
    })());
  if (!Number.isFinite(capturedAtMs)) return { state: 'invalid', ...empty };

  let fiveHour = null;
  let sevenDay = null;
  for (const key of ['primary', 'secondary']) {
    const win = rl[key];
    if (!win || typeof win !== 'object') continue;
    const slot = classifyWindow(win.window_minutes);
    if (!slot) continue;
    const used = usedPercent(win.used_percent);
    if (used === null) continue;
    const w = { usedPercentage: used, resetsAtMs: resetMsOf(win, slot, now, capturedAtMs) };
    if (slot === 'fiveHour') fiveHour = w;
    else sevenDay = w;
  }

  if (fiveHour === null && sevenDay === null) return { state: 'absent', ...empty };

  const ageMs = now - capturedAtMs;
  const state = ageMs > maxAgeMs ? 'stale' : 'fresh';
  return {
    state,
    capturedAt: new Date(capturedAtMs).toISOString(),
    capturedAtMs,
    ageMs,
    fiveHour,
    sevenDay,
    planType: typeof rl.plan_type === 'string' ? rl.plan_type : null,
  };
}

module.exports = {
  readCodexRateLimits,
  codexHome,
  codexSessionsDir,
  isNetworkPath,
  isNetworkResolved,
  isLocalAbsolute,
  MAX_LINK_HOPS,
  resolveLocalDir,
  isRefusedDir,
  _resetPathGuardForTests,
  newestRollout,
  newestDayDirs,
  _resetRolloutCacheForTests,
  classifyWindow,
  MAX_AGE_MS,
};
