/**
 * The window blocks: one per usage window, five-hour and weekly.
 *
 * WHY THIS REPLACED THE TWIN-TRACK METER
 * --------------------------------------
 * The old meter drew the weekly window as a 2px hairline under the 6px
 * five-hour rail and printed neither its percentage nor its reset time. It was
 * on screen and it was still reported as missing — "haftalık kullanım
 * göstermiyor" — because a hairline with no figure beside it reads as
 * decoration. A window the product measures and refuses to name is, to the
 * user, a window the product does not measure.
 *
 * So each window now gets the SAME block: its own label, its own percentage,
 * its own full-height bar, its own reset countdown. Nothing about the weekly
 * block is quieter than the five-hour one. The two are told apart by their
 * labels and their numbers, which is the only distinction that survives a
 * screenshot.
 *
 * WHAT DID NOT CHANGE
 * -------------------
 *  - The state ramp still colours the bar and the percentage, and it is still
 *    derived from the ROUNDED value (format.stateFor). It is derived PER
 *    WINDOW now, because a weekly window at %19 beside a five-hour window at
 *    %91 are two different answers to "am I near the limit" and one colour
 *    cannot carry both.
 *  - `certainty: 'unknown'`, or a null percentage, still draws NO bar and NO
 *    percentage. The block does not vanish, though: it names the window and
 *    says "bilinmiyor" in place of the figure, which is the difference between
 *    "we cannot say" and "we did not look" — the exact confusion that made the
 *    weekly window read as absent in the first place.
 *  - `estimated` still frays its terminus instead of drawing a tick, and still
 *    prints the approximation sign in front of the figure.
 *
 * Nothing here animates via width/left. The fill is `transform: scaleX()` and
 * the tick counter-scales, so the whole thing stays on the compositor.
 */

import type { WindowAbsence, WindowUsage } from '../../../shared/contract.js';
import { el, setAttr, setText } from '../dom.js';
import {
  asOf,
  clockTime,
  compact,
  countdownRemaining,
  countdownSpoken,
  parseInstant,
  percent,
  percentSpoken,
  mixWithin,
  stateFor,
} from '../format.js';
import { t } from '../i18n.js';

export type WindowKind = '5h' | '7d';

interface WindowCopy {
  /** The label printed above the bar. */
  label: string;
  /**
   * The two- or three-character tag the compact layouts print before the
   * figure ("5sa %62 · 7g %41"). Printed only there (layout-*.css); the full
   * label is what the details and every spoken sentence use.
   */
  tag: string;
  /** The name a screen reader hears for the meter. */
  spoken: string;
}

/**
 * Window copy, one place, read in the current language. No `toUpperCase()` and
 * no `text-transform` — the reference layout's ALL-CAPS section labels are not
 * available to us, so the hierarchy is carried by size, weight and ink instead
 * (see row.css).
 */
function copyFor(kind: WindowKind): WindowCopy {
  // The SHORT label ("5 saatlik", "Haftalık"): the two windows now sit side by
  // side as equal columns, and the full name is still what a screen reader
  // hears and what the details and the tooltip say.
  return kind === '5h'
    ? { label: t('meter.window5h.short'), tag: t('meter.window5h.tag'), spoken: t('meter.window5h.spoken') }
    : { label: t('meter.window7d.short'), tag: t('meter.window7d.tag'), spoken: t('meter.window7d.spoken') };
}

