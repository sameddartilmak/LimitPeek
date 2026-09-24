'use strict';
/**
 * Antigravity TOKEN usage, read from the per-conversation SQLite stores the
 * products write themselves. Rung 1 only: no credential, no network. The same
 * design as the Gemini CLI reader (gemini/usage.js), held in a long-lived
 * worker (antigravity/scan-worker.js) behind the same LocalUsageChannel.
 *
 * WHERE THE FILES ARE (verified on a live machine, 2026-09-24)
 * ------------------------------------------------------------
 *   <home>/.gemini/{antigravity-cli, antigravity-ide, antigravity}/conversations/<uuid>.db
 * One store per conversation, possibly in WAL mode (`-wal` / `-shm` beside it,
 * and the newest steps may live only in the WAL). `<uuid>.pb` files in the same
 * directories are ENCRYPTED older conversations: never listed past their name,
 * never opened. Nothing else under `.gemini` is listed (paths.js).
 *
 * WHAT IS READ, AND NOTHING ELSE
 * ------------------------------
 * Two queries, each naming one column, on a read-only handle:
 *   SELECT metadata FROM steps          one protobuf blob per step
 *   SELECT data FROM gen_metadata       only to name the model of a response
 * No `SELECT *`, no other table or column: the conversation text lives in
 * the same stores and is never selected.
 *
 * steps.metadata, the two fields decoded (the others are skipped by length):
 *    1  creation time  { 1: seconds varint, 2: nanos varint }
 *    9  usage          { 1: model enum, 2: input tokens EXCLUDING cache reads,
 *                        3: output tokens (= thinking + response), 4: cache
 *                        write (never seen), 5: cache-read tokens, 6: provider
 *                        enum, 7: message id, 8: session key/value, 9: thinking
 *                        tokens, 10: response tokens, 11: response id }
 * A step without field 9 is not a model call and is skipped. Usage fields 7
 * and 8 are never decoded, compared or kept; field 8 carries a session key.
 * proto3 omits a zero, so an absent count reads 0.
 *
 * gen_metadata.data: field 1 -> 19 is the model name, and field 1 -> 4 is the
 * same usage message, whose field 11 maps a response id to that name. Field 8
 * (an opaque encrypted blob) is never read at any level. A response the table
 * does not name falls back to MODEL_ENUMS below; an enum missing there is
 * 'unknown', which is always unpriced (antigravity/cost.js), never guessed.
 *
 * STRICT, AS ide-quota.js IS (GUARD 3a)
 * -------------------------------------
 * This is a field-numbered wire format, so it fails OPEN: renumber a field and
 * the bytes still decode. Every field that is read is therefore held to its
 * wire type and to appearing once; the usage message may carry no field
 * outside the eleven above; and when thinking (9) and response (10) are both
 * present, output (3) must be their sum. A step that fails any of this is
 * REFUSED and counted as usage known unread (ADR-002 A3.15): the cost block
 * then says the source is incomplete instead of presenting a partial count as
 * whole. A cache write (field 4) has never been seen; when present it is kept
 * as `cacheWrite` and priced as antigravity/cost.js states.
 *
 * DEDUPE ON RESPONSE ID, GLOBALLY
 * -------------------------------
 * Field 11 is the key across every store and every root: a response is counted
 * once, from the first store that carries it in sorted path order.
 *
 * PERFORMANCE AND PRIVACY
 * -----------------------
 * One parsed entry per store, reused while the size and mtime of BOTH the
 * `.db` and its `-wal` are unchanged, so an idle rescan opens nothing. Raw
 * events for the last RAW_DAYS, older ones folded into UTC 15-minute buckets
 * on the way out. Only the time, the model, four counts and the response id
 * (for the dedupe; never posted) are kept; nothing read here is ever logged.
 */

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const log = require('../log');
const paths = require('../paths');
const { resolveLocalDir, isRefusedDir, isNetworkPath } = require('../codex/rollout');
const { childFiles } = require('../scan/local-tree');
const { capModels } = require('../scan/model-cap');
const { decodeMessage, all, WireError, WIRE } = require('./protobuf');
const { loadSqlite } = require('./sqlite');
const { LONG_PROMPT_TOKENS } = require('../gemini/pricing');

