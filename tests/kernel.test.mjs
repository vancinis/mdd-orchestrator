import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate } from '../dist/kernel.js';
import { getDefaultConfig, POLICY_VERSION } from '../dist/policy.js';
import { ValidationError } from '../dist/validation.js';

const clear = {
  certainty: 'very-sure',
  artifactStore: 'none',
  mode: 'automatic',
  summary: 'low',
  complexity: 'not-complex',
};
const lowPhases = ['mdd-plan', 'mdd-apply', 'mdd-verify'];
const highPhases = [
  'mdd-explore', 'mdd-propose', 'mdd-spec', 'mdd-design',
  'mdd-tasks', 'mdd-apply', 'mdd-verify',
];
const run = (answers = clear, rest = {}) => evaluate({ answers, ...rest });

test('default policy produces the minimum low route and explanations', () => {
  const result = run();
  assert.equal(result.score, 20);
  assert.equal(result.threshold, 50);
  assert.equal(result.route, 'low');
  assert.equal(result.policyVersion, POLICY_VERSION);
  assert.deepEqual(result.phases, lowPhases);
  assert.deepEqual(result.contributions, [
    { field: 'certainty', answer: 'very-sure', points: 10 },
    { field: 'mode', answer: 'automatic', points: 5 },
    { field: 'summary', answer: 'low', points: 5 },
    { field: 'complexity', answer: 'not-complex', points: 0 },
  ]);
  assert.ok(result.reasons.includes('Score 20 < threshold 50: low route.'));
  assert.ok(result.reasons.includes('Artifact storage is unscored.'));
  assert.equal('confidence' in result, false);
  assert.equal('timestamp' in result, false);
});

const weightCases = {
  certainty: { 'very-sure': 10, 'somewhat-sure': 15, 'not-sure': 25 },
  mode: { interactive: 15, automatic: 5 },
  summary: { detailed: 25, medium: 10, low: 5 },
  complexity: { 'very-complex': 25, 'somewhat-complex': 10, 'not-complex': 0 },
};
for (const [field, values] of Object.entries(weightCases)) {
  for (const [answer, points] of Object.entries(values)) {
    test(`default contribution: ${field}=${answer} is ${points}`, () => {
      const result = run({ ...clear, [field]: answer });
      assert.equal(result.contributions.find((entry) => entry.field === field).points, points);
      assert.equal(result.score, 20 - weightCases[field][clear[field]] + points);
    });
  }
}

test('all 54 scored combinations stay within 20..90 and obey exact phase rules', () => {
  const scores = [];
  for (const certainty of Object.keys(weightCases.certainty)) {
    for (const mode of Object.keys(weightCases.mode)) {
      for (const summary of Object.keys(weightCases.summary)) {
        for (const complexity of Object.keys(weightCases.complexity)) {
          const answers = { ...clear, certainty, mode, summary, complexity };
          const result = run(answers);
          scores.push(result.score);
          assert.equal(result.route, result.score >= 50 ? 'high' : 'low');
          const explore = certainty !== 'very-sure' || complexity !== 'not-complex';
          assert.deepEqual(result.phases, result.route === 'high'
            ? highPhases : [...(explore ? ['mdd-explore'] : []), ...lowPhases]);
        }
      }
    }
  }
  assert.equal(scores.length, 54);
  assert.equal(Math.min(...scores), 20);
  assert.equal(Math.max(...scores), 90);
});

for (const artifactStore of ['engram', 'openspec', 'both', 'none']) {
  test(`artifact store ${artifactStore} is completely unscored`, () => {
    assert.deepEqual(run({ ...clear, artifactStore }), run());
  });
}

for (const [points, route] of [[49, 'low'], [50, 'high'], [51, 'high']]) {
  test(`threshold boundary: score ${points} routes ${route}`, () => {
    const result = run(clear, { config: { weights: { certainty: { 'very-sure': points - 10 } } } });
    assert.equal(result.score, points);
    assert.equal(result.route, route);
  });
}

test('threshold override and zero weights are applied rather than replaced by defaults', () => {
  assert.equal(run(clear, { config: { threshold: 20 } }).route, 'high');
  assert.equal(run(clear, { config: { threshold: 21 } }).route, 'low');
  const config = getDefaultConfig();
  for (const values of Object.values(config.weights)) {
    for (const option of Object.keys(values)) values[option] = 0;
  }
  config.threshold = 0;
  const result = run(clear, { config });
  assert.equal(result.score, 0);
  assert.equal(result.route, 'high');
});

