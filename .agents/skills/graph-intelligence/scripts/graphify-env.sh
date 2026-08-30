#!/usr/bin/env bash
# graphify-env.sh — Bridge the user's provider config + PQC secrets
#                       to graphify LLM backends.
#
# Discovers available LLM providers from:
#   1. ~/.config/ainish-coder/providers.json   (machine-readable; base URLs,
#                                              default models, env key names)
#   2. ~/.config/providers.txt                 (human-readable; canonical key
#                                              env var names per provider)
#   3. PQC secrets bundle at ~/.config/pqc-secrets/secrets.bundle.json
#      (decrypted at runtime via `pqc-secrets export` or `secrets-load` —
#       keys live in macOS Keychain, never on disk)
#
# Exports the env vars graphify needs (OPENAI_API_KEY + OPENAI_BASE_URL,
# GEMINI_API_KEY, ANTHROPIC_API_KEY, MOONSHOT_API_KEY, etc.) and prints
# which backend + provider + model to use.
#
# Usage:
#   secrets-load
#   source scripts/graphify-env.sh
#   graphify extract ./docs
#
# Force a specific provider:
#   GRAPHIFY_PROVIDER=zenmux source scripts/graphify-env.sh
#
# Force a specific graphify backend:
#   GRAPHIFY_BACKEND=openai source scripts/graphify-env.sh
#
# Set a default model:
#   GRAPHIFY_MODEL=google/gemini-3.1-pro-preview source scripts/graphify-env.sh
#
# Environment variables consumed:
#   GRAPHIFY_PROVIDER  — force provider (zenmux, openrouter, kimi, claude, ...)
#   GRAPHIFY_BACKEND   — force graphify backend (openai|gemini|claude|kimi|ollama)
#   GRAPHIFY_MODEL     — model id to pass to graphify via --model
#   PQC_SECRETS_BIN    — path to pqc-secrets binary
#
# Exit codes:
#   0   — at least one provider configured; env vars exported
#   1   — no providers found; help printed
#   2   — forced provider / backend requested but its key is not loaded
#
# Compatible with bash 3.2 (macOS default) — no associative arrays.

set -e

# -----------------------------------------------------------------------------
# Paths
# -----------------------------------------------------------------------------
PROVIDERS_JSON="${HOME}/.config/ainish-coder/providers.json"
PROVIDERS_TXT="${HOME}/.config/providers.txt"
PQC_SECRETS_BIN="${PQC_SECRETS_BIN:-}"
if [[ -z "${PQC_SECRETS_BIN}" ]]; then
  if [[ -x "./bin/pqc-secrets" ]]; then
    PQC_SECRETS_BIN="./bin/pqc-secrets"
  elif command -v pqc-secrets >/dev/null 2>&1; then
    PQC_SECRETS_BIN="$(command -v pqc-secrets)"
  elif [[ -x "${HOME}/.local/bin/pqc-secrets" ]]; then
    PQC_SECRETS_BIN="${HOME}/.local/bin/pqc-secrets"
  fi
fi

# Color helpers (degrade gracefully if no TTY)
if [[ -t 1 ]]; then
  C_BOLD="\033[1m"; C_DIM="\033[2m"; C_RESET="\033[0m"
  C_GREEN="\033[32m"; C_YELLOW="\033[33m"; C_RED="\033[31m"; C_CYAN="\033[36m"
else
  C_BOLD=""; C_DIM=""; C_RESET=""
  C_GREEN=""; C_YELLOW=""; C_RED=""; C_CYAN=""
fi

log()  { printf "${C_DIM}[graphify-env]${C_RESET} %s\n" "$*" >&2; }
ok()   { printf "${C_GREEN}[graphify-env] ✓${C_RESET} %s\n" "$*" >&2; }
warn() { printf "${C_YELLOW}[graphify-env] !${C_RESET} %s\n" "$*" >&2; }
die()  { printf "${C_RED}[graphify-env] ✗${C_RESET} %s\n" "$*" >&2; exit "${2:-1}"; }

# -----------------------------------------------------------------------------
# 1) Source PQC secrets if no API keys are loaded yet
# -----------------------------------------------------------------------------
_secrets_already_loaded() {
  for v in ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY GOOGLE_API_KEY \
           MOONSHOT_API_KEY DEEPSEEK_API_KEY ZENMUX_API_KEY \
           OPENROUTER_API_KEY NEBIUS_API_KEY WAFER_SERVERLESS_API_KEY \
           NVIDIA_NIM_API_KEY MODAL_API_KEY OPENCODE_API_KEY ZAI_API_KEY \
           XIAOMI_MIMO_API_KEY; do
    [[ -n "${!v:-}" ]] && return 0
  done
  return 1
}

