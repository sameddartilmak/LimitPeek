'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Finds the Antigravity IDE install whose state store was written most
 * recently — GUARD 1, and the reason the user approved reading this store at
 * all.
 *
 * The failure it exists to prevent actually happened, to us, during design:
 * the product renamed its install directory from `Antigravity` to
 * `Antigravity IDE`, a hard-coded path kept resolving to the abandoned one,
 * and the read returned a 112-day-old snapshot AS IF IT WERE CURRENT. A
 * confident wrong number is the single thing this project exists to prevent,
 * and a hard-coded directory name is enough to produce one.
 *
 * So the directory is never named in code as a constant to trust. We enumerate
 * everything under %APPDATA% whose name begins with "antigravity", keep the
 * ones that actually hold a state store, and pick the newest by mtime. A
 * future rename is then a no-op rather than a silent regression, and the
 * abandoned install loses on age the moment the new one is written.
 *
 * Nothing here opens the store. This module only decides WHICH file, and
 * reports every candidate it saw so the choice can be logged and argued with.
 */

/** Roaming AppData. The env var is what Windows itself uses. */
function appDataDir() {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

/**
 * Deliberately a prefix match and nothing cleverer.
 *
 * `Antigravity`, `Antigravity IDE`, a hypothetical `Antigravity IDE 2` and an
 * un-spaced `AntigravityIDE` all match. The real filter is the one below it —
 * a candidate only counts if it actually contains a state store — so a loose
 * name test costs nothing and a tight one would reintroduce exactly the
 * brittleness this module exists to remove.
 */
const NAME = /^antigravity/i;

/** Where an Electron-based IDE keeps its global state store. */
function storePathFor(root) {
  return path.join(root, 'User', 'globalStorage', 'state.vscdb');
}

/**
 * Every install that has a readable state store, newest first.
 *
 * @param {string} [dir] the AppData directory to scan; defaults to the real one
 * @returns {Array<{name:string, root:string, file:string, mtimeMs:number, size:number}>}
 */
function antigravityIdeCandidates(dir) {
  const base = dir || appDataDir();
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    // No %APPDATA%, or we cannot list it. Not an error: it means no install.
    return [];
  }

  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !NAME.test(entry.name)) continue;
    const root = path.join(base, entry.name);
    const file = storePathFor(root);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    found.push({ name: entry.name, root, file, mtimeMs: st.mtimeMs, size: st.size });
  }

  // Newest first. The tie-break is the name, so the choice is deterministic
  // and two runs a millisecond apart cannot disagree about which install is
  // "the" one.
  found.sort((a, b) => (b.mtimeMs - a.mtimeMs) || a.name.localeCompare(b.name));
  return found;
}

/**
 * The store to read, or null when there is no install.
 *
 * @returns {{file:string, root:string, name:string, mtimeMs:number,
 *            candidates:Array}|null}
 */
function resolveAntigravityIdeStore(dir) {
  const candidates = antigravityIdeCandidates(dir);
  if (candidates.length === 0) return null;
  const chosen = candidates[0];
  return { ...chosen, candidates };
}

module.exports = { appDataDir, antigravityIdeCandidates, resolveAntigravityIdeStore, storePathFor, NAME };
