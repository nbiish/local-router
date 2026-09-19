---
name: repo-memory-graph-intelligence
description: Dual-substrate codebase intelligence and persistent repo-memory (GitNexus AST code graph + Memorix/Reference-Memory/Engram persistent memory). MANDATORY FIRST STEP for any non-trivial coding task: inspect call-chains and blast-radius with GitNexus ("WHERE") and recall architectural decisions, gotchas, and invariants from Repo-Memory ("WHY") BEFORE touching code. Continuously executes the active memory CRUD lifecycle (Make, Update, Delete/Resolve) across chat sessions and tasks, anchoring durable facts to AST symbols and updating the .agents/memories/ digest and exports. Trigger on: any code navigation, "how does X work", "what calls Y", "what breaks if I change Z", blast radius, architectural decisions, gotchas, or before editing unfamiliar code.
---

# Dual-Substrate Codebase Intelligence & Persistent Repo-Memory

> **The Dual-Substrate Law:**
> 1. Codebase AST intelligence without memory is **blind**: you map the call graph but repeat past architectural regressions and violate unwritten invariants.
> 2. Memory without codebase AST intelligence is **unanchored**: you recall past discussions and intentions but miss current call hierarchies and blast-radius impacts.
> 3. Together, **GitNexus (AST Code Graph)** and **Repo-Memory (Memorix + Reference Memory + Engram)** form an unshakeable engineering cockpit: **GitNexus tells you WHERE, Repo-Memory tells you WHY.**

---

## 🚧 MANDATORY FIRST STEP FOR ALL INTAKING AGENTS

**Before modifying, refactoring, or diagnosing code in this repository, you MUST execute the Dual-Recon Loop:**

```
          ┌──────────────────────────────────────────────────────────┐
          │               MANDATORY DUAL-RECON LOOP                  │
          └────────────────────────────┬─────────────────────────────┘
                                       │
                 ┌─────────────────────┴─────────────────────┐
                 ▼                                           ▼
      [1. AST RECON — WHERE]                      [2. MEMORY RECON — WHY]
   Run GitNexus on target symbol              Query Repo-Memory for symbol/area
   • gitnexus context <symbol>                • memorix_search / memorix_context
   • gitnexus impact <symbol>                 • mem_search / mem_context
   • Identify callers, callees, tests         • Recall invariants, gotchas, fixes
                 │                                           │
                 └─────────────────────┬─────────────────────┘
                                       ▼
                         [3. SYNTHESIZE RECONNAISSANCE]
                  Verify proposal against BOTH AST structure
                        and historical architectural invariants
                                       ▼
                           [4. EXECUTE CODE EDIT]
```

Never emit code edits based on intuition or simple grep alone when AST graphs and persistent memory are available.

---

## 1. Division of Labor: The Two Substrates

| Concern | Substrate | Engine / Tool | Storage | Core Question Answered |
|---|---|---|---|---|
| **AST Code Graph** | Static Call Hierarchy | `gitnexus` (CLI / MCP) | `.gitnexus/` AST DB | **WHERE** does this symbol live, who calls it, and what breaks if it changes? |
| **Project Facts & Decisions** | Persistent Memory | `memorix` (MCP / CLI) | SQLite | **WHAT** are the enduring rules, gotchas, and reasoning behind this module? |
| **Entity Relationships** | Knowledge Graph | `reference_memory` (MCP) | JSONL graph | **HOW** are named concepts, subsystems, and services related across repos? |
| **Curated Session Bookmarking** | Session Memory | `engram` (MCP / CLI) | SQLite + FTS5 | **WHEN** were past decisions made, and how to resolve conflicting views? |
| **Git-Tracked Durability** | Repo Memory Layer | `.agents/memories/` | Markdown + JSON | **SURVIVES** cross-machine git push even when local MCP databases are absent. |

---

## 2. The 4 Symbiotic Bridges (The Dual-Substrate Engine)

The power of this unified skill lies in the continuous, automated feedback loop between the AST graph and persistent memory:

```
                  ┌─────────────────────────────────────────┐
                  │          THE 4 SYMBIOTIC BRIDGES        │
                  └────────────────────┬────────────────────┘
                                       │
       ┌───────────────────────────────┼───────────────────────────────┐
       ▼                               ▼                               ▼
[Bridge 1: AST Grounding]    [Bridge 2: Blast Healer]     [Bridge 3: Conflict Judge]
Link every stored memory     For every symbol in blast    Arbitrate contradictory
fact to exact AST symbols    radius, query memory for     memories using GitNexus
from GitNexus.               hidden invariants.           AST ground truth.
       │                               │                               │
       └───────────────────────────────┼───────────────────────────────┘
                                       ▼
                        [Bridge 4: Post-Mortem Loop]
                        Inscribe fixes and gotchas into
                        memory and refresh .agents/memories/
```

