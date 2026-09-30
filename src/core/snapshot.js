'use strict';
const { PROVIDERS } = require('./providers');
const { applyOrder } = require('./order');
const { resolveEnabled } = require('./enabled');
const pricing = require('./pricing');
const agg = require('./aggregate');
const history = require('./history');
const codexUsage = require('./codex/usage');
const codexPricing = require('./codex/pricing');
const kimiUsage = require('./kimi/usage');
const kimiCostMod = require('./kimi/cost');
const qwenUsage = require('./qwen/usage');
const qwenPricing = require('./qwen/pricing');
const grokUsage = require('./grok/usage');
const grokCostMod = require('./grok/cost');
const antigravityUsage = require('./antigravity/usage');
const antigravityCostMod = require('./antigravity/cost');
const { RETENTION_DAYS, DAY_MS } = require('./scan/scanner');
const { sanitizePlanLabels } = require('./plan-labels');
const { codexPlanFrom, planFields } = require('./plan-detect');

/** One shared empty list, so "no events" keeps the same identity across builds. */
const EMPTY_EVENTS = Object.freeze([]);

/**
 * The last usage history built, and what it was built from (ADR-003 A6 Phase A
 * ruling on F3). Pricing every week and month over a year of four tools' events
 * took ~19 ms per rebuild on the main thread; the inputs rarely change between
 * two sweeps, so an identical rebuild reuses the previous result.
 *
 * The key is exact, never a content guess:
 *  - each tool's event array by IDENTITY (the collector keeps the previous array
 *    when a scan returns identical events, see `sameEvents` in usage-channel.js),
 *  - the known-unread ranges by value,
 *  - the local week and month the clock is in (a new period appears at the boundary).
 * Every event is older than the scan that produced it, so nothing else about
 * `now` changes the result. A failed scan's unread range ends at `now` and
 * therefore misses the memo on every rebuild: correct, merely not cached.
 */
let historyMemo = null;

function memoUsageHistory(rawClaude, dedupedAll, now, opts, archive) {
  // A Claude record stamped in the future (clock skew) would join the history
  // later without any key changing (review F10): such records are left out of
  // the history until their time comes, and how many were left out is part of
  // the key.
  let future = 0;
  for (const ev of dedupedAll) if (ev && ev.ts > now) future += 1;
  const deduped = future > 0 ? dedupedAll.filter((ev) => !(ev && ev.ts > now)) : dedupedAll;
  const key = {
    future,
    claude: rawClaude,
    archive,
    codex: opts.codexEvents,
    kimi: opts.kimiEvents,
    qwen: opts.qwenEvents,
    grok: opts.grokEvents,
    antigravity: opts.antigravityEvents,
    unread: JSON.stringify(opts.unreadRanges),
    week: history.weekStartMs(now),
    month: history.monthStartMs(now),
  };
  const prev = historyMemo && historyMemo.key;
  if (prev && prev.future === key.future && prev.claude === key.claude && prev.archive === key.archive && prev.codex === key.codex && prev.kimi === key.kimi
    && prev.qwen === key.qwen && prev.grok === key.grok && prev.antigravity === key.antigravity && prev.unread === key.unread && prev.week === key.week && prev.month === key.month) {
    return historyMemo.value;
  }
  // Before the archive's frontier the archive's per-day rows stand in for the
  // raw records; from it on, the raw records. Never both for one instant.
  const claudeHistory = archive
    ? archive.rows.concat(deduped.filter((ev) => ev && ev.ts >= archive.frontierMs))
    : deduped;
  const value = history.usageHistory(claudeHistory, now, opts);
  historyMemo = { key, value };
  return value;
}

/**
 * Per-model lists in a WeeklyCost are bounded (ADR-003 A6 review, security F4).
 * `byModel` is ordered priced-first, so the kept rows carry the money.
 */
function boundCost(cost) {
  if (!cost) return cost;
  if (cost.byModel.length > history.MAX_LIST) cost.byModel = cost.byModel.slice(0, history.MAX_LIST);
  if (cost.unpricedModels.length > history.MAX_LIST) cost.unpricedModels = cost.unpricedModels.slice(0, history.MAX_LIST);
  return cost;
}

/**
 * `hookInstalled` on the two rows whose setup writes a statusLine hook into
 * another tool's settings, when main says (input.hooks); absent otherwise.
 */
