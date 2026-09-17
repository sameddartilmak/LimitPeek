'use strict';
/**
 * Directory listing for the local readers added under ADR-003 Amendment 3/6
 * (Gemini CLI chats, Kimi Code sessions).
 *
 * LINKS ARE FOLLOWED ONLY AT THE ROOT (ADR-003 A6, Phase A review rulings).
 * The root (`~/.gemini/tmp`, `~/.kimi-code/sessions`) is resolved once by the
 * caller with the shared path guard (`codex/rollout.js` `resolveLocalDir`), so a
 * user who junctions a whole tree to another local drive still works. Below the
 * root:
 *  - only PLAIN directories are descended into. A symbolic link, a junction, or
 *    an entry whose type the platform did not report is skipped, never resolved:
 *    a junction inside `chats/` pointing at `~/.gemini` must not make the reader
 *    open `oauth_creds.json`.
 *  - FILES must be regular files; links are skipped here and again by the
 *    caller's lstat before any open.
 *  - every path handed out is checked to lie inside the resolved root
 *    (`isInside`: string prefix plus separator). Plain directories joined under
 *    a resolved root satisfy it by construction; the check guards the invariant.
 *
 * Accepted residual (ADR-003 A6 review rulings, as A3.4): a same-user process
 * swapping a plain directory for a link between listing and open.
 *
 * `onUnread()` is called when a directory that EXISTS could not be listed, so the
 * caller can mark the figure incomplete (ADR-002 A3.15). Nothing here logs a path.
 */

const fs = require('node:fs');
const path = require('node:path');

function isGone(err) {
  return Boolean(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'));
}

/** Is `p` strictly inside the directory `root` (both absolute, resolved)? */
function isInside(root, p) {
  if (typeof root !== 'string' || typeof p !== 'string') return false;
  const base = root.endsWith(path.sep) ? root : root + path.sep;
  return p.length > base.length && p.slice(0, base.length).toLowerCase() === base.toLowerCase();
}

/**
 * Entries of `dir` as Dirents, or [] when it is gone. A listing that failed for
 * any other reason calls `onUnread`.
 */
function listDir(dir, onUnread) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (!isGone(err) && onUnread) onUnread();
    return [];
  }
}

/**
 * Plain sub-directories of `dir`, sorted by name, as `{ name, dir }`.
 * `accept(name)` filters by name first. `root` is the resolved root every result
 * must stay inside. (`_label` is kept for call-site symmetry; nothing is resolved.)
 */
function childDirs(dir, root, onUnread, accept = () => true) {
  const out = [];
  for (const d of listDir(dir, onUnread)) {
    const name = d.name;
    if (!accept(name)) continue;
    if (!d.isDirectory() || d.isSymbolicLink()) continue;
    const joined = path.join(dir, name);
    if (!isInside(root, joined)) continue;
    out.push({ name, dir: joined });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** Regular-file names in `dir` accepted by `accept(name)`, sorted. */
function childFiles(dir, onUnread, accept) {
  const out = [];
  for (const d of listDir(dir, onUnread)) {
    if (!accept(d.name)) continue;
    if (!d.isFile() || d.isSymbolicLink()) continue;
    out.push(d.name);
  }
  return out.sort();
}

module.exports = { childDirs, childFiles, listDir, isInside };
