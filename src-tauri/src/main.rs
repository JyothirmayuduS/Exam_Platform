// Vignan OS — Lockdown Exam Browser (Tauri v2)
//
// Boots the student straight into the exam in a kiosk window (fullscreen,
// always-on-top, no decorations) and injects a lockdown layer that blocks the
// usual escape hatches: right-click, devtools shortcuts, copy/cut/paste,
// printing, text selection, and drag-and-drop. There is no onboarding — the
// window opens directly on the exam.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, WindowEvent};

const LOCKDOWN_JS: &str = r#"
(() => {
  if (window.__vignanLockdown) return;
  window.__vignanLockdown = true;
  const block = (e) => { e.preventDefault(); e.stopPropagation(); return false; };

  // No right-click context menu.
  document.addEventListener('contextmenu', block, true);

  // No copy / cut / paste / drag of exam content.
  ['copy','cut','paste','dragstart','drop','selectstart'].forEach((evt) =>
    document.addEventListener(evt, block, true));

  // Strict keyboard: no modifier combination of any kind (Cmd/Ctrl/Option/
  // Win), no Escape, no function keys, no OS/system keys. Plain typing, Shift,
  // Tab, Enter, Backspace and the arrows stay usable for answers. keyup too:
  // Win+Shift+S and some macOS shortcuts act on release.
  const SYSTEM_KEYS = new Set(['escape','printscreen','snapshot','contextmenu','meta','os','super','hyper','fn','fnlock','help',
    'browserback','browserforward','browserrefresh','browserhome','browsersearch','launchapplication1','launchapplication2','launchmail']);
  const blockedCombo = (e) => {
    const k = (e.key || '').toLowerCase();
    if (e.metaKey || e.ctrlKey || e.altKey) return true;
    if (SYSTEM_KEYS.has(k)) return true;
    if (/^f\d{1,2}$/.test(k)) return true;
    return false;
  };
  const onKey = (e) => {
    if (!blockedCombo(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if ((e.key || '').toLowerCase() === 'printscreen') navigator.clipboard?.writeText('').catch(() => {});
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  window.addEventListener('keypress', onKey, true);
  // No pinch / Ctrl+wheel zoom and no paste/drop via input events.
  ['gesturestart','gesturechange','gestureend'].forEach((evt) => document.addEventListener(evt, block, true));
  window.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) block(e); }, { capture: true, passive: false });
  document.addEventListener('beforeinput', (e) => {
    if (e.inputType === 'insertFromPaste' || e.inputType === 'insertFromDrop' || e.inputType === 'insertFromYank') block(e);
  }, true);
  document.addEventListener('auxclick', block, true);

  // NOTE: deliberately do NOT touch window.__TAURI_INTERNALS__ / __TAURI__
  // here. Tauri injects its REAL IPC bridge into this webview before page
  // scripts run, and overwriting it with a plain boolean destroyed every
  // invoke()/listen() from the web layer — the kiosk could never fetch the
  // launch URL or receive deep-link/lockdown events (the "app opens but
  // nothing triggers" bug). isTauri() detects the genuine injected globals,
  // so no fake markers are needed.

  // Warn the invigilator layer when the window loses focus (possible cheating).
  window.addEventListener('blur', () => {
    window.dispatchEvent(new CustomEvent('lockdown:focus-lost'));
  });

  // Disable text selection visually. Runs at document start, so wait for a root.
  const addStyle = () => {
    const root = document.head || document.documentElement;
    if (!root) return false;
    const style = document.createElement('style');
    style.textContent = '*{-webkit-user-select:none!important;user-select:none!important;} input,textarea{-webkit-user-select:text!important;user-select:text!important;}';
    root.appendChild(style);
    return true;
  };
  if (!addStyle()) document.addEventListener('DOMContentLoaded', addStyle, { once: true });
})();
"#;

#[tauri::command]
fn check_prohibited_apps() -> Vec<String> {
    use sysinfo::System;
    let mut sys = System::new_all();
    sys.refresh_all();
    
    let prohibited = vec![
        "anydesk", "teamviewer", "zoom.us", "zoom.exe", "skype", "discord", "rustdesk",
        "dwservice", "zoho", "logmein", "splashtop", "chrome remote desktop", "vncserver", "vncviewer", "realvnc",
        "cheatengine", "x64dbg", "wireshark", "processhacker", "ollydbg", "fiddler", "charles"
    ];
    
    let mut found = Vec::new();
    
    for (_pid, process) in sys.processes() {
        let name_os = process.name();
        let name_str = name_os.to_string_lossy();
        let name_lower = name_str.to_lowercase();
        
        // Exclude common false positives
        if name_lower.contains("zoom") && name_lower.contains("window") { continue; } // window zoom daemon
        
        for p in &prohibited {
            if name_lower.contains(p) {
                // If it's just "zoom", make sure it's the actual app, not something else.
                // We added "zoom.us" and "zoom.exe", but if we still need "zoom", we can just rely on the above exclusions.
                found.push(name_str.to_string());
                break;
            }
        }
    }
    
    found.sort();
    found.dedup();
    found
}

#[cfg(target_os = "windows")]
fn disable_task_manager() {
    let _ = std::process::Command::new("reg")
        .args(&["add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System", "/v", "DisableTaskMgr", "/t", "REG_DWORD", "/d", "1", "/f"])
        .output();
}

#[cfg(target_os = "windows")]
fn enable_task_manager() {
    let _ = std::process::Command::new("reg")
        .args(&["add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System", "/v", "DisableTaskMgr", "/t", "REG_DWORD", "/d", "0", "/f"])
        .output();
}

#[cfg(not(target_os = "windows"))]
fn disable_task_manager() {}

#[cfg(not(target_os = "windows"))]
fn enable_task_manager() {}

