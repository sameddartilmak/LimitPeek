'use strict';

/**
 * Which commit an installed binary was built from.
 *
 * Until 0.2.0 every build reported version 0.1.0, so nothing on an installed
 * machine said which build it was, and a rollback target could not be named.
 * The version now moves per release; this adds the commit, so two builds of
 * the same version are distinguishable too, and a backup can be matched to its
 * source by reading the tray menu instead of guessing.
 *
 * `build-info.json` is written at package time by `scripts/write-build-info.js`
 * and is NOT committed (it would always describe the commit before the one it
 * is in). A dev run or a missing file simply shows the version alone: an
 * absent commit is stated by omission, never invented.
 */

const SHA_RE = /^[0-9a-f]{7,40}$/;

/**
 * @param {string} version  app.getVersion()
 * @param {unknown} info    parsed build-info.json, or null
 * @returns {string}        e.g. "LimitPeek 0.2.1 · 1a2b3c4"
 */
function versionLabel(version, info) {
  const base = `LimitPeek ${version}`;
  if (!info || typeof info !== 'object') return base;
  const sha = /** @type {{sha?: unknown}} */ (info).sha;
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) return base;
  // A tree with uncommitted changes is not the commit it names; say so.
  const dirty = /** @type {{dirty?: unknown}} */ (info).dirty === true;
  return `${base} · ${sha.slice(0, 7)}${dirty ? '+' : ''}`;
}

module.exports = { versionLabel };
