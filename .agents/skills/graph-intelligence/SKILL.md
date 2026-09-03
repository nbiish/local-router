---
name: graph-intelligence
description: >
  Enterprise-grade codebase intelligence via a THREE-PILLAR knowledge graph architecture.
  Use GitNexus (AST-precise, call-graph aware) for deterministic code call-chains, blast-radius, and renames.
  Use Graphify (multimodal code+docs+PDFs) for cross-artifact synthesis, community clustering, and visual deliverables.
  Use Semantica (context graphs, decision intelligence, PROV-O) for causal provenance, audit trails, and ontology governance.
  Trigger on: "how does X work", "what calls Y", "what breaks if I change Z", "show me the architecture",
  "ingest this paper/RFC", "why did the agent decide X", "audit trail", or any codebase question.
version: 3.0.0
---

# Graph Intelligence — Master Edition

A unified, three-pillar knowledge-graph architecture providing complete codebase, multimodal, and governance intelligence.

---

## 1. The Three Pillars & Purpose Determination

| Tool | Engine Layer | Primary Specialization & Best Purpose |
|---|---|---|
| **GitNexus** | **AST & Code-Symbol Layer** | **Deterministic code call-chains & blast radius:** AST-precise symbol exploration, incoming/outgoing call hierarchies, cross-file impact analysis, coordinated multi-file renames, and API route contract validation. |
| **Graphify** | **Multimodal & Synthesis Layer** | **Broad cross-artifact system synthesis:** Ingesting heterogeneous sources (code + markdown + PDFs + RFCs), Leiden community clustering, PR triage, and generating interactive visual graph deliverables (`graph.html`, `GRAPH_REPORT.md`). |
| **Semantica** | **Context, Decision & Governance Layer** | **Decision intelligence & causal auditability:** Context graphs, recording first-class agent decisions, tracing causal ancestry ("why did the AI do that?"), W3C PROV-O audit trails, deterministic reasoning (Rete/Datalog/SPARQL), and SHACL/OWL governance. |

