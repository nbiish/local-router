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
    '  local-router start [--port 11434] [--host 127.0.0.1] [--foreground]',
    '  local-router stop [--port 11434] [--host 127.0.0.1]',
    '  local-router status [--port 11434] [--host 127.0.0.1]',
    '  local-router route set',
    '  local-router route custom <localhost:port>',
    '  local-router route unset',
    '  local-router route status',
    '',
    'Behavior:',
    '  - start: launches proxy only when nothing else is listening on the target port.',
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
    foreground: false
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
    if (token === '--foreground') {
      options.foreground = true;
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error(`Invalid port: ${options.port}`);
  }
  return options;
}

async function fetchWithTimeout(url, timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
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
      console.log(`Local Router already running at ${current.baseUrl}`);
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

  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    SHIM_MARKER,
    `REAL_OLLAMA=${bashSingleQuote(realOllamaPath)}`,
    'LOCAL_ROUTER_BIN="${LOCAL_ROUTER_BIN:-${FVS_CODE_BIN:-local-router}}"',
    '',
    '# Escape hatch: LOCAL_ROUTER_NO_SHIM=1 runs the real binary directly.',
    'if [[ "${LOCAL_ROUTER_NO_SHIM:-0}" == "1" ]]; then',
    '  exec "$REAL_OLLAMA" "$@"',
    'fi',
    '',
    'if [[ "${1:-}" == "serve" ]]; then',
    '  export OLLAMA_HOST="127.0.0.1:11435"',
    '  "$REAL_OLLAMA" serve &',
    '  OLLAMA_PID=$!',
    '  trap "kill $OLLAMA_PID" EXIT',
    '  export LOCAL_ROUTER_PROVIDER_OLLAMA_BASE_URL="http://127.0.0.1:11435/v1"',
    '  export OLLAMA_API_KEY="local-router-ollama"',
    `  exec "$LOCAL_ROUTER_BIN" ${serveArgs}`,
    'fi',
    '',
    'exec "$REAL_OLLAMA" "$@"',
    ''
  ].join('\n');
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
          // A symlink lives at the shim path (e.g. ~/.local/bin/llama-server ->
          // miniforge3/bin/llama-server): the link target survives replacing
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
    return candidate;
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
    shimPath: serviceTarget.shimPath,
    enabled: fs.existsSync(serviceTarget.shimPath) && shimFileContainsMarker(serviceTarget.shimPath),
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
    shimPath: OLLAMA_SHIM_PATH,
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
  if (summary.enabled && summary.activeOllamaPath !== OLLAMA_SHIM_PATH) {
    console.log('Warning: ollama shim exists but is not first in PATH. Place ~/.local/bin earlier in PATH.');
  }
  return 0;
}

async function cmdRouteSet(routeMode = 'services', customTarget = null) {
  if (IS_WIN) {
    console.error('The service shims are POSIX bash features and are not supported on Windows.');
    console.error('On Windows, run `local-router start` directly (and start the ollama backend separately if needed).');
    return 1;
  }

  let routeTarget = null;
  if (routeMode === 'custom') {
    routeTarget = parseCustomRouteTarget(customTarget);
    await validateCustomRouteTarget(routeTarget);
  }

  fs.mkdirSync(SHIM_DIR, { recursive: true });

  const installed = [];
  let sawError = false;

  for (const serviceTarget of SERVICE_TARGETS) {
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

    installed.push({ command: serviceTarget.command, shimPath: serviceTarget.shimPath, realPath });
    console.log(`Installed ${serviceTarget.command} service shim: ${serviceTarget.shimPath}`);
    console.log(`  Real ${serviceTarget.command}: ${realPath}`);
    if (serviceTarget.providerSlug) {
      console.log(`  Registers custom provider "${serviceTarget.providerSlug}" when the service starts.`);
    }
  }

  writeStateFile(ROUTING_STATE_PATH, {
    enabled: installed.length > 0,
    mode: routeMode,
    shimPath: OLLAMA_SHIM_PATH,
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
  console.log('Ensure ~/.local/bin is before other paths in PATH for this to take effect.');
  return sawError ? 1 : 0;
}

function cmdRouteUnset() {
  let refused = false;
  let removedAny = false;
  for (const serviceTarget of SERVICE_TARGETS) {
    if (!fs.existsSync(serviceTarget.shimPath)) {
      continue;
    }
    if (!shimFileContainsMarker(serviceTarget.shimPath)) {
      console.error(`Refusing to remove non-Local Router file at ${serviceTarget.shimPath}`);
      refused = true;
      continue;
    }
    fs.unlinkSync(serviceTarget.shimPath);
    console.log(`Removed ${serviceTarget.command} service shim: ${serviceTarget.shimPath}`);
    removedAny = true;
  }

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

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] || 'start';

  if (command === 'help' || command === '--help' || command === '-h') {
    usage();
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

  if (command === 'start') {
    process.exitCode = await cmdStart(options);
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

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
