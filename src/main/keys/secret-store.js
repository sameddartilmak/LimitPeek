'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { safeStorage } = require('electron');

const paths = require('../../core/paths');
const log = require('../../core/log');
const { isNetworkPath, isLocalAbsolute, resolveLocalDir, isRefusedDir } = require('../../core/codex/rollout');
const { isKeyCapable, keySpec } = require('../../core/keys/registry');

/**
 * The secret store (ADR-003 Amendment 5, K7-K12).
 *
 * DPAPI OR NOTHING
 * ----------------
 * Electron's `safeStorage` on Windows is DPAPI, keyed to the logged-in user. If
 * `isEncryptionAvailable()` is false we REFUSE to store anything and the row
 * reports 'secure-storage-unavailable'. There is no fallback path in this file —
 * no plaintext, no base64-as-protection, no key derived from a machine id — and
 * `setUsePlainTextEncryption` is never called anywhere in this codebase (a
 * source scan asserts the string's absence). Amendment 5 pre-declares a
 * non-DPAPI fallback as a veto, so the correct behaviour when DPAPI is missing
 * is to do nothing and say so.
 *
 * WHAT DPAPI DOES AND DOES NOT PROTECT
 * ------------------------------------
 * It protects the file from OTHER Windows accounts and from a copy taken to
 * another machine. It does NOT protect against a program running as the same
 * user, which can ask DPAPI to unprotect the same blob. The consent copy has to
 * say exactly that (Amendment 5), and this comment exists so nobody later
 * "upgrades" the description in the UI to something stronger than the mechanism.
 *
 * THE FILE
 * --------
 * `%LOCALAPPDATA%\UsageNotch\secrets\<provider>.json`:
 *
 *     { "v": 1, "provider": "copilot", "region": null,
 *       "storedAt": "2026-09-22T…Z", "blob": "<base64 DPAPI ciphertext>" }
 *
 * The username lives INSIDE the ciphertext, not beside it. It is not a secret,
 * but it is the other half of the pair the request needs, and keeping the two
 * in one blob means a reader either gets both or gets neither — there is no
 * state where a key is present with a username from an older entry.
 *
 * Reads are capped at 4 KiB. Anything larger, unparsable, of another version or
 * naming another provider is 'unreadable' — a fixed code, never a throw, and
 * never a path or a parse message in the log.
 */

const SECRET_VERSION = 1;
/** Read cap (K10). A record is ~700 bytes; this is generous and still bounded. */
const MAX_RECORD_BYTES = 4096;
/** A DPAPI blob for a 300-character key is ~600 bytes of base64. */
const MAX_BLOB_CHARS = 3072;

/** Refusals are remembered for the process (ADR-003 A3.3). */
let dirRefused = false;
let dirRefusalLogged = false;

function refuseDir(code) {
  dirRefused = true;
  if (!dirRefusalLogged) {
    dirRefusalLogged = true;
    // A fixed code. Never the path.
    log.warn(`usage notch secrets directory refused: code=${code}`);
  }
  return null;
}

/**
 * The secrets directory, created if needed, RESOLVED and re-checked — or null.
 *
 * ADR-003 Amendment 3, in its documented order: judge the string and every link
 * target along it without following anything, only then resolve, then check the
 * resolved result again, and remember a refusal for the life of the process so a
 * stalled share is not retried on every store.
 *
 * @param {boolean} create  false for a read (a missing directory is simply "no key")
 */
