# RESEARCH-ANNOTATIONS — orchestrate-subagent-masters v4 (2026-09-07)

Depth layer for the v4 skill: full expert annotations of the four research
areas, every claim carrying provenance (source URL + publish date) and a
skill-mapping note (→ §). The SKILL.md carries only the distilled mastery;
this document carries the evidence and the reasoning. Sources were read in
full during the 2026-09-07 research round; anything not extracted here was
judged not actionable for this fleet.

---

## PART 1 — DEEPSEEK HARNESS (operator-owned engine)

### 1.1 CLI launcher (`apps/cli/README.md`, master branch, retrieved 2026-09-07)

- `dsh` is a product launcher for profiles: ordered stacks of plugin-bundle
  patch layers under the user's own overrides. `src/args.ts` owns the command
  grammar; `src/bin.ts` loads only the selected runner. Invalid commands,
  foreign options, config errors, and boot failures exit nonzero.
  → SKILL §2 note (modality matrix footer), §4.
- Entry modes: `dsh --profile <name>` boots `$DSH_HOME/profiles/<name>`;
  `dsh --profile headless "job"` runs one fresh persisted session, prints the
  final answer, exits; `dsh web` is a hardcoded alias of `--profile web`;
  `dsh plugin --profile <p> <args>` forwards to pnpm in the profile directory.
  → SKILL §2 matrix.
- The invoking directory is the default workspace root. The `web` and
  `headless` profiles auto-initialize on first use from shipped templates; any
  other profile must be created through `dsh plugin`. → SKILL §2 cwd rule.
- Launcher flags come first; the first token the launcher does not recognize
  starts the app's arguments (`dsh --profile web --port 8080` — `--port`
  belongs to the web app). The parser consumes one `--`; an app argument that
  must arrive as a literal `--` needs `-- --`. `--profile X --help` prints the
  app's help and boots nothing. → SKILL §2 footer, §7 pitfall table.
- `--dump-default-config` prints only bundle layers; `--dump-config` adds the
  profile patch, home-level patch, and `--patch` overlays. Both print comments
  naming the file that supplied each row and every overlay that changed it;
  `!!js` expressions remain unevaluated; dumps never run app command-line
  providers and reject app arguments. → SKILL §4.1 (inspection without boot).

### 1.2 CLI behavior reference (`apps/cli/reference/README.md`, retrieved 2026-09-07)

- Config layer precedence (authoritative): bundle patches in
  `dsh.profile.bundles` order → the profile's own `cordis.patch.yml` → the
  home-level `$DSH_HOME/cordis.patch.yml` (machine-local, outranks the
  per-profile layer) → each `--patch` overlay in argv order. Later layers win
  per row; a patch replaces the targeted row's complete `config` value rather
  than deep-merging keys, and may insert new rows. → SKILL §4 (layer law).
- Headless one-shot contract: a one-shot task creates one fresh persisted
  Agent through the core registry, submits the task, waits for quiescence, and
  flushes the Session before deriving the last non-empty assistant text and
  final `turn/end` reason from its durable interval. It prints the text on
  stdout and exits 0 for `completed`, else 1. An invocation with no task text
  is a usage error. The shipped headless profile mounts no ApiProxy, Host,
  HTTP server, Web runtime, or browser client; a successful run writes nothing
  to stderr and opens no listening port. → SKILL §4.3 raw contract.
- Signals: the plugin tree gets up to five seconds to dispose. SIGTERM is a
  supervisor's ordinary stop request and exits 0 on every surface; SIGINT
  reports 130; a second signal forces immediate exit; if one-shot normal
  completion is already stuck in disposal, the first Ctrl+C is the escalation
  and exits immediately. → SKILL §4.3 raw contract.
- All modes treat the invoking directory as the default workspace root, load
  applicable `AGENTS.md` or `CLAUDE.md` instructions with a 65,536-byte render
  budget, and use an in-memory SQLite session content index. Every profile
  boot watches valid edits of both `cordis.patch.yml` layers (profile and
  home) and reapplies them transactionally. → SKILL §4 (repo instructions are
  visible to dispatched engines; live patch edits).
- Permissions: new sessions default to the `workspace-write` permission
  preset — bash and filesystem mutations are restricted to the session
  workspace and platform temporary roots; reads, network access, and process
  visibility are NOT confined. `DSH_PERMISSION_MODE` changes the process
  fallback; stored General-settings permissions affect later Web sessions, not
  an already-open one. → SKILL §4 sandbox law. NOTE: this operator's
  `~/.dsh/settings.yaml` sets `permission.defaultPreset: danger-full-access`
  (verified 2026-09-07) — the operator's own choice supersedes the shipped
  default; worktree isolation remains the real containment.
- `DSH_TOOLS_MODE` selects `native`, `code`, or `both` (another value fails at
  boot). The shipped `minimal` agent preset keeps that deployment
  presentation, fixes the system prompt to
  `You are a helpful software engineer assistant.`, and composes only
  persistent bash plus str_replace_editor. → SKILL §2.3b notes.
- Shared deployment: the base bundle mounts the native DeepSeek adapter,
  settings and credential providers, stable `web_search`, and disabled session
  telemetry. Provider credentials resolve from the inherited environment, then
  `$DSH_HOME/.credentials.yaml`, then the invoking directory's `.env`, then
  `$DSH_HOME/.env`; the managed document is never materialized into
  `process.env`. Search uses `DEEPSEEK_API_KEY` and accepts
  `DEEPSEEK_SEARCH_BASE_URL`; `web_fetch` is disabled unless a patch layer
  inserts a provider and enables it. → SKILL §4.1 (credential law — never
  pass raw keys in dispatch args; the document resolution order).

