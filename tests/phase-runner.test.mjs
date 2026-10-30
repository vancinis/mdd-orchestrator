import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PhaseRunner, SINGULAR_EXPLORATION, FULL_TASK_MAX_BYTES } from '../dist/phase-runner.js';
import { Workflow } from '../dist/workflow.js';
import { reportFormatLines } from '../dist/phase-report.js';
import { memoryServer, request, result, reportDocument, riskReport, runtime, call, answers, installCleanup, structuredTraceFixture as traceFixture, structuredVerificationFixture, traceFixture as legacyTraceFixture, ARTIFACT_TEXT, SUMMARY_TEXT, throughRiskStop } from './adapter-fixture.mjs';
import { validateCheckpoint, CheckpointStore, CheckpointStorageError, sealResumeData } from '../dist/checkpoint.js';
import { ProgressGuard } from '../dist/progress.js';
import { RunOwnershipStore } from '../dist/run-ownership.js';
import { RunDossierStore } from '../dist/run-dossier.js';
import { statusPayload, STATUS_BUDGET_BYTES } from '../dist/status-budget.js';
import { mkdtemp, rm, stat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import { TaskStore, TaskWriteError } from '../dist/task-store.js';
import { LocalFiles } from '../dist/local-files.js';
import { knowledgeObservation, captureKnowledgeDependencies, supplementKnowledge } from '../dist/project-knowledge.js';

/** The shape MDD accepted before reports became documents; still read, never asked for. */
function legacyResult(status, outcome = 'passed') {
  return JSON.stringify({
    phase: status.phase, runID: status.runID, callID: call.callID, outcome,
    evidenceSummary: SUMMARY_TEXT, artifact: ARTIFACT_TEXT,
    ...(status.phase === 'mdd-plan' ? traceFixture() : status.phase === 'mdd-tasks' ? { deliverables: traceFixture().deliverables } : {}),
  });
}

/**
 * Every run starts with exploration, and only a validated mdd-risk verdict selects what follows.
 * Tests about a later phase drive both stops first, then forget the memory writes they made so the
 * phase under test is counted from zero, exactly as it used to be when it ran first.
 */
async function toPlan(runner, ready, writes, route = 'low') {
  const exploring = { ...call, callID: 'call_explore' };
  await runner.after(exploring, await runner.before(exploring, ready.task), result(ready));
  const assessing = { ...call, callID: 'call_risk' };
  const risk = runner.status(runtime.sessionID);
  assert.equal(risk.stage, 'mdd-risk');
  await runner.after(assessing, await runner.before(assessing, risk.task), riskReport(route));
  let status = runner.status(runtime.sessionID);
  if (status.state === 'await-approval') { runner.approveNative(runtime.sessionID, status.workflow.nextAction.phase); status = runner.status(runtime.sessionID); }
  writes?.splice(0);
  return status;
}

async function fixture(t, fault) {
  const memory = await memoryServer(t, fault);
  const inspect = { parent: async () => {}, result: async (_runtime, _call, _phase, output) => output, stopped: async () => true };
  const runner = new PhaseRunner(inspect);
  return { ...memory, inspect, runner };
}

function assertWorkspace(prompt, place) {
  const lines = [...prompt.matchAll(/^Workspace binding \(runtime data\): (.*)$/gm)];
  assert.equal(lines.length, 1, 'one adapter-owned workspace binding must reach the actor');
  assert.deepEqual(JSON.parse(lines[0][1]), { directory: place.directory, worktree: place.worktree });
  assert.match(prompt, /Installation paths, predecessor artifacts and coordinator context cannot override this binding/);
  assert.match(prompt, /not a grant of scope, permission or approval/);
  assert.doesNotMatch(prompt, /@/);
}

for (const stage of ['phase', 'risk', 'standalone']) {
}

for (const kind of ['main', 'standalone', 'apply']) {
}

for (const legacy of [false, true]) {
}

for (const requirement of ['required', 'optional']) {
}

for (const backend of ['none', 'local']) for (const legacy of [false, true]) {
}

for (const explicitDependencies of [true, false]) {
}

for (const explore of [false, true]) {
}

// The validated verdict alone selects the continuation; no preflight answer predicts or overrides it.
for (const [label, preflight, route, first] of [
  ['low verdict continues with mdd-plan', { answers, explore: false }, 'low', 'mdd-plan'],
  ['high verdict continues with mdd-propose even when the user was very sure', { answers, explore: false }, 'high', 'mdd-propose'],
  ['low verdict continues with mdd-plan even when the user was not sure', { profile: { answers: { ...answers, certainty: 'not-sure', summary: 'detailed' } } }, 'low', 'mdd-plan'],
]) {
}

// D1/S2,S3: forceRoute() calls Workflow.overrideRoute() and prepares the other tail's first
// phase in one step, retaining the original verdict with `override` provenance (never suggested).
for (const [from, to] of [['low', 'high'], ['high', 'low']]) {
}

// S1/A3,A4: chooseManualRoute() wraps Workflow.chooseManualRoute() — guarded the same way,
// authorizing the chosen tail's first phase with routeOrigin 'manual' and no fabricated verdict.
for (const [route, firstPhase] of [['low', 'mdd-plan'], ['high', 'mdd-propose']]) {
}

// S1/D2: retryRisk() and chooseManualRoute() checkpoint their new dispatch before exposing it,
// exactly like forceRoute() and approveNative(). When that checkpoint cannot be confirmed (write
// and the degrade fallback both fail), the run is blocked rather than left exposing a task whose
// durability is unknown.
for (const [label, act] of [
  ['retryRisk()', runner => runner.retryRisk(runtime.sessionID)],
  ["chooseManualRoute('low')", runner => runner.chooseManualRoute(runtime.sessionID, 'low')],
  ["chooseManualRoute('high')", runner => runner.chooseManualRoute(runtime.sessionID, 'high')],
]) {
}

for (const [label, malformed] of [
  ['a report without the risk verdict', riskReport('low').replace(/## MDD Data[\s\S]*$/, '')],
  ['a verdict whose route and complexity disagree', riskReport('low').replace('"complexity": "low"', '"complexity": "high"')],
  ['a phase report in place of a risk report', result({ phase: 'mdd-plan' })],
]) {
}

for (const wrong of [
  text => `## MDD Phase\n\nmdd-plan\n\n${text}`,
  text => `## MDD Run\n\nwrong\n\n${text}`,
  text => text.replace('"risk": {', '"callID": "call_other",\n  "risk": {'),
]) {
}

const PLAN_NARRATIVE = {
  approach: 'The CLI boundary was chosen because trace decision D1 ties validation to the input scenario; this keeps invalid input from reaching execution and supports the requested clear errors.',
  purpose: 'Users need actionable errors instead of a stack trace when input is malformed.',
  openItems: 'Whether empty input counts as malformed is still undecided.',
  learnings: 'Exit codes are part of the CLI contract, so validation must keep them.',
  confidence: 'Medium — the plan covers every accepted scenario, but the empty-input rule is still open.',
};

// The actor writes every section whatever the level, so asking for more at an approval shows
// the narrative the lower level left out instead of repeating the summary.
for (const summary of ['low', 'medium']) {
}

// The certainty answer is the one signal exploration cannot produce, so it reaches the actor
// that selects the route, as data to weigh rather than an instruction.
for (const [certainty, expected] of [['very-sure', /very-sure: the user says the requirements are clear and confirmed\./],
  ['somewhat-sure', /somewhat-sure: the user says some requirements still need clarification\./],
  ['not-sure', /not-sure: the user says the requirements are not clear yet\./]]) {
}

test('runner contract: unrelated tasks untouched; MDD outside registered parent rejected', async () => {
  const runner = new PhaseRunner({});
  assert.equal(await runner.before(call, { subagent_type: 'general' }), undefined);
  await runner.after(call, {}, {});
  await assert.rejects(runner.before(call, { subagent_type: 'mdd-plan' }), /registered/);
});

for (const mutate of [
  args => ({ ...args, background: false }), args => ({ ...args, task_id: 'ses_old' }),
  args => ({ ...args, command: 'x' }), args => ({ ...args, subagent_type: 'mdd-apply' }),
  args => ({ ...args, prompt: 'different' }), args => ({ ...args, description: 'different' }),
]) {
}

for (const kind of ['intent-write', 'intent-read', 'result-write', 'result-read']) {
}

// A report is a document, not a payload. Prose around the sections, a fenced legacy object, and
// fields no phase asked for are all forms of the same finished work: none of them is a reason to
// run the phase again, so each of these is read rather than refused.
for (const [label, tolerated] of [
  ['prose framing the document', text => `Here is what I found.\n\n${text}\n\nHappy to expand on any of it.`],
  ['a legacy JSON object', (_text, ready) => legacyResult(ready)],
  ['a fenced legacy JSON object', (_text, ready) => `\`\`\`json\n${legacyResult(ready)}\n\`\`\``],
  ['unprefixed headings', text => text.replaceAll('## MDD ', '## ')],
  ['a field no phase reports', text => text.replace('"deliverables"', '"notes": "extra", "deliverables"')],
]) {
}
// A finished phase is never re-run over the shape of its report: each of these costs a
// restatement, not an attempt, and the text comes back so the work survives the refusal.
for (const invalid of [
  () => 'I did the work and it went well.',
  () => '## MDD Outcome\n\npassed\n\n## MDD Summary\n\nDone.\n',
  text => text.replace('\npassed\n', '\nunknown\n'),
  text => text.replace(/## MDD Summary\n\n[^\n]+/, '## MDD Summary\n\n'),
  text => text.replace('```json', '```json\nnot json'),
  text => `${text}\n## MDD Summary\n\nsecond one\n`,
]) {
}

// Stated binding is checked when it is stated. It can only reject a mismatch, never allow one.
for (const wrong of [
  text => text.replace(/## MDD Phase\n\n[^\n]+/, '## MDD Phase\n\nmdd-apply'),
  text => text.replace(/## MDD Run\n\n[^\n]+/, '## MDD Run\n\nwrong'),
]) {
}

for (const store of ['none', 'engram', 'openspec', 'both']) {
}

test('a receipt failure does not prove an investigation stopped', async t => {
  const { runner } = await fixture(t);
  await runner.explore({ purpose: 'Buscar el issue 389.' }, runtime);
  await runner.before(call, runner.status(runtime.sessionID).task);
  runner.block(runtime.sessionID, 'A tool in the delegated phase failed or was interrupted.');
  const stopped = runner.status(runtime.sessionID);
  assert.equal(stopped.state, 'await-result');
  assert.match(stopped.reason, /termination is unconfirmed/);
  await assert.rejects(runner.explore({ purpose: 'Ask another question.' }, runtime), /already in progress/);
});

test('the adapter-owned trace section cannot be written by the actor', async t => {
  const { acceptance } = await import('../dist/acceptance.js');
  const { assertNoTraceSection, TRACE_HEADING } = await import('../dist/acceptance.js');
  assert.equal(assertNoTraceSection('# Report\n\nAll good.\n'), '# Report\n\nAll good.\n');
  assert.throws(() => assertNoTraceSection(`# Report\n\n${TRACE_HEADING}\n\n{"accepted": false}\n`),
    /adapter-owned acceptance and plan links/);
  assert.equal(typeof acceptance, 'function');
});

