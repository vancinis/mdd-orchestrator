import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Workflow, currentGeneration } from '../dist/workflow.js';
import { PhaseRunner } from '../dist/phase-runner.js';
import { CheckpointStore, sealResumeData, validateCheckpoint } from '../dist/checkpoint.js';
import { ProgressGuard } from '../dist/progress.js';
import { completeRemaining, remainingSteps } from '../dist/apply-batches.js';
import { verifyReport } from '../dist/phase-evidence.js';
import { deepestCause, failingRequirements, tracedLinks, verificationFindings } from '../dist/acceptance.js';
import { nextAction } from '../dist/next-action.js';
import { reportDocument, structuredTraceFixture, structuredVerificationFixture, throughRiskStop } from './adapter-fixture.mjs';

// The incident behind these tests: a design declared it could not meet a requirement and still
// passed; Verify failed it three times and recommended design rework, but rework could only return
// to Apply, which split the correction across four scoped actors and moved the same failure one
// fallback deeper each round. Every behavior below answers one link of that chain.

const answers = { certainty: 'very-sure', artifactStore: 'none', mode: 'automatic', summary: 'low' };
const report = data => reportDocument({ evidenceSummary: 'Phase evidence.', artifact: 'Phase artifact.', ...data });
const trace = () => structuredTraceFixture();
const STEP = 'cli-validation';
const FINDINGS = ['S1', 'S2', STEP, 'D1', `${STEP}-check`];

function failedVerify(cause, requirementID = 'R1') {
  const assessment = { status: 'not-verified', checks: [], assessment: 'A failed login still restores after a fresh restart.', ...(cause ? { cause } : {}) };
  return { outcome: 'failed', checks: [], verification: {
    scenarios: ['S1', 'S2'].map(scenarioID => ({ requirementID, scenarioID, stepID: STEP, ...assessment })),
    steps: [{ stepID: STEP, ...assessment }], decisions: [{ decisionID: 'D1', ...assessment }],
    changes: 'Correction needed.', limits: [],
    checkResults: [{ checkID: `${STEP}-check`, disposition: 'blocked', executions: [], reason: 'Blocked until the restart failure is closed.' }], supplementalChecks: [],
  } };
}
const closure = (ids = FINDINGS) => ids.map(id => ({ id, status: 'closed', evidence: `Probe for ${id} failed first and passes after the change (exit 0).` }));

async function fixture(t, route = 'low', sessionID = 'ses_rework', options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mdd-rework-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = { sessionID, agent: 'mdd-orchestrator', directory: root, worktree: root };
  const durable = new CheckpointStore(root);
  const progress = new ProgressGuard(root);
  const inspect = { parent: async () => {}, result: async (_runtime, _call, _phase, output) => output, stopped: async () => true };
  const settings = { checkpoint: durable, progress, ...(options.automaticCorrections !== undefined ? { automaticCorrections: options.automaticCorrections } : {}) };
  let runner = new PhaseRunner(inspect, settings);
  let ordinal = 0;
  const f = {
    root, runtime, durable,
    get runner() { return runner; },
    status: () => runner.status(runtime.sessionID),
    async dispatch() {
      // Interactive mode holds each tail phase for approval; these tests approve it as the user would.
      if (f.status().state === 'await-approval') runner.approveNative(runtime.sessionID, f.status().workflow.nextAction.phase);
      const call = { sessionID: runtime.sessionID, callID: `call-${++ordinal}` };
      return { call, args: await runner.before(call, f.status().task) };
    },
    async finish(data) {
      const { call, args } = await f.dispatch();
      await runner.after(call, args, report(data));
      return { call, args };
    },
    async restart() {
      runner = new PhaseRunner(inspect, settings);
      return runner.restore(runtime);
    },
    saved: () => durable.read(runtime.sessionID),
  };
  await runner.start({ preflight: { answers: { ...answers, ...(options.mode ? { mode: options.mode } : {}) } }, requirements: 'Keep failed logins signed out across restarts.' }, runtime,
    { requirementsConfirmed: true, userMessageID: 'user-rework' });
  await throughRiskStop(runner, runtime.sessionID, route);
  return f;
}

