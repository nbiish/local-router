# Memory CRUD Lifecycle & Tooling Reference Matrix

Reference cheat-sheet for coding agents operating the dual-substrate memory layer across **Memorix**, **Reference Memory**, **Engram**, and the Git-tracked **`.agents/memories/`** repository layer.

---

## 1. Quick Reference Matrix Across Substrates

| Action | Memorix (Facts & Decisions) | Reference Memory (Entity Graph) | Engram (Session Memory) | Git-Tracked (`.agents/memories/`) |
|---|---|---|---|---|
| **Make (Create)** | `memorix_store(...)` | `create_entities(...)`<br>`create_relations(...)` | `mem_save(...)`<br>`mem_session_summary(...)` | Append to `## Active Facts`, `## Active Decisions`, or `## Active Gotchas` |
| **Update (Revise)** | `memorix_store(topicKey=existing, ...)` | `add_observations(...)`<br>`create_relations(...)` | `mem_update(id, ...)` | Mutate entry in place with tag `[UPDATED YYYY-MM-DD]` |
| **Delete / Resolve** | `memorix_resolve(fact_id=...)` | `delete_entities(...)`<br>`delete_relations(...)`<br>`delete_observations(...)` | `mem_delete(observation_id=...)` | Move to `## Resolved / Retired Archive` with resolution note |
| **Query / Recall** | `memorix_search(query=...)`<br>`memorix_project_context()` | `search_nodes(query=...)`<br>`read_graph()` | `mem_search(query=...)`<br>`mem_context()` | Read `MEMORY.md`; grep `exports/` |

---

## 2. Memorix Inscription & CRUD Details

Memorix is the primary store for codebase facts, gotchas, architectural decisions, and invariants anchored to Git roots.

### 2.1 Make (Create)
```json
// Tool: memorix_store
{
  "entityName": "symlink-guard",
  "type": "fact",
  "title": "AGENTS.md symlink protection uses BSD uchg on Darwin",
  "narrative": "On macOS, AGENTS.md is locked with chmod 444 followed by BSD chflags uchg. chflags uchg must be unlocked with nouchg before chmod 644 on edit.",
  "topicKey": "agents-protection:darwin-uchg",
  "scope": "src/agents_protection.sh",
  "facts": [
    "chmod must precede chflags uchg because chmod fails with EPERM when uchg is active",
    "Linked to task: 2026-09-19.posix-cross-platform-task.md"
  ]
}
```
**CLI Fallback:**
```bash
memorix remember "AGENTS.md symlink protection uses BSD uchg on Darwin (task: 2026-09-19.posix-cross-platform-task.md, ast: lock_agents_contract)"
```

### 2.2 Update (Revise)
Re-call `memorix_store` using the **same `topicKey`** to update the narrative and facts in place. Memorix reconciles updates under the same topic key without creating duplicate conflicting records.

### 2.3 Delete / Resolve (Retire)
```json
// Tool: memorix_resolve
{
  "id": "fact-xyz123"
}
```
**CLI Fallback:**
```bash
memorix resolve <fact-id>
```

---

## 3. Reference Memory Entity Graph CRUD Details

Reference Memory manages architectural components, microservices, and system entities in a portable graph.

### 3.1 Make (Create Entities & Relations)
```json
// Tool: create_entities
{
  "entities": [
    {
      "name": "agents-protection-module",
      "entityType": "ShellModule",
      "observations": [
        "Path: src/agents_protection.sh",
        "Enforces OS write protection on root AGENTS.md across Linux, Darwin, and Windows"
      ]
    },
    {
      "name": "canonical-rules-contract",
      "entityType": "GovernanceContract",
      "observations": [
        "Path: AGENTS.md",
        "Singular symlink target deployed to all downstream repositories"
      ]
    }
  ]
}

// Tool: create_relations
{
  "relations": [
    {
      "from": "agents-protection-module",
      "to": "canonical-rules-contract",
      "relationType": "locks_and_unlocks"
    }
  ]
}
```

### 3.2 Update (Add Observations)
```json
// Tool: add_observations
{
  "observations": [
    {
      "entityName": "agents-protection-module",
      "contents": [
        "Updated 2026-09-19: Added multi-tier SHA256 checksum fallback (openssl, python, powershell, cksum)"
      ]
    }
  ]
}
```

### 3.3 Delete (Entities, Relations, Observations)
```json
// Tool: delete_observations
{
  "deletions": [
    {
      "entityName": "agents-protection-module",
      "observations": ["Obsolescent observation text to prune"]
    }
  ]
}

// Tool: delete_entities (cascades relations)
{
  "entityNames": ["deprecated-subsystem-name"]
}
```

---

## 4. Engram Curated Session CRUD Details

Engram captures session milestones, turn-by-turn bookmarks, and arbitrates conflicting decisions.

### 4.1 Make (Save Observation or Session Summary)
```json
// Tool: mem_save
{
  "title": "Cross-platform xargs gotcha",
  "type": "gotcha",
  "content": "macOS BSD xargs rejects -r (--no-run-if-empty). Use portable while IFS= read -r loops instead.",
  "topic_key": "portable-hooks:xargs",
  "scope": "scripts/setup-hooks.sh"
}

// Tool: mem_session_summary
{
  "summary": "Completed memory CRUD lifecycle integration in AGENTS.md, SKILL.md, and .agents/memories. Verified green gates."
}
```

### 4.2 Update (Mutate Existing Observation)
```json
// Tool: mem_update
{
  "id": 42,
  "title": "Updated port configuration",
  "content": "Standard backend port updated to 8888 after unsloth integration.",
  "type": "fact"
}
```

### 4.3 Delete (Remove Obsolete Observation)
```json
// Tool: mem_delete
{
  "id": 42
}
```

---

## 5. Git-Tracked `.agents/memories/MEMORY.md` Schema

The singular Git-tracked record layer follows a strict markdown format.

### 5.1 Format Syntax
```markdown
- [YYYY-MM-DD] [STATE] <statement> *(source: <tool/server>, task: <task-file-or-branch>, ast: <symbol>)*
```
Where `[STATE]` is one of:
- `[ACTIVE]` — Current truth and active invariant.
- `[UPDATED YYYY-MM-DD]` — Invariant that has evolved, noting update date.
- `[RESOLVED YYYY-MM-DD]` — Retired fact/gotcha, moved to the Archive section with resolution explanation.

### 5.2 Section Layout
```markdown
# MEMORY — <project-name> (curated digest)

## Active Facts
- [2026-09-19] [ACTIVE] Fact description... *(source: feat/xyz, ast: abc)*

## Active Decisions
- [2026-09-19] [ACTIVE] Decision rationale... *(source: operator directive)*

## Active Gotchas
- [2026-09-19] [ACTIVE] Gotcha warning... *(source: tests/unit.test.ts)*

## Resolved / Retired Archive
- [2026-09-19] [RESOLVED 2026-09-19] Workaround for bug X is retired because upstream PR #123 fixed the root issue. *(source: feat/fix-x)*
```
