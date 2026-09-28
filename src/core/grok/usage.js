'use strict';
/**
 * Grok Build TOKEN usage and xAI's own reported cost, read from the
 * content-free per-session usage file the tool writes itself (ADR-003
 * Amendments 1, 3 and 6). Rung 1 only: no credential, no network, no price
 * table (grok/cost.js).
 *
 * WHERE THE FILES ARE (xai-org/grok-build main f0e3be11, 2026-09-23, crate 1.0.41)
 * --------------------------------------------------------------------------------
 *   <home>/sessions/<encoded-cwd>/<session-id>/usage.json
 * `<home>` is GROK_HOME when set and non-empty, else `~/.grok`. The file is
 * written by xai-grok-shell/src/session/usage_file.rs and REWRITTEN after
 * every turn, so it is parsed whole whenever its size or mtime changes.
 *
 * Only `usage.json` is opened. The session's `chat_history.jsonl`,
 * `updates.jsonl`, `prompt_history.jsonl`, `plan.json` and `summary.json`
 * (conversation content) are never listed, opened or resolved, and the walk
 * never descends into `subagents/`: the parent's totals already include every
 * subagent's usage. `<encoded-cwd>` is a URL-encoded path or
 * `{slug}-{blake3hex16}`; it names a project directory, so it is never decoded
 * and never logged.
 *
 * WHAT IS COUNTED
 * ---------------
 *   {"sessionId","updatedAt":"<RFC3339>","session":{...totals,"primaryModelId",
 *    "modelUsage":{...}},"turns":[{"turnNumber","endedAt":"<RFC3339>",
 *    "inputTokens","outputTokens","cachedReadTokens","cacheCreationTokens",
 *    "reasoningTokens","totalTokens","modelCalls","costUsdTicks","costIsPartial",
 *    "usageIsIncomplete","modelUsage":{<model>:{...same fields}}}]}
 *  - The TURNS, each at its `endedAt`. The session totals are their sum and
 *    are never added again.
 *  - `inputTokens` is the WHOLE prompt, cache reads and cache writes included:
 *    the uncached input is `input - cachedRead - cacheCreation`, floored at 0.
 *    `reasoningTokens` is part of `outputTokens` and never added to it.
 *  - A turn is split by its own `modelUsage` when it has one (the per-model
 *    entries carry the turn's fields), else attributed to
 *    `session.primaryModelId`, else to 'unknown'.
 *  - `costUsdTicks` is the cost xAI's server reported, 1e10 ticks per USD. It
 *    is used as-is when > 0; a turn that reports none is unpriced (never $0).
 *    A turn marked `costIsPartial` or `usageIsIncomplete` keeps its amount and
 *    is flagged, so the figure says it is a floor; `usageIsIncomplete` makes
 *    the token COUNT a floor too.
 *
 * WHY TURNS ARE DEDUPED ACROSS SESSIONS
 * -------------------------------------
 * A forked session starts from a VERBATIM copy of its parent's usage.json, so
 * the parent's turns appear in both files. What links a fork to its parent is
 * in summary.json, which holds conversation text and is never opened. A copied
 * turn is instead recognised by its content: (endedAt, turnNumber,
 * inputTokens, outputTokens, costUsdTicks) is taken once across every file,
 * read in sorted path order. Two genuinely different turns agreeing on all
 * five, down to the millisecond instant and the exact tick count, would lose
 * one of them: an undercount, never a double count.
 *
 * VALIDATION
 * ----------
 * Every field that is read is checked (counts are non-negative safe integers,
 * instants parse, flags are booleans, ids are id-shaped). A file or turn that
 * is not that shape is not guessed at: it is skipped and its instants are
 * marked KNOWN unread (ADR-002 A3.15), so the figure reads as incomplete.
 *
 * PERFORMANCE AND PRIVACY
 * -----------------------
 * Long-lived worker, per-file cache by size + mtime; raw turns for RAW_DAYS and
 * UTC 15-minute buckets before (after the dedupe, which needs the raw turns).
 * Only the dedupe key, the instant, the model id, four counts, the reported
 * amount and two flags are kept; nothing read here is ever logged.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const log = require('../log');
const { resolveLocalDir, isRefusedDir, isNetworkPath } = require('../codex/rollout');
const { childDirs } = require('../scan/local-tree');
const { capModels } = require('../scan/model-cap');

const LABEL = 'grok sessions';
const DAY_MS = 24 * 60 * 60 * 1000;
const RAW_DAYS = 8;
const BUCKET_MS = 15 * 60 * 1000;
const USAGE_FILE = 'usage.json';
/** A usage file is parsed whole; past this it is reported unread, not loaded. */
const MAX_FILE_BYTES = 32 * 1024 * 1024;
/** Ticks per US dollar (usage_file.rs). */
const TICKS_PER_USD = 1e10;
/** Model ids per turn beyond this are not a shape the writer produces. */
const MAX_TURN_MODELS = 32;

