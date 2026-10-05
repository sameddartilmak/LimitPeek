'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readAppended } = require('./scan/append-reader');

/**
 * Claude Code's own record that the usage limit was hit, read from its
 * session transcripts.
 *
 * WHY: the status-line payload the bridge captures carries the rate limits of
 * the last SUCCESSFUL request. The request that hits the limit is not one, so
 * the capture stops at the figure before it: owner, 2026-10-05, the 5h limit
 * was full and the panel still read 99%. Claude Code does write the moment
 * down, as a meta record with a top-level `usageLimitNote` field:
 *
 *   "wrap_up"  the limit was reached (seen 14:07, the 5h window reset 14:10)
 *   "release"  earlier notes no longer apply (seen 14:10, after the reset)
 *
 * Every open session writes into its own transcript, so the NEWEST note
 * across all of them is the account's current state.
 *
 * PRIVACY, the same discipline as `scan/parse.js`: a line is decoded only if
 * its bytes contain `"usageLimitNote"`, and only `usageLimitNote` and
 * `timestamp` are read from it. The note is accepted only as one of the known
 * short tokens, so no free text can leave this module.
 */

const NOTES = new Set(['wrap_up', 'release']);
const MARKER = Buffer.from('"usageLimitNote"');

/**
 * A note older than this cannot describe a current window: the weekly window
 * is the longest a note can mark full (see `ratelimits.applyLimitNote`), plus
 * a day of slack.
 */
const NOTE_KEEP_MS = 8 * 24 * 60 * 60 * 1000;

/**
 * At start-up only transcripts written to this recently are opened. Reading
 * a week of them would cost far more than the case it covers: a weekly limit
 * hit more than six hours before the app started, still unreleased.
 */
const PRIME_HORIZON_MS = 6 * 60 * 60 * 1000;

/** How far back from the end a file is read the first time it is seen. */
const FIRST_READ_BYTES = 1024 * 1024;

const noop = () => {};

/** `{ atMs, note }` from one transcript line, or null. */
function noteFromLine(buf) {
  if (buf.indexOf(MARKER) === -1) return null;
  let record;
  try {
    record = JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
  if (!record || typeof record !== 'object') return null;
  const note = record.usageLimitNote;
  if (typeof note !== 'string' || !NOTES.has(note)) return null;
  const atMs = Date.parse(record.timestamp);
  if (!Number.isFinite(atMs)) return null;
  return { atMs, note };
}

const newer = (a, b) => (!a ? b : !b ? a : (b.atMs > a.atMs ? b : a));

/**
 * Follows the transcripts under one projects root and answers "what is the
 * newest usage-limit note?". Each file is read only from where the previous
 * read stopped, so a change costs the appended bytes, not the file.
 */
class LimitNoteTracker {
  /** @param {{root: string}} options */
  constructor(options) {
    this.root = options.root;
    /** path -> { offset, note } */
    this._files = new Map();
    /** Paths reported changed since the last `latest()`. */
    this._pending = new Set();
    this._primed = false;
  }

  /** A watcher saw `file` change. Read on the next `latest()`. */
  touch(file) {
    if (typeof file === 'string' && file.endsWith('.jsonl')) this._pending.add(file);
  }

  /**
   * The first call lists the session transcripts written to in the last
   * PRIME_HORIZON_MS (one level of project folders, where Claude Code keeps a
   * session's own transcript). Later changes arrive through `touch`.
   */
  _prime(now) {
    let dirs;
    try {
      dirs = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      // No projects folder yet (Claude Code never ran): try again next time.
      return;
    }
    this._primed = true;
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(this.root, d.name);
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const file = path.join(dir, name);
        try {
          if (fs.statSync(file).mtimeMs >= now - PRIME_HORIZON_MS) this._pending.add(file);
        } catch { /* gone */ }
      }
    }
  }

  _read(file) {
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      this._files.delete(file);
      return;
    }
    let entry = this._files.get(file);
    // New, or shorter than what was read (rewritten): start near the end. The
    // first line from a mid-file offset is a fragment and fails to parse.
    if (!entry || size < entry.offset) {
      entry = { offset: Math.max(0, size - FIRST_READ_BYTES), note: null };
      this._files.set(file, entry);
    }
    if (size === entry.offset) return;
    readAppended(file, entry, size, (line) => {
      entry.note = newer(entry.note, noteFromLine(line));
    }, noop);
  }

  /** The newest note across every followed transcript, or null. */
  latest(now = Date.now()) {
    if (!this._primed) this._prime(now);
    for (const file of this._pending) this._read(file);
    this._pending.clear();
    let best = null;
    for (const [file, entry] of this._files) {
      // A note this old can never apply again. Only the note is dropped: the
      // offset stays, so the next change reads the new bytes alone.
      if (entry.note && entry.note.atMs < now - NOTE_KEEP_MS) entry.note = null;
      if (!entry.note) continue;
      best = newer(best, entry.note);
    }
    return best;
  }
}

module.exports = { LimitNoteTracker, noteFromLine, NOTE_KEEP_MS, PRIME_HORIZON_MS, FIRST_READ_BYTES };
