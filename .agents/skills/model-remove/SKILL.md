---
name: model-remove
description: "Removes a deprecated model from the local-router toggle store (untoggle + registry extras), specs, routing, gateway, pricing, ollama-cloud, and from any persisted user routers. Invoke when a model is shut down, replaced, or a free-for-limited-time promo ends."
---

# Model Remove

Removes a model from **every** place the local-router references it, and from any persisted user routers on disk. A clean removal leaves zero stale references — otherwise the build fails on `validate-model-specs.mts` or, worse, a runtime request to a dead model ID.

> **Companion skills:** [model-add](../model-add/SKILL.md) — forward mapping for onboarding. [provider-models-list](../provider-models-list/SKILL.md) — verify the upstream really is gone before removing locally.

---

## 1. Pre-Removal Checklist

Before deleting anything, confirm:

| Question | Why |
|---|---|
| Is the upstream model actually gone? | Run `provider-models-list` — a 200 with an empty `data` array ≠ "removed" |
| Is the model **completely** dead on **every** provider that hosts it? | The same `step-3.7-flash` may exist on ZenMux, Kilo, Cline, and OpenCode Zen — each is an independent removal |
| Is the user router/fallback chain relying on the presented ID? | Removal orphans persisted routers; you must migrate them first |
| Is there a replacement model? | If so, add the replacement first via `model-add`, then migrate persisted routers atomically |

If the model is **only** removed from one provider (not the upstream as a whole), scope the removal to that provider's row only. Don't delete the canonical `model-specs.json` entry — other providers may still host it.

---

## 2. Files Touched (Reverse of `model-add`)

```text
src/provider-model-registries.ts           # delete registry extra (zai/cline only)
toggle store curated keys                  # untoggle provider::model via PUT /api/model-curation
src/model-specs.json                       # delete only if NO provider hosts it anymore
src/routing-defaults.ts                    # CANDIDATE_DEFAULTS + DEFAULT_FALLBACK_ORDERED_IDS
src/routing-exhaustion-order.ts            # FALLBACK_PAID_TAIL_IDS + free chains
src/gateway-provider-catalog.ts            # CLINE_/KILO_ arrays + GATEWAY_UPSTREAM_FRIENDLY_LABELS
src/ollama-cloud-catalog.ts                # OLLAMA_CLOUD_TAG_TIERS + routing tags (Ollama only)
src/provider-pricing.ts                    # BASELINE_PROVIDER_PRICING entry
```

User state on disk (NOT in git, but a removal must clean these too):

```text
~/.config/local-router/router-models.json       # custom router definitions
~/.config/local-router/fallback-models.json     # custom fallback chains
~/.config/local-router/provider-models.json     # per-model overrides
~/.config/local-router/endpoint-models-cache.json  # refresh next launch
```

---

## 3. Workflow

### 3.1 Run the Worktree Gate

Per `AGENTS.md`: branch from `main`, one removal = one worktree. Deprecations are not hot-patched.

```bash
git worktree add -b chore/<scope>-remove-<model> ../remove-<model> main
cd ../remove-<model>
```

### 3.2 Verify the Upstream Is Actually Gone

Use `provider-models-list` to probe each affected provider's `/v1/models` endpoint and grep for the upstream ID:

```bash
node .agents/skills/provider-models-list/scripts/probe.mjs <provider> | grep -i "<upstream-model-id>"
```

Empty output means the upstream is gone. If you see matches on a *different* provider, scope the removal to the dead provider only.

### 3.3 Inventory the Local References

```bash
rg -l "step-3.7-flash-free" --glob '!node_modules' --glob '!.git'
rg -l "step-3.7-flash-free" ~/.config/local-router/
```

The first sweep finds source references; the second finds user-state references. Both must be addressed.

### 3.4 Remove from the Toggle Store

providers.txt is fully removed (Release 2026-08-20h); the toggle store is
seeded from the factual registry in `src/provider-model-registries.ts`.

1. **Untoggle**: `GET /api/model-curation` → remove `provider::upstream-id`
   from `selectedKeys` → `PUT /api/model-curation` with the remaining keys
   (the PUT replaces the whole selection).
2. **Drop the cache entry**: the next `POST /api/provider-models/<provider>/refresh`
   replaces that provider's section with current upstream truth, retiring the
   dead id from the store.