### 1.3 Python SDK guide (`deepseek-harness.github.io/.../guide/python-sdk`, retrieved 2026-09-07)

- Prerequisites: Python ≥3.10, git; `pip install deepseek-harness-sdk`
  includes a matching native runtime wheel and the `dsh` command; normal SDK
  execution needs no system Node.js. → SKILL §2.3b.
- Environment: `DEEPSEEK_API_KEY` required; optional `DEEPSEEK_BASE_URL` for a
  compatible proxy endpoint (this is the sanctioned proxy-aiming mechanism).
  → SKILL §4.1 (router aiming precedent).
- Programmatic shape: `DeepSeekHarness(provider=, model=, max_tokens=49_152,
  cwd=, dsh_home=, profile=)` used as a context manager; `harness.run(task,
  session_id=)` returns a result with `.final_response`. The SDK starts the
  bundled `dsh --profile sdk-minimal` process lazily and reuses it until
  context-manager exit. The profile, its persistent patch, the home patch, and
  any ordered `patches` tuple form the application configuration. There is no
  separate Python runtime bin or complete-config option. → SKILL §2.3b.
- Example contract: always pass explicit `--workspace` and `--dsh-home` paths;
  the example and SDK never silently read `~/.dsh`. → SKILL §2.3b isolation.
- sdk-minimal profile properties: system prompt from `DSH_SYSTEM_PROMPT`
  (fallback: helpful-software-engineer line); model resolves `--model` →
  `DSH_MODEL` → `deepseek-v4-flash`; model-facing tools = persistent
  bash (Linux/macOS) or pwsh (Windows) + `str_replace_editor`; shell timeout
  300 s; editor output limit 16,000 characters; no runtime context or
  compaction; session persistence = uncompressed JSONL under
  `<dsh_home>/sessions`. → SKILL §2.3b (limits shape task design: bounded
  steps, small edits, no reliance on compaction).
- The profile's sole bundle inserts the complete tree over an empty root and
  does NOT include `dsh-base` — later base-profile tools cannot appear
  implicitly. It contains the SDK protocol, one environment-configured DeepSeek
  adapter, local execution, and persistence, while settings, managed
  credentials, telemetry, Web tools, subagents, local instruction discovery,
  and compaction are absent. It pins `danger-full-access`, so the shell and
  editor can modify any path visible to the runtime — use a disposable
  checkout or container. → SKILL §2.3b (sdk-minimal = disposable only).
- Another profile is valid for SDK use only when it includes
  `@deepseek-ai/dsh-sdk-app` or another JSON-RPC server row. Missing server
  rows, unresolved plugins, and invalid patches fail during startup instead of
  falling back to another composition. → SKILL §4 (fail-loud law).
- Isolation doctrine (SDK guide): use a fresh home when profiles, plugins,
  credentials, settings, and sessions must be isolated; use a fresh session id
  for independent work; reuse a harness, home, and id only to continue the same
  durable conversation and session-owned resources. → SKILL §2.3b.
- Plugin persistence: `dsh plugin --profile sdk-minimal add file:<path>`
  (initialize first via `--dump-default-config >/dev/null`); edit
  `$DSH_HOME/profiles/sdk-minimal/cordis.patch.yml` for persistent row
  changes; pass patch files from Python for per-launch changes. `web` is a
  separate CLI application and cannot serve a Python SDK client.
  → SKILL §2.3b.

### 1.4 Local live-fire verification (this machine, 2026-09-07)

- Installed release: `npm install -g @deepseek-ai/dsh@0.1.0-rc.8` — the exact
  command the `fcc-dsh` wrapper (free-claude-code launcher shim at
  `~/.local/bin/fcc-dsh`) prints when it cannot find `dsh`. Launcher resolves
  at `~/.local/bin/dsh`, version 0.1.0-rc.8. npm blocks postinstall scripts
  for `node-pty`/`koffi`/`protobufjs` by default (warnings only; boot and
  headless run worked regardless on Node v26.8.1).
- `$DSH_HOME` unset → default `~/.dsh` (profiles: headless, web).
- Router: `/api/version` HTTP 200 on loopback 11434; real round-trip
  `/v1/chat/completions` (max_tokens 1, model `local-router/fallback-models`)
  returned HTTP 200 with the chain serving `glm-5.3-flash`. Liveness ≠ health:
  the round-trip is the probe that counts (re-confirms 2026-09-05 lesson).
- Credentials schema discovery (two boot failures, both fixed):
  1. `.credentials.yaml` `version: 1` (integer) → `credentials-local: the
     value for "version" ... must be a string`. Parser source
     (`dsh-credentials-local/lib/index.js::parseCredentialsDocument`) reveals
     the true schema: the document is a STRICT FLAT mapping of
     credential-ref → non-empty string; non-string values, nested mappings,
     and empty strings are all rejected fail-loud.
  2. After fixing `version`, the nested `refs:` block failed the same way.
     Root cause: the old document (nested `version`/`refs`/`records` shape,
     written by a different tool on Sep 4) is entirely incompatible with rc.8.
     Fix: flattened to five top-level `KEY: value` rows (all keys preserved;
     `records:` browser-session grant dropped — dsh does not consume it).
     Backups: `~/.dsh/.credentials.yaml.bak-20260907`,
     `~/.dsh/settings.yaml.bak-20260907`.
