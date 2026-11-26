import test from 'node:test';
import assert from 'node:assert/strict';

import {
  filterEligibleFallbackModels,
  requestRequiresMultimodal,
  requestRequiresTools
} from '../build/routing-capabilities.js';

// Injected specs keep the tests deterministic: they pin exactly what the
// planner sees per member, independent of the curated registry.
const SPECS = {
  both: { contextLength: 128000, outputTokens: 8192, supportsImages: true, supportsTools: true, reasoningLevelCount: 0 },
  textonly: { contextLength: 64000, outputTokens: 4096, supportsImages: false, supportsTools: false, reasoningLevelCount: 0 },
  toolsonly: { contextLength: 64000, outputTokens: 4096, supportsImages: false, supportsTools: true, reasoningLevelCount: 0 },
  visiononly: { contextLength: 64000, outputTokens: 4096, supportsImages: true, supportsTools: false, reasoningLevelCount: 0 }
};
const specsFor = (id) => SPECS[id];
const CHAIN = ['both', 'textonly', 'toolsonly', 'visiononly'];

const TOOLS = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
const IMAGE_PART = { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } };

test('a tools chat is planned only onto tool-capable members', () => {
  const body = { messages: [{ role: 'user', content: 'hi' }], tools: TOOLS };
  const result = filterEligibleFallbackModels(CHAIN, body, specsFor);
  assert.equal(result.requiresTools, true);
  assert.deepEqual(result.eligible, ['both', 'toolsonly']);
  const skippedTools = result.skipped
    .filter((entry) => entry.reason === 'no_tools_support')
    .map((entry) => entry.model)
    .sort();
  assert.deepEqual(skippedTools, ['textonly', 'visiononly']);
});

test('a vision chat is planned only onto vision-capable members', () => {
  const body = { messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this' }, IMAGE_PART] }] };
  const result = filterEligibleFallbackModels(CHAIN, body, specsFor);
  assert.equal(result.requiresMultimodal, true);
  assert.deepEqual(result.eligible, ['both', 'visiononly']);
  const skippedVision = result.skipped
    .filter((entry) => entry.reason === 'no_multimodal_support')
    .map((entry) => entry.model)
    .sort();
  assert.deepEqual(skippedVision, ['textonly', 'toolsonly']);
});

test('requirements are sticky to the whole session, not the last turn', () => {
  // The image is in the FIRST message; the last turn is plain text.
  const visionBody = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'look' }, IMAGE_PART] },
      { role: 'assistant', content: 'a chart' },
      { role: 'user', content: 'thanks' }
    ]
  };
  assert.equal(requestRequiresMultimodal(visionBody), true);
  assert.deepEqual(filterEligibleFallbackModels(CHAIN, visionBody, specsFor).eligible, ['both', 'visiononly']);

  // Tool traffic is in the history only; no tools array on this turn.
  const toolsBody = {
    messages: [
      { role: 'user', content: 'use the tool' },
      { role: 'assistant', tool_calls: [{ id: '1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: '1', content: '42' },
      { role: 'user', content: 'and now?' }
    ]
  };
  assert.equal(requestRequiresTools(toolsBody), true);
  assert.deepEqual(filterEligibleFallbackModels(CHAIN, toolsBody, specsFor).eligible, ['both', 'toolsonly']);
});

test('a chat needing both tools and vision needs a member with both', () => {
  const body = {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'use it on this' }, IMAGE_PART] }],
    tools: TOOLS
  };
  const result = filterEligibleFallbackModels(CHAIN, body, specsFor);
  assert.deepEqual(result.eligible, ['both']);
  // Gates run in sequence and record the first reason that fails: textonly and
  // toolsonly fall to the vision gate before tools are ever considered, so only
  // visiononly is recorded as a tools skip.
  assert.deepEqual(
    result.skipped.filter((entry) => entry.reason === 'no_multimodal_support').map((entry) => entry.model).sort(),
    ['textonly', 'toolsonly']
  );
  assert.deepEqual(
    result.skipped.filter((entry) => entry.reason === 'no_tools_support').map((entry) => entry.model),
    ['visiononly']
  );
});

test('zero capable members fail closed with the skips recorded', () => {
  const body = { messages: [{ role: 'user', content: 'hi' }], tools: TOOLS };
  const result = filterEligibleFallbackModels(['textonly', 'visiononly'], body, specsFor);
  assert.equal(result.error, 'no_tools_models');
  assert.deepEqual(result.eligible, []);
  assert.deepEqual(result.skipped.map((entry) => entry.reason), ['no_tools_support', 'no_tools_support']);
});

test('a plain chat keeps every member eligible', () => {
  const body = { messages: [{ role: 'user', content: 'hi' }] };
  const result = filterEligibleFallbackModels(CHAIN, body, specsFor);
  assert.equal(result.requiresTools, false);
  assert.equal(result.requiresMultimodal, false);
  assert.deepEqual(result.eligible, CHAIN);
  assert.deepEqual(result.skipped, []);
});

test('the detectors key on explicit signals only', () => {
  assert.equal(requestRequiresTools({ messages: [{ role: 'user', content: 'hi' }] }), false);
  assert.equal(requestRequiresTools({ messages: [], tools: [] }), false);
  assert.equal(requestRequiresTools({ functions: [{ name: 'f' }] }), true);
  assert.equal(requestRequiresTools({ messages: [{ role: 'tool', content: '42' }] }), true);
  assert.equal(
    requestRequiresTools({ messages: [{ role: 'assistant', content: [{ type: 'tool_use', name: 'f', input: {} }] }] }),
    true
  );
  assert.equal(requestRequiresMultimodal({ messages: [{ role: 'user', content: 'hi' }] }), false);
});
