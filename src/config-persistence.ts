import fs from 'node:fs';
import path from 'node:path';
import {
  configLocation,
  ConfigLocation,
  machineConfigDir,
  machineConfigPath,
  portableConfigPath,
  seedPortableConfigFile
} from './config-paths';

/** Machine-local files below (curation configs, harness config) stay per box. */
const LOCAL_ROUTER_CONFIG_DIR = machineConfigDir();

// ── Fallback chain config (portable) ────────────────────────────────────────
// router-settings.json is the authoritative chain definition, and it is the one
// config file that must be shared rather than copied: a fleet syncs the checkout,
// so the checkout copy is what every machine reads. `config-paths.ts` owns that
// decision (checkout → env pin → machine fallback); this module only reads and
// writes it.

const ROUTER_SETTINGS_FILE = 'router-settings.json';

/** Authoritative location of the chain config on this machine right now. */
export function routerSettingsLocation(): ConfigLocation {
  return configLocation(ROUTER_SETTINGS_FILE);
}

/** Absolute path of the authoritative chain config. */
export function routerSettingsPath(): string {
  return portableConfigPath(ROUTER_SETTINGS_FILE);
}

/**
 * The pre-2026-11-10 location. Still read when the authoritative file is absent
 * (a machine that has not booted this build yet), then seeded into place by
 * {@link seedRouterSettings} — so an existing chain is never silently dropped by
 * the move.
 */
export function legacyRouterSettingsPath(): string {
  return machineConfigPath(ROUTER_SETTINGS_FILE);
}

/** Copy the machine chain file into the checkout once, if the checkout has none. */
export function seedRouterSettings(): boolean {
  return seedPortableConfigFile(ROUTER_SETTINGS_FILE);
}

export type RouterSettings = {
  fallbackModelsText?: string;
  /** Named chain routes (single-source mirror of the runtime chain set). */
  routes?: Array<{ id: string; models: string[]; disabledModels?: string[] }>;
};

export function loadRouterSettings(): RouterSettings {
  const primary = routerSettingsPath();
  const candidates = [primary, legacyRouterSettingsPath()]
    .map((candidate) => path.resolve(candidate))
    .filter((candidate, index, all) => all.indexOf(candidate) === index);

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const raw = fs.readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (error) {
      // A corrupt authoritative file is NOT a reason to fall back to the legacy
      // copy: that would silently resurrect a chain the operator already replaced.
      // Report it as "no opinion" and let the boot log show why.
      console.error(`[config] failed to load router settings from ${candidate}`, error);
      return {};
    }
  }
  return {};
}

export function saveRouterSettings(settings: RouterSettings): void {
  const target = routerSettingsPath();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporaryPath = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, target);
    fs.chmodSync(target, 0o600);
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

// ── Agent Proxy Config ──────────────────────────────────────────────────────
export const AGENT_PROXY_CONFIG_PATH = path.join(LOCAL_ROUTER_CONFIG_DIR, 'agent-proxy-config.json');

export type ClaudeModelSlotMappings = {
  default?: string;
  opus1m?: string;
  sonnet?: string;
  sonnet5_1m?: string;
  haiku?: string;
};

export type CodexHarnessConfig = {
  enabled: boolean;
  /**
   * Model the managed Codex profile asks Local Router for. Codex CLI has one
   * selectable model (no Anthropic-style role slots), so the Agents page
   * writes this value straight into ~/.codex/local-router.config.toml.
   */
  model: string;
};

export type AgentProxyConfig = {
  claudeCode: {
    enabled: boolean;
    models: ClaudeModelSlotMappings;
  };
  codex: CodexHarnessConfig;
};

export const DEFAULT_AGENT_PROXY_CONFIG: AgentProxyConfig = {
  claudeCode: {
    enabled: false,
    models: {
      default: 'local-router/fallback-models',
      opus1m: 'local-router/fallback-models',
      sonnet: 'local-router/fallback-models',
      sonnet5_1m: 'local-router/fallback-models',
      haiku: 'local-router/fallback-models'
    }
  },
  codex: {
    enabled: false,
    model: 'local-router/fallback-models'
  }
};

export function loadAgentProxyConfig(): AgentProxyConfig {
  try {
    if (!fs.existsSync(AGENT_PROXY_CONFIG_PATH)) {
      return JSON.parse(JSON.stringify(DEFAULT_AGENT_PROXY_CONFIG));
    }
    const raw = fs.readFileSync(AGENT_PROXY_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const claude = parsed?.claudeCode;
    const codex = parsed?.codex;
    return {
      claudeCode: {
        enabled: Boolean(claude?.enabled),
        models: {
          default: typeof claude?.models?.default === 'string' ? claude.models.default : DEFAULT_AGENT_PROXY_CONFIG.claudeCode.models.default,
          opus1m: typeof claude?.models?.opus1m === 'string' ? claude.models.opus1m : DEFAULT_AGENT_PROXY_CONFIG.claudeCode.models.opus1m,
          sonnet: typeof claude?.models?.sonnet === 'string' ? claude.models.sonnet : DEFAULT_AGENT_PROXY_CONFIG.claudeCode.models.sonnet,
          sonnet5_1m: typeof claude?.models?.sonnet5_1m === 'string' ? claude.models.sonnet5_1m : DEFAULT_AGENT_PROXY_CONFIG.claudeCode.models.sonnet5_1m,
          haiku: typeof claude?.models?.haiku === 'string' ? claude.models.haiku : DEFAULT_AGENT_PROXY_CONFIG.claudeCode.models.haiku
        }
      },
      codex: {
        enabled: Boolean(codex?.enabled),
        model: typeof codex?.model === 'string' && codex.model.trim()
          ? codex.model.trim()
          : DEFAULT_AGENT_PROXY_CONFIG.codex.model
      }
    };
  } catch (error) {
    console.error('[config] failed to load agent proxy config', error);
    return JSON.parse(JSON.stringify(DEFAULT_AGENT_PROXY_CONFIG));
  }
}

export function saveAgentProxyConfig(config: AgentProxyConfig): void {
  try {
    fs.mkdirSync(path.dirname(AGENT_PROXY_CONFIG_PATH), { recursive: true, mode: 0o700 });
    fs.writeFileSync(AGENT_PROXY_CONFIG_PATH, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(AGENT_PROXY_CONFIG_PATH, 0o600);
  } catch (error) {
    console.error('[config] failed to save agent proxy config', error);
    throw error;
  }
}

