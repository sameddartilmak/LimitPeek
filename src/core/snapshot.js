'use strict';
const { PROVIDERS } = require('./providers');
const { applyOrder } = require('./order');
const { resolveEnabled } = require('./enabled');
const pricing = require('./pricing');
const agg = require('./aggregate');

/**
 * Builds the Snapshot described by `src/shared/contract.ts`.
 *
 * Invariant enforced here and nowhere else: `usedPercentage` is non-null only
 * when it came verbatim from the statusline payload. There is no branch in
 * this file that computes a percentage from tokens, and `billableSinceCapture`
 * is never divided by anything.
 */

function unknownWindow(absence) {
  return {
    usedPercentage: null,
    certainty: 'unknown',
    resetsAt: null,
    capturedAt: null,
    billableSinceCapture: null,
    // Machine-readable cause, so the renderer can say "bildirilmiyor" for a
    // window the source does not publish and "bilinmiyor" for one we merely
    // cannot state. Defaults to the honest general case.
    absence: typeof absence === 'string' ? absence : 'no-capture',
  };
}

/**
 * ADR-001 amendment 2 — the three window states.
 *
 * The rule is "is this number still a true statement about the window it
 * describes?", not "is the file recent?". A percentage is a fact about one
 * specific rolling window; it stops being true the moment that window resets,
 * and not a second earlier.
 *
 *   1. capture younger than the freshness budget      -> known, exact
 *   2. capture older, but now < resetsAt              -> known, "as of"
 *   3. now >= resetsAt (or no resetsAt at all)        -> unknown, no meter
 *
 * State 2 errs optimistic, because consumption inside a window only ever
 * rises — the same bias ADR-001 rejected for token arithmetic. It is answered
 * with `billableSinceCapture`: billable tokens actually observed in local
 * transcripts since the capture. That is a measured FLOOR on the additional
 * usage, not a recomputed rate, so the user gets a true number plus a true
 * delta and takes the last step themselves.
 *
 * @param {object|null} win        { usedPercentage, resetsAtMs } from the capture
 * @param {boolean} captureFresh   capture is inside the freshness budget
 * @param {number|null} capturedAtMs
 * @param {number} now
 * @param {number|null} sinceCaptureBillable  billable observed since capturedAt
 */
function windowFrom(win, captureFresh, capturedAtMs, now, sinceCaptureBillable, stamp) {
  // `stamp` names the published field and how much its interface can be
  // trusted. Optional so the existing Claude call sites read unchanged; when
  // absent the window carries nulls, which is what a provider with no declared
  // source should say.
  const source = (stamp && stamp.source) || null;
  const provenance = (stamp && stamp.provenance) || null;
  const absenceWhenMissing = (stamp && stamp.absence) || 'no-capture';

  if (!win || win.usedPercentage === null) return unknownWindow(absenceWhenMissing);

  const resetsAtMs = win.resetsAtMs;
  const resetsAt = Number.isFinite(resetsAtMs) ? new Date(resetsAtMs).toISOString() : null;
  const capturedAt = Number.isFinite(capturedAtMs) ? new Date(capturedAtMs).toISOString() : null;

  // State 3 is UNCONDITIONAL and dominates state 1 (ADR-001 amendment 2,
  // clarified after review). Capture age and window rollover are independent
  // facts, and rollover is the stronger one: a two-minute-old capture whose 5h
  // window rolled over a minute ago describes a window that no longer exists.
  // Showing it would put a near-100% figure on the tray at exactly the moment
  // the user is checking whether their limit reset — optimistic, which is the
  // one direction ADR-001 exists to prevent.
  //
  // The check is deliberately conditioned on `Number.isFinite` here rather
  // than hoisted whole: a FRESH capture that simply carries no resetsAt is
  // still a true reading, and only the stale path needs a reset instant to
  // reason about.
  if (Number.isFinite(resetsAtMs) && now >= resetsAtMs) return unknownWindow('rolled-over');

  if (captureFresh) {
    return {
      usedPercentage: win.usedPercentage,
      certainty: 'known',
      source,
      provenance,
      absence: null,
      resetsAt,
      capturedAt,
      billableSinceCapture: null,
    };
  }

  // Stale, and with no reset instant there is no way to tell whether the
  // window it describes is still open. Unusable.
  if (!Number.isFinite(resetsAtMs)) return unknownWindow('stale');

  return {
    usedPercentage: win.usedPercentage,
    certainty: 'known',
    source,
    provenance,
    absence: null,
    resetsAt,
    capturedAt,
    billableSinceCapture: Number.isFinite(sinceCaptureBillable) ? sinceCaptureBillable : null,
  };
}

