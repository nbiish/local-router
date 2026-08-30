---
name: skyvern
description: >
  AI-powered browser automation using Skyvern (self-hosted only). Automate web workflows, fill forms,
  extract data, and navigate multi-step processes using Vision LLMs and Playwright. Skyvern uses a
  Planner→Agent→Validator multi-agent architecture with computer vision to interact with web pages
  semantically — no brittle CSS/XPath selectors. All LLM inference routes through LiteLLM; use
  OpenRouter, Ollama, any OpenAI-compatible endpoint, or your own proxy (ZenMux, Z.AI, Nebius, etc.).
  Never use the Skyvern cloud API. Always self-host.
version: 2.0.0
---

# Skyvern — AI Browser Automation (Self-Hosted Expert Reference)

> **Policy**: We NEVER use Skyvern's hosted cloud API (`api.skyvern.com`). All deployments are
> self-hosted, routing LLM calls through our own providers: OpenRouter, ZenMux, Z.AI, Nebius Token
> Factory, Ollama, or any OpenAI-compatible endpoint.

## Instructions

### Step 1: Fetch Latest Docs (Always)

Before implementing, use web tools to pull current state from these canonical sources:

| Source | URL | Purpose |
|--------|-----|---------|
| **llms.txt** | `https://skyvern.com/docs/llms.txt` | Full documentation index — start here |
| **GitHub** | `https://github.com/Skyvern-AI/skyvern` | Source code, `.env.example`, `config_registry.py` |
| **Docs (new)** | `https://docs-new.skyvern.com` | Developer docs, self-hosted guides |
| **Docs (legacy)** | `https://docs.skyvern.com` | Cloud UI docs, workflow block reference |
| **PyPI** | `https://pypi.org/project/skyvern` | Latest version (currently v1.0.32+) |

### Step 2: Architecture Deep Dive

#### 2.1 How Skyvern Works

Skyvern is inspired by BabyAGI/AutoGPT but adds real browser control via Playwright. It uses a
**swarm of agents** to comprehend a website, plan actions, and execute them:

```
┌─────────────────────────────────────────────────────┐
│                  Skyvern 2.0 Engine                 │
│                                                     │
│  ┌──────────┐   ┌──────────┐   ┌──────────────┐    │
│  │ Planner  │──→│  Agent   │──→│  Validator   │    │
│  │  Agent   │   │ (Actor)  │   │   Agent      │    │
│  └──────────┘   └──────────┘   └──────────────┘    │
│       │              │               │              │
│       └──────────────┴───────────────┘              │
│                      │                              │
│              ┌───────▼───────┐                      │
│              │   Playwright  │                      │
│              │   (Browser)   │                      │
│              └───────────────┘                      │
│                      │                              │
│              ┌───────▼───────┐                      │
│              │   LiteLLM     │ ◄── All LLM calls    │
│              │   (Gateway)   │     route through     │
│              └───────────────┘     this layer        │
└─────────────────────────────────────────────────────┘
```

**Key advantages:**
1. **Zero-shot** — operates on websites never seen before
2. **Layout-resistant** — no XPath/CSS selectors; vision-based element discovery
3. **Multi-site reusable** — one workflow runs across different websites
4. **Computer Vision** — screenshots → LLM reasoning → action plan → Playwright execution

#### 2.2 Core Concepts

| Concept | Description |
|---------|-------------|
| **Task** | Single automation job: `prompt` (required) + `url` (optional) + optional `data_extraction_schema` |
| **Workflow** | Multi-step pipeline of chained blocks, built visually or via API |
| **Block** | Atomic unit inside a workflow (see Block Taxonomy below) |
| **Run** | Single execution of a task or workflow, with status tracking |
| **Browser Session** | Persistent Chromium instance; cookies/auth state survive across pages |
| **Browser Profile** | Saved browser state (cookies, storage) reusable across runs |
| **Credential** | Stored passwords, credit cards, TOTP seeds (via Bitwarden/1Password/custom) |
| **Artifact** | Output from a run: screenshots, recordings, downloaded files, logs |
| **Engine** | Skyvern 1.0 (legacy) vs 2.0 (Planner→Agent→Validator, recommended) |

#### 2.3 Workflow Block Taxonomy

