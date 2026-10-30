import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PhaseRunner } from '../dist/phase-runner.js';
import { nextAction } from '../dist/next-action.js';
import { collapseDispatchPrompts } from '../dist/dispatch-transcript.js';
import { memoryServer, request, result, riskReport, runtime } from './adapter-fixture.mjs';

async function fixture(t) {
  const { endpoint } = await memoryServer(t);
  const events = [];
  const inspect = { parent: async () => {}, result: async (_r, _c, _p, output) => output, stopped: async () => true };
  const runner = new PhaseRunner(inspect, { telemetry: (_root, event) => {
    events.push(event); return { ok: true, enabled: true, count: events.length, retentionDays: 30 };
  } });
  await runner.start(request(endpoint), runtime);
  return { runner, inspect, events };
}

async function fail(runner, ordinal) {
  const call = { sessionID: runtime.sessionID, callID: `failed_${ordinal}` };
  await runner.before(call, runner.status(runtime.sessionID).task);
  await runner.nativeError(call.sessionID, call.callID);
}

/** Settles exploration and a validated low risk verdict so the main route reaches mdd-plan. */
async function throughRisk(runner) {
  let status = runner.status(runtime.sessionID);
  let call = { sessionID: runtime.sessionID, callID: 'prelude-explore' };
  let args = await runner.before(call, status.task);
  await runner.after(call, args, result(status));
  status = runner.status(runtime.sessionID);
  call = { sessionID: runtime.sessionID, callID: 'prelude-risk' };
  args = await runner.before(call, status.task);
  await runner.after(call, args, riskReport('low', 'passed'));
}

// Every run starts at the mdd-explore stop, so its own native fallback is `explore`, and
// recovering from it does not skip the mdd-risk stop that always follows exploration.
test('three settled attempts select one native explore and advance into the risk stop', async t => {
  const { runner, events } = await fixture(t);
  const initial = runner.status(runtime.sessionID);
  for (let i = 0; i < 3; i++) await fail(runner, i);
  const fallback = runner.status(runtime.sessionID);
  assert.equal(fallback.mode, 'native');
  assert.equal(fallback.phase, initial.phase);
  assert.equal(fallback.task.subagent_type, 'explore');
  assert.deepEqual(fallback.workflow.answers, initial.workflow.answers);
  assert.deepEqual(fallback.workflow.evaluation, initial.workflow.evaluation);
  await assert.rejects(runner.before({ sessionID: runtime.sessionID, callID: 'forged' }, { ...fallback.task, prompt: 'Do arbitrary work' }), /arguments differ/);
  const call = { sessionID: runtime.sessionID, callID: 'native' };
  const args = await runner.before(call, runner.status(runtime.sessionID).task);
  assert.match(args.prompt, /inspect git status and git diff and preserve partial work/);
  assert.match(args.prompt, /Do not delegate, load skills, or call any MDD tools/);
  assert.doesNotMatch(args.prompt, /^Optional packaged skills for this phase/m);
  assert.match(args.prompt, /overrides ordinary skill and report-checker guidance/);
  assert.doesNotMatch(args.prompt, /report it with mdd_phase_result/);
  await runner.after(call, args, result(fallback));
  const next = runner.status(runtime.sessionID);
  assert.equal(next.mode, 'delegate');
  assert.equal(next.attempts, 0);
  assert.equal(next.phase, fallback.phase);
  assert.equal(next.stage, 'mdd-risk');
  assert.equal(next.task.subagent_type, 'mdd-risk');
  assert.equal(events.findLast(event => event.event === 'phase-end').executor, fallback.task.subagent_type);
});

// Once exploration and a validated risk verdict have settled, the main route's own fallback is
// `general`, and recovering from it resets the attempt budget at the next main phase.
test('three settled attempts select one native general and reset at the next phase', async t => {
  const { runner, events } = await fixture(t);
  await throughRisk(runner);
  const initial = runner.status(runtime.sessionID);
  for (let i = 0; i < 3; i++) await fail(runner, i);
  const fallback = runner.status(runtime.sessionID);
  assert.equal(fallback.mode, 'native');
  assert.equal(fallback.phase, initial.phase);
  assert.equal(fallback.task.subagent_type, 'general');
  assert.deepEqual(fallback.workflow.answers, initial.workflow.answers);
  assert.deepEqual(fallback.workflow.evaluation, initial.workflow.evaluation);
  await assert.rejects(runner.before({ sessionID: runtime.sessionID, callID: 'forged' }, { ...fallback.task, prompt: 'Do arbitrary work' }), /arguments differ/);
  const call = { sessionID: runtime.sessionID, callID: 'native' };
  const args = await runner.before(call, runner.status(runtime.sessionID).task);
  assert.match(args.prompt, /inspect git status and git diff and preserve partial work/);
  assert.match(args.prompt, /Do not delegate, load skills, or call any MDD tools/);
  assert.doesNotMatch(args.prompt, /^Optional packaged skills for this phase/m);
  assert.match(args.prompt, /Planning is read-only for project sources/);
  assert.doesNotMatch(args.prompt, /report it with mdd_phase_result/);
  await runner.after(call, args, result(fallback));
  const next = runner.status(runtime.sessionID);
  assert.equal(next.mode, 'delegate');
  assert.equal(next.attempts, 0);
  assert.notEqual(next.phase, fallback.phase);
  assert.equal(next.task.subagent_type, next.phase);
  assert.equal(events.findLast(event => event.event === 'phase-end').executor, fallback.task.subagent_type);
});

