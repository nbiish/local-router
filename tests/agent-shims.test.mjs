import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { installAgentShims, planAgentShims } from '../scripts/lib/agent-shims.mjs';

function makeTree() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-agent-shims-'));
  const bin = path.join(home, 'repo-bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ['claude', 'codex']) {
    fs.writeFileSync(path.join(bin, name), '#!/usr/bin/env bash\nexec node "$(dirname "$0")/runner.js" "$@"\n', {
      encoding: 'utf8',
      mode: 0o755
    });
  }
  return { home, bin };
}

test('planAgentShims keeps agent shims out of ~/.local/bin', () => {
  const { home, bin } = makeTree();
  const plan = planAgentShims({ homeDir: home, binDir: bin });

  assert.equal(plan.shimDir, path.join(home, '.local', 'share', 'local-router', 'bin'));
  assert.deepEqual(plan.entries.map((entry) => entry.name), ['claude', 'codex']);
  const userBin = path.join(home, '.local', 'bin');
  for (const entry of plan.entries) {
    assert.equal(path.dirname(entry.link), plan.shimDir);
    assert.ok(!entry.link.startsWith(userBin + path.sep), 'must not link over a native installer target');
  }

  fs.rmSync(home, { recursive: true, force: true });
});

test('installAgentShims never overwrites a native binary and appends PATH once', (t) => {
  const { home, bin } = makeTree();
  const userBin = path.join(home, '.local', 'bin');
  fs.mkdirSync(userBin, { recursive: true });
  const nativeClaude = path.join(userBin, 'claude');
  fs.writeFileSync(nativeClaude, 'REAL-CLAUDE-BINARY', 'utf8');
  const rcPath = path.join(home, '.zshrc');
  fs.writeFileSync(rcPath, '# shell config\n', 'utf8');

  const first = installAgentShims({ homeDir: home, binDir: bin });
  assert.equal(fs.readFileSync(nativeClaude, 'utf8'), 'REAL-CLAUDE-BINARY', 'native claude must survive');
  assert.equal(first.rcUpdated.length, 1);

  const rcAfterFirst = fs.readFileSync(rcPath, 'utf8');
  assert.match(rcAfterFirst, /\.local\/share\/local-router\/bin/);

  const second = installAgentShims({ homeDir: home, binDir: bin });
  assert.equal(second.rcUpdated.length, 0, 'PATH line must not duplicate');
  assert.equal((fs.readFileSync(rcPath, 'utf8').match(/local-router\/bin/g) || []).length, 1);

  if (process.platform === 'win32') {
    // Symlink creation may require Developer Mode; the installer reports it
    // instead of throwing, and the non-destructive guarantee still holds.
    assert.ok(second.failed.length === 0 || second.failed.every((entry) => /EPERM|privilege/i.test(entry.error)));
  } else {
    assert.deepEqual(second.failed, []);
    assert.equal(fs.readlinkSync(path.join(second.shimDir, 'claude')), path.join(bin, 'claude'));
    assert.equal(fs.readlinkSync(path.join(second.shimDir, 'codex')), path.join(bin, 'codex'));
  }

  fs.rmSync(home, { recursive: true, force: true });
});
