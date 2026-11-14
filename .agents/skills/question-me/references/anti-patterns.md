# Questioning Anti-Patterns Catalog

This document catalogues common mistakes, failure modes, and anti-patterns encountered during Socratic requirements elicitation and the `question-me` protocol.

---

## 1. Lazy Codebase Ignorance (The "Did You Check?" Sin)

### The Anti-Pattern:
Asking the operator for information that is already established in repository documentation, source code, dependency manifests, or git configuration.

- ❌ **Anti-Pattern Example:**
  > *"Are you using TypeScript or JavaScript in this project?"*
  > *(When `package.json` and `tsconfig.json` clearly specify TypeScript 5.6)*
- ❌ **Anti-Pattern Example:**
  > *"Where should we store the configuration file?"*
  > *(When `llms.txt` states: 'Config persists to ~/.config/ainish-coder/')*

### The Fix:
Run **Phase 0 Reconnaissance** first. Read `llms.txt`, run `find_by_name`, grep configuration paths, and inspect existing conventions. If the answer exists, declare it as an **Anchor Fact** in the session notes and move on.

---

## 2. The 10-Question Barrage (Cognitive Overload)

### The Anti-Pattern:
Bombarding the operator with a massive questionnaire containing multiple unrelated questions in a single turn.

- ❌ **Anti-Pattern Example:**
  > *"Here are 7 questions before we start:*
  > *1. Which database engine?*
  > *2. What should the CLI flag be?*
  > *3. Should we support Docker?*
  > *4. What happens on HTTP 404?*
  > *5. What is the log directory?*
  > *6. Do you want unit tests or integration tests?*
  > *7. Should output be colored?"*

### The Fix:
Enforce **Strict Monadic Flow (One Question at a Time)**. Ask exactly **one** question per interaction. Wait for the operator's response, record the decision, update downstream branches, and then ask the next question.

---

## 3. Unopinionated Shrugging (The Feckless Neutral)

### The Anti-Pattern:
Presenting a menu of technical options without expressing any engineering judgment or recommendation.

- ❌ **Anti-Pattern Example:**
  > *"We could use SQLite, JSON, YAML, or Postgres. Which one do you want?"*

### The Fix:
Always mark the optimal technical path with `(Recommended)` and provide the architectural rationale based on project constraints:

- ✅ **Elite Standard:**
  > *"How should persistent state be stored?*
  > *1. (Recommended) Flat JSON file with atomic rename (`~/.config/app/state.json`). Matches existing repo patterns and avoids heavy database dependencies.*
  > *2. Embedded SQLite database. Better if relational queries are required in future phases.*
  > *3. Pure memory cache without persistence."*

---

## 4. Premature Bikeshedding (Trivial Micro-Decisions)

### The Anti-Pattern:
Derailing the architectural alignment by interrogating the operator on cosmetic details, variable naming, or internal helper functions before the core design is settled.

- ❌ **Anti-Pattern Example:**
  > *"Should the helper function be named `parse_args` or `extract_arguments`?"*
  > *"Should we indent JSON with 2 spaces or 4 spaces?"*

### The Fix:
Follow repo standards without asking. Apply convention-over-configuration for trivial details. Reserve operator questions strictly for architectural boundaries, contracts, state storage, security models, and user experience.

---

## 5. The Binary Trap (Yes/No Dead-Ends)

### The Anti-Pattern:
Asking trivial yes/no questions that fail to expose trade-offs or alternatives.

- ❌ **Anti-Pattern Example:**
  > *"Should we handle errors?"*
  > *"Should we write tests?"*

### The Fix:
Elevate binary questions into actionable trade-off options:

- ✅ **Elite Standard:**
  > *"How should the system recover when network connectivity drops during sync?*
  > *1. (Recommended) Retry with exponential backoff (3 attempts, max 10s delay), then fail closed with exit code 3.*
  > *2. Fail fast immediately without retry to avoid blocking scripted pipelines.*
  > *3. Queue failed operations into a local pending-sync buffer for subsequent execution."*

---

## 6. Orphan Branching (Non-Sequitur Questioning)

### The Anti-Pattern:
Jumping across branches of the decision tree without resolving upstream dependencies.

- ❌ **Anti-Pattern Example:**
  > *Asking: "What should the `--format` flag options be?" before deciding whether the tool has a CLI interface or is an internal library.*

### The Fix:
Traverse the decision tree hierarchically:
`System Architecture -> Interface/Contract -> Data/Storage -> Security/Crypto -> Ergonomics/CLI`.
Never ask child questions before parent decisions are locked.

---

## 7. Raw Secret Solicitation (Security Violation)

### The Anti-Pattern:
Asking the operator to paste API keys, tokens, or private secrets directly into the chat or terminal prompt.

- ❌ **Anti-Pattern Example:**
  > *"Please provide your OpenAI API key so I can configure the client."*

### The Fix:
Never request plaintext secrets. Instruct the operator or recommend configuring secrets via `pqc-secrets`:
> *"Authentication requires an API key. Recommended path: Load via PQC secrets bundle (`pqc-secrets export` or `PQC_SECRETS_FILE`) using FIPS 203 ML-KEM-768 encryption, keeping disk free of plaintext tokens."*
