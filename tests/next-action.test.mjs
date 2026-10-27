import assert from 'node:assert/strict';
import { test } from 'node:test';

test('plural foreground tasks preserve exact objects and cannot advance a phase early', () => {
  const tasks = [{ description: 'first', subagent_type: 'mdd-apply', prompt: 'handle-one' },
    { description: 'second', subagent_type: 'mdd-apply', prompt: 'handle-two' }];
  const action = nextAction({ state: 'await-result', tasks });
  assert.equal(action.tool, 'task'); assert.deepEqual(action.calls, tasks); assert.equal(action.args, undefined);
  action.calls[0].prompt = 'changed'; assert.equal(tasks[0].prompt, 'handle-one');
  assert.equal(nextAction({ state: 'await-result', tasks: [] }).tool, 'mdd_status');
});
import { nextAction, withNextAction } from '../dist/next-action.js';

const task = { description: 'MDD plan phase', subagent_type: 'mdd-plan', prompt: 'mdd:dispatch:token' };

test('R04: accepted context before first main result requires inspection and cause correction', () => {
  const status = { state: 'blocked', uncertain: false, contextual: false,
    contexts: [{ explorationID: 'context-one', outcome: 'passed' }], workflow: { results: [] },
    next: { kind: 'execute', phase: 'mdd-explore' }, reason: 'Original preparation overflow: excess=1200.' };
  const original = structuredClone(status);
  const attached = withNextAction(status);
  assert.equal(attached.nextAction.tool, 'mdd_status');
  assert.equal(attached.nextAction.args, undefined);
  assert.match(attached.nextAction.why, /original diagnostic/);
  assert.match(attached.nextAction.why, /after.*corrected/);
  assert.match(attached.nextAction.why, /never replay/);
  assert.equal(attached.reason, original.reason);
  assert.deepEqual(status, original);
  assert.deepEqual(attached.workflow.results, []);
  const uncertain = nextAction({ ...status, uncertain: true, checkpointFailed: true });
  assert.equal(uncertain.tool, 'mdd_status');
  assert.doesNotMatch(uncertain.why, /scope phase/);
  for (const change of [{ contexts: [] }, { contextual: true }, { next: { kind: 'await-result' } }])
    assert.doesNotMatch(nextAction({ ...status, ...change }).why, /after.*corrected/);
});

test('R02: uncertain persistence never recommends phase reset', () => {
  const action = nextAction({ state: 'blocked', uncertain: true, checkpointFailed: true });
  assert.equal(action.tool, 'mdd_status');
  assert.equal(action.args, undefined);
  assert.match(action.why, /durability/i);
  assert.doesNotMatch(action.why, /scope phase/);
});

test('R02: preparation recovery is conditional on correcting its cause', () => {
  const action = nextAction({ state: 'blocked', uncertain: false,
    workflow: { results: [{ phase: 'mdd-design', outcome: 'passed' }] },
    next: { kind: 'execute', phase: 'mdd-tasks' }, reason: 'combined phase handoff exceeds 96000 bytes' });
  assert.equal(action.tool, 'mdd_status');
  assert.match(action.why, /preparation/i);
  assert.match(action.why, /after.*corrected/i);
  assert.match(action.why, /scope phase/);
  assert.match(action.why, /never replay/i);
});

for (const state of ['completed', 'closed-unverified']) test(`AL-03: internal ${state} offers status only, never public or review authority`, () => {
  const action = nextAction({ lane: 'adaptive-low-internal', state });
  assert.equal(action.tool, 'mdd_status'); assert.equal(action.args, undefined);
  assert.match(action.why, /no Plan, Verify, review authority/);
  assert.match(action.why, /unverified closure is not verified completion/);
});
const question = { questions: [{ header: 'Aprobación', question: '¿Continuar?', multiple: false, options: [] }] };

test('AL05b: inactive native projection never falls into public fixed reset or startup routing', () => {
  const base = { lane: 'adaptive-native-protocol-internal', routingVersion: 3, registration: 'inactive' };
  for (const state of ['blocked', 'not-started', 'recovery-blocked', 'await-selection', 'await-result', 'transfer-recovery-required']) {
    assert.equal(nextAction({ ...base, state, next: { internal: 'status', inputContract: 'operations' } }), undefined);
  }
  assert.deepEqual(nextAction({ ...base, state: 'question-ready', question }).args, question);
  assert.doesNotMatch(nextAction({ ...base, state: 'question-ready', question }).why, /mdd_answer/);
  assert.deepEqual(nextAction({ ...base, state: 'authorized-actor', task }).args, task);
  assert.equal(nextAction({ ...base, state: 'question-ready', questionRef: { args: { cursor: 'held:0' } } }), undefined);
});

test('SA-3: failed Verify offers explicit actions without fabricating the next phase or consent', () => {
  const action = nextAction({ state: 'blocked', reworkable: 'mdd-apply', runID: 'failed' });
  assert.equal(action.tool, 'mdd_reset');
  assert.equal(action.args, undefined);
  for (const hint of [/scope rework/, /scope phase/, /scope continue/, /runID/, /mdd_start/, /no next phase/i]) assert.match(action.why, hint);
  const continued = nextAction({ state: 'continued-with-failed-verification' });
  assert.equal(continued.tool, 'mdd_status');
  assert.equal(continued.args, undefined);
  assert.match(continued.why, /no work/i);
});

