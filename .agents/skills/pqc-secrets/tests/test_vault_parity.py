#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "cryptography>=45.0",
#     "argon2-cffi==25.1.0",
# ]
# ///
"""
Vault parity tests (Phase 1): the Python engine must unwrap a Rust-created
vault.pqc identity and decapsulate a bundle keychain-free.

Flow exercised end-to-end, fully sandboxed:
  1. rust  vault init                          (throwaway PQC_CONFIG_DIR)
  2. rust  vault export-identity --pub-out     (pack-compatible recipient.pub)
  3. py    pack                                (against the vault's public key)
  4. py    export                              (vault-first identity, NO keychain)
  5. eval in bash -> values roundtrip verbatim

Incident-mandate sandbox: per-test env sandbox (setUp applies it,
tearDown restores the exact prior values) + subprocess-only engine
invocations via `uv run --script` — the production invocation, so the
engine's PEP 723 deps resolve regardless of which interpreter runs the
tests (never in-process against the live store); the sandbox keychain
account pqc-secrets-vtest-vault is passed via subprocess env ONLY and never
exported into any shell. PQC_VAULT_TEST_KDF_LIGHT=1 keeps the Argon2id
parameters light for tests ONLY (recorded per-vault in the header; production
defaults are untouched). Never logs key material — fingerprints/synthetic
values only.

Run:  uv run --script .agents/skills/pqc-secrets/tests/test_vault_parity.py
  or  python3 -m unittest discover -s .agents/skills/pqc-secrets/tests
      (from the repo root; sandbox is scoped per-test so sibling test
      modules cannot clobber it under discover)
"""

import atexit
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
SKILL_DIR = TESTS_DIR.parent
ENGINE_PATH = SKILL_DIR / "scripts" / "pqc_secrets.py"
# tests/ -> pqc-secrets -> skills -> .agents -> REPO ROOT
REPO_ROOT = TESTS_DIR.parents[3]
RUST_BIN = REPO_ROOT / "bin" / "pqc-secrets.darwin-arm64"

SANDBOX_KEYCHAIN_ACCOUNT = "pqc-secrets-vtest-vault"
SANDBOX_PASSPHRASE = "synthetic-vtest-passphrase"

# Synthetic values only — no real secret material anywhere in this file.
ROUNDTRIP_VALUES = {
    "VTEST_VAULT_API_KEY": "vault-parity-dummy-123",
    "VTEST_VAULT_QUOTED": "it's a 'vault' $value `here`",
}
STDIN_LINES = "\n".join(f"{k}={v}" for k, v in ROUNDTRIP_VALUES.items())

# Sandbox fixture lives at module scope but is NEVER applied to os.environ at
# import time: under `unittest discover` whichever sibling module imports
# later would clobber the other. Tests activate it per-test (setUp) and
# restore the exact prior values (tearDown).
# History: incident 2026-08-30 ~14:38 UTC — an in-process engine import
# before the sandbox resolved the engine to the LIVE config dir. The current
# design is stricter: this module never imports the engine in-process at all;
# every engine run is a `uv run --script` subprocess.
_TMP_DIR = tempfile.mkdtemp(prefix="pqc-vtest-vault-")
SANDBOX_ENV = {
    "PQC_CONFIG_DIR": _TMP_DIR,
    "PQC_USE_KEYCHAIN": "false",
    "PQC_KEYCHAIN_ACCOUNT": SANDBOX_KEYCHAIN_ACCOUNT,
    "PQC_VAULT_PASSPHRASE": SANDBOX_PASSPHRASE,
    "PQC_VAULT_TEST_KDF_LIGHT": "1",
}
atexit.register(shutil.rmtree, _TMP_DIR, ignore_errors=True)

_SANDBOX_ACTIVE = False
_SAVED_ENV: dict[str, str | None] | None = None


def activate_sandbox() -> None:
    """Apply the sandbox into os.environ, saving prior values for restore."""
    global _SANDBOX_ACTIVE, _SAVED_ENV
    _SAVED_ENV = {name: os.environ.get(name) for name in SANDBOX_ENV}
    os.environ.update(SANDBOX_ENV)
    _SANDBOX_ACTIVE = True


def deactivate_sandbox() -> None:
    """Restore the exact pre-activation os.environ values."""
    global _SANDBOX_ACTIVE, _SAVED_ENV
    if _SAVED_ENV is not None:
        for name, val in _SAVED_ENV.items():
            if val is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = val
    _SAVED_ENV = None
    _SANDBOX_ACTIVE = False


def _sandbox_guard() -> None:
    """Hard stop: never invoke the engine unless the sandbox is provably active."""
    if not _SANDBOX_ACTIVE or os.environ.get("PQC_CONFIG_DIR") != _TMP_DIR:
        raise AssertionError(
            "sandbox env not active — refusing to invoke the engine "
            "(would risk resolving the LIVE ~/.config/pqc-secrets)"
        )


class SandboxedTestCase(unittest.TestCase):
    """Per-test sandbox: activate in setUp, restore prior env in tearDown."""

    def setUp(self):
        activate_sandbox()
        _sandbox_guard()

    def tearDown(self):
        deactivate_sandbox()


def _engine_env(**overrides: str) -> dict[str, str]:
    env = dict(os.environ)
    env.update(SANDBOX_ENV)
    env.update(overrides)
    return env


def _run_engine(*args: str, stdin: str | None = None, **env_overrides: str) -> subprocess.CompletedProcess[str]:
    _sandbox_guard()
    return subprocess.run(
        # Production invocation: `uv run --script` resolves the engine's own
        # PEP 723 dependency metadata regardless of the runner's interpreter.
        ["uv", "run", "--script", str(ENGINE_PATH), *args],
        input=stdin,
        capture_output=True,
        text=True,
        env=_engine_env(**env_overrides),
        timeout=240,
    )


