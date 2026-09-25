#!/usr/bin/env node
/**
 * Usage Notch — Claude Code statusline bridge.
 *
 * Claude Code invokes this on every status-line render and pipes a JSON payload
 * on stdin. That payload is the ONLY documented source of Anthropic's
 * server-computed rate-limit percentages (5h + 7d windows) and their reset
 * instants. We capture just those numbers to a small file that the tray app
 * reads. Everything else in the payload is ignored and never persisted.
 *
 * Security contract (security lane, F3/F11):
 *   - writes ONLY numeric rate-limit fields + a capture timestamp
 *   - never writes prompt/response text, cwd, file paths or credentials
 *   - never opens a network connection
 *   - never throws: a crash here would break the user's status line
 *
 * The status line text also shows the model, the session's elapsed time and
 * how full the context window is. All three come from the same stdin payload
 * (model.display_name, cost.total_duration_ms, context_window.used_percentage)
 * and are only printed, never written to OUT_FILE.
 */
import { mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const OUT_DIR = join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'UsageNotch');
const OUT_FILE = join(OUT_DIR, 'claude-rate-limits.json');

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
 * tmp + rename, with the one failure Windows adds to it.
 *
 * Two Claude Code sessions fire this hook independently, and on Windows a
 * rename onto a target that another process is renaming over at that instant
 * is refused with EPERM (EACCES/EBUSY when an AV scanner or indexer holds the
 * file). The refusal is transient, so it is retried a bounded number of times
 * — about a quarter of a second in total, well inside a status-line render.
 * Whatever happens, the temp file is removed: a `<pid>.tmp` left behind is
 * never read and never cleaned up, and a new one would accumulate on every
 * refusal.
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

function pickWindow(w) {
  if (!w || typeof w !== 'object') return null;
  return { usedPercentage: num(w.used_percentage), resetsAt: num(w.resets_at) };
}

/**
 * Elapsed session time as "12m" or "1h05m", from the payload's own
 * cost.total_duration_ms. Language-neutral like the rest of the line.
 */
function durationLabel(ms) {
  const v = num(ms);
  if (v == null || v < 0) return null;
  const totalMin = Math.floor(v / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
}

try {
  const raw = await readStdin();
  let payload = null;
  try { payload = JSON.parse(raw); } catch { payload = null; }

  const rl = payload?.rate_limits ?? null;
  const snapshot = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    present: rl != null,
    fiveHour: pickWindow(rl?.five_hour),
    sevenDay: pickWindow(rl?.seven_day),
    // diagnostic only: which top-level keys the payload carried. No values.
    payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload).sort() : [],
    rateLimitKeys: rl && typeof rl === 'object' ? Object.keys(rl).sort() : [],
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeWhole(OUT_FILE, JSON.stringify(snapshot, null, 2));

  // Render something useful so the user's status line is not blank.
  //
  // LANGUAGE-NEUTRAL (ADR-004 Amendment 1, ruling 5). This runs inside Claude
  // Code's terminal, not in our app, and has no access to the user's language
  // preference; reading a locale file from here would couple two processes for
  // one short string. `5h`/`7d` and a trailing percent read the same in both
  // languages, and the fallback is the product name, which is not translated.
  const f = snapshot.fiveHour?.usedPercentage;
  const d = snapshot.sevenDay?.usedPercentage;
  const model = typeof payload?.model?.display_name === 'string' && payload.model.display_name.trim().length > 0
    ? payload.model.display_name.trim()
    : null;
  const duration = durationLabel(payload?.cost?.total_duration_ms);
  const ctx = num(payload?.context_window?.used_percentage);
  const parts = [];
  if (model != null) parts.push(model);
  if (duration != null) parts.push(duration);
  if (f != null) parts.push(`5h ${f.toFixed(0)}%`);
  if (d != null) parts.push(`7d ${d.toFixed(0)}%`);
  if (ctx != null) parts.push(`ctx ${ctx.toFixed(0)}%`);
  process.stdout.write(parts.length ? parts.join(' · ') : 'Usage Notch');
} catch {
  process.stdout.write('');
}

// Deliberately NOT process.exit(). On Windows stdout to a pipe is
// asynchronous, and exiting discards whatever has not been flushed — which
// makes the user's status line render blank or truncated at random. Claude
// Code pipes this, so it is the common case, not the rare one. Once stdin has
// ended nothing keeps the event loop alive, so the process exits on its own
// as soon as the write drains.
process.exitCode = 0;
