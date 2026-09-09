'use strict';
const fs = require('node:fs');

const { decodeMessage, all, one, exactly, WireError } = require('./protobuf');
const { resolveAntigravityIdeStore } = require('./install');
const { loadSqlite } = require('./sqlite');

/**
 * Reads the five-hour model quota out of the Antigravity IDE's state store.
 *
 * This is the ONE place in this codebase that reads an undocumented interface,
 * and it does so because the user approved it on two conditions, both of which
 * live here or next door:
 *
 *   GUARD 1 (install.js) — the install directory is never hard-coded. It is
 *   resolved by picking the candidate whose store was written most recently,
 *   because the product renamed its directory once already and a hard-coded
 *   path silently served 112-day-old data as current.
 *
 *   GUARD 2 (here) — the store's own mtime IS the capture instant, so a stale
 *   store ages out through exactly the same freshness model as the two
 *   statusline bridges. There is no second staleness rule, and the failure
 *   mode is "no number", never "wrong number".
 *
 *   GUARD 3a (protobuf.js) — the decode is strict and refuses the whole
 *   reading on any structural surprise, because a field-numbered wire format
 *   fails OPEN where a documented JSON field fails closed.
 *
 * What it reads: ONE key, `antigravityUnifiedStateSync.userStatus`, opened
 * read-only. `antigravityUnifiedStateSync.oauthToken` sits in the same table
 * and is never named, selected, enumerated or touched — the query names its
 * key literally and there is no `SELECT *` anywhere in this file.
 *
 * What it does NOT read: a weekly figure. There is none in this store.
 * Confirmed by exhaustive decode: each model carries exactly one quota entry,
 * and no second horizon appears anywhere in the message. The IDE's own UI does
 * show a weekly limit, so the IDE fetches it live and does not persist it.
 * `sevenDay` is therefore reported as "this source does not supply it", never
 * as "this provider has no weekly window" — the second claim is false and the
 * user can see it is false on their own screen.
 */

const STORE_KEY = 'antigravityUnifiedStateSync.userStatus';

/**
 * The nested envelope, verified against a live store.
 *
 *   value            base64 text in ItemTable
 *    -> message      { 1: entry }            repeated keyed entries
 *       entry        { 1: string key, 2: msg }
 *          msg       { 1: bytes }            the bytes are base64 TEXT again
 *             -> base64 -> userStatus message
 *
 * The double base64 is theirs, not a mistake here.
 */
const SENTINEL_KEY = 'userStatusSentinelKey';

/** Field numbers, all verified against a live store on 2026-09-09. */
const F = {
  ENTRY: 1,            // top level: repeated keyed entry
  ENTRY_KEY: 1,
  ENTRY_VALUE: 2,
  PAYLOAD_B64: 1,      // inside entry value: the re-encoded payload
  MODEL_LIST: 33,      // inside userStatus: the container holding the models
  MODEL: 1,            // inside the container: repeated model entry
  MODEL_NAME: 1,
  MODEL_QUOTA: 15,
  MODEL_TIER: 16,
  QUOTA_FRACTION: 1,   // float32
  QUOTA_RESET: 2,      // message
  RESET_SECONDS: 1,    // varint, unix seconds
};

/** Bounds. A store outside these is malformed or hostile, not merely new. */
const MAX_MODELS = 64;
const MAX_NAME_LEN = 64;
/** A reset instant must be a plausible unix second, before any skew check. */
const RESET_MIN_MS = Date.parse('2020-01-01T00:00:00Z');
const RESET_MAX_MS = Date.parse('2100-01-01T00:00:00Z');

/** Control, zero-width and bidi-override characters — the same class the two
 *  bridges and the renderer's sanitizer strip, for the same reason. */
const CONTROL_CHARS = new RegExp(
  '[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]',
  'g',
);

function safeName(raw) {
  if (typeof raw !== 'string') return null;
  const clean = raw.replace(CONTROL_CHARS, '').trim();
  return clean.length > 0 && clean.length <= MAX_NAME_LEN ? clean : null;
}