def _run_rust(*args: str, stdin: str | None = None, **env_overrides: str) -> subprocess.CompletedProcess[str]:
    _sandbox_guard()
    env = dict(os.environ)
    env.update(SANDBOX_ENV)
    env.update(env_overrides)
    return subprocess.run(
        [str(RUST_BIN), *args],
        input=stdin,
        capture_output=True,
        text=True,
        env=env,
        timeout=180,
    )


def _eval_export_in_bash(export_stdout: str, keys: list[str]) -> list[str]:
    """eval the export output in a real bash and read the values back."""
    bash_script = (
        'eval "$PQC_EXPORT_OUTPUT"\n'
        'for k in "$@"; do printf \'%s\\036\' "${!k}"; done\n'
    )
    result = subprocess.run(
        ["/bin/bash", "-c", bash_script, "bash", *keys],
        capture_output=True,
        text=True,
        env={**os.environ, "PQC_EXPORT_OUTPUT": export_stdout},
        timeout=60,
    )
    if result.returncode != 0:
        raise AssertionError(f"bash eval failed: {result.stderr}")
    return result.stdout.split("\x1e")[:-1]


class VaultSetup:
    """One-time sandboxed vault fixture shared by all tests."""

    ready = False

    @classmethod
    def ensure(cls):
        if cls.ready:
            return
        _sandbox_guard()
        init = _run_rust("vault", "init")
        assert init.returncode == 0, f"rust vault init failed: {init.stderr}"
        pub_out = Path(_TMP_DIR) / "recipient.pub"
        export_identity = _run_rust("vault", "export-identity", "--pub-out", str(pub_out))
        assert export_identity.returncode == 0, f"vault export-identity failed: {export_identity.stderr}"
        assert pub_out.is_file(), "vault export-identity must write the public key file"
        parsed_pub = __import__("json").loads(pub_out.read_text())
        assert "public_key_b64" in parsed_pub, "pub file must be the engine-JSON format"
        # Pack the bundle once so every test is order-independent: the fixture
        # is exactly the documented vault workflow (vault init → export-identity
        # → pack against it → export via the vault, keychain-free).
        packed = subprocess.run(
            ["uv", "run", "--script", str(ENGINE_PATH), "pack"],
            input=STDIN_LINES + "\n",
            capture_output=True,
            text=True,
            env=_engine_env(),
            timeout=240,
        )
        assert packed.returncode == 0, f"sandbox pack failed: {packed.stderr}"
        cls.ready = True


@unittest.skipUnless(
    sys.platform == "darwin" and platform.machine() == "arm64" and RUST_BIN.is_file(),
    "darwin/arm64 + staged Rust binary required",
)
class VaultParityExport(SandboxedTestCase):
    """Python export must decapsulate via the vault identity, keychain-free."""

    def test_py_export_via_vault_roundtrip(self):
        VaultSetup.ensure()
        exported = _run_engine("export")
        self.assertEqual(exported.returncode, 0, exported.stderr)
        got = _eval_export_in_bash(exported.stdout, sorted(ROUNDTRIP_VALUES))
        for key, expected in ROUNDTRIP_VALUES.items():
            self.assertEqual(
                got[sorted(ROUNDTRIP_VALUES).index(key)],
                expected,
                msg=f"{key}: vault-parity export value differs",
            )

    def test_py_export_fails_closed_on_wrong_passphrase(self):
        VaultSetup.ensure()
        exported = _run_engine("export", PQC_VAULT_PASSPHRASE="definitely-wrong-passphrase")
        self.assertNotEqual(exported.returncode, 0, "wrong passphrase must fail closed")
        self.assertIn("unwrap failed", exported.stderr)

    def test_no_keychain_access_needed_for_vault_export(self):
        """With a vault present, a bogus keychain account name must not matter."""
        VaultSetup.ensure()
        exported = _run_engine("export", PQC_KEYCHAIN_ACCOUNT="pqc-secrets-vtest-unused")
        self.assertEqual(exported.returncode, 0, exported.stderr)
        self.assertIn("VTEST_VAULT_API_KEY", exported.stdout)

    def test_rust_and_py_status_show_vault(self):
        VaultSetup.ensure()
        status = _run_rust("vault", "status")
        self.assertEqual(status.returncode, 0, status.stderr)
        self.assertIn("vault:", status.stdout)
        self.assertIn("kem-fp:", status.stdout)
        # Fingerprints only — never key material.
        for line in status.stdout.splitlines():
            if "fp:" in line:
                self.assertIn("sha3:", line)


class VaultFileShape(SandboxedTestCase):
    """Structural checks on the vault file itself (no key material asserted)."""

    def test_vault_file_is_0600_json_with_expected_keys(self):
        VaultSetup.ensure()
        vault_path = Path(_TMP_DIR) / "vault.pqc"
        self.assertTrue(vault_path.is_file())
        mode = vault_path.stat().st_mode & 0o777
        self.assertEqual(mode, 0o600, "vault.pqc must be 0600")
        header = __import__("json").loads(vault_path.read_text())
        self.assertEqual(header["version"], 1)
        self.assertEqual(header["alg"], "ML-KEM-768")
        self.assertEqual(header["sig_alg"], "ML-DSA-65")
        self.assertEqual(header["kdf"]["name"], "argon2id")
        self.assertIn("salt_b64", header["kdf"])
        self.assertIn("kem_seed", header)
        self.assertIn("dsa_seed", header)
        self.assertIn("dsa_pub_b64", header["identity"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
