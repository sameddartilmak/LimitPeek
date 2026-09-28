'use strict';
/**
 * Qwen Code TOKEN usage, read from the content-free usage log the tool writes
 * itself (ADR-003 Amendments 1, 3 and 6). Rung 1 only: no credential, no
 * network. Priced by qwen/pricing.js.
 *
 * WHERE THE FILES ARE (qwen-code v0.24.6, packages/core/src/config/storage.ts,
 * services/tokenUsageService.ts)
 * ---------------------------------------------------------------------------
 *   <runtime>/usage/token-usage-<YYYY-MM>.jsonl
 * The GLOBAL directory is QWEN_HOME when set, else `~/.qwen`
 * (Storage.getGlobalQwenDir). The RUNTIME directory, which holds `usage/`, is
 * QWEN_RUNTIME_DIR when set, else the settings key
 * `advanced.runtimeOutputDir`, else the global directory
 * (Storage.getRuntimeBaseDir). Both environment values get Qwen's own `~`
 * expansion (Storage.resolvePath); a RELATIVE value is resolved by Qwen
 * against its own working directory, which this app cannot know, so it is
 * not guessed: a relative QWEN_HOME reads as "not found" and a relative
 * QWEN_RUNTIME_DIR as a known-unread log.
 *
 * KNOWN LIMITATION: `advanced.runtimeOutputDir` lives in Qwen's settings.json,
 * which can hold API keys, and is NEVER opened here. A user who moved the
 * runtime directory only through that setting reads as "no usage log yet".
 *
 * Only `usage/token-usage-YYYY-MM.jsonl` is read (first shipped in v0.18.4).
 * `projects/*\/chats/*.jsonl` (conversation content, and the same usage
 * again), `tmp/`, `usage_record.jsonl` and the settings files are never
 * listed, opened or resolved. `<month>` is the writer's LOCAL month, so only
 * the files whose month overlaps the history span (one month of slack on each
 * side for a writer in another time zone) are read at all.
 *
 * WHAT A RECORD LOOKS LIKE (schema v1, tokenUsageService.ts)
 * -----------------------------------------------------------
 * One JSON line per SUCCESSFUL API response:
 *   {"schemaVersion":1,"id":"<uuid>","timestamp":"<ISO>","localDate":"YYYY-MM-DD",
 *    "localMonth":"YYYY-MM","sessionId":"<uuid>","model":"qwen3-coder-plus",
 *    "authType":"openai","source":"main","inputTokens":48211,"outputTokens":812,
 *    "cachedTokens":40960,"thoughtsTokens":0,"totalTokens":49023,"apiDurationMs":6120}
 *  - `inputTokens` INCLUDES `cachedTokens`; the uncached prompt is the rest.
 *  - `thoughtsTokens` is PART of `outputTokens` and is never added to it.
 *  - Every line is its own response (`id` is a random uuid), so nothing is
 *    deduped; the chat files are never read beside it, which would double it.
 *  - Only `schemaVersion: 1` is understood. Any other version, or a field that
 *    is not what v1 writes, is not guessed at: the line is dropped and its
 *    instant marked KNOWN unread (ADR-002 A3.15), so the figure says it is
 *    incomplete instead of silently undercounting.
 *
 * THE FIGURE IS A FLOOR
 * ---------------------
 * Failed calls and retries are not written, internal side queries are left
 * out, and nothing is written while `privacy.usageStatisticsEnabled` is off
 * (loggers.ts). See qwen/pricing.js for how that reaches the figure.
 *
 * PERFORMANCE AND PRIVACY
 * -----------------------
 * Same design as the Kimi Code scanner: long-lived worker, per-file cache by
 * size + mtime, appended files read from their last complete line, raw
 * records for RAW_DAYS and UTC 15-minute buckets before. Only the model id,
 * the instant and four counts are kept (plus the request's tier class); the
 * session id, auth type and source are validated and dropped; nothing read
 * here is ever logged.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const log = require('../log');
const { resolveLocalDir, isRefusedDir, isNetworkPath } = require('../codex/rollout');
const { childFiles } = require('../scan/local-tree');
const { readAppended, settleTail, tailBytes, isAppendOf } = require('../scan/append-reader');
const { capModels } = require('../scan/model-cap');
const { tierClassOf } = require('./tiers');

const LABEL = 'qwen usage';
const DAY_MS = 24 * 60 * 60 * 1000;
const RAW_DAYS = 8;
const BUCKET_MS = 15 * 60 * 1000;

/** `token-usage-YYYY-MM.jsonl` and nothing else (tokenUsageService.ts). */
const USAGE_FILE = /^token-usage-(\d{4})-(\d{2})\.jsonl$/;
/** A model id is shown verbatim in the UI, so it is held to an id's shape. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
/** Bounded, printable, never shown: `id` and `sessionId` are uuids. */
const OPAQUE_ID = /^[\x21-\x7e]{1,128}$/;
const SHORT_TEXT = /^[\x20-\x7e]{0,64}$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_MONTH = /^\d{4}-\d{2}$/;
const HEAD_TIMESTAMP = /"timestamp"\s*:\s*"([^"]{1,40})"/;

