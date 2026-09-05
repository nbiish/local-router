import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

// Regression for the 2026-09-04 "every config-page button is dead" class:
// a `'\n'` escape written inside the server-side TS template literal emits a
// REAL newline inside a quoted JS string in the served page, which is a
// SyntaxError — killing the ENTIRE inline script block (logout, chain edits,
// imports, everything silently stopped working). Every rendered page's
// <script> blocks must parse as JavaScript.

const pages = [
  { name: 'providers', load: () => import('../build/ui/pages/providers.js'), render: (m) => m.renderProvidersPage({ defaultFallbackModelsText: 'modal-proxy-a' }) },
  { name: 'fallback', load: () => import('../build/ui/pages/fallback.js'), render: (m) => m.renderFallbackPage({ defaultFallbackModelsText: 'modal-proxy-a' }) },
  { name: 'thinking', load: () => import('../build/ui/pages/thinking.js'), render: (m) => m.renderThinkingPage({ defaultFallbackModelsText: 'modal-proxy-a' }) },
  { name: 'chat', load: () => import('../build/ui/pages/chat.js'), render: (m) => m.renderChatPage({ defaultFallbackModelsText: 'modal-proxy-a' }) }
];

for (const page of pages) {
  test(`rendered ${page.name} page contains only parseable <script> blocks`, async () => {
    const mod = await page.load();
    const html = page.render(mod);
    const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    let count = 0;
    while ((match = scriptRegex.exec(html)) !== null) {
      count++;
      assert.doesNotThrow(() => {
        new vm.Script(match[1]);
      }, `${page.name} page script #${count} must parse as valid JavaScript (template-literal escaping bug class)`);
    }
    assert.ok(count >= 2, `${page.name} page should contain at least 2 script blocks`);
  });
}
