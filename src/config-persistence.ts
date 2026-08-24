import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCAL_ROUTER_CONFIG_DIR = path.join(os.homedir(), '.config', 'local-router');
export const ROUTER_SETTINGS_PATH = path.join(LOCAL_ROUTER_CONFIG_DIR, 'router-settings.json');

export type RouterSettings = {
  fallbackModelsText?: string;
};

export function loadRouterSettings(): RouterSettings {
  try {
    if (!fs.existsSync(ROUTER_SETTINGS_PATH)) return {};
    const raw = fs.readFileSync(ROUTER_SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (error) {
    console.error('[config] failed to load router settings', error);
  }
  return {};
}

export function saveRouterSettings(settings: RouterSettings): void {
  try {
    fs.mkdirSync(path.dirname(ROUTER_SETTINGS_PATH), { recursive: true, mode: 0o700 });
    fs.writeFileSync(ROUTER_SETTINGS_PATH, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(ROUTER_SETTINGS_PATH, 0o600);
  } catch (error) {
    console.error('[config] failed to save router settings', error);
    throw error;
  }
}

// ── Named curation configs ──────────────────────────────────────────────────
// A named snapshot of the curated model selection ('provider::model' keys).
// Backed by curation-configs.json; one config may be flagged as the default
// (stored in model-source-config.json as defaultCurationConfig) and is
// re-applied at boot.

export const CURATION_CONFIGS_PATH = path.join(LOCAL_ROUTER_CONFIG_DIR, 'curation-configs.json');

export type CurationConfig = {
  name: string;
  selectedKeys: string[];
  updatedAt?: string;
};

export function loadCurationConfigs(): CurationConfig[] {
  try {
    if (!fs.existsSync(CURATION_CONFIGS_PATH)) return [];
    const raw = fs.readFileSync(CURATION_CONFIGS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed?.configs) ? parsed.configs : [];
    const out: CurationConfig[] = [];
    for (const entry of entries) {
      const name = String(entry?.name || '').trim();
      if (!name) continue;
      const selectedKeys = Array.isArray(entry?.selectedKeys)
        ? entry.selectedKeys.map((key: unknown) => String(key || '').trim()).filter((key: string) => key.length > 0)
        : [];
      out.push({ name, selectedKeys, updatedAt: entry?.updatedAt });
    }
    return out;
  } catch (error) {
    console.error('[config] failed to load curation configs', error);
    return [];
  }
}

export function saveCurationConfigs(configs: CurationConfig[]): void {
  try {
    fs.mkdirSync(path.dirname(CURATION_CONFIGS_PATH), { recursive: true, mode: 0o700 });
    fs.writeFileSync(CURATION_CONFIGS_PATH, JSON.stringify({ version: 1, configs }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(CURATION_CONFIGS_PATH, 0o600);
  } catch (error) {
    console.error('[config] failed to save curation configs', error);
    throw error;
  }
}
