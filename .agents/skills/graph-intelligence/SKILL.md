---
name: graph-intelligence
description: >
  Enterprise-grade codebase intelligence via a TWO-LAYER knowledge graph. Use
  GitNexus (MCP-native, AST-precise, call-graph aware) as the always-on
  operational layer for code call-chains, blast-radius, and rename. Use Graphify
  (multimodal, code+docs+papers+video+image) as the on-demand semantic enrichment
  layer for cross-document reasoning, PR triage, and visual deliverables. Trigger
  on: "how does X work", "what calls Y", "what breaks if I change Z", "show me
  the architecture", "ingest this paper/RFC", "triage my PRs", "client briefing",
  "merge-order risk", "find dead code", "explain this symbol", "find god nodes",
  or any codebase question. Skips guessing, fast-paths through cached graphs.
version: 2.0.0
---

# Graph Intelligence — Expert Edition

Two complementary knowledge-graph tools, used together as a two-layer
architecture. This is the **expert-level** skill: it covers the complete
tool surfaces (not the 60% subset), the version-pinned semantics, the
failure-mode runbook, and the cross-tool integration patterns that turn
two utilities into a system.

> **Always read `llms.txt` first** in any target repo — it is the
> authoritative PRD anchor. The patterns below assume you have done so.

---

## Table of Contents

