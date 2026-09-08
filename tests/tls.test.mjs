/**
 * TLS / HTTPS listener contract tests (src/tls.ts, build/tls.js).
 *
 * Coverage:
 * - env surface: enable flag, port parsing/defaults, hostname sanitization,
 *   LOCAL_ROUTER_TLS_DIR override for the auto-managed material location.
 * - SAN collection: loopback IP literals, configured hostname, zero-config
 *   localtest.me alias, LAN IPv4s.
 * - Certificate generation: parseable X.509, expected SANs, ~825-day validity,
 *   0600 key file on POSIX, meta sidecar.
 * - Reuse semantics: second call reuses material; a hostname change regenerates.
 * - End-to-end HTTPS handshake: server built from the generated material must
 *   complete a verified TLS handshake for `localhost` AND for the custom
 *   hostname (SNI) when the cert is supplied as the client CA.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';

const IS_WIN = process.platform === 'win32';

function freshTlsEnv(dir, extra = {}) {
  return {
    ...process.env,
    LOCAL_ROUTER_TLS_DIR: dir,
    LOCAL_ROUTER_TLS_CERT: '',
    LOCAL_ROUTER_TLS_KEY: '',
    LOCAL_ROUTER_TLS_HOSTNAME: '',
    LOCAL_ROUTER_TLS_PORT: '',
    ...extra
  };
}

function makeTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `local-router-tls-${label}-`));
}

function parseSanNames(certPem) {
  const cert = new X509Certificate(certPem);
  // subjectAltName renders like "DNS:localhost, IP Address:127.0.0.1, ..." —
  // Node expands IPv6, so normalize `0:0:0:0:0:0:0:1` back to `::1`.
  const names = [];
  for (const part of String(cert.subjectAltName || '').split(', ')) {
    const idx = part.indexOf(':');
    if (idx > 0) {
      const value = part.slice(idx + 1).trim();
      names.push(value === '0:0:0:0:0:0:0:1' ? '::1' : value);
    }
  }
  return { cert, names };
}

test('TLS settings: disabled by default, sane defaults, env overrides', async () => {
  const { resolveTlsSettings, DEFAULT_TLS_PORT, DEFAULT_TLS_HOSTNAME } = await import('../build/tls.js');
  const base = freshTlsEnv('/tmp/does-not-matter');
  assert.equal(resolveTlsSettings(base).enabled, false);
  assert.equal(resolveTlsSettings(base).port, DEFAULT_TLS_PORT);
  assert.equal(DEFAULT_TLS_PORT, 11443);
  assert.equal(resolveTlsSettings(base).hostname, DEFAULT_TLS_HOSTNAME);
  assert.equal(DEFAULT_TLS_HOSTNAME, 'local-router.local');
  assert.equal(resolveTlsSettings(base).certPath, path.join('/tmp/does-not-matter', 'local-router-cert.pem'));

  assert.equal(resolveTlsSettings({ ...base, LOCAL_ROUTER_TLS: 'true' }).enabled, true);
  assert.equal(resolveTlsSettings({ ...base, LOCAL_ROUTER_TLS: '1' }).enabled, true);
  assert.equal(resolveTlsSettings({ ...base, LOCAL_ROUTER_TLS: 'false' }).enabled, false);

  assert.equal(resolveTlsSettings({ ...base, LOCAL_ROUTER_TLS_PORT: '12500' }).port, 12500);
  assert.equal(resolveTlsSettings({ ...base, LOCAL_ROUTER_TLS_PORT: 'bogus' }).port, DEFAULT_TLS_PORT);
  assert.equal(resolveTlsSettings({ ...base, LOCAL_ROUTER_TLS_PORT: '70000' }).port, DEFAULT_TLS_PORT);

  assert.equal(
    resolveTlsSettings({ ...base, LOCAL_ROUTER_TLS_HOSTNAME: 'router.LAN.example' }).hostname,
    'router.lan.example'
  );
  // Hostname injection (spaces, wildcards mid-label, path chars) falls back to default.
  assert.equal(
    resolveTlsSettings({ ...base, LOCAL_ROUTER_TLS_HOSTNAME: 'evil host.*.x/../y' }).hostname,
    DEFAULT_TLS_HOSTNAME
  );

  const supplied = resolveTlsSettings({
    ...base,
    LOCAL_ROUTER_TLS_CERT: '/x/ca.pem',
    LOCAL_ROUTER_TLS_KEY: '/x/ca-key.pem'
  });
  assert.equal(supplied.operatorSupplied, true);
  assert.equal(supplied.certPath, '/x/ca.pem');
});

test('SAN collection covers loopback, configured hostname, zero-config alias, LAN IPs', async () => {
  const { collectSubjectAltNames, ZERO_CONFIG_HOSTNAME } = await import('../build/tls.js');
  const sans = collectSubjectAltNames('router.test');
  for (const required of ['localhost', 'router.test', ZERO_CONFIG_HOSTNAME, '127.0.0.1', '::1']) {
    assert.ok(sans.includes(required), `missing SAN: ${required}`);
  }
  assert.ok(ZERO_CONFIG_HOSTNAME.endsWith('.localtest.me'));
  for (const entry of sans) {
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(entry) || entry.includes(':');
    const isDns = /^[a-z0-9.-]+$/.test(entry);
    assert.ok(isIp || isDns, `malformed SAN entry: ${entry}`);
  }
});

test('certificate generation: files, SANs, validity, key permissions, meta sidecar', async () => {
  const dir = makeTempDir('gen');
  const { ensureTlsMaterial, resolveTlsSettings } = await import('../build/tls.js');
  const settings = resolveTlsSettings(freshTlsEnv(dir, { LOCAL_ROUTER_TLS_HOSTNAME: 'router.test' }));
  const material = await ensureTlsMaterial(settings);

  assert.equal(material.generated, true);
  assert.ok(fs.existsSync(material.certPath));
  assert.ok(fs.existsSync(material.keyPath));
  const keyStat = fs.statSync(material.keyPath);
  if (!IS_WIN) assert.equal(keyStat.mode & 0o777, 0o600, 'private key must be 0600');

  const { cert, names } = parseSanNames(material.cert);
  for (const required of ['localhost', 'router.test', '127.0.0.1', '::1']) {
    assert.ok(names.includes(required), `cert missing SAN: ${required}`);
  }
  const validFrom = new Date(cert.validFrom);
  const validTo = new Date(cert.validTo);
  const days = Math.round((validTo - validFrom) / 86400000);
  assert.ok(days >= 800 && days <= 850, `unexpected validity span: ${days} days`);

  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'tls-meta.json'), 'utf8'));
  assert.equal(meta.hostname, 'router.test');
  assert.deepEqual(meta.sans, material.sans);
});

test('material reuse: second call reuses; hostname change regenerates', async () => {
  const dir = makeTempDir('reuse');
  const { ensureTlsMaterial, resolveTlsSettings } = await import('../build/tls.js');
  const settingsA = resolveTlsSettings(freshTlsEnv(dir, { LOCAL_ROUTER_TLS_HOSTNAME: 'alpha.test' }));
  const first = await ensureTlsMaterial(settingsA);
  const second = await ensureTlsMaterial(settingsA);
  assert.equal(second.generated, false, 'existing valid material must be reused');
  assert.equal(second.cert, first.cert);

  const settingsB = resolveTlsSettings(freshTlsEnv(dir, { LOCAL_ROUTER_TLS_HOSTNAME: 'beta.test' }));
  const third = await ensureTlsMaterial(settingsB);
  assert.equal(third.generated, true, 'hostname change must regenerate the cert');
  const { names } = parseSanNames(third.cert);
  assert.ok(names.includes('beta.test'));
  assert.ok(!names.includes('alpha.test'));
});

test('HTTPS handshake works with the generated material for localhost and SNI hostname', async () => {
  const dir = makeTempDir('handshake');
  const { ensureTlsMaterial, resolveTlsSettings } = await import('../build/tls.js');
  const material = await ensureTlsMaterial(
    resolveTlsSettings(freshTlsEnv(dir, { LOCAL_ROUTER_TLS_HOSTNAME: 'router.test' }))
  );

  const server = https.createServer(
    { key: material.key, cert: material.cert },
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    }
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const requestOnce = (servername) => new Promise((resolve, reject) => {
    const req = https.get(
      {
        host: '127.0.0.1',
        port,
        servername,
        path: '/api/version',
        ca: material.cert,
        timeout: 5000
      },
      (res) => {
        // Grab the socket before the body stream ends (it is nulled afterwards).
        const socket = res.socket;
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, body, socket }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });

  try {
    const viaLocalhost = await requestOnce('localhost');
    assert.equal(viaLocalhost.statusCode, 200);
    assert.equal(viaLocalhost.socket.authorized, true, 'localhost handshake must verify');
    assert.equal(viaLocalhost.body, JSON.stringify({ ok: true, url: '/api/version' }));

    const viaHostname = await requestOnce('router.test');
    assert.equal(viaHostname.socket.authorized, true, 'custom hostname (SNI) handshake must verify');

    // An unrelated hostname must be REFUSED at handshake time (request errors out).
    await assert.rejects(
      requestOnce('wrong.example'),
      (err) => err && err.code === 'ERR_TLS_CERT_ALTNAME_INVALID'
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