- `agent-default-model.reasoningEffort: max` → boot failure
  `UNSUPPORTED_REASONING_EFFORT: provider "ollama-local-router" model
  "local-router/fallback-models" does not support reasoning effort "max"`.
  Row removed (openai-completions adapter carries no reasoning-effort support).
- Green pong after fixes: `dsh --profile headless "Reply with the single word:
  pong..."` → exit 0, stdout `pong`, silent stderr (~matches §1.2 contract
  exactly). Session log
  `~/.dsh/sessions/--mnt-d-Code-orchestrate-masters-v4--/session-99dc594e-c6be-4f31-bc09-1020ae9c7c91/session.jsonl.zstd`
  records `"provider":"ollama-local-router"`, `"model":
  "local-router/fallback-models"` ×7 — the runtime ground truth.
- Session layout discovery: workspace slug = absolute path with `/` → `-`
  wrapped in `--` (e.g. `--mnt-d-Code-orchestrate-masters-v4--`); log file is
  `session.jsonl.zstd` (zstd; decompress to grep provider/model).
  → SKILL §4.1 (model verification procedure updated).

---

## PART 2 — ANTHROPIC PUBLISHING

### 2.1 "How we built our multi-agent research system" (anthropic.com/engineering, Jun 13 2025)

- Architecture: orchestrator-worker. Lead agent saves its plan to Memory
  BEFORE spawning (context beyond 200k tokens is truncated — persist the plan),
  spawns specialized subagents that search in parallel with their own context
  windows, synthesizes, optionally spawns more, and a separate CitationAgent
  does final attribution. → SKILL §1 (plan-before-dispatch), §5 (artifact
  handoffs).
- Result: Opus 4 lead + Sonnet 4 subagents beat single-agent Opus 4 by 90.2%
  on the internal research eval. → SKILL §2.0 (why fan out at all).
- Cost analysis: token usage alone explains 80% of BrowseComp performance
  variance; token usage + tool-call count + model choice explain 95%. Agents
  use ~4× chat tokens; multi-agent systems ~15×. "Multi-agent architectures
  effectively scale token usage" — the win is largely bought with compute;
  model upgrades are efficiency multipliers on that spend. → SKILL §1 cost
  doctrine (fan-out must buy something a bigger turn budget cannot).
- Fit/misfit: excel at breadth-first, parallelizable, context-overflowing,
  tool-heavy work; poor fit when all agents must share one context or when
  subtasks interdepend — "most coding tasks involve fewer truly parallelizable
  tasks than research." → SKILL §2.0 topology rules (read/write axis).
- Prompting principles (primary lever — early agents spawned 50 subagents for
  simple queries, scoured the web endlessly, distracted each other with
  excessive updates):
  1. Think like your agents — simulate with the exact prompts and tools,
     watch step-by-step; failure modes become obvious. → SKILL §8 (prompt
     iterations are simulation-driven, not vibes).
  2. Teach the orchestrator how to delegate — each subagent needs an
     OBJECTIVE, an OUTPUT FORMAT, guidance on TOOLS/SOURCES, and clear TASK
     BOUNDARIES. Vague briefs ("research the semiconductor shortage")
     produced duplication and gaps. → SKILL §2 Task Prompt Contract (the four
     required fields beyond scope/gates).
  3. Scale effort to query complexity — agents cannot judge appropriate
     effort; embed scaling rules: fact-finding = 1 agent, 3–10 tool calls;
     comparisons = 2–4 subagents, 10–15 calls each; complex research = >10
     subagents with clearly divided responsibilities. → SKILL §2.0 effort
     scaling bands.
  4. (Blog continues past truncation in the fetch:) teach subagents to judge
     WHEN TO STOP (escape hatches: "give up when evidence is sufficient"),
     keep boundaries non-overlapping. → SKILL §2 STOP CONDITIONS.
- Production reliability (post-truncation takeaways retained from the full
  post): async parallel execution of subagents; agent trajectory tracking +
  "multi-agent linearizer" (stateful refresh when an agent hiccups); tool
  design improvements (deduplicated search calls, clear tool intent, a
  "think" tool for interleaved reasoning); start-to-end evaluations +
  LLM-as-judge + manual inspection + human feedback pipeline.
  → SKILL §5/§7 (receipts = trajectory record; evaluator separation).

### 2.2 "Patterns and problems in emerging multiagent systems" (anthropic.com/research, Aug 13 2026)

- Agents cooperate well TODAY when treated as tool invocations (well-defined
  prompt in, artifact out). Where they stumble: treating each other as
  long-lived peers with goals and no hierarchy. → SKILL §1 (dispatch = tool
  call with a contract, never a peer chat).
- Vulnerability-detection experiment: 45 agents, each with its own VM, a
  SHARED FORUM for coordination, identical prompt; peer review of findings +
  a separate ARBITER agent deciding validity. Result: coordinating swarm 266
  vulns over 27M tokens vs pre-assigned parallel agents 21 vulns over 6.5M —
  but ~half the swarm's finds were outside the pre-assigned core dirs
  (tokens-per-vuln comparable in-core), and only 12 findings were common to
  both methods (largely COMPLEMENTARY). The swarm agents built their own
  tools and specialized in vuln classes. Anthropic's prediction:
  specialization + coordination will dominate uncoordinated brute-force.
  → SKILL §2.0 arbiter pattern; conformity mitigation; wtf hub as the forum
  plane (§9).