/**
 * True when the capture carried a percentage for a window whose reset instant
 * has already passed. Such a row cannot be 'ok' however fresh the file is: the
 * chrome has to match the content, or a row with no meter still reads as a
 * current, healthy reading.
 */
function anyWindowRolledOver(rl, now) {
  for (const win of [rl.fiveHour, rl.sevenDay]) {
    if (!win || win.usedPercentage === null) continue;
    if (Number.isFinite(win.resetsAtMs) && now >= win.resetsAtMs) return true;
  }
  return false;
}

/**
 * The Antigravity row's chrome, over BOTH of its sources.
 *
 * Two things this provider has that Claude does not: two independent sources
 * (the documented `agy` statusline hook, and the IDE's own state store), and
 * no local transcript corpus at all, so there is no scan rung.
 *
 * The `error` rung is deliberately narrow, and it used to be far too wide.
 * A capture that arrived and could not be interpreted — an unrecognised bucket
 * id, a refused protobuf shape — used to return `status:'error'` with
 * `ANTIGRAVITY_QUOTA_UNAVAILABLE`, which the panel renders as "Güncellenemedi"
 * beside a "Yeniden dene" button. Both are false: nothing failed, and retrying
 * cannot change the answer. A provider that is working perfectly was being
 * presented as broken. Those states are now a STATED ABSENCE — the row is
 * `ok`, and its windows carry `absence: 'unreadable'`, which the renderer
 * turns into words.
 *
 * `error` is now reserved for a genuine fault where a retry is meaningful: a
 * capture file or store we could not open or parse at all.
 */
function antigravityRowState(sources, windows, anyFigure, allFresh, rolledOver) {
  const present = sources.filter((s) => s.state !== 'missing');
  if (present.length === 0) {
    // Neither source connected. The "Bağla" case, not an error.
    return { connected: false, status: 'passive', setup: true, errorCode: undefined };
  }
  if (present.some((s) => s.state === 'invalid')) {
    return { connected: true, status: 'error', setup: false, errorCode: 'ANTIGRAVITY_CAPTURE_INVALID' };
  }
  if (!anyFigure) {
    // Connected, but with nothing to state. WHY decides the chrome, because
    // the two causes are different situations:
    //
    //   we HAD a figure and it aged out or its window reset -> 'stale', so
    //   the row is dimmed and does not read as a current, healthy reading;
    //
    //   the source never published one, or published something we refused to
    //   interpret -> 'ok'. Nothing failed and nothing is out of date; the
    //   window's `absence` carries the sentence and there is no retry button,
    //   because retrying cannot change the answer.
    const aged = windows.some((w) => w.absence === 'rolled-over' || w.absence === 'stale');
    return { connected: true, status: aged ? 'stale' : 'ok', setup: false, errorCode: undefined };
  }
  const live = allFresh && !rolledOver;
  return { connected: true, status: live ? 'ok' : 'stale', setup: false, errorCode: undefined };
}

/**
 * Why a window carries no figure, in the contract's vocabulary.
 *
 * @param {object} reading  the source's result
 * @param {object|null} raw the raw window the source offered for this slot
 * @param {boolean} supplies  whether this source publishes this window AT ALL
 */
function absenceOf(reading, raw, supplies, now) {
  if (!reading || reading.state === 'missing') return 'no-capture';
  if (reading.state === 'invalid') return 'unreadable';
  if (!supplies) return 'not-supplied';
  if (reading.state === 'absent') {
    // 'no-quota' means the source ran and had nothing to say about quota at
    // all; anything else means it said something we could not read.
    return (reading.reason === 'no-quota' || reading.reason == null) ? 'not-supplied' : 'unreadable';
  }
  if (!raw || raw.usedPercentage === null) return 'not-supplied';
  if (Number.isFinite(raw.resetsAtMs) && now >= raw.resetsAtMs) return 'rolled-over';
  if (reading.state === 'stale') return 'stale';
  return 'no-capture';
}

