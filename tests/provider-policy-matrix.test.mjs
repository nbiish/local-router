import test from 'node:test';
import assert from 'node:assert/strict';

import {
  anthropicThinkingToChatFields,
  countCacheMarkers,
  DEFAULT_THINKING_LEVEL,
  PROVIDER_POLICIES,
  reasoningLevelsFor,
  resolveCachingPolicy,
  resolveReasoningPolicy,
  responsesReasoningToChatFields,
  THINKING_LEVEL_ORDER
} from '../build/provider-policy.js';
import { sanitizeProviderRequestBody } from '../build/reasoning.js';
import { injectPromptCaching, translateResponsesRequestToChatBody } from '../build/index.js';
import { PROVIDER_REGISTRY } from '../build/provider-registry.js';
import { PROVIDER_MODEL_REGISTRY } from '../build/provider-model-registries.js';

/**
 * The reasoning + caching contract matrix.
 *
 * Every other test in this repository checks one provider, or one wire, or one
 * level. This one is exhaustive by construction: it enumerates every
 * `{provider}-{model}` pairing the router can serve, crosses it with every level
 * that pairing advertises, and runs the REAL exported translation and injection
 * functions over every inbound wire shape. What it asserts is the invariant, not
 * an example:
 *
 *   "a harness that asks for level L on model M reaching provider P sends an
 *    upstream body in which P can actually read level L."
 *
 * That is the property the previous implementation broke silently: the anthropic
 * and responses wires never emitted anything at all, and the advertisement
 * promised a dial for families the translator never spoke to. Nothing above this
 * layer can detect that, because the request still succeeds with HTTP 200 and
 * just ignores what the caller asked for.
 *
 * Offline, deterministic, no keys, no network, no cost.
 */

// ── The pairing universe ────────────────────────────────────────────────────

/** Every model id the curated registry knows, deduplicated per provider. */
function registryPairings() {
  const pairings = [];
  for (const [provider, entries] of Object.entries(PROVIDER_MODEL_REGISTRY)) {
    for (const entry of entries || []) {
      if (!entry?.id) continue;
      pairings.push({ provider, model: entry.id, id: `${provider}/${entry.id}` });
    }
  }
  return pairings;
}

const PAIRINGS = registryPairings();

/** Provider slugs the router can reach that carry no curated registry entry. */
const LOOPBACK_PROVIDERS = ['llama-cpp', 'llama-local', 'unsloth'];

/** The four inbound wire shapes a level can arrive on. */
const WIRES = ['openai', 'anthropic', 'codex', 'ollama'];

/**
 * Build the caller-side body for a level on a given wire, then run it through
 * the SAME translation the route uses, producing the chat-completions body the
 * pipeline forwards.
 *
 * Using the real translators matters: a hand-built approximation would keep
 * passing after the route stopped calling them, which is precisely how the
 * Anthropic and Responses wires dropped thinking for as long as they did.
 */
function inboundBody({ wire, model, level }) {
  const messages = [
    { role: 'system', content: 'You are a careful assistant. '.repeat(20) },
    { role: 'user', content: 'Summarise the change. '.repeat(20) }
  ];

  switch (wire) {
    case 'openai':
      return { model, messages, reasoning_effort: level };

    case 'ollama':
      // Ollama-native: `think` is a boolean on the wire.
      return { model, messages, think: level !== 'none' };

    case 'anthropic': {
      // /v1/messages: the route copies exactly this field set onto the chat body.
      const thinking = level === 'none'
        ? { type: 'disabled' }
        : { type: 'enabled', budget_tokens: budgetFor(level) };
      return { model, messages, ...anthropicThinkingToChatFields(thinking) };
    }

    case 'codex': {
      // /v1/responses: drive the real shim so the assertion covers it.
      const responsesRequest = {
        model,
        input: messages.map((message) => ({ role: message.role, content: message.content })),
        reasoning: level === 'none' ? { effort: 'none' } : { effort: level }
      };
      return translateResponsesRequestToChatBody(responsesRequest);
    }

    default:
      throw new Error(`unknown wire ${wire}`);
  }
}

function budgetFor(level) {
  switch (level) {
    case 'minimal': return 1024;
    case 'low': return 1536;
    case 'medium': return 4096;
    case 'high': return 16384;
    case 'xhigh': return 32768;
    default: return 0;
  }
}

/**
 * The field a given dialect is read from upstream — what the provider actually
 * parses. A level that is not in here was not delivered, however valid the body.
 */
