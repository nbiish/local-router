#!/usr/bin/env bash
# commit-identity-guard.sh — keep AI harnesses from becoming the author of the operator's history.
#
# Problem: several CLI/IDE agent harnesses set git identity, add attribution trailers, or rewrite
# config so their own name lands on commits. Some do it by prompt-injecting the agent, some by
# exporting GIT_AUTHOR_* themselves. The operator's profile must win either way.
#
# This runs as a post-commit hook. If the commit was authored by a harness, it rewrites the commit to
# `Nanoboozhoo - embodied by <harness>` and strips harness attribution lines from the message. If the
# commit is already the operator's, it does nothing. Idempotent, and it never touches a commit that
# does not name a harness.
#
# Escape hatch: AINISH_IDENTITY_GUARD=off disables it for one commit (also used internally to stop
# the amend from re-entering).

set -uo pipefail

[ "${AINISH_IDENTITY_GUARD:-on}" = "off" ] && exit 0
[ "${AINISH_IDENTITY_GUARD_ACTIVE:-0}" = "1" ] && exit 0

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$repo_root" || exit 0

# The canonical form the operator asked for. {harness} is the tool that forced the commit.
identity_prefix="Nanoboozhoo - embodied by"

# The prefix was "embodies by" before 2026-11-13. A commit authored under the old spelling is still
# the operator's own history, so it must count as already-normalised — otherwise the post-commit
# guard (or any amend of an older commit) would see a mismatch and rewrite an already-correct author,
# which is an amend loop and a needless rewrite of history nobody asked to change.
identity_prefix_legacy="Nanoboozhoo - embodies by"

# Harness names, lowercased, as they appear in authors and in attribution trailers.
harness_pattern='claude|cursor|copilot|codex|aider|opencode|windsurf|cline|devin|gemini|antigravity|jules|qodo|tabnine|continue'

detect_harness() {
    # Environment markers first: they say which tool is driving, even if authorship was rewritten.
    local marker
    for marker in CLAUDECODE CURSOR_TRACE_ID CURSOR_AGENT COPILOT_AGENT COPILOT_CLI CODEX_SANDBOX \
                  OPENCODE AIDER WINDSURF CLINE_AGENT DEVIN_AGENT GEMINI_CLI ANTIGRAVITY JULES_AGENT; do
        if [ -n "${!marker:-}" ]; then
            printf '%s\n' "$marker" | tr 'A-Z' 'a-z' | sed -E 's/_(trace_id|agent|cli|sandbox)$//'
            return 0
        fi
    done
    # Otherwise read the author field the harness wrote.
    local author
    author="$(git log -1 --format='%an' 2>/dev/null)"
    printf '%s' "$author" | grep -oiE "$harness_pattern" | head -1 | tr 'A-Z' 'a-z'
}

harness="$(detect_harness)"
[ -n "$harness" ] || exit 0

identity="${identity_prefix} ${harness}"
cur_name="$(git log -1 --format='%an')"
cur_email="$(git log -1 --format='%ae')"

# Already ours — nothing to do (also prevents amend loops). Both spellings count: history authored
# before 2026-11-13 says "embodies by" and is still the operator's own.
[ "$cur_name" = "$identity" ] && exit 0
case "$cur_name" in
    "$identity_prefix_legacy "*) exit 0 ;;
esac

# The operator's email stays put; only the display name is corrected.
email="${cur_email}"
case "$email" in
    *@users.noreply.github.com|*@anthropic.com|*@cursor.so|*@cursor.com|noreply@*)
        email="$(git config --get user.email || printf '%s' "$email")" ;;
esac

msg_file="$(mktemp "${TMPDIR:-/tmp}/identity-guard.XXXXXX")"
trap 'rm -f "$msg_file"' EXIT
git log -1 --format=%B \
    | grep -viE "^[[:space:]]*(co-authored-by|signed-off-by|generated-by)[[:space:]]*:.*(${harness_pattern})" \
    | grep -viE "(${harness_pattern})[[:space:]]*(code|coder|cli|agent|ide)|generated with (${harness_pattern})|made with (${harness_pattern})|🤖" \
    > "$msg_file" || true
# An empty message means the whole body was attribution; keep the subject line.
[ -s "$msg_file" ] || git log -1 --format=%s > "$msg_file"

AINISH_IDENTITY_GUARD_ACTIVE=1 \
GIT_COMMITTER_NAME="$identity" GIT_COMMITTER_EMAIL="$email" \
    git commit --amend --no-edit --quiet --author="$identity <${email}>" -F "$msg_file" 2>/dev/null || exit 0

# Say what happened, on stderr so it does not pollute hook stdout.
printf 'identity-guard: commit re-authored as "%s" (was "%s")\n' "$identity" "$cur_name" >&2

# Leave a durable line so the operator can see a harness tried to claim authorship.
if [ -d .agents/comms ] && [ "${AINISH_IDENTITY_GUARD_QUIET:-0}" != "1" ]; then
    stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '%s identity-guard | %s -> %s | %s\n' \
        "$stamp" "$cur_name" "$identity" "$(git log -1 --format='%h %s')" \
        >> ".agents/comms/$(date -u +%Y-%m-%d)-identity-guard.live.txt" 2>/dev/null || true
fi

exit 0
