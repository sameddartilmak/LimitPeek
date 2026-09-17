'use strict';
/**
 * Gemini CLI TOKEN usage, read from the chat recordings the CLI writes itself
 * (ADR-003 Amendments 1, 3 and 6). Rung 1 only: no credential, no network.
 *
 * WHERE THE FILES ARE (gemini-cli 6a466a7, 2026-09-15)
 * ----------------------------------------------------
 *   <home>/.gemini/tmp/<project>/chats/session-<YYYY-MM-DDTHH-MM>-<id8>.jsonl
 *   <home>/.gemini/tmp/<project>/chats/<parentSessionId>/<sessionId>.jsonl   (subagents)
 *   <home>/.gemini/tmp/<project>/chats/session-*.json                         (legacy)
 * `<home>` is GEMINI_CLI_HOME when set, else the OS home (core/utils/paths.ts:22-28,
 * core/config/storage.ts:54-60, 195-197, 230-234; chatRecordingService.ts:479-519).
 *
 * The walk is exactly `tmp/*` -> `chats` -> files and `chats/*` -> files, names
 * ending `.jsonl` or `.json` only. `~/.gemini` also holds `oauth_creds.json`,
 * `google_accounts.json` and, on machines with Antigravity, that product's
 * data: none of it is listed, opened or resolved. `.unreadable-<ts>` backups
 * (chatRecordingService.ts:604-617) and `.tmp-<pid>` files do not match.
 *
 * WHAT A RECORD LOOKS LIKE
 * ------------------------
 * One JSON object per line (chatRecordingService.ts:559-573). A message record
 * is `{id, timestamp, type, content, ...}`; a `type:'gemini'` message may carry
 * `tokens: {input, output, cached, thoughts, tool, total}` and `model`
 * (chatRecordingTypes.ts:19-26, 72-82; chatRecordingService.ts:686-773).
 * `input` is promptTokenCount and INCLUDES `cached`.
 *
 * WHY DEDUPE ON MESSAGE ID, GLOBALLY
 * ----------------------------------
 *  - Every update re-appends the FULL message under the same id
 *    (chatRecordingService.ts:648-663), e.g. once without tokens and again with
 *    them (:744-773), or again when tool calls are added (:775-844).
 *  - A legacy `.json` session is migrated by appending its messages to a new
 *    `.jsonl` beside it and never deleting the `.json` (:436-460), so the same
 *    ids live in two files.
 * Tokens are therefore taken ONCE per id, from the first record that carries
 * valid tokens, across every file read. Files are read in sorted path order, so
 * which file "owns" an id is deterministic ('x.json' sorts before 'x.jsonl').
 *
 * WHAT IS IGNORED FOR ACCOUNTING
 * ------------------------------
 * `$rewindTo` (:931-951) is append-only: the rewound messages stay on disk and
 * were really sent, so they are counted. `$set` checkpoints (:642-646,
 * :1021-1030) re-list messages already recorded and are never decoded here.
 *
 * THE FIGURE IS A FLOOR
 * ---------------------
 * The CLI records tokens only after a successful stream (geminiChat.ts:1573-1641)
 * and never records its utility calls; see gemini/pricing.js rule 5.
 *
 * PERFORMANCE AND PRIVACY
 * -----------------------
 * Same design as the Codex scanner (codex/usage.js), held in a long-lived worker:
 * a per-file cache invalidated by size + mtime, appended files read from their
 * last complete line, raw messages for the last RAW_DAYS and older ones folded
 * into UTC 15-minute buckets. A line is decoded only when its bytes contain
 * `"tokens":{`; only the id, timestamp, model and six token counts are kept;
 * nothing read here is ever logged.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const log = require('../log');
const { resolveLocalDir, isRefusedDir, isNetworkPath } = require('../codex/rollout');
const { childDirs, childFiles } = require('../scan/local-tree');
const { readAppended, settleTail, tailBytes, isAppendOf, HEAD_BYTES } = require('../scan/append-reader');
const { capModels } = require('../scan/model-cap');
const { LONG_PROMPT_TOKENS } = require('./pricing');

const LABEL = 'gemini chats';
const DAY_MS = 24 * 60 * 60 * 1000;
const RAW_DAYS = 8;
const BUCKET_MS = 15 * 60 * 1000;
/** A legacy `.json` session is parsed whole; past this it is reported unread. */
const MAX_JSON_BYTES = 64 * 1024 * 1024;

