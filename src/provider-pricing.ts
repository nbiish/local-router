import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveGatewayPresentedLegacyId } from './gateway-provider-catalog';

export type ProviderPricingEntry = {
  inputPricePerM: number;
  outputPricePerM: number;
  label?: string;
  validUntil?: string;
  sourceUrl?: string;
  updatedAt?: string;
};

export type ProviderPricingSnapshot = {
  version: number;
  models: Record<string, ProviderPricingEntry>;
};

const LOCAL_ROUTER_CONFIG_DIR = path.join(os.homedir(), '.config', 'local-router');
export const PROVIDER_PRICING_PATH = path.join(LOCAL_ROUTER_CONFIG_DIR, 'provider-pricing.json');

/** USD per 1M tokens — router scoring + user-editable overrides. */
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
  'nous-portal-hermes-4-70b': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Nous Portal Hermes-4-70B subscription (Hermes Desktop/CLI plan)',
    sourceUrl: 'https://inference-api.nousresearch.com/v1/models',
    validUntil: '2026-12-31'
  },
  'nous-portal-hermes-4-405b': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Nous Portal Hermes-4-405B subscription (Hermes Desktop/CLI plan)',
    sourceUrl: 'https://inference-api.nousresearch.com/v1/models',
    validUntil: '2026-12-31'
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
  'nous-portal-deepseek-v4-pro': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Nous Portal deepseek/deepseek-v4-pro (subscription, plan-billed)',
    sourceUrl: 'https://inference-api.nousresearch.com/v1/models',
    validUntil: '2026-12-31'
  },
  'nous-portal-deepseek-v4-flash': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Nous Portal deepseek/deepseek-v4-flash (subscription, plan-billed)',
    sourceUrl: 'https://inference-api.nousresearch.com/v1/models',
    validUntil: '2026-12-31'
  },
  'nous-portal-qwen3.7-max': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Nous Portal qwen/qwen3.7-max (subscription, plan-billed)',
    sourceUrl: 'https://inference-api.nousresearch.com/v1/models',
    validUntil: '2026-12-31'
  },
  'nous-portal-qwen3.7-plus': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Nous Portal qwen/qwen3.7-plus (subscription, plan-billed)',
    sourceUrl: 'https://inference-api.nousresearch.com/v1/models',
    validUntil: '2026-12-31'
  },
  'nous-portal-qwen3.6-plus': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Nous Portal qwen/qwen3.6-plus (subscription, plan-billed)',
    sourceUrl: 'https://inference-api.nousresearch.com/v1/models',
    validUntil: '2026-12-31'
  },
  'nous-portal-qwen3-coder': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Nous Portal qwen/qwen3-coder (subscription, plan-billed)',
    sourceUrl: 'https://inference-api.nousresearch.com/v1/models',
    validUntil: '2026-12-31'
  },
  'nous-portal-glm-5.1': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Nous Portal z-ai/glm-5.1 (subscription, plan-billed)',
    sourceUrl: 'https://inference-api.nousresearch.com/v1/models',
    validUntil: '2026-12-31'
  },
  'nous-portal-kimi-k2.7-code': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Nous Portal moonshotai/kimi-k2.7-code (subscription, plan-billed)',
    sourceUrl: 'https://inference-api.nousresearch.com/v1/models',
    validUntil: '2026-12-31'
  },
  'nous-portal-kimi-latest': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Nous Portal ~moonshotai/kimi-latest pointer (subscription, plan-billed)',
    sourceUrl: 'https://inference-api.nousresearch.com/v1/models',
    validUntil: '2026-12-31'
  },
  'nous-portal-nemotron-3-ultra-550b-a55b': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Nous Portal nvidia/nemotron-3-ultra-550b-a55b (subscription, plan-billed)',
    sourceUrl: 'https://inference-api.nousresearch.com/v1/models',
    validUntil: '2026-12-31'
  },
  'nous-portal-nemotron-3-ultra-free': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Nous Portal nvidia/nemotron-3-ultra:free (free tier on subscription)',
    sourceUrl: 'https://inference-api.nousresearch.com/v1/models'
  },
  'nous-portal-step-3.5-flash': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Nous Portal stepfun/step-3.5-flash (subscription, plan-billed)',
    sourceUrl: 'https://inference-api.nousresearch.com/v1/models',
    validUntil: '2026-12-31'
  },
  'nous-portal-minimax-m2.7': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Nous Portal minimax/minimax-m2.7 (subscription, plan-billed)',
    sourceUrl: 'https://inference-api.nousresearch.com/v1/models',
    validUntil: '2026-12-31'
  },
  'nous-portal-claude-opus-4.8': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Nous Portal anthropic/claude-opus-4.8 (subscription, plan-billed)',
    sourceUrl: 'https://inference-api.nousresearch.com/v1/models',
    validUntil: '2026-12-31'
  },
  'nous-portal-claude-opus-latest': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Nous Portal ~anthropic/claude-opus-latest pointer (subscription, plan-billed)',
    sourceUrl: 'https://inference-api.nousresearch.com/v1/models',
    validUntil: '2026-12-31'
  },
  'nous-portal-claude-sonnet-latest': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Nous Portal ~anthropic/claude-sonnet-latest pointer (subscription, plan-billed)',
    sourceUrl: 'https://inference-api.nousresearch.com/v1/models',
    validUntil: '2026-12-31'
  },
  'nous-portal-gpt-latest': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Nous Portal ~openai/gpt-latest pointer (subscription, plan-billed)',
    sourceUrl: 'https://inference-api.nousresearch.com/v1/models',
    validUntil: '2026-12-31'
  },
  'nous-portal-gemini-pro-latest': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Nous Portal ~google/gemini-pro-latest pointer (subscription, plan-billed)',
    sourceUrl: 'https://inference-api.nousresearch.com/v1/models',
    validUntil: '2026-12-31'
  },
  'nous-portal-gemini-flash-latest': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Nous Portal ~google/gemini-flash-latest pointer (subscription, plan-billed)',
    sourceUrl: 'https://inference-api.nousresearch.com/v1/models',
    validUntil: '2026-12-31'
  },
  'nous-portal-gemini-3.5-flash': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Nous Portal google/gemini-3.5-flash (subscription, plan-billed)',
    sourceUrl: 'https://inference-api.nousresearch.com/v1/models',
    validUntil: '2026-12-31'
  },
  'nous-portal-grok-4.3': {
    inputPricePerM: 0,
    outputPricePerM: 0,
    label: 'Nous Portal x-ai/grok-4.3 (subscription, plan-billed)',
    sourceUrl: 'https://inference-api.nousresearch.com/v1/models',
    validUntil: '2026-12-31'
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
  }
};