const LABEL = 'antigravity conversations';
const DAY_MS = 24 * 60 * 60 * 1000;
const RAW_DAYS = 8;
const BUCKET_MS = 15 * 60 * 1000;

/** `<uuid>.db` and nothing else: not the `.pb`, not the `-wal` / `-shm`. */
const STORE_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.db$/i;
/** A model id is shown verbatim in the UI, so it is held to an id's shape. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
/** A response id: bounded, printable, never shown. */
const RESPONSE_ID = /^[\x21-\x7e]{1,128}$/;
/** A step's creation instant must be a plausible unix second. */
const TS_MIN_MS = Date.parse('2020-01-01T00:00:00Z');
const TS_MAX_MS = Date.parse('2100-01-01T00:00:00Z');

/**
 * Model enum -> id, used only when gen_metadata does not name the response.
 * Each pair was seen in gen_metadata on a live machine (2026-09-24);
 * 'gemini-pro-default' is the name recorded there, not a published model id,
 * and has no price row. Enums seen without a name (1050, 1018, 330) are
 * deliberately absent: they read 'unknown'.
 */
const MODEL_ENUMS = Object.freeze({
  1318: 'gemini-3.8-flash',
  1026: 'claude-opus-4-6-thinking',
  1016: 'gemini-pro-default',
});

/** Field numbers of steps.metadata and of the usage message inside it. */
const F = {
  STEP_CREATED: 1,
  STEP_USAGE: 9,
  TS_SECONDS: 1,
  TS_NANOS: 2,
  U_MODEL: 1,
  U_INPUT: 2,
  U_OUTPUT: 3,
  U_CACHE_WRITE: 4,
  U_CACHE_READ: 5,
  U_PROVIDER: 6,
  U_MESSAGE_ID: 7,
  U_SESSION: 8,
  U_THINKING: 9,
  U_RESPONSE: 10,
  U_RESPONSE_ID: 11,
  G_ENTRY: 1,
  G_USAGE: 4,
  G_MODEL_NAME: 19,
};

/** Every field the usage message may carry, with its wire type. */
const USAGE_FIELDS = new Map([
  [F.U_MODEL, WIRE.VARINT],
  [F.U_INPUT, WIRE.VARINT],
  [F.U_OUTPUT, WIRE.VARINT],
  [F.U_CACHE_WRITE, WIRE.VARINT],
  [F.U_CACHE_READ, WIRE.VARINT],
  [F.U_PROVIDER, WIRE.VARINT],
  [F.U_MESSAGE_ID, WIRE.LEN],
  [F.U_SESSION, WIRE.LEN],
  [F.U_THINKING, WIRE.VARINT],
  [F.U_RESPONSE, WIRE.VARINT],
  [F.U_RESPONSE_ID, WIRE.LEN],
]);

let networkHomeWarned = false;

/** `<OS home>/.gemini`, or null when that is a network path. */
function antigravityUsageRoot(home) {
  const dir = home || paths.antigravityDataRoot();
  if (isNetworkPath(dir)) {
    if (!networkHomeWarned) {
      networkHomeWarned = true;
      log.warn('antigravity data home is a network or device path; its usage is treated as not found');
    }
    return null;
  }
  return dir;
}

/**
 * The first conversation directory that exists (unresolved), or null. What
 * "Antigravity usage is on this machine" means to the collector's channel.
 */
function antigravityUsageInstallDir(home) {
  const root = antigravityUsageRoot(home);
  if (!root) return null;
  for (const dir of paths.antigravityConversationDirs(root)) {
    if (resolveLocalDir(dir, LABEL)) return dir;
  }
  return null;
}

