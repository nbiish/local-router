import { renderLayout } from './layout';

export function renderDiagnosticsPage(params: {
  defaultRouterId: string;
  defaultRouterCandidatesText: string;
  defaultFallbackModelsText: string;
}): string {
  const body = `
      <div class="card">
        <div class="catalog-meta">
          <div>
            <h2>Diagnostics</h2>
            <p class="muted">Redacted request/response summaries for troubleshooting. API keys, authorization headers, and full payload content are excluded.</p>
          </div>
          <div class="muted" id="diagnosticsStatus">Loading diagnostics...</div>
        </div>
        <div class="diagnostics-controls">
          <button id="diagnosticsToggle" class="button-secondary" onclick="toggleDiagnostics()">Enable Diagnostics</button>
          <button class="button-secondary" onclick="refreshDiagnostics()">Refresh Diagnostics</button>
          <button class="button-secondary" onclick="clearDiagnostics()">Clear Diagnostics</button>
        </div>
        <pre id="diagnosticsLog" class="diagnostics-log">Loading diagnostics...</pre>
      </div>
      <div class="card">
        <div class="catalog-meta">
          <div>
            <h2>Recent Sessions</h2>
            <p class="muted">Track CLI agent sessions by endpoint. Rate sessions thumbs up/down to inform Continuous Improvement (CIP) routing decisions.</p>
          </div>
          <div class="muted" id="sessionCount">Loading sessions...</div>
        </div>
        <div id="sessionList" class="fallback-route-list">
          <div class="fallback-route-empty">Loading sessions...</div>
        </div>
      </div>
`;
  return renderLayout('Diagnostics & Sessions', body, params);
}
