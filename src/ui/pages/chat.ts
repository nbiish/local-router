import { renderLayout } from './layout';
import { detectInstalledAgents } from '../../agent-executor';

export function renderChatPage(params: {
  defaultFallbackModelsText: string;
}): string {
  const agents = detectInstalledAgents();

  const body = `
  <div class="chat-wrapper">
    <div class="chat-header-bar card">
      <div class="header-left">
        <h2>Agent Chat &amp; CLI Fleet Dispatch</h2>
        <p class="section-desc">Interactive browser chat and headless CLI agent execution powered exclusively by <code class="highlight-model">local-router/fallback-models</code>.</p>
      </div>
      <div class="header-right">
        <div class="badge-row">
          <span class="badge model-badge">Target Model: local-router/fallback-models</span>
          <span class="badge port-badge">Port: 127.0.0.1:11434</span>
        </div>
      </div>
    </div>

    <div class="chat-toolbar card">
      <div class="toolbar-group">
        <label for="agent-select" class="toolbar-label">Agent Mode:</label>
        <select id="agent-select" class="form-select">
          <option value="auto" selected>⚡ Auto (free-claude-code → omp → trae-cli)</option>
          <option value="free-claude-code">Anthropic Claude Code (fcc-claude / claude)</option>
          <option value="omp">OhMyPy (omp)</option>
          <option value="trae-cli">Trae SWE Agent (trae-cli)</option>
          <option value="mini">Live-SWE Agent (mini)</option>
        </select>
      </div>

      <div class="toolbar-group">
        <label class="toggle-control">
          <input type="checkbox" id="fleet-toggle" checked />
          <span class="toggle-slider"></span>
          <span class="toggle-text">Trae / Mini Agent Fleet</span>
        </label>
      </div>

      <div class="toolbar-group mode-selector">
        <span class="toolbar-label">Execution:</span>
        <button type="button" id="mode-chat" class="btn btn-sm btn-mode active" data-mode="chat">Direct LLM Chat</button>
        <button type="button" id="mode-action" class="btn btn-sm btn-mode" data-mode="action">Headless Agent Action</button>
      </div>
    </div>

    <div class="chat-container card">
      <div id="chat-messages" class="chat-messages">
        <div class="message system-message">
          <div class="msg-header"><span class="msg-author">System</span></div>
          <div class="msg-content">
            Ready. Model <strong>local-router/fallback-models</strong> is active across all channels.
            <br />
            Select <em>Direct LLM Chat</em> for streaming conversational dialogue or <em>Headless Agent Action</em> to dispatch tasks through the fallback cascade (<code style="color:#00ffc8;">free-claude-code → omp → trae-cli</code>).
          </div>
        </div>
      </div>

      <div class="chat-input-container">
        <div id="status-indicator" class="status-indicator" style="display: none;">
          <span class="spinner"></span>
          <span id="status-text">Thinking…</span>
        </div>
        <div class="input-row">
          <textarea id="prompt-input" class="prompt-input" rows="3" placeholder="Type a message or describe a coding task to dispatch... (Press Enter to send, Shift+Enter for newline)"></textarea>
          <div class="input-actions">
            <button type="button" id="send-btn" class="btn btn-primary send-btn">Send</button>
            <button type="button" id="stop-btn" class="btn btn-secondary stop-btn" style="display:none;">Stop</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <style>
    .chat-wrapper {
      display: flex;
      flex-direction: column;
      gap: 16px;
      height: calc(100vh - 120px);
      max-width: 1200px;
      margin: 0 auto;
    }
    .chat-header-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 20px;
      flex-wrap: wrap;
      gap: 12px;
    }
    .chat-header-bar h2 {
      margin: 0 0 4px 0;
      font-size: 1.25rem;
      color: var(--text);
    }
    .highlight-model {
      color: #00ffc8;
      background: rgba(0, 255, 200, 0.1);
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 600;
    }
    .badge-row {
      display: flex;
      gap: 8px;
    }
    .badge {
      font-size: 0.75rem;
      padding: 4px 10px;
      border-radius: 12px;
      font-weight: 500;
      letter-spacing: 0.3px;
    }
    .model-badge {
      background: rgba(0, 255, 200, 0.15);
      color: #00ffc8;
      border: 1px solid rgba(0, 255, 200, 0.3);
    }
    .port-badge {
      background: rgba(74, 163, 255, 0.15);
      color: #4aa3ff;
      border: 1px solid rgba(74, 163, 255, 0.3);
    }
    .chat-toolbar {
      display: flex;
      align-items: center;
      gap: 20px;
      padding: 12px 20px;
      flex-wrap: wrap;
    }
    .toolbar-group {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .toolbar-label {
      font-size: 0.85rem;
      color: var(--muted);
      font-weight: 500;
    }
    .form-select {
      background: var(--surface);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 12px;
      font-size: 0.85rem;
      outline: none;
      cursor: pointer;
    }
    .toggle-control {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      user-select: none;
    }
    .toggle-control input {
      display: none;
    }
    .toggle-slider {
      position: relative;
      width: 36px;
      height: 20px;
      background-color: var(--border);
      border-radius: 20px;
      transition: .3s;
    }
    .toggle-slider:before {
      position: absolute;
      content: "";
      height: 14px;
      width: 14px;
      left: 3px;
      bottom: 3px;
      background-color: #fff;
      border-radius: 50%;
      transition: .3s;
    }
    .toggle-control input:checked + .toggle-slider {
      background-color: #00ffc8;
    }
    .toggle-control input:checked + .toggle-slider:before {
      transform: translateX(16px);
      background-color: #0b0e14;
    }
    .toggle-text {
      font-size: 0.85rem;
      color: var(--text);
    }
    .mode-selector {
      margin-left: auto;
    }
    .btn-mode {
      background: var(--surface);
      color: var(--muted);
      border: 1px solid var(--border);
      padding: 5px 12px;
      border-radius: 6px;
      font-size: 0.8rem;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-mode.active {
      background: rgba(0, 255, 200, 0.15);
      color: #00ffc8;
      border-color: #00ffc8;
      font-weight: 600;
    }
    .chat-container {
      display: flex;
      flex-direction: column;
      flex: 1;
      padding: 0;
      overflow: hidden;
      min-height: 400px;
    }
    .chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .message {
      padding: 14px 18px;
      border-radius: 8px;
      max-width: 90%;
      line-height: 1.5;
      font-size: 0.95rem;
      word-break: break-word;
    }
    .system-message {
      align-self: center;
      background: rgba(29, 38, 55, 0.5);
      border: 1px dashed var(--border);
      color: var(--muted);
      font-size: 0.85rem;
      max-width: 95%;
      width: 100%;
    }
    .user-message {
      align-self: flex-end;
      background: #16345c;
      color: #ffffff;
      border-bottom-right-radius: 2px;
    }
    .assistant-message {
      align-self: flex-start;
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--text);
      border-bottom-left-radius: 2px;
    }
    .action-message {
      align-self: flex-start;
      background: #0d1320;
      border: 1px solid #233152;
      color: #d7dde8;
      width: 95%;
      font-family: ui-monospace, monospace;
    }
    .msg-header {
      display: flex;
      justify-content: space-between;
      margin-bottom: 6px;
      font-size: 0.75rem;
      color: var(--muted);
    }
    .msg-author {
      font-weight: 600;
      letter-spacing: 0.5px;
    }
    .trace-pills {
      display: flex;
      gap: 6px;
      margin-top: 8px;
      flex-wrap: wrap;
    }
    .trace-pill {
      font-size: 0.7rem;
      padding: 2px 8px;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #9fd08a;
    }
    .chat-input-container {
      border-top: 1px solid var(--border);
      padding: 16px 20px;
      background: var(--surface);
    }
    .status-indicator {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.85rem;
      color: #00ffc8;
      margin-bottom: 8px;
    }
    .spinner {
      width: 12px;
      height: 12px;
      border: 2px solid rgba(0, 255, 200, 0.3);
      border-top-color: #00ffc8;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .input-row {
      display: flex;
      gap: 12px;
      align-items: flex-end;
    }
    .prompt-input {
      flex: 1;
      background: var(--bg);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 14px;
      font-family: inherit;
      font-size: 0.95rem;
      resize: none;
      outline: none;
      line-height: 1.4;
      transition: border-color 0.2s;
    }
    .prompt-input:focus {
      border-color: #00ffc8;
    }
    .input-actions {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .send-btn {
      padding: 10px 22px;
      font-weight: 600;
      background: #00ffc8;
      color: #0b0e14;
      border: none;
      border-radius: 6px;
      cursor: pointer;
    }
    .send-btn:hover {
      background: #00e0b0;
    }
    .stop-btn {
      padding: 10px 22px;
      font-weight: 600;
      background: #ff5555;
      color: #fff;
      border: none;
      border-radius: 6px;
      cursor: pointer;
    }
    pre.code-block {
      background: #05070c;
      padding: 12px;
      border-radius: 6px;
      overflow-x: auto;
      border: 1px solid #1d2637;
      margin: 8px 0;
      font-size: 0.85rem;
    }
  </style>

  <script>
    (function() {
      var currentMode = 'chat';
      var history = [];
      var activeAbortController = null;

      var messagesEl = document.getElementById('chat-messages');
      var promptInput = document.getElementById('prompt-input');
      var sendBtn = document.getElementById('send-btn');
      var stopBtn = document.getElementById('stop-btn');
      var statusIndicator = document.getElementById('status-indicator');
      var statusText = document.getElementById('status-text');
      var agentSelect = document.getElementById('agent-select');
      var fleetToggle = document.getElementById('fleet-toggle');

      document.querySelectorAll('.btn-mode').forEach(function(btn) {
        btn.addEventListener('click', function() {
          document.querySelectorAll('.btn-mode').forEach(function(b) { b.classList.remove('active'); });
          btn.classList.add('active');
          currentMode = btn.dataset.mode;
        });
      });

      function scrollToBottom() {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      function addMessage(author, content, type, trace) {
        var msgDiv = document.createElement('div');
        msgDiv.className = 'message ' + type + '-message';
        
        var header = document.createElement('div');
        header.className = 'msg-header';
        header.innerHTML = '<span class="msg-author">' + escapeHtml(author) + '</span><span>' + new Date().toLocaleTimeString() + '</span>';
        msgDiv.appendChild(header);

        var contentDiv = document.createElement('div');
        contentDiv.className = 'msg-content';
        if (type === 'action') {
          contentDiv.innerHTML = '<pre class="code-block">' + escapeHtml(content) + '</pre>';
        } else {
          contentDiv.textContent = content;
        }
        msgDiv.appendChild(contentDiv);

        if (trace && trace.length) {
          var pills = document.createElement('div');
          pills.className = 'trace-pills';
          trace.forEach(function(t) {
            var p = document.createElement('span');
            p.className = 'trace-pill';
            p.textContent = t;
            pills.appendChild(p);
          });
          msgDiv.appendChild(pills);
        }

        messagesEl.appendChild(msgDiv);
        scrollToBottom();
        return contentDiv;
      }

      function escapeHtml(str) {
        var div = document.createElement('div');
        div.textContent = str || '';
        return div.innerHTML;
      }

      promptInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          handleSend();
        }
      });

      sendBtn.addEventListener('click', handleSend);

      stopBtn.addEventListener('click', function() {
        if (activeAbortController) {
          activeAbortController.abort();
          activeAbortController = null;
          hideStatus();
        }
      });

      function showStatus(text) {
        statusText.textContent = text;
        statusIndicator.style.display = 'flex';
        sendBtn.style.display = 'none';
        stopBtn.style.display = 'block';
      }

      function hideStatus() {
        statusIndicator.style.display = 'none';
        sendBtn.style.display = 'block';
        stopBtn.style.display = 'none';
      }

      async function handleSend() {
        var text = promptInput.value.trim();
        if (!text) return;

        promptInput.value = '';
        addMessage('User', text, 'user');
        history.push({ role: 'user', content: text });

        if (currentMode === 'chat') {
          await runStreamingChat(text);
        } else {
          await runAgentAction(text);
        }
      }

      async function runStreamingChat(text) {
        showStatus('Streaming from local-router/fallback-models…');
        activeAbortController = new AbortController();

        var assistantMsg = addMessage('Assistant (local-router/fallback-models)', '', 'assistant');
        var accumulated = '';

        try {
          var response = await fetch('/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'local-router/fallback-models',
              messages: history,
              stream: true
            }),
            signal: activeAbortController.signal
          });

          if (!response.ok) {
            var err = await response.text();
            assistantMsg.textContent = 'Error: ' + err;
            hideStatus();
            return;
          }

          var reader = response.body.getReader();
          var decoder = new TextDecoder('utf-8');
          var buffer = '';

          while (true) {
            var result = await reader.read();
            if (result.done) break;
            buffer += decoder.decode(result.value, { stream: true });
            var lines = buffer.split('\\n');
            buffer = lines.pop();

            for (var i = 0; i < lines.length; i++) {
              var line = lines[i].trim();
              if (!line || line === 'data: [DONE]') continue;
              if (line.startsWith('data: ')) {
                try {
                  var json = JSON.parse(line.substring(6));
                  var delta = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
                  if (delta) {
                    accumulated += delta;
                    assistantMsg.textContent = accumulated;
                    scrollToBottom();
                  }
                } catch(e) {}
              }
            }
          }
          history.push({ role: 'assistant', content: accumulated });
        } catch (err) {
          if (err.name !== 'AbortError') {
            assistantMsg.textContent = 'Failed to fetch: ' + err.message;
          }
        } finally {
          hideStatus();
          activeAbortController = null;
        }
      }

      async function runAgentAction(text) {
        var agent = agentSelect.value;
        var fleet = fleetToggle.checked;
        showStatus('Executing agent (' + agent + ', fleet: ' + (fleet ? 'ON' : 'OFF') + ')…');

        try {
          var res = await fetch('/api/chat/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt: text,
              agent: agent,
              fleet: fleet
            })
          });
          var data = await res.json();
          addMessage('Agent Execution [' + (data.agentUsed || agent) + ']', data.output || '(no output)', 'action', data.trace);
        } catch (err) {
          addMessage('Agent Execution Error', String(err), 'action', ['error: ' + err.message]);
        } finally {
          hideStatus();
        }
      }
    })();
  </script>
  `;

  return renderLayout('Agent Chat', body, params);
}