/** A varint field that appears at most once, as a safe integer; 0 when absent. */
function countField(fields, field) {
  const hits = fields.filter((f) => f.field === field);
  if (hits.length === 0) return 0;
  if (hits.length > 1) throw new WireError(`field ${field} repeated`);
  const n = Number(hits[0].value);
  if (!Number.isSafeInteger(n) || n < 0) throw new WireError(`field ${field} out of range`);
  return n;
}

/** The creation instant of a step, in ms. @throws {WireError} */
function createdMs(buf) {
  const fields = decodeMessage(buf);
  for (const f of fields) {
    if ((f.field !== F.TS_SECONDS && f.field !== F.TS_NANOS) || f.wire !== WIRE.VARINT) {
      throw new WireError('timestamp shape');
    }
  }
  const seconds = countField(fields, F.TS_SECONDS);
  const nanos = countField(fields, F.TS_NANOS);
  if (nanos >= 1e9) throw new WireError('timestamp nanos');
  const ms = seconds * 1000 + Math.floor(nanos / 1e6);
  if (ms < TS_MIN_MS || ms > TS_MAX_MS) throw new WireError('timestamp not a plausible instant');
  return ms;
}

/**
 * The usage message of one step, as the counts this reader keeps.
 * Fields 7 and 8 are checked for their wire type only, never decoded.
 * @throws {WireError}
 */
function usageOf(buf) {
  const fields = decodeMessage(buf);
  const seen = new Set();
  for (const f of fields) {
    const wire = USAGE_FIELDS.get(f.field);
    if (wire === undefined) throw new WireError(`usage field ${f.field} unexpected`);
    if (f.wire !== wire) throw new WireError(`usage field ${f.field} wire ${f.wire}`);
    if (seen.has(f.field)) throw new WireError(`usage field ${f.field} repeated`);
    seen.add(f.field);
  }
  const idField = fields.find((f) => f.field === F.U_RESPONSE_ID);
  const id = idField ? idField.value.toString('utf8') : '';
  if (!RESPONSE_ID.test(id)) throw new WireError('response id');
  const output = countField(fields, F.U_OUTPUT);
  if (seen.has(F.U_THINKING) && seen.has(F.U_RESPONSE)
    && output !== countField(fields, F.U_THINKING) + countField(fields, F.U_RESPONSE)) {
    throw new WireError('output is not thinking + response');
  }
  return {
    id,
    modelEnum: countField(fields, F.U_MODEL),
    input: countField(fields, F.U_INPUT),
    output,
    cacheWrite: countField(fields, F.U_CACHE_WRITE),
    cacheRead: countField(fields, F.U_CACHE_READ),
  };
}

/**
 * One steps.metadata blob: null when the step is not a model call, a record
 * otherwise. @throws {WireError} for a model call it refuses.
 */
function stepRecord(buf) {
  const fields = decodeMessage(buf);
  const usage = fields.filter((f) => f.field === F.STEP_USAGE);
  if (usage.length === 0) return null;
  if (usage.length > 1) throw new WireError('usage repeated');
  if (usage[0].wire !== WIRE.LEN) throw new WireError('usage wire type');
  const created = fields.filter((f) => f.field === F.STEP_CREATED);
  if (created.length !== 1 || created[0].wire !== WIRE.LEN) throw new WireError('creation time');
  return { ts: createdMs(created[0].value), ...usageOf(usage[0].value) };
}

/**
 * Response id -> model name from one gen_metadata blob. An enrichment only: a
 * blob that does not have the expected shape names nothing, and the enum table
 * answers instead. Field 8 is skipped by length and never read.
 */
function collectNames(buf, names) {
  let top;
  try {
    top = decodeMessage(buf);
  } catch (err) {
    if (err instanceof WireError) return;
    throw err;
  }
  for (const entry of all(top, F.G_ENTRY, WIRE.LEN)) {
    try {
      const inner = decodeMessage(entry.value);
      const name = inner.filter((f) => f.field === F.G_MODEL_NAME);
      const usage = inner.filter((f) => f.field === F.G_USAGE);
      if (name.length !== 1 || usage.length !== 1 || name[0].wire !== WIRE.LEN || usage[0].wire !== WIRE.LEN) continue;
      const model = name[0].value.toString('utf8');
      if (!MODEL_ID.test(model)) continue;
      const ids = decodeMessage(usage[0].value).filter((f) => f.field === F.U_RESPONSE_ID && f.wire === WIRE.LEN);
      if (ids.length !== 1) continue;
      names.set(ids[0].value.toString('utf8'), model);
    } catch (err) {
      if (!(err instanceof WireError)) throw err;
    }
  }
}

