---
name: model-add
description: "Adds a new model to the local-router toggle store (live discovery, curated registry, or /config toggle), plus model-specs.json, routing defaults, gateway tier lists, pricing, ollama-cloud tier map, fallback chain. Invoke when a new model appears on a provider or when a user asks to onboard a model to the router."
---

# Model Add

Adds a single model to **every** place the local-router references it. A new model is never one-line — it touches 6+ files and three validation scripts. This skill is the canonical workflow.

> **Companion skills:** [model-remove](../model-remove/SKILL.md) — reverse mapping for deprecation. [provider-models-list](../provider-models-list/SKILL.md) — discover what each provider's `/v1/models` advertises before onboarding.

---

## 1. Inputs You Need Before You Start

Collect from the operator (or the live `/v1/models` probe — see `provider-models-list`):

| Field | Example | Source |
|---|---|---|
| `provider` slug | `zenmux` | `allProviderSummaries()` in `src/index.ts` |
| `upstreamModelId` | `stepfun/step-3.7-flash:free` | provider `/v1/models` response |
| `presentedId` | `zenmux-step-3.7-flash-free` | `gatewayPresentedModelSegment()` rules |
| Billing tier | `free` / `api-paid` / `subscription-only` | upstream docs |
| Context window | `256000` | provider docs |
| Output tokens | `256000` | provider docs |
| Tools / vision / cache | `true / true / true` | provider docs |
| Source URL | `https://zenmux.ai/models` | for `validUntil` + `sourceUrl` |
| `validUntil` (promos) | `2026-07-15` | if free-for-limited-time |

If onboarding **multiple** providers for the same model, repeat per provider.

---

## 2. Files Touched (Canonical Checklist)

```text
src/provider-model-registries.ts           # PROVIDER_MODEL_REGISTRY_EXTRAS (registry-only providers: zai, cline)
~/.config/local-router (toggle store)      # refresh discovers; toggle ON via /config or PUT /api/model-curation
src/model-specs.json                       # canonical context/output/tools metadata
src/routing-defaults.ts                    # CANDIDATE_DEFAULTS + fallback chain
src/routing-exhaustion-order.ts            # tier band + paid tail
src/gateway-provider-catalog.ts            # CLINE_/KILO_ free/paid + free chain
src/ollama-cloud-catalog.ts                # OLLAMA_CLOUD_TAG_TIERS (only if Ollama)
src/provider-pricing.ts                    # BASELINE_PROVIDER_PRICING entry
src/index.ts                               # presented alias map (if legacy alias needed)
```

Validation scripts to run **after** editing:
- `scripts/validate-model-specs.mts` — metadata drift check
- `scripts/validate-cline-kilo-catalog.mjs` — gateway tier alignment
- `npm test` — routing + fallback + execution-plan suites

---

## 3. Workflow

### 3.1 Run the Worktree Gate

Per `AGENTS.md`: branch from `main`. One model = one worktree.

```bash
git worktree add -b feat/<scope>-add-<provider>-<model> ../add-<model> main
cd ../add-<model>
```

### 3.2 Verify the Model Exists on the Upstream

Use `provider-models-list` to confirm the upstream ID and that the model is reachable (returns the static fallback row when no key is set):

```bash
node .agents/skills/provider-models-list/scripts/probe.mjs <provider> --filter <upstream>
```

If a real API key is set for the provider in the PQC bundle, this hits `${baseUrl}/models`. If not, it returns the static catalog row.

### 3.3 Register the Model in the Toggle Store

providers.txt is fully removed (Release 2026-08-20h); the persisted toggle
store (`endpoint-models-cache.json` + curated keys in `model-source-config.json`)
is the only catalog, seeded from the factual registry in
`src/provider-model-registries.ts`. Two paths:

**a. Live provider (upstream `/models` works):** nothing to register. Refresh
discovers it, and it appears untoggled in the provider card:

```bash
curl -s -X POST http://127.0.0.1:11434/api/provider-models/<provider>/refresh
```

Then toggle it ON — `/config` provider card, or add `provider::upstream-id` to
`selectedKeys` via `PUT /api/model-curation` (fetch current keys first; the PUT
replaces the whole selection).

**b. Registry-only provider (zai, cline — no upstream `/models`):** add an entry
to `PROVIDER_MODEL_REGISTRY_EXTRAS` in `src/provider-model-registries.ts`:

```ts
zai: [
  { id: 'GLM-5.3', contextLength: 200000, outputTokens: 128000, supportsTools: true, note: 'source URL' }
]
```

Capability hints here flow into the catalog when the refresh unions the
registry. Then refresh + toggle as in (a).

### 3.4 Add to `src/model-specs.json`

```json
"step-3.7-flash-free": {
  "context": 256000,
  "output": 256000,
  "tools": true,
  "vision": true,
  "reasoning": true,
  "source": "zenmux.ai/models (June 2026)"
}
```

Use the **bare** model name (no provider prefix) as the key. `validate-model-specs.mts` will fail the build if any presented alias lacks a specs row.

### 3.5 Add to `src/routing-defaults.ts`

Two places:

**a. `CANDIDATE_DEFAULTS` line** — choose `coding=0.x` based on the model tier (free models cluster around `0.80–0.86`; paid flagships `0.88–0.91`):

```ts
'zenmux-step-3.7-flash-free': 'coding=0.84, input=0, output=0, latency=800, notes=ZenMux Step 3.7 Flash free',
```

**b. Insert into `DEFAULT_FALLBACK_ORDERED_IDS`** at the correct exhaustion band. Free models go in band 0–3, subscription in band 4, paid in band 5. Order within band follows `ROUTING_FREE_PROVIDER_SUB_ORDER` / `SUBSCRIPTION_PROVIDER_SUB_ORDER` / `ROUTING_PAID_PROVIDER_SUB_ORDER`.

### 3.6 Add to `src/routing-exhaustion-order.ts`

If the model is **Cline or Kilo**, register it in:
- `CLINE_FREE_MODEL_IDS` / `CLINE_PAID_ROUTING_IDS` **or** `KILO_FREE_MODEL_IDS` / `KILO_PAID_ROUTING_IDS`
- `DEFAULT_CLINE_FREE_ROUTING_IDS` **or** `DEFAULT_KILO_FREE_ROUTING_IDS` (if it should be tried first in the free chain)
- `GATEWAY_UPSTREAM_FRIENDLY_LABELS` (for the `/config` UI display name)

Use the actual upstream ID, **not** the presented ID, in these arrays.

### 3.7 Add to `src/ollama-cloud-catalog.ts` (Ollama Only)

Skip this step unless onboarding an Ollama Cloud tag. Add to `OLLAMA_CLOUD_TAG_TIERS`:

```ts
'step-3.7-flash:cloud': 'free'
```

If the new tag is free, also append to `DEFAULT_OLLAMA_CLOUD_FREE_ROUTING_TAGS` so router/fallback can route to it. If pro-only, append to `DEFAULT_OLLAMA_CLOUD_PRO_ROUTING_TAGS`.

### 3.8 Add to `src/provider-pricing.ts`

```ts
'zenmux-step-3.7-flash-free': {
  inputPricePerM: 0,
  outputPricePerM: 0,
  label: 'ZenMux stepfun/step-3.7-flash:free',
  sourceUrl: 'https://zenmux.ai/models',
  validUntil: '2026-07-15'  // remove once free period ends
}
```

For paid models, copy list pricing from the provider's `/v1/models` `pricing.prompt` / `pricing.completion` fields (USD per 1M tokens, not per 1K).

### 3.9 Run the Validators

```bash
npx tsx scripts/validate-model-specs.mts
node scripts/validate-cline-kilo-catalog.mjs
npm test -- --test-name-pattern="routing|fallback|execution-plan"
```

All three must pass before commit. A red CI gate means a presented alias is missing a specs row, a tier mismatch, or a broken `CANDIDATE_DEFAULTS` key.

### 3.10 Smoke Test the Live Routing

Follow `AGENTS.md` § Verification Procedure. Start the proxy on `11436` (develop verification port) and exercise the new presented ID:

```bash
curl -s http://127.0.0.1:11436/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${ZENMUX_API_KEY}" \
  -d '{"model":"zenmux-step-3.7-flash-free","messages":[{"role":"user","content":"ping"}],"max_tokens":16}'
```

Expect 200 with a non-empty `choices[0].message.content`. If 401, the key isn't in the PQC bundle yet — run `secrets-load` or update via `/config`.

### 3.11 Update `llms.txt`

