import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traj-test-'));
process.env.LOCAL_ROUTER_TRAJECTORY_DIR = tmpDir;

const {
  TrajectoryTracker,
  appendTrajectory,
  loadTrajectories,
  getTrajectory,
  storeReceipt,
  readReceiptPayload,
  analyzeTrajectories,
  listTrajectorySummaries,
  summarizeRequestBody,
  clearTrajectories
} = await import('../build/trajectories.js');

function makeLog(overrides = {}) {
  return {
    timestamp: new Date().toISOString(),
    durationMs: 100,
    status: 200,
    promptTokens: 10,
    completionTokens: 5,
    cachedTokens: 0,
    costTotal: 0.001,
    ...overrides
  };
}

test('tracker records the full stage timeline, chain snapshot, and winner', () => {
  clearTrajectories();
  const tracker = new TrajectoryTracker(
    { client: 'test-client', presentedModel: 'local-router/fallback-models', routeKind: 'fallback', routeId: 'fallback-models' },
    { model: 'local-router/fallback-models', messages: [{ role: 'user', content: 'hello' }] }
  );
  tracker.setChain({
    routeId: 'fallback-models',
    configuredTargets: ['model-a', 'model-b'],
    excludedTargets: [],
    eligibleTargets: ['model-a', 'model-b'],
    requiredContext: 100,
    requiresMultimodal: false,
    planStageCount: 2
  });
  tracker.addStage({
    stage: 'pass-1-step-1',
    targetModel: 'model-a',
    provider: 'prov-a',
    actualModel: 'model-a',
    attempt: 1,
    stageAttempts: 1,
    outcome: 'failed',
    errorType: 'upstream_http_rate_limit',
    status: 429,
    errorMessage: 'rate limited',
    waitBeforeRetrySeconds: 2
  });
  tracker.addStage({
    stage: 'pass-1-step-2',
    targetModel: 'model-b',
    provider: 'prov-b',
    actualModel: 'model-b-actual',
    attempt: 1,
    stageAttempts: 1,
    outcome: 'answered',
    status: 200,
    ms: 50
  });
  const record = tracker.finish(makeLog({ content: 'the answer', thinking: 'hmm' }));

  assert.equal(record.stages.length, 2);
  assert.equal(record.stages[0].outcome, 'failed');
  assert.equal(record.stages[0].waitBeforeRetrySeconds, 2);
  assert.equal(record.stages[1].outcome, 'answered');
  assert.deepEqual(record.result.answeredBy, { provider: 'prov-b', model: 'model-b-actual' });
  assert.equal(record.routeKind, 'fallback');
  assert.equal(record.chain.planStageCount, 2);
  assert.equal(record.request.promptHash.length, 16);

  const persisted = getTrajectory(record.id);
  assert.ok(persisted, 'record must be retrievable by id');
  assert.equal(persisted.stages.length, 2);

  // A second finish is a no-op: the completion hook must never double-log.
  assert.equal(tracker.finish(makeLog()), null);
  assert.equal(loadTrajectories().length, 1);
});

test('chain snapshot carries pre-plan exclusions with their reasons', () => {
  clearTrajectories();
  const tracker = new TrajectoryTracker(
    { client: 'c', presentedModel: 'local-router/chain-x', routeKind: 'fallback', routeId: 'chain-x' },
    {}
  );
  tracker.setChain({
    routeId: 'chain-x',
    configuredTargets: ['kept', 'ghost', 'off'],
    excludedTargets: [
      { model: 'ghost', reason: 'no_configured_key' },
      { model: 'off', reason: 'disabled_toggle' }
    ],
    eligibleTargets: ['kept'],
    requiredContext: 1,
    requiresMultimodal: false,
    planStageCount: 1
  });
  tracker.addStage({
    stage: 'pass-1-step-1', targetModel: 'kept', provider: 'p', actualModel: 'kept',
    attempt: 1, stageAttempts: 1, outcome: 'answered', status: 200
  });
  const record = tracker.finish(makeLog());

  assert.deepEqual(record.chain.excludedTargets, [
    { model: 'ghost', reason: 'no_configured_key' },
    { model: 'off', reason: 'disabled_toggle' }
  ]);
  const summary = listTrajectorySummaries({ route: 'chain-x' });
  assert.equal(summary.length, 1);
  assert.equal(summary[0].answeredBy.provider, 'p');
});

