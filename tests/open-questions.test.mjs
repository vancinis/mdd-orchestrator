import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openQuestions } from '../dist/open-questions.js';
import { parsePhaseReport, reportFormatLines, MalformedReport } from '../dist/phase-report.js';
import { checkReportForm } from '../dist/report-check.js';
import { nativeQuestionAnswers, UnselectedAnswer } from '../dist/native-intake.js';
import { validateQuestionRecord } from '../dist/question-checkpoint.js';

// Decisions a phase could not make on the user's behalf, reported instead of guessed.
const question = { question: 'Which locale formats dates?', why: 'Every rendered date depends on it.', options: [{ label: 'es-AR', description: 'Day first.', recommended: true }, { label: 'en-US', description: 'Month first.' }], multiple: false, deferrable: true };

const document = (questions, extra = '') => `## MDD Outcome\n\npassed\n\n## MDD Summary\n\nExplored the date rendering.\n\n## MDD Artifact\n\nFindings.\n${extra}${
  questions === undefined ? '' : `\n## MDD Questions\n\n\`\`\`json\n${JSON.stringify(questions)}\n\`\`\`\n`}`;

test('open questions are optional, normalized, and keep only true flags', () => {
  assert.deepEqual(openQuestions(undefined), []);
  assert.deepEqual(openQuestions([]), []);
  assert.deepEqual(openQuestions([question]), [{ question: question.question, why: question.why,
    options: [{ label: 'es-AR', description: 'Day first.', recommended: true }, { label: 'en-US', description: 'Month first.' }], deferrable: true }]);
  // No options is an open-ended question the user answers in their own words.
  assert.deepEqual(openQuestions([{ question: 'What is the API base URL?', why: 'Every request needs it.' }]),
    [{ question: 'What is the API base URL?', why: 'Every request needs it.', options: [] }]);
});

test('open questions refuse what the coordinator could not ask faithfully', () => {
  for (const bad of [
    'not an array', [{ ...question, why: '' }], [{ ...question, question: '  ' }], [{ question: 'Q?' }],
    [{ ...question, options: Array(7).fill(question.options[1]) }], [{ ...question, options: [question.options[1], question.options[1]] }],
    [{ ...question, multiple: 'yes' }], [{ ...question, extra: true }], Array(9).fill(question),
  ]) assert.throws(() => openQuestions(bad), undefined, JSON.stringify(bad).slice(0, 80));
});

test('a phase report carries open questions under their own heading', () => {
  assert.deepEqual(parsePhaseReport(document([question]), 'mdd-explore').questions, [question]);
  assert.equal(parsePhaseReport(document(undefined), 'mdd-explore').questions, undefined);
  assert.equal(parsePhaseReport(document(undefined, '\n## MDD Open Questions\n\n```json\n[]\n```\n'), 'mdd-explore').questions.length, 0);
  assert.throws(() => parsePhaseReport(`${document(undefined)}\n## MDD Questions\n\nnot json\n`, 'mdd-explore'), MalformedReport);
  for (const phase of ['mdd-explore', 'mdd-plan', 'mdd-apply']) assert.match(reportFormatLines(phase).join('\n'), /Optional "## MDD Questions".*only the user can make/s);
});

test('the report check names malformed questions before the report is returned', () => {
  assert.equal(checkReportForm('mdd-explore', document([question])).ok, true);
  const checked = checkReportForm('mdd-explore', document([{ ...question, why: '' }]));
  assert.equal(checked.ok, false);
  assert.match(checked.problems.join(' '), /open question 1 why/);
});

test('a clarification may be left empty, answered in the user\'s words or with several choices; a token question may not', () => {
  const args = { questions: [
    { header: 'Modo', question: 'Mode?', multiple: false, options: [{ label: 'A', description: 'a' }] },
    { header: 'Navegadores', question: 'Browsers?', multiple: true, options: [{ label: 'Chrome', description: 'c' }, { label: 'Safari', description: 's' }] },
    { header: 'Detalle', question: 'Copy?', multiple: false, options: [{ label: 'Short', description: 's' }] },
  ] };
  const output = selections => ({ title: 'Asked 3 questions', metadata: { answers: selections, truncated: false },
    output: `User has answered your questions: ${args.questions.map((q, i) => `"${q.question}"="${selections[i].length ? selections[i].join(', ') : 'Unanswered'}"`).join(', ')}. You can now continue with the user's answers in mind.` });
  assert.deepEqual(nativeQuestionAnswers(args, output([['A'], ['Chrome', 'Edge'], []]), 1), [['A'], ['Chrome', 'Edge'], []]);
  assert.throws(() => nativeQuestionAnswers(args, output([['A'], ['Chrome'], ['Short', 'Long']]), 1), /Invalid native question answer label/);
  assert.throws(() => nativeQuestionAnswers(args, output([['own words'], ['Chrome'], []]), 1), UnselectedAnswer);
  assert.throws(() => nativeQuestionAnswers(args, output([[], ['Chrome'], []]), 1), /Invalid native question answer label/);
  // Without a boundary every question is a token question, exactly as before.
  assert.throws(() => nativeQuestionAnswers(args, output([['A'], ['Chrome', 'Safari'], ['Short']])), /Invalid native question answer label/);
});

test('a durable record keeps preflight fields strict and its clarifications open', () => {
  const field = { header: 'Modo', question: 'Mode?', multiple: false, options: [{ label: 'Automático', description: 'a' }, { label: 'Interactivo', description: 'i' }] };
  const note = { header: 'Notas', question: '¿Algo más?', multiple: false, options: [{ label: 'Nada que agregar', description: 'n' }] };
  const doubt = { header: 'Pantalla', question: '¿Dónde?', multiple: true, options: [{ label: 'Dashboard', description: 'd' }, { label: 'Que decida el agente', description: 'x' }] };
  const record = { version: 1, parent: 'parent', sequence: 1, requirements: 'Do it.', known: {}, state: 'answered', callID: 'call',
    slot: { kind: 'preflight', fields: 1, args: { questions: [field, doubt, note] } },
    clarifications: [{ question: '¿Dónde?', header: 'Pantalla', why: 'No lo dice.', options: [{ label: 'Dashboard', description: 'd', recommended: false }], multiple: true, deferrable: false },
      { question: '¿Algo más?', header: 'Notas', options: [{ label: 'Nada que agregar', description: 'n', recommended: false }], deferrable: false, note: true }],
    deferred: [], clarificationAnswers: [], answer: [['Automático'], ['Dashboard', 'También pedidos'], ['No tocar el backend']] };
  assert.doesNotThrow(() => validateQuestionRecord(record));
  assert.throws(() => validateQuestionRecord({ ...record, answer: [['own words'], ['Dashboard'], []] }), /Invalid native answer/);
  assert.throws(() => validateQuestionRecord({ ...record, answer: [['Automático'], ['Dashboard'], ['a', 'b']] }), /Invalid native answer/);
  assert.throws(() => validateQuestionRecord({ ...record, slot: { ...record.slot, fields: 4 } }), /field count/);
  assert.throws(() => validateQuestionRecord({ ...record, slot: { ...record.slot, args: { questions: [{ ...field, multiple: true }, doubt, note] } } }), /Invalid native question/);
  // Only a preflight declares leading field questions.
  assert.throws(() => validateQuestionRecord({ ...record, slot: { kind: 'clarification', phase: 'mdd-plan', fields: 0, args: record.slot.args }, runID: 'run' }));
});
