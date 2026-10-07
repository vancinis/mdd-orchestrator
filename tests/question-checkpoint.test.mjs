import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { NativeIntake, ROUTE_LABELS, routeEnvelope, RISK_RECOVERY_LABELS, riskRecoveryEnvelope } from '../dist/native-intake.js';
import { QuestionCheckpointStore, validateQuestionRecord } from '../dist/question-checkpoint.js';
import { Workflow } from '../dist/workflow.js';
import { defaultSettings } from '../dist/settings.js';
import { answers, runtime } from './adapter-fixture.mjs';

/** Drives a fresh workflow through the mandatory exploration and risk stop every run now starts with. */
function throughRisk(workflow, route = 'low') {
  workflow.start('mdd-explore');
  workflow.recordResult({ phase: 'mdd-explore', outcome: 'passed', evidenceSummary: 'The question was explored.' });
  workflow.startRisk();
  workflow.recordRiskResult({ outcome: 'passed', evidenceSummary: `Risk is ${route}.`, route });
}
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
    throughRisk(workflow);
    // mdd-plan is no longer the first dispatch of the route (the risk stop is), so an interactive
    // profile requires its own approval before it can start, unlike the always-`execute` first phase.
    if (workflow.nextAction().kind === 'approve') workflow.approve('mdd-plan');
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

/** A minimal otherwise-valid record, built by hand so it does not depend on a live workflow. */
function riskReservationRecord(stable) {
  return {
    version: 1, parent: 'ses-risk', sequence: 0, runID: 'run-risk', requirements: 'Plan a safe change.',
    userMessageID: 'user-risk', known: {},
    reservation: { runID: 'run-risk', stable },
    checkpoint: { sequence: 0, digest: 'a'.repeat(64) },
    state: 'pending', callID: 'call-risk',
    slot: { kind: 'approval', phase: 'mdd-plan', args: { questions: [{ header: 'Aprobación', question: '¿Continuar?', multiple: false,
      options: [{ label: 'Continuar', description: 'Autorizar.' }] }] } },
    clarifications: [], deferred: [], clarificationAnswers: [],
  };
}

test('a question reserved against a settled risk boundary binds the exact run and checkpoint', () => {
  for (const stable of ['risk-ready', 'risk-blocked']) {
    const record = validateQuestionRecord(riskReservationRecord(stable));
    assert.deepEqual(record.reservation, { runID: 'run-risk', stable });
  }
});

test('risk-await-result is never a settled question reservation boundary', () => {
  assert.throws(() => validateQuestionRecord(riskReservationRecord('risk-await-result')), /Invalid question reservation/);
});

/**
 * D2/S1,S5: a route question is persisted and validated through the same record mechanism as an
 * approval, reserved against a settled risk boundary with the three continue/force/stop options.
 */
function routeRecord(overrides = {}) {
  const args = routeEnvelope('run-route', 'mdd-plan', { route: 'low', complexity: 'low', reason: 'The change is contained.' });
  return {
    version: 1, parent: 'ses-route', sequence: 0, runID: 'run-route', requirements: 'Plan a route decision.',
    userMessageID: 'user-route', known: {},
    reservation: { runID: 'run-route', stable: 'risk-ready' },
    checkpoint: { sequence: 0, digest: 'a'.repeat(64) },
    state: 'pending', callID: 'call-route',
    slot: { kind: 'route', phase: 'mdd-plan', args },
    clarifications: [], deferred: [], clarificationAnswers: [],
    ...overrides,
  };
}

test('D2/S1: a well-formed route record with continue/force/stop options is a valid question record', () => {
  const record = validateQuestionRecord(routeRecord());
  assert.equal(record.slot.kind, 'route');
  assert.deepEqual(record.slot.args.questions[0].options.map(option => option.label),
    [ROUTE_LABELS.continue, ROUTE_LABELS.force, ROUTE_LABELS.stop]);
});

test('D2/S5: an answered route record only accepts one of the three issued labels, never free text', () => {
  const base = { ...routeRecord(), state: 'answered', sequence: 1 };
  for (const label of [ROUTE_LABELS.continue, ROUTE_LABELS.force, ROUTE_LABELS.stop]) {
    assert.deepEqual(validateQuestionRecord({ ...base, answer: [[label]] }).answer, [[label]]);
  }
  // A free-text or altered answer is not an offered option: the record is malformed, not merely
  // unauthorized, so no caller downstream can mistake it for a valid route decision.
  assert.throws(() => validateQuestionRecord({ ...base, answer: [['I would rather decide later']] }), /Invalid native answer/);
  assert.throws(() => validateQuestionRecord({ ...base, answer: [[ROUTE_LABELS.continue, ROUTE_LABELS.force]] }), /Invalid native answer/);
});