- Fantasy-game swarms (interdependent build work): baseline
  "form teams and work together" vs prescriptive-roles prompt vs CEO-hierarchy
  prompt made NO material difference — products were bad in all three.
  Coordination quality varied by model generation, measured as PR-merge
  fraction vs code-sharing degree: older models committed to the same files
  with low merge rates (conflict abandonment); newer models "solved" conflict
  by SILOING (very high per-file ownership, little true co-editing); only the
  newest model sustained high code-sharing AND high merge throughput.
  → SKILL §2.0 (worker ownership boundaries are the practical conflict
  cure for TODAY's models: one owner per file set; hierarchy prompts are
  not a substitute).
- Conformity risk: individual agents are "low variance" — they often act the
  same where different humans would diverge; all that differentiates two
  agents is context, scaffolding, and prompts. Identical scaffolds therefore
  reproduce identical blind spots, and benign individual quirks can compound
  into systemic failures. → SKILL §2.0 conformity mitigation: diversify
  scaffold (persona framing, tool order, prompt structure, starting hints)
  across same-model parallel auditors.

### 2.3 "Harness design for long-running application development" (anthropic.com/engineering, Mar 24 2026)

- GAN-inspired loop: generator agent + evaluator agent. To make subjective
  quality gradable: explicit GRADING CRITERIA given to BOTH sides (design
  quality / originality / craft / functionality), weighted toward the axes the
  model is weak on (design + originality over craft + functionality), with
  criteria that penalize generic "AI slop" patterns; evaluator calibrated with
  few-shot scored examples to reduce drift; evaluator interacts with the LIVE
  artifact (Playwright MCP navigation) rather than scoring a screenshot;
  5–15 iterations; generator instructed to choose refine-vs-pivot after each
  evaluation. → SKILL §5 evaluator loop (criteria + live verification +
  refine/pivot).
- Long-running failure modes: (a) incoherence as context fills;
  (b) "context anxiety" — premature wrap-up near the perceived context limit.
  Fix: CONTEXT RESETS (fresh agent) + STRUCTURED HANDOFF artifact carrying
  state and next steps — distinct from compaction (same agent, shortened
  history), which preserves continuity but not a clean slate. Community
  equivalent named: the "Ralph Wiggum" method (hooks/scripts driving
  continuous fresh-agent iteration). → SKILL §2.7 ralph doctrine + §5
  handoff artifacts (context reset = fresh dispatch; the artifact is the
  memory).
- Self-evaluation leniency is structural: agents confidently praise their own
  work, most visibly on subjective tasks; even on verifiable tasks they show
  poor in-flight judgment. "Tuning a standalone evaluator to be skeptical
  turns out to be far more tractable than making a generator critical of its
  own work." → SKILL §5 evaluator-separation rule (never self-approve;
  separate skeptical dispatch).
- Harness assumptions go stale as models improve (their example: context
  resets became dead weight on a newer model). → SKILL §8 reflection ledger
  (audit scaffolds each round; delete dead weight).

### 2.4 "Scaling Managed Agents: Decoupling the brain from the hands" (anthropic.com/engineering, Apr 08 2026)

- Virtualized interfaces that outlive implementations: SESSION (append-only
  log of everything that happened), HARNESS (the loop that calls the model and
  routes tool calls), SANDBOX (execution environment). Each can fail or be
  replaced independently. → SKILL §1 (session/harness/sandbox separation is
  the mental model for receipts + worktrees).
- Pets → cattle: container death = an ordinary tool-call error the harness
  passes to the model; reinitialize from a standard recipe
  (`provision({resources})`). Harness death = `wake(sessionId)` +
  `getSession(id)` + resume from last event; the harness writes
  `emitEvent(id, event)` so nothing in the harness needs to survive a crash.
  → SKILL §5 (crashed dispatch = re-dispatch from the handoff artifact, never
  nurse the old process).
- Security boundary: in the coupled design, prompt injection only had to
  convince the model to read its own environment's tokens. Structural fix:
  credentials are never reachable from the sandbox — auth bundled with the
  resource (git remote wired at clone) or held in a vault behind a proxy; the
  harness is never made aware of credentials. → SKILL §7 privacy rule
  (profiles carry their own provider config; zero raw keys in dispatch args).
- The session is not the model's context window: context lives durably OUTSIDE
  the window in the session log; `getEvents()` reads positional slices; the
  harness can transform events (cache organization, compaction) before they
  re-enter context. Irreversible retain/discard decisions are the failure
  mode to avoid. → SKILL §4 (dsh session log = recoverable ground truth; read
  it instead of trusting memory).
- TTFT note: decoupling brains from containers cut time-to-first-token
  (no per-session container setup when no sandbox is touched).
  → cost/latency background only.

### 2.5 Dynamic workflows in Claude Code (claude.com blog May 28 2026; code.claude.com/docs/en/workflows; Trilogy analysis Jun 05 2026)

