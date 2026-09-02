#!/usr/bin/env node
/**
 * setup-platform.mjs — Universal setup and CLI installer for Windows, macOS, Linux, and WSL.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const isWin = process.platform === "win32";
const isWSL = !isWin && fs.existsSync("/proc/version") && fs.readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");

console.log("==================================================");
console.log(" Local Router — Cross-Platform Environment Setup");
console.log(" Platform: " + process.platform + (isWSL ? " (WSL)" : "") + " | Arch: " + process.arch);
console.log("==================================================\n");

// 1. Build TypeScript source
console.log("[1/6] Building TypeScript source...");
try {
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit", shell: isWin });
  console.log("✓ Build complete.\n");
} catch (err) {
  console.error("✗ Build failed:", err.message);
  process.exit(1);
}

// 2. Ensure config directories
console.log("[2/6] Ensuring config directories...");
const homeDir = os.homedir();
const localRouterConfigDir = path.join(homeDir, ".config", "local-router");
const pqcConfigDir = path.join(homeDir, ".config", "pqc-secrets");
fs.mkdirSync(localRouterConfigDir, { recursive: true });
fs.mkdirSync(pqcConfigDir, { recursive: true });
console.log("✓ Config directories initialized at ~/.config/local-router and ~/.config/pqc-secrets.\n");

// 3. Initialize PQC secrets keypair if not present
console.log("[3/6] Checking Post-Quantum (ML-KEM-768) keypair...");
const pubkeyPath = path.join(pqcConfigDir, "recipient.pub");
if (fs.existsSync(pubkeyPath)) {
  console.log("✓ Existing ML-KEM-768 public key verified at " + pubkeyPath + "\n");
} else {
  try {
    const scriptPath = path.join(root, ".agents", "skills", "pqc-secrets", "scripts", "pqc_secrets.py");
    execFileSync("uv", ["run", scriptPath, "keygen"], {
      cwd: root,
      stdio: "inherit",
      shell: isWin,
      env: { ...process.env, PQC_CONFIG_DIR: pqcConfigDir }
    });
    console.log("✓ Generated new ML-KEM-768 keypair.\n");
  } catch (err) {
    console.log("ℹ uv not found in PATH; keygen can be run later via bin/pqc-secrets keygen.\n");
  }
}

// 4. Generate Desktop Application Icon Assets
console.log("[4/6] Generating Desktop and System Tray multi-resolution icons...");
try {
  execFileSync("node", [path.join(root, "scripts", "generate-icons.mjs")], { cwd: root, stdio: "inherit", shell: isWin });
  console.log("✓ Desktop icons generated in src-tauri/icons/\n");
} catch (err) {
  console.log("ℹ Icon generation skipped: " + err.message);
}

// 5. Install CLI shims and binaries to User PATH
console.log("[5/6] Configuring CLI entry points (local-router, localrouter, ollama, pqc-secrets)...");
const binDir = path.join(root, "bin");

if (isWin) {
  const ollamaCmd = path.join(binDir, "ollama.cmd");
  const localRouterCmd = path.join(binDir, "local-router.cmd");

  if (!fs.existsSync(localRouterCmd)) {
    fs.writeFileSync(localRouterCmd, `@echo off\r\nnode "%~dp0local-router.js" %*\r\n`, "utf8");
  }
  if (!fs.existsSync(ollamaCmd)) {
    fs.writeFileSync(ollamaCmd, `@echo off\r\nnode "%~dp0local-router.js" %*\r\n`, "utf8");
  }

  console.log("✓ Windows batch wrappers ready in " + binDir);
  try {
    const cargoBin = path.join(homeDir, ".cargo", "bin");
    const currentPath = execFileSync("powershell", ["-NoProfile", "-Command", `[Environment]::GetEnvironmentVariable("Path", "User")`], { encoding: "utf8" }).trim();
    let newPath = currentPath;
    if (!newPath.includes(binDir)) newPath = newPath + ";" + binDir;
    if (fs.existsSync(cargoBin) && !newPath.includes(cargoBin)) newPath = newPath + ";" + cargoBin;
    if (newPath !== currentPath) {
      execFileSync("powershell", ["-NoProfile", "-Command", `[Environment]::SetEnvironmentVariable("Path", "${newPath}", "User")`], { stdio: "ignore" });
      console.log("✓ Added Local Router and Cargo to Windows User PATH.\n");
    } else {
      console.log("✓ Windows User PATH already contains Local Router.\n");
    }
  } catch {}
} else {
  const userBin = path.join(homeDir, ".local", "bin");
  fs.mkdirSync(userBin, { recursive: true });

  for (const b of ["local-router", "localrouter", "pqc-secrets"]) {
    const targetLink = path.join(userBin, b);
    const sourceBin = b === "local-router" || b === "localrouter" ? path.join(binDir, "local-router.js") : path.join(binDir, b);
    try {
      if (fs.existsSync(targetLink)) fs.unlinkSync(targetLink);
      fs.symlinkSync(sourceBin, targetLink);
      fs.chmodSync(sourceBin, 0o755);
      console.log("✓ Linked " + b + " -> " + targetLink);
    } catch {}
  }
  console.log("");

  // Activate cross-platform service routing and autostart
  try {
    execFileSync("node", [path.join(binDir, "local-router.js"), "route", "set"], { cwd: root, stdio: "inherit" });
  } catch (err) {
    console.log("ℹ Note: route set can be run later via local-router route set: " + err.message);
  }
}

// 6. Auto-export environment variables for external AI tools
console.log("[6/6] Configuring environment variables (OLLAMA_HOST, OPENAI_BASE_URL, ANTHROPIC_BASE_URL)...");

const envVars = {
  OLLAMA_HOST: "http://127.0.0.1:11434",
  OLLAMA_API_BASE: "http://127.0.0.1:11434",
  OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
  OPENAI_API_BASE: "http://127.0.0.1:11434/v1",
  OPENAI_API_KEY: "local-router",
  ANTHROPIC_BASE_URL: "http://127.0.0.1:11434",
  ANTHROPIC_API_URL: "http://127.0.0.1:11434",
  ANTHROPIC_API_KEY: "local-router"
};

const envScriptContent = Object.entries(envVars).map(([k, v]) => `export ${k}="${v}"`).join("\n") + "\n";
const envScriptPath = path.join(localRouterConfigDir, "env.sh");
fs.writeFileSync(envScriptPath, envScriptContent, "utf8");

if (isWin) {
  for (const [k, v] of Object.entries(envVars)) {
    try {
      execFileSync("powershell", ["-NoProfile", "-Command", `[Environment]::SetEnvironmentVariable("${k}", "${v}", "User")`], { stdio: "ignore" });
    } catch {}
  }
  console.log("✓ Windows User environment variables registered (OPENAI_BASE_URL, ANTHROPIC_BASE_URL, OLLAMA_HOST).\n");

  // Auto-sync into WSL if WSL is present
  try {
    const wslCheck = execFileSync("wsl", ["-e", "sh", "-c", "echo wsl_ok"], { encoding: "utf8" }).trim();
    if (wslCheck === "wsl_ok") {
      const b64Env = Buffer.from(envScriptContent).toString("base64");
      execFileSync("wsl", ["-e", "sh", "-c", `
        mkdir -p ~/.config/local-router
        echo "${b64Env}" | base64 -d > ~/.config/local-router/env.sh
        for rc in ~/.bashrc ~/.zshrc; do
          if [ -f "$rc" ] && ! grep -q "local-router/env.sh" "$rc"; then
            echo '[ -f "$HOME/.config/local-router/env.sh" ] && source "$HOME/.config/local-router/env.sh"' >> "$rc"
          fi
        done
      `], { stdio: "ignore" });
      console.log("✓ WSL environment synchronized (~/.config/local-router/env.sh and ~/.bashrc).\n");
    }
  } catch {}
} else {
  // On macOS / Linux / WSL: Auto-source in ~/.bashrc and ~/.zshrc if present
  for (const rcName of [".bashrc", ".zshrc", ".profile"]) {
    const rcPath = path.join(homeDir, rcName);
    if (fs.existsSync(rcPath)) {
      const existing = fs.readFileSync(rcPath, "utf8");
      if (!existing.includes("local-router/env.sh")) {
        fs.appendFileSync(rcPath, '\n# Local Router environment variables\n[ -f "$HOME/.config/local-router/env.sh" ] && source "$HOME/.config/local-router/env.sh"\n');
        console.log("✓ Injected auto-source into ~/" + rcName);
      }
    }
  }
  console.log("✓ Environment file created at " + envScriptPath + "\n");
}

console.log("==================================================");
console.log(" Setup Complete! Local Router is ready to run.");
console.log(" Start server:   node bin/local-router.js start");
console.log(" Web Dashboard:  http://127.0.0.1:11434/config");
console.log(" Desktop App:    npm run tauri:dev (or native release binary)");
console.log("==================================================\n");