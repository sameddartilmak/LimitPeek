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
 * WHY NO PREFILL PARAMETERS
 * -------------------------
 * The brief allows query parameters that prefill the token name, expiry or the
 * Plan permission for FINE-GRAINED tokens, but only against a citable doc. This
 * lane has no network access and could not read GitHub's documentation, so the
 * bare page URL is used. An invented `?name=…&…` that GitHub ignores would be
 * harmless; one it half-honours would put the user on a screen whose fields do
 * not match the instructions beside the button. Whoever can cite the doc may add
 * them here, in the literal.
 */
function openTokenPage(providerId) {
  if (!isKeyCapable(providerId)) return { ok: false };

  if (providerId === 'copilot') {
    try {
      // GitHub's fine-grained personal access token creation page. The consent
      // copy tells the user which permission to grant (User -> Plan: read); the
      // URL itself asks for nothing.
      const opened = shell.openExternal('https://github.com/settings/personal-access-tokens/new');
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
