Usage windows and failure economics — per provider
==================================================

What this directory answers: when a member fails, how long should it be parked,
and is that a budget problem or a broken provider?

The code-owned table is `src/usage-policy-table.ts`. These files carry the
long-form evidence and the "Last verified" date, mirroring `docs/caching/`.

Evidence tiers for a reset, strongest first
-------------------------------------------
1. header   — `Retry-After`, `x-ratelimit-reset*`. Machine-readable; trusted.
2. body     — a stated duration ("retry in 45 seconds"). Trusted but weaker.
3. hint     — vague prose ("retry shortly"). Recorded as INFERRED.
4. default  — nothing known. The class default applies and is marked inferred.

Measured 2026-11-18: no provider in this fleet publishes reset headers on a
successful path, and all 11 live 429s carried only prose hints. So tier 4 is
the common case and must always be honest about being a guess.

Economic classes
----------------
subscription — a rolling window. Exhausting it is parked for the window.
free         — allowance undocumented and volatile. Recorded as unknown.
paid         — metered; a 429 is a burst, a 402 is a billing problem.
local        — no budget at all; a failure is a process problem.

Operator-confirmed facts (2026-11-18)
-------------------------------------
- The ONLY subscription is the GLM coding plan (z.ai), ~5h window.
- Xiaomi MiMo is a designated TOKEN allowance, not a rate-limited window.
- Ollama, Unsloth and llama.cpp remain available so online and local usage can
  be combined. Local-router itself is not an offline-only system.
