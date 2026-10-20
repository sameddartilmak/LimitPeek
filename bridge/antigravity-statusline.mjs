#!/usr/bin/env node
/**
 * LimitPeek — Antigravity (`agy` CLI) statusline bridge.
 *
 * Structural twin of `claude-statusline.mjs`. Per
 * https://antigravity.google/docs/cli/statusline/ the CLI runs the command
 * configured under `statusLine` in `~/.gemini/antigravity-cli/settings.json`
 * whenever the agent state changes, pipes a state JSON payload to this
 * script's stdin, and renders whatever we write to stdout.
 *
 * That payload's `quota` object is the ONLY server-computed statement about
 * how much of the user's quota is left — the doc describes it as a map from
 * model/bucket id to `{ remaining_fraction, reset_time, reset_in_seconds }`.
 * We capture just those three numbers per bucket. Everything else is ignored.
 *
 * Security contract (same as the Claude bridge, ADR-001 security F1/F3/F11):
 *   - writes ONLY numeric quota fields, their bucket ids, and a capture stamp
 *   - the payload also carries `cwd`, `transcript_path`, `workspace`,
 *     `email`, `vcs.branch` and `model` — NONE of them is read or written here
 *   - never opens a network connection
 *   - never touches any credential store
 *   - never throws: a crash here would break the user's status line
 *
 * Deliberately NOT converted here: `remaining_fraction` is written verbatim,
 * as the CLI stated it. The remaining -> used conversion happens exactly once,
 * in `src/core/ratelimits.js`, so this file stays a faithful, auditable copy
 * of what Antigravity said rather than an interpretation of it.
 */
import { mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const OUT_DIR = join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'UsageNotch');
const OUT_FILE = join(OUT_DIR, 'antigravity-quota.json');

/** Bound on what we copy out of `quota`. A payload with thousands of buckets
 *  is a malformed or hostile one, and this file must stay small. When the cap
 *  bites we say so — see `truncated` in the snapshot below. */
const MAX_BUCKETS = 16;
const MAX_ID_LEN = 64;

/**
 * Control, zero-width and bidi-override characters, the same class and for the
 * same reason as `CONTROL_CHARS` in `src/renderer/src/sanitize.ts`: a string
 * carrying U+202E visually reverses everything printed after it. A bucket id
 * is echoed into the user's status line beside a percentage, so 64 harmless
 * characters are enough to render `10% left` as `tfel %01` — a false statement
 * about remaining quota, which is the one thing this project exists to
 * prevent.
 *
 * Stripped, never rejected wholesale, and deliberately NOT a general non-ASCII
 * filter: a legitimate id may be any word the CLI chooses, and truncating it
 * would lose a bucket over its spelling.
 */
const CONTROL_CHARS =
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    const timer = setTimeout(() => resolve(buf), 2000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(buf); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(buf); });
  });
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The reset instant, as an ISO string. The doc gives `reset_time` as an
 * RFC3339 instant ("2026-07-06T07:50:32Z"); we re-emit it normalised so the
 * reader never has to parse an arbitrary string, and null when it will not
 * parse. `reset_in_seconds` is kept alongside it, unused by the reader but
 * recorded because it is the CLI's own statement and disagreement between the
 * two is worth being able to see.
 */
