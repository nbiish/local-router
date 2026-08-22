import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPORT_PATH = path.resolve('.agents/research/cline-kilo-catalog-validation.json');

const { PROVIDER_MODEL_REGISTRY } = await import('../build/provider-model-registries.js');

function registryModelIds(providerName) {
  return new Set((PROVIDER_MODEL_REGISTRY[providerName] || []).map((entry) => entry.id));
}

test('cline-kilo chat-proven models stay in the factual registry', () => {
  if (!fs.existsSync(REPORT_PATH)) {
    console.log('Skip: run node scripts/validate-cline-kilo-catalog.mjs to generate report');
    return;
  }

  const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));

  for (const provider of ['cline', 'kilo']) {
    const section = report[provider];
    assert.ok(section, `missing ${provider} section in validation report`);

    const registryIds = registryModelIds(provider);
    const keep = section.catalogResults.filter((row) => row.keep);
    assert.ok(
      registryIds.size >= keep.length,
      `${provider} registry (${registryIds.size}) must cover the chat-proven KEEP set (${keep.length})`
    );
    for (const row of keep) {
      assert.ok(
        registryIds.has(row.model),
        `${provider} chat-proven ${row.model} must stay in the factual registry`
      );
    }
    assert.equal(
      section.staleCatalog.length,
      0,
      `${provider} stale catalog rows: ${section.staleCatalog.map((row) => row.model).join(', ')}`
    );
    assert.equal(
      section.missingFree.length,
      0,
      `${provider} missing free models: ${section.missingFree.map((row) => row.model).join(', ')}`
    );

    for (const row of keep) {
      assert.equal(row.chat?.ok, true, `${provider} ${row.model} must have chat 200`);
    }
  }

  assert.equal(report.cline.provableFree.length, 4, 'Cline must list four chat-proven free models');
  assert.equal(
    report.cline.provableFree.includes('openrouter/free'),
    false,
    'openrouter/free must not be in Cline provable free (chat 500 on Cline)'
  );
  assert.equal(report.kilo.provableFree.length, 7, 'Kilo must list seven chat-proven free models');
  assert.equal(
    report.kilo.provableFree.includes('openrouter/owl-alpha'),
    false,
    'openrouter/owl-alpha must not be in provable free (chat 400)'
  );
});
