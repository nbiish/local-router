#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     # cryptography>=47 is REQUIRED, not merely preferred: `asymmetric.mlkem`
#     # (ML-KEM-768, FIPS 203) first appears in 47.0. The floor used to read
#     # ">=45.0", which resolves to a cryptography WITHOUT mlkem, so the
#     # module-level `from ... import mlkem` raised ImportError and EVERY
#     # command died before argument parsing — `list`, `export`, `store` and
#     # `verify` included. The failure surfaced as a bare traceback, so an
#     # operator could not tell a missing dependency from a broken store.
#     "cryptography>=47.0",
#     # argon2-cffi is pinned for vault.pqc identity unwrapping (vault-first
#     # export when a vault exists — Phase 1 parity with the Rust vault core).
#     "argon2-cffi==25.1.0",
#     # kyber-py is retained ONLY to decapsulate legacy expanded-form (2400-byte)
#     # private-key stores written by older engines. New keygens use the native
#     # cryptography ML-KEM-768 implementation exclusively.
#     "kyber-py>=0.2.0",
# ]
# ///
"""
PQC Secrets Management — ML-KEM-768 + AES-256-GCM.
Post-quantum encryption for API keys and private data.

  keygen   Generate ML-KEM-768 keypair; private -> encrypted local store (keychain if opted-in), public -> ~/.config/pqc-secrets/recipient.pub
  gen      Generate high-entropy secrets (OS CSPRNG via stdlib 'secrets'); 512-bit default,
           hex/base64url/base85 formats, EFF-large-list diceware passphrases, entropy
           reported on stderr, secret ONLY on stdout (pipe-safe, never logged)
  pack     Read KEY=VALUE lines from stdin, encrypt, write ~/.config/pqc-secrets/secrets.bundle.json
           (--merge preserves keys already in the bundle)
  set      Upsert one or more keys without disturbing the rest (NAME=VALUE ... or --stdin)
  del      Delete one or more keys, preserving the rest (NAME ...)
  export   Decrypt bundle, output shell 'export KEY=VALUE' lines to stdout (--json for tooling)
  verify   Check bundle integrity, list key names (no values)
  list     List secret names only (no values) — inspect what is set / needs renaming (--json)
  store    Show which bundle this platform resolves (env, host-interop, home) — --json
  rename   Rename one secret NAME (value preserved); previous bundle backed up first
  sync     Cross-machine / cross-store sync (per-identity re-pack)
  migrate  Migrate keychain entry from old account name to new account name

Environment variables:
  PQC_USE_KEYCHAIN           Set to "true" to opt-in to macOS Keychain or Linux Secret Service (default: false, uses encrypted file store)
  PQC_CONFIG_DIR             Explicit store directory (highest precedence)
  PQC_SECRETS_DIR            Contract alias for PQC_CONFIG_DIR
  PQC_STORE_ISOLATED         Set to "1" to keep per-environment stores (disables WSL<->Windows host interop)
  PQC_KEYCHAIN_ACCOUNT       Keychain account name (default: pqc-secrets-key)
  PQC_KEYCHAIN_ACCOUNT_OLD   Old account name for migrate command (default: default)
  PQC_KEYCHAIN_ACCOUNT_NEW   New account name for migrate command (default: pqc-secrets-key)
"""

import base64
import getpass
import hashlib
import json
import math
import os
import platform
import re
import secrets
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

# ML-KEM-768 (FIPS 203) is the store's key-encapsulation primitive, so without it every command —
# including read-only ones like `list` and `store` — is unusable. Import it defensively and explain
# the fix, because the bare ImportError named an internal module path and read like a corrupted
# install rather than an out-of-date dependency.
try:
    from cryptography.hazmat.primitives.asymmetric import mlkem as _native_mlkem
except ImportError as _mlkem_error:  # pragma: no cover - environment guard
    import cryptography as _cryptography

    _engine = Path(__file__).resolve()
    sys.stderr.write(
        "pqc-secrets: the installed 'cryptography' has no ML-KEM-768 support.\n"
        f"  installed: cryptography {getattr(_cryptography, '__version__', 'unknown')}\n"
        "  required:  cryptography >= 47.0 (asymmetric.mlkem first shipped in 47.0)\n"
        "\n"
        "Fix (recommended, uses this script's pinned dependencies):\n"
        f"  uv run --script {_engine} --help\n"
        "\n"
        "Or install the floor directly:\n"
        "  python3 -m pip install --upgrade 'cryptography>=47.0'\n"
        "\n"
        "If the dependency is installed for a different interpreter than the one running this\n"
        f"script, note that the active interpreter is {sys.executable}\n"
        f"(cryptography resolved from {Path(_cryptography.__file__).parent}).\n"
        f"\nOriginal error: {_mlkem_error}\n"
    )
    raise SystemExit(78)  # EX_CONFIG

# ML-KEM-768 private-key material lengths (FIPS 203):
#   64 bytes   = seed form (d || z) — stored by this engine since 2026-08-20;
#                the native cryptography implementation keygens and loads this form.
#   2400 bytes = expanded dk — written by older kyber-py keygens and the Rust
#                engine. Read-compatible via the kyber-py fallback path only.
KEM_SEED_LEN = 64
KEM_EXPANDED_LEN = 2400


def _kem_keygen() -> tuple[bytes, bytes]:
    """Generate an ML-KEM-768 keypair with the native engine.

    Returns (public_key_raw_1184, private_seed_64).
    """
    priv = _native_mlkem.MLKEM768PrivateKey.generate()
    return priv.public_key().public_bytes_raw(), priv.private_bytes_raw()


def _kem_encapsulate(public_key: bytes) -> tuple[bytes, bytes]:
    """Encapsulate against a raw 1184-byte ML-KEM-768 public key.

    Returns (shared_secret_32, ciphertext_1088).
    """
    pub = _native_mlkem.MLKEM768PublicKey.from_public_bytes(public_key)
    return pub.encapsulate()


def _kem_decapsulate(private_key: bytes, ciphertext: bytes) -> bytes:
    """Decapsulate with either supported private-key form.

    64-byte seed keys use the native engine. 2400-byte expanded keys (legacy
    kyber-py / Rust-engine stores) fall back to kyber-py with a rotation hint,
    because the seed cannot be recovered from the expanded form.
    """
    if len(private_key) == KEM_SEED_LEN:
        return _native_mlkem.MLKEM768PrivateKey.from_seed_bytes(private_key).decapsulate(ciphertext)
    if len(private_key) == KEM_EXPANDED_LEN:
        print(
            "NOTE: legacy expanded-form ML-KEM private key in use. "
            "Run 'keygen' and re-pack secrets to rotate to the native seed-form store.",
            file=sys.stderr,
        )
        from kyber_py.ml_kem import ML_KEM_768
        return ML_KEM_768.decaps(private_key, ciphertext)
    raise ValueError(
        f"unsupported ML-KEM-768 private key length {len(private_key)} "
        f"(expected {KEM_SEED_LEN}-byte seed or {KEM_EXPANDED_LEN}-byte expanded form)"
    )

def _is_wsl() -> bool:
    try:
        return "microsoft" in Path("/proc/version").read_text(encoding="utf-8").lower()
    except OSError:
        return False


def _store_has_bundle(path: Path) -> bool:
    return path.is_dir() and (path / "secrets.bundle.json").exists()


def _wsl_windows_store() -> Path | None:
    """The Windows host store as seen from WSL (/mnt/<drive>/Users/<user>)."""
    users = Path("/mnt/c/Users")
    if not _is_wsl() or not users.is_dir():
        return None
    candidates: list[Path] = []
    preferred = os.environ.get("USER") or getpass.getuser()
    if preferred:
        candidates.append(users / preferred / ".config" / "pqc-secrets")
    try:
        for entry in sorted(users.iterdir()):
            lowered = entry.name.lower()
            if lowered in {"public", "default", "all users"} or entry.name.startswith("."):
                continue
            candidates.append(entry / ".config" / "pqc-secrets")
    except OSError:
        pass
    for candidate in candidates:
        if _store_has_bundle(candidate):
            return candidate
    return None


