import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildAntigravityAuthUrl,
  getAntigravityStateDbPaths,
  parseAntigravityOauthTokenProto,
  detectLocalAntigravitySession,
  getCursorStateDbPaths,
  detectLocalCursorSession,
  getCopilotHostsPaths,
  detectLocalCopilotSession,
  listOAuthProviders,
  isOAuthProvider,
  getOAuthStatus,
  getOAuthState
} from "../build/oauth-providers.js";

test("buildAntigravityAuthUrl includes non-empty client_id and required parameters", () => {
  const urlString = buildAntigravityAuthUrl("http://127.0.0.1:51121/oauth-callback", "state_123", "challenge_456");
  const url = new URL(urlString);

  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:51121/oauth-callback");
  assert.equal(url.searchParams.get("state"), "state_123");
  assert.equal(url.searchParams.get("code_challenge"), "challenge_456");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");

  const clientId = url.searchParams.get("client_id");
  assert.ok(clientId, "client_id must not be empty");
  assert.match(clientId, /\.apps\.googleusercontent\.com$/);
  assert.ok(url.searchParams.get("scope").includes("cloud-platform"));
  assert.ok(url.searchParams.get("scope").includes("cclog"));
});

test("getAntigravityStateDbPaths returns platform candidate paths", () => {
  const paths = getAntigravityStateDbPaths();
  assert.ok(Array.isArray(paths));
  assert.ok(paths.length >= 2);
  for (const p of paths) {
    assert.ok(typeof p === "string");
    assert.ok(p.includes("state.vscdb"));
  }
});

test("parseAntigravityOauthTokenProto parses JSON format", () => {
  const jsonPayload = JSON.stringify({
    access_token: "ya29.test-access-token",
    refresh_token: "1//test-refresh-token",
    token_type: "Bearer",
    expires_in: 3600
  });
  const parsed = parseAntigravityOauthTokenProto(jsonPayload);
  assert.ok(parsed);
  assert.equal(parsed.accessToken, "ya29.test-access-token");
  assert.equal(parsed.refreshToken, "1//test-refresh-token");
  assert.equal(parsed.tokenType, "Bearer");
  assert.ok(parsed.expiresAt > Date.now());
});

test("parseAntigravityOauthTokenProto parses nested base64 protobuf format", () => {
  const f1 = Buffer.from([0x0A, 9, ...Buffer.from("ya29.mock")]);
  const f2 = Buffer.from([0x12, 6, ...Buffer.from("Bearer")]);
  const f3 = Buffer.from([0x1A, 9, ...Buffer.from("1//mockrf")]);
  const nestedBuf = Buffer.concat([f1, f2, f3]);
  const nestedB64 = nestedBuf.toString("base64");

  const outerText = "authStateWithContextSentinelKey some-data oauthTokenInfoSentinelKey " + nestedB64;
  const outerB64 = Buffer.from(outerText, "utf8").toString("base64");

  const parsed = parseAntigravityOauthTokenProto(outerB64);
  assert.ok(parsed);
  assert.equal(parsed.accessToken, "ya29.mock");
  assert.equal(parsed.tokenType, "Bearer");
  assert.equal(parsed.refreshToken, "1//mockrf");
  assert.ok(parsed.expiresAt > Date.now());
});

test("parseAntigravityOauthTokenProto gracefully rejects invalid payloads", () => {
  assert.equal(parseAntigravityOauthTokenProto(""), null);
  assert.equal(parseAntigravityOauthTokenProto(null), null);
  assert.equal(parseAntigravityOauthTokenProto("not-a-valid-token"), null);
});

test("detectLocalAntigravitySession auto-detects host installation if present", () => {
  const session = detectLocalAntigravitySession();
  const dbPaths = getAntigravityStateDbPaths();
  const hostHasDb = dbPaths.some((p) => fs.existsSync(p));

  if (hostHasDb && session) {
    assert.equal(session.provider, "antigravity");
    assert.equal(session.authType, "oauth-pkce");
    assert.ok(session.accessToken.startsWith("ya29"));
    assert.ok(session.expiresAt > 0);

    const status = getOAuthStatus("antigravity");
    assert.equal(status.configured, true);
    assert.equal(status.provider, "antigravity");
  }
});

test("listOAuthProviders includes antigravity, github-copilot, and cursor", () => {
  const list = listOAuthProviders();
  assert.deepEqual(list, ["antigravity", "github-copilot", "cursor"]);
  assert.equal(isOAuthProvider("cursor"), true);
  assert.equal(isOAuthProvider("antigravity"), true);
  assert.equal(isOAuthProvider("github-copilot"), true);
  assert.equal(isOAuthProvider("unknown"), false);
});

test("getCursorStateDbPaths returns valid platform paths", () => {
  const paths = getCursorStateDbPaths();
  assert.ok(Array.isArray(paths));
  assert.ok(paths.length >= 1);
  assert.ok(paths[0].includes("Cursor"));
});

test("detectLocalCursorSession auto-detects host installation if present", () => {
  const session = detectLocalCursorSession();
  const dbPaths = getCursorStateDbPaths();
  const hostHasDb = dbPaths.some((p) => fs.existsSync(p));

  if (hostHasDb && session) {
    assert.equal(session.provider, "cursor");
    assert.equal(session.authType, "oauth-pkce");
    assert.ok(session.accessToken.startsWith("eyJ"));
    assert.ok(session.expiresAt > Date.now());

    const status = getOAuthStatus("cursor");
    assert.equal(status.configured, true);
    assert.equal(status.provider, "cursor");
    assert.equal(status.displayName, "Cursor");
  }
});

test("renderProvidersPage pre-renders SSR cards for all OAuth providers", async () => {
  const { renderProvidersPage } = await import("../build/ui/pages/providers.js");
  const html = renderProvidersPage({ defaultFallbackModelsText: "" });
  assert.ok(html.includes("OAuth Provider Logins"));
  assert.ok(html.includes("Google Antigravity"));
  assert.ok(html.includes("GitHub Copilot"));
  assert.ok(html.includes("Cursor"));
  assert.ok(html.includes("id=\"oauthProviderList\""));
});

test("getCopilotHostsPaths returns platform candidate paths", () => {
  const paths = getCopilotHostsPaths();
  assert.ok(Array.isArray(paths));
  assert.ok(paths.length >= 2);
  for (const p of paths) {
    assert.ok(p.includes("github-copilot"));
  }
});

test("detectLocalCopilotSession handles env variable tokens", () => {
  const oldEnv = process.env.GITHUB_COPILOT_TOKEN;
  process.env.GITHUB_COPILOT_TOKEN = "ghu_mock_copilot_token_123";
  try {
    const session = detectLocalCopilotSession();
    assert.ok(session);
    assert.equal(session.provider, "github-copilot");
    assert.equal(session.accessToken, "ghu_mock_copilot_token_123");
  } finally {
    if (oldEnv === undefined) delete process.env.GITHUB_COPILOT_TOKEN;
    else process.env.GITHUB_COPILOT_TOKEN = oldEnv;
  }
});

test("renderProvidersPage HTML contains 100% valid executable client JavaScript", async () => {
  const { renderProvidersPage } = await import("../build/ui/pages/providers.js");
  const html = renderProvidersPage({ defaultFallbackModelsText: "test" });
  const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let count = 0;
  while ((match = scriptRegex.exec(html)) !== null) {
    count++;
    const code = match[1];
    assert.doesNotThrow(() => {
      new vm.Script(code);
    }, "Script #" + count + " should parse as valid JavaScript");
  }
  assert.ok(count >= 2, "Must contain at least 2 script tags");
});
