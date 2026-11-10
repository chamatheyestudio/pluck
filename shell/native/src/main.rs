// Pluck: the app window. Made by Matte Black.
//
// A small native window around Pluck's engine (the local server in app/server.ts). It starts the
// engine in the background, shows a warm up screen until the engine answers, then shows Pluck.
// It also watches for copied links: when one is copied anywhere, a small card pops up in the corner
// (the card is app/ui/popup.html, so it updates with the app). While that is on, closing the window
// keeps Pluck running (Dock on Mac, tray on Windows). Otherwise closing quits; the engine finishes
// any downloads and then stops by itself.
// This file ships inside the installers and is not auto updated, so keep it small and stable.

#![cfg_attr(windows, windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tao::dpi::{LogicalPosition, LogicalSize};
use tao::event::{Event, StartCause, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopWindowTarget};
use tao::window::{Icon, Theme, Window, WindowBuilder};
use wry::{NewWindowResponse, WebContext, WebView, WebViewBuilder};

const ENGINE: &str = "127.0.0.1:47821";
const HOME: &str = "http://127.0.0.1:47821/";
const INSTANCE: &str = "127.0.0.1:47822";
const BG: (u8, u8, u8, u8) = (7, 7, 7, 255);

const WARMUP: &str = r#"<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#070707;color:#8A8A8A;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px;-webkit-user-select:none;user-select:none;cursor:default}
.rec{width:132px;height:132px;border-radius:50%;position:relative;background:conic-gradient(from 0deg,rgba(255,255,255,.09),transparent 18%,transparent 50%,rgba(255,255,255,.06) 62%,transparent 78%),repeating-radial-gradient(circle,#161616 0 1.5px,#0b0b0b 1.5px 4.5px);box-shadow:0 0 0 1px #1e1e1e,0 24px 60px rgba(0,0,0,.7);animation:spin 1.8s linear infinite}
.rec:after{content:"";position:absolute;inset:44px;border-radius:50%;background:#C9B48A}
.rec:before{content:"";position:absolute;left:64px;top:64px;width:4px;height:4px;border-radius:50%;background:#070707;z-index:1}
@keyframes spin{to{transform:rotate(360deg)}}
.t{font-size:15px;letter-spacing:.02em}.t b{color:#E6E2DA;font-weight:600}
.s{font-size:12px;color:#5E5E5E;min-height:16px;text-align:center;max-width:360px;line-height:1.5}
</style></head><body><div class="rec" id="rec"></div><div class="t"><b>pluck</b> is warming up</div><div class="s" id="msg"></div></body></html>"#;

enum Msg {
    Ready,
    Slow,
    Failed,
    Show,
    Quit,
    /// A link was copied that Pluck can save.
    Clip(String),
    /// A message from the copied link card.
    Card(String),
}

/// The copied link card. The web view goes before the window so it is dropped first.
struct Card {
    web: WebView,
    win: Window,
}

const CARD_W: f64 = 380.0;

fn main() {
    if std::env::args().any(|a| a == "--smoke") {
        // Used by the release tests: start the engine and report, no window.
        start_engine();
        let ok = wait_ready(Duration::from_secs(120));
        println!("{}", if ok { "Pluck engine is up" } else { "Pluck engine did not start" });
        std::process::exit(if ok { 0 } else { 1 });
    }

    // One Pluck at a time. A second launch just brings the open window forward.
    let listener = match TcpListener::bind(INSTANCE) {
        Ok(l) => Some(l),
        Err(_) => {
            let addr: SocketAddr = INSTANCE.parse().unwrap();
            if let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(800)) {
                let _ = s.write_all(b"show\n");
                return;
            }
            None
        }
    };

    let background = std::env::args().any(|a| a == "--background");
    let popup_on = Arc::new(AtomicBool::new(true));
    let event_loop = EventLoopBuilder::<Msg>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    #[cfg(target_os = "macos")]
    let menu = mac_menu();

    // 1200 x 820 when it fits, smaller on small screens.
    let (mut w, mut h) = (1200.0_f64, 820.0_f64);
    if let Some(m) = event_loop.primary_monitor() {
        let s: LogicalSize<f64> = m.size().to_logical(m.scale_factor());
        w = w.min(s.width * 0.94);
        h = h.min(s.height * 0.88);
    }
    let window = WindowBuilder::new()
        .with_title("Pluck")
        .with_inner_size(LogicalSize::new(w, h))
        .with_min_inner_size(LogicalSize::new(w.min(980.0), h.min(640.0)))
        .with_theme(Some(Theme::Dark))
        .with_background_color(BG)
        .with_visible(!background)
        .with_window_icon(Icon::from_rgba(include_bytes!("../icon64.rgba").to_vec(), 64, 64).ok())
        .build(&event_loop)
        .expect("could not open the Pluck window");

    let mut context = WebContext::new(data_dir());
    let builder = WebViewBuilder::new_with_web_context(&mut context)
        .with_html(WARMUP)
        .with_background_color(BG)
        .with_devtools(false)
        .with_clipboard(true)
        .with_autoplay(true)
        .with_accept_first_mouse(true)
        .with_navigation_handler(|url: String| {
            if url.starts_with("http://") || url.starts_with("https://") {
                if url.starts_with(HOME) || url == HOME.trim_end_matches('/') {
                    return true;
                }
                open_external(&url);
                return false;
            }
            true
        })
        .with_new_window_req_handler(|url: String, _features| {
            open_external(&url);
            NewWindowResponse::Deny
        });

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    let built = builder.build(&window);
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let built = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        builder.build_gtk(window.default_vbox().unwrap())
    };

    let webview = match built {
        Ok(w) => w,
        Err(_) => {
            // No system web view (very old Windows without WebView2): fall back to the browser.
            start_engine();
            if wait_ready(Duration::from_secs(60)) {
                open_external(HOME);
            }
            return;
        }
    };

    // Start the engine and wait for it on a side thread.
    {
        let proxy = proxy.clone();
        let popup_on = popup_on.clone();
        std::thread::spawn(move || {
            start_engine();
            let t = Instant::now();
            let mut told_slow = false;
            loop {
                if engine_up() {
                    let _ = proxy.send_event(Msg::Ready);
                    break;
                }
                if !told_slow && t.elapsed() > Duration::from_secs(12) {
                    told_slow = true;
                    let _ = proxy.send_event(Msg::Slow);
                }
                if t.elapsed() > Duration::from_secs(90) {
                    let _ = proxy.send_event(Msg::Failed);
                    return;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
            // Check in with the engine now and then, and keep the popup setting in step.
            loop {
                if let Some(b) = http_get("/api/native") {
                    popup_on.store(b.contains("\"popup\":true"), Ordering::Relaxed);
                } else {
                    start_engine();
                }
                std::thread::sleep(Duration::from_secs(10));
            }
        });
    }
    #[cfg(any(target_os = "macos", windows))]
    watch_clipboard(proxy.clone(), popup_on.clone());

    #[cfg(windows)]
    {
        let p = proxy.clone();
        tray_icon::menu::MenuEvent::set_event_handler(Some(move |e: tray_icon::menu::MenuEvent| {
            let _ = p.send_event(if e.id.0 == "quit" { Msg::Quit } else { Msg::Show });
        }));
        let p = proxy.clone();
        tray_icon::TrayIconEvent::set_event_handler(Some(move |e: tray_icon::TrayIconEvent| {
            use tray_icon::{MouseButton, MouseButtonState, TrayIconEvent};
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                let _ = p.send_event(Msg::Show);
            }
        }));
    }
    #[cfg(windows)]
    let mut tray: Option<tray_icon::TrayIcon> = None;
    let mut card: Option<Card> = None;

    if let Some(l) = listener {
        let proxy = proxy.clone();
        std::thread::spawn(move || {
            for s in l.incoming() {
                if s.is_ok() {
                    let _ = proxy.send_event(Msg::Show);
                }
            }
        });
    }

    event_loop.run(move |event, target, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::NewEvents(StartCause::Init) => {
                #[cfg(target_os = "macos")]
                {
                    menu.0.init_for_nsapp();
                    menu.1.set_as_windows_menu_for_nsapp();
                }
                #[cfg(windows)]
                {
                    tray = make_tray();
                }
            }
            Event::UserEvent(Msg::Clip(url)) => {
                // Copied inside Pluck itself: the window handles it.
                if window.is_visible() && window.is_focused() {
                    return;
                }
                card = None;
                card = open_card(target, &mut context, &proxy, &url);
            }
            Event::UserEvent(Msg::Card(m)) => {
                if m == "close" {
                    card = None;
                } else if let Some(h) = m.strip_prefix("size:") {
                    if let (Some(c), Ok(h)) = (card.as_ref(), h.trim().parse::<f64>()) {
                        place_card(target, &c.win, h.clamp(80.0, 260.0));
                    }
                } else if let Some(u) = m.strip_prefix("open:") {
                    card = None;
                    window.set_visible(true);
                    window.set_minimized(false);
                    window.set_focus();
                    let js = format!("window.pluckOpenLink && window.pluckOpenLink({})", js_string(u));
                    let _ = webview.evaluate_script(&js);
                }
            }
            Event::UserEvent(Msg::Quit) => {
                card = None;
                #[cfg(windows)]
                {
                    tray = None;
                }
                *control_flow = ControlFlow::Exit;
            }
            Event::UserEvent(Msg::Ready) => {
                let _ = webview.load_url(HOME);
            }
            Event::UserEvent(Msg::Slow) => {
                let _ = webview.evaluate_script("document.getElementById('msg').textContent='The first start takes a little longer.'");
            }
            Event::UserEvent(Msg::Failed) => {
                let _ = webview.evaluate_script("document.getElementById('rec').style.animation='none';document.getElementById('msg').textContent='Pluck could not start its engine. Quit Pluck and open it again. If it keeps happening, reinstall Pluck.'");
            }
            Event::UserEvent(Msg::Show) | Event::Reopen { .. } => {
                window.set_visible(true);
                window.set_minimized(false);
                window.set_focus();
            }
            Event::WindowEvent { event: WindowEvent::CloseRequested, window_id, .. } => {
                if let Some(c) = card.as_ref() {
                    if c.win.id() == window_id {
                        card = None;
                        return;
                    }
                }
                // With link popups on, Pluck stays around (Dock on Mac, tray on Windows).
                if popup_on.load(Ordering::Relaxed) {
                    window.set_visible(false);
                } else {
                    *control_flow = ControlFlow::Exit;
                }
            }
            _ => {}
        }
    });
}

/// Open the copied link card in the corner of the screen, without taking focus.
fn open_card(target: &EventLoopWindowTarget<Msg>, context: &mut WebContext, proxy: &tao::event_loop::EventLoopProxy<Msg>, url: &str) -> Option<Card> {
    let b = WindowBuilder::new()
        .with_title("Pluck")
        .with_decorations(false)
        .with_resizable(false)
        .with_always_on_top(true)
        .with_focused(false)
        .with_visible(false)
        .with_inner_size(LogicalSize::new(CARD_W, 100.0))
        .with_background_color(BG);
    #[cfg(windows)]
    let b = {
        use tao::platform::windows::WindowBuilderExtWindows;
        b.with_skip_taskbar(true)
    };
    let win = b.build(target).ok()?;
    place_card(target, &win, 100.0);
    let p = proxy.clone();
    let wb = WebViewBuilder::new_with_web_context(context)
        .with_url(format!("{HOME}popup?u={}", enc(url)))
        .with_background_color(BG)
        .with_devtools(false)
        .with_focused(false)
        .with_accept_first_mouse(true)
        .with_ipc_handler(move |req: wry::http::Request<String>| {
            let _ = p.send_event(Msg::Card(req.body().clone()));
        })
        .with_navigation_handler(|u: String| {
            if u.starts_with(HOME) {
                return true;
            }
            open_external(&u);
            false
        });
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    let web = wb.build(&win).ok()?;
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let web = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        wb.build_gtk(win.default_vbox()?).ok()?
    };
    win.set_visible(true);
    Some(Card { web, win })
}

/// Top right on a Mac (where notifications go), bottom right above the taskbar on Windows.
fn place_card(target: &EventLoopWindowTarget<Msg>, win: &Window, h: f64) {
    win.set_inner_size(LogicalSize::new(CARD_W, h));
    let Some(m) = win.current_monitor().or_else(|| target.primary_monitor()) else { return };
    let size: LogicalSize<f64> = m.size().to_logical(m.scale_factor());
    let origin: LogicalPosition<f64> = m.position().to_logical(m.scale_factor());
    let x = origin.x + size.width - CARD_W - 16.0;
    let y = if cfg!(target_os = "macos") { origin.y + 44.0 } else { origin.y + size.height - h - 64.0 };
    win.set_outer_position(LogicalPosition::new(x, y));
}

/// Watch the clipboard for copied links and ask the engine whether each one is worth a card.
#[cfg(any(target_os = "macos", windows))]
fn watch_clipboard(proxy: tao::event_loop::EventLoopProxy<Msg>, on: Arc<AtomicBool>) {
    #[cfg(windows)]
    #[link(name = "user32")]
    extern "system" {
        fn GetClipboardSequenceNumber() -> u32;
    }
    std::thread::spawn(move || {
        let mut cb: Option<arboard::Clipboard> = None;
        let mut last: Option<String> = None;
        #[cfg(windows)]
        let mut seq = 0u32;
        loop {
            std::thread::sleep(Duration::from_millis(600));
            // Only look when something new was copied, so Pluck never gets in the way of copy and paste.
            #[cfg(windows)]
            {
                let s = unsafe { GetClipboardSequenceNumber() };
                if s == seq {
                    continue;
                }
                note(&format!("clipboard changed {seq} -> {s}"));
                seq = s;
            }
            if cb.is_none() {
                cb = match arboard::Clipboard::new() {
                    Ok(c) => Some(c),
                    Err(e) => {
                        note(&format!("clipboard open failed: {e}"));
                        None
                    }
                };
            }
            let Some(c) = cb.as_mut() else { continue };
            let text = match c.get_text() {
                Ok(t) => t,
                // Something that isn't text (a picture, a file): nothing to do.
                Err(arboard::Error::ContentNotAvailable) => String::new(),
                // The clipboard is busy (another app is still writing to it): look again shortly.
                Err(e) => {
                    note(&format!("clipboard read failed: {e}"));
                    #[cfg(windows)]
                    {
                        seq = seq.wrapping_sub(1);
                    }
                    cb = None;
                    continue;
                }
            };
            if last.as_deref() == Some(text.as_str()) {
                continue;
            }
            let first = last.is_none();
            note(&format!("copied {} chars, first={first}", text.len()));
            last = Some(text.clone());
            // Whatever was copied before Pluck started doesn't count.
            if first || !on.load(Ordering::Relaxed) {
                continue;
            }
            let t = text.trim();
            if t.len() < 8 || t.len() > 4000 || !(t.contains("http") || t.contains('/')) {
                continue;
            }
            if let Some(body) = http_get(&format!("/api/clip?u={}", enc(t))) {
                if body.contains("\"show\":true") {
                    if let Some(u) = json_str(&body, "url") {
                        let _ = proxy.send_event(Msg::Clip(u));
                    }
                }
            }
        }
    });
}

#[cfg(windows)]
fn make_tray() -> Option<tray_icon::TrayIcon> {
    use tray_icon::menu::{Menu, MenuItem, PredefinedMenuItem};
    let m = Menu::new();
    let open = MenuItem::with_id("open", "Open Pluck", true, None);
    let quit = MenuItem::with_id("quit", "Quit Pluck", true, None);
    m.append_items(&[&open, &PredefinedMenuItem::separator(), &quit]).ok()?;
    let icon = tray_icon::Icon::from_rgba(include_bytes!("../icon64.rgba").to_vec(), 64, 64).ok()?;
    tray_icon::TrayIconBuilder::new()
        .with_menu(Box::new(m))
        .with_menu_on_left_click(false)
        .with_tooltip("Pluck. Copy a link to save it.")
        .with_icon(icon)
        .build()
        .ok()
}

/// Notes for the release tests, only when PLUCK_NATIVE_LOG names a file.
fn note(m: &str) {
    if let Some(p) = std::env::var_os("PLUCK_NATIVE_LOG") {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
            let _ = writeln!(f, "{m}");
        }
    }
}

/// A plain GET to the engine. Returns the body.
fn http_get(path: &str) -> Option<String> {
    let addr: SocketAddr = ENGINE.parse().unwrap();
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(600)).ok()?;
    let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
    let req = format!("GET {path} HTTP/1.1\r\nHost: {ENGINE}\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes()).ok()?;
    let mut buf = Vec::new();
    let _ = s.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf).to_string();
    if !text.starts_with("HTTP/1.1 200") {
        return None;
    }
    text.split_once("\r\n\r\n").map(|(_, b)| b.to_string())
}

