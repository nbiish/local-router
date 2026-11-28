import { renderLayout } from './layout';

export function renderAccountPage(params: {
  defaultFallbackModelsText: string;
}): string {
  const body = `
      <div class="card">
        <div class="catalog-meta">
          <div>
            <h2>Account &amp; Tied Machines</h2>
            <p class="muted">
              Open-source Local Router always serves on <code>http://localhost:11434</code> with zero sign-up required.
              Sign in with Google, Apple, or Microsoft on <code>local-router.com</code> to bind this machine via PQC
              (<code>ML-KEM-768</code> + <code>ML-DSA-65</code> + <code>SHA3-256</code>), manage your tied machines across
              Free / Pro / Business limits, and unlock managed <code>https://inference.local-router.com/v1</code> routing.
            </p>
          </div>
          <span class="pill catalog" id="acctTierPill">checking&hellip;</span>
        </div>
        <div id="acctSummaryBox" class="routing-info-box" style="margin-top:12px;">
          <div id="acctSummaryLine" style="font-weight:600;">Loading local account &amp; PQC status&hellip;</div>
          <div id="acctHashLine" class="muted" style="font-size:12px;margin-top:6px;"></div>
          <div id="acctLeaseLine" class="muted" style="font-size:12px;margin-top:4px;"></div>
        </div>
        <div class="button-row" style="margin-top:14px;align-items:center;">
          <a class="button-secondary" id="acctWebDashboardLink" href="https://local-router.com/dashboard" target="_blank" rel="noopener" style="text-decoration:none;padding:9px 14px;border-radius:4px;font-size:14px;">Open local-router.com Dashboard</a>
          <a class="button-secondary" id="acctUpgradeLink" href="https://local-router.com/pricing" target="_blank" rel="noopener" style="text-decoration:none;padding:9px 14px;border-radius:4px;font-size:14px;">View Plans / Upgrade Tier</a>
          <button class="button-secondary" id="acctRefreshLeaseBtn" type="button" onclick="refreshAccountLease()" style="display:none;">Refresh Tier &amp; Lease</button>
          <button class="button-secondary" id="acctRelinkBtn" type="button" onclick="showRelinkForm()" style="display:none;">Re-link This Machine</button>
          <button class="button-secondary" id="acctUnpairBtn" type="button" onclick="unpairThisMachine()" style="display:none;">Unpair This Machine</button>
          <span id="acctActionMsg" class="muted" style="font-size:12px;"></span>
        </div>
      </div>

      <div class="card" id="acctConnectionsCard">
        <div class="catalog-meta">
          <div>
            <h2>Connections &amp; PQC Bridge</h2>
            <p class="muted">
              Local apps always connect to <code>http://localhost:11434/v1</code> (zero sign-up). Remote agentic harnesses and Business employee chats connect over HTTPS using this machine's built-in PQC bridge key.
            </p>
          </div>
          <span class="pill catalog" id="acctBridgePill">checking&hellip;</span>
        </div>
        <div id="acctBridgeMeta" class="muted" style="font-size:12px;margin-top:10px;">Loading local PQC bridge &amp; Cloudflared status&hellip;</div>
        <div class="button-row" style="margin-top:12px;align-items:center;">
          <button type="button" id="acctCopyKeyBtn" onclick="acctCopyBridgeKey()">Copy Bridge Key</button>
          <button class="button-secondary" type="button" id="acctCopyTeamBtn" onclick="acctCopyTeamConfig()">Copy Team / Harness Config</button>
          <button class="button-secondary" type="button" id="acctRotateKeyBtn" onclick="acctRotateBridgeKey()">Rotate Machine Key</button>
          <button class="button-secondary" type="button" id="acctStartBridgeBtn" onclick="acctStartBridge()">Start Bridge</button>
          <button class="button-secondary" type="button" id="acctStopBridgeBtn" onclick="acctStopBridge()" style="display:none;">Stop Bridge</button>
          <span id="acctBridgeFeedback" class="muted" style="font-size:12px;"></span>
        </div>
      </div>

      <div class="card" id="acctPairCard">
        <div class="catalog-meta">
          <div>
            <h2 id="acctPairHeading">Sign In &amp; Pair This Machine</h2>
            <p class="muted" id="acctPairHelp">
              1. Sign in at <a href="https://local-router.com/login?next=/dashboard" target="_blank" rel="noopener">local-router.com/login</a> (Google, Apple, or Microsoft) and click <strong>Generate pairing code</strong>.<br>
              2. Paste the single-use <code>lrp_...</code> code below and optionally give this machine a friendly name. Deleting a machine frees its tier slot so you can re-link it anytime.
            </p>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));gap:12px;margin-top:12px;">
          <div class="form-group" style="margin-bottom:0;">
            <label for="acctPairCodeInput">Single-use Pairing Code</label>
            <input id="acctPairCodeInput" type="password" placeholder="lrp_..." autocomplete="off">
          </div>
          <div class="form-group" style="margin-bottom:0;">
            <label for="acctMachineLabelInput">Machine Name (optional)</label>
            <input id="acctMachineLabelInput" type="text" maxlength="80" placeholder="e.g. Mac Studio, Windows Rig">
          </div>
        </div>
        <div class="button-row" style="margin-top:12px;align-items:center;">
          <button type="button" id="acctPairSubmitBtn" onclick="pairThisMachine()">Pair This Machine</button>
          <span id="acctPairFeedback" class="muted" style="font-size:12px;"></span>
        </div>
      </div>

      <div class="card" id="acctMachinesCard">
        <div class="catalog-meta">
          <div>
            <h2>Tied Machines &amp; Tier Quota</h2>
            <p class="muted" id="acctQuotaSubtitle">
              Pair this machine above to view, rename, and delete all machines tied to your account within your Free, Pro, or Business tier limits.
            </p>
          </div>
          <button class="button-secondary" id="acctReloadMachinesBtn" type="button" onclick="loadTiedMachines()">Refresh Machines</button>
        </div>
        <div id="acctMachinesMsg" class="muted" style="font-size:12px;margin-top:8px;"></div>
        <div style="overflow-x:auto;margin-top:12px;">
          <table id="acctMachinesTable" style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead>
              <tr style="border-bottom:1px solid var(--border);text-align:left;">
                <th style="padding:8px;">Machine</th>
                <th style="padding:8px;">Platform</th>
                <th style="padding:8px;">PQC / Machine Hash</th>
                <th style="padding:8px;">Lease Expires</th>
                <th style="padding:8px;">Actions</th>
              </tr>
            </thead>
            <tbody id="acctMachinesBody">
              <tr><td colspan="5" class="muted" style="padding:10px 8px;">Not paired yet. Localhost (<code>http://localhost:11434</code>) works without signing in.</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <script>
        (function initAccountProfilePage() {
          let currentStatus = null;

          function clearEl(el) {
            while (el && el.firstChild) el.removeChild(el.firstChild);
          }

          function showRelinkCard(noticeText) {
            const pairCard = document.getElementById('acctPairCard');
            const heading = document.getElementById('acctPairHeading');
            const fb = document.getElementById('acctPairFeedback');
            if (heading) heading.textContent = 'Re-link This Machine to Your Profile';
            if (pairCard) pairCard.style.display = 'block';
            if (noticeText && fb) fb.textContent = noticeText;
          }

          window.showRelinkForm = function showRelinkForm() {
            showRelinkCard('Generate a fresh lrp_... code on local-router.com/dashboard and paste it below to re-tie this machine.');
          };

          async function loadBridgeConnectionCard() {
            const pill = document.getElementById('acctBridgePill');
            const meta = document.getElementById('acctBridgeMeta');
            const startBtn = document.getElementById('acctStartBridgeBtn');
            const stopBtn = document.getElementById('acctStopBridgeBtn');
            try {
              const res = await fetch('/api/bridge/status');
              if (!res.ok) throw new Error('HTTP ' + res.status);
              const b = await res.json();
              if (pill) pill.textContent = b.running ? ('Bridge Running (' + b.mode + ')') : ('Localhost Ready · ' + b.bridgeKeySource);
              if (meta) {
                const cfText = b.running
                  ? ('Cloudflared: running (' + b.mode + (b.publicUrl ? ' → ' + b.publicUrl : '') + ')')
                  : (b.cloudflaredInstalled ? 'Cloudflared: ready (stopped)' : 'Cloudflared: not installed (' + b.installHint + ')');
                meta.textContent = 'Localhost: http://localhost:11434/v1 · Key: ' + (b.bridgeKeyFingerprint || 'n/a') + ' (' + b.bridgeKeySource + ') · ' + cfText;
              }
              if (startBtn) startBtn.style.display = b.managedByRouter ? 'none' : 'inline-block';
              if (stopBtn) stopBtn.style.display = b.managedByRouter ? 'inline-block' : 'none';
            } catch (err) {
              if (pill) pill.textContent = 'Unavailable';
              if (meta) meta.textContent = 'Could not load bridge status.';
            }
          }

          window.acctCopyBridgeKey = async function acctCopyBridgeKey() {
            const fb = document.getElementById('acctBridgeFeedback');
            try {
              const res = await fetch('/api/bridge-key/reveal', { method: 'POST' });
              const data = await res.json();
              if (!res.ok || !data.accessKey) throw new Error(data.error || 'Failed to read bridge key');
              if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(data.accessKey);
                if (fb) fb.textContent = 'Copied bridge key (' + data.fingerprint + ').';
              } else {
                if (fb) fb.textContent = 'Use CLI: localrouter bridge-key --copy';
              }
            } catch (err) {
              const errMsg = err && err.message ? err.message : String(err);
              if (fb) fb.textContent = 'Error: ' + errMsg;
              if (/revoked|not_found|403|401/i.test(errMsg)) {
                showRelinkCard('This machine was revoked or removed remotely — paste a fresh pairing code below to re-tie it.');
              }
            }
          };

          window.acctCopyTeamConfig = async function acctCopyTeamConfig() {
            const fb = document.getElementById('acctBridgeFeedback');
            try {
              const res = await fetch('/api/bridge-key/reveal', { method: 'POST' });
              const rev = await res.json();
              if (!res.ok || !rev.accessKey) throw new Error(rev.error || 'Failed to read bridge key');
              const endpoint = (currentStatus && currentStatus.inferenceEndpoint) || 'https://inference.local-router.com/v1';
              const snippet = ['Base URL: ' + endpoint, 'Model: fallback-models', 'API Key: ' + rev.accessKey].join('\\n');
              if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(snippet);
                if (fb) fb.textContent = 'Copied endpoint + key config (' + rev.fingerprint + ').';
              } else {
                if (fb) fb.textContent = 'Clipboard unavailable — use /config/agents or CLI.';
              }
            } catch (err) {
              const errMsg = err && err.message ? err.message : String(err);
              if (fb) fb.textContent = 'Error: ' + errMsg;
              if (/revoked|not_found|403|401/i.test(errMsg)) {
                showRelinkCard('This machine was revoked or removed remotely — paste a fresh pairing code below to re-tie it.');
              }
            }
          };

          window.acctRotateBridgeKey = async function acctRotateBridgeKey() {
            const fb = document.getElementById('acctBridgeFeedback');
            if (fb) fb.textContent = 'Rotating machine PQC key…';
            try {
              const res = await fetch('/api/bridge-key/rotate', { method: 'POST' });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || 'Rotation failed');
              if (fb) fb.textContent = 'Rotated to epoch ' + data.epoch + ' (' + data.machineFingerprint + ').';
              await loadBridgeConnectionCard();
            } catch (err) {
              const errMsg = err && err.message ? err.message : String(err);
              if (fb) fb.textContent = 'Error: ' + errMsg;
              if (/revoked|not_found|403|401/i.test(errMsg)) {
                showRelinkCard('This machine was revoked or removed remotely — paste a fresh pairing code below to re-tie it.');
              }
            }
          };

          window.acctStartBridge = async function acctStartBridge() {
            const fb = document.getElementById('acctBridgeFeedback');
            if (fb) fb.textContent = 'Starting Cloudflared bridge…';
            try {
              const res = await fetch('/api/bridge/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || 'Bridge start failed');
              if (fb) fb.textContent = 'Bridge running (' + data.mode + (data.publicUrl ? ' · ' + data.publicUrl : '') + ').';
              await loadBridgeConnectionCard();
            } catch (err) {
              const errMsg = err && err.message ? err.message : String(err);
              if (fb) fb.textContent = 'Error: ' + errMsg;
              if (/revoked|not_found|403|401/i.test(errMsg)) {
                showRelinkCard('This machine was revoked or removed remotely — paste a fresh pairing code below to re-tie it.');
              }
            }
          };

          window.acctStopBridge = async function acctStopBridge() {
            const fb = document.getElementById('acctBridgeFeedback');
            try {
              const res = await fetch('/api/bridge/stop', { method: 'POST' });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || 'Bridge stop failed');
              if (fb) fb.textContent = data.stopped ? 'Bridge stopped.' : 'No managed bridge was running.';
              await loadBridgeConnectionCard();
            } catch (err) {
              const errMsg = err && err.message ? err.message : String(err);
              if (fb) fb.textContent = 'Error: ' + errMsg;
              if (/revoked|not_found|403|401/i.test(errMsg)) {
                showRelinkCard('This machine was revoked or removed remotely — paste a fresh pairing code below to re-tie it.');
              }
            }
          };

          async function loadAccountStatus() {
            const pill = document.getElementById('acctTierPill');
            const summary = document.getElementById('acctSummaryLine');
            const hashLine = document.getElementById('acctHashLine');
            const leaseLine = document.getElementById('acctLeaseLine');
            const refreshBtn = document.getElementById('acctRefreshLeaseBtn');
            const relinkBtn = document.getElementById('acctRelinkBtn');
            const unpairBtn = document.getElementById('acctUnpairBtn');
            const pairCard = document.getElementById('acctPairCard');
            const pairHeading = document.getElementById('acctPairHeading');
            const dashLink = document.getElementById('acctWebDashboardLink');
            const upLink = document.getElementById('acctUpgradeLink');

            loadBridgeConnectionCard();
            try {
              const res = await fetch('/api/account/status');
              if (!res.ok) throw new Error('HTTP ' + res.status);
              const s = await res.json();
              currentStatus = s;

              const base = (s.controlPlaneUrl || 'https://local-router.com').replace(/\\/+$/, '');
              if (dashLink) dashLink.href = base + '/dashboard';
              if (upLink) upLink.href = base + '/pricing';

              const hwShort = s.machineIdHash ? s.machineIdHash.slice(0, 14) + '…' : 'n/a';
              const appShort = s.appMachineHash ? s.appMachineHash.slice(0, 19) + '…' : 'n/a';

              if (!s.paired) {
                if (pill) pill.textContent = 'Local OSS (Unpaired)';
                if (summary) summary.textContent = 'Not paired to local-router.com — serving locally on http://localhost:11434 (open-source).';
                if (hashLine) hashLine.textContent = 'This machine: ' + (s.deviceId || 'local') + ' · Machine Hash: ' + hwShort + ' · App Hash: ' + appShort;
                if (leaseLine) leaseLine.textContent = 'Sign in on local-router.com to tie up to 3 machines on the Free tier, or upgrade to Pro (10) / Business (50) for managed HTTPS endpoints.';
                if (refreshBtn) refreshBtn.style.display = 'none';
                if (relinkBtn) relinkBtn.style.display = 'none';
                if (unpairBtn) unpairBtn.style.display = 'none';
                if (pairHeading) pairHeading.textContent = 'Sign In & Pair This Machine';
                if (pairCard) pairCard.style.display = 'block';
                renderUnpairedTable();
                return;
              }

              const tierLabel = String(s.tier || 'free').toUpperCase();
              if (pill) pill.textContent = tierLabel + (s.valid ? ' · Verified PQC' : ' · ' + (s.reason || 'Invalid'));
              if (summary) {
                summary.textContent = (s.email || 'Signed-in account') + ' (' + (s.provider || 'oauth') + ') · Plan: ' + tierLabel + (s.entitlements && s.entitlements.maxDevices ? ' · Limit: ' + s.entitlements.maxDevices + ' machines' : '');
              }
              const bindShort = s.pqcBindingHash ? s.pqcBindingHash.slice(0, 21) + '…' : 'n/a';
              if (hashLine) {
                hashLine.textContent = 'Device: ' + (s.deviceId || 'n/a') + ' · PQC Binding: ' + bindShort + ' · Machine: ' + hwShort + ' · App: ' + appShort;
              }
              if (leaseLine) {
                const exp = s.leaseExpiresAt ? String(s.leaseExpiresAt).slice(0, 19).replace('T', ' ') + 'Z' : 'n/a';
                const ep = s.inferenceEndpoint ? (' · Managed HTTPS: ' + s.inferenceEndpoint) : ' · Managed HTTPS: Pro/Business tier';
                leaseLine.textContent = 'ML-DSA-65 Lease expires: ' + exp + ' · Signer: ' + (s.signingKeyFingerprint || 'n/a') + ep;
              }
              if (refreshBtn) refreshBtn.style.display = 'inline-block';
              if (relinkBtn) relinkBtn.style.display = 'inline-block';
              if (unpairBtn) unpairBtn.style.display = 'inline-block';
              if (pairCard) pairCard.style.display = s.valid ? 'none' : 'block';
              if (!s.valid) showRelinkCard('Local lease is ' + (s.reason || 'invalid') + ' — paste a new pairing code to re-link this machine.');

              await loadTiedMachines();
            } catch (err) {
              if (pill) pill.textContent = 'Unavailable';
              if (summary) summary.textContent = 'Could not load local account status: ' + (err && err.message ? err.message : String(err));
            }
          }

          function renderUnpairedTable() {
            const tbody = document.getElementById('acctMachinesBody');
            const sub = document.getElementById('acctQuotaSubtitle');
            if (sub) sub.textContent = 'Pair this machine above to view, rename, and delete all machines tied to your account within your Free, Pro, or Business tier limits.';
            if (!tbody) return;
            clearEl(tbody);
            const tr = document.createElement('tr');
            const td = document.createElement('td');
            td.colSpan = 5;
            td.className = 'muted';
            td.style.padding = '10px 8px';
            td.textContent = 'Not paired yet. Localhost (http://localhost:11434) works without signing in.';
            tr.appendChild(td);
            tbody.appendChild(tr);
          }

          window.loadTiedMachines = async function loadTiedMachines() {
            const tbody = document.getElementById('acctMachinesBody');
            const sub = document.getElementById('acctQuotaSubtitle');
            const msg = document.getElementById('acctMachinesMsg');
            if (!currentStatus || !currentStatus.paired) {
              renderUnpairedTable();
              return;
            }
            if (msg) msg.textContent = 'Loading tied machines from ' + (currentStatus.controlPlaneUrl || 'local-router.com') + '…';
            try {
              const res = await fetch('/api/account/devices');
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
              const usage = data.usage || { deviceCount: 0, maxDevices: 3 };
              const tier = (data.quotas && data.quotas.tier) || currentStatus.tier || 'free';
              if (sub) sub.textContent = 'Active tied machines: ' + usage.deviceCount + ' / ' + usage.maxDevices + ' (' + String(tier).toUpperCase() + ' tier limit)';
              if (msg) msg.textContent = '';

              const list = Array.isArray(data.devices) ? data.devices : [];
              const selfStillLinked = Boolean(currentStatus && list.some((item) => item.deviceId === currentStatus.deviceId));
              if (currentStatus && currentStatus.paired && !selfStillLinked) {
                showRelinkCard('This machine (' + currentStatus.deviceId + ') was removed from your profile. Paste a new pairing code below to re-link it.');
              }
              clearEl(tbody);
              if (list.length === 0) {
                const tr = document.createElement('tr');
                const td = document.createElement('td');
                td.colSpan = 5;
                td.className = 'muted';
                td.style.padding = '10px 8px';
                td.textContent = 'No active machines found on this account.';
                tr.appendChild(td);
                tbody.appendChild(tr);
                return;
              }

              for (const d of list) {
                const tr = document.createElement('tr');
                tr.style.borderBottom = '1px solid var(--border)';
                const isSelf = currentStatus && d.deviceId === currentStatus.deviceId;

                const tdName = document.createElement('td');
                tdName.style.padding = '8px';
                const strong = document.createElement('strong');
                strong.textContent = d.label || d.deviceId;
                tdName.appendChild(strong);
                if (isSelf) {
                  const badge = document.createElement('span');
                  badge.className = 'pill catalog';
                  badge.textContent = 'This machine';
                  tdName.appendChild(badge);
                }
                const subId = document.createElement('div');
                subId.className = 'muted';
                subId.style.fontSize = '11px';
                subId.textContent = d.deviceId;
                tdName.appendChild(subId);

                const tdPlat = document.createElement('td');
                tdPlat.style.padding = '8px';
                tdPlat.textContent = (d.platform || 'unknown') + ' · ' + (d.clientKind || 'cli');

                const tdHash = document.createElement('td');
                tdHash.style.padding = '8px';
                tdHash.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace';
                tdHash.style.fontSize = '11px';
                const pqcTxt = d.pqcBindingHash ? String(d.pqcBindingHash).slice(0, 19) + '…' : 'legacy';
                const hwTxt = d.machineIdHash ? (' · hw:' + String(d.machineIdHash).slice(0, 10) + '…') : '';
                tdHash.textContent = pqcTxt + hwTxt;

                const tdExp = document.createElement('td');
                tdExp.style.padding = '8px';
                tdExp.textContent = d.leaseExpiresAt ? String(d.leaseExpiresAt).slice(0, 19).replace('T', ' ') + 'Z' : '—';

                const tdAct = document.createElement('td');
                tdAct.style.padding = '8px';
                tdAct.style.whiteSpace = 'nowrap';

                const renameBtn = document.createElement('button');
                renameBtn.type = 'button';
                renameBtn.className = 'button-secondary';
                renameBtn.style.padding = '4px 10px';
                renameBtn.style.marginRight = '6px';
                renameBtn.textContent = 'Rename';
                renameBtn.onclick = function() {
                  clearEl(tdName);
                  const input = document.createElement('input');
                  input.type = 'text';
                  input.maxLength = 80;
                  input.value = d.label || '';
                  input.placeholder = d.deviceId;
                  input.style.maxWidth = '200px';
                  input.style.display = 'inline-block';
                  input.style.marginRight = '6px';

                  const saveBtn = document.createElement('button');
                  saveBtn.type = 'button';
                  saveBtn.style.padding = '4px 10px';
                  saveBtn.style.marginRight = '4px';
                  saveBtn.textContent = 'Save';
                  saveBtn.onclick = async function() {
                    const r = await fetch('/api/account/devices/' + encodeURIComponent(d.deviceId), {
                      method: 'PATCH',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ label: input.value.trim() || null })
                    });
                    const body = await r.json().catch(() => ({}));
                    if (msg) msg.textContent = r.ok ? ('Renamed ' + d.deviceId + '.') : ('Error: ' + (body.error || r.status));
                    await loadTiedMachines();
                  };

                  const cancelBtn = document.createElement('button');
                  cancelBtn.type = 'button';
                  cancelBtn.className = 'button-secondary';
                  cancelBtn.style.padding = '4px 10px';
                  cancelBtn.textContent = 'Cancel';
                  cancelBtn.onclick = loadTiedMachines;

                  tdName.appendChild(input);
                  tdName.appendChild(saveBtn);
                  tdName.appendChild(cancelBtn);
                  input.focus();
                };

                const delBtn = document.createElement('button');
                delBtn.type = 'button';
                delBtn.className = 'button-secondary';
                delBtn.style.padding = '4px 10px';
                delBtn.textContent = 'Delete';
                delBtn.onclick = async function() {
                  if (msg) msg.textContent = 'Deleting ' + d.deviceId + '…';
                  const r = await fetch('/api/account/devices/' + encodeURIComponent(d.deviceId), { method: 'DELETE' });
                  const body = await r.json().catch(() => ({}));
                  if (msg) msg.textContent = r.ok ? ('Deleted ' + d.deviceId + ' and freed quota slot.') : ('Error: ' + (body.error || r.status));
                  await loadAccountStatus();
                };

                tdAct.appendChild(renameBtn);
                tdAct.appendChild(delBtn);

                tr.appendChild(tdName);
                tr.appendChild(tdPlat);
                tr.appendChild(tdHash);
                tr.appendChild(tdExp);
                tr.appendChild(tdAct);
                tbody.appendChild(tr);
              }
            } catch (err) {
              if (msg) msg.textContent = 'Error loading tied machines: ' + (err && err.message ? err.message : String(err));
            }
          };

          window.pairThisMachine = async function pairThisMachine() {
            const codeInput = document.getElementById('acctPairCodeInput');
            const labelInput = document.getElementById('acctMachineLabelInput');
            const fb = document.getElementById('acctPairFeedback');
            const code = codeInput ? codeInput.value.trim() : '';
            const label = labelInput ? labelInput.value.trim() : '';
            if (!code) { if (fb) fb.textContent = 'Paste a single-use lrp_... pairing code first.'; return; }
            if (fb) fb.textContent = 'Exchanging PQC identity & verifying ML-DSA-65 lease…';
            try {
              const res = await fetch('/api/account/pair', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ pairingCode: code, ...(label ? { label } : {}) })
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
              if (codeInput) codeInput.value = '';
              if (labelInput) labelInput.value = '';
              if (fb) fb.textContent = 'Paired successfully (' + (data.tier || 'free').toUpperCase() + ' tier).';
              await loadAccountStatus();
            } catch (err) {
              const errMsg = err && err.message ? err.message : String(err);
              if (fb) fb.textContent = 'Error: ' + errMsg;
              if (/revoked|not_found|403|401/i.test(errMsg)) {
                showRelinkCard('This machine was revoked or removed remotely — paste a fresh pairing code below to re-tie it.');
              }
            }
          };

          window.refreshAccountLease = async function refreshAccountLease() {
            const fb = document.getElementById('acctActionMsg');
            if (fb) fb.textContent = 'Renewing ML-DSA-65 lease & checking plan tier…';
            try {
              const res = await fetch('/api/account/refresh', { method: 'POST' });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
              if (fb) fb.textContent = 'Refreshed: tier=' + (data.tier || 'free') + ', expires ' + (data.leaseExpiresAt || 'n/a');
              await loadAccountStatus();
            } catch (err) {
              const errMsg = err && err.message ? err.message : String(err);
              if (fb) fb.textContent = 'Error: ' + errMsg;
              if (/revoked|not_found|403|401/i.test(errMsg)) {
                showRelinkCard('This machine was revoked or removed remotely — paste a fresh pairing code below to re-tie it.');
              }
            }
          };

          window.unpairThisMachine = async function unpairThisMachine() {
            const fb = document.getElementById('acctActionMsg');
            if (fb) fb.textContent = 'Removing local account lease…';
            try {
              const res = await fetch('/api/account/pair', { method: 'DELETE' });
              if (!res.ok) throw new Error('HTTP ' + res.status);
              if (fb) fb.textContent = 'Unpaired locally. Localhost (http://localhost:11434) continues serving.';
              await loadAccountStatus();
            } catch (err) {
              const errMsg = err && err.message ? err.message : String(err);
              if (fb) fb.textContent = 'Error: ' + errMsg;
              if (/revoked|not_found|403|401/i.test(errMsg)) {
                showRelinkCard('This machine was revoked or removed remotely — paste a fresh pairing code below to re-tie it.');
              }
            }
          };

          if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', loadAccountStatus);
          } else {
            loadAccountStatus();
          }
        })();
      </script>
  `;

  return renderLayout('Account &amp; Machines', body, params);
}
