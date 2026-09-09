'use strict';
const { PROVIDER_IDS, DEFAULT_ENABLED } = require('./providers');

/**
 * Which providers the user has ADDED to the main panel.
 *
 * Sibling of `order.js`, and for the same reason: this is a file on disk that
 * survives upgrades, so it is UNTRUSTED input. It will eventually name a
 * provider that no longer exists, omit one that was added after it was
 * written, or be a hand-edited fragment.
 *
 * The failure mode this module exists to prevent is asymmetric. A bad ORDER
 * costs the user a row in the wrong place; a bad ENABLEMENT map can cost them
 * every row at once — an empty panel with no visible cause, on a machine where
 * the data was collected fine. So every degraded path falls back to the
 * shipped defaults rather than to "nothing is enabled":
 *
 *   1. a value that is not a plain object (missing, array, string, null) ->
 *      defaults for everything
 *   2. a key that is not a real provider id -> ignored
 *   3. a value that is not a boolean -> ignored, so that id keeps its default
 *   4. an id the map does not mention -> its default
 *
 * Stored as a MAP rather than a list of enabled ids on purpose: a list cannot
 * distinguish "the user turned everything off" from "the file is missing", and
 * those two must not render the same.
 */

/** Untrusted value -> the known ids it states a boolean for, and nothing else. */
function sanitizeEnabled(raw, known = PROVIDER_IDS) {
  const allowed = Array.isArray(known) ? known : [];
  const out = {};
  // `typeof null === 'object'`, and an array would silently contribute
  // numeric keys that are not provider ids, so both are rejected here.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const id of allowed) {
    if (!Object.prototype.hasOwnProperty.call(raw, id)) continue;
    const value = raw[id];
    if (typeof value !== 'boolean') continue;
    out[id] = value;
  }
  return out;
}

/** Sanitized map, completed with the shipped default for every unnamed id. */
function resolveEnabled(raw, known = PROVIDER_IDS) {
  const allowed = Array.isArray(known) ? known : [];
  const stated = sanitizeEnabled(raw, allowed);
  const out = {};
  for (const id of allowed) {
    out[id] = Object.prototype.hasOwnProperty.call(stated, id)
      ? stated[id]
      : DEFAULT_ENABLED[id] === true;
  }
  return out;
}

/** The map with one id changed, ready to persist. Never mutates its input. */
function withEnabled(raw, id, enabled, known = PROVIDER_IDS) {
  const allowed = Array.isArray(known) ? known : [];
  const next = sanitizeEnabled(raw, allowed);
  if (!allowed.includes(id)) return next;
  next[id] = Boolean(enabled);
  return next;
}

module.exports = { sanitizeEnabled, resolveEnabled, withEnabled, DEFAULT_ENABLED };