| Category | Blocks |
|----------|--------|
| **Browser Automation** | Browser Task, Browser Action, Extraction, Login, Go to URL, Print Page |
| **Data & Extraction** | Text Prompt (LLM-only, no browser), File Parser (PDF/CSV/Excel) |
| **Control Flow** | Loop (for-each), Conditional (if/else), AI Validation, Code (Python/Playwright), Wait |
| **Files** | File Download, Cloud Storage Upload |
| **Communication** | Send Email, HTTP Request, Human Interaction (pause for manual intervention) |

**Browser Task** (recommended block): accepts natural-language prompt, autonomously navigates.
- Skyvern 2.0 fields: URL, Prompt, Max Steps, Disable Cache
- Skyvern 1.0 fields: URL, Prompt + Advanced (completion condition, action history, download triggers)

**Browser Action**: single granular action (click, type, select, upload) — no goal-seeking.

**Extraction**: turns current page content into structured JSON without navigation.

---

### Step 3: Self-Hosted Deployment

#### 3.1 Option A: pip install (Recommended for dev)

```bash
pip install skyvern  # or: uv pip install skyvern
skyvern quickstart   # interactive wizard: DB, LLM provider, browser mode, MCP
```

The quickstart wizard will:
1. Set up database (SQLite default since v1.0.31+, or PostgreSQL)
2. Configure your LLM provider via `.env`
3. Choose browser mode (headless, headful, connect to existing Chrome)
4. Generate local API credentials (`SKYVERN_API_KEY`)
5. Optionally configure MCP for Claude Code/Desktop/Cursor/Windsurf
6. Download Chromium browser

#### 3.2 Option B: Docker Compose

```bash
git clone https://github.com/Skyvern-AI/skyvern.git && cd skyvern
cp .env.example .env
# Edit .env — configure LLM provider (see Step 4)
docker compose up -d
# UI at http://localhost:8080
```

#### 3.3 Option C: Kubernetes

Helm charts and manifests in `kubernetes-deployment/` directory. See docs for scaling config.

---

### Step 4: LLM Configuration (BYOM — Bring Your Own Model)

> **Critical**: All LLM routing goes through **LiteLLM** internally. The `LLMConfigRegistry`
> (at `skyvern/forge/sdk/api/llm/config_registry.py`, ~1946 lines) registers model configs
> at startup based on `ENABLE_*` environment flags.

#### 4.1 Supported Provider Matrix