Add the model to the **Provider Catalog Contracts** table count and the **Key Model Metadata Specifications** block (only if the model introduces new context/output/cache metadata that the routing chain needs to know about). Increment the catalog totals at the top of the section.

---

## 4. Presentation ID Conventions

Local-router presented IDs follow strict rules — don't hand-roll them:

```text
GATEWAY_PRESENTATION_PREFIXES = { cline: 'cline', kilo: 'kilo' }
segment = upstreamId
  .replace(/^@/, '')
  .toLowerCase()
  .replace(/[^a-z0-9._+-]+/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-|-$/g, '')

tier suffix:    free  → -free   api-paid → -paid   null → (no suffix)
```

Examples:
- `zenmux/stepfun/step-3.7-flash:free` → `zenmux-step-3.7-flash-free` (presented prefix `zenmux-` comes from the provider slug, not the gateway helper)
- `kilo` + `stepfun/step-3.7-flash:free` → `kilo-stepfun-step-3.7-flash-free` (full upstream path retained to avoid `kilo-step-3.7-flash-free` collision if a paid variant also exists)
- `cline` + `nvidia/nemotron-3-ultra-550b-a55b:free` → `cline-nvidia-nemotron-3-ultra-550b-a55b-free`
- `opencode-zen` + `minimax-m3-free` → `opencode-zen-minimax-m3-free`

Use `gatewayPresentedModelId(providerName, upstreamId)` from `src/gateway-provider-catalog.ts` to derive the ID programmatically rather than guessing.

---

## 5. Free-for-Limited-Time Models

When a provider runs a promo, three things matter:

1. **`validUntil` in `provider-pricing.ts`** — the date the free period ends. The router doesn't enforce this, but `cip-daily-research.mts` flags expired promos for removal.
2. **Tier suffix on the presented ID** — the `-free` suffix is non-negotiable. If the same upstream model later has a paid tier, the presented IDs must differ (`*-free` vs `*-paid`) so persisted routers don't get silently swapped.
3. **`/config` UI filter** — the UI relies on the `:free` / `-free` suffix to label the row as free. Renaming a model mid-promo will orphan every saved router referencing it.

When the promo ends, **don't** rename the presented ID — invoke [model-remove](../model-remove/SKILL.md) on the free variant and re-add it as paid if a paid tier exists on the same upstream ID.

---

## 6. Common Pitfalls

- **Forgetting `validate-model-specs.mts`** — CI fails on missing specs row but local edits can sneak through.
- **Using the upstream ID in `CANDIDATE_DEFAULTS`** — the key must be the **presented** ID, not the upstream model path. Mismatches cause silent candidate drops at runtime.
- **Inserting into the wrong exhaustion band** — free models in the paid band break the price-anchored fallback chain.
- **Skipping `BASELINE_PROVIDER_PRICING`** — the router uses `inputPricePerM` / `outputPricePerM` for cost scoring. Missing entries score as 0 (cheapest), which skews auto-router selection.
- **Editing the legacy alias map in `src/index.ts` for new models** — legacy aliases exist only for **persisted routers** with old IDs. New models should ship with the new presented ID and no alias.

---

## 7. Worked Example: `zenmux/stepfun/step-3.7-flash:free`

Goal: add ZenMux's free Step 3.7 Flash to the catalog.

1. Toggle store — ZenMux is a live provider: refresh discovers `zenmux-step-3.7-flash-free`, toggle it ON (no registry edit needed).
2. `src/model-specs.json` — `step-3.7-flash-free` with context 256K, output 256K, tools/vision/reasoning true.
3. `src/routing-defaults.ts`:
   - `CANDIDATE_DEFAULTS['zenmux-step-3.7-flash-free'] = 'coding=0.84, input=0, output=0, latency=800, notes=ZenMux Step 3.7 Flash free'`
   - Insert in `DEFAULT_FALLBACK_ORDERED_IDS` after the Kilo free Step 3.7 Flash (or at the same band) so the free Step 3.7 Flash has multiple failover paths.
4. `src/routing-exhaustion-order.ts` — not Cline/Kilo, skip.
5. `src/provider-pricing.ts` — `'zenmux-step-3.7-flash-free'` at $0/$0 with `validUntil: '2026-07-15'`.
6. Run the three validators + smoke test on `11436`.
7. Update `llms.txt` catalog totals (19 → 20 ZenMux models).
