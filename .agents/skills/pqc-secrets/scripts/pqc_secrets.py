#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "cryptography>=45.0",
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
  export   Decrypt bundle, output shell 'export KEY=VALUE' lines to stdout
  verify   Check bundle integrity, list key names (no values)
  list     List secret names only (no values) — inspect what is set / needs renaming
  rename   Rename one secret NAME (value preserved); previous bundle backed up first
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
import math
import os
import platform
import re
import secrets
import subprocess
import sys
import time
import uuid
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import mlkem as _native_mlkem
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

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

CONFIG_DIR = Path(os.environ.get("PQC_CONFIG_DIR") or (Path.home() / ".config" / "pqc-secrets"))
PUBKEY_PATH = CONFIG_DIR / "recipient.pub"
BUNDLE_PATH = CONFIG_DIR / "secrets.bundle.json"
PRIVATE_KEY_ENC_PATH = CONFIG_DIR / "private.key.enc"
KEK_PATH = CONFIG_DIR / "machine.kek"
KEYCHAIN_SERVICE = "pqc-secrets"
KEYCHAIN_ACCOUNT = os.environ.get("PQC_KEYCHAIN_ACCOUNT", "pqc-secrets-key")
KDF_INFO = b"pqc-secrets:v1:kek"


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


def _encrypt_entries_to_bundle(entries: dict[str, str]) -> None:
    """Encrypt entries (AES-256-GCM payload, ML-KEM-768 keywrap) and write the bundle."""
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

    BUNDLE_PATH.write_text(json.dumps(bundle, indent=2, sort_keys=True))
    BUNDLE_PATH.chmod(0o600)
    print(f"Secrets packed: {len(entries)} keys -> {BUNDLE_PATH}")


def cmd_pack() -> None:
    """Read KEY=VALUE lines from stdin, encrypt via AES-256-GCM + ML-KEM-768.

    Produces a Rust-compatible bundle with keywrap layer and AAD.
    """
    _ensure_config_dir()

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

    _encrypt_entries_to_bundle(entries)


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


def cmd_export() -> None:
    """Decrypt bundle and output shell export lines."""
    if not BUNDLE_PATH.exists():
        print(_NO_BUNDLE_MSG, file=sys.stderr)
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
    "Then add keys:             printf 'K=V\\n' | pqc-secrets pack\n"
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


def cmd_list() -> None:
    """List secret names only (never values) — the inspection surface for what
    is set, what belongs to which tool prefix, and what needs renaming."""
    if not BUNDLE_PATH.exists():
        print(_NO_BUNDLE_MSG, file=sys.stderr)
        sys.exit(1)
    entries = _read_entries()
    names = sorted(entries.keys())
    print(f"{len(names)} secret name(s) in {BUNDLE_PATH}:")
    for name in names:
        print(f"  {name}")


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


ENGINE_NAME = "py-native-mlkem"
ENGINE_BUILD_DATE = "2026-08-29"
ENGINE_COMMANDS = "keygen gen pack export verify list rename migrate setup version"
BUNDLE_SCHEMA = "v1 (ML-KEM-768 keywrap + AES-256-GCM data, aad)"


def cmd_version() -> None:
    """Print engine identity and coverage — the standalone 'is this current?' probe."""
    print(f"pqc-secrets engine: {ENGINE_NAME} (canonical python)")
    print(f"build date:         {ENGINE_BUILD_DATE}")
    print(f"crypto:             ML-KEM-768 (FIPS 203, seed-form private key) + AES-256-GCM")
    print(f"bundle schema:      {BUNDLE_SCHEMA}")
    print(f"commands:           {ENGINE_COMMANDS}")
    print(f"darwin rust binary: legacy v1.0.0 fast-path (keygen/pack/export only)")


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


USAGE_LINE = "Usage: pqc_secrets.py <keygen|gen|pack|export|verify|list|rename|migrate|version>"
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
        cmd_pack()
    elif cmd == "export":
        cmd_export()
    elif cmd == "verify":
        cmd_verify()
    elif cmd == "list":
        cmd_list()
    elif cmd == "rename":
        if len(sys.argv) != 4:
            print("Usage: pqc_secrets.py rename <OLD_NAME> <NEW_NAME>", file=sys.stderr)
            sys.exit(1)
        cmd_rename(sys.argv[2], sys.argv[3])
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
