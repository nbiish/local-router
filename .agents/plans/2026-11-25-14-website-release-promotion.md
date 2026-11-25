---
plan_format: ainish/plan/v1
slug: website-release-promotion
date: 2026-11-25
status: done
branch: feat/website-release-promotion
worktree: C:/Users/kenwa/code-external/local-router-worktrees/feat-website-release-promotion
task_record: .agents/tasks/2026-11-25-14-website-release-promotion.md
operator: user
---

# Plan: Release-Linked `production` Branch & Website Promotion Workflow

1. Add `.github/workflows/promote-website-release.yml` triggered on `release: [published]` and `workflow_dispatch`:
   - Fast-forwards `refs/heads/production` on `nbiish/local-router` to the published release commit.
   - Dispatches `repository_dispatch` (`event_type: "local-router-release"`) to `nbiish/local-router-dot-com` using `secrets.WEBSITE_DISPATCH_TOKEN` (failing closed if unset).
2. Update `.github/workflows/desktop-release.yml` release body provider count (`19` -> `23 built-in model providers`).
3. Open PR against `nbiish/local-router` `main`.
