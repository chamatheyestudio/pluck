#!/usr/bin/env bash
# Packs app/ into app.zip and writes latest.json, the file every installed Pluck reads to find updates.
# Usage: scripts/build-feed.sh OUT_DIR RELEASE_DOWNLOAD_URL
#   e.g. scripts/build-feed.sh dist https://github.com/chamatheyestudio/pluck/releases/download/v1.0.1
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mkdir -p "$1" && cd "$1" && pwd)"
BASE="${2%/}"
rm -f "$OUT/app.zip"
(cd "$REPO/app" && zip -q -X -r "$OUT/app.zip" . -x '.*' -x '*/.*')
python3 - "$REPO/app/version.json" "$OUT" "$BASE" <<'PY'
import hashlib, json, os, sys
vf, out, base = sys.argv[1:4]
v = json.load(open(vf))
z = os.path.join(out, "app.zip")
feed = {
    "version": v["version"],
    "shell": v.get("shell", 1),
    "notes": v.get("notes", []),
    "app": {"url": f"{base}/app.zip", "sha256": hashlib.sha256(open(z, "rb").read()).hexdigest(), "size": os.path.getsize(z)},
    "downloads": {"mac": f"{base}/Pluck.dmg", "windows": f"{base}/Pluck-Setup.exe"},
    "page": base.replace("/releases/download/", "/releases/tag/"),
}
with open(os.path.join(out, "latest.json"), "w") as f:
    json.dump(feed, f, indent=2)
print(json.dumps(feed, indent=2))
PY
