; bin\engine.exe: starts Pluck's engine (Deno running bundle\launch.ts) with no console window.
; The Pluck window (Pluck.exe, from shell/native) runs this when it opens. Made by Matte Black.
; Built by build.sh. Needs -DVERSION=x.y.z -DBUILD=<staging folder>.

Target amd64-unicode
SetCompressor /SOLID lzma
!include "FileFunc.nsh"
Name "Pluck engine"
OutFile "${BUILD}\engine.exe"
Icon "${__FILEDIR__}\Pluck.ico"
SilentInstall silent
RequestExecutionLevel user
ManifestDPIAware true

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Pluck"
VIAddVersionKey "FileDescription" "Pluck engine"
VIAddVersionKey "CompanyName" "Matte Black"
VIAddVersionKey "LegalCopyright" "Made by Matte Black"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

Section
  ${GetParent} "$EXEDIR" $0
  IfFileExists "$EXEDIR\deno.exe" found
    MessageBox MB_ICONEXCLAMATION "Pluck is missing some of its files. Download Pluck again and run the installer to fix it."
    Quit
  found:
  System::Call 'Kernel32::SetEnvironmentVariable(t "DENO_NO_UPDATE_CHECK", t "1")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "DENO_DIR", t "$0\cache\deno")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "PLUCK_ROOT", t "$0")i'
  SetOutPath "$0"
  ExecShell "open" "$EXEDIR\deno.exe" 'run -A --no-prompt --no-config "$0\bundle\launch.ts"' SW_HIDE
SectionEnd
