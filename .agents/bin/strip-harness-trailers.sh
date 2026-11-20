#!/usr/bin/env bash
# strip-harness-trailers.sh — remove tool self-attribution from a commit message.
#
# WHY THIS IS A commit-msg HOOK AND NOT post-commit:
# a post-commit fix has to `git commit --amend`, which builds a NEW object. Unless it is told to sign
# again, the result is unsigned — measured 2026-11-18, when the author guard's own repair destroyed
# the signature on 15 of 16 commits. `commit-msg` runs BEFORE the commit object exists, so editing the
# message there is free: no amend, no re-sign, no rewritten history.
#
# WHY THE TABLE EXISTS:
# every harness spells its attribution differently (`Co-authored-by: Cursor
# <cursoragent@cursor.com>`, `Co-Authored-By: Warp <agent@warp.dev>`, plain `Made with Cursor`). A
# hardcoded list inside each script is how one tool got missed and authored six commits. One table,
# read by the hook, the author guard, and the history rewrite.
#
# WHAT IS NOT STRIPPED:
#   Signed-off-by  — a DCO assertion the OPERATOR makes; removing it deletes a legal statement.
#   Co-authored-by naming a person — a real collaborator is not a tool claiming authorship.
#
# Usage:
#   strip-harness-trailers.sh --stdin              filter stdin -> stdout (for `filter-repo`)
#   strip-harness-trailers.sh --check FILE         exit 1 if FILE holds a harness attribution
#   strip-harness-trailers.sh FILE                 rewrite FILE in place (the commit-msg hook)
#   strip-harness-trailers.sh --report FILE        as above, printing what was removed
#
# Exit codes: 0 always, except `--check` (1 = dirty). A hook that can fail a commit gets disabled,
# and a disabled hook is how the trailers accumulated in the first place.
set -uo pipefail

SELF_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TABLE="${SELF_DIR}/harness-attribution.txt"
# A repo that deploys this script may not have the table beside it; the hook block passes it in.
TABLE="${AINISH_HARNESS_TABLE:-$TABLE}"

die_soft() {
    # Never block a commit because this script could not read its own table.
    if [ "$1" = "check" ]; then exit 0; fi
    cat
    exit 0
}

build_pattern() {
    [ -f "$TABLE" ] || return 1
    local frags=()
    local line frag
    while IFS= read -r line; do
        case "$line" in ''|'#'*) continue ;; esac
        # label | match | display
        frag="$(printf '%s' "$line" | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2}')"
        [ -n "$frag" ] && frags+=("$frag")
    done < "$TABLE"
    [ ${#frags[@]} -gt 0 ] || return 1
    local IFS='|'
    printf '%s' "${frags[*]}"
}

HARNESS_RE="$(build_pattern)" || true
if [ -z "${HARNESS_RE:-}" ]; then
    case "${1:-}" in
        --check) exit 0 ;;
        *) cat 2>/dev/null; exit 0 ;;
    esac
fi

# The attribution LINES. Deliberately narrow: a trailer key we own, or a known "generated with"
# flourish, whose value matches the table. A prose sentence that happens to contain "cursor" in a
# commit body is left alone — this strips attribution, not vocabulary.
strip_filter() {
    # -i: attribution casing varies (Co-authored-by / Co-Authored-By / CO-AUTHORED-BY).
    grep -viE "^[[:space:]]*(co-authored-by|generated-by|made-with|generated-with)[[:space:]]*:.*(${HARNESS_RE})" \
    | grep -viE "^[[:space:]]*(🤖[[:space:]]*)?(generated|made)[[:space:]]+(with|by)[[:space:]]+(${HARNESS_RE})[[:space:]]*$"
}

count_hits() {
    grep -ciE "^[[:space:]]*(co-authored-by|generated-by|made-with|generated-with)[[:space:]]*:.*(${HARNESS_RE})|^[[:space:]]*(🤖[[:space:]]*)?(generated|made)[[:space:]]+(with|by)[[:space:]]+(${HARNESS_RE})[[:space:]]*$" || true
}

report_hits() {
    grep -oiE "(co-authored-by|generated-by|made-with|generated-with)[[:space:]]*:[^<]*" | sed 's/[[:space:]]*$//' || true
}

mode="${1:---stdin}"

case "$mode" in
    --stdin)
        strip_filter
        exit 0
        ;;
    --check)
        target="${2:-}"
        # git passes the message path as $1 for commit-msg; accept both shapes.
        [ -n "$target" ] || target="$1"
        [ -f "$target" ] || exit 0
        if [ "$(count_hits < "$target")" -gt 0 ]; then exit 1; fi
        exit 0
        ;;
    --report)
        target="${2:-}"
        [ -f "$target" ] || exit 0
        hits="$(count_hits < "$target")"
        if [ "$hits" -gt 0 ]; then
            report_hits < "$target" >&2 || true
            tmp="$(mktemp "${TMPDIR:-/tmp}/strip-trailers.XXXXXX")" || exit 0
            if strip_filter < "$target" > "$tmp"; then
                # A message that was ONLY attribution must keep its subject.
                if [ -s "$tmp" ] || [ ! -s "$target" ]; then
                    cat "$tmp" > "$target"
                fi
            fi
            rm -f "$tmp"
            printf 'identity-strip: removed %s harness attribution line(s) from the message\n' "$hits" >&2
        fi
        exit 0
        ;;
    *)
        # commit-msg contract: $1 is the message file. Rewrite in place.
        if [ -f "$mode" ]; then
            hits="$(count_hits < "$mode")"
            if [ "$hits" -gt 0 ]; then
                report_hits < "$mode" >&2 || true
                tmp="$(mktemp "${TMPDIR:-/tmp}/strip-trailers.XXXXXX")" || exit 0
                if strip_filter < "$mode" > "$tmp"; then
                    if [ -s "$tmp" ] || [ ! -s "$mode" ]; then
                        cat "$tmp" > "$mode"
                    fi
                fi
                rm -f "$tmp"
                printf 'identity-strip: removed %s harness attribution line(s)\n' "$hits" >&2
            fi
        fi
        exit 0
        ;;
esac
