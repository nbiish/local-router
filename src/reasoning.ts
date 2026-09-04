type JsonObject = Record<string, any>;

export type ThinkingLevel = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium';

const RESPONSE_REASONING_KEYS = new Set([
  'reasoning_content',
  'reasoningContent',
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

function stripReasoningMetadataInternal(value: unknown, depth: number): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((item) => !isReasoningContentBlock(item))
      .map((item) => stripReasoningMetadataInternal(item, depth + 1));
  }

  if (!isObject(value)) return value;

  const output: JsonObject = {};

  for (const [key, child] of Object.entries(value)) {
    if (RESPONSE_REASONING_KEYS.has(key)) continue;
    if (depth > 0 && (key === 'thinking' || key === 'reasoning')) continue;

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
  options: {
    providerName: string;
    modelName: string;
    thinkingLevel?: ThinkingLevel;
    applyProxyThinking?: boolean;
  }
): T {
  // Explicit opt-out from any harness is honored unconditionally — even when
  // proxy-side thinking defaults are disabled.
  if (hasExplicitNoThinkingRequest(body)) {
    const sanitized = { ...body } as JsonObject;
    delete sanitized.think;
    return applyNoThinkingHints(sanitized) as T;
  }

  // Explicit opt-in / effort choice from any harness passes through verbatim
  // (normalized), overriding the proxy default level.
  if (hasExplicitThinkingRequest(body)) {
    return normalizeExplicitThinkingRequest(body) as T;
  }

  const level = options.thinkingLevel ?? DEFAULT_THINKING_LEVEL;

  // For native reasoning models with an explicit 'none' level, disable
  const isNativeReasoning = shouldDisableNativeThinking(options.providerName, options.modelName);
  if (isNativeReasoning && level === 'none') {
    return applyNoThinkingHints(body) as T;
  }

  // Apply configured thinking level
  const sanitized = { ...body } as JsonObject;
  delete sanitized.think;

  const thinkingParams = getThinkingRequestParams(level, options.providerName, options.modelName);

  // Merge thinking params, preserving existing extra_body
  const result: JsonObject = { ...sanitized };
  for (const [key, value] of Object.entries(thinkingParams)) {
    if (key === 'extra_body' && isObject(result.extra_body) && isObject(value)) {
      result.extra_body = { ...result.extra_body, ...value };
    } else {
      result[key] = value;
    }
  }

  return result as T;
}
