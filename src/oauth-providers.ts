import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';

/**
 * OAuth / subscription-based provider support for Local Router.
 *
 * Antigravity uses OAuth 2.0 + PKCE (browser-based flow with local callback).
 * GitHub Copilot uses the OAuth device flow (RFC 8628) plus an extra
 * token-exchange step that turns the long-lived GitHub token into a
 * short-lived Copilot API token.
 *
 * Credentials are persisted at
 *   ~/.config/local-router/oauth-credentials.json
 * (owner-readable only). The PQC bundle is intentionally NOT used because
 * the existing `secrets.bundle.json` format is a flat map of string keys;
 * OAuth tokens need structured fields (expiresAt, accountId, refreshToken)
 * and a small JSON file fits them better. Tokens never leave the local
 * filesystem except in the Authorization header on outbound requests.
 */

export type OAuthProviderId = 'antigravity' | 'github-copilot';

export type OAuthProviderState = {
  provider: OAuthProviderId;
  authType: 'oauth-pkce' | 'oauth-device';
  /** Long-lived refresh / GitHub token. For Antigravity this is the Google
   *  refresh token; for Copilot this is the `gho_*` / `ghu_*` GitHub token. */
  refreshToken: string;
  /** Short-lived access / API token used on every upstream request. */
  accessToken: string;
  /** Unix-ms expiry of the access token. */
  expiresAt: number;
  /** Stable account identifier (Google `sub`, GitHub numeric id). Used to
   *  dedup duplicate credentials rows (oh-my-pi PR #1210). */
  accountId?: string;
  /** Human-readable account label for the UI (email or login). */
  accountLabel?: string;
  /** Last successful refresh timestamp (unix-ms). */
  lastRefreshedAt?: number;
};

export type OAuthProviderSummary = {
  provider: OAuthProviderId;
  authType: 'oauth-pkce' | 'oauth-device';
  displayName: string;
  configured: boolean;
  expiresAt?: number;
  accountId?: string;
  accountLabel?: string;
  modelCount: number;
  lastRefreshedAt?: number;
  /** Set if there is a pending device-code login the user must complete. */
  pendingDeviceCode?: {
    userCode: string;
    verificationUri: string;
    expiresAt: number;
    interval: number;
  };
};

const OAUTH_STORE_DIR = path.join(os.homedir(), '.config', 'local-router');
export const OAUTH_STORE_PATH = path.join(OAUTH_STORE_DIR, 'oauth-credentials.json');

/** Public, well-known OAuth client IDs. Antigravity is Google's own
 *  publicly-distributed desktop client; Copilot's is the same VS Code
 *  Copilot Chat client that GitHub ships, reused by every third-party
 *  integration. They are not org-specific. */
const ANTIGRAVITY_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const ANTIGRAVITY_CLIENT_SECRET = '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';
const ANTIGRAVITY_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const ANTIGRAVITY_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ANTIGRAVITY_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'openid'
];
const ANTIGRAVITY_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const ANTIGRAVITY_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const ANTIGRAVITY_DISPLAY_NAME = 'Google Antigravity';

const GITHUB_COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_OAUTH_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';
const COPILOT_TOKEN_EXCHANGE_URL = 'https://api.github.com/copilot_internal/v2/token';
const COPILOT_BASE_URL = 'https://api.githubcopilot.com';
const COPILOT_DISPLAY_NAME = 'GitHub Copilot';
const GITHUB_OAUTH_SCOPES = 'read:user';

type OAuthStore = Partial<Record<OAuthProviderId, OAuthProviderState>>;

const PROVIDER_CONFIG: Record<OAuthProviderId, {
  authType: 'oauth-pkce' | 'oauth-device';
  displayName: string;
  baseUrl: string;
  headers?: () => Record<string, string>;
}> = {
  antigravity: {
    authType: 'oauth-pkce',
    displayName: ANTIGRAVITY_DISPLAY_NAME,
    baseUrl: ANTIGRAVITY_BASE_URL
  },
  'github-copilot': {
    authType: 'oauth-device',
    displayName: COPILOT_DISPLAY_NAME,
    baseUrl: COPILOT_BASE_URL,
    headers: () => ({
      'Copilot-Integration-Id': 'vscode-chat',
      'Editor-Version': 'vscode/1.99.0',
      'Editor-Plugin-Version': 'copilot-chat/0.26.7',
      'User-Agent': 'GitHubCopilotChat/0.26.7',
      'openai-intent': 'conversation-panel',
      'x-github-api-version': '2025-04-01'
    })
  }
};

