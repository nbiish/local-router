---
name: browser-skill
description: Drive the user's real Chromium browser through the bsk CLI and BrowserSkill extension. Automate tasks in an isolated Agent Window with existing logins/cookies, borrow user tabs explicitly, extract semantic observations, click, fill, emulate mobile, transfer files, or request human takeover (captcha/2FA).
---

# browser-skill

Drive the user's real Chromium browser (Chrome, Edge, Brave, etc.) through the `bsk` CLI and BrowserSkill browser extension. Automation executes in an isolated **Agent Window** preserving the user's authenticated sessions, logins, and cookies without disrupting user-window tabs (unless explicitly borrowed).

> **Zero Credentials in Plaintext**: Never extract credentials, tokens, cookies, or auth secrets from web pages. Any API keys or environment secrets must adhere to the repository's PQC mandate (FIPS 203 ML-KEM-768).
>
> **Companion References**:
> - [CLI Help Reference](references/cli-help.txt) — Full inventory of `bsk` subcommands and flags.
> - [Doctor Diagnostics Reference](references/doctor-reference.txt) — Healthcheck verification output.
> - [Agent Install Guide](references/AGENT_INSTALL.md) — Upstream setup protocol for agents.
> - [Upstream Project Documentation](references/README.md) — Architectural overview and browser extension store links.

---

## 1. Quick Start & Prerequisites

Verify that `bsk` is available on your PATH and that the background daemon and browser extension are healthy:

```bash
# Run doctor diagnostics
bsk doctor
```

All rows should report `ok` (or `na`). If `extension connected` reports `FAIL` (`0 browsers connected`), prompt the operator to ensure the **BrowserSkill** extension is installed and enabled in Chrome or Edge and has turned green in its extension popup.

### Installation (if missing on a fresh machine):
- **Windows (PowerShell):**
  ```powershell
  irm https://raw.githubusercontent.com/Tencent/BrowserSkill/main/install.ps1 | iex
  bsk install-skill --yes
  ```
- **macOS / Linux:**
  ```bash
  curl -fsSL https://raw.githubusercontent.com/Tencent/BrowserSkill/main/install.sh | sh
  bsk install-skill --yes
  ```

---

## 2. Mandatory Session Lifecycle

Every browser automation task **must** own a bounded session. Do not rely on idle timeouts for cleanup:

```bash
# 1. Start session (capturing the 4-letter session ID, e.g. "a1b2")
bsk session start

# Optional: When multiple browsers exist or background work is desired:
# bsk session start --browser <id-or-label> --no-focus

# 2. Execute session-scoped commands passing --session <id>
bsk navigate https://example.com --session <id>
bsk observe --session <id>
bsk click @e1 --session <id>

# 3. Always terminate the session on both success and error paths
bsk session stop <id>
```

Stopping the session automatically returns borrowed tabs and closes the isolated Agent Window.

---

## 3. The Core Automation Loop: Observe → Act → Observe

Follow this tight feedback loop:
1. **Navigate**: Direct the Agent Window to the target URL.
2. **Observe**: Obtain semantic element refs (`@eN`).
3. **Act**: Click, fill, hover, or select using fresh refs.
4. **Observe Again**: Navigation or significant DOM changes invalidate `@eN` refs. Re-observe before subsequent interactions.

```bash
# Example automation flow
bsk navigate "https://news.ycombinator.com" --session <id>
bsk observe --session <id>

# Click link using element ref @e12
bsk click @e12 --session <id>

# Re-observe changed DOM state
bsk observe --session <id>
```

### Perception & Inspection Levels
Escalate page reading progressively based on task needs:
1. `bsk observe --session <id>`: Standard semantic understanding, readable text, interactive controls, and `@eN` refs.
2. `bsk observe --probe-hover --session <id>`: Active probe hovering likely triggers to reveal CSS/hover-only menus and tooltips.
3. `bsk snapshot --session <id>`: Strict accessibility tree (ARIA snapshot).
4. `bsk get-html --session <id>`: Raw DOM markup / metadata inspection.
5. `bsk screenshot --out screenshot.png --session <id>`: Visual layout, canvas, styling, or evidence capture.
6. `bsk console --session <id>` / `bsk network --session <id>`: Read console errors and network traffic.

