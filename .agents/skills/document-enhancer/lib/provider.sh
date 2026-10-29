#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║  provider.sh — Per-Role Multi-Provider LLM API Abstraction      ║
# ║                                                                 ║
# ║  Each role (orchestrator, subagent, reviewer) independently     ║
# ║  targets a provider + model. Fallback chain on failure.         ║
# ║                                                                 ║
# ║  Supports: OpenRouter, ZenMux, Nebius                          ║
# ║  Compatible: Bash 3.2+ (macOS default)                         ║
# ╚══════════════════════════════════════════════════════════════════╝
set -euo pipefail

LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Load .env if present
if [[ -f "${PWD}/.env" ]]; then
  # shellcheck disable=SC1091
  set -a
  source "${PWD}/.env"
  set +a
elif [[ -f "${LAB_DIR}/.env" ]]; then
  # shellcheck disable=SC1091
  set -a
  source "${LAB_DIR}/.env"
  set +a
fi

# ── Bash 3.2 compat helpers ──────────────────────────────────────
_lower() { echo "$1" | tr '[:upper:]' '[:lower:]'; }
_upper() { echo "$1" | tr '[:lower:]' '[:upper:]'; }
_trim()  { echo "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'; }

# Indirect variable expansion (bash 3.2 safe)
# Usage: _getvar VARNAME [default]
_getvar() {
  local val
  val="$(eval echo "\"\${${1}:-${2:-}}\"")"
  echo "${val}"
}

# ═══════════════════════════════════════════════════════════════════
# PROVIDER REGISTRY
# Maps provider names → (base_url, api_key)
# ═══════════════════════════════════════════════════════════════════

_provider_url() {
  local p
  p="$(_lower "$1")"
  case "${p}" in
    openrouter) echo "${OPENROUTER_BASE_URL:-https://openrouter.ai/api/v1}" ;;
    zenmux)     echo "${ZENMUX_BASE_URL:-}" ;;
    nebius)     echo "${NEBIUS_BASE_URL:-https://api.studio.nebius.com/v1}" ;;
    nvidia)     echo "${NVIDIA_BASE_URL:-https://integrate.api.nvidia.com/v1}" ;;
    wafer)      echo "${WAFER_BASE_URL:-https://pass.wafer.ai/v1}" ;;
    opencode)   echo "${OPENCODE_BASE_URL:-https://opencode.ai/zen/go/v1}" ;;
    kimi)       echo "${KIMI_BASE_URL:-https://api.moonshot.ai/v1}" ;;
    *)          echo >&2 "[provider] Unknown provider: ${p}"; return 1 ;;
  esac
}

_provider_key() {
  local p
  p="$(_lower "$1")"
  case "${p}" in
    openrouter) echo "${OPENROUTER_API_KEY:-}" ;;
    zenmux)     echo "${ZENMUX_API_KEY:-}" ;;
    nebius)     echo "${NEBIUS_API_KEY:-}" ;;
    nvidia)     echo "${NVIDIA_API_KEY:-}" ;;
    wafer)      echo "${WAFER_API_KEY:-}" ;;
    opencode)   echo "${OPENCODE_API_KEY:-}" ;;
    kimi)       echo "${KIMI_API_KEY:-}" ;;
    *)          echo >&2 "[provider] Unknown provider: ${p}"; return 1 ;;
  esac
}

# Check if a provider is configured (has both key and URL)
_provider_ready() {
  local p
  p="$(_lower "$1")"
  local url key
  url="$(_provider_url "${p}" 2>/dev/null)" || return 1
  key="$(_provider_key "${p}" 2>/dev/null)" || return 1
  [[ -n "${url}" && -n "${key}" ]]
}

# ═══════════════════════════════════════════════════════════════════
# ROLE RESOLUTION
# Resolves a role name → (provider, model) from env vars
# ═══════════════════════════════════════════════════════════════════

# Usage: _resolve_role <ROLE>
# Reads: ${ROLE}_PROVIDER, ${ROLE}_MODEL from env
# Prints: provider model (space-separated)
_resolve_role() {
  local role="${1:?role required}"
  local role_upper
  role_upper="$(_upper "${role}")"

  local provider_var="${role_upper}_PROVIDER"
  local model_var="${role_upper}_MODEL"

  local provider
  provider="$(_getvar "${provider_var}" "openrouter")"
  provider="$(_lower "${provider}")"

  local model
  model="$(_getvar "${model_var}" "")"

  # Defaults per role if model not set
  if [[ -z "${model}" ]]; then
    case "${role_upper}" in
      ORCHESTRATOR) model="anthropic/claude-sonnet-4" ;;
      SUBAGENT)     model="google/gemini-2.5-flash" ;;
      REVIEWER)     model="anthropic/claude-sonnet-4" ;;
      *)            model="anthropic/claude-sonnet-4" ;;
    esac
  fi

  echo "${provider} ${model}"
}

