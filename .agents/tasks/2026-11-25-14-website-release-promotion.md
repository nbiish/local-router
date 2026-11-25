# Task: Release-Linked `production` Branch & Website Promotion Workflow

- lane: now
- branch: `feat/website-release-promotion`
- status: done
- plan: `.agents/plans/2026-11-25-14-website-release-promotion.md`
- scope: `.github/workflows/promote-website-release.yml`, `.github/workflows/desktop-release.yml`
- objective: Link `nbiish/local-router` published GitHub Releases to `refs/heads/production` and dispatch `local-router-release` to `nbiish/local-router-dot-com` for Cloudflare Pages production deploys.
