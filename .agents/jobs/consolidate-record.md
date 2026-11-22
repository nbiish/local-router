---
name: consolidate-record
status: active
harness: ainish-coder
profile: consolidate-elephant (drafts) + consolidate-goldfish (reviews, blocks)
cadence: weekly, or when any folder exceeds 5 originals
prompt: >
  For each of .agents/{memories,comms,tasks,suggestions,plans}: protect the 3 newest records, feed the
  rest to consolidate-elephant in batches, have consolidate-goldfish verify each batch against its
  sources, and only write the digest and remove the originals when the review passes.
tooling: ainish-context context-consolidate, hermes profiles consolidate-elephant / consolidate-goldfish
purpose: The coordination folders stay small enough to review, without losing what they recorded.
owner: operator
---

# consolidate-record

## What it does

Turns old records into one dated digest per folder per period, keeping what was accomplished, what did
not finish, the insights, and the recurring lessons. The three newest records in each folder are never
touched, so recent work stays readable in its original form.

## Why two agents and a blocking review

The first version used the prime's own elephant/goldfish pair with an advisory review. In one live run
it deleted 16 files and replaced them with the sentence "I'll start with the required context call."
The pair now has its own profiles and the review **blocks**: a draft that fails is retried once with the
reviewer's named gap, and a second failure abandons the period and leaves every source in place.

## How to run it by hand

```bash
ainish-context context-consolidate --dry-run              # what it would do; changes nothing
ainish-context context-consolidate --folder comms        # one folder
ainish-context context-consolidate                       # all five
```

## What it has gotten wrong

- **Half-digested a period.** Chunked drafting let one chunk pass and another fail, so a digest was
  written covering part of a period while the rest stayed. Check `records_consolidated` in the digest
  against the number of files the period had.
- **Reported a digest as the plan of record.** `DIGEST-plans-*.md` has no `status:` field, so the prime
  claimed `status: designing`. Digests are now excluded from that selection.
- **Used the wrong transport.** `pi` timed out on 40K-character payloads at 300s; the same prompt via
  hermes answered in 66s.

## What to check when it fails

1. The digest's `sources:` list — it names exactly what was removed. Anything not listed is still there.
2. `git log --diff-filter=D --name-only` will show every record any run removed.
3. A refusal is a correct outcome. The reviewer names the gap; fix the drafter's coverage rather than
   lowering the gate.
