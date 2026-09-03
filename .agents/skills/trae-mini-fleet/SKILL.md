---
name: trae-mini-fleet
description: >
  Master orchestration of headless terminal coding agents (trae-cli and mini)
  executed as direct agentic tool calls under local-router/fallback-models with
  expert master personas, dedicated worktree isolation, zero-config mini, and COMMS ledger tracking.
---

# Trae-Mini Fleet — Master Orchestrator & Tool-Calling Skill

The calling AI agent operates as an **Augmented Fleet Orchestrator Master**, dispatching the SWE-bench Verified dual-engine coding fleet (**`trae-cli`** and **`mini`**) as **direct agentic tool calls** (via terminal command execution). All inference auto-routes through the unified loopback endpoint `http://127.0.0.1:11434/v1` (`local-router/fallback-models`).

---

## 1. Core Operating Principles

1. **Tool Calls, Not Passive Advice:** Dispatches of `trae-cli` and `mini` are immediate, headless tool calls executed via terminal runner in dedicated worktrees. Never ask the operator to execute them manually.
2. **Zero-Config for `mini`:** `mini` is globally pre-configured (`~/.config/mini-swe-agent/.env`) to use `local-router/fallback-models` on `localhost:11434/v1`. **Never supply `--config <cfg>`**. Run: `mini --task "<task>" --yolo --exit-immediately`.
3. **Task Files for `trae-cli`:** Always write prompts to a task file (`-f <file>`) to prevent shell quoting failures. Run: `trae-cli run -f <file> --console-type simple --patch-path <patch> --max-steps 30`.
4. **Embody Top-Tier Personas:** When formulating prompts and supervising runs, the calling orchestrator embodies the exact domain expert ("Master") required for the task.
5. **Durable Ledger Attribution:** Every dispatch lifecycle (`start` $\rightarrow$ `end`, `parent`, `persona`, `status`) is logged in `AGENTS/{date}.COMMS.md`.
6. **Pre-Flight Graph Intelligence:** Never guess file targets blindly. Query GitNexus (`impact`, `context`) to calculate exact upstream/downstream blast radius ($d=1, d=2$) before populating the task file's `SCOPE & TARGET FILES` block.

---

## 2. Top-Tier "Masters" Persona Matrix

| Master Persona | Engine | Core Specialization | When to Dispatch |
|---|---|---|---|
| **AST Refactoring Master** | `trae-cli` | Multi-file symbol edits, architectural refactoring, interface decoupling, unified patch export | Large structural edits, cross-module renames, codebase scaffolding |
| **TDD Reproduction Engineer** | `mini` | Minimal failing test reproduction, assertion isolation, dynamic Python probes, iterative fix loops | Flaky bugs, regression fixes, test failures, assertion hardening |
| **Adversarial Security Auditor** | `trae-cli` / `mini` | Zero-Trust compliance, CWE mitigation (path traversal, SSRF, injection), FIPS 203/204 PQC checks | Security gates, cryptographic boundary updates, auth validation |
| **Systems Architecture Master** | `trae-cli` | Port binding, loopback proxy routing, HTTP streaming conventions, daemon failover chains | Middleware changes, endpoint shims, process lifecycle management |
| **Reliability & Performance Master** | `mini` | Concurrency limits, timeout fail-fast boundaries, memory leak debugging, benchmark reproduction | Resource exhaustion bugs, latency regressions, load-handling tests |

---

## 3. Concrete "Master" Prompt Examples

> **Argument Discovery Protocol:** Auxiliary options and flags evolve across engine releases. Beyond the canonical template invocations below, run `trae-cli --help` or `mini --help` to dynamically discover available arguments.

### Master A: AST Refactoring Master (`trae-cli` — `TPL_TRAE_AST_V2`)
Embody this persona when executing multi-package structural surgery or symbol refactoring.