/**
 * One decoded store, keyed by file identity AND mtime.
 *
 * `rebuild()` runs on a 15s sweep while the panel is open. Without this it
 * would open SQLite, pull a 7KB blob and walk two levels of protobuf every
 * fifteen seconds for a file that changes when the IDE syncs — minutes apart
 * at best. Keyed by mtime, so a changed store is never served from cache; the
 * cache can only ever return exactly the bytes it was built from.
 *
 * Deliberately one entry: there is one chosen install at a time, and a map
 * would keep a decoded copy of an abandoned install alive for the session.
 */
let decodeCache = null;

function cached(file, mtimeMs) {
  return decodeCache && decodeCache.file === file && decodeCache.mtimeMs === mtimeMs
    ? decodeCache.models
    : null;
}

function remember(file, mtimeMs, models) {
  decodeCache = { file, mtimeMs, models };
}

/** Test seam. Nothing in the app calls this. */
function clearDecodeCache() {
  decodeCache = null;
}

function absent(reason, extra = {}) {
  return {
    state: 'absent',
    reason,
    capturedAt: null,
    capturedAtMs: null,
    ageMs: null,
    fiveHour: null,
    sevenDay: null,
    groups: [],
    diverged: false,
    modelsSeen: 0,
    install: null,
    ...extra,
  };
}

/**
 * The one query. Named key, read-only handle, no enumeration.
 * @returns {string|null} the base64 value, or null when the key is not there.
 */
function readStoreValue(file) {
  const sqlite = loadSqlite();
  if (!sqlite || typeof sqlite.DatabaseSync !== 'function') return { err: 'sqlite-unavailable' };
  let db = null;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true });
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(STORE_KEY);
    if (!row || row.value == null) return { err: 'no-key' };
    return { value: String(row.value) };
  } catch (err) {
    // A locked, corrupt or schema-less store. Never propagate the message: it
    // can quote file contents.
    return { err: 'unreadable', code: (err && err.code) || 'UNKNOWN' };
  } finally {
    if (db) { try { db.close(); } catch { /* best effort */ } }
  }
}

/**
 * Peels the double-base64 envelope and returns the decoded userStatus fields.
 * @throws {WireError}
 */
function unwrap(value) {
  const outer = decodeMessage(Buffer.from(value, 'base64'));
  const entries = all(outer, F.ENTRY, 2);
  if (entries.length === 0) throw new WireError('no keyed entries');

  let payload = null;
  for (const entry of entries) {
    const inner = decodeMessage(entry.value);
    const key = one(inner, F.ENTRY_KEY, 2).value.toString('utf8');
    if (key !== SENTINEL_KEY) continue;
    const wrapper = decodeMessage(one(inner, F.ENTRY_VALUE, 2).value);
    // Exactly one field here: the re-encoded payload. An extra one would mean
    // we are no longer sure which of two blobs is the status.
    exactly(wrapper, [F.PAYLOAD_B64]);
    payload = one(wrapper, F.PAYLOAD_B64, 2).value.toString('utf8');
    break;
  }
  if (payload === null) throw new WireError(`entry ${SENTINEL_KEY} missing`);
  return decodeMessage(Buffer.from(payload, 'base64'));
}

/**
 * The quota block for one model, or null when the model carries none.
 *
 * `exactly` is the load-bearing line. A second float appearing beside
 * `remaining_fraction` — a `used_fraction`, say — is the case where picking
 * one of them would be a coin flip presented as a fact, so the whole reading
 * is refused instead of the one entry.
 *
 * @throws {WireError} on any structural surprise.
 */
