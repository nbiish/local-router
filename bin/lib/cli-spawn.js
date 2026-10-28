#!/usr/bin/env node
/**
 * cli-spawn.js — start a real CLI safely from the Local Router shims.
 *
 * Windows cannot spawn a `.cmd`/`.bat` without a shell (Node refuses since the
 * 2024 argument-injection fix), and `shell: true` joins argv with spaces, which
 * destroys any prompt containing whitespace. npm/Claude/Codex shims always
 * point at a concrete `.js` or `.exe`, so resolve that target and spawn it with
 * a real argv array instead of round-tripping through cmd.exe.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MAX_SHIM_BYTES = 16 * 1024;

function expandShimPath(raw, shimDir) {
  return raw
    .replace(/%~dp0/gi, shimDir + path.sep)
    .replace(/%dp0%/gi, shimDir + path.sep)
    .replace(/%~?dp0%/gi, shimDir + path.sep);
}

/**
 * Resolve the executable a generated `.cmd`/`.bat` wrapper ultimately runs.
 * Returns null when the file is not a recognisable generated wrapper.
 */
function resolveCommandShim(shimPath) {
  let text = '';
  try {
    if (fs.statSync(shimPath).size > MAX_SHIM_BYTES) return null;
    text = fs.readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }

  const shimDir = path.dirname(shimPath);
  const jsMatch = /"([^"]*\.js)"/i.exec(text);
  if (jsMatch) {
    const target = path.normalize(expandShimPath(jsMatch[1], shimDir));
    if (fs.existsSync(target)) {
      return { command: process.execPath, prefixArgs: [target] };
    }
  }

  const exeMatch = /"([^"]*\.exe)"/i.exec(text);
  if (exeMatch) {
    const target = path.normalize(expandShimPath(exeMatch[1], shimDir));
    if (fs.existsSync(target)) {
      return { command: target, prefixArgs: [] };
    }
  }

  return null;
}

function spawnCli(candidate, args) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(candidate)) {
    const target = resolveCommandShim(candidate);
    if (target) {
      return spawnSync(target.command, [...target.prefixArgs, ...args], {
        stdio: 'inherit',
        env: process.env
      });
    }
    // Unknown wrapper format — fall back to the shell, accepting its quoting
    // limits rather than refusing to run the CLI at all.
    return spawnSync(candidate, args, { stdio: 'inherit', env: process.env, shell: true });
  }

  return spawnSync(candidate, args, { stdio: 'inherit', env: process.env });
}

module.exports = { resolveCommandShim, spawnCli };

