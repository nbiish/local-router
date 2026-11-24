import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isLoopbackUrl } from './agent-pi-config';

/**
 * Managed Hermes Agent config wiring (`config.yaml` + context/consolidation profiles).
 *
 * Hermes stores its root home at:
 *   - `$HERMES_HOME` when explicitly set
 *   - `%LOCALAPPDATA%\hermes` on Windows
 *   - `~/.hermes` on macOS/Linux/WSL
 *
 * Zero external YAML dependencies are used here so `local-router` stays lean.
 * Only `providers.local-router` (and `model.provider`/`model.default` inside
 * `context-*` and `consolidate-*` profiles) is managed; `.env`, `auth.json`,
 * other providers, and operator profiles remain untouched.
 */

export const HERMES_PROVIDER_ID = 'local-router';
export const HERMES_MANAGED_MARKER = '# local-router managed';
export const HERMES_DEFAULT_MODEL = 'local-router/fallback-models';

export type HermesProfileStatus = {
  name: string;
  configPath: string;
  providerPresent: boolean;
  baseUrl: string | null;
  defaultProvider: string | null;
  defaultModel: string | null;
  isContextProfile: boolean;
};

export type HermesHarnessState = {
  home: string;
  configPath: string;
  exists: boolean;
  providerPresent: boolean;
  baseUrl: string | null;
  defaultProvider: string | null;
  defaultModel: string | null;
  profiles: HermesProfileStatus[];
};

export type HermesSyncResult = {
  ok: boolean;
  enabled: boolean;
  configPath: string;
  changed: boolean;
  profilesUpdated: string[];
  error?: string;
};

export function hermesHomeDir(override?: string): string {
  const explicit = (override || process.env.HERMES_HOME || '').trim();
  if (explicit) return path.resolve(explicit);
  if (process.platform === 'win32') {
    const localAppData = (process.env.LOCALAPPDATA || '').trim();
    const base = localAppData || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'hermes');
  }
  return path.join(os.homedir(), '.hermes');
}

export function hermesProfilesDir(homeOverride?: string): string {
  return path.join(hermesHomeDir(homeOverride), 'profiles');
}

export function isContextAgentProfile(name: string): boolean {
  return name.startsWith('context-') || name.startsWith('consolidate-');
}

function normalizeLoopbackV1(baseUrl: string): string {
  const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed || !isLoopbackUrl(trimmed)) {
    throw new Error(`Hermes local-router base_url must be a loopback URL, got: ${trimmed || '(empty)'}`);
  }
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

function validateModelId(model: string): string {
  const clean = String(model || '').trim();
  if (!clean || clean.length > 200 || /[\r\n]/.test(clean)) {
    throw new Error('Hermes model must be a single non-empty model id (200 chars max).');
  }
  return clean;
}

