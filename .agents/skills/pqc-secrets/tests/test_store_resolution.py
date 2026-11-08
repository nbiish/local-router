"""Regression guards for store resolution across WSL host boundaries.

The bug these pin: `resolve_store()` returned the Windows host store from WSL
merely because it EXISTED. On the reference machine both stores exist but hold
DIFFERENT identities:

  WSL native   ~/.config/pqc-secrets     24 keys   identity ff76bf0a...
  Windows host /mnt/c/Users/*/...         1 key    identity f73b5a70...

The Windows store held nothing but a test fixture (`LOCALROUTER_TEST_VENDOR_API_KEY`)
from `tests/pqc-key-resolver.test.mjs`, yet it won resolution. So:

  * `pqc-secrets list` / `export` showed 1 key while the router read 24 — which
    reads as "keys are not persisting";
  * `printf 'KEY=val' | pqc-secrets pack --merge`, the documented way to add a
    key, wrote into that test-artefact store;
  * every tool resolving credentials through `export` (ainish-rag does) saw it.

Precedence now requires keys, not mere existence, and between two populated
stores the fuller one wins. Host interop still works when local is empty.
"""

from __future__ import annotations

import re
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parent.parent
ENGINE = SKILL_ROOT / "scripts" / "pqc_secrets.py"


def _source() -> str:
    return ENGINE.read_text(encoding="utf-8")


def _function_body(src: str, name: str) -> str:
    """Source text of one top-level def, bounded by indentation."""
    lines = src.splitlines()
    start = None
    for i, line in enumerate(lines):
        if re.match(rf"^def {re.escape(name)}\(", line):
            start = i
            break
    if start is None:
        return ""
    out = [lines[start]]
    for line in lines[start + 1:]:
        if line.strip() and not line.startswith((" ", "\t")):
            break
        out.append(line)
    return "\n".join(out)


# ── the precedence rule ────────────────────────────────────────────────────

def test_resolve_store_does_not_return_host_on_existence_alone():
    """The regression: a bare early return of the host store with no comparison."""
    body = _function_body(_source(), "resolve_store")
    assert body, "resolve_store not found"

    bare_return = re.search(
        r"if\s+_is_wsl\(\):\s*\n\s*host\s*=\s*_wsl_windows_store\(\)\s*\n\s*if\s+host\s+is\s+not\s+None:\s*\n\s*return\s+host,\s*['\"]host-interop['\"]",
        body,
    )
    assert bare_return is None, (
        "resolve_store returns the host store on existence alone again; a store "
        "holding only a test fixture would outrank the real one"
    )
    assert "_store_key_count" in body, (
        "resolve_store no longer compares key counts, so an empty or "
        "test-artefact store can still outrank a populated one"
    )


def test_store_key_count_never_raises():
    """It runs at import time, so a mismatched identity must not kill every command."""
    body = _function_body(_source(), "_store_key_count")
    assert body, "_store_key_count not found"
    assert "except Exception" in body, (
        "_store_key_count must swallow read/decrypt failures: a foreign-identity "
        "store (a different keypair) must report 0, not abort import"
    )
    assert "return 0" in body, "an unreadable store must report 0 keys, not raise"


def test_store_key_count_handles_a_foreign_identity():
    """A store encrypted to a different keypair is unreadable, not fatal.

    This is the real shape on the reference machine: the Windows store's
    recipient key differs, so its machine.kek cannot open the WSL bundle. The
    count must degrade to 0 rather than propagate an AESGCM error.
    """
    body = _function_body(_source(), "_store_key_count")
    # The decrypt is inside the try, not before it.
    try_at = body.find("try:")
    decrypt_at = body.find("_decrypt_bundle")
    assert try_at != -1 and decrypt_at != -1, "_store_key_count lost its decrypt step"
    assert try_at < decrypt_at, (
        "the bundle decrypt must be inside the try block, or a foreign-identity "
        "store raises during import"
    )


def test_vault_backed_store_is_treated_as_readable():
    """A vault store's identity is passphrase-gated, so it cannot be counted."""
    body = _function_body(_source(), "_store_key_count")
    assert "vault.pqc" in body, (
        "_store_key_count must special-case vault.pqc: it cannot decrypt without "
        "the operator passphrase and would otherwise report 0 keys"
    )


# ── contracts that must not regress ────────────────────────────────────────

def test_isolated_escape_hatch_short_circuits_before_host_lookup():
    body = _function_body(_source(), "resolve_store")
    isolated = body.find("PQC_STORE_ISOLATED")
    host = body.find("_wsl_windows_store")
    assert isolated != -1, "the isolation escape hatch disappeared"
    assert host == -1 or isolated < host, (
        "isolation must be checked before any host-store lookup, or isolated "
        "users still reach across stores"
    )


def test_explicit_env_always_wins():
    body = _function_body(_source(), "resolve_store")
    explicit = body.find("PQC_CONFIG_DIR")
    isolated = body.find("PQC_STORE_ISOLATED")
    assert explicit != -1, "PQC_CONFIG_DIR override disappeared"
    assert explicit < isolated, (
        "an explicit PQC_CONFIG_DIR must be honoured before isolation and "
        "auto-detection, otherwise the documented override silently loses"
    )


def test_documented_source_values_survive():
    """`store --json` consumers read these exact strings."""
    body = _function_body(_source(), "resolve_store")
    for value in ('"env"', '"isolated"', '"home"'):
        assert value in body, f"source value {value} disappeared from resolve_store"
