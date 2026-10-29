---
name: browser-use
description: Direct browser control via CDP for web interaction: automation, scraping, testing, screenshots, and site/app work across macOS, Linux, and Windows.
homepage: https://browser-use.com
---

# Browser Use

Direct browser control via Chrome DevTools Protocol (CDP). Cross-platform automation across macOS, Linux, and Windows.

> **Zero Credentials in Plaintext**: Never extract credentials, tokens, cookies, or auth secrets from web pages. Any API keys or environment secrets must adhere to the repository's PQC mandate (FIPS 203 ML-KEM-768).
>
> **Companion References**:
> - [Install & Troubleshooting Guide](https://github.com/browser-use/browser-harness/blob/main/install.md)
> - [Interaction Mechanics & Recipes](https://github.com/browser-use/browser-harness/tree/main/interaction-skills)

---

## 1. Fast Setup & Cross-Platform Prerequisites

Install or upgrade `browser-use` to the latest stable release using Python 3.12:

```bash
# macOS / Linux / Windows (POSIX bash or PowerShell with uv)
uv tool install --python 3.12 --upgrade --force browser-use
```

Verify the installation and runtime health:

```bash
browser-use doctor
```

### OS-Specific Setup Notes:
- **macOS**: When local Chrome prompts "Allow remote debugging?", keep the command running and call `browser-use mac-approve` (or `BU_NAME=<name> browser-use mac-approve`) in a separate terminal. If accessibility access is requested, grant permission in **System Settings > Privacy & Security > Accessibility**.
- **Linux**: If Chromium is installed via Snap and blocks CDP, run `browser-use doctor --fix-snap` for instructions or use the native distribution `.deb`/`.rpm` package.
- **Windows**: PowerShell does not support bash `<<'PY'` heredocs directly. Use piping via stdin or PowerShell here-strings:
  ```powershell
  @"
  print(page_info())
  "@ | browser-use
  ```

---

## 2. When to Use (and When Not to)

- **Do NOT use a browser** for basic public info fetching. If a plain HTTP request or `curl` can fetch it (e.g. public APIs, documentation, static pages), use standard fetch tools.
- **DO use `browser-use`** when the task requires interaction (clicking, filling forms, multi-step navigation), authenticated user sessions, client-rendered JavaScript (SPAs), visual screenshots, or bot-sensitive pages.

---

## 3. Core Automation Patterns

### Execution Syntax:
- **POSIX (macOS / Linux / WSL):**
  ```bash
  browser-use <<'PY'
  ensure_real_tab()
  print(page_info())
  PY
  ```
- **PowerShell / Windows:**
  ```powershell
  @"
  ensure_real_tab()
  print(page_info())
  "@ | browser-use
  ```

### Key Workflow Rules:
1. **First Navigation**: Use `new_tab("https://example.com")`, not `goto_url()`. The daemon maintains the attached tab across calls.
2. **Tab Reuse**: Do not spam duplicate tabs. Check `list_tabs()` and `current_tab()`, and use `switch_tab()` to reuse tabs.
3. **Background Control**: `new_tab()` and `switch_tab()` operate in the background without stealing OS focus. Only call `activate_tab()` if the user explicitly requests foreground switching or a page stops rendering when hidden.
4. **Navigation Completion**: Always call `wait_for_load()` after triggering navigation or page loads.

---

## 4. Element Interaction & Inspection

- **AX Tree First (Recommended)**: Query accessibility nodes rather than processing heavy screenshots:
  ```python
  nodes = cdp("Accessibility.getFullAXTree")["nodes"]
  # Filter nodes by role or name to retrieve backendDOMNodeId
  ```
- **Coordinate Clicks**:
  ```python
  box = cdp("DOM.getBoxModel", backendNodeId=node_id)["model"]["content"]
  x, y = sum(box[0::2]) / 4, sum(box[1::2]) / 4
  click_at_xy(x, y)
  ```
- **Form Filling**: For long text, use DOM value updates or batch input methods rather than slow keystroke simulation, then verify with `page_info()` or `js(...)`.
- **Raw CDP Fallback**: Direct CDP method calls are available via `cdp("Domain.method", **kwargs)`.

---

## 5. Local vs. Remote / Cloud Browsers

### Local Chrome / Brave / Edge:
- Ensure remote debugging is active (`chrome://inspect/#remote-debugging`).
- Or pass `BU_CDP_WS=ws://127.0.0.1:<port>/devtools/browser/<id>` to attach directly to an existing browser CDP websocket.

### Remote & Cloud Browsers:
For parallel tasks, headless CI, or avoiding local IP rate-limiting, use Browser Use Cloud:
```bash
# Login once
browser-use auth login

# Start and control named remote browser session
browser-use <<'PY'
start_remote_daemon("task-session-1")
PY

BU_NAME=task-session-1 browser-use <<'PY'
new_tab("https://example.com")
print(page_info())
PY
```
*Always close remote browsers when done to avoid lingering costs:*
```python
stop_remote_daemon("task-session-1")
```

---

## 6. Recordings & Diagnostic Traces

Local background recordings are off by default.
- Check recording status: `browser-use recordings`
- Enable/disable:
  ```bash
  browser-use recordings enable
  browser-use recordings disable
  ```
- Override per command: `BH_RECORD=1 browser-use ...`
- In automation scripts: `start_recording("name", title="...")` and `stop_recording()`.

---

## 7. Common Gotchas & Troubleshooting

1. **Daemon Connection Failure**: Run `browser-use doctor`. Check that Chrome/Brave/Edge is running with remote debugging or that the CDP port is reachable.
2. **Access Denied on Upgrade (Windows)**: If `uv tool install` reports an in-use file lock, run `uv tool uninstall browser-use` followed by `uv tool install --python 3.12 browser-use`.
3. **macOS Remote Debugging Dialog**: Run `browser-use mac-approve` in a separate terminal while the command waits.
4. **Login Walls & MFA**: Stop and prompt the operator for human takeover on 2FA/MFA or account selection rather than guessing credentials.
