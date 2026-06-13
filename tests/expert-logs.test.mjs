import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  LogEntryTracker,
  detectModalities,
  analyzeLogs,
  getExpertLogs,
  clearExpertLogs,
  importExpertLogs,
  loadExpertLogs,
  saveExpertLogs
} from '../build/expert-logs.js';

test('detectModalities correctly parses different payload types', () => {
  // Text only
  const textBody = {
    messages: [
      { role: 'user', content: 'Hello' }
    ]
  };
  assert.deepEqual(detectModalities(textBody), ['text']);

  // Multimodal image (OpenAI style)
  const imageBodyOpenAI = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }
        ]
      }
    ]
  };
  assert.deepEqual(detectModalities(imageBodyOpenAI).sort(), ['image', 'text']);

  // Video body (Gemini/custom style)
  const videoBody = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'video_url', video_url: 'http://example.com/video.mp4' }
        ]
      }
    ]
  };
  assert.deepEqual(detectModalities(videoBody), ['video']);

  // PDF document body
  const pdfBody = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'document', mime_type: 'application/pdf' }
        ]
      }
    ]
  };
  assert.deepEqual(detectModalities(pdfBody), ['pdf']);
});

test('LogEntryTracker handles successful completion and cost calculations', () => {
  clearExpertLogs();

  const tracker = new LogEntryTracker('test-client', 'gpt-4o', 'direct');
  tracker.setRequestDetails({
    stream: false,
    tools: [{ name: 'get_weather' }]
  });

  tracker.onSuccess('openai', 'gpt-4o', 200);

  // Simulate usage payload
  tracker.onUsage({
    choices: [
      {
        message: {
          role: 'assistant',
          content: 'The weather is nice.',
          tool_calls: [
            {
              function: {
                name: 'get_weather',
                arguments: '{"location":"San Francisco"}'
              }
            }
          ]
        }
      }
    ],
    usage: {
      prompt_tokens: 1500,
      completion_tokens: 200,
      prompt_tokens_details: {
        cached_tokens: 1000
      }
    }
  });

  tracker.onFinish(250);

  const logs = getExpertLogs();
  assert.equal(logs.length, 1);
  const log = logs[0];

  assert.equal(log.clientName, 'test-client');
  assert.equal(log.requestModel, 'gpt-4o');
  assert.equal(log.selectedModel, 'gpt-4o');
  assert.equal(log.provider, 'openai');
  assert.equal(log.status, 200);
  assert.equal(log.durationMs, 250);
  assert.equal(log.promptTokens, 1500);
  assert.equal(log.completionTokens, 200);
  assert.equal(log.cachedTokens, 1000);
  assert.equal(log.toolCallsRequested, 1);
  assert.equal(log.toolCalls.length, 1);
  assert.equal(log.toolCalls[0].name, 'get_weather');
  assert.equal(log.toolCalls[0].arguments, '{"location":"San Francisco"}');
  assert.equal(log.content, 'The weather is nice.');
  assert.equal(log.thinking, '');
});

test('LogEntryTracker handles thinking/reasoning content and stream merging', () => {
  clearExpertLogs();

  const tracker = new LogEntryTracker('test-client', 'deepseek-reasoner', 'direct');
  tracker.setRequestDetails({ stream: true });

  tracker.onSuccess('deepseek', 'deepseek-reasoner', 200);

  // Simulate stream chunks
  tracker.onUsage({
    choices: [{ delta: { reasoning_content: 'Let me ' } }]
  });
  tracker.onUsage({
    choices: [{ delta: { reasoning_content: 'think...' } }]
  });
  tracker.onUsage({
    choices: [{ delta: { content: 'Hello!' } }]
  });
  tracker.onUsage({
    choices: [{
      delta: {
        tool_calls: [
          {
            index: 0,
            id: 'call-1',
            function: { name: 'calculator', arguments: '{"expr":' }
          }
        ]
      }
    }]
  });
  tracker.onUsage({
    choices: [{
      delta: {
        tool_calls: [
          {
            index: 0,
            function: { arguments: '"2+2"}' }
          }
        ]
      }
    }]
  });
  tracker.onUsage({
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50
    }
  });

  tracker.onFinish(300);

  const logs = getExpertLogs();
  assert.equal(logs.length, 1);
  const log = logs[0];

  assert.equal(log.thinking, 'Let me think...');
  assert.equal(log.content, 'Hello!');
  assert.equal(log.toolCalls.length, 1);
  assert.equal(log.toolCalls[0].name, 'calculator');
  assert.equal(log.toolCalls[0].arguments, '{"expr":"2+2"}');
});

