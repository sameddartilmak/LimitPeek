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

module.exports = { isStoreBuild, bridgeDirFor };
