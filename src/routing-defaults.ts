/**
 * Default auto-router and fallback-model candidate lists (tier-ordered at bootstrap).
 */

import {
  DEEPSEEK_V4_FLASH_PAID_PRESENTED_IDS,
  stableSortModelIdsByRoutingExhaustion,
  type CatalogModelRef
} from './routing-exhaustion-order';

export { DEEPSEEK_V4_FLASH_PAID_PRESENTED_IDS };

/** Ollama Cloud free-tier routing tags. */
const OLLAMA_FREE_CANDIDATES = [
  'ollama-nemotron-3-ultra-cloud, coding=0.86, input=0, output=0, latency=850, notes=Ollama Cloud Nemotron 3 Ultra (free tier)',
  'ollama-minimax-m3-cloud, coding=0.82, input=0, output=0, latency=950, notes=Ollama Cloud MiniMax M3 (free tier)',
  'ollama-deepseek-v4-flash-cloud, coding=0.84, input=0, output=0, latency=900, notes=Ollama Cloud DeepSeek V4 Flash (free tier coding fallback)'
] as const;

/** openrouter/free on OpenRouter, Kilo gateway, and Cline gateway. */
const OPENROUTER_FREE_CANDIDATES = [
  'openrouter-free, coding=0.80, input=0, output=0, latency=900, notes=OpenRouter openrouter/free (personal key)',
  'kilo-openrouter-free, coding=0.80, input=0, output=0, latency=900, notes=Kilo Gateway openrouter/free',
  'cline-openrouter-free, coding=0.80, input=0, output=0, latency=850, notes=Cline API openrouter/free'
] as const;

const KILO_CLINE_FREE_CANDIDATES = [
  'kilo-stepfun-step-3.7-flash-free, coding=0.84, input=0, output=0, latency=800, notes=Kilo Gateway Step 3.7 Flash free',
  'kilo-nvidia-nemotron-3-super-120b-a12b-free, coding=0.82, input=0, output=0, latency=850, notes=Kilo Gateway Nemotron 3 Super free',
  'kilo-nvidia-nemotron-3-ultra-550b-a55b-free, coding=0.86, input=0, output=0, latency=800, notes=Kilo Gateway Nemotron 3 Ultra free',
  'cline-nvidia-nemotron-3-ultra-550b-a55b-free, coding=0.86, input=0, output=0, latency=800, notes=Cline API Nemotron 3 Ultra free',
  'cline-minimax-minimax-m3, coding=0.85, input=0, output=0, latency=750, notes=Cline API MiniMax M3 free tier',
  'cline-xiaomi-mimo-v2.5, coding=0.80, input=0, output=0, latency=900, notes=Cline API MiMo V2.5 free tier'
] as const;

const OPENCODE_FREE_CANDIDATES = [
  'opencode-zen-minimax-m3-free, coding=0.80, input=0, output=0, latency=900, notes=OpenCode Zen MiniMax M3 free tier',
  'opencode-zen-deepseek-v4-flash-free, coding=0.78, input=0, output=0, latency=950, notes=OpenCode Zen DeepSeek V4 Flash free',
  'opencode-minimax-m3-free, coding=0.80, input=0, output=0, latency=900, notes=OpenCode Go MiniMax M3 free tier'
] as const;