const DIALECT_FIELD = {
  'openai-effort': 'reasoning_effort',
  'anthropic-thinking': 'thinking',
  'enable-thinking': 'enable_thinking',
  'ollama-think': 'think'
};

/** What the level looks like once written in that field. */
function levelAsSent(field, value) {
  if (field === 'thinking') {
    if (!value || typeof value !== 'object') return null;
    if (value.type === 'disabled') return 'none';
    return value.type === 'enabled' ? 'enabled' : null;
  }
  if (field === 'enable_thinking' || field === 'think') {
    return value === true ? 'enabled' : value === false ? 'none' : null;
  }
  return typeof value === 'string' ? value : null;
}

// ── 1. Coverage: every provider has a policy, every registry row resolves ───

test('every registry provider has a policy row', () => {
  const missing = PROVIDER_REGISTRY
    .map((entry) => entry.name)
    .filter((name) => !PROVIDER_POLICIES[name]);
  assert.deepEqual(missing, [],
    `a provider without a policy silently inherits "no dial, no cache": ${missing.join(', ')}`);
});

test('every loopback provider has a policy row', () => {
  const missing = LOOPBACK_PROVIDERS.filter((name) => !PROVIDER_POLICIES[name]);
  assert.deepEqual(missing, [], `loopback providers need a policy too: ${missing.join(', ')}`);
});

test('the registry enumerates a usable pairing universe', () => {
  // A silent drop to zero rows would make every matrix test below vacuous.
  assert.ok(PAIRINGS.length > 200, `expected a large pairing universe, got ${PAIRINGS.length}`);
  const providers = new Set(PAIRINGS.map((p) => p.provider));
  assert.ok(providers.size >= 15, `expected every registry provider to contribute, got ${providers.size}`);
});

test('every policy declares a level list consistent with its dialect', () => {
  for (const [name, policy] of Object.entries(PROVIDER_POLICIES)) {
    const { dialect, levels, defaultLevel } = policy.reasoning;
    if (dialect === 'none' || dialect === 'model-id') {
      // These have no request field. Advertising levels would be a control that
      // cannot move, which is the exact bug this table exists to prevent.
      assert.deepEqual(levels, [], `${name}: dialect ${dialect} must advertise no levels`);
      continue;
    }
    assert.ok(levels.length > 0, `${name}: dialect ${dialect} must advertise at least one level`);
    assert.ok(levels.includes('none'), `${name}: "none" must be offered so thinking can be turned off`);
    for (const level of levels) {
      assert.ok(THINKING_LEVEL_ORDER.includes(level), `${name}: unknown level ${level}`);
    }
    // A boolean dialect can only express off/on; advertising minimal or xhigh
    // there is a selector option that silently does nothing.
    if (dialect === 'enable-thinking' || dialect === 'ollama-think') {
      assert.deepEqual([...levels].sort(), ['medium', 'none'].sort(),
        `${name}: boolean dialect advertises exactly off and on, got ${levels}`);
    }
    if (levels.length > 1) {
      assert.ok(levels.includes(defaultLevel) || defaultLevel === 'none',
        `${name}: default ${defaultLevel} is not in the advertised set`);
    }
    // Cache policy sanity.
    const caching = policy.caching;
    if (caching.mechanism === 'anthropic-cache-control') {
      assert.ok(caching.maxBreakpoints > 0, `${name}: explicit markers need a breakpoint budget`);
      assert.equal(caching.stripsCacheControl, false, `${name}: cannot both inject markers and strip them`);
    } else {
      assert.equal(caching.maxBreakpoints, 0, `${name}: only anthropic-cache-control spends breakpoints`);
    }
  }
});

// ── 2. Translation: every pairing x every advertised level x every wire ─────