/// Percent encode for a query string.
fn enc(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            o.push(b as char);
        } else {
            o.push_str(&format!("%{b:02X}"));
        }
    }
    o
}

/// Read one string value out of a small JSON reply.
fn json_str(body: &str, key: &str) -> Option<String> {
    let start = body.find(&format!("\"{key}\":\""))? + key.len() + 4;
    let mut out = String::new();
    let mut chars = body[start..].chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return Some(out),
            '\\' => match chars.next()? {
                'n' => out.push('\n'),
                't' => out.push('\t'),
                'u' => {
                    let h: String = chars.by_ref().take(4).collect();
                    out.push(char::from_u32(u32::from_str_radix(&h, 16).ok()?).unwrap_or('?'));
                }
                o => out.push(o),
            },
            _ => out.push(c),
        }
    }
    None
}

/// A JavaScript string literal.
fn js_string(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' | '\r' | '\u{2028}' | '\u{2029}' => o.push(' '),
            '<' => o.push_str("\\u003c"),
            _ => o.push(c),
        }
    }
    o.push('"');
    o
}

/// Is the engine answering?
fn engine_up() -> bool {
    let addr: SocketAddr = ENGINE.parse().unwrap();
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(400)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(4)));
    if s.write_all(b"GET /api/state HTTP/1.1\r\nHost: 127.0.0.1:47821\r\nConnection: close\r\n\r\n").is_err() {
        return false;
    }
    let mut buf = [0u8; 32];
    match s.read(&mut buf) {
        Ok(n) if n >= 12 => buf[..n].starts_with(b"HTTP/1.1 200"),
        _ => false,
    }
}