for (const [field, answer] of [
  ['certainty', 'somewhat-sure'], ['certainty', 'not-sure'],
  ['complexity', 'somewhat-complex'], ['complexity', 'very-complex'],
]) {
  test(`low route requires exploration for ${field}=${answer}`, () => {
    const result = run({ ...clear, [field]: answer }, { config: { threshold: 100 }, explore: false });
    assert.deepEqual(result.phases, ['mdd-explore', ...lowPhases]);
    assert.ok(result.reasons.some((reason) => reason.includes(`${field} is ${answer}`)));
  });
}

test('explicit exploration is optional only on otherwise clear low work; high never duplicates it', () => {
  assert.deepEqual(run(clear, { explore: true }).phases, ['mdd-explore', ...lowPhases]);
  assert.deepEqual(run(clear, { explore: false }).phases, lowPhases);
  const result = run(clear, { config: { threshold: 0 }, explore: true });
  assert.deepEqual(result.phases, highPhases);
  assert.equal(result.phases.filter((phase) => phase === 'mdd-explore').length, 1);
});

test('complete profiles use identical validation and yield identical results', () => {
  const options = { config: { threshold: 25 }, explore: true };
  assert.deepEqual(evaluate({ profile: { answers: clear }, ...options }), run(clear, options));
  assert.throws(() => evaluate({ profile: { answers: { certainty: 'very-sure' } } }), /answers.artifactStore/);
  assert.throws(() => evaluate({ profile: { answers: { ...clear, mode: 'invalid' } } }), /answers.mode/);
  assert.throws(() => evaluate({ profile: {} }), /profile.answers/);
  assert.throws(() => evaluate({ profile: { answers: clear, models: {} } }), /profile.models/);
});

test('repeated evaluation is deterministic and does not mutate input or share defaults/results', () => {
  const request = { answers: { ...clear }, config: { weights: { summary: { low: 7 } } } };
  const original = structuredClone(request);
  const expected = evaluate(request);
  for (let iteration = 0; iteration < 10; iteration++) assert.deepEqual(evaluate(request), expected);
  assert.deepEqual(request, original);
  const defaults = getDefaultConfig();
  defaults.weights.certainty['very-sure'] = 999;
  defaults.threshold = 999;
  const changed = run();
  changed.phases.push('mdd-explore');
  changed.contributions[0].points = 999;
  changed.reasons.length = 0;
  assert.equal(run().score, 20);
  assert.equal(getDefaultConfig().threshold, 50);
  assert.deepEqual(run().phases, lowPhases);
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
    assert.throws(() => run(clear, { config: value }), ValidationError);
  }
  for (const request of [
    {}, { answers: clear, profile: { answers: clear } },
    { answers: clear, unknown: true }, { answers: clear, explore: 'true' },
    { answers: clear, explore: undefined }, { answers: clear, explore: null },
  ]) assert.throws(() => evaluate(request), ValidationError);
  assert.throws(() => run(new Date()), ValidationError);
  assert.throws(() => run({ ...clear, [Symbol('extra')]: true }), ValidationError);
});

test('unknown and malformed configuration entries cannot be silently merged', () => {
  for (const config of [
    { unknown: 1 }, { weights: null }, { weights: [] }, { weights: undefined },
    { weights: { artifactStore: { none: 100 } } },
    { weights: { mode: null } }, { weights: { mode: [] } },
    { weights: { mode: 5 } }, { weights: { mode: { invalid: 5 } } },
    { weights: { mode: { automatic: undefined } } }, { threshold: undefined },
  ]) assert.throws(() => run(clear, { config }), ValidationError);
});

for (const value of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '50', null, true]) {
  test(`invalid numeric value ${String(value)} is rejected for weights and threshold`, () => {
    assert.throws(() => run(clear, { config: { threshold: value } }), /nonnegative safe integer/);
    assert.throws(() => run(clear, { config: { weights: { mode: { automatic: value } } } }), /nonnegative safe integer/);
  });
}

test('maximum possible sum is checked even when selected answers would score safely', () => {
  assert.throws(() => run(clear, {
    config: { weights: { certainty: { 'not-sure': Number.MAX_SAFE_INTEGER } } },
  }), /maximum possible score/);
  const config = getDefaultConfig();
  for (const values of Object.values(config.weights)) {
    for (const option of Object.keys(values)) values[option] = 0;
  }
  config.weights.certainty['very-sure'] = Number.MAX_SAFE_INTEGER;
  config.threshold = Number.MAX_SAFE_INTEGER;
  const result = run(clear, { config });
  assert.equal(result.score, Number.MAX_SAFE_INTEGER);
  assert.equal(result.route, 'high');
});