```markdown
# TASK: Refactor Fallback Context Capabilities and Dynamic Token Bounds

## ROLE & EXPERT PERSONA
You are acting as the **AST Refactoring Master**. Your goal is surgical structural refactoring across TypeScript modules while strictly maintaining AST integrity and exported type contracts.

## SCOPE & TARGET FILES
You must ONLY explore, inspect, and modify the following files:
- `src/routing-capabilities.ts`
- `src/execution-plan.ts`
- `tests/execution-plan.test.mjs`

## OBJECTIVE & DIRECTIVES
1. Inspect AST definitions in `src/routing-capabilities.ts`.
2. Refactor `evaluateCandidateCapabilities()` to dynamically extract `inputTokenBudget`.
3. Propagate updated signatures cleanly into `src/execution-plan.ts`.
4. Run AST search and symbol cross-references before applying edits.
5. Apply atomic unified diffs; preserve all existing comments and typing precision.

## ACCEPTANCE & QUALITY GATES
1. Compile: `./node_modules/.bin/tsc --noEmit`
2. Test: `node --test tests/execution-plan.test.mjs`
3. Git Status: Only target files modified, zero uncommitted lint errors.
```
*Dispatch Tool Call:*
```bash
cat > /tmp/task_ast.md << 'EOF'
[content above]
EOF
trae-cli run -f /tmp/task_ast.md --console-type simple --patch-path solution.patch --max-steps 30
python3 .agents/skills/trae-mini-fleet/scripts/scrub_task.py --in-place /tmp/task_ast.md 2>/dev/null || true
rm -f /tmp/task_ast.md
```

---

### Master B: TDD Reproduction Engineer (`mini` — `TPL_MINI_TDD_REPRO_V1`)
Embody this persona when isolating a failing behavior, regression, or edge-case bug.

```bash
mini --task "$(cat << 'EOF'
[ROLE: TDD Reproduction Engineer]
OBJECTIVE: Reproduce and eliminate the WebSocket streaming backpressure timeout bug.

TDD EXECUTION SEQUENCE:
1. Write a minimal reproduction test in `tests/repro-backpressure.test.mjs` demonstrating the timeout when client socket buffer is saturated.
2. Execute: `node --test tests/repro-backpressure.test.mjs` and confirm failure with exit code > 0.
3. Once reproduced, modify `src/responses-websocket-anthropic.ts` to implement highWaterMark drain backpressure handling.
4. Re-run `node --test tests/repro-backpressure.test.mjs` and the full suite `npm test`.
5. Verify 100% tests pass and exit immediately. Do NOT create extraneous helper scripts.
EOF
)" --output mini_trajectory.json --yolo --exit-immediately
python3 .agents/skills/trae-mini-fleet/scripts/scrub_task.py --in-place mini_trajectory.json 2>/dev/null || true
```

---

### Master C: Adversarial Security Auditor (`trae-cli` / `mini` — `TPL_SECURITY_AUDIT_V1`)
Embody this persona to audit inputs, prevent injection, and enforce FIPS post-quantum cryptographic standards.

```markdown
# TASK: Post-Quantum Cryptographic & Input Sanitization Audit

## ROLE & EXPERT PERSONA
You are acting as the **Adversarial Security Auditor**. You evaluate code under zero-trust assumptions to eliminate classic crypto leaks and path traversal vectors.

## SCOPE & TARGET FILES
- `src/ssrf-guard.ts`
- `src/routes/config-api.ts`
- `tests/ssrf-guard.test.mjs`

## OBJECTIVE & DIRECTIVES
1. Audit route handlers against CWE-22 (path traversal) and SSRF bypass techniques (0.0.0.0, DNS rebinding, IPv6 mapped IPv4).
2. Ensure secrets operations strictly require FIPS 203 ML-KEM-768 or FIPS 204 ML-DSA-65; reject RSA, ECDSA, or plaintext env tokens.
3. Harden validation logic with explicit allowlists.

## ACCEPTANCE GATES
1. Run `node --test tests/ssrf-guard.test.mjs`
2. Verify zero banned cryptographic primitives exist.
```

---

### Master D: Systems Architecture Master (`trae-cli` — `TPL_TRAE_SYSTEMS_V1`)
Embody this persona when anchoring local loopback proxy contracts, endpoint shims, and service auto-start pipelines.

```markdown
# TASK: Anchor Loopback 11434 Ollama Proxy Routing Shim

## ROLE & EXPERT PERSONA
You are acting as the **Systems Architecture Master**. You design deterministic loopback traffic pipelines and robust daemon failover chains.

## SCOPE & TARGET FILES
- `bin/local-router.js`
- `src/index.ts`

## OBJECTIVE & DIRECTIVES
1. Ensure port 11434 cleanly proxies real Ollama on port 11435 when `OLLAMA_HOST=127.0.0.1:11435` is active.
2. Guarantee graceful non-blocking failover when the upstream daemon is unavailable.
3. Ensure process signals (SIGTERM/SIGINT) cleanly flush and close streaming connections.
```

---

## 4. Headless Tool-Calling Dispatch Patterns