fn wait_ready(limit: Duration) -> bool {
    let t = Instant::now();
    while t.elapsed() < limit {
        if engine_up() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    false
}

/// Start the engine in the background (it keeps going if this window closes mid download).
fn start_engine() {
    if std::env::var_os("PLUCK_DEV_NO_ENGINE").is_some() || engine_up() {
        return;
    }
    let exe = std::env::current_exe().unwrap_or_default();
    let dir = exe.parent().map(|p| p.to_path_buf()).unwrap_or_default();

    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("/bin/bash");
        c.arg(dir.join("../Resources/launch.sh"));
        c
    };
    #[cfg(windows)]
    let mut cmd = Command::new(dir.join("bin").join("engine.exe"));
    #[cfg(not(any(target_os = "macos", windows)))]
    let mut cmd = match std::env::var_os("PLUCK_ENGINE") {
        Some(p) => Command::new(p),
        None => {
            let _ = dir;
            return;
        }
    };

    cmd.env("PLUCK_NATIVE", "1").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let _ = cmd.spawn();
}

/// Where the web view keeps its own data.
fn data_dir() -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA").map(|d| std::path::PathBuf::from(d).join("Pluck").join("webview"))
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Open a link in the person's own browser.
fn open_external(url: &str) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    #[cfg(target_os = "macos")]
    let r = Command::new("/usr/bin/open").arg(url).spawn();
    #[cfg(windows)]
    let r = Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).spawn();
    #[cfg(not(any(target_os = "macos", windows)))]
    let r = Command::new("xdg-open").arg(url).spawn();
    let _ = r;
}

