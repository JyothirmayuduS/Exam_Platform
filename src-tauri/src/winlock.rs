// Windows kiosk lock — the counterpart of the macOS presentation options and
// keylock. Everything here works for a per-user install without admin rights
// and without sending the student to Settings:
//
//   • a low-level keyboard hook drops Win, Ctrl, Alt (so Alt+Tab, Win+Tab,
//     Ctrl+Esc, Ctrl+Shift+Esc, Win+Shift+S never form), Escape, function,
//     PrintScreen and browser/launch keys;
//   • the taskbar is hidden;
//   • per-user policies remove Task Manager, Win+L lock, password change and
//     sign-out from the Ctrl+Alt+Del screen (the one key combination Windows
//     never lets a hook see);
//   • camera / microphone consent is switched on for desktop apps.
//
// The hook dies with the process. The taskbar and policies do not, so the
// watchdog calls `restore_desktop` when the exam browser is gone for good.
#![allow(dead_code)]

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Registry::{
    RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, REG_DWORD, REG_SZ,
    RRF_RT_REG_SZ,
};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, FindWindowExW, FindWindowW, GetMessageW, PostThreadMessageW, SetWindowsHookExW,
    ShowWindow, TranslateMessage, UnhookWindowsHookEx, HC_ACTION, KBDLLHOOKSTRUCT, LLKHF_ALTDOWN, MSG, SW_HIDE,
    SW_SHOW, WH_KEYBOARD_LL, WM_QUIT,
};

static HOOK_ACTIVE: AtomicBool = AtomicBool::new(false);
static HOOK_STARTED: AtomicBool = AtomicBool::new(false);
static HOOK_THREAD: AtomicU32 = AtomicU32::new(0);
static BYPASS: AtomicBool = AtomicBool::new(false);

const POLICY_SYSTEM: PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System");
const POLICY_EXPLORER: PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer");
const POLICIES: &[(PCWSTR, PCWSTR)] = &[
    (POLICY_SYSTEM, w!("DisableTaskMgr")),
    (POLICY_SYSTEM, w!("DisableLockWorkstation")),
    (POLICY_SYSTEM, w!("DisableChangePassword")),
    (POLICY_EXPLORER, w!("NoLogoff")),
];

static LOCKED: AtomicBool = AtomicBool::new(false);

/// Full lockdown: keyboard hook, hidden taskbar, Ctrl+Alt+Del policies.
pub fn lock() {
    LOCKED.store(true, Ordering::SeqCst);
    set_policies(true);
    set_taskbar(false);
    start_keyboard();
}

/// Undo `lock` (clean exit / relaunch).
pub fn unlock() {
    LOCKED.store(false, Ordering::SeqCst);
    stop_keyboard();
    restore_desktop();
}

/// Re-apply taskbar and policies while locked: Explorer restarts show the
/// taskbar again, and a previous instance's watchdog may restore the desktop
/// just after this instance locked it.
pub fn reassert() {
    if LOCKED.load(Ordering::SeqCst) && !BYPASS.load(Ordering::SeqCst) {
        set_policies(true);
        set_taskbar(false);
        start_keyboard();
    }
}

/// Taskbar and policies back to normal. Safe to call from another process.
pub fn restore_desktop() {
    set_policies(false);
    set_taskbar(true);
}

/// Let keys through while a native dialog must stay operable.
pub fn set_bypass(on: bool) {
    BYPASS.store(on, Ordering::SeqCst);
}

pub fn keyboard_active() -> bool {
    HOOK_ACTIVE.load(Ordering::SeqCst)
}

fn set_policies(on: bool) {
    for (key, name) in POLICIES {
        unsafe {
            if on {
                let one: u32 = 1;
                let _ = RegSetKeyValueW(
                    HKEY_CURRENT_USER,
                    *key,
                    *name,
                    REG_DWORD.0,
                    Some(&one as *const u32 as *const _),
                    4,
                );
            } else {
                let _ = RegDeleteKeyValueW(HKEY_CURRENT_USER, *key, *name);
            }
        }
    }
}

fn set_taskbar(visible: bool) {
    let cmd = if visible { SW_SHOW } else { SW_HIDE };
    unsafe {
        if let Ok(tray) = FindWindowW(w!("Shell_TrayWnd"), PCWSTR::null()) {
            let _ = ShowWindow(tray, cmd);
        }
        // One secondary taskbar per extra monitor.
        let mut prev: Option<HWND> = None;
        while let Ok(h) = FindWindowExW(None, prev, w!("Shell_SecondaryTrayWnd"), PCWSTR::null()) {
            let _ = ShowWindow(h, cmd);
            prev = Some(h);
        }
    }
}

