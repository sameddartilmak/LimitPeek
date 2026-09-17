'use strict';
const fs = require('node:fs');
const { walkJsonlFiles } = require('./walk');
const { extractEvents } = require('./parse');
const log = require('../log');

const DAY_MS = 24 * 60 * 60 * 1000;
/** Events are kept for 8 days: the 7-day window plus a day of slack. */
const RETENTION_DAYS = 8;
/** A failed, unterminated last line in a file written this recently is a write
 *  in progress, not a lost record (ADR-002 A3.15). */
const TORN_WRITE_GRACE_MS = 5 * 60 * 1000;

/**
 * Incremental scan of the transcript tree.
 *
 * Two prefilters, both measured on the reference corpus (209 files / 144 MB):
 *   1. mtime: only 34 files / 27 MB fall inside a 7-day window. A file we have
 *      never seen whose mtime predates the retention cutoff cannot contain a
 *      record inside the window, so it is stat'ed and never opened.
 *   2. cursor: a file whose (size, mtimeMs) is unchanged since the last scan is
 *      not re-read; its previously extracted events are carried forward. A size
 *      change re-parses the file regardless of mtime.
 *
 * Every file is wrapped in its own try/catch: a single unreadable or truncated
 * transcript must not take down the tray process.
 *
 * `unreadRange` (ADR-002 A3.15, A3.20) is `{ fromMs, throughMs }`, the hull of
 * the instants holding usage records this scan KNOWS it could not read, or null
 * when it missed none. No range starts before the retention cutoff: the store
 * holds nothing older, so nothing older is missing from it. It is set by:
 *   - a walk that stopped at its file/directory cap, or a subdirectory or file
 *     that exists but could not be listed/stat'ed -> through `now` (no bound);
 *   - a transcript that could not be read -> through that file's mtime
 *     (records are appended, so none is newer than the last write);
 *   - usage records lost inside a file -> through that file's mtime: lines that
 *     failed to parse, or usage records with an unusable timestamp. The count
 *     rides on the file's cursor (`droppedLines`, always present), so an
 *     unchanged file carried forward keeps saying so. A torn final line is
 *     excluded only while the file was written in the last TORN_WRITE_GRACE_MS
 *     (a writer mid-append; the next scan re-reads it) — an old one is lost.
 *     An excused torn line rides on the cursor as `tornLines`; if the file is
 *     still unchanged once the grace has passed, it becomes a dropped line.
 *   A cursor with no `droppedLines` predates this accounting: a file inside
 *   retention is re-read once so an old loss is counted.
 * A path that vanished mid-scan (ENOENT) is gone, not unread.
 *
 * @param {object} opts
 * @param {string} opts.root         projects directory
 * @param {object} opts.cursors      { [fileId]: { size, mtimeMs } } from the store
 * @param {Array}  opts.priorEvents  events from the store, each carrying `f`
 * @param {number} opts.now          epoch ms
 */
