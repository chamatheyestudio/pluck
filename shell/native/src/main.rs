// Pluck: the app window. Made by Matte Black.
//
// A small native window around Pluck's engine (the local server in app/server.ts). It starts the
// engine in the background, shows a warm up screen until the engine answers, then shows Pluck.
// Closing the window quits the app; the engine finishes any downloads and then stops by itself.
// This file ships inside the installers and is not auto updated, so keep it small and stable.

#![cfg_attr(windows, windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use tao::dpi::LogicalSize;
use tao::event::{Event, StartCause, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::{Icon, Theme, WindowBuilder};
use wry::{NewWindowResponse, WebContext, WebViewBuilder};

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
}

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
        std::thread::spawn(move || {
            start_engine();
            let t = Instant::now();
            let mut told_slow = false;
            loop {
                if engine_up() {
                    let _ = proxy.send_event(Msg::Ready);
                    return;
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
        });
    }

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

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        let _ = &context;
        match event {
            Event::NewEvents(StartCause::Init) => {
                #[cfg(target_os = "macos")]
                {
                    menu.0.init_for_nsapp();
                    menu.1.set_as_windows_menu_for_nsapp();
                }
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
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    });
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
