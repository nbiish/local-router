import test from 'node:test';
import assert from 'node:assert/strict';

test('renderEfficiencyPage returns complete HTML with all 3 efficiency tools', async () => {
  const { renderEfficiencyPage } = await import('../build/ui/pages/efficiency.js');
  const html = renderEfficiencyPage({ defaultFallbackModelsText: 'test-model' });

  // Page title and layout
  assert.ok(html.includes('<title>Token Efficiency | Local Router</title>'), 'Includes correct document title');
  assert.ok(html.includes('Token Efficiency &amp; Optimization Hub'), 'Includes header title');

  // Architecture rationale
  assert.ok(html.includes('Why is token efficiency decoupled from Local Router core?'), 'Explains decoupling rationale');
  assert.ok(html.includes('unify all LLM providers under one source'), 'Mentions primary router mission');
  assert.ok(html.includes('resilient, tool-agnostic fallback-models pipeline'), 'Mentions fallback models mission');

  // Tool 1: Ponytail
  assert.ok(html.includes('1. Ponytail'), 'Includes Ponytail heading');
  assert.ok(html.includes('https://github.com/dietrichgebert/ponytail'), 'Links to Ponytail GitHub');
  assert.ok(html.includes('/plugin marketplace add DietrichGebert/ponytail'), 'Includes Claude Code install command');
  assert.ok(html.includes('codex plugin marketplace add DietrichGebert/ponytail'), 'Includes Codex install command');
  assert.ok(html.includes('agy plugin install https://github.com/DietrichGebert/ponytail'), 'Includes Antigravity install command');
  assert.ok(html.includes('/ponytail-review'), 'Includes Ponytail commands');

  // Tool 2: Headroom
  assert.ok(html.includes('2. Headroom'), 'Includes Headroom heading');
  assert.ok(html.includes('https://github.com/headroomlabs-ai/headroom'), 'Links to Headroom GitHub');
  assert.ok(html.includes('headroom proxy --port 8787'), 'Includes Headroom proxy command');
  assert.ok(html.includes('headroom wrap claude'), 'Includes Headroom wrap command');
  assert.ok(html.includes('HEADROOM_OUTPUT_SHAPER=1'), 'Includes output token reduction flag');

  // Tool 3: RTK
  assert.ok(html.includes('3. RTK (Rust Token Killer)'), 'Includes RTK heading');
  assert.ok(html.includes('https://github.com/rtk-ai/rtk'), 'Links to RTK GitHub');
  assert.ok(html.includes('brew install rtk'), 'Includes Homebrew install command');
  assert.ok(html.includes('rtk init -g'), 'Includes RTK init command');
  assert.ok(html.includes('rtk gain'), 'Includes RTK gain dashboard command');

  // Navigation link
  assert.ok(html.includes('href="/config/efficiency"'), 'Includes sidebar nav link to Token Efficiency');

  // Copy code mechanism
  assert.ok(html.includes('copyCodeSnippet'), 'Includes copyCodeSnippet helper function');
});
