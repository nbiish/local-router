#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const IS_WIN = process.platform === 'win32';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 11434;
const CONFIG_DIR = path.join(os.homedir(), '.config', 'local-router');
const LEGACY_CONFIG_DIR = path.join(os.homedir(), '.config', 'fvs-code');
const STATE_PATH = path.join(CONFIG_DIR, 'proxy-state.json');
const LEGACY_STATE_PATH = path.join(LEGACY_CONFIG_DIR, 'proxy-state.json');
const ROUTING_STATE_PATH = path.join(CONFIG_DIR, 'tool-routing.json');
const LEGACY_ROUTING_STATE_PATH = path.join(LEGACY_CONFIG_DIR, 'tool-routing.json');
const SHIM_DIR = path.join(os.homedir(), '.local', 'bin');
const OLLAMA_SHIM_PATH = path.join(SHIM_DIR, 'ollama');
const SHIM_MARKER = '# local-router ollama shim';
const LEGACY_SHIM_MARKER = '# fvs-code ollama shim';
const SERVICE_SHIM_MARKER = '# local-router service shim';
const LLAMA_SERVER_SHIM_PATH = path.join(SHIM_DIR, 'llama-server');
const UNSLOTH_SHIM_PATH = path.join(SHIM_DIR, 'unsloth');

// Drop-in service shims installed by `route set`. Any invocation that starts a
// service first ensures Local Router is running, then hands off to the real
// binary; other invocations pass straight through to the real binary (which
// then talks to Local Router on the standard port when one is running).
// - ollama keeps its dedicated renderer: the SHIM_MARKER line in that file is
//   what src/ollama-backend.ts resolveRealOllamaBinary() looks for when it
//   needs to skip the shim and locate the real ollama install.
// - llama-server (llama.cpp) always serves, so every invocation is treated as
//   a service start; it also self-registers the `llama-cpp` custom provider.
// - unsloth: only `serve`/`server` subcommands are treated as service starts;
//   it self-registers the `unsloth` custom provider.
const SERVICE_TARGETS = [
  {
    command: 'ollama',
    shimPath: OLLAMA_SHIM_PATH
  },
  {
    command: 'llama-server',
    shimPath: LLAMA_SERVER_SHIM_PATH,
    providerSlug: 'llama-cpp',
    keyEnvVar: 'LLAMA_CPP_API_KEY',
    displayName: 'llama.cpp (local llama-server)',
    backendPort: 8080,
    interceptAllArgs: true
  },
  {
    command: 'unsloth',
    shimPath: UNSLOTH_SHIM_PATH,
    providerSlug: 'unsloth',
    keyEnvVar: 'UNSLOTH_API_KEY',
    displayName: 'Unsloth (local)',
    backendPort: 8000,
    serveSubcommands: ['serve', 'server']
  }
];

function usage() {
  console.log([
    'Local Router CLI',
    '',
    'Usage:',
    '  local-router start [--port 11434] [--host 127.0.0.1] [--foreground] [--config <file>]',
    '  local-router stop [--port 11434] [--host 127.0.0.1]',
    '  local-router status [--port 11434] [--host 127.0.0.1]',
    '  local-router route set',
    '  local-router route custom <localhost:port>',
    '  local-router route unset',
    '  local-router route status',
    '  local-router chat [prompt] [--agent <choice>] [--fleet|--no-fleet]',
    '',
    'Behavior:',
    '  - start: launches proxy only when nothing else is listening on the target port.',
    '    --config <file>: apply a declarative routes/curation config at boot (chains are otherwise',
    '    empty by default — author them in /config/fallback, or export them from that page).',
    '    Same as LOCAL_ROUTER_ROUTES_CONFIG=<file>. Template: config/routes.example.json.',
    '  - route set: installs drop-in shims (ollama, llama-server, unsloth) in ~/.local/bin so',
    '    service starts go through Local Router (preferred + provider model catalog).',
    '  - route custom: ollama shim only, but `ollama serve` starts Local Router on a custom localhost port.',
    '  - route unset: removes all Local Router service shims.',
    '',
    'Compatibility:',
    '  - fvs-code remains available as a deprecated CLI alias for this release.',
    ''
  ].join('\n'));
}

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function parseOptions(args) {
  const options = {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    foreground: false,
    config: '',
    args: []
  };
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--port') {
      options.port = Number.parseInt(args[i + 1] || '', 10);
      i += 1;
      continue;
    }
    if (token === '--host') {
      options.host = String(args[i + 1] || '').trim() || DEFAULT_HOST;
      i += 1;
      continue;
    }
    if (token === '--config' || token.startsWith('--config=')) {
      options.config = token === '--config' ? String(args[i + 1] || '').trim() : token.slice('--config='.length).trim();
      if (token === '--config') i += 1;
      if (!options.config) throw new Error('--config requires a file path.');
      continue;
    }
    if (token === '--foreground') {
      options.foreground = true;
      continue;
    }
    if (token === '--json') {
      options.json = true;
      continue;
    }
    if (token === '--ps1' || token === '--pwsh') {
      options.pwsh = true;
      continue;
    }
    if (token === '--cmd') {
      options.cmd = true;
      continue;
    }
    if (!token.startsWith('-')) {
      options.args.push(token);
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error(`Invalid port: ${options.port}`);
  }
  if (options.config) {
    options.config = path.resolve(options.config);
    if (!fs.existsSync(options.config)) {
      throw new Error(`Config file not found: ${options.config}`);
    }
  }
  return options;
}

async function fetchWithTimeout(url, timeoutMs = 1200, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function probeServer(host, port) {
  const baseUrl = `http://${host}:${port}`;
  const providerConfigs = await fetchWithTimeout(`${baseUrl}/api/provider-configs`);
  if (providerConfigs && providerConfigs.ok) {
    return { running: true, kind: 'local-router', baseUrl };
  }

  const version = await fetchWithTimeout(`${baseUrl}/api/version`);
  if (version && version.ok) {
    let payload = '';
    try {
      payload = await version.text();
    } catch {
      payload = '';
    }
    return { running: true, kind: 'ollama-compatible', baseUrl, versionPayload: payload };
  }

  const root = await fetchWithTimeout(`${baseUrl}/`);
  if (root) {
    return { running: true, kind: 'unknown', baseUrl };
  }

  return { running: false, kind: 'none', baseUrl };
}

function resolveServerEntry() {
  const projectRoot = path.resolve(__dirname, '..');
  const buildEntry = path.join(projectRoot, 'build', 'index.js');
  const sourceEntry = path.join(projectRoot, 'src', 'index.ts');

  if (fs.existsSync(buildEntry)) {
    return {
      command: process.execPath,
      args: [buildEntry],
      source: 'build'
    };
  }
  if (fs.existsSync(sourceEntry)) {
    return {
      command: process.execPath,
      args: ['-r', 'ts-node/register', sourceEntry],
      source: 'ts-node'
    };
  }

  throw new Error('Could not find build/index.js or src/index.ts for proxy start.');
}

function readStateFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Find all PIDs with an IPv4/IPv6 socket listening on `port`.
 * Returns an array of unique integer PIDs (may be empty).
 */
function findPidsOnPort(port) {
  if (IS_WIN) {
    // Windows: `netstat -ano` prints proto/local/foreign/state/PID. The local address ends with
    // `:PORT` for listeners on both IPv4 (1.2.3.4:PORT) and IPv6 ([::]:PORT); last column is PID.
    const result = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 3000 });
    if (!result.stdout) return [];
    const suffix = `:${port}`;
    const pids = [];
    for (const line of result.stdout.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 5) continue;
      if (!/^tcp$/i.test(cols[0])) continue;
      if (cols[3] !== 'LISTENING') continue;
      if (!cols[1].endsWith(suffix)) continue;
      const pid = Number.parseInt(cols[cols.length - 1], 10);
      if (Number.isInteger(pid) && pid > 0) pids.push(pid);
    }
    return [...new Set(pids)];
  }
  try {
    const result = spawnSync(
      'lsof',
      ['-i', `:${port}`, '-P', '-n', '-sTCP:LISTEN', '-F', 'p'],
      { encoding: 'utf8', timeout: 3000 }
    );
    if (!result.stdout) return [];
    const pids = [];
    for (const line of result.stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith('p')) {
        const pid = Number.parseInt(trimmed.slice(1), 10);
        if (Number.isInteger(pid) && pid > 0) pids.push(pid);
      }
    }
    return [...new Set(pids)];
  } catch {
    return [];
  }
}