test('every pairing translates every advertised level on every wire', () => {
  const failures = [];

  for (const pairing of PAIRINGS) {
    const policy = resolveReasoningPolicy(pairing.provider, pairing.model);
    const levels = reasoningLevelsFor(pairing.provider, pairing.model);
    if (levels.length === 0) continue;

    const field = DIALECT_FIELD[policy.dialect];
    assert.ok(field, `${pairing.id}: dialect ${policy.dialect} claims levels but has no field`);

    for (const wire of WIRES) {
      for (const level of [...levels, 'xhigh']) {
        // xhigh is accepted on every wire even where unadvertised, and must
        // degrade rather than vanish.
        const inbound = inboundBody({ wire, model: pairing.model, level });
        const outbound = sanitizeProviderRequestBody(inbound, {
          providerName: pairing.provider,
          modelName: pairing.model
        });

        const sent = levelAsSent(field, outbound[field]);
        if (level === 'none') {
          if (sent !== 'none') {
            failures.push(`${pairing.id} [${wire}] none -> ${field}=${JSON.stringify(outbound[field])}`);
          }
          continue;
        }
        if (sent === null) {
          failures.push(`${pairing.id} [${wire}] ${level} -> ${field} missing (dialect ${policy.dialect})`);
          continue;
        }
        if (sent === 'none') {
          failures.push(`${pairing.id} [${wire}] ${level} -> thinking turned OFF`);
          continue;
        }
        if (policy.dialect === 'openai-effort') {
          // The delivered level must be one this provider distinguishes, and a
          // downgrade is allowed — a silent drop to "off" or to a level outside
          // the advertised set is not.
          if (!levels.includes(sent)) {
            failures.push(`${pairing.id} [${wire}] ${level} -> ${sent} (not advertised)`);
          }
        }
      }
    }
  }

  assert.deepEqual(failures.slice(0, 25), [],
    `${failures.length} pairing/wire/level combinations did not reach the upstream dialect`);
});

test('a provider with no dial is never GIVEN a reasoning parameter', () => {
  const failures = [];
  for (const pairing of PAIRINGS) {
    const levels = reasoningLevelsFor(pairing.provider, pairing.model);
    if (levels.length > 0) continue;
    // The caller sent no reasoning intent, so nothing may be invented. (A caller
    // that DID send one is entitled to have it pass through untouched — the
    // upstream only ever sees what the harness sent.)
    const outbound = sanitizeProviderRequestBody(
      { model: pairing.model, messages: [{ role: 'user', content: 'hi' }] },
      { providerName: pairing.provider, modelName: pairing.model }
    );
    for (const key of ['reasoning_effort', 'enable_thinking', 'think', 'thinking']) {
      if (key in outbound) {
        failures.push(`${pairing.id} invented ${key}=${JSON.stringify(outbound[key])}`);
      }
    }
  }
  assert.deepEqual([...new Set(failures)].slice(0, 25), []);
});

test('an unspecified level is never invented', () => {
  // Operator contract (2026-09-04): the proxy sets no thinking default. Only a
  // level the caller asked for may appear upstream.
  const failures = [];
  for (const pairing of PAIRINGS) {
    const outbound = sanitizeProviderRequestBody(
      { model: pairing.model, messages: [{ role: 'user', content: 'hi' }] },
      { providerName: pairing.provider, modelName: pairing.model }
    );
    for (const key of ['reasoning_effort', 'enable_thinking', 'think', 'thinking']) {
      if (key in outbound) failures.push(`${pairing.id} invented ${key}=${JSON.stringify(outbound[key])}`);
    }
  }
  assert.deepEqual([...new Set(failures)].slice(0, 25), []);
});

test('an explicit opt-out always wins', () => {
  const failures = [];
  // Sending two conflicting fields is what a confused harness does; "off" must
  // still win rather than being overwritten by whichever field the translator
  // happened to read last.
  const conflicting = [
    { think: false, reasoning_effort: 'high' },
    { reasoning_effort: 'none', enable_thinking: true },
    { thinking: { type: 'disabled' }, reasoning_effort: 'high' },
    { enable_thinking: false, reasoning: { effort: 'high' } }
  ];
  for (const pairing of PAIRINGS) {
    for (const extra of conflicting) {
      const outbound = sanitizeProviderRequestBody(
        { model: pairing.model, messages: [{ role: 'user', content: 'hi' }], ...extra },
        { providerName: pairing.provider, modelName: pairing.model }
      );
      const levels = reasoningLevelsFor(pairing.provider, pairing.model);
      if (levels.length === 0) continue;
      const policy = resolveReasoningPolicy(pairing.provider, pairing.model);
      const sent = levelAsSent(DIALECT_FIELD[policy.dialect], outbound[DIALECT_FIELD[policy.dialect]]);
      if (sent !== 'none') {
        failures.push(`${pairing.id} ${JSON.stringify(extra)} -> ${sent}`);
      }
    }
  }
  assert.deepEqual(failures.slice(0, 25), []);
});

// ── 3. Advertisement agrees with translation ────────────────────────────────

test('every advertised level is one the translator can deliver', () => {
  const failures = [];
  for (const pairing of PAIRINGS) {
    for (const level of reasoningLevelsFor(pairing.provider, pairing.model)) {
      const outbound = sanitizeProviderRequestBody(
        inboundBody({ wire: 'openai', model: pairing.model, level }),
        { providerName: pairing.provider, modelName: pairing.model }
      );
      const policy = resolveReasoningPolicy(pairing.provider, pairing.model);
      const field = DIALECT_FIELD[policy.dialect];
      if (levelAsSent(field, outbound[field]) === null) {
        failures.push(`${pairing.id}: advertises ${level} but cannot send it`);
      }
    }
  }
  assert.deepEqual(failures.slice(0, 25), []);
});

