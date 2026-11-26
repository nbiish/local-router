/**
 * Routing Capabilities & Candidate Filtering
 *
 * Dynamically evaluates context token requirements and multimodal payload constraints
 * to select eligible models in fallback chains.
 */

/**
 * Ceiling on the output headroom folded into a context requirement.
 *
 * A context requirement is input + output, but a client's output ask is not a
 * trustworthy measurement of it: several harnesses send a huge `max_tokens` to
 * mean "no limit" (measured: 943718), which would otherwise demand a 945K-token
 * context for a two-message prompt and exclude most of the chain.
 */
export const MAX_OUTPUT_HEADROOM_TOKENS = 32768;
const DEFAULT_OUTPUT_HEADROOM_TOKENS = 4096;

export interface ModelCapabilitySpecs {
  id?: string;
  contextLength: number;
  outputTokens: number;
  supportsImages: boolean;
  supportsTools: boolean;
  supportsCache?: boolean;
  /** Does this model reason at all (capability)? */
  supportsReasoning?: boolean;
  /**
   * How many selectable thinking levels it exposes (0 = no request dial).
   * Distinct from `supportsReasoning`: a model can reason at one fixed depth and
   * still have no dial, so it cannot honour a caller-chosen level.
   */
  reasoningLevelCount?: number;
}

export interface SkippedCandidate {
  model: string;
  reason: 'context_window_too_small' | 'no_multimodal_support' | 'no_tools_support' | 'unconfigured_key' | 'no_reasoning_dial';
  contextLength: number;
  supportsImages: boolean;
  supportsTools?: boolean;
}

export interface FallbackFilterResult {
  eligible: string[];
  /**
   * Members that can serve the request only by running at their own fixed
   * reasoning depth, because the caller chose a thinking level they cannot be
   * told. Ordered exactly like `eligible`, and attempted ONLY after every
   * `eligible` member has failed. The caller's level is not honoured here, so
   * accepting one of these is a recorded downgrade, never a silent success.
   */
  degraded: string[];
  skipped: SkippedCandidate[];
  requiredContext: number;
  requiresMultimodal: boolean;
  requiresTools: boolean;
  /** True when the caller expressed a thinking intent and so needs a real dial. */
  requiresReasoningDial: boolean;
  /**
   * `no_reasoning_models` is retained for readers built before the tier-2 tail
   * existed; it is no longer produced, because a chain with no dial-capable
   * member now serves the request through `degraded` instead of failing.
   */
  error?: 'no_multimodal_models' | 'no_tools_models' | 'chain_empty' | 'no_reasoning_models';
}

/**
 * Heuristic conservative estimate of request token count (input + expected output headroom).
 * Uses UTF-8 character length ratio (~3.2 chars/token) + image vision token budget (~1,200/image).
 */
