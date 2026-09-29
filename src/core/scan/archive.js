'use strict';
const pricing = require('../pricing');
const agg = require('../aggregate');

/**
 * The Claude usage archive: what the week/month history needs from records
 * older than the scanner's raw retention (8 days), kept as one row per
 * (local day, model, speed).
 *
 * Raw events are the right shape for the 5-hour and 7-day windows, but a
 * year of them is tens of MB rewritten on every scan, and Claude Code deletes
 * its own transcripts after a while — so without this the history showed
 * nothing before last week (owner, 2026-09-28: July and August empty).
 *
 * A row carries the summed token classes plus the counters pricing needs to
 * keep its floor honest: `n` records, `nCw` records with cache writes and
 * `nFb` of those priced at the 5-minute fallback. Its cache writes are stored
 * ALREADY split (`cacheWrite === cw5 + cw1h`), so the per-record fallback
 * decision is made once, here, from the record itself, and never re-derived
 * from a sum.
 *
 * `frontierMs` is a local midnight: rows hold everything before it, the raw
 * store everything from it on. It only moves forward. `unread` is the hull of
 * old records a read KNOWS it missed (an unreadable transcript, lost lines),
 * so the periods it overlaps are floors, never a silent zero.
 *
 * No path, no key, no text: numbers, a model id and a speed.
 */

const ARCHIVE_VERSION = 1;
/** A bound, not a budget: 12 months x a handful of models is ~2,000 rows. */
const MAX_ROWS = 20000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Longer than the 12 months the history shows, with room to spare. */
const KEEP_DAYS = 400;

function emptyArchive() {
  return { version: ARCHIVE_VERSION, frontierMs: null, rows: [], unread: null };
}

/** Local midnight of the day containing `ms`. */
function dayStartMs(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** The raw-retention boundary for `now`, on a local midnight. */
function frontierFor(now, retentionDays, dayMs) {
  return dayStartMs(now - retentionDays * dayMs);
}

const COUNT_FIELDS = ['input', 'output', 'cacheWrite', 'cacheRead', 'cw5', 'cw1h', 'n', 'nCw', 'nFb'];

function isRow(r) {
  return Boolean(r) && typeof r === 'object'
    && Number.isFinite(r.ts)
    && typeof r.model === 'string'
    && (r.speed === undefined || typeof r.speed === 'string')
    && COUNT_FIELDS.every((k) => Number.isFinite(r[k]) && r[k] >= 0);
}

function isRange(r) {
  return Boolean(r) && typeof r === 'object' && Number.isFinite(r.fromMs) && Number.isFinite(r.throughMs);
}

/** A persisted archive, validated; anything malformed reads as none. */
function fromStored(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== ARCHIVE_VERSION) return null;
  if (!Number.isFinite(raw.frontierMs) || !Array.isArray(raw.rows)) return null;
  if (raw.rows.length > MAX_ROWS || !raw.rows.every(isRow)) return null;
  const out = {
    version: ARCHIVE_VERSION,
    frontierMs: raw.frontierMs,
    rows: raw.rows,
    unread: isRange(raw.unread) ? { fromMs: raw.unread.fromMs, throughMs: raw.unread.throughMs } : null,
  };
  const sources = sourcesOf(raw);
  if (sources.length > 0) out.sources = sources;
  return out;
}

/**
 * Transcript sources whose history before the frontier the archive already
 * holds, beyond Claude Code's own `projects` tree (always included). A source
 * added later (Cowork, 2026-09-29) is folded in once, from its files, by
 * `foldSource`; its name here is what stops a second fold.
 */
function sourcesOf(archive) {
  const s = archive && archive.sources;
  return Array.isArray(s) ? s.filter((x) => typeof x === 'string' && x.length <= 32).slice(0, 8) : [];
}

function hasSource(archive, name) {
  return sourcesOf(archive).includes(name);
}

/** The archive, recorded as holding `name`'s history. */
function withSource(archive, name) {
  if (hasSource(archive, name)) return archive;
  return { ...archive, sources: [...sourcesOf(archive), name] };
}

