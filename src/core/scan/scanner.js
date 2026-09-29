'use strict';
const fs = require('node:fs');
const { walkJsonlFiles } = require('./walk');
const { extractEvents } = require('./parse');
const archiveMod = require('./archive');
const log = require('../log');

const DAY_MS = 24 * 60 * 60 * 1000;
/** Events are kept for 8 days: the 7-day window plus a day of slack. */
const RETENTION_DAYS = 8;
/** A failed, unterminated last line in a file written this recently is a write
 *  in progress, not a lost record (ADR-002 A3.15). */
const TORN_WRITE_GRACE_MS = 5 * 60 * 1000;
/** The archive's name for the desktop app's Cowork transcript trees. */
const COWORK_SOURCE = 'cowork';

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
 * @param {object|null} [opts.archive] the stored archive (scan/archive.js);
 *                                   null: every transcript is read once and
 *                                   the archive is built from scratch;
 *                                   omitted: no archive is kept at all and
 *                                   the raw store is cut at exactly 8 days
 * @param {string[]} [opts.extraRoots] further transcript trees in the same
 *                                   format (the desktop app's Cowork sessions).
 *                                   One that cannot be read is a known gap,
 *                                   never a failed scan. The first archiving
 *                                   scan that has them folds their history
 *                                   before the frontier into the archive once.
 * @param {number} opts.now          epoch ms
 *
 * The raw store keeps records from a local midnight (`frontier`, 8 days back)
 * on; everything before it is folded into the archive as the frontier moves,
 * so the week/month history outlives both the retention and Claude Code's own
 * transcript cleanup. The records folded are the ones this scan holds for the
 * days between the archive's frontier and the new one: carried or read, and a
 * never-seen file is opened when it may hold such a day.
 */
async function scan(opts) {
  const started = Date.now();
  const root = opts.root;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const retentionDays = opts.retentionDays ?? RETENTION_DAYS;
  const archiving = Object.prototype.hasOwnProperty.call(opts, 'archive');
  const frontier = archiveMod.frontierFor(now, retentionDays, DAY_MS);
  let priorArchive = archiving ? archiveMod.fromStored(opts.archive) : null;
  // First build: every transcript is read once, whatever its cursor says.
  const backfill = archiving && priorArchive === null;
  // A frontier in the future was saved while the clock ran ahead. Kept, it
  // would cut the raw store at that date and skip every new transcript as
  // too old (review F2). The rows from the real frontier on are dropped and
  // the files that can hold those days are read again into the raw store.
  const rewound = !backfill && archiving && priorArchive.frontierMs > frontier;
  if (rewound) {
    priorArchive = { ...priorArchive, frontierMs: frontier, rows: priorArchive.rows.filter((r) => r.ts < frontier) };
  }
  const gapFrom = !archiving ? Infinity : (backfill ? -Infinity : priorArchive.frontierMs);
  // Never below the archive's frontier: a record on both sides would be counted twice.
  const cutoff = !archiving ? now - retentionDays * DAY_MS
    : (backfill ? frontier : Math.max(frontier, priorArchive.frontierMs));
  const needGap = archiving && frontier > gapFrom;
  // Old records this scan KNOWS it missed, for the archive (the hot range
  // below never starts before the cutoff).
  let gapUnread = null;
  const gapUnreadThrough = (ms) => {
    if (!needGap) return;
    const at = Number.isFinite(ms) ? Math.min(ms, frontier) : frontier;
    if (at < gapFrom) return;
    const from = Number.isFinite(gapFrom) ? gapFrom : 0;
    gapUnread = gapUnread === null
      ? { fromMs: from, throughMs: at }
      : { fromMs: Math.min(gapUnread.fromMs, from), throughMs: Math.max(gapUnread.throughMs, at) };
  };
  const priorCursors = opts.cursors && typeof opts.cursors === 'object' ? opts.cursors : {};
  const extraRoots = Array.isArray(opts.extraRoots) ? opts.extraRoots.filter((r) => typeof r === 'string') : null;
  // An archive built before the Cowork trees were read has none of their
  // history: their files are read once, whatever their cursors say, and what
  // predates the archive's frontier is folded in (owner, 2026-09-29).
  const extraFold = archiving && !backfill && extraRoots !== null
    && !archiveMod.hasSource(priorArchive, COWORK_SOURCE);
  let extraUnread = null;
  const extraUnreadThrough = (ms) => {
    if (!extraFold) return;
    const at = Number.isFinite(ms) ? Math.min(ms, priorArchive.frontierMs) : priorArchive.frontierMs;
    extraUnread = extraUnread === null
      ? { fromMs: 0, throughMs: at }
      : { fromMs: 0, throughMs: Math.max(extraUnread.throughMs, at) };
  };

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
      archive: opts.archive || null,
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
      archive: opts.archive || null,
      stats: { filesSeen: 0, filesParsed: 0, filesFailed: 0, bytesParsed: 0, records: 0, failedLines: 0, ms: Date.now() - started },
    };
  }

  const extraIds = new Set();
  for (const extraRoot of extraRoots || []) {
    let w;
    try {
      w = await walkJsonlFiles(extraRoot, { maxDepth: opts.maxDepth });
    } catch (err) {
      log.fileFailure('extra-root', err);
      w = { files: [], truncated: false, unreadable: 1, rootError: null };
    }
    if (w.rootError && w.rootError !== 'ENOENT') w.unreadable += 1;
    for (const f of w.files) {
      extraIds.add(f.id);
      walked.files.push(f);
    }
    if (w.truncated) walked.truncated = true;
    walked.unreadable += w.unreadable;
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
  if (walked.truncated || walked.unreadable > 0) {
    unreadThrough(now);
    gapUnreadThrough(now);
    extraUnreadThrough(now);
  }

  for (const file of walked.files) {
    const prev = priorCursors[file.id];
    const folding = extraFold && extraIds.has(file.id);
    const forceRead = backfill || folding;
    const sameFile = prev && prev.size === file.size && prev.mtimeMs === file.mtimeMs;
    // A cursor from before the loss accounting carries no `droppedLines`: its
    // file is re-read once while inside retention, so an old loss is counted.
    const accounted = Boolean(prev) && Number.isSafeInteger(prev.droppedLines);
    const unchanged = !forceRead && sameFile && (accounted || file.mtimeMs < cutoff)
      && !(rewound && file.mtimeMs >= frontier);

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
        // The days the archive takes in now keep their known loss (review F4).
        if (dropped > 0) gapUnreadThrough(file.mtimeMs);
      }
      const carried = priorByFile.get(file.id);
      if (carried) for (const ev of carried) events.push(ev);
      continue;
    }

    // Never-seen file that is older than the retention window AND than the
    // archive's frontier: record the cursor so we do not consider it again,
    // but never open it. One written after the archive's frontier may hold a
    // day the archive is about to take in (the app was closed for a while).
    if (!forceRead && !prev && file.mtimeMs < cutoff && file.mtimeMs < gapFrom) {
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
      // A torn LAST line is the file's newest record: in a file written after
      // the frontier it is not in any day the archive holds (review F5).
      const tornLost = torn > 0 ? 0 : (res.failedUnterminated || 0);
      if (dropped - (file.mtimeMs >= frontier ? tornLost : 0) > 0) gapUnreadThrough(file.mtimeMs);
      if (folding && dropped > 0) extraUnreadThrough(file.mtimeMs);
    } catch (err) {
      filesFailed += 1;
      if (!err || err.code !== 'ENOENT') {
        unreadThrough(file.mtimeMs);
        gapUnreadThrough(file.mtimeMs);
        if (folding) extraUnreadThrough(file.mtimeMs);
      }
      log.fileFailure(file.id, err);
      // Keep whatever we already had for this file rather than dropping it,
      // and keep the OLD cursor so the next scan retries the read.
      if (prev) cursors[file.id] = prev;
      const carried = priorByFile.get(file.id);
      if (carried) for (const ev of carried) events.push(ev);
    }
  }

  const result = (kept, archive) => ({
    ok: true,
    cursors,
    events: kept,
    archive,
    archiveChanged: archiving && archive !== opts.archive,
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
  });

  if (!archiving) {
    // Files that disappeared from the tree drop out of both maps implicitly:
    // they were never added to `cursors`, and their events were never carried.
    const kept = events.filter((ev) => ev.ts >= cutoff);
    return result(kept, null);
  }

  // A transcript that disappeared (Claude Code's own cleanup, a deleted
  // project) keeps its records here until the archive has taken them in:
  // the usage happened (review F6). Its cursor is gone, so it is never read.
  const walkedIds = new Set(walked.files.map((f) => f.id));
  for (const [id, bucket] of priorByFile) {
    if (!walkedIds.has(id)) for (const ev of bucket) events.push(ev);
  }

  // One response is several lines under one request id, each with its own
  // time. The EARLIEST line decides the side of the frontier for all of
  // them, the same instant the dedupe keeps: split by line, a response
  // across midnight would be counted on both sides (review F1).
  const firstTs = new Map();
  for (const ev of events) {
    const t = firstTs.get(ev.key);
    if (t === undefined || ev.ts < t) firstTs.set(ev.key, ev.ts);
  }
  const kept = events.filter((ev) => firstTs.get(ev.key) >= cutoff);
  // An archive that did not move is handed back as the SAME object it came
  // in as: the history memo keys on identity.
  let archive = opts.archive;
  if (needGap) {
    const gap = events.filter((ev) => {
      const t = firstTs.get(ev.key);
      return t >= gapFrom && t < frontier;
    });
    archive = archiveMod.advance(priorArchive, frontier, gap, gapUnread);
  } else if (rewound) {
    archive = priorArchive;
  }
  if (extraFold) {
    const before = events.filter((ev) => extraIds.has(ev.f) && firstTs.get(ev.key) < gapFrom);
    archive = archiveMod.foldSource(archive, COWORK_SOURCE, before, extraUnread);
  } else if (backfill && extraRoots !== null) {
    archive = archiveMod.withSource(archive, COWORK_SOURCE);
  }
  return result(kept, archive);
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