function withHooks(providers, hooks) {
  if (!hooks || typeof hooks !== 'object') return providers;
  return providers.map((p) => (p.id === 'claude' || p.id === 'antigravity'
    ? { ...p, hookInstalled: hooks[p.id] === true }
    : p));
}

/** Test seam: forget the memoised history. */
function _resetHistoryMemoForTests() {
  historyMemo = null;
}

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

/**
 * The known-unread instant ranges of one tool (ADR-002 A3.15, A3.20): the
 * scan's own `{ fromMs, throughMs }` hull, plus — when the latest scan failed
 * and an older result is served — everything from when that result was read
 * up to now. Invalid entries are dropped.
 */
/** The collector's archive: validated when it was loaded or built, so only its shape is checked here. */
function isArchive(a) {
  return Boolean(a) && typeof a === 'object' && Number.isFinite(a.frontierMs) && Array.isArray(a.rows);
}

function unreadRangesOf(scanRange, failed, failedFromMs, now) {
  const out = [];
  if (scanRange && Number.isFinite(scanRange.fromMs) && Number.isFinite(scanRange.throughMs)) {
    out.push({ fromMs: scanRange.fromMs, throughMs: scanRange.throughMs });
  }
  // A failure's range always has width: from strictly before now (review F4).
  if (failed) out.push({ fromMs: Number.isFinite(failedFromMs) ? Math.min(failedFromMs, now - 1) : 0, throughMs: now });
  return out;
}

/**
 * Does any range overlap the window [startMs, endMs]? Inclusive at the end: a
 * range's instants are inclusive, and a window ending at now must still meet a
 * range that starts at now (review F4).
 */
function overlapsAny(ranges, startMs, endMs) {
  return ranges.some((r) => r.throughMs >= startMs && r.fromMs <= endMs);
}

/**
 * A WeeklyCost with nothing readable in it, for a source KNOWN to be incomplete
 * (ADR-002 A3.19): the block states the gap instead of the row reading "no
 * token data". Every figure is an honest zero of "nothing READ"; the renderer
 * reads `sourceIncomplete` and never presents it as a lower-bound amount.
 */
