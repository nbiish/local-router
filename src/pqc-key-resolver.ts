/**
 * pqc-key-resolver.ts — map a secret name from the PQC bundle onto a provider.
 *
 * Operators (and other agent tools) naturally name keys by provider:
 * `LOCALROUTER_ZAI_API_KEY`, `LOCAL_ROUTER_XIAOMI_MIMO`, `WAFER_API_KEY`, or
 * even plain `ZAI_API_KEY`. Local Router's canonical name is
 * `LOCALROUTER_<provider.keyEnvVar>`, but accepting the obvious variants is
 * what makes a packed key actually usable instead of "not picked up".
 *
 * Both tool prefixes are accepted (`LOCALROUTER_` and the underscore form
 * `LOCAL_ROUTER_` that older docs/tools emitted). A name only maps when it
 * matches a registered provider's env var, slug, or a documented variant —
 * never by fuzzy substring.
 */

export type ProviderKeySummary = {
  name: string;
  keyEnvVar: string;
};

const TOOL_PREFIXES = ['LOCALROUTER_', 'LOCAL_ROUTER_', 'LOCAL-ROUTER_'];

export function stripToolPrefix(rawName: string): string {
  const normalized = String(rawName || '').trim().toUpperCase();
  for (const prefix of TOOL_PREFIXES) {
    if (normalized.startsWith(prefix)) return normalized.slice(prefix.length);
  }
  return normalized;
}

function slugAliases(providerName: string): string[] {
  const slug = String(providerName || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  // Only the full slug. Progressive prefixes (OPENCODE for opencode-zen) would
  // collide with a sibling provider's real env var.
  return slug ? [slug] : [];
}

const SUFFIXES = ['', '_API_KEY', '_KEY', '_TOKEN'];

/**
 * Every key name Local Router accepts for one provider, without the tool
 * prefix. Canonical env var first, then slug-derived variants.
 */
export function providerKeyAliases(summary: ProviderKeySummary): string[] {
  const aliases = new Set<string>();
  const envVar = String(summary.keyEnvVar || '').trim().toUpperCase();
  if (envVar) {
    aliases.add(envVar);
    const base = envVar.replace(/_(API_KEY|KEY|TOKEN)$/, '');
    if (base) {
      for (const suffix of SUFFIXES) aliases.add(`${base}${suffix}`);
    }
  }
  for (const slugAlias of slugAliases(summary.name)) {
    for (const suffix of SUFFIXES) aliases.add(`${slugAlias}${suffix}`);
  }
  aliases.delete('');
  return Array.from(aliases);
}

/** Strip one matching pair of shell quotes from an exported value. */
export function unquoteSecretValue(rawValue: string): string {
  const trimmed = String(rawValue ?? '').trim();
  const match = /^(['"])([\s\S]*)\1$/.exec(trimmed);
  return match ? match[2] : trimmed;
}

export function resolveProvidersForKey<T extends ProviderKeySummary>(fullName: string, summaries: T[]): T[] {
  const bare = stripToolPrefix(fullName);
  if (!bare) return [];

  const direct = summaries.filter((summary) => String(summary.keyEnvVar || '').toUpperCase() === bare);
  if (direct.length > 0) return direct;

  const exact = summaries.filter((summary) => providerKeyAliases(summary).includes(bare));
  if (exact.length > 0) return exact;

  // Underscore-insensitive fallback so Z_AI/_ZAI and XIAOMI-MIMO spellings
  // resolve without opening the door to substring guesses.
  const squashed = bare.replace(/_/g, '');
  return summaries.filter((summary) =>
    providerKeyAliases(summary).some((alias) => alias.replace(/_/g, '') === squashed)
  );
}

/** Human-readable hint for an unmapped bundle entry (names only, no values). */
export function suggestKeyName(fullName: string, summaries: ProviderKeySummary[]): string | null {
  const bare = stripToolPrefix(fullName)
    .replace(/_(API_KEY|KEY|TOKEN)$/, '')
    .replace(/_/g, '');
  if (!bare) return null;
  for (const summary of summaries) {
    const aliases = providerKeyAliases(summary).map((alias) => alias.replace(/_/g, ''));
    if (aliases.some((alias) => alias.includes(bare) || bare.includes(alias))) {
      return `LOCALROUTER_${summary.keyEnvVar}`;
    }
  }
  return null;
}
