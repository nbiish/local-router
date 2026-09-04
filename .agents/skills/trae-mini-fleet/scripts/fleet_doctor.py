#!/usr/bin/env python3
"""
fleet_doctor.py - preflight validator for the trae-mini fleet.

Verifies, before any dispatch burns engine steps:
  1. trae-cli binary resolvable (optional sha256 pin)
  2. mini binary resolvable (optional sha256 pin)
  3. loopback proxy 127.0.0.1:11434 health (any HTTP answer = daemon up)
  4. Ollama backend 127.0.0.1:11435 reachable (warn-only)
  5. scrub_task.py present in the fleet skill
  6. cwd is a dedicated git worktree, not main (unless --skip-worktree)

Exit 0 = all critical checks pass; 1 = at least one critical failure.
Secrets policy: never reads or prints key material; the proxy probe uses the
public dummy bearer token (`local-router`) only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

PROXY_DEFAULT = "http://127.0.0.1:11434"
BACKEND_DEFAULT = "http://127.0.0.1:11435"
SCRUB_RELATIVE = Path(".agents/skills/trae-mini-fleet/scripts/scrub_task.py")
TIMEOUT_S = 6


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check_binary(name: str, expect: str | None, pin: str | None) -> dict:
    """Locate a fleet binary; optionally enforce a path expectation + sha pin."""
    resolved = expect if expect else shutil.which(name)
    found = bool(resolved) and Path(resolved).is_file()
    result = {
        "check": f"binary:{name}", "critical": True, "ok": found,
        "path": resolved or None, "sha256": None,
    }
    if found:
        result["sha256"] = sha256_of(Path(resolved))
        if pin and result["sha256"] != pin:
            result["ok"] = False
            result["detail"] = f"sha256 mismatch (expected {pin[:12]}...)"
    elif expect:
        result["detail"] = f"expected binary not found at {expect}"
    else:
        result["detail"] = f"'{name}' not on PATH"
    return result


def check_http(url: str, critical: bool, label: str) -> dict:
    """Probe an HTTP endpoint; any HTTP response counts as up (401/403 fine).

    SSRF guard (CWE-918): only plain-http loopback endpoints may be probed;
    the fleet proxy and Ollama backend are loopback services by definition.
    """
    match = re.match(r"^http://([^/:?#]+)(?::(\d+))?", url.strip().lower())
    host = match.group(1) if match else None
    if host not in ("127.0.0.1", "localhost", "::1", "[::1]"):
        return {"check": label, "critical": critical, "ok": False,
                "detail": f"non-loopback probe refused: {url}"}
    req = urllib.request.Request(
        url, headers={"Authorization": "Bearer local-router"},
    )
    try:
        # Loopback-http only, enforced above (SSRF guard).
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:  # nosec B310 - loopback-http only
            detail = f"HTTP {resp.status}"
        ok = True
    except urllib.error.HTTPError as exc:
        detail, ok = f"HTTP {exc.code} (daemon up)", True
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        detail, ok = f"unreachable: {exc}", False
    return {"check": label, "critical": critical, "ok": ok, "detail": detail}


def check_scrub(root: Path) -> dict:
    scrub = root / SCRUB_RELATIVE
    ok = scrub.is_file()
    return {
        "check": "scrub_task.py", "critical": True, "ok": ok,
        "path": str(scrub), "detail": None if ok else "scrub tool not found",
    }


def check_worktree(root: Path) -> dict:
    """cwd must be a linked worktree on a non-main branch."""
    try:
        wt = subprocess.run(
            ["git", "-C", str(root), "worktree", "list", "--porcelain"],
            capture_output=True, text=True, timeout=15, check=False, shell=False,
        )
        branch = subprocess.run(
            ["git", "-C", str(root), "branch", "--show-current"],
            capture_output=True, text=True, timeout=15, check=False, shell=False,
        )
    except (subprocess.SubprocessError, OSError) as exc:
        return {"check": "worktree", "critical": True, "ok": False,
                "detail": f"git failed: {exc}"}
    root_resolved = str(root.resolve())
    entries, entry = [], {}
    for line in wt.stdout.splitlines():
        if line.startswith("worktree "):
            entry = {"path": line.split(" ", 1)[1]}
        elif line.startswith("bare") and entry:
            entry["bare"] = True
        elif not line and entry:
            entries.append(entry)
            entry = {}
    if entry:
        entries.append(entry)
    is_linked = any(
        e.get("path") == root_resolved and not e.get("bare") for e in entries
    )
    is_main_repo = bool(entries) and entries[0].get("path") == root_resolved
    branch_name = branch.stdout.strip()
    ok = is_linked and not is_main_repo and branch_name not in ("", "main")
    detail = None
    if is_main_repo:
        detail = "cwd is the main repo, not a linked worktree"
    elif not is_linked:
        detail = "cwd is not a git worktree"
    elif branch_name == "main":
        detail = "worktree is on branch main"
    return {"check": "worktree", "critical": True, "ok": ok,
            "branch": branch_name, "detail": detail}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="fleet_doctor.py",
                                description="trae-mini fleet preflight validator")
    p.add_argument("--json", action="store_true", help="machine-readable output")
    p.add_argument("--skip-worktree", action="store_true",
                   help="skip the worktree check (doctor-only runs)")
    p.add_argument("--proxy", default=PROXY_DEFAULT)
    p.add_argument("--expect-trae", default=None,
                   help="explicit trae-cli path (default: PATH lookup)")
    p.add_argument("--expect-mini", default=None,
                   help="explicit mini path (default: PATH lookup)")
    p.add_argument("--pin-trae", default=None, help="expected trae-cli sha256")
    p.add_argument("--pin-mini", default=None, help="expected mini sha256")
    args = p.parse_args(argv)

    root = Path.cwd()
    results = [
        check_binary("trae-cli", args.expect_trae, args.pin_trae),
        check_binary("mini", args.expect_mini, args.pin_mini),
        check_http(f"{args.proxy.rstrip('/')}/v1/models", True, f"proxy:{args.proxy}"),
        check_http(BACKEND_DEFAULT, False, "backend:11435 (ollama, warn-only)"),
        check_scrub(root),
    ]
    if not args.skip_worktree:
        results.append(check_worktree(root))

    critical_ok = all(r["ok"] for r in results if r["critical"])
    summary = {"ok": critical_ok, "checks": results}
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        for r in results:
            mark = "PASS" if r["ok"] else ("WARN" if not r["critical"] else "FAIL")
            line = f"[{mark}] {r['check']}"
            if r.get("detail"):
                line += f" - {r['detail']}"
            if r.get("sha256"):
                line += f" ({r['sha256'][:12]})"
            print(line)
        print(f"fleet doctor: {'GO' if critical_ok else 'NO-GO'}")
    return 0 if critical_ok else 1


if __name__ == "__main__":
    sys.exit(main())
