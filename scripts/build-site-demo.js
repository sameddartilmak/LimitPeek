'use strict';
/**
 * Puts the REAL panel on the site (site/demo/), in place of the hand-built
 * replica the page used to carry (owner, 2026-09-30: the replica still showed
 * the old design). It is the dev harness in screenshot mode: the shipping
 * renderer, mounted against the mock bridge and its sample data, so the demo
 * can never drift from the app again. Re-run after any UI change:
 *
 *   node scripts/build-site-demo.js
 *
 * Layout under site/demo/ mirrors src/renderer/ so the harness's relative
 * paths hold unchanged: dev/panel.html, dev/harness.css, styles/*.css,
 * assets/, dist/renderer/**.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'renderer');
const OUT = path.join(ROOT, 'site', 'demo');

// The dev build: `npm run dist` builds --prod, which leaves the harness out.
execFileSync(process.execPath, [path.join(SRC, 'build.mjs')], { cwd: ROOT, stdio: 'inherit' });

fs.rmSync(OUT, { recursive: true, force: true });
const copy = (from, to) => fs.cpSync(path.join(SRC, from), path.join(OUT, to), { recursive: true });
copy('dist', 'dist');
for (const css of ['tokens.css', 'panel.css', 'row.css']) copy(path.join('styles', css), path.join('styles', css));
copy(path.join('dev', 'harness.css'), path.join('dev', 'harness.css'));
copy(path.join('assets', 'app-icon.svg'), path.join('assets', 'app-icon.svg'));
for (const f of fs.readdirSync(path.join(SRC, 'assets', 'logos')).filter((n) => n.endsWith('-color.svg'))) {
  copy(path.join('assets', 'logos', f), path.join('assets', 'logos', f));
}

// The harness page, reduced to the panel: no control column, screenshot mode.
const page = fs.readFileSync(path.join(SRC, 'dev', 'harness.html'), 'utf8')
  .replace('<body class="hx">', '<body class="hx hx--shot">')
  .replace(/<title>[^<]*<\/title>/, '<title>Usage Notch — canlı demo</title>')
  .replace(/<aside id="controls"[\s\S]*?<\/aside>/, '<aside id="controls" class="hx-controls" hidden></aside>');
fs.writeFileSync(path.join(OUT, 'dev', 'panel.html'), page, 'utf8');

const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
walk(OUT);
const kb = files.reduce((n, f) => n + fs.statSync(f).size, 0) / 1024;
console.log(`site demo: ${files.length} files, ${kb.toFixed(0)} KB -> site/demo/dev/panel.html`);
