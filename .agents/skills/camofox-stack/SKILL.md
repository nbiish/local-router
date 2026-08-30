---
name: camofox-stack
description: Skill for utilizing the CamoFox anti-detection browser stack (camoufox, camofox-browser, camofox-mcp) for agentic web scraping and automation.
---

# CamoFox Browser Stack

> **You are an expert in Anti-Detection Browser Automation.**
> You understand the three-layer architecture of the CamoFox ecosystem and how to leverage it for stealth web automation.

## 1. Architecture Overview (The Three Repositories)

The CamoFox stack consists of three distinct layers, derived from the three repositories you integrated. It is crucial to understand how they interlock into a single stack:

1. **Layer 1: `camoufox` (Core Engine)**
   * **Source**: [daijro/camoufox](https://github.com/daijro/camoufox)
   * **Role**: A C++ fork of Firefox that provides engine-level fingerprint spoofing. It defeats TLS fingerprinting, canvas fingerprinting, and standard bot mitigations (Cloudflare, Datadome).
2. **Layer 2: `camofox-browser` (Server/CLI)**
   * **Source**: [jo-inc/camofox-browser](https://github.com/jo-inc/camofox-browser) *(also known as redf0x1/camofox-browser)*
   * **Role**: A Node.js REST API and CLI wrapper around the Camoufox engine. It handles profile isolation, persistent contexts, proxy routing, and translates commands into Playwright/accessibility-tree interactions.
3. **Layer 3: `camofox-mcp` (Agent Bridge)**
   * **Source**: [redf0x1/camofox-mcp](https://github.com/redf0x1/camofox-mcp)
   * **Role**: The Model Context Protocol (MCP) server that connects AI agents (like Claude Desktop, OpenClaw, or Cursor) to the `camofox-browser` API.

## 2. Resource Management & Memory Constraints

When running this stack on a standard machine (e.g., 16GB unified memory Mac):
- **Node Server (`camofox-browser`)**: ~100MB RAM overhead.
- **MCP Bridge (`camofox-mcp`)**: ~50MB RAM overhead.
- **Browser Engine (`camoufox`)**: ~1.2GB base per isolated user context. Camoufox runs multiple heavy `plugin-container` processes to manage anti-detect spoofing and isolated tracking protection.
- **Recommendation for 16GB RAM**: Limit concurrent isolated `userId` sessions to **max 5-8 contexts**. Running more than 8 contexts will result in severe memory pressure and swapping on a 16GB Mac. If you need more tabs, reuse the same `userId` context, which adds a much smaller ~50-100MB per additional tab.
- **Eviction**: `camofox-browser` automatically manages idle contexts via LRU eviction, but you must aggressively manage active context count.

## 3. Best Practices for Agents

### 3.1 Use the CLI for Pipeline Automation
When writing automation scripts inside the agent environment, prefer the `camofox` CLI for rapid prototyping.

**Important Quirk:** Always capture the `tabId` returned by `camofox open` and pass it to subsequent commands, especially in shell scripts. Relying on implicit active tab state can lead to "No active tab found" errors during fast execution.

```bash
# Open URL and capture the tab ID
TAB_ID=$(camofox open https://example.com | grep -o 'tabId: .*' | cut -d' ' -f2)

# Get structured element tree using the captured tab ID
camofox snapshot $TAB_ID --format json --user agent-1

# Interact safely
camofox click e1 $TAB_ID --user agent-1
camofox type e3 "search query" $TAB_ID --user agent-1

# Save state
camofox session save my-session --user agent-1
```

### 3.2 Structured Extraction
Instead of injecting arbitrary JavaScript (which can trigger anti-bot systems), use the native Structured Extraction feature:
```json
{
  "kind": "extractStructured",
  "schema": {
    "kind": "object",
    "fields": {
      "title": { "kind": "text", "selector": "h1" }
    }
  }
}
```

### 3.3 Security & Auth Vault
**Never** hardcode credentials in your agent scripts. Use the `camofox auth` vault:
```bash
# Inject credentials directly into the browser without the LLM seeing the password
camofox auth load my-service --inject --username-ref e5 --password-ref e12
```

## 4. Integration Workflow

When tasked with a web scraping or automation task that requires bypassing bot detection:
1. **Verify**: Ensure `camofox-browser` is running (`curl http://localhost:9377/health`).
2. **Handle IP vs Fingerprint Bans**: CamoFox easily defeats **Fingerprint** bans (e.g., ResearchGate). However, if a target site (e.g., Google Scholar, JSTOR) uses hard **IP Reputation** bans against Datacenter IPs, you *must* route traffic through a Residential Proxy via the `CAMOFOX_PROXY_PROFILES_FILE` or explicit `--proxy-host` arguments. No browser engine can spoof an IP address!
3. **Navigate**: Open the target URL via CLI or REST.
4. **Observe**: Take an accessibility snapshot (`camofox snapshot`).
4. **Interact**: Use `[eN]` refs from the snapshot to click and type.
5. **Extract**: Use `camofox extract-structured` with a strict JSON schema.

### 4.1 REST API Quirk (Session Isolation)
If you decide to use `curl` or language-native HTTP clients instead of the CLI, note that the `/tabs` endpoint **requires** both a `userId` and a `sessionKey` in the JSON body. The `sessionKey` determines the scope of session reuse and proxy bindings.

```bash
# Correct REST API Usage
curl -X POST http://localhost:9377/tabs \
  -H 'Content-Type: application/json' \
  -d '{"userId": "agent1", "sessionKey": "task1", "url": "https://example.com"}'
# Returns: {"tabId": "...", "url": "..."}
```
