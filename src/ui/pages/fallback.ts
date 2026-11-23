import { renderLayout } from './layout';
import { routerSettingsLocation } from '../../config-persistence';
import { describeConfigLocation } from '../../config-paths';

/** Paths are operator-controlled, so they are escaped before entering the page. */
function escapePathText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderFallbackPage(params: {
  defaultFallbackModelsText: string;
}): string {
  // The page states where the chain actually lives on THIS machine, because the
  // whole point of the repo-local file is that it differs from the old path.
  const chainConfig = escapePathText(describeConfigLocation(routerSettingsLocation()));
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
          <button class="button-secondary" onclick="configureVSCodePicker()">Refresh VS Code Picker</button>
        </div>
        <p class="muted" style="margin:6px 0 0;">Edits auto-save into the authoritative chain file <code>${chainConfig}</code> (applied at boot, watched live). When this build runs from a git checkout the file lives in the checkout, so a synced clone reads the same chain; credentials and discovery caches stay in <code>~/.config/local-router</code>. The ✕ button removes a model from the chain entirely; the checkbox only disables it. The <strong>fallback-models</strong> route is the safety net used when direct models fail.</p>
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
                      <p class="muted" style="margin:10px 0 0;">This page is the only fallback chain editor. Use the <strong>+ Fallback</strong> button on any model in the Providers &amp; Models catalog to stage it here (existing chains save instantly); then drag to order. Configure provider keys — candidates light up when ready.</p>
        </div>
      </div>
      <div class="card" id="portableConfigCard">
        <h3>Portable configuration</h3>
        <p class="muted">Save the fallback chain to a versioned JSON file you can carry to another machine. Import shows a preview before anything is written. Provider keys and catalog selection never travel — each machine keeps its own credentials.</p>
        <div class="button-row">
          <button type="button" onclick="exportFallbackConfigBundle()">Export chain</button>
          <label class="button button-secondary" for="fallbackConfigFile" style="cursor:pointer;">Import chain…</label>
          <input id="fallbackConfigFile" type="file" accept="application/json,.json" style="display:none;" onchange="previewFallbackConfigFile(this)">
        </div>
        <div id="fallbackImportPreview" style="display:none; margin-top:12px; padding:10px 14px; border:1px solid var(--border); border-radius:4px; background:var(--surface-soft);"></div>
        <div id="fallbackImportActions" class="button-row" style="display:none; margin-top:10px;">
          <button type="button" onclick="applyFallbackConfigBundle()">Apply imported chain</button>
          <button type="button" class="button-secondary" onclick="cancelFallbackConfigImport()">Cancel</button>
        </div>
      </div>
      <script>
        var pendingFallbackConfigText = '';

        function portableEscape(value) {
          return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        function portableMessage(text, kind) {
          if (typeof setMessage === 'function') setMessage(text, kind || 'success');
        }

        function portableList(label, values) {
          if (!values || values.length === 0) return '';
          return '<div style="margin:4px 0;"><strong>' + portableEscape(label) + ':</strong> ' +
            values.map(function(v) { return '<code>' + portableEscape(v) + '</code>'; }).join(', ') + '</div>';
        }

        function downloadFallbackConfigBundle(config, filename) {
          var blob = new Blob([config], { type: 'application/json' });
          var url = URL.createObjectURL(blob);
          var anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = filename;
          document.body.appendChild(anchor);
          anchor.click();
          document.body.removeChild(anchor);
          setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
        }

        async function exportFallbackConfigBundle() {
          try {
            var response = await fetch('/api/config/fallback/export');
            var data = await response.json();
            if (!response.ok || !data.success) throw new Error(data.error || 'Export failed');
            downloadFallbackConfigBundle(data.config, data.filename);
            portableMessage('Fallback chain exported to ' + data.filename, 'success');
          } catch (error) {
            portableMessage('Export failed: ' + (error && error.message ? error.message : String(error)), 'error');
          }
        }

        function cancelFallbackConfigImport() {
          pendingFallbackConfigText = '';
          var preview = document.getElementById('fallbackImportPreview');
          var actions = document.getElementById('fallbackImportActions');
          if (preview) { preview.style.display = 'none'; preview.innerHTML = ''; }
          if (actions) actions.style.display = 'none';
        }

        async function previewFallbackConfigFile(input) {
          var file = input.files && input.files[0];
          input.value = '';
          if (!file) return;
          if (file.size > 1024 * 1024) {
            portableMessage('Config file is too large (limit 1 MiB).', 'error');
            return;
          }
          try {
            var text = await file.text();
            var response = await fetch('/api/config/fallback/import', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ config: text, dryRun: true })
            });
            var data = await response.json();
            if (!response.ok || !data.success) {
              portableMessage('Import rejected: ' + (data.error || 'invalid config'), 'error');
              return;
            }
            pendingFallbackConfigText = text;
            var diff = data.diff || {};
            var html = '<strong>Preview — nothing has been written.</strong>' +
              portableList('Added steps', diff.chainAdded) +
              portableList('Removed steps', diff.chainRemoved) +
              portableList('Added routes', diff.routesAdded) +
              portableList('Removed routes', diff.routesRemoved) +
              (diff.orderChanged ? '<div><strong>Step order changed.</strong></div>' : '') +
              '<div class="muted" style="margin-top:6px;">Save the current chain first if you may want to roll back.</div>';
            var preview = document.getElementById('fallbackImportPreview');
            var actions = document.getElementById('fallbackImportActions');
            if (preview) { preview.innerHTML = html; preview.style.display = 'block'; }
            if (actions) actions.style.display = 'flex';
          } catch (error) {
            portableMessage('Import preview failed: ' + (error && error.message ? error.message : String(error)), 'error');
          }
        }

        async function applyFallbackConfigBundle() {
          if (!pendingFallbackConfigText) return;
          try {
            var response = await fetch('/api/config/fallback/import', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ config: pendingFallbackConfigText, dryRun: false })
            });
            var data = await response.json();
            if (!response.ok || !data.success) {
              portableMessage('Import failed: ' + (data.error || 'unknown error'), 'error');
              return;
            }
            portableMessage('Fallback chain imported. Reloading…', 'success');
            setTimeout(function() { window.location.reload(); }, 600);
          } catch (error) {
            portableMessage('Import failed: ' + (error && error.message ? error.message : String(error)), 'error');
          }
        }
      </script>
`;
  return renderLayout('Fallback Routes', body, params);
}
