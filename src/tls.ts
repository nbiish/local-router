/**
 * TLS / HTTPS listener support for Local Router.
 *
 * Some strict client tooling refuses plain-HTTP endpoints and refuses to accept
 * base URLs containing `http://`, `localhost`, or `127.0.0.1`. Local Router can
 * additionally serve HTTPS on a dedicated port so those tools can be pointed at
 * an `https://` URL with a friendly hostname while the standard loopback HTTP
 * listener on 11434 keeps serving every existing drop-in client.
 *
 * Contract (see llms.txt "TLS / HTTPS Listener Contract"):
 * - `LOCAL_ROUTER_TLS=true` enables the HTTPS listener (default off).
 * - `LOCAL_ROUTER_TLS_PORT` (default 11443 — 11434 + the classic 443 suffix).
 * - `LOCAL_ROUTER_TLS_HOSTNAME` (default `local-router.local`) is baked into the
 *   certificate SANs so `https://<hostname>:<port>` verifies once a hosts entry
 *   maps it to loopback.
 * - `local-router.localtest.me` (public wildcard DNS -> loopback) is always a
 *   SAN too, giving a zero-configuration hostname that contains neither
 *   "localhost" nor a loopback IP literal.
 * - `LOCAL_ROUTER_TLS_CERT` / `LOCAL_ROUTER_TLS_KEY` point at operator-supplied
 *   PEM pairs (e.g. mkcert output); when unset, a self-signed RSA-2048/SHA-256
 *   certificate is generated once into `~/.config/local-router/tls/`.
 *
 * The generated material is transport-only (standard TLS; never used for
 * secrets operations, which stay PQC per AGENTS.md). The private key is written
 * mode 0600 and never leaves the machine.
 */

import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';

// Lazy require: selfsigned v5 is async and only needed when generating.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const selfsigned = require('selfsigned') as {
  generate(attrs: Array<{ name: string; value: string }> | null, opts: Record<string, unknown>): Promise<{
    private: string;
    public: string;
    cert: string;
    fingerprint: string;
  }>;
};

export const DEFAULT_TLS_PORT = 11443;
export const DEFAULT_TLS_HOSTNAME = 'local-router.local';
/** Public wildcard DNS name that resolves to loopback — zero-config alias. */
export const ZERO_CONFIG_HOSTNAME = 'local-router.localtest.me';
const DEFAULT_TLS_DIR = path.join(os.homedir(), '.config', 'local-router', 'tls');
const CERT_FILE = 'local-router-cert.pem';
const KEY_FILE = 'local-router-key.pem';
const META_FILE = 'tls-meta.json';

function tlsDir(env: NodeJS.ProcessEnv): string {
  const custom = env.LOCAL_ROUTER_TLS_DIR?.trim();
  return custom || DEFAULT_TLS_DIR;
}
/** Self-signed dev material: 825 days (long-lived but not absurd). */
const VALIDITY_DAYS = 825;
/** Regenerate auto-managed certs that expire within 30 days. */
const REGEN_MARGIN_DAYS = 30;

export type TlsSettings = {
  enabled: boolean;
  port: number;
  hostname: string;
  certPath: string;
  keyPath: string;
  operatorSupplied: boolean;
};

export type TlsMaterial = {
  key: string;
  cert: string;
  certPath: string;
  keyPath: string;
  hostname: string;
  sans: string[];
  generated: boolean;
  validTo: string | null;
};

function envTrue(value: string | undefined): boolean {
  return value === 'true' || value === '1' || value === 'yes';
}

function validPort(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function validHostname(raw: string | undefined): string {
  const trimmed = String(raw ?? '').trim().toLowerCase();
  // RFC 1123 hostname labels: letters, digits, hyphens, dots; no leading/trailing dot/hyphen.
  if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(trimmed)) {
    return trimmed;
  }
  return DEFAULT_TLS_HOSTNAME;
}

export function resolveTlsSettings(env: NodeJS.ProcessEnv = process.env): TlsSettings {
  const certPath = env.LOCAL_ROUTER_TLS_CERT?.trim();
  const keyPath = env.LOCAL_ROUTER_TLS_KEY?.trim();
  const operatorSupplied = Boolean(certPath && keyPath);
  return {
    enabled: envTrue(env.LOCAL_ROUTER_TLS),
    port: validPort(env.LOCAL_ROUTER_TLS_PORT, DEFAULT_TLS_PORT),
    hostname: validHostname(env.LOCAL_ROUTER_TLS_HOSTNAME),
    certPath: certPath || path.join(tlsDir(env), CERT_FILE),
    keyPath: keyPath || path.join(tlsDir(env), KEY_FILE),
    operatorSupplied,
  };
}

export function isTlsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveTlsSettings(env).enabled;
}

/** Every non-internal IPv4 address of this machine (so LAN clients can verify too). */
export function lanIpv4Addresses(): string[] {
  const found: string[] = [];
  try {
    for (const infos of Object.values(os.networkInterfaces())) {
      for (const info of infos ?? []) {
        if (info.family === 'IPv4' && !info.internal && !found.includes(info.address)) {
          found.push(info.address);
        }
      }
    }
  } catch {
    // Interface enumeration is best-effort only.
  }
  return found;
}

export function collectSubjectAltNames(hostname: string): string[] {
  const names = new Set<string>();
  // DNS names (type 2 semantics; kept as plain strings here).
  names.add('localhost');
  names.add(hostname);
  names.add(ZERO_CONFIG_HOSTNAME);
  // Loopback IP literals.
  names.add('127.0.0.1');
  names.add('::1');
  for (const ip of lanIpv4Addresses()) {
    names.add(ip);
  }
  return Array.from(names);
}

