#!/usr/bin/env python3
"""Probe the TypeSafe Jev Decisions API with a typed question batch.

Dependency-free (stdlib only). Resolves the OpenRouter key exactly like the engine: environment
first (consumer-prefixed names included), then the PQC store via `pqc-secrets export --json`.
The key is never printed, written, or passed on a recorded command line.

Examples:
    python jev_probe.py --state "file src/rag/src/store.rs uses lancedb" \
        --questions '{"q":{"type":"noul","instructions":"Uses a vector DB?",
        "criteria":{"true":"it connects to LanceDB","false":"it does not"}}}'

    python jev_probe.py --state-file state.txt --questions @questions.json --json
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

DEFAULT_MODEL = "typesafe/jev-1.14"
DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions"
KEY_NAMES = (
    "OPENROUTER_API_KEY",
    "ROUTER_API_KEY",
    "OPENROUTER_EMBED_API_KEY",
    "LOCALROUTER_OPENROUTER_API_KEY",
    "LOCALROUTER_OPENROUTER_EMBED_API_KEY",
    "AINISHCODER_OPENROUTER_API_KEY",
)


def _parse_export(text: str) -> dict:
    out = {}
    stripped = text.strip()
    if stripped.startswith("{"):
        try:
            data = json.loads(stripped)
        except ValueError:
            data = None
        if isinstance(data, dict):
            secrets = data.get("secrets") if isinstance(data.get("secrets"), dict) else data
            for name, value in secrets.items():
                if isinstance(value, str) and value.strip():
                    out[str(name)] = value.strip()
            if out:
                return out
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("export "):
            line = line[len("export "):]
        if "=" in line:
            name, _, value = line.partition("=")
            name = name.strip()
            value = value.strip().strip("'").strip('"')
            if name and value:
                out[name] = value
    return out


def resolve_key() -> str:
    for name in KEY_NAMES:
        value = os.environ.get(name)
        if value and value.strip():
            return value.strip()

    candidates = []
    explicit = os.environ.get("PQC_SECRETS_BIN")
    if explicit:
        candidates.append([explicit, "export", "--json"])
    installed = shutil.which("pqc-secrets")
    if installed:
        candidates.append([installed, "export", "--json"])
    candidates.append(["pqc-secrets", "export", "--json"])

    for cmd in candidates:
        run_cmd = cmd
        if os.name == "nt" and cmd[0].lower().endswith((".cmd", ".bat")):
            run_cmd = ["cmd", "/C", *cmd]
        try:
            proc = subprocess.run(
                run_cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                stdin=subprocess.DEVNULL,
                text=True,
                timeout=20,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            continue
        if proc.returncode == 0 and proc.stdout.strip():
            secrets = _parse_export(proc.stdout)
            for name in KEY_NAMES:
                if secrets.get(name):
                    return secrets[name]

    raise SystemExit(
        "No OpenRouter key resolved. Set OPENROUTER_API_KEY (or store "
        "LOCALROUTER_OPENROUTER_API_KEY in the PQC store)."
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe the TypeSafe Jev Decisions API")
    parser.add_argument("--state", default=None, help="State text sent with every question")
    parser.add_argument("--state-file", default=None, help="Read state from a file instead")
    parser.add_argument("--questions", required=True, help="Typed question batch (inline JSON or @path)")
    parser.add_argument("--model", default=os.environ.get("JEV_DECISION_MODEL", DEFAULT_MODEL))
    parser.add_argument("--json", action="store_true", help="Print only the JSON response")
    args = parser.parse_args()

    if args.state_file:
        with open(args.state_file, "r", encoding="utf-8") as handle:
            state = handle.read()
    elif args.state is not None:
        state = args.state
    else:
        parser.error("one of --state or --state-file is required")

    questions_raw = args.questions
    if questions_raw.startswith("@"):
        with open(questions_raw[1:], "r", encoding="utf-8") as handle:
            questions_raw = handle.read()
    try:
        questions = json.loads(questions_raw)
    except ValueError as exc:
        print(f"invalid --questions JSON: {exc}", file=sys.stderr)
        return 2
    if not isinstance(questions, dict):
        print("--questions must be a JSON object keyed by question id", file=sys.stderr)
        return 2

    payload = json.dumps({"model": args.model, "state": state, "questions": questions}).encode("utf-8")
    request = urllib.request.Request(
        DECISIONS_URL,
        data=payload,
        headers={
            "Authorization": f"Bearer {resolve_key()}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/nbiish/ainish-coder",
            "X-Title": "ainish-rag-jev-probe",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        print(f"Jev API {exc.code}: {detail[:2000]}", file=sys.stderr)
        return 1
    except Exception as exc:  # network, TLS, timeout
        print(f"Jev request failed: {exc}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(body, indent=2))
        return 0

    answers = body.get("answers") or {}
    print(f"model: {body.get('model', args.model)}")
    print(f"usage: {json.dumps(body.get('usage', {}))}")
    for qid in sorted(answers):
        answer = answers[qid]
        kind = answer.get("type", "?")
        if answer.get("noul") is not None:
            value = answer["noul"]
            band = "yes" if value >= 0.70 else ("no" if value <= 0.30 else "unsettled")
            print(f"  {qid:<28} {kind:<8} {value:.3f} ({band})")
        elif answer.get("choice") is not None:
            confidence = answer.get("confidence")
            suffix = f" (confidence {confidence:.2f})" if isinstance(confidence, (int, float)) else ""
            print(f"  {qid:<28} {kind:<8} {answer['choice']}{suffix}")
        elif answer.get("score") is not None:
            print(f"  {qid:<28} {kind:<8} {float(answer['score']):.2f}")
        else:
            print(f"  {qid:<28} {kind:<8} {json.dumps(answer)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