test('LogEntryTracker handles failures', () => {
  clearExpertLogs();

  const tracker = new LogEntryTracker('test-client', 'gpt-4o', 'direct');
  tracker.onFailure(429, 'upstream_http_rate_limit', 'Rate limit exceeded');
  tracker.onFinish(50);

  const logs = getExpertLogs();
  assert.equal(logs.length, 1);
  const log = logs[0];

  assert.equal(log.status, 429);
  assert.equal(log.errorType, 'upstream_http_rate_limit');
  assert.equal(log.errorMessage, 'Rate limit exceeded');
});

test('analyzeLogs aggregates stats correctly', () => {
  clearExpertLogs();

  const tracker1 = new LogEntryTracker('c1', 'm1', 'direct');
  tracker1.log.promptTokens = 1000;
  tracker1.log.cachedTokens = 500;
  tracker1.log.completionTokens = 100;
  tracker1.log.status = 200;
  tracker1.log.modalities = ['text'];
  tracker1.log.costTotal = 0.05;
  tracker1.log.savingsDollars = 0.02;
  tracker1.log.durationMs = 150;
  tracker1.log.provider = 'p1';
  tracker1.log.requestModel = 'm1';
  tracker1.onFinish(150);

  const tracker2 = new LogEntryTracker('c2', 'm2', 'direct');
  tracker2.log.promptTokens = 2000;
  tracker2.log.cachedTokens = 1000;
  tracker2.log.completionTokens = 200;
  tracker2.log.status = 500;
  tracker2.log.errorType = 'upstream_error';
  tracker2.log.modalities = ['text', 'image'];
  tracker2.log.costTotal = 0.10;
  tracker2.log.savingsDollars = 0.04;
  tracker2.log.durationMs = 250;
  tracker2.log.provider = 'p2';
  tracker2.log.requestModel = 'm2';
  tracker2.onFinish(250);

  const analysis = analyzeLogs();
  assert.equal(analysis.totalRequests, 2);
  assert.equal(analysis.totalTokens.prompt, 3000);
  assert.equal(analysis.totalTokens.cached, 1500);
  assert.equal(analysis.totalCostDollars, 0.15);
  assert.equal(analysis.totalSavingsDollars, 0.06);
  assert.equal(analysis.modalitiesCount['text'], 2);
  assert.equal(analysis.modalitiesCount['image'], 1);
  assert.equal(analysis.modelUsage['m1'], 1);
  assert.equal(analysis.providerUsage['p2'], 1);
  assert.equal(analysis.errorCount['upstream_error'], 1);
  assert.equal(analysis.averageLatencyMs, 200);
  assert.equal(analysis.cacheMissReasons['none'], 1);

  // Modalites verification check
  assert.ok(analysis.modalitiesVerification['text']);
  assert.ok(analysis.modalitiesVerification['image+text']);
});

test('import and export APIs function correctly', () => {
  clearExpertLogs();

  const dummyLogs = [
    {
      id: 'log-1',
      timestamp: new Date().toISOString(),
      clientName: 'c1',
      requestModel: 'm1',
      presentedModel: 'm1',
      selectedModel: 'm1',
      provider: 'p1',
      routeKind: 'direct',
      routerId: '',
      stream: false,
      status: 200,
      durationMs: 100,
      modalities: ['text'],
      isMultimodal: false,
      toolCallsRequested: 0,
      toolCalls: [],
      thinking: '',
      content: '',
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      costPrompt: 0,
      costCompletion: 0,
      costCached: 0,
      costTotal: 0,
      costWithoutCaching: 0,
      savingsDollars: 0
    }
  ];

  const result = importExpertLogs(dummyLogs);
  assert.equal(result.success, true);
  assert.equal(result.count, 1);

  const logs = getExpertLogs();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].id, 'log-1');

  clearExpertLogs();
  assert.equal(getExpertLogs().length, 0);
});
