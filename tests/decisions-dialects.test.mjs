import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LATEST_DECISION_MODEL,
  advertisedDecisionModels,
  canonicalizeDecisionId,
  decisionProvider,
  decisionProvidersForModel,
  isDecisionModelId,
  resolveDecisionModel
} from '../build/decisions/catalog.js';
import {
  DecisionMalformedResponseError,
  validateDecisionQuestions,
  zenmuxDialect
} from '../build/decisions/dialects.js';
import { DecisionContractError } from '../build/decisions/types.js';

// ── Model id resolution ─────────────────────────────────────────

test('canonical decision ids resolve from every client form', () => {
  assert.equal(resolveDecisionModel('typesafe/jev-1.14').canonical, 'typesafe/jev-1.14');
  assert.equal(resolveDecisionModel('jev-1.14').canonical, 'typesafe/jev-1.14');
  assert.equal(resolveDecisionModel('jev-latest').canonical, LATEST_DECISION_MODEL);
  assert.equal(resolveDecisionModel('typesafe/jev-latest').canonical, LATEST_DECISION_MODEL);
  assert.equal(resolveDecisionModel('local-router/jev-1.14').canonical, 'typesafe/jev-1.14');
  assert.equal(resolveDecisionModel('openrouter/jev-1.14').canonical, 'typesafe/jev-1.14');
  assert.equal(resolveDecisionModel('openrouter/jev-1.14').provider, 'openrouter');
  assert.equal(resolveDecisionModel('zenmux/typesafe/jev-1.14').provider, 'zenmux');
  assert.equal(resolveDecisionModel('zenmux/typesafe/jev-1.14').canonical, 'typesafe/jev-1.14');
});

test('the Jev chat alias is never treated as a decision model', () => {
  // `openrouter-jev-router` is served by a general chat model. Treating it as a
  // decision model would route prose into a calibrated-probability channel.
  assert.equal(isDecisionModelId('openrouter-jev-router'), false);
  assert.equal(isDecisionModelId('openrouter/jev-router'), false);
  assert.equal(isDecisionModelId('local-router/fallback-models'), false);
  assert.equal(isDecisionModelId('zenmux/qwen3.7-max'), false);
  assert.equal(isDecisionModelId('typesafe/jev-router'), false);
  assert.equal(canonicalizeDecisionId('jev-router'), null);
});

test('advertised decision ids carry the provider prefix', () => {
  const rows = advertisedDecisionModels([decisionProvider('openrouter'), decisionProvider('zenmux')]);
  assert.deepEqual(rows.map((row) => row.id), ['openrouter/jev-1.14', 'zenmux/jev-1.14']);
  assert.equal(rows[0].canonical, 'typesafe/jev-1.14');
});

test('both configured providers claim the latest model; order is stable', () => {
  assert.deepEqual(
    decisionProvidersForModel('typesafe/jev-1.14').map((spec) => spec.name),
    ['openrouter', 'zenmux']
  );
  assert.deepEqual(decisionProvidersForModel('typesafe/jev-router'), []);
});

// ── Contract validation ─────────────────────────────────────────

test('choice requires at least two options', () => {
  assert.throws(
    () => validateDecisionQuestions({ q: { type: 'choice', instructions: 'pick', options: ['only'] } }),
    DecisionContractError
  );
});

test('choice options may come from criteria keys', () => {
  assert.doesNotThrow(() =>
    validateDecisionQuestions({
      q: { type: 'choice', instructions: 'pick', criteria: { a: 'first', b: 'second' } }
    })
  );
});

test('score requires level descriptions', () => {
  assert.throws(
    () => validateDecisionQuestions({ q: { type: 'score', instructions: 'rate' } }),
    DecisionContractError
  );
});

test('unknown question types are rejected', () => {
  assert.throws(
    () => validateDecisionQuestions({ q: { type: 'vibe', instructions: 'rate' } }),
    /unsupported type/
  );
});

// ── ZenMux dialect ──────────────────────────────────────────────