| Provider | Enable Flag | Key Env Vars | `LLM_KEY` Value |
|----------|-------------|--------------|-----------------|
| **OpenRouter** ⭐ | `ENABLE_OPENROUTER=true` | `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | `OPENROUTER` |
| **OpenAI-Compatible** ⭐ | `ENABLE_OPENAI_COMPATIBLE=true` | `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_API_BASE`, `OPENAI_COMPATIBLE_MODEL_NAME` | `OPENAI_COMPATIBLE` (or custom via `OPENAI_COMPATIBLE_MODEL_KEY`) |
| **Ollama** | `ENABLE_OLLAMA=true` | `OLLAMA_SERVER_URL`, `OLLAMA_MODEL` | `OLLAMA` |
| **Anthropic** | `ENABLE_ANTHROPIC=true` | `ANTHROPIC_API_KEY` | `ANTHROPIC_CLAUDE4.6_SONNET`, etc. |
| **OpenAI** | `ENABLE_OPENAI=true` | `OPENAI_API_KEY` | `OPENAI_GPT5`, `OPENAI_GPT4_1`, etc. |
| **Gemini** | `ENABLE_GEMINI=true` | `GEMINI_API_KEY` | `GEMINI_3_1_PRO`, `GEMINI_3_FLASH`, etc. |
| **Azure OpenAI** | `ENABLE_AZURE=true` | `AZURE_API_KEY`, `AZURE_DEPLOYMENT`, `AZURE_API_BASE`, `AZURE_API_VERSION` | `AZURE_OPENAI` |
| **AWS Bedrock** | `ENABLE_BEDROCK=true` | AWS credentials | `BEDROCK_ANTHROPIC_CLAUDE4.5_SONNET_INFERENCE_PROFILE` |
| **Groq** | `ENABLE_GROQ=true` | `GROQ_API_KEY`, `GROQ_MODEL` | `GROQ` |
| **Moonshot** | `ENABLE_MOONSHOT=true` | `MOONSHOT_API_KEY` | `MOONSHOT_KIMI_K2` |
| **Inception** | `ENABLE_INCEPTION=true` | `INCEPTION_API_KEY` | `INCEPTION_MERCURY_2` |
| **Volcengine** | `ENABLE_VOLCENGINE=true` | `VOLCENGINE_API_KEY` | — |

#### 4.2 OpenRouter Configuration (Our Primary Path)

```bash
# .env
ENABLE_OPENROUTER=true
LLM_KEY=OPENROUTER
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=minimax/minimax-m2.5  # Any model on OpenRouter
# OPENROUTER_API_BASE=https://openrouter.ai/api/v1  # default
```

**Under the hood** — the `config_registry.py` registers it as:
```python
LLMConfigRegistry.register_config(
    "OPENROUTER",
    LLMConfig(
        "openrouter/{model_name}",
        ["OPENROUTER_API_KEY", "OPENROUTER_MODEL"],
        supports_vision=settings.LLM_CONFIG_SUPPORT_VISION,
        max_completion_tokens=settings.LLM_CONFIG_MAX_TOKENS,
        litellm_params=LiteLLMParams(
            api_key=settings.OPENROUTER_API_KEY,
            api_base=settings.OPENROUTER_API_BASE,
            model_info={"model_name": f"openrouter/{model_name}"},
        ),
    ),
)
```

**Dynamic OpenRouter model resolution**: If `LLM_KEY` starts with `openrouter/`, the registry
creates a config on-the-fly without needing explicit registration.

#### 4.3 OpenAI-Compatible Endpoint (ZenMux, Z.AI, Nebius, LM Studio, vLLM, etc.)

```bash
# .env
ENABLE_OPENAI_COMPATIBLE=true
LLM_KEY=OPENAI_COMPATIBLE

# Required
OPENAI_COMPATIBLE_API_KEY=your-key-here
OPENAI_COMPATIBLE_API_BASE=https://your-proxy.example.com/v1
OPENAI_COMPATIBLE_MODEL_NAME=your-model-name

# Optional
OPENAI_COMPATIBLE_MODEL_KEY=OPENAI_COMPATIBLE    # Custom registry key
OPENAI_COMPATIBLE_SUPPORTS_VISION=true            # Enable vision support
OPENAI_COMPATIBLE_ADD_ASSISTANT_PREFIX=false
OPENAI_COMPATIBLE_MAX_TOKENS=128000
OPENAI_COMPATIBLE_TEMPERATURE=0.7
OPENAI_COMPATIBLE_REASONING_EFFORT=medium
OPENAI_COMPATIBLE_API_VERSION=                    # If needed
```

**Under the hood** — registers with `openai/` prefix for LiteLLM routing:
```python
LLMConfig(
    f"openai/{openai_compatible_model_name}",  # LiteLLM requires this prefix
    required_env_vars,
    supports_vision=settings.OPENAI_COMPATIBLE_SUPPORTS_VISION,
    litellm_params=LiteLLMParams(
        api_key=settings.OPENAI_COMPATIBLE_API_KEY,
        api_base=settings.OPENAI_COMPATIBLE_API_BASE,
        model_info={"model_name": f"openai/{openai_compatible_model_name}"},
    ),
)
```

#### 4.4 Ollama (Fully Local)

```bash
# .env
ENABLE_OLLAMA=true
LLM_KEY=OLLAMA
OLLAMA_SERVER_URL=http://localhost:11434
OLLAMA_MODEL=llava:latest
OLLAMA_SUPPORTS_VISION=true
```

#### 4.5 Multi-Model Setup

Skyvern supports `LLM_KEY` for the primary model and `SECONDARY_LLM_KEY` for mini agents:

```bash
LLM_KEY=OPENROUTER                         # Primary (Planner + Actor)
SECONDARY_LLM_KEY=OLLAMA                   # Secondary (mini validation tasks)
LLM_CONFIG_MAX_TOKENS=128000               # Global max tokens override
```

#### 4.6 General LLM Tuning Variables

| Variable | Type | Description | Default |
|----------|------|-------------|---------|
| `LLM_KEY` | string | Primary model registry key | — |
| `SECONDARY_LLM_KEY` | string | Mini agent model | — |
| `LLM_CONFIG_MAX_TOKENS` | int | Max tokens override | `128000` |
| `LLM_CONFIG_TEMPERATURE` | float | Temperature | — |
| `LLM_CONFIG_SUPPORT_VISION` | bool | Vision support flag | — |
| `LLM_CONFIG_ADD_ASSISTANT_PREFIX` | bool | Add assistant prefix to messages | — |

---

### Step 5: SDK Usage (Playwright + AI Hybrid)

Skyvern's SDK is a **Playwright extension** that adds AI-powered commands.

#### 5.1 Python SDK — Three Interaction Modes

```python
from skyvern import Skyvern

