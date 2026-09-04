#!/usr/bin/env python3
"""
fleet_dispatch.py - dispatch wrapper for trae-cli / mini with normalized exit
codes, JSON receipts, scope conformance, plugin gates, and fail-closed scrub.

Turns the fleet's narrative circuit-breaker matrix into machine behavior:

    0   OK                      engine succeeded, scope clean, gates green
    20  STEP-EXHAUSTED          engine failed with no changed files -> handoff
    30  PROBE-LOOP              mini trajectory shows >=3 identical probes -> handoff
    40  ENGINE_OR_GATES_FAILED  engine failed with edits, or a --gate failed
    50  SCOPE_VIOLATION         edits outside the --scope allowlist
    60  PREFLIGHT_FAILED        binary/worktree/task-file checks failed
    70  SCRUB_FAILED            privacy scrub could not complete (fail-closed)
    124 TIMEOUT                 dispatch exceeded --timeout

A JSON receipt (schema fleet.receipt/v1) is written to --output on every run
that reaches the engine stage. Receipts are the dispatch's COMMS evidence.

Secrets policy: no shell, fixed argument vectors, timeout on every subprocess,
engine stdout/stderr captured but never echoed wholesale (length + tail only).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path

CODE_MEANING = {
    0: "OK",
    20: "STEP-EXHAUSTED (no productive edits; hand off to sibling engine)",
    30: "PROBE-LOOP (>=3 identical probes; hand off to sibling engine)",
    40: "ENGINE_OR_GATES_FAILED",
    50: "SCOPE_VIOLATION",
    60: "PREFLIGHT_FAILED",
    70: "SCRUB_FAILED (artifacts retained for manual scrubbing)",
    124: "TIMEOUT",
}
SCRUB_RELATIVE = Path(".agents/skills/trae-mini-fleet/scripts/scrub_task.py")
GATE_TIMEOUT_S = 600


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(worktree: Path, *args: str, timeout: int = 30) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(worktree), *args],
        capture_output=True, text=True, timeout=timeout, check=False, shell=False,
    )


def preflight(args: argparse.Namespace) -> tuple[str | None, dict]:
    """Resolve binary, validate worktree; returns (bin_path, info)."""
    bin_path = args.bin or shutil.which(
        "trae-cli" if args.engine == "trae" else "mini"
    )
    if not bin_path or not Path(bin_path).is_file():
        return None, {"detail": f"engine binary '{args.engine}' not found"}

    wt_list = git(args.worktree, "worktree", "list", "--porcelain")
    if wt_list.returncode != 0:
        return None, {"detail": f"not a git repo: {args.worktree}"}
    root_resolved = str(args.worktree.resolve())
    first_wt = next(
        (line.split(" ", 1)[1] for line in wt_list.stdout.splitlines()
         if line.startswith("worktree ")),
        None,
    )
    is_main = first_wt == root_resolved  # first porcelain entry is the main repo
    branch = git(args.worktree, "branch", "--show-current").stdout.strip()
    if not args.allow_main and (branch in ("", "main") or is_main):
        return None, {"detail": f"refusing dispatch on branch '{branch or '?'}' "
                                "(dedicated worktree required)"}
    if not Path(args.task_file).is_file():
        return None, {"detail": f"task file missing: {args.task_file}"}
    return bin_path, {"branch": branch}


def engine_command(args: argparse.Namespace, bin_path: str) -> list[str]:
    """Fixed-argument, non-interactive engine invocation (no shell)."""
    if args.engine == "trae":
        return [
            bin_path, "run", "-f", str(args.task_file),
            "--console-type", "simple",
            "--patch-path", str(args.patch_path),
            "--max-steps", str(args.max_steps),
        ]
    task_text = Path(args.task_file).read_text(encoding="utf-8")
    return [
        bin_path, "--task", task_text,
        "--output", str(args.trajectory),
        "--yolo", "--exit-immediately",
    ]


def changed_files(worktree: Path) -> list[str]:
    """Tracked modifications + untracked files relative to the worktree."""
    proc = git(worktree, "status", "--porcelain")
    files = []
    for line in proc.stdout.splitlines():
        if len(line) < 4:
            continue
        path = line[3:].strip().strip('"')
        if path:
            files.append(path)
    return sorted(set(files))


def detect_probe_loop(trajectory: Path, threshold: int = 3) -> bool:
    """Scan a mini trajectory for >=threshold identical consecutive messages."""
    if not trajectory.is_file():
        return False
    try:
        data = json.loads(trajectory.read_text(encoding="utf-8", errors="replace"))
    except json.JSONDecodeError:
        return False
    messages = data.get("messages") if isinstance(data, dict) else data
    if not isinstance(messages, list):
        return False
    streak, last = 1, None
    for item in messages:
        if isinstance(item, dict):
            content = item.get("content")
        else:
            content = item
        if content is None:
            continue
        key = json.dumps(content, sort_keys=True)
        streak = streak + 1 if key == last else 1
        last = key
        if streak >= threshold:
            return True
    return False


def run_gates(args: argparse.Namespace) -> list[dict]:
    gates = []
    for cmd in args.gate or []:
        try:
            argv = shlex.split(cmd)
            proc = subprocess.run(
                argv, capture_output=True, text=True,
                timeout=GATE_TIMEOUT_S, check=False, shell=False,
                cwd=str(args.worktree),
            )
            gates.append({"cmd": cmd, "code": proc.returncode,
                          "tail": (proc.stdout + proc.stderr)[-400:]})
        except (subprocess.TimeoutExpired, OSError) as exc:
            gates.append({"cmd": cmd, "code": 124, "tail": str(exc)})
    return gates


def scrub_artifacts(args: argparse.Namespace, task_file: Path) -> tuple[bool, str | None]:
    """Fail-closed privacy scrub; returns (ok, scrubbed_task_sha256)."""
    scrub = args.scrub or shutil.which("scrub_task.py")
    candidates = [Path(scrub)] if scrub else []
    candidates.append(args.worktree / SCRUB_RELATIVE)
    candidates.append(Path.cwd() / SCRUB_RELATIVE)
    scrub_tool = next((c for c in candidates if c and c.is_file()), None)
    if scrub_tool is None:
        return False, None
    targets = [task_file]
    if args.trajectory.is_file():
        targets.append(args.trajectory)
    for target in targets:
        proc = subprocess.run(
            [sys.executable, str(scrub_tool), "--in-place", str(target)],
            capture_output=True, text=True, timeout=120, check=False, shell=False,
        )
        if proc.returncode != 0:
            return False, None
    return True, sha256_of(task_file)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="fleet_dispatch.py",
                                description="trae/mini dispatch wrapper with receipts")
    p.add_argument("--engine", required=True, choices=("trae", "mini"))
    p.add_argument("--task-file", required=True, type=Path)
    p.add_argument("--worktree", required=True, type=Path)
    p.add_argument("--scope", nargs="*", default=None,
                   help="allowlist of paths the engine may touch")
    p.add_argument("--gate", action="append", default=[],
                   help="post-edit gate command (repeatable; shlex-split, no shell)")
    p.add_argument("--max-steps", type=int, default=30)
    p.add_argument("--timeout", type=int, default=1800, help="engine timeout seconds")
    p.add_argument("--persona", default="Unspecified Master")
    p.add_argument("--output", type=Path, default=Path("fleet_receipt.json"))
    p.add_argument("--patch-path", type=Path, default=Path("solution.patch"))
    p.add_argument("--trajectory", type=Path, default=Path("mini_trajectory.json"))
    p.add_argument("--bin", default=None, help="explicit engine binary override")
    p.add_argument("--scrub", default=None, help="explicit scrub_task.py path")
    p.add_argument("--auto-revert", action="store_true",
                   help="revert tracked changes on scope violation")
    p.add_argument("--allow-main", action="store_true",
                   help="permit dispatch outside a dedicated worktree (testing only)")
    args = p.parse_args(argv)

    args.worktree = args.worktree.resolve()
    started = time.time()

    def finish(code: int, receipt: dict) -> int:
        receipt.update({
            "code": code,
            "meaning": CODE_MEANING[code],
            "duration_s": round(time.time() - started, 1),
        })
        try:
            args.output.write_text(json.dumps(receipt, indent=2), encoding="utf-8")
            print(f"[fleet] receipt: {args.output}")
        except OSError as exc:
            print(f"[fleet] could not write receipt: {exc}")
        print(f"[fleet] {args.engine} dispatch -> {code} {CODE_MEANING[code]}")
        return code

    bin_path, info = preflight(args)
    if bin_path is None:
        return finish(60, {"stage": "preflight", "engine": args.engine,
                           "persona": args.persona, "ok": False,
                           "detail": info.get("detail")})

    task_file = Path(args.task_file).resolve()
    task_sha = sha256_of(task_file)
    patch_abs = args.worktree / args.patch_path
    traj_abs = args.worktree / args.trajectory
    cmd = engine_command(args, bin_path)
    if args.engine == "trae":
        cmd[cmd.index("--patch-path") + 1] = str(patch_abs)
    else:
        cmd[cmd.index("--output") + 1] = str(traj_abs)

    print(f"[fleet] dispatching {args.engine} as [{args.persona}] in {args.worktree}")
    receipt: dict = {
        "schema": "fleet.receipt/v1",
        "engine": args.engine, "persona": args.persona,
        "bin": bin_path, "bin_sha256": sha256_of(Path(bin_path)),
        "worktree": str(args.worktree), "branch": info.get("branch"),
        "task_file": str(task_file), "task_file_sha256": task_sha,
        "scope": args.scope, "gates": [], "artifacts": [],
    }

    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, cwd=str(args.worktree),
            timeout=args.timeout, check=False, shell=False,
        )
        receipt["exit_code"] = proc.returncode
        receipt["engine_output_tail"] = (proc.stdout + proc.stderr)[-400:]
    except subprocess.TimeoutExpired:
        receipt["exit_code"] = None
        receipt["engine_output_tail"] = f"timeout after {args.timeout}s"
        return finish(124, receipt)

    probe_loop = (args.engine == "mini" and detect_probe_loop(traj_abs))
    changed = changed_files(args.worktree)
    receipt["changed_files"] = changed
    receipt["probe_loop"] = probe_loop
    for artifact in (patch_abs, traj_abs):
        if artifact.is_file():
            receipt["artifacts"].append(str(artifact))

    if probe_loop:
        return finish(30, receipt)
    if proc.returncode != 0:
        return finish(20 if not changed else 40, receipt)

    if args.scope is not None:
        scope_norm = {s.strip().lstrip("./") for s in args.scope}
        outside = [f for f in changed
                   if f.lstrip("./") not in scope_norm
                   and not any(f.lstrip("./").startswith(s.rstrip("/") + "/")
                               for s in scope_norm)]
        receipt["out_of_scope"] = outside
        if outside:
            if args.auto_revert:
                git(args.worktree, "checkout", "--", ".")
                receipt["auto_reverted"] = True
            return finish(50, receipt)

    receipt["gates"] = run_gates(args)
    if any(g["code"] != 0 for g in receipt["gates"]):
        return finish(40, receipt)

    scrubbed, scrub_sha = scrub_artifacts(args, task_file)
    receipt["scrubbed"] = scrubbed
    receipt["scrubbed_task_sha256"] = scrub_sha
    if not scrubbed:
        return finish(70, receipt)

    return finish(0, receipt)


if __name__ == "__main__":
    sys.exit(main())