function claudeRowState(rl, scanOk, captureFresh, rolledOver) {
  switch (rl.state) {
    case 'missing':
      // Bridge never installed. This is the "Ekle/Bağla" case, not an error.
      return { connected: false, status: 'passive', setup: true, errorCode: undefined };
    case 'invalid':
      return { connected: false, status: 'error', setup: true, errorCode: 'RATE_LIMIT_FILE_INVALID' };
    case 'absent':
      // Bridge ran, but Claude Code handed it no `rate_limits` block.
      return { connected: true, status: 'error', setup: false, errorCode: 'RATE_LIMITS_UNAVAILABLE' };
    case 'stale':
    case 'fresh': {
      if (!scanOk) return { connected: true, status: 'error', setup: false, errorCode: 'TRANSCRIPT_SCAN_FAILED' };
      // A capture past the freshness budget is dimmed even when its windows
      // are still valid: the renderer shows "as of", not a live figure. A
      // capture describing a window that has already reset is dimmed too, even
      // when the file itself is seconds old.
      const live = captureFresh && !rolledOver;
      return { connected: true, status: live ? 'ok' : 'stale', setup: false, errorCode: undefined };
    }
    default:
      return { connected: false, status: 'passive', setup: true, errorCode: undefined };
  }
}

/**
 * The instant this row's values were last simultaneously known-good.
 *
 * Deliberately the MINIMUM of its components, not the maximum: a row is only
 * as fresh as its stalest part. Reporting the newest component would let a row
 * whose percentage is two hours old claim it updated "şimdi" just because the
 * transcript scan succeeded a second ago — the over-confident reading the ADR
 * exists to prevent (frontend F1).
 */
function lastGoodAtFor(scanGoodAtMs, capturedAtMs, rateLimitState) {
  const parts = [];
  if (Number.isFinite(scanGoodAtMs)) parts.push(scanGoodAtMs);
  // Only counts when the capture is a component of this row's value at all.
  if (Number.isFinite(capturedAtMs) && (rateLimitState === 'fresh' || rateLimitState === 'stale')) {
    parts.push(capturedAtMs);
  }
  if (parts.length === 0) return null;
  return new Date(Math.min(...parts)).toISOString();
}

/**
 * @param {object} input
 * @param {number} input.now
 * @param {Array}  input.events      raw (not yet deduped) usage events
 * @param {object} input.rateLimits  result of readClaudeRateLimits()
 * @param {boolean} input.scanOk
 * @param {number} [input.scanGoodAtMs] when the transcript data was last good
 * @param {string|null} input.planLabel  from app settings only. Never inferred,
 *        and never read from the credentials file.
 * @param {string[]} [input.order]  persisted provider order. Applied here so
 *        that EVERY emitted snapshot is ordered — the tray icon is driven by
 *        the first ENABLED row, and a snapshot that skipped the ordering step
 *        would put a different provider on the tray than in the panel.
 * @param {object} [input.enabled]  persisted enablement map. Applied here for
 *        the same reason: the snapshot still carries ALL providers, because
 *        the settings view needs the full list, so `enabled` is the only thing
 *        telling the panel and the tray which rows the user actually added.
 * @returns {{generatedAt:string, providers:Array}}
 */
