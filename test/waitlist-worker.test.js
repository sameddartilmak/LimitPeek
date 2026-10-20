'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/**
 * worker/waitlist: the "tell me when the paid version is out" list. It is
 * not deployed from here (README.md there), so these tests are what stands
 * between an edit and a Worker that stores more than the privacy page says.
 *
 *   1. the pure parts (src/lib.js): validation, normalisation, sanitising
 *   2. the request handler (src/index.js) against the real schema.sql, run on
 *      node:sqlite behind a minimal D1-shaped shim. Not the Workers runtime,
 *      but the same SQL and the same Request/Response objects.
 *   3. the site's form offers exactly the values the Worker accepts
 */
const ROOT = path.join(__dirname, '..');
const WORKER = path.join(ROOT, 'worker', 'waitlist');

let lib;
let worker;
test.before(async () => {
  lib = await import(pathToFileURL(path.join(WORKER, 'src', 'lib.js')).href);
  worker = await import(pathToFileURL(path.join(WORKER, 'src', 'index.js')).href);
});

function form(pairs) {
  const f = new URLSearchParams();
  for (const [k, v] of pairs) f.append(k, v);
  return f;
}

/* ------------------------------------------------------------ 1. pure parts */

test('normaliseEmail trims and lower-cases, and turns a non-string into ""', () => {
  assert.equal(lib.normaliseEmail('  Ada.Lovelace@Example.COM \n'), 'ada.lovelace@example.com');
  assert.equal(lib.normaliseEmail(null), '');
  assert.equal(lib.normaliseEmail(42), '');
});

test('isValidEmail accepts ordinary addresses', () => {
  for (const ok of ['a@b.co', 'ada.lovelace@example.com', 'first+tag@sub.example.com.tr', "o'brien@example.ie", 'x@xn--bcher-kva.example', 'a_b-c@my-host.io']) {
    assert.equal(lib.isValidEmail(ok), true, ok);
  }
});

test('isValidEmail rejects malformed, oversized and non-ASCII addresses', () => {
  const bad = [
    '', 'plain', '@example.com', 'a@', 'a@b', 'a@b.c', 'a@@b.com', 'a@b@c.com',
    '.a@b.com', 'a.@b.com', 'a..b@c.com', 'a b@c.com', 'a@b..com', 'a@-b.com', 'a@b-.com',
    'a@b.c0m', 'a@b.123', '<a>@b.com', 'a@b.com>', 'ş@örnek.com', 'a@örnek.com',
    'a'.repeat(65) + '@b.com',
    'a@' + 'b'.repeat(64) + '.com',
    'a@' + Array(60).fill('bbbb').join('.') + '.com', // > 254 overall
  ];
  for (const v of bad) assert.equal(lib.isValidEmail(v), false, JSON.stringify(v));
  assert.equal(lib.isValidEmail(undefined), false);
});

test('isValidEmail expects a normalised address (upper case is the caller\'s job)', () => {
  assert.equal(lib.isValidEmail('Ada@Example.com'), false);
  assert.equal(lib.isValidEmail(lib.normaliseEmail('Ada@Example.com')), true);
});

test('cleanText makes one plain line: no controls, no invisible or bidi marks', () => {
  assert.equal(lib.cleanText('  dark\tmode \n please  ', 200), 'dark mode please');
  assert.equal(lib.cleanText('a\u0000b\u0007c\u007fd\u0085e', 200), 'a b c d e');
  assert.equal(lib.cleanText('zero\u200bwidth\u200d', 200), 'zero width');
  assert.equal(lib.cleanText('\u202eevil\u202c \u2066x\u2069', 200), 'evil x');
  assert.equal(lib.cleanText('line\u2028sep\u2029para\ufeff', 200), 'line sep para');
  assert.equal(lib.cleanText('Cafe\u0301', 200), 'Caf\u00e9', 'NFC');
  assert.equal(lib.cleanText(' \u200b \u0000 ', 200), '');
  assert.equal(lib.cleanText(undefined, 200), '');
});

test('cleanText caps at max code points without splitting a surrogate pair', () => {
  assert.equal(lib.cleanText('x'.repeat(500), 200).length, 200);
  const emoji = '\u{1F600}'.repeat(201);
  const out = lib.cleanText(emoji, 200);
  assert.equal(Array.from(out).length, 200);
  assert.ok(!/[\ud800-\udbff]$/.test(out), 'no lone high surrogate at the end');
});

