#!/usr/bin/env bash
# commit-identity-guard.sh — keep AI harnesses from becoming the author of the operator's history.
#
# Problem: several CLI/IDE agent harnesses set git identity, add attribution trailers, or rewrite
# config so their own name lands on commits. Some do it by prompt-injecting the agent, some by
# exporting GIT_AUTHOR_* themselves. The operator's profile must win either way.
#
# This runs as a post-commit hook. If the commit was authored by a harness, it rewrites the commit to
# `Nanoboozhoo embodied by: <harness>` and strips harness attribution lines from the message. If the
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

# The canonical form the operator asked for. {harness} is the tool that forced the commit — never
# a hardcoded product name: the guard detects the actual harness from env markers or the author.
# The colon belongs after "by:", exactly as the operator specified.
identity_prefix="Nanoboozhoo embodied by:"

# Harness names, lowercased, as they appear in authors and in attribution trailers.
#
# `ainish-coder` is in this list because it is OUR OWN tool, and it was the one identity the guard
# missed: six merge commits on 2026-11-18 were authored `ainish-coder bot <bot@local>` and the guard
# walked past every one, since "ainish-coder" matched none of the third-party names. The contract's
# rule is not "no third-party harness may be the author" — it is "the operator is the only author",
# and a tool of ours claiming authorship is exactly as wrong as a tool of theirs doing it.
harness_pattern='claude|cursor|copilot|codex|aider|opencode|windsurf|cline|devin|gemini|antigravity|jules|qodo|tabnine|ainish-coder|hermes'

# Authors that are a tool by construction rather than a person. Kept separate from the name pattern
# because these catch tooling whose display name carries no recognisable product word at all.
bot_email_pattern='^bot@|@bot\.local$|^noreply@|\[bot\]'

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
# A tool-shaped author is a tool, whatever it is called. This is the backstop that would have caught
# `ainish-coder bot <bot@local>` even before the name was added to the pattern above. When no
# environment marker and no known product name identify WHICH tool it was, the honest label is the
# generic `agent` — inventing a product name would be a false attribution, which is worse than a vague
# one, because the contract's record exists to say who actually did the work.
if [ -z "$harness" ] && printf '%s' "$(git log -1 --format='%ae')" | grep -qE "$bot_email_pattern"; then
    harness="agent"
fi
[ -n "$harness" ] || exit 0

identity="${identity_prefix} ${harness}"
cur_name="$(git log -1 --format='%an')"
cur_email="$(git log -1 --format='%ae')"

# Already ours AND the message is clean — nothing to do.
#
# The "author is correct" test alone was a bug worth 26 commits: a harness that set the author field
# correctly AND appended `Co-authored-by: Cursor <...>` produced a commit this guard walked away from,
# leaving the strip at the bottom of this file unreachable for exactly the commits that needed it.
# The early exit now requires BOTH conditions, so a correct author with a dirty message is still
# repaired.
message_is_clean() {
    local stripper="${repo_root}/scripts/strip-harness-trailers.sh"
    [ -x "$stripper" ] || return 0   # no table available: assume clean rather than amend blindly
    git log -1 --format=%B > "${TMPDIR:-/tmp}/guard-msg.$$" 2>/dev/null || return 0
    "$stripper" --check "${TMPDIR:-/tmp}/guard-msg.$$" 2>/dev/null
    local rc=$?
    rm -f "${TMPDIR:-/tmp}/guard-msg.$$"
    return $rc
}

if [ "$cur_name" = "$identity" ] && message_is_clean; then
    exit 0
fi
# Old spellings (`Nanoboozhoo - embodied by ...`, `Nanoboozhoo - embodies by ...`) are deliberately
# NOT accepted as already-normalised: the newest canonical form is `Nanoboozhoo embodied by: ...`,
# and an amend of an older commit should bring its author forward rather than preserve a retired form.

# The operator's email stays put; only the display name is corrected.
email="${cur_email}"
case "$email" in
    *@users.noreply.github.com|*@anthropic.com|*@cursor.so|*@cursor.com|noreply@*)
        email="$(git config --get user.email || printf '%s' "$email")" ;;
esac

msg_file="$(mktemp "${TMPDIR:-/tmp}/identity-guard.XXXXXX")"
trap 'rm -f "$msg_file"' EXIT
# One table decides what counts as harness attribution — see scripts/harness-attribution.txt.
#
# This block used to carry its OWN regex, and it was wrong in two opposite ways: it stripped
# `Signed-off-by:` (a DCO assertion the OPERATOR makes, not a tool claiming authorship), and its
# harness list was narrower than the table's. Two lists drift; one table does not. When the stripper
# is unavailable the fallback still removes `Co-authored-by:` lines naming a harness, because leaving
# those is the failure this guard exists to prevent.
stripper="${repo_root}/scripts/strip-harness-trailers.sh"
if [ -x "$stripper" ]; then
    git log -1 --format=%B | "$stripper" --stdin > "$msg_file" 2>/dev/null || \
        git log -1 --format=%B > "$msg_file"
else
    git log -1 --format=%B \
        | grep -viE "^[[:space:]]*co-authored-by[[:space:]]*:.*(${harness_pattern})" \
        > "$msg_file" || true
fi
# An empty message means the whole body was attribution; keep the subject line.
[ -s "$msg_file" ] || git log -1 --format=%s > "$msg_file"

# SIGNING MUST SURVIVE THE REWRITE.
#
# `git commit --amend` does NOT inherit the original commit's signature: it builds a new object, and
# unless asked to sign it again the result is unsigned. Measured on 2026-11-18: 15 of 16 commits made
# that day were unsigned, because this guard rewrote each one after `commit.gpgsign` had already
# produced a good signature — the guard's own repair silently destroyed the evidence it exists to
# protect. An unsigned commit cannot be verified by anyone, so "the operator is the only author" was
# unprovable on exactly the commits that had been re-authored.
#
# `-S` re-signs with the configured key. It is passed only when the repo actually signs, so a host
# with no key configured does not have the amend fail and the author rewrite silently skipped.
sign_flag=""
if [ "$(git config --get commit.gpgsign 2>/dev/null || echo false)" = "true" ] &&
   [ -n "$(git config --get user.signingkey 2>/dev/null || true)" ]; then
    sign_flag="-S"
fi

AINISH_IDENTITY_GUARD_ACTIVE=1 \
GIT_COMMITTER_NAME="$identity" GIT_COMMITTER_EMAIL="$email" \
    git commit --amend --no-edit --quiet $sign_flag --author="$identity <${email}>" -F "$msg_file" 2>/dev/null || exit 0

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
