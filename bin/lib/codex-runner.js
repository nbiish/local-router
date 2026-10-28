#!/usr/bin/env node
/**
 * codex-runner.js — transparent `codex` shim for Local Router.
 *
 * When Codex interception is enabled on the Agents page, run the real Codex
 * CLI through the managed `local-router` profile so it talks to the loopback
 * Responses shim. When interception is off, this is a pure passthrough.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, execFileSync } = require('child_process');

const PROFILE_NAME = 'local-router';

function loadAgentProxyConfig() {
  try {
    const configPath = path.join(os.homedir(), '.config', 'local-router', 'agent-proxy-config.json');
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch {
    // A corrupt config must not break the CLI: fall back to passthrough.
  }
  return null;
}

function findRealCodex() {
  const currentBinDir = path.resolve(__dirname, '..');
  const isWin = process.platform === 'win32';
  const pathSeparator = isWin ? ';' : ':';
  const pathDirs = (process.env.PATH || '').split(pathSeparator).filter(Boolean);
  const extensions = isWin ? ['.exe', '.cmd', '.bat', '.ps1', ''] : [''];
  const skip = (dir) => path.resolve(dir).toLowerCase() === currentBinDir.toLowerCase();
  // A second Local Router install on PATH ships the same shim; re-executing it
  // would ping-pong between the two instead of starting Codex.
  const isShim = (candidate) => {
    try {
      if (fs.statSync(candidate).size > 4096) return false;
      return fs.readFileSync(candidate, 'utf8').includes('codex-runner.js');
    } catch {
      return false;
    }
  };

  const candidates = [
    ...pathDirs.map((dir) => ({ dir, label: dir })),
    ...(isWin && process.env.LOCALAPPDATA
      ? [{ dir: path.join(process.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin'), label: 'codex-install' }]
      : []),
    { dir: path.join(os.homedir(), '.local', 'bin'), label: 'user-bin' }
  ];

  for (const entry of candidates) {
    if (!entry.dir || skip(entry.dir)) continue;
    for (const ext of extensions) {
      const candidate = path.join(entry.dir, `codex${ext}`);
      try {
        if (fs.existsSync(candidate) && !fs.statSync(candidate).isDirectory() && !isShim(candidate)) {
          return candidate;
        }
      } catch {}
    }
  }

  if (isWin) {
    try {
      const output = execFileSync('where.exe', ['codex'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      for (const line of output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
        if (skip(path.dirname(line)) || !fs.existsSync(line) || isShim(line)) continue;
        return line;
      }
    } catch {}
  }

  return null;
}

/** Inject the managed profile unless the operator chose one explicitly. */
function withManagedProfile(args) {
  const hasProfile = args.some(
    (arg) => arg === '--profile' || arg === '-p' || arg.startsWith('--profile=') || arg.startsWith('-p=')
  );
  if (hasProfile) return args;
  return ['--profile', PROFILE_NAME, ...args];
}

const config = loadAgentProxyConfig();
const interceptionEnabled = Boolean(config && config.codex && config.codex.enabled);
const args = interceptionEnabled ? withManagedProfile(process.argv.slice(2)) : process.argv.slice(2);

if (interceptionEnabled && !process.env.OPENAI_API_KEY) {
  // The managed provider uses env_key = "OPENAI_API_KEY"; Local Router accepts
  // any non-empty value and never forwards it upstream.
  process.env.OPENAI_API_KEY = 'local-router';
}

const realCodex = findRealCodex();

if (!realCodex) {
  console.error("[local-router] Codex CLI ('codex') was not found on your system PATH.");
  console.error('[local-router] Install Codex CLI via one of:');
  console.error('    npm install -g @openai/codex');
  console.error('    irm https://chatgpt.com/codex/install.ps1 | iex   (Windows)');
  process.exit(1);
}

const result = spawnSync(realCodex, args, {
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32' && (realCodex.endsWith('.cmd') || realCodex.endsWith('.bat'))
});

if (result.error) {
  console.error('[local-router] Error executing Codex CLI:', result.error.message);
  process.exit(1);
}

process.exit(result.status !== null ? result.status : 0);
