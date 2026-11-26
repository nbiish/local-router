# Suggestion: root `llms.txt` carries stale branch doctrine

- date: 2026-11-26
- status: open
- found during: release-promotion-chain work (`.agents/tasks/2026-11-26-17-release-promotion-chain.md`)

The root `llms.txt` still describes this as a single-branch `main` repository, contains a
self-contradictory merge-path section ("worktrees merge directly back into `main`" vs "never promote
feature work directly to `main` … must pass through `develop`" vs "single-branch, no develop"), and
predates the `production` branch and the release chain added on 2026-11-25 (`RELEASING.md`,
`promote-website-release.yml`, `desktop-release.yml`).

Consequence observed: the `--context` prime agents answered from that doctrine and asserted "production
is not a branch here" and "PR #14 still open" — both wrong against the repository. Stale DOX produces
stale retrieval.

Suggested resolution: a DOX refresh pass over `llms.txt` (ownership/branch doctrine, release and
production flow, pointer to `RELEASING.md`), and a rule that PRs changing branch or release mechanics
update `llms.txt` in the same change.