### Bridge 1: AST Grounding $\rightarrow$ Memory Inscription
- **Rule:** Never store vague, untethered memories like *"the auth function had a bug"*.
- **Execution:** First run `gitnexus context <symbol>` to resolve the exact canonical symbol name and file path (e.g., `resolveRealServiceBinary` in `bin/local-router.js`). Then store the fact in `memorix` or `engram` referencing that exact AST symbol.
- **Result:** Future queries on that symbol will instantly retrieve its precise architectural context.

### Bridge 2: Blast-Radius Healer $\rightarrow$ Decision Recall
- **Rule:** When modifying an existing symbol, a green compiler does NOT guarantee zero regression.
- **Execution:**
  1. Run `gitnexus impact <symbol> --direction downstream` to list all direct and indirect callers.
  2. For every critical downstream caller identified in the blast radius, run `memorix_search` or `mem_search` on its symbol name.
  3. Verify whether any caller relies on undocumented side effects, environment variables, or port contracts discovered in past tasks.

### Bridge 3: Conflict Arbitration via AST Ground Truth
- **Rule:** When two memory records disagree (e.g., an older memory says *"port is 8000"* and a newer says *"port is 8888"*):
- **Execution:**
  1. Do not guess or narrate debate.
  2. Run `gitnexus query` or inspect AST definitions to determine the active codebase reality.
  3. Run `engram judge` or `memorix_resolve` to resolve the stale memory record and mark it obsolete.

### Bridge 4: Post-Mortem Loop $\rightarrow$ `.agents/memories/` Digest
- **Rule:** Every bug fix, unexpected dependency, or runtime gotcha must outlive the current conversation.
- **Execution:**
  1. Store the gotcha into `memorix` (`memorix_store`) and `engram` (`mem_session_summary`).
  2. Append the verified architectural fact into the Git-tracked `.agents/memories/MEMORY.md`.
  3. Refresh the `.agents/memories/exports/` snapshots before session checkout.

---

## 3. Substrate 1: GitNexus AST Intelligence Reference

GitNexus indexes the repository using Tree-sitter parsers into an AST knowledge graph stored locally in `.gitnexus/`. It has zero LLM overhead and runs in milliseconds.

### Fast CLI Commands

```bash
# 1. Analyze / index repository (run once or after major branch merges)
gitnexus analyze

# 2. Context reconnaissance: symbol definition, direct callers, callees, references
gitnexus context <symbol-name>
# Example: gitnexus context resolveRealServiceBinary

# 3. Blast-radius impact analysis: what breaks if this symbol changes?
gitnexus impact <symbol-name>
gitnexus impact <symbol-name> --direction downstream   # Callers affected
gitnexus impact <symbol-name> --direction upstream     # Callees depended on

# 4. Search symbols across repository
gitnexus query <pattern>

# 5. Safe coordinated rename with blast-radius check
gitnexus rename <old-symbol> <new-symbol> --dry-run
gitnexus rename <old-symbol> <new-symbol>

# 6. Diff impact: check impact of changes in git working tree / commit
gitnexus diff
gitnexus diff HEAD~1

# 7. Index status & diagnostics
gitnexus status
gitnexus clean
```

### MCP Tool Equivalents (when operating inside an MCP-enabled agent harness)

| CLI Command | MCP Tool Call | Description |
|---|---|---|
| `gitnexus context <sym>` | `mcp__gitnexus__context` | Symbol definition, caller/callee list, references |
| `gitnexus impact <sym>` | `mcp__gitnexus__impact` | Multi-hop blast-radius calculation |
| `gitnexus query <pattern>` | `mcp__gitnexus__query` | Fast regex/fuzzy symbol search across AST |
| `gitnexus status` | `mcp__gitnexus__status` | Node/edge counts, index freshness |

### Reading Blast Radius Output

