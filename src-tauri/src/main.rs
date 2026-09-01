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
    if (k === 'printscreen') { navigator.clipboard?.writeText(''); return block(e); }
  }, true);

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

#[tauri::command]
fn exit_app() {
    enable_task_manager();
    let flag_path = std::env::temp_dir().join("vignan_exit.flag");
    let _ = std::fs::write(flag_path, "1");
    std::process::exit(0);
}

#[cfg(target_os = "windows")]
fn enforce_admin_privileges() {
    let output = std::process::Command::new("reg")
        .args(&["query", "HKU\\S-1-5-19"])
        .output();
    
    let is_admin = match output {
        Ok(out) => out.status.success(),
        Err(_) => false,
    };
    
    if !is_admin {
        println!("FATAL: Application must be run as Administrator.");
        // We could show a native message box here, but exiting is the fail-safe.
        std::process::exit(1);
    }
}

#[cfg(not(target_os = "windows"))]
fn enforce_admin_privileges() {}

fn main() {
    enforce_admin_privileges();
    
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![check_prohibited_apps, exit_app])
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            // On Windows, register the vignan-exam:// URL scheme in the registry.
            // On macOS the scheme is registered automatically via Info.plist
            // (embedded from tauri.conf.json plugins.deep-link) — calling
            // register() on macOS panics with "unsupported platform".
            #[cfg(target_os = "windows")]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register("vignan-exam")?;
            }
            #[cfg(target_os = "macos")]
            {
                // Lock down macOS to create a true kiosk mode (disables Cmd+Tab, Dock, Menu Bar, Spaces)
                unsafe {
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
                            // 0 is NSWindowSharingTypeNone (prevents screenshots/screen recording)
                            let _: () = objc2::msg_send![ns_win, setSharingType: 0_isize];
                        }
                    }
                }
                
                let _ = win.eval(LOCKDOWN_JS);
                let _ = win.set_focus();
            }

            if detect_vm() {
                println!("VM Detected. Exiting.");
                let flag_path = std::env::temp_dir().join("vignan_exit.flag");
                let _ = std::fs::write(flag_path, "1");
                std::process::exit(0);
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

            // Prohibited app watchdog thread
            std::thread::spawn(|| {
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    let apps = check_prohibited_apps();
                    if !apps.is_empty() {
                        enable_task_manager();
                        let flag_path = std::env::temp_dir().join("vignan_exit.flag");
                        let _ = std::fs::write(flag_path, "1");
                        std::process::exit(0);
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
                    api.prevent_close(); // Block Cmd+Q
                    // Notify frontend to show alert
                    if let Some(webview_window) = window.get_webview_window("exam") {
                        let _ = webview_window.eval("alert('Force close detected! The proctor has been notified.');");
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the Vignan lockdown app");
}