test('native fallback failure blocks instead of issuing a fifth attempt or inline work', async t => {
  const { runner } = await fixture(t);
  for (let i = 0; i < 4; i++) await fail(runner, i);
  const status = runner.status(runtime.sessionID);
  assert.equal(status.state, 'blocked');
  assert.equal(status.task, undefined);
  assert.equal(status.fallbackExhausted, true);
  assert.match(nextAction(status).why, /do not automatically reset/);
  await assert.rejects(runner.submit({ result: result(status) }, runtime), /not waiting/);
});

test('unknown liveness keeps the writer slot; stale results do not release or degrade it', async t => {
  const { runner, inspect } = await fixture(t);
  inspect.stopped = async () => false;
  const ready = runner.status(runtime.sessionID);
  const call = { sessionID: runtime.sessionID, callID: 'live' };
  const args = await runner.before(call, ready.task);
  await runner.nativeError(call.sessionID, call.callID);
  assert.equal(runner.status(call.sessionID).state, 'await-result');
  assert.throws(() => runner.reset(call.sessionID, 'run'), /may still be running/);
  await assert.rejects(runner.before({ ...call, callID: 'overlap' }, ready.task), /in flight/);
  await assert.rejects(runner.after({ ...call, callID: 'stale' }, args, result(ready)), /discarded/);
  assert.equal(runner.status(call.sessionID).attempts, 0);
  await runner.after(call, args, result(ready));
  assert.equal(runner.status(call.sessionID).workflow.results.length, 1);
});

test('context investigation gets its own budget and restores an exhausted main phase', async t => {
  const { runner } = await fixture(t);
  for (let i = 0; i < 4; i++) await fail(runner, i);
  const main = runner.status(runtime.sessionID);
  await runner.explore({ purpose: 'Inspect the reason for failure without changing files.' }, runtime);
  const ready = runner.status(runtime.sessionID);
  assert.equal(ready.attempts, 0);
  assert.equal(ready.fallbackExhausted, undefined);
  assert.equal(nextAction(ready).tool, 'task');
  const call = { sessionID: runtime.sessionID, callID: 'context' };
  const args = await runner.before(call, ready.task);
  await runner.after(call, args, result({ phase: 'mdd-explore' }));
  const restored = runner.status(runtime.sessionID);
  assert.equal(restored.fallbackExhausted, true);
  assert.equal(restored.reason, main.reason);
  assert.equal(restored.attempts, main.attempts);
  assert.deepEqual(restored.workflow, main.workflow);
});

test('SA-1: standalone fallback preserves its JSON envelope and omits inaccessible skills', async () => {
  const runner = new PhaseRunner({ parent: async () => {}, result: async (_r, _c, _p, output) => output, stopped: async () => true });
  await runner.explore({ purpose: 'Inspect the CLI' }, runtime);
  for (let i = 0; i < 3; i++) await fail(runner, i);
  const args = await runner.before({ sessionID: runtime.sessionID, callID: 'fallback-contract' }, runner.status(runtime.sessionID).task);
  assert.match(args.prompt, /Return exactly one JSON object, no fences/);
  assert.doesNotMatch(args.prompt, /^Optional packaged skills for this phase/m);
  assert.match(args.prompt, /searched scope, concrete source references and coverage gaps/);
  assert.match(args.prompt, /overrides ordinary skill and report-checker guidance/);
});

test('only owned native prompts are collapsed; unrelated native sessions are untouched', async t => {
  const { runner } = await fixture(t);
  const selected = await runner.submit({ result: 'Select native execution' }, runtime);
  const call = { sessionID: runtime.sessionID, callID: 'owned' };
  const args = await runner.before(call, selected.task);
  const part = { type: 'tool', tool: 'task', ...call, state: { status: 'completed', input: args } };
  const other = structuredClone(part); other.sessionID = 'unrelated';
  const messages = [{ parts: [part, other] }];
  assert.equal(collapseDispatchPrompts(messages, [], (sessionID, callID, input) => runner.ownsNativePrompt(sessionID, callID, input)), 1);
  assert.equal(messages[0].parts[1].state.input.prompt, args.prompt);
  assert.equal(part.state.input.prompt, args.prompt);
});