- Mechanism: Claude writes a JavaScript orchestration script; a separate
  runtime executes it in the background while the session stays free. The
  plan lives in CODE (script variables), not in model memory: "the loop, the
  branching, the intermediate results — the script absorbs all of that, and
  Claude's context holds only the final answer." → SKILL §2.6 workflow
  doctrine sharpened: the script, not the orchestrator's context, is the
  ledger for long fan-outs.
- Caps: tens-to-hundreds of subagents per session; 16 concurrent; 1,000 per
  run hard cap. Primitives: `agent(prompt)` per unit, `pipeline` for
  per-item stages, `parallel` only at true barriers. → SKILL §2.6.
- The trust mechanism is NOT headcount: "agents address the problem from
  independent angles, other agents try to refute what they found, and the run
  keeps iterating until the answers converge" — the bundled `/deep-research`
  fans searches across angles, cross-checks sources, votes on claims, and
  filters out claims that did not survive. "A thousand agents that don't
  check each other is just a thousand ways to be confidently wrong."
  → SKILL §2.0 adversarial-verification rule (fan out → refute → converge).
- When to use: genuinely unpredictable, one-off, exploratory work (unfamiliar
  debugging, evidence-following research, run-once migrations). WRONG for
  repetitive production tasks / nightly runs / work whose components you can
  already name — a plain pipeline of subagents is cheaper and more
  predictable there. A snag "might spend 5× more tokens recovering."
  Anthropic's own advice: run on a small slice first. Headline datapoint:
  Bun's 750k-line Zig→Rust port in 11 days at 99.8% test-pass.
  → SKILL §1 cost doctrine + §2.0 (small-slice-first rule).
- Historical frame (Building Effective Agents, Dec 19 2024): workflows =
  LLMs/tools orchestrated through predefined code paths; agents = LLMs
  dynamically directing their own processes; five patterns (prompt chaining,
  routing, parallelization, orchestrator-workers, evaluator-optimizer).
  2024 said "you hand-code these"; 2026 said "the model writes them." The
  patterns did not change — the automation did. → background for §2.6.

---

## PART 3 — OPENAI PUBLISHING

### 3.1 Codex subagents (developers.openai.com/codex/subagents; launch Mar 16 2026)

- Dispatch discipline: "Codex only spawns subagents when you explicitly ask
  it to" — subagent workflows consume more tokens than comparable
  single-agent runs. The orchestrator handles spawning, routing follow-ups,
  waiting, and closing threads; when many run, Codex waits until all
  requested results are available, then returns one consolidated response.
  → SKILL §2.0 (explicit-dispatch-only default; consolidated collection).
- Custom agents: standalone TOML files under `~/.codex/agents/` (personal) or
  `.codex/agents/` (project). Required fields: `name`, `description`,
  `developer_instructions`. Optional: `model`, `model_reasoning_effort`,
  `sandbox_mode`, `mcp_servers`, `skills.config`, `nickname_candidates`
  (display-only) — all inherit from the parent session when omitted. The
  `name` field is the source of truth. → SKILL §2 (persona = file-carried
  config, inherits defaults; our analogue = the TPL persona prompt blocks).
- Global knobs: `agents.max_threads` (default 6 concurrent), `agents.max_depth`
  (default 1 — "keep the default unless you specifically need recursive
  delegation. Raising this value can turn broad delegation instructions into
  repeated fan-out"), `agents.job_max_runtime_seconds` (default 1800 for
  batch jobs). → SKILL §2.0 concurrency caps (6 concurrent, depth 1,
  1800 s budget — cross-vendor agreement with our `timeout 1800`).
- Built-ins: `default`, `worker` (execution-focused), `explorer` (read-heavy).
  Best agents are "narrow and opinionated"; tool surface matches the job;
  read-only sandbox for explorer/reviewer roles; live parent overrides
  (sandbox/approval choices) are reapplied when spawning children.
  Steering: switch/inspect/stop agent threads mid-flight. → SKILL §2
  (explorer persona = read-only scoping master; steering = our follow-up
  dispatch).
- Batch pattern: `spawn_agents_on_csv` — one worker per CSV row, per-worker
  default timeout 1800 s, combined results exported back to CSV.
  → SKILL §2.6 (row-per-worker fan-out for mechanical batches).
