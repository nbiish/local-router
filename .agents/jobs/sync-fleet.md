---
name: sync-fleet
status: active
harness: ainish-coder
profile: none (a CLI job, not a model job)
cadence: every 5 minutes, while the machine is awake
prompt: >
  Run `ainish-coder --machine-sync --all --branches --auto-commit --quiet` for every repository in
  `~/.config/ainish-coder/links.txt`, and report per-repo outcome.
tooling: ainish-coder, git, ssh
purpose: Every linked repository reaches every peer without a human typing a sync command.
owner: operator
---

# sync-fleet

## What it does

Polls each linked repository for changes, debounces to quiescence, then runs the proven sync path
(`--machine-sync --both --branches --auto-commit --linked-only --quiet`). The watcher decides *when*;
`--machine-sync` moves the bytes.

## How to run it by hand

```bash
ainish-coder --machine-watch --status          # is it running, and what did the last cycle do
ainish-coder --machine-sync --all              # one manual pass over every repo
ainish-coder --machine-sync --latest           # which machine holds the newest commit per branch
```

## What it has gotten wrong

- **Committed files mid-authoring.** A skill was committed while its author was still writing it. The
  fix is an edit quiet period; until that ships, do not leave a file half-written for minutes.
- **Reported `failed=0` while failing.** `watch.state` is not trustworthy yet — read
  `~/.config/ainish-coder/watch.log` and count `Z failed:` lines.
- **One repo can monopolise the loop.** A permanently-failing repository retries a full
  timeout-and-backoff before others get a turn.
- **Authored as the operator.** `--auto-commit` once used the operator's identity; the contract permits
  `Nanoboozhoo - embodied by {machine}` only.

## What to check when it fails

1. `grep -c 'Z failed:' ~/.config/ainish-coder/watch.log` against `Z ok:` — a ratio near 1:2 is broken.
2. Whether the same command works by hand in the failing repo. If it does, the fault is in the watcher's
   invocation path, not the repository.
3. Whether the peer's history is related at all. Unrelated root commits can never fast-forward, and the
   repo will fail forever until that is decided.