/** A model id is shown verbatim in the UI, so it is held to an id's shape. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
/** Bounded, printable, never shown. */
const OPAQUE_ID = /^[\x21-\x7e]{1,128}$/;

let networkHomeWarned = false;

/**
 * `GROK_HOME` (when non-empty) or `~/.grok`, or null when that is a network
 * path. A RELATIVE `GROK_HOME` is null too: Grok resolves it against its own
 * working directory, which this app cannot know, and resolving it against the
 * app's would read some other tree (security review F3).
 */
function grokHome(home) {
  const env = process.env.GROK_HOME;
  const fromEnv = typeof env === 'string' && env.length > 0;
  if (!home && fromEnv && !path.isAbsolute(env)) return null;
  const dir = home || (fromEnv ? env : path.join(os.homedir(), '.grok'));
  if (isNetworkPath(dir)) {
    if (!networkHomeWarned) {
      networkHomeWarned = true;
      log.warn('grok home is a network or device path; Grok Build is treated as not found');
    }
    return null;
  }
  return dir;
}

/**
 * The file's text, read through ONE descriptor and never past MAX_FILE_BYTES:
 * the size checked on lstat is not the size at open, and a file grown in
 * between must not become an unbounded buffer (security review F2). A file
 * that turns out larger throws, and is treated as unread.
 */
function readBounded(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size > MAX_FILE_BYTES) throw Object.assign(new Error('too large'), { code: 'EFBIG' });
    const buf = Buffer.allocUnsafe(size);
    let off = 0;
    while (off < size) {
      const n = fs.readSync(fd, buf, off, size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.toString('utf8', 0, off);
  } finally {
    fs.closeSync(fd);
  }
}

/** A safe non-negative integer, or null. `optional` lets an ABSENT field read 0. */
function count(v, optional = false) {
  if (v === undefined && optional) return 0;
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** A boolean flag; absent reads false; anything else is not the writer's shape. */
function flag(v) {
  if (v === undefined) return false;
  return typeof v === 'boolean' ? v : null;
}

/** Reported ticks: a safe integer, absent/null read 0 (unreported); else null. */
function ticks(v) {
  if (v === undefined || v === null) return 0;
  return Number.isSafeInteger(v) ? v : null;
}

/** The counts and cost fields shared by a turn and a per-model entry, or null. */
function usageOf(u) {
  if (!u || typeof u !== 'object' || Array.isArray(u)) return null;
  const c = {
    input: count(u.inputTokens),
    output: count(u.outputTokens),
    cacheRead: count(u.cachedReadTokens, true),
    cacheWrite: count(u.cacheCreationTokens, true),
    reasoning: count(u.reasoningTokens, true),
    // The all-class sum the file also carries is never read: this app holds
    // no merged token figure (ADR-001).
    calls: count(u.modelCalls, true),
    ticks: ticks(u.costUsdTicks),
    costIsPartial: flag(u.costIsPartial),
    usageIsIncomplete: flag(u.usageIsIncomplete),
  };
  return Object.values(c).some((v) => v === null) ? null : c;
}

/** One event from a usage block (turn or per-model entry). */
function eventOf(ts, model, u, turnPartial, turnIncomplete) {
  const incomplete = turnIncomplete || u.usageIsIncomplete;
  return {
    ts,
    model,
    input: Math.max(0, u.input - u.cacheRead - u.cacheWrite),
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
    output: u.output,
    // Reported USD, or null when the server reported none (unpriced).
    usd: u.ticks > 0 ? u.ticks / TICKS_PER_USD : null,
    partial: turnPartial || u.costIsPartial || incomplete,
    incomplete,
  };
}

/**
 * One turn as `{ key, ts, events }`, or null when it is not the writer's shape.
 */
function turnOf(t, primaryModel) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  const n = count(t.turnNumber);
  if (n === null || typeof t.endedAt !== 'string' || t.endedAt.length > 40) return null;
  const ts = Date.parse(t.endedAt);
  if (!Number.isFinite(ts)) return null;
  const u = usageOf(t);
  if (u === null) return null;
  const key = `${t.endedAt}|${n}|${u.input}|${u.output}|${u.ticks}`;
  const events = [];
  let reported = 0;
  const mu = t.modelUsage;
  if (mu !== undefined && mu !== null) {
    if (typeof mu !== 'object' || Array.isArray(mu)) return null;
    const ids = Object.keys(mu);
    if (ids.length > MAX_TURN_MODELS) return null;
    for (const id of ids) {
      const m = usageOf(mu[id]);
      if (m === null) return null;
      events.push(eventOf(ts, MODEL_ID.test(id) ? id : 'unknown', m, u.costIsPartial, u.usageIsIncomplete));
      reported += m.ticks > 0 ? m.ticks : 0;
    }
  }
  if (events.length === 0) {
    events.push(eventOf(ts, primaryModel, u, false, false));
  } else if (u.ticks > reported) {
    // The per-model entries do not carry all of the amount xAI reported for
    // the turn (review F1): the rest is kept, on the primary model's entry
    // (else the first), rather than dropped. The TOTAL is then exact; only
    // which model it sits under is the primary's best guess.
    const extra = (u.ticks - reported) / TICKS_PER_USD;
    const target = events.find((e) => e.model === primaryModel) || events[0];
    target.usd = (target.usd || 0) + extra;
  } else if (u.ticks > 0 && reported > u.ticks) {
    // More split out than the turn reported: the two disagree, so no figure
    // from this turn is stated as exact.
    for (const e of events) e.partial = true;
  }
  return { key, ts, events };
}