let networkHomeWarned = false;
let relativeHomeWarned = false;

/**
 * An environment directory as Qwen resolves it (Storage.resolvePath), or null
 * when it is relative: Qwen resolves that against its own working directory.
 */
function envDir(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  let v = value;
  if (v === '~' || v.startsWith('~/') || v.startsWith('~\\')) {
    const segments = v === '~' ? [] : v.slice(2).split(/[/\\]+/).filter(Boolean);
    v = path.join(os.homedir(), ...segments);
  }
  return path.isAbsolute(v) ? v : null;
}

function refuseNetwork(dir) {
  if (!isNetworkPath(dir)) return false;
  if (!networkHomeWarned) {
    networkHomeWarned = true;
    log.warn('qwen home is a network or device path; Qwen Code is treated as not found');
  }
  return true;
}

/**
 * The global Qwen directory (QWEN_HOME or `~/.qwen`), or null when it is a
 * network path or a relative QWEN_HOME. Its presence means "installed".
 * `home` overrides it (tests).
 */
function qwenHome(home) {
  let dir = home;
  if (!dir) {
    const env = envDir(process.env.QWEN_HOME);
    if (env === null) {
      if (!relativeHomeWarned) {
        relativeHomeWarned = true;
        log.warn('QWEN_HOME is a relative path; Qwen Code is treated as not found');
      }
      return null;
    }
    dir = env || path.join(os.homedir(), '.qwen');
  }
  return refuseNetwork(dir) ? null : dir;
}

/**
 * The `usage` directory: `<QWEN_RUNTIME_DIR or the global dir>/usage`.
 * `{ dir: null, relative: true }` for a relative QWEN_RUNTIME_DIR. With a
 * `home` override the runtime directory IS that home, so a developer's own
 * QWEN_RUNTIME_DIR never reaches a test.
 */
function qwenUsageDir(home) {
  const global = qwenHome(home);
  if (!global) return { dir: null, relative: false };
  if (home) return { dir: path.join(home, 'usage'), relative: false };
  const runtime = envDir(process.env.QWEN_RUNTIME_DIR);
  if (runtime === null) return { dir: null, relative: true };
  const base = runtime || global;
  // A network QWEN_RUNTIME_DIR: the log exists, on a path this app will not
  // open. Known unread, never "no log yet" (review F3).
  if (refuseNetwork(base)) return { dir: null, relative: Boolean(runtime) };
  return { dir: path.join(base, 'usage'), relative: false };
}

