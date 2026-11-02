# Pluck: notes for whoever works on this next

Pluck is a free desktop app (Mac and Windows) that downloads from social platforms. It was made for
Athul, who is credited in the app as **Matte Black**. Every theme carries a Matte Black credit with a
joke that fits the theme. Keep it that way.

## How it fits together

- `app/` is the app itself and the only part that auto updates.
  - `server.ts`: a local server (Deno, no imports) on 127.0.0.1:47821 that drives yt-dlp, gallery-dl and ffmpeg,
    downloads those engines on first run, updates them daily, and checks for new Pluck versions.
  - `ui/index.html`: the whole interface in one file, opened in a Chrome or Edge app window.
  - `version.json`: version, release notes shown in "What's new", the update feed URL and the launcher version it needs.
- `shell/launch.ts`: the launcher that ships inside the installers. It picks the newest good copy of the app
  (installed, staged update, or the one bundled with the installer), swaps updates in, and rolls back a version
  that fails to start. It is never auto updated, so keep it small and stable.
- `installer/mac`: `build.sh` (runs on macOS) makes `Pluck.dmg`. The app executable is a tiny C stub that starts
  `launch.sh` in the background, which copies Deno to `~/Library/Application Support/Pluck/bin` and runs the launcher.
- `installer/windows`: `build.sh` (runs on Linux with NSIS) makes `Pluck-Setup.exe`, a per user install in
  `%LOCALAPPDATA%\Pluck`. `Pluck.exe` is an NSIS stub that starts Deno hidden.
- `.github/workflows/release.yml`: builds both installers on every push; on a `v*` tag it also publishes a GitHub
  release with `Pluck.dmg`, `Pluck-Setup.exe`, `app.zip` and `latest.json` (made by `scripts/build-feed.sh`).

## Shipping an update

1. Make the change in `app/`.
2. Bump `version` in `app/version.json` and replace `notes` with a few short lines for "What's new".
3. Commit, then tag and push: `git tag v1.0.1 && git push origin main v1.0.1`.

The workflow publishes the release. Installed copies check `latest.json` a few seconds after opening and every
6 hours, download `app.zip`, verify its sha256, and show "Pluck 1.0.1 is ready · Restart". Otherwise the update
installs the next time Pluck opens. New themes are part of `ui/index.html`, so they ship the same way.

Only bump `shell` in `app/version.json` (and `SHELL` in `shell/launch.ts`) when the app needs something new from
the launcher or installers. Copies with an older launcher are then told to download the new installer instead.

Never change the feed URL in `version.json` or the bundle id `com.matteblack.pluck`: installed copies depend on them.

## Testing locally (Linux works)

```
PLUCK_ROOT=/tmp/pluck PLUCK_BUNDLED=$PWD/app PLUCK_NO_WINDOW=1 PLUCK_NO_EXIT=1 \
  deno run -A --no-prompt --no-config shell/launch.ts
```

Then open http://127.0.0.1:47821/. `PLUCK_FEED` points the updater at a local `latest.json`
(`scripts/build-feed.sh out http://127.0.0.1:8765/out` builds one; plain http is allowed for 127.0.0.1 only).
The launcher only replaces an installed app with a higher version, so bump the version or copy files into
`$PLUCK_ROOT/app` when testing changes. The Windows installer and Pluck itself run under Wine 9 (64 bit).

## Writing for Pluck

- Plain, warm, short. No em dashes and no hyphens in user facing copy.
- Wins and errors in human words ("Couldn't download. Check your internet connection and try again.").
- Each theme has its own voice for status lines (see `THEMES[...].say` in the UI).
