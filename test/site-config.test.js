'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkSite, readConfig, readCsp } = require('../scripts/check-site-config.js');

/**
 * The landing page's CSP is a static <meta>. Setting `waitlistUrl` in the
 * RELEASE CONFIG without also opening form-action to that origin (or opening
 * it wider) is the mistake this catches; scripts/check-site-config.js holds
 * the rules. The real site must pass, and each rule must be able to fail.
 */
const ROOT = path.join(__dirname, '..');
const SITE = path.join(ROOT, 'site');

test('the site as committed passes the check', () => {
  assert.deepEqual(checkSite(SITE), []);
});

test('the committed config is empty: no Store link, no waitlist URL, form-action none', () => {
  const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
  const cfg = readConfig(html);
  assert.deepEqual(Object.keys(cfg).sort(), ['storeUrl', 'version', 'waitlistUrl']);
  assert.equal(cfg.storeUrl, '');
  assert.equal(cfg.waitlistUrl, '');
  assert.deepEqual(readCsp(html)['form-action'], ["'none'"]);
  assert.deepEqual(readCsp(html)['connect-src'], ["'none'"]);
});

/** A copy of site/'s pages in a temp dir, with index.html edited by `edit`. */
function siteWith(edit, extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-config-'));
  for (const f of fs.readdirSync(SITE)) {
    if (/\.(html|js)$/.test(f)) fs.copyFileSync(path.join(SITE, f), path.join(dir, f));
  }
  const p = path.join(dir, 'index.html');
  fs.writeFileSync(p, edit(fs.readFileSync(p, 'utf8')));
  if (extra) extra(dir);
  return dir;
}
const setConfig = (key, value) => (html) => html.replace(`"${key}": ""`, `"${key}": ${JSON.stringify(value)}`);
const setFormAction = (sources) => (html) => html.replace("form-action 'none'", 'form-action ' + sources);
const both = (...fns) => (html) => fns.reduce((h, f) => f(h), html);

const WORKER = 'https://limitpeek-waitlist.example.workers.dev/';

test('waitlistUrl set but the CSP still says none: fails', () => {
  const problems = checkSite(siteWith(setConfig('waitlistUrl', WORKER)));
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /index\.html: form-action is "'none'", must be "'self' https:\/\/limitpeek-waitlist\.example\.workers\.dev"/);
});

test("waitlistUrl set and form-action is exactly 'self' + its origin: passes", () => {
  const dir = siteWith(both(setConfig('waitlistUrl', WORKER), setFormAction("'self' https://limitpeek-waitlist.example.workers.dev")));
  assert.deepEqual(checkSite(dir), []);
});

test("form-action missing 'self' (the redirect to thanks.html) or wider than the Worker: fails", () => {
  for (const sources of ['https://limitpeek-waitlist.example.workers.dev', "'self' https://limitpeek-waitlist.example.workers.dev https://evil.example", "'self' https:", '*']) {
    const problems = checkSite(siteWith(both(setConfig('waitlistUrl', WORKER), setFormAction(sources))));
    assert.ok(problems.some((p) => /form-action/.test(p)), sources);
  }
});

test('form-action opened while waitlistUrl is empty: fails', () => {
  const problems = checkSite(siteWith(setFormAction("'self' https://limitpeek-waitlist.example.workers.dev")));
  assert.ok(problems.some((p) => /form-action is .* must be "'none'"/.test(p)), problems.join('\n'));
});

test('a waitlistUrl that is not https: fails', () => {
  for (const bad of ['http://limitpeek-waitlist.example.workers.dev/', 'limitpeek-waitlist.example', 'javascript:alert(1)']) {
    const problems = checkSite(siteWith(setConfig('waitlistUrl', bad)));
    assert.ok(problems.some((p) => /waitlistUrl must be an https URL/.test(p)), bad);
  }
});

test('storeUrl must be an https link on microsoft.com', () => {
  assert.deepEqual(checkSite(siteWith(setConfig('storeUrl', 'https://apps.microsoft.com/detail/9NBLGGH4NNS1'))), []);
  for (const bad of ['http://apps.microsoft.com/detail/x', 'https://microsoft.com.evil.example/x', 'https://github.com/x', 'ms-windows-store://pdp/?productid=9N']) {
    const problems = checkSite(siteWith(setConfig('storeUrl', bad)));
    assert.ok(problems.some((p) => /storeUrl/.test(p)), bad);
  }
});

test('unknown or non-string config keys: fail', () => {
  const extraKey = checkSite(siteWith((h) => h.replace('"version": ""', '"version": "", "sha256": ""')));
  assert.ok(extraKey.some((p) => /unknown key "sha256"/.test(p)));
  const notString = checkSite(siteWith((h) => h.replace('"version": ""', '"version": 1')));
  assert.ok(notString.some((p) => /"version" must be a string/.test(p)));
  const broken = checkSite(siteWith((h) => h.replace('"version": ""', '"version": ')));
  assert.ok(broken.some((p) => /RELEASE CONFIG unreadable/.test(p)));
});

test('connect-src opened, unsafe-inline, or a link to the private repo on any page: fails', () => {
  const connect = checkSite(siteWith((h) => h.replace("connect-src 'none'", "connect-src 'self'")));
  assert.ok(connect.some((p) => /index\.html: connect-src must be 'none'/.test(p)));
  const inline = checkSite(siteWith((h) => h.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")));
  assert.ok(inline.some((p) => /style-src allows/.test(p)));
  const repo = checkSite(siteWith((h) => h, (dir) => {
    const p = path.join(dir, 'privacy.html');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('</main>', '<a href="https://github.com/sameddartilmak/ai-usage-monitor">x</a></main>'));
  }));
  assert.ok(repo.some((p) => /privacy\.html: links to the private GitHub repository/.test(p)));
});

test('a legal page with an open form-action, or a missing redirect page: fails', () => {
  const legal = checkSite(siteWith((h) => h, (dir) => {
    const p = path.join(dir, 'terms.html');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace("form-action 'none'", "form-action 'self'"));
  }));
  assert.ok(legal.some((p) => /terms\.html: form-action/.test(p)));
  const missing = checkSite(siteWith((h) => h, (dir) => fs.unlinkSync(path.join(dir, 'thanks.html'))));
  assert.ok(missing.some((p) => /thanks\.html is missing/.test(p)));
});
