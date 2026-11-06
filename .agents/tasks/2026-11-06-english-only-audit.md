# Task — repository English-only audit and escape-corruption repair — 2026-11-06

- **Branch:** `fix/english-only-audit`
- **Worktree:** `D:/Code/lr-english-only`
- **Lane:** now
- **Status:** in progress
- **Scope:** make every tracked artifact English, and repair the escape-interpretation damage that
  silently replaced characters with control bytes.
- compat: Content-only repair. No source, schema, CLI, routing, or dependency change. The single
  user-facing label change (`＋` → `+`) is inside existing HTML strings and has no API surface.
- concurrency: appends to dated `.agents/` records only; no shared-state rewrite.
- budget: no model, retrieval, or CI spend. Verification is local `node` + `npm run build`.

## Findings

Scanned all 451 tracked files for non-Latin scripts, CJK/fullwidth punctuation, Latin-script
non-English prose, invisible formatting characters, and raw control bytes.

**1. Escape-interpretation corruption — 23 sites across 6 files.** Backticks were converted to
backslashes and then interpreted as escape sequences, so `` `ainish-rag` `` became `\ainish-rag\`
and `\a` collapsed to a BEL byte. The visible symptom is a missing first letter (`inish-rag`,
`lwaysAvailable`, `erify:decisions`); the byte-level symptom is a control character embedded in
prose. Affected: `.agents/comms/2026-10-30-team.txt` (5), `.agents/comms/2026-10-31-team.txt` (2),
`.agents/memories/llms.txt` (6, plus one TAB), `.agents/suggestions/2026-10-30-suggestions.txt` (5),
`.agents/suggestions/2026-10-31-suggestions.txt` (4), `llms.txt` (1).

These files are also corrupted at the source commit (`ad4ae61` and earlier), so no clean blob
exists in history to restore — the text is reconstructed from context.

**2. Latin/Cyrillic homoglyphs — 2 sites.** `rерanked` (U+0435 U+0440) in
`.agents/suggestions/2026-10-30-suggestions.txt:50` and `PQС` (U+0421) in
`.agents/tasks/2026-10-29-task.md:28`. Both are unsearchable and break `grep`.

**3. CJK fullwidth `＋` (U+FF0B) — 8 sites in `llms.txt`, 5 in `src/`, 6 in `.agents/` records.**
Operator-approved normalization to ASCII `+`.

**4. Deliberate or legitimate non-Latin text — retained, not defects.** Anishinaabemowin syllabics
in `critical.md` (the steward's name, beside its Latin transliteration), the Greek `γ`/`ξ`/`Σ`
symbols in cryptographic and ranking notation, and the `払湵畴…` mojibake in
`pqc_secrets.py`'s docstring (it documents the exact bug being fixed). The English-only clause
permits quoted operator material with a gloss, which is how `critical.md` already presents it.

## Acceptance

- No control bytes or stray tabs inside prose in any tracked text file.
- No Latin/Cyrillic mixed-script tokens.
- No fullwidth `＋` anywhere.
- `scripts/check-english-only.mjs` fails the build on any recurrence, wired into CI.
- `npm run build` and the focused test suite still pass.

## Outcome

Repaired: 23 control-byte sites across 6 files, 2 homoglyph tokens, and 28 fullwidth `+`
characters across 10 files. Two further mangled spans (the `MEMORY.md` entry-format template and
the `exports/` command in `.agents/memories/llms.txt`) were caught in a second pass because their
bodies contained spaces and the first pass skipped those to protect Windows paths.

Added `scripts/check-english-only.mjs` with an explicit `ALLOW` list carrying a reason per entry,
plus `scripts/check-english-only.selftest.mjs`, which proves the guard fails on each defect class
and stays quiet on the four legitimate shapes (math symbols, code spans, ASCII label, fenced
blocks). Wired into `.github/workflows/ci.yml` after the build.

## Verification

```bash
node scripts/check-english-only.mjs           # OK, 0 findings
node scripts/check-english-only.selftest.mjs  # 10/10 passed
npm run build                                 # tsc clean
```

`npm run test:integration` reports two failures —
`antigravity-auth-platform-detect.test.mjs` ("auto-detects host installation") and
`custom-providers.integration.test.mjs` ("custom provider CRUD"). Both reproduce unchanged on
`main` in `D:/Code/local-router` with this diff absent, so they are pre-existing host-environment
failures (a missing local Cursor session, and a provider catalog leaking a demo model), not
regressions from this task. `data-stage-fallback`, the attribute the UI tests actually assert, is
untouched.

## Note for the next agent

`git worktree add` for a new sibling checkout fires this repo's `post-checkout` hook, which runs
`.agents/bin/ainish-rules-sync`. That sync rewrites `.agents/ainish-deploy.json`/`.sig`, merges the
COMMS ledger, and — because a fresh worktree is not yet enrolled in the fleet registry — deletes
every selected skill pack. Restore with `git restore .agents/skills` and revert the manifest, or
run git with `-c core.hooksPath=/dev/null` in a scratch worktree.
