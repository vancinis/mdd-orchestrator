import assert from 'node:assert/strict';
import test from 'node:test';
import { ANSWER_FIELDS, questionEnvelope, answersFromLabels, resolvePreflight, parsePartialAnswers, answerFromLabel } from '../dist/preflight.js';
import { evaluate } from '../dist/kernel.js';
import { Workflow } from '../dist/workflow.js';

const answers = { certainty: 'very-sure', artifactStore: 'none', mode: 'interactive', summary: 'low' };
const labels = [['Muy seguro'], ['Ninguno'], ['Interactivo'], ['Bajo']];

test('native envelope uses only supported question and option fields in original order', () => {
  const envelope = questionEnvelope();
  assert.deepEqual(Object.keys(envelope), ['questions']);
  assert.deepEqual(envelope.questions.map(q => q.header), ['Certeza', 'Artefactos', 'Modo', 'Resumen']);
  for (const question of envelope.questions) {
    assert.deepEqual(Object.keys(question).sort(), ['header', 'multiple', 'options', 'question']);
    assert.equal(question.multiple, false);
    assert.ok(question.question.length > 0);
    for (const option of question.options) assert.deepEqual(Object.keys(option).sort(), ['description', 'label']);
  }
  envelope.questions[0].options[0].label = 'changed';
  assert.equal(questionEnvelope().questions[0].options[0].label, 'Muy seguro');
});

test('every partial subset asks all and only missing fields together, preserving order and kernel evaluation', () => {
  for (let mask = 0; mask < 16; mask++) {
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

test('complete profile skips questions; submission always makes exploration ready first, even interactively', () => {
  assert.deepEqual(questionEnvelope(answers), { questions: [] });
  const resolved = resolvePreflight(answers, []);
  const workflow = new Workflow({ answers: resolved.answers });
  assert.deepEqual(workflow.nextAction(), { kind: 'execute', phase: 'mdd-explore' });
  workflow.start('mdd-explore');
  workflow.recordResult({ phase: 'mdd-explore', outcome: 'passed', evidenceSummary: 'Fixture exploration' });
  // No preflight score selects a route; only a validated mdd-risk verdict does.
  assert.deepEqual(workflow.nextAction(), { kind: 'execute-risk' });
  workflow.startRisk();
  workflow.recordRiskResult({ outcome: 'passed', evidenceSummary: 'Fixture risk', route: 'low' });
  assert.deepEqual(workflow.nextAction(), { kind: 'approve', phase: 'mdd-plan' });
});

for (const selected of [undefined, null, {}, [], labels.slice(1), [...labels, ['Low']], labels.map(x => x[0]),
  [['very-sure'], ...labels.slice(1)], [['Muy seguro', 'Poco seguro'], ...labels.slice(1)],
  [['Ninguno'], ['Muy seguro'], ...labels.slice(2)], [[' Muy seguro'], ...labels.slice(1)]]) {
  test(`reject ordered label ambiguity/missing data ${JSON.stringify(selected)}`, () => assert.throws(() => answersFromLabels({}, selected)));
}

test('legacy complexity answer is accepted but ignored, never asked and never scored', () => {
  assert.deepEqual(parsePartialAnswers({ complexity: 'very-complex' }), {});
  assert.deepEqual(parsePartialAnswers({ ...answers, complexity: 'very-complex' }), answers);
  assert.deepEqual(questionEnvelope({ complexity: 'very-complex' }).questions.map(q => q.header),
    ['Certeza', 'Artefactos', 'Modo', 'Resumen']);
  assert.deepEqual(resolvePreflight({ complexity: 'very-complex' }, labels).evaluation, evaluate({ answers }));
});

test('partial validation rejects unknown, invalid, prototype and undefined values without defaults', () => {
  assert.deepEqual(parsePartialAnswers({}), {});
  for (const input of [{ certainty: undefined }, { other: 'x' }, { mode: 'auto' }, [], null, Object.create({ mode: 'automatic' })]) {
    assert.throws(() => parsePartialAnswers(input));
  }
  assert.throws(() => answerFromLabel('__proto__', 'x'));
  assert.throws(() => answersFromLabels(answers, labels));
});