- Launch analysis (baristalabs.io, Mar 16 2026): "ten subagents is where the
  manager tax shows up" — overlap (duplicate file inspections), stale
  assumptions (agent working from a snapshot another agent disproved), and
  merge pressure (arbitration cost grows with write-capable agents). Practical
  ceiling for most teams: 3–5 active branches. Subagents excel at
  read-only/pre-implementation compression ("what does this task really
  touch / what breaks the first attempt / what test surface proves it").
  → SKILL §2.0 caps + read-before-write staging.

### 3.2 Orchestration and handoffs guide (developers.openai.com/api/docs/guides/agents/orchestration, retrieved 2026-09-07)

- The first design choice is OWNERSHIP of the final user-facing answer per
  branch. Two patterns: HANDOFFS (a specialist takes over the conversation
  for that branch — control moves) vs AGENTS-AS-TOOLS (a manager stays in
  control and calls specialists as bounded capabilities — manager keeps
  ownership of the reply). → SKILL §2 (native subagent = manager-keeps-
  ownership; our equivalent of "handoff" = the operator-facing escalation).
- Keep the routing surface legible: narrow jobs, short concrete
  `handoff_description`s, "split only when the next branch truly needs
  different instructions, tools, or policy." "Add specialists only when they
  materially improve capability isolation, policy isolation, prompt clarity,
  or trace legibility." "Start with one agent whenever you can."
  → SKILL §2.0 (add-a-modality bar).

### 3.3 Cross-model routing: Sol → Luna (Codex Multi Agents v2; reporting Aug 24 2026)

- Hierarchy: Sol (planner tier) decomposes, gives Luna (worker tier) a
  BOUNDED assignment, and assembles returned work. Luna executes
  self-contained tasks and CANNOT contact other agents or spawn workers —
  the parent retains all orchestration tools. → SKILL §1 (model tiering:
  bounded execution on the operator-configured engine; the orchestrator
  always retains merge authority).
- Opt-in economics: default remains same-model workers (stronger in evals,
  slower, costlier); cross-model routing trades capability isolation for
  cost. Task-level model + reasoning-effort selection replaces session-wide
  choice. → SKILL §2.0 (tier-down deliberately, per task, not by default).
- Handoff hygiene: a context-free worker needs `fork_turns: none` plus a
  COMPLETE opening instruction containing everything required — "the handoff
  must stand on its own." Reliability guidance: roughly 6–8 subagents
  (not a hard limit). → SKILL §2 Task Prompt Contract (standalone-completeness
  rule) + §2.0 caps.

### 3.4 Symphony (openai.com/index/open-source-codex-orchestration-symphony/, Apr 27 2026)

- Inversion: stop supervising sessions; make the issue tracker the control
  plane. Every open task gets an agent; agents run continuously; the
  orchestrator watches the board, restarts crashed/stalled agents, and picks
  up new work. Tickets decouple from sessions and PRs (one ticket may yield
  multiple PRs or pure analysis). → SKILL §5 (work items, not sessions, are
  the unit of orchestration; COMMS ledger = our board).
- Dependencies: agents only start unblocked tasks — execution unfolds as a
  DAG (their example: React upgrade blocked on Vite migration started only
  after it). → SKILL §2.0 (dependent scopes block on receipts).
- Discovered work: during implementation, agents file NEW issues for
  out-of-scope improvements (perf issues, refactor opportunities) instead of
  scope-creeping. → SKILL §7 (scope conformance; discoveries become new
  scoped dispatches, never silent expansion).
- Spec-as-orchestrator: "Symphony is technically just a SPEC.md file" — the
  supervisor is a written definition of problem + intended solution giving
  agents high-level steering. 500% increase in landed PRs on some teams in
  three weeks; exploration got so cheap that speculative tasks are routine;
  PMs/designers file work directly. → SKILL §1 (the skill file itself is the
  SPEC that carries the intelligence; low-intelligence engines execute it).
- Guardrail philosophy: rather than patching bad outputs manually, add
  guardrails and skills so agents succeed NEXT time (they added e2e tests,
  Chrome DevTools driving, QA smoke skills). And: "treating agents as rigid
  nodes in a state machine doesn't work well... we moved toward giving agents
  objectives instead of strict transitions." → SKILL §2 (objectives + gates,
  not step-by-step choreography) + §8 (each failure round hardens the skill).
- Human role: ambiguous, high-judgment problems stay interactive; the board
  carries routine implementation. Humans review at the ticket level.
  → SKILL §7.7 (operator confirms every merge).

### 3.5 Swarm → Agents SDK evolution (github.com/openai/swarm README; retrospective Jun 12 2026)

- Swarm (Oct 2024, educational): an Agent = instructions + tools; routing =
  returning an Agent object from a function call; entirely stateless,
  client-side, Chat Completions–powered; `context_variables` for shared
  state. Now redirects to the Agents SDK ("production-ready evolution").
  → historical root of the handoff pattern; the primitives (instructions +
  tools + routing) are exactly our persona/task/receipt triangle.
- SDK productionization adds: declarative handoffs; input/output guardrails;
  tracing (OpenTelemetry, parent-child spans, token counts); sessions;
  sandbox agents (manifest-driven containers, snapshot/rehydrate);
  human-in-the-loop approval checkpoints; async-first. Known cost warning:
  "handoff chains multiply token usage." → SKILL §7 (guardrails = our gates;
  HITL = operator merge gate; token-amplification warning folded into §1
  cost doctrine).

---

## PART 4 — TOPOLOGY SYNTHESIS (cross-vendor)

- The three shapes are ONE AXIS: how much context can be lost between agents.
  PIPELINE (sequential, context accumulates, fully preserved) — for
  interdependent stages sharing evolving state. ORCHESTRATOR-WORKER (lead
  fans out parallel workers that are BLIND to each other, then synthesizes)
  — for genuinely independent, read-mostly subtasks. SWARM/peer-handoffs
  (control flow AND state dynamic) — only when routing itself is the
  problem; keep the handoff graph and shared state minimal.
  (dreaming.press topology analysis Jul 06 2026, resolving Anthropic's
  +90.2% vs Cognition's "Don't Build Multi-Agents": both are right, scoped
  by the axis.)
- The rule: FAN OUT FOR READ; SINGLE-THREAD FOR WRITE. Interdependent
  write-heavy work must serialize (pipeline) or stay with one agent.
  → SKILL §2.0.
- Decision heuristic, in order: (1) start with one agent with enough turn
  budget; (2) if the task overflows one context window AND splits into
  independent parts → orchestrator-worker, accept the ~15× bill only for
  real breadth, and note that letting workers spawn workers compounds it
  (every summarization seam throws away intermediate output); (3) if parts
  depend on each other → pipeline, retry the step not the run; (4) swarm
  only for routing problems. → SKILL §2.0.

