import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerWords, mentions, typedSelections } from '../dist/typed-answer.js';
import { questionEnvelope } from '../dist/preflight.js';
import { approvalEnvelope, CLARIFICATION_LABELS } from '../dist/native-intake.js';

// The grouped preflight as MDD issues it: four field questions, then the open note.
const note = { header: 'Notas', question: '¿Algo más?', multiple: false, options: [{ label: CLARIFICATION_LABELS.nothing, description: 'Seguir.' }] };
const preflight = { questions: [...questionEnvelope({}).questions, note] };
const chat = text => () => ({ text, own: false });
const read = (...labels) => labels.map(label => ({ labels: label === undefined ? [] : [label] }));

// The message that could not be recorded on 2026-10-08 and forced a fresh start.
test('the user\'s own numbered answers to a preflight are read exactly as the form would carry them', () => {
  const text = '1. algo seguro 2. engram 3. automatico 4. medio 5. nada que agregar.';
  assert.deepEqual(typedSelections(preflight, 4, read('Algo seguro', 'Engram', 'Automático', 'Medio', 'Nada que agregar'), chat(text)),
    [['Algo seguro'], ['Engram'], ['Automático'], ['Medio'], ['Nada que agregar']]);
});

test('case, accents and punctuation are ignored; the words themselves are not', () => {
  assert.equal(answerWords('  ¡AUTOMÁTICO!, por favor '), 'automatico por favor');
  assert.ok(mentions('Modo: AUTOMÁTICO.', 'Automático'));
  assert.ok(mentions('modo automatico', 'Automático'));
  // Whole words only: "medio" is not written inside "intermedio".
  assert.equal(mentions('un nivel intermedio', 'Medio'), false);
  assert.throws(() => typedSelections(preflight, 4, read('Muy seguro', 'Ninguno', 'Interactivo', 'Medio', undefined),
    chat('muy seguro, ninguno, interactivo, intermedio')), /did not write "Medio"/);
});

test('an option the user did not write is never recorded, whatever the coordinator read', () => {
  assert.throws(() => typedSelections(approvalEnvelope('run-1', 'mdd-plan'), 1, read('Continuar'), chat('sí, dale')), /did not write "Continuar"/);
  assert.deepEqual(typedSelections(approvalEnvelope('run-1', 'mdd-plan'), 1, read('Continuar'), chat('Continuar, por favor')), [['Continuar']]);
});

test('words that also name another option of the same question are ambiguous, so nothing is recorded', () => {
  const text = '1. muy seguro 2. no quiero engram, mejor openspec 3. interactivo 4. bajo';
  assert.throws(() => typedSelections(preflight, 4, read('Muy seguro', 'OpenSpec', 'Interactivo', 'Bajo', undefined), chat(text)), /also name "Engram"/);
  assert.throws(() => typedSelections(approvalEnvelope('run-1', 'mdd-plan'), 1, read('Continuar'), chat('pausar no, continuar')), /also name "Pausar"/);
});

test('a quote narrows what answers each question when options repeat across questions', () => {
  const clarify = label => ({ header: label, question: `¿${label}?`, multiple: false, options: [
    { label: 'ISO', description: 'ISO.' }, { label: CLARIFICATION_LABELS.delegate, description: 'Delegar.' }] });
  const args = { questions: [clarify('Fecha'), clarify('Hora')] };
  const text = '1. ISO 2. que decida el agente';
  // Read against the whole message, the first answer also names the delegation offered to it.
  assert.throws(() => typedSelections(args, 0, [{ labels: ['ISO'] }, { labels: [CLARIFICATION_LABELS.delegate] }], chat(text)), /Quote only the part/);
  assert.deepEqual(typedSelections(args, 0, [{ labels: ['ISO'], quote: '1. ISO' }, { labels: [CLARIFICATION_LABELS.delegate], quote: 'que decida el agente' }], chat(text)),
    [['ISO'], [CLARIFICATION_LABELS.delegate]]);
  assert.throws(() => typedSelections(args, 0, [{ labels: ['ISO'], quote: 'ISO 8601' }, { labels: [] }], chat(text)), /quote is not part/);
});

test('an option inside a longer chosen one is not a second answer', () => {
  const args = { questions: [{ header: 'API', question: '¿Qué API?', multiple: false, options: [
    { label: 'API', description: 'Cualquiera.' }, { label: 'API REST', description: 'REST.' }] }] };
  assert.deepEqual(typedSelections(args, 0, [{ labels: ['API REST'] }], chat('prefiero API REST')), [['API REST']]);
  assert.throws(() => typedSelections(args, 0, [{ labels: ['API'] }], chat('prefiero API REST')), /also name "API REST"/);
});

test('recommended options are matched without the suffix nobody types', () => {
  const args = { questions: [{ header: 'Formato', question: '¿Formato?', multiple: false, options: [
    { label: 'ISO (Recomendada)', description: 'ISO.' }, { label: 'Local', description: 'Local.' }] }] };
  assert.deepEqual(typedSelections(args, 0, [{ labels: ['ISO (Recomendada)'] }], chat('iso')), [['ISO (Recomendada)']]);
});

test('open questions take the user\'s own words, several choices, or nothing', () => {
  const open = { header: 'Detalle', question: '¿Algo más?', multiple: true, options: [
    { label: 'Chrome', description: 'Chrome.' }, { label: 'Firefox', description: 'Firefox.' }] };
  const args = { questions: [open] };
  assert.deepEqual(typedSelections(args, 0, [{ labels: [], quote: 'que funcione offline' }], chat('Y que funcione offline.')), [['que funcione offline']]);
  assert.deepEqual(typedSelections(args, 0, [{ labels: ['Chrome', 'Firefox'] }], chat('chrome y firefox')), [['Chrome', 'Firefox']]);
  assert.deepEqual(typedSelections(args, 0, [{ labels: [] }], chat('nada más')), [[]], 'without a quote, a chat message is not read as an open answer');
  // Typed into the question's own box, the text is the answer to that question.
  assert.deepEqual(typedSelections(args, 0, [{ labels: [] }], () => ({ text: 'que funcione offline', own: true })), [['que funcione offline']]);
  assert.throws(() => typedSelections({ questions: [{ ...open, multiple: false }] }, 0, [{ labels: ['Chrome', 'Firefox'] }], chat('chrome y firefox')), /single choice/);
});

test('fixed-choice questions need exactly one offered label, in a complete ordered answer', () => {
  const approval = approvalEnvelope('run-1', 'mdd-plan');
  assert.throws(() => typedSelections(approval, 1, [], chat('continuar')), /exactly one answer per question/);
  assert.throws(() => typedSelections(approval, 1, read(undefined), chat('continuar')), /exactly one of its options/);
  assert.throws(() => typedSelections(approval, 1, [{ labels: ['Continuar', 'Pausar'] }], chat('continuar o pausar')), /exactly one of its options/);
  assert.throws(() => typedSelections(approval, 1, read('continuar'), chat('continuar')), /not one of its options/);
  assert.throws(() => typedSelections(approval, 1, [{ labels: ['Continuar'], extra: true }], chat('continuar')), /Unknown|extra|not allowed|unexpected/i);
});
