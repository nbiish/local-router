import { renderLayout } from './layout';

export function renderEfficiencyPage(params: {
  defaultFallbackModelsText: string;
}): string {
  const body = `
      <div class="card" style="border-left: 4px solid var(--primary);">
        <div class="catalog-meta">
          <div>
            <h2 style="margin:0 0 6px;">Token Efficiency &amp; Optimization Hub</h2>
            <p class="muted" style="margin:0; line-height:1.5;">
              Local Router is built with a singular, lean mission: <strong>unify all LLM providers under one source</strong> and provide a <strong>resilient, tool-agnostic fallback-models pipeline</strong>.
            </p>
          </div>
          <div>
            <span class="pill catalog" style="font-size:12px; font-weight:600;">Decoupled &amp; Modular</span>
          </div>
        </div>
        <div class="routing-info-box" style="margin-top:14px; background:var(--surface-soft);">
          <p style="margin:0 0 8px; font-weight:600; color:var(--text);">
            Why is token efficiency decoupled from Local Router core?
          </p>
          <ul style="margin:0; padding-left:20px; color:var(--muted); line-height:1.6;">
            <li><strong>Zero Proxy Overhead:</strong> Your proxy stays blazing fast, deterministic, and free of brittle in-memory compression states or timeout cascades.</li>
            <li><strong>Complete Flexibility:</strong> Choose the exact token efficiency layer you need &mdash; prompt-level reasoning, shell output filtering, or standalone compression proxy &mdash; without altering router code.</li>
            <li><strong>Independent Upgrades:</strong> Update each tool on its own release schedule using its native package manager (uv, npm, brew, cargo).</li>
          </ul>
        </div>
      </div>

      <!-- Efficiency Layer Matrix -->
      <div class="card">
        <h3 style="margin-top:0; margin-bottom:12px;">Token Defense in Depth: 3 Layers</h3>
        <p class="muted" style="margin-bottom:14px;">Combine all three layers for maximum savings across your entire AI workflow:</p>
        <div style="overflow-x:auto;">
          <table style="width:100%; border-collapse:collapse; font-size:13px; text-align:left;">
            <thead>
              <tr style="background:var(--surface-soft); border-bottom:2px solid var(--border);">
                <th style="padding:10px 12px;">Tool</th>
                <th style="padding:10px 12px;">Layer</th>
                <th style="padding:10px 12px;">What It Targets</th>
                <th style="padding:10px 12px;">Measured Savings</th>
                <th style="padding:10px 12px;">Overhead</th>
              </tr>
            </thead>
            <tbody>
              <tr style="border-bottom:1px solid var(--border);">
                <td style="padding:10px 12px; font-weight:600;"><a href="#ponytail">Ponytail</a></td>
                <td style="padding:10px 12px;"><span class="pill catalog">Prompt &amp; Code</span></td>
                <td style="padding:10px 12px;">Eliminates code bloat &amp; over-engineering before generation</td>
                <td style="padding:10px 12px; color:var(--success-text); font-weight:600;">~54% less code, -20% cost</td>
                <td style="padding:10px 12px;">0 ms (prompt guidance)</td>
              </tr>
              <tr style="border-bottom:1px solid var(--border);">
                <td style="padding:10px 12px; font-weight:600;"><a href="#headroom">Headroom</a></td>
                <td style="padding:10px 12px;"><span class="pill catalog">Context &amp; Output</span></td>
                <td style="padding:10px 12px;">Compresses tool outputs, logs, RAG &amp; shapes model verbosity</td>
                <td style="padding:10px 12px; color:var(--success-text); font-weight:600;">20% &ndash; 90% prompt, -30% output</td>
                <td style="padding:10px 12px;">&lt; 1 ms</td>
              </tr>
              <tr>
                <td style="padding:10px 12px; font-weight:600;"><a href="#rtk">RTK (Rust Token Killer)</a></td>
                <td style="padding:10px 12px;"><span class="pill catalog">Shell &amp; CLI</span></td>
                <td style="padding:10px 12px;">Filters git diff/status, test runners, linter output</td>
                <td style="padding:10px 12px; color:var(--success-text); font-weight:600;">Up to 90% bash output cut</td>
                <td style="padding:10px 12px;">&lt; 10 ms (native Rust)</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Layer 1: Ponytail -->
      <div class="card" id="ponytail">
        <div class="catalog-meta">
          <div>
            <div style="display:flex; align-items:center; gap:10px;">
              <h2 style="margin:0;">1. Ponytail</h2>
              <span class="pill catalog">Reasoning &amp; Code Minimization</span>
            </div>
            <p class="muted" style="margin:4px 0 0; font-style:italic;">&ldquo;He says nothing. He writes one line. It works.&rdquo;</p>
          </div>
          <div>
            <a href="https://github.com/dietrichgebert/ponytail" target="_blank" rel="noopener noreferrer" style="font-size:13px; font-weight:600; text-decoration:none; display:inline-flex; align-items:center; gap:4px;">
              GitHub Repository &rarr;
            </a>
          </div>
        </div>

        <p style="margin-top:12px; line-height:1.5;">
          Ponytail makes your AI agent think like the laziest senior dev in the room. Before writing code, it forces the agent down a 7-rung ladder:
        </p>

        <div class="routing-info-box" style="margin:10px 0; background:var(--surface-soft); font-family:ui-monospace, monospace; font-size:12px;">
          1. Does this need to exist? &rarr; No: Skip it (YAGNI)<br>
          2. Already in this codebase? &rarr; Reuse it, don't rewrite<br>
          3. Stdlib does it? &rarr; Use stdlib<br>
          4. Native platform feature? &rarr; Use native (e.g. &lt;input type="date"&gt;)<br>
          5. Installed dependency? &rarr; Use it<br>
          6. One line? &rarr; Write one line<br>
          7. Only then: The minimum working implementation
        </div>

        <h4 style="margin:16px 0 8px;">Installation by Agent:</h4>

        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:12px;">
          <div style="background:var(--surface-soft); padding:12px; border:1px solid var(--border); border-radius:6px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
              <strong>Claude Code</strong>
              <button class="button-secondary" style="padding:2px 8px; font-size:11px;" onclick="copyCodeSnippet('/plugin marketplace add DietrichGebert/ponytail\\n/plugin install ponytail@ponytail')">Copy</button>
            </div>
            <pre style="margin:0; padding:8px; background:var(--surface-raised); border-radius:4px; font-size:12px; overflow-x:auto;"><code>/plugin marketplace add DietrichGebert/ponytail
/plugin install ponytail@ponytail</code></pre>
            <p class="muted" style="font-size:11px; margin:4px 0 0;">Run as two separate prompts in Claude Code CLI.</p>
          </div>

          <div style="background:var(--surface-soft); padding:12px; border:1px solid var(--border); border-radius:6px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
              <strong>Codex (OpenAI)</strong>
              <button class="button-secondary" style="padding:2px 8px; font-size:11px;" onclick="copyCodeSnippet('codex plugin marketplace add DietrichGebert/ponytail\\ncodex plugin add ponytail@ponytail')">Copy</button>
            </div>
            <pre style="margin:0; padding:8px; background:var(--surface-raised); border-radius:4px; font-size:12px; overflow-x:auto;"><code>codex plugin marketplace add DietrichGebert/ponytail
codex plugin add ponytail@ponytail</code></pre>
            <p class="muted" style="font-size:11px; margin:4px 0 0;">Trust the two lifecycle hooks when prompted.</p>
          </div>

          <div style="background:var(--surface-soft); padding:12px; border:1px solid var(--border); border-radius:6px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
              <strong>Antigravity / Gemini CLI</strong>
              <button class="button-secondary" style="padding:2px 8px; font-size:11px;" onclick="copyCodeSnippet('agy plugin install https://github.com/DietrichGebert/ponytail')">Copy</button>
            </div>
            <pre style="margin:0; padding:8px; background:var(--surface-raised); border-radius:4px; font-size:12px; overflow-x:auto;"><code>agy plugin install https://github.com/DietrichGebert/ponytail
# or: gemini extensions install https://github.com/DietrichGebert/ponytail</code></pre>
            <p class="muted" style="font-size:11px; margin:4px 0 0;">Installs skills and ruleset into your config.</p>
          </div>

          <div style="background:var(--surface-soft); padding:12px; border:1px solid var(--border); border-radius:6px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
              <strong>GitHub Copilot CLI</strong>
              <button class="button-secondary" style="padding:2px 8px; font-size:11px;" onclick="copyCodeSnippet('copilot plugin marketplace add DietrichGebert/ponytail\\ncopilot plugin install ponytail@ponytail')">Copy</button>
            </div>
            <pre style="margin:0; padding:8px; background:var(--surface-raised); border-radius:4px; font-size:12px; overflow-x:auto;"><code>copilot plugin marketplace add DietrichGebert/ponytail
copilot plugin install ponytail@ponytail</code></pre>
            <p class="muted" style="font-size:11px; margin:4px 0 0;">In session: /plugin marketplace add DietrichGebert/ponytail</p>
          </div>
        </div>

        <div style="margin-top:14px; background:var(--surface-soft); padding:12px; border:1px solid var(--border); border-radius:6px;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <strong>Zero-Install Fallback: AGENTS.md</strong>
            <button class="button-secondary" style="padding:2px 8px; font-size:11px;" onclick="copyCodeSnippet('curl -fsSL https://raw.githubusercontent.com/DietrichGebert/ponytail/main/AGENTS.md >> AGENTS.md')">Copy</button>
          </div>
          <p class="muted" style="font-size:12px; margin:4px 0;">Works with any agent reading AGENTS.md (OpenCode, Cursor, Qoder, CodeWhale, Swival):</p>
          <pre style="margin:0; padding:8px; background:var(--surface-raised); border-radius:4px; font-size:12px; overflow-x:auto;"><code>curl -fsSL https://raw.githubusercontent.com/DietrichGebert/ponytail/main/AGENTS.md >> AGENTS.md</code></pre>
        </div>

        <h4 style="margin:16px 0 8px;">Commands &amp; Skills:</h4>
        <div style="display:flex; flex-wrap:wrap; gap:8px; font-size:13px;">
          <span style="background:var(--surface-soft); border:1px solid var(--border); padding:4px 10px; border-radius:4px;"><code>/ponytail [lite|full|ultra|off]</code> &mdash; Set intensity</span>
          <span style="background:var(--surface-soft); border:1px solid var(--border); padding:4px 10px; border-radius:4px;"><code>/ponytail-review</code> &mdash; Review diff for over-engineering</span>
          <span style="background:var(--surface-soft); border:1px solid var(--border); padding:4px 10px; border-radius:4px;"><code>/ponytail-audit</code> &mdash; Scan entire repo for bloat to delete</span>
          <span style="background:var(--surface-soft); border:1px solid var(--border); padding:4px 10px; border-radius:4px;"><code>/ponytail-gain</code> &mdash; Scoreboard of saved tokens &amp; LOC</span>
        </div>
      </div>

      <!-- Layer 2: Headroom -->
      <div class="card" id="headroom">
        <div class="catalog-meta">
          <div>
            <div style="display:flex; align-items:center; gap:10px;">
              <h2 style="margin:0;">2. Headroom</h2>
              <span class="pill catalog">Context Compression &amp; Output Shaping</span>
            </div>
            <p class="muted" style="margin:4px 0 0;">Compresses tool outputs, logs, RAG chunks, and history before reaching the model.</p>
          </div>
          <div>
            <a href="https://github.com/headroomlabs-ai/headroom" target="_blank" rel="noopener noreferrer" style="font-size:13px; font-weight:600; text-decoration:none; display:inline-flex; align-items:center; gap:4px;">
              GitHub Repository &rarr;
            </a>
          </div>
        </div>

        <p style="margin-top:12px; line-height:1.5;">
          Headroom operates locally on your machine. It utilizes content-aware compression (SmartCrusher for JSON, CodeCompressor for AST, Kompress-v2-base for text), CacheAligner to protect downstream provider prompt caches, and CCR (Content-Centric Retrieval) to recall original full text if needed.
        </p>

        <h4 style="margin:16px 0 8px;">Installation:</h4>
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:12px;">
          <div style="background:var(--surface-soft); padding:12px; border:1px solid var(--border); border-radius:6px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
              <strong>UV (Recommended &mdash; Isolated Python)</strong>
              <button class="button-secondary" style="padding:2px 8px; font-size:11px;" onclick="copyCodeSnippet('uv tool install --python 3.13 \\\"headroom-ai[all]\\\"')">Copy</button>
            </div>
            <pre style="margin:0; padding:8px; background:var(--surface-raised); border-radius:4px; font-size:12px; overflow-x:auto;"><code>uv tool install --python 3.13 "headroom-ai[all]"</code></pre>
          </div>

          <div style="background:var(--surface-soft); padding:12px; border:1px solid var(--border); border-radius:6px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
              <strong>Pip (Python CLI)</strong>
              <button class="button-secondary" style="padding:2px 8px; font-size:11px;" onclick="copyCodeSnippet('pip install \\\"headroom-ai[all]\\\"')">Copy</button>
            </div>
            <pre style="margin:0; padding:8px; background:var(--surface-raised); border-radius:4px; font-size:12px; overflow-x:auto;"><code>pip install "headroom-ai[all]"</code></pre>
          </div>
        </div>

        <h4 style="margin:16px 0 8px;">How to Run Headroom:</h4>
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:12px;">
          <div style="background:var(--surface-soft); padding:12px; border:1px solid var(--border); border-radius:6px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
              <strong>Option A: Transparent Proxy</strong>
              <button class="button-secondary" style="padding:2px 8px; font-size:11px;" onclick="copyCodeSnippet('headroom proxy --port 8787')">Copy</button>
            </div>
            <pre style="margin:0; padding:8px; background:var(--surface-raised); border-radius:4px; font-size:12px; overflow-x:auto;"><code>headroom proxy --port 8787</code></pre>
            <p class="muted" style="font-size:11px; margin:4px 0 0;">Runs a local proxy for any tool or SDK.</p>
          </div>

          <div style="background:var(--surface-soft); padding:12px; border:1px solid var(--border); border-radius:6px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
              <strong>Option B: Agent Wrap Mode</strong>
              <button class="button-secondary" style="padding:2px 8px; font-size:11px;" onclick="copyCodeSnippet('headroom wrap claude')">Copy</button>
            </div>
            <pre style="margin:0; padding:8px; background:var(--surface-raised); border-radius:4px; font-size:12px; overflow-x:auto;"><code>headroom wrap claude
# Also supports: codex, cursor, aider, copilot</code></pre>
            <p class="muted" style="font-size:11px; margin:4px 0 0;">Starts proxy and launches the configured agent.</p>
          </div>

          <div style="background:var(--surface-soft); padding:12px; border:1px solid var(--border); border-radius:6px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
              <strong>Option C: Output Token Shaper</strong>
              <button class="button-secondary" style="padding:2px 8px; font-size:11px;" onclick="copyCodeSnippet('export HEADROOM_OUTPUT_SHAPER=1\\nheadroom proxy --port 8787')">Copy</button>
            </div>
            <pre style="margin:0; padding:8px; background:var(--surface-raised); border-radius:4px; font-size:12px; overflow-x:auto;"><code>export HEADROOM_OUTPUT_SHAPER=1
headroom proxy --port 8787</code></pre>
            <p class="muted" style="font-size:11px; margin:4px 0 0;">Trims ~30% of output tokens via verbosity steering.</p>
          </div>
        </div>

        <h4 style="margin:16px 0 8px;">Health &amp; Savings Dashboard:</h4>
        <div style="display:flex; flex-wrap:wrap; gap:8px; font-size:13px;">
          <span style="background:var(--surface-soft); border:1px solid var(--border); padding:4px 10px; border-radius:4px;"><code>headroom doctor</code> &mdash; Verify proxy health</span>
          <span style="background:var(--surface-soft); border:1px solid var(--border); padding:4px 10px; border-radius:4px;"><code>headroom dashboard</code> &mdash; Live web metrics</span>
          <span style="background:var(--surface-soft); border:1px solid var(--border); padding:4px 10px; border-radius:4px;"><code>headroom output-savings</code> &mdash; Measure output reduction</span>
        </div>
      </div>

      <!-- Layer 3: RTK -->
      <div class="card" id="rtk">
        <div class="catalog-meta">
          <div>
            <div style="display:flex; align-items:center; gap:10px;">
              <h2 style="margin:0;">3. RTK (Rust Token Killer)</h2>
              <span class="pill catalog">Shell &amp; CLI Output Compression</span>
            </div>
            <p class="muted" style="margin:4px 0 0;">Cuts up to 90% of bash command output read by agents before it lands in LLM context.</p>
          </div>
          <div>
            <a href="https://github.com/rtk-ai/rtk" target="_blank" rel="noopener noreferrer" style="font-size:13px; font-weight:600; text-decoration:none; display:inline-flex; align-items:center; gap:4px;">
              GitHub Repository &rarr;
            </a>
          </div>
        </div>

        <p style="margin-top:12px; line-height:1.5;">
          Terminal and build outputs (like <code>git status</code>, test runner failures, linter reports, and <code>grep</code> dumps) are filled with whitespace and repeated boilerplate. RTK intercepts tool execution with &lt;10ms overhead, removing noise, grouping similar rows, and collapsing duplicates while preserving critical failure messages.
        </p>

        <h4 style="margin:16px 0 8px;">Installation:</h4>
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:12px;">
          <div style="background:var(--surface-soft); padding:12px; border:1px solid var(--border); border-radius:6px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
              <strong>Homebrew (macOS / Linux)</strong>
              <button class="button-secondary" style="padding:2px 8px; font-size:11px;" onclick="copyCodeSnippet('brew install rtk')">Copy</button>
            </div>
            <pre style="margin:0; padding:8px; background:var(--surface-raised); border-radius:4px; font-size:12px; overflow-x:auto;"><code>brew install rtk</code></pre>
          </div>

          <div style="background:var(--surface-soft); padding:12px; border:1px solid var(--border); border-radius:6px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
              <strong>Quick Install (Linux / macOS)</strong>
              <button class="button-secondary" style="padding:2px 8px; font-size:11px;" onclick="copyCodeSnippet('curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh')">Copy</button>
            </div>
            <pre style="margin:0; padding:8px; background:var(--surface-raised); border-radius:4px; font-size:12px; overflow-x:auto;"><code>curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh</code></pre>
          </div>

          <div style="background:var(--surface-soft); padding:12px; border:1px solid var(--border); border-radius:6px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
              <strong>Cargo (From Source)</strong>
              <button class="button-secondary" style="padding:2px 8px; font-size:11px;" onclick="copyCodeSnippet('cargo install --git https://github.com/rtk-ai/rtk')">Copy</button>
            </div>
            <pre style="margin:0; padding:8px; background:var(--surface-raised); border-radius:4px; font-size:12px; overflow-x:auto;"><code>cargo install --git https://github.com/rtk-ai/rtk</code></pre>
            <p class="muted" style="font-size:11px; margin:4px 0 0;">Note: Avoid crate name collisions by using --git repo.</p>
          </div>

          <div style="background:var(--surface-soft); padding:12px; border:1px solid var(--border); border-radius:6px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
              <strong>Windows Binary</strong>
              <button class="button-secondary" style="padding:2px 8px; font-size:11px;" onclick="copyCodeSnippet('https://github.com/rtk-ai/rtk/releases')">Copy URL</button>
            </div>
            <p class="muted" style="font-size:12px; margin:0 0 6px;">Download <code>rtk-x86_64-pc-windows-msvc.zip</code>, extract <code>rtk.exe</code>, and place it in your <code>PATH</code>.</p>
            <pre style="margin:0; padding:8px; background:var(--surface-raised); border-radius:4px; font-size:12px; overflow-x:auto;"><code>rtk --version</code></pre>
          </div>
        </div>

        <h4 style="margin:16px 0 8px;">Hook Initialization into Your Agent:</h4>
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:12px;">
          <div style="background:var(--surface-soft); padding:12px; border:1px solid var(--border); border-radius:6px;">
            <strong>Claude Code &amp; Copilot</strong>
            <pre style="margin:6px 0 0; padding:8px; background:var(--surface-raised); border-radius:4px; font-size:12px; overflow-x:auto;"><code>rtk init -g</code></pre>
          </div>
          <div style="background:var(--surface-soft); padding:12px; border:1px solid var(--border); border-radius:6px;">
            <strong>Antigravity / Gemini CLI</strong>
            <pre style="margin:6px 0 0; padding:8px; background:var(--surface-raised); border-radius:4px; font-size:12px; overflow-x:auto;"><code>rtk init --agent antigravity
# or: rtk init -g --gemini</code></pre>
          </div>
          <div style="background:var(--surface-soft); padding:12px; border:1px solid var(--border); border-radius:6px;">
            <strong>Codex &amp; Cursor</strong>
            <pre style="margin:6px 0 0; padding:8px; background:var(--surface-raised); border-radius:4px; font-size:12px; overflow-x:auto;"><code>rtk init -g --codex
rtk init -g --agent cursor</code></pre>
          </div>
        </div>

        <h4 style="margin:16px 0 8px;">Verification &amp; Direct Usage:</h4>
        <div style="display:flex; flex-wrap:wrap; gap:8px; font-size:13px;">
          <span style="background:var(--surface-soft); border:1px solid var(--border); padding:4px 10px; border-radius:4px;"><code>rtk gain</code> &mdash; View terminal savings dashboard</span>
          <span style="background:var(--surface-soft); border:1px solid var(--border); padding:4px 10px; border-radius:4px;"><code>rtk git status</code> &mdash; Condensed git view</span>
          <span style="background:var(--surface-soft); border:1px solid var(--border); padding:4px 10px; border-radius:4px;"><code>rtk test &lt;cmd&gt;</code> &mdash; Strip passing tests, show failures</span>
          <span style="background:var(--surface-soft); border:1px solid var(--border); padding:4px 10px; border-radius:4px;"><code>rtk read &lt;file&gt;</code> &mdash; Signatures and structure</span>
        </div>
      </div>

      <script>
        function copyCodeSnippet(text) {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function() {
              if (typeof setMessage === 'function') {
                setMessage('Copied snippet to clipboard.', 'success');
              }
            }).catch(function() {
              if (typeof setMessage === 'function') {
                setMessage('Unable to copy to clipboard.', 'error');
              }
            });
          } else {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            try {
              document.execCommand('copy');
              if (typeof setMessage === 'function') {
                setMessage('Copied snippet to clipboard.', 'success');
              }
            } catch (e) {
              if (typeof setMessage === 'function') {
                setMessage('Unable to copy snippet.', 'error');
              }
            }
            document.body.removeChild(textarea);
          }
        }
      </script>
`;

  return renderLayout('Token Efficiency', body, params);
}
