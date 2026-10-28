import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * System-wide client environment for the two agent harnesses the Agents page
 * manages:
 *
 *   Claude Code — Anthropic Messages API (`/v1/messages`)
 *   Codex CLI   — OpenAI Responses API (`/v1/responses`)
 *
 * Both families are written together because the install contract already
 * exports them for every external tool (scripts, Cline, Copilot, …). The
 * Agents page toggles control model remapping and the managed Codex profile,
 * not whether the loopback endpoint is advertised.
 */

export type AgentEnvSyncResult = {
  ok: boolean;
  envScriptPath: string;
  windows: boolean;
  /** Keys whose env.sh / User value now carries the loopback contract. */
  applied: string[];
  error?: string;
};

export function agentHarnessEnv(baseUrl?: string): Record<string, string> {
  const base = (baseUrl || `http://127.0.0.1:${process.env.PORT || '11434'}`).replace(/\/+$/, '');
  const v1 = `${base}/v1`;
  return {
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_API_URL: base,
    ANTHROPIC_API_KEY: 'local-router',
    ANTHROPIC_AUTH_TOKEN: 'local-router',
    OPENAI_BASE_URL: v1,
    OPENAI_API_BASE: v1,
    OPENAI_API_KEY: 'local-router'
  };
}

function shellExportLine(key: string, value: string): string {
  return `export ${key}="${String(value).replace(/(["\\$`])/g, '\\$1')}"`;
}

function parseShellExportValue(line: string, key: string): string | null {
  const match = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)$`).exec(line);
  if (!match) return null;
  let raw = match[1].trim();
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    raw = raw.slice(1, -1);
  }
  return raw.replace(/\\(["\\$`])/g, '$1');
}

/**
 * Update-or-append managed exports while preserving every unrelated line and
 * the operator's ordering. A previous bug used `existingEnv.includes(key)`, so
 * a changed base URL or key was silently left stale.
 */
export function upsertShellExports(existing: string, vars: Record<string, string>): string {
  const lines = existing.length > 0 ? existing.replace(/\r\n/g, '\n').split('\n') : [];
  const out: string[] = [];
  const written = new Set<string>();

  for (const line of lines) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const key = match?.[1];
    if (key && Object.prototype.hasOwnProperty.call(vars, key)) {
      // Rewrite the first occurrence in place and drop any duplicates so a
      // stale later export cannot win when the file is sourced.
      if (written.has(key)) continue;
      out.push(shellExportLine(key, vars[key]));
      written.add(key);
      continue;
    }
    out.push(line);
  }

  if (written.size < Object.keys(vars).length) {
    for (const [key, value] of Object.entries(vars)) {
      if (written.has(key)) continue;
      out.push(shellExportLine(key, value));
      written.add(key);
    }
  }

  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return `${out.join('\n')}\n`;
}

export function readShellExport(content: string, key: string): string | null {
  for (const line of content.replace(/\r\n/g, '\n').split('\n')) {
    const value = parseShellExportValue(line, key);
    if (value !== null) return value;
  }
  return null;
}

function psQuote(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function writeWindowsUserEnv(vars: Record<string, string>): void {
  const pairs = Object.entries(vars)
    .map(([key, value]) => `@{ k = ${psQuote(key)}; v = ${psQuote(value)} }`)
    .join(', ');
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `$ErrorActionPreference = 'Stop'; foreach ($p in @(${pairs})) { [Environment]::SetEnvironmentVariable($p.k, $p.v, 'User') }`
    ],
    { stdio: 'ignore' }
  );
}

function syncIntoWsl(envScript: string): void {
  try {
    const wslCheck = execFileSync('wsl', ['-e', 'sh', '-c', 'echo wsl_ok'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (wslCheck !== 'wsl_ok') return;
    const b64Env = Buffer.from(envScript).toString('base64');
    execFileSync('wsl', ['-e', 'sh', '-c', `
      mkdir -p ~/.config/local-router
      echo "${b64Env}" | base64 -d > ~/.config/local-router/env.sh
    `], { stdio: 'ignore' });
  } catch {
    // WSL is optional; the Windows files remain the source of truth.
  }
}

function ensureRcSource(homeDir: string): void {
  for (const rcName of ['.bashrc', '.zshrc', '.profile']) {
    const rcPath = path.join(homeDir, rcName);
    if (!fs.existsSync(rcPath)) continue;
    const existing = fs.readFileSync(rcPath, 'utf8');
    if (existing.includes('local-router/env.sh')) continue;
    fs.appendFileSync(
      rcPath,
      '\n# Local Router environment variables\n[ -f "$HOME/.config/local-router/env.sh" ] && source "$HOME/.config/local-router/env.sh"\n'
    );
  }
}

export function syncSystemAgentEnv(opts?: {
  homeDir?: string;
  baseUrl?: string;
  skipOsEnvironment?: boolean;
}): AgentEnvSyncResult {
  const isWin = process.platform === 'win32';
  const homeDir = opts?.homeDir || os.homedir();
  const configDir = path.join(homeDir, '.config', 'local-router');
  const envScriptPath = path.join(configDir, 'env.sh');
  const vars = agentHarnessEnv(opts?.baseUrl);
  const skipOsEnvironment = opts?.skipOsEnvironment === true || process.env.LOCAL_ROUTER_SKIP_OS_ENV === '1';

  try {
    fs.mkdirSync(configDir, { recursive: true });
    const existing = fs.existsSync(envScriptPath) ? fs.readFileSync(envScriptPath, 'utf8') : '';
    const next = upsertShellExports(existing, vars);
    if (next !== existing) {
      fs.writeFileSync(envScriptPath, next, { encoding: 'utf8', mode: 0o600 });
    } else {
      fs.chmodSync(envScriptPath, 0o600);
    }

    if (isWin) {
      if (!skipOsEnvironment) {
        try {
          writeWindowsUserEnv(vars);
        } catch {
          // Non-fatal: env.sh (sourced by the shims) still applies for CLI runs.
        }
        syncIntoWsl(next);
      }
    } else {
      ensureRcSource(homeDir);
    }

    return {
      ok: true,
      envScriptPath,
      windows: isWin,
      applied: Object.keys(vars)
    };
  } catch (err: any) {
    return {
      ok: false,
      envScriptPath,
      windows: isWin,
      applied: [],
      error: err?.message || String(err)
    };
  }
}
