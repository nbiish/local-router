#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "cryptography>=45.0",
#     "kyber-py>=0.2.0",
# ]
# ///
"""
Cross-machine sync tests for `pqc_secrets.py sync` (v1.3.0).

Fully sandboxed: every engine run uses throwaway PQC_CONFIG_DIR temp dirs
with the encrypted-file store (PQC_USE_KEYCHAIN=false), so the live bundle
at ~/.config/pqc-secrets and any keychain/vault are never touched.

Covers:
- pack -> sync --from/--to -> target decapsulates under its own identity
- merge semantics: target-only keys preserved, source wins on collisions
- --dry-run writes nothing
- foreign-identity target bundle is skipped without --force, replaced
  (with backup) with --force
- --stdout / --stdin lane roundtrip (the remote ssh shape)

Run:  uv run --script .agents/skills/pqc-secrets/tests/test_sync.py
  or  python3 -m unittest discover -s .agents/skills/pqc-secrets/tests
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
SKILL_DIR = TESTS_DIR.parent
ENGINE_PATH = SKILL_DIR / "scripts" / "pqc_secrets.py"

SANDBOX_ENV = {
    "PQC_USE_KEYCHAIN": "false",
}


def engine(args: list[str], config_dir: Path, stdin: str | None = None) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env.update(SANDBOX_ENV)
    env["PQC_CONFIG_DIR"] = str(config_dir)
    return subprocess.run(
        [sys.executable, str(ENGINE_PATH), *args],
        input=stdin,
        capture_output=True,
        text=True,
        env=env,
    )


def new_store() -> tempfile.TemporaryDirectory:
    td = tempfile.TemporaryDirectory()
    d = Path(td.name)
    r = engine(["keygen"], d)
    assert r.returncode == 0, r.stderr
    return td


class SyncTests(unittest.TestCase):
    def setUp(self):
        self._tmpdirs = []

    def tearDown(self):
        for td in self._tmpdirs:
            td.cleanup()

    def store(self) -> Path:
        td = new_store()
        self._tmpdirs.append(td)
        return Path(td.name)

    def test_sync_repacks_under_target_identity(self):
        a, b = self.store(), self.store()
        r = engine(["pack"], a, stdin="LOCALROUTER_ZAI_API_KEY=v1\nLOCALROUTER_MODAL_API_KEY=v2\n")
        self.assertEqual(r.returncode, 0, r.stderr)

        r = engine(["sync", "--from", str(a), "--to", str(b)], a)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("synced 2 key(s)", r.stdout)

        # Target store reads its own bundle under its own identity.
        r = engine(["list"], b)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("LOCALROUTER_ZAI_API_KEY", r.stdout)
        self.assertIn("LOCALROUTER_MODAL_API_KEY", r.stdout)

        # The bundles differ on disk (different identities), same plaintext.
        a_bundle = json.loads((a / "secrets.bundle.json").read_text())
        b_bundle = json.loads((b / "secrets.bundle.json").read_text())
        self.assertNotEqual(
            a_bundle["kem"]["ciphertext_b64"], b_bundle["kem"]["ciphertext_b64"]
        )

    def test_merge_preserves_target_only_keys_and_source_wins(self):
        a, b = self.store(), self.store()
        engine(["pack"], a, stdin="SHARED_KEY=from_a\nA_ONLY=v\n")
        engine(["pack"], b, stdin="SHARED_KEY=from_b\nB_ONLY=v\n")

        r = engine(["sync", "--from", str(a), "--to", str(b)], a)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("added 1, updated 1, kept 1", r.stdout)

        names = engine(["list"], b).stdout
        for name in ("SHARED_KEY", "A_ONLY", "B_ONLY"):
            self.assertIn(name, names)

        # Source wins: SHARED_KEY must now export with the source value.
        out = engine(["export"], b)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("export SHARED_KEY='from_a'", out.stdout)

    def test_dry_run_writes_nothing(self):
        a, b = self.store(), self.store()
        engine(["pack"], a, stdin="K=v\n")

        before = (b / "secrets.bundle.json").exists()
        r = engine(["sync", "--from", str(a), "--to", str(b), "--dry-run"], a)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("(dry-run)", r.stdout)
        self.assertIn("+ K", r.stdout)
        self.assertEqual((b / "secrets.bundle.json").exists(), before)

    def test_foreign_identity_skipped_then_force_replaces_with_backup(self):
        a, b = self.store(), self.store()
        engine(["pack"], a, stdin="K=v\n")
        # Clobber b's bundle with a's (foreign kem ciphertext).
        shutil.copy(a / "secrets.bundle.json", b / "secrets.bundle.json")

        r = engine(["sync", "--from", str(a), "--to", str(b)], a)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("not readable", r.stderr)
        self.assertIn("skipped", r.stderr)

        r = engine(["sync", "--from", str(a), "--to", str(b), "--force"], a)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("replaced unreadable bundle", r.stdout)
        backups = list(b.glob("secrets.bundle.json.bak.*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(engine(["list"], b).returncode, 0)

    def test_stdout_stdin_lane_roundtrip(self):
        a, b = self.store(), self.store()
        engine(["pack"], a, stdin="K=v\n")

        out = engine(["sync", "--from", str(a), "--stdout"], a)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertTrue(out.stdout.startswith("export K='v'"))

        r = engine(["sync", "--stdin", "--to", str(b)], a, stdin=out.stdout)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("synced 1 key(s)", r.stdout)
        self.assertIn("K", engine(["list"], b).stdout)

    def test_mutually_exclusive_flags_rejected(self):
        a = self.store()
        r = engine(["sync", "--from", str(a), "--stdin"], a)
        self.assertNotEqual(r.returncode, 0)
        r = engine(["sync", "--from", str(a), "--stdout", "--to", str(a)], a)
        self.assertNotEqual(r.returncode, 0)


if __name__ == "__main__":
    unittest.main()
