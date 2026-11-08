---
plan_format: ainish/plan/v1
slug: {kebab-name}
date: {YYYY-MM-DD}
status: designing
branch: {type}/{scope}-{slug}
worktree: {absolute path}
task_record: .agents/tasks/{YYYY-MM-DD}-{slug}-task.md
operator: question-me
---

# Plan: {short, specific title}

<!--
Copy to `.agents/plans/{YYYY-MM-DD}-{slug}.plan.md`. Replace every `{placeholder}`.
Frontmatter keys are a contract: `.agents/plans/llms.txt` defines who may change which
field, and `ainish-rag` orientation reads `status` and counts the unchecked boxes below.
Sections 1-4 and 7 are history once written. Section 5 is the only part that is edited in
place, by ticking its boxes. Delete these comments when the plan is created.

status values, in order: designing -> ready -> implementing -> done
                          (or abandoned from any state, with a reason in section 7)
-->

## 1. Problem

{One paragraph, in the operator's words. What is wrong or missing today, and why it matters. No
solution, no file names.}

## 2. Anchor Facts

{What the codebase already answered, so no reader re-derives it and no operator was asked a lazy
question. Each line names how it was established. A fact belongs here only if it was verified, not
assumed.}

- {Fact} — established from `{path or command}`.
- {Fact} — established from `{path or command}`.

## 3. Plan

### Goals

- {Observable outcome the finished work produces.}

### Non-goals

- {Adjacent thing this deliberately does not do, and the one-line reason.}

### Constraints and invariants

- {Rule from the contract, an existing schema, or a host limit that the design must not violate.}

### Proposed architecture

{How the pieces fit and why this shape rather than another. A short diagram is welcome when the
data flow is not obvious; two boxes and an arrow usually beats a paragraph.}

### Interfaces and data

{Every surface the change touches: CLI flags, function signatures, file formats, frontmatter keys,
env vars, exit codes. State the before and after where a signature changes.}

### Files and symbols

- `{path}` — {what changes, and the symbol or line range involved}.
- `{path}` — {what changes}.

### Alternatives considered

| Alternative | Why rejected |
|---|---|
| {Approach} | {Concrete reason, not "worse".} |

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| {What can break, and for whom} | {The check or design choice that catches it} |

## 4. Clarifications

{One entry per resolved decision, in the order the walk resolved them. `asked:` distinguishes a
decision the operator made from one the codebase already answered — the operator must be able to
audit everything decided on their behalf. Append as the walk proceeds; never rewrite a resolved
entry after `status` leaves `designing`.}

### 4.1 {Decision title}

- **Question:** {The question as it was put to the operator.}
- **Options:** 1. (Recommended) {option} — {rationale}; 2. {option} — {trade-off}; 3. {option} — {trade-off}.
- **Selected:** {The answer, verbatim in substance.}
- **Trade-off accepted:** {What this choice gives up.}
- **asked:** operator | resolved from code
- **resolved by:** {If `resolved from code`, the file or command that settled it.}

### 4.2 {Decision title}

- **Question:** {…}
- **Options:** {…}
- **Selected:** {…}
- **Trade-off accepted:** {…}
- **asked:** operator | resolved from code
- **resolved by:** {…}

## 5. Todos

{Derived from sections 1-4 together, not from a plan you would have written alone. Each item is
atomic enough to finish in one sitting and specific enough that "done" is not a judgement call.
Write this section only after the walk has terminated: a list built from a half-walked tree encodes
decisions nobody made.}

- [ ] **T1** {Imperative change, naming the file or symbol.}
  - from: §{section} | done when: {observable state} | verify: `{command}`
- [ ] **T2** {…}
  - from: §{section} | done when: {observable state} | verify: `{command}`

## 6. Verification

{Gates that must pass before `status: done`. Each is a command and its required result. A gate
nobody runs is decoration.}

- `{command}` — {required result}.
- `{command}` — {required result}.

## 7. Open Decisions

{Forks deliberately left open, each with what would settle it. An empty section is the good state;
do not invent questions to fill it. If an implementation choice invalidates a clarification in
section 4, record it here and move `status` back to `designing` rather than diverging quietly.}

- {Open question} — settled by {the observation or answer that closes it}.
