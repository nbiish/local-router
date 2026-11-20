---
plan_format: ainish/plan/v1
slug: nebius-region-and-modal-endpoint
date: 2026-11-20
status: done
branch: feat/providers-nebius-region-modal-endpoint
worktree: /Volumes/1tb-sandisk/code-external/local-router-providers
task_record: .agents/tasks/TASK.2026-11-20-13-nebius-region-and-modal-endpoint.md
operator: question-me
---

# Plan: Nebius us-north1 region row and the re-pointed Modal proxy endpoint

## 1. Problem

Two upstream provider facts changed and the router no longer describes either truthfully. Nebius
now serves a region-pinned Token Factory gateway at `https://api.tokenfactory.us-north1.nebius.com/v1`
that the router has no row for, so no route can pin its traffic to that region. The `modal-proxy`
provider — an own-deployment Modal endpoint with a `wk-`/`ws-` proxy token — still points at a
deployment that has been retired (`404 domain association not found`), while the operator's current
deployment is a DeepSeek-V4.1-Flash server at a different hostname. A router that reports a
configured key and a curated model set for a dead host is worse than one that reports nothing: every
fallback step that lands there burns a request. Neither provider row can be trusted until both are
re-pointed and their catalogs reconciled with what the upstreams actually serve.

## 2. Anchor Facts

Measured live on 2026-11-20 with the operator's `LOCALROUTER_*` keys, values never printed.

- `us-north1` is a **regional subset**, not a superset: 8 models vs the global host's 24 — all 8 also
  served globally — established by diffing `GET /v1/models` on both hosts.
- `us-north1` omits `nvidia/Nemotron-3_5-Lightning` (in the live curated selection at
  `router-settings.json:79`) and `nvidia/Nemotron-3-Ultra-550b-a55b` (referenced by
  `UPSTREAM_MODEL_ID_ALIASES` at `src/index.ts:399`); both answer `404 model does not exist` there and
  `200 OK` on the global host. Established by chat-completion probes on both hosts.
- `deepseek-ai/DeepSeek-V4-Pro` is **gone from both hosts**; the global host serves
  `deepseek-ai/DeepSeek-V4-Pro-0813` instead. `deepseek-ai/DeepSeek-V4-Pro` returns
  `404 does not exist` on both. Established by chat-completion probe.
- 16 of the 29 curated `nebius` rows are dead on the global host and 27 of 29 are dead on `us-north1`.
  Established by set-diffing the curated registry block against both live listings.
- Model id casing is load-bearing on Nebius: `nvidia/Nemotron-3-Ultra-550b-a55b` (lowercase `b`) is
  `200`; `nvidia/Nemotron-3-Ultra-550B-A55B` is `404`. Established by paired probes.
- Nebius reads `reasoning_effort`, and accepts the full six-value ladder including `xhigh`; it
  **ignores** `enable_thinking` (3 runs with `enable_thinking:false` returned 30–43 reasoning tokens,
  i.e. thinking never turned off). `reasoning_effort:none` returned 0 reasoning tokens in 3/3 runs.
  Established by billed `reasoning_tokens` per probe.
- The `deepseek` family override in `src/provider-policy.ts:508` already selects
  `openai-effort`/`EFFORT_FIVE`, so V4.1-Flash-1017 is correct today by accident; the **provider row**
  is still `booleanThinking(...)` (`src/provider-policy.ts:267`), which is wrong for every non-DeepSeek
  family on Nebius.
