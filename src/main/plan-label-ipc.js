'use strict';
const { withPlanLabel } = require('../core/plan-labels');
const { PROVIDER_IDS } = require('../core/providers');

/**
 * The main-process half of SET_PLAN_LABEL, split out of `index.js` for the same
 * reason `language-ipc.js` is: so the code that runs in the app is the code that
 * is tested. `test/plan-labels.test.js` drives this handler in plain Node and
 * `scripts/smoke-ipc.js` registers this same function in a real Electron
 * process. A smoke that re-implemented it would prove only its own copy.
 *
 * Nothing here requires `electron`; every side effect is passed in.
 */

/**
 * The SET_PLAN_LABEL handler.
 *
 * THIS IS THE VALIDATION BOUNDARY. The control on the other side is an
 * `<input list>` whose datalist only SUGGESTS known plans — it accepts anything
 * the user types — and nothing arriving over IPC may be assumed to have been
 * checked by the renderer. So the id must be a real provider, and the label goes
 * through `withPlanLabel`, which is the SAME function the settings loader uses:
 * trimmed, whitespace-collapsed, control characters stripped, capped at 24. One
 * function, so a hand-edited settings file and this channel cannot disagree
 * about what a valid label is.
 *
 * A non-string label is REFUSED rather than treated as a clear. Clearing is a
 * thing the user asks for by emptying the field; a caller bug that sends a
 * number must not silently delete a label they still want.
 *
 * Persist THEN apply, with an in-memory rollback if the write failed, exactly as
 * SET_THEME does. `{ ok: false }` has to mean main wrote NOTHING, because the
 * renderer reverts its control on that answer — and a label that lived only in
 * the DOM would be a setting the user loses at the next launch without ever
 * being told. There is no push here: the new label reaches the panel on the
 * snapshot `apply()` rebuilds, which is what the row renders from.
 *
 * Synchronous end to end, like its neighbours: main runs it to completion before
 * the next message, so two rapid edits cannot interleave two read-modify-write
 * cycles over `settings.planLabels`.
 *
 * @param {object} deps
 * @param {(event: object) => boolean} deps.fromPanel
 * @param {() => object} deps.getSettings  the live settings object, mutated in place
 * @param {(settings: object) => boolean} deps.save
 * @param {(providerId: string, label: string) => void} deps.apply
 * @param {{warn: Function}} deps.log
 * @param {string[]} [deps.known]  provider ids, for tests
 */
function createSetPlanLabelHandler({ fromPanel, getSettings, save, apply, log, known = PROVIDER_IDS }) {
  return (event, providerId, label) => {
    if (!fromPanel(event)) return { ok: false };
    if (typeof providerId !== 'string' || !known.includes(providerId)) return { ok: false };
    if (typeof label !== 'string') return { ok: false };

    const settings = getSettings();
    const previous = settings.planLabels;
    settings.planLabels = withPlanLabel(previous, providerId, label, known);
    if (!save(settings)) {
      settings.planLabels = previous;
      log.warn('plan label could not be persisted; nothing changed');
      return { ok: false };
    }
    // Only after the write succeeded, so the panel and the file always agree.
    try {
      apply(providerId, label);
    } catch (err) {
      // The file is correct and the next launch will read it; only this
      // session's snapshot is stale. Reverting the FILE here would be worse —
      // it would discard a value the user successfully saved because a repaint
      // failed. Report and keep the write.
      log.warn(`plan label could not be applied: code=${(err && err.code) || 'UNKNOWN'}`);
    }
    return { ok: true };
  };
}

module.exports = { createSetPlanLabelHandler };