/**
 * Send SIGTERM to a process group (negative pid) so child processes
 * spawned by `tsx watch` or `npm exec` are also terminated.
 * Falls back to killing just the pid if the group kill fails.
 */
function killProcessTree(pid, force) {
  if (IS_WIN) {
    // Windows has no process groups; `taskkill /T` walks the child tree, `/F` force-terminates.
    const args = ['/PID', String(pid), '/T'];
    if (force) args.push('/F');
    spawnSync('taskkill', args, { encoding: 'utf8', timeout: 3000 });
    return;
  }
  const signal = force ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // process already gone
    }
  }
}

function writeStateFile(filePath, value) {
  ensureConfigDir();
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function waitForLocalRouterReady(host, port, attempts = 40, intervalMs = 250) {
  for (let i = 0; i < attempts; i += 1) {
    const state = await probeServer(host, port);
    if (state.running && state.kind === 'local-router') {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function cmdStart(options) {
  const current = await probeServer(options.host, options.port);
  if (current.running) {
    if (current.kind === 'local-router') {
      const pids = findPidsOnPort(options.port);
      const pidStr = pids.length > 0 ? ` (PID: ${pids.join(', ')})` : '';
      console.log(`\n✓ Local Router is already running at ${current.baseUrl}${pidStr}\n`);
      console.log('  Web Dashboard & Management:');
      console.log(`    ► Open Dashboard:   ${current.baseUrl}/config`);
      console.log(`    ► Manage Providers: ${current.baseUrl}/config/providers`);
      console.log(`    ► Fallback Routes:  ${current.baseUrl}/config/fallback`);
      console.log('');
      console.log('  Universal API Endpoints (Ollama & OpenAI Compatible):');
      console.log(`    ► Ollama Tags API:  ${current.baseUrl}/api/tags`);
      console.log(`    ► OpenAI V1 Models: ${current.baseUrl}/v1/models`);
      console.log(`    ► Completions API:  ${current.baseUrl}/v1/chat/completions`);
      console.log('');
      console.log('  CLI Commands:');
      console.log('    ► List Models:      local-router list  (or ollama list)');
      console.log('    ► Stop Server:      local-router stop');
      console.log('    ► View Status:      local-router status');
      console.log('');
      return 0;
    }
    console.error(`Port ${options.port} already in use by ${current.kind}.`);
    console.error('Not starting Local Router to avoid overriding another server.');
    return 1;
  }

  const entry = resolveServerEntry();
  const env = {
    ...process.env,
    PORT: String(options.port)
  };
  if (options.config) {
    env.LOCAL_ROUTER_ROUTES_CONFIG = options.config;
  }

  if (options.foreground) {
    const child = spawn(entry.command, entry.args, {
      cwd: path.resolve(__dirname, '..'),
      env,
      stdio: 'inherit'
    });
    child.on('exit', (code) => process.exit(code ?? 0));
    return 0;
  }

  ensureConfigDir();
  const logPath = path.join(CONFIG_DIR, `proxy-${options.port}.log`);
  const logFd = fs.openSync(logPath, 'a');

  const child = spawn(entry.command, entry.args, {
    cwd: path.resolve(__dirname, '..'),
    env,
    detached: true,
    stdio: ['ignore', logFd, logFd]
  });
  child.unref();

  const started = await waitForLocalRouterReady(options.host, options.port);
  if (!started) {
    try {
      process.kill(child.pid, 'SIGTERM');
    } catch {
      // Best-effort cleanup.
    }
    console.error(`Local Router failed to start on ${options.host}:${options.port}`);
    console.error(`Check logs: ${logPath}`);
    return 1;
  }

  writeStateFile(STATE_PATH, {
    pid: child.pid,
    host: options.host,
    port: options.port,
    startedAt: new Date().toISOString(),
    logPath,
    entrySource: entry.source
  });
  console.log(`Local Router started at http://${options.host}:${options.port}`);
  console.log(`PID: ${child.pid}`);
  console.log(`Log: ${logPath}`);
  return 0;
}

async function cmdStatus(options) {
  const state = await probeServer(options.host, options.port);
  const localState = readStateFile(STATE_PATH) || readStateFile(LEGACY_STATE_PATH);

  if (!state.running) {
    console.log(`No server detected on http://${options.host}:${options.port}`);
  } else {
    console.log(`Server detected on http://${options.host}:${options.port}`);
    console.log(`Type: ${state.kind}`);
  }

  if (localState && localState.port === options.port) {
    console.log(`State file PID: ${localState.pid}`);
    if (localState.logPath) {
      console.log(`Log: ${localState.logPath}`);
    }
  } else {
    console.log('No matching Local Router state file for this port.');
  }

  const route = routeStatusSummary();
  const enabledServices = route.services
    .filter((service) => service.enabled)
    .map((service) => service.command);
  console.log(`Route shims: ${enabledServices.length > 0 ? enabledServices.join(', ') : 'none'}`);
  return 0;
}

async function cmdStop(options) {
  const localState = readStateFile(STATE_PATH) || readStateFile(LEGACY_STATE_PATH);

  // Phase 1: try recorded PID (process group kill to catch tsx/npm trees)
  if (localState && Number.isInteger(localState.pid)) {
    killProcessTree(localState.pid);
  }

  // Phase 2: wait briefly, then fall back to lsof-based port discovery
  for (let i = 0; i < 25; i += 1) {
    const current = await probeServer(options.host, options.port);
    if (!current.running || current.kind !== 'local-router') {
      try { fs.unlinkSync(STATE_PATH); } catch { /* noop */ }
      try { fs.unlinkSync(LEGACY_STATE_PATH); } catch { /* noop */ }
      console.log(`Local Router stopped on ${options.host}:${options.port}`);
      return 0;
    }

    // After 5 failed probes, discover PIDs on the port and force-kill them
    if (i === 5) {
      const pids = findPidsOnPort(options.port);
      for (const pid of pids) {
        killProcessTree(pid);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // Final attempt: discover port PIDs and force-kill their process trees
  const finalPids = findPidsOnPort(options.port);
  for (const pid of finalPids) {
    killProcessTree(pid, true);
  }

  // Brief wait for SIGKILL to take effect
  await new Promise((resolve) => setTimeout(resolve, 500));
  const final = await probeServer(options.host, options.port);
  if (!final.running || final.kind !== 'local-router') {
    try { fs.unlinkSync(STATE_PATH); } catch { /* noop */ }
    try { fs.unlinkSync(LEGACY_STATE_PATH); } catch { /* noop */ }
    console.log(`Local Router stopped on ${options.host}:${options.port}`);
    return 0;
  }

  console.error('Unable to confirm Local Router shutdown. Check running processes.');
  return 1;
}

function bashSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function whichAll(commandName) {
  if (IS_WIN) {
    // Windows: `where` prints each match on its own line (CRLF); exits 1 when nothing matches.
    const result = spawnSync('where', [commandName], { encoding: 'utf8', shell: true });
    const lines = (result.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return Array.from(new Set(lines));
  }
  const result = spawnSync('sh', ['-lc', `which -a ${commandName} 2>/dev/null || true`], { encoding: 'utf8' });
  const lines = (result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return Array.from(new Set(lines));
}

function parseCustomRouteTarget(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) {
    throw new Error('Missing custom route target. Use: local-router route custom localhost:11500');
  }

  const normalized = raw.replace(/^https?:\/\//i, '');
  if (normalized.includes('/')) {
    throw new Error('Custom route must be host:port without path.');
  }

  const separator = normalized.lastIndexOf(':');
  if (separator <= 0 || separator === normalized.length - 1) {
    throw new Error(`Invalid custom route target: ${raw}. Expected localhost:port`);
  }

  const host = normalized.slice(0, separator).trim().toLowerCase();
  const port = Number.parseInt(normalized.slice(separator + 1).trim(), 10);
  if (!['localhost', '127.0.0.1'].includes(host)) {
    throw new Error(`Unsupported host: ${host}. Use localhost or 127.0.0.1 only.`);
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`Invalid custom route port: ${port}. Use a port in 1024-65535.`);
  }
  if (port === DEFAULT_PORT) {
    throw new Error(`Custom route port must not be ${DEFAULT_PORT}; use route set for the default Ollama port.`);
  }

  return { host, port };
}

async function validateCustomRouteTarget(target) {
  const current = await probeServer(target.host, target.port);
  if (current.running && current.kind !== 'local-router') {
    throw new Error(
      `Cannot set custom route ${target.host}:${target.port}; port is already used by ${current.kind}.`
    );
  }
}

function renderOllamaShim(realOllamaPath, routeMode, target) {
  const serveArgs = routeMode === 'custom'
    ? `start --foreground --host ${target.host} --port ${target.port}`
    : 'start --foreground';
  const routerHost = routeMode === 'custom' ? target.host : '127.0.0.1';
  const routerPort = routeMode === 'custom' ? target.port : DEFAULT_PORT;

  // Always-route contract (operator directive, 2026-09-01): ANY ollama.cli
  // invocation from ANY tool must (1) ensure Local Router is up — starting it
  // in the background if not — and (2) talk to the router on the standard
  // port, never to a bare ollama. The real binary serves only as the
  // router's backend (port 11435) when `ollama serve` is requested.
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    SHIM_MARKER,
    `REAL_OLLAMA=${bashSingleQuote(realOllamaPath)}`,
    'LOCAL_ROUTER_BIN="${LOCAL_ROUTER_BIN:-${FVS_CODE_BIN:-local-router}}"',
    `ROUTER_PROBE="http://${routerHost}:${routerPort}/api/version"`,
    '',
    '# Escape hatch: LOCAL_ROUTER_NO_SHIM=1 bypasses the router entirely.',
    'if [[ "${LOCAL_ROUTER_NO_SHIM:-0}" == "1" ]]; then',
    '  exec "$REAL_OLLAMA" "$@"',
    'fi',
    '',
    '# ALWAYS-ROUTE: ensure the router is up before anything else. A stale',
    '# router from another tool start counts — one router per machine.',
    'router_up() { curl -sf -m 2 "$ROUTER_PROBE" >/dev/null 2>&1; }',
    'if ! router_up; then',
    '  # Not running: start the router detached (its own session, survives',
    '  # this shell), then wait briefly for the probe to come up.',
    `  "$LOCAL_ROUTER_BIN" ${serveArgs} >/dev/null 2>&1 &`,
    '  disown || true',
    '  for _ in $(seq 1 20); do',
    '    router_up && break',
    '    sleep 0.5',
    '  done',
    'fi',
    '',
    'if [[ "${1:-}" == "serve" ]]; then',
    '  # `ollama serve` requested: run the REAL ollama as the router\'s backend',
    '  # on 11435 (the router on 11434 proxies to it), keep both alive for the',
    '  # lifetime of this invocation, and exec the router in the foreground.',
    '  if ! curl -sf -m 2 http://127.0.0.1:11435/api/version >/dev/null 2>&1; then',
    '    export OLLAMA_HOST="127.0.0.1:11435"',
    '    "$REAL_OLLAMA" serve >/dev/null 2>&1 &',
    '    OLLAMA_PID=$!',
    '    trap "kill $OLLAMA_PID 2>/dev/null || true" EXIT',
    '  fi',
    '  export LOCAL_ROUTER_PROVIDER_OLLAMA_BASE_URL="http://127.0.0.1:11435/v1"',
    '  export OLLAMA_API_KEY="local-router-ollama"',
    `  exec "$LOCAL_ROUTER_BIN" ${serveArgs}`,
    'fi',
    '',
    '# Non-serve invocations (list, run, pull, ps, ...) talk to the ROUTER on',
    '# the standard port: point the real CLI at it. The router serves the',
    '# Ollama-compatible API, so the real binary behaves as a client of it.',
    'if [[ -n "${OLLAMA_HOST:-}" ]]; then',
    '  : # caller already pinned a host — respect it (they may target a remote)',
    'else',
    `  export OLLAMA_HOST="${routerHost}:${routerPort}"`,
    'fi',
    'exec "$REAL_OLLAMA" "$@"',
    ''
  ].join('\n');
}

function renderWindowsOllamaCmd(realOllamaPath, routeMode, target) {
  const routerHost = routeMode === 'custom' ? target.host : '127.0.0.1';
  const routerPort = routeMode === 'custom' ? target.port : DEFAULT_PORT;
  const serveArgs = routeMode === 'custom'
    ? `start --foreground --host ${target.host} --port ${target.port}`
    : 'start --foreground';

  return [
    '@echo off',
    'setlocal enabledelayedexpansion',
    SHIM_MARKER,
    `set "REAL_OLLAMA=${realOllamaPath}"`,
    'set "LOCAL_ROUTER_BIN=%LOCAL_ROUTER_BIN%"',
    'if "%LOCAL_ROUTER_BIN%"=="" set "LOCAL_ROUTER_BIN=local-router"',
    `set "ROUTER_PROBE=http://${routerHost}:${routerPort}/api/version"`,
    '',
    'rem Escape hatch: LOCAL_ROUTER_NO_SHIM=1 bypasses the router entirely.',
    'if "%LOCAL_ROUTER_NO_SHIM%"=="1" (',
    '  "%REAL_OLLAMA%" %*',
    '  exit /b !ERRORLEVEL!',
    ')',
    '',
    'rem ALWAYS-ROUTE: ensure Local Router is running before anything else.',
    'curl -sf -m 2 "%ROUTER_PROBE%" >nul 2>&1',
    'if errorlevel 1 (',
    `  start /B "" "%LOCAL_ROUTER_BIN%" ${serveArgs} >nul 2>&1`,
    '  for /L %%i in (1,1,20) do (',
    '    curl -sf -m 2 "%ROUTER_PROBE%" >nul 2>&1 && goto router_up',
    '    timeout /t 1 /nobreak >nul 2>&1',
    '  )',
    ')',
    ':router_up',
    '',
    'if /i "%~1"=="serve" (',
    '  curl -sf -m 2 "http://127.0.0.1:11435/api/version" >nul 2>&1',
    '  if errorlevel 1 (',
    '    set "OLLAMA_HOST=127.0.0.1:11435"',
    '    start /B "" "%REAL_OLLAMA%" serve >nul 2>&1',
    '  )',
    '  set "LOCAL_ROUTER_PROVIDER_OLLAMA_BASE_URL=http://127.0.0.1:11435/v1"',
    '  set "OLLAMA_API_KEY=local-router-ollama"',
    `  "%LOCAL_ROUTER_BIN%" ${serveArgs}`,
    '  exit /b !ERRORLEVEL!',
    ')',
    '',
    'if "%OLLAMA_HOST%"=="" (',
    `  set "OLLAMA_HOST=${routerHost}:${routerPort}"`,
    ')',
    '"%REAL_OLLAMA%" %*',
    'exit /b !ERRORLEVEL!',
    ''
  ].join('\r\n');
}

function renderWindowsOllamaPs1(realOllamaPath, routeMode, target) {
  const routerHost = routeMode === 'custom' ? target.host : '127.0.0.1';
  const routerPort = routeMode === 'custom' ? target.port : DEFAULT_PORT;
  const serveArgs = routeMode === 'custom'
    ? `@("start", "--foreground", "--host", "${target.host}", "--port", "${target.port}")`
    : `@("start", "--foreground")`;

  return [
    '# local-router ollama shim',
    `$RealOllama = "${realOllamaPath}"`,
    '$LocalRouterBin = if ($env:LOCAL_ROUTER_BIN) { $env:LOCAL_ROUTER_BIN } else { "local-router" }',
    `$RouterProbe = "http://${routerHost}:${routerPort}/api/version"`,
    '',
    'if ($env:LOCAL_ROUTER_NO_SHIM -eq "1") {',
    '    & $RealOllama @args',
    '    exit $LASTEXITCODE',
    '}',
    '',
    'function Test-RouterUp {',
    '    try {',
    '        $null = Invoke-RestMethod -Uri $RouterProbe -TimeoutSec 2 -ErrorAction Stop',
    '        return $true',
    '    } catch {',
    '        return $false',
    '    }',
    '}',
    '',
    'if (-not (Test-RouterUp)) {',
    `    Start-Process -FilePath $LocalRouterBin -ArgumentList ${serveArgs} -WindowStyle Hidden`,
    '    for ($i = 0; $i -lt 20; $i++) {',
    '        if (Test-RouterUp) { break }',
    '        Start-Sleep -Milliseconds 500',
    '    }',
    '}',
    '',
    'if ($args.Count -gt 0 -and $args[0] -eq "serve") {',
    '    $backendUp = $false',
    '    try {',
    '        $null = Invoke-RestMethod -Uri "http://127.0.0.1:11435/api/version" -TimeoutSec 2 -ErrorAction Stop',
    '        $backendUp = $true',
    '    } catch {}',
    '    if (-not $backendUp) {',
    '        $env:OLLAMA_HOST = "127.0.0.1:11435"',
    '        Start-Process -FilePath $RealOllama -ArgumentList "serve" -WindowStyle Hidden',
    '    }',
    '    $env:LOCAL_ROUTER_PROVIDER_OLLAMA_BASE_URL = "http://127.0.0.1:11435/v1"',
    '    $env:OLLAMA_API_KEY = "local-router-ollama"',
    `    & $LocalRouterBin ${serveArgs}`,
    '    exit $LASTEXITCODE',
    '}',
    '',
    'if (-not $env:OLLAMA_HOST) {',
    `    $env:OLLAMA_HOST = "${routerHost}:${routerPort}"`,
    '}',
    '& $RealOllama @args',
    'exit $LASTEXITCODE',
    ''
  ].join('\r\n');
}

function setupDesktopAndServiceAutostart(routeMode, target) {
  const routerHost = routeMode === 'custom' ? target.host : '127.0.0.1';
  const routerPort = routeMode === 'custom' ? target.port : DEFAULT_PORT;

  if (process.platform === 'darwin') {
    // 1. Configure GUI environment variable so Ollama desktop app (Ollama.app) binds to port 11435
    try {
      spawnSync('launchctl', ['setenv', 'OLLAMA_HOST', '127.0.0.1:11435'], { stdio: 'ignore' });
      console.log('✓ macOS GUI environment: launchctl setenv OLLAMA_HOST 127.0.0.1:11435');
    } catch {}

    // 2. Install LaunchAgent to keep Local Router daemon running in background
    try {
      const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
      fs.mkdirSync(launchAgentsDir, { recursive: true });
      const plistPath = path.join(launchAgentsDir, 'com.localrouter.daemon.plist');
      const plistContent = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '    <key>Label</key>',
        '    <string>com.localrouter.daemon</string>',
        '    <key>ProgramArguments</key>',
        '    <array>',
        `        <string>${process.execPath}</string>`,
        `        <string>${path.join(__dirname, 'local-router.js')}</string>`,
        '        <string>start</string>',
        '        <string>--foreground</string>',
        '    </array>',
        '    <key>RunAtLoad</key>',
        '    <true/>',
        '    <key>KeepAlive</key>',
        '    <dict>',
        '        <key>SuccessfulExit</key>',
        '        <false/>',
        '    </dict>',
        '    <key>StandardOutPath</key>',
        `    <string>${path.join(CONFIG_DIR, 'launchd.log')}</string>`,
        '    <key>StandardErrorPath</key>',
        `    <string>${path.join(CONFIG_DIR, 'launchd.err')}</string>`,
        '</dict>',
        '</plist>'
      ].join('\n');
      fs.writeFileSync(plistPath, plistContent, 'utf8');
      spawnSync('launchctl', ['load', '-w', plistPath], { stdio: 'ignore' });
      console.log(`✓ macOS LaunchAgent installed: ${plistPath}`);
    } catch (err) {
      console.log(`ℹ LaunchAgent registration notice: ${err.message}`);
    }
  } else if (IS_WIN) {
    // 1. Set Windows User environment variable so Windows Ollama desktop app binds to port 11435
    try {
      spawnSync('powershell', ['-NoProfile', '-Command', `[Environment]::SetEnvironmentVariable("OLLAMA_HOST", "127.0.0.1:11435", "User")`], { stdio: 'ignore' });
      console.log('✓ Windows User environment: OLLAMA_HOST=127.0.0.1:11435 registered.');
    } catch {}

    // 2. Install Startup script in Windows Startup folder for silent background boot
    try {
      const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      const startupDir = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
      if (fs.existsSync(startupDir)) {
        const vbsPath = path.join(startupDir, 'LocalRouter.vbs');
        const vbsContent = [
          'Set WshShell = CreateObject("WScript.Shell")',
          'WshShell.Run "cmd /c local-router start", 0, False'
        ].join('\r\n');
        fs.writeFileSync(vbsPath, vbsContent, 'utf8');
        console.log(`✓ Windows Startup launcher installed: ${vbsPath}`);
      }
    } catch (err) {
      console.log(`ℹ Windows Startup script notice: ${err.message}`);
    }
  } else {
    // Linux / WSL
    // 1. Environment.d config for user desktop sessions
    try {
      const envDir = path.join(os.homedir(), '.config', 'environment.d');
      fs.mkdirSync(envDir, { recursive: true });
      fs.writeFileSync(path.join(envDir, 'ollama.conf'), 'OLLAMA_HOST=127.0.0.1:11435\n', 'utf8');
      console.log('✓ Linux user session environment: ~/.config/environment.d/ollama.conf');
    } catch {}

    // 2. Desktop autostart entry
    try {
      const autostartDir = path.join(os.homedir(), '.config', 'autostart');
      fs.mkdirSync(autostartDir, { recursive: true });
      const desktopContent = [
        '[Desktop Entry]',
        'Type=Application',
        'Exec=local-router start',
        'Hidden=false',
        'NoDisplay=true',
        'X-GNOME-Autostart-enabled=true',
        'Name=Local Router',
        'Comment=Local Ollama and OpenAI model router'
      ].join('\n');
      fs.writeFileSync(path.join(autostartDir, 'local-router.desktop'), desktopContent, 'utf8');
      console.log('✓ Linux desktop autostart entry: ~/.config/autostart/local-router.desktop');
    } catch {}
  }
}

function removeDesktopAndServiceAutostart() {
  if (process.platform === 'darwin') {
    try {
      spawnSync('launchctl', ['unsetenv', 'OLLAMA_HOST'], { stdio: 'ignore' });
      const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.localrouter.daemon.plist');
      if (fs.existsSync(plistPath)) {
        spawnSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
        fs.unlinkSync(plistPath);
        console.log(`Removed macOS LaunchAgent: ${plistPath}`);
      }
    } catch {}
  } else if (IS_WIN) {
    try {
      spawnSync('powershell', ['-NoProfile', '-Command', `[Environment]::SetEnvironmentVariable("OLLAMA_HOST", $null, "User")`], { stdio: 'ignore' });
      const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      const vbsPath = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'LocalRouter.vbs');
      if (fs.existsSync(vbsPath)) {
        fs.unlinkSync(vbsPath);
        console.log(`Removed Windows Startup launcher: ${vbsPath}`);
      }
    } catch {}
  } else {
    try {
      const envPath = path.join(os.homedir(), '.config', 'environment.d', 'ollama.conf');
      if (fs.existsSync(envPath)) fs.unlinkSync(envPath);
      const desktopPath = path.join(os.homedir(), '.config', 'autostart', 'local-router.desktop');
      if (fs.existsSync(desktopPath)) fs.unlinkSync(desktopPath);
    } catch {}
  }
}

function shimFileContainsMarker(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(4096);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const head = buffer.subarray(0, bytesRead).toString('utf8');
      return head.includes(SHIM_MARKER) || head.includes(LEGACY_SHIM_MARKER) || head.includes(SERVICE_SHIM_MARKER);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function resolveRealServiceBinary(serviceTarget) {
  const shimPathResolved = path.resolve(serviceTarget.shimPath);
  for (const candidate of whichAll(serviceTarget.command)) {
    const candidateResolved = path.resolve(candidate);
    if (candidateResolved === shimPathResolved) {
      if (shimFileContainsMarker(candidate)) {
        continue; // our own previous shim — look further down PATH
      }
      try {
        const realTarget = fs.realpathSync(candidate);
        if (path.resolve(realTarget) !== shimPathResolved) {
          // A symlink lives at the shim path: the link target survives replacing
          // the symlink with our shim.
          return realTarget;
        }
      } catch {
        // Fall through and keep looking.
      }
      continue;
    }
    if (shimFileContainsMarker(candidate)) {
      continue; // stale Local Router shim elsewhere in PATH
    }
    if (IS_WIN && (candidate.toLowerCase().endsWith('.cmd') || candidate.toLowerCase().endsWith('.ps1'))) {
      if (shimFileContainsMarker(candidate)) continue;
    }
    return candidate;
  }

  // Cross-platform standard binary fallback locations
  if (serviceTarget.command === 'ollama') {
    const fallbacks = process.platform === 'darwin'
      ? ['/Applications/Ollama.app/Contents/Resources/ollama', '/usr/local/bin/ollama']
      : IS_WIN
        ? [
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
            path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Ollama', 'ollama.exe')
          ]
        : ['/usr/local/bin/ollama', '/usr/bin/ollama'];
    for (const fb of fallbacks) {
      if (fb && fs.existsSync(fb) && !shimFileContainsMarker(fb)) {
        return fb;
      }
    }
  }

  return null;
}

function pushProviderRegistration(lines, serviceTarget, routerHost, routerPort) {
  if (!serviceTarget.providerSlug) {
    return;
  }
  const payloadFormat = `{"name":"${serviceTarget.providerSlug}","endpoint":"http://127.0.0.1:%s","keyEnvVar":"${serviceTarget.keyEnvVar}","displayName":"${serviceTarget.displayName}"}`;
  lines.push(
    '# Best-effort: register this backend as a Local Router custom provider',
    '# and refresh its model list once it has had time to boot.',
    `SERVICE_PORT=${serviceTarget.backendPort}`,
    'for ((i=1; i<=$#; i++)); do',
    '  if [[ "${!i}" == "--port" ]]; then',
    '    __next=$((i+1)); SERVICE_PORT="${!__next}"',
    '  elif [[ "${!i}" == --port=* ]]; then',
    '    SERVICE_PORT="${!i#--port=}"',
    '  fi',
    'done',
    '(',
    '  sleep 3',
    `  payload="$(printf ${bashSingleQuote(payloadFormat)} "$SERVICE_PORT")"`,
    `  curl -sf -m 5 -X POST http://${routerHost}:${routerPort}/api/providers -H 'Content-Type: application/json' -d "$payload" >/dev/null 2>&1 \\`,
    `    || curl -sf -m 5 -X PUT http://${routerHost}:${routerPort}/api/providers/${serviceTarget.providerSlug} -H 'Content-Type: application/json' -d "$payload" >/dev/null 2>&1 || true`,
    '  sleep 12',
    `  curl -sf -m 60 -X POST http://${routerHost}:${routerPort}/api/refresh-endpoint-models >/dev/null 2>&1 || true`,
    ') &'
  );
}

function renderServiceShim(serviceTarget, realPath, routeTarget) {
  const host = routeTarget ? routeTarget.host : '127.0.0.1';
  const port = routeTarget ? routeTarget.port : DEFAULT_PORT;
  const startArgs = routeTarget ? `start --host ${host} --port ${port}` : 'start';
  const realVar = `REAL_${serviceTarget.command.toUpperCase().replace(/-/g, '_')}`;

  const lines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    SERVICE_SHIM_MARKER,
    `${realVar}=${bashSingleQuote(realPath)}`,
    'LOCAL_ROUTER_BIN="${LOCAL_ROUTER_BIN:-${FVS_CODE_BIN:-local-router}}"',
    '',
    '# Escape hatch: LOCAL_ROUTER_NO_SHIM=1 runs the real binary directly.',
    'if [[ "${LOCAL_ROUTER_NO_SHIM:-0}" == "1" ]]; then',
    `  exec "$${realVar}" "$@"`,
    'fi',
    ''
  ];

  if (serviceTarget.interceptAllArgs) {
    // llama-server always serves: every invocation is a service start.
    lines.push(
      `"$LOCAL_ROUTER_BIN" ${startArgs} >/dev/null 2>&1 || true`,
      ''
    );
    pushProviderRegistration(lines, serviceTarget, host, port);
    lines.push(
      `exec "$${realVar}" "$@"`,
      ''
    );
    return lines.join('\n');
  }

  const subcommands = (serviceTarget.serveSubcommands || []).join('|');
  lines.push(
    'case "${1:-}" in',
    `  ${subcommands})`,
    `    "$LOCAL_ROUTER_BIN" ${startArgs} >/dev/null 2>&1 || true`
  );
  const registration = [];
  pushProviderRegistration(registration, serviceTarget, host, port);
  for (const line of registration) {
    lines.push(`  ${line}`);
  }
  lines.push(
    '    ;;',
    'esac',
    '',
    `exec "$${realVar}" "$@"`,
    ''
  );
  return lines.join('\n');
}

function installShim(serviceTarget, realPath, routeMode, routeTarget) {
  if (IS_WIN) {
    if (serviceTarget.command === 'ollama') {
      const cmdPath = path.join(SHIM_DIR, 'ollama.cmd');
      const ps1Path = path.join(SHIM_DIR, 'ollama.ps1');
      const cmdScript = renderWindowsOllamaCmd(realPath, routeMode, routeTarget);
      const ps1Script = renderWindowsOllamaPs1(realPath, routeMode, routeTarget);
      fs.writeFileSync(cmdPath, cmdScript, 'utf8');
      fs.writeFileSync(ps1Path, ps1Script, 'utf8');
      const binDir = path.resolve(__dirname, '..', 'bin');
      try {
        fs.writeFileSync(path.join(binDir, 'ollama.cmd'), cmdScript, 'utf8');
      } catch {}
      return true;
    }
    return false;
  }
  if (fs.existsSync(serviceTarget.shimPath)) {
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(serviceTarget.shimPath).isSymbolicLink();
    } catch {
      // Fall through to the marker check.
    }
    const replaceable = isSymlink || shimFileContainsMarker(serviceTarget.shimPath);
    if (!replaceable) {
      console.error(`Refusing to overwrite existing non-Local Router file at ${serviceTarget.shimPath}.`);
      return false;
    }
    if (isSymlink) {
      console.log(`Replacing symlink at ${serviceTarget.shimPath} with the Local Router shim (real binary stays at ${realPath}).`);
    }
    fs.unlinkSync(serviceTarget.shimPath);
  }
  const shimScript = serviceTarget.command === 'ollama'
    ? renderOllamaShim(realPath, routeMode, routeTarget)
    : renderServiceShim(serviceTarget, realPath, routeTarget);
  fs.writeFileSync(serviceTarget.shimPath, shimScript, 'utf8');
  fs.chmodSync(serviceTarget.shimPath, 0o755);
  return true;
}

function routeStatusSummary() {
  const routingState = readStateFile(ROUTING_STATE_PATH) || readStateFile(LEGACY_ROUTING_STATE_PATH) || {};
  const activeOllamaPath = whichAll('ollama')[0] || '';
  const services = SERVICE_TARGETS.map((serviceTarget) => ({
    command: serviceTarget.command,
    shimPath: IS_WIN && serviceTarget.command === 'ollama' ? path.join(SHIM_DIR, 'ollama.cmd') : serviceTarget.shimPath,
    enabled: fs.existsSync(serviceTarget.shimPath) && shimFileContainsMarker(serviceTarget.shimPath)
      || (IS_WIN && fs.existsSync(path.join(SHIM_DIR, 'ollama.cmd')) && shimFileContainsMarker(path.join(SHIM_DIR, 'ollama.cmd'))),
    realPath: null
  }));
  const recorded = Array.isArray(routingState.services) ? routingState.services : [];
  for (const entry of recorded) {
    const service = services.find((item) => item.command === entry.command);
    if (service && entry.realPath) {
      service.realPath = entry.realPath;
    }
  }
  const ollamaService = services.find((service) => service.command === 'ollama') || {};

  return {
    enabled: Boolean(ollamaService.enabled),
    services,
    shimPath: IS_WIN ? path.join(SHIM_DIR, 'ollama.cmd') : OLLAMA_SHIM_PATH,
    activeOllamaPath: activeOllamaPath || null,
    realOllamaPath: ollamaService.realPath || routingState.realOllamaPath || null,
    mode: routingState.mode || (ollamaService.enabled ? 'ollama' : 'none'),
    targetHost: routingState.targetHost || null,
    targetPort: routingState.targetPort || null
  };
}

function cmdRouteStatus() {
  const summary = routeStatusSummary();
  console.log(`Route mode: ${summary.mode}`);
  for (const service of summary.services) {
    console.log(`${service.command} shim: ${service.enabled ? 'enabled' : 'not installed'}`);
    if (service.enabled) {
      console.log(`  Shim path: ${service.shimPath}`);
      if (service.realPath) {
        console.log(`  Real ${service.command}: ${service.realPath}`);
      }
    }
  }
  console.log(`ollama path: ${summary.activeOllamaPath || 'not found'}`);
  if (summary.mode === 'custom' && summary.targetHost && summary.targetPort) {
    console.log(`Custom target: ${summary.targetHost}:${summary.targetPort}`);
  }
  if (summary.enabled && summary.activeOllamaPath !== summary.shimPath) {
    console.log(`Warning: ollama shim exists but is not first in PATH. Place ${SHIM_DIR} earlier in PATH.`);
  }
  return 0;
}

async function cmdRouteSet(routeMode = 'services', customTarget = null) {
  let routeTarget = null;
  if (routeMode === 'custom') {
    routeTarget = parseCustomRouteTarget(customTarget);
    await validateCustomRouteTarget(routeTarget);
  }

  fs.mkdirSync(SHIM_DIR, { recursive: true });

  const installed = [];
  let sawError = false;

  for (const serviceTarget of SERVICE_TARGETS) {
    if (IS_WIN && serviceTarget.command !== 'ollama') {
      continue;
    }
    const realPath = resolveRealServiceBinary(serviceTarget);
    if (!realPath) {
      if (serviceTarget.command === 'ollama') {
        console.error('Could not locate the real ollama binary. Install Ollama first.');
        sawError = true;
      } else {
        console.log(`Note: ${serviceTarget.command} not found in PATH — skipping its shim. Re-run \`local-router route set\` after installing it.`);
      }
      continue;
    }

    if (!installShim(serviceTarget, realPath, routeMode, routeTarget)) {
      sawError = true;
      continue;
    }

    const effectiveShimPath = IS_WIN && serviceTarget.command === 'ollama' ? path.join(SHIM_DIR, 'ollama.cmd') : serviceTarget.shimPath;
    installed.push({ command: serviceTarget.command, shimPath: effectiveShimPath, realPath });
    console.log(`Installed ${serviceTarget.command} service shim: ${effectiveShimPath}`);
    console.log(`  Real ${serviceTarget.command}: ${realPath}`);
    if (serviceTarget.providerSlug) {
      console.log(`  Registers custom provider "${serviceTarget.providerSlug}" when the service starts.`);
    }
  }

  // Configure desktop application and daemon/service autostart
  setupDesktopAndServiceAutostart(routeMode, routeTarget);

  writeStateFile(ROUTING_STATE_PATH, {
    enabled: installed.length > 0,
    mode: routeMode,
    shimPath: IS_WIN ? path.join(SHIM_DIR, 'ollama.cmd') : OLLAMA_SHIM_PATH,
    realOllamaPath: (installed.find((entry) => entry.command === 'ollama') || {}).realPath || null,
    services: installed,
    targetHost: routeTarget?.host || null,
    targetPort: routeTarget?.port || null,
    updatedAt: new Date().toISOString()
  });

  if (routeTarget) {
    console.log(`Custom route target: ${routeTarget.host}:${routeTarget.port}`);
  }
  if (installed.length > 0) {
    console.log('Service starts (ollama serve, llama-server, unsloth serve) now go through Local Router.');
    console.log('Other invocations pass through to the real binary and talk to Local Router on its port.');
    console.log('Set LOCAL_ROUTER_NO_SHIM=1 to bypass a shim and use the real binary directly.');
  }
  console.log(`Ensure ${SHIM_DIR} is before other paths in PATH for this to take effect.`);
  return sawError ? 1 : 0;
}

function cmdRouteUnset() {
  let refused = false;
  let removedAny = false;
  for (const serviceTarget of SERVICE_TARGETS) {
    const checkPaths = [serviceTarget.shimPath];
    if (serviceTarget.command === 'ollama') {
      checkPaths.push(path.join(SHIM_DIR, 'ollama.cmd'), path.join(SHIM_DIR, 'ollama.ps1'));
    }
    for (const p of checkPaths) {
      if (!fs.existsSync(p)) {
        continue;
      }
      if (!shimFileContainsMarker(p)) {
        console.error(`Refusing to remove non-Local Router file at ${p}`);
        refused = true;
        continue;
      }
      fs.unlinkSync(p);
      console.log(`Removed ${serviceTarget.command} service shim: ${p}`);
      removedAny = true;
    }
  }

  removeDesktopAndServiceAutostart();

  const routingState = readStateFile(ROUTING_STATE_PATH) || {};
  writeStateFile(ROUTING_STATE_PATH, {
    ...routingState,
    enabled: false,
    mode: 'none',
    services: [],
    targetHost: null,
    targetPort: null,
    updatedAt: new Date().toISOString()
  });

  if (!removedAny) {
    console.log('No Local Router service shims found.');
  }
  return refused ? 1 : 0;
}

async function cmdList(options) {
  const current = await probeServer(options.host, options.port);
  if (!current.running) {
    console.error(`Local Router is not running on http://${options.host}:${options.port}. Start it with 'local-router start'.`);
    return 1;
  }
  const res = await fetchWithTimeout(`${current.baseUrl}/api/tags`);
  if (!res || !res.ok) {
    console.error(`Failed to fetch model tags from ${current.baseUrl}`);
    return 1;
  }
  const data = await res.json().catch(() => ({}));
  const models = Array.isArray(data.models) ? data.models : [];
  if (models.length === 0) {
    console.log('No models currently configured. Open http://127.0.0.1:11434/config/providers to toggle on models.');
    return 0;
  }
  console.log(`NAME					ID			SIZE	MODIFIED`);
  for (const m of models) {
    const name = m.name || m.model || '';
    const id = (m.digest || m.id || name).slice(0, 12);
    const size = m.size ? `${(m.size / (1024 * 1024)).toFixed(1)} MB` : 'N/A';
    const mod = m.modified_at ? new Date(m.modified_at).toLocaleDateString() : 'N/A';
    console.log(`${name.padEnd(40)}	${id}	${size}	${mod}`);
  }
  return 0;
}


async function cmdShow(modelName, options) {
  if (!modelName) {
    console.error("Model name is required (e.g. local-router show <model> or ollama show <model>).");
    return 1;
  }
  const current = await probeServer(options.host, options.port);
  if (!current.running) {
    console.error(`Local Router is not running on http://${options.host}:${options.port}. Start it with 'local-router start'.`);
    return 1;
  }
  const res = await fetchWithTimeout(`${current.baseUrl}/api/show`, 5000, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelName })
  });
  if (!res || !res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error(`Model '${modelName}' not found: ${err.error || res.statusText}`);
    return 1;
  }
  const data = await res.json();
  console.log(`  Model:          ${modelName}`);
  console.log(`  Architecture:   ${data.details?.family || "transformer"}`);
  console.log(`  Parameters:     ${data.details?.parameter_size || "N/A"}`);
  console.log(`  Quantization:   ${data.details?.quantization_level || "N/A"}`);
  console.log(`  Format:         ${data.details?.format || "gguf/cloud"}`);
  if (data.local_router_chain) {
    console.log(`  Fallback Chain: ${data.local_router_chain.models?.join(" -> ")}`);
  }
  return 0;
}

async function cmdPs(options) {
  const current = await probeServer(options.host, options.port);
  if (!current.running) {
    console.error(`Local Router is not running on http://${options.host}:${options.port}.`);
    return 1;
  }
  const res = await fetchWithTimeout(`${current.baseUrl}/api/tags`);
  if (!res || !res.ok) return 1;
  const data = await res.json().catch(() => ({}));
  const models = Array.isArray(data.models) ? data.models : [];
  console.log(`NAME                                    ID          SIZE    PROCESSOR       UNTIL`);
  for (const m of models.slice(0, 10)) {
    const name = m.name || m.model || "";
    const id = (m.digest || m.id || name).slice(0, 12);
    const size = m.size ? `${(m.size / (1024 * 1024)).toFixed(1)} MB` : "N/A";
    console.log(`${name.padEnd(40)} ${id.padEnd(11)} ${size.padEnd(7)} 100% GPU/Cloud  Active`);
  }
  return 0;
}

async function cmdPull(modelName, options) {
  if (!modelName) {
    console.error("Model name is required (e.g. ollama pull <model>).");
    return 1;
  }
  console.log(`Pulling model manifest for ${modelName}...`);
  const current = await probeServer(options.host, options.port);
  if (current.running) {
    const res = await fetchWithTimeout(`${current.baseUrl}/api/pull`, 30000, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelName })
    });
    if (res && res.ok) {
      console.log(`✓ Model ${modelName} is active and ready in Local Router.`);
      return 0;
    }
  }
  console.log(`✓ Model ${modelName} is registered for routing.`);
  return 0;
}


