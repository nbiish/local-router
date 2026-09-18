#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, execFileSync } = require('child_process');

function findRealClaude() {
  const currentBinDir = path.resolve(__dirname, '..');
  const isWin = process.platform === 'win32';
  const pathSeparator = isWin ? ';' : ':';
  const pathDirs = (process.env.PATH || '').split(pathSeparator).filter(Boolean);

  const extensions = isWin ? ['.cmd', '.exe', '.bat', '.ps1', ''] : [''];

  for (const dir of pathDirs) {
    const resolvedDir = path.resolve(dir);
    // Skip local-router's own bin directory to prevent recursion
    if (resolvedDir.toLowerCase() === currentBinDir.toLowerCase()) {
      continue;
    }

    for (const ext of extensions) {
      const candidate = path.join(dir, `claude${ext}`);
      try {
        if (fs.existsSync(candidate) && !fs.statSync(candidate).isDirectory()) {
          return candidate;
        }
      } catch {}
    }
  }

  // Fallback check on Windows using where.exe
  if (isWin) {
    try {
      const output = execFileSync('where.exe', ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const lines = output.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        if (!line.toLowerCase().includes(currentBinDir.toLowerCase()) && fs.existsSync(line)) {
          return line;
        }
      }
    } catch {}
  }

  return null;
}

function loadAgentProxyConfig() {
  try {
    const configPath = path.join(os.homedir(), '.config', 'local-router', 'agent-proxy-config.json');
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch {}
  return null;
}

const config = loadAgentProxyConfig();
const isProxyEnabled = Boolean(config && config.claudeCode && config.claudeCode.enabled);

if (isProxyEnabled) {
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:11434';
  if (!process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = 'local-router';
  }
  if (!process.env.ANTHROPIC_AUTH_TOKEN) {
    process.env.ANTHROPIC_AUTH_TOKEN = 'local-router';
  }
}

const realClaude = findRealClaude();

if (!realClaude) {
  console.error('[local-router] Claude Code CLI (\'claude\') was not found on your system PATH.');
  console.error('[local-router] Install Anthropic Claude Code via:');
  console.error('    npm install -g @anthropic-ai/claude-code');
  process.exit(1);
}

const args = process.argv.slice(2);
const result = spawnSync(realClaude, args, {
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32' && (realClaude.endsWith('.cmd') || realClaude.endsWith('.bat'))
});

if (result.error) {
  console.error('[local-router] Error executing Claude Code:', result.error.message);
  process.exit(1);
}

process.exit(result.status !== null ? result.status : 0);
