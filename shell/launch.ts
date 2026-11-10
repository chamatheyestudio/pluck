// Pluck launcher. Made by Matte Black.
//
// Ships inside the installed app (the Mac bundle, or the Windows install folder) and is never
// replaced by the auto updater. It picks the newest good copy of the Pluck app (the installed one,
// a staged update, or the copy that came with the installer), puts it in place and starts it.
// If a new version fails to start, it rolls back and remembers not to install that version again.
//
// Bump SHELL only when the app needs something new from the launcher or installer. Releases whose
// app/version.json "shell" is higher than this tell people to download the new installer instead.

const SHELL = 2;
const PORT = Number(Deno.env.get("PLUCK_PORT") ?? 47821);
const isWin = Deno.build.os === "windows";
const isMac = Deno.build.os === "darwin";
const SEP = isWin ? "\\" : "/";
const HOME = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
const HERE = import.meta.dirname ?? ".";
const ROOT = Deno.env.get("PLUCK_ROOT") || defaultRoot();
const BUNDLED = Deno.env.get("PLUCK_BUNDLED") || join(HERE, "app");
const LIVE = join(ROOT, "app");
const OLD = join(ROOT, "app.old");
const INCOMING = join(ROOT, "app.incoming");
const NEXT = join(ROOT, "update", "next");
const BAD = join(ROOT, "update", "bad.json");
const RESTART = Deno.env.get("PLUCK_RESTART") === "1";

function defaultRoot(): string {
  if (isMac) return join(HOME, "Library", "Application Support", "Pluck");
  if (isWin) return join(Deno.env.get("LOCALAPPDATA") ?? join(HOME, "AppData", "Local"), "Pluck");
  return join(Deno.env.get("XDG_DATA_HOME") ?? join(HOME, ".local", "share"), "pluck");
}
function join(...p: string[]): string { return p.filter((x) => x !== "").join(SEP); }
function exists(p: string): boolean { try { Deno.statSync(p); return true; } catch { return false; } }
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function log(...a: unknown[]) {
  const line = new Date().toISOString() + " launcher " + a.map((x) => (x instanceof Error ? x.message : typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n";
  try { Deno.writeTextFileSync(join(ROOT, "pluck.log"), line, { append: true }); } catch { /* ignore */ }
}

function version(dir: string): string | null {
  try {
    const v = JSON.parse(Deno.readTextFileSync(join(dir, "version.json"))).version;
    return typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v) ? v : null;
  } catch { return null; }
}
function valid(dir: string): boolean { return version(dir) !== null && exists(join(dir, "server.ts")) && exists(join(dir, "ui", "index.html")); }
function cmp(a: string, b: string): number {
  const x = a.split("."), y = b.split(".");
  for (let i = 0; i < 3; i++) { const d = (parseInt(x[i]) || 0) - (parseInt(y[i]) || 0); if (d) return Math.sign(d); }
  return 0;
}
function badList(): string[] { try { const l = JSON.parse(Deno.readTextFileSync(BAD)); return Array.isArray(l) ? l.map(String) : []; } catch { return []; } }
function markBad(v: string) {
  const l = badList();
  if (l.includes(v)) return;
  l.push(v);
  try { Deno.mkdirSync(join(ROOT, "update"), { recursive: true }); Deno.writeTextFileSync(BAD, JSON.stringify(l)); } catch { /* ignore */ }
}

async function portFree(): Promise<boolean> {
  try { const l = Deno.listen({ hostname: "127.0.0.1", port: PORT }); l.close(); return true; } catch { return false; }
}
async function retry<T>(f: () => Promise<T>, n = 6): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await f(); } catch (e) { if (i >= n) throw e; await sleep(250 * (i + 1)); }
  }
}
async function rmrf(p: string) { try { await Deno.remove(p, { recursive: true }); } catch { /* already gone */ } }
async function copyDir(src: string, dst: string) {
  await Deno.mkdir(dst, { recursive: true });
  for await (const e of Deno.readDir(src)) {
    const s = join(src, e.name), d = join(dst, e.name);
    if (e.isDirectory) await copyDir(s, d);
    else if (e.isFile) await retry(() => Deno.copyFile(s, d));
  }
}

// Put `src` in place as the live app. A staged update can be moved; the bundled copy is copied.
async function install(src: string, move: boolean) {
  await rmrf(INCOMING);
  if (move) { try { await retry(() => Deno.rename(src, INCOMING), 3); } catch { await copyDir(src, INCOMING); } }
  else await copyDir(src, INCOMING);
  if (!valid(INCOMING)) throw new Error("the new app copy is incomplete");
  await rmrf(OLD);
  if (exists(LIVE)) {
    try { await retry(() => Deno.rename(LIVE, OLD)); }
    catch {
      // Something holds the folder open (antivirus, usually). Keep a backup and write over it instead.
      await copyDir(LIVE, OLD).catch(() => {});
      await copyDir(INCOMING, LIVE);
      await rmrf(INCOMING);
      return;
    }
  }
  try { await retry(() => Deno.rename(INCOMING, LIVE)); }
  catch (e) { if (!exists(LIVE) && exists(OLD)) await Deno.rename(OLD, LIVE).catch(() => {}); throw e; }
}

