# Plan Artifacts — Deriving Todos, Splitting, and Closing Out

How to turn a finished decision tree into a plan an implementing agent can execute, and how to
close one without leaving debris.

The canonical shape lives in [`.agents/templates/plan.md`](../../../templates/plan.md). The
mutation rules live in `SKILL.md` §7 Plan Lifecycle. This file covers the judgement calls.

---

## 1. Deriving §5 Todos

The todos are not a restatement of §3 Plan. They are the ordered work an implementing agent can
start on without re-reading the whole plan — which is why they are generated last and from all four
preceding sections at once.

### Where each todo comes from

| Source | Becomes a todo when | Example |
|---|---|---|
| §3 Proposed architecture | It names a component that must exist before another can reference it | "Add `render_plan_section` to `rag.py`" |
| §3 Interfaces and data | A signature, format, or frontmatter key changes | "Add `plan:` line to the task record template" |
| §3 Files and symbols | Each file is a separate unit of work | "Wire `.agents/plans` into the `--rules` scaffold" |
| §4 Clarifications | A decision requires an action no other todo covers | "Set `status: designing` default in the template" |
| §3 Risks and mitigations | The mitigation is itself work | "Add malformed-frontmatter test case" |
| §6 Verification | A gate needs setup that does not exist yet | "Rewrite the literal deploy-loop assertion in `test-pqc-dist.sh`" |

### The five tests for a todo

1. **Atomic** — finishable in one sitting, with no "and then also" hiding inside it. If it has two
   verbs joined by "and", it is two todos.
2. **Imperative and named** — starts with a verb and names the file, symbol, or path. "Update the
   deploy wiring" fails; "Add `.agents/plans` to the `mkdir -p` in `bin/ainish-coder`" passes.
3. **Observably done** — `done when:` describes a state a second person could confirm without
   asking the author. "Code is clean" fails; "`git status` shows no untracked files in the target"
   passes.
4. **Verifiable** — `verify:` names the command, or explicitly says `manual review` when no command
   exists. A todo whose completion nobody can check is a wish.
5. **Not a duplicate** — if two todos would be ticked by the same edit, they are one todo.

### Ordering

Order by dependency, not by section number: a todo that blocks three others goes first even if it
came from §6. When a todo is genuinely independent and could run in parallel, say so, because that
is what lets an orchestrator fan out subagents without re-deriving the graph.

### What does not belong in §5

- **Reading tasks.** "Read `rag.py` to understand orientation" is reconnaissance, and it already
  happened — that is why §2 Anchor Facts exists. A todo list with reading tasks in it is a diary.
- **Decisions.** "Decide whether to add a CLI flag" belongs in §7 Open Decisions. A todo cannot be
  ticked by thinking.
- **Restated context.** `from: §3` is the pointer; do not paste the paragraph.

### Worked example

```markdown
- [ ] **T3** Add `.agents/plans` to the `--rules` scaffold `mkdir -p` in `bin/ainish-coder`.
  - from: §3 Files and symbols | done when: a fresh `--rules` target contains `.agents/plans/`
  - verify: `bash bin/ainish-coder --rules /tmp/scratch && test -d /tmp/scratch/.agents/plans`
```

Three lines: what, why we know it is done, how to prove it. Anything longer is §3 leaking in.

---

## 2. Splitting a Plan

One plan, one outcome. Split when:

- **The plan has two verbs at the top.** "Add the plans directory and rewrite the retrieval
  orientation" is two plans that will be reviewed separately anyway.
- **A section could ship alone and be useful.** If §3 files could merge and pass gates before the
  rest exists, that is a plan boundary, not a todo boundary.
- **The clarification ledger crosses a subsystem.** Security-model decisions and output-formatting
  decisions do not belong in one document; neither agent reads the other half.
- **The todo list exceeds roughly fifteen items.** Past that, an implementing agent loses the thread
  and start guessing at intent. Split by phase instead.

When splitting, the second plan's §1 Problem links the first plan by filename, and the first plan
gets a §7 line naming the successor. Never split retroactively by copying a locked plan — write a
new one and mark the old `abandoned` with a pointer.

---

## 3. Closing a Plan Out

A plan reaches `done` when §6 is green and every §5 box is ticked. The closeout is deliberately
small, because the surrounding system (task record, COMMS, memory) already owns the reporting:

1. **Tick the last boxes and run §6.** Do not mark done on the strength of "the tests passed
   earlier" — run the gates in the current tree.
2. **Set `status: done`.** Nothing else in the plan changes; §5 stays as written so the diff
   history of the checkboxes remains readable.
3. **Record the outcome in the task record** — its `status:` and a short verdict. The plan holds
   the reasoning; the task holds the result.
4. **Append the COMMS lifecycle line** and any scrubbed durable fact to the daily memory file, per
   `AGENTS.md` § Close.
5. **Leave §7 honest.** Open decisions that remain open after `done` are not a failure — they are the
   correct record of what was deferred. Copying them into a new plan is how they get picked up.

If a gate cannot pass on this host, the plan does not become `done`. Name the host and the missing
control, leave `status: implementing`, and add a §7 entry. A plan marked done over a skipped gate is
a false record that a future agent will trust.

---

## 4. What a Good Plan Looks Like After the Fact

A reader six months later, with no chat history, should be able to answer all of these from the file
alone:

- What problem was this, and who had it? (§1)
- What did we already know, and how did we know it? (§2)
- What was built, and why this shape? (§3)
- What was decided, by whom, and what did it cost? (§4 — `asked:` tells them whether a human ever
  agreed)
- What was the work, and did it get done? (§5 checkboxes)
- How was it proven? (§6)
- What did we knowingly leave open? (§7)

If any of those needs a chat transcript to answer, the plan was written as a summary rather than as
the working surface.
