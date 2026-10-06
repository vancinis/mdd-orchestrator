import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { NativeIntake } from '../dist/native-intake.js';
import { QuestionCheckpointStore, validateQuestionRecord } from '../dist/question-checkpoint.js';
import { Workflow } from '../dist/workflow.js';
import { defaultSettings } from '../dist/settings.js';
import { answers, runtime } from './adapter-fixture.mjs';

function output(args, selections) {
  const formatted = args.questions.map((question, index) => `"${question.question}"="${selections[index]?.join(', ') ?? 'Unanswered'}"`).join(', ');
  return { title: `Asked ${args.questions.length} question${args.questions.length === 1 ? '' : 's'}`,
    output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
    metadata: { answers: selections, truncated: false } };
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mdd-question-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new QuestionCheckpointStore(root);
  const settings = defaultSettings();
  settings.profiles.default.answers = { ...answers, mode: 'interactive' };
  let workflow;
  let blocked = false;
  let approvals = 0;
  let inspected = 0;
  let checkpointRunID = 'run-1';
  const runner = {
    async start(input) { workflow = new Workflow(input.preflight); },
    status() { return workflow ? { runID: 'run-1', state: blocked ? 'blocked' : 'ready', reportDetail: 'detailed', workflow: workflow.snapshot() } : { state: 'not-started' }; },
    approveNative(_session, phase) { approvals++; workflow.approve(phase); },
    block() { blocked = true; },
  };
  const inspect = { async intake() { return 'user-1'; }, async question() { inspected++; } };
  const gate = () => new NativeIntake(runner, inspect, settings, { questions: store,
    checkpoint: { read: () => ({ checkpoint: { version: 3, runID: checkpointRunID, sequence: 4, dataDigest: 'a'.repeat(64) } }) } });
  const start = async current => {
    await current.start({ requirements: 'Plan input validation.' }, runtime, 'user-1');
    workflow.start('mdd-plan');
    workflow.recordResult({ phase: 'mdd-plan', outcome: 'passed', evidenceSummary: 'Plan recorded.' });
    current.phaseRecorded(runtime.sessionID);
    current.prepareAdvance({ questions: [] }, runtime);
    return current.status(runtime.sessionID).question;
  };
  return { root, store, settings, runner, gate, start, approvals: () => approvals, inspected: () => inspected,
    changeCheckpointRunID: value => { checkpointRunID = value; }, workflow: () => workflow };
}

test('regression: clarification durable prepare answer settle retains long multibyte prose verbatim', async t => {
  const f = fixture(t);
  const intake = f.gate();
  await f.start(intake);
  intake.revisit(runtime);
  const question = '¿Qué configuración necesitás?\n"Ruta" \\ íntegra. '.repeat(100);
  const option = { label: 'Conservar íntegramente. '.repeat(600), description: 'No perder ningún detalle. '.repeat(30) };
  const answer = 'Usar esta respuesta íntegra.\n"Detalle" \\ final. '.repeat(300);
  intake.prepareAdvance({ questions: [{ question, options: [option] }] }, runtime);
  const records = [];
  const write = f.store.write.bind(f.store);
  t.mock.method(f.store, 'write', (parent, record) => { write(parent, record); records.push(f.store.read(parent)); });
  const args = intake.status(runtime.sessionID).question;
  const call = { sessionID: runtime.sessionID, callID: 'long-clarification' };
  await intake.beforeQuestion(call, args);
  await intake.afterQuestion(call, args, output(args, [[answer]]));
  const answered = records.find(record => record.state === 'answered');
  assert.equal(answered.slot.args.questions[0].question, args.questions[0].question);
  assert.deepEqual(answered.clarifications[0], { question, options: [{ ...option, recommended: false }], deferrable: false });
  assert.equal(answered.answer[0][0], answer);
  const approval = intake.status(runtime.sessionID).question;
  const approvalCall = { sessionID: runtime.sessionID, callID: 'approval-after-long-clarification' };
  await intake.beforeQuestion(approvalCall, approval);
  await intake.afterQuestion(approvalCall, approval, output(approval, [['Continuar']]));
  const reconstructed = new QuestionCheckpointStore(f.root).read(runtime.sessionID);
  assert.equal(reconstructed.state, 'settled');
  assert.equal(reconstructed.clarificationAnswers[0].question, question);
  assert.equal(reconstructed.clarificationAnswers[0].answer, answer);
  assert.equal(f.approvals(), 1);
  for (const value of ['', '  ', 42, null]) {
    assert.throws(() => validateQuestionRecord({ ...answered, answer: [[value]] }));
  }
  assert.throws(() => validateQuestionRecord({ ...answered, answer: [['á'.repeat(80000)]] }), /Invalid native question record/);
});

