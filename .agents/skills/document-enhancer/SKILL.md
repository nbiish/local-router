---
name: document-enhancer
description: Enhances and hardens markdown documents through two independent pipelines — (1) fusing external knowledge bases into a target document via multi-agent orchestration, and (2) recursively optimizing documents for multi-model LLM effectiveness using a split→optimize→review→merge architecture.
---

# Document Enhancer

A dual-pipeline system for improving markdown documents. Both pipelines use the same underlying multi-agent architecture (Orchestrator → Sub-Agent → Reviewer → Merge), but differ in their purpose and inputs.

## Pipeline 1: Knowledge Fusion (`fuse_knowledge.sh`)

Fuses external knowledge (e.g., a video knowledge base produced by the **video-knowledge-extractor** skill) into a target document.

### When to Use

- You ran the video-knowledge-extractor and have a `_analysis.md` knowledge base ready
- You have any external reference material you want woven into a document
- You want to enrich a document with factual, sourced intelligence

### How it Works

1. **Condense:** An Orchestrator agent reads and condenses the knowledge base, extracting only high-signal findings relevant to the target document.
2. **Split:** The target document is split into semantic sections (on H2/H3 headers).
3. **Plan:** The Orchestrator identifies which sections should receive knowledge and produces an integration plan (JSON).
4. **Integrate:** A Sub-Agent weaves the relevant knowledge into each targeted section — surgically, preserving existing content.
5. **Review:** A Reviewer agent validates each enhanced section against a Quality Assurance Gate (fidelity, utility, token discipline).
6. **Reassemble:** Approved sections are merged back into the final document, with a diff produced.

### Usage

```bash
.agents/skills/document-enhancer/fuse_knowledge.sh "path/to/target_document.md" "path/to/omni_output_dir"
```

- First argument: target document to enhance
- Second argument: directory containing `_analysis.md` knowledge base files (output from video-knowledge-extractor)

### QA Validation Gate

The Reviewer evaluates each enhanced section on:
- **Fidelity:** Are original objectives and domain terms preserved?
- **Effectiveness:** Is the integrated knowledge woven naturally, not just appended?
- **Token Discipline:** Is section growth surgical (under 30%)?

---

## Pipeline 2: Recursive Document Hardening (`harden_document.sh`)

Recursively optimizes any markdown document for maximum effectiveness across all major LLM families (GPT, Claude, Gemini, Llama, Mistral).

### When to Use

- You have a prompt, system instruction, or agent definition that needs hardening
- You want to improve token efficiency without losing semantic density
- You need a document to parse reliably across different model architectures

### How it Works

1. **Split:** Document is split into semantic sections on H2/H3 headers.
2. **Optimize:** Each section is dispatched to a specialized Sub-Agent that applies multi-model formatting (XML tags for Claude, delimiters for GPT, hierarchical markers for Gemini, clear markdown for open-source models).
3. **Review:** A Reviewer agent scores each optimized section. Sections below threshold are flagged for revision.
4. **Iterate:** The pipeline loops up to 5 times — sections that pass are locked; sections that fail are re-optimized with reviewer feedback injected.
5. **Merge:** Final optimized document is assembled and a diff is generated.

### Usage

```bash
.agents/skills/document-enhancer/harden_document.sh "path/to/target_document.md"
```

Control iterations via environment variable:
```bash
MAX_ITERATIONS=3 .agents/skills/document-enhancer/harden_document.sh "path/to/doc.md"
```

---

## Architecture Constraints (Both Pipelines)

- **Context Pollution Prevention:** The full document is never sent to a single agent. Both pipelines handle semantic chunking natively. All agents are injected with the project's `AGENTS.md` structured reasoning framework to prevent context drift.
- **Camofox Web Stealth Integration:** The sub-agent and orchestrator system prompts include the `camofox-stack` SKILL.md, giving agents native expertise to write and execute stealth CLI web-scraping scripts if external intelligence is needed.
- **Provider Fallback:** All API calls route through `lib/provider.sh`, which automatically falls back between OpenRouter, ZenMux, and Nebius if a provider drops a request.
- **Do not edit the scripts manually** to fix context limits; the pipelines already handle chunking, dispatch, and reassembly.

## Environment & Configuration

A `.env` file must be configured. Copy `.env.example` from the skill directory.

If the pipeline fails:
1. Verify `.env` exists.
2. `ORCHESTRATOR_PROVIDER`, `SUBAGENT_PROVIDER`, `REVIEWER_PROVIDER` must be configured.
3. For the knowledge fusion pipeline, `OMNI_PROVIDER` and `OMNI_MODEL` are also needed (set by video-knowledge-extractor).
