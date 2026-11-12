import { renderLayout } from './layout';

export function renderTrajectoriesPage(params: {
  defaultFallbackModelsText: string;
}): string {
  const body = `
      <div class="card" style="border-left: 4px solid var(--primary);">
        <div class="catalog-meta">
          <div>
            <h2 style="margin:0 0 6px;">Trajectories &amp; Fallback-Chain Health</h2>
            <p class="muted" style="margin:0; line-height:1.5;">
              Every model call is logged as a <strong>full trajectory</strong>: each fallback stage
              attempted, failed, or skipped &mdash; with the reason &mdash; plus the winner, token usage,
              and cost. Use it to detect a provider/model in a chain that <strong>stopped answering</strong>
              or is being <strong>silently skipped</strong>.
            </p>
          </div>
          <div>
            <span class="pill catalog" style="font-size:12px; font-weight:600;">Agent-inspectable</span>
          </div>
        </div>
        <div class="routing-info-box" style="margin-top:14px; background:var(--surface-soft);">
          <p style="margin:0 0 8px; font-weight:600; color:var(--text);">Where the log lives</p>
          <ul style="margin:0; padding-left:20px; color:var(--muted); line-height:1.6;">
            <li><strong>On disk:</strong> <code>~/.config/local-router/trajectories/trajectories.jsonl</code> &mdash; append-only JSONL, one record per model call; large payloads spill to <code>spill/&lt;sha256&gt;.txt</code> and are referenced by <code>sha:</code> receipts.</li>
            <li><strong>API:</strong> <code>GET /api/trajectories</code> (summaries), <code>GET /api/trajectories/health</code> (per-chain analysis), <code>GET /api/trajectories/:id</code> (full record, <code>?part=request|response|thinking|toolCalls</code> for payloads), <code>GET /api/trajectories/export</code> (raw JSONL).</li>
            <li><strong>Agents:</strong> grep the JSONL directly or curl the API &mdash; every skipped chain member carries its reason (<code>disabled_toggle</code>, <code>no_configured_key</code>, <code>context_window_too_small</code>, &hellip;).</li>
          </ul>
        </div>
      </div>

      <div class="card">
        <div class="catalog-meta">
          <h3 style="margin:0;">Chain health</h3>
          <div class="button-row" style="margin:0;">
            <button type="button" class="button-secondary" onclick="loadTrajectoryHealth()">🔄 Refresh</button>
          </div>
        </div>
        <div id="trajectoryHealth" style="margin-top:10px;">Loading&hellip;</div>
        <p class="muted" style="margin:12px 0 0;">
          Flags: <span class="pill status-pill pending">never_answers</span> attempted repeatedly, never succeeded &middot;
          <span class="pill status-pill pending">always_skipped</span> skipped every time it was considered &middot;
          <span class="pill status-pill pending">recent_error_spike</span> failure rate recently jumped &middot;
          <span class="pill status-pill pending">missing_from_plan</span> configured in the chain but never eligible, excluded, nor executed.
        </p>
      </div>

      <div class="card">
        <div class="catalog-meta">
          <h3 style="margin:0;">Recent trajectories</h3>
          <div class="button-row" style="margin:0; gap:6px; align-items:center;">
            <select id="trajectoryRouteFilter" onchange="loadTrajectoryList()" style="font-size:12px;">
              <option value="">all routes</option>
            </select>
            <select id="trajectoryOutcomeFilter" onchange="loadTrajectoryList()" style="font-size:12px;">
              <option value="">all outcomes</option>
              <option value="success">success only</option>
              <option value="failure">failures only</option>
            </select>
            <button type="button" class="button-secondary" onclick="loadTrajectoryList()">🔄 Refresh</button>
            <a class="button button-secondary" href="/api/trajectories/export" style="text-decoration:none;">Export JSONL</a>
            <button type="button" onclick="clearTrajectories()">Clear log</button>
          </div>
        </div>
        <div id="trajectoryList" style="margin-top:10px;">Loading&hellip;</div>
        <p class="muted" style="margin:12px 0 0;">Click a row to expand its full stage timeline. <code>direct+cascade</code> means the requested direct model failed and the system fallback chain carried the request.</p>
      </div>
  `;
  return renderLayout('Trajectories', body, {
    defaultFallbackModelsText: params.defaultFallbackModelsText
  });
}
