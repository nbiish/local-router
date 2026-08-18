import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isBlockedIpv4,
  isBlockedIpv6,
  isBlockedIp,
  assertSafeUpstreamUrl,
  SsrfBlockedError
} from '../build/ssrf-guard.js';

// ── IPv4 blocklist ──────────────────────────────────────────────

test('cloud-metadata IP 169.254.169.254 is blocked', () => {
  assert.equal(isBlockedIpv4('169.254.169.254'), true);
  assert.equal(isBlockedIp('169.254.169.254'), true);
});

test('RFC 1918 private ranges are blocked', () => {
  assert.equal(isBlockedIpv4('10.0.0.1'), true);
  assert.equal(isBlockedIpv4('10.255.255.255'), true);
  assert.equal(isBlockedIpv4('172.16.0.1'), true);
  assert.equal(isBlockedIpv4('172.31.255.255'), true);
  assert.equal(isBlockedIpv4('192.168.1.1'), true);
  assert.equal(isBlockedIpv4('192.168.0.0'), true);
});

test('loopback range is blocked', () => {
  assert.equal(isBlockedIpv4('127.0.0.1'), true);
  assert.equal(isBlockedIpv4('127.255.255.255'), true);
});

test('link-local range is blocked', () => {
  assert.equal(isBlockedIpv4('169.254.0.1'), true);
  assert.equal(isBlockedIpv4('169.254.255.255'), true);
});

test('public IPs are NOT blocked', () => {
  assert.equal(isBlockedIpv4('8.8.8.8'), false);
  assert.equal(isBlockedIpv4('1.1.1.1'), false);
  assert.equal(isBlockedIpv4('172.32.0.1'), false); // just outside 172.16/12
});

// ── IPv6 blocklist ──────────────────────────────────────────────

test('IPv6 loopback is blocked', () => {
  assert.equal(isBlockedIpv6('::1'), true);
});

test('IPv6 link-local is blocked', () => {
  assert.equal(isBlockedIpv6('fe80::1'), true);
});

test('IPv6 unique-local (ULA) is blocked', () => {
  assert.equal(isBlockedIpv6('fd00::1'), true);
  assert.equal(isBlockedIpv6('fc00::1'), true);
});

// ── assertSafeUpstreamUrl ───────────────────────────────────────

test('assertSafeUpstreamUrl blocks literal cloud-metadata HTTPS URL', async () => {
  await assert.rejects(
    () => assertSafeUpstreamUrl('https://169.254.169.254/latest/meta-data/'),
    (err) => {
      assert.ok(err instanceof SsrfBlockedError);
      assert.match(err.message, /blocked/i);
      return true;
    }
  );
});

test('assertSafeUpstreamUrl blocks other private IPs', async () => {
  await assert.rejects(() => assertSafeUpstreamUrl('https://10.0.0.1/'));
  await assert.rejects(() => assertSafeUpstreamUrl('https://192.168.1.1/'));
});

test('assertSafeUpstreamUrl blocks non-HTTPS without DEV mode', async () => {
  // LOCAL_ROUTER_DEV is not set in the test environment.
  await assert.rejects(
    () => assertSafeUpstreamUrl('http://example.com/'),
    (err) => {
      assert.ok(err instanceof SsrfBlockedError);
      assert.match(err.message, /HTTP/i);
      return true;
    }
  );
});

test('assertSafeUpstreamUrl rejects unsupported protocols', async () => {
  await assert.rejects(
    () => assertSafeUpstreamUrl('file:///etc/passwd'),
    SsrfBlockedError
  );
});

test('assertSafeUpstreamUrl allows loopback HTTP (local service backends)', async () => {
  await assertSafeUpstreamUrl('http://127.0.0.1:8080/v1/models');
  await assertSafeUpstreamUrl('http://[::1]:8080/v1/models');
  await assertSafeUpstreamUrl('http://localhost:8080/v1/models');
});

test('assertSafeUpstreamUrl still blocks non-loopback HTTP without DEV mode', async () => {
  await assert.rejects(
    () => assertSafeUpstreamUrl('http://127.0.0.1.evil.example/v1'),
    SsrfBlockedError
  );
});