function emptyWeeklyCost(startMs, endMs, anchored, pricesAsOf) {
  return {
    totalUsd: 0,
    byClass: { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
    byModel: [],
    unpricedModels: [],
    fallbackWriteEvents: 0,
    cacheWriteEvents: 0,
    unrecordedWriteEvents: 0,
    assumedTierEvents: 0,
    fastRequestedEvents: 0,
    // Nothing was read, so there is no amount for any cause to qualify.
    unrecordedCalls: false,
    longPromptFloorEvents: 0,
    toolTokenEvents: 0,
    partialUsageEvents: 0,
    sourceIncomplete: true,
    pricesAsOf,
    windowStart: new Date(startMs).toISOString(),
    windowEnd: new Date(endMs).toISOString(),
    windowAnchored: Boolean(anchored),
  };
}

/**
 * `ProviderSnapshot.weeklyTokenFloorCauses` for one row.
 *
 * The RULE is `history.tokenFloorCauses` and lives there precisely so this file
 * does not hold a second copy of it: what differs between a panel row and a
 * history period is the window arithmetic, not what makes a count a lower bound.
 * All this does is reduce this row's window to the booleans that function takes.
 */
function weeklyTokenFloorCausesFor(providerId, weeklyTokens, sourceIncomplete, unrecordedWrites, partialUsage = false) {
  return history.tokenFloorCauses(providerId, {
    hasCount: history.hasAnyTokens(weeklyTokens),
    sourceIncomplete,
    unrecordedWrites,
    partialUsage,
  });
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
 * A row for a tool whose ONLY source is its own local usage log: Kimi Code,
 * Qwen Code and Grok Build (ADR-003 Amendment 6). None writes a 5-hour or
 * weekly limit figure anywhere this app may read, so both windows are `not-supplied`
 * ("bildirilmiyor"): the tool does not publish them to us, which is not the
 * same claim as "unknown", and no window is invented.
 *
 *  - Not installed (its data directory is absent): the passive "not installed"
 *    row every unsupported provider already had.
 *  - Installed: connected, status 'ok'. Tokens are a trailing five hours (no
 *    reset anchor exists, exactly as Codex falls back without one); the cost
 *    block is a trailing 7 days (`windowAnchored: false`). While the first scan
 *    is pending, `tokens`/`weeklyCost` are null because they are NOT READ YET
 *    and `Snapshot.pendingUsage` says so. A known-incomplete scan marks the cost
 *    `sourceIncomplete` (A3.15) and never touches the row status.
 *  - Installed but no usage log written at all (`src.usageLogAbsent`, Qwen
 *    Code): connected with no figures, and `usageLogAbsent: true` so the row
 *    says why instead of claiming a measured zero.
 *
 * @param {object} p        registry entry
 * @param {boolean} enabled
 * @param {{installed?:boolean, events?:Array|null, readFailed?:boolean,
 *          resultAtMs?:number|null, unreadRange?:object|null}|undefined} src
 * @param {number} now
 * @param {{sum: Function, cost: Function, pricesAsOf: string,
 *          partialUsage?: Function}} reader  `partialUsage(events, startMs, endMs)`
 *        is the Grok Build token-floor fact (xAI marked usage incomplete)
 * @param {string|null} [planLabel] the plan the user typed for THIS tool, or
 *        null. Passed in rather than looked up here so this function keeps no
 *        opinion about a value it only forwards.
 * @returns {{row: object, unread: Array}}
 */
function localUsageRow(p, enabled, src, now, reader, planLabel) {
  const installed = Boolean(src && src.installed === true);
  const base = {
    id: p.id,
    displayName: p.displayName,
    accent: p.accent,
    enabled,
    experimental: p.experimental === true,
    planLabel: typeof planLabel === 'string' && planLabel ? planLabel : null,
    burnRatePerHour: null,
  };
  if (!installed) {
    return {
      row: {
        ...base,
        connected: false,
        status: 'passive',
        fiveHour: null,
        sevenDay: null,
        tokens: null,
        weeklyTokens: null,
        weeklyTokensWindowAnchored: null,
        weeklyTokenFloorCauses: [],
        weeklyCost: null,
        setupAction: { ...p.setupAction },
        lastGoodAt: null,
      },
      unread: [],
      events: EMPTY_EVENTS,
    };
  }
  const events = Array.isArray(src.events) ? src.events : null;
  const list = events || EMPTY_EVENTS;
  // Only from a scan that worked: after a failed one the old "no log" is not
  // known to still hold (review F4).
  if (events && src.usageLogAbsent === true && src.readFailed !== true && list.length === 0) {
    return {
      row: {
        ...base,
        connected: true,
        status: 'ok',
        fiveHour: unknownWindow('not-supplied'),
        sevenDay: unknownWindow('not-supplied'),
        tokens: null,
        // No log exists, so there is no week to measure: null, not a zero.
        weeklyTokens: null,
        weeklyTokensWindowAnchored: null,
        weeklyTokenFloorCauses: [],
        byModel: [],
        weeklyCost: null,
        usageLogAbsent: true,
        setupAction: null,
        lastGoodAt: Number.isFinite(src.resultAtMs) ? new Date(src.resultAtMs).toISOString() : null,
      },
      unread: [],
      events: EMPTY_EVENTS,
    };
  }
  const fiveWin = agg.fiveHourWindow(now, null);
  const five = reader.sum(list, fiveWin.start, Math.min(fiveWin.end, now));
  const weekWin = agg.sevenDayWindow(now, null);
  // The row's headline token figure, over EXACTLY the window the cost block
  // below is priced over — never capped at `now` the way the five-hour sum is,
  // so the two figures beside each other describe the same seven days. Neither
  // tool publishes a weekly reset to us, so this window is always trailing
  // (`windowAnchored: false`), which is what the block already says.
  const week = reader.sum(list, weekWin.start, weekWin.end);
  // Present whenever the corpus was SCANNED, all-zero included: a quiet week is
  // a measurement and must read as one. Null only while pending (`events` is
  // null), which `Snapshot.pendingUsage` explains. Deliberately NOT the
  // `billable > 0` rule that `tokens` below still uses — that rule reported a
  // scanned empty week as "we did not look".
  const weekTokens = events ? week.tokens : null;
  const unread = events
    ? unreadRangesOf(src.unreadRange, src.readFailed === true, src.resultAtMs, now)
    : [];
  const incomplete = overlapsAny(unread, weekWin.start, weekWin.end);
  let weeklyCost = events ? reader.cost(list, weekWin.start, weekWin.end, false) : null;
  if (weeklyCost) boundCost(weeklyCost).sourceIncomplete = incomplete;
  else if (incomplete) weeklyCost = emptyWeeklyCost(weekWin.start, weekWin.end, false, reader.pricesAsOf);
  return {
    row: {
      ...base,
      connected: true,
      status: 'ok',
      fiveHour: unknownWindow('not-supplied'),
      sevenDay: unknownWindow('not-supplied'),
      tokens: five.tokens.billable > 0 ? five.tokens : null,
      // Same null rule as `tokens` on this row, deliberately: pending (no
      // events read yet) and a genuinely empty week both read as "nothing to
      // state" rather than a confident zero. A row never carries one of the two
      // figures without the other.
      weeklyTokens: weekTokens,
      // Always false once scanned: neither tool publishes a weekly reset to us,
      // so `weekWin` can only ever be trailing. Stated rather than left to be
      // inferred, and readable even when nothing priced and `weeklyCost` is null.
      weeklyTokensWindowAnchored: weekTokens ? weekWin.anchored : null,
      // Qwen Code's unrecorded calls, Grok Build's incomplete turns and every
      // tool's known-unread ranges are decided by the shared rule; none reads
      // a cost cause.
      weeklyTokenFloorCauses: weeklyTokenFloorCausesFor(
        p.id, weekTokens, incomplete, false,
        Boolean(events && reader.partialUsage && reader.partialUsage(list, weekWin.start, weekWin.end)),
      ),
      byModel: five.byModel.slice(0, 6),
      weeklyCost,
      setupAction: null,
      // When the held usage result was read; null while pending.
      lastGoodAt: events && Number.isFinite(src.resultAtMs) ? new Date(src.resultAtMs).toISOString() : null,
    },
    unread,
    events: list,
  };
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
 * @param {{fromMs:number, throughMs:number}|null} [input.scanUnreadRange] instants
 *        of transcript records the last scan knew it could not read (A3.15)
 * @param {boolean} [input.codexReadFailed] the latest Codex usage scan failed or
 *        timed out, so `codexEvents` is an older result
 * @param {number|null} [input.codexReadGoodAtMs] when the held Codex result was read
 * @param {{fromMs:number, throughMs:number}|null} [input.codexUnreadRange] instants
 *        of Codex turns the last rollout scan knew it could not read
 * @param {object} [input.planLabels]  plan names the user typed, per tool, from
 *        app settings ONLY. Never inferred, never read from the credentials file
 *        (ADR-001 security F1), and never read by any figure: it is copied onto
 *        the row and displayed. See `src/core/plan-labels.js`.
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
  // The per-day archive of Claude records older than the raw retention
  // (scan/archive.js); only the week/month history reads it.
  const claudeArchive = isArchive(input.claudeArchive) ? input.claudeArchive : null;

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
  // The row's headline token figure: absolute tokens inside EXACTLY that
  // window — the one `sevenDay` describes and `weeklyCost` is priced over. The
  // identity is the point: the count is read beside the 7-day percentage, so a
  // window even slightly different would pair a number with a percentage that
  // describe two different weeks. Same deduped set, same half-open bounds. One
  // extra linear pass over events already in memory (no file is re-read), so
  // the short panel cadence costs nothing here.
  const weekTokens = agg.sumWindow(deduped, weekWin.start, weekWin.end).tokens;
  // Same deduped set as every other figure: the 115.3% replay inflation would
  // otherwise land directly on the money.
  // ADR-002 A3.15: only the transcript scan's OWN completeness — never the
  // rate-limit capture's freshness or rollover, which say nothing about whether
  // the logs were read. A failed scan serves the previous store, which holds
  // nothing older than the retention window.
  const claudeUnread = unreadRangesOf(
    input.scanUnreadRange,
    !scanOk,
    Number.isFinite(input.scanGoodAtMs) ? input.scanGoodAtMs : now - RETENTION_DAYS * DAY_MS,
    now,
  );
  const claudeIncomplete = overlapsAny(claudeUnread, weekWin.start, weekWin.end);
  let weeklyCost = pricing.weeklyCost(deduped, weekWin.start, weekWin.end, weekWin.anchored);
  if (weeklyCost) boundCost(weeklyCost).sourceIncomplete = claudeIncomplete;
  else if (claudeIncomplete) {
    // A3.19: nothing readable in the window, and KNOWN not to be the whole story.
    weeklyCost = emptyWeeklyCost(weekWin.start, weekWin.end, weekWin.anchored, pricing.PRICES_AS_OF);
  }

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

  // Same discipline, one line down, and the only use this value has anywhere in
  // core: the label the user typed for each tool, copied onto its row. Nothing
  // below reads it to decide a quota, a price, a floor or a limit — it is not a
  // fact we verified (src/core/plan-labels.js). A tool the user said nothing
  // about gets null, and the renderer then shows nothing at all.
  const planLabels = sanitizePlanLabels(input.planLabels);
  const planOf = (id) => (planLabels[id] === undefined ? null : planLabels[id]);

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
   * Tokens and the notional cost come from a THIRD source, the per-conversation
   * stores (antigravity/usage.js), read off-thread like Kimi Code's journals; see
   * the block after `agModelQuotas`. `burnRatePerHour` stays null, as on the
   * other local-log rows. ADR-001 Decision 1 still rules out any percentage
   * from those tokens.
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

  // Tokens and notional API cost, from the conversation stores. The same shape
  // as Codex's block below and the same null rules as the local-log rows: five-hour
  // tokens anchored to the five-hour reset of the source `agFive` came from
  // while that reset is ahead, a trailing five hours otherwise; the week
  // anchored to the agy CLI's weekly reset while it is ahead, a trailing 7 days
  // otherwise, which the block labels (windowAnchored). Null until the store
  // scan first answers (Snapshot.pendingUsage), and while Antigravity has no
  // conversation store on this machine.
  const agUse = input.antigravityUsage;
  const agScanned = Boolean(agUse && agUse.installed === true && Array.isArray(agUse.events));
  const agEvents = agScanned ? agUse.events : EMPTY_EVENTS;
  const agFiveRaw = agUseCliFive ? agq.fiveHour : agIde.fiveHour;
  const agFiveResetsAtMs = agFiveRaw ? agFiveRaw.resetsAtMs : null;
  const agFiveWin = agg.fiveHourWindow(now, Number.isFinite(agFiveResetsAtMs) && now < agFiveResetsAtMs ? agFiveResetsAtMs : null);
  const agFiveUsage = antigravityUsage.sumAntigravityTokens(agEvents, agFiveWin.start, Math.min(agFiveWin.end, now));
  const agSevenResetsAtMs = agq.sevenDay ? agq.sevenDay.resetsAtMs : null;
  const agWeekWin = agg.sevenDayWindow(now, Number.isFinite(agSevenResetsAtMs) && now < agSevenResetsAtMs ? agSevenResetsAtMs : null);
  const agWeeklyTokens = agScanned
    ? antigravityUsage.sumAntigravityTokens(agEvents, agWeekWin.start, agWeekWin.end).tokens
    : null;
  const agUnread = agScanned
    ? unreadRangesOf(agUse.unreadRange, agUse.readFailed === true, agUse.resultAtMs, now)
    : [];
  const agIncomplete = overlapsAny(agUnread, agWeekWin.start, agWeekWin.end);
  let agWeeklyCost = agScanned
    ? antigravityCostMod.antigravityCost(agEvents, agWeekWin.start, agWeekWin.end, agWeekWin.anchored)
    : null;
  if (agWeeklyCost) boundCost(agWeeklyCost).sourceIncomplete = agIncomplete;
  else if (agIncomplete) {
    agWeeklyCost = emptyWeeklyCost(agWeekWin.start, agWeekWin.end, agWeekWin.anchored, antigravityCostMod.PRICES_AS_OF);
  }

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
  // Claude's do); the cost block is the week at OpenAI's published prices —
  // never a bill, the same framing as Claude's.
  const cxEvents = Array.isArray(input.codexEvents) ? input.codexEvents : EMPTY_EVENTS;
  // Five-hour tokens: anchored to Codex's own five-hour reset while it is
  // still ahead, exactly as Claude's are; a trailing 5h otherwise. The window
  // end is capped at now — the rest of it has not happened.
  const cxFiveResetsAtMs = cx.fiveHour ? cx.fiveHour.resetsAtMs : null;
  const cxFiveAnchorMs = Number.isFinite(cxFiveResetsAtMs) && now < cxFiveResetsAtMs ? cxFiveResetsAtMs : null;
  const cxFiveWin = agg.fiveHourWindow(now, cxFiveAnchorMs);
  const cxFiveUsage = codexUsage.sumCodexTokens(cxEvents, cxFiveWin.start, Math.min(cxFiveWin.end, now));
  const cxTokens = cxFiveUsage.tokens.billable > 0 ? cxFiveUsage.tokens : null;
  const cxByModel = cxFiveUsage.byModel;
  // Same window rule as Claude's (ADR-002 rule 4): the Codex quota week, ending
  // at its own seven-day reset, while that reset is still ahead of us; a
  // trailing 7 days otherwise, which the block labels as such (windowAnchored).
  const cxSevenResetsAtMs = cx.sevenDay ? cx.sevenDay.resetsAtMs : null;
  const cxWeekAnchorMs = Number.isFinite(cxSevenResetsAtMs) && now < cxSevenResetsAtMs ? cxSevenResetsAtMs : null;
  const cxWeekWin = agg.sevenDayWindow(now, cxWeekAnchorMs);
  // The row's headline token figure, over EXACTLY the window `cxSeven` reports
  // and `cxWeeklyCost` is priced over — anchored to Codex's own weekly reset
  // while that reset is still ahead, trailing otherwise, never Claude's. Not
  // capped at `now`: the cost beside it is not, and the two must describe the
  // same seven days.
  const cxWeekUsage = codexUsage.sumCodexTokens(cxEvents, cxWeekWin.start, cxWeekWin.end);
  // Present whenever the rollout scan has produced a result, all-zero included:
  // a week without Codex is a measured zero, not "we did not look". Null only
  // while PENDING, which `Snapshot.pendingUsage` explains (A3.12). `cxTokens`
  // (5 hours) keeps its own shipped rule, so the two can differ here.
  const cxWeeklyTokens = Array.isArray(input.codexEvents) ? cxWeekUsage.tokens : null;
  // ADR-002 A3.15, as for Claude: the rollout scan's own completeness only.
  // While pending there is no result to be incomplete (pendingUsage says so).
  const codexUnread = Array.isArray(input.codexEvents)
    ? unreadRangesOf(input.codexUnreadRange, input.codexReadFailed === true, input.codexReadGoodAtMs, now)
    : [];
  const cxIncomplete = overlapsAny(codexUnread, cxWeekWin.start, cxWeekWin.end);
  // The DETAIL, not just the cost: `unrecordedWriteTokens` rides the same pass
  // and is what decides whether the token count is a floor (A3.3/A3.9). It is
  // a different question from `unrecordedWriteEvents`, which stays a cost cause.
  const cxWeekDetail = codexPricing.codexCostDetail(cxEvents, cxWeekWin.start, cxWeekWin.end, cxWeekWin.anchored);
  let cxWeeklyCost = cxWeekDetail.cost;
  if (cxWeeklyCost) boundCost(cxWeeklyCost).sourceIncomplete = cxIncomplete;
  else if (cxIncomplete) {
    cxWeeklyCost = emptyWeeklyCost(cxWeekWin.start, cxWeekWin.end, cxWeekWin.anchored, codexPricing.PRICES_AS_OF);
  }

  // --- Kimi Code / Qwen Code / Grok Build (ADR-003 A6) ---------------------
  const km = localUsageRow(PROVIDERS.find((p) => p.id === 'kimi'), enabled.kimi === true, input.kimi, now, {
    sum: kimiUsage.sumKimiTokens,
    cost: kimiCostMod.kimiCost,
    // Kimi has no price table: an incomplete empty cost states no date either.
    pricesAsOf: '',
  }, planOf('kimi'));
  const qw = localUsageRow(PROVIDERS.find((p) => p.id === 'qwen'), enabled.qwen === true, input.qwen, now, {
    sum: qwenUsage.sumQwenTokens,
    cost: qwenPricing.qwenCost,
    pricesAsOf: qwenPricing.PRICES_AS_OF,
  }, planOf('qwen'));
  const gk = localUsageRow(PROVIDERS.find((p) => p.id === 'grok'), enabled.grok === true, input.grok, now, {
    sum: grokUsage.sumGrokTokens,
    cost: grokCostMod.grokCost,
    // The amounts are xAI's own: no price list, so no date.
    pricesAsOf: '',
    partialUsage: grokUsage.grokUsageIncomplete,
  }, planOf('grok'));
  const localPending = (src) => Boolean(src && src.installed === true && !Array.isArray(src.events));

  const providers = PROVIDERS.map((p) => {
    if (p.id === 'kimi') return km.row;
    if (p.id === 'qwen') return qw.row;
    if (p.id === 'grok') return gk.row;
    if (p.id === 'antigravity') {
      const snap = {
        id: p.id,
        displayName: p.displayName,
        accent: p.accent,
        enabled: enabled[p.id] === true,
        experimental: p.experimental === true,
        connected: agRow.connected,
        status: agRow.status,
        // Antigravity states a plan tier in its payload, and the bridge still
        // does not capture it: ADR-001 keeps `planLabel` sourced from app
        // settings ONLY, so even a tier we could read is not read. What shows
        // here is what the user typed for this tool, or nothing.
        planLabel: planOf(p.id),
        fiveHour: agFive,
        sevenDay: agSeven,
        // Same null rule as the local-log rows: a quiet five hours is null, a
        // scanned week is present even at zero.
        tokens: agFiveUsage.tokens.billable > 0 ? agFiveUsage.tokens : null,
        weeklyTokens: agWeeklyTokens,
        weeklyTokensWindowAnchored: agWeeklyTokens ? agWeekWin.anchored : null,
        weeklyTokenFloorCauses: weeklyTokenFloorCausesFor('antigravity', agWeeklyTokens, agIncomplete, false),
        burnRatePerHour: null,
        byModel: agFiveUsage.byModel.slice(0, 6),
        weeklyCost: agWeeklyCost,
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
        experimental: p.experimental === true,
        connected: cxRow.connected,
        status: cxRow.status,
        // plan_type ("plus") is in the rollout and is still not read: ADR-001
        // keeps planLabel sourced from app settings, as for Antigravity. So this
        // is the user's own label for Codex, or nothing.
        planLabel: planOf(p.id),
        fiveHour: cxFive,
        sevenDay: cxSeven,
        tokens: cxTokens,
        weeklyTokens: cxWeeklyTokens,
        // Codex's OWN weekly reset, never Claude's; null while the scan is pending.
        weeklyTokensWindowAnchored: cxWeeklyTokens ? cxWeekWin.anchored : null,
        // `unrecordedWriteTokens` rides the pricing pass and is price-free, so
        // an unpriced turn's missing writes count exactly as a priced one's do.
        weeklyTokenFloorCauses: weeklyTokenFloorCausesFor(
          'codex', cxWeeklyTokens, cxIncomplete, cxWeekDetail.unrecordedWriteTokens === true,
        ),
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
        experimental: p.experimental === true,
        connected: false,
        status: 'passive',
        // A row we cannot collect for can still be a plan the user pays for, and
        // saying so is not a claim about usage.
        planLabel: planOf(p.id),
        fiveHour: null,
        sevenDay: null,
        tokens: null,
        weeklyTokens: null,
        weeklyTokensWindowAnchored: null,
        weeklyTokenFloorCauses: [],
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
      experimental: p.experimental === true,
      connected: row.connected,
      status: row.status,
      planLabel: planOf(p.id),
      fiveHour,
      sevenDay,
      tokens,
      // Present whenever `tokens` is, and by the same rule: this row is only
      // built after a scan, so both are real counts — a zero here is a measured
      // zero, not "we did not look" (that state is `loadingSnapshot`).
      weeklyTokens: weekTokens,
      // The same `weekWin` the count was summed over, so the figure always names
      // its own window — including on a quiet or just-reset week, where nothing
      // priced and `weeklyCost` is null.
      weeklyTokensWindowAnchored: weekWin.anchored,
      // Claude's own recorder drops nothing we know of: its writes survive the
      // TTL fallback (`max(total, cw5 + cw1h)`) and an unpriced model still has
      // its tokens counted. So only a range the scan KNOWS it could not read
      // makes this count a lower bound.
      weeklyTokenFloorCauses: weeklyTokenFloorCausesFor('claude', weekTokens, claudeIncomplete, false),
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
    providers: applyOrder(withPlans(withHooks(providers, input.hooks), planLabels, {
      // The plan each tool RECORDS for the account (plan-detect.js); the user's
      // own label in Settings still wins.
      claude: typeof input.claudePlan === 'string' ? input.claudePlan : null,
      codex: codexPlanFrom(cx.planType),
    }), input.order),
    // Week/month notional cost from the SAME deduped local corpus every other
    // figure uses — so the 115.3% resume-replay inflation cannot land on the
    // history any more than it can on the weekly total. Codex joins it from the
    // SAME scanned turn deltas its row's tokens and weekly cost are built from,
    // priced by its own table; the settings section names both sources.
    // Periods overlapping a known-unread range are floors (A3.20).
    // Kimi Code, Qwen Code and Grok Build join it from their own scans
    // (ADR-003 A6), each priced by its own rules (Kimi: unpriced; Grok: the
    // amount xAI reported).
    usageHistory: memoUsageHistory(Array.isArray(input.events) ? input.events : EMPTY_EVENTS, deduped, now, {
      codexEvents: cxEvents,
      kimiEvents: km.events,
      qwenEvents: qw.events,
      grokEvents: gk.events,
      antigravityEvents: agEvents,
      unreadRanges: {
        claude: claudeArchive && claudeArchive.unread ? claudeUnread.concat([claudeArchive.unread]) : claudeUnread,
        codex: codexUnread, antigravity: agUnread, kimi: km.unread, qwen: qw.unread, grok: gk.unread,
      },
    }, claudeArchive),
    // ADR-002 A3.12. The collector passes `codexEvents: null` until the Codex
    // worker's first result, so its empty figures above read as NOT READ YET.
    // Claude never needs an entry: before its first scan the collector sends
    // `loadingSnapshot` instead of this, and afterwards its store is real.
    // The local-log tools are pending only when installed and not yet
    // scanned, in the registry's order.
    pendingUsage: [
      ...(Array.isArray(input.codexEvents) ? [] : ['codex']),
      ...(localPending(input.antigravityUsage) ? ['antigravity'] : []),
      ...(localPending(input.kimi) ? ['kimi'] : []),
      ...(localPending(input.qwen) ? ['qwen'] : []),
      ...(localPending(input.grok) ? ['grok'] : []),
    ],
  };
}

/**
 * Every row's plan fields: the user's label from Settings, else the plan the
 * tool itself recorded (`detected`), with where it came from and the tool's
 * value kept for Settings' "Otomatik (…)" option. A label only — nothing reads
 * it to compute anything (plan-labels.js, plan-detect.js).
 */
function withPlans(providers, userLabels, detected) {
  return providers.map((row) => ({
    ...row,
    ...planFields(userLabels[row.id], Object.prototype.hasOwnProperty.call(detected, row.id) ? detected[row.id] : null),
  }));
}

/** Shown before the first scan completes, and if the store is empty. */
function loadingSnapshot(now = Date.now(), order, enabledRaw, pendingUsage, planLabelsRaw) {
  // Same resolution as buildSnapshot: the skeleton must show exactly the rows
  // the first real snapshot will, or the panel visibly drops rows on load.
  const enabled = resolveEnabled(enabledRaw);
  // Carried because the plan sits in the row HEADER, so a row that gains one a
  // moment after the panel opens visibly changes shape. It
  // is a setting, already known at cold start — unlike every figure here, which
  // is why this is the one value the skeleton can state truthfully.
  const planLabels = sanitizePlanLabels(planLabelsRaw);
  return {
    generatedAt: new Date(now).toISOString(),
    // Ordered too: the skeleton is what a cold start paints, and rows must not
    // visibly jump into place when the first real snapshot lands.
    providers: applyOrder(PROVIDERS.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      accent: p.accent,
      enabled: enabled[p.id] === true,
      experimental: p.experimental === true,
      connected: false,
      // Keyed off `live`, not off the id: a provider we can collect must paint
      // the same skeleton the first real snapshot will replace, or its row
      // visibly changes shape a moment after the panel opens.
      status: p.live ? 'loading' : 'passive',
      ...planFields(planLabels[p.id], null),
      fiveHour: p.live ? unknownWindow() : null,
      sevenDay: p.live ? unknownWindow() : null,
      tokens: null,
      // Nothing scanned yet: null is "we have not looked", never a zero week.
      weeklyTokens: null,
      weeklyTokensWindowAnchored: null,
      weeklyTokenFloorCauses: [],
      burnRatePerHour: null,
      weeklyCost: null,
      setupAction: p.live ? null : { ...p.setupAction },
      lastGoodAt: null,
    })), order),
    // Nothing has been scanned yet, so there is no history to state. Null, not
    // an empty history: "we have not looked" is not "you used nothing".
    usageHistory: null,
    // Claude's rows already say 'loading'. Codex's figures come from a
    // separate worker that may already have answered, so the collector passes
    // its real state; with no caller state, nothing has been scanned.
    pendingUsage: Array.isArray(pendingUsage) ? pendingUsage.slice() : ['codex'],
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
  _resetHistoryMemoForTests,
};