---

## 4. Element Interactions & Exact Flag Syntax

Avoid common CLI syntax errors by using exact flag names:

| Action | Command Syntax | Notes |
|---|---|---|
| **Fill Input** | `bsk fill @eN --value "text" --session <id>` | Supports inputs, textareas, contenteditable. |
| **Select Dropdown** | `bsk select @eN --value "val" --session <id>` | Matches `<option value="...">`, NOT visible text label. |
| **Click** | `bsk click @eN --session <id>` | Clicks snapshot ref or CSS selector. |
| **Hover** | `bsk hover @eN --session <id>` | Triggers hover pseudo-classes and submenus. |
| **Key Press** | `bsk press "Enter" --session <id>` | Dispatches key combo (`Enter`, `Control+a`, etc.). |
| **Screenshot** | `bsk screenshot --out ./page.png --session <id>` | Captures viewport PNG. |
| **Mobile Emulate** | `bsk emulate --device iphone-14 --session <id>` | Preset IDs are lowercase hyphenated. Restore via `--off`. |
| **Evaluate JS** | `bsk evaluate "document.title" --json --session <id>` | Last resort. Check `.ok` in returned JSON payload. |

---

## 5. Agent Window & User Tab Isolation

The **Agent Window** isolates automation from the user's active browsing:
- To inspect or operate tabs in the user's primary window, explicitly list them:
  ```bash
  bsk tab list --scope user --session <id>
  ```
- Borrow the tab by its ID:
  ```bash
  bsk tab borrow <tab-id> --session <id>
  ```
- Return it immediately when finished:
  ```bash
  bsk tab return <tab-id> --session <id>
  ```
- Never invent tab IDs or retain personal user tabs across unrelated tasks.

---

## 6. Human-in-the-Loop Takeover (`request-help`)

When encountering login walls, CAPTCHAs, two-factor authentication (TOTP/SMS), payments, or sensitive confirmations:
```bash
bsk request-help --prompt "Please complete the Cloudflare captcha challenge" --session <id>
```
- Wait for the operator to resolve the barrier.
- Result `outcome` will be `continued`, `completed`, `cancelled`, `timed_out`, or `disabled`.
- Resume **only** after `continued` or `completed`.
- Immediately run `bsk observe --session <id>` after control returns to re-synchronize refs.

---

## 7. File Uploads & Downloads

Staged through the daemon to keep agent operations sandboxed:

### Upload Modes
1. **Input Mode (Default)**:
   ```bash
   bsk upload @eN --file "path/to/file.pdf" --session <id>
   ```
   Clicks the target and intercepts the native OS file picker.
2. **Drop Mode (`--mode drop`)**:
   ```bash
   bsk upload @eN --mode drop --file "path/to/file.pdf" --session <id>
   ```
   Targets designated drag-and-drop zones, email attachment zones, or chat composers.

### Downloads
```bash
bsk download @eN --out "./downloaded_report.csv" --session <id>
```
Add `--overwrite` if replacing an existing file is intentional.

---

## 8. Failure Recovery Without Wandering

- **Stale Ref**: Run `bsk observe --session <id>` to obtain fresh `@eN` references and retry once.
- **Value Mismatch (`fill_value_mismatch`)**: Observe the field first; the page may have auto-formatted currency, phone, or date. Proceed if visible intent is satisfied.
- **Session Lost / Disconnect**: Verify with `bsk session list` and `bsk doctor`.
- **Fatal Error**: Always invoke `bsk session stop <id>` in your cleanup handler to release browser resources and borrowed tabs cleanly.
