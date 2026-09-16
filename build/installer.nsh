; Included by electron-builder into the per-user NSIS installer (package.json
; build.nsis.include).
;
; The app registers its own login item at runtime via
; app.setLoginItemSettings (src/main/index.js, applyAutostart). NSIS knows
; nothing about that value, so a plain uninstall would leave
; HKCU\...\Run pointing at an exe that no longer exists. Remove it here.
;
; Guarded by isUpdated: electron-builder runs the old uninstaller during an
; upgrade, and the new build re-registers on its first launch anyway, but there
; is no reason to drop the entry in between.
;
; Value name is Electron's default AppUserModelID, "electron.app.<productName>",
; verified against the installed build (not the package.json "name").
; HKCU only: this installer never elevates and never writes HKLM.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.Usage Notch"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "electron.app.Usage Notch"
  ${endIf}
!macroend
