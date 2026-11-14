# TASK.2026-11-12 — Maximum prompt caching across all providers and models

- Machine: mac (darwin arm64), checkout `/Volumes/1tb-sandisk/code-external/local-router`
- Branch: `feat/max-caching-everywhere` (worktree `../local-router-max-caching`, off `main` @ cd3fe1a)
- Plan: `.agents/plans/2026-11-12-max-caching-everywhere.plan.md`
- Status: done (T1/T2 live re-measurement blocked on operator keys — see below)

## Operator directive (2026-11-12)

"We should be using max possible caching across all providers and models." — reverses the
conservative fastino row shipped earlier the same day; every row now runs at the maximum its
evidence supports.

## Worktree journal

- Commit `e1f9ab6` (author `Nanoboozhoo - embodies by omp <nanoboozhoo@local>`); 6 files,
  +88/−49; merged to `main` (merge commit follows `merge: feat/max-caching-everywhere …`);
  `git log main..branch` empty; worktree removed (`--force` after proving its only deltas were
  old copies of skills main's working tree deliberately deleted) and branch deleted (e1f9ab6).

## What changed

- **fastino** → `anthropicCache` at maximum: 4 breakpoints, 1h TTL, tool breakpoint, sticky
  `prompt_cache_key` — the predecessor wire's measured shape (api.pioneer.ai 2026-08-23) plus
  the directive. `docs/caching/fastino.txt` carries the receipt and names the gap.
- **opencode-go/zen** → automatic + sticky: the injected markers were for `/messages` families
  the router no longer serves (§4.1 chat-only); the Console chat wire's caching is automatic
  prefix caching billed via `usage.opencode.tokens.cache_read` — prefix stability is the lever.
- **nvidia-nim** `noCache` → `implicitCache`: hosted NIM is vLLM-backed (automatic prefix cache)
  `[INFERENCE]`.
- **xiaomi-mimo, wafer-serverless, antigravity, github-copilot, cursor** → sticky
  `prompt_cache_key` (zai-row precedent: anchors sessions where honoured, ignored where not).
- **Dead knob removed**: `minCacheableTokens` was declared in every row but consulted NOWHERE in
  the runtime — markers already reach every prompt (the max posture); floor facts stay in notes.
- fastino registry rows flag `supportsCache` (runtime caching is provider-policy driven; the
  flag is client-facing truth).
- Tests pin the max contract: markers on every prompt (even tiny ones — the marker count is the
  only budget), stable sticky key, no retention leak to wires that document none.

## Verification

- Full suite: 378 tests, 367 pass, 12 skipped (sandbox-gated), 0 fail.
- Wire-shape smoke (mock upstream behind the router, 5/5): `cache_control {type:'ephemeral',
  ttl:'1h'}` reaches the wire on the system breakpoint; `prompt_cache_key` stable across
  identical shapes; `prompt_cache_retention` absent where undocumented.

## Measurement results (probes through pqc-secrets export → stdin → memory; no key material in
argv/files/logs) — and the blocker

- **fastino: 401** — "API keys starting with 'pio_sk_' were retired on the move to Fastino."
  The bundle's `LOCALROUTER_PIONEER_API_KEY` value is a retired pioneer-era key. The max policy
  is enabled on the predecessor measurement; re-probe once a valid fastino key exists.
- **opencode-zen: 401** — "This API key has expired. Create a new API key in OpenCode Console."
- Operator actions: `pqc-secrets set LOCALROUTER_FASTINO_API_KEY=<fs key>` and
  `pqc-secrets set LOCALROUTER_OPENCODE_ZEN_API_KEY=oc_sk_…` (canonical names; the stale
  `LOCALROUTER_PIONEER_API_KEY` entry can then be `pqc-secrets del`'d). Then re-run the marker/
  retention probes and replace the [INFERENCE]-flavoured notes with measurements.
