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
  /**
   * Set when the provider's wire normalises EVERY hosted model family onto one
   * request field, so a family override must not swap the dialect back.
   *
   * Measured on Nebius 2026-11-20: `enable_thinking:false` returned a
   * byte-identical completion to the baseline on GLM-5.3-Flash (1225 reasoning
   * tokens both times), i.e. the field is inert on that wire, while
   * `reasoning_effort` moved the same model from 168 to 1653 reasoning tokens
   * between `low` and `medium`. Kimi-K3.1-Pro and MiniMax-M3.1-Flash behave the
   * same way (`reasoning_effort:none` -> 0 reasoning tokens, 3/3 runs). The
   * provider is the fact here, not the model family: it terminates family
   * overrides for the request field while leaving the provider's own `levels`.
   */
  providerDeclaresDialect?: boolean;
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
  /** True when the upstream rejects unknown `cache_control` markers. */
  stripsCacheControl: boolean;
  /** Ask for the trailing usage chunk so `cached_tokens` is observable. */
  includeStreamUsage: boolean;
  /** Fields this provider treats as a cache-warmth lever, not a reasoning one. */
  extraBodyFields?: Record<string, unknown>;
  /**
   * The optional request fields this surface accepts at all.
   *
   * `strict` means the upstream validates its JSON schema and rejects unknown
   * names outright — Google's OpenAI-compat wire does exactly that, answering
   * `Invalid JSON payload received. Unknown name "prompt_cache_key"` /
   * `Unknown name "store"`. On such a surface the router may only send fields
   * named here plus the standard chat-completions core; everything else is
   * dropped rather than forwarded and hoped for. Measured live 2026-11-20:
   * ~40 Antigravity failures were router-injected or client-passthrough fields
   * the surface never accepted.
   *
   * `lenient` (the default) forwards the caller's body as-is.
   */
  requestFields?: {
    /** `strict` = reject unknown fields; `lenient` = ignore them. */
    validation: 'strict' | 'lenient';
    /** Optional fields known to be accepted. Ignored when lenient. */
    accepted?: readonly string[];
  };
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
/**
 * The full ladder including `xhigh`. Only providers that were MEASURED to
 * accept the six-value enum get this: advertising a level the upstream 422s on
 * is the "control that cannot move" bug this table exists to prevent.
 */
