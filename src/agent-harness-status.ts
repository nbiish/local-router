import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AgentProxyConfig } from './config-persistence';
import { agentHarnessEnv, readShellExport } from './agent-env-sync';
import { readCodexHarnessState, type CodexHarnessState } from './agent-codex-config';

/**
 * Read-only harness readiness + on-demand round-trip verification for the
 * Agents page.
 *
 * Readiness is free: it only inspects PATH, the managed env file, and the
 * Codex config files. Verification is an explicit 1-token request through the
 * real fallback chain, so it proves the wire path for the exact shape each
 * harness speaks (Anthropic Messages / OpenAI Responses).
 */

export type HarnessCliInfo = {
  command: string;
  found: boolean;
  path: string | null;
  searched: string[];
};

export type HarnessEnvInfo = {
  applied: boolean;
  envScriptPath: string;
  expected: Record<string, string>;
  observed: Record<string, string | null>;
};

export type AgentHarnessStatus = {
  generatedAt: string;
  baseUrl: string;
  claude: {
    cli: HarnessCliInfo;
    interception: { enabled: boolean };
    env: HarnessEnvInfo;
    configPath: string;
  };
  codex: {
    cli: HarnessCliInfo;
    interception: { enabled: boolean; model: string };
    env: HarnessEnvInfo;
    config: CodexHarnessState;
    launchCommand: string;
  };
};

export type HarnessVerifyResult = {
  harness: 'claude' | 'codex';
  ok: boolean;
  status: number | null;
  latencyMs: number;
  requestedModel: string;
  checkedAt: string;
  detail: string;
  error?: string;
};

const WINDOWS_DEFAULT_EXTS = ['.com', '.exe', '.bat', '.cmd', ''];

function windowsPathExts(): string[] {
  const raw = process.env.PATHEXT || '';
  const exts = raw
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  return exts.length > 0 ? [...exts, ''] : WINDOWS_DEFAULT_EXTS;
}

function repoBinDir(): string {
  // build/agent-harness-status.js → repo root → bin
  return path.resolve(__dirname, '..', 'bin');
}

export function harnessSearchDirs(opts?: { command?: string; extraDirs?: string[] }): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  const push = (dir: string | undefined | null) => {
    if (!dir) return;
    const resolved = path.resolve(dir);
    if (seen.has(resolved.toLowerCase())) return;
    seen.add(resolved.toLowerCase());
    dirs.push(resolved);
  };

  const ownBin = repoBinDir();
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    // Resolving our own bin would recurse through the shim we ship.
    if (path.resolve(dir).toLowerCase() === ownBin.toLowerCase()) continue;
    push(dir);
  }

  // Installer locations that are not always on PATH for non-login shells.
  const home = os.homedir();
  push(path.join(home, '.local', 'bin'));
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) {
      push(path.join(process.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin'));
      push(path.join(process.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'current', 'bin'));
    }
  }
  if ((opts?.command || '') === 'codex') {
    push(path.join(home, '.codex', 'bin'));
  }
  for (const extra of opts?.extraDirs || []) push(extra);
  return dirs;
}

export function findHarnessCli(command: string, opts?: { extraDirs?: string[] }): HarnessCliInfo {
  const dirs = harnessSearchDirs({ command, extraDirs: opts?.extraDirs });
  const isWin = process.platform === 'win32';
  const extensions = isWin ? windowsPathExts() : [''];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${command}${ext}`);
      try {
        if (fs.existsSync(candidate) && !fs.statSync(candidate).isDirectory()) {
          return { command, found: true, path: candidate, searched: dirs };
        }
      } catch {
        // Unreadable PATH entry — keep looking.
      }
    }
  }

  return { command, found: false, path: null, searched: dirs };
}

function envInfo(homeDir: string | undefined, baseUrl: string): HarnessEnvInfo {
  const configDir = path.join(homeDir || os.homedir(), '.config', 'local-router');
  const envScriptPath = path.join(configDir, 'env.sh');
  const expected = agentHarnessEnv(baseUrl);
  const content = (() => {
    try {
      return fs.existsSync(envScriptPath) ? fs.readFileSync(envScriptPath, 'utf8') : '';
    } catch {
      return '';
    }
  })();
  const observed: Record<string, string | null> = {};
  for (const key of Object.keys(expected)) {
    observed[key] = readShellExport(content, key);
  }
  return {
    applied: Object.entries(expected).every(([key, value]) => observed[key] === value),
    envScriptPath,
    expected,
    observed
  };
}

export function collectAgentHarnessStatus(
  config: AgentProxyConfig,
  opts?: { homeDir?: string; baseUrl?: string; cli?: { claude?: HarnessCliInfo; codex?: HarnessCliInfo } }
): AgentHarnessStatus {
  const homeDir = opts?.homeDir || os.homedir();
  const baseUrl = (opts?.baseUrl || `http://127.0.0.1:${process.env.PORT || '11434'}`).replace(/\/+$/, '');
  const env = envInfo(homeDir, baseUrl);
  const codexHome = opts?.homeDir && !process.env.CODEX_HOME
    ? path.join(opts.homeDir, '.codex')
    : undefined;

  return {
    generatedAt: new Date().toISOString(),
    baseUrl,
    claude: {
      cli: opts?.cli?.claude || findHarnessCli('claude'),
      interception: { enabled: Boolean(config.claudeCode?.enabled) },
      env,
      configPath: path.join(homeDir, '.config', 'local-router', 'agent-proxy-config.json')
    },
    codex: {
      cli: opts?.cli?.codex || findHarnessCli('codex'),
      interception: {
        enabled: Boolean(config.codex?.enabled),
        model: String(config.codex?.model || '')
      },
      env,
      config: readCodexHarnessState({ codexHome }),
      launchCommand: 'codex --profile local-router'
    }
  };
}

