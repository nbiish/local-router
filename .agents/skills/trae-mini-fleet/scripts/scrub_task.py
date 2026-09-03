#!/usr/bin/env python3
"""
scrub_task.py — Privacy & Environmental Hygiene Scrubber for Fleet Trajectories & Task Files

Redacts API keys, bearer tokens, private keys, authentication headers, and absolute
user home paths from /tmp task files and trajectory JSON logs prior to git commits or
cross-machine sharing.

Usage:
    python3 scrub_task.py <file_path> [--in-place] [--output <dest>]
"""

import argparse
import json
import re
import sys
from pathlib import Path

# Common patterns for sensitive tokens and credentials
SENSITIVE_PATTERNS = [
    # API keys and bearer tokens
    (re.compile(r'(?i)(bearer\s+)[a-zA-Z0-9_\-\.]{12,}', re.IGNORECASE), r'\1[REDACTED_BEARER_TOKEN]'),
    (re.compile(r'(?i)(api[_-]?key\s*[:=]\s*["\']?)[a-zA-Z0-9_\-\.]{12,}(["\']?)', re.IGNORECASE), r'\1[REDACTED_API_KEY]\2'),
    (re.compile(r'(?i)(secret[_-]?key\s*[:=]\s*["\']?)[a-zA-Z0-9_\-\.]{12,}(["\']?)', re.IGNORECASE), r'\1[REDACTED_SECRET_KEY]\2'),
    (re.compile(r'(?i)(token\s*[:=]\s*["\']?)[a-zA-Z0-9_\-\.]{16,}(["\']?)', re.IGNORECASE), r'\1[REDACTED_TOKEN]\2'),
    (re.compile(r'(?i)(password\s*[:=]\s*["\']?)[^\s"\']+(["\']?)', re.IGNORECASE), r'\1[REDACTED_PASSWORD]\2'),
    # Specific provider key prefixes
    (re.compile(r'sk-[a-zA-Z0-9]{20,}', re.IGNORECASE), '[REDACTED_OPENAI_KEY]'),
    (re.compile(r'ghp_[a-zA-Z0-9]{20,}', re.IGNORECASE), '[REDACTED_GITHUB_TOKEN]'),
    (re.compile(r'xox[baprs]-[a-zA-Z0-9]{10,}', re.IGNORECASE), '[REDACTED_SLACK_TOKEN]'),
    # Absolute user paths (macOS / Linux / Windows)
    (re.compile(r'/Users/[a-zA-Z0-9_\-]+/', re.IGNORECASE), '~/'),
    (re.compile(r'/home/[a-zA-Z0-9_\-]+/', re.IGNORECASE), '~/'),
    (re.compile(r'[A-Za-z]:\\[Uu]sers\\[a-zA-Z0-9_\-]+\\', re.IGNORECASE), r'~\\'),
]


def scrub_text(text: str) -> str:
    """Applies redaction regexes to arbitrary text."""
    scrubbed = text
    for pattern, replacement in SENSITIVE_PATTERNS:
        scrubbed = pattern.sub(replacement, scrubbed)
    return scrubbed


def scrub_json_obj(obj):
    """Recursively traverses and scrubs strings in JSON objects/arrays."""
    if isinstance(obj, str):
        return scrub_text(obj)
    elif isinstance(obj, list):
        return [scrub_json_obj(item) for item in obj]
    elif isinstance(obj, dict):
        return {key: scrub_json_obj(val) for key, val in obj.items()}
    return obj


def process_file(file_path: Path, in_place: bool = False, output_path: Path = None) -> str:
    if not file_path.exists():
        raise FileNotFoundError(f"Target file not found: {file_path}")

    raw_content = file_path.read_text(encoding="utf-8", errors="replace")

    # If file is JSON, parse and scrub structurally to maintain JSON validity
    if file_path.suffix.lower() == ".json":
        try:
            data = json.loads(raw_content)
            scrubbed_data = scrub_json_obj(data)
            result = json.dumps(scrubbed_data, indent=2)
        except Exception:
            # Fallback to plain regex scrubbing if JSON is malformed
            result = scrub_text(raw_content)
    else:
        result = scrub_text(raw_content)

    if in_place:
        file_path.write_text(result, encoding="utf-8")
        print(f"[scrub_task] Sanitized in-place: {file_path}")
    elif output_path:
        output_path.write_text(result, encoding="utf-8")
        print(f"[scrub_task] Sanitized output written to: {output_path}")

    return result


def main():
    parser = argparse.ArgumentParser(description="Privacy and token scrubber for fleet trajectory and task files.")
    parser.add_argument("file", type=Path, help="Target file to scrub")
    parser.add_argument("--in-place", "-i", action="store_true", help="Modify file directly in place")
    parser.add_argument("--output", "-o", type=Path, default=None, help="Destination output file path")

    args = parser.parse_args()

    try:
        content = process_file(args.file, in_place=args.in_place, output_path=args.output)
        if not args.in_place and not args.output:
            print(content)
        sys.exit(0)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