test('workflow: a Verify rework is one correction pass; replay keeps the older step-by-step form', () => {
  const plan = [{ id: 'first', dependsOn: [] }, { id: 'second', dependsOn: ['first'] }];
  const failedRun = () => {
    const workflow = new Workflow({ answers });
    workflow.start('mdd-explore'); workflow.recordResult({ phase: 'mdd-explore', outcome: 'passed', evidenceSummary: 'Explored.' });
    workflow.startRisk(); workflow.recordRiskResult({ outcome: 'passed', evidenceSummary: 'Low.', route: 'low' });
    workflow.start('mdd-plan'); workflow.recordResult({ phase: 'mdd-plan', outcome: 'passed', evidenceSummary: 'Planned.', applyPlan: plan });
    for (const [index, id] of ['first', 'second'].entries()) {
      workflow.start('mdd-apply');
      workflow.recordResult({ phase: 'mdd-apply', outcome: 'passed', evidenceSummary: 'Applied.', batchID: `batch-1-${index}`, completed: [id] });
    }
    workflow.start('mdd-verify'); workflow.recordResult({ phase: 'mdd-verify', outcome: 'failed', evidenceSummary: 'Failed.' });
    return workflow;
  };
  const corrected = failedRun();
  corrected.rework('mdd-apply');
  assert.equal(corrected.correcting(), true);
  assert.deepEqual(remainingSteps(corrected.applyProgress()), ['first', 'second']);
  corrected.start('mdd-apply');
  corrected.recordResult({ phase: 'mdd-apply', outcome: 'passed', evidenceSummary: 'Corrected.', batchID: 'batch-2-a', completed: ['first', 'second'] });
  assert.equal(corrected.correcting(), false);
  assert.deepEqual(corrected.nextAction(), { kind: 'execute', phase: 'mdd-verify' });
  assert.deepEqual(Workflow.replay({ answers }, corrected.history()).nextAction(), { kind: 'execute', phase: 'mdd-verify' });
  // A history recorded before the correction pass existed completed one step per result.
  const legacy = failedRun();
  legacy.rework('mdd-apply');
  legacy.start('mdd-apply');
  legacy.recordResult({ phase: 'mdd-apply', outcome: 'passed', evidenceSummary: 'First.', batchID: 'batch-2-a', completed: ['first'] });
  assert.deepEqual(legacy.nextAction(), { kind: 'execute', phase: 'mdd-apply' });
  assert.equal(Workflow.replay({ answers }, legacy.history()).applyProgress().completed.join(), 'first');
  assert.throws(() => completeRemaining({ epoch: 1, planned: plan, completed: [] }, ['second', 'first']), /every remaining deliverable in plan order \(first, second\)/);
  assert.throws(() => completeRemaining({ epoch: 1, planned: plan, completed: [] }, ['first']), /partial correction earns no progress/);
});

test('workflow: a rework to a planning phase releases the held plan and starts a new generation', () => {
  const workflow = new Workflow({ answers });
  workflow.start('mdd-explore'); workflow.recordResult({ phase: 'mdd-explore', outcome: 'passed', evidenceSummary: 'Explored.' });
  workflow.startRisk(); workflow.recordRiskResult({ outcome: 'passed', evidenceSummary: 'Low.', route: 'low' });
  workflow.start('mdd-plan'); workflow.recordResult({ phase: 'mdd-plan', outcome: 'passed', evidenceSummary: 'Planned.', applyPlan: [{ id: 'first', dependsOn: [] }] });
  workflow.start('mdd-apply'); workflow.recordResult({ phase: 'mdd-apply', outcome: 'passed', evidenceSummary: 'Applied.', batchID: 'batch-1-a', completed: ['first'] });
  workflow.start('mdd-verify'); workflow.recordResult({ phase: 'mdd-verify', outcome: 'failed', evidenceSummary: 'Design gap.' });
  assert.equal(workflow.generation().length, 4);
  workflow.rework('mdd-plan');
  assert.equal(workflow.correcting(), false);
  assert.deepEqual(workflow.applyProgress(), { epoch: 2, planned: [], completed: [] });
  workflow.start('mdd-plan'); workflow.recordResult({ phase: 'mdd-plan', outcome: 'passed', evidenceSummary: 'Replanned.', applyPlan: [{ id: 'other', dependsOn: [] }] });
  assert.deepEqual(workflow.generation().map(result => result.phase), ['mdd-plan']);
  assert.deepEqual(workflow.applyProgress(), { epoch: 3, planned: [{ id: 'other', dependsOn: [] }], completed: [] });
  const replayed = Workflow.replay({ answers }, workflow.history());
  assert.deepEqual(replayed.generation(), workflow.generation());
  // The boundary is visible from results alone, so a preserved dossier reads it the same way.
  assert.deepEqual(currentGeneration(workflow.snapshot().results, workflow.snapshot().evaluation.phases).map(result => result.evidenceSummary), ['Replanned.']);
});

