#!/usr/bin/env python3
"""
fleet_dataset.py — Empirical Prompt Engineering Dataset CLI for trae-mini-fleet

Provides subcommands to query past prompt benchmarks, append new dispatch metrics,
and compute fleet-wide performance statistics against `trae-mini-fleet.csv`.

Usage:
    python3 fleet_dataset.py query <task_type>
    python3 fleet_dataset.py stats
    python3 fleet_dataset.py log --agent <agent> --task-type <type> --step-budget <int> \
                                 --steps-taken <int> --template <id> --excerpt <str> \
                                 [--patch] [--pass] [--failure-mode <mode>] \
                                 [--strengths <str>] [--weaknesses <str>] [--refinement <str>]
"""

import argparse
import csv
import datetime
import sys
from pathlib import Path

DEFAULT_CSV_PATH = Path(__file__).resolve().parent.parent / "trae-mini-fleet.csv"

CSV_HEADERS = [
    "dispatch_id",
    "timestamp",
    "agent",
    "task_type",
    "model_endpoint",
    "virtual_model",
    "step_budget",
    "steps_taken",
    "prompt_template_id",
    "prompt_excerpt",
    "patch_generated",
    "verification_passed",
    "failure_mode",
    "harness_strengths_revealed",
    "harness_weaknesses_revealed",
    "prompt_refinement",
]


def load_records(csv_path: Path = DEFAULT_CSV_PATH):
    if not csv_path.exists():
        return []
    with open(csv_path, mode="r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        return list(reader)


def cmd_query(args):
    records = load_records()
    task_type = args.task_type.strip().lower()
    matching = [r for r in records if r["task_type"].strip().lower() == task_type]

    if not matching:
        print(f"No previous dispatches found for task_type '{task_type}'.")
        print("Available task types:", sorted(list(set(r['task_type'] for r in records))))
        return

    print(f"=== Empirical Benchmarks for '{task_type}' ({len(matching)} dispatches) ===")
    passed = [r for r in matching if r["verification_passed"].lower() == "true"]
    pass_rate = (len(passed) / len(matching)) * 100
    avg_steps = sum(int(r["steps_taken"]) for r in matching) / len(matching)

    print(f"Historical Pass Rate: {pass_rate:.1f}% | Avg Steps Taken: {avg_steps:.1f}")

    # Rank templates
    templates = {}
    for r in matching:
        tid = r["prompt_template_id"]
        templates[tid] = templates.get(tid, 0) + (1 if r["verification_passed"].lower() == "true" else 0)

    top_template = max(templates.items(), key=lambda x: x[1])[0] if templates else "N/A"
    print(f"Top Recommended Template: {top_template}")

    print("\nRecent Dispatch Refinements & Failure Signatures:")
    for r in matching[-3:]:
        status = "PASSED" if r["verification_passed"].lower() == "true" else f"FAILED ({r['failure_mode']})"
        print(f"  • [{r['agent']} / {r['prompt_template_id']}] {status}")
        print(f"    Excerpt: {r['prompt_excerpt']}")
        if r['prompt_refinement']:
            print(f"    Refinement: {r['prompt_refinement']}")


def cmd_stats(args):
    records = load_records()
    if not records:
        print("No dispatch records in trae-mini-fleet.csv.")
        return

    print(f"=== Trae-Mini Fleet Empirical Metrics ({len(records)} total dispatches) ===")
    agents = sorted(list(set(r["agent"] for r in records)))

    print(f"{'Agent':<18} | {'Dispatches':<10} | {'Pass Rate':<10} | {'Avg Steps':<10}")
    print("-" * 55)
    for agent in agents:
        agent_recs = [r for r in records if r["agent"] == agent]
        passed = sum(1 for r in agent_recs if r["verification_passed"].lower() == "true")
        rate = (passed / len(agent_recs)) * 100
        avg_steps = sum(int(r["steps_taken"]) for r in agent_recs) / len(agent_recs)
        print(f"{agent:<18} | {len(agent_recs):<10} | {rate:>8.1f}% | {avg_steps:>9.1f}")

    # Failure modes
    failures = [r["failure_mode"] for r in records if r["failure_mode"] and r["failure_mode"].lower() != "none"]
    if failures:
        print("\nFailure Mode Distribution:")
        counts = {}
        for f in failures:
            counts[f] = counts.get(f, 0) + 1
        for f, count in sorted(counts.items(), key=lambda x: x[1], reverse=True):
            print(f"  • {f}: {count}")


def cmd_log(args):
    records = load_records()
    next_id = f"dsp_{datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d')}_{len(records) + 1:03d}"
    timestamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    row = {
        "dispatch_id": next_id,
        "timestamp": timestamp,
        "agent": args.agent,
        "task_type": args.task_type,
        "model_endpoint": args.endpoint,
        "virtual_model": args.model,
        "step_budget": str(args.step_budget),
        "steps_taken": str(args.steps_taken),
        "prompt_template_id": args.template,
        "prompt_excerpt": args.excerpt,
        "patch_generated": "true" if args.patch else "false",
        "verification_passed": "true" if args.verify_pass else "false",
        "failure_mode": args.failure_mode,
        "harness_strengths_revealed": args.strengths,
        "harness_weaknesses_revealed": args.weaknesses,
        "prompt_refinement": args.refinement,
    }

    file_exists = DEFAULT_CSV_PATH.exists()
    with open(DEFAULT_CSV_PATH, mode="a", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_HEADERS)
        if not file_exists:
            writer.writeheader()
        writer.writerow(row)

    print(f"[fleet_dataset] Logged dispatch {next_id} ({args.agent} on {args.task_type}) to {DEFAULT_CSV_PATH}")


def main():
    parser = argparse.ArgumentParser(description="Trae-Mini Fleet Empirical Dataset Manager")
    subparsers = parser.add_subparsers(dest="subcommand", required=True)

    # query
    p_query = subparsers.add_parser("query", help="Query benchmarks for a task type")
    p_query.add_argument("task_type", type=str, help="Task type category (e.g. ast_refactor, bug_reproduce)")
    p_query.set_defaults(func=cmd_query)

    # stats
    p_stats = subparsers.add_parser("stats", help="Show fleet-wide statistics")
    p_stats.set_defaults(func=cmd_stats)

    # log
    p_log = subparsers.add_parser("log", help="Log a new dispatch result")
    p_log.add_argument("--agent", required=True, choices=["trae-cli", "mini-live", "free-claude-code", "omp"])
    p_log.add_argument("--task-type", required=True)
    p_log.add_argument("--step-budget", type=int, default=30)
    p_log.add_argument("--steps-taken", type=int, required=True)
    p_log.add_argument("--template", required=True)
    p_log.add_argument("--excerpt", required=True)
    p_log.add_argument("--patch", action="store_true", default=False)
    p_log.add_argument("--pass", dest="verify_pass", action="store_true", default=False)
    p_log.add_argument("--failure-mode", default="none")
    p_log.add_argument("--strengths", default="")
    p_log.add_argument("--weaknesses", default="")
    p_log.add_argument("--refinement", default="")
    p_log.add_argument("--endpoint", default="http://localhost:11434/v1")
    p_log.add_argument("--model", default="local-router/fallback-models")
    p_log.set_defaults(func=cmd_log)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
