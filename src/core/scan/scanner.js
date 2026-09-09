'use strict';
const fs = require('node:fs');
const { walkJsonlFiles } = require('./walk');
const { extractEvents } = require('./parse');
const log = require('../log');

const DAY_MS = 24 * 60 * 60 * 1000;
/** Events are kept for 8 days: the 7-day window plus a day of slack. */
const RETENTION_DAYS = 8;

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

  for (const file of walked.files) {
    const prev = priorCursors[file.id];
    const unchanged = prev && prev.size === file.size && prev.mtimeMs === file.mtimeMs;

    if (unchanged) {
      cursors[file.id] = { size: file.size, mtimeMs: file.mtimeMs };
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
      cursors[file.id] = { size: file.size, mtimeMs: file.mtimeMs };
    } catch (err) {
      filesFailed += 1;
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

module.exports = { scan, RETENTION_DAYS, DAY_MS };