# ═══════════════════════════════════════════════════════════════════
# BUILD PROVIDER CHAIN
# For a given role, builds: [primary_provider, fallback_1, fallback_2, ...]
# Deduplicates — primary is always first, fallbacks follow
# ═══════════════════════════════════════════════════════════════════

_build_provider_chain() {
  local primary="${1:?primary provider required}"
  local result="${primary}"

  # Parse fallback list
  local fallback_str="${FALLBACK_PROVIDERS:-}"
  if [[ -z "${fallback_str}" ]]; then
    echo "${result}"
    return
  fi

  local IFS=','
  for fb in ${fallback_str}; do
    fb="$(_trim "${fb}")"
    fb="$(_lower "${fb}")"
    [[ -z "${fb}" ]] && continue
    # Skip if already in result (dedup)
    case " ${result} " in
      *" ${fb} "*) continue ;;
    esac
    result="${result} ${fb}"
  done

  echo "${result}"
}

# ═══════════════════════════════════════════════════════════════════
# CORE API CALL
# Sends a chat completion request to a specific provider
# ═══════════════════════════════════════════════════════════════════

# Usage: _api_call <provider> <model> <json_body>
# Returns: response content on stdout, 0 on success
_api_call() {
  local provider="${1:?provider required}"
  local model="${2:?model required}"
  local body="${3:?body required}"
  local timeout="${TIMEOUT_SECONDS:-300}"

  local url key
  url="$(_provider_url "${provider}" 2>/dev/null)" || return 1
  key="$(_provider_key "${provider}" 2>/dev/null)" || return 1

  if [[ -z "${url}" || -z "${key}" ]]; then
    echo >&2 "[provider] ${provider}: not configured (missing URL or API key)"
    return 1
  fi

  echo >&2 "[provider] ${provider} → ${model}"

  local response
  response="$(curl -s -w "\n%{http_code}" \
    --max-time "${timeout}" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${key}" \
    -d "${body}" \
    "${url}/chat/completions" 2>/dev/null)" || {
      echo >&2 "[provider] ${provider}: curl failed"
      return 1
    }

  local http_code
  http_code="$(echo "${response}" | tail -1)"
  local json_body
  json_body="$(echo "${response}" | sed '$d')"

  if [[ "${http_code}" == "200" ]]; then
    local content
    content="$(echo "${json_body}" | python3 -c '
import sys, json
data = json.load(sys.stdin)
print(data["choices"][0]["message"]["content"])
' 2>/dev/null)" || {
      echo >&2 "[provider] ${provider}: failed to parse response JSON"
      return 1
    }
    echo "${content}"
    return 0
  else
    echo >&2 "[provider] ${provider}: HTTP ${http_code}"
    # Print error details if available
    echo "${json_body}" | python3 -c '
import sys, json
try:
    data = json.load(sys.stdin)
    err = data.get("error", {})
    if isinstance(err, dict):
        msg = err.get("message", "")
    else:
        msg = str(err)
    if msg:
        print(f"  → {msg}", file=sys.stderr)
except: pass
' 2>/dev/null || true
    return 1
  fi
}

# ═══════════════════════════════════════════════════════════════════
# ROLE-BASED CALL WITH FALLBACK
# The main entry point for the pipeline
# ═══════════════════════════════════════════════════════════════════

