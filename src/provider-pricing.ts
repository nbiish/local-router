import { resolveGatewayPresentedLegacyId } from './gateway-provider-catalog';

export type ProviderPricingEntry = {
  inputPricePerM: number;
  outputPricePerM: number;
  /** USD per 1M tokens for cached input reads (e.g. ZDR enhanced inference). */
  cacheReadPricePerM?: number;
  label?: string;
  validUntil?: string;
  sourceUrl?: string;
  updatedAt?: string;
};

/** USD per 1M tokens — router baseline rates. */
export const BASELINE_PROVIDER_PRICING: Record<string, ProviderPricingEntry> = {
  'openrouter-qwen3.7-max': {
    inputPricePerM: 1.25,
    outputPricePerM: 3.75,
    label: 'OpenRouter qwen/qwen3.7-max — matched ZenMux promo',
    sourceUrl: 'https://openrouter.ai/api/v1/models'
  },
  'zenmux-qwen3.7-max': {
    inputPricePerM: 1.25,
    outputPricePerM: 3.75,
    label: 'ZenMux qwen/qwen3.7-max — matched OpenRouter promo',
    sourceUrl: 'https://zenmux.ai/models',
    validUntil: '2026-06-11'
  },
  'wafer-ai-minimax-m3': {
    inputPricePerM: 0.33,
    outputPricePerM: 1.32,
    label: 'Wafer serverless MiniMax-M3 promo (live API 2026-06-04)',
    sourceUrl: 'https://pass.wafer.ai/v1/models',
    validUntil: '2026-06-11'
  },
  'wafer-ai-deepseek-v4-pro': {
    inputPricePerM: 1.2,
    outputPricePerM: 2.4,
    cacheReadPricePerM: 0.1,
    label: 'Wafer serverless DeepSeek V4 Pro (ZDR enhanced inference, 2026-06-12)',
    sourceUrl: 'https://pass.wafer.ai/v1/models'
  },
  'zenmux-minimax-m3': {
    inputPricePerM: 0.3,
    outputPricePerM: 1.2,
    label: 'ZenMux MiniMax M3 intro 50% off',
    sourceUrl: 'https://zenmux.ai/models'
  },
  'opencode-go-minimax-m3': {
    inputPricePerM: 0.3,
    outputPricePerM: 1.2,
    label: 'OpenCode Go MiniMax M3 subscription',
    sourceUrl: 'https://opencode.ai/zen/go/v1/models'
  },
  'opencode-zen-minimax-m3-free': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'OpenCode Zen MiniMax M3 free tier'
  },
  'nvidia-nim-minimax-m3': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'NVIDIA NIM MiniMax M3 free tier (June 2026)',
    sourceUrl: 'https://integrate.api.nvidia.com/v1/models'
  },
  'zenmux-mimo-v2.5-pro': {
    inputPricePerM: 0.44,
    outputPricePerM: 0.88,
    label: 'ZenMux xiaomi/mimo-v2.5-pro fallback paid tail',
    sourceUrl: 'https://zenmux.ai/models'
  },
  'nebius-nemotron-3-ultra-550b-a55b': {
    inputPricePerM: 0.5,
    outputPricePerM: 1,
    label: 'Nebius nvidia/Nemotron-3-Ultra-550b-a55b paid fallback tail'
  },
  'kilo-stepfun-step-3.7-flash-free': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Kilo Gateway stepfun/step-3.7-flash:free',
    sourceUrl: 'https://api.kilo.ai/api/gateway/models'
  },
  'kilo-nvidia-nemotron-3-super-120b-a12b-free': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Kilo Gateway nvidia/nemotron-3-super-120b-a12b:free',
    sourceUrl: 'https://api.kilo.ai/api/gateway/models'
  },
  'cline-nvidia-nemotron-3-ultra-550b-a55b-free': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Cline API nvidia/nemotron-3-ultra-550b-a55b:free'
  },
  'cline-minimax-minimax-m3-free': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Cline API minimax/minimax-m3 free tier'
  },
  'cline-xiaomi-mimo-v2.5-free': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Cline API xiaomi/mimo-v2.5 free tier'
  },
  'cline-deepseek-deepseek-v4-flash-free': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Cline API deepseek/deepseek-v4-flash free tier'
  },
  'cline-deepseek-deepseek-v4-pro-paid': {
    inputPricePerM: 0.5,
    outputPricePerM: 1,
    label: 'Cline API deepseek/deepseek-v4-pro paid'
  },
  'cline-deepseek-deepseek-chat-paid': {
    inputPricePerM: 0.5,
    outputPricePerM: 1,
    label: 'Cline API deepseek/deepseek-chat paid'
  },
  'cline-z-ai-glm-5.1-paid': {
    inputPricePerM: 0.5,
    outputPricePerM: 1,
    label: 'Cline API z-ai/glm-5.1 paid'
  },
  'cline-qwen-qwen3.7-max-paid': {
    inputPricePerM: 1.25,
    outputPricePerM: 3.75,
    label: 'Cline API qwen/qwen3.7-max paid'
  },
  'cline-stepfun-step-3.7-flash-paid': {
    inputPricePerM: 0.1,
    outputPricePerM: 0.3,
    label: 'Cline API stepfun/step-3.7-flash paid'
  },
  'cline-xiaomi-mimo-v2.5-pro-paid': {
    inputPricePerM: 0.44,
    outputPricePerM: 0.88,
    label: 'Cline API xiaomi/mimo-v2.5-pro paid'
  },
  'cline-moonshotai-kimi-k2.6-paid': {
    inputPricePerM: 0.6,
    outputPricePerM: 2.5,
    label: 'Cline API moonshotai/kimi-k2.6 paid'
  },
  'nous-portal-step-3.7-flash-free': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Nous Portal stepfun/step-3.7-flash:free (free tier on subscription)',
    sourceUrl: 'https://inference-api.nousresearch.com/v1/models'
  },
  'nous-portal-minimax-m3': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Nous Portal minimax/minimax-m3 (subscription, plan-billed)',
    sourceUrl: 'https://inference-api.nousresearch.com/v1/models',
    validUntil: '2026-12-31'
  },
  'zai-code-pass-glm-4.6v': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Z.ai zai-org/GLM-4.6v (vision variant, subscription via Z.ai coding plan)',
    sourceUrl: 'https://api.z.ai/api/coding/paas/v4/models',
    validUntil: '2026-12-31'
  },
  'commandcode-minimax-m3': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'CommandCode minimax/minimax-m3 (subscription via 4x-deal plan)',
    sourceUrl: 'https://api.commandcode.ai/provider/v1',
    validUntil: '2026-12-31'
  },
  'openrouter-kimi-k2.7-code': {
    inputPricePerM: 0.95,
    outputPricePerM: 4,
    label: 'OpenRouter moonshotai/kimi-k2.7-code paid',
    sourceUrl: 'https://openrouter.ai/api/v1/models'
  },
  'openrouter-free': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'OpenRouter openrouter/free'
  },
  'kilo-openrouter-free': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Kilo Gateway openrouter/free'
  },
  'kilo-nvidia-nemotron-3-ultra-550b-a55b-free': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Kilo Gateway nvidia/nemotron-3-ultra-550b-a55b:free'
  },
  'zenmux-deepseek-v4-flash': {
    inputPricePerM: 0.5,
    outputPricePerM: 1,
    label: 'ZenMux deepseek/deepseek-v4-flash'
  },
  'openrouter-deepseek-v4-flash': {
    inputPricePerM: 0.5,
    outputPricePerM: 1,
    label: 'OpenRouter deepseek/deepseek-v4-flash'
  },
  'kilo-deepseek-deepseek-v4-flash-paid': {
    inputPricePerM: 0.5,
    outputPricePerM: 1,
    label: 'Kilo Gateway deepseek/deepseek-v4-flash'
  },
  'kilo-deepseek-deepseek-v4-pro-paid': {
    inputPricePerM: 0.5,
    outputPricePerM: 1,
    label: 'Kilo Gateway deepseek/deepseek-v4-pro paid'
  },
  'kilo-deepseek-deepseek-chat-paid': {
    inputPricePerM: 0.5,
    outputPricePerM: 1,
    label: 'Kilo Gateway deepseek/deepseek-chat paid'
  },
  'kilo-z-ai-glm-5.1-paid': {
    inputPricePerM: 0.5,
    outputPricePerM: 1,
    label: 'Kilo Gateway z-ai/glm-5.1 paid'
  },
  'kilo-qwen-qwen3.7-max-paid': {
    inputPricePerM: 1.25,
    outputPricePerM: 3.75,
    label: 'Kilo Gateway qwen/qwen3.7-max paid'
  },
  'kilo-minimax-minimax-m3-paid': {
    inputPricePerM: 0.3,
    outputPricePerM: 1.2,
    label: 'Kilo Gateway minimax/minimax-m3 paid'
  },
  'kilo-stepfun-step-3.7-flash-paid': {
    inputPricePerM: 0.1,
    outputPricePerM: 0.3,
    label: 'Kilo Gateway stepfun/step-3.7-flash paid'
  },
  'kilo-xiaomi-mimo-v2.5-pro-paid': {
    inputPricePerM: 0.44,
    outputPricePerM: 0.88,
    label: 'Kilo Gateway xiaomi/mimo-v2.5-pro paid'
  },
  'kilo-xiaomi-mimo-v2.5-paid': {
    inputPricePerM: 0.15,
    outputPricePerM: 0.29,
    label: 'Kilo Gateway xiaomi/mimo-v2.5 paid'
  },
  'kilo-moonshotai-kimi-k2.7-code-paid': {
    inputPricePerM: 0.6,
    outputPricePerM: 2.5,
    label: 'Kilo Gateway moonshotai/kimi-k2.7-code paid'
  },
  'kilo-nvidia-nemotron-3-nano-omni-30b-a3b-reasoning-free': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Kilo Gateway nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free'
  },
  'kilo-poolside-laguna-m.1-free': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Kilo Gateway poolside/laguna-m.1:free'
  },
  'kilo-poolside-laguna-xs.2-free': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Kilo Gateway poolside/laguna-xs.2:free'
  },
  'modal-proxy-kimi-k3': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Modal Nbiish moonshotai/Kimi-K3 (own deployment, compute-billed)',
    sourceUrl: 'https://nbiish--ep-kimi-k3-nbiish-server.us-west.modal.direct/v1'
  }
};

