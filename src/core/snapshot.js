'use strict';
const { PROVIDERS } = require('./providers');
const { applyOrder } = require('./order');
const { resolveEnabled } = require('./enabled');
const pricing = require('./pricing');
const agg = require('./aggregate');
const history = require('./history');
const codexUsage = require('./codex/usage');
const codexPricing = require('./codex/pricing');

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
function antigravityRowState(sources, windows, anyFigure, allFresh, rolledOver, cliMissing) {
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
  // Connected on the IDE store's five-hour figure, but the agy CLI is not
  // installed. That CLI is the ONLY source of the weekly window and of a live,
  // forward five-hour reset — the IDE fetches both from its server and never
  // writes them to disk, so from the store alone there is no countdown and no
  // weekly to show. So keep the row connected (the five-hour figure is real)
  // and STILL offer the bridge, giving the user a path to the reading
  // Antigravity computes but does not persist. Once agy is installed the CLI
  // supplies both windows and `cliMissing` is false, so this returns to
  // setup:false on its own — the button disappears without any state to clear.
  return { connected: true, status: live ? 'ok' : 'stale', setup: cliMissing === true, errorCode: undefined };
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
 * The Codex row's connection/status from its rollout reading.
 *
 * Unlike Claude there is no bridge to install — Codex writes its rollout files
 * itself — so `setup` is only ever the informational "not installed" chip when
 * Codex is absent from the machine, never a "connect me" action.
 */
function codexRowState(cx, anyFigure, fresh, rolledOver) {
  switch (cx.state) {
    case 'missing':
      // No ~/.codex/sessions at all: Codex is not on this machine. Passive.
      return { connected: false, status: 'passive', setup: true, errorCode: undefined };
    case 'invalid':
      return { connected: true, status: 'error', setup: false, errorCode: 'CODEX_ROLLOUT_INVALID' };
    case 'absent':
      // A rollout exists but names no rate_limits — an API-key session (which
      // gets no server percentage) or a session with no priced turn yet.
      // Connected, with nothing to state; the window absence carries the reason.
      return { connected: true, status: 'ok', setup: false, errorCode: undefined };
    case 'stale':
    case 'fresh': {
      // No drawable figure: the only window rolled over, or the reading is
      // stale with nothing forward. Dim the row so the chrome matches the
      // content, exactly as claude/antigravity do — a bright, healthy row at
      // the very moment a limit resets is the optimistic reading ADR-001 exists
      // to prevent.
      if (!anyFigure) {
        return { connected: true, status: (rolledOver || !fresh) ? 'stale' : 'ok', setup: false, errorCode: undefined };
      }
      const live = fresh && !rolledOver;
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

  // When the bridge capture is FRESH but a window carries no figure, Claude
  // Code has renewed that window and not yet reported the new number — it only
  // writes one the next time it runs. That is a connected, current, waiting
  // state, and it earns its own word: 'awaiting-report' -> "yeni veri
  // bekleniyor", rather than the bare "bilinmiyor" that reads as "we did not
  // look". It is deliberately gated on `fresh`, not on connection alone:
  //   - a NEVER-CONNECTED row (rl.state 'missing') keeps 'no-capture' so the
  //     first-run user still sees the setup path, not a "waiting" figure;
  //   - a STALE capture keeps 'no-capture' too — a capture that never carried a
  //     figure and is now old is not "about to report", it is simply old.
  // A figure whose window has already ROLLED OVER is untouched by this: that is
  // decided in windowFrom, which reaches its 'rolled-over' branch only with a
  // NON-null percentage and so never consults this stamp.
  const claudeStamp = { absence: rl.state === 'fresh' ? 'awaiting-report' : 'no-capture' };
  const fiveHour = windowFrom(rl.fiveHour, captureFresh, capturedAtMs, now, sinceCapture, claudeStamp);
  const sevenDay = windowFrom(rl.sevenDay, captureFresh, capturedAtMs, now, sinceCapture, claudeStamp);

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
  //
  // The store's OWN five-hour window, computed unconditionally. It is the
  // fallback headline when the CLI supplies nothing, and — separately — it is
  // the gate the store-derived per-model disclosure rides on: that breakdown
  // may only appear while the store's own reading is currently showable, never
  // on the strength of a CLI figure that describes the same window a fresher
  // way (see `agModelQuotas`).
  const agStoreFive = windowFrom(agIde.fiveHour, agIdeFresh, agIdeCapturedAtMs, now, null, {
    source: 'antigravity.ide.quota_info.remaining_fraction',
    provenance: 'derived',
    absence: absenceOf(agIde, agIde.fiveHour, true, now),
  });
  // Five-hour SOURCE: prefer the agy CLI over the IDE store, because only the
  // CLI carries a LIVE, forward reset — the IDE persists a stale one (it fetches
  // the live reset from its server and never writes it back), which `windowFrom`
  // then nulls as not-forward, leaving the window with no countdown. But do NOT
  // prefer a STALE CLI figure over a fresh store one: an old percentage with a
  // countdown is a worse headline than a current percentage without one. So the
  // CLI wins only when it is fresh, or when the store has nothing fresher to
  // offer. With no CLI at all we fall back to the store's figure, percentage
  // only. Both sources meter the same five-hour pool the same way.
  const agCliFiveSupplied = agq.fiveHour != null && agq.fiveHour.usedPercentage !== null;
  const agStoreFiveShowable = agStoreFive.usedPercentage !== null;
  const agUseCliFive = agCliFiveSupplied && (agCliFresh || !agStoreFiveShowable || !agIdeFresh);
  const agFiveFresh = agUseCliFive ? agCliFresh : agIdeFresh;
  const agFiveCapturedAtMs = agUseCliFive ? agCliCapturedAtMs : agIdeCapturedAtMs;
  const agFive = agUseCliFive
    ? windowFrom(agq.fiveHour, agCliFresh, agCliCapturedAtMs, now, null, {
      source: 'antigravity.cli.quota.remaining_fraction',
      provenance: 'documented',
      absence: absenceOf(agq, agq.fiveHour, true, now),
    })
    : agStoreFive;
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
  // Only the sources that actually contributed a figure gate "live", and each
  // is judged by the freshness of the source that actually produced it —
  // `agFiveFresh` is the CLI's when the CLI drove the five-hour window, the
  // store's otherwise.
  const agFreshParts = [];
  if (agFive.usedPercentage !== null) agFreshParts.push(agFiveFresh);
  if (agSeven.usedPercentage !== null) agFreshParts.push(agCliFresh);
  const agAllFresh = agFreshParts.length > 0 && agFreshParts.every(Boolean);
  const agRolled = anyWindowRolledOver(agq, now) || anyWindowRolledOver(agIde, now);
  // The agy CLI is the only source of the weekly and of a live five-hour
  // reset; when it is not installed the row stays connected on the store but
  // still offers the bridge.
  const agCliMissing = agq.state === 'missing';
  const agRow = antigravityRowState([agq, agIde], [agFive, agSeven], agAnyFigure, agAllFresh, agRolled, agCliMissing);

  // Same MINIMUM rule as Claude's: a row is only as fresh as its stalest
  // contributing part, so a five-hour figure from an hour ago cannot claim it
  // updated "şimdi" because the weekly one landed a second ago.
  const agGoodParts = [];
  if (agFive.usedPercentage !== null && agFiveCapturedAtMs !== null) agGoodParts.push(agFiveCapturedAtMs);
  if (agSeven.usedPercentage !== null && agCliCapturedAtMs !== null) agGoodParts.push(agCliCapturedAtMs);
  const agLastGoodAt = agGoodParts.length ? new Date(Math.min(...agGoodParts)).toISOString() : null;

  // Per-model detail. This is a STORE-derived breakdown, so it is gated on the
  // STORE's own five-hour window being showable — NOT on `agFive`, which may
  // now be the CLI's fresher figure. Without this the stale store groups could
  // ride onto a row the CLI has made 'ok': the disclosure would then show a
  // stale, unmarked breakdown (the row is not degraded, so quotas.ts prints no
  // staleness note) whose group figures contradict the fresh headline. The
  // extra `agIdeFresh || !agUseCliFive` term is what closes that gap: the
  // breakdown appears either when the store is currently fresh, or when the
  // store is what drives the headline (so the row's own degraded state carries
  // the staleness note, exactly as before this change).
  const agModelQuotas = (agStoreFiveShowable && (agIdeFresh || !agUseCliFive)
    && Array.isArray(agIde.groups) && agIde.groups.length > 0
    && Number.isFinite(agIdeCapturedAtMs))
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

  // --- Codex ------------------------------------------------------------
  // Server-computed figures Codex writes into its own session rollout: primary
  // (5h) and secondary (weekly), each a used_percent from OpenAI's headers.
  // Read passively from the rollout — never the OAuth tokens sitting beside it,
  // never the network. See core/codex/rollout.js.
  const cx = input.codexRateLimits || { state: 'missing', fiveHour: null, sevenDay: null };
  const cxFresh = cx.state === 'fresh';
  const cxCapturedAtMs = Number.isFinite(cx.capturedAtMs) ? cx.capturedAtMs : null;
  // A rollout that ran but carried no rate_limits yet is a figure not yet
  // reported, not a figure this tool refuses to publish — the subscription user
  // this feature targets gets one on their next priced turn. So `absent` reads
  // as 'awaiting-report' ("yeni veri bekleniyor"), as Claude's does, rather than
  // 'not-supplied'. Every other absence is decided the shared way.
  const cxAbsence = (raw) => (cx.state === 'absent' ? 'awaiting-report' : absenceOf(cx, raw, true, now));
  const cxFive = windowFrom(cx.fiveHour, cxFresh, cxCapturedAtMs, now, null, {
    source: 'codex.rate_limits.primary.used_percent',
    provenance: 'documented',
    absence: cxAbsence(cx.fiveHour),
  });
  const cxSeven = windowFrom(cx.sevenDay, cxFresh, cxCapturedAtMs, now, null, {
    source: 'codex.rate_limits.secondary.used_percent',
    provenance: 'documented',
    absence: cxAbsence(cx.sevenDay),
  });
  const cxAnyFigure = cxFive.usedPercentage !== null || cxSeven.usedPercentage !== null;
  const cxRow = codexRowState(cx, cxAnyFigure, cxFresh, anyWindowRolledOver(cx, now));
  const cxLastGoodAt = (cxAnyFigure && cxCapturedAtMs !== null)
    ? new Date(cxCapturedAtMs).toISOString()
    : null;

  // Codex token usage and its notional API cost, from the per-turn rollout
  // deltas the collector scanned. Row tokens track the five-hour window (as
  // Claude's do); the cost block is the trailing week at OpenAI's published
  // prices — never a bill, the same framing as Claude's.
  const cxEvents = Array.isArray(input.codexEvents) ? input.codexEvents : [];
  const cxFiveUsage = codexUsage.sumCodexTokens(cxEvents, now - 5 * 60 * 60 * 1000, now);
  const cxTokens = cxFiveUsage.tokens.billable > 0 ? cxFiveUsage.tokens : null;
  const cxByModel = cxFiveUsage.byModel;
  const cxWeeklyCost = codexPricing.codexCost(cxEvents, now - 7 * 24 * 60 * 60 * 1000, now, false);

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
    if (p.id === 'codex') {
      const snap = {
        id: p.id,
        displayName: p.displayName,
        accent: p.accent,
        enabled: enabled[p.id] === true,
        connected: cxRow.connected,
        status: cxRow.status,
        // plan_type ("plus") is an account fact, not a usage number; ADR-001
        // keeps planLabel sourced from app settings, as for Antigravity.
        planLabel: null,
        fiveHour: cxFive,
        sevenDay: cxSeven,
        tokens: cxTokens,
        burnRatePerHour: null,
        byModel: cxByModel.slice(0, 6),
        weeklyCost: cxWeeklyCost,
        setupAction: cxRow.setup ? { ...p.setupAction } : null,
        lastGoodAt: cxLastGoodAt,
      };
      if (cxRow.errorCode) snap.errorCode = cxRow.errorCode;
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
    // Week/month notional cost from the SAME deduped local corpus every other
    // figure uses — so the 115.3% resume-replay inflation cannot land on the
    // history any more than it can on the weekly total. Today that corpus is
    // Claude's; the settings section is labelled accordingly.
    usageHistory: history.usageHistory(deduped, now),
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
    // Nothing has been scanned yet, so there is no history to state. Null, not
    // an empty history: "we have not looked" is not "you used nothing".
    usageHistory: null,
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