# Usage: role_call <role> <system_prompt_file> <user_prompt_file> [output_file]
#
# <role>: orchestrator | subagent | reviewer | any custom role
#   Looks up: ${ROLE}_PROVIDER, ${ROLE}_MODEL from .env
#
# Falls back through FALLBACK_PROVIDERS on failure.
role_call() {
  local role="${1:?role required (orchestrator|subagent|reviewer)}"
  local system_file="${2:?system prompt file required}"
  local user_file="${3:?user prompt file required}"
  local output_file="${4:-}"
  local max_tokens="${MAX_TOKENS_PER_CALL:-8192}"

  # Resolve role → provider + model
  local resolved
  resolved="$(_resolve_role "${role}")"
  local primary_provider="${resolved%% *}"
  local model="${resolved#* }"

  # Read and JSON-escape prompts (errors='replace' handles non-UTF-8 bytes in external material)
  local system_prompt user_prompt

  # Inject AGENTS.md to prevent context poisoning and provide security framework
  local agents_md=""
  
  # Search for AGENTS.md from PWD upwards
  local current_dir="${PWD}"
  local target_agents=""
  while [[ "${current_dir}" != "/" ]]; do
    if [[ -f "${current_dir}/AGENTS.md" ]]; then
      target_agents="${current_dir}/AGENTS.md"
      break
    fi
    current_dir="$(dirname "${current_dir}")"
  done
  
  if [[ -n "${target_agents}" ]]; then
    agents_md="$(cat "${target_agents}")"$'\n\n---\n\n'
    echo >&2 "[provider] Injected context from ${target_agents}"
  fi

  local camofox_md=""
  
  # Search for camofox-stack/SKILL.md from PWD upwards
  local target_camofox=""
  current_dir="${PWD}"
  while [[ "${current_dir}" != "/" ]]; do
    if [[ -f "${current_dir}/.agents/skills/camofox-stack/SKILL.md" ]]; then
      target_camofox="${current_dir}/.agents/skills/camofox-stack/SKILL.md"
      break
    fi
    current_dir="$(dirname "${current_dir}")"
  done

  if [[ -n "${target_camofox}" ]]; then
    camofox_md="# CAMOFOX STEALTH AUTOMATION SKILL"$'\n'"$(cat "${target_camofox}")"$'\n'"You have full authorization to write and execute camofox CLI scripts to bypass bot detection when sourcing new intelligence for the target document."$'\n\n---\n\n'
    echo >&2 "[provider] Injected stealth skills from ${target_camofox}"
  fi

  system_prompt="$(python3 -c '
import sys,json
content = sys.argv[1] + sys.argv[2] + sys.stdin.buffer.read().decode("utf-8", errors="replace")
print(json.dumps(content))
' "${agents_md}" "${camofox_md}" < "${system_file}")"

  user_prompt="$(python3 -c 'import sys,json; print(json.dumps(sys.stdin.buffer.read().decode("utf-8", errors="replace")))' < "${user_file}")"

  # Build request body
  local body
  body=$(cat <<ENDJSON
{
  "model": "${model}",
  "max_tokens": ${max_tokens},
  "messages": [
    {"role": "system", "content": ${system_prompt}},
    {"role": "user", "content": ${user_prompt}}
  ]
}
ENDJSON
)

  # Build provider chain: primary first, then fallbacks
  local chain
  chain="$(_build_provider_chain "${primary_provider}")"

  echo >&2 "[${role}] Model: ${model} | Chain: ${chain}"

  for provider in ${chain}; do
    if ! _provider_ready "${provider}"; then
      echo >&2 "[${role}] Skipping ${provider} (not configured)"
      continue
    fi

    local content
    if content="$(_api_call "${provider}" "${model}" "${body}")"; then
      if [[ -n "${output_file}" ]]; then
        echo "${content}" > "${output_file}"
        echo >&2 "[${role}] ✓ ${provider}/${model} → ${output_file}"
      else
        echo "${content}"
      fi
      return 0
    fi
  done

  echo >&2 "[${role}] ✗ All providers exhausted for ${model}"
  return 1
}

# ═══════════════════════════════════════════════════════════════════
# CONVENIENCE WRAPPERS
# One-liner calls for each pipeline role
# ═══════════════════════════════════════════════════════════════════

# orchestrator_call <system_file> <user_file> [output_file]
orchestrator_call() {
  role_call "orchestrator" "$@"
}

# subagent_call <system_file> <user_file> [output_file]
subagent_call() {
  role_call "subagent" "$@"
}

# reviewer_call <system_file> <user_file> [output_file]
reviewer_call() {
  role_call "reviewer" "$@"
}

# ═══════════════════════════════════════════════════════════════════
# DIAGNOSTICS
# Run this script directly to see provider status
# ═══════════════════════════════════════════════════════════════════

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo ""
  echo "╔══════════════════════════════════════════════════╗"
  echo "║  Provider Diagnostics                            ║"
  echo "╚══════════════════════════════════════════════════╝"
  echo ""

  echo "── Provider Status ─────────────────────────────────"
  for p in openrouter zenmux nebius nvidia wafer opencode kimi; do
    if _provider_ready "${p}"; then
      url="$(_provider_url "${p}")"
      echo "  ✓ ${p}: READY (${url})"
    else
      echo "  ✗ ${p}: NOT CONFIGURED"
    fi
  done

  echo ""
  echo "── Role Assignments ────────────────────────────────"
  for role in orchestrator subagent reviewer; do
    resolved="$(_resolve_role "${role}")"
    prov="${resolved%% *}"
    mod="${resolved#* }"
    status="✓"
    _provider_ready "${prov}" || status="✗ (provider not configured!)"
    echo "  ${role}:"
    echo "    Provider: ${prov} ${status}"
    echo "    Model:    ${mod}"
  done

  echo ""
  echo "── Fallback Chain ──────────────────────────────────"
  echo "  ${FALLBACK_PROVIDERS:-<none>}"

  echo ""
  echo "── Execution Limits ────────────────────────────────"
  echo "  MAX_ITERATIONS:      ${MAX_ITERATIONS:-5}"
  echo "  MAX_TOKENS_PER_CALL: ${MAX_TOKENS_PER_CALL:-8192}"
  echo "  TIMEOUT_SECONDS:     ${TIMEOUT_SECONDS:-300}"
  echo "  PARALLEL_AGENTS:     ${PARALLEL_AGENTS:-4}"
  echo ""
fi
