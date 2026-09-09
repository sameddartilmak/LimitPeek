'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { stripTypeScriptTypes } = require('node:module');

/**
 * Loads `src/renderer/src/format.ts` FROM SOURCE for the unit suites.
 *
 * Both `format.test.js` and `cost-format.test.js` used to strip the file and
 * import it from a `data:` URL, on the stated reasoning that a stale `dist/`
 * must never be able to make these tests pass. That reasoning still holds and
 * is preserved here.
 *
 * What changed: `format.ts` now imports `STATE_THRESHOLDS` from
 * `../../shared/contract.js` instead of restating 60/85/100 as literals
 * (code-reviewer F4 — the drift guard in contract-mirror.test.js keyed on the
 * string `export function stateFor`, so a rename disabled it silently; one
 * shared declaration removes the guard's reason to exist). A `data:` URL has
 * no path, so it cannot resolve a relative specifier.
 *
 * So the two sources are stripped into a throwaway mirror of the `src/` layout
 * in the OS temp directory, where that single relative import resolves. It is
 * still the source that runs; the mirror only supplies a resolution root, and
 * it is deleted afterwards.
 */
const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

function strip(file) {
  return stripTypeScriptTypes(fs.readFileSync(file, 'utf8'), { mode: 'strip' });
}

/**
 * @returns {{ load: () => Promise<object>, cleanup: () => void }}
 */
function formatModule() {
  let dir = null;
  return {
    async load() {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-format-'));
      const files = [
        // No package.json means a bare `.js` is CommonJS and the import fails.
        ['package.json', '{"type":"module"}'],
        [path.join('shared', 'contract.js'), strip(path.join(SRC, 'shared', 'contract.ts'))],
        [
          path.join('renderer', 'src', 'format.js'),
          strip(path.join(SRC, 'renderer', 'src', 'format.ts')),
        ],
      ];
      for (const [rel, body] of files) {
        const out = path.join(dir, rel);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, body, 'utf8');
      }
      return import(pathToFileURL(path.join(dir, 'renderer', 'src', 'format.js')).href);
    },
    cleanup() {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
      dir = null;
    },
  };
}

module.exports = { formatModule };