if ! _secrets_already_loaded; then
  if [[ -n "${PQC_SECRETS_BIN}" && -x "${PQC_SECRETS_BIN}" ]]; then
    log "Loading PQC secrets via ${PQC_SECRETS_BIN}…"
    if ! eval "$("${PQC_SECRETS_BIN}" export 2>/dev/null)"; then
      warn "pqc-secrets export failed — continuing without secret injection"
    fi
  else
    warn "No API keys in env and no pqc-secrets binary found."
    warn "  Run: secrets-load   (preferred) — or set keys manually"
  fi
fi

# -----------------------------------------------------------------------------
# 2) Provider registry — pipe-delimited, 4 fields per entry:
#    <provider>|<canonical-env-var>|<graphify-backend>|<default-model>
# -----------------------------------------------------------------------------
# Default auto-pick priority. Direct user subscriptions come first
# (cheap, predictable, no aggregator markup), then free local options,
# then aggregators. Override with GRAPHIFY_PROVIDER_PRIORITY.
PROVIDER_REGISTRY=(
  "claude|ANTHROPIC_API_KEY|claude|"
  "gemini|GEMINI_API_KEY|gemini|"
  "zai|ZAI_API_KEY|openai|"
  "xiaomi-mimo|XIAOMI_MIMO_API_KEY|openai|"
  "kimi|MOONSHOT_API_KEY|kimi|"
  "ollama|OLLAMA_BASE_URL|ollama|"
  "zenmux|ZENMUX_API_KEY|openai|"
  "openrouter|OPENROUTER_API_KEY|openai|"
  "wafer-serverless|WAFER_SERVERLESS_API_KEY|openai|"
  "nebius|NEBIUS_API_KEY|openai|"
  "opencode|OPENCODE_API_KEY|openai|"
  "opencode-zen|OPENCODE_API_KEY|openai|"
  "nvidia-nim|NVIDIA_NIM_API_KEY|openai|"
  "modal|MODAL_API_KEY|openai|"
  "deepseek|DEEPSEEK_API_KEY|openai|"
)

# Parse providers.json into temp files (bash 3.2 compat — no associative arrays)
_BASE_URL_TMP="$(mktemp -t graphify-env-baseurl.XXXXXX)"
_DEFAULT_MODEL_TMP="$(mktemp -t graphify-env-defmodel.XXXXXX)"
trap 'rm -f "$_BASE_URL_TMP" "$_DEFAULT_MODEL_TMP"' EXIT

if [[ -f "${PROVIDERS_JSON}" ]] && command -v python3 >/dev/null 2>&1; then
  python3 - "$PROVIDERS_JSON" "$_BASE_URL_TMP" "$_DEFAULT_MODEL_TMP" <<'PY' 2>/dev/null
import json, sys
prov_file, base_out, model_out = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    data = json.load(open(prov_file))
    with open(base_out, "w") as f1, open(model_out, "w") as f2:
        for k, v in data.items():
            url = v.get("baseUrl", "").rstrip("/")
            if url.endswith("/v1"):
                url = url[:-3]
            f1.write(f"{k}\t{url}\n")
            f2.write(f"{k}\t{v.get('defaultModel', '')}\n")
except Exception as e:
    pass
PY
  log "Loaded providers from ${PROVIDERS_JSON}"
else
  warn "providers.json not found at ${PROVIDERS_JSON} — using fallback base URLs"
  cat > "$_BASE_URL_TMP" <<'EOF'
wafer-serverless	https://pass.wafer.ai
zenmux	https://zenmux.ai/api
nebius	https://api.tokenfactory.nebius.com
moonshot	https://api.moonshot.ai
nvidia-nim	https://integrate.api.nvidia.com
modal	https://api.us-west-2.modal.direct
openrouter	https://openrouter.ai/api
opencode	https://opencode.ai/zen/go
opencode-zen	https://opencode.ai/zen
zai	https://api.z.ai/api/coding/paas
ollama	http://127.0.0.1:11435
xiaomi-mimo	https://token-plan-sgp.xiaomimimo.com
EOF
fi

# Read providers.txt for canonical env var names (override registry defaults)
_TXT_ENV_TMP="$(mktemp -t graphify-env-txtenv.XXXXXX)"
trap 'rm -f "$_BASE_URL_TMP" "$_DEFAULT_MODEL_TMP" "$_TXT_ENV_TMP"' EXIT