fn detect_vm() -> bool {
    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = std::process::Command::new("wmic").args(&["computersystem", "get", "manufacturer,model"]).output() {
            let out_str = String::from_utf8_lossy(&output.stdout).to_lowercase();
            if out_str.contains("vmware") || out_str.contains("virtualbox") || out_str.contains("qemu") || out_str.contains("parallels") {
                return true;
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("sysctl").args(&["-n", "hw.model"]).output() {
            let out_str = String::from_utf8_lossy(&output.stdout).to_lowercase();
            if out_str.contains("vmware") || out_str.contains("virtual") || out_str.contains("parallels") {
                return true;
            }
        }
        if let Ok(output) = std::process::Command::new("system_profiler").arg("SPHardwareDataType").output() {
            let out_str = String::from_utf8_lossy(&output.stdout).to_lowercase();
            if out_str.contains("vmware") || out_str.contains("virtualbox") || out_str.contains("parallels") || out_str.contains("qemu") {
                return true;
            }
        }
    }
    false
}

/// Read the plugin's live URL state, not a setup-time snapshot. macOS delivers
/// its launch URL through RunEvent::Opened, which may arrive AFTER setup().
/// The frontend subscribes to new-url events before invoking this command.
#[tauri::command]
fn vignan_launch_url(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_deep_link::DeepLinkExt;
    app.deep_link()
        .get_current()
        .ok()
        .flatten()
        .and_then(|urls| urls.into_iter().find(|url| url.scheme() == "vignan-exam"))
        .map(|url| url.to_string())
}

/// Handoff probe used by scripts/lockdown/smoke-handoff.mjs.
///
/// The exam window is excluded from screen capture, so verifying "did the deep
/// link land on the system check?" cannot rely on pixels. When the app is built
/// with VIGNAN_PROBE=1, this command records the payload the webview injected
/// (route, title, visible text) to a temp file the smoke script reads.
///
/// It is opt-in at COMPILE time: release installers built by CI (which never
/// sets VIGNAN_PROBE) compile the body out entirely, so a candidate can never
/// read app state on demand.
#[tauri::command]
fn lockdown_log_probe(payload: String) {
    if option_env!("VIGNAN_PROBE").is_some() {
        let path = std::env::temp_dir().join("vignan_probe.json");
        let _ = std::fs::write(path, payload);
    }
    let _ = payload;
}

/// Open the normal browser-side student console before the kiosk exits.
/// Only web URLs are accepted; the frontend supplies the configured public app
/// origin, so an exam cannot use this command as an arbitrary process launcher.
#[tauri::command]
fn open_student_side(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("student-side URL must use http or https".into());
    }

    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("open").arg(&url).status();
    #[cfg(target_os = "windows")]
    let status = std::process::Command::new("cmd")
        .args(["/C", "start", "", &url])
        .status();
    #[cfg(target_os = "linux")]
    let status = std::process::Command::new("xdg-open").arg(&url).status();

    status
        .map_err(|err| format!("could not open student side: {err}"))
        .and_then(|result| {
            if result.success() {
                Ok(())
            } else {
                Err(format!("browser exited with status {result}"))
            }
        })
}

#[tauri::command]
fn exit_app() {
    enable_task_manager();
    let flag_path = std::env::temp_dir().join("vignan_exit.flag");
    let _ = std::fs::write(flag_path, "1");
    std::process::exit(0);
}

#[cfg(target_os = "macos")]
#[link(name = "AVFoundation", kind = "framework")]
extern "C" {}

#[cfg(target_os = "macos")]
fn av_media_type(kind: &str) -> *mut objc2::runtime::AnyObject {
    let media_type = if kind == "microphone" { "soun" } else { "vide" };
    let c = std::ffi::CString::new(media_type).unwrap();
    unsafe { objc2::msg_send![objc2::class!(NSString), stringWithUTF8String: c.as_ptr()] }
}

#[cfg(target_os = "macos")]
fn av_status(kind: &str) -> String {
    unsafe {
        let status: isize = objc2::msg_send![objc2::class!(AVCaptureDevice), authorizationStatusForMediaType: av_media_type(kind)];
        match status {
            3 => "granted",
            1 | 2 => "denied",
            _ => "prompt",
        }
        .to_string()
    }
}

/// Current OS camera/microphone permission without prompting. A macOS TCC
/// "Don't Allow" is remembered by bundle id; only System Settings undoes it.
/// Windows WebView2 grants web media permissions implicitly.
#[tauri::command]
fn media_permission_prompt(kind: String) -> String {
    #[cfg(target_os = "macos")]
    {
        av_status(&kind)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = kind;
        // WebView2 does not gate getUserMedia behind an OS dialog.
        "granted".to_string()
    }
}

/// Show the native camera / microphone dialog (when not yet decided) and wait
/// for the student's answer. Returns "granted", "denied" or "prompt" (timed out).
#[tauri::command]
async fn request_media_access(kind: String) -> String {
    #[cfg(target_os = "macos")]
    {
        let current = av_status(&kind);
        if current != "prompt" {
            return current;
        }
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        {
            let tx = std::sync::Mutex::new(Some(tx));
            let handler = block2::RcBlock::new(move |granted: objc2::runtime::Bool| {
                if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
                    let _ = tx.send(granted.as_bool());
                }
            });
            unsafe {
                let _: () = objc2::msg_send![objc2::class!(AVCaptureDevice), requestAccessForMediaType: av_media_type(&kind), completionHandler: &*handler];
            }
        }
        let answer = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(120)))
            .await
            .ok()
            .and_then(|r| r.ok());
        match answer {
            Some(true) => "granted".to_string(),
            Some(false) => "denied".to_string(),
            None => av_status(&kind),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = kind;
        "granted".to_string()
    }
}

/// While the student answers OS permission dialogs the kiosk must not cover
/// them or steal focus back; see begin_permission_phase.
static PERMISSION_PHASE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn in_permission_phase() -> bool {
    PERMISSION_PHASE.load(std::sync::atomic::Ordering::SeqCst)
}

