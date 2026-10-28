import { renderLayout } from './layout';

export function renderAgentsPage(params: {
  defaultFallbackModelsText: string;
}): string {
  const body = `
      <div class="card">
        <div class="catalog-meta">
          <div>
            <h2>Harness Readiness</h2>
            <p class="muted">
              What Local Router can prove right now for the two agent harnesses it manages:
              Anthropic's <code>claude</code> CLI (Messages API) and OpenAI's <code>codex</code> CLI (Responses API).
            </p>
          </div>
          <div class="muted" id="harnessStatusStamp">Checking wiring&hellip;</div>
        </div>

        <div id="harnessStatusRows" style="margin-top:14px;">
          <div class="harness-row" style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:12px 14px;border:1px solid var(--border);border-radius:8px;background:var(--surface-soft);margin-bottom:10px;">
            <div style="min-width:200px;">
              <strong>Claude Code</strong>
              <div class="muted" style="font-size:12px;"><code>claude</code> &rarr; <code>POST /v1/messages</code></div>
            </div>
            <div style="font-size:12px;"><span class="muted">CLI</span> <span id="claudeCliState">checking&hellip;</span></div>
            <div style="font-size:12px;"><span class="muted">Interception</span> <span id="claudeInterceptState">checking&hellip;</span></div>
            <div style="font-size:12px;"><span class="muted">Env</span> <span id="claudeEnvState">checking&hellip;</span></div>
            <div style="font-size:12px;flex:1;min-width:180px;" id="claudeProbeState"><span class="muted">Not probed yet</span></div>
            <button class="button-secondary" id="claudeProbeBtn" onclick="verifyHarness('claude')" style="padding:4px 12px;">Verify messages</button>
          </div>

          <div class="harness-row" style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:12px 14px;border:1px solid var(--border);border-radius:8px;background:var(--surface-soft);">
            <div style="min-width:200px;">
              <strong>Codex CLI</strong>
              <div class="muted" style="font-size:12px;"><code>codex</code> &rarr; <code>POST /v1/responses</code></div>
            </div>
            <div style="font-size:12px;"><span class="muted">CLI</span> <span id="codexCliState">checking&hellip;</span></div>
            <div style="font-size:12px;"><span class="muted">Interception</span> <span id="codexInterceptState">checking&hellip;</span></div>
            <div style="font-size:12px;"><span class="muted">Config</span> <span id="codexConfigState">checking&hellip;</span></div>
            <div style="font-size:12px;flex:1;min-width:180px;" id="codexProbeState"><span class="muted">Not probed yet</span></div>
            <button class="button-secondary" id="codexProbeBtn" onclick="verifyHarness('codex')" style="padding:4px 12px;">Verify responses</button>
          </div>
        </div>
        <p class="muted" style="font-size:12px;margin:10px 0 0;line-height:1.5;">
          Verification sends one 16-token request through the active fallback chain with the same credentials as normal agent
          traffic &mdash; it proves the wire shape, not just that a port is open. Readiness alone costs nothing.
        </p>
      </div>

      <div class="card">
        <div class="catalog-meta">
          <div>
            <h2>Claude Code CLI Interception</h2>
            <p class="muted">
              Intercept Anthropic's official <code>claude</code> CLI across the entire system.
              Transparently replace Claude Code's internal models with your selected Local Router models.
            </p>
          </div>
          <div class="muted" id="claudeProxyStatus">Not checked</div>
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
            <button class="button-secondary" id="claudeTestBtn" onclick="verifyHarness('claude')">Test Proxy Endpoint</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="catalog-meta">
          <div>
            <h2>Codex CLI Interception</h2>
            <p class="muted">
              Route OpenAI's <code>codex</code> CLI through the loopback Responses shim. Local Router writes a managed
              provider table in <code>~/.codex/config.toml</code> and a <code>local-router</code> profile; the
              <code>bin/codex</code> shim selects that profile automatically.
            </p>
          </div>
          <div class="muted" id="codexProxyStatus">Not checked</div>
        </div>
        <div style="margin-top:14px;">
          <label style="display:inline-flex;align-items:center;gap:10px;font-weight:bold;cursor:pointer;font-size:15px;">
            <input type="checkbox" id="codexProxyToggle" onchange="toggleCodexProxy()" style="width:18px;height:18px;">
            Enable Codex proxy interception
          </label>
        </div>
        <div id="codexConfigFields" style="margin-top:16px; display:none;">
          <div class="form-group" style="background:var(--surface-soft);padding:14px;border:1px solid var(--border);border-radius:8px;max-width:520px;">
            <label for="codexModelSelect">Model for the Codex profile</label>
            <p class="muted" style="font-size:12px;margin:2px 0 8px;">
              Written to <code>model</code> in <code>~/.codex/local-router.config.toml</code>. Codex has a single model
              slot, so every <code>codex</code> run through the profile asks Local Router for this model.
            </p>
            <select id="codexModelSelect" class="agent-model-select" onchange="saveCodexAgentConfig()">
              <option value="">Loading models...</option>
            </select>
          </div>

          <div style="margin-top:14px;background:var(--surface-soft);padding:12px 16px;border-radius:6px;border:1px solid var(--border);font-size:12px;line-height:1.7;">
            <div>Provider: <code>local-router</code> &middot; wire API: <code>responses</code> &middot; base URL: <code>http://127.0.0.1:11434/v1</code></div>
            <div>Profile: <code>~/.codex/local-router.config.toml</code> &middot; config: <code>~/.codex/config.toml</code> (managed block only)</div>
            <div>Launch: <code>codex --profile local-router</code> &mdash; the <code>bin/codex</code> shim adds the flag for you</div>
          </div>

          <div class="button-row" style="margin-top:16px;">
            <button onclick="saveCodexAgentConfig()">Save Codex Configuration</button>
            <button class="button-secondary" onclick="resetCodexAgentConfigToDefault()">Reset to System Fallback Chain</button>
            <button class="button-secondary" id="codexTestBtn" onclick="verifyHarness('codex')">Test Responses Endpoint</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="catalog-meta">
          <div>
            <h2>System-Wide Interception Hook</h2>
            <p class="muted">
              How Local Router keeps <code>claude</code> and <code>codex</code> pointed at port 11434 everywhere on the system.
            </p>
          </div>
          <div class="muted" id="envSyncStatus">Not checked</div>
        </div>
        <div style="margin-top:12px;font-size:13px;line-height:1.6;">
          <div style="background:var(--surface-soft);padding:12px 16px;border-radius:6px;border:1px solid var(--border);margin-bottom:12px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
              <strong>Active Environment Interceptors:</strong>
              <button class="button-secondary" onclick="syncAgentEnv()" style="padding:2px 10px;font-size:12px;">Re-sync Environment</button>
            </div>
            <ul style="margin:6px 0 0 18px;padding:0;">
              <li><code>ANTHROPIC_BASE_URL="http://127.0.0.1:11434"</code> + <code>ANTHROPIC_AUTH_TOKEN="local-router"</code> (Windows User environment &amp; WSL <code>~/.config/local-router/env.sh</code>)</li>
              <li><code>OPENAI_BASE_URL="http://127.0.0.1:11434/v1"</code> + <code>OPENAI_API_KEY="local-router"</code> (same stores; also used by scripts and OpenAI-compatible tools)</li>
              <li>CLI shims: <code>bin/claude.cmd</code> &amp; <code>bin/claude</code> (Claude Code), <code>bin/codex.cmd</code> &amp; <code>bin/codex</code> (Codex profile selector)</li>
            </ul>
          </div>
          <div class="endpoint-help">
            <details>
              <summary>CLI Verification Commands</summary>
              <div style="margin-top:8px;">
                <p>Verify the active endpoint inside each harness:</p>
                <pre style="background:var(--log-bg);color:var(--log-text);padding:10px;border-radius:6px;font-size:12px;overflow-x:auto;">claude /status
codex --profile local-router
codex exec --profile local-router "say OK"</pre>
                <p style="margin-top:8px;">Test the raw wire shapes Local Router proxies:</p>
                <pre style="background:var(--log-bg);color:var(--log-text);padding:10px;border-radius:6px;font-size:12px;overflow-x:auto;">curl http://127.0.0.1:11434/v1/messages \\
  -H "Content-Type: application/json" \\
  -d '{"model":"claude-3-7-sonnet-20250219","max_tokens":100,"messages":[{"role":"user","content":"Hello"}]}'

curl http://127.0.0.1:11434/v1/responses \\
  -H "Content-Type: application/json" \\
  -d '{"model":"local-router/fallback-models","input":"Hello","max_output_tokens":64}'</pre>
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
              <div style="font-size:12px;color:var(--success-text);">Env + shim + 5 remappable slots</div>
            </div>
            <div style="padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--surface-raised);">
              <strong style="color:var(--text);">Codex CLI</strong>
              <div style="font-size:12px;">Endpoint: <code>/v1/responses</code></div>
              <div style="font-size:12px;color:var(--success-text);">Managed provider + <code>local-router</code> profile</div>
            </div>
            <div style="padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--surface-raised);">
              <strong style="color:var(--text);">Cursor / Copilot</strong>
              <div style="font-size:12px;">Endpoint: <code>/chat/completions</code></div>
              <div style="font-size:12px;color:var(--primary);">Auto bridge supported</div>
            </div>
          </div>
        </div>
      </div>
`;
  return renderLayout('Agents', body, params);
}