if [[ -f "${PROVIDERS_TXT}" ]]; then
  awk -F'│' '
    /^\s*│/ && !/Provider/ && !/Key Env Var/ && !/Model ID/ {
      gsub(/^[ \t]+|[ \t]+$/, "", $2);
      gsub(/^[ \t]+|[ \t]+$/, "", $4);
      if (length($2) > 0 && length($4) > 0) print $2 "\t" $4;
    }
  ' "${PROVIDERS_TXT}" > "$_TXT_ENV_TMP" 2>/dev/null
  log "Loaded env-var hints from providers.txt"
fi

# Helper: look up a value in a tab-delimited file
_lookup() {
  local file="$1" key="$2"
  awk -F'\t' -v k="$key" '$1 == k { print $2; exit }' "$file" 2>/dev/null
}

# -----------------------------------------------------------------------------
# 3) Discovery — which providers have keys loaded?
# -----------------------------------------------------------------------------
AVAILABLE=()
declare -a HAVE_KEY_PROV HAVE_KEY_VAR
for entry in "${PROVIDER_REGISTRY[@]}"; do
  IFS='|' read -r prov envvar backend defaultmodel <<< "$entry"
  # Override envvar from providers.txt if known
  override="$(_lookup "$_TXT_ENV_TMP" "$prov")"
  [[ -n "$override" ]] && envvar="$override"
  if [[ -n "${!envvar:-}" ]]; then
    AVAILABLE+=("$prov")
    HAVE_KEY_PROV+=("$prov")
    HAVE_KEY_VAR+=("$envvar")
  fi
done

if [[ ${#AVAILABLE[@]} -eq 0 ]]; then
  {
    die "No LLM provider keys detected in environment." 1
    echo
    echo "  No API keys found. Pick one of:"
    echo "    1) Run:  secrets-load       (loads from PQC bundle, default)"
    echo "    2) Set the env var directly, e.g.:"
    echo "         export ZENMUX_API_KEY=..."
    echo "         export ANTHROPIC_API_KEY=..."
    echo "         export GEMINI_API_KEY=..."
    echo "         export MOONSHOT_API_KEY=..."
    echo
    echo "  Provider → env-var mapping (from providers.txt):"
    for entry in "${PROVIDER_REGISTRY[@]}"; do
      IFS='|' read -r prov envvar backend defaultmodel <<< "$entry"
      printf "    %-22s %s\n" "$prov" "$envvar"
    done
  } >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# 4) Pick a provider
# -----------------------------------------------------------------------------
get_backend_for() {
  local prov="$1"
  for entry in "${PROVIDER_REGISTRY[@]}"; do
    IFS='|' read -r p _ b _ <<< "$entry"
    [[ "$p" == "$prov" ]] && { printf "%s" "$b"; return; }
  done
  printf "openai"
}

# Pick order: forced > custom priority > default registry
PROVIDER=""
if [[ -n "${GRAPHIFY_PROVIDER:-}" ]]; then
  # Forced — verify the key is loaded
  found=0
  for k in "${HAVE_KEY_PROV[@]}"; do
    [[ "$k" == "$GRAPHIFY_PROVIDER" ]] && { found=1; break; }
  done
  if [[ $found -eq 0 ]]; then
    die "Forced provider '$GRAPHIFY_PROVIDER' requested but its key is not loaded." 2
  fi
  PROVIDER="$GRAPHIFY_PROVIDER"
elif [[ -n "${GRAPHIFY_PROVIDER_PRIORITY:-}" ]]; then
  # Custom priority list (space-separated). Try each in order;
  # first one with a loaded key wins. Fall through to default if
  # none of the priority list has a key.
  log "Custom priority: ${GRAPHIFY_PROVIDER_PRIORITY}"
  for candidate in ${GRAPHIFY_PROVIDER_PRIORITY}; do
    for k in "${HAVE_KEY_PROV[@]}"; do
      [[ "$k" == "$candidate" ]] && { PROVIDER="$candidate"; break 2; }
    done
  done
  if [[ -z "$PROVIDER" ]]; then
    log "None of the priority list has a loaded key — falling back to default order"
  fi
fi
if [[ -z "$PROVIDER" ]]; then
  # Default: first in registry order that has a key
  for entry in "${PROVIDER_REGISTRY[@]}"; do
    IFS='|' read -r p _ _ _ <<< "$entry"
    for k in "${HAVE_KEY_PROV[@]}"; do
      [[ "$k" == "$p" ]] && { PROVIDER="$p"; break 2; }
    done
  done
  # Fallback to first available
  [[ -z "$PROVIDER" ]] && PROVIDER="${AVAILABLE[0]}"
  log "Auto-selected provider: ${PROVIDER}"
fi

# -----------------------------------------------------------------------------
# 5) Determine env var, base URL, backend, model
# -----------------------------------------------------------------------------
ENV_VAR=""
for i in "${!HAVE_KEY_PROV[@]}"; do
  if [[ "${HAVE_KEY_PROV[$i]}" == "$PROVIDER" ]]; then
    ENV_VAR="${HAVE_KEY_VAR[$i]}"
    break
  fi
done
KEY_VALUE="${!ENV_VAR}"
BASE="$(_lookup "$_BASE_URL_TMP" "$PROVIDER")"
DEFAULT_MODEL="$(_lookup "$_DEFAULT_MODEL_TMP" "$PROVIDER")"
BACKEND="${GRAPHIFY_BACKEND:-$(get_backend_for "$PROVIDER")}"
MODEL="${GRAPHIFY_MODEL:-$DEFAULT_MODEL}"

# -----------------------------------------------------------------------------
# 6) Set env vars graphify expects
# -----------------------------------------------------------------------------
case "$BACKEND" in
  openai)
    export OPENAI_API_KEY="$KEY_VALUE"
    [[ -n "$BASE" ]] && export OPENAI_BASE_URL="$BASE"
    ;;
  gemini)
    export GEMINI_API_KEY="$KEY_VALUE"
    export GOOGLE_API_KEY="$KEY_VALUE"
    ;;
  claude)
    export ANTHROPIC_API_KEY="$KEY_VALUE"
    [[ -n "$BASE" ]] && export ANTHROPIC_BASE_URL="$BASE"
    ;;
  kimi)
    export MOONSHOT_API_KEY="$KEY_VALUE"
    ;;
  ollama)
    [[ -n "$BASE" ]] && export OLLAMA_BASE_URL="$BASE"
    [[ -n "${OLLAMA_API_KEY:-}" ]] && export OLLAMA_API_KEY="$OLLAMA_API_KEY"
    ;;
  bedrock)
    : "${AWS_ACCESS_KEY_ID:?not set}" "${AWS_SECRET_ACCESS_KEY:?not set}"
    ;;
  claude-cli)
    : # uses local claude CLI; no env var
    ;;
  *)
    die "Unknown backend: $BACKEND" 2
    ;;
