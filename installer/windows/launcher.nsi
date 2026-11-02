; Pluck.exe: opens Pluck without a console window. Made by Matte Black.
; Built by build.sh. Needs -DVERSION=x.y.z -DBUILD=<staging folder>.

Target amd64-unicode
SetCompressor /SOLID lzma
Name "Pluck"
OutFile "${BUILD}\Pluck.exe"
Icon "${__FILEDIR__}\Pluck.ico"
SilentInstall silent
RequestExecutionLevel user
ManifestDPIAware true

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Pluck"
VIAddVersionKey "FileDescription" "Pluck"
VIAddVersionKey "CompanyName" "Matte Black"
VIAddVersionKey "LegalCopyright" "Made by Matte Black"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

Section
  IfFileExists "$EXEDIR\bin\deno.exe" found
    MessageBox MB_ICONEXCLAMATION "Pluck is missing some of its files. Download Pluck again and run the installer to fix it."
    Quit
  found:
  System::Call 'Kernel32::SetEnvironmentVariable(t "DENO_NO_UPDATE_CHECK", t "1")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "DENO_DIR", t "$EXEDIR\cache\deno")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "PLUCK_ROOT", t "$EXEDIR")i'
  SetOutPath "$EXEDIR"
  ExecShell "open" "$EXEDIR\bin\deno.exe" 'run -A --no-prompt --no-config "$EXEDIR\bundle\launch.ts"' SW_HIDE
SectionEnd
