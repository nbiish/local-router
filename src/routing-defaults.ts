/**
 * Default auto-router and fallback-model candidate lists.
 * Fallback uses a fixed 16-step chain; auto-router uses exhaustion sort on a broader curated set.
 */

import {
  FALLBACK_PAID_TAIL_IDS,
  stableSortModelIdsByRoutingExhaustion,
  type CatalogModelRef
} from './routing-exhaustion-order';

export { FALLBACK_PAID_TAIL_IDS, DEEPSEEK_V4_FLASH_PAID_PRESENTED_IDS } from './routing-exhaustion-order';

/** Curated Cline/Kilo free models for auto-router-main (not full catalog free tier). */
export const AUTO_ROUTER_CLINE_FREE_PRESENTED_IDS: readonly string[] = [
  'cline-nvidia-nemotron-3-ultra-550b-a55b-free',
  'cline-minimax-minimax-m3-free'
] as const;

/** Kilo MiniMax M3 is paid upstream; free tier uses Nemotron Ultra + Step 3.7 Flash. */
export const AUTO_ROUTER_KILO_FREE_PRESENTED_IDS: readonly string[] = [
  'kilo-nvidia-nemotron-3-ultra-550b-a55b-free',
  'kilo-stepfun-step-3.7-flash-free'
] as const;

export const AUTO_ROUTER_GATEWAY_FREE_PRESENTED_IDS: readonly string[] = [
  ...AUTO_ROUTER_CLINE_FREE_PRESENTED_IDS,
  ...AUTO_ROUTER_KILO_FREE_PRESENTED_IDS
] as const;

const AUTO_ROUTER_GATEWAY_FREE_SET = new Set<string>(AUTO_ROUTER_GATEWAY_FREE_PRESENTED_IDS);

export function isAllowedAutoRouterGatewayFreeModel(presentedId: string): boolean {
  return AUTO_ROUTER_GATEWAY_FREE_SET.has(String(presentedId || '').trim());
}

export const DEFAULT_FALLBACK_ORDERED_IDS: readonly string[] = [
  'ollama-nemotron-3-ultra-cloud',
  'nvidia-nim-minimax-m3',
  'cline-minimax-minimax-m3-free',
  'kilo-stepfun-step-3.7-flash-free',
  'opencode-zen-minimax-m3-free',
  'modal-glm-5.1-fp8',
  'zai-code-pass-glm-5.1',
  'xiaomi-mimo-mimo-v2.5-pro',
  'opencode-go-deepseek-v4-pro',
  'nebius-nemotron-3-ultra-550b-a55b',
  'commandcode-deepseek-v4-pro',
  'wafer-ai-deepseek-v4-flash',
  'kilo-minimax-minimax-m3-paid',
  'cline-deepseek-deepseek-v4-pro-paid',
  'zenmux-mimo-v2.5-pro',
  'openrouter-chain-of-draft',
  'openrouter-free'
] as const;

