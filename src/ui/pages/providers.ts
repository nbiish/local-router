import { renderLayout } from './layout';

export function renderProvidersPage(params: {
  defaultRouterId: string;
  defaultRouterCandidatesText: string;
  defaultFallbackModelsText: string;
}): string {
  const body = `
      <div class="card">
        <div class="theme-panel">
          <div>
            <div class="theme-title">
              <label id="colorSchemeLabel" for="colorSchemeScale">Color Scheme</label>
              <span id="colorSchemeValue" class="theme-value">Light - 0%</span>
            </div>
            <p class="muted">Adjusts contrast, surfaces, borders, and accent colors across the configuration UI.</p>
          </div>
          <div class="theme-slider">
            <input id="colorSchemeScale" type="range" min="0" max="100" step="1" value="0" aria-labelledby="colorSchemeLabel" oninput="setThemeScale(this.value)" onchange="setThemeScale(this.value)">
            <div class="theme-scale-labels" aria-hidden="true">
              <span>Light</span>
              <span>Balanced</span>
              <span>Dark</span>
            </div>
          </div>
        </div>
        <h2>Local Router Secure Key Configuration</h2>
        <p class="muted">API keys are held in memory while the server runs and persisted to your PQC-encrypted secrets bundle (<code>~/.config/pqc-secrets/</code>) whenever you save from this UI.</p>
        <details class="endpoint-help">
          <summary>Proxy vs upstream endpoints</summary>
          <p class="muted">Clients talk to Local Router at <code>http://127.0.0.1:11434</code>. Custom vendors must expose an OpenAI-compatible HTTPS API.</p>
          <table>
            <thead><tr><th>Local Router (clients)</th><th>Role</th></tr></thead>
            <tbody>
              <tr><td><code>POST /v1/chat/completions</code></td><td>Primary inference</td></tr>
              <tr><td><code>GET /v1/models</code>, <code>GET /api/tags</code></td><td>Discovery</td></tr>
              <tr><td><code>POST /api/chat</code>, <code>POST /api/generate</code></td><td>Ollama-compat (translated)</td></tr>
              <tr><td><code>POST /v1/responses</code>, <code>POST /v1/messages</code></td><td>Codex / Anthropic shims</td></tr>
            </tbody>
          </table>
          <p class="muted" style="margin-top:8px;">Upstream base URL must be HTTPS and end with <code>/v1</code>. Local Router calls <code>POST {base}/chat/completions</code> and optionally <code>GET {base}/models</code>. Model id: <code>{providerSlug}/{alias}</code>.</p>
        </details>
        <div class="provider-picker">
          <div class="form-group">
            <label for="providerSelect">Provider</label>
            <select id="providerSelect"></select>
          </div>
          <div class="form-group">
            <label>Provider Key Env Var</label>
            <input id="providerEnvVar" type="text" disabled>
          </div>
        </div>
        <div id="customProviderPanel" class="custom-provider-panel" style="display:none;">
          <h3 id="customProviderPanelTitle">Add custom provider</h3>
          <p class="muted">Register an OpenAI-compatible upstream. Keys are not stored in <code>custom-providers.json</code> — only metadata.</p>
          <input type="hidden" id="customProviderEditMode" value="">
          <div class="provider-picker">
            <div class="form-group">
              <label for="customProviderSlug">Provider ID (slug)</label>
              <input id="customProviderSlug" type="text" placeholder="my-vendor" pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?">
            </div>
            <div class="form-group">
              <label for="customProviderDisplayName">Display name</label>
              <input id="customProviderDisplayName" type="text" placeholder="My Vendor">
            </div>
          </div>
          <div class="provider-picker">
            <div class="form-group">
              <label for="customProviderKeyEnv">Key env var</label>
              <input id="customProviderKeyEnv" type="text" placeholder="MY_VENDOR_API_KEY">
            </div>
            <div class="form-group">
              <label for="customProviderEndpoint">Upstream base URL</label>
              <input id="customProviderEndpoint" type="url" placeholder="https://api.example.com/v1">
            </div>
          </div>
          <div class="form-group">
            <label for="customProviderDefaultTool">Default tool label</label>
            <input id="customProviderDefaultTool" type="text" value="OpenAI Compatible">
          </div>
          <div class="button-row">
            <button type="button" onclick="saveCustomProvider()">Save custom provider</button>
            <button type="button" class="button-secondary" onclick="cancelCustomProviderPanel()">Cancel</button>
          </div>
        </div>
        <div id="providerKeySection">
          <div class="form-group">
            <label>API Key</label>
            <input type="password" id="providerKey" placeholder="Enter provider API key">
          </div>
          <div class="button-row">
            <button onclick="saveProviderKey()">Save Selected Provider Key</button>
          </div>
        </div>
        <div class="form-group" style="margin-top:18px;">
          <label>Provider Model Manager (one model at a time)</label>
          <p class="muted">Registry defaults remain available. Add, update, or delete single models per provider in-memory without removing the provider itself.</p>
          <div class="provider-picker">
            <div class="form-group">
              <label for="modelUpstream">Upstream Model ID</label>
              <input id="modelUpstream" type="text" placeholder="@preset/chain-of-draft">
            </div>
            <div class="form-group">
              <label for="modelPresented">Presented Model Name (alias)</label>
              <input id="modelPresented" type="text" placeholder="openrouter-chain-of-draft">
            </div>
          </div>
          <div class="provider-picker">
            <div class="form-group">
              <label for="modelContextLength">Context Length</label>
              <input id="modelContextLength" type="number" min="1" step="1" value="64000">
            </div>
            <div class="form-group">
              <label for="modelOutputTokens">Max Output Tokens</label>
              <input id="modelOutputTokens" type="number" min="1" step="1" value="4096">
            </div>
          </div>
          <div class="model-flag-grid">
            <label class="flag-toggle"><input id="modelSupportsTools" type="checkbox" checked>Tools</label>
            <label class="flag-toggle"><input id="modelSupportsImages" type="checkbox">Vision</label>
            <label class="flag-toggle"><input id="modelSupportsCache" type="checkbox">Cache</label>
            <label class="flag-toggle"><input id="modelSupportsReasoning" type="checkbox">Reasoning</label>
          </div>
        </div>
        <div class="button-row">
          <button onclick="saveProviderModel()">Add / Update Selected Provider Model</button>
          <button class="button-secondary" onclick="clearProviderModelForm()">Clear Model Form</button>
          <button class="button-secondary" onclick="resetSelectedProviderModels()">Reset Selected Provider Models</button>
          <button class="button-secondary" onclick="configureVSCodePicker()">Refresh VS Code Model Picker</button>
        </div>
        <div class="form-group" style="margin-top:16px;">
          <label>Selected Provider Models</label>
          <div id="providerModelList" class="provider-model-list">
            <div class="provider-model-empty">Loading selected provider models...</div>
          </div>
        </div>
        <div id="message"></div>
      </div>
      <div class="card">
        <div class="catalog-meta">
          <div>
            <h2>Provider Key Configs</h2>
            <p class="muted">Select one of the registry providers, then save the API key in-memory for that backend.</p>
          </div>
          <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 8px;">
            <div class="muted" id="providerCount">Loading providers...</div>
            <button type="button" class="button-secondary" onclick="syncPqcBundleKeys(true)" style="padding: 4px 10px; font-size: 13px;">🔁 Sync PQC keys</button>
          </div>
        </div>
        <div id="providerGrid" class="provider-grid"></div>
      </div>
      <div class="card">
        <div class="catalog-meta">
          <div>
            <h2>Available Providers & Models</h2>
            <p class="muted" id="catalogDescription">Toggle the models you want served — the selection powers both the OpenAI-compatible and Ollama-compatible endpoints.</p>
            <div style="margin-top: 12px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap;">
              <button id="refreshEndpointsBtn" class="button-secondary" onclick="refreshEndpointModels()" style="padding: 4px 10px; font-size: 13px;">🔄 Refresh All Provider Models</button>
            </div>
            <div style="margin-top: 10px; display: flex; align-items: center; gap: 8px;">
              <label class="flag-toggle">
                <input id="filterConfiguredToggle" type="checkbox" checked onchange="setFilterConfigured(this.checked)">
                <span style="font-weight: 500;">Only show models from configured providers in Ollama proxy</span>
              </label>
            </div>
            <div id="curationControls" style="display: none; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border-color, #333);">
              <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                <label class="flag-toggle">
                  <input id="curationToggle" type="checkbox" onchange="toggleCuration(this.checked)">
                  <span style="font-weight: 500;">Curate endpoint models (serve only checked)</span>
                </label>
                <input id="catalogSearch" type="search" placeholder="Search ported models…" oninput="renderCurationCatalog()" style="flex: 1; min-width: 160px;">
                <button type="button" class="button-secondary" onclick="selectAllShownCatalog()" style="padding: 4px 10px; font-size: 13px;">Select shown</button>
                <button type="button" class="button-secondary" onclick="clearCatalogSelection()" style="padding: 4px 10px; font-size: 13px;">Clear all</button>
                <button type="button" onclick="saveCuration()" style="padding: 4px 10px; font-size: 13px;">Save Curation</button>
              </div>
              <div class="muted" id="curationStatus" style="margin-top: 6px;"></div>
            </div>
          </div>
          <div class="muted" id="catalogCount">Loading catalog...</div>
        </div>
        <div id="catalog" class="catalog"></div>
      </div>
      <div class="card">
        <h2>OAuth Provider Logins</h2>
        <p class="muted">Some providers authenticate via OAuth instead of a static API key. Use the controls below to sign in. Tokens are stored locally at <code>~/.config/local-router/oauth-credentials.json</code> and refreshed automatically.</p>
        <div id="oauthProviderList" class="provider-grid"></div>
      </div>
`;
  return renderLayout('Providers & Models', body, params);
}
