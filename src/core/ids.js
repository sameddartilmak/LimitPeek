'use strict';
const crypto = require('node:crypto');

/**
 * Stable, non-reversible id for a transcript file.
 *
 * Why hash instead of storing the path: Claude Code encodes the project's
 * working directory into the directory name (`projects/C--Users-me-Projects-x`).
 * Persisting raw paths would put the user's cwd into our snapshot file, which
 * the parse-discipline constraint forbids. The hash is enough — we only ever
 * need to answer "is this the same file as last scan?".
 */
function fileId(absolutePath) {
  return crypto.createHash('sha256').update(String(absolutePath)).digest('hex').slice(0, 16);
}

module.exports = { fileId };
