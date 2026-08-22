import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Hermetic HOME: importing build/index.js boots the whole app, and candidate
// resolution reads the seeded toggle store — a real operator HOME with a
// curated subset makes eligibility assertions flaky (2026-08-22).
process.env.HOME = mkdtempSync(join(tmpdir(), 'lr-router-disabled-test-'));
process.env.LOCAL_ROUTER_SKIP_OLLAMA_ENSURE = 'true';
process.env.LOCAL_ROUTER_SKIP_PQC_LOAD = 'true';
// Strict namespace: Local Router only reads LOCALROUTER_-prefixed env keys.
process.env.LOCALROUTER_WAFER_SERVERLESS_API_KEY = 'test';
process.env.LOCALROUTER_OPENROUTER_API_KEY = 'test';

const {
  parseRouterModel,
  selectRouterCandidate
} = await import('../build/index.js');

test('selectRouterCandidate: ignores disabled candidates', () => {
  const parsed = parseRouterModel({
    id: 'my-custom-router',
    type: 'auto-local',
    candidates: [
      { model: 'wafer-ai-deepseek-v4-pro', enabled: true },
      { model: 'openrouter-chain-of-draft', enabled: false }
    ]
  });

  assert.ok(parsed.ok);
  const router = parsed.model;

  const body = { messages: [{ role: 'user', content: 'hello' }] };
  const decision = selectRouterCandidate(router, body);

  assert.ok(!('error' in decision), `routing failed: ${decision?.error}`);
  assert.equal(decision.selected.model, 'wafer-ai-deepseek-v4-pro');

  const orderedModels = decision.orderedCandidates.map((c) => c.model);
  assert.equal(orderedModels.includes('openrouter-chain-of-draft'), false);
});