function freshEntry() {
  return {
    size: 0,
    mtimeMs: 0,
    birthMs: NaN,
    minTs: null,
    maxTs: null,
    droppedFromMs: null,
    droppedThroughMs: null,
    droppedUntimed: false,
    turns: [],
  };
}

function noteTs(entry, ts) {
  if (entry.minTs === null || ts < entry.minTs) entry.minTs = ts;
  if (entry.maxTs === null || ts > entry.maxTs) entry.maxTs = ts;
}

function noteDropped(entry, ts) {
  if (!Number.isFinite(ts)) {
    entry.droppedUntimed = true;
    return;
  }
  noteTs(entry, ts);
  if (entry.droppedFromMs === null || ts < entry.droppedFromMs) entry.droppedFromMs = ts;
  if (entry.droppedThroughMs === null || ts > entry.droppedThroughMs) entry.droppedThroughMs = ts;
}

/** Parse one usage file's text into `entry`. False when the file is not the writer's shape. */
function parseInto(entry, text, startMs) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return false;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false;
  if (typeof doc.sessionId !== 'string' || !OPAQUE_ID.test(doc.sessionId)) return false;
  if (!Array.isArray(doc.turns)) return false;
  let primary = 'unknown';
  if (doc.session !== undefined && doc.session !== null) {
    if (typeof doc.session !== 'object' || Array.isArray(doc.session)) return false;
    const p = doc.session.primaryModelId;
    if (p !== undefined && p !== null && typeof p !== 'string') return false;
    if (typeof p === 'string' && MODEL_ID.test(p)) primary = p;
  }
  for (const raw of doc.turns) {
    const turn = turnOf(raw, primary);
    if (turn === null) {
      const at = raw && typeof raw === 'object' && typeof raw.endedAt === 'string' ? Date.parse(raw.endedAt) : NaN;
      noteDropped(entry, at);
      continue;
    }
    noteTs(entry, turn.ts);
    if (turn.ts < startMs) continue;
    if (turn.events.every((ev) => ev.input === 0 && ev.output === 0 && ev.cacheRead === 0 && ev.cacheWrite === 0 && ev.usd === null)) continue;
    entry.turns.push(turn);
  }
  return true;
}

function foldInto(buckets, ev) {
  const slot = Math.floor(ev.ts / BUCKET_MS) * BUCKET_MS;
  const priced = ev.usd !== null;
  const key = `${slot}|${ev.model}|${priced ? 1 : 0}${ev.partial ? 1 : 0}${ev.incomplete ? 1 : 0}`;
  let b = buckets.get(key);
  if (!b) {
    b = {
      ts: slot,
      model: ev.model,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      usd: priced ? 0 : null,
      partial: ev.partial,
      incomplete: ev.incomplete,
      count: 0,
    };
    buckets.set(key, b);
  }
  b.input += ev.input;
  b.cacheRead += ev.cacheRead;
  b.cacheWrite += ev.cacheWrite;
  b.output += ev.output;
  if (priced) b.usd += ev.usd;
  b.count += Number.isSafeInteger(ev.count) && ev.count > 0 ? ev.count : 1;
}

