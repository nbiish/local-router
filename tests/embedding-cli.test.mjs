import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * The CLI is the cross-platform surface: ainish-rag operators on PowerShell, a POSIX shell, WSL,
 * macOS and Linux all drive the same binary. These tests pin the parts that differ per shell —
 * quoting and exit codes — because a wrong dialect silently exports a broken base URL instead of
 * failing loudly.
 */

const CLI = join(process.cwd(), 'bin', 'localrouter.js');

function runCli(args, env = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ...env }
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

test('embedding-env emits each shell dialect with the route as the model', () => {
  const cases = [
    { shell: 'posix', expect: /^export AINISH_EMBED_API_BASE="http:\/\/127\.0\.0\.1:11434\/v1"$/m },
    { shell: 'powershell', expect: /^\$env:AINISH_EMBED_API_BASE = "http:\/\/127\.0\.0\.1:11434\/v1"$/m },
    { shell: 'cmd', expect: /^set AINISH_EMBED_API_BASE=http:\/\/127\.0\.0\.1:11434\/v1$/m },
    { shell: 'fish', expect: /^set -gx AINISH_EMBED_API_BASE http:\/\/127\.0\.0\.1:11434\/v1$/m }
  ];

  for (const { shell, expect } of cases) {
    const result = runCli(['embedding-env', '--shell', shell, '--dimensions', '768']);
    assert.equal(result.status, 0, `${shell}: ${result.stderr}`);
    assert.match(result.stdout, expect, `${shell} dialect must be syntactically correct`);
    // The route id, not a provider model: this is what makes the router the backend.
    assert.match(result.stdout, /AINISH_EMBED_MODEL.*local-router\/fallback-embedding/, shell);
    // The key is a placeholder — the router holds the real provider keys.
    assert.match(result.stdout, /AINISH_EMBED_API_KEY.*local-router/, shell);
    assert.match(result.stdout, /AINISH_EMBED_DIM.*768/, shell);
  }
});

test('embedding-env omits the dimension when none is requested', () => {
  const result = runCli(['embedding-env', '--shell', 'posix']);
  assert.equal(result.status, 0, result.stderr);
  // Omitting it is honest: the router forwards the request unchanged, so inventing a width here
  // would silently override the caller's index width.
  assert.doesNotMatch(result.stdout, /AINISH_EMBED_DIM/);
});

test('embedding-env honours an explicit route and host/port', () => {
  const result = runCli(['embedding-env', '--shell', 'posix', '--route', 'my-embedding', '--port', '12345']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /AINISH_EMBED_API_BASE="http:\/\/127\.0\.0\.1:12345\/v1"/);
  assert.match(result.stdout, /AINISH_EMBED_MODEL.*my-embedding/);
});

test('embedding-env --json is machine-readable for agents', () => {
  const result = runCli(['embedding-env', '--json', '--dimensions', '1536', '--shell', 'powershell']);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.env.AINISH_EMBED_MODEL, 'local-router/fallback-embedding');
  assert.equal(payload.env.AINISH_EMBED_DIM, '1536');
  assert.equal(payload.shell, 'powershell');
  assert.ok(Array.isArray(payload.lines) && payload.lines.length > 0);
});

test('embedding reports exit 2 when the router is not running', () => {
  // The documented contract: 0 success, 1 runtime error, 2 not running. A script that cannot
  // distinguish "down" from "broken" will retry forever or fail silently.
  const result = runCli(['embedding', '--port', '59998', '--json'], { LOCAL_ROUTER_PORT: '59998' });
  assert.equal(result.status, 2, `expected exit 2, got ${result.status}: ${result.stdout}${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
});
