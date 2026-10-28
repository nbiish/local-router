import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Managed Codex CLI wiring for the Agents page.
 *
 * Codex (0.134+) reads `~/.codex/config.toml` for provider definitions and
 * `~/.codex/<profile>.config.toml` for a named profile layer. Interception is
 * therefore two files, both owned by Local Router:
 *
 *   1. config.toml — a managed `[model_providers.local-router]` table pointing
 *      `wire_api = "responses"` at the loopback Responses shim.
 *   2. local-router.config.toml — the profile that selects that provider and
 *      the model Local Router should route to.
 *
 * Both writes are fenced by markers so an operator's own config.toml is never
 * rewritten wholesale. Disabling interception removes only what we wrote.
 */

export const CODEX_MANAGED_BEGIN =
  '# >>> local-router managed block — regenerate from /config/agents; edits inside are overwritten >>>';
export const CODEX_MANAGED_END = '# <<< local-router managed block <<<';

export const CODEX_PROFILE_FILENAME = 'local-router.config.toml';
export const CODEX_PROFILE_MARKER =
  '# local-router profile — regenerate from /config/agents; edits are overwritten';

export const CODEX_PROVIDER_ID = 'local-router';

export type CodexProviderBlockState = 'present' | 'missing' | 'conflict';
export type CodexProfileState = 'present' | 'missing' | 'stale';

export type CodexHarnessState = {
  home: string;
  configPath: string;
  profilePath: string;
  providerBlock: CodexProviderBlockState;
  profile: CodexProfileState;
  profileModel: string | null;
};

export type CodexSyncResult = {
  ok: boolean;
  enabled: boolean;
  configPath: string;
  profilePath: string;
  changed: boolean;
  error?: string;
};

export function codexHomeDir(override?: string): string {
  const explicit = (override || process.env.CODEX_HOME || '').trim();
  return explicit ? path.resolve(explicit) : path.join(os.homedir(), '.codex');
}

export function codexConfigPath(home?: string): string {
  return path.join(codexHomeDir(home), 'config.toml');
}

export function codexProfilePath(home?: string): string {
  return path.join(codexHomeDir(home), CODEX_PROFILE_FILENAME);
}

