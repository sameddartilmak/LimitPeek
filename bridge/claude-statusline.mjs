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
 *   - writes ONLY numeric rate-limit fields + a capture timestamp, and to its
 *     run log (see `recordRun`) those plus the outcome, Claude Code's version
 *     string and an 8-character session-id prefix, each shape-checked
 *   - never writes prompt/response text, cwd, file paths or credentials
 *   - never opens a network connection
 *   - never throws: a crash here would break the user's status line
 *
 * WHAT THE USER SEES: NOTHING OF OURS. Capturing is this script's only job; the
 * status line belongs to the user. With no status line of their own it prints
 * nothing, so Claude Code looks exactly as it did before Usage Notch. With one
 * of their own, the setup kept it in CHAIN_FILE next to this script, and this
 * script runs it with the same stdin and prints its output unchanged. That
 * command is one the user configured themselves and Claude Code was already
 * running; we only pass it the payload it would have received anyway.
 */
import { mkdirSync, writeFileSync, readFileSync, renameSync, unlinkSync, existsSync, appendFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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

/** The user's own status line, kept by the setup when it wired this script in. */
const CHAIN_FILE = join(dirname(fileURLToPath(import.meta.url)), 'claude-chain.json');
const CHAIN_TIMEOUT_MS = 3000;
const CHAIN_MAX_OUTPUT = 64 * 1024;

/**
 * The chained command, or null. A command naming this bridge is refused, so a
 * chain can never call itself.
 */
function chainedCommand() {
  try {
    const kept = JSON.parse(readFileSync(CHAIN_FILE, 'utf8'));
    const line = kept && kept.statusLine;
    if (!line || line.type !== 'command' || typeof line.command !== 'string') return null;
    const command = line.command.trim();
    if (command.length === 0 || command.includes('claude-statusline.mjs')) return null;
    return command;
  } catch {
    return null;
  }
}

/**
 * Claude Code on Windows runs its commands through Git Bash, so a user's line
 * written for bash (`~/...`, `$HOME`) is run by bash here too. Without it,
 * the platform shell.
 */
function shellFor(command) {
  const candidates = [process.env.CLAUDE_CODE_GIT_BASH_PATH, 'C:\\Program Files\\Git\\bin\\bash.exe'];
  if (process.platform === 'win32') {
    for (const bash of candidates) {
      if (typeof bash === 'string' && bash.length > 0 && existsSync(bash)) return { file: bash, args: ['-c', command], shell: false };
    }
    return { file: command, args: [], shell: true };
  }
  return { file: '/bin/sh', args: ['-c', command], shell: false };
}

function runChained(command, input) {
  const how = shellFor(command);
  const res = spawnSync(how.file, how.args, {
    input, encoding: 'utf8', timeout: CHAIN_TIMEOUT_MS, maxBuffer: CHAIN_MAX_OUTPUT,
    windowsHide: true, shell: how.shell,
  });
  return res && typeof res.stdout === 'string' ? res.stdout : '';
}

/**
 * Is `next` an OLDER reading than the capture already on disk?
 *
 * Every Claude Code session runs this hook with the rate limits of ITS OWN
 * last request. A session left idle since early in the window re-renders its
 * line with that old figure and, last writer wins, put 3% over the 37% an
 * active session had just written (owner, 2026-09-28: the panel read %3 / %10
 * while claude.ai read 30% / 15%). Within one window usage only ever grows,
 * so a LOWER figure for the same window, or a figure for an EARLIER window,
 * can only have come from an older request. Such a reading is not written.
 * A later window (one that has reset) is always newer and always written.
 */
const SAME_WINDOW_S = 300;

function readStored() {
  try {
    const stored = JSON.parse(readFileSync(OUT_FILE, 'utf8'));
    return stored && typeof stored === 'object' ? stored : null;
  } catch {
    return null;
  }
}

function olderThanStored(next, stored) {
  if (!stored) return false;
  for (const key of ['fiveHour', 'sevenDay']) {
    const s = stored[key];
    const n = next[key];
    if (!s || !n || num(s.resetsAt) === null || num(n.resetsAt) === null) continue;
    if (n.resetsAt < s.resetsAt - SAME_WINDOW_S) return true;
    const sameWindow = Math.abs(n.resetsAt - s.resetsAt) <= SAME_WINDOW_S;
    if (sameWindow && num(s.usedPercentage) !== null && num(n.usedPercentage) !== null
      && n.usedPercentage < s.usedPercentage) return true;
  }
  return false;
}

/**
 * One line per run in a small log next to the capture, so a capture that
 * stopped moving can be explained afterwards: was the bridge run at all, and
 * did it write or refuse? (Owner, 2026-10-09: the panel read "13 sa" old
 * while sessions were open, and nothing on disk could say why.)
 *
 * Numbers and short tokens only, the same contract as the capture: the time,
 * the outcome, the incoming and (on a refusal) the stored figures, Claude
 * Code's version, and the first 8 characters of the session id so two
 * sessions can be told apart. Two files of at most LOG_MAX_BYTES each: when
 * the log outgrows it, it becomes `.old` and a new one starts.
 */
const LOG_FILE = join(OUT_DIR, 'claude-bridge-log.jsonl');
const LOG_MAX_BYTES = 64 * 1024;

const token = (v, re) => (typeof v === 'string' && re.test(v) ? v : null);
const pair = (w) => (w ? [w.usedPercentage, w.resetsAt] : null);

function recordRun(outcome, next, stored, payload) {
  try {
    const line = {
      at: next.capturedAt,
      outcome,
      v: token(payload?.version, /^[0-9][0-9A-Za-z.+-]{0,31}$/),
      sid: token(typeof payload?.session_id === 'string' ? payload.session_id.slice(0, 8) : null, /^[0-9A-Za-z-]{1,8}$/),
      present: next.present,
      five: pair(next.fiveHour),
      seven: pair(next.sevenDay),
    };
    if (outcome === 'older-than-stored' && stored) {
      line.storedFive = pair(stored.fiveHour);
      line.storedSeven = pair(stored.sevenDay);
    }
    mkdirSync(OUT_DIR, { recursive: true });
    let size = 0;
    try { size = statSync(LOG_FILE).size; } catch { /* not there yet */ }
    if (size > LOG_MAX_BYTES) {
      try { renameSync(LOG_FILE, LOG_FILE + '.old'); } catch { /* another session rotated it */ }
    }
    appendFileSync(LOG_FILE, JSON.stringify(line) + '\n', 'utf8');
  } catch { /* the log is a diagnostic: it never costs the capture or the line */ }
}

function pickWindow(w) {
  if (!w || typeof w !== 'object') return null;
  return { usedPercentage: num(w.used_percentage), resetsAt: num(w.resets_at) };
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

  const stored = readStored();
  let outcome = 'written';
  try {
    if (olderThanStored(snapshot, stored)) {
      outcome = 'older-than-stored';
    } else {
      mkdirSync(OUT_DIR, { recursive: true });
      writeWhole(OUT_FILE, JSON.stringify(snapshot, null, 2));
    }
  } catch {
    // A failed capture must not take the user's own line with it.
    outcome = 'write-failed';
  }
  recordRun(outcome, snapshot, stored, payload);

  // The user's own line, or nothing (see the header).
  const command = chainedCommand();
  process.stdout.write(command ? runChained(command, raw) : '');
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
