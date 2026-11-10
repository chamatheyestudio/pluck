// Pluck engine. Made by Matte Black.
// Runs a tiny local server for the Pluck window and drives yt-dlp, gallery-dl and ffmpeg.

const PORT = Number(Deno.env.get("PLUCK_PORT") ?? 47821);
const OS = Deno.build.os;
const isWin = OS === "windows";
const isMac = OS === "darwin";
const SEP = isWin ? "\\" : "/";
const HOME = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
const APP_DIR = import.meta.dirname ?? ".";
const ROOT = Deno.env.get("PLUCK_ROOT") ?? parent(APP_DIR);
const BIN = join(ROOT, "bin");
const NO_WINDOW = !!Deno.env.get("PLUCK_NO_WINDOW");
// Started by the native Pluck app, which shows the window itself.
const NATIVE = !!Deno.env.get("PLUCK_NATIVE");
const NO_EXIT = !!Deno.env.get("PLUCK_NO_EXIT");
const RESTARTED = Deno.env.get("PLUCK_RESTART") === "1";
// Set by the launcher that ships with the installer (shell/launch.ts). 0 means Pluck was started some other way.
const SHELL = Number(Deno.env.get("PLUCK_SHELL") ?? 0) || 0;
const VINFO: { version: string; shell: number; feed: string; notes: string[] } = (() => {
  const d = { version: "0.0.0", shell: 1, feed: "", notes: [] as string[] };
  try { return { ...d, ...JSON.parse(Deno.readTextFileSync(join(APP_DIR, "version.json"))) }; } catch { return d; }
})();
const VERSION = VINFO.version;
const FEED = Deno.env.get("PLUCK_FEED") ?? VINFO.feed;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const startedAt = Date.now();

// ---------------------------------------------------------------- helpers

function join(...p: string[]): string { return p.filter((x) => x !== "").join(SEP); }
function parent(p: string): string { return p.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, "") || p; }
function base(p: string): string { return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p; }
function exists(p: string): boolean { try { Deno.statSync(p); return true; } catch { return false; } }
function ext(p: string): string { const m = base(p).match(/\.([A-Za-z0-9]+)$/); return m ? m[1].toLowerCase() : ""; }
function stem(p: string): string { return base(p).replace(/\.[A-Za-z0-9]+$/, ""); }
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function uid() { return Math.random().toString(36).slice(2, 10); }

function safeName(s: string, max = 110): string {
  let n = (s || "Untitled").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[\\/:*?"<>|#%]/g, " ").replace(/\s+/g, " ").trim();
  n = n.replace(/^[.\s]+|[.\s]+$/g, "");
  if (n.length > max) n = n.slice(0, max).trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n)) n = "_" + n;
  return n || "Untitled";
}

function uniquePath(dir: string, name: string, extension: string): string {
  let p = join(dir, `${name}.${extension}`);
  let i = 2;
  while (exists(p)) { p = join(dir, `${name} (${i}).${extension}`); i++; }
  return p;
}

async function moveFile(src: string, dest: string) {
  try { await Deno.rename(src, dest); }
  catch { await Deno.copyFile(src, dest); try { await Deno.remove(src); } catch { /* ignore */ } }
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      const p = join(dir, e.name);
      if (e.isDirectory) out.push(...(await listFiles(p)));
      else if (e.isFile && !/\.(part|ytdl|tmp|json|txt)$/i.test(e.name)) out.push(p);
    }
  } catch { /* ignore */ }
  return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

// ---------------------------------------------------------------- tools

type Tool = { cmd: string; pre: string[] };

function tool(name: string): Tool {
  const exe = join(BIN, name + (isWin ? ".exe" : ""));
  if (exists(exe)) return { cmd: exe, pre: [] };
  if (name === "gallery-dl") {
    const py = isWin ? join(ROOT, "python", "python.exe") : join(ROOT, "python", "bin", "python3");
    if (exists(py)) return { cmd: py, pre: ["-m", "gallery_dl"] };
  }
  return { cmd: name, pre: [] };
}
const ytdlp = () => tool("yt-dlp");
const gallerydl = () => tool("gallery-dl");
const ffmpeg = () => tool("ffmpeg");
const ffprobeT = () => tool("ffprobe");
function ffDir(): string | null { const f = ffmpeg().cmd; return f.includes(SEP) ? parent(f) : null; }

type RunOpts = { onLine?: (l: string) => void; job?: Job; timeoutMs?: number; capture?: boolean; env?: Record<string, string> };
type RunResult = { code: number; out: string; err: string; tail: string[] };

function killTree(child: Deno.ChildProcess) {
  try {
    if (isWin) new Deno.Command("taskkill", { args: ["/PID", String(child.pid), "/T", "/F"], stdout: "null", stderr: "null" }).spawn();
    else { try { new Deno.Command("pkill", { args: ["-TERM", "-P", String(child.pid)], stdout: "null", stderr: "null" }).spawn(); } catch { /* ignore */ } child.kill("SIGTERM"); }
  } catch { /* ignore */ }
}

async function run(t: Tool, args: string[], o: RunOpts = {}): Promise<RunResult> {
  const env: Record<string, string> = { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", ...(o.env ?? {}) };
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(t.cmd, { args: [...t.pre, ...args], stdout: "piped", stderr: "piped", stdin: "null", env }).spawn();
  } catch (e) {
    return { code: -1, out: "", err: String(e), tail: [String(e)] };
  }
  if (o.job) o.job.procs.add(child);
  const timer = o.timeoutMs ? setTimeout(() => killTree(child), o.timeoutMs) : undefined;
  const tail: string[] = [];
  let out = "";
  let err = "";
  const pump = async (stream: ReadableStream<Uint8Array>, isOut: boolean) => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of stream) {
      const s = dec.decode(chunk, { stream: true });
      if (isOut && o.capture) { out += s; continue; }
      if (!isOut) { err += s; if (err.length > 400000) err = err.slice(-200000); }
      buf += s;
      let i;
      while ((i = buf.search(/[\r\n]/)) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) { tail.push(line); if (tail.length > 400) tail.shift(); try { o.onLine?.(line); } catch { /* ignore */ } }
      }
    }
    if (buf.trim()) { tail.push(buf); try { o.onLine?.(buf); } catch { /* ignore */ } }
  };
  await Promise.all([pump(child.stdout, true), pump(child.stderr, false)]);
  const st = await child.status;
  if (timer) clearTimeout(timer);
  if (o.job) o.job.procs.delete(child);
  return { code: st.code, out, err, tail };
}

// ---------------------------------------------------------------- settings

type Settings = {
  theme: string | null; outDir: string; askEachTime: boolean; ownFolders: boolean; openAtLogin: boolean;
  music: boolean; sfx: boolean; browser: string; lastUpdate: number; lastVersion: string | null;
};
const SETTINGS_FILE = join(ROOT, "settings.json");
let settings!: Settings;