/**
 * What is printed in place of the figure, per `WindowAbsence`.
 *
 * THREE WORDINGS FOR FIVE CAUSES, AND WHY NOT FIVE
 * ------------------------------------------------
 * The five causes are machine-readable so the renderer CAN distinguish them.
 * That is not the same as an obligation to. Five near-synonyms in the same
 * 11px slot would be five things the user has to learn to tell apart, and four
 * of them would say the same thing about what to do next. So they collapse to
 * the smallest set that carries a difference the user can act on:
 *
 *   'not-supplied'  -> "bildirilmiyor". The one that MUST be split out. The
 *                      Antigravity IDE store carries no weekly figure while
 *                      Antigravity's own UI shows the user a weekly limit, so
 *                      "bilinmiyor" is a claim they can disprove on their own
 *                      screen — and a product whose stated argument is "never
 *                      show a number you cannot defend" cannot afford one
 *                      falsifiable sentence. It is also the only cause with a
 *                      cause worth printing, so it alone carries a foot line.
 *   'rolled-over'   -> "yenileniyor". Precedent, not invention:
 *                      src/core/tray-tooltip.js chose exactly this word over
 *                      "bilinmiyor" with exactly this reasoning — we know why
 *                      there is no figure, and it is the thing the user is
 *                      most likely looking to find out. The panel said
 *                      "bilinmiyor" for the same state, so two surfaces
 *                      disagreed about one fact.
 *   everything else -> "bilinmiyor", unchanged.
 *
 * `stale` was considered for its own line and deliberately does not get one.
 * The row ALREADY states it, better, one line down: `row.ts` renders
 * `refs.staleAge` ("112 gün önce güncellendi") for exactly the case where a
 * stale row has no capture instant to name, and that line carries the real
 * duration and is repainted every second. A second word for it in the figure
 * slot would be the same fact in two places, and the worse copy would be the
 * one without the number in it.
 */
const NO_FIGURE = (): string => t('absence.unknown');

interface AbsenceCopy {
  /** Replaces the figure. */
  figure: string;
  /** The sentence a screen reader hears for the whole block. */
  spoken: (label: string) => string;
  /** Printed under the block. Only the cause worth explaining has one. */
  reason: string | null;
}

/**
 * The words live in the shared catalogs (common.json `absence.*` — the SAME
 * keys the tray tooltip reads, so the panel and the tooltip cannot name one
 * absence two ways). The record is built per call so it follows the language.
 */
function absenceTable(): Partial<Record<WindowAbsence, AbsenceCopy>> {
  return {
  'not-supplied': {
    figure: t('absence.notReported'),
    // "yayımlamıyor" — does not PUBLISH it. Deliberately not "vermiyor" or
    // "yok": the limit exists and the user can see it elsewhere; what is
    // missing is a published number for us to read. Denying the limit would be
    // the same falsifiable claim in different words.
    reason: t('meter.notSupplied.reason'),
    spoken: (label) => t('meter.notSupplied.spoken', { label }),
  },
  'rolled-over': {
    figure: t('absence.resetting'),
    reason: null,
    spoken: (label) => t('meter.rolledOver.spoken', { label }),
  },
  // Connected and current, but the number for THIS window has not landed yet.
  // Deliberately not "bilinmiyor" (which reads as "we did not look") and not
  // "yenileniyor" (the window did not reset — it is fresh and simply unreported
  // so far). No reason line: the word already says the whole of it, and the
  // reset countdown beneath still carries when the window turns over.
  'awaiting-report': {
    figure: t('absence.awaiting'),
    reason: null,
    spoken: (label) => t('meter.awaiting.spoken', { label }),
  },
  };
}

/**
 * The word printed in place of a figure, for a caller outside the block: the
 * row's hover line says "Haftalık bildirilmiyor" with the same word the block
 * prints, from the same table, so the two can never name one absence twice.
 */
export function absenceFigure(usage: WindowUsage | null | undefined): string {
  return absenceCopy(usage).figure;
}

function absenceCopy(usage: WindowUsage | null | undefined): AbsenceCopy {
  const found = usage?.absence ? absenceTable()[usage.absence] : undefined;
  return (
    found ?? {
      figure: NO_FIGURE(),
      reason: null,
      spoken: (label: string) => t('meter.unknown.spoken', { label }),
    }
  );
}

export interface MeterHandle {
  el: HTMLElement;
  update(
    fiveHour: WindowUsage | null,
    sevenDay: WindowUsage | null,
    stale: boolean,
    now: number,
  ): void;
  /** 1Hz: refresh the countdowns without touching anything else. */
  tick(now: number): void;
}

/** True when the window carries a percentage we are allowed to draw. */
export function isDrawable(usage: WindowUsage | null | undefined): usage is WindowUsage {
  return (
    !!usage &&
    usage.certainty !== 'unknown' &&
    typeof usage.usedPercentage === 'number' &&
    Number.isFinite(usage.usedPercentage)
  );
}

