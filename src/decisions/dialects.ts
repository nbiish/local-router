/**
 * Decision wire dialects.
 *
 * The router's edge contract is the TypeSafe System One shape (also served by
 * OpenRouter's Decisions API). Two dialects are implemented:
 *
 *  - `typesafe` — OpenRouter: the canonical body is forwarded unchanged
 *    (`{ model, state, questions }` -> `{ model, answers, usage }`).
 *  - `zenmux`  — ZenMux's `/api/v1/decisions`: a strict, array-shaped body
 *    (`{ model, input, questions: [{ name, type, choices | levels }] }`).
 *    ZenMux has no noul primitive, so a noul is carried as a calibrated
 *    two-option choice (`true` / `false`) and converted back to a probability.
 *    The conversion is recorded in the answer (`translated_from: 'choice'`) and
 *    in the response provenance; it is never hidden from the caller.
 *
 * Decoding validates every requested question is answered with the expected
 * primitive. A partial, malformed, or empty answer set is an error — never a
 * silent default, because a transport failure must not become a "no".
 */

import type {
  DecisionAnswer,
  DecisionQuestions,
  DecisionUsage,
  NoulQuestion,
  ChoiceQuestion,
  ScoreQuestion
} from './types';
import { DecisionContractError } from './types';
import type { DecisionDialectName } from './catalog';

export class DecisionMalformedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionMalformedResponseError';
  }
}

export interface EncodedDecisionRequest {
  body: unknown;
  /** Human-readable notes about anything the dialect had to change. */
  translations: string[];
}

export interface DecodedDecisionResponse {
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage?: DecisionUsage;
  id?: string;
}

export interface DecisionDialect {
  name: DecisionDialectName;
  encode(input: {
    canonicalModel: string;
    state: unknown;
    questions: DecisionQuestions;
  }): EncodedDecisionRequest;
  decode(
    body: unknown,
    questions: DecisionQuestions,
    fallbackModel: string
  ): DecodedDecisionResponse;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Renders a criterion (string, object, or array) as the string a provider needs. */
function descriptionText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function instructionsText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function requireInstructions(question: { instructions?: unknown }, id: string): string {
  const text = instructionsText(question.instructions);
  if (!text.trim()) {
    throw new DecisionContractError(`Question "${id}" is missing required instructions.`);
  }
  return text;
}

function scoreCriteria(question: ScoreQuestion, id: string): unknown[] {
  const criteria = question.criteria;
  if (!Array.isArray(criteria) || criteria.length === 0) {
    throw new DecisionContractError(
      `Score question "${id}" requires a non-empty criteria array (one description per level).`
    );
  }
  return criteria;
}

function choiceOptions(question: ChoiceQuestion, id: string): Array<{ name: string; description: string }> {
  const criteria = asRecord(question.criteria) || {};
  const explicit = Array.isArray(question.options)
    ? question.options.filter((option): option is string => typeof option === 'string' && option.length > 0)
    : [];
  const names = explicit.length > 0 ? explicit : Object.keys(criteria);
  const unique = [...new Set(names)];
  if (unique.length < 2) {
    throw new DecisionContractError(
      `Choice question "${id}" requires at least two options (options[i] or criteria keys).`
    );
  }
  return unique.map((name) => ({
    name,
    description: descriptionText(criteria[name])
  }));
}

function noulCriteria(question: NoulQuestion, id: string): { yes: string; no: string } {
  const criteria = asRecord(question.criteria) || {};
  const yes = descriptionText(criteria.true);
  const no = descriptionText(criteria.false);
  if (!yes.trim() || !no.trim()) {
    throw new DecisionContractError(
      `Noul question "${id}" requires criteria.true and criteria.false descriptions.`
    );
  }
  return { yes, no };
}

function pickNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numericMap(value: unknown): Record<string, number> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const out: Record<string, number> = {};
  let seen = false;
  for (const [key, raw] of Object.entries(record)) {
    const num = pickNumber(raw);
    if (num === undefined) continue;
    out[key] = num;
    seen = true;
  }
  return seen ? out : undefined;
}

function pickUsage(value: unknown): DecisionUsage | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return record as DecisionUsage;
}

/**
 * Questions are validated once per dialect so a caller mistake is a 400 that
 * names the field, not an opaque upstream failure. Choice and score need their
 * option/level descriptions because both providers require them; a noul only
 * needs them when a dialect has to translate it into a two-option choice.
 */
export function validateDecisionQuestions(
  questions: DecisionQuestions,
  options: { requireNoulCriteria?: boolean } = {}
): void {
  for (const [id, question] of Object.entries(questions)) {
    const record = asRecord(question);
    if (!record) {
      throw new DecisionContractError(`Question "${id}" must be an object.`);
    }
    const type = record.type;
    if (type === 'noul') {
      if (options.requireNoulCriteria) noulCriteria(record as unknown as NoulQuestion, id);
    } else if (type === 'choice') {
      choiceOptions(record as unknown as ChoiceQuestion, id);
    } else if (type === 'score') {
      scoreCriteria(record as unknown as ScoreQuestion, id);
    } else {
      throw new DecisionContractError(
        `Question "${id}" has unsupported type ${JSON.stringify(type)} (expected noul, choice, or score).`
      );
    }
  }
}