```
Impact Analysis for: standardLocalBackendPort
Severity: HIGH (3 direct callers, 8 indirect callers, 2 test suites)
Direct Callers:
  ├─ ensureStandardLocalBackends (src/index.ts:670) [CRITICAL PATH]
  └─ customProviderPort (src/index.ts:712)
Indirect Callers:
  ├─ app.listen boot callback (src/index.ts:6961)
  └─ test "local backends register offline" (tests/local-backends.test.mjs:135)
```
- **Severity HIGH/CRITICAL:** You must inspect all direct callers before making the edit.
- **Test Suites Flagged:** Run the specific test suites identified by GitNexus immediately after editing.

---

## 4. Substrate 2: Persistent Repo-Memory MCP Reference

Three persistent memory MCP servers run locally and are available to any agent harness:
1. **`memorix`** (SQLite): Per-git-repo factual memory, decisions, gotchas, code facts.
2. **`reference_memory`** (JSONL): Entity-relation knowledge graph for architectural components.
3. **`engram`** (SQLite + FTS5): Curated session summaries, bookmarks, and conflict verdicts.

### Tool Routing & Protocol

| Kind of Knowledge | Destination | MCP Tool Call | CLI Fallback |
|---|---|---|---|
| Repository facts, gotchas, fixes | `memorix` | `memorix_store(kind="fact"|"gotcha"|"decision", content=...)` | `memorix remember "..."` |
| Full project orientation | `memorix` | `memorix_project_context()` | `memorix context` |
| Search repo memory | `memorix` | `memorix_search(query=...)` | `memorix search "..."` |
| Resolve / delete stale fact | `memorix` | `memorix_resolve(fact_id=...)` | `memorix resolve <id>` |
| Named entity relationships | `reference_memory` | `create_entities`, `create_relations` | Edit `exports/reference-graph.jsonl` |
| Search entity knowledge graph | `reference_memory` | `search_nodes(query=...)` | Grep `exports/reference-graph.jsonl` |
| Session open / start | `engram` | `mem_session_start(scope=...)` | `engram session start` |
| Session bookmark / summary | `engram` | `mem_session_summary(summary=...)` | `engram save "..."` |
| Search curated session logs | `engram` | `mem_search(query=...)` | `engram search "..."` |
| Resolve conflicting memories | `engram` | `mem_judge(conflict_id=..., verdict=...)` | `engram conflicts resolve` |

### Verified Tool Surfaces

- **`memorix`** (micro profile default; `--mode lite|team|full` scales to 20/28/47 tools):
  `memorix_project_context`, `memorix_context_pack`, `memorix_search` (query/limit/scope/type/since/status), `memorix_detail` (ids/typedRefs), `memorix_store` (entityName/type/title/narrative/facts/filesModified/concepts/topicKey/progress), `memorix_resolve`, `memorix_codegraph_status`. CLI: `memorix init --global`, `memorix setup --agent <name>`, `memorix doctor agents`, `memorix background start` (HTTP + dashboard `:3211/mcp`).
- **`reference_memory`** (9 tools):
  `create_entities`, `create_relations` (fails if endpoints missing), `add_observations`, `delete_entities` (cascades relations), `delete_observations`, `delete_relations`, `read_graph`, `search_nodes` (substring, ≤2048 chars), `open_nodes`. JSONL records: `{"type":"entity","name":...}` / `{"type":"relation","from":...,"to":...}`.
- **`engram`** (22 `mem_*` tools):
  `mem_current_project`, `mem_context`, `mem_search(query)`, `mem_timeline(observation_id)`, `mem_get_observation`, `mem_stats`, `mem_save(title,type,content,topic_key?,scope?)`, `mem_update`, `mem_save_prompt`, `mem_session_summary`, `mem_delete`, `mem_pin`/`mem_unpin`, `mem_review`, `mem_merge_projects`, `mem_doctor`, `mem_compare`, `mem_judge`. CLI: `engram tui`, `engram serve` (HTTP `127.0.0.1:7437`), `engram export/import`.

### Concrete Inscription Patterns

#### Pattern A: Inscribing a Gotcha / Fix (Bridge 1 & 4)
```json
// memorix_store
{
  "kind": "gotcha",
  "content": "Unsloth CLI starts its native backend on port 8888 (not 8000). Commands `unsloth start <agent>` (dsh, hermes) run `unsloth run -p 8888` under the hood. Local Router must intercept on 8888 and include 'start' and 'run' in serveSubcommands.",
  "scope": "local-router:unsloth-backend"
}
```

