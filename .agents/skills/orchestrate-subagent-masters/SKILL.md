---
name: orchestrate-subagent-masters
description: >
  Master orchestration of ALL subagent modalities as direct agentic tool calls:
  DeepSeek Harness engines (dsh --profile headless one-shot dispatches and
  dsh --profile acp persistent automation surface) carrying the AST Refactoring
  Master and TDD Reproduction Engineer personas, harness-native subagent /
  subagent_fork delegates, workflow fan-out, and ralph fresh-agent loops — each
  embodied as an expert master persona with concise terminal-command
  instructions, dedicated worktree isolation, loop-engineered
  Manager/Executor/Auditor rounds for long-horizon tasks, handoff chaining,
  evaluator separation, and COMMS ledger receipts — with the wtf MCP hub as
  the live cross-machine observability plane. The dsh configuration is the
  operator's own (agent-default-model: local-router/fallback-models on the
  loopback ollama-local-router endpoint): never override profile, provider, or
  model config in dispatches. Engines are portable: any agentic harness maps
  its own internal subagent tooling onto the same scaffold when dsh is absent
  (§2 Engine portability). Runtime coordination lives in the .agents/comms/ +
  .agents/handoffs/ + .agents/tasks/ triad via the
  <name>.{date}.masters.<slug>.txt masters channel — detailed, explicit prose,
  Chain-of-Draft exempt; this skill folder is read-only knowledge. Use when
  orchestrating coding subagents, dispatching fleet engines, fanning out
  parallel subtasks, running long-horizon verify-checkpoint loops, or
  delegating any scoped task to a sub-master.
---

# Orchestrate-Subagent-Masters — Universal Subagent Orchestrator Skill

The calling AI agent is the **Master Orchestrator**: it decomposes operator intent, embodies the exact domain expert each phase needs, and dispatches subagents as **direct tool calls** — never as passive advice, never as operator chores. Every dispatch runs in a dedicated sibling worktree; the engine is the **DeepSeek Harness CLI (`dsh`)** — headless one-shot dispatches, the ACP persistent surface, and `sdk[-minimal]` programmatic dispatch via `deepseek-harness-sdk` (profiles, never separate bins) — running the operator's own configuration. Tasks that cannot fit one dispatch run as loop-engineered **Manager/Executor/Auditor rounds** (§2.8). The wtf MCP hub is the live cross-machine observability plane (§9). The invoking directory is the workspace root, so always `cd` into the worktree first. Depth layer: `RESEARCH-ANNOTATIONS.md` beside this file carries every claim's provenance.

## 1. Core Doctrine

1. **Tool calls, not commentary.** Dispatch immediately via the modality's invocation form (§2).
2. **Embody the master.** Formulate each prompt AS the persona (AST Master, TDD Engineer, Security Auditor, …) — precise scope, bounded steps, explicit gates.
3. **Worktree isolation.** One dispatch = one branch = one sibling worktree (`git worktree add -b <type>/<scope>-<slug> ../<slug> main`). Never dispatch against `main`.
4. **Operator-owned config.** dsh runs the configuration the operator set: `agent-default-model` = `local-router/fallback-models` served by the `ollama-local-router` provider (loopback router; set from the DSH web dashboard, 2026-09-07). Never override profile, provider, or model config in a dispatch (no `--patch` overlays, no profile edits). Verify what will boot with the §4.1 preflight and the session log; never pass raw API keys in dispatch args or task text.
5. **Scope recon first.** Map callers and blast radius (d≤2) with the harness's own code search; that output IS the `SCOPE & TARGET FILES` allowlist. Zero blind edits.
6. **Receipts or it never happened.** Every dispatch lifecycle is a `SUBAGENT-DISPATCH` entry in the active `.agents/comms/{date}-team.txt` (`parent: <orchestrator>`) plus a closed packet in `.agents/handoffs/` (§5–§6, §8).
7. **Scaffold carries the intelligence.** Lower-intelligence engines reach frontier outcomes through the scaffold — scope allowlists, persona prompts, structured artifacts, gates, evaluator separation, receipts — not through model horsepower. When a dispatch underperforms, harden the scaffold, not the model.
8. **Fan out for read; single-thread for write.** The one axis that picks the topology is how much context can be lost between agents (§2.0). Interdependent write-heavy work serializes as a pipeline or stays with one agent.
9. **Cost doctrine.** Multi-agent systems spend ~15× chat tokens (single agents ~4×); token spend alone explains ~80% of multi-agent performance variance, and a fan-out snag can cost ~5× recovery tokens. Reserve fan-out for one-off exploratory / parallel-read breadth; repetitive production work → a plain pipeline of subagents; always start on a small slice.
10. **Memory-aware dispatches.** Embed in each dispatch prompt a recon line ("read `.agents/memories/{date}-memory.txt` before edits") and a closeout line ("append one durable gotcha/decision to today's memory file before exit"). Cross-machine coordination still lives ONLY in the COMMS triad — the memory files are context, never the system of record (§7.1, AGENTS.md `<REPO_MEMORY>`).

