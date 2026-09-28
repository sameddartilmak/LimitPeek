'use strict';
/**
 * Kimi Code TOKEN usage, read from the wire journals the tool writes itself
 * (ADR-003 Amendments 1, 3 and 6). Rung 1 only: no credential, no network, and
 * no price: Kimi publishes no per-token price for its plan (kimi/cost.js).
 *
 * WHERE THE FILES ARE (kimi-code 86e0820, 2026-09-17)
 * ---------------------------------------------------
 *   <home>/sessions/<workspaceId>/<sessionId>/agents/<agentId>/wire.jsonl
 * `<home>` is KIMI_CODE_HOME when set, else `~/.kimi-code`
 * (agent-core-v2 app/bootstrap/bootstrap.ts:173; bootstrapService.ts:45, 53;
 * workspaceInstanceManagerService.ts:201; sessionLifecycle/internal/addressing.ts:7-17;
 * wire/record.ts:3). Only files named EXACTLY `wire.jsonl` are read: a repaired
 * journal keeps its original as `wire.jsonl.bak` (wire/repair.ts:16-40), which
 * would count everything twice. `config.toml` in the same home can hold a
 * plaintext api_key and is never listed, opened or resolved.
 *
 * WHAT IS COUNTED
 * ---------------
 * One JSON object per line (persistence/backends/node-fs/appendLogStore.ts:301-304),
 * serialised with `type` first and `time` last (app/event/event2.ts:38-46):
 *   {"type":"usage.record","agentId","model","usage":{inputOther,output,
 *    inputCacheRead,inputCacheCreation,raw?},"usageScope","time":<epoch ms>}
 * (agent/usage/usageOps.ts:13-30, human/llm/usage.ts:1-7, docs/wire-manifest.d.ts:876-883).
 *
 *  - ONLY `usage.record`. `step.end` loop events repeat per-step usage inside
 *    `context.append_loop_event` records (agent/loop/loopService.ts:1782-1790)
 *    and are never decoded; summing both would double every figure.
 *  - ONLY records after the LAST `{"type":"forked"}` record of a file. A fork or
 *    child session COPIES the source's records into its own wire.jsonl and then
 *    appends the marker (sessionLifecycleService.ts:579-614, 720-735, 907-908),
 *    so everything before the marker was already counted in the source.
 *  - `model` is the config ALIAS as recorded (llmRequesterService.ts:477-482).
 *    Only `kimi-code/<id>` is the Kimi plan (oauth/src/managed-kimi-code.ts:11,
 *    224); anything else is another provider's model used through Kimi Code.
 *
 * PERFORMANCE AND PRIVACY
 * -----------------------
 * Same design as the Codex scanner: long-lived worker, per-file cache
 * by size + mtime, appended files read from their last complete line, raw records
 * for RAW_DAYS and UTC 15-minute buckets before. A line is decoded only when its
 * head names a `usage.record` or `forked` record; only the alias, the time and
 * four counts are kept; nothing read here is ever logged.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const log = require('../log');
const { resolveLocalDir, isRefusedDir, isNetworkPath } = require('../codex/rollout');
const { childDirs, childFiles } = require('../scan/local-tree');
const { readAppended, settleTail, tailBytes, isAppendOf } = require('../scan/append-reader');
const { capModels } = require('../scan/model-cap');

const LABEL = 'kimi sessions';
const DAY_MS = 24 * 60 * 60 * 1000;
const RAW_DAYS = 8;
const BUCKET_MS = 15 * 60 * 1000;
const WIRE_FILE = 'wire.jsonl';
/**
 * Warm scans reuse each session's file list (ADR-003 A6 ruling on F5): the
 * workspace directories are listed every scan (new and removed sessions are seen
 * at once) and every known wire.jsonl is lstat-ed (appends are seen at once),
 * but a session's agents subtree is listed again only when one of its files
 * changed or vanished, or on a full walk at most FULL_WALK_MS apart. A subagent
 * added to a session with no other activity is therefore picked up within
 * FULL_WALK_MS; one added while the session is active (the usual case: its
 * parent's journal is being appended) is picked up at once.
 */
