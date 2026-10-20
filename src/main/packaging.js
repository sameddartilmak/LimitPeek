'use strict';
const os = require('node:os');
const path = require('node:path');

/**
 * How this copy of the app was installed, and the two places where that
 * changes what main may do (verified on an MSIX build, 2026-09-25).
 *
 * A Microsoft Store (MSIX) package runs with its writes to AppData and to
 * HKCU REDIRECTED into a private per-package location on a machine where the
 * folder did not exist before the package created it. Reads of the user's
 * home directory are not redirected, which is why every reader in core/ works
 * unchanged. Two things this app writes are meant to be seen by OTHER programs,
 * and those two break:
 *
 *   - the bridge script Claude Code and agy execute. Under userData it lands
 *     in the package's private copy, which `node` started by Claude Code never
 *     sees. A Store build keeps it under the home directory instead.
 *   - the HKCU\...\Run login item `app.setLoginItemSettings` writes. Windows
 *     never reads the redirected copy. A Store build declares a StartupTask in
 *     its manifest (build/appx-extensions.xml) and Windows owns the setting.
 *
 * The NSIS build is unchanged in both: moving an existing user's bridge would
 * mean rewriting their Claude Code settings.json without asking, which the
 * setup flow never does.
 */

/** True inside an MSIX/AppX package (Electron sets this from the package identity). */
function isStoreBuild(proc = process) {
  return Boolean(proc && proc.windowsStore === true);
}

/**
 * Where the bridge scripts live.
 * @param {{store:boolean, userData:string, home?:string}} where
 */
function bridgeDirFor({ store, userData, home = os.homedir() }) {
  return store ? path.join(home, '.usage-notch', 'bridge') : path.join(userData, 'bridge');
}

/**
 * The userData folder, by name. NEVER derived from the product name.
 *
 * Electron names userData after `app.name`, which comes from the packaged
 * package.json: its top-level `productName` if it has one, else `name`.
 * electron-builder's `build.productName` (the exe, the shortcuts, the
 * Programs-list entry: "Usage Notch" up to 0.6.26, "LimitPeek" since) is not
 * copied into that file, so the folder has always been `name`, `usage-notch`.
 * Every installed copy keeps its settings, its usage history and the bridge
 * script Claude Code's settings.json points at (userData\bridge) in it, so it
 * is pinned here instead of being left to a packaging detail that a future
 * electron-builder, or a top-level productName, would quietly change.
 */
const USER_DATA_FOLDER = 'usage-notch';

/**
 * Pins userData to %APPDATA%\usage-notch. Must run before anything reads it,
 * the single-instance lock included (Electron keys the lock on userData, so an
 * old and a new build also keep excluding each other). `--user-data-dir` still
 * wins: the zero-socket audit runs a build against a scratch folder that way,
 * and pinning over it would point the audit at the owner's real settings.
 */
function pinUserData(app) {
  if (app.commandLine.hasSwitch('user-data-dir')) return;
  app.setPath('userData', path.join(app.getPath('appData'), USER_DATA_FOLDER));
}

module.exports = { isStoreBuild, bridgeDirFor, USER_DATA_FOLDER, pinUserData };
