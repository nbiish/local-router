use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// How the router daemon's `local-router` CLI is reached from the desktop app.
enum ServerLauncher {
    /// Repo checkout root (a directory whose package.json names "local-router"
    /// and that has build/index.js). Found by walking up from the executable,
    /// so it works no matter the cwd (Finder launches get "/").
    Repo(PathBuf),
    /// The `local-router` shim installed on PATH by `npm run setup`
    /// (~/.local/bin on Unix, the User PATH on Windows).
    PathShim,
}

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

        let Some(launcher) = resolve_launcher() else {
            let exe = std::env::current_exe()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| "<unknown>".to_string());
            eprintln!(
                "[daemon] Cannot locate the Local Router server.\n  \
                 Tried: (1) a repo root (package.json name \"local-router\" + build/index.js) \
                 above the executable at {}\n  \
                 and   (2) a `local-router` shim on PATH (~/.local/bin/local-router).\n  \
                 Run `npm run setup` inside the repo to install the shim.",
                exe
            );
            return;
        };

        match self.spawn_command(&launcher).spawn() {
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

    /// Restart the daemon unconditionally (explicit user action from the tray).
    /// This also restarts a daemon started outside the app: `local-router stop`
    /// resolves the running server through its state file / port, not through
    /// our child handle.
    pub fn restart(&self) {
        println!("[daemon] Restarting Local Router daemon...");
        self.kill_owned_child();
        self.stop_via_cli();
        // Give the OS a beat to release the listen port before rebinding.
        std::thread::sleep(Duration::from_millis(300));
        self.ensure_started();
    }

    /// Stop the daemon if this app started it. A daemon started elsewhere
    /// (e.g. `local-router start` from a terminal) is left running.
    pub fn stop(&self) {
        if self.kill_owned_child() {
            // `local-router start` detaches the real server process and exits,
            // so our child handle is only the launcher. Confirm the shutdown
            // through the CLI, which tracks the server via its state file.
            self.stop_via_cli();
            println!("[daemon] Stopped the Local Router daemon owned by this app.");
        } else {
            println!("[daemon] Daemon was not started by this app; leaving it running.");
        }
    }

    /// Command that starts the daemon for the resolved launcher. Absolute
    /// paths / PATH-shim forms only — never a bare `node build/index.js`
    /// relative to an arbitrary cwd.
    fn spawn_command(&self, launcher: &ServerLauncher) -> Command {
        let mut cmd = match launcher {
            ServerLauncher::Repo(root) => {
                let cli = root.join("bin").join("local-router.js");
                let mut c = Command::new("node");
                if cli.is_file() {
                    c.arg(&cli).arg("start").arg("--port").arg(self.port.to_string());
                } else {
                    // Partial checkout without the CLI: run the built server
                    // directly with an absolute path.
                    c.arg(root.join("build").join("index.js"));
                    c.env("PORT", self.port.to_string());
                }
                c.current_dir(root);
                c
            }
            ServerLauncher::PathShim => shim_command("start", self.port),
        };
        no_window(&mut cmd);
        cmd
    }

    /// Command that stops the daemon via the CLI, when a CLI form exists.
    fn stop_command(&self, launcher: &ServerLauncher) -> Option<Command> {
        let mut cmd = match launcher {
            ServerLauncher::Repo(root) => {
                let cli = root.join("bin").join("local-router.js");
                if !cli.is_file() {
                    // Repo without the CLI only ever runs the server as our
                    // direct child, which kill_owned_child() already handled.
                    return None;
                }
                let mut c = Command::new("node");
                c.arg(&cli).arg("stop").arg("--port").arg(self.port.to_string());
                c.current_dir(root);
                c
            }
            ServerLauncher::PathShim => shim_command("stop", self.port),
        };
        no_window(&mut cmd);
        Some(cmd)
    }

    fn stop_via_cli(&self) {
        let Some(launcher) = resolve_launcher() else {
            eprintln!("[daemon] Cannot locate the local-router CLI to stop the daemon.");
            return;
        };
        let Some(mut cmd) = self.stop_command(&launcher) else {
            return;
        };
        match cmd.output() {
            Ok(out) if out.status.success() => {
                println!("[daemon] Stopped Local Router via the CLI.");
            }
            Ok(out) => {
                eprintln!(
                    "[daemon] CLI stop exited with {}: {}",
                    out.status,
                    String::from_utf8_lossy(&out.stderr).trim()
                );
            }
            Err(e) => eprintln!("[daemon] Failed to run the CLI stop: {}", e),
        }
    }

    fn kill_owned_child(&self) -> bool {
        let mut lock = self.child.lock().unwrap();
        match lock.take() {
            Some(mut child) => {
                let _ = child.kill();
                let _ = child.wait();
                true
            }
            None => false,
        }
    }
}

/// Repo roots ship package.json with name "local-router" plus a built server.
fn is_repo_root(dir: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(dir.join("package.json")) else {
        return false;
    };
    let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    pkg.get("name").and_then(|v| v.as_str()) == Some("local-router")
        && dir.join("build").join("index.js").is_file()
}

/// Walk up from the executable to the first enclosing repo root.
fn find_repo_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors().skip(1).find(|dir| is_repo_root(dir)).map(Path::to_path_buf)
}

fn resolve_launcher() -> Option<ServerLauncher> {
    if let Some(root) = find_repo_root() {
        return Some(ServerLauncher::Repo(root));
    }
    if shim_available() {
        return Some(ServerLauncher::PathShim);
    }
    None
}

/// True when a `local-router` shim is reachable without a repo checkout.
fn shim_available() -> bool {
    let names: &[&str] = if cfg!(target_os = "windows") {
        &["local-router.cmd", "local-router.exe"]
    } else {
        &["local-router"]
    };
    if let Some(home) = std::env::var_os("HOME") {
        let shim_dir = Path::new(&home).join(".local").join("bin");
        if names.iter().any(|n| shim_dir.join(n).is_file()) {
            return true;
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            if names.iter().any(|n| dir.join(n).is_file()) {
                return true;
            }
        }
    }
    false
}

/// PATH-shim invocation. On Unix std searches PATH directly; on Windows
/// `cmd /C` performs the PATHEXT resolution needed to find the .cmd shim.
#[cfg(target_os = "windows")]
fn shim_command(subcommand: &str, port: u16) -> Command {
    let mut c = Command::new("cmd");
    c.args(["/C", "local-router", subcommand, "--port", &port.to_string()]);
    c
}

#[cfg(not(target_os = "windows"))]
fn shim_command(subcommand: &str, port: u16) -> Command {
    let mut c = Command::new("local-router");
    c.arg(subcommand).arg("--port").arg(port.to_string());
    c
}

/// Keep helper processes from flashing a console window on Windows.
#[cfg(target_os = "windows")]
fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn no_window(_cmd: &mut Command) {}
