---
name: pliny-research
description: >
  Pliny research collection — extracted system prompts, guidelines, tools, and jailbreak techniques 
  from virtually all major AI models and agents (OpenAI, Google, Anthropic, xAI, Perplexity, Cursor, 
  Windsurf, Devin, Manus, Replit, and more). Deploy with `ainish-coder --unlock` to gain AI 
  transparency and observability knowledge.
---

# Pliny Research Skill

*Updated: May 21, 2026*

> AI Systems Transparency and Observability for all. Full extracted system prompts, guidelines, 
> and tools from virtually all major AI models + agents.
> 
> "In order to trust the output, one must understand the input."
>
> — @elder_plinius

---

## Overview

This skill provides the complete **Pliny research collection** — a comprehensive repository of
extracted system prompts, model guidelines, tool definitions, and jailbreak techniques across
every major AI platform. It is deployed into your project via `ainish-coder --unlock`.

### What's Included

| Collection | Contents |
|------------|----------|
| **CL4R1T4S** | Extracted system prompts & tools from OpenAI, Google, Anthropic, xAI, Perplexity, Cursor, Windsurf, Devin, Manus, Replit, Bolt, Lovable, Vercel v0, Cline, SameDev, MiniMax, MultiOn |
| **L1B3RT4S** | Liberation prompts, special tokens, jailbreak shortcuts, and system prompt templates for all major providers |
| **G0DM0D3** | Advanced jailbreak techniques and prompt engineering approaches |
| **OBLITERATUS** | Research on refusal removal, abliteration, and mechanistic interpretability of AI safety mechanisms |

---

## Why This Matters

AI labs shape how models behave using massive, unseen prompt scaffolds. Because AI is a trusted 
external intelligence layer for a growing number of humans, these hidden instructions can affect 
the perceptions and behavior of the public.

These prompts define:
- What AIs can't say
- What personas and functions they're forced to follow
- How they're told to lie, refuse, or redirect
- What ethical/political frames are baked in by default

**If you're interacting with an AI without knowing its system prompt, you're not talking to a 
neutral intelligence — you're talking to a shadow-puppet.**

---

## Usage

### Deploy the Research

```bash
ainish-coder --unlock [TARGET_DIR]
```

This deploys the full `pliny-research/` collection into `.agents/skills/pliny-research/` in the
target directory.

### Explore the Research

After deployment, navigate the collection:

```bash
ls .agents/skills/pliny-research/
```

Key entry points:
- `CL4R1T4S/README.md` — Overview of system prompt extraction project
- `L1B3RT4S/README.md` — Liberation techniques and templates
- `L1B3RT4S/#MOTHERLOAD.txt` — Comprehensive prompt collection
- `L1B3RT4S/!SHORTCUTS.json` — Jailbreak shortcuts
- `OBLITERATUS/docs/RESEARCH_SURVEY.md` — Academic survey on refusal removal

---

## Research Domains

### System Prompt Extraction (CL4R1T4S)

Extracted prompts reveal how each AI provider instructs their models:

- **OpenAI**: ChatGPT, GPT-4, GPT-4o system prompts
- **Anthropic**: Claude system prompts across versions
- **Google**: Gemini variants, Gmail Assistant
- **xAI**: Grok 3, Grok 4, Grok Code
- **Cursor**: Agent system prompts, tools
- **Devin**: Full system prompt and commands
- **Windsurf**: Cascade agent instructions
- **Replit**: Agent configuration
- **Perplexity**: Deep Research prompts
- **Vercel v0**: Frontend generation prompts

### Liberation Techniques (L1B3RT4S)

Jailbreak and prompt engineering approaches:

- Special token manipulation
- System prompt injection patterns
- Provider-specific bypasses
- Motherload comprehensive prompt collection

### Safety Mechanism Research (OBLITERATUS)

Academic and practical research on:

- Refusal direction identification (Arditi et al. 2024)
- Gabliteration — multi-direction subspace approach
- Norm-preserving projection (MPOA)
- Contrastive Activation Addition (CAA)
- Representation Engineering (RepE)

---

## Integration with Other Skills

- **llm-security**: Use pliny research to understand attack surfaces in LLM systems
- **code-security**: Apply extraction knowledge to harden AI-integrated code
- **osa**: Dispatch research extraction tasks across multiple agents
- **modern-prompting**: Leverage discovered prompt patterns for OOReDAct

---

## Contribute

Leak, extract, or reverse-engineer something? Send a pull request or hit up @elder_plinius on X or Discord.

---

*<3 Love, Pliny*
