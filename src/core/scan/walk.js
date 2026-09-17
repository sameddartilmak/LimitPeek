'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fileId } = require('../ids');
const log = require('../log');

const DEFAULT_MAX_DEPTH = 10;
const DEFAULT_MAX_FILES = 20000;
const DEFAULT_MAX_DIRS = 20000;

/**
 * Recursive walk of the transcript tree.
 *
 * Measured on the reference corpus: 55 of 209 `.jsonl` files sit at
 * `projects/<slug>/<uuid>.jsonl`; the other 154 are nested under
 * `<uuid>/subagents/` and `<uuid>/subagents/workflows/<wf>/`. A non-recursive
 * glob loses 74% of them.
 *
 * Hardening (ADR-001, security F12):
 *   - depth limited
 *   - `withFileTypes` + explicit symlink/junction skip: we never follow a
 *     reparse point out of the tree
 *   - `lstat`, never `stat`, so a symlinked file is not silently resolved
 *   - strict `.jsonl` suffix: sibling `agent-*.meta.json` files exist
 *   - per-directory try/catch: one unreadable directory cannot end the scan
 */
async function walkJsonlFiles(root, options = {}) {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDirs = options.maxDirs ?? DEFAULT_MAX_DIRS;

  const out = [];
  const queue = [{ dir: root, depth: 0 }];
  let dirsVisited = 0;
  let truncated = false;
  // Distinguished from a per-directory failure: if the ROOT cannot be read we
  // must not report "no usage" as though it were a fact.
  let rootError = null;
  // Directories and files that exist but could not be read (locked, access
  // denied). Their transcripts drop out of the scan, so the cost reader must
  // be able to say it KNOWS it missed records (ADR-002 A3.15). A path that
  // vanished between listing and reading (ENOENT) is gone, not unreadable.
  let unreadable = 0;

  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    if (depth > maxDepth) continue;
    if (++dirsVisited > maxDirs) { truncated = true; break; }

    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (dir === root) rootError = (err && err.code) || 'EREADDIR';
      else if (!err || err.code !== 'ENOENT') unreadable += 1;
      log.fileFailure(fileId(dir), err);
      continue;
    }

    for (const entry of entries) {
      // Symlinks and NTFS junctions are reported here as symbolic links.
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (depth < maxDepth) queue.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.jsonl')) continue;
      if (out.length >= maxFiles) { truncated = true; break; }

      let st;
      try {
        st = await fs.promises.lstat(full);
      } catch (err) {
        if (!err || err.code !== 'ENOENT') unreadable += 1;
        log.fileFailure(fileId(full), err);
        continue;
      }
      if (!st.isFile()) continue;

      out.push({ path: full, id: fileId(full), size: st.size, mtimeMs: st.mtimeMs });
    }
    if (truncated) break;
  }

  return { files: out, dirsVisited, truncated, rootError, unreadable };
}

module.exports = { walkJsonlFiles, DEFAULT_MAX_DEPTH };
