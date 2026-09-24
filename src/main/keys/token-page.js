'use strict';
const { shell } = require('electron');

const log = require('../../core/log');
const { isKeyCapable } = require('../../core/keys/registry');

/**
 * Opens the provider's token-creation page in the DEFAULT BROWSER (owner's
 * addition to ADR-003 Amendment 8).
 *
 * THE ONLY `shell.openExternal` IN THIS CODEBASE
 * ---------------------------------------------
 * And the only one there may be: a test scans `src/main` and `src/core` for the
 * string and fails if it appears anywhere else, or if its argument here is
 * anything but a quoted literal. `openExternal` hands a string to the OS shell
 * to dispatch by protocol handler, so a URL built from a variable — an IPC
 * argument, a provider reply, a stored value — is a way to launch something that
 * is not a browser. There is no variable in the call below, by construction:
 * the provider id chooses a BRANCH, and the branch contains the whole URL.
 *
 * PREFILLED FROM GITHUB'S TEMPLATE URL
 * -------------------------------------
 * GitHub documents query parameters that prefill the fine-grained token page
 * (docs.github.com, "Managing your personal access tokens", pre-filling
 * details; changelog 2025-08-26, checked 2026-09-24): `name` (<= 40 chars),
 * `description`, `expires_in` (1-366 days) and one `<permission>=<level>` per
 * permission, where the account permission "Plan" read-only is `plan=read`.
 * So the page opens with the name, a 30-day expiry and Plan: Read-only already
 * set, and the user only presses "Generate token". The owner's first real try
 * without it got a 403, because the Plan permission is easy to miss on that
 * page. `target_name` is left out: it defaults to the signed-in user, who is the
 * only account a Plan permission can be granted on.
 */
function openTokenPage(providerId) {
  if (!isKeyCapable(providerId)) return { ok: false };

  if (providerId === 'copilot') {
    try {
      // GitHub's fine-grained token page, prefilled: name, 30 days, Plan: read.
      const opened = shell.openExternal('https://github.com/settings/personal-access-tokens/new?name=Usage+Notch&description=Reads+Copilot+AI+credits+for+Usage+Notch&expires_in=30&plan=read');
      if (opened && typeof opened.catch === 'function') {
        opened.catch((err) => log.warn(`token page could not be opened: code=${(err && err.code) || 'UNKNOWN'}`));
      }
      return { ok: true };
    } catch (err) {
      log.warn(`token page could not be opened: code=${(err && err.code) || 'UNKNOWN'}`);
      return { ok: false };
    }
  }

  // A key-capable provider with no page is a registry entry someone added
  // without finishing this switch. Refused, never guessed.
  return { ok: false };
}

module.exports = { openTokenPage };