- [§0 Mental Model](#0-mental-model)
- [§1 GitNexus — Complete Tool Inventory](#1-gitnexus--complete-tool-inventory)
- [§2 Graphify — Complete Tool Inventory](#2-graphify--complete-tool-inventory)
- [§3 Decision Matrix — Which Tool, Which Mode](#3-decision-matrix)
- [§4 Core Workflow Modes](#4-core-workflow-modes)
- [§5 Pre-Edit Safety Protocol](#5-pre-edit-safety-protocol)
- [§6 Cross-Repo & Group Recipes](#6-cross-repo--group-recipes)
- [§7 Multimodal & Non-Code Recipes](#7-multimodal--non-code-recipes)
- [§8 Embeddings, Performance & Tuning](#8-embeddings-performance--tuning)
- [§9 Confidence, Uncertainty & Honesty](#9-confidence-uncertainty--honesty)
- [§10 Failure Modes & Recovery Runbook](#10-failure-modes--recovery-runbook)
- [§11 Anti-Patterns — What NOT to Do](#11-anti-patterns)
- [§12 References & Version Pin](#12-references--version-pin)
- [§13 Provider Integration — PQC + providers.txt](#13-provider-integration--pqc--providerstxt)
- [Appendix A — One-Page Cheat Sheet](#appendix-a--one-page-cheat-sheet)

---

## §0 Mental Model

Both tools build knowledge graphs. The differences that matter for choosing
between them:

| Property | GitNexus | Graphify |
|---|---|---|
| **What it graphs** | Code only (AST-derived) | Code + docs + papers + PDFs + images + video + audio + URLs + MCP configs |
| **Primary language** | TypeScript (CLI + MCP), Python (eval) | Python (CLI + library) |
| **Storage** | LadybugDB native (was KuzuDB) under `.gitnexus/`; registry at `~/.gitnexus/registry.json` | NetworkX in-memory + `graphify-out/` on disk (graph.json, graph.html, GRAPH_REPORT.md); global at `~/.graphify/global.json` |
| **Interface to agents** | MCP stdio (one server, all repos) **or** CLI direct | Slash command `/graphify` **or** MCP stdio (`python -m graphify.serve`) **or** CLI direct |
| **AST precision** | 14 languages via tree-sitter, language-aware heritage/imports/constructor inference, MRO | tree-sitter for 33+ languages; **no** cross-file call resolution, **no** MRO |
| **Embeddings** | Optional `--embeddings` (HuggingFace transformers.js, 50k-node cap) | None — relies on BM25 + community name lookup |
| **Clustering** | Leiden algorithm in `communities` phase → `Community` nodes w/ `heuristicLabel` | Leiden in `cluster.py`; community naming by LLM at `cluster-only`/`label` time |
| **Pre-structured tools** | Yes — every tool returns typed objects (callers w/ confidence, d=N groups, risk levels) | No — most queries are BFS/DFS traversals w/ token budgets |
| **Speed** | ~4s cold index, <400ms query (in-memory) | ~12s `extract` cold, sub-second `query` against cached graph |
| **Determinism** | Stable IDs from qualified name + file + line | Deterministic since 0.8.27 (community ID total order, file traversal sorted) |
| **Confidence** | Numeric `confidence` (0.0–1.0) on every edge | Categorical `EXTRACTED` / `INFERRED` / `AMBIGUOUS` per edge |
| **LLM cost** | Zero at index time; optional LLM only for `--skills` (community-named skill files) and `wiki` | LLM required for docs/papers/images/video/cluster-naming; tree-sitter only for code |
| **Multi-repo** | Native — `~/.gitnexus/registry.json`, `@<group>` routing, `gitnexus://group/{name}/{contracts,status}` resources | Manual — `graphify merge-graphs a.json b.json` or `global add` |
| **PR/issue awareness** | None (purely structural) | `graphify prs [--triage] [--conflicts] [--worktrees]` (PR dashboard) |

**Rule of thumb:**
- Code questions about a function/symbol/class → **GitNexus first**.
- Questions that span code + docs, or involve non-code artifacts → **Graphify**.
- When in doubt, **run both in parallel** — they have orthogonal blind spots.

---

## §1 GitNexus — Complete Tool Inventory

GitNexus exposes **15 MCP tools, 6 resources, 2 prompts, 4 base skills, plus
N generated skills** per repo. Every tool appends a "next step" hint to its
response so the agent self-guides through the workflow.

### 1.1 MCP Tools (15)

Group-aware tools (`query`, `context`, `impact`, `cypher`) accept
`repo: "@<groupName>"` or `repo: "@<groupName>/<memberPath>"` to operate
across the multi-repo contract bridge.

| # | Tool | Purpose | Key Parameters |
|---|---|---|---|
| 1 | `list_repos` | Discover all indexed repos w/ staleness hints | — |
| 2 | `query` | Hybrid BM25 + semantic + RRF search; returns **processes**, **process_symbols**, **definitions** | `query`, `repo?`, `limit?` (default 10) |
| 3 | `context` | 360° symbol view: incoming/outgoing `calls`, `imports`, `accesses`, processes | `name`, `repo?`, `file_path?`, `kind?`, `uid?` |
| 4 | `impact` | Blast radius (upstream/downstream) w/ risk, depth grouping, confidence | `target`, `direction` (upstream/downstream), `maxDepth?`, `minConfidence?`, `relationTypes?` (CALLS/IMPORTS/EXTENDS/IMPLEMENTS), `includeTests?`, `limit?`, `offset?`, `summaryOnly?` |
| 5 | `cypher` | Raw Cypher against the LadybugDB-backed graph; use `gitnexus://repo/{name}/schema` for types | `query`, `repo?` |
| 6 | `detect_changes` | Git-diff-aware: maps changed lines to affected symbols & processes | `repo?`, `scope?` (unstaged/staged/all/compare), `base_ref?` |
| 7 | `rename` | Multi-file coordinated rename (graph + text-search, both confidence-tagged) | `symbol_name`, `new_name`, `file_path?`, `dry_run?` (default true) |
| 8 | `route_map` | API route → handler → consumer mapping | `route?`, `repo?` |
| 9 | `tool_map` | MCP/RPC tool definitions & handler file paths | `tool?`, `repo?` |
| 10 | `shape_check` | Response-shape vs consumer-property-access mismatch detection | `route?`, `repo?` |
| 11 | `api_impact` | Pre-change impact for an API route handler (combines route_map + shape_check + impact) | `route` or `file`, `repo?` |
| 12 | `group_list` | List groups, or show one group's repos | `name?` |
| 13 | `group_sync` | Rebuild Contract Registry (`contracts.json`) for cross-repo routes/handlers | `name` |

> **Removed in 1.5.0:** `group_query`, `group_contracts`, `group_status` MCP
> tools. Use `repo: "@<groupName>"` on `query`/`context`/`impact`/`cypher`
> and read the `gitnexus://group/{name}/contracts` and
> `gitnexus://group/{name}/status` **resources** instead.

### 1.2 Resources (8 templates / 2 static)

Resources are read-only, on-demand, and use `gitnexus://` URI scheme. Read
them **before** a heavy tool call — they cost almost nothing and often
disambiguate.

| URI | Purpose |
|---|---|
| `gitnexus://repos` | All indexed repos w/ stats + staleness — **read first** |
| `gitnexus://setup` | Concatenated AGENTS.md content for all indexed repos (onboarding) |
| `gitnexus://repo/{name}/context` | Repo overview: file count, symbols, edges, clusters, processes, tools available, staleness |
| `gitnexus://repo/{name}/clusters` | All Leiden communities w/ cohesion & keyword tags |
| `gitnexus://repo/{name}/cluster/{clusterName}` | Members + cohesion detail of one cluster |
| `gitnexus://repo/{name}/processes` | All execution flows, ranked |
| `gitnexus://repo/{name}/process/{processName}` | Step-by-step trace w/ file:line per step |
| `gitnexus://repo/{name}/schema` | Node/edge schema for Cypher (use before `cypher`) |
| `gitnexus://group/{name}/contracts` | Contract Registry rows (provider/consumer); query params: `type`, `repo`, `unmatchedOnly` |
| `gitnexus://group/{name}/status` | Per-member index + contract-registry staleness |

### 1.3 Prompts (2)

MCP prompts are guided multi-step recipes the host can call.

| Prompt | Arguments | What it does |
|---|---|---|
| `detect_impact` | `scope?` (unstaged/staged/all/compare), `base_ref?` | Pre-commit change analysis — pick scope, detect, review affected processes, assess risk, surface HIGH/CRITICAL warnings |
| `generate_map` | `repo?` | Architecture doc generation: reads clusters + processes, emits a Mermaid module/flow diagram with cross-references |

### 1.4 Skills (4 base + N generated per repo)

Installed automatically to `.claude/skills/gitnexus/`:

- **Exploring** — navigate unfamiliar code
- **Debugging** — trace bugs through call chains
- **Impact Analysis** — blast radius before changes
- **Refactoring** — safe rename / extract / split

Plus **N generated skills** under `.claude/skills/generated/` (one per
Leiden community) when you run `gitnexus analyze --skills`. Each generated
skill describes a module's key files, entry points, execution flows, and
cross-area connections — so the agent gets targeted context for the exact
area being worked in. Regenerate on every `--skills` run to stay current.

### 1.5 CLI Commands

```bash
gitnexus setup                    # one-time: writes MCP config for all detected editors
gitnexus analyze [path]           # index a repo (or update stale)
gitnexus analyze --repair-fts     # rebuild FTS only (fast incremental)
gitnexus analyze --force          # full re-parse + graph + FTS rebuild
gitnexus analyze --skills         # generate per-cluster skill files
gitnexus analyze --skip-embeddings    # faster; skip semantic vectors
gitnexus analyze --embeddings [n] # generate embeddings (default cap: 50,000 nodes; 0 = unlimited)
gitnexus analyze --skip-agents-md     # preserve hand-edits in gitnexus:start block
gitnexus analyze --skip-git           # index non-git directories
gitnexus analyze --max-file-size KB   # raise per-file parse cap (default 512, hard max 32768)
gitnexus analyze --workers N          # parse worker pool size (default cores-1, capped 16; 0 = sequential)
gitnexus analyze --worker-timeout 60  # slow-file grace (seconds)
gitnexus analyze --wal-checkpoint-threshold 67108864  # LadybugDB WAL auto-checkpoint (bytes); -1 keeps default
gitnexus analyze --verbose        # log skipped files, per-chunk throughput

gitnexus mcp                      # start MCP server (stdio) — serves all indexed repos
gitnexus serve                    # start local HTTP server (port 4747) for web UI bridge
gitnexus list                     # list indexed repos
gitnexus status                   # current repo index status
gitnexus clean                    # delete current repo's index (prompts)
gitnexus clean --force            # skip confirmation
gitnexus clean --all --force      # delete all

gitnexus wiki [path]              # generate LLM-powered wiki from graph
gitnexus wiki --model <m>         # custom model (default gpt-4o-mini)
gitnexus wiki --base-url <url>    # custom LLM endpoint
gitnexus wiki --force             # force full regen
gitnexus wiki --timeout <s>       # per-request LLM timeout (default: disabled)
gitnexus wiki --retries <n>       # retry budget (default 3)
gitnexus wiki --lang <lang>       # output language

gitnexus publish                  # opt-in: notify understand-quickly registry
                                  # (no-op without UNDERSTAND_QUICKLY_TOKEN)

# Repository groups
gitnexus group create <name>                                          # create a group
gitnexus group add    <group> <groupPath> <registryName>             # add repo by hierarchy path
gitnexus group remove <group> <groupPath>                            # remove
gitnexus group list   [name]                                          # list groups or show one
gitnexus group sync   <name>                                          # rebuild contracts.json + bridge graph
# NOTE: group_query / group_contracts / group_status MCP tools were REMOVED in 1.5.0.
# Use repo:"@<group>" on query/context/impact/cypher and read the resources instead.
```

### 1.6 Environment Variables

CLI flags take precedence over env vars; env vars take precedence over
defaults. Use env vars for long-running hosts (MCP server, eval-server, CI).

| Var | Default | Effect |
|---|---|---|
| `GITNEXUS_WORKER_POOL_SIZE` | `cores-1` (cap 16) | Parse pool; `0` = sequential fallback. Equivalent to `--workers`. |
| `GITNEXUS_PARSE_CHUNK_CONCURRENCY` | `2` | Concurrent chunk reads while pool dispatches. |
| `GITNEXUS_VERBOSE` | unset | Skipped-file logs, per-chunk throughput. |
| `GITNEXUS_PROFILE_DEFERRED` | unset | `[deferred-profile]` logs for post-chunk resolution. Implied by `GITNEXUS_VERBOSE`. |
| `GITNEXUS_PROFILE_DEFERRED_SLOW_MS` | `3000` (verbose) / `5000` | Per-file slow-threshold for deferred resolution logs. |
| `GITNEXUS_MAX_FILE_SIZE` | `512` (KB) | Walker skip threshold. Hard cap `32768`. |
| `GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS` | `30000` | Per-job idle timeout. Equivalent to `--worker-timeout` × 1000. |
| `GITNEXUS_WAL_CHECKPOINT_THRESHOLD` | `67108864` (64 MiB) | LadybugDB WAL auto-checkpoint. `-1` keeps default. |
| `GITNEXUS_WORKER_SUB_BATCH_MAX_BYTES` | `8388608` (8 MB) | Per-job byte budget. Bump with caution. |
| `GITNEXUS_WORKER_MAX_RESPAWNS_PER_SLOT` | `3` | Max replacements per slot before dropping. |
| `GITNEXUS_WORKER_MAX_CUMULATIVE_TIMEOUT_MS` | `5 × subBatchTimeoutMs` | Total retry budget per job. |
| `GITNEXUS_WORKER_CONSECUTIVE_FAILURE_THRESHOLD` | `max(3, poolSize)` | Circuit breaker. |
| `GITNEXUS_CHUNK_BYTE_BUDGET` | `2097152` (2 MB) | Chunk boundary for cache-key composition. |
| `GITNEXUS_NO_GITIGNORE` | unset | Skip `.gitignore` parsing; `.gitnexusignore` still honored. |
| `GITNEXUS_SKIP_OPTIONAL_GRAMMARS` | `=1` strict | Skip dart/proto/swift grammar build. |

### 1.7 Editor Support

| Editor | MCP | Skills | Hooks | Notes |
|---|---|---|---|---|
| **Claude Code** | ✓ | ✓ | PreToolUse + PostToolUse (full) | Deepest integration |
| **Cursor** | ✓ | ✓ | postToolUse (manual install) | See `gitnexus-cursor-integration` |
| **Antigravity** (Google) | ✓ | ✓ | AfterTool (Gemini CLI hooks schema) | Augments via `hookSpecificOutput.additionalContext` |
| **Codex** | ✓ | ✓ | — | MCP + Skills only |
| **Windsurf** | ✓ | — | — | MCP only |
| **OpenCode** | ✓ | ✓ | — | MCP + Skills |

### 1.8 Supported Languages (14)

| Language | Imports | Named Bindings | Exports | Heritage | Type Annot | Ctor Inference | Config | Frameworks | Entry |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| TypeScript | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| JavaScript | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| Python | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Java | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| **Kotlin** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| C# | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Go | ✓ | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Rust | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| PHP | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | ✓ | ✓ |
| Ruby | ✓ | — | ✓ | ✓ | — | ✓ | — | ✓ | ✓ |
| Swift | — | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| C | — | — | ✓ | — | ✓ | ✓ | — | ✓ | ✓ |
| C++ | — | — | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| Dart | ✓ | — | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ |

**Migration status** (RFC #909 Ring 3, scope-resolution pipeline):
- **Migrated to registry-primary call resolution** (uses scope-resolution
  pipeline in parallel with legacy DAG; CI parity gate enforced):
  Python, C#, Kotlin, TypeScript.
- Unmigrated languages still use the legacy 6-stage Call-Resolution DAG
  (`extract-call → classify-form → infer-receiver → select-dispatch →
  resolve-target → emit-edge`).

### 1.9 Architecture (12-Phase Pipeline DAG)

```
scan → structure → [markdown, cobol] → parse → [routes, tools, orm]
  → crossFile → mro → communities → processes
```

Phases defined in `gitnexus/src/core/ingestion/pipeline-phases/`. Runner
is a static DAG (compile-time type safety) using Kahn's topological sort;
cycles and missing deps are rejected at validation with a concrete trace.
Each phase mutates the single `KnowledgeGraph` accumulator and produces
typed output in `PhaseResult`. **Skippable phases**: `skipGraphPhases`
omits MRO/communities/processes (faster tests); `skipWorkers` forces
sequential parsing.

### 1.10 Storage Layout

```
~/.gitnexus/registry.json              # global registry: {name, path, lastCommit}
<repo>/.gitnexus/                      # per-repo index (gitignored)
├── lbug/                              # LadybugDB native store
├── meta.json                          # stats.embeddings, lastCommit, etc.
└── run.cjs                            # local runner (auto-selected)
```

LadybugDB connections open **lazily** on first query and evict after 5
minutes of inactivity (max 5 concurrent). If only one repo is indexed,
the `repo` parameter is optional on all tools.

---

## §2 Graphify — Complete Tool Inventory

Graphify has **10 MCP tools, ~30 CLI commands, 22+ supported editor
platforms**, and produces five output formats from one source corpus.

### 2.1 MCP Tools (10)

Exposed via `python -m graphify.serve graphify-out/graph.json` (stdio)
or auto-installed by `graphify install` on supporting platforms.

| # | Tool | Purpose | Key Arguments |
|---|---|---|---|
| 1 | `query_graph` | BFS/DFS traversal with budget; returns subgraph | `question`, `dfs?`, `budget?` |
| 2 | `get_node` | Full metadata for one node | `node_id` |
| 3 | `get_neighbors` | Adjacent nodes + edge types | `node_id`, `depth?` |
| 4 | `get_community` | Members + summary for a community | `community_id` |
| 5 | `god_nodes` | High-degree hubs (risk concentrators) | `top_n?` |
| 6 | `graph_stats` | Counts: nodes, edges, communities, types | — |
| 7 | `shortest_path` | Path between two concepts | `source`, `target` |
| 8 | `list_prs` | PR dashboard (CI, review, worktree, graph impact) | `pr_number?`, `triage?`, `conflicts?`, `worktrees?`, `base?`, `repo?` |
| 9 | `get_pr_impact` | Deep dive on a single PR's graph impact | `pr_number`, `repo?` |
| 10 | `triage_prs` | AI-ranked review queue (auto-detects backend) | `repo?`, `model?` |

### 2.2 CLI Commands

#### Build / extract
```bash
graphify update .                          # re-extract + cluster (LLM needed for naming)
graphify update . --no-cluster             # fast: code-only AST extraction, no LLM
graphify update . --force                  # overwrite even if rebuild has fewer nodes
graphify update . --watch                  # auto-rebuild on file change
graphify update . --mode deep              # richer INFERRED edges via extended prompt
graphify update . --skip-llm               # same as --no-cluster but explicit

graphify extract ./docs                    # headless LLM extraction (CI, no IDE)
graphify extract ./docs --backend gemini   # explicit backend
graphify extract ./docs --backend kimi
graphify extract ./docs --backend claude
graphify extract ./docs --backend openai
graphify extract ./docs --backend deepseek
graphify extract ./docs --backend ollama   # local — set OLLAMA_BASE_URL / OLLAMA_MODEL
graphify extract ./docs --backend bedrock  # AWS Bedrock via IAM (no API key)
graphify extract ./docs --backend claude-cli  # route through Claude Code CLI (no API key)
graphify extract ./docs --model gemini-3.1-pro-preview
graphify extract ./docs --token-budget 30000   # smaller chunks for local models
graphify extract ./docs --max-concurrency 2    # fewer parallel LLM calls
graphify extract ./docs --api-timeout 900      # longer HTTP timeout (default 600s)
graphify extract ./docs --max-workers 16       # AST parallelism (alias GRAPHIFY_MAX_WORKERS)
graphify extract ./docs --google-workspace     # export .gdoc/.gsheet/.gslides via gws first
graphify extract ./docs --force                # overwrite graph.json even with fewer nodes
graphify extract ./docs --dedup-llm            # LLM tiebreaker for ambiguous entity pairs
graphify extract ./docs --global --as myrepo   # register into cross-project global graph
GRAPHIFY_MAX_OUTPUT_TOKENS=32768 graphify extract ./docs --backend claude
```

#### Query / navigate
```bash
graphify query "<question>"                     # BFS — broad context
graphify query "..." --dfs --budget 1500        # DFS — trace a specific path
graphify query "..." --graph path/to/graph.json # custom graph location
graphify path "A" "B"                           # shortest path between concepts
graphify explain "RateLimiter"                  # plain-language node explanation
graphify diagnose multigraph                    # edge-collapse diagnostic
```

#### Cluster management
```bash
graphify cluster-only ./my-project                          # recluster existing graph
graphify cluster-only ./my-project --resolution 1.5         # more, smaller communities
graphify cluster-only ./my-project --exclude-hubs 99        # suppress p99-degree utility hubs
graphify cluster-only ./my-project --no-label               # keep "Community N" placeholders
graphify cluster-only ./my-project --backend=gemini         # backend for community naming
graphify label         ./my-project                         # (re)name communities on demand
graphify label         ./my-project --backend=openai        # force a specific backend
```

#### Ingest
```bash
graphify add https://arxiv.org/abs/1706.03762       # fetch a paper and add it
graphify add <youtube-url>                          # transcribe + add a video
graphify add <url> --author "Name"                  # tag author
graphify add <url> --contributor "Name"             # tag contributor
graphify add <url> --google-workspace               # auth via gws for .gdoc/.gsheet/.gslides
```

#### Export
```bash
graphify export callflow-html                              # Mermaid architecture/call-flow HTML
graphify export callflow-html --max-sections 8             # cap architecture sections
graphify export callflow-html --output docs/arch.html
graphify export callflow-html ./some-repo/graphify-out     # custom input dir

# Inferred export flags (subset of `/graphify` slash command):
# --svg      graphify-out/graph.svg (embeds in Notion, GitHub)
# --graphml  graphify-out/graph.graphml (Gephi, yEd)
# --neo4j    graphify-out/cypher.txt (Neo4j)
# --neo4j-push bolt://localhost:7687   push directly to Neo4j
# --obsidian vault (optional --obsidian-dir)
# --wiki     markdown wiki (index.md + one article per community)
# --no-viz   skip graph.html
```

#### PR dashboard
```bash
graphify prs                       # dashboard: CI, review, worktree, graph impact
graphify prs 42                    # deep dive on PR #42
graphify prs --triage              # AI ranks review queue (auto-detects backend)
graphify prs --worktrees           # worktree → branch → PR mapping
graphify prs --conflicts           # PRs sharing graph communities (merge-order risk)
graphify prs --base main           # filter to PRs targeting a base branch
graphify prs --repo owner/repo     # different GitHub repo
GRAPHIFY_TRIAGE_BACKEND=kimi graphify prs --triage
GRAPHIFY_TRIAGE_MODEL=claude-opus-4-7 graphify prs --triage
```

#### Cross-project / global
```bash
graphify global add  graphify-out/graph.json myrepo   # register into ~/.graphify/global.json
graphify global remove myrepo
graphify global list                                  # all registered repos + counts
graphify global path                                  # print path to global graph file
graphify merge-graphs a.json b.json --out merged.json # one-shot merge
```

#### Hooks / install / misc
```bash
graphify hook install        # post-commit + post-checkout hooks + git merge driver
graphify hook uninstall
graphify hook status

graphify install             # install skill to current platform (auto-detect)
graphify install --project   # project-scoped install
graphify install --platform <name>  # explicit: claude|codex|opencode|kilo|copilot|...
graphify install --platform antigravity --project

graphify uninstall
graphify uninstall --purge   # also delete graphify-out/

# Per-platform always-on install:
graphify claude install      # PreToolUse hook + CLAUDE.md (also nudges Read/Glob)
graphify codex install       # AGENTS.md + .codex/hooks.json PreToolUse
graphify opencode install    # AGENTS.md + .opencode/plugin
graphify kilo install        # .kilo native skill + /graphify command + plugin
graphify cursor install      # .cursor/rules/graphify.mdc w/ alwaysApply:true
graphify gemini install      # GEMINI.md + BeforeTool hook
graphify copilot install
graphify aider install
graphify claw install
graphify droid install
graphify trae install
graphify trae-cn install
graphify hermes install
graphify amp install
graphify kiro install
graphify pi install
graphify devin install
graphify antigravity install
graphify vscode install
graphify kiro install

# Discovery / setup helpers:
graphify clone https://github.com/<owner>/<repo> [--branch <b>]   # clone + prep
graphify --version
graphify check-update ./src    # check for new graphify release
```

### 2.3 Supported File Types (50+)

| Type | Extensions | Backend |
|---|---|---|
| Code (33 langs) | `.py .ts .tsx .js .jsx .mjs .cjs .go .rs .java .c .cpp .h .hpp .rb .cs .kt .scala .php .swift .lua .luau .zig .ps1 .ex .exs .m .mm .jl .vue .svelte .astro .groovy .gradle .dart .v .sv .svh .sql .f .f90 .f95 .f03 .f08 .pas .pp .dpr .dpk .lpr .inc .dfm .lfm .lpk .sh .bash .json .dm .dme .dmi .dmm .dmf .sln .csproj .fsproj .vbproj .razor .cshtml` | tree-sitter (local, no API) |
| MCP configs | `.mcp.json` `mcp.json` `mcp_servers.json` `claude_desktop_config.json` | regex parser |
| Docs | `.md .mdx .qmd .html .txt .rst .yaml .yml` | LLM |
| Office | `.docx .xlsx` | `graphifyy[office]` |
| Google Workspace | `.gdoc .gsheet .gslides` (opt-in; `.gsheet` needs `graphifyy[google]`) | LLM (via `gws` auth) |
| PDFs | `.pdf` | LLM |
| Images | `.png .jpg .webp .gif` | LLM |
| Video / Audio | `.mp4 .mov .mp3 .wav` + more | `graphifyy[video]` (faster-whisper local) |
| YouTube / URLs | any video URL | `graphifyy[video]` |

### 2.4 Output Layout

```
graphify-out/
├── graph.html                       # interactive visualization (sigma.js / graphology)
├── graph.json                       # persistent graph (the source of truth)
├── graph.svg                        # optional: embeds in Notion/GitHub
├── graph.graphml                    # optional: Gephi / yEd
├── cypher.txt                       # optional: Neo4j bulk import
├── GRAPH_REPORT.md                  # god nodes, surprises, suggested questions
├── obsidian/                        # optional: vault (one .md per node)
├── wiki/                            # optional: --wiki (index.md + one article per community)
├── <project>-callflow.html          # graphify export callflow-html output
├── manifest.json                    # mtime-based; .gitignore
├── cost.json                        # local only; .gitignore
├── .graphify_python                 # pinned interpreter path
├── .graphify_root                   # scan root
├── .graphify_detect.json            # last detect() output
├── .graphify_ast.json               # last AST extraction
├── .graphify_cached.json            # last semantic cache hit
├── .graphify_uncached.txt           # last semantic cache miss
├── .graphify_labels.json            # last community labels
└── cache/                           # SHA256 file content cache (commit for speed)
```

**Recommended `.gitignore` additions:**
```
graphify-out/manifest.json    # mtime-based, breaks after clone
graphify-out/cost.json        # local only
# graphify-out/cache/         # optional: commit for speed, skip to keep repo small
```

**Team setup workflow:**
1. One person runs `/graphify .` and commits `graphify-out/` (sans
   `manifest.json` and `cost.json`).
2. Everyone pulls — their assistant reads the graph immediately.
3. `graphify hook install` to auto-rebuild on commit (AST only, no API
   cost) **and** register a git merge driver so `graph.json` union-merges
   automatically — two devs committing in parallel never get conflict
   markers.
4. Run `/graphify --update` to refresh docs/papers nodes.

### 2.5 Confidence Labels

Every edge in `graph.json` carries one of:

| Label | Meaning | Example |
|---|---|---|
| `EXTRACTED` | Explicitly stated in source | `import x from 'y'`, direct call in AST |
| `INFERRED` | Reasonable deduction | Call-graph 2nd pass, co-occurrence in context, LLM inferred |
| `AMBIGUOUS` | Uncertain; flagged for review | Surprising connections, dedup-uncertain pairs |

Surfaced in `GRAPH_REPORT.md` as a filterable list.

### 2.6 Query Logging

Every `graphify query`, `graphify path`, `graphify explain`, and MCP
`query_graph` call is appended to `~/.cache/graphify-queries.log` in
JSON Lines (timestamp, kind, question, corpus path, nodes returned,
result size, duration). **Full responses are not stored by default.**

| Env var | Effect |
|---|---|
| `GRAPHIFY_QUERY_LOG` | Override log path (empty or `/dev/null` silences without disabling code path) |
| `GRAPHIFY_QUERY_LOG_DISABLE=1` | Opt out completely |
| `GRAPHIFY_QUERY_LOG_RESPONSES=1` | Also log full subgraph responses (off by default) |

### 2.7 Privacy & Data Residency

- **Code files** — processed locally via tree-sitter. Nothing leaves your machine.
- **Video / audio** — transcribed locally with faster-whisper. Nothing leaves your machine.
- **Docs, PDFs, images, semantic extraction** — sent to whatever model your
  IDE session runs (when using `/graphify`); or to the explicit backend
  when using `graphify extract` headless.

Backend auto-detect priority: **Gemini → Kimi → Claude → OpenAI →
DeepSeek → Bedrock → Ollama** (built-ins), then custom OpenAI-compatible
endpoints in `~/.graphify/providers.json`. To pin, pass `--backend`.

**For data-residency requirements** use `--backend ollama` (fully local)
or `--backend bedrock` (AWS IAM, no API key). Kimi (`MOONSHOT_API_KEY`)
routes to Moonshot AI servers in China — caveat for non-PRC projects.

**Security (since 0.8.29):**
- Project-local `./.graphify/providers.json` is **not** auto-loaded
  (travels with cloned repos — opt in with `GRAPHIFY_ALLOW_LOCAL_PROVIDERS=1`).
- Non-http(s) `base_url`s rejected on load and on `provider add`.
- Plaintext-http egress warns.
- Office/PDF files screened: size cap + bounded zip-decompression ceiling.
- `OLLAMA_BASE_URL` pointing at link-local / cloud-metadata (169.254.x,
  metadata.google.*) fails closed. Trusted LAN hosts warn-and-allow.

### 2.8 Custom Provider Registry

```bash
graphify provider add    # register an OpenAI-compatible endpoint (NVIDIA NIM, vLLM, OpenRouter, Together, LiteLLM)
graphify provider list
graphify provider show <name>
graphify provider remove <name>
```

Stored at `~/.graphify/providers.json`. Auto-detected after built-ins in
the `detect_backend()` priority chain.

### 2.9 Cluster ID Stability (since 0.8.27)

Community IDs are assigned by a total order `(-size, sorted node IDs)`
so an identical grouping always gets identical IDs across runs.
`graph.json` is now deterministic across runs (file traversal sorted
lexicographically; first-writer-wins node-ID decisions reproducible).

---

## §3 Decision Matrix — Which Tool, Which Mode

| Scenario | Tool | Mode / Call |
|---|---|---|
| "Where is X defined?" | GitNexus | `query({query: "X", repo})` |
| "What calls X?" | GitNexus | `context({name: "X", repo})` |
| "What breaks if I change X?" | GitNexus | `impact({target: "X", direction: "upstream", repo})` |
| "What does X depend on (transitively)?" | GitNexus | `impact({target: "X", direction: "downstream", repo, maxDepth: 3})` |
| "Show me the call chain from Y → Z" | GitNexus | `cypher` on PROCESS nodes, or `context` recursively |
| "Is the index stale?" | GitNexus | `list_repos` (read `staleness.hint`) |
| "What changed since last commit?" | GitNexus | `detect_changes({repo, scope: "compare", base_ref: "main"})` |
| "Rename X everywhere safely" | GitNexus | `rename({symbol_name: "X", new_name: "Y", dry_run: true})` |
| "Show me the full architecture" | Graphify | `graphify update .` → `open graphify-out/graph.html` |
| "What connects auth to the database?" | Graphify | `graphify query "auth database connection"` |
| "Where do concept A and concept B meet?" | Graphify | `graphify path "A" "B"` |
| "Explain this symbol in plain language" | Graphify | `graphify explain "X"` |
| "Show me the call-flow diagram" | Graphify | `graphify export callflow-html` |
| "Ingest this paper / RFC / video / URL" | Graphify | `graphify add <url>` |
| "Open it in Obsidian" | Graphify | `graphify update . --obsidian` |
| "Build me a wiki" | Graphify | `graphify update . --wiki` |
| "Triage my review queue" | Graphify | `graphify prs --triage` |
| "Which PRs share communities? (merge-order risk)" | Graphify | `graphify prs --conflicts` |
| "Which worktrees are mapped to which PRs?" | Graphify | `graphify prs --worktrees` |
| "Auto-rebuild on commit" | Graphify | `graphify hook install` |
| "Cross-repo contract analysis" | GitNexus | `group_sync` + `gitnexus://group/{name}/contracts` resource |
| "Cross-repo knowledge graph" | Graphify | `graphify merge-graphs a.json b.json` or `graphify global add` |
| "Multi-service call trace" | GitNexus | `repo: "@<group>"` on `query`/`context`/`impact` |
| "What services depend on this API?" | GitNexus | `api_impact({route: "/api/x"})` |
| "Does this route's response shape match consumer expectations?" | GitNexus | `shape_check({route: "/api/x"})` |
| "What MCP tools does this codebase define?" | GitNexus | `tool_map({repo})` |
| "Anatomy of an API: route → handler → middleware" | GitNexus | `route_map({repo})` |
| "Production-readiness review of a PR" | Both | GitNexus `detect_changes` + Graphify `prs --conflicts` + `pr-swarm-review/orchestration.md` (7 lanes) |
| "Find god nodes (risk concentrators)" | Graphify | `graphify update .` then read `GRAPH_REPORT.md` "God Nodes" section, or MCP `god_nodes` |
| "Surprising cross-file connections" | Graphify | `GRAPH_REPORT.md` "Surprising Connections" section |
| "Suggested questions" | Graphify | `GRAPH_REPORT.md` "Suggested Questions" section |
| "Generate architecture doc w/ Mermaid" | GitNexus | `generate_map` MCP prompt |
| "Generate LLM wiki from graph" | GitNexus | `gitnexus wiki --model gpt-4o` |
| "Watch for file changes, rebuild" | Graphify | `graphify watch ./src` |

---

## §4 Core Workflow Modes

### Mode 1: Orient — Start Any Task

**Purpose:** Situational awareness before writing code.

```
STEP 1  gitnexus list                # or MCP list_repos — discover repos, check staleness
STEP 2  gitnexus analyze --index-only  # or just `gitnexus analyze`; <1s no-op if fresh
STEP 3  READ gitnexus://repo/{name}/context     # MCP resource: overview, tools available
STEP 4  READ gitnexus://repo/{name}/processes   # all execution flows, ranked
STEP 5  gitnexus MCP → query({query: "<task keywords>", repo, limit: 10})
STEP 6  (optional, if docs/papers present)
        graphify update . --no-cluster         # code-only fast extraction
        READ graphify-out/GRAPH_REPORT.md      # god nodes, surprises
```

**When to use:** Every new coding session. Every new client engagement.
Every unfamiliar repo. Skipping this is the #1 cause of agents missing
context and shipping blind edits.

### Mode 2: Symbol Dive — Deep Call Graph

**Purpose:** Understand exactly how a function works, who calls it,
what it calls, what flows it participates in.

```
gitnexus MCP → context({
  name: "<symbol_name>",
  repo: "<repo>"
  # file_path?, kind? (Function|Class|Method|Interface|Constructor), uid? — disambiguate
})

Output:
  • symbol:        uid, kind, filePath, startLine
  • incoming:      calls (with confidence), imports, accesses (read/write)
  • outgoing:      calls, accesses
  • processes:     step / process name (e.g. "LoginFlow (step 2/7)")
```

**Disambiguation** — when several symbols share a name, GitNexus returns
a ranked `ambiguous` candidate list. Pin with:
- `target_uid: "Function:src/embed.py:get_embeddings"` (zero ambiguity)
- `file_path: "src/embed.py"`
- `kind: "Function"`

**Cypher fallback for complex traversal:**
```cypher
-- Find what calls auth functions with high confidence
MATCH (c:Community {heuristicLabel: 'Authentication'})<-[:CodeRelation {type: 'MEMBER_OF'}]-(fn)
MATCH (caller)-[r:CodeRelation {type: 'CALLS'}]->(fn)
WHERE r.confidence > 0.8
RETURN caller.name, fn.name, r.confidence
ORDER BY r.confidence DESC
```

### Mode 3: Blast Check — Impact Analysis Before Edits

**Purpose:** Before modifying any symbol, what breaks?

```
gitnexus MCP → impact({
  target:        "<symbol_name>",
  direction:     "upstream",   # "downstream" for transitive deps
  repo:          "<repo>",
  maxDepth:      3,            # default 3; raise for deep fan-out
  minConfidence: 0.8,          # default 0; raise to suppress low-conv edges
  relationTypes: ["CALLS","IMPORTS","EXTENDS","IMPLEMENTS"],
  includeTests:  false,        # default false
  limit:         100,          # max symbols per depth
  offset:        0,            # pagination per depth
  summaryOnly:   false         # set true to skip symbol list, get just counts+risk
})

Output:
  • risk:           LOW / MEDIUM / HIGH / CRITICAL
  • summary.direct: direct dependents count
  • summary.processes_affected: execution flows that break
  • summary.modules_affected: clusters hit
  • byDepth:        callers grouped by distance
                      d=1 WILL BREAK
                      d=2 LIKELY AFFECTED
                      d=3 MAY NEED TESTING
  • affected_processes: name, file, step where break occurs
  • affected_modules:   clusters hit, direct vs indirect
```

**If risk ≥ MEDIUM**, also run `direction: "downstream"` to see what the
symbol itself depends on — those break too if your refactor changes the
return type or signature.

**API-specific variant:**
```
gitnexus MCP → api_impact({route: "/api/users", repo: "<repo>"})
# OR
gitnexus MCP → api_impact({file: "src/routes/users.ts", repo: "<repo>"})
```
Returns handlers, middleware wrappers, consumers, response-shape
mismatches, and risk in one call (combines `route_map` + `shape_check` +
`impact`).

### Mode 4: Stale Guard — Keep Indexes Fresh

**Purpose:** Detect when the knowledge graph is out of date.

```
gitnexus MCP → detect_changes({
  repo:    "<repo>",
  scope:   "compare",   # "unstaged" (default) | "staged" | "all" | "compare"
  base_ref: "main"      # required for "compare"
})

Output:
  • changed_count:     number of symbols affected
  • affected_count:    downstream symbols that may be stale
  • changed_files:     N
  • risk_level:        none | low | medium | high
  • changed_symbols:   [...]
  • affected_processes: [...]
```

**When `changed_count > 0`:**
```
gitnexus analyze --index-only       # ~4s
graphify update . --no-cluster      # if you maintain a graphify graph
gitnexus MCP → list_repos           # verify staleness hint is gone
```

**Automation:** GitNexus hooks can auto-trigger reindex after
`git commit`, `git merge`, `git rebase`, `git cherry-pick`, `git pull`
in Claude Code and Antigravity. Installed by `gitnexus setup`. Stale
hints are surfaced via the same `hookSpecificOutput.additionalContext`
channel.

### Mode 5: Enrich — Multimodal Knowledge Extraction

**Purpose:** Codebase includes docs, papers, diagrams, video, or
non-code artifacts that need to be part of the knowledge graph.

```
# Step 1: full extraction w/ LLM clustering & naming
graphify update .                       # needs API key for docs/papers/images
# or, code-only fast path:
graphify update . --no-cluster

# Step 2: pull out a specific concept
graphify explain "<concept>"            # plain-language node explanation
graphify path "<A>" "<B>"              # shortest path

# Step 3: ingest external resources
graphify add https://arxiv.org/abs/...         # papers
graphify add https://x.com/user/status/...     # tweets
graphify add https://docs.example.com/api      # docs
graphify add <youtube-url>                     # transcribe + add

# Step 4: query the enriched graph
graphify query "what connects PQC to the deployment pipeline?"
```

**When to use:**
- Client onboarding with existing documentation
- Research-heavy projects with papers, RFCs, design docs
- Multi-language repos where docs bridge code boundaries
- Tribal government / regulated IT systems with policy documents
  alongside code

**Backends to choose:**
| Need | Backend |
|---|---|
| Fastest, free in IDE | Whatever your IDE session runs (no flag) |
| Gemini (low cost, strong quality) | `--backend gemini` |
| Kimi (Chinese data-residency) | `--backend kimi` |
| Claude (deepest quality) | `--backend claude` (needs `graphifyy[anthropic]`) |
| OpenAI / compatible (vLLM, NVIDIA NIM, OpenRouter) | `--backend openai` or custom |
| DeepSeek | `--backend deepseek` |
| AWS Bedrock (IAM, no key) | `--backend bedrock` |
| Ollama (fully local) | `--backend ollama` |

### Mode 6: Client Brief — Visual Deliverables

**Purpose:** Interactive visualizations + structured reports for
stakeholders (tribal councils, corporate leadership, government IT
oversight, conference talks).

```
# 1. Build the full graph
graphify update .                     # needs API key for docs/papers/images
# or for code-only briefing:
graphify update . --no-cluster

# 2. Open interactive graph
open graphify-out/graph.html          # macOS
# Click nodes, search, filter by community

# 3. Generate call-flow diagram (Mermaid)
graphify export callflow-html
# Auto-regenerates on every commit if `graphify hook install` was run

# 4. Optional: generate wiki
graphify update . --wiki

# 5. Review GRAPH_REPORT.md:
cat graphify-out/GRAPH_REPORT.md
#   - God nodes           (high centrality — risk concentrators)
#   - Surprising connections (unexpected dependencies)
#   - Suggested questions (automated curiosity prompts)
#   - Import cycles        (Johnson's algorithm since 0.8.26)

# 6. For multi-repo engagements:
graphify merge-graphs repo1/graphify-out/graph.json \
                    repo2/graphify-out/graph.json \
                    --out merged-graph.json
```

**Cross-repo with GitNexus groups** (preferred for call-graph work):
```bash
gitnexus group create <client-name>
gitnexus group add <client-name> "<path>" <repo-name>
gitnexus group add <client-name> "<path>" <repo-name-2>
gitnexus group sync <client-name>
# Read gitnexus://group/<client-name>/contracts and .../status
# Use repo:"@<client-name>" on query/context/impact
```

### Mode 7: PR Triage & Review (Cross-CLI)

**Purpose:** Production-readiness review of a pull request — a workflow
that runs the same way in Claude Code, Codex, Gemini, Cursor, Copilot.

The canonical spec is **`pr-swarm-review/orchestration.md`** in any
GitNexus checkout. It defines seven read-only lanes:

| Lane | Persona | Responsibility | Depends on |
|---|---|---|---|
| 1 | `01-pr-facts-historian.md` | PR identity, visible state, changed files, linked issues, related PRs, repo history | — |
| 2 | `02-branch-hygiene-reviewer.md` | Merge-state + branch hygiene classification | 1 |
| 3 | `03-risk-architect.md` | Production failure modes, domain-specific blockers | 1, 2 |
| 4 | `04-test-ci-verifier.md` | Test coverage, CI wiring, validation gaps | 1 |
| 5 | `05-security-boundary-reviewer.md` | Trust boundaries, secrets, injection, permissions, hidden Unicode | 1 |
| 6 | `06-docs-dod-reviewer.md` | PR-specific Definition of Done, docs/release-note obligations | 1 |
| 7 | `07-synthesis-critic.md` | Critique the draft review | 1–6 + draft |

**Execution:**
- **Swarm mode** (Claude Code, parallel subagents): dispatch 1–2 first,
  then 3–6 in parallel, then 7.
- **Solo mode** (Codex, Gemini, Cursor, Copilot, Pi, …): one agent does
  all lanes in dependency order, adopting each persona in turn.

**Pre-lane data sources:**
```
# Lane 1 starts with:
graphify prs <PR>                       # CI state, review state, worktree, graph impact
graphify prs --conflicts               # PRs sharing graph communities
gitnexus detect_changes({repo, scope: "compare", base_ref: "main"})
gitnexus impact({target, direction: "upstream", repo, maxDepth: 2})
READ gitnexus://repo/{name}/processes
```

**Lane 7 is a hard gate.** Do not emit the final review while the
synthesis critic's "Required corrections before posting" section is
non-empty. Revise and re-run.

### Mode 8: Cross-Cutting Cypher (when the typed tools aren't enough)

**Use `cypher` when:**
- The shape of the question doesn't fit `query`/`context`/`impact`
- You need to filter on edge `confidence`, `reason`, or `step`
- You're tracing through processes or MRO chains
- You want cross-community flows

```cypher
-- Trace a process start to finish
MATCH (s:CodeElement)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process {name: 'LoginFlow'})
RETURN s.name, s.filePath, r.step
ORDER BY r.step

-- Diamond inheritance detection
MATCH (d:Class)-[r1:CodeRelation {type: 'EXTENDS'}]->(b1),
      (d)-[r2:CodeRelation {type: 'EXTENDS'}]->(b2),
      (b1)-[r3:CodeRelation {type: 'EXTENDS'}]->(a),
      (b2)-[r4:CodeRelation {type: 'EXTENDS'}]->(a)
WHERE b1 <> b2
RETURN d.name, b1.name, b2.name, a.name

-- Method overrides (MRO resolution)
MATCH (winner:Method)-[r:CodeRelation {type: 'METHOD_OVERRIDES'}]->(loser:Method)
RETURN winner.name, winner.filePath, loser.name, loser.filePath, r.reason

-- Confidence-filtered fan-in (high-risk symbols)
MATCH (caller:CodeElement)-[r:CodeRelation {type: 'CALLS'}]->(target)
WHERE r.confidence > 0.9
WITH target, count(caller) AS fan_in
WHERE fan_in > 5
RETURN target.name, target.filePath, fan_in
ORDER BY fan_in DESC
```

Read `gitnexus://repo/{name}/schema` first for the exact node labels,
edge types, and property names.

---

## §5 Pre-Edit Safety Protocol

**Mandatory sequence before editing any code symbol.** This protocol
exists because blind edits are the #1 cause of regressions in
AI-assisted development.

```
1. STALE CHECK
   gitnexus detect_changes({repo})         # is the index fresh?
   gitnexus status                          # CLI equivalent

2. UNDERSTAND THE SYMBOL
   gitnexus context({name: "<target>", repo})
   # Note: incoming calls, outgoing calls, processes, type, location

3. BLAST RADIUS
   gitnexus impact({
     target:    "<target>",
     direction: "upstream",   # who depends on this
     repo,
     minConfidence: 0.8
   })
   # If risk >= MEDIUM, also:
   gitnexus impact({target, direction: "downstream", repo})

4. HIGH-RISK GATE
   if risk in {HIGH, CRITICAL}:
     # Report to user BEFORE editing:
     #   - N direct dependents
     #   - M processes that break
     #   - K clusters hit
     #   - Specific symbols at d=1 (WILL BREAK)
     #   - Proposed safe edit plan (e.g. feature flag, phased rollout)
     #   - WAIT for explicit go-ahead

5. EDIT THE CODE

6. RE-INDEX
   gitnexus analyze --index-only           # ~4s

7. VERIFY
   gitnexus detect_changes({repo})         # confirm only expected symbols changed
   # Run repo's test suite + linter as usual
```

**For renames specifically**, use `rename` instead of find-and-replace:
```
gitnexus rename({
  symbol_name: "oldName",
  new_name:    "newName",
  repo,
  dry_run: true                              # always preview first
})
# Edits are tagged:
#   graph_edits:       high confidence (from call graph)
#   text_search_edits: review carefully (regex match)
```

---

## §6 Cross-Repo & Group Recipes

### 6.1 GitNexus Groups

Groups are an organizational concept for multi-repo or monorepo
service-tracking. A group aggregates repos so cross-repo queries work
transparently via `repo: "@<groupName>"`.

```bash
# Create
gitnexus group create <group>

# Add repos (note: <groupPath> is a hierarchy path, e.g. "hr/hiring/backend")
gitnexus group add <group> "<groupPath>" <registryName>

# Sync — extract HTTP contracts and match across repos
gitnexus group sync <group>

# Inspect
gitnexus group list
gitnexus group list <group>
# Per-group staleness: READ gitnexus://group/<group>/status
# Contract registry:    READ gitnexus://group/<group>/contracts
#   Query params: ?type=Route&repo=api&unmatchedOnly=true

# Query across all members (uses RRF fusion)
gitnexus query({query: "...", repo: "@<group>"})

# Scope to a single member
gitnexus query({query: "...", repo: "@<group>/<memberPath>"})

# Cross-repo impact (local walk + Contract Bridge fan-out)
gitnexus impact({target: "...", direction: "upstream", repo: "@<group>"})
```

**Resource query examples (MCP `read_resource`):**
```
# All unmatched contracts in a group
gitnexus://group/myorg/contracts?unmatchedOnly=true

# Routes only, from the api repo
gitnexus://group/myorg/contracts?type=Route&repo=api
```

### 6.2 Graphify Multi-Repo

```bash
# 1. Clone each repo (or use existing local paths)
graphify clone https://github.com/org/repo-a
graphify clone https://github.com/org/repo-b

# 2. Build each graph
cd repo-a && graphify update . --no-cluster && cd ..
cd repo-b && graphify update . --no-cluster && cd ..

# 3. Merge — every node carries a `repo` attribute
graphify merge-graphs \
  repo-a/graphify-out/graph.json \
  repo-b/graphify-out/graph.json \
  --out graphify-out/cross-repo-graph.json

# 4. Or register into the global cross-project graph
graphify extract ./repo-a --global --as repo-a
graphify extract ./repo-b --global --as repo-b
graphify global list           # shows both with node/edge counts
graphify global path           # ~/.graphify/global.json
```

**Monorepo / multi-service layout** — running the slash command on each
subfolder clobbers the same `graphify-out/`. Use the CLI directly:
```bash
graphify extract ./core/     # → ./core/graphify-out/graph.json
graphify extract ./service/  # → ./service/graphify-out/graph.json
graphify extract ./platform/ # → ./platform/graphify-out/graph.json
graphify merge-graphs \
  ./core/graphify-out/graph.json \
  ./service/graphify-out/graph.json \
  ./platform/graphify-out/graph.json \
  --out graphify-out/graph.json
```

### 6.3 Combined: Groups + Global Graph

For an org with N repos where you want both call-graph precision
(GitNexus) and cross-doc reasoning (Graphify):

```bash
# GitNexus side: one MCP server, all repos
cd repo-a && gitnexus analyze
cd ../repo-b && gitnexus analyze
gitnexus group create myorg
gitnexus group add myorg "a" repo-a
gitnexus group add myorg "b" repo-b
gitnexus group sync myorg

# Graphify side: global graph
graphify extract ./repo-a --global --as repo-a
graphify extract ./repo-b --global --as repo-b

# Use:
#   gitnexus query({query: "auth", repo: "@myorg"})     for code call-chains
#   graphify query "policy + auth"                       for cross-doc reasoning
#   gitnexus://group/myorg/contracts                     for cross-repo HTTP wiring
#   graphify prs --conflicts                             for merge-order risk across repos
```

---

## §7 Multimodal & Non-Code Recipes

### 7.1 PDF Ingest

```bash
# Install PDF extra
uv tool install "graphifyy[pdf]"

# Add a research paper or RFC
graphify add https://arxiv.org/abs/1706.03762        # the "Attention Is All You Need" paper
graphify add https://datatracker.ietf.org/doc/html/rfc8446  # TLS 1.3
```

### 7.2 Video / Audio

```bash
uv tool install "graphifyy[video]"

graphify add <youtube-url>           # auto-download + transcribe (faster-whisper, local)
graphify add ./recordings/townhall.mp4
graphify add ./podcast/episode-7.mp3

# Larger Whisper model = better accuracy
graphify add <youtube-url> --whisper-model medium
```

**Tip:** write the initial Whisper prompt yourself from the project's
existing god-node labels — the labels are a strong domain hint that
improves transcription of jargon.

### 7.3 Google Workspace (gdoc/gsheet/gslides)

```bash
# One-time: install gws CLI and authenticate
uv tool install "graphifyy[google]"
gws auth login -s drive

# Per-run: enable export
graphify extract ./docs --google-workspace
# or
GRAPHIFY_GOOGLE_WORKSPACE=1 graphify extract ./docs
```

Shortcuts (`.gdoc`, `.gsheet`, `.gslides` in Google Drive for desktop)
get exported to `graphify-out/converted/` as Markdown sidecars, then
extracted as docs. Native content requires the gws auth.

### 7.4 Images

```bash
graphify extract ./diagrams --no-cluster
# .png .jpg .webp .gif
```

### 7.5 Multi-Repo URL Pipeline

```bash
# Clone + extract + build + merge, all in one command
/graphify https://github.com/org/repo-a https://github.com/org/repo-b
# Clones to ~/.graphify/repos/<owner>/<repo>, extracts each, merges
# Each node carries a `repo` attribute so you can filter
```

### 7.6 MCP Configs as Code

Graphify extracts server nodes, package refs, and env-var requirements
from `.mcp.json`, `mcp.json`, `mcp_servers.json`,
`claude_desktop_config.json`. Useful for auditing which servers depend
on which API keys (especially with PQC secrets).

---

## §8 Embeddings, Performance & Tuning

### 8.1 GitNexus Embeddings

Embeddings enable semantic search (vector similarity) on top of BM25.
HuggingFace transformers.js runs in the same Node process; CPU by
default, GPU if available.

```bash
# First time (slower, more RAM)
gitnexus analyze --embeddings

# Large repos — embeddings are auto-capped at 50,000 nodes
# to protect memory. Override the cap:
gitnexus analyze --embeddings 100000   # raise cap
gitnexus analyze --embeddings 0        # disable cap entirely (big host only)

# Skip embeddings on subsequent runs (faster):
gitnexus analyze --skip-embeddings

# Check current state
cat .gitnexus/meta.json | jq .stats.embeddings
# 0  = no embeddings (BM25 only)
# N  = N nodes embedded
```

**CRITICAL:** Once you've enabled embeddings, **always** pass
`--embeddings` on subsequent analyzes — or they'll be dropped.

### 8.2 GitNexus Worker Pool & WAL

For very large repos, the worker pool and LadybugDB WAL are the
bottlenecks. Tune via env vars (see §1.6 for full table):

```bash
# Constrained container / cgroup CPU limit
GITNEXUS_WORKER_POOL_SIZE=2 gitnexus analyze

# Debug a worker crash (sequential, no pool)
GITNEXUS_WORKER_POOL_SIZE=0 gitnexus analyze --verbose

# Large repos with many chunks — raise I/O concurrency
GITNEXUS_PARSE_CHUNK_CONCURRENCY=4 gitnexus analyze

# Slow files (minified JS, huge TS types)
GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS=60000 gitnexus analyze
GITNEXUS_WORKER_SUB_BATCH_MAX_BYTES=16777216 gitnexus analyze

# Disk-constrained env (smaller WAL)
GITNEXUS_WAL_CHECKPOINT_THRESHOLD=16777216 gitnexus analyze

# Diagnose "Resolving calls (all chunks)" stalls
GITNEXUS_PROFILE_DEFERRED=1 GITNEXUS_PROFILE_DEFERRED_SLOW_MS=2000 gitnexus analyze
```

### 8.3 Graphify Concurrency & Token Budgets

```bash
# AST parallelism
GRAPHIFY_MAX_WORKERS=16 graphify extract ./docs
graphify extract ./docs --max-workers 16

# Smaller semantic chunks for local/small models
graphify extract ./docs --token-budget 30000

# Fewer parallel LLM calls (useful for Ollama)
graphify extract ./docs --max-concurrency 2

# Longer HTTP timeout for slow local models (default 600s)
graphify extract ./docs --api-timeout 900

# Raise output cap for dense corpora
GRAPHIFY_MAX_OUTPUT_TOKENS=32768 graphify extract ./docs --backend claude
```

### 8.4 Cluster Tuning (Graphify)

```bash
# More, smaller communities
graphify cluster-only ./my-project --resolution 1.5

# Suppress utility super-hubs from god-node rankings
graphify cluster-only ./my-project --exclude-hubs 99

# Keep "Community N" placeholders (no LLM naming)
graphify cluster-only ./my-project --no-label

# Re-name on demand
graphify label ./my-project --backend=openai
```

### 8.5 Graph HTML Too Large to Open

If `graph.html` exceeds browser memory (>5000 nodes):

```bash
graphify cluster-only ./my-project --no-viz
graphify query "..." --graph graphify-out/graph.json
# Or: --svg instead of --html (much smaller)
graphify update . --svg
```

### 8.6 npm 11 Install Crash

```
Cannot destructure property 'package' of 'node.target'
```

This is an `npm/arborist` bug, **not** a GitNexus bug, that happens
before GitNexus runs. Fixes:

```bash
# Option 1: pnpm (recommended)
pnpm --allow-build=@ladybugdb/core --allow-build=gitnexus --allow-build=tree-sitter \
  dlx gitnexus@latest analyze

# Option 2: install globally so npx is never used
npm install -g gitnexus@latest
gitnexus analyze

# Option 3: skip optional grammars (no C++ toolchain)
GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1 npm install -g gitnexus
# Dart/Proto/Swift files won't parse; install completes in seconds
```

### 8.7 Cosign-Verified Docker Images

```bash
# Stable releases (signed from v* tag ref)
cosign verify ghcr.io/abhigyanpatwari/gitnexus:1.6.2 \
  --certificate-identity-regexp '^https://github\.com/abhigyanpatwari/GitNexus/\.github/workflows/docker\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

# Same signature verifies the Docker Hub mirror (identical digest)
cosign verify docker.io/akonlabs/gitnexus:1.6.2 \
  --certificate-identity-regexp '^https://github\.com/abhigyanpatwari/GitNexus/\.github/workflows/docker\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

# Inspect build provenance + SBOM
cosign download attestation ghcr.io/abhigyanpatwari/gitnexus:1.6.2 \
  --predicate-type https://slsa.dev/provenance/v1
```

For Kubernetes, ship the bundled `deploy/kubernetes/cluster-image-policy.yaml`
to reject unsigned or wrong-workflow-signed images at admission.

---

## §9 Confidence, Uncertainty & Honesty

A knowledge graph is only as useful as the agent's calibration about
what it **knows** vs what it **guessed**.

### 9.1 GitNexus Edge Confidence

Every edge carries a numeric `confidence` (0.0–1.0). The value reflects
how certain the resolver was about the relationship.

| Tier | Typical | Examples |
|---|---|---|
| High (≥ 0.9) | Direct call in same file, explicit import | `[CALLS 90%]` `[IMPORTS 95%]` |
| Medium (0.7–0.9) | Cross-file resolved call w/ matching signature | `[CALLS 85%]` (MRO-walked override) |
| Low (< 0.7) | Name collision, dynamic dispatch, weak inference | `[CALLS 60%]` (duck-typed) |

**Filter on confidence** to suppress low-conv edges:
```bash
gitnexus impact --min-confidence 0.8 ...
```

**Cypher**:
```cypher
MATCH (a)-[r:CALLS]->(b) WHERE r.confidence > 0.8 RETURN ...
```

### 9.2 Graphify Confidence Labels

Three categorical labels per edge:

| Label | Meaning | User action |
|---|---|---|
| `EXTRACTED` | Explicit in source (AST) | Trust |
| `INFERRED` | Reasonable deduction (call-graph 2nd pass, co-occurrence) | Verify on first encounter |
| `AMBIGUOUS` | Uncertain; flagged in `GRAPH_REPORT.md` | Review before relying |

### 9.3 Honesty Rules for Agents

1. **Never present an inferred relationship as fact.** If you used
   `INFERRED` edges, say "the graph *suggests* X" or "likely".
2. **When citing `graph.html` or `GRAPH_REPORT.md`,** name the section
   ("God Nodes", "Surprising Connections") so the user can audit.
3. **For `cypher` results, always include the query and `confidence`
   filter** in the report. The user should be able to reproduce.
4. **For PR triage (`graphify prs --triage`),** mark the output as
   "AI-ranked" — the backend's LLM is doing the ranking, not a rule
   engine.
5. **Forgotten nodes / ghost duplicates** are real. If `graph.json`
   has stale entries from a refactor, run `graphify extract . --force`.

---

## §10 Failure Modes & Recovery Runbook

### 10.1 GitNexus

| Symptom | Cause | Fix |
|---|---|---|
| `GitNexus: No indexed repos yet` on stderr when starting MCP | Per-repo `.gitnexus/` missing | `cd <repo> && npx gitnexus analyze` |
| `staleness.hint` shows `commitsBehind > 0` | HEAD moved past indexed commit | `gitnexus analyze` (or rely on auto-hook) |
| Wrong repo when multiple indexed | `repo` param omitted | `list_repos` first; pass `repo` on every call |
| `route_map` / `shape_check` empty | Not a REST codebase | Expected; these are HTTP-only |
| Shell function calls not tracked as edges | tree-sitter doesn't see function bodies of shell funcs | Use `query()` to find the function, then read the file |
| Doc content not in graph | GitNexus clusters code, not docs | Use Graphify for doc intelligence |
| Index is "stuck" / corrupt | `.gitnexus/lbug` corruption | `gitnexus clean --force && gitnexus analyze` (or `analyze --force` for FTS only) |
| `Cannot destructure property 'package' of 'node.target'` | npm 11 / arborist bug | `npm i -g gitnexus@latest` or pnpm — see §8.6 |
| OOM on huge repos | Native bindings + embeddings | `analyze --skip-embeddings`, `GITNEXUS_WORKER_POOL_SIZE=0`, or analyze a smaller path |
| LadybugDB lock error | MCP + `analyze` fighting | Stop one; restart MCP after `analyze` finishes |
| npx install exceeds 30s MCP_TIMEOUT | Cold cache | `npm i -g gitnexus@latest` (absolute path, bypasses npx) |
| Embeddings disappeared after re-analyze | Forgot to pass `--embeddings` | `gitnexus analyze --embeddings` |
| `MIGRATED_LANGUAGES` produces different graph than before | Scope-resolution pipeline vs legacy DAG diverge | Both paths are kept in sync via CI parity gate; if you see drift, file an issue |

### 10.2 Graphify

| Symptom | Cause | Fix |
|---|---|---|
| `graphify: command not found` | PATH missing the user bin dir | `uv tool install graphifyy` (preferred) or add `~/.local/bin` to PATH |
| `python -m graphify` works but `graphify` command doesn't | PATH issue | Use `uv` or `pipx` instead of `pip` |
| `/graphify .` → "path not recognized" (PowerShell) | PowerShell treats `/` as path separator | Use `graphify .` (no slash) on Windows |
| Graph has fewer nodes after `--update` | Refactor deleted files | `graphify update . --force` (or `GRAPHIFY_FORCE=1`) |
| Ghost duplicates for same entity | Semantic vs AST disagreed on node ID | `graphify extract . --force` (full re-extract) |
| Empty nodes/edges for docs/PDFs | LLM not called | Check `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` / etc.; pass `--backend` explicitly |
| `graph.json` has conflict markers | Two devs committed in parallel | `graphify hook install` to register the union-merge driver (future commits) |
| `graph.html` too large to open | >5000 nodes exceeds browser memory | `graphify cluster-only . --no-viz`, or `--svg` instead |
| Ollama OOM / context window exceeded | KV cache too large for GPU | `GRAPHIFY_OLLAMA_NUM_CTX=8192 graphify extract ./docs --backend ollama --token-budget 4000` |
| Skill version mismatch warning | Installed graphify ≠ skill file | `uv tool upgrade graphifyy && graphify install` |
| Hook fires but no rebuild | `graphify` launcher not on PATH for GUI/CI | Hook now embeds `sys.executable` directly (0.8.31); re-run `graphify hook install` |
| Linked local providers file ignored | Security (0.8.29) | Set `GRAPHIFY_ALLOW_LOCAL_PROVIDERS=1` for project-local `~/.graphify/providers.json` |
| OLLAMA points at metadata endpoint | Security (0.8.29) | Fails closed; use a different `OLLAMA_BASE_URL` |

### 10.3 When In Doubt

1. **Read the source's llms.txt** — every project ships one.
2. **For GitNexus**, the canonical runbook is `RUNBOOK.md`; for
   architecture, `ARCHITECTURE.md`; for safety rules, `GUARDRAILS.md`.
3. **For Graphify**, the README troubleshooting section covers the
   common ones; `ARCHITECTURE.md` covers module responsibilities.
4. **Cosign verification** for the GitNexus Docker image if you ship
   it (see §8.7).
5. **File an issue** — both projects are actively maintained; bug
   reports with `graphify-out/cache/` entries and the input file are
   acted on.

---

## §11 Anti-Patterns — What NOT to Do

| Anti-pattern | Why it fails | Use instead |
|---|---|---|
| Reading every source file one-by-one to "understand" a repo | Slow, error-prone, context-budget killer | `query` + `context` (GitNexus) or `graphify query` (Graphify) |
| `grep` / `rg` for symbol lookup | Misses indirect references, MRO overrides, dynamic dispatch | `context` |
| `find . -name` for file lookup | Misses semantic relations | `query` for symbol context |
| Find-and-replace for renames | Misses indirect refs, re-exports, dynamic dispatch | `gitnexus rename` (graph + text-search both) |
| Running `analyze` on every question | Wasteful (~4s); `analyze --index-only` is no-op if fresh | `analyze` once after edits, then trust the index |
| `graphify update .` for every question | Wasteful (~12s + LLM cost); `--update` re-extracts only changed | `graphify query` against cached graph |
| Auto-approving HIGH/CRITICAL impact edits | Silent regressions | Mandatory user confirmation |
| Committing `graphify-out/manifest.json` | mtime-based, breaks after `git clone` | `.gitignore` it |
| Running `pip install graphifyy` on Mac/Windows | Python env mismatch causes `ModuleNotFoundError` | `uv tool install graphifyy` (preferred) or `pipx` |
| Disabling git hooks to "fix" merge conflicts | Loses auto-rebuild + union-merge driver | Keep hooks; resolve manually if needed |
| Putting real API keys in MCP config files | Discovered & shared via dotfiles | Use PQC secrets (`secrets-load`) and reference env vars |
| Treating `gitnexus://repo/{name}/processes` as the only entry point | Heavy first call | Read `gitnexus://repo/{name}/context` first — it's tiny |
| Using `cypher` when `context` would do | Verbose, error-prone | `context` returns pre-typed objects |
| Treating `GRAPH_REPORT.md` god-nodes as bugs to delete blindly | Some are intentional hubs (entry points, error handlers) | Read the labels and reason about the role |
| Trusting `INFERRED` edges without audit | Inference is heuristic | Filter on `EXTRACTED` only for first pass |
| Importing project-local `providers.json` automatically | Travels with cloned repos, can exfiltrate | `GRAPHIFY_ALLOW_LOCAL_PROVIDERS=1` opt-in (0.8.29+) |
| Pointing OLLAMA at `169.254.x` or `metadata.google.*` | SSRF / cloud-metadata leak | Fail closed — use loopback or trusted LAN |
| Stale graph + `analyze` skipped because it "looks fresh" | Drift accumulates silently | Always run `gitnexus detect_changes` before major edits |

---

## §12 References & Version Pin

This skill is **pinned** to:

- **GitNexus ≥ 1.7.0** (TypeScript 1.5.0 added `MIGRATED_LANGUAGES` parity;
  1.5.0+ uses resources for groups). Cosign-signed Docker images at
  `ghcr.io/abhigyanpatwari/gitnexus:{version}` (mirror: `akonlabs/gitnexus`).
- **Graphify ≥ 0.8.31** (Kilo support, `--no-label` option, hook
  interpreter fix, Read-tool hook, `anthropic` extra, project-local
  provider opt-in).

### 12.1 Canonical Sources

**GitNexus:**
- Repo: `github.com/abhigyanpatwari/GitNexus`
- `README.md` — quick start, CLI reference, editor support matrix
- `llms.txt` — agent entry point
- `AGENTS.md` — tool reference + always-do/never-do for agents
- `ARCHITECTURE.md` — 12-phase pipeline DAG, scope-resolution
  pipeline, call-resolution DAG, CI parity gate
- `RUNBOOK.md` — operational commands, embeddings, MCP recovery
- `GUARDRAILS.md` — non-negotiables and operational "Signs"
- `pr-swarm-review/orchestration.md` — 7-lane PR review spec
- `gitnexus/src/mcp/{server,tools,resources,prompts}.ts` — tool source

**Graphify:**
- Repo: `github.com/safishamsi/graphify` (active branch: `v8`)
- `README.md` — installation, command reference, troubleshooting
- `ARCHITECTURE.md` — pipeline, module responsibilities, confidence labels
- `SECURITY.md` — threat model (URLs, paths, labels, OLLAMA, providers)
- `docs/how-it-works.md` — extraction pipeline details, benchmarks
- `docs/translations/` — 13 README translations
- `CHANGELOG.md` — version history (semantic versioning)
- `graphify/serve.py` — MCP server source (10 tools)
- `graphify/{detect,extract,build,cluster,analyze,report,export}.py`
  — pipeline stages

### 12.2 Cross-References in this Skill Pack

- **Pre-edit safety** → §5 (mandatory), §6.1 (groups), §10 (runbook)
- **Performance** → §8 (tuning), §10 (recovery)
- **PR review** → §4 Mode 7 (lanes), `pr-swarm-review/orchestration.md`
- **Multi-repo** → §6 (groups, global graph, combined pattern)
- **Multimodal** → §7 (PDF, video, image, Google Workspace)
- **Honesty / uncertainty** → §9 (confidence), §11 (anti-patterns)

### 12.3 Companion Tools / Hooks

- **`secrets-load`** — PQC-protected env injection; required before
  LLM-backed `graphify` commands if you want zero plain-text keys.
- **Post-merge / post-checkout hooks** (`scripts/hooks/agents-md-sync.sh`)
  — keep AGENTS.md in sync with the canonical source on `main`.
- **GitNexus PostToolUse hook** — reindexes after `git commit` /
  `merge` / `rebase` / `cherry-pick`; installed by `gitnexus setup`.
- **Graphify `hook install`** — auto-rebuilds `graph.json` after
  commit; registers git merge driver for `graph.json` to union-merge
  on parallel commits.

### 12.4 What This Skill Does Not Cover

- **GitNexus web UI / Docker setup** — read `README.md` "Web UI" and
  "Docker" sections.
- **Graphify's Penpax always-on layer** — commercial extension; not
  the OSS tool.
- **GitNexus enterprise SaaS** — `akonlabs.com`.
- **Custom language extractors** — see `graphify/ARCHITECTURE.md`
  "Adding a new language extractor" for the pattern.

---

## §13 Provider Integration — PQC + providers.txt

Graphify's LLM backends (gemini, kimi, claude, openai, deepseek, ollama,
bedrock, claude-cli) each take a different env-var + endpoint contract.
Rather than re-implement that mapping per project, this skill ships a
**bridge** that reads the operator's existing provider config and
PQC-protected secret bundle, then exports the right vars for graphify.

### 13.1 The three sources of truth

| Source | Path | What it provides |
|---|---|---|
| `providers.json` (machine) | `~/.config/ainish-coder/providers.json` | `baseUrl`, `defaultModel`, per-tool flags per provider |
| `providers.txt` (human) | `~/.config/providers.txt` (often a symlink) | Canonical env-var names per provider (`WAFER_SERVERLESS_API_KEY`, `ZENMUX_API_KEY`, …) and full model catalog |
| PQC secrets bundle | `~/.config/pqc-secrets/secrets.bundle.json` + macOS Keychain | The actual API key values, decrypted at runtime only |

**The bridge script** lives at `scripts/graphify-env.sh` and is the
recommended entry point for every graphify command that touches an
LLM.

### 13.2 Quick start

```bash
# 1) Load PQC secrets into the current shell (one-time per session)
secrets-load
# OR:  eval "$(./bin/pqc-secrets export)"

# 2) Source the bridge (auto-detects best provider, exports env vars)
source .agents/skills/graph-intelligence/scripts/graphify-env.sh

# 3) Run graphify — it now finds the right backend and key
graphify extract ./docs
graphify update . --no-cluster       # AST-only, no LLM call needed
graphify cluster-only .              # re-cluster and (re)name communities
graphify add https://arxiv.org/abs/1706.03762
```

Output you should see:

```
[graphify-env] Loaded providers from /Users/nbiish/.config/ainish-coder/providers.json
[graphify-env] Loaded env-var hints from providers.txt
[graphify-env] Auto-selected provider: zenmux
graphify-env
  provider:  zenmux
  backend:   openai
  env var:   OPENAI_API_KEY (value hidden)
  base URL:  https://zenmux.ai/api
  model:    deepseek/deepseek-v4-pro
```

### 13.3 Provider → graphify-backend mapping

| Provider | Graphify backend | Key env var | Base URL |
|---|---|---|---|
| `claude` (Anthropic) | `claude` | `ANTHROPIC_API_KEY` | — (default) |
| `gemini` (Google) | `gemini` | `GEMINI_API_KEY` / `GOOGLE_API_KEY` | — |
| `kimi` (Moonshot) | `kimi` | `MOONSHOT_API_KEY` | — |
| `ollama` (local) | `ollama` | `OLLAMA_BASE_URL` (key optional) | `http://127.0.0.1:11435` |
| `bedrock` (AWS) | `bedrock` | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` | — (AWS SDK) |
| `claude-cli` (local) | `claude-cli` | — | — (uses local `claude` binary) |
| `zenmux` | `openai` | `ZENMUX_API_KEY` | `https://zenmux.ai/api` |
| `openrouter` | `openai` | `OPENROUTER_API_KEY` | `https://openrouter.ai/api` |
| `wafer-serverless` | `openai` | `WAFER_SERVERLESS_API_KEY` | `https://pass.wafer.ai` |
| `nebius` | `openai` | `NEBIUS_API_KEY` | `https://api.tokenfactory.nebius.com` |
| `opencode` / `opencode-zen` | `openai` | `OPENCODE_API_KEY` | `https://opencode.ai/zen/go` (or `/v1`) |
| `zai` | `openai` | `ZAI_API_KEY` | `https://api.z.ai/api/coding/paas` |
| `nvidia-nim` | `openai` | `NVIDIA_NIM_API_KEY` | `https://integrate.api.nvidia.com` |
| `modal` | `openai` | `MODAL_API_KEY` | `https://api.us-west-2.modal.direct` |
| `xiaomi-mimo` | `openai` | `XIAOMI_MIMO_API_KEY` | `https://token-plan-sgp.xiaomimimo.com` |
| `deepseek` | `openai` | `DEEPSEEK_API_KEY` | `https://api.deepseek.com` |

### 13.4 Auto-pick priority

When neither `GRAPHIFY_PROVIDER` nor `GRAPHIFY_PROVIDER_PRIORITY` is set,
the script picks the **first** provider in the registry order below
whose key is loaded. The order prioritizes:

1. **Direct user subscriptions** (no aggregator markup, predictable cost)
2. **Free local options** (no network)
3. **Aggregators** (more expensive but flexible)

| # | Provider | Notes |
|---|---|---|
| 1 | `claude` (Anthropic) | Best for code reasoning; first choice if loaded |
| 2 | `gemini` | Fast multimodal |
| 3 | **`zai`** (Z.ai) | **Direct subscription — GLM-5.1, GLM-5** |
| 4 | **`xiaomi-mimo`** | **Direct subscription — mimo-v2.5** |
| 5 | `kimi` (Moonshot) | Long context, multimodal |
| 6 | `ollama` | Local-only |
| 7 | `zenmux` | Aggregator with 60+ models |
| 8 | `openrouter` | 300+ models, presets supported |
| 9 | `wafer-serverless` | Fast, 1M-context deepseek |
| 10 | `nebius` | Hosting for Kimi, DeepSeek, Nemotron |
| 11 | `opencode` / `opencode-zen` | Curated coding-agent subscription |
| 12 | `nvidia-nim` | Nemotron, MiniMax |
| 13 | `modal` | Direct inference |
| 14 | `deepseek` | Direct DeepSeek API |

**Rationale for #3 and #4 being so high:** Z.ai GLM-5.1 and Xiaomi
MiMo mimo-v2.5 are operator-direct subscriptions — paid for
independently of any aggregator. They are preferred over aggregators
because (a) the user already paid for them, (b) there is no aggregator
markup, and (c) the call path is shorter and more reliable.

**Default behaviour:** with both ZAI and MiMo keys loaded, the script
auto-selects `zai` (default model `glm-5.1`). With only MiMo loaded,
it selects `xiaomi-mimo` (default model `mimo-v2.5`).

Override with `GRAPHIFY_PROVIDER=<name>` to force a specific one
(errors out if its key is not loaded — fail closed). For ordering
multiple, use `GRAPHIFY_PROVIDER_PRIORITY` (see §13.5).

### 13.5 Forcing a specific provider / backend / model

Three knobs, in order of precedence:

#### `GRAPHIFY_PROVIDER` — force exactly one (errors if key missing)

```bash
# Force provider (errors if its key is not loaded)
GRAPHIFY_PROVIDER=zenmux source scripts/graphify-env.sh
```

#### `GRAPHIFY_PROVIDER_PRIORITY` — try in order, fall through to default

Space-separated list of provider names. The script tries each in order;
the first one with a loaded key wins. If **none** of the priority list
has a key, falls through to the default registry order.

```bash
# Prefer zenmux, fall back to xiaomi-mimo, then zai, then default
GRAPHIFY_PROVIDER_PRIORITY="zenmux xiaomi-mimo zai" source scripts/graphify-env.sh

# Prefer user-direct subscriptions over aggregators
GRAPHIFY_PROVIDER_PRIORITY="zai xiaomi-mimo kimi" source scripts/graphify-env.sh

# Force kimi (or fall through to zai → xiaomi-mimo)
GRAPHIFY_PROVIDER_PRIORITY="kimi zai xiaomi-mimo" source scripts/graphify-env.sh

# Empty priority list / no key loaded → falls through to default order
GRAPHIFY_PROVIDER_PRIORITY="claude" source scripts/graphify-env.sh
#   ↳ if no ANTHROPIC_API_KEY, picks zai (default order, first match)
```

The `GRAPHIFY_PROVIDER_PRIORITY` is the right knob when you want to
**express preference without forcing** — useful for shared configs
where different machines may have different keys loaded.

#### `GRAPHIFY_BACKEND` and `GRAPHIFY_MODEL` — override backend and model

```bash
# Force graphify backend (overrides the registry default for the provider)
GRAPHIFY_BACKEND=openai source scripts/graphify-env.sh

# Override the model the registry would pick
GRAPHIFY_MODEL=google/gemini-3.1-pro-preview source scripts/graphify-env.sh

# Combined: openai backend via zenmux with the coder model
GRAPHIFY_PROVIDER=zenmux GRAPHIFY_BACKEND=openai \
  GRAPHIFY_MODEL=openai/gpt-5-codex source scripts/graphify-env.sh

# Force kimi on its dedicated backend (not the openai-compat path)
GRAPHIFY_PROVIDER=kimi source scripts/graphify-env.sh
```

#### Resolved state (always exported)

After sourcing, the script exports three resolved-state variables you
can use in your own commands:

```bash
echo "$GRAPHIFY_RESOLVED_PROVIDER"   # e.g. zai
echo "$GRAPHIFY_RESOLVED_BACKEND"    # e.g. openai
echo "$GRAPHIFY_RESOLVED_MODEL"      # e.g. glm-5.1
```

### 13.6 No-keys path (and how to recover)

If the script finds no API keys in the env **and** cannot run
`pqc-secrets export`, it exits 1 with a help message:

```
[graphify-env] ✗ No LLM provider keys detected in environment.

  No API keys found. Pick one of:
    1) Run:  secrets-load       (loads from PQC bundle, default)
    2) Set the env var directly, e.g.:
         export ZENMUX_API_KEY=...
         export ANTHROPIC_API_KEY=...
         export GEMINI_API_KEY=...
         export MOONSHOT_API_KEY=...

  Provider → env-var mapping (from providers.txt):
    claude                  ANTHROPIC_API_KEY
    gemini                  GEMINI_API_KEY
    kimi                    MOONSHOT_API_KEY
    ollama                  OLLAMA_BASE_URL
    zenmux                  ZENMUX_API_KEY
    openrouter              OPENROUTER_API_KEY
    wafer-serverless        WAFER_SERVERLESS_API_KEY
    nebius                  NEBIUS_API_KEY
    opencode                OPENCODE_API_KEY
    opencode-zen            OPENCODE_API_KEY
    zai                     ZAI_API_KEY
    nvidia-nim              NVIDIA_NIM_API_KEY
    modal                   MODAL_API_KEY
    xiaomi-mimo             XIAOMI_MIMO_API_KEY
    deepseek                DEEPSEEK_API_KEY
```

**Recovery checklist:**

1. Verify PQC bundle exists: `ls -la ~/.config/pqc-secrets/`
2. Verify the macOS Keychain entry: `security find-generic-password -s pqc-secrets -a default` (returns 0 if present)
3. Verify the binary is on PATH: `command -v pqc-secrets`
4. Try loading manually: `eval "$(./bin/pqc-secrets export)" && env | grep _API_KEY`
5. If a key is missing, re-pack: `key1=val1 key2=val2 ./bin/pqc-secrets pack`

### 13.7 Code-only path (no LLM needed)

Many graphify operations don't need an LLM at all. These work even with
zero keys:

```bash
graphify update . --no-cluster      # AST only, no community naming
graphify query "..." --graph graphify-out/graph.json   # read-only
graphify path "A" "B"               # read-only
graphify explain "X"                # read-only
graphify export svg / graphml / callflow-html / obsidian / wiki
graphify merge-graphs a.json b.json --out merged.json
graphify watch ./src                # re-extract on file change (AST only)
graphify prs [--triage --conflicts --worktrees]   # PR dashboard
```

For LLM-backed operations (community naming, doc/PDF/image/video
extraction, semantic cluster naming, deep mode), use the bridge
script first.

### 13.8 The script's compatibility matrix

| bash | Compatible | Notes |
|---|---|---|
| bash 3.2 (macOS default) | ✓ | No associative arrays — uses tmp files for parallel arrays |
| bash 4.0+ (Linux) | ✓ | Same code path |
| bash 5.x | ✓ | Same code path |
| zsh | ✓ | Source with `source` (works in zsh) |
| fish | partial | Use `bash -c 'source …; …'` wrapper |
| sh / dash | ✗ | Uses `[[ ]]`, arrays, `printf -v` — needs bash |

Requires `python3` on PATH for parsing `providers.json`.

### 13.9 Why this exists (design rationale)

The graphify CLI and the `ainish-coder` providers config evolved
independently:

- **Graphify** has 8 LLM backends, each with its own env-var contract
  (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`,
  `MOONSHOT_API_KEY`, `DEEPSEEK_API_KEY`, `OLLAMA_BASE_URL`, AWS vars,
  `claude` CLI).
- **ainish-coder** has its own `providers.json` and `providers.txt`
  with a different naming convention (`WAFER_SERVERLESS_API_KEY` vs
  `CODEX_WAFER_SERVERLESS_KEY`), prioritizing the canonical cross-tool
  names from `providers.txt`.
- **PQC secrets** stores keys under the canonical names from
  `providers.txt`, decrypted only into env vars at runtime.

The bridge script reconciles all three so that **one
`source scripts/graphify-env.sh` call** makes graphify work with
whichever provider is currently loaded, without writing any
plaintext keys to disk or shell history.

### 13.10 Deploying the bridge with `--skills`

The script is part of the skill pack, so `ainish-coder --skills` ships
it to every project that uses this skill. Each deployment is a symlink
(by default) to the canonical source in this repo, so edits propagate
automatically. To copy instead: `ainish-coder --skills -y .` then
`rm .agents/skills/graph-intelligence/scripts/graphify-env.sh && cp <new>`.

---

## Appendix A — One-Page Cheat Sheet

```text
═══════════════════════════════════════════════════════════════════════
 GitNexus — operational layer (code call-graph, AST-precise)
═══════════════════════════════════════════════════════════════════════
  Discover:  list_repos
  Cheap:     READ gitnexus://repo/{name}/context
             READ gitnexus://repo/{name}/processes
             READ gitnexus://repo/{name}/schema        (before cypher)
  Search:    query({query, repo, limit})               processes + symbols
  Symbol:    context({name, repo, file_path?, kind?, uid?})
  Blast:     impact({target, direction, repo, minConfidence, maxDepth})
  API:       route_map / tool_map / shape_check / api_impact
  Changes:   detect_changes({repo, scope, base_ref})
  Rename:    rename({symbol_name, new_name, dry_run: true})
  Raw:       cypher("MATCH ... WHERE r.confidence > 0.8 ...")
  Multi:     repo: "@<group>" / "@<group>/<memberPath>"
  Resources: gitnexus://group/{name}/contracts  ?type=Route&unmatchedOnly=true
             gitnexus://group/{name}/status
  Prompts:   detect_impact, generate_map
  CLI:       gitnexus analyze [--embeddings] [--skills] [--skip-...]
             gitnexus serve / mcp / list / status / clean / wiki
  Hooks:     gitnexus setup  (PreToolUse + PostToolUse)
═══════════════════════════════════════════════════════════════════════
 Graphify — semantic layer (multimodal, code+docs+papers+video+image)
═══════════════════════════════════════════════════════════════════════
  Build:     graphify update . [--no-cluster] [--force] [--mode deep] [--watch]
             graphify extract ./docs --backend {gemini|kimi|claude|openai|deepseek|ollama|bedrock|claude-cli}
  Query:     graphify query "..."  [--dfs] [--budget N] [--graph PATH]
  Path:      graphify path "A" "B"
  Explain:   graphify explain "X"
  Ingest:    graphify add <url|youtube|file>  (PDF / video / docs / images / workspace)
  Export:    --svg / --graphml / --neo4j / --neo4j-push / --obsidian / --wiki
             graphify export callflow-html [--max-sections 8]
  PR:        graphify prs [--triage] [--conflicts] [--worktrees] [--base main]
  Multi:     graphify merge-graphs a.json b.json --out merged.json
             graphify extract ./repo --global --as myrepo
  Cluster:   graphify cluster-only . [--resolution 1.5] [--exclude-hubs 99] [--no-label]
             graphify label . --backend=openai
  Hooks:     graphify hook install    (post-commit + git merge driver for graph.json)
  MCP:       python -m graphify.serve graphify-out/graph.json
             Tools: query_graph, get_node, get_neighbors, get_community,
                    god_nodes, graph_stats, shortest_path,
                    list_prs, get_pr_impact, triage_prs
  Confidence: EXTRACTED > INFERRED > AMBIGUOUS
═══════════════════════════════════════════════════════════════════════
 Provider Bridge (PQC + providers.txt → graphify) — see §13
═══════════════════════════════════════════════════════════════════════
  secrets-load                                                     # decrypt PQC bundle → env
  source scripts/graphify-env.sh                                    # auto-pick: zai → xiaomi-mimo → ...
  graphify extract ./docs                                           # uses env (default: zai/glm-5.1)
  GRAPHIFY_PROVIDER=zenmux source scripts/graphify-env.sh           # force exact provider
  GRAPHIFY_PROVIDER_PRIORITY="zenmux kimi zai" source …             # try in order, fall through
  GRAPHIFY_BACKEND=openai source scripts/graphify-env.sh            # force graphify backend
  GRAPHIFY_MODEL=openai/gpt-5-codex source scripts/graphify-env.sh  # override model
  graphify update . --no-cluster                                    # AST-only, no LLM
═══════════════════════════════════════════════════════════════════════
 Pre-Edit Safety (mandatory)
═══════════════════════════════════════════════════════════════════════
  1. detect_changes({repo})            — index fresh?
  2. context({name, repo})             — understand the symbol
  3. impact({target, "upstream", repo, minConfidence: 0.8})
  4. if risk >= MEDIUM → user confirmation
  5. edit
  6. gitnexus analyze --index-only     — re-index
  7. detect_changes({repo})            — verify
═══════════════════════════════════════════════════════════════════════
```

---

*Version 2.0.0 — built from a deep read of GitNexus 1.7.0+ source
(`gitnexus/src/mcp/{server,tools,resources,prompts}.ts`,
`ARCHITECTURE.md`, `RUNBOOK.md`, `pr-swarm-review/orchestration.md`)
and Graphify 0.8.31 source (`graphify/serve.py`, `extract.py`,
`ARCHITECTURE.md`, `CHANGELOG.md`, `README.md`).*
