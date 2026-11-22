---
name: job-name
status: paused
harness: <hermes | codex | claude | cursor | ainish-coder | ...>
profile: <the harness profile or role, or `none`>
cadence: <cron expression | interval like 6h | manual>
prompt: >
  <one sentence describing the prompt. The full prompt goes in the body.>
tooling: <commands, scripts, or MCP servers this job invokes>
purpose: <one sentence: what this exists to make true>
owner: <who to ask before changing it>
---

# job-name

## What it does

<Three or four sentences. What runs, on what input, producing what.>

## How to run it by hand

```bash
<the exact command, with the arguments a person would actually use>
```

## What it has gotten wrong

<The failures that already happened. A job record with no failure history is either new or not being
reviewed — those are different facts and the reader should be able to tell which.>

## What to check when it fails

1. <The first thing to look at>
2. <The command that distinguishes "the job broke" from "its input was bad">
