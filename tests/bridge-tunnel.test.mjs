import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ml_dsa65 } = require('@noble/post-quantum/ml-dsa.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-bridge-tunnel-test-'));
process.env.LOCAL_ROUTER_CONFIG_DIR = tmpDir;
process.env.LOCAL_ROUTER_MACHINE_ID_OVERRIDE = 'a'.repeat(64);
delete process.env.LOCAL_ROUTER_REQUIRE_LEASE;
delete process.env.LOCAL_ROUTER_ACCESS_KEY;

const pqc = require('../build/pqc-entitlement.js');
const bridge = require('../build/bridge-tunnel.js');

function makeSignedLease(tier, remoteBridge, machineIdHash, identity, siteKeys) {
  const emailHash = pqc.computeEmailHash('operator@gmail.com');
  const pqcBindingHash = pqc.computePqcBindingHash({
    accountId: 'acc-1',
    emailHash,
    provider: 'google',
    deviceId: identity.deviceId,
    devicePubHash: identity.devicePubHash
  });
  const appMachineHash = pqc.computeAppMachineHash({
    appId: 'local-router',
    machineIdHash,
    devicePubHash: identity.devicePubHash
  });
  const keyId = pqc.signingKeyFingerprint(siteKeys.publicKey);
  const lease = {
    schema: 1,
    issuer: 'https://local-router.com',
    keyId,
    accountId: 'acc-1',
    provider: 'google',
    emailHash,
    deviceId: identity.deviceId,
    devicePubHash: identity.devicePubHash,
    pqcBindingHash,
    appId: 'local-router',
    machineIdHash,
    appMachineHash,
    tier,
    tierExpiresAt: null,
    entitlements: {
      cloudSync: true,
      remoteBridge,
      maxDevices: tier === 'free' ? 3 : 10,
      maxBlobs: tier === 'free' ? 3 : 50,
      maxBlobBytes: 262144
    },
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  };
  const sig = ml_dsa65.sign(pqc.canonicalLeaseMessage(lease), siteKeys.secretKey);
  return {
    schema: 1,
    controlPlaneUrl: 'https://local-router.com',
    deviceId: identity.deviceId,
    email: 'operator@gmail.com',
    provider: 'google',
    algorithm: 'ML-DSA-65',
    lease,
    signatureB64: pqc.base64urlEncode(sig),
    signingPublicKeyB64: pqc.base64urlEncode(siteKeys.publicKey),
    signingKeyFingerprint: keyId,
    wrappedAccessSecret: null,
    pairedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

test('hardware machine hash + appMachineHash bind leases to this physical host and gate free-tier remote bridges', () => {
  const identity = pqc.ensureDevicePqcIdentity();
  const hwHash = pqc.getHardwareMachineIdHash();
  assert.equal(hwHash, 'a'.repeat(64));

  const appHash = pqc.computeAppMachineHash({
    appId: 'local-router',
    machineIdHash: hwHash,
    devicePubHash: identity.devicePubHash
  });
  assert.match(appHash, /^app3:[0-9a-f]{64}$/);

  // 1. Free-tier paired lease is refused from starting a remote Cloudflared bridge
  const siteKeys = ml_dsa65.keygen();
  pqc.savePersistedAccountLease(makeSignedLease('free', false, hwHash, identity, siteKeys));
  const freeGate = bridge.canStartRemoteBridge();
  assert.equal(freeGate.allowed, false);
  assert.equal(freeGate.reason, 'tier_upgrade_required');

  // 2. Pro-tier paired lease bound to THIS physical machine is allowed
  pqc.savePersistedAccountLease(makeSignedLease('pro', true, hwHash, identity, siteKeys));
  const proGate = bridge.canStartRemoteBridge();
  assert.equal(proGate.allowed, true);
  assert.equal(proGate.tier, 'pro');
  assert.equal(proGate.machineIdHash, hwHash);
  assert.equal(proGate.appMachineHash, appHash);

  // 3. Cloning that exact Pro lease file onto a DIFFERENT physical machine fails closed
  process.env.LOCAL_ROUTER_MACHINE_ID_OVERRIDE = 'b'.repeat(64);
  const clonedGate = bridge.canStartRemoteBridge();
  assert.equal(clonedGate.allowed, false);
  assert.equal(clonedGate.reason, 'machine_hash_mismatch');
  process.env.LOCAL_ROUTER_MACHINE_ID_OVERRIDE = 'a'.repeat(64);
});

test('bridge tunnel token validation enforces 0600 file custody and rejects whitespace/short junk', () => {
  assert.throws(() => bridge.saveBridgeTunnelToken('short'), /invalid Cloudflare Tunnel token/);
  assert.throws(() => bridge.saveBridgeTunnelToken('token with spaces in it 1234567890'), /invalid Cloudflare Tunnel token/);
  const saved = bridge.saveBridgeTunnelToken('eyJhIjoiMTIzNDU2Nzg5MCIsInQiOiJhYmNkZWZnaGlqa2xtbm9wIn0');
  assert.equal(saved.saved, true);
  assert.equal(bridge.hasSavedBridgeToken(), true);
  assert.equal(bridge.clearBridgeTunnelToken(), true);
  assert.equal(bridge.hasSavedBridgeToken(), false);
});
