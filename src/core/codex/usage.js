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
 * first settings record no tier is RECORDED: the event's `tier` is `null` and it
 * carries `preSettings: true`.
 *
 * Whether such a turn may be priced at Standard is ADR-002 A3.17's question, and
 * it is answered per ROLLOUT, not per turn: Codex core sends only a tier the
 * model catalog advertises and no observed catalog lists flex, so a rollout whose
 * every recorded tier is default/priority/fast (or that records none) is
 * eligible. Eligibility depends on records AFTER the turn too, so it is not
 * baked into the event or its folded bucket: each scan emits pre-settings turns
 * with `tierAssumable` set from the whole file read so far, and a flex record
 * appended later turns it false for every earlier turn. In an eligible rollout
 * that has a settings record, those turns take the tier the FIRST record states
 * (backfill, see the output loop). Only a rollout with no settings record at all
 * still leaves them unknown: the pricer prices those `tierAssumable` turns at
 * Standard as a counted floor (`assumedTierEvents`) and leaves ineligible ones
 * unpriced — never a silent Standard.
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
const { codexSessionsDir, resolveLocalDir, isRefusedDir } = require('./rollout');
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
    // A settings record that STATES a tier has been read. Turns before it carry
    // `preSettings: true` (ADR-002 A3.17).
    settingsSeen: false,
    // The tier the FIRST settings record stated; backfills the turns before it.
    firstTier: null,
    // Some recorded service_tier is outside {default, priority, fast} (flex,
    // ultrafast, anything else, or a non-string). Decided over the WHOLE file
    // read so far — including records AFTER a turn — so a later flex record
    // makes every earlier pre-settings turn unassumable again (A3.17).
    tierIneligible: false,
    // Local date of the day-folder the rollout sits in: sessions append into
    // their START day, so no turn in it is older (bounds unread ranges).
    dayMs: NaN,
    // Timestamp range of usage records this file HAS but could not count
    // (corrupt line, invalid counts, over the line cap, an unreadable timestamp,
    // a reset with no per-turn figure); null when none (ADR-002 A3.15).
    // `droppedUntimed`: one of them had no usable timestamp. Records are
    // appended in order, so it is no later than the NEXT timestamped record
    // (`untimedThroughMs`); while none has followed (`untimedOpen`) it may be as
    // late as now (review F2).
    droppedFromMs: null,
    droppedThroughMs: null,
    droppedUntimed: false,
    untimedOpen: false,
    untimedThroughMs: null,
    // Latest turn or record timestamp read from this file. A resumed or
    // long-lived session keeps appending into its START folder, so the folder
    // date alone does not bound it (review F2).
    maxTs: null,
    events: [], // raw turn deltas since the raw cutoff, oldest first
    buckets: new Map(), // older turns, folded per UTC 15-min slot + model + tier + flags
  };
}

/**
 * How many leading bytes of a line identify its record. Codex writes
 * `{"timestamp":"…","type":"event_msg","payload":{"type":"token_count"` in that
 * order, so a token_count record names itself well inside this; a prompt or
 * tool output that merely MENTIONS token_count further in does not.
 */
const HEAD_BYTES = 256;
const HEAD_TOKEN_COUNT = /"type"\s*:\s*"token_count"/;
const HEAD_TIMESTAMP = /^\{\s*"timestamp"\s*:\s*"([^"]{1,40})"/;

/**
 * A line that could not be decoded or counted: when its head says it is a
 * token_count record, the file knowingly lost usage (ADR-002 A3.15). Only the
 * head's timestamp is read out of it, and nothing is logged.
 */
function noteUnreadable(entry, line) {
  const head = line.subarray(0, HEAD_BYTES).toString('utf8');
  if (!HEAD_TOKEN_COUNT.test(head)) return;
  const m = HEAD_TIMESTAMP.exec(head);
  noteDropped(entry, m ? Date.parse(m[1]) : NaN);
}

/** Record one lost usage record at `ts` (NaN when its timestamp is unusable). */
function noteDropped(entry, ts) {
  if (!Number.isFinite(ts)) {
    entry.droppedUntimed = true;
    entry.untimedOpen = true;
    return;
  }
  noteTimestamp(entry, ts);
  if (entry.droppedFromMs === null || ts < entry.droppedFromMs) entry.droppedFromMs = ts;
  if (entry.droppedThroughMs === null || ts > entry.droppedThroughMs) entry.droppedThroughMs = ts;
}