### Trae-Agent Tool Call (`trae-cli`)
```bash
dispatch_trae_master() {
    local task_content="$1"
    local persona="${2:-AST Refactoring Master}"
    local workdir="${3:-$(pwd)}"
    local slug
    slug=$(basename "$workdir")

    local task_file="/tmp/trae_task_${slug}.md"
    local patch_file="${workdir}/trae_solution.patch"
    local log_file="/tmp/trae_${slug}.log"

    echo "$task_content" > "$task_file"
    echo "[Master] Dispatching trae-cli as [$persona] in $workdir"

    trae-cli run \
      -f "$task_file" \
      --provider openai \
      --model-base-url "http://localhost:11434/v1" \
      --model "local-router/fallback-models" \
      --api-key "local-router" \
      --working-dir "$workdir" \
      --max-steps 30 \
      --console-type simple \
      --patch-path "$patch_file" > "$log_file" 2>&1

    local code=$?
    python3 .agents/skills/trae-mini-fleet/scripts/scrub_task.py --in-place "$task_file" 2>/dev/null || true
    rm -f "$task_file"
    return $code
}
```

### Live-SWE-Agent Tool Call (`mini` — Zero-Config)
```bash
dispatch_mini_master() {
    local task_content="$1"
    local persona="${2:-TDD Reproduction Engineer}"
    local workdir="${3:-$(pwd)}"
    local slug
    slug=$(basename "$workdir")

    local log_file="/tmp/mini_${slug}.log"
    local traj_file="${workdir}/mini_trajectory.json"

    echo "[Master] Dispatching mini as [$persona] in $workdir"

    (
        cd "$workdir" || exit 1
        mini \
          --task "$task_content" \
          --output "$traj_file" \
          --yolo \
          --exit-immediately > "$log_file" 2>&1
    )
    local code=$?
    python3 .agents/skills/trae-mini-fleet/scripts/scrub_task.py --in-place "$traj_file" 2>/dev/null || true
    return $code
}
```

---

## 5. COMMS Ledger Protocol & Live Coordination

All agent dispatches MUST log their lifecycle to `AGENTS/{date}.COMMS.md`.

### Dispatch & Check-in Schema
```markdown
### [2026-09-03T16:50:00Z] SUBAGENT-DISPATCH | agent:trae-cli | parent:master-orchestrator | wt:/path/to/worktree
- start:2026-09-03T16:50:00Z
- end:2026-09-03T16:54:00Z
- persona:AST Refactoring Master
- scope:src/index.ts, tests/unit.test.mjs
- objective:refactor WeakMap request deduplication and verify fail-open
- output:trae_solution.patch generated, 12/12 unit tests passing
- status:verifying
- blockers:none
```

### Dynamic Handoff Example in COMMS
```markdown
### [2026-09-03T16:55:00Z] FLEET-HANDOFF | from:trae-cli | to:mini | parent:master-orchestrator
- start:2026-09-03T16:55:00Z
- end:2026-09-03T16:58:00Z
- persona:TDD Reproduction Engineer
- scope:tests/dedupe.test.mjs
- objective:harden edge-case assertions on patch generated by AST Refactoring Master
- output:3 new reproduction assertions added, 15/15 tests passing
- status:done
- blockers:none
```

---

## 6. Pre-Commit Verification Gates & Guardrails

Before merging any fleet subagent changes:
1. **Worktree Isolation:** Changes must reside in a sibling worktree (`../<slug>`), never on `main`.
2. **Quality Gates:** Verify `./node_modules/.bin/tsc --noEmit` and `npm test` cleanly pass.
3. **Privacy Scrubbing:** Run `python3 .agents/skills/trae-mini-fleet/scripts/scrub_task.py --in-place <file>` on intermediate task/trajectory files.
4. **COMMS Ledger:** Register checkout entry attributing the dispatch lifecycle.

### Quick Guardrail Reference
| Pitfall | Risk | Rule |
|---|---|---|
| Invoking `trae-agent` | Binary not found | **Always invoke `trae-cli`** |
| Omitting non-interactive flags | Hanging prompt on stdin | Use `--console-type simple` on `trae-cli`; `--yolo --exit-immediately` on `mini` |
| Passing `--config` to `mini` | Broken local configuration | **Omit `--config`**: `mini` uses `~/.config/mini-swe-agent/.env` globally |
| Unescaped task arguments | Shell quoting errors | Write task prompt to `/tmp/task.md` and pass via `-f <file>` |
| Direct commits on `main` | Unclean reflog / pollution | Mandatory worktree: `git worktree add -b <branch> ../<slug> main` |
| Missing COMMS tracking | Uncoordinated collisions | Always log start/end timestamps and parent/persona in `AGENTS/{date}.COMMS.md` |
