; Included by electron-builder into the per-user NSIS installer (package.json
; build.nsis.include). `!include`d by path, so makensis reads THIS file: it is
; saved UTF-8 with a BOM, which is what NSIS 3 needs to decode the Turkish
; message below (without a BOM it would fall back to the system code page).
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

; A REAL uninstall also deletes the stored API key (ADR-003 Amendment 5, K12).
;
; `%LOCALAPPDATA%\UsageNotch\secrets` holds one DPAPI-encrypted record per
; provider, written only if the user chose to add a key (src/core/paths.js,
; secretsDir). Leaving it behind would leave a credential on a machine whose
; owner just removed the program that asked for it — and nothing would ever
; delete it, because the only code that can is being uninstalled.
;
; Guarded by the same isUpdated as the login item, and for a stronger reason:
; electron-builder runs the OLD uninstaller during an upgrade, so deleting the
; key here unguarded would silently log the user out of their own row on every
; update. The rest of %LOCALAPPDATA%\UsageNotch (the statusline captures) is
; left alone: it is derived data, and this macro deletes only the secret.
;
; RMDir /r on a fixed, hard-coded path with no variables in it. The captures
; directory is not removed recursively because $LOCALAPPDATA is per-user and the
; path is a constant, so there is nothing here for a crafted value to redirect.
;
; WHAT isUpdated ACTUALLY TESTS, AND THE ONE EXCEPTION
; ---------------------------------------------------
; `${isUpdated}` is not an electron-builder template constant: it is generated
; per build as a macro that runs `${StdUtils.TestParameter} $R9 "updated"` on the
; UNINSTALLER'S OWN command line (app-builder-lib/out/targets/nsis/NsisTarget.js,
; `scriptGenerator.flags([... "updated" ...])`, emitted by
; nsisScriptGenerator.js). So it is true exactly when this uninstaller was
; started with `--updated`.
;
; During an upgrade the new installer copies the old uninstaller to
; $PLUGINSDIR\old-uninstaller.exe and runs it, normally with `--updated`
; appended (app-builder-lib/templates/nsis/include/installUtil.nsh, "always pass
; --updated flag"). That is why an upgrade keeps the key.
;
; EXCEPTION: that same block is an if/else. If the new installer itself was run
; with `--delete-app-data`, the old uninstaller is given `--delete-app-data`
; INSTEAD OF `--updated`:
;
;     ${if} ${isDeleteAppData}
;       StrCpy $0 "$0 --delete-app-data"
;     ${else}
;       StrCpy $0 "$0 --updated"
;     ${endif}
;
; so `${ifNot} ${isUpdated}` is TRUE in the middle of an upgrade and this macro
; deletes the stored key and the login item. That is a real hole in the sentence
; "an upgrade always keeps the key", and it is deliberate on electron-builder's
; side: the flag means the user asked for application data to go. Deleting the
; credential when the user asked to wipe their data is defensible, and the login
; item is re-registered by the new build on first launch, so nothing is left
; broken — but it is not what a reader of the paragraph above would assume.
;
; It is NOT guarded here on purpose. The only available discriminator is that an
; upgrade runs the uninstaller out of $PLUGINSDIR while a real uninstall runs it
; from $INSTDIR, which depends on an electron-builder implementation detail and
; would change upgrade semantics — an orchestrator/security decision, not a
; comment's. See the devops report of 2026-09-22 (F5).

; WHY THE REMOVAL IS CHECKED AND NOT JUST ISSUED (F4)
; --------------------------------------------------
; `RMDir /r` does not abort the section when it fails, and this macro runs
; BEFORE `RMDir /r $INSTDIR` (app-builder-lib/templates/nsis/uninstaller.nsh
; inserts customUnInstall at the top of `Section "un.Uninstall"`), i.e. while the
; app's own files — and possibly a still-running process — are still there. A
; single locked file therefore used to leave a DPAPI credential on disk after an
; uninstall the user asked for, with no log line, no dialog and no retry. That
; is the one outcome K12 exists to prevent, so it must not fail quietly.
;
; Three steps, cheapest first:
;   1. `RMDir /r`, then VERIFY with FileExists rather than trusting the error
;      flag. The question is "is anything left in there", not "did the API
;      complain", which is why the check uses `secrets\*.*`: an empty directory
;      that survives is not a leaked credential.
;   2. Anything left is retried with `/REBOOTOK`, which hands the leftovers to
;      PendingFileRenameOperations. WHEN THAT WORKS the credential goes at the
;      next boot instead of never. It does not always work: the queue lives under
;      HKLM and this uninstall is per-user and not elevated, so the retry can be
;      refused silently. A false -> true TRANSITION of the reboot flag says which
;      happened — the flag alone does not, because it is global and sticky and may
;      already be set for an unrelated reason (see the macro). The two cases then
;      get DIFFERENT copy — promising "it will go at the next restart" on the
;      path where it may survive forever is exactly the false reassurance K12
;      exists to prevent.
;   3. Report, and in BOTH cases point at revocation. Deleting the folder removes
;      the local copy; revoking the token at GitHub removes what the copy could
;      do. Only the second works whether or not the file went, so it is in every
;      message rather than only in the one where deletion failed.
;      `DetailPrint` alone is not enough: this is a oneClick uninstall,
;      the details log lives in $INSTDIR and $INSTDIR is deleted seconds later,
;      so the only channel that reaches a human is a dialog.
;
; The dialog is NOT guarded on `${Silent}`. un.onInit calls `SetSilent silent`
; for every oneClick uninstall (uninstaller.nsh, right after the
; "areYouSureToUninstall" confirmation), so `${Silent}` is true on the normal
; interactive path and that guard would suppress the message in exactly the case
; it is written for. The command line is re-read instead: `/S` is present only
; when a script or Windows' QuietUninstallString drove this, and that caller must
; never be blocked by a dialog. Registers $R6/$R7/$R8 are used rather than
; $R0/$R1, which the surrounding section reuses, and never $R9, which the
; generated `isUpdated` macro clobbers via ${StdUtils.TestParameter}.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; Take our statusLine hooks out of Claude Code's and agy's settings (the
    ; user's own line comes back if the setup kept one), while the app's files
    ; are still here to do it. Bounded: a hung run must not hold the uninstall.
    ; An update skips this, so a reinstall keeps the user connected.
    ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      nsExec::ExecToLog /TIMEOUT=15000 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --cleanup-integrations'
      Pop $0
    ${endIf}

    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.Usage Notch"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "electron.app.Usage Notch"

    ClearErrors
    RMDir /r "$LOCALAPPDATA\UsageNotch\secrets"
    ClearErrors

    ${if} ${FileExists} "$LOCALAPPDATA\UsageNotch\secrets\*.*"
      ; DID THE SCHEDULING ACTUALLY HAPPEN? `/REBOOTOK` queues the leftovers in
      ; PendingFileRenameOperations, under HKLM — which needs administrator
      ; context, and this is a per-user, non-elevated uninstall. So it can fail
      ; silently, and the old copy promised the folder would go at the next
      ; restart on a path where it may survive indefinitely. NSIS raises the
      ; reboot flag only when something really was queued, so that flag is the
      ; discriminator.
      ;
      ; But the reboot flag is GLOBAL and STICKY: it is not ours, nothing resets
      ; it, and anything earlier in this uninstall could have raised it. Reading
      ; it once after the call would therefore take the "scheduled" branch — and
      ; make exactly the false promise this fix exists to remove — whenever a
      ; reboot happened to be pending already. Only a false -> true TRANSITION is
      ; evidence about OUR deferral, so the state is captured first.
      ;
      ; If it was already set, the outcome stays "failed". That under-promises on
      ; a folder that may well have been queued, which is the safe direction for a
      ; credential: the failed message is true either way, it just omits a
      ; restart promise nobody can substantiate. The flag is never cleared here —
      ; suppressing another component's reboot prompt to make this test tidier
      ; would be a worse bug than the one it fixes.
      ;
      ; The error flag is deliberately NOT part of the test. After a SUCCESSFUL
      ; deferral the directory is still on disk, so RMDir may report failure
      ; anyway; requiring no-error would only add false negatives.
      StrCpy $R6 "0"
      ${if} ${RebootFlag}
        StrCpy $R6 "1"
      ${endIf}

      RMDir /r /REBOOTOK "$LOCALAPPDATA\UsageNotch\secrets"
      ClearErrors

      ; One discriminator, computed once. Two separate ${RebootFlag} tests could
      ; in principle disagree, and the dialog must not say something the log did
      ; not.
      StrCpy $R8 "failed"
      ${if} ${RebootFlag}
      ${andIf} $R6 == "0"
        StrCpy $R8 "scheduled"
      ${endIf}

      ${if} $R8 == "scheduled"
        DetailPrint "Usage Notch: $LOCALAPPDATA\UsageNotch\secrets is in use; its removal is scheduled for the next restart."
      ${else}
        DetailPrint "Usage Notch: $LOCALAPPDATA\UsageNotch\secrets is in use and could NOT be deleted, and no deferred removal could be confirmed; the user has been told to delete it and to revoke the token."
      ${endIf}

      ${GetParameters} $R6
      ClearErrors
      ${GetOptions} $R6 "/S" $R7
      ${if} ${Errors}
        ; REVOCATION IS IN EVERY MESSAGE, on purpose. It is the only remedy that
        ; works whether or not the file went: deleting the folder removes the
        ; local copy, revoking at GitHub removes the credential's power. So the
        ; step that protects the user unconditionally is never the one left out.
        ${if} $R8 == "scheduled"
          ${if} $LANGUAGE == 1055
            MessageBox MB_ICONEXCLAMATION|MB_OK "Usage Notch kaldırıldı, ancak kayıtlı API anahtarınızın bulunduğu klasör kullanımda olduğu için henüz silinemedi:$\r$\n$\r$\n$LOCALAPPDATA\UsageNotch\secrets$\r$\n$\r$\nWindows'u yeniden başlattığınızda kaldırılacak. Beklemek istemezseniz klasörü kendiniz silebilirsiniz. Her durumda anahtarı GitHub'dan iptal edin."
          ${else}
            MessageBox MB_ICONEXCLAMATION|MB_OK "Usage Notch has been removed, but the folder holding your stored API key was in use and could not be deleted yet:$\r$\n$\r$\n$LOCALAPPDATA\UsageNotch\secrets$\r$\n$\r$\nIt will be removed the next time you restart Windows. Delete it yourself if you would rather not wait. Either way, revoke the token at GitHub."
          ${endIf}
        ${else}
          ; Nothing was scheduled, so nothing may be promised for the restart.
          ${if} $LANGUAGE == 1055
            MessageBox MB_ICONEXCLAMATION|MB_OK "Usage Notch kaldırıldı, ancak kayıtlı API anahtarınızın bulunduğu klasör kullanımda olduğu için silinemedi:$\r$\n$\r$\n$LOCALAPPDATA\UsageNotch\secrets$\r$\n$\r$\nKlasörü kendiniz silin ve anahtarı GitHub'dan iptal edin — her durumda sizi koruyan adım bu."
          ${else}
            MessageBox MB_ICONEXCLAMATION|MB_OK "Usage Notch has been removed, but the folder holding your stored API key was in use and could not be deleted:$\r$\n$\r$\n$LOCALAPPDATA\UsageNotch\secrets$\r$\n$\r$\nDelete it yourself, and revoke the token at GitHub — that is the step that protects you either way."
          ${endIf}
        ${endIf}
      ${endIf}
      ClearErrors
    ${else}
      DetailPrint "Usage Notch: stored key removed ($LOCALAPPDATA\UsageNotch\secrets)."
    ${endIf}
  ${endIf}
!macroend
