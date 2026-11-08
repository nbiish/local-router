/**
 * provider-policy.ts — the single source of truth for two per-{provider, model}
 * contracts that used to be decided by regexes scattered across `index.ts`:
 *
 *   1. how a thinking level is expressed on the wire, and
 *   2. how prompt caching is maximised for that upstream.
 *
 * Everything else consumes this table: `/v1/models` and `/api/show`
 * advertisement, translation of a claimed level on every inbound wire, cache
 * marker injection, and the offline contract matrix in
 * `tests/provider-policy-matrix.test.mjs`.
 *
 * Facts, not guesses. Each row names the doc it came from:
 *   - `docs/caching/<provider>.txt` for caching (verified 2026-08-23, upstream
 *     docs, per provider).
 *   - `llms.txt` (§ Provider Caching / § Thinking) for reasoning dialects.
 *   - Anything the docs do not state is marked `[INFERENCE]` in the row's note
 *     and never presented as measured fact.
 *
 * Two measured facts drive the reasoning table:
 *   - 2026-11-07, ZenMux `deepseek/deepseek-v4.1-flash`: billed reasoning_tokens
 *     per level were minimal 422 < low 577 < medium 706 ≈ high 701, and
 *     `thinking:{type:'disabled'}` produced 0. So `reasoning_effort` is the
 *     working dial for the DeepSeek family on that surface.
 *   - The same run showed `enable_thinking:false` was IGNORED there (455
 *     reasoning tokens still billed). A boolean off-switch is therefore only
 *     trusted where the provider documents it as its native control.
 */

