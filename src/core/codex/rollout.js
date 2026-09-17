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
 * Is a RESOLVED path on the network? UNC (`\\server\share`), the long UNC
 * form (`\\?\UNC\server`) and `//host`. A local long path (`\\?\C:\`) or a
 * volume GUID path (`\\?\Volume{…}`) is local and allowed.
 */
function isNetworkResolved(p) {
  if (typeof p !== 'string') return true;
  if (/^[\\/]{2}[?.][\\/]/.test(p)) return /^[\\/]{2}[?.][\\/]UNC[\\/]/i.test(p);
  return /^[\\/]{2}/.test(p);
}

let refusedDirWarned = false;

/**
 * Paths refused (network) or whose resolution FAILED for a reason other than
 * "not there yet", remembered for the life of the process (ADR-003 A3.3): a
 * stalled share must not be retried on the main thread on every rebuild.
 * ENOENT/ENOTDIR are not remembered — a day folder that does not exist yet
 * will exist tomorrow.
 * @type {Map<string, string>} path -> fixed reason code
 */
const refusedPaths = new Map();

function refuse(key, code) {
  refusedPaths.set(key, code);
  if (code === 'NETWORK_TARGET' && !refusedDirWarned) {
    refusedDirWarned = true;
    log.warn('codex sessions directory refused: code=NETWORK_TARGET');
  }
  return null;
}

const MAX_LINK_DEPTH = 16;

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
function precheck(abs, depth = 0) {
  if (isNetworkResolved(abs)) return 'NETWORK_TARGET';
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
    let target;
    try {
      target = fs.readlinkSync(cur);
    } catch {
      return 'READLINK_FAILED';
    }
    if (isNetworkResolved(target)) return 'NETWORK_TARGET';
    const targetAbs = path.isAbsolute(target) ? target : path.resolve(path.dirname(cur), target);
    const inner = precheck(targetAbs, depth + 1);
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
 */
function resolveLocalDir(p) {
  if (typeof p !== 'string' || p.length === 0) return null;
  if (isNetworkResolved(p)) return refuse(p, 'NETWORK_TARGET');
  const abs = path.resolve(p);
  if (refusedPaths.has(abs)) return null;
  const pre = precheck(abs);
  if (pre === 'ENOENT') return null;
  if (pre) return refuse(abs, pre);
  let real;
  try {
    real = fs.realpathSync.native(abs);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    return refuse(abs, 'REALPATH_FAILED');
  }
  if (isNetworkResolved(real)) return refuse(abs, 'NETWORK_TARGET');
  try {
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** Test seam: forget remembered refusals and the once-per-process log flag. */
function _resetPathGuardForTests() {
  refusedPaths.clear();
  refusedDirWarned = false;
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

/**
 * The most recently WRITTEN `rollout-*.jsonl`. The two newest DATES are the
 * candidates — computed across month/year boundaries, so a session opened at
 * 23:xx on a month's last day and still active is not stranded once a session
 * starts in the new month — and the winner among their files is chosen by
 * mtime, i.e. by which session last took a turn.
 */
function newestRollout(sessionsDir) {
  let best = null;
  let bestMs = -1;
  for (const { dir } of newestDayDirs(sessionsDir, 2)) {
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!/^rollout-.*\.jsonl$/.test(f)) continue;
      const full = path.join(dir, f);
      let stat;
      try {
        stat = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (stat.mtimeMs > bestMs) {
        bestMs = stat.mtimeMs;
        best = { file: full, mtimeMs: stat.mtimeMs };
      }
    }
  }
  return best;
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

/** The last `rate_limits` object in a rollout, with the instant it was seen. */
function lastRateLimits(text) {
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
      const stampMs = Date.parse(obj.timestamp);
      return { rl: payload.rate_limits, stampMs: Number.isFinite(stampMs) ? stampMs : null };
    }
  }
  return null;
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
    const found = newestRollout(codexSessionsDir(options.home));
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
  resolveLocalDir,
  _resetPathGuardForTests,
  newestRollout,
  newestDayDirs,
  classifyWindow,
  MAX_AGE_MS,
};