async function documentsDir(): Promise<string> {
  if (isWin) {
    const r = await run({ cmd: "powershell", pre: [] }, ["-NoProfile", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetFolderPath('MyDocuments')"], { capture: true, timeoutMs: 15000 });
    const p = r.out.trim();
    if (p) return p;
  }
  return join(HOME, "Documents");
}

async function loadSettings() {
  let s: Partial<Settings> = {};
  try { s = JSON.parse(await Deno.readTextFile(SETTINGS_FILE)); } catch { /* first run */ }
  settings = {
    theme: s.theme ?? null,
    outDir: s.outDir || join(await documentsDir(), "Pluck"),
    askEachTime: s.askEachTime ?? false,
    ownFolders: s.ownFolders ?? true,
    openAtLogin: s.openAtLogin ?? false,
    music: s.music ?? true,
    sfx: s.sfx ?? true,
    browser: s.browser ?? "auto",
    lastUpdate: s.lastUpdate ?? 0,
    lastVersion: s.lastVersion ?? null,
  };
}
async function saveSettings() {
  try { await Deno.mkdir(ROOT, { recursive: true }); await Deno.writeTextFile(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch (e) { log("settings save failed", e); }
}

const LOG_FILE = join(ROOT, "pluck.log");
function log(...a: unknown[]) {
  const line = new Date().toISOString() + " " + a.map((x) => (typeof x === "string" ? x : JSON.stringify(String(x)))).join(" ") + "\n";
  try { Deno.writeTextFileSync(LOG_FILE, line, { append: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- browsers (for sign in cookies)

let browserCache: string[] | null = null;
function detectBrowsers(): string[] {
  if (browserCache) return browserCache;
  const found: string[] = [];
  const has = (...paths: string[]) => paths.some((p) => p && exists(p));
  if (isMac) {
    const apps = ["/Applications", join(HOME, "Applications")];
    const app = (n: string) => apps.map((a) => join(a, n));
    if (has(...app("Google Chrome.app"))) found.push("chrome");
    if (has(...app("Brave Browser.app"))) found.push("brave");
    if (has(...app("Microsoft Edge.app"))) found.push("edge");
    if (has(...app("Firefox.app"))) found.push("firefox");
    found.push("safari");
  } else if (isWin) {
    const pf = Deno.env.get("ProgramFiles") ?? "C:\\Program Files";
    const pf86 = Deno.env.get("ProgramFiles(x86)") ?? "C:\\Program Files (x86)";
    const la = Deno.env.get("LOCALAPPDATA") ?? "";
    const ad = Deno.env.get("APPDATA") ?? "";
    if (has(join(ad, "Mozilla", "Firefox", "Profiles"))) found.push("firefox");
    if (has(join(pf, "Google", "Chrome", "Application", "chrome.exe"), join(pf86, "Google", "Chrome", "Application", "chrome.exe"), join(la, "Google", "Chrome", "Application", "chrome.exe"))) found.push("chrome");
    if (has(join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"), join(pf, "Microsoft", "Edge", "Application", "msedge.exe"))) found.push("edge");
    if (has(join(la, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"), join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"))) found.push("brave");
  } else {
    if (has(join(HOME, ".mozilla", "firefox"))) found.push("firefox");
    if (has(join(HOME, ".config", "google-chrome"))) found.push("chrome");
    if (has(join(HOME, ".config", "chromium"))) found.push("chromium");
  }
  browserCache = found;
  return found;
}
function cookieBrowsers(): string[] {
  if (settings.browser === "off") return [];
  if (settings.browser && settings.browser !== "auto") return [settings.browser];
  return detectBrowsers();
}

// ---------------------------------------------------------------- platform detection

// The link inside whatever was pasted, so "Look at this https://pin.it/abc" works too.
function pickUrl(raw: string): string {
  const t = raw.trim();
  const m = t.match(/https?:\/\/[^\s<>"']+/i) ?? t.match(/(?:^|\s)((?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>"']*)/i);
  const u = (m ? (m[1] ?? m[0]) : t).trim().replace(/[)\].,!?;:'"]+$/, "");
  return /^https?:\/\//i.test(u) ? u : "https://" + u;
}

type Platform = { id: string; name: string; sub: string };
function detect(raw: string): Platform {
  let u: URL;
  try { u = new URL(raw); } catch { return { id: "web", name: "Web", sub: "" }; }
  const h = u.hostname.toLowerCase().replace(/^(www|m|mobile|web)\./, "");
  const p = u.pathname;
  const is = (...d: string[]) => d.some((x) => h === x || h.endsWith("." + x));
  if (is("youtube.com", "youtu.be", "youtube-nocookie.com")) {
    const sub = h.startsWith("music.") ? "Music" : p.startsWith("/shorts/") ? "Short" : (u.searchParams.get("list") && !u.searchParams.get("v")) ? "Playlist" : "Video";
    return { id: "youtube", name: "YouTube", sub };
  }
  if (is("instagram.com", "instagr.am")) {
    const sub = p.includes("/stories/highlights/") || p.includes("/s/") ? "Highlight" : p.includes("/stories/") ? "Story" : (p.includes("/reel/") || p.includes("/reels/")) ? "Reel" : p.includes("/p/") ? "Post" : p.includes("/tv/") ? "Video" : "Profile";
    return { id: "instagram", name: "Instagram", sub };
  }
  if (is("tiktok.com")) return { id: "tiktok", name: "TikTok", sub: p.includes("/photo/") ? "Photos" : p.includes("/video/") || h.startsWith("vm.") || h.startsWith("vt.") ? "Video" : "Profile" };
  if (is("x.com", "twitter.com", "fxtwitter.com", "vxtwitter.com")) return { id: "x", name: "X", sub: p.includes("/status/") ? "Post" : "Profile" };
  if (is("facebook.com", "fb.watch", "fb.com")) return { id: "facebook", name: "Facebook", sub: p.includes("/reel") ? "Reel" : p.includes("/photo") ? "Photo" : "Video" };
  if (is("spotify.com")) { const m = p.match(/\/(track|album|playlist|artist|episode|show)\//); return { id: "spotify", name: "Spotify", sub: m ? m[1][0].toUpperCase() + m[1].slice(1) : "Link" }; }
  if (is("soundcloud.com")) return { id: "soundcloud", name: "SoundCloud", sub: p.includes("/sets/") ? "Playlist" : "Track" };
  if (is("vimeo.com")) return { id: "vimeo", name: "Vimeo", sub: "Video" };
  if (is("reddit.com", "redd.it")) return { id: "reddit", name: "Reddit", sub: "Post" };
  if (is("pinterest.com", "pin.it") || /(^|\.)pinterest\./.test(h)) {
    const seg = p.split("/").filter(Boolean);
    const sub = h === "pin.it" || seg[0] === "pin" ? "Pin" : seg[0] === "search" ? "Search" : seg.length >= 2 ? "Board" : seg.length === 1 ? "Profile" : "Pin";
    return { id: "pinterest", name: "Pinterest", sub };
  }
  if (is("threads.net", "threads.com")) return { id: "threads", name: "Threads", sub: "Post" };
  if (is("linkedin.com")) return { id: "linkedin", name: "LinkedIn", sub: "Post" };
  if (is("snapchat.com")) return { id: "snapchat", name: "Snapchat", sub: "Spotlight" };
  if (is("twitch.tv")) return { id: "twitch", name: "Twitch", sub: p.includes("/clip") || h.startsWith("clips.") ? "Clip" : "Video" };
  if (is("dailymotion.com", "dai.ly")) return { id: "dailymotion", name: "Dailymotion", sub: "Video" };
  if (is("tumblr.com")) return { id: "tumblr", name: "Tumblr", sub: "Post" };
  if (is("bandcamp.com")) return { id: "bandcamp", name: "Bandcamp", sub: p.includes("/album/") ? "Album" : "Track" };
  if (is("bsky.app")) return { id: "bluesky", name: "Bluesky", sub: "Post" };
  if (is("imgur.com")) return { id: "imgur", name: "Imgur", sub: "Post" };
  if (is("flickr.com")) return { id: "flickr", name: "Flickr", sub: "Photo" };
  return { id: "web", name: h || "Web", sub: "" };
}
const GALLERY_FIRST = new Set(["instagram", "x", "pinterest", "tumblr", "threads", "bluesky", "imgur", "flickr"]);

// ---------------------------------------------------------------- errors

class Friendly extends Error {}
const RETRYABLE = /403|Forbidden|Sign in|sign-in|login|log in|not a bot|Requested format is not available|PO Token|rate.?limit|private|cookie|authenticat|401|429|empty media|Unable to extract|No video formats|checkpoint|challenge|redirect|HTTP Error|keyring|Safe Storage|database|Full Disk/i;

function friendly(raw: string): string {
  const r = raw || "";
  if (/Unsupported URL|No suitable extractor|is not a valid URL|unsupported/i.test(r)) return "Couldn't find a video or photo on that page. Check it opens in your browser, then copy the link to the post itself.";
  if (/DRM/i.test(r)) return "This one is protected (DRM), so it can't be saved.";
  if (/\b404\b|Not Found|does not exist|has been removed/i.test(r)) return "That page doesn't exist anymore, or it was taken down. Check the link and try again.";
  if (/429|rate.?limit|Too Many Requests/i.test(r)) return "The site is slowing Pluck down for a bit. Wait a few minutes and try again.";
  if (/private|login|log in|sign in|authenticat|cookies|checkpoint|401|not a bot/i.test(r)) return "This one needs you signed in. In Settings, pick the browser where you're logged in to this site, then try again.";
  if (/403|Forbidden/i.test(r)) return "The site blocked this download. Pluck will update itself; press Check now in Settings and try again in a few minutes.";
  if (/no video|There is no video|No media|nothing to download|No results|empty/i.test(r)) return "Nothing to save at that link. It may be deleted, private or a text only post.";
  if (/getaddrinfo|Network is unreachable|timed out|Connection|resolve host|Temporary failure/i.test(r)) return "Couldn't reach the site. Check your internet connection.";
  if (/No space|Permission denied|Access is denied|Read-only/i.test(r)) return "Couldn't write the file. Check the save folder has space and Pluck can write to it.";
  const lines = r.split(/\r?\n/).filter((l) => l.trim());
  const line = [...lines].reverse().find((l) => /ERROR|error/i.test(l)) ?? lines.pop() ?? "";
  return line.replace(/^.*?ERROR:\s*(\[[^\]]*\]\s*)?/i, "").replace(/^\[[^\]]*\]\s*/, "").slice(0, 220) || "Something went wrong. Try again.";
}

// ---------------------------------------------------------------- probe

type Item = { i: number; type: "photo" | "video" | "audio"; title?: string; thumb?: string; dur?: number; w?: number; h?: number; artist?: string; ytId?: string; src?: string };
type Info = {
  url: string; platform: Platform; engine: "ytdlp" | "gallery" | "spotify"; kind: "video" | "audio" | "photo" | "gallery" | "music";
  title: string; author: string; thumb: string; duration: number; maxHeight: number; items: Item[]; album?: string; attempt: number; note?: string;
};
const probeCache = new Map<string, Info>();

function ytAttempts(platform: string): string[][] {
  const a: string[][] = [[]];
  if (platform === "youtube") {
    a.push(["--extractor-args", "youtube:player_client=default,visionos,web_embedded,mweb"]);
    a.push(["--extractor-args", "youtube:player_client=visionos,web_embedded"]);
  }
  for (const b of cookieBrowsers()) a.push(["--cookies-from-browser", b]);
  return a;
}
function gdAttempts(platform: string): string[][] {
  const ck = cookieBrowsers().map((b) => ["--cookies-from-browser", b]);
  return platform === "instagram" && ck.length ? [...ck, []] : [[], ...ck];
}
function ytCommon(): string[] {
  const a = ["--no-warnings", "--color", "never", "--js-runtimes", `deno:${Deno.execPath()}`];
  const fd = ffDir();
  if (fd) a.push("--ffmpeg-location", fd);
  return a;
}

function pickThumb(j: any): string {
  if (j?.thumbnail) return j.thumbnail;
  const t = j?.thumbnails;
  if (Array.isArray(t) && t.length) return (t[t.length - 1]?.url) ?? "";
  return "";
}

async function probeYt(url: string, pf: Platform): Promise<Info> {
  const attempts = ytAttempts(pf.id);
  let lastErr = "";
  for (let i = 0; i < attempts.length; i++) {
    const r = await run(ytdlp(), [...ytCommon(), ...attempts[i], "-J", "--flat-playlist", "--no-playlist", "--", url], { capture: true, timeoutMs: 90000 });
    if (r.code === 0 && r.out.trim().startsWith("{")) {
      const j = JSON.parse(r.out);
      return ytInfo(url, pf, j, i);
    }
    const isCookie = attempts[i][0] === "--cookies-from-browser";
    if (!isCookie || !lastErr) lastErr = r.err;
    if (!RETRYABLE.test(r.err) && !isCookie) break;
  }
  throw new Error(lastErr || "probe failed");
}

function ytInfo(url: string, pf: Platform, j: any, attempt: number): Info {
  const isList = j._type === "playlist" || j._type === "multi_video";
  if (isList) {
    const entries = (j.entries ?? []).filter(Boolean);
    const items: Item[] = entries.map((e: any, i: number) => ({
      i, type: (e.vcodec === "none" || pf.id === "soundcloud" || pf.id === "bandcamp") ? "audio" : "video",
      title: e.title ?? `Item ${i + 1}`, dur: e.duration ?? 0,
      thumb: pickThumb(e) || (pf.id === "youtube" && e.id ? `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg` : ""),
    }));
    const allAudio = items.length > 0 && items.every((x) => x.type === "audio");
    return {
      url, platform: pf, engine: "ytdlp", kind: items.length > 1 ? "gallery" : (allAudio ? "audio" : "video"),
      title: j.title ?? "Playlist", author: j.uploader ?? j.channel ?? j.playlist_uploader ?? "", thumb: pickThumb(j) || items[0]?.thumb || "",
      duration: 0, maxHeight: 2160, items, attempt,
    };
  }
  if (IMAGE_EXT.has(String(j.ext ?? "").toLowerCase())) throw new Error("image link");
  const formats: any[] = j.formats ?? [];
  const isV = (f: any) => (f.vcodec && f.vcodec !== "none") || (f.vcodec == null && f.video_ext && f.video_ext !== "none");
  const hasVideo = formats.length ? formats.some(isV) : !!(isV(j) || j.width || j.height);
  const maxHeight = formats.reduce((m, f) => (isV(f) && f.height ? Math.max(m, f.height) : m), 0) || j.height || 0;
  const kind = hasVideo ? "video" : "audio";
  return {
    url, platform: pf, engine: "ytdlp", kind, title: j.title ?? j.fulltitle ?? "Untitled", author: j.uploader ?? j.channel ?? j.creator ?? j.uploader_id ?? "",
    thumb: pickThumb(j), duration: j.duration ?? 0, maxHeight,
    items: [{ i: 0, type: kind === "video" ? "video" : "audio", title: j.title, dur: j.duration ?? 0, thumb: pickThumb(j), w: j.width, h: j.height }], attempt,
  };
}

const VIDEO_EXT = new Set(["mp4", "webm", "mov", "m4v", "mkv", "avi", "m3u8", "ts"]);
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "webp", "gif", "heic", "avif", "bmp"]);
const AUDIO_EXT = new Set(["mp3", "m4a", "aac", "ogg", "opus", "wav", "flac"]);

async function probeGallery(url: string, pf: Platform): Promise<Info> {
  const attempts = gdAttempts(pf.id);
  let lastErr = "";
  for (let i = 0; i < attempts.length; i++) {
    const r = await run(gallerydl(), [...attempts[i], "-J", "--range", "1-80", "--", url], { capture: true, timeoutMs: 120000 });
    let msgs: any = null;
    try { msgs = JSON.parse(r.out); } catch { /* not json */ }
    const files: { u: string; kw: any }[] = [];
    const walk = (m: any) => {
      if (!Array.isArray(m)) return;
      if (m[0] === 3 && typeof m[1] === "string") { files.push({ u: m[1], kw: m[2] ?? {} }); return; }
      for (const x of m) if (Array.isArray(x)) walk(x);
    };
    if (msgs) walk(msgs);
    if (files.length) return galleryInfo(url, pf, files, i);
    const isCookie = attempts[i][0] === "--cookies-from-browser";
    const e = r.err || (r.out.length < 2000 ? r.out : "") || "No media found";
    if (!isCookie || !lastErr) lastErr = e;
    if (!RETRYABLE.test(e) && !isCookie && i > 0) break;
  }
  throw new Error(lastErr || "No media found");
}

function galleryInfo(url: string, pf: Platform, files: { u: string; kw: any }[], attempt: number): Info {
  const items: Item[] = files.map((f, i) => {
    const e = String(f.kw.extension ?? ext(f.u.split("?")[0]) ?? "").toLowerCase();
    const type = VIDEO_EXT.has(e) ? "video" : AUDIO_EXT.has(e) ? "audio" : "photo";
    const thumb = String(type === "photo" ? f.u : (f.kw.display_url ?? f.kw.thumbnail ?? f.kw.preview ?? f.kw.image ?? f.kw.poster ?? f.kw.images?.orig?.url ?? f.kw.images?.["736x"]?.url ?? ""));
    return { i, type, thumb: /^https?:/.test(thumb) ? thumb : "", dur: Number(f.kw.video_duration ?? f.kw.duration ?? 0) || 0, w: f.kw.width, h: f.kw.height, src: f.u };
  });
  const k = files[0]?.kw ?? {};
  const first = (...v: any[]) => String(v.find((x) => typeof x === "string" && x.trim()) ?? "");
  const text = first(k.description, k.content, k.title, k.grid_title, k.og_title, k.text, k.caption).replace(/\s+/g, " ").trim();
  const author = first(k.username, k.owner_username, k.pinner?.username, k.origin_pinner?.username, k.author?.name, k.author?.nick, k.user?.name, k.user?.screen_name, k.uploader, k.blog_name, k.blog?.name, k.og_site_name).trim();
  const fallback = pf.id === "web" && k.filename ? String(k.filename) : `${author ? author + " " : ""}${pf.name} ${pf.sub || "post"}`.trim();
  const title = text ? (text.length > 70 ? text.slice(0, 68).trim() + "..." : text) : fallback;
  const kind = items.length > 1 ? "gallery" : items[0].type === "photo" ? "photo" : items[0].type === "audio" ? "audio" : "video";
  return { url, platform: pf, engine: "gallery", kind, title, author: author ? "@" + author.replace(/^@/, "") : "", thumb: items[0]?.thumb ?? "", duration: items[0]?.dur ?? 0, maxHeight: 0, items, attempt };
}

// Spotify: read the song details from the public embed page, then match each song on YouTube.
function findKey(o: any, key: string, depth = 0): any {
  if (!o || typeof o !== "object" || depth > 12) return undefined;
  if (key in o) return o[key];
  for (const v of Object.values(o)) { const r = findKey(v, key, depth + 1); if (r !== undefined) return r; }
  return undefined;
}
function bigImage(list: any): string {
  if (!Array.isArray(list) || !list.length) return "";
  return [...list].sort((a, b) => (b?.width ?? b?.maxWidth ?? 0) - (a?.width ?? a?.maxWidth ?? 0))[0]?.url ?? "";
}

async function probeSpotify(url: string, pf: Platform): Promise<Info> {
  const m = url.match(/spotify\.com\/(?:intl-[a-z]{2}(?:-[a-zA-Z]+)?\/)?(?:embed\/)?(track|album|playlist|artist|episode|show)\/([A-Za-z0-9]+)/);
  if (!m) throw new Friendly("That Spotify link doesn't look right. Use Share › Copy link on a song, album or playlist.");
  const [, type, id] = m;
  if (type === "episode" || type === "show") throw new Friendly("Spotify podcasts only live on Spotify, so there's nothing to match. Try the show's YouTube or website link.");
  const res = await fetch(`https://open.spotify.com/embed/${type}/${id}`, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en" } });
  if (!res.ok) throw new Friendly("Couldn't open that Spotify link. Check it's public and try again.");
  const html = await res.text();
  const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!nd) throw new Friendly("Spotify changed its page. Pluck will update itself; try again later.");
  const data = JSON.parse(nd[1]);
  const ent = findKey(data, "entity") ?? {};
  const name = String(ent.title ?? ent.name ?? "Spotify");
  const cover = bigImage(ent.coverArt?.sources) || bigImage(ent.visualIdentity?.image) || bigImage(ent.images) || bigImage(findKey(ent, "sources"));
  const artistsOf = (t: any) => String(t.subtitle ?? (Array.isArray(t.artists) ? t.artists.map((a: any) => a.name).join(", ") : "")).replace(/\u00a0/g, " ").replace(/,\s*/g, ", ");
  let items: Item[] = [];
  if (Array.isArray(ent.trackList) && ent.trackList.length) {
    items = ent.trackList.map((t: any, i: number) => ({ i, type: "audio" as const, title: String(t.title ?? t.name ?? `Track ${i + 1}`), artist: artistsOf(t), dur: Math.round((t.duration ?? 0) / 1000), thumb: cover }));
  } else {
    items = [{ i: 0, type: "audio", title: name, artist: artistsOf(ent), dur: Math.round((ent.duration ?? 0) / 1000), thumb: cover }];
  }
  const author = type === "track" ? items[0].artist ?? "" : String(ent.subtitle ?? "").replace(/\u00a0/g, " ");
  return {
    url, platform: { ...pf, sub: type[0].toUpperCase() + type.slice(1) }, engine: "spotify", kind: "music", title: name, author,
    thumb: cover, duration: items.reduce((a, b) => a + (b.dur ?? 0), 0), maxHeight: 0, items, album: type === "album" ? name : undefined, attempt: 0,
  };
}

async function probe(url: string): Promise<Info> {
  const pf = detect(url);
  if (pf.id === "spotify") return await probeSpotify(url, pf);
  const isImage = IMAGE_EXT.has(ext(new URL(url).pathname));
  const order = GALLERY_FIRST.has(pf.id) || isImage || (pf.id === "tiktok" && pf.sub === "Photos") ? ["gallery", "ytdlp"] : ["ytdlp", "gallery"];
  let firstErr = "";
  for (const eng of order) {
    try { return eng === "ytdlp" ? await probeYt(url, pf) : await probeGallery(url, pf); }
    catch (e) { const m = e instanceof Error ? e.message : String(e); if (!firstErr || /login|sign in|private|cookie|401|403/i.test(m)) firstErr = m; log("probe", eng, url, m.slice(0, 400)); }
  }
  // Any other page: collect the photos and videos on it, so every link gives you something.
  if (!/login|sign in|private|cookie|401|\b404\b|Not Found|getaddrinfo|resolve host|unreachable|DRM/i.test(firstErr)) {
    try { return await probePage(url, pf); }
    catch (e) { log("probe", "page", url, String(e).slice(0, 400)); }
  }
  throw new Friendly(friendly(firstErr));
}

const JUNK = /favicon|sprite|logo|icon|avatar|emoji|badge|spacer|blank\.|pixel|placeholder|loader|spinner|tracking|1x1|gravatar|\.svg(\?|$)|\/ads?\//i;
const unent = (t: string) => t.replace(/&(#x?[0-9a-f]+|amp|quot|apos|lt|gt|#39);/gi, (_, e: string) => {
  const k = e.toLowerCase();
  if (k[0] === "#") { const n = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : ""; }
  return ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" } as Record<string, string>)[k] ?? "";
});
const attrs = (tag: string) => {
  const o: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) o[m[1].toLowerCase()] = unent(m[2] ?? m[3] ?? m[4] ?? "");
  return o;
};

// Any web page: read it like a browser would and pick out its photos and videos, the page's own share image and video first.
async function probePage(url: string, pf: Platform): Promise<Info> {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) { await res.body?.cancel(); throw new Error(`HTTP Error ${res.status}`); }
  if (!/html|xml/i.test(res.headers.get("content-type") ?? "")) { await res.body?.cancel(); throw new Error("not a web page"); }
  const html = (await res.text()).slice(0, 5_000_000);
  let base = res.url || url;
  const b = html.match(/<base\s[^>]*href\s*=\s*["']?([^"' >]+)/i);
  if (b) { try { base = new URL(unent(b[1]), base).href; } catch { /* keep */ } }
  const abs = (u?: string) => { if (!u) return ""; try { const x = new URL(u.trim(), base); return /^https?:$/.test(x.protocol) ? x.href : ""; } catch { return ""; } };
  const meta: Record<string, string> = {};
  for (const m of html.matchAll(/<meta\s[^>]*>/gi)) { const a = attrs(m[0]); const k = (a.property ?? a.name ?? a.itemprop ?? "").toLowerCase(); if (k && a.content && !(k in meta)) meta[k] = a.content; }
  const out: { u: string; type: "photo" | "video"; thumb?: string }[] = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined, type: "photo" | "video", thumb?: string) => {
    const u = abs(raw);
    if (!u || JUNK.test(u)) return;
    const key = u.replace(/[?#].*$/, "");
    if (seen.has(key)) return;
    seen.add(key); out.push({ u, type, thumb });
  };
  const kindOf = (u: string, hint: "photo" | "video") => { const e = ext(u.split(/[?#]/)[0]); return VIDEO_EXT.has(e) ? "video" : IMAGE_EXT.has(e) ? "photo" : hint; };
  const ogImage = abs(meta["og:image:secure_url"] ?? meta["og:image"] ?? meta["og:image:url"] ?? meta["twitter:image"] ?? meta["twitter:image:src"]);
  for (const k of ["og:video:secure_url", "og:video:url", "og:video", "twitter:player:stream"]) if (meta[k] && kindOf(meta[k], "photo") === "video") add(meta[k], "video", ogImage);
  for (const m of html.matchAll(/<(video|source)\s[^>]*>/gi)) {
    const a = attrs(m[0]); const src = a.src ?? a["data-src"];
    if (src && (m[1].toLowerCase() === "video" || /video|mpegurl/i.test(a.type ?? "") || kindOf(src, "photo") === "video")) add(src, "video", abs(a.poster) || ogImage);
  }
  if (ogImage) add(ogImage, "photo");
  for (const m of html.matchAll(/<img\s[^>]*>/gi)) {
    const a = attrs(m[0]);
    const w = parseInt(a.width ?? ""), h = parseInt(a.height ?? "");
    if ((w && w < 120) || (h && h < 120)) continue;
    const set = a.srcset ?? a["data-srcset"];
    let best = "";
    if (set) { let bw = -1; for (const part of set.split(/,\s+/)) { const [u, d] = part.trim().split(/\s+/); const n = parseFloat(d ?? "1") || 1; if (u && n > bw) { bw = n; best = u; } } }
    add(best || a["data-src"] || a["data-original"] || a["data-lazy-src"] || a.src, "photo");
  }
  for (const m of html.matchAll(/<a\s[^>]*href\s*=\s*["']([^"']+\.(?:jpe?g|png|webp|gif|avif|mp4|webm|mov)(?:\?[^"']*)?)["']/gi)) { const u = unent(m[1]); add(u, kindOf(u, "photo")); }
  if (!out.length) throw new Error("No media found");
  const list = out.slice(0, 60);
  const items: Item[] = list.map((x, i) => ({ i, type: x.type, thumb: x.type === "photo" ? x.u : (x.thumb ?? ""), src: "page:" + x.u }));
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  const title = unent(meta["og:title"] ?? meta["twitter:title"] ?? titleTag).replace(/\s+/g, " ").trim() || `Media from ${pf.name}`;
  const kind = items.length > 1 ? "gallery" : items[0].type;
  return {
    url, platform: { ...pf, sub: "Page" }, engine: "gallery", kind, title: title.length > 70 ? title.slice(0, 68).trim() + "..." : title,
    author: unent(meta["og:site_name"] ?? "").trim(), thumb: items.find((x) => x.thumb)?.thumb ?? "", duration: 0, maxHeight: 0, items, attempt: 0,
  };
}

const IMG_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif", "image/heic": "heic", "image/bmp": "bmp" };
async function fetchDirect(j: Job, src: string, dir: string, n: number): Promise<string> {
  const name = join(dir, `v${String(n).padStart(3, "0")}`);
  if (src.startsWith("page:")) {
    const u = src.slice(5);
    if (kindOfUrl(u) !== "video") {
      try {
        const r = await fetch(u, { headers: { "User-Agent": UA, "Referer": j.url, "Accept": "image/avif,image/webp,image/*,*/*;q=0.8" }, signal: AbortSignal.timeout(120000) });
        const ct = (r.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
        if (r.ok && (ct.startsWith("image/") || ct.startsWith("video/"))) {
          const e = IMG_TYPES[ct] ?? (ext(u.split(/[?#]/)[0]) || ct.split("/")[1] || "bin");
          await Deno.writeFile(`${name}.${e}`, new Uint8Array(await r.arrayBuffer()));
          return "";
        }
        await r.body?.cancel();
        if (!r.ok) return `HTTP Error ${r.status}`;
      } catch (e) { return String(e); }
    }
    src = "ytdl:" + u;
  }
  const r = await run(ytdlp(), [...ytCommon(), "--no-playlist", "--referer", j.url, "-f", "bv*+ba/b", "--merge-output-format", "mp4", "-o", `${name}.%(ext)s`, "--", src.slice(5)], { job: j });
  return r.code === 0 ? "" : (r.err || r.tail.join("\n"));
}
const kindOfUrl = (u: string) => { const e = ext(u.split(/[?#]/)[0]); return VIDEO_EXT.has(e) ? "video" : IMAGE_EXT.has(e) ? "photo" : "other"; };

// ---------------------------------------------------------------- jobs

function parseCut(c: any, info: Info): Cut | undefined {
  if (!c || typeof c !== "object" || info.engine === "spotify") return undefined;
  const from = Math.max(0, Number(c.from) || 0);
  let to: number | null = c.to == null || c.to === "" ? null : Number(c.to);
  if (to != null && !Number.isFinite(to)) to = null;
  if (to != null && info.duration && to >= info.duration - 0.25) to = null;
  if (to != null && to <= from + 0.2) throw new Friendly("The end has to come after the start. Check the times and try again.");
  if (info.duration && from >= info.duration) throw new Friendly("The start is past the end of this one. Check the times and try again.");
  if (from < 0.05 && to == null) return undefined;
  return { from: Math.round(from * 100) / 100, to: to == null ? null : Math.round(to * 100) / 100 };
}

type Job = {
  id: string; url: string; info: Info; mode: string; quality: string; select: number[]; dir?: string;
  status: "queued" | "running" | "done" | "error" | "canceled"; phase: string; sub: string; pct: number; speed: string; eta: string;
  item: number; items: number; files: string[]; folder: string; error: string; warn: string; created: number; endedAt: number;
  procs: Set<Deno.ChildProcess>; canceled: boolean; tmp: string; cut?: Cut; cutLater?: boolean;
};
// "Just a part": seconds from the start; to = null means until the end.
type Cut = { from: number; to: number | null };
const tlabel = (x: number) => { const t = Math.round(x), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60; return (h ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`) + `${String(sec).padStart(2, "0")}s`; };
const cutLabel = (c: Cut) => `${tlabel(c.from)} to ${c.to == null ? "end" : tlabel(c.to)}`;
const cutIn = (c?: Cut) => c ? ["-ss", String(c.from), ...(c.to != null ? ["-to", String(c.to)] : [])] : [];
const cutLen = (c: Cut | undefined, dur: number) => c ? Math.max(0.1, (c.to ?? dur) - c.from) : dur;
const jobs: Job[] = [];
const MAX_PARALLEL = 2;

function publicJob(j: Job) {
  return {
    id: j.id, url: j.url, title: j.info.title, author: j.info.author, thumb: j.info.thumb, platform: j.info.platform, kind: j.info.kind,
    mode: j.mode, status: j.status, phase: j.phase, sub: j.sub, pct: Math.round(j.pct * 10) / 10, speed: j.speed, eta: j.eta,
    item: j.item, items: j.items, files: j.files, folder: j.folder, error: j.error, warn: j.warn, created: j.created, endedAt: j.endedAt,
    cut: j.cut ? cutLabel(j.cut) : "",
  };
}

function setP(j: Job, patch: Partial<Job>) { Object.assign(j, patch); broadcast(); }

function pump() {
  const running = jobs.filter((j) => j.status === "running").length;
  const next = jobs.filter((j) => j.status === "queued").sort((a, b) => a.created - b.created);
  for (let k = 0; k < Math.min(MAX_PARALLEL - running, next.length); k++) runJob(next[k]);
}

async function runJob(j: Job) {
  j.status = "running"; j.phase = "start"; j.pct = 0; broadcast();
  try {
    if (updating) { setP(j, { phase: "update" }); await updating; }
    j.tmp = await Deno.makeTempDir({ prefix: "pluck-" });
    const baseDir = j.dir || settings.outDir;
    const many = (j.select.length || j.info.items.length) > 1;
    j.folder = settings.ownFolders && many ? join(baseDir, safeName(j.info.title, 80)) : baseDir;
    await Deno.mkdir(j.folder, { recursive: true });
    if (j.info.engine === "spotify") await runSpotify(j);
    else if (j.info.engine === "gallery") await runGallery(j);
    else await runYt(j);
    if (j.canceled) throw new Error("canceled");
    if (!j.files.length) throw new Error(j.error || "Nothing was saved.");
    if (j.cut) {
      for (let k = 0; k < j.files.length; k++) {
        const f = j.files[k], e = ext(f);
        if (!VIDEO_EXT.has(e) && !AUDIO_EXT.has(e) && e !== "wav") continue;
        const d = uniquePath(f.slice(0, f.length - base(f).length).replace(/[\\/]+$/, ""), `${stem(f)} (${cutLabel(j.cut)})`, e);
        try { await Deno.rename(f, d); j.files[k] = d; } catch { /* keep the name */ }
      }
    }
    setP(j, { status: "done", pct: 100, phase: "finish", endedAt: Date.now() });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (j.canceled) setP(j, { status: "canceled", endedAt: Date.now() });
    else { log("job failed", j.url, m.slice(0, 1000)); setP(j, { status: "error", error: e instanceof Friendly ? m : friendly(m), endedAt: Date.now() }); }
  } finally {
    if (j.tmp) { try { await Deno.remove(j.tmp, { recursive: true }); } catch { /* ignore */ } }
    pump();
  }
}

// progress lines from yt-dlp
function ytProgress(j: Job, line: string, st: { dest: number; item: number; n: number; both: boolean; weight: number }) {
  const m = line.match(/^PCT\s*([\d.]+)%?\|([^|]*)\|(.*)$/);
  if (m) {
    const pct = Math.min(100, parseFloat(m[1]) || 0) / 100;
    let frac = pct;
    if (st.both) frac = st.dest <= 1 ? pct * 0.85 : 0.85 + pct * 0.15;
    const overall = ((Math.max(1, st.item) - 1 + frac) / st.n) * st.weight;
    j.pct = Math.max(j.pct, overall * 100);
    j.speed = m[2].trim().replace(/^Unknown.*$/i, "");
    j.eta = m[3].trim().replace(/^Unknown.*$/i, "");
    j.sub = st.both ? (st.dest <= 1 ? "video" : "audio") : j.sub;
    broadcast();
    return;
  }
  const it = line.match(/Downloading item (\d+) of (\d+)/);
  if (it) { st.item = Number(it[1]); st.dest = 0; j.item = st.item; j.items = Math.max(j.items, Number(it[2])); broadcast(); return; }
  if (/\[download\] Destination:/.test(line)) { st.dest++; return; }
  if (/\[Merger\]/.test(line)) { j.phase = "merge"; broadcast(); return; }
  if (/\[ExtractAudio\]/.test(line)) { j.phase = "encode"; j.sub = "audio"; broadcast(); }
}

function ytFormat(mode: string, q: string): string[] {
  const H = q === "best" ? "" : `[height<=${q === "4k" ? 2160 : Number(q) || 1080}]`;
  switch (mode) {
    case "mp3": return ["-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "0", "--embed-metadata", "--embed-thumbnail", "--convert-thumbnails", "jpg"];
    case "wav": return ["-f", "ba/b", "-x", "--audio-format", "wav"];
    case "cover": return ["--skip-download", "--write-thumbnail", "--convert-thumbnails", "jpg"];
    case "orig": return ["-f", `bv*${H}+ba/b${H}/bv*+ba/b`, "--merge-output-format", "mkv"];
    default: return ["-f", `bv*${H}[dynamic_range=?SDR]+ba[ext=m4a]/bv*${H}+ba[ext=m4a]/bv*${H}+ba/b${H}/bv*+ba/b`, "--merge-output-format", "mkv"];
  }
}

async function ytDownload(j: Job, url: string, extra: string[], dir: string, multi: boolean, weight: number, onPct = true): Promise<string[]> {
  const paths = join(dir, "paths.txt");
  const attempts = ytAttempts(j.info.platform.id);
  const order = [...attempts.slice(j.info.attempt), ...attempts.slice(0, j.info.attempt)];
  let lastErr = "";
  const audioOnly = extra.includes("-x") || extra[1] === "ba/b";
  for (const at of order) {
    if (j.canceled) break;
    try { await Deno.writeTextFile(paths, ""); } catch { /* ignore */ }
    const st = { dest: 0, item: 1, n: multi ? Math.max(1, j.select.length || j.info.items.length) : 1, both: !audioOnly && !extra.includes("--skip-download"), weight };
    const part = j.cut && !j.cutLater && !extra.includes("--skip-download") ? ["--download-sections", `*${j.cut.from}-${j.cut.to ?? "inf"}`, "--force-keyframes-at-cuts"] : [];
    const args = [
      ...ytCommon(), ...at, ...part, "--newline", "--no-mtime", "--retries", "10", "--fragment-retries", "10", "--concurrent-fragments", "4",
      "--progress-template", "download:PCT %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
      "-o", multi ? "%(playlist_index|0)03d %(title).110B [%(id)s].%(ext)s" : "%(title).150B [%(id)s].%(ext)s",
      "-P", dir, "-P", `temp:${dir}`, "--print-to-file", "after_move:filepath", paths,
      ...(multi ? ["--yes-playlist", "--ignore-errors", ...(j.select.length ? ["--playlist-items", j.select.map((i) => i + 1).join(",")] : [])] : ["--no-playlist"]),
      ...extra, "--", url,
    ];
    const r = await run(ytdlp(), args, { job: j, onLine: onPct ? (l) => ytProgress(j, l, st) : undefined });
    let files: string[] = [];
    try { files = [...new Set((await Deno.readTextFile(paths)).split(/\r?\n/).map((s) => s.trim()).filter((s) => s && exists(s)))]; } catch { /* ignore */ }
    if (!files.length && extra.includes("--skip-download")) files = (await listFiles(dir)).filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f));
    if (files.length) return files;
    const err = r.err || r.tail.join("\n");
    const isCookie = at[0] === "--cookies-from-browser";
    if (!isCookie || !lastErr) lastErr = err;
    if (!RETRYABLE.test(err) && !isCookie) break;
    j.phase = "retry"; broadcast();
  }
  throw new Error(lastErr || "download failed");
}

async function runYt(j: Job) {
  const multi = j.info.items.length > 1;
  const dl = join(j.tmp, "dl");
  await Deno.mkdir(dl, { recursive: true });
  const needsPost = j.mode === "video" || j.mode === "split";
  const weight = needsPost ? 0.8 : 1;
  j.items = multi ? (j.select.length || j.info.items.length) : 1;
  j.item = 1; j.phase = "fetch"; j.sub = ["mp3", "wav"].includes(j.mode) ? "audio" : j.mode === "cover" ? "photo" : "video";
  broadcast();
  let files: string[] = [];
  try { files = await ytDownload(j, j.url, ytFormat(j.mode, j.quality), dl, multi, weight); }
  catch (e) {
    if (j.mode === "cover") throw new Friendly("There's no cover image for this one.");
    if (!j.cut || j.cutLater || j.canceled) throw e;
    // Some sites can't send just a part. Fetch the whole thing and cut it here instead.
    log("part download failed, cutting after", String(e).slice(0, 300));
    j.cutLater = true; j.pct = 0; broadcast();
    files = await ytDownload(j, j.url, ytFormat(j.mode, j.quality), dl, multi, weight);
  }
  const later = j.cutLater ? j.cut : undefined;
  if (later && !needsPost) {
    j.phase = "encode"; broadcast();
    const cutted: string[] = [];
    for (const f of files) cutted.push(await cutFile(j, f, later));
    files = cutted;
  }
  const clean = (f: string) => stem(f).replace(/\.part-cut$/, "").replace(/\s\[[^\]]+\]$/, "");
  if (!needsPost) {
    for (const f of files) { const d = uniquePath(j.folder, safeName(clean(f)), ext(f)); await moveFile(f, d); j.files.push(d); }
    return;
  }
  for (let k = 0; k < files.length; k++) {
    if (j.canceled) return;
    const f = files[k];
    j.item = k + 1; j.items = files.length; j.phase = "encode"; j.sub = "video"; broadcast();
    const onPct = (x: number) => { j.pct = (weight + (1 - weight) * ((k + x) / files.length)) * 100; broadcast(); };
    let audio: string | null = null;
    const pi = await ffprobe(f);
    if (pi.v && !pi.a && !multi) {
      setP(j, { phase: "fetch", sub: "audio" });
      try {
        const ad = join(j.tmp, "aud"); await Deno.mkdir(ad, { recursive: true });
        const got = await ytDownload(j, j.url, ["-f", "ba[ext=m4a]/ba/b"], ad, false, 1, false);
        audio = got[0] ?? null;
      } catch (e) { log("audio fetch failed", String(e)); }
      if (!audio) j.warn = "The site held back the audio for this one, so the video is silent. Try again in a few minutes.";
      setP(j, { phase: "encode", sub: "video" });
    }
    const name = safeName(clean(f));
    if (!pi.v) { const src = later ? await cutFile(j, f, later) : f; const d = uniquePath(j.folder, name, ext(src)); await moveFile(src, d); j.files.push(d); continue; }
    if (j.mode === "video") {
      const d = uniquePath(j.folder, name, "mp4");
      if (await editReady(j, f, audio, true, d, onPct, later)) j.files.push(d);
      else { const o = uniquePath(j.folder, name, ext(f)); await moveFile(f, o); j.files.push(o); j.warn = "Couldn't convert to MP4, so Pluck saved the original file."; }
    } else {
      const dv = uniquePath(j.folder, name + " (video)", "mp4");
      if (await editReady(j, f, null, false, dv, (x) => onPct(x * 0.7), later)) j.files.push(dv);
      const asrc = audio ?? (pi.a ? f : null);
      if (asrc) { const da = uniquePath(j.folder, name + " (audio)", "wav"); j.phase = "encode"; j.sub = "audio"; if (await toAudio(j, asrc, da, "wav", (x) => onPct(0.7 + x * 0.3), later)) j.files.push(da); }
    }
  }
}

async function runGallery(j: Job) {
  const sel = j.select.length ? j.select : j.info.items.map((x) => x.i);
  const dl = join(j.tmp, "dl");
  await Deno.mkdir(dl, { recursive: true });
  j.items = sel.length; j.item = 1; j.phase = "fetch"; j.sub = j.info.items[sel[0]]?.type ?? "photo"; broadcast();
  const post = j.mode !== "orig" && j.mode !== "photos";
  const weight = post ? 0.7 : 1;
  const attempts = gdAttempts(j.info.platform.id);
  const order = [...attempts.slice(j.info.attempt), ...attempts.slice(0, j.info.attempt)];
  // Some videos (Pinterest, for one) are streams that gallery-dl hands to yt-dlp. Pluck fetches those itself.
  const streams = sel.filter((i) => /^(ytdl|page):/.test(j.info.items[i]?.src ?? ""));
  const gsel = sel.filter((i) => !streams.includes(i));
  let files: string[] = [];
  let lastErr = "";
  for (let k = 0; k < streams.length; k++) {
    if (j.canceled) return;
    const i = streams[k];
    j.item = k + 1; j.sub = j.info.items[i].type; broadcast();
    const err = await fetchDirect(j, j.info.items[i].src!, dl, i + 1);
    if (err) lastErr = err;
    j.pct = ((k + 1) / sel.length) * weight * 100; broadcast();
  }
  const got = (await listFiles(dl)).length;
  for (const at of gsel.length ? order : []) {
    if (j.canceled) return;
    let count = 0;
    const r = await run(gallerydl(), [...at, "--range", gsel.map((i) => i + 1).join(","), "-D", dl, "--", j.info.url], {
      job: j,
      onLine: (l) => {
        if (l.startsWith(dl) || l.startsWith("# ") || l.includes(SEP + "dl" + SEP)) {
          count++;
          j.item = Math.min(sel.length, count + 1);
          j.sub = j.info.items[sel[Math.min(sel.length - 1, count)]]?.type ?? j.sub;
          j.pct = (count / sel.length) * weight * 100;
          broadcast();
        }
      },
    });
    files = await listFiles(dl);
    if (files.length > got) break;
    const isCookie = at[0] === "--cookies-from-browser";
    const err = r.err || r.tail.join("\n");
    if (!isCookie || !lastErr) lastErr = err;
    if (!RETRYABLE.test(err) && !isCookie) break;
  }
  files = (await listFiles(dl)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!files.length) throw new Error(lastErr || "No media found");
  const title = safeName(j.info.title, 80);
  const many = files.length > 1;
  for (let k = 0; k < files.length; k++) {
    if (j.canceled) return;
    const f = files[k];
    const e = ext(f);
    const isVid = VIDEO_EXT.has(e);
    const name = many ? `${title} ${String(k + 1).padStart(2, "0")}` : title;
    j.item = k + 1;
    const onPct = (x: number) => { j.pct = (weight + (1 - weight) * ((k + x) / files.length)) * 100; broadcast(); };
    const cut = isVid ? j.cut : undefined;
    if (cut && j.mode === "orig") {
      setP(j, { phase: "encode", sub: "video" });
      const d = uniquePath(j.folder, name, "mp4");
      if (await editReady(j, f, null, true, d, onPct, cut)) j.files.push(d);
      continue;
    }
    if (j.mode === "orig" || (!isVid && j.mode !== "mp3")) {
      if (!isVid && (e === "webp" || e === "heic") && j.mode !== "orig") {
        const d = uniquePath(j.folder, name, "jpg");
        if (await ffmpegRun(j, ["-i", f, "-q:v", "2", d], 0, () => {})) { j.files.push(d); continue; }
      }
      if (j.mode === "videos" || j.mode === "split") continue;
      const d = uniquePath(j.folder, name, e || "jpg"); await moveFile(f, d); j.files.push(d); onPct(1); continue;
    }
    if (!isVid) continue;
    setP(j, { phase: "encode", sub: "video" });
    if (j.mode === "mp3") { const d = uniquePath(j.folder, name, "mp3"); if (await toAudio(j, f, d, "mp3", onPct, cut)) j.files.push(d); continue; }
    if (j.mode === "split") {
      const dv = uniquePath(j.folder, name + " (video)", "mp4");
      if (await editReady(j, f, null, false, dv, (x) => onPct(x * 0.7), cut)) j.files.push(dv);
      const pi = await ffprobe(f);
      if (pi.a) { const da = uniquePath(j.folder, name + " (audio)", "wav"); if (await toAudio(j, f, da, "wav", (x) => onPct(0.7 + x * 0.3), cut)) j.files.push(da); }
      continue;
    }
    const d = uniquePath(j.folder, name, "mp4");
    if (await editReady(j, f, null, true, d, onPct, cut)) j.files.push(d);
    else { const o = uniquePath(j.folder, name, e); await moveFile(f, o); j.files.push(o); }
  }
}

function scoreMatch(e: any, tr: Item): number {
  const t = String(e.title ?? "");
  const ch = String(e.channel ?? e.uploader ?? "");
  let s = 0;
  if (tr.dur && e.duration) { const diff = Math.abs(e.duration - tr.dur); s -= Math.min(diff, 120); if (diff <= 3) s += 20; }
  if (/ - Topic$/i.test(ch)) s += 25;
  if (/official (audio|video)|\baudio\b/i.test(t)) s += 8;
  const bad = /\b(live|remix|cover|karaoke|instrumental|sped ?up|slowed|reverb|8d|nightcore|lyrics?|reaction)\b/i;
  if (bad.test(t) && !bad.test(tr.title ?? "")) s -= 30;
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (norm(t).includes(norm(tr.title ?? ""))) s += 10;
  return s;
}

async function runSpotify(j: Job) {
  const sel = j.select.length ? j.select : j.info.items.map((x) => x.i);
  j.items = sel.length;
  let coverFile = "";
  if (j.info.thumb) {
    try { const r = await fetch(j.info.thumb, { headers: { "User-Agent": UA } }); if (r.ok) { coverFile = join(j.tmp, "cover.jpg"); await Deno.writeFile(coverFile, new Uint8Array(await r.arrayBuffer())); } } catch { /* ignore */ }
  }
  if (j.mode === "cover") {
    if (!coverFile) throw new Friendly("Couldn't fetch the cover art.");
    const d = uniquePath(j.folder, safeName(j.info.title) + " (cover)", "jpg"); await moveFile(coverFile, d); j.files.push(d); return;
  }
  const failed: string[] = [];
  for (let k = 0; k < sel.length; k++) {
    if (j.canceled) return;
    const tr = j.info.items[sel[k]];
    j.item = k + 1; j.sub = "audio";
    const frac = (x: number) => { j.pct = ((k + x) / sel.length) * 100; broadcast(); };
    setP(j, { phase: "match" }); frac(0.02);
    const q = `${tr.artist ?? ""} ${tr.title ?? ""} audio`.replace(/\s+/g, " ").trim();
    const sr = await run(ytdlp(), [...ytCommon(), "--flat-playlist", "-J", `ytsearch6:${q}`], { capture: true, job: j, timeoutMs: 60000 });
    let best: any = null;
    try { const ents = (JSON.parse(sr.out).entries ?? []).filter((e: any) => e?.id); best = ents.map((e: any) => ({ e, s: scoreMatch(e, tr) })).sort((a: any, b: any) => b.s - a.s)[0]?.e; } catch { /* ignore */ }
    if (!best) { failed.push(tr.title ?? ""); continue; }
    setP(j, { phase: "fetch" }); frac(0.1);
    const dir = join(j.tmp, "t" + k); await Deno.mkdir(dir, { recursive: true });
    let got: string[] = [];
    try {
      const sub = { ...j, info: { ...j.info, platform: { id: "youtube", name: "YouTube", sub: "" }, attempt: 0 } } as Job;
      sub.procs = j.procs;
      got = await ytDownload(sub, `https://www.youtube.com/watch?v=${best.id}`, ["-f", "ba/b", "-x", "--audio-format", j.mode === "wav" ? "wav" : "mp3", "--audio-quality", "0"], dir, false, 1, false);
    } catch (e) { log("spotify track failed", tr.title, String(e).slice(0, 300)); }
    if (!got.length) { failed.push(tr.title ?? ""); continue; }
    setP(j, { phase: "tag" }); frac(0.85);
    const name = safeName(`${tr.artist ? tr.artist.split(",")[0] + " - " : ""}${tr.title}`);
    const outExt = j.mode === "wav" ? "wav" : "mp3";
    const d = uniquePath(j.folder, name, outExt);
    const meta = ["-metadata", `title=${tr.title ?? ""}`, "-metadata", `artist=${tr.artist ?? ""}`];
    if (j.info.album) meta.push("-metadata", `album=${j.info.album}`, "-metadata", `track=${sel[k] + 1}`);
    const args = outExt === "mp3" && coverFile
      ? ["-i", got[0], "-i", coverFile, "-map", "0:a", "-map", "1:v", "-c", "copy", "-id3v2_version", "3", ...meta, "-metadata:s:v", "title=Album cover", "-disposition:v", "attached_pic", d]
      : ["-i", got[0], "-map", "0:a", "-c", "copy", ...meta, d];
    if (await ffmpegRun(j, args, 0, () => {})) j.files.push(d);
    else { await moveFile(got[0], d); j.files.push(d); }
    frac(1);
  }
  if (failed.length) j.warn = `Couldn't find a match for ${failed.length === 1 ? `"${failed[0]}"` : failed.length + " songs"}.`;
}

// ---------------------------------------------------------------- ffmpeg helpers

type Probe = { v?: { codec: string; height: number; pix: string }; a?: { codec: string }; dur: number };
async function ffprobe(f: string): Promise<Probe> {
  const r = await run(ffprobeT(), ["-v", "error", "-show_entries", "stream=codec_type,codec_name,height,pix_fmt:format=duration", "-of", "json", f], { capture: true, timeoutMs: 30000 });
  const out: Probe = { dur: 0 };
  try {
    const j = JSON.parse(r.out);
    for (const s of j.streams ?? []) {
      if (s.codec_type === "video" && !out.v && !["mjpeg", "png"].includes(s.codec_name)) out.v = { codec: s.codec_name, height: s.height ?? 0, pix: s.pix_fmt ?? "" };
      if (s.codec_type === "audio" && !out.a) out.a = { codec: s.codec_name };
    }
    out.dur = parseFloat(j.format?.duration ?? "0") || 0;
  } catch { /* ignore */ }
  return out;
}

async function ffmpegRun(j: Job, args: string[], dur: number, onPct: (x: number) => void): Promise<boolean> {
  const out = args[args.length - 1];
  const r = await run(ffmpeg(), ["-hide_banner", "-y", ...args.slice(0, -1), "-progress", "pipe:1", "-nostats", "-loglevel", "error", out], {
    job: j,
    onLine: (l) => { const m = l.match(/^out_time_(?:us|ms)=(\d+)/); if (m && dur > 0) onPct(Math.min(1, Number(m[1]) / 1e6 / dur)); },
  });
  let ok = r.code === 0;
  try { ok = ok && (await Deno.stat(out)).size > 0; } catch { ok = false; }
  if (!ok) { log("ffmpeg failed", r.err.slice(-600)); try { await Deno.remove(out); } catch { /* ignore */ } }
  return ok;
}

function videoEncoders(height: number): string[][] {
  const br = height >= 2160 ? "45M" : height >= 1440 ? "24M" : height >= 1080 ? "12M" : height >= 720 ? "7M" : "5M";
  const hw: string[][] = isMac
    ? [["-c:v", "h264_videotoolbox", "-b:v", br, "-profile:v", "high", "-pix_fmt", "yuv420p"]]
    : isWin
    ? [["-c:v", "h264_nvenc", "-preset", "p5", "-b:v", br, "-pix_fmt", "yuv420p"], ["-c:v", "h264_qsv", "-b:v", br, "-pix_fmt", "nv12"], ["-c:v", "h264_amf", "-b:v", br, "-pix_fmt", "yuv420p"]]
    : [];
  return [...hw, ["-c:v", "libx264", "-preset", "fast", "-crf", "17", "-pix_fmt", "yuv420p"]];
}

async function editReady(j: Job, src: string, audioSrc: string | null, withAudio: boolean, dest: string, onPct: (x: number) => void, cut?: Cut): Promise<boolean> {
  const pi = await ffprobe(src);
  if (!pi.v) return false;
  const inputs = [...cutIn(cut), "-i", src];
  const maps = ["-map", "0:v:0"];
  let aArgs = ["-an"];
  if (withAudio) {
    const as = audioSrc ?? (pi.a ? src : null);
    if (as) {
      const ai = as === src ? pi : await ffprobe(as);
      if (ai.a) {
        if (as !== src) { inputs.push(...cutIn(cut), "-i", as); maps.push("-map", "1:a:0"); } else maps.push("-map", "0:a:0");
        aArgs = ai.a.codec === "aac" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "320k"];
      }
    }
  }
  if (cut && aArgs[1] === "copy") aArgs = ["-c:a", "aac", "-b:a", "320k"];
  const tries: string[][] = [];
  if (!cut && pi.v.codec === "h264") tries.push(["-c:v", "copy"]);
  if (!cut && pi.v.codec === "hevc") tries.push(["-c:v", "copy", "-tag:v", "hvc1"]);
  tries.push(...videoEncoders(pi.v.height));
  for (const v of tries) {
    if (j.canceled) return false;
    if (await ffmpegRun(j, [...inputs, ...maps, ...v, ...aArgs, "-movflags", "+faststart", dest], cutLen(cut, pi.dur), onPct)) return true;
  }
  return false;
}

// Cut a finished file to the part asked for. Keeps the format when it can; video comes out as MP4.
async function cutFile(j: Job, f: string, cut: Cut): Promise<string> {
  const pi = await ffprobe(f);
  const e = ext(f);
  const out = f.replace(/\.[^.\\/]+$/, "") + ".part-cut";
  if (pi.v && VIDEO_EXT.has(e)) {
    const d = out + ".mp4";
    if (await editReady(j, f, null, true, d, () => {}, cut)) return d;
    return f;
  }
  if (!pi.a) return f;
  const codec: Record<string, string[]> = { mp3: ["-c:a", "libmp3lame", "-q:a", "0"], wav: ["-c:a", "pcm_s16le"], flac: ["-c:a", "flac"], opus: ["-c:a", "libopus", "-b:a", "192k"], ogg: ["-c:a", "libvorbis", "-q:a", "8"] };
  const d = `${out}.${codec[e] ? e : "m4a"}`;
  if (await ffmpegRun(j, [...cutIn(cut), "-i", f, "-map", "0:a:0", "-vn", ...(codec[e] ?? ["-c:a", "aac", "-b:a", "320k"]), d], cutLen(cut, pi.dur), () => {})) return d;
  return f;
}

async function toAudio(j: Job, src: string, dest: string, fmt: "wav" | "mp3", onPct: (x: number) => void, cut?: Cut): Promise<boolean> {
  const pi = await ffprobe(src);
  const codec = fmt === "wav" ? ["-c:a", "pcm_s16le", "-ar", "48000"] : ["-c:a", "libmp3lame", "-q:a", "0"];
  return await ffmpegRun(j, [...cutIn(cut), "-i", src, "-map", "0:a:0", "-vn", ...codec, dest], cutLen(cut, pi.dur), onPct);
}

// ---------------------------------------------------------------- downloads and archives

async function writeAll(f: Deno.FsFile, b: Uint8Array) { let o = 0; while (o < b.length) o += await f.write(b.subarray(o)); }
async function rmrf(p: string) { try { await Deno.remove(p, { recursive: true }); } catch { /* already gone */ } }

async function download(url: string, dest: string, onPct?: (x: number) => void, tries = 3): Promise<void> {
  if (!/^https:\/\/|^http:\/\/127\.0\.0\.1[:/]/.test(url)) throw new Error("refusing to download " + url);
  let last: unknown;
  for (let t = 0; t < tries; t++) {
    const ctl = new AbortController();
    let idle = setTimeout(() => ctl.abort(), 45000);
    const tmp = dest + ".download";
    try {
      const r = await fetch(url, { headers: { "User-Agent": `Pluck/${VERSION}` }, signal: ctl.signal });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status} for ${url}`);
      const total = Number(r.headers.get("content-length") ?? 0);
      const f = await Deno.open(tmp, { write: true, create: true, truncate: true });
      let got = 0;
      try {
        for await (const chunk of r.body) {
          clearTimeout(idle); idle = setTimeout(() => ctl.abort(), 45000);
          await writeAll(f, chunk);
          got += chunk.length;
          if (total && onPct) onPct(Math.min(1, got / total));
        }
      } finally { f.close(); }
      if (total && got !== total) throw new Error("download cut short");
      await Deno.rename(tmp, dest);
      return;
    } catch (e) {
      last = e;
      try { await Deno.remove(tmp); } catch { /* ignore */ }
      if (t < tries - 1) await sleep(1500 * (t + 1));
    } finally { clearTimeout(idle); }
  }
  throw last;
}

// A path inside an archive, split into safe parts (no absolute paths, no "..").
function safeRel(name: string): string[] | null {
  const parts = name.replace(/\\/g, "/").split("/").filter((x) => x !== "" && x !== ".");
  if (!parts.length || parts.some((x) => x === ".." || x.includes(":"))) return null;
  return parts;
}

async function readAt(f: Deno.FsFile, pos: number, len: number): Promise<Uint8Array> {
  await f.seek(pos, Deno.SeekMode.Start);
  const buf = new Uint8Array(len);
  let off = 0;
  while (off < len) { const n = await f.read(buf.subarray(off)); if (n === null) break; off += n; }
  return buf.subarray(0, off);
}

// Small zip reader, so unpacking works the same on every computer. `pick` maps an entry name to
// where it should be written, or null to skip it. Returns the files written.
async function unzip(zipPath: string, pick: (name: string) => string | null): Promise<string[]> {
  const f = await Deno.open(zipPath, { read: true });
  const out: string[] = [];
  try {
    const size = (await f.stat()).size;
    const tailLen = Math.min(size, 65536 + 22);
    const tail = await readAt(f, size - tailLen, tailLen);
    const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("not a zip file");
    let count = dv.getUint16(eocd + 10, true);
    let cdSize = dv.getUint32(eocd + 12, true);
    let cdOff = dv.getUint32(eocd + 16, true);
    if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
      const loc = eocd - 20;
      if (loc < 0 || dv.getUint32(loc, true) !== 0x07064b50) throw new Error("broken zip64 file");
      const z = await readAt(f, Number(dv.getBigUint64(loc + 8, true)), 56);
      const zv = new DataView(z.buffer, z.byteOffset, z.byteLength);
      if (zv.getUint32(0, true) !== 0x06064b50) throw new Error("broken zip64 file");
      count = Number(zv.getBigUint64(32, true));
      cdSize = Number(zv.getBigUint64(40, true));
      cdOff = Number(zv.getBigUint64(48, true));
    }
    const cd = await readAt(f, cdOff, cdSize);
    const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
    const dec = new TextDecoder();
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.length; n++) {
      if (cv.getUint32(p, true) !== 0x02014b50) throw new Error("broken zip directory");
      const flags = cv.getUint16(p + 8, true);
      const method = cv.getUint16(p + 10, true);
      let csize = cv.getUint32(p + 20, true);
      let usize = cv.getUint32(p + 24, true);
      const nlen = cv.getUint16(p + 28, true), xlen = cv.getUint16(p + 30, true), clen = cv.getUint16(p + 32, true);
      const attrs = cv.getUint32(p + 38, true);
      let lho = cv.getUint32(p + 42, true);
      const name = dec.decode(cd.subarray(p + 46, p + 46 + nlen));
      for (let x = p + 46 + nlen; x + 4 <= p + 46 + nlen + xlen;) {
        const id = cv.getUint16(x, true), sz = cv.getUint16(x + 2, true);
        if (id === 0x0001) {
          let q = x + 4;
          if (usize === 0xffffffff) { usize = Number(cv.getBigUint64(q, true)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(cv.getBigUint64(q, true)); q += 8; }
          if (lho === 0xffffffff) { lho = Number(cv.getBigUint64(q, true)); q += 8; }
        }
        x += 4 + sz;
      }
      p += 46 + nlen + xlen + clen;
      if (name.endsWith("/") || name.endsWith("\\")) continue;
      const dest = pick(name);
      if (!dest) continue;
      if (flags & 1) throw new Error("encrypted zip");
      if (method !== 0 && method !== 8) throw new Error("unsupported zip compression " + method);
      const lh = await readAt(f, lho, 30);
      const lv = new DataView(lh.buffer, lh.byteOffset, lh.byteLength);
      if (lv.getUint32(0, true) !== 0x04034b50) throw new Error("broken zip entry");
      await f.seek(lho + 30 + lv.getUint16(26, true) + lv.getUint16(28, true), Deno.SeekMode.Start);
      let left = csize;
      const raw = new ReadableStream<Uint8Array>({
        async pull(ctrl) {
          if (left <= 0) { ctrl.close(); return; }
          const buf = new Uint8Array(Math.min(left, 1 << 20));
          const r = await f.read(buf);
          if (r === null) { ctrl.error(new Error("zip file is cut short")); return; }
          left -= r;
          ctrl.enqueue(buf.subarray(0, r));
        },
      });
      const body = method === 8 ? raw.pipeThrough(new DecompressionStream("deflate-raw") as unknown as TransformStream<Uint8Array, Uint8Array>) : raw;
      await Deno.mkdir(parent(dest), { recursive: true });
      const tmp = dest + ".unzip";
      const of = await Deno.open(tmp, { write: true, create: true, truncate: true });
      let written = 0;
      try { for await (const chunk of body) { await writeAll(of, chunk); written += chunk.length; } } finally { of.close(); }
      if (written !== usize) throw new Error("zip entry size mismatch");
      await Deno.rename(tmp, dest);
      if (!isWin) await Deno.chmod(dest, ((attrs >>> 16) & 0o111) || /(^|\/)[^.\/]+$/.test(name) ? 0o755 : 0o644);
      out.push(dest);
    }
  } finally { f.close(); }
  return out;
}

async function untar(archive: string, destDir: string) {
  const r = await run({ cmd: "tar", pre: [] }, ["-xf", archive, "-C", destDir], { timeoutMs: 600000 });
  if (r.code !== 0) throw new Error("couldn't unpack " + base(archive));
}

async function findFile(dir: string, name: string): Promise<string | null> {
  try {
    for await (const e of Deno.readDir(dir)) {
      const p = join(dir, e.name);
      if (e.isFile && e.name === name) return p;
      if (e.isDirectory) { const f = await findFile(p, name); if (f) return f; }
    }
  } catch { /* ignore */ }
  return null;
}

// ---------------------------------------------------------------- first run setup (download engines)

type StepId = "ytdlp" | "ffmpeg" | "gallery";
type Step = { id: StepId; state: "wait" | "run" | "ok" | "err"; pct: number; note: string };
const STEP_IDS: StepId[] = ["ytdlp", "ffmpeg", "gallery"];
const setup = { state: "idle" as "idle" | "running" | "ready" | "error", steps: [] as Step[] };
let setupRun: Promise<void> | null = null;
const ARCH = Deno.build.arch === "aarch64" ? "arm64" : "x64";
const binPath = (n: string) => join(BIN, n + (isWin ? ".exe" : ""));

function onPath(name: string): boolean {
  return (Deno.env.get("PATH") ?? "").split(isWin ? ";" : ":").some((d) => d && (exists(join(d, name)) || (isWin && exists(join(d, name + ".exe")))));
}
function have(id: StepId): boolean {
  if (id === "ytdlp") return exists(binPath("yt-dlp"));
  if (id === "ffmpeg") return (exists(binPath("ffmpeg")) && exists(binPath("ffprobe"))) || (OS === "linux" && onPath("ffmpeg") && onPath("ffprobe"));
  return gallerydl().cmd.includes(SEP);
}
function uvEnv(): Record<string, string> {
  return {
    UV_TOOL_DIR: join(ROOT, "uv", "tools"), UV_TOOL_BIN_DIR: BIN, UV_PYTHON_INSTALL_DIR: join(ROOT, "uv", "python"),
    UV_PYTHON_BIN_DIR: join(ROOT, "uv", "pybin"), UV_CACHE_DIR: join(ROOT, "uv", "cache"), UV_NO_MODIFY_PATH: "1",
    UV_PYTHON_PREFERENCE: "only-managed", UV_NO_CONFIG: "1", UV_NO_PROGRESS: "1",
  };
}
function prog(st: Step, x: number) { st.pct = Math.max(st.pct, Math.min(1, x)); broadcast(); }
async function works(t: Tool, args: string[]) {
  const r = await run(t, args, { capture: true, timeoutMs: 180000 });
  if (r.code !== 0) throw new Error(`${base(t.cmd)} didn't run: ${(r.err || r.out).trim().slice(-300)}`);
}

async function getYtdlp(st: Step) {
  const name = isMac ? "yt-dlp_macos" : isWin ? "yt-dlp.exe" : ARCH === "arm64" ? "yt-dlp_linux_aarch64" : "yt-dlp_linux";
  const dest = binPath("yt-dlp");
  try { await download(`https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/${name}`, dest, (x) => prog(st, x * 0.9), 2); }
  catch { await download(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${name}`, dest, (x) => prog(st, x * 0.9)); }
  if (!isWin) await Deno.chmod(dest, 0o755);
  await works(ytdlp(), ["--version"]);
}

async function getFfmpeg(st: Step) {
  const tmp = await Deno.makeTempDir({ dir: ROOT, prefix: "setup-" });
  try {
    if (isMac) {
      const a = ARCH === "arm64" ? "arm64" : "amd64";
      const names = ["ffmpeg", "ffprobe"];
      for (let i = 0; i < names.length; i++) {
        const name = names[i], zip = join(tmp, name + ".zip"), from = i * 0.47;
        const urls = [`https://ffmpeg.martin-riedl.de/redirect/latest/macos/${a}/release/${name}.zip`, `https://ffmpeg.martin-riedl.de/redirect/latest/macos/${a}/snapshot/${name}.zip`];
        if (a === "amd64") urls.push(`https://evermeet.cx/ffmpeg/getrelease/${name === "ffmpeg" ? "" : "ffprobe/"}zip`);
        let ok = false, err: unknown;
        for (const u of urls) { try { await download(u, zip, (x) => prog(st, from + x * 0.45), 2); ok = true; break; } catch (e) { err = e; } }
        if (!ok) throw err;
        const got = await unzip(zip, (n) => (base(n) === name ? binPath(name) : null));
        if (!got.length) throw new Error(name + " was missing from the download");
        await Deno.chmod(binPath(name), 0o755);
      }
    } else if (isWin) {
      const zip = join(tmp, "ffmpeg.zip");
      await download("https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip", zip, (x) => prog(st, x * 0.85));
      const got = await unzip(zip, (n) => {
        const m = n.replace(/\\/g, "/").match(/\/bin\/([^/]+\.(?:exe|dll))$/i);
        return m && !/^ffplay/i.test(m[1]) ? join(BIN, m[1]) : null;
      });
      if (!got.some((p) => /ffmpeg\.exe$/i.test(p)) || !got.some((p) => /ffprobe\.exe$/i.test(p))) throw new Error("ffmpeg was missing from the download");
    } else if (!(onPath("ffmpeg") && onPath("ffprobe"))) {
      const arc = join(tmp, "ffmpeg.tar.xz");
      await download(`https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-${ARCH === "arm64" ? "linuxarm64" : "linux64"}-gpl.tar.xz`, arc, (x) => prog(st, x * 0.85));
      await untar(arc, tmp);
      for (const n of ["ffmpeg", "ffprobe"]) {
        const f = await findFile(tmp, n);
        if (!f) throw new Error(n + " was missing from the download");
        await moveFile(f, binPath(n)); await Deno.chmod(binPath(n), 0o755);
      }
    }
    prog(st, 0.95);
    await works(ffmpeg(), ["-version"]);
  } finally { await rmrf(tmp); }
}

async function getGallery(st: Step) {
  const tmp = await Deno.makeTempDir({ dir: ROOT, prefix: "setup-" });
  let creep: ReturnType<typeof setInterval> | undefined;
  try {
    const uv: Tool = { cmd: binPath("uv"), pre: [] };
    if (!exists(uv.cmd)) {
      const cpu = ARCH === "arm64" ? "aarch64" : "x86_64";
      const triple = isMac ? `${cpu}-apple-darwin` : isWin ? "x86_64-pc-windows-msvc" : `${cpu}-unknown-linux-gnu`;
      const arc = join(tmp, isWin ? "uv.zip" : "uv.tar.gz");
      await download(`https://github.com/astral-sh/uv/releases/latest/download/uv-${triple}.${isWin ? "zip" : "tar.gz"}`, arc, (x) => prog(st, x * 0.3));
      if (isWin) {
        const got = await unzip(arc, (n) => (/(^|[\\/])uv\.exe$/i.test(n) ? uv.cmd : null));
        if (!got.length) throw new Error("uv was missing from the download");
      } else {
        await untar(arc, tmp);
        const f = await findFile(tmp, "uv");
        if (!f) throw new Error("uv was missing from the download");
        await moveFile(f, uv.cmd); await Deno.chmod(uv.cmd, 0o755);
      }
    }
    prog(st, 0.35);
    creep = setInterval(() => prog(st, st.pct + (0.92 - st.pct) * 0.04), 1000);
    let r = await run(uv, ["tool", "install", "--force", "--python", "3.12", "gallery-dl"], { env: uvEnv(), timeoutMs: 900000 });
    if (r.code !== 0) r = await run(uv, ["tool", "install", "--force", "gallery-dl"], { env: uvEnv(), timeoutMs: 900000 });
    if (r.code !== 0 || !exists(binPath("gallery-dl"))) {
      log("uv install failed", r.tail.slice(-4).join(" | "));
      if (!isWin) throw new Error("couldn't install the photo engine");
      // Windows fallback: the standalone gallery-dl.exe
      const rel = await fetch("https://codeberg.org/api/v1/repos/mikf/gallery-dl/releases/latest", { headers: { "User-Agent": `Pluck/${VERSION}` }, signal: AbortSignal.timeout(30000) }).then((x) => x.json());
      const a = (rel.assets ?? []).find((x: any) => x.name === "gallery-dl.exe");
      if (!a) throw new Error("couldn't find gallery-dl.exe");
      await download(String(a.browser_download_url), binPath("gallery-dl"), (x) => prog(st, 0.4 + x * 0.5));
    }
    await works(gallerydl(), ["--version"]);
  } finally { if (creep) clearInterval(creep); await rmrf(tmp); }
}

function setupError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/HTTP|fetch|network|dns|connect|timed? ?out|abort|cut short|error sending/i.test(m)) return "Couldn't download. Check your internet connection and try again.";
  return "Didn't finish setting up. Try again.";
}

function ensureTools(): Promise<void> {
  if (setupRun) return setupRun;
  const need = STEP_IDS.filter((id) => !have(id));
  if (!need.length) { setup.state = "ready"; setup.steps = []; return Promise.resolve(); }
  setup.steps = STEP_IDS.map((id) => ({ id, state: need.includes(id) ? "wait" : "ok", pct: need.includes(id) ? 0 : 1, note: "" }));
  setup.state = "running";
  log("setup", need.join(" "));
  broadcast();
  setupRun = (async () => {
    try { await Deno.mkdir(BIN, { recursive: true }); } catch { /* ignore */ }
    await Promise.all(need.map(async (id) => {
      const st = setup.steps.find((x) => x.id === id)!;
      st.state = "run"; broadcast();
      try {
        await (id === "ytdlp" ? getYtdlp(st) : id === "ffmpeg" ? getFfmpeg(st) : getGallery(st));
        st.state = "ok"; st.pct = 1;
      } catch (e) { st.state = "err"; st.note = setupError(e); log("setup failed", id, e instanceof Error ? e.message : String(e)); }
      broadcast();
    }));
    setup.state = setup.steps.some((x) => x.state === "err") ? "error" : "ready";
    log("setup", setup.state);
    if (setup.state === "ready") { settings.lastUpdate = Date.now(); await saveSettings(); }
    setupRun = null;
    broadcast();
    versions().then(() => broadcast());
  })();
  return setupRun;
}

// ---------------------------------------------------------------- engine updates (daily fixes for sites)

let updating: Promise<void> | null = null;
let updateState = { state: "idle", last: 0, versions: {} as Record<string, string>, message: "" };

async function versions() {
  const v: Record<string, string> = {};
  const y = await run(ytdlp(), ["--version"], { capture: true, timeoutMs: 20000 }); v.ytdlp = y.out.trim() || "missing";
  const g = await run(gallerydl(), ["--version"], { capture: true, timeoutMs: 20000 }); v.gallerydl = g.out.trim() || "missing";
  const f = await run(ffmpeg(), ["-version"], { capture: true, timeoutMs: 20000 }); v.ffmpeg = (f.out.match(/ffmpeg version (\S+)/)?.[1]) ?? "missing";
  v.pluck = VERSION;
  updateState.versions = v;
  updateState.last = settings.lastUpdate;
}

function updateTools(force = false): Promise<void> {
  if (updating) return updating;
  if (setupRun) return Promise.resolve();
  if (!force && Date.now() - settings.lastUpdate < 20 * 3600 * 1000) return Promise.resolve();
  updating = (async () => {
    updateState.state = "updating"; updateState.message = "Checking for fixes"; broadcast();
    const msgs: string[] = [];
    try {
      const yt = ytdlp();
      if (yt.cmd.includes(SEP)) { const r = await run(yt, ["--update-to", "nightly"], { timeoutMs: 180000 }); msgs.push(r.tail.slice(-1)[0] ?? ""); }
      const gd = gallerydl();
      const uv: Tool = { cmd: binPath("uv"), pre: [] };
      if (exists(uv.cmd) && exists(join(ROOT, "uv", "tools", "gallery-dl"))) {
        const r = await run(uv, ["tool", "upgrade", "gallery-dl"], { timeoutMs: 300000, env: uvEnv() });
        msgs.push(r.tail.slice(-1)[0] ?? "");
      } else if (gd.pre.length) await run({ cmd: gd.cmd, pre: [] }, ["-m", "pip", "install", "-U", "--disable-pip-version-check", "-q", "gallery-dl"], { timeoutMs: 180000 });
      else if (gd.cmd.includes(SEP)) await run(gd, ["-U"], { timeoutMs: 180000 });
      settings.lastUpdate = Date.now(); await saveSettings();
      await versions();
      updateState.state = "ok"; updateState.message = "Up to date";
    } catch (e) {
      updateState.state = "error"; updateState.message = "Update check failed, will try again later"; log("update failed", e);
    }
    log("update", msgs.join(" | "));
    updating = null; broadcast();
    if (STEP_IDS.some((id) => !have(id))) ensureTools();
  })();
  return updating;
}

// ---------------------------------------------------------------- Pluck updates (new versions, themes and fixes)

type AppUpdate = { state: "idle" | "checking" | "downloading" | "ready" | "installer" | "latest" | "error"; latest: string; notes: string[]; pct: number; url: string; checked: number };
const appUpd: AppUpdate = { state: "idle", latest: "", notes: [], pct: 0, url: "", checked: 0 };
let appUpdRun: Promise<void> | null = null;
let restarting = false;
const UPD_DIR = join(ROOT, "update");
const NEXT_DIR = join(UPD_DIR, "next");

function semver(a: string, b: string): number {
  const x = a.split("."), y = b.split(".");
  for (let i = 0; i < 3; i++) { const d = (parseInt(x[i]) || 0) - (parseInt(y[i]) || 0); if (d) return Math.sign(d); }
  return 0;
}
function versionOf(dir: string): string | null {
  try { const v = JSON.parse(Deno.readTextFileSync(join(dir, "version.json"))).version; return typeof v === "string" ? v : null; } catch { return null; }
}
function badVersions(): string[] {
  try { const l = JSON.parse(Deno.readTextFileSync(join(UPD_DIR, "bad.json"))); return Array.isArray(l) ? l.map(String) : []; } catch { return []; }
}
async function sha256(path: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", await Deno.readFile(path));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

function checkAppUpdate(): Promise<void> {
  if (appUpdRun) return appUpdRun;
  if (!FEED || appUpd.state === "ready" || restarting) return Promise.resolve();
  appUpdRun = (async () => {
    const before = appUpd.state;
    appUpd.state = "checking"; broadcast();
    try {
      const r = await fetch(FEED, { headers: { "User-Agent": `Pluck/${VERSION}`, "Accept": "application/json" }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`feed HTTP ${r.status}`);
      const f = await r.json();
      appUpd.checked = Date.now();
      const v = String(f.version ?? "");
      if (!/^\d+\.\d+\.\d+$/.test(v) || semver(v, VERSION) <= 0 || badVersions().includes(v)) { appUpd.state = "latest"; return; }
      appUpd.latest = v;
      appUpd.notes = Array.isArray(f.notes) ? f.notes.map(String).slice(0, 12) : [];
      const dl = f.downloads ?? {};
      appUpd.url = String((isMac ? dl.mac : isWin ? dl.windows : "") || f.page || "");
      // This version needs a newer installer (or Pluck wasn't installed with one): send people to the download.
      if (!SHELL || Number(f.shell ?? 1) > SHELL) { appUpd.state = "installer"; return; }
      if (versionOf(NEXT_DIR) === v) { appUpd.state = "ready"; return; }
      appUpd.state = "downloading"; appUpd.pct = 0; broadcast();
      await Deno.mkdir(UPD_DIR, { recursive: true });
      const zip = join(UPD_DIR, "app.zip");
      await download(String(f.app?.url ?? ""), zip, (x) => { appUpd.pct = x; broadcast(); });
      if ((await sha256(zip)) !== String(f.app?.sha256 ?? "").toLowerCase()) throw new Error("update checksum didn't match");
      const stage = join(UPD_DIR, "next.tmp");
      await rmrf(stage);
      await unzip(zip, (n) => { const parts = safeRel(n); return parts ? join(stage, ...parts) : null; });
      if (versionOf(stage) !== v || !exists(join(stage, "server.ts")) || !exists(join(stage, "ui", "index.html"))) throw new Error("update package is incomplete");
      await rmrf(NEXT_DIR);
      await Deno.rename(stage, NEXT_DIR);
      await rmrf(zip);
      appUpd.state = "ready";
      log("update ready", v);
    } catch (e) {
      appUpd.state = before === "installer" ? "installer" : "error";
      log("app update failed", e instanceof Error ? e.message : String(e));
    } finally { appUpdRun = null; broadcast(); }
  })();
  return appUpdRun;
}

function busy(): boolean { return jobs.some((j) => j.status === "running" || j.status === "queued"); }

// Start a fresh copy through the launcher (which swaps in the staged update) and step aside.
function restartPluck() {
  if (restarting) return;
  restarting = true;
  const launcher = Deno.env.get("PLUCK_LAUNCHER");
  const entry = launcher && exists(launcher) ? launcher : join(APP_DIR, "server.ts");
  log("restarting to update", VERSION, "to", appUpd.latest);
  setTimeout(async () => {
    const args = ["run", "-A", "--no-prompt", "--no-config", entry];
    try {
      if (isWin) await detachWin(Deno.execPath(), args, { PLUCK_RESTART: "1" });
      else new Deno.Command(Deno.execPath(), { args, cwd: ROOT, env: { PLUCK_RESTART: "1" }, stdin: "null", stdout: "inherit", stderr: "inherit" }).spawn().unref();
    } catch (e) { log("restart failed", e); restarting = false; broadcast(); return; }
    Deno.exit(0);
  }, 300);
}

// ---------------------------------------------------------------- OS integration

async function osRun(cmd: string, args: string[], raw?: string): Promise<RunResult> {
  if (isWin && raw !== undefined) {
    try {
      const c = new Deno.Command(cmd, { args: [raw], windowsRawArguments: true, stdout: "piped", stderr: "piped" } as any);
      const o = await c.output();
      return { code: o.code, out: new TextDecoder().decode(o.stdout), err: new TextDecoder().decode(o.stderr), tail: [] };
    } catch (e) { return { code: -1, out: "", err: String(e), tail: [] }; }
  }
  return await run({ cmd, pre: [] }, args, { capture: true, timeoutMs: 600000 });
}

async function reveal(p: string) {
  if (isMac) await osRun("open", exists(p) && !Deno.statSync(p).isDirectory ? ["-R", p] : [p]);
  else if (isWin) { if (exists(p) && !Deno.statSync(p).isDirectory) await osRun("explorer.exe", [], `/select,"${p}"`); else await osRun("explorer.exe", [], `"${p}"`); }
  else await osRun("xdg-open", [exists(p) && !Deno.statSync(p).isDirectory ? parent(p) : p]);
}

async function pickFolder(): Promise<string | null> {
  if (isMac) {
    const r = await osRun("osascript", ["-e", "activate", "-e", `POSIX path of (choose folder with prompt "Choose where Pluck saves downloads")`]);
    return r.code === 0 && r.out.trim() ? r.out.trim().replace(/\/$/, "") : null;
  }
  if (isWin) {
    const ps = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form -Property @{TopMost=$true; ShowInTaskbar=$false; WindowState='Minimized'}; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Choose where Pluck saves downloads'; $d.UseDescriptionForTitle = $true; if ($d.ShowDialog($f) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }";
    const r = await osRun("powershell", ["-NoProfile", "-STA", "-Command", ps]);
    return r.out.trim() || null;
  }
  const r = await osRun("zenity", ["--file-selection", "--directory"]);
  return r.code === 0 ? r.out.trim() : null;
}

async function setOpenAtLogin(on: boolean) {
  try {
    if (isMac) {
      const dir = join(HOME, "Library", "LaunchAgents");
      const plist = join(dir, "com.matteblack.pluck.plist");
      if (on) {
        // Installed from the DMG: find the app by its id, wherever it lives. Older installs: by path.
        let target = ["-b", "com.matteblack.pluck"];
        if (!SHELL) {
          let app = "/Applications/Pluck.app";
          try { app = (await Deno.readTextFile(join(ROOT, "app-path.txt"))).trim() || app; } catch { /* default */ }
          target = ["-a", app];
        }
        const xml = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;");
        await Deno.mkdir(dir, { recursive: true });
        await Deno.writeTextFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.matteblack.pluck</string>
<key>ProgramArguments</key><array><string>/usr/bin/open</string>${target.map((t) => `<string>${xml(t)}</string>`).join("")}</array>
<key>RunAtLoad</key><true/>
<key>LimitLoadToSessionType</key><string>Aqua</string>
</dict></plist>
`);
      } else { try { await Deno.remove(plist); } catch { /* ignore */ } }
    } else if (isWin) {
      const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
      const exe = join(ROOT, "Pluck.exe");
      const startup = join(Deno.env.get("APPDATA") ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Pluck.vbs");
      if (on) {
        if (exists(exe)) {
          const r = await osRun("reg", ["add", key, "/v", "Pluck", "/t", "REG_SZ", "/d", `"${exe}"`, "/f"]);
          if (r.code !== 0) throw new Error(r.err || "reg add failed");
        } else await Deno.copyFile(join(ROOT, "Pluck.vbs"), startup);
      } else {
        await osRun("reg", ["delete", key, "/v", "Pluck", "/f"]);
        try { await Deno.remove(startup); } catch { /* ignore */ }
      }
    }
  } catch (e) { log("login item failed", e); throw new Friendly("Couldn't change the startup setting."); }
}

// On Windows, Deno ends its own child processes when it exits. Programs that must outlive this
// copy of Pluck (the window, or the fresh copy after an update) are started through "start".
async function detachWin(exe: string, args: string[], env: Record<string, string> = {}) {
  const r = await new Deno.Command("cmd.exe", { args: ["/d", "/c", "start", "", "/b", exe, ...args], cwd: ROOT, env, stdin: "null", stdout: "null", stderr: "null" }).output();
  if (r.code !== 0) throw new Error("start failed with code " + r.code);
}

async function openUrl(u: string) {
  if (!/^https:\/\/[^\s"']+$/.test(u)) return;
  if (isMac) await osRun("open", [u]);
  else if (isWin) await osRun("rundll32", ["url.dll,FileProtocolHandler", u]);
  else await osRun("xdg-open", [u]);
}

async function openWindow() {
  if (NO_WINDOW || NATIVE) return;
  const url = `http://127.0.0.1:${PORT}/`;
  const prof = join(ROOT, "window");
  const flags = [`--app=${url}`, `--user-data-dir=${prof}`, "--window-size=1200,820", "--no-first-run", "--no-default-browser-check", "--disable-features=Translate"];
  if (isMac) {
    const apps = ["Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium", "Vivaldi", "Arc"];
    for (const a of apps) {
      for (const dir of ["/Applications", join(HOME, "Applications")]) {
        if (exists(join(dir, a + ".app"))) { await osRun("open", ["-na", join(dir, a + ".app"), "--args", ...flags]); return; }
      }
    }
    await osRun("open", [url]);
    return;
  }
  if (isWin) {
    const pf = Deno.env.get("ProgramFiles") ?? "C:\\Program Files";
    const pf86 = Deno.env.get("ProgramFiles(x86)") ?? "C:\\Program Files (x86)";
    const la = Deno.env.get("LOCALAPPDATA") ?? "";
    const cands = [join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"), join(pf, "Microsoft", "Edge", "Application", "msedge.exe"), join(pf, "Google", "Chrome", "Application", "chrome.exe"), join(pf86, "Google", "Chrome", "Application", "chrome.exe"), join(la, "Google", "Chrome", "Application", "chrome.exe")];
    for (const c of cands) {
      if (exists(c)) { try { await detachWin(c, flags); return; } catch { /* try next */ } }
    }
    await osRun("cmd", ["/c", "start", "", url]);
    return;
  }
  try { new Deno.Command("xdg-open", { args: [url], stdout: "null", stderr: "null" }).spawn(); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- live updates (SSE)

type Client = { send: (s: string) => void; ping: ReturnType<typeof setInterval> };
const clients = new Set<Client>();
let lastSeen = Date.now();
let bTimer: ReturnType<typeof setTimeout> | undefined;
const enc = new TextEncoder();

function snapshot() {
  return { jobs: [...jobs].sort((a, b) => b.created - a.created).slice(0, 40).map(publicJob), update: updateState, setup, app: appUpd, restarting };
}
function broadcast() {
  if (bTimer) return;
  bTimer = setTimeout(() => {
    bTimer = undefined;
    const msg = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const c of clients) c.send(msg);
  }, 110);
}

// ---------------------------------------------------------------- http

function json(o: unknown, status = 200) { return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const host = req.headers.get("host") ?? "";
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return new Response("no", { status: 403 });
  const path = url.pathname;

  if (req.method === "GET") {
    if (path === "/" || path === "/index.html") {
      return new Response(await Deno.readTextFile(join(APP_DIR, "ui", "index.html")), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    if (path === "/icon.png") {
      try { return new Response(await Deno.readFile(join(APP_DIR, "ui", "icon.png")), { headers: { "content-type": "image/png" } }); } catch { return new Response("", { status: 404 }); }
    }
    if (path === "/api/state") {
      const news = settings.lastVersion && settings.lastVersion !== VERSION ? { version: VERSION, notes: VINFO.notes } : null;
      return json({ version: VERSION, shell: SHELL, os: OS, settings, browsers: detectBrowsers(), news, windows: clients.size, ...snapshot() });
    }
    if (path === "/api/events") {
      let client: Client;
      const body = new ReadableStream({
        start(ctrl) {
          client = {
            send: (s: string) => { try { ctrl.enqueue(enc.encode(s)); } catch { /* closed */ } },
            ping: setInterval(() => client.send(": ping\n\n"), 15000),
          };
          clients.add(client); lastSeen = Date.now();
          client.send(`data: ${JSON.stringify(snapshot())}\n\n`);
          req.signal.addEventListener("abort", () => { clearInterval(client.ping); clients.delete(client); lastSeen = Date.now(); try { ctrl.close(); } catch { /* ignore */ } });
        },
        cancel() { clearInterval(client.ping); clients.delete(client); lastSeen = Date.now(); },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "connection": "keep-alive" } });
    }
    if (path === "/api/thumb") {
      const site = req.headers.get("sec-fetch-site");
      if (site && site !== "same-origin") return new Response("", { status: 403 });
      const u = url.searchParams.get("u") ?? "";
      if (!/^https?:\/\//.test(u)) return new Response("", { status: 400 });
      try {
        const r = await fetch(u, { headers: { "User-Agent": UA, "Accept": "image/*" } });
        const ct = r.headers.get("content-type") ?? "";
        if (!r.ok || !ct.startsWith("image/")) return new Response("", { status: 404 });
        return new Response(r.body, { headers: { "content-type": ct, "cache-control": "max-age=86400" } });
      } catch { return new Response("", { status: 502 }); }
    }
    return new Response("Not found", { status: 404 });
  }

  if (req.method !== "POST" || req.headers.get("x-pluck") !== "1") return new Response("no", { status: 403 });
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  try {
    switch (path) {
      case "/api/probe": {
        let u = pickUrl(String(body.url ?? ""));
        try { new URL(u); } catch { throw new Friendly("That doesn't look like a link. Copy the full address and paste it again."); }
        if (setupRun) await setupRun;
        if (!have("ytdlp")) throw new Friendly("Pluck is still missing its download engine. Open Settings and choose Finish setup.");
        if (updating) await Promise.race([updating, sleep(20000)]);
        const info = await probe(u);
        probeCache.set(u, info);
        return json(info);
      }
      case "/api/download": {
        let u = pickUrl(String(body.url ?? ""));
        let info = probeCache.get(u);
        if (!info) { info = await probe(u); probeCache.set(u, info); }
        const j: Job = {
          id: uid(), url: u, info, mode: String(body.mode ?? "video"), quality: String(body.quality ?? "best"),
          select: Array.isArray(body.select) ? body.select.map(Number).filter((n: number) => Number.isInteger(n) && n >= 0 && n < info!.items.length) : [],
          dir: body.dir ? String(body.dir) : undefined,
          cut: parseCut(body.cut, info),
          status: "queued", phase: "queued", sub: "", pct: 0, speed: "", eta: "", item: 0, items: 0, files: [], folder: "", error: "", warn: "",
          created: Date.now(), endedAt: 0, procs: new Set(), canceled: false, tmp: "",
        };
        if (info.items.length > 1 && j.select.length === info.items.length) j.select = [];
        jobs.push(j); broadcast(); pump();
        return json(publicJob(j));
      }
      case "/api/cancel": {
        const j = jobs.find((x) => x.id === body.id);
        if (j && (j.status === "running" || j.status === "queued")) {
          j.canceled = true;
          for (const p of j.procs) killTree(p);
          if (j.status === "queued") { j.status = "canceled"; j.endedAt = Date.now(); }
          broadcast();
        }
        return json({ ok: true });
      }
      case "/api/retry": {
        const j = jobs.find((x) => x.id === body.id);
        if (j) {
          const n: Job = { ...j, id: uid(), status: "queued", phase: "queued", sub: "", pct: 0, speed: "", eta: "", item: 0, items: 0, files: [], folder: "", error: "", warn: "", created: Date.now(), endedAt: 0, procs: new Set(), canceled: false, tmp: "" };
          n.info = { ...j.info, attempt: 0 };
          const idx = jobs.indexOf(j); if (idx >= 0) jobs.splice(idx, 1);
          jobs.push(n); broadcast(); pump();
          return json(publicJob(n));
        }
        return json({ ok: false });
      }
      case "/api/clear": {
        for (let i = jobs.length - 1; i >= 0; i--) if (["done", "error", "canceled"].includes(jobs[i].status)) jobs.splice(i, 1);
        broadcast();
        return json({ ok: true });
      }
      case "/api/settings": {
        const allowed = ["theme", "outDir", "askEachTime", "ownFolders", "openAtLogin", "music", "sfx", "browser", "lastVersion"] as const;
        for (const k of allowed) {
          if (!(k in body)) continue;
          if (k === "openAtLogin" && body[k] !== settings.openAtLogin) await setOpenAtLogin(!!body[k]);
          if (k === "browser") browserCache = null;
          if (k === "lastVersion" && body[k] !== VERSION) continue;
          (settings as any)[k] = body[k];
        }
        await saveSettings();
        return json(settings);
      }
      case "/api/pick-folder": return json({ path: await pickFolder() });
      case "/api/reveal": { const p = String(body.path ?? ""); if (p) await reveal(p); return json({ ok: true }); }
      case "/api/open-folder": { const p = String(body.path ?? settings.outDir); await Deno.mkdir(p, { recursive: true }).catch(() => {}); await reveal(p); return json({ ok: true }); }
      case "/api/update": { updateTools(true); checkAppUpdate(); return json({ ok: true }); }
      case "/api/setup": { ensureTools(); return json({ ok: true }); }
      case "/api/restart": {
        if (appUpd.state !== "ready") throw new Friendly("There's no update waiting.");
        if (busy()) throw new Friendly("Pluck will be ready to restart when your downloads finish.");
        if (setupRun) throw new Friendly("Pluck is still setting up. Try again in a minute.");
        restartPluck(); broadcast();
        return json({ ok: true });
      }
      case "/api/open-url": { await openUrl(String(body.url ?? "")); return json({ ok: true }); }
    }
    return json({ error: "Unknown request" }, 404);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return json({ error: e instanceof Friendly ? m : friendly(m) }, 400);
  }
}

// ---------------------------------------------------------------- start

await loadSettings();
if (!settings.lastVersion) { settings.lastVersion = VERSION; await saveSettings(); }
for (let i = 0; ; i++) {
  try { Deno.serve({ port: PORT, hostname: "127.0.0.1", onListen: () => {} }, handle); break; }
  catch (e) {
    if (!(e instanceof Deno.errors.AddrInUse)) throw e;
    // After "Restart to update" the old copy may need a moment to let go of the port.
    if (RESTARTED && i < 60) { await sleep(250); continue; }
    await openWindow();
    Deno.exit(0);
  }
}
log("Pluck started", VERSION, OS, SHELL ? `launcher ${SHELL}` : "no launcher", RESTARTED ? "after update" : "");
if (!RESTARTED) await openWindow();
ensureTools();
versions().then(() => broadcast());
setTimeout(() => updateTools(false), 1500);
setInterval(() => updateTools(false), 6 * 3600 * 1000);
setTimeout(() => checkAppUpdate(), 8000);
setInterval(() => checkAppUpdate(), 6 * 3600 * 1000);
setInterval(() => {
  if (NO_EXIT || setupRun || appUpdRun || restarting || busy()) return;
  if (clients.size === 0 && Date.now() - lastSeen > 25000 && Date.now() - startedAt > 60000) Deno.exit(0);
}, 5000);
