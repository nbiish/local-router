---
name: specialized-agents
description: Check the hermes CLI for the most relevant specialized agent profile before starting any task or automation. Use when choosing which agent, persona, or model should do a job, when a task spans several domains, or when scheduling recurring work. Lists how to discover profiles, read their descriptions, and invoke one non-interactively.
---

# Specialized agents (hermes)

Before doing substantial work, check whether a **specialized hermes profile** fits the task better
than the default agent. A profile carries its own persona, model, skills, and memory; picking the
right one is usually the difference between generic output and expert output.

## 1. Discover what exists

```bash
hermes profile list                    # every profile, its model, gateway state
hermes profile describe <name>         # one-line purpose — the discovery hook
```

`describe` is what a kanban/orchestrator reads to route work. **A profile with no description is
invisible to routing** — if you create one, describe it in the same breath:

```bash
hermes profile describe <name> --text "one line: what it is expert at"
```

## 2. Choose by task domain

Match the task to a description, not to a familiar name. Examples of real profiles and their shape:

| Profile | Use for |
|---|---|
| `marketing-engineer` | campaigns, funnels, pricing, channel copy, growth experiments |
| `rev` | binary/RE, malware, firmware, protocol analysis |
| `veteran-production-coder` | hardened code, security doctrine, production delivery |
| `default` | general work with no better specialist |

If nothing fits, say so and proceed with `default` — do not invent a specialist persona by hand.

## 3. Invoke non-interactively

```bash
hermes -z "<self-contained prompt>" --profile <name>
```

- `-z` is the one-shot prompt flag. `hermes -p "text"` **does not work** — `-p` is parsed as a
  positional command and fails with `'text' is not a hermes command`.
- `--profile` selects the profile. Do not rely on a sticky default you did not set.
- Prompts must be **self-contained**: a fresh profile has no memory of your conversation.

## 4. Schedule recurring work

```bash
hermes cron create "0 9 * * *" "<prompt>" --name "<job>" --deliver bot-chat:<profile>
```

`cron create` has **no `--profile` flag**. Profile targeting happens through
`--deliver bot-chat[:profile]`, which injects the output into that profile's bot chat. Write the
prompt as the message that profile should act on.

Check before adding load: `hermes cron list`, `hermes cron status`, `hermes cron doctor`.

## Stop conditions

- **Do not schedule a recurring job that spends model tokens without explicit operator approval.**
  Recurring spend is a business decision, not an implementation detail.
- Do not create, rename, or delete a profile for a one-off task.
- Do not pass secrets in a prompt; profiles do not sanitise their inputs.
- If `hermes` is not on PATH, report that and fall back to the default agent rather than guessing a
  path.

## Verify

```bash
hermes profile list | grep <name>              # profile exists and gateway is running
hermes -z "Reply with exactly: OK" --profile <name>   # it actually answers
hermes cron runs                               # after scheduling: real execution records
```