test('sanitiseAnswers keeps only known values, in a fixed order, once each', () => {
  const a = lib.sanitiseAnswers(form([
    ['tools', 'codex'], ['tools', 'evil<script>'], ['tools', 'claude-code'], ['tools', 'codex'], ['tools', 'other'],
    ['price', '3to5'], ['feature', '  phone\nalerts  '], ['locale', 'en'],
  ]));
  assert.deepEqual(a, { tools: 'claude-code,codex,other', price: '3to5', feature: 'phone alerts', locale: 'en' });
});

test('sanitiseAnswers: unanswered or unknown answers are null, locale falls back to tr', () => {
  assert.deepEqual(lib.sanitiseAnswers(form([])), { tools: null, price: null, feature: null, locale: 'tr' });
  assert.deepEqual(
    lib.sanitiseAnswers(form([['tools', 'copilot'], ['price', '1000'], ['feature', '\u200b '], ['locale', 'de']])),
    { tools: null, price: null, feature: null, locale: 'tr' });
});

test('sanitiseAnswers accepts every value the lists define', () => {
  const all = lib.sanitiseAnswers(form(lib.TOOLS.map((t) => ['tools', t])));
  assert.equal(all.tools, lib.TOOLS.join(','));
  assert.ok(all.tools.length <= 120, 'fits the schema CHECK');
  for (const p of lib.PRICES) assert.equal(lib.sanitiseAnswers(form([['price', p]])).price, p);
});

test('isBot is true only for a filled honeypot', () => {
  assert.equal(lib.isBot(form([])), false);
  assert.equal(lib.isBot(form([['website', '   ']])), false);
  assert.equal(lib.isBot(form([['website', 'http://spam']])), true);
});

test('originAllowed: none, "null" (no-referrer page) or the site itself', () => {
  const site = 'https://limitpeek.example';
  assert.equal(lib.originAllowed(null, site), true);
  assert.equal(lib.originAllowed('', site), true);
  assert.equal(lib.originAllowed('null', site), true);
  assert.equal(lib.originAllowed(site, site), true);
  assert.equal(lib.originAllowed('https://evil.example', site), false);
  assert.equal(lib.originAllowed('https://limitpeek.example.evil.example', site), false);
});

test('siteBase: https (or http on localhost), always ending in "/", nothing else', () => {
  assert.equal(lib.siteBase('https://limitpeek.pages.dev').href, 'https://limitpeek.pages.dev/');
  assert.equal(lib.siteBase(' https://x.example/site?q=1#h ').href, 'https://x.example/site/');
  assert.equal(lib.siteBase('http://127.0.0.1:8080/').href, 'http://127.0.0.1:8080/');
  for (const bad of ['', '   ', undefined, 'not a url', 'http://x.example/', 'javascript:alert(1)', 'https://u:p@x.example/', 'ftp://x.example/']) {
    assert.equal(lib.siteBase(bad), null, String(bad));
  }
});

test('sitePage resolves against the base and adds the state fragment', () => {
  const base = lib.siteBase('https://x.example/site/');
  assert.equal(lib.sitePage(base, 'thanks.html'), 'https://x.example/site/thanks.html');
  assert.equal(lib.sitePage(base, 'thanks.html', 'invalid'), 'https://x.example/site/thanks.html#invalid');
});

test('hourBucket counts whole hours since the epoch', () => {
  assert.equal(lib.hourBucket(0), 0);
  assert.equal(lib.hourBucket(3599999), 0);
  assert.equal(lib.hourBucket(3600000), 1);
});

test('ipKey: a 64-hex digest that changes with the day and the salt, never the IP', async () => {
  const t = Date.UTC(2026, 9, 20, 10);
  const k = await lib.ipKey('203.0.113.7', 'salt', t);
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.ok(!k.includes('203'));
  assert.equal(await lib.ipKey('203.0.113.7', 'salt', t + 3600000), k, 'same UTC day');
  assert.notEqual(await lib.ipKey('203.0.113.7', 'salt', Date.UTC(2026, 9, 21, 0, 0, 1)), k, 'next day');
  assert.notEqual(await lib.ipKey('203.0.113.7', 'other', t), k, 'other salt');
  assert.notEqual(await lib.ipKey('203.0.113.8', 'salt', t), k, 'other IP');
});