3. **Registry-only providers (zai, cline)**: also delete the entry from
   `PROVIDER_MODEL_REGISTRY_EXTRAS` in `src/provider-model-registries.ts`.

### 3.5 Remove from `src/model-specs.json`

Only delete the bare model name entry if **no other provider hosts it**. If `step-3.7-flash` still lives on Kilo + OpenCode Zen + OpenRouter, leave the specs row and just drop the ZenMux-specific references.

### 3.6 Remove from `src/routing-defaults.ts`

Two places:
- Delete the `CANDIDATE_DEFAULTS` key line entirely.
- Remove the presented ID from `DEFAULT_FALLBACK_ORDERED_IDS`. If removing the last free model in a band, the band may collapse; do not leave dangling fallbacks.

### 3.7 Remove from `src/routing-exhaustion-order.ts`

- Drop from `FALLBACK_PAID_TAIL_IDS` if present.
- Drop from `DEFAULT_CLINE_FREE_ROUTING_IDS` / `DEFAULT_KILO_FREE_ROUTING_IDS` if present.
- Drop from `GATEWAY_UPSTREAM_FRIENDLY_LABELS` (the `/config` UI display map).

### 3.8 Remove from `src/ollama-cloud-catalog.ts` (Ollama Only)

Skip unless the model was an Ollama Cloud tag. Delete from `OLLAMA_CLOUD_TAG_TIERS` and the appropriate `DEFAULT_OLLAMA_CLOUD_*_ROUTING_TAGS` array. `filterOllamaCloudPullTags()` will then block the tag on next pull.

### 3.9 Remove from `src/provider-pricing.ts`

Delete the entry from `BASELINE_PROVIDER_PRICING`. The router's cost scoring falls back to 0 if missing — be sure the upstream is **truly** dead, not just running a free-for-limited-time window, before doing this.

### 3.10 Clean Persisted Routers

```bash
node -e '
const fs = require("fs");
const os = require("os");
const path = require("path");
const cfg = path.join(os.homedir(), ".config", "local-router");
const files = ["router-models.json", "fallback-models.json", "provider-models.json"];
for (const f of files) {
  const p = path.join(cfg, f);
  if (!fs.existsSync(p)) continue;
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  // recurse: remove any string === "<presented-id>" or array entry === "<presented-id>"
  // (caller-specific: this is a hand-edit pattern; commit the migration patch)
  console.log(f, "— review and hand-edit before commit");
}'
```

Hand-edit the persisted files to either:
- **Migrate**: replace the presented ID with a successor model
- **Disable**: comment out / mark the candidate as `disabled: true`
- **Delete**: remove the entire router definition if it has no other candidates

A persisted router that points to a dead presented ID will 502 on next call. The error is loud enough to detect in `verify` output.

### 3.11 Invalidate the Endpoint Cache

```bash
rm -f ~/.config/local-router/endpoint-models-cache.json
```

The cache is rewritten on next `/api/tags` call. Stale cache rows can show ghost models in the `/config` UI for up to 1 hour otherwise.

### 3.12 Run the Validators

```bash
npx tsx scripts/validate-model-specs.mts
node scripts/validate-cline-kilo-catalog.mjs
npm test -- --test-name-pattern="routing|fallback|execution-plan"
```

All three must pass. A red gate means a stale `CANDIDATE_DEFAULTS` key, a dangling presented ID in `DEFAULT_FALLBACK_ORDERED_IDS`, or a specs row that no catalog row references.