export type ThinkingLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/** Canonical order, weakest to strongest. Used for clamping and unions. */
export const THINKING_LEVEL_ORDER: readonly ThinkingLevel[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium';

/**
 * The request dialect an upstream understands.
 *
 * `anthropic-thinking` exists for an Anthropic-shaped endpoint
 * (`/v1/messages`). No configured provider is reached that way today — the
 * proxy posts every attempt to `/chat/completions` — so no row uses it yet;
 * emitting `thinking:{...}` at a chat endpoint is what a provider 400s on.
 */
export type ReasoningDialect =
  | 'openai-effort'
  | 'anthropic-thinking'
  | 'enable-thinking'
  | 'ollama-think'
  | 'model-id'
  | 'none';

export interface ReasoningPolicy {
  dialect: ReasoningDialect;
  /**
   * The levels this upstream actually distinguishes. A boolean dialect offers
   * two real states, so it declares two — advertising five would be a dial the
   * UI renders and the provider cannot honour.
   */
  levels: ThinkingLevel[];
  defaultLevel: ThinkingLevel;
  acceptsXhigh: boolean;
  /** Only for `anthropic-thinking`: the budget each level buys. */
  budgetPerLevel?: Partial<Record<ThinkingLevel, number>>;
  /** Extra fields that must accompany "thinking on" on this provider. */
  onFields?: Record<string, unknown>;
  note: string;
}

export type CacheMechanism =
  | 'anthropic-cache-control'
  | 'openai-prompt-cache'
  | 'implicit-prefix'
  | 'kv-resident'
  | 'none';

export type StickyKey = 'session_id' | 'prompt_cache_key' | 'keep_alive' | 'none';

export interface CachingPolicy {
  mechanism: CacheMechanism;
  /** Anthropic caps explicit breakpoints at 4; 0 means "inject none". */
  maxBreakpoints: number;
  /** Mark the last tool definition (part of the cacheable prefix). */
  toolBreakpoint: boolean;
  /** Extended TTL, only where the upstream documents one. */
  ttl: '5m' | '1h' | null;
  /** OpenAI-style retention hint, only where the upstream documents one. */
  retention?: '24h';
  stickyKey: StickyKey;
  minCacheableTokens?: number;
  /** True when the upstream rejects unknown `cache_control` markers. */
  stripsCacheControl: boolean;
  /** Ask for the trailing usage chunk so `cached_tokens` is observable. */
  includeStreamUsage: boolean;
  /** Fields this provider treats as a cache-warmth lever, not a reasoning one. */
  extraBodyFields?: Record<string, unknown>;
  note: string;
}

export interface ProviderPolicy {
  reasoning: ReasoningPolicy;
  caching: CachingPolicy;
}

/** A model-family override layers on top of the provider row. */
type PartialReasoning = Partial<ReasoningPolicy>;
type PartialCaching = Partial<CachingPolicy>;

interface FamilyOverride {
  match: RegExp;
  reasoning?: PartialReasoning;
  caching?: PartialCaching;
  note: string;
}

/**
 * Shared policy fragments. Spelling a family out once is what keeps 22 provider
 * rows from drifting against each other.
 */
const EFFORT_FIVE: ThinkingLevel[] = ['none', 'minimal', 'low', 'medium', 'high'];
const EFFORT_FOUR: ThinkingLevel[] = ['none', 'low', 'medium', 'high'];
/** Boolean upstream: the two states it can actually express. */
const BOOLEAN_TWO: ThinkingLevel[] = ['none', 'medium'];

const ANTHROPIC_BUDGETS: Partial<Record<ThinkingLevel, number>> = {
  minimal: 1024,
  low: 1024,
  medium: 4096,
  high: 16384,
  xhigh: 32768
};

function effortPolicy(
  levels: ThinkingLevel[],
  note: string,
  extra: Partial<ReasoningPolicy> = {}
): ReasoningPolicy {
  return {
    dialect: 'openai-effort',
    levels,
    defaultLevel: 'medium',
    acceptsXhigh: false,
    note,
    ...extra
  };
}

function booleanThinking(note: string, extra: Partial<ReasoningPolicy> = {}): ReasoningPolicy {
  return {
    dialect: 'enable-thinking',
    levels: [...BOOLEAN_TWO],
    defaultLevel: 'medium',
    acceptsXhigh: false,
    note,
    ...extra
  };
}

function noThinking(note: string): ReasoningPolicy {
  return {
    dialect: 'none',
    levels: [],
    defaultLevel: 'none',
    acceptsXhigh: false,
    note
  };
}

/** Explicit Anthropic markers. */
function anthropicCache(
  note: string,
  extra: Partial<CachingPolicy> = {}
): CachingPolicy {
  return {
    mechanism: 'anthropic-cache-control',
    maxBreakpoints: 4,
    toolBreakpoint: true,
    ttl: '1h',
    stickyKey: 'prompt_cache_key',
    stripsCacheControl: false,
    includeStreamUsage: true,
    note,
    ...extra
  };
}

/**
 * OpenAI's own automatic prefix cache. Nothing to mark: the levers are the
 * retention hint and a stable key, and `cache_control` must be stripped or the
 * endpoint rejects the body.
 */
function openAiCache(
  note: string,
  extra: Partial<CachingPolicy> = {}
): CachingPolicy {
  return {
    mechanism: 'openai-prompt-cache',
    maxBreakpoints: 0,
    toolBreakpoint: false,
    ttl: null,
    retention: '24h',
    stickyKey: 'prompt_cache_key',
    stripsCacheControl: true,
    includeStreamUsage: true,
    note,
    ...extra
  };
}

/** Upstream prefix cache with nothing to mark; the only lever is prefix stability. */
function implicitCache(
  note: string,
  extra: Partial<CachingPolicy> = {}
): CachingPolicy {
  return {
    mechanism: 'implicit-prefix',
    maxBreakpoints: 0,
    toolBreakpoint: false,
    ttl: null,
    stickyKey: 'none',
    stripsCacheControl: true,
    includeStreamUsage: true,
    note,
    ...extra
  };
}

function noCache(note: string): CachingPolicy {
  return {
    mechanism: 'none',
    maxBreakpoints: 0,
    toolBreakpoint: false,
    ttl: null,
    stickyKey: 'none',
    stripsCacheControl: true,
    includeStreamUsage: false,
    note
  };
}

/**
 * One row per provider in `src/provider-registry.ts`, plus the loopback custom
 * providers the router can reach without a registry entry
 * (`llama-cpp`, `llama-local`, `unsloth`).
 */
export const PROVIDER_POLICIES: Record<string, ProviderPolicy> = {
  'wafer-serverless': {
    // Wafer serves DeepSeek/GLM/Kimi/MiniMax on an OpenAI-compatible surface;
    // the thinking control these families honour there is the effort dial
    // [INFERENCE: Wafer publishes no thinking doc; matches the ZenMux-measured
    // behaviour of the same model family].
    reasoning: effortPolicy(EFFORT_FIVE, 'llms.txt §Thinking (family mapping); measured 2026-11-07 on ZenMux for deepseek-v4.1-flash'),
    caching: implicitCache('docs/caching/wafer-serverless.txt — automatic radix prefix cache, no request knobs; cache_read price exposed in /v1/models', {
      stickyKey: 'none'
    })
  },

  zenmux: {
    // Not a single family: the gateway routes to Anthropic, OpenAI, DeepSeek,
    // Qwen, Moonshot and GLM, and translates `reasoning_effort` per upstream.
    reasoning: effortPolicy(EFFORT_FIVE, 'docs/caching/zenmux.txt; measured 2026-11-07: reasoning_effort moves billed reasoning_tokens, thinking:{type:disabled} -> 0'),
    caching: anthropicCache('docs/caching/zenmux.txt — 4 breakpoints, 1h extended TTL, implicit caching for OpenAI/DeepSeek/Kimi/GLM routes', {
      stickyKey: 'prompt_cache_key',
      minCacheableTokens: 1024
    })
  },

  nebius: {
    reasoning: booleanThinking('llms.txt §Thinking (DeepSeek/Qwen/GLM family mapping); Nebius serves vLLM [INFERENCE]'),
    caching: implicitCache('docs/caching/nebius.txt — automatic context cache; Responses API takes prompt_cache_key, chat completions takes nothing', {
      stickyKey: 'prompt_cache_key'
    })
  },

  moonshot: {
    reasoning: booleanThinking('llms.txt line 722 — DeepSeek/Qwen/GLM/Kimi/Step/MiniMax use enable_thinking'),
    caching: implicitCache('docs/caching/moonshot.txt — automatic context cache, 256-token floor, prompt_cache_key steers hits', {
      stickyKey: 'prompt_cache_key',
      minCacheableTokens: 256
    })
  },

  'nvidia-nim': {
    reasoning: booleanThinking('llms.txt §Thinking (Nemotron/Qwen/DeepSeek family); NIM serves via TRT-LLM [INFERENCE]'),
    caching: noCache('docs/caching/nvidia-nim.txt — hosted API documents no prompt caching; reuse is a self-hosted container flag')
  },

  modal: {
    reasoning: booleanThinking('llms.txt §Thinking (Kimi/GLM family); Modal serves vLLM [INFERENCE]'),
    caching: implicitCache('docs/caching/modal.txt — vLLM automatic prefix cache, capacity-bound, no client knobs', {
      stickyKey: 'prompt_cache_key'
    })
  },

  'modal-proxy': {
    reasoning: booleanThinking('llms.txt §Thinking (Kimi family); own GLM-5.3-Flash / Kimi-K3 vLLM deployment [INFERENCE]'),
    caching: implicitCache('docs/caching/modal-proxy.txt — vLLM APC on a private deployment; Modal-Session-ID keeps requests on one replica', {
      stickyKey: 'prompt_cache_key'
    })
  },

  openrouter: {
    reasoning: effortPolicy(EFFORT_FIVE, 'docs/caching/openrouter.txt; OpenRouter normalises reasoning_effort per upstream'),
    caching: anthropicCache('docs/caching/openrouter.txt — cache_control passed to Anthropic/Qwen/Gemini, implicit elsewhere; sticky routing keyed by session_id', {
      stickyKey: 'session_id',
      minCacheableTokens: 1024
    })
  },

  typesafe: {
    // Decisions only. /v1/systemone is not a chat surface.
    reasoning: noThinking('src/decisions/catalog.ts — typed decision models, no chat surface'),
    caching: noCache('docs/caching/typesafe.txt — typed decision transport, no prompt to warm')
  },

  'xiaomi-mimo': {
    reasoning: effortPolicy(EFFORT_FOUR, 'docs/caching/xiaomi-mimo.txt; MiMo publishes cache hit/miss split but no thinking doc [INFERENCE]'),
    caching: implicitCache('docs/caching/xiaomi-mimo.txt — automatic prefix cache with ~1-2% cache-hit input price')
  },

  'opencode-go': {
    reasoning: effortPolicy(EFFORT_FIVE, 'docs/caching/opencode-go.txt — routes MiniMax/Qwen (messages), GLM/Kimi/DeepSeek (chat), Grok/GPT (responses)'),
    caching: anthropicCache('docs/caching/opencode-go.txt — explicit markers on /messages models, automatic elsewhere', {
      minCacheableTokens: 1024
    })
  },

  'opencode-zen': {
    reasoning: effortPolicy(EFFORT_FIVE, 'docs/caching/opencode-zen.txt — same gateway families as Go'),
    caching: anthropicCache('docs/caching/opencode-zen.txt — cache_control on /messages models, automatic elsewhere', {
      minCacheableTokens: 1024
    })
  },

  zai: {
    reasoning: booleanThinking('llms.txt §Z.ai — implicit context cache; GLM reasoning uses enable_thinking, clear_thinking:false keeps reasoning KV warm', {
      // Preserved Thinking: keeps prior reasoning in context so the prefix cache
      // stays warm across turns (llms.txt line 549).
      onFields: { clear_thinking: false }
    }),
    caching: implicitCache('docs/caching/zai.txt — automatic context caching, cached input ~19% of list price', {
      // Documented as a cache lever, not a reasoning one, so it is applied even
      // when the caller said nothing about thinking.
      extraBodyFields: { clear_thinking: false },
      // Z.ai documents no client knob, but `prompt_cache_key` is a standard
      // OpenAI field its inference stack accepts and ignores where unsupported
      // [INFERENCE: not stated either way in docs.z.ai]. Kept because a stable
      // key costs nothing on a surface that ignores it and anchors a session on
      // one that does not.
      stickyKey: 'prompt_cache_key'
    })
  },

  ollama: {
    // The proxy posts to the backend's OpenAI-compatible /chat/completions,
    // which takes reasoning_effort; the Ollama-native `think` boolean is
    // rewired to it by the translation step.
    reasoning: effortPolicy(EFFORT_FOUR, 'docs/caching/ollama.txt; Ollama OpenAI-compat surface [INFERENCE: older builds ignore reasoning_effort]'),
    caching: {
      mechanism: 'kv-resident',
      maxBreakpoints: 0,
      toolBreakpoint: false,
      ttl: null,
      stickyKey: 'keep_alive',
      stripsCacheControl: true,
      includeStreamUsage: false,
      note: 'docs/caching/ollama.txt — no cache API; keep_alive keeps the KV cache resident'
    }
  },

  cline: {
    reasoning: effortPolicy(EFFORT_FIVE, 'docs/caching/cline.txt — OpenAI-compatible gateway over anthropic/*, openai/* and open models'),
    caching: anthropicCache('docs/caching/cline.txt — pass-through of upstream Anthropic cache_control, cached_tokens in usage', {
      minCacheableTokens: 1024
    })
  },

  kilo: {
    reasoning: effortPolicy(EFFORT_FIVE, 'docs/caching/kilo.txt — gateway over 500+ models'),
    caching: anthropicCache('docs/caching/kilo.txt — Anthropic markers reach the upstream Claude route; other families auto-cache', {
      minCacheableTokens: 1024
    })
  },

  commandcode: {
    reasoning: effortPolicy(EFFORT_FIVE, 'docs/caching/commandcode.txt — passthrough gateway, OpenAI schema on /chat/completions'),
    caching: anthropicCache('docs/caching/commandcode.txt — Claude routes accept Anthropic markers [INFERENCE: not documented as a caching feature]', {
      minCacheableTokens: 1024
    })
  },

  antigravity: {
    reasoning: effortPolicy(EFFORT_FOUR, 'docs/caching/antigravity.txt — Gemini via the AI Studio OpenAI-compat surface; thinking_config is not reachable here [INFERENCE]'),
    caching: implicitCache('docs/caching/antigravity.txt — Gemini implicit caching, nothing client-configurable', {
      includeStreamUsage: false
    })
  },

  'github-copilot': {
    reasoning: effortPolicy(EFFORT_FIVE, 'docs/caching/github-copilot.txt — Copilot serves GPT-5.x, Claude and Gemini behind one OpenAI-compatible endpoint'),
    caching: implicitCache('docs/caching/github-copilot.txt — GitHub caches Claude/Gemini prefixes server-side; no client knobs', {
      includeStreamUsage: false
    })
  },

  cursor: {
    // The effort is part of the model id (`...-low`, `...-high`, `...-max`), so
    // there is no request field to set: choosing the id IS the dial.
    reasoning: {
      dialect: 'model-id',
      levels: [],
      defaultLevel: 'none',
      acceptsXhigh: false,
      note: 'docs/caching/cursor.txt — effort is baked into the model id, so no request dial exists'
    },
    caching: implicitCache('docs/caching/cursor.txt — server-side prefix reuse, nothing client-configurable; markers not documented as accepted', {
      includeStreamUsage: false
    })
  },

  pioneer: {
    reasoning: effortPolicy(EFFORT_FIVE, 'docs/caching/pioneer.txt — /v1/chat/completions over Claude and GPT families'),
    caching: anthropicCache('docs/caching/pioneer.txt — 4 markers, 1h TTL, content-block arrays required (plain-string system prompts cannot carry a marker)', {
      minCacheableTokens: 1024
    })
  },

  'nous-portal': {
    reasoning: effortPolicy(EFFORT_FIVE, 'docs/caching/nous-portal.txt — passthrough aggregator over Anthropic/OpenAI/DeepSeek/Kimi'),
    caching: anthropicCache('docs/caching/nous-portal.txt — passthrough; markers honoured only where the route accepts content-block arrays [INFERENCE]', {
      minCacheableTokens: 1024
    })
  },

  // ── Loopback custom providers (no registry entry, no auth) ──────────────
  'llama-cpp': {
    reasoning: effortPolicy(EFFORT_FOUR, 'llama-server OpenAI-compat; reasoning_effort supported for templated reasoning models [INFERENCE]'),
    caching: {
      mechanism: 'kv-resident',
      maxBreakpoints: 0,
      toolBreakpoint: false,
      ttl: null,
      stickyKey: 'none',
      stripsCacheControl: true,
      includeStreamUsage: false,
      note: 'llama.cpp slot KV reuse; prefix stability is the only lever'
    }
  },
  'llama-local': {
    reasoning: effortPolicy(EFFORT_FOUR, 'llama-server OpenAI-compat [INFERENCE]'),
    caching: {
      mechanism: 'kv-resident',
      maxBreakpoints: 0,
      toolBreakpoint: false,
      ttl: null,
      stickyKey: 'none',
      stripsCacheControl: true,
      includeStreamUsage: false,
      note: 'llama.cpp slot KV reuse; prefix stability is the only lever'
    }
  },
  unsloth: {
    reasoning: effortPolicy(EFFORT_FOUR, 'Unsloth Studio OpenAI-compat over llama.cpp [INFERENCE]'),
    caching: {
      mechanism: 'kv-resident',
      maxBreakpoints: 0,
      toolBreakpoint: false,
      ttl: null,
      stickyKey: 'none',
      stripsCacheControl: true,
      includeStreamUsage: false,
      note: 'llama.cpp slot KV reuse; prefix stability is the only lever'
    }
  }
};

/**
 * Model-family overrides applied after the provider row. A gateway routes
 * different families through one endpoint and one provider-level dialect would
 * mis-translate most of them, so the family wins where the docs name it.
 */
const FAMILY_OVERRIDES: readonly FamilyOverride[] = [
  {
    // OpenAI's own models auto-cache and REJECT `cache_control`; Pioneer's doc
    // says outright that markers on GPT models are "ignored or rejected". A
    // marker injected here is a 400, not a cache hit.
    match: /(^|\/)(openai\/)?(gpt-|o[134](-|$)|chatgpt)/i,
    caching: {
      mechanism: 'openai-prompt-cache',
      maxBreakpoints: 0,
      toolBreakpoint: false,
      ttl: null,
      retention: '24h',
      stripsCacheControl: true,
      includeStreamUsage: true,
      note: 'OpenAI family: automatic prefix cache, markers rejected'
    },
    note: 'OpenAI family over a gateway'
  },
  {
    match: /(^|\/)(anthropic\/|claude)/i,
    // Anthropic bills a thinking BUDGET; on a chat-completions gateway it is
    // reached through reasoning_effort, which the gateway maps to that budget.
    reasoning: { dialect: 'openai-effort', levels: EFFORT_FOUR },
    note: 'Anthropic family over an OpenAI-compatible gateway'
  },
  {
    match: /(^|\/)(openai\/)?(gpt-5|gpt-4\.1|o[134](-|$))/i,
    reasoning: { dialect: 'openai-effort', levels: EFFORT_FIVE },
    note: 'OpenAI reasoning family'
  },
  {
    // Measured 2026-11-07: the dial this family honours on a gateway is
    // reasoning_effort, not the boolean enable_thinking.
    match: /deepseek/i,
    reasoning: { dialect: 'openai-effort', levels: EFFORT_FIVE },
    note: 'ZenMux measurement 2026-11-07 (billed reasoning_tokens per level)'
  },
  {
    match: /(moonshotai\/|(^|\/)kimi)/i,
    reasoning: { dialect: 'enable-thinking', levels: BOOLEAN_TWO },
    note: 'llms.txt line 722 — Kimi/Moonshot use enable_thinking'
  },
  {
    match: /(z-ai\/|zai-org\/|(^|[^a-z])glm)/i,
    reasoning: { dialect: 'enable-thinking', levels: BOOLEAN_TWO },
    note: 'llms.txt line 722 — GLM uses enable_thinking'
  },
  {
    match: /(minimax|stepfun|(^|\/)step-|qwen)/i,
    reasoning: { dialect: 'enable-thinking', levels: BOOLEAN_TWO },
    note: 'llms.txt line 722 — Qwen/Step/MiniMax use enable_thinking'
  },
  {
    // gpt-oss / Nemotron / Qwen on vLLM-class servers take a boolean template
    // flag; reasoning_effort is only honoured for gpt-oss.
    match: /(gpt-oss|nemotron)/i,
    reasoning: { dialect: 'openai-effort', levels: EFFORT_FOUR },
    note: 'gpt-oss/Nemotron reasoning_effort [INFERENCE]'
  }
];

/** Unknown providers get the safe row: strip markers, claim nothing. */
const UNKNOWN_POLICY: ProviderPolicy = {
  reasoning: noThinking('unknown provider — no reasoning dial is claimed'),
  caching: noCache('unknown provider — no cache injection')
};

function modelMatches(match: RegExp, haystack: string): boolean {
  // A global regex keeps `lastIndex` between calls; test a fresh copy.
  return new RegExp(match.source, match.flags.replace('g', '')).test(haystack);
}

export function providerPolicyFor(providerName: string): ProviderPolicy {
  const key = String(providerName || '').trim().toLowerCase();
  return PROVIDER_POLICIES[key] || UNKNOWN_POLICY;
}

/**
 * True when this provider has a curated policy row. A custom provider an
 * operator registered at runtime has none, and must keep the portable
 * passthrough contract rather than being treated as "claims no reasoning".
 */
export function hasProviderPolicy(providerName: string): boolean {
  const key = String(providerName || '').trim().toLowerCase();
  return Boolean(PROVIDER_POLICIES[key]);
}

export function resolveReasoningPolicy(providerName: string, modelName?: string): ReasoningPolicy {
  const base = providerPolicyFor(providerName).reasoning;
  const model = String(modelName || '').trim();
  if (!model) return base;

  // `model-id` and `none` are structural facts about the endpoint, not a guess
  // about a family: Cursor expresses effort by serving a different model id, and
  // TypeSafe serves typed decisions rather than chat. No family override may
  // invent a request dial for those — it would send a parameter the endpoint
  // ignores, and advertise a selector that cannot move.
  if (base.dialect === 'none' || base.dialect === 'model-id') return base;

  let policy = base;
  for (const override of FAMILY_OVERRIDES) {
    if (!override.reasoning) continue;
    if (!modelMatches(override.match, model)) continue;
    policy = { ...policy, ...override.reasoning, note: `${base.note}; family override: ${override.note}` };
    break;
  }

  // A provider- or family-declared default that the dialect cannot express is
  // not a default; fall back to the canonical one rather than clamping to "off".
  const levels = THINKING_LEVEL_ORDER.filter((level) => policy.levels.includes(level));
  const defaultLevel = levels.includes(policy.defaultLevel) && policy.defaultLevel !== 'none'
    ? policy.defaultLevel
    : DEFAULT_THINKING_LEVEL;
  return { ...policy, levels, defaultLevel };
}

export function resolveCachingPolicy(providerName: string, modelName?: string): CachingPolicy {
  const base = providerPolicyFor(providerName).caching;
  const model = String(modelName || '').trim();
  if (!model) return base;

  for (const override of FAMILY_OVERRIDES) {
    if (!override.caching) continue;
    if (!modelMatches(override.match, model)) continue;
    return { ...base, ...override.caching, note: `${base.note}; family override: ${override.note}` };
  }
  return base;
}

/** The advertised dial, or an empty list when the pairing has no request dial. */
export function reasoningLevelsFor(providerName: string, modelName?: string): ThinkingLevel[] {
  const policy = resolveReasoningPolicy(providerName, modelName);
  if (policy.dialect === 'none' || policy.dialect === 'model-id') return [];
  return [...policy.levels];
}

// ── Level normalisation ─────────────────────────────────────────────────────

const LEVEL_ALIASES: Record<string, ThinkingLevel> = {
  off: 'none',
  disabled: 'none',
  false: 'none',
  on: 'medium',
  true: 'medium',
  'x-high': 'xhigh',
  'extra-high': 'xhigh',
  max: 'xhigh',
  maximum: 'xhigh'
};

export function normalizeThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if ((THINKING_LEVEL_ORDER as readonly string[]).includes(normalized)) {
    return normalized as ThinkingLevel;
  }
  return LEVEL_ALIASES[normalized];
}

