/**
 * pqc-entitlement.ts — Post-Quantum application identity binding & ML-DSA-65
 * entitlement lease verification for running Local Router instances.
 *
 * Mirrors local-router-dot-com/lib/pqc.js byte-for-byte:
 *   - Identity anchor: federated OAuth account (Google / Apple / Microsoft)
 *     paired via short-lived single-use pairing code — zero passwords managed.
 *   - Binding hash (FIPS 202 SHA3-256):
 *       emailHash      = hex(SHA3-256("lr-email-v1:" + normalizeEmail(email)))
 *       devicePubHash  = hex(SHA3-256("lr-mlkem-pub-v1:" || mlKem768PubBytes))
 *       pqcBindingHash = "pqc3:" + hex(SHA3-256(
 *         "lr-app-bind-v1|" + accountId + "|" + emailHash + "|" +
 *         provider + "|" + deviceId + "|" + devicePubHash
 *       ))
 *   - Lease signature (FIPS 204 ML-DSA-65):
 *       signed over "local-router-lease-v1\n" + canonicalSortedJson(lease).
 *   - Renew token custody (FIPS 203 ML-KEM-768 + AES-256-GCM):
 *       stored ONLY in ML-KEM-768-wrapped form at rest and decapsulated in
 *       memory solely when renewing the lease.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDecipheriv, createHash, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';
import { machineConfigPath } from './config-paths';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ml_kem768 } = require('@noble/post-quantum/ml-kem.js') as {
  ml_kem768: {
    keygen: () => { publicKey: Uint8Array; secretKey: Uint8Array };
    decapsulate: (cipherText: Uint8Array, secretKey: Uint8Array) => Uint8Array;
  };
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ml_dsa65 } = require('@noble/post-quantum/ml-dsa.js') as {
  ml_dsa65: {
    verify: (sig: Uint8Array, msg: Uint8Array, publicKey: Uint8Array) => boolean;
  };
};

export const DEFAULT_CONTROL_PLANE_URL = 'https://local-router.com';
export const ML_KEM_PUBLIC_KEY_BYTES = 1184;
export const ML_DSA_PUBLIC_KEY_BYTES = 1952;
export const ML_DSA_SIGNATURE_BYTES = 3309;
const LEASE_DOMAIN_PREFIX = 'local-router-lease-v1\n';
const ML_KEM_Q = 3329;

export interface LeaseEntitlements {
  cloudSync: boolean;
  remoteBridge: boolean;
  maxDevices: number;
  maxBlobs: number;
  maxBlobBytes: number;
}

export interface AppEntitlementLease {
  schema: number;
  issuer: string;
  keyId: string;
  accountId: string;
  provider: string;
  emailHash: string;
  deviceId: string;
  devicePubHash: string;
  pqcBindingHash: string;
  tier: string;
  tierExpiresAt: string | null;
  entitlements: LeaseEntitlements;
  issuedAt: string;
  expiresAt: string;
}

export interface WrappedSecretPayload {
  encapsulationB64: string;
  wrappedB64: string;
  nonceB64: string;
}

export interface PersistedAccountLease {
  schema: 1;
  controlPlaneUrl: string;
  deviceId: string;
  email: string;
  provider: string;
  algorithm: 'ML-DSA-65';
  lease: AppEntitlementLease;
  signatureB64: string;
  signingPublicKeyB64: string;
  signingKeyFingerprint: string;
  wrappedAccessSecret?: WrappedSecretPayload | null;
  pairedAt: string;
  updatedAt: string;
}

export interface DevicePqcIdentity {
  schema: 1;
  deviceId: string;
  algorithm: 'ML-KEM-768';
  publicKeyB64: string;
  secretKeyB64: string;
  devicePubHash: string;
  createdAt: string;
}

export interface LeaseVerificationResult {
  valid: boolean;
  reason?: string;
  lease?: AppEntitlementLease;
}

export interface AccountLeaseStatus {
  paired: boolean;
  valid: boolean;
  reason: string | null;
  requireLease: boolean;
  remoteBridgeEntitled: boolean;
  deviceId: string | null;
  devicePubHash: string | null;
  pqcBindingHash: string | null;
  email: string | null;
  provider: string | null;
  tier: string;
  tierExpiresAt: string | null;
  leaseExpiresAt: string | null;
  entitlements: LeaseEntitlements | null;
  signingKeyFingerprint: string | null;
  controlPlaneUrl: string;
}

export function base64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function base64urlDecode(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(String(text || ''), 'base64url'));
}

function sha3Hex(data: Buffer | Uint8Array | string): string {
  return createHash('sha3-256').update(data).digest('hex');
}

function safeStrEqual(a: string, b: string): boolean {
  const ab = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ab.length !== bb.length) return false;
  return nodeTimingSafeEqual(ab, bb);
}

/** Alias-proof email normalization matching local-router-dot-com/lib/identity.js. */
export function normalizeEmail(email: unknown): string | null {
  const trimmed = String(email ?? '').trim().toLowerCase();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return null;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (!local || !domain || !domain.includes('.')) return null;

  const plus = local.indexOf('+');
  const bareLocal = plus >= 0 ? local.slice(0, plus) : local;
  if (!bareLocal) return null;

  const bareDomain = domain === 'googlemail.com' ? 'gmail.com' : domain;
  const finalLocal = bareDomain === 'gmail.com' ? bareLocal.replace(/\./g, '') : bareLocal;
  if (!finalLocal) return null;

  return `${finalLocal}@${bareDomain}`;
}