/**
 * S2/D1: the risk-recovery slot is its own distinct kind, persisted and validated through the
 * same record mechanism as `route` and `approval`, reserved against a settled `blocked-risk`
 * boundary with the four retry/low/high/stop options.
 */
function riskRecoveryRecord(overrides = {}) {
  const args = riskRecoveryEnvelope('run-recovery', 'mdd-risk reported that the request cannot be substantiated on this evidence.');
  return {
    version: 1, parent: 'ses-recovery', sequence: 0, runID: 'run-recovery', requirements: 'Plan a change under a failed assessment.',
    userMessageID: 'user-recovery', known: {},
    reservation: { runID: 'run-recovery', stable: 'risk-blocked' },
    checkpoint: { sequence: 0, digest: 'a'.repeat(64) },
    state: 'pending', callID: 'call-recovery',
    slot: { kind: 'risk-recovery', args },
    clarifications: [], deferred: [], clarificationAnswers: [],
    ...overrides,
  };
}

test('risk recovery: a well-formed recovery record with the four retry/low/high/stop options is a valid question record', () => {
  const record = validateQuestionRecord(riskRecoveryRecord());
  assert.equal(record.slot.kind, 'risk-recovery');
  assert.equal(record.slot.phase, undefined, 'the recovery slot names no single phase of its own');
  assert.deepEqual(record.slot.args.questions[0].options.map(option => option.label),
    [RISK_RECOVERY_LABELS.retry, RISK_RECOVERY_LABELS.low, RISK_RECOVERY_LABELS.high, RISK_RECOVERY_LABELS.stop]);
});

test('risk recovery: an answered recovery record only accepts one of the four issued labels, never free text', () => {
  const base = { ...riskRecoveryRecord(), state: 'answered', sequence: 1 };
  for (const label of [RISK_RECOVERY_LABELS.retry, RISK_RECOVERY_LABELS.low, RISK_RECOVERY_LABELS.high, RISK_RECOVERY_LABELS.stop]) {
    assert.deepEqual(validateQuestionRecord({ ...base, answer: [[label]] }).answer, [[label]]);
  }
  // A free-text, altered or multi-select answer is not an offered option: the record is
  // malformed, not merely unauthorized, so no caller downstream can mistake it for a recovery
  // decision the user never actually made.
  assert.throws(() => validateQuestionRecord({ ...base, answer: [['I would rather decide later']] }), /Invalid native answer/);
  assert.throws(() => validateQuestionRecord({ ...base, answer: [['Forged']] }), /Invalid native answer/);
  assert.throws(() => validateQuestionRecord({ ...base, answer: [[RISK_RECOVERY_LABELS.retry, RISK_RECOVERY_LABELS.low]] }), /Invalid native answer/);
});

test('risk recovery: a recovery record reserved against the settled risk-blocked boundary is valid', () => {
  assert.deepEqual(validateQuestionRecord(riskRecoveryRecord()).reservation, { runID: 'run-recovery', stable: 'risk-blocked' });
  // risk-await-result is never a settled reservation boundary for any question kind, this one included.
  assert.throws(() => validateQuestionRecord(riskRecoveryRecord({ reservation: { runID: 'run-recovery', stable: 'risk-await-result' } })), /Invalid question reservation/);
});

/**
 * S9: a real `QuestionCheckpointStore` write/read roundtrip (actual local files, not just
 * in-memory `validateQuestionRecord`) for both the `route` and `risk-recovery` slot kinds, each
 * through the prepared → pending → answered → settled lifecycle the native intake actually
 * drives, so the on-disk binding (reservation, slot args, callID, answer) survives intact and an
 * invalid record fails closed instead of silently resuming.
 */