test('prepared and pending native questions survive a restart as blocked, never reissued', async t => {
  const f = fixture(t);
  const intake = f.gate();
  const args = await f.start(intake);
  const prepared = f.store.read(runtime.sessionID);
  assert.equal(prepared.state, 'prepared');
  assert.equal(prepared.runID, 'run-1');
  assert.deepEqual(prepared.checkpoint, { sequence: 4, digest: 'a'.repeat(64) });
  assert.deepEqual(prepared.slot.args, args);
  assert.equal(f.gate().status(runtime.sessionID).state, 'recovery-blocked');
  await assert.rejects(f.gate().start({ requirements: 'Plan input validation.' }, runtime, 'user-2'), /unresolved outcome/);
  const call = { sessionID: runtime.sessionID, callID: 'question-1' };
  await intake.beforeQuestion(call, args);
  assert.equal(f.store.read(runtime.sessionID).state, 'pending');
  assert.equal(f.store.read(runtime.sessionID).callID, call.callID);
  assert.equal(f.gate().status(runtime.sessionID).question, undefined);
  assert.equal(f.approvals(), 0);
});

test('answered but unapplied native callback cannot approve from durable history', async t => {
  const f = fixture(t);
  const intake = f.gate();
  const args = await f.start(intake);
  const call = { sessionID: runtime.sessionID, callID: 'question-2' };
  await intake.beforeQuestion(call, args);
  f.runner.approveNative = () => { throw new Error('Approval transition failed after recording the answer.'); };
  await assert.rejects(intake.afterQuestion(call, args, output(args, [['Continuar']])), /Approval transition failed/);
  const saved = f.store.read(runtime.sessionID);
  assert.equal(saved.state, 'answered');
  assert.deepEqual(saved.answer, [['Continuar']]);
  assert.equal(f.workflow().nextAction().kind, 'approve');
  assert.equal(f.gate().status(runtime.sessionID).state, 'recovery-blocked');
});

test('native cancellation records no answer and cannot grant approval', async t => {
  const f = fixture(t);
  const intake = f.gate();
  const args = await f.start(intake);
  const call = { sessionID: runtime.sessionID, callID: 'question-3' };
  await intake.beforeQuestion(call, args);
  intake.nativeError(call);
  const saved = f.store.read(runtime.sessionID);
  assert.equal(saved.state, 'cancelled');
  assert.equal(saved.answer, undefined);
  assert.equal(f.approvals(), 0);
  assert.equal(f.workflow().nextAction().kind, 'approve');
});

test('question record rejects tampered answers, foreign parent and damaged local bytes', async t => {
  const f = fixture(t);
  const intake = f.gate();
  await f.start(intake);
  const saved = f.store.read(runtime.sessionID);
  assert.throws(() => validateQuestionRecord({ ...saved, answer: [['Continuar']] }));
  assert.throws(() => f.store.write(runtime.sessionID, { ...saved, sequence: 1, parent: 'other' }));
  const path = join(f.root, '.mdd', `question-${createHash('sha256').update(runtime.sessionID).digest('hex')}.json`);
  writeFileSync(path, '{');
  assert.throws(() => f.store.read(runtime.sessionID), /cannot be read safely/);
});

test('a stored native answer must match the exact pending call and envelope', async t => {
  const f = fixture(t);
  const intake = f.gate();
  const args = await f.start(intake);
  const call = { sessionID: runtime.sessionID, callID: 'question-bound' };
  await intake.beforeQuestion(call, args);
  const pending = f.store.read(runtime.sessionID);
  const answered = { ...pending, sequence: pending.sequence + 1, state: 'answered', answer: [['Continuar']] };
  assert.throws(() => f.store.write(runtime.sessionID, { ...answered, callID: 'other-call' }));
  assert.throws(() => f.store.write(runtime.sessionID, { ...answered, slot: { ...answered.slot, args: { questions: [{ ...args.questions[0], question: 'Different question' }] } } }));
  assert.equal(f.store.read(runtime.sessionID).state, 'pending');
});

