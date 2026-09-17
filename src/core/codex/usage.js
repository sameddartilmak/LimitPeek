'use strict';
/**
 * Codex TOKEN usage and its notional API cost, read from the same session
 * rollout logs the rate-limit reader uses.
 *
 * WHERE THE NUMBERS COME FROM (and why it is honest)
 * --------------------------------------------------
 * Every Codex turn appends a `token_count` event carrying the session's
 * CUMULATIVE usage and the turn's own split, both measured by Codex itself:
 *
 *   total_token_usage / last_token_usage: { input_tokens, cached_input_tokens,
 *     cache_write_input_tokens, output_tokens, reasoning_output_tokens,
 *     total_tokens }
 *
 * These are COUNTS the tool recorded, not anything we derive — so summing the
 * per-turn deltas whose timestamp falls in a window gives that window's real
 * usage. The cost is those counts multiplied by OpenAI's PUBLISHED per-token
 * prices (`pricing.js`), framed exactly as Claude's is: never a bill, "what
 * this would have cost on the API" — the user is on a subscription.
 *
 * `input_tokens` is the WHOLE prompt including the cached part, so the
 * full-price ("input") share is `input_tokens - cached_input_tokens - write`,
 * and the cached share is billed at OpenAI's discounted cached-input rate.
 * `reasoning_output_tokens` is a SUBSET of `output_tokens` and is never added.
 *
 * Deltas come from the cumulative total, not from summing `last_token_usage`:
 * Codex re-emits `token_count` with an unchanged total (measured on the owner's
 * corpus: 16 of 460 records, 1.8M tokens that a last-usage sum would count
 * twice). A monotonic total turns a re-emission into a zero delta.
 *
 * WHICH MODEL
 * -----------
 * The model is taken per turn from the most recent `turn_context.model`, which
 * Codex writes before each turn — so a session that switches model mid-way
 * prices each turn at its own model. `session_meta` carries no top-level model
 * on current Codex builds; the header is only a fallback for a turn that
 * precedes any `turn_context`. Nothing resolvable -> "unknown", which the
 * pricer reports as unpriced, never as $0.
 *
 * WHICH SERVICE TIER
 * ------------------
 * The tier (Standard / Fast) sets the price, so every event carries the tier in
 * effect when it ran: the `service_tier` of the most recent
 * `event_msg`/`thread_settings_applied` before it (`priority` and `fast` are
 * one tier; `default` is Standard). Measured on the owner's corpus, that record
 * is NOT written at session start: in every top-level session the first turn's
 * token_count comes before the first settings record (one session has none at
 * all), and it is re-emitted with unchanged values when settings are applied,
 * not only on a change. `session_meta`, `turn_context` and `world_state` carry
 * no tier. The Codex app resolves a new request's tier from its own per-host
 * selection and only then from config.toml's `service_tier`, whose CURRENT
 * value says nothing about the value when an older session ran. So before the
 * first settings record the tier is not determinable, the event's `tier` is
 * `null`, and the pricer leaves it unpriced (ADR-002 Amendment 3 rule 1) —
 * never assumed Standard.
 *
 * WINDOWING ACROSS STALE MTIMES
 * -----------------------------
 * Codex keeps a session's rollout OPEN and appends without reliably updating
 * the file's mtime, and a long session's file stays in its START-date folder
 * while it keeps taking turns. So a window cannot be resolved by file mtime or
 * folder date alone: every day-folder from `DAY_SPAN` days before the earliest
 * instant asked for is scanned, and only events whose OWN timestamp lands in
 * the window are returned.
 *
 * PERFORMANCE
 * -----------
 * The usage history spans a year, so re-reading every rollout on every rebuild
 * is not an option. `createCodexUsageScanner()` keeps a per-file cache keyed by
 * path and invalidated by size + mtime. A rollout is append-only, so a file that
 * only GREW is read from the byte after its last complete line; anything else
 * (shrunk, rewritten in place) is re-read from the start. Reads are chunked, so
 * no file is ever loaded whole.
 *
 * PRIVACY
 * -------
 * Rollouts contain prompts and code. Only lines that contain one of the four
 * record markers are decoded at all, only `token_count`, `turn_context`,
 * `thread_settings_applied` and `session_meta` records are inspected, only
 * numeric token fields, timestamps, a model id and a service tier are kept,
 * and nothing read here is ever logged — not a line, not a value, not a
 * JSON.parse error.
 */

