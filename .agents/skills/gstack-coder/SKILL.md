---
name: gstack-coder
description: >
  Multi-tool coding skill integrating gstack (Claude Code skills), claude (Claude Code),
  and mini-live (mini-swe-agent with Live-SWE-agent config). Use when spawning Claude Code
  sessions for coding work, running security audits, code reviews, QA testing URLs,
  building features end-to-end, or planning before building. Also configures and
  orchestrates sub-agents to maximize utilization of all AI subscriptions and APIs.
  For MCP-equipped sub-agent dispatch with provider fallback, pair with pi-mini-orchestrator skill.
---

# GStack Coder — Multi-Tool Coding Orchestration

This skill combines **gstack** (Claude Code skill pack) with **claude** and **mini-live** to form a complete multi-tool coding workflow. Each tool has unique strengths and subscription quotas — this skill ensures all are utilized.

**PRD Anchor:** Always read `llms.txt` in the repository root first. It is the authoritative Product Requirements Document for this repo — it defines architecture, security policy (PQC mandates, secrets management), workflow rules (git worktrees, commit conventions), and the provider/MCP infrastructure. If `llms.txt` and any other doc conflict, `llms.txt` wins. Never skip reading it.

---

## 1. GStack Installation & Setup

gstack is a collection of Claude Code skills by garrytan. Install once:

```bash
git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup
```

After installation, gstack provides these slash commands inside Claude Code:

| Command | Purpose |
|---------|---------|
| `/cso` | Security audit — full codebase security review |
| `/review` | Code review — detailed PR/code review |
| `/qa https://...` | QA test a URL — test a deployed endpoint |
| `/autoplan` | Auto-plan — generate implementation plan for a feature |
| `/ship` | Ship — build, test, and deploy pipeline |
| `/office-hours` | Office hours — architect/planning discussion before building |

---

## 2. Multi-Tool Coding Workflow

### Tool Inventory

| Tool | CLI Command | Config Location | Best For |
|------|-------------|-----------------|----------|
| **Claude Code** (gstack) | `claude` | `~/.claude/` or `.claude/` | Security audits, code review, planning, shipping |
| **mini-swe-agent** (Live-SWE) | `mini-live` | `~/.config/mini-swe-agent/live-swe-agent.yaml` | SWE execution: fixes, tests, migrations, bash tasks |
| **mini-swe-agent** (default) | `mini` | `~/.config/mini-swe-agent/.env` | Upstream default config only when Live-SWE is not needed |

**Rule:** This skill uses **`mini-live`** for all mini-swe-agent dispatch — never bare `mini` for gstack-orchestrated SWE work.

`mini-live` is a shell function (`~/.zsh/functions.zsh`) equivalent to:

```bash
mini --config ~/.config/mini-swe-agent/live-swe-agent.yaml "$@"
```

### Secret & Provider Injection (PQC compliance)

API keys and provider endpoints are stored securely at rest using the PQC secrets bundle. Load them into your shell environment before invoking the tools:

```bash
# 1. Load keys into environment memory
secrets-load

# 2. Run claude directly using environment keys
claude -p "Add input validation to src/api/handlers.ts" --no-session --thinking off

# 3. Run mini-live (Live-SWE-agent config + ~/.config/mini-swe-agent/.env)
mini-live --task "Fix the race condition" --yolo
```

---

## 3. Coding Task Patterns

### Security Audit
```
Load gstack. Run /cso
```
Full codebase security review using gstack's security audit skill. Covers PQC compliance, injection vectors, secret leaks, and dependency vulnerabilities.

### Code Review
```
Load gstack. Run /review
```
Detailed PR/code review with line-by-line analysis, best practices checks, and improvement suggestions.

### QA Test a URL
```
Load gstack. Run /qa https://staging.example.com
```
Test a deployed URL end-to-end: functional testing, API validation, UI checks, performance baseline.

### Build a Feature End-to-End
```
Load gstack. Run /autoplan, implement the plan, then run /ship
```
Full cycle: auto-generate implementation plan, execute, build and ship.

### Plan Before Building (No Implementation)
```
Load gstack. Run /office-hours then /autoplan. Save the plan, don't implement.
```
Architecture discussion first, then detailed plan. Save for later. No code changes.