test('spill receipts keep large payloads retrievable by sha handle', () => {
  const large = 'L'.repeat(10000);
  const receipt = storeReceipt(large);
  assert.equal(receipt.chars, 10000);
  assert.match(receipt.sha, /^sha:[0-9a-f]{64}$/);
  assert.equal(receipt.preview.length <= 401, true);
  assert.equal(readReceiptPayload(receipt), large);

  const smallReceipt = storeReceipt('small payload');
  assert.equal(readReceiptPayload(smallReceipt), 'small payload');
});

test('analysis flags dead, always-skipped, and invisible chain members', () => {
  clearTrajectories();
  for (let i = 0; i < 4; i += 1) {
    const tracker = new TrajectoryTracker(
      { client: 'c', presentedModel: 'local-router/chain-y', routeKind: 'fallback', routeId: 'chain-y' },
      {}
    );
    tracker.setChain({
      routeId: 'chain-y',
      configuredTargets: ['good', 'dead', 'ghost', 'gone'],
      excludedTargets: [{ model: 'ghost', reason: 'no_configured_key' }],
      eligibleTargets: ['good', 'dead'],
      requiredContext: 1,
      requiresMultimodal: false,
      planStageCount: 2
    });
    tracker.addStage({
      stage: 'pass-1-step-1', targetModel: 'good', provider: 'p', actualModel: 'good',
      attempt: 1, stageAttempts: 1, outcome: 'answered', status: 200
    });
    tracker.addStage({
      stage: 'pass-1-step-2', targetModel: 'dead', provider: 'p', actualModel: 'dead',
      attempt: 1, stageAttempts: 1, outcome: 'failed', errorType: 'upstream_http_auth', status: 401
    });
    tracker.finish(makeLog());
  }

  const report = analyzeTrajectories();
  const route = report.routes.find((r) => r.routeId === 'chain-y');
  assert.ok(route, 'route must appear in the health report');
  const byModel = new Map(route.models.map((m) => [m.model, m]));

  assert.deepEqual(byModel.get('good').flags, []);
  assert.ok(byModel.get('dead').flags.includes('never_answers'));
  assert.equal(byModel.get('dead').errorTypes.upstream_http_auth, 4);
  // §4.3: failures roll up into the stable triage classes and flag the member.
  assert.deepEqual(byModel.get('dead').errorClasses, { key_rejected: 4 });
  assert.ok(byModel.get('dead').flags.includes('key_rejected'));
  assert.deepEqual(byModel.get('good').errorClasses, {});
  assert.ok(byModel.get('ghost').flags.includes('always_skipped'));
  assert.equal(byModel.get('ghost').skipReasons.no_configured_key, 4);
  assert.ok(byModel.get('gone').flags.includes('missing_from_plan'));
  assert.equal(route.winnerCounts['p/good'], 4);
});

