#!/usr/bin/env node
/**
 * setup-bin-shims.mjs — postinstall fallback for filesystems without symlink support.
 *
 * npm creates node_modules/.bin entries as symlinks. On filesystems that forbid
 * symlink creation (Windows NTFS drives mounted into WSL without metadata,
 * some network filesystems) `npm install` fails with EPERM: operation not
 * permitted, symlink — leaving the tree without .bin shims so `npm run <cmd>`
 * cannot resolve package executables.
 *
 * This script runs after install and, for every direct dependency that exports
 * a `bin`, ensures node_modules/.bin/<name> exists:
 *   1. Skip if the entry already exists (normal installs — no-op).
 *   2. Try a symlink first (works wherever the filesystem allows it).
 *   3. Fall back to a tiny executable shim that re-execs the real target:
 *      - Node-shebang / extensionless JS targets -> node spawn shim
 *      - ELF binaries and other shebangs        -> /bin/sh exec shim
 *
 * No-op on healthy installs; self-healing on symlink-hostile mounts when the
 * install was run with `npm install --no-bin-links`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nmDir = path.join(root, 'node_modules');
const binDir = path.join(nmDir, '.bin');

if (!fs.existsSync(nmDir)) {
  console.log('[bin-shims] no node_modules present; nothing to do.');
  process.exit(0);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const depNames = [
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.devDependencies || {})
];

fs.mkdirSync(binDir, { recursive: true });

let created = 0;
let skipped = 0;
let failed = 0;

function readHead(filePath, size = 64) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(size);
    const bytes = fs.readSync(fd, buf, 0, size, 0);
    return buf.subarray(0, bytes);
  } finally {
    fs.closeSync(fd);
  }
}

for (const name of depNames) {
  const pkgDir = path.join(nmDir, name);
  const manifestPath = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(manifestPath)) continue;

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    continue;
  }
  if (!manifest.bin) continue;

  const entries = typeof manifest.bin === 'string' ? { [name]: manifest.bin } : manifest.bin;

  for (const [binName, rawTarget] of Object.entries(entries)) {
    const linkPath = path.join(binDir, binName);
    if (fs.existsSync(linkPath)) {
      skipped += 1;
      continue;
    }

    const targetAbs = path.join(pkgDir, String(rawTarget));
    if (!fs.existsSync(targetAbs)) {
      failed += 1;
      console.warn(`[bin-shims] missing bin target: ${targetAbs}`);
      continue;
    }

    const relFromBin = path.relative(binDir, targetAbs);

    try {
      fs.symlinkSync(relFromBin, linkPath);
      created += 1;
      continue;
    } catch {
      // Symlinks unavailable on this filesystem — write a shim below.
    }

    const head = readHead(targetAbs);
    const isElf = head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
    const text = head.toString('utf8');
    const newlineIndex = text.indexOf('\n');
    const shebang = text.startsWith('#!') ? text.slice(0, newlineIndex >= 0 ? newlineIndex : text.length) : '';
    const shebangTokens = shebang.trim().split(/\s+/);
    const interpreter = shebangTokens[shebangTokens.length - 1] || '';
    const isNode = /node(\.exe)?$/.test(interpreter);

    let shim;
    if (isElf || (shebang && !isNode)) {
      shim = `#!/bin/sh\nDIR="$(cd "$(dirname "$0")" && pwd)"\nexec "$DIR/${relFromBin}" "$@"\n`;
    } else {
      shim = [
        '#!/usr/bin/env node',
        'const { spawnSync } = require(\'node:child_process\');',
        'const path = require(\'node:path\');',
        `const target = path.join(__dirname, ${JSON.stringify(relFromBin)});`,
        'const result = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: \'inherit\' });',
        'if (result.error) { console.error(result.error); process.exit(1); }',
        'process.exit(result.status ?? 1);',
        ''
      ].join('\n');
    }

    try {
      fs.writeFileSync(linkPath, shim, { mode: 0o755 });
      fs.chmodSync(linkPath, 0o755);
      created += 1;
    } catch (err) {
      failed += 1;
      console.warn(`[bin-shims] failed for ${binName}: ${err.message}`);
    }
  }
}

console.log(`[bin-shims] created=${created} skipped=${skipped} failed=${failed}`);
