'use strict';
const os = require('node:os');
const path = require('node:path');

/**
 * Filesystem locations the collector is allowed to touch.
 *
 * Deliberately absent: `~/.claude/.credentials.json`. That file holds
 * `claudeAiOauth.accessToken` / `refreshToken`. Per ADR-001 (security F1,
 * CRITICAL veto) it is never opened, read, bound or referenced anywhere in
 * this codebase. `planLabel` comes from app settings or stays null.
 *
 * The same veto covers Antigravity: `~/.gemini/` holds the CLI's own auth
 * material, and the only file named here under it is `settings.json`, of which
 * only the `statusLine` key is ever read or written.
 */

function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function claudeProjectsDir() {
  return path.join(claudeHome(), 'projects');
}

function claudeSettingsPath() {
  return path.join(claudeHome(), 'settings.json');
}

/**
 * Where the `agy` CLI keeps its configuration, per
 * https://antigravity.google/docs/cli/statusline/ — the documented location of
 * the `statusLine` hook block.
 */
function antigravityDefaultHome() {
  return path.join(os.homedir(), '.gemini', 'antigravity-cli');
}

/**
 * The env override exists for tests, and for a user whose CLI is not at the
 * documented path — if that directory name is ever wrong, this is the only
 * one-constant fix available in the field.
 *
 * It is a loaded gun, which is why `antigravityHomeOverridden()` exists beside
 * it. A set value makes the installer write a `statusLine` somewhere `agy`
 * never reads while reporting "Bağlandı", and the user then waits for a
 * percentage that cannot arrive. Every caller that WRITES must say out loud
 * that it is not using the default path (see `setup/antigravity-bridge.js`).
 *
 * Read, never written.
 */
function antigravityHome() {
  return process.env.ANTIGRAVITY_CLI_DIR || antigravityDefaultHome();
}

/**
 * True when `ANTIGRAVITY_CLI_DIR` is set AND is the path being used.
 *
 * Deliberately keyed on the ENV VAR rather than on "this path is not the
 * default one". The warning it drives is about the escape hatch being active,
 * and a caller that passes an explicit directory — a test, or a future
 * multi-install resolver — has not touched the escape hatch and must not be
 * warned about one. Comparing paths alone conflated the two and fired the
 * warning at every sandbox.
 */
function antigravityHomeOverridden(homeDir) {
  const override = process.env.ANTIGRAVITY_CLI_DIR;
  if (!override) return false;
  const resolved = homeDir || antigravityHome();
  return path.resolve(resolved) === path.resolve(override)
    && path.resolve(resolved) !== path.resolve(antigravityDefaultHome());
}

function antigravitySettingsPath() {
  return path.join(antigravityHome(), 'settings.json');
}

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
}

function rateLimitsDir() {
  return path.join(localAppData(), 'UsageNotch');
}

function rateLimitsFile() {
  return path.join(rateLimitsDir(), 'claude-rate-limits.json');
}

/**
 * The Antigravity bridge's output. A SEPARATE file from Claude's on purpose:
 * the two hooks are executed by two different programs at two different
 * cadences, and one shared file would mean whichever ran last erased the other
 * provider's reading.
 */
function antigravityQuotaFile() {
  return path.join(rateLimitsDir(), 'antigravity-quota.json');
}

module.exports = {
  claudeHome,
  claudeProjectsDir,
  claudeSettingsPath,
  antigravityHome,
  antigravityDefaultHome,
  antigravityHomeOverridden,
  antigravitySettingsPath,
  localAppData,
  rateLimitsDir,
  rateLimitsFile,
  antigravityQuotaFile,
};