test('newToken is 64 random hex characters; isToken checks exactly that', () => {
  const a = lib.newToken();
  const b = lib.newToken();
  assert.ok(lib.isToken(a) && lib.isToken(b));
  assert.notEqual(a, b);
  for (const bad of ['', 'abc', a.toUpperCase(), a + '0', a.slice(1) + 'g', null, 7]) assert.equal(lib.isToken(bad), false);
});

/* ------------------------------------------------- 2. handler on real SQL */

/** A D1-shaped wrapper over node:sqlite: prepare().bind().run/first/all. */
function d1(db) {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        async run() { const r = stmt.run(...args); return { success: true, meta: { changes: r.changes } }; },
        async first(col) { const row = stmt.get(...args); if (!row) return null; return col ? row[col] : row; },
        async all() { return { success: true, results: stmt.all(...args) }; },
      };
      return api;
    },
  };
}

function setup(overrides) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(WORKER, 'schema.sql'), 'utf8'));
  const env = { DB: d1(db), SITE_URL: 'https://limitpeek.example/', IP_SALT: 'test-salt', ...overrides };
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const rows = () => db.prepare('SELECT * FROM subscribers ORDER BY email').all().map((r) => ({ ...r }));
  return { db, env, ctx, pending, rows };
}

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const W = 'https://limitpeek-waitlist.example.workers.dev';

function post(pairs, { ip = '198.51.100.1', origin = 'null', type = 'application/x-www-form-urlencoded', path: p = '/' } = {}) {
  const headers = { 'Content-Type': type, 'CF-Connecting-IP': ip };
  if (origin !== undefined) headers.Origin = origin;
  return new Request(W + p, { method: 'POST', headers, body: form(pairs).toString() });
}

test('handler: a sign-up is stored normalised and redirects (303) to thanks.html', async () => {
  const { env, ctx, rows } = setup();
  const res = await worker.handle(post([
    ['email', '  Ada@Example.COM '], ['tools', 'codex'], ['tools', 'claude-code'], ['price', 'upto3'],
    ['feature', 'phone\talerts'], ['locale', 'en'], ['website', ''],
  ]), env, ctx, NOW);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('Location'), 'https://limitpeek.example/thanks.html');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  const [r, ...rest] = rows();
  assert.equal(rest.length, 0);
  assert.equal(r.email, 'ada@example.com');
  assert.equal(r.tools, 'claude-code,codex');
  assert.equal(r.price, 'upto3');
  assert.equal(r.feature, 'phone alerts');
  assert.equal(r.locale, 'en');
  assert.match(r.token, /^[0-9a-f]{64}$/);
  assert.equal(r.created_at, '2026-10-20T12:00:00.000Z');
  assert.equal(r.updated_at, r.created_at);
  assert.deepEqual(Object.keys(r).sort(), ['created_at', 'email', 'feature', 'locale', 'price', 'token', 'tools', 'updated_at'],
    'exactly the columns the privacy policy lists');
});

test('handler: signing up again updates the given answers and keeps the rest', async () => {
  const { env, ctx, rows } = setup();
  await worker.handle(post([['email', 'ada@example.com'], ['tools', 'codex'], ['price', 'more'], ['feature', 'first']]), env, ctx, NOW);
  const before = rows()[0];
  const res = await worker.handle(post([['email', 'ADA@example.com'], ['price', 'none'], ['locale', 'en']]), env, ctx, NOW + 60000);
  assert.equal(res.status, 303);
  const all = rows();
  assert.equal(all.length, 1, 'deduplicated on email');
  assert.equal(all[0].price, 'none');
  assert.equal(all[0].tools, 'codex', 'unanswered this time: kept');
  assert.equal(all[0].feature, 'first');
  assert.equal(all[0].locale, 'en');
  assert.equal(all[0].token, before.token, 'the unsubscribe link keeps working');
  assert.equal(all[0].created_at, before.created_at);
  assert.equal(all[0].updated_at, '2026-10-20T12:01:00.000Z');
});

test('handler: an invalid email stores nothing and redirects to #invalid', async () => {
  const { env, ctx, rows } = setup();
  for (const email of ['', 'nope', 'a@b', 'x'.repeat(300) + '@b.com']) {
    const res = await worker.handle(post([['email', email]]), env, ctx, NOW);
    assert.equal(res.headers.get('Location'), 'https://limitpeek.example/thanks.html#invalid', email);
  }
  assert.equal(rows().length, 0);
});