test('next action: a pending question outranks everything the run could otherwise do', () => {
  const action = nextAction({ state: 'ready', question, task, mode: 'delegate' });
  assert.equal(action.tool, 'question');
  assert.deepEqual(action.args, question);
});

test('next action: review resolves uncertainties first and pause never advances automatically', () => {
  const review = nextAction({ state: 'review-ready' });
  assert.equal(review.tool, 'mdd_prepare_advance');
  assert.equal(review.args, undefined);
  assert.match(review.why, /before asking to advance/);
  const paused = nextAction({ state: 'paused' });
  assert.equal(paused.tool, 'mdd_prepare_advance');
  assert.match(paused.why, /Wait for their request to resume/);
});

// The report was refused for its wording, not its work. Dispatching here pays for the phase twice.
test('next action: a rejected report is restated, never re-dispatched', () => {
  const action = nextAction({ state: 'ready', task, mode: 'inline', rejected: { reason: 'Missing heading.', text: '## MDD Outcome' } });
  assert.equal(action.tool, 'mdd_phase_result');
  assert.equal(action.args, undefined, 'a restatement has to be composed, so no arguments are invented');
  assert.match(action.why, /costs no attempt/);
});

test('next action: native fallback dispatches exact child work, never coordinator execution', () => {
  const native = { ...task, subagent_type: 'general' };
  const action = nextAction({ state: 'ready', task: native, mode: 'native' });
  assert.equal(action.tool, 'task');
  assert.deepEqual(action.args, native);
});

test('next action: a ready delegated phase carries the exact dispatchable task', () => {
  const action = nextAction({ state: 'ready', task, mode: 'delegate' });
  assert.equal(action.tool, 'task');
  assert.deepEqual(action.args, task);
  assert.notEqual(action.args, task, 'the action must not alias the status object');
});

// "Te interrumpí, continúa" used to end in scope run, a fresh preflight and a second exploration
// and plan for work that was already recorded. An interrupted attempt keeps its run.
test('next action: recovery states point at the narrower reset first', () => {
  const unknown = nextAction({ state: 'recovery-blocked' });
  assert.equal(unknown.tool, 'mdd_reset');
  assert.equal(unknown.args, undefined, 'the user\'s confirmation has to be composed, never invented');
  assert.match(unknown.why, /scope phase and userText/);
  assert.match(unknown.why, /no new preflight/);
  const stopped = nextAction({ state: 'recovery-blocked', liveness: { verdict: 'stopped' } });
  assert.deepEqual(stopped.args, { scope: 'phase' });
  assert.match(stopped.why, /completed phases are not repeated/);
  const running = nextAction({ state: 'recovery-blocked', liveness: { verdict: 'running' } });
  assert.equal(running.tool, 'mdd_status');
  for (const action of [unknown, stopped, running]) assert.notDeepEqual(action.args, { scope: 'run' });
  assert.deepEqual(nextAction({ state: 'blocked', recoverable: true }).args, { scope: 'phase' });
  assert.match(nextAction({ state: 'blocked' }).why, /before scope run/);
});

test('next action: work in flight is waited for, never redispatched', () => {
  assert.equal(nextAction({ state: 'await-result' }).tool, 'mdd_status');
  assert.equal(nextAction({ state: 'await-result' }).args, undefined);
  assert.match(nextAction({ state: 'await-answer' }).why, /never infer an answer from prose/i);
});

test('next action: a pending objective is offered with its own exact arguments', () => {
  const action = nextAction({ state: 'not-started', pendingStart: { requirements: 'Ship the thing.' } });
  assert.equal(action.tool, 'mdd_start');
  assert.deepEqual(action.args, { requirements: 'Ship the thing.' });
  assert.match(action.why, /only if the user is continuing that same objective/);
});

test('next action: an idle conversation is never told to start implementation blindly', () => {
  const action = nextAction({ state: 'not-started' });
  assert.equal(action.tool, 'mdd_start');
  assert.equal(action.args, undefined, 'requirements are the user\'s text and are never invented here');
  assert.match(action.why, /mdd_contextual_explore/);
});

test('next action: a finished run proposes nothing, and unknown shapes are left alone', () => {
  assert.equal(nextAction({ state: 'complete' }), undefined);
  assert.equal(nextAction(undefined), undefined);
  assert.equal(nextAction('not a status'), undefined);
  assert.equal(withNextAction({ state: 'complete' }).nextAction, undefined);
});

test('next action: attaching it never touches what the tool already decided', () => {
  const status = { state: 'ready', task, mode: 'delegate', evidence: { plan: 'confirmed' } };
  const attached = withNextAction(status);
  assert.deepEqual({ ...attached, nextAction: undefined }, { ...status, nextAction: undefined });
  assert.equal(attached.nextAction.tool, 'task');
  assert.equal(status.nextAction, undefined, 'the original status is not mutated');
});
test('AL-02: an actorless adaptive boundary waits for internal selection, not startup/reset/completion', () => {
  const action = nextAction({ lane: 'adaptive-low-internal', state: 'await-selection', selection: { handle: 'internal' } });
  assert.equal(action.tool, 'mdd_status');
  assert.equal(action.args, undefined);
  assert.match(action.why, /select|selection/);
  const pending = nextAction({ lane: 'adaptive-low-internal', state: 'await-result', liveness: { verdict: 'stopped' } });
  assert.equal(pending.tool, 'mdd_status'); assert.equal(pending.args, undefined);
});