/** OpenCode Go subscription (non-free) models. */
const OPENCODE_GO_SUBSCRIPTION_CANDIDATES = [
  'opencode-minimax-m3, coding=0.85, input=0.3, output=1.2, latency=650, notes=OpenCode Go MiniMax M3 subscription',
  'opencode-minimax-m2.7, coding=0.83, input=0.3, output=1.2, latency=700, notes=OpenCode Go MiniMax M2.7 subscription',
  'opencode-minimax-m2.5, coding=0.80, input=0.3, output=1.2, latency=720, notes=OpenCode Go MiniMax M2.5 subscription',
  'opencode-kimi-k2.6, coding=0.86, input=0.6, output=2.5, latency=850, notes=OpenCode Go Kimi K2.6 subscription',
  'opencode-kimi-k2.5, coding=0.82, input=0.5, output=2, latency=900, notes=OpenCode Go Kimi K2.5 subscription',
  'opencode-glm-5.1, coding=0.88, input=0.88, output=3.51, latency=750, notes=OpenCode Go GLM-5.1 subscription',
  'opencode-glm-5, coding=0.85, input=0.5, output=1.5, latency=800, notes=OpenCode Go GLM-5 subscription',
  'opencode-deepseek-v4-pro, coding=0.91, input=0.5, output=1, latency=800, notes=OpenCode Go DeepSeek V4 Pro subscription',
  'opencode-deepseek-v4-flash, coding=0.87, input=0.5, output=1, latency=850, notes=OpenCode Go DeepSeek V4 Flash subscription',
  'opencode-deepseek-v3.2, coding=0.84, input=0.4, output=0.9, latency=900, notes=OpenCode Go DeepSeek V3.2 subscription',
  'opencode-qwen3.7-max, coding=0.85, input=1.25, output=3.75, latency=900, notes=OpenCode Go Qwen3.7 Max subscription',
  'opencode-qwen3.6-plus, coding=0.82, input=0.8, output=2, latency=950, notes=OpenCode Go Qwen3.6 Plus subscription',
  'opencode-qwen3.5-plus, coding=0.80, input=0.6, output=1.5, latency=1000, notes=OpenCode Go Qwen3.5 Plus subscription',
  'opencode-mimo-v2-pro, coding=0.78, input=0.4, output=0.8, latency=1000, notes=OpenCode Go MiMo V2 Pro subscription',
  'opencode-mimo-v2-omni, coding=0.76, input=0.4, output=0.8, latency=1050, notes=OpenCode Go MiMo V2 Omni subscription',
  'opencode-mimo-v2.5-pro, coding=0.80, input=0.44, output=0.88, latency=1000, notes=OpenCode Go MiMo V2.5 Pro subscription',
  'opencode-mimo-v2.5, coding=0.76, input=0.15, output=0.29, latency=1100, notes=OpenCode Go MiMo V2.5 subscription',
  'opencode-hy3-preview, coding=0.75, input=0.3, output=0.6, latency=1100, notes=OpenCode Go HY3 preview subscription'
] as const;

/** OpenCode Zen paid subscription models (Zen also hosts free-tier rows above). */
const OPENCODE_ZEN_SUBSCRIPTION_CANDIDATES = [
  'opencode-zen-glm-5.1, coding=0.88, input=0.88, output=3.51, latency=750, notes=OpenCode Zen GLM-5.1 subscription',
  'opencode-zen-claude-sonnet-4-6, coding=0.90, input=3, output=15, latency=1200, notes=OpenCode Zen Claude Sonnet 4.6 subscription'
] as const;

const OTHER_SUBSCRIPTION_CANDIDATES = [
  'zai-code-pass-glm-5.1, coding=0.88, input=0.88, output=3.51, latency=750, notes=Z.ai Code Pass GLM-5.1 subscription',
  'xiaomi-mimo-mimo-v2.5-pro, coding=0.80, input=0.44, output=0.88, latency=1000, notes=Xiaomi MiMo V2.5 Pro subscription',
  'xiaomi-mimo-mimo-v2.5, coding=0.76, input=0.15, output=0.29, latency=1100, notes=Xiaomi MiMo V2.5 subscription multimodal'
] as const;

const DEEPSEEK_V4_FLASH_PAID_CANDIDATES = [
  'wafer-ai-deepseek-v4-flash, coding=0.87, input=0.5, output=1, latency=600, notes=Wafer DeepSeek V4 Flash 1M ctx',
  'zenmux-deepseek-v4-flash, coding=0.86, input=0.5, output=1, latency=650, notes=ZenMux DeepSeek V4 Flash 1M ctx',
  'openrouter-deepseek-v4-flash, coding=0.86, input=0.5, output=1, latency=700, notes=OpenRouter deepseek/deepseek-v4-flash',
  'cline-deepseek-deepseek-v4-flash, coding=0.84, input=0.5, output=1, latency=800, notes=Cline API DeepSeek V4 Flash paid',
  'kilo-deepseek-deepseek-v4-flash, coding=0.84, input=0.5, output=1, latency=750, notes=Kilo Gateway DeepSeek V4 Flash paid',
  'opencode-zen-deepseek-v4-flash, coding=0.87, input=0.5, output=1, latency=900, notes=OpenCode Zen DeepSeek V4 Flash paid'
] as const;

