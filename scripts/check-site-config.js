'use strict';
/**
 * Checks that site/ keeps its promises after the RELEASE CONFIG is edited.
 *
 *   node scripts/check-site-config.js          prints problems, exit 1 if any
 *
 * The site's CSP is a static <meta>, so it cannot follow the config by
 * itself. When `waitlistUrl` is set, the owner must also put that origin into
 * index.html's form-action (worker/waitlist/README.md). This check fails
 * until both agree:
 *
 *   waitlistUrl empty  -> form-action 'none'
 *   waitlistUrl set    -> an https URL, and form-action is exactly
 *                         'self' + its origin. 'self' because browsers also
 *                         check the Worker's redirect to thanks.html against
 *                         form-action; nothing else, so the form cannot be
 *                         pointed anywhere further.
 *   storeUrl set       -> an https link on microsoft.com
 *
 * And on every page, whatever the config: connect-src 'none', no
 * 'unsafe-inline', form-action 'none' except on index.html, and no link to
 * the old private GitHub repository (the open-source repository may be
 * linked). test/site-config.test.js runs this.
 */
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_KEYS = ['version', 'storeUrl', 'waitlistUrl'];
const PRIVATE_REPO = /github\.com\/sameddartilmak\/ai-usage-monitor\b/i;

/** The JSON inside <script type="application/json" id="release-config">. */
function readConfig(html) {
  const m = /<script\b[^>]*\bid="release-config"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) throw new Error('no release-config block');
  return JSON.parse(m[1]);
}

/** The CSP <meta> as { directive: [sources] }, or null when there is none. */
function readCsp(html) {
  const m = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(html);
  if (!m) return null;
  const out = {};
  for (const part of m[1].split(';')) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    if (words.length) out[words[0].toLowerCase()] = words.slice(1);
  }
  return out;
}

function httpsUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password ? u : null;
  } catch {
    return null;
  }
}

function sameSet(a, b) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** Problems with one page's CSP, given what its form-action must be. */
function checkPage(name, html, wantFormAction) {
  const problems = [];
  const csp = readCsp(html);
  if (!csp) return [`${name}: no Content-Security-Policy meta`];
  if (!sameSet(csp['connect-src'] || [], ["'none'"])) problems.push(`${name}: connect-src must be 'none'`);
  for (const [dir, sources] of Object.entries(csp)) {
    if (sources.some((s) => /^'unsafe-/i.test(s))) problems.push(`${name}: ${dir} allows ${sources.join(' ')}`);
  }
  const fa = csp['form-action'] || [];
  if (!sameSet(fa, wantFormAction)) {
    problems.push(`${name}: form-action is "${fa.join(' ')}", must be "${wantFormAction.join(' ')}"`);
  }
  if (PRIVATE_REPO.test(html)) problems.push(`${name}: links to the private GitHub repository`);
  return problems;
}

/** Every problem in `siteDir`; an empty list means the site is consistent. */
function checkSite(siteDir) {
  const problems = [];
  const indexPath = path.join(siteDir, 'index.html');
  const index = fs.readFileSync(indexPath, 'utf8');

  let cfg;
  try { cfg = readConfig(index); } catch (err) { return [`index.html: RELEASE CONFIG unreadable (${err.message})`]; }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return ['index.html: RELEASE CONFIG is not an object'];
  for (const key of Object.keys(cfg)) {
    if (!CONFIG_KEYS.includes(key)) problems.push(`index.html: RELEASE CONFIG has unknown key "${key}"`);
  }
  for (const key of CONFIG_KEYS) {
    if (typeof cfg[key] !== 'string') problems.push(`index.html: RELEASE CONFIG "${key}" must be a string ("" when unset)`);
  }

  const store = typeof cfg.storeUrl === 'string' ? cfg.storeUrl.trim() : '';
  if (store) {
    const u = httpsUrl(store);
    if (!u || !(u.hostname === 'microsoft.com' || u.hostname.endsWith('.microsoft.com'))) {
      problems.push(`index.html: storeUrl must be an https link on microsoft.com, got "${store}"`);
    }
  }

  const wl = typeof cfg.waitlistUrl === 'string' ? cfg.waitlistUrl.trim() : '';
  let indexFormAction = ["'none'"];
  if (wl) {
    const u = httpsUrl(wl);
    if (!u) problems.push(`index.html: waitlistUrl must be an https URL, got "${wl}"`);
    else indexFormAction = ["'self'", u.origin];
  }

  const pages = fs.readdirSync(siteDir).filter((f) => f.endsWith('.html')).sort();
  for (const page of pages) {
    const html = page === 'index.html' ? index : fs.readFileSync(path.join(siteDir, page), 'utf8');
    problems.push(...checkPage(page, html, page === 'index.html' ? indexFormAction : ["'none'"]));
  }
  for (const page of ['thanks.html', 'unsubscribed.html']) {
    if (!pages.includes(page)) problems.push(`${page} is missing (the Worker redirects to it)`);
  }
  for (const js of fs.readdirSync(siteDir).filter((f) => f.endsWith('.js'))) {
    if (PRIVATE_REPO.test(fs.readFileSync(path.join(siteDir, js), 'utf8'))) {
      problems.push(`${js}: links to the private GitHub repository`);
    }
  }
  return problems;
}

module.exports = { checkSite, readConfig, readCsp };

if (require.main === module) {
  const dir = path.join(__dirname, '..', 'site');
  const problems = checkSite(dir);
  if (problems.length) {
    console.error('site config: ' + problems.length + ' problem(s)');
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }
  console.log('site config: OK');
}