- `modal-proxy`'s configured base is dead: the old GLM host returns `404 domain association not
  found` for both `/v1/models` and `/v1/chat/completions`.
- The `modal` shared-endpoint row is also dead: `api.us-west-2.modal.direct/v1` returns
  `404 route not found`; the real gateway host `inference.us-west.modal.direct` answers
  `401 invalid proxy auth credentials` (i.e. the route exists, the token does not).
- The vault's `wk-`/`ws-` proxy pair is **rejected** at the new DeepSeek endpoint
  (`401 Webhook token not found`). Both documented auth shapes fail identically (dot-joined Bearer and
  `Modal-Key`/`Modal-Secret`), so the token is revoked or scoped to another environment — not a
  dialect problem. Established against `modal.com/docs/guide/webhook-proxy-auth`.
- `modal-proxy` already implements the correct auth: `getModalProxyApiKey()` joins
  `MODAL_PROXY_TOKEN_ID.MODAL_PROXY_TOKEN_SECRET` (`src/providers/modal-proxy.ts:12`), and boot maps
  the same pair into `keyStore['modal-proxy']` (`src/index.ts:4681`, `src/index.ts:4902`).
- Baseline gates before this task: `npm run build` clean; `tests/provider-policy-matrix`,
  `provider-policy-docs`, `usage-policy` = 47/47 pass; `npm run validate:model-specs` **already fails**
  with 95 errors / 39 warnings / 1082 unmatched (pre-existing, unrelated).
- `PROVIDER_REGISTRY` rows may not share a `keyEnvVar` today (0 of 21 do), and
  `resolveProvidersForKey` maps a secret to **every** summary whose `keyEnvVar` matches
  (`src/pqc-key-resolver.ts:76`), so a shared var would fan one secret out to both rows — usable, but
  it must be a deliberate decision, not an accident.
- `router-settings.json` is gitignored (`.gitignore:234`) and carries the live curation; code changes
  must not assume it exists.

## 3. Plan

### Goals

- A `nebius-us-north1` provider row exists, is keyed by the same Token Factory credential, and
  discovers exactly the 8 models that gateway serves.
- `modal-proxy` points at `https://nbiish--ep-deepseek-v4-1-flash-1017-server.us-west.modal.direct/v1`
  with a catalog matching that deployment, and the dead GLM host is gone from code.
- Both provider rows state the reasoning/caching dialect the wire actually honours, with the
  measurement or source that establishes it.
- The stale `modal` shared-endpoint row is corrected to a host that exists.
- A single verification command proves both providers answer through the router, not just that the
  process booted.

### Non-goals

- Adding a `DeepSeek-V4.1-Flash-1017` fallback chain step or reordering `DEFAULT_FALLBACK_PAID_IDS` —
  chain content is the operator's call and lives in the gitignored `router-settings.json`.
- Pruning the 16 dead global-Nebius curated rows wholesale — the honest repair is to reconcile them
  against the live listing, but retiring a curated model is a curation decision; this plan fixes only
  rows this task's evidence proves wrong (renames and removals of models absent upstream).
- Reworking the `modal` provider's auth model (it is an `ak-`/`as-` API-token provider, not a proxy
  token provider); only its host is corrected.
- Rotating the Modal proxy token — the operator does that; this plan makes the code correct so a fresh
  token works the moment it lands in the vault.

### Constraints and invariants

- Secrets stay in `pqc-secrets`; no key value is printed, logged, or committed. Probes read from
  `bin/pqc-secrets export` in a subshell and never echo the value.
- `AGENTS.md` rule 1: no work on `main`; all edits land in the worktree and merge back.
- `AGENTS.md` rule 4: the operator is the only author; no `Co-authored-by:` trailer.
- `src/provider-policy.ts` is a coverage contract: every `PROVIDER_REGISTRY` entry needs a policy row
  (`tests/provider-policy-matrix.test.mjs:148`) that cites a `docs/caching/*.txt` file
  (`tests/provider-policy-docs.test.mjs`). Adding a provider therefore also adds a doc.
- `src/usage-policy-table.ts` needs one row per provider so a new provider is not silently `unknown`
  by omission (its own header says so; no test enforces it, so this plan does).
- `PROVIDER_ENDPOINTS.md` is generated — regenerate, never hand-edit.
- Base URLs must end in `/v1` with no trailing slash (`src/routes/config-api.ts:1154`); the Modal
  endpoint as given ends in `/v1/chat/completions` and must be trimmed to its base.

### Proposed architecture

Two axes, deliberately independent:

```
credential axis                    endpoint axis
LOCALROUTER_NEBIUS_API_KEY ──┬──► nebius             api.tokenfactory.nebius.com/v1       (24 models)
                             └──► nebius-us-north1    api.tokenfactory.us-north1.nebius.com/v1  (8 models)

MODAL_PROXY_TOKEN_ID.SECRET ─────► modal-proxy        nbiish--ep-deepseek-v4-1-flash-1017-…/v1
MODAL_API_KEY ───────────────────► modal              inference.us-west.modal.direct/v1
```

