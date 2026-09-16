'use strict';
const fs = require('node:fs');
const path = require('node:path');

/**
 * The method names `contract.ts` declares on `UsageNotchApi`, parsed from the
 * source.
 *
 * ONE parser, used by `test/contract-mirror.test.js` (against the preload
 * source) and by `scripts/smoke-ipc.js` (against the bridge the sandboxed
 * renderer actually receives). The smoke used to keep a hand-typed copy of the
 * method list, and that copy drifted twice — `onPanelVisibility`, then
 * `setLanguage` — while the unit test that parsed the contract stayed green.
 * Two copies of a list with nothing holding them equal is the failure this
 * file exists to remove.
 *
 * Plain Node, no electron: it runs under `node --test` and inside Electron's
 * main process alike.
 */
const CONTRACT = path.join(__dirname, '..', '..', 'src', 'shared', 'contract.ts');

/**
 * @param {string} [source] contract.ts text; read from disk when omitted
 * @returns {string[]} method names, sorted
 */
function usageNotchApiMethods(source) {
  const src = source === undefined ? fs.readFileSync(CONTRACT, 'utf8') : source;
  const start = src.indexOf('export interface UsageNotchApi');
  if (start === -1) throw new Error('contract.ts no longer declares UsageNotchApi');
  const block = src.slice(start, src.indexOf('\n}', start));
  const names = new Set();
  for (const m of block.matchAll(/^ {2}([a-zA-Z]+)\(/gm)) names.add(m[1]);
  if (!names.has('initialSnapshot')) throw new Error('UsageNotchApi parser found no methods; it is broken');
  return [...names].sort();
}

module.exports = { usageNotchApiMethods, CONTRACT };
