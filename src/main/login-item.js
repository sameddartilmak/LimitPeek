'use strict';
const path = require('node:path');

/**
 * The HKCU\...\Run login item, and the one rename it went through.
 *
 * Every build up to 0.6.26 was called "Usage Notch" on disk. Electron names the
 * Run value after the default AppUserModelID, "electron.app.<exe ProductName>",
 * so those builds wrote `electron.app.Usage Notch`, pointing at
 * `Usage Notch.exe`. From 0.6.27 the exe is `LimitPeek.exe` and the value is
 * named here explicitly, so it no longer depends on how Electron derives the ID.
 *
 * An update over an old install leaves the old value behind: the old
 * uninstaller runs with --updated and keeps it on purpose (build/installer.nsh),
 * and the new installer only repoints it at the new exe so a login before the
 * first launch still starts the app. The first launch then moves it to the new
 * name, here, carrying the user's Task Manager choice with it: Windows keeps
 * "disabled" as a StartupApproved\Run value under the SAME name, so a plain
 * re-register under the new name would silently switch it back on.
 *
 * Only a value that points at THIS install is touched (this exe, or the old exe
 * beside it). A packaged build run from somewhere else — dist\win-unpacked
 * during an audit — must not delete the login item of the copy the owner has
 * installed.
 *
 * Nothing here requires `electron`; `app` is passed in, so the tests drive this
 * exact code over a fake.
 */

/** The value 0.6.27 and later write. */
const RUN_NAME = 'electron.app.LimitPeek';

/** The value every build up to 0.6.26 wrote, and the exe it pointed at. */
const LEGACY_RUN_NAME = 'electron.app.Usage Notch';
const LEGACY_EXE = 'Usage Notch.exe';

/** Started by Windows: come up in the tray only, never flash a window. */
const LOGIN_ARGS = ['--hidden'];

/**
 * HKCU launch items Electron reports for `exe` under `name`.
 *
 * Asked twice, bare and in quotes. Electron 44's match depends on whether the
 * path holds a space: `"...\Usage Notch.exe" --hidden` was found only for a
 * quoted `path`, `"...\LimitPeek.exe" --hidden` (no space) for a bare one
 * (measured 2026-10-20, on the host read-only and in Windows Sandbox). A
 * profile folder with a space puts LimitPeek.exe in the first group too.
 */
function itemsFor(app, exe, name) {
  const items = [];
  for (const asked of [exe, `"${exe}"`]) {
    const found = app.getLoginItemSettings({ path: asked, args: LOGIN_ARGS });
    if (found && Array.isArray(found.launchItems)) items.push(...found.launchItems);
  }
  return items.filter((item) => item && item.scope === 'user' && item.name === name);
}

/**
 * Removes the pre-0.6.27 value if it belongs to this install.
 *
 * @param {{app: object, execPath?: string, log: {info: Function}}} deps
 * @returns {{migrated: boolean, disabled: boolean}} `disabled` is true when
 *   Windows had the old value switched off (Task Manager, Settings > Startup).
 */
function migrateLegacyLoginItem({ app, execPath = process.execPath, log }) {
  // A build still called Usage Notch has nothing to migrate from: the old
  // value IS its own.
  if (path.basename(execPath).toLowerCase() === LEGACY_EXE.toLowerCase()) return { migrated: false, disabled: false };
  const candidates = [execPath, path.join(path.dirname(execPath), LEGACY_EXE)];
  const found = candidates.flatMap((exe) => itemsFor(app, exe, LEGACY_RUN_NAME));
  if (found.length === 0) return { migrated: false, disabled: false };
  // openAtLogin:false deletes the Run value AND its StartupApproved twin.
  app.setLoginItemSettings({ openAtLogin: false, name: LEGACY_RUN_NAME });
  const disabled = found.some((item) => item.enabled === false);
  log.info(`login item moved from ${LEGACY_RUN_NAME}${disabled ? ' (switched off in Windows; kept off)' : ''}`);
  return { migrated: true, disabled };
}

/** True when Windows has this build's own value switched off. */
function disabledByWindows({ app, execPath = process.execPath }) {
  return itemsFor(app, execPath, RUN_NAME).some((item) => item.enabled === false);
}

/**
 * What applyAutostart hands to `app.setLoginItemSettings`.
 *
 * `keepOff` keeps a value Windows has switched off, off. Electron's `enabled`
 * defaults to true, which DELETES the StartupApproved value, so without it a
 * launch would undo the user's Task Manager choice every time. Launch passes
 * it; the app's own switch does not, because flipping that is an explicit
 * "start with Windows" and must win.
 */
function loginItemSettings(enabled, { keepOff = false } = {}) {
  const settings = { openAtLogin: Boolean(enabled), name: RUN_NAME, args: LOGIN_ARGS };
  if (enabled && keepOff) settings.enabled = false;
  return settings;
}

module.exports = {
  RUN_NAME,
  LEGACY_RUN_NAME,
  LEGACY_EXE,
  LOGIN_ARGS,
  migrateLegacyLoginItem,
  disabledByWindows,
  loginItemSettings,
};
