# TASK — Agents Skill Hygiene
Date: 2026-06-02
Branch: chore/agents-skill-hygiene
Base: develop @ 04f9424

## Plan
- Read uncommitted main changes
- Identify symlink portability issue
- Group changes into atomic commits
- Worktree from develop
- Push branch to local-router

####

## Findings
- SKILL.md: symlink to system path
- pqc_helper.py: no timeout, swallowed errors
- .gitignore: missing local agent config
- TASK.2026-05-27.md: stale, removable

## Actions
- Create worktree chore/agents-skill-hygiene
- Stash main, pop in worktree
- Convert SKILL.md symlink to regular file
- Add timeout, returncode distinction
- Add .opencode/ and .omo/ excludes
- Delete stale task file
- Record work in this file
- Push branch to local-router

####

## Deliverables
1. `.agents/skills/pqc-signatures-security/SKILL.md` — portable regular file (was symlink)
2. `.agents/skills/pqc-signatures-security/scripts/pqc_helper.py` — hardened subprocess wrapper
3. `.gitignore` — exclude `.opencode/`, `.omo/` local agent config
4. Removed `TASK.2026-05-27.md` — stale
5. `.agents/tasks/TASK.2026-06-02.agents-skill-hygiene.md` — this record
6. Branch `chore/agents-skill-hygiene` pushed to `local-router`

## Audit
- No banned crypto introduced
- No secrets or keys touched
- PQC operations remain ML-DSA-65 only
- OpenSSL pkeyutl calls preserved
- Worktree isolated from main
- No merges to develop performed