/** Anthropic expresses effort as a token budget; this is the inverse mapping. */
export function levelFromThinkingBudget(budget: number): ThinkingLevel {
  if (!Number.isFinite(budget) || budget <= 0) return 'none';
  if (budget <= 2048) return 'low';
  if (budget <= 8192) return 'medium';
  if (budget <= 24576) return 'high';
  return 'xhigh';
}

/**
 * Clamp a requested level to one this policy can express. `xhigh` is never
 * advertised (no configured upstream documents it) but is still accepted, and
 * degrades to `high` rather than being silently dropped.
 */
export function clampThinkingLevel(level: ThinkingLevel, policy: ReasoningPolicy): ThinkingLevel {
  if (level === 'none') return 'none';
  let candidate = level;
  if (candidate === 'xhigh' && !policy.acceptsXhigh) candidate = 'high';
  if (policy.levels.includes(candidate)) return candidate;

  const targetRank = THINKING_LEVEL_ORDER.indexOf(candidate);
  let best: ThinkingLevel = policy.defaultLevel;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const supported of policy.levels) {
    if (supported === 'none') continue;
    const distance = Math.abs(THINKING_LEVEL_ORDER.indexOf(supported) - targetRank);
    if (distance < bestDistance) {
      best = supported;
      bestDistance = distance;
    }
  }
  return best;
}

