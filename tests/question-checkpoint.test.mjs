import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { NativeIntake } from '../dist/native-intake.js';
import { QuestionCheckpointStore, validateQuestionRecord, QUESTION_CHECKPOINT_BYTES } from '../dist/question-checkpoint.js';
import { Workflow } from '../dist/workflow.js';
import { defaultSettings } from '../dist/settings.js';
import { answers, runtime } from './adapter-fixture.mjs';

// The brief is the detail the short form leaves out. It is kept with the record, so a restored
// question still has it, and an issued question keeps it exactly like its envelope.
test('a question brief is kept with its record and bound like the envelope once issued', t => {
  const root = mkdtempSync(join(tmpdir(), 'mdd-question-brief-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new QuestionCheckpointStore(root);
  const args = { questions: [{ header: 'Cambio', question: '¿Confirmás el cambio? [MDD change x]', multiple: false, options: [{ label: 'Sí', description: 'Confirmar.' }] }] };
  const prepared = { version: 1, parent: runtime.sessionID, sequence: 0, runID: 'run-brief', requirements: 'Objective.', known: {}, state: 'prepared',
    slot: { kind: 'change', requirements: 'New objective.', args, brief: '**Requisitos propuestos:**\n> New objective.' }, clarifications: [], deferred: [], clarificationAnswers: [] };
  store.write(runtime.sessionID, prepared);
  assert.equal(store.read(runtime.sessionID).slot.brief, prepared.slot.brief);
  for (const brief of ['', '   ', 42]) assert.throws(() => validateQuestionRecord({ ...prepared, slot: { ...prepared.slot, brief } }), /brief/);
  const pending = { ...prepared, sequence: 1, state: 'pending', callID: 'call-brief' };
  store.write(runtime.sessionID, pending);
  assert.throws(() => store.write(runtime.sessionID, { ...pending, sequence: 2, state: 'cancelled', slot: { ...pending.slot, brief: 'Otro detalle.' } }), /durability/,
    'an issued question cannot change the detail it was shown with');
});

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

