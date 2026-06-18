; Screen Time — custom NSIS installer macros
; customInit: find and silently remove any previous installation before
; installing the new version (update-in-place / upgrade flow).
;
; electron-builder uses:
;   • a GUID as the registry key name  (e.g. {10b9e964-...})
;   • DisplayName = "Screen Time <version>"  (includes the version number)
;
; So we scan all Uninstall entries and compare the first 11 characters of
; DisplayName against "Screen Time" to match any version.
;
; The stored UninstallString is already fully-formed, e.g.:
;   "C:\Program Files\Screen Time\Uninstall Screen Time.exe" /allusers
; We append /S and execute it directly (no extra quoting).

!macro customInit
  ; ---- 1. Search HKLM (per-machine / elevated install) ----
  StrCpy $R1 0
  hklm_loop:
    EnumRegKey $R0 HKLM \
      "Software\Microsoft\Windows\CurrentVersion\Uninstall" $R1
    StrCmp $R0 "" hklm_done
    IntOp $R1 $R1 + 1
    ReadRegStr $R2 HKLM \
      "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R0" "DisplayName"
    ; Compare first 11 chars ("Screen Time") so any version matches
    StrCpy $R4 $R2 11
    StrCmp $R4 "Screen Time" 0 hklm_loop
    ReadRegStr $R3 HKLM \
      "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R0" "UninstallString"
    StrCmp $R3 "" hklm_loop
    ExecWait '$R3 /S'
    Sleep 2000
    GoTo customInitDone
  hklm_done:

  ; ---- 2. Search HKCU (per-user install) ----
  StrCpy $R1 0
  hkcu_loop:
    EnumRegKey $R0 HKCU \
      "Software\Microsoft\Windows\CurrentVersion\Uninstall" $R1
    StrCmp $R0 "" hkcu_done
    IntOp $R1 $R1 + 1
    ReadRegStr $R2 HKCU \
      "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R0" "DisplayName"
    StrCpy $R4 $R2 11
    StrCmp $R4 "Screen Time" 0 hkcu_loop
    ReadRegStr $R3 HKCU \
      "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R0" "UninstallString"
    StrCmp $R3 "" hkcu_loop
    ExecWait '$R3 /S'
    Sleep 2000
    GoTo customInitDone
  hkcu_done:

  ; ---- 3. Last-resort: well-known file-system paths ----
  StrCpy $R0 "$PROGRAMFILES64\Screen Time\Uninstall Screen Time.exe"
  ${If} ${FileExists} "$R0"
    ExecWait '"$R0" /S /allusers'
    Sleep 2000
    GoTo customInitDone
  ${EndIf}
  StrCpy $R0 "$LOCALAPPDATA\Programs\Screen Time\Uninstall Screen Time.exe"
  ${If} ${FileExists} "$R0"
    ExecWait '"$R0" /S'
    Sleep 2000
  ${EndIf}

  customInitDone:
!macroend

!macro customInstall
  ; Register autostart at install time so 24/7 tracking begins on next login.
  WriteRegStr HKCU \
    "Software\Microsoft\Windows\CurrentVersion\Run" \
    "Screen Time" \
    '"$INSTDIR\Screen Time.exe" --hidden'
!macroend

!macro customUnInstall
  ; Remove autostart on uninstall.
  DeleteRegValue HKCU \
    "Software\Microsoft\Windows\CurrentVersion\Run" \
    "Screen Time"
!macroend
