/**
 * Curated model registries for providers that publish NO models-list API.
 *
 * Some providers (zai GLM Coding Plan, cline usage-billing gateway) expose
 * chat/completions but no /models discovery endpoint. For those, per-provider
 * refresh falls back to a curated registry = current providers.txt catalog
 * rows ∪ the verified additions below, and the refresh response reports
 * `source: "registry"` so the UI never mistakes it for a live fetch.
 *
 * Sources (verified 2026-08-20):
 * - zai: https://docs.z.ai/devpack/overview — plan models GLM-5.3,
 *   GLM-5-Turbo, GLM-4.7 (GLM-4.6V vision via MCP); upstream auto-routes
 *   GLM-5.2/GLM-5.1 requests to GLM-5.3.
 * - cline: https://docs.cline.bot/api/models (provider/model id format) +
 *   models.dev cline-pass catalog for the newer open-model additions.
 *
 * Registry entries are discovery metadata only — serving still requires a
 * valid provider key, and capabilities here are hints that mapLiveRawModelsToCatalog
 * applies when the id is not already in the providers.txt catalog.
 */

export interface RegistryModelEntry {
  id: string;
  contextLength?: number;
  outputTokens?: number;
  supportsTools?: boolean;
  supportsImages?: boolean;
  supportsCache?: boolean;
  supportsReasoning?: boolean;
  note?: string;
}

/** Providers whose upstream exposes no OpenAI-compatible /models list. */
export const PROVIDERS_WITHOUT_LIVE_MODEL_LIST: readonly string[] = ['zai', 'cline'];

/**
 * Verified model additions beyond the providers.txt catalog rows.
 * Catalog rows are unioned in at runtime, so entries here only need to cover
 * models released since the last providers.txt curation pass.
 */
export const PROVIDER_MODEL_REGISTRY_EXTRAS: Record<string, RegistryModelEntry[]> = {
  zai: [
    {
      id: 'GLM-5.3',
      contextLength: 200000,
      outputTokens: 128000,
      supportsTools: true,
      note: 'Current coding-plan flagship; GLM-5.2/GLM-5.1 requests auto-route here upstream'
    },
    {
      id: 'GLM-5-Turbo',
      contextLength: 200000,
      outputTokens: 128000,
      supportsTools: true
    },
    {
      id: 'GLM-4.7',
      contextLength: 200000,
      outputTokens: 128000,
      supportsTools: true
    }
  ],
  cline: [
    { id: 'moonshotai/kimi-k3', contextLength: 256000, outputTokens: 128000, supportsTools: true },
    { id: 'moonshotai/kimi-k2.7-code', contextLength: 256000, outputTokens: 128000, supportsTools: true },
    { id: 'qwen/qwen3.7-plus', contextLength: 256000, outputTokens: 128000, supportsTools: true },
    { id: 'z-ai/glm-5.2', contextLength: 200000, outputTokens: 128000, supportsTools: true },
    { id: 'nvidia/nemotron-3-ultra-550b-a55b', contextLength: 200000, outputTokens: 128000, supportsTools: true, note: 'Paid tier of the :free catalog row' }
  ]
};

export function providerHasNoLiveModelList(providerName: string): boolean {
  return PROVIDERS_WITHOUT_LIVE_MODEL_LIST.includes(providerName);
}
