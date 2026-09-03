---
name: trae-mini-fleet
description: >
  Fleet orchestration of headless terminal coding agents (live-swe-agent and trae-agent)
  with the calling agent acting as the master orchestration agent. Sub-agents are configured
  under the Ollama endpoint (our local-router single config proxy/shim) using model
  local-router/fallback-models with per-dispatch git worktree isolation and verification gates.
---

# Trae-Mini Fleet — Headless Terminal Agent Orchestration

The calling AI agent acts as the **Master Orchestration Agent**, dispatching specialized headless terminal coding agents (`live-swe-agent` and `trae-agent`) to autonomously investigate, modify, and verify codebases. All fleet agents are configured under our unified **Ollama endpoint** proxy/shim (`http://localhost:11434/v1`), using the virtual routing model **`local-router/fallback-models`**.

---

## 1. Architecture Overview

```
Calling Agent (Master Orchestrator — Antigravity / Claude / Codex / Qwen)
  │
  ├─ 1. Evaluates operator goal & decomposes into discrete, testable coding units
  ├─ 2. Isolates execution in a dedicated Git Worktree (one dispatch = one worktree)
  ├─ 3. Selects optimal headless terminal agent:
  │      ├─ live-swe-agent  (interactive debugging, reproduction scripts, tool synthesis)
  │      └─ trae-agent      (AST code navigation, multi-file refactoring, patch extraction)
  │
  ├─ 4. Routes inference through Local-Router Single Config Proxy / Shim:
  │      Endpoint:  http://localhost:11434/v1  (Ollama endpoint)
  │      Model:     local-router/fallback-models
  │      (Handles 24-step fallback cascade, rate-limits, and provider auth transparently)
  │
  ├─ 5. Executes agent headlessly in worktree (non-interactive, batch mode, logged)
  ├─ 6. Harvests patch & trajectory, runs quality verification gates & tests
  └─ 7. Merges verified changes & cleans up worktree
```

---

## 2. Master Coding Terminal Agents

The fleet is comprised of two expert terminal-based coding engines:

