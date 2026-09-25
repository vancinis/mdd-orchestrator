import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativeIntake, approvalEnvelope, nativeQuestionAnswers, CLARIFICATION_LABELS, APPROVAL_LABELS, UnselectedAnswer } from '../dist/native-intake.js';
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
  const pass = () => { const next = workflow.nextAction(); workflow.start(next.phase); workflow.recordResult({ phase: next.phase, outcome: 'passed', evidenceSummary: 'Simulated trusted phase result.' }); gate.phaseRecorded(runtime.sessionID); };
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
    assert.equal(status.question.questions.length, 5 - Object.keys(known).length);
    assert.equal(f.starts(), 0);
    const labels = { Certeza: 'Muy seguro', Artefactos: 'Ninguno', Modo: 'Automático', Resumen: 'Bajo', Complejidad: 'Poco complejo' };
    const selections = status.question.questions.map(q => [labels[q.header]]);
    status.question.questions[0].question = 'mutated snapshot';
    await f.answer(selections);
    assert.deepEqual(f.workflow().snapshot().answers, answers);
    assert.equal(f.gate.status(runtime.sessionID).provenance.preflight, 'native-question');
    assert.equal(f.checks.filter(check => check[0] === 'question').length, 2);
    assert.equal(f.starts(), 1);
  });
}

for (const route of ['low', 'high']) {
  for (const mode of ['automatic', 'interactive']) {
    test(`native gate state contract: full ${route} ${mode} route has exact approval slots`, async t => {
      const known = { ...answers, mode, ...(route === 'high' ? { complexity: 'very-complex', certainty: 'not-sure' } : {}) };
      const f = await fixture(t, known);
      await f.start();
      const phases = f.workflow().snapshot().evaluation.phases;
      assert.equal(f.gate.status(runtime.sessionID).question, undefined);
      for (let index = 0; index < phases.length; index++) {
        assert.deepEqual(f.workflow().nextAction(), { kind: 'execute', phase: phases[index] });
        f.pass();
        if (mode === 'interactive' && index !== phases.length - 1) {
          assert.equal(f.gate.status(runtime.sessionID).state, 'review-ready');
          f.gate.prepareAdvance({ questions: [] }, runtime);
        }
        const status = f.gate.status(runtime.sessionID);
        if (index === phases.length - 1 || mode === 'automatic') assert.equal(status.question, undefined);
        else {
          assert.deepEqual(status.question, approvalEnvelope('run-contract', phases[index + 1]));
          await f.answer([['Continuar']]);
          assert.equal(f.gate.status(runtime.sessionID).question, undefined);
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

test('review questions precede approval and retain recommended, delegated, deferred and free-text answers', async t => {
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
  assert.deepEqual(f.gate.status(runtime.sessionID).question.questions[0].options.map(option => option.label), ['Centered (Recomendada)', 'Edge', CLARIFICATION_LABELS.delegate]);
  await f.answer([['Centered (Recomendada)']]);
  assert.match(f.gate.status(runtime.sessionID).question.questions[0].question, /^Which date format\? \[MDD clarification /);
  await f.answer([[CLARIFICATION_LABELS.defer]]);
  await f.answer([[CLARIFICATION_LABELS.delegate]]);
  await f.answer([['Use this exact custom wording']]);
  assert.deepEqual(f.gate.status(runtime.sessionID).clarificationAnswers.map(item => item.answer),
    ['Centered (Recomendada)', CLARIFICATION_LABELS.defer, CLARIFICATION_LABELS.delegate, 'Use this exact custom wording']);
  assert.equal(f.gate.status(runtime.sessionID).clarificationAnswers[1].disposition, 'deferred');
  assert.deepEqual(f.gate.status(runtime.sessionID).pendingClarifications.map(item => item.question), ['Which date format?']);
  assert.equal(f.contributions.length, 4);
  assert.match(f.contributions[1].content, /unresolved.*Do not assume/);
  assert.deepEqual(f.contributions[3], { label: 'Clarification: What copy?', content: 'Answer: Use this exact custom wording' });
  assert.equal(f.gate.status(runtime.sessionID).question.questions[0].header, 'Aprobación');
  assert.equal(f.workflow().nextAction().kind, 'approve');
  await f.answer([[APPROVAL_LABELS.proceed]]);
  assert.equal(f.workflow().nextAction().kind, 'execute');
});

test('deferred clarification is unresolved through approval and returns after the next phase, not immediately', async t => {
  const f = await fixture(t, { ...answers, mode: 'interactive', complexity: 'very-complex', certainty: 'not-sure' });
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
  await f.gate.afterQuestion(call, args, output(args, [['Muy seguro'], ['Ninguno'], ['Automático'], ['Bajo'], ['Poco complejo']]));
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

for (const selections of [[], [['forged']], [['Muy seguro', 'Poco seguro']], [['Muy seguro', 'Poco seguro'], ['Ninguno'], ['Automático'], ['Bajo'], ['Poco complejo']]]) {
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
  await f.answer([['Ninguno'], ['Muy seguro'], ['Automático'], ['Bajo'], ['Poco complejo']]);
  const stalled = f.gate.status(runtime.sessionID);
  assert.equal(stalled.state, 'question-ready');
  assert.ok(stalled.question);
  assert.equal(f.starts(), 0);
  assert.equal(stalled.questionReceipts.at(-1).cancelled, true);
  assert.equal(stalled.questionReceipts.at(-1).answers.length, 0);
  await f.answer([['Muy seguro'], ['Ninguno'], ['Automático'], ['Bajo'], ['Poco complejo']]);
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
  await assert.rejects(f.gate.afterQuestion(call, args, output(args, [['Muy seguro'], ['Ninguno'], ['Automático'], ['Bajo'], ['Poco complejo']])));
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
  const raw = output(args, [['Muy seguro'], ['Ninguno'], ['Automático'], ['Bajo'], ['Poco complejo']]);
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
