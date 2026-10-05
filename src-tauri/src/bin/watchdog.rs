#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "windows")]
#[path = "../winlock.rs"]
mod winlock;

use std::env;
use std::process::Command;
use std::thread;
use std::time::Duration;
use sysinfo::System;

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        println!("Usage: watchdog <pid> <executable_path>");
        std::process::exit(1);
    }

    let target_pid_str = &args[1];
    let executable_path = &args[2];
    
    let target_pid = match target_pid_str.parse::<u32>() {
        Ok(pid) => sysinfo::Pid::from_u32(pid),
        Err(_) => std::process::exit(1),
    };

    let mut sys = System::new_all();
    
    loop {
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        
        // If the process is no longer running, it means it crashed or was force quit
        if sys.process(target_pid).is_none() {
            let flag_path = env::temp_dir().join("vignan_exit.flag");
            if flag_path.exists() {
                let _ = std::fs::remove_file(flag_path);
                restore_desktop();
                std::process::exit(0); // Intentional exit, don't restart
            }
            
            println!("Watchdog: Target process {} died! Restarting...", target_pid);
            
            // Restart the main application
            match Command::new(executable_path).spawn() {
                Ok(_) => {
                    println!("Watchdog: Successfully restarted application.");
                }
                Err(e) => {
                    eprintln!("Watchdog: Failed to restart application: {}", e);
                    restore_desktop();
                }
            }
            
            // Exit watchdog after restarting
            std::process::exit(0);
        }
        
        thread::sleep(Duration::from_millis(500));
    }
}

/// Taskbar and Ctrl+Alt+Del policies back to normal once the exam browser is
/// gone for good (its own keyboard hook dies with it).
fn restore_desktop() {
    #[cfg(target_os = "windows")]
    winlock::restore_desktop();
}
