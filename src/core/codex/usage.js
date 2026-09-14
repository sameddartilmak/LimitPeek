'use strict';
/**
 * Codex TOKEN usage and its notional API cost, read from the same session
 * rollout logs the rate-limit reader uses.
 *
 * WHERE THE NUMBERS COME FROM (and why it is honest)
 * --------------------------------------------------
 * Every Codex turn appends a `token_count` event whose `last_token_usage` is
 * that turn's exact token split, measured by Codex itself:
 *
 *   last_token_usage: { input_tokens, cached_input_tokens,
 *                       cache_write_input_tokens, output_tokens,
 *                       reasoning_output_tokens, total_tokens }
 *
 * These are COUNTS the tool recorded, not anything we derive — so summing the
 * per-turn deltas whose timestamp falls in a window gives that window's real
 * usage. The cost is those counts multiplied by OpenAI's PUBLISHED per-token
 * prices (pricing table below), framed exactly as Claude's is: never a bill,
 * "what this would have cost on the API" — the user is on a subscription.
 *
 * `input_tokens` is the WHOLE prompt including the cached part, so the
 * full-price ("input") share is `input_tokens - cached_input_tokens`, and the
 * cached share is billed at OpenAI's discounted cached-input rate. Output and
 * reasoning tokens both bill at the output rate.
 *
 * WINDOWING ACROSS STALE MTIMES
 * -----------------------------
 * Codex keeps a session's rollout OPEN and appends without updating the file's
 * mtime, and a long session's file stays in its START-date folder while it
 * keeps taking turns. So a window cannot be resolved by file mtime or folder
 * date alone. Instead we scan the newest `DAY_SPAN` day-folders (enough to
 * catch a session opened well before the window that is still appending) and
 * keep only the `token_count` events whose OWN timestamp lands in the window.
 */

const fs = require('node:fs');
const path = require('node:path');
const { codexHome, codexSessionsDir } = require('./rollout');

/** How many newest day-folders to scan. A weekly window plus slack for a
 *  session that opened before it and is still live. */
const DAY_SPAN = 14;

/** Per-file cap, same spirit as the rollout tail read: never load an
 *  unbounded log whole. A whole-file read is needed here (events are spread
 *  through the file, not just at the tail), so the cap guards memory. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

/** The session model, from the rollout's `session_meta` (first line). */
function sessionModel(firstLine) {
  try {
    const o = JSON.parse(firstLine);
    const s = JSON.stringify(o);
    const m = /"model"\s*:\s*"([^"]+)"/.exec(s);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** The `token_count` turn deltas in a rollout whose timestamp is in [startMs, endMs). */
function eventsFromFile(file, startMs, endMs, out) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return;
  }
  if (stat.size > MAX_FILE_BYTES) return; // pathological; skip rather than OOM
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return;
  const model = sessionModel(lines[0]);
  for (const line of lines) {
    if (line.indexOf('token_count') === -1) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const p = o && o.payload;
    if (!p || p.type !== 'token_count' || !p.info) continue;
    const ts = Date.parse(o.timestamp);
    if (!Number.isFinite(ts) || ts < startMs || ts >= endMs) continue;
    const u = p.info.last_token_usage;
    if (!u || typeof u !== 'object') continue;
    // `input_tokens` is the WHOLE prompt; `cached_input_tokens` and
    // `cache_write_input_tokens` are disjoint subsets of it (OpenAI usage-object
    // convention), so the full-price share is what remains. `reasoning_output`
    // is a subset of `output_tokens`, NOT additive — adding it double-counts,
    // and on the reference session input+output already equals total.
    const inputTotal = num(u.input_tokens);
    const cached = num(u.cached_input_tokens);
    const write = num(u.cache_write_input_tokens);
    out.push({
      ts,
      model: typeof model === 'string' ? model : 'unknown',
      inputUncached: Math.max(0, inputTotal - cached - write),
      cachedInput: cached,
      cacheWrite: write,
      output: num(u.output_tokens),
    });
  }
}

/**
 * Every Codex turn delta between `startMs` and `now`, across the newest
 * `DAY_SPAN` day-folders. `startMs` is the earliest instant any caller needs
 * (e.g. one week back); each caller re-filters to its own window.
 */
function codexUsageEvents(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const startMs = Number.isFinite(options.startMs) ? options.startMs : now - 7 * 24 * 60 * 60 * 1000;
  const sessionsDir = codexSessionsDir(options.home);
  const out = [];

  // Collect day-folders (YYYY/MM/DD), newest first, capped at DAY_SPAN.
  const dayDirs = [];
  let years;
  try {
    years = fs.readdirSync(sessionsDir).sort().reverse();
  } catch {
    return out;
  }
  for (const y of years) {
    let months;
    try { months = fs.readdirSync(path.join(sessionsDir, y)).sort().reverse(); } catch { continue; }
    for (const m of months) {
      let days;
      try { days = fs.readdirSync(path.join(sessionsDir, y, m)).sort().reverse(); } catch { continue; }
      for (const d of days) {
        dayDirs.push(path.join(sessionsDir, y, m, d));
        if (dayDirs.length >= DAY_SPAN) break;
      }
      if (dayDirs.length >= DAY_SPAN) break;
    }
    if (dayDirs.length >= DAY_SPAN) break;
  }

  for (const dir of dayDirs) {
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!/^rollout-.*\.jsonl$/.test(f)) continue;
      eventsFromFile(path.join(dir, f), startMs, now, out);
    }
  }
  return out;
}

/** Sum a window's events into the row's TokenBreakdown shape. OpenAI has no
 *  cache-WRITE charge, so `cacheWrite` is the (usually zero) recorded count and
 *  `cacheRead` is the cached-input count; `billable` matches the app's rule
 *  `input + output + cacheWrite`. */
function sumCodexTokens(events, startMs, endMs) {
  const t = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, billable: 0 };
  const perModel = new Map();
  for (const ev of events) {
    if (ev.ts < startMs || ev.ts >= endMs) continue;
    t.input += ev.inputUncached;
    t.output += ev.output;
    t.cacheWrite += ev.cacheWrite;
    t.cacheRead += ev.cachedInput;
    const bill = ev.inputUncached + ev.output + ev.cacheWrite;
    perModel.set(ev.model, (perModel.get(ev.model) || 0) + bill);
  }
  t.billable = t.input + t.output + t.cacheWrite;
  const byModel = Array.from(perModel, ([model, billable]) => ({ model, billable }))
    .sort((a, b) => b.billable - a.billable || (a.model < b.model ? -1 : 1));
  return { tokens: t, byModel };
}

module.exports = {
  codexUsageEvents,
  sumCodexTokens,
  DAY_SPAN,
};
