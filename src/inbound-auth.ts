/**
 * inbound-auth.ts — transport-based inbound access control (2026-11-25).
 *
 * The router was built loopback-only: every local tool (desktop app, VS Code,
 * Claude Code, the real `ollama` CLI) talks to 127.0.0.1 and needs no auth.
 * When the operator exposes the router through a Cloudflare Tunnel (or binds it
 * past loopback), requests arrive that no longer deserve local trust:
 *
 *   - a tunneled request always carries `cf-connecting-ip` (Cloudflare sets it;
 *     cloudflared connects from 127.0.0.1, so the socket address alone is not
 *     enough to distinguish it from a local client);
 *   - a direct non-loopback connection has a non-loopback socket address.
 *
 * Rules, deterministic in code:
 *   1. LOOPBACK requests (no `cf-connecting-ip`, loopback socket) are never
 *      gated — the desktop app and local tools keep working with zero config.
 *   2. PUBLIC requests may ONLY reach the inference allowlist below, and only
 *      with a valid access key (timing-safe compare). Wrong/missing → 401,
 *      nothing configured → 503 (fail closed, never open).
 *   3. EVERYTHING ELSE (dashboard `/config*`, admin `/api/router-settings`,
 *      `/api/config/*`, provider key resolution, sync, logs, any future route)
 *      from a public request → 403 `local access only`, regardless of key.
 *
 * The same evaluator also guards the `/v1/responses` WebSocket upgrade in
 * src/index.ts, which never passes through Express middleware.
 *
 * CORS note: the previous `app.use(cors())` wildcard (`Access-Control-Allow-Origin: *`)
 * let any webpage read loopback admin JSON from the operator's own browser.
 * `inboundCors` replaces it: public responses carry NO CORS headers at all
 * (server-side AI clients never needed them), loopback responses reflect the
 * origin only when it is one of the router's own loopback origins, and
 * credentials are never allowed.
 *
 * Spoofing analysis: `cf-connecting-ip` can be set by a local client, but that
 * only *restricts* the spoofer (loopback → public classification can never
 * unlock anything). A public client cannot remove the header (Cloudflare always
 * sets it) and cannot present a loopback socket address. X-Forwarded-For and
 * friends are deliberately NOT consulted — they are trivially spoofable.
 *
 * The access key itself never appears in this file, in logs, or in any response
 * body; it arrives at runtime via `LOCAL_ROUTER_ACCESS_KEY` or the pqc-secrets
 * vault (see `noteVaultAccessKey`, fed from the bundle sync in src/index.ts).
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** env var / vault name that carries the inbound access key at runtime. */
export const ACCESS_KEY_ENV_VAR = 'LOCAL_ROUTER_ACCESS_KEY';

export type InboundVerdict =
  | { allow: true }
  | { allow: false; status: 401 | 403 | 503; body: string };

/** Fixed rejection bodies — never echo the presented credential. */
const BODY_INVALID_KEY = 'invalid or missing access key';
const BODY_LOCAL_ONLY = 'local access only';
const BODY_NOT_CONFIGURED = 'access key not configured';

/**
 * Addresses that can only originate on this machine. `::ffff:` is stripped
 * first so IPv4-mapped IPv6 forms classify correctly, and the whole 127.0.0.0/8
 * block counts as loopback (a remote host cannot source it; routers drop it).
 */
const LOOPBACK_ADDRESSES = new Set(['::1', '127.0.0.1']);

function normalizeRemoteAddress(raw: unknown): string {
  return String(raw ?? '').trim().toLowerCase().replace(/^::ffff:/, '');
}

export function isLoopbackAddress(raw: unknown): boolean {
  const addr = normalizeRemoteAddress(raw);
  if (!addr) return false;
  return addr.startsWith('127.') || LOOPBACK_ADDRESSES.has(addr);
}

/**
 * Classify by transport. `cf-connecting-ip` presence wins because a tunneled
 * request looks exactly like a loopback one at the socket layer (cloudflared
 * dials 127.0.0.1).
 */
export function classifyRequest(req: Request): 'loopback' | 'public' {
  if (req?.headers?.['cf-connecting-ip']) return 'public';
  return isLoopbackAddress(req?.socket?.remoteAddress) ? 'loopback' : 'public';
}

/**
 * The only paths a public (tunneled / non-loopback) client may reach, and even
 * then only with a valid access key. Adding an entry here is a deliberate
 * decision: an entry is reachable by anyone on the internet who has the key.
 *
 * Matching is exact or `entry + '/'` prefix, so `/api/chatty` never sneaks
 * through the `/api/chat` entry and `/v1x` never sneaks through `/v1`.
 */