export function estimateRequestContext(body: any): number {
  if (!body || typeof body !== 'object') return 4096;

  let textChars = 0;
  let imageCount = 0;

  // 1. Messages
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!msg) continue;
      if (typeof msg.content === 'string') {
        textChars += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (!part) continue;
          if (part.type === 'text' && typeof part.text === 'string') {
            textChars += part.text.length;
          } else if (
            part.type === 'image_url' ||
            part.type === 'image' ||
            part.type === 'input_image' ||
            Boolean(part.image_url)
          ) {
            imageCount += 1;
          } else if (typeof part === 'string') {
            textChars += (part as string).length;
          }
        }
      }

      // Ollama per-message image attachments
      if (Array.isArray(msg.images)) {
        imageCount += msg.images.length;
      }
    }
  }

  // 2. Prompt (Ollama / legacy completions)
  if (typeof body.prompt === 'string') {
    textChars += body.prompt.length;
  } else if (Array.isArray(body.prompt)) {
    for (const p of body.prompt) {
      if (typeof p === 'string') textChars += p.length;
    }
  }

  // 3. System prompt
  if (typeof body.system === 'string') {
    textChars += body.system.length;
  }

  // 4. Root Ollama images array
  if (Array.isArray(body.images)) {
    imageCount += body.images.length;
  }

  // 5. Tools / functions definition overhead
  if (Array.isArray(body.tools)) {
    try {
      textChars += JSON.stringify(body.tools).length;
    } catch {
      // ignore serialization failure
    }
  } else if (Array.isArray(body.functions)) {
    try {
      textChars += JSON.stringify(body.functions).length;
    } catch {
      // ignore
    }
  }

  const estimatedInputTokens = Math.ceil(textChars / 3.2);
  const imageTokens = imageCount * 1200;
  const requestedOutput = Number(body.max_tokens || body.max_completion_tokens || 4096);
  // Output headroom belongs in a context requirement — a model must be able to
  // hold the prompt AND produce the answer — but the caller's raw ask cannot.
  // Measured live 2026-11-20: clients send `max_tokens: 943718` as a
  // "no limit" default, which drove the requirement to 945,635 tokens and
  // excluded every chain member below that, leaving 10 eligible of 18 for a
  // two-message prompt. The headroom is capped at a ceiling no fallback step
  // needs, so an absurd budget can no longer empty the chain, while a real
  // large-output request still requires a model with room to satisfy it.
  const outputTokens = Number.isFinite(requestedOutput) && requestedOutput > 0
    ? Math.min(requestedOutput, MAX_OUTPUT_HEADROOM_TOKENS)
    : DEFAULT_OUTPUT_HEADROOM_TOKENS;

  return Math.max(estimatedInputTokens + imageTokens + outputTokens, 1024);
}

/**
 * Returns true if the request contains image or visual multimodal parts.
 */
export function requestRequiresMultimodal(body: any): boolean {
  if (!body || typeof body !== 'object') return false;

  // Root Ollama images array
  if (Array.isArray(body.images) && body.images.length > 0) {
    return true;
  }

  // Messages examination
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!msg) continue;
      if (Array.isArray(msg.images) && msg.images.length > 0) {
        return true;
      }
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (!part) continue;
          if (
            part.type === 'image_url' ||
            part.type === 'image' ||
            part.type === 'input_image' ||
            Boolean(part.image_url)
          ) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

/**
 * Returns true when the request needs a model that can call tools.
 *
 * Sticky across the session, like `requestRequiresMultimodal`: tool calls and
 * tool results live in the history, so a chat that started with tools keeps
 * requiring them on every later turn. A member that cannot call tools must be
 * skipped rather than handed a tool request it would answer without tools — a
 * "successful" turn that silently dropped the caller's tool.
 */