#### Pattern B: Inscribing Architectural Entity Relationships (Bridge 1)
```json
// create_entities
{
  "entities": [
    { "name": "unsloth-shim", "entityType": "ServiceShim", "observations": ["Drop-in CLI shim installed at ~/.local/bin/unsloth", "Resolves real binary lazily to Unsloth Studio"] },
    { "name": "local-router-proxy", "entityType": "ProxyService", "observations": ["Listens on localhost:11434", "Registers unsloth custom provider on port 8888"] }
  ]
}
// create_relations
{
  "relations": [
    { "from": "unsloth-shim", "to": "local-router-proxy", "relationType": "boots_and_registers" }
  ]
}
```

### Wiring Any Agent Harness (MCP stdio config)

All tools run as standard stdio MCP servers. Registration shape in your harness configuration (`mcpServers` JSON):

```json
{
  "mcpServers": {
    "gitnexus":          { "command": "gitnexus", "args": ["mcp"] },
    "memorix":           { "command": "memorix", "args": ["serve"] },
    "reference_memory":  { 
      "command": "mcp-server-memory",
      "env": {
        "MEMORY_FILE_PATH": "/home/<user>/.local/state/reference-memory/graph.jsonl"
      }
    },
    "engram":            { "command": "engram", "args": ["mcp"] }
  }
}
```

- **`reference_memory`:** ALWAYS set env `MEMORY_FILE_PATH` to an absolute, stable path. The unwired default lands inside the npm package cache and is wiped on package upgrades.
- **Engram env:** `ENGRAM_DATA_DIR` (data store), `ENGRAM_PROJECT` (project override), `ENGRAM_HTTP_TOKEN` (admin HTTP).
- **Memorix env:** `MEMORIX_DATA_DIR`, `MEMORIX_MODE` (tool profile: `micro`|`lite`|`team`|`full`).
- **Built-in agent installers:** Run `memorix setup --agent <name>` (claude, codex, cursor, windsurf, gemini-cli, opencode, etc.) and `engram setup <agent>` to automatically generate valid config.
- **Launch root:** Always launch from inside the target Git repository so GitNexus, Memorix, and Engram auto-bind to the current repository root.

### Installation on a New Machine

```bash
# Prerequisites: Node.js >= 22.18, Go 1.24+ (if building engram from source)
npm install -g gitnexus
npm install -g memorix
npm install -g @modelcontextprotocol/server-memory
go install github.com/Gentleman-Programming/engram/cmd/engram@v1.20.0
# Or prebuilt Engram: https://github.com/Gentleman-Programming/engram/releases

# Initialize global configs
memorix init --global
gitnexus analyze
```

### Verification Smoke Test (run after install or upgrade)

1. **GitNexus Status:** Run `gitnexus status` to verify the Tree-sitter AST database is healthy and symbol counts are populated.
2. **MCP JSON-RPC Handshake:** Send newline-delimited JSON-RPC `initialize` -> `notifications/initialized` -> `tools/list` to each server (`memorix serve`, `mcp-server-memory`, `engram mcp`, `gitnexus mcp`).
3. **Write / Read Roundtrip:**
   - Memorix: `memorix remember "smoke-test-token-<rand>"` -> `memorix search smoke-test-token`
   - Engram: `engram mcp` -> run `mem_doctor`
   - Memorix: `memorix doctor agents` for agent harness hook health.

### Hygiene, Privacy & Coordination Directives

- **PQC Secrets:** Server API keys (if any) live encrypted in the PQC secrets manager (`~/.config/pqc-secrets/secrets.bundle.json`) — never in plaintext config files on disk.
- **Privacy & Sanitization:** All stores are local-only. Scrub operator identifiers, credentials, and raw trajectories before committing or syncing anything derived from memory.
- **Not the System of Record:** Durable cross-machine coordination lives in the repository's `.agents/{comms,tasks,handoffs}/` triad. Live MCP databases are per-machine caches; `.agents/memories/` is the git-portable knowledge record. Never record a task claim exclusively in memory.

### Known Gotchas

- **Reference Memory:** `create_relations` will fail if either entity endpoint does not already exist in the graph. `search_nodes` is substring-only (no semantics) — route fuzzy queries to Memorix or Engram.
- **Engram:** Project detection keys off the git remote URL. If a repo remote changes, run `mem_merge_projects` to reconcile project keys. `mem_search` requires the `query` parameter (passing `q` returns an FTS5 syntax error).
- **Memorix:** Pins project context to the Git root. Launch from inside the repo or pass `projectRoot` explicitly on HTTP sessions.
- **GitNexus:** If symbols appear missing after major branch checkouts or renames, run `gitnexus clean && gitnexus analyze` to regenerate `.gitnexus/`.

