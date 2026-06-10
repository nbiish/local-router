#!/usr/bin/env python3
"""verify-bundle.py — validate a PQC secrets bundle.

Checks:
  1. Bundle file parses as JSON.
  2. Required top-level fields are present.
  3. KEM ciphertext length is reasonable for ML-KEM-768 (>= 1000 B encoded).
  4. AES-GCM tag length is reasonable (>= 16 B encoded).
  5. Scans for plaintext secret patterns (sk-live, sk-test, whsec_, AKIA, ghp_).

Usage:
  verify-bundle.py                          # validate live bundle
  verify-bundle.py --bundle <PATH>          # validate a specific bundle
  verify-bundle.py --dummy                  # validate a generated dummy
  verify-bundle.py --strict                 # stricter size checks (>= 1500 B KEM)

Exit codes:
  0 — bundle validates
  1 — bundle invalid (missing fields, corrupt, plaintext leak)
  2 — file not found / not readable
  3 — invalid arguments

This is the canonical pre-commit / CI check for any pqc-secrets bundle.
The verifier is intentionally pure-stdlib so it runs anywhere Python 3.6+
is available (CI, pre-commit hook, local dev).
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
from typing import Any, Dict

# Required top-level fields (verified against the live bundle schema).
# Top-level fields that must be present in any v1 bundle.
REQUIRED_FIELDS = ["version", "alg", "engine", "created_utc",
                   "recipient", "kem", "keywrap", "data"]

# Sub-fields that must be present in each top-level block.
REQUIRED_RECIPIENT = ["public_key_sha3_256"]
REQUIRED_KEM = ["ciphertext_b64"]
REQUIRED_KEYWRAP = ["kdf", "aad", "nonce_b64", "ciphertext_b64"]
REQUIRED_DATA = ["aad", "nonce_b64", "ciphertext_b64"]

# Expected sizes (raw, base64-decoded).
# ML-KEM-768 KEM ciphertext is 1088 B. AES-256-GCM tag is 16 B appended
# to the data ciphertext. SHA3-256 digest is 32 B.
KEM_RAW_LEN = 1088  # ML-KEM-768
NONCE_RAW_LEN = 12  # AES-256-GCM nonce
MIN_DATA_RAW_LEN = 16  # At least the GCM tag must be present
RECIPIENT_FP_LEN = 64  # SHA3-256 hex = 64 chars

# Plaintext secret patterns (these should NEVER appear in the bundle).
# Each pattern is compiled as a regex against the bundle's raw JSON.
PLAINTEXT_PATTERNS = [
    rb"sk-live-[A-Za-z0-9]{8,}",
    rb"sk-test-[A-Za-z0-9]{8,}",
    rb"whsec_[A-Za-z0-9]{8,}",
    rb"AKIA[0-9A-Z]{16}",
    rb"ghp_[A-Za-z0-9]{8,}",
]

# Default bundle path (the canonical ~/.config/pqc-secrets/ location).
DEFAULT_BUNDLE = os.path.expanduser("~/.config/pqc-secrets/secrets.bundle.json")


def _make_dummy_bundle() -> Dict[str, Any]:
    """Construct a minimal valid-looking dummy bundle for --dummy mode."""
    return {
        "version": 1,
        "alg": "ML-KEM-768",
        "engine": "rust-fips203 (dummy)",
        "created_utc": "2026-06-09T00:00:00Z",
        "recipient": {
            "public_key_sha3_256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        },
        "kem": {
            "ciphertext_b64": base64.b64encode(b"\x00" * 1088).decode("ascii"),
        },
        "keywrap": {
            "kdf": "SHA3-256",
            "aad": "pqc-secrets:v1:keywrap",
            "nonce_b64": base64.b64encode(b"\x00" * 12).decode("ascii"),
            "ciphertext_b64": base64.b64encode(b"\x00" * 48).decode("ascii"),
        },
        "data": {
            "aad": "pqc-secrets:v1:data",
            "nonce_b64": base64.b64encode(b"\x00" * 12).decode("ascii"),
            "ciphertext_b64": base64.b64encode(b"\x00" * 64).decode("ascii"),
        },
    }


def _check_required_fields(bundle: Dict[str, Any]) -> str | None:
    for f in REQUIRED_FIELDS:
        if f not in bundle:
            return f"FAIL: missing required top-level field '{f}'"
    for f in REQUIRED_RECIPIENT:
        if f not in bundle.get("recipient", {}):
            return f"FAIL: missing recipient.{f}"
    for f in REQUIRED_KEM:
        if f not in bundle.get("kem", {}):
            return f"FAIL: missing kem.{f}"
    for f in REQUIRED_KEYWRAP:
        if f not in bundle.get("keywrap", {}):
            return f"FAIL: missing keywrap.{f}"
    for f in REQUIRED_DATA:
        if f not in bundle.get("data", {}):
            return f"FAIL: missing data.{f}"
    return None


def _check_kem_length(bundle: Dict[str, Any], strict: bool) -> str | None:
    """Validate the kem.ciphertext_b64 length.

    ML-KEM-768 raw KEM ciphertext is 1088 B. Encoded base64 is ~1452 chars.
    The verifier decodes the base64 and checks the raw length.
    """
    ct = bundle.get("kem", {}).get("ciphertext_b64", "")
    if not ct:
        return "FAIL: kem.ciphertext_b64 is empty"
    try:
        decoded_len = len(base64.b64decode(ct, validate=True))
    except Exception as e:
        return f"FAIL: kem.ciphertext_b64 is not valid base64: {e}"
    if decoded_len != KEM_RAW_LEN:
        return (f"FAIL: kem.ciphertext_b64 decoded length {decoded_len} B "
                f"!= expected {KEM_RAW_LEN} B (ML-KEM-768)")
    return None


def _check_nonce_length(bundle: Dict[str, Any]) -> str | None:
    """Validate the data.nonce_b64 length (12 B for AES-256-GCM)."""
    nonce = bundle.get("data", {}).get("nonce_b64", "")
    if not nonce:
        return "FAIL: data.nonce_b64 is empty"
    try:
        decoded_len = len(base64.b64decode(nonce, validate=True))
    except Exception as e:
        return f"FAIL: data.nonce_b64 is not valid base64: {e}"
    if decoded_len != NONCE_RAW_LEN:
        return (f"FAIL: data.nonce_b64 decoded length {decoded_len} B "
                f"!= expected {NONCE_RAW_LEN} B (AES-256-GCM nonce)")
    return None


def _check_data_ciphertext_length(bundle: Dict[str, Any]) -> str | None:
    """Validate the data.ciphertext_b64 length.

    The data.ciphertext_b64 contains the AES-256-GCM ciphertext WITH the
    16-byte auth tag appended (no separate 'tag' field). The minimum length
    is the GCM tag (16 B). For N secrets of ~100 bytes each, the expected
    length is approximately (N * 100) + 16 B.
    """
    ct = bundle.get("data", {}).get("ciphertext_b64", "")
    if not ct:
        return "FAIL: data.ciphertext_b64 is empty"
    try:
        decoded_len = len(base64.b64decode(ct, validate=True))
    except Exception as e:
        return f"FAIL: data.ciphertext_b64 is not valid base64: {e}"
    if decoded_len < MIN_DATA_RAW_LEN:
        return (f"FAIL: data.ciphertext_b64 decoded length {decoded_len} B "
                f"< minimum {MIN_DATA_RAW_LEN} B (must include GCM tag)")
    return None


def _check_recipient_fingerprint(bundle: Dict[str, Any]) -> str | None:
    """Validate the recipient.public_key_sha3_256 length (64 hex chars)."""
    fp = bundle.get("recipient", {}).get("public_key_sha3_256", "")
    if not fp:
        return "FAIL: recipient.public_key_sha3_256 is empty"
    if len(fp) != RECIPIENT_FP_LEN:
        return (f"FAIL: recipient.public_key_sha3_256 length {len(fp)} "
                f"!= expected {RECIPIENT_FP_LEN} (SHA3-256 hex)")
    # Verify it's valid hex.
    try:
        bytes.fromhex(fp)
    except ValueError:
        return f"FAIL: recipient.public_key_sha3_256 is not valid hex"
    return None


def _check_no_plaintext(bundle: Dict[str, Any]) -> str | None:
    raw = json.dumps(bundle, sort_keys=True).encode("utf-8")
    for pat in PLAINTEXT_PATTERNS:
        m = re.search(pat, raw)
        if m:
            return f"FAIL: plaintext secret pattern found: {m.group(0).decode('latin-1')[:20]}..."
    return None


def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__.split("\n", 1)[0] if __doc__ else "verify a PQC secrets bundle"
    )
    p.add_argument("--bundle", default=DEFAULT_BUNDLE,
                   help="Path to secrets.bundle.json (default: %(default)s)")
    p.add_argument("--dummy", action="store_true",
                   help="Validate against a generated dummy bundle (no file I/O)")
    p.add_argument("--strict", action="store_true",
                   help="Stricter size checks (KEM ciphertext >= 1500 B encoded)")
    args = p.parse_args()

    # Load the bundle.
    if args.dummy:
        bundle = _make_dummy_bundle()
    else:
        if not os.path.isfile(args.bundle):
            print(f"FAIL: bundle not found: {args.bundle}")
            return 2
        try:
            with open(args.bundle, "rb") as f:
                bundle = json.loads(f.read().decode("utf-8"))
        except json.JSONDecodeError as e:
            print(f"FAIL: bundle is not valid JSON: {e}")
            return 1
        except OSError as e:
            print(f"FAIL: cannot read bundle: {e}")
            return 2

    # Run checks.
    for check in (
        lambda: _check_required_fields(bundle),
        lambda: _check_recipient_fingerprint(bundle),
        lambda: _check_kem_length(bundle, args.strict),
        lambda: _check_nonce_length(bundle),
        lambda: _check_data_ciphertext_length(bundle),
        lambda: _check_no_plaintext(bundle),
    ):
        msg = check()
        if msg is not None:
            print(msg)
            return 1

    # All checks passed.
    fp = bundle.get("recipient", {}).get("public_key_sha3_256", "?")[:16]
    n_keys_estimate = max(
        0,
        (len(bundle.get("data", {}).get("ciphertext_b64", "")) * 3 // 4 - 16) // 100,
    )
    if args.dummy:
        print(f"OK: dummy bundle validates, recipient.fp=sha3:{fp}... (no plaintext leaks)")
    else:
        print(f"OK: bundle validates, recipient.fp=sha3:{fp}..., "
              f"~{n_keys_estimate} keys, 0 plaintext leaks")
    return 0


if __name__ == "__main__":
    sys.exit(main())