### 3.13 Smoke Test the Negative Path

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:11436/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"<removed-presented-id>","messages":[{"role":"user","content":"ping"}]}'
```

Expect `404` (model not in catalog) or `400` (validation error). Anything else means stale state leaked through.

### 3.14 Update `llms.txt`

Decrement the affected provider's model count in the **Provider Catalog Contracts** table. Update the **System Snapshot & Release Lineage** section with a one-line summary: `Removed <provider>/<model> — deprecated by upstream <YYYY-MM-DD>`.

---

## 4. Free-Promo-Ended Removals

When a `validUntil` date in `src/provider-pricing.ts` elapses:

1. The router does **not** auto-disable the model. Operators must re-check upstream `/v1/models` to confirm the model has actually moved to paid.
2. If the model moved to paid: **do not remove**. Re-add the presented ID with `-paid` tier suffix and update `BASELINE_PROVIDER_PRICING` with the new list price.
3. If the model disappeared entirely: follow § 3 above.
4. `cip-daily-research.mts` (in `scripts/`) emits a daily research report flagging expired `validUntil` dates — check `data/cip-report-*.json` for the alert before deciding.

The `-free` → `-paid` rename is **not** a removal; it's a presentation-ID change and requires a legacy alias in `resolveGatewayPresentedLegacyId()` for any persisted routers that captured the old `-free` ID.

---

## 5. Multi-Provider Same-Model Removals

When the **same** upstream model is hosted on multiple providers (e.g. `step-3.7-flash` on ZenMux, Kilo, Cline, and OpenCode Zen), removal is per-provider:

| Step | All-providers gone | Only one provider gone |
|---|---|---|
| toggle store | untoggle every provider's key | untoggle only the dead provider's key |
| `model-specs.json` | delete the bare-name entry | leave the entry (other providers still need it) |
| `routing-defaults.ts` | delete the `CANDIDATE_DEFAULTS` line | add a per-provider `CANDIDATE_DEFAULTS` line per surviving provider if not already present |
| `routing-exhaustion-order.ts` | remove from gateway lists | remove only from the dead provider's list |
| `provider-pricing.ts` | delete the entry | delete only the dead provider's entry |
| Persisted routers | migrate to successor | swap to a surviving provider's presented ID |

---

## 6. Common Pitfalls

- **Untoggling without removing the specs row (or vice versa)** — the spec validator fails the build with "orphan specs row". Either both go, or neither.
- **Forgetting `BASELINE_PROVIDER_PRICING`** — the router keeps scoring the missing model at $0/M, making it the cheapest candidate and biasing auto-router selection.
- **Editing persisted routers on disk before the new presented ID is published** — a router that points to a not-yet-released ID will 502 from the moment the proxy restarts. Publish the new model first, then migrate routers in a follow-up commit.
- **Hand-editing the toggle store cache on disk** — the registry seed (v2) unions registry rows at boot; a manually inserted row can be re-deduped away on the next refresh.
- **Removing the wrong tier from a gateway list** — Cline and Kilo both have `*-free` and `*-paid` lists. Removing from the wrong one flips a paid model into the free chain (and vice versa). Always cross-check the `upstreamId` against `CLINE_FREE_SET` / `KILO_FREE_SET` membership before deleting.
- **Forgetting the endpoint cache** — the cache persists across restarts. Stale rows show ghost models in `/config` until the next per-provider refresh replaces the section.

---

## 7. Worked Example: Removing `zenmux/stepfun/step-3.7-flash:free`

Scenario: ZenMux announced the free tier ended 2026-07-15, model is now paid-only upstream at $0.10/$0.30 per 1M. We want to remove the free variant but keep a future paid variant.

1. Probe via `provider-models-list` — `zenmux` upstream no longer advertises `:free`. Decision: remove the free presented ID.
2. Toggle store — untoggle `zenmux::stepfun/step-3.7-flash:free`; the next refresh retires it from the cache section.
3. `src/model-specs.json` — leave `step-3.7-flash` (Kilo, OpenCode Zen, OpenRouter, Cline all still host it).
4. `src/routing-defaults.ts` — delete `CANDIDATE_DEFAULTS['zenmux-step-3.7-flash-free']` and the `DEFAULT_FALLBACK_ORDERED_IDS` entry.
5. `src/routing-exhaustion-order.ts` — not Cline/Kilo, skip.
6. `src/provider-pricing.ts` — delete the entry (free, $0/$0). The future paid variant will get a new `validUntil`-less entry with real pricing.
7. `~/.config/local-router/router-models.json` — hand-edit any persisted router using `zenmux-step-3.7-flash-free` to swap to `kilo-stepfun-step-3.7-flash-free` (still free) or `zenmux-step-3.7-flash` (when re-added as paid).
8. `rm -f ~/.config/local-router/endpoint-models-cache.json`.
9. Run the three validators + smoke test a 404 on the removed ID + 200 on the migrated ID.
10. Update `llms.txt` — decrement ZenMux count by 1, add a release lineage row.
