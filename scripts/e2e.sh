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
"$FF" -loglevel error -f lavfi -i testsrc=size=900x600 -frames:v 1 "$MEDIA/pic2.jpg"
"$FF" -loglevel error -f lavfi -i color=c=black:size=32x32 -frames:v 1 "$MEDIA/logo.png"
printf '<html><head><title>Test page</title></head><body><img src="logo.png"><h1>Hello</h1><img src="pic.jpg"><p>Words</p><img src="/pic2.jpg"></body></html>' > "$MEDIA/page.html"
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

echo "Just a part: 2s to 5s of a 12s clip"
"$FF" -loglevel error -f lavfi -i testsrc2=size=640x360:rate=30 -f lavfi -i sine=frequency=330 -t 12 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest -movflags +faststart "$MEDIA/long.mp4"
# long2.mp4 can't be read in pieces from this test server, so Pluck has to fetch it whole and cut it afterwards.
"$FF" -loglevel error -i "$MEDIA/long.mp4" -c copy "$MEDIA/long2.mp4"
printf '<html><head><title>Clip page</title></head><body><a href="long.mp4">Watch the clip</a></body></html>' > "$MEDIA/vpage.html"
FP="$ROOT/bin/ffprobe"; [ -x "$FP" ] || FP="$ROOT/bin/ffprobe.exe"; [ -x "$FP" ] || FP=ffprobe
for c in long.mp4:video long.mp4:mp3 long2.mp4:video long2.mp4:wav vpage.html:video vpage.html:mp3; do
  m="${c#*:}"
  curl -sf "${H[@]}" -d "{\"url\":\"http://127.0.0.1:8765/${c%%:*}\",\"mode\":\"$m\",\"cut\":{\"from\":2,\"to\":5}}" "$API/api/download" > /dev/null
  for i in $(seq 1 60); do
    r=$(state | py 'import json,sys; j=json.load(sys.stdin)["jobs"][0]; print(j["status"], j["files"][0] if j["files"] else "", j.get("error") or "")')
    case "$r" in running*|queued*) sleep 2 ;; *) break ;; esac
  done
  f=$(state | py 'import json,sys; j=json.load(sys.stdin)["jobs"][0]; print(j["files"][0] if j["files"] else "")')
  d=$("$FP" -v error -show_entries format=duration -of csv=p=0 "$f" 2>/dev/null || echo 0)
  echo "part $c: $r ($d s)"
  case "$r" in done*) ;; *) echo "::error::part download gave: $r"; cat "$ROOT/pluck.log"; exit 1 ;; esac
  py "import sys; d=float(sys.argv[1] or 0); sys.exit(0 if 2.5 <= d <= 3.6 else 1)" "$d" || { echo "::error::part $m is $d seconds, expected about 3"; exit 1; }
done

echo "Any web page: photos on a plain page"
p=$(curl -sf "${H[@]}" -d '{"url":"Look at this http://127.0.0.1:8765/page.html"}' "$API/api/probe" | py 'import json,sys; d=json.load(sys.stdin); print(d["engine"], d["kind"], len(d["items"]), d["title"])')
echo "$p"
case "$p" in "gallery gallery 2 "*) ;; *) echo "::error::web page probe gave: $p"; cat "$ROOT/pluck.log"; exit 1 ;; esac
curl -sf "${H[@]}" -d '{"url":"http://127.0.0.1:8765/page.html","mode":"photos"}' "$API/api/download" > /dev/null
for i in $(seq 1 30); do
  r=$(state | py 'import json,sys; j=json.load(sys.stdin)["jobs"][0]; print(j["status"], len(j["files"]), j.get("error") or "")')
  case "$r" in running*|queued*) sleep 2 ;; *) break ;; esac
done
echo "page: $r"
case "$r" in "done 2"*) ;; *) echo "::error::web page download gave: $r"; cat "$ROOT/pluck.log"; exit 1 ;; esac

# Live sites can block CI machines, so these only warn.
for u in https://www.pinterest.com/pin/664281013778109217/ https://www.pinterest.com/pin/1084663891475263837/; do
  p=$(curl -s "${H[@]}" -d "{\"url\":\"$u\"}" "$API/api/probe" | py 'import json,sys; d=json.load(sys.stdin); print(d.get("error") or "%s %s %s %s" % (d["engine"], d["kind"], [i["type"] for i in d["items"]], d["title"][:40]))' || true)
  echo "Pinterest $u: $p"
  case "$p" in gallery*|ytdlp*) ;; *) echo "::warning::Pinterest probe: $p"; continue ;; esac
  curl -sf "${H[@]}" -d "{\"url\":\"$u\",\"mode\":\"video\"}" "$API/api/download" > /dev/null || true
  for i in $(seq 1 60); do
    r=$(state | py 'import json,sys; j=json.load(sys.stdin)["jobs"][0]; print(j["status"], j["files"], j.get("error") or "")')
    case "$r" in running*|queued*) sleep 2 ;; *) break ;; esac
  done
  echo "  download: $r"
  case "$r" in done*) ;; *) echo "::warning::Pinterest download: $r" ;; esac
done

if [ -n "${PLUCK_FEED:-}" ]; then
  echo "Testing an update to 99.0.0"
  REPO="$(cd "$(dirname "$0")/.." && pwd)"
  T="$(mktemp -d)"; cp -R "$REPO/app" "$T/app"
  py 'import json,sys; p=sys.argv[1]; v=json.load(open(p)); v["version"]="99.0.0"; v["notes"]=["Test update"]; json.dump(v, open(p, "w"))' "$T/app/version.json"
  "$REPO/scripts/build-feed.sh" "$MEDIA/upd" "http://127.0.0.1:8765/upd" "$T/app" > /dev/null
  curl -sf "${H[@]}" -d '{}' "$API/api/update" > /dev/null
  for i in $(seq 1 45); do u=$(state | py 'import json,sys; print(json.load(sys.stdin)["app"]["state"])'); [ "$u" = ready ] && break; sleep 2; done
  echo "update: $u"
  [ "$u" = ready ] || { echo "::error::update was not staged"; cat "$ROOT/pluck.log"; exit 1; }
  curl -sf "${H[@]}" -d '{}' "$API/api/restart" > /dev/null
  for i in $(seq 1 45); do v=$(state 2>/dev/null | py 'import json,sys; print(json.load(sys.stdin)["version"])' 2>/dev/null || true); [ "$v" = 99.0.0 ] && break; sleep 2; done
  state | py 'import json,sys; d=json.load(sys.stdin); print("after restart:", d["version"], "news:", d["news"])'
  [ "$v" = 99.0.0 ] || { echo "::error::Pluck did not come back on the new version"; cat "$ROOT/pluck.log"; exit 1; }
fi

curl -sf "${H[@]}" -d '{"openAtLogin":true}' "$API/api/settings" > /dev/null && echo "open at login: on"
curl -sf "${H[@]}" -d '{"openAtLogin":false}' "$API/api/settings" > /dev/null && echo "open at login: off"
echo "--- pluck.log"; cat "$ROOT/pluck.log"
echo "All good"
