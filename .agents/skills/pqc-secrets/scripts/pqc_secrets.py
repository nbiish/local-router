#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "kyber-py>=0.2.0",
#     "cryptography>=44.0",
# ]
# ///
"""
PQC Secrets Management — ML-KEM-768 + AES-256-GCM.
Post-quantum encryption for API keys and private data.

  keygen   Generate ML-KEM-768 keypair; private -> encrypted local store (keychain if opted-in), public -> ~/.config/pqc-secrets/recipient.pub
  pack     Read KEY=VALUE lines from stdin, encrypt, write ~/.config/pqc-secrets/secrets.bundle.json
  export   Decrypt bundle, output shell 'export KEY=VALUE' lines to stdout
  verify   Check bundle integrity, list key names (no values)
  migrate  Migrate keychain entry from old account name to new account name

Environment variables:
  PQC_USE_KEYCHAIN           Set to "true" to opt-in to macOS Keychain or Linux Secret Service (default: false, uses encrypted file store)
  PQC_KEYCHAIN_ACCOUNT       Keychain account name (default: pqc-secrets-key)
  PQC_KEYCHAIN_ACCOUNT_OLD   Old account name for migrate command (default: default)
  PQC_KEYCHAIN_ACCOUNT_NEW   New account name for migrate command (default: pqc-secrets-key)
"""

import base64
import getpass
import hashlib
import json
import os
import platform
import subprocess
import sys
import uuid
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from kyber_py.ml_kem import ML_KEM_768

CONFIG_DIR = Path(os.environ.get("PQC_CONFIG_DIR") or (Path.home() / ".config" / "pqc-secrets"))
PUBKEY_PATH = CONFIG_DIR / "recipient.pub"
BUNDLE_PATH = CONFIG_DIR / "secrets.bundle.json"
PRIVATE_KEY_ENC_PATH = CONFIG_DIR / "private.key.enc"
KEYCHAIN_SERVICE = "pqc-secrets"
KEYCHAIN_ACCOUNT = os.environ.get("PQC_KEYCHAIN_ACCOUNT", "pqc-secrets-key")
KDF_INFO = b"pqc-secrets:v1:kek"


def _ensure_config_dir() -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_DIR.chmod(0o700)


def _get_machine_kek() -> bytes:
    parts = [
        platform.node(),
        getpass.getuser(),
        platform.platform(),
        hex(uuid.getnode())
    ]
    entropy = "|".join(parts).encode("utf-8")
    
    hkdf = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=b"pqc-secrets:v1:machine-salt",
        info=b"pqc-secrets:v1:machine-key",
    )
    return hkdf.derive(entropy)


def _save_key_to_file(sk: bytes) -> None:
    _ensure_config_dir()
    kek = _get_machine_kek()
    
    nonce = os.urandom(12)
    ciphertext = AESGCM(kek).encrypt(nonce, sk, b"pqc-secrets:v1:private-key")
    
    payload = {
        "version": 1,
        "nonce_b64": base64.b64encode(nonce).decode(),
        "ciphertext_b64": base64.b64encode(ciphertext).decode(),
    }
    
    PRIVATE_KEY_ENC_PATH.write_text(json.dumps(payload, indent=2))
    PRIVATE_KEY_ENC_PATH.chmod(0o600)


def _load_key_from_file() -> bytes:
    if not PRIVATE_KEY_ENC_PATH.exists():
        print(f"ERROR: Private key not found in keychain or file at {PRIVATE_KEY_ENC_PATH}. Run 'keygen' first.", file=sys.stderr)
        sys.exit(1)
        
    try:
        payload = json.loads(PRIVATE_KEY_ENC_PATH.read_text())
        nonce = base64.b64decode(payload["nonce_b64"])
        ciphertext = base64.b64decode(payload["ciphertext_b64"])
        
        kek = _get_machine_kek()
        sk = AESGCM(kek).decrypt(nonce, ciphertext, b"pqc-secrets:v1:private-key")
        return sk
    except Exception as e:
        print(f"ERROR: Failed to decrypt private key from local store: {e}", file=sys.stderr)
        sys.exit(1)