fn should_block(kb: &KBDLLHOOKSTRUCT) -> bool {
    if kb.flags.0 & LLKHF_ALTDOWN.0 != 0 {
        return true;
    }
    let vk = VIRTUAL_KEY(kb.vkCode as u16);
    // Modifiers are dropped on their own, so no combination can form.
    const BLOCKED: &[VIRTUAL_KEY] = &[
        VK_LWIN, VK_RWIN, VK_APPS, VK_CONTROL, VK_LCONTROL, VK_RCONTROL, VK_MENU, VK_LMENU, VK_RMENU, VK_ESCAPE,
        VK_SNAPSHOT, VK_SLEEP, VK_HELP, VK_BROWSER_BACK, VK_BROWSER_FORWARD, VK_BROWSER_REFRESH, VK_BROWSER_STOP,
        VK_BROWSER_SEARCH, VK_BROWSER_FAVORITES, VK_BROWSER_HOME, VK_LAUNCH_MAIL, VK_LAUNCH_MEDIA_SELECT,
        VK_LAUNCH_APP1, VK_LAUNCH_APP2,
    ];
    BLOCKED.contains(&vk) || (VK_F1.0..=VK_F24.0).contains(&vk.0)
}

unsafe extern "system" fn on_key(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && !BYPASS.load(Ordering::SeqCst) {
        let kb = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        if should_block(kb) {
            return LRESULT(1);
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

fn start_keyboard() {
    if HOOK_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| unsafe {
        let module = GetModuleHandleW(PCWSTR::null()).ok().map(|m| HINSTANCE(m.0));
        let Ok(hook) = SetWindowsHookExW(WH_KEYBOARD_LL, Some(on_key), module, 0) else {
            HOOK_STARTED.store(false, Ordering::SeqCst);
            return;
        };
        HOOK_THREAD.store(GetCurrentThreadId(), Ordering::SeqCst);
        HOOK_ACTIVE.store(true, Ordering::SeqCst);
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        let _ = UnhookWindowsHookEx(hook);
        HOOK_ACTIVE.store(false, Ordering::SeqCst);
        HOOK_THREAD.store(0, Ordering::SeqCst);
        HOOK_STARTED.store(false, Ordering::SeqCst);
    });
}

fn stop_keyboard() {
    let thread = HOOK_THREAD.load(Ordering::SeqCst);
    if thread != 0 {
        unsafe {
            let _ = PostThreadMessageW(thread, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
}

fn read_sz(root: HKEY, key: PCWSTR, name: PCWSTR) -> Option<String> {
    let mut buf = [0u16; 256];
    let mut len = (buf.len() * 2) as u32;
    let ok = unsafe {
        RegGetValueW(root, key, name, RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr() as *mut _), Some(&mut len))
    };
    if ok.is_err() {
        return None;
    }
    let n = (len as usize / 2).saturating_sub(1).min(buf.len());
    Some(String::from_utf16_lossy(&buf[..n]))
}

fn write_sz(key: PCWSTR, name: PCWSTR, value: &str) -> bool {
    let wide: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        RegSetKeyValueW(
            HKEY_CURRENT_USER,
            key,
            name,
            REG_SZ.0,
            Some(wide.as_ptr() as *const _),
            (wide.len() * 2) as u32,
        )
        .is_ok()
    }
}

fn consent_keys(kind: &str) -> (PCWSTR, PCWSTR) {
    if kind == "microphone" {
        (
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone"),
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged"),
        )
    } else {
        (
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\webcam"),
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\webcam\\NonPackaged"),
        )
    }
}

/// Windows privacy switches for camera / microphone. "denied" when the device
/// switch (admin-only) or the per-user / desktop-app switch is off.
pub fn media_status(kind: &str) -> String {
    let (base, desktop) = consent_keys(kind);
    let off = |root, key| read_sz(root, key, w!("Value")).is_some_and(|v| v.eq_ignore_ascii_case("Deny"));
    if off(HKEY_LOCAL_MACHINE, base) || off(HKEY_CURRENT_USER, base) || off(HKEY_CURRENT_USER, desktop) {
        "denied".into()
    } else {
        "granted".into()
    }
}

/// Turn on the per-user and desktop-app switches (both live in HKCU, so no
/// admin and no Settings trip). The device-wide switch stays as the admin set it.
pub fn request_media(kind: &str) -> String {
    let (base, desktop) = consent_keys(kind);
    write_sz(base, w!("Value"), "Allow");
    write_sz(desktop, w!("Value"), "Allow");
    media_status(kind)
}

/// BIOS vendor / model strings (wmic is gone from current Windows 11).
pub fn bios_identity() -> String {
    let key = w!("HARDWARE\\DESCRIPTION\\System\\BIOS");
    let maker = read_sz(HKEY_LOCAL_MACHINE, key, w!("SystemManufacturer")).unwrap_or_default();
    let model = read_sz(HKEY_LOCAL_MACHINE, key, w!("SystemProductName")).unwrap_or_default();
    format!("{maker} {model}").to_lowercase()
}