The region is a **separate provider**, not a query parameter, because the router's unit of key
resolution, curation, policy, and fallback identity is the provider row. Two rows over one credential
gives region pinning for free: a route that must stay in `us-north1` references
`nebius-us-north1/...` and never silently fails over to another region under the same name. The cost
is that the credential is named twice, which is why the shared-key resolution behaviour is stated as
an explicit invariant rather than left implicit.

For `modal-proxy`, the deployment *is* the provider — its host encodes the model — so re-pointing is a
row edit, not a new provider. Its registry block, fallback discovery list, and pricing label all key
off the same host, so they move together.

### Interfaces and data

- New registry row:
  `{ name: 'nebius-us-north1', endpoint: 'https://api.tokenfactory.us-north1.nebius.com/v1', keyEnvVar: 'NEBIUS_API_KEY', note: '…' }`.
  Reusing `NEBIUS_API_KEY` is what makes `resolveProvidersForKey` hand one vault secret to both rows;
  the alternative (`NEBIUS_US_NORTH1_API_KEY`) would need a second vault entry holding the same value.
- `modal-proxy` endpoint: `https://nbiish--ep-glm-5-3-flash-server…/v1` → `https://nbiish--ep-deepseek-v4-1-flash-1017-server.us-west.modal.direct/v1`
  in both `src/provider-registry.ts:34` and the `getModalProxyBaseUrl()` fallback
  (`src/providers/modal-proxy.ts:9`). `MODAL_PROXY_ENDPOINT`/`MODAL_PROXY_URL` overrides are unchanged.
- `modal` endpoint: `https://api.us-west-2.modal.direct/v1` →
  `https://inference.us-west.modal.direct/v1` (`src/provider-registry.ts:31`).
- `PROVIDER_MODEL_REGISTRY['modal-proxy']`: GLM rows drop, the DeepSeek row plus its discovery
  aliases take their place, matching `src/providers/modal-proxy.ts`'s fallback list.
- `PROVIDER_MODEL_REGISTRY['nebius-us-north1']`: exactly the 8 live ids.
- `PROVIDER_MODEL_REGISTRY['nebius']`: dead rows removed, `DeepSeek-V4-Pro` → `DeepSeek-V4-Pro-0813`,
  misspelled `Nemotron-3-Ultra-550B-A55B` → `Nemotron-3-Ultra-550b-a55b`.
- `PROVIDER_POLICIES['nebius' | 'nebius-us-north1']`: `effortPolicy` with the six-level ladder
  (`EFFORT_SIX`) replacing `booleanThinking`, per the measured `enable_thinking`-ignored result.
- `docs/caching/nebius-us-north1.txt` (new) plus an updated `docs/caching/nebius.txt` recording the
  regional/global catalog split and the measured dialect.
- `docs/caching/modal-proxy.txt` and `docs/caching/modal.txt`: rewritten for the new deployments, each
  with a fresh `Last verified: 2026-11-20` line.
- `src/usage-policy-table.ts`: a `nebius-us-north1` row (`paid`, no published reset).
- `src/provider-pricing.ts`: the `modal-proxy-kimi-k3` entry is keyed to a model this deployment no
  longer serves; retarget it to the DeepSeek row (compute-billed, 0/0).

### Files and symbols

- `src/provider-registry.ts:28` — add the `nebius-us-north1` row beside `nebius`.
- `src/provider-registry.ts:31` — `modal` host correction.
- `src/provider-registry.ts:33-37` — `modal-proxy` endpoint + note.
- `src/provider-model-registries.ts:574-586` — `modal` and `modal-proxy` blocks reconciled with the
  live deployments.
- `src/provider-model-registries.ts:598-627` — `nebius` block reconciled; new
  `nebius-us-north1` block after it.
- `src/providers/modal-proxy.ts:3-16` — default base URL; fallback model list.
- `src/provider-policy.ts:117-131` — add `EFFORT_SIX` (the ladder Nebius was measured to accept).
- `src/provider-policy.ts:266-271` — `nebius` row → `effortPolicy`.
- `src/provider-policy.ts:292-297` — `modal-proxy` row evidence note.
- `src/usage-policy-table.ts:55` — add the region row beside `nebius`.
- `src/provider-pricing.ts:274-279` — retarget the `modal-proxy` pricing entry.
- `docs/caching/nebius.txt` — regional/global split + measured dialect.
- `docs/caching/nebius-us-north1.txt` — new, cites the regional gateway.
- `docs/caching/modal-proxy.txt`, `docs/caching/modal.txt` — new hosts, fresh dates.
- `llms.txt` — provider table rows (`:347`, `:350-351`) and the modal model-note line (`:383`).
- `data/provider-watch.json:26` — add the regional models endpoint.
- `PROVIDER_ENDPOINTS.md` — regenerated by boot, not hand-edited.
- `scripts/verify-provider-endpoints.mjs` — new read-only receipt script (T9).

