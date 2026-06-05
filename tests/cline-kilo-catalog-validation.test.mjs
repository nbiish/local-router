import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPORT_PATH = path.resolve('.agents/research/cline-kilo-catalog-validation.json');

function parseCatalogCount(providerName) {
  const content = fs.readFileSync(path.resolve('providers.txt'), 'utf8');
  let count = 0;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('# │')) continue;
    const columns = line
      .replace(/^#\s*/, '')
      .split('│')
      .map((part) => part.trim())
      .filter(Boolean);
    if (columns.length < 4 || !/^\d+$/.test(columns[0])) continue;
    if (columns[1] === providerName) count += 1;
  }
  return count;
}

test('cline-kilo catalog validation report matches providers.txt', () => {
  if (!fs.existsSync(REPORT_PATH)) {
    console.log('Skip: run node scripts/validate-cline-kilo-catalog.mjs to generate report');
    return;
  }

  const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));

  for (const provider of ['cline', 'kilo']) {
    const section = report[provider];
    assert.ok(section, `missing ${provider} section in validation report`);

    const keep = section.catalogResults.filter((row) => row.keep);
    assert.equal(
      keep.length,
      parseCatalogCount(provider),
      `${provider} providers.txt rows must match chat-proven KEEP set`
    );
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
