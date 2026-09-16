'use strict';
/**
 * Build-time JSON inlining for the renderer. ADR-004 Amendment 1, ruling 4.
 *
 * The renderer imports the shared catalogs as JSON modules so the TypeScript
 * checker can type the keys. Shipped as-is, that import is a module fetch of
 * a `.json` file, which the CSP's `connect-src 'none'` exists to forbid — and
 * that directive is not being loosened. So the build replaces each
 *
 *   import name from './relative/path.json' with { type: 'json' };
 *
 * with `const name = <the file's contents>;` before writing to dist/.
 *
 * One function, used by `build.mjs`, `test/renderer-build.test.js` (so the
 * staleness check compares against what the build really writes) and the unit
 * loaders in `test/helpers/` (so tests run the shipped shape). CommonJS so the
 * synchronous test code can `require` it.
 *
 * Anything that LOOKS like a JSON import but does not match the one accepted
 * form throws: a partially-rewritten module would fail in the panel at load,
 * and the build is the place to find that out.
 */
const fs = require('node:fs');
const path = require('node:path');

const JSON_IMPORT =
  /^import\s+([A-Za-z_$][\w$]*)\s+from\s+(['"])([^'"]+\.json)\2\s+with\s*\{\s*type:\s*(['"])json\4\s*\};?[ \t]*$/gm;

/**
 * @param {string} js       type-stripped module text
 * @param {string} fromFile absolute path of the SOURCE file (specifiers are relative to it)
 * @returns {{ code: string, inputs: string[] }} rewritten code and the JSON files read
 */
function inlineJsonImports(js, fromFile) {
  const inputs = [];
  const code = js.replace(JSON_IMPORT, (_whole, name, _q, spec) => {
    if (!spec.startsWith('.')) throw new Error(`inline-json: bare JSON specifier "${spec}" in ${fromFile}`);
    const file = path.resolve(path.dirname(fromFile), spec);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    inputs.push(file);
    return `const ${name} = ${JSON.stringify(data)};`;
  });
  if (/\.json['"]\s*(with|assert)\b/.test(code)) {
    throw new Error(`inline-json: a JSON import in ${fromFile} is not in the accepted form`);
  }
  return { code, inputs };
}

module.exports = { inlineJsonImports };