const FULL_WALK_MS = 5 * 60 * 1000;

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
const HEAD_USAGE = /^\{\s*"type"\s*:\s*"usage\.record"/;
const HEAD_FORKED = /^\{\s*"type"\s*:\s*"forked"/;
const TAIL_TIME = /"time"\s*:\s*(\d{1,16})\s*\}\s*$/;

let networkHomeWarned = false;

/** `KIMI_CODE_HOME` or `~/.kimi-code`, or null when that is a network path. */
function kimiHome(home) {
  const dir = home || process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
  if (isNetworkPath(dir)) {
    if (!networkHomeWarned) {
      networkHomeWarned = true;
      log.warn('kimi home is a network or device path; Kimi Code is treated as not found');
    }
    return null;
  }
  return dir;
}

/** Is `alias` the Kimi plan (`kimi-code/<id>`)? */
function isKimiPlanAlias(alias) {
  return typeof alias === 'string' && alias.startsWith('kimi-code/') && alias.length > 'kimi-code/'.length;
}

function count(v) {
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
}

function freshEntry() {
  return {
    size: 0,
    mtimeMs: 0,
    birthMs: NaN,
    offset: 0,
    minTs: null,
    maxTs: null,
    forks: 0,
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

/** Everything read so far was copied from the fork source: start over. */
function resetAtFork(entry) {
  entry.forks += 1;
  entry.events = [];
  entry.buckets = new Map();
  entry.droppedFromMs = null;
  entry.droppedThroughMs = null;
  entry.droppedUntimed = false;
}

function consumeLine(entry, line, startMs) {
  if (line.length === 0) return;
  const head = line.toString('utf8', 0, Math.min(line.length, 64));
  const isUsage = HEAD_USAGE.test(head);
  if (!isUsage && !HEAD_FORKED.test(head)) return;
  let rec;
  try {
    rec = JSON.parse(line.toString('utf8'));
  } catch {
    if (isUsage) {
      const m = TAIL_TIME.exec(line.toString('utf8', Math.max(0, line.length - 64)));
      noteDropped(entry, m ? Number(m[1]) : NaN);
    }
    return;
  }
  if (!rec || typeof rec !== 'object') return;
  if (rec.type === 'forked') {
    resetAtFork(entry);
    return;
  }
  if (rec.type !== 'usage.record') return;
  const ts = typeof rec.time === 'number' && Number.isFinite(rec.time) ? rec.time : NaN;
  const u = rec.usage;
  const c = u && typeof u === 'object' && !Array.isArray(u)
    ? { input: count(u.inputOther), output: count(u.output), cacheRead: count(u.inputCacheRead), cacheWrite: count(u.inputCacheCreation) }
    : null;
  if (!Number.isFinite(ts) || c === null || Object.values(c).some((v) => v === null)) {
    noteDropped(entry, ts);
    return;
  }
  noteTs(entry, ts);
  if (ts < startMs) return;
  if (c.input === 0 && c.output === 0 && c.cacheRead === 0 && c.cacheWrite === 0) return;
  const model = typeof rec.model === 'string' && MODEL_ID.test(rec.model) ? rec.model : 'unknown';
  entry.events.push({ ts, model, ...c });
}

function foldInto(buckets, ev) {
  const slot = Math.floor(ev.ts / BUCKET_MS) * BUCKET_MS;
  const key = `${slot}|${ev.model}`;
  let b = buckets.get(key);
  if (!b) {
    b = { ts: slot, model: ev.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, count: 0 };
    buckets.set(key, b);
  }
  b.input += ev.input;
  b.output += ev.output;
  b.cacheRead += ev.cacheRead;
  b.cacheWrite += ev.cacheWrite;
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

function createKimiUsageScanner() {
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

  /** session dir -> { files, unread: Map } from its last listing. */
  const sessions = new Map();
  let lastFullWalkAt = null;
  let lastRoot = null;

  /** List one session's agents/<id>/wire.jsonl files, remembering listing failures. */
  function walkSession(sessionDir, now) {
    const own = new Map();
    const markUnread = (key) => () => own.set(key, { fromMs: 0, throughMs: now });
    const files = [];
    for (const agents of childDirs(sessionDir, lastRoot, markUnread(sessionDir), (n) => n === 'agents')) {
      for (const agent of childDirs(agents.dir, lastRoot, markUnread(agents.dir))) {
        for (const name of childFiles(agent.dir, markUnread(agent.dir), (n) => n === WIRE_FILE)) {
          files.push(path.join(agent.dir, name));
        }
      }
    }
    const entry = { files: files.sort(), unread: own };
    sessions.set(sessionDir, entry);
    return entry;
  }

  /** The session directories under the sessions root (workspace dirs listed every scan). */
  function sessionDirs(sessionsDir, now, stats) {
    const root = resolveLocalDir(sessionsDir, LABEL);
    if (!root) {
      if (isRefusedDir(sessionsDir)) unread.set(sessionsDir, { fromMs: 0, throughMs: now });
      sessions.clear();
      lastRoot = null;
      return [];
    }
    const full = lastFullWalkAt === null || root !== lastRoot || now < lastFullWalkAt || now - lastFullWalkAt >= FULL_WALK_MS;
    // Links are followed only at this root (ADR-003 A6 review rulings).
    lastRoot = root;
    if (full) {
      sessions.clear();
      lastFullWalkAt = now;
      lastRoot = root;
      stats.fullWalk = true;
    }
    const markUnread = (key) => () => unread.set(key, { fromMs: 0, throughMs: now });
    const out = [];
    for (const ws of childDirs(root, root, markUnread(root))) {
      for (const session of childDirs(ws.dir, root, markUnread(ws.dir))) out.push(session.dir);
    }
    const present = new Set(out);
    for (const dir of sessions.keys()) if (!present.has(dir)) sessions.delete(dir);
    return out;
  }

  /**
   * Every counted Kimi usage record with `startMs <= ts < now`: raw records since
   * `rawSinceMs`, UTC 15-minute buckets (with `count`) before.
   *
   * @param {{now?:number, startMs?:number, home?:string, rawSinceMs?:number}} [options]
   *   `home` overrides the Kimi Code home directory (tests).
   */
  function scan(options = {}) {
    const began = Date.now();
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const startMs = Number.isFinite(options.startMs) ? options.startMs : now - 7 * DAY_MS;
    const rawSinceMs = Number.isFinite(options.rawSinceMs) ? options.rawSinceMs : now - RAW_DAYS * DAY_MS;
    const stats = { files: 0, parsed: 0, appended: 0, bytesRead: 0, ms: 0, cacheReset: false };

    if (rawSinceMs < foldedTo) {
      cache.clear();
      stats.cacheReset = true;
    }
    foldedTo = rawSinceMs;

    unread.clear();
    stats.fullWalk = false;
    stats.sessionsListed = 0;
    const home = kimiHome(options.home);
    const dirs = home ? sessionDirs(path.join(home, 'sessions'), now, stats) : [];
    if (!home) sessions.clear();
    const seen = new Set();

    /** Bring one file up to date. Returns true when it changed or vanished. */
    const processFile = (file) => {
      seen.add(file);
      const prior = cache.get(file);
      let st;
      try {
        st = fs.lstatSync(file);
      } catch (err) {
        if (!(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'))) unread.set(file, rangeOf(prior, null, now, false));
        cache.delete(file);
        return true;
      }
      if (!st.isFile() || st.isSymbolicLink()) {
        cache.delete(file);
        return true;
      }
      stats.files += 1;
      const consume = (entry) => (line) => consumeLine(entry, line, startMs);
      // Only a line whose HEAD names a usage record is lost usage (review F5).
      const oversize = (entry) => (head) => {
        if (HEAD_USAGE.test(head.toString('utf8', 0, Math.min(head.length, 64)))) noteDropped(entry, NaN);
      };
      if (prior && prior.size === st.size && prior.mtimeMs === st.mtimeMs) {
        const before = prior.offset;
        settleTail(file, prior, st.size, st.mtimeMs, now, consume(prior), oversize(prior));
        if (prior.offset !== before) prior.tail = tailBytes(file, prior.offset);
        return false;
      }
      const appended = prior && st.size > prior.size && isAppendOf(file, prior);
      const entry = appended ? prior : freshEntry();
      const read = readAppended(file, entry, st.size, consume(entry), oversize(entry));
      if (read < 0) {
        unread.set(file, rangeOf(prior || entry, st, now, Boolean(prior) && prior.size !== st.size));
        cache.delete(file);
        return true;
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
      return true;
    };

    for (const dir of dirs) {
      let tree = sessions.get(dir);
      if (!tree) {
        tree = walkSession(dir, now);
        stats.sessionsListed += 1;
        for (const file of tree.files) processFile(file);
      } else {
        let dirty = false;
        for (const file of tree.files) if (processFile(file)) dirty = true;
        if (dirty) {
          // Activity here: list the subtree again for new or removed agents.
          tree = walkSession(dir, now);
          stats.sessionsListed += 1;
          for (const file of tree.files) if (!seen.has(file)) processFile(file);
        }
      }
      for (const [key, r] of tree.unread) unread.set(key, r);
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
          m.output += b.output;
          m.cacheRead += b.cacheRead;
          m.cacheWrite += b.cacheWrite;
          m.count += b.count;
        }
      }
      for (const ev of entry.events) if (ev.ts >= startMs && ev.ts < now) out.push(ev);
    }
    for (const b of merged.values()) out.push(b);
    out.sort((a, b) => a.ts - b.ts);
    // At most MAX_MODELS aliases; the rest is 'unknown' and a known gap (security F4).
    const capped = capModels(out);
    if (capped.overflow) reach(capped.overflow);

    stats.ms = Date.now() - began;
    stats.cachedFiles = cache.size;
    stats.rawEvents = out.length - merged.size;
    stats.buckets = merged.size;
    stats.modelsCapped = capped.overflow !== null;
    lastStats = stats;
    lastUnread = hull === null ? null : { fromMs: Math.min(hull.fromMs, now), throughMs: Math.min(hull.throughMs, now) };
    return capped.events;
  }

  return {
    scan,
    stats: () => lastStats,
    unreadRange: () => (lastUnread ? { ...lastUnread } : null),
  };
}

function kimiUsageEvents(options = {}) {
  return createKimiUsageScanner().scan(options);
}

/** Sum a window into the row's TokenBreakdown (`billable` = input + output + cacheWrite). */
function sumKimiTokens(events, startMs, endMs) {
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
  createKimiUsageScanner,
  kimiUsageEvents,
  sumKimiTokens,
  kimiHome,
  isKimiPlanAlias,
  RAW_DAYS,
  BUCKET_MS,
  _resetForTests,
};
