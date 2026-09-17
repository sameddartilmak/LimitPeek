'use strict';
/**
 * Incremental line reading for append-only JSONL logs written by OTHER tools
 * (Gemini CLI chat recordings, Kimi Code wire journals).
 *
 * The same discipline as the Codex rollout reader (codex/usage.js), restated
 * here as a small shared module for the readers added after it rather than
 * refactoring that reader in the same change:
 *
 *  - A file is read from `entry.offset`, the byte after its last COMPLETE line,
 *    in chunks, so no file is ever loaded whole.
 *  - A trailing partial line is left for the next read (the writer may be
 *    mid-append), unless the file has been idle past TORN_WRITE_GRACE_MS, when
 *    it is read once as a final line (`settleTail`).
 *  - A line longer than MAX_LINE_BYTES is never decoded; its head is handed to
 *    `onOversize` so the caller can decide whether usage was lost.
 *
 * PRIVACY: nothing here decodes, keeps or logs a line. The caller's `onLine`
 * decides, from bytes, whether a line is worth decoding at all.
 */

const fs = require('node:fs');

const CHUNK_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const HEAD_BYTES = 256;
const TORN_WRITE_GRACE_MS = 5 * 60 * 1000;
const NL = 0x0a;

/**
 * Reads `file` from `entry.offset` to `size`, feeding complete lines to
 * `onLine(buf)`. Returns the bytes read, or -1 when the file could not be
 * opened or read (the caller must then treat the entry as unusable).
 *
 * @param {string} file
 * @param {{offset:number}} entry
 * @param {number} size
 * @param {(line: Buffer) => void} onLine
 * @param {(head: Buffer) => void} onOversize
 */
function readAppended(file, entry, size, onLine, onOversize) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return -1;
  }
  let bytes = 0;
  try {
    let pos = entry.offset;
    let carry = null;
    let skipping = false;
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK_BYTES, size - pos), pos);
      if (n <= 0) break;
      bytes += n;
      let start = 0;
      for (;;) {
        const nl = buf.indexOf(NL, start);
        if (nl === -1 || nl >= n) break;
        if (skipping) {
          skipping = false;
        } else if (carry) {
          const piece = buf.subarray(start, nl);
          if (carry.length + piece.length <= MAX_LINE_BYTES) onLine(Buffer.concat([carry, piece]));
          else onOversize(carry.subarray(0, HEAD_BYTES));
        } else {
          onLine(buf.subarray(start, nl));
        }
        carry = null;
        entry.offset = pos + nl + 1;
        start = nl + 1;
      }
      if (start < n && !skipping) {
        const rest = buf.subarray(start, n);
        const len = (carry ? carry.length : 0) + rest.length;
        if (len > MAX_LINE_BYTES) {
          onOversize(carry ? Buffer.concat([carry.subarray(0, HEAD_BYTES), rest.subarray(0, HEAD_BYTES)]) : rest.subarray(0, HEAD_BYTES));
          carry = null;
          skipping = true;
        } else {
          carry = carry ? Buffer.concat([carry, rest]) : Buffer.from(rest);
        }
      }
      pos += n;
    }
  } catch {
    bytes = -1;
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
  return bytes;
}

/**
 * An unterminated tail on a file idle for more than TORN_WRITE_GRACE_MS is not
 * a write in progress: it is read once as a final line and the offset moves
 * past it. If the file grows again, the byte before the new offset is not a
 * newline, so the caller's boundary check re-reads the file from the start.
 */
function settleTail(file, entry, size, mtimeMs, now, onLine, onOversize) {
  if (entry.offset >= size || !(mtimeMs < now - TORN_WRITE_GRACE_MS)) return;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const len = Math.min(size - entry.offset, MAX_LINE_BYTES + 1);
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, entry.offset);
    const line = buf.subarray(0, n);
    if (size - entry.offset > MAX_LINE_BYTES) onOversize(line.subarray(0, HEAD_BYTES));
    else onLine(line);
    entry.offset = size;
  } catch {
    // Left pending: the next scan tries again.
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/** Bytes kept from just before `entry.offset` to recognise an append. */
const TAIL_FINGERPRINT_BYTES = 64;

/** Up to 64 bytes ending at `offset`, or null when they cannot be read. */
function tailBytes(file, offset) {
  const len = Math.min(TAIL_FINGERPRINT_BYTES, offset);
  if (len === 0) return Buffer.alloc(0);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(len);
    return fs.readSync(fd, b, 0, len, offset - len) === len ? b : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/**
 * Did the file only GROW since `entry` was read (ADR-003 A6 review, F4)? The
 * bytes before the consumed offset must still be the ones read then. A single
 * newline byte is not enough: an atomic rewrite that happens to be longer can
 * put a newline there too, and appending from the old offset would count the
 * rewritten records twice. Callers store `entry.tail = tailBytes(file, offset)`
 * after every read.
 */
function isAppendOf(file, entry) {
  if (!entry || entry.offset === 0) return true;
  if (!Buffer.isBuffer(entry.tail)) return false;
  const now = tailBytes(file, entry.offset);
  return now !== null && now.equals(entry.tail) && now[now.length - 1] === NL;
}

/** Is the byte before `offset` a newline? Confirms an append did not rewrite
 *  the part of the file already consumed. */
function endsAtLineBoundary(file, offset) {
  if (offset === 0) return true;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(1);
    return fs.readSync(fd, b, 0, 1, offset - 1) === 1 && b[0] === NL;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

module.exports = {
  readAppended,
  settleTail,
  endsAtLineBoundary,
  MAX_LINE_BYTES,
  HEAD_BYTES,
  TORN_WRITE_GRACE_MS,
  tailBytes,
  isAppendOf,
};
