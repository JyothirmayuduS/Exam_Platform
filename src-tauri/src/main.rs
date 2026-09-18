// Vignan OS — Lockdown Exam Browser (Tauri v2)
//
// Boots the student straight into the exam in a kiosk window (fullscreen,
// always-on-top, no decorations) and injects a lockdown layer that blocks the
// usual escape hatches: right-click, devtools shortcuts, copy/cut/paste,
// printing, text selection, and drag-and-drop. There is no onboarding — the
// window opens directly on the exam.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, WindowEvent};

// Single instance / deep link: when the OS opens `vignan-exam://` while the
// kiosk is already running, forward the URL to the live webview (which listens
// for `vignan-deeplink` events) instead of stacking a second kiosk process.
const DEEPLINK_EVENT: &str = "vignan-deeplink";

fn forward_deeplink_to_webview(app: &tauri::AppHandle, url: &str) {
    use tauri::Emitter;
    if let Some(win) = app.get_webview_window("exam") {
        let _ = win.emit(DEEPLINK_EVENT, url);
    }
}

const LOCKDOWN_JS: &str = r#"
(() => {
  const block = (e) => { e.preventDefault(); e.stopPropagation(); return false; };

  // No right-click context menu.
  document.addEventListener('contextmenu', block, true);

  // No copy / cut / paste / drag of exam content.
  ['copy','cut','paste','dragstart','drop','selectstart'].forEach((evt) =>
    document.addEventListener(evt, block, true));

  // Block devtools, view-source, print, save, find, and refresh shortcuts.
  document.addEventListener('keydown', (e) => {
    const k = (e.key || '').toLowerCase();
    const combo = e.ctrlKey || e.metaKey;
    if (k === 'escape') return block(e);
    if (k === 'f12') return block(e);
    if (combo && e.shiftKey && ['i','j','c'].includes(k)) return block(e); // devtools
    if (combo && ['u','p','s','f','r','w','t','n'].includes(k)) return block(e);
    if (k === 'f5') return block(e);
    if (e.altKey && k === 'tab') return block(e);
    if (e.altKey && k === 'f4') return block(e);
    if (k === 'printscreen') { navigator.clipboard?.writeText(''); return block(e); }
  }, true);

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
        "anydesk", "teamviewer", "zoom", "skype", "discord", "screensharing", "rustdesk",
        "dws", "dwservice", "zoho", "logmein", "splashtop", "chrome remote desktop", "vnc",
        "cheatengine", "x64dbg", "ida", "wireshark", "processhacker", "ollydbg", "fiddler", "charles"
    ];
    
    let mut found = Vec::new();
    
    for (_pid, process) in sys.processes() {
        let name_os = process.name();
        let name_str = name_os.to_string_lossy();
        let name_lower = name_str.to_lowercase();
        for p in &prohibited {
            if name_lower.contains(p) {
                found.push(name_str.to_string());
                break; // Stop checking this process if we already found a match
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

/// Hand the cold-start deep link (vignan-exam://open?exam=…&roll=…) to the
/// web layer. Written by setup() before the webview loaded; main.tsx reads it
/// once at boot and preloads the exam.
#[tauri::command]
fn vignan_launch_url() -> Option<String> {
    let flag = std::env::temp_dir().join("vignan_launch_url.txt");
    match std::fs::read_to_string(&flag) {
        Ok(url) => {
            let _ = std::fs::remove_file(&flag); // one-shot
            Some(url.trim().to_string())
        }
        Err(_) => None,
    }
}

#[tauri::command]
fn exit_app() {
    enable_task_manager();
    let flag_path = std::env::temp_dir().join("vignan_exit.flag");
    let _ = std::fs::write(flag_path, "1");
    std::process::exit(0);
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
}

fn main() {
    enforce_admin_privileges();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![check_prohibited_apps, exit_app, vignan_launch_url])
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // A second launch attempt (e.g. the OS handing us the deep link
            // again while we're already running) — surface it to the live
            // webview and make sure the kiosk is front and centre.
            if let Some(url) = argv.iter().find(|a| a.starts_with("vignan-exam://")) {
                forward_deeplink_to_webview(app, url);
            }
            if let Some(win) = app.get_webview_window("exam") {
                let _ = win.unminimize();
                let _ = win.set_fullscreen(true);
                let _ = win.set_always_on_top(true);
                let _ = win.set_focus();
            }
        }))
        .setup(|app| {
            // On Windows, register the vignan-exam:// URL scheme in the registry.
            // On macOS the scheme is registered automatically via Info.plist
            // (embedded from tauri.conf.json plugins.deep-link) — calling
            // register() on macOS panics with "unsupported platform".
            // Deep link: register the scheme on Windows, and on every platform
            // forward the launch URL (cold start) into the webview so the exam
            // opens with the right exam/roll preloaded. This fires BEFORE the
            // webview finishes loading, so also stash the URL for main.tsx to
            // read via the `vignan_launch_url` command at boot.
            #[cfg(target_os = "windows")]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register("vignan-exam")?;
            }
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // get_current() is Option<Vec<Url>> — the OS may deliver several.
                let launch_url = app
                    .deep_link()
                    .get_current()
                    .ok()
                    .flatten()
                    .and_then(|urls| urls.first().map(|u| u.to_string()));
                if let Some(url) = launch_url {
                    println!("launch deep link: {url}");
                    // Persist for the boot script in main.tsx.
                    let flag = std::env::temp_dir().join("vignan_launch_url.txt");
                    let _ = std::fs::write(&flag, &url);
                    // Also emit for the (unlikely) case the webview is ready.
                    forward_deeplink_to_webview(app.handle(), &url);
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
                }
            }
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
                            // NOTE: NSWindowSharingTypeNone was deliberately REMOVED.
                            // Setting sharing type 0 made the window invisible to EVERY
                            // screen-capture API — including the exam's own screen
                            // recording and the live proctor screen feed, which came
                            // through as black/absent. The proctor MUST be able to
                            // record this window; anti-cheat is enforced by the kiosk
                            // lockdown (no app switching, no devtools, etc) instead.
                            // 2 is NSWindowSharingReadWrite (capturable).
                            let _: () = objc2::msg_send![ns_win, setSharingType: 2_isize];
                        }
                    }
                }
                #[cfg(target_os = "windows")]
                {
                    // NOTE: WDA_EXCLUDEFROMCAPTURE was deliberately REMOVED — it
                    // excluded the exam window from the screen recording, so the
                    // proctor's screen feed/recording showed the desktop with a
                    // black hole where the exam was (or fully black in fullscreen).
                    // The window is now capturable for proctoring evidence.
                    if let Ok(hwnd) = win.hwnd() {
                        unsafe {
                            SetWindowDisplayAffinity(hwnd.0 as *mut _, 0x00000000); // WDA_NONE
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
                WindowEvent::CloseRequested { .. } => {
                    // When the OS shuts down (or if the user forces a quit like Cmd+Q/Alt+F4),
                    // exit immediately. If we prevent close here, the OS shutdown process
                    // might take the app out of fullscreen but leave it running in the background,
                    // creating a loophole where the user cancels shutdown and accesses the desktop.
                    exit_app();
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the Vignan lockdown app");
}
