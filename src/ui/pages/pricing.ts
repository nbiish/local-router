import { renderLayout } from './layout';

export function renderPricingPage(params: {
  defaultRouterId: string;
  defaultRouterCandidatesText: string;
  defaultFallbackModelsText: string;
}): string {
  const body = `
        <div class="catalog-meta">
          <div>
            <h2>Model Pricing Overrides</h2>
            <p class="muted">USD per 1M tokens for router cost scoring. Saved to <code>~/.config/local-router/provider-pricing.json</code>. Use for limited-time promos (ZenMux matched rates, Wafer MiniMax-M3 weekly pricing, etc.).</p>
          </div>
          <div class="muted" id="pricingCount">Loading pricing...</div>
        </div>
        <div class="form-group" style="display:grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <div>
            <label for="pricingModelId">Presented model ID</label>
            <input id="pricingModelId" type="text" placeholder="zenmux-qwen3.7-max">
          </div>
          <div>
            <label for="pricingValidUntil">Valid until (YYYY-MM-DD, optional)</label>
            <input id="pricingValidUntil" type="text" placeholder="2026-06-11">
          </div>
          <div>
            <label for="pricingInput">Input $ / 1M tokens</label>
            <input id="pricingInput" type="number" min="0" step="0.01" placeholder="1.25">
          </div>
          <div>
            <label for="pricingOutput">Output $ / 1M tokens</label>
            <input id="pricingOutput" type="number" min="0" step="0.01" placeholder="3.75">
          </div>
          <div style="grid-column: 1 / -1;">
            <label for="pricingLabel">Label / notes</label>
            <input id="pricingLabel" type="text" placeholder="ZenMux Qwen3.7-Max — 50% off OpenRouter match">
          </div>
        </div>
        <div style="margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap;">
          <button onclick="saveProviderPricingEntry()">Save Pricing Override</button>
          <button class="button-secondary" onclick="clearProviderPricingForm()">Clear Form</button>
        </div>
        <div id="pricingList" class="fallback-route-list" style="margin-top: 16px;">Loading pricing overrides...</div>
      </div>
      <div class="card">
`;
  return renderLayout('Pricing Overrides', body, params);
}