function cmdEnv(options) {
  const host = options.host || DEFAULT_HOST;
  const port = options.port || DEFAULT_PORT;
  const baseUrl = `http://${host}:${port}`;
  const v1Url = `${baseUrl}/v1`;

  if (options.json) {
    console.log(JSON.stringify({
      OLLAMA_HOST: baseUrl,
      OLLAMA_API_BASE: baseUrl,
      OPENAI_BASE_URL: v1Url,
      OPENAI_API_BASE: v1Url,
      OPENAI_API_KEY: "local-router",
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_URL: baseUrl,
      ANTHROPIC_API_KEY: "local-router"
    }, null, 2));
    return 0;
  }

  if (options.pwsh) {
    console.log(`$env:OLLAMA_HOST = "${baseUrl}"`);
    console.log(`$env:OLLAMA_API_BASE = "${baseUrl}"`);
    console.log(`$env:OPENAI_BASE_URL = "${v1Url}"`);
    console.log(`$env:OPENAI_API_BASE = "${v1Url}"`);
    console.log(`$env:OPENAI_API_KEY = "local-router"`);
    console.log(`$env:ANTHROPIC_BASE_URL = "${baseUrl}"`);
    console.log(`$env:ANTHROPIC_API_URL = "${baseUrl}"`);
    console.log(`$env:ANTHROPIC_API_KEY = "local-router"`);
    return 0;
  }

  if (options.cmd) {
    console.log(`set OLLAMA_HOST=${baseUrl}`);
    console.log(`set OLLAMA_API_BASE=${baseUrl}`);
    console.log(`set OPENAI_BASE_URL=${v1Url}`);
    console.log(`set OPENAI_API_BASE=${v1Url}`);
    console.log(`set OPENAI_API_KEY=local-router`);
    console.log(`set ANTHROPIC_BASE_URL=${baseUrl}`);
    console.log(`set ANTHROPIC_API_URL=${baseUrl}`);
    console.log(`set ANTHROPIC_API_KEY=local-router`);
    return 0;
  }

  // Default: POSIX export
  console.log(`export OLLAMA_HOST="${baseUrl}"`);
  console.log(`export OLLAMA_API_BASE="${baseUrl}"`);
  console.log(`export OPENAI_BASE_URL="${v1Url}"`);
  console.log(`export OPENAI_API_BASE="${v1Url}"`);
  console.log(`export OPENAI_API_KEY="local-router"`);
  console.log(`export ANTHROPIC_BASE_URL="${baseUrl}"`);
  console.log(`export ANTHROPIC_API_URL="${baseUrl}"`);
  console.log(`export ANTHROPIC_API_KEY="local-router"`);
  return 0;
}

