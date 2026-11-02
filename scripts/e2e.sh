#!/usr/bin/env bash
# End to end check of an installed Pluck: waits for first run setup, then downloads a test video and photo.
# Usage: scripts/e2e.sh PLUCK_ROOT     (Pluck must already be started with PLUCK_NO_WINDOW=1 PLUCK_NO_EXIT=1)
set -euo pipefail
ROOT="$1"
API=http://127.0.0.1:47821
H=(-H "content-type: application/json" -H "x-pluck: 1")
PY=python3; "$PY" -c "print(1)" > /dev/null 2>&1 || PY=python
py() { "$PY" -c "$@"; }
state() { curl -sf "$API/api/state"; }

echo "Waiting for Pluck"
for i in $(seq 1 60); do state > /dev/null && break; sleep 2; done
state | py 'import json,sys; d=json.load(sys.stdin); print("Pluck", d["version"], "on", d["os"], "launcher", d["shell"])'

echo "Waiting for first run setup"
for i in $(seq 1 150); do
  s=$(state | py 'import json,sys; d=json.load(sys.stdin)["setup"]; print(d["state"], " ".join("%s=%s:%d%%" % (x["id"], x["state"], x["pct"] * 100) for x in d["steps"]))')
  case "$s" in running*) sleep 3 ;; *) break ;; esac
done
echo "$s"
case "$s" in ready*) ;; *) echo "::error::setup did not finish: $s"; cat "$ROOT/pluck.log"; exit 1 ;; esac
sleep 6
state | py 'import json,sys; print("engines", json.load(sys.stdin)["update"]["versions"])'

FF="$ROOT/bin/ffmpeg"; [ -x "$FF" ] || FF="$ROOT/bin/ffmpeg.exe"; [ -x "$FF" ] || FF=ffmpeg
MEDIA="$(mktemp -d)"
"$FF" -loglevel error -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=440 -t 4 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$MEDIA/clip.mp4"
"$FF" -loglevel error -f lavfi -i testsrc2=size=800x800 -frames:v 1 "$MEDIA/pic.jpg"
(cd "$MEDIA" && "$PY" -m http.server 8765 --bind 127.0.0.1 > /dev/null 2>&1 &)
sleep 3

for job in '{"url":"http://127.0.0.1:8765/clip.mp4","mode":"video","quality":"best"}' '{"url":"http://127.0.0.1:8765/clip.mp4","mode":"mp3"}' '{"url":"http://127.0.0.1:8765/pic.jpg","mode":"all"}'; do
  curl -sf "${H[@]}" -d "$job" "$API/api/download" > /dev/null
done
for i in $(seq 1 60); do
  r=$(state | py 'import json,sys; j=json.load(sys.stdin)["jobs"]; print(" ".join(x["status"] for x in j))')
  case "$r" in *running*|*queued*) sleep 2 ;; *) break ;; esac
done
state | py 'import json,sys
for j in json.load(sys.stdin)["jobs"]: print(j["status"], j["mode"], j["files"], j.get("error") or "")'
case "$r" in *error*|*running*|*queued*) echo "::error::downloads did not finish: $r"; cat "$ROOT/pluck.log"; exit 1 ;; esac

curl -sf "${H[@]}" -d '{"openAtLogin":true}' "$API/api/settings" > /dev/null && echo "open at login: on"
curl -sf "${H[@]}" -d '{"openAtLogin":false}' "$API/api/settings" > /dev/null && echo "open at login: off"
echo "--- pluck.log"; cat "$ROOT/pluck.log"
echo "All good"
