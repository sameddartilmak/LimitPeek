/**
 * Turkish formatting. Every numeral in the panel goes through here.
 *
 * Rules that are not negotiable:
 *  - locale is always 'tr-TR' (decimal comma, thousand dot)
 *  - the percent sign PRECEDES the number: %62
 *  - no `toUpperCase()` and no `text-transform: uppercase` anywhere, because
 *    both map i -> I, which is wrong in Turkish (the pair is i/İ and ı/I)
 *  - a value that ROUNDS into a claim it cannot support is never printed. That
 *    rule has now caught the same bug four times (the zero countdown, the tray
 *    sweep, "$0,00" and "%0"), so the thresholds live here, once, and every
 *    formatter that can round to a boundary states a bound instead.
 */

import { STATE_THRESHOLDS, type StateStep } from '../../shared/contract.js';

const nfInt = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 });
const nfCompact = new Intl.NumberFormat('tr-TR', {
  notation: 'compact',
  compactDisplay: 'short',
  maximumFractionDigits: 1,
});
/**
 * USD, Turkish separators: "$226,81", "$1.234,50".
 *
 * The app is tr-TR throughout (`<html lang="tr">`), so a Turkish reader parses
 * "." as the thousands group and "," as the decimal — the figure is not
 * ambiguous TO ITS READER, which is the only reader it has. The "$" beside
 * Turkish separators is the one thing that could give a bilingual reader pause,
 * so the FIRST and largest instance in any block uses `usdWithUnit()` to name
 * the currency outright, and the small figures below it inherit that context.
 */
const nfUsd = new Intl.NumberFormat('tr-TR', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const nfUsdNamed = new Intl.NumberFormat('tr-TR', {
  style: 'currency',
  currency: 'USD',
  currencyDisplay: 'name',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const nfShare = new Intl.NumberFormat('tr-TR', { style: 'percent', maximumFractionDigits: 0 });
const dtDay = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long' });
const dtDate = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
const dtClock = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' });
const dtClockDay = new Intl.DateTimeFormat('tr-TR', {
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const FIVE_HOURS = 5 * HOUR;

/** "%62" — sign first, integer only. Callers pass 0..100. */
export function percent(value: number): string {
  return '%' + nfInt.format(Math.round(value));
}

/** Long form for screen readers: "yüzde 62". */
export function percentSpoken(value: number): string {
  return 'yüzde ' + nfInt.format(Math.round(value));
}

export function integer(value: number): string {
  return nfInt.format(value);
}

/** 1_240_000 -> "1,2 Mn". Turkish compact: B (bin), Mn (milyon), Mr (milyar). */
export function compact(value: number): string {
  return nfCompact.format(value);
}

export function tokens(value: number): string {
  return compact(value) + ' token';
}

export function burnRate(value: number): string {
  return compact(value) + ' token/sa';
}

/**
 * Billable tokens measured locally since a stale capture. Rendered as a signed
 * delta because that is what it is: a measured floor on how much more has been
 * spent since the percentage was true. It is never divided into a percentage.
 */
export function sinceCapture(value: number): string {
  return `o zamandan beri +${compact(value)} token`;
}

/** "14:10 itibarıyla" — the instant a stale percentage was actually true. */
export function asOf(iso: string): string {
  return `${clockTime(iso)} itibarıyla`;
}

export function clockTime(iso: string | number | Date): string {
  return dtClock.format(new Date(iso as never));
}

export function clockTimeWithDay(iso: string | number | Date): string {
  return dtClockDay.format(new Date(iso as never));
}

/** Short countdown for the row: "2 sa 14 dk" / "14 dk" / "48 sn". */
export function countdown(msRemaining: number): string {
  if (!Number.isFinite(msRemaining) || msRemaining < 1000) return 'sıfırlanıyor';
  const totalSec = Math.floor(msRemaining / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  // A zero minor unit is dropped: "1 saat 0 dakika" is not how the duration is
  // said out loud, and the trailing zero reads as precision that is not there.
  if (h >= 48) {
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return rh === 0 ? `${nfInt.format(d)} gün` : `${nfInt.format(d)} gün ${nfInt.format(rh)} sa`;
  }
  if (h > 0) return m === 0 ? `${nfInt.format(h)} sa` : `${nfInt.format(h)} sa ${nfInt.format(m)} dk`;
  if (m > 0) return `${nfInt.format(m)} dk`;
  return `${nfInt.format(s)} sn`;
}

/**
 * The countdown as the row prints it, suffix included. The suffix lives here
 * because at zero the string is not a duration any more — "sıfırlanıyor kaldı"
 * is not Turkish, and a caller appending " kaldı" cannot know that.
 */
export function countdownRemaining(msRemaining: number): string {
  if (!Number.isFinite(msRemaining) || msRemaining < 1000) return 'sıfırlanıyor';
  return countdown(msRemaining) + ' kaldı';
}

/** Spoken countdown: abbreviations read badly, so spell the units out. */
export function countdownSpoken(msRemaining: number): string {
  if (!Number.isFinite(msRemaining) || msRemaining < 1000) return 'şu anda sıfırlanıyor';
  const totalSec = Math.floor(msRemaining / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h >= 48) {
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return rh === 0
      ? `${nfInt.format(d)} gün`
      : `${nfInt.format(d)} gün ${nfInt.format(rh)} saat`;
  }
  if (h > 0) {
    return m === 0
      ? `${nfInt.format(h)} saat`
      : `${nfInt.format(h)} saat ${nfInt.format(m)} dakika`;
  }
  if (m > 0) return `${nfInt.format(m)} dakika`;
  return `${nfInt.format(totalSec % 60)} saniye`;
}

/** "şimdi" / "3 dk önce" / "2 sa önce" / "12.03 14:20". */
export function ago(msElapsed: number): string {
  if (!Number.isFinite(msElapsed) || msElapsed < MINUTE) return 'şimdi';
  const min = Math.floor(msElapsed / MINUTE);
  if (min < 60) return `${nfInt.format(min)} dk önce`;
  const hours = Math.floor(msElapsed / HOUR);
  if (hours < 24) return `${nfInt.format(hours)} sa önce`;
  const days = Math.floor(hours / 24);
  return `${nfInt.format(days)} gün önce`;
}

export function agoSpoken(msElapsed: number): string {
  if (!Number.isFinite(msElapsed) || msElapsed < MINUTE) return 'az önce';
  const min = Math.floor(msElapsed / MINUTE);
  if (min < 60) return `${nfInt.format(min)} dakika önce`;
  const hours = Math.floor(msElapsed / HOUR);
  if (hours < 24) return `${nfInt.format(hours)} saat önce`;
  return `${nfInt.format(Math.floor(hours / 24))} gün önce`;
}

/**
 * Monogram letter. Uses the Turkish locale mapping, never toUpperCase().
 *
 * No longer used by the row — every provider now has a drawn mark
 * (components/logo.ts) instead of a letter tile. Kept because it is the one
 * place the i/İ vs ı/I rule is expressed and tested, and because any future
 * initial-from-a-name needs it to be this function and not toUpperCase().
 */
export function monogramLetter(displayName: string): string {
  const first = Array.from(displayName.trim())[0] ?? '?';
  return first.toLocaleUpperCase('tr-TR');
}

/**
 * A notional USD figure.
 *
 * A cost strictly greater than zero that rounds to "$0,00" is the silent-zero
 * failure of ADR-002 rule 2 in miniature: a real, priced amount printed as
 * nothing at all reads as free. Below a cent it is reported as an upper bound
 * instead, which is true and cannot be misread.
 */
const SUB_CENT = 0.005;

export function usd(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value > 0 && value < SUB_CENT) return '<$0,01';
  return nfUsd.format(value);
}

/**
 * The same figure with the currency named. Used ONCE per block, on the largest
 * instance, so "$" beside Turkish separators cannot be misread.
 *
 * Carries the SAME sub-cent bound as `usd()`. It did not, and the result was a
 * collapsed line reading "<$0,01" two lines above an expanded headline reading
 * "$0,00 ABD doları" — and that headline is also the toggle's aria-label, so it
 * was the only figure a screen-reader user received. The bound is prefixed to
 * the formatted one-cent string rather than rebuilt, so the currency name comes
 * from locale data and not from a hand-written suffix.
 */
export function usdWithUnit(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value > 0 && value < SUB_CENT) return '<' + nfUsdNamed.format(0.01);
  return nfUsdNamed.format(value);
}

/**
 * A share of a whole, 0..1 -> "%65". Never a limit; never on the state ramp.
 *
 * Bounded at both ends for the same reason `usd()` is bounded at one. A real
 * share that rounds to "%0" reads as "none of it", and a caveat that printed
 * "7 / 1.724 kayıtta (%0)" contradicted its own numerator. Likewise "%100" for
 * a share that is not the whole thing. Same convention as "<$0,01": one
 * spelling for one idea, rather than a special decimal case at each end.
 */
export function share(fraction: number): string {
  if (!Number.isFinite(fraction)) return '';
  if (fraction <= 0) return nfShare.format(0);
  if (fraction >= 1) return nfShare.format(1);
  if (fraction < 0.005) return '<%1';
  if (fraction >= 0.995) return '>%99';
  return nfShare.format(fraction);
}

/**
 * The date a price list was current: "24 Haziran 2026".
 *
 * A bare "YYYY-MM-DD" parses as UTC midnight, so west of Greenwich `new Date()`
 * would render the day BEFORE the one written down. The date parts are read
 * literally and rebuilt in local time, because this string is a calendar date,
 * not an instant.
 */
export function priceDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  const date = m
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    : new Date(iso);
  return Number.isFinite(date.getTime()) ? dtDate.format(date) : iso;
}

/** "3 Eylül – 10 Eylül". An en dash, not a hyphen: this is a range. */
export function dayRange(startIso: string, endIso: string): string {
  const a = new Date(startIso);
  const b = new Date(endIso);
  if (!Number.isFinite(a.getTime()) || !Number.isFinite(b.getTime())) return '';
  return `${dtDay.format(a)} – ${dtDay.format(b)}`;
}

// Re-exported, not redeclared: one definition of the ramp's four steps.
export type { StateStep };

/**
 * The state ramp. The single thing allowed to color a meter.
 *
 * Compares the ROUNDED value, because that is the number actually on screen:
 * percent() prints Math.round(), so 99,6 reads "%100" and must be styled
 * 'spent'. A "%100" in ember reads as a bug in a product whose whole claim is
 * that the figure shown is exactly true.
 */
export function stateFor(usedPercentage: number): StateStep {
  const shown = Math.round(usedPercentage);
  if (shown >= STATE_THRESHOLDS.spent) return 'spent';
  if (shown >= STATE_THRESHOLDS.ember) return 'ember';
  if (shown >= STATE_THRESHOLDS.watch) return 'watch';
  return 'calm';
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Millisecond ISO parse that never throws and never returns NaN downstream. */
export function parseInstant(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string' || iso.length === 0) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * The notice cap. Layout, not policy: the notice is a two-or-three-line box in
 * a 360px panel, and a message longer than this pushes the footer off screen.
 */
export const NOTICE_MAX = 160;

/**
 * Terminators a truncated notice may end on WITHOUT an ellipsis.
 *
 * Full stops only. ':' and ';' were in this set and the result was
 * "…yeniden basın;" — a clause boundary presented as a finished message, with
 * the instruction after the semicolon silently gone and no mark saying so.
 * A colon is in fact the strongest possible promise that more follows. Those
 * two are left to the word-boundary rule below, which keeps the ellipsis.
 */
const SENTENCE_END = new Set(['.', '!', '?', '…']);
/** Not `\s` inline: a fresh literal per loop iteration is pure garbage. */
const WHITESPACE = /\s/;

/**
 * Trim a notice to the cap, cutting at a boundary the language recognises.
 *
 * WHY THE OLD `slice(0, 159) + '…'` WAS A DEFECT AND NOT A COMPROMISE
 * -------------------------------------------------------------------
 * A character index lands wherever it lands. The Antigravity "CLI bulunamadı"
 * message is 172 characters, so the cut fell mid-word and took the ACTIONABLE
 * half of the sentence with it — the user was left with a diagnosis and no
 * instruction. Lengthening the cap only moves the index; it does not stop it
 * landing inside a word, and the cap has a real layout reason to exist.
 *
 * So the cut walks BACKWARDS from the cap to the nearest boundary:
 *
 *   1. a sentence terminator, if one falls in the last third of the budget.
 *      Ending on a whole sentence is the only cut that loses no meaning at
 *      all, and it drops the ellipsis: the text that remains is complete, so
 *      claiming it was truncated would be the second-hand version of the same
 *      lie. The last-third floor stops a single early period ("Antigravity
 *      CLI bulunamadı." at char 30 of 160) from throwing away everything after
 *      it — which would be a worse cut than the character one it replaced.
 *   2. otherwise the last whitespace run, so the visible fragment ends on a
 *      whole word and the ellipsis says the rest is missing.
 *   3. otherwise — a 160-character string with no space in it at all, e.g. a
 *      path or a token — the character cut, because there is no boundary to
 *      find and refusing to render is worse than a hard cut.
 *
 * The ellipsis is appended, never counted into the budget as the old code did
 * by slicing to 159: the cap is about how much text fits, and it is the
 * boundary search that decides where the text stops.
 */
export function trimMessage(message: string, max = NOTICE_MAX): string {
  const clean = message.trim();
  if (clean.length === 0) return '';
  if (clean.length <= max) return clean;

  // Include the character AT the cap: if the budget ends exactly on a space or
  // a full stop, that boundary is inside the budget and must be findable.
  const head = clean.slice(0, max + 1);
  const floor = Math.floor(max / 3);

  for (let i = head.length - 1; i >= floor; i -= 1) {
    if (!SENTENCE_END.has(head.charAt(i))) continue;
    const upTo = head.slice(0, i + 1).trimEnd();
    // A terminator with nothing but the terminator behind it is punctuation,
    // not a sentence.
    if (upTo.length > 1) return upTo;
  }

  for (let i = head.length - 1; i > 0; i -= 1) {
    if (!WHITESPACE.test(head.charAt(i))) continue;
    const upTo = head.slice(0, i).trimEnd();
    if (upTo.length > 0) return upTo + '…';
  }

  return clean.slice(0, max) + '…';
}