test('S9: QuestionCheckpointStore write/read roundtrips a route record end to end, and rejects a tampered one', t => {
  const root = mkdtempSync(join(tmpdir(), 'mdd-question-store-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new QuestionCheckpointStore(root);
  // `reservation` and `callID` only bind once the question is actually issued (`pending`),
  // exactly as the real native intake writes it; a `prepared` record never carries either yet.
  const { reservation: _unused, callID: _unusedCall, ...preparedBase } = routeRecord();
  const prepared = { ...preparedBase, state: 'prepared' };
  store.write('ses-route', prepared);
  assert.deepEqual(store.read('ses-route').slot, prepared.slot);
  const pending = { ...preparedBase, reservation: { runID: 'run-route', stable: 'risk-ready' }, state: 'pending', sequence: 1, callID: 'call-route-live' };
  store.write('ses-route', pending);
  assert.equal(store.read('ses-route').state, 'pending');
  assert.equal(store.read('ses-route').callID, 'call-route-live');
  const answered = { ...pending, state: 'answered', sequence: 2, answer: [[ROUTE_LABELS.force]] };
  store.write('ses-route', answered);
  const settledRecord = store.read('ses-route');
  assert.equal(settledRecord.state, 'answered');
  assert.deepEqual(settledRecord.answer, [[ROUTE_LABELS.force]]);
  assert.deepEqual(settledRecord.reservation, { runID: 'run-route', stable: 'risk-ready' });
  // Settling drops the spent answer, exactly as the real intake does once it is applied: a
  // settled record is never mistaken for one still carrying an authorizing answer.
  const { answer: _spent, ...answeredRest } = answered;
  const settled = { ...answeredRest, state: 'settled', sequence: 3 };
  store.write('ses-route', settled);
  assert.equal(store.read('ses-route').state, 'settled');
  // Writing a record with an answer that is not one of the issued route options fails closed:
  // the store never persists it, and the previously settled record on disk is untouched.
  assert.throws(() => store.write('ses-route', { ...settled, sequence: 4, answer: [['Forged']] }));
  assert.equal(store.read('ses-route').state, 'settled');
});

test('S9: QuestionCheckpointStore write/read roundtrips a risk-recovery record end to end, and rejects a tampered one', t => {
  const root = mkdtempSync(join(tmpdir(), 'mdd-question-store-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new QuestionCheckpointStore(root);
  const { reservation: _unused, callID: _unusedCall, ...preparedBase } = riskRecoveryRecord();
  const prepared = { ...preparedBase, state: 'prepared' };
  store.write('ses-recovery', prepared);
  assert.deepEqual(store.read('ses-recovery').slot, prepared.slot);
  const pending = { ...preparedBase, reservation: { runID: 'run-recovery', stable: 'risk-blocked' }, state: 'pending', sequence: 1, callID: 'call-recovery-live' };
  store.write('ses-recovery', pending);
  assert.equal(store.read('ses-recovery').callID, 'call-recovery-live');
  const answered = { ...pending, state: 'answered', sequence: 2, answer: [[RISK_RECOVERY_LABELS.high]] };
  store.write('ses-recovery', answered);
  const settledRecord = store.read('ses-recovery');
  assert.deepEqual(settledRecord.answer, [[RISK_RECOVERY_LABELS.high]]);
  assert.deepEqual(settledRecord.reservation, { runID: 'run-recovery', stable: 'risk-blocked' });
  // Settling drops the spent answer, exactly as the real intake does once it is applied: a
  // settled record is never mistaken for one still carrying an authorizing answer.
  const { answer: _spent, ...answeredRest } = answered;
  const settled = { ...answeredRest, state: 'settled', sequence: 3 };
  store.write('ses-recovery', settled);
  assert.equal(store.read('ses-recovery').state, 'settled');
  // A record claiming a reservation boundary risk-recovery never settles at (risk-await-result
  // is never settled for any kind) fails closed and leaves the stored settled record untouched.
  assert.throws(() => store.write('ses-recovery', { ...settled, sequence: 4, reservation: { runID: 'run-recovery', stable: 'risk-await-result' } }));
  assert.equal(store.read('ses-recovery').state, 'settled');
});

test('D2/S5: a route record cannot replay a retired call, even with a previously valid answer', () => {
  const settled = { ...routeRecord(), state: 'answered', sequence: 1, answer: [[ROUTE_LABELS.continue]], callID: 'call-route' };
  // Marking the exact answered call as retired, as the real store does once a receipt is spent,
  // makes the record reject itself: the same callID cannot both answer and be retired.
  assert.throws(() => validateQuestionRecord({ ...settled, retiredCalls: ['call-route'] }), /Invalid retired native call IDs/);
  // A fresh record for the next call, still carrying the old one in history, replays cleanly.
  const next = validateQuestionRecord({ ...settled, callID: 'call-route-2', retiredCalls: ['call-route'] });
  assert.deepEqual(next.retiredCalls, ['call-route']);
});

test('D2/S5: a cancelled route record carries no answer and cannot be mistaken for a settled one', () => {
  const cancelled = { ...routeRecord(), state: 'cancelled', sequence: 1, callID: undefined, answer: undefined };
  assert.throws(() => validateQuestionRecord(cancelled), /Invalid native question call correlation/);
  // 'cancelled' still requires a correlated callID (only prepared/withdrawn do not); the
  // cancellation keeps the call identity while dropping any answer.
  const properlyCancelled = { ...routeRecord(), state: 'cancelled', sequence: 1, callID: 'call-route', answer: undefined };
  assert.equal(validateQuestionRecord(properlyCancelled).answer, undefined);
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
  throughRisk(f.workflow());
  if (f.workflow().nextAction().kind === 'approve') f.workflow().approve('mdd-plan');
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
  throughRisk(f.workflow());
  if (f.workflow().nextAction().kind === 'approve') f.workflow().approve('mdd-plan');
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
