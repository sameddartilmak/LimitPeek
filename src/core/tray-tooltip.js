'use strict';
const { leadProvider, windowPercentage, windowResetting, READING_HORIZON_MS } = require('./tray-spec');
const i18n = require('./i18n');

const { t } = i18n;

/**
 * The native tray tooltip.
 *
 * This is the FOURTH surface printing the same number — the panel meter, the
 * donut, the panel's text and now this — so it obeys the same two rules the
 * other three do: the format locale main resolved, and the ROUNDED value,
 * always. A tooltip
 * carrying `%61,6` beside a panel printing `%62` would be the one place in the
 * product that disagrees with itself about what the usage is.
 *
 * It also inherits ADR-001's honesty rule verbatim, through
 * `windowPercentage()`: no window, `certainty: 'unknown'`, a null percentage or
 * a disconnected provider all mean the same thing, and the tooltip says so in
 * words rather than printing a number it cannot defend.
 *
 * Shape: ONE WINDOW PER LINE, each line a `Etiket: değer` pair carrying that
 * window's figure and — parenthesised, subordinate to it — how long is left on
 * it.
 *
 *   Usage Notch — Claude Code
 *   5 saatlik limit: %62 (2 sa 14 dk kaldı)
 *   Haftalık limit: %41 (3 gün 4 sa kaldı)
 *
 * The user asked for the weekly reset as well, which is a fourth fact, and a
 * fourth LINE does not fit `szTip` (see TOOLTIP_MAX). The previous shape gave
 * the countdown its own line under the figure it described; that was one idea
 * per line, but it also wrote the two windows in two different shapes — one
 * with a countdown, one without — and only one of them could afford it. They
 * are parallel now, which is what they are: the same question over two
 * horizons. The parenthesis is deliberately not the old ` · ` separator: a
 * middle dot joins two independent facts, which is what made the old one-line
 * form hard to read, while a parenthetical subordinates the duration to the
 * figure it qualifies, so the eye still finds one value per line.
 *
 * No `electron` import: this is text, and text is testable under plain
 * `node --test`. `src/main/index.js` hands the result to `Tray.setToolTip`.
 */

/**
 * Practical cap, in UTF-16 code units.
 *
 * Windows delivers a tray tooltip through `NOTIFYICONDATAW.szTip`, which is
 * `WCHAR[128]` — 127 characters plus the terminator — and the shell truncates
 * anything longer WITHOUT reporting it. Measured on Electron 44.2.0 here:
 * `Tray.setToolTip` accepts 128, 200, 512 and 4096-character strings without
 * throwing, and exposes no getter, so nothing at the API layer will ever tell
 * us the string was cut. The budget therefore has to be enforced on this side.
 *
 * 120 rather than 127: the margin absorbs a longer provider name or a wider
 * countdown ("2 gün 3 sa") without the last line landing mid-word.
 */
const TOOLTIP_MAX = 120;

/**
 * The percentage formatter for the current format locale, rebuilt only when
 * the locale changes. Same options as `percent` in `src/renderer/src/format.ts`
 * — `style: 'percent'`, no fraction digits — so the sign's placement comes from
 * Intl in both surfaces: `%62` in tr-TR, `62%` in en-US and en-GB.
 */
let percentFormat = null;
let percentLocale = '';
function percentFormatter() {
  const locale = i18n.formatLocale();
  if (!percentFormat || percentLocale !== locale) {
    percentFormat = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
    percentLocale = locale;
  }
  return percentFormat;
}

/**
 * ROUNDED first, then formatted as a fraction — `%20` / `20%`, never `%20,0`.
 * The printed integer is exactly `Math.round(value)` in every locale, which is
 * what the donut's state compares.
 */
function formatPercent(value) {
  return percentFormatter().format(Math.round(value) / 100);
}

/**
 * Short countdown, mirroring `countdown()` in `src/renderer/src/format.ts`.
 *
 * Restated rather than imported because that file is TypeScript owned by the
 * renderer lane and cannot be required from a CommonJS main process. The
 * duplication is deliberate and narrow: same units, same dropped-zero rule,
 * and the SAME catalog keys, so the tooltip and the row read alike in either
 * language. `tooltip-parity.test.js` runs both.
 */
function countdown(msRemaining, daysFromHours = 48) {
  if (!Number.isFinite(msRemaining) || msRemaining < 1000) return t('countdown.resetting');
  const totalSec = Math.floor(msRemaining / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h >= daysFromHours) {
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return rh === 0
      ? t('duration.short.days', { d })
      : t('duration.short.daysHours', { d, h: rh });
  }
  if (h > 0) {
    return m === 0
      ? t('duration.short.hours', { h })
      : t('duration.short.hoursMinutes', { h, m });
  }
  if (m > 0) return t('duration.short.minutes', { m });
  return t('duration.short.seconds', { s });
}