function asBuffer(v) {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  return null;
}

/**
 * Reads one store, read-only.
 *
 * HOW IT IS OPENED DECIDES WHAT IT LEAVES BEHIND. A WAL-mode store opened with
 * a plain read-only handle makes SQLite CREATE an empty `-wal` and a `-shm`
 * beside it when they are not there (measured, 2026-09-24): files in another
 * program's data directory that this app put there. So:
 *   - no `-wal` on disk: every committed step is in the `.db` itself, and it
 *     is opened `immutable=1`, which creates nothing and takes no lock;
 *   - a `-wal` on disk: the newest steps may be only in it, and only a normal
 *     read-only handle sees them, through the `-shm` the writer already keeps.
 * A writer starting between the stat and the open can at worst make this one
 * read fail (reported unread) or see the older state; either way the stat
 * changed, so the next scan reads the store again.
 *
 * @returns {{records:Array, dropped:Array<number>}|{err:string}}
 */
function readStore(file, startMs, walOnDisk) {
  const sqlite = loadSqlite();
  if (!sqlite || typeof sqlite.DatabaseSync !== 'function') return { err: 'sqlite-unavailable' };
  let db = null;
  try {
    let location = file;
    if (!walOnDisk) {
      location = pathToFileURL(file);
      location.searchParams.set('immutable', '1');
    }
    db = new sqlite.DatabaseSync(location, { readOnly: true });
    const steps = db.prepare('SELECT metadata FROM steps').all();
    const names = new Map();
    let rows = [];
    try {
      rows = db.prepare('SELECT data FROM gen_metadata').all();
    } catch {
      // No names table: the enum fallback answers. Not a gap in the COUNTS.
      rows = [];
    }
    for (const row of rows) {
      const buf = row ? asBuffer(row.data) : null;
      if (buf) collectNames(buf, names);
    }
    rows = null;
    const records = [];
    // Instants of refused model calls; NaN when even the time was unreadable.
    const dropped = [];
    for (const row of steps) {
      const buf = row ? asBuffer(row.metadata) : null;
      if (!buf) continue;
      let rec;
      try {
        rec = stepRecord(buf);
      } catch (err) {
        if (!(err instanceof WireError)) throw err;
        dropped.push(droppedTs(buf));
        continue;
      }
      if (rec === null || rec.ts < startMs) continue;
      const named = names.get(rec.id);
      const model = named || MODEL_ENUMS[rec.modelEnum] || 'unknown';
      records.push({
        ts: rec.ts, id: rec.id, model, input: rec.input, cacheWrite: rec.cacheWrite, cacheRead: rec.cacheRead, output: rec.output,
      });
    }
    return { records, dropped };
  } catch (err) {
    // Locked, corrupt, or not the schema we know. Never propagate the message:
    // it can quote file contents.
    return { err: 'unreadable', code: (err && err.code) || 'UNKNOWN' };
  } finally {
    if (db) { try { db.close(); } catch { /* best effort */ } }
  }
}

/** The creation instant of a refused step when that part still reads, else NaN. */
function droppedTs(buf) {
  try {
    const created = decodeMessage(buf).filter((f) => f.field === F.STEP_CREATED && f.wire === WIRE.LEN);
    return created.length === 1 ? createdMs(created[0].value) : NaN;
  } catch {
    return NaN;
  }
}

/** size + mtime of a file, or null when it is not there. */
function statOrNull(file) {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() && !st.isSymbolicLink() ? st : null;
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    throw err;
  }
}

