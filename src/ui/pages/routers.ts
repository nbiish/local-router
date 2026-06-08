import { renderLayout } from './layout';

export function renderRoutersPage(params: {
  defaultRouterId: string;
  defaultRouterCandidatesText: string;
  defaultFallbackModelsText: string;
}): string {
  const body = `
          <div>
            <h2>Router Models</h2>
            <p class="muted">Create a local router model from explicit candidate model IDs. Routers appear as local-router/&lt;name&gt; and only select from the candidates listed here.</p>
          </div>
          <div class="muted" id="routerCount">Loading router models...</div>
        </div>
        <div class="provider-picker">
          <div class="form-group">
            <label for="routerRouteId">Presented Router Model Name</label>
            <input id="routerRouteId" type="text" placeholder="auto-router-main">
          </div>
          <div class="form-group">
            <label for="routerType">Router Type</label>
            <select id="routerType" onchange="toggleBanditFields()">
              <option value="auto-local">auto-local — smart balance (recommended)</option>
              <option value="pareto-code">pareto-code — coding-first</option>
              <option value="priority">priority — manual order</option>
              <option value="bandit-local">bandit-local — learns from usage</option>
            </select>
            <div id="routerTypeHelp" class="muted"></div>
          </div>
        </div>
        <div class="provider-picker">
          <div class="form-group">
            <label for="routerMinCodingScore">Min Coding Score (0-1)</label>
            <input id="routerMinCodingScore" type="number" min="0" max="1" step="0.01" value="0.66">
          </div>
          <div class="form-group">
            <label for="routerCostQualityTradeoff">Cost/Quality Tradeoff (0-10)</label>
            <input id="routerCostQualityTradeoff" type="number" min="0" max="10" step="1" value="7">
          </div>
          <div class="form-group" id="banditExplorationGroup" style="display:none;">
            <label for="routerExplorationBudget">Exploration Budget (0-1)</label>
            <input id="routerExplorationBudget" type="number" min="0" max="1" step="0.01" value="0.05">
            <p class="muted">Controls how much the bandit explores new candidates. Higher = more exploration. 0.05 is a safe default.</p>
          </div>
        </div>
        <label class="flag-toggle" style="margin-bottom:8px;">
          <input id="routerEnableAutoTiers" type="checkbox">
          Enable Auto Tiers — automatically derank underperforming candidates (requires 50+ samples)
        </label>
        <div class="form-group">
          <label>Candidate Models</label>
          <div class="router-tabs">
            <button id="tab-visual-btn" class="router-tab-btn active" onclick="switchToBuilderTab()">Visual Builder</button>
            <button id="tab-advanced-btn" class="router-tab-btn" onclick="switchToAdvancedTab()">Advanced (Text)</button>
          </div>
          <div id="tab-visual" class="router-tab-content">
            <div class="provider-picker" style="margin:0; gap:10px;">
              <div class="form-group" style="margin:0;">
                <label for="routerModelSearch">Add Model</label>
                <div class="dropdown-search-container">
                  <input id="routerModelSearch" type="text" placeholder="Search models..." autocomplete="off" oninput="filterModelDropdown()" onfocus="openModelDropdown()">
                  <div id="routerModelDropdown" class="dropdown-search-menu"></div>
                </div>
              </div>
              <div class="form-group" style="margin:0; align-self:end;">
                <button onclick="addSelectedCandidate()">Add to Candidates</button>
              </div>
            </div>
            <label class="flag-toggle" style="margin-top:10px;">
              <input id="routerFallbackGroupToggle" type="checkbox" onchange="toggleFallbackGroupMode(this.checked)">
              Add candidate as fallback group (same model across providers chains as fallback)
            </label>
          </div>
          <div id="tab-advanced" class="router-tab-content" style="display:none;">
            <textarea id="routerCandidatesText" placeholder="wafer-ai-deepseek-v4-pro, coding=0.86, input=1, output=2, latency=1200&#10;openrouter-chain-of-draft, coding=0.80&#10;mimo-mimo-v2.5-pro, coding=0.45"></textarea>
          </div>
        </div>
        <div class="button-row" style="margin-top:14px;">
          <button onclick="saveRouterRoute()">Add / Update Router Model</button>
          <button class="button-secondary" onclick="clearRouterRouteForm()">Reset Router Defaults</button>
          <button class="button-secondary" onclick="configureVSCodePicker()">Refresh VS Code Model Picker</button>
          <a class="button-secondary" href="/api/router-candidates.csv" style="display:inline-block; text-decoration:none; padding:10px 15px; border-radius:4px;">Export Candidates CSV</a>
          <a class="button-secondary" href="/api/router-events.csv" style="display:inline-block; text-decoration:none; padding:10px 15px; border-radius:4px;">Export Events CSV</a>
          <button class="button-secondary" onclick="recomputeRouter()">Recompute from Telemetry</button>
          <button class="button-secondary" onclick="importRouterBackup()">Import Backup</button>
        </div>
        <div id="recomputeResults" style="margin-top:12px; display:none;">
          <h4>Recompute Results</h4>
          <div id="recomputeSummary" class="muted"></div>
          <div id="recomputeProposals" style="margin-top:8px;"></div>
        </div>
        <input type="file" id="routerImportFile" accept=".json" style="display:none;" onchange="handleRouterImportFile(event)">
        <div id="routerRouteList" class="fallback-route-list">
          <div class="fallback-route-empty">Loading router models...</div>
        </div>
        <div style="margin-top:18px;">
          <label style="font-weight:500;">Candidate Order (drag to reorder · click toggle to enable/disable a model)</label>
          <p class="muted" style="margin:4px 0 8px; font-size:12px;">Order is saved with the route. Active reordering changes the persisted chain above.</p>
          <div id="routerCandidateList" class="router-candidate-list">
            <div class="router-candidate-empty">No candidates added yet. Search and add models above.</div>
          </div>
        </div>
      </div>
      <div class="card">
`;
  return renderLayout('Auto Router Models', body, params);
}
