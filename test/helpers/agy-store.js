'use strict';
const fs = require('node:fs');
const path = require('node:path');

const { loadSqlite } = require('../../src/core/antigravity/sqlite');

/**
 * Builds synthetic Antigravity IDE state stores.
 *
 * A hand-written ENCODER, deliberately, rather than a copy of a real store:
 * the tests need shapes a real store will not produce — a renumbered field, an
 * extra float beside the fraction, a double where a float32 belongs — and
 * those are exactly the cases the strict decoder exists for. A fixture that
 * can only reproduce today's bytes cannot test tomorrow's drift.
 *
 * The envelope it reproduces was verified against a live store:
 *
 *   ItemTable.value  base64 text
 *    -> message      { 1: entry }            repeated keyed entries
 *       entry        { 1: string key, 2: msg }
 *          msg       { 1: bytes }            these bytes are base64 TEXT again
 *             -> base64 -> userStatus
 *                userStatus { 33: container, ... }
 *                container  { 1: model }     repeated
 *                model      { 1: name, 15: quota, 16: tier, ... }
 *                quota      { 1: float32 fraction, 2: { 1: varint seconds } }
 */

function varint(n) {
  const out = [];
  let v = BigInt(n);
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return Buffer.from(out);
}

function tag(field, wire) {
  return varint((BigInt(field) << 3n) | BigInt(wire));
}

function lenField(field, payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  return Buffer.concat([tag(field, 2), varint(buf.length), buf]);
}

function varintField(field, value) {
  return Buffer.concat([tag(field, 0), varint(value)]);
}

function floatField(field, value) {
  const b = Buffer.alloc(4);
  b.writeFloatLE(value);
  return Buffer.concat([tag(field, 5), b]);
}

function doubleField(field, value) {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(value);
  return Buffer.concat([tag(field, 1), b]);
}

/**
 * One model's quota block.
 * @param {object} o
 * @param {number} o.fraction        remaining, 0..1
 * @param {number} o.resetSeconds    unix seconds
 * @param {number} [o.fractionField] field number for the fraction (drift tests)
 * @param {boolean} [o.asDouble]     encode the fraction as a double (drift tests)
 * @param {number} [o.extraFloat]    add a SECOND float beside it (drift tests)
 */
function quotaBlock(o) {
  const parts = [];
  const fieldNo = o.fractionField ?? 1;
  parts.push(o.asDouble ? doubleField(fieldNo, o.fraction) : floatField(fieldNo, o.fraction));
  if (o.extraFloat !== undefined) parts.push(floatField(3, o.extraFloat));
  parts.push(lenField(2, varintField(1, o.resetSeconds)));
  return Buffer.concat(parts);
}

/**
 * @param {object} o
 * @param {string} o.name
 * @param {number} [o.fraction]
 * @param {number} [o.resetSeconds]
 * @param {string} [o.tier]
 * @param {boolean} [o.noQuota]  omit the quota block entirely
 * @param {number} [o.quotaField] field number for the quota block (drift tests)
 */
function modelEntry(o) {
  const parts = [lenField(1, o.name)];
  if (!o.noQuota) parts.push(lenField(o.quotaField ?? 15, quotaBlock(o)));
  if (o.tier) parts.push(lenField(16, o.tier));
  // A couple of the unrelated siblings a real entry carries, so the tests
  // prove the decoder tolerates fields it does not read.
  parts.push(varintField(5, 1));
  parts.push(lenField(18, 'unrelated'));
  return Buffer.concat(parts);
}

/**
 * @param {Array} models
 * @param {object} [o]
 * @param {number} [o.listField]  field number for the model container
 * @param {boolean} [o.omitList]  leave the container out entirely
 */
function userStatus(models, o = {}) {
  const container = Buffer.concat(models.map((m) => lenField(1, modelEntry(m))));
  const parts = [
    // Unrelated account-envelope siblings, present in the real message.
    lenField(3, 'account'),
    lenField(7, 'settings'),
  ];
  if (!o.omitList) parts.push(lenField(o.listField ?? 33, container));
  return Buffer.concat(parts);
}

/** The double-base64 envelope the store actually holds. */
function envelope(statusBuf, o = {}) {
  const inner = lenField(1, Buffer.from(statusBuf.toString('base64'), 'utf8'));
  const entry = Buffer.concat([
    lenField(1, o.sentinel ?? 'userStatusSentinelKey'),
    lenField(2, inner),
  ]);
  return Buffer.concat([lenField(1, entry)]).toString('base64');
}

/**
 * Writes a store at `<root>/User/globalStorage/state.vscdb`.
 *
 * @param {string} root        the install directory to create
 * @param {string|null} value  the ItemTable value, or null to omit the key
 * @param {object} [o]
 * @param {number} [o.mtimeMs] force the file's modification time — this is the
 *   capture instant the reader ages against, so every staleness test sets it
 * @returns {string} the store path
 */
function writeStore(root, value, o = {}) {
  const sqlite = loadSqlite();
  if (!sqlite) throw new Error('node:sqlite unavailable; cannot build a fixture');
  const dir = path.join(root, 'User', 'globalStorage');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'state.vscdb');
  fs.rmSync(file, { force: true });

  const db = new sqlite.DatabaseSync(file);
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
  if (value !== null) {
    // The oauth token lives in this same table in a real store. It is here so
    // the tests can prove the reader never selects it.
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
      .run('antigravityUnifiedStateSync.oauthToken', 'ya29.PRETEND-TOKEN-DO-NOT-READ');
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
      .run('antigravityUnifiedStateSync.userStatus', value);
  }
  db.close();

  if (o.mtimeMs !== undefined) {
    const when = new Date(o.mtimeMs);
    fs.utimesSync(file, when, when);
  }
  return file;
}

/** The common case: an install with these models, stamped at `mtimeMs`. */
function writeInstall(root, models, o = {}) {
  return writeStore(root, envelope(userStatus(models, o), o), o);
}

module.exports = {
  varint, tag, lenField, varintField, floatField, doubleField,
  quotaBlock, modelEntry, userStatus, envelope, writeStore, writeInstall,
};