function secretsDirSafe(create) {
  if (dirRefused) return null;
  const dir = paths.secretsDir();
  if (typeof dir !== 'string' || dir.length === 0) return refuseDir('NO_PATH');
  if (isNetworkPath(dir) && !isLocalAbsolute(dir)) return refuseDir('NETWORK_TARGET');
  const abs = path.resolve(dir);
  if (!isLocalAbsolute(abs)) return refuseDir('NOT_LOCAL_PATH');

  if (create) {
    try {
      // `recursive` also creates %LOCALAPPDATA%\UsageNotch, which the rate-limit
      // capture already owns. mkdir follows links, which is why the checks above
      // run first and the check below runs after.
      fs.mkdirSync(abs, { recursive: true });
    } catch (err) {
      return refuseDir((err && err.code) || 'MKDIR_FAILED');
    }
  }

  const real = resolveLocalDir(abs, 'usage notch secrets');
  if (real === null) {
    // `resolveLocalDir` answers null both for "not there" and for "refused";
    // only the refusal is remembered here.
    if (isRefusedDir(abs)) return refuseDir('REFUSED');
    return null;
  }
  return real;
}

function recordPath(dir, provider) {
  return path.join(dir, `${provider}.json`);
}

function isAvailable() {
  try {
    return safeStorage.isEncryptionAvailable() === true;
  } catch {
    return false;
  }
}

/**
 * Reads the record WITHOUT decrypting it: enough for `keyState` and
 * `keyStoredAt`, and nothing more. There is no exported function that returns a
 * key to a caller other than the request path (K3).
 *
 * @returns {{state:'none'|'stored'|'unreadable', storedAt:string|null}}
 */
function read(provider) {
  if (!isKeyCapable(provider)) return { state: 'none', storedAt: null };
  const dir = secretsDirSafe(false);
  if (dir === null) return { state: 'none', storedAt: null };
  const record = readRecord(recordPath(dir, provider), provider);
  if (record === null) return { state: 'none', storedAt: null };
  if (record === false) return { state: 'unreadable', storedAt: null };
  return { state: 'stored', storedAt: record.storedAt };
}

/**
 * @returns {object|null|false} the validated record, null when there is no file,
 *   false when there is one and it cannot be trusted ('unreadable').
 */
function readRecord(file, provider) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    // An existing file we cannot open is NOT "no key": saying 'none' there
    // would offer the user a fresh entry flow while a key sits on disk.
    log.warn(`secret record could not be opened: code=${(err && err.code) || 'UNKNOWN'}`);
    return false;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return false;
    // The cap is applied to the FILE, before any allocation (K10).
    if (st.size === 0 || st.size > MAX_RECORD_BYTES) return false;
    const buf = Buffer.allocUnsafe(st.size);
    const read2 = fs.readSync(fd, buf, 0, st.size, 0);
    if (read2 !== st.size) return false;
    const raw = JSON.parse(buf.toString('utf8'));
    if (!raw || typeof raw !== 'object') return false;
    // A version or provider mismatch is 'unreadable', never a best-effort
    // reinterpretation: a record written by a future version may mean something
    // else by the same field names.
    if (raw.v !== SECRET_VERSION) return false;
    if (raw.provider !== provider) return false;
    if (typeof raw.blob !== 'string' || raw.blob.length === 0 || raw.blob.length > MAX_BLOB_CHARS) return false;
    if (typeof raw.storedAt !== 'string' || !Number.isFinite(Date.parse(raw.storedAt))) return false;
    return { v: raw.v, provider: raw.provider, region: raw.region === undefined ? null : raw.region, storedAt: raw.storedAt, blob: raw.blob };
  } catch (err) {
    // Includes JSON.parse, whose message embeds a slice of the source and is
    // therefore never propagated (ADR-001 security F3).
    log.warn(`secret record unreadable: code=${(err && err.code) || 'PARSE'}`);
    return false;
  } finally {
    try { fs.closeSync(fd); } catch { /* already gone */ }
  }
}

/** True when a record file exists at all. Says nothing about its contents. */
function hasRecord(provider) {
  const state = read(provider).state;
  return state === 'stored' || state === 'unreadable';
}

