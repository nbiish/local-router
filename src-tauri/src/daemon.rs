use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;

pub struct DaemonManager {
    child: Mutex<Option<Child>>,
    port: u16,
}

impl DaemonManager {
    pub fn new(port: u16) -> Self {
        Self {
            child: Mutex::new(None),
            port,
        }
    }

    pub fn is_running(&self) -> bool {
        let url = format!("http://127.0.0.1:{}/api/version", self.port);
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_millis(800))
            .build();

        if let Ok(client) = client {
            if let Ok(res) = client.get(&url).send() {
                return res.status().is_success();
            }
        }
        false
    }

    pub fn ensure_started(&self) {
        if self.is_running() {
            println!("[daemon] Local Router daemon is already running on port {}", self.port);
            return;
        }

        println!("[daemon] Starting Local Router daemon on port {}...", self.port);
        
        #[cfg(target_os = "windows")]
        let cmd = Command::new("cmd")
            .args(["/C", "local-router start || node build/index.js"])
            .spawn();

        #[cfg(not(target_os = "windows"))]
        let cmd = Command::new("sh")
            .args(["-c", "local-router start || node build/index.js"])
            .spawn();

        match cmd {
            Ok(child) => {
                let mut lock = self.child.lock().unwrap();
                *lock = Some(child);
                println!("[daemon] Spawned Local Router background process.");
            }
            Err(e) => {
                eprintln!("[daemon] Failed to spawn Local Router process: {}", e);
            }
        }

        // Wait up to 5 seconds for daemon to become ready
        for _ in 0..20 {
            if self.is_running() {
                println!("[daemon] Local Router daemon is online and responsive on port {}.", self.port);
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }

    pub fn restart(&self) {
        println!("[daemon] Restarting Local Router daemon...");
        self.stop();
        std::thread::sleep(Duration::from_millis(500));
        self.ensure_started();
    }

    pub fn stop(&self) {
        let mut lock = self.child.lock().unwrap();
        if let Some(mut child) = lock.take() {
            let _ = child.kill();
            let _ = child.wait();
            println!("[daemon] Stopped child process.");
        }
    }
}