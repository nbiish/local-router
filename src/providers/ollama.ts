import { ProxyProvider } from '../types';
import { filterOllamaCloudTags, isOllamaCloudModelName } from '../ollama-cloud';
import { ollamaBackendBaseUrl, ollamaBackendTagsUrl } from '../ollama-backend';

type RawModel = { id: string; object: string; owned_by: string };

function ollamaAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  const apiKey = process.env.OLLAMA_API_KEY;
  if (apiKey && apiKey !== 'ollama-local') {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

async function fetchOllamaTagsFromUrl(tagsUrl: string): Promise<string[]> {
  const response = await fetch(tagsUrl, {
    headers: ollamaAuthHeaders(),
    signal: AbortSignal.timeout(6000)
  });
  if (!response.ok) {
    return [];
  }

  const payload = await response.json();
  const models = Array.isArray(payload?.models) ? payload.models : [];
  return filterOllamaCloudTags(models);
}

export async function fetchLiveOllamaModels(): Promise<RawModel[]> {
  const discovered = new Set<string>();

  try {
    const localTags = await fetchOllamaTagsFromUrl(ollamaBackendTagsUrl());
    for (const name of localTags) {
      discovered.add(name);
    }
  } catch (error) {
    console.error('[ollama] Failed to fetch local backend tags:', error);
  }

  const apiKey = process.env.OLLAMA_API_KEY;
  if (apiKey && apiKey !== 'ollama-local') {
    try {
      const remoteTags = await fetchOllamaTagsFromUrl('https://ollama.com/api/tags');
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
      headers: ollamaAuthHeaders(),
      signal: AbortSignal.timeout(6000)
    });
    if (response.ok) {
      const payload = await response.json();
      for (const model of Array.isArray(payload?.data) ? payload.data : []) {
        const id = typeof model?.id === 'string' ? model.id : '';
        if (id && isOllamaCloudModelName(id)) {
          discovered.add(id);
        }
      }
    }
  } catch (error) {
    console.error('[ollama] Failed to fetch OpenAI-compat model list:', error);
  }

  return Array.from(discovered)
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({
      id,
      object: 'model',
      owned_by: 'ollama'
    }));
}

const provider: ProxyProvider = {
  name: 'ollama',
  baseUrl: ollamaBackendBaseUrl(),
  getHeaders: () => ollamaAuthHeaders(),
  getModels: fetchLiveOllamaModels
};

export default provider;
