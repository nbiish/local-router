# TASK 2026-08-30: PQC Skill Sync — gen Command + Vault-Era Docs

## Draft
- ainish-coder evolved vault-first elsewhere
- this machine's mirror sat uncommitted
- scope: local-router skill + protocol docs only
- ainish remote intentionally behind (other machine)
- new engine command: gen
- gen: 512-bit default, b64url/hex/b85
- gen --words: EFF large diceware, pinned
- gen --env NAME: tool-namespace emission
- vault passphrases feed Argon2id KDF
- new references: application-orchestration
- new references: cross-repo-key-sharing
- CLI/KEK/agent-integration refs refreshed
- AGENTS.md: COMMS + WTF hub protocol
- .gitignore: live-board sidecar ignored
- secret audit of diff: clean
- smoke: gen --help exit 0

####

## Output

### What this commit is
Brings local-router's `.agents/skills/pqc-secrets/` copy and agent-workflow
docs up to the current PQC system design as authored on this machine:

1. **`pqc_secrets.py` — new `gen` subcommand**: cryptographically secure
   secret generation. Default 512-bit base64url; `--words N` Diceware mode
   over the pinned EFF large wordlist (`eff_large_wordlist.txt`, 7,776 words,
   ~12.925 bits/word) feeding Argon2id vault passphrases; `--env NAME`
   emits `NAME=<secret>` lines named for tool namespaces (`WTF_*`,
   `AINISHCODER_*`, `LOCALROUTER_*`).
2. **New references**: `application-orchestration.md` (app-owned key
   lifecycle; production reference local-router) and
   `cross-repo-key-sharing.md` (one bundle, many repos, namespace
   discipline).
3. **Refreshed references**: `pqc-secrets-cli.md` (+gen), `kek-persistence.md`,
   `agent-integration.md`.
4. **`AGENTS.md`**: COMMS ledger protocol formalized + WTF HUB cross-machine
   reporting contract; worktree-gate language tightened (single-branch policy).
5. **`.gitignore`**: `AGENTS/*.COMMS.live.md` sidecar ignored; node_modules /
   src-tauri patterns consolidated.

### Verification
- Secret-pattern audit of the full diff: clean (no keys, no tokens).
- `pqc_secrets.py gen --help` exits 0 with documented usage (uv engine run).
- EFF wordlist committed verbatim (public domain, EFF large list).

### Provenance note
ainish-coder's remote is intentionally behind the other machine's state; this
commit is scoped to local-router only. No ainish-coder pulls or pushes were
performed from here. When the other machine pushes, re-sync this skill copy
from that history — not from this machine's stale clone.