/** A safe non-negative integer, or null. */
function count(v) {
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/**
 * The counted fields of one v1 record, or null when any field is not what v1
 * writes. Every field is checked, including the ones not kept: a line whose
 * shape has drifted is not trusted for the ones that are.
 */
function recordOf(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  if (rec.schemaVersion !== 1) return null;
  if (typeof rec.id !== 'string' || !OPAQUE_ID.test(rec.id)) return null;
  if (typeof rec.sessionId !== 'string' || !OPAQUE_ID.test(rec.sessionId)) return null;
  if (typeof rec.timestamp !== 'string' || rec.timestamp.length > 40) return null;
  const ts = Date.parse(rec.timestamp);
  if (!Number.isFinite(ts)) return null;
  if (typeof rec.localDate !== 'string' || !LOCAL_DATE.test(rec.localDate)) return null;
  if (typeof rec.localMonth !== 'string' || !LOCAL_MONTH.test(rec.localMonth)) return null;
  if (typeof rec.authType !== 'string' || !SHORT_TEXT.test(rec.authType)) return null;
  if (typeof rec.source !== 'string' || !SHORT_TEXT.test(rec.source)) return null;
  if (typeof rec.model !== 'string') return null;
  if (rec.apiDurationMs !== undefined && !(Number.isFinite(rec.apiDurationMs) && rec.apiDurationMs >= 0)) return null;
  const input = count(rec.inputTokens);
  const output = count(rec.outputTokens);
  const cached = count(rec.cachedTokens);
  const thoughts = count(rec.thoughtsTokens);
  // The record's own all-class sum is deliberately never read: this app holds
  // no merged token figure (ADR-001), and nothing here needs it.
  if (input === null || output === null || cached === null || thoughts === null) return null;
  // `inputTokens` includes the cached part, so more cached than input is not
  // a v1 record.
  if (cached > input) return null;
  return {
    ts,
    model: MODEL_ID.test(rec.model) ? rec.model : 'unknown',
    input: input - cached,
    cached,
    output,
    // The request's size class (qwen/tiers.js): Model Studio picks the rate by
    // the request's WHOLE input, cached part included.
    tier: tierClassOf(input),
  };
}

function freshEntry() {
  return {
    size: 0,
    mtimeMs: 0,
    birthMs: NaN,
    offset: 0,
    minTs: null,
    maxTs: null,
    droppedFromMs: null,
    droppedThroughMs: null,
    droppedUntimed: false,
    events: [],
    buckets: new Map(),
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

function timeOfBadLine(text) {
  const m = HEAD_TIMESTAMP.exec(text);
  return m ? Date.parse(m[1]) : NaN;
}

function consumeLine(entry, line, startMs) {
  if (line.length === 0) return;
  const text = line.toString('utf8');
  if (text.trim().length === 0) return;
  let rec;
  try {
    rec = JSON.parse(text);
  } catch {
    // Every line of this file is a usage record: an unreadable one is lost usage.
    noteDropped(entry, timeOfBadLine(text));
    return;
  }
  const r = recordOf(rec);
  if (r === null) {
    const ts = rec && typeof rec === 'object' && typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
    noteDropped(entry, ts);
    return;
  }
  noteTs(entry, r.ts);
  if (r.ts < startMs) return;
  if (r.input === 0 && r.cached === 0 && r.output === 0) return;
  entry.events.push(r);
}

function foldInto(buckets, ev) {
  const slot = Math.floor(ev.ts / BUCKET_MS) * BUCKET_MS;
  const key = `${slot}|${ev.model}|${ev.tier}`;
  let b = buckets.get(key);
  if (!b) {
    b = { ts: slot, model: ev.model, tier: ev.tier, input: 0, cached: 0, output: 0, count: 0 };
    buckets.set(key, b);
  }
  b.input += ev.input;
  b.cached += ev.cached;
  b.output += ev.output;
  b.count += Number.isSafeInteger(ev.count) && ev.count > 0 ? ev.count : 1;
}

function foldOld(entry, rawSinceMs) {
  if (!entry.events.some((ev) => ev.ts < rawSinceMs)) return;
  const keep = [];
  for (const ev of entry.events) {
    if (ev.ts < rawSinceMs) foldInto(entry.buckets, ev);
    else keep.push(ev);
  }
  entry.events = keep;
}

/** `YYYY * 12 + (MM - 1)` for a month key, so a range check is arithmetic. */
function monthIndex(year, month) {
  return year * 12 + (month - 1);
}

function localMonthIndex(ms) {
  const d = new Date(ms);
  return monthIndex(d.getFullYear(), d.getMonth() + 1);
}

function createQwenUsageScanner() {
  const cache = new Map();
  const unread = new Map();
  let lastStats = null;
  let lastUnread = null;
  let foldedTo = -Infinity;

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

  /**
   * Every counted Qwen Code response with `startMs <= ts < now`: raw records
   * since `rawSinceMs`, UTC 15-minute buckets (with `count`) before.
   *
   * @param {{now?:number, startMs?:number, home?:string, rawSinceMs?:number}} [options]
   *   `home` overrides the global Qwen directory, and with it the runtime one (tests).
   */
  function scan(options = {}) {
    const began = Date.now();
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const startMs = Number.isFinite(options.startMs) ? options.startMs : now - 7 * DAY_MS;
    const rawSinceMs = Number.isFinite(options.rawSinceMs) ? options.rawSinceMs : now - RAW_DAYS * DAY_MS;
    const stats = { files: 0, parsed: 0, appended: 0, bytesRead: 0, ms: 0, cacheReset: false, usageFiles: 0 };

    if (rawSinceMs < foldedTo) {
      cache.clear();
      stats.cacheReset = true;
    }
    foldedTo = rawSinceMs;
    unread.clear();

    const where = qwenUsageDir(options.home);
    const files = [];
    if (where.relative) {
      // The log exists somewhere this app cannot name or will not open: known
      // unread, all of it.
      unread.set('runtime', { fromMs: 0, throughMs: now });
    } else if (where.dir) {
      const root = resolveLocalDir(where.dir, LABEL);
      if (!root) {
        if (isRefusedDir(where.dir)) unread.set(where.dir, { fromMs: 0, throughMs: now });
      } else {
        const lo = localMonthIndex(startMs) - 1;
        const hi = localMonthIndex(now) + 1;
        const names = childFiles(root, () => unread.set(root, { fromMs: 0, throughMs: now }), (n) => USAGE_FILE.test(n));
        stats.usageFiles = names.length;
        for (const name of names) {
          const m = USAGE_FILE.exec(name);
          const idx = monthIndex(Number(m[1]), Number(m[2]));
          if (idx >= lo && idx <= hi) files.push(path.join(root, name));
        }
      }
    }
    const seen = new Set();

    for (const file of files) {
      seen.add(file);
      const prior = cache.get(file);
      let st;
      try {
        st = fs.lstatSync(file);
      } catch (err) {
        if (!(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'))) unread.set(file, rangeOf(prior, null, now, false));
        cache.delete(file);
        continue;
      }
      if (!st.isFile() || st.isSymbolicLink()) {
        cache.delete(file);
        continue;
      }
      stats.files += 1;
      const consume = (entry) => (line) => consumeLine(entry, line, startMs);
      // Every line is a usage record, so an oversize one is lost usage.
      const oversize = (entry) => (head) => noteDropped(entry, timeOfBadLine(head.toString('utf8')));
      if (prior && prior.size === st.size && prior.mtimeMs === st.mtimeMs) {
        const before = prior.offset;
        settleTail(file, prior, st.size, st.mtimeMs, now, consume(prior), oversize(prior));
        if (prior.offset !== before) prior.tail = tailBytes(file, prior.offset);
        continue;
      }
      const appended = prior && st.size > prior.size && isAppendOf(file, prior);
      const entry = appended ? prior : freshEntry();
      const read = readAppended(file, entry, st.size, consume(entry), oversize(entry));
      if (read < 0) {
        unread.set(file, rangeOf(prior || entry, st, now, Boolean(prior) && prior.size !== st.size));
        cache.delete(file);
        continue;
      }
      stats.bytesRead += read;
      if (appended) stats.appended += 1;
      else stats.parsed += 1;
      entry.size = st.size;
      entry.mtimeMs = st.mtimeMs;
      entry.birthMs = st.birthtimeMs;
      settleTail(file, entry, st.size, st.mtimeMs, now, consume(entry), oversize(entry));
      entry.tail = tailBytes(file, entry.offset);
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

    const out = [];
    const merged = new Map();
    for (const entry of cache.values()) {
      if (entry.droppedFromMs !== null) reach({ fromMs: entry.droppedFromMs, throughMs: entry.droppedThroughMs });
      if (entry.droppedUntimed) reach(rangeOf(entry, { birthtimeMs: entry.birthMs, mtimeMs: entry.mtimeMs }, now, false));
      foldOld(entry, rawSinceMs);
      for (const [key, b] of entry.buckets) {
        if (b.ts < startMs || b.ts >= now) continue;
        const m = merged.get(key);
        if (!m) merged.set(key, { ...b });
        else {
          m.input += b.input;
          m.cached += b.cached;
          m.output += b.output;
          m.count += b.count;
        }
      }
      for (const ev of entry.events) if (ev.ts >= startMs && ev.ts < now) out.push(ev);
    }
    for (const b of merged.values()) out.push(b);
    out.sort((a, b) => a.ts - b.ts);
    // At most MAX_MODELS model ids; the rest is 'unknown' and a known gap (security F4).
    const capped = capModels(out);
    if (capped.overflow) reach(capped.overflow);

    stats.ms = Date.now() - began;
    stats.cachedFiles = cache.size;
    stats.rawEvents = out.length - merged.size;
    stats.buckets = merged.size;
    stats.modelsCapped = capped.overflow !== null;
    // Qwen Code is here but has written no usage log at all (older than
    // v0.18.4, or usage statistics off): the row says so instead of a zero.
    stats.usageLogAbsent = stats.usageFiles === 0 && unread.size === 0;
    lastStats = stats;
    lastUnread = hull === null ? null : { fromMs: Math.min(hull.fromMs, now), throughMs: Math.min(hull.throughMs, now) };
    return capped.events;
  }

  return {
    scan,
    /** Counts and timings of the last scan. Numbers and booleans only: safe to log. */
    stats: () => lastStats,
    /** `{ fromMs, throughMs }` hull of usage known unread by the last scan, or null. */
    unreadRange: () => (lastUnread ? { ...lastUnread } : null),
  };
}

/** One-shot scan with no cache carried between calls. */
function qwenUsageEvents(options = {}) {
  return createQwenUsageScanner().scan(options);
}

/**
 * Sum a window into the row's TokenBreakdown. `input` is the uncached prompt,
 * `cacheRead` the cached part, `output` already holds the thinking tokens.
 * Qwen records no cache-write count, so `cacheWrite` stays 0.
 */
function sumQwenTokens(events, startMs, endMs) {
  const t = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, billable: 0 };
  const perModel = new Map();
  for (const ev of events || []) {
    if (!ev || ev.ts < startMs || ev.ts >= endMs) continue;
    t.input += ev.input;
    t.output += ev.output;
    t.cacheRead += ev.cached;
    perModel.set(ev.model, (perModel.get(ev.model) || 0) + ev.input + ev.output);
  }
  t.billable = t.input + t.output + t.cacheWrite;
  const byModel = Array.from(perModel, ([model, billable]) => ({ model, billable }))
    .sort((a, b) => b.billable - a.billable || (a.model < b.model ? -1 : 1));
  return { tokens: t, byModel };
}

function _resetForTests() {
  networkHomeWarned = false;
  relativeHomeWarned = false;
}

module.exports = {
  createQwenUsageScanner,
  qwenUsageEvents,
  sumQwenTokens,
  qwenHome,
  qwenUsageDir,
  RAW_DAYS,
  BUCKET_MS,
  _resetForTests,
};