/** Structural FIPS 203 check for a canonical 1184-byte ML-KEM-768 public key. */
export function isValidMlKemPublicKeyB64(keyB64: string): boolean {
  try {
    const pk = base64urlDecode(keyB64);
    if (pk.length !== ML_KEM_PUBLIC_KEY_BYTES) return false;
    let nonZero = 0;
    for (let i = 0; i < 1152; i += 3) {
      const b0 = pk[i], b1 = pk[i + 1], b2 = pk[i + 2];
      nonZero |= b0 | b1 | b2;
      const c0 = b0 | ((b1 & 0x0f) << 8);
      const c1 = (b1 >> 4) | (b2 << 4);
      if (c0 >= ML_KEM_Q || c1 >= ML_KEM_Q) return false;
    }
    return nonZero !== 0;
  } catch {
    return false;
  }
}

export function computeEmailHash(email: unknown): string | null {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  return sha3Hex(Buffer.from(`lr-email-v1:${normalized}`, 'utf8'));
}

export function computeDevicePubHash(mlKemPublicKeyB64: string): string | null {
  if (!isValidMlKemPublicKeyB64(mlKemPublicKeyB64)) return null;
  const pk = base64urlDecode(mlKemPublicKeyB64);
  return sha3Hex(Buffer.concat([Buffer.from('lr-mlkem-pub-v1:', 'utf8'), Buffer.from(pk)]));
}

export function computePqcBindingHash(parts: {
  accountId: string;
  emailHash: string;
  provider: string;
  deviceId: string;
  devicePubHash: string;
}): string | null {
  const fields = [parts.accountId, parts.emailHash, parts.provider, parts.deviceId, parts.devicePubHash];
  if (fields.some((v) => typeof v !== 'string' || !v.trim())) return null;
  const material = `lr-app-bind-v1|${fields.map((v) => v.trim()).join('|')}`;
  return `pqc3:${sha3Hex(Buffer.from(material, 'utf8'))}`;
}

export function signingKeyFingerprint(publicKeyBytes: Uint8Array): string {
  return `sha3:${sha3Hex(publicKeyBytes).slice(0, 16)}`;
}

export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalizeJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`).join(',')}}`;
}

export function canonicalLeaseMessage(lease: AppEntitlementLease): Uint8Array {
  return new Uint8Array(Buffer.from(`${LEASE_DOMAIN_PREFIX}${canonicalizeJson(lease)}`, 'utf8'));
}

