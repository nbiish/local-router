---
name: rotation-procedure
description: Step-by-step runbook for data-key rotation (routine) and full identity-key rotation (out-of-band ceremony). Includes DR section for lost keychain entry.
---

# Rotation Procedure

Three flavors of rotation:

- **§1 Data-key rotation via the MCP tool** (routine, monthly/quarterly) — what
  `browser_secrets_rotate` does (v0.8.0+). The recommended path
  for agents and humans alike.
- **§2 Data-key rotation via the CLI directly** (routine, same as
  §1 but bypassing the MCP server). Use this if you're rotating
  from a non-MCP context (cron job, manual shell session, etc.).
- **§3 Full identity rotation** (out-of-band ceremony, annually or
  after compromise) — generates a new ML-KEM-768 keypair, writes
  it to the keychain, and redistributes `recipient.pub` to all
  consumers. Heavyweight; usually scheduled.
- **§4 Disaster recovery** — what to do when the keychain entry is
  lost.

## §1 Data-key rotation via MCP (routine — recommended)

**Trigger:** monthly for high-value deployments, quarterly for typical.

**Duration:** ~25 s on first call (ML-KEM-768 init), ~2 s subsequent.

**Audit:** emits one `rotate name=- tab=- old=sha3:...; new=sha3:...;
count=N; backup=<path>` event (see `audit-log.md`).

**Side effects:**
- Fresh random AES-256-GCM data key
- Fresh random ML-KEM-768 shared secret (via encaps against the
  existing recipient pubkey)
- Previous bundle preserved as `secrets.bundle.json.bak.<UTC>`
  for a 7-day grace period
- Identity ML-KEM-768 keypair in keychain is **unchanged**

### Steps (MCP, via Hermes / Claude Code / any MCP client)

```
LLM: "Rotate the PQC bundle."
→ browser_secrets_rotate
← "Rotated PQC bundle.
   Old fingerprint: sha3:4d96075ada91fa0b...
   New fingerprint: sha3:0ae9fa5052c82b65...
   Previous bundle backed up to
   /Users/nbiish/.config/pqc-secrets/secrets.bundle.json.bak.2026-06-10T...
   (retain for 7 days, then delete with: rm <path>).
   13 secret(s) re-encrypted with a fresh data key and a
   fresh ML-KEM-768 shared secret. The identity keypair in
   the keychain is unchanged."
```

**That's it.** The tool backs up, re-encrypts, and reports old +
new fingerprints. Verify the rotation succeeded by `grep rotate
~/.config/pqc-secrets/audit.log | tail -1`.

### Steps (CLI, same effect, for non-MCP contexts)

1. **Backup** the current bundle:
   ```bash
   cp ~/.config/pqc-secrets/secrets.bundle.json \
      ~/.config/pqc-secrets/secrets.bundle.json.bak.$(date -u +%Y%m%dT%H%M%SZ)
   ```

2. **Run rotate:**
   ```bash
   $ pqc-secrets rotate
   Backed up to secrets.bundle.json.bak.2026-06-09T15-00-00Z
   Re-encapsulated 12 keys against fresh ephemeral KEM keypair
   Wrote secrets.bundle.json (4 KB)
   Audit: rotate keysAffected=12
   ```

3. **Verify** the new bundle:
   ```bash
   $ python3 .agents/skills/pqc-secrets/scripts/verify-bundle.py
   OK: bundle validates, 1 recipient, 0 plaintext leaks
   ```

4. **Smoke-test** that the new bundle works:
   ```bash
   $ pqc-secrets status
   {"keychainOk":true, ... }
   $ pqc-secrets export | head -2
   export STRIPE_SECRET="sk-live-..."
   ```

5. **Confirm** the audit log:
   ```bash
   $ tail -1 ~/.config/pqc-secrets/audit.log
   2026-06-09T15:00:00Z hermes rotate keysAffected=12
   ```

**That's it.** No consumer config changes, no recipient.pub
distribution, no keychain entry changes. The data key is re-encaps'd
in place.

## §2 Full identity rotation (out-of-band ceremony)

**Trigger:** annually (compliance), after a security incident, or
when an employee with keychain access leaves.

**Duration:** 5-10 minutes (mostly manual coordination).

**Audit:** emits `rotate_identity keysAffected=N` and
`revoke_old_key grace_until=<UTC+7d>` events.

### Pre-flight checklist

- [ ] Schedule a maintenance window (consumers will see brief bundle
      re-issuance).
- [ ] Notify any team members with `recipient.pub` copies.
- [ ] Have a backup of the current bundle
      (`secrets.bundle.json.bak.<UTC>`).
- [ ] Confirm the current keychain entry exists:
      `security find-generic-password -s pqc-secrets -a ml-kem-768`

### Steps

1. **Generate new keypair** (do NOT overwrite the existing one yet):
   ```bash
   $ pqc-secrets keygen --recipient-out /tmp/pqc-new-recipient.pub
   Wrote public key to /tmp/pqc-new-recipient.pub
   ```

