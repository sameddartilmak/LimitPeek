'use strict';
const { PROVIDER_IDS } = require('./providers');

/**
 * The plan the user says they are on, per tool. "Max 20x" beside Claude Code.
 *
 * WHY THIS IS A SETTING AND NOT A READING
 * --------------------------------------
 * The plan appears nowhere in anything this app reads. Claude Code's
 * transcripts carry no plan, subscription, tier or account field; the one place
 * a tier does exist is `~/.claude/.credentials.json`, which ADR-001 security F1
 * forbids opening at all. So there are exactly two honest options: the user
 * tells us, or the row says nothing. Inferring a plan from usage volume — "you
 * burned this much, you must be on 20x" — would be a guess printed as a fact,
 * which is the error ADR-001 exists to prevent. We repeat back what we were
 * told, and nothing more.
 *
 * IT IS A LABEL, NEVER A NUMBER
 * -----------------------------
 * Nothing may compute from it. Not a quota, not a denominator, not a price, not
 * a floor, not a limit — no `if (plan === 'Max 20x')` anywhere, ever. The
 * moment a figure depends on it, an unverified string the user typed becomes an
 * input to arithmetic we present as measured, and the plan is not even
 * spell-checked. It travels from this file to `ProviderSnapshot.planLabel` and
 * is displayed. That is its whole life cycle.
 *
 * PER TOOL, BECAUSE A PERSON HAS SEVERAL PLANS
 * -------------------------------------------
 * Claude Max 20x and a Codex Plus subscription coexist, so one global string
 * could only ever be right about one row. A partial map, for the same reason
 * `enabled.js` is partial: a tool the user has said nothing about must show
 * nothing, which is different from showing an empty string.
 *
 * UNTRUSTED AT BOTH ENDS
 * ----------------------
 * It is typed by a person, persisted to a hand-editable file that survives
 * upgrades, and then rendered into the panel. So it is sanitised here on the way
 * in — trimmed, length-capped, non-strings dropped, empty stored as absent —
 * AND again in the renderer on the way out. Two checks on one value is not
 * redundancy: this one keeps the settings file sane, the renderer's keeps the
 * DOM sane, and neither can assume the other ran.
 */

/**
 * Longest label kept, in characters.
 *
 * Long enough for every real plan name ("Max 20x", "Pro+", "Business",
 * "Teams Premium"), short enough that it cannot push the row header around —
 * the label sits inline beside the tool name in a fixed-width panel, so an
 * unbounded string is a layout bug the user can type. Mirrored by the
 * renderer's own cap in `sanitize.ts`; both are 24 on purpose.
 */
const MAX_PLAN_LABEL = 24;

/**
 * One untrusted value -> a clean label, or null.
 *
 * Trimmed first, so " Max 20x " and "Max 20x" are one value and a label of
 * nothing but spaces reads as absent. Sliced AFTER trimming, so the cap counts
 * what will be shown rather than the whitespace around it.
 *
 * Control characters are stripped rather than causing a reject: a label pasted
 * out of a terminal or a web page can carry a stray newline or a zero-width
 * character, and dropping the user's whole plan over an invisible byte would be
 * a mysterious failure. What is left is a single visual line or nothing.
 */
function sanitizePlanLabel(raw) {
  if (typeof raw !== 'string') return null;
  const clean = raw
    // C0/C1 controls, then the invisible formatting range, then the two
    // characters that are line terminators in JS but not matched by \s.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return null;
  return clean.slice(0, MAX_PLAN_LABEL);
}

/**
 * Untrusted value -> the known ids it states a usable label for, and nothing
 * else. Same four rules as `sanitizeEnabled`, for the same reason:
 *
 *   1. a value that is not a plain object (missing, array, string, null) -> {}
 *   2. a key that is not a real provider id -> ignored
 *   3. a value that is not a usable string -> ignored, so that row shows nothing
 *   4. an id the map does not mention -> absent, which renders as nothing
 *
 * There is deliberately no default label for any tool. A plan we were not told
 * is not "Free" and not "bilinmiyor" — it is a row that says nothing about
 * plans, which is the honest rendering of an absent fact.
 */
function sanitizePlanLabels(raw, known = PROVIDER_IDS) {
  const allowed = Array.isArray(known) ? known : [];
  const out = {};
  // `typeof null === 'object'`, and an array would contribute numeric keys that
  // are not provider ids, so both are rejected here.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const id of allowed) {
    if (!Object.prototype.hasOwnProperty.call(raw, id)) continue;
    const label = sanitizePlanLabel(raw[id]);
    if (label !== null) out[id] = label;
  }
  return out;
}

/**
 * The map with one tool's label changed, ready to persist. Never mutates its
 * input, and clearing a label DELETES the key rather than storing an empty
 * string — an empty string would travel to the row as a truthy-looking absence
 * and the renderer would have to decide what it meant.
 */
function withPlanLabel(raw, id, label, known = PROVIDER_IDS) {
  const allowed = Array.isArray(known) ? known : [];
  const next = sanitizePlanLabels(raw, allowed);
  if (!allowed.includes(id)) return next;
  const clean = sanitizePlanLabel(label);
  if (clean === null) delete next[id];
  else next[id] = clean;
  return next;
}

/**
 * The legacy single `planLabel` folded into the per-tool map.
 *
 * Before this was per tool there was one string, and only the Claude row ever
 * received it — so that is exactly where it belongs now, and nowhere else.
 * Dropping it instead would silently lose a setting the user typed, on upgrade,
 * with no error and no way to tell it had happened.
 *
 * The map wins where both exist: a `planLabels.claude` was written by a newer
 * build than the `planLabel` beside it, and a stale field left behind by a
 * downgrade-then-upgrade must not overwrite the current answer.
 *
 * @param {unknown} rawLabels  the `planLabels` map as read from disk
 * @param {unknown} legacy     the old top-level `planLabel`
 */
function migratePlanLabels(rawLabels, legacy, known = PROVIDER_IDS) {
  const out = sanitizePlanLabels(rawLabels, known);
  const allowed = Array.isArray(known) ? known : [];
  if (!allowed.includes('claude')) return out;
  if (Object.prototype.hasOwnProperty.call(out, 'claude')) return out;
  const clean = sanitizePlanLabel(legacy);
  if (clean !== null) out.claude = clean;
  return out;
}

module.exports = {
  MAX_PLAN_LABEL,
  sanitizePlanLabel,
  sanitizePlanLabels,
  withPlanLabel,
  migratePlanLabels,
};