## 2. Subagent Modality Matrix — One Command Each

| Modality | Master Persona | Dispatch When |
|---|---|---|
| `dsh --profile headless` | AST Refactoring Master / TDD Reproduction Engineer (one-shot) | Multi-file structural edits, patches, failing-test reproduction, fix loops — answer, print, exit |
| `dsh --profile acp` | Persistent harness surface | A long-lived automation client (editor, orchestrator) driving multi-turn sessions over stdio |
| `dsh --profile sdk[-minimal]` via `deepseek-harness-sdk` | Any (programmatic one-shot) | Orchestrator scripts: `DeepSeekHarness(provider=, model=, max_tokens=, cwd=, dsh_home=, profile=, patches=).run(task, session_id=)` → `result.final_response` — explicit isolated workspace+home, fresh session id per task; `sdk-minimal` pins `danger-full-access` → disposable checkout/container only |
| Native subagent | Any (context-fresh delegate) | Self-contained research/implementation; must not see this conversation |
| `subagent_fork` | Any (context-inheriting delegate) | Follow-up analysis/review building on current conversation |
| `workflow` | Parallel Masters (fan-out) | Many independent scoped pieces: audits, migrations, multi-angle research |
| `ralph` | Fresh-Agent Iteration Master | ONLY on explicit operator request for fresh-agent iterative loops |