async function scan(opts) {
  const started = Date.now();
  const root = opts.root;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const retentionDays = opts.retentionDays ?? RETENTION_DAYS;
  const cutoff = now - retentionDays * DAY_MS;
  const priorCursors = opts.cursors && typeof opts.cursors === 'object' ? opts.cursors : {};

  const priorByFile = new Map();
  for (const ev of opts.priorEvents || []) {
    if (!ev || typeof ev.f !== 'string') continue;
    let bucket = priorByFile.get(ev.f);
    if (!bucket) { bucket = []; priorByFile.set(ev.f, bucket); }
    bucket.push(ev);
  }

  let walked;
  try {
    walked = await walkJsonlFiles(root, { maxDepth: opts.maxDepth });
  } catch (err) {
    log.fileFailure('root', err);
    return {
      ok: false,
      errorCode: (err && err.code) || 'EWALK',
      cursors: priorCursors,
      events: opts.priorEvents || [],
      stats: { filesSeen: 0, filesParsed: 0, bytesParsed: 0, records: 0, failedLines: 0, ms: Date.now() - started },
    };
  }

  // An unreadable root (permissions, a disk that went away) must not be
  // reported as "you used nothing". A root that does not exist is different:
  // Claude Code has simply never run here.
  if (walked.rootError && walked.rootError !== 'ENOENT') {
    return {
      ok: false,
      errorCode: walked.rootError,
      cursors: priorCursors,
      events: opts.priorEvents || [],
      stats: { filesSeen: 0, filesParsed: 0, filesFailed: 0, bytesParsed: 0, records: 0, failedLines: 0, ms: Date.now() - started },
    };
  }

  const cursors = Object.create(null);
  const events = [];
  let filesParsed = 0;
  let bytesParsed = 0;
  let failedLines = 0;
  let filesFailed = 0;
  let unread = null;
  const unreadThrough = (ms) => {
    const at = Number.isFinite(ms) ? Math.min(ms, now) : now;
    const from = Math.min(cutoff, at);
    if (unread === null) unread = { fromMs: from, throughMs: at };
    else {
      if (from < unread.fromMs) unread.fromMs = from;
      if (at > unread.throughMs) unread.throughMs = at;
    }
  };
  if (walked.truncated || walked.unreadable > 0) unreadThrough(now);

  for (const file of walked.files) {
    const prev = priorCursors[file.id];
    const sameFile = prev && prev.size === file.size && prev.mtimeMs === file.mtimeMs;
    // A cursor from before the loss accounting carries no `droppedLines`: its
    // file is re-read once while inside retention, so an old loss is counted.
    const accounted = Boolean(prev) && Number.isSafeInteger(prev.droppedLines);
    const unchanged = sameFile && (accounted || file.mtimeMs < cutoff);

    if (unchanged) {
      cursors[file.id] = { size: file.size, mtimeMs: file.mtimeMs };
      if (accounted) {
        let dropped = droppedLinesOf(prev);
        const torn = tornLinesOf(prev);
        if (torn > 0 && file.mtimeMs < now - TORN_WRITE_GRACE_MS) {
          // The writer never finished that line: the grace has run out on an
          // unchanged file, so the record is lost, not in progress (review F1).
          dropped += torn;
        } else if (torn > 0) {
          cursors[file.id].tornLines = torn;
        }
        cursors[file.id].droppedLines = dropped;
        // Nothing from a file older than retention is in the store, so nothing
        // of it is missing from the store (review F3).
        if (dropped > 0 && file.mtimeMs >= cutoff) unreadThrough(file.mtimeMs);
      }
      const carried = priorByFile.get(file.id);
      if (carried) for (const ev of carried) events.push(ev);
      continue;
    }

    // Never-seen file that is older than the retention window: record the
    // cursor so we do not consider it again, but never open it.
    if (!prev && file.mtimeMs < cutoff) {
      cursors[file.id] = { size: file.size, mtimeMs: file.mtimeMs };
      continue;
    }

    try {
      const text = await fs.promises.readFile(file.path, 'utf8');
      const res = extractEvents(text, file.id);
      for (const ev of res.events) events.push(ev);
      filesParsed += 1;
      bytesParsed += file.size;
      failedLines += res.failed;
      // A torn last line is a write in progress only while the file is fresh.
      const torn = file.mtimeMs >= now - TORN_WRITE_GRACE_MS ? (res.failedUnterminated || 0) : 0;
      const dropped = res.failed - torn + (res.droppedRecords || 0);
      cursors[file.id] = { size: file.size, mtimeMs: file.mtimeMs, droppedLines: dropped };
      // Remembered, so an unchanged file whose writer died is counted once the
      // grace has passed instead of being excused forever (review F1).
      if (torn > 0) cursors[file.id].tornLines = torn;
      if (dropped > 0) unreadThrough(file.mtimeMs);
    } catch (err) {
      filesFailed += 1;
      if (!err || err.code !== 'ENOENT') unreadThrough(file.mtimeMs);
      log.fileFailure(file.id, err);
      // Keep whatever we already had for this file rather than dropping it,
      // and keep the OLD cursor so the next scan retries the read.
      if (prev) cursors[file.id] = prev;
      const carried = priorByFile.get(file.id);
      if (carried) for (const ev of carried) events.push(ev);
    }
  }

  // Files that disappeared from the tree drop out of both maps implicitly:
  // they were never added to `cursors`, and their events were never carried.
  const kept = events.filter((ev) => ev.ts >= cutoff);

  return {
    ok: true,
    cursors,
    events: kept,
    unreadRange: unread,
    stats: {
      filesSeen: walked.files.length,
      filesParsed,
      filesFailed,
      bytesParsed,
      records: kept.length,
      failedLines,
      truncated: walked.truncated,
      ms: Date.now() - started,
    },
  };
}

/** A cursor's persisted count of usage lines that failed to parse, or 0. */
function droppedLinesOf(cursor) {
  const n = cursor && cursor.droppedLines;
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/** A cursor's torn final line still inside its write grace (0 or 1), or 0. */
function tornLinesOf(cursor) {
  const n = cursor && cursor.tornLines;
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

module.exports = { scan, RETENTION_DAYS, DAY_MS, TORN_WRITE_GRACE_MS };
