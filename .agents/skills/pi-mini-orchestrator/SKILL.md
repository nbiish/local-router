---
name: pi-mini-orchestrator
description: >
  Multi-agent orchestration via fixed claude→mini rotation with scoped MCP tools and provider fallback chains.
  Every dispatch gets exactly the MCP servers it needs, a provider chain that auto-recovers from API failures,
  and its own git worktree for filesystem isolation. Use when dispatching subagent tasks, running parallel
  coding work across subscriptions, or orchestrating complex multi-step code changes.
---

# Pi-Mini Orchestrator — MCP + Provider Fallback + Worktree Isolation

**YOLO:** Yielding Ownership to Local Orchestrators

---

## 1. Architecture

```
Orchestrator (main agent)
  │
  ├─ Reads:  ~/.agents/mcp-settings.json        (global MCP server catalog)
  │          $(pwd)/.agents/mcp-settings.json    (project overrides)
  │          ~/.config/ainish-coder/providers.json  (provider definitions)
  │
  ├─ Decides: which sub-agent, which provider, which MCP servers, rotation position
  │
  ├─ Configures: Writes to ~/.claude.json or mini.yaml dynamically (PQC env keys)
  │
  ├─ Dispatches:  claude   -p "task" --no-session --thinking off
  │               mini     --task "task" --yolo
  │
  └─ Isolates:  git worktree per dispatch → merge back → verify → commit
```

Because custom CLI wrappers are removed, sub-agents are invoked directly via their native binaries (`claude` for Claude Code, `mini` for mini-swe-agent). The orchestrator dynamically manages native settings files at runtime to configure MCP servers and API keys.

---

## 2. Agent Pool — Fixed Rotation

```
claude → mini → claude → mini → (wrap around)
```

Two equal peers forming a tight loop. Every task flows through this fixed rotation:

| # | Agent | YOLO Command |
|---|-------|-------------|
| 1 | **claude** | `claude -p "prompt" --no-session --thinking off` |
| 2 | **mini** | `mini --config <temp_config> --task "prompt" --yolo` |

### Rotation Rules

1. **Fixed order**: Always dispatch claude → mini → claude → mini → ...
2. **claude is primary for complex reasoning** — research, audit, design, review
3. **mini is primary for execution** — fixes, tests, migrations, boilerplate generation
4. **Fallback on failure**: If one agent fails after exhausting providers, dispatch the other
5. **Wrap around**: After mini, restart from claude

---

## 3. Provider Fallback Chain

When a provider returns an error (rate limit, auth failure, timeout, model unavailable), retry with the next provider in the chain. **Always follow this exact order:**

```
Canonical fallback chain:
  modal → nvidia → nebius → opencode → zai → wafer-serverless → openrouter → zenmux
```

Never skip or reorder. Each provider failure increments to the next in the chain. After zenmux is exhausted, fall back to the other agent (claude→mini or mini→claude) and restart the chain.

---

## 4. MCP Server Catalog

Pulled live from `~/.agents/mcp-settings.json` + `$(pwd)/.agents/mcp-settings.json` at dispatch time. Project settings override global for the same server name.

| Server | Command | Requires | Best For |
|--------|---------|----------|----------|
| `tavily-search` | `npx -y tavily-mcp` | `TAVILY_API_KEY` | Web search, current events, docs lookup |
| `context7` | `npx -y @anthropic-ai/context7-mcp` | — | Up-to-date library/package documentation |
| `brave-search` | `npx -y @anthropic-ai/brave-search-mcp` | `BRAVE_API_KEY` | Web + local search |
| `github` | `npx -y @anthropic-ai/github-mcp` | `GITHUB_TOKEN` | PRs, issues, repo management, code search |
| `postgres` | `npx -y @anthropic-ai/postgres-mcp` | `DATABASE_URL` | Database queries, schema inspection |
| `filesystem` | `npx -y @anthropic-ai/filesystem-mcp` | — | Scoped file reads/writes, directory traversal |
| `puppeteer` | `npx -y @anthropic-ai/puppeteer-mcp` | — | Headless browser automation, screenshots |
| `memory` | `npx -y @anthropic-ai/memory-mcp` | — | Persistent knowledge graph, cross-task memory |
| `gitnexus` | `gitnexus mcp` | — | Local git intelligence, repo analysis, commit forensics |

### MCP-to-Task Mapping