const EFFORT_SIX: ThinkingLevel[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
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
    caching: implicitCache('docs/caching/wafer-serverless.txt — automatic radix prefix cache; cache_read price exposed in /v1/models; sticky prompt_cache_key anchors the cache where honoured and is ignored where not [INFERENCE: acceptance unstated]', {
      stickyKey: 'prompt_cache_key'
    })
  },

  zenmux: {
    // Not a single family: the gateway routes to Anthropic, OpenAI, DeepSeek,
    // Qwen, Moonshot and GLM, and translates `reasoning_effort` per upstream.
    reasoning: effortPolicy(EFFORT_FIVE, 'docs/caching/zenmux.txt; measured 2026-11-07: reasoning_effort moves billed reasoning_tokens, thinking:{type:disabled} -> 0'),
    caching: anthropicCache('docs/caching/zenmux.txt — 4 breakpoints, 1h extended TTL, implicit caching for OpenAI/DeepSeek/Kimi/GLM routes', {
      stickyKey: 'prompt_cache_key'
    })
  },

  nebius: {
    // Measured 2026-11-20 on api.tokenfactory.nebius.com and the us-north1
    // region alike: `enable_thinking` is IGNORED and `reasoning_effort` is the
    // only field that moves thinking. On GLM-5.3-Flash, `enable_thinking:false`
    // returned a completion byte-identical to the no-parameter baseline
    // (1225 reasoning tokens, 3299-char reasoning_content both times); on the
    // same model `reasoning_effort` moved 168 / 1653 / 296 reasoning tokens for
    // low / medium / high. Kimi-K3.1-Pro and MiniMax-M3.1-Flash both billed 0
    // reasoning tokens at `none` (3/3 runs). The full six-value enum including
    // `xhigh` is accepted (200, not 422).
    //
    // This is a provider-level fact, not a per-family one, which is why the row
    // sets providerDeclaresDialect: the `glm`/`kimi`/`minimax` family overrides
    // would otherwise put GLM and Kimi back on `enable_thinking`, the field this
    // wire does not read.
    reasoning: effortPolicy(EFFORT_SIX, 'measured 2026-11-20 on Token Factory: enable_thinking inert (byte-identical output with false), reasoning_effort moves billed reasoning_tokens across none/minimal/low/medium/high/xhigh', {
      acceptsXhigh: true,
      providerDeclaresDialect: true
    }),
    caching: implicitCache('docs/caching/nebius.txt — automatic context cache; Responses API takes prompt_cache_key, chat completions takes nothing', {
      stickyKey: 'prompt_cache_key'
    })
  },

  'nebius-us-north1': {
    // Same wire, same credential, different gateway: the region-pinned host
    // serves a subset of the global catalog (8 of 24, measured 2026-11-20).
    // Reasoning and caching therefore match `nebius` exactly, including the
    // provider-level dialect finding.
    reasoning: effortPolicy(EFFORT_SIX, 'measured 2026-11-20 on api.tokenfactory.us-north1.nebius.com: enable_thinking inert, reasoning_effort moves billed reasoning_tokens across none/minimal/low/medium/high/xhigh', {
      acceptsXhigh: true,
      providerDeclaresDialect: true
    }),
    caching: implicitCache('docs/caching/nebius-us-north1.txt — same Token Factory engine as the global host; automatic context cache, nothing to mark client-side', {
      stickyKey: 'prompt_cache_key'
    })
  },

  moonshot: {
    reasoning: booleanThinking('llms.txt line 722 — DeepSeek/Qwen/GLM/Kimi/Step/MiniMax use enable_thinking'),
    caching: implicitCache('docs/caching/moonshot.txt — automatic context cache, 256-token floor, prompt_cache_key steers hits', {
      stickyKey: 'prompt_cache_key'
    })
  },

  'nvidia-nim': {
    reasoning: booleanThinking('llms.txt §Thinking (Nemotron/Qwen/DeepSeek family); NIM serves via TRT-LLM [INFERENCE]'),
    caching: implicitCache('docs/caching/nvidia-nim.txt — hosted NIM is a vLLM-backed OpenAI API (API reference 2026-11): automatic prefix cache runs server-side, nothing client-side to mark [INFERENCE: hosted docs never state APC explicitly]')
  },

  modal: {
    reasoning: booleanThinking('llms.txt §Thinking; Modal inference gateway serves vLLM-backed shared endpoints [INFERENCE: host corrected 2026-11-20 — api.us-west-2.modal.direct answers 404 route not found]'),
    caching: implicitCache('docs/caching/modal.txt — vLLM automatic prefix cache, capacity-bound, no client knobs', {
      stickyKey: 'prompt_cache_key'
    })
  },

  'modal-proxy': {
    // The deployment now serves deepseek-ai/DeepSeek-V4.1-Flash-1017, which the
    // `deepseek` family override below already maps to reasoning_effort. The
    // provider row keeps the conservative boolean row as the fallback for any
    // other family the operator deploys here later; the family override wins for
    // DeepSeek, which is the only model this endpoint serves today.
    reasoning: booleanThinking('llms.txt §Thinking; own DeepSeek-V4.1-Flash-1017 vLLM deployment — the deepseek family override supplies reasoning_effort for the served model [INFERENCE]'),
    caching: implicitCache('docs/caching/modal-proxy.txt — vLLM APC on a private deployment; Modal-Session-ID keeps requests on one replica', {
      stickyKey: 'prompt_cache_key'
    })
  },

  openrouter: {
    reasoning: effortPolicy(EFFORT_FIVE, 'docs/caching/openrouter.txt; OpenRouter normalises reasoning_effort per upstream'),
    caching: anthropicCache('docs/caching/openrouter.txt — cache_control passed to Anthropic/Qwen/Gemini, implicit elsewhere; sticky routing keyed by session_id', {
      stickyKey: 'session_id'
    })
  },

  typesafe: {
    // Decisions only. /v1/systemone is not a chat surface.
    reasoning: noThinking('src/decisions/catalog.ts — typed decision models, no chat surface'),
    caching: noCache('docs/caching/typesafe.txt — typed decision transport, no prompt to warm')
  },

  'xiaomi-mimo': {
    reasoning: effortPolicy(EFFORT_FOUR, 'docs/caching/xiaomi-mimo.txt; MiMo publishes cache hit/miss split but no thinking doc [INFERENCE]'),
    caching: implicitCache('docs/caching/xiaomi-mimo.txt — automatic prefix cache with ~1-2% cache-hit input price; sticky prompt_cache_key anchors the cache where honoured and is ignored where not [INFERENCE: acceptance unstated]', {
      stickyKey: 'prompt_cache_key'
    })
  },

  'opencode-go': {
    reasoning: effortPolicy(EFFORT_FIVE, 'docs/caching/opencode-go.txt — Console chat family: GLM/Kimi/DeepSeek/MiniMax (automatic prefix caching)'),
    caching: implicitCache('docs/caching/opencode-go.txt — Console chat wire: automatic upstream prefix caching, cached reads billed via usage.opencode.tokens.cache_read; keep the prefix byte-identical. The old /messages-family markers do not apply to the chat surface we serve [INFERENCE: prompt_cache_key acceptance unstated]', {
      stickyKey: 'prompt_cache_key'
    })
  },

  'opencode-zen': {
    reasoning: effortPolicy(EFFORT_FIVE, 'docs/caching/opencode-zen.txt — same Console chat family as Go'),
    caching: implicitCache('docs/caching/opencode-zen.txt — Console chat wire: automatic upstream prefix caching, cached reads billed via usage.opencode.tokens.cache_read; keep the prefix byte-identical. The old /messages-family markers do not apply to the chat surface we serve [INFERENCE: prompt_cache_key acceptance unstated]', {
      stickyKey: 'prompt_cache_key'
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
    caching: anthropicCache('docs/caching/cline.txt — pass-through of upstream Anthropic cache_control, cached_tokens in usage')
  },

  kilo: {
    reasoning: effortPolicy(EFFORT_FIVE, 'docs/caching/kilo.txt — gateway over 500+ models'),
    caching: anthropicCache('docs/caching/kilo.txt — Anthropic markers reach the upstream Claude route; other families auto-cache')
  },

  commandcode: {
    reasoning: effortPolicy(EFFORT_FIVE, 'docs/caching/commandcode.txt — passthrough gateway, OpenAI schema on /chat/completions'),
    caching: anthropicCache('docs/caching/commandcode.txt — Claude routes accept Anthropic markers [INFERENCE: not documented as a caching feature]')
  },

  antigravity: {
    reasoning: effortPolicy(EFFORT_FOUR, 'docs/caching/antigravity.txt — Gemini via the AI Studio OpenAI-compat surface; thinking_config is not reachable here [INFERENCE]'),
    caching: implicitCache('docs/caching/antigravity.txt — Gemini implicit caching, nothing client-configurable; the surface validates its JSON schema and rejects unknown names, so no sticky key is sent [MEASURED 2026-11-20: Unknown name "prompt_cache_key" / "store" are 400s]', {
      // strict: the AI Studio OpenAI-compat wire answers 400 for any field its
      // schema does not declare. Sending a "harmless" sticky key there is the
      // opposite of harmless — it fails the whole request.
      requestFields: { validation: 'strict' },
      stickyKey: 'none',
      includeStreamUsage: false
    })
  },

  'github-copilot': {
    reasoning: effortPolicy(EFFORT_FIVE, 'docs/caching/github-copilot.txt — Copilot serves GPT-5.x, Claude and Gemini behind one OpenAI-compatible endpoint'),
    caching: implicitCache('docs/caching/github-copilot.txt — GitHub caches Claude/Gemini prefixes server-side; sticky prompt_cache_key anchors the cache where honoured and is ignored where not [INFERENCE: acceptance unstated]', {
      stickyKey: 'prompt_cache_key',
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
    caching: implicitCache('docs/caching/cursor.txt — server-side prefix reuse; markers not documented as accepted; sticky prompt_cache_key anchors the cache where honoured and is ignored where not [INFERENCE: acceptance unstated]', {
      stickyKey: 'prompt_cache_key',
      includeStreamUsage: false
    })
  },

  fastino: {
    reasoning: effortPolicy(EFFORT_FIVE, 'docs/caching/fastino.txt — Nemotron family on api.fastino.ai; reasoning dial unverified on the new host 2026-11-12'),
    caching: anthropicCache('docs/caching/fastino.txt — 4 markers, 1h TTL, content-block arrays; measured on the predecessor wire (api.pioneer.ai, 2026-08-23) and enabled at maximum per operator directive 2026-11-12 — live re-measurement on api.fastino.ai blocked on a valid key (pio_sk_ keys retired)')
  },

  'nous-portal': {
    reasoning: effortPolicy(EFFORT_FIVE, 'docs/caching/nous-portal.txt — passthrough aggregator over Anthropic/OpenAI/DeepSeek/Kimi'),
    caching: anthropicCache('docs/caching/nous-portal.txt — passthrough; markers honoured only where the route accepts content-block arrays [INFERENCE]')
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
    // Gemini 2.5 and newer reason implicitly; the AI Studio OpenAI-compatible
    // surface accepts reasoning_effort for them [INFERENCE: Google documents
    // thinking_config on the native API, not this shim].
    match: /gemini-(2\.[5-9]|[3-9])/i,
    reasoning: { dialect: 'openai-effort', levels: EFFORT_FOUR },
    note: 'Gemini 2.5+ implicit reasoning [INFERENCE]'
  },
  {
    // MiMo V2.x is Xiaomi's reasoning-capable family. docs/caching/xiaomi-mimo.txt
    // documents the cache side only, so the dialect is [INFERENCE] from the
    // OpenAI-compatible surface it is served on.
    match: /(^|\/)mimo/i,
    reasoning: { dialect: 'openai-effort', levels: EFFORT_FOUR },
    note: 'docs/caching/xiaomi-mimo.txt (MiMo served via an OpenAI-compatible API) [INFERENCE]'
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
  // A provider that declares its own wire dialect is the authority for the
  // REQUEST FIELD. Family overrides still describe the model, but they must not
  // put the request back on a field this provider measurably ignores — that is
  // exactly how `enable_thinking` kept being sent to a wire that needs
  // `reasoning_effort`.
  if (!base.providerDeclaresDialect) {
    for (const override of FAMILY_OVERRIDES) {
      if (!override.reasoning) continue;
      if (!modelMatches(override.match, model)) continue;
      policy = { ...policy, ...override.reasoning, note: `${base.note}; family override: ${override.note}` };
      break;
    }
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

/**
 * The chat-completions fields every OpenAI-compatible surface accepts.
 *
 * A strict surface validates its schema and 400s on anything else, so this is
 * the floor: it is the wire contract itself, not a per-provider opinion, and it
 * must not grow a field merely because one provider tolerates it.
 */
const CHAT_CORE_FIELDS: readonly string[] = [
  'model', 'messages', 'stream', 'stream_options',
  'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'top_k',
  'stop', 'n', 'seed', 'presence_penalty', 'frequency_penalty', 'logprobs',
  'top_logprobs', 'logit_bias', 'user', 'response_format', 'tools',
  'tool_choice', 'parallel_tool_calls', 'reasoning_effort', 'modalities',
  'audio', 'prediction', 'service_tier', 'metadata'
];

/**
 * Drop request fields a strict surface would reject.
 *
 * The defect this closes (measured live 2026-11-20): the router forwarded the
 * caller's own body verbatim, and Google's AI Studio OpenAI-compat wire answers
 * `Invalid JSON payload received. Unknown name "store"` / `Unknown name
 * "prompt_cache_key"` with HTTP 400. ~40 stage failures were the router sending
 * a field the target never declared. A lenient surface keeps today's behaviour
 * exactly; only a provider whose row states `validation: 'strict'` is filtered.
 *
 * Returns the dropped names so a caller can record that the request was
 * reshaped rather than passed through — a silent drop would be the same class of
 * bug as the one being fixed.
 */
export function dropUnsupportedRequestFields<T extends JsonObject>(
  body: T,
  providerName: string,
  modelName?: string
): { body: T; dropped: string[] } {
  const policy = resolveCachingPolicy(providerName, modelName);
  const contract = policy.requestFields;
  if (!contract || contract.validation !== 'strict') return { body, dropped: [] };

  const accepted = new Set<string>([...CHAT_CORE_FIELDS, ...(contract.accepted || [])]);

  const next: JsonObject = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (accepted.has(key)) next[key] = value;
    else dropped.push(key);
  }
  return { body: next as T, dropped };
}

/** The advertised dial, or an empty list when the pairing has no request dial. */
export function reasoningLevelsFor(providerName: string, modelName?: string): ThinkingLevel[] {
  const policy = resolveReasoningPolicy(providerName, modelName);
  if (policy.dialect === 'none' || policy.dialect === 'model-id') return [];
  return [...policy.levels];
}

/**
 * Does the model id name a family we hold a positive reasoning fact about?
 *
 * This is deliberately narrower than `reasoningLevelsFor`. A gateway row
 * (`kilo`, `nous-portal`, `pioneer`) covers hundreds of unrelated models, so its
 * provider-level default says "this endpoint accepts an effort parameter", not
 * "every model here reasons". `meta-llama/llama-3.3-70b` on Kilo must not
 * advertise a thinking dial just because Kilo also serves GLM.
 *
 * True only when a family override — the place facts about a MODEL are recorded —
 * matches. Used to decide whether the policy may overrule a stale published
 * capability flag, so it can fill a gap but never invent one.
 */
export function modelMatchesReasoningFamily(providerName: string, modelName?: string): boolean {
  const base = providerPolicyFor(providerName).reasoning;
  if (base.dialect === 'none' || base.dialect === 'model-id') return false;
  const model = String(modelName || '').trim();
  if (!model) return false;
  return FAMILY_OVERRIDES.some((override) => override.reasoning && modelMatches(override.match, model));
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

/**
 * The thinking level a caller expressed, in canonical form, or undefined when
 * they said nothing.
 *
 * Exported so a trajectory stage can record WHAT was asked for at the moment a
 * model without a request dial served the turn — a downgrade note that says
 * "the level was not honoured" without naming the level is only half the fact.
 */
export function requestedThinkingLevel(body: JsonObject): ThinkingLevel | undefined {
  const intent = readIntent(body);
  if (intent.kind === 'unspecified') return undefined;
  if (intent.kind === 'off') return 'none';
  return intent.level ?? DEFAULT_THINKING_LEVEL;
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