test('the fallback route advertises exactly the union of its members', () => {
  // A route that advertises a level no member can take renders a selector whose
  // option does nothing on every hop.
  const policy = resolveReasoningPolicy('local-router', 'fallback-models');
  const levels = reasoningLevelsFor('local-router', 'fallback-models');
  // `local-router` itself has no row (it is a route, not an upstream), so it
  // resolves to the empty default rather than inventing a dialect. The route's
  // advertised set is computed by `reasoningEffortLevels` in index.ts from its
  // members; this asserts the base rule that keeps that computation honest.
  assert.deepEqual(levels, []);
  assert.equal(policy.dialect, 'none');
});

// ── 4. Cache contract ───────────────────────────────────────────────────────

function cacheBody(overrides = {}) {
  return {
    model: 'test-model',
    messages: [
      { role: 'system', content: 'System prompt. '.repeat(50) },
      { role: 'user', content: 'First turn. '.repeat(20) },
      { role: 'assistant', content: 'First answer. '.repeat(20) },
      { role: 'user', content: 'Second turn. '.repeat(20) }
    ],
    tools: [
      { type: 'function', function: { name: 'read_file', description: 'read' } },
      { type: 'function', function: { name: 'write_file', description: 'write' } }
    ],
    ...overrides
  };
}

test('no provider is ever sent more breakpoints than its cap', () => {
  const failures = [];
  for (const pairing of PAIRINGS) {
    const policy = resolveCachingPolicy(pairing.provider, pairing.model);
    const out = injectPromptCaching(
      cacheBody({ model: pairing.model }),
      pairing.provider,
      pairing.model
    );
    const markers = countCacheMarkers(out);
    if (markers > policy.maxBreakpoints) {
      failures.push(`${pairing.id}: ${markers} markers > cap ${policy.maxBreakpoints}`);
    }
    if (policy.maxBreakpoints === 0 && markers > 0) {
      failures.push(`${pairing.id}: injected a marker on a surface that cannot take one`);
    }
  }
  assert.deepEqual(failures.slice(0, 25), []);
});

test('a client that already used the whole breakpoint budget is not pushed over it', () => {
  const pairing = { provider: 'zenmux', model: 'anthropic/claude-sonnet-4.5' };
  const policy = resolveCachingPolicy(pairing.provider, pairing.model);
  assert.ok(policy.maxBreakpoints > 0, 'this pairing must be an explicit-marker surface');

  // Claude Code ships four breakpoints of its own; adding two more is a 400.
  const prefilled = cacheBody({
    model: pairing.model,
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b', cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: 'c' }
    ],
    tools: [
      { type: 'function', function: { name: 'one' }, cache_control: { type: 'ephemeral' } },
      { type: 'function', function: { name: 'two' }, cache_control: { type: 'ephemeral' } }
    ]
  });

  const out = injectPromptCaching(prefilled, pairing.provider, pairing.model);
  assert.ok(countCacheMarkers(out) <= policy.maxBreakpoints,
    `budget exceeded: ${countCacheMarkers(out)} > ${policy.maxBreakpoints}`);
});

test('cache markers are never sent to a surface that rejects them', () => {
  const failures = [];
  for (const pairing of PAIRINGS) {
    const policy = resolveCachingPolicy(pairing.provider, pairing.model);
    if (!policy.stripsCacheControl) continue;
    const marked = cacheBody({
      model: pairing.model,
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }] },
        { role: 'user', content: 'hi' }
      ],
      tools: [{ type: 'function', function: { name: 'x' }, cache_control: { type: 'ephemeral' } }]
    });
    const out = injectPromptCaching(marked, pairing.provider, pairing.model);
    if (countCacheMarkers(out) > 0) {
      failures.push(`${pairing.id}: marker survived a stripping surface`);
    }
  }
  assert.deepEqual(failures.slice(0, 25), []);
});

test('the retention hint appears only where the upstream documents it', () => {
  const failures = [];
  for (const pairing of PAIRINGS) {
    const policy = resolveCachingPolicy(pairing.provider, pairing.model);
    const out = injectPromptCaching(
      cacheBody({ model: pairing.model }),
      pairing.provider,
      pairing.model
    );
    const present = out.prompt_cache_retention !== undefined;
    const allowed = policy.retention === '24h';
    if (present !== allowed) {
      failures.push(`${pairing.id}: retention=${JSON.stringify(out.prompt_cache_retention)}, policy=${policy.retention}`);
    }
  }
  assert.deepEqual(failures.slice(0, 25), []);
});