#[cfg(target_os = "macos")]
fn set_kiosk_presentation(locked: bool) {
    use objc2_app_kit::{NSApplication, NSApplicationPresentationOptions};
    if let Some(mtm) = objc2::MainThreadMarker::new() {
        let app = NSApplication::sharedApplication(mtm);
        let opts = if locked {
            NSApplicationPresentationOptions::HideDock
                | NSApplicationPresentationOptions::HideMenuBar
                | NSApplicationPresentationOptions::DisableAppleMenu
                | NSApplicationPresentationOptions::DisableProcessSwitching
                | NSApplicationPresentationOptions::DisableForceQuit
                | NSApplicationPresentationOptions::DisableSessionTermination
                | NSApplicationPresentationOptions::DisableHideApplication
        } else {
            NSApplicationPresentationOptions::empty()
        };
        app.setPresentationOptions(opts);
    }
}

/// Lower the kiosk so macOS permission dialogs and System Settings appear in
/// front of it: normal window level, not always-on-top, out of fullscreen,
/// presentation options relaxed, and no focus re-grab.
#[tauri::command]
fn begin_permission_phase(app: tauri::AppHandle) {
    PERMISSION_PHASE.store(true, std::sync::atomic::Ordering::SeqCst);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(win) = handle.get_webview_window("exam") {
            let _ = win.set_always_on_top(false);
            #[cfg(target_os = "macos")]
            if let Ok(ns_win) = win.ns_window() {
                unsafe {
                    let ns_win = ns_win as *mut objc2::runtime::AnyObject;
                    let _: () = objc2::msg_send![ns_win, setLevel: 0_isize];
                }
            }
            let _ = win.set_fullscreen(false);
            let _ = win.maximize();
        }
        #[cfg(target_os = "macos")]
        set_kiosk_presentation(false);
    });
}

/// Restore the full lockdown after the permission dialogs are answered.
#[tauri::command]
fn end_permission_phase(app: tauri::AppHandle) {
    PERMISSION_PHASE.store(false, std::sync::atomic::Ordering::SeqCst);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        set_kiosk_presentation(true);
        if let Some(win) = handle.get_webview_window("exam") {
            let _ = win.set_fullscreen(true);
            let _ = win.set_always_on_top(true);
            #[cfg(target_os = "macos")]
            if let Ok(ns_win) = win.ns_window() {
                unsafe {
                    let ns_win = ns_win as *mut objc2::runtime::AnyObject;
                    let _: () = objc2::msg_send![ns_win, setLevel: 1000_isize];
                }
            }
            let _ = win.set_focus();
        }
    });
}

