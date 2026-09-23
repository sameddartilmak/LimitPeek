/**
 * Renderer build: TypeScript -> plain ES modules, with zero dependencies.
 *
 * Node 24 ships type stripping in core (`node:module`.stripTypeScriptTypes),
 * so this lane needs no bundler, no CDN and no entry in package.json — which
 * matters, because package.json belongs to the main-process lane.
 *
 * The output mirrors the `src/` tree under `src/renderer/dist/`, so a relative
 * specifier like `../../shared/contract.js` resolves identically in the source
 * tree and in the build output.
 *
 *   node src/renderer/build.mjs
 *   node src/renderer/build.mjs --watch
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { inlineJsonImports } from './inline-json.cjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RENDERER = HERE;
const SRC_ROOT = resolve(HERE, '..');
const OUT_ROOT = join(RENDERER, 'dist');

/**
 * `--prod` omits dev/, so the harness and its fixtures are never emitted into
 * a packaged build. The harness also contains the only file in this lane that
 * opens a socket (dev/serve.mjs), which the security lane forbade in the
 * shipped app; it is never imported by index.html and never runs in Electron.
 */
const PROD = process.argv.includes('--prod');

/** Everything the renderer document needs, and nothing the main lane owns. */
const INPUTS = [
  join(SRC_ROOT, 'shared', 'contract.ts'),
  join(RENDERER, 'src'),
  // No .ts in here, so nothing is emitted from it; listed so --watch rebuilds
  // when a catalog changes, since its JSON is inlined into the modules.
  join(SRC_ROOT, 'shared', 'i18n'),
  ...(PROD ? [] : [join(RENDERER, 'dev')]),
];

/**
 * Exactly what a packaged app must contain, relative to src/renderer/.
 * Anything not listed is build-time or dev-only.
 *   PACKAGE:  index.html, styles/**, assets/**, dist/shared/**, dist/renderer/src/**
 *   EXCLUDE:  dev/**, dist/renderer/dev/**, build.mjs, tsconfig.json, src/**.ts
 */
export const PACKAGE_GLOBS = [
  'index.html',
  // The key-entry window's document (ADR-003 A8). Loaded by main from disk,
  // like index.html, and built from src/key-entry.ts into dist/.
  'key-entry.html',
  'styles/**/*.css',
  'assets/**/*',
  'dist/shared/**/*.js',
  'dist/renderer/src/**/*.js',
];

function collect(target) {
  const out = [];
  const stat = statSync(target, { throwIfNoEntry: false });
  if (!stat) return out;
  if (stat.isFile()) {
    if (target.endsWith('.ts') && !target.endsWith('.d.ts')) out.push(target);
    return out;
  }
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    out.push(...collect(join(target, entry.name)));
  }
  return out;
}

function outputPathFor(file) {
  const rel = relative(SRC_ROOT, file);
  if (rel.startsWith('..')) throw new Error(`build: ${file} is outside src/`);
  return join(OUT_ROOT, rel.replace(/\.ts$/, '.js'));
}

function buildOne(file) {
  const source = readFileSync(file, 'utf8');
  // Catalog JSON is inlined, never fetched: see inline-json.cjs (ADR-004 A1.4).
  const { code: js } = inlineJsonImports(
    stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: file }),
    file,
  );
  const out = outputPathFor(file);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, js, 'utf8');
  return out;
}

function buildAll() {
  // Clean first. Without this, `--prod` after any dev build leaves the previous
  // dist/renderer/dev/*.js in place while reporting "dev/ omitted" — the log
  // line would be a lie, and a packaging glob of dist/** would ship the harness
  // and its fixtures. It also stops a deleted source file lingering as a stale
  // module that still resolves at runtime.
  rmSync(OUT_ROOT, { recursive: true, force: true });

  const files = INPUTS.flatMap(collect);
  let ok = 0;
  for (const file of files) {
    try {
      buildOne(file);
      ok++;
    } catch (error) {
      console.error(`build: FAILED ${relative(SRC_ROOT, file)}`);
      console.error(`  ${error && error.message ? error.message : error}`);
      process.exitCode = 1;
    }
  }
  console.log(`build: ${ok}/${files.length} module(s) -> ${relative(SRC_ROOT, OUT_ROOT)}${sep}${PROD ? ' (prod: dev/ omitted)' : ''}`);
  return ok === files.length;
}

buildAll();

if (process.argv.includes('--watch')) {
  console.log('build: watching for changes (Ctrl+C to stop)');
  let pending = null;
  const rebuild = () => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      process.exitCode = 0;
      buildAll();
    }, 80);
  };
  for (const target of INPUTS) {
    const stat = statSync(target, { throwIfNoEntry: false });
    if (!stat) continue;
    watch(target, { recursive: stat.isDirectory() }, rebuild);
  }
}
