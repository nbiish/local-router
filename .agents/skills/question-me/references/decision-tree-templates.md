# Decision Tree Templates & Archetypes

This reference catalog provides pre-structured decision tree archetypes for common engineering tasks. Use these templates in **Phase 1** of the `question-me` protocol to construct dependency trees rapidly.

---

## 1. Archetype: New CLI Tool / Subcommand

```mermaid
graph TD
    A["Level 1: Invocation Model<br>(Built-in subcommand vs. Standalone script vs. Dispatch wrapper)"]
    A --> B["Level 2: Input & Argument Topology<br>(Flags vs. Positional args vs. Interactive wizard)"]
    A --> C["Level 3: Configuration & State<br>(Persistent config file vs. Env variables vs. Zero-config)"]
    B --> D["Level 4: Output & Telemetry<br>(JSON structured vs. Human TTY vs. Silent with exit codes)"]
    C --> E["Level 5: Failure & Recovery<br>(Fail fast vs. Graceful fallback vs. Retry prompt)"]
```

### Pre-Formulated Questions:
1. **Invocation Model:**
   - *(Recommended)* Subcommand integration: Integrate under the existing root binary CLI dispatch (`ainish-coder --<command>`).
   - Standalone binary: Create a dedicated binary in `bin/<name>` with separate symlink distribution.
   - Shell alias/wrapper: Implement as a lightweight shell function in `src/`.
2. **Input Topology:**
   - *(Recommended)* Positional target path with optional modifier flags (`--force`, `--dry-run`, `--json`).
   - Interactive prompt wizard with arrow navigation when flags are omitted.
   - Environment variable-only configuration.
3. **Output & Ergonomics:**
   - *(Recommended)* Adaptive TTY: Colorful human-readable output on interactive terminals; strict JSON when piped or `--json` is passed.
   - Human text only with ANSI color codes.
   - Minimal silent UNIX style (standard error only on failure).

---

## 2. Archetype: Refactoring & Architecture Migration

```mermaid
graph TD
    A["Level 1: Migration Strategy<br>(Strangler fig / Shadow shim vs. Big-bang atomic cutover)"]
    A --> B["Level 2: Public Contract Compatibility<br>(Strict backwards-compatible vs. Breaking version bump)"]
    B --> C["Level 3: Scope & Allowlist<br>(Single module vs. Multi-crate blast radius)"]
    C --> D["Level 4: Verification Gate<br>(Dual-run parity tests vs. Unit coverage threshold)"]
```

### Pre-Formulated Questions:
1. **Cutover Strategy:**
   - *(Recommended)* Strangler / Parallel Facade: Introduce new implementation alongside old, route calls through a shim, verify zero regressions, then deprecate old code.
   - In-place Atomic Refactor: Directly edit and replace existing symbols across target files in a single isolated worktree.
   - Deprecation Shadow: Keep legacy symbols intact under `legacy_` prefix, emit deprecation warnings for 1 cycle.
2. **Contract Preservation:**
   - *(Recommended)* Strict ABI/API Parity: Retain all exported function signatures, return shapes, and error types without breaking changes.
   - Modernized Interface: Adopt cleaner signatures with breaking changes, updating all internal call sites in the same commit.

---

## 3. Archetype: Data Persistence & State Storage

```mermaid
graph TD
    A["Level 1: Storage Medium<br>(Filesystem JSON/YAML vs. SQLite vs. Pure in-memory)"]
    A --> B["Level 2: Concurrency & Locking<br>(Atomic rename write vs. File flock vs. Optimistic timestamp)"]
    B --> C["Level 3: Location & Hierarchy<br>(~/.config/<app>/ vs. Repo-local .agents/ vs. /tmp/)"]
    C --> D["Level 4: Schema Evolution<br>(Versioned schema migration vs. Additive-only fields)"]
```

### Pre-Formulated Questions:
1. **Persistence Format:**
   - *(Recommended)* Atomic JSON File: Flat JSON written via write-to-temp-then-atomic-rename (`atomic_write`) for corruption immunity.
   - SQLite / Embedded DB: Embedded database for complex querying and relational lookups.
   - Plaintext key-value / INI store: Simple text format readable by shell tools.
2. **Storage Location:**
   - *(Recommended)* User Configuration Home: `~/.config/<app>/` adhering to XDG Base Directory specification.
   - Repository-Local State: `.agents/` inside the target workspace for project-scoped sharing.
   - Ephemeral Runtime: `/tmp/` or memory cache destroyed on process exit.

---

## 4. Archetype: Security & Cryptography Integration

```mermaid
graph TD
    A["Level 1: Secret Storage & Key Lifecycle<br>(pqc-secrets bundle ML-KEM-768 vs. Vault vs. OS Keychain)"]
    A --> B["Level 2: Data Integrity & Signatures<br>(ML-DSA-65 FIPS 204 vs. Hybrid ML-DSA/ECDSA)"]
    B --> C["Level 3: Permission & Boundary<br>(Strict local loopback vs. Sandboxed subagent vs. User confirm)"]
    C --> D["Level 4: Audit & Tamper-evidence<br>(Hash-chained ledger vs. Syslog vs. Silent)"]
```

### Pre-Formulated Questions:
1. **Cryptographic Standard:**
   - *(Recommended)* PQC FIPS 203/204 Mandate: FIPS 203 ML-KEM-768 for secret encryption, FIPS 204 ML-DSA-65 for code and manifest signing.
   - Standard TLS transport crypto with classical TLS 1.3 (strictly for wire transport, never for API keys).
2. **Secret Ingestion:**
   - *(Recommended)* On-demand memory load: Load via `pqc-secrets export` directly into memory with zero disk footprint.
   - System Keychain extraction via OS daemon.

---

## 5. Archetype: Subagent & Autonomous Orchestration

```mermaid
graph TD
    A["Level 1: Execution Modality<br>(One-shot headless run vs. Native subagent vs. Workflow fan-out)"]
    A --> B["Level 2: Scope Allowlist<br>(GitNexus impact files only vs. Whole directory)"]
    B --> C["Level 3: Verification Loop<br>(Compiler/typecheck gate vs. Integration smoke test)"]
    C --> D["Level 4: COMMS Ledger Logging<br>(SUBAGENT-DISPATCH receipt vs. Orchestrator log)"]
```

### Pre-Formulated Questions:
1. **Orchestration Modality:**
   - *(Recommended)* Headless Master Run: Dispatch a dedicated headless agent run with an implementation or TDD engineer persona inside an isolated worktree.
   - Native Subagent: Fresh context subagent tool call with read/write isolation.
   - Single-Agent Direct Execution: Execute directly within the current worktree without subagent fan-out.