export const INFERENCE_PATH_ALLOWLIST: readonly string[] = [
  // OpenAI/Anthropic/agent-harness client surface: /v1/chat/completions,
  // /v1/completions, /v1/embeddings, /v1/models, /v1/messages, /v1/responses,
  // /v1/decisions — the documented remote-client API.
  '/v1',
  // Ollama-native clients (the real `ollama` CLI, Ollama SDKs) hit these:
  '/api/chat',       // ollama chat inference
  '/api/generate',   // ollama generate inference
  '/api/tags',       // ollama model listing
  '/api/show',       // ollama model details (also /api/show/:model)
  '/api/ps',         // ollama running-model status
  '/api/embed',      // ollama embeddings
  '/api/embeddings', // legacy ollama embeddings shape
  '/api/version'     // ollama version handshake (client compatibility checks)
];

/**
 * Path shapes a public client never legitimately sends. The allowlist matches
 * the raw (undecoded, unnormalized) path, and Express does not normalize
 * either — so without this check `/v1/../api/router-settings` or
 * `/v1/%2e%2e/api/router-settings` would satisfy the `/v1` entry. No route
 * resolves to the admin surface from those strings today (and Cloudflare
 * normalizes dot segments at the edge), but the gate must not depend on
 * either fact. Defense in depth: any dot-segment, empty segment, backslash,
 * NUL, or percent-encoded `.`, `/`, `\`, NUL → rejected before the allowlist.
 */
export function isSuspiciousPath(rawPath: unknown): boolean {
  const pathname = String(rawPath ?? '').split('?')[0];
  if (pathname.includes('\\') || pathname.includes('\0')) return true;
  if (/%(2e|2f|5c|00)/i.test(pathname)) return true;
  if (pathname.includes('//')) return true;
  return pathname.split('/').some((segment) => segment === '.' || segment === '..');
}

export function isInferenceAllowlistPath(rawPath: unknown): boolean {
  if (isSuspiciousPath(rawPath)) return false;
  const pathname = String(rawPath ?? '').split('?')[0];
  for (const entry of INFERENCE_PATH_ALLOWLIST) {
    if (pathname === entry || pathname.startsWith(`${entry}/`)) return true;
  }
  return false;
}

/**
 * Timing-safe credential compare. Both sides are hashed to fixed-length
 * digests first: timingSafeEqual throws on length mismatch, and hashing hides
 * the key's length from a probing client.
 */
export function timingSafeKeyMatch(presented: unknown, configured: unknown): boolean {
  const a = typeof presented === 'string' ? presented.trim() : '';
  const b = typeof configured === 'string' ? configured.trim() : '';
  if (!a || !b) return false;
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Access key noted from the pqc-secrets bundle during sync (src/index.ts).
 * `process.env[ACCESS_KEY_ENV_VAR]` always wins; an empty value clears the
 * vault slot so a removed bundle entry stops authenticating after a resync.
 */
let vaultAccessKey: string | null = null;

export function noteVaultAccessKey(value: unknown): void {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  vaultAccessKey = trimmed ? trimmed : null;
}

export function getConfiguredAccessKey(): string | null {
  const envValue = (process.env[ACCESS_KEY_ENV_VAR] ?? '').trim();
  if (envValue) return envValue;
  return vaultAccessKey;
}

/**
 * Credentials a client may present: `Authorization: Bearer <key>` (OpenAI-style)
 * or `x-api-key: <key>` (Anthropic-style). Both candidates are checked; any
 * match authorizes. Non-Bearer Authorization values yield no candidate rather
 * than leaking into the compare.
 */
function presentedAccessKey(req: Request): string[] {
  const candidates: string[] = [];
  const auth = req?.headers?.['authorization'];
  if (typeof auth === 'string' && auth.trim()) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) candidates.push(match[1].trim());
  }
  const xApiKey = req?.headers?.['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey.trim()) {
    candidates.push(xApiKey.trim());
  }
  return candidates;
}

/**
 * Pure gate decision. Loopback always passes. Public requests: unknown paths are
 * 403 before the key is even considered (the admin surface stays closed
 * "regardless of key"); inference paths then require a configured key (503 when
 * none is configured — fail closed) that timing-safe matches (401 otherwise).
 */
