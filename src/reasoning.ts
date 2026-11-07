type JsonObject = Record<string, any>;

export type ThinkingLevel = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium';

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

const NATIVE_REASONING_MODEL_PATTERN = /(deepseek|kimi|qwen[-_/]?(?:qwen)?3|qwen3|glm|z-ai|zai-org|moonshotai|minimax|stepfun|sapiens)/i;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isReasoningContentBlock(value: unknown): boolean {
  if (!isObject(value)) return false;

  const type = value.type;
  return typeof type === 'string' && REASONING_BLOCK_TYPES.has(type.toLowerCase());
}

function hasExplicitNoThinkingRequest(value: JsonObject): boolean {
  if (value.think === false) return true;
  if (value.enable_thinking === false) return true;
  if (value.reasoning_effort === 'none') return true;

  const thinking = value.thinking;
  if (isObject(thinking)) {
    if (thinking.type === 'disabled') return true;
    if (thinking.enabled === false) return true;
  }

  return false;
}

const VALID_EFFORT_LEVELS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

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
 * Normalize an explicitly-requested thinking body so it is safe to forward
 * upstream verbatim: Ollama's boolean `think: true` is translated to the
 * portable `enable_thinking: true` and the non-standard key is dropped.
 */
function normalizeExplicitThinkingRequest(value: JsonObject): JsonObject {
  const next: JsonObject = { ...value };
  if (next.think === true) {
    next.enable_thinking = true;
  }
  delete next.think;
  return next;
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

function applyNoThinkingHints(body: JsonObject): JsonObject {
  const next: JsonObject = {
    ...body,
    reasoning_effort: 'none',
    thinking: { type: 'disabled' }
  };

  delete next.think;

  if ('enable_thinking' in next) next.enable_thinking = false;
  if ('include_reasoning' in next) next.include_reasoning = false;
  if ('return_reasoning' in next) next.return_reasoning = false;

  if (isObject(next.extra_body)) {
    const extraBody: JsonObject = { ...next.extra_body };
    delete extraBody.reasoning_budget;

    if ('enable_thinking' in extraBody) extraBody.enable_thinking = false;
    if ('include_reasoning' in extraBody) extraBody.include_reasoning = false;
    if ('return_reasoning' in extraBody) extraBody.return_reasoning = false;
    if ('reasoning_effort' in extraBody) extraBody.reasoning_effort = 'none';

    if (isObject(extraBody.chat_template_kwargs)) {
      const chatTemplateKwargs: JsonObject = {
        ...extraBody.chat_template_kwargs,
        thinking: false,
        enable_thinking: false
      };
      delete chatTemplateKwargs.reasoning_budget;
      extraBody.chat_template_kwargs = chatTemplateKwargs;
    }

    next.extra_body = extraBody;
  }

  return next;
}

/**
 * Map thinking level to provider-specific request parameters.
 * Different providers use different parameter names for reasoning/thinking.
 */
export function getThinkingRequestParams(
  level: ThinkingLevel,
  providerName: string,
  modelName: string
): JsonObject {
  if (level === 'none') {
    return { reasoning_effort: 'none', thinking: { type: 'disabled' } };
  }

  const normalized = `${providerName}/${modelName}`.toLowerCase();

  // DeepSeek, Qwen, GLM, Z.ai, MiniMax, StepFun, Sapiens use enable_thinking
  if (/(deepseek|qwen|glm|z-ai|zai|minimax|stepfun|sapiens)/.test(normalized)) {
    return { enable_thinking: true };
  }

  // Moonshot/Kimi uses enable_thinking
  if (/(moonshot|kimi)/.test(normalized)) {
    return { enable_thinking: true };
  }

  // Default: OpenAI-style reasoning_effort (low, medium, high)
  // xhigh maps to high for providers that don't support it
  const effort = level === 'xhigh' ? 'high' : level;
  return { reasoning_effort: effort };
}

export function shouldDisableNativeThinking(providerName: string, modelName: string): boolean {
  return NATIVE_REASONING_MODEL_PATTERN.test(`${providerName}/${modelName}`);
}

export function stripReasoningMetadata<T>(value: T): T {
  return stripReasoningMetadataInternal(value, 0) as T;
}

/**
 * Sanitize provider request body before forwarding upstream.
 *
 * CRITICAL: We do NOT strip reasoning_metadata from request bodies.
 * Stripping reasoning_content from assistant messages breaks multi-turn
 * conversations with providers like Moonshot that require reasoning_content
 * to be present in assistant tool_call messages when thinking is enabled.
 *
 * Reasoning metadata is only stripped from responses (see stripReasoningMetadata).
 *
 * Thinking resolution order (any agent harness, any wire shape):
 *   1. Explicit opt-out (`think:false`, `reasoning_effort:'none'`,
 *      `thinking:{type:'disabled'}`, …) → thinking disabled.
 *   2. Explicit opt-in / effort (`reasoning_effort`, `think:true`,
 *      `enable_thinking:true`, `thinking:{...}`, incl. `extra_body`) →
 *      passed through verbatim.
 *   3. Otherwise → configured level, defaulting to `DEFAULT_THINKING_LEVEL`
 *      (`medium`), regardless of the `applyProxyThinking` toggle (deprecated,
 *      retained for signature compatibility; now a no-op).
 */
export function sanitizeProviderRequestBody<T extends JsonObject>(
  body: T,
  options?: {
    providerName?: string;
    modelName?: string;
    /** Deprecated (2026-09-04 operator contract): the proxy NEVER sets a
     *  thinking default. Every call to the endpoint configures its own
     *  thinking/effort — whatever the harness sends is forwarded verbatim
     *  (Ollama `think` normalized to the portable `enable_thinking`). */
    thinkingLevel?: ThinkingLevel;
    applyProxyThinking?: boolean;
    supportsReasoning?: boolean;
  }
): T {
  // Pure passthrough (2026-09-04): no proxy-injected reasoning_effort /
  // enable_thinking / thinking payloads, ever. Providers that reject an
  // unsupported parameter (gpt-4o-mini + reasoning_effort → HTTP 400
  // invalid_reasoning_effort) only see parameters the caller actually sent.
  const next: JsonObject = { ...body };
  // Ollama accepts `think` as a boolean OR as a level string ("low"/"medium"/"high"), and its
  // documented meaning is the same dial as reasoning_effort. A level string was being dropped
  // entirely, so a client that sent think:"low" reached the provider with NO reasoning parameter
  // and got whatever the model defaults to — the selection appeared to have no effect, and
  // switching levels between turns looked like the setting had stopped working.
  if (typeof next.think === 'string') {
    const level = String(next.think).trim().toLowerCase();
    if (VALID_EFFORT_LEVELS.has(level)) {
      next.think = level === 'none' ? false : true;
      if (level !== 'none') next.reasoning_effort = level;
    } else {
      // An unrecognised value is not a dial the provider knows; report it rather than
      // forwarding a parameter that means nothing.
      delete next.think;
    }
  }
  if (next.think !== undefined || next.enable_thinking !== undefined || next.reasoning_effort !== undefined) {
    // Normalize Ollama's boolean `think` into a dialect the upstream honours.
    //
    // `enable_thinking` is NOT universal: measured against ZenMux
    // deepseek/deepseek-v4.1-flash on 2026-11-07, `enable_thinking:false` still
    // billed 455 reasoning tokens (ignored), while `reasoning_effort:'none'` and
    // `thinking:{type:'disabled'}` both produced 0. Translating `think:false`
    // into enable_thinking made the caller's "off" a no-op, so an Ollama-wire
    // client could not actually disable thinking on that provider.
    const wantsOff = next.think === false
      || next.enable_thinking === false
      || (isObject(next.thinking) && next.thinking.type === 'disabled')
      || next.reasoning_effort === 'none';
    const explicitOn = next.think === true
      || next.enable_thinking === true
      || (isObject(next.thinking) && next.thinking.type === 'enabled');

    if (wantsOff) {
      // Both portable dialects, so any provider that understands either one obeys.
      next.reasoning_effort = 'none';
      next.thinking = { type: 'disabled' };
      delete next.enable_thinking;
    } else if (explicitOn) {
      // Send the level we resolved from a `think` string, else keep the caller's rich shape.
      // Only invent `enable_thinking` when no explicit effort was chosen, because a level is the
      // more precise signal and adding a second key can make a provider ignore the first.
      if (next.reasoning_effort === undefined
        && next.think === true
        && next.enable_thinking === undefined
        && next.thinking === undefined) {
        next.enable_thinking = true;
      }
    }
  }
  delete next.think;
    return next as T;
}
