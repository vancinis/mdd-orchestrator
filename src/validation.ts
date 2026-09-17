import { getDefaultConfig } from './policy.js';
import type { Answers, Config } from './policy.js';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function objectWithKeys(
  value: unknown,
  path: string,
  allowed: readonly string[],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`${path} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ValidationError(`${path} must be a plain object.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) {
      throw new ValidationError(`${path}.${String(key)} is unknown. Allowed keys: ${allowed.join(', ')}.`);
    }
  }
  return value as Record<string, unknown>;
}

function option<Value extends string>(value: unknown, path: string, options: readonly Value[]): Value {
  if (typeof value !== 'string' || !options.includes(value as Value)) {
    throw new ValidationError(`${path} must be one of: ${options.join(', ')}. Supply a complete answer set.`);
  }
  return value as Value;
}

function points(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError(`${path} must be a nonnegative safe integer (0..${Number.MAX_SAFE_INTEGER}).`);
  }
  return value;
}

export function parseAnswers(value: unknown): Answers {
  const answers = objectWithKeys(value, 'answers', ['certainty', 'artifactStore', 'mode', 'summary', 'complexity']);
  return {
    certainty: option(answers.certainty, 'answers.certainty', ['very-sure', 'somewhat-sure', 'not-sure']),
    artifactStore: option(answers.artifactStore, 'answers.artifactStore', ['engram', 'openspec', 'both', 'none']),
    mode: option(answers.mode, 'answers.mode', ['interactive', 'automatic']),
    summary: option(answers.summary, 'answers.summary', ['detailed', 'medium', 'low']),
    complexity: option(answers.complexity, 'answers.complexity', ['very-complex', 'somewhat-complex', 'not-complex']),
  };
}

function weightOverrides<Key extends string>(
  value: unknown,
  defaults: Record<Key, number>,
  path: string,
): Record<Key, number> {
  const overrides = objectWithKeys(value, path, Object.keys(defaults));
  const result = { ...defaults };
  for (const key of Object.keys(overrides) as Key[]) {
    result[key] = points(overrides[key], `${path}.${key}`);
  }
  return result;
}

export function parseConfig(value: unknown): Config {
  const input = objectWithKeys(value, 'config', ['threshold', 'weights']);
  const config = getDefaultConfig();
  if (Object.hasOwn(input, 'threshold')) config.threshold = points(input.threshold, 'config.threshold');
  if (Object.hasOwn(input, 'weights')) {
    const weights = objectWithKeys(input.weights, 'config.weights', Object.keys(config.weights));
    if (Object.hasOwn(weights, 'certainty')) {
      config.weights.certainty = weightOverrides(weights.certainty, config.weights.certainty, 'config.weights.certainty');
    }
    if (Object.hasOwn(weights, 'mode')) {
      config.weights.mode = weightOverrides(weights.mode, config.weights.mode, 'config.weights.mode');
    }
    if (Object.hasOwn(weights, 'summary')) {
      config.weights.summary = weightOverrides(weights.summary, config.weights.summary, 'config.weights.summary');
    }
    if (Object.hasOwn(weights, 'complexity')) {
      config.weights.complexity = weightOverrides(weights.complexity, config.weights.complexity, 'config.weights.complexity');
    }
  }
  let maximum = 0;
  for (const values of Object.values(config.weights)) {
    const largest = Math.max(...Object.values(values));
    if (largest > Number.MAX_SAFE_INTEGER - maximum) {
      throw new ValidationError('config.weights maximum possible score exceeds Number.MAX_SAFE_INTEGER. Reduce weights.');
    }
    maximum += largest;
  }
  return config;
}
