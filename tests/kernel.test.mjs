import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate } from '../dist/kernel.js';
import { POLICY_VERSION } from '../dist/policy.js';
import { ValidationError } from '../dist/validation.js';

const clear = {
  certainty: 'very-sure',
  artifactStore: 'none',
  mode: 'automatic',
  summary: 'low',
};
/**
 * Every run always starts with exactly one exploration phase, and nothing in the preflight is
 * scored: only a validated mdd-risk verdict selects a route, through Workflow.recordRiskResult.
 */
const explorePhases = ['mdd-explore'];
const run = (answers = clear, rest = {}) => evaluate({ answers, ...rest });
const choices = {
  certainty: ['very-sure', 'somewhat-sure', 'not-sure'],
  artifactStore: ['engram', 'openspec', 'both', 'none'],
  mode: ['interactive', 'automatic'],
  summary: ['detailed', 'medium', 'low'],
};

test('evaluation starts with exploration, names no route and scores nothing', () => {
  const result = run();
  assert.equal(result.policyVersion, POLICY_VERSION);
  assert.equal(POLICY_VERSION, 'mdd-routing-v2');
  assert.deepEqual(result.phases, explorePhases);
  assert.equal('route' in result, false, 'no route exists before mdd-risk selects one');
  for (const removed of ['score', 'threshold', 'contributions', 'confidence', 'timestamp']) assert.equal(removed in result, false, removed);
  assert.deepEqual(result.reasons, [
    'Every run always starts with exactly one exploration phase before any routing decision.',
    'A validated mdd-risk verdict selects the low or high continuation; the preflight answers are not scored.',
  ]);
});

// No answer moves anything: the evaluation of every valid answer set is the same one.
test('every one of the 72 answer combinations yields the identical evaluation', () => {
  let count = 0;
  for (const certainty of choices.certainty) for (const artifactStore of choices.artifactStore)
    for (const mode of choices.mode) for (const summary of choices.summary) {
      assert.deepEqual(run({ certainty, artifactStore, mode, summary }), run());
      count++;
    }
  assert.equal(count, 72);
});

test('the removed scoring configuration is refused, never silently ignored', () => {
  for (const config of [{}, { threshold: 50 }, { weights: { certainty: { 'very-sure': 40 } } }, { weights: { summary: { low: 7 } } }, null]) {
    assert.throws(() => run(clear, { config }), /request\.config is no longer accepted: preflight answers are not scored/);
    assert.throws(() => evaluate({ profile: { answers: clear }, config }), ValidationError);
  }
});

test('legacy explore flag and complexity are accepted but change nothing', () => {
  assert.deepEqual(run(clear, { explore: true }), run());
  assert.deepEqual(run(clear, { explore: false }), run());
  assert.deepEqual(run({ ...clear, complexity: 'very-complex' }), run());
});

test('complete profiles use identical validation and yield identical results', () => {
  assert.deepEqual(evaluate({ profile: { answers: clear }, explore: true }), run(clear, { explore: true }));
  assert.throws(() => evaluate({ profile: { answers: { certainty: 'very-sure' } } }), /answers.artifactStore/);
  assert.throws(() => evaluate({ profile: { answers: { ...clear, mode: 'invalid' } } }), /answers.mode/);
  assert.throws(() => evaluate({ profile: {} }), /profile.answers/);
  assert.throws(() => evaluate({ profile: { answers: clear, models: {} } }), /profile.models/);
});

test('repeated evaluation is deterministic and does not mutate input or share results', () => {
  const request = { answers: { ...clear } };
  const original = structuredClone(request);
  const expected = evaluate(request);
  for (let iteration = 0; iteration < 10; iteration++) assert.deepEqual(evaluate(request), expected);
  assert.deepEqual(request, original);
  const changed = run();
  changed.phases.push('mdd-apply');
  changed.reasons.length = 0;
  assert.deepEqual(run().phases, explorePhases);
  assert.equal(run().reasons.length, 2);
});

test('missing and unknown answer fields fail actionably', () => {
  for (const field of Object.keys(clear)) {
    const answers = { ...clear };
    delete answers[field];
    assert.throws(() => run(answers), new RegExp(`answers.${field}`));
    assert.throws(() => run({ ...clear, [field]: 'unknown' }), /must be one of/);
    assert.throws(() => run({ ...clear, [field]: null }), /must be one of/);
  }
  assert.throws(() => run({ ...clear, extra: true }), /answers.extra is unknown/);
});

test('invalid structures and ambiguous sources fail rather than selecting defaults', () => {
  for (const value of [undefined, null, [], 'text', 1, true]) {
    assert.throws(() => evaluate(value), ValidationError);
    assert.throws(() => evaluate({ answers: value }), ValidationError);
    assert.throws(() => evaluate({ profile: value }), ValidationError);
  }
  for (const request of [
    {}, { answers: clear, profile: { answers: clear } },
    { answers: clear, unknown: true }, { answers: clear, explore: 'true' },
    { answers: clear, explore: undefined }, { answers: clear, explore: null },
  ]) assert.throws(() => evaluate(request), ValidationError);
  assert.throws(() => run(new Date()), ValidationError);
  assert.throws(() => run({ ...clear, [Symbol('extra')]: true }), ValidationError);
});
