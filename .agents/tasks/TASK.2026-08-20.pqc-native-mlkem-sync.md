# TASK 2026-08-20 — Sync native ML-KEM engine (from ainish-coder)

## Read
- ainish-coder commit 617163b.
- Same script both repos.
- local-router llms.txt parity line.

####

## Draft
- copy migrated script.
- SKILL.md three paragraphs.
- llms.txt tooling parity.
- engine tag py-native-mlkem.
- seed-form store 64B.

####

## Execute
- Script copied byte-identical.
- SKILL.md engine docs synced.
- llms.txt parity line updated.

## Verify
- Roundtrip tested upstream worktree.
- Gates: build + tests this worktree.
- Smoke :11436 PQC load.

## Audit
- FIPS 203 ML-KEM-768 only.
- kyber-py read-path fallback only.
- No secrets committed.
