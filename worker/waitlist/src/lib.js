/* LimitPeek waitlist Worker: the pure parts. No I/O and no Cloudflare APIs
 * (only WebCrypto, which Node has too), so test/waitlist-worker.test.js loads
 * this file directly. src/index.js does the requests and the database. */

export const LIMITS = {
  emailMax: 254, // RFC 5321 path limit
  localMax: 64,
  featureMax: 200, // code points; the form says "at most 200 characters"
  bodyMax: 8192, // the whole form is a few hundred bytes
};

/* The only values the optional questions accept. Anything else is dropped,
 * so the database never holds free text except the one feature field. */
export const TOOLS = ['claude-code', 'codex', 'antigravity', 'kimi-code', 'qwen-code', 'grok-build', 'other'];
export const PRICES = ['none', 'upto3', '3to5', '5to10', 'more'];
export const LOCALES = ['tr', 'en'];

/* At most this many sign-ups per IP per hour. The IP itself is never stored:
 * only a salted hash that changes every UTC day, kept for at most a day. */
export const RATE = { perHour: 5, keepSeconds: 86400 };

/** Trimmed, NFC, lower-cased. Not a validity check: see isValidEmail. */
export function normaliseEmail(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFC').trim().toLowerCase();
}

const LOCAL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/**
 * A basic shape check on an already normalised address: ASCII only, one @,
 * a dot-atom local part, a domain of at least two labels with an alphabetic
 * (or punycode) top level. It does not prove the mailbox exists.
 */
export function isValidEmail(email) {
  if (typeof email !== 'string' || email.length > LIMITS.emailMax) return false;
  const at = email.indexOf('@');
  if (at < 1 || at !== email.lastIndexOf('@')) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > LIMITS.localMax || !LOCAL.test(local)) return false;
  if (domain.length > 253) return false;
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return false;
  return TLD.test(labels[labels.length - 1]);
}

/* Control characters, zero-width and bidi marks, line/paragraph separators
 * and a stray BOM: never wanted in a short answer, and the bidi ones can make
 * a stored line read differently from what it is. */
const UNWANTED = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;

/** One line of plain text, at most `max` code points, or '' when empty. */
export function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  let s = value.normalize('NFC').replace(UNWANTED, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(s);
  if (chars.length > max) s = chars.slice(0, max).join('').trim();
  return s;
}

function one(form, name) {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

/**
 * The optional answers, reduced to known values. `form` is anything with
 * get/getAll (URLSearchParams or FormData). Unanswered questions are null.
 *   tools    comma-separated ids from TOOLS, in TOOLS order, no duplicates
 *   price    one of PRICES
 *   feature  cleanText, at most LIMITS.featureMax code points
 *   locale   'tr' or 'en' (the page language, so a mail can match it)
 */
export function sanitiseAnswers(form) {
  const picked = new Set(form.getAll('tools').filter((v) => typeof v === 'string'));
  const tools = TOOLS.filter((t) => picked.has(t));
  const price = one(form, 'price');
  const locale = one(form, 'locale');
  return {
    tools: tools.length ? tools.join(',') : null,
    price: PRICES.includes(price) ? price : null,
    feature: cleanText(one(form, 'feature'), LIMITS.featureMax) || null,
    locale: LOCALES.includes(locale) ? locale : 'tr',
  };
}

/** The honeypot field is invisible to people; a bot that fills it is a bot. */
export function isBot(form) {
  return one(form, 'website').trim() !== '';
}

/**
 * The page sends `<meta name="referrer" content="no-referrer">`, so a real
 * submission carries Origin "null" (or none). Any other origin is another
 * site posting into the list.
 */
export function originAllowed(origin, siteOrigin) {
  return !origin || origin === 'null' || origin === siteOrigin;
}

/**
 * SITE_URL from the environment as a URL: https, or http on localhost for a
 * local test. null when missing or anything else, so the Worker refuses to
 * redirect anywhere it was not told to.
 */
export function siteBase(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let u;
  try { u = new URL(value.trim()); } catch { return null; }
  const local = u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  if ((u.protocol !== 'https:' && !local) || u.username || u.password) return null;
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  u.search = '';
  u.hash = '';
  return u;
}

/** A page of the site, with an optional state fragment (thanks.html#invalid). */
export function sitePage(base, page, state) {
  const u = new URL(page, base);
  if (state) u.hash = state;
  return u.href;
}

/** The hour number since the epoch: the rate limit's window. */
export function hourBucket(nowMs) {
  return Math.floor(nowMs / 3600000);
}

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * SHA-256 over the secret salt, the UTC day and the IP. The salt never leaves
 * the Worker and the day changes the hash every midnight, so a stored key
 * cannot be turned back into an IP or linked across days.
 */
export async function ipKey(ip, salt, nowMs) {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const data = new TextEncoder().encode(String(salt) + '\n' + day + '\n' + String(ip || ''));
  return hex(await crypto.subtle.digest('SHA-256', data));
}

/** 32 random bytes as hex: the unsubscribe token. */
export function newToken() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

export function isToken(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