# Self-hosted local mode (our standard)
skyvern = Skyvern.local()
# Or explicit:
skyvern = Skyvern(
    base_url="http://localhost:8000",
    api_key="YOUR_LOCAL_SKYVERN_API_KEY"
)

browser = await skyvern.launch_cloud_browser()
page = await browser.get_working_page()

# Mode 1: Traditional Playwright (CSS/XPath selectors)
await page.goto("https://example.com")
await page.click("#submit-button")

# Mode 2: AI-powered (natural language)
await page.click(prompt="Click the green Submit button")

# Mode 3: AI fallback (tries selector first, AI if it fails)
await page.click("#submit-btn", prompt="Click the Submit button")
```

#### 5.2 Core AI Page Commands

| Command | Description |
|---------|-------------|
| `page.act(prompt)` | Perform multi-step actions via natural language |
| `page.extract(prompt, schema)` | Extract structured data with optional JSON schema |
| `page.validate(prompt)` | Validate page state, returns `bool` |
| `page.prompt(prompt, schema)` | Send arbitrary prompts to the LLM |

#### 5.3 Agent-Level Commands

| Command | Description |
|---------|-------------|
| `page.agent.run_task(prompt)` | Execute complex multi-step tasks |
| `page.agent.login(cred_type, cred_id)` | Authenticate with stored credentials |
| `page.agent.download_files(prompt)` | Navigate and download files |
| `page.agent.run_workflow(workflow_id)` | Execute pre-built workflows |

#### 5.4 Simple Task Execution

```python
from skyvern import Skyvern

skyvern = Skyvern()
task = await skyvern.run_task(
    prompt="Find the top post on hackernews today",
    data_extraction_schema={
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "url": {"type": "string"},
            "points": {"type": "integer"}
        }
    }
)
print(task)
```

#### 5.5 TypeScript SDK

```typescript
import { Skyvern } from "@skyvern/client";

const skyvern = new Skyvern({
    baseUrl: "http://localhost:8000",
    apiKey: "YOUR_LOCAL_KEY"
});
const browser = await skyvern.launchCloudBrowser();
const page = await browser.getWorkingPage();

await page.goto("https://example.com");
await page.agent.runTask("Complete checkout with: John Snow, 12345");
await browser.close();
```

#### 5.6 REST API (Self-Hosted)

```bash
# Create a task
curl -X POST "http://localhost:8000/api/v1/tasks" \
  -H "Authorization: Bearer $SKYVERN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "navigation_goal": "Find the pricing page and extract all plan details",
    "data_extraction_schema": {
      "type": "object",
      "properties": {
        "plans": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": {"type": "string"},
              "price": {"type": "string"}
            }
          }
        }
      }
    }
  }'

# Get task result
curl "http://localhost:8000/api/v1/tasks/{task_id}" \
  -H "Authorization: Bearer $SKYVERN_API_KEY"
