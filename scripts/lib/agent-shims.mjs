#!/usr/bin/env node
/**
 * agent-shims.mjs — install the `claude` and `codex` shims on macOS, Linux,
 * and WSL without ever overwriting a native harness binary.
 *
 * Both native installers put their binary in `~/.local/bin`, which is also the
 * directory Local Router uses for `local-router` / `pqc-secrets`. Agent shims
 * therefore live in their own directory that is prepended to PATH from the
 * user's shell rc files; the shim resolves the real binary further down PATH.
 */
import fs from 'node:fs';
import path from 'node:path';

export const AGENT_SHIM_NAMES = ['claude', 'codex'];
export const AGENT_SHIM_PATH_LINE = 'export PATH="$HOME/.local/share/local-router/bin:$PATH"';

export function planAgentShims({ homeDir, binDir }) {
  const shimDir = path.join(homeDir, '.local', 'share', 'local-router', 'bin');
  return {
    shimDir,
    entries: AGENT_SHIM_NAMES.map((name) => ({
      name,
      source: path.join(binDir, name),
      link: path.join(shimDir, name)
    }))
  };
}

export function ensureShimPath(rcPath) {
  const existing = fs.existsSync(rcPath) ? fs.readFileSync(rcPath, 'utf8') : '';
  if (existing.includes('.local/share/local-router/bin')) return false;
  fs.appendFileSync(
    rcPath,
    '\n# Local Router agent shims (claude, codex)\n' + AGENT_SHIM_PATH_LINE + '\n'
  );
  return true;
}

export function installAgentShims({ homeDir, binDir, log = () => {} }) {
  const { shimDir, entries } = planAgentShims({ homeDir, binDir });
  fs.mkdirSync(shimDir, { recursive: true });

  const linked = [];
  const failed = [];
  for (const entry of entries) {
    if (!fs.existsSync(entry.source)) {
      failed.push({ name: entry.name, error: 'shim source missing: ' + entry.source });
      continue;
    }
    try {
      if (fs.existsSync(entry.link)) fs.unlinkSync(entry.link);
      fs.symlinkSync(entry.source, entry.link);
      fs.chmodSync(entry.source, 0o755);
      linked.push(entry.link);
      log('✓ Linked ' + entry.name + ' -> ' + entry.link);
    } catch (error) {
      failed.push({ name: entry.name, error: error?.message || String(error) });
    }
  }

  const rcCandidates = ['.zshrc', '.bashrc', '.profile'].filter((name) =>
    fs.existsSync(path.join(homeDir, name))
  );
  const rcTargets = rcCandidates.length > 0 ? rcCandidates : ['.profile'];
  const rcUpdated = [];
  for (const rcName of rcTargets) {
    const rcPath = path.join(homeDir, rcName);
    if (ensureShimPath(rcPath)) {
      rcUpdated.push(rcPath);
      log('✓ Prepended Local Router agent shims to ~/' + rcName);
    }
  }

  return { shimDir, linked, failed, rcUpdated };
}