/** A timestamped record was read: it bounds any untimed loss before it. */
function noteTimestamp(entry, ts) {
  if (entry.maxTs === null || ts > entry.maxTs) entry.maxTs = ts;
  if (entry.untimedOpen) {
    entry.untimedOpen = false;
    if (entry.untimedThroughMs === null || ts > entry.untimedThroughMs) entry.untimedThroughMs = ts;
  }
}

/** Recorded service tiers Codex core can send for a catalog model (A3.17). */
const ASSUMABLE_TIERS = new Set(['default', 'priority', 'fast']);

/**
 * One complete line. Cheap byte-marker test first, so prompt and tool-output
 * lines are never decoded to a string, let alone parsed.
 */
function consumeLine(entry, line) {
  if (line.length === 0) return;
  if (line.length > MAX_LINE_BYTES) {
    noteUnreadable(entry, line);
    return;
  }
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
    // Never log: the message can quote the line. A corrupt token_count record
    // is still usage this file has and the figure lacks.
    noteUnreadable(entry, line);
    return;
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
      if (!entry.settingsSeen) entry.firstTier = entry.tier;
      entry.settingsSeen = true;
      const raw = typeof s.service_tier === 'string' ? s.service_tier.trim().toLowerCase() : null;
      if (!ASSUMABLE_TIERS.has(raw)) entry.tierIneligible = true;
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
  const recordTs = Date.parse(o.timestamp);
  if ((hasTotal && cur === null) || (hasLast && last === null)) {
    // Skipped per A3.10, but it IS a usage record the figure now lacks.
    noteDropped(entry, recordTs);
    return;
  }

  let delta;
  if (cur) {
    const prev = entry.cum;
    if (!prev) {
      const inherited = last !== null && KEYS.some((k) => cur[k] > last[k]);
      delta = inherited ? { ...last } : { ...cur };
    } else if (KEYS.some((k) => cur[k] < prev[k])) {
      if (last === null) {
        // A reset with no per-turn figure: the new baseline is taken, nothing
        // is counted — an undercount, never an invented charge, and a KNOWN one.
        entry.cum = cur;
        noteDropped(entry, recordTs);
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

  const ts = recordTs;
  if (Number.isFinite(ts)) noteTimestamp(entry, ts);
  if (delta.input === 0 && delta.cached === 0 && delta.write === 0 && delta.output === 0) return;
  if (!Number.isFinite(ts)) {
    // The running total already moved past this turn; it cannot be placed in
    // any window, so it is a known loss rather than a silent one.
    noteDropped(entry, NaN);
    return;
  }
  // `input` is the WHOLE prompt; `cached` and `write` are disjoint subsets, so
  // the full-price share is what remains. `output` already includes reasoning
  // tokens (a subset), so nothing is added for them.
  const event = {
    ts,
    model: entry.turnModel || entry.metaModel || 'unknown',
    tier: entry.tier,
    inputUncached: Math.max(0, delta.input - delta.cached - delta.write),
    cachedInput: delta.cached,
    cacheWrite: delta.write,
    output: delta.output,
  };
  // Before any settings record stated a tier (A3.17). Whether it may be priced
  // at Standard depends on the whole rollout, so it is decided at output.
  if (!entry.settingsSeen) event.preSettings = true;
  entry.events.push(event);
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
          } else {
            noteUnreadable(entry, carry);
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
          // The head is where the line started: the carried bytes, then this rest.
          noteUnreadable(entry, carry ? Buffer.concat([carry, rest.subarray(0, HEAD_BYTES)]) : rest);
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

/**
 * How long an unterminated last line is taken to be a write in progress. Past
 * it, on a file that has not changed, the writer is gone and the line will
 * never be completed. Same value as the Claude scanner's (scan/scanner.js).
 */
const TORN_WRITE_GRACE_MS = 5 * 60 * 1000;

/**
 * An unterminated tail (`entry.offset < size`) on a file last written more than
 * TORN_WRITE_GRACE_MS ago is not in progress (review F1): it is read once as a
 * final line — counted if it happens to be whole, noted as a loss if it is a
 * truncated token_count — and the offset moves past it. If the file ever grows
 * again, the byte before the new offset is not a newline, so `refresh` re-reads
 * it from the start and nothing is counted twice.
 *
 * Codex does not reliably update a rollout's mtime while appending, so a live
 * session can look idle: its half-written line is then noted early (an
 * over-mark, allowed by A3.9) and the next append re-reads the file.
 */
function settleDeadTail(file, entry, size, mtimeMs, now) {
  if (entry.offset >= size || !(mtimeMs < now - TORN_WRITE_GRACE_MS)) return;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const len = Math.min(size - entry.offset, MAX_LINE_BYTES + 1);
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, entry.offset);
    const line = buf.subarray(0, n);
    if (size - entry.offset > MAX_LINE_BYTES) noteUnreadable(entry, line);
    else consumeLine(entry, line);
    entry.offset = size;
  } catch {
    // Left pending: the next scan tries again.
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
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

/**
 * Names in `dir` that are all digits of length `len`, newest first. A listing
 * that FAILED for a reason other than the directory being gone calls
 * `onUnread` (ADR-002 A3.15): the directory exists and its rollouts were not read.
 */
function digitNames(dir, len, onUnread) {
  try {
    return fs.readdirSync(dir).filter((n) => n.length === len && /^\d+$/.test(n)).sort().reverse();
  } catch (err) {
    if (onUnread && !(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'))) onUnread();
    return [];
  }
}

/**
 * The latest instant a rollout started on local day `dayMs` can carry turns
 * this scanner would read: the scanner reaches back DAY_SPAN days before the
 * window for sessions still appending (mtimes do not bound them), so an
 * unread file or folder is taken to reach DAY_SPAN days past its date — the
 * same assumption, never later than `now`.
 */
function unreadThrough(dayMs, now) {
  return Number.isFinite(dayMs) ? Math.min(now, dayMs + (DAY_SPAN + 1) * DAY_MS) : now;
}

/**
 * The instant range `{ fromMs, throughMs }` an unread folder or file covering
 * local days `firstDayMs`..`lastDayMs` can hold turns in: none older than its
 * first day (sessions append into their START folder), none later than
 * `unreadThrough` of its last. An unknown first day is 0 (unbounded).
 */
function unreadRange(firstDayMs, lastDayMs, now) {
  return {
    fromMs: Number.isFinite(firstDayMs) ? Math.min(firstDayMs, now) : 0,
    throughMs: unreadThrough(lastDayMs, now),
  };
}

/**
 * Day-folders (`YYYY/MM/DD`) whose LOCAL date is on or after `fromMs`'s day,
 * newest first, as `{ dir, dayMs }` with RESOLVED paths. Local links and
 * junctions are followed (a sessions tree junctioned to another drive works); a
 * directory that resolves to the network is refused (`resolveLocalDir`, review
 * F7). Names that are not a date are ignored.
 *
 * `onUnread(key, range)` is told about every directory in range that exists but
 * was refused or could not be listed, with the `unreadRange` its rollouts could
 * cover (ADR-002 A3.15). A directory that is simply absent is not unread.
 */
function dayDirsSince(sessionsDir, fromMs, now, onUnread = () => {}) {
  const out = [];
  const root = sessionsDir ? resolveLocalDir(sessionsDir) : null;
  if (!root) {
    if (sessionsDir && isRefusedDir(sessionsDir)) onUnread(sessionsDir, unreadRange(NaN, NaN, now));
    return out;
  }
  const fromDay = localDayStart(fromMs);
  const fromYear = new Date(fromDay).getFullYear();
  for (const y of digitNames(root, 4, () => onUnread(root, unreadRange(NaN, NaN, now)))) {
    if (Number(y) < fromYear) break;
    const year = unreadRange(new Date(Number(y), 0, 1).getTime(), new Date(Number(y), 11, 31).getTime(), now);
    const yKey = path.join(root, y);
    const yDir = resolveLocalDir(yKey);
    if (!yDir) {
      if (isRefusedDir(yKey)) onUnread(yKey, year);
      continue;
    }
    for (const m of digitNames(yDir, 2, () => onUnread(yDir, year))) {
      // Day 0 of the next month is this month's last day.
      const month = unreadRange(new Date(Number(y), Number(m) - 1, 1).getTime(), new Date(Number(y), Number(m), 0).getTime(), now);
      const mKey = path.join(yDir, m);
      const mDir = resolveLocalDir(mKey);
      if (!mDir) {
        if (isRefusedDir(mKey)) onUnread(mKey, month);
        continue;
      }
      for (const d of digitNames(mDir, 2, () => onUnread(mDir, month))) {
        const dayMs = folderDayMs(y, m, d);
        if (!Number.isFinite(dayMs) || dayMs < fromDay) continue;
        const dKey = path.join(mDir, d);
        const dDir = resolveLocalDir(dKey);
        if (dDir) out.push({ dir: dDir, dayMs });
        else if (isRefusedDir(dKey)) onUnread(dKey, unreadRange(dayMs, dayMs, now));
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
  const pre = ev.preSettings === true;
  const key = `${slot}|${ev.model}|${ev.tier}|${longContext ? 1 : 0}${writeFloor ? 1 : 0}${hasWrite ? 1 : 0}${pre ? 1 : 0}`;
  let b = buckets.get(key);
  if (!b) {
    b = {
      ts: slot,
      model: ev.model,
      tier: ev.tier,
      // Kept apart: whether these may be priced at Standard is decided per
      // scan from the rollout's eligibility, which a later record can change.
      ...(pre ? { preSettings: true } : {}),
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
  /**
   * Rollouts and directories in range that EXIST but could not be read — a
   * locked or access-denied file, a refused (network) or unlistable folder —
   * keyed by path, valued by the `unreadRange` their turns could cover
   * (ADR-002 A3.15). Rebuilt by every full walk; a changed-files scan updates
   * only the files it re-examines.
   * @type {Map<string, {fromMs:number, throughMs:number}>}
   */
  const unread = new Map();
  let lastUnread = null;

  /** Bring one rollout's cache entry up to date. Returns false when the file
   *  is gone or unusable (its entry is then dropped, and an unusable one is
   *  remembered in `unread`). `dayMs` is its folder's local date. */
  function refresh(file, stats, dayMs, now) {
    unread.delete(file);
    const prior = cache.get(file);
    // Where an unreadable rollout's turns can reach (review F2): its folder's
    // span, but never short of the latest turn already read from it — a resumed
    // session appends into its START folder — and through now if it grew since.
    const failedRange = () => {
      const r = unreadRange(dayMs, dayMs, now);
      if (prior && Number.isFinite(prior.maxTs)) r.throughMs = Math.max(r.throughMs, Math.min(prior.maxTs, now));
      return r;
    };
    let st;
    try {
      st = fs.lstatSync(file);
    } catch (err) {
      if (!(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'))) unread.set(file, failedRange());
      cache.delete(file);
      return false;
    }
    if (!st.isFile() || st.isSymbolicLink()) {
      cache.delete(file);
      return false;
    }
    stats.files += 1;
    let entry = prior;
    const unchanged = entry && entry.size === st.size && entry.mtimeMs === st.mtimeMs;
    if (unchanged) {
      settleDeadTail(file, entry, st.size, st.mtimeMs, now);
      return true;
    }
    const priorSize = prior ? prior.size : null;
    const priorMaxTs = prior ? prior.maxTs : null;
    const appended = entry && st.size > entry.size && endsAtLineBoundary(file, entry.offset);
    if (!appended) entry = freshEntry();
    const read = readForward(file, entry, st.size);
    if (read < 0) {
      // It was there a moment ago (lstat succeeded): locked or denied, and the
      // turns it held drop out of the figure. `prior` may have been advanced by
      // a partial append read, so its pre-read facts are used.
      const r = unreadRange(dayMs, dayMs, now);
      if (priorSize !== null && st.size !== priorSize) r.throughMs = now; // grew since its last read
      else if (Number.isFinite(priorMaxTs)) r.throughMs = Math.max(r.throughMs, Math.min(priorMaxTs, now));
      unread.set(file, r);
      cache.delete(file);
      return false;
    }
    stats.bytesRead += read;
    if (appended) stats.appended += 1;
    else stats.parsed += 1;
    entry.size = st.size;
    entry.mtimeMs = st.mtimeMs;
    entry.dayMs = dayMs;
    settleDeadTail(file, entry, st.size, st.mtimeMs, now);
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
      unread.clear();
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
        if (!dDir) {
          // Refused or gone; the next full walk drops its entry. Refused means
          // the rollout exists and was not read.
          const key = !root ? sessionsDir
            : !yDir ? path.join(root, m[1])
              : !mDir ? path.join(yDir, m[2])
                : path.join(mDir, m[3]);
          if (isRefusedDir(key)) unread.set(path.join(sessionsDir, String(rel)), unreadRange(dayMs, dayMs, now));
          continue;
        }
        refresh(path.join(dDir, m[4]), stats, dayMs, now);
      }
    } else {
      const seen = new Set();
      unread.clear();
      const onUnread = (key, range) => unread.set(key, range);
      for (const { dir, dayMs } of dayDirsSince(sessionsDir, fromMs, now, onUnread)) {
        let names;
        try {
          names = fs.readdirSync(dir);
        } catch (err) {
          if (!(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'))) unread.set(dir, unreadRange(dayMs, dayMs, now));
          continue;
        }
        for (const name of names) {
          if (!/^rollout-.*\.jsonl$/.test(name)) continue;
          const file = path.join(dir, name);
          if (refresh(file, stats, dayMs, now)) seen.add(file);
        }
      }
      // A rollout that disappeared, or aged out of the scanned range, is dropped.
      for (const file of cache.keys()) {
        if (!seen.has(file)) cache.delete(file);
      }
    }

    // The hull of every known-unread range (A3.15, A3.20). A hull can mark a
    // quiet gap between two unread ranges too: over-marking is allowed (A3.9).
    // The history already accepts a LIST of ranges, if this is ever refined.
    let hull = null;
    const reach = (fromMs, throughMs) => {
      if (!Number.isFinite(fromMs) || !Number.isFinite(throughMs)) return;
      if (hull === null) hull = { fromMs, throughMs };
      else {
        if (fromMs < hull.fromMs) hull.fromMs = fromMs;
        if (throughMs > hull.throughMs) hull.throughMs = throughMs;
      }
    };
    for (const r of unread.values()) reach(r.fromMs, r.throughMs);

    const out = [];
    const merged = new Map();
    for (const entry of cache.values()) {
      if (entry.droppedFromMs !== null) reach(entry.droppedFromMs, entry.droppedThroughMs);
      if (entry.droppedUntimed) {
        // No timestamp: from the folder date; through the next timestamped
        // record after it, never short of the folder's span — or now while no
        // record has followed it (review F2).
        const r = unreadRange(entry.dayMs, entry.dayMs, now);
        if (entry.untimedOpen) r.throughMs = now;
        else if (Number.isFinite(entry.untimedThroughMs)) r.throughMs = Math.max(r.throughMs, Math.min(entry.untimedThroughMs, now));
        reach(r.fromMs, r.throughMs);
      }
      // A3.17: a pre-settings turn may be priced at Standard only while every
      // tier this rollout has recorded — before OR after it — is assumable.
      const assumable = !entry.tierIneligible;
      // Backfill: in an assumable rollout, the turns before the first settings
      // record take the tier that record states. Codex re-emits that record with
      // unchanged values, so it states the tier the session was already on.
      // Measured on the owner's data: 51 of 573 turns, every rollout's records
      // all `default`. Without it those turns were an "assumed" floor.
      const backfill = assumable && (entry.firstTier === 'standard' || entry.firstTier === 'fast')
        ? entry.firstTier : null;
      const outOf = (b) => {
        if (!b.preSettings) return { ...b };
        if (!backfill) return { ...b, tierAssumable: assumable };
        const { preSettings: _pre, ...rest } = b;
        return { ...rest, tier: backfill };
      };
      foldOld(entry, rawSinceMs);
      for (const [key, b] of entry.buckets) {
        if (b.ts < startMs || b.ts >= now) continue;
        const outKey = b.preSettings ? `${key}|${assumable ? 1 : 0}|${backfill || ''}` : key;
        const m = merged.get(outKey);
        if (!m) {
          merged.set(outKey, outOf(b));
        } else {
          m.inputUncached += b.inputUncached;
          m.cachedInput += b.cachedInput;
          m.cacheWrite += b.cacheWrite;
          m.output += b.output;
          m.count += b.count;
        }
      }
      for (const ev of entry.events) {
        if (ev.ts >= startMs && ev.ts < now) out.push(ev.preSettings ? outOf(ev) : ev);
      }
    }
    for (const b of merged.values()) out.push(b);

    out.sort((a, b) => a.ts - b.ts);
    stats.ms = Date.now() - began;
    stats.cachedFiles = cache.size;
    stats.rawEvents = out.length - merged.size;
    stats.buckets = merged.size;
    lastStats = stats;
    // Never past `now`.
    lastUnread = hull === null ? null : { fromMs: Math.min(hull.fromMs, now), throughMs: Math.min(hull.throughMs, now) };
    return out;
  }

  return {
    scan,
    /** Counts and timings of the last scan. Numbers only — safe to log. */
    stats: () => lastStats,
    /**
     * After the last scan: the latest instant Codex turns it KNOWS it could not
     * read may carry, or null when it missed none (ADR-002 A3.15). A cost window
     * starting at or before it is missing usage.
     */
    unreadThroughMs: () => (lastUnread ? lastUnread.throughMs : null),
    /**
     * After the last scan: `{ fromMs, throughMs }`, the hull of every instant
     * range holding Codex turns it KNOWS it could not read, or null (ADR-002
     * A3.15, A3.20). A window or period overlapping it is missing usage.
     */
    unreadRange: () => (lastUnread ? { ...lastUnread } : null),
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