function cmdVersion() {
  console.log("ollama version is 0.6.4 (local-router 1.0.0)");
  return 0;
}

async function cmdCheckUpdate(options) {
  const current = await probeServer(options.host, options.port);
  if (current.running) {
    const res = await fetchWithTimeout(`${current.baseUrl}/api/check-updates`, 6000);
    if (res && res.ok) {
      const data = await res.json().catch(() => ({}));
      console.log(`Current Version: v${data.currentVersion} (${data.currentCommit})`);
      console.log(`Latest Version:  ${data.latestCommit ? `(${data.latestCommit})` : "Up to date"}`);
      if (data.hasUpdate) {
        console.log("\n✨ New update available! Run 'local-router update' to apply.");
      } else {
        console.log("\n✓ Local Router is up to date.");
      }
      return 0;
    }
  }

  // Offline / standalone check
  const projectRoot = path.resolve(__dirname, "..");
  const gitRes = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: projectRoot, encoding: "utf8" });
  const currentCommit = gitRes.stdout ? gitRes.stdout.trim() : "unknown";
  console.log(`Current Version: (${currentCommit})`);
  console.log("Run 'local-router update' to fetch and apply latest changes from main.");
  return 0;
}

async function cmdUpdate(options) {
  console.log("Checking for Local Router updates...");
  const current = await probeServer(options.host, options.port);
  if (current.running) {
    const res = await fetchWithTimeout(`${current.baseUrl}/api/apply-update`, 60000);
    if (res && res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        console.log(`✓ ${data.message}`);
        console.log("Restarting Local Router server...");
        await cmdStop(options);
        await cmdStart(options);
        console.log("✓ Server restarted with updated release.");
        return 0;
      }
      console.error(`✗ Update failed: ${data.message || data.error}`);
      return 1;
    }
  }

  // Standalone update when server is not running
  const projectRoot = path.resolve(__dirname, "..");
  const isWin = process.platform === "win32";
  console.log("[1/3] Pulling latest code from origin/main...");
  spawnSync("git", ["pull", "origin", "main"], { cwd: projectRoot, encoding: "utf8", stdio: "inherit", shell: isWin });

  console.log("[2/3] Updating dependencies...");
  spawnSync("npm", ["install", "--prefer-offline"], { cwd: projectRoot, encoding: "utf8", stdio: "inherit", shell: isWin });

  console.log("[3/3] Rebuilding TypeScript...");
  const buildRes = spawnSync("npm", ["run", "build"], { cwd: projectRoot, encoding: "utf8", stdio: "inherit", shell: isWin });

  if (buildRes.status === 0) {
    console.log("\n✓ Local Router successfully updated to latest release.");
    return 0;
  }
  console.error("\n✗ Build failed during update.");
  return 1;
}

