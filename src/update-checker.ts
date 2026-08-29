import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface UpdateStatus {
  currentVersion: string;
  currentCommit: string;
  latestCommit: string | null;
  hasUpdate: boolean;
  lastCheckedAt: number;
  message?: string;
  error?: string;
}

let cachedStatus: UpdateStatus | null = null;
let lastCheckTime = 0;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

export function getCurrentCommit(projectRoot: string): string {
  try {
    const res = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 3000
    });
    if (res.stdout) return res.stdout.trim();
  } catch {
    // fallback
  }
  return "unknown";
}

export function getCurrentVersion(projectRoot: string): string {
  try {
    const pkgPath = path.join(projectRoot, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      return pkg.version || "1.0.0";
    }
  } catch {
    // fallback
  }
  return "1.0.0";
}

export async function checkUpdateStatus(projectRoot: string, force = false): Promise<UpdateStatus> {
  const now = Date.now();
  if (!force && cachedStatus && now - lastCheckTime < CACHE_TTL_MS) {
    return cachedStatus;
  }

  const currentVersion = getCurrentVersion(projectRoot);
  const currentCommit = getCurrentCommit(projectRoot);
  let latestCommit: string | null = null;
  let hasUpdate = false;
  let errorMsg: string | undefined;

  try {
    // Method 1: Check via git ls-remote if git is available
    const gitRes = spawnSync("git", ["ls-remote", "origin", "main"], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 5000
    });
    if (gitRes.stdout && gitRes.stdout.trim()) {
      const fullHash = gitRes.stdout.trim().split(/\s+/)[0];
      if (fullHash) {
        latestCommit = fullHash.slice(0, 7);
        if (currentCommit !== "unknown" && latestCommit !== currentCommit) {
          hasUpdate = true;
        }
      }
    }
  } catch (err: any) {
    errorMsg = err?.message || String(err);
  }

  // Method 2: Check GitHub API if git remote check did not resolve
  if (!latestCommit) {
    try {
      const res = await fetch("https://api.github.com/repos/nbiish/local-router/commits/main", {
        headers: { "User-Agent": "LocalRouter-UpdateChecker/1.0" },
        signal: AbortSignal.timeout(4000)
      });
      if (res.ok) {
        const payload = await res.json() as any;
        if (payload?.sha) {
          latestCommit = String(payload.sha).slice(0, 7);
          if (currentCommit !== "unknown" && latestCommit !== currentCommit) {
            hasUpdate = true;
          }
          errorMsg = undefined;
        }
      }
    } catch {
      // offline / quiet fallback
    }
  }

  cachedStatus = {
    currentVersion,
    currentCommit,
    latestCommit: latestCommit || currentCommit,
    hasUpdate,
    lastCheckedAt: now,
    error: errorMsg
  };
  lastCheckTime = now;
  return cachedStatus;
}

export interface ApplyUpdateResult {
  success: boolean;
  updated: boolean;
  message: string;
  fromCommit?: string;
  toCommit?: string;
  error?: string;
}

export function applyUpdate(projectRoot: string): ApplyUpdateResult {
  const isWin = process.platform === "win32";
  const fromCommit = getCurrentCommit(projectRoot);

  try {
    // 1. Git pull latest main
    const pullRes = spawnSync("git", ["pull", "--ff-only", "origin", "main"], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 30000,
      shell: isWin
    });
    if (pullRes.status !== 0 && pullRes.stderr) {
      // Try regular git pull if ff-only is not configured
      spawnSync("git", ["pull", "origin", "main"], {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: 30000,
        shell: isWin
      });
    }

    // 2. Install dependencies if needed
    spawnSync("npm", ["install", "--prefer-offline"], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 60000,
      shell: isWin
    });

    // 3. Rebuild TypeScript
    const buildRes = spawnSync("npm", ["run", "build"], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 60000,
      shell: isWin
    });
    if (buildRes.status !== 0) {
      return {
        success: false,
        updated: false,
        message: "TypeScript build failed during update.",
        error: buildRes.stderr || buildRes.stdout
      };
    }

    const toCommit = getCurrentCommit(projectRoot);
    cachedStatus = null; // Invalidate cache

    return {
      success: true,
      updated: toCommit !== fromCommit,
      message: toCommit !== fromCommit ? `Successfully updated from ${fromCommit} to ${toCommit}.` : "Local Router is already up to date.",
      fromCommit,
      toCommit
    };
  } catch (err: any) {
    return {
      success: false,
      updated: false,
      message: "Failed to apply update.",
      error: err?.message || String(err)
    };
  }
}