const fs = require('node:fs');
const path = require('node:path');
const { codexSessionsDir, resolveLocalDir } = require('./rollout');
const { normalizeTier, classifyCodexEvent } = require('./pricing');

/** Day-folders scanned BEFORE the earliest instant a caller needs: slack for a
 *  session that opened before the window and is still appending into it. */
const DAY_SPAN = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Read granularity. Bounds memory per read; a rollout is never loaded whole. */
const CHUNK_BYTES = 1024 * 1024;

/** A line longer than this is skipped unparsed. The records read here are a
 *  few hundred bytes (token_count, turn_context) to tens of KB (session_meta);
 *  anything this large is a tool output or a pasted file. */
const MAX_LINE_BYTES = 4 * 1024 * 1024;

const NL = 0x0a;

/** A model id is shown verbatim in the UI, so it is held to an id's shape. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;

/**
 * A token count as recorded, or `null` when it is not a safe non-negative
 * integer (ADR-002 A3.10, security F2) — a 1e300 or a fraction must never move
 * the money or the running total. `optional` lets an ABSENT field read as 0.
 */
function count(v, optional = false) {
  if (v === undefined && optional) return 0;
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/**
 * The four counts of a usage block, or `null` when it is unusable. Only
 * `cache_write_input_tokens` may be absent (older Codex builds omit it; it is
 * then 0). A block missing input, cached or output is PARTIAL, not a block of
 * zeros: read as zeros, a partial total would look like a reset and the next
 * full total would count the whole session again (review F6).
 */
function usageOf(u) {
  if (!u || typeof u !== 'object') return null;
  const out = {
    input: count(u.input_tokens),
    cached: count(u.cached_input_tokens),
    write: count(u.cache_write_input_tokens, true),
    output: count(u.output_tokens),
  };
  return out.input === null || out.cached === null || out.write === null || out.output === null ? null : out;
}

const KEYS = ['input', 'cached', 'write', 'output'];

function modelId(v) {
  return typeof v === 'string' && MODEL_ID.test(v) ? v : null;
}

/** Fresh per-file parse state. */
function freshEntry() {
  return {
    size: 0,
    mtimeMs: 0,
    offset: 0, // bytes consumed through the last complete line
    cum: null, // running cumulative { input, cached, write, output }
    turnModel: null, // latest turn_context.model
    metaModel: null, // first session_meta fallback
    metaSeen: false, // only the FIRST header is the session's own (a fork carries its parent's too)
    tier: null, // latest thread_settings_applied service_tier; null = not determinable
    events: [], // raw turn deltas since the raw cutoff, oldest first
    buckets: new Map(), // older turns, folded per UTC 15-min slot + model + tier + flags
  };
}

/**
 * One complete line. Cheap byte-marker test first, so prompt and tool-output
 * lines are never decoded to a string, let alone parsed.
 */
function consumeLine(entry, line) {
  if (line.length === 0 || line.length > MAX_LINE_BYTES) return;
  // The markers only decide whether a line is worth decoding; what a record IS
  // is decided by its parsed `type`, never by which marker happened to match.
  const worth = line.indexOf('token_count') !== -1
    || line.indexOf('turn_context') !== -1
    || line.indexOf('thread_settings_applied') !== -1
    || (!entry.metaSeen && line.indexOf('session_meta') !== -1);
  if (!worth) return;

  let o;
  try {
    o = JSON.parse(line.toString('utf8'));
  } catch {
    return; // never log: the message can quote the line
  }
  if (!o || typeof o !== 'object' || !o.payload || typeof o.payload !== 'object') return;

  if (o.type === 'turn_context') {
    const m = modelId(o.payload.model);
    if (m) entry.turnModel = m;
    return;
  }
  if (o.type === 'event_msg' && o.payload.type === 'thread_settings_applied') {
    const s = o.payload.thread_settings;
    // Only a record that states the tier moves it. One that names the key with
    // a non-string value makes the tier undeterminable again, not Standard.
    if (s && typeof s === 'object' && Object.prototype.hasOwnProperty.call(s, 'service_tier')) {
      entry.tier = normalizeTier(s.service_tier);
    }
    return;
  }
  if (o.type === 'session_meta') {
    if (entry.metaSeen) return;
    entry.metaSeen = true;
    const bi = o.payload.base_instructions;
    entry.metaModel = modelId(o.payload.model)
      || (bi && bi.provenance && modelId(bi.provenance.model))
      || null;
    return;
  }

  const p = o.payload;
  if (o.type !== 'event_msg' || p.type !== 'token_count' || !p.info) return;

  // Deltas come from the cumulative total while it is MONOTONIC (ADR-002
  // A3.10). `last_token_usage` is used instead when:
  //   - the total DROPS below the previous one (a reset): the drop says nothing
  //     about this turn, the record's own last usage does;
  //   - it is the file's FIRST record and its total exceeds its last usage: a
  //     resumed or forked session inherited a running total that was already
  //     counted where it was spent;
  //   - the record carries no total at all.
  // A record whose counts are not valid is skipped and does NOT move the
  // running total, so one corrupt line cannot poison every later delta.
  const hasTotal = p.info.total_token_usage !== undefined && p.info.total_token_usage !== null;
  const cur = hasTotal ? usageOf(p.info.total_token_usage) : null;
  const hasLast = p.info.last_token_usage !== undefined && p.info.last_token_usage !== null;
  const last = hasLast ? usageOf(p.info.last_token_usage) : null;
  if (hasTotal && cur === null) return;
  if (hasLast && last === null) return;

  let delta;
  if (cur) {
    const prev = entry.cum;
    if (!prev) {
      const inherited = last !== null && KEYS.some((k) => cur[k] > last[k]);
      delta = inherited ? { ...last } : { ...cur };
    } else if (KEYS.some((k) => cur[k] < prev[k])) {
      if (last === null) {
        // A reset with no per-turn figure: the new baseline is taken, nothing
        // is counted — an undercount, never an invented charge.
        entry.cum = cur;
        return;
      }
      delta = { ...last };
    } else {
      delta = {
        input: cur.input - prev.input,
        cached: cur.cached - prev.cached,
        write: cur.write - prev.write,
        output: cur.output - prev.output,
      };
    }
    entry.cum = cur;
  } else {
    if (last === null) return;
    delta = { ...last };
  }

  const ts = Date.parse(o.timestamp);
  if (!Number.isFinite(ts)) return;
  if (delta.input === 0 && delta.cached === 0 && delta.write === 0 && delta.output === 0) return;
  // `input` is the WHOLE prompt; `cached` and `write` are disjoint subsets, so
  // the full-price share is what remains. `output` already includes reasoning
  // tokens (a subset), so nothing is added for them.
  entry.events.push({
    ts,
    model: entry.turnModel || entry.metaModel || 'unknown',
    tier: entry.tier,
    inputUncached: Math.max(0, delta.input - delta.cached - delta.write),
    cachedInput: delta.cached,
    cacheWrite: delta.write,
    output: delta.output,
  });
}

/**
 * Reads `file` from `entry.offset` to `size`, feeding complete lines to
 * `consumeLine`. A trailing partial line is left for the next read (the writer
 * may be mid-append). Returns the bytes read, or -1 when the file could not be
 * read (the entry is then unusable and must be dropped).
 */
function readForward(file, entry, size) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return -1;
  }
  let bytes = 0;
  try {
    let pos = entry.offset;
    let carry = null; // bytes of an unfinished line
    let skipping = false; // inside a line already known to exceed MAX_LINE_BYTES
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK_BYTES, size - pos), pos);
      if (n <= 0) break;
      bytes += n;
      let start = 0;
      for (;;) {
        const nl = buf.indexOf(NL, start);
        if (nl === -1 || nl >= n) break;
        if (skipping) {
          skipping = false;
        } else if (carry) {
          const piece = buf.subarray(start, nl);
          if (carry.length + piece.length <= MAX_LINE_BYTES) {
            consumeLine(entry, Buffer.concat([carry, piece]));
          }
        } else {
          consumeLine(entry, buf.subarray(start, nl));
        }
        carry = null;
        entry.offset = pos + nl + 1;
        start = nl + 1;
      }
      if (start < n && !skipping) {
        const rest = buf.subarray(start, n);
        const len = (carry ? carry.length : 0) + rest.length;
        if (len > MAX_LINE_BYTES) {
          carry = null;
          skipping = true;
        } else {
          // Copied: `buf` is reused on the next read.
          carry = carry ? Buffer.concat([carry, rest]) : Buffer.from(rest);
        }
      }
      pos += n;
    }
  } catch {
    bytes = -1;
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
  return bytes;
}

/** Is the byte before `offset` a newline? Confirms an append did not rewrite
 *  the part of the file already consumed. */
function endsAtLineBoundary(file, offset) {
  if (offset === 0) return true;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(1);
    return fs.readSync(fd, b, 0, 1, offset - 1) === 1 && b[0] === NL;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/** Local midnight of the day containing `ms`. */
function localDayStart(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Local midnight of the day a `YYYY/MM/DD` folder names, or NaN. */
function folderDayMs(y, m, d) {
  const ms = new Date(Number(y), Number(m) - 1, Number(d)).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

/** Names in `dir` that are all digits of length `len`, newest first. */
function digitNames(dir, len) {
  try {
    return fs.readdirSync(dir).filter((n) => n.length === len && /^\d+$/.test(n)).sort().reverse();
  } catch {
    return [];
  }
}

/**
 * Day-folders (`YYYY/MM/DD`) whose LOCAL date is on or after `fromMs`'s day,
 * newest first, as RESOLVED paths. Local links and junctions are followed (a
 * sessions tree junctioned to another drive works); a directory that resolves
 * to the network is refused (`resolveLocalDir`, review F7). Names that are not
 * a date are ignored.
 */
function dayDirsSince(sessionsDir, fromMs) {
  const out = [];
  const root = sessionsDir ? resolveLocalDir(sessionsDir) : null;
  if (!root) return out;
  const fromDay = localDayStart(fromMs);
  const fromYear = new Date(fromDay).getFullYear();
  for (const y of digitNames(root, 4)) {
    if (Number(y) < fromYear) break;
    const yDir = resolveLocalDir(path.join(root, y));
    if (!yDir) continue;
    for (const m of digitNames(yDir, 2)) {
      const mDir = resolveLocalDir(path.join(yDir, m));
      if (!mDir) continue;
      for (const d of digitNames(mDir, 2)) {
        const dayMs = folderDayMs(y, m, d);
        if (!Number.isFinite(dayMs) || dayMs < fromDay) continue;
        const dDir = resolveLocalDir(path.join(mDir, d));
        if (dDir) out.push(dDir);
      }
    }
  }
  return out;
}

/** A rollout path relative to the sessions root, as fs.watch reports it. */
const CHANGED_PATH = /^(\d{4})[\\/](\d{2})[\\/](\d{2})[\\/](rollout-[^\\/]*\.jsonl)$/;

/** Is `name` a rollout file a watcher event can name precisely? */
function isRolloutRelPath(name) {
  return typeof name === 'string' && CHANGED_PATH.test(name);
}

/**
 * How many days of RAW turn events are kept. Older turns are folded into one
 * bucket per UTC 15-minute slot + model + tier + pricing flags (security F1:
 * memory). The row's five-hour tokens and weekly cost need raw turns for at
 * most the last 7 days.
 *
 * WHY 15 MINUTES OF UTC, not a local day (review F4): every real UTC offset is
 * a multiple of 15 minutes, so every local midnight — and with it every local
 * week and month boundary the history uses — is a 15-minute UTC boundary. A
 * bucket therefore can never straddle a history period, even if the time zone
 * changes while the app runs, or the worker and the main thread disagree about
 * it. A local-day bucket had neither guarantee.
 */
const RAW_DAYS = 8;
const BUCKET_MS = 15 * 60 * 1000;

/** Fold one raw event into `buckets`. The pricing flags are decided per turn
 *  first, so folding changes no price, floor or unpriced count. */
function foldInto(buckets, ev) {
  const { longContext, writeFloor, hasWrite } = classifyCodexEvent(ev);
  const slot = Math.floor(ev.ts / BUCKET_MS) * BUCKET_MS;
  const key = `${slot}|${ev.model}|${ev.tier}|${longContext ? 1 : 0}${writeFloor ? 1 : 0}${hasWrite ? 1 : 0}`;
  let b = buckets.get(key);
  if (!b) {
    b = {
      ts: slot,
      model: ev.model,
      tier: ev.tier,
      inputUncached: 0,
      cachedInput: 0,
      cacheWrite: 0,
      output: 0,
      count: 0,
      longContext,
      writeFloor,
      hasWrite,
    };
    buckets.set(key, b);
  }
  b.inputUncached += ev.inputUncached;
  b.cachedInput += ev.cachedInput;
  b.cacheWrite += ev.cacheWrite;
  b.output += ev.output;
  b.count += Number.isSafeInteger(ev.count) && ev.count > 0 ? ev.count : 1;
}

/** Move an entry's raw events older than `rawSinceMs` into its buckets. */
function foldOld(entry, rawSinceMs) {
  if (entry.events.length === 0 || entry.events[0].ts >= rawSinceMs) return;
  const keep = [];
  for (const ev of entry.events) {
    if (ev.ts < rawSinceMs) foldInto(entry.buckets, ev);
    else keep.push(ev);
  }
  entry.events = keep;
}

/**
 * A scanner that remembers what it has read. Hold one for the life of the
 * process (the collector holds it inside the Codex scan worker); each `scan()`
 * re-reads only rollouts that changed since the last.
 */
function createCodexUsageScanner() {
  /** @type {Map<string, ReturnType<typeof freshEntry>>} */
  const cache = new Map();
  let lastStats = null;
  /** The highest `rawSinceMs` any entry has been folded to. */
  let foldedTo = -Infinity;

  /** Bring one rollout's cache entry up to date. Returns false when the file
   *  is gone or unusable (its entry is then dropped). */
  function refresh(file, stats) {
    let st;
    try {
      st = fs.lstatSync(file);
    } catch {
      cache.delete(file);
      return false;
    }
    if (!st.isFile() || st.isSymbolicLink()) {
      cache.delete(file);
      return false;
    }
    stats.files += 1;
    let entry = cache.get(file);
    const unchanged = entry && entry.size === st.size && entry.mtimeMs === st.mtimeMs;
    if (unchanged) return true;
    const appended = entry && st.size > entry.size && endsAtLineBoundary(file, entry.offset);
    if (!appended) entry = freshEntry();
    const read = readForward(file, entry, st.size);
    if (read < 0) {
      cache.delete(file);
      return false;
    }
    stats.bytesRead += read;
    if (appended) stats.appended += 1;
    else stats.parsed += 1;
    entry.size = st.size;
    entry.mtimeMs = st.mtimeMs;
    cache.set(file, entry);
    return true;
  }

  /**
   * Every Codex turn delta with `startMs <= ts < now`: raw turns since
   * `rawSinceMs`, and UTC 15-minute buckets (with `count`) for older turns.
   *
   * @param {{now?:number, startMs?:number, home?:string, rawSinceMs?:number,
   *          changed?:string[]}} [options]
   *   `changed` — rollout paths relative to the sessions root, as fs.watch
   *   names them. When given, ONLY those files are re-examined and every other
   *   cached rollout is reused as-is; without it every day-folder in range is
   *   walked and rollouts no longer present are dropped.
   */
  function scan(options = {}) {
    const began = Date.now();
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const startMs = Number.isFinite(options.startMs) ? options.startMs : now - 7 * DAY_MS;
    const rawSinceMs = Number.isFinite(options.rawSinceMs)
      ? options.rawSinceMs
      : localDayStart(now - RAW_DAYS * DAY_MS);
    const sessionsDir = codexSessionsDir(options.home);
    const stats = { files: 0, parsed: 0, appended: 0, bytesRead: 0, ms: 0, mode: 'full', cacheReset: false };
    const fromMs = startMs - DAY_SPAN * DAY_MS;

    // The clock jumped forward and came back (review F5): turns already folded
    // past the new raw cutoff exist only as buckets, and a raw-window consumer
    // (five-hour tokens, weekly cost) would silently miss them. Folding cannot
    // be undone, so the cache is dropped and every rollout re-read in full.
    if (rawSinceMs < foldedTo) {
      cache.clear();
      stats.cacheReset = true;
    }
    foldedTo = rawSinceMs;

    if (!sessionsDir) {
      cache.clear();
    } else if (Array.isArray(options.changed) && !stats.cacheReset) {
      stats.mode = 'changed';
      const fromDay = localDayStart(fromMs);
      for (const rel of options.changed) {
        const m = CHANGED_PATH.exec(String(rel));
        if (!m) continue;
        const dayMs = folderDayMs(m[1], m[2], m[3]);
        if (!Number.isFinite(dayMs) || dayMs < fromDay) continue;
        // Resolved level by level exactly as the full walk resolves them, so the
        // cache key for a file is the same string in both modes.
        const root = resolveLocalDir(sessionsDir);
        const yDir = root && resolveLocalDir(path.join(root, m[1]));
        const mDir = yDir && resolveLocalDir(path.join(yDir, m[2]));
        const dDir = mDir && resolveLocalDir(path.join(mDir, m[3]));
        if (!dDir) continue; // refused or gone; the next full walk drops its entry
        refresh(path.join(dDir, m[4]), stats);
      }
    } else {
      const seen = new Set();
      for (const dir of dayDirsSince(sessionsDir, fromMs)) {
        let names;
        try { names = fs.readdirSync(dir); } catch { continue; }
        for (const name of names) {
          if (!/^rollout-.*\.jsonl$/.test(name)) continue;
          const file = path.join(dir, name);
          if (refresh(file, stats)) seen.add(file);
        }
      }
      // A rollout that disappeared, or aged out of the scanned range, is dropped.
      for (const file of cache.keys()) {
        if (!seen.has(file)) cache.delete(file);
      }
    }

    const out = [];
    const merged = new Map();
    for (const entry of cache.values()) {
      foldOld(entry, rawSinceMs);
      for (const [key, b] of entry.buckets) {
        if (b.ts < startMs || b.ts >= now) continue;
        const m = merged.get(key);
        if (!m) {
          merged.set(key, { ...b });
        } else {
          m.inputUncached += b.inputUncached;
          m.cachedInput += b.cachedInput;
          m.cacheWrite += b.cacheWrite;
          m.output += b.output;
          m.count += b.count;
        }
      }
      for (const ev of entry.events) {
        if (ev.ts >= startMs && ev.ts < now) out.push(ev);
      }
    }
    for (const b of merged.values()) out.push(b);

    out.sort((a, b) => a.ts - b.ts);
    stats.ms = Date.now() - began;
    stats.cachedFiles = cache.size;
    stats.rawEvents = out.length - merged.size;
    stats.buckets = merged.size;
    lastStats = stats;
    return out;
  }

  return {
    scan,
    /** Counts and timings of the last scan. Numbers only — safe to log. */
    stats: () => lastStats,
  };
}

/**
 * One-shot scan with no cache carried between calls. `startMs` is the earliest
 * instant the caller needs; each consumer re-filters to its own window.
 */
function codexUsageEvents(options = {}) {
  return createCodexUsageScanner().scan(options);
}

/** Sum a window's events into the row's TokenBreakdown shape. `cacheWrite` is
 *  the recorded write count and `cacheRead` the cached-input count; `billable`
 *  matches the app's rule `input + output + cacheWrite`. */
function sumCodexTokens(events, startMs, endMs) {
  const t = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, billable: 0 };
  const perModel = new Map();
  for (const ev of events) {
    if (ev.ts < startMs || ev.ts >= endMs) continue;
    t.input += ev.inputUncached;
    t.output += ev.output;
    t.cacheWrite += ev.cacheWrite;
    t.cacheRead += ev.cachedInput;
    const bill = ev.inputUncached + ev.output + ev.cacheWrite;
    perModel.set(ev.model, (perModel.get(ev.model) || 0) + bill);
  }
  t.billable = t.input + t.output + t.cacheWrite;
  const byModel = Array.from(perModel, ([model, billable]) => ({ model, billable }))
    .sort((a, b) => b.billable - a.billable || (a.model < b.model ? -1 : 1));
  return { tokens: t, byModel };
}

module.exports = {
  createCodexUsageScanner,
  isRolloutRelPath,
  RAW_DAYS,
  BUCKET_MS,
  codexUsageEvents,
  sumCodexTokens,
  DAY_SPAN,
};