type TlsMeta = {
  hostname: string;
  sans: string[];
  generatedAt: string;
  validTo: string;
};

function readMeta(metaPath: string): TlsMeta | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as TlsMeta;
    return parsed && typeof parsed.hostname === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function certNotAfter(certPem: string): Date | null {
  try {
    // node:crypto X509Certificate — available since Node 15.6.
    const { X509Certificate } = require('node:crypto');
    return new Date(new X509Certificate(certPem).validTo);
  } catch {
    return null;
  }
}

/**
 * Load (or generate) the TLS keypair. Operator-supplied paths are used as-is;
 * auto-managed material regenerates when missing, unparseable, near expiry, or
 * when the configured hostname is no longer covered by the SAN set.
 */
export async function ensureTlsMaterial(settings: TlsSettings = resolveTlsSettings()): Promise<TlsMaterial> {
  if (settings.operatorSupplied) {
    const key = fs.readFileSync(settings.keyPath, 'utf8');
    const cert = fs.readFileSync(settings.certPath, 'utf8');
    return {
      key,
      cert,
      certPath: settings.certPath,
      keyPath: settings.keyPath,
      hostname: settings.hostname,
      sans: collectSubjectAltNames(settings.hostname),
      generated: false,
      validTo: certNotAfter(cert)?.toISOString() ?? null,
    };
  }

  fs.mkdirSync(path.dirname(settings.certPath), { recursive: true });
  const metaPath = path.join(path.dirname(settings.certPath), META_FILE);
  const existingKey = safeRead(settings.keyPath);
  const existingCert = safeRead(settings.certPath);
  const meta = readMeta(metaPath);
  const notAfter = existingCert ? certNotAfter(existingCert) : null;
  const expiringSoon = notAfter
    ? notAfter.getTime() - Date.now() < REGEN_MARGIN_DAYS * 24 * 60 * 60 * 1000
    : false;
  const sans = collectSubjectAltNames(settings.hostname);
  const hostnameChanged = !meta
    || meta.hostname !== settings.hostname
    || JSON.stringify(meta.sans ?? []) !== JSON.stringify(sans);

  if (existingKey && existingCert && notAfter && !expiringSoon && !hostnameChanged) {
    return {
      key: existingKey,
      cert: existingCert,
      certPath: settings.certPath,
      keyPath: settings.keyPath,
      hostname: settings.hostname,
      sans,
      generated: false,
      validTo: notAfter.toISOString(),
    };
  }

  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: settings.hostname }],
    {
      keyType: 'rsa',
      keySize: 2048,
      algorithm: 'sha256',
      notBeforeDate: new Date(Date.now() - 60 * 60 * 1000), // clock-skew headroom
      notAfterDate: new Date(Date.now() + VALIDITY_DAYS * 24 * 60 * 60 * 1000),
      extensions: [
        { name: 'basicConstraints', cA: false, critical: true },
        {
          name: 'keyUsage',
          digitalSignature: true,
          keyEncipherment: true,
          critical: true,
        },
        { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
        {
          name: 'subjectAltName',
          altNames: sans.map((value) => (net_isIp(value)
            ? { type: 7, ip: value }
            : { type: 2, value })),
        },
      ],
    }
  );

  fs.writeFileSync(settings.keyPath, pems.private, { mode: 0o600 });
  fs.writeFileSync(settings.certPath, pems.cert, { mode: 0o644 });
  try {
    fs.chmodSync(settings.keyPath, 0o600);
  } catch {
    // Windows ignores POSIX modes; not fatal.
  }
  const validTo = certNotAfter(pems.cert);
  const newMeta: TlsMeta = {
    hostname: settings.hostname,
    sans,
    generatedAt: new Date().toISOString(),
    validTo: validTo ? validTo.toISOString() : '',
  };
  fs.writeFileSync(metaPath, `${JSON.stringify(newMeta, null, 2)}\n`, { mode: 0o600 });

  return {
    key: pems.private,
    cert: pems.cert,
    certPath: settings.certPath,
    keyPath: settings.keyPath,
    hostname: settings.hostname,
    sans,
    generated: true,
    validTo: newMeta.validTo || null,
  };
}

function net_isIp(value: string): boolean {
  return value.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(value);
}

function safeRead(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Create the HTTPS server pair (IPv4 + IPv6 loopback, mirroring the HTTP
 * dual-stack bind). Returns null when TLS is disabled. Does NOT listen —
 * callers own binding and logging so startup ordering stays in index.ts.
 */
export async function createTlsServers(
  app: Express,
  settings: TlsSettings = resolveTlsSettings()
): Promise<{ servers: https.Server[]; material: TlsMaterial } | null> {
  if (!settings.enabled) {
    return null;
  }
  const material = await ensureTlsMaterial(settings);
  const options: https.ServerOptions = {
    key: material.key,
    cert: material.cert,
    minVersion: 'TLSv1.2',
  };
  return { servers: [https.createServer(options, app), https.createServer(options, app)], material };
}

/** Friendly, ready-to-paste endpoint list for banners and the CLI. */
export function tlsEndpointHints(settings: TlsSettings, sans: string[]): string[] {
  const lanIps = sans.filter((value) => /^\d{1,3}(\.\d{1,3}){3}$/.test(value) && value !== '127.0.0.1');
  const hints = [
    `https://localhost:${settings.port}`,
    `https://${ZERO_CONFIG_HOSTNAME}:${settings.port}`,
    `https://${settings.hostname}:${settings.port}`,
  ];
  for (const ip of lanIps) {
    hints.push(`https://${ip}:${settings.port}`);
  }
  return hints;
}