/**
 * The temporary file a write lands in before its rename.
 *
 * TWO properties, both from the security review of Phase B (F4):
 *
 *  1. It is opened with `'wx'` — create-exclusive. `'w'` at a predictable path
 *     would be written THROUGH a pre-planted symlink or junction, by a program
 *     running as this user, into a file of its choosing.
 *  2. The name is unpredictable. `'wx'` alone would turn a stale temporary left
 *     by a crash (pids are recycled) into a permanent refusal to store a key.
 *     With random bytes in the name there is nothing to pre-plant and nothing to
 *     collide with, so EEXIST means a genuine race and failing is correct.
 *
 * `remove()` still finds these: it matches `<provider>.json.*.tmp`.
 */
function tmpPath(target) {
  return `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
}

/**
 * Create-exclusive write, then fsync, then rename. Returns null on success or a
 * fixed error code.
 *
 * `nameTmp` is a test seam and nothing else. The EEXIST branch below is the one
 * the review asked for, and it is unreachable from outside once the name is
 * random — which is the point of the name being random. Injecting the namer is
 * how the refusal gets a test instead of a comment claiming it works.
 */
function writeAtomic(target, contents, nameTmp = tmpPath) {
  const tmp = nameTmp(target);
  let created = false;
  try {
    // 'wx' fails rather than following anything that is already there.
    const fd = fs.openSync(tmp, 'wx', 0o600);
    created = true;
    try {
      fs.writeFileSync(fd, contents, 'utf8');
      // Without the fsync the rename can land before the bytes do, so a crash
      // seconds later leaves a truncated record — which reads as 'unreadable'
      // and costs the user their key with no visible cause.
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
    return null;
  } catch (err) {
    // Our own temporary is cleaned up; a path we did NOT create is left exactly
    // as it was. Deleting it would be a write to a file that is not ours, which
    // is the thing the create-exclusive open exists to avoid — and on a planted
    // symlink it would quietly remove something the user may care about.
    if (created) {
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    }
    return (err && err.code) || 'UNKNOWN';
  }
}

/**
 * Encrypts and writes, atomically — see `writeAtomic` for the create-exclusive
 * temporary and the fsync, and why both are load-bearing here.
 *
 * @returns {{ok:true, storedAt:string} | {ok:false, code:string}}
 */
function store({ provider, key, username, now }) {
  if (!isKeyCapable(provider)) return { ok: false, code: 'unknown-provider' };
  if (typeof key !== 'string' || key.length === 0) return { ok: false, code: 'invalid' };
  if (!isAvailable()) return { ok: false, code: 'secure-storage-unavailable' };

  const spec = keySpec(provider);
  const dir = secretsDirSafe(true);
  if (dir === null) return { ok: false, code: 'store-failed' };

  const storedAt = new Date(Number.isFinite(now) ? now : Date.now()).toISOString();
  let blob;
  try {
    blob = safeStorage.encryptString(JSON.stringify({ key, username })).toString('base64');
  } catch (err) {
    log.warn(`secret could not be encrypted: code=${(err && err.code) || 'UNKNOWN'}`);
    return { ok: false, code: 'secure-storage-unavailable' };
  }
  const record = { v: SECRET_VERSION, provider, region: spec.region, storedAt, blob };

  const failure = writeAtomic(recordPath(dir, provider), `${JSON.stringify(record)}\n`);
  if (failure !== null) {
    log.warn(`secret could not be written: code=${failure}`);
    return { ok: false, code: 'store-failed' };
  }
  return { ok: true, storedAt };
}

/**
 * Decrypts. Called from ONE place — the request function, immediately before
 * the request — and its result is never assigned to anything that outlives the
 * call (K17). There is no cache in this module, on purpose: a cached key is a
 * key in a crash dump.
 *
 * @returns {{ok:true, key:string, username:string} | {ok:false, code:'none'|'unreadable'}}
 */
function open(provider) {
  if (!isKeyCapable(provider)) return { ok: false, code: 'none' };
  const dir = secretsDirSafe(false);
  if (dir === null) return { ok: false, code: 'none' };
  const record = readRecord(recordPath(dir, provider), provider);
  if (record === null) return { ok: false, code: 'none' };
  if (record === false) return { ok: false, code: 'unreadable' };
  if (!isAvailable()) return { ok: false, code: 'unreadable' };
  let payload;
  try {
    payload = JSON.parse(safeStorage.decryptString(Buffer.from(record.blob, 'base64')));
  } catch (err) {
    // A blob from another user or another machine lands here. A fixed code; the
    // ciphertext, the error message and the path are all left out.
    log.warn(`secret could not be decrypted: code=${(err && err.code) || 'DECRYPT'}`);
    return { ok: false, code: 'unreadable' };
  }
  if (!payload || typeof payload !== 'object') return { ok: false, code: 'unreadable' };
  const { key, username } = payload;
  if (typeof key !== 'string' || key.length === 0) return { ok: false, code: 'unreadable' };
  if (typeof username !== 'string' || username.length === 0) return { ok: false, code: 'unreadable' };
  return { ok: true, key, username };
}

/**
 * Deletes the record, any half-written temporary beside it, and the schedule
 * file (K20). Everything else removal has to do — cancelling timers, aborting a
 * request in flight, `closeAllConnections()`, `clearAuthCache()`, dropping the
 * cached figure — belongs to the service that owns those things, because this
 * module owns only the bytes.
 *
 * `{ok:true}` when no file is left behind, including the case where there was
 * nothing to delete: "remove" is idempotent by design, since the user may press
 * it twice and both presses must end in the same state.
 */
function remove(provider) {
  if (!isKeyCapable(provider)) return { ok: false };
  const dir = secretsDirSafe(false);
  if (dir === null) return { ok: true };
  let ok = true;
  const target = recordPath(dir, provider);
  ok = unlinkIfPresent(target) && ok;
  ok = unlinkIfPresent(path.join(dir, `${provider}.state.json`)) && ok;
  // Temporaries carry the writing process's pid, so a crash during a store can
  // leave one behind under a pid we no longer know.
  try {
    for (const name of fs.readdirSync(dir)) {
      if ((name.startsWith(`${provider}.json.`) || name.startsWith(`${provider}.state.json.`))
        && name.endsWith('.tmp')) {
        ok = unlinkIfPresent(path.join(dir, name)) && ok;
      }
    }
  } catch { /* an unreadable directory leaves nothing else to clean */ }
  return { ok };
}

function unlinkIfPresent(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return true;
    log.warn(`secret file could not be deleted: code=${(err && err.code) || 'UNKNOWN'}`);
    return false;
  }
}

/* --------------------------------------------------------------- schedule */

/**
 * The polling schedule, beside the secret (see `paths.secretStateFile`). Holds
 * no secret, is capped and validated exactly like the record, and a corrupt one
 * simply reads as "no schedule yet".
 */
function readSchedule(provider) {
  if (!isKeyCapable(provider)) return null;
  const dir = secretsDirSafe(false);
  if (dir === null) return null;
  try {
    const file = path.join(dir, `${provider}.state.json`);
    const st = fs.statSync(file);
    if (!st.isFile() || st.size === 0 || st.size > MAX_RECORD_BYTES) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || raw.provider !== provider) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeSchedule(provider, state) {
  if (!isKeyCapable(provider)) return false;
  const dir = secretsDirSafe(true);
  if (dir === null) return false;
  // The same create-exclusive write as the record: this file holds no secret,
  // but it sits in the same directory and is written just as often, so it must
  // not be the one followable path in there.
  return writeAtomic(
    path.join(dir, `${provider}.state.json`),
    `${JSON.stringify({ v: SECRET_VERSION, provider, ...state })}\n`,
  ) === null;
}

/** Test seam: forget the remembered directory refusal. */
function _resetForTests() {
  dirRefused = false;
  dirRefusalLogged = false;
}

module.exports = {
  isAvailable,
  read,
  hasRecord,
  store,
  open,
  remove,
  readSchedule,
  writeSchedule,
  secretsDirSafe,
  writeAtomic,
  tmpPath,
  SECRET_VERSION,
  MAX_RECORD_BYTES,
  _resetForTests,
};