def _store_private_key(sk: bytes) -> None:
    # Check if native keychain is requested; otherwise default to system-agnostic file backend
    if os.environ.get("PQC_USE_KEYCHAIN") != "true":
        _save_key_to_file(sk)
        return

    # Try native keychain
    # macOS
    if sys.platform == "darwin":
        try:
            subprocess.run(
                [
                    "security", "add-generic-password",
                    "-s", KEYCHAIN_SERVICE,
                    "-a", KEYCHAIN_ACCOUNT,
                    "-w", sk.hex(),
                    "-U",
                ],
                check=True,
                capture_output=True,
            )
            return
        except Exception as e:
            print(f"WARNING: macOS Keychain failed ({e}). Falling back to encrypted file store.", file=sys.stderr)
    
    # Linux (secret-tool)
    elif sys.platform.startswith("linux"):
        try:
            subprocess.run(
                [
                    "secret-tool", "store",
                    "--label=pqc-secrets",
                    "service", KEYCHAIN_SERVICE,
                    "account", KEYCHAIN_ACCOUNT,
                ],
                input=sk.hex().encode('utf-8'),
                check=True,
                capture_output=True,
            )
            return
        except Exception as e:
            print(f"WARNING: Linux secret-tool failed ({e}). Falling back to encrypted file store.", file=sys.stderr)

    # Universal File-based Fallback
    _save_key_to_file(sk)