---

## 4. OSA: Orchestrated System of Agents

When dispatching work across coding tools using fixed-order rotation:

```
gemini → claude → crush → mini-live → opencode → kilo → (wrap)
```

### YOLO Dispatch Commands

Ensure environment variables are loaded via `secrets-load` first.

```bash
# Sequential dispatch — each agent does one task
gemini -p "Add error handling to src/api/routes.ts" -y
claude -p "Review the error handling for edge cases" --dangerously-skip-permissions
mini-live --task "Validate routes against schema" --yolo
```

### Parallel Dispatch (separate worktrees)

```bash
# Each agent works on a different file in isolation
git worktree add ../task-auth agent-gemini
cd ../task-auth && gemini -p "Implement OAuth2 login flow" -y &

git worktree add ../task-payment agent-claude
cd ../task-payment && (write ~/.claude.json) && claude -p "Implement Stripe payment integration" --no-session --thinking off &

wait
# Review and merge worktrees back
```

---

## 5. Tool-Specific Configuration

### Claude Code (`claude`)
- Config: `~/.claude.json` (user settings and MCP)
- Non-interactive: `claude -p "prompt" --no-session --thinking off`
- Dynamic MCP: Write MCP servers to `~/.claude.json` dynamically right before calling `claude` (and clean up using traps).

### mini-swe-agent — Live-SWE (`mini-live`)
- Global config: `~/.config/mini-swe-agent/live-swe-agent.yaml` (upstream [live-swe-agent](https://github.com/OpenAutoCoder/live-swe-agent) `config/livesweagent.yaml`)
- Provider env: `~/.config/mini-swe-agent/.env` (loaded automatically by mini-swe-agent)
- Non-interactive: `mini-live --task "prompt" --yolo`
- Equivalent explicit form: `mini --config ~/.config/mini-swe-agent/live-swe-agent.yaml --task "prompt" --yolo`
- Refresh config from upstream:
  ```bash
  curl -fsSL "https://raw.githubusercontent.com/OpenAutoCoder/live-swe-agent/main/config/livesweagent.yaml" \
    -o ~/.config/mini-swe-agent/live-swe-agent.yaml
  ```
- Repo vendored copy (reference only): `config/livesweagent.yaml` in this repository

### mini-swe-agent — default (`mini`)
- Use only when upstream default `mini.yaml` behavior is explicitly required
- Not used by this skill for orchestrated SWE work

---

## 6. MCP Sub-Agent Dispatch

For MCP-equipped sub-agent dispatch with automatic provider fallback, pair with the **pi-mini-orchestrator** skill. It provides:

- MCP server catalog (10 servers: tavily, context7, brave, github, postgres, filesystem, codewhale, puppeteer, memory, gitnexus)
- Provider fallback chain (modal → nvidia → nebius → opencode → zai → wafer-serverless → openrouter → zenmux)
- Error recovery patterns (provider failure → next provider config, MCP failure → retry without)
- Scoped MCP: sub-agents only get the tools they need per task

When pi-mini-orchestrator dispatches mini-swe-agent for execution, use **`mini-live`** (not bare `mini`).

---

## 7. Adding "Coding Tasks" to AGENTS.md

When setting up a new codebase, add this section to AGENTS.md:

```markdown
## CODING TASKS

When spawning Claude Code sessions for coding work, tell the session to use gstack skills.
Always read llms.txt first — it is the authoritative PRD for this repository.

### Task Patterns

- **Security audit**: "Load gstack. Run /cso"
- **Code review**: "Load gstack. Run /review"
- **QA test a URL**: "Load gstack. Run /qa https://..."
- **Build feature end-to-end**: "Load gstack. Run /autoplan, implement the plan, then run /ship"
- **Plan before building**: "Load gstack. Run /office-hours then /autoplan. Save the plan, don't implement."

### Multi-Tool Dispatch

For parallel work across subscriptions (in canonical order):
- Ensure `secrets-load` is run to export API keys
- **claude**: `claude -p "task" --no-session --thinking off`
- **mini-live**: `mini-live --task "task" --yolo`

For MCP-equipped sub-agent dispatch with provider fallback, pair with pi-mini-orchestrator skill.
```