/** Verify an ML-DSA-65 signed entitlement lease locally (fail-closed). */
export function verifyAppLease(input: {
  lease: AppEntitlementLease | null | undefined;
  signatureB64: string;
  signingPublicKeyB64: string;
  expectedDevicePubHash?: string | null;
  expectedEmail?: string | null;
  now?: Date;
}): LeaseVerificationResult {
  const { lease, signatureB64, signingPublicKeyB64, expectedDevicePubHash = null, expectedEmail = null, now = new Date() } = input;
  if (!lease || typeof lease !== 'object') return { valid: false, reason: 'missing_lease' };
  if (lease.schema !== 1) return { valid: false, reason: 'unsupported_schema' };
  if (typeof signatureB64 !== 'string' || typeof signingPublicKeyB64 !== 'string') {
    return { valid: false, reason: 'missing_signature' };
  }

  let pubKeyBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    pubKeyBytes = base64urlDecode(signingPublicKeyB64);
    sigBytes = base64urlDecode(signatureB64);
  } catch {
    return { valid: false, reason: 'malformed_encoding' };
  }
  if (pubKeyBytes.length !== ML_DSA_PUBLIC_KEY_BYTES || sigBytes.length !== ML_DSA_SIGNATURE_BYTES) {
    return { valid: false, reason: 'invalid_key_or_sig_length' };
  }

  const expectedKeyId = signingKeyFingerprint(pubKeyBytes);
  if (!safeStrEqual(String(lease.keyId || ''), expectedKeyId)) {
    return { valid: false, reason: 'key_id_mismatch' };
  }

  let sigOk = false;
  try {
    sigOk = ml_dsa65.verify(sigBytes, canonicalLeaseMessage(lease), pubKeyBytes);
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { valid: false, reason: 'invalid_signature' };

  const recomputed = computePqcBindingHash({
    accountId: lease.accountId,
    emailHash: lease.emailHash,
    provider: lease.provider,
    deviceId: lease.deviceId,
    devicePubHash: lease.devicePubHash
  });
  if (!recomputed || !safeStrEqual(String(lease.pqcBindingHash || ''), recomputed)) {
    return { valid: false, reason: 'pqc_binding_mismatch' };
  }

  if (expectedDevicePubHash && !safeStrEqual(String(lease.devicePubHash || ''), expectedDevicePubHash)) {
    return { valid: false, reason: 'device_key_mismatch' };
  }

  if (expectedEmail) {
    const expectedHash = computeEmailHash(expectedEmail);
    if (!expectedHash || !safeStrEqual(String(lease.emailHash || ''), expectedHash)) {
      return { valid: false, reason: 'email_mismatch' };
    }
  }

  const expiresMs = Date.parse(String(lease.expiresAt || ''));
  if (!Number.isFinite(expiresMs) || expiresMs <= now.getTime()) {
    return { valid: false, reason: 'lease_expired' };
  }

  return { valid: true, lease };
}

/** Decapsulate an ML-KEM-768 + AES-256-GCM wrapped renew token into process memory. */
export function unwrapSecretWithClientKey(secretKeyB64: string, payload: WrappedSecretPayload): string {
  const sharedSecret = ml_kem768.decapsulate(
    base64urlDecode(payload.encapsulationB64),
    base64urlDecode(secretKeyB64)
  );
  const nonce = Buffer.from(base64urlDecode(payload.nonceB64));
  const combined = Buffer.from(base64urlDecode(payload.wrappedB64));
  if (combined.length < 16) throw new Error('wrapped ciphertext truncated');
  const tag = combined.subarray(combined.length - 16);
  const ciphertext = combined.subarray(0, combined.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(sharedSecret), nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString('utf8');
}

export function deviceIdentityPath(): string {
  return machineConfigPath('device-pqc-identity.json');
}

export function accountLeasePath(): string {
  return machineConfigPath('account-lease.json');
}

export function controlPlaneBaseUrl(override?: string | null): string {
  const raw = (override || process.env.LOCAL_ROUTER_CONTROL_PLANE_URL || DEFAULT_CONTROL_PLANE_URL).trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('invalid control plane URL');
  }
  const isLoopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    throw new Error('control plane URL must use https:// (http:// is allowed for loopback only)');
  }
  return parsed.origin;
}

function defaultPlatformName(): 'macos' | 'windows' | 'linux' {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
}

function defaultDeviceId(devicePubHash: string): string {
  const rawHost = os.hostname().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'local-router';
  return `${rawHost}-${devicePubHash.slice(0, 8)}`;
}

