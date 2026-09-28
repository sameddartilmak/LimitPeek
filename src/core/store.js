'use strict';
const fs = require('node:fs');
const path = require('node:path');
const log = require('./log');
const archiveMod = require('./scan/archive');

/**
 * Single-file, atomically written persistence. No SQLite (ADR-001) — the
 * working set is a few thousand small records.
 *
 * What is stored: file cursors keyed by a HASH of the path (never the path
 * itself, because Claude Code encodes the user's cwd in the directory name),
 * the extracted numeric events for the retention window, and the per-day
 * archive of older ones (scan/archive.js). There are no
 * message bodies, no file paths, no cwd, no model prompts in this file.
 */
/**
 * 2: events carry the per-TTL cache-write split (`cw5`/`cw1h`) and `speed`,
 * which ADR-002 pricing needs. A version-1 store cannot be upgraded in place —
 * the fields were never extracted — and silently pricing its records with the
 * 5-minute fallback would understate the first week after an update. Discard
 * and rescan instead; it costs 600-900 ms once.
 */
const SCHEMA_VERSION = 2;
const STORE_FILE = 'usage-store.json';

function storePath(userDataDir) {
  return path.join(userDataDir, STORE_FILE);
}

function emptyStore() {
  return { schemaVersion: SCHEMA_VERSION, cursors: {}, events: [], archive: null, builtAt: null };
}

function load(userDataDir) {
  const file = storePath(userDataDir);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (!err || err.code !== 'ENOENT') log.warn(`store unreadable: code=${(err && err.code) || 'UNKNOWN'}`);
    return emptyStore();
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    log.warn('store corrupt, starting empty');
    return emptyStore();
  }
  if (!raw || typeof raw !== 'object' || raw.schemaVersion !== SCHEMA_VERSION) {
    // Forward/backward incompatible: discard rather than misread. The cost is
    // one full rescan (~600-900 ms on the reference corpus).
    return emptyStore();
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    cursors: raw.cursors && typeof raw.cursors === 'object' ? raw.cursors : {},
    events: Array.isArray(raw.events) ? raw.events.filter(isEvent) : [],
    // Absent (a store from before the archive) or malformed: the next scan
    // reads every transcript once and builds it.
    archive: archiveMod.fromStored(raw.archive),
    builtAt: typeof raw.builtAt === 'string' ? raw.builtAt : null,
  };
}

function isEvent(ev) {
  return ev
    && typeof ev === 'object'
    && typeof ev.f === 'string'
    && Number.isFinite(ev.ts)
    && typeof ev.model === 'string'
    && typeof ev.key === 'string'
    && Number.isFinite(ev.input)
    && Number.isFinite(ev.output)
    && Number.isFinite(ev.cacheWrite)
    && Number.isFinite(ev.cacheRead)
    // Present on every schema-2 event. Required rather than defaulted: a
    // record missing them would be priced by the fallback path and quietly
    // understate the week.
    && Number.isFinite(ev.cw5)
    && Number.isFinite(ev.cw1h);
}

/** tmp + fsync + rename in the same directory: a crash mid-write leaves the
 *  previous store intact rather than a truncated one. */
function save(userDataDir, data) {
  const file = storePath(userDataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    builtAt: data.builtAt || new Date().toISOString(),
    cursors: data.cursors || {},
    events: data.events || [],
    archive: data.archive || null,
  };
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(payload), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    log.warn(`store write failed: code=${(err && err.code) || 'UNKNOWN'}`);
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    return false;
  }
}

module.exports = { load, save, emptyStore, storePath, SCHEMA_VERSION, STORE_FILE };
