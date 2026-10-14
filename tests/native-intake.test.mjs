import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeIntake, approvalEnvelope, routeEnvelope, riskRecoveryEnvelope, nativeQuestionAnswers, CLARIFICATION_LABELS, APPROVAL_LABELS, CHANGE_LABELS, ROUTE_LABELS, RISK_RECOVERY_LABELS, UnselectedAnswer } from '../dist/native-intake.js';
import { QuestionCheckpointStore } from '../dist/question-checkpoint.js';
import { Workflow } from '../dist/workflow.js';
import { defaultSettings } from '../dist/settings.js';
import { answers, memoryServer, runtime } from './adapter-fixture.mjs';

// State-level native hook contracts, not model execution or permission UI proof.
function output(args, selections) {
  const formatted = args.questions.map((q, i) => `"${q.question}"="${selections[i]?.length ? selections[i].join(', ') : 'Unanswered'}"`).join(', ');
  return { title: `Asked ${args.questions.length} question${args.questions.length > 1 ? 's' : ''}`, output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`, metadata: { answers: selections, truncated: false } };
}
async function fixture(t, known = answers) {
  const { endpoint } = await memoryServer(t);
  const settings = defaultSettings();
  settings.engram = { endpoint, project: 'mdd-test' };
  settings.profiles.default.answers = { ...known };
  let workflow;
  let blocked = false;
  let starts = 0;
  const contributions = [];
  const runner = {
    async start(input) { starts++; workflow = new Workflow(input.preflight); },
    status() { return workflow ? { runID: 'run-contract', state: blocked ? 'blocked' : 'phase-recorded', reportDetail: 'detailed', workflow: workflow.snapshot() } : { state: 'not-started' }; },
    approveNative(_session, phase) { workflow.approve(phase); },
    block() { blocked = true; },
    contribute(value) { contributions.push(value); },
  };
  const checks = [];
  const inspect = {
    async intake(...args) { checks.push(['intake', ...args]); },
    async question(...args) { checks.push(['question', ...args]); },
  };
  const gate = new NativeIntake(runner, inspect, settings);
  const start = () => gate.start({ requirements: 'Human requirements' }, runtime, 'msg_start');
  let ordinal = 0;
  const answer = async selections => {
    if (gate.status(runtime.sessionID).state === 'review-ready') gate.prepareAdvance({ questions: [] }, runtime);
    const args = gate.status(runtime.sessionID).question;
    const call = { sessionID: runtime.sessionID, callID: `question-${++ordinal}` };
    await gate.beforeQuestion(call, args);
    await gate.afterQuestion(call, args, output(args, selections));
    return { args, call };
  };
  // mdd-explore is always first and is immediately followed by the mandatory mdd-risk stop,
  // never straight to the tail or an interactive review; resolving it transparently here means a
  // fixture that drives the workflow phase by phase does not need its own copy of the risk gate.
  // `route` only matters for the one call that passes exploration; every later call ignores it.
  const pass = (route = 'low') => {
    const next = workflow.nextAction();
    workflow.start(next.phase);
    workflow.recordResult({ phase: next.phase, outcome: 'passed', evidenceSummary: 'Simulated trusted phase result.' });
    if (workflow.nextAction().kind === 'execute-risk') {
      workflow.startRisk();
      workflow.recordRiskResult({ outcome: 'passed', evidenceSummary: `Risk is ${route}.`, route });
    }
    gate.phaseRecorded(runtime.sessionID);
  };
  return { gate, runner, inspect, checks, contributions, settings, start, answer, pass, starts: () => starts, workflow: () => workflow };
}

test('protected intake: full frozen profile skips question and authorizes only initial phase', async t => {
  const f = await fixture(t);
  f.settings.profiles.default.answers.mode = 'interactive';
  await f.start();
  const status = f.gate.status(runtime.sessionID);
  assert.equal(status.question, undefined);
  assert.equal(status.provenance.preflight, 'startup-profile');
  assert.equal(status.provenance.requirements, 'native-user');
  assert.equal(f.workflow().snapshot().answers.mode, 'automatic');
  assert.equal(f.starts(), 1);
  await assert.rejects(f.start(), /already/);
});

for (const known of [{}, { certainty: 'very-sure', artifactStore: 'none', summary: 'low' }]) {
  test(`protected intake: ${Object.keys(known).length} known fields produces one ordered native interaction`, async t => {
    const f = await fixture(t, known);
    const status = await f.start();
    assert.equal(status.state, 'question-ready');
    // The missing fields, then the free-form note that rides on every preflight that is asked.
    assert.equal(status.question.questions.length, 4 - Object.keys(known).length + 1);
    assert.equal(status.question.questions.at(-1).header, 'Notas');
    assert.deepEqual(status.question.questions.at(-1).options.map(option => option.label), [CLARIFICATION_LABELS.nothing]);
    assert.equal(f.starts(), 0);
    const labels = { Certeza: 'Muy seguro', Artefactos: 'Ninguno', Modo: 'Automático', Resumen: 'Bajo', Notas: CLARIFICATION_LABELS.nothing };
    const selections = status.question.questions.map(q => [labels[q.header]]);
    status.question.questions[0].question = 'mutated snapshot';
    await f.answer(selections);
    assert.deepEqual(f.workflow().snapshot().answers, answers);
    assert.equal(f.gate.status(runtime.sessionID).provenance.preflight, 'native-question');
    assert.equal(f.checks.filter(check => check[0] === 'question').length, 2);
    assert.equal(f.starts(), 1);
    // "Nothing to add" is not an answer the next phase has to carry.
    assert.equal(f.contributions.length, 0);
    assert.deepEqual(f.gate.status(runtime.sessionID).clarificationAnswers, []);
  });
}

for (const route of ['low', 'high']) {
  for (const mode of ['automatic', 'interactive']) {
    test(`native gate state contract: full ${route} ${mode} route has exact approval slots`, async t => {
      // The route is no longer scored from preflight answers; it is only ever selected by the
      // mandatory mdd-risk stop's passed verdict, driven here through `f.pass(route)`.
      const known = { ...answers, mode };
      const f = await fixture(t, known);
      await f.start();
      assert.equal(f.gate.status(runtime.sessionID).question, undefined);
      assert.deepEqual(f.workflow().nextAction(), { kind: 'execute', phase: 'mdd-explore' });
      f.pass(route);
      // mdd-risk settled transparently inside pass(); the tail now reflects the selected route.
      const phases = f.workflow().snapshot().evaluation.phases;
      assert.equal(phases[0], 'mdd-explore');
      assert.equal(f.workflow().snapshot().evaluation.route, route);
      if (mode === 'interactive') {
        assert.equal(f.gate.status(runtime.sessionID).state, 'review-ready');
        f.gate.prepareAdvance({ questions: [] }, runtime);
      }
      for (let index = 1; index < phases.length; index++) {
        const status = f.gate.status(runtime.sessionID);
        if (mode === 'automatic') assert.equal(status.question, undefined);
        else {
          assert.deepEqual(status.question, approvalEnvelope('run-contract', phases[index]));
          await f.answer([['Continuar']]);
          assert.equal(f.gate.status(runtime.sessionID).question, undefined);
        }
        assert.deepEqual(f.workflow().nextAction(), { kind: 'execute', phase: phases[index] });
        f.pass();
        if (mode === 'interactive' && index !== phases.length - 1) {
          assert.equal(f.gate.status(runtime.sessionID).state, 'review-ready');
          f.gate.prepareAdvance({ questions: [] }, runtime);
        }
      }
      assert.equal(f.workflow().nextAction().kind, 'finished');
      assert.equal(f.starts(), 1);
      assert.equal(f.gate.status(runtime.sessionID).questionReceipts.length, mode === 'interactive' ? phases.length - 1 : 0);
    });
  }
}

test('protected intake: model-supplied answers and setup overrides rejected', async t => {
  const f = await fixture(t);
  for (const extra of [{ preflight: { answers } }, { project: 'forged' }, { engramEndpoint: 'http://127.0.0.1:1' }, { profile: 'other' }]) {
    await assert.rejects(f.gate.start({ requirements: 'Human requirements', ...extra }, runtime, 'msg_start'));
  }
  assert.equal(f.starts(), 0);
});

test('session preferences: material replacement refreshes only objective certainty and drops old doubts', async t => {
  const f = await fixture(t, {});
  f.inspect.intake = async (_runtime, _text, id) => id;
  const inputs = [];
  const start = f.runner.start;
  f.runner.start = async input => { inputs.push(input); await start(input); };
  await f.gate.start({ requirements: 'Human requirements', context: { label: 'Old context', content: 'Old objective only.' },
    questions: [{ question: 'Old unresolved detail?', options: [], deferrable: true }] }, runtime, 'original');
  await f.answer([['Poco seguro'], ['Ninguno'], ['Interactivo'], ['Detallado'], [CLARIFICATION_LABELS.defer], [CLARIFICATION_LABELS.nothing]]);
  const before = f.workflow().snapshot();
  await f.gate.changeRequest({ kind: 'material', userText: 'Replace the objective.', requirements: 'A separate objective.' }, runtime, 'replacement');
  assert.deepEqual(f.workflow().snapshot(), before);
  await f.answer([[CHANGE_LABELS.confirm]]);
  const pending = f.gate.status(runtime.sessionID);
  assert.deepEqual(pending.question.questions.map(q => q.header), ['Certeza', 'Notas']);
  assert.deepEqual(pending.pendingClarifications, []);
  assert.deepEqual(pending.clarificationAnswers, []);
  await f.answer([['Muy seguro'], [CLARIFICATION_LABELS.nothing]]);
  assert.equal(inputs[1].context, undefined, 'objective-specific context is not carried into replacement');
  assert.ok(f.gate.status(runtime.sessionID).questionReceipts.some(item => item.answers.some(answer => answer.includes(CLARIFICATION_LABELS.defer))), 'previous answers remain history, not pending doubts');
  assert.deepEqual(f.workflow().snapshot().answers, { ...answers, mode: 'interactive', summary: 'detailed' });
  f.pass();
  assert.equal(f.gate.status(runtime.sessionID).state, 'review-ready');
  assert.equal(f.workflow().nextAction().kind, 'approve');
});

test('protected intake: absent Engram is off and asks only supported artifact choices', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Memory off must not fetch'); });
  const gate = new NativeIntake({}, { async intake() { return 'native-original'; } }, defaultSettings());
  const stopped = await gate.start({ requirements: 'Human requirements' }, runtime, 'msg_start');
  assert.equal(stopped.state, 'question-ready');
  assert.equal(stopped.memory, 'off');
  assert.equal(stopped.setup, undefined);
  assert.deepEqual(stopped.question.questions[1].options.map(option => option.label), ['OpenSpec', 'Ninguno']);
});

test('memory-off intake cannot replace a pending native objective', async () => {
  let inspections = 0;
  const gate = new NativeIntake({ status: () => ({ state: 'not-started' }) }, {
    async intake() { inspections++; return 'native-original'; },
  }, defaultSettings());
  await gate.start({ requirements: 'Original objective' }, runtime, 'first');
  assert.equal(gate.status(runtime.sessionID).state, 'question-ready');
  await assert.rejects(gate.start({ requirements: 'Continue after restart' }, runtime, 'later'), /already.*intake/i);
  assert.equal(inspections, 1);
});

test('native approval: Pause preserves the proposal without approving or fabricating a phase failure', async t => {
  const f = await fixture(t, { ...answers, mode: 'interactive' });
  await f.start(); f.pass();
  await f.answer([['Pausar']]);
  assert.equal(f.gate.status(runtime.sessionID).state, 'paused');
  assert.equal(f.workflow().nextAction().kind, 'approve');
  assert.equal(f.workflow().snapshot().results.length, 1);
  assert.throws(() => f.gate.guardTask(runtime.sessionID));
  f.gate.prepareAdvance({ questions: [] }, runtime);
  await f.answer([['Continuar']]);
  assert.equal(f.workflow().nextAction().kind, 'execute');
});

test('review questions are asked together before approval and retain recommended, delegated, deferred and free-text answers', async t => {
  const f = await fixture(t, { ...answers, mode: 'interactive' });
  await f.start(); f.pass();
  assert.equal(f.gate.status(runtime.sessionID).state, 'review-ready');
  assert.equal(f.gate.status(runtime.sessionID).question, undefined);
  assert.throws(() => f.gate.guardTask(runtime.sessionID));
  f.gate.prepareAdvance({ questions: [
    { question: 'Which layout?', options: [{ label: 'Centered', description: 'Keeps the panel centered.', recommended: true }, { label: 'Edge', description: 'Aligns it to the edge.' }] },
    { question: 'Which date format?', options: [{ label: 'ISO', description: 'Use YYYY-MM-DD.' }], deferrable: true },
    { question: 'Which fallback?', options: [{ label: 'Local', description: 'Use local cache.' }] },
    { question: 'What copy?', options: [{ label: 'Short', description: 'Use short copy.' }] },
  ] }, runtime);
  // One native interaction carries every question, the way preflight does.
  const grouped = f.gate.status(runtime.sessionID).question;
  assert.equal(grouped.questions.length, 4);
  assert.deepEqual(grouped.questions.map(question => question.header), ['Detalle', 'Detalle', 'Detalle', 'Detalle']);
  assert.deepEqual(grouped.questions[0].options.map(option => option.label), ['Centered (Recomendada)', 'Edge', CLARIFICATION_LABELS.delegate]);
  assert.deepEqual(grouped.questions[1].options.map(option => option.label), ['ISO', CLARIFICATION_LABELS.defer, CLARIFICATION_LABELS.delegate]);
  assert.match(grouped.questions[0].question, /^Which layout\? \[MDD clarification /);
  assert.equal(grouped.questions[3].question, 'What copy?');
  await f.answer([['Centered (Recomendada)'], [CLARIFICATION_LABELS.defer], [CLARIFICATION_LABELS.delegate], ['Use this exact custom wording']]);
  assert.deepEqual(f.gate.status(runtime.sessionID).clarificationAnswers.map(item => item.answer),
    ['Centered (Recomendada)', CLARIFICATION_LABELS.defer, CLARIFICATION_LABELS.delegate, 'Use this exact custom wording']);
  assert.equal(f.gate.status(runtime.sessionID).clarificationAnswers[1].disposition, 'deferred');
  assert.deepEqual(f.gate.status(runtime.sessionID).pendingClarifications.map(item => item.question), ['Which date format?']);
  // All answers of one interaction travel as one context entry.
  assert.equal(f.contributions.length, 1);
  assert.equal(f.contributions[0].label, 'Clarification');
  assert.match(f.contributions[0].content, /Question: Which date format\?\nAnswer: Dejar para más adelante\nDeferred by the user; unresolved\. Do not assume/);
  assert.match(f.contributions[0].content, /Question: What copy\?\nAnswer: Use this exact custom wording$/);
  assert.equal(f.gate.status(runtime.sessionID).question.questions[0].header, 'Aprobación');
  assert.equal(f.workflow().nextAction().kind, 'approve');
  await f.answer([[APPROVAL_LABELS.proceed]]);
  assert.equal(f.workflow().nextAction().kind, 'execute');
});

test('clarifications carry a header and why, allow several choices or none, and treat an empty answer as unresolved', async t => {
  const f = await fixture(t, { ...answers, mode: 'interactive' });
  await f.start(); f.pass();
  f.gate.prepareAdvance({ questions: [
    { question: '¿Qué navegadores soportamos?', header: 'Navegadores', why: 'Define qué APIs puede usar la implementación.', multiple: true,
      options: [{ label: 'Chrome', description: 'Últimas dos versiones.' }, { label: 'Firefox', description: 'Últimas dos versiones.' }, { label: 'Safari', description: 'iOS incluido.' }] },
    { question: '¿Cuál es la URL base de la API?', header: 'URL de la API', options: [] },
    { question: '¿Qué texto usamos en el botón?', options: [{ label: 'Guardar', description: 'Texto corto.' }] },
  ] }, runtime);
  const grouped = f.gate.status(runtime.sessionID).question;
  assert.deepEqual(grouped.questions.map(question => question.header), ['Navegadores', 'URL de la API', 'Detalle']);
  assert.match(grouped.questions[0].question, /^¿Qué navegadores soportamos\?\nPor qué importa: Define qué APIs puede usar la implementación\. \[MDD clarification /);
  assert.deepEqual(grouped.questions.map(question => question.multiple), [true, false, false]);
  // An open-ended question still offers delegation; the user types the answer.
  assert.deepEqual(grouped.questions[1].options.map(option => option.label), [CLARIFICATION_LABELS.delegate]);
  await f.answer([['Chrome', 'Safari', 'Edge también'], ['https://api.example.test'], []]);
  const status = f.gate.status(runtime.sessionID);
  assert.deepEqual(status.clarificationAnswers.map(item => [item.answer, item.disposition]), [
    ['Chrome, Safari, Edge también', 'answered'], ['https://api.example.test', 'answered'], ['Sin respuesta', 'deferred']]);
  assert.match(f.contributions[0].content, /Question: ¿Qué navegadores soportamos\?\nAnswers:\n- Chrome\n- Safari\n- Edge también/);
  assert.match(f.contributions[0].content, /Answer: Sin respuesta\nLeft unanswered by the user; unresolved/);
  assert.deepEqual(status.pendingClarifications.map(item => item.question), ['¿Qué texto usamos en el botón?']);
  assert.equal(status.question.questions[0].header, 'Aprobación');
  // A single-choice question cannot be answered with two choices.
  const g = await fixture(t, { ...answers, mode: 'interactive' });
  await g.start(); g.pass();
  g.gate.prepareAdvance({ questions: [{ question: 'Which one?', options: [{ label: 'A', description: 'First.' }, { label: 'B', description: 'Second.' }] }] }, runtime);
  await assert.rejects(g.answer([['A', 'B']]), /Invalid native question answer label/);
});

test('automatic mode stops for questions a phase reported, asks them together, then dispatches without approval', async t => {
  const f = await fixture(t, { ...answers, mode: 'automatic' });
  let reported = { phase: 'mdd-explore', questions: [{ question: 'Which locale?', why: 'Dates render differently.', options: [] }] };
  let taken = 0;
  f.runner.openQuestions = () => reported && structuredClone(reported);
  f.runner.takeOpenQuestions = () => { taken++; reported = undefined; };
  await f.start(); f.pass();
  assert.equal(f.workflow().nextAction().kind, 'execute');
  const review = f.gate.status(runtime.sessionID);
  assert.equal(review.state, 'review-ready');
  assert.equal(review.task, undefined);
  assert.match(review.notice, /openQuestions.*before the next phase is dispatched/s);
  assert.throws(() => f.gate.guardTask(runtime.sessionID));
  f.gate.prepareAdvance({ questions: [
    { question: '¿Qué idioma usamos para las fechas?', header: 'Idioma', why: 'Las fechas se muestran distinto según el idioma.', options: [{ label: 'Español', description: 'es-AR.', recommended: true }] },
    { question: '¿Mostramos la hora?', options: [{ label: 'Sí', description: 'Con hora.' }, { label: 'No', description: 'Solo fecha.' }] },
  ] }, runtime);
  assert.equal(taken, 1);
  assert.equal(f.gate.status(runtime.sessionID).question.questions.length, 2);
  await f.answer([['Español (Recomendada)'], ['No']]);
  const after = f.gate.status(runtime.sessionID);
  assert.equal(after.question, undefined);
  assert.equal(after.state, 'phase-recorded');
  assert.match(after.notice, /no approval is needed/);
  assert.doesNotThrow(() => f.gate.guardTask(runtime.sessionID));
  assert.equal(f.contributions.length, 1);
  assert.deepEqual(after.clarificationAnswers.map(item => item.phase), [f.workflow().nextAction().phase, f.workflow().nextAction().phase]);
  // No receipt approves anything: automatic mode records the answers, not consent.
  assert.equal(after.questionReceipts.at(-1).kind, 'clarification');
  // A later phase that reports nothing does not stop the run.
  f.pass();
  assert.notEqual(f.gate.status(runtime.sessionID).state, 'review-ready');
});

test('automatic mode: an empty answer set resumes the ready phase at once', async t => {
  const f = await fixture(t, { ...answers, mode: 'automatic' });
  let reported = { phase: 'mdd-explore', questions: [{ question: 'Which locale?', why: 'Dates.', options: [] }] };
  f.runner.openQuestions = () => reported;
  f.runner.takeOpenQuestions = () => { reported = undefined; };
  await f.start(); f.pass();
  assert.equal(f.gate.status(runtime.sessionID).state, 'review-ready');
  f.gate.prepareAdvance({ questions: [] }, runtime);
  assert.equal(reported, undefined);
  assert.equal(f.gate.status(runtime.sessionID).question, undefined);
  assert.doesNotThrow(() => f.gate.guardTask(runtime.sessionID));
});

test('the coordinator may stop a ready phase before dispatch to ask, in either mode, but not while work is in flight', async t => {
  const f = await fixture(t, { ...answers, mode: 'automatic' });
  await f.start();
  let state = 'await-result';
  const status = f.runner.status;
  f.runner.status = (...args) => ({ ...status(...args), state });
  assert.throws(() => f.gate.prepareAdvance({ questions: [{ question: '¿Qué color?', options: [{ label: 'Azul', description: 'Fondo azul.' }] }] }, runtime), /not ready/);
  state = 'ready';
  // Nothing to ask leaves the ready task untouched.
  f.gate.prepareAdvance({ questions: [] }, runtime);
  assert.equal(f.gate.status(runtime.sessionID).question, undefined);
  f.gate.prepareAdvance({ questions: [{ question: '¿Qué color?', options: [{ label: 'Azul', description: 'Fondo azul.' }] }] }, runtime);
  assert.equal(f.gate.status(runtime.sessionID).question.questions[0].header, 'Detalle');
  assert.throws(() => f.gate.guardTask(runtime.sessionID));
  await f.answer([['Azul']]);
  assert.equal(f.gate.status(runtime.sessionID).question, undefined);
  assert.doesNotThrow(() => f.gate.guardTask(runtime.sessionID));
  assert.match(f.contributions[0].content, /Question: ¿Qué color\?\nAnswer: Azul/);
  assert.equal(f.workflow().snapshot().results.length, 0);
});

test('startup doubts ride in the same native interaction as preflight and reach the first phase', async t => {
  const f = await fixture(t, { certainty: 'very-sure', artifactStore: 'none', summary: 'low' });
  const status = await f.gate.start({ requirements: 'Human requirements', questions: [
    { question: '¿Para qué pantalla es el cambio?', header: 'Pantalla', why: 'El pedido no dice dónde va.', options: [{ label: 'Dashboard', description: 'Inicio.' }, { label: 'Pedidos', description: 'Listado.' }] },
  ] }, runtime, 'msg_start');
  assert.deepEqual(status.question.questions.map(question => question.header), ['Modo', 'Pantalla', 'Notas']);
  assert.equal(f.starts(), 0);
  await f.answer([['Automático'], ['Pedidos'], ['No tocar el backend']]);
  assert.equal(f.starts(), 1);
  const started = f.gate.status(runtime.sessionID);
  assert.equal(started.provenance.preflight, 'native-question');
  assert.equal(f.contributions.length, 1);
  assert.match(f.contributions[0].content, /Question: ¿Para qué pantalla es el cambio\?\nAnswer: Pedidos/);
  assert.match(f.contributions[0].content, /Answer: No tocar el backend/);
  assert.deepEqual(started.clarificationAnswers.map(item => [item.answer, item.phase]), [['Pedidos', 'mdd-explore'], ['No tocar el backend', 'mdd-explore']]);
});

test('a complete profile starts at once unless the coordinator has doubts, which are then asked alone', async t => {
  const f = await fixture(t);
  const status = await f.gate.start({ requirements: 'Human requirements', questions: [
    { question: '¿Qué formato de fecha?', options: [{ label: 'ISO', description: 'AAAA-MM-DD.' }], deferrable: true },
  ] }, runtime, 'msg_start');
  // Only the doubt: no preflight field and no note, because preflight itself is not asked.
  assert.deepEqual(status.question.questions.map(question => question.header), ['Detalle']);
  assert.equal(f.starts(), 0);
  await f.answer([[CLARIFICATION_LABELS.defer]]);
  assert.equal(f.starts(), 1);
  const started = f.gate.status(runtime.sessionID);
  assert.equal(started.provenance.preflight, 'startup-profile');
  assert.deepEqual(started.pendingClarifications.map(item => item.question), ['¿Qué formato de fecha?']);
  assert.match(f.contributions[0].content, /Deferred by the user; unresolved/);
  await assert.rejects(fixture(t).then(g => g.gate.start({ requirements: 'Human requirements', questions: [{ question: 'Bad', options: [], header: 'x'.repeat(31) }] }, runtime, 'msg_start')), /at most 30 characters/);
});

test('regression: clarification prose still requires nonempty strings and bounded choice counts', async t => {
  const f = await fixture(t, { ...answers, mode: 'interactive' });
  await f.start(); f.pass();
  const base = { question: '¿Qué formato?', options: [{ label: 'ISO', description: 'Usar fechas ISO.' }] };
  for (const value of ['', '  ', null, 42]) {
    assert.throws(() => f.gate.prepareAdvance({ questions: [{ ...base, question: value }] }, runtime));
    for (const key of ['label', 'description']) {
      assert.throws(() => f.gate.prepareAdvance({ questions: [{ ...base, options: [{ ...base.options[0], [key]: value }] }] }, runtime));
    }
  }
  // An empty list is an open-ended question now; more than six choices is still refused.
  assert.throws(() => f.gate.prepareAdvance({ questions: [{ ...base, options: Array(7).fill(base.options[0]) }] }, runtime));
  assert.throws(() => f.gate.prepareAdvance({ questions: Array(9).fill(base) }, runtime));
  assert.throws(() => f.gate.prepareAdvance({ questions: [{ ...base, header: 'Un encabezado demasiado largo para la UI' }] }, runtime), /at most 30 characters/);
  for (const key of ['multiple', 'deferrable']) assert.throws(() => f.gate.prepareAdvance({ questions: [{ ...base, [key]: 'yes' }] }, runtime));
  assert.throws(() => f.gate.prepareAdvance({ questions: [{ ...base, why: '  ' }] }, runtime));
  assert.equal(f.gate.status(runtime.sessionID).state, 'review-ready');
});

test('deferred clarification is unresolved through approval and returns after the next phase, not immediately', async t => {
  const f = await fixture(t, { ...answers, mode: 'interactive', summary: 'detailed', certainty: 'not-sure' });
  await f.start(); f.pass();
  const question = { question: 'Which date format?', options: [{ label: 'ISO', description: 'Use ISO dates.' }], deferrable: true };
  f.gate.prepareAdvance({ questions: [question] }, runtime);
  await f.answer([[CLARIFICATION_LABELS.defer]]);
  assert.equal(f.gate.status(runtime.sessionID).question.questions[0].header, 'Aprobación');
  assert.equal(f.workflow().nextAction().kind, 'approve');
  await f.answer([[APPROVAL_LABELS.proceed]]);
  assert.equal(f.gate.status(runtime.sessionID).pendingClarifications[0].question, question.question);
  assert.equal(f.gate.status(runtime.sessionID).clarificationAnswers.at(-1).disposition, 'deferred');
  assert.equal(f.gate.status(runtime.sessionID).question, undefined);
  f.pass();
  assert.equal(f.gate.status(runtime.sessionID).state, 'review-ready');
  f.gate.prepareAdvance({ questions: [] }, runtime);
  assert.match(f.gate.status(runtime.sessionID).question.questions[0].question, /^Which date format\? \[MDD clarification /);
  f.gate.revisit(runtime);
  f.gate.prepareAdvance({ questions: [] }, runtime);
  assert.equal(f.gate.status(runtime.sessionID).question.questions[0].header, 'Detalle');
  await f.answer([[CLARIFICATION_LABELS.defer]]);
  assert.equal(f.gate.status(runtime.sessionID).question.questions[0].header, 'Aprobación');
  assert.equal(f.gate.status(runtime.sessionID).pendingClarifications.length, 1);
  // A later boundary can ask again without turning the second deferral into consent.
  await f.answer([[APPROVAL_LABELS.proceed]]);
  f.pass();
  f.gate.prepareAdvance({ questions: [] }, runtime);
  await f.answer([['ISO']]);
  assert.deepEqual(f.gate.status(runtime.sessionID).clarificationAnswers.map(item => item.disposition), ['deferred', 'deferred', 'answered']);
  assert.deepEqual(f.gate.status(runtime.sessionID).pendingClarifications, []);
  assert.equal(f.gate.status(runtime.sessionID).question.questions[0].header, 'Aprobación');
});

test('equal clarifications in concurrent parents retain their own issued identity', async () => {
  const settings = defaultSettings();
  settings.profiles.default.answers = { ...answers, mode: 'interactive' };
  const workflows = new Map();
  const gate = new NativeIntake({
    async start(input, parent) { workflows.set(parent.sessionID, new Workflow(input.preflight)); },
    status(id) { const workflow = workflows.get(id); return workflow ? { runID: `run-${id}`, state: 'phase-recorded', workflow: workflow.snapshot() } : { state: 'not-started' }; },
    approveNative(id, phase) { workflows.get(id).approve(phase); },
    block() {},
  }, { async intake() { return 'native-user'; }, async question() {} }, settings);
  const parents = ['parent-one', 'parent-two'].map(sessionID => ({ ...runtime, sessionID }));
  const question = { question: 'Which layout?', options: [{ label: 'Centered', description: 'Center the panel.' }] };
  for (const parent of parents) {
    await gate.start({ requirements: 'Human requirements' }, parent, `start-${parent.sessionID}`);
    const workflow = workflows.get(parent.sessionID);
    workflow.start(workflow.nextAction().phase);
    workflow.recordResult({ phase: workflow.snapshot().evaluation.phases[0], outcome: 'passed', evidenceSummary: 'Phase completed.' });
    // mdd-explore is immediately followed by the mandatory mdd-risk stop; resolve it inline so
    // the interactive review this test exercises is reached the same way phase-runner reaches it.
    if (workflow.nextAction().kind === 'execute-risk') {
      workflow.startRisk();
      workflow.recordRiskResult({ outcome: 'passed', evidenceSummary: 'Risk is low.', route: 'low' });
    }
    gate.phaseRecorded(parent.sessionID);
    gate.prepareAdvance({ questions: [question] }, parent);
  }
  const [first, second] = parents.map(parent => gate.status(parent.sessionID).question);
  assert.notDeepEqual(first, second);
  await assert.rejects(gate.beforeQuestion({ sessionID: parents[0].sessionID, callID: 'wrong-parent' }, second), /another parent/);
  for (const [index, parent] of parents.entries()) {
    const args = [first, second][index];
    const call = { sessionID: parent.sessionID, callID: `clarify-${index}` };
    await gate.beforeQuestion(call, args);
    await gate.afterQuestion(call, args, output(args, [['Centered']]));
    assert.equal(gate.status(parent.sessionID).clarificationAnswers[0].answer, 'Centered');
  }
});

test('unrelated native questions cannot compete during MDD accepting or await-answer', async t => {
  const f = await fixture(t, {}); await f.start();
  const args = f.gate.status(runtime.sessionID).question;
  const other = { questions: [{ header: 'Other', question: 'Unrelated?', multiple: false, options: [{ label: 'Yes', description: 'Other.' }] }] };
  let release;
  f.inspect.question = () => new Promise(resolve => { release = resolve; });
  const call = { sessionID: runtime.sessionID, callID: 'mdd-pending' };
  const before = f.gate.beforeQuestion(call, args);
  await assert.rejects(f.gate.beforeQuestion({ sessionID: runtime.sessionID, callID: 'other-accepting' }, other), /already pending/);
  release(); await before;
  assert.equal(f.gate.status(runtime.sessionID).state, 'await-answer');
  await assert.rejects(f.gate.beforeQuestion({ sessionID: runtime.sessionID, callID: 'other-awaiting' }, other), /already pending/);
  assert.equal(f.gate.status(runtime.sessionID).state, 'await-answer');
  f.inspect.question = async () => {};
  await f.gate.afterQuestion(call, args, output(args, [['Muy seguro'], ['Ninguno'], ['Automático'], ['Bajo'], [CLARIFICATION_LABELS.nothing]]));
  assert.equal(f.starts(), 1);
});

test('clarification option uniqueness uses rendered Spanish labels', async t => {
  const f = await fixture(t, { ...answers, mode: 'interactive' });
  await f.start(); f.pass();
  assert.throws(() => f.gate.prepareAdvance({ questions: [{ question: 'Which layout?', options: [
    { label: 'Centered', description: 'Recommended layout.', recommended: true },
    { label: 'Centered (Recomendada)', description: 'Duplicate rendered label.' },
  ] }] }, runtime), /unique and not reserved/);
  assert.throws(() => f.gate.prepareAdvance({ questions: [{ question: 'Who chooses?', options: [
    { label: CLARIFICATION_LABELS.delegate, description: 'Reserved delegation.' },
  ] }] }, runtime), /unique and not reserved/);
  assert.equal(f.gate.status(runtime.sessionID).state, 'review-ready');
});

test('unanswered phase clarification retains pending question and reports phase status', async t => {
  const f = await fixture(t, { ...answers, mode: 'interactive' });
  await f.start(); f.pass();
  f.gate.prepareAdvance({ questions: [{ question: 'Which layout?', options: [{ label: 'Centered', description: 'Center the panel.' }] }] }, runtime);
  // Exercise the unanswered recovery branch; ordinary valid custom text is accepted separately above.
  f.runner.contribute = () => { throw new UnselectedAnswer('Please clarify the layout first'); };
  const { args } = await f.answer([['Please clarify the layout first']]);
  const stalled = f.gate.status(runtime.sessionID);
  assert.equal(stalled.state, 'question-ready');
  assert.deepEqual(stalled.question, args);
  assert.equal(stalled.questionReceipts.at(-1).cancelled, true);
  assert.equal(stalled.questionReceipts.at(-1).kind, 'clarification');
  assert.equal(stalled.clarificationAnswers.length, 0);
  assert.equal(f.workflow().nextAction().kind, 'approve');
  assert.match(stalled.notice, /phase was not approved/i);
  assert.match(stalled.notice, /user's words.*respond/i);
  assert.match(stalled.notice, /clarification remains pending/i);
  assert.doesNotMatch(stalled.notice, /run has not started|no answer was recorded/i);
});

test('an edit revisits idle clarification or approval without discarding the route', async t => {
  const f = await fixture(t, { ...answers, mode: 'interactive' });
  await f.start(); f.pass();
  f.gate.prepareAdvance({ questions: [{ question: 'Which color?', options: [{ label: 'Blue', description: 'Blue background.' }] }] }, runtime);
  f.gate.revisit(runtime);
  assert.equal(f.gate.status(runtime.sessionID).state, 'review-ready');
  assert.equal(f.workflow().nextAction().kind, 'approve');
  f.gate.contribute({ label: 'User edit', content: 'Use a green background.' }, runtime);
  f.gate.prepareAdvance({ questions: [] }, runtime);
  assert.equal(f.gate.status(runtime.sessionID).question.questions[0].header, 'Aprobación');
  f.gate.revisit(runtime);
  assert.equal(f.gate.status(runtime.sessionID).clarificationAnswers.length, 0);
  assert.equal(f.contributions.length, 1);
});

test('dismissed clarification pauses without dropping remaining questions', async t => {
  const f = await fixture(t, { ...answers, mode: 'interactive' });
  await f.start(); f.pass();
  f.gate.prepareAdvance({ questions: [{ question: 'Which format?', options: [{ label: 'ISO', description: 'Use ISO dates.' }] }] }, runtime);
  const args = f.gate.status(runtime.sessionID).question;
  const call = { sessionID: runtime.sessionID, callID: 'dismissed-clarification' };
  await f.gate.beforeQuestion(call, args);
  f.gate.nativeError(call);
  assert.equal(f.gate.status(runtime.sessionID).state, 'paused');
  assert.equal(f.workflow().nextAction().kind, 'approve');
  f.gate.prepareAdvance({ questions: [] }, runtime);
  assert.match(f.gate.status(runtime.sessionID).question.questions[0].question, /^Which format\? \[MDD clarification /);
  await f.answer([['ISO']]);
  assert.equal(f.gate.status(runtime.sessionID).question.questions[0].header, 'Aprobación');
});

test('the detail choice is conditional and does not grant approval', async t => {
  const f = await fixture(t, { ...answers, mode: 'interactive' });
  await f.start();
  f.runner.status = () => ({ runID: 'run-contract', state: 'await-approval', reportDetail: 'low', workflow: f.workflow().snapshot() });
  f.pass();
  f.gate.prepareAdvance({ questions: [] }, runtime);
  assert.ok(f.gate.status(runtime.sessionID).question.questions[0].options.some(option => option.label === APPROVAL_LABELS.detail));
  await f.answer([[APPROVAL_LABELS.detail]]);
  assert.equal(f.workflow().nextAction().kind, 'approve');
  assert.equal(f.gate.status(runtime.sessionID).question.questions[0].options.some(option => option.label === APPROVAL_LABELS.detail), false);
  assert.match(f.gate.status(runtime.sessionID).notice, /expandedReport|full/);
});

for (const selections of [[], [['forged']], [['Muy seguro', 'Poco seguro']], [['Muy seguro', 'Poco seguro'], ['Ninguno'], ['Automático'], ['Bajo'], ['Nada que agregar']]]) {
  test(`native question: reject malformed answer envelopes ${JSON.stringify(selections)}`, async t => {
    const f = await fixture(t, {}); await f.start();
    await assert.rejects(f.answer(selections));
    assert.equal(f.gate.status(runtime.sessionID).state, 'blocked');
    assert.equal(f.starts(), 0);
  });
}

// A well-formed answer naming something outside the offered options is the user writing their own
// words, or a host that reordered them. MDD cannot tell those apart, and neither is consent: it
// starts nothing and records nothing. Ending the run over it is what cost a whole route once, so
// the question simply stays open and can be answered again.
test('native question: an unlisted label answers nothing and leaves the question open', async t => {
  const f = await fixture(t, {}); await f.start();
  await f.answer([['Ninguno'], ['Muy seguro'], ['Automático'], ['Bajo'], [CLARIFICATION_LABELS.nothing]]);
  const stalled = f.gate.status(runtime.sessionID);
  assert.equal(stalled.state, 'question-ready');
  assert.ok(stalled.question);
  assert.equal(f.starts(), 0);
  assert.equal(stalled.questionReceipts.at(-1).cancelled, true);
  assert.equal(stalled.questionReceipts.at(-1).answers.length, 0);
  await f.answer([['Muy seguro'], ['Ninguno'], ['Automático'], ['Bajo'], [CLARIFICATION_LABELS.nothing]]);
  assert.equal(f.starts(), 1);
  assert.equal(f.gate.status(runtime.sessionID).state, 'phase-recorded');
});

// The same rule at the approval boundary, where it actually cost a run: the user answered the
// phase report in prose, the label did not match, and the whole route was thrown away.
test('native question: an unlisted approval answer keeps the run and re-opens the approval', async t => {
  const f = await fixture(t, { ...answers, mode: 'interactive' });
  await f.start(); f.pass();
  await f.answer([['Ya no lo quiero en la esquina, lo quiero centrado']]);
  const stalled = f.gate.status(runtime.sessionID);
  assert.equal(stalled.state, 'question-ready');
  assert.equal(stalled.question.questions[0].header, 'Aprobación');
  assert.equal(f.workflow().nextAction().kind, 'approve');
  assert.match(stalled.notice, /approved/);
  await f.answer([['Continuar']]);
  assert.equal(f.workflow().nextAction().kind, 'execute');
});

// A question the coordinator asks on its own, between phases, is ordinary work. MDD used to treat
// every native question as its own and blocked the run over an unrelated clarification.
test('native question: the coordinator may ask its own question without ending the run', async t => {
  const f = await fixture(t, { ...answers, mode: 'interactive' });
  await f.start();
  const mine = { questions: [{ header: 'Detalle', question: '¿Qué formato de fecha usamos?', multiple: false, options: [{ label: 'ISO', description: 'AAAA-MM-DD.' }] }] };
  const call = { sessionID: runtime.sessionID, callID: 'own-question' };
  await f.gate.beforeQuestion(call, mine);
  await f.gate.afterQuestion(call, mine, output(mine, [['ISO']]));
  const status = f.gate.status(runtime.sessionID);
  assert.equal(status.state, 'phase-recorded');
  assert.equal(status.questionReceipts.some(receipt => receipt.callID === 'own-question'), false);
});

test('native question: stale duplicate result cannot approve another phase', async t => {
  const f = await fixture(t, { ...answers, mode: 'interactive' });
  await f.start(); f.pass();
  const previous = await f.answer([['Continuar']]);
  f.pass();
  await assert.rejects(f.gate.afterQuestion(previous.call, previous.args, output(previous.args, [['Continuar']])));
  assert.equal(f.workflow().nextAction().kind, 'approve');
  assert.equal(f.gate.status(runtime.sessionID).state, 'blocked');
});

test('native question: exact arguments, wrong parent, cancellation and unrelated sessions', async t => {
  const f = await fixture(t, {}); await f.start();
  const args = f.gate.status(runtime.sessionID).question;
  await assert.rejects(f.gate.beforeQuestion({ sessionID: 'other', callID: 'bad' }, args), /parent/);
  await f.gate.beforeQuestion({ sessionID: 'unrelated', callID: 'normal' }, { questions: [] });
  await f.gate.afterQuestion({ sessionID: 'unrelated', callID: 'normal' }, {}, {});
  const call = { sessionID: runtime.sessionID, callID: 'pending' };
  await f.gate.beforeQuestion(call, args);
  f.gate.nativeError({ ...call, callID: 'unrelated' });
  assert.equal(f.gate.status(runtime.sessionID).state, 'await-answer');
  f.gate.nativeError(call);
  assert.equal(f.gate.status(runtime.sessionID).state, 'stopped');
  await assert.rejects(f.gate.afterQuestion(call, args, output(args, [['Muy seguro'], ['Ninguno'], ['Automático'], ['Bajo']])));
  assert.equal(f.starts(), 0);
});

test('native question: task before preflight blocks without creating a workflow', async t => {
  const f = await fixture(t, {}); await f.start();
  assert.throws(() => f.gate.guardTask(runtime.sessionID));
  assert.equal(f.starts(), 0);
  assert.equal(f.gate.status(runtime.sessionID).state, 'question-ready');
});

for (const [name, mutate] of Object.entries({
  'missing answer metadata': result => { result.metadata = { truncated: false }; },
  'prose-only approval': result => { result.metadata.answers = [['Detener']]; },
  'unknown metadata': result => { result.metadata.approved = true; },
  'truncated native output': result => { result.metadata.truncated = true; },
  'missing truncation flag': result => { delete result.metadata.truncated; },
  'fabricated wrapper': result => { result.output = 'Continuar'; },
  'unknown title': result => { result.title = 'Approved'; },
  'unexpected attachment': result => { result.attachments = [{}]; },
})) {
  test(`native question output contract rejects ${name}`, () => {
    const args = approvalEnvelope('run-contract', 'mdd-apply');
    const raw = output(args, [['Continuar']]); mutate(raw);
    assert.throws(() => nativeQuestionAnswers(args, raw));
  });
}

test('native question: changed before args cannot change defaults or options', async t => {
  const f = await fixture(t, {}); await f.start();
  const args = f.gate.status(runtime.sessionID).question;
  args.questions[0].options[0].label = 'Forged';
  await assert.rejects(f.gate.beforeQuestion({ sessionID: runtime.sessionID, callID: 'changed' }, args));
  assert.equal(f.starts(), 0);
});

test('native question: result without before and arbitrary task before approval never advance', async t => {
  const f = await fixture(t, { ...answers, mode: 'interactive' });
  await f.start(); f.pass();
  f.gate.prepareAdvance({ questions: [] }, runtime);
  const args = f.gate.status(runtime.sessionID).question;
  await assert.rejects(f.gate.afterQuestion({ sessionID: runtime.sessionID, callID: 'forged' }, args, output(args, [['Continuar']])));
  assert.throws(() => f.gate.guardTask(runtime.sessionID));
  assert.equal(f.workflow().nextAction().kind, 'approve');
});

test('native question: duplicate concurrent before blocks both admissions', async t => {
  const f = await fixture(t, {}); await f.start();
  const args = f.gate.status(runtime.sessionID).question;
  let release;
  f.inspect.question = () => new Promise(resolve => { release = resolve; });
  const call = { sessionID: runtime.sessionID, callID: 'one' };
  const first = f.gate.beforeQuestion(call, args);
  await assert.rejects(f.gate.beforeQuestion({ ...call, callID: 'two' }, args));
  release();
  await assert.rejects(first);
  assert.equal(f.gate.status(runtime.sessionID).state, 'blocked');
  assert.equal(f.starts(), 0);
});

test('native question: duplicate concurrent after cannot accept either response', async t => {
  const f = await fixture(t, {}); await f.start();
  const args = f.gate.status(runtime.sessionID).question;
  const call = { sessionID: runtime.sessionID, callID: 'one' };
  await f.gate.beforeQuestion(call, args);
  let release;
  f.inspect.question = () => new Promise(resolve => { release = resolve; });
  const raw = output(args, [['Muy seguro'], ['Ninguno'], ['Automático'], ['Bajo']]);
  const first = f.gate.afterQuestion(call, args, raw);
  await assert.rejects(f.gate.afterQuestion(call, args, raw));
  release(); await assert.rejects(first);
  assert.equal(f.starts(), 0);
});

test('native question: failed parent inspection blocks rather than reprompting', async t => {
  const f = await fixture(t, {}); await f.start();
  f.inspect.question = async () => { throw new Error('Native history unavailable.'); };
  const args = f.gate.status(runtime.sessionID).question;
  await assert.rejects(f.gate.beforeQuestion({ sessionID: runtime.sessionID, callID: 'one' }, args));
  assert.equal(f.gate.status(runtime.sessionID).question, undefined);
  assert.equal(f.starts(), 0);
});

test('native question: Pause and cancellation do not reuse previous consent', async t => {
  const f = await fixture(t, { ...answers, mode: 'interactive' });
  await f.start(); f.pass();
  const previous = await f.answer([['Continuar']]);
  f.pass();
  f.gate.prepareAdvance({ questions: [] }, runtime);
  const args = f.gate.status(runtime.sessionID).question;
  await assert.rejects(f.gate.beforeQuestion(previous.call, args), /already consumed/);
  assert.equal(f.workflow().nextAction().kind, 'approve');
  assert.equal(f.gate.status(runtime.sessionID).questionReceipts.length, 1);
});

test('protected intake: native user inspection failure leaves requirements unconfirmed', async t => {
  const f = await fixture(t);
  f.inspect.intake = async () => { throw new Error('No actual user input.'); };
  await assert.rejects(f.start());
  assert.equal(f.gate.status(runtime.sessionID).provenance, undefined);
  assert.equal(f.starts(), 0);
});

/**
 * A minimal runner parked exactly at the settled risk boundary this fixture exercises: `stage`
 * is what marks it as the typed mdd-risk stop rather than an ordinary ready/blocked phase, the
 * same distinction `beforeQuestion` reads off the real PhaseRunner.
 */
function riskFixture(t, stable) {
  const root = mkdtempSync(join(tmpdir(), 'mdd-native-risk-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new QuestionCheckpointStore(root);
  const settings = defaultSettings();
  settings.profiles.default.answers = { ...answers };
  const runID = 'run-risk';
  let workflow;
  const runner = {
    async start(input) { workflow = new Workflow(input.preflight); },
    status() {
      if (!workflow) return { state: 'not-started' };
      // The same public state label the real PhaseRunner reports for each risk-* stable label.
      const state = { 'risk-ready': 'ready', 'risk-await-result': 'await-result', 'risk-blocked': 'blocked' }[stable];
      return { runID, state, stage: 'mdd-risk', reportDetail: 'detailed', workflow: workflow.snapshot() };
    },
    approveNative() {}, block() {}, assertChangeable() {}, owner() { return undefined; },
    reserve() { return { runID }; }, release() {},
  };
  // Echoes the exact native message ID back, the same way a real adapter inspection would,
  // so each distinct call (start, then change request) is its own fresh user message.
  const inspect = { async intake(_runtime, _text, messageID) { return messageID; }, async question() {} };
  const gate = () => new NativeIntake(runner, inspect, settings, { questions: store,
    checkpoint: { read: () => ({ checkpoint: { version: 3, runID, sequence: 7, dataDigest: 'b'.repeat(64) } }) } });
  return { root, store, gate, runID, workflow: () => workflow };
}

for (const stable of ['risk-ready', 'risk-blocked']) {
  test(`S11: a native question reserved at ${stable} survives persist and reload bound to the same run and checkpoint`, async t => {
    const f = riskFixture(t, stable);
    const intake = f.gate();
    await intake.start({ requirements: 'Plan a safe change.' }, runtime, 'user-start');
    const workflow = f.workflow();
    workflow.start('mdd-explore');
    workflow.recordResult({ phase: 'mdd-explore', outcome: 'passed', evidenceSummary: 'Explored.' });
    // risk-ready leaves the stop at `execute-risk`, never started; risk-blocked drives it through
    // a failed assessment, exactly as workflow.ts settles the two stable labels.
    if (stable === 'risk-blocked') {
      workflow.startRisk();
      workflow.recordRiskResult({ outcome: 'failed', evidenceSummary: 'Too risky to continue.' });
    }
    await intake.changeRequest({ kind: 'rerun', userText: 'Please redo the preflight questions.' }, runtime, 'user-change');
    const args = intake.status(runtime.sessionID).question;
    assert.ok(args, 'a change-request question must be pending at this settled risk boundary');
    const call = { sessionID: runtime.sessionID, callID: `change-${stable}` };
    await intake.beforeQuestion(call, args);
    const saved = f.store.read(runtime.sessionID);
    assert.equal(saved.state, 'pending');
    assert.deepEqual(saved.reservation, { runID: f.runID, stable });
    assert.deepEqual(saved.checkpoint, { sequence: 7, digest: 'b'.repeat(64) });
    // A fresh gate instance has no in-memory session; the persisted record still binds the exact
    // run and settled state, so it reports recovery-blocked instead of silently losing the
    // pending question or letting a second intake replace it.
    const reloaded = f.gate();
    assert.equal(reloaded.status(runtime.sessionID).state, 'recovery-blocked');
    await assert.rejects(reloaded.start({ requirements: 'Different objective.' }, runtime, 'user-replace'), /unresolved outcome/);
  });
}

test('S12: risk-await-result is refused as a reservation through the native writer path', async t => {
  const f = riskFixture(t, 'risk-await-result');
  const intake = f.gate();
  await intake.start({ requirements: 'Plan a safe change.' }, runtime, 'user-start');
  const workflow = f.workflow();
  workflow.start('mdd-explore');
  workflow.recordResult({ phase: 'mdd-explore', outcome: 'passed', evidenceSummary: 'Explored.' });
  // The risk stop's own attempt is unconfirmed: started, never settled.
  workflow.startRisk();
  await intake.changeRequest({ kind: 'rerun', userText: 'Please redo the preflight questions.' }, runtime, 'user-change');
  const args = intake.status(runtime.sessionID).question;
  const call = { sessionID: runtime.sessionID, callID: 'change-await-result' };
  await intake.beforeQuestion(call, args);
  const saved = f.store.read(runtime.sessionID);
  assert.equal(saved.state, 'pending');
  // 'await-result' never maps to a settled label; the native writer path never records a
  // reservation for it, the same way it never would for an ordinary phase's unconfirmed attempt.
  assert.equal(saved.reservation, undefined);
});

/**
 * 3a: the one native route question offered in place of the generic approval, at the exact
 * boundary where a passed mdd-risk verdict's suggested route still only awaits its ordinary
 * approval. `pass(route)` plays mdd-explore and mdd-risk transparently, the same way `fixture`'s
 * own `pass` does, but also records the verdict `status()` must expose as `risk` for the gate to
 * recognise this boundary — the plain contract mock above never carries that field, which is why
 * its own tests above never exercise this path.
 */
function routeFixture(t, mode) {
  let workflow;
  let riskVerdict;
  let blocked = false;
  let forced = 0;
  const runner = {
    async start(input) { workflow = new Workflow(input.preflight); },
    status() {
      if (!workflow) return { state: 'not-started' };
      return { runID: 'run-route', state: blocked ? 'blocked' : 'phase-recorded', reportDetail: 'detailed',
        workflow: workflow.snapshot(), ...(riskVerdict ? { risk: riskVerdict } : {}) };
    },
    approveNative(_session, phase) { workflow.approve(phase); },
    forceRoute() { workflow.overrideRoute(); forced++; },
    block() { blocked = true; },
    approvalStopped() {},
  };
  const inspect = { async intake() {}, async question() {}, async typed() { return 'msg-route-answer'; } };
  const settings = defaultSettings();
  settings.profiles.default.answers = { ...answers, mode };
  const gate = new NativeIntake(runner, inspect, settings);
  const start = () => gate.start({ requirements: 'Plan a route decision.' }, runtime, 'user-route-start');
  let ordinal = 0;
  const answer = async selections => {
    if (gate.status(runtime.sessionID).state === 'review-ready') gate.prepareAdvance({ questions: [] }, runtime);
    const args = gate.status(runtime.sessionID).question;
    const call = { sessionID: runtime.sessionID, callID: `route-question-${++ordinal}` };
    await gate.beforeQuestion(call, args);
    await gate.afterQuestion(call, args, output(args, selections));
    return { args, call };
  };
  const pass = route => {
    const next = workflow.nextAction();
    workflow.start(next.phase);
    workflow.recordResult({ phase: next.phase, outcome: 'passed', evidenceSummary: 'Explored for a route decision.' });
    workflow.startRisk();
    riskVerdict = { route, complexity: route, reason: `The change is ${route === 'high' ? 'cross-cutting' : 'contained'}.`,
      evidence: [{ source: 'exploration', finding: 'Scope is bounded to the CLI.' }],
      risks: [{ description: 'Exit codes could change.', evidence: 'exploration', mitigation: 'Keep tests on exit codes.' }] };
    workflow.recordRiskResult({ outcome: 'passed', evidenceSummary: `Risk is ${route}.`, route });
    gate.phaseRecorded(runtime.sessionID);
  };
  return { gate, runner, start, answer, pass, forced: () => forced, workflow: () => workflow };
}

for (const route of ['low', 'high']) {
  test(`route question (S1): continue authorizes only the suggested ${route} tail and keeps the verdict`, async t => {
    const f = routeFixture(t, 'interactive');
    await f.start();
    f.pass(route);
    const first = f.workflow().snapshot().evaluation.phases[1];
    f.gate.prepareAdvance({ questions: [] }, runtime);
    const pending = f.gate.status(runtime.sessionID).question;
    const reason = `The change is ${route === 'high' ? 'cross-cutting' : 'contained'}.`;
    assert.deepEqual(pending, routeEnvelope('run-route', first, { route, complexity: route, reason }));
    assert.equal(pending.questions[0].header, 'Ruta');
    assert.deepEqual(pending.questions[0].options.map(option => option.label), [ROUTE_LABELS.continue, ROUTE_LABELS.force, ROUTE_LABELS.stop]);
    await f.answer([[ROUTE_LABELS.continue]]);
    assert.deepEqual(f.workflow().nextAction(), { kind: 'execute', phase: first });
    assert.equal(f.workflow().snapshot().routeOrigin, 'suggested');
    assert.equal(f.workflow().snapshot().evaluation.route, route);
    assert.equal(f.forced(), 0);
    assert.equal(f.gate.status(runtime.sessionID).question, undefined);
  });
}

for (const [from, to] of [['low', 'high'], ['high', 'low']]) {
  test(`route question (S2/S3): force switches ${from} to ${to}, preserving the original verdict`, async t => {
    const f = routeFixture(t, 'interactive');
    await f.start();
    f.pass(from);
    await f.answer([[ROUTE_LABELS.force]]);
    const snapshot = f.workflow().snapshot();
    assert.equal(snapshot.evaluation.route, to);
    assert.equal(snapshot.routeOrigin, 'override');
    // The verdict itself is never rewritten by a force: only which tail runs changes.
    const verdict = f.workflow().history().find(event => event.kind === 'risk-result');
    assert.equal(verdict.result.route, from);
    assert.equal(f.forced(), 1);
    assert.equal(f.gate.status(runtime.sessionID).question, undefined);
  });
}

test('route question (S4): stop pauses without authorizing or rejecting either route', async t => {
  const f = routeFixture(t, 'interactive');
  await f.start();
  f.pass('low');
  await f.answer([[ROUTE_LABELS.stop]]);
  assert.equal(f.gate.status(runtime.sessionID).reason, 'The user stopped before either route was authorized. No phase was authorized or rejected.');
  assert.equal(f.workflow().nextAction().kind, 'approve');
  assert.equal(f.workflow().snapshot().routeOrigin, 'suggested');
  assert.equal(f.forced(), 0);
});

test('route question (S5): an answer outside continue/force/stop authorizes nothing and the question is re-armed', async t => {
  const f = routeFixture(t, 'interactive');
  await f.start();
  f.pass('low');
  await f.answer([['I would rather decide later']]);
  assert.equal(f.workflow().nextAction().kind, 'approve');
  assert.equal(f.forced(), 0);
  const rearmed = f.gate.status(runtime.sessionID).question;
  assert.equal(rearmed.questions[0].header, 'Ruta');
  assert.deepEqual(rearmed.questions[0].options.map(option => option.label), [ROUTE_LABELS.continue, ROUTE_LABELS.force, ROUTE_LABELS.stop]);
});

test('route question (S6): automatic mode asks no route question and keeps the suggested route', async t => {
  const f = routeFixture(t, 'automatic');
  await f.start();
  f.pass('high');
  assert.equal(f.gate.status(runtime.sessionID).question, undefined);
  assert.equal(f.workflow().nextAction().kind, 'execute');
  assert.equal(f.workflow().snapshot().routeOrigin, 'suggested');
  assert.equal(f.forced(), 0);
});

// D3/S5: a cancelled route receipt authorizes nothing and leaves the route question re-askable,
// exactly like a cancelled generic approval — no phase is approved and no force happens. It pauses
// like that approval too: stopping used to block the run and discard the evidence it was about.
test('route question (S5): a cancelled native call authorizes neither continue nor force', async t => {
  const f = routeFixture(t, 'interactive');
  await f.start();
  f.pass('low');
  f.gate.prepareAdvance({ questions: [] }, runtime);
  const args = f.gate.status(runtime.sessionID).question;
  const call = { sessionID: runtime.sessionID, callID: 'route-cancel-1' };
  await f.gate.beforeQuestion(call, args);
  f.gate.nativeError(call);
  assert.equal(f.workflow().nextAction().kind, 'approve');
  assert.equal(f.workflow().snapshot().routeOrigin, 'suggested');
  assert.equal(f.forced(), 0);
  assert.equal(f.gate.status(runtime.sessionID).state, 'paused');
  f.gate.prepareAdvance({ questions: [] }, runtime);
  assert.equal(f.gate.status(runtime.sessionID).question.questions[0].header, 'Ruta');
});

// D3/S5: once a route call has already answered, that exact callID cannot answer again — the
// durable record retires it, so a replayed receipt for the same call is refused rather than
// silently re-authorizing a force or a second continue.
test('route question (S5): a stale duplicate route result cannot force or approve again', async t => {
  const f = routeFixture(t, 'interactive');
  await f.start();
  f.pass('low');
  const first = await f.answer([[ROUTE_LABELS.continue]]);
  assert.equal(f.workflow().nextAction().kind, 'execute');
  assert.equal(f.forced(), 0);
  // The same callID/args replayed after the route already settled must not force the other
  // route or re-approve anything.
  await assert.rejects(f.gate.afterQuestion(first.call, first.args, output(first.args, [[ROUTE_LABELS.force]])));
  assert.equal(f.forced(), 0);
  assert.equal(f.workflow().snapshot().routeOrigin, 'suggested');
});

/**
 * S2: the one native recovery question offered exactly once a `blocked-risk` assessment settles
 * (a valid failed verdict or an exhausted fallback), mapping the four exact labels onto
 * `PhaseRunner.retryRisk()` / `chooseManualRoute()` / stop. `failRisk()` plays exploration and a
 * failed mdd-risk assessment transparently, the same way `routeFixture`'s `pass()` plays a
 * passed one; `retryRisk`/`chooseManualRoute` mutate the workflow directly, exactly like the real
 * guarded runner operations they stand in for.
 */
function riskRecoveryFixture(t, mode, faults = {}) {
  let workflow;
  let blocked = false;
  let retries = 0;
  let manualRoutes = [];
  let stops = 0;
  const runner = {
    async start(input) { workflow = new Workflow(input.preflight); },
    status() {
      if (!workflow) return { state: 'not-started' };
      return { runID: 'run-recovery', state: blocked ? 'blocked' : 'phase-recorded', reportDetail: 'detailed',
        ...(blocked ? { reason: 'mdd-risk reported that the request cannot be substantiated on this evidence.' } : {}),
        workflow: workflow.snapshot() };
    },
    approveNative(_session, phase) { workflow.approve(phase); },
    block() { blocked = true; },
    approvalStopped() { stops++; },
    // Stands in for the guarded runner operation's own checkpoint failure: the workflow
    // transition it would make is never reached, exactly like the real retryRisk()/
    // chooseManualRoute() throwing before a task is ever exposed.
    retryRisk() { if (faults.retry) throw new Error('simulated runner checkpoint fault'); workflow.retry(); blocked = false; retries++; },
    chooseManualRoute(_session, route) {
      if (faults.route) throw new Error('simulated runner checkpoint fault');
      workflow.chooseManualRoute(route); blocked = false; manualRoutes.push(route);
    },
    // A settled blocked-risk released at phase scope stays exactly where it was: still
    // blocked-risk, nothing authorized, so the recovery question can be reopened from it.
    reset() { return { scope: 'phase' }; },
  };
  const inspect = { async intake() {}, async question() {}, async typed() { return 'msg-recovery-answer'; } };
  const settings = defaultSettings();
  settings.profiles.default.answers = { ...answers, mode };
  const gate = new NativeIntake(runner, inspect, settings);
  const start = () => gate.start({ requirements: 'Plan a change risk cannot route.' }, runtime, 'user-recovery-start');
  let ordinal = 0;
  const answer = async selections => {
    const args = gate.status(runtime.sessionID).question;
    const call = { sessionID: runtime.sessionID, callID: `recovery-question-${++ordinal}` };
    await gate.beforeQuestion(call, args);
    await gate.afterQuestion(call, args, output(args, selections));
    return { args, call };
  };
  const failRisk = () => {
    const next = workflow.nextAction();
    workflow.start(next.phase);
    workflow.recordResult({ phase: next.phase, outcome: 'passed', evidenceSummary: 'Explored.' });
    workflow.startRisk();
    workflow.recordRiskResult({ outcome: 'failed', evidenceSummary: 'Cannot substantiate a route on this evidence.' });
    blocked = true;
    gate.phaseRecorded(runtime.sessionID);
  };
  return { gate, start, answer, failRisk, retries: () => retries, manualRoutes: () => manualRoutes, stops: () => stops, workflow: () => workflow };
}

// A1: the recovery question is armed only once blocked-risk is settled — never while exploration
// or the assessment itself is still in flight, and never as a side effect of starting the run.
test('risk recovery (A1): the recovery question is armed only after blocked-risk settles', async t => {
  const f = riskRecoveryFixture(t, 'interactive');
  await f.start();
  assert.equal(f.gate.status(runtime.sessionID).question, undefined);
  f.failRisk();
  const pending = f.gate.status(runtime.sessionID).question;
  assert.deepEqual(pending, riskRecoveryEnvelope('run-recovery', 'mdd-risk reported that the request cannot be substantiated on this evidence.'));
  assert.deepEqual(pending.questions[0].options.map(option => option.label),
    [RISK_RECOVERY_LABELS.retry, RISK_RECOVERY_LABELS.low, RISK_RECOVERY_LABELS.high, RISK_RECOVERY_LABELS.stop]);
});

// A2: Reintentar calls PhaseRunner.retryRisk() exactly once and settles this exact native call.
test('risk recovery (A2): Reintentar evaluación de riesgo retries exactly once', async t => {
  const f = riskRecoveryFixture(t, 'interactive');
  await f.start();
  f.failRisk();
  await f.answer([[RISK_RECOVERY_LABELS.retry]]);
  assert.equal(f.retries(), 1);
  assert.deepEqual(f.manualRoutes(), []);
  assert.equal(f.stops(), 0);
  assert.equal(f.gate.status(runtime.sessionID).question, undefined);
});

// A3/A4: Ruta low / Ruta high call PhaseRunner.chooseManualRoute() with the exact named route.
for (const [label, route] of [[RISK_RECOVERY_LABELS.low, 'low'], [RISK_RECOVERY_LABELS.high, 'high']]) {
  test(`risk recovery: '${label}' chooses the manual ${route} route exactly once`, async t => {
    const f = riskRecoveryFixture(t, 'interactive');
    await f.start();
    f.failRisk();
    await f.answer([[label]]);
    assert.deepEqual(f.manualRoutes(), [route]);
    assert.equal(f.retries(), 0);
    assert.equal(f.stops(), 0);
  });
}

// A5: Detener authorizes neither a retry nor either route; the run stays recoverably blocked-risk.
test('risk recovery (A5): Detener leaves the run blocked-risk without authorizing anything', async t => {
  const f = riskRecoveryFixture(t, 'interactive');
  await f.start();
  f.failRisk();
  await f.answer([[RISK_RECOVERY_LABELS.stop]]);
  assert.equal(f.stops(), 1);
  assert.equal(f.retries(), 0);
  assert.deepEqual(f.manualRoutes(), []);
  assert.equal(f.workflow().nextAction().kind, 'blocked-risk');
});

// A6: free text, a cancelled call, or a stale duplicate answer for this slot authorizes nothing.
test('risk recovery (A6): free text authorizes nothing and the same question is re-armed', async t => {
  const f = riskRecoveryFixture(t, 'interactive');
  await f.start();
  f.failRisk();
  await f.answer([['I need more time to think about this']]);
  assert.equal(f.retries(), 0);
  assert.deepEqual(f.manualRoutes(), []);
  assert.equal(f.stops(), 0);
  assert.equal(f.workflow().nextAction().kind, 'blocked-risk');
  const rearmed = f.gate.status(runtime.sessionID).question;
  assert.deepEqual(rearmed.questions[0].options.map(option => option.label),
    [RISK_RECOVERY_LABELS.retry, RISK_RECOVERY_LABELS.low, RISK_RECOVERY_LABELS.high, RISK_RECOVERY_LABELS.stop]);
});

test('risk recovery (A6): a cancelled native call authorizes neither a retry nor a route', async t => {
  const f = riskRecoveryFixture(t, 'interactive');
  await f.start();
  f.failRisk();
  const args = f.gate.status(runtime.sessionID).question;
  const call = { sessionID: runtime.sessionID, callID: 'recovery-cancel-1' };
  await f.gate.beforeQuestion(call, args);
  f.gate.nativeError(call);
  assert.equal(f.retries(), 0);
  assert.deepEqual(f.manualRoutes(), []);
  assert.equal(f.workflow().nextAction().kind, 'blocked-risk');
  assert.equal(f.gate.status(runtime.sessionID).state, 'stopped');
});

// A7: once a call already answered this exact slot, that same callID cannot answer again — a
// retried/altered or reused receipt for it must not authorize a second retry or route.
test('risk recovery (A7): a stale duplicate recovery answer cannot retry or choose a route again', async t => {
  const f = riskRecoveryFixture(t, 'interactive');
  await f.start();
  f.failRisk();
  const first = await f.answer([[RISK_RECOVERY_LABELS.retry]]);
  assert.equal(f.retries(), 1);
  await assert.rejects(f.gate.afterQuestion(first.call, first.args, output(first.args, [[RISK_RECOVERY_LABELS.low]])));
  assert.equal(f.retries(), 1);
  assert.deepEqual(f.manualRoutes(), []);
});

// A6: an envelope the coordinator altered before answering is never accepted, exactly like every
// other native question kind — options and defaults are MDD's to issue, never the caller's to edit.
test('risk recovery (A6): an envelope altered before answering is refused', async t => {
  const f = riskRecoveryFixture(t, 'interactive');
  await f.start();
  f.failRisk();
  const args = f.gate.status(runtime.sessionID).question;
  args.questions[0].options[0].label = 'Forged';
  const call = { sessionID: runtime.sessionID, callID: 'recovery-altered' };
  await assert.rejects(f.gate.beforeQuestion(call, args));
  assert.equal(f.retries(), 0);
  assert.deepEqual(f.manualRoutes(), []);
  assert.equal(f.stops(), 0);
});

// A7: once a free-text answer retires its call and re-arms the same question under a fresh call,
// the retired call's exact answer must not be replayable even though its wording looks valid.
test('risk recovery (A7): a retired call cannot replay once a fresh call has issued the question again', async t => {
  const f = riskRecoveryFixture(t, 'interactive');
  await f.start();
  f.failRisk();
  const first = await f.answer([['I need more time to think about this']]);
  assert.equal(f.retries(), 0);
  assert.deepEqual(f.manualRoutes(), []);
  // A genuinely new call for the re-armed question applies its exact choice exactly once.
  await f.answer([[RISK_RECOVERY_LABELS.low]]);
  assert.deepEqual(f.manualRoutes(), ['low']);
  // The original, now-retired free-text call cannot replay with a selection after the fresh one
  // has already settled the question it was re-armed into.
  await assert.rejects(f.gate.afterQuestion(first.call, first.args, output(first.args, [[RISK_RECOVERY_LABELS.high]])));
  assert.deepEqual(f.manualRoutes(), ['low']);
  assert.equal(f.retries(), 0);
});

// A5/A6: a cancelled native call authorizes nothing, but the recovery question is not lost — an
// explicit phase-scope reset reopens it from the same settled blocked-risk, and a fresh call can
// still resolve it afterward.
test('risk recovery: a cancelled recovery call can be reopened by reset and still resolves', async t => {
  const f = riskRecoveryFixture(t, 'interactive');
  await f.start();
  f.failRisk();
  const args = f.gate.status(runtime.sessionID).question;
  const call = { sessionID: runtime.sessionID, callID: 'recovery-cancel-reopen' };
  await f.gate.beforeQuestion(call, args);
  f.gate.nativeError(call);
  assert.equal(f.gate.status(runtime.sessionID).state, 'stopped');
  assert.equal(f.retries(), 0);
  assert.deepEqual(f.manualRoutes(), []);
  const reopened = f.gate.reset(runtime, 'phase');
  assert.notEqual(reopened.question, undefined);
  assert.deepEqual(reopened.question.questions[0].options.map(option => option.label),
    [RISK_RECOVERY_LABELS.retry, RISK_RECOVERY_LABELS.low, RISK_RECOVERY_LABELS.high, RISK_RECOVERY_LABELS.stop]);
  await f.answer([[RISK_RECOVERY_LABELS.retry]]);
  assert.equal(f.retries(), 1);
});

// Post-receipt checkpoint failure: the exact native answer is persisted first, so the choice
// itself is never lost, but if the guarded runner operation it then calls cannot confirm its own
// checkpoint (simulated here as retryRisk()/chooseManualRoute() throwing), the intake must never
// mark the run active or expose a task for work the runner itself refused to commit to.
for (const [label, faults, act] of [
  [RISK_RECOVERY_LABELS.retry, { retry: true }, f => f.answer([[RISK_RECOVERY_LABELS.retry]])],
  [RISK_RECOVERY_LABELS.low, { route: true }, f => f.answer([[RISK_RECOVERY_LABELS.low]])],
]) {
  test(`risk recovery: a runner checkpoint fault after '${label}' is persisted never marks the run active`, async t => {
    const f = riskRecoveryFixture(t, 'interactive', faults);
    await f.start();
    f.failRisk();
    await assert.rejects(act(f), /simulated runner checkpoint fault/);
    const after = f.gate.status(runtime.sessionID);
    assert.notEqual(after.state, 'active', 'a checkpoint fault must never leave the run marked active');
    assert.equal(after.task, undefined, 'no task is exposed for an operation the runner refused to commit to');
    // Nothing the fixture tracks reports a route or retry that the runner itself never confirmed.
    assert.equal(f.retries(), 0);
    assert.deepEqual(f.manualRoutes(), []);
  });
}

// ── Written answers ─────────────────────────────────────────────────────────────────────────────
// The form is how MDD asks, but a person who answered in their own words has answered. These cover
// both places those words can be (the form's own text box, and a chat message after the form was
// closed), every kind of question, and what is refused: an option the user did not write, a message
// already used, an answer to a question the user never saw.

// A call to the native question tool that the user closes, or that is interrupted.
async function dismiss(gate, callID) {
  const args = gate.status(runtime.sessionID).question;
  const call = { sessionID: runtime.sessionID, callID };
  await gate.beforeQuestion(call, args);
  gate.nativeError(call);
  return { args, call };
}

function written(f, userMessageID = 'msg_written') {
  const proofs = [];
  f.inspect.typed = async (_runtime, text, messageID, after) => { proofs.push({ text, messageID, after: [...after] }); return userMessageID; };
  return proofs;
}

test('written answers: an interrupted preflight answered in the chat starts the run without asking again', async t => {
  const f = await fixture(t, {});
  f.inspect.intake = async () => 'msg_start';
  await f.start();
  const { call } = await dismiss(f.gate, 'interrupted-preflight');
  assert.equal(f.gate.status(runtime.sessionID).state, 'stopped');
  assert.match(f.gate.status(runtime.sessionID).reason, /mdd_answer/);
  const proofs = written(f);
  const userText = '1. algo seguro 2. engram 3. automatico 4. medio 5. nada que agregar.';
  await f.gate.answer({ userText, answers: [{ labels: ['Algo seguro'] }, { labels: ['Engram'] }, { labels: ['Automático'] }, { labels: ['Medio'] }, { labels: [CLARIFICATION_LABELS.nothing] }] }, runtime, 'msg_caller');
  assert.equal(f.starts(), 1);
  assert.deepEqual(f.workflow().snapshot().answers, { ...f.workflow().snapshot().answers, certainty: 'somewhat-sure', artifactStore: 'engram', mode: 'automatic', summary: 'medium' });
  const status = f.gate.status(runtime.sessionID);
  assert.equal(status.provenance.preflight, 'typed-answer');
  assert.deepEqual(status.questionReceipts.at(-1).typed, { source: 'chat', userMessageID: 'msg_written' });
  // The proof was asked for the user's exact words, after the call that showed them the question.
  assert.deepEqual(proofs, [{ text: userText, messageID: 'msg_caller', after: [call.callID] }]);
});

test('written answers: the request that started the run never answers its own preflight', async t => {
  const f = await fixture(t, {});
  f.inspect.intake = async () => 'msg_start';
  await f.start();
  await dismiss(f.gate, 'closed-preflight');
  written(f, 'msg_start');
  await assert.rejects(f.gate.answer({ userText: 'Muy seguro, Ninguno, Automático, Bajo', answers: [{ labels: ['Muy seguro'] }, { labels: ['Ninguno'] }, { labels: ['Automático'] }, { labels: ['Bajo'] }, { labels: [] }] }, runtime, 'msg_caller'), /already used/);
  assert.equal(f.starts(), 0);
  assert.equal(f.gate.status(runtime.sessionID).state, 'stopped');
});

test('written answers: a closed approval is approved by the user\'s next message, recorded like the form', async t => {
  const f = await fixture(t, { ...answers, mode: 'interactive' });
  await f.start(); f.pass();
  f.gate.prepareAdvance({ questions: [] }, runtime);
  await dismiss(f.gate, 'closed-approval');
  assert.equal(f.gate.status(runtime.sessionID).state, 'paused');
  written(f);
  await f.gate.answer({ userText: 'Continuar', answers: [{ labels: [APPROVAL_LABELS.proceed] }] }, runtime, 'msg_caller');
  assert.equal(f.workflow().nextAction().kind, 'execute');
  const receipt = f.gate.status(runtime.sessionID).questionReceipts.at(-1);
  assert.equal(receipt.kind, 'approval');
  assert.deepEqual(receipt.answers, [[APPROVAL_LABELS.proceed]]);
  assert.match(receipt.callID, /^typed-/);
  // The same message cannot approve the next phase as well.
  f.pass();
  f.gate.prepareAdvance({ questions: [] }, runtime);
  await dismiss(f.gate, 'closed-approval-2');
  await assert.rejects(f.gate.answer({ userText: 'Continuar', answers: [{ labels: [APPROVAL_LABELS.proceed] }] }, runtime, 'msg_caller'), /already used/);
  assert.equal(f.workflow().nextAction().kind, 'approve');
});

test('written answers: a reading the user\'s words do not support records nothing and checks no history', async t => {
  const f = await fixture(t, { ...answers, mode: 'interactive' });
  await f.start(); f.pass();
  f.gate.prepareAdvance({ questions: [] }, runtime);
  await dismiss(f.gate, 'closed-approval');
  const proofs = written(f);
  const before = f.gate.status(runtime.sessionID).questionReceipts.length;
  await assert.rejects(f.gate.answer({ userText: 'sí, dale', answers: [{ labels: [APPROVAL_LABELS.proceed] }] }, runtime, 'msg_caller'), /did not write "Continuar"/);
  await assert.rejects(f.gate.answer({ userText: 'pausar no, continuar', answers: [{ labels: [APPROVAL_LABELS.proceed] }] }, runtime, 'msg_caller'), /ambiguous/);
  const status = f.gate.status(runtime.sessionID);
  assert.equal(status.state, 'paused');
  assert.equal(status.questionReceipts.length, before);
  assert.equal(f.workflow().nextAction().kind, 'approve');
  assert.equal(proofs.length, 0);
});

test('written answers: a question the user never saw cannot be answered in the chat', async t => {
  const f = await fixture(t, { ...answers, mode: 'interactive' });
  await f.start(); f.pass();
  f.gate.prepareAdvance({ questions: [] }, runtime);
  written(f);
  await assert.rejects(f.gate.answer({ userText: 'Continuar', answers: [{ labels: [APPROVAL_LABELS.proceed] }] }, runtime, 'msg_caller'), /not shown/);
  assert.equal(f.gate.status(runtime.sessionID).state, 'question-ready');
  assert.equal(f.workflow().nextAction().kind, 'approve');
});

test('written answers: a host that cannot prove the user\'s message records nothing', async t => {
  const f = await fixture(t, { ...answers, mode: 'interactive' });
  await f.start(); f.pass();
  f.gate.prepareAdvance({ questions: [] }, runtime);
  await dismiss(f.gate, 'closed-approval');
  f.inspect.typed = async () => { throw new Error('userText must be the user\'s exact latest message in this conversation, unchanged. Nothing was recorded.'); };
  await assert.rejects(f.gate.answer({ userText: 'Continuar', answers: [{ labels: [APPROVAL_LABELS.proceed] }] }, runtime, 'msg_caller'), /exact latest message/);
  assert.equal(f.gate.status(runtime.sessionID).state, 'paused');
  assert.equal(f.workflow().nextAction().kind, 'approve');
});

test('written answers: words typed inside the form are recorded once the option is read from them', async t => {
  const f = await fixture(t, { ...answers, mode: 'interactive' });
  await f.start(); f.pass();
  await f.answer([['continuar, dale']]);
  const stalled = f.gate.status(runtime.sessionID);
  assert.equal(stalled.state, 'question-ready');
  assert.match(stalled.notice, /mdd_answer \(omit userText\)/);
  await assert.rejects(f.gate.answer({ answers: [{ labels: [APPROVAL_LABELS.pause] }] }, runtime, 'msg_caller'), /did not write "Pausar"/);
  await f.gate.answer({ answers: [{ labels: [APPROVAL_LABELS.proceed], quote: 'continuar' }] }, runtime, 'msg_caller');
  assert.equal(f.workflow().nextAction().kind, 'execute');
  assert.deepEqual(f.gate.status(runtime.sessionID).questionReceipts.at(-1).typed, { source: 'form' });
});

test('written answers: form words belong to the showing they were typed in', async t => {
  const f = await fixture(t, { ...answers, mode: 'interactive' });
  await f.start(); f.pass();
  // Nothing was typed into this form at all.
  f.gate.prepareAdvance({ questions: [] }, runtime);
  await assert.rejects(f.gate.answer({ answers: [{ labels: [APPROVAL_LABELS.proceed] }] }, runtime, 'msg_caller'), /typed nothing/);
  await f.answer([['continuar, dale']]);
  // Asked again, the form is answered afresh; what was typed into the earlier one no longer counts.
  await dismiss(f.gate, 'asked-again');
  await assert.rejects(f.gate.answer({ answers: [{ labels: [APPROVAL_LABELS.proceed] }] }, runtime, 'msg_caller'), /typed nothing/);
  assert.equal(f.workflow().nextAction().kind, 'approve');
});

test('written answers: a closed route question is answered in the chat, including forcing the other route', async t => {
  const f = routeFixture(t, 'interactive');
  await f.start();
  f.pass('low');
  f.gate.prepareAdvance({ questions: [] }, runtime);
  await dismiss(f.gate, 'closed-route');
  assert.equal(f.gate.status(runtime.sessionID).state, 'paused');
  await f.gate.answer({ userText: 'Mejor forzar la otra ruta.', answers: [{ labels: [ROUTE_LABELS.force] }] }, runtime, 'msg_caller');
  assert.equal(f.forced(), 1);
  assert.equal(f.workflow().snapshot().routeOrigin, 'override');
});

test('written answers: a stopped risk recovery is resolved by the user\'s message', async t => {
  const f = riskRecoveryFixture(t, 'interactive');
  await f.start();
  f.failRisk();
  await dismiss(f.gate, 'closed-recovery');
  assert.equal(f.gate.status(runtime.sessionID).state, 'stopped');
  await f.gate.answer({ userText: 'ruta high', answers: [{ labels: [RISK_RECOVERY_LABELS.high] }] }, runtime, 'msg_caller');
  assert.deepEqual(f.manualRoutes(), ['high']);
  assert.equal(f.retries(), 0);
});

test('written answers: a change confirmation typed into the form stays open and is then confirmed', async t => {
  const f = await fixture(t, { ...answers, mode: 'interactive' });
  f.inspect.intake = async () => 'msg_start';
  await f.start(); f.pass();
  f.inspect.intake = async () => 'msg_change';
  await f.gate.changeRequest({ kind: 'material', userText: 'Cambiemos el alcance', requirements: 'Human requirements, now with exports' }, runtime, 'msg_caller');
  await f.answer([['confirmar el cambio!']]);
  const open = f.gate.status(runtime.sessionID);
  assert.equal(open.state, 'question-ready');
  assert.equal(open.question.questions[0].header, 'Cambio');
  await f.gate.answer({ answers: [{ labels: [CHANGE_LABELS.confirm] }] }, runtime, 'msg_caller');
  // Fresh typed scope consent replaces the run, not its accepted preference defaults.
  assert.equal(f.gate.status(runtime.sessionID).question, undefined);
  assert.equal(f.starts(), 2);
  assert.equal(f.workflow().snapshot().answers.mode, 'interactive');
  assert.deepEqual(f.workflow().snapshot().results, []);
  f.pass();
  assert.equal(f.workflow().nextAction().kind, 'approve', 'scope consent never approves the next phase');
});

test('written answers: nothing can be answered when no MDD question waits', async t => {
  const f = await fixture(t);
  await f.start();
  written(f);
  await assert.rejects(f.gate.answer({ userText: 'Continuar', answers: [{ labels: [APPROVAL_LABELS.proceed] }] }, runtime, 'msg_caller'), /No MDD question is waiting/);
});