const DEVICE_FLOW_PENDING: Partial<Record<OAuthProviderId, OAuthProviderSummary['pendingDeviceCode']>> = {};

// ---------------------------------------------------------------------------
// Concurrent refresh deduplication
// ---------------------------------------------------------------------------

/**
 * In-flight refresh promises keyed by provider. When two requests arrive
 * simultaneously and the token is expired, both would otherwise race the
 * refresh endpoint — the second call would see a rotated refresh_token
 * (Google rotates on every refresh) and fail. Sharing the in-flight promise
 * (oh-my-pi pattern from `getVertexAccessToken` in
 * packages/ai/src/providers/google-auth.ts) means a single refresh serves
 * all concurrent callers.
 */
const REFRESH_INFLIGHT = new Map<OAuthProviderId, Promise<OAuthProviderState>>();

/** Bound the shared refresh slot: a hung OAuth exchange must not pin the
 *  inflight slot forever — every later call would await the stuck promise
 *  until process restart. */
const REFRESH_TIMEOUT_MS = 30_000;

/** In-flight Antigravity PKCE logins tracked by `state` token. */
type AntigravityPendingLogin = {
  init: AntigravityLoginInit;
  resolve: (value: { code: string }) => void;
  reject: (error: Error) => void;
  promise: Promise<{ code: string }>;
};

const ANTIGRAVITY_PENDING = new Map<string, AntigravityPendingLogin>();
let antigravityCallbackServer: http.Server | null = null;
let antigravityCallbackPort = 51121;

