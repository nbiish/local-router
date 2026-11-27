/**
 * bridge-tunnel.ts — Packaged Cloudflared + PQC Remote Bridge controller.
 *
 * Packages Cloudflare Tunnel (`cloudflared`) lifecycle directly inside
 * `local-router` so users never hand-wire tunnel daemons, while enforcing:
 *   1. Fail-closed bridge authentication (requires an active bridge key from
 *      `env` / `pqc-vault` / built-in `machine-pqc`).
 *   2. Per-machine hardware + app PQC hash (`machineIdHash` + `appMachineHash`)
 *      and signed ML-DSA-65 tier entitlement checks (free tier cannot bypass
 *      paid remote-bridge caps when paired or `LOCAL_ROUTER_REQUIRE_LEASE=1`).
 *   3. Zero tunnel token in process argv — named tunnel tokens are persisted
 *      with mode `0600` and passed exclusively via `--token-file`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { machineConfigPath } from './config-paths';
import {
  getConfiguredAccessKeyFingerprint,
  getConfiguredAccessKeySource,
  noteMachineAccessKey
} from './inbound-auth';
import {
  computeAppMachineHash,
  deriveMachineBridgeAccessKey,
  ensureDevicePqcIdentity,
  evaluateAccountLeaseStatus,
  getHardwareMachineIdHash
} from './pqc-entitlement';

export type BridgeTunnelMode = 'named-token' | 'quick' | 'external' | 'stopped';

export interface CloudflaredBinaryInfo {
  installed: boolean;
  path: string | null;
  version: string | null;
  installHint: string;
}

export interface BridgeGateDecision {
  allowed: boolean;
  reason: string | null;
  tier: string;
  paired: boolean;
  requireLease: boolean;
  machineIdHash: string;
  appMachineHash: string;
  bridgeKeySource: string;
}

export interface BridgeTunnelStatus {
  cloudflaredInstalled: boolean;
  cloudflaredPath: string | null;
  cloudflaredVersion: string | null;
  installHint: string;
  running: boolean;
  managedByRouter: boolean;
  mode: BridgeTunnelMode;
  pid: number | null;
  publicUrl: string | null;
  startedAt: string | null;
  lastError: string | null;
  tokenFileConfigured: boolean;
  tokenFilePath: string;
  externalServiceActive: boolean;
  deviceId: string;
  machineIdHash: string;
  appMachineHash: string;
  bridgeKeySource: string;
  bridgeKeyFingerprint: string | null;
  tier: string;
  paired: boolean;
  bridgeAllowed: boolean;
  blockedReason: string | null;
}

interface ManagedTunnelState {
  child: ChildProcess | null;
  mode: BridgeTunnelMode;
  pid: number | null;
  publicUrl: string | null;
  startedAt: string | null;
  lastError: string | null;
}

const state: ManagedTunnelState = {
  child: null,
  mode: 'stopped',
  pid: null,
  publicUrl: null,
  startedAt: null,
  lastError: null
};

let exitHookRegistered = false;

function installHintForPlatform(): string {
  if (process.platform === 'darwin') return 'brew install cloudflared';
  if (process.platform === 'win32') return 'winget install --id Cloudflare.cloudflared -e';
  return 'Install cloudflared from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';
}

export function bridgeTokenPath(): string {
  return machineConfigPath('cloudflared-bridge.token');
}

export function hasSavedBridgeToken(): boolean {
  const filePath = bridgeTokenPath();
  try {
    if (!fs.existsSync(filePath)) return false;
    return fs.readFileSync(filePath, 'utf8').trim().length >= 20;
  } catch {
    return false;
  }
}

/** Validate and save a Cloudflare Tunnel token to a `0600` file (never logged or echoed). */
export function saveBridgeTunnelToken(rawToken: string): { saved: true; tokenFilePath: string } {
  const token = String(rawToken || '').trim();
  if (token.length < 20 || token.length > 4096 || /\s/.test(token)) {
    throw new Error('invalid Cloudflare Tunnel token (expected a single token string without whitespace)');
  }
  const filePath = bridgeTokenPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${token}\n`, { mode: 0o600 });
  return { saved: true, tokenFilePath: filePath };
}

export function clearBridgeTunnelToken(): boolean {
  const filePath = bridgeTokenPath();
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

/** Locate `cloudflared` across macOS, Windows, and Linux/WSL. */
export function detectCloudflared(): CloudflaredBinaryInfo {
  const installHint = installHintForPlatform();
  const home = os.homedir();
  const candidates: string[] = [];
  if (process.env.LOCAL_ROUTER_CLOUDFLARED_BIN) {
    candidates.push(process.env.LOCAL_ROUTER_CLOUDFLARED_BIN.trim());
  }
  if (process.platform === 'darwin') {
    candidates.push('/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', 'cloudflared');
  } else if (process.platform === 'win32') {
    candidates.push(
      'cloudflared.exe',
      'cloudflared',
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'cloudflared', 'cloudflared.exe'),
      path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'cloudflared', 'cloudflared.exe')
    );
  } else {
    candidates.push(
      path.join(home, '.local', 'bin', 'cloudflared'),
      '/usr/local/bin/cloudflared',
      '/usr/bin/cloudflared',
      'cloudflared'
    );
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    const isAbsolute = path.isAbsolute(candidate);
    if (isAbsolute && !fs.existsSync(candidate)) continue;
    try {
      const r = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 2000 });
      if (r.status === 0) {
        const line = `${r.stdout || ''}\n${r.stderr || ''}`.trim().split(/\r?\n/)[0] || 'cloudflared';
        return { installed: true, path: candidate, version: line.trim(), installHint };
      }
    } catch {
      // Try next candidate
    }
  }
  return { installed: false, path: null, version: null, installHint };
}

/** Detect an externally managed systemd user cloudflared service (e.g. Linux/WSL). */
function detectExternalCloudflaredService(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const r = spawnSync('systemctl', ['--user', 'list-units', '--type=service', '--state=running', '--no-legend'], {
      encoding: 'utf8',
      timeout: 1500
    });
    if (r.status !== 0) return false;
    return /cloudflared/i.test(String(r.stdout || ''));
  } catch {
    return false;
  }
}

/**
 * Deterministic policy gate before starting a remote Cloudflared bridge.
 * Fails closed when no bridge key is active or when a paired/required PQC lease
 * is invalid, cloned from another machine, or on the free tier.
 */
export function canStartRemoteBridge(): BridgeGateDecision {
  const identity = ensureDevicePqcIdentity();
  const machineIdHash = getHardwareMachineIdHash();
  const appMachineHash = computeAppMachineHash({
    appId: 'local-router',
    machineIdHash,
    devicePubHash: identity.devicePubHash
  });

  if (getConfiguredAccessKeySource() === 'none' && process.env.LOCAL_ROUTER_SKIP_PQC_LOAD !== 'true') {
    const derived = deriveMachineBridgeAccessKey(identity);
    noteMachineAccessKey(derived.accessKey);
  }
  const bridgeKeySource = getConfiguredAccessKeySource();
  const lease = evaluateAccountLeaseStatus();

  if (bridgeKeySource === 'none') {
    return {
      allowed: false,
      reason: 'bridge_access_key_not_configured',
      tier: lease.tier,
      paired: lease.paired,
      requireLease: lease.requireLease,
      machineIdHash,
      appMachineHash,
      bridgeKeySource
    };
  }

  if (lease.paired || lease.requireLease) {
    if (!lease.valid) {
      return {
        allowed: false,
        reason: lease.reason || 'invalid_pqc_lease',
        tier: lease.tier,
        paired: lease.paired,
        requireLease: lease.requireLease,
        machineIdHash,
        appMachineHash,
        bridgeKeySource
      };
    }
    if (!lease.remoteBridgeEntitled) {
      return {
        allowed: false,
        reason: 'tier_upgrade_required',
        tier: lease.tier,
        paired: lease.paired,
        requireLease: lease.requireLease,
        machineIdHash,
        appMachineHash,
        bridgeKeySource
      };
    }
  }

  return {
    allowed: true,
    reason: null,
    tier: lease.tier,
    paired: lease.paired,
    requireLease: lease.requireLease,
    machineIdHash,
    appMachineHash,
    bridgeKeySource
  };
}

export function getBridgeTunnelStatus(): BridgeTunnelStatus {
  const bin = detectCloudflared();
  const identity = ensureDevicePqcIdentity();
  const gate = canStartRemoteBridge();
  const tokenFileConfigured = hasSavedBridgeToken();
  const managedRunning = Boolean(state.child && state.child.exitCode === null && !state.child.killed);
  const externalServiceActive = !managedRunning && detectExternalCloudflaredService();
  const mode: BridgeTunnelMode = managedRunning
    ? state.mode
    : externalServiceActive
      ? 'external'
      : 'stopped';

  return {
    cloudflaredInstalled: bin.installed,
    cloudflaredPath: bin.path,
    cloudflaredVersion: bin.version,
    installHint: bin.installHint,
    running: managedRunning || externalServiceActive,
    managedByRouter: managedRunning,
    mode,
    pid: managedRunning ? state.pid : null,
    publicUrl: managedRunning ? state.publicUrl : null,
    startedAt: managedRunning ? state.startedAt : null,
    lastError: state.lastError,
    tokenFileConfigured,
    tokenFilePath: bridgeTokenPath(),
    externalServiceActive,
    deviceId: identity.deviceId,
    machineIdHash: gate.machineIdHash,
    appMachineHash: gate.appMachineHash,
    bridgeKeySource: gate.bridgeKeySource,
    bridgeKeyFingerprint: getConfiguredAccessKeyFingerprint(),
    tier: gate.tier,
    paired: gate.paired,
    bridgeAllowed: gate.allowed,
    blockedReason: gate.reason
  };
}

export async function startBridgeTunnel(options: {
  port?: number;
  mode?: 'named-token' | 'quick';
  tokenFile?: string;
} = {}): Promise<BridgeTunnelStatus> {
  const gate = canStartRemoteBridge();
  if (!gate.allowed) {
    const err = new Error(
      gate.reason === 'tier_upgrade_required'
        ? 'Remote Cloudflared bridge requires a Pro or Business tier lease (upgrade at https://local-router.com/pricing).'
        : `Remote bridge refused by PQC gate (${gate.reason}).`
    ) as Error & { code?: string; status?: number };
    err.code = gate.reason || 'bridge_blocked';
    err.status = gate.reason === 'tier_upgrade_required' ? 402 : 403;
    throw err;
  }

  if (state.child && state.child.exitCode === null && !state.child.killed) {
    return getBridgeTunnelStatus();
  }

  const bin = detectCloudflared();
  if (!bin.installed || !bin.path) {
    const err = new Error(`cloudflared is not installed on this host. Install via: ${bin.installHint}`) as Error & { code?: string; status?: number };
    err.code = 'cloudflared_not_installed';
    err.status = 400;
    throw err;
  }

  const tokenFile = options.tokenFile || bridgeTokenPath();
  const desiredMode: 'named-token' | 'quick' = options.mode
    || (fs.existsSync(tokenFile) ? 'named-token' : 'quick');
  const port = Number.isInteger(options.port) && (options.port as number) > 0 ? (options.port as number) : 11434;

  let args: string[];
  if (desiredMode === 'named-token') {
    if (!fs.existsSync(tokenFile)) {
      const err = new Error('No tunnel token configured. Run `localrouter bridge set-token --token-stdin` or save one in /config/agents.') as Error & { code?: string; status?: number };
      err.code = 'bridge_token_missing';
      err.status = 400;
      throw err;
    }
    // Token is NEVER placed in argv; cloudflared reads it from the 0600 file.
    args = ['tunnel', 'run', '--protocol', 'http2', '--token-file', tokenFile];
  } else {
    args = ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${port}`];
  }

  const child = spawn(bin.path, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  state.child = child;
  state.mode = desiredMode;
  state.pid = child.pid ?? null;
  state.publicUrl = null;
  state.startedAt = new Date().toISOString();
  state.lastError = null;

  const parseQuickUrl = (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (match) state.publicUrl = match[0];
  };
  child.stdout?.on('data', parseQuickUrl);
  child.stderr?.on('data', parseQuickUrl);
  child.on('error', (err) => {
    state.lastError = err.message;
  });
  child.on('exit', (code, signal) => {
    if (state.child === child) {
      if (code && code !== 0 && !signal) {
        state.lastError = `cloudflared exited with code ${code}`;
      }
      state.child = null;
      state.pid = null;
      state.mode = 'stopped';
    }
  });

  if (!exitHookRegistered) {
    exitHookRegistered = true;
    process.once('exit', () => {
      try { state.child?.kill(); } catch { /* ignore */ }
    });
  }

  // Wait briefly for early crash or quick-tunnel URL emission (max 1.5s)
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 1200);
    const check = setInterval(() => {
      if (state.publicUrl || !state.child || state.child.exitCode !== null) {
        clearTimeout(timer);
        clearInterval(check);
        resolve();
      }
    }, 100);
    child.once('exit', () => {
      clearTimeout(timer);
      clearInterval(check);
      resolve();
    });
  });

  return getBridgeTunnelStatus();
}

export function stopBridgeTunnel(): { stopped: boolean; pid: number | null } {
  const child = state.child;
  if (!child || child.exitCode !== null || child.killed) {
    state.child = null;
    state.pid = null;
    state.mode = 'stopped';
    state.publicUrl = null;
    return { stopped: false, pid: null };
  }
  const pid = state.pid;
  try {
    child.kill('SIGTERM');
  } catch {
    try { child.kill(); } catch { /* ignore */ }
  }
  state.child = null;
  state.pid = null;
  state.mode = 'stopped';
  state.publicUrl = null;
  return { stopped: true, pid };
}