function fileUrl(p: string): string {
  let s = p.replace(/\\/g, "/");
  if (!s.startsWith("/")) s = "/" + s;
  return "file://" + encodeURI(s).replace(/[?#]/g, (c) => encodeURIComponent(c));
}

async function alert(message: string) {
  try {
    if (isMac) await new Deno.Command("/usr/bin/osascript", { args: ["-e", `display alert "Pluck couldn't start" message ${JSON.stringify(message)} as critical`], stdout: "null", stderr: "null" }).output();
    else if (isWin) {
      const ps = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(${"'" + message.replace(/'/g, "''") + "'"}, 'Pluck') | Out-Null`;
      const units = new Uint16Array(ps.length);
      for (let i = 0; i < ps.length; i++) units[i] = ps.charCodeAt(i);
      const b64 = btoa(Array.from(new Uint8Array(units.buffer), (b) => String.fromCharCode(b)).join(""));
      await new Deno.Command("powershell", { args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", b64], stdout: "null", stderr: "null" }).output();
    }
  } catch { /* nothing else we can do */ }
}

// ---------------------------------------------------------------- go

Deno.env.set("PLUCK_ROOT", ROOT);
Deno.env.set("PLUCK_SHELL", String(SHELL));
Deno.env.set("PLUCK_LAUNCHER", import.meta.filename ?? join(HERE, "launch.ts"));
try { Deno.mkdirSync(ROOT, { recursive: true }); Deno.chdir(ROOT); } catch { /* ignore */ }

// After "Restart to update", wait for the old copy to let go of the port.
if (RESTART) for (let i = 0; i < 60 && !(await portFree()); i++) await sleep(250);

// Only touch the app folder when no other Pluck is running.
if (await portFree()) {
  try {
    const bad = badList();
    const found: { dir: string; v: string; rank: number }[] = [];
    if (valid(LIVE)) found.push({ dir: LIVE, v: version(LIVE)!, rank: 0 });
    if (valid(NEXT) && !bad.includes(version(NEXT)!)) found.push({ dir: NEXT, v: version(NEXT)!, rank: 1 });
    if (valid(BUNDLED)) found.push({ dir: BUNDLED, v: version(BUNDLED)!, rank: 2 });
    found.sort((a, b) => cmp(b.v, a.v) || a.rank - b.rank);
    const best = found[0];
    if (best && best.dir !== LIVE) {
      log("installing", best.rank === 1 ? "update" : "bundled app", best.v, "over", version(LIVE) ?? "nothing");
      await install(best.dir, best.rank === 1);
    }
  } catch (e) { log("could not put the newest app in place", e); }
  if (exists(NEXT)) {
    const nv = version(NEXT), lv = version(LIVE);
    if (!valid(NEXT) || !nv || (lv && cmp(nv, lv) <= 0)) await rmrf(NEXT);
  }
  await rmrf(INCOMING);
}

// A failed import stays cached under its URL, so every attempt gets its own.
let attempt = 0;
async function start(dir: string) {
  await import(fileUrl(join(dir, "server.ts")) + (attempt++ ? `?attempt=${attempt}` : ""));
}

try {
  if (!valid(LIVE)) throw new Error("no installed app");
  await start(LIVE);
} catch (e) {
  const v = version(LIVE);
  log("app failed to start", v ?? "missing", e);
  if (!(await portFree())) {
    // The server got far enough to open its port, so it is running. Leave it be.
  } else {
    const bv = version(BUNDLED);
    if (v && bv && cmp(v, bv) > 0) markBad(v);
    let ok = false;
    for (const src of [OLD, BUNDLED]) {
      const sv = version(src);
      if (!valid(src) || !sv || (v && sv === v)) continue;
      try {
        log("rolling back to", sv);
        if (src === OLD) { await rmrf(LIVE); await retry(() => Deno.rename(OLD, LIVE)).catch(() => copyDir(OLD, LIVE)); }
        else { await rmrf(LIVE); await copyDir(BUNDLED, LIVE); }
        await start(LIVE);
        ok = true;
        break;
      } catch (e2) { log("rollback failed", e2); }
    }
    if (!ok && valid(BUNDLED)) {
      try { await start(BUNDLED); ok = true; } catch (e3) { log("bundled app failed too", e3); }
    }
    if (!ok) {
      await alert("Something went wrong while starting. Please download Pluck again and reinstall it. Your downloads and settings are safe.");
      Deno.exit(1);
    }
  }
}