function ensureAntigravityCallbackServer(): void {
  if (antigravityCallbackServer) return;
  antigravityCallbackServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== '/oauth-callback') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      const error = url.searchParams.get('error');
      if (error) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<h1>OAuth error</h1><p>${error}</p><p>You may close this window.</p>`);
        const state = url.searchParams.get('state');
        if (state) {
          const pending = ANTIGRAVITY_PENDING.get(state);
          if (pending) {
            pending.reject(new Error(`Antigravity OAuth error: ${error}`));
            ANTIGRAVITY_PENDING.delete(state);
          }
        }
        return;
      }
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      if (!state || !code) {
        res.statusCode = 400;
        res.end('missing state or code');
        return;
      }
      const pending = ANTIGRAVITY_PENDING.get(state);
      if (pending) {
        pending.resolve({ code });
        ANTIGRAVITY_PENDING.delete(state);
        // Auto-complete the login: exchange the code for tokens and persist.
        // The browser will be redirected back to the config UI.
        const init = pending.init;
        Promise.resolve()
          .then(() => completeAntigravityLogin(init))
          .then((state2) => {
            console.log(`[oauth] antigravity login complete for ${state2.accountLabel || state2.accountId || 'user'}`);
          })
          .catch((err) => {
            console.error('[oauth] antigravity auto-complete failed:', err?.message || err);
          });
      }
      // Redirect the browser back to the Local Router config UI. The UI
      // will auto-refresh the OAuth status panel to reflect the new login.
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.statusCode = 302;
      res.setHeader('Location', '/config/providers');
      res.end('<h1>Antigravity login complete</h1><p>Redirecting to the Local Router configuration...</p>');
    } catch (err) {
      res.statusCode = 500;
      res.end('internal error');
    }
  });
}

function loadStore(): OAuthStore {
  try {
    if (!fs.existsSync(OAUTH_STORE_PATH)) return {};
    const raw = fs.readFileSync(OAUTH_STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as OAuthStore;
  } catch (error) {
    console.error('[oauth] failed to load oauth credentials store', error);
  }
  return {};
}

function saveStore(store: OAuthStore): void {
  fs.mkdirSync(OAUTH_STORE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(OAUTH_STORE_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(OAUTH_STORE_PATH, 0o600);
  } catch {
    /* best-effort, not all platforms support chmod */
  }
}

function sanitizeProviderId(input: string): OAuthProviderId {
  const trimmed = String(input || '').trim().toLowerCase();
  if (trimmed === 'antigravity' || trimmed === 'github-copilot') {
    return trimmed;
  }
  throw new Error(`Unknown OAuth provider: ${input}`);
}

export function isOAuthProvider(name: string): boolean {
  return name === 'antigravity' || name === 'github-copilot';
}

export function listOAuthProviders(): OAuthProviderId[] {
  return ['antigravity', 'github-copilot'];
}

export function getOAuthProviderConfig(provider: OAuthProviderId) {
  return PROVIDER_CONFIG[provider];
}

export function getOAuthState(provider: OAuthProviderId): OAuthProviderState | undefined {
  return loadStore()[provider];
}

export function getOAuthStatus(provider: OAuthProviderId): OAuthProviderSummary {
  const state = getOAuthState(provider);
  const config = PROVIDER_CONFIG[provider];
  const pendingDeviceCode = DEVICE_FLOW_PENDING[provider];
  return {
    provider,
    authType: config.authType,
    displayName: config.displayName,
    configured: Boolean(state?.accessToken),
    expiresAt: state?.expiresAt,
    accountId: state?.accountId,
    accountLabel: state?.accountLabel,
    modelCount: 0,
    lastRefreshedAt: state?.lastRefreshedAt,
    pendingDeviceCode
  };
}

function persistState(state: OAuthProviderState): void {
  const store = loadStore();
  store[state.provider] = state;
  saveStore(store);
}

export function clearOAuthCredentials(provider: OAuthProviderId): void {
  const store = loadStore();
  delete store[provider];
  saveStore(store);
  delete DEVICE_FLOW_PENDING[provider];
}

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

function isTokenExpiringSoon(state: OAuthProviderState, leewayMs = 5 * 60_000): boolean {
  return state.expiresAt - leewayMs <= Date.now();
}

/**
 * Returns a currently-valid access token for the given OAuth provider.
 * Refreshes the access token transparently when expired or close to expiry.
 */
export async function getOAuthAccessToken(provider: OAuthProviderId): Promise<string> {
  const state = getOAuthState(provider);
  if (!state) {
    throw new Error(`OAuth provider "${provider}" is not configured. Login first.`);
  }
  if (!isTokenExpiringSoon(state)) {
    return state.accessToken;
  }
  const refreshed = await refreshOAuthToken(provider);
  return refreshed.accessToken;
}

export async function refreshOAuthToken(provider: OAuthProviderId): Promise<OAuthProviderState> {
  // Share the in-flight refresh promise across concurrent callers.
  // See REFRESH_INFLIGHT comment above for the rationale.
  const existing = REFRESH_INFLIGHT.get(provider);
  if (existing) return existing;
  const promise = (async () => {
    try {
      const state = getOAuthState(provider);
      if (!state) {
        throw new Error(`OAuth provider "${provider}" is not configured.`);
      }
      let next: OAuthProviderState;
      if (state.authType === 'oauth-pkce') {
        next = await refreshAntigravityToken(state);
      } else {
        next = await refreshCopilotToken(state);
      }
      next.lastRefreshedAt = Date.now();
      persistState(next);
      return next;
    } finally {
      REFRESH_INFLIGHT.delete(provider);
    }
  })();
  // Bound the shared slot: a hung refresh must not pin the inflight entry
  // forever. If the timeout fires, reject the shared promise and clean up.
  const guarded = Promise.race<OAuthProviderState>([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`OAuth refresh for ${provider} timed out after ${REFRESH_TIMEOUT_MS}ms`)),
        REFRESH_TIMEOUT_MS,
      ),
    ),
  ]);
  REFRESH_INFLIGHT.set(provider, guarded);
  return guarded;
}

/** Test seam: clears every in-flight refresh promise. */
export function __resetRefreshInflight(): void {
  REFRESH_INFLIGHT.clear();
}

// ---------------------------------------------------------------------------
// Antigravity PKCE flow
// ---------------------------------------------------------------------------

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function buildAntigravityAuthUrl(redirectUri: string, state: string, challenge: string): string {
  const url = new URL(ANTIGRAVITY_AUTH_URL);
  url.searchParams.set('client_id', ANTIGRAVITY_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', ANTIGRAVITY_SCOPES.join(' '));
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  return url.toString();
}

async function exchangeAntigravityCode(params: {
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<{ access: string; refresh: string; expiresIn: number; idToken?: string }> {
  const body = new URLSearchParams({
    client_id: ANTIGRAVITY_CLIENT_ID,
    code: params.code,
    grant_type: 'authorization_code',
    redirect_uri: params.redirectUri,
    code_verifier: params.verifier
  });
  if (ANTIGRAVITY_CLIENT_SECRET) {
    body.set('client_secret', ANTIGRAVITY_CLIENT_SECRET);
  }
  const res = await fetch(ANTIGRAVITY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Antigravity token exchange failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = await res.json() as any;
  if (!data.access_token) {
    throw new Error('Antigravity token exchange returned no access_token');
  }
  return {
    access: data.access_token,
    refresh: data.refresh_token || '',
    expiresIn: Number(data.expires_in) || 3600,
    idToken: data.id_token
  };
}

async function fetchAntigravityUserInfo(accessToken: string): Promise<{ sub: string; email?: string }> {
  try {
    const res = await fetch(ANTIGRAVITY_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000)
    });
    if (!res.ok) return { sub: '' };
    const data = await res.json() as any;
    return { sub: String(data.sub || ''), email: data.email ? String(data.email) : undefined };
  } catch {
    return { sub: '' };
  }
}

async function refreshAntigravityToken(state: OAuthProviderState): Promise<OAuthProviderState> {
  if (!state.refreshToken) {
    throw new Error('Antigravity refresh token missing — re-login required.');
  }
  const body = new URLSearchParams({
    client_id: ANTIGRAVITY_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: state.refreshToken
  });
  if (ANTIGRAVITY_CLIENT_SECRET) {
    body.set('client_secret', ANTIGRAVITY_CLIENT_SECRET);
  }
  const res = await fetch(ANTIGRAVITY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Antigravity token refresh failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = await res.json() as any;
  if (!data.access_token) {
    throw new Error('Antigravity token refresh returned no access_token');
  }
  return {
    ...state,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || state.refreshToken,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000
  };
}

export type AntigravityLoginInit = {
  authUrl: string;
  redirectUri: string;
  state: string;
  verifier: string;
};

export function initAntigravityLogin(): AntigravityLoginInit {
  ensureAntigravityCallbackServer();
  const { verifier, challenge } = generatePkcePair();
  const state = base64url(randomBytes(16));
  const redirectUri = `http://127.0.0.1:${antigravityCallbackPort}/oauth-callback`;
  const authUrl = buildAntigravityAuthUrl(redirectUri, state, challenge);
  const entry: AntigravityPendingLogin = {
    init: { authUrl, redirectUri, state, verifier },
    resolve: () => {},
    reject: () => {},
    promise: Promise.resolve({ code: '' })
  };
  entry.promise = new Promise<{ code: string }>((resolve, reject) => {
    entry.resolve = resolve;
    entry.reject = reject;
  });
  // Prevent unhandled promise rejection crash
  entry.promise.catch(() => {});
  ANTIGRAVITY_PENDING.set(state, entry);
  // Auto-expire pending logins after 5 minutes.
  setTimeout(() => {
    const pending = ANTIGRAVITY_PENDING.get(state);
    if (pending) {
      pending.reject(new Error('Antigravity OAuth callback timed out'));
      ANTIGRAVITY_PENDING.delete(state);
    }
  }, 5 * 60_000);
  return { authUrl, redirectUri, state, verifier };
}