```

#### 5.7 Task Parameters Reference

| Parameter | Type | Description |
|-----------|------|-------------|
| `prompt` | string (required) | Natural language instructions |
| `url` | string | Starting URL |
| `engine` | string | `skyvern_2.0` (default) or `skyvern_1.0` |
| `data_extraction_schema` | object | JSON schema for structured output |
| `max_steps` | int | Maximum AI steps (default: 50) |
| `proxy_location` | string | Proxy/geolocation |
| `browser_session_id` | string | Reuse existing browser session |
| `totp_identifier` / `totp_url` | string | 2FA configuration |
| `error_code_mapping` | object | Custom error codes to halt execution |
| `webhook_url` | string | Callback URL for results |
| `run_with` | string | `agent` or `code` |
| `model` | string | Override LLM model for this task |
| `browser_address` | string | CDP address for local browser |

#### 5.8 Run Status Values

`queued` → `running` → `completed` | `failed` | `terminated` | `timed_out` | `canceled`

---

### Step 6: MCP Server

Skyvern exposes an MCP server for integration with Claude Code, Claude Desktop, Cursor, Windsurf,
Codex, Hermes, and OpenClaw.

#### 6.1 Configuration

```json
{
  "mcpServers": {
    "Skyvern": {
      "command": "/path/to/python3",
      "args": ["-m", "skyvern", "run", "mcp"],
      "env": {
        "SKYVERN_BASE_URL": "http://localhost:8000",
        "SKYVERN_API_KEY": "YOUR_LOCAL_KEY"
      }
    }
  }
}
```

| Client | Config Path |
|--------|------------|
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Code (project) | `.mcp.json` in project root |
| Claude Code (global) | `~/.claude.json` |
| Codex (global) | `~/.codex/config.toml` |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |

#### 6.2 Quickstart MCP auto-setup

During `skyvern quickstart`, if you choose Claude Code, it will:
- Write `.mcp.json` in project root
- Pin the MCP command to the active Python interpreter
- Install bundled skills into `.claude/skills/`

---

### Step 7: Browser Configuration

```bash
# .env options
BROWSER_TYPE=chromium-headful          # or: chromium-headless, cdp-connect
BROWSER_STREAMING_MODE=vnc             # or: cdp
BROWSER_ACTION_TIMEOUT_MS=5000
MAX_STEPS_PER_RUN=50
VIDEO_PATH=./videos
MAX_SCRAPING_RETRIES=0

# Connect to existing Chrome (local dev)
BROWSER_TYPE=cdp-connect
BROWSER_REMOTE_DEBUGGING_URL=http://127.0.0.1:9222
```

---

### Step 8: Credential Management

Skyvern supports stored credentials for automated login:

| Type | Support |
|------|---------|
| **Bitwarden / Vaultwarden** | Built-in integration |
| **1Password** | Via `OP_SERVICE_ACCOUNT_TOKEN` |
| **Custom HTTP API** | `CREDENTIAL_VAULT_TYPE=custom`, `CUSTOM_CREDENTIAL_API_BASE_URL`, `CUSTOM_CREDENTIAL_API_TOKEN` |
| **TOTP / 2FA** | QR-based, email-based, SMS-based |

---

### Step 9: CLI Commands

```bash
skyvern quickstart        # Interactive setup wizard
skyvern init              # Setup-only (no service start)
skyvern run all           # Start server + UI
skyvern run server        # Start API server only
skyvern run ui            # Start frontend only
skyvern status            # Check service status
skyvern stop all          # Stop everything
skyvern init browser      # Setup Chrome remote debugging
skyvern browser serve --tunnel  # Start Chrome + tunnel
```

---

## Guardrail

Do NOT install Skyvern inside the `ainish-coder` codebase. This codebase is strictly a tool
orchestrator. This skill is meant for target repositories where the agent is deployed.

**Never use `api.skyvern.com` or any Skyvern cloud API key.** Always self-host with your own
LLM provider credentials.

---

## Troubleshooting

### 1. LLM Configuration Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| `LLM Provider NOT provided. You passed model=OPENAI_COMPATIBLE` | Docker image too old or model not registered | Pull latest image: `docker pull skyvern/skyvern:latest`. Ensure `ENABLE_OPENAI_COMPATIBLE=true` is set |
| `Using general model configuration for unknown LLM key` | `LLM_KEY` value doesn't match a registered config | Check `config_registry.py` for valid keys. For OpenAI-compatible, the `openai/` prefix is added automatically |
| OpenRouter model not found | Model slug doesn't match | Verify model exists at `openrouter.ai/models`. Use format: `vendor/model-name` |
| Vision not working | Provider doesn't support vision | Set `LLM_CONFIG_SUPPORT_VISION=true` or `OPENAI_COMPATIBLE_SUPPORTS_VISION=true` |
| Timeout during inference | Model too slow or rate-limited | Increase `MAX_STEPS_PER_RUN`, use faster model, check rate limits |

### 2. Docker Issues

| Issue | Fix |
|-------|-----|
| `table organizations already exists` | `rm ~/.skyvern/data.db` + upgrade to v1.0.32+ |
| Port conflict | Check `docker ps` for conflicting Postgres. Change `PORT=8000` in `.env` |
| `.env` not loaded in compose | Ensure `env_file:` directive in `docker-compose.yml` |

### 3. SDK / API Issues

| Issue | Fix |
|-------|-----|
| `pip install skyvern` fails (ResolutionImpossible) | Use `uv pip install skyvern` or upgrade to v1.0.32+ |
| SDK import error | Activate correct `.venv`; Python 3.11/3.12 only (not 3.13) |
| Task returns empty extraction | Verify `data_extraction_schema` matches page structure |
| Browser automation hangs | Check `BROWSER_ACTION_TIMEOUT_MS`; break complex tasks into smaller steps |

### 4. Diagnostic Steps

1. Verify LLM connectivity: test your provider endpoint directly with curl
2. Check Skyvern logs: `docker compose logs skyvern` or server stdout
3. Verify `.env` is complete: compare against `.env.example` in the repo
4. Fetch latest docs: `https://skyvern.com/docs/llms.txt`
5. Search codebase: `Grep("skyvern")` to find deployment/config issues