The launcher parses only its own flags; everything after them belongs to the booted profile (`dsh --profile <name> --help` for the app's flags). Invalid commands, foreign options, config errors, and boot failures exit nonzero.

**Engine portability — any harness, any intelligence.** `dsh` is this fleet's terminal engine; the CONTRACT is the skill. An agentic harness with no `dsh` binary maps its own internal subagent tooling onto the same scaffold: one-shot scoped tool-call delegate ↔ `dsh --profile headless` (§2.1–§2.2); persistent session surface ↔ `dsh --profile acp` (§2.3); programmatic dispatch ↔ the SDK form (§2.3b); context-fresh / context-inheriting delegates, scripted fan-out, and fresh-agent iteration ↔ §2.4–§2.7 as named. Whatever the engine, the invariants are non-negotiable: persona prompt, scope allowlist, OUTPUT FORMAT + STOP CONDITIONS, fresh context per dispatch, sibling-worktree isolation, exit normalization (§4.3), COMMS receipt + handoff packet (§6, §8).

### 2.0 Topology & fan-out rules (decide BEFORE any fan-out)

- **Pipeline** for dependent stages sharing evolving state (retry the step, not the run); **orchestrator-worker** for genuinely independent read-mostly subtasks (workers blind to each other, orchestrator synthesizes); **swarm/ralph** only on explicit operator request — the routing-is-the-problem case.
- **Effort scaling** (engines cannot judge appropriate effort — embed it): fact-finding = 1 dispatch, 3–10 engine calls; multi-angle work = 2–4 parallel masters, 10–15 calls each; >10 only for genuinely complex breadth. Hard caps: ≤6 concurrent engine dispatches, ~6–8 as the reliability ceiling; nesting depth 1 — workers never spawn workers; `timeout 1800` per episode.
- **Explicit-dispatch-only default.** Fan out only when the operator asked or the scope truly splits into independent read-heavy parts; "ten subagents is where the manager tax shows up" (overlap, stale assumptions, merge pressure). Add a modality/specialist only when the contract changes.
- **Conformity mitigation.** Individual engines are low-variance: identical scaffolds reproduce identical blind spots. Diversify scaffolds across same-model parallel auditors — persona framing, tool order, prompt structure, starting hints.
- **Ownership boundaries.** One owner per file set; file-ownership siloing is today's practical conflict cure. Hierarchy prompts are not a substitute.
- **Arbiter pattern.** Peer findings are validated by one fresh scoped dispatch before merge; fan out → refute → converge. Adversarial cross-checking makes output trustworthy — headcount does not.

### 2.1 `dsh --profile headless` — AST Refactoring Master (one-shot)
```bash
cat > /tmp/task_ast.md << 'EOF'
# TASK: <one-line objective>
## ROLE & EXPERT PERSONA
You are the **AST Refactoring Master**. Surgical structural edits; preserve AST and exported contracts.
## SCOPE & TARGET FILES   # blast-radius recon output — the ONLY editable files
- <file1>
- <file2>
## OBJECTIVE & DIRECTIVES
1. <directive>  2. <directive>
## ACCEPTANCE & QUALITY GATES
1. <compile/typecheck cmd>  2. <test cmd>  3. git status shows ONLY scope files
## OUTPUT FORMAT
<structured artifact per §3 contract>
## STOP CONDITIONS
<per §3 contract>
EOF
cd ../<slug>   # invoking directory = workspace root — never main
timeout 1800 dsh --profile headless "$(cat /tmp/task_ast.md)"
rm -f /tmp/task_ast.md   # scrub task file — mandatory, never skip; the worktree edits are the deliverable
```
Headless streams reasoning to stderr, prints the final assistant message to stdout, and exits — inherently non-interactive. Task text is visible in the child process argv: ephemeral task files only, never secrets.

### 2.2 `dsh --profile headless` — TDD Reproduction Engineer (one-shot)
```bash
cd ../<slug>
timeout 1800 dsh --profile headless "$(cat << 'EOF'
[ROLE: TDD Reproduction Engineer]
OBJECTIVE: <reproduce & eliminate <bug>>
SEQUENCE: 1) write minimal failing test <tests/repro.test.mjs> 2) run it, confirm failure
3) patch <target file> minimally 4) re-run test + full suite green 5) stop and report
## SCOPE & TARGET FILES: <allowlist>
## OUTPUT FORMAT / ## STOP CONDITIONS: per §3 contract
EOF
)"
```
No session flag exists or is needed — each headless run is one fresh persisted session (sessions persist under `$DSH_HOME/sessions/<workspace-slug>/session-<id>/session.jsonl.zstd`; cite the session id from stderr in the COMMS receipt when one is printed).

### 2.3 `dsh --profile acp` — persistent automation surface
```bash
dsh --profile acp   # serves ACP over stdio until disconnect
```
For clients that drive multi-turn agent sessions (editors, orchestrator processes). Boot it deliberately as a managed background process with a bounded lifetime — never inside a one-shot dispatch. One-shot orchestration uses §2.1/§2.2, not ACP.

### 2.3b `dsh --profile sdk[-minimal]` — programmatic one-shot via Python SDK
```python
from deepseek_harness import DeepSeekHarness   # pip install deepseek-harness-sdk
with DeepSeekHarness(profile="sdk-minimal", cwd=str(workspace), dsh_home=str(dsh_home)) as harness:
    result = harness.run("<scoped task, same §3 contract>", session_id="<fresh-id>")
print(result.final_response)
```
SDK and ACP are profiles, not separate bins. ALWAYS pass explicit isolated `workspace` + `dsh_home` (never silently reads `~/.dsh`); fresh `session_id` per independent task — reuse harness+home+id only to continue one conversation. Params: `provider=, model=, max_tokens=, patches=` join the profile's own layers. `sdk-minimal` limits shape task design: 300 s shell timeout, 16,000-char editor output limit, no runtime context or compaction, uncompressed JSONL sessions → **bounded steps, small edits**. System prompt from `DSH_SYSTEM_PROMPT`; model resolves `--model` → `DSH_MODEL`. Missing server rows / unresolved plugins / invalid patches FAIL AT STARTUP — no silent fallback. `sdk-minimal` pins `danger-full-access`: disposable checkout/container only.

### 2.4 Harness-native subagent — context-fresh delegate
Tool call (not shell): `subagent` with a **complete standalone prompt** — objective, scope allowlist, gates, persona, worktree/branch instruction. The delegate sees none of this conversation and cannot contact peers or spawn workers; the handoff must stand on its own. Use `run_in_background: true` for independent scopes; block (`run_in_background: false`) when the next phase consumes the result.

### 2.5 Harness-native subagent_fork — context-inheriting delegate
Tool call: `subagent_fork` when the delegate should inherit the completed conversation (review, continuation, follow-up analysis). State only what is new; it already sees prior turns.

### 2.6 `workflow` — parallel Masters fan-out
Tool call: scripted fan-out across many independent pieces (audits, migrations). Write the orchestration as plain JS: `agent(prompt)` per unit, `pipeline` for per-item stages, `parallel` only at true barriers. The plan lives in CODE, not in the orchestrator's context — the script absorbs bookkeeping, branching, and intermediate results; the session holds only the final answer. Independent scopes may run concurrently; dependent scopes block on receipts.

### 2.7 `ralph` — fresh-agent iteration
Tool call: ONLY when the operator explicitly requests Ralph/fresh-agent iteration. Each round is a context-free child; the shared workspace plus a structured handoff artifact is the memory — context resets + structured handoff artifacts beat compaction for long tasks.

### 2.8 Loop engineering — Manager/Executor/Auditor rounds (long-horizon tasks)
Skill-native loop doctrine (implementation annotations: RESEARCH-ANNOTATIONS.md Part 5) — one engine, no external loop-harness install, no multi-backend fallback machinery. The model determines what an engine can do in ONE round; the loop is the orchestrator's job. When a task cannot fit one dispatch (dozens of steps, verification-heavy, must survive failures and context refreshes), stop writing one big task file and run ROUNDS:

| Role | Who | Owns |
|---|---|---|
| **Manager** | the orchestrator + a persisted plan/round-ledger artifact | rebuilds each round from the original goal + verified progress + failure evidence + remaining work; picks the next BOUNDED step |
| **Executor** | fresh `dsh --profile headless` dispatch in the round's worktree (§2.1/§2.2) | completes exactly one bounded step; returns the structured artifact + gate results |
| **Auditor** | independent read-only verification dispatch — fresh context, skeptical persona, explicit grading criteria, inspects the real filesystem/tests/logs | accepts or rejects the Executor's result; never trusts its claim |

Round law:
1. **Verified state only.** Only auditor-passed results enter the checkpoint artifact. A rejected result remains EVIDENCE, not progress.
2. **Fresh context per action.** Every Executor round is a new dispatch; the checkpoint artifact is the memory (context resets + structured handoff artifacts beat compaction).
3. **Checkpoint or recover.** Pass → append verified progress to the round-ledger artifact. Fail or timeout → record the failure signature + evidence; the next round restarts from the original goal + last verified checkpoint and continues what remains.
4. **Final reply from verified state alone.** Compose the operator answer only from checkpointed verified progress; say plainly if the task did not finish.
5. **Caps.** ~30 rounds max; Executor episodes `timeout 1800`; Manager/Auditor episodes `timeout 600`. A timeout = recoverable state, not a provider failure — re-derive from the ledger; repeated failed rounds on the same step escalate to the operator (§7.7).
6. **Isolation & hygiene.** Executor dispatches own the worktree (workspace-write semantics); Manager planning and Auditor verification stay read-only on the workspace. Secrets stay env/CLI — task text is visible in child argv.
7. **Tiering.** Pay for strength where it matters — a capable Manager + skeptical Auditor over a cheaper Executor scaffold. On this fleet the model is the operator's single `local-router/fallback-models`; tiering happens via persona scaffolding, never model overrides (§1.4).

## 3. Canonical Master Templates (authoritative copies)

Four templates, invoked with the §2 command forms. TPL ids keep their V3 names for cross-reference stability; the contract below is the v4 upgrade applied to every block. Invariants (non-negotiable): scoped `SCOPE & TARGET FILES` allowlist from graph recon; one-shot engines only inside dispatches (never boot `web`/`tui`/`acp` profiles in a dispatch — headless answers and exits); task prompts via task file fed with `"$(cat <file>)"`; dispatch only inside dedicated sibling worktrees (invoking directory = workspace root); every task prompt carries the OUTPUT FORMAT and STOP CONDITIONS fields.

**v4 Task Prompt Contract — two required fields on every template:**
```
## OUTPUT FORMAT
Return a structured artifact: findings; files-touched; gate results (command → pass/fail); confidence; open-questions.
## STOP CONDITIONS
Stop and report when evidence is sufficient, or after 3 failed attempts on the same step — never scour past that. You cannot judge appropriate effort; these bounds are your effort budget.
```

- **TPL_AST_REFACTOR_V3** — AST Refactoring Master (dsh headless): role = surgical structural refactor preserving AST/type contracts; scope = blast-radius allowlist; gates = compile + tests + scope-clean `git status`.
- **TPL_TDD_REPRO_V3** — TDD Reproduction Engineer (dsh headless): role = minimal failing test → confirm failure → minimal patch → green suite → report; zero extraneous scripts.
- **TPL_SECURITY_AUDIT_V3** — Adversarial Security Auditor (dsh headless/native): role = zero-trust audit — CWE-22/SSRF/injection vectors, FIPS 203/204/205-only secrets ops, allowlist validation; gates = security tests + zero banned primitives.
- **TPL_SYSTEMS_ARCH_V3** — Systems Architecture Master (dsh headless): role = deterministic loopback pipelines, port contracts, daemon failover, signal-clean shutdown; gates = endpoint smoke + lifecycle tests.

## 4. Terminal-Native Dispatch Protocol

No wrapper scripts — the orchestrator runs plain commands and normalizes outcomes itself.

### 4.0 Runtime contract (dsh ground truth)
- **Raw exit contract:** headless exit 0 = `completed`, else 1; SIGINT → 130; SIGTERM = ordinary supervisor stop → 0 on every surface; a second signal forces exit. Success = last non-empty assistant text on stdout, silent stderr, no listening port. The §4.3 taxonomy is orchestrator-normalized on top of this raw contract.
- **Config layer precedence:** bundle patches (in `dsh.profile.bundles` order) → the profile's `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` overlays in argv order. Later layers win per row; a patch replaces the targeted row's whole `config` (no deep-merge). `--dump-default-config` = bundle layers only; `--dump-config` adds profile + home patches + overlays; both print per-row provenance comments and reject app args.
- **Credentials resolution:** inherited env → `$DSH_HOME/.credentials.yaml` → invoking dir `.env` → `$DSH_HOME/.env`; the managed document is never materialized into `process.env`. The credentials document is a STRICT FLAT `KEY: value` mapping — non-string, nested, or empty values fail boot fail-loud (verified on rc.8, 2026-09-07).
- **Sandbox law:** new sessions default to `workspace-write` — bash and filesystem mutations confined to the session workspace + platform temporary roots; reads, network access, and process visibility are NOT confined. `DSH_PERMISSION_MODE` is the process fallback. This operator's settings set `danger-full-access` (their own choice): worktree isolation remains the real containment.
- **Repo instructions travel.** Dispatched engines auto-load workspace `AGENTS.md`/`CLAUDE.md` with a 65,536-byte render budget — the worktree carries repo instructions to the engine.
- **Session ground truth.** Each headless run = one fresh persisted session under `$DSH_HOME/sessions/<workspace-slug>/session-<id>/session.jsonl.zstd` (slug = absolute path with `/` → `-`, wrapped in `--`). The log records the actually-served `provider` and `model` — read it, never trust memory.

### 4.1 Preflight (before first dispatch of a session)
```bash
command -v dsh >/dev/null && dsh --version >/dev/null && \
timeout 120 dsh --profile headless "Reply with the single word: pong. Do not run any commands or modify any files." | grep -q pong && echo GO || echo NO-GO
```
NO-GO = fix environment first (binary missing → install/pin `dsh`; pong fails → profile provider config broken — fix credentials/config before ANY dispatch). **Liveness is not health:** the pong is a real inference round-trip — it proves the provider can complete a completion (live-fire 2026-09-05: router liveness passed while every upstream 401'd and the dispatch died at step 1). When a profile routes through the local-router loopback, additionally run the `/v1/chat/completions` round-trip probe (max_tokens 1) against the loopback endpoint only — never probe non-loopback hosts. Verify agent CLIs by RUNNING them (`--version`), not by PATH presence — a present-but-broken install must read as a failure. The pong consumes one cheap call — first dispatch of a session only.

**Model verification (which model will serve):** `dsh --dump-config` shows only static layers and does NOT reflect runtime settings — never use it to confirm the model. The runtime authority is the operator's `$DSH_HOME/settings.yaml` (`agent-default-model`), corroborated by the dispatched session's log under `$DSH_HOME/sessions/`, which records the actual `provider` and `model` served. Verified 2026-09-07: headless masters serve `ollama-local-router` / `local-router/fallback-models` (credentials flattened to the strict flat schema; `reasoningEffort` row removed — unsupported by the router's openai-completions adapter). This supersedes the 2026-09-05 zai note as current truth; the DSH web dashboard remains the operator's source of truth.

### 4.2 Dispatch rules
- Fixed command vectors, `timeout 1800` (tune 900–3600 by scope) on every engine call.
- `cd` into the dispatch worktree first — the invoking directory is the workspace root.
- Parallel dispatches only for independent scopes in separate worktrees; dependent scopes block on completion.
- Packet contract (mechanical, every dispatch): open `.agents/handoffs/HANDOFF.{date}.{slug}.{from}-to-{to}.md` BEFORE the dispatch (scope, allowlist, worktree, done-criteria); close it AFTER with results + normalized exit code; link both from the `SUBAGENT-DISPATCH` ledger entry.
- After each dispatch: verify scope conformance (`git -C ../<slug> status --porcelain` ⊆ allowlist), scrub task files (`rm -f`), then log the COMMS receipt with exit code.

### 4.3 Exit taxonomy (orchestrator-normalized)
| Code | Meaning | Action |
|---|---|---|
| `0` | OK | Collect receipt → verification/merge flow |
| `20` | STEP-EXHAUSTED (failed, zero edits) or `124` timeout | Hand off to sibling modality with discovered targets |
| `30` | PROBE-LOOP (≥3 identical probes in engine output) | Hand failure signature to a fresh scoped dispatch for AST surgery |
| `40` | ENGINE_OR_GATES_FAILED | Fix scope/gates, re-dispatch |
| `50` | SCOPE_VIOLATION | Revert edits, tighten allowlist, re-dispatch |
| `60` | ENVIRONMENT (preflight failed; dsh boot/config/foreign-option failure; auth/upstream-error signature) | Fix profile/provider credentials, re-run §4.1 pong. **Never hand off to a sibling engine on 60 — all engines share the environment** |

Raw exit `124` (timeout) normalizes to `20`. In loop-engineered tasks (§2.8), a timeout additionally preserves the partial trajectory + ledger state for the next Manager round. No script assigns these — the orchestrator reads engine output and assigns.

## 5. Handoff Chaining & Evaluator Separation

- **Refactor → Harden:** one `dsh headless` dispatch (AST Master) applies structural edits → a second `dsh headless` dispatch (TDD Engineer) synthesizes reproduction tests + hardens edges on the result.
- **Probe → Fix:** a `dsh headless` dispatch (TDD Engineer) isolates the bug with a minimal failing test → a fresh scoped dispatch (AST Master) applies the production patch to exact files.
- **Native ↔ Terminal:** a `subagent`/`subagent_fork` delegate's analysis becomes the scoped task file for a `dsh` dispatch; terminal receipts feed back into native verification delegates.
- **Evaluator separation.** No dispatch self-approves quality. A separate skeptical evaluator dispatch — fresh context, explicit grading criteria, interacting with the LIVE artifact (run the tests, open the page), not a screenshot or the worker's self-report — audits worker output; the generator decides refine-vs-pivot after each evaluation. Self-evaluation leniency is structural: tuning a standalone evaluator to be skeptical is far more tractable than making a generator critical of its own work. Complements §7.7 (the operator confirms every merge).
- **Crashed dispatch = re-dispatch from the artifact.** Engine/process death is ordinary: re-dispatch fresh from the handoff/checkpoint artifact; never nurse the old process. Sessions, harnesses, and worktrees are cattle — provision recipes, not pets.
Each handoff = one `FLEET-HANDOFF` COMMS entry (§6).

## 6. COMMS Receipts (ledger = the receipt)

```markdown
### [ISO-8601] SUBAGENT-DISPATCH | branch:<branch> | wt:../<slug>
- start:<ISO> / end:<ISO>
- persona:<Master persona>
- scope:<allowlist files>
- objective:<one line>
- output:<artifact + gate results + exit code (normalized)>
- served:<provider/model from the session log — e.g. ollama-local-router/local-router/fallback-models>
- status:done | verifying | blocked
- blockers:none
```
One entry per dispatch; handoffs use `FLEET-HANDOFF | from:<modality> | to:<modality>`. No COMMS receipt = the dispatch never happened; no merge proceeds without receipts for every phase. Pre-merge assertion (mechanical, never by recall): every closed packet in `.agents/handoffs/` greps back to a linked `SUBAGENT-DISPATCH` ledger entry.

## 7.1 Memory Plane (all profiles)

No memory service to install — dispatches and the orchestrator share `.agents/memories/{date}-memory.txt` (AGENTS.md `<REPO_MEMORY>`): read it at recon, append one durable entry at closeout. Zero-dependency plain markdown, identical on every harness and machine; memory-blind dispatches re-derive known gotchas and re-make fixed mistakes.

## 7. Verification Gates & Guardrails

1. Worktree isolation intact (never `main`).
2. Native gates green (`tsc --noEmit`, `cargo clippy`, `ruff`, test suites — per repo language).
3. Scope conformance: `git diff --name-only` ⊆ allowlist; violations revert before re-dispatch.
4. C/C++ patches: warnings-as-errors + ASan/UBSan + tests re-run on the optimized shipping binary.
5. Privacy: task files and intermediate artifacts scrubbed after every dispatch; no secrets, no absolute home paths in any artifact (headless sessions persist under `$DSH_HOME` — treat session logs as artifacts too; task text is visible in child argv, so task files carry no secrets).
6. Scope proof before merge: gate-3's `git diff --name-only` ⊆ allowlist check re-run and logged in COMMS (or a logged gap note).
7. Operator confirms every merge — never self-approve.
8. Quality gate: no dispatch self-approves quality — evaluator separation (§5) before any merge-quality claim.
9. Discoveries become dispatches: out-of-scope work found mid-dispatch is filed as a NEW scoped dispatch (with its own receipt), never silent scope expansion.

| Pitfall | Rule |
|---|---|
| Booting `web`/`tui`/`acp` inside a dispatch | One-shot engines only — headless answers and exits |
| Mixing launcher and app flags | Launcher parses `--profile`/`--patch`/`--dump-*` only; the rest belong to the profile (`--help` per profile) |
| Dispatching from `main` | Invoking directory = workspace root — `cd` into the sibling worktree first |
| Unescaped task strings | Task file + `"$(cat <file>)"` |
| Raw keys in dispatch args or task text | Never — profiles carry their own provider config; argv is observable |
| Nested/typed values in `.credentials.yaml` | Strict flat `KEY: value` mapping only — anything else fails boot fail-loud |
| Fan-out for interdependent write work | Fan out for read; single-thread for write (§2.0) |
| Identical scaffolds on parallel auditors | Diversify persona framing/tool order/prompt structure — identical scaffolds reproduce identical blind spots |
| Worker self-report treated as ground truth | Independent auditor inspects the real filesystem/tests (§2.8, §5) |
| Dispatch without preflight | §4.1 GO before first dispatch |
| Skipping scrub | `rm -f` task files after EVERY dispatch |
| Missing COMMS receipt | Ledger entry with exit code per dispatch — no exceptions |

## 8. Masters Channel — Coordinate in the Triad, Never in the Skill Folder

This folder is read-only knowledge (`SKILL.md` + `RESEARCH-ANNOTATIONS.md`). Subagents, fleet members, swarms, and masters coordinate ONLY through the triad at the repo root: `.agents/comms/`, `.agents/handoffs/`, `.agents/tasks/`. Never write runtime artifacts into `.agents/skills/**` — skills deploy byte-identical to target projects; runtime state would corrupt every downstream copy.

- **Masters schema — `.agents/{comms,tasks,handoffs}/<name>.{date}.masters.<slug>.txt`:** master-grade artifacts where LLMs are detailed and explicit — full prose, structured sections, evidence, reasoning — to master task coordination and completion. Chain-of-Draft (≤5 words/step) does NOT apply to `.masters.` files; it still governs the concise team ledger and task gists.
- **Reflections:** upon every dispatch, append persona-aligned refinements to `.agents/comms/reflections.{date}.masters.swarm.txt` — one file per UTC date, detailed entries welcome (ISO-8601, modality, action, refinement, evidence). Harness assumptions go stale as models improve — audit the scaffold each round; delete dead weight.
- **Dispatches:** concise `SUBAGENT-DISPATCH` entries in the active `.agents/comms/{date}-team.txt` + closed packets in `.agents/handoffs/` (§5, §6). Task records live in `.agents/tasks/`.

## 9. wtf MCP Orchestration

The wtf hub is the live cross-machine observability and coordination plane, complementary to the git-carried COMMS ledger:

1. **Discover:** `wtf_is_going_on` before starting work — see what peers are doing machine-wide.
2. **Report:** `check_in` working/blocked/done at task boundaries; `log_event` for milestones and receipts.
3. **Dispatch:** the hub's `chat_run` / session-lifecycle tools execute headless tasks through its agent catalog — any hub-dispatched task still owes a COMMS receipt.
4. **Coordinate:** COMMS-ledger channels (`comms_post`/`comms_read`) for live distributed sync; encrypted sealed sessions for confidential coordination. The hub is also the shared-forum plane for swarm patterns (§2.0 peer review + arbiter).
5. **Degrade gracefully:** hub unavailable → the COMMS ledger carries coordination with a gap note; never block fleet dispatches on hub availability.