function quotaOf(modelFields) {
  const blocks = modelFields.filter((f) => f.field === F.MODEL_QUOTA);
  if (blocks.length === 0) return null;
  if (blocks.length > 1) throw new WireError('model carries more than one quota block');
  if (blocks[0].wire !== 2) throw new WireError('quota block wire type');

  const quota = decodeMessage(blocks[0].value);
  exactly(quota, [F.QUOTA_FRACTION, F.QUOTA_RESET]);

  const fractionField = one(quota, F.QUOTA_FRACTION, 5);   // float32, not double
  const fraction = fractionField.value;
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) throw new WireError('fraction not finite');
  // Rejected, never clamped: a fraction outside the stated range is proof the
  // producer is not the producer we think it is.
  if (fraction < 0 || fraction > 1) throw new WireError('fraction out of range');

  const resetMsg = decodeMessage(one(quota, F.QUOTA_RESET, 2).value);
  exactly(resetMsg, [F.RESET_SECONDS]);
  const seconds = one(resetMsg, F.RESET_SECONDS, 0).value;
  const resetMs = Number(seconds) * 1000;
  if (!Number.isFinite(resetMs) || resetMs < RESET_MIN_MS || resetMs > RESET_MAX_MS) {
    throw new WireError('reset instant not a plausible unix second');
  }

  return { fraction, resetMs };
}

/**
 * Groups models by IDENTICAL (fraction, reset) pairs.
 *
 * This is de-duplication of repeated values and nothing more. It asserts no
 * relationship between the models in a group — not a shared pool, not a
 * shared limit, not a family. Two models land together because their two
 * numbers are the same two numbers, which is a fact about the payload rather
 * than a claim about the product.
 *
 * Members carry NAMES ONLY. The figure lives on the group. No structure this
 * function can produce pairs one model name with one percentage, which is why
 * no downstream surface can render "Claude Opus 4.6 · %60" out of it — a
 * string that would sit directly beneath the user's real Claude Code row.
 */
function groupByValue(models) {
  const byKey = new Map();
  for (const m of models) {
    const key = `${m.fraction}|${m.resetMs}`;
    if (!byKey.has(key)) byKey.set(key, { fraction: m.fraction, resetMs: m.resetMs, members: [] });
    byKey.get(key).members.push(m.name);
  }
  const groups = [...byKey.values()];
  for (const g of groups) g.members.sort((a, b) => a.localeCompare(b));
  // Most consumed first: the binding constraint leads, and the order is
  // total, so two runs of the same store produce the same list.
  groups.sort((a, b) => (a.fraction - b.fraction) || (a.resetMs - b.resetMs));
  return groups;
}

/**
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {string} [options.appDataDir] scan root, for tests
 * @param {string} [options.file] a specific store, bypassing resolution
 * @param {number} [options.maxAgeMs]
 * @returns {{state:'missing'|'invalid'|'absent'|'stale'|'fresh', reason:string|null,
 *   capturedAt:string|null, capturedAtMs:number|null, ageMs:number|null,
 *   fiveHour:{usedPercentage:number,resetsAtMs:number|null}|null, sevenDay:null,
 *   groups:Array, diverged:boolean, modelsSeen:number, install:object|null}}
 *
 *   - `missing`  no install, or no store file
 *   - `invalid`  the store exists but could not be opened
 *   - `absent`   opened, but nothing could be stated: no key, no models with a
 *                quota, or a shape we refuse to guess at (`reason: 'schema'`)
 *   - `stale`    older than the freshness budget
 *   - `fresh`    usable
 */
