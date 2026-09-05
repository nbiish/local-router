import { renderLayout } from './layout';

export function renderFallbackPage(params: {
  defaultFallbackModelsText: string;
}): string {
  const body = `
      <div class="card">
        <div class="catalog-meta">
          <div>
            <h2>Fallback Model Routes</h2>
            <p class="muted">Create a presented fallback model from existing model IDs. The route appears in /v1/models, /api/tags, /api/show, and VS Code picker refreshes.</p>
            <p class="muted">The <strong>fallback-models</strong> route is the system safety net: when a direct model fails, Local Router cascades to this chain automatically.</p>
          </div>
          <div class="muted" id="fallbackCount">Loading fallback routes...</div>
        </div>
        <div class="provider-picker">
          <div class="form-group">
            <label for="fallbackRouteSelect">Fallback Chain</label>
            <select id="fallbackRouteSelect" onchange="selectFallbackRouteToEdit(this.value)"></select>
            <input id="fallbackRouteNewName" type="text" placeholder="new-chain-name" maxlength="128" style="display:none; margin-top:6px;">
            <p class="muted" style="margin:4px 0 0;">Pick an existing chain to edit its steps below (drag/toggle auto-saves). Pick <strong>— New chain…</strong> to author a fresh one.</p>
          </div>
          <div class="form-group">
            <label>Add Model to Chain</label>
            <div class="dropdown-search-container">
              <input id="fallbackModelSearch" type="text" placeholder="Search your toggled-on models..." autocomplete="off" oninput="filterFallbackModelDropdown()" onfocus="openFallbackModelDropdown()">
              <div id="fallbackModelDropdown" class="dropdown-search-menu"></div>
            </div>
            <p class="muted" style="margin:4px 0 0;">Lists only your toggled-on models (checked on Providers &amp; Models; local ollama always included), re-fetched at every open. ✓ marks models already in this chain; chips show context/output/tools/vision.</p>
            <button style="margin-top:8px;" onclick="addSelectedFallbackCandidate()">Add to Chain</button>
          </div>
          <div class="form-group">
            <label for="fallbackModelsText">Fallback Model Chain (advanced — synced with order list)</label>
            <textarea id="fallbackModelsText" style="min-height:80px;" placeholder="wafer-ai-deepseek-v4-pro&#10;openrouter-chain-of-draft&#10;moonshot-kimi-k2.6 disabled" oninput="applyFallbackTextareaToStore()"></textarea>
          </div>
        </div>
        <div class="button-row">
          <button onclick="saveFallbackRoute()">Save Chain</button>
          <button class="button-secondary" onclick="setFallbackDefault()" title="Copy this chain into the default fallback-models route (persists across restarts)">Set as Default</button>
          <button class="button-secondary" onclick="unsetFallbackDefault()" title="Empty the default fallback-models route">Unset Default</button>
          <button class="button-secondary" onclick="exportFallbackSettings()" title="Download all fallback routes as fallback-models.json">Export JSON</button>
          <button class="button-secondary" onclick="document.getElementById('fallbackImportInput').click()" title="Import fallback routes from a JSON file">Import JSON</button>
          <input id="fallbackImportInput" type="file" accept="application/json" style="display:none" onchange="importFallbackSettings(event)">
          <button class="button-secondary" onclick="clearFallbackRouteForm()">Clear Form</button>
          <button class="button-secondary" onclick="resetFallbackSettings()">Reset Settings</button>
          <button class="button-secondary" onclick="applyFallbackDefaults()">Reset Fallback Defaults</button>
          <button class="button-secondary" onclick="configureVSCodePicker()">Refresh VS Code Picker</button>
        </div>
        <p class="muted" style="margin:6px 0 0;">Chains persist across shutdowns (fallback-models.json). The ✕ button removes a model from the chain entirely; the checkbox only disables it. <strong>Set as Default</strong> copies this chain into <code>local-router/fallback-models</code> — the safety net used when direct models fail.</p>
        <div style="margin-top:14px;">
          <label>Fallback Order (drag to reorder · click toggle to enable/disable a model)</label>
          <div id="fallbackCandidateList" class="router-candidate-list">
            <div class="router-candidate-empty">No candidates added yet. Search and add models above.</div>
          </div>
        </div>
        <div id="fallbackRouteList" class="fallback-route-list">
          <div class="fallback-route-empty">Loading fallback routes...</div>
        </div>
      </div>
      <div class="card">
        <div class="routing-info-box">
          <h4>How routing works</h4>
          <ul>
            <li><strong>Direct model</strong> — one provider call (e.g. <code>zenmux-deepseek-v4-pro</code>). On failure, cascades to the system fallback chain.</li>
            <li><strong>Fallback route</strong> (<code>local-router/&lt;chain&gt;</code>) — ordered retry chain with backoff. Use <code>local-router/fallback-models</code> as the system safety net.</li>
          </ul>
                      <p class="muted" style="margin:10px 0 0;">This page is the only fallback chain editor. Use the <strong>＋ Fallback</strong> button on any model in the Providers &amp; Models catalog to stage it here (existing chains save instantly); then drag to order. Configure provider keys — candidates light up when ready.</p>
        </div>
      </div>
`;
  return renderLayout('Fallback Routes', body, params);
}