/**
 * A new source's records from before the archive's frontier, folded in once.
 * `events` are raw (every line of each response); deduped here, and only the
 * ones before the frontier are taken: the rest belong to the raw store.
 */
function foldSource(prior, name, events, unread) {
  const before = agg.dedupe(events).filter((ev) => ev.ts < prior.frontierMs);
  return withSource({
    ...prior,
    rows: fold(prior.rows, before),
    unread: hull(prior.unread, unread),
  }, name);
}

function rowKey(ts, model, speed) {
  return `${ts}|${model}|${speed || ''}`;
}

/**
 * `rows` plus `events` folded in by (local day, model, speed). `events` MUST
 * already be deduped. A new array of new objects: the input rows are cached
 * by the caller and are never mutated.
 */
function fold(rows, events) {
  const byKey = new Map();
  const out = [];
  for (const r of rows) {
    const copy = { ...r };
    byKey.set(rowKey(r.ts, r.model, r.speed), copy);
    out.push(copy);
  }
  for (const ev of events) {
    const ts = dayStartMs(ev.ts);
    const speed = typeof ev.speed === 'string' && ev.speed.length > 0 ? ev.speed : undefined;
    const key = rowKey(ts, ev.model, speed);
    let row = byKey.get(key);
    if (!row) {
      row = { ts, model: ev.model, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cw5: 0, cw1h: 0, n: 0, nCw: 0, nFb: 0 };
      if (speed) row.speed = speed;
      byKey.set(key, row);
      out.push(row);
    }
    const split = pricing.cacheWriteSplit(ev);
    const written = split.write5m + split.write1h;
    row.input += num(ev.input);
    row.output += num(ev.output);
    row.cacheRead += num(ev.cacheRead);
    row.cw5 += split.write5m;
    row.cw1h += split.write1h;
    row.cacheWrite += written;
    row.n += 1;
    if (written > 0) {
      row.nCw += 1;
      if (!split.fromBreakdown) row.nFb += 1;
    }
  }
  out.sort((a, b) => (a.ts - b.ts) || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0)
    || ((a.speed || '') < (b.speed || '') ? -1 : (a.speed || '') > (b.speed || '') ? 1 : 0));
  return out;
}

function hull(a, b) {
  if (!a) return b;
  if (!b) return a;
  return { fromMs: Math.min(a.fromMs, b.fromMs), throughMs: Math.max(a.throughMs, b.throughMs) };
}

/**
 * The archive after moving its frontier to `frontierMs`: `gapEvents` are the
 * raw events (not yet deduped, every line of each response) this scan holds
 * for [old frontier, new frontier); a first build passes every record before
 * the new frontier.
 * A frontier that would move backwards leaves the archive as it is (the
 * scanner rewinds a future frontier itself).
 */
function advance(prior, frontierMs, gapEvents, gapUnread) {
  const base = prior || emptyArchive();
  if (base.frontierMs !== null && frontierMs <= base.frontierMs) {
    return base;
  }
  const from = base.frontierMs === null ? -Infinity : base.frontierMs;
  // Deduped FIRST, then placed by the survivor's (earliest) instant: every
  // line of one response lands on the same side (review F1).
  const inGap = agg.dedupe(gapEvents).filter((ev) => ev.ts >= from && ev.ts < frontierMs);
  // Rows older than any period the history can show are let go, so the
  // archive stays small for good instead of one day failing its row bound.
  const keepFrom = frontierMs - KEEP_DAYS * DAY_MS;
  const out = {
    version: ARCHIVE_VERSION,
    frontierMs,
    rows: fold(base.rows.filter((r) => r.ts >= keepFrom), inGap),
    unread: hull(base.unread, gapUnread),
  };
  const sources = sourcesOf(base);
  if (sources.length > 0) out.sources = sources;
  return out;
}

function num(v) {
  return Number.isFinite(v) ? v : 0;
}

module.exports = {
  ARCHIVE_VERSION,
  MAX_ROWS,
  emptyArchive,
  dayStartMs,
  frontierFor,
  fromStored,
  fold,
  advance,
  isRow,
  hasSource,
  withSource,
  foldSource,
};