// ── Inbound wire → canonical level ──────────────────────────────────────────

type JsonObject = Record<string, any>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Anthropic `/v1/messages` expresses thinking as a content-block toggle with a
 * budget. Translating it into a canonical level here is what stops a Claude
 * client's `thinking` from being dropped on the floor by the chat-completions
 * pipeline, which has no such field.
 */
export function anthropicThinkingToChatFields(thinking: unknown): JsonObject {
  if (!isObject(thinking)) return {};
  if (thinking.type === 'disabled' || thinking.enabled === false) {
    return { reasoning_effort: 'none' };
  }
  if (thinking.type === 'enabled' || thinking.enabled === true) {
    const budget = Number(thinking.budget_tokens);
    if (Number.isFinite(budget) && budget > 0) {
      return { reasoning_effort: levelFromThinkingBudget(budget) };
    }
    return { reasoning_effort: 'medium' };
  }
  return {};
}

/**
 * Responses `/v1/responses` carries `reasoning: {effort, max_tokens}` (Codex
 * sends `{effort:'high'}`). Same job as above for the Codex wire.
 */
export function responsesReasoningToChatFields(reasoning: unknown): JsonObject {
  if (!isObject(reasoning)) return {};
  const level = normalizeThinkingLevel(reasoning.effort);
  if (level) return { reasoning_effort: level };
  const max = Number(reasoning.max_tokens ?? reasoning.budget_tokens);
  if (Number.isFinite(max) && max > 0) {
    return { reasoning_effort: levelFromThinkingBudget(max) };
  }
  return {};
}