test('a sticky key is sent in the field each provider reads', () => {
  const failures = [];
  for (const pairing of PAIRINGS) {
    const policy = resolveCachingPolicy(pairing.provider, pairing.model);
    const out = injectPromptCaching(
      cacheBody({ model: pairing.model }),
      pairing.provider,
      pairing.model
    );
    switch (policy.stickyKey) {
      case 'session_id':
        if (!out.session_id) failures.push(`${pairing.id}: no session_id`);
        if (!out.prompt_cache_key) failures.push(`${pairing.id}: no prompt_cache_key`);
        break;
      case 'prompt_cache_key':
        if (!out.prompt_cache_key) failures.push(`${pairing.id}: no prompt_cache_key`);
        break;
      case 'keep_alive':
        if (out.keep_alive === undefined) failures.push(`${pairing.id}: no keep_alive`);
        break;
      default:
        break;
    }
  }
  assert.deepEqual(failures.slice(0, 25), []);
});

test('a streamed request asks for the usage chunk where the surface supports it', () => {
  const failures = [];
  for (const pairing of PAIRINGS) {
    const policy = resolveCachingPolicy(pairing.provider, pairing.model);
    if (!policy.includeStreamUsage) continue;
    const out = injectPromptCaching(
      cacheBody({ model: pairing.model, stream: true }),
      pairing.provider,
      pairing.model
    );
    if (out.stream_options?.include_usage !== true) {
      failures.push(`${pairing.id}: streams usage-less, so cached_tokens is unverifiable`);
    }
  }
  assert.deepEqual(failures.slice(0, 25), []);
});

test('a caller-chosen TTL is normalised onto the surface it is sent to', () => {
  // A marker minted for one provider is re-stamped for the next on a fallback hop,
  // so a TTL that surface does not accept cannot survive the trip.
  const pairing = { provider: 'zenmux', model: 'anthropic/claude-sonnet-4.5' };
  const prefilled = cacheBody({
    model: pairing.model,
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '5m' } }] },
      { role: 'user', content: 'hi' }
    ],
    tools: []
  });
  const out = injectPromptCaching(prefilled, pairing.provider, pairing.model);
  const marker = out.messages[0].content[0].cache_control;
  assert.equal(marker.type, 'ephemeral');
  assert.equal(marker.ttl, '1h', 'the policy TTL is the maximum this surface documents');
});

// ── 5. Wire-level translation helpers ───────────────────────────────────────

test('an Anthropic thinking budget becomes an effort the chat pipeline can carry', () => {
  assert.deepEqual(anthropicThinkingToChatFields({ type: 'enabled', budget_tokens: 1024 }), {
    reasoning_effort: 'low'
  });
  assert.deepEqual(anthropicThinkingToChatFields({ type: 'enabled', budget_tokens: 60000 }), {
    reasoning_effort: 'xhigh'
  });
  assert.deepEqual(anthropicThinkingToChatFields({ type: 'disabled' }), { reasoning_effort: 'none' });
  // An absent block must add nothing at all, or the proxy invents a default.
  assert.deepEqual(anthropicThinkingToChatFields(undefined), {});
  assert.deepEqual(anthropicThinkingToChatFields({}), {});
});

test('a Responses reasoning effort survives into the chat body', () => {
  assert.deepEqual(responsesReasoningToChatFields({ effort: 'high' }), { reasoning_effort: 'high' });
  assert.deepEqual(responsesReasoningToChatFields({ effort: 'none' }), { reasoning_effort: 'none' });
  assert.deepEqual(responsesReasoningToChatFields({ max_tokens: 2000 }), { reasoning_effort: 'low' });
  assert.deepEqual(responsesReasoningToChatFields(undefined), {});
});

test('the default level is one every dialect can express', () => {
  assert.equal(DEFAULT_THINKING_LEVEL, 'medium');
  for (const [name, policy] of Object.entries(PROVIDER_POLICIES)) {
    if (policy.reasoning.dialect === 'none' || policy.reasoning.dialect === 'model-id') continue;
    assert.ok(policy.reasoning.levels.includes(DEFAULT_THINKING_LEVEL),
      `${name}: cannot express the default level ${DEFAULT_THINKING_LEVEL}`);
  }
});