/// The Mac menu bar. Without an Edit menu, copy and paste shortcuts don't reach the page.
#[cfg(target_os = "macos")]
fn mac_menu() -> (muda::Menu, muda::Submenu) {
    use muda::{AboutMetadata, Menu, PredefinedMenuItem as P, Submenu};
    let about = AboutMetadata {
        name: Some("Pluck".into()),
        copyright: Some("Made by Matte Black. Free, always.".into()),
        ..Default::default()
    };
    let app = Submenu::with_items(
        "Pluck",
        true,
        &[
            &P::about(Some("About Pluck"), Some(about)),
            &P::separator(),
            &P::hide(Some("Hide Pluck")),
            &P::hide_others(None),
            &P::show_all(None),
            &P::separator(),
            &P::quit(Some("Quit Pluck")),
        ],
    )
    .unwrap();
    let edit = Submenu::with_items(
        "Edit",
        true,
        &[&P::undo(None), &P::redo(None), &P::separator(), &P::cut(None), &P::copy(None), &P::paste(None), &P::select_all(None)],
    )
    .unwrap();
    let window = Submenu::with_items("Window", true, &[&P::minimize(None), &P::fullscreen(None), &P::separator(), &P::close_window(None)]).unwrap();
    let menu = Menu::with_items(&[&app, &edit, &window]).unwrap();
    (menu, window)
}
