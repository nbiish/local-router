import {
  applyReasoningPolicy,
  DEFAULT_THINKING_LEVEL,
  hasProviderPolicy,
  normalizeThinkingLevel,
  resolveReasoningPolicy,
  THINKING_LEVEL_ORDER,
  type ReasoningPolicy,
  type ThinkingLevel
} from './provider-policy';

export { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_ORDER };
export type { ThinkingLevel };

type JsonObject = Record<string, any>;

/**
 * Response keys that are ONLY valid for the upstream turn that produced them.
 *
 * Signatures and redacted blocks cannot be replayed: a later request (or a
 * fallback hop to a different provider) rejects them. The readable reasoning
 * text is NOT in this set — see stripReasoningMetadataInternal.
 */
const RESPONSE_REASONING_SIGNATURE_KEYS = new Set([
  'reasoning_details',
  'reasoningDetails',
  'redacted_thinking',
  'redactedThinking',
  'thinking_signature',
  'thinkingSignature',
  'reasoning_signature',
  'reasoningSignature'
]);

const REASONING_BLOCK_TYPES = new Set([
  'thinking',
  'redacted_thinking',
  'reasoning',
  'reasoning_content'
]);

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isReasoningContentBlock(value: unknown): boolean {
  if (!isObject(value)) return false;

  const type = value.type;
  return typeof type === 'string' && REASONING_BLOCK_TYPES.has(type.toLowerCase());
}

const VALID_EFFORT_LEVELS = new Set<string>(THINKING_LEVEL_ORDER);

/**
 * Detect a request that explicitly opted IN to thinking or chose an effort
 * level. Any agent harness can express this via its native parameter shape
 * (OpenAI `reasoning_effort`, Ollama `think`, Anthropic-style `thinking`,
 * Qwen/GLM `enable_thinking`, or any of those inside `extra_body`). When
 * present, the harness's choice wins over the proxy default.
 */
export function hasExplicitThinkingRequest(value: JsonObject): boolean {
  if (value.think === true) return true;
  if (value.enable_thinking === true) return true;
  if (typeof value.reasoning_effort === 'string' && VALID_EFFORT_LEVELS.has(value.reasoning_effort)) {
    return true;
  }
  if (isObject(value.thinking)) {
    if (value.thinking.type === 'enabled') return true;
    if (value.thinking.enabled === true) return true;
    if (typeof value.thinking.budget_tokens === 'number') return true;
  }

  const extra = value.extra_body;
  if (isObject(extra)) {
    if (extra.enable_thinking === true) return true;
    if (typeof extra.reasoning_effort === 'string' && VALID_EFFORT_LEVELS.has(extra.reasoning_effort)) {
      return true;
    }
    if (typeof extra.reasoning_budget === 'number') return true;
    const kwargs = extra.chat_template_kwargs;
    if (isObject(kwargs) && kwargs.enable_thinking === true) return true;
  }

  return false;
}

/**
 * Strip reasoning metadata from a provider RESPONSE.
 *
 * Scope (2026-11-07): this removes wire-format artifacts a client cannot use
 * — signatures, redacted blocks, and array-shaped thinking blocks — so a
 * response stays a valid OpenAI chat completion.
 *
 * It deliberately KEEPS the readable reasoning a reasoning model returns at
 * the message level (`reasoning`, `reasoning_content`). Those are the actual
 * thinking text, and every harness that offers a thinking mode reads them to
 * display or persist it. Stripping them made a reasoning model look like it
 * had none: measured against ZenMux `deepseek/deepseek-v4.1-flash`, the
 * upstream body carried `reasoning` (217 chars) and the router returned a
 * message with only `role` and `content`, while `completion_tokens_details
 * .reasoning_tokens` still billed 42 reasoning tokens. The consumer could not
 * show thinking it had paid for.
 *
 * Signatures stay stripped because they are only valid for the exact upstream
 * conversation that produced them; forwarding them into a later request
 * (especially across a fallback hop to another provider) is rejected.
 */
function stripReasoningMetadataInternal(value: unknown, depth: number): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((item) => !isReasoningContentBlock(item))
      .map((item) => stripReasoningMetadataInternal(item, depth + 1));
  }

  if (!isObject(value)) return value;

  const output: JsonObject = {};

  for (const [key, child] of Object.entries(value)) {
    if (RESPONSE_REASONING_SIGNATURE_KEYS.has(key)) continue;
    output[key] = stripReasoningMetadataInternal(child, depth + 1);
  }

  return output;
}

