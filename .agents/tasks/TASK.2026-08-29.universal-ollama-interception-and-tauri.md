# TASK 2026-08-29: Universal Ollama Tool Interception & Tauri v2 Desktop Application

## 1. Goal
Ensure Local Router functions as a 100% drop-in Ollama & OpenAI & Anthropic interception proxy across all developer tooling (VS Code Copilot, Continue, Cline, Claude Code, fcc-server, omp, OpenCode, Hermes) on Windows, macOS, Linux, and WSL, while providing a native Tauri v2 desktop application with system tray controls.

## 2. Implemented Architecture
- **Tauri v2 Desktop App (`src-tauri/`)**:
  - Full desktop window with centered 1200x820 view on startup.
  - Native system tray context menus and window minimize-on-close to keep background proxy routing alive.
  - Cross-platform autostart initialization (`MacosLauncher::LaunchAgent`).
  - Compiled and verified on both Windows host (MSVC) and Linux/WSL.
- **Anthropic SSE Streaming Format**:
  - Standardized double-newline delimiters (`\n\n`) across all Anthropic stream events (`message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`).
- **Route Normalization**:
  - `POST /messages` and `POST /v1/messages`
  - `GET /models` and `GET /v1/models`
  - `POST /chat/completions` and `POST /v1/chat/completions`
  - `POST /responses` and `POST /v1/responses`
- **Model Cascading**:
  - Generic/standard aliases (`claude-3-5-sonnet*`, `claude-3-7-sonnet*`, `gpt-4o*`, `deepseek*`, `default`) automatically cascade into the user active fallback chain (`local-router/fallback-models`).
- **Cross-Platform Auto-Export**:
  - CLI: `local-router env` (bash/zsh), `local-router env --pwsh`, `local-router env --cmd`, `local-router env --json`.
  - Scripts: `bin/export-env.sh`, `bin/export-env.ps1`, `bin/export-env.cmd`.
  - API: `GET /api/env` (JSON, bash, pwsh, cmd formats).
  - Setup: Windows User registry variables + WSL `~/.config/local-router/env.sh` auto-source in `~/.bashrc`.

## 3. Verification Receipts
- `POST /messages` with `claude-3-5-sonnet-20241022`: 200 OK (Anthropic Messages envelope).
- `POST /v1/messages` (streaming): 200 OK (Anthropic SSE with `\n\n`).
- `POST /chat/completions` with `default`: 200 OK (OpenAI completion).
- `GET /models`: 200 OK (25 active models).
- `GET /api/env`: 200 OK (JSON dictionary).
- `cargo check` (WSL/Linux): Finished dev profile in 23.28s (0 warnings, 0 errors).
- `cargo check` (Windows MSVC): Finished dev profile in 1m 32s (0 warnings, 0 errors).
- `npm test`: 112 / 112 passed.