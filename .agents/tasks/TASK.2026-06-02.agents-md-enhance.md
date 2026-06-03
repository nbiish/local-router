# TASK.2026-06-02.agents-md-enhance.md

## Date: 2026-06-02
## Branch: docs/agents-md-enhance
## Base: develop @ d1408e1

####
CoD reasoning (≤5 words/step):
- User asked to improve AGENTS.md.
- Add verification procedures.
- Add post-merge cleanup details.
- Make expert and concise.
- No bloat, just actionable steps.
- Preserve existing structure.
- Add concrete examples.

####
####
Step 1: Survey current AGENTS.md.
- 185 lines, 6 sections.
- WORKTREE GATE: branch check + worktree check.
- WORKFLOW: branch strategy, dev loop, merge.
- AUDIT: checklist with worktree hygiene.
- Missing: verification steps, cleanup details.

####
Step 2: Identify gaps.
- Branch naming examples absent.
- Worktree path convention absent.
- No smoke-test commands in dev loop.
- "Clean up post-merge" mentioned briefly.
- No -d vs -D branch delete guidance.
- AUDIT lacks verification gate.

####
Step 3: Plan enhancements.
- WORKTREE GATE: add branch type examples.
- WORKFLOW: add Step 6 Verify.
- WORKFLOW: add Post-Merge Cleanup subsection.
- AUDIT: add verification + cleanup items.
- Keep changes minimal, no bloat.

####
Step 4: Edit WORKTREE GATE.
- Add branch type examples list.
- Add worktree path example.
- Add "Safe to delete merged worktree" note.
- Use concrete slugs, not abstract.

####
Step 5: Edit WORKFLOW.
- Add Step 6 Verify with commands.
- Add Post-Merge Cleanup subsection.
- Cover -d fails when develop holds merge.
- Cover -D safe with rationale.

####
Step 6: Edit AUDIT.
- Add "Verification" item.
- Add "Post-merge cleanup" item.
- Concise checklist additions.

####
Step 7: Verify and commit.
- Diff review for accuracy.
- Gitleaks scan (docs only).
- Commit on feature branch.
- Ask user for merge.

####
####

## Files Modified

1. `AGENTS.md` — WORKTREE GATE, WORKFLOW, AUDIT sections

## Out of Scope

- No code changes
- No API endpoint changes
- No provider metadata changes
- No new PQC or signature work

## Security Audit

- AGENTS.md is documentation only
- No code, no secrets, no crypto changes
- Gitleaks scan on diff (will pass)
- No .env modifications
- All existing rules preserved
