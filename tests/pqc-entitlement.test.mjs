/**
 * PQC Identity Binding & Tier-Gated Lease Enforcement tests for local-router.
 * Verifies byte-identical SHA3-256 PQC binding hash, ML-DSA-65 lease
 * verification, ML-KEM-768 wrapped renew credential round-trip, control-plane
 * pairing/renewal, and tier-gated remote bridge enforcement in inbound-auth.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ml_kem768 } = require('@noble/post-quantum/ml-kem.js');
const { ml_dsa65 } = require('@noble/post-quantum/ml-dsa.js');

const pqcEnt = require('../build/pqc-entitlement.js');
const inboundAuth = require('../build/inbound-auth.js');

function withTempConfigDir(fn) {
  const prevDir = process.env.LOCAL_ROUTER_CONFIG_DIR;
  const prevReq = process.env.LOCAL_ROUTER_REQUIRE_LEASE;
  const prevKey = process.env.LOCAL_ROUTER_ACCESS_KEY;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-pqc-ent-'));
  process.env.LOCAL_ROUTER_CONFIG_DIR = tmp;
  delete process.env.LOCAL_ROUTER_REQUIRE_LEASE;
  delete process.env.LOCAL_ROUTER_ACCESS_KEY;
  const cleanup = () => {
    if (prevDir === undefined) delete process.env.LOCAL_ROUTER_CONFIG_DIR;
    else process.env.LOCAL_ROUTER_CONFIG_DIR = prevDir;
    if (prevReq === undefined) delete process.env.LOCAL_ROUTER_REQUIRE_LEASE;
    else process.env.LOCAL_ROUTER_REQUIRE_LEASE = prevReq;
    if (prevKey === undefined) delete process.env.LOCAL_ROUTER_ACCESS_KEY;
    else process.env.LOCAL_ROUTER_ACCESS_KEY = prevKey;
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  return Promise.resolve().then(() => fn(tmp)).finally(cleanup);
}

function wrapSecretForTest(clientPkB64, plaintextSecret) {
  const pk = pqcEnt.base64urlDecode(clientPkB64);
  const { sharedSecret, cipherText } = ml_kem768.encapsulate(pk);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(sharedSecret), nonce);
  const enc = Buffer.concat([cipher.update(Buffer.from(plaintextSecret, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encapsulationB64: pqcEnt.base64urlEncode(cipherText),
    wrappedB64: pqcEnt.base64urlEncode(Buffer.concat([enc, tag])),
    nonceB64: pqcEnt.base64urlEncode(nonce)
  };
}

function signTestLease(signingKeys, overrides = {}) {
  const identity = pqcEnt.ensureDevicePqcIdentity();
  const email = overrides.email || 'alice.smith+dev@googlemail.com';
  const provider = overrides.provider || 'google';
  const accountId = overrides.accountId || '11111111-2222-4333-8444-555555555555';
  const emailHash = pqcEnt.computeEmailHash(email);
  const devicePubHash = overrides.devicePubHash || identity.devicePubHash;
  const deviceId = overrides.deviceId || identity.deviceId;
  const pqcBindingHash = pqcEnt.computePqcBindingHash({
    accountId,
    emailHash,
    provider,
    deviceId,
    devicePubHash
  });
  const keyId = pqcEnt.signingKeyFingerprint(signingKeys.publicKey);
  const lease = {
    schema: 1,
    issuer: 'https://local-router.com',
    keyId,
    accountId,
    provider,
    emailHash,
    deviceId,
    devicePubHash,
    pqcBindingHash,
    tier: overrides.tier || 'pro',
    tierExpiresAt: overrides.tierExpiresAt ?? '2027-01-01T00:00:00.000Z',
    entitlements: {
      cloudSync: true,
      remoteBridge: overrides.remoteBridge ?? true,
      maxDevices: overrides.maxDevices ?? 10,
      maxBlobs: 50,
      maxBlobBytes: 262144
    },
    issuedAt: new Date().toISOString(),
    expiresAt: overrides.expiresAt || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  };
  const sig = ml_dsa65.sign(pqcEnt.canonicalLeaseMessage(lease), signingKeys.secretKey);
  return {
    email,
    provider,
    lease,
    signatureB64: pqcEnt.base64urlEncode(sig),
    signingPublicKeyB64: pqcEnt.base64urlEncode(signingKeys.publicKey),
    signingKeyFingerprint: keyId
  };
}

test('computeEmailHash & computePqcBindingHash normalize Gmail aliases identically and verify ML-DSA-65', async () => {
  await withTempConfigDir(async () => {
    assert.equal(
      pqcEnt.computeEmailHash('Alice.Smith+tag@googlemail.com'),
      pqcEnt.computeEmailHash('alicesmith@gmail.com')
    );
    const signingKeys = ml_dsa65.keygen();
    const signed = signTestLease(signingKeys);
    const identity = pqcEnt.ensureDevicePqcIdentity();

    const ok = pqcEnt.verifyAppLease({
      lease: signed.lease,
      signatureB64: signed.signatureB64,
      signingPublicKeyB64: signed.signingPublicKeyB64,
      expectedDevicePubHash: identity.devicePubHash,
      expectedEmail: 'alicesmith@gmail.com'
    });
    assert.equal(ok.valid, true);

    const forged = pqcEnt.verifyAppLease({
      lease: { ...signed.lease, tier: 'business' },
      signatureB64: signed.signatureB64,
      signingPublicKeyB64: signed.signingPublicKeyB64,
      expectedDevicePubHash: identity.devicePubHash
    });
    assert.equal(forged.valid, false);
    assert.equal(forged.reason, 'invalid_signature');

    const otherMachine = pqcEnt.verifyAppLease({
      lease: signed.lease,
      signatureB64: signed.signatureB64,
      signingPublicKeyB64: signed.signingPublicKeyB64,
      expectedDevicePubHash: pqcEnt.computeDevicePubHash(pqcEnt.base64urlEncode(ml_kem768.keygen().publicKey))
    });
    assert.equal(otherMachine.valid, false);
    assert.equal(otherMachine.reason, 'device_key_mismatch');
  });
});

test('pairWithControlPlane + refreshLeaseFromControlPlane verify ML-DSA-65 and unwrap ML-KEM-768 renew token in memory', async () => {
  await withTempConfigDir(async () => {
    const signingKeys = ml_dsa65.keygen();
    const renewSecret = 'lrc-renew-secret-never-plaintext-on-disk';
    let seenAuthHeader = '';

    const mockFetch = async (url, init) => {
      const reqBody = JSON.parse(String(init.body || '{}'));
      if (String(url).endsWith('/api/v1/devices/pair')) {
        assert.equal(reqBody.pairingCode, 'lrp_test_pairing_code_12345');
        const signed = signTestLease(signingKeys, { tier: 'free', maxDevices: 3, tierExpiresAt: null });
        return new Response(JSON.stringify({
          paired: true,
          deviceId: reqBody.deviceId,
          provider: 'google',
          email: signed.email,
          pqcBindingHash: signed.lease.pqcBindingHash,
          algorithm: 'ML-DSA-65',
          lease: signed.lease,
          signatureB64: signed.signatureB64,
          signingPublicKeyB64: signed.signingPublicKeyB64,
          signingKeyFingerprint: signed.signingKeyFingerprint,
          delivery: 'ml-kem-768-wrapped',
          wrappedAccessSecret: wrapSecretForTest(reqBody.mlKemPublicKey, renewSecret)
        }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      if (String(url).endsWith('/api/v1/devices/lease')) {
        seenAuthHeader = String(init.headers?.authorization || '');
        const signed = signTestLease(signingKeys, { tier: 'pro', maxDevices: 10 });
        return new Response(JSON.stringify({
          renewed: true,
          deviceId: reqBody.deviceId,
          provider: 'google',
          pqcBindingHash: signed.lease.pqcBindingHash,
          algorithm: 'ML-DSA-65',
          lease: signed.lease,
          signatureB64: signed.signatureB64,
          signingPublicKeyB64: signed.signingPublicKeyB64,
          signingKeyFingerprint: signed.signingKeyFingerprint
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'unexpected url' }), { status: 404 });
    };

    const paired = await pqcEnt.pairWithControlPlane({
      pairingCode: 'lrp_test_pairing_code_12345',
      controlPlaneUrl: 'https://local-router.com',
      fetchImpl: mockFetch
    });
    assert.equal(paired.paired, true);
    assert.equal(paired.valid, true);
    assert.equal(paired.tier, 'free');
    assert.match(paired.pqcBindingHash, /^pqc3:[0-9a-f]{64}$/);

    // Verify plaintext renew secret is NEVER written to account-lease.json
    const rawDisk = fs.readFileSync(pqcEnt.accountLeasePath(), 'utf8');
    assert.equal(rawDisk.includes(renewSecret), false, 'renew secret must stay ML-KEM-768-wrapped on disk');

    // Refresh unwraps renew secret in memory and upgrades local lease to Pro
    const refreshed = await pqcEnt.refreshLeaseFromControlPlane({ fetchImpl: mockFetch });
    assert.equal(seenAuthHeader, `Bearer ${renewSecret}`);
    assert.equal(refreshed.valid, true);
    assert.equal(refreshed.tier, 'pro');
    assert.equal(refreshed.entitlements.maxDevices, 10);

    // Unpair removes the lease cleanly
    assert.equal(pqcEnt.unpairLocalAccount(), true);
    assert.equal(pqcEnt.evaluateAccountLeaseStatus().paired, false);
  });
});

test('tier-gated inbound-auth enforcement: loopback always open; remote bridge fails closed on expired/tampered lease or LOCAL_ROUTER_REQUIRE_LEASE=1', async () => {
  await withTempConfigDir(async () => {
    process.env.LOCAL_ROUTER_ACCESS_KEY = 'bridge-test-key-xyz';
    const signingKeys = ml_dsa65.keygen();

    const loopbackReq = {
      path: '/v1/chat/completions',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' }
    };
    const publicReq = {
      path: '/v1/chat/completions',
      headers: {
        'cf-connecting-ip': '203.0.113.55',
        authorization: 'Bearer bridge-test-key-xyz'
      },
      socket: { remoteAddress: '127.0.0.1' }
    };

    // 1. Unpaired + LOCAL_ROUTER_REQUIRE_LEASE unset -> loopback & keyed bridge both allowed (OSS compatibility)
    assert.deepEqual(inboundAuth.evaluateInboundAccess(loopbackReq), { allow: true });
    assert.deepEqual(inboundAuth.evaluateInboundAccess(publicReq), { allow: true });

    // 2. Unpaired + LOCAL_ROUTER_REQUIRE_LEASE=1 -> loopback still allowed, remote bridge fails closed 403
    process.env.LOCAL_ROUTER_REQUIRE_LEASE = '1';
    assert.deepEqual(inboundAuth.evaluateInboundAccess(loopbackReq), { allow: true });
    const reqLeaseBlocked = inboundAuth.evaluateInboundAccess(publicReq);
    assert.equal(reqLeaseBlocked.allow, false);
    assert.equal(reqLeaseBlocked.status, 403);
    assert.match(reqLeaseBlocked.body, /not_paired/);

    // 3. Valid ML-DSA-65 lease saved -> remote bridge allowed even under LOCAL_ROUTER_REQUIRE_LEASE=1
    const validSigned = signTestLease(signingKeys, { tier: 'pro' });
    const identity = pqcEnt.ensureDevicePqcIdentity();
    pqcEnt.savePersistedAccountLease({
      schema: 1,
      controlPlaneUrl: 'https://local-router.com',
      deviceId: identity.deviceId,
      email: validSigned.email,
      provider: 'google',
      algorithm: 'ML-DSA-65',
      lease: validSigned.lease,
      signatureB64: validSigned.signatureB64,
      signingPublicKeyB64: validSigned.signingPublicKeyB64,
      signingKeyFingerprint: validSigned.signingKeyFingerprint,
      pairedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    assert.deepEqual(inboundAuth.evaluateInboundAccess(publicReq), { allow: true });

    // 4. Expired lease on disk -> fails closed 403 even when LOCAL_ROUTER_REQUIRE_LEASE is unset
    delete process.env.LOCAL_ROUTER_REQUIRE_LEASE;
    const expiredSigned = signTestLease(signingKeys, {
      tier: 'pro',
      expiresAt: new Date(Date.now() - 60_000).toISOString()
    });
    pqcEnt.savePersistedAccountLease({
      schema: 1,
      controlPlaneUrl: 'https://local-router.com',
      deviceId: identity.deviceId,
      email: expiredSigned.email,
      provider: 'google',
      algorithm: 'ML-DSA-65',
      lease: expiredSigned.lease,
      signatureB64: expiredSigned.signatureB64,
      signingPublicKeyB64: expiredSigned.signingPublicKeyB64,
      signingKeyFingerprint: expiredSigned.signingKeyFingerprint,
      pairedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    assert.deepEqual(inboundAuth.evaluateInboundAccess(loopbackReq), { allow: true });
    const expiredBlocked = inboundAuth.evaluateInboundAccess(publicReq);
    assert.equal(expiredBlocked.allow, false);
    assert.equal(expiredBlocked.status, 403);
    assert.match(expiredBlocked.body, /lease_expired/);
  });
});
