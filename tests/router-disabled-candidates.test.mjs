import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRouterModel,
  selectRouterCandidate
} from '../build/index.js';

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

  // Configure provider keys
  process.env.WAFER_SERVERLESS_API_KEY = 'test';
  process.env.OPENROUTER_API_KEY = 'test';

  const body = { messages: [{ role: 'user', content: 'hello' }] };
  const decision = selectRouterCandidate(router, body);

  assert.ok(!('error' in decision), `routing failed: ${decision?.error}`);
  assert.equal(decision.selected.model, 'wafer-ai-deepseek-v4-pro');

  const orderedModels = decision.orderedCandidates.map((c) => c.model);
  assert.equal(orderedModels.includes('openrouter-chain-of-draft'), false);
});
