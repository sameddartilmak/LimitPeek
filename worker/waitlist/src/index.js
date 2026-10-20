/* LimitPeek waitlist: a Cloudflare Worker (ES module) with a D1 database.
 *
 *   POST /              the site's form (application/x-www-form-urlencoded)
 *                       -> 303 to SITE_URL/thanks.html (#invalid, #limit, #error)
 *   GET  /unsubscribe?token=...   the link in every mail
 *                       -> deletes the row, 303 to SITE_URL/unsubscribed.html
 *   POST /unsubscribe?token=...   RFC 8058 one-click (List-Unsubscribe-Post)
 *                       -> deletes the row, 200
 *   cron                deletes rate-limit rows older than a day
 *
 * Environment (wrangler.toml / `wrangler secret put`):
 *   DB        the D1 binding (schema.sql)
 *   SITE_URL  the site's address, e.g. https://limitpeek.pages.dev/
 *   IP_SALT   secret, long and random; hashes the IP for the rate limit
 *
 * Stored per sign-up: email, the optional answers, the page language, a
 * random unsubscribe token, created/updated time. Never the IP, never a
 * cookie. No third-party service is called. */
import {
  LIMITS, RATE, normaliseEmail, isValidEmail, sanitiseAnswers, isBot,
  originAllowed, siteBase, sitePage, hourBucket, ipKey, newToken, isToken,
} from './lib.js';

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function text(status, body, extra) {
  return new Response(body + '\n', {
    status,
    headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', ...extra },
  });
}

function seeOther(location) {
  return new Response(null, { status: 303, headers: { ...SECURITY_HEADERS, Location: location } });
}

async function purgeRateLimits(db, nowMs) {
  const oldest = hourBucket(nowMs - RATE.keepSeconds * 1000);
  await db.prepare('DELETE FROM rate_limits WHERE bucket < ?1').bind(oldest).run();
}

async function subscribe(request, env, ctx, base, nowMs) {
  const thanks = (state) => seeOther(sitePage(base, 'thanks.html', state));

  if (!originAllowed(request.headers.get('Origin'), base.origin)) return text(403, 'Forbidden');
  const type = (request.headers.get('Content-Type') || '').toLowerCase();
  if (!type.startsWith('application/x-www-form-urlencoded')) return thanks('error');
  if (Number(request.headers.get('Content-Length') || 0) > LIMITS.bodyMax) return thanks('error');
  const body = await request.text();
  if (body.length > LIMITS.bodyMax) return thanks('error');
  const form = new URLSearchParams(body);

  // A filled honeypot looks like success to the bot and stores nothing.
  if (isBot(form)) return thanks();

  const email = normaliseEmail(form.get('email'));
  if (!isValidEmail(email)) return thanks('invalid');

  if (!env.IP_SALT) return text(500, 'IP_SALT is not set');
  const key = await ipKey(request.headers.get('CF-Connecting-IP'), env.IP_SALT, nowMs);
  const hits = await env.DB
    .prepare('INSERT INTO rate_limits (key, bucket, hits) VALUES (?1, ?2, 1) '
      + 'ON CONFLICT (key, bucket) DO UPDATE SET hits = hits + 1 RETURNING hits')
    .bind(key, hourBucket(nowMs))
    .first('hits');
  if (ctx && ctx.waitUntil) ctx.waitUntil(purgeRateLimits(env.DB, nowMs));
  if (hits > RATE.perHour) return thanks('limit');

  // One row per address. Signing up again updates the answers that were
  // given this time and keeps the earlier ones, the token and created_at.
  const a = sanitiseAnswers(form);
  const at = new Date(nowMs).toISOString();
  await env.DB
    .prepare('INSERT INTO subscribers (email, tools, price, feature, locale, token, created_at, updated_at) '
      + 'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7) '
      + 'ON CONFLICT (email) DO UPDATE SET '
      + 'tools = COALESCE(excluded.tools, tools), '
      + 'price = COALESCE(excluded.price, price), '
      + 'feature = COALESCE(excluded.feature, feature), '
      + 'locale = excluded.locale, '
      + 'updated_at = excluded.updated_at')
    .bind(email, a.tools, a.price, a.feature, a.locale, newToken(), at)
    .run();
  return thanks();
}

async function unsubscribe(request, env, base, url) {
  const token = url.searchParams.get('token');
  if (isToken(token)) {
    await env.DB.prepare('DELETE FROM subscribers WHERE token = ?1').bind(token).run();
  }
  // The same answer whether or not the token matched: a link cannot be used
  // to learn whether an address is on the list.
  if (request.method === 'POST') return text(200, 'Unsubscribed');
  return seeOther(sitePage(base, 'unsubscribed.html'));
}

export async function handle(request, env, ctx, nowMs = Date.now()) {
  const base = siteBase(env.SITE_URL);
  if (!base) return text(500, 'SITE_URL is not set');
  if (!env.DB) return text(500, 'DB is not bound');
  const url = new URL(request.url);
  try {
    if (url.pathname === '/' || url.pathname === '/subscribe') {
      if (request.method !== 'POST') return text(405, 'Method not allowed', { Allow: 'POST' });
      return await subscribe(request, env, ctx, base, nowMs);
    }
    if (url.pathname === '/unsubscribe') {
      if (request.method !== 'GET' && request.method !== 'POST') return text(405, 'Method not allowed', { Allow: 'GET, POST' });
      return await unsubscribe(request, env, base, url);
    }
  } catch (err) {
    // No details to the visitor; `wrangler tail` shows the error to the owner.
    console.error('waitlist:', err && err.message ? err.message : err);
    return url.pathname === '/unsubscribe' && request.method === 'POST'
      ? text(500, 'Error')
      : seeOther(sitePage(base, url.pathname === '/unsubscribe' ? 'unsubscribed.html' : 'thanks.html', 'error'));
  }
  return text(404, 'Not found');
}

export default {
  fetch(request, env, ctx) {
    return handle(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(purgeRateLimits(env.DB, Date.now()));
  },
};