// ── Canonical level → provider dialect ──────────────────────────────────────

type ThinkingIntent =
  | { kind: 'unspecified' }
  | { kind: 'off' }
  | { kind: 'on'; level?: ThinkingLevel; budget?: number };

function readIntent(body: JsonObject): ThinkingIntent {
  const extra = isObject(body.extra_body) ? body.extra_body : {};
  const thinking = isObject(body.thinking) ? body.thinking : undefined;
  const kwargs = isObject(extra.chat_template_kwargs) ? extra.chat_template_kwargs : undefined;

  // Off wins, unconditionally: an explicit opt-out must never be overridden by
  // a second field that happened to say "on".
  if (body.think === false) return { kind: 'off' };
  if (body.enable_thinking === false) return { kind: 'off' };
  if (body.reasoning_effort === 'none') return { kind: 'off' };
  if (thinking && (thinking.type === 'disabled' || thinking.enabled === false)) return { kind: 'off' };
  if (extra.enable_thinking === false) return { kind: 'off' };
  if (extra.reasoning_effort === 'none') return { kind: 'off' };
  if (kwargs && kwargs.enable_thinking === false) return { kind: 'off' };

  // Precedence among "on" signals: a stated level beats an inference from a
  // budget, which beats a bare boolean. A harness that sends both
  // `reasoning_effort:'high'` and `thinking:{budget_tokens:2048}` stated the
  // level directly and the budget only describes a shape; taking the inferred
  // `low` would silently downgrade an explicit choice.
  const effort = normalizeThinkingLevel(body.reasoning_effort)
    ?? normalizeThinkingLevel(extra.reasoning_effort);
  if (effort) return { kind: 'on', level: effort };

  const thinkLevel = normalizeThinkingLevel(body.think);
  if (thinkLevel) return { kind: 'on', level: thinkLevel };

  const rawBudget = thinking ? Number(thinking.budget_tokens) : Number.NaN;
  if (Number.isFinite(rawBudget) && rawBudget > 0) {
    return { kind: 'on', level: levelFromThinkingBudget(rawBudget), budget: rawBudget };
  }
  const rawExtraBudget = Number(extra.reasoning_budget);
  if (Number.isFinite(rawExtraBudget) && rawExtraBudget > 0) {
    return { kind: 'on', level: levelFromThinkingBudget(rawExtraBudget), budget: rawExtraBudget };
  }

  if (body.think === true) return { kind: 'on' };
  if (body.enable_thinking === true) return { kind: 'on' };
  if (extra.enable_thinking === true) return { kind: 'on' };
  if (kwargs && kwargs.enable_thinking === true) return { kind: 'on' };
  if (thinking && thinking.type === 'enabled') return { kind: 'on' };
  if (thinking && thinking.enabled === true) return { kind: 'on' };

  return { kind: 'unspecified' };
}

