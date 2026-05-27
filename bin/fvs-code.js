#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 11434;
const CONFIG_DIR = path.join(os.homedir(), '.config', 'fvs-code');
const STATE_PATH = path.join(CONFIG_DIR, 'proxy-state.json');
const ROUTING_STATE_PATH = path.join(CONFIG_DIR, 'tool-routing.json');
const SHIM_DIR = path.join(os.homedir(), '.local', 'bin');
const OLLAMA_SHIM_PATH = path.join(SHIM_DIR, 'ollama');
const SHIM_MARKER = '# fvs-code ollama shim';

function usage() {
  console.log([
    'fvs-code CLI',
    '',
    'Usage:',
    '  fvs-code start [--port 11434] [--host 127.0.0.1] [--foreground]',
    '  fvs-code stop [--port 11434] [--host 127.0.0.1]',
    '  fvs-code status [--port 11434] [--host 127.0.0.1]',
    '  fvs-code route set',
    '  fvs-code route custom <localhost:port>',
    '  fvs-code route unset',
    '  fvs-code route status',
    '',
    'Behavior:',
    '  - start: launches proxy only when nothing else is listening on the target port.',
    '  - route set: installs ~/.local/bin/ollama shim so `ollama serve` starts fvs-code proxy.',
    '  - route custom: same shim, but `ollama serve` starts fvs-code on a custom localhost port.',
    '  - route unset: removes that shim.',
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
    return { running: true, kind: 'fvs-code', baseUrl };
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

function writeStateFile(filePath, value) {
  ensureConfigDir();
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function waitForFvsReady(host, port, attempts = 40, intervalMs = 250) {
  for (let i = 0; i < attempts; i += 1) {
    const state = await probeServer(host, port);
    if (state.running && state.kind === 'fvs-code') {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function cmdStart(options) {
  const current = await probeServer(options.host, options.port);
  if (current.running) {
    if (current.kind === 'fvs-code') {
      console.log(`fvs-code proxy already running at ${current.baseUrl}`);
      return 0;
    }
    console.error(`Port ${options.port} already in use by ${current.kind}.`);
    console.error('Not starting fvs-code proxy to avoid overriding another server.');
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

  const started = await waitForFvsReady(options.host, options.port);
  if (!started) {
    try {
      process.kill(child.pid, 'SIGTERM');
    } catch {
      // Best-effort cleanup.
    }
    console.error(`fvs-code proxy failed to start on ${options.host}:${options.port}`);
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
  console.log(`fvs-code proxy started at http://${options.host}:${options.port}`);
  console.log(`PID: ${child.pid}`);
  console.log(`Log: ${logPath}`);
  return 0;
}

async function cmdStatus(options) {
  const state = await probeServer(options.host, options.port);
  const localState = readStateFile(STATE_PATH);

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
    console.log('No matching local fvs-code state file for this port.');
  }

  const route = routeStatusSummary();
  console.log(`Route shim: ${route.enabled ? 'enabled' : 'disabled'}`);
  if (route.enabled) {
    console.log(`Shim path: ${route.shimPath}`);
    console.log(`Real ollama: ${route.realOllamaPath || 'unknown'}`);
    console.log(`command -v ollama: ${route.activeOllamaPath || 'not found'}`);
  }
  return 0;
}

async function cmdStop(options) {
  const localState = readStateFile(STATE_PATH);
  if (localState && Number.isInteger(localState.pid)) {
    try {
      process.kill(localState.pid, 'SIGTERM');
    } catch (error) {
      // Keep going and check runtime state.
    }
  }

  for (let i = 0; i < 25; i += 1) {
    const current = await probeServer(options.host, options.port);
    if (!current.running || current.kind !== 'fvs-code') {
      try {
        fs.unlinkSync(STATE_PATH);
      } catch {
        // noop
      }
      console.log(`fvs-code proxy stopped on ${options.host}:${options.port}`);
      return 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  console.error('Unable to confirm fvs-code shutdown. Check running processes.');
  return 1;
}

function bashSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function whichAll(commandName) {
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
    throw new Error('Missing custom route target. Use: fvs-code route custom localhost:11500');
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
  if (current.running && current.kind !== 'fvs-code') {
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
    'FVS_CODE_BIN="${FVS_CODE_BIN:-fvs-code}"',
    '',
    'if [[ "${1:-}" == "serve" ]]; then',
    `  exec "$FVS_CODE_BIN" ${serveArgs}`,
    'fi',
    '',
    'exec "$REAL_OLLAMA" "$@"',
    ''
  ].join('\n');
}

function routeStatusSummary() {
  const routingState = readStateFile(ROUTING_STATE_PATH) || {};
  const activeOllamaPath = spawnSync('sh', ['-lc', 'command -v ollama || true'], { encoding: 'utf8' }).stdout.trim();
  const shimExists = fs.existsSync(OLLAMA_SHIM_PATH);
  const shimContent = shimExists ? fs.readFileSync(OLLAMA_SHIM_PATH, 'utf8') : '';
  const enabled = shimExists && shimContent.includes(SHIM_MARKER);

  return {
    enabled,
    shimPath: OLLAMA_SHIM_PATH,
    activeOllamaPath: activeOllamaPath || null,
    realOllamaPath: routingState.realOllamaPath || null,
    mode: routingState.mode || (enabled ? 'ollama' : 'none'),
    targetHost: routingState.targetHost || null,
    targetPort: routingState.targetPort || null
  };
}

function cmdRouteStatus() {
  const summary = routeStatusSummary();
  console.log(`Route shim: ${summary.enabled ? 'enabled' : 'disabled'}`);
  console.log(`Route mode: ${summary.mode}`);
  console.log(`Shim path: ${summary.shimPath}`);
  console.log(`command -v ollama: ${summary.activeOllamaPath || 'not found'}`);
  if (summary.realOllamaPath) {
    console.log(`Recorded real ollama: ${summary.realOllamaPath}`);
  }
  if (summary.mode === 'custom' && summary.targetHost && summary.targetPort) {
    console.log(`Custom target: ${summary.targetHost}:${summary.targetPort}`);
  }
  if (summary.enabled && summary.activeOllamaPath !== OLLAMA_SHIM_PATH) {
    console.log('Warning: shim exists but is not first in PATH. Place ~/.local/bin earlier in PATH.');
  }
  return 0;
}

async function cmdRouteSet(routeMode = 'ollama', customTarget = null) {
  const candidates = whichAll('ollama');
  const realOllamaPath = candidates.find((candidate) => path.resolve(candidate) !== path.resolve(OLLAMA_SHIM_PATH));
  if (!realOllamaPath) {
    console.error('Could not locate the real ollama binary. Install Ollama first.');
    return 1;
  }

  let target = null;
  if (routeMode === 'custom') {
    target = parseCustomRouteTarget(customTarget);
    await validateCustomRouteTarget(target);
  }

  fs.mkdirSync(SHIM_DIR, { recursive: true });
  const shimScript = renderOllamaShim(realOllamaPath, routeMode, target);

  fs.writeFileSync(OLLAMA_SHIM_PATH, shimScript, 'utf8');
  fs.chmodSync(OLLAMA_SHIM_PATH, 0o755);
  writeStateFile(ROUTING_STATE_PATH, {
    enabled: true,
    mode: routeMode,
    shimPath: OLLAMA_SHIM_PATH,
    realOllamaPath,
    targetHost: target?.host || null,
    targetPort: target?.port || null,
    updatedAt: new Date().toISOString()
  });

  console.log(`Installed ollama route shim: ${OLLAMA_SHIM_PATH}`);
  console.log(`Real ollama path: ${realOllamaPath}`);
  if (routeMode === 'custom' && target) {
    console.log(`Custom route target: ${target.host}:${target.port}`);
  }
  console.log('Ensure ~/.local/bin is before other paths in PATH for this to take effect.');
  return 0;
}

function cmdRouteUnset() {
  if (fs.existsSync(OLLAMA_SHIM_PATH)) {
    const content = fs.readFileSync(OLLAMA_SHIM_PATH, 'utf8');
    if (!content.includes(SHIM_MARKER)) {
      console.error(`Refusing to remove non-fvs shim at ${OLLAMA_SHIM_PATH}`);
      return 1;
    }
    fs.unlinkSync(OLLAMA_SHIM_PATH);
  }

  const routingState = readStateFile(ROUTING_STATE_PATH) || {};
  writeStateFile(ROUTING_STATE_PATH, {
    ...routingState,
    enabled: false,
    mode: 'none',
    targetHost: null,
    targetPort: null,
    updatedAt: new Date().toISOString()
  });

  console.log(`Removed ollama route shim: ${OLLAMA_SHIM_PATH}`);
  return 0;
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
      process.exitCode = await cmdRouteSet('ollama');
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