export async function waitForAntigravityCode(state: string, timeoutMs = 5 * 60_000): Promise<{ code: string }> {
  const pending = ANTIGRAVITY_PENDING.get(state);
  if (!pending) {
    throw new Error('Antigravity login session expired or unknown state token.');
  }
  return Promise.race([
    pending.promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Antigravity OAuth callback timed out')), timeoutMs))
  ]);
}

export async function completeAntigravityLogin(init: AntigravityLoginInit): Promise<OAuthProviderState> {
  const callback = await waitForAntigravityCode(init.state);
  const tokens = await exchangeAntigravityCode({
    code: callback.code,
    verifier: init.verifier,
    redirectUri: init.redirectUri
  });
  const user = await fetchAntigravityUserInfo(tokens.access);
  const state: OAuthProviderState = {
    provider: 'antigravity',
    authType: 'oauth-pkce',
    accessToken: tokens.access,
    refreshToken: tokens.refresh,
    expiresAt: Date.now() + tokens.expiresIn * 1000,
    accountId: user.sub || undefined,
    accountLabel: user.email,
    lastRefreshedAt: Date.now()
  };
  persistState(state);
  ANTIGRAVITY_PENDING.delete(init.state);
  return state;
}

// ---------------------------------------------------------------------------
// GitHub Copilot device flow
// ---------------------------------------------------------------------------

type GitHubDeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
};

async function requestCopilotDeviceCode(): Promise<GitHubDeviceCodeResponse> {
  const body = new URLSearchParams({
    client_id: GITHUB_COPILOT_CLIENT_ID,
    scope: GITHUB_OAUTH_SCOPES
  });
  const res = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(15_000)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub device code request failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = await res.json() as any;
  if (!data.device_code || !data.user_code) {
    throw new Error('GitHub device code response missing fields');
  }
  return {
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: data.verification_uri,
    expires_in: Number(data.expires_in) || 900,
    interval: Number(data.interval) || 5
  };
}

