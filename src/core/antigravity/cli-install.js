'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { agyBinaryPath } = require('../paths');

/**
 * Installs the `agy` CLI by running Google's official Windows installer.
 *
 * ============================ SECURITY NOTE ============================
 * This module is the ONE place in the codebase that downloads and executes
 * code from the network. Everything else about this app is offline; this is
 * the deliberate, narrow exception, and it exists only behind an explicit
 * user consent gate raised by the caller (see
 * `src/main/bridge-install.js:runAntigravityInstall`, where the native
 * confirmation dialog sits immediately above the call to `installAgy`).
 *
 * What it runs is exactly the command the vendor documents at
 * https://antigravity.google/docs/cli/install :
 *
 *     irm https://antigravity.google/cli/install.ps1 | iex
 *
 * i.e. PowerShell downloads `install.ps1` over HTTPS from antigravity.google
 * and executes it. That script drops `agy.exe` into
 * `%LOCALAPPDATA%\agy\bin`.
 *
 * The app's "zero outbound network at RUNTIME" promise is intact and this does
 * not weaken it: this runs only when the user clicks "install" in a setup
 * flow, never on a timer, a refresh, or a snapshot. It is a one-time,
 * consented setup step, and the code and the dialog both say so plainly.
 *
 * Safety properties this module guarantees:
 *   - Windows only. Every other platform returns `unsupported` and runs
 *     nothing.
 *   - The URL is a hard-coded HTTPS constant. No part of it comes from user
 *     input, a file, or the network, so there is nothing to inject into it.
 *   - PowerShell is invoked by ABSOLUTE path through `execFile` with an
 *     argument array — no shell, no PATH lookup, no string the OS re-parses.
 *   - A timeout kills a hung installer.
 *   - SUCCESS IS DEFINED BY THE BINARY EXISTING afterwards, not by an exit
 *     code. A script that exits 0 but left no `agy.exe` is a failure here.
 *   - Fail-safe: on any failure the caller is told, and this module itself
 *     writes nothing to the machine. (The vendor script may have; that is
 *     outside our reach and the dialog says the download runs it.)
 * ======================================================================
 */

/** The vendor's documented installer. HTTPS, hard-coded, never composed. */
// Security residual (reviewed, INFO): this is trust-on-first-use. We cannot
// hash-pin the script — the vendor publishes no integrity value for it, and it
// changes with every CLI release — so the guarantee is HTTPS to a hard-coded
// vendor host, nothing more. That is inherent to the documented install
// method; pinning would require the vendor to publish a digest.
const INSTALL_URL = 'https://antigravity.google/cli/install.ps1';

/** Generous: a cold download plus unpack on a slow link. Killed past this. */
const INSTALL_TIMEOUT_MS = 180_000;
/** The installer prints progress; give it room without being unbounded. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** True when `agy.exe` is on disk where the installer puts it. */
function isAgyInstalled(binaryPath) {
  const file = binaryPath || agyBinaryPath();
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Runs the installer. NO consent is asked here — the caller must have obtained
 * it already. This function assumes the click has happened.
 *
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.binaryPath] where to look for the result (tests)
 * @param {Function} [options.exec] injection point, same shape as
 *   `child_process.execFile`. Nothing in the app passes it; tests do, so the
 *   suite never touches the network.
 * @returns {Promise<{ok:boolean, code:string, detail?:string}>}
 *   - `{ok:true,  code:'installed'}`   agy.exe is present afterwards
 *   - `{ok:false, code:'unsupported'}` not Windows; nothing ran
 *   - `{ok:false, code:'already'}`     agy.exe was already there; nothing ran
 *   - `{ok:false, code:'run-failed'}`  the installer errored/timed out and no
 *                                      binary appeared
 *   - `{ok:false, code:'no-binary'}`   it ran without error but left no binary
 *   never rejects.
 */
function installAgy(options = {}) {
  const binaryPath = options.binaryPath || agyBinaryPath();
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: false, code: 'unsupported' });
  }
  // Idempotent: never reinstall over an existing binary.
  if (isAgyInstalled(binaryPath)) {
    return Promise.resolve({ ok: false, code: 'already' });
  }

  const run = options.exec || execFile;
  const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : INSTALL_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      run(
        powershellPath(),
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy', 'Bypass',
          // The vendor's exact one-liner. `irm` = Invoke-RestMethod (the
          // download), `iex` = Invoke-Expression (the run). The URL is the
          // constant above and nothing else is interpolated.
          '-Command', `irm ${INSTALL_URL} | iex`,
        ],
        { timeout, windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
        (err) => {
          // The binary is the source of truth, not the exit code: a vendor
          // script that exits 0 but installed nothing is not a success, and
          // one that prints a warning to stderr and exits non-zero but DID
          // install is not a failure.
          if (isAgyInstalled(binaryPath)) return finish({ ok: true, code: 'installed' });
          if (err) {
            // Never surface `err.message`: it can echo the command line.
            return finish({ ok: false, code: 'run-failed', detail: (err && err.code) || 'UNKNOWN' });
          }
          return finish({ ok: false, code: 'no-binary' });
        },
      );
    } catch {
      // Spawn refused outright (no PowerShell, no permission).
      finish({ ok: false, code: 'run-failed', detail: 'SPAWN' });
    }
  });
}

module.exports = {
  installAgy,
  isAgyInstalled,
  powershellPath,
  INSTALL_URL,
  INSTALL_TIMEOUT_MS,
};