test('verification rows carry a cause only on a gap, and findings are derived from the structured report', () => {
  const held = { accepted: trace().acceptance, choices: trace().decisions, planned: trace().deliverables, verificationVersion: 1 };
  const failed = failedVerify('design');
  const { verification } = verifyReport(failed.checks, failed.verification, held);
  assert.equal(deepestCause(verification), 'design');
  assert.deepEqual(verificationFindings(verification), FINDINGS);
  assert.deepEqual(failingRequirements(verification), ['R1']);
  const passing = structuredVerificationFixture(trace());
  passing.verification.scenarios[0].cause = 'design';
  assert.throws(() => verifyReport(passing.checks, passing.verification, held), /cannot name a cause; only a gap has one/);
  const unknown = failedVerify('luck');
  assert.throws(() => verifyReport(unknown.checks, unknown.verification, held), /unknown cause "luck"/);
  assert.equal(deepestCause(verifyReport(failedVerify().checks, failedVerify().verification, held).verification), 'implementation');
  assert.equal(failingRequirements({ scenarios: 'not rows' }).length, 0);
});

test('R03: mixed causes retain semantic precedence and same-requirement semantic rows', () => {
  const checked = failedVerify('verification').verification;
  assert.equal(deepestCause(checked), 'verification');
  assert.deepEqual(failingRequirements(checked), []);
  assert.deepEqual(verificationFindings(checked), FINDINGS);
  for (const cause of ['implementation', 'design', 'requirements']) {
    checked.scenarios[1].cause = cause;
    assert.equal(deepestCause(checked), cause);
    assert.deepEqual(failingRequirements(checked), ['R1']);
  }
  checked.steps[0].cause = 'design';
  checked.decisions[0].cause = 'implementation';
  assert.equal(deepestCause(checked), 'requirements');
});

for (const restored of [false, true]) {
  for (const [before, after] of [['verification', 'verification'], [undefined, 'verification'], ['verification', undefined]]) {
  }
}

for (const restored of [false, true]) {
}

for (const [cause, target] of [['requirements', 'mdd-spec'], ['design', 'mdd-design']]) {
}

test('next action: a failed planning phase offers the earlier phase, not continuation', () => {
  const action = nextAction({ state: 'blocked', reworkable: 'mdd-spec', reworkTargets: ['mdd-spec'], reworkFrom: 'mdd-design', reworkReason: 'R1 cannot be met.' });
  assert.equal(action.tool, 'mdd_reset'); assert.equal(action.args, undefined);
  assert.match(action.why, /phase set to their choice \(mdd-spec\)/);
  assert.match(action.why, /scope phase retries mdd-design/);
  assert.doesNotMatch(action.why, /scope continue/);
});

// Automatic correction (gentle-orchestrator's bound): in automatic mode a failed Verify of the
// implementation goes back to one Apply correction pass without stopping, and the Verify after it
// rechecks only the findings; a second pass only when that recheck closed findings and opened none.

/** A Verify that verified every held link except the named scenarios, which it found unmet. */
function partialVerify(failing, { execution = 'E1', cause } = {}) {
  const data = structuredVerificationFixture(trace());
  data.outcome = failing.length ? 'failed' : 'passed';
  data.checks = [{ id: execution, command: 'npm test', exit: 0 }];
  const rows = [...data.verification.scenarios, ...data.verification.steps, ...data.verification.decisions];
  for (const row of rows) row.checks = [execution];
  data.verification.checkResults[0].executions = [execution];
  for (const row of data.verification.scenarios) if (failing.includes(row.scenarioID))
    Object.assign(row, { status: 'not-verified', checks: [], assessment: `${row.scenarioID}: a failed login still restores after restart.`, ...(cause ? { cause } : {}) });
  return data;
}
/** A scoped recheck: rows only for the given scenarios, failing those listed in `failing`. */
function recheckOf(scenarios, failing = [], execution = 'E2') {
  const data = partialVerify(failing, { execution });
  data.verification.scenarios = data.verification.scenarios.filter(row => scenarios.includes(row.scenarioID));
  data.verification.steps = []; data.verification.decisions = [];
  return data;
}
const results = status => status.workflow.results.map(item => `${item.phase}:${item.outcome}`).slice(3);

