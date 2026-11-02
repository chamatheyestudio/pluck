#!/usr/bin/env bash
# Packs the app into app.zip and writes latest.json, the file every installed Pluck reads to find updates.
# Usage: scripts/build-feed.sh OUT_DIR RELEASE_DOWNLOAD_URL [APP_DIR]
#   e.g. scripts/build-feed.sh dist https://github.com/chamatheyestudio/pluck/releases/download/v1.0.1
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mkdir -p "$1" && cd "$1" && pwd)"
PY=python3; "$PY" -c "print(1)" > /dev/null 2>&1 || PY=python
"$PY" - "${3:-$REPO/app}" "$OUT" "${2%/}" <<'PYCODE'
import hashlib, json, os, sys, zipfile
app, out, base = sys.argv[1:4]
v = json.load(open(os.path.join(app, "version.json")))
z = os.path.join(out, "app.zip")
with zipfile.ZipFile(z, "w", zipfile.ZIP_DEFLATED) as zf:
    for d, dirs, files in os.walk(app):
        dirs[:] = sorted(x for x in dirs if not x.startswith("."))
        for f in sorted(files):
            if f.startswith("."):
                continue
            p = os.path.join(d, f)
            zf.write(p, os.path.relpath(p, app).replace(os.sep, "/"))
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
PYCODE
