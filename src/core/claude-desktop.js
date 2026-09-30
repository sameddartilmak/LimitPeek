'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { claudePlanFrom } = require('./plan-detect');

/**
 * What the Claude desktop app leaves on disk that this app may read.
 *
 * Owner, 2026-09-29: the panel only knew Claude usage through Claude Code, so
 * a user who works in the desktop app (chat or Cowork) saw a stale or missing
 * limit figure. Two things are read, and nothing else:
 *
 *   1. `plan-usage-history.json`: the desktop app polls the account's plan
 *      usage every 15 minutes while it runs and appends
 *      `{ t, org, u: { fh, sd } }` — epoch ms, organization id, and the
 *      five-hour and seven-day percentages the SERVER computed. Account-wide,
 *      so it includes claude.ai chat. No reset instant, no tokens, no text.
 *   2. Cowork sessions: each runs Claude Code with its own config directory
 *      under `local-agent-mode-sessions/<a>/<b>/local_<c>/.claude/projects`,
 *      in the same transcript format `scan/` already reads for usage.
 *
 * Never opened: the app's cookies, Local Storage, IndexedDB, `config.json`,
 * `*-tokens.json` or any other file here. Chat conversations live on the
 * server and are not on disk as usage, so they have no token figure to read.
 *
 * `~/.claude.json` is opened for ONE field, `oauthAccount.organizationUuid`:
 * a desktop reading for a different account than Claude Code's must not stand
 * in for it. Nothing else of that file is kept.
 */

/** The file is ~50 KB after a month; anything far larger is not this file. */
const MAX_HISTORY_BYTES = 4 * 1024 * 1024;
const MAX_CLAUDE_JSON_BYTES = 16 * 1024 * 1024;
/** A sample stamped in the future beyond clock skew is not believed. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;
/** Bounds on the Cowork layout walk: a handful of sessions is normal. */
const MAX_COWORK_ROOTS = 500;

/**
 * The desktop app's data directory: `%APPDATA%\Claude` for the classic
 * installer, `%LOCALAPPDATA%\Packages\Claude_<publisher>\LocalCache\Roaming\Claude`
 * for the Store (MSIX) package, whose Roaming writes are redirected there.
 * Only existing, real (non-link) directories are returned.
 */
function claudeDesktopDirs(env = process.env) {
  const out = [];
  const appData = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  out.push(path.join(appData, 'Claude'));
  const packages = path.join(localAppData, 'Packages');
  try {
    for (const e of fs.readdirSync(packages, { withFileTypes: true })) {
      if (e.isDirectory() && !e.isSymbolicLink() && /^Claude_[a-z0-9]+$/i.test(e.name)) {
        out.push(path.join(packages, e.name, 'LocalCache', 'Roaming', 'Claude'));
      }
    }
  } catch { /* no Packages directory */ }
  return out.filter(isRealDir);
}

function isRealDir(dir) {
  try {
    const st = fs.lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function subdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/**
 * Every Cowork session's transcript root, at the fixed depth the desktop app
 * writes them: `local-agent-mode-sessions/<a>/<b>/local_<c>/.claude/projects`.
 * The rest of each session (its outputs, uploads, audit log) is never listed.
 */
function coworkProjectRoots(dirs) {
  const roots = [];
  for (const dir of dirs || []) {
    for (const a of subdirs(path.join(dir, 'local-agent-mode-sessions'))) {
      for (const b of subdirs(a)) {
        for (const c of subdirs(b)) {
          if (!path.basename(c).startsWith('local_')) continue;
          const projects = path.join(c, '.claude', 'projects');
          if (isRealDir(path.join(c, '.claude')) && isRealDir(projects)) roots.push(projects);
          if (roots.length >= MAX_COWORK_ROOTS) return roots;
        }
      }
    }
  }
  return roots;
}

function percent(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
}

const historyCache = new Map();

function readHistory(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile() || st.size > MAX_HISTORY_BYTES) return null;
  const hit = historyCache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.samples;
  let samples = null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && Array.isArray(raw.samples)) samples = raw.samples;
  } catch { /* being rewritten, or not this format: no reading */ }
  historyCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, samples });
  return samples;
}

/**
 * The newest plan-usage sample across the desktop data directories.
 *
 * @param {object} opts
 * @param {string[]} opts.dirs       desktop data directories
 * @param {number}  opts.now
 * @param {string|null} [opts.org]   Claude Code's organization id; when known,
 *                                   samples for any other org are ignored
 * @returns {{ atMs:number, fiveHour:number|null, sevenDay:number|null }|null}
 */
function readDesktopPlanUsage(opts) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const org = typeof opts.org === 'string' && opts.org ? opts.org : null;
  let best = null;
  for (const dir of opts.dirs || []) {
    const samples = readHistory(path.join(dir, 'plan-usage-history.json'));
    if (!samples) continue;
    for (const s of samples) {
      if (!s || typeof s !== 'object' || !Number.isFinite(s.t) || !s.u || typeof s.u !== 'object') continue;
      if (s.t > now + FUTURE_SKEW_MS) continue;
      if (org && s.org !== org) continue;
      const fiveHour = percent(s.u.fh);
      const sevenDay = percent(s.u.sd);
      if (fiveHour === null && sevenDay === null) continue;
      if (!best || s.t > best.atMs) best = { atMs: s.t, fiveHour, sevenDay };
    }
  }
  return best;
}

let accountCache = null;

/**
 * Two fields of `~/.claude.json`'s `oauthAccount`, and nothing else: the
 * organization id (so a desktop reading for another account is not used) and
 * the plan Claude Code recorded for it (`plan-detect.js`). The file is parsed
 * and dropped; no other field is kept, and the token file is never opened.
 *
 * @returns {{ org: string|null, plan: string|null }}
 */
function claudeCodeAccount(file = path.join(os.homedir(), '.claude.json')) {
  const none = { org: null, plan: null };
  let st;
  try { st = fs.statSync(file); } catch { return none; }
  if (!st.isFile() || st.size > MAX_CLAUDE_JSON_BYTES) return none;
  if (accountCache && accountCache.file === file && accountCache.size === st.size && accountCache.mtimeMs === st.mtimeMs) {
    return accountCache.value;
  }
  let value;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const account = raw && raw.oauthAccount;
    const v = account && account.organizationUuid;
    value = {
      org: typeof v === 'string' && /^[0-9a-f-]{8,64}$/i.test(v) ? v : null,
      plan: claudePlanFrom(account),
    };
  } catch {
    // Caught mid-write: the last known answer still stands, and the next
    // change to the file is read again.
    return accountCache && accountCache.file === file ? accountCache.value : none;
  }
  accountCache = { file, size: st.size, mtimeMs: st.mtimeMs, value };
  return value;
}

/** Claude Code's organization id from `~/.claude.json`, or null. */
function claudeCodeOrg(file) {
  return claudeCodeAccount(file).org;
}

module.exports = {
  claudeDesktopDirs,
  coworkProjectRoots,
  readDesktopPlanUsage,
  claudeCodeOrg,
  claudeCodeAccount,
  MAX_HISTORY_BYTES,
};
