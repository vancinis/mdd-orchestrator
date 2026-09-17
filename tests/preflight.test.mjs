import assert from 'node:assert/strict';
import test from 'node:test';
import { ANSWER_FIELDS, questionEnvelope, answersFromLabels, resolvePreflight, parsePartialAnswers, answerFromLabel } from '../dist/preflight.js';
import { evaluate } from '../dist/kernel.js';
import { Workflow } from '../dist/workflow.js';

const answers = { certainty: 'very-sure', artifactStore: 'none', mode: 'interactive', summary: 'low', complexity: 'not-complex' };
const labels = [['Very sure'], ['None'], ['Interactive'], ['Low'], ['Not complex']];

test('native envelope uses only supported question and option fields in original order', () => {
  const envelope = questionEnvelope();
  assert.deepEqual(Object.keys(envelope), ['questions']);
  assert.deepEqual(envelope.questions.map(q => q.header), ['Certainty', 'Artifacts', 'Mode', 'Summary', 'Complexity']);
  for (const question of envelope.questions) {
    assert.deepEqual(Object.keys(question).sort(), ['header', 'multiple', 'options', 'question']);
    assert.equal(question.multiple, false);
    assert.ok(question.question.length > 0);
    for (const option of question.options) assert.deepEqual(Object.keys(option).sort(), ['description', 'label']);
  }
  envelope.questions[0].options[0].label = 'changed';
  assert.equal(questionEnvelope().questions[0].options[0].label, 'Very sure');
});

test('every partial subset asks all and only missing fields together, preserving order and kernel evaluation', () => {
  for (let mask = 0; mask < 32; mask++) {
    const known = Object.fromEntries(ANSWER_FIELDS.filter((_, i) => mask & (1 << i)).map(field => [field, answers[field]]));
    const missing = labels.filter((_, i) => !(mask & (1 << i)));
    const envelope = questionEnvelope(known);
    assert.equal(envelope.questions.length, missing.length);
    assert.deepEqual(envelope.questions, questionEnvelope().questions.filter((_, i) => !(mask & (1 << i))));
    assert.deepEqual(answersFromLabels(known, missing), answers);
    assert.deepEqual(resolvePreflight(known, missing).evaluation, evaluate({ answers }));
    assert.deepEqual(known, Object.fromEntries(ANSWER_FIELDS.filter((_, i) => mask & (1 << i)).map(field => [field, answers[field]])));
  }
});

test('complete profile skips questions; submission makes first phase ready even interactively', () => {
  assert.deepEqual(questionEnvelope(answers), { questions: [] });
  const resolved = resolvePreflight(answers, []);
  const workflow = new Workflow({ answers: resolved.answers });
  assert.deepEqual(workflow.nextAction(), { kind: 'execute', phase: 'mdd-plan' });
  workflow.start('mdd-plan');
  workflow.recordResult({ phase: 'mdd-plan', outcome: 'passed', evidenceSummary: 'Fixture plan' });
  assert.deepEqual(workflow.nextAction(), { kind: 'approve', phase: 'mdd-apply' });
});

for (const selected of [undefined, null, {}, [], labels.slice(1), [...labels, ['Low']], labels.map(x => x[0]),
  [['very-sure'], ...labels.slice(1)], [['Very sure', 'Not sure'], ...labels.slice(1)],
  [['None'], ['Very sure'], ...labels.slice(2)], [[' Very sure'], ...labels.slice(1)]]) {
  test(`reject ordered label ambiguity/missing data ${JSON.stringify(selected)}`, () => assert.throws(() => answersFromLabels({}, selected)));
}

test('partial validation rejects unknown, invalid, prototype and undefined values without defaults', () => {
  assert.deepEqual(parsePartialAnswers({}), {});
  for (const input of [{ certainty: undefined }, { other: 'x' }, { mode: 'auto' }, [], null, Object.create({ mode: 'automatic' })]) {
    assert.throws(() => parsePartialAnswers(input));
  }
  assert.throws(() => answerFromLabel('__proto__', 'x'));
  assert.throws(() => answersFromLabels(answers, labels));
});
