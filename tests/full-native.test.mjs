import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, cp } from 'node:fs/promises';
import fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { createLegacyPlugin as plugin } from '../dist/opencode-plugin.js';
import { defaultSettings, MODEL_ROLES } from '../dist/settings.js';
import { saveGlobalSettings } from '../dist/global-settings.js';
import { memoryServer, installCleanup, isolateHome, answers, structuredTraceFixture as traceFixture, reportDocument, riskReport } from './adapter-fixture.mjs';
import { traceArtifact } from '../dist/acceptance.js';
import { ManagedMemory } from '../dist/managed-memory.js';
import { STATUS_BUDGET_BYTES, STATUS_COMPACT_KEEP, STATUS_DROP_ORDER, STATUS_PROTECTED_FIELDS } from '../dist/status-budget.js';
import { retroReport } from '../dist/retro.js';
import { collapsedPrompt } from '../dist/dispatch-transcript.js';
import { QuestionCheckpointStore } from '../dist/question-checkpoint.js';
import { RunOwnershipStore } from '../dist/run-ownership.js';
import { CheckpointStore } from '../dist/checkpoint.js';
import { ProgressGuard } from '../dist/progress.js';
import { RunDossierStore } from '../dist/run-dossier.js';
import { projectApprovalTransfer, projectTargetTransfer } from '../dist/transfer.js';
import { Workflow } from '../dist/workflow.js';

for (const phase of ['mdd-explore', 'mdd-risk', 'mdd-plan', 'mdd-propose', 'mdd-spec', 'mdd-design', 'mdd-tasks', 'mdd-apply', 'mdd-verify']) {
  test(`SA-1: composed ${phase} prompt keeps phase authority and evidence handoff`, async t => {
    const route = ['mdd-propose', 'mdd-spec', 'mdd-design', 'mdd-tasks'].includes(phase) ? 'high' : 'low';
    const f = await fixture(t, { route, memoryEnabled: false });
    while (true) {
      const status = await f.status();
      if ((status.stage ?? status.phase) === phase) break;
      await f.phase({ only: true });
    }
    await f.phase({ only: true });
    const prompt = f.delivered();
    assert.doesNotMatch(prompt, /change sources only if the phase genuinely requires it/);
    const provenance = JSON.parse(prompt.match(/^Packaged MDD actor instructions with provenance, which govern this (?:phase|assessment): (.*)$/m)[1]);
    assert.equal(provenance.content, fs.readFileSync('assets/opencode/mdd-instructions.md', 'utf8'));
    assert.equal(provenance.digest, createHash('sha256').update(provenance.content).digest('hex'));
    if (phase === 'mdd-apply') {
      assert.match(prompt, /This phase implements: edit the sources the plan calls for/);
      assert.match(prompt, /integration assumptions and deferred integration checks/);
    } else if (phase === 'mdd-verify') {
      assert.match(prompt, /Verify is read-only for project sources/);
      assert.match(prompt, /ordinary generated test\/build outputs/);
      assert.match(prompt, /never repair sources/);
    } else if (!['mdd-explore', 'mdd-risk'].includes(phase)) {
      assert.match(prompt, /Planning is read-only for project sources/);
      assert.match(prompt, /never implement or repair sources/);
    }
    const expectations = {
      'mdd-explore': /searched scope, concrete source references and coverage gaps/,
      'mdd-risk': /identifiable Explore findings/,
      'mdd-plan': /assigned completion checks from deferred integration verification/,
      'mdd-propose': /Separate observed evidence, constraints and assumptions/,
      'mdd-spec': /completeness against the original user request/,
      'mdd-design': /existing implementation seams and important constraints/,
      'mdd-tasks': /assigned completion checks from deferred integration verification/,
    };
    if (expectations[phase]) assert.match(prompt, expectations[phase]);
  });
}

test('opt-in same-parent restart restores ready Verify from validated local dependencies, memory off', async t => {
  const f = await fixture(t, { memoryEnabled: false, store: 'none' });
  await f.hooks.tool.mdd_context.execute({ label: 'Issue context', content: 'The validated input boundary must preserve prior behavior. '.repeat(200) }, f.context);
  await f.phase();
  await f.phase();
  assert.equal((await f.status()).phase, 'mdd-verify');
  const resumed = await plugin(f.input);
  const status = JSON.parse(await resumed.tool.mdd_status.execute({ detail: 'full' }, f.context));
  assert.equal(status.state, 'ready');
  assert.equal(status.phase, 'mdd-verify');
  assert.equal(status.workflow.results.length, 3); // + the exploration every run now starts with
  assert.equal(status.workflow.nextAction.phase, 'mdd-verify');
  assert.equal(status.planned.length, 1);
  assert.equal(status.evidence.implementation, 'confirmed');
  const args = structuredClone(status.task);
  const call = { sessionID: f.runtime.sessionID, callID: 'task-restored-verify', tool: 'task' };
  f.parent[1].parts = [{ type: 'tool', tool: 'task', callID: call.callID, state: { status: 'running', input: structuredClone(args) } }];
  await resumed['tool.execute.before'](call, { args });
  assert.match(args.prompt, /Artifact for mdd-plan/);
  assert.match(args.prompt, /Artifact for mdd-apply/);
  assert.match(args.prompt, /validated input boundary must preserve prior behavior/);
});

test('opt-in pending child releases only after explicit stopped-child confirmation', async t => {
  const f = await fixture(t, { memoryEnabled: false, store: 'none' });
  await f.phase();
  const ready = await f.status();
  const args = structuredClone(ready.task);
  const call = { sessionID: f.runtime.sessionID, callID: 'task-interrupted-apply', tool: 'task' };
  f.parent[1].parts = [{ type: 'tool', tool: 'task', callID: call.callID, state: { status: 'running', input: structuredClone(args) } }];
  await f.hooks['tool.execute.before'](call, { args });
  const resumed = await plugin(f.input);
  const blocked = JSON.parse(await resumed.tool.mdd_status.execute({ detail: 'full' }, f.context));
  assert.equal(blocked.state, 'recovery-blocked');
  assert.equal(blocked.task, undefined);
  // What the coordinator is told to do must be the call that keeps this run, never scope run.
  assert.equal(blocked.nextAction.tool, 'mdd_reset');
  assert.notDeepEqual(blocked.nextAction.args, { scope: 'run' });
  assert.match(blocked.nextAction.why, /scope phase/);
  f.user('I stopped the interrupted subagent.');
  const released = JSON.parse(await resumed.tool.mdd_reset.execute({ scope: 'phase', userText: 'I stopped the interrupted subagent.' }, f.context));
  assert.equal(released.state, 'ready');
  assert.equal(released.runID, ready.runID);
  assert.equal(released.phase, 'mdd-apply');
  assert.equal(released.question, undefined, 'continuing never asks the preflight again');
  assert.deepEqual(released.workflow.results.map(item => item.phase), ready.workflow.results.map(item => item.phase));
  assert.notEqual(released.task.prompt, ready.task.prompt);
});

// A risk-routed run (explored, assessed, planned, interrupted in apply) restarts on the tail its
// replayed verdict selected, whatever its answers would score now. A score-routed legacy route
// stapled onto that history contradicts it and is refused rather than trusted.
for (const recorded of [true, false]) {
  test(`a restart keeps a risk-routed run whatever its score says, and refuses a stapled legacy route (${recorded ? 'stapled route' : 'record without route'})`, async t => {
    const f = await fixture(t, { route: 'low-explore', memoryEnabled: false, store: 'none' });
    await f.phase();
    await f.phase();
    const ready = await f.status();
    assert.equal(ready.phase, 'mdd-apply');
    const file = join(f.root, '.mdd', `checkpoint-${createHash('sha256').update(f.runtime.sessionID).digest('hex')}.json`);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    // A new run records no route: its replayed mdd-risk verdict is what selects the tail.
    assert.equal(saved.request.route, undefined, 'a new run records no route');
    // Answers whose diagnostic score would differ change nothing: no score routes the run.
    saved.request.answers.certainty = 'very-sure';
    // A score-routed route stapled onto a risk-routed history is a contradiction, never authority.
    if (recorded) saved.request.route = ['mdd-explore', 'mdd-plan', 'mdd-apply', 'mdd-verify'];
    await writeFile(file, JSON.stringify(saved));
    const resumed = await plugin(f.input);
    const status = JSON.parse(await resumed.tool.mdd_status.execute({ detail: 'full' }, f.context));
    if (recorded) {
      assert.equal(status.state, 'recovery-blocked');
      assert.equal(status.task, undefined);
      return;
    }
    assert.equal(status.state, 'ready', status.reason);
    assert.equal(status.runID, ready.runID);
    assert.equal(status.phase, 'mdd-apply');
    assert.equal(status.question, undefined);
    assert.deepEqual(status.workflow.results.map(item => item.phase), ['mdd-explore', 'mdd-plan']);
    assert.deepEqual(status.workflow.evaluation.phases, ['mdd-explore', 'mdd-plan', 'mdd-apply', 'mdd-verify']);
    assert.ok(status.task, 'the interrupted phase is ready to dispatch again');
  });
}

test('two restored plugins racing reset never both replay a pending child', async t => {
  const f = await fixture(t, { memoryEnabled: false, store: 'none' });
  await f.phase();
  const ready = await f.status();
  const task = structuredClone(ready.task);
  const call = { sessionID: f.runtime.sessionID, callID: 'task-racing-reset', tool: 'task' };
  f.parent[1].parts = [{ type: 'tool', tool: 'task', callID: call.callID, state: { status: 'running', input: structuredClone(task) } }];
  await f.hooks['tool.execute.before'](call, { args: task });
  const plugins = await Promise.all([plugin(f.input), plugin(f.input)]);
  f.user('I stopped the interrupted subagent.');
  const results = await Promise.allSettled(plugins.map(instance => instance.tool.mdd_reset.execute(
    { scope: 'phase', userText: 'I stopped the interrupted subagent.' }, f.context)));
  assert.ok(results.filter(item => item.status === 'fulfilled').length <= 1);
  const owner = new RunOwnershipStore(f.root).read(ready.runID);
  assert.ok(owner.state === 'idle' || (owner.state === 'reserved' && !!owner.recovery));
  await assert.rejects(plugins[0]['tool.execute.after']({ ...call, args: task }, { output: 'stale' }));
});

test('a reset handoff that crashed is released only on the user\'s word and never replays the old child', async t => {
  const f = await fixture(t, { memoryEnabled: false, store: 'none' });
  await f.phase();
  const ready = await f.status();
  const args = structuredClone(ready.task);
  const call = { sessionID: f.runtime.sessionID, callID: 'task-before-reset-crash', tool: 'task' };
  f.parent[1].parts = [{ type: 'tool', tool: 'task', callID: call.callID, state: { status: 'running', input: structuredClone(args) } }];
  await f.hooks['tool.execute.before'](call, { args });
  const checkpoint = new CheckpointStore(f.root).read(f.runtime.sessionID).checkpoint;
  const owners = new RunOwnershipStore(f.root);
  const owner = owners.read(ready.runID);
  const recovery = { sourceCallID: call.callID, kind: 'task', checkpointSequence: checkpoint.sequence, checkpointDigest: checkpoint.dataDigest };
  owners.handoff(ready.runID, f.runtime.sessionID, call.callID, 'reset-interrupted', owner.epoch, recovery);
  const resumed = await plugin(f.input);
  assert.match(JSON.parse(await resumed.tool.mdd_status.execute({}, f.context)).reason, /reset handoff.*unchanged/);
  await assert.rejects(f.hooks['tool.execute.after']({ ...call, args }, { output: 'old child result' }));
  // Without the user's own word nothing is released.
  await assert.rejects(resumed.tool.mdd_reset.execute({ scope: 'phase' }, f.context), /reset handoff.*userText/);
  assert.equal(owners.read(ready.runID).callID, 'reset-interrupted');
  f.user(STOPPED);
  const released = JSON.parse(await resumed.tool.mdd_reset.execute({ scope: 'phase', userText: STOPPED }, f.context));
  assert.equal(released.state, 'ready');
  assert.equal(released.runID, ready.runID);
  assert.equal(released.phase, 'mdd-apply');
  assert.equal(owners.read(ready.runID).state, 'idle');
  assert.equal(new ProgressGuard(f.root).read(f.runtime.sessionID).state, 'settled');
  // The old child cannot report into the released attempt.
  await assert.rejects(resumed['tool.execute.after']({ ...call, args }, { output: 'old child result' }));
});

test('a crashed coordinator operation whose checkpoint drifted allows only an attested run discard', async t => {
  const f = await fixture(t, { memoryEnabled: false, store: 'none' });
  await f.phase();
  const ready = await f.status();
  const saved = new CheckpointStore(f.root).read(f.runtime.sessionID).checkpoint;
  const owners = new RunOwnershipStore(f.root);
  owners.reserve(ready.runID, f.runtime.sessionID, 'operation-crashed', owners.read(ready.runID).epoch,
    { name: 'mdd_context', checkpointSequence: saved.sequence - 1, checkpointDigest: 'a'.repeat(64) });
  const resumed = await plugin(f.input);
  assert.match(JSON.parse(await resumed.tool.mdd_status.execute({}, f.context)).reason, /mdd_context.*different/);
  f.user(STOPPED);
  await assert.rejects(resumed.tool.mdd_reset.execute({ scope: 'phase', userText: STOPPED }, f.context), /only.*scope run/);
  assert.equal(owners.read(ready.runID).callID, 'operation-crashed');
  await assert.rejects(resumed.tool.mdd_reset.execute({ scope: 'run' }, f.context), /userText/);
  const discarded = JSON.parse(await resumed.tool.mdd_reset.execute({ scope: 'run', userText: STOPPED }, f.context));
  assert.equal(discarded.reset.scope, 'run');
  assert.ok(discarded.reset.preserved, 'the discarded evidence is set aside, not deleted');
  assert.equal(owners.read(ready.runID).state, 'idle');
  assert.equal(owners.parent(f.runtime.sessionID), undefined);
});

test('read-only coordinator tools never take the durable run reservation', async t => {
  const f = await fixture(t, { memoryEnabled: false, store: 'none' });
  await f.phase();
  const reserve = t.mock.method(RunOwnershipStore.prototype, 'reserve');
  f.user('Remember that the plan summary was too terse.');
  await f.hooks.tool.mdd_improve.execute({ userText: 'Remember that the plan summary was too terse.', title: 'Terse plan', detail: 'The plan summary omitted the reasoning.' }, f.context);
  f.user('Draft the PR body.');
  await f.hooks.tool.mdd_pr_body.execute({ userText: 'Draft the PR body.' }, f.context);
  await f.hooks.tool.mdd_check_report.execute({ phase: 'mdd-apply', result: 'not a report' }, f.context);
  await f.hooks.tool.mdd_improvements.execute({}, f.context);
  await f.hooks.tool.mdd_status.execute({}, f.context);
  assert.equal(reserve.mock.callCount(), 0);
});

test('a crashed question reset handoff re-presents a fresh question on the user\'s word and never accepts the old answer', async t => {
  const f = await fixture(t, { mode: 'interactive', store: 'none', memoryEnabled: false });
  await f.phase();
  const ready = await f.status();
  const args = structuredClone(ready.question);
  const call = { sessionID: f.runtime.sessionID, callID: 'question-before-reset-crash', tool: 'question' };
  f.parent[1].parts = [{ type: 'tool', tool: 'question', callID: call.callID, sessionID: f.runtime.sessionID,
    messageID: f.context.messageID, state: { status: 'running', input: structuredClone(args) } }];
  await f.hooks['tool.execute.before'](call, { args });
  const questions = new QuestionCheckpointStore(f.root);
  const pending = questions.read(f.runtime.sessionID);
  const checkpoint = new CheckpointStore(f.root).read(f.runtime.sessionID).checkpoint;
  const owners = new RunOwnershipStore(f.root);
  const owner = owners.read(ready.runID);
  owners.handoff(ready.runID, f.runtime.sessionID, call.callID, 'reset-question-interrupted', owner.epoch,
    { sourceCallID: call.callID, kind: 'question', checkpointSequence: checkpoint.sequence, checkpointDigest: checkpoint.dataDigest });
  const resumed = await plugin(f.input);
  assert.match(JSON.parse(await resumed.tool.mdd_status.execute({}, f.context)).reason, /reset handoff/);
  const oldAnswer = { title: 'Asked 1 question', output: `User has answered your questions: "${args.questions[0].question}"="Continuar". You can now continue with the user's answers in mind.`,
    metadata: { answers: [['Continuar']], truncated: false } };
  await assert.rejects(f.hooks['tool.execute.after']({ ...call, args }, oldAnswer));
  assert.equal(questions.read(f.runtime.sessionID).state, pending.state);
  await assert.rejects(resumed.tool.mdd_reset.execute({ scope: 'phase' }, f.context), /reset handoff.*userText/);
  f.user('I stopped the interrupted question.');
  const recovered = JSON.parse(await resumed.tool.mdd_reset.execute({ scope: 'phase', userText: 'I stopped the interrupted question.' }, f.context));
  assert.equal(recovered.state, 'question-ready');
  assert.notEqual(recovered.question.questions[0].question, args.questions[0].question);
  assert.equal(owners.read(ready.runID).state, 'idle');
  await assert.rejects(resumed['tool.execute.after']({ ...call, args }, oldAnswer));
  assert.equal(JSON.parse(await resumed.tool.mdd_status.execute({}, f.context)).workflow.nextAction.kind, 'approve');
});

test('opt-in restart refuses a corrupt checkpoint instead of granting dossier authority', async t => {
  const f = await fixture(t, { memoryEnabled: false, store: 'none' });
  await f.phase();
  const name = `checkpoint-${createHash('sha256').update(f.runtime.sessionID).digest('hex')}.json`;
  await writeFile(join(f.root, '.mdd', name), '{corrupt');
  const resumed = await plugin(f.input);
  const status = JSON.parse(await resumed.tool.mdd_status.execute({ detail: 'full' }, f.context));
  assert.equal(status.state, 'recovery-blocked');
  assert.equal(status.task, undefined);
  assert.match(status.reason, /Checkpoint or progress cannot be validated/);
  await assert.rejects(resumed.tool.mdd_start.execute({ requirements: f.requirements }, f.context));
});

test('opt-in pending native approval requires attestation, then re-presents without old consent', async t => {
  const f = await fixture(t, { mode: 'interactive', store: 'none', memoryEnabled: false });
  await f.phase();
  const before = await f.status();
  assert.equal(before.workflow.nextAction.kind, 'approve');
  const oldArgs = before.question;
  const oldCall = { sessionID: f.runtime.sessionID, callID: 'question-before-restart', tool: 'question' };
  f.parent[1].parts = [{ type: 'tool', tool: 'question', callID: oldCall.callID, sessionID: f.runtime.sessionID,
    messageID: f.context.messageID, state: { status: 'running', input: structuredClone(oldArgs) } }];
  await f.hooks['tool.execute.before'](oldCall, { args: oldArgs });
  const resumed = await plugin(f.input);
  const status = JSON.parse(await resumed.tool.mdd_status.execute({ detail: 'full' }, f.context));
  assert.equal(status.state, 'recovery-blocked');
  assert.equal(status.task, undefined);
  assert.equal(status.question, undefined);
  const answer = (args, callID) => {
    const formatted = args.questions.map(q => `"${q.question}"="Continuar"`).join(', ');
    return { title: 'Asked 1 question', output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
      metadata: { answers: [['Continuar']], truncated: false } };
  };
  await assert.rejects(resumed['tool.execute.after']({ ...oldCall, args: oldArgs }, answer(oldArgs, oldCall.callID)), /no current issued question/);
  assert.equal(JSON.parse(await resumed.tool.mdd_status.execute({ detail: 'full' }, f.context)).state, 'recovery-blocked');
  await assert.rejects(resumed['tool.execute.before']({ sessionID: f.runtime.sessionID, callID: 'question-after-restart', tool: 'question' },
    { args: oldArgs }), /durable run owner/);
  await assert.rejects(resumed.tool.mdd_reset.execute({ scope: 'phase' }, f.context), /attestation/);
  f.user('I stopped the interrupted question.');
  const recovered = JSON.parse(await resumed.tool.mdd_reset.execute({ scope: 'phase', userText: 'I stopped the interrupted question.' }, f.context));
  assert.equal(recovered.state, 'question-ready');
  assert.notEqual(recovered.question.questions[0].question, oldArgs.questions[0].question);
  await assert.rejects(resumed['tool.execute.after']({ ...oldCall, args: oldArgs }, answer(oldArgs, oldCall.callID)));
  assert.equal(JSON.parse(await resumed.tool.mdd_status.execute({}, f.context)).workflow.nextAction.kind, 'approve');
});

// T1/S1: a settled blocked-risk assessment is recovered across a restart: a fresh four-choice
// envelope is minted from the current replayed action, never from the earlier prepared record's
// text, and only a fresh call answering it (never the earlier one) can retry or choose a route.
test('a settled blocked-risk assessment re-presents a fresh recovery question on restart and never accepts the old call', async t => {
  const f = await fixture(t, { mode: 'interactive', store: 'none', memoryEnabled: false });
  await f.phase({ only: true });
  const before = await f.phase({ only: true, outcome: 'failed' });
  assert.equal(before.workflow.nextAction.kind, 'blocked-risk');
  const oldArgs = before.question;
  assert.ok(oldArgs, 'a recovery question is armed');
  // The restarted process never saw a native call for the old envelope: a fresh plugin instance
  // over the same durable state is restart, not a crashed-call handoff.
  const resumed = await plugin(f.input);
  const status = JSON.parse(await resumed.tool.mdd_status.execute({}, f.context));
  assert.equal(status.workflow.nextAction.kind, 'blocked-risk');
  assert.ok(status.question, 'the recovery question is reissued after restart');
  assert.notEqual(status.question.questions[0].question, oldArgs.questions[0].question);
  assert.deepEqual(status.question.questions[0].options.map(option => option.label),
    ['Reintentar evaluación de riesgo', 'Ruta low', 'Ruta high', 'Detener']);
  // The old, pre-restart envelope can never be answered through the restarted process: it names
  // no question this process ever issued, so its callback has nothing to resolve.
  const oldCall = { sessionID: f.runtime.sessionID, callID: 'question-before-restart', tool: 'question' };
  f.parent[1].parts = [{ type: 'tool', tool: 'question', callID: oldCall.callID, sessionID: f.runtime.sessionID,
    messageID: f.context.messageID, state: { status: 'running', input: structuredClone(oldArgs) } }];
  await assert.rejects(resumed['tool.execute.before'](oldCall, { args: oldArgs }), /differ from the pending question/);
  // Only a fresh call against the newly re-presented envelope resolves the recovery.
  const freshCall = { sessionID: f.runtime.sessionID, callID: 'question-after-restart', tool: 'question' };
  f.parent[1].parts = [{ type: 'tool', tool: 'question', callID: freshCall.callID, sessionID: f.runtime.sessionID,
    messageID: f.context.messageID, state: { status: 'running', input: structuredClone(status.question) } }];
  await resumed['tool.execute.before'](freshCall, { args: status.question });
  const formatted = status.question.questions.map(q => `"${q.question}"="Reintentar evaluación de riesgo"`).join(', ');
  await resumed['tool.execute.after']({ ...freshCall, args: status.question }, { title: 'Asked 1 question',
    output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
    metadata: { answers: [['Reintentar evaluación de riesgo']], truncated: false } });
  const retried = JSON.parse(await resumed.tool.mdd_status.execute({}, f.context));
  assert.equal(retried.stage, 'mdd-risk');
  assert.equal(retried.risk, undefined, 'no stale verdict survives the restart-driven retry');
});

// T1/S2: an unrelated ordinary blocked phase (not blocked-risk) is never offered the risk
// recovery question on restart, and a settled route choice already on record is never re-asked.
test('restart never arms risk recovery for an unrelated blocked phase or a settled route decision', async t => {
  const f = await fixture(t, { mode: 'automatic', store: 'none', memoryEnabled: false, route: 'low' });
  await f.phase({ only: true });
  const risked = await f.phase({ only: true });
  assert.equal(risked.workflow.evaluation.route, 'low');
  assert.equal(risked.workflow.routeOrigin, 'suggested');
  const resumedSuggested = await plugin(f.input);
  const suggestedStatus = JSON.parse(await resumedSuggested.tool.mdd_status.execute({}, f.context));
  assert.equal(suggestedStatus.question, undefined, 'a settled suggested route is never re-asked as a recovery question');
  const blocked = await f.phase({ only: true, outcome: 'failed' });
  assert.equal(blocked.workflow.nextAction.kind, 'blocked');
  assert.notEqual(blocked.workflow.nextAction.kind, 'blocked-risk');
  const resumedBlocked = await plugin(f.input);
  const blockedStatus = JSON.parse(await resumedBlocked.tool.mdd_status.execute({}, f.context));
  assert.equal(blockedStatus.question, undefined, 'an unrelated ordinary blocked phase arms no recovery question on restart');
});

// T1/S1 (fail closed): a risk-recovery record bound to this exact checkpoint sequence but with a
// different digest is a foreign or corrupted binding. Restart refuses to reissue over it.
test('restart refuses to reissue risk recovery over a record bound to a different checkpoint digest', async t => {
  const f = await fixture(t, { mode: 'interactive', store: 'none', memoryEnabled: false });
  await f.phase({ only: true });
  const before = await f.phase({ only: true, outcome: 'failed' });
  assert.equal(before.workflow.nextAction.kind, 'blocked-risk');
  const saved = new CheckpointStore(f.root).read(f.runtime.sessionID).checkpoint;
  const recorded = new QuestionCheckpointStore(f.root).read(f.runtime.sessionID);
  assert.equal(recorded.slot.kind, 'risk-recovery');
  assert.ok(['prepared', 'pending', 'answered'].includes(recorded.state));
  const name = join(f.root, '.mdd', `question-${createHash('sha256').update(f.runtime.sessionID).digest('hex')}.json`);
  const forged = { ...recorded, checkpoint: { sequence: saved.sequence, digest: saved.dataDigest === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64) } };
  await writeFile(name, JSON.stringify(forged));
  const resumed = await plugin(f.input);
  const status = JSON.parse(await resumed.tool.mdd_status.execute({}, f.context));
  assert.equal(status.state, 'recovery-blocked');
  assert.equal(status.question, undefined);
  assert.equal(status.task, undefined);
  // The foreign binding is left exactly as found, never overwritten by a fresh envelope.
  assert.deepEqual(JSON.parse(await readFile(name, 'utf8')), forged);
});

// T1/S2: a recovery decision already committed before the restart is restored once from replay,
// keeps its route attribution, and never re-arms the recovery question.
for (const [label, expectStage, route] of [['Reintentar evaluación de riesgo', 'mdd-risk', undefined], ['Ruta low', undefined, 'low'], ['Ruta high', undefined, 'high']]) {
  test(`restart after a committed '${label}' recovery choice restores it once and never re-arms risk recovery`, async t => {
    const f = await fixture(t, { mode: 'interactive', store: 'none', memoryEnabled: false });
    await f.phase({ only: true });
    const blocked = await f.phase({ only: true, outcome: 'failed' });
    assert.equal(blocked.workflow.nextAction.kind, 'blocked-risk');
    await f.answer(label);
    const committed = JSON.parse(await f.hooks.tool.mdd_status.execute({ detail: 'full' }, f.context));
    assert.notEqual(committed.workflow.nextAction.kind, 'blocked-risk');
    const resumed = await plugin(f.input);
    const status = JSON.parse(await resumed.tool.mdd_status.execute({ detail: 'full' }, f.context));
    assert.notEqual(status.state, 'recovery-blocked');
    assert.notEqual(status.workflow.nextAction.kind, 'blocked-risk');
    assert.notEqual(status.question?.questions[0].header, 'Recuperación', 'a spent recovery choice is never asked again');
    assert.deepEqual(status.workflow.nextAction, committed.workflow.nextAction);
    assert.equal(status.workflow.results.length, committed.workflow.results.length);
    if (expectStage) assert.equal(status.stage, expectStage);
    if (route) {
      assert.equal(status.workflow.routeOrigin, 'manual');
      assert.equal(status.workflow.evaluation.route, route);
      assert.equal(status.risk, undefined, 'a restored manual choice carries no fabricated verdict');
    }
  });
}

