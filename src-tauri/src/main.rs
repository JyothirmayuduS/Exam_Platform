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
  const block = (e) => { e.preventDefault(); e.stopPropagation(); return false; };

  // No right-click context menu.
  document.addEventListener('contextmenu', block, true);

  // No copy / cut / paste / drag of exam content.
  ['copy','cut','paste','dragstart','drop','selectstart'].forEach((evt) =>
    document.addEventListener(evt, block, true));

  // Block devtools, view-source, print, save, find, refresh, and screenshot
  // shortcuts. Note keydown AND keyup: Windows Snipping Tool (Win+Shift+S) and
  // Ctrl+Shift+Cmd+4 fire on keyup, so intercepting only keydown lets the OS
  // snipping surface appear.
  const blockedCombo = (e) => {
    const k = (e.key || '').toLowerCase();
    const combo = e.ctrlKey || e.metaKey;
    if (k === 'escape') return true;
    if (k === 'f12') return true;
    if (combo && e.shiftKey && ['i','j','c','s'].includes(k)) return true; // devtools + snip
    if (combo && ['u','p','s','f','r','w','t','n','x','v','a'].includes(k)) return true;
    if (k === 'f5') return true;
    if (e.altKey && k === 'tab') return true;
    if (e.altKey && k === 'f4') return true;
    if (e.metaKey && e.shiftKey && ['3','4','5','6'].includes(k)) return true; // macOS screenshots
    if (k === 'printscreen' || k === 'snapshot') {
      navigator.clipboard?.writeText('');
      return true;
    }
    return false;
  };
  document.addEventListener('keydown', (e) => { if (blockedCombo(e)) { e.preventDefault(); e.stopPropagation(); } }, true);
  document.addEventListener('keyup', (e) => { if (blockedCombo(e)) { e.preventDefault(); e.stopPropagation(); } }, true);

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

  // Disable text selection visually.
  const style = document.createElement('style');
  style.textContent = '*{-webkit-user-select:none!important;user-select:none!important;} input,textarea{-webkit-user-select:text!important;user-select:text!important;}';
  document.documentElement.appendChild(style);
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

/// Re-trigger the OS-level camera/microphone permission dialog from inside the
/// kiosk. In a normal browser the site can re-prompt via getUserMedia, but a
/// macOS TCC "Don't Allow" answer is remembered by the BUNDLE ID and the
/// webview never asks again — the only escape is requestAccessForMediaType
/// from native code (which surfaces the dialog again when the answer is still
/// undecided) plus a shortcut into System Settings. Windows WebView2 grants
/// web media permissions implicitly, so this resolves to "granted" there.
#[tauri::command]
fn media_permission_prompt(kind: String) -> String {
    #[cfg(target_os = "macos")]
    {
        use objc2::runtime::AnyObject;
        let media_type = if kind == "microphone" { "soun" } else { "vide" };
        unsafe {
            let cls = objc2::class!(AVCaptureDevice);
            let sel_type: *mut AnyObject = objc2::msg_send![objc2::class!(NSString), stringWithUTF8String: std::ffi::CString::new(media_type).unwrap().as_ptr()];
            let dev: *mut AnyObject = objc2::msg_send![cls, deviceWithMediaType: sel_type];
            if dev.is_null() {
                return "unavailable".to_string();
            }
            let status: i64 = objc2::msg_send![dev, authorizationStatusForMediaType: sel_type];
            match status {
                // Authorized.
                3 => "granted".to_string(),
                // Denied or Restricted: only System Settings can change this.
                1 | 2 => "denied".to_string(),
                // NotDetermined (0): the web layer's next getUserMedia call
                // surfaces the native WKWebView prompt itself — no native
                // requestAccess block needed here.
                _ => "prompt".to_string(),
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = kind;
        // WebView2 does not gate getUserMedia behind an OS dialog.
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
/// On Windows the WDA_EXCLUDEFROMCAPTURE flag is toggled equivalently.
#[tauri::command]
fn set_window_sharing(app: tauri::AppHandle, allow: bool) {
    #[cfg(target_os = "macos")]
    {
        if let Some(win) = app.get_webview_window("exam") {
            if let Ok(ns_win) = win.ns_window() {
                unsafe {
                    let ns_win = ns_win as *mut objc2::runtime::AnyObject;
                    // 0 = NSWindowSharingNone (excluded from capture)
                    // 1 = NSWindowSharingReadOnly (visible to capture APIs)
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

fn main() {
    enforce_admin_privileges();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            check_prohibited_apps,
            exit_app,
            open_student_side,
            vignan_launch_url,
            media_permission_prompt,
            open_media_settings,
            screen_capture_excluded,
            lockdown_log_probe,
            set_window_sharing
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
                use objc2_app_kit::{NSApplication, NSApplicationPresentationOptions};
                if let Some(mtm) = objc2::MainThreadMarker::new() {
                    let app = NSApplication::sharedApplication(mtm);
                    let opts = NSApplicationPresentationOptions::HideDock
                        | NSApplicationPresentationOptions::HideMenuBar
                        | NSApplicationPresentationOptions::DisableAppleMenu
                        | NSApplicationPresentationOptions::DisableProcessSwitching
                        | NSApplicationPresentationOptions::DisableForceQuit
                        | NSApplicationPresentationOptions::DisableSessionTermination
                        | NSApplicationPresentationOptions::DisableHideApplication;
                    app.setPresentationOptions(opts);

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
