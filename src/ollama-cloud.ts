export function isOllamaCloudModelName(name: string): boolean {
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized) return false;
  return normalized.includes(':cloud') || normalized.endsWith('-cloud');
}

export function filterOllamaCloudTags(tags: Array<{ name?: string; model?: string }>): string[] {
  const names: string[] = [];
  for (const tag of tags) {
    const name = typeof tag?.name === 'string'
      ? tag.name
      : typeof tag?.model === 'string'
        ? tag.model
        : '';
    if (name && isOllamaCloudModelName(name)) {
      names.push(name);
    }
  }
  return names;
}