function isPricingEntryExpired(entry: ProviderPricingEntry): boolean {
  if (!entry.validUntil) return false;
  const end = new Date(`${entry.validUntil}T23:59:59.999Z`);
  return Number.isFinite(end.getTime()) && end.getTime() < Date.now();
}

function cloneEntry(entry: ProviderPricingEntry): ProviderPricingEntry {
  return { ...entry };
}

/**
 * Baseline catalog pricing + automatic free-tier detection.
 * Returns undefined when pricing cannot be detected so the caller/user can account for it independently.
 */
export function getProviderPricingEntry(modelId: string): ProviderPricingEntry | undefined {
  const trimmed = resolveGatewayPresentedLegacyId(String(modelId || '').trim());
  if (!trimmed) return undefined;

  const baseline = BASELINE_PROVIDER_PRICING[trimmed];
  if (baseline && !isPricingEntryExpired(baseline)) {
    return cloneEntry(baseline);
  }

  // Automatic free-tier detection
  const lower = trimmed.toLowerCase();
  if (lower.endsWith('-free') || lower.includes(':free') || lower.endsWith('/free') || lower === 'openrouter-free') {
    return {
      inputPricePerM: 0,
      outputPricePerM: 0,
      cacheReadPricePerM: 0,
      label: 'Free tier'
    };
  }

  return undefined;
}