/**
 * The figure itself. Certainty lives in the bar geometry, but the number has
 * to carry it too, or an estimate and a server-computed truth read identically
 * in plain text. The approximation sign is a numeric convention, not a badge.
 */
export function percentLabel(usage: WindowUsage): string {
  const value = percent(usage.usedPercentage as number);
  return usage.certainty === 'estimated' ? '≈' + value : value;
}

function valueText(usage: WindowUsage, label: string, now: number): string {
  const value = usage.usedPercentage as number;
  const parts: string[] = [];

  if (usage.certainty === 'estimated') {
    parts.push(t('meter.value.estimated', { label, percent: percentSpoken(value) }));
    if (typeof usage.confidenceLo === 'number' && typeof usage.confidenceHi === 'number') {
      parts.push(
        t('meter.value.range', {
          low: percentSpoken(usage.confidenceLo),
          high: percentSpoken(usage.confidenceHi),
        }),
      );
    } else {
      parts.push(t('meter.value.estimatedOnly'));
    }
  } else {
    parts.push(t('meter.value.known', { label, percent: percentSpoken(value) }));
    if (usage.capturedAt) {
      // Speak the capture instant, or a screen reader user hears a bare
      // percentage with none of the staleness the sighted layout carries.
      parts.push(t('meter.value.measuredAt', { time: clockTime(usage.capturedAt) }));
      if (typeof usage.billableSinceCapture === 'number' && usage.billableSinceCapture > 0) {
        parts.push(
          t('meter.value.sinceCapture', {
            count: usage.billableSinceCapture,
            value: compact(usage.billableSinceCapture),
          }),
        );
      }
    } else {
      parts.push(t('meter.value.exact'));
    }
  }

  const resetsAt = parseInstant(usage.resetsAt);
  if (resetsAt !== null) {
    parts.push(t('meter.value.resetsIn', { duration: countdownSpoken(resetsAt - now) }));
  }
  return parts.join(' ');
}

/*
 * The sentence a block with no drawable figure hands to a screen reader used
 * to live here as `unknownText()`, with one wording. It is now
 * `AbsenceCopy.spoken` above, one per cause, so the spoken sentence and the
 * printed word can never drift apart — they come from the same record. It
 * still carries no countdown: the foot below is left exposed for exactly that,
 * so the spoken duration is the one being repainted rather than a frozen copy.
 */

interface BlockHandle {
  el: HTMLElement;
  update(usage: WindowUsage | null, stale: boolean, now: number): void;
  tick(now: number): void;
}

/**
 * One window block.
 *
 * `drawable` is fixed at construction because it is STRUCTURE, not content: a
 * block that can draw a bar has one, a block that cannot never creates the
 * element. row.ts rebuilds the row when a window's certainty changes, so this
 * is never asked to grow a bar it was not built with.
 */