async function pollCopilotDeviceCode(deviceCode: string, intervalSeconds: number, deadlineMs: number): Promise<string> {
  let intervalMs = Math.max(1000, intervalSeconds * 1000);
  const body = new URLSearchParams({
    client_id: GITHUB_COPILOT_CLIENT_ID,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
  });
  // Allow caller to cancel by throwing on timeoutMs expiration.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() > deadlineMs) {
      throw new Error('GitHub device code expired before authorization');
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    const res = await fetch(GITHUB_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(15_000)
    });
    const data = await res.json().catch(() => ({})) as any;
    if (data.access_token) return data.access_token as string;
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') {
      intervalMs += 5_000;
      continue;
    }
    if (data.error === 'expired_token') {
      throw new Error('GitHub device code expired');
    }
    if (data.error === 'access_denied') {
      throw new Error('GitHub device flow was denied');
    }
    if (data.error) {
      throw new Error(`GitHub device flow error: ${data.error}`);
    }
  }
}

async function exchangeGitHubTokenForCopilotToken(githubToken: string): Promise<{ token: string; expiresAt: number }> {
  const res = await fetch(COPILOT_TOKEN_EXCHANGE_URL, {
    method: 'GET',
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: 'application/json',
      'User-Agent': 'GitHubCopilotChat/0.26.7',
      'Editor-Plugin-Version': 'copilot-chat/0.26.7',
      'Editor-Version': 'vscode/1.99.0'
    },
    signal: AbortSignal.timeout(15_000)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Copilot token exchange failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = await res.json() as any;
  if (!data.token) {
    throw new Error('Copilot token exchange returned no token');
  }
  // expires_at is RFC 3339 like "2024-01-02T15:04:05Z"
  const expiresAtMs = parseGitHubExpiry(data.expires_at) || (Date.now() + 25 * 60_000);
  return { token: data.token, expiresAt: expiresAtMs };
}

function parseGitHubExpiry(value: unknown): number {
  if (typeof value !== 'string' || !value) return 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

async function fetchGitHubUser(githubToken: string): Promise<{ id: string; login: string; email?: string }> {
  try {
    const res = await fetch(GITHUB_USER_URL, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'GitHubCopilotChat/0.26.7',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      signal: AbortSignal.timeout(10_000)
    });
    if (!res.ok) return { id: '', login: '' };
    const data = await res.json() as any;
    return {
      id: String(data.id || ''),
      login: String(data.login || ''),
      email: data.email ? String(data.email) : undefined
    };
  } catch {
    return { id: '', login: '' };
  }
}

async function refreshCopilotToken(state: OAuthProviderState): Promise<OAuthProviderState> {
  if (!state.refreshToken) {
    throw new Error('GitHub token missing — re-login required.');
  }
  const exchanged = await exchangeGitHubTokenForCopilotToken(state.refreshToken);
  return {
    ...state,
    accessToken: exchanged.token,
    expiresAt: exchanged.expiresAt
  };
}

export type CopilotLoginInit = {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  interval: number;
};

export async function startCopilotLogin(): Promise<CopilotLoginInit> {
  const device = await requestCopilotDeviceCode();
  const init: CopilotLoginInit = {
    userCode: device.user_code,
    verificationUri: device.verification_uri,
    expiresAt: Date.now() + device.expires_in * 1000,
    interval: device.interval
  };
  DEVICE_FLOW_PENDING['github-copilot'] = init;
  // Run the polling in the background. The HTTP layer calls
  // `completeCopilotLogin()` when the user signals the device code is entered.
  void pollAndStoreCopilotLogin(device, init).catch((err) => {
    console.error('[oauth] copilot device flow failed', err);
    delete DEVICE_FLOW_PENDING['github-copilot'];
  });
  return init;
}

async function pollAndStoreCopilotLogin(device: GitHubDeviceCodeResponse, init: CopilotLoginInit): Promise<void> {
  const deadline = init.expiresAt;
  const token = await pollCopilotDeviceCode(device.device_code, device.interval, deadline);
  const exchanged = await exchangeGitHubTokenForCopilotToken(token);
  const user = await fetchGitHubUser(token);
  const state: OAuthProviderState = {
    provider: 'github-copilot',
    authType: 'oauth-device',
    accessToken: exchanged.token,
    refreshToken: token,
    expiresAt: exchanged.expiresAt,
    accountId: user.id || undefined,
    accountLabel: user.login || user.email,
    lastRefreshedAt: Date.now()
  };
  persistState(state);
  delete DEVICE_FLOW_PENDING['github-copilot'];
}

export async function cancelCopilotLogin(): Promise<void> {
  delete DEVICE_FLOW_PENDING['github-copilot'];
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

/**
 * Returns a list of upstream model ids for the given OAuth provider, fetched
 * live from the provider's `/models` endpoint. When discovery fails or the
 * provider isn't configured, the function returns an empty list — callers
 * fall back to the catalog model list in `providers.txt`.
 */
export async function fetchOAuthProviderModels(provider: OAuthProviderId): Promise<Array<{ id: string; object: string; owned_by: string }>> {
  const state = getOAuthState(provider);
  if (!state) return [];
  const config = PROVIDER_CONFIG[provider];
  try {
    if (isTokenExpiringSoon(state, 60_000)) {
      await refreshOAuthToken(provider);
    }
    const accessToken = await getOAuthAccessToken(provider);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json'
    };
    const extra = config.headers?.();
    if (extra) Object.assign(headers, extra);
    const url = `${config.baseUrl.replace(/\/+$/, '')}/models`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) {
      console.error(`[oauth] ${provider} /models returned ${res.status}`);
      return [];
    }
    const data = await res.json() as any;
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
    return list
      .map((m: any) => ({ id: String(m.id || m.name || ''), object: 'model', owned_by: provider }))
      .filter((m: { id: string }) => m.id);
  } catch (err) {
    console.error(`[oauth] failed to fetch live models for ${provider}`, err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Copilot-specific helpers (oh-my-pi pattern from
// packages/ai/src/providers/github-copilot-headers.ts)
// ---------------------------------------------------------------------------

export type CopilotInitiator = 'user' | 'agent';

/**
 * Infer whether the current Copilot request is user-initiated or
 * agent-initiated, so GitHub can properly account premium requests.
 * Mirrors oh-my-pi's `inferCopilotInitiator`.
 */
export function inferCopilotInitiator(messages: unknown[] | undefined): CopilotInitiator {
  if (!Array.isArray(messages) || messages.length === 0) return 'user';
  const last = messages[messages.length - 1] as Record<string, unknown>;
  const role = last?.role as string | undefined;
  if (role === 'assistant' || role === 'system' || role === 'tool') return 'agent';
  if (role !== 'user') return 'user';
  // User message but the last block is a tool_result → agent turn.
  const content = last.content;
  if (Array.isArray(content) && content.length > 0) {
    const lastBlock = content[content.length - 1] as Record<string, unknown>;
    if (lastBlock?.type === 'tool_result') return 'agent';
  }
  return 'user';
}

/**
 * Check whether any message in the conversation contains image content
 * (for the Copilot-Vision-Request header).
 */
export function hasCopilotVisionInput(messages: unknown[] | undefined): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some((msg) => {
    const m = msg as Record<string, unknown>;
    if (m.role === 'user' && Array.isArray(m.content)) {
      return (m.content as unknown[]).some((c) => {
        const b = c as Record<string, unknown>;
        return b.type === 'image' || b.type === 'image_url';
      });
    }
    return false;
  });
}

// ---------------------------------------------------------------------------
// Headers used for upstream requests
// ---------------------------------------------------------------------------
export async function getOAuthUpstreamHeaders(
  provider: OAuthProviderId,
  opts?: { messages?: unknown[] },
): Promise<Record<string, string>> {
  const state = getOAuthState(provider);
  if (!state) {
    throw new Error(`OAuth provider "${provider}" is not configured.`);
  }
  if (isTokenExpiringSoon(state, 60_000)) {
    await refreshOAuthToken(provider);
  }
  const accessToken = await getOAuthAccessToken(provider);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
  const extra = PROVIDER_CONFIG[provider].headers?.();
  if (extra) Object.assign(headers, extra);
  // Copilot-specific dynamic headers (oh-my-pi pattern from
  // packages/ai/src/providers/github-copilot-headers.ts).
  if (provider === 'github-copilot') {
    headers['X-Initiator'] = inferCopilotInitiator(opts?.messages);
    if (hasCopilotVisionInput(opts?.messages)) {
      headers['Copilot-Vision-Request'] = 'true';
    }
  }
  return headers;
}
