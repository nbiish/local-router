/**
 * Routing Capabilities & Candidate Filtering
 *
 * Dynamically evaluates context token requirements and multimodal payload constraints
 * to select eligible models in fallback chains.
 */

export interface ModelCapabilitySpecs {
  id?: string;
  contextLength: number;
  outputTokens: number;
  supportsImages: boolean;
  supportsTools: boolean;
  supportsCache?: boolean;
  supportsReasoning?: boolean;
}

export interface SkippedCandidate {
  model: string;
  reason: 'context_window_too_small' | 'no_multimodal_support' | 'unconfigured_key';
  contextLength: number;
  supportsImages: boolean;
}

export interface FallbackFilterResult {
  eligible: string[];
  skipped: SkippedCandidate[];
  requiredContext: number;
  requiresMultimodal: boolean;
  error?: 'no_multimodal_models' | 'chain_empty';
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
  const outputTokens = Number.isFinite(requestedOutput) && requestedOutput > 0 ? requestedOutput : 4096;

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
 * Filters the active fallback chain candidates against context and multimodal requirements.
 */
export function filterEligibleFallbackModels(
  activeModels: string[],
  body: any,
  getSpecs: (modelId: string) => ModelCapabilitySpecs
): FallbackFilterResult {
  const requiredContext = estimateRequestContext(body);
  const requiresMultimodal = requestRequiresMultimodal(body);

  if (activeModels.length === 0) {
    return {
      eligible: [],
      skipped: [],
      requiredContext,
      requiresMultimodal,
      error: 'chain_empty'
    };
  }

  const candidatesWithSpecs = activeModels.map((modelId) => {
    const specs = getSpecs(modelId);
    return {
      modelId,
      contextLength: specs.contextLength || 64000,
      supportsImages: Boolean(specs.supportsImages)
    };
  });

  const eligible: string[] = [];
  const skipped: SkippedCandidate[] = [];

  // Step 1: Multimodal filter
  let multimodalFiltered = candidatesWithSpecs;
  if (requiresMultimodal) {
    multimodalFiltered = [];
    for (const c of candidatesWithSpecs) {
      if (c.supportsImages) {
        multimodalFiltered.push(c);
      } else {
        skipped.push({
          model: c.modelId,
          reason: 'no_multimodal_support',
          contextLength: c.contextLength,
          supportsImages: false
        });
      }
    }

    if (multimodalFiltered.length === 0) {
      return {
        eligible: [],
        skipped,
        requiredContext,
        requiresMultimodal,
        error: 'no_multimodal_models'
      };
    }
  }

  // Step 2: Context length filter
  for (const c of multimodalFiltered) {
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

  // Step 3: If no candidate has enough context (e.g. prompt is 1.5M tokens),
  // rather than failing with 0 attempts, pick the largest available models
  // in the active chain so we attempt execution on the best-capacity targets.
  if (eligible.length === 0 && multimodalFiltered.length > 0) {
    const maxContext = Math.max(...multimodalFiltered.map((c) => c.contextLength));
    for (const c of multimodalFiltered) {
      if (c.contextLength === maxContext) {
        eligible.push(c.modelId);
      }
    }
  }

  return {
    eligible,
    skipped,
    requiredContext,
    requiresMultimodal
  };
}
