/**
 * SSRF egress guard.
 *
 * Every outbound fetch to a custom-provider or live-discovered endpoint is
 * routed through `safeFetch()`, which:
 *   1. Enforces HTTPS for non-loopback upstreams (loopback HTTP is always
 *      allowed for locally registered service backends such as llama.cpp
 *      `llama-server` or Unsloth; any other HTTP is dev-mode only).
 *   2. Resolves the hostname and rejects private/loopback/link-local/
 *      cloud-metadata/ULA destinations.
 *   3. Follows redirects manually, re-validating every hop so a public URL
 *      cannot redirect (30x) to an internal address.
 *
 * This module intentionally has no side effects and no runtime dependencies
 * beyond the Node `dns` and `net` built-ins so it can be unit-tested in
 * isolation.
 */

import { promises as dns } from 'node:dns';
import net from 'node:net';

/** Whether loopback HTTP upstreams are permitted at all. */
const DEV_MODE = process.env.LOCAL_ROUTER_DEV === 'true';

/**
 * IPs / prefixes that must never receive traffic from the proxy. Blocking is
 * applied *after* DNS resolution so hostnames that resolve to these ranges
 * (including DNS-rebinding attacks) are rejected.
 *
 * Private ranges (RFC 1918), loopback, link-local, cloud-metadata
 * (169.254.169.254), and unique-local IPv6 (fc00::/7) are all covered.
 */
const BLOCKED_IPV4_PREFIXES: ReadonlyArray<readonly [number, number]> = [
  [0x0a000000, 0xff000000], // 10.0.0.0/8      (RFC 1918)
  [0xac100000, 0xfff00000], // 172.16.0.0/12   (RFC 1918)
  [0xc0a80000, 0xffff0000], // 192.168.0.0/16  (RFC 1918)
  [0x7f000000, 0xff000000], // 127.0.0.0/8     (loopback)
  [0xa9fe0000, 0xffff0000], // 169.254.0.0/16  (link-local + metadata)
  [0x00000000, 0xff000000], // 0.0.0.0/8       ("this network")
  [0xc6120000, 0xffffff00], // 198.18.0.0/15   (benchmarking)
  [0xc6336400, 0xffffff40], // 192.0.2.0/24    (TEST-NET-1)
  [0xcb007100, 0xffffff00], // 203.0.113.0/24  (TEST-NET-3)
  [0xe0000000, 0xf0000000], // 224.0.0.0/4     (multicast)
  [0xf0000000, 0xf0000000], // 240.0.0.0/4     (reserved)
];

/** Convert a dotted-quad string to a 32-bit unsigned int (or null). */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const octet = Number.parseInt(part, 10);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    result = (result << 8) | octet;
  }
  // `<<` returns int32; coerce to uint32.
  return result >>> 0;
}

/** Is the IPv4 address in a blocked prefix? 169.254.169.254 is included. */
export function isBlockedIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return false;
  return BLOCKED_IPV4_PREFIXES.some(
    ([network, mask]) => (value & mask) >>> 0 === network
  );
}

/** Is the IPv6 address blocked (loopback, link-local, ULA, v4-mapped)? */
export function isBlockedIpv6(ip: string): boolean {
  const lc = ip.toLowerCase();
  if (lc === '::1') return true; // loopback
  if (lc.startsWith('fe80')) return true; // link-local
  if (lc.startsWith('fc') || lc.startsWith('fd')) return true; // ULA fc00::/7
  // IPv4-mapped (::ffff:a.b.c.d) — extract and reuse IPv4 rules.
  const v4MappedMatch = lc.match(/^(?:0*:)*ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4MappedMatch) {
    return isBlockedIpv4(v4MappedMatch[1]);
  }
  if (lc.startsWith('64:ff9b:')) return true; // NAT64 well-known prefix
  return false;
}

/** True for any string-shaped IP that falls in a blocked range. */
export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isBlockedIpv4(ip);
  if (net.isIPv6(ip)) return isBlockedIpv6(ip);
  return false;
}

/** Check if an IP address is loopback (127.0.0.0/8 for IPv4, ::1 for IPv6). */
function isLoopbackIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const value = ipv4ToInt(ip);
    return value !== null && (value & 0xff000000) >>> 0 === 0x7f000000;
  }
  return ip.toLowerCase() === '::1';
}

