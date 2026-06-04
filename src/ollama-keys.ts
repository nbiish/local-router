/** Placeholder for Local Router — not sent to ollama.com; cloud uses local `ollama signin` session. */
export const DEFAULT_OLLAMA_API_KEY = 'local-router-ollama';

const OLLAMA_PLACEHOLDER_KEYS = new Set([
  DEFAULT_OLLAMA_API_KEY,
  'ollama-local'
]);

export function isOllamaPlaceholderKey(key: string | undefined): boolean {
  const normalized = String(key || '').trim().toLowerCase();
  if (!normalized) return true;
  return OLLAMA_PLACEHOLDER_KEYS.has(normalized);
}

/** True only when the operator set a real ollama.com API key (optional; not required for cloud free tier). */
export function isRealOllamaComApiKey(key: string | undefined): boolean {
  return Boolean(String(key || '').trim()) && !isOllamaPlaceholderKey(key);
}

export function resolveOllamaApiKey(): string {
  const fromEnv = String(process.env.OLLAMA_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_OLLAMA_API_KEY;
}

export function ensureDefaultOllamaApiKey(keyStore: Record<string, string>): void {
  const current = String(keyStore.ollama || process.env.OLLAMA_API_KEY || '').trim();
  const resolved = current || DEFAULT_OLLAMA_API_KEY;

  keyStore.ollama = resolved;
  process.env.OLLAMA_API_KEY = resolved;

  if (!current) {
    console.log(
      `[ollama] Default API key set to ${DEFAULT_OLLAMA_API_KEY} (Local Router placeholder). `
      + 'Ollama Cloud free tier uses your local `ollama signin` session — no ollama.com API key required.'
    );
  }
}
