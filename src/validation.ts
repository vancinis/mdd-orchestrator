import type { Answers } from './policy.js';

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

// 'complexity' is accepted for backward compatibility with saved profiles and existing kernel
// callers, but it is never read: mdd-risk, not this legacy field, now judges complexity.
export function parseAnswers(value: unknown): Answers {
  const answers = objectWithKeys(value, 'answers', ['certainty', 'artifactStore', 'mode', 'summary', 'complexity']);
  return {
    certainty: option(answers.certainty, 'answers.certainty', ['very-sure', 'somewhat-sure', 'not-sure']),
    artifactStore: option(answers.artifactStore, 'answers.artifactStore', ['engram', 'openspec', 'both', 'none', 'local']),
    mode: option(answers.mode, 'answers.mode', ['interactive', 'automatic']),
    summary: option(answers.summary, 'answers.summary', ['detailed', 'medium', 'low']),
  };
}
