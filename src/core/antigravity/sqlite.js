'use strict';

/**
 * Loads `node:sqlite` without letting its ExperimentalWarning reach the user.
 *
 * `node:sqlite` is built into the Node that Electron 44 ships, so this adds no
 * dependency and nobody has to carry a native module. It does print
 *
 *     ExperimentalWarning: SQLite is an experimental feature ...
 *
 * on first load, which in a packaged run is a line of Node internals appearing
 * in a user's console for a tray app. The suppression is scoped to that one
 * warning, restored immediately, and deliberately not `--no-warnings`: every
 * other warning this process can emit is one we want to see.
 *
 * Returns null rather than throwing when the module is unavailable. A Node
 * without it is a stated absence upstream, not a crash — this whole path is an
 * optional enrichment of one row.
 */

let cached;

function loadSqlite() {
  if (cached !== undefined) return cached;

  const previous = process.emitWarning;
  process.emitWarning = function filtered(warning, ...rest) {
    const message = typeof warning === 'string' ? warning : (warning && warning.message) || '';
    // The type arrives either as the second positional argument or as
    // `options.type`, and on an Error instance as its `name`.
    const type = typeof rest[0] === 'string'
      ? rest[0]
      : (rest[0] && rest[0].type) || (warning && warning.name) || '';
    if (String(type).includes('ExperimentalWarning') && /sqlite/i.test(message)) return undefined;
    return previous.call(process, warning, ...rest);
  };

  try {
    // eslint-disable-next-line global-require
    cached = require('node:sqlite');
  } catch {
    cached = null;
  } finally {
    process.emitWarning = previous;
  }
  return cached;
}

module.exports = { loadSqlite };