function createBlock(
  kind: WindowKind,
  drawable: boolean,
  stale: boolean,
  note?: string,
): BlockHandle {
  const copy = copyFor(kind);
  // An optional qualifier on the window's own label, printed and spoken right
  // where the figure is. Used by the Antigravity row to say "· seçili model"
  // on the five-hour block, so the headline percentage — which main ties to
  // the model the user picked in Antigravity — reads as THEIRS rather than as
  // a number that shifted for no visible reason. It is a role, never a model
  // NAME: the name lives only in the disclosure below, marked in its group, so
  // no name is ever set beside this percentage.
  const labelText = note ? `${copy.label} · ${note}` : copy.label;
  const spokenText = note ? `${copy.spoken}, ${note}` : copy.spoken;

  const label = el('span', { class: 'win__label' }, labelText);
  // The compact tag, "5sa" / "7g". In the head, so it is aria-hidden with the
  // label it abbreviates: the meter's sentence (or the group's) already names
  // the window in full, and a screen reader must not hear "5sa" as a word.
  const tag = el('span', { class: 'win__tag' }, copy.tag);
  const pct = el(
    'span',
    { class: drawable ? 'win__pct' : 'win__pct win__pct--none' },
    drawable ? null : NO_FIGURE(),
  );

  const head = el('div', { class: 'win__head' }, label, tag, el('span', { class: 'win__gap' }), pct);

  // The reset countdown, beneath the bar. It is painted for every block that
  // has a reset instant — including one we cannot put a percentage on, because
  // "when does this window roll over" is knowable even when "how much of it is
  // gone" is not, and suppressing it would throw away a true fact to punish an
  // unknown one.
  const reset = el('span', { class: 'win__reset' });
  // The instant a stale percentage was actually true. ADR-001 amendment 2: the
  // figure is never shown without it.
  const asOfLabel = stale && drawable ? el('span', { class: 'win__asof' }) : null;
  // Why there is no figure, for the one absence where the cause is worth a
  // line. Created for every non-drawable block rather than only when the
  // reason is known at construction: `absence` is CONTENT and can change from
  // 'no-capture' to 'not-supplied' without `certainty` moving off 'unknown',
  // so row.ts's shape key would not rebuild the block and a span created
  // conditionally would never appear.
  const reason = drawable ? null : el('span', { class: 'win__reason' });
  const foot = el('div', { class: 'win__foot' }, reset, asOfLabel, reason);

  const root = el('div', { class: `win win--${kind}`, 'data-win': kind }, head);

  let rail: HTMLElement | null = null;
  let fill: HTMLElement | null = null;
  let band: HTMLElement | null = null;

  if (drawable) {
    const tickMark = el('i', { class: 'rail__tick', 'aria-hidden': 'true' });
    fill = el('div', { class: 'rail__fill' }, tickMark);
    band = el('div', { class: 'rail__band', 'aria-hidden': 'true' });
    rail = el(
      'div',
      {
        class: `rail rail--${kind}`,
        role: 'meter',
        'aria-label': spokenText,
        'aria-valuemin': '0',
        'aria-valuemax': '100',
      },
      band,
      fill,
    );
    root.appendChild(rail);
    // The meter's aria-valuetext already states the label, the figure, the
    // certainty and the countdown as one sentence. Leaving the visible copies
    // exposed as well would make a screen reader say all of it twice.
    setAttr(head, 'aria-hidden', 'true');
    setAttr(foot, 'aria-hidden', 'true');
  } else {
    // No meter to carry the sentence, so the block carries it itself. The head
    // is hidden because the group label restates it; the foot is NOT, because
    // the countdown in it is repainted every second and an aria-label written
    // once would go stale inside a minute.
    setAttr(root, 'role', 'group');
    setAttr(head, 'aria-hidden', 'true');
  }

  root.appendChild(foot);

  function paintReset(now: number): void {
    const at = parseInstant(reset.getAttribute('data-resets-at'));
    if (at === null) {
      setText(reset, '');
      reset.hidden = true;
    } else {
      reset.hidden = false;
      setText(reset, countdownRemaining(at - now));
      setAttr(reset, 'title', t('meter.resetTitle', { time: clockTime(at) }));
    }
    // An empty foot would still eat its gap; hide it outright.
    //
    // Derived from the children rather than from an enumeration of them. The
    // predicate used to name `reset` and `asOfLabel` explicitly, so adding a
    // third child would have left the foot hidden whenever the first two were
    // — which is EXACTLY the state the reason line exists to explain: a block
    // with no figure and no reset instant. The one case it had to survive was
    // the one the old form would have swallowed.
    let anyVisible = false;
    for (const child of foot.children) {
      if (!(child as HTMLElement).hidden) {
        anyVisible = true;
        break;
      }
    }
    foot.hidden = !anyVisible;
  }

  return {
    el: root,
    update(usage: WindowUsage | null, isStale: boolean, now: number): void {
      if (drawable && isDrawable(usage) && rail && fill && band) {
        const value = usage.usedPercentage as number;
        const fraction = Math.max(0, Math.min(1, value / 100));

        setText(pct, percentLabel(usage));
        setAttr(pct, 'data-estimated', usage.certainty === 'estimated' ? 'true' : null);
        // Per window, from the ROUNDED value: the colour and the printed
        // figure can never disagree, and the weekly block is never coloured by
        // the five-hour window's pressure.
        setAttr(root, 'data-state', stateFor(value));
        // How far into that step, so the fill can mix toward the NEXT anchor
        // instead of holding one colour across a whole band. Same rounded
        // value as the step and as the printed figure — one number, three
        // renderings of it, and they cannot disagree.
        root.style.setProperty('--mix', mixWithin(value).toFixed(4));

        fill.style.setProperty('--f', fraction.toFixed(4));
        fill.classList.toggle('rail__fill--estimated', usage.certainty === 'estimated');

        const hasBand =
          usage.certainty === 'estimated' &&
          typeof usage.confidenceHi === 'number' &&
          Number.isFinite(usage.confidenceHi);
        band.style.setProperty(
          '--band-hi',
          hasBand ? Math.max(0, Math.min(1, (usage.confidenceHi as number) / 100)).toFixed(4) : '0',
        );
        band.hidden = !hasBand;

        setAttr(rail, 'aria-valuenow', String(Math.round(value)));
        setAttr(rail, 'aria-valuetext', valueText(usage, spokenText, now));

        if (asOfLabel) {
          const capturedAt = isStale ? usage.capturedAt : null;
          if (capturedAt) {
            setText(asOfLabel, asOf(capturedAt));
            setAttr(asOfLabel, 'title', t('meter.asOfTitle', { time: clockTime(capturedAt) }));
            asOfLabel.hidden = false;
          } else {
            setText(asOfLabel, '');
            asOfLabel.hidden = true;
          }
        }
      } else {
        // No defensible percentage: no figure, no bar, no state colour. The
        // block still names the window, so the absence is a stated one rather
        // than a missing line — and it now names the CAUSE too, when the cause
        // is one the user can do anything with.
        const absence = absenceCopy(usage);
        setText(pct, absence.figure);
        setAttr(root, 'data-state', null);
        // No step, so nothing to mix between: the block falls back to the
        // neutral ink rather than to the bottom of a ramp it is not on.
        root.style.removeProperty('--mix');
        setAttr(root, 'aria-label', absence.spoken(spokenText));
        if (reason) {
          setText(reason, absence.reason ?? '');
          reason.hidden = absence.reason === null;
        }
      }

      setAttr(reset, 'data-resets-at', usage?.resetsAt ?? null);
      paintReset(now);
    },
    tick: paintReset,
  };
}