async function cmdChat(argv) {
  let agent = 'auto';
  let fleet = true;
  const promptParts = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--agent' && i + 1 < argv.length) {
      agent = argv[++i];
    } else if (arg.startsWith('--agent=')) {
      agent = arg.slice(8);
    } else if (arg === '--fleet') {
      fleet = true;
    } else if (arg === '--no-fleet') {
      fleet = false;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: local-router chat [prompt] [options]');
      console.log('');
      console.log('Execute a prompt through the headless CLI agent fallback cascade or chat interactively.');
      console.log('Fallback chain: free-claude-code -> omp -> trae-cli');
      console.log('Target model: local-router/fallback-models @ 127.0.0.1:11434');
      console.log('');
      console.log('Options:');
      console.log('  --agent <choice>   Agent to use: auto, free-claude-code, omp, trae-cli, mini (default: auto)');
      console.log('  --fleet            Enable Trae/Mini agent fleet for autonomous subagent tasks (default)');
      console.log('  --no-fleet         Disable Trae/Mini agent fleet');
      console.log('  -h, --help         Show this help message');
      return 0;
    } else {
      promptParts.push(arg);
    }
  }

  const executorPath = path.join(__dirname, '..', 'build', 'agent-executor.js');
  if (!fs.existsSync(executorPath)) {
    console.error('Build artifacts not found. Run `npm run build` in the local-router directory first.');
    return 1;
  }
  const { executeAgentChain } = require(executorPath);

  const prompt = promptParts.join(' ').trim();
  if (prompt) {
    console.log(`[local-router chat] Model: local-router/fallback-models | Agent: ${agent} | Fleet: ${fleet ? 'ON' : 'OFF'}`);
    console.log(`[local-router chat] Executing: "${prompt}"...`);
    const result = await executeAgentChain({
      prompt,
      agentChoice: agent,
      fleetEnabled: fleet
    });

    console.log(`\n[Trace] ${result.trace.join(' -> ')}`);
    console.log(`[Agent Used] ${result.agentUsed} (${result.ok ? 'SUCCESS' : 'FAILED'}) in ${(result.durationMs / 1000).toFixed(1)}s\n`);
    console.log(result.output);
    return result.ok ? 0 : 1;
  }

  // Interactive REPL loop
  const readline = require('node:readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log('================================================================');
  console.log('Local Router Interactive Agent Chat');
  console.log('Model: local-router/fallback-models @ 127.0.0.1:11434');
  console.log(`Agent Selection: ${agent} | Fleet: ${fleet ? 'ON' : 'OFF'}`);
  console.log('Type your prompt and press Enter. Type "exit" or "quit" to leave.');
  console.log('================================================================\n');

  const ask = () => {
    rl.question('chat> ', async (input) => {
      const line = input.trim();
      if (!line || line.toLowerCase() === 'exit' || line.toLowerCase() === 'quit') {
        rl.close();
        return;
      }

      try {
        const result = await executeAgentChain({
          prompt: line,
          agentChoice: agent,
          fleetEnabled: fleet
        });
        console.log(`\n[${result.agentUsed}] (${result.ok ? 'OK' : 'FAIL'}):`);
        console.log(result.output);
        console.log(`[Trace: ${result.trace.join(' | ')}]\n`);
      } catch (err) {
        console.error(`[Error] ${err.message}`);
      }

      ask();
    });
  };

  ask();
  return new Promise((resolve) => {
    rl.on('close', () => resolve(0));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] || 'start';

  if (command === 'help' || command === '--help' || command === '-h') {
    usage();
    return;
  }

  if (command === 'chat') {
    process.exitCode = await cmdChat(argv.slice(1));
    return;
  }

  if (command === 'route') {
    const subcommand = argv[1] || 'status';
    if (subcommand === 'set') {
      process.exitCode = await cmdRouteSet('services');
      return;
    }
    if (subcommand === 'custom') {
      process.exitCode = await cmdRouteSet('custom', argv[2] || '');
      return;
    }
    if (subcommand === 'unset') {
      process.exitCode = cmdRouteUnset();
      return;
    }
    if (subcommand === 'status') {
      process.exitCode = cmdRouteStatus();
      return;
    }
    throw new Error(`Unknown route subcommand: ${subcommand}`);
  }

  const options = parseOptions(argv.slice(1));

  if (command === 'env' || command === 'exports') {
    process.exitCode = cmdEnv(options);
    return;
  }
  if (command === 'start' || command === 'serve') {
    process.exitCode = await cmdStart(options);
    return;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    process.exitCode = cmdVersion();
    return;
  }
  if (command === 'list' || command === 'tags' || command === 'models') {
    process.exitCode = await cmdList(options);
    return;
  }
  if (command === 'ps') {
    process.exitCode = await cmdPs(options);
    return;
  }
  if (command === 'show') {
    process.exitCode = await cmdShow(options.args[0] || argv[1], options);
    return;
  }
  if (command === 'pull') {
    process.exitCode = await cmdPull(options.args[0] || argv[1], options);
    return;
  }
  if (command === 'run') {
    const model = options.args[0] || argv[1] || 'local-router/free';
    console.log(`Connecting to Local Router at http://${options.host}:${options.port} for model '${model}'...`);
    console.log(`Tip: Connect IDE tools (VS Code Copilot, Continue, Cline, Roo Code) to http://${options.host}:${options.port}/v1`);
    return;
  }
  if (command === 'stop') {
    process.exitCode = await cmdStop(options);
    return;
  }
  if (command === 'status') {
    process.exitCode = await cmdStatus(options);
    return;
  }
  if (command === 'check-update' || command === 'check-updates') {
    process.exitCode = await cmdCheckUpdate(options);
    return;
  }
  if (command === 'update' || command === 'upgrade') {
    process.exitCode = await cmdUpdate(options);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