const CANDIDATE_DEFAULTS: Record<string, string> = {
  'ollama-nemotron-3-ultra-cloud': 'coding=0.86, input=0, output=0, latency=850, notes=Ollama Cloud Nemotron 3 Ultra (free tier)',
  'ollama-minimax-m3-cloud': 'coding=0.82, input=0, output=0, latency=950, notes=Ollama Cloud MiniMax M3 (free tier)',
  'ollama-deepseek-v4-flash-cloud': 'coding=0.84, input=0, output=0, latency=900, notes=Ollama Cloud DeepSeek V4 Flash (free tier)',
  'nvidia-nim-minimax-m3': 'coding=0.85, input=0.1, output=0.3, latency=720, notes=NVIDIA NIM MiniMax M3',
  'nvidia-nim-kimi-k2.6': 'coding=0.86, input=0.6, output=2.5, latency=850, notes=NVIDIA NIM Kimi K2.6',
  'nvidia-nim-step-3.7-flash': 'coding=0.84, input=0.1, output=0.3, latency=700, notes=NVIDIA NIM Step 3.7 Flash',
  'modal-glm-5.1-fp8': 'coding=0.83, input=0.5, output=1, latency=800, notes=Modal GLM-5.1 FP8 200K ctx',
  'openrouter-free': 'coding=0.80, input=0, output=0, latency=900, notes=OpenRouter openrouter/free',
  'kilo-openrouter-free': 'coding=0.80, input=0, output=0, latency=900, notes=Kilo Gateway openrouter/free',
  'kilo-stepfun-step-3.7-flash-free': 'coding=0.84, input=0, output=0, latency=800, notes=Kilo Step 3.7 Flash free',
  'kilo-nvidia-nemotron-3-super-120b-a12b-free': 'coding=0.82, input=0, output=0, latency=850, notes=Kilo Nemotron 3 Super free',
  'kilo-nvidia-nemotron-3-ultra-550b-a55b-free': 'coding=0.86, input=0, output=0, latency=800, notes=Kilo Nemotron 3 Ultra free',
  'cline-nvidia-nemotron-3-ultra-550b-a55b-free': 'coding=0.86, input=0, output=0, latency=800, notes=Cline Nemotron 3 Ultra free',
  'cline-minimax-minimax-m3-free': 'coding=0.85, input=0, output=0, latency=750, notes=Cline MiniMax M3 free tier',
  'cline-xiaomi-mimo-v2.5-free': 'coding=0.80, input=0, output=0, latency=900, notes=Cline MiMo V2.5 free tier',
  'opencode-zen-minimax-m3-free': 'coding=0.80, input=0, output=0, latency=900, notes=OpenCode Zen MiniMax M3 free',
  'opencode-zen-deepseek-v4-flash-free': 'coding=0.78, input=0, output=0, latency=950, notes=OpenCode Zen DeepSeek V4 Flash free',
  'opencode-go-minimax-m3': 'coding=0.85, input=0.3, output=1.2, latency=650, notes=OpenCode Go MiniMax M3 subscription',
  'opencode-go-kimi-k2.6': 'coding=0.86, input=0.6, output=2.5, latency=850, notes=OpenCode Go Kimi K2.6 subscription',
  'opencode-go-glm-5.1': 'coding=0.88, input=0.88, output=3.51, latency=750, notes=OpenCode Go GLM-5.1 subscription',

  'opencode-go-deepseek-v4-pro': 'coding=0.91, input=0.5, output=1, latency=800, notes=OpenCode Go DeepSeek V4 Pro subscription',
  'opencode-go-deepseek-v4-flash': 'coding=0.87, input=0.5, output=1, latency=850, notes=OpenCode Go DeepSeek V4 Flash subscription',
  'opencode-go-qwen3.7-max': 'coding=0.85, input=1.25, output=3.75, latency=900, notes=OpenCode Go Qwen3.7 Max subscription',
  'opencode-go-mimo-v2.5-pro': 'coding=0.80, input=0.44, output=0.88, latency=1000, notes=OpenCode Go MiMo V2.5 Pro subscription',
  'opencode-go-mimo-v2.5': 'coding=0.76, input=0.15, output=0.29, latency=1100, notes=OpenCode Go MiMo V2.5 subscription',
  'zai-code-pass-glm-5.1': 'coding=0.88, input=0.88, output=3.51, latency=750, notes=Z.ai Code Pass GLM-5.1 subscription',
  'xiaomi-mimo-mimo-v2.5-pro': 'coding=0.80, input=0.44, output=0.88, latency=1000, notes=Xiaomi MiMo V2.5 Pro subscription',
  'xiaomi-mimo-mimo-v2.5': 'coding=0.76, input=0.15, output=0.29, latency=1100, notes=Xiaomi MiMo V2.5 subscription',
  'commandcode-deepseek-v4-pro': 'coding=0.89, input=0.5, output=1, latency=800, notes=CommandCode DeepSeek V4 Pro subscription',
  'wafer-ai-deepseek-v4-flash': 'coding=0.87, input=0.5, output=1, latency=600, notes=Wafer DeepSeek V4 Flash',
  'zenmux-mimo-v2.5-pro': 'coding=0.84, input=0.44, output=0.88, latency=700, notes=ZenMux xiaomi/mimo-v2.5-pro paid tail',
  'zenmux-minimax-m3': 'coding=0.90, input=0.3, output=1.2, latency=700, notes=ZenMux MiniMax M3',
  'zenmux-deepseek-v4-flash': 'coding=0.86, input=0.5, output=1, latency=650, notes=ZenMux DeepSeek V4 Flash',
  'openrouter-chain-of-draft': 'coding=0.82, input=0, output=0, latency=900, notes=OpenRouter @preset/chain-of-draft',
  'openrouter-deepseek-v4-flash': 'coding=0.86, input=0.5, output=1, latency=700, notes=OpenRouter deepseek-v4-flash',
  'openrouter-minimax-m3': 'coding=0.88, input=0.3, output=1.2, latency=750, notes=OpenRouter minimax-m3',
  'openrouter-qwen3.7-max': 'coding=0.85, input=1.25, output=3.75, latency=900, notes=OpenRouter qwen3.7-max',
  'nebius-nemotron-3-ultra-550b-a55b': 'coding=0.86, input=0.5, output=1, latency=800, notes=Nebius Nemotron 3 Ultra 550B',
  'nebius-deepseek-v4-pro': 'coding=0.88, input=0.5, output=1, latency=800, notes=Nebius DeepSeek V4 Pro',
  'cline-deepseek-deepseek-v4-flash-free': 'coding=0.84, input=0, output=0, latency=800, notes=Cline DeepSeek V4 Flash free tier',
  'cline-deepseek-deepseek-v4-pro-paid': 'coding=0.88, input=0.5, output=1, latency=800, notes=Cline DeepSeek V4 Pro paid',
  'cline-deepseek-deepseek-chat-paid': 'coding=0.82, input=0.5, output=1, latency=850, notes=Cline DeepSeek Chat paid',
  'cline-z-ai-glm-5.1-paid': 'coding=0.88, input=0.5, output=1, latency=750, notes=Cline z-ai/glm-5.1 paid',
  'cline-qwen-qwen3.7-max-paid': 'coding=0.85, input=1.25, output=3.75, latency=900, notes=Cline qwen/qwen3.7-max paid',

  'cline-stepfun-step-3.7-flash-paid': 'coding=0.84, input=0.1, output=0.3, latency=700, notes=Cline Step 3.7 Flash paid',
  'cline-xiaomi-mimo-v2.5-pro-paid': 'coding=0.84, input=0.44, output=0.88, latency=700, notes=Cline MiMo V2.5 Pro paid',
  'cline-moonshotai-kimi-k2.6-paid': 'coding=0.86, input=0.6, output=2.5, latency=850, notes=Cline Kimi K2.6 paid',
  'kilo-deepseek-deepseek-v4-flash-paid': 'coding=0.84, input=0.5, output=1, latency=750, notes=Kilo DeepSeek V4 Flash paid',
  'kilo-deepseek-deepseek-v4-pro-paid': 'coding=0.88, input=0.5, output=1, latency=800, notes=Kilo DeepSeek V4 Pro paid',
  'kilo-deepseek-deepseek-chat-paid': 'coding=0.82, input=0.5, output=1, latency=850, notes=Kilo DeepSeek Chat paid',
  'kilo-z-ai-glm-5.1-paid': 'coding=0.88, input=0.5, output=1, latency=750, notes=Kilo z-ai/glm-5.1 paid',
  'kilo-qwen-qwen3.7-max-paid': 'coding=0.85, input=1.25, output=3.75, latency=900, notes=Kilo qwen/qwen3.7-max paid',
  'kilo-minimax-minimax-m3-paid': 'coding=0.90, input=0.3, output=1.2, latency=700, notes=Kilo MiniMax M3 paid',

  'kilo-stepfun-step-3.7-flash-paid': 'coding=0.84, input=0.1, output=0.3, latency=700, notes=Kilo Step 3.7 Flash paid',
  'kilo-xiaomi-mimo-v2.5-pro-paid': 'coding=0.84, input=0.44, output=0.88, latency=700, notes=Kilo MiMo V2.5 Pro paid',
  'kilo-xiaomi-mimo-v2.5-paid': 'coding=0.80, input=0.15, output=0.29, latency=900, notes=Kilo MiMo V2.5 paid',
  'kilo-moonshotai-kimi-k2.6-paid': 'coding=0.86, input=0.6, output=2.5, latency=850, notes=Kilo Kimi K2.6 paid',
  'kilo-nvidia-nemotron-3-nano-omni-30b-a3b-reasoning-free': 'coding=0.80, input=0, output=0, latency=850, notes=Kilo Nemotron 3 Nano Omni free',
  'kilo-poolside-laguna-m.1-free': 'coding=0.78, input=0, output=0, latency=900, notes=Kilo Poolside Laguna M.1 free',
  'kilo-poolside-laguna-xs.2-free': 'coding=0.76, input=0, output=0, latency=950, notes=Kilo Poolside Laguna XS.2 free',
  'wafer-ai-minimax-m3': 'coding=0.90, input=0.33, output=1.32, latency=650, notes=Wafer MiniMax-M3 promo',
  'wafer-ai-deepseek-v4-pro': 'coding=0.90, input=0.5, output=1, latency=650, notes=Wafer DeepSeek V4 Pro',
  'wafer-ai-glm-5.1': 'coding=0.88, input=0.5, output=1, latency=700, notes=Wafer GLM-5.1',
  'opencode-zen-deepseek-v4-flash': 'coding=0.87, input=0.5, output=1, latency=900, notes=OpenCode Zen DeepSeek V4 Flash paid'
};