### Alternatives considered

| Alternative | Why rejected |
|---|---|
| Repoint `nebius` at `us-north1` | Loses 16 models and breaks two live references (`Nemotron-3_5-Lightning`, `Nemotron-3-Ultra-550b-a55b`) for a region pin that most routes do not need. |
| Encode region as a model-id suffix (`nebius/…@us-north1`) | The router's key resolution, curation keys, and policy rows all key off the provider name; a suffix would need parsing in every one of them. |
| Keep `modal-proxy` but add a second `modal-deepseek` provider | Two rows over one token pair, and the curated GLM models would still advertise a dead host. Re-pointing keeps one identity per deployment. |
| Drop `modal-proxy` entirely and wait for a token | The endpoint is the operator's live deployment; the code should describe it correctly even while the token is being rotated. |
| Leave `nebius` row as `booleanThinking` since the DeepSeek family override already rescues V4.1-Flash | That is a coincidence of the model currently being DeepSeek; the row would still mis-translate every GLM/Kimi/MiniMax model on the same host. |

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| Shared `NEBIUS_API_KEY` fans the secret to both rows, so an operator who wants distinct keys cannot have them | Documented in the row note and in `docs/caching/nebius-us-north1.txt`; a distinct var can be added later without breaking either row. |
| Reconciling the `nebius` catalog removes curated rows an operator relies on | Removals are limited to ids proven `404` on the live host; renames keep the model under its live id, and the mapping is recorded in the task record. |
| `router-settings.json` curates `nebius::nvidia/Nemotron-3_5-Lightning`, which the *region* cannot serve | The region is a separate row, so the existing curation is unaffected; T9 asserts the global row still resolves it. |
| The Modal endpoint stays unverifiable until a valid token exists | The plan ships code correct-by-construction with the existing `wk-`/`ws-` handling; T9 reports the upstream status verbatim instead of claiming success, and the task record names the blocker. |
| An `EFFORT_SIX` ladder advertises `xhigh`, which no other provider offers | `clampThinkingLevel` already degrades `xhigh`→`high` for policies that do not accept it; only Nebius rows set `acceptsXhigh: true`. |
| `modal`'s real provider is `ak-`/`as-` API tokens, so pointing it at the proxy gateway may be wrong | Non-goal scoped: only the host is corrected to the documented inference gateway; if it needs proxy auth later that is a separate decision. |

## 4. Clarifications

### 4.1 Nebius scope

