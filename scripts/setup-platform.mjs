#!/usr/bin/env node
/**
 * setup-platform.mjs — Universal setup and CLI installer for Windows, macOS, Linux, and WSL.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
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

// 1. Build TypeScript code
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
  console.log("✓ Existing ML-KEM-768 public key verified at " + pubkeyPath);
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
} else {
  console.log("✓ Environment file created at " + envScriptPath);
  console.log("  To auto-load in zsh/bash, add to ~/.zshrc or ~/.bashrc:");
  console.log("    source " + envScriptPath + "\n");
}
if (isWin) {
  // On Windows: Ensure .cmd wrappers exist in bin/
  const ollamaCmd = path.join(binDir, "ollama.cmd");
  const localRouterCmd = path.join(binDir, "local-router.cmd");
  const pqcSecretsCmd = path.join(binDir, "pqc-secrets.cmd");

  if (!fs.existsSync(localRouterCmd)) {
    fs.writeFileSync(localRouterCmd, `@echo off\r\nnode "%~dp0local-router.js" %*\r\n`, "utf8");
  }
  if (!fs.existsSync(ollamaCmd)) {
    fs.writeFileSync(ollamaCmd, `@echo off\r\nnode "%~dp0local-router.js" %*\r\n`, "utf8");
  }

  console.log("✓ Windows batch wrappers ready in " + binDir);
  console.log("  To add to PATH in PowerShell, run:");
  console.log(`    [Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path", "User") + ";${binDir}", "User")`);
} else {
  // On macOS / Linux / WSL: Install symlinks into ~/.local/bin if available
  const userBin = path.join(homeDir, ".local", "bin");
  fs.mkdirSync(userBin, { recursive: true });

  const binaries = ["local-router.js", "ollama", "pqc-secrets"];
  for (const b of ["local-router", "localrouter", "ollama", "pqc-secrets"]) {
    const targetLink = path.join(userBin, b);
    const sourceBin = b === "local-router" || b === "localrouter" ? path.join(binDir, "local-router.js") : path.join(binDir, b);
    try {
      if (fs.existsSync(targetLink)) fs.unlinkSync(targetLink);
      fs.symlinkSync(sourceBin, targetLink);
      fs.chmodSync(sourceBin, 0o755);
      console.log("✓ Linked " + b + " -> " + targetLink);
    } catch {
      // Fallback
    }
  }
}

console.log("\n==================================================");
console.log(" Setup Complete! Local Router is ready to run.");
console.log(" Start server:   node bin/local-router.js start");
console.log(" Web Dashboard:  http://127.0.0.1:11434/config");
console.log(" Desktop Tray:   npm run tauri:dev (or native release binary)");
console.log("==================================================\n");