import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

export function syncSystemAgentEnv(): { ok: boolean; error?: string } {
  const isWin = process.platform === 'win32';
  const homeDir = os.homedir();
  const localRouterConfigDir = path.join(homeDir, '.config', 'local-router');
  const envVars: Record<string, string> = {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434',
    ANTHROPIC_API_KEY: 'local-router',
    ANTHROPIC_AUTH_TOKEN: 'local-router'
  };

  try {
    fs.mkdirSync(localRouterConfigDir, { recursive: true });
    // Update ~/.config/local-router/env.sh
    const envScriptPath = path.join(localRouterConfigDir, 'env.sh');
    let existingEnv = fs.existsSync(envScriptPath) ? fs.readFileSync(envScriptPath, 'utf8') : '';
    for (const [k, v] of Object.entries(envVars)) {
      const line = `export ${k}="${v}"`;
      if (!existingEnv.includes(k)) {
        existingEnv += (existingEnv.endsWith('\n') || existingEnv.length === 0 ? '' : '\n') + line + '\n';
      }
    }
    fs.writeFileSync(envScriptPath, existingEnv, 'utf8');

    if (isWin) {
      for (const [k, v] of Object.entries(envVars)) {
        try {
          execFileSync(
            'powershell',
            ['-NoProfile', '-Command', `[Environment]::SetEnvironmentVariable("${k}", "${v}", "User")`],
            { stdio: 'ignore' }
          );
        } catch {}
      }

      // Auto-sync into WSL if WSL is available
      try {
        const wslCheck = execFileSync('wsl', ['-e', 'sh', '-c', 'echo wsl_ok'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
        if (wslCheck === 'wsl_ok') {
          const b64Env = Buffer.from(existingEnv).toString('base64');
          execFileSync('wsl', ['-e', 'sh', '-c', `
            mkdir -p ~/.config/local-router
            echo "${b64Env}" | base64 -d > ~/.config/local-router/env.sh
          `], { stdio: 'ignore' });
        }
      } catch {}
    } else {
      // On macOS / Linux: inject into ~/.bashrc and ~/.zshrc if not present
      for (const rcName of ['.bashrc', '.zshrc', '.profile']) {
        const rcPath = path.join(homeDir, rcName);
        if (fs.existsSync(rcPath)) {
          const existing = fs.readFileSync(rcPath, 'utf8');
          if (!existing.includes('local-router/env.sh')) {
            fs.appendFileSync(
              rcPath,
              '\n# Local Router environment variables\n[ -f "$HOME/.config/local-router/env.sh" ] && source "$HOME/.config/local-router/env.sh"\n'
            );
          }
        }
      }
    }

    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}
