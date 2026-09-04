import { ProxyProvider } from '../types';
import { filterOllamaCloudTags, isOllamaCloudModelName } from '../ollama-cloud';
import { ollamaBackendBaseUrl, ollamaBackendTagsUrl } from '../ollama-backend';
import {
  isRealOllamaComApiKey,
  resolveOllamaApiKey
} from '../ollama-keys';

type RawModel = { id: string; object: string; owned_by: string; context_length?: number; max_output_tokens?: number };

function ollamaAuthHeaders(forRemoteOllamaCom = false): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  const apiKey = resolveOllamaApiKey();
  if (forRemoteOllamaCom && isRealOllamaComApiKey(apiKey)) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

async function fetchOllamaTagsFromUrl(
  tagsUrl: string,
  options: { remoteOllamaCom?: boolean } = {}
): Promise<string[]> {
  const response = await fetch(tagsUrl, {
    headers: ollamaAuthHeaders(Boolean(options.remoteOllamaCom)),
    signal: AbortSignal.timeout(6000)
  });
  if (!response.ok) {
    return [];
  }

  const payload = await response.json();
  const models = Array.isArray(payload?.models) ? payload.models : [];
  collectTagMeta(models);
  return filterOllamaCloudTags(models);
}

// name -> metadata published alongside the tag list (Ollama tags carry
// details.context_length; the OpenAI-compat list carries context_length too).
type OllamaTagMeta = { context_length?: number; max_output_tokens?: number };
const tagMeta = new Map<string, OllamaTagMeta>();

function collectTagMeta(models: unknown[]): void {
  for (const model of models) {
    const id = typeof (model as any)?.name === 'string'
      ? (model as any).name
      : (typeof (model as any)?.id === 'string' ? (model as any).id : '');
    if (!id) continue;
    const details = (model as any)?.details ?? {};
    const meta: OllamaTagMeta = {
      context_length: Number(details?.context_length)
        ?? Number((model as any)?.context_length)
        ?? undefined,
      max_output_tokens: Number((model as any)?.max_output_tokens) || undefined
    };
    if (meta.context_length || meta.max_output_tokens) {
      tagMeta.set(id, meta);
    }
  }
}

export async function fetchLiveOllamaModels(): Promise<RawModel[]> {
  const discovered = new Set<string>();
  tagMeta.clear();

  try {
    const localTags = await fetchOllamaTagsFromUrl(ollamaBackendTagsUrl());
    for (const name of localTags) {
      discovered.add(name);
    }
  } catch (error) {
    console.error('[ollama] Failed to fetch local backend tags:', error);
  }

  const apiKey = resolveOllamaApiKey();
  if (isRealOllamaComApiKey(apiKey)) {
    try {
      const remoteTags = await fetchOllamaTagsFromUrl('https://ollama.com/api/tags', {
        remoteOllamaCom: true
      });
      for (const name of remoteTags) {
        discovered.add(name);
      }
    } catch (error) {
      console.error('[ollama] Failed to fetch ollama.com cloud tags:', error);
    }
  }

  try {
    const baseUrl = ollamaBackendBaseUrl();
    const response = await fetch(`${baseUrl}/models`, {
      headers: ollamaAuthHeaders(false),
      signal: AbortSignal.timeout(6000)
    });
    if (response.ok) {
      const payload = await response.json();
      for (const model of Array.isArray(payload?.data) ? payload.data : []) {
        const id = typeof model?.id === 'string' ? model.id : '';
        if (id && isOllamaCloudModelName(id)) {
          discovered.add(id);
          if (typeof model?.context_length === 'number' && model.context_length > 0) {
            tagMeta.set(id, { context_length: model.context_length });
          }
        }
      }
    }
  } catch (error) {
    console.error('[ollama] Failed to fetch OpenAI-compat model list:', error);
  }

  if (discovered.size === 0) {
    discovered.add('deepseek-v4-flash:cloud');
    discovered.add('minimax-m3:cloud');
    discovered.add('nemotron-3-ultra:cloud');
  }

  return Array.from(discovered)
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({
      id,
      object: 'model',
      owned_by: 'ollama',
      ...(tagMeta.get(id) ?? {})
    }));
}

const provider: ProxyProvider = {
  name: 'ollama',
  baseUrl: ollamaBackendBaseUrl(),
  getHeaders: () => ollamaAuthHeaders(true),
  getModels: fetchLiveOllamaModels
};

export default provider;
