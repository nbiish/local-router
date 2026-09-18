import { renderLayout } from './layout';

export function renderAgentsPage(params: {
  defaultFallbackModelsText: string;
}): string {
  const body = `
      <div class="card">
        <div class="catalog-meta">
          <div>
            <h2>Claude Code CLI Interception</h2>
            <p class="muted">
              Intercept Anthropic's official <code>claude</code> CLI across the entire system.
              Transparently replace Claude Code's internal models with your selected Local Router models.
            </p>
          </div>
          <div class="muted" id="claudeProxyStatus">Loading...</div>
        </div>
        <div style="margin-top:14px;">
          <label style="display:inline-flex;align-items:center;gap:10px;font-weight:bold;cursor:pointer;font-size:15px;">
            <input type="checkbox" id="claudeProxyToggle" onchange="toggleClaudeProxy()" style="width:18px;height:18px;">
            Enable Claude Code proxy interception
          </label>
        </div>
        <div id="claudeConfigFields" style="margin-top:16px; display:none;">
          <p class="muted" style="margin-bottom:14px;line-height:1.5;">
            Select which active Local Router model replaces each internal Claude Code model slot.
            Options include all currently toggled models and your configured Fallback Routes.
          </p>

          <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(320px, 1fr));gap:16px;">
            <!-- 1. Default -->
            <div class="form-group" style="background:var(--surface-soft);padding:14px;border:1px solid var(--border);border-radius:8px;">
              <label for="claudeModelDefault" style="display:flex;justify-content:space-between;align-items:center;">
                <span>Default Model Slot</span>
                <span class="pill catalog">default</span>
              </label>
              <p class="muted" style="font-size:12px;margin:2px 0 8px;">Used for general CLI prompts when no explicit <code>--model</code> is given.</p>
              <select id="claudeModelDefault" class="agent-model-select" onchange="saveClaudeAgentConfig()">
                <option value="">Loading models...</option>
              </select>
            </div>

            <!-- 2. Opus (1M context) -->
            <div class="form-group" style="background:var(--surface-soft);padding:14px;border:1px solid var(--border);border-radius:8px;">
              <label for="claudeModelOpus1m" style="display:flex;justify-content:space-between;align-items:center;">
                <span>Opus (1M context)</span>
                <span class="pill catalog">claude-opus-*</span>
              </label>
              <p class="muted" style="font-size:12px;margin:2px 0 8px;">Triggered for deep reasoning and massive multi-file codebase operations.</p>
              <select id="claudeModelOpus1m" class="agent-model-select" onchange="saveClaudeAgentConfig()">
                <option value="">Loading models...</option>
              </select>
            </div>

            <!-- 3. Sonnet -->
            <div class="form-group" style="background:var(--surface-soft);padding:14px;border:1px solid var(--border);border-radius:8px;">
              <label for="claudeModelSonnet" style="display:flex;justify-content:space-between;align-items:center;">
                <span>Sonnet</span>
                <span class="pill catalog">claude-sonnet-*</span>
              </label>
              <p class="muted" style="font-size:12px;margin:2px 0 8px;">Standard daily coding, multi-turn pair programming, and planning.</p>
              <select id="claudeModelSonnet" class="agent-model-select" onchange="saveClaudeAgentConfig()">
                <option value="">Loading models...</option>
              </select>
            </div>

            <!-- 4. Sonnet 5 (1M context) -->
            <div class="form-group" style="background:var(--surface-soft);padding:14px;border:1px solid var(--border);border-radius:8px;">
              <label for="claudeModelSonnet5_1m" style="display:flex;justify-content:space-between;align-items:center;">
                <span>Sonnet 5 (1M context)</span>
                <span class="pill catalog">claude-sonnet-5</span>
              </label>
              <p class="muted" style="font-size:12px;margin:2px 0 8px;">Next-generation high-context model for complex agentic workflows.</p>
              <select id="claudeModelSonnet5_1m" class="agent-model-select" onchange="saveClaudeAgentConfig()">
                <option value="">Loading models...</option>
              </select>
            </div>

            <!-- 5. Haiku -->
            <div class="form-group" style="background:var(--surface-soft);padding:14px;border:1px solid var(--border);border-radius:8px;">
              <label for="claudeModelHaiku" style="display:flex;justify-content:space-between;align-items:center;">
                <span>Haiku</span>
                <span class="pill catalog">claude-haiku-*</span>
              </label>
              <p class="muted" style="font-size:12px;margin:2px 0 8px;">High-speed low-cost tasks: git commits, summaries, file triage.</p>
              <select id="claudeModelHaiku" class="agent-model-select" onchange="saveClaudeAgentConfig()">
                <option value="">Loading models...</option>
              </select>
            </div>
          </div>

          <div class="button-row" style="margin-top:16px;">
            <button onclick="saveClaudeAgentConfig()">Save Configuration</button>
            <button class="button-secondary" onclick="resetClaudeAgentConfigToDefault()">Reset All to System Fallback Chain</button>
            <button class="button-secondary" id="claudeTestBtn" onclick="testClaudeProxyConnection()">Test Proxy Endpoint</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="catalog-meta">
          <div>
            <h2>System-Wide Interception Hook</h2>
            <p class="muted">
              How Local Router ensures <code>claude</code> automatically routes through port 11434 everywhere on the system.
            </p>
          </div>
          <div class="muted" id="envSyncStatus">Verified</div>
        </div>
        <div style="margin-top:12px;font-size:13px;line-height:1.6;">
          <div style="background:var(--surface-soft);padding:12px 16px;border-radius:6px;border:1px solid var(--border);margin-bottom:12px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
              <strong>Active Environment Interceptors:</strong>
              <button class="button-secondary" onclick="syncAgentEnv()" style="padding:2px 10px;font-size:12px;">Re-sync Environment</button>
            </div>
            <ul style="margin:6px 0 0 18px;padding:0;">
              <li><code>ANTHROPIC_BASE_URL="http://127.0.0.1:11434"</code> (Registered in Windows User Registry &amp; WSL <code>~/.config/local-router/env.sh</code>)</li>
              <li><code>ANTHROPIC_API_KEY="local-router"</code> / <code>ANTHROPIC_AUTH_TOKEN="local-router"</code></li>
              <li>CLI Shims: <code>bin/claude.cmd</code> &amp; <code>bin/claude</code> transparently proxy calls to Local Router</li>
            </ul>
          </div>
          <div class="endpoint-help">
            <details>
              <summary>CLI Verification Commands</summary>
              <div style="margin-top:8px;">
                <p>Verify active endpoint inside Claude Code:</p>
                <pre style="background:var(--log-bg);color:var(--log-text);padding:10px;border-radius:6px;font-size:12px;overflow-x:auto;">claude /status
claude /model</pre>
                <p style="margin-top:8px;">Test raw Anthropic Messages API proxying directly:</p>
                <pre style="background:var(--log-bg);color:var(--log-text);padding:10px;border-radius:6px;font-size:12px;overflow-x:auto;">curl http://127.0.0.1:11434/v1/messages \\
  -H "Content-Type: application/json" \\
  -d '{"model":"claude-3-7-sonnet-20250219","max_tokens":100,"messages":[{"role":"user","content":"Hello"}]}'</pre>
              </div>
            </details>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="catalog-meta">
          <div>
            <h2>Agent Ecosystem &amp; CLI Shims</h2>
            <p class="muted">
              Unified agent proxy architecture for developer tooling (similar to <code>fcc-server</code> and <code>unsloth start {claude / codex}</code>).
            </p>
          </div>
          <span class="pill custom">Extensible</span>
        </div>
        <div style="margin-top:12px;font-size:13px;line-height:1.6;color:var(--muted);">
          <p>
            Local Router provides drop-in shims for both OpenAI-compatible and Anthropic-compatible coding agents:
          </p>
          <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));gap:10px;margin-top:10px;">
            <div style="padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--surface-raised);">
              <strong style="color:var(--text);">Claude Code</strong>
              <div style="font-size:12px;">Endpoint: <code>/v1/messages</code></div>
              <div style="font-size:12px;color:var(--success-text);">Active &amp; Remappable</div>
            </div>
            <div style="padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--surface-raised);">
              <strong style="color:var(--text);">Codex / OpenCode</strong>
              <div style="font-size:12px;">Endpoint: <code>/v1/responses</code> &amp; <code>/v1/chat</code></div>
              <div style="font-size:12px;color:var(--primary);">Ollama &amp; OpenAI Native</div>
            </div>
            <div style="padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--surface-raised);">
              <strong style="color:var(--text);">Cursor / Copilot</strong>
              <div style="font-size:12px;">Endpoint: <code>/chat/completions</code></div>
              <div style="font-size:12px;color:var(--primary);">Auto Bridge Supported</div>
            </div>
          </div>
        </div>
      </div>
`;
  return renderLayout('Agents', body, params);
}