/**
 * Hostnames that are always considered loopback and therefore exempt from the
 * HTTPS-only rule but still validated through DNS resolution.
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', 'localhost.',]);

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

/** WHATWG URLs keep brackets on IPv6 literals (`[::1]`); strip them for IP checks. */
function normalizeIpv6Hostname(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

/**
 * True for plain-HTTP URLs whose destination is loopback (literal loopback IP
 * or `localhost`). Local service backends registered by the Local Router
 * service shims (llama.cpp `llama-server`, Unsloth) and other loopback custom
 * providers are exempt from the HTTPS-only rule: the destination is the local
 * machine itself and the operator registered the endpoint explicitly.
 * Non-loopback HTTP remains forbidden outside dev mode.
 */
function isLoopbackHttpUrl(hostname: string, protocol: string): boolean {
  const host = normalizeIpv6Hostname(hostname);
  return protocol === 'http:' && (isLoopbackHostname(host) || isLoopbackIp(host));
}

export interface SafeFetchOptions extends RequestInit {
  /** Max redirect hops to follow (default 5). */
  maxRedirects?: number;
}

export class SsrfBlockedError extends Error {
  constructor(
    message: string,
    readonly detail: { hostname?: string; address?: string; url: string }
  ) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

/** Validate the URL scheme/host, throwing SsrfBlockedError on policy violations. */
function assertSchemeAndHost(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`Invalid URL: ${rawUrl}`, { url: rawUrl });
  }

  const { hostname, protocol } = parsed;
  if (protocol === 'http:') {
    // Plain HTTP is always permitted for loopback destinations (local service
    // backends). Any other HTTP is dev-mode only.
    if (!isLoopbackHttpUrl(hostname, protocol)) {
      if (!DEV_MODE) {
        throw new SsrfBlockedError(
          `HTTP upstreams are forbidden; use HTTPS (url=${rawUrl}). ` +
            `Set LOCAL_ROUTER_DEV=true to allow loopback HTTP in development.`,
          { hostname, url: rawUrl }
        );
      }
      if (!isLoopbackHostname(hostname) && !net.isIP(hostname)) {
        throw new SsrfBlockedError(
          `HTTP upstreams are only permitted on loopback in dev mode (url=${rawUrl}).`,
          { hostname, url: rawUrl }
        );
      }
    }
  } else if (protocol !== 'https:') {
    throw new SsrfBlockedError(
      `Unsupported protocol "${protocol}"; only https is allowed (url=${rawUrl}).`,
      { hostname, url: rawUrl }
    );
  }

  return parsed;
}

/** Resolve a hostname and confirm every returned address is safe. */
async function assertSafeResolvedAddress(rawHostname: string, url: string, allowLoopback = false): Promise<void> {
  const hostname = normalizeIpv6Hostname(rawHostname);
  // Literal IPs bypass DNS but still need blocklist checks.
  if (net.isIP(hostname)) {
    // Allow loopback IPs for dev mode and for loopback-HTTP service URLs.
    if ((DEV_MODE || allowLoopback) && isLoopbackIp(hostname)) return;
    if (isBlockedIp(hostname)) {
      throw new SsrfBlockedError(
        `Resolved/literal address ${hostname} is in a blocked range.`,
        { hostname, address: hostname, url }
      );
    }
    return;
  }

  let addresses: string[];
  try {
    // lookup() returns all A/AAAA records; we validate *all* of them because
    // an attacker can return a mix of benign + internal addresses.
    const records = await dns.lookup(hostname, { all: true });
    addresses = records.map((r) => r.address);
  } catch (err) {
    throw new SsrfBlockedError(
      `Could not resolve hostname "${hostname}" (${(err as Error).message}).`,
      { hostname, url }
    );
  }

  if (addresses.length === 0) {
    throw new SsrfBlockedError(
      `Hostname "${hostname}" did not resolve to any address.`,
      { hostname, url }
    );
  }

  for (const address of addresses) {
    // Allow loopback addresses for dev mode and loopback-HTTP service URLs.
    if ((DEV_MODE || allowLoopback) && isLoopbackIp(address)) continue;
    if (isBlockedIp(address)) {
      throw new SsrfBlockedError(
        `Hostname "${hostname}" resolves to blocked address ${address}.`,
        { hostname, address, url }
      );
    }
  }
}

/**
 * Validate that a URL is safe to fetch. Public entry point reused by callers
 * that perform their own fetch (e.g. when they need streaming or custom
 * options the wrapper cannot express).
 */
export async function assertSafeUpstreamUrl(rawUrl: string): Promise<void> {
  const parsed = assertSchemeAndHost(rawUrl);
  const allowLoopback = isLoopbackHttpUrl(parsed.hostname, parsed.protocol);
  await assertSafeResolvedAddress(parsed.hostname, rawUrl, allowLoopback);
}

/**
 * Fetch wrapper that validates the URL, then follows redirects manually,
 * re-running the SSRF check at every hop. A public URL that 30x-redirects to
 * an internal IP is therefore rejected.
 */
export async function safeFetch(
  input: string,
  options: SafeFetchOptions = {}
): Promise<Response> {
  const { maxRedirects = 5, ...fetchOptions } = options;
  let currentUrl = input;
  let redirects = 0;

  // Re-validate scheme/host and resolved address on every hop.
  for (;;) {
    await assertSafeUpstreamUrl(currentUrl);

    const response = await fetch(currentUrl, fetchOptions);
    if (!response.redirected || redirects >= maxRedirects) {
      return response;
    }

    const locationHeader = response.headers.get('location');
    if (!locationHeader) {
      // Claimed a redirect but no Location header — return as-is.
      return response;
    }

    redirects += 1;
    // Resolve relative redirects against the current URL.
    currentUrl = new URL(locationHeader, currentUrl).toString();
  }
}
