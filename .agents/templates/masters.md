# The Nine Advisory Masters

Status: canonical definition — `AGENTS.md` § Advisory masters points here
Scope: every task, every repository that receives the rules bundle

## What this is

Nine **dual-expertise** advisory niches. Each one names two disciplines that interfere
*constructively* — the tension between them is what produces a useful question. An agent reading
`AGENTS.md` is expected to **constitute the named experts on the fly** for the task in front of it,
not to recite a checklist.

This is a reasoning device, not a gate. The gate enforces the three mechanically checkable surfaces
(`compat:`, `budget:`, append-only) separately. These masters exist to make an agent *think like*
the right two experts before it writes anything.

## How an agent uses them

1. **Read what each pair is for** (the table below). Do not expand them into prose yet.
2. **Constitute the pair for this task.** Name both experts concretely: not "a security expert" but
   "a supply-chain attacker who controls a transitive dependency" and "a platform engineer who must
   ship this on Friday". Specificity is the whole point.
3. **Let them disagree.** The value is in the interference. Ask each pair a question the other half
   would answer differently, then record what survived.
4. **Record only the survivors** in the suggestions block: one line per master that actually had
   something to say. A master with nothing to add says nothing — silent is a valid outcome and
   padding is worse than silence.

## The nine

| # | Master of ___ / ___ | Constituted as | The productive tension |
|---|---|---|---|
| 1 | **breach / blast radius** | an attacker who already has a foothold, and the operator paged at 3am | Can this be abused, and how far does the damage spread before anyone notices? |
| 2 | **privacy / data lifecycle** | a data-protection officer who must justify every collected byte, and the engineer who must delete it on request | What did we retain that we cannot defend, and can we actually erase it? |
| 3 | **dependencies / provenance** | a supply-chain attacker who owns a transitive package, and the auditor who must trace every artifact to its source | What did we accept without being able to prove where it came from? |
| 4 | **structure / operations** | an architect who must live with this for five years, and an on-call engineer woken by it | Is this the right shape, and can it be run at 3am by someone who did not write it? |
| 5 | **failure / verification** | an adversarial test engineer who assumes the code is wrong, and the release manager who must prove it right | What is the cheapest experiment that would falsify this claim? |
| 6 | **authority / accountability** | a governance reviewer who asks "who authorized this?", and the sovereignty holder whose data it is | Who is allowed to decide this, and who answers for it if it goes wrong? |
| 7 | **automation / reproducibility** | a harness engineer who must run this unattended, and a benchmark author who must reproduce it in a year | Can a machine run it without a human, and can anyone re-derive the result? |
| 8 | **orchestration / self-correction** | the orchestrator who must decompose and delegate, and the critic who assumes the plan itself is the flaw | Is the work shaped right, and what would make me abandon this approach? |
| 9 | **comprehension / operability** | the newcomer reading this cold, and the expert who must maintain it under pressure | Can someone understand and safely change this without me? |

## Why these nine and not more

They cover the failure modes this repository has actually hit — a half-deployed target nobody
noticed (4, 5), a silent model substitution (3), a stall that hung an unattended hook (7), a
regression reintroduced by fixing its symptom (8) — plus the classes that cost the most when absent
(1, 2, 6). Adding a tenth dilutes attention rather than adding coverage; if a task needs a
discipline outside this set, name it explicitly as an *ad hoc* expert and say why the nine were
insufficient.

## Triggered surfaces (not masters)

When the diff touches one of these, the corresponding master must speak — silence is a defect, not a
choice. These are the mechanically checkable subset and are enforced by `ainish-rag gate`:

| Surface touched | Required declaration | Enforcing master |
|---|---|---|
| contract / schema / CLI / dependency manifest | `compat:` line with window and rollback | 3, 4 |
| shared mutable state (`.agents/comms`, `memories`, `suggestions`) | append-only, or lock-guarded with a merge rule | 4, 7 |
| retrieval / model / CI spend (`src/rag/`, `.github/`, `benchmarks/`, `scripts/`) | `budget:` line | 3, 7 |
| user-facing text, color, TTY output | plain-language survives `NO_COLOR` | 9 |
| new dependency, model, dataset, asset | license + provenance recorded | 2, 3, 6 |
| cross-harness or cross-OS behaviour | parity row updated, or N/A with a reason | 4, 7 |

## Recording

In `.agents/suggestions/{date}-suggestions.txt`, one block per task:

```
### [ISO-8601] <branch>
What changed: <one line>
Next step: <exactly one>
<Master n> <name>/<name>: <the surviving finding, one line — omit if silent>
...
```

Omit every master that had nothing to say. Nine lines of boilerplate is the failure mode this
document exists to prevent.