function sanitizeBody(text: string, limit = 400): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function verifyModelFor(harness: 'claude' | 'codex', config: AgentProxyConfig): string {
  if (harness === 'codex') {
    const model = String(config.codex?.model || '').trim();
    return model || 'local-router/fallback-models';
  }
  // With interception off there is no slot to exercise, so probe the loopback
  // shim itself rather than passing an Anthropic id to a provider that has no
  // Anthropic credentials.
  if (!config.claudeCode?.enabled) return 'local-router/fallback-models';
  // Claude Code always sends an Anthropic model id; the Haiku slot is the
  // cheapest slot to exercise and is the one agent harnesses use for triage.
  return 'claude-3-5-haiku-20241022';
}

export async function verifyAgentHarness(
  harness: 'claude' | 'codex',
  config: AgentProxyConfig,
  opts?: { baseUrl?: string; timeoutMs?: number }
): Promise<HarnessVerifyResult> {
  const baseUrl = (opts?.baseUrl || `http://127.0.0.1:${process.env.PORT || '11434'}`).replace(/\/+$/, '');
  const timeoutMs = Math.max(2000, Math.min(opts?.timeoutMs ?? 60_000, 120_000));
  const requestedModel = verifyModelFor(harness, config);
  const startedAt = Date.now();
  const checkedAt = new Date().toISOString();

  const request = harness === 'claude'
    ? {
        path: '/v1/messages',
        headers: { 'x-local-router-client': 'claude' },
        body: {
          model: requestedModel,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'Reply with OK.' }]
        }
      }
    : {
        path: '/v1/responses',
        headers: { 'x-local-router-client': 'codex' },
        body: {
          model: requestedModel,
          input: 'Reply with OK.',
          max_output_tokens: 16,
          stream: false
        }
      };

  try {
    const response = await fetch(`${baseUrl}${request.path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...request.headers },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const latencyMs = Date.now() - startedAt;
    const text = await response.text().catch(() => '');
    let payload: any = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      return {
        harness,
        ok: false,
        status: response.status,
        latencyMs,
        requestedModel,
        checkedAt,
        detail: `${request.path} returned HTTP ${response.status}`,
        error: sanitizeBody(text || 'empty response')
      };
    }

    const shapeOk = harness === 'claude'
      ? Boolean(payload && payload.type === 'message' && Array.isArray(payload.content))
      : Boolean(payload && payload.object === 'response' && Array.isArray(payload.output));

    return {
      harness,
      ok: shapeOk,
      status: response.status,
      latencyMs,
      requestedModel,
      checkedAt,
      detail: shapeOk
        ? `${harness === 'claude' ? 'Anthropic Messages' : 'OpenAI Responses'} round-trip OK in ${latencyMs} ms (model ${requestedModel})`
        : `${request.path} answered 200 but the ${harness === 'claude' ? 'message' : 'response'} envelope was not recognised`,
      ...(shapeOk ? {} : { error: sanitizeBody(text || 'empty response') })
    };
  } catch (error: any) {
    return {
      harness,
      ok: false,
      status: null,
      latencyMs: Date.now() - startedAt,
      requestedModel,
      checkedAt,
      detail: `${request.path} probe failed`,
      error: error?.name === 'TimeoutError'
        ? `No answer within ${timeoutMs} ms — the fallback chain may be slow or down.`
        : error?.message || String(error)
    };
  }
}
