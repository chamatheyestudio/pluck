#!/usr/bin/env bash
# Builds Pluck.dmg. Runs on macOS (GitHub's macOS runners build it for every release).
# Usage: installer/mac/build.sh [OUT_DIR]     (DENO_VERSION=v2.x.y to pin Deno, default latest)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="$(mkdir -p "${1:-$REPO/dist}" && cd "${1:-$REPO/dist}" && pwd)"
VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$REPO/app/version.json")"
DENO="${DENO_VERSION:-latest}"
B="$HERE/build"
APP="$B/Pluck.app"
R="$APP/Contents/Resources"

rm -rf "$B"; mkdir -p "$APP/Contents/MacOS" "$R"

# The app's executable: a tiny universal binary that starts launch.sh in the background.
clang -O2 -Wall -mmacosx-version-min=11.0 -arch arm64 -arch x86_64 -o "$APP/Contents/MacOS/Pluck" "$HERE/stub.c"
sed "s/__VERSION__/$VERSION/g" "$HERE/Info.plist" > "$APP/Contents/Info.plist"
printf "APPL????" > "$APP/Contents/PkgInfo"
cp "$HERE/Pluck.icns" "$R/Pluck.icns"
cp "$HERE/launch.sh" "$R/launch.sh"; chmod 755 "$R/launch.sh"
cp "$REPO/shell/launch.ts" "$R/launch.ts"
cp -R "$REPO/app" "$R/app"

# Deno for both kinds of Mac (Apple silicon and Intel). Their own signatures are left untouched.
for pair in aarch64:arm64 x86_64:x64; do
  triple="${pair%%:*}"; arch="${pair##*:}"
  if [ "$DENO" = "latest" ]; then url="https://github.com/denoland/deno/releases/latest/download/deno-$triple-apple-darwin.zip"
  else url="https://github.com/denoland/deno/releases/download/$DENO/deno-$triple-apple-darwin.zip"; fi
  curl -fsSL --retry 3 -o "$B/deno-$arch.zip" "$url"
  mkdir -p "$B/deno-$arch" && unzip -q -o "$B/deno-$arch.zip" deno -d "$B/deno-$arch"
  mv "$B/deno-$arch/deno" "$R/deno-$arch"; chmod 755 "$R/deno-$arch"
done
cat "$R/deno-arm64" "$R/deno-x64" | shasum -a 256 | cut -c1-16 > "$R/deno.stamp"
"$R/deno-$( [ "$(uname -m)" = arm64 ] && echo arm64 || echo x64 )" --version | head -1

# Ad hoc signature so macOS sees one consistent, unmodified app.
codesign --force --sign - "$APP" || echo "warning: ad hoc signing failed"
codesign --verify --verbose=2 "$APP" || true

# Disk image with the drag to Applications window.
rm -f "$OUT/Pluck.dmg"
tiffutil -cathidpicheck "$HERE/dmg-background.png" "$HERE/dmg-background@2x.png" -out "$B/background.tiff"
if python3 -m venv "$B/venv" && "$B/venv/bin/pip" install --quiet "dmgbuild>=1.6" \
  && "$B/venv/bin/dmgbuild" -s "$HERE/dmg-settings.py" -D app="$APP" -D background="$B/background.tiff" -D icon="$HERE/Pluck.icns" "Pluck" "$OUT/Pluck.dmg"; then
  echo "dmgbuild ok"
else
  echo "dmgbuild failed, making a plain disk image instead"
  mkdir -p "$B/dmg" && cp -R "$APP" "$B/dmg/" && ln -s /Applications "$B/dmg/Applications"
  hdiutil create -volname "Pluck" -srcfolder "$B/dmg" -ov -format ULMO "$OUT/Pluck.dmg"
fi
hdiutil verify "$OUT/Pluck.dmg"
rm -rf "$B"
echo "Built $OUT/Pluck.dmg ($VERSION)"