function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value) && !['true', 'false', 'null', '~'].includes(value.toLowerCase())) {
    return value;
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function unquoteYaml(raw: string): string {
  const trimmed = raw.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function findTopLevelBlock(lines: string[], key: string): { start: number; end: number } | null {
  const headerRe = new RegExp(`^${key}:\\s*(?:#.*)?$`);
  const start = lines.findIndex((line) => headerRe.test(line));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (/^\S/.test(line) && !line.startsWith('#')) break;
    end += 1;
  }
  return { start, end };
}

function findSubBlock(lines: string[], parentStart: number, parentEnd: number, subKey: string, indent = 2): { start: number; end: number } | null {
  const prefix = ' '.repeat(indent);
  const re = new RegExp(`^${prefix}${subKey}:\\s*(?:#.*)?$`);
  for (let i = parentStart + 1; i < parentEnd; i += 1) {
    if (!re.test(lines[i])) continue;
    let end = i + 1;
    while (end < parentEnd) {
      const line = lines[end];
      if (!line.trim() || line.trim().startsWith('#')) {
        end += 1;
        continue;
      }
      const lead = line.match(/^ */)?.[0].length ?? 0;
      if (lead <= indent) break;
      end += 1;
    }
    return { start: i, end };
  }
  return null;
}

function extractSubKey(lines: string[], start: number, end: number, key: string): string | null {
  const re = new RegExp(`^\\s+${key}:\\s*(.+?)\\s*(?:#.*)?$`);
  for (let i = start + 1; i < end; i += 1) {
    const m = re.exec(lines[i]);
    if (m) return unquoteYaml(m[1]);
  }
  return null;
}

export function inspectHermesConfigYaml(text: string): {
  providerPresent: boolean;
  baseUrl: string | null;
  defaultProvider: string | null;
  defaultModel: string | null;
} {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const modelBlock = findTopLevelBlock(lines, 'model');
  const defaultProvider = modelBlock ? extractSubKey(lines, modelBlock.start, modelBlock.end, 'provider') : null;
  const defaultModel = modelBlock ? extractSubKey(lines, modelBlock.start, modelBlock.end, 'default') : null;

  const providersBlock = findTopLevelBlock(lines, 'providers');
  const lrBlock = providersBlock ? findSubBlock(lines, providersBlock.start, providersBlock.end, HERMES_PROVIDER_ID, 2) : null;
  if (!lrBlock) {
    return { providerPresent: false, baseUrl: null, defaultProvider, defaultModel };
  }
  const baseUrl = extractSubKey(lines, lrBlock.start, lrBlock.end, 'base_url');
  return {
    providerPresent: Boolean(baseUrl),
    baseUrl,
    defaultProvider,
    defaultModel
  };
}

function renderLocalRouterProviderLines(v1BaseUrl: string, model: string): string[] {
  return [
    `  ${HERMES_PROVIDER_ID}: ${HERMES_MANAGED_MARKER}`,
    '    name: Local Router',
    `    base_url: ${yamlScalar(v1BaseUrl)}`,
    '    api_key: local-router',
    `    model: ${yamlScalar(model)}`,
    '    discover_models: true',
    '    models:',
    `      ${yamlScalar(model)}: {}`
  ];
}

export function upsertHermesConfigYaml(
  existingText: string,
  opts: { v1BaseUrl: string; model: string; setDefaultModel: boolean }
): string {
  const normalized = existingText ? existingText.replace(/\r\n/g, '\n') : '';
  let lines = normalized ? normalized.split('\n') : [];
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  if (opts.setDefaultModel) {
    const modelBlock = findTopLevelBlock(lines, 'model');
    if (!modelBlock) {
      const insertion = ['model:', `  default: ${yamlScalar(opts.model)}`, `  provider: ${HERMES_PROVIDER_ID}`];
      lines = [...insertion, ...(lines.length ? [''] : []), ...lines];
    } else {
      let hasDefault = false;
      let hasProvider = false;
      for (let i = modelBlock.start + 1; i < modelBlock.end; i += 1) {
        if (/^\s{2}default:/.test(lines[i])) {
          lines[i] = `  default: ${yamlScalar(opts.model)}`;
          hasDefault = true;
        } else if (/^\s{2}provider:/.test(lines[i])) {
          lines[i] = `  provider: ${HERMES_PROVIDER_ID}`;
          hasProvider = true;
        }
      }
      const extras: string[] = [];
      if (!hasDefault) extras.push(`  default: ${yamlScalar(opts.model)}`);
      if (!hasProvider) extras.push(`  provider: ${HERMES_PROVIDER_ID}`);
      if (extras.length > 0) {
        lines.splice(modelBlock.start + 1, 0, ...extras);
      }
    }
  }

  const blockLines = renderLocalRouterProviderLines(opts.v1BaseUrl, opts.model);
  const providersBlock = findTopLevelBlock(lines, 'providers');
  if (!providersBlock) {
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    lines.push('providers:', ...blockLines);
  } else {
    const lrBlock = findSubBlock(lines, providersBlock.start, providersBlock.end, HERMES_PROVIDER_ID, 2);
    if (lrBlock) {
      // Trim trailing blank lines inside the old sub-block so spacing stays tight.
      let replaceEnd = lrBlock.end;
      while (replaceEnd > lrBlock.start + 1 && !lines[replaceEnd - 1].trim()) {
        replaceEnd -= 1;
      }
      lines.splice(lrBlock.start, replaceEnd - lrBlock.start, ...blockLines);
    } else {
      let insertAt = providersBlock.end;
      while (insertAt > providersBlock.start + 1 && !lines[insertAt - 1].trim()) {
        insertAt -= 1;
      }
      lines.splice(insertAt, 0, ...blockLines);
    }
  }

  return `${lines.join('\n')}\n`;
}

export function removeManagedHermesProvider(existingText: string): string {
  const lines = existingText.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const providersBlock = findTopLevelBlock(lines, 'providers');
  if (!providersBlock) return existingText;
  const lrBlock = findSubBlock(lines, providersBlock.start, providersBlock.end, HERMES_PROVIDER_ID, 2);
  if (!lrBlock) return existingText;
  if (!lines[lrBlock.start].includes(HERMES_MANAGED_MARKER)) {
    // Operator-authored block without our marker — leave untouched.
    return existingText;
  }
  let removeEnd = lrBlock.end;
  while (removeEnd > lrBlock.start + 1 && !lines[removeEnd - 1].trim()) {
    removeEnd -= 1;
  }
  lines.splice(lrBlock.start, removeEnd - lrBlock.start);
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

function writeTextAtomic(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, text, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows NTFS ignores POSIX chmod bits.
  }
}

export function readHermesHarnessState(opts?: { hermesHome?: string; baseUrl?: string }): HermesHarnessState {
  const home = hermesHomeDir(opts?.hermesHome);
  const configPath = path.join(home, 'config.yaml');
  const exists = fs.existsSync(configPath);
  const rootText = exists ? fs.readFileSync(configPath, 'utf8') : '';
  const rootInfo = rootText ? inspectHermesConfigYaml(rootText) : {
    providerPresent: false,
    baseUrl: null,
    defaultProvider: null,
    defaultModel: null
  };

  const profiles: HermesProfileStatus[] = [];
  const profilesDir = path.join(home, 'profiles');
  if (fs.existsSync(profilesDir)) {
    try {
      const entries = fs.readdirSync(profilesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const pCfg = path.join(profilesDir, entry.name, 'config.yaml');
        if (!fs.existsSync(pCfg)) continue;
        const pText = fs.readFileSync(pCfg, 'utf8');
        const info = inspectHermesConfigYaml(pText);
        profiles.push({
          name: entry.name,
          configPath: pCfg,
          providerPresent: info.providerPresent,
          baseUrl: info.baseUrl,
          defaultProvider: info.defaultProvider,
          defaultModel: info.defaultModel,
          isContextProfile: isContextAgentProfile(entry.name)
        });
      }
      profiles.sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      // Unreadable profiles dir — report empty list rather than crashing status.
    }
  }

  return {
    home,
    configPath,
    exists,
    ...rootInfo,
    profiles
  };
}

export function syncHermesHarnessConfig(opts: {
  enabled: boolean;
  model: string;
  baseUrl: string;
  syncProfiles?: boolean;
  hermesHome?: string;
}): HermesSyncResult {
  const home = hermesHomeDir(opts.hermesHome);
  const configPath = path.join(home, 'config.yaml');
  const result: HermesSyncResult = {
    ok: true,
    enabled: Boolean(opts.enabled),
    configPath,
    changed: false,
    profilesUpdated: []
  };

  try {
    if (!opts.enabled) {
      if (fs.existsSync(configPath)) {
        const existing = fs.readFileSync(configPath, 'utf8');
        const next = removeManagedHermesProvider(existing);
        if (next !== existing) {
          writeTextAtomic(configPath, next);
          result.changed = true;
        }
      }
      return result;
    }

    const model = validateModelId(opts.model);
    const v1BaseUrl = normalizeLoopbackV1(opts.baseUrl);

    const existingRoot = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
    const nextRoot = upsertHermesConfigYaml(existingRoot, {
      v1BaseUrl,
      model,
      setDefaultModel: false
    });
    if (nextRoot !== existingRoot) {
      writeTextAtomic(configPath, nextRoot);
      result.changed = true;
    }

    if (opts.syncProfiles !== false) {
      const profilesDir = path.join(home, 'profiles');
      if (fs.existsSync(profilesDir)) {
        const entries = fs.readdirSync(profilesDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('.') || !isContextAgentProfile(entry.name)) {
            continue;
          }
          const profileConfig = path.join(profilesDir, entry.name, 'config.yaml');
          const existingProfile = fs.existsSync(profileConfig) ? fs.readFileSync(profileConfig, 'utf8') : '';
          const nextProfile = upsertHermesConfigYaml(existingProfile, {
            v1BaseUrl,
            model,
            setDefaultModel: true
          });
          if (nextProfile !== existingProfile) {
            writeTextAtomic(profileConfig, nextProfile);
            result.changed = true;
            result.profilesUpdated.push(entry.name);
          }
        }
      }
    }

    return result;
  } catch (error: any) {
    return {
      ...result,
      ok: false,
      error: error?.message || String(error)
    };
  }
}