/** Fold one event into UTC 15-minute buckets keyed by slot + model + flag. */
function foldInto(buckets, ev) {
  const slot = Math.floor(ev.ts / BUCKET_MS) * BUCKET_MS;
  const key = `${slot}|${ev.model}|${ev.longPrompt ? 1 : 0}`;
  let b = buckets.get(key);
  if (!b) {
    b = { ts: slot, model: ev.model, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, longPrompt: ev.longPrompt === true, count: 0 };
    buckets.set(key, b);
  }
  b.input += ev.input;
  b.cacheWrite += ev.cacheWrite;
  b.cacheRead += ev.cacheRead;
  b.output += ev.output;
  b.count += 1;
}

function createAntigravityUsageScanner() {
  /** file -> { db, wal, startMs, birthMs, records, dropped } */
  const cache = new Map();
  let lastStats = null;
  let lastUnread = null;

  /** Every store in the three roots, in sorted path order. */
  function walk(root, now, unread) {
    const files = [];
    for (const dir of paths.antigravityConversationDirs(root)) {
      const resolved = resolveLocalDir(dir, LABEL);
      if (!resolved) {
        if (isRefusedDir(dir)) unread.push({ fromMs: 0, throughMs: now });
        continue;
      }
      const markUnread = () => unread.push({ fromMs: 0, throughMs: now });
      for (const name of childFiles(resolved, markUnread, (n) => STORE_FILE.test(n))) {
        files.push(path.join(resolved, name));
      }
    }
    files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return files;
  }

  /**
   * Every Antigravity model call with `startMs <= ts < now`, deduped by
   * response id: raw events since `rawSinceMs`, UTC 15-minute buckets (with
   * `count`) before.
   *
   * @param {{now?:number, startMs?:number, home?:string, rawSinceMs?:number}} [options]
   *   `home` overrides the `.gemini` directory itself (tests).
   */
  function scan(options = {}) {
    const began = Date.now();
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const startMs = Number.isFinite(options.startMs) ? options.startMs : now - 7 * DAY_MS;
    const rawSinceMs = Number.isFinite(options.rawSinceMs) ? options.rawSinceMs : now - RAW_DAYS * DAY_MS;
    const stats = { files: 0, parsed: 0, reused: 0, unreadable: 0, refused: 0, ms: 0 };
    const unread = [];

    const root = antigravityUsageRoot(options.home);
    const found = root ? walk(root, now, unread) : [];
    const seen = new Set(found);
    for (const file of cache.keys()) if (!seen.has(file)) cache.delete(file);

    for (const file of found) {
      const prior = cache.get(file);
      let st;
      let wal;
      try {
        st = statOrNull(file);
        wal = st ? statOrNull(`${file}-wal`) : null;
      } catch {
        unread.push(unreadRangeOf(prior, null, now));
        cache.delete(file);
        stats.unreadable += 1;
        continue;
      }
      if (!st) { cache.delete(file); continue; }
      stats.files += 1;
      const same = (a, b) => (a === null ? b === null : b !== null && a.size === b.size && a.mtimeMs === b.mtimeMs);
      const walKey = wal ? { size: wal.size, mtimeMs: wal.mtimeMs } : null;
      if (prior && same(prior.db, st) && same(prior.wal, walKey) && prior.startMs <= startMs) {
        stats.reused += 1;
        continue;
      }
      const read = readStore(file, startMs, wal !== null);
      if (read.err) {
        unread.push(unreadRangeOf(prior, st, now, wal));
        cache.delete(file);
        stats.unreadable += 1;
        continue;
      }
      stats.parsed += 1;
      cache.set(file, {
        db: { size: st.size, mtimeMs: st.mtimeMs },
        wal: walKey,
        startMs,
        birthMs: st.birthtimeMs,
        mtimeMs: Math.max(st.mtimeMs, wal ? wal.mtimeMs : 0),
        records: read.records,
        dropped: read.dropped,
      });
    }

    // Known-unread hull (ADR-002 A3.15, A3.20). Over-marking is allowed (A3.9).
    let hull = null;
    const reach = (r) => {
      if (!r || !Number.isFinite(r.fromMs) || !Number.isFinite(r.throughMs)) return;
      if (hull === null) hull = { fromMs: r.fromMs, throughMs: r.throughMs };
      else {
        hull.fromMs = Math.min(hull.fromMs, r.fromMs);
        hull.throughMs = Math.max(hull.throughMs, r.throughMs);
      }
    };
    for (const r of unread) reach(r);

    // Dedupe on the response id across every store, first in path order wins.
    const ids = new Set();
    const raw = [];
    const buckets = new Map();
    for (const file of found) {
      const entry = cache.get(file);
      if (!entry) continue;
      for (const ts of entry.dropped) {
        // A refused call older than anything reported is no gap in it.
        if (Number.isFinite(ts) && ts < startMs) continue;
        stats.refused += 1;
        if (Number.isFinite(ts)) reach({ fromMs: ts, throughMs: ts });
        else reach(unreadRangeOf(entry, null, now));
      }
      for (const rec of entry.records) {
        if (ids.has(rec.id)) continue;
        ids.add(rec.id);
        if (rec.ts < startMs || rec.ts >= now) continue;
        // The response id stays here: it is the dedupe key, never an output.
        const ev = {
          ts: rec.ts,
          model: rec.model,
          input: rec.input,
          cacheWrite: rec.cacheWrite,
          cacheRead: rec.cacheRead,
          output: rec.output,
          longPrompt: rec.input + rec.cacheRead > LONG_PROMPT_TOKENS,
        };
        if (ev.ts < rawSinceMs) foldInto(buckets, ev);
        else raw.push(ev);
      }
    }
    const out = raw.concat([...buckets.values()]);
    out.sort((a, b) => a.ts - b.ts);
    // At most MAX_MODELS model ids; the rest is 'unknown' and a known gap (security F4).
    const capped = capModels(out);
    if (capped.overflow) reach(capped.overflow);

    stats.modelsCapped = capped.overflow !== null;
    stats.ms = Date.now() - began;
    stats.cachedFiles = cache.size;
    stats.rawEvents = raw.length;
    stats.buckets = buckets.size;
    stats.ids = ids.size;
    lastStats = stats;
    lastUnread = hull === null ? null : { fromMs: Math.min(hull.fromMs, now), throughMs: Math.min(hull.throughMs, now) };
    return capped.events;
  }

  /** The instants a store we could not read may cover. */
  function unreadRangeOf(entry, st, now, wal) {
    const starts = [];
    if (entry && Number.isFinite(entry.birthMs) && entry.birthMs > 0) starts.push(entry.birthMs);
    if (st && Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0) starts.push(st.birthtimeMs);
    const fromMs = starts.length ? Math.min(...starts, now) : 0;
    let throughMs = entry && Number.isFinite(entry.mtimeMs) ? entry.mtimeMs : now;
    if (st && Number.isFinite(st.mtimeMs)) throughMs = Math.max(st.mtimeMs, wal && Number.isFinite(wal.mtimeMs) ? wal.mtimeMs : 0);
    return { fromMs, throughMs: Math.min(Math.max(throughMs, fromMs), now) };
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
function antigravityUsageEvents(options = {}) {
  return createAntigravityUsageScanner().scan(options);
}

/**
 * Sum a window into the row's TokenBreakdown. `input` is the uncached prompt,
 * `cacheRead` the cached prompt, `output` already includes thinking tokens.
 */
function sumAntigravityTokens(events, startMs, endMs) {
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

function _resetForTests() {
  networkHomeWarned = false;
}

module.exports = {
  createAntigravityUsageScanner,
  antigravityUsageEvents,
  sumAntigravityTokens,
  antigravityUsageRoot,
  antigravityUsageInstallDir,
  stepRecord,
  MODEL_ENUMS,
  RAW_DAYS,
  BUCKET_MS,
  F,
  _resetForTests,
};