function candidateLine(modelId: string): string {
  const meta = CANDIDATE_DEFAULTS[modelId] || 'coding=0.75, input=0, output=0, latency=1000, notes=Catalog default';
  return `${modelId}, ${meta}`;
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

const FALLBACK_CANDIDATE_LINES = DEFAULT_FALLBACK_ORDERED_IDS.map((id) => candidateLine(id));

/** Curated auto-router superset (Hermes-relevant providers.txt picks + fallback union). */
const AUTO_ROUTER_EXTRA_CANDIDATE_IDS = [
  'ollama-minimax-m3-cloud',
  'ollama-deepseek-v4-flash-cloud',
  ...AUTO_ROUTER_GATEWAY_FREE_PRESENTED_IDS,
  'opencode-zen-deepseek-v4-flash-free',
  'opencode-go-minimax-m3',
  'opencode-go-kimi-k2.6',
  'opencode-go-glm-5.1',

  'opencode-go-deepseek-v4-flash',
  'opencode-go-qwen3.7-max',
  'opencode-go-mimo-v2.5-pro',
  'opencode-go-mimo-v2.5',
  'xiaomi-mimo-mimo-v2.5',
  'nvidia-nim-kimi-k2.6',
  'nvidia-nim-step-3.7-flash',
  'nebius-deepseek-v4-pro',
  'wafer-ai-minimax-m3',
  'wafer-ai-deepseek-v4-pro',
  'wafer-ai-glm-5.1',
  'zenmux-minimax-m3',
  'zenmux-deepseek-v4-flash',
  'openrouter-minimax-m3',
  'openrouter-qwen3.7-max',
  'openrouter-deepseek-v4-flash',
  'opencode-zen-deepseek-v4-flash',
  'cline-deepseek-deepseek-v4-pro-paid',
  'cline-deepseek-deepseek-chat-paid',
  'cline-z-ai-glm-5.1-paid',
  'cline-qwen-qwen3.7-max-paid',

  'cline-stepfun-step-3.7-flash-paid',
  'cline-xiaomi-mimo-v2.5-pro-paid',
  'cline-moonshotai-kimi-k2.6-paid',
  'kilo-deepseek-deepseek-v4-pro-paid',
  'kilo-deepseek-deepseek-chat-paid',
  'kilo-z-ai-glm-5.1-paid',
  'kilo-qwen-qwen3.7-max-paid',
  'kilo-minimax-minimax-m3-paid',

  'kilo-stepfun-step-3.7-flash-paid',
  'kilo-xiaomi-mimo-v2.5-pro-paid',
  'kilo-xiaomi-mimo-v2.5-paid',
  'kilo-moonshotai-kimi-k2.6-paid'
] as const;

const AUTO_ROUTER_CANDIDATE_LINES = dedupeLines([
  ...FALLBACK_CANDIDATE_LINES,
  ...AUTO_ROUTER_EXTRA_CANDIDATE_IDS.map((id) => candidateLine(id))
]);

export const DEFAULT_FALLBACK_CANDIDATES_TEXT = FALLBACK_CANDIDATE_LINES.join('\n');

export const DEFAULT_AUTO_ROUTER_CANDIDATES_TEXT = AUTO_ROUTER_CANDIDATE_LINES.join('\n');

export function sortModelIdsByRoutingExhaustion(
  modelIds: string[],
  findModel: (id: string) => CatalogModelRef | undefined
): string[] {
  return stableSortModelIdsByRoutingExhaustion(modelIds, findModel);
}

function candidateLinesToModelIds(lines: readonly string[]): string[] {
  return lines.map((line) => line.split(',')[0].trim()).filter(Boolean);
}

export function buildDefaultFallbackModelIds(
  _findModel: (id: string) => CatalogModelRef | undefined = () => undefined
): string[] {
  return [...DEFAULT_FALLBACK_ORDERED_IDS];
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