test('handler: a filled honeypot looks like success and stores nothing', async () => {
  const { env, ctx, rows } = setup();
  const res = await worker.handle(post([['email', 'bot@example.com'], ['website', 'spam']]), env, ctx, NOW);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('Location'), 'https://limitpeek.example/thanks.html');
  assert.equal(rows().length, 0);
});

test('handler: rate limit per IP per hour, keyed by a hash, never the raw IP', async () => {
  const { db, env, ctx, rows } = setup();
  const ip = '203.0.113.9';
  for (let i = 0; i < 5; i++) {
    const res = await worker.handle(post([['email', `u${i}@example.com`]], { ip }), env, ctx, NOW);
    assert.equal(res.headers.get('Location'), 'https://limitpeek.example/thanks.html', `try ${i + 1}`);
  }
  const sixth = await worker.handle(post([['email', 'u5@example.com']], { ip }), env, ctx, NOW);
  assert.equal(sixth.headers.get('Location'), 'https://limitpeek.example/thanks.html#limit');
  assert.equal(rows().length, 5);
  const other = await worker.handle(post([['email', 'v@example.com']], { ip: '203.0.113.10' }), env, ctx, NOW);
  assert.equal(other.headers.get('Location'), 'https://limitpeek.example/thanks.html');
  const nextHour = await worker.handle(post([['email', 'u5@example.com']], { ip }), env, ctx, NOW + 3600000);
  assert.equal(nextHour.headers.get('Location'), 'https://limitpeek.example/thanks.html');

  const dump = JSON.stringify(db.prepare('SELECT * FROM rate_limits').all());
  assert.ok(!dump.includes('203.0.113'), 'no raw IP in the rate-limit table');
  for (const r of db.prepare('SELECT key FROM rate_limits').all()) assert.match(r.key, /^[0-9a-f]{64}$/);
});

test('handler: rate-limit rows older than a day are purged', async () => {
  const { db, env, ctx, pending } = setup();
  db.prepare('INSERT INTO rate_limits (key, bucket, hits) VALUES (?, ?, ?)').run('old', lib.hourBucket(NOW) - 25, 3);
  db.prepare('INSERT INTO rate_limits (key, bucket, hits) VALUES (?, ?, ?)').run('recent', lib.hourBucket(NOW) - 2, 3);
  await worker.handle(post([['email', 'ada@example.com']]), env, ctx, NOW);
  await Promise.all(pending);
  const keys = db.prepare('SELECT key FROM rate_limits').all().map((r) => r.key);
  assert.ok(!keys.includes('old'));
  assert.ok(keys.includes('recent'));
});

test('handler: another site posting into the list is refused', async () => {
  const { env, ctx, rows } = setup();
  const res = await worker.handle(post([['email', 'ada@example.com']], { origin: 'https://evil.example' }), env, ctx, NOW);
  assert.equal(res.status, 403);
  const own = await worker.handle(post([['email', 'ada@example.com']], { origin: 'https://limitpeek.example' }), env, ctx, NOW);
  assert.equal(own.status, 303);
  assert.equal(rows().length, 1);
});

test('handler: wrong body type or an oversized body goes to #error', async () => {
  const { env, ctx, rows } = setup();
  const json = await worker.handle(post([['email', 'ada@example.com']], { type: 'application/json' }), env, ctx, NOW);
  assert.equal(json.headers.get('Location'), 'https://limitpeek.example/thanks.html#error');
  const big = await worker.handle(post([['email', 'ada@example.com'], ['feature', 'x'.repeat(9000)]]), env, ctx, NOW);
  assert.equal(big.headers.get('Location'), 'https://limitpeek.example/thanks.html#error');
  assert.equal(rows().length, 0);
});