function buildSnapshot(input) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const rl = input.rateLimits || { state: 'missing', fiveHour: null, sevenDay: null };
  const scanOk = input.scanOk !== false;

  const deduped = agg.dedupe(input.events || []);

  const capturedAtMs = Number.isFinite(rl.capturedAtMs) ? rl.capturedAtMs : null;
  const captureFresh = rl.state === 'fresh';

  // Measured floor on consumption since the capture. Only meaningful when the
  // capture is old, and only ever reported as an absolute token count.
  let sinceCapture = null;
  if (!captureFresh && capturedAtMs !== null && capturedAtMs <= now) {
    sinceCapture = agg.sumWindow(deduped, capturedAtMs, now).tokens.billable;
  }

  const fiveHour = windowFrom(rl.fiveHour, captureFresh, capturedAtMs, now, sinceCapture);
  const sevenDay = windowFrom(rl.sevenDay, captureFresh, capturedAtMs, now, sinceCapture);

  // Token window: anchored to the real reset instant whenever that instant is
  // still ahead of us — that is true of a stale capture too, and it is what
  // makes the "as of" state usable. Trailing 5h otherwise.
  const fiveResetsAtMs = rl.fiveHour ? rl.fiveHour.resetsAtMs : null;
  const anchorMs = Number.isFinite(fiveResetsAtMs) && now < fiveResetsAtMs ? fiveResetsAtMs : null;
  const win = agg.fiveHourWindow(now, anchorMs);
  const { tokens, byModel } = agg.sumWindow(deduped, win.start, win.end);
  const burn = agg.burnRatePerHour(tokens.billable, win.elapsedMs);

  // Notional weekly spend (ADR-002). Anchored to the 7-day reset instant when
  // that instant is still ahead of us, on the same reasoning as the token
  // window above: anchoring to a reset that has already passed would define a
  // window that closed, and silently exclude everything spent since.
  const sevenResetsAtMs = rl.sevenDay ? rl.sevenDay.resetsAtMs : null;
  const weekAnchorMs = Number.isFinite(sevenResetsAtMs) && now < sevenResetsAtMs ? sevenResetsAtMs : null;
  const weekWin = agg.sevenDayWindow(now, weekAnchorMs);
  // Same deduped set as every other figure: the 115.3% replay inflation would
  // otherwise land directly on the money.
  const weeklyCost = pricing.weeklyCost(deduped, weekWin.start, weekWin.end, weekWin.anchored);

  const row = claudeRowState(rl, scanOk, captureFresh, anyWindowRolledOver(rl, now));
  const lastGoodAt = lastGoodAtFor(
    Number.isFinite(input.scanGoodAtMs) ? input.scanGoodAtMs : (scanOk ? now : undefined),
    capturedAtMs,
    rl.state,
  );

  // Resolved once: an unknown id is dropped, an unstated one takes its shipped
  // default, and a corrupt value degrades to defaults rather than to an empty
  // panel (src/core/enabled.js).
  const enabled = resolveEnabled(input.enabled);

  /* ------------------------------------------------------------ Antigravity
   *
   * TWO independent sources, feeding one window each:
   *
   *   IDE state store   -> fiveHour.  Undocumented protobuf, so `derived`.
   *   `agy` CLI hook    -> sevenDay.  Documented JSON field, so `documented`.
   *
   * They are composed here, per window, rather than merged into one reading.
   * That keeps `provenance` truthful at the level it varies: this row can
   * legitimately show one derived figure beside one documented figure, and
   * flattening them to a single trust level would be a claim about both that
   * is true of neither.
   *
   * OPEN QUESTION, deliberately not guessed at: whether the CLI's weekly
   * bucket and the IDE's five-hour figure meter the SAME underlying pool.
   * They have different horizons, which is why they occupy different slots and
   * are never shown as two views of one number — but "different horizon" is
   * not proof of "different pool". Establishing it needs the `agy` CLI
   * installed beside the IDE, which no machine here has. Until then the two
   * are presented exactly as what they are: two windows, separately sourced,
   * each labelled with the field it came from.
   *
   * No local corpus at all for this provider, so `tokens`, `burnRatePerHour`
   * and `weeklyCost` stay null. ADR-001 Decision 1 rules out filling them from
   * the percentage, and ADR-002's cost figure needs per-token records this app
   * does not have here.
   */
  const agq = input.antigravityQuota || { state: 'missing', fiveHour: null, sevenDay: null };
  const agIde = input.antigravityIde || { state: 'missing', fiveHour: null, sevenDay: null, groups: [] };

  const agCliFresh = agq.state === 'fresh';
  const agIdeFresh = agIde.state === 'fresh';
  const agCliCapturedAtMs = Number.isFinite(agq.capturedAtMs) ? agq.capturedAtMs : null;
  const agIdeCapturedAtMs = Number.isFinite(agIde.capturedAtMs) ? agIde.capturedAtMs : null;

  // `sinceCapture` is deliberately null on both: Claude's measured floor comes
  // from Claude transcripts and would describe the wrong provider entirely.
  //
  // The row headline is the MOST-CONSUMED model group (`agIde.fiveHour` is the
  // reader's `lead`), i.e. the honest worst case. It once followed the user's
  // "selected model", but that selection is not on disk — the picker's choice
  // is not persisted — so it was removed (see the note in ide-quota.js). The
  // tray also shows the most-consumed group, so the two agree again.
  const agFive = windowFrom(agIde.fiveHour, agIdeFresh, agIdeCapturedAtMs, now, null, {
    source: 'antigravity.ide.quota_info.remaining_fraction',
    provenance: 'derived',
    absence: absenceOf(agIde, agIde.fiveHour, true, now),
  });
  const agSeven = windowFrom(agq.sevenDay, agCliFresh, agCliCapturedAtMs, now, null, {
    source: 'antigravity.cli.quota.remaining_fraction',
    provenance: 'documented',
    // The IDE store carries no weekly figure at all, so when the CLI hook is
    // not installed this window is `not-supplied` rather than `no-capture`.
    // It is never null: a null window would assert this provider HAS no weekly
    // limit, and the user can see one in Antigravity's own UI. "There is one
    // and we cannot state it" is the true claim.
    absence: agq.state === 'missing' && agIde.state !== 'missing'
      ? 'not-supplied'
      : absenceOf(agq, agq.sevenDay, true, now),
  });

  const agAnyFigure = agFive.usedPercentage !== null || agSeven.usedPercentage !== null;
  // Only the sources that actually contributed a figure gate "live".
  const agFreshParts = [];
  if (agFive.usedPercentage !== null) agFreshParts.push(agIdeFresh);
  if (agSeven.usedPercentage !== null) agFreshParts.push(agCliFresh);
  const agAllFresh = agFreshParts.length > 0 && agFreshParts.every(Boolean);
  const agRolled = anyWindowRolledOver(agq, now) || anyWindowRolledOver(agIde, now);
  const agRow = antigravityRowState([agq, agIde], [agFive, agSeven], agAnyFigure, agAllFresh, agRolled);

  // Same MINIMUM rule as Claude's: a row is only as fresh as its stalest
  // contributing part, so a five-hour figure from an hour ago cannot claim it
  // updated "şimdi" because the weekly one landed a second ago.
  const agGoodParts = [];
  if (agFive.usedPercentage !== null && agIdeCapturedAtMs !== null) agGoodParts.push(agIdeCapturedAtMs);
  if (agSeven.usedPercentage !== null && agCliCapturedAtMs !== null) agGoodParts.push(agCliCapturedAtMs);
  const agLastGoodAt = agGoodParts.length ? new Date(Math.min(...agGoodParts)).toISOString() : null;

  // Per-model detail. Offered ONLY alongside a five-hour figure the row is
  // actually showing: the groups are the same numbers seen a second way, so
  // presenting them next to a window we just refused would be presenting a
  // reading through the back door.
  const agModelQuotas = (agFive.usedPercentage !== null && Array.isArray(agIde.groups) && agIde.groups.length > 0)
    ? {
      groups: agIde.groups.map((g) => ({
        usedPercentage: g.usedPercentage,
        resetsAt: Number.isFinite(g.resetsAtMs) ? new Date(g.resetsAtMs).toISOString() : null,
        // Names only. No shape here pairs a model with a percentage.
        members: g.members.slice(),
      })),
      diverged: agIde.diverged === true,
      // Straight through from the reader, which already refused every
      // doubtful match. Nothing here re-derives it: a selection this row
      // invented would point at a figure that is not the user's.
      selectedModel: typeof agIde.selectedModel === 'string' ? agIde.selectedModel : null,
      selectedGroupIndex: Number.isInteger(agIde.selectedGroupIndex) ? agIde.selectedGroupIndex : null,
      source: 'antigravity.ide.quota_info.remaining_fraction',
      provenance: 'derived',
      capturedAt: new Date(agIdeCapturedAtMs).toISOString(),
    }
    : null;

  const providers = PROVIDERS.map((p) => {
    if (p.id === 'antigravity') {
      const snap = {
        id: p.id,
        displayName: p.displayName,
        accent: p.accent,
        enabled: enabled[p.id] === true,
        connected: agRow.connected,
        status: agRow.status,
        // Antigravity states a plan tier in its payload. The bridge does not
        // capture it and this stays null: a subscription tier is an account
        // fact, not a usage number, and ADR-001 keeps `planLabel` sourced from
        // app settings for exactly one provider's worth of reasons already.
        planLabel: null,
        fiveHour: agFive,
        sevenDay: agSeven,
        tokens: null,
        burnRatePerHour: null,
        weeklyCost: null,
        modelQuotas: agModelQuotas,
        setupAction: agRow.setup ? { ...p.setupAction } : null,
        lastGoodAt: agLastGoodAt,
      };
      if (agRow.errorCode) snap.errorCode = agRow.errorCode;
      return snap;
    }
    if (p.id !== 'claude') {
      return {
        id: p.id,
        displayName: p.displayName,
        accent: p.accent,
        // The user's choice to SEE this row, not our ability to fill it.
        enabled: enabled[p.id] === true,
        connected: false,
        status: 'passive',
        planLabel: null,
        fiveHour: null,
        sevenDay: null,
        tokens: null,
        burnRatePerHour: null,
        // No transcripts, so no usage to price. Never 0, which would read as
        // "this provider cost nothing" rather than "we have no data".
        weeklyCost: null,
        setupAction: { ...p.setupAction },
        // Never had a good value, so there is no age to report. The renderer
        // must not fall back to generatedAt and imply one.
        lastGoodAt: null,
      };
    }
    const snap = {
      id: p.id,
      displayName: p.displayName,
      accent: p.accent,
      enabled: enabled[p.id] === true,
      connected: row.connected,
      status: row.status,
      planLabel: typeof input.planLabel === 'string' && input.planLabel ? input.planLabel : null,
      fiveHour,
      sevenDay,
      tokens,
      burnRatePerHour: burn,
      byModel: byModel.slice(0, 6),
      weeklyCost,
      setupAction: row.setup ? { ...p.setupAction } : null,
      lastGoodAt,
    };
    if (row.errorCode) snap.errorCode = row.errorCode;
    return snap;
  });

  return {
    generatedAt: new Date(now).toISOString(),
    providers: applyOrder(providers, input.order),
  };
}

