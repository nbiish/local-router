function renderOAuthProviderCards(): string {
  const providers = listOAuthProviders();
  return providers.map((id) => {
    const status = getOAuthStatus(id);
    const configured = status.configured;
    const pending = status.pendingDeviceCode;
    const accountLabel = status.accountLabel || "not signed in";
    let html = `<section class="provider-card${configured ? " active" : ""}">` +
      `<h4>${escapeHtml(status.displayName || id)}</h4>` +
      `<div class="muted">Account: ${escapeHtml(accountLabel)}</div>` +
      `<div class="muted">Auth: ${escapeHtml(status.authType || "")}</div>`;
    if (pending) {
      html += `<div class="pill status-pill pending" style="font-size:13px;font-weight:bold;margin:4px 0;">Code: ${escapeHtml(pending.userCode)}</div>` +
        `<div class="muted" style="margin:4px 0 8px;">Enter code at <a href="${escapeHtml(pending.verificationUri)}" target="_blank" rel="noopener noreferrer" style="color:var(--link);font-weight:bold;text-decoration:underline;">${escapeHtml(pending.verificationUri)}</a></div>` +
        `<div class="row row-actions" style="gap:6px;">` +
          `<button type="button" data-copy-code="${escapeHtml(pending.userCode)}">📋 Copy Code</button>` +
          `<a href="${escapeHtml(pending.verificationUri)}" target="_blank" rel="noopener noreferrer" class="button button-secondary" style="display:inline-flex;align-items:center;padding:4px 8px;font-size:12px;text-decoration:none;">Open GitHub ↗</a>` +
        `</div>`;
    }
    if (configured) {
      html += `<div class="pill status-pill configured">Logged in</div>` +
        `<div class="row row-actions">` +
          `<button data-oauth-logout="${escapeHtml(id)}">Log out</button>` +
        `</div>`;
    } else {
      html += `<div class="pill status-pill pending">Not logged in</div>` +
        `<div class="row row-actions">` +
          `<button data-oauth-login="${escapeHtml(id)}">Log in with ${escapeHtml(status.displayName || id)}</button>` +
        `</div>`;
    }
    html += `</section>`;
    return html;
  }).join("");
}

import { renderLayout, escapeHtml } from './layout';
import { listOAuthProviders, getOAuthStatus } from '../../oauth-providers';

export function renderProvidersPage(params: {
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
      </div>
      <div class="card">
        <div class="catalog-meta">
          <div>
            <h2>Providers, Keys &amp; Models</h2>
            <p class="muted" id="catalogDescription">Toggle the models you want served — the selection powers both the OpenAI-compatible and Ollama-compatible endpoints.</p>
            <details class="endpoint-help" style="margin-top:10px;">
              <summary>IDE compatibility — VS Code "Unable to verify Ollama server version"</summary>
              <p class="muted">VS Code Copilot Chat verifies the server before listing models: <code>GET /api/version</code> must answer 200 JSON with version ≥ 0.6.4, then <code>GET /api/tags</code> and per-model <code>POST /api/show</code>. This proxy mirrors the real backend ollama's version at <code>/api/version</code> (env <code>OLLAMA_VERSION</code> overrides) and listens on both <code>127.0.0.1</code> and <code>::1</code> so <code>http://localhost:11434</code> resolves on IPv4-only and IPv6-first hosts alike.</p>
              <p class="muted" style="margin-top:6px;">If VS Code still shows the error: point Copilot Chat at this proxy explicitly — set <code>github.copilot.chat.byok.ollamaEndpoint</code> (or Manage Models → Ollama) to <code>http://localhost:11434</code>, reload the window, then use <em>Refresh VS Code Model Picker</em>. A real <code>ollama serve</code> bound on this port ahead of Local Router also triggers the error; Local Router keeps real Ollama on port 11435 for this reason.</p>
            </details>
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
                <button type="button" class="button-secondary" onclick="selectAllCatalog()" style="padding: 4px 10px; font-size: 13px;">Select all</button>
                <button type="button" class="button-secondary" onclick="clearCatalogSelection()" style="padding: 4px 10px; font-size: 13px;">Deselect all</button>
                <button type="button" onclick="saveCuration()" style="padding: 4px 10px; font-size: 13px;">Save Curation</button>
              </div>
              <div class="muted" id="curationStatus" style="margin-top: 6px;"></div>
              <div style="margin-top: 10px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                <label for="curationConfigSelect" style="font-weight: 500;">Curation configs</label>
                <select id="curationConfigSelect" onchange="onCurationConfigSelected()"></select>
                <input id="curationConfigName" type="text" placeholder="config name…" maxlength="128" style="width: 180px;">
                <button type="button" class="button-secondary" onclick="saveCurationConfig()" style="padding: 4px 10px; font-size: 13px;">Save as…</button>
                <button type="button" class="button-secondary" onclick="loadCurationConfig()" style="padding: 4px 10px; font-size: 13px;">Load</button>
                <button type="button" class="button-secondary" onclick="deleteCurationConfig()" style="padding: 4px 10px; font-size: 13px;">Delete</button>
                <button type="button" class="button-secondary" onclick="setDefaultCurationConfig()" style="padding: 4px 10px; font-size: 13px;">Set as default</button>
                <button type="button" class="button-secondary" onclick="clearDefaultCurationConfig()" style="padding: 4px 10px; font-size: 13px;">Clear default</button>
              </div>
            </div>
          </div>
          <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 8px;">
            <div class="muted" id="providerCount">Loading providers...</div>
            <div class="muted" id="catalogCount">Loading catalog...</div>
            <button type="button" class="button-secondary" onclick="syncPqcBundleKeys(true)" style="padding: 4px 10px; font-size: 13px;">🔁 Sync PQC keys</button>
          </div>
        </div>
        <p class="muted">Each provider below shows its key status, fetch controls, and models in one place. Check a model to serve it (saves automatically); <strong>＋ Fallback</strong> stages it into a chain on the <a href="/config/fallback">Fallback Routes</a> page, where all chain editing lives.</p>
        <div id="catalog" class="catalog"></div>
      </div>
      <div class="card">
        <h2>OAuth Provider Logins</h2>
        <p class="muted">Some providers authenticate via OAuth instead of a static API key. Use the controls below to sign in. Tokens are stored locally at <code>~/.config/local-router/oauth-credentials.json</code> and refreshed automatically.</p>
        <div id="oauthProviderList" class="provider-grid">${renderOAuthProviderCards()}</div>
      </div>
`;
  return renderLayout('Providers & Models', body, params);
}
