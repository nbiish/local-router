/**
 * Local backend endpoint policy.
 *
 * Standard local backends (llama.cpp `llama-server`, Unsloth Studio) are
 * detected at the operator's own loopback endpoint and never started by Local
 * Router. Their keys — Unsloth's `sk-unsloth-…` bearer token in particular —
 * must never leave the machine: a provider record edited to point at a public
 * host must be refused before any request is made, not "proxied securely".
 */

import net from 'node:net';

/** True for http(s) URLs whose destination is loopback (127.0.0.0/8, ::1, localhost). */
export function isLoopbackEndpointUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host === '::1') return true;
  if (net.isIP(host) === 4) return host.startsWith('127.');
  return false;
}

/** Key egress is allowed only when the endpoint is loopback. */
export function localBackendKeyEgressAllowed(endpoint: string): boolean {
  return isLoopbackEndpointUrl(endpoint);
}