/** OpenRouter / TypeSafe dialect: canonical shape in, canonical shape out. */
export const typesafeDialect: DecisionDialect = {
  name: 'typesafe',
  encode({ canonicalModel, state, questions }) {
    validateDecisionQuestions(questions);
    const clean: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(questions)) {
      const record = asRecord(question) as Record<string, unknown>;
      const type = record.type;
      if (type === 'noul') {
        const criteria = asRecord(record.criteria);
        clean[id] = {
          type: 'noul',
          instructions: String(record.instructions ?? ''),
          ...(criteria ? { criteria: { true: criteria.true ?? null, false: criteria.false ?? null } } : {})
        };
      } else if (type === 'choice') {
        const options = choiceOptions(record as unknown as ChoiceQuestion, id);
        clean[id] = {
          type: 'choice',
          instructions: String(record.instructions ?? ''),
          criteria: Object.fromEntries(options.map((option) => [option.name, option.description]))
        };
      } else {
        const criteria = scoreCriteria(record as unknown as ScoreQuestion, id);
        clean[id] = {
          type: 'score',
          instructions: String(record.instructions ?? ''),
          criteria
        };
      }
    }
    return {
      body: { model: canonicalModel, state, questions: clean },
      translations: []
    };
  },
  decode(body, questions, fallbackModel) {
    const record = asRecord(body);
    if (!record) throw new DecisionMalformedResponseError('Provider response was not a JSON object.');
    const answers = asRecord(record.answers);
    if (!answers) throw new DecisionMalformedResponseError('Provider response contained no answers object.');

    const decoded: Record<string, DecisionAnswer> = {};
    for (const [id, question] of Object.entries(questions)) {
      const answer = asRecord(answers[id]);
      if (!answer) {
        throw new DecisionMalformedResponseError(`Provider response omitted an answer for "${id}".`);
      }
      const expected = (question as { type?: string }).type;
      const actual = pickString(answer.type);
      if (actual && expected && actual !== expected) {
        throw new DecisionMalformedResponseError(
          `Provider answered "${id}" as ${actual} but the question asked for ${expected}.`
        );
      }
      if (expected === 'noul') {
        const noul = pickNumber(answer.noul);
        if (noul === undefined || noul < 0 || noul > 1) {
          throw new DecisionMalformedResponseError(`Answer for "${id}" had no valid noul probability.`);
        }
        decoded[id] = { type: 'noul', noul };
      } else if (expected === 'choice') {
        const choice = pickString(answer.choice);
        if (!choice) throw new DecisionMalformedResponseError(`Answer for "${id}" had no choice.`);
        decoded[id] = {
          type: 'choice',
          choice,
          ...(numericMap(answer.probabilities) ? { probabilities: numericMap(answer.probabilities) } : {}),
          ...(pickNumber(answer.confidence) !== undefined ? { confidence: pickNumber(answer.confidence) } : {})
        };
      } else {
        const score = pickNumber(answer.score);
        if (score === undefined) throw new DecisionMalformedResponseError(`Answer for "${id}" had no score.`);
        const legendRaw = asRecord(answer.legend);
        const legend = legendRaw
          ? Object.fromEntries(Object.entries(legendRaw).map(([key, value]) => [key, descriptionText(value)]))
          : undefined;
        decoded[id] = {
          type: 'score',
          score,
          ...(numericMap(answer.probabilities) ? { probabilities: numericMap(answer.probabilities) } : {}),
          ...(legend ? { legend } : {}),
          ...(pickNumber(answer.confidence) !== undefined ? { confidence: pickNumber(answer.confidence) } : {})
        };
      }
    }

    return {
      model: pickString(record.model) || fallbackModel,
      answers: decoded,
      usage: pickUsage(record.usage),
      id: pickString(record.id)
    };
  }
};

