#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { spawnCli } = require('./cli-spawn');

function findRealClaude() {
  const currentBinDir = path.resolve(__dirname, '..');
  const isWin = process.platform === 'win32';
  const pathSeparator = isWin ? ';' : ':';
  const pathDirs = (process.env.PATH || '').split(pathSeparator).filter(Boolean);

  const extensions = isWin ? ['.exe', '.cmd', '.bat', ''] : [''];
  // A second Local Router install on PATH ships the same shim; re-executing it
  // would ping-pong between the two instead of starting Claude Code.
  const isShim = (candidate) => {
    try {
      if (fs.statSync(candidate).size > 4096) return false;
      return fs.readFileSync(candidate, 'utf8').includes('claude-runner.js');
    } catch {
      return false;
    }
  };

  for (const dir of pathDirs) {
    const resolvedDir = path.resolve(dir);
    // Skip local-router's own bin directory to prevent recursion
    if (resolvedDir.toLowerCase() === currentBinDir.toLowerCase()) {
      continue;
    }

    for (const ext of extensions) {
      const candidate = path.join(dir, `claude${ext}`);
      try {
        if (fs.existsSync(candidate) && !fs.statSync(candidate).isDirectory() && !isShim(candidate)) {
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
        if (!line.toLowerCase().includes(currentBinDir.toLowerCase()) && fs.existsSync(line) && !isShim(line)) {
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
  // Follow the configured port instead of assuming the default one: a router on
  // a custom PORT is still the same gateway, and a hardcoded 11434 would send
  // the session to whatever else happens to listen there.
  const baseUrl = (process.env.LOCAL_ROUTER_BASE_URL || `http://127.0.0.1:${process.env.PORT || '11434'}`).replace(/\/+$/, '');
  process.env.ANTHROPIC_BASE_URL = baseUrl;
  if (!process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = 'local-router';
  }
  if (!process.env.ANTHROPIC_AUTH_TOKEN) {
    process.env.ANTHROPIC_AUTH_TOKEN = 'local-router';
  }
  // Auto mode asks the API to run its action classifier server-side and passes
  // the verdict back in `safeguard_results`. Local Router is not the Anthropic
  // API: it rewrites the conversation into chat-completions, so the `safeguards`
  // body field and `anthropic-beta` pairing cannot survive the translation and
  // the server's verdict never comes back. Claude Code then reports that this
  // session is not eligible and bills the classifier requests itself.
  // Declaring that up front is the documented handling for a gateway that
  // cannot provide the checks — it keeps auto mode working, keeps the billing
  // predictable, and stops the notice appearing on every new session. Set here
  // rather than system-wide so a direct Anthropic connection keeps the checks.
  if (!process.env.CLAUDE_CODE_AUTO_MODE_SERVER) {
    process.env.CLAUDE_CODE_AUTO_MODE_SERVER = '0';
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
const result = spawnCli(realClaude, args);

if (result.error) {
  console.error('[local-router] Error executing Claude Code:', result.error.message);
  process.exit(1);
}

process.exit(result.status !== null ? result.status : 0);