/** Shown before the first scan completes, and if the store is empty. */
function loadingSnapshot(now = Date.now(), order, enabledRaw) {
  // Same resolution as buildSnapshot: the skeleton must show exactly the rows
  // the first real snapshot will, or the panel visibly drops rows on load.
  const enabled = resolveEnabled(enabledRaw);
  return {
    generatedAt: new Date(now).toISOString(),
    // Ordered too: the skeleton is what a cold start paints, and rows must not
    // visibly jump into place when the first real snapshot lands.
    providers: applyOrder(PROVIDERS.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      accent: p.accent,
      enabled: enabled[p.id] === true,
      connected: false,
      // Keyed off `live`, not off the id: a provider we can collect must paint
      // the same skeleton the first real snapshot will replace, or its row
      // visibly changes shape a moment after the panel opens.
      status: p.live ? 'loading' : 'passive',
      planLabel: null,
      fiveHour: p.live ? unknownWindow() : null,
      sevenDay: p.live ? unknownWindow() : null,
      tokens: null,
      burnRatePerHour: null,
      weeklyCost: null,
      setupAction: p.live ? null : { ...p.setupAction },
      lastGoodAt: null,
    })), order),
  };
}

module.exports = {
  buildSnapshot,
  loadingSnapshot,
  unknownWindow,
  windowFrom,
  lastGoodAtFor,
  anyWindowRolledOver,
  absenceOf,
};