const providerPricingStore: Record<string, ProviderPricingEntry> = {};

function ensureConfigDir() {
  fs.mkdirSync(LOCAL_ROUTER_CONFIG_DIR, { recursive: true });
}

function isPricingEntryExpired(entry: ProviderPricingEntry): boolean {
  if (!entry.validUntil) return false;
  const end = new Date(`${entry.validUntil}T23:59:59.999Z`);
  return Number.isFinite(end.getTime()) && end.getTime() < Date.now();
}

function cloneEntry(entry: ProviderPricingEntry): ProviderPricingEntry {
  return { ...entry };
}

export function getProviderPricingStore(): Record<string, ProviderPricingEntry> {
  return providerPricingStore;
}

/** Baseline + persisted override (non-expired) for routing tier heuristics. */
export function getProviderPricingEntry(modelId: string): ProviderPricingEntry | undefined {
  const trimmed = resolveGatewayPresentedLegacyId(String(modelId || '').trim());
  if (!trimmed) return undefined;

  const override = providerPricingStore[trimmed];
  if (override && !isPricingEntryExpired(override)) {
    return cloneEntry(override);
  }

  const baseline = BASELINE_PROVIDER_PRICING[trimmed];
  return baseline ? cloneEntry(baseline) : undefined;
}

export function getProviderPricingSnapshot(): ProviderPricingSnapshot {
  const models = Object.fromEntries(
    Object.entries(providerPricingStore).map(([modelId, entry]) => [modelId, cloneEntry(entry)])
  );
  return { version: 1, models };
}

export function resolveEffectiveCandidatePricing(
  modelId: string,
  fallback?: { inputPrice?: number; outputPrice?: number }
): { inputPrice?: number; outputPrice?: number; pricingLabel?: string; pricingExpired?: boolean } {
  const override = providerPricingStore[modelId];
  if (override && !isPricingEntryExpired(override)) {
    return {
      inputPrice: override.inputPricePerM,
      outputPrice: override.outputPricePerM,
      pricingLabel: override.label
    };
  }

  if (override && isPricingEntryExpired(override)) {
    return {
      inputPrice: fallback?.inputPrice,
      outputPrice: fallback?.outputPrice,
      pricingLabel: override.label,
      pricingExpired: true
    };
  }

  return {
    inputPrice: fallback?.inputPrice,
    outputPrice: fallback?.outputPrice
  };
}