### Upstream Repositories & Installation
- **GitNexus:** Learn more at [GitNexus on GitHub](https://github.com/abhigyanpatwari/GitNexus), and install the latest release via `npm install -g gitnexus` (or connect via native MCP stdio `gitnexus`).
- **Graphify:** Learn more at [Graphify on GitHub](https://github.com/safishamsi/graphify), and install the latest release via `pip install graphifyy` (or clone the repository).
- **Semantica:** Learn more at [Semantica on GitHub](https://github.com/semantica-agi/semantica), and install the latest release via `pip install semantica` (CLI: `semantica`, MCP: `semantica-mcp`).

---

## 2. Decision Tree & Operational Routing

- **Code Symbol / Call Graph / Impact?** $\rightarrow$ **GitNexus first.** Query symbols, callers, and blast radius with zero LLM overhead.
- **Cross-Document / Architecture Synthesis / PR Triage?** $\rightarrow$ **Graphify.** Ingest code alongside documentation, RFCs, and papers.
- **Agent Decision / Audit Trail / Policy Enforcement?** $\rightarrow$ **Semantica.** Record decision nodes, trace causal chains, and verify rules.
- **Deep Enterprise Audit?** $\rightarrow$ **Triangulate:** GitNexus (AST verification) + Graphify (cross-doc alignment) + Semantica (decision provenance).

---

## 3. Minimal Core Invocations & Help-Driven Discovery

> **Argument Discovery Protocol:** Do not rely on static tables of CLI flags. Beyond the minimal base commands below, **always run `--help` or `help`** to dynamically discover available options, arguments, and subcommands.

### GitNexus (CLI & MCP)
- **Discover:** `gitnexus --help` or `gitnexus <command> --help`
- **Index Repo:** `gitnexus analyze`
- **Core MCP Tools:** `query` (hybrid search), `context` (360° symbol view), `impact` (blast radius), `detect_changes` (diff impact), `rename` (coordinated rename).

### Graphify (CLI)
- **Discover:** `graphify --help` or `graphify <command> --help`
- **Extract & Ingest:** `graphify extract ./src ./docs`
- **Query Graph:** `graphify query "How does authentication flow?"`
- **PQC Secrets & Provider Bridge:** Source `scripts/graphify-env.sh` before running extractions to bridge local LLM provider keys into Graphify environment variables without writing secrets to disk.

### Semantica (CLI & MCP)
- **Discover:** `semantica --help` or `semantica <group> --help` (groups: `ingest`, `extract`, `kg`, `reason`, `decision`, `provenance`, `ontology`, `validate`, `export`)
- **Health Check:** `semantica doctor`
- **Record Decision:** `semantica decision record --category "<cat>" --reasoning "<rationale>"`
- **Causal Trace:** `semantica provenance trace --id "<decision_id>"`
- **MCP Server:** `semantica-mcp` (or `python -m semantica.mcp_server`)

---

## 4. Concrete "Master" Prompts

### Master A: AST Blast-Radius & Refactoring Master (GitNexus)
*Embody this persona when tracing call hierarchies, assessing pre-edit risk, or executing multi-file symbol refactoring.*

```markdown
# TASK: AST Call-Chain & Pre-Edit Blast Radius Assessment

## ROLE & EXPERT PERSONA
You are acting as the **AST Blast-Radius & Refactoring Master**. You execute deterministic, AST-level call-graph exploration to ensure zero regressions before modifying exported interfaces.

## TOOL DISCOVERY & EXECUTION DIRECTIVES
1. Run `gitnexus analyze` if the repository index is stale, or verify MCP tool availability (`gitnexus --help` for options).
2. Execute `gitnexus_context` on the target symbol `<SYMBOL_NAME>` to map incoming/outgoing call edges.
3. Run `gitnexus_impact` with `direction: "upstream"` to compute the blast radius and identify affected dependent files.
4. If modifying API handlers, execute `gitnexus_shape_check` to verify consumer property expectations.
5. Review results and output a structured blast-radius matrix before writing any code modifications.
```

---

### Master B: Multimodal Architecture Synthesizer (Graphify)
*Embody this persona when integrating documentation with code, clustering modules, or generating visual deliverables.*

```markdown
# TASK: Multimodal Architecture & Cross-Document Synthesis

## ROLE & EXPERT PERSONA
You are acting as the **Multimodal Architecture Synthesizer**. You unify codebases, architecture specifications, RFCs, and markdown documentation into a cohesive, clustered knowledge graph.

## TOOL DISCOVERY & EXECUTION DIRECTIVES
1. Run `graphify --help` and `graphify extract --help` to discover current extraction flags.
2. Source `scripts/graphify-env.sh` to configure provider credentials securely via in-memory PQC secrets.
3. Run `graphify extract <SOURCE_DIR> <DOCS_DIR>` to parse code and documentation artifacts.
4. Execute `graphify query "<QUERY>"` to extract high-level architectural relationships across modules.
5. Generate the interactive visualization (`graph.html`) and markdown summary (`GRAPH_REPORT.md`) for operator review.
```

---

### Master C: Context & Decision Governance Master (Semantica)
*Embody this persona when recording consequential agent choices, auditing causal lineage, or enforcing policy constraints.*

```markdown
# TASK: Consequential Decision Logging & Causal Provenance Audit

## ROLE & EXPERT PERSONA
You are acting as the **Context & Decision Governance Master**. You govern AI decision boundaries, enforce SHACL constraints, and maintain immutable W3C PROV-O audit trails.

## TOOL DISCOVERY & EXECUTION DIRECTIVES
1. Run `semantica --help` and `semantica decision --help` to inspect current command parameters.
2. Verify platform status with `semantica doctor`.
3. Record the operational decision using `record_decision` (or `semantica decision record`), capturing category, scenario, reasoning, and confidence.
4. Trace causal ancestry using `trace_decision_chain` to verify prerequisite policies.
5. Export the audit record in standard JSON/PROV-O format for verification and regulatory compliance.
```

---

### Master D: Triangulated Deep Audit Master (Symbiotic Fleet)
*Embody this persona when conducting a safety-critical audit requiring AST precision, documentation grounding, and decision traceability.*

```markdown
# TASK: Safety-Critical Triangulated Codebase & Policy Audit

## ROLE & EXPERT PERSONA
You are acting as the **Triangulated Deep Audit Master**. You orchestrate GitNexus, Graphify, and Semantica in lockstep to prove structural integrity, specification adherence, and decision provenance.

## SYMBIOIC EXECUTION SEQUENCE
1. **AST Layer (GitNexus):** Map call paths and dependent call sites for the target module. Discover extended filters via `gitnexus impact --help`.
2. **Synthesis Layer (Graphify):** Query related design docs and RFCs to verify implementation matches intent. Discover options via `graphify --help`.
3. **Governance Layer (Semantica):** Audit previous architectural decisions and record the current audit outcome with full causal lineage. Discover arguments via `semantica --help`.
4. Output a unified Triangulated Audit Report highlighting any discrepancies between code, specs, and past decisions.
```

---

## 5. Fleet Orchestration Bridge (Fueling `trae-cli` & `mini`)

Graph Intelligence functions as the radar for the Master Orchestrator, dynamically feeding exact file boundaries and symbols into SWE-bench coding fleet tasks:

1. **Deterministic Target Scoping:** Query `gitnexus_impact(target, direction: "upstream")` $\rightarrow$ Extract all depth $d=1$ and $d=2$ files $\rightarrow$ Inject directly into `SCOPE & TARGET FILES` of `TPL_TRAE_AST_V2`. Subagents never explore or modify out-of-scope files.
2. **TDD Failure Isolation:** When `mini` reproduces a bug, pass the failing test signature and affected symbol to `gitnexus_context` to locate the exact upstream callers $\rightarrow$ dispatch `trae-cli` to perform surgical surgery.
3. **Post-Edit Safety Audit:** Run `gitnexus_detect_changes` on the git diff $\rightarrow$ verify that ONLY the intended symbols were modified and no caller contracts broke.
4. **Causal Audit Provenance:** Once native test gates pass, call `semantica_record_decision` to log the change scenario, graph impact metrics, and generated patch for auditability.

---

## 6. Deep GitNexus Operational Manuals & References

For deep dives into specialized GitNexus capabilities, consult the bundled reference playbooks in `references/`:

| Manual | Focus Area & When to Consult | Primary Command / Tools |
|---|---|---|
| [`gitnexus-cli.md`](references/gitnexus-cli.md) | Indexing, runner setup (`node .gitnexus/run.cjs`), cache cleaning, embeddings | `gitnexus analyze`, `clean`, `status` |
| [`gitnexus-debugging.md`](references/gitnexus-debugging.md) | Tracing bugs, root cause analysis, 500 responses, error call paths | `context`, `query`, `cypher` |
| [`gitnexus-exploring.md`](references/gitnexus-exploring.md) | Architecture discovery, execution flows, entry point ranking, unfamiliar code | `context`, `processes`, `query` |
| [`gitnexus-guide.md`](references/gitnexus-guide.md) | Complete MCP schema, graph nodes/edges, epistemic confidence levels | `gitnexus://repo/{name}/context` |
| [`gitnexus-impact-analysis.md`](references/gitnexus-impact-analysis.md) | Pre-edit blast radius ($d=1, d=2$), ripple effects, breaking changes | `impact({direction: "upstream"})` |
| [`gitnexus-refactoring.md`](references/gitnexus-refactoring.md) | Safe multi-file renames, symbol extraction, module splitting with dry-run | `rename`, `detect_changes` |