2. **Verify** the new pubkey differs from the current:
   (Rotation also migrates a legacy expanded-form key store to the native
   seed form — the migration is complete once the bundle is re-packed.)
   ```bash
   $ shasum -a 256 /tmp/pqc-new-recipient.pub ~/.config/pqc-secrets/recipient.pub
   ```
   The hashes should differ.

3. **Decapsulate** the existing bundle (one read per key — recorded
   in the audit log as `get mode=plain`):
   ```bash
   $ pqc-secrets export --bundle /tmp/secrets-export.sh
   $ head -5 /tmp/secrets-export.sh
   export STRIPE_SECRET="sk-live-..."
   export GH_TOKEN="ghp_..."
   ```
   Keep this file in memory; do not save to disk.

4. **Write the new keypair to the keychain** (overwriting the
   current entry):
   ```bash
   $ pqc-secrets keygen --in-place
   Wrote public key to /Users/nbiish/.config/pqc-secrets/recipient.pub
   Wrote private key to macOS keychain (service: pqc-secrets, account: ml-kem-768)
   ```

5. **Re-pack** the bundle with the new recipient:
   ```bash
   $ pqc-secrets pack --bundle ~/.config/pqc-secrets/secrets.bundle.json
   Wrote 12 keys to /Users/nbiish/.config/pqc-secrets/secrets.bundle.json (4 KB)
   ```
   This reads from `/tmp/secrets-export.sh` if needed; in practice,
   the pack step reads the previous bundle directly via the
   keychain entry.

6. **Verify** the new bundle:
   ```bash
   $ python3 .agents/skills/pqc-secrets/scripts/verify-bundle.py
   OK: bundle validates, 1 recipient, 0 plaintext leaks
   ```

7. **Distribute** the new `recipient.pub` to every consumer:
   - `~/.hermes/config.yaml` (Hermes MCP) — no change needed; the
     recipient.pub is on disk, MCP server reads it on startup.
   - Any other agents that pin a specific recipient.pub path.

8. **Reload** consumers:
   - For Hermes: `/reload-mcp` in the TUI input box.
   - For other consumers: restart the process.

9. **Old keychain entry** is **kept** for 7 days (in case
   distribution is partial). After 7 days, delete:
   ```bash
   $ security delete-generic-password -s pqc-secrets -a ml-kem-768
   ```
   Actually, the keygen step in #4 overwrites the entry, so the
   "old" keychain entry no longer exists. The 7-day grace is for
   the case where you used a NEW keychain account name (e.g.,
   `ml-kem-768-2026-06`) and the old `ml-kem-768` entry is still
   in the keychain. In that case, delete the old entry after 7 days.

10. **Audit log** should show:
    ```bash
    $ grep -E 'rotate_identity|revoke_old_key' ~/.config/pqc-secrets/audit.log
    2026-06-09T15:00:00Z hermes rotate_identity keysAffected=12
    2026-06-09T15:00:00Z hermes revoke_old_key grace_until=2026-06-16T15:00:00Z
    ```

## §3 Disaster recovery — Lost keychain entry

If the keychain is wiped (Time Machine restore failure, accidental
`security delete-generic-password`, macOS reinstall without restoring
keychain), the data in `secrets.bundle.json` is **unrecoverable**.
PQC keys are not escrowed; this is intentional.

### Recovery requires ONE of:

- A working keychain entry for the original ML-KEM-768 key
  (the only one — no shares, no recovery codes)
- OR a backup of the bundle's **plaintext** (which should never
  exist on disk per the threat model)

### Mitigations

- **Time Machine.** Keep the keychain entry on a Time Machine
  backup volume. Verify monthly that the backup includes the
  `pqc-secrets` service:
  ```bash
  $ tmutil listbackups | head
  $ security find-generic-password -s pqc-secrets -a ml-kem-768 \
      -D /Volumes/Time\ Machine\ Backups/Backups.backupdb/...
  ```
  (This is a manual check; restore from a Time Machine backup if
  the keychain entry is missing.)

- **Bundle backups.** Maintain N=5 generations of bundle backups
  in `~/.config/pqc-secrets/`:
  ```bash
  ls -la ~/.config/pqc-secrets/secrets.bundle.json.bak.*
  ```
  The rotate op naturally produces one; copy older generations
  from your existing bundle history.

- **Critical: never write the bundle plaintext to disk.** If you
  must export a value for a one-time use, pipe it directly:
  ```bash
  $ pqc-secrets export | grep STRIPE_SECRET | cut -d= -f2- | tr -d '"' | my-tool
  ```
  No intermediate file. No leftover plaintext.

## See also

- `references/pqc-secrets-cli.md` — CLI reference
- `references/bundle-schema.md` — bundle file format
- `references/audit-log.md` — audit log format