---

## PART 5 — LOOP ENGINEERING (skill-native doctrine; pure implementation)

No external dependency, no multi-backend selection matrix, no backend-fallback
logic — the orchestrator implements the loop natively around one engine.
Each rule below maps to its SKILL.md implementation surface.

### 5.1 The thesis — Loop Engineering

- The model determines what an agent can do in one round; the orchestrator
  engineers the loop around it: what to do next, how to verify the result on
  the real machine, what progress to preserve, and how to continue after
  failure or context refresh. The loop does not train a model or replace an
  agent — it is the durable execution loop around one. → SKILL §2.8 (the loop
  is the orchestrator's job, not the engine's).
- The loop: plan → act (fresh context) → verify in the real environment →
  checkpoint or recover → repeat — until the work is actually done.
  Concretely: original goal + verified state → plan the next bounded step →
  act with fresh context → verify files/UI/logs/tests in the real environment
  → pass: checkpoint verified progress; fail: record evidence and recover →
  task complete? no → next round from state. → SKILL §2.8 (canonical round).
- Lever law: with the SAME model and backend, changing only the loop produces
  step-change gains in pass rate and token efficiency — the loop, not the
  model, is the lever. → SKILL §2.8 (the exact fleet differentiator).

### 5.2 Three roles as ONE loop's implementation boundaries

- Roles are "implementation boundaries inside the loop, not three agents
  independently growing their own versions of the task":
  - Manager (state + next step): rebuilds each round from the original goal,
    verified progress, failure evidence, and remaining work.
  - Executor (action): starts with a FRESH context and completes one clearly
    defined bounded step.
  - Auditor (ground truth): independently inspects the actual files,
    interfaces, logs, and tests instead of trusting the Executor's claim.
  → SKILL §2.8 (role table; Manager = orchestrator + plan artifact,
  Executor = fresh dsh headless dispatch, Auditor = independent read-only
  scoped dispatch).
- State law: "Only results that pass independent verification become trusted
  task state. A rejected result remains evidence, not progress." Context
  refresh, action failure, or failed inspection → the next round starts from
  the original goal and the last verified checkpoint, continuing what
  remains. → SKILL §2.8 (verified-state checkpointing; evidence-not-progress).

### 5.3 Round ledger, final reply, caps, timeouts

- Run record (per run, under the run's own directory): task state (original
  goal, requirements, verified progress, remaining work), event stream,
  audit reports (evidence + acceptance decisions for every round), role
  trajectories (Manager/Executor/Auditor inputs + outputs), workspace, and
  the final report. → SKILL §2.8 (round-ledger artifact shape).
- Final reply: plain language, answers the task from the VERIFIED
  state alone, and says plainly if the task did not finish. Follow-ups
  continue on the run's own round ledger instead of replanning from
  scratch; a mid-round message is claimed by the very next round; graceful
  stop escalates to force-stop only when a worker ignores it.
  → SKILL §2.8 (final-reply law) + §5 (resume from ledger, not memory).
- Caps and timeouts: ~30 rounds max; per-EPISODE limits (one role
  invocation, not the run): manager 600 s, executor 1800 s,
  auditor 600 s. A timeout keeps the partial trajectory and recorded task
  state, then the next Manager round inspects the real workspace and
  recovers — a timeout is an agent execution timeout, never proof of a
  provider network failure. Repeated timed-out
  rounds trigger a human-review gate. → SKILL §2.8 caps + §4.3 (timeout
  normalization keeps partial work recoverable).
- Role tiering: pay for strength where it matters — a capable Manager and
  skeptical Auditor over a cheaper Executor. → SKILL §2.8 (tiering rule; on
  this fleet the model is the operator's single local-router/fallback-models —
  tiering happens via persona scaffolding, never model swaps).

### 5.4 Permission asymmetry & hygiene (implementation law)

- Execution asymmetry: every run gets an ISOLATED engine home; executors run
  `workspace-write`; the Manager and auditors run read-only.
  → SKILL §2.8 (permission asymmetry mapped to our law: executor dispatches
  own the worktree; manager/auditor verification stays read-only) + §4.1
  (loopback-only probes; proxy aiming via environment, never dispatch args).
- One-shot surface facts: the headless profile returns only the final
  answer (intermediate tool events are not streamed into the trajectory);
  and the positional task interface means the task text is visible in the
  child process argument list while an episode runs.
  → SKILL §2.8 + §7 (ephemeral task files; never put secrets in task text —
  argv is observable).
- Secrets doctrine: task text, run IDs, and API keys are deliberately NOT
  configurable in the project config file — they stay command-line or
  environment inputs "so they never land in a file you might commit."
  → SKILL §4/§7 (no secrets in any committed artifact).