/** Does the body already state this dialect's field itself? */
function hasDialectField(body: JsonObject, dialect: ReasoningDialect): boolean {
  switch (dialect) {
    case 'openai-effort':
      // `none` counts: an explicit off is a stated value, not an absence.
      return normalizeThinkingLevel(body.reasoning_effort) !== undefined;
    case 'anthropic-thinking':
      return isObject(body.thinking);
    case 'enable-thinking':
      return body.enable_thinking !== undefined;
    case 'ollama-think':
      return body.think !== undefined;
    default:
      return false;
  }
}

/**
 * What level a body's own dialect field currently expresses, if any.
 */
function statedLevel(body: JsonObject, dialect: ReasoningDialect): ThinkingLevel | undefined {
  switch (dialect) {
    case 'openai-effort':
      return normalizeThinkingLevel(body.reasoning_effort);
    case 'anthropic-thinking': {
      if (!isObject(body.thinking)) return undefined;
      const thinking = body.thinking;
      if (thinking.type === 'disabled' || thinking.enabled === false) return 'none';
      const budget = Number(thinking.budget_tokens);
      return Number.isFinite(budget) && budget > 0 ? levelFromThinkingBudget(budget) : 'medium';
    }
    case 'enable-thinking':
      if (body.enable_thinking === true) return 'medium';
      if (body.enable_thinking === false) return 'none';
      return undefined;
    case 'ollama-think':
      if (body.think === true) return 'medium';
      if (body.think === false) return 'none';
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Re-express whatever thinking intent the caller sent in the dialect this
 * provider actually reads.
 *
 * This is ADDITIVE and VALUE-PRESERVING, deliberately:
 *
 *   - Nothing is invented. A caller that said nothing about thinking reaches the
 *     upstream with no reasoning parameter at all (2026-09-04 operator contract),
 *     so a provider that rejects an unsupported parameter is never surprised.
 *   - Nothing the caller got right is rewritten. If the body already states the
 *     level in this dialect and the value is one the policy expresses, it is left
 *     byte-identical, and its sibling fields (`thinking.budget_tokens`,
 *     `extra_body`, …) travel with it.
 *   - A value this upstream cannot express IS translated, because forwarding it is
 *     a 400 rather than a request: `xhigh` becomes `high`, and a level outside the
 *     advertised set is clamped to the nearest one that exists.
 *   - An explicit opt-out always wins, even when a second field claims the
 *     opposite — a confused harness must not silently get thinking when it asked
 *     for none.
 *
 * The one removal is Ollama's bare `think`, which is not a valid
 * chat-completions parameter on any other dialect and is re-stated in the target
 * dialect's own field.
 */
export function applyReasoningPolicy<T extends JsonObject>(body: T, policy: ReasoningPolicy): T {
  const intent = readIntent(body);
  const next: JsonObject = { ...body };

  // `think` is Ollama-native only. Forwarded to a chat-completions upstream it is
  // either ignored or rejected, and its meaning is re-stated below.
  if (policy.dialect !== 'ollama-think') delete next.think;

  if (intent.kind === 'unspecified') return next as T;

  const requested = intent.kind === 'off' ? 'none' : (intent.level ?? policy.defaultLevel);
  const level = clampThinkingLevel(requested, policy);

  // Nothing to do when the caller already said exactly this, in this dialect.
  // (An opt-out is checked against the stated value too, so a body that says
  // "off" one way and "on" another is reconciled rather than left contradictory.)
  if (hasDialectField(next, policy.dialect) && statedLevel(next, policy.dialect) === level) {
    return next as T;
  }

  switch (policy.dialect) {
    case 'openai-effort':
      // `none` is the documented off switch on the surfaces we reach (measured
      // 2026-11-07: 0 reasoning tokens), so it is sent explicitly.
      next.reasoning_effort = level;
      break;

    case 'anthropic-thinking':
      next.thinking = level === 'none'
        ? { type: 'disabled' }
        : {
            type: 'enabled',
            budget_tokens: intent.kind === 'on' && intent.budget
              ? intent.budget
              : (policy.budgetPerLevel?.[level] ?? ANTHROPIC_BUDGETS[level] ?? 4096)
          };
      break;

    case 'enable-thinking':
      next.enable_thinking = level !== 'none';
      if (level !== 'none' && policy.onFields) Object.assign(next, policy.onFields);
      break;

    case 'ollama-think':
      next.think = level !== 'none';
      break;

    // `model-id` and `none` have no request field by definition: the level is
    // expressed by choosing a different model id, or not at all. Emitting an
    // ignored parameter would claim a control that does not exist.
    case 'model-id':
    case 'none':
    default:
      break;
  }

  return next as T;
}

// ── Cache policy helpers ────────────────────────────────────────────────────

/** True when the caller already marked this body at least once. */
export function countCacheMarkers(body: JsonObject): number {
  let count = 0;
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!isObject(message) || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (isObject(part) && part.cache_control) count += 1;
      }
    }
  }
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (isObject(tool) && tool.cache_control) count += 1;
    }
  }
  return count;
}
