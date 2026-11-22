#!/usr/bin/env node
/**
 * install-desktop.mjs — Desktop launcher installer for the Local Router Tauri app.
 *
 * macOS:   builds the release bundle, installs it to ~/Applications/Local Router.app
 *          (owner-marker protected, staged swap, ad-hoc codesigned) and symlinks
 *          it onto ~/Desktop.
 * Windows: builds the release exe and creates Desktop + Start Menu shortcuts (.lnk)
 *          via the WScript.Shell COM API.
 * Linux:   not supported (prints a note, exits 0).
 *
 * Flags: --dry-run (print the plan, change nothing), --skip-build (reuse the
 * existing bundle/binary).
 *
 * Deletion scope is strictly limited to: the staged tmp sibling dir inside
 * ~/Applications, ~/Applications/Local Router.app, the ~/Desktop/Local Router.app
 * symlink we own, and the two Windows .lnk targets.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const DRY_RUN = process.argv.includes("--dry-run");
const SKIP_BUILD = process.argv.includes("--skip-build");
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

const APP_NAME = "Local Router";
const OWNER_ID = "com.nbiish.localrouter";
const MARKER_NAME = ".local-router-owner";
const BUNDLE_APP = path.join(root, "src-tauri", "target", "release", "bundle", "macos", `${APP_NAME}.app`);

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

function plan(message) {
  console.log(`${DRY_RUN ? "[dry-run] " : ""}${message}`);
}

function markerPath(appBundle) {
  return path.join(appBundle, "Contents", "Resources", MARKER_NAME);
}

function isOwnedBundle(appBundle) {
  try {
    return fs.readFileSync(markerPath(appBundle), "utf8").trim() === OWNER_ID;
  } catch {
    return false;
  }
}

function buildRelease() {
  if (SKIP_BUILD) {
    console.log("ℹ --skip-build: reusing existing release artifacts.");
    return;
  }
  if (DRY_RUN) {
    plan(`would run: npm run tauri:build`);
    return;
  }
  console.log("Building release bundle (npm run tauri:build)...");
  run("npm", ["run", "tauri:build"], { cwd: root, shell: IS_WIN });
  console.log("✓ Release build complete.\n");
}

function installMacOS() {
  buildRelease();

  const homeDir = os.homedir();
  const applicationsDir = path.join(homeDir, "Applications");
  const installTarget = path.join(applicationsDir, `${APP_NAME}.app`);
  const desktopLink = path.join(homeDir, "Desktop", `${APP_NAME}.app`);

  if (!DRY_RUN && !fs.existsSync(BUNDLE_APP)) {
    fail(`release bundle not found at ${BUNDLE_APP} — run without --skip-build first.`);
  }
  console.log(`${DRY_RUN ? "[dry-run] " : ""}✓ Bundle source: ${BUNDLE_APP}`);

  // 1. Install (owner-marker protected) into ~/Applications
  const targetExists = fs.existsSync(installTarget);
  if (targetExists && !isOwnedBundle(installTarget)) {
    fail(
      `${installTarget} already exists and is not owned by this installer ` +
        `(missing ${MARKER_NAME} with "${OWNER_ID}"). Remove it manually to proceed.`
    );
  }
  if (DRY_RUN) {
    plan(`would stage-copy bundle → ${installTarget} (marker "${OWNER_ID}", ad-hoc codesign, atomic swap)`);
  } else {
    fs.mkdirSync(applicationsDir, { recursive: true });
    const stageDir = path.join(applicationsDir, `.local-router-stage-${process.pid}-${Date.now()}`);
    const stagedApp = path.join(stageDir, `${APP_NAME}.app`);
    fs.mkdirSync(stageDir, { recursive: true });
    try {
      fs.cpSync(BUNDLE_APP, stagedApp, { recursive: true });
      fs.mkdirSync(path.join(stagedApp, "Contents", "Resources"), { recursive: true });
      fs.writeFileSync(markerPath(stagedApp), `${OWNER_ID}\n`, "utf8");

      console.log("Ad-hoc codesigning staged bundle...");
      run("codesign", ["--force", "--sign", "-", stagedApp]);
      run("codesign", ["--verify", "--strict", stagedApp]);
      console.log("✓ Staged bundle signed and verified.");

      if (targetExists) {
        const previous = path.join(stageDir, "previous.app");
        fs.renameSync(installTarget, previous);
      }
      fs.renameSync(stagedApp, installTarget);
      console.log(`✓ Installed ${installTarget}`);
    } finally {
      if (fs.existsSync(stageDir)) {
        fs.rmSync(stageDir, { recursive: true, force: true });
      }
    }
  }

  // 2. Desktop symlink (convenience; skip politely if the path is occupied by
  //    anything we do not own)
  let linkStatus = null;
  try {
    linkStatus = fs.lstatSync(desktopLink);
  } catch {
    linkStatus = null;
  }
  if (linkStatus && !linkStatus.isSymbolicLink()) {
    console.log(`⚠ ${desktopLink} exists and is not a symlink; leaving it untouched.`);
  } else if (linkStatus && fs.readlinkSync(desktopLink) !== installTarget) {
    console.log(`⚠ ${desktopLink} is a symlink to ${fs.readlinkSync(desktopLink)}; leaving it untouched.`);
  } else if (DRY_RUN) {
    plan(`would symlink ${desktopLink} → ${installTarget}`);
  } else {
    if (linkStatus) fs.unlinkSync(desktopLink);
    fs.symlinkSync(installTarget, desktopLink);
    console.log(`✓ Desktop launcher ${desktopLink} → ${installTarget}`);
  }
}

function findWindowsExe(releaseDir) {
  const candidates = [`${APP_NAME}.exe`, "local-router.exe"];
  for (const name of candidates) {
    const direct = path.join(releaseDir, name);
    if (fs.existsSync(direct)) return direct;
  }
  // Fallback: bounded recursive search below target/release (bundle subfolders).
  const queue = [releaseDir];
  let visited = 0;
  while (queue.length > 0 && visited < 500) {
    const dir = queue.shift();
    visited += 1;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (candidates.includes(entry.name)) return full;
    }
  }
  return null;
}

function installWindows() {
  buildRelease();

  const releaseDir = path.join(root, "src-tauri", "target", "release");
  const exe = findWindowsExe(releaseDir);
  if (!exe && !DRY_RUN) {
    fail(`release exe not found under ${releaseDir} — run without --skip-build first.`);
  }
  const iconPath = path.join(root, "src-tauri", "icons", "icon.ico");
  if (!DRY_RUN && !fs.existsSync(iconPath)) {
    fail(`icon not found at ${iconPath} — run \`npm run tauri:icons\` first.`);
  }

  const shortcutTargets = [
    path.join(os.homedir(), "Desktop", `${APP_NAME}.lnk`),
    path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "Microsoft", "Windows", "Start Menu", "Programs", `${APP_NAME}.lnk`)
  ];

  for (const lnk of shortcutTargets) {
    if (DRY_RUN) {
      plan(`would create shortcut ${lnk} → ${exe || "<release exe>"} (icon: ${iconPath})`);
      continue;
    }
    fs.mkdirSync(path.dirname(lnk), { recursive: true });
    const ps = [
      `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}')`,
      `$s.TargetPath='${exe.replace(/'/g, "''")}'`,
      `$s.IconLocation='${iconPath.replace(/'/g, "''")}'`,
      `$s.Save()`
    ].join("; ");
    run("powershell", ["-NoProfile", "-Command", ps]);
    console.log(`✓ Shortcut ${lnk}`);
  }
}

console.log("==================================================");
console.log(` Local Router — Desktop Launcher Installer`);
console.log(` Platform: ${process.platform}${DRY_RUN ? " | dry-run" : ""}${SKIP_BUILD ? " | skip-build" : ""}`);
console.log("==================================================\n");

if (IS_MAC) {
  installMacOS();
} else if (IS_WIN) {
  installWindows();
} else {
  console.log("Desktop launcher install supports macOS and Windows");
  process.exit(0);
}

console.log("\n==================================================");
console.log(" Desktop launcher install complete.");
console.log("==================================================\n");