/**
 * The staleness horizon, from `tray-spec.js`. Governs the countdown AND the
 * number beside it.
 *
 * The tooltip has no clock: it is written when a snapshot arrives and read
 * whenever the user happens to hover, up to `Collector.SWEEP_IDLE_MS` later.
 * That argument was originally applied to the countdown alone, which was
 * half a fix — the percentage ages out on exactly the same schedule and with
 * worse consequences. A window that reset thirty seconds ago still printed
 * `5sa: %98`, with the countdown correctly gone, so the tooltip made the
 * staleness case and then ignored it for the figure beside it.
 *
 * Both now defer to `windowResetting()`.
 */
const COUNTDOWN_FLOOR_MS = READING_HORIZON_MS;

/**
 * "2 sa 14 dk kaldı", or null when nothing true can be said about the time.
 *
 * Character-for-character what the panel row prints for the same instant
 * (`countdownRemaining()` in `src/renderer/src/format.ts`), which is the point:
 * the tooltip and the row are read seconds apart and must not disagree about
 * how long is left. `tooltip-parity.test.js` runs both.
 *
 * Null on three counts, and each of them is a parenthetical that must not be
 * printed: no `resetsAt` at all (a fresh capture with no reset instant to
 * reason about), one that will not parse, and one already inside
 * READING_HORIZON_MS — the tooltip has no clock, so a countdown that expires
 * before it is read is worse than no countdown.
 */
function remaining(win, now) {
  if (!win || typeof win.resetsAt !== 'string') return null;
  const at = Date.parse(win.resetsAt);
  if (!Number.isFinite(at)) return null;
  if (windowResetting(win, now)) return null;
  // `countdownRemaining()` in format.ts, key for key.
  return t('countdown.remaining', { duration: countdown(at - now) });
}

/**
 * The time left alone, "2 sa 14 dk", for a surface that has no room for the
 * word "kaldı" (the taskbar strip). Null on exactly the counts `remaining()`
 * is null, so the strip never shows a countdown the tooltip would refuse.
 */
function remainingDuration(win, now, daysFromHours = 48) {
  if (!win || typeof win.resetsAt !== 'string') return null;
  const at = Date.parse(win.resetsAt);
  if (!Number.isFinite(at)) return null;
  if (windowResetting(win, now)) return null;
  return countdown(at - now, daysFromHours);
}

/**
 * The labels.
 *
 * `5sa` and `Hafta` were abbreviations that only made sense to someone who had
 * already read the panel. `5sa` in particular reads as a token rather than a
 * duration, and neither said what the number after it MEANT — 62% of what?
 * Spelled out, each line is a plain "this thing: this value" pair the eye can
 * scan down, and the three labels line up in the same shape.
 *
 * Short enough in both languages that the value is the widest thing on the
 * line, which is what makes the numbers easy to find.
 *
 * Every word below is read from the catalog at CALL time, never captured at
 * load: a language change must re-word the next tooltip without a restart.
 */
const fiveLabel = () => t('tooltip.fiveHourLabel');
const weekLabel = () => t('tooltip.weeklyLabel');
/**
 * The word that turns a bare duration into a countdown inside the
 * parenthetical. Was the label `Yenilenmesine kalan:` on a line of its own; as
 * a suffix it says the same thing in one word, and it is the SAME catalog
 * entry the panel row uses (`countdown.remaining`), so the two surfaces read
 * alike. Exported for tests as the entry with its duration removed.
 */
const remainingWord = () => t('countdown.remaining', { duration: '' }).trim();

/**
 * Said INSTEAD of a percentage when we cannot defend one.
 *
 * Was `yüzde bilinmiyor`. Under a bare `5sa:` the word "yüzde" had to carry
 * the subject on its own; under `5 saatlik limit:` it is already stated by the
 * label, and repeating it made the line longer without making it clearer.
 */
const noPercent = () => t('absence.unknown');
/**
 * Said INSTEAD of `bilinmiyor` when the source does not publish this window at
 * all.
 *
 * The two are different claims and the difference is load-bearing. The
 * Antigravity IDE store carries a five-hour quota and no weekly one, while
 * Antigravity's own UI shows the user a weekly limit — so "bilinmiyor" on that
 * line reads as "we lost it", which the user can disprove by looking at the
 * other window on their screen, and every honest `bilinmiyor` elsewhere gets
 * less believable for it. `bildirilmiyor` says the true thing: there is a
 * limit, this source does not report it.
 */
const notSupplied = () => t('absence.notReported');
/**
 * Said INSTEAD of the number when the window is at or past its reset.
 *
 * Deliberately not silence. An absent line reads as the tooltip breaking, and
 * an absence that looks like an absence of data is the collision this project
 * keeps finding. Deliberately not `bilinmiyor` either: we know exactly why
 * there is no figure, and the reason is the one the user is most likely
 * hovering to ask about.
 *
 * Was `pencere sıfırlanıyor`. "Pencere" is our word for a rate-limit window,
 * not the user's — and on a desktop it names something else entirely. With the
 * label saying which limit it is, `yenileniyor` states the same fact in the
 * user's vocabulary.
 */
const resetting = () => t('absence.resetting');

/**
 * The line for one window: a figure with its countdown, a reset notice, or an
 * honest blank.
 *
 * The countdown is attached HERE rather than assembled by the caller, which is
 * what stops it outliving the figure it frames: there is no path that puts a
 * parenthetical after `bilinmiyor` or `yenileniyor`, because those two returns
 * never reach it. Both windows come through this one function, so the
 * READING_HORIZON_MS rule the five-hour line has always had governs the weekly
 * line by construction rather than by a second copy of the check.
 */
function windowLine(label, provider, key, now) {
  const win = provider ? provider[key] : null;
  const pct = windowPercentage(provider, key, now);
  if (pct === null) {
    // `windowPercentage` returns null for every cause, so the cause is asked
    // for separately — "we cannot state this", "this is not reported" and "it
    // just reset" are three different sentences, and the last two are the
    // useful ones.
    if (windowResetting(win, now)) return `${label}: ${resetting()}`;
    if (win && win.absence === 'not-supplied') return `${label}: ${notSupplied()}`;
    return `${label}: ${noPercent()}`;
  }
  const figure = `${label}: ${formatPercent(pct)}`;
  const left = remaining(win, now);
  return left === null ? figure : `${figure} (${left})`;
}

/**
 * The lines the tooltip is built from, most important first.
 *
 * Three, not four: each window line carries its own countdown now, so a
 * countdown can no longer be dropped separately from the figure it describes.
 * `week` is null only when there is no provider to describe at all.
 *
 * @returns {{head:string, five:string, week:string|null}}
 */
function tooltipParts(snapshot, now = Date.now()) {
  const provider = leadProvider(snapshot);
  const name = provider && typeof provider.displayName === 'string' && provider.displayName
    ? provider.displayName
    : null;

  if (!provider || !name) {
    // Either the snapshot is empty or the user has added nothing to the panel.
    // Both mean the icon is drawing the no-data ring, and the tooltip has to
    // agree with it: naming a provider here would describe a row that is not
    // on screen.
    return {
      head: 'Usage Notch',
      five: t('tooltip.noProviders'),
      week: null,
    };
  }

  const head = `Usage Notch — ${name}`;
  // Identical treatment, on purpose. The weekly window resets far more rarely,
  // which makes it easier to forget and no less wrong when it happens — and
  // its countdown is the one the user asked for.
  const five = windowLine(fiveLabel(), provider, 'fiveHour', now);
  const week = windowLine(weekLabel(), provider, 'sevenDay', now);

  return { head, five, week };
}

/**
 * The tooltip string, multi-line and inside the shell's budget.
 *
 * Degradation is by DROPPING THE LEAST IMPORTANT LINE, in order, rather than
 * by slicing: a hard cut lands mid-word and, worse, can cut a percentage in
 * half — `%10` where the panel says `%100`. The weekly line goes first, then
 * the whole five-hour line, and only a pathological provider name reaches the
 * final slice.
 *
 * The ladder has one rung fewer than it did, because a window's countdown is
 * no longer separable from its figure. What is gone is the rung that kept a
 * bare weekly figure after dropping the five-hour countdown; nothing realistic
 * reaches it. The worst case the suite measures — longest `displayName` in the
 * registry, both windows at three digits, both countdowns multi-day — is 110
 * of the 120 characters, so the ladder is a guarantee against a pathological
 * provider name rather than a routine path.
 */
function buildTooltip(snapshot, now = Date.now(), max = TOOLTIP_MAX) {
  const { head, five, week } = tooltipParts(snapshot, now);
  const variants = [
    [head, five, week].filter(Boolean),
    [head, five].filter(Boolean),
    [head],
  ];
  for (const lines of variants) {
    const text = lines.join('\n');
    if (text.length <= max) return text;
  }
  return head.slice(0, max);
}

module.exports = {
  buildTooltip,
  tooltipParts,
  countdown,
  remainingDuration,
  formatPercent,
  TOOLTIP_MAX,
  COUNTDOWN_FLOOR_MS,
};

// The words, for tests, in the language current at the moment they are READ.
// Getters rather than values: a value captured at require time would pin
// whichever language was active when the test file loaded.
Object.defineProperties(module.exports, {
  RESETTING: { enumerable: true, get: resetting },
  NO_PERCENT: { enumerable: true, get: noPercent },
  NOT_SUPPLIED: { enumerable: true, get: notSupplied },
  FIVE_LABEL: { enumerable: true, get: fiveLabel },
  WEEK_LABEL: { enumerable: true, get: weekLabel },
  REMAINING: { enumerable: true, get: remainingWord },
});
