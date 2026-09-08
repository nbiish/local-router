/**
 * `local-router start` connection-printout contract tests (bin/local-router.js).
 *
 * Coverage:
 * - requiring the CLI module is side-effect free (require.main guard) so the
 *   banner helpers are testable.
 * - buildConnectionLines: HTTP line always present; HTTPS URLs (localhost,
 *   localtest.me alias, custom hostname with hosts-entry hint) when live;
 *   disabled hint when off; "enabled but not detected" variant.
 * - resolveTlsBannerSettings: repo-root .env supplies LOCAL_ROUTER_TLS* when
 *   the shell lacks them; shell env wins over .env; sane defaults otherwise.
 * - readRepoDotEnvTls: comments/blank lines skipped, quotes stripped.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cli = (await import('../bin/local-router.js')).default;
const ZERO_CONFIG_HOSTNAME = 'local-router.localtest.me';

test('CLI module requires without running main() (require.main guard)', () => {
  assert.equal(typeof cli.buildConnectionLines, 'function');
  assert.equal(typeof cli.resolveTlsBannerSettings, 'function');
  assert.equal(typeof cli.readRepoDotEnvTls, 'function');
  // Guard proof: a bare require must not have emitted usage or started servers.
  assert.equal(process.exitCode, undefined);
});

test('buildConnectionLines: TLS live prints HTTP + all HTTPS identities', () => {
  const lines = cli.buildConnectionLines({
    httpBaseUrl: 'http://127.0.0.1:11434',
    tlsLive: true,
    tlsPort: 11443,
    tlsHostname: 'mytool.lab'
  });
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^ {4}► HTTP {4}http:\/\/127\.0\.0\.1:11434/);
  assert.ok(lines.some((l) => l.includes('https://localhost:11443')));
  assert.ok(lines.some((l) => l.includes(`https://${ZERO_CONFIG_HOSTNAME}:11443`)));
  assert.ok(lines.some((l) => l.includes('https://mytool.lab:11443') && l.includes('127.0.0.1 mytool.lab')));
  assert.ok(!lines.some((l) => /disabled/i.test(l)));
});

test('buildConnectionLines: TLS off prints disabled hint; enabled-but-dark variant', () => {
  const off = cli.buildConnectionLines({
    httpBaseUrl: 'http://127.0.0.1:11434',
    tlsLive: false,
    tlsPort: 11443,
    tlsHostname: 'local-router.local'
  });
  assert.equal(off.length, 2);
  assert.match(off[1], /disabled — enable with LOCAL_ROUTER_TLS=true/);

  const dark = cli.buildConnectionLines({
    httpBaseUrl: 'http://127.0.0.1:11434',
    tlsLive: false,
    tlsPort: 11443,
    tlsHostname: 'local-router.local',
    tlsEnabledButNotLive: true
  });
  assert.match(dark[1], /enabled but not detected yet/);
});

test('resolveTlsBannerSettings: repo .env enables when shell is silent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-start-banner-'));
  const dotEnvPath = path.join(dir, '.env');
  fs.writeFileSync(dotEnvPath, [
    '# comment line',
    'LOCAL_ROUTER_TLS=true',
    'LOCAL_ROUTER_TLS_HOSTNAME="mytool.lab"',
    'UNRELATED_KEY=ignored',
    ''
  ].join('\n'));

  const settings = cli.resolveTlsBannerSettings(dotEnvPath, {});
  assert.equal(settings.enabled, true);
  assert.equal(settings.hostname, 'mytool.lab');
  assert.equal(settings.port, 11443); // default when unset anywhere
});

test('resolveTlsBannerSettings: shell env wins over .env; defaults when neither', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-start-banner-'));
  const dotEnvPath = path.join(dir, '.env');
  fs.writeFileSync(dotEnvPath, 'LOCAL_ROUTER_TLS_PORT=11500\nLOCAL_ROUTER_TLS_HOSTNAME=from-file.test\n');

  const overridden = cli.resolveTlsBannerSettings(dotEnvPath, { LOCAL_ROUTER_TLS_PORT: '11600' });
  assert.equal(overridden.port, 11600);
  assert.equal(overridden.hostname, 'from-file.test'); // .env still supplies what shell omits

  const plain = cli.resolveTlsBannerSettings(path.join(dir, 'missing.env'), {});
  assert.equal(plain.enabled, false);
  assert.equal(plain.port, 11443);
  assert.equal(plain.hostname, 'local-router.local');
});

test('readRepoDotEnvTls: quotes stripped, comments skipped, non-TLS keys ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-start-banner-'));
  const dotEnvPath = path.join(dir, '.env');
  fs.writeFileSync(dotEnvPath, [
    '# LOCAL_ROUTER_TLS=false (commented out — must be ignored)',
    "LOCAL_ROUTER_TLS='true'",
    'LOCAL_ROUTER_TLS_HOSTNAME="quoted.test"',
    'PORT=9999',
    ''
  ].join('\n'));
  const parsed = cli.readRepoDotEnvTls(dotEnvPath);
  assert.deepEqual(parsed, { LOCAL_ROUTER_TLS: 'true', LOCAL_ROUTER_TLS_HOSTNAME: 'quoted.test' });
});
