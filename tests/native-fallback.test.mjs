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