/** ZenMux dialect: strict array-shaped body, translated back to canonical answers. */
export const zenmuxDialect: DecisionDialect = {
  name: 'zenmux',
  encode({ canonicalModel, state, questions }) {
    validateDecisionQuestions(questions, { requireNoulCriteria: true });
    if (state === undefined) {
      throw new DecisionContractError('A decisions request requires state.');
    }
    const translations: string[] = [];
    const input = typeof state === 'string' ? state : instructionsText(state);

    const encodedQuestions = Object.entries(questions).map(([id, question]) => {
      const record = asRecord(question) as Record<string, unknown>;
      const type = record.type;
      if (type === 'noul') {
        const { yes, no } = noulCriteria(record as unknown as NoulQuestion, id);
        translations.push(`noul->choice(${id})`);
        return {
          name: id,
          type: 'choice',
          instructions: requireInstructions(record as { instructions?: unknown }, id),
          choices: [
            { value: 'true', description: yes },
            { value: 'false', description: no }
          ]
        };
      }
      if (type === 'choice') {
        const options = choiceOptions(record as unknown as ChoiceQuestion, id);
        return {
          name: id,
          type: 'choice',
          instructions: requireInstructions(record as { instructions?: unknown }, id),
          choices: options.map((option) => ({ value: option.name, description: option.description }))
        };
      }
      const criteria = scoreCriteria(record as unknown as ScoreQuestion, id);
      return {
        name: id,
        type: 'score',
        instructions: requireInstructions(record as { instructions?: unknown }, id),
        levels: criteria.map((entry) => ({ label: descriptionText(entry) }))
      };
    });

    return {
      body: { model: canonicalModel, input, questions: encodedQuestions },
      translations
    };
  },
  decode(body, questions, fallbackModel) {
    const record = asRecord(body);
    if (!record) throw new DecisionMalformedResponseError('ZenMux response was not a JSON object.');
    const answers = asRecord(record.answers);
    if (!answers) throw new DecisionMalformedResponseError('ZenMux response contained no answers object.');

    const decoded: Record<string, DecisionAnswer> = {};
    for (const [id, question] of Object.entries(questions)) {
      const answer = asRecord(answers[id]);
      if (!answer) {
        throw new DecisionMalformedResponseError(`ZenMux response omitted an answer for "${id}".`);
      }
      const expected = (question as { type?: string }).type;

      if (expected === 'noul') {
        const probabilities = numericMap(answer.probabilities) || {};
        const yes = probabilities.true ?? probabilities.True ?? probabilities.yes;
        if (yes === undefined) {
          throw new DecisionMalformedResponseError(
            `ZenMux answer for "${id}" had no probability for the "true" choice.`
          );
        }
        decoded[id] = { type: 'noul', noul: yes, translated_from: 'choice' };
        continue;
      }

      if (expected === 'choice') {
        const choice = pickString(answer.choice);
        if (!choice) throw new DecisionMalformedResponseError(`ZenMux answer for "${id}" had no choice.`);
        decoded[id] = {
          type: 'choice',
          choice,
          ...(numericMap(answer.probabilities) ? { probabilities: numericMap(answer.probabilities) } : {}),
          ...(pickNumber(answer.confidence) !== undefined ? { confidence: pickNumber(answer.confidence) } : {})
        };
        continue;
      }

      const criteria = scoreCriteria(question as ScoreQuestion, id);
      const rawScore = pickNumber(answer.score);
      const probabilities = numericMap(answer.probabilities);
      const legendRaw = asRecord(answer.legend);
      const legendKeys = legendRaw ? Object.keys(legendRaw) : probabilities ? Object.keys(probabilities) : [];

      // TypeSafe levels are 0-based. Some deployments echo 1-based keys; shift
      // only when the key set proves it, never by guessing.
      const oneBased = isOneBasedKeys(legendKeys, criteria.length);
      const shift = oneBased ? 1 : 0;

      let score = rawScore;
      if (score === undefined && probabilities) {
        score = Object.entries(probabilities).reduce((sum, [key, probability]) => {
          const index = Number.parseInt(key, 10);
          return Number.isFinite(index) ? sum + index * probability : sum;
        }, 0);
      }
      if (score === undefined) {
        throw new DecisionMalformedResponseError(`ZenMux answer for "${id}" had no score.`);
      }
      score -= shift;

      const probabilitiesOut = probabilities
        ? Object.fromEntries(
            Object.entries(probabilities).map(([key, value]) => {
              const index = Number.parseInt(key, 10);
              return [Number.isFinite(index) ? String(index - shift) : key, value];
            })
          )
        : undefined;

      decoded[id] = {
        type: 'score',
        score,
        ...(probabilitiesOut ? { probabilities: probabilitiesOut } : {}),
        legend: buildScoreLegend(criteria, legendRaw, shift),
        ...(pickNumber(answer.confidence) !== undefined ? { confidence: pickNumber(answer.confidence) } : {})
      };
    }

    return {
      model: pickString(record.model) || fallbackModel,
      answers: decoded,
      usage: pickUsage(record.usage),
      id: pickString(record.id)
    };
  }
};

function isOneBasedKeys(keys: string[], levelCount: number): boolean {
  if (keys.length !== levelCount || levelCount === 0) return false;
  const numbers = keys
    .map((key) => Number.parseInt(key, 10))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (numbers.length !== levelCount) return false;
  return numbers[0] === 1 && numbers[levelCount - 1] === levelCount;
}

function buildScoreLegend(
  criteria: unknown[],
  upstreamLegend: Record<string, unknown> | null,
  shift: number
): Record<string, string> {
  const legend: Record<string, string> = {};
  criteria.forEach((entry, index) => {
    const key = String(index);
    const upstreamKey = String(index + shift);
    const upstream = upstreamLegend ? upstreamLegend[upstreamKey] : undefined;
    legend[key] = descriptionText(upstream !== undefined ? upstream : entry);
  });
  return legend;
}

export const DECISION_DIALECTS: Record<DecisionDialectName, DecisionDialect> = {
  typesafe: typesafeDialect,
  zenmux: zenmuxDialect
};

export function decisionDialect(name: DecisionDialectName): DecisionDialect {
  return DECISION_DIALECTS[name];
}