def _decode_wsl_list(raw: bytes) -> list[str]:
    """Distro names from `wsl.exe -l -q`, tolerant of the encoding it actually returned.

    `wsl.exe` writes UTF-16-LE on some Windows builds and plain UTF-8 on others, and which one you
    get is not something the caller controls. Decoding unconditionally as UTF-16-LE turned
    "Ubuntu\\r\\ndocker-desktop" into mojibake (払湵畴…), so every distro name was garbage, the
    `\\\\wsl.localhost\\<distro>\\home` probe could never match, and Windows silently saw zero keys
    while the secrets sat in the WSL store. Detect the encoding from the byte shape instead.
    """
    if not raw:
        return []
    # UTF-16-LE ASCII text is padded with NUL bytes; UTF-8 almost never is.
    has_nul = b"\x00" in raw
    if has_nul:
        text = raw.decode("utf-16-le", errors="ignore")
    else:
        text = raw.decode("utf-8", errors="ignore")
    names: list[str] = []
    for line in text.splitlines():
        # Some builds emit a UTF-16 BOM or stray NULs even on the UTF-8 path.
        name = line.replace("\x00", "").replace("\ufeff", "").strip()
        if name:
            names.append(name)
    return names


def _windows_wsl_store() -> Path | None:
    """The WSL user store as seen from Windows (\\\\wsl.localhost\\<distro>\\home\\<user>)."""
    if os.name != "nt":
        return None
    try:
        raw = subprocess.run(
            ["wsl.exe", "-l", "-q"],
            capture_output=True,
            timeout=5,
            shell=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    # Both `\\wsl.localhost` (current) and `\\wsl$` (legacy) are attempted: either may be the one
    # the running Windows build exposes, and the legacy form still works on older builds.
    for distro in _decode_wsl_list(raw):
        for share in ("wsl.localhost", "wsl$"):
            home_root = Path(f"\\\\{share}\\{distro}\\home")
            try:
                homes = [entry for entry in home_root.iterdir() if entry.is_dir()]
            except OSError:
                continue
            for home in homes:
                candidate = home / ".config" / "pqc-secrets"
                if _store_has_bundle(candidate):
                    return candidate
    return None


def _store_key_count(path: Path) -> int:
    """How many secrets a store's bundle holds, or 0 when it cannot be read.

    The bundle is encrypted, so counting means decrypting that store's own
    private key and payload. This is deliberately best-effort and never raises:
    a store whose key will not load (wrong identity, a stale Windows key, a
    copy taken from another machine) cannot claim precedence, and the caller
    falls through to the next candidate instead of dying during import.

    Runs at import time, so it must stay cheap: it reads two small files and
    does one ML-KEM decapsulation per candidate store.
    """
    bundle_path = path / "secrets.bundle.json"
    key_path = path / "private.key.enc"
    kek_path = path / "machine.kek"
    if not bundle_path.is_file():
        return 0
    try:
        bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
        # A vault-backed store keeps its identity in vault.pqc; that read path is
        # passphrase-gated, so such a store is treated as readable-but-unknown
        # and only claims precedence on the existence of a bundle.
        if (path / "vault.pqc").is_file():
            return 1
        if not (key_path.is_file() and kek_path.is_file()):
            return 0
        payload = json.loads(key_path.read_text(encoding="utf-8"))
        nonce = base64.b64decode(payload["nonce_b64"])
        ciphertext = base64.b64decode(payload["ciphertext_b64"])
        kek = kek_path.read_bytes()
        sk = AESGCM(kek).decrypt(nonce, ciphertext, b"pqc-secrets:v1:private-key")
        decrypted = _decrypt_bundle(bundle, sk)
        entries = decrypted.get("secrets", decrypted) if isinstance(decrypted, dict) else {}
        return len(entries) if isinstance(entries, dict) else 0
    except Exception:
        return 0


def resolve_store() -> tuple[Path, str]:
    """Resolve the ONE store every tool on this machine should share.

    Order: explicit env (PQC_CONFIG_DIR, then the contract's PQC_SECRETS_DIR
    alias) → the local ~/.config store → host-interop store → ~/.config.

    Precedence rule (2026-11-08): a store is only a candidate for "the" store
    when it holds keys, and between two that both do, the fuller one wins. Before
    this, WSL returned the Windows host store merely because it EXISTED. On the
    reference machine that store held a single key while the local one held 24,
    so `pqc-secrets pack` (the documented way to add a key) wrote to a 1-key
    bundle the router did not treat as primary, and `pqc-secrets list` showed one
    key next to a router reading twenty-four. That reads as "keys are not
    persisting" and it is not survivable by any single-tool fix.

    Host interop is preserved, not removed: when the local store is empty the
    Windows store is still used, so a Windows-managed identity keeps working. The
    difference is that an empty store no longer outranks a populated one.

    PQC_STORE_ISOLATED=1 keeps per-environment stores and skips interop, which
    is the escape hatch for intentionally separate identities.
    """
    explicit = os.environ.get("PQC_CONFIG_DIR") or os.environ.get("PQC_SECRETS_DIR")
    if explicit:
        return Path(explicit).expanduser(), "env"
    local = Path.home() / ".config" / "pqc-secrets"
    if os.environ.get("PQC_STORE_ISOLATED") == "1":
        return local, "isolated"

    local_has_bundle = _store_has_bundle(local)
    local_keys = _store_key_count(local) if local_has_bundle else 0

    def _prefer_host(host: Path | None) -> tuple[Path, str] | None:
        """Host store beats local only when it actually holds more keys."""
        if host is None:
            return None
        host_keys = _store_key_count(host)
        if not local_has_bundle or host_keys > local_keys:
            return host, "host-interop"
        return None

    if _is_wsl():
        # A populated local store is the answer; interop only fills an empty one.
        if local_has_bundle and local_keys > 0:
            return local, "home"
        return _prefer_host(_wsl_windows_store()) or (local, "home")
    if os.name == "nt":
        if local_has_bundle and local_keys > 0:
            return local, "home"
        return _prefer_host(_windows_wsl_store()) or (local, "home")
    return local, "home"


CONFIG_DIR, STORE_SOURCE = resolve_store()
PUBKEY_PATH = CONFIG_DIR / "recipient.pub"
BUNDLE_PATH = CONFIG_DIR / "secrets.bundle.json"
PRIVATE_KEY_ENC_PATH = CONFIG_DIR / "private.key.enc"
KEK_PATH = CONFIG_DIR / "machine.kek"
KEYCHAIN_SERVICE = "pqc-secrets"
KEYCHAIN_ACCOUNT = os.environ.get("PQC_KEYCHAIN_ACCOUNT", "pqc-secrets-key")
KDF_INFO = b"pqc-secrets:v1:kek"

# Vault (Phase 1): vault.pqc is the canonical, OS-independent identity root
# when it exists. Python reads it (never writes) — write-side is Rust-only.
VAULT_PATH = CONFIG_DIR / "vault.pqc"
VAULT_KEM_SEED_AAD = b"pqc-secrets:vault:v1:kem-seed"
VAULT_PASSPHRASE_ENV = "PQC_VAULT_PASSPHRASE"


def _ensure_config_dir() -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_DIR.chmod(0o700)


def _legacy_machine_kek() -> bytes:
    """Legacy KEK derived from volatile machine identity.

    Deprecated: this derivation defeats persistence because it depends on
    platform.node()/platform.platform()/uuid.getnode(), which change across
    WSL2 reboots, kernel updates and distro re-creation. Any single part
    changing rotates the key and permanently locks the stored private key.
    Retained only to migrate pre-existing stores to the persisted KEK below.
    """
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


def _get_machine_kek() -> bytes:
    """Return a stable, persisted machine KEK.

    The KEK is generated once and persisted to a 0600 file so it survives
    reboots, WSL kernel updates and distro re-creation. Generation is
    preceded by a best-effort migration of any pre-existing store that was
    encrypted with the legacy machine-identity derivation.
    """
    _ensure_config_dir()

    if KEK_PATH.exists():
        return KEK_PATH.read_bytes()

    # Migration: if a legacy-encrypted private key already exists and still
    # decrypts with the volatile derivation, adopt that KEK so the store is
    # preserved and stable going forward. If it no longer decrypts (identity
    # already drifted), fall through and generate a fresh persisted KEK.
    if PRIVATE_KEY_ENC_PATH.exists():
        try:
            payload = json.loads(PRIVATE_KEY_ENC_PATH.read_text())
            nonce = base64.b64decode(payload["nonce_b64"])
            ciphertext = base64.b64decode(payload["ciphertext_b64"])
            legacy = _legacy_machine_kek()
            AESGCM(legacy).decrypt(nonce, ciphertext, b"pqc-secrets:v1:private-key")
            KEK_PATH.write_bytes(legacy)
            KEK_PATH.chmod(0o600)
            return legacy
        except Exception:
            # Legacy store is not recoverable under current identity; ignore
            # and mint a fresh persisted KEK.
            pass

    kek = os.urandom(32)
    KEK_PATH.write_bytes(kek)
    KEK_PATH.chmod(0o600)
    return kek


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


def _vault_load_kem_seed() -> bytes:
    """Unwrap the ML-KEM-768 seed from a vault.pqc store (read-only parity).

    Mirrors the Rust vault core (Phase 1) unwrap path without touching the OS
    keychain: Argon2id(passphrase, header salt/params) -> 32-byte vault KEK,
    then AES-256-GCM decrypt of the AAD-pinned kem_seed blob (64-byte d‖z).
    Fail-closed: version/alg/KDF checks, AAD pinning, seed length check.
    Passphrase: PQC_VAULT_PASSPHRASE env, else interactive prompt (never
    persisted, never logged).

    Scope note (documented decision): Python parity covers the ML-KEM identity
    path only — enough to decapsulate bundles keychain-free. The vault ML-DSA
    signing identity and the signed audit chain are verified by the Rust
    engine (`vault audit-verify`); there is no mature pinned Python ML-DSA.
    """
    from argon2.low_level import Type, hash_secret_raw

    try:
        header = json.loads(VAULT_PATH.read_text())
    except Exception as e:
        print(f"ERROR: vault unreadable at {VAULT_PATH}: {e}", file=sys.stderr)
        sys.exit(1)

    if header.get("version") != 1:
        print(f"ERROR: unsupported vault version {header.get('version')!r}", file=sys.stderr)
        sys.exit(1)
    if header.get("alg") != "ML-KEM-768" or header.get("sig_alg") != "ML-DSA-65":
        print("ERROR: unsupported vault algorithms (fail closed).", file=sys.stderr)
        sys.exit(1)
    kdf = header.get("kdf", {})
    if kdf.get("name") != "argon2id" or kdf.get("output_len") != 32:
        print("ERROR: unsupported vault KDF (fail closed).", file=sys.stderr)
        sys.exit(1)

    passphrase = os.environ.get(VAULT_PASSPHRASE_ENV)
    if passphrase is None:
        passphrase = getpass.getpass("Vault passphrase: ")

    try:
        salt = base64.b64decode(kdf["salt_b64"])
        kek = hash_secret_raw(
            secret=passphrase.encode("utf-8"),
            salt=salt,
            time_cost=int(kdf["t_cost"]),
            memory_cost=int(kdf["m_cost_kib"]),
            parallelism=int(kdf["p_cost"]),
            hash_len=32,
            type=Type.ID,
        )
        blob = header["kem_seed"]
        if blob.get("aad").encode() != VAULT_KEM_SEED_AAD:
            raise ValueError("vault kem_seed AAD mismatch (fail closed)")
        nonce = base64.b64decode(blob["nonce_b64"])
        ciphertext = base64.b64decode(blob["ciphertext_b64"])
        seed = AESGCM(kek).decrypt(nonce, ciphertext, VAULT_KEM_SEED_AAD)
    except SystemExit:
        raise
    except Exception as e:
        print(f"ERROR: vault unwrap failed (wrong passphrase or tampered vault): {e}", file=sys.stderr)
        sys.exit(1)

    if len(seed) != KEM_SEED_LEN:
        print(f"ERROR: vault seed has wrong length {len(seed)} (expected {KEM_SEED_LEN})", file=sys.stderr)
        sys.exit(1)
    return seed


def _load_private_key() -> bytes:
    # Vault-first (Phase 1): when a vault exists it is the canonical identity
    # root — read the seed from it, never the OS keychain. Existing no-vault
    # behavior is unchanged.
    if VAULT_PATH.exists():
        return _vault_load_kem_seed()

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


def cmd_keygen(argv: list[str] | None = None) -> None:
    """Generate ML-KEM-768 keypair. Private -> Encrypted File/Keystore. Public -> disk.

    An existing keypair is NEVER silently overwritten: pass --force to rotate
    (the previous private key + public key are backed up beside the live files
    with a UTC timestamp suffix first). Rotating without re-packing makes every
    existing bundle undecryptable — that is why this guard exists.
    """
    argv = argv or []
    force = "--force" in argv or "-f" in argv
    _ensure_config_dir()

    if PRIVATE_KEY_ENC_PATH.exists() or PUBKEY_PATH.exists():
        if not force:
            print(
                "ERROR: a keypair already exists in this config dir; refusing to overwrite.\n"
                "  Rotating the keypair makes all existing bundles undecryptable.\n"
                "  To rotate deliberately: pqc_secrets.py keygen --force\n"
                "  (previous key material is backed up with a timestamp suffix).",
                file=sys.stderr,
            )
            sys.exit(1)
        stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        for src in (PRIVATE_KEY_ENC_PATH, PUBKEY_PATH):
            if src.exists():
                dst = src.with_name(f"{src.name}.rotated-{stamp}")
                src.rename(dst)
                print(f"Backed up previous key material: {dst}")

    pk, sk = _kem_keygen()

    # Store private key using cross-platform helper
    _store_private_key(sk)

    # Write public key to disk
    pk_hex = pk.hex()
    PUBKEY_PATH.write_text(pk_hex)
    PUBKEY_PATH.chmod(0o600)

    print("ML-KEM-768 keypair generated.")
    print(f"  Private key: Securely stored (account={KEYCHAIN_ACCOUNT})")
    print(f"  Public key:  {PUBKEY_PATH}")

# ---------------------------------------------------------------------------
# gen — SOTA secret generation (Aug 2026)
#
# Design basis (see SKILL.md "Secret generation policy"):
# - Randomness: stdlib `secrets` module -> OS CSPRNG (getrandom(2) on Linux,
#   BCryptGenRandom on Windows, SecRandomCopyBytes on macOS). Never `random`.
# - Entropy floor: 256 bits (NIST SP 800-63B-4 tolerates far less for online
#   secrets; we target 512-bit default for long-term machine secrets).
# - Uniformity: secrets.choice / token_* use rejection sampling internally —
#   no modulo bias. Wordlist mode never assumes a power-of-two list size.
# - Passphrases: EFF large wordlist (7,776 words, 12.925 bits/word), pinned
#   by SHA-256 and verified at load; refuse to generate from a tampered list.
# - Hygiene: secret bytes go to stdout ONLY; all metadata to stderr. The
#   value is never echoed, logged, or written to disk by this command.
# ---------------------------------------------------------------------------
GEN_WORDLIST_NAME = "eff_large_wordlist.txt"
GEN_WORDLIST_SHA256 = "addd35536511597a02fa0a9ff1e5284677b8883b83e986e43f15a3db996b903e"
GEN_WORDLIST_WORDS = 7776  # 6^5; log2 = 12.924812503605781 bits/word
GEN_DEFAULT_BITS = 512
GEN_MIN_BITS = 256
GEN_MAX_BITS = 8192
GEN_DEFAULT_WORDS = 8
GEN_MIN_WORDS = 6
GEN_MAX_WORDS = 64

_GEN_WORDLIST_CACHE: list[str] | None = None


def _gen_load_wordlist() -> list[str]:
    """Load the EFF large wordlist next to this script, verifying integrity.

    The list is pinned by SHA-256. Any mismatch, wrong length, duplicate
    word, or malformed TSV is a hard error — never generate from a wordlist
    whose contents cannot be proven authentic.
    """
    global _GEN_WORDLIST_CACHE
    if _GEN_WORDLIST_CACHE is not None:
        return _GEN_WORDLIST_CACHE
    path = Path(__file__).resolve().parent / GEN_WORDLIST_NAME
    if not path.exists():
        print(f"ERROR: wordlist missing: {path}", file=sys.stderr)
        sys.exit(1)
    raw = path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != GEN_WORDLIST_SHA256:
        print(
            f"ERROR: wordlist integrity check failed ({path})\n"
            f"  expected sha256 {GEN_WORDLIST_SHA256}\n"
            f"  actual   sha256 {digest}\n"
            "Refusing to generate secrets from an unverified wordlist.",
            file=sys.stderr,
        )
        sys.exit(1)
    words = []
    for line in raw.decode("utf-8").splitlines():
        parts = line.split("\t")
        if len(parts) != 2 or not parts[1]:
            print(f"ERROR: malformed wordlist line: {line!r}", file=sys.stderr)
            sys.exit(1)
        words.append(parts[1])
    if len(words) != GEN_WORDLIST_WORDS or len(set(words)) != len(words):
        print(
            f"ERROR: wordlist shape invalid ({len(words)} entries, "
            f"{len(words) - len(set(words))} duplicates)",
            file=sys.stderr,
        )
        sys.exit(1)
    _GEN_WORDLIST_CACHE = words
    return words


def _gen_usage() -> str:
    return (
        "Usage: pqc_secrets.py gen [--bits N | --bytes N] [--format b64|hex|b85]\n"
        "                          [--words N] [--sep S] [--count N] [--env NAME]\n"
        "                          [--quiet] [--allow-weak]\n"
        "  default: 512-bit, base64url, 1 secret; secret to stdout, metadata to stderr\n"
        "  --bits N    target entropy in bits (256..8192); rounded up to whole bytes\n"
        "  --bytes N   raw random bytes (implies 8*N bits)\n"
        "  --format    b64 = base64url (default, shell/URL/JSON-safe), hex, b85 (RFC1924)\n"
        "  --words N   diceware mode: N words from pinned EFF large list (~12.925 bits/word)\n"
        "  --sep S     word separator (default '-')\n"
        "  --count N   emit N independent secrets, one per line (1..64)\n"
        "  --env NAME  emit 'NAME=<secret>' lines (KEY naming: WTF_*, AINISHCODER_*, ...)\n"
        "  --allow-weak accept below-floor entropy (<256 bits or <6 words); avoid"
    )


def cmd_gen(argv: list[str]) -> None:
    """Generate high-entropy secrets from the OS CSPRNG; stdout = secrets only."""
    bits: int | None = None
    nbytes: int | None = None
    fmt = "b64"
    words: int | None = None
    sep = "-"
    count = 1
    env_name: str | None = None
    quiet = False
    allow_weak = False

    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("-h", "--help"):
            print(_gen_usage())
            return
        def _int_flag(flag: str, cur: int | None) -> int:
            nonlocal i
            i += 1
            if i >= len(argv):
                print(f"ERROR: {flag} requires an integer", file=sys.stderr)
                sys.exit(1)
            try:
                return int(argv[i])
            except ValueError:
                print(f"ERROR: {flag} requires an integer, got {argv[i]!r}", file=sys.stderr)
                sys.exit(1)
        if a == "--bits":
            bits = _int_flag(a, bits)
        elif a == "--bytes":
            nbytes = _int_flag(a, nbytes)
        elif a == "--words":
            words = _int_flag(a, words)
        elif a == "--count":
            count = _int_flag(a, count)
        elif a == "--sep":
            i += 1
            if i >= len(argv):
                print("ERROR: --sep requires a value", file=sys.stderr)
                sys.exit(1)
            sep = argv[i]
        elif a == "--format":
            i += 1
            if i >= len(argv) or argv[i] not in ("b64", "hex", "b85"):
                print("ERROR: --format must be b64, hex, or b85", file=sys.stderr)
                sys.exit(1)
            fmt = argv[i]
        elif a == "--env":
            i += 1
            if i >= len(argv):
                print("ERROR: --env requires a NAME", file=sys.stderr)
                sys.exit(1)
            env_name = argv[i]
        elif a == "--quiet":
            quiet = True
        elif a == "--allow-weak":
            allow_weak = True
        else:
            print(f"ERROR: unknown gen flag: {a}", file=sys.stderr)
            print(_gen_usage(), file=sys.stderr)
            sys.exit(1)
        i += 1

    if count < 1 or count > 64:
        print("ERROR: --count must be 1..64", file=sys.stderr)
        sys.exit(1)
    if env_name is not None and not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", env_name):
        print(f"ERROR: --env NAME must be a valid identifier: {env_name!r}", file=sys.stderr)
        sys.exit(1)

    if words is not None:
        # Diceware mode
        if not (1 <= words <= GEN_MAX_WORDS):
            print(f"ERROR: --words must be 1..{GEN_MAX_WORDS}", file=sys.stderr)
            sys.exit(1)
        wl = _gen_load_wordlist()
        per_word = math.log2(len(wl))
        total_bits = words * per_word
        if words < GEN_MIN_WORDS and not allow_weak:
            print(
                f"ERROR: {words} words = {total_bits:.1f} bits, below the "
                f"{GEN_MIN_WORDS}-word floor; pass --allow-weak to override",
                file=sys.stderr,
            )
            sys.exit(1)
        secrets_out = [
            sep.join(secrets.choice(wl) for _ in range(words)) for _ in range(count)
        ]
        mode_desc = f"diceware {words}x EFF-large ({total_bits:.1f} bits; {per_word:.3f} bits/word)"
        secret_bits = total_bits
    else:
        # Byte-string mode (default)
        if nbytes is not None:
            if nbytes < 1 or nbytes > GEN_MAX_BITS // 8:
                print(f"ERROR: --bytes must be 1..{GEN_MAX_BITS // 8}", file=sys.stderr)
                sys.exit(1)
            n = nbytes
        elif bits is not None:
            if bits < 1 or bits > GEN_MAX_BITS:
                print(f"ERROR: --bits must be 1..{GEN_MAX_BITS}", file=sys.stderr)
                sys.exit(1)
            n = (bits + 7) // 8
        else:
            n = GEN_DEFAULT_BITS // 8
        secret_bits = 8 * n
        if secret_bits < GEN_MIN_BITS and not allow_weak:
            print(
                f"ERROR: {secret_bits} bits below {GEN_MIN_BITS}-bit floor; "
                "pass --allow-weak to override",
                file=sys.stderr,
            )
            sys.exit(1)
        raws = [secrets.token_bytes(n) for _ in range(count)]
        if fmt == "hex":
            secrets_out = [r.hex() for r in raws]
        elif fmt == "b85":
            secrets_out = [base64.b85encode(r).decode("ascii") for r in raws]
        else:
            secrets_out = [base64.urlsafe_b64encode(r).rstrip(b"=").decode("ascii") for r in raws]
        mode_desc = f"{n} random bytes ({secret_bits} bits), format {fmt}"

    if not quiet:
        wl_note = "; wordlist sha256 pinned+verified" if words is not None else ""
        print(
            f"gen: {mode_desc}{wl_note}; chars="
            + ",".join(str(len(s)) for s in secrets_out)
            + "; source=OS CSPRNG (stdlib secrets)",
            file=sys.stderr,
        )
        print(
            "gen: value printed to stdout ONLY — do not log, screenshot, or echo it",
            file=sys.stderr,
        )
    for s in secrets_out:
        print(f"{env_name}={s}" if env_name else s)


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


def _backup_bundle() -> Path | None:
    """Copy the current bundle alongside itself before a rewrite (mode 0600)."""
    if not BUNDLE_PATH.exists():
        return None
    keep = BUNDLE_PATH.with_name(BUNDLE_PATH.name + f".bak.{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}")
    shutil.copy2(BUNDLE_PATH, keep)
    keep.chmod(0o600)
    return keep


def _encrypt_entries_to_bundle(entries: dict[str, str]) -> Path | None:
    """Encrypt entries (AES-256-GCM payload, ML-KEM-768 keywrap) and write the bundle atomically.

    The previous bundle is backed up before the atomic replace, so a failed or
    interrupted write can never leave the store without a readable bundle.
    """
    pk = _load_public_key()

    # Generate random data key (32 bytes)
    data_key = os.urandom(32)

    # Encrypt payload with data key
    data_nonce = os.urandom(12)
    payload_plaintext = json.dumps({"secrets": entries}, sort_keys=True).encode("utf-8")
    data_ciphertext = AESGCM(data_key).encrypt(data_nonce, payload_plaintext, b"pqc-secrets:v1:data")

    # ML-KEM encapsulation
    shared_secret, ciphertext_kem = _kem_encapsulate(pk)

    # Derive KEK from shared secret
    kek = hashlib.sha3_256(shared_secret + KDF_INFO).digest()

    # Wrap data key with KEK
    keywrap_nonce = os.urandom(12)
    keywrap_ciphertext = AESGCM(kek).encrypt(keywrap_nonce, data_key, b"pqc-secrets:v1:keywrap")

    bundle = {
        "version": 1,
        "alg": "ML-KEM-768",
        "engine": "py-native-mlkem",
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

    backup = _backup_bundle()
    BUNDLE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = BUNDLE_PATH.with_name(BUNDLE_PATH.name + f".tmp.{os.getpid()}")
    tmp_path.write_text(json.dumps(bundle, indent=2, sort_keys=True), encoding="utf-8")
    tmp_path.chmod(0o600)
    os.replace(tmp_path, BUNDLE_PATH)
    print(f"Secrets packed: {len(entries)} keys -> {BUNDLE_PATH}")
    if backup is not None:
        print(f"Backup: {backup}")
    return backup


def _reject_quoted_values(quoted: list[str], command: str) -> None:
    if not quoted:
        return
    print(
        "ERROR: refused to store shell-quoted value(s) for: "
        + ", ".join(sorted(quoted))
        + "\n"
        "  These values arrived wrapped in single quotes (KEY='value'); storing\n"
        "  them as-is would keep the quote characters literally — this caused\n"
        "  the 2026-08-30 incident where packed values contained stray quotes.\n"
        "  Strip the shell quotes first and pass plain KEY=value input:\n"
        f"    printf 'KEY=value\\n' | pqc-secrets {command}",
        file=sys.stderr,
    )
    sys.exit(1)


def _parse_key_value_input(text: str) -> tuple[dict[str, str], list[str]]:
    """Parse KEY=VALUE lines; returns (entries, shell_quoted_names)."""
    entries: dict[str, str] = {}
    quoted: list[str] = []
    for line in text.split("\n"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value.startswith("'") and value.endswith("'"):
            quoted.append(key)
        entries[key] = value
    return entries, quoted


def _warn_expansion_chars(entries: dict[str, str]) -> None:
    expansion = sorted(name for name, value in entries.items() if "$" in value or "`" in value)
    if not expansion:
        return
    print(
        "WARNING: value(s) for "
        + ", ".join(expansion)
        + " contain '$' or '`'; stored literally. On export they are\n"
        "  single-quoted, so eval will NOT expand them (that is the safe default) —\n"
        "  re-check these values if shell expansion was intended.",
        file=sys.stderr,
    )


def cmd_pack(argv: list[str] | None = None) -> None:
    """Read KEY=VALUE lines from stdin, encrypt via AES-256-GCM + ML-KEM-768.

    `--merge` preserves keys already in the bundle and overwrites only the
    names supplied on stdin (the upsert-safe mode); the default replaces the
    whole bundle. Input hygiene (2026-08-30): shell-quoted values are refused.
    """
    argv = list(argv or [])
    merge = "--merge" in argv
    argv = [arg for arg in argv if arg != "--merge"]
    if argv:
        print(f"ERROR: unknown pack option(s): {' '.join(argv)}", file=sys.stderr)
        sys.exit(3)
    _ensure_config_dir()

    lines = sys.stdin.read().strip()
    if not lines:
        print("ERROR: No input provided on stdin.", file=sys.stderr)
        sys.exit(1)

    entries, shell_quoted = _parse_key_value_input(lines)
    if not entries:
        print("ERROR: No valid KEY=VALUE pairs found in input.", file=sys.stderr)
        sys.exit(1)
    _reject_quoted_values(shell_quoted, "pack")
    _warn_expansion_chars(entries)

    if merge and BUNDLE_PATH.exists():
        entries = {**_read_entries(), **entries}

    _encrypt_entries_to_bundle(entries)


def cmd_set(argv: list[str] | None = None) -> None:
    """Upsert one or more secrets without disturbing the rest of the bundle.

    Forms:
      pqc-secrets set NAME=VALUE [NAME2=VALUE2 ...]
      pqc-secrets set NAME VALUE
      printf 'NAME=VALUE\\n' | pqc-secrets set --stdin

    This is the reusable-key path: run it once per key, from any platform, and
    the store keeps every other key untouched.
    """
    argv = list(argv or [])
    quiet = "--quiet" in argv
    argv = [arg for arg in argv if arg != "--quiet"]

    entries: dict[str, str] = {}
    if argv == ["--stdin"]:
        entries, _quoted_from_stdin = _parse_key_value_input(sys.stdin.read())
    elif len(argv) == 2 and "=" not in argv[0]:
        entries[argv[0].strip()] = argv[1]
    elif argv and all("=" in arg for arg in argv):
        for pair in argv:
            key, _, value = pair.partition("=")
            entries[key.strip()] = value
    else:
        print(
            "Usage: pqc-secrets set NAME=VALUE [NAME2=VALUE2 ...]\n"
            "       pqc-secrets set NAME VALUE\n"
            "       printf 'NAME=VALUE\\n' | pqc-secrets set --stdin",
            file=sys.stderr,
        )
        sys.exit(3)

    _reject_quoted_values(
        [name for name, value in entries.items() if len(value) >= 2 and value.startswith("'") and value.endswith("'")],
        "set",
    )
    invalid = sorted(name for name in entries if not _ENV_NAME_RE.match(name))
    if invalid:
        print(f"ERROR: invalid key name(s): {', '.join(invalid)} (must match ^[A-Z0-9_]+$)", file=sys.stderr)
        sys.exit(1)
    empty = sorted(name for name in entries if not entries[name])
    if empty:
        print(f"ERROR: empty value(s) for: {', '.join(empty)}", file=sys.stderr)
        sys.exit(1)

    _ensure_config_dir()
    if BUNDLE_PATH.exists():
        existing = _read_entries()
    else:
        existing = {}
    added = sum(1 for name in entries if name not in existing)
    updated = len(entries) - added
    merged = {**existing, **entries}
    backup = _encrypt_entries_to_bundle(merged)
    if not quiet:
        print(
            f"Set {len(entries)} key(s) ({added} added, {updated} updated); "
            f"{len(merged)} total in {BUNDLE_PATH}"
            + (f" (backup: {backup})" if backup else "")
        )


def cmd_del(argv: list[str] | None = None) -> None:
    """Delete one or more secret names, preserving every other entry.

    Idempotent: names that are already absent are reported, not treated as an
    error. Values are never printed.
    """
    names = [name.strip() for name in list(argv or []) if name.strip()]
    if not names:
        print("Usage: pqc-secrets del NAME [NAME2 ...]", file=sys.stderr)
        sys.exit(3)
    invalid = sorted(name for name in names if not _ENV_NAME_RE.match(name))
    if invalid:
        print(f"ERROR: invalid key name(s): {', '.join(invalid)} (must match ^[A-Z0-9_]+$)", file=sys.stderr)
        sys.exit(1)
    if not BUNDLE_PATH.exists():
        print(_NO_BUNDLE_MSG, file=sys.stderr)
        sys.exit(1)

    entries = _read_entries()
    removed = [name for name in names if name in entries]
    missing = [name for name in names if name not in entries]
    if removed:
        for name in removed:
            del entries[name]
        backup = _encrypt_entries_to_bundle(entries)
        print(f"Deleted {len(removed)} key(s): {', '.join(removed)}; {len(entries)} total" + (f" (backup: {backup})" if backup else ""))
    else:
        print(f"Nothing to delete: {', '.join(missing)} not present in {BUNDLE_PATH}")
    if missing and removed:
        print(f"Not present (skipped): {', '.join(missing)}", file=sys.stderr)


def _decrypt_bundle(bundle: dict, sk: bytes) -> dict[str, str]:
    """Decrypt a bundle, handling both legacy (hex) and Rust-engine (b64+keywrap) formats."""
    # Decapsulate DEK from KEM ciphertext
    kem = bundle["kem"]
    if "ciphertext_b64" in kem:
        ciphertext_kem = base64.b64decode(kem["ciphertext_b64"])
    else:
        ciphertext_kem = bytes.fromhex(kem["ciphertext"])
    dek = _kem_decapsulate(sk, ciphertext_kem)

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


def _shell_quote(value: str) -> str:
    """Quote a value for POSIX shell so eval is safe for ANY value.

    Matches the Rust engine's shell_quote(): single-quote the whole value
    and replace every embedded ' with '\'' (close, escaped quote, reopen).
    Survives quotes, spaces, $, backticks, and embedded newlines —
    single-quoted strings in shell may span lines.
    """
    return "'" + value.replace("'", "'\\''") + "'"


def cmd_export(argv: list[str] | None = None) -> None:
    """Decrypt bundle and output shell export lines (values shell-quoted).

    `--json` emits `{"secrets": {NAME: VALUE}}` for tooling; values are still
    only written to stdout (same exposure as the shell form).
    """
    as_json = "--json" in list(argv or [])
    if not BUNDLE_PATH.exists():
        print(_NO_BUNDLE_MSG, file=sys.stderr)
        sys.exit(1)

    sk = _load_private_key()
    bundle = json.loads(BUNDLE_PATH.read_text())
    payload = _decrypt_bundle(bundle, sk)

    # Rust engine wraps secrets in {"secrets": {...}}; legacy packs directly
    entries = payload.get("secrets", payload) if isinstance(payload, dict) and "secrets" in payload else payload

    if as_json:
        print(json.dumps({"secrets": entries}, indent=2, sort_keys=True))
        return
    for key, value in entries.items():
        print(f"export {key}={_shell_quote(value)}")


def cmd_verify() -> None:
    """Verify bundle can be decrypted; list key names only."""
    if not BUNDLE_PATH.exists():
        print(_NO_BUNDLE_MSG, file=sys.stderr)
        sys.exit(1)

    sk = _load_private_key()
    bundle = json.loads(BUNDLE_PATH.read_text())
    payload = _decrypt_bundle(bundle, sk)

    entries = payload.get("secrets", payload) if isinstance(payload, dict) and "secrets" in payload else payload

    print(f"Bundle valid: {len(entries)} keys")
    for key in sorted(entries.keys()):
        print(f"  {key}")


_ENV_NAME_RE = re.compile(r"^[A-Z0-9_]+$")

_NO_BUNDLE_MSG = (
    f"ERROR: No secrets bundle at {BUNDLE_PATH}.\n"
    "Fresh machine? First run:  pqc-secrets keygen\n"
    "Then add keys:             pqc-secrets set LOCALROUTER_ZAI_API_KEY=...\n"
    "Inspect names (no values): pqc-secrets list"
)


def _read_entries() -> dict[str, str]:
    """Decrypt the bundle and normalize its secrets mapping."""
    sk = _load_private_key()
    bundle = json.loads(BUNDLE_PATH.read_text())
    payload = _decrypt_bundle(bundle, sk)
    entries = payload.get("secrets", payload) if isinstance(payload, dict) and "secrets" in payload else payload
    if not isinstance(entries, dict):
        print("ERROR: bundle payload is not a name/value mapping.", file=sys.stderr)
        sys.exit(1)
    return {str(k): str(v) for k, v in entries.items()}


def cmd_list(argv: list[str] | None = None) -> None:
    """List secret names only (never values) — the inspection surface for what
    is set, what belongs to which tool prefix, and what needs renaming.

    `--json` emits {bundle, count, names} for tooling.
    """
    as_json = "--json" in list(argv or [])
    if not BUNDLE_PATH.exists():
        print(_NO_BUNDLE_MSG, file=sys.stderr)
        sys.exit(1)
    entries = _read_entries()
    names = sorted(entries.keys())
    if as_json:
        print(json.dumps({"bundle": str(BUNDLE_PATH), "count": len(names), "names": names}, indent=2, sort_keys=True))
        return
    print(f"{len(names)} secret name(s) in {BUNDLE_PATH}:")
    for name in names:
        print(f"  {name}")


def _other_store_candidates() -> list[dict]:
    """Every other store this platform could have used, with what it holds.

    Divergence visibility (2026-11-08): `store` used to report only the winner.
    When a second store exists — the WSL<->Windows pair is the common case — an
    operator needs to see it, because a key written to the loser looks like it
    vanished. Each entry is name-of-store plus a key COUNT only; no values are
    read out and none are printed.
    """
    seen = {str(CONFIG_DIR)}
    out: list[dict] = []
    local = Path.home() / ".config" / "pqc-secrets"
    candidates: list[Path] = []
    if _is_wsl():
        host = _wsl_windows_store()
        if host is not None:
            candidates.append(host)
        candidates.append(local)
    elif os.name == "nt":
        candidates.append(local)
        wsl = _windows_wsl_store()
        if wsl is not None:
            candidates.append(wsl)
    else:
        candidates.append(local)

    for path in candidates:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        has_bundle = _store_has_bundle(path)
        out.append({
            "store": key,
            "bundleExists": has_bundle,
            # A foreign-identity store cannot be decrypted here, so it honestly
            # reports 0 rather than a number it did not verify.
            "keyCount": _store_key_count(path) if has_bundle else 0,
            "usable": _store_key_count(path) > 0 if has_bundle else False,
        })
    return out


def cmd_store(argv: list[str] | None = None) -> None:
    """Report which store this process resolves — the cross-platform anchor.

    Answers "am I reading the same bundle as the other shell/OS?" `--json` for
    tooling. Also reports any OTHER store on this machine and whether it holds
    keys, so a split between environments is visible instead of silent.
    """
    as_json = "--json" in list(argv or [])
    bundle_exists = BUNDLE_PATH.exists()
    names: list[str] = []
    read_error: str | None = None
    if bundle_exists:
        try:
            names = sorted(_read_entries().keys())
        except SystemExit:
            raise
        except Exception as exc:  # corrupt bundle must not break `store`
            read_error = str(exc)
    others = _other_store_candidates()
    # A second store that exists but cannot be read is the exact shape of the
    # WSL/Windows split: name it explicitly so nobody has to infer it.
    shadowed = [o for o in others if o["bundleExists"] and not o["usable"]]
    payload = {
        "store": str(CONFIG_DIR),
        "source": STORE_SOURCE,
        "platform": "wsl" if _is_wsl() else sys.platform,
        "bundle": str(BUNDLE_PATH),
        "bundleExists": bundle_exists,
        "keys": names,
        "keyCount": len(names),
        "isolated": os.environ.get("PQC_STORE_ISOLATED") == "1",
        "explicitEnv": bool(os.environ.get("PQC_CONFIG_DIR") or os.environ.get("PQC_SECRETS_DIR")),
        "otherStores": others,
    }
    # Present only when something is worth the operator's attention.
    if shadowed:
        payload["shadowedStores"] = shadowed
    if read_error:
        payload["readError"] = read_error
    if as_json:
        print(json.dumps(payload, indent=2, sort_keys=True))
        return
    print(f"store:      {payload['store']}")
    print(f"source:     {payload['source']}")
    print(f"platform:   {payload['platform']}")
    print(f"bundle:     {payload['bundle']} ({'present' if bundle_exists else 'missing'})")
    print(f"keys:       {len(names) if not read_error else 'unreadable'}")
    if names:
        print(f"names:      {', '.join(names)}")
    # Divergence is the operator-facing half of this command: a second store on
    # this machine that holds keys looks to the user like "my keys vanished"
    # when the CLI writes there, so name it and say which one won.
    if others:
        print("also found: ")
        for other in others:
            if other["bundleExists"]:
                state = (
                    f"{other['keyCount']} key(s), not selected"
                    if other["usable"]
                    else "present but unreadable here (different identity)"
                )
                print(f"            {other['store']}  —  {state}")
            else:
                print(f"            {other['store']}  —  no bundle")
        if shadowed:
            print(
                "            ^ this machine has more than one store. A key written with "
                "'pqc-secrets pack' goes to the one above; copy it with "
                "'pqc-secrets sync' if the other is the one you meant."
            )
    print(
        "hint:       explicit PQC_CONFIG_DIR/PQC_SECRETS_DIR wins; "
        "PQC_STORE_ISOLATED=1 keeps per-environment stores"
    )


def cmd_rename(old_name: str, new_name: str) -> None:
    """Rename one secret NAME in the bundle (value preserved, never printed).

    The existing bundle is backed up alongside itself before rewriting.
    """
    if not BUNDLE_PATH.exists():
        print(_NO_BUNDLE_MSG, file=sys.stderr)
        sys.exit(1)
    if not _ENV_NAME_RE.match(old_name) or not _ENV_NAME_RE.match(new_name):
        print("ERROR: names must match ^[A-Z0-9_]+$ (environment variable names).", file=sys.stderr)
        sys.exit(1)
    if old_name == new_name:
        print(f"Nothing to do: OLD and NEW are the same ({old_name}).")
        return

    entries = _read_entries()
    if old_name not in entries:
        print(f"ERROR: '{old_name}' not found in bundle.", file=sys.stderr)
        sys.exit(1)
    if new_name in entries:
        print(f"ERROR: '{new_name}' already exists — refusing to overwrite.", file=sys.stderr)
        sys.exit(1)

    backup = BUNDLE_PATH.with_name(
        BUNDLE_PATH.name + f".bak.{__import__('datetime').datetime.now(__import__('datetime').UTC).strftime('%Y%m%dT%H%M%SZ')}"
    )
    backup.write_text(BUNDLE_PATH.read_text())
    backup.chmod(0o600)

    entries[new_name] = entries.pop(old_name)
    _encrypt_entries_to_bundle(entries)
    print(f"Renamed {old_name} -> {new_name} (backup: {backup})")


class _ConfigDirScope:
    """Temporarily re-point the module-level store paths at another config dir.

    `sync` reads one store and writes others; every helper in this module
    resolves paths from these globals at call time, so swapping them under a
    context manager is the smallest safe override. Globals are always restored
    on exit, including on exceptions.
    """

    _PATH_GLOBALS = (
        "CONFIG_DIR", "PUBKEY_PATH", "BUNDLE_PATH",
        "PRIVATE_KEY_ENC_PATH", "KEK_PATH", "VAULT_PATH",
    )

    def __init__(self, config_dir: Path) -> None:
        self._dir = config_dir
        self._saved: dict = {}

    def __enter__(self) -> "_ConfigDirScope":
        g = globals()
        self._saved = {name: g[name] for name in self._PATH_GLOBALS}
        g["CONFIG_DIR"] = self._dir
        g["PUBKEY_PATH"] = self._dir / "recipient.pub"
        g["BUNDLE_PATH"] = self._dir / "secrets.bundle.json"
        g["PRIVATE_KEY_ENC_PATH"] = self._dir / "private.key.enc"
        g["KEK_PATH"] = self._dir / "machine.kek"
        g["VAULT_PATH"] = self._dir / "vault.pqc"
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        g = globals()
        for name, value in self._saved.items():
            g[name] = value


def _shell_unquote(field: str) -> str:
    """Exact inverse of _shell_quote for our own export format.

    Accepts the single-quoted field produced by _shell_quote ('...') and
    reverses the '\'' escape. Refuses anything else — sync never guesses.
    """
    if len(field) >= 2 and field.startswith("'") and field.endswith("'"):
        inner = field[1:-1]
        if "\\'" not in inner.replace("'\\''", ""):
            return inner.replace("'\\''", "'")
    raise ValueError("value is not in pqc-secrets export quoting format")


_EXPORT_LINE_RE = re.compile(r"^export ([A-Z0-9_]+)=('(?:[^']|'\\'')*')$")


def _parse_export_lines(text: str) -> dict[str, str]:
    """Parse `export KEY='value'` lines (our own export format) into a mapping."""
    entries: dict[str, str] = {}
    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue
        match = _EXPORT_LINE_RE.match(line)
        if not match:
            print(
                "ERROR: stdin is not in pqc-secrets export format "
                "(expected: export KEY='value'). Refusing to guess.",
                file=sys.stderr,
            )
            sys.exit(1)
        entries[match.group(1)] = _shell_unquote(match.group(2))
    if not entries:
        print("ERROR: no export lines found on stdin.", file=sys.stderr)
        sys.exit(1)
    return entries


def cmd_sync(argv: list[str]) -> None:
    """Re-pack one store's secrets into other stores' bundles, per-identity.

    Cross-machine flow — WSL <-> Windows mounted dirs, second Linux store:

        pqc-secrets sync --from ~/.config/pqc-secrets \\
            --to /mnt/c/Users/<you>/.config/pqc-secrets

    Remote machines (macOS / Linux over ssh) — values cross exactly once,
    transport-encrypted, packed at the destination, never written to disk
    in transit:

        pqc-secrets sync --from ~/.config/pqc-secrets --stdout \\
            | ssh host 'pqc-secrets sync --stdin --to ~/.config/pqc-secrets'

    Semantics:
    - Each target bundle is re-encrypted under ITS OWN store identity
      (the recipient.pub in the target dir). No private key material ever
      crosses stores or the network.
    - Merge: target-only secrets are preserved; source wins on name
      collisions. Existing target bundles are backed up alongside
      themselves (mode 0600) before rewrite.
    - Values are never printed and never touch disk in plaintext.
    """
    source_dir: Path | None = None
    targets: list[Path] = []
    from_stdin = False
    to_stdout = False
    dry_run = False
    force = False

    it = iter(argv)
    for arg in it:
        if arg == "--from":
            source_dir = Path(next(it, ""))
        elif arg == "--to":
            targets.append(Path(next(it, "")))
        elif arg == "--stdin":
            from_stdin = True
        elif arg == "--stdout":
            to_stdout = True
        elif arg == "--dry-run":
            dry_run = True
        elif arg == "--force":
            force = True
        else:
            print(f"ERROR: unknown sync argument: {arg}", file=sys.stderr)
            print(_SYNC_USAGE, file=sys.stderr)
            sys.exit(1)

    if from_stdin and source_dir is not None:
        print("ERROR: --stdin and --from are mutually exclusive.", file=sys.stderr)
        sys.exit(1)
    if to_stdout and targets:
        print("ERROR: --stdout and --to are mutually exclusive.", file=sys.stderr)
        sys.exit(1)

    # ---- Source phase: resolve entries in memory, never printed ----------
    if from_stdin:
        entries = _parse_export_lines(sys.stdin.read())
        source_label = "stdin"
    else:
        source = source_dir if source_dir is not None else CONFIG_DIR
        if not source.exists():
            print(f"ERROR: source store dir does not exist: {source}", file=sys.stderr)
            sys.exit(1)
        with _ConfigDirScope(source):
            if not BUNDLE_PATH.exists():
                print(
                    f"ERROR: No secrets bundle at {BUNDLE_PATH}.\n"
                    "Fresh store? First run:  pqc-secrets keygen\n"
                    "Then add keys:           printf 'K=V\\n' | pqc-secrets pack",
                    file=sys.stderr,
                )
                sys.exit(1)
            entries = _read_entries()
        source_label = str(source)

    # ---- --stdout lane: emit export-format lines for a remote pipe -------
    if to_stdout:
        for key in sorted(entries):
            print(f"export {key}={_shell_quote(entries[key])}")
        return

    if not targets:
        print(_SYNC_USAGE, file=sys.stderr)
        sys.exit(1)

    # ---- Target phase: merge + re-encrypt per target identity ------------
    if dry_run:
        print(f"sync (dry-run): {len(entries)} key(s) from {source_label}")
    for target in targets:
        if source_label != "stdin" and target.resolve() == Path(source_label).resolve():
            print(f"sync: skipping {target} (source and target are the same store)")
            continue
        if not target.exists():
            print(f"sync: target store dir does not exist: {target} — skipped "
                  "(run 'pqc-secrets keygen' there first)", file=sys.stderr)
            continue

        with _ConfigDirScope(target):
            if not PUBKEY_PATH.exists():
                print(f"sync: no recipient.pub in {target} — skipped "
                      "(run 'pqc-secrets keygen' there first)", file=sys.stderr)
                continue

            existing: dict[str, str] = {}
            readable = BUNDLE_PATH.exists()
            if readable:
                try:
                    existing = _read_entries()
                except SystemExit:
                    raise
                except Exception as err:
                    readable = False
                    if not force:
                        print(
                            f"sync: existing bundle in {target} is not readable "
                            f"under this store's identity ({err}); skipped. "
                            "Re-run with --force to replace it (backup kept).",
                            file=sys.stderr,
                        )
                        continue

            merged = dict(existing)
            added = sorted(set(entries) - set(existing))
            updated = sorted(set(entries) & set(existing))
            for key, value in entries.items():
                merged[key] = value

            if dry_run:
                print(f"sync (dry-run) -> {target}: {len(merged)} key(s) would be "
                      f"packed (added {len(added)}, updated {len(updated)}, "
                      f"kept {len(existing) - len(updated)})")
                for key in added:
                    print(f"  + {key}")
                for key in updated:
                    print(f"  ~ {key}")
                continue

            backup = None
            if BUNDLE_PATH.exists():
                backup = BUNDLE_PATH.with_name(
                    BUNDLE_PATH.name + f".bak.{__import__('datetime').datetime.now(__import__('datetime').UTC).strftime('%Y%m%dT%H%M%SZ')}"
                )
                backup.write_text(BUNDLE_PATH.read_text())
                backup.chmod(0o600)

            _encrypt_entries_to_bundle(merged)
            detail = (
                f"added {len(added)}, updated {len(updated)}, "
                f"kept {len(existing) - len(updated)}"
                + ("" if readable else " [replaced unreadable bundle]")
            )
            print(f"synced {len(merged)} key(s) -> {target} ({detail})")
            if backup is not None:
                print(f"  backup: {backup}")
    print(f"sync: {len(entries)} key(s) from {source_label} processed")


_SYNC_USAGE = (
    "Usage: pqc_secrets.py sync (--from <DIR> | --stdin) [--to <DIR>]... "
    "[--stdout] [--dry-run] [--force]\n"
    "  --from <DIR>   source store dir (default: ambient PQC_CONFIG_DIR / ~/.config/pqc-secrets)\n"
    "  --stdin        read source entries as export-format lines from stdin\n"
    "  --to <DIR>     target store dir (repeatable); re-packed under the target's own identity\n"
    "  --stdout       emit export-format lines (for an ssh pipe) instead of packing\n"
    "  --dry-run      print the per-target plan (names only) without writing\n"
    "  --force        replace a target bundle that is unreadable under the target identity\n"
    "Values never touch disk in plaintext and are never printed."
)

ENGINE_NAME = "py-native-mlkem"
ENGINE_BUILD_DATE = "2026-10-29"
ENGINE_COMMANDS = "keygen gen pack set del export verify list rename sync store migrate setup version"
BUNDLE_SCHEMA = "v1 (ML-KEM-768 keywrap + AES-256-GCM data, aad)"


def cmd_version() -> None:
    """Print engine identity and coverage — the standalone 'is this current?' probe."""
    print(f"pqc-secrets engine: {ENGINE_NAME} (canonical python)")
    print(f"build date:         {ENGINE_BUILD_DATE}")
    print("crypto:             ML-KEM-768 (FIPS 203, seed-form private key) + AES-256-GCM")
    print(f"bundle schema:      {BUNDLE_SCHEMA}")
    print(f"commands:           {ENGINE_COMMANDS}")
    print("darwin rust binary: legacy v1.0.0 fast-path (keygen/pack/export only)")


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


USAGE_LINE = "Usage: pqc_secrets.py <keygen|gen|pack|set|del|export|verify|list|rename|sync|store|migrate|version>"
NAMING_LINE = "Naming:  always prefix keys with the consuming tool's name - LOCALROUTER_*_API_KEY, AINISHCODER_*_API_KEY, ..."


def main() -> None:
    if len(sys.argv) < 2:
        print(USAGE_LINE, file=sys.stderr)
        print(NAMING_LINE, file=sys.stderr)
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "keygen":
        cmd_keygen(sys.argv[2:])
    elif cmd == "gen":
        cmd_gen(sys.argv[2:])
    elif cmd == "pack":
        cmd_pack(sys.argv[2:])
    elif cmd == "set":
        cmd_set(sys.argv[2:])
    elif cmd == "del":
        cmd_del(sys.argv[2:])
    elif cmd == "export":
        cmd_export(sys.argv[2:])
    elif cmd == "verify":
        cmd_verify()
    elif cmd == "list":
        cmd_list(sys.argv[2:])
    elif cmd == "store":
        cmd_store(sys.argv[2:])
    elif cmd == "rename":
        if len(sys.argv) != 4:
            print("Usage: pqc_secrets.py rename <OLD_NAME> <NEW_NAME>", file=sys.stderr)
            sys.exit(1)
        cmd_rename(sys.argv[2], sys.argv[3])
    elif cmd == "sync":
        cmd_sync(sys.argv[2:])
    elif cmd == "migrate":
        cmd_migrate()
    elif cmd == "version":
        cmd_version()
    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        print(USAGE_LINE, file=sys.stderr)
        print(NAMING_LINE, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
