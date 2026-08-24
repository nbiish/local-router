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