export function stripReasoningMetadata<T>(value: T): T {
  return stripReasoningMetadataInternal(value, 0) as T;
}

/**
 * Portable translation for a call that names no provider (or an unregistered
 * one). This is the historical behaviour, kept for library callers and for
 * custom providers registered after boot: an explicit opt-out becomes the two
 * portable off dialects, an explicit opt-in becomes `enable_thinking: true`
 * unless a precise effort was already given, and the Ollama-only `think` key is
 * dropped because no chat-completions upstream accepts it.
 */
function applyPortableThinking(body: JsonObject): JsonObject {
  const next: JsonObject = { ...body };

  if (typeof next.think === 'string') {
    const level = normalizeThinkingLevel(next.think);
    if (level) {
      next.think = level !== 'none';
      if (level !== 'none') next.reasoning_effort = level;
    } else {
      delete next.think;
    }
  }

  if (next.think !== undefined || next.enable_thinking !== undefined || next.reasoning_effort !== undefined) {
    const wantsOff = next.think === false
      || next.enable_thinking === false
      || (isObject(next.thinking) && next.thinking.type === 'disabled')
      || next.reasoning_effort === 'none';
    const explicitOn = next.think === true
      || next.enable_thinking === true
      || (isObject(next.thinking) && next.thinking.type === 'enabled');

    if (wantsOff) {
      next.reasoning_effort = 'none';
      next.thinking = { type: 'disabled' };
      delete next.enable_thinking;
    } else if (explicitOn) {
      if (next.reasoning_effort === undefined
        && next.think === true
        && next.enable_thinking === undefined
        && next.thinking === undefined) {
        next.enable_thinking = true;
      }
    }
  }

  delete next.think;
  return next;
}

export type ProviderReasoningTarget = {
  providerName?: string;
  modelName?: string;
};

/** The policy a request to this provider/model is translated by. */
export function reasoningPolicyFor(target?: ProviderReasoningTarget): ReasoningPolicy | undefined {
  const providerName = target?.providerName;
  if (!providerName || !providerName.trim()) return undefined;
  return resolveReasoningPolicy(providerName, target?.modelName);
}

/**
 * Sanitize a provider request body before forwarding upstream.
 *
 * CRITICAL: reasoning metadata is never stripped from request bodies.
 * Stripping `reasoning_content` from assistant messages breaks multi-turn
 * conversations with providers like Moonshot that require it to be present in
 * assistant tool_call messages when thinking is enabled. Reasoning metadata is
 * only stripped from responses (see stripReasoningMetadata).
 *
 * Thinking resolution order (any agent harness, any wire shape):
 *   1. Explicit opt-out (`think:false`, `reasoning_effort:'none'`,
 *      `thinking:{type:'disabled'}`, …) → thinking disabled.
 *   2. Explicit opt-in / effort (`reasoning_effort`, `think:true`,
 *      `enable_thinking:true`, `thinking:{...}`, incl. `extra_body`) →
 *      re-expressed in the dialect this provider reads.
 *   3. Otherwise → passed through untouched. The proxy never invents a level:
 *      per-request configuration always wins, and a provider that rejects an
 *      unsupported parameter (`gpt-4o-mini` + `reasoning_effort` → HTTP 400
 *      `invalid_reasoning_effort`) only ever sees what the caller sent.
 */
export function sanitizeProviderRequestBody<T extends JsonObject>(
  body: T,
  options?: {
    providerName?: string;
    modelName?: string;
    /** Deprecated (2026-09-04 operator contract): the proxy never sets a
     *  thinking default. Retained for signature compatibility; a no-op. */
    thinkingLevel?: ThinkingLevel;
    applyProxyThinking?: boolean;
    supportsReasoning?: boolean;
  }
): T {
  const providerName = options?.providerName?.trim();
  if (!providerName || !hasProviderPolicy(providerName)) {
    // No policy row means no factual contract to translate against: an operator's
    // custom provider, or a library caller that named none. The portable passthrough
    // contract applies, so their own thinking parameters keep working untouched.
    return applyPortableThinking({ ...body }) as T;
  }

  const policy = resolveReasoningPolicy(providerName, options?.modelName);
  if (policy.dialect === 'none' || policy.dialect === 'model-id') {
    // No request dial exists for this pairing, so nothing is added. The caller's
    // own parameters still pass through untouched: an upstream should only ever
    // see what the caller sent, and silently deleting a field the harness set is
    // how a working client breaks after a router upgrade.
    const next: JsonObject = { ...body };
    delete next.think;
    return next as T;
  }

  return applyReasoningPolicy({ ...body }, policy) as T;
}
