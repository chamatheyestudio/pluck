; Pluck installer for Windows. Made by Matte Black.
; Built by build.sh. Needs -DVERSION=x.y.z -DBUILD=<staging folder> -DOUT=<output folder>.
; Installs just for the current user into %LOCALAPPDATA%\Pluck, so no admin password is needed.

Target amd64-unicode
SetCompressor /SOLID lzma
!include "MUI2.nsh"

!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Pluck"
!define RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"

Name "Pluck"
Caption "Pluck ${VERSION}"
OutFile "${OUT}\Pluck-Setup.exe"
InstallDir "$LOCALAPPDATA\Pluck"
RequestExecutionLevel user
ManifestDPIAware true
BrandingText "Made by Matte Black"
ShowInstDetails nevershow
ShowUninstDetails nevershow

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Pluck"
VIAddVersionKey "FileDescription" "Pluck installer"
VIAddVersionKey "CompanyName" "Matte Black"
VIAddVersionKey "LegalCopyright" "Made by Matte Black"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

!define MUI_ICON "${__FILEDIR__}\Pluck.ico"
!define MUI_UNICON "${__FILEDIR__}\Pluck.ico"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${__FILEDIR__}\welcome.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${__FILEDIR__}\welcome.bmp"
!define MUI_WELCOMEPAGE_TITLE "Pluck"
!define MUI_WELCOMEPAGE_TEXT "Download videos, Reels, carousels, stories, photos and music from almost anywhere.$\r$\n$\r$\nPluck installs just for you, so there's no admin password to type. It takes a few seconds.$\r$\n$\r$\nFree, always. Made by Matte Black."
!define MUI_FINISHPAGE_TITLE "Pluck is ready"
!define MUI_FINISHPAGE_TEXT "You'll find Pluck on your desktop and in the Start menu.$\r$\n$\r$\nThe first time it opens, Pluck fetches its download engines. That takes about a minute. After that it keeps itself up to date."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Open Pluck now"
!define MUI_FINISHPAGE_RUN_FUNCTION OpenPluck
!define MUI_UNCONFIRMPAGE_TEXT_TOP "Pluck will be removed from this computer. Everything you downloaded stays where it is."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; Close a running Pluck (its window and its engine) so files can be replaced. Only touches Pluck's own files.
!macro StopPluck
  nsExec::Exec `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-Process deno,pluck -ErrorAction SilentlyContinue | Where-Object { $$_.Path -and $$_.Path.StartsWith((Join-Path $$env:LOCALAPPDATA 'Pluck'), [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force"`
  Pop $0
  Sleep 500
!macroend

Function OpenPluck
  ExecShell "open" "$INSTDIR\Pluck.exe"
FunctionEnd

Section "Pluck"
  SetShellVarContext current
  !insertmacro StopPluck

  ; The launcher and the copy of the app that ships with this installer. The live app in
  ; $INSTDIR\app is managed by the launcher, so auto updates are never undone by a reinstall.
  RMDir /r "$INSTDIR\bundle"
  SetOutPath "$INSTDIR\bundle"
  File /r "${BUILD}\bundle\*.*"
  SetOutPath "$INSTDIR\bin"
  File "${BUILD}\bin\deno.exe"
  File "${BUILD}\engine.exe"
  SetOutPath "$INSTDIR"
  File "${BUILD}\Pluck.exe"
  File "${__FILEDIR__}\Pluck.ico"

  ; Tidy up after the old script installer, keeping "open at startup" if it was on.
  Delete "$INSTDIR\Pluck.vbs"
  IfFileExists "$SMSTARTUP\Pluck.vbs" 0 +3
    Delete "$SMSTARTUP\Pluck.vbs"
    WriteRegStr HKCU "${RUN_KEY}" "Pluck" '"$INSTDIR\Pluck.exe"'

  CreateShortcut "$DESKTOP\Pluck.lnk" "$INSTDIR\Pluck.exe" "" "$INSTDIR\Pluck.ico" 0 SW_SHOWNORMAL "" "Pluck, made by Matte Black"
  CreateShortcut "$SMPROGRAMS\Pluck.lnk" "$INSTDIR\Pluck.exe" "" "$INSTDIR\Pluck.ico" 0 SW_SHOWNORMAL "" "Pluck, made by Matte Black"

  WriteUninstaller "$INSTDIR\Uninstall Pluck.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "Pluck"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "Matte Black"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\Pluck.ico"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall Pluck.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall Pluck.exe" /S'
  WriteRegStr HKCU "${UNINST_KEY}" "URLInfoAbout" "https://github.com/chamatheyestudio/pluck"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" 350000
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  !insertmacro StopPluck
  Delete "$DESKTOP\Pluck.lnk"
  Delete "$SMPROGRAMS\Pluck.lnk"
  Delete "$SMSTARTUP\Pluck.vbs"
  DeleteRegValue HKCU "${RUN_KEY}" "Pluck"
  DeleteRegKey HKCU "${UNINST_KEY}"
  RMDir /r "$INSTDIR"
SectionEnd