esac

# -----------------------------------------------------------------------------
# 7) Summary
# -----------------------------------------------------------------------------
SUMMARY_KEY="OPENAI_API_KEY (value hidden)"
case "$BACKEND" in
  gemini)     SUMMARY_KEY="GEMINI_API_KEY (value hidden)" ;;
  claude)     SUMMARY_KEY="ANTHROPIC_API_KEY (value hidden)" ;;
  kimi)       SUMMARY_KEY="MOONSHOT_API_KEY (value hidden)" ;;
  ollama)     SUMMARY_KEY="OLLAMA_BASE_URL=${OLLAMA_BASE_URL:-<unset>}" ;;
  bedrock)    SUMMARY_KEY="AWS credentials (resolved by boto3)" ;;
  claude-cli) SUMMARY_KEY="none (uses local claude CLI)" ;;
esac

{
  printf "${C_BOLD}graphify-env${C_RESET}\n"
  printf "  ${C_DIM}provider:${C_RESET}  %s\n" "$PROVIDER"
  printf "  ${C_DIM}backend:${C_RESET}   %s\n" "$BACKEND"
  printf "  ${C_DIM}env var:${C_RESET}   %s\n" "$SUMMARY_KEY"
  if [[ -n "$BASE" && "$BACKEND" != "ollama" ]]; then
    printf "  ${C_DIM}base URL:${C_RESET}  %s\n" "$BASE"
  fi
  if [[ -n "$MODEL" ]]; then
    printf "  ${C_DIM}model:${C_RESET}    %s\n" "$MODEL"
  fi
  printf "\n"
  printf "${C_DIM}# Run graphify with this backend:${C_RESET}\n"
  printf "${C_CYAN}graphify extract . --backend %s%s${C_RESET}\n" \
    "$BACKEND" "${MODEL:+ --model \"$MODEL\"}"
  printf "${C_CYAN}graphify update . --no-cluster  ${C_DIM}# AST-only, no LLM call${C_RESET}\n\n"
} >&2

# Export the resolved choices for downstream tooling
export GRAPHIFY_RESOLVED_PROVIDER="$PROVIDER"
export GRAPHIFY_RESOLVED_BACKEND="$BACKEND"
export GRAPHIFY_RESOLVED_MODEL="$MODEL"
