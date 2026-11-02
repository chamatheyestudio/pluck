#!/bin/bash
# Pluck for Mac. Started in the background by the app's executable. Made by Matte Black.
RES="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HOME/Library/Application Support/Pluck"
BIN="$ROOT/bin"
LOG="$ROOT/pluck-run.log"
mkdir -p "$BIN" || exit 1

# Pluck runs on its own copy of Deno, refreshed whenever a new installer brings a new one.
# cat copies only the contents, so no download flags come along with it.
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ]; then SRC="$RES/deno-arm64"; else SRC="$RES/deno-x64"; fi
STAMP="$(cat "$RES/deno.stamp" 2>/dev/null)"
if [ ! -x "$BIN/deno" ] || [ "$(cat "$BIN/deno.stamp" 2>/dev/null)" != "$STAMP" ]; then
  cat "$SRC" > "$BIN/deno.new" && chmod 755 "$BIN/deno.new" && mv -f "$BIN/deno.new" "$BIN/deno" && printf "%s" "$STAMP" > "$BIN/deno.stamp"
fi
xattr -d com.apple.quarantine "$BIN/deno" >/dev/null 2>&1

# The launcher also lives outside the app, so updates still work if Pluck was opened from the disk image.
cmp -s "$RES/launch.ts" "$ROOT/launch.ts" || cp -f "$RES/launch.ts" "$ROOT/launch.ts"

if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 2000000 ]; then mv -f "$LOG" "$LOG.old"; fi

export DENO_NO_UPDATE_CHECK=1 DENO_DIR="$ROOT/cache/deno" PLUCK_ROOT="$ROOT" PLUCK_BUNDLED="$RES/app"
cd "$ROOT" || exit 1
if ! "$BIN/deno" --version >/dev/null 2>&1; then
  /usr/bin/osascript -e 'display alert "Pluck couldn’t start" message "macOS blocked part of Pluck. Drag Pluck to the Trash, download it again and open it from your Applications folder." as critical' >/dev/null 2>&1
  exit 1
fi
exec "$BIN/deno" run -A --no-prompt --no-config "$ROOT/launch.ts" >>"$LOG" 2>&1
