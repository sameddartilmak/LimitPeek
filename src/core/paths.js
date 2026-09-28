'use strict';
const os = require('node:os');
const path = require('node:path');

/**
 * Filesystem locations the collector is allowed to touch.
 *
 * Deliberately absent: `~/.claude/.credentials.json`. That file holds
 * `claudeAiOauth.accessToken` / `refreshToken`. Per ADR-001 (security F1,
 * CRITICAL veto) it is never opened, read, bound or referenced anywhere in
 * this codebase. `planLabel` comes from app settings — one label per tool, in
 * `settings.planLabels` — or the row stays silent; never from a credential or a
 * plan field any tool records (`src/core/plan-labels.js`).
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

/**
 * The `.gemini` directory the Antigravity products keep their data under. NOT
 * `antigravityHome()`: that is the CLI's own config directory, and the
 * conversation stores sit beside it for all three products.
 */
function antigravityDataRoot() {
  return path.join(os.homedir(), '.gemini');
}

/**
 * The three conversation directories Antigravity writes one SQLite store per
 * conversation into: the `agy` CLI, the IDE, and the older `antigravity`
 * directory, which still holds stores written before the IDE's own directory
 * name changed (its install directory was renamed too; see
 * `antigravity/install.js`). All three are read. Only the
 * `<uuid>.db` files inside are ever opened (`antigravity/usage.js`), never
 * the encrypted `<uuid>.pb` files beside them, and nothing else under
 * `.gemini` is listed. `root` is the `.gemini` directory itself (tests).
 */
function antigravityConversationDirs(root) {
  const base = root || antigravityDataRoot();
  return ['antigravity-cli', 'antigravity-ide', 'antigravity'].map((name) => path.join(base, name, 'conversations'));
}

/**
 * Where the `agy` CLI's official Windows installer drops the binary, per
 * https://antigravity.google/docs/cli/install :
 * `C:\\Users\\<user>\\AppData\\Local\\agy\\bin\\agy.exe`.
 *
 * This is a SEPARATE location from `antigravityHome()`. That is the CLI's
 * config directory (`~/.gemini/antigravity-cli/`, created the first time agy
 * runs); this is the executable itself. A freshly installed CLI has the binary
 * but not yet the config directory, so "is agy installed" is answered by the
 * binary, not by the config dir.
 */
function agyBinDir() {
  return path.join(localAppData(), 'agy', 'bin');
}

function agyBinaryPath() {
  return path.join(agyBinDir(), 'agy.exe');
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
  antigravityDataRoot,
  antigravityConversationDirs,
  agyBinDir,
  agyBinaryPath,
  localAppData,
  rateLimitsDir,
  rateLimitsFile,
  antigravityQuotaFile,
};