/** Preferred API-paid models for auto-router (per providers.txt Hermes picks). */
export const ROUTING_PREFERRED_PAID_CANDIDATES = [
  'nvidia-nim-step-3.7-flash, coding=0.84, input=0.1, output=0.3, latency=700, notes=NVIDIA NIM Step 3.7 Flash reasoning',
  'nvidia-nim-kimi-k2.6, coding=0.86, input=0.6, output=2.5, latency=850, notes=NVIDIA NIM Kimi K2.6 256K ctx coding',
  'nvidia-nim-minimax-m3, coding=0.85, input=0.1, output=0.3, latency=720, notes=NVIDIA NIM MiniMax M3',
  'modal-glm-5.1-fp8, coding=0.83, input=0.5, output=1, latency=800, notes=Modal GLM-5.1 FP8 200K ctx',
  'nebius-deepseek-v4-pro, coding=0.88, input=0.5, output=1, latency=800, notes=Nebius DeepSeek V4 Pro 1M ctx',
  'wafer-ai-minimax-m3, coding=0.90, input=0.33, output=1.32, latency=650, notes=Wafer MiniMax-M3 serverless promo',
  'zenmux-minimax-m3, coding=0.90, input=0.3, output=1.2, latency=700, notes=ZenMux MiniMax M3',
  'zenmux-step-3.7-flash, coding=0.84, input=0.2, output=1.15, latency=700, notes=ZenMux Step 3.7 Flash reasoning',
  'zenmux-deepseek-v4-pro, coding=0.91, input=0.435, output=0.87, latency=900, notes=ZenMux DeepSeek V4 Pro 1M ctx',
  'zenmux-qwen3.7-max, coding=0.85, input=1.25, output=3.75, latency=900, notes=ZenMux qwen/qwen3.7-max',
  'openrouter-1-million-chain-of-draft, coding=0.88, input=1, output=2, latency=1200, notes=OpenRouter preset: DS V4 Pro + V4 Flash + MiMo',
  'openrouter-chain-of-draft, coding=0.86, input=1, output=2, latency=1300, notes=OpenRouter preset: DS V4 Pro + Kimi K2.6 + MiMo',
  'openrouter-qwen3.7-max, coding=0.85, input=1.25, output=3.75, latency=900, notes=OpenRouter qwen/qwen3.7-max',
  'openrouter-minimax-m3, coding=0.85, input=0.3, output=1.2, latency=750, notes=OpenRouter MiniMax M3'
] as const;

function candidateLinesToModelIds(lines: readonly string[]): string[] {
  return lines
    .map((line) => line.split(',')[0].trim())
    .filter(Boolean);
}

function dedupeLines(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const id = line.split(',')[0].trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(line);
  }
  return out;
}

const FALLBACK_CANDIDATE_LINES = dedupeLines([
  ...OLLAMA_FREE_CANDIDATES,
  ...OPENROUTER_FREE_CANDIDATES,
  ...KILO_CLINE_FREE_CANDIDATES,
  ...OPENCODE_FREE_CANDIDATES,
  ...OPENCODE_GO_SUBSCRIPTION_CANDIDATES,
  ...OTHER_SUBSCRIPTION_CANDIDATES,
  ...DEEPSEEK_V4_FLASH_PAID_CANDIDATES
]);

const AUTO_ROUTER_CANDIDATE_LINES = dedupeLines([
  ...FALLBACK_CANDIDATE_LINES,
  ...OPENCODE_ZEN_SUBSCRIPTION_CANDIDATES,

  ...ROUTING_PREFERRED_PAID_CANDIDATES.filter((line) => {
    const id = line.split(',')[0].trim();
    return !FALLBACK_CANDIDATE_LINES.some((fallbackLine) => (
      fallbackLine.split(',')[0].trim() === id
    ));
  })
]);

export const DEFAULT_FALLBACK_CANDIDATES_TEXT = FALLBACK_CANDIDATE_LINES.join('\n');

export const DEFAULT_AUTO_ROUTER_CANDIDATES_TEXT = AUTO_ROUTER_CANDIDATE_LINES.join('\n');

export function sortModelIdsByRoutingExhaustion(
  modelIds: string[],
  findModel: (id: string) => CatalogModelRef | undefined
): string[] {
  return stableSortModelIdsByRoutingExhaustion(modelIds, findModel);
}

export function buildDefaultFallbackModelIds(
  findModel: (id: string) => CatalogModelRef | undefined = () => undefined
): string[] {
  const ids = candidateLinesToModelIds(FALLBACK_CANDIDATE_LINES);
  return sortModelIdsByRoutingExhaustion(ids, findModel);
}

export function buildDefaultFallbackModelsText(
  findModel: (id: string) => CatalogModelRef | undefined = () => undefined
): string {
  return buildDefaultFallbackModelIds(findModel).join('\n');
}

export function buildDefaultAutoRouterCandidateLines(
  findModel: (id: string) => CatalogModelRef | undefined = () => undefined
): string[] {
  const byId = new Map(AUTO_ROUTER_CANDIDATE_LINES.map((line) => {
    const id = line.split(',')[0].trim();
    return [id, line] as const;
  }));
  const sortedIds = sortModelIdsByRoutingExhaustion([...byId.keys()], findModel);
  return sortedIds.map((id) => byId.get(id)!).filter(Boolean);
}
