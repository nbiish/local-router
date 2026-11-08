# Task — local work-review site for the repo's work record — 2026-11-07

- **Branch:** `feat/review-site`
- **Worktree:** `~/orca/workspaces/local-router/lr-review-site`
- **Lane:** now
- **Status:** done
- **Scope:** a local, browser-reviewable explorer for this repo's recent work — the COMMS work
  cycles, git history, task records, memories, suggestions, research, and docs — so the operator
  can intuitively browse findings, gotchas, verification evidence, and diffs in one place.
- compat: Additive tooling only. Two new npm scripts (`review:build`, `review:site`) and a new
  `scripts/review-site/` directory; no request, CLI, schema, or runtime change. Generated output
  lands in `build/review-site/` (already gitignored) so `local-router update` stays clean.
- concurrency: one writer on a task branch; appends to dated `.agents/` records only.
- budget: no model, retrieval, or CI spend. Verification is local `node`, `npm install`, and the
  repository test gate.

## Design

- `scripts/review-site/generate.mjs` — read-only extraction over the repo: git log (all 869
  commits, per-commit file stats, full diffs for the window since `--since`, default 2026-11-01),
  `.agents/comms/*-team.txt` ledgers, `.agents/tasks`, `.agents/memories`, `.agents/suggestions`,
  `.agents/research`, and the root + `docs/` markdown. Emits `build/review-site/data.json`.
- The ledger parser handles all three historical entry formats: the old `- id:` YAML-block format
  (with `>` block scalars folded into their field), the mid format (`[ts] agent event` headers),
  and the current `### [ts] EVENT | branch: | wt:` format. The `<PROTOCOL>` block is stripped
  before parsing so its example header cannot become a fake entry. Event names are normalized to
  a `kind` (e.g. `FEATURE` -> `feat`, `mac-checkout-1` -> `checkout`) for chips and filters.
- `scripts/review-site/serve.mjs` — stdlib static server, loopback only, default port 8777.
- `scripts/review-site/app/` — dependency-free static app (hash routing): Overview (stats,
  45-day commit/cycle activity, needs-attention panel), Timeline (cycles + commits + memory notes
  by day, with source filters), Work cycles (grouped findings/gotchas/verification/compat fields,
  text + event + status filters), Commits (file stats + colored diff viewer), Records (tasks,
  memories, suggestions, research), Docs (markdown reader with on-page TOC), and full-text Search
  with highlighted context snippets. All repo text is escaped before rendering; nothing executes
  repo content.

## Gates

- smoke: generated from the real record (869 commits, 41 with diffs, 115 cycles, 137 tasks,
  9 memories, 34 docs); served on 127.0.0.1:8777 and every view exercised in a real browser —
  overview chart reflects the true Sep 24 - Oct 26 quiet period and the two work bursts; cycle
  drill-down shows grouped fields; commit diffs render colored; docs render markdown with TOC;
  search "typesafe" returns 38 ranked, highlighted matches; cycle filter narrows 115 -> 12;
  zero console errors.
- fixed in smoke: undated memory files (`MEMORY.md`, `memories/llms.txt`) collapsed into a
  `T12:00:00` timeline bucket; now they take a file-date or mtime fallback and sort last.
- suites: repository gate `npm run test:integration` run on the branch; result recorded in the
  COMMS entry. `scripts/check-english-only.mjs` covers the new files.

## Masters (triggered surfaces: npm scripts = CLI surface, user-facing text)

- structure/operations (4): one command brings the site up (`npm run review:site`); the server
  binds 127.0.0.1 only; generated data lives in gitignored `build/`, so a pull can never fight
  with a regenerated snapshot.
- comprehension/operability (9): each script carries a header stating what it reads and writes;
  README Dev Scripts documents both commands; the app is three plain files with no build step.
- dependencies/provenance (3): zero new dependencies — node stdlib only, nothing to vendor.

- Classification: Internal. No secrets in this file.
