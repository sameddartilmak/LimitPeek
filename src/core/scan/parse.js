'use strict';
const log = require('../log');

const SYNTHETIC_MODEL = '<synthetic>';

/**
 * Only these fields are ever read out of a transcript record:
 *   timestamp, message.model, message.usage.{input_tokens, output_tokens,
 *   cache_creation_input_tokens, cache_read_input_tokens, speed,
 *   cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}},
 *   and the dedup identity (requestId / message.id / sessionId+uuid).
 *
 * The last three exist for ADR-002 pricing: a 1-hour cache write bills at
 * 2.0x the input rate against a 5-minute write's 1.25x, and `speed` selects
 * the fast price row. Both are numbers or a short enum, never free text.
 *
 * Never read: .content, .text, .toolUseResult, .cwd, .gitBranch, .summary,
 * .thinking, or anything under message.content. Nothing from this function's
 * output can contain user text.
 *
 * `message.usage.iterations[]` restates the same four counters per inference
 * iteration; adding it to the top level would double-count. Top level only.
 */

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * `usage.speed`, accepted only as a short lowercase token.
 *
 * It is an API enum, but it arrives from a file this app does not own, and it
 * ends up as a price-table lookup key. The shape guard keeps an arbitrary
 * string out of that path; anything rejected reads as standard, which is the
 * documented default. Never logged either way (parse discipline).
 */
function speedOf(usage) {
  const speed = usage.speed;
  if (typeof speed !== 'string') return null;
  if (!/^[a-z][a-z0-9_-]{0,15}$/.test(speed)) return null;
  return speed === 'standard' ? null : speed;
}

/**
 * Global dedup identity. Measured on the reference corpus: 9,789 of 18,282
 * usage-bearing records repeat a `requestId` (session resume and /compact
 * replay records into fresh files), so counting without this inflates totals
 * by 115.3%.
 */
function dedupKey(record, message, fid, lineIndex) {
  if (typeof record.requestId === 'string' && record.requestId.length > 0) {
    return record.requestId;
  }
  if (message && typeof message.id === 'string' && message.id.length > 0) {
    return message.id;
  }
  const sid = typeof record.sessionId === 'string' ? record.sessionId : '';
  const uuid = typeof record.uuid === 'string' ? record.uuid : '';
  // BOTH halves are required. With `||`, a record carrying a sessionId but no
  // uuid produces the key "<sid>:" for every record in that session, and the
  // global dedup then keeps exactly one of them — a silent, optimistic-biased
  // undercount. Falling through to the per-line key counts each record once
  // instead, which is the safe direction when identity is unknown.
  if (sid && uuid) return `${sid}:${uuid}`;
  return `#${fid}:${lineIndex}`;
}

/**
 * @param {string} text  whole file contents
 * @param {string} fid   hashed file id (never a path)
 * @returns {{events: Array, lines: number, parsed: number, failed: number}}
 */
function extractEvents(text, fid) {
  const events = [];
  let lines = 0;
  let parsed = 0;
  let failed = 0;

  let start = 0;
  const len = text.length;
  while (start <= len) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = len;
    const line = text.slice(start, end);
    const lineIndex = lines;
    start = end + 1;
    lines += 1;
    if (start > len && line.length === 0) break;

    // Cheap prefilter before JSON.parse. On the reference corpus this cuts
    // 47,709 candidate lines down to 18,289 actual parses.
    if (line.length < 32 || line.indexOf('"usage"') === -1) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      // The caught error is intentionally not inspected: JSON.parse embeds a
      // slice of the source text in its message.
      failed += 1;
      log.parseFailure(fid, lineIndex);
      continue;
    }
    if (!record || typeof record !== 'object') continue;

    const message = record.message;
    if (!message || typeof message !== 'object') continue;
    const usage = message.usage;
    if (!usage || typeof usage !== 'object') continue;

    const model = typeof message.model === 'string' ? message.model : null;
    // `<synthetic>` records carry zero tokens and no real model attribution.
    if (!model || model === SYNTHETIC_MODEL) continue;

    const ts = Date.parse(record.timestamp);
    if (!Number.isFinite(ts)) continue;

    const input = num(usage.input_tokens);
    const output = num(usage.output_tokens);
    const cacheRead = num(usage.cache_read_input_tokens);

    // Per-TTL cache writes, recorded verbatim: pricing.js reconciles them
    // against the total itself and uses the result to decide whether the
    // breakdown is usable, so neither counter is normalised or back-filled.
    const creation = usage.cache_creation;
    const hasCreation = creation && typeof creation === 'object';
    const cw5 = hasCreation ? num(creation.ephemeral_5m_input_tokens) : 0;
    const cw1h = hasCreation ? num(creation.ephemeral_1h_input_tokens) : 0;

    // Measured: 3 of 20,674 records on the reference corpus report
    // `cache_creation_input_tokens: 0` while carrying a real 1-hour write of
    // 1,280-1,592 tokens, with every other counter zero. Read from the top
    // level alone those records total zero and are DROPPED by the all-zero
    // guard below, so the tokens vanish from the breakdown as well as from the
    // cost. The larger of the two readings is the honest one: it never reduces
    // an observed count and never invents one, and where the two agree — the
    // other 20,671 — it changes nothing.

    const cacheWrite = Math.max(num(usage.cache_creation_input_tokens), cw5 + cw1h);
    if (input + output + cacheWrite + cacheRead === 0) continue;

    const event = {
      f: fid,
      ts,
      model,
      input,
      output,
      cacheWrite,
      cacheRead,
      cw5,
      cw1h,
      key: dedupKey(record, message, fid, lineIndex),
    };
    // Omitted when standard, which is the overwhelming majority: this object
    // is persisted once per record, and an absent field is the default.
    const speed = speedOf(usage);
    if (speed) event.speed = speed;

    events.push(event);
    parsed += 1;
  }

  return { events, lines, parsed, failed };
}

module.exports = { extractEvents, dedupKey, SYNTHETIC_MODEL };