export function loadProviderPricingStore(): void {
  ensureConfigDir();
  Object.keys(providerPricingStore).forEach((key) => delete providerPricingStore[key]);

  for (const [modelId, entry] of Object.entries(BASELINE_PROVIDER_PRICING)) {
    providerPricingStore[modelId] = cloneEntry({
      ...entry,
      updatedAt: entry.updatedAt || new Date().toISOString()
    });
  }

  if (!fs.existsSync(PROVIDER_PRICING_PATH)) {
    persistProviderPricingStore();
    return;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(PROVIDER_PRICING_PATH, 'utf8')) as ProviderPricingSnapshot;
    const models = parsed?.models && typeof parsed.models === 'object' ? parsed.models : {};
    for (const [modelId, entry] of Object.entries(models)) {
      if (!entry || typeof entry !== 'object') continue;
      const inputPricePerM = Number(entry.inputPricePerM);
      const outputPricePerM = Number(entry.outputPricePerM);
      if (!Number.isFinite(inputPricePerM) || !Number.isFinite(outputPricePerM)) continue;
      providerPricingStore[modelId] = {
        inputPricePerM,
        outputPricePerM,
        label: typeof entry.label === 'string' ? entry.label : undefined,
        validUntil: typeof entry.validUntil === 'string' ? entry.validUntil : undefined,
        sourceUrl: typeof entry.sourceUrl === 'string' ? entry.sourceUrl : undefined,
        updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date().toISOString()
      };
    }
  } catch (error) {
    console.error('Failed to load provider pricing overrides:', error);
  }

  migrateLegacyQwen37MaxPricing();
}

const LEGACY_QWEN37_MAX_PRICING = { inputPricePerM: 2.5, outputPricePerM: 7.5 };
const QWEN37_MAX_PRESENTED_IDS = ['openrouter-qwen3.7-max', 'zenmux-qwen3.7-max'] as const;

function migrateLegacyQwen37MaxPricing(): void {
  let changed = false;
  for (const modelId of QWEN37_MAX_PRESENTED_IDS) {
    const entry = providerPricingStore[modelId];
    if (
      !entry
      || entry.inputPricePerM !== LEGACY_QWEN37_MAX_PRICING.inputPricePerM
      || entry.outputPricePerM !== LEGACY_QWEN37_MAX_PRICING.outputPricePerM
    ) {
      continue;
    }
    providerPricingStore[modelId] = {
      ...entry,
      inputPricePerM: BASELINE_PROVIDER_PRICING[modelId].inputPricePerM,
      outputPricePerM: BASELINE_PROVIDER_PRICING[modelId].outputPricePerM,
      label: BASELINE_PROVIDER_PRICING[modelId].label,
      updatedAt: new Date().toISOString()
    };
    changed = true;
  }
  if (changed) {
    persistProviderPricingStore();
  }
}

export function persistProviderPricingStore(): void {
  ensureConfigDir();
  const temporaryPath = `${PROVIDER_PRICING_PATH}.${process.pid}.tmp`;
  const payload: ProviderPricingSnapshot = getProviderPricingSnapshot();
  fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  fs.renameSync(temporaryPath, PROVIDER_PRICING_PATH);
  fs.chmodSync(PROVIDER_PRICING_PATH, 0o600);
}

export function upsertProviderPricingEntry(
  modelId: string,
  entry: Partial<ProviderPricingEntry>
): ProviderPricingEntry {
  const trimmed = modelId.trim();
  if (!trimmed) {
    throw new Error('modelId is required.');
  }
  const inputPricePerM = Number(entry.inputPricePerM);
  const outputPricePerM = Number(entry.outputPricePerM);
  if (!Number.isFinite(inputPricePerM) || inputPricePerM < 0) {
    throw new Error('inputPricePerM must be a non-negative number.');
  }
  if (!Number.isFinite(outputPricePerM) || outputPricePerM < 0) {
    throw new Error('outputPricePerM must be a non-negative number.');
  }

  const next: ProviderPricingEntry = {
    inputPricePerM,
    outputPricePerM,
    label: typeof entry.label === 'string' ? entry.label.trim() : undefined,
    validUntil: typeof entry.validUntil === 'string' ? entry.validUntil.trim() : undefined,
    sourceUrl: typeof entry.sourceUrl === 'string' ? entry.sourceUrl.trim() : undefined,
    updatedAt: new Date().toISOString()
  };
  providerPricingStore[trimmed] = next;
  persistProviderPricingStore();
  return cloneEntry(next);
}

export function deleteProviderPricingEntry(modelId: string): boolean {
  const trimmed = modelId.trim();
  if (!trimmed || !providerPricingStore[trimmed]) return false;
  delete providerPricingStore[trimmed];
  if (BASELINE_PROVIDER_PRICING[trimmed]) {
    providerPricingStore[trimmed] = cloneEntry({
      ...BASELINE_PROVIDER_PRICING[trimmed],
      updatedAt: new Date().toISOString()
    });
  }
  persistProviderPricingStore();
  return true;
}

export function applyPricingToRouterCandidates<
  T extends { model: string; inputPrice?: number; outputPrice?: number }
>(candidates: T[]): T[] {
  return candidates.map((candidate) => {
    const resolved = resolveEffectiveCandidatePricing(candidate.model, {
      inputPrice: candidate.inputPrice,
      outputPrice: candidate.outputPrice
    });
    return {
      ...candidate,
      inputPrice: resolved.inputPrice,
      outputPrice: resolved.outputPrice
    };
  });
}