function createGrokUsageScanner() {
  const cache = new Map();
  const unread = new Map();
  let lastStats = null;
  let lastUnread = null;

  function rangeOf(entry, st, now, grew) {
    const starts = [];
    if (entry && Number.isFinite(entry.minTs)) starts.push(entry.minTs);
    if (st && Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0) starts.push(st.birthtimeMs);
    const fromMs = starts.length ? Math.min(...starts, now) : 0;
    let throughMs = st && Number.isFinite(st.mtimeMs) ? st.mtimeMs : now;
    if (entry && Number.isFinite(entry.maxTs)) throughMs = Math.max(throughMs, entry.maxTs);
    if (grew) throughMs = now;
    return { fromMs, throughMs: Math.min(throughMs, now) };
  }

  /** Every `<encoded-cwd>/<session-id>/usage.json` path, sorted. */
  function walk(sessionsDir, now) {
    const root = resolveLocalDir(sessionsDir, LABEL);
    if (!root) {
      if (isRefusedDir(sessionsDir)) unread.set(sessionsDir, { fromMs: 0, throughMs: now });
      return [];
    }
    const markUnread = (key) => () => unread.set(key, { fromMs: 0, throughMs: now });
    const files = [];
    for (const cwd of childDirs(root, root, markUnread(root))) {
      for (const session of childDirs(cwd.dir, root, markUnread(cwd.dir))) {
        files.push(path.join(session.dir, USAGE_FILE));
      }
    }
    return files.sort();
  }

  /**
   * Every counted Grok Build turn with `startMs <= ts < now`, deduped across
   * sessions: raw events since `rawSinceMs`, UTC 15-minute buckets (with
   * `count`) before.
   *
   * @param {{now?:number, startMs?:number, home?:string, rawSinceMs?:number}} [options]
   *   `home` overrides the Grok home directory (tests).
   */
  function scan(options = {}) {
    const began = Date.now();
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const startMs = Number.isFinite(options.startMs) ? options.startMs : now - 7 * DAY_MS;
    const rawSinceMs = Number.isFinite(options.rawSinceMs) ? options.rawSinceMs : now - RAW_DAYS * DAY_MS;
    const stats = { files: 0, parsed: 0, bytesRead: 0, ms: 0, sessions: 0 };

    unread.clear();
    const home = grokHome(options.home);
    const found = home ? walk(path.join(home, 'sessions'), now) : [];
    stats.sessions = found.length;
    const seen = new Set();

    for (const file of found) {
      const prior = cache.get(file);
      let st;
      try {
        st = fs.lstatSync(file);
      } catch (err) {
        // A session dir with no usage.json yet is normal (it is written after
        // the first turn); only a failure other than "not there" is a gap.
        if (!(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'))) unread.set(file, rangeOf(prior, null, now, false));
        continue;
      }
      if (!st.isFile() || st.isSymbolicLink()) continue;
      seen.add(file);
      stats.files += 1;
      // A changed start (a longer history asked for) re-reads, like a changed file.
      if (prior && prior.size === st.size && prior.mtimeMs === st.mtimeMs && prior.startMs <= startMs) continue;
      if (st.size > MAX_FILE_BYTES) {
        unread.set(file, rangeOf(prior, st, now, false));
        cache.delete(file);
        continue;
      }
      let text;
      try {
        text = readBounded(file);
      } catch {
        unread.set(file, rangeOf(prior, st, now, Boolean(prior) && prior.size !== st.size));
        cache.delete(file);
        continue;
      }
      stats.bytesRead += st.size;
      stats.parsed += 1;
      const entry = freshEntry();
      entry.size = st.size;
      entry.mtimeMs = st.mtimeMs;
      entry.birthMs = st.birthtimeMs;
      entry.startMs = startMs;
      if (!parseInto(entry, text, startMs)) {
        // Not the writer's shape, or caught mid-rewrite: known unread. The
        // last good read stays cached, so the turns it already counted do not
        // drop out for a scan (review F5); its size and mtime no longer match
        // the file, so the next scan reads it again.
        unread.set(file, rangeOf(prior, st, now, false));
        continue;
      }
      cache.set(file, entry);
    }
    for (const file of cache.keys()) if (!seen.has(file)) cache.delete(file);

    let hull = null;
    const reach = (r) => {
      if (!r || !Number.isFinite(r.fromMs) || !Number.isFinite(r.throughMs)) return;
      if (hull === null) hull = { fromMs: r.fromMs, throughMs: r.throughMs };
      else {
        hull.fromMs = Math.min(hull.fromMs, r.fromMs);
        hull.throughMs = Math.max(hull.throughMs, r.throughMs);
      }
    };
    for (const r of unread.values()) reach(r);

    // The fork dedupe, in sorted path order (see the header).
    const taken = new Set();
    const out = [];
    const buckets = new Map();
    let duplicates = 0;
    for (const file of found) {
      const entry = cache.get(file);
      if (!entry) continue;
      if (entry.droppedFromMs !== null) reach({ fromMs: entry.droppedFromMs, throughMs: entry.droppedThroughMs });
      if (entry.droppedUntimed) reach(rangeOf(entry, { birthtimeMs: entry.birthMs, mtimeMs: entry.mtimeMs }, now, false));
      for (const turn of entry.turns) {
        if (turn.ts < startMs || turn.ts >= now) continue;
        if (taken.has(turn.key)) {
          duplicates += 1;
          continue;
        }
        taken.add(turn.key);
        for (const ev of turn.events) {
          if (ev.ts < rawSinceMs) foldInto(buckets, ev);
          else out.push(ev);
        }
      }
    }
    for (const b of buckets.values()) out.push(b);
    out.sort((a, b) => a.ts - b.ts);
    const capped = capModels(out);
    if (capped.overflow) reach(capped.overflow);

    stats.ms = Date.now() - began;
    stats.cachedFiles = cache.size;
    stats.duplicateTurns = duplicates;
    stats.rawEvents = out.length - buckets.size;
    stats.buckets = buckets.size;
    stats.modelsCapped = capped.overflow !== null;
    lastStats = stats;
    lastUnread = hull === null ? null : { fromMs: Math.min(hull.fromMs, now), throughMs: Math.min(hull.throughMs, now) };
    return capped.events;
  }

  return {
    scan,
    /** Counts and timings of the last scan. Numbers only: safe to log. */
    stats: () => lastStats,
    /** `{ fromMs, throughMs }` hull of usage known unread by the last scan, or null. */
    unreadRange: () => (lastUnread ? { ...lastUnread } : null),
  };
}

/** One-shot scan with no cache carried between calls. */
function grokUsageEvents(options = {}) {
  return createGrokUsageScanner().scan(options);
}

/** Sum a window into the row's TokenBreakdown (`billable` = input + output + cacheWrite). */
function sumGrokTokens(events, startMs, endMs) {
  const t = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, billable: 0 };
  const perModel = new Map();
  for (const ev of events || []) {
    if (!ev || ev.ts < startMs || ev.ts >= endMs) continue;
    t.input += ev.input;
    t.output += ev.output;
    t.cacheWrite += ev.cacheWrite;
    t.cacheRead += ev.cacheRead;
    perModel.set(ev.model, (perModel.get(ev.model) || 0) + ev.input + ev.output + ev.cacheWrite);
  }
  t.billable = t.input + t.output + t.cacheWrite;
  const byModel = Array.from(perModel, ([model, billable]) => ({ model, billable }))
    .sort((a, b) => b.billable - a.billable || (a.model < b.model ? -1 : 1));
  return { tokens: t, byModel };
}

/**
 * Did xAI mark any turn in [startMs, endMs) as having incomplete usage? The
 * token-side fact `history.tokenFloorCauses` takes as `partialUsage`.
 */
function grokUsageIncomplete(events, startMs, endMs) {
  for (const ev of events || []) {
    if (ev && ev.ts >= startMs && ev.ts < endMs && ev.incomplete === true) return true;
  }
  return false;
}

function _resetForTests() {
  networkHomeWarned = false;
}

module.exports = {
  createGrokUsageScanner,
  grokUsageEvents,
  sumGrokTokens,
  grokUsageIncomplete,
  grokHome,
  RAW_DAYS,
  BUCKET_MS,
  TICKS_PER_USD,
  _resetForTests,
};