test('handler: methods, paths and missing configuration', async () => {
  const { env, ctx } = setup();
  assert.equal((await worker.handle(new Request(W + '/'), env, ctx, NOW)).status, 405);
  assert.equal((await worker.handle(new Request(W + '/admin'), env, ctx, NOW)).status, 404);
  assert.equal((await worker.handle(new Request(W + '/unsubscribe', { method: 'DELETE' }), env, ctx, NOW)).status, 405);
  const noSite = setup({ SITE_URL: '' });
  assert.equal((await worker.handle(post([['email', 'a@b.co']]), noSite.env, noSite.ctx, NOW)).status, 500);
  const noSalt = setup({ IP_SALT: '' });
  assert.equal((await worker.handle(post([['email', 'a@b.co']]), noSalt.env, noSalt.ctx, NOW)).status, 500);
  assert.equal(noSalt.rows().length, 0);
});

test('handler: a database failure redirects to #error without details', async () => {
  const broken = { prepare() { throw new Error('D1 is down'); } };
  const { env, ctx } = setup();
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const res = await worker.handle(post([['email', 'ada@example.com']]), { ...env, DB: broken }, ctx, NOW);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('Location'), 'https://limitpeek.example/thanks.html#error');
    const un = await worker.handle(new Request(W + '/unsubscribe?token=' + 'a'.repeat(64)), { ...env, DB: broken }, ctx, NOW);
    assert.equal(un.headers.get('Location'), 'https://limitpeek.example/unsubscribed.html#error');
  } finally {
    console.error = orig;
  }
  assert.ok(errors.some((e) => e.includes('D1 is down')), 'logged for the owner');
});

test('handler: the unsubscribe link deletes the row and answers the same for any token', async () => {
  const { env, ctx, rows } = setup();
  await worker.handle(post([['email', 'ada@example.com']]), env, ctx, NOW);
  await worker.handle(post([['email', 'bob@example.com']]), env, ctx, NOW);
  const token = rows()[0].token;

  const miss = await worker.handle(new Request(W + '/unsubscribe?token=' + 'f'.repeat(64)), env, ctx, NOW);
  const junk = await worker.handle(new Request(W + '/unsubscribe?token=%27%20OR%201=1'), env, ctx, NOW);
  assert.equal(rows().length, 2);
  const hit = await worker.handle(new Request(W + '/unsubscribe?token=' + token), env, ctx, NOW);
  for (const res of [miss, junk, hit]) {
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('Location'), 'https://limitpeek.example/unsubscribed.html');
  }
  assert.deepEqual(rows().map((r) => r.email), ['bob@example.com']);
});

test('handler: RFC 8058 one-click unsubscribe (POST) deletes and answers 200', async () => {
  const { env, ctx, rows } = setup();
  await worker.handle(post([['email', 'ada@example.com']]), env, ctx, NOW);
  const token = rows()[0].token;
  const res = await worker.handle(post([['List-Unsubscribe', 'One-Click']], { path: '/unsubscribe?token=' + token }), env, ctx, NOW);
  assert.equal(res.status, 200);
  assert.equal(rows().length, 0);
});

/* ---------------------------------------- 3. the site's form matches it */

test('site form: field names and option values are exactly what the Worker accepts', () => {
  const html = fs.readFileSync(path.join(ROOT, 'site', 'index.html'), 'utf8');
  const m = /<form\b[^>]*id="waitlist-form"[^>]*>([\s\S]*?)<\/form>/.exec(html);
  assert.ok(m, 'waitlist form exists');
  const formTag = /<form\b[^>]*id="waitlist-form"[^>]*>/.exec(html)[0];
  assert.match(formTag, /method="post"/);
  assert.doesNotMatch(formTag, /enctype=/, 'default urlencoded body, which the Worker expects');
  const body = m[1];
  const values = (name) => [...body.matchAll(new RegExp(`name="${name}" value="([^"]+)"`, 'g'))].map((x) => x[1]);
  assert.deepEqual(values('tools'), lib.TOOLS);
  assert.deepEqual(values('price'), lib.PRICES);
  const names = new Set([...body.matchAll(/\bname="([^"]+)"/g)].map((x) => x[1]));
  assert.deepEqual([...names].sort(), ['email', 'feature', 'locale', 'price', 'tools', 'website']);
  assert.match(body, /name="email"[^>]*\brequired\b/);
  assert.match(body, new RegExp(`name="feature"[^>]*maxlength="${lib.LIMITS.featureMax}"`));
  assert.match(body, new RegExp(`name="email"[^>]*maxlength="${lib.LIMITS.emailMax}"`));
  assert.match(body, /<fieldset class="wl__set" id="waitlist-set" disabled>/, 'disabled until configured');
});