---

## Examples

- "Automate filling out this insurance form using AI."
- "Extract all product listings from this e-commerce site."
- "Build a workflow to log into a portal, download a report, and email it."
- "Set up Skyvern to monitor a competitor's pricing page daily."
- "Replace our Selenium tests with Skyvern for more resilient automation."
- "Create a workflow that navigates a multi-page signup process."
- "Download all invoices newer than January 1st from a vendor portal."

---

## Guidelines

1. **Always self-host** — never reference `api.skyvern.com` or cloud API keys
2. **Prefer OpenRouter or OpenAI-compatible** for maximum model flexibility
3. Use Skyvern 2.0 engine (Planner→Agent→Validator) for all new tasks
4. Use the Python SDK for programmatic integration; REST API for non-Python
5. Design workflows for reusability — parameterize inputs via workflow parameters
6. Provide clear, specific navigation goals — vague prompts = unreliable automation
7. Handle failures gracefully — check status, implement retries for transient errors
8. Use `data_extraction_schema` to structure output for downstream processing
9. Always fetch `llms.txt` before implementing to verify current API surface
10. When troubleshooting, check `config_registry.py` source for valid `LLM_KEY` values

---

## Requirements

### Self-Hosted (pip)
```bash
pip install skyvern  # or: uv pip install skyvern
```
- Python 3.11.x or 3.12.x (NOT 3.13)
- NodeJS & NPM (for UI)
- LLM provider credentials (OpenRouter, Ollama, or any OpenAI-compatible endpoint)

### Self-Hosted (Docker)
- Docker and Docker Compose
- LLM provider credentials in `.env`
- See `https://github.com/Skyvern-AI/skyvern` for full setup

---

## Resources

| Resource | URL |
|----------|-----|
| **llms.txt** | https://skyvern.com/docs/llms.txt |
| **GitHub** | https://github.com/Skyvern-AI/skyvern |
| **Docs (new)** | https://docs-new.skyvern.com |
| **Docs (legacy)** | https://docs.skyvern.com |
| **API Reference** | https://docs.skyvern.com/api-reference |
| **PyPI** | https://pypi.org/project/skyvern |
| **MCP Docs** | https://www.skyvern.com/docs/getting-started/mcp |
| **LLM Config** | https://www.skyvern.com/docs/self-hosted/llm-configuration |
| **OpenRouter Blog** | https://www.skyvern.com/blog/surprise-launch-day-2-openrouter-support-is-live-in-skyvern/ |
| **config_registry.py** | https://github.com/Skyvern-AI/skyvern/blob/main/skyvern/forge/sdk/api/llm/config_registry.py |
| **.env.example** | https://github.com/Skyvern-AI/skyvern/blob/main/.env.example |
