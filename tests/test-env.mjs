/**
 * test-env.mjs — keep the operator's real credentials out of spawned test servers.
 *
 * Why this exists: tests that spawn `build/index.js` spread `...process.env` into
 * the child. On a developer machine that environment often carries the operator's
 * real provider keys (exported by `pqc-secrets export`, a sourced `env.sh`, or a
 * shell profile). The router prefers a real key over the test's dummy, so a test
 * asserting "the upstream saw `test-openrouter-key`" fails — and the mock
 * upstream is handed a live credential.
 *
 * Measured 2026-11-22: with `LOCALROUTER_OPENROUTER_API_KEY` exported in the
 * shell, `tests/decisions.integration.test.mjs` failed 5 assertions showing the
 * real 73-character key in the mock's Authorization header. With those variables
 * unset, 14/14 passed. The suite was never broken; the environment leaked.
 *
 * Rule: a test process must never inherit credential material it did not set
 * itself, and a mock upstream must never be handed a real key.
 */

/** Secret-name shapes the router treats as credential material. */
const CREDENTIAL_PATTERNS = [
  /^LOCALROUTER_.*(_API_)?KEY$/,
  /^LOCAL_ROUTER_.*(_API_)?KEY$/,
  /^LOCALROUTER_.*_TOKEN_(ID|SECRET)$/,
  /^(OPENROUTER|ZENMUX|GROQ|ANTHROPIC|OPENAI|GEMINI|GOOGLE|MISTRAL|COHERE|DEEPSEEK|MOONSHOT|NEBIUS|TOGETHER|FIREWORKS|XAI|WAFER_SERVERLESS|XIAOMI_MIMO|ZAI|KILO|CLINE|COMMANDCODE|FASTINO|MODAL|NOUS)_API_KEY$/,
  /^(MODAL_PROXY_TOKEN_ID|MODAL_PROXY_TOKEN_SECRET|VAULT_PASSPHRASE|CACTUS_API_KEY|HF_TOKEN)$/
];

/** True when a variable name looks like credential material. */
export function isCredentialName(name) {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Return a copy of `env` with every credential-looking variable removed.
 *
 * Use this instead of `{ ...process.env }` whenever spawning the router, so a
 * test can only ever authenticate with keys it explicitly sets afterwards.
 *
 * IMPORTANT ordering rule: this must be evaluated BEFORE the test sets its own
 * keys, or the scrub will strip the keys the test just added. The recommended
 * pattern is to snapshot at module load:
 *
 *   const BASE_ENV = scrubbedEnv();      // top of the file, before any setup
 *   ...{ ...childEnv(BASE_ENV), PORT: port, MY_KEY: 'test-value' }
 *
 * A scrub that ran late silently removed a key a test had set for itself
 * (measured 2026-11-22 on `local-backends.test.mjs`), which is the opposite of
 * this module's intent.
 */
export function scrubbedEnv(env = process.env) {
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (isCredentialName(name)) continue;
    out[name] = value;
  }
  return out;
}

/** Names that `scrubbedEnv` would remove, for a test asserting the scrub. */
export function scrubbedNames(env = process.env) {
  return Object.keys(env).filter(isCredentialName);
}

/**
 * Build a child environment that inherits no credential the process started
 * with, but DOES carry credentials a test deliberately set afterwards.
 *
 * `scrubbedEnv()` alone is a snapshot and is wrong for that second case: several
 * tests set `process.env.LOCALROUTER_<PROVIDER>_API_KEY` in setup and expect the
 * spawned router to inherit it (measured 2026-11-22 on `local-backends.test.mjs`,
 * where a plain snapshot stripped the test's own unsloth key and made the local
 * backend unkeyed).
 *
 * So: keep the inherited baseline minus credentials, then re-apply every
 * credential variable whose CURRENT value differs from the inherited one — i.e.
 * the ones this process changed on purpose.
 *
 * @param inherited Snapshot taken at module load, before any test setup.
 */
export function childEnv(inherited = process.env) {
  const out = scrubbedEnv(inherited);
  for (const [name, value] of Object.entries(process.env)) {
    if (!isCredentialName(name)) continue;
    if (inherited[name] === value) continue; // unchanged inherited secret: drop
    out[name] = value;
  }
  return out;
}