def _load_private_key() -> bytes:
    # Check if native keychain is requested; otherwise default to system-agnostic file backend
    if os.environ.get("PQC_USE_KEYCHAIN") != "true":
        return _load_key_from_file()

    # Try native keychain
    # macOS
    if sys.platform == "darwin":
        try:
            result = subprocess.run(
                [
                    "security", "find-generic-password",
                    "-s", KEYCHAIN_SERVICE,
                    "-a", KEYCHAIN_ACCOUNT,
                    "-w",
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            raw = result.stdout.strip()
            try:
                return bytes.fromhex(raw)
            except ValueError:
                return base64.b64decode(raw)
        except Exception:
            pass

    # Linux (secret-tool)
    elif sys.platform.startswith("linux"):
        try:
            result = subprocess.run(
                [
                    "secret-tool", "lookup",
                    "service", KEYCHAIN_SERVICE,
                    "account", KEYCHAIN_ACCOUNT,
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            raw = result.stdout.strip()
            if raw:
                try:
                    return bytes.fromhex(raw)
                except ValueError:
                    return base64.b64decode(raw)
        except Exception:
            pass

    # Universal File-based Fallback
    return _load_key_from_file()

def _load_private_key_from_account(account: str) -> bytes:
    if os.environ.get("PQC_USE_KEYCHAIN") != "true":
        return _load_key_from_file()

    # Try macOS security first
    if sys.platform == "darwin":
        try:
            result = subprocess.run(
                [
                    "security", "find-generic-password",
                    "-s", KEYCHAIN_SERVICE,
                    "-a", account,
                    "-w",
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            raw = result.stdout.strip()
            try:
                return bytes.fromhex(raw)
            except ValueError:
                return base64.b64decode(raw)
        except Exception:
            pass
            
    # Try Linux secret-tool
    elif sys.platform.startswith("linux"):
        try:
            result = subprocess.run(
                [
                    "secret-tool", "lookup",
                    "service", KEYCHAIN_SERVICE,
                    "account", account,
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            raw = result.stdout.strip()
            if raw:
                try:
                    return bytes.fromhex(raw)
                except ValueError:
                    return base64.b64decode(raw)
        except Exception:
            pass
            
    # Fallback to local encrypted file
    if PRIVATE_KEY_ENC_PATH.exists():
        return _load_key_from_file()
        
    raise RuntimeError("Private key not found in keychain or local store")

def _delete_private_key_from_account(account: str) -> None:
    if os.environ.get("PQC_USE_KEYCHAIN") == "true":
        if sys.platform == "darwin":
            subprocess.run(
                [
                    "security", "delete-generic-password",
                    "-s", KEYCHAIN_SERVICE,
                    "-a", account,
                ],
                check=False,
                capture_output=True,
            )
        elif sys.platform.startswith("linux"):
            subprocess.run(
                [
                    "secret-tool", "clear",
                    "service", KEYCHAIN_SERVICE,
                    "account", account,
                ],
                check=False,
                capture_output=True,
            )
    # Also delete private key file if account matches current account
    if account == KEYCHAIN_ACCOUNT and PRIVATE_KEY_ENC_PATH.exists():
        try:
            PRIVATE_KEY_ENC_PATH.unlink()
        except Exception:
            pass
def cmd_keygen() -> None:
    """Generate ML-KEM-768 keypair. Private -> Encrypted File/Keystore. Public -> disk."""
    _ensure_config_dir()

    pk, sk = ML_KEM_768.keygen()

    # Store private key using cross-platform helper
    _store_private_key(sk)

    # Write public key to disk
    pk_hex = pk.hex()
    PUBKEY_PATH.write_text(pk_hex)
    PUBKEY_PATH.chmod(0o600)

    print("ML-KEM-768 keypair generated.")
    print(f"  Private key: Securely stored (account={KEYCHAIN_ACCOUNT})")
    print(f"  Public key:  {PUBKEY_PATH}")

def _load_public_key() -> bytes:
    """Load ML-KEM-768 public key from disk.

    Supports both formats:
    - Rust engine (JSON): {"public_key_b64": "...", "engine": "rust-fips203"}
    - Legacy Python (hex): raw hex string
    """
    if not PUBKEY_PATH.exists():
        print(f"ERROR: Public key not found at {PUBKEY_PATH}. Run 'keygen' first.", file=sys.stderr)
        sys.exit(1)
    raw = PUBKEY_PATH.read_text().strip()
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict) and "public_key_b64" in parsed:
            return base64.b64decode(parsed["public_key_b64"])
    except (json.JSONDecodeError, ValueError):
        pass
    return bytes.fromhex(raw)


def cmd_pack() -> None:
    """Read KEY=VALUE lines from stdin, encrypt via AES-256-GCM + ML-KEM-768.

    Produces a Rust-compatible bundle with keywrap layer and AAD.
    """
    _ensure_config_dir()

    pk = _load_public_key()
    lines = sys.stdin.read().strip()
    if not lines:
        print("ERROR: No input provided on stdin.", file=sys.stderr)
        sys.exit(1)

    # Parse KEY=VALUE pairs
    entries: dict[str, str] = {}
    for line in lines.split("\n"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        entries[key.strip()] = value.strip()

    if not entries:
        print("ERROR: No valid KEY=VALUE pairs found in input.", file=sys.stderr)
        sys.exit(1)

    # Generate random data key (32 bytes)
    data_key = os.urandom(32)

    # Encrypt payload with data key
    data_nonce = os.urandom(12)
    payload_plaintext = json.dumps({"secrets": entries}, sort_keys=True).encode("utf-8")
    data_ciphertext = AESGCM(data_key).encrypt(data_nonce, payload_plaintext, b"pqc-secrets:v1:data")

    # ML-KEM encapsulation
    shared_secret, ciphertext_kem = ML_KEM_768.encaps(pk)

    # Derive KEK from shared secret
    kek = hashlib.sha3_256(shared_secret + KDF_INFO).digest()

    # Wrap data key with KEK
    keywrap_nonce = os.urandom(12)
    keywrap_ciphertext = AESGCM(kek).encrypt(keywrap_nonce, data_key, b"pqc-secrets:v1:keywrap")

    bundle = {
        "version": 1,
        "alg": "ML-KEM-768",
        "engine": "kyber-py",
        "created_utc": __import__("datetime").datetime.now(__import__("datetime").UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        "recipient": {
            "public_key_sha3_256": hashlib.sha3_256(pk).hexdigest(),
        },
        "kem": {
            "ciphertext_b64": base64.b64encode(ciphertext_kem).decode(),
        },
        "keywrap": {
            "kdf": "SHA3-256",
            "aad": "pqc-secrets:v1:keywrap",
            "nonce_b64": base64.b64encode(keywrap_nonce).decode(),
            "ciphertext_b64": base64.b64encode(keywrap_ciphertext).decode(),
        },
        "data": {
            "aad": "pqc-secrets:v1:data",
            "nonce_b64": base64.b64encode(data_nonce).decode(),
            "ciphertext_b64": base64.b64encode(data_ciphertext).decode(),
        },
    }

    BUNDLE_PATH.write_text(json.dumps(bundle, indent=2, sort_keys=True))
    BUNDLE_PATH.chmod(0o600)
    print(f"Secrets packed: {len(entries)} keys -> {BUNDLE_PATH}")


def _decrypt_bundle(bundle: dict, sk: bytes) -> dict[str, str]:
    """Decrypt a bundle, handling both legacy (hex) and Rust-engine (b64+keywrap) formats."""
    # Decapsulate DEK from KEM ciphertext
    kem = bundle["kem"]
    if "ciphertext_b64" in kem:
        ciphertext_kem = base64.b64decode(kem["ciphertext_b64"])
    else:
        ciphertext_kem = bytes.fromhex(kem["ciphertext"])
    dek = ML_KEM_768.decaps(sk, ciphertext_kem)

    # Derive the data key (DK)
    if "keywrap" in bundle:
        kw = bundle["keywrap"]
        kw_ct = base64.b64decode(kw["ciphertext_b64"])
        kw_nonce = base64.b64decode(kw["nonce_b64"])
        kw_aad = kw.get("aad", "pqc-secrets:v1:keywrap").encode("utf-8")
        kek = hashlib.sha3_256(dek + KDF_INFO).digest() if kw.get("kdf") == "SHA3-256" else dek
        dk = AESGCM(kek).decrypt(kw_nonce, kw_ct, kw_aad)
    else:
        dk = dek

    # Decrypt the data payload
    data_sec = bundle["data"]
    if "nonce_b64" in data_sec:
        nonce = base64.b64decode(data_sec["nonce_b64"])
    else:
        nonce = bytes.fromhex(data_sec["nonce"])
    if "ciphertext_b64" in data_sec:
        ciphertext = base64.b64decode(data_sec["ciphertext_b64"])
    else:
        ciphertext = bytes.fromhex(data_sec["ciphertext"])
    data_aad = data_sec.get("aad", "").encode("utf-8")

    plaintext = AESGCM(dk).decrypt(nonce, ciphertext, data_aad)
    return json.loads(plaintext)


def cmd_export() -> None:
    """Decrypt bundle and output shell export lines."""
    if not BUNDLE_PATH.exists():
        print(f"ERROR: Bundle not found at {BUNDLE_PATH}. Run 'pack' first.", file=sys.stderr)
        sys.exit(1)

    sk = _load_private_key()
    bundle = json.loads(BUNDLE_PATH.read_text())
    payload = _decrypt_bundle(bundle, sk)

    # Rust engine wraps secrets in {"secrets": {...}}; legacy packs directly
    entries = payload.get("secrets", payload) if isinstance(payload, dict) and "secrets" in payload else payload

    for key, value in entries.items():
        print(f"export {key}={value}")


def cmd_verify() -> None:
    """Verify bundle can be decrypted; list key names only."""
    if not BUNDLE_PATH.exists():
        print(f"Bundle not found at {BUNDLE_PATH}")
        sys.exit(1)

    sk = _load_private_key()
    bundle = json.loads(BUNDLE_PATH.read_text())
    payload = _decrypt_bundle(bundle, sk)

    entries = payload.get("secrets", payload) if isinstance(payload, dict) and "secrets" in payload else payload

    print(f"Bundle valid: {len(entries)} keys")
    for key in sorted(entries.keys()):
        print(f"  {key}")


def cmd_migrate() -> None:
    """Migrate keychain entry from old account name to new account name."""
    global KEYCHAIN_ACCOUNT
    old_account = os.environ.get("PQC_KEYCHAIN_ACCOUNT_OLD", "default")
    new_account = os.environ.get("PQC_KEYCHAIN_ACCOUNT_NEW", KEYCHAIN_ACCOUNT)

    if old_account == new_account:
        print(f"Old and new account names are the same ({old_account}). Nothing to migrate.")
        return

    # Read from old account
    try:
        sk = _load_private_key_from_account(old_account)
    except Exception as e:
        print(f"ERROR: No keychain entry found for service={KEYCHAIN_SERVICE}, account={old_account}: {e}", file=sys.stderr)
        sys.exit(1)

    # Delete old entry
    _delete_private_key_from_account(old_account)

    # Add new entry
    try:
        orig_account = KEYCHAIN_ACCOUNT
        KEYCHAIN_ACCOUNT = new_account
        _store_private_key(sk)
        KEYCHAIN_ACCOUNT = orig_account
    except Exception as e:
        print(f"ERROR: Failed to store private key to new account: {e}", file=sys.stderr)
        sys.exit(1)
    print(f"Migrated keychain entry: service={KEYCHAIN_SERVICE}, account={old_account} -> {new_account}")


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: pqc_secrets.py <keygen|pack|export|verify|migrate>", file=sys.stderr)
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "keygen":
        cmd_keygen()
    elif cmd == "pack":
        cmd_pack()
    elif cmd == "export":
        cmd_export()
    elif cmd == "verify":
        cmd_verify()
    elif cmd == "migrate":
        cmd_migrate()
    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        print("Usage: pqc_secrets.py <keygen|pack|export|verify|migrate>", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
