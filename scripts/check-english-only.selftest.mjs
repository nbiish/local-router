/**
 * Regression proof for scripts/check-english-only.mjs.
 *
 * Each case is a defect class the guard exists to catch, fed to the guard as a temporary tracked
 * file so the real scan path is exercised. A guard nobody has seen fail is not evidence.
 */
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

const TMP = 'tests/.tmp-english-only-probe.md';

const cases = [
  {
    name: 'control byte from a collapsed \\a escape',
    body: 'and \u0007inish-rag secrets reporting Decisions Route\n',
    expect: 'control-byte',
  },
  {
    name: 'lone CR from a collapsed \\r escape',
    body: 'a fixture snapshot of \rationale prefixes\n',
    expect: 'control-byte',
  },
  {
    name: 'Cyrillic homoglyph inside an English word',
    body: 'so r\u0435\u0440anked retrieval is proven\n',
    expect: 'mixed-script-token',
  },
  {
    name: 'Greek word in prose',
    body: 'this is written in \u03b5\u03bb\u03bb\u03b7\u03bd\u03b9\u03ba\u03ac here\n',
    expect: 'non-latin-script',
  },
  {
    name: 'Han text',
    body: 'this line contains \u6f22\u5b57 characters\n',
    expect: 'non-latin-script',
  },
  {
    name: 'fullwidth plus in a label',
    body: 'Use the \uff0b Fallback button\n',
    expect: 'fullwidth-punctuation',
  },
];

const clean = [
  { name: 'Greek math symbols', body: 'dLinUCB with geometric forgetting (\u03b3=0.98) and \u03be seed\n' },
  { name: 'code span with a foreign word', body: 'run `\u6f22\u5b57 --flag` to check\n' },
  { name: 'ASCII plus label', body: 'Use the + Fallback button\n' },
  { name: 'fenced block with foreign text', body: '```\n\u6f22\u5b57\n```\n' },
];

let failures = 0;
const results = [];

for (const c of cases) {
  fs.writeFileSync(TMP, c.body, 'utf8');
  execFileSync('git', ['add', '-f', TMP]);
  const r = spawnSync(process.execPath, ['scripts/check-english-only.mjs', '--json'], { encoding: 'utf8' });
  const parsed = JSON.parse(r.stdout);
  const hit = parsed.findings.some((f) => f.kind === c.expect);
  results.push({ name: c.name, ok: hit, detail: hit ? c.expect : `missed (${parsed.count} findings, expected ${c.expect})` });
  if (!hit) failures++;
  execFileSync('git', ['rm', '--cached', '-q', '--force', TMP]);
}

for (const c of clean) {
  fs.writeFileSync(TMP, c.body, 'utf8');
  execFileSync('git', ['add', '-f', TMP]);
  const r = spawnSync(process.execPath, ['scripts/check-english-only.mjs', '--json'], { encoding: 'utf8' });
  const parsed = JSON.parse(r.stdout);
  const ok = parsed.count === 0;
  results.push({ name: `clean: ${c.name}`, ok, detail: ok ? 'no findings' : JSON.stringify(parsed.findings) });
  if (!ok) failures++;
  execFileSync('git', ['rm', '--cached', '-q', '--force', TMP]);
}

try { fs.unlinkSync(TMP); } catch { }

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.detail})`);
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures === 0 ? 0 : 1);