test('zenmux encodes the strict array body and translates noul to a two-way choice', () => {
  const { body, translations } = zenmuxDialect.encode({
    canonicalModel: 'typesafe/jev-1.14',
    state: 'file src/router.ts binds port 11434',
    questions: {
      needs_port: {
        type: 'noul',
        instructions: 'Does this state bind a port?',
        criteria: { true: 'it binds a port', false: 'no network binding' }
      },
      component: {
        type: 'choice',
        instructions: 'Which component?',
        options: ['resolver', 'server'],
        criteria: { resolver: 'resolves keys', server: 'serves http' }
      },
      utility: {
        type: 'score',
        instructions: 'How relevant?',
        criteria: ['none', 'partial', 'complete']
      }
    }
  });

  assert.equal(body.model, 'typesafe/jev-1.14');
  assert.equal(body.input, 'file src/router.ts binds port 11434');
  assert.ok(Array.isArray(body.questions));
  assert.deepEqual(body.questions.map((q) => q.name), ['needs_port', 'component', 'utility']);
  assert.deepEqual(body.questions[0].choices, [
    { value: 'true', description: 'it binds a port' },
    { value: 'false', description: 'no network binding' }
  ]);
  assert.deepEqual(body.questions[1].choices, [
    { value: 'resolver', description: 'resolves keys' },
    { value: 'server', description: 'serves http' }
  ]);
  assert.deepEqual(body.questions[2].levels, [
    { label: 'none' },
    { label: 'partial' },
    { label: 'complete' }
  ]);
  assert.deepEqual(translations, ['noul->choice(needs_port)']);
});

test('zenmux refuses a noul without criteria (the translation needs both descriptions)', () => {
  assert.throws(
    () =>
      zenmuxDialect.encode({
        canonicalModel: 'typesafe/jev-1.14',
        state: 's',
        questions: { q: { type: 'noul', instructions: 'Is it?' } }
      }),
    DecisionContractError
  );
});

test('zenmux decodes a translated noul from the two-way choice probabilities', () => {
  const questions = {
    needs_port: {
      type: 'noul',
      instructions: 'Does this state bind a port?',
      criteria: { true: 'it binds a port', false: 'no network binding' }
    }
  };
  const decoded = zenmuxDialect.decode(
    {
      model: 'typesafe/jev-1.14-20261014',
      answers: {
        needs_port: {
          type: 'choice',
          choice: 'true',
          confidence: 0.66,
          probabilities: { true: 0.83, false: 0.17 }
        }
      },
      usage: { input_tokens: 30, output_tokens: 4 }
    },
    questions,
    'typesafe/jev-1.14'
  );

  assert.equal(decoded.model, 'typesafe/jev-1.14-20261014');
  assert.equal(decoded.answers.needs_port.type, 'noul');
  assert.equal(decoded.answers.needs_port.noul, 0.83);
  assert.equal(decoded.answers.needs_port.translated_from, 'choice');
  assert.deepEqual(decoded.usage, { input_tokens: 30, output_tokens: 4 });
});

test('zenmux normalizes one-based score levels and rebuilds the legend', () => {
  const questions = { utility: { type: 'score', instructions: 'How relevant?', criteria: ['none', 'partial', 'complete'] } };
  const decoded = zenmuxDialect.decode(
    {
      model: 'typesafe/jev-1.14',
      answers: {
        utility: {
          type: 'score',
          score: 2.3,
          confidence: 0.5,
          probabilities: { 1: 0.1, 2: 0.5, 3: 0.4 },
          legend: { 1: 'none', 2: 'partial', 3: 'complete' }
        }
      }
    },
    questions,
    'typesafe/jev-1.14'
  );

  assert.ok(Math.abs(decoded.answers.utility.score - 1.3) < 1e-9, `score was ${decoded.answers.utility.score}`);
  assert.deepEqual(decoded.answers.utility.legend, { 0: 'none', 1: 'partial', 2: 'complete' });
  assert.deepEqual(decoded.answers.utility.probabilities, { 0: 0.1, 1: 0.5, 2: 0.4 });
});

test('zenmux fails closed when the true probability is missing', () => {
  assert.throws(
    () =>
      zenmuxDialect.decode(
        {
          model: 'typesafe/jev-1.14',
          answers: { q: { type: 'choice', choice: 'true', probabilities: { false: 1 } } }
        },
        { q: { type: 'noul', instructions: 'Is it?', criteria: { true: 'a', false: 'b' } } },
        'typesafe/jev-1.14'
      ),
    DecisionMalformedResponseError
  );
});

test('zenmux fails closed when an answer is missing', () => {
  assert.throws(
    () =>
      zenmuxDialect.decode(
        { model: 'typesafe/jev-1.14', answers: {} },
        { q: { type: 'noul', instructions: 'Is it?', criteria: { true: 'a', false: 'b' } } },
        'typesafe/jev-1.14'
      ),
    DecisionMalformedResponseError
  );
});
