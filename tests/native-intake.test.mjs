import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativeIntake, approvalEnvelope, nativeQuestionAnswers } from '../dist/native-intake.js';
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
  const runner = {
    async start(input) { starts++; workflow = new Workflow(input.preflight); },
    status() { return workflow ? { runID: 'run-contract', state: blocked ? 'blocked' : 'phase-recorded', workflow: workflow.snapshot() } : { state: 'not-started' }; },
    approveNative(_session, phase) { workflow.approve(phase); },
    block() { blocked = true; },
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
    const args = gate.status(runtime.sessionID).question;
    const call = { sessionID: runtime.sessionID, callID: `question-${++ordinal}` };
    await gate.beforeQuestion(call, args);
    await gate.afterQuestion(call, args, output(args, selections));
    return { args, call };
  };
  const pass = () => { const next = workflow.nextAction(); workflow.start(next.phase); workflow.recordResult({ phase: next.phase, outcome: 'passed', evidenceSummary: 'Simulated trusted phase result.' }); gate.phaseRecorded(runtime.sessionID); };
  return { gate, runner, inspect, checks, settings, start, answer, pass, starts: () => starts, workflow: () => workflow };
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

test('native approval: Stop records refusal without approving or fabricating a phase failure', async t => {
  const f = await fixture(t, { ...answers, mode: 'interactive' });
  await f.start(); f.pass();
  await f.answer([['Detener']]);
  assert.equal(f.gate.status(runtime.sessionID).state, 'stopped');
  assert.equal(f.workflow().nextAction().kind, 'approve');
  assert.equal(f.workflow().snapshot().results.length, 1);
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

test('native question: Stop and cancellation do not reuse previous consent', async t => {
  const f = await fixture(t, { ...answers, mode: 'interactive' });
  await f.start(); f.pass();
  const previous = await f.answer([['Continuar']]);
  f.pass();
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