/** Load or generate this machine's persistent ML-KEM-768 pairing identity (0600). */
export function ensureDevicePqcIdentity(): DevicePqcIdentity {
  const filePath = deviceIdentityPath();
  if (fs.existsSync(filePath)) {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as DevicePqcIdentity;
    if (
      parsed &&
      parsed.schema === 1 &&
      typeof parsed.deviceId === 'string' &&
      typeof parsed.publicKeyB64 === 'string' &&
      typeof parsed.secretKeyB64 === 'string' &&
      isValidMlKemPublicKeyB64(parsed.publicKeyB64)
    ) {
      const devicePubHash = computeDevicePubHash(parsed.publicKeyB64)!;
      return { ...parsed, devicePubHash };
    }
  }
  const keys = ml_kem768.keygen();
  const publicKeyB64 = base64urlEncode(keys.publicKey);
  const secretKeyB64 = base64urlEncode(keys.secretKey);
  const devicePubHash = computeDevicePubHash(publicKeyB64)!;
  const identity: DevicePqcIdentity = {
    schema: 1,
    deviceId: defaultDeviceId(devicePubHash),
    algorithm: 'ML-KEM-768',
    publicKeyB64,
    secretKeyB64,
    devicePubHash,
    createdAt: new Date().toISOString()
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  return identity;
}

export function loadPersistedAccountLease(): PersistedAccountLease | null {
  const filePath = accountLeasePath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as PersistedAccountLease;
    if (!parsed || parsed.schema !== 1 || !parsed.lease) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function savePersistedAccountLease(record: PersistedAccountLease): void {
  const filePath = accountLeasePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export function unpairLocalAccount(): boolean {
  const filePath = accountLeasePath();
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

export function isLeaseRequiredForRemoteBridge(): boolean {
  const raw = String(process.env.LOCAL_ROUTER_REQUIRE_LEASE || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/** Evaluate this machine's current PQC pairing & ML-DSA-65 lease validity. */
export function evaluateAccountLeaseStatus(now: Date = new Date()): AccountLeaseStatus {
  const requireLease = isLeaseRequiredForRemoteBridge();
  const defaultUrl = (() => {
    try { return controlPlaneBaseUrl(); } catch { return DEFAULT_CONTROL_PLANE_URL; }
  })();
  const persisted = loadPersistedAccountLease();
  if (!persisted) {
    return {
      paired: false,
      valid: false,
      reason: 'not_paired',
      requireLease,
      remoteBridgeEntitled: !requireLease,
      deviceId: null,
      devicePubHash: null,
      pqcBindingHash: null,
      email: null,
      provider: null,
      tier: 'free',
      tierExpiresAt: null,
      leaseExpiresAt: null,
      entitlements: null,
      signingKeyFingerprint: null,
      controlPlaneUrl: defaultUrl
    };
  }

  let localIdentity: DevicePqcIdentity;
  try {
    localIdentity = ensureDevicePqcIdentity();
  } catch {
    return {
      paired: true,
      valid: false,
      reason: 'device_identity_unavailable',
      requireLease,
      remoteBridgeEntitled: false,
      deviceId: persisted.deviceId || null,
      devicePubHash: null,
      pqcBindingHash: persisted.lease?.pqcBindingHash || null,
      email: persisted.email || null,
      provider: persisted.provider || null,
      tier: persisted.lease?.tier || 'free',
      tierExpiresAt: persisted.lease?.tierExpiresAt || null,
      leaseExpiresAt: persisted.lease?.expiresAt || null,
      entitlements: persisted.lease?.entitlements || null,
      signingKeyFingerprint: persisted.signingKeyFingerprint || null,
      controlPlaneUrl: persisted.controlPlaneUrl || defaultUrl
    };
  }

  const verified = verifyAppLease({
    lease: persisted.lease,
    signatureB64: persisted.signatureB64,
    signingPublicKeyB64: persisted.signingPublicKeyB64,
    expectedDevicePubHash: localIdentity.devicePubHash,
    expectedEmail: persisted.email,
    now
  });

  const remoteBridgeEntitled = verified.valid && Boolean(persisted.lease?.entitlements?.remoteBridge);
  return {
    paired: true,
    valid: verified.valid,
    reason: verified.valid ? null : (verified.reason || 'invalid_lease'),
    requireLease,
    remoteBridgeEntitled,
    deviceId: persisted.deviceId,
    devicePubHash: localIdentity.devicePubHash,
    pqcBindingHash: persisted.lease?.pqcBindingHash || null,
    email: persisted.email,
    provider: persisted.provider,
    tier: verified.valid ? persisted.lease.tier : 'free',
    tierExpiresAt: persisted.lease?.tierExpiresAt || null,
    leaseExpiresAt: persisted.lease?.expiresAt || null,
    entitlements: verified.valid ? persisted.lease.entitlements : null,
    signingKeyFingerprint: persisted.signingKeyFingerprint || null,
    controlPlaneUrl: persisted.controlPlaneUrl || defaultUrl
  };
}

/**
 * Pair this running Local Router instance with local-router.com using a
 * single-use OAuth pairing code (`lrp_...`). Verifies the returned ML-DSA-65
 * signature and SHA3-256 PQC binding hash BEFORE saving to disk.
 */
export async function pairWithControlPlane(options: {
  pairingCode: string;
  email?: string;
  label?: string;
  clientKind?: 'desktop' | 'cli' | 'cloud';
  controlPlaneUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<AccountLeaseStatus> {
  const pairingCode = String(options.pairingCode || '').trim();
  if (!pairingCode.startsWith('lrp_')) {
    throw new Error('pairingCode must start with lrp_ (generate one from https://local-router.com/dashboard)');
  }
  const baseUrl = controlPlaneBaseUrl(options.controlPlaneUrl);
  const identity = ensureDevicePqcIdentity();
  const fetchFn = options.fetchImpl || fetch;

  const res = await fetchFn(`${baseUrl}/api/v1/devices/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pairingCode,
      deviceId: identity.deviceId,
      platform: defaultPlatformName(),
      clientKind: options.clientKind || 'cli',
      label: options.label || os.hostname().slice(0, 80),
      mlKemPublicKey: identity.publicKeyB64
    })
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok || !body.lease || !body.signatureB64 || !body.signingPublicKeyB64) {
    const err = new Error(String(body.error || `pairing failed (HTTP ${res.status})`)) as Error & { status?: number; code?: string };
    err.status = res.status;
    if (body.code) err.code = String(body.code);
    throw err;
  }

  const emailToCheck = options.email || body.email;
  const check = verifyAppLease({
    lease: body.lease as AppEntitlementLease,
    signatureB64: String(body.signatureB64),
    signingPublicKeyB64: String(body.signingPublicKeyB64),
    expectedDevicePubHash: identity.devicePubHash,
    expectedEmail: emailToCheck
  });
  if (!check.valid) {
    throw new Error(`control plane returned an invalid PQC lease (${check.reason})`);
  }

  const nowIso = new Date().toISOString();
  savePersistedAccountLease({
    schema: 1,
    controlPlaneUrl: baseUrl,
    deviceId: identity.deviceId,
    email: String(body.email || options.email || ''),
    provider: String(body.provider || body.lease.provider || 'google'),
    algorithm: 'ML-DSA-65',
    lease: body.lease as AppEntitlementLease,
    signatureB64: String(body.signatureB64),
    signingPublicKeyB64: String(body.signingPublicKeyB64),
    signingKeyFingerprint: String(body.signingKeyFingerprint || body.lease.keyId),
    wrappedAccessSecret: body.wrappedAccessSecret || null,
    pairedAt: nowIso,
    updatedAt: nowIso
  });

  return evaluateAccountLeaseStatus();
}

/** Renew the ML-DSA-65 signed lease by decapsulating the ML-KEM-768 renew token in memory. */
export async function refreshLeaseFromControlPlane(options: {
  fetchImpl?: typeof fetch;
} = {}): Promise<AccountLeaseStatus> {
  const persisted = loadPersistedAccountLease();
  if (!persisted) throw new Error('this Local Router instance is not paired yet');
  if (!persisted.wrappedAccessSecret) {
    throw new Error('no ML-KEM-768 wrapped renew credential stored — re-pair with a fresh pairing code');
  }
  const identity = ensureDevicePqcIdentity();
  const baseUrl = controlPlaneBaseUrl(persisted.controlPlaneUrl);
  const bearerSecret = unwrapSecretWithClientKey(identity.secretKeyB64, persisted.wrappedAccessSecret);
  const fetchFn = options.fetchImpl || fetch;

  const res = await fetchFn(`${baseUrl}/api/v1/devices/lease`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${bearerSecret}`
    },
    body: JSON.stringify({
      deviceId: identity.deviceId,
      mlKemPublicKey: identity.publicKeyB64
    })
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok || !body.lease || !body.signatureB64 || !body.signingPublicKeyB64) {
    const err = new Error(String(body.error || `lease renewal failed (HTTP ${res.status})`)) as Error & { status?: number; code?: string };
    err.status = res.status;
    if (body.code) err.code = String(body.code);
    throw err;
  }

  const check = verifyAppLease({
    lease: body.lease as AppEntitlementLease,
    signatureB64: String(body.signatureB64),
    signingPublicKeyB64: String(body.signingPublicKeyB64),
    expectedDevicePubHash: identity.devicePubHash,
    expectedEmail: persisted.email
  });
  if (!check.valid) {
    throw new Error(`renewed PQC lease failed verification (${check.reason})`);
  }

  savePersistedAccountLease({
    ...persisted,
    lease: body.lease as AppEntitlementLease,
    signatureB64: String(body.signatureB64),
    signingPublicKeyB64: String(body.signingPublicKeyB64),
    signingKeyFingerprint: String(body.signingKeyFingerprint || body.lease.keyId),
    updatedAt: new Date().toISOString()
  });

  return evaluateAccountLeaseStatus();
}