test('restart after a committed route override keeps the override origin and the original verdict', async t => {
  const f = await fixture(t, { mode: 'interactive', store: 'none', memoryEnabled: false, route: 'low' });
  await f.phase({ only: true });
  await f.phase({ only: true });
  const routed = await f.status();
  assert.equal(routed.question?.questions[0].header, 'Ruta');
  await f.answer('Forzar la otra ruta');
  const forced = JSON.parse(await f.hooks.tool.mdd_status.execute({ detail: 'full' }, f.context));
  assert.equal(forced.workflow.routeOrigin, 'override');
  const resumed = await plugin(f.input);
  const status = JSON.parse(await resumed.tool.mdd_status.execute({ detail: 'full' }, f.context));
  assert.notEqual(status.state, 'recovery-blocked');
  assert.equal(status.workflow.routeOrigin, 'override');
  assert.equal(status.workflow.evaluation.route, forced.workflow.evaluation.route);
  assert.equal(status.risk.route, 'low', 'the original suggested verdict survives the restart');
  assert.deepEqual(status.workflow.nextAction, forced.workflow.nextAction);
  assert.notEqual(status.question?.questions[0].header, 'Ruta', 'a spent route choice is never asked again');
  assert.notEqual(status.question?.questions[0].header, 'Recuperación');
});

test('transfer projection retains work but carries no source approval into a target', async t => {
  const f = await fixture(t, { mode: 'interactive', store: 'none', memoryEnabled: false });
  const checkpoints = new CheckpointStore(f.root);
  const before = checkpoints.read(f.runtime.sessionID).checkpoint;
  assert.throws(() => projectApprovalTransfer(before, undefined,
    { ...f.runtime, sessionID: 'ses-fresh-target' }, 'user-fresh-target'), /settled interactive approval/);
  await f.phase();
  const source = checkpoints.read(f.runtime.sessionID).checkpoint;
  const marker = new ProgressGuard(f.root).read(f.runtime.sessionID);
  const projected = projectApprovalTransfer(source, marker,
    { ...f.runtime, sessionID: 'ses-fresh-target' }, 'user-fresh-target');
  assert.equal(projected.checkpoint.data.userMessageID, 'user-fresh-target');
  assert.deepEqual(projected.checkpoint.data.usedMessages, ['user-fresh-target']);
  assert.deepEqual(projected.checkpoint.data.proposed, []);
  assert.equal(projected.progress.userMessageID, 'user-fresh-target');
  assert.equal(new Workflow(source.request).snapshot().answers.mode, 'interactive');
  assert.equal(Workflow.replay(projected.checkpoint.request, projected.checkpoint.events).nextAction().kind, 'approve');
  assert.equal(checkpoints.read('ses-fresh-target'), undefined);
  assert.equal(checkpoints.read(f.runtime.sessionID).checkpoint.dataDigest, source.dataDigest);
  await f.answer('Continuar');
  const approved = checkpoints.read(f.runtime.sessionID).checkpoint;
  assert.equal(approved.events.at(-1).kind, 'approve');
  const userText = `Continue sourceSessionID=${f.runtime.sessionID} runID=${approved.runID}`;
  const reasked = projectTargetTransfer(approved, new ProgressGuard(f.root).read(f.runtime.sessionID),
    { ...f.runtime, sessionID: 'ses-fresh-target' },
    { sessionID: 'ses-fresh-target', userMessageID: 'user-fresh-target', userText, latest: true, authored: true });
  assert.equal(reasked.checkpoint.stable.state, 'await-approval');
  assert.equal(reasked.checkpoint.events.length, approved.events.length - 1);
  assert.equal(Workflow.replay(reasked.checkpoint.request, reasked.checkpoint.events).nextAction().kind, 'approve');
  assert.equal(reasked.resumeConsent, undefined);
  assert.equal(checkpoints.read(f.runtime.sessionID).checkpoint.events.at(-1).kind, 'approve');
  const owners = new RunOwnershipStore(f.root);
  const intent = { operationID: 'interactive-reask', nativeUserMessageID: 'user-fresh-target',
    requestDigest: createHash('sha256').update(userText).digest('hex') };
  const reserved = owners.reserveVerifiedTransfer(approved.runID, f.runtime.sessionID,
    { sessionID: 'ses-fresh-target', directory: f.root, worktree: f.root },
    { sequence: approved.sequence, digest: approved.dataDigest }, owners.read(approved.runID).epoch, intent);
  checkpoints.write('ses-fresh-target', reasked.checkpoint);
  new ProgressGuard(f.root).write('ses-fresh-target', reasked.progress);
  const finished = owners.finishVerifiedTransfer(approved.runID, f.runtime.sessionID, 'ses-fresh-target', reserved.epoch,
    { sourceSequence: approved.sequence, sourceDigest: approved.dataDigest,
      targetSequence: reasked.checkpoint.sequence, targetDigest: reasked.checkpoint.dataDigest }, intent);
  assert.equal(finished.ownerSessionID, 'ses-fresh-target');
  assert.equal(checkpoints.read('ses-fresh-target').workflow.nextAction().kind, 'approve');
});

test('automatic target resume records only the exact target-authored request', async t => {
  const f = await fixture(t, { mode: 'automatic', store: 'none', memoryEnabled: false });
  await f.phase();
  const source = new CheckpointStore(f.root).read(f.runtime.sessionID).checkpoint;
  const marker = new ProgressGuard(f.root).read(f.runtime.sessionID);
  const target = { ...f.runtime, sessionID: 'ses-auto-target' };
  const userText = `Continue sourceSessionID=${f.runtime.sessionID} runID=${source.runID}`;
  const proof = { sessionID: target.sessionID, userMessageID: 'user-auto-target', userText, latest: true, authored: true };
  const projected = projectTargetTransfer(source, marker, target, proof);
  assert.equal(projected.checkpoint.stable.state, 'ready');
  assert.deepEqual(projected.checkpoint.events, source.events);
  assert.equal(projected.resumeConsent.sessionID, target.sessionID);
  assert.equal(projected.resumeConsent.userMessageID, proof.userMessageID);
  assert.equal(projected.checkpoint.data.usedMessages.includes(source.data.userMessageID), false);
  for (const wrong of [
    { ...proof, sessionID: f.runtime.sessionID },
    { ...proof, userText: 'Continue without the source and run identifiers.' },
    { ...proof, userMessageID: source.data.userMessageID },
    { ...proof, latest: false },
  ]) assert.throws(() => projectTargetTransfer(source, marker, target, wrong));
  assert.throws(() => projectTargetTransfer({ ...source, dataDigest: 'a'.repeat(64) }, marker, target, proof));
  assert.equal(new CheckpointStore(f.root).read(target.sessionID), undefined);
  const owners = new RunOwnershipStore(f.root);
  const intent = { operationID: 'auto-transfer', nativeUserMessageID: proof.userMessageID,
    requestDigest: projected.resumeConsent.digest };
  const reserved = owners.reserveVerifiedTransfer(source.runID, f.runtime.sessionID, target,
    { sequence: source.sequence, digest: source.dataDigest }, owners.read(source.runID).epoch, intent);
  new CheckpointStore(f.root).write(target.sessionID, projected.checkpoint);
  new ProgressGuard(f.root).write(target.sessionID, projected.progress);
  const finished = owners.finishVerifiedTransfer(source.runID, f.runtime.sessionID, target.sessionID, reserved.epoch,
    { sourceSequence: source.sequence, sourceDigest: source.dataDigest,
      targetSequence: projected.checkpoint.sequence, targetDigest: projected.checkpoint.dataDigest }, intent);
  assert.equal(finished.receipt.nativeUserMessageID, proof.userMessageID);
  assert.equal(finished.receipt.requestDigest, projected.resumeConsent.digest);
});

test('failed Verify projects only an explicit target-authored rework request', async t => {
  const f = await fixture(t, { mode: 'automatic', store: 'none', memoryEnabled: false });
  await f.phase(); await f.phase(); await f.phase({ outcome: 'failed' });
  const source = new CheckpointStore(f.root).read(f.runtime.sessionID).checkpoint;
  const marker = new ProgressGuard(f.root).read(f.runtime.sessionID);
  const target = { ...f.runtime, sessionID: 'ses-rework-target' };
  const userText = `Rework sourceSessionID=${f.runtime.sessionID} runID=${source.runID}`;
  const proof = { sessionID: target.sessionID, userMessageID: 'user-rework-target', userText, latest: true, authored: true };
  assert.throws(() => projectTargetTransfer(source, marker, target, { ...proof,
    userText: `Continue sourceSessionID=${f.runtime.sessionID} runID=${source.runID}` }));
  const projected = projectTargetTransfer(source, marker, target, proof);
  assert.equal(projected.checkpoint.stable.state, 'ready');
  assert.equal(projected.checkpoint.stable.phase, 'mdd-apply');
  assert.equal(projected.checkpoint.events.at(-1).kind, 'rework');
  assert.equal(projected.checkpoint.attempt, undefined);
  assert.equal(projected.resumeConsent.userMessageID, proof.userMessageID);
  const owners = new RunOwnershipStore(f.root);
  const intent = { operationID: 'rework-transfer', nativeUserMessageID: proof.userMessageID,
    requestDigest: createHash('sha256').update(userText).digest('hex') };
  const reserved = owners.reserveVerifiedTransfer(source.runID, f.runtime.sessionID, target,
    { sequence: source.sequence, digest: source.dataDigest }, owners.read(source.runID).epoch, intent);
  new CheckpointStore(f.root).write(target.sessionID, projected.checkpoint);
  new ProgressGuard(f.root).write(target.sessionID, projected.progress);
  const finished = owners.finishVerifiedTransfer(source.runID, f.runtime.sessionID, target.sessionID, reserved.epoch,
    { sourceSequence: source.sequence, sourceDigest: source.dataDigest,
      targetSequence: projected.checkpoint.sequence, targetDigest: projected.checkpoint.dataDigest }, intent);
  assert.equal(finished.ownerSessionID, target.sessionID);
});

test('pending, unrequested blocked and complete source checkpoints cannot project target authority', async t => {
  const f = await fixture(t, { mode: 'automatic', store: 'none', memoryEnabled: false });
  const target = { ...f.runtime, sessionID: 'ses-refused-target' };
  const proof = { sessionID: target.sessionID, userMessageID: 'user-refused-target',
    userText: `Rework sourceSessionID=${f.runtime.sessionID} runID=${(await f.status()).runID}`, latest: true, authored: true };
  const task = structuredClone((await f.status()).task);
  const call = { sessionID: f.runtime.sessionID, callID: 'pending-transfer-task', tool: 'task' };
  f.parent[1].parts = [{ type: 'tool', tool: 'task', callID: call.callID, state: { status: 'running', input: structuredClone(task) } }];
  await f.hooks['tool.execute.before'](call, { args: task });
  const pending = new CheckpointStore(f.root).read(f.runtime.sessionID).checkpoint;
  assert.throws(() => projectTargetTransfer(pending, new ProgressGuard(f.root).read(f.runtime.sessionID), target, proof));
  assert.equal(new CheckpointStore(f.root).read(target.sessionID), undefined);
  const failed = await fixture(t, { mode: 'automatic', store: 'none', memoryEnabled: false });
  await failed.phase({ outcome: 'failed' });
  const blocked = new CheckpointStore(failed.root).read(failed.runtime.sessionID).checkpoint;
  assert.throws(() => projectTargetTransfer(blocked, new ProgressGuard(failed.root).read(failed.runtime.sessionID),
    { ...failed.runtime, sessionID: target.sessionID }, { ...proof,
      userText: `Rework sourceSessionID=${failed.runtime.sessionID} runID=${blocked.runID}` }));
  const complete = await fixture(t, { mode: 'automatic', store: 'none', memoryEnabled: false });
  await complete.phase(); await complete.phase(); await complete.phase();
  const finished = new CheckpointStore(complete.root).read(complete.runtime.sessionID).checkpoint;
  assert.throws(() => projectTargetTransfer(finished, new ProgressGuard(complete.root).read(complete.runtime.sessionID),
    { ...complete.runtime, sessionID: target.sessionID }, { ...proof,
      userText: `Continue sourceSessionID=${complete.runtime.sessionID} runID=${finished.runID}` }));
});

test('answered but unapplied native approval is retired and re-asked, never accepted from history', async t => {
  const f = await fixture(t, { mode: 'interactive', store: 'none', memoryEnabled: false });
  await f.phase();
  const oldArgs = (await f.status()).question;
  const call = { sessionID: f.runtime.sessionID, callID: 'answered-before-crash', tool: 'question' };
  f.parent[1].parts = [{ type: 'tool', tool: 'question', callID: call.callID, sessionID: f.runtime.sessionID,
    messageID: f.context.messageID, state: { status: 'running', input: structuredClone(oldArgs) } }];
  await f.hooks['tool.execute.before'](call, { args: oldArgs });
  const questions = new QuestionCheckpointStore(f.root);
  const pending = questions.read(f.runtime.sessionID);
  questions.write(f.runtime.sessionID, { ...pending, state: 'answered', sequence: pending.sequence + 1, answer: [['Continuar']] });
  const resumed = await plugin(f.input);
  assert.equal(JSON.parse(await resumed.tool.mdd_status.execute({}, f.context)).state, 'recovery-blocked');
  f.user('I stopped the interrupted question.');
  const recovered = JSON.parse(await resumed.tool.mdd_reset.execute({ scope: 'phase', userText: 'I stopped the interrupted question.' }, f.context));
  assert.equal(recovered.state, 'question-ready');
  assert.notEqual(recovered.question.questions[0].question, oldArgs.questions[0].question);
  const oldAnswer = { title: 'Asked 1 question', output: `User has answered your questions: "${oldArgs.questions[0].question}"="Continuar". You can now continue with the user's answers in mind.`,
    metadata: { answers: [['Continuar']], truncated: false } };
  await assert.rejects(resumed['tool.execute.after']({ ...call, args: oldArgs }, oldAnswer));
  assert.equal(JSON.parse(await resumed.tool.mdd_status.execute({}, f.context)).state, 'question-ready');
  assert.equal(questions.read(f.runtime.sessionID).state, 'prepared');
});

test('opt-in OpenSpec ready Verify restores without using serialized artifact refs', async t => {
  const f = await fixture(t, { memoryEnabled: false, store: 'openspec' });
  await f.phase(); await f.phase();
  const resumed = await plugin(f.input);
  const status = JSON.parse(await resumed.tool.mdd_status.execute({ detail: 'full' }, f.context));
  assert.equal(status.state, 'ready');
  assert.equal(status.phase, 'mdd-verify');
  const args = structuredClone(status.task);
  const call = { sessionID: f.runtime.sessionID, callID: 'task-openspec-verify', tool: 'task' };
  f.parent[1].parts = [{ type: 'tool', tool: 'task', callID: call.callID, state: { status: 'running', input: structuredClone(args) } }];
  await resumed['tool.execute.before'](call, { args });
  assert.match(args.prompt, /Artifact for mdd-plan/);
  assert.match(args.prompt, /Artifact for mdd-apply/);
});

for (const store of ['engram', 'both']) {
  test(`opt-in ${store} ready Verify requires a fresh bound Engram session`, async t => {
    const f = await fixture(t, { memoryEnabled: true, store });
    await f.phase(); await f.phase();
    const resumed = await plugin(f.input);
    const status = JSON.parse(await resumed.tool.mdd_status.execute({ detail: 'full' }, f.context));
    assert.equal(status.state, 'ready');
    assert.equal(status.phase, 'mdd-verify');
    assert.equal(status.workflow.results.length, 3); // + the exploration every run now starts with
    assert.equal(status.task.subagent_type, 'mdd-verify');
  });
}

test('opt-in Engram project mismatch blocks restoration without rebinding', async t => {
  const f = await fixture(t, { memoryEnabled: true, store: 'engram' });
  await f.phase(); await f.phase();
  f.memory.binding.project = 'different-project';
  const resumed = await plugin(f.input);
  const status = JSON.parse(await resumed.tool.mdd_status.execute({ detail: 'full' }, f.context));
  assert.equal(status.state, 'recovery-blocked');
  assert.equal(status.task, undefined);
});

test('opt-in rejected result survives restart as a retry of the same phase', async t => {
  const f = await fixture(t, { memoryEnabled: false, store: 'none' });
  await assert.rejects(f.phase({ badEnvelope: true }));
  const current = await f.status();
  assert.equal(current.state, 'ready');
  const resumed = await plugin(f.input);
  const restored = JSON.parse(await resumed.tool.mdd_status.execute({ detail: 'full' }, f.context));
  assert.equal(restored.state, 'ready');
  assert.equal(restored.runID, current.runID);
  assert.equal(restored.phase, 'mdd-plan');
  assert.equal(restored.attempts, 1);
  assert.equal(restored.workflow.results.length, 1); // + the exploration every run now starts with
  assert.equal(restored.task.subagent_type, 'mdd-plan');
});

test('opt-in malformed completed report restores report-only restatement, not dispatch', async t => {
  const f = await fixture(t, { memoryEnabled: false, store: 'none' });
  const malformed = 'I finished the plan, but did not use the report headings.';
  await assert.rejects(f.phase({ reportText: malformed }));
  const resumed = await plugin(f.input);
  const held = JSON.parse(await resumed.tool.mdd_status.execute({ detail: 'full' }, f.context));
  assert.equal(held.state, 'ready');
  assert.equal(held.mode, 'inline');
  assert.equal(held.task, undefined);
  assert.equal(held.rejected.text, malformed);
  const restated = JSON.parse(await resumed.tool.mdd_phase_result.execute({ result: reportDocument({
    outcome: 'passed', evidenceSummary: 'Planned the CLI boundary change.',
    artifact: 'Plan: validate at the CLI boundary; run npm test afterwards.',
    ...traceFixture(join(f.root, 'feature.txt'), 'feature'),
  }) }, f.context));
  assert.equal(restated.state, 'ready');
  assert.equal(restated.phase, 'mdd-apply');
  assert.equal(restated.workflow.results.length, 2); // + the exploration every run now starts with
});

test('opt-in failed Verify restores rework and complete runs close before a fresh objective', async t => {
  const failed = await fixture(t, { memoryEnabled: false, store: 'none' });
  await failed.phase(); await failed.phase(); await failed.phase({ outcome: 'failed' });
  const resumed = await plugin(failed.input);
  const blocked = JSON.parse(await resumed.tool.mdd_status.execute({ detail: 'full' }, failed.context));
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.reworkable, 'mdd-apply');
  failed.user('Please correct the failed verification.');
  const corrected = JSON.parse(await resumed.tool.mdd_reset.execute({ scope: 'rework', userText: 'Please correct the failed verification.' }, failed.context));
  assert.equal(corrected.state, 'ready');
  assert.equal(corrected.runID, blocked.runID);
  assert.equal(corrected.phase, 'mdd-apply');
  assert.equal(corrected.workflow.results.length, 4); // + the exploration every run now starts with

  const complete = await fixture(t, { memoryEnabled: false, store: 'none' });
  await complete.phase(); await complete.phase(); await complete.phase();
  const nextPlugin = await plugin(complete.input);
  const finished = JSON.parse(await nextPlugin.tool.mdd_status.execute({ detail: 'full' }, complete.context));
  assert.equal(finished.state, 'complete');
  await nextPlugin.tool.mdd_reset.execute({ scope: 'run' }, complete.context);
  complete.user('Build a new, separately scoped feature.');
  const fresh = JSON.parse(await nextPlugin.tool.mdd_start.execute({ requirements: 'Build a new, separately scoped feature.' }, complete.context));
  assert.equal(fresh.state, 'ready');
  assert.notEqual(fresh.runID, finished.runID);
});