test('a stale checkpoint or failed prepared write prevents question exposure', async t => {
  const f = fixture(t);
  const intake = f.gate();
  await intake.start({ requirements: 'Plan input validation.' }, runtime, 'user-1');
  f.workflow().start('mdd-plan');
  f.workflow().recordResult({ phase: 'mdd-plan', outcome: 'passed', evidenceSummary: 'Plan recorded.' });
  intake.phaseRecorded(runtime.sessionID);
  f.changeCheckpointRunID('other-run');
  assert.throws(() => intake.prepareAdvance({ questions: [] }, runtime), /cannot be bound/);
  assert.equal(intake.status(runtime.sessionID).question, undefined);
  assert.equal(f.inspected(), 0);
});

test('failed answer write cancels the call instead of locking the parent, and cannot approve', async t => {
  const f = fixture(t);
  const intake = f.gate();
  const args = await f.start(intake);
  const call = { sessionID: runtime.sessionID, callID: 'question-fault' };
  await intake.beforeQuestion(call, args);
  const original = f.store.write.bind(f.store);
  f.store.write = (parent, value) => {
    if (value.state === 'answered') throw new Error('Simulated readback failure.');
    return original(parent, value);
  };
  await assert.rejects(intake.afterQuestion(call, args, output(args, [['Continuar']])), /Simulated readback failure/);
  // The call ended without a recorded answer: it is cancelled, never approved, and nothing is left pending.
  assert.equal(f.store.read(runtime.sessionID).state, 'cancelled');
  assert.equal(f.store.read(runtime.sessionID).answer, undefined);
  assert.equal(f.approvals(), 0);
  assert.notEqual(f.gate().status(runtime.sessionID).state, 'recovery-blocked');
  await assert.rejects(intake.afterQuestion(call, args, output(args, [['Continuar']])));
  assert.equal(f.approvals(), 0);
});

test('deferred clarification and its native response remain unresolved through the next approval', async t => {
  const f = fixture(t);
  const intake = f.gate();
  await intake.start({ requirements: 'Plan input validation.' }, runtime, 'user-1');
  f.workflow().start('mdd-plan');
  f.workflow().recordResult({ phase: 'mdd-plan', outcome: 'passed', evidenceSummary: 'Plan recorded.' });
  intake.phaseRecorded(runtime.sessionID);
  intake.prepareAdvance({ questions: [{ question: 'Which input shape?', options: [{ label: 'Strict', description: 'Reject unknown input.' }], deferrable: true }] }, runtime);
  const args = intake.status(runtime.sessionID).question;
  assert.equal(f.store.read(runtime.sessionID).clarifications[0].question, 'Which input shape?');
  const call = { sessionID: runtime.sessionID, callID: 'clarification-1' };
  await intake.beforeQuestion(call, args);
  await intake.afterQuestion(call, args, output(args, [['Dejar para más adelante']]));
  const next = f.store.read(runtime.sessionID);
  assert.equal(next.state, 'prepared');
  assert.equal(next.slot.kind, 'approval');
  assert.equal(next.deferred[0].question, 'Which input shape?');
  assert.equal(next.clarificationAnswers[0].disposition, 'deferred');
  assert.equal(f.approvals(), 0);
});

test('explicit run discard permits a fresh question but never reuses the old approval', async t => {
  const f = fixture(t);
  const intake = f.gate();
  const args = await f.start(intake);
  const call = { sessionID: runtime.sessionID, callID: 'question-old' };
  await intake.beforeQuestion(call, args);
  assert.equal(f.gate().status(runtime.sessionID).state, 'recovery-blocked');
  const restarted = f.gate();
  restarted.reset(runtime, 'run');
  assert.equal(f.store.read(runtime.sessionID), undefined);
  f.settings.profiles.default.answers = {};
  const fresh = f.gate();
  const status = await fresh.start({ requirements: 'Plan input validation.' }, runtime, 'new-user-message');
  assert.equal(status.state, 'question-ready');
  assert.equal(f.store.read(runtime.sessionID).state, 'prepared');
  assert.equal(f.approvals(), 0);
});