- **Question:** `us-north1` serves 8 models (a subset of the global host's 24) and omits
  `nvidia/Nemotron-3_5-Lightning`, which is in the live curated selection. How should the router treat it?
- **Options:** 1. (Recommended) Add `nebius-us-north1` as a separate region-pinned provider and keep
  the global `nebius` row — nothing breaks, and a residency/latency-pinned route becomes possible;
  2. Repoint `nebius` at `us-north1` and reconcile down to 8 models — drops the
  Nemotron-3.5-Lightning curation row; 3. Keep the global base and only reconcile stale rows —
  ignores the region entirely.
- **Selected:** Add as a separate region-pinned provider; keep `nebius` global.
- **Trade-off accepted:** The credential is named by two rows, and the catalog view grows by 8
  near-duplicate model ids that must be distinguished by provider prefix.
- **asked:** operator
- **resolved by:** operator, 2026-11-20.

### 4.2 Modal scope

- **Question:** `modal-proxy`'s endpoint is `404` and its token is rejected. What should the code
  change, given verification is blocked on a valid token?
- **Options:** 1. (Recommended) Repoint `modal-proxy` at the new DeepSeek endpoint and update its
  discovery/catalog rows, with the operator re-issuing the proxy token; 2. The same, plus fixing the
  stale `modal` shared-endpoint row to the real inference gateway; 3. Leave Modal code untouched
  until a working token exists.
- **Selected:** Repoint `modal-proxy` **and** fix the stale `modal` row.
- **Trade-off accepted:** The `modal` row's provider semantics (API token vs proxy token) remain
  unverified past its host being correct; a request against it can still fail on auth until an
  `ak-`/`as-` token exists.
- **asked:** operator
- **resolved by:** operator, 2026-11-20.

### 4.3 Modal token handling

- **Question:** How should the rejected Modal proxy token be handled?
- **Options:** 1. (Recommended) Operator rotates it via `modal workspace proxy-tokens` and stores it
  with `pqc-secrets`; 2. Operator pastes a fresh pair for the agent to store; 3. Leave the current
  token and only make the code correct.
- **Selected:** Operator rotates and stores it themselves.
- **Trade-off accepted:** End-to-end verification of the Modal path is deferred to the operator's
  rotation; this task delivers code correctness plus a receipt that reports the upstream status
  honestly.
- **asked:** operator
- **resolved by:** operator, 2026-11-20.

### 4.4 Reasoning dialect for Nebius rows

- **Question:** The `nebius` row claims `booleanThinking` (`enable_thinking`) while DeepSeek is rescued
  by a family override. Which is true for non-DeepSeek families on this host?
- **Options:** 1. (Recommended) `effortPolicy` — measured, `enable_thinking` is ignored and
  `reasoning_effort` including `xhigh` is honoured; 2. Keep `booleanThinking` and rely on family
  overrides; 3. Claim no dial.
- **Selected:** `effortPolicy` with the six-level ladder; `enable_thinking` is measurably ignored.
- **Trade-off accepted:** Advertising `xhigh` on Nebius while other providers clamp it means a harness
  can observe a level working on one provider and degrading on another — correct, but asymmetric.
- **asked:** resolved from code
- **resolved by:** live probes 2026-11-20 (`enable_thinking:false` → 30–43 reasoning_tokens across 3
  runs; `reasoning_effort:none` → 0; `reasoning_effort:xhigh` → `200`), against
  `src/provider-policy.ts:267`.

## 5. Todos

- [x] **T1** Add the `nebius-us-north1` registry row to `src/provider-registry.ts` sharing
      `NEBIUS_API_KEY`, and correct the `modal` host and `modal-proxy` endpoint in the same file.
  - from: §4.1, §4.2 | done when: registry lists 22 rows, both Modal hosts are live-valid, and the
    region row shares the Nebius key var | verify: `npm run build && node -e "…PROVIDER_REGISTRY check"`
- [x] **T2** Add `EFFORT_SIX` and move the `nebius` policy row to `effortPolicy` with the measured note.
  - from: §4.4 | done when: `resolveReasoningPolicy('nebius','zai-org/GLM-5.3-Flash')` reports
    `openai-effort` with six levels | verify: `npm run build && node --test tests/provider-policy-matrix.test.mjs`
- [x] **T3** Add the `nebius-us-north1` policy row and the `nebius-us-north1` usage-policy row.
  - from: §3 | done when: coverage tests pass and the region row classifies as `paid` |
    verify: `node --test tests/provider-policy-matrix.test.mjs tests/provider-policy-docs.test.mjs tests/usage-policy.test.mjs`
- [x] **T4** Reconcile the `nebius` registry block: drop ids proven `404`, rename
      `DeepSeek-V4-Pro`→`DeepSeek-V4-Pro-0813` and `Nemotron-3-Ultra-550B-A55B`→lowercase-`b`.
  - from: §2 | done when: every remaining id answers on the global host |
    verify: T9 receipt against the global base.
- [x] **T5** Add the `nebius-us-north1` registry block with exactly the 8 live ids and their specs.
  - from: §2 | done when: block matches the live listing | verify: T9 receipt against the region base.
- [x] **T6** Rewrite the `modal-proxy` registry block and `src/providers/modal-proxy.ts`'s default
      base URL + fallback model list for the DeepSeek-V4.1-Flash deployment.
  - from: §4.2 | done when: no code path mentions the GLM host | verify: `rg -n "glm-5-3-flash-server" src/`
    returns nothing.
- [x] **T7** Reconcile the `modal` registry block against the shared-endpoint gateway.
  - from: §4.2 | done when: rows name models the gateway serves, or carry an evidence note |
    verify: T9 receipt against `inference.us-west.modal.direct`.
- [x] **T8** Update `docs/caching/{nebius,nebius-us-north1,modal-proxy,modal}.txt` with fresh
      `Last verified: 2026-11-20` dates, the regional/global split, and the measured dialect.
  - from: §3 | done when: policy-docs bijection test passes and every file has a fresh date |
    verify: `node --test tests/provider-policy-docs.test.mjs`
- [x] **T9** Add `scripts/verify-provider-endpoints.mjs`: a read-only receipt that probes each
      provider's `/v1/models` and one chat completion, printing status per provider and never a key.
  - from: §3 | done when: the script runs green for global Nebius and honestly reports the Modal
    401 while the token is invalid | verify: `node scripts/verify-provider-endpoints.mjs`
- [x] **T10** Retarget the `modal-proxy` pricing entry to the served model in `src/provider-pricing.ts`.
  - from: §3 | done when: no pricing entry references the retired Kimi deployment URL |
    verify: `rg -n "ep-kimi-k3" src/` returns nothing.
- [x] **T11** Update `llms.txt` provider rows/notes, `data/provider-watch.json`, and regenerate
      `PROVIDER_ENDPOINTS.md` by booting the server once.
  - from: §3 | done when: docs match the code | verify: `git diff --stat llms.txt PROVIDER_ENDPOINTS.md`
- [x] **T12** Write the task record, COMMS ledger lines, memory facts, and merge the worktree.
  - from: §3 | done when: `git log main..feat/providers-nebius-region-modal-endpoint` is empty and the
    worktree is removed | verify: `git worktree list`

## 6. Verification

- `npm run build` — clean compile.
- `node --test tests/provider-policy-matrix.test.mjs tests/provider-policy-docs.test.mjs tests/usage-policy.test.mjs`
  — all pass (baseline 47/47).
- `npm test` — no new failures against the recorded baseline.
- `npm run validate:model-specs` — must not exceed the 95-error baseline; zero new `nebius*`/`modal*`
  errors other than those already present.
- `node scripts/verify-provider-endpoints.mjs` — global Nebius green; region green; modal-proxy reports
  the upstream's own status verbatim (expected 401 until the operator rotates the token).
- `rg -n "glm-5-3-flash-server|ep-kimi-k3" src/ docs/ llms.txt` — no matches.
- `bin/pqc-secrets list --json` — no new plain-named secrets introduced.

## 7. Open Decisions

- Whether `modal` (the `ak-`/`as-` API-token provider) is still wanted at all, now that every
  own-deployment path is proxy-token based — settled once a token exists and one chat completes, or
  the operator retires the row.
- Whether the region row should later become the *default* Nebius for latency — settled by measuring
  TTFT from this host against both bases.

## 7. Outcome (closed 2026-11-20)

All twelve todos landed on `main` via merge commit `8a16520`; branch deleted, worktree removed.

- **§4.4 was corrected by measurement during implementation.** The original note said the DeepSeek
  family override "already rescues" Nebius. Measuring the OTHER families showed the opposite problem:
  `enable_thinking` is inert on that wire, so GLM/Kimi/MiniMax levels were silently dropped. That
  required a code change (`providerDeclaresDialect`), not just a policy-row edit — recorded here
  because it invalidated the plan's assumption rather than diverging quietly.
- **`modal-proxy` remains unverified** pending the operator's token rotation. Its code is correct and
  its receipt says FAIL with the upstream's own words. Per §4.3 this is the accepted state.
- **Not done, by design:** the operator's `router-settings.json` still curates the retired
  `modal-proxy::GLM-5.3-Flash*` ids, and `custom-providers.json` still holds a `modal-glm` row pointed
  at the dead GLM host. Both live outside the checkout or are operator-owned; flagged in the task
  record and COMMS ledger. Cleaning them is a one-line curation edit the operator should make, because
  until then `/v1/models` advertises three `modal-proxy-glm-5.3-flash*` rows that can only 401.

- Whether `modal` (the `ak-`/`as-` API-token provider) is still wanted at all — **still open**: no
  `ak-`/`as-` token exists to settle it.
- Whether the region row should become the default Nebius for latency — **still open**: needs a TTFT
  measurement from this host against both bases.