test('error classes aggregate into triage buckets and surface as flags', () => {
  clearTrajectories();
  const tracker = new TrajectoryTracker(
    { client: 'c', presentedModel: 'local-router/chain-ec', routeKind: 'fallback', routeId: 'chain-ec' },
    {}
  );
  tracker.setChain({
    routeId: 'chain-ec',
    configuredTargets: ['funds', 'limited', 'usage'],
    excludedTargets: [],
    eligibleTargets: ['funds', 'limited', 'usage'],
    requiredContext: 1,
    requiresMultimodal: false,
    planStageCount: 3
  });
  tracker.addStage({
    stage: 'pass-1-step-1', targetModel: 'funds', provider: 'p', actualModel: 'funds',
    attempt: 1, stageAttempts: 1, outcome: 'failed', errorType: 'upstream_http_payment_required', status: 402
  });
  tracker.addStage({
    stage: 'pass-1-step-2', targetModel: 'limited', provider: 'p', actualModel: 'limited',
    attempt: 1, stageAttempts: 1, outcome: 'failed', errorType: 'upstream_http_rate_limit', status: 429
  });
  tracker.addStage({
    stage: 'pass-1-step-3', targetModel: 'usage', provider: 'p', actualModel: 'usage',
    attempt: 1, stageAttempts: 1, outcome: 'failed', errorType: 'upstream_http_invalid_request', status: 400
  });
  tracker.finish(makeLog({ status: 502, errorType: 'upstream_http_payment_required' }));

  const report = analyzeTrajectories();
  const route = report.routes.find((r) => r.routeId === 'chain-ec');
  const byModel = new Map(route.models.map((m) => [m.model, m]));

  assert.deepEqual(byModel.get('funds').errorClasses, { out_of_funds: 1 });
  assert.ok(byModel.get('funds').flags.includes('out_of_funds'), 'a single out-of-funds is the member\'s current problem');
  assert.deepEqual(byModel.get('limited').errorClasses, { usage_limit: 1 });
  assert.ok(byModel.get('limited').flags.includes('usage_limit'));
  assert.deepEqual(byModel.get('usage').errorClasses, { usage_error: 1 });
  assert.ok(byModel.get('usage').flags.includes('usage_error'));
});

test('planned-but-unreached chain members are not flagged', () => {
  clearTrajectories();
  const tracker = new TrajectoryTracker(
    { client: 'c', presentedModel: 'local-router/chain-z', routeKind: 'fallback', routeId: 'chain-z' },
    {}
  );
  tracker.setChain({
    routeId: 'chain-z',
    configuredTargets: ['first', 'second'],
    excludedTargets: [],
    eligibleTargets: ['first', 'second'],
    requiredContext: 1,
    requiresMultimodal: false,
    planStageCount: 2
  });
  tracker.addStage({
    stage: 'pass-1-step-1', targetModel: 'first', provider: 'p', actualModel: 'first',
    attempt: 1, stageAttempts: 1, outcome: 'answered', status: 200
  });
  tracker.finish(makeLog());

  const report = analyzeTrajectories();
  const route = report.routes.find((r) => r.routeId === 'chain-z');
  const second = route.models.find((m) => m.model === 'second');
  assert.ok(second, 'eligible-but-unreached member stays visible in the table');
  assert.deepEqual(second.flags, [], 'but carries no anomaly flag');
});

test('log is bounded: oldest records drop, newest survive', () => {
  clearTrajectories();
  for (let i = 0; i < 2210; i += 1) {
    appendTrajectory({
      schema_version: 1,
      id: `traj-bound-${i}`,
      timestamp: new Date().toISOString(),
      durationMs: 1,
      client: 'c',
      presentedModel: 'm',
      routeKind: 'direct',
      routeId: null,
      request: { stream: false, modalities: ['text'], toolCallsRequested: 0, messageCount: 0, promptHash: 'x' },
      chain: null,
      stages: [],
      result: {
        status: 200, answeredBy: null, errorType: null, errorMessage: null,
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 },
        cost: { total: 0, prompt: 0, completion: 0, cached: 0 }
      },
      receipts: {}
    });
  }
  const records = loadTrajectories();
  assert.equal(records.length < 2210, true, 'log must stay bounded');
  assert.equal(records[records.length - 1].id, 'traj-bound-2209', 'newest record survives');
  assert.equal(records.some((r) => r.id === 'traj-bound-0'), false, 'oldest record is dropped');
});

test('request summarization redacts binary payloads but keeps tool names', () => {
  const summary = summarizeRequestBody({
    model: 'm',
    stream: true,
    tools: [{ function: { name: 'read_file' } }, { type: 'function', function: { name: 'grep' } }],
    messages: [
      { role: 'system', content: 'you are helpful' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is in this image?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
        ]
      }
    ]
  });
  assert.equal(summary.toolCallsRequested, 2);
  assert.equal(summary.messageCount, 2);
  assert.equal(summary.stream, true);
  assert.ok(summary.modalities.includes('image'));
  assert.ok(summary.requestJson.includes('read_file'));
  assert.ok(!summary.requestJson.includes('base64'), 'binary payloads must not be spilled');
  assert.ok(summary.requestJson.includes('"omitted":true'));
});
