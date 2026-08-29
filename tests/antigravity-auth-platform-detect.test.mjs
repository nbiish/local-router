import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildAntigravityAuthUrl,
  getAntigravityStateDbPaths,
  parseAntigravityOauthTokenProto,
  detectLocalAntigravitySession,
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
  // Construct a valid protobuf message with field 1 = ya29.mock, field 2 = Bearer, field 3 = 1//refresh
  // Field 1: tag = (1 << 3) | 2 = 0x0A, length = 9, value = "ya29.mock"
  // Field 2: tag = (2 << 3) | 2 = 0x12, length = 6, value = "Bearer"
  // Field 3: tag = (3 << 3) | 2 = 0x1A, length = 9, value = "1//mockrf"
  const f1 = Buffer.from([0x0A, 9, ...Buffer.from("ya29.mock")]);
  const f2 = Buffer.from([0x12, 6, ...Buffer.from("Bearer")]);
  const f3 = Buffer.from([0x1A, 9, ...Buffer.from("1//mockrf")]);
  const nestedBuf = Buffer.concat([f1, f2, f3]);
  const nestedB64 = nestedBuf.toString("base64");

  // Construct outer sentinel wrapper
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