### 1. Live-SWE-Agent (`mini` / `mini-live`)
- **Repository:** [https://github.com/OpenAutoCoder/live-swe-agent](https://github.com/OpenAutoCoder/live-swe-agent)
- **Pinned Release / Commit:** `v0.1.4` (`commit f52e89a64e18b8240a5fa7de21c97a5180f9bbfa`)
- **Installation Directive:** Clone and install pinned release via `uv` or `pip`:
  ```bash
  git clone https://github.com/OpenAutoCoder/live-swe-agent.git /tmp/live-swe-agent
  cd /tmp/live-swe-agent && git checkout f52e89a && pip install -e .
  ```
- **Core Strengths:**
  - **Dynamic Tool Synthesis:** Writes temporary Python helper scripts at runtime to investigate complex bugs.
  - **Test-Driven Problem Reproduction:** Generates reproducing test cases before altering production code.
  - **Iterative Bash Verification:** Executes in a continuous action/observation loop until tests pass.
- **CLI Invocations:**
  - Standard command: `mini --config <config.yaml> --task "<task>" --yolo --exit-immediately`
  - Vendor wrapper: `mini-live --task "<task>" --yolo` (loads `~/.config/mini-swe-agent/live-swe-agent.yaml`).

### 2. Trae-Agent (`trae-cli`)
- **Repository:** [https://github.com/bytedance/trae-agent](https://github.com/bytedance/trae-agent)
- **Pinned Release / Commit:** `v0.2.1` (`commit 8d4b3c1092e07173b22cf5c1f0d3a5a41571d871`)
- **Installation Directive:** Clone and install pinned release via `uv` or `pip`:
  ```bash
  git clone https://github.com/bytedance/trae-agent.git /tmp/trae-agent
  cd /tmp/trae-agent && git checkout 8d4b3c1 && uv tool install .
  ```
- **CRITICAL HARNESS NOTE:** The binary installed on PATH is **`trae-cli`** (invoking `trae-agent` directly fails with `zsh: command not found: trae-agent`).
- **Core Strengths:**
  - **Structural Codebase Navigation:** Built-in tools for AST search, symbol inspection, and directory mapping.
  - **Multi-File Architectural Refactoring:** Excels at broad edits across multiple interconnected packages.
  - **Patch & Trajectory Generation:** Natively outputs standalone unified diffs (`--patch-path`) and JSON action trajectories (`--trajectory-file`).
- **CLI Invocations:**
  - Headless batch mode: `trae-cli run -f <task_file> --console-type simple ...`

---

## 3. Local-Router Single Config Proxy / Shim

All fleet sub-agents connect exclusively through the **Ollama endpoint shim** hosted by `local-router`:

- **Endpoint URL:** `http://localhost:11434/v1` (OpenAI-compatible) or `http://localhost:11434` (Ollama native API).
- **Target Model:** `local-router/fallback-models`
- **Authentication Key:** `local-router` (or any non-empty placeholder string; upstream API keys are securely managed via the PQC secrets bundle).

### Architectural Advantages
1. **Zero Client Multi-Provider Complexity:** Sub-agents require no provider fallback logic, rate-limit retry loops, or multi-key rotating configurations.
2. **24-Step Transparent Cascade:** When a primary provider fails, rate-limits, or exhausts its context window, `local-router` automatically routes to the next model in the curated chain:
   ```
   Ollama Cloud → NIM → Free-tier (Cline/Kilo/Zen) → Modal → Nous → Subscriptions/OAuth → Z.ai/Xiaomi → Pioneer → Go/CommandCode → Nebius/Wafer → Paid backstops (ZenMux/OpenRouter)
   ```
3. **Cross-Platform Auto-Start Guarantee:** Local Router automatically starts whenever the Ollama CLI or Desktop application starts on macOS, Windows, Linux, or WSL:
   - **Port Allocation:** Local Router occupies port `11434` (the standard Ollama endpoint), proxying the real Ollama backend on port `11435` via `OLLAMA_HOST=127.0.0.1:11435`.
   - **Desktop App Autostart:** macOS GUI apps inherit `OLLAMA_HOST` via `launchctl setenv`; Windows sets User environment variable `OLLAMA_HOST` and Startup shortcut; Linux uses `~/.config/environment.d/ollama.conf` and autostart desktop entry.
   - **CLI Auto-Start:** POSIX `~/.local/bin/ollama` and Windows `ollama.cmd` / `ollama.ps1` probe port 11434 and launch `local-router start` detached if not already running.
4. **No Plaintext Secret Leakage:** Sub-agents never receive real API keys on disk or in command-line arguments. All egress calls stay on loopback `localhost:11434` with dummy bearer tokens (`local-router`).

---

## 4. Headless Execution Fallback Cascade & Dispatch Patterns

### Primary Fallback Cascade
When executing user or agent tasks headlessly, harnesses follow the resilient 3-stage fallback cascade:
$$\text{free-claude-code} \xrightarrow{\text{if fail}} \text{omp} \xrightarrow{\text{if fail}} \text{trae-cli}$$

1. **`free-claude-code` (`claude` / `fcc-claude`):** Primary agent using `ANTHROPIC_BASE_URL=http://127.0.0.1:11434` with `--dangerously-skip-permissions`.
2. **`omp` (OhMyPy):** Secondary agent for non-interactive execution (`omp -p <prompt>`).
3. **`trae-cli` (Trae SWE Agent):** Tertiary agent for deep structural AST edits and patch generation.

### Agent Selection & Fleet Toggle
Both `local-router` (/config/chat & CLI) and `wtf-is-going-on-mcp` (dashboard & MCP `chat_run`) provide:
- **Agent Selection:** `auto` (runs the 3-stage cascade), or pinned to `free-claude-code`, `omp`, `trae-cli`, or `mini`.
- **Trae / Mini Fleet Toggle:** Controls whether autonomous multi-file SWE fleet expansion is permitted (ON) or confined to single-turn interactive execution (OFF).
- **Universal Model Standard:** All agents and chats route through virtual model `local-router/fallback-models`.

### Pattern A: Trae-Agent Headless Dispatch (`trae-cli run`)

When dispatching `trae-cli`, **always use a task file (`-f <file>`)** rather than raw command-line string arguments. This prevents shell quoting failures when tasks contain backticks, quotes, or code snippets.

```bash
dispatch_trae_agent() {
    local task_content="$1"
    local workdir="${2:-$(pwd)}"
    local max_steps="${3:-30}"
    local slug
    slug=$(basename "$workdir")

    local task_file="/tmp/trae_task_${slug}.md"
    local patch_file="${workdir}/trae_solution.patch"
    local traj_file="${workdir}/trae_trajectory.json"
    local log_file="/tmp/trae_exec_${slug}.log"

    # Write task specification cleanly
    cat > "$task_file" <<EOF
$task_content
EOF

    echo "[Orchestrator] Dispatching trae-cli in workdir: $workdir"
    echo "[Orchestrator] Logs: $log_file"

    trae-cli run \
      -f "$task_file" \
      --provider openai \
      --model-base-url "http://localhost:11434/v1" \
      --model "local-router/fallback-models" \
      --api-key "local-router" \
      --working-dir "$workdir" \
      --max-steps "$max_steps" \
      --console-type simple \
      --patch-path "$patch_file" \
      --trajectory-file "$traj_file" > "$log_file" 2>&1

    local exit_code=$?
    rm -f "$task_file"

    if [[ $exit_code -ne 0 ]]; then
        echo "[Orchestrator] trae-cli exited with code $exit_code. Check $log_file"
        return $exit_code
    fi

    echo "[Orchestrator] trae-cli finished successfully."
    if [[ -f "$patch_file" && -s "$patch_file" ]]; then
        echo "[Orchestrator] Generated patch: $patch_file"
    fi
}
```

### Pattern B: Live-SWE-Agent Headless Dispatch (`mini` / `mini-live`)

Live-SWE-agent requires non-interactive flags (`--yolo --exit-immediately`) and a dynamic configuration specifying the local-router Ollama provider:

```bash
dispatch_live_swe_agent() {
    local task_content="$1"
    local workdir="${2:-$(pwd)}"
    local step_limit="${3:-30}"
    local slug
    slug=$(basename "$workdir")

    local temp_config
    temp_config=$(mktemp /tmp/liveswe-config.XXXXXX.yaml)
    local log_file="/tmp/liveswe_exec_${slug}.log"
    local traj_file="${workdir}/liveswe_trajectory.json"

    # Dynamic configuration incorporating local-router Ollama shim
    cat > "$temp_config" <<EOF
agent:
  mode: yolo
  step_limit: $step_limit
  cost_limit: 0.0
model:
  model_name: "ollama/local-router/fallback-models"
  model_kwargs:
    api_base: "http://localhost:11434/v1"
    api_key: "local-router"
    temperature: 0.0
    drop_params: true
environment:
  env:
    PAGER: cat
    MANPAGER: cat
    LESS: -R
    PIP_PROGRESS_BAR: "off"
    TQDM_DISABLE: "1"
EOF

    echo "[Orchestrator] Dispatching Live-SWE-agent in workdir: $workdir"
    echo "[Orchestrator] Logs: $log_file"

    (
        cd "$workdir" || exit 1
        OPENAI_API_BASE="http://localhost:11434/v1" \
        OLLAMA_API_BASE="http://localhost:11434" \
        mini \
          --config "$temp_config" \
          --task "$task_content" \
          --output "$traj_file" \
          --yolo \
          --exit-immediately > "$log_file" 2>&1
    )
    local exit_code=$?
    rm -f "$temp_config"

    if [[ $exit_code -ne 0 ]]; then
        echo "[Orchestrator] mini exited with code $exit_code. Check $log_file"
        return $exit_code
    fi

    echo "[Orchestrator] Live-SWE-agent finished successfully."
}
```

---

## 5. Master Orchestrator Operational Playbook

Any agent harness (Claude, Antigravity, OpenCode, Codex) must execute the following 7-phase loop when mastering this skill:

### Phase 1: Pre-Flight Health Check
Verify that the local-router Ollama proxy is up and responsive before spawning any subagent:
```bash
curl -s http://localhost:11434/v1/models | grep -q "data" || {
    echo "ERROR: Local-router Ollama endpoint is not responding on port 11434."
    exit 1
}
```

### Phase 2: Git Worktree Scaffolding
Never execute a subagent in the main repository root or active working tree. Create an isolated sibling worktree:
```bash
git worktree add -b feat/<scope>-<slug> ../<slug> HEAD
```

### Phase 3: Task Framing & Prompt Formulation
High-performing subagents require deterministic constraints. Structure the task description into:
1. **Context & Scope:** Exactly which files or modules to investigate.
2. **Objective:** What behavior to fix, feature to implement, or test to satisfy.
3. **Acceptance Criteria:** Precise test commands (e.g. `npm test`, `pytest tests/test_core.py`, `cargo test`).
4. **Completion Directive:** Instruct the agent to run the tests and verify that `git status` shows clean, working code before exiting.

### Phase 4: Non-Blocking Dispatch & Monitoring
Dispatch the agent using the patterns above. Redirect all terminal output to `/tmp/<agent>-<slug>.log`. In an agent harness:
- Use asynchronous process management or moderate tool timeout thresholds.
- Avoid polling loops; monitor completion via exit code or file creation.

### Phase 5: Patch Inspection & Quality Gates
Once the subagent completes, the orchestrator inspects the worktree:
```bash
cd ../<slug>
git status --short
git diff
```
Run repository quality gates:
- Security gate: Zero-Trust & PQC secret check (`python3 bin/security_gate.py`).
- Test suite: Native test runners (`pytest`, `cargo test`, `npm test`).
- Linter / Types: `cargo clippy`, `tsc`, `ruff check`.

### Phase 6: Autonomous Error Recovery & Cross-Agent Handoff
If a subagent fails or gets stuck:
- **Case 1: Trae hits max steps or produces syntax errors:**
  Inspect `trae_trajectory.json` to identify where it halted. Extract any partial changes into a commit, then dispatch `live-swe-agent` with a task to write a targeted reproduction script and fix the remaining failures.
- **Case 2: Live-SWE enters a tool-creation loop without fixing the root cause:**
  Terminate the process. Read its latest tool attempt in `liveswe_trajectory.json`. Frame a concise prompt for `trae-cli` targeting the exact files identified by Live-SWE.
- **Case 3: Both agents exhausted:**
  Discard the worktree cleanly (`git worktree remove --force ../<slug>`) and report findings back to the operator without polluting the primary codebase.

### Phase 7: Integration & Cleanup
When all tests and security gates pass:
```bash
cd <main-repo-path>
git merge feat/<scope>-<slug>
git worktree remove ../<slug>
git branch -d feat/<scope>-<slug>
```

### Phase 8: Continuous Action Reflection & Empirical Data-Engineering
Upon completing each action with `trae-cli` and `mini`:
1. Inspect the agent trajectory (`trae_trajectory.json` or `liveswe_trajectory.json`) and output logs.
2. **Sanitize & Scrub Files (Privacy Master):** Purge all environmental credentials, bearer tokens, and user home paths using the privacy scrubber:
   ```bash
   python3 .agents/skills/trae-mini-fleet/scripts/scrub_task.py --in-place /tmp/trae_task_*.md
   python3 .agents/skills/trae-mini-fleet/scripts/scrub_task.py --in-place trae_trajectory.json
   ```
3. Evaluate adherence to the **9 TTS.COMMS Master Suggestions**:
   - *Adversarial:* Confined to loopback proxy 11434 with dummy bearer token (`local-router`).
   - *Privacy:* Intermediate files in `/tmp` scrubbed via `scrub_task.py`.
   - *Supply-chain:* Upstream git commits pinned (`trae-agent@8d4b3c1`, `live-swe-agent@f52e89a`).
   - *Systems-architecture:* Port 11434 availability probed prior to execution.
   - *Reliability:* Explicit step limits respected; patch passed automated test execution.
   - *Governance:* Commits, task files, and ledger entries recorded and tracked.
   - *Ergonomics:* Single-command task file templates (`-f <file>`) used without quoting flaws.
   - *Agentic-orchestration:* Trae AST navigation refactoring preceding Live-SWE test hardening.
   - *Performance:* Failed worktrees removed immediately, intermediate trajectories pruned.
4. **Data-Engineering CSV Update:** Append a structured row to `trae-mini-fleet.csv` via the CLI helper:
   ```bash
   python3 .agents/skills/trae-mini-fleet/scripts/fleet_dataset.py log \
       --agent <agent> \
       --task-type <task_type> \
       --step-budget <budget> \
       --steps-taken <steps> \
       --template <template_id> \
       --excerpt "<summary>" \
       --patch --pass \
       --failure-mode <none|mode> \
       --strengths "<strengths>" \
       --weaknesses "<weaknesses>" \
       --refinement "<refinement>"
   ```
5. Record a qualitative reflection entry in `.agents/skills/trae-mini-fleet/FLEET-SKILL-REFLECTIONS.txt` with an ISO-8601 timestamp, subagent used, action summary, and iterative instruction refinement.

---

## 6. Prompt-Engineering Mastery per Harness

High-performing subagents require prompt architectures calibrated to their cognitive harnesses:

### A. Trae-Agent (`trae-cli`) — Structural AST Prompt Formula
- **Cognitive Profile:** Excels at broad symbol discovery, AST traversal, multi-file code editing, and patch generation. Vulnerable to open-ended wandering or step exhaustion if not given explicit scope boundaries.
- **Master Template (`TPL_TRAE_AST_V2`):**
```markdown
# TASK: [Short Actionable Slug]

## CONTEXT & OBJECTIVE
- Repository: [Repo Name / Subdirectory]
- Goal: [1-2 sentences strictly defining the required modification]

## SCOPE & TARGET FILES
You must ONLY explore, inspect, and modify the following files:
- [Primary Source File Path]
- [Secondary Source / Type Definition File Path]
- [Target Test File Path]

## STEP BUDGET & NON-INTERACTIVE DIRECTIVES
- Max Steps: [20-30]
- Execute non-interactively. Run AST search and symbol inspection first.
- Apply modifications using precise diff blocks.

## ACCEPTANCE & VERIFICATION GATES
Run the following test commands to verify your changes before exiting:
1. Compile / Type Check: [e.g. ./node_modules/.bin/tsc or cargo check]
2. Test Execution: [e.g. node --test tests/my-test.test.mjs or pytest]
3. Git Status: Ensure all changes are confined to the target files and tests pass.
```

### B. Live-SWE-Agent (`mini` / `mini-live`) — Test-Driven Reproduction Formula
- **Cognitive Profile:** Excels at runtime problem reproduction, writing standalone Python verification probes, and iterative bash loops. Vulnerable to getting stuck in tool-synthesis loops if test runners are unspecified.
- **Master Template (`TPL_MINI_TDD_REPRO_V1`):**
```markdown
# TASK: [Bug Reproduction & Test-Driven Hardening]

## PROBLEM SIGNATURE
- Error Description: [Exact error message or unexpected status code]
- Triggering Condition: [Input payload or call sequence that triggers failure]

## EXECUTION DIRECTIVES (TDD FIRST)
1. Write a minimal reproduction test script in `tests/` or `/tmp/reproduce_issue.py`.
2. Execute the test and verify it fails with the expected error signature.
3. If reproduction succeeds within 3 attempts, proceed IMMEDIATELY to editing source files.
   DO NOT create extraneous helper probe scripts.
4. Modify production code in [Target File] to eliminate the bug.
5. Re-run your reproduction test and the repository test suite:
   Command: [e.g. npm test or pytest tests/test_targeted.py]
6. Verify tests pass 100% and exit immediately.
```

### C. Free-Claude-Code (`claude` / `fcc-claude`) — Rapid Diagnostic Formula
- **Cognitive Profile:** Best for single-turn rapid diagnosis, inspecting environment state, checking port listeners (`lsof`, `ps`), and reviewing small diffs.
- **Formula:** Provide a single, direct diagnostic question with output format constraints (e.g. "Report which process holds port 11434 in 2 bullet points").

### D. OhMyPy (`omp`) — Algorithmic Python Synthesis Formula
- **Cognitive Profile:** Generates self-contained, clean Python automation scripts with zero external dependency assumptions.
- **Formula:** Specify input format, output format, and mandate using Python standard library only (`argparse`, `json`, `csv`, `http.client`, `urllib`).

---

## 7. Empirical Data-Engineering Protocol (`trae-mini-fleet.csv`)

The fleet continuously data-engineers its own prompting effectiveness through the structured ledger at:
`.agents/skills/trae-mini-fleet/trae-mini-fleet.csv`

### CLI Data-Engineering Workflow:
1. **Pre-Dispatch Query:** Before formulating a task prompt, query past benchmarks for the target `task_type`:
   ```bash
   python3 .agents/skills/trae-mini-fleet/scripts/fleet_dataset.py query <task_type>
   ```
2. **Dispatch Logging:** Log the dispatch outcomes automatically:
   ```bash
   python3 .agents/skills/trae-mini-fleet/scripts/fleet_dataset.py log \
       --agent <agent> \
       --task-type <task_type> \
       --step-budget 25 \
       --steps-taken 14 \
       --template TPL_TRAE_AST_V2 \
       --excerpt "Refactored WeakMap request compression" \
       --patch --pass \
       --strengths "Clean diff" \
       --weaknesses "None" \
       --refinement "Provided explicit target files"
   ```
3. **Continuous Performance Analysis:** View fleet statistics, pass rates, and failure distributions:
   ```bash
   python3 .agents/skills/trae-mini-fleet/scripts/fleet_dataset.py stats
   ```


---

## 8. Agent Selection & Dynamic Handoff Matrix

| Task Characteristics | Primary Agent | Fallback / Handoff Agent | Handoff Trigger Condition |
|----------------------|---------------|--------------------------|---------------------------|
| Multi-file refactoring / AST edits | `trae-cli` | `mini-live` | Trae hits step limit or syntax errors; Live-SWE writes targeted reproduction test to harden patch. |
| Failing tests / bug reproduction | `mini-live` | `trae-cli` | Live-SWE loops creating helper tools; Trae is dispatched with exact file targets found by Live-SWE. |
| Port collision / env diagnosis | `free-claude-code` | `omp` | Quick diagnosis needed; FCC probes state, OMP writes remediation script if complex. |
| Standalone script / bench utility | `omp` | `trae-cli` | Script requires deeper integration with repository packages; Trae wires into codebase. |
| End-to-end full-stack feature | Trae $\rightarrow$ Mini | Operator Review | Trae builds multi-file scaffold; Mini adds edge-case tests; orchestrator verifies. |

---

## 9. Common Pitfalls & Operational Guardrails

| Pitfall | Impact | Prevention / Remedy |
|---------|--------|---------------------|
| Invoking `trae-agent` | `zsh: command not found: trae-agent` | **Always invoke `trae-cli`**. |
| Omitting non-interactive flags | Process hangs waiting for stdin | Use `--console-type simple` on `trae-cli` and `--yolo --exit-immediately` on `mini`. |
| Unescaped task arguments | Shell syntax error on quotes/backticks | Write task prompt to `/tmp/task.md` and pass via `trae-cli run -f /tmp/task.md`. |
| Running directly in main tree | Branch pollution / git conflicts | **Mandatory:** `git worktree add -b <branch> ../<slug>`. |
| Passing raw API keys | Leaked secrets / PQC violation | Direct traffic to `http://localhost:11434/v1` with placeholder key `local-router`. |
| Unbounded step counts | Agent burns tokens in loops | Always set `--max-steps 20-35` for Trae and `step_limit: 30` for Live-SWE. |
| Port 11434 collision | Standalone Ollama overrides proxy | Ensure `local-router route set` is active (Ollama backend on 11435, router on 11434). |
| Unpruned failed worktrees | Disk / memory exhaustion | Discard failed worktrees immediately (`git worktree remove --force ../<slug>`). |
| Missing CSV & reflection logging | Recurring subagent failure modes | Record lessons in `trae-mini-fleet.csv` and `FLEET-SKILL-REFLECTIONS.txt` after every dispatch. |