export function requestRequiresTools(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;

  // Tool declarations on the request itself.
  if ('tools' in body && Array.isArray(body.tools) && body.tools.length > 0) return true;
  if ('functions' in body && Array.isArray(body.functions) && body.functions.length > 0) return true;

  // Messages examination (history): tool calls, tool results, tool blocks.
  if ('messages' in body && Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!msg || typeof msg !== 'object') continue;
      if ('role' in msg && (msg.role === 'tool' || msg.role === 'function')) return true;
      if ('tool_calls' in msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return true;
      if ('function_call' in msg && msg.function_call && typeof msg.function_call === 'object') return true;
      if ('content' in msg && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (!part || typeof part !== 'object' || !('type' in part)) continue;
          const type = part.type;
          if (
            type === 'tool_use' ||
            type === 'tool_result' ||
            type === 'tool_output' ||
            type === 'function_call' ||
            type === 'function_result' ||
            type === 'function_call_output'
          ) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

/**
 * Does the request express a thinking intent that a model without a request dial
 * could not honour?
 *
 * Any explicit level counts, including "off": a model with no dial cannot be
 * told to stop thinking either, so "no dial" is not eligible for a caller who
 * asked for `none`. A request that says nothing about thinking needs nothing —
 * that is the common case and stays untouched.
 */
export function requestRequiresReasoningDial(body: any): boolean {
  if (!body || typeof body !== 'object') return false;

  const extra = body.extra_body && typeof body.extra_body === 'object' ? body.extra_body : {};
  const thinking = body.thinking && typeof body.thinking === 'object' ? body.thinking : undefined;

  if (typeof body.think === 'boolean') return true;
  if (typeof body.enable_thinking === 'boolean') return true;
  if (typeof body.reasoning_effort === 'string' && body.reasoning_effort.trim()) return true;
  if (thinking) {
    if (thinking.type === 'enabled' || thinking.type === 'disabled') return true;
    if (typeof thinking.enabled === 'boolean') return true;
    if (typeof thinking.budget_tokens === 'number') return true;
  }
  if (typeof extra.enable_thinking === 'boolean') return true;
  if (typeof extra.reasoning_effort === 'string' && extra.reasoning_effort.trim()) return true;
  if (typeof extra.reasoning_budget === 'number') return true;

  return false;
}

/**
 * Filters the active fallback chain candidates against context and multimodal requirements.
 */
export function filterEligibleFallbackModels(
  activeModels: string[],
  body: any,
  getSpecs: (modelId: string) => ModelCapabilitySpecs
): FallbackFilterResult {
  const requiredContext = estimateRequestContext(body);
  const requiresMultimodal = requestRequiresMultimodal(body);
  const requiresTools = requestRequiresTools(body);
  const requiresReasoningDial = requestRequiresReasoningDial(body);

  if (activeModels.length === 0) {
    return {
      eligible: [],
      degraded: [],
      skipped: [],
      requiredContext,
      requiresMultimodal,
      requiresTools,
      requiresReasoningDial,
      error: 'chain_empty'
    };
  }

  const candidatesWithSpecs = activeModels.map((modelId) => {
    const specs = getSpecs(modelId);
    return {
      modelId,
      contextLength: specs.contextLength || 64000,
      supportsImages: Boolean(specs.supportsImages),
      supportsTools: Boolean(specs.supportsTools),
      reasoningLevelCount: Number(specs.reasoningLevelCount) || 0
    };
  });

  const eligible: string[] = [];
  const skipped: SkippedCandidate[] = [];

  // Step 1: Multimodal filter
  let candidates = candidatesWithSpecs;
  if (requiresMultimodal) {
    candidates = [];
    for (const c of candidatesWithSpecs) {
      if (c.supportsImages) {
        candidates.push(c);
      } else {
        skipped.push({
          model: c.modelId,
          reason: 'no_multimodal_support',
          contextLength: c.contextLength,
          supportsImages: false
        });
      }
    }

    if (candidates.length === 0) {
      return {
        eligible: [],
        degraded: [],
        skipped,
        requiredContext,
        requiresMultimodal,
        requiresTools,
        requiresReasoningDial,
        error: 'no_multimodal_models'
      };
    }
  }

  // Step 1.5: Tools filter — the same hard-skip shape as multimodal. A model
  // that cannot call tools must not receive a tool request: upstream it either
  // errors (a wasted attempt) or answers with the caller's tools silently
  // ignored — the silent downgrade this gate replaces with a recorded skip.
  if (requiresTools) {
    const toolCapable: typeof candidatesWithSpecs = [];
    for (const c of candidates) {
      if (c.supportsTools) {
        toolCapable.push(c);
      } else {
        skipped.push({
          model: c.modelId,
          reason: 'no_tools_support',
          contextLength: c.contextLength,
          supportsImages: c.supportsImages,
          supportsTools: false
        });
      }
    }
    candidates = toolCapable;
    if (candidates.length === 0) {
      return {
        eligible: [],
        degraded: [],
        skipped,
        requiredContext,
        requiresMultimodal,
        requiresTools,
        requiresReasoningDial,
        error: 'no_tools_models'
      };
    }
  }

  // Step 2: Reasoning-dial partition.
  //
  // A caller who chose a thinking level prefers a model that can be TOLD a
  // level. Sending the request to a model with no request dial runs at that
  // model's own fixed depth, so the caller's setting would appear to work and do
  // nothing — the silent downgrade this gate exists to prevent.
  //
  // The original fix was to EXCLUDE such models outright. That prevented the
  // silent downgrade by removing capacity instead: measured live 2026-11-20,
  // four members (cursor-auto, github-copilot-auto, cursor-deepseek-v41-flash,
  // cursor-grok-4.7) were ineligible for 167 of 200 requests because a harness
  // sends `reasoning_effort` on nearly every turn — two paid subscriptions that
  // could never serve a single request. Exclusion traded a silent downgrade for
  // a silent outage.
  //
  // The partition keeps both properties: dial-capable members are tried first,
  // dial-less members are kept as an explicit tier-2 tail attempted only after
  // every dial-capable member has failed, and each tier-2 acceptance is recorded
  // as a downgrade in the trajectory. Capacity is preserved AND the downgrade is
  // stated rather than implied.
  let dialCapable = candidates;
  const dialLess: typeof candidatesWithSpecs = [];
  if (requiresReasoningDial) {
    dialCapable = [];
    for (const c of candidates) {
      if (c.reasoningLevelCount > 0) {
        dialCapable.push(c);
      } else {
        dialLess.push(c);
      }
    }
    // Every candidate lacks a dial: this is no longer an error but the whole
    // eligible set runs degraded. The caller is still served, and the record
    // says the level could not be honoured.
    if (dialCapable.length === 0) dialCapable = [];
    candidates = dialCapable;
  }

  // Step 3: Context length filter
  for (const c of candidates) {
    if (c.contextLength >= requiredContext) {
      eligible.push(c.modelId);
    } else {
      skipped.push({
        model: c.modelId,
        reason: 'context_window_too_small',
        contextLength: c.contextLength,
        supportsImages: c.supportsImages
      });
    }
  }

  // Step 4: If no candidate has enough context (e.g. prompt is 1.5M tokens),
  // rather than failing with 0 attempts, pick the largest available models
  // in the active chain so we attempt execution on the best-capacity targets.
  // `candidates` here is already narrowed by the vision, tools, and
  // reasoning-dial gates, so this fallback can never reintroduce a model that
  // fails them.
  if (eligible.length === 0 && candidates.length > 0) {
    const maxContext = Math.max(...candidates.map((c) => c.contextLength));
    for (const c of candidates) {
      if (c.contextLength === maxContext) {
        eligible.push(c.modelId);
      }
    }
  }

  // Step 5: The tier-2 tail. Context filtering applies exactly as it does to
  // tier 1: a member whose window cannot hold the prompt cannot serve it just
  // because it also lacks a dial.
  const degraded: string[] = [];
  const eligibleSet = new Set(eligible);
  for (const c of dialLess) {
    // Never let a member appear in both tiers. Step 4's widest-window rescue can
    // already have admitted it to `eligible`, and billing one model twice would
    // make the plan attempt it after it had just answered.
    if (eligibleSet.has(c.modelId)) continue;
    if (c.contextLength >= requiredContext) {
      degraded.push(c.modelId);
    } else {
      skipped.push({
        model: c.modelId,
        reason: 'context_window_too_small',
        contextLength: c.contextLength,
        supportsImages: c.supportsImages
      });
    }
  }
  if (degraded.length === 0 && dialLess.length > 0 && requiresReasoningDial) {
    // None of the dial-less members can hold the prompt either. Keep the widest
    // ones reachable rather than dropping the whole tier, mirroring Step 4.
    const maxContext = Math.max(...dialLess.map((c) => c.contextLength));
    for (const c of dialLess) {
      if (c.contextLength === maxContext && !eligibleSet.has(c.modelId)) degraded.push(c.modelId);
    }
  }

  return {
    eligible,
    degraded,
    skipped,
    requiredContext,
    requiresMultimodal,
    requiresTools,
    requiresReasoningDial
  };
}