/** TOML basic string with the escapes TOML actually defines. */
export function tomlString(value: string): string {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`;
}

export function renderCodexProviderBlock(baseUrl: string): string {
  // Codex appends `/responses` (wire_api = responses) and `/chat/completions`
  // (wire_api = chat) to base_url, so the value must end in /v1.
  const normalized = baseUrl.replace(/\/+$/, '');
  return [
    CODEX_MANAGED_BEGIN,
    `[model_providers.${CODEX_PROVIDER_ID}]`,
    'name = "Local Router"',
    `base_url = ${tomlString(`${normalized}/v1`)}`,
    'wire_api = "responses"',
    'env_key = "OPENAI_API_KEY"',
    CODEX_MANAGED_END,
    ''
  ].join('\n');
}

export function renderCodexProfileBlock(model: string): string {
  return [
    CODEX_PROFILE_MARKER,
    `model_provider = "${CODEX_PROVIDER_ID}"`,
    `model = ${tomlString(model)}`,
    ''
  ].join('\n');
}

function managedBlockRange(text: string): { begin: number; end: number } | null {
  const begin = text.indexOf(CODEX_MANAGED_BEGIN);
  const end = text.indexOf(CODEX_MANAGED_END);
  if (begin < 0 && end < 0) return null;
  if (begin < 0 || end < begin) {
    throw new Error('Codex config.toml has an incomplete Local Router managed block; repair the markers before enabling interception.');
  }
  return { begin, end: end + CODEX_MANAGED_END.length };
}

function stripManagedBlock(text: string): string {
  const range = managedBlockRange(text);
  if (!range) return text;
  return `${text.slice(0, range.begin)}${text.slice(range.end)}`;
}

/** True when an operator-defined `[model_providers.local-router]` exists outside our block. */
function hasForeignProviderTable(text: string): boolean {
  const outside = stripManagedBlock(text);
  return /^[ \t]*\[[ \t]*model_providers[ \t]*\.[ \t]*(?:"local-router"|local-router)[ \t]*\]/m.test(outside);
}

export function upsertManagedBlock(existing: string, block: string): string {
  const range = managedBlockRange(existing);
  const normalizedBlock = block.trim();
  if (range) {
    const before = existing.slice(0, range.begin).replace(/\s+$/, '');
    const after = existing.slice(range.end).replace(/^\s+/, '');
    return `${[before, normalizedBlock, after].filter(Boolean).join('\n\n')}\n`;
  }
  const trimmed = existing.replace(/\s+$/, '');
  if (!trimmed) return `${normalizedBlock}\n`;
  return `${trimmed}\n\n${normalizedBlock}\n`;
}

export function removeManagedBlock(existing: string): string {
  const range = managedBlockRange(existing);
  if (!range) return existing;
  const before = existing.slice(0, range.begin).replace(/\s+$/, '');
  const after = existing.slice(range.end).replace(/^\s+/, '');
  const joined = [before, after].filter((part) => part.length > 0).join('\n\n');
  return joined ? `${joined}\n` : '';
}

function readText(filePath: string): string {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  } catch {
    return '';
  }
}

function parseProfileModel(text: string): string | null {
  const match = /^[ \t]*model[ \t]*=[ \t]*"((?:[^"\\]|\\.)*)"/m.exec(text);
  if (!match) return null;
  return match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

export function readCodexHarnessState(opts?: { codexHome?: string }): CodexHarnessState {
  const home = codexHomeDir(opts?.codexHome);
  const configPath = path.join(home, 'config.toml');
  const profilePath = path.join(home, CODEX_PROFILE_FILENAME);

  const configText = readText(configPath);
  let providerBlock: CodexProviderBlockState = 'missing';
  try {
    providerBlock = hasForeignProviderTable(configText)
      ? 'conflict'
      : managedBlockRange(configText)
        ? 'present'
        : 'missing';
  } catch {
    providerBlock = 'conflict';
  }

  const profileText = readText(profilePath);
  const profileModel = parseProfileModel(profileText);
  let profileState: CodexProfileState = 'missing';
  if (profileText.trim()) {
    const pointsAtLocalRouter = new RegExp(
      `^[ \\t]*model_provider[ \\t]*=[ \\t]*"${CODEX_PROVIDER_ID}"`,
      'm'
    ).test(profileText);
    profileState = pointsAtLocalRouter && profileModel ? 'present' : 'stale';
  }

  return {
    home,
    configPath,
    profilePath,
    providerBlock,
    profile: profileState,
    profileModel
  };
}

/**
 * Reconcile the two Codex files with the Agents page state.
 *
 * Enabled: write the provider table + profile (idempotent; no rewrite when the
 * content already matches). Disabled: remove the managed block and the profile
 * file, leaving the rest of the operator's config.toml untouched.
 */
export function syncCodexHarnessConfig(opts: {
  enabled: boolean;
  model: string;
  baseUrl: string;
  codexHome?: string;
}): CodexSyncResult {
  const home = codexHomeDir(opts?.codexHome);
  const configPath = path.join(home, 'config.toml');
  const profilePath = path.join(home, CODEX_PROFILE_FILENAME);
  const model = String(opts.model || '').trim();
  const baseUrl = String(opts.baseUrl || '').trim();
  const result: CodexSyncResult = {
    ok: true,
    enabled: Boolean(opts.enabled),
    configPath,
    profilePath,
    changed: false
  };

  if (opts.enabled && (!model || !baseUrl)) {
    return { ...result, ok: false, error: 'Codex interception needs a model and a loopback base URL.' };
  }

  try {
    if (!opts.enabled) {
      const existing = readText(configPath);
      if (existing) {
        const next = removeManagedBlock(existing);
        if (next !== existing) {
          fs.writeFileSync(configPath, next, { encoding: 'utf8', mode: 0o600 });
          result.changed = true;
        }
      }
      const profileText = readText(profilePath);
      // Only delete the profile when it still carries our marker — a file the
      // operator replaced by hand is theirs.
      if (profileText.trim() && profileText.startsWith(CODEX_PROFILE_MARKER)) {
        fs.rmSync(profilePath, { force: true });
        result.changed = true;
      }
      return result;
    }

    fs.mkdirSync(home, { recursive: true, mode: 0o700 });

    const existing = readText(configPath);
    if (hasForeignProviderTable(existing)) {
      return {
        ...result,
        ok: false,
        error: `${configPath} already defines [model_providers.${CODEX_PROVIDER_ID}]. Rename or remove that table, then retry.`
      };
    }
    const nextConfig = upsertManagedBlock(existing, renderCodexProviderBlock(baseUrl));
    if (nextConfig !== existing) {
      fs.writeFileSync(configPath, nextConfig, { encoding: 'utf8', mode: 0o600 });
      result.changed = true;
    }

    const existingProfile = readText(profilePath);
    const nextProfile = renderCodexProfileBlock(model);
    if (existingProfile !== nextProfile) {
      fs.writeFileSync(profilePath, nextProfile, { encoding: 'utf8', mode: 0o600 });
      result.changed = true;
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