function isoOrNull(v) {
  if (typeof v !== 'string' || v.length === 0 || v.length > 64) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Bucket ids come from the CLI. They name a quota pool, not user content — but
 * they are still foreign strings that get both written to a file and printed
 * to the user's terminal, so they are stripped and bounded before being kept.
 *
 * Order matters: strip first, then measure. Measuring first would let an id
 * pass the length check on the strength of characters that are about to be
 * removed.
 */
function safeId(id) {
  if (typeof id !== 'string') return null;
  const clean = id.replace(CONTROL_CHARS, '');
  return clean.length > 0 && clean.length <= MAX_ID_LEN ? clean : null;
}

/**
 * tmp + rename, with the one failure Windows adds to it.
 *
 * Two agy sessions fire this hook independently, and on Windows a rename onto
 * a target that another process is renaming over at that instant is refused
 * with EPERM (EACCES/EBUSY when an AV scanner or indexer holds the file). The
 * refusal is transient, so it is retried a bounded number of times — about a
 * quarter of a second in total, well inside a status-line render. Whatever
 * happens, the temp file is removed: a `<pid>.tmp` left behind is never read
 * and never cleaned up, and a new one would accumulate on every refusal.
 *
 * Rename is still what makes this safe to race: each writer's capture lands
 * whole or not at all, never spliced with another's.
 */
const RENAME_TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 8;
const RENAME_BACKOFF_MS = 8;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeWhole(file, text) {
  const tmp = file + '.' + process.pid + '.tmp';
  try {
    writeFileSync(tmp, text, 'utf8');
    for (let attempt = 1; ; attempt += 1) {
      try {
        renameSync(tmp, file);
        return;
      } catch (err) {
        if (attempt >= RENAME_ATTEMPTS || !RENAME_TRANSIENT.has(err && err.code)) throw err;
        sleepSync(attempt * RENAME_BACKOFF_MS);
      }
    }
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best effort: it may never have been created */ }
    throw err;
  }
}

function pickBucket(b) {
  if (!b || typeof b !== 'object') return null;
  return {
    remainingFraction: num(b.remaining_fraction),
    resetTime: isoOrNull(b.reset_time),
    resetInSeconds: num(b.reset_in_seconds),
  };
}

try {
  const raw = await readStdin();
  let payload = null;
  try { payload = JSON.parse(raw); } catch { payload = null; }

  const q = payload && typeof payload.quota === 'object' ? payload.quota : null;
  const present = q != null && !Array.isArray(q);

  const buckets = {};
  const ids = present ? Object.keys(q).sort() : [];
  // The cap is applied after a deterministic sort, which means it drops
  // alphabetically LAST. That is arbitrary with respect to consumption: the
  // bucket it discards may be the most consumed one, and the reader picks the
  // most consumed bucket as the binding constraint. Silently keeping 16 of 17
  // would therefore let a size guard produce an OPTIMISTIC figure. So we
  // record that it happened, and the reader refuses to present a maximum it
  // has been told may be incomplete.
  const truncated = ids.length > MAX_BUCKETS;
  for (const id of ids.slice(0, MAX_BUCKETS)) {
    const key = safeId(id);
    if (key === null) continue;
    const picked = pickBucket(q[id]);
    if (picked) buckets[key] = picked;
  }

  const snapshot = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    present,
    quota: buckets,
    truncated,
    // diagnostic only: which top-level keys the payload carried. No values.
    payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload).sort() : [],
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeWhole(OUT_FILE, JSON.stringify(snapshot, null, 2));

  // Render something useful so the user's status line is not blank.
  //
  // Stated as REMAINING, the word the payload uses, and therefore with no
  // conversion in this file. Printing a used percentage here would be a second
  // conversion site that could silently disagree with the app's.
  //
  // Language-neutral like the Claude bridge (ADR-004 A1, ruling 5), with ONE
  // short word: `left`. A bare `94%` beside Claude's USED figures would read
  // as 94% used, a false claim; the neutral vocabulary is already short
  // English (`5h`, `7d`), and `left` joins it.
  //
  // The range test is the SAME one `usedFromRemaining` in
  // `src/core/ratelimits.js` applies, on purpose. A fraction of 1.4 is proof
  // the producer is wrong; the app refuses it, and this line must refuse it
  // too, or the status line prints `140% left` beside a panel row that shows
  // nothing at all. Two surfaces reading one number must not disagree about
  // when that number is unusable.
  const parts = [];
  for (const [id, b] of Object.entries(buckets)) {
    const f = b.remainingFraction;
    if (typeof f !== 'number' || !Number.isFinite(f) || f < 0 || f > 1) continue;
    parts.push(`${id} ${(f * 100).toFixed(0)}% left`);
  }
  // The fallback is the product name: language-neutral, see the Claude bridge.
  process.stdout.write(parts.length ? parts.join(' · ') : 'LimitPeek');
} catch {
  process.stdout.write('');
}

// Deliberately NOT process.exit(). Same reason as the Claude bridge: on
// Windows stdout to a pipe is asynchronous, and exiting discards whatever has
// not been flushed, which makes the user's status line render blank or
// truncated at random.
process.exitCode = 0;
