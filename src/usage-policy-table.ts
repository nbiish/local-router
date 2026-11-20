/**
 * usage-policy-table.ts — per-provider usage facts, one row per access path.
 *
 * This is the code-owned half of the usage model; `docs/usage/<provider>.txt`
 * carries the long-form evidence and the "Last verified" date. A row exists for
 * every provider in the registry so an unclassifiable one is a visible gap
 * rather than a silent default.
 *
 * Provenance of these facts (verified 2026-11-18 unless noted):
 *   - Operator statement: the ONLY subscription is the GLM coding plan (z.ai).
 *     Everything else is either a free tier or a metered API key.
 *   - Operator statement: the Xiaomi MiMo plan is a token allowance, not a
 *     rate-limited window — it meters spend, so it behaves like a paid key that
 *     eventually runs dry, not like a rolling window.
 *   - Operator statement: Ollama, Unsloth and llama.cpp stay available as
 *     providers so online and local usage can be combined; they are `local`
 *     and have no usage window to exhaust.
 *   - Free-tier allowances (OpenRouter `:free`, Kilo, Cline) are UNDOCUMENTED
 *     and change without notice. They are recorded as `free` with no window and
 *     a note saying so: the honest state is "unknown", and observed behaviour
 *     (via the failure-rate system) is what teaches us the real shape.
 *
 * Adding a provider here is one row. A provider with no row gets `unknown`,
 * which behaves exactly like today's retry default and never quarantines
 * longer than the retry class would.
 */

import type { UsagePolicy } from './usage-policy';

/** Providers whose allowance is genuinely unknown. Kept explicit so the gap is visible. */
const UNKNOWN_FREE_NOTE = 'free tier; published allowance undocumented and subject to change — learned from observed failures, not assumed';

export const PROVIDER_USAGE_POLICIES: Record<string, UsagePolicy> = {
  // --- subscription capacity (the only one, per operator 2026-11-18) -------
  zai: {
    class: 'subscription',
    // The GLM coding plan meters over a rolling window. The operator reports
    // five-hour cool times for this class of plan; the window is what a spent
    // allowance must be parked for, so a 429 that says "limit resets" parks the
    // member for the window instead of the 5-minute retry default.
    windowMinutes: 5 * 60,
    resetPublished: false,
    note: 'GLM Coding Plan (api.z.ai) — the operator’s only subscription; rolling ~5h window, resets not published in headers'
  },

  // --- metered paid keys ---------------------------------------------------
  openrouter: {
    class: 'paid',
    resetPublished: true,
    note: 'metered API key; free :free models share the same key but are rate-limited upstream and say "retry shortly"'
  },
  wafer: { class: 'paid', resetPublished: false, note: 'pay-as-you-go pass.wafer.ai' },
  'wafer-serverless': { class: 'paid', resetPublished: false, note: 'pay-as-you-go pass.wafer.ai' },
  zenmux: { class: 'paid', resetPublished: false, note: 'metered reseller' },
  nebius: { class: 'paid', resetPublished: false, note: 'metered inference' },
  'nebius-us-north1': { class: 'paid', resetPublished: false, note: 'metered inference; region-pinned Token Factory gateway sharing the global Nebius credential' },
  moonshot: { class: 'paid', resetPublished: false, note: 'metered inference' },
  fastino: { class: 'paid', resetPublished: false, note: 'metered inference (replaced pioneer)' },
  'nous-portal': { class: 'paid', resetPublished: false, note: 'metered portal' },
  'nvidia-nim': { class: 'paid', resetPublished: false, note: 'metered NIM' },
  'modal-proxy': { class: 'paid', resetPublished: false, note: 'metered proxy token pair' },
  modal: { class: 'paid', resetPublished: false, note: 'metered' },
  typesafe: { class: 'paid', resetPublished: false, note: 'decision-model source; metered' },
  'xiaomi-mimo': {
    class: 'paid',
    resetPublished: false,
    // Operator: "I don't think there are rate limits. I think I'm just given a
    // designated token limit." A token allowance that runs out is a spend
    // problem (out_of_funds), not a window to wait out — so no windowMinutes.
    note: 'MiMo token plan — designated token allowance, no rolling rate limit (operator 2026-11-18)'
  },
  commandcode: { class: 'paid', resetPublished: false, note: 'metered' },

  // --- free tiers (allowance unknown) --------------------------------------
  kilo: { class: 'free', resetPublished: false, note: UNKNOWN_FREE_NOTE },
  cline: { class: 'free', resetPublished: false, note: UNKNOWN_FREE_NOTE },
  'opencode-zen': { class: 'free', resetPublished: false, note: UNKNOWN_FREE_NOTE },
  'opencode-go': { class: 'free', resetPublished: false, note: UNKNOWN_FREE_NOTE },

  // --- local / self-hosted -------------------------------------------------
  // Kept so online and local usage can be combined. A local backend has no
  // window and no allowance; if it fails it is a process problem, not a budget.
  ollama: { class: 'local', note: 'local backend; no usage window' },
  unsloth: { class: 'local', note: 'local backend; no usage window' },
  'llama-cpp': { class: 'local', note: 'local backend; no usage window' },

  // --- OAuth sessions ------------------------------------------------------
  // The router treats any OAuth provider as already-paid capacity
  // (fallback-topology doctrine). The operator does not hold a Cursor or
  // Copilot subscription, so these resolve through local session detection;
  // they are recorded as free-with-unknown-allowance rather than subscription
  // until the operator says otherwise.
  cursor: { class: 'free', resetPublished: false, note: 'local OAuth session detected; operator holds no Cursor subscription (2026-11-18) — allowance unknown' },
  'github-copilot': { class: 'free', resetPublished: false, note: 'local OAuth session detected; operator holds no Copilot subscription (2026-11-18) — allowance unknown' },
  antigravity: { class: 'free', resetPublished: false, note: UNKNOWN_FREE_NOTE }
};

/** Normalize provider aliases so a registry name always finds its row. */
function normalizeProviderName(name: string): string {
  const lower = String(name || '').trim().toLowerCase();
  if (lower === 'wafer') return 'wafer-serverless';
  if (lower === 'llamacpp' || lower === 'llama_cpp') return 'llama-cpp';
  if (lower === 'xiaomi') return 'xiaomi-mimo';
  if (lower === 'unsloth-ai') return 'unsloth';
  return lower;
}

export function usagePolicyFor(providerName: string): UsagePolicy {
  const key = normalizeProviderName(providerName);
  const found = PROVIDER_USAGE_POLICIES[key];
  if (found) return found;
  return {
    class: 'unknown',
    resetPublished: false,
    note: 'no usage row — treated as unknown; behaves like the retry default and never parks longer than a burst'
  };
}