export function evaluateInboundAccess(req: Request): InboundVerdict {
  if (classifyRequest(req) === 'loopback') return { allow: true };
  const rawPath = (req as { path?: unknown; url?: unknown }).path
    ?? (req as { url?: unknown }).url
    ?? '';
  if (!isInferenceAllowlistPath(rawPath)) {
    return { allow: false, status: 403, body: BODY_LOCAL_ONLY };
  }
  const configured = getConfiguredAccessKey();
  if (!configured) {
    return { allow: false, status: 503, body: BODY_NOT_CONFIGURED };
  }
  for (const candidate of presentedAccessKey(req)) {
    if (timingSafeKeyMatch(candidate, configured)) return { allow: true };
  }
  return { allow: false, status: 401, body: BODY_INVALID_KEY };
}

function logRejection(req: Request, status: number): void {
  // One sanitized line: method + truncated path only. Never headers, never keys.
  const rawPath = String((req as { path?: unknown; url?: unknown }).path ?? (req as { url?: unknown }).url ?? '');
  console.log(`[inbound-auth] rejected public ${req.method} ${rawPath.slice(0, 120)} -> ${status}`);
}

/** Early Express gate: every route sits below this in src/index.ts. */
export const inboundAccessControl: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const verdict = evaluateInboundAccess(req);
  if (verdict.allow) {
    next();
    return;
  }
  logRejection(req, verdict.status);
  res.setHeader('Cache-Control', 'no-store');
  res.status(verdict.status).json({ error: verdict.body });
};

/**
 * Loopback origins the dashboard may be browsed from. The desktop app's
 * devUrl is the router's own `/config` origin (src-tauri/tauri.conf.json), so
 * the allowlist is exactly the router's own loopback HTTP origins for the
 * effective PORT — nothing else is ever reflected.
 */
export function effectiveRouterPort(): number {
  const parsed = Number.parseInt(process.env.PORT || '11434', 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 11434;
}

export function loopbackAllowedOrigins(port: number = effectiveRouterPort()): string[] {
  return [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`
  ];
}

const PREFLIGHT_ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
// Headers real clients send: OpenAI SDKs (authorization, content-type),
// Anthropic SDKs (x-api-key, anthropic-version), and generic tools.
const PREFLIGHT_ALLOWED_HEADERS = 'Authorization, Content-Type, X-Api-Key, Anthropic-Version, Accept';

/**
 * CORS policy (replaces the wildcard `cors()`):
 *   - PUBLIC responses: no CORS headers at all.
 *   - LOOPBACK responses: `Vary: Origin` always; ACAO reflects the origin only
 *     when allowlisted; credentials never allowed; preflight OPTIONS answered
 *     directly (204) so they never reach routes or rate limiters.
 */
export const inboundCors: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  if (classifyRequest(req) === 'public') {
    next();
    return;
  }
  const origin = req?.headers?.origin;
  const isPreflight = req.method === 'OPTIONS'
    && typeof req?.headers?.['access-control-request-method'] === 'string';
  res.setHeader('Vary', 'Origin');
  if (typeof origin !== 'string' || !origin) {
    // Same-origin dashboard requests and non-browser clients: no CORS needed.
    next();
    return;
  }
  if (!loopbackAllowedOrigins().includes(origin)) {
    // Unknown origin: no ACAO. Answer preflights with a bare 204 so the
    // browser does the blocking instead of leaking a route 404.
    if (isPreflight) {
      res.status(204).end();
      return;
    }
    next();
    return;
  }
  res.setHeader('Access-Control-Allow-Origin', origin);
  if (isPreflight) {
    res.setHeader('Access-Control-Allow-Methods', PREFLIGHT_ALLOWED_METHODS);
    res.setHeader('Access-Control-Allow-Headers', PREFLIGHT_ALLOWED_HEADERS);
    res.setHeader('Access-Control-Max-Age', '600');
    res.status(204).end();
    return;
  }
  next();
};

/**
 * Raw HTTP/1.1 response for a rejected WebSocket upgrade (those bypass Express
 * entirely). Used by handleHttpUpgrade in src/index.ts.
 */
export function inboundUpgradeRejectionResponse(status: 401 | 403 | 503, body: string): string {
  const reason = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Service Unavailable';
  const payload = JSON.stringify({ error: body });
  return [
    `HTTP/1.1 ${status} ${reason}`,
    'Content-Type: application/json',
    'Cache-Control: no-store',
    'Connection: close',
    `Content-Length: ${Buffer.byteLength(payload, 'utf8')}`,
    '',
    '',
    payload
  ].join('\r\n');
}