/** A model id is shown verbatim in the UI, so it is held to an id's shape. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
/** A message id: the CLI writes randomUUID() or a history turn id. Bounded. */
const MESSAGE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const TOKENS_MARKER = Buffer.from('"tokens":{');
const HEAD_MESSAGE = /^\{\s*"id"\s*:/;
const HEAD_GEMINI = /"type"\s*:\s*"gemini"/;
const HEAD_TIMESTAMP = /"timestamp"\s*:\s*"([^"]{1,40})"/;
/**
 * The only names the CLI writes (ADR-003 A6 review rulings). In `chats/`: main
 * sessions `session-<ISO minute>-<id8>.jsonl` (chatRecordingService.ts:510-518)
 * and legacy `session-*.json` beside their migrated `.jsonl` (:436-437; listed
 * by cli/src/utils/sessionUtils.ts:420-424). In `chats/<safeParentId>/`: a
 * subagent's `<safeSessionId>.jsonl` (:484-512), where both ids pass
 * sanitizeFilenamePart, i.e. [A-Za-z0-9_-] (utils/fileUtils.ts:696-698).
 */
const MAIN_CHAT_FILE = /^session-[A-Za-z0-9_-]+\.jsonl?$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const SUBAGENT_CHAT_FILE = /^[A-Za-z0-9_-]{1,256}\.jsonl$/;
/** `session-2026-09-15T10-30-abcdef12.json[l]` (chatRecordingService.ts:499-518). */
const SESSION_NAME_TS = /^session-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-/;

let networkHomeWarned = false;

/**
 * A message id as a 53-bit number: the high 21 bits of 32-bit FNV-1a and a
 * second, independently seeded 32-bit multiply-xorshift hash over the UTF-16
 * code units. The dedupe map holds numbers, not id strings (ADR-003 A6 Phase A
 * ruling): on the synthetic year corpus this cut the worker heap by ~28 MB.
 *
 * A collision can only make two different messages look like one, so the
 * second is DROPPED (an undercount), never double counted. Every Gemini figure is
 * already a floor ("en az", unrecorded calls), so the claim stays true. For
 * 160,000 ids the chance of any collision is about 1.4e-6.
 */
function hashId(s) {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
    h2 ^= h2 >>> 15;
  }
  return (h1 >>> 11) * 4294967296 + (h2 >>> 0);
}

/** `<GEMINI_CLI_HOME or OS home>/.gemini`, or null when that is a network path. */
function geminiDir(home) {
  const dir = home || path.join(process.env.GEMINI_CLI_HOME || os.homedir(), '.gemini');
  if (isNetworkPath(dir)) {
    if (!networkHomeWarned) {
      networkHomeWarned = true;
      log.warn('gemini home is a network or device path; Gemini is treated as not found');
    }
    return null;
  }
  return dir;
}

/** The chats root parent (`.gemini/tmp`), unresolved, or null. */
function geminiTmpDir(home) {
  const dir = geminiDir(home);
  return dir ? path.join(dir, 'tmp') : null;
}

