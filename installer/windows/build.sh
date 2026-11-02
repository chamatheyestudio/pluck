#!/usr/bin/env bash
# Builds Pluck-Setup.exe. Runs on Linux or macOS with NSIS installed (apt install nsis / brew install makensis).
# Usage: installer/windows/build.sh [OUT_DIR]     (DENO_VERSION=v2.x.y to pin Deno, default latest)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="$(mkdir -p "${1:-$REPO/dist}" && cd "${1:-$REPO/dist}" && pwd)"
VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$REPO/app/version.json")"
DENO="${DENO_VERSION:-latest}"
B="$HERE/build"

rm -rf "$B"; mkdir -p "$B/bundle" "$B/bin"
cp -R "$REPO/app" "$B/bundle/app"
cp "$REPO/shell/launch.ts" "$B/bundle/launch.ts"

if [ "$DENO" = "latest" ]; then URL="https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip"
else URL="https://github.com/denoland/deno/releases/download/$DENO/deno-x86_64-pc-windows-msvc.zip"; fi
curl -fsSL --retry 3 -o "$B/deno.zip" "$URL"
unzip -q -o "$B/deno.zip" deno.exe -d "$B/bin"
rm -f "$B/deno.zip"

makensis -V2 -DVERSION="$VERSION" -DBUILD="$B" "$HERE/launcher.nsi"
makensis -V2 -DVERSION="$VERSION" -DBUILD="$B" -DOUT="$OUT" "$HERE/installer.nsi"
rm -rf "$B"
echo "Built $OUT/Pluck-Setup.exe ($VERSION)"