/**
 * The blocks for a provider.
 *
 * A window that is absent from the snapshot altogether gets no block: there is
 * nothing to name. A window that is PRESENT but unmeasurable gets one, because
 * "Haftalık pencere — bilinmiyor" and no line at all are different claims, and
 * the user reads the second one as a missing feature.
 */
export function createMeter(
  fiveHour: WindowUsage | null,
  sevenDay: WindowUsage | null,
  stale: boolean,
  /** Qualifier on the five-hour label, e.g. "seçili model" (see createBlock). */
  fiveHourNote?: string,
): MeterHandle {
  const root = el('div', { class: 'meter' });

  const block5 = fiveHour ? createBlock('5h', isDrawable(fiveHour), stale, fiveHourNote) : null;
  const block7 = sevenDay ? createBlock('7d', isDrawable(sevenDay), stale) : null;

  if (block5) root.appendChild(block5.el);
  if (block7) root.appendChild(block7.el);

  return {
    el: root,
    update(next5, next7, isStale, now): void {
      if (block5) block5.update(next5, isStale, now);
      if (block7) block7.update(next7, isStale, now);
    },
    tick(now: number): void {
      if (block5) block5.tick(now);
      if (block7) block7.tick(now);
    },
  };
}

/**
 * The row-level state step, still driven by the window the user acts on: the
 * five-hour one. It no longer colours anything (each block owns its own
 * colour); it is the row's headline state, and the tray icon is drawn from the
 * same window by main.
 */
export function meterStateStep(
  fiveHour: WindowUsage | null,
  sevenDay: WindowUsage | null,
): string | null {
  const primary = isDrawable(fiveHour) ? fiveHour : isDrawable(sevenDay) ? sevenDay : null;
  if (!primary) return null;
  return stateFor(primary.usedPercentage as number);
}