/** A safe non-negative integer, or null. `optional` lets an ABSENT field read 0. */
function count(v, optional = false) {
  if (v === undefined && optional) return 0;
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** The six counts of a `tokens` object, or null when unusable. */
function tokensOf(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  const out = {
    input: count(t.input),
    output: count(t.output),
    cached: count(t.cached),
    // Optional in TokensSummary (chatRecordingTypes.ts:23-24).
    thoughts: count(t.thoughts, true),
    tool: count(t.tool, true),
  };
  return Object.values(out).some((v) => v === null) ? null : out;
}

function freshEntry(kind, startMs) {
  return {
    kind, // 'jsonl' | 'json'
    size: 0,
    mtimeMs: 0,
    birthMs: NaN,
    offset: 0,
    startMs, // from the file name, or NaN
    minTs: null,
    maxTs: null,
    // Some id this file carries was already owned by another file.
    skippedDup: false,
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

function fileStartMs(name) {
  const m = SESSION_NAME_TS.exec(name);
  if (!m) return NaN;
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:00.000Z`);
  return Number.isFinite(ms) ? ms : NaN;
}

/** Fold one raw message into `buckets`: UTC 15-minute slot + model + flags. */
function foldInto(buckets, ev) {
  const slot = Math.floor(ev.ts / BUCKET_MS) * BUCKET_MS;
  const hasTool = ev.tool > 0 || ev.hasTool === true;
  const key = `${slot}|${ev.model}|${ev.noModel ? 1 : 0}${ev.longPrompt ? 1 : 0}${hasTool ? 1 : 0}`;
  let b = buckets.get(key);
  if (!b) {
    b = {
      ts: slot,
      model: ev.model,
      ...(ev.noModel ? { noModel: true } : {}),
      input: 0,
      cached: 0,
      output: 0,
      thoughts: 0,
      tool: 0,
      longPrompt: ev.longPrompt === true,
      hasTool,
      count: 0,
    };
    buckets.set(key, b);
  }
  b.input += ev.input;
  b.cached += ev.cached;
  b.output += ev.output;
  b.thoughts += ev.thoughts;
  b.tool += ev.tool;
  b.count += Number.isSafeInteger(ev.count) && ev.count > 0 ? ev.count : 1;
}

function foldOld(entry, rawSinceMs) {
  if (entry.events.length === 0) return;
  let any = false;
  for (const ev of entry.events) if (ev.ts < rawSinceMs) { any = true; break; }
  if (!any) return;
  const keep = [];
  for (const ev of entry.events) {
    if (ev.ts < rawSinceMs) foldInto(entry.buckets, ev);
    else keep.push(ev);
  }
  entry.events = keep;
}

/**
 * hashId -> owning file, as an open-addressing table over typed arrays: a
 * Float64Array of 53-bit keys and an Int32Array of owner indexes (0 empty, -1
 * deleted). No per-entry objects, so 160,000 ids cost a few MB and no GC work.
 * Files are interned to small integers; release() is a linear sweep, which only
 * runs when a file is removed, rewritten or unreadable.
 */
function createOwnerTable() {
  let cap = 1 << 16;
  let keys = new Float64Array(cap);
  let slots = new Int32Array(cap);
  let size = 0;
  let used = 0; // live + deleted slots
  const fileIndex = new Map();
  const files = [null];

  const indexOf = (file) => {
    let i = fileIndex.get(file);
    if (i === undefined) {
      i = files.length;
      files.push(file);
      fileIndex.set(file, i);
    }
    return i;
  };

  function find(key) {
    let i = key % cap;
    for (;;) {
      const s = slots[i];
      if (s === 0) return -1;
      if (s > 0 && keys[i] === key) return i;
      i = (i + 1) & (cap - 1);
    }
  }

  function grow() {
    const oldKeys = keys;
    const oldSlots = slots;
    if (size * 2 >= cap) cap *= 2;
    keys = new Float64Array(cap);
    slots = new Int32Array(cap);
    used = size;
    for (let j = 0; j < oldSlots.length; j += 1) {
      if (oldSlots[j] <= 0) continue;
      let i = oldKeys[j] % cap;
      while (slots[i] !== 0) i = (i + 1) & (cap - 1);
      keys[i] = oldKeys[j];
      slots[i] = oldSlots[j];
    }
  }

  return {
    get(key) {
      const i = find(key);
      return i === -1 ? undefined : files[slots[i]];
    },
    set(key, file) {
      if ((used + 1) * 10 > cap * 7) grow();
      let i = key % cap;
      while (slots[i] > 0) i = (i + 1) & (cap - 1);
      if (slots[i] === 0) used += 1;
      keys[i] = key;
      slots[i] = indexOf(file);
      size += 1;
    },
    /** Delete every id owned by a file in `set`. Returns true when any was. */
    release(set) {
      const idx = new Set();
      for (const file of set) {
        const i = fileIndex.get(file);
        if (i !== undefined) idx.add(i);
      }
      if (idx.size === 0) return false;
      let any = false;
      for (let i = 0; i < cap; i += 1) {
        if (slots[i] > 0 && idx.has(slots[i])) {
          slots[i] = -1;
          size -= 1;
          any = true;
        }
      }
      return any;
    },
    clear() {
      cap = 1 << 16;
      keys = new Float64Array(cap);
      slots = new Int32Array(cap);
      size = 0;
      used = 0;
    },
    get size() { return size; },
  };
}

function createGeminiUsageScanner() {
  /** @type {Map<string, ReturnType<typeof freshEntry>>} */
  const cache = new Map();
  /** hashId(message id) -> the file that owns its tokens (global dedupe). */
  const owners = createOwnerTable();
  /** Files and directories that exist but could not be read -> instant range. */
  const unread = new Map();
  let lastStats = null;
  let lastUnread = null;
  let foldedTo = -Infinity;
  /** Ids were released during pass 2 (a read failed): files that skipped an id
   *  owned elsewhere are re-read on the next scan, so no id is lost for good. */
  let rescanSkippers = false;

  /** Forget every id `file` owns. Returns true when any was released. */
  function release(files) {
    if (files.size === 0) return false;
    return owners.release(files);
  }

  /**
   * One message record (already parsed) from `file`. Claims its id and records
   * its tokens once. `startMs` bounds what is kept at all.
   */
  function consumeMessage(file, entry, rec, startMs) {
    if (!rec || typeof rec !== 'object' || rec.type !== 'gemini') return;
    if (rec.tokens === null || rec.tokens === undefined) return;
    const ts = Date.parse(rec.timestamp);
    const t = tokensOf(rec.tokens);
    const id = typeof rec.id === 'string' && MESSAGE_ID.test(rec.id) ? hashId(rec.id) : null;
    if (t === null || id === null || !Number.isFinite(ts)) {
      // A gemini message that carries tokens we cannot count: known lost usage.
      noteDropped(entry, ts);
      return;
    }
    noteTs(entry, ts);
    if (ts < startMs) return;
    // A message whose every count is 0 carries no usage (review F6, as Kimi).
    if (t.input === 0 && t.output === 0 && t.cached === 0 && t.thoughts === 0 && t.tool === 0) return;
    const owner = owners.get(id);
    if (owner !== undefined) {
      if (owner !== file) entry.skippedDup = true;
      return; // tokens are taken once per id
    }
    owners.set(id, file);
    const rawModel = rec.model;
    const noModel = rawModel === undefined || rawModel === null || rawModel === '';
    const model = !noModel && typeof rawModel === 'string' && MODEL_ID.test(rawModel) ? rawModel : 'unknown';
    const ev = {
      ts,
      model,
      input: Math.max(0, t.input - t.cached),
      cached: Math.min(t.cached, t.input),
      output: t.output,
      thoughts: t.thoughts,
      tool: t.tool,
      longPrompt: t.input > LONG_PROMPT_TOKENS,
    };
    if (noModel) ev.noModel = true;
    entry.events.push(ev);
  }

  function onLine(file, entry, startMs) {
    return (line) => {
      if (line.length === 0 || line.indexOf(TOKENS_MARKER) === -1) return;
      const head = line.subarray(0, HEAD_BYTES).toString('utf8');
      if (!HEAD_MESSAGE.test(head)) return; // `$set` checkpoints and metadata
      let rec;
      try {
        rec = JSON.parse(line.toString('utf8'));
      } catch {
        // Never logged: the message could quote the line.
        if (HEAD_GEMINI.test(line.toString('utf8', 0, Math.min(line.length, 64 * 1024)))) {
          const m = HEAD_TIMESTAMP.exec(head);
          noteDropped(entry, m ? Date.parse(m[1]) : NaN);
        }
        return;
      }
      consumeMessage(file, entry, rec, startMs);
    };
  }

  function onOversize(entry) {
    return (head) => {
      const text = head.toString('utf8');
      if (!HEAD_MESSAGE.test(text) || !HEAD_GEMINI.test(text)) return;
      const m = HEAD_TIMESTAMP.exec(text);
      noteDropped(entry, m ? Date.parse(m[1]) : NaN);
    };
  }

  /** Reads a legacy whole-file `.json` session. Returns bytes or -1. */
  function readLegacy(file, entry, size, startMs) {
    if (size > MAX_JSON_BYTES) {
      noteDropped(entry, NaN);
      return 0;
    }
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return -1;
    }
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      noteDropped(entry, NaN);
      return Buffer.byteLength(text);
    }
    text = null;
    if (obj && typeof obj === 'object' && Array.isArray(obj.messages)) {
      for (const rec of obj.messages) consumeMessage(file, entry, rec, startMs);
    }
    entry.offset = size;
    return size;
  }

  function unreadRangeOf(entry, st, now, grew) {
    const starts = [];
    if (entry && Number.isFinite(entry.minTs)) starts.push(entry.minTs);
    if (entry && Number.isFinite(entry.startMs)) starts.push(entry.startMs);
    if (st && Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0) starts.push(st.birthtimeMs);
    const fromMs = starts.length ? Math.min(...starts, now) : 0;
    let throughMs = st && Number.isFinite(st.mtimeMs) ? st.mtimeMs : now;
    if (entry && Number.isFinite(entry.maxTs)) throughMs = Math.max(throughMs, entry.maxTs);
    if (grew) throughMs = now;
    return { fromMs, throughMs: Math.min(throughMs, now) };
  }

  /** Every chat file in the walk, sorted, as `{ file, name }`. */
  function walk(root, now) {
    const files = [];
    const tmp = resolveLocalDir(root, LABEL);
    if (!tmp) {
      if (isRefusedDir(root)) unread.set(root, { fromMs: 0, throughMs: now });
      return files;
    }
    const markUnread = (key) => () => unread.set(key, { fromMs: 0, throughMs: now });
    for (const project of childDirs(tmp, tmp, markUnread(tmp))) {
      for (const chats of childDirs(project.dir, tmp, markUnread(project.dir), (n) => n === 'chats')) {
        for (const name of childFiles(chats.dir, markUnread(chats.dir), (n) => MAIN_CHAT_FILE.test(n))) {
          files.push({ file: path.join(chats.dir, name), name });
        }
        for (const sub of childDirs(chats.dir, tmp, markUnread(chats.dir), (n) => SAFE_ID.test(n))) {
          for (const name of childFiles(sub.dir, markUnread(sub.dir), (n) => SUBAGENT_CHAT_FILE.test(n))) {
            files.push({ file: path.join(sub.dir, name), name });
          }
        }
      }
    }
    files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    return files;
  }

  /**
   * Every Gemini message with tokens and `startMs <= ts < now`, deduped by id:
   * raw messages since `rawSinceMs`, UTC 15-minute buckets (with `count`) before.
   *
   * @param {{now?:number, startMs?:number, home?:string, rawSinceMs?:number}} [options]
   *   `home` overrides the `.gemini` directory itself (tests).
   */
  function scan(options = {}) {
    const began = Date.now();
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const startMs = Number.isFinite(options.startMs) ? options.startMs : now - 7 * DAY_MS;
    const rawSinceMs = Number.isFinite(options.rawSinceMs) ? options.rawSinceMs : now - RAW_DAYS * DAY_MS;
    const stats = { files: 0, parsed: 0, appended: 0, bytesRead: 0, ms: 0, cacheReset: false };

    if (rawSinceMs < foldedTo) {
      cache.clear();
      owners.clear();
      stats.cacheReset = true;
    }
    foldedTo = rawSinceMs;

    unread.clear();
    const root = geminiTmpDir(options.home);
    const found = root ? walk(root, now) : [];
    if (!root) {
      cache.clear();
      owners.clear();
    }

    // Pass 1: what changed. Ownership of a file that is gone, unreadable or
    // re-read from scratch is released BEFORE anything is read, and a file that
    // skipped an id owned elsewhere is re-read so the id is counted exactly once.
    const plan = [];
    const released = new Set();
    const seen = new Set(found.map((f) => f.file));
    for (const file of cache.keys()) {
      if (!seen.has(file)) {
        released.add(file);
        cache.delete(file);
      }
    }
    for (const { file, name } of found) {
      const prior = cache.get(file);
      let st;
      try {
        st = fs.lstatSync(file);
      } catch (err) {
        if (!(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'))) unread.set(file, unreadRangeOf(prior, null, now, false));
        if (prior) { released.add(file); cache.delete(file); }
        continue;
      }
      if (!st.isFile() || st.isSymbolicLink()) {
        if (prior) { released.add(file); cache.delete(file); }
        continue;
      }
      stats.files += 1;
      const kind = name.endsWith('.jsonl') ? 'jsonl' : 'json';
      const unchanged = prior && prior.size === st.size && prior.mtimeMs === st.mtimeMs;
      let mode = 'fresh';
      if (unchanged) mode = 'unchanged';
      else if (prior && kind === 'jsonl' && st.size > prior.size && isAppendOf(file, prior)) mode = 'append';
      if (mode === 'fresh' && prior) released.add(file);
      plan.push({ file, name, st, kind, mode, prior });
    }
    if (release(released) || rescanSkippers) {
      rescanSkippers = false;
      for (const p of plan) {
        if (p.mode !== 'fresh' && p.prior && p.prior.skippedDup) p.mode = 'fresh';
      }
      // Their own ids go too, so the re-read reclaims them in path order.
      release(new Set(plan.filter((p) => p.mode === 'fresh' && p.prior).map((p) => p.file)));
    }

    // Pass 2: read, in sorted path order.
    for (const p of plan) {
      const { file, st, kind } = p;
      if (p.mode === 'unchanged') {
        if (kind === 'jsonl') {
          const before = p.prior.offset;
          settleTail(file, p.prior, st.size, st.mtimeMs, now, onLine(file, p.prior, startMs), onOversize(p.prior));
          if (p.prior.offset !== before) p.prior.tail = tailBytes(file, p.prior.offset);
        }
        continue;
      }
      const entry = p.mode === 'append' ? p.prior : freshEntry(kind, fileStartMs(p.name));
      const read = kind === 'jsonl'
        ? readAppended(file, entry, st.size, onLine(file, entry, startMs), onOversize(entry))
        : readLegacy(file, entry, st.size, startMs);
      if (read < 0) {
        unread.set(file, unreadRangeOf(p.prior || entry, st, now, Boolean(p.prior) && p.prior.size !== st.size));
        if (release(new Set([file]))) rescanSkippers = true;
        cache.delete(file);
        continue;
      }
      stats.bytesRead += read;
      if (p.mode === 'append') stats.appended += 1;
      else stats.parsed += 1;
      entry.size = st.size;
      entry.mtimeMs = st.mtimeMs;
      entry.birthMs = st.birthtimeMs;
      if (kind === 'jsonl') {
        settleTail(file, entry, st.size, st.mtimeMs, now, onLine(file, entry, startMs), onOversize(entry));
        entry.tail = tailBytes(file, entry.offset);
      }
      cache.set(file, entry);
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
    for (const r of unread.values()) reach(r);

    const out = [];
    const merged = new Map();
    for (const entry of cache.values()) {
      if (entry.droppedFromMs !== null) reach({ fromMs: entry.droppedFromMs, throughMs: entry.droppedThroughMs });
      if (entry.droppedUntimed) {
        reach(unreadRangeOf(entry, { birthtimeMs: entry.birthMs, mtimeMs: entry.mtimeMs }, now, false));
      }
      foldOld(entry, rawSinceMs);
      for (const [key, b] of entry.buckets) {
        if (b.ts < startMs || b.ts >= now) continue;
        const m = merged.get(key);
        if (!m) merged.set(key, { ...b });
        else {
          m.input += b.input;
          m.cached += b.cached;
          m.output += b.output;
          m.thoughts += b.thoughts;
          m.tool += b.tool;
          m.count += b.count;
        }
      }
      for (const ev of entry.events) {
        if (ev.ts >= startMs && ev.ts < now) out.push(ev);
      }
    }
    for (const b of merged.values()) out.push(b);
    out.sort((a, b) => a.ts - b.ts);
    // At most MAX_MODELS model ids; the rest is 'unknown' and a known gap (security F4).
    const capped = capModels(out);
    if (capped.overflow) reach(capped.overflow);

    stats.modelsCapped = capped.overflow !== null;
    stats.ms = Date.now() - began;
    stats.cachedFiles = cache.size;
    stats.rawEvents = out.length - merged.size;
    stats.buckets = merged.size;
    stats.ids = owners.size;
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
function geminiUsageEvents(options = {}) {
  return createGeminiUsageScanner().scan(options);
}

/**
 * Sum a window into the row's TokenBreakdown. `input` is the uncached prompt,
 * `cacheRead` the cached prompt, `output` includes thinking tokens (billed as
 * output). Tool-use prompt tokens have no slot and are not counted here; the
 * cost block names them as a floor cause instead.
 */
function sumGeminiTokens(events, startMs, endMs) {
  const t = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, billable: 0 };
  const perModel = new Map();
  for (const ev of events || []) {
    if (!ev || ev.ts < startMs || ev.ts >= endMs) continue;
    t.input += ev.input;
    t.output += ev.output + ev.thoughts;
    t.cacheRead += ev.cached;
    const bill = ev.input + ev.output + ev.thoughts;
    perModel.set(ev.model, (perModel.get(ev.model) || 0) + bill);
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
  createGeminiUsageScanner,
  geminiUsageEvents,
  sumGeminiTokens,
  geminiDir,
  geminiTmpDir,
  RAW_DAYS,
  BUCKET_MS,
  hashId,
  _resetForTests,
};