---

## 5. The Git-Tracked `.agents/memories/` Persistence Layer

While SQLite and JSONL MCP servers provide instantaneous per-machine querying, the `.agents/memories/` directory inside the repository is the **authoritative, git-tracked memory layer** that travels with git push to peer agents and machines.

### Directory Layout
```
.agents/memories/
├── llms.txt                     # Contract: rules, scopes, and schema of the memory layer
├── MEMORY.md                    # Curated human- and agent-readable memory digest
└── exports/                     # Machine-readable sync snapshots
    ├── memorix.<repo>.json      # Exported Memorix facts and gotchas
    ├── reference-graph.jsonl    # Exported Reference Memory entities and relations
    └── engram.json              # Exported Engram curated session summaries
```

### The Continuous Session & Task Memory Lifecycle Protocol

Memory is active, not passive. In every chat turn and every task, agents execute the three-phase loop:

#### Phase A: Turn & Session Inception (Orient)
1. Query local memory stores immediately upon receiving instructions: `memorix_project_context`, `mem_context`.
2. Offline fallback: If MCP servers are offline, read `.agents/memories/MEMORY.md` and grep `.agents/memories/exports/`.
3. Check for existing invariants or gotchas relating to the current prompt, target symbols, or subsystem before writing code.

#### Phase B: In-Flight CRUD Mutation (Act)
1. **Make:** As new architectural insights, gotchas, or decisions emerge, immediately inscribe them in `memorix` (`memorix_store`) and `engram` (`mem_save`), anchored to canonical AST symbols.
2. **Update:** When code modifications change existing behavior, ports, signatures, or configurations, update existing memory records in place (`mem_update`, `memorix_store` with matching topicKey). Never leave obsolete statements in place.
3. **Delete / Resolve:** When dead symbols are removed or bugs are permanently fixed, immediately call `memorix_resolve`, `mem_delete`, or `delete_observations`.

#### Phase C: Task Verification & Session Wrap-up (Consolidate)
1. **Update Digest:** Add or update verified facts in `.agents/memories/MEMORY.md` with explicit status tags (`[ACTIVE]`, `[UPDATED YYYY-MM-DD]`, `[RESOLVED YYYY-MM-DD]`).
2. **Refresh Snapshots:**
   ```bash
   memorix export > .agents/memories/exports/memorix.$(basename "$PWD").json 2>/dev/null || true
   engram export > .agents/memories/exports/engram.json 2>/dev/null || true
   ```
3. **Commit on Branch:** Commit changes in `.agents/memories/` alongside code changes on the task branch before merge.

---

## 6. End-to-End Execution Checklist for Coding Agents

When tasked with any non-trivial code modification, follow this deterministic checklist:

- [ ] **1. ORIENT (WHERE):** Run `gitnexus context <target_symbol>` to identify file locations, direct callers, callees, and dependencies.
- [ ] **2. RECALL (WHY):** Run `memorix_search <target_symbol>` and `mem_search <target_symbol>` (or read `.agents/memories/MEMORY.md`) for known failure modes, invariants, and historical rationale.
- [ ] **3. IMPACT CHECK:** Run `gitnexus impact <target_symbol>` to establish the exact blast-radius boundary.
- [ ] **4. IMPLEMENT:** Apply minimal, surgical edits respecting established invariants.
- [ ] **5. MUTATE MEMORY (IN-FLIGHT):**
  - Inscribe new gotchas or decisions (`memorix_store`, `mem_save`).
  - Update changed contracts (`mem_update`, `memorix_store` with same topicKey).
  - Resolve/delete obsolete gotchas or dead symbols (`memorix_resolve`, `mem_delete`, `delete_observations`).
- [ ] **6. VERIFY:** Run targeted tests flagged in the GitNexus impact analysis; confirm no memory regressions.
- [ ] **7. SYNC MEMORY DIGEST:** Update `.agents/memories/MEMORY.md` with lifecycle tags and commit alongside code changes.

---

## 7. The Memory CRUD Lifecycle Engine: Chat Session & Task Integration

Persistent memory functions as an active operating substrate. Every agent turn and task must participate in the continuous CRUD lifecycle:

### 7.1 The Three Lifecycle Planes

