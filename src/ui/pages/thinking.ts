import { renderLayout } from './layout';

export function renderThinkingPage(params: {
  defaultFallbackModelsText: string;
}): string {
  const body = `
      <div class="card">
        <div class="catalog-meta">
          <div>
            <h2>System Prompt</h2>
            <p class="muted">Inject a custom system prompt before every LLM request. Default: Chain of Draft (concise step-by-step reasoning).</p>
          </div>
          <div class="muted" id="systemPromptStatus">Loading...</div>
        </div>
        <div style="margin-top:12px;">
          <label style="display:inline-flex;align-items:center;gap:8px;font-weight:bold;cursor:pointer;">
            <input type="checkbox" id="systemPromptToggle" onchange="toggleSystemPrompt()"> Enable custom system prompt
          </label>
        </div>
        <div id="systemPromptFields" style="margin-top:12px; display:none;">
          <div class="form-group">
            <label for="systemPromptText">Prompt text</label>
            <textarea id="systemPromptText" rows="6" placeholder="Enter your system prompt..."></textarea>
          </div>
          <div class="button-row">
            <button onclick="saveSystemPrompt()">Save</button>
            <button class="button-secondary" onclick="resetSystemPromptToDefault()">Reset to Default (CoD)</button>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="catalog-meta">
          <div>
            <h2>Thinking / Reasoning</h2>
            <p class="muted">Optional proxy overrides. When off, IDE/CLI/script thinking settings pass through unchanged.</p>
          </div>
          <div class="muted" id="thinkingLevelStatus">Loading...</div>
        </div>
        <div style="margin-top:12px;">
          <label style="display:inline-flex;align-items:center;gap:8px;font-weight:bold;cursor:pointer;">
            <input type="checkbox" id="thinkingProxyToggle" onchange="toggleThinkingProxy()"> Enable Local Router thinking overrides
          </label>
        </div>
        <div id="thinkingConfigFields" style="margin-top:12px; display:none;">
        <div class="form-group">
          <label for="thinkingLevelSelect">Global Thinking Level</label>
          <select id="thinkingLevelSelect" onchange="saveThinkingLevel()">
            <option value="none">none — disable reasoning (VS Code safe)</option>
            <option value="low">low — minimal reasoning</option>
            <option value="medium">medium — balanced reasoning</option>
            <option value="high">high — extended reasoning</option>
            <option value="xhigh">xhigh — maximum reasoning</option>
          </select>
        </div>
        <div class="form-group" id="providerThinkingLevels" style="margin-top:14px;">
          <label>Per-Provider Thinking Levels</label>
          <p class="muted">Override the global level for specific providers. Cleared overrides fall back to global.</p>
          <div id="providerThinkingGrid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px;"></div>
        </div>
        </div>
      </div>
      <div class="card">
        <div class="catalog-meta">
          <div>
            <h2>Wafer AI ZDR Enhancement</h2>
            <p class="muted">Zero Delay Reduction inference optimization for GLM-5.1, Kimi-K2.6, and deepseek-v4-pro models via <code>Wafer-ZDR: required</code> header.</p>
          </div>
          <div class="muted" id="waferZdrStatus">Loading...</div>
        </div>
        <div style="margin-top:12px;">
          <label style="display:inline-flex;align-items:center;gap:8px;font-weight:bold;cursor:pointer;">
            <input type="checkbox" id="waferZdrToggle" onchange="toggleWaferZdr()"> Enable ZDR enhancement for eligible Wafer AI models
          </label>
        </div>
      </div>
      <div class="card">
        <div class="catalog-meta">
          <div>
            <h2>Headroom Context Compression</h2>
            <p class="muted">Intelligent context compression layer utilizing the <code>headroom-ai</code> SDK to compress prompt histories before forwarding upstream, optimizing token caching and cost.</p>
          </div>
          <div class="muted" id="headroomStatus">Loading...</div>
        </div>
        <div style="margin-top:12px;">
          <label style="display:inline-flex;align-items:center;gap:8px;font-weight:bold;cursor:pointer;">
            <input type="checkbox" id="headroomToggle" onchange="toggleHeadroom()"> Enable Headroom context compression
          </label>
        </div>
        <div id="headroomFields" style="margin-top:12px; display:none;">
          <div class="form-group">
            <label for="headroomProxyUrlInput">Headroom Proxy URL</label>
            <input type="text" id="headroomProxyUrlInput" placeholder="http://localhost:8787" style="width:100%;max-width:400px;" />
          </div>
          <div class="button-row">
            <button onclick="saveHeadroomProxyUrl()">Save</button>
          </div>
        </div>
      </div>
`;
  return renderLayout('Prompt & Thinking Level', body, params);
}