function readAntigravityIdeQuota(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  // Imported lazily to keep the module graph acyclic: ratelimits.js owns the
  // freshness budget and this file must not own a second one.
  // eslint-disable-next-line global-require
  const { MAX_AGE_MS, RESET_SKEW_MS } = require('../ratelimits');
  const maxAgeMs = options.maxAgeMs ?? MAX_AGE_MS;

  let install = null;
  let file = options.file || null;
  if (!file) {
    install = resolveAntigravityIdeStore(options.appDataDir);
    if (!install) {
      return { ...absent('no-install'), state: 'missing' };
    }
    file = install.file;
  }

  // GUARD 2. The store's own mtime is the capture instant. Everything after
  // this point ages through the same rule the statusline captures do, so a
  // store nobody has written for 112 days cannot present a figure.
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { ...absent('no-store'), state: 'missing', install };
  }
  // Floored: `mtimeMs` carries sub-millisecond precision on NTFS, and a
  // fractional instant round-trips through ISO as something no other
  // capturedAt in this app looks like.
  const capturedAtMs = Math.floor(stat.mtimeMs);
  const capturedAt = new Date(capturedAtMs).toISOString();
  const ageMs = now - capturedAtMs;

  let models = cached(file, capturedAtMs);
  if (models === null) {
    const decoded = decodeStore(file, capturedAtMs);
    if (decoded.err) {
      return {
        ...absent(decoded.err),
        state: decoded.err === 'unreadable' ? 'invalid' : 'absent',
        capturedAt,
        capturedAtMs,
        ageMs,
        install,
        ...(decoded.schemaError ? { schemaError: decoded.schemaError } : {}),
      };
    }
    models = decoded.models;
  }

  if (models.length === 0) {
    return { ...absent('no-quota'), capturedAt, capturedAtMs, ageMs, install };
  }

  const groups = groupByValue(models);
  // Main-computed, because the contract forbids the renderer doing arithmetic
  // on usage data — including the comparison that would tell it whether two
  // figures differ.
  const diverged = groups.length > 1;

  // The row's five-hour figure is the MOST consumed group: it is the binding
  // constraint on the user, and it errs pessimistic, the same choice the CLI
  // reader makes when two buckets land in one slot.
  const lead = groups[0];
  const usedPercentage = Math.round((1 - lead.fraction) * 10000) / 100;
  // Same credibility guard as the two statusline readers. An instant far
  // outside this window's own length would keep a dead percentage alive
  // forever, because `now >= resetsAt` never becomes true.
  const resetsAtMs = Math.abs(lead.resetMs - now) <= RESET_SKEW_MS.fiveHour ? lead.resetMs : null;

  const state = (ageMs > maxAgeMs || ageMs < -maxAgeMs) ? 'stale' : 'fresh';
  return {
    state,
    reason: null,
    capturedAt,
    capturedAtMs,
    ageMs,
    fiveHour: { usedPercentage, resetsAtMs },
    // This SOURCE carries no weekly figure — confirmed by exhaustive decode.
    // `snapshot.js` turns that into an `unknownWindow()` carrying the reason
    // `not-supplied`, NOT into a null window: null would assert the provider
    // has no weekly limit, which the user can disprove by glancing at
    // Antigravity's own UI. "There is one and we cannot state it" is true;
    // "there is none" is not.
    sevenDay: null,
    groups: groups.map((g) => ({
      usedPercentage: Math.round((1 - g.fraction) * 10000) / 100,
      resetsAtMs: Math.abs(g.resetMs - now) <= RESET_SKEW_MS.fiveHour ? g.resetMs : null,
      members: g.members,
    })),
    diverged,
    modelsSeen: models.length,
    install,
  };
}

/**
 * Opens, unwraps and validates one store. Time-independent on purpose: the
 * result is cacheable by mtime, and every decision that depends on `now`
 * stays in the caller.
 *
 * @returns {{models:Array}|{err:string, schemaError?:string}}
 */
function decodeStore(file, mtimeMs) {
  const read = readStoreValue(file);
  if (read.err) return { err: read.err };

  let models;
  try {
    const status = unwrap(read.value);
    const list = one(status, F.MODEL_LIST, 2);
    const container = decodeMessage(list.value);
    const raw = all(container, F.MODEL, 2);
    if (raw.length === 0) throw new WireError('model list empty');
    if (raw.length > MAX_MODELS) throw new WireError('model list implausibly long');

    models = [];
    for (const entry of raw) {
      const fields = decodeMessage(entry.value);
      const name = safeName(one(fields, F.MODEL_NAME, 2).value.toString('utf8'));
      const quota = quotaOf(fields);
      if (name === null || quota === null) continue;
      models.push({ name, fraction: quota.fraction, resetMs: quota.resetMs });
    }
  } catch (err) {
    if (!(err instanceof WireError)) throw err;
    // The refusal GUARD 3a exists for. We know the bytes decoded; we do not
    // know that they still mean what they meant, so we say nothing.
    return { err: 'schema', schemaError: err.message };
  }

  remember(file, mtimeMs, models);
  return { models };
}

module.exports = {
  readAntigravityIdeQuota,
  clearDecodeCache,
  groupByValue,
  quotaOf,
  unwrap,
  safeName,
  STORE_KEY,
  SENTINEL_KEY,
  F,
};