```
 ┌─────────────────────────┐     ┌─────────────────────────┐     ┌─────────────────────────┐
 │   CHAT SESSION PLANE    │     │       TASK PLANE        │     │    MEMORY CRUD PLANE    │
 ├─────────────────────────┤     ├─────────────────────────┤     ├─────────────────────────┤
 │ • Turn Start (Orient)   │ ──► │ • Task Claim (checkin)  │ ──► │ • MAKE (Inscribe)       │
 │ • In-Flight Execution   │     │ • Dual-Recon Loop       │     │ • UPDATE (Revise)       │
 │ • Turn Close (Summary)  │     │ • Pre-Merge & Checkout  │     │ • DELETE/RESOLVE (Retire)│
 └─────────────────────────┘     └─────────────────────────┘     └─────────────────────────┘
```

### 7.2 The Make (Create / Inscribe) Protocol
- **When to Inscribe:**
  1. A non-obvious bug fix or gotcha is identified (e.g. platform-specific flag behavior, undocumented port requirement).
  2. A core architectural decision is finalized (e.g. choice of crypto algorithm, data store design).
  3. A new service, subsystem, or component relationship is established.
- **Required Inscription Metadata:**
  - `task_ref`: Task file name (e.g. `2026-09-19.memory-lifecycle-task.md`) or branch slug.
  - `ast_symbol`: Exact AST symbol name resolved via `gitnexus context <symbol>`.
  - `kind`: `fact` | `decision` | `gotcha`.
  - `topic_key`: Namespaced unique identifier (e.g. `auth:token-rotation`).
- **Tool Invocations:**
  - Memorix: `memorix_store(entityName, type, title, narrative, topicKey, scope, facts)`
  - Reference Memory: `create_entities(entities=[...])`, `create_relations(relations=[...])`
  - Engram: `mem_save(title, type, content, topic_key, scope)`

### 7.3 The Update (Revise / Evolve) Protocol
- **When to Update:**
  1. A subsystem port, configuration flag, or default parameter is altered.
  2. An API signature or return type is updated.
  3. A previously recorded invariant is modified to support new requirements.
- **Protocol:**
  1. Locate the existing entry: `memorix_search <query>` or `mem_search <query>`.
  2. Overwrite in place:
     - Memorix: Re-call `memorix_store` with the **same `topicKey`** to update the narrative and facts.
     - Engram: Call `mem_update(id=..., title=..., content=..., type=...)`.
     - Reference Memory: Call `add_observations` on the target entity.
  3. In `.agents/memories/MEMORY.md`, update the entry in place and append the update tag:
     `- [2026-09-10] [UPDATED 2026-09-19] New behavior description... *(source: feat/branch, ast: symbol)*`

### 7.4 The Delete / Resolve (Retire / Invalidate) Protocol
- **When to Delete / Resolve:**
  1. A dead function, class, or module is removed or superseded.
  2. A temporary workaround or gotcha is rendered obsolete by a permanent code fix.
  3. An architectural pattern is deprecated and completely removed from the codebase.
- **Protocol:**
  1. Locate target record ID: `memorix_search` or `mem_search`.
  2. Delete or mark resolved in MCP stores:
     - Memorix: `memorix_resolve(fact_id="...")` marks the fact resolved.
     - Engram: `mem_delete(observation_id=...)` purges the obsolete observation.
     - Reference Memory: `delete_observations(...)` or `delete_entities(...)`.
  3. In `.agents/memories/MEMORY.md`, move the item from `## Active *` to `## Resolved / Retired Archive`:
     `- [2026-09-10] [RESOLVED 2026-09-19] Stale gotcha text... — RESOLUTION: Superseded by upstream POSIX fix in feat/branch.`
- **Zero-Tolerance Rule:** Never allow obsolete constraints to remain active. Stale memory corrupts downstream agent reasoning.

### 7.5 Turn-by-Turn Chat Session Playbook
When an operator gives instructions in a conversation turn:
1. **Turn Inception:** Check `.agents/memories/MEMORY.md` or call `memorix_project_context`. If the user asks about a specific feature, immediately query memory for known constraints.
2. **During the Turn:** If the turn introduces or resolves an architectural fact, immediately record or update the corresponding memory.
3. **Turn Conclusion:**
   - Save turn milestone to Engram: `mem_session_summary(summary="...")`.
   - Update `.agents/memories/MEMORY.md` with any newly verified facts.
   - Append masters' review to `.agents/suggestions/{date}-suggestions.md`.
   - See detailed schema matrix in `references/memory-crud-matrix.md`.
