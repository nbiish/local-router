#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "cryptography>=47.0",
#     "kyber-py>=0.2.0",
# ]
# ///
"""
Reusable-key upsert tests for `pqc_secrets.py set` / `pack --merge` (2026-10-29).

Fully sandboxed: every engine run points PQC_CONFIG_DIR at a throwaway temp dir
with PQC_USE_KEYCHAIN=false, so the live store is never touched.

Covers:
- set creates a bundle, merges (existing keys preserved), and updates values
- set forms: NAME=VALUE, NAME VALUE, --stdin
- set rejects shell-quoted values, invalid names, and empty values
- pack --merge merges; default pack replaces
- backups are written and no temp files are left behind
- list --json / export --json / store --json shapes
- PQC_SECRETS_DIR is honored as the contract alias

Run:  uv run --script .agents/skills/pqc-secrets/tests/test_set_upsert.py
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
SKILL_DIR = TESTS_DIR.parent
ENGINE_PATH = SKILL_DIR / "scripts" / "pqc_secrets.py"


def engine(args: list[str], config_dir: Path, stdin: str | None = None, env_overrides: dict | None = None) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["PQC_USE_KEYCHAIN"] = "false"
    env.pop("PQC_SECRETS_DIR", None)
    env["PQC_CONFIG_DIR"] = str(config_dir)
    if env_overrides:
        env.update(env_overrides)
    return subprocess.run(
        [sys.executable, str(ENGINE_PATH), *args],
        input=stdin,
        capture_output=True,
        text=True,
        env=env,
    )


class SetTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        r = engine(["keygen"], self.dir)
        self.assertEqual(r.returncode, 0, r.stderr)

    def tearDown(self):
        self._tmp.cleanup()

    def export(self) -> dict[str, str]:
        r = engine(["export", "--json"], self.dir)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)["secrets"]

    def test_set_creates_merges_and_updates(self):
        r = engine(["set", "A_KEY=one"], self.dir)
        self.assertEqual(r.returncode, 0, r.stderr)
        r = engine(["set", "B_KEY=two"], self.dir)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.export(), {"A_KEY": "one", "B_KEY": "two"})

        r = engine(["set", "A_KEY=updated"], self.dir)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("1 updated", r.stdout)
        self.assertEqual(self.export(), {"A_KEY": "updated", "B_KEY": "two"})

    def test_set_positional_and_stdin_forms(self):
        r = engine(["set", "SPACE_KEY", "value with spaces"], self.dir)
        self.assertEqual(r.returncode, 0, r.stderr)
        r = engine(["set", "--stdin"], self.dir, stdin="STDIN_A=1\nSTDIN_B=2\n")
        self.assertEqual(r.returncode, 0, r.stderr)
        exported = self.export()
        self.assertEqual(exported["SPACE_KEY"], "value with spaces")
        self.assertEqual(exported["STDIN_A"], "1")
        self.assertEqual(exported["STDIN_B"], "2")

    def test_set_rejects_bad_input(self):
        r = engine(["set", "QUOTED_KEY='wrapped'"], self.dir)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("refused", r.stderr)

        r = engine(["set", "bad-name=value"], self.dir)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("invalid key name", r.stderr)

        r = engine(["set", "EMPTY="], self.dir)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("empty value", r.stderr)

    def test_pack_merge_preserves_and_default_replaces(self):
        engine(["set", "A_KEY=one", "B_KEY=two"], self.dir)

        r = engine(["pack", "--merge"], self.dir, stdin="A_KEY=updated\nC_KEY=three\n")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.export(), {"A_KEY": "updated", "B_KEY": "two", "C_KEY": "three"})

        r = engine(["pack"], self.dir, stdin="ONLY_KEY=only\n")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.export(), {"ONLY_KEY": "only"})

    def test_backup_written_and_no_temp_left(self):
        engine(["set", "A_KEY=one"], self.dir)
        self.assertEqual(list(self.dir.glob("secrets.bundle.json.bak.*")), [])
        engine(["set", "A_KEY=two"], self.dir)
        backups = list(self.dir.glob("secrets.bundle.json.bak.*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(list(self.dir.glob("secrets.bundle.json.tmp.*")), [])

    def test_delete_preserves_the_rest_and_is_idempotent(self):
        engine(["set", "A_KEY=1", "B_KEY=2", "C_KEY=3"], self.dir)
        r = engine(["del", "B_KEY"], self.dir)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.export(), {"A_KEY": "1", "C_KEY": "3"})
        r = engine(["del", "B_KEY"], self.dir)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("Nothing to delete", r.stdout)

    def test_list_and_store_json(self):
        engine(["set", "Z_KEY=z", "A_KEY=a"], self.dir)
        names = json.loads(engine(["list", "--json"], self.dir).stdout)
        self.assertEqual(names["count"], 2)
        self.assertEqual(names["names"], ["A_KEY", "Z_KEY"])
        self.assertNotIn("z", json.dumps(names["names"]))

        store = json.loads(engine(["store", "--json"], self.dir).stdout)
        self.assertEqual(store["source"], "env")
        self.assertEqual(store["bundleExists"], True)
        self.assertEqual(store["keyCount"], 2)
        self.assertTrue(store["store"].endswith(str(self.dir)))

    def test_pqc_secrets_dir_alias(self):
        env = dict(os.environ)
        env.pop("PQC_CONFIG_DIR", None)
        env["PQC_SECRETS_DIR"] = str(self.dir)
        env["PQC_USE_KEYCHAIN"] = "false"
        r = subprocess.run(
            [sys.executable, str(ENGINE_PATH), "set", "ALIAS_KEY=via_alias"],
            capture_output=True,
            text=True,
            env=env,
        )
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.export(), {"ALIAS_KEY": "via_alias"})


if __name__ == "__main__":
    unittest.main()