// Native SDK/hook contract fixtures. No model or real shell execution is performed.
async function fixture(t, { mode = 'automatic', route = 'low', store = 'none', partial = false, summary = 'low', telemetry = true, memoryEnabled = true, memoryFault, start = true, worktree: worktreeLayout = false, autoReview = true } = {}) {
  isolateHome(t);
  // When asked, the session runs inside a linked git worktree laid out as git does on disk — a
  // `.git` file pointing at the administrative directory, which names the shared git directory. It
  // is where entrecuadras runs, and where MDD used to bury a run's records so the worktree could
  // delete them. `mainRoot` is the repository those records must land in instead.
  const base = await mkdtemp(join(tmpdir(), 'mdd-full-native-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  let root = base;
  let mainRoot = base;
  if (worktreeLayout) {
    mainRoot = join(base, 'MainRepo');
    const administrative = join(mainRoot, '.git', 'worktrees', 'linked');
    await mkdir(administrative, { recursive: true });
    await writeFile(join(administrative, 'commondir'), '../..\n');
    root = join(base, 'linked');
    await mkdir(root);
    await writeFile(join(root, '.git'), `gitdir: ${administrative.replaceAll('\\', '/')}\n`);
  }
  installCleanup(root);
  await writeFile(join(root, 'feature.txt'), 'pending\n');
  const memory = memoryEnabled ? await memoryServer(t, memoryFault) : { binding: {}, writes: [] };
  memory.binding.directory = root;
  const settings = defaultSettings();
  // complexity no longer scores a route (mdd-risk judges it after exploration instead), so the
  // high-route fixture now reaches the threshold through certainty and summary alone.
  const known = { ...answers, mode, summary, artifactStore: store, ...(route === 'high' ? { certainty: 'not-sure', summary: 'detailed' } : route === 'low-explore' ? { certainty: 'somewhat-sure' } : {}) };
  settings.profiles.default.answers = partial ? { ...known, mode: undefined } : known;
  if (partial) delete settings.profiles.default.answers.mode;
  if (memoryEnabled) settings.engram = { endpoint: memory.endpoint, project: 'mdd-test' };
  settings.telemetry.enabled = telemetry;
  saveGlobalSettings(settings);
  const runtime = { sessionID: 'ses_parent', agent: 'mdd-orchestrator', directory: root, worktree: root };
  const model = { providerID: 'contract-only', modelID: 'model' };
  const requirements = 'Implement a scoped feature and check it.';
  const agents = MODEL_ROLES.map(role => ({ name: role === 'orchestrator' ? 'mdd-orchestrator' : role, mode: role === 'orchestrator' ? 'primary' : 'subagent', permission: [
    { permission: '*', pattern: '*', action: 'deny' }, ...['read', 'glob', 'grep'].map(permission => ({ permission, pattern: '*', action: 'allow' })),
    ...(role === 'mdd-apply' ? [{ permission: 'edit', pattern: '*', action: 'ask' }] : []),
    ...(['mdd-apply', 'mdd-verify'].includes(role) ? [{ permission: 'bash', pattern: '*', action: 'ask' }] : []),
  ] }));
  const sessions = new Map([[runtime.sessionID, { id: runtime.sessionID, agent: runtime.agent, directory: root, projectID: 'project' }]]);
  const info = { id: 'msg_parent', sessionID: runtime.sessionID, agent: runtime.agent, role: 'assistant', ...model, path: { cwd: root, root } };
  const parent = [{ info: { id: 'user', sessionID: runtime.sessionID, role: 'user' }, parts: [{ type: 'text', text: requirements, sessionID: runtime.sessionID, messageID: 'user' }] }, { info, parts: [] }];
  const histories = new Map([[runtime.sessionID, parent]]);
  const input = { directory: root, worktree: root, project: { id: 'project' }, client: {
    app: { agents: async () => ({ data: agents }) }, session: {
      status: async () => ({ data: {} }),
      get: async ({ path }) => ({ data: sessions.get(path.id) }), messages: async ({ path }) => ({ data: histories.get(path.id) }),
    },
  } };
  const hooks = await plugin(input);
  const context = { ...runtime, messageID: 'msg_parent', abort: new AbortController().signal };
  // These tests inspect the run itself — its route, held plan, coverage and recorded evidence —
  // so they read the inspection view. The compact default that every other tool returns has its
  // own contract tests; asserting run semantics through it would only test the projection twice.
  const status = async () => {
    const current = JSON.parse(await hooks.tool.mdd_status.execute({ detail: 'full' }, context));
    // Existing route tests act as a coordinator with no outstanding clarification.
    return current.state === 'review-ready' && autoReview
      ? JSON.parse(await hooks.tool.mdd_prepare_advance.execute({ questions: [] }, context))
      : current;
  };
  let questionCount = 0;
  async function answer(selection) {
    const current = await status();
    const args = current.question;
    const call = { sessionID: runtime.sessionID, callID: `question-${++questionCount}`, tool: 'question' };
    parent[1].parts = [{ type: 'tool', tool: 'question', callID: call.callID, sessionID: runtime.sessionID, messageID: context.messageID, state: { status: 'running', input: structuredClone(args) } }];
    await hooks['tool.execute.before'](call, { args });
    // 'Ruta' is the one native route question (3a) that replaces the generic approval at the
    // suggested route's first tail phase; the default answer here keeps the suggested route,
    // exactly like the plain 'Continuar' it stands in for.
    const labels = { 'Aprobación': 'Continuar', Ruta: 'Continuar con la ruta sugerida', Cambio: 'Confirmar el cambio', Certeza: known.certainty === 'not-sure' ? 'Poco seguro' : known.certainty === 'somewhat-sure' ? 'Algo seguro' : 'Muy seguro', Artefactos: { none: 'Ninguno', openspec: 'OpenSpec', engram: 'Engram', both: 'Ambos' }[store], Modo: mode === 'automatic' ? 'Automático' : 'Interactivo', Resumen: { low: 'Bajo', medium: 'Medio', detailed: 'Detallado' }[known.summary], Notas: 'Nada que agregar' };
    const selections = Array.isArray(selection) ? selection : args.questions.map(q => [typeof selection === 'string' ? selection : labels[q.header]]);
    const formatted = args.questions.map((q, i) => `"${q.question}"="${selections[i].join(', ')}"`).join(', ');
    await hooks['tool.execute.after']({ ...call, args }, { title: `Asked ${args.questions.length} question${args.questions.length > 1 ? 's' : ''}`, output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`, metadata: { answers: selections, truncated: false } });
    return { call, args };
  }
  let userIndex = 0;
  function user(text) {
    const id = `user-${++userIndex}`;
    parent[0] = { info: { id, sessionID: runtime.sessionID, role: 'user' }, parts: [{ type: 'text', text, sessionID: runtime.sessionID, messageID: id }] };
    context.messageID = `msg-parent-${userIndex}`;
    parent[1] = { info: { ...info, id: context.messageID }, parts: [] };
  }
  async function change(kind = 'rerun', requirements) {
    return JSON.parse(await hooks.tool.mdd_change_request.execute({ kind, userText: parent[0].parts[0].text,
      ...(kind === 'material' ? { requirements, concerns: [{ category: 'integrations', evidence: 'The user requested a new integration.', impact: 'The approved acceptance map must be replanned.' }] } : {}) }, context));
  }
  let index = 0;
  const visited = [];
  // What the last dispatched actor actually received. The parent only ever sees a handle now, so
  // assertions about prompt content belong here, where the prompt is really delivered.
  let delivered;
  let hiddenIndex = 0;
  // The verdict the fixture's risk actor returns: it follows the route the fixture was built for.
  const riskRoute = route === 'high' ? 'high' : 'low';
  /**
   * Every run now starts with exploration and then the mdd-risk stop, and only the validated
   * verdict selects the route. These tests were written when a low route began at mdd-plan and a
   * high one went straight from exploration to its tail, so `phase()` drives that prelude itself —
   * an exploration the low route never asked for, and the risk stop, plus the approval interactive
   * mode now asks before the first tail phase — and then runs the phase the test meant, so each
   * call still advances exactly one phase of the route the test was written against.
   * `{ only: true }` runs exactly the current task, prelude included, for tests about it.
   */
  async function phase(options = {}) {
    let current = await status();
    if (!options.only) {
      const settle = async () => {
        let next = await status();
        if (next.question && next.state === 'question-ready') { await answer(); next = await status(); }
        return next;
      };
      if (route === 'low' && !current.contextual && current.stage === undefined && current.task?.subagent_type === 'mdd-explore' && current.workflow?.results.length === 0) {
        await step(current, {}, true);
        current = await settle();
      }
      if (current.stage === 'mdd-risk' && current.task) {
        await step(current, {}, true);
        current = await settle();
      }
    }
    return step(current, options, false);
  }
  async function step(current, options, hidden) {
    const args = current.task;
    assert.ok(args, `Expected task, got ${current.state}`);
    const phase = current.stage ?? current.phase ?? 'mdd-explore';
    const risk = phase === 'mdd-risk';
    // The parent conversation is handed a dispatch handle, never the prompt itself. That is the
    // contract: the prompt is what fills a coordinator's context window and gets it compacted,
    // and the actor receives it all the same because the hook expands the handle below.
    assert.ok(args.prompt.startsWith('mdd:dispatch:'), `status handed the full prompt for ${phase}`);
    assert.ok(Buffer.byteLength(JSON.stringify(args)) < 300, `oversized dispatched task for ${phase}`);
    assert.equal(current.dispatch.mode, 'handle');
    assert.deepEqual(current.nextAction.args, args, `nextAction must carry the dispatchable task for ${phase}`);
    // A coordinator reading its own collapsed history back may replay the transcript note in
    // place of the handle. The byte count it writes is whatever it remembers, never the real one.
    if (options.replayNote) args.prompt = collapsedPrompt(args.subagent_type, 4242);
    const ordinal = hidden ? `prelude-${++hiddenIndex}` : `${++index}`;
    const callID = `task-${ordinal}`;
    const call = { sessionID: runtime.sessionID, callID, tool: 'task' };
    parent[1].parts = [{ type: 'tool', tool: 'task', callID, state: { status: 'running', input: args } }];
    await hooks['tool.execute.before'](call, { args });
    // Expanded in place by the hook, so from here `args` is exactly what the actor receives.
    assert.ok(args.prompt.length > 1000, `the handle was not expanded for ${phase}`);
    if (!hidden) delivered = args.prompt;
    if (risk) {
      // The risk actor gets the requirements, the recorded exploration and its own report form.
      assert.equal(args.subagent_type, current.mode === 'native' ? 'general' : 'mdd-risk');
      assert.ok(args.prompt.includes('Requirements data: "'), 'requirements missing in mdd-risk');
      assert.ok(args.prompt.includes('Artifact for mdd-explore'), 'exploration artifact missing in mdd-risk');
      assert.ok(args.prompt.includes('exactly this key: risk'), 'risk report form missing in mdd-risk');
      assert.ok(args.prompt.includes('Packaged MDD actor instructions with provenance'), 'MDD instructions missing in mdd-risk');
    } else {
    // A dependency reaches the phase in full, or as its recorded summary and ref when inlining
    // every artifact would exceed the handoff budget. What it never does is disappear silently.
    const announced = /appear above as their recorded summary and ref/.test(args.prompt);
    for (const prior of visited) {
      const summarized = (current.handoff?.summarized ?? []).some(item => item.phase === prior);
      assert.ok(args.prompt.includes(`Artifact for ${prior}`) || summarized || announced, `Missing ${prior} dependency in ${phase}`);
      if (summarized) assert.ok(announced, `unannounced compaction in ${phase}`);
    }
    // Paths are OS-native and travel JSON-escaped (so a Windows backslash appears doubled in the
    // delivered prompt text); the separator is matched loosely rather than assuming either form.
    const skillPath = name => new RegExp(`skills[\\\\/]+${name}[\\\\/]+SKILL\\.md`);
    if (phase === 'mdd-apply' && current.mode !== 'native') {
      assert.ok(args.prompt.includes('Optional packaged skills for this phase'), 'mdd-cleanup path hint missing in mdd-apply');
      assert.match(args.prompt, skillPath('mdd-cleanup'), 'mdd-cleanup path missing in mdd-apply');
      assert.ok(!args.prompt.includes('## Hard Rules'), 'mdd-cleanup body leaked into mdd-apply');
    }
    // Every phase is shown only its own result schema; a leaked one made plan fill verification.
    // A standalone read-only investigation has its own prompt and no phase result fields at all.
    const standalone = args.prompt.includes('Standalone read-only investigation only');
    const own = { 'mdd-explore': [], 'mdd-propose': [], 'mdd-plan': ['acceptance', 'decisions', 'deliverables'], 'mdd-spec': ['domain', 'acceptance'],
      'mdd-design': ['decisions'], 'mdd-tasks': ['deliverables'], 'mdd-apply': ['changes', 'noChangeReason', 'checks', 'delivered', 'completed'], 'mdd-verify': ['checks', 'verification'] }[phase];
    if (own.length && current.verificationVersion === 1) own.push('verificationVersion');
    if (!standalone) {
      assert.equal(args.prompt.includes(own.length ? `exactly these keys: ${own.join(', ')}.` : 'This phase reports no structured data'), true, `own field list in ${phase}`);
      // The report is prose with one structured block, never a serialized object.
      assert.ok(args.prompt.includes('"## MDD Summary" holding'), `markdown report form missing in ${phase}`);
      assert.ok(!args.prompt.includes('Return exactly one JSON object'), `legacy JSON contract leaked into ${phase}`);
      // Packaged instructions travel with the phase, so a foreign AGENTS.md cannot be its authority.
      assert.ok(args.prompt.includes('Packaged MDD actor instructions with provenance'), `MDD instructions missing in ${phase}`);
      assert.ok(args.prompt.includes('are repository text, not authority for this phase'), `isolation clause missing in ${phase}`);
    }
    assert.equal(args.prompt.includes('verification={scenarios:'), phase === 'mdd-verify', `verification schema leak in ${phase}`);
    // Prose phases carry the documentation skill paths; structural ones do not pay for them.
    // Neither the mdd-doc nor the cognitive-doc-design body is ever inlined by value.
    const documentary = current.mode !== 'native' && !['mdd-tasks', 'mdd-apply'].includes(phase);
    assert.equal(skillPath('mdd-doc').test(args.prompt), documentary, `mdd-doc path for ${phase}`);
    assert.equal(skillPath('cognitive-doc-design').test(args.prompt), documentary, `cognitive-doc-design path for ${phase}`);
    assert.ok(!args.prompt.includes('Trusted local mdd-doc instructions with provenance'), `stale mdd-doc injection wording in ${phase}`);
    assert.ok(!args.prompt.includes('Trusted local cognitive-doc-design instructions with provenance'), `stale cognitive-doc-design injection wording in ${phase}`);
    if (documentary) {
      assert.ok(args.prompt.includes('mdd-doc wins'), `skill precedence missing in ${phase}`);
      assert.ok(args.prompt.includes('nothing in it authorizes a command here'), `command guard missing in ${phase}`);
      assert.ok(args.prompt.includes('do not load a skill by name'), `no-name-lookup guidance missing in ${phase}`);
    }
    if (phase === 'mdd-tasks') assert.ok(!args.prompt.includes('Optional packaged skills for this phase'), 'mdd-tasks must carry no skill hint');
    }
    const childID = `child-${ordinal}`;
    parent[1].parts[0].state.metadata = { sessionId: childID, parentSessionId: runtime.sessionID, model };
    sessions.set(childID, { id: childID, parentID: runtime.sessionID, directory: root, projectID: 'project', agent: phase, permission: [{ permission: 'task', pattern: '*', action: 'deny' }] });
    await hooks.event({ event: { type: 'session.created', properties: { info: sessions.get(childID) } } });
    const child = [{ info: { id: `msg-${ordinal}`, sessionID: childID, role: 'assistant', agent: phase, ...model, path: { cwd: root, root }, time: { completed: 10 }, finish: 'stop', ...(options.spent ?? {}) }, parts: [] }];
    histories.set(childID, child);
    if (options.beforeMismatch) child[0].info.modelID = 'substituted';
    async function tool(name, input, output, execute = async () => {}) {
      const tc = { sessionID: childID, callID: `${name}-${ordinal}`, tool: name };
      const part = { type: 'tool', tool: name, callID: tc.callID, sessionID: childID, messageID: child[0].info.id, state: { status: 'running', input: structuredClone(input) } };
      child[0].parts.push(part);
      await hooks['tool.execute.before'](tc, { args: input });
      if (options.denied) {
        await hooks.event({ event: { type: 'message.part.updated', properties: { part: { ...part, state: { status: 'error', input, error: 'Permission denied.' } } } } });
        throw new Error('Simulated native permission denial.');
      }
      await execute();
      if (!options.missingAfter) await hooks['tool.execute.after']({ ...tc, args: input }, output);
      part.state = { status: 'completed', input: structuredClone(input), ...output };
      return tc.callID;
    }
    const result = { phase, runID: current.runID ?? current.explorationID, callID, outcome: options.outcome ?? 'passed', evidenceSummary: `Actual contract evidence for ${phase}.`, artifact: `Artifact for ${phase}: scoped requirements, changes and executable check plan.` };
    if (options.concerns) result.concerns = options.concerns;
    if (options.questions) result.questions = options.questions;
    if (options.unauthorized) await tool('write', { filePath: join(root, 'feature.txt'), content: 'not permitted' }, { output: 'write', metadata: {} }, () => writeFile(join(root, 'feature.txt'), 'not permitted'));
    if (phase === 'mdd-apply') {
      if (result.outcome === 'passed') result.completed = ['feature'];
      if (options.noChange) {
        await tool('read', { filePath: join(root, 'feature.txt') }, { output: 'Inspected existing implementation.', metadata: { truncated: false } });
        result.noChangeReason = 'Inspected implementation already satisfies the scoped task.';
      }
      else {
        const filePath = options.external ? join(root, '../escape.txt') : join(root, 'feature.txt');
        await tool('write', { filePath, content: 'implemented\n' }, { output: 'Wrote file successfully.', metadata: { filepath: filePath, exists: true, diagnostics: {}, truncated: false } }, () => writeFile(filePath, 'implemented\n'));
        // Apply reports why each file changed, not only that it did: the reason is what the PR
        // body tabulates and what a reviewer cannot get from the diff.
        result.changes = [{ path: filePath, reason: 'Implementa el manejo de entrada que pide el plan en el borde de la feature.' }];
        // And what the change delivers, which is what the body opens with. Malformed here on
        // purpose in one case: a summary must never be able to fail a finished implementation.
        result.delivered = options.badSummary ? { what: '' } : { what: 'Invalid input is now rejected at the feature boundary.', implies: 'Whoever uses the feature gets a clear error instead of an unintended change.' };
      }
    } else if (phase === 'mdd-verify') {
      if (!options.noChecks) {
        const command = 'npm test';
        const text = '1 test passed';
        await tool('bash', { command, workdir: root, description: 'Run scoped tests' }, { output: text, metadata: { output: text, exit: options.exit === undefined ? 0 : options.exit, truncated: false } });
        result.checks = [{ id: 'E1', command, exit: options.exit === undefined ? 0 : options.exit }];
      } else result.checks = [];
    } else await tool('read', { filePath: join(root, 'feature.txt') }, { output: 'Inspected project context.', metadata: { truncated: false } });
    const trace = traceFixture(join(root, 'feature.txt'), 'feature');
    if (phase === 'mdd-plan') Object.assign(result, trace);
    if (phase === 'mdd-spec') { result.domain = 'project'; result.acceptance = trace.acceptance; }
    if (phase === 'mdd-design') result.decisions = trace.decisions;
    if (phase === 'mdd-tasks') result.deliverables = trace.deliverables;
    if (phase === 'mdd-verify') {
      const assessment = { status: 'verified', checks: ['E1'], assessment: 'The inspected boundary and planned check output support the expected behavior.' };
      result.verification = { scenarios: ['S1', 'S2'].map(scenarioID => ({ requirementID: 'R1', scenarioID, stepID: 'feature', ...assessment })),
        steps: [{ stepID: 'feature', ...assessment }], decisions: [{ decisionID: 'D1', ...assessment }], changes: options.noChange ? 'No implementation change was needed.' : 'The requested input handling is implemented.', limits: [],
        checkResults: [{ checkID: 'feature-check', disposition: options.noChecks ? 'blocked' : options.exit === null ? 'ran' : options.exit ? 'failed' : 'passed',
          executions: options.noChecks ? [] : ['E1'], reason: options.noChecks ? 'Checks unavailable.' : 'Observed fixture execution.' }], supplementalChecks: [] };
      if (options.unverified) for (const row of [...result.verification.scenarios, ...result.verification.steps, ...result.verification.decisions]) row.status = 'not-verified';
      if (options.coverageFault === 'missing') result.verification.scenarios.pop();
      if (options.coverageFault === 'invented') result.verification.scenarios[0].requirementID = 'invented';
      if (options.coverageFault === 'drift' || options.coverageFault === 'partial') {
        result.verification.decisions[0].status = 'deviation';
        result.verification.decisions[0].assessment = 'Input handling diverges from the planned boundary.';
        result.verification.limits = ['Boundary behavior still needs alignment with the plan.'];
        if (options.coverageFault === 'partial') result.outcome = 'failed';
      }
    }
    if (options.artifact !== undefined) result.artifact = options.artifact;
    if (options.narrative) Object.assign(result, options.narrative);
    if (options.large) {
      const suffix = traceArtifact(phase, '', trace.acceptance, trace.decisions, trace.deliverables, result.verification);
      // `fill` lets a test choose characters JSON must escape, so serialized size exceeds raw size.
      const fill = options.fill ?? 'x';
      result.artifact += fill.repeat(Math.floor((16000 - Buffer.byteLength(result.artifact) - Buffer.byteLength(suffix)) / Buffer.byteLength(fill)));
    }
    if (options.mismatch) child[0].info.modelID = 'substituted';
    const text = options.reportText ?? (risk ? riskReport(options.riskRoute ?? riskRoute, options.outcome ?? 'passed') : reportDocument(result));
    child[0].parts.push({ type: 'text', sessionID: childID, messageID: child[0].info.id, text });
    const output = { title: 'Native task', metadata: { sessionId: childID, parentSessionId: runtime.sessionID, model }, output: `<task id="${childID}" state="completed">\n<task_result>\n${text}\n</task_result>\n</task>` };
    if (options.badEnvelope) output.output = 'the delegated task did not finish';
    await hooks['tool.execute.after']({ ...call, args }, output);
    if (!risk) visited.push(phase);
    return status();
  }
  if (start) await hooks.tool.mdd_start.execute({ requirements }, context);
  return { root, mainRoot, settings, hooks, status, phase, answer, user, change, input, context, parent, runtime, visited, requirements, memory,
    sessions, histories, delivered: () => delivered, writes: memory.writes, questions: () => questionCount };
}

/**
 * Drives the two stops every run starts with — exploration, then the mdd-risk assessment — and
 * returns the route the validated verdict selected. Before the verdict nothing beyond exploration
 * is on the route, whatever the preflight score says.
 */
async function assessedRoute(f, route) {
  const tail = route === 'high' ? ['mdd-propose', 'mdd-spec', 'mdd-design', 'mdd-tasks', 'mdd-apply', 'mdd-verify'] : ['mdd-plan', 'mdd-apply', 'mdd-verify'];
  let current = await f.status();
  assert.equal(current.task.subagent_type, 'mdd-explore');
  assert.deepEqual(current.workflow.evaluation.phases, ['mdd-explore']);
  await f.phase({ only: true });
  current = await f.status();
  assert.equal(current.stage, 'mdd-risk');
  assert.equal(current.phase, 'mdd-explore');
  assert.equal(current.task.subagent_type, 'mdd-risk');
  assert.deepEqual(current.workflow.evaluation.phases, ['mdd-explore']);
  assert.equal(current.question, undefined, 'the risk stop dispatches without an approval of its own');
  await f.phase({ only: true });
  current = await f.status();
  assert.equal(current.stage, undefined);
  assert.deepEqual(current.workflow.evaluation.phases, ['mdd-explore', ...tail]);
  if (current.question) await f.answer();
  return ['mdd-explore', ...tail];
}

for (const route of ['low', 'high']) for (const store of ['none', 'openspec']) for (const mode of ['automatic', 'interactive']) {
  test(`memory off complete native route: ${route}/${store}/${mode}, no transport or service`, async t => {
    t.mock.method(globalThis, 'fetch', () => { assert.fail('Memory off fetched'); });
    t.mock.method(ManagedMemory.prototype, 'endpoint', () => { assert.fail('Memory off started a service'); });
    const f = await fixture(t, { route, store, mode, memoryEnabled: false, partial: true });
    await f.answer();
    const phases = await assessedRoute(f, route);
    for (const phase of phases.slice(1)) {
      assert.equal((await f.status()).task.subagent_type, phase);
      await f.phase({ only: true });
      if ((await f.status()).question) await f.answer();
    }
    const status = await f.status();
    assert.equal(status.state, 'complete');
    assert.equal(status.memory, 'off');
    assert.equal(status.coverage, 100);
    assert.equal(f.writes.length, 0);
    for (const artifact of status.artifacts) {
      assert.equal(artifact.ref.observationID, undefined);
      if (store === 'openspec') assert.ok(artifact.ref.path);
    }
    await f.hooks.event({ event: { type: 'server.instance.disposed', properties: { directory: f.root } } });
  });
}

for (const [name, question, option, freeText] of [
  ['question over the context-label budget', '¿Qué comportamiento necesitás? '.repeat(10), { label: 'Conservar', description: 'Conservar el comportamiento.' }],
  ['multibyte question and selected option beyond prose ceilings', '¿Qué comportamiento necesitás? '.repeat(150),
    { label: 'Conservar la configuración íntegra. '.repeat(400), description: 'Mantener el comportamiento actual. '.repeat(20), recommended: true }],
  ['multibyte free-text answer beyond 12000 bytes', '¿Qué texto necesitás?', { label: 'Breve', description: 'Usar texto breve.' }, 'Necesito la configuración íntegra. '.repeat(400)],
]) {
  test(`regression: clarification real runner preserves ${name} through restart and dispatch`, async t => {
    const f = await fixture(t, { mode: 'interactive', memoryEnabled: false });
    await f.phase();
    await f.hooks.tool.mdd_revisit.execute({}, f.context);
    const prepared = JSON.parse(await f.hooks.tool.mdd_prepare_advance.execute({ questions: [{ question, options: [option] }] }, f.context));
    assert.ok(prepared.question.questions[0].question.startsWith(question));
    const answer = freeText ?? `${option.label}${option.recommended ? ' (Recomendada)' : ''}`;
    await f.answer(answer);
    const current = await f.status();
    assert.equal(current.state, 'question-ready');
    assert.equal(current.workflow.nextAction.kind, 'approve', 'clarification is not phase consent');
    assert.equal(current.clarificationAnswers[0].question, question);
    assert.equal(current.clarificationAnswers[0].answer, answer);
    const questions = new QuestionCheckpointStore(f.root);
    assert.equal(questions.read(f.runtime.sessionID).clarificationAnswers[0].answer, answer);
    await f.answer('Continuar');
    assert.equal(questions.read(f.runtime.sessionID).state, 'settled');
    const checkpoint = new CheckpointStore(f.root).read(f.runtime.sessionID).checkpoint;
    assert.deepEqual(checkpoint.data.context.at(-1), { label: 'Clarification', content: `Question: ${question}\nAnswer: ${answer}`, source: 'coordinator' });
    const resumed = await plugin(f.input);
    const ready = JSON.parse(await resumed.tool.mdd_status.execute({ detail: 'full' }, f.context));
    assert.equal(ready.state, 'ready');
    const args = structuredClone(ready.task);
    const call = { sessionID: f.runtime.sessionID, callID: 'long-clarification-dispatch', tool: 'task' };
    f.parent[1].parts = [{ type: 'tool', tool: 'task', callID: call.callID, state: { status: 'running', input: structuredClone(args) } }];
    await resumed['tool.execute.before'](call, { args });
    assert.ok(args.prompt.includes(JSON.stringify(`Question: ${question}\nAnswer: ${answer}`)), 'full content reaches the reconstructed native phase');
    assert.match(args.prompt, /Report in English — summary, artifact, concerns and data/);
  });
}

test('regression: clarification preparation tool requires Spanish user-visible fields', async t => {
  const f = await fixture(t, { memoryEnabled: false });
  assert.match(f.hooks.tool.mdd_prepare_advance.description, /question text, option labels and descriptions in Spanish/);
});

test('interactive review exposes expanded detail and carries clarification choices into the next actor', async t => {
  const f = await fixture(t, { mode: 'interactive', summary: 'low', store: 'none', memoryEnabled: false });
  await f.phase({ narrative: { approach: 'Read the feature boundary first.', purpose: 'Find where input enters.', openItems: 'None.',
    learnings: 'The boundary is a single module.', confidence: 'High — the whole module was read.' } });
  let current = JSON.parse(await f.hooks.tool.mdd_status.execute({ detail: 'full' }, f.context));
  assert.equal(current.state, 'question-ready');
  // Low shows the summary; the expanded view shows the narrative the actor wrote anyway.
  assert.doesNotMatch(current.report, /Propósito|Confianza/);
  assert.match(current.expandedReport, /\nPropósito\nFind where input enters\.\n/);
  assert.match(current.expandedReport, /\nAprendizajes clave\nThe boundary is a single module\.\n/);
  assert.match(current.expandedReport, /\nConfianza\nAlta — the whole module was read\.\n/);
  assert.doesNotMatch(current.expandedReport, /Cobertura/);
  assert.ok(current.question.questions[0].options.some(option => option.label === 'Obtener un resumen más completo de esta fase'));
  await f.answer('Obtener un resumen más completo de esta fase');
  current = await f.status();
  assert.equal(current.workflow.nextAction.kind, 'approve');
  assert.equal(current.question.questions[0].options.some(option => option.label === 'Obtener un resumen más completo de esta fase'), false);
  await f.hooks.tool.mdd_revisit.execute({}, f.context);
  current = JSON.parse(await f.hooks.tool.mdd_prepare_advance.execute({ questions: [
    { question: 'Which date format?', options: [{ label: 'ISO', description: 'Use ISO dates.', recommended: true }], deferrable: true },
    { question: 'Which retry strategy?', options: [{ label: 'Fixed', description: 'Use a fixed backoff.', recommended: true }] },
  ] }, f.context));
  assert.equal(current.question.questions[0].header, 'Detalle');
  // Both clarifications arrive in one native interaction and are answered together.
  assert.equal(current.question.questions.length, 2);
  await f.answer([['Dejar para más adelante'], ['Que decida el agente']]);
  assert.equal((await f.status()).workflow.nextAction.kind, 'approve');
  await f.answer('Continuar');
  await f.phase();
  assert.match(f.delivered(), /Question: Which date format\?/);
  assert.match(f.delivered(), /Question: Which retry strategy\?/);
});

const REPORTED_QUESTIONS = [{ question: 'Which locale formats dates?', why: 'Every rendered date depends on it.',
  options: [{ label: 'es-AR', description: 'Day first.', recommended: true }, { label: 'en-US', description: 'Month first.' }] }];

test('automatic mode asks the questions a phase reported together and carries the answers into the next phase', async t => {
  const f = await fixture(t, { memoryEnabled: false, store: 'none', autoReview: false });
  await f.phase({ only: true, questions: REPORTED_QUESTIONS });
  let current = await f.status();
  // The risk stop is not a phase boundary; the questions wait, visible, for the first one.
  assert.equal(current.stage, 'mdd-risk');
  assert.deepEqual(current.openQuestions, { phase: 'mdd-explore', questions: REPORTED_QUESTIONS });
  await f.phase({ only: true });
  current = await f.status();
  assert.equal(current.state, 'review-ready');
  assert.equal(current.task, undefined);
  assert.equal(current.workflow.nextAction.kind, 'execute', 'automatic mode asks no approval');
  assert.equal(current.nextAction.tool, 'mdd_prepare_advance');
  assert.match(current.nextAction.why, /openQuestions/);
  const prepared = JSON.parse(await f.hooks.tool.mdd_prepare_advance.execute({ questions: [
    { question: 'Which date format?', header: 'Date format', why: 'Every rendered date depends on it.', options: [{ label: 'es-AR', description: 'Day first.', recommended: true }, { label: 'en-US', description: 'Month first.' }] },
    { question: 'Which screens?', header: 'Screens', multiple: true, options: [{ label: 'Orders', description: 'List.' }, { label: 'Dashboard', description: 'Home.' }] },
  ] }, f.context));
  assert.equal(prepared.openQuestions, undefined, 'asking them settles the pending phase questions');
  assert.deepEqual(prepared.question.questions.map(question => [question.header, question.multiple]), [['Date format', false], ['Screens', true]]);
  await f.answer([['es-AR (Recomendada)'], ['Orders', 'Dashboard']]);
  current = await f.status();
  assert.equal(current.question, undefined);
  assert.equal(current.task.subagent_type, 'mdd-plan');
  assert.equal(current.questionReceipts.at(-1).kind, 'clarification');
  await f.phase({ only: true });
  assert.ok(f.delivered().includes(JSON.stringify('Question: Which date format?\nAnswer: es-AR (Recomendada)\n\nQuestion: Which screens?\nAnswers:\n- Orders\n- Dashboard')),
    'every answer of the interaction reaches the next phase as one context entry');
});

test('a restart before reported questions are asked keeps the automatic boundary', async t => {
  const f = await fixture(t, { memoryEnabled: false, store: 'none', autoReview: false });
  await f.phase({ only: true, questions: REPORTED_QUESTIONS });
  await f.phase({ only: true });
  const resumed = await plugin(f.input);
  const restored = JSON.parse(await resumed.tool.mdd_status.execute({ detail: 'full' }, f.context));
  assert.equal(restored.state, 'review-ready');
  assert.equal(restored.task, undefined);
  assert.equal(restored.openQuestions.phase, 'mdd-explore');
  assert.match(restored.notice, /openQuestions/);
  const asked = JSON.parse(await resumed.tool.mdd_prepare_advance.execute({ questions: [{ question: 'Which locale?', options: [] }] }, f.context));
  assert.equal(asked.state, 'question-ready');
  assert.equal(asked.openQuestions, undefined);
  assert.deepEqual(asked.question.questions[0].options.map(option => option.label), ['Que decida el agente']);
});

for (const fault of [{ noChecks: true }, { coverageFault: 'missing' }]) {
  test(`memory off rejects an inconsistent report and keeps the phase runnable: ${JSON.stringify(fault)}`, async t => {
    t.mock.method(globalThis, 'fetch', () => assert.fail('Memory off fetched'));
    const f = await fixture(t, { memoryEnabled: false });
    await f.phase(); await f.phase();
    await assert.rejects(f.phase(fault));
    const after = await f.status();
    assert.equal(after.state, 'ready');
    // An inconsistent report is still a report: the checks it describes were either run or not,
    // and re-running the phase cannot change that. It comes back to be restated instead.
    assert.equal(after.attempts, 0);
    assert.equal(after.mode, 'inline');
    assert.ok(after.rejected, 'the refused report is handed back to be corrected');
    assert.equal(after.task, undefined, 'a rejected report authorizes repair, not another execution');
    assert.equal(after.nextAction.tool, 'mdd_phase_result');
    assert.equal(after.workflow.results.length, 3); // explore, plan, apply
  });
}

test('memory off contextual exploration keeps local provenance, and a restart leaves the conversation usable', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Memory off fetched'));
  const f = await fixture(t, { memoryEnabled: false });
  await f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Inspect the current feature boundary.' }, f.context);
  await f.phase();
  assert.equal((await f.status()).workflow.results.length, 0);
  await f.phase();
  const live = await f.status();
  const restarted = await plugin(f.input);
  // Settled work resumes where it stopped, with the investigation's findings still attached.
  const after = JSON.parse(await restarted.tool.mdd_status.execute({ detail: 'full' }, f.context));
  assert.equal(after.state, 'ready');
  assert.equal(after.runID, live.runID);
  assert.equal(after.contexts.length, 1);
  assert.ok(after.task, 'the resumed phase is dispatchable');
  // A different objective needs the user's explicit discard of the unfinished run first.
  f.user('A different objective for this conversation.');
  await assert.rejects(restarted.tool.mdd_start.execute({ requirements: 'A different objective for this conversation.' }, f.context));
  await restarted.tool.mdd_reset.execute({ scope: 'run' }, f.context);
  const fresh = JSON.parse(await restarted.tool.mdd_start.execute({ requirements: 'A different objective for this conversation.' }, f.context));
  assert.equal(fresh.state, 'ready');
});

/** What a checkpoint write that kept failing leaves behind: the marker withdraws resumability. */
function withdrawResume(f) {
  const progress = new ProgressGuard(f.root);
  progress.write(f.runtime.sessionID, { ...progress.read(f.runtime.sessionID), resumable: false });
}

for (const route of ['low', 'high']) for (const mode of ['automatic', 'interactive']) for (const store of ['none', 'openspec', 'engram', 'both']) {
  test(`complete native contract: ${route}/${mode}/${store} exact route and grounded coverage`, async t => {
    const f = await fixture(t, { route, mode, store, partial: mode === 'interactive' });
    const initial = await f.status();
    if (initial.question) await f.answer();
    const phases = await assessedRoute(f, route);
    assert.equal(phases.length, route === 'low' ? 4 : 7);
    assert.equal((await f.status()).coverage, 20);
    for (const phase of phases.slice(1)) {
      assert.equal((await f.status()).task.subagent_type, phase);
      await f.phase({ only: true });
      const current = await f.status();
      const completed = current.workflow.results.map(result => result.phase);
      const expectedCoverage = completed.includes('mdd-verify') ? 100 : completed.includes('mdd-apply') ? 65 : completed.some(phase => ['mdd-plan', 'mdd-tasks'].includes(phase)) ? 40 : 20;
      assert.equal(current.coverage, expectedCoverage);
      if (current.question) await f.answer();
    }
    const final = await f.status();
    assert.equal(final.state, 'complete'); assert.equal(final.coverage, 100);
    assert.deepEqual(f.visited, phases); assert.equal(final.artifacts.length, phases.length);
    if (route === 'low') assert.equal(final.artifacts.filter(item => item.ref.phase === 'mdd-plan').length, 1);
    assert.equal(f.questions(), mode === 'interactive' ? phases.length : 0);
    assert.equal(final.workflow.results.length, phases.length);
    final.evidence.checks = 'invalidated'; final.acceptance.requirements[0].id = 'changed'; final.verification.matched = false;
    assert.equal((await f.status()).coverage, 100); assert.equal((await f.status()).acceptance.requirements[0].id, 'R1');
    const general = f.writes.filter(write => write.type === 'workflow');
    // Every phase and the risk stop each write one intent and one result.
    assert.equal(general.length, (phases.length + 1) * 2);
    // The assessment that selected the route is persisted like a phase artifact, outside history.
    assert.equal(final.risk.route, route);
    if (store !== 'none') assert.equal(final.risk.ref.phase, 'mdd-risk');
    assert.ok(general.every(write => !write.content.includes('Artifact for')));
    const events = (await readFile(join(f.root, '.mdd/telemetry.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(events.filter(event => event.event === 'phase-start').length, phases.length);
    assert.equal(events.filter(event => event.event === 'preflight').length, 1);
    // Knowledge delivery has bounded metadata without a run ID; workflow events retain their
    // opaque run identity. These fixtures have no reusable observations or approved catalog.
    for (const event of events) {
      if (event.event === 'knowledge-dispatch') {
        assert.deepEqual(Object.keys(event).sort(), ['event', 'knowledge', 'timestamp']);
        assert.ok(Number.isSafeInteger(event.timestamp) && event.timestamp >= 0);
        const { candidates } = event.knowledge;
        assert.ok(Number.isSafeInteger(candidates) && candidates >= 0 && candidates <= 42);
        assert.deepEqual(event.knowledge, { candidates, freshHits: 0, staleRejects: 0,
          selectedReferences: [], selectedSkillIDs: [], selectedBytes: 0, promptByteDelta: 0 });
      } else {
        assert.ok(Object.keys(event).every(key => ['timestamp', 'event', 'phase', 'duration', 'route', 'outcome', 'runID', 'attempt', 'mode', 'failure', 'usage'].includes(key)));
        assert.equal(event.runID, final.runID);
        assert.ok(!/[A-Za-z]{2}/.test(event.runID.replaceAll(/[0-9a-f-]/g, '')));
      }
    }
  });
}

// MDD does not re-run anything, so the one honesty it can enforce is that the report agrees
// with itself: an assessment may not lean on a check the same phase never reported running.
test('Verify rejects an assessment citing a check it never reported, keeping earned coverage', async t => {
  const f = await fixture(t);
  await f.phase(); await f.phase();
  assert.equal((await f.status()).coverage, 65);
  await assert.rejects(f.phase({ noChecks: true }), /did not report running/);
  const after = await f.status();
  assert.equal(after.state, 'ready'); assert.equal(after.coverage, 65);
  assert.equal(after.phase, 'mdd-verify'); assert.equal(after.workflow.results.length, 3);
  assert.equal(after.task, undefined);
});

for (const [name, exit] of Object.entries({ nonzero: 1, interrupted: null })) {
  test(`a ${name} check cannot support a verified assessment`, async t => {
    const f = await fixture(t);
    await f.phase(); await f.phase();
    await assert.rejects(f.phase({ exit }), /did not pass/);
    const after = await f.status();
    assert.equal(after.state, 'ready'); assert.equal(after.coverage, 65);
    assert.equal(after.evidence.checks, 'unearned');
  });
}

test('Apply no-change result earns no implementation credit; executable checks remain required', async t => {
  const f = await fixture(t); await f.phase(); await f.phase({ noChange: true }); await f.phase();
  assert.equal((await f.status()).state, 'complete'); assert.equal((await f.status()).coverage, 75);
  assert.match((await f.status()).report, /No se registró ningún cambio de implementación/);
});
for (const summary of ['low', 'medium', 'detailed']) {
  test(`live report ${summary} and disabled telemetry`, async t => {
    const f = await fixture(t, { summary, telemetry: false });
    for (let current = await f.status(); current.task; current = await f.status()) await f.phase();
    const status = await f.status();
    assert.match(status.report, /Make the requested feature usable/);
    // The validated mdd-risk verdict that selected this route is named here too (D3/S7).
    assert.match(status.report, /^\*\*MDD · low route\*\*\n\nEvaluación de riesgo: complejidad low, ruta sugerida low\.\n\n✅ explore  ✅ plan  ✅ apply  ✅ verify\n\nSkills: doc, cognitive doc design/m);
    assert.equal(status.visual.route, 'low');
    assert.deepEqual(status.visual.skills, ['mdd-doc', 'cognitive-doc-design']);
    assert.match(status.report, /los requisitos y el plan coinciden con lo implementado/);
    assert.doesNotMatch(status.report, /mdd-|task-\d|bash-\d|receipt/i);
    assert.equal(status.report.includes('\nVerificación\n'), summary !== 'low');
    assert.equal(status.report.includes('\nEstado\ncompletado\n'), summary === 'detailed');
    assert.doesNotMatch(status.report, /Cobertura|cobertura/);
    // The level the user chose is named in the payload, not buried in a droppable snapshot: the
    // coordinator cannot present the report they asked for if it has to guess which one that is.
    assert.equal(status.reportDetail, summary);
    await assert.rejects(readFile(join(f.root, '.mdd/telemetry.jsonl')), { code: 'ENOENT' });
  });
}

// The actor writes every narrative section whatever detail the user chose: the level decides
// what the user is shown, so a request for more detail at an approval has more to show.
test('every report detail asks the actor for the full narrative, never a level-specific summary', async t => {
  for (const summary of ['low', 'medium', 'detailed']) {
    const f = await fixture(t, { summary, memoryEnabled: false });
    assert.equal((await f.status()).reportDetail, summary);
    await f.phase();
    const prompt = f.delivered();
    for (const heading of ['Summary', 'Approach', 'Purpose', 'Open Items', 'Learnings', 'Confidence']) {
      assert.match(prompt, new RegExp(`\\\\"## MDD ${heading}\\\\"|"## MDD ${heading}"`), `${summary}: ${heading}`);
    }
    assert.match(prompt, /write every prose section the result format below lists/);
    assert.doesNotMatch(prompt, /brief reports|medium-detail reports|The user asked for detailed reports/);
  }
});

// A checkpoint written at the approval carries the narrative, so a restart restores the same
// report, including the sections the actor left out.
test('a restored approval presents the narrative it was checkpointed with', async t => {
  const f = await fixture(t, { mode: 'interactive', summary: 'detailed', store: 'none', memoryEnabled: false });
  await f.phase({ narrative: { purpose: 'Find where input enters.', confidence: 'Low — only one file was read.' } });
  const before = await f.status();
  assert.match(before.report, /\nPropósito\nFind where input enters\.\n/);
  assert.match(before.report, /\nConfianza\nBaja — only one file was read\.\n/);
  assert.match(before.report, /\nAprendizajes clave\nEl agente no lo informó\.\n/);
  const resumed = await plugin(f.input);
  const after = JSON.parse(await resumed.tool.mdd_status.execute({ detail: 'full' }, f.context));
  assert.equal(after.runID, before.runID);
  assert.equal(after.report, before.report);
});
test('late result memory failure never completes Verify or retains checks credit', async t => {
  const f = await fixture(t, { memoryFault(req, reply, writes) {
    const last = writes.at(-1);
    if (req.method === 'POST' && last?.type === 'workflow') { const body = JSON.parse(last.content); if (body.kind === 'agent-evidence' && body.phase === 'mdd-verify') reply.status = 500; }
  } });
  await f.phase(); await f.phase(); await assert.rejects(f.phase());
  assert.equal((await f.status()).coverage, 65); assert.equal((await f.status()).state, 'ready');
  assert.equal((await f.status()).evidence.checks, 'unearned');
});

for (const fault of ['missing', 'invented', 'drift', 'partial']) {
  test(`acceptance closure cannot claim success for ${fault} coverage`, async t => {
    const f = await fixture(t); await f.phase(); await f.phase();
    if (fault === 'partial') {
      // A phase that reports failure is a recorded outcome: it closes the route and withdraws
      // the evidence it could not stand behind.
      await f.phase({ coverageFault: fault });
      const status = await f.status();
      assert.equal(status.state, 'blocked'); assert.equal(status.coverage, 40);
      assert.match(status.report, /Sin completar: los requisitos y el plan no están verificados del todo/);
      assert.doesNotMatch(status.report, /100%|los requisitos y el plan coinciden con lo implementado/);
      assert.equal(status.verification.decisions[0].status, 'deviation');
      assert.match(status.report, /diverges from the planned boundary/);
      return;
    }
    await assert.rejects(f.phase({ coverageFault: fault }));
    const status = await f.status();
    assert.equal(status.state, 'ready'); assert.equal(status.coverage, 65);
    assert.doesNotMatch(status.report, /100%|los requisitos y el plan coinciden con lo implementado/);
  });
}

// A failed verification used to leave one exit that kept the run: re-checking the same unchanged
// implementation. Correcting it meant a material change, new requirements and a fresh preflight.
test('a failed verification can send the run back to Apply with its findings, on the user\'s word', async t => {
  const f = await fixture(t); await f.phase(); await f.phase();
  await f.phase({ coverageFault: 'partial' });
  const blocked = await f.status();
  assert.equal(blocked.state, 'blocked'); assert.equal(blocked.reworkable, 'mdd-apply');
  assert.equal(blocked.nextAction.tool, 'mdd_reset'); assert.match(blocked.nextAction.why, /scope rework/);
  // Rework changes the route, so the coordinator cannot choose it on its own.
  await assert.rejects(f.hooks.tool.mdd_reset.execute({ scope: 'rework' }, f.context), /needs the user's own word/);
  await assert.rejects(f.hooks.tool.mdd_reset.execute({ scope: 'rework', userText: 'fix it' }, f.context), /exact latest message/);
  assert.equal((await f.status()).state, 'blocked');
  f.user('Vamos con la opción A: corregí lo que encontró la verificación.');
  const reworked = JSON.parse(await f.hooks.tool.mdd_reset.execute({ scope: 'rework', userText: f.parent[0].parts[0].text }, f.context));
  assert.equal(reworked.reset.scope, 'rework'); assert.equal(reworked.phase, 'mdd-apply'); assert.equal(reworked.state, 'ready');
  assert.equal(reworked.rework.after, 'mdd-verify'); assert.equal(reworked.reworkable, undefined);
  // Every recorded result and artifact survives; the failed verification is part of the history.
  assert.deepEqual(reworked.workflow.results.map(item => `${item.phase}:${item.outcome}`), ['mdd-explore:passed', 'mdd-plan:passed', 'mdd-apply:passed', 'mdd-verify:failed']);
  assert.equal(reworked.artifacts.length, blocked.artifacts.length);
  await f.phase();
  assert.match(f.delivered(), /This is a correction pass: mdd-verify reported failure/);
  assert.match(f.delivered(), /Artifact for mdd-verify/);
  const verifying = await f.status();
  assert.equal(verifying.phase, 'mdd-verify'); assert.equal(verifying.rework, undefined);
  await f.phase();
  const done = await f.status();
  assert.equal(done.state, 'complete'); assert.equal(done.coverage, 100);
});
test('rework is refused where there is no failed verification to correct', async t => {
  const f = await fixture(t); await f.phase({ outcome: 'failed' });
  f.user('Corregí lo que falló.');
  const blocked = await f.status();
  assert.equal(blocked.reworkable, undefined);
  await assert.rejects(f.hooks.tool.mdd_reset.execute({ scope: 'rework', userText: f.parent[0].parts[0].text }, f.context), /only after mdd-verify reported failure/);
  assert.deepEqual((await f.status()).workflow, blocked.workflow);
});

async function failedVerification(t) {
  const f = await fixture(t, { memoryEnabled: false });
  await f.phase(); await f.phase();
  await f.phase({ outcome: 'failed', exit: 1, unverified: true });
  return f;
}

for (const restart of [false, true]) {
  test(`SA-3: explicit continuation archives failure without PASS or new work (restart=${restart})`, async t => {
    const f = await failedVerification(t);
    const failed = await f.status();
    const hooks = restart ? await plugin(f.input) : f.hooks;
    const text = 'Seguí de todos modos; conservo el resultado fallido.';
    f.user(text);
    const result = JSON.parse(await hooks.tool.mdd_reset.execute({ scope: 'continue', runID: failed.runID, userText: text }, f.context));
    assert.equal(result.state, 'continued-with-failed-verification');
    assert.equal(result.task, undefined);
    assert.equal(result.priorRun.lastState, 'blocked');
    assert.equal(result.priorRun.results.at(-1).outcome, 'failed');
    assert.equal(result.priorRun.verification.matched, false);
    assert.equal(result.priorRun.verificationVersion, 1);
    assert.equal(result.priorRun.continuation.userMessageID, f.parent[0].info.id);
    assert.equal(result.priorRun.continuation.userText, text);
    assert.equal(new RunOwnershipStore(f.root).parent(f.runtime.sessionID), undefined);
    const fresh = await plugin(f.input);
    const retained = JSON.parse(await fresh.tool.mdd_status.execute({ detail: 'full' }, f.context));
    assert.equal(retained.state, result.state);
    assert.deepEqual(retained.priorRun.verification, result.priorRun.verification);
    f.user('Draft the preserved failed run evidence.');
    const request = JSON.parse(await fresh.tool.mdd_pr_body.execute({ runID: failed.runID, userText: f.parent[0].parts[0].text }, f.context));
    assert.ok(request.entries.some(item => /input handling/.test(item.text)), JSON.stringify(request));
    const translations = request.entries.map(entry => ({ key: entry.key, text: entry.key === 'limit.0'
      ? 'El usuario continuó después de la verificación fallida; el resultado fallido no se aceptó como PASS.'
      : PR_SPANISH[entry.key] ?? entry.text }));
    const draft = JSON.parse(await fresh.tool.mdd_pr_body.execute({ runID: failed.runID, userText: f.parent[0].parts[0].text, digest: request.digest, translations }, f.context));
    assert.match(draft.body, /salida 1/);
    assert.match(draft.body, /no están verificados del todo/);
    assert.doesNotMatch(draft.body.split('## Bloqueos')[1], /^\s*No aplica\./);
  });
}

for (const restart of [false, true]) {
  test(`SA-3: explicit new objective replaces failed Verify through normal intake (restart=${restart})`, async t => {
    const f = await failedVerification(t); const failed = await f.status();
    const hooks = restart ? await plugin(f.input) : f.hooks;
    const requirements = 'Implement a separate export boundary.';
    f.user(requirements);
    const result = JSON.parse(await hooks.tool.mdd_start.execute({ requirements }, f.context));
    assert.equal(result.state, 'ready');
    assert.equal(result.phase, 'mdd-explore');
    assert.notEqual(result.runID, failed.runID);
    const archive = new RunDossierStore(f.root).readContinued(f.runtime.sessionID, failed.runID);
    assert.equal(archive.lastState, 'blocked');
    assert.equal(archive.continuation.kind, 'new-task');
    assert.equal(archive.continuation.userText, requirements);
    assert.equal(archive.executedChecks[0].exit, 1);
    const owner = new RunOwnershipStore(f.root).parent(f.runtime.sessionID);
    await assert.rejects(hooks.tool.mdd_reset.execute({ scope: 'continue', runID: failed.runID, userText: requirements }, f.context));
    assert.equal(new RunOwnershipStore(f.root).parent(f.runtime.sessionID), owner, 'stale continuation cannot retire the later run');
  });
}

test('SA-3: continuation requires fresh exact text and target, and status never continues automatically', async t => {
  const f = await failedVerification(t); const failed = await f.status();
  for (const args of [
    { scope: 'continue', runID: failed.runID },
    { scope: 'continue', runID: failed.runID, userText: 'Invented consent.' },
    { scope: 'continue', runID: failed.runID, userText: f.requirements },
  ]) await assert.rejects(f.hooks.tool.mdd_reset.execute(args, f.context));
  f.user('Continue despite the failure.');
  for (const runID of [undefined, 'another-run']) await assert.rejects(f.hooks.tool.mdd_reset.execute({ scope: 'continue', runID, userText: f.parent[0].parts[0].text }, f.context));
  const after = await f.status();
  assert.equal(after.state, 'blocked');
  assert.deepEqual(after.workflow, failed.workflow);
  assert.equal(new RunOwnershipStore(f.root).parent(f.runtime.sessionID), failed.runID);
});

test('SA-3: archival error leaves failed state, checkpoint and ownership intact', async t => {
  const f = await failedVerification(t); const failed = await f.status();
  const before = new CheckpointStore(f.root).read(f.runtime.sessionID).checkpoint;
  const original = RunDossierStore.prototype.archiveContinuation;
  RunDossierStore.prototype.archiveContinuation = () => { throw new Error('Injected archival failure'); };
  t.after(() => { RunDossierStore.prototype.archiveContinuation = original; });
  f.user('Continue despite the failed checks.');
  await assert.rejects(f.hooks.tool.mdd_reset.execute({ scope: 'continue', runID: failed.runID, userText: f.parent[0].parts[0].text }, f.context), /archival failure/);
  assert.equal(new RunOwnershipStore(f.root).parent(f.runtime.sessionID), failed.runID);
  assert.deepEqual(new CheckpointStore(f.root).read(f.runtime.sessionID).checkpoint, before);
  assert.deepEqual((await f.status()).workflow, failed.workflow);
});

test('SA-3: continuation never invokes stopped-child recovery for a pending actor', async t => {
  const f = await fixture(t, { memoryEnabled: false });
  const ready = await f.status(); const args = structuredClone(ready.task);
  const call = { sessionID: f.runtime.sessionID, callID: 'pending-before-continue', tool: 'task' };
  f.parent[1].parts = [{ type: 'tool', tool: 'task', callID: call.callID, state: { status: 'running', input: structuredClone(args) } }];
  await f.hooks['tool.execute.before'](call, { args });
  let aborted = 0;
  f.input.client.session.abort = async () => { aborted++; return { data: true }; };
  f.user('Continue anyway despite verification.');
  await assert.rejects(f.hooks.tool.mdd_reset.execute({ scope: 'continue', runID: ready.runID, userText: f.parent[0].parts[0].text }, f.context));
  assert.equal(aborted, 0);
  assert.equal(new ProgressGuard(f.root).read(f.runtime.sessionID).state, 'pending');
  assert.equal(new RunOwnershipStore(f.root).parent(f.runtime.sessionID), ready.runID);
});

test('SA-3: a new objective still needs latest text and ordinary preflight; archival failure cannot replace the failed run', async t => {
  const f = await failedVerification(t); const failed = await f.status();
  f.user('Implement a new export boundary.');
  await assert.rejects(f.hooks.tool.mdd_start.execute({ requirements: 'A model rewrite of that request.' }, f.context));
  assert.deepEqual((await f.status()).workflow, failed.workflow);
  const original = RunDossierStore.prototype.archiveContinuation;
  t.mock.method(RunDossierStore.prototype, 'archiveContinuation', () => { throw new Error('Archive refused'); });
  await assert.rejects(f.hooks.tool.mdd_start.execute({ requirements: f.parent[0].parts[0].text }, f.context), /Archive refused/);
  assert.equal(new RunOwnershipStore(f.root).parent(f.runtime.sessionID), failed.runID);
  assert.deepEqual((await f.status()).workflow, failed.workflow);
  RunDossierStore.prototype.archiveContinuation = original;
  delete f.settings.profiles.default.answers.mode;
  saveGlobalSettings(f.settings);
  const restarted = await plugin(f.input);
  const result = JSON.parse(await restarted.tool.mdd_start.execute({ requirements: f.parent[0].parts[0].text }, f.context));
  assert.equal(result.state, 'question-ready');
  assert.equal(result.task, undefined);
  assert.equal(result.question.questions[0].header, 'Modo');
  assert.equal(new RunDossierStore(f.root).readContinued(f.runtime.sessionID, failed.runID).results.at(-1).outcome, 'failed');
});

for (const issued of [false, true]) test(`SA-3: ${issued ? 'pending' : 'prepared'} native question cannot be retired by continuation or a fresh objective`, async t => {
  const f = await failedVerification(t); const failed = await f.status();
  f.user('Reconsider the plan.');
  await f.change();
  if (issued) {
    const args = (await f.status()).question;
    const call = { sessionID: f.runtime.sessionID, callID: 'question-before-continuation', tool: 'question' };
    f.parent[1].parts = [{ type: 'tool', tool: 'question', callID: call.callID, sessionID: f.runtime.sessionID, messageID: f.context.messageID,
      state: { status: 'running', input: structuredClone(args) } }];
    await f.hooks['tool.execute.before'](call, { args });
  }
  const questions = new QuestionCheckpointStore(f.root);
  const before = questions.read(f.runtime.sessionID);
  assert.equal(before.state, issued ? 'pending' : 'prepared');
  f.user('Continue despite the failed verification.');
  for (const hooks of [f.hooks, await plugin(f.input)]) {
    await assert.rejects(hooks.tool.mdd_reset.execute({ scope: 'continue', runID: failed.runID, userText: f.parent[0].parts[0].text }, f.context), /question|intake/i);
    await assert.rejects(hooks.tool.mdd_start.execute({ requirements: f.parent[0].parts[0].text }, f.context), /question|intake|owner/i);
  }
  assert.deepEqual(questions.read(f.runtime.sessionID), before);
  assert.equal(new RunOwnershipStore(f.root).parent(f.runtime.sessionID), failed.runID);
});

test('SA-3: archive readback failure and pre-retirement interruption preserve the failed owner', async t => {
  const f = await failedVerification(t); const failed = await f.status();
  const checkpoints = new CheckpointStore(f.root); const saved = checkpoints.read(f.runtime.sessionID).checkpoint;
  f.user('Proceed despite the failure.');
  const args = { scope: 'continue', runID: failed.runID, userText: f.parent[0].parts[0].text };
  const read = t.mock.method(RunDossierStore.prototype, 'readContinued', () => undefined);
  await assert.rejects(f.hooks.tool.mdd_reset.execute(args, f.context), /readback/);
  read.mock.restore();
  assert.deepEqual(checkpoints.read(f.runtime.sessionID).checkpoint, saved);
  assert.equal(new RunOwnershipStore(f.root).parent(f.runtime.sessionID), failed.runID);
  const retire = t.mock.method(RunOwnershipStore.prototype, 'retireParent', () => { throw new Error('Interrupted before retirement'); });
  await assert.rejects(f.hooks.tool.mdd_reset.execute(args, f.context), /Interrupted before retirement/);
  retire.mock.restore();
  const restarted = await plugin(f.input);
  const status = JSON.parse(await restarted.tool.mdd_status.execute({ detail: 'full' }, f.context));
  assert.equal(status.state, 'blocked', 'an archived request without retired ownership is not completed continuation');
  assert.deepEqual(status.verification, failed.verification);
  assert.equal(new RunOwnershipStore(f.root).parent(f.runtime.sessionID), failed.runID);
});

test('SA-3: reported open questions do not force a new consent ritual after an explicit continuation', async t => {
  const f = await fixture(t, { memoryEnabled: false });
  await f.phase(); await f.phase();
  await f.phase({ outcome: 'failed', exit: 1, unverified: true, narrative: {
    questions: [{ question: 'Should this optional integration be redesigned?', why: 'The behavior remains unsupported.' }],
  } });
  const failed = await f.status();
  assert.ok(failed.openQuestions);
  f.user('Continue despite those unresolved findings.');
  const result = JSON.parse(await f.hooks.tool.mdd_reset.execute({ scope: 'continue', runID: failed.runID, userText: f.parent[0].parts[0].text }, f.context));
  assert.equal(result.state, 'continued-with-failed-verification');
  assert.equal(result.priorRun.results.at(-1).outcome, 'failed');
});

test('SA-3: a transfer fence cannot be released by continuation or a new objective', async t => {
  const f = await failedVerification(t); const failed = await f.status();
  const owners = new RunOwnershipStore(f.root);
  const source = new CheckpointStore(f.root).read(f.runtime.sessionID).checkpoint;
  const target = { sessionID: 'waiting-target', directory: f.root, worktree: f.root };
  const intent = { operationID: 'pending-transfer', nativeUserMessageID: 'target-consent', requestDigest: 'a'.repeat(64) };
  owners.reserveVerifiedTransfer(failed.runID, f.runtime.sessionID, target,
    { sequence: source.sequence, digest: source.dataDigest }, owners.read(failed.runID).epoch, intent);
  const before = owners.read(failed.runID);
  f.user('Continue despite verification.');
  await assert.rejects(f.hooks.tool.mdd_reset.execute({ scope: 'continue', runID: failed.runID, userText: f.parent[0].parts[0].text }, f.context));
  await assert.rejects(f.hooks.tool.mdd_start.execute({ requirements: f.parent[0].parts[0].text }, f.context));
  assert.deepEqual(owners.read(failed.runID), before);
});

for (const restart of [false, true]) test(`SA-3: replayed continuation cannot retire a later failed run, even with its new runID (restart=${restart})`, async t => {
  const f = await failedVerification(t); const first = await f.status();
  f.user('Continue despite verification.');
  const consentUser = structuredClone(f.parent[0]);
  const consent = { scope: 'continue', runID: first.runID, userText: f.parent[0].parts[0].text };
  await f.hooks.tool.mdd_reset.execute(consent, f.context);
  f.user('Implement the next independent objective.');
  await f.hooks.tool.mdd_start.execute({ requirements: f.parent[0].parts[0].text }, f.context);
  f.visited.splice(0);
  await f.phase(); await f.phase(); await f.phase({ outcome: 'failed', exit: 1, unverified: true });
  const second = await f.status();
  const saved = new CheckpointStore(f.root).read(f.runtime.sessionID).checkpoint;
  assert.ok(saved.data.usedMessages.includes(consentUser.info.id));
  const hooks = restart ? await plugin(f.input) : f.hooks;
  f.parent[0] = consentUser;
  for (const runID of [first.runID, second.runID]) await assert.rejects(hooks.tool.mdd_reset.execute({ ...consent, runID }, f.context));
  assert.equal(new RunOwnershipStore(f.root).parent(f.runtime.sessionID), second.runID);
  assert.deepEqual(new CheckpointStore(f.root).read(f.runtime.sessionID).checkpoint, saved);
  assert.deepEqual(JSON.parse(await hooks.tool.mdd_status.execute({ detail: 'full' }, f.context)).workflow, second.workflow);
});

test('SA-3: fresh continuation after restart preserves all previously consumed native identities', async t => {
  const f = await failedVerification(t); const first = await f.status();
  f.user('Continue despite verification.');
  const consumedID = f.parent[0].info.id;
  await f.hooks.tool.mdd_reset.execute({ scope: 'continue', runID: first.runID, userText: f.parent[0].parts[0].text }, f.context);
  f.user('Implement the next independent objective.');
  await f.hooks.tool.mdd_start.execute({ requirements: f.parent[0].parts[0].text }, f.context);
  f.visited.splice(0);
  await f.phase(); await f.phase(); await f.phase({ outcome: 'failed', exit: 1, unverified: true });
  const saved = new CheckpointStore(f.root).read(f.runtime.sessionID).checkpoint;
  assert.ok(saved.data.usedMessages.includes(consumedID));
  const hooks = await plugin(f.input);
  f.user('Proceed despite the second failed verification.');
  const freshID = f.parent[0].info.id;
  const result = JSON.parse(await hooks.tool.mdd_reset.execute({ scope: 'continue', runID: saved.runID, userText: f.parent[0].parts[0].text }, f.context));
  assert.equal(result.state, 'continued-with-failed-verification');
  const archive = new RunDossierStore(f.root).readContinued(f.runtime.sessionID, saved.runID);
  assert.deepEqual(new Set(archive.usedMessages), new Set([...saved.data.usedMessages, saved.data.userMessageID, freshID]));
  assert.deepEqual(archive.verification, saved.data.verification);
  assert.deepEqual(archive.executedChecks, saved.data.executedChecks);
  assert.equal(archive.verificationVersion, saved.data.verificationVersion);
  assert.equal(archive.results.at(-1).outcome, 'failed');
  assert.deepEqual(archive.questionReceipts, [], 'historical receipts must not become live consent after restore');
});

test('SA-3: explicit retry keeps the failed run and does not implicitly continue', async t => {
  const f = await failedVerification(t); const failed = await f.status();
  f.user('Retry the verification.');
  const retry = JSON.parse(await f.hooks.tool.mdd_reset.execute({ scope: 'phase' }, f.context));
  assert.equal(retry.runID, failed.runID);
  assert.equal(retry.phase, 'mdd-verify');
  assert.equal(retry.state, 'ready');
  assert.equal(new RunDossierStore(f.root).readContinued(f.runtime.sessionID, failed.runID), undefined);
  await f.phase();
  assert.equal((await f.status()).state, 'complete');
});

test('SA-3: continuation retires only after archival and leaves the durable failed checkpoint as data', async t => {
  const f = await failedVerification(t); const failed = await f.status();
  const saved = new CheckpointStore(f.root).read(f.runtime.sessionID).checkpoint;
  const progress = new ProgressGuard(f.root).read(f.runtime.sessionID);
  f.user('Proceed despite the failed checks.');
  await f.hooks.tool.mdd_reset.execute({ scope: 'continue', runID: failed.runID, userText: f.parent[0].parts[0].text }, f.context);
  assert.deepEqual(new CheckpointStore(f.root).read(f.runtime.sessionID).checkpoint, saved);
  assert.deepEqual(new ProgressGuard(f.root).read(f.runtime.sessionID), progress);
  const restarted = await plugin(f.input);
  const status = JSON.parse(await restarted.tool.mdd_status.execute({ detail: 'full' }, f.context));
  assert.equal(status.state, 'continued-with-failed-verification');
  assert.equal(status.task, undefined);
  f.user('Implement a new boundary after the continued run.');
  const next = JSON.parse(await restarted.tool.mdd_start.execute({ requirements: f.parent[0].parts[0].text }, f.context));
  assert.equal(next.state, 'ready');
  assert.notEqual(next.runID, saved.runID);
  assert.equal(new RunDossierStore(f.root).readContinued(f.runtime.sessionID, saved.runID).results.at(-1).outcome, 'failed');
});

// Seven phases of maximum-size artifacts outgrow the handoff budget, and the route used to die
// there: at Tasks, Apply or Verify, after everything that produced them had already been paid for.
// The oldest artifacts now travel as their own recorded summary plus the ref that still identifies
// the full text, announced in the prompt, while recent ones stay whole.
test('a long route compacts its oldest artifacts instead of dying at the handoff budget', async t => {
  const f = await fixture(t, { route: 'high' });
  let compacted;
  // The compacted handoff is announced in the prompt of the phase that follows it, and that
  // prompt only exists where it is delivered: in the arguments the hook expands for the actor.
  let compactedPrompt;
  for (let i = 0; i < 7; i++) {
    // Verify reports its own links, which share the artifact bound, so it does not fill it.
    await f.phase({ large: i < 6 });
    if (compacted && compactedPrompt === undefined) compactedPrompt = f.delivered();
    const current = await f.status();
    if (current.handoff && current.task) compacted ??= current;
  }
  const final = await f.status();
  assert.equal(final.state, 'complete');
  assert.ok(f.visited.includes('mdd-verify'));
  assert.ok(compacted, 'a seven-phase route of maximum artifacts must exceed the handoff budget');
  // Oldest first, and the phase that produced each one is still named with its store record.
  assert.equal(compacted.handoff.summarized[0].phase, 'mdd-explore');
  assert.ok(compacted.handoff.summarized.every(item => item.recordID));
  assert.ok(compactedPrompt, 'the compacted handoff must reach an actor');
  assert.equal(compactedPrompt.includes('Artifact for mdd-explore'), false);
  assert.match(compactedPrompt, /appear above as their recorded summary and ref/);
  assert.ok(Buffer.byteLength(compactedPrompt) <= 96000);
  // The coordinator never pays for any of it: what reaches the parent is the handle alone.
  assert.ok(compacted.task.prompt.startsWith('mdd:dispatch:'));
});
test('telemetry storage failure is bounded and does not fabricate a failed phase', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, '.mdd/telemetry.jsonl'), 'malformed private content');
  await f.phase(); await f.phase(); await f.phase();
  const status = await f.status();
  assert.equal(status.state, 'complete');
  assert.equal(status.telemetryDiagnostic, 'telemetry-unavailable');
  assert.ok(!JSON.stringify(status).includes('malformed private content'));
});
test('low route with exploration preserves all four native phases', async t => {
  const f = await fixture(t, { route: 'low-explore' });
  for (let current = await f.status(); current.task; current = await f.status()) await f.phase();
  assert.deepEqual(f.visited, ['mdd-explore', 'mdd-plan', 'mdd-apply', 'mdd-verify']);
  assert.equal((await f.status()).coverage, 100);
});
// A refused native permission belongs to the user and the actor, not to MDD: the write simply
// does not happen and MDD keeps waiting for the delegated result instead of sealing the run.
test('a refused native write leaves the file untouched and the dispatch still awaits its result', async t => {
  const f = await fixture(t); await f.phase();
  await assert.rejects(f.phase({ denied: true }), /Simulated native permission denial/);
  assert.equal(await readFile(join(f.root, 'feature.txt'), 'utf8'), 'pending\n');
  const waiting = await f.status();
  assert.equal(waiting.state, 'await-result');
  assert.equal(waiting.coverage, 40);
  // A tool error without terminal child evidence cannot release the writer.
  await f.hooks.event({ event: { type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'task', sessionID: f.runtime.sessionID, callID: 'task-2', state: { status: 'error' } } } } });
  const released = await f.status();
  assert.equal(released.state, 'await-result'); assert.equal(released.task, undefined);
  await assert.rejects(f.hooks.tool.mdd_reset.execute({ scope: 'phase' }, f.context), /may still be running/);
});

test('confirmed rerun asks every field once despite complete profile and preserves old run evidence', async t => {
  const f = await fixture(t); await f.phase();
  const old = await f.status();
  f.user('Please rerun the preflight for this task.');
  const confirmation = await f.change();
  assert.equal(confirmation.question.questions.length, 1);
  await f.answer();
  const preflight = await f.status(); assert.equal(preflight.question.questions.length, 5);
  assert.equal(preflight.runID, old.runID);
  await f.answer([['Muy seguro'], ['Ninguno'], ['Interactivo'], ['Bajo'], ['Nada que agregar']]);
  const next = await f.status();
  assert.notEqual(next.runID, old.runID); assert.equal(next.task.subagent_type, 'mdd-explore');
  assert.equal(next.previousRuns[0].runID, old.runID);
  assert.deepEqual(next.previousRuns[0].artifacts, old.artifacts);
  assert.deepEqual(next.previousRuns[0].acceptance, old.acceptance);
  assert.equal(next.workflow.answers.mode, 'interactive'); assert.equal(next.previousRuns[0].workflow.answers.mode, 'automatic');
  assert.equal(f.questions(), 2);
  await assert.rejects(f.change(), /already used by MDD\. A rerun needs a new user message/);
});
test('rejected material change restores exact answers, plan and pending approval', async t => {
  const f = await fixture(t, { mode: 'interactive' }); await f.phase();
  const old = await f.status();
  f.user('Consider adding a new integration.'); await f.change('material', 'Implement the feature with the new integration.');
  await f.answer('Mantener el plan actual');
  const current = await f.status();
  assert.equal(current.runID, old.runID); assert.deepEqual(current.workflow, old.workflow);
  assert.deepEqual(current.question, old.question); assert.deepEqual(current.acceptance, old.acceptance);
});
test('confirmed material change replans from new requirements after one grouped preflight', async t => {
  const f = await fixture(t); const old = await f.status();
  f.user('Change the scope to include an integration.');
  await f.change('material', 'New integration requirements.'); await f.answer(); await f.answer();
  const next = await f.status();
  assert.notEqual(next.runID, old.runID);
  assert.equal(next.workflow.results.length, 0); assert.equal(next.acceptance, undefined);
  await f.phase();
  assert.match(f.delivered(), /New integration requirements/);
});
test('invalid change parameters and wrong user text do not poison a ready plan', async t => {
  const f = await fixture(t); const old = await f.status();
  f.user('Please rerun.');
  await assert.rejects(f.hooks.tool.mdd_change_request.execute({ kind: 'rerun', userText: 'forged' }, f.context));
  await assert.rejects(f.hooks.tool.mdd_change_request.execute({ kind: 'material', userText: 'Please rerun.', requirements: 'New scope', concerns: [{ category: 'style', evidence: 'x', impact: 'x' }] }, f.context));
  assert.equal((await f.status()).state, 'ready'); assert.deepEqual((await f.status()).task, old.task);
});
test('known failed phase permits a confirmed new planned run; unknown native result does not', async t => {
  const known = await fixture(t); await known.phase({ outcome: 'failed' });
  assert.equal((await known.status()).uncertain, false);
  const failed = await known.status();
  await known.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Inspect the known failure without retrying it.' }, known.context);
  await known.phase(); assert.deepEqual((await known.status()).workflow, failed.workflow);
  known.user('Replan this failed task.'); await known.change(); await known.answer(); await known.answer();
  assert.equal((await known.status()).state, 'ready'); assert.equal((await known.status()).previousRuns[0].workflow.results.at(-1).outcome, 'failed');
  // A rejected attempt used to mark the run uncertain forever, which then refused every repair
  // path. Releasing it is what keeps replanning, investigation and reset reachable after a failure.
  const unknown = await fixture(t); await assert.rejects(unknown.phase({ badEnvelope: true }));
  assert.equal((await unknown.status()).uncertain, false);
  assert.equal((await unknown.status()).state, 'ready');
  unknown.user('Try again.');
  assert.equal((await unknown.change()).question.questions.length, 1);
});
test('new task after completion uses profile without a redundant change confirmation', async t => {
  const f = await fixture(t); await f.phase(); await f.phase(); await f.phase();
  const old = await f.status(); f.user('A new independent requested outcome.');
  await f.hooks.tool.mdd_start.execute({ requirements: 'A new independent requested outcome.' }, f.context);
  const next = await f.status(); assert.equal(next.state, 'ready'); assert.notEqual(next.runID, old.runID);
  assert.equal(f.questions(), 0); assert.equal(next.previousRuns[0].lastState, 'complete');
});
for (const mode of ['automatic', 'interactive']) {
  test(`contextual exploration preserves ${mode} main workflow and approval`, async t => {
    const f = await fixture(t, { mode, store: 'both' }); await f.phase();
    const old = await f.status();
    await f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Inspect integration uncertainty without changing the plan.' }, f.context);
    const side = await f.status(); assert.equal(side.contextual, true); assert.equal(side.task.subagent_type, 'mdd-explore'); assert.equal(side.question, undefined);
    await assert.rejects(f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Duplicate side task' }, f.context));
    await f.phase({ concerns: [{ category: 'integrations', evidence: 'An integration assumption needs inspection.', impact: 'May affect a later explicit scope request.' }] });
    const current = await f.status();
    assert.deepEqual(current.workflow, old.workflow); assert.deepEqual(current.evidence, old.evidence); assert.deepEqual(current.acceptance, old.acceptance);
    assert.equal(current.contexts.length, 1); assert.match(current.contexts[0].artifact.ref.path, /explorations/);
    assert.equal(current.contexts[0].artifact.ref.explorationID, current.contexts[0].explorationID);
    assert.deepEqual(current.question, old.question);
    if (current.question) await f.answer();
    await f.phase();
    // What the investigation found reaches the next actor as advisory data, never as approval.
    assert.match(f.delivered(), /Contextual findings/);
    assert.match(f.delivered(), /integration assumption needs inspection/);
    assert.equal((await f.status()).contextualReport, undefined);
    assert.equal((await f.status()).contexts.length, 1);
  });
}
test('side exploration does not expose Apply capabilities and invalid purpose leaves main ready', async t => {
  const f = await fixture(t); const old = await f.status();
  await assert.rejects(f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'x'.repeat(2001) }, f.context));
  assert.deepEqual((await f.status()).task, old.task);
  await f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Inspect only.' }, f.context);
  await f.phase({ outcome: 'failed' });
  assert.match(f.delivered(), /Contextual exploration only/);
  assert.deepEqual((await f.status()).workflow, old.workflow); assert.equal((await f.status()).contexts[0].outcome, 'failed');
});
// Regression: one grep refused outside the workspace used to block the whole investigation,
// and every later tool call then reported a misleading dispatch error.
test('a refused read lets the investigation continue instead of ending it', async t => {
  const f = await fixture(t, { start: false, memoryEnabled: false });
  await f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Buscar el issue 389.' }, f.context);
  // phase({denied}) dispatches the task, runs a child read through the hooks, then reports the
  // native permission denial exactly as OpenCode does. Apply's write denial still blocks; see
  // "Apply native refusal or model mismatch prevents writes".
  await assert.rejects(f.phase({ denied: true }), /Simulated native permission denial/);
  const after = await f.status();
  assert.equal(after.state, 'await-result', 'a refused read must not end the investigation');
  assert.equal(after.contextual, true);
});

// Regression: a rewritten mdd_start blocked the intake, and because no run existed the
// change request could never settle it. With a stopped investigation also reporting itself
// as in flight, the conversation had no way out at all.
test('a failed intake can be replaced by a fresh request instead of stranding the parent', async t => {
  const f = await fixture(t, { start: false, memoryEnabled: false });
  f.user('Trabajemos en el issue 389.');
  await assert.rejects(f.hooks.tool.mdd_start.execute({ requirements: 'Un resumen reescrito del issue.' }, f.context),
    /exactly match an actual native user message/);
  assert.equal((await f.status()).state, 'blocked');
  // A stopped standalone investigation must not keep the parent looking busy either.
  await f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Mirar el issue.' }, f.context);
  for (let i = 0; i < 4; i++) await assert.rejects(f.phase({ badEnvelope: true }));
  await f.hooks.tool.mdd_reset.execute({ scope: 'run' }, f.context);
  f.user('Trabajemos en el issue 389.');
  await f.hooks.tool.mdd_start.execute({ requirements: 'Trabajemos en el issue 389.' }, f.context);
  const started = await f.status();
  assert.equal(started.state, 'ready');
  // Every objective starts with exploration; only mdd-risk then selects what follows.
  assert.equal(started.task.subagent_type, 'mdd-explore');
});

// Regression: interrupting the coordinator and then writing "continue" made the continuation the
// latest user text, and the objective it continued could never be started in that conversation.
test('an interrupted objective still starts after the user writes a continuation message', async t => {
  const f = await fixture(t, { start: false, memoryEnabled: false });
  const objective = 'Corrige el bind de memoria cuando la raíz nativa es un worktree.';
  f.user(objective);
  const requested = f.parent[0];
  f.user('te interrumpi, puedes continuar');
  f.parent.unshift(requested);
  // Continuation text is not an objective, and inventing one from it is still refused.
  await assert.rejects(f.hooks.tool.mdd_start.execute({ requirements: 'Un resumen reescrito del objetivo.' }, f.context),
    /exactly match an actual native user message/);
  await f.hooks.tool.mdd_start.execute({ requirements: objective }, f.context);
  const started = await f.status();
  assert.equal(started.state, 'ready');
  // Every objective starts with exploration; only mdd-risk then selects what follows.
  assert.equal(started.task.subagent_type, 'mdd-explore');
});

// A ledger that cannot say what a phase cost cannot answer the question it exists for. The child
// session the task envelope names is the only place that price is reported.
test('a delegated phase records the tokens its own child session reported', async t => {
  const f = await fixture(t, { memoryEnabled: false });
  await f.phase({ spent: { tokens: { input: 1200, output: 340, reasoning: 20, cache: { read: 90, write: 10 } }, cost: 0.0125 } });
  const rows = (await readFile(join(f.root, '.mdd/telemetry.jsonl'), 'utf8')).trim().split('\n').map(row => JSON.parse(row));
  const ended = rows.findLast(row => row.event === 'phase-end');
  assert.deepEqual(ended.usage, { input: 1200, output: 340, reasoning: 20, cacheRead: 90, cacheWrite: 10, cost: 0.0125, messages: 1 });
  assert.equal(ended.phase, 'mdd-plan');
  assert.equal(ended.mode, 'delegate');
  assert.equal(ended.attempt, 1);
  assert.match(ended.runID, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const knowledgeEvents = rows.filter(row => row.event === 'knowledge-dispatch');
  assert.ok(knowledgeEvents.length > 0, 'default-on knowledge records delivery diagnostics without a provider');
  for (const event of knowledgeEvents) {
    assert.deepEqual(Object.keys(event).sort(), ['event', 'knowledge', 'timestamp']);
    assert.ok(Number.isSafeInteger(event.timestamp) && event.timestamp >= 0);
    assert.deepEqual(event.knowledge, { candidates: 0, freshHits: 0, staleRejects: 0,
      selectedReferences: [], selectedSkillIDs: [], selectedBytes: 0, promptByteDelta: 0 });
  }
  assert.deepEqual([...new Set(rows.filter(row => row.event !== 'knowledge-dispatch').map(row => row.runID))], [ended.runID]);
  const rollup = JSON.parse(await readFile(join(f.root, '.mdd/telemetry-rollup.json'), 'utf8'));
  assert.equal(rollup.phases['mdd-plan'].input, 1200);
  assert.equal(rollup.phases['mdd-plan'].cost, 0.0125);
  assert.equal(rollup.phases['mdd-plan'].measured, 1);
  assert.equal(rollup.phases['mdd-plan'].partial, 0);
  // A host that reports no usage produces a run without numbers, never a failed phase.
  await f.phase();
  const quiet = (await readFile(join(f.root, '.mdd/telemetry.jsonl'), 'utf8')).trim().split('\n').map(row => JSON.parse(row)).findLast(row => row.event === 'phase-end');
  assert.equal(quiet.phase, 'mdd-apply');
  assert.equal(quiet.usage, undefined);
  assert.equal((await f.status()).telemetryDiagnostic, undefined);
});

test('a failed attempt is filed under the class that ended it, with what it spent getting there', async t => {
  const f = await fixture(t, { memoryEnabled: false });
  const spent = { tokens: { input: 900, output: 120, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.004 };
  await f.phase({ outcome: 'failed', spent });
  const rows = (await readFile(join(f.root, '.mdd/telemetry.jsonl'), 'utf8')).trim().split('\n').map(row => JSON.parse(row));
  const ended = rows.findLast(row => row.event === 'phase-end');
  assert.equal(ended.outcome, 'failed');
  assert.equal(ended.failure, 'phase-failed');
  assert.equal(ended.usage.input, 900);
  const rollup = JSON.parse(await readFile(join(f.root, '.mdd/telemetry-rollup.json'), 'utf8'));
  assert.equal(rollup.failures['phase-failed'], 1);
  assert.equal(rollup.phases['mdd-plan'].failed, 1);
  assert.equal(rollup.phases['mdd-plan'].input, 900);
  assert.equal(rollup.runs.blocked, 1);
});

test('a result that names no session is charged to nobody rather than to a guess', async t => {
  const f = await fixture(t, { memoryEnabled: false });
  await assert.rejects(f.phase({ badEnvelope: true, spent: { tokens: { input: 900, output: 120, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.004 } }));
  const rows = (await readFile(join(f.root, '.mdd/telemetry.jsonl'), 'utf8')).trim().split('\n').map(row => JSON.parse(row));
  const ended = rows.findLast(row => row.event === 'phase-end');
  assert.equal(ended.outcome, 'blocked');
  assert.equal(ended.failure, 'result-rejected');
  // The envelope that would name the child is exactly what was malformed, so the spending is
  // real but unattributable. Recording it against this phase anyway would be inventing evidence.
  assert.equal(ended.usage, undefined);
  assert.equal(rows.findLast(row => row.event === 'retry').failure, 'result-rejected');
  const rollup = JSON.parse(await readFile(join(f.root, '.mdd/telemetry-rollup.json'), 'utf8'));
  assert.equal(rollup.failures['result-rejected'], 1);
  assert.equal(rollup.phases['mdd-plan'].retries, 1);
  assert.equal(rollup.phases['mdd-plan'].blocked, 1);
  assert.equal(rollup.phases['mdd-plan'].measured, 0);
});

test('read-only investigation answers without an accepted run and leaves implementation available', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Read-only investigation fetched'));
  const f = await fixture(t, { start: false, memoryEnabled: false });
  assert.equal((await f.status()).state, 'not-started');
  await f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Explain what this project is about.' }, f.context);
  const ready = await f.status();
  assert.equal(ready.contextual, true);
  assert.equal(ready.task.subagent_type, 'mdd-explore');
  await assert.rejects(f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'A concurrent investigation.' }, f.context), /already in progress/);
  await f.phase();
  assert.match(f.delivered(), /Standalone read-only investigation only/);
  assert.match(f.delivered(), /No MDD run is accepted/);
  const done = await f.status();
  assert.equal(done.task, undefined);
  assert.equal(done.contextual, false);
  assert.equal(done.contexts.length, 1);
  assert.match(done.contextualReport, /Read-only investigation completed/);
  assert.match(done.contextualReport, /Artifact for mdd-explore/);
  assert.equal(f.writes.length, 0);
  // Standalone investigation leaves no local trace at all: neither a marker nor a preserved run.
  const traces = await readdir(join(f.root, '.mdd')).catch(() => []);
  assert.ok(!traces.some(name => name.startsWith('progress-')));
  assert.ok(!traces.some(name => name.startsWith('run-')));
  f.user(f.requirements);
  await f.hooks.tool.mdd_start.execute({ requirements: f.requirements }, f.context);
  const started = await f.status();
  assert.equal(started.state, 'ready');
  // Every objective starts with exploration; only mdd-risk then selects what follows.
  assert.equal(started.task.subagent_type, 'mdd-explore');
  assert.equal(started.contextual, false);
});
test('a replayed transcript note dispatches the standalone investigation it stands for', async t => {
  const f = await fixture(t, { start: false, memoryEnabled: false });
  await f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Inspect this project.' }, f.context);
  const ready = await f.status();
  // The note names another actor: that is not this investigation, and it stays refused.
  const note = collapsedPrompt('mdd-plan', Buffer.byteLength(ready.task.prompt));
  await assert.rejects(f.hooks['tool.execute.before']({ ...f.runtime, callID: 'solo-note', tool: 'task' },
    { args: { ...ready.task, subagent_type: 'mdd-plan', prompt: note } }), /delivered transcript placeholder is not a task/);
  const after = await f.status();
  assert.equal(after.dispatch.mode, 'handle');
  assert.deepEqual(after.task, ready.task);
  // The same note with the investigation's own description and actor is the handle in another
  // shape: the actor receives the investigation's real prompt, never the note.
  await f.phase({ replayNote: true });
  assert.match(f.delivered(), /Standalone read-only investigation only/);
  assert.equal((await f.status()).contextual, false);
});
{
  test('a standalone investigation exhausts bounded fallback before explicit recovery', async t => {
    const f = await fixture(t, { start: false, memoryEnabled: false });
    await f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Read project context only.' }, f.context);
    for (let i = 0; i < 4; i++) await assert.rejects(f.phase({ badEnvelope: true }));
    const stopped = await f.status();
    // A stopped investigation is finished, not in flight: it must not look like main work.
    assert.equal(stopped.state, 'blocked');
    assert.equal(stopped.fallbackExhausted, true);
    assert.ok(stopped.reason, 'the rejection stays visible');
    assert.equal(await readFile(join(f.root, 'feature.txt'), 'utf8'), 'pending\n');
    await f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Ask a different read-only question.' }, f.context);
    assert.equal((await f.status()).task.subagent_type, 'mdd-explore');
  });
}
test('a restarted conversation still answers read-only investigation', async t => {
  const f = await fixture(t, { memoryEnabled: false });
  await f.phase();
  const restarted = await plugin(f.input);
  // The run resumes, and read-only investigation stays reachable on it.
  assert.equal(JSON.parse(await restarted.tool.mdd_status.execute({}, f.context)).state, 'ready');
  await restarted.tool.mdd_contextual_explore.execute({ purpose: 'Explain the recorded project state.' }, f.context);
  const ready = JSON.parse(await restarted.tool.mdd_status.execute({}, f.context));
  assert.equal(ready.contextual, true);
  assert.equal(ready.task.subagent_type, 'mdd-explore');
  await assert.rejects(restarted.tool.mdd_start.execute({ requirements: 'Continue the old work.' }, f.context));
  // A run that could not keep a resumable checkpoint is reported as data; investigation still works.
  const g = await fixture(t, { memoryEnabled: false });
  await g.phase();
  withdrawResume(g);
  const dataOnly = await plugin(g.input);
  assert.equal(JSON.parse(await dataOnly.tool.mdd_status.execute({}, g.context)).state, 'recoverable');
  await dataOnly.tool.mdd_contextual_explore.execute({ purpose: 'Explain the recorded project state.' }, g.context);
  const side = JSON.parse(await dataOnly.tool.mdd_status.execute({}, g.context));
  assert.equal(side.contextual, true);
  assert.equal(side.task.subagent_type, 'mdd-explore');
});

test('a run lost mid-route keeps its plan reachable as read-only data', async t => {
  // The actual incident: the process died during mdd-apply after ~40 minutes. Artifacts were
  // persisted in Engram, but the index naming them lived only in memory, so nothing was findable.
  const f = await fixture(t, { route: 'low-explore', store: 'engram' });
  const phases = (await f.status()).workflow.evaluation.phases;
  // Only exploration is on the route until mdd-risk selects the rest; phase() drives that stop.
  assert.deepEqual(phases, ['mdd-explore']);
  await f.phase(); await f.phase();
  const live = await f.status();
  assert.equal(live.state, 'ready');
  assert.equal(live.task.subagent_type, 'mdd-apply');
  // With its checkpoint current, a restarted plugin resumes the run at mdd-apply.
  const resumed = JSON.parse(await (await plugin(f.input)).tool.mdd_status.execute({}, f.context));
  assert.equal(resumed.state, 'ready');
  assert.equal(resumed.runID, live.runID);
  assert.equal(resumed.task.subagent_type, 'mdd-apply');
  // When the checkpoint could not be kept current, the plan must still be reachable as data.
  withdrawResume(f);
  // Fresh instances over the same directory hold empty maps, exactly like a restarted plugin.
  const restarted = await plugin(f.input);
  const status = JSON.parse(await restarted.tool.mdd_status.execute({}, f.context));
  assert.equal(status.state, 'recoverable');
  assert.equal(status.recovery, 'data-only');
  assert.equal(status.priorRun.capability, 'data-only');
  assert.equal(status.priorRun.runID, live.runID);
  assert.equal(status.priorRun.phase, 'mdd-apply');
  assert.deepEqual(status.priorRun.results.map(item => item.phase), ['mdd-explore', 'mdd-plan']);
  assert.equal(status.priorRun.requirements, f.requirements);
  // What the lost time actually bought: the acceptance map, the plan and the artifact bodies.
  assert.equal(status.priorRun.acceptance.goal, traceFixture().acceptance.goal);
  assert.equal(status.priorRun.planned.length, 1);
  assert.equal(status.priorRun.artifacts.length, 2);
  assert.match(status.priorRun.artifacts[1].content, /Artifact for mdd-plan/);
  // The Engram observation ID is retained as a diagnostic identifier, not as a live capability.
  assert.ok(status.priorRun.artifacts[1].ref.observationID);
  // It is evidence, never something runnable, and it says plainly what it cannot know.
  assert.equal(status.task, undefined);
  assert.equal(status.workflow, undefined);
  assert.ok(status.limits.some(limit => /git status/.test(limit)), 'the working tree must be declared unknown');
  assert.ok(status.limits.some(limit => /approval/i.test(limit)));
  assert.match(status.reason, /does not resume/i);
  // A preserved run informs the restart; it never blocks it. New consent starts new work.
  f.user('Retomemos el objetivo original con consentimiento nuevo.');
  const fresh = JSON.parse(await restarted.tool.mdd_start.execute({ requirements: 'Retomemos el objetivo original con consentimiento nuevo.' }, f.context));
  assert.equal(fresh.state, 'ready');
  assert.notEqual(fresh.runID, live.runID);
  // The new run earns its own evidence: nothing is inherited from the record.
  assert.equal(fresh.workflow.results.length, 0);
  assert.equal(fresh.acceptance, undefined);
  assert.equal(fresh.priorRun, undefined);
});

// The incident: "Continúa el issue #433" in a new conversation started a second run from the bare
// sentence, while the run that had planned that issue sat in the same workspace. A new
// conversation now sees it, with how it resumes, and the advertised route actually works.
test('a new conversation finds a run recorded by another one and can take it over', async t => {
  const f = await fixture(t, { memoryEnabled: false });
  await f.phase();
  const live = await f.status();
  assert.equal(live.state, 'ready');
  assert.equal(live.workspaceRuns, undefined, 'a conversation with its own run is not sent elsewhere');
  const other = 'ses_other';
  const model = { providerID: 'contract-only', modelID: 'model' };
  const say = text => f.histories.set(other, [
    { info: { id: `user-${other}`, sessionID: other, role: 'user' }, parts: [{ type: 'text', text, sessionID: other, messageID: `user-${other}` }] },
    { info: { id: `msg-${other}`, sessionID: other, role: 'assistant', agent: 'mdd-orchestrator', ...model, path: { cwd: f.root, root: f.root } }, parts: [] },
  ]);
  f.sessions.set(other, { id: other, agent: 'mdd-orchestrator', directory: f.root, projectID: 'project' });
  // Restoring a transferred run re-reads its exact native request, which the fixture never needed.
  f.input.client.session.message = async ({ path }) => ({ data: f.histories.get(path.id)?.find(item => item.info.id === path.messageID) });
  say('Continúa el objetivo anterior.');
  const context = { ...f.runtime, sessionID: other, messageID: `msg-${other}`, abort: new AbortController().signal };
  // Read through the default compact view: that is what a coordinator sees before deciding.
  const idle = JSON.parse(await f.hooks.tool.mdd_status.execute({}, context));
  assert.equal(idle.state, 'not-started');
  assert.equal(idle.workspaceRuns.length, 1);
  const [found] = idle.workspaceRuns;
  assert.equal(found.runID, live.runID);
  assert.equal(found.sessionID, f.runtime.sessionID);
  assert.equal(found.requirements, f.requirements);
  assert.deepEqual(found.passed, ['mdd-explore', 'mdd-plan']);
  assert.equal(found.phase, 'mdd-apply');
  assert.equal(found.resume, 'transfer');
  assert.equal(idle.task, undefined, 'a listed run authorizes nothing');
  assert.match(idle.nextAction.why, /workspaceRuns/);
  assert.match(idle.nextAction.why, /do not call mdd_start/);
  // The resume hint is the transfer projection's own answer, so following it succeeds.
  const request = `Continúa sourceSessionID=${found.sessionID} runID=${found.runID}`;
  say(request);
  const moved = JSON.parse(await f.hooks.tool.mdd_transfer.execute({ sourceSessionID: found.sessionID, runID: found.runID, userText: request }, context));
  assert.equal(moved.transfer?.state, 'confirmed', JSON.stringify(moved));
  assert.equal(moved.runID, live.runID);
  // A third conversation never sees the copy the run left behind in its old conversation.
  const third = 'ses_third';
  f.sessions.set(third, { id: third, agent: 'mdd-orchestrator', directory: f.root, projectID: 'project' });
  f.histories.set(third, [
    { info: { id: `user-${third}`, sessionID: third, role: 'user' }, parts: [{ type: 'text', text: 'Hola.', sessionID: third, messageID: `user-${third}` }] },
    { info: { id: `msg-${third}`, sessionID: third, role: 'assistant', agent: 'mdd-orchestrator', ...model, path: { cwd: f.root, root: f.root } }, parts: [] },
  ]);
  const later = JSON.parse(await f.hooks.tool.mdd_status.execute({}, { ...context, sessionID: third, messageID: `msg-${third}` }));
  assert.ok(!(later.workspaceRuns ?? []).some(run => run.sessionID === f.runtime.sessionID));
});

test('a preserved run restores no approval and no live consent receipt', async t => {
  const f = await fixture(t, { mode: 'interactive', partial: true, memoryEnabled: false });
  await f.answer();
  await f.phase();
  assert.equal((await f.status()).question.questions[0].header, 'Aprobación');
  await f.answer();
  const live = await f.status();
  assert.ok(live.questionReceipts.some(item => item.kind === 'approval'));
  // Resumed in the same conversation: the approval that was applied stays applied, but no receipt
  // is reloaded as live consent and no question is re-asked from history.
  const resumed = JSON.parse(await (await plugin(f.input)).tool.mdd_status.execute({}, f.context));
  assert.equal(resumed.state, 'ready');
  assert.equal(resumed.runID, live.runID);
  assert.deepEqual(resumed.questionReceipts, []);
  assert.equal(resumed.question, undefined);
  // As data only (checkpoint withdrawn), nothing at all is authorized.
  withdrawResume(f);
  const restarted = await plugin(f.input);
  const status = JSON.parse(await restarted.tool.mdd_status.execute({}, f.context));
  assert.equal(status.state, 'recoverable');
  // Receipts are a historical record of what the user was asked, never live consent: their call
  // IDs are anti-reuse guards, so loading them would both fake approval and cause false refusals.
  assert.deepEqual(status.questionReceipts, []);
  assert.ok(status.priorRun.questionReceipts.some(item => item.kind === 'approval'));
  // There is no restored workflow for an approval to authorize, so no phase is dispatchable.
  assert.equal(status.task, undefined);
  assert.equal(status.next, undefined);
  assert.equal(status.question, undefined);
  // The new run wins its own preflight; the old confirmed requirements flag is not inherited.
  f.user('Empecemos de nuevo con este objetivo.');
  const fresh = JSON.parse(await restarted.tool.mdd_start.execute({ requirements: 'Empecemos de nuevo con este objetivo.' }, f.context));
  assert.equal(fresh.state, 'question-ready');
  assert.deepEqual(fresh.questionReceipts, []);
});

test('mdd_reset with scope run frees the conversation and sets the record aside, memory off', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Memory off fetched'));
  const f = await fixture(t, { memoryEnabled: false });
  await f.phase();
  const names = async () => readdir(join(f.root, '.mdd')).catch(() => []);
  assert.ok((await names()).some(name => name.startsWith('run-')), 'evidence is preserved without memory');
  const restarted = await plugin(f.input);
  const status = JSON.parse(await restarted.tool.mdd_status.execute({ detail: 'full' }, f.context));
  assert.equal(status.state, 'ready');
  assert.equal(status.memory, 'off');
  assert.equal(status.workflow.results.length, 2); // explore, plan
  JSON.parse(await restarted.tool.mdd_reset.execute({ scope: 'run' }, f.context));
  // The live record is gone, so nothing holds the conversation or offers a recovery it cleared.
  assert.ok(!(await names()).some(name => /^run-[a-f0-9]{64}\.json$/.test(name)), 'the live record no longer occupies the conversation');
  assert.ok(!(await names()).some(name => /^checkpoint-[a-f0-9]{64}\.json$/.test(name)), 'the checkpoint no longer occupies the conversation');
  // What the run produced is not destroyed by the request to start something else.
  assert.ok((await names()).some(name => name.endsWith('.discarded.json')), 'the evidence is set aside, not deleted');
  assert.equal(JSON.parse(await restarted.tool.mdd_status.execute({}, f.context)).state, 'not-started');
  // The discarded run's old plugin instance is fenced: it no longer owns the conversation.
  await assert.rejects(f.phase());
  // A second discard replaces that slot instead of filling the directory with one file per reset.
  f.user('A second objective to discard.');
  await restarted.tool.mdd_start.execute({ requirements: 'A second objective to discard.' }, f.context);
  JSON.parse(await restarted.tool.mdd_reset.execute({ scope: 'run' }, f.context));
  assert.equal((await names()).filter(name => name.endsWith('.discarded.json')).length, 1);
});

test('restart detects pending work without repeating memory writes', async t => {
  const f = await fixture(t, { partial: true }); await f.answer(); const ready = await f.status();
  const call = { sessionID: f.runtime.sessionID, callID: 'uncertain-task', tool: 'task' };
  f.parent[1].parts = [{ type: 'tool', tool: 'task', callID: call.callID, state: { status: 'running', input: ready.task } }];
  await f.hooks['tool.execute.before'](call, { args: ready.task });
  f.user('Rerun while still pending.'); await assert.rejects(f.change(), /in flight/);
  const restarted = await plugin(f.input);
  const status = JSON.parse(await restarted.tool.mdd_status.execute({}, f.context));
  assert.equal(status.state, 'recovery-blocked');
  assert.equal(status.recoverable, true);
  assert.equal(status.question, undefined);
  const writes = f.writes.length;
  await assert.rejects(restarted.tool.mdd_start.execute({ requirements: 'Rerun while still pending.' }, f.context), /mdd_reset/);
  assert.equal(f.writes.length, writes);
  // Reset cannot manufacture evidence that the old child stopped.
  await assert.rejects(restarted.tool.mdd_reset.execute({ scope: 'run' }, f.context), /unconfirmed liveness[\s\S]*userText[\s\S]*What OpenCode reports/);
  const blocked = JSON.parse(await restarted.tool.mdd_status.execute({}, f.context));
  assert.equal(blocked.state, 'recovery-blocked');
  // Status says what OpenCode actually sees, and how the user's word gets the conversation out.
  assert.equal(blocked.liveness.verdict, 'unknown');
  assert.match(blocked.nextAction.why, /userText/);
  assert.equal(f.writes.length, writes);
  // The user's word is their own latest message, never the model's paraphrase of it.
  f.user('El subagente está detenido, podés continuar.');
  await assert.rejects(restarted.tool.mdd_reset.execute({ scope: 'run', userText: 'The user confirmed it stopped.' }, f.context), /exact latest message/);
  assert.equal(JSON.parse(await restarted.tool.mdd_status.execute({}, f.context)).state, 'recovery-blocked');
  const released = JSON.parse(await restarted.tool.mdd_reset.execute({ scope: 'run', userText: 'El subagente está detenido, podés continuar.' }, f.context));
  assert.equal(released.state, 'not-started');
  assert.equal(released.liveness.verdict, 'unknown');
});

for (const stage of ['confirmation', 'preflight']) {
  test(`dismissed change ${stage} restores the original pending approval`, async t => {
    const f = await fixture(t, { mode: 'interactive' }); await f.phase(); const old = await f.status();
    f.user('Rerun preflight.'); await f.change(); if (stage === 'preflight') await f.answer();
    const current = await f.status();
    const call = { sessionID: f.runtime.sessionID, callID: `cancel-${stage}`, tool: 'question' };
    f.parent[1].parts = [{ type: 'tool', tool: 'question', callID: call.callID, sessionID: f.runtime.sessionID, messageID: f.context.messageID, state: { status: 'running', input: current.question } }];
    await f.hooks['tool.execute.before'](call, { args: current.question });
    await f.hooks.event({ event: { type: 'message.part.updated', properties: { part: { ...call, type: 'tool', state: { status: 'error' } } } } });
    const restored = await f.status(); assert.equal(restored.runID, old.runID); assert.deepEqual(restored.workflow, old.workflow); assert.deepEqual(restored.question, old.question);
  });
}
test('stale change confirmation cannot approve a later phase or erase the old run', async t => {
  const f = await fixture(t); await f.phase(); f.user('Rerun preflight.'); await f.change();
  const used = await f.answer(); await f.answer(); const next = await f.status();
  await assert.rejects(f.hooks['tool.execute.after']({ ...used.call, args: used.args }, { title: 'Approved', output: 'approved', metadata: { answers: [['Confirmar el cambio']], truncated: false } }));
  const blocked = await f.status(); assert.equal(blocked.runID, next.runID); assert.equal(blocked.previousRuns.length, 1); assert.equal(blocked.workflow.results.length, 0);
});
test('a side exploration exhausts its own fallback then restores the main plan untouched', async t => {
  const f = await fixture(t); const main = await f.status();
  await f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Read context only.' }, f.context);
  for (let i = 0; i < 4; i++) await assert.rejects(f.phase({ badEnvelope: true }));
  const status = await f.status();
  assert.deepEqual(status.workflow, main.workflow); assert.deepEqual(status.evidence, main.evidence);
  assert.equal(status.contextual, false);
  // The restored plan is the same phase and the same task; only its handle is retired with the
  // investigation that borrowed the dispatch, so a stale one cannot start the main phase.
  assert.equal(status.task.description, main.task.description);
  assert.equal(status.task.subagent_type, main.task.subagent_type);
  assert.notEqual(status.task.prompt, main.task.prompt);
  await f.phase();
  assert.match(f.delivered(), /Perform only mdd-plan/);
});
test('advisory concerns alone do not change routing or create a confirmation question', async t => {
  const f = await fixture(t); const initial = await f.status();
  await f.phase({ concerns: [{ category: 'sensitive-data', evidence: 'A data handling assumption needs review.', impact: 'May matter if scope changes.' }] });
  const status = await f.status(); assert.equal(status.question, undefined); assert.deepEqual(status.workflow.answers, initial.workflow.answers);
  assert.equal(status.concerns[0].category, 'sensitive-data'); assert.equal(f.questions(), 0);
});
test('a recorded material concern can be proposed once without inventing new human input', async t => {
  const f = await fixture(t);
  const concern = { category: 'integrations', evidence: 'The inspected integration assumption differs from the original scope.', impact: 'A new integration would require replanning.' };
  await f.phase({ concerns: [concern] }); const old = await f.status();
  const args = { kind: 'material', userText: f.parent[0].parts[0].text, requirements: 'Implement a different integration.', concerns: [concern] };
  await f.hooks.tool.mdd_change_request.execute(args, f.context);
  await f.answer('Mantener el plan actual');
  await assert.rejects(f.hooks.tool.mdd_change_request.execute(args, f.context), /already presented/);
  assert.deepEqual((await f.status()).workflow, old.workflow);
});
test('mdd_change_request accepts concerns the host tool bridge serialized as a JSON string', async t => {
  const f = await fixture(t);
  const concern = { category: 'integrations', evidence: 'The host serialized this concern as a JSON string.', impact: 'The bridge must still validate it strictly.' };
  // Recorded first through the ordinary array form, as any concern must be, so the fresh-message
  // guard below is satisfied by a matching recorded concern rather than by an unused user message.
  await f.phase({ concerns: [concern] });
  const args = { kind: 'material', userText: f.parent[0].parts[0].text, requirements: 'Implement a different integration.', concerns: JSON.stringify([concern]) };
  const status = JSON.parse(await f.hooks.tool.mdd_change_request.execute(args, f.context));
  assert.equal(status.question.questions[0].header, 'Cambio');
  assert.match(status.question.questions[0].question, /integrations/);
});
test('a fresh user message is enough for a material change: concerns are optional', async t => {
  const f = await fixture(t); await f.phase();
  f.user('Change the scope: also remove the obsolete context cap.');
  const status = JSON.parse(await f.hooks.tool.mdd_change_request.execute({ kind: 'material', userText: f.parent[0].parts[0].text, requirements: 'Also remove the obsolete context cap.' }, f.context));
  assert.equal(status.question.questions[0].header, 'Cambio');
  assert.doesNotMatch(status.question.questions[0].question, /Evidencia advertida/);
});
test('mdd_change_request accepts a single bare concern object and an empty concerns string', async t => {
  const f = await fixture(t); await f.phase();
  const concern = { category: 'objective', evidence: 'The user widened the scope.', impact: 'The plan must be redone.' };
  f.user('Widen the scope to include the recovery path.');
  const single = JSON.parse(await f.hooks.tool.mdd_change_request.execute({ kind: 'material', userText: f.parent[0].parts[0].text, requirements: 'Include the recovery path.', concerns: concern }, f.context));
  assert.match(single.question.questions[0].question, /objective/);
  await f.answer('Mantener el plan actual');
  f.user('Widen it again, differently.');
  const empty = JSON.parse(await f.hooks.tool.mdd_change_request.execute({ kind: 'material', userText: f.parent[0].parts[0].text, requirements: 'Include a different recovery path.', concerns: '  ' }, f.context));
  assert.equal(empty.question.questions[0].header, 'Cambio');
});
test('a spent user message still needs recorded concerns, and the refusal says how to proceed', async t => {
  const f = await fixture(t); await f.phase(); const before = await f.status();
  await assert.rejects(f.hooks.tool.mdd_change_request.execute({ kind: 'material', userText: f.parent[0].parts[0].text, requirements: 'Something else entirely.' }, f.context), /already used by MDD\. Ask the user to state the change in a new message/);
  await assert.rejects(f.hooks.tool.mdd_change_request.execute({ kind: 'material', userText: f.parent[0].parts[0].text, requirements: 'Something else entirely.',
    concerns: [{ category: 'objective', evidence: 'Never recorded by any phase.', impact: 'None.' }] }, f.context), /already used by MDD/);
  assert.deepEqual((await f.status()).workflow, before.workflow);
});
test('decoded concerns are still validated strictly', async t => {
  const f = await fixture(t); await f.phase();
  f.user('Change the scope.');
  const base = { kind: 'material', userText: f.parent[0].parts[0].text, requirements: 'A changed scope.' };
  const nine = Array.from({ length: 9 }, () => ({ category: 'objective', evidence: 'x', impact: 'y' }));
  await assert.rejects(f.hooks.tool.mdd_change_request.execute({ ...base, concerns: JSON.stringify(nine) }, f.context), /at most eight/);
  await assert.rejects(f.hooks.tool.mdd_change_request.execute({ ...base, concerns: JSON.stringify([{ category: 'style', evidence: 'x', impact: 'y' }]) }, f.context), /Unknown material-change category/);
  await assert.rejects(f.hooks.tool.mdd_change_request.execute({ ...base, concerns: '"just text"' }, f.context), /must decode to an array/);
  // Concerns text has no transport size limit; a large payload is still validated by content.
  await assert.rejects(f.hooks.tool.mdd_change_request.execute({ ...base, concerns: `[${'"x",'.repeat(4000)}"x"]` }, f.context), /at most eight/);
});
test('mdd_change_request rejects a concerns string that is not valid JSON, without recording anything', async t => {
  const f = await fixture(t); const before = await f.status();
  const args = { kind: 'material', userText: f.parent[0].parts[0].text, requirements: 'Implement a different integration.', concerns: '{not json' };
  await assert.rejects(f.hooks.tool.mdd_change_request.execute(args, f.context), /not valid JSON/);
  assert.deepEqual((await f.status()).workflow, before.workflow);
});
test('context accumulation is bounded without truncating results or advancing the main workflow', async t => {
  const f = await fixture(t); await f.phase(); const main = await f.status();
  let stopped = false;
  // The last status that still reported the findings themselves. Accumulated context eventually
  // pushes the payload past its budget, and the findings are one of the first things it sheds, so
  // the non-truncation evidence is read from a status that still carried them.
  let reported;
  for (let i = 0; i < 8; i++) {
    try {
      await f.hooks.tool.mdd_contextual_explore.execute({ purpose: `Read-only investigation ${i}.` }, f.context);
      await f.phase({ large: true });
      const now = await f.status();
      if (now.contexts?.length) reported = now;
    } catch (error) { assert.match(error.message, /combined phase handoff/); stopped = true; break; }
  }
  assert.equal(stopped, true);
  const final = await f.status();
  // The main route did not move: phase and next action are protected fields, so they answer this
  // whatever the payload budget had to shed.
  assert.equal(final.phase, main.phase);
  assert.deepEqual(final.next, main.next);
  // The workflow snapshot is droppable. Accumulated context makes the phase prompt large enough to
  // reach that point, and when it does the field must be declared in `omitted`, never silently
  // missing: an unannounced disappearance is the failure the budget module exists to prevent.
  if (final.workflow === undefined) assert.ok(final.omitted?.includes('workflow'), 'a dropped workflow must be declared');
  else assert.deepEqual(final.workflow, main.workflow);
  if (final.contexts === undefined) assert.ok(final.omitted?.includes('contexts'), 'dropped findings must be declared');
  assert.ok(reported, 'the accumulated findings were reported before the budget had to shed them');
  // The status reports the ref only; the bytes it records still prove nothing was truncated.
  assert.ok(reported.contexts.every(context => context.artifact.content === undefined && context.artifact.ref.bytes === 16000));
});

// The observed failure: mdd_status grew past the host output limit, the host truncated it and
// saved the rest to a file, the coordinator could no longer copy the exact task, and it
// abandoned delegation to implement the phase itself. The status must stay copyable instead.
test('a large history keeps mdd_status within budget and the task byte-identical for dispatch', async t => {
  const f = await fixture(t, { route: 'high' });
  await f.phase({ large: true });
  // A superseded run leaves its own history and contexts behind in previousRuns.
  f.user('Please rerun the preflight for this task.');
  await f.change(); await f.answer();
  await f.answer([['Poco seguro'], ['Ninguno'], ['Automático'], ['Bajo'], ['Nada que agregar']]);
  f.visited.length = 0;
  await f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Inspect the current feature boundary.' }, f.context);
  await f.phase({ large: true });
  await f.phase({ large: true });
  const previous = await f.status();
  assert.ok(previous.previousRuns === undefined || previous.previousRuns.length === 1);
  // The full view is the one that can reach the budget at all, so it is the one this guards.
  const raw = await f.hooks.tool.mdd_status.execute({ detail: 'full' }, f.context);
  assert.ok(Buffer.byteLength(raw) <= STATUS_BUDGET_BYTES, `mdd_status was ${Buffer.byteLength(raw)} bytes`);
  const status = JSON.parse(raw);
  assert.equal(status.budget, undefined, 'the task fits without an unresolved budget problem');
  // Compacting the oldest artifacts keeps the handoff deliverable in the first place, so a large
  // history no longer has to shed reportable fields; when it still does, it declares them.
  if (status.omitted !== undefined) {
    assert.ok(status.omitted.length > 0, 'what was left out is declared, not silently missing');
    assert.match(status.omittedNote, /Nothing was deleted/);
    for (const key of status.omitted) assert.equal(status[key], undefined);
  }
  assert.ok(status.task && status.state === 'ready');
  // The invariant the bug broke: the task read back from a budgeted status still satisfies the
  // byte-for-byte check in PhaseRunner.before, so delegation survives a large history.
  await f.phase({ large: true });
  const after = await f.status();
  assert.notEqual(after.phase, status.phase, 'the delegated phase actually advanced');
  assert.ok(after.task, 'the next phase stays dispatchable');
});

test('a settled dispatch stops being re-read, while the run still dispatches the next phase', async t => {
  const f = await fixture(t, { route: 'high' });
  await f.phase({ large: true });

  // This is the real mechanism, not a stand-in: `before` expanded the handle by mutating the very
  // args object the host recorded in the part, so the transcript now holds the whole phase prompt.
  const recorded = f.parent[1].parts[0];
  assert.equal(recorded.tool, 'task');
  assert.ok(Buffer.byteLength(recorded.state.input.prompt) > 2000, 'the fixture must hold a real expanded prompt');
  const expanded = recorded.state.input.prompt;
  recorded.state.status = 'completed';

  const outgoing = structuredClone(f.parent);
  await f.hooks['experimental.chat.messages.transform']({}, { messages: outgoing });
  const sent = outgoing[1].parts[0].state.input.prompt;
  assert.notEqual(sent, expanded);
  assert.ok(Buffer.byteLength(sent) < Buffer.byteLength(expanded) / 4, `collapsed to ${Buffer.byteLength(sent)} of ${Buffer.byteLength(expanded)}`);
  assert.match(sent, /omitted from the transcript/);
  // The run's own record is untouched: only what travels to the model changed.
  assert.equal(f.parent[1].parts[0].state.input.prompt, expanded);

  // A model may replay the transcript note as a fresh task argument. Aimed at another actor it is
  // not a lost handle: rejecting it must leave the exact compact task available, not expose a
  // truncated full prompt.
  const ready = await f.status();
  await assert.rejects(f.hooks['tool.execute.before']({ ...f.runtime, callID: 'transcript-replay', tool: 'task' },
    { args: { ...ready.task, subagent_type: 'mdd-verify', prompt: sent } }), /delivered transcript placeholder is not a task/);
  await assert.rejects(f.hooks['tool.execute.before']({ ...f.runtime, callID: 'transcript-replay-2', tool: 'task' },
    { args: { ...ready.task, prompt: sent, background: true } }), /Task arguments differ/);
  const recoveredRaw = await f.hooks.tool.mdd_status.execute({}, f.context);
  assert.ok(Buffer.byteLength(recoveredRaw) <= STATUS_BUDGET_BYTES);
  const recovered = JSON.parse(recoveredRaw);
  assert.equal(recovered.state, 'ready');
  assert.equal(recovered.dispatch.mode, 'handle');
  assert.deepEqual(recovered.task, ready.task);

  // Aimed at this phase and actor it is the handle in the shape the model saw last, and on the
  // observed run it was the only shape the model could produce: it dispatches, and the actor
  // receives the run's own prompt rather than the note.
  await f.phase({ large: true, replayNote: true });
  assert.ok(Buffer.byteLength(f.delivered()) > 2000, 'the note must be expanded into the real prompt');
  assert.doesNotMatch(f.delivered(), /omitted from the transcript/);
  const next = await f.status();
  assert.ok(next.task || next.state === 'complete');
});

test('the compact view keeps the protocol and sheds what a later turn would only re-read', async t => {
  const f = await fixture(t, { route: 'high' });
  await f.phase({ large: true });
  await f.phase({ large: true });

  const compactRaw = await f.hooks.tool.mdd_status.execute({}, f.context);
  const fullRaw = await f.hooks.tool.mdd_status.execute({ detail: 'full' }, f.context);
  const compact = JSON.parse(compactRaw);
  const full = JSON.parse(fullRaw);

  // The point of the view: the same run, materially cheaper to carry through a long conversation.
  assert.ok(Buffer.byteLength(compactRaw) < Buffer.byteLength(fullRaw),
    `compact ${Buffer.byteLength(compactRaw)} should be smaller than full ${Buffer.byteLength(fullRaw)}`);

  // Dispatch is the invariant that must survive any projection: the coordinator copies this
  // object verbatim, and PhaseRunner.before compares it with isDeepStrictEqual.
  assert.deepEqual(compact.task, full.task);
  assert.equal(compact.state, full.state);
  assert.equal(compact.phase, full.phase);
  assert.deepEqual(compact.next, full.next);
  assert.deepEqual(compact.nextAction, full.nextAction);
  assert.deepEqual(compact.resultFormat, full.resultFormat);

  // Reference material is gone from compact, still there in full, and never silently missing.
  const shed = STATUS_DROP_ORDER.filter(key => !STATUS_COMPACT_KEEP.includes(key) && full[key] !== undefined);
  assert.ok(shed.length > 0, 'the fixture must actually hold reference material to shed');
  for (const key of shed) {
    assert.equal(compact[key], undefined, `${key} should not ride along in the compact view`);
    assert.ok(compact.omitted.includes(key), `${key} should be declared as omitted`);
  }
  assert.match(compact.omittedNote, /Nothing was deleted/);
  assert.match(compact.omittedNote, /detail="full"/);

  // Progress survives without the prose: which phases are recorded is protocol, the summary a
  // person reads about a phase that already closed is not.
  assert.equal(compact.workflow.results.length, full.workflow.results.length);
  assert.deepEqual(compact.workflow.results.map(item => item.phase), full.workflow.results.map(item => item.phase));
  assert.deepEqual(compact.workflow.results.map(item => item.outcome), full.workflow.results.map(item => item.outcome));
  assert.ok(full.workflow.results.every(item => typeof item.evidenceSummary === 'string'));
  assert.ok(compact.workflow.results.every(item => item.evidenceSummary === undefined));
  assert.ok(compact.omitted.includes('workflow.results[].evidenceSummary'));

  // A protected field is protected in both views, or the projection would be shedding protocol.
  for (const key of STATUS_PROTECTED_FIELDS) {
    if (full[key] === undefined) continue;
    assert.deepEqual(compact[key], full[key], `protected field ${key} must survive the compact view`);
  }

  // The phase still dispatches from the compact payload, which is the whole reason it may ship.
  const call = { sessionID: f.context.sessionID, callID: 'compact-dispatch', tool: 'task' };
  await f.hooks['tool.execute.before'](call, { args: compact.task });
});

test('every MDD tool but an explicit full status answers compactly', async t => {
  const f = await fixture(t, { route: 'high' });
  await f.phase({ large: true });
  const held = JSON.parse(await f.hooks.tool.mdd_status.execute({ detail: 'full' }, f.context));
  const heavy = STATUS_DROP_ORDER.filter(key => !STATUS_COMPACT_KEEP.includes(key) && held[key] !== undefined);
  assert.ok(heavy.length > 0, 'the fixture must hold reference material for this to mean anything');

  // mdd_reset returned a whole snapshot on every call, which made releasing a phase one of the
  // most expensive things a run could do. It reports where the run stands, not what it holds.
  const released = JSON.parse(await f.hooks.tool.mdd_reset.execute({ scope: 'phase' }, f.context));
  assert.deepEqual(released.reset, { scope: 'phase', phase: held.phase });
  for (const key of heavy) assert.equal(released[key], undefined, `mdd_reset should not carry ${key}`);

  // Contributing context answers with the updated task, not with the run's reference material.
  const added = JSON.parse(await f.hooks.tool.mdd_context.execute(
    { label: 'Prior decision', content: 'Keep the current exit codes.' }, f.context));
  assert.ok(added.task, 'the recomposed task still comes back');
  for (const key of heavy) assert.equal(added[key], undefined, `mdd_context should not carry ${key}`);
});

// Delegation is the default route, never the only one: a subagent that cannot finish the work
// must not be able to stop the user. The phase comes back to the coordinator instead.
test('three settled failures select native fallback and the next phase delegates normally', async t => {
  const f = await fixture(t);
  const initial = await f.status();
  assert.equal(initial.mode, 'delegate');
  assert.ok(initial.task, 'delegation is offered first');
  assert.equal(initial.attemptsLeft, 3, 'the phase is told how many dispatches it has');
  // A failure buys another delegated attempt that knows what went wrong: handing the phase over
  // immediately spends the parent's context on work that was delegated to keep it out of there.
  for (const left of [2, 1]) {
    await assert.rejects(f.phase({ badEnvelope: true }), /dispatch its updated task/);
    const retry = await f.status();
    assert.equal(retry.state, 'ready');
    assert.equal(retry.mode, 'delegate');
    assert.equal(retry.attemptsLeft, left);
    assert.equal(retry.brief, undefined);
  }
  // Each retry is dispatched carrying what the previous attempt failed at. The parent only ever
  // holds a handle now, so what the actor received is read from the delivered prompt.
  assert.match(f.delivered(), /previous attempt at this exact phase did not complete/);
  await assert.rejects(f.phase({ badEnvelope: true }), /single tracked native fallback/);
  const handed = await f.status();
  assert.equal(handed.state, 'ready');
  assert.equal(handed.mode, 'native');
  assert.equal(handed.attempts, 3);
  assert.equal(handed.attemptsLeft, 0);
  assert.equal(handed.brief, undefined);
  assert.equal(handed.task.subagent_type, 'general');
  const done = await f.phase();
  assert.equal(done.workflow.results.length, 2); // explore, then the plan that needed fallback
  assert.equal(done.workflow.results[1].phase, 'mdd-plan');
  assert.equal(done.evidence.plan, 'confirmed');
  assert.equal(done.task.subagent_type, 'mdd-apply');
  assert.equal(done.mode, 'delegate', 'the next phase starts from delegation again');
  // The failures belonged to the phase that spent them. Carrying them into the next phase is what
  // made one struggling phase send the whole rest of the route into the coordinator's context.
  assert.equal(done.attempts, 0, 'the next phase starts with its own count');
  assert.equal(done.attemptsLeft, 3);
  assert.equal(done.runAttempts, 3, 'the run-wide total still records what was spent');
  assert.equal(JSON.parse(await f.hooks.tool.mdd_status.execute({}, f.context)).artifacts.length, 2);
});

test('an inline report is refused when no phase is waiting for one', async t => {
  const f = await fixture(t, { start: false, memoryEnabled: false });
  await assert.rejects(f.hooks.tool.mdd_phase_result.execute({ result: { phase: 'mdd-plan', runID: 'invented', outcome: 'passed', evidenceSummary: 'x', artifact: 'y' } }, f.context),
    /No rejected investigation report/);
  f.user(f.requirements);
  await f.hooks.tool.mdd_start.execute({ requirements: f.requirements }, f.context);
  const ready = await f.status();
  await f.hooks.tool.mdd_phase_result.execute({ result: 'Select native execution instead of coordinator work.' }, f.context);
  // A report MDD could not read costs no attempt: the work it describes may already be done, so
  // the phase stays runnable, the text comes back, and the coordinator restates it.
  const after = await f.status();
  assert.equal(after.state, 'ready');
  assert.equal(after.attempts, 0, 'a malformed report must not spend an attempt');
  assert.equal(after.mode, 'native');
  // Every run starts with exploration, whose native executor is explore.
  assert.equal(after.task.subagent_type, 'explore');
  assert.equal(after.workflow.results.length, 0);
  assert.equal(after.rejected, undefined);
});

test('a phase whose report only needs restating is not run again', async t => {
  const f = await fixture(t, { memoryEnabled: false });
  const ready = await f.status();
  // The actor did the work and described it in a shape MDD cannot read.
  await assert.rejects(f.phase({ reportText: 'I finished the plan. Everything looks good.' }), /needs the headings/);
  const held = await f.status();
  assert.equal(held.attempts, 0);
  assert.equal(held.workflow.results.length, 1); // only the exploration that precedes the plan
  // Restating the same work in the right form records it, without dispatching anything.
  const restated = JSON.parse(await f.hooks.tool.mdd_phase_result.execute({ result: reportDocument({
    outcome: 'passed', evidenceSummary: 'Planned the CLI boundary change.',
    artifact: 'Plan: validate at the CLI boundary; run npm test afterwards.',
    ...traceFixture(join(f.root, 'feature.txt'), 'feature'),
  }) }, f.context));
  assert.equal(ready.phase, 'mdd-explore');
  assert.equal(restated.workflow.results[1].phase, 'mdd-plan');
  assert.equal(restated.evidence.plan, 'confirmed');
  assert.equal(restated.rejected, undefined, 'a recorded result clears the report it replaced');
});

test('an MDD run dispatches only its own phase actors', async t => {
  const f = await fixture(t, { memoryEnabled: false });
  const ready = await f.status();
  await assert.rejects(
    f.hooks['tool.execute.before']({ sessionID: f.runtime.sessionID, callID: 'foreign-1', tool: 'task' },
      { args: { description: 'Do the thing', subagent_type: 'gentle-ai', prompt: 'anything' } }),
    /Task arguments differ/);
  // The refusal changes nothing: the real phase is still exactly where it was.
  const held = await f.status();
  assert.equal(held.state, 'ready');
  assert.equal(held.attempts, 0);
  assert.equal(held.task.subagent_type, ready.phase);
});

test('MDD tools belong to the coordinator and are withdrawn from every other agent', async t => {
  const f = await fixture(t, { start: false });
  const foreign = { ...f.context, agent: 'gentle-ai' };
  const args = { requirements: 'x', userText: 'x', purpose: 'x', kind: 'rerun', scope: 'run', title: 'x', detail: 'x' };
  for (const name of ['mdd_status', 'mdd_start', 'mdd_phase_result', 'mdd_reset', 'mdd_change_request', 'mdd_contextual_explore', 'mdd_pr_body', 'mdd_improve', 'mdd_improvements']) {
    await assert.rejects(f.hooks.tool[name].execute(args, foreign), /mdd-orchestrator/, `${name} answered a foreign agent`);
  }
  const config = { agent: { 'gentle-ai': {}, 'mdd-orchestrator': {} } };
  await f.hooks.config(config);
  assert.equal(config.agent['gentle-ai'].tools.mdd_status, false);
  assert.equal(config.agent['gentle-ai'].tools['mdd_*'], false);
  assert.equal(config.agent['mdd-orchestrator'].tools, undefined);
});

test('tracked native children cannot recurse or use MDD tools; unrelated native sessions are unchanged', async t => {
  const f = await fixture(t, { memoryEnabled: false });
  await f.hooks.tool.mdd_phase_result.execute({ result: 'Select native work.' }, f.context);
  await f.phase();
  for (const tool of ['task', 'skill', 'mdd_check_report', 'mdd_start']) {
    await assert.rejects(f.hooks['tool.execute.before']({ sessionID: 'child-1', callID: `nested-${tool}`, tool }, { args: {} }), /tracked native fallback/);
  }
  await assert.rejects(f.hooks.tool.mdd_check_report.execute({ phase: 'mdd-plan', result: 'anything' }, { ...f.context, sessionID: 'child-1', agent: 'general' }), /belongs to MDD phase actors/);
  const args = { subagent_type: 'general', description: 'Unrelated work', prompt: 'Independent native task' };
  const before = structuredClone(args);
  const call = { sessionID: 'unrelated-parent', callID: 'unrelated', tool: 'task' };
  // Unresolved native identity fails closed; a valid unrelated conversation remains untouched.
  await assert.rejects(f.hooks['tool.execute.before'](call, { args }), /Unknown OpenCode response structure/);
  assert.deepEqual(args, before);
  f.sessions.set(call.sessionID, { id: call.sessionID, agent: 'general', directory: f.root, projectID: 'project' });
  f.histories.set(call.sessionID, [{
    info: { id: 'msg_unrelated', sessionID: call.sessionID, agent: 'general', role: 'assistant',
      providerID: 'contract-only', modelID: 'model', path: { cwd: f.root, root: f.root } },
    parts: [{ type: 'tool', tool: call.tool, callID: call.callID, sessionID: call.sessionID,
      messageID: 'msg_unrelated', state: { status: 'running', input: structuredClone(args) } }],
  }]);
  await f.hooks['tool.execute.before'](call, { args });
  assert.deepEqual(args, before);
});

test('uncertain Apply cannot skip interactive approval or automatically retry partial writes', async t => {
  const f = await fixture(t, { mode: 'interactive', memoryEnabled: false });
  await f.hooks.tool.mdd_phase_result.execute({ result: 'Use native exploration.' }, f.context);
  await f.phase();
  // The risk stop dispatches without an approval of its own; the first tail phase then waits for one.
  await f.phase({ only: true });
  const approval = await f.status();
  assert.equal(approval.state, 'question-ready');
  assert.equal(approval.task, undefined);
  await assert.rejects(f.hooks.tool.mdd_phase_result.execute({ result: 'Skip approval.' }, f.context), /approval|question|not waiting|active/);
  await f.answer();
  await f.phase();
  await f.answer();
  await assert.rejects(f.phase({ badEnvelope: true }));
  assert.equal(await readFile(join(f.root, 'feature.txt'), 'utf8'), 'implemented\n');
  const stopped = await f.status();
  assert.equal(stopped.phase, 'mdd-apply');
  assert.equal(stopped.state, 'blocked');
  assert.equal(stopped.task, undefined);
  assert.equal(new ProgressGuard(f.root).read(f.runtime.sessionID).state, 'pending');
});

// A harness that cannot be told what it did badly can only be corrected by the person who
// remembers. These two tools are the record, and the record is local first: memory indexes it so
// another conversation can find it, and memory being off is an ordinary way to run MDD.
test('a failed attempt records its own improvement, and the user can record one deliberately', async t => {
  const f = await fixture(t);
  await assert.rejects(f.phase({ badEnvelope: true }));
  const automatic = JSON.parse(await f.hooks.tool.mdd_improvements.execute({}, f.context));
  assert.equal(automatic.total, 1);
  assert.equal(automatic.lessons[0].source, 'failure');
  assert.equal(automatic.lessons[0].phase, 'mdd-plan');
  assert.equal(automatic.lessons[0].kind, 'result-rejected');
  assert.match(automatic.lessons[0].title, /attempt 1 of 3 did not complete/);
  assert.match(automatic.report, /Automejoras anotadas de MDD/);

  f.user('Quiero que guardes ese error para que te automejores.');
  const recorded = JSON.parse(await f.hooks.tool.mdd_improve.execute({
    userText: 'Quiero que guardes ese error para que te automejores.',
    title: 'El reporte se presentó en inglés',
    detail: 'Debía presentarse en español, traduciendo solo la prosa del subagente y conservando las secciones.',
  }, f.context));
  assert.equal(recorded.recorded.source, 'user');
  assert.equal(recorded.total, 2);
  // Memory is an index over the local record, so the entry is both on disk and in the provider.
  assert.equal(recorded.memory, 'saved');
  const saved = f.memory.writes.find(write => write.type === 'mdd-lesson');
  assert.match(saved.title, /^MDD lesson v1:/);
  assert.equal(JSON.parse(saved.content).kind, 'mdd-improvement');

  const all = JSON.parse(await f.hooks.tool.mdd_improvements.execute({ query: 'inglés' }, f.context));
  assert.equal(all.memory, 'searched');
  assert.deepEqual(all.lessons.map(lesson => lesson.source), ['user']);
  assert.match(all.report, /pedida por vos/);
  // Recording is not fixing: nothing about the run moved.
  const status = await f.status();
  assert.equal(status.phase, 'mdd-plan');
  assert.equal(status.state, 'ready');
});

test('an improvement is recorded with memory off, and only the user\'s own words record one', async t => {
  const f = await fixture(t, { memoryEnabled: false });
  await assert.rejects(f.hooks.tool.mdd_improve.execute({
    userText: 'Something the user never wrote.', title: 'x', detail: 'y',
  }, f.context), /latest native user text/);
  f.user('Anotá que el PR salió en inglés.');
  const recorded = JSON.parse(await f.hooks.tool.mdd_improve.execute({
    userText: 'Anotá que el PR salió en inglés.',
    title: 'El PR body salió en inglés',
    detail: 'El cuerpo del PR debe ir en español y sin el aviso de borrador.',
    phase: 'mdd-verify',
  }, f.context));
  assert.equal(recorded.memory, 'off');
  assert.equal(recorded.recorded.phase, 'mdd-verify');
  assert.match(recorded.note, /Optional memory is off/);
  const listed = JSON.parse(await f.hooks.tool.mdd_improvements.execute({}, f.context));
  assert.equal(listed.memory, 'off');
  assert.equal(listed.total, 1);
  assert.equal(listed.fromMemory, undefined);
});

test('mdd_reset releases a stopped phase and a whole run without a new conversation', async t => {
  const f = await fixture(t);
  await assert.rejects(f.phase({ badEnvelope: true }));
  assert.equal((await f.status()).attempts, 1);
  const released = JSON.parse(await f.hooks.tool.mdd_reset.execute({ scope: 'phase' }, f.context));
  assert.deepEqual(released.reset, { scope: 'phase', phase: 'mdd-plan' });
  assert.equal(released.state, 'ready');
  assert.equal(released.attempts, 0);
  assert.equal(released.attemptsLeft, 3, 'releasing a phase restores its dispatches');
  assert.equal(released.reason, '');
  await f.phase();
  assert.equal((await f.status()).workflow.results.length, 2); // explore, plan
  const cleared = JSON.parse(await f.hooks.tool.mdd_reset.execute({ scope: 'run' }, f.context));
  assert.equal(cleared.reset.scope, 'run');
  assert.equal(cleared.state, 'not-started');
  // Freeing the conversation is not destroying what it produced: the record is set aside, named,
  // and no longer reported as recoverable, so the recorded plan survives the reset that frees it.
  assert.match(cleared.reset.preserved.file, /\.mdd\/run-[a-f0-9]{64}\.discarded\.json$/);
  const preserved = JSON.parse(await readFile(join(f.root, cleared.reset.preserved.file), 'utf8'));
  assert.equal(preserved.runID, cleared.reset.preserved.runID);
  assert.equal(preserved.results.length, 2);
  assert.ok(preserved.discardedAt > 0);
  f.user('An entirely different objective.');
  assert.equal(JSON.parse(await f.hooks.tool.mdd_start.execute({ requirements: 'An entirely different objective.' }, f.context)).state, 'ready');
});

/**
 * The Spanish a coordinator would send back for this fixture's recorded prose. Anything it does
 * not name is returned as recorded, which is how a text that is already Spanish passes unchanged.
 */
const PR_SPANISH = {
  'delivered.what': 'Ahora la entrada inválida se rechaza en el borde de la feature.',
  'delivered.implies': 'Quien usa la feature recibe un error claro en lugar de un cambio no buscado.',
  goal: 'Dejar la feature pedida usable, con un manejo de entrada claro.',
  verification: 'El manejo de entrada pedido quedó implementado.',
};
async function prBody(f, userText, notes, spanish = PR_SPANISH) {
  const args = { userText, ...(notes ? { notes } : {}) };
  const request = JSON.parse(await f.hooks.tool.mdd_pr_body.execute(args, f.context));
  assert.equal(request.render, 'pending-translation');
  const translations = request.entries.map(entry => ({ key: entry.key, text: spanish[entry.key] ?? entry.text }));
  return { request, draft: JSON.parse(await f.hooks.tool.mdd_pr_body.execute({ ...args, digest: request.digest, translations }, f.context)) };
}

test('native PR-body tool drafts recorded facts without changing workflow, approval or memory', async t => {
  const f = await fixture(t); await f.phase(); await f.phase(); await f.phase();
  f.user('Please draft the PR body.\nNo aplica.');
  const before = await f.status(); const writes = f.writes.length;
  const { draft } = await prBody(f, 'Please draft the PR body.\nNo aplica.', { environmentVariables: 'No aplica.', deployment: 'No aplica.' });
  assert.match(draft.body, /\| Archivo \| Por qué cambió \|/); assert.match(draft.body, /Comandos registrados: 1 en total, 1 con salida 0\./);
  assert.match(draft.body, /Con salida 0: `npm test`\./);
  // The reason the apply phase recorded travels all the way into the row a reviewer reads.
  assert.match(draft.body, /Implementa el manejo de entrada que pide el plan/);
  // What the change delivers opens the body; how it was built stays in the table below it.
  assert.match(draft.body, /## Resumen\n\nAhora la entrada inválida se rechaza en el borde de la feature\./);
  assert.doesNotMatch(draft.body, /Draft only|Nothing was committed/);
  assert.equal(draft.publication, 'not-authorized'); assert.equal(draft.provenance.runID, before.runID);
  assert.ok(!draft.body.includes(f.root)); assert.deepEqual(await f.status(), before); assert.equal(f.writes.length, writes);
});

// Every sentence of substance in the body was recorded in English by a phase. Rendering it as it
// was recorded is what put "Verified the implementation" under a Spanish heading for a reviewer.
test('a body cannot be rendered from prose that was never translated, and drafting stops asking', async t => {
  const f = await fixture(t); await f.phase(); await f.phase(); await f.phase();
  f.user('Please draft the PR body.');
  const args = { userText: 'Please draft the PR body.' };
  const request = JSON.parse(await f.hooks.tool.mdd_pr_body.execute(args, f.context));
  const untranslated = request.entries.map(entry => ({ key: entry.key, text: entry.text }));
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(f.hooks.tool.mdd_pr_body.execute({ ...args, digest: request.digest, translations: untranslated }, f.context), /no parece estar en español/);
  }
  // Bounded: a model that failed three times at translating a paragraph is not one try away.
  await assert.rejects(f.hooks.tool.mdd_pr_body.execute({ ...args, digest: request.digest, translations: untranslated }, f.context), /failed its checks 3 times/);
  // Asking again for the recorded text is the way out, and it restores the budget.
  const { draft } = await prBody(f, 'Please draft the PR body.');
  assert.match(draft.body, /## Resumen\n\nAhora la entrada inválida/);
  // Translations alone prove nothing: without the digest they could answer any evidence at all.
  await assert.rejects(f.hooks.tool.mdd_pr_body.execute({ ...args, translations: untranslated }, f.context), /digest/);
});

// A summary is the least important thing a phase reports and the easiest to get wrong. Losing a
// finished implementation over one would trade real work for a paragraph.
test('a malformed change summary is named back to the phase without failing the implementation', async t => {
  const f = await fixture(t); await f.phase(); await f.phase({ badSummary: true });
  // Named in the recorded result, so the phase is told what was dropped, and nothing else lost.
  assert.match(f.writes.map(write => JSON.stringify(write)).join(''), /ignoredFields.{0,16}delivered/);
  assert.equal((await f.status()).evidence.implementation, 'confirmed');
  await f.phase();
  assert.equal((await f.status()).state, 'complete');
  f.user('Please draft the PR body.');
  const { request, draft } = await prBody(f, 'Please draft the PR body.');
  assert.deepEqual(request.entries.map(entry => entry.key), ['goal', 'file.0', 'verification']);
  assert.match(draft.body, /## Resumen\n\nDejar la feature pedida usable/);
  assert.match(draft.body, /No se registró un resumen del cambio/);
});
// The coordinator's context window is a resource the protocol spends. It used to spend it twice
// per attempt on a prompt the coordinator never reads, which is what filled it and got the
// conversation compacted. What reaches the parent now is a handle and the derived next call.
test('the dispatch contract keeps whole phase prompts out of the coordinator conversation', async t => {
  const f = await fixture(t, { route: 'high' });
  let worst = 0;
  let prompts = 0;
  for (let i = 0; i < 3; i++) {
    const ready = await f.status();
    const text = JSON.stringify(ready);
    worst = Math.max(worst, Buffer.byteLength(text));
    assert.ok(ready.task.prompt.startsWith('mdd:dispatch:'));
    assert.match(ready.dispatch.note, /single-use MDD dispatch handle/);
    // Not one line of the phase prompt reaches the conversation, which is the whole claim.
    assert.equal(text.includes('Perform only mdd-'), false, 'a phase prompt leaked into the parent payload');
    assert.equal(text.includes('Packaged MDD actor instructions'), false);
    await f.phase({ large: true });
    // The actor still receives everything: nothing was shortened, only moved off the transcript.
    assert.ok(Buffer.byteLength(f.delivered()) > 3000);
    prompts += Buffer.byteLength(f.delivered());
  }
  // The dispatched prompts alone used to be written into this conversation twice over. What the
  // parent keeps now is the run's own evidence, and it stays a fraction of what it carried.
  assert.ok(worst < prompts / 2, `status payload grew to ${worst} bytes against ${prompts} bytes of prompt`);
});

test('a dispatch handle is single-use and never survives the prompt it stood for', async t => {
  const f = await fixture(t);
  const first = (await f.status()).task;
  await f.phase();
  const second = (await f.status()).task;
  assert.notEqual(second.prompt, first.prompt, 'a new phase mints a new handle');
  // A handle from a phase that is already recorded must not be able to start the next one.
  await assert.rejects(f.hooks['tool.execute.before']({ ...f.runtime, callID: 'replay', tool: 'task' }, { args: first }),
    /Read mdd_status and pass its exact task object/);
  assert.equal((await f.status()).state, 'ready');
});

// A prompt that arrives as neither the handle nor the real text is the one failure that says the
// handle did not travel. The run stops saving bytes rather than stop being dispatchable.
test('a handle that cannot travel falls back to the full prompt instead of blocking the phase', async t => {
  const f = await fixture(t);
  const ready = await f.status();
  await assert.rejects(f.hooks['tool.execute.before']({ ...f.runtime, callID: 'lost', tool: 'task' },
    { args: { ...ready.task, prompt: 'I will write the prompt myself.' } }), /full phase prompt instead/);
  const after = await f.status();
  assert.equal(after.state, 'ready');
  assert.equal(after.dispatch, undefined, 'the fallback stops advertising a handle');
  assert.match(after.task.prompt, /Perform only mdd-explore/);
  assert.deepEqual(after.nextAction.args, after.task);
  // And the phase still dispatches, which is the entire point of degrading rather than refusing.
  const output = { args: after.task };
  await f.hooks['tool.execute.before']({ ...f.runtime, callID: 'recovered', tool: 'task' }, output);
  assert.equal((await f.status()).state, 'await-result');
  assert.match(output.args.prompt, /Native callID="recovered"/);
});

// `nextAction.args` repeats whatever `task` holds, so exposing the full prompt doubles it in one
// payload. Once that doubled payload could not fit the tool transport budget, falling back to it
// would only replace one undispatchable shape with another; a fresh compact handle stays usable.
test('an unrecognised prompt too large to expose in full reminted a fresh compact handle instead', async t => {
  const f = await fixture(t);
  await f.hooks.tool.mdd_context.execute({ label: 'Large material', content: 'x'.repeat(20000) }, f.context);
  const ready = await f.status();
  assert.ok(ready.task.prompt.startsWith('mdd:dispatch:'), 'the run still holds a compact handle before the mismatch');
  await assert.rejects(f.hooks['tool.execute.before']({ ...f.runtime, callID: 'lost', tool: 'task' },
    { args: { ...ready.task, prompt: 'I will write the prompt myself.' } }), /fresh compact handle instead/);
  const after = await f.status();
  assert.equal(after.state, 'ready');
  // A fresh handle was minted rather than the full prompt being exposed.
  assert.ok(after.task.prompt.startsWith('mdd:dispatch:'));
  assert.notEqual(after.task.prompt, ready.task.prompt);
  assert.equal(after.dispatch.mode, 'handle');
  // The phase still dispatches normally through the reminted handle.
  const output = { args: after.task };
  await f.hooks['tool.execute.before']({ ...f.runtime, callID: 'recovered', tool: 'task' }, output);
  assert.equal((await f.status()).state, 'await-result');
});

test('phase reset restores a compact fresh handle after full-prompt fallback', async t => {
  const f = await fixture(t);
  const ready = await f.status();
  await assert.rejects(f.hooks['tool.execute.before']({ ...f.runtime, callID: 'lost', tool: 'task' },
    { args: { ...ready.task, prompt: 'unknown substituted prompt' } }), /full phase prompt instead/);
  assert.equal((await f.status()).dispatch, undefined);

  const resetRaw = await f.hooks.tool.mdd_reset.execute({ scope: 'phase' }, f.context);
  assert.ok(Buffer.byteLength(resetRaw) <= STATUS_BUDGET_BYTES);
  const reset = JSON.parse(resetRaw);
  assert.equal(reset.state, 'ready');
  assert.equal(reset.dispatch.mode, 'handle');
  assert.notEqual(reset.task.prompt, ready.task.prompt);
  assert.ok(reset.task.prompt.startsWith('mdd:dispatch:'));
  const output = { args: reset.task };
  await f.hooks['tool.execute.before']({ ...f.runtime, callID: 'reset-recovered', tool: 'task' }, output);
  assert.equal((await f.status()).state, 'await-result');
});

// Compaction is not a failure and MDD's state never lived in the transcript. What the coordinator
// loses is its own memory of the protocol, so the run restates itself from state instead.
test('a compacted conversation is handed the run back as a card, not left to reconstruct it', async t => {
  const f = await fixture(t);
  await f.phase();
  const before = await f.status();
  assert.equal(before.compacted, undefined);
  assert.equal(before.runCard, undefined);
  await f.hooks.event({ event: { type: 'session.compacted', properties: { sessionID: f.runtime.sessionID } } });
  const after = await f.status();
  assert.equal(after.compacted, 1);
  assert.equal(after.runCard.runID, before.runID);
  assert.equal(after.runCard.objective, f.requirements);
  assert.deepEqual(after.runCard.completed, ['mdd-explore: passed', 'mdd-plan: passed']);
  assert.equal(after.runCard.phase, after.phase);
  assert.match(after.runCard.note, /Recorded results must not be repeated/);
  // The card is a description, never a capability: nothing about the run moved.
  assert.deepEqual(after.workflow, before.workflow);
  assert.deepEqual(after.evidence, before.evidence);
  assert.equal(after.nextAction.tool, 'task');
  // Counted where the cost of an oversized conversation becomes visible.
  const rollup = JSON.parse(await readFile(join(f.root, '.mdd/telemetry-rollup.json'), 'utf8'));
  assert.equal(rollup.runs.compacted, 1);
  // A conversation MDD is not running is none of its business.
  await f.hooks.event({ event: { type: 'session.compacted', properties: { sessionID: 'ses_other' } } });
  assert.equal((await f.status()).compacted, 1);
});

// A conversation that dies at its first question used to leave the workspace exactly as it found
// it, so the most expensive failures were also the invisible ones.
test('the workspace records that a coordinator opened MDD here, before any run exists', async t => {
  const f = await fixture(t, { start: false, memoryEnabled: false });
  assert.equal((await f.status()).state, 'not-started');
  const sessions = (await readFile(join(f.root, '.mdd/sessions.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionID, f.runtime.sessionID);
  assert.equal(sessions[0].agent, 'mdd-orchestrator');
  assert.equal(sessions[0].directory, f.root);
  // Recorded once per conversation, not once per tool call.
  await f.status(); await f.status();
  assert.equal((await readFile(join(f.root, '.mdd/sessions.jsonl'), 'utf8')).trimEnd().split('\n').length, 1);
});

// The dossier keeps one slot per conversation and telemetry counts events without saying which
// run they belonged to, so a repository could run MDD for months and still have nothing to review.
test('a finished run leaves a row a later review can read, and the retro reads it', async t => {
  const f = await fixture(t, { memoryEnabled: false });
  await f.phase(); await f.phase(); await f.phase();
  assert.equal((await f.status()).state, 'complete');

  const rows = (await readFile(join(f.root, '.mdd/runs.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'complete');
  assert.equal(rows[0].phase, 'mdd-verify');
  assert.deepEqual(rows[0].route, ['mdd-explore', 'mdd-plan', 'mdd-apply', 'mdd-verify']);
  assert.equal(rows[0].coverage, 100);
  assert.equal(rows[0].changedFiles, 1);
  assert.deepEqual(rows[0].checks, { total: 1, passed: 1, failed: 0 });
  assert.equal(rows[0].directory, f.root);
  assert.match(rows[0].goal, /Make the requested feature usable/);

  const { text } = retroReport(f.root);
  assert.match(text, /Retrospectiva de MDD/);
  assert.match(text, /completa en mdd-verify · 100% de cobertura · 1 archivo\(s\)/);
  assert.match(text, /Make the requested feature usable/);
});

// entrecuadras runs MDD inside a linked worktree that is deleted the moment its task is done.
// Anchored there, every record the run produced went down with it — the dossier a later run could
// have restarted from, and the lessons the repository was meant to accumulate across its worktrees.
// They belong to the repository now, and the worktree keeps no .mdd of its own to lose.
test('a run in a linked worktree keeps its records in the repository, not the worktree', async t => {
  const f = await fixture(t, { worktree: true, memoryEnabled: false });
  await f.phase(); await f.phase(); await f.phase();
  assert.equal((await f.status()).state, 'complete');
  f.user('Guardá este aprendizaje para que te automejores.');
  await f.hooks.tool.mdd_improve.execute({ userText: 'Guardá este aprendizaje para que te automejores.',
    title: 'Un aprendizaje deliberado', detail: 'Anotado a mano para comprobar dónde queda el archivo local de lecciones.' }, f.context);

  // The repository holds everything the run and the coordinator produced.
  const repo = await readdir(join(f.mainRoot, '.mdd'));
  assert.ok(repo.some(name => /^run-[a-f0-9]{64}\.json$/.test(name)), `dossier missing from repo: ${repo}`);
  assert.ok(repo.includes('sessions.jsonl'), `session ledger missing from repo: ${repo}`);
  assert.ok(repo.includes('telemetry.jsonl'), `telemetry missing from repo: ${repo}`);
  assert.ok(repo.includes('lessons.jsonl'), `lessons missing from repo: ${repo}`);
  assert.ok(repo.includes('runs.jsonl'), `run ledger missing from repo: ${repo}`);

  // The worktree that will be deleted has no .mdd of its own to take down with it.
  await assert.rejects(readdir(join(f.root, '.mdd')), /ENOENT/);

  // The improvements reader resolves the same repository from inside the worktree.
  const listed = JSON.parse(await f.hooks.tool.mdd_improvements.execute({}, f.context));
  assert.equal(listed.total, 1);
});

test('PR-body tool preserves pending approval and refuses wrong user/parent evidence claims', async t => {
  const f = await fixture(t, { mode: 'interactive' }); await f.phase(); f.user('Draft a preliminary PR body.');
  const before = await f.status();
  const { draft } = await prBody(f, 'Draft a preliminary PR body.');
  assert.match(draft.body, /No se registró ningún cambio de implementación/); assert.match(draft.body, /no están verificados del todo/);
  await assert.rejects(f.hooks.tool.mdd_pr_body.execute({ userText: 'The work was approved and deployed.' }, f.context));
  await assert.rejects(f.hooks.tool.mdd_pr_body.execute({ userText: 'Draft a preliminary PR body.' }, { ...f.context, sessionID: 'other-parent' }));
  assert.deepEqual(await f.status(), before);
});

// ---------------------------------------------------------------------------------------------
// Resume hardening: each test reproduces one defect an independent audit found with checkpoint,
// ownership and restore always on. They are named after the audit finding they pin down.
// ---------------------------------------------------------------------------------------------
const STOPPED = 'I stopped the interrupted subagent.';
const questionAnswer = (args, label) => ({ title: `Asked ${args.questions.length} question${args.questions.length > 1 ? 's' : ''}`,
  output: `User has answered your questions: ${args.questions.map(q => `"${q.question}"="${label}"`).join(', ')}. You can now continue with the user's answers in mind.`,
  metadata: { answers: args.questions.map(() => [label]), truncated: false } });
function dispatchQuestion(f, callID, args) {
  f.parent[1].parts = [{ type: 'tool', tool: 'question', callID, sessionID: f.runtime.sessionID, messageID: f.context.messageID,
    state: { status: 'running', input: structuredClone(args) } }];
  return f.hooks['tool.execute.before']({ sessionID: f.runtime.sessionID, callID, tool: 'question' }, { args });
}
function dispatchTask(f, callID, args) {
  f.parent[1].parts = [{ type: 'tool', tool: 'task', callID, state: { status: 'running', input: structuredClone(args) } }];
  return f.hooks['tool.execute.before']({ sessionID: f.runtime.sessionID, callID, tool: 'task' }, { args });
}

test('audit D1: run discard after restart, without reading status first, frees the parent for a new objective', async t => {
  const f = await fixture(t, { memoryEnabled: false, store: 'none' });
  await f.phase();
  const ready = await f.status();
  await dispatchTask(f, 'task-before-discard-restart', structuredClone(ready.task));
  const resumed = await plugin(f.input);
  f.user(STOPPED);
  const discarded = JSON.parse(await resumed.tool.mdd_reset.execute({ scope: 'run', userText: STOPPED }, f.context));
  assert.equal(discarded.reset.scope, 'run');
  assert.equal(new RunOwnershipStore(f.root).parent(f.runtime.sessionID), undefined);
  assert.equal(new CheckpointStore(f.root).read(f.runtime.sessionID), undefined);
  f.user('Build a different objective after the discard.');
  const fresh = JSON.parse(await resumed.tool.mdd_start.execute({ requirements: 'Build a different objective after the discard.' }, f.context));
  assert.equal(fresh.state, 'ready');
  assert.notEqual(fresh.runID, ready.runID);
});

test('audit D1: run discard after a restore blocked by unavailable Engram frees the parent', async t => {
  const f = await fixture(t, { memoryEnabled: true, store: 'engram' });
  await f.phase();
  const ready = await f.status();
  const project = f.memory.binding.project;
  f.memory.binding.project = 'different-project';
  const resumed = await plugin(f.input);
  const blocked = JSON.parse(await resumed.tool.mdd_status.execute({}, f.context));
  assert.equal(blocked.state, 'recovery-blocked');
  await resumed.tool.mdd_reset.execute({ scope: 'run' }, f.context);
  assert.equal(new RunOwnershipStore(f.root).parent(f.runtime.sessionID), undefined);
  f.memory.binding.project = project;
  f.user('Start again with the memory service back.');
  const fresh = JSON.parse(await resumed.tool.mdd_start.execute({ requirements: 'Start again with the memory service back.' }, f.context));
  assert.equal(fresh.state, 'ready');
  assert.notEqual(fresh.runID, ready.runID);
});

test('audit D2: a pending change question survives restart and an attested reset releases it', async t => {
  const f = await fixture(t, { memoryEnabled: false, store: 'none' });
  await f.phase();
  const ready = await f.status();
  f.user('Please rerun the preflight for this task.');
  const args = structuredClone((await f.change()).question);
  assert.equal(args.questions[0].header, 'Cambio');
  await dispatchQuestion(f, 'change-before-restart', args);
  const resumed = await plugin(f.input);
  assert.equal(JSON.parse(await resumed.tool.mdd_status.execute({}, f.context)).state, 'recovery-blocked');
  f.user('I stopped the interrupted question.');
  const released = JSON.parse(await resumed.tool.mdd_reset.execute({ scope: 'phase', userText: 'I stopped the interrupted question.' }, f.context));
  assert.equal(released.state, 'ready');
  assert.equal(released.runID, ready.runID);
  assert.equal(new RunOwnershipStore(f.root).read(ready.runID).state, 'idle');
  // The old native answer can never be turned into a confirmed change afterwards.
  await assert.rejects(resumed['tool.execute.after']({ sessionID: f.runtime.sessionID, callID: 'change-before-restart', tool: 'question', args },
    questionAnswer(args, 'Confirmar el cambio')));
  const after = JSON.parse(await resumed.tool.mdd_status.execute({ detail: 'full' }, f.context));
  assert.equal(after.state, 'ready');
  assert.equal(after.runID, ready.runID);
  assert.equal(after.task.subagent_type, 'mdd-apply');
});

test('audit D2: a pending re-preflight question on an existing run survives restart and an attested reset', async t => {
  const f = await fixture(t, { memoryEnabled: false, store: 'none' });
  await f.phase();
  const ready = await f.status();
  f.user('Please rerun the preflight for this task.');
  await f.change();
  await f.answer();
  const preflight = await f.status();
  assert.equal(preflight.question.questions.length, 5);
  await dispatchQuestion(f, 'preflight-before-restart', structuredClone(preflight.question));
  const resumed = await plugin(f.input);
  assert.equal(JSON.parse(await resumed.tool.mdd_status.execute({}, f.context)).state, 'recovery-blocked');
  f.user('I stopped the interrupted question.');
  const released = JSON.parse(await resumed.tool.mdd_reset.execute({ scope: 'run', userText: 'I stopped the interrupted question.' }, f.context));
  assert.equal(released.reset.scope, 'run');
  assert.equal(new RunOwnershipStore(f.root).parent(f.runtime.sessionID), undefined);
  assert.equal(new RunOwnershipStore(f.root).read(ready.runID).state, 'idle');
  f.user('A new objective after the interrupted preflight.');
  const fresh = JSON.parse(await resumed.tool.mdd_start.execute({ requirements: 'A new objective after the interrupted preflight.' }, f.context));
  assert.equal(fresh.state, 'ready');
});

test('audit D2: a change answer that cannot be inspected releases the reservation instead of locking the parent', async t => {
  const f = await fixture(t, { memoryEnabled: false, store: 'none' });
  await f.phase();
  const ready = await f.status();
  f.user('Please rerun the preflight for this task.');
  const args = structuredClone((await f.change()).question);
  await dispatchQuestion(f, 'change-uninspectable', args);
  assert.equal(new RunOwnershipStore(f.root).read(ready.runID).state, 'reserved');
  // The native call can no longer be confirmed in the parent history, so the answer is refused.
  f.parent[1].parts = [];
  await assert.rejects(f.hooks['tool.execute.after']({ sessionID: f.runtime.sessionID, callID: 'change-uninspectable', tool: 'question', args },
    questionAnswer(args, 'Confirmar el cambio')), /intake stopped/);
  assert.equal(new RunOwnershipStore(f.root).read(ready.runID).state, 'idle');
  assert.equal(new QuestionCheckpointStore(f.root).read(f.runtime.sessionID).state, 'cancelled');
  assert.notEqual(JSON.parse(await f.hooks.tool.mdd_status.execute({}, f.context)).state, 'recovery-blocked');
  const reset = JSON.parse(await f.hooks.tool.mdd_reset.execute({ scope: 'run' }, f.context));
  assert.equal(reset.reset.scope, 'run');
  f.user('A fresh objective once the question failed.');
  assert.equal(JSON.parse(await f.hooks.tool.mdd_start.execute({ requirements: 'A fresh objective once the question failed.' }, f.context)).state, 'ready');
});

test('audit D4: an artifact with ANSI escapes and carriage returns is checkpointed and restored', async t => {
  const f = await fixture(t, { memoryEnabled: false, store: 'none' });
  const artifact = 'Artifact for mdd-plan: \u001b[31mred\u001b[0m output\r\nwith a tab\tand a bell\u0007.';
  await f.phase({ artifact });
  const live = await f.status();
  assert.equal(live.state, 'ready');
  assert.equal(live.phase, 'mdd-apply');
  const resumed = await plugin(f.input);
  const restored = JSON.parse(await resumed.tool.mdd_status.execute({ detail: 'full' }, f.context));
  assert.equal(restored.state, 'ready');
  assert.equal(restored.runID, live.runID);
  assert.equal(restored.phase, 'mdd-apply');
  const args = structuredClone(restored.task);
  f.parent[1].parts = [{ type: 'tool', tool: 'task', callID: 'task-after-ansi', state: { status: 'running', input: structuredClone(args) } }];
  await resumed['tool.execute.before']({ sessionID: f.runtime.sessionID, callID: 'task-after-ansi', tool: 'task' }, { args });
  // The dependency travels as JSON-escaped data inside the prompt; either form keeps the exact bytes.
  assert.ok(args.prompt.includes('\u001b[31mred') || args.prompt.includes('\\u001b[31mred'), 'the restored dependency keeps its exact bytes');
});

test('audit D4: requirements with ANSI escapes survive interactive approval and restart', async t => {
  const f = await fixture(t, { memoryEnabled: false, store: 'none', mode: 'interactive', start: false });
  const requirements = 'Colour the \u001b[1mCLI\u001b[0m banner\r\nand keep the tab\tsafe.';
  f.user(requirements);
  const started = JSON.parse(await f.hooks.tool.mdd_start.execute({ requirements }, f.context));
  assert.equal(started.state, 'ready');
  await f.phase();
  const review = await f.status();
  assert.equal(review.state, 'question-ready');
  const resumed = await plugin(f.input);
  const restored = JSON.parse(await resumed.tool.mdd_status.execute({ detail: 'full' }, f.context));
  assert.equal(restored.runID, review.runID);
  assert.equal(restored.workflow.nextAction.kind, 'approve');
});

test('audit D4: more than 64 concerns are deduplicated and capped at runtime, and the run still restores', async t => {
  const f = await fixture(t, { memoryEnabled: false, store: 'none' });
  let serial = 0;
  const batch = () => Array.from({ length: 8 }, () => ({ category: 'integrations', evidence: `Distinct integration evidence ${++serial}.`, impact: 'Needs attention later.' }));
  await f.phase({ concerns: batch() });
  await f.phase({ concerns: batch() });
  for (let round = 0; round < 3; round++) {
    await f.phase({ coverageFault: 'partial', concerns: batch() });
    f.user(`Rework round ${round}: correct what verification found.`);
    await f.hooks.tool.mdd_reset.execute({ scope: 'rework', userText: f.parent[0].parts[0].text }, f.context);
    await f.phase({ concerns: batch() });
  }
  // A repeated concern is recorded once.
  await f.phase({ concerns: [...batch().slice(0, 7), { category: 'integrations', evidence: 'Distinct integration evidence 1.', impact: 'Needs attention later.' }] });
  const live = await f.status();
  assert.ok(serial > 64);
  assert.equal(live.concerns.length, 64);
  assert.equal(new Set(live.concerns.map(item => JSON.stringify(item))).size, 64);
  const resumed = await plugin(f.input);
  const restored = JSON.parse(await resumed.tool.mdd_status.execute({ detail: 'full' }, f.context));
  assert.equal(restored.runID, live.runID);
  assert.equal(restored.state, live.state);
  assert.deepEqual(restored.concerns, live.concerns);
});

test('audit D4: a long reworked route of maximum escaped artifacts plus context still checkpoints and restores', async t => {
  const f = await fixture(t, { route: 'high', memoryEnabled: false, store: 'none' });
  // Context input refuses terminal control characters; quotes and newlines are what JSON escapes.
  await f.hooks.tool.mdd_context.execute({ label: 'Issue body', content: 'Quoted "context" line\n'.repeat(1500) }, f.context);
  // Verify reports its own acceptance links, which share the artifact bound, so it is not filled.
  for (let i = 0; i < 6; i++) await f.phase({ large: true, fill: '"' });
  await f.phase({ coverageFault: 'partial' });
  const rounds = 7;
  for (let round = 0; round < rounds; round++) {
    f.user(`Rework round ${round} of the long route.`);
    await f.hooks.tool.mdd_reset.execute({ scope: 'rework', userText: f.parent[0].parts[0].text }, f.context);
    await f.phase({ large: true, fill: '"' });
    await f.phase({ coverageFault: round === rounds - 1 ? undefined : 'partial' });
  }
  const live = await f.status();
  assert.equal(live.workflow.results.length, 7 + 2 * rounds);
  assert.equal(live.state, 'complete');
  const saved = new CheckpointStore(f.root).read(f.runtime.sessionID).checkpoint;
  assert.ok(Buffer.byteLength(JSON.stringify(saved)) > 400000, 'the route really exceeds the old 400 KB budget');
  const resumed = await plugin(f.input);
  const restored = JSON.parse(await resumed.tool.mdd_status.execute({ detail: 'full' }, f.context));
  assert.equal(restored.state, 'complete');
  assert.equal(restored.runID, live.runID);
  assert.equal(restored.workflow.results.length, 7 + 2 * rounds);
});

test('audit D4: an uncertain Apply checkpoint blocks the live run and stale restart dispatch', async t => {
  const f = await fixture(t, { memoryEnabled: false, store: 'none' });
  await f.phase();
  const rename = fs.renameSync;
  let refused = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (/checkpoint-[a-f0-9]{64}\.json$/.test(String(to))) { refused++; throw Object.assign(new Error('locked by scanner'), { code: 'EPERM' }); }
    return rename(from, to);
  });
  await assert.rejects(f.phase(), /Checkpoint outcome is unconfirmed/);
  const live = await f.status();
  // LocalFiles already retries EPERM rename six times inside one metadata write. The runner
  // must not repeat that checkpoint write or dispatch any substantive Apply writer.
  assert.equal(refused, 6, 'only one CheckpointStore write, including its bounded filesystem retries');
  assert.equal(live.state, 'blocked');
  assert.equal(live.task, undefined);
  assert.equal(new ProgressGuard(f.root).read(f.runtime.sessionID).state, 'pending');
  // A restart must not resume the older ready Apply checkpoint.
  const stale = await plugin(f.input);
  const dataOnly = JSON.parse(await stale.tool.mdd_status.execute({ detail: 'full' }, f.context));
  assert.notEqual(dataOnly.phase, 'mdd-apply');
  assert.equal(dataOnly.task, undefined);
  assert.equal(dataOnly.state, 'recovery-blocked');
});

test('audit D7: after restart a complete run closes for a new native objective and keeps its evidence', async t => {
  const f = await fixture(t, { memoryEnabled: false, store: 'none' });
  await f.phase(); await f.phase(); await f.phase();
  const done = await f.status();
  assert.equal(done.state, 'complete');
  const resumed = await plugin(f.input);
  f.user('A new independent requested outcome after restart.');
  const next = JSON.parse(await resumed.tool.mdd_start.execute({ requirements: 'A new independent requested outcome after restart.' }, f.context));
  assert.equal(next.state, 'ready');
  assert.notEqual(next.runID, done.runID);
  assert.equal(new RunOwnershipStore(f.root).parent(f.runtime.sessionID), next.runID);
  const discarded = (await readdir(join(f.root, '.mdd'))).filter(name => name.endsWith('.discarded.json'));
  assert.equal(discarded.length, 1);
  assert.equal(JSON.parse(await readFile(join(f.root, '.mdd', discarded[0]), 'utf8')).runID, done.runID);
  const ledger = (await readFile(join(f.root, '.mdd', 'runs.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(ledger.some(row => row.runID === done.runID && row.state === 'complete'));
});

test('audit D7: an unfinished run is never auto-closed by a new objective after restart', async t => {
  const f = await fixture(t, { memoryEnabled: false, store: 'none' });
  await f.phase();
  const ready = await f.status();
  const resumed = await plugin(f.input);
  f.user('Try to replace unfinished work silently.');
  await assert.rejects(resumed.tool.mdd_start.execute({ requirements: 'Try to replace unfinished work silently.' }, f.context));
  assert.equal(new RunOwnershipStore(f.root).parent(f.runtime.sessionID), ready.runID);
  assert.equal(new CheckpointStore(f.root).read(f.runtime.sessionID).checkpoint.runID, ready.runID);
});