- `doctor`/preflight is read-only and verifies agent CLIs by RUNNING `<binary>
  --version`, not just by finding them on PATH — a present-but-broken
  install is reported as a failure with fix instructions; exits non-zero
  when a required check fails. → SKILL §4.1 (our pong preflight = the same
  philosophy: exercise the binary, don't trust presence).
- Auditor hardening: stronger read-only checks and role isolation; the
  orchestrator's own state directory stays off-limits to the
  agents so run logs are never mistaken for task content.
  → SKILL §2.8 (auditor isolation) + §7 (receipts/artifacts live outside the
  worktree's task surface).

### 5.5 Implementation stance

- The loop-engineering doctrine is ADOPTED skill-native (SKILL §2.8); the
  fallback machinery is STRIPPED: no external loop-harness install, no
  multi-backend adapter matrix, no backend-fallback logic — one engine, one
  loop, for simplicity and robustness. The doctrine transfers; the machinery
  does not.

---

## PART 6 — SYNTHESIS MAP (finding → SKILL.md v4 section)

| Research finding | Lands in SKILL v4 |
|---|---|
| Scaffold carries the intelligence (Symphony SPEC.md + our operator framing: low-intelligence engines reach frontier outcomes via allowlists/personas/artifacts/gates) | §1 |
| Cost: 15×/4× multipliers; 80% variance = tokens; 5× recovery; small-slice-first; repetitive work → plain pipeline | §1 cost doctrine |
| Fan out for read / single-thread for write; pipeline vs orchestrator-worker vs swarm axis | §2.0 |
| Effort scaling bands (1 agent/3–10 calls; 2–4 subagents/10–15; >10 rare) + vendor caps (max_threads 6, depth 1, 6–8 reliability, 16/1000) + 1800 s worker budget | §2.0 |
| Delegation fields: objective + output format + tool guidance + task boundaries (Anthropic) + standalone-completeness (fork_turns: none) | §2 Task Prompt Contract |
| Stop conditions / escape hatches (teach subagents when to stop) | §2 Task Prompt Contract |
| Adversarial verification: fan out → refute → converge; claims that fail cross-check filtered | §2.0 arbiter + §5 evaluator |
| Conformity/low-variance: diversify scaffolds across same-model auditors; shared forum + peer review + arbiter (45-agent experiment) | §2.0 + §9 wtf-as-forum |
| File-ownership siloing is today's conflict cure; hierarchy prompts don't fix coordination | §2.0 ownership boundaries |
| Evaluator separation: skeptical fresh-context evaluator; grading criteria; live verification; refine-vs-pivot | §5 |
| Context resets + structured handoff artifacts beat compaction; crashed dispatch = re-dispatch from artifact (cattle) | §5 |
| Ownership: handoffs vs agents-as-tools; add specialists only when the contract changes; start with one agent | §2.0 |
| Objectives over state machines; discovered work → new scoped dispatch; plan-to-memory before spawning | §1/§5/§7 |
| dsh raw exit contract (0/1, SIGINT 130, SIGTERM 0), silent-stderr success, layer precedence, dump provenance, credentials order + flat schema, workspace-write default, AGENTS 65,536-byte auto-load, session-log ground truth | §4 |
| SDK params/limits (provider/model/max_tokens/patches; 300 s shell; 16k editor; uncompressed JSONL; fail-loud startup; never ~/.dsh) | §2.3b |
| Credentials/sandbox hygiene: tokens never in dispatch args; profile-owned provider config; operator dashboard remains authority | §4/§7 |
| Loop engineering: plan → act (fresh ctx) → verify → checkpoint/recover → repeat; the loop, not the model, is the lever | §2.8 |
| Manager/Executor/Auditor as one loop's boundaries; verified-state checkpointing; rejected result = evidence not progress; final reply from verified state alone | §2.8 |
| Round-ledger artifact; caps ~30 rounds, executor 1800 s / manager+auditor 600 s; timeout = recoverable state, not failure | §2.8 + §4.3 |
| Engine isolation: isolated engine home per run; workspace-write executors vs read-only Manager/auditors; secrets CLI/env only; preflight runs `<binary> --version` | §4/§4.1 |

## APPENDIX — 2026-09-07 config directive verification transcript (summary)

1. Operator directive: fleet dsh agent config = local-router ollama endpoint,
   model `local-router/fallback-models` (supersedes Round-3
   deepseek-official/zai notes; supersedes only as the CURRENT operator-owned
   value — the dashboard remains the source of truth).
2. `settings.yaml`: `agent-default-model` → provider `ollama-local-router`,
   model `local-router/fallback-models`; `reasoningEffort` row removed
   (unsupported by the openai-completions router adapter — boot-failed live,
   twice-confirmed signature).
3. `.credentials.yaml`: flattened to rc.8's strict ref→string schema (five
   keys preserved; nested legacy document backed up and retired).
4. Harness installed: `@deepseek-ai/dsh@0.1.0-rc.8` global (wrapper-directed).
5. Verification: router `/v1/chat/completions` round-trip HTTP 200 (chain
   served `glm-5.3-flash`); dsh pong exit 0 / stdout `pong` / silent stderr;
   session log records `ollama-local-router` + `local-router/fallback-models`.
   GO.

6. Repo-memory MCP plane (2026-09-08): memorix@1.3.0 + @modelcontextprotocol/
   server-memory 0.6.3 + engram v1.20.0 verified live (initialize/tools/list/
   write-read roundtrips) and wired into all four dsh profiles via
   ~/.dsh/memory-mcp.cordis.yml inlined into each profile's cordis.patch.yml —
   dsh headless store→fresh-session recall roundtrip green. Skill pack:
   .agents/skills/repo-memory-graph-intelligence/SKILL.md. Gotchas: patch files accept ONE YAML
   array (no include:, no second document after []); engram mem_search takes
   `query` (not `q`); reference-memory relations require both endpoints first.