/// Screen Recording permission without prompting.
#[tauri::command]
fn screen_capture_status() -> String {
    #[cfg(target_os = "macos")]
    {
        // CGPreflightScreenCaptureAccess is cached for the life of a process,
        // so a grant made in System Settings would only show after a restart.
        // A short-lived child of this app is attributed to the app by TCC and
        // sees the current state, matching the per-frame screencapture child.
        if let Ok(exe) = std::env::current_exe() {
            if let Ok(status) = std::process::Command::new(exe)
                .arg(SCREEN_PREFLIGHT_ARG)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
            {
                return if status.success() { "granted".into() } else { "denied".into() };
            }
        }
        if screen_preflight() { "granted".into() } else { "denied".into() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        "granted".to_string()
    }
}

/// Restart the exam browser (macOS applies a new Screen Recording grant only
/// to a fresh process). The exit flag stops the watchdog from spawning a
/// second copy.
#[tauri::command]
fn relaunch_app(app: tauri::AppHandle) {
    let flag_path = std::env::temp_dir().join("vignan_exit.flag");
    let _ = std::fs::write(flag_path, "1");
    enable_task_manager();
    app.restart();
}

/// Request screen capture permission natively.
/// Returns "granted", "denied", or "prompt".
#[tauri::command]
fn screen_capture_permission_prompt(app: tauri::AppHandle) -> String {
    #[cfg(target_os = "macos")]
    {
        if screen_capture_status() == "granted" {
            return "granted".into();
        }
        // With a self-signed build TCC pins the grant to the binary's cdhash,
        // so after an update the switch can show "on" yet never match. Drop
        // this app's stale entry, then request from a fresh child process
        // (the request only prompts once per process) so the list gets an
        // entry for the current binary and the student flips one switch.
        let _ = std::process::Command::new("/usr/bin/tccutil")
            .args(["reset", "ScreenCapture", &app.config().identifier])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        if let Ok(exe) = std::env::current_exe() {
            if let Ok(mut child) = std::process::Command::new(exe)
                .arg(SCREEN_REQUEST_ARG)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
            {
                std::thread::spawn(move || { let _ = child.wait(); });
            }
        }
        "denied".into()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        "granted".to_string()
    }
}

/// Open the OS privacy pane for camera/microphone so a previously-denied
/// student can flip the switch, then return to the kiosk and re-grant.
#[tauri::command]
fn open_media_settings(kind: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let pane = if kind == "microphone" {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        } else if kind == "screen" {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        } else if kind == "keyboard" {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        } else {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera"
        };
        std::process::Command::new("open")
            .arg(pane)
            .status()
            .map(|_| ())
            .map_err(|err| format!("could not open System Settings: {err}"))
    }
    #[cfg(target_os = "windows")]
    {
        let pane = if kind == "microphone" {
            "ms-settings:privacy-microphone"
        } else {
            "ms-settings:privacy-webcam"
        };
        std::process::Command::new("cmd")
            .args(["/C", "start", "", pane])
            .status()
            .map(|_| ())
            .map_err(|err| format!("could not open Settings: {err}"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = kind;
        Err("media settings pane is not available on this platform".into())
    }
}

/// Temporarily allow or disallow the exam window to appear in OS screen
/// capture APIs. Called from the frontend around getDisplayMedia() so that
/// the WKWebView can present the screen picker — NSWindowSharingNone blocks
/// the webview's own capture API on macOS. After the stream is acquired the
/// frontend calls this again with `allow = false` to restore the lockdown.
///
/// When allowing (allow = true) we also:
///   1. Lower the window level to NSNormalWindowLevel so the macOS screen
///      picker (system UI) can appear on top of the exam window. At level 1000
///      (kiosk level) the picker would appear *behind* the exam window.
///   2. Call CGRequestScreenCaptureAccess() to surface the TCC authorization
///      request if the user has never granted screen recording permission —
///      this shows the "Vignan Exam Browser would like to record your screen"
///      system notification / System Settings prompt.
///
/// When re-locking (allow = false) the window level returns to 1000 and the
/// sharing type returns to NSWindowSharingNone.
///
/// On Windows the WDA_EXCLUDEFROMCAPTURE flag is toggled equivalently.
#[tauri::command]
fn set_window_sharing(app: tauri::AppHandle, allow: bool) {
    #[cfg(target_os = "macos")]
    {
        // Only the capture visibility changes here. The window level belongs
        // to begin/end_permission_phase, and the screen is captured natively
        // (no system picker), so the window never has to drop below it.
        if let Some(win) = app.get_webview_window("exam") {
            if let Ok(ns_win) = win.ns_window() {
                unsafe {
                    let ns_win = ns_win as *mut objc2::runtime::AnyObject;
                    //   0 = NSWindowSharingNone      (excluded from capture APIs)
                    //   1 = NSWindowSharingReadOnly  (visible to capture APIs)
                    let sharing_type: isize = if allow { 1 } else { 0 };
                    let _: () = objc2::msg_send![ns_win, setSharingType: sharing_type];
                }
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(win) = app.get_webview_window("exam") {
            if let Ok(hwnd) = win.hwnd() {
                unsafe {
                    // 0x00 = WDA_NONE (capturable), 0x11 = WDA_EXCLUDEFROMCAPTURE
                    let affinity: u32 = if allow { 0x00 } else { 0x11 };
                    SetWindowDisplayAffinity(hwnd.0 as *mut _, affinity);
                }
            }
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (app, allow);
    }
}

fn jpeg_base64(bytes: &[u8]) -> String {
    const ALPH: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len() * 4 / 3 + 4);
    let mut i = 0;
    while i < bytes.len() {
        let b0 = bytes[i] as u32;
        let b1 = if i + 1 < bytes.len() { bytes[i + 1] as u32 } else { 0 };
        let b2 = if i + 2 < bytes.len() { bytes[i + 2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPH[((triple >> 18) & 63) as usize] as char);
        out.push(ALPH[((triple >> 12) & 63) as usize] as char);
        out.push(if i + 1 < bytes.len() { ALPH[((triple >> 6) & 63) as usize] as char } else { '=' });
        out.push(if i + 2 < bytes.len() { ALPH[(triple & 63) as usize] as char } else { '=' });
        i += 3;
    }
    out
}

/// Screen Recording status, re-checked at most every few seconds (each check
/// spawns a child process).
#[cfg(target_os = "macos")]
fn screen_recording_granted_cached() -> bool {
    use std::sync::Mutex;
    static CACHE: Mutex<Option<(std::time::Instant, bool)>> = Mutex::new(None);
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, granted)) = *cache {
        if at.elapsed() < std::time::Duration::from_secs(5) {
            return granted;
        }
    }
    let granted = screen_capture_status() == "granted";
    *cache = Some((std::time::Instant::now(), granted));
    granted
}

/// JPEG of the kiosk page itself, rendered by WebKit. Needs no Screen
/// Recording permission and ignores NSWindowSharingNone. The kiosk covers the
/// whole display with switching locked, so this is what the student sees.
#[cfg(target_os = "macos")]
async fn snapshot_exam_window(app: &tauri::AppHandle) -> Result<Vec<u8>, String> {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    let win = app.get_webview_window("exam").ok_or("exam window missing")?;
    let (tx, rx) = std::sync::mpsc::channel::<Option<Vec<u8>>>();
    win.with_webview(move |wv| unsafe {
        let webview = wv.inner() as *mut AnyObject;
        let config: *mut AnyObject = msg_send![class!(WKSnapshotConfiguration), new];
        let width: *mut AnyObject = msg_send![class!(NSNumber), numberWithDouble: 960.0f64];
        let _: () = msg_send![config, setSnapshotWidth: width];
        let tx = std::sync::Mutex::new(Some(tx));
        let handler = block2::RcBlock::new(move |image: *mut AnyObject, _error: *mut AnyObject| {
            let bytes = if image.is_null() { None } else { nsimage_jpeg(image) };
            if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
                let _ = tx.send(bytes);
            }
        });
        let _: () = msg_send![webview, takeSnapshotWithConfiguration: config, completionHandler: &*handler];
        let _: () = msg_send![config, release];
    })
    .map_err(|e| format!("snapshot: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(3)))
        .await
        .map_err(|e| format!("snapshot: {e}"))?
        .map_err(|_| "snapshot timed out".to_string())?
        .ok_or_else(|| "snapshot failed".to_string())
}

#[cfg(target_os = "macos")]
unsafe fn nsimage_jpeg(image: *mut objc2::runtime::AnyObject) -> Option<Vec<u8>> {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    let tiff: *mut AnyObject = msg_send![image, TIFFRepresentation];
    if tiff.is_null() {
        return None;
    }
    let rep: *mut AnyObject = msg_send![class!(NSBitmapImageRep), imageRepWithData: tiff];
    if rep.is_null() {
        return None;
    }
    let key = std::ffi::CString::new("NSImageCompressionFactor").ok()?;
    let key: *mut AnyObject = msg_send![class!(NSString), stringWithUTF8String: key.as_ptr()];
    let quality: *mut AnyObject = msg_send![class!(NSNumber), numberWithDouble: 0.6f64];
    let props: *mut AnyObject = msg_send![class!(NSDictionary), dictionaryWithObject: quality, forKey: key];
    // 3 = NSBitmapImageFileTypeJPEG
    let data: *mut AnyObject = msg_send![rep, representationUsingType: 3usize, properties: props];
    if data.is_null() {
        return None;
    }
    let len: usize = msg_send![data, length];
    let ptr: *const u8 = msg_send![data, bytes];
    if ptr.is_null() || len == 0 {
        return None;
    }
    Some(std::slice::from_raw_parts(ptr, len).to_vec())
}

/// JPEG frame for the kiosk screen-share pipeline — never a picker, never a
/// trip to System Settings. With Screen Recording already granted it is the
/// whole display; otherwise it is the kiosk page itself.
#[tauri::command]
async fn capture_display_jpeg(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    if !screen_recording_granted_cached() {
        return snapshot_exam_window(&app).await.map(|b| jpeg_base64(&b));
    }
    let _ = &app;
    let path = std::env::temp_dir().join(format!("vignan-scr-{}.jpg", std::process::id()));
    let path_str = path.to_string_lossy().to_string();

    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("screencapture")
            .args(["-x", "-C", "-t", "jpg", &path_str])
            .status()
            .map_err(|e| format!("screencapture: {e}"))?;
        if !status.success() {
            return Err("screencapture failed".into());
        }
        let _ = std::process::Command::new("sips")
            .args(["-Z", "1280", &path_str])
            .status();
    }

    #[cfg(target_os = "windows")]
    {
        let script = format!(
            "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp=New-Object Drawing.Bitmap $b.Width,$b.Height; $g=[Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size); $bmp.Save('{}',[Drawing.Imaging.ImageFormat]::Jpeg);",
            path_str.replace('\\', "\\\\").replace('\'', "''")
        );
        let status = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .status()
            .map_err(|e| format!("powershell capture: {e}"))?;
        if !status.success() {
            return Err("windows screen capture failed".into());
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = path_str;
        return Err("native screen capture is not available on this platform".into());
    }

    let bytes = std::fs::read(&path).map_err(|e| format!("read capture: {e}"))?;
    let _ = std::fs::remove_file(&path);
    if bytes.is_empty() {
        return Err("empty capture".into());
    }
    Ok(jpeg_base64(&bytes))
}


/// Diagnostic: is the exam window excluded from OS screen capture? The web
/// layer shows a lockdown notice if the exclusion could not be applied.
#[tauri::command]
fn screen_capture_excluded(app: tauri::AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    {
        if let Some(win) = app.get_webview_window("exam") {
            if let Ok(ns_win) = win.ns_window() {
                unsafe {
                    let ns_win = ns_win as *mut objc2::runtime::AnyObject;
                    let sharing: isize = objc2::msg_send![ns_win, sharingType];
                    return sharing == 0; // NSWindowSharingNone
                }
            }
        }
        false
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(win) = app.get_webview_window("exam") {
            if let Ok(hwnd) = win.hwnd() {
                unsafe {
                    let mut affinity: u32 = 0;
                    // GetWindowDisplayAffinity via the same extern block pattern.
                    return get_window_display_affinity(hwnd.0 as *mut _, &mut affinity) && (affinity & 0x00000011) != 0;
                }
            }
        }
        false
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // Linux has no capture-exclusion API — nothing to verify, so never
        // fail the kiosk on this platform.
        let _ = app;
        true
    }
}

#[cfg(target_os = "windows")]
unsafe fn get_window_display_affinity(hwnd: *mut std::ffi::c_void, out: &mut u32) -> bool {
    GetWindowDisplayAffinity(hwnd, out) != 0
}

#[cfg(target_os = "windows")]
fn enforce_admin_privileges() {
    // NOTE: Deliberately NON-FATAL. The NSIS bundle installs per-user
    // (installMode = currentUser), so the app legitimately runs unelevated —
    // a hard admin requirement here meant the exe flashed and exited silently
    // on every normal install ("the app never opens"). All lockdown features
    // (task-manager disable via HKCU, kiosk window, watchdogs) work per-user;
    // if elevation is available we simply note it.
    let is_admin = std::process::Command::new("reg")
        .args(&["query", "HKU\\S-1-5-19"])
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false);
    if !is_admin {
        println!("NOTICE: running without administrator privileges (per-user install) — continuing.");
    }
}

#[cfg(not(target_os = "windows"))]
fn enforce_admin_privileges() {}

#[cfg(target_os = "windows")]
extern "system" {
    fn SetWindowDisplayAffinity(hwnd: *mut std::ffi::c_void, affinity: u32) -> i32;
    fn GetWindowDisplayAffinity(hwnd: *mut std::ffi::c_void, affinity: *mut u32) -> i32;
}

const SCREEN_PREFLIGHT_ARG: &str = "--screen-preflight";
const SCREEN_REQUEST_ARG: &str = "--screen-request";

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[cfg(target_os = "macos")]
fn screen_preflight() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}

/// System-wide keyboard lock. System shortcuts (Spotlight, Globe/fn actions,
/// screenshots, Mission Control keys, Cmd+H/M/Q…) are handled by macOS before
/// the webview ever sees them, so JS cannot stop them. A CGEventTap sits in
/// front of all of that and drops every keystroke that carries Cmd, Control
/// or Option, plus Escape, function and system keys. macOS only allows a
/// filtering tap for apps trusted under Privacy & Security > Accessibility.
#[cfg(target_os = "macos")]
mod keylock {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};

    type TapCallback = extern "C" fn(*mut c_void, u32, *mut c_void, *mut c_void) -> *mut c_void;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn CGEventTapCreate(tap: u32, place: u32, options: u32, mask: u64, callback: TapCallback, info: *mut c_void) -> *mut c_void;
        fn CGEventTapEnable(tap: *mut c_void, enable: bool);
        fn CGEventGetFlags(event: *mut c_void) -> u64;
        fn CGEventGetIntegerValueField(event: *mut c_void, field: u32) -> i64;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFRunLoopCommonModes: *const c_void;
        fn CFMachPortCreateRunLoopSource(alloc: *const c_void, port: *mut c_void, order: isize) -> *mut c_void;
        fn CFRunLoopGetCurrent() -> *mut c_void;
        fn CFRunLoopAddSource(rl: *mut c_void, src: *mut c_void, mode: *const c_void);
        fn CFRunLoopRun();
    }

    const HID_TAP: u32 = 0;
    const SESSION_TAP: u32 = 1;
    const KEY_DOWN: u32 = 10;
    const KEY_UP: u32 = 11;
    const FLAGS_CHANGED: u32 = 12;
    const TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
    const TAP_DISABLED_BY_USER_INPUT: u32 = 0xFFFF_FFFF;
    const KEYCODE_FIELD: u32 = 9;

    const FLAG_CONTROL: u64 = 0x0004_0000;
    const FLAG_OPTION: u64 = 0x0008_0000;
    const FLAG_COMMAND: u64 = 0x0010_0000;
    const FLAG_FN: u64 = 0x0080_0000;

    /// Escape, Help, F1–F20, and the dedicated system keys (Mission Control,
    /// Launchpad, Spotlight, Dictation, Do Not Disturb, Globe).
    const BLOCKED_KEYS: &[i64] = &[
        53, 114, 122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90,
        160, 131, 177, 176, 178, 179,
    ];
    /// Keys that carry the fn flag by themselves: arrows, forward delete,
    /// home/end/page keys, delete, return.
    const FN_NAVIGATION: &[i64] = &[123, 124, 125, 126, 117, 115, 119, 116, 121, 51, 36, 76];
    /// Command, Option, Control and fn/Globe press/release on their own
    /// (double-Control dictation, Globe emoji picker).
    const BLOCKED_MODIFIERS: &[i64] = &[54, 55, 58, 59, 61, 62, 63, 179];

    static ACTIVE: AtomicBool = AtomicBool::new(false);
    static STARTED: AtomicBool = AtomicBool::new(false);
    static TAP: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGSMainConnectionID() -> i32;
        fn CGSSetGlobalHotKeyOperatingMode(cid: i32, mode: i32) -> i32;
        fn CGSGetGlobalHotKeyOperatingMode(cid: i32, mode: *mut i32) -> i32;
    }

    /// Switch every system-wide shortcut off (Spotlight, screenshots,
    /// Mission Control, input-source and app-switch hot keys) for this login
    /// session. Needs no permission; WindowServer restores the mode when the
    /// process exits, so a crash never leaves the Mac without shortcuts.
    pub fn set_system_hotkeys(enabled: bool) {
        unsafe {
            CGSSetGlobalHotKeyOperatingMode(CGSMainConnectionID(), if enabled { 0 } else { 1 });
        }
    }

    pub fn system_hotkeys_disabled() -> bool {
        let mut mode = 0;
        unsafe { CGSGetGlobalHotKeyOperatingMode(CGSMainConnectionID(), &mut mode) };
        mode != 0
    }

    /// The keyboard lock holds when system hot keys are off; the event tap
    /// below adds per-key filtering when the app already happens to be
    /// trusted under Accessibility (never prompted for).
    pub fn active() -> bool {
        system_hotkeys_disabled() || ACTIVE.load(Ordering::SeqCst)
    }

    fn trusted() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    fn should_block(kind: u32, event: *mut c_void) -> bool {
        let flags = unsafe { CGEventGetFlags(event) };
        let code = unsafe { CGEventGetIntegerValueField(event, KEYCODE_FIELD) };
        if kind == FLAGS_CHANGED {
            return BLOCKED_MODIFIERS.contains(&code);
        }
        if flags & (FLAG_COMMAND | FLAG_CONTROL | FLAG_OPTION) != 0 {
            return true;
        }
        if BLOCKED_KEYS.contains(&code) {
            return true;
        }
        flags & FLAG_FN != 0 && !FN_NAVIGATION.contains(&code)
    }

    extern "C" fn on_event(_proxy: *mut c_void, kind: u32, event: *mut c_void, _info: *mut c_void) -> *mut c_void {
        if kind == TAP_DISABLED_BY_TIMEOUT || kind == TAP_DISABLED_BY_USER_INPUT {
            let tap = TAP.load(Ordering::SeqCst);
            if !tap.is_null() {
                unsafe { CGEventTapEnable(tap, true) };
            }
            return event;
        }
        // System Settings and permission dialogs must stay operable.
        if super::in_permission_phase() {
            return event;
        }
        if should_block(kind, event) {
            return std::ptr::null_mut();
        }
        event
    }

    /// Install the tap as soon as the app is trusted (polls, so a switch
    /// flipped in System Settings takes effect without a restart).
    pub fn start() {
        set_system_hotkeys(false);
        if STARTED.swap(true, Ordering::SeqCst) {
            return;
        }
        std::thread::spawn(|| {
            let mask = (1u64 << KEY_DOWN) | (1u64 << KEY_UP) | (1u64 << FLAGS_CHANGED);
            loop {
                if trusted() {
                    let tap = [HID_TAP, SESSION_TAP].iter().find_map(|&location| {
                        let t = unsafe { CGEventTapCreate(location, 0, 0, mask, on_event, std::ptr::null_mut()) };
                        if t.is_null() { None } else { Some(t) }
                    });
                    if let Some(tap) = tap {
                        TAP.store(tap, Ordering::SeqCst);
                        unsafe {
                            let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
                            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
                            CGEventTapEnable(tap, true);
                        }
                        ACTIVE.store(true, Ordering::SeqCst);
                        unsafe { CFRunLoopRun() };
                        ACTIVE.store(false, Ordering::SeqCst);
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(1000));
            }
        });
    }
}

