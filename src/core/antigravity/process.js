'use strict';
const { execFile } = require('node:child_process');
const path = require('node:path');

/**
 * Is the Antigravity IDE running right now?
 *
 * Asked only when the user presses Yenile. The reason it is worth asking: the
 * five-hour figure comes out of a file the IDE writes, so with the IDE closed
 * a refresh cannot possibly produce a newer number. Without this the user
 * presses the button, sees the same "… önce güncellendi" as before, and has no
 * way to tell whether the fault is theirs or ours.
 *
 * Three answers, and the third is not a failure:
 *
 *   'running'      an image whose name begins with "antigravity" is up
 *   'not-running'  the process list was read and none is
 *   'unknown'      we could not tell — wrong platform, tasklist missing,
 *                  timed out, unreadable output
 *
 * `unknown` is the FAIL-SAFE direction and every error path lands there.
 * Telling a user their editor is closed while it is open is a wrong statement;
 * saying nothing is merely unhelpful, and the row's own wording already covers
 * the unhelpful case.
 *
 * No network, no dependency: `tasklist.exe` ships with Windows and is invoked
 * by absolute path through `execFile`, so neither PATH nor a shell is
 * involved and there is no argument string for anything to be injected into.
 */

/** Deliberately a prefix, for the same reason `install.js` uses one: the
 *  product renamed itself once already, and the live image is "Antigravity
 *  IDE.exe" where the old one was "Antigravity.exe". */
const IMAGE_PREFIX = /^antigravity/i;
/** Its own ceiling, independent of whatever budget the caller allows. */
const PROBE_TIMEOUT_MS = 2000;
/** The process list on a busy machine is tens of KB; this is room to spare. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function tasklistPath() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(root, 'System32', 'tasklist.exe');
}

/**
 * The first CSV field of each line is the image name. Parsed by hand rather
 * than with a filter argument (`/FI "IMAGENAME eq ..."`) because a filter
 * needs the exact name, which is the thing that changed last time — and
 * because tasklist's "no tasks" message is localised, while an empty match
 * list is not.
 */
function anyAntigravityImage(stdout) {
  for (const line of String(stdout).split('\n')) {
    const m = /^"([^"]*)"/.exec(line.trim());
    if (m && IMAGE_PREFIX.test(m[1])) return true;
  }
  return false;
}

/**
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.exec] injection point for tests; same shape as
 *   `child_process.execFile`. Nothing in the app passes it.
 * @returns {Promise<'running'|'not-running'|'unknown'>} never rejects.
 */
function isAntigravityRunning(options = {}) {
  if (process.platform !== 'win32') return Promise.resolve('unknown');
  const run = options.exec || execFile;
  const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : PROBE_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      resolve(answer);
    };
    try {
      run(
        tasklistPath(),
        ['/FO', 'CSV', '/NH'],
        { timeout, windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
        (err, stdout) => {
          // A timeout arrives here as an error with the child already killed.
          // Never inspect the message: it can quote the command line.
          if (err) return finish('unknown');
          if (typeof stdout !== 'string' || stdout.length === 0) return finish('unknown');
          return finish(anyAntigravityImage(stdout) ? 'running' : 'not-running');
        },
      );
    } catch {
      // Spawn refused outright (no such binary, no permission).
      finish('unknown');
    }
  });
}

module.exports = { isAntigravityRunning, anyAntigravityImage, IMAGE_PREFIX, PROBE_TIMEOUT_MS };
