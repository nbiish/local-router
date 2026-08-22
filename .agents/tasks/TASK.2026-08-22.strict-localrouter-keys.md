# TASK 2026-08-22 — Strict LOCALROUTER_ key namespace

## Read
- User: LR only reads LOCALROUTER_*_KEY.
- Ambient plain keys invisible by design.
- Bundle persist: namespaced + preserve all.
- ainish-coder: add list + rename CLI.

####

## Execute
- providerEnvKeyValue/loadKeysFromEnv: strict namespaced only.
- sync: LOCALROUTER_ map; plain -> skipped + rename hint.
- persistPqcSecrets: merge, namespaced-only management, others preserved; abort on unreadable bundle.
- delete: namespaced only; ambient untouched.
- Harnesses: 6 files inject namespaced keys.
- Engine: pack-writer extracted; cmd_list;
  cmd_rename (backup first, no overwrite).
- SKILL.md rows + §5.4 (mirrored both repos).

## Verify
- Mixed bundle: zai pqc, kilo none (plain
  ignored+hint), ambient OPENROUTER ignored.
- Save -> bundle keeps HF_TOKEN + plain kilo;
  adds LOCALROUTER_WAFER_. Engine: list/rename/collision OK.
- Suite 114/114 (78s) after killing user's
  18-thread TTS zombie that starved the box.

## Audit
- No values in logs/docs. Bundle untouched
  outside its own dir.