| Task Type | Recommended MCP Servers | Preferred Agent |
|-----------|------------------------|-----------------|
| Bug fix (code only) | `filesystem` (if scoped), or none | mini |
| Bug fix (needs context) | `tavily-search`, `context7` | claude |
| Security audit | `github`, `tavily-search`, `gitnexus` | claude |
| PR review | `github`, `gitnexus` | claude |
| Web scraping / QA | `puppeteer`, `brave-search` | claude |
| Database migration | `postgres` | mini |
| Research-heavy feature | `tavily-search`, `context7`, `memory` | claude |
| Full-stack feature | `github`, `postgres`, `tavily-search` | claude (design), mini (build) |
| Cross-task project | `memory`, `github`, `filesystem` | claude |
| Git history / blame / diff | `gitnexus` | claude |
| Unit/integration tests | `filesystem` | mini |
| Boilerplate generation | none | mini |
| Refactoring | `filesystem`, `context7` | claude |

---

## 5. Dynamic Configuration & Dispatch

To configure MCP servers and API keys without wrapper scripts, the orchestrator writes configurations dynamically right before launching the sub-agent, and cleans up using `trap` structures.

### Claude Code Dynamic Dispatch

To run `claude` with specific MCP servers:

```bash
run_claude_with_mcp() {
  local prompt="$1"
  local mcp_config_path="$HOME/.claude.json"
  
  # Back up existing config
  local backup=""
  if [[ -f "$mcp_config_path" ]]; then
    backup=$(cat "$mcp_config_path")
  fi
  
  # Ensure cleanup on exit
  trap 'if [[ -n "$backup" ]]; then echo "$backup" > "$mcp_config_path"; else rm -f "$mcp_config_path"; fi' EXIT
  
  # Generate temporary ~/.claude.json containing only allowed MCP servers
  cat > "$mcp_config_path" <<EOF
{
  "mcpServers": {
    "tavily-search": {
      "command": "npx",
      "args": ["-y", "tavily-mcp"],
      "env": {
        "TAVILY_API_KEY": "${TAVILY_API_KEY}"
      }
    }
  }
}
EOF

  # Run Claude Code directly (ensure secrets are in environment)
  claude -p "$prompt" --no-session --thinking off
}
```

### mini-swe-agent Dynamic Dispatch

To run `mini` with a specific configuration file:

```bash
run_mini_with_config() {
  local task="$1"
  local temp_yaml
  temp_yaml=$(mktemp /tmp/mini-config.XXXXXX.yaml)
  trap 'rm -f "$temp_yaml"' EXIT
  
  # Generate custom configuration incorporating current provider and MCP settings
  cat > "$temp_yaml" <<EOF
model: "deepseek/deepseek-v4-flash"
api_key: "${OPENROUTER_API_KEY}"
mcp_servers:
  tavily-search:
    command: "npx"
    args: ["-y", "tavily-mcp"]
    env:
      TAVILY_API_KEY: "${TAVILY_API_KEY}"
EOF

  # Run mini directly pointing to the config
  mini --config "$temp_yaml" --task "$task" --yolo
}
```

---

## 6. Worktree Orchestration

Each dispatch gets its own **git worktree**. The orchestrator merges results. This prevents concurrent agents from creating conflicts.

### Pattern

```
Orchestrator (main agent)
  ├── git worktree add ../task-1-claude branch-task-1
  │     └── (write ~/.claude.json) && claude -p "Implement feature X" --no-session --thinking off
  ├── git worktree add ../task-2-mini branch-task-2
  │     └── mini --config temp.yaml --task "Write migration for Y" --yolo
  ├── review each worktree's changes
  └── merge worktrees back → verify → commit → clean up
```

### Rules

- **One worktree per dispatch** — never let two agents write to the same tree
- **Main agent merges** — sub-agents never merge their own work
- **Verify before merge** — the orchestrator reviews and tests all sub-agent output
- **Clean up worktrees** after merge (`git worktree remove`)

---

## 7. State Management

```yaml
rotation:
  agents: ["claude", "mini"]
  pointer: 0          # current position in the rotation
  last_agent: null    # tracks which agent was last dispatched
  last_provider: null # tracks which provider last succeeded

dispatch_history:
  - task: "security audit"
    agent: claude
    provider: modal
    mcp: [tavily-search, github, gitnexus]
    result: success
    worktree: feature/security-audit
```

---

## 8. Operational Rules

- **MCP servers are scoped per dispatch** — sub-agents only get the tools they need for the task, never all servers by default
- **Fallback is automatic** — never ask the operator to retry; rotate providers yourself, then agents
- **Rate limit cooldown**: 2 seconds between provider attempts
- **Abort threshold**: Give up after both agents have exhausted all 8 providers (16 total attempts)
- **Provider timeout**: 5 minutes per provider attempt
- **Worktree discipline**: One sub-agent = one worktree. Clean up after merge.
- **Secrets from environment only**: API keys come from `secrets-load` (PQC bundle), never hardcoded on disk.
