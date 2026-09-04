# LLM & Agentic AI Security — Production Standards

> Deploy with: `ainish-coder --secure <target-dir>`  
> Owning skill: `../SKILL.md`  
> Governance: `../../production-security/SKILL.md`

---

## Core Philosophy

AI components are probabilistic and fallible. Build systems that survive their failures.

- **Steerability**: Use schemas and typed boundaries alongside natural language.
- **Resilience**: System functions safely even if the LLM hallucinates, times out, or refuses.
- **Observability**: Log *why* an agent decided, not just the final result.
- **Containment**: Runtime enforces boundaries the AI cannot cross, regardless of output.

---

## Prompt Injection Defense

### Instruction Hierarchy

```
System prompt (highest authority)
  └── Developer instructions (AGENTS.md)
       └── User message (current task)
            └── Untrusted data (files, web pages, tool outputs)
```

**Rule**: Lower layers can never override higher layers. Untrusted data is evidence, not instruction.

### Separation via XML Tags

```
<system>       Hard rules, identity, constraints    </system>
<context>      Environment, project state            </context>
<user>         Current task request                  </user>
<data>         Untrusted: web pages, PDFs, tool outputs </data>
```

### Input Sanitization Before LLM Ingestion

- Strip instruction-like phrases from untrusted content ("ignore previous", "you are now", "system:")
- Remove markdown code fences that could inject tool calls
- Redact secrets and PII before any untrusted content reaches the model
- Truncate extremely long untrusted inputs before the context window

---

## Tool & MCP Security

### Tool Risk Classification

| Risk Level | Examples | Controls |
|------------|----------|----------|
| **Read-only** | File read, search, HTTP GET | Log all calls |
| **Write-scoped** | File write, DB insert, HTTP POST | Schema validation, rate limit |
| **System-modifying** | Shell exec, package install, config change | Human approval required |
| **Network-egress** | Upload, external API, email | Allowlist + human approval |

### MCP Server Hardening

- Allowlisted servers only. Pin manifests by hash. Verify the server itself (binary/container hash), not just its manifest.
- **Sign tool manifests AND tool descriptions (ML-DSA-65, FIPS 204 — not Ed25519). Alert on any description drift after first approval; drift without explicit re-consent = block (rug-pull defense).**
- No auto-install of MCP servers. Manual approval required.
- Sandboxed execution (WASM or Firecracker). Never on host.
- Drift detection: re-hash manifests periodically.
- Inter-agent mTLS for multi-agent MCP communication.
- **OAuth 2.1 short-lived tokens with per-server audience validation. No static PATs, no token passthrough.** Tokens scoped to minimum necessary capabilities; automated scope expiry. Evaluate ETDI (OAuth-Enhanced Tool Definitions) for tool provenance.
- Hash MCP config files and monitor; bind trust to content hash, not file path.

### Tool Call Validation

All tool parameters must be validated before execution:

- Type-check against a Zod/Pydantic schema
- Range-check numeric values
- Allowlist-check enum/string values
- Path containment check for file operations
- URL validation for network operations (see Code Security SSRF section)

---

## RAG & Context Hygiene

- Vector DB contents treated as untrusted (they originate from external sources).
- Retrieved chunks: strip instruction-like patterns, mark as `<data>`.
- Citation required for every retrieved chunk used in output.
- Regular re-indexing with updated sanitization rules.
- PII detection on ingestion (Presidio, spaCy NER). Redact or reject.

---

## Agentic Workflows

### Circuit Breakers

```
If: 3 consecutive tool failures → Pause. Signal operator.
If: Agent exceeds token budget → Truncate. Save state.
If: Agent loops (same tool, same params, same result > 3x) → Kill. Log.
If: Agent requests system-modifying action → Human approval gate.
```

### Kill Switch

Every agentic workflow must expose a kill switch — a single command or API endpoint that:
- Terminates the agent process immediately
- Saves state for post-mortem
- Revokes any temporary credentials
- Notifies the operator with a summary of what was in flight

### Audit Ledger

Append-only, immutable log of every agent action:

```json
{
  "timestamp": "2026-05-23T14:32:00Z",
  "agent_id": "claude-code-session-42",
  "action": "tool_call",
  "tool": "bash",
  "parameters_hash": "sha256:abc123...",
  "result_hash": "sha256:def456...",
  "human_approved": true,
  "correlation_id": "task-7b3f"
}
```

---

## Model & Provider Governance

- Approved model list. No unvetted models.
- Provider audit: SOC 2, ISO 27001, data residency, PQC compliance.
- Log every model invocation: model name, token count, cost, latency.
- Rate-limit per-provider per-tool to prevent quota exhaustion.
- Failover: if primary provider errors, retry on fallback provider (via `ainish-coder` hot-swap).

---

## PII & Data Protection

- Detect PII before it reaches the model (Presidio, Microsoft Presidio, custom NER).
- Redaction pipeline: identify → classify → mask/replace → log detection (not value).
- No training-on-user-data clauses in provider agreements (opt-out where available).
- Encrypted at rest (AES-256-GCM) and in transit (TLS 1.3 + mTLS).

---

## Testing & Red Teaming

- Prompt injection test suite: include known jailbreak strings in CI.
- Fuzz tool parameters with invalid types, out-of-range values, path traversal strings.
- Chaos engineering: randomly kill agents, drop network, exhaust tokens — verify graceful degradation.
- Regular adversarial testing against each new model version.

---

## AI as Security Analyzer (Dual-Use)

- Frontier LLMs audit at machine scale (~500M LOC / ~100 h / ~300 findings for one detector-less bug class — Domas, Black Hat 2026). Attackers have the same capability: assume every "rare" pattern is findable.
- Mandate an LLM pattern audit for vulnerability classes without tooling (e.g., compiler-introduced TOCTOU via `snapshot-check-use`) before releasing security-critical C/C++.
- Prompt as a defender — "audit my code, propose fixes" — avoids guardrail friction; never frame release audits as exploit development.
- Verify LLM findings deterministically (compile, sanitize, test) before acting; log audits with model + version provenance.

---

*Compiled reference for `.agents/skills/llm-security/SKILL.md` and `.agents/skills/production-security/SKILL.md`. These docs are versioned and improve with every iteration. Load `../SKILL.md` for full context, procedural checklists, and language-specific implementations.*