/// "granted" once the system-wide keyboard lock is running.
#[tauri::command]
fn keyboard_lock_status() -> String {
    #[cfg(target_os = "macos")]
    {
        if keylock::active() { "granted".into() } else { "denied".into() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        "granted".to_string()
    }
}

/// (Re)apply the keyboard lock. Never sends the student to System Settings.
#[tauri::command]
fn keyboard_lock_request() -> String {
    #[cfg(target_os = "macos")]
    {
        keylock::start();
        if keylock::active() { "granted".into() } else { "denied".into() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        "granted".to_string()
    }
}

fn main() {
    if std::env::args().any(|a| a == SCREEN_PREFLIGHT_ARG) {
        #[cfg(target_os = "macos")]
        std::process::exit(if screen_preflight() { 0 } else { 3 });
        #[cfg(not(target_os = "macos"))]
        std::process::exit(0);
    }
    if std::env::args().any(|a| a == SCREEN_REQUEST_ARG) {
        #[cfg(target_os = "macos")]
        {
            let granted = unsafe { CGRequestScreenCaptureAccess() };
            // Let tccd finish recording the request before the process goes away.
            std::thread::sleep(std::time::Duration::from_secs(2));
            std::process::exit(if granted { 0 } else { 3 });
        }
        #[cfg(not(target_os = "macos"))]
        std::process::exit(0);
    }
    enforce_admin_privileges();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            check_prohibited_apps,
            exit_app,
            open_student_side,
            vignan_launch_url,
            media_permission_prompt,
            screen_capture_permission_prompt,
            open_media_settings,
            screen_capture_excluded,
            lockdown_log_probe,
            set_window_sharing,
            capture_display_jpeg,
            request_media_access,
            begin_permission_phase,
            end_permission_phase,
            screen_capture_status,
            relaunch_app,
            keyboard_lock_status,
            keyboard_lock_request
        ])
        // Register first so a second process exits before other plugins start.
        // Its deep-link feature forwards Windows/Linux argv to the same plugin
        // event used by macOS OS-open events, and updates get_current().
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // The OS can hand the exam URL to a SECOND process instead of the
            // running one: Windows/Linux pass it as argv, and macOS
            // LaunchServices starts a fresh instance when the running one is
            // hidden behind NSApplicationPresentationOptions::HideDock. That
            // process exits immediately (see above), so this callback is the
            // ONLY place the URL still exists — without forwarding it the
            // running kiosk never learns about the exam and the student is
            // left staring at the previous screen. Emit it to the frontend,
            // which already listens for "vignan-deeplink" alongside the
            // plugin's own deep-link://new-url event.
            if let Some(url) = argv.iter().find(|arg| arg.starts_with("vignan-exam://")) {
                use tauri::Emitter;
                let _ = app.emit("vignan-deeplink", url.clone());
            }
            if let Some(win) = app.get_webview_window("exam") {
                let _ = win.unminimize();
                let _ = win.set_fullscreen(true);
                let _ = win.set_always_on_top(true);
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            // macOS registers via the bundled Info.plist. Windows/Linux can
            // also register at runtime (needed for a manually run AppImage).
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(err) = app.deep_link().register_all() {
                    // Do not abort an otherwise usable installed app if the OS
                    // refuses to change the handler; the installer may own it.
                    eprintln!("Could not register exam URL handler: {err}");
                }
            }
            #[cfg(target_os = "macos")]
            {
                // Lock down macOS to create a true kiosk mode (disables Cmd+Tab, Dock, Menu Bar, Spaces)
                set_kiosk_presentation(true);
                keylock::start();
                if let Some(mtm) = objc2::MainThreadMarker::new() {
                    let app = objc2_app_kit::NSApplication::sharedApplication(mtm);

                    // Replace the default main menu (File/Edit/… with Quit ≘ Cmd+Q
                    // and Close ≘ Cmd+W accelerators) with an empty menu. JS
                    // listeners cannot intercept app-menu shortcuts because they
                    // dispatch through the menu bar before the webview sees the
                    // key — removing the menu removes every accelerator, so
                    // Cmd+Q / Cmd+W / Cmd+M become dead keys during an exam.
                    // Termination still works programmatically via exit_app.
                    unsafe {
                        let empty_menu: *mut objc2::runtime::AnyObject =
                            objc2::msg_send![objc2::class!(NSMenu), new];
                        let _: () = objc2::msg_send![&app, setMainMenu: empty_menu];
                    }
                }
            }

            // Manually spawn the exam window so we can attach a permission handler.
            // By auto-allowing Webview permissions, we defer to the REAL native OS popup.
            let win = tauri::WebviewWindowBuilder::new(
                app,
                "exam",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Vignan Exam Browser")
            .fullscreen(true)
            .always_on_top(true)
            .decorations(false)
            .resizable(false)
            .maximized(true)
            .skip_taskbar(false)
            .visible(true)
            .closable(false)
            .minimizable(false)
            // Before page scripts on every load, so a reload or navigation
            // never leaves a page without the lockdown layer.
            .initialization_script(LOCKDOWN_JS)
            .on_permission_request(|_, req| match req {
                // Camera and microphone are needed for proctoring identity
                // verification and audio monitoring.
                tauri::webview::PermissionKind::Camera
                | tauri::webview::PermissionKind::Microphone => {
                    tauri::webview::PermissionResponse::Allow
                }
                // DisplayCapture is needed for getDisplayMedia() — the student
                // must share their screen so the proctor can monitor it.
                // Without this, the browser-side picker never appears.
                tauri::webview::PermissionKind::DisplayCapture => {
                    tauri::webview::PermissionResponse::Allow
                }
                _ => tauri::webview::PermissionResponse::Deny,
            })
            .build()
            .expect("Failed to build exam window");
            
            // Note: `.focus(true)` was deprecated and removed; the window is focused by default.
            let _ = win.set_focus();

            if let Some(win) = app.get_webview_window("exam") {
                let _ = win.set_fullscreen(true);
                let _ = win.set_always_on_top(true);
                
                #[cfg(target_os = "macos")]
                {
                    if let Ok(ns_win) = win.ns_window() {
                        unsafe {
                            // Cast to AnyObject pointer to send messages
                            let ns_win = ns_win as *mut objc2::runtime::AnyObject;
                            // 1000 is usually CGShieldingWindowLevel or NSScreenSaverWindowLevel
                            // This ensures the window is above notifications and other overlay apps.
                            let _: () = objc2::msg_send![ns_win, setLevel: 1000_isize];
                            // 0 = NSWindowSharingNone: the window is excluded from
                            // every OS screen-capture API. A student pressing
                            // Cmd+Shift+3/4/5 gets a screenshot of the desktop
                            // WITHOUT the exam content (wallpaper shows through).
                            //
                            // Consequence: the kiosk's own getDisplayMedia feed is
                            // also excluded. The proctor still sees the candidate
                            // through the (always-granted) camera stream and the
                            // per-second webcam snapshot timeline; screen motion
                            // evidence is replaced by camera + AI + lockdown events.
                            let _: () = objc2::msg_send![ns_win, setSharingType: 0_isize];
                        }
                    }
                }
                #[cfg(target_os = "windows")]
                {
                    // WDA_EXCLUDEFROMCAPTURE (0x11): the exam window disappears
                    // from PrintScreen, Snipping Tool (Win+Shift+S) and every
                    // capture API — the screenshot shows everything else but a
                    // black hole where the exam was. Same trade as macOS: the
                    // kiosk's own screen-share feed is excluded; proctor evidence
                    // comes from the camera stream + AI + lockdown events.
                    if let Ok(hwnd) = win.hwnd() {
                        unsafe {
                            SetWindowDisplayAffinity(hwnd.0 as *mut _, 0x00000011);
                        }
                    }
                }
                
                let _ = win.eval(LOCKDOWN_JS);
                // (No fake __TAURI_INTERNALS__ eval here either — see LOCKDOWN_JS
                // note. Overwriting the real bridge after page load was also
                // breaking invoke()/listen() mid-session.)
                let _ = win.set_focus();
            }

            // VM detection: don't silently exit — show the reason in the kiosk
            // window so the student (and invigilator) can see WHY the app won't
            // continue. The web layer renders this as a full-screen notice.
            if detect_vm() {
                let flag_path = std::env::temp_dir().join("vignan_vm_detected.flag");
                let _ = std::fs::write(flag_path, "1");
                if let Some(win) = app.get_webview_window("exam") {
                    let _ = win.eval("window.dispatchEvent(new CustomEvent('lockdown:vm-detected'));");
                    let _ = win.set_focus();
                }
                return Ok(()); // keep the window up; no exam is served
            }

            disable_task_manager();

            // Blackout extra monitors
            if let Ok(monitors) = app.available_monitors() {
                if monitors.len() > 1 {
                    for (i, m) in monitors.iter().enumerate().skip(1) {
                        let _ = tauri::WebviewWindowBuilder::new(
                            app, 
                            format!("blackout_{}", i), 
                            tauri::WebviewUrl::App("about:blank".into())
                        )
                        .title("Blackout")
                        .fullscreen(true)
                        .always_on_top(true)
                        .decorations(false)
                        .initialization_script("document.body.style.backgroundColor = 'black'; document.body.style.cursor = 'none';")
                        .position(m.position().x.into(), m.position().y.into())
                        .build();
                    }
                }
            }

            // Spawn Watchdog
            if let Ok(exe) = std::env::current_exe() {
                let mut watchdog_path = exe.clone();
                watchdog_path.set_file_name("vignan-watchdog");
                if watchdog_path.exists() {
                    let _ = std::process::Command::new(watchdog_path)
                        .arg(std::process::id().to_string())
                        .arg(exe)
                        .spawn();
                }
            }

            // Prohibited app watchdog: instead of force-killing the exam (which
            // loses the recording), surface a visible lockdown notice in the
            // kiosk. The web layer listens for this event and shows the reason.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    if in_permission_phase() {
                        continue;
                    }
                    let apps = check_prohibited_apps();
                    if !apps.is_empty() {
                        let list = apps.join(", ");
                        if let Some(win) = handle.get_webview_window("exam") {
                            let _ = win.eval(&format!(
                                "window.dispatchEvent(new CustomEvent('lockdown:prohibited-apps', {{ detail: '{}' }}));",
                                list.replace('\'', "")
                            ));
                            let _ = win.set_focus();
                        }
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                WindowEvent::Focused(false) => {
                    // A macOS permission dialog or System Settings is in front
                    // on purpose; grabbing focus back would hide it.
                    if in_permission_phase() {
                        return;
                    }
                    // Re-assert the lockdown if the student tries to minimize or unfocus.
                    let _ = window.set_fullscreen(true);
                    let _ = window.set_always_on_top(true);
                    let _ = window.set_focus();
                }
                WindowEvent::CloseRequested { api, .. } => {
                    // Refuse the close (red X button, Alt+F4, Cmd+W). Exiting
                    // here also killed the app when macOS delivered a spurious
                    // close during fullscreen transitions — the student lost the
                    // exam session. The attempt is surfaced in the kiosk as a
                    // "quit is locked" notice; the ONLY sanctioned exits are the
                    // in-app controls, which invoke exit_app explicitly.
                    api.prevent_close();
                    if let Some(wv) = window.app_handle().get_webview_window("exam") {
                        let _ = wv.eval("window.dispatchEvent(new CustomEvent('lockdown:quit-attempted'));");
                    }
                    let _ = window.set_fullscreen(true);
                    let _ = window.set_always_on_top(true);
                    let _ = window.set_focus();
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the Vignan lockdown app");
}
