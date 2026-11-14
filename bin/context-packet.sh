#!/bin/sh
# Emit a bounded orientation packet for a project/task.
set -eu

task=""
mode="elephant"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --task)
      [ "$#" -ge 2 ] || { echo "error: --task requires text" >&2; exit 2; }
      task=$2
      shift 2
      ;;
    --mode)
      [ "$#" -ge 2 ] || { echo "error: --mode requires elephant|goldfish|build" >&2; exit 2; }
      mode=$2
      case "$mode" in elephant|goldfish|build) ;; *) echo "error: invalid --mode: $mode" >&2; exit 2 ;; esac
      shift 2
      ;;
    --help|-h)
      printf '%s\n' 'Usage: bin/context-packet.sh --task "request"'
      exit 0
      ;;
    *)
      echo "error: unknown option: $1" >&2
      exit 2
      ;;
  esac
done

[ -n "$task" ] || { echo 'error: --task is required' >&2; exit 2; }

echo '=== CONTEXT PACKET ==='
printf 'request: %s\n' "$task"
printf 'mode: %s\n' "$mode"
if [ "$mode" = "goldfish" ]; then
  echo 'policy: stateless review; only explicit design references are allowed'
  echo '--- goldfish_boundary ---'
  echo 'memory: excluded'
  echo 'comms: excluded'
  echo 'implementation: excluded'
  echo 'provide_design_path_and_explicit_references_to_reviewer'
  echo '=== END CONTEXT PACKET ==='
  exit 0
fi

printf 'branch: %s\n' "$(git branch --show-current 2>/dev/null || printf '?')"
printf 'worktree: %s\n' "$(git rev-parse --show-toplevel 2>/dev/null || printf '?')"
printf 'status_count: %s\n' "$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"

echo '--- changed_files ---'
git status --short 2>/dev/null | head -40 || true

echo '--- task_state ---'
found=0
for file in $(ls -1 .agents/tasks/*-task.md .agents/tasks/TASK.*.md 2>/dev/null | sort | tail -3); do
  [ -f "$file" ] || continue
  found=1
  printf '%s: ' "$file"
  grep -E '^- (status|lane|objective|scope):' "$file" 2>/dev/null | head -4 | tr '\n' ';' || true
  printf '\n'
done
[ "$found" -eq 1 ] || echo 'none'

echo '--- plan_state ---'
# Parity with the RAG orientation section: without this, the non-RAG fallback would be the one path
# that cannot see the plan of record. Newest by mtime — a plan touched during implementation is more
# current than one merely dated later. Both naming schemes are live: `{date}-{slug}.plan.md` is
# grandfathered, `{date}-{HH}-{slug}.md` is current, and `.agents/plans/llms.txt` is the index.
found=0
for plan_file in $(ls -1t .agents/plans/*.md 2>/dev/null | grep -v '/llms\.txt$' | head -3); do
  [ -f "$plan_file" ] || continue
  found=1
  printf '%s: ' "$plan_file"
  grep -E '^(status|branch|task_record):' "$plan_file" 2>/dev/null | head -3 | tr '\n' ';' || true
  open_todos=$(grep -c '^- \[ \]' "$plan_file" 2>/dev/null || true)
  done_todos=$(grep -cE '^- \[[xX]\]' "$plan_file" 2>/dev/null || true)
  printf 'todos: %s done, %s open\n' "${done_todos:-0}" "${open_todos:-0}"
done
[ "$found" -eq 1 ] || echo 'none'

echo '--- masters ---'
# The always-on contract names the nine dual-expertise niches; the packet echoes
# them as one line each so an agent can constitute the relevant pair without a
# second file read. Definitions stay in .agents/templates/masters.md.
cat <<'MASTERS'
advisory_only: true
constitute: name both experts concretely for THIS task, let them disagree, keep only what survived
omit: a master with nothing to add says nothing — nine boilerplate lines is the failure mode
1 breach/blast-radius: Can this be abused, and how far does damage spread before anyone notices?
2 privacy/data-lifecycle: What did we retain that we cannot defend, and can we actually erase it?
3 dependencies/provenance: What did we accept without proving where it came from?
4 structure/operations: Is this the right shape, and can it run at 3am by someone who did not write it?
5 failure/verification: What is the cheapest experiment that would falsify this claim?
6 authority/accountability: Who is allowed to decide this, and who answers for it?
7 automation/reproducibility: Can a machine run it unattended, and can anyone re-derive the result?
8 orchestration/self-correction: Is the work shaped right, and what would make me abandon this approach?
9 comprehension/operability: Can someone understand and safely change this without me?
MASTERS

echo '--- master_suggestions ---'
suggestions=$(ls -1 .agents/suggestions/*-suggestions.txt 2>/dev/null | sort | tail -1 || true)
if [ -n "$suggestions" ] && [ -f "$suggestions" ]; then
  printf 'source: %s\n' "$suggestions"
  echo 'advisory_only: true'
  echo 'tail:'
  tail -20 "$suggestions"
else
  echo 'source: none'
  echo 'advisory_only: true'
fi

echo '--- recent_memory ---'
# Both memory suffixes are live; newest by mtime, because a name sort prefers the grandfather file.
memory=$(ls -1t .agents/memories/*-memory.md .agents/memories/*-memory.txt 2>/dev/null | head -1 || true)
if [ -n "$memory" ]; then
  printf '%s\n' "$memory"
  grep '^- ' "$memory" 2>/dev/null | tail -5 || true
else
  echo 'none'
fi

echo '--- route ---'
if command -v ainish-rag >/dev/null 2>&1; then
  if command -v timeout >/dev/null 2>&1; then
    route_output=$(timeout 20s ainish-rag route "$task" --json 2>/dev/null) || route_output='route_unavailable'
  else
    route_output='route_unavailable:no_timeout_command'
  fi
  printf '%s\n' "$route_output" | sed -n '1,80p'
else
  echo 'ainish-rag unavailable'
fi

echo '=== END CONTEXT PACKET ==='
