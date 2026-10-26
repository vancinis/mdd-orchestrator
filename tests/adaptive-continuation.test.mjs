import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdaptiveLow, adaptiveSelection } from '../dist/adaptive-low.js';
import { PhaseRunner } from '../dist/phase-runner.js';
import { NativeIntake } from '../dist/native-intake.js';
import { AdaptiveStore } from '../dist/adaptive-store.js';
import { ProgressGuard } from '../dist/progress.js';
import { RunOwnershipStore } from '../dist/run-ownership.js';
import { defaultSettings } from '../dist/settings.js';
import { LocalFiles } from '../dist/local-files.js';
import { adaptiveTransferRequest } from '../dist/adaptive-transfer.js';

const hash = value => createHash('sha256').update(value).digest('hex');
function rewriteContinuation(f, change) {
  const saved = f.options.adaptiveStore.read('parent'), receipts = structuredClone(saved.data.receipts);
  change(saved.data.continuation);
  const { digest, ...body } = saved; saved.digest = hash(JSON.stringify(body));
  new LocalFiles(f.root).updateStrict(`.mdd/adaptive-${hash('parent')}.json`, () => JSON.stringify(saved), 8 * 1024 * 1024);
  assert.deepEqual(f.options.adaptiveStore.read('parent').data.receipts, receipts, 'actual native receipts remain unchanged');
}

test('AL-04c P1: rehashed continuation cannot move an actual Verify receipt to a new snapshot', async t => {
  const f = fixture(t); await f.admit(); await f.retain(); await f.start('medium'); await plan(f); await applyRemaining(f);
  const original = await evidence(f); await f.select('mdd-verify'); await f.dispatch(verify(f, original.checks));
  const fresh = await evidence(f); assert.notEqual(fresh.snapshotID, original.snapshotID);
  assert.equal(f.status().continuation.next, 'mdd-verify');
  rewriteContinuation(f, c => { c.reports.at(-1).snapshotID = fresh.snapshotID; });
  const cold = new PhaseRunner(f.inspect, f.options), restored = await cold.restore(f.runtime);
  if (restored.restored) {
    const closed = await cold.closeAdaptiveInternal({ handle: cold.status('parent').selection.handle, outcome: 'verified' }, f.runtime);
    assert.notEqual(closed.state, 'completed', 'a previous native Verify cannot earn closure on a different snapshot');
  }
  assert.equal(restored.restored, false, 'cold restore must reject the moved native Verify snapshot');
});

test('AL-04c P2: rehashed continuation cannot replace actual native Plan instructions or required checks', async t => {
  const f = fixture(t); await f.admit(); await f.retain(); await f.start('medium'); await plan(f);
  rewriteContinuation(f, c => { c.reports[0].fields.deliverables[0].description = 'Forged replacement instructions';
    c.reports[0].fields.deliverables[0].checks[0].command = 'node --version'; });
  const cold = new PhaseRunner(f.inspect, f.options), restored = await cold.restore(f.runtime);
  if (restored.restored) {
    await cold.selectAdaptiveInternal({ handle: cold.status('parent').selection.handle, actor: 'mdd-apply', assignmentID: 'A2', purpose: 'Continue actual held work.' }, f.runtime);
    const sent = await cold.before({ sessionID: 'parent', callID: 'forged-plan' }, cold.status('parent').task);
    assert.doesNotMatch(sent.prompt, /Forged replacement instructions|node --version/, 'native Apply must never receive modified continuation-only planning');
  }
  assert.equal(restored.restored, false, 'cold restore must reject planning fields different from the actual native receipt');
});

for (const field of ['description', 'command']) test(`AL-04c receipt binding: continuation-only Plan ${field} swap is refused`, async t => {
  const f = fixture(t); await f.admit(); await f.retain(); await f.start('medium'); await plan(f);
  rewriteContinuation(f, c => {
    const step = c.reports[0].fields.deliverables[0];
    if (field === 'description') step.description = 'Different native writer instructions'; else step.checks[0].command = 'node --version';
  });
  const cold = new PhaseRunner(f.inspect, f.options), restored = await cold.restore(f.runtime);
  assert.equal(restored.restored, false); assert.match(restored.reason, /accepted native receipt payload/);
});

test('AL-04c receipt binding: internally consistent continuation-only Verify history swap is refused', async t => {
  const f = fixture(t); await f.admit(); await f.retain(); await f.start('medium'); await plan(f); await applyRemaining(f);
  const report = await evidence(f); await f.select('mdd-verify'); await f.dispatch(verify(f, report.checks));
  report.checks.push({ id: 'X2', command: 'node --check two.txt', exit: 0 });
  report.checkResults[0].executions.push('X2'); report.checkResults[0].reason = 'Actual subsequent parent retry.';
  await f.runner.submitAdaptiveEvidenceInternal({ handle: f.status().selection.handle, evidence: report }, f.runtime);
  rewriteContinuation(f, c => {
    const fields = c.reports.at(-1).fields;
    fields.checks = report.checks; fields.verification.checkResults = report.checkResults;
  });
  const restored = await new PhaseRunner(f.inspect, f.options).restore(f.runtime);
  assert.equal(restored.restored, false); assert.match(restored.reason, /accepted native receipt payload/);
});

test('AL-04c receipt binding: stale Verify restores honestly and a fresh native Verify retains frozen dispatch context', async t => {
  const f = fixture(t); await f.admit(); await f.retain(); await f.start('medium'); await plan(f); await applyRemaining(f);
  const old = await evidence(f); await f.select('mdd-verify'); await f.dispatch(verify(f, old.checks));
  const fresh = await evidence(f), cold = new PhaseRunner(f.inspect, f.options), restored = await cold.restore(f.runtime);
  assert.equal(restored.restored, true, restored.reason); assert.equal(cold.status('parent').continuation.next, 'mdd-verify');
  await assert.rejects(cold.closeAdaptiveInternal({ handle: cold.status('parent').selection.handle, outcome: 'verified' }, f.runtime), /Verify/);
  await cold.selectAdaptiveInternal({ handle: cold.status('parent').selection.handle, actor: 'mdd-verify', assignmentID: 'A2', purpose: 'Review the fresh actual snapshot.' }, f.runtime);
  const call = { sessionID: 'parent', callID: 'fresh-verify' }, args = await cold.before(call, cold.status('parent').task);
  const frozen = f.options.adaptiveStore.read('parent').data.pending.verifyContext;
  assert.deepEqual(frozen, { snapshotID: fresh.snapshotID, checks: fresh.checks });
  const actual = verify(f, fresh.checks); await cold.after(call, args, JSON.stringify(actual));
  const saved = f.options.adaptiveStore.read('parent');
  assert.deepEqual(saved.data.receipts.at(-1).accepted, { fields: actual, verifyContext: frozen });
  assert.equal((await cold.closeAdaptiveInternal({ handle: cold.status('parent').selection.handle, outcome: 'verified' }, f.runtime)).state, 'completed');
});

test('AL-04c receipt binding: accepted structured Verify payload and context survive native-proven transfer', async t => {
  const f = fixture(t); await f.admit(); await f.retain(); await f.start('medium'); await plan(f); await applyRemaining(f);
  const report = await evidence(f); await f.select('mdd-verify'); await f.dispatch(verify(f, report.checks));
  const source = f.options.adaptiveStore.read('parent'), target = { ...f.runtime, sessionID: 'target' };
  f.inspect.adaptiveTransferIdle = async () => {};
  f.inspect.intake = async (here, text, messageID, scope) => {
    assert.deepEqual(here, target); assert.equal(scope, 'latest'); assert.equal(messageID, 'target-message');
    assert.equal(text, adaptiveTransferRequest(source)); return 'target-native-user';
  };
  f.inspect.confirmAdaptiveTransfer = async (here, receipt, runID) => {
    assert.deepEqual(here, target); assert.equal(runID, source.runID);
    assert.equal(receipt.sourceDigest, source.digest); assert.equal(receipt.sourceSequence, source.sequence);
    assert.deepEqual(f.options.ownership.confirmAdaptiveReceipt(runID, 'target', f.options.adaptiveStore), receipt);
  };
  await f.runner.transferAdaptiveInternal({ sourceSessionID: 'parent', runID: source.runID, operationID: 'move-verify', messageID: 'target-message' }, target);
  assert.deepEqual(f.options.adaptiveStore.read('target').data.receipts, source.data.receipts);
  const cold = new PhaseRunner(f.inspect, f.options), restored = await cold.restore(target);
  assert.equal(restored.restored, true, restored.reason);
  assert.equal((await cold.closeAdaptiveInternal({ handle: cold.status('target').selection.handle, outcome: 'verified' }, target)).state, 'completed');
});
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mdd-continuation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scope = { complete: true, reads: ['one.txt', 'two.txt'], writes: ['one.txt', 'two.txt'] };
  for (const path of scope.reads) writeFileSync(join(root, path), 'before');
  const contract = { contractVersion: 1, objective: 'Replace two bounded texts.',
    acceptance: { goal: 'Replace both texts', requirements: [{ id: 'R1', description: 'Bounded replacement',
      scenarios: [{ id: 'S1', given: 'Original texts', when: 'Replaced', then: 'Updated texts' }] }] },
    decisions: [], exclusions: ['No additional files'], productQuestions: [], scope,
    context: { technical: 'understood', dependencies: 'bounded', reason: 'Both sources were inspected.',
      fingerprints: scope.reads.map(path => ({ path, digest: hash('before') })) },
    assessment: { assessmentVersion: 1, impact: 'low', complexity: 'low' },
    assignments: scope.writes.map((path, i) => ({ id: `A${i + 1}`, description: `Replace text ${i + 1}`, path,
      scenarios: ['S1'], decisions: [], dependsOn: [], scope: { complete: true, reads: [path], writes: [path] },
      obligations: { source: [{ id: `E${i + 1}`, description: 'Read back the replacement', paths: [path] }], checks: [] } })) };
  const runtime = { sessionID: 'parent', agent: 'mdd-orchestrator', directory: root, worktree: root };
  const inspect = { parent: async () => {}, intake: async () => 'native-user', result: async (_r, _c, _a, output) => output,
    stopped: async () => true, liveness: async () => ({ verdict: 'stopped', reason: 'Exact child stopped.' }) };
  const options = { adaptiveStore: new AdaptiveStore(root), progress: new ProgressGuard(root), ownership: new RunOwnershipStore(root),
    workerCapability: { phase: 'mdd-explore', readOnly: true, applyEditing: true } };
  const runner = new PhaseRunner(inspect, options), settings = defaultSettings(); settings.profiles.default.answers.mode = 'automatic';
  const context = () => ({ ...contract.context, fingerprints: scope.reads.map(path => ({ path, digest: hash(readFileSync(join(root, path))) })) });
  const status = () => runner.status(runtime.sessionID);
  const select = (actor, assignmentID = 'A2') => runner.selectAdaptiveInternal({ handle: status().selection.handle,
    actor, assignmentID, purpose: 'Perform only the authorized next stage.' }, runtime);
  let calls = 0;
  const dispatch = async report => {
    const call = { sessionID: runtime.sessionID, callID: `call-${++calls}` }, task = status().task;
    const args = await runner.before(call, task);
    await runner.after(call, args, JSON.stringify(report)); return { call, args };
  };
  const start = depth => runner.escalateAdaptiveInternal({ handle: status().selection.handle, depth,
    rationale: 'Remaining technical coordination needs structured planning.',
    assessment: { assessmentVersion: 1, complexity: depth, impact: 'low' }, context: context() }, runtime);
  const report = extra => ({ outcome: 'passed', evidenceSummary: 'Actual bounded stage completed.', artifact: 'Actual stage findings.', ...extra });
  const remaining = () => [{ id: 'A2', description: 'Replace text 2 after the retained text', path: 'two.txt',
    scenarios: ['S1'], decisions: [], dependsOn: ['A1'], parallel: contract.assignments[1].scope,
    checks: [{ id: 'C2', command: 'node --check two.txt', requirement: 'required' }] }];
  const admit = () => new NativeIntake(runner, inspect, settings).admitAdaptiveInternal({ contract }, runtime, 'native-message');
  const retain = async () => { await select('mdd-apply', 'A1'); await dispatch(report({ completed: ['A1'], changes: ['one.txt'], checks: [] })); };
  return { root, contract, runtime, inspect, options, runner, status, select, dispatch, start, report, remaining, admit, retain, context };
}

test('AL-04c: medium executes actual Plan, revises remaining execution and preserves admission and retained IDs', async t => {
  const f = fixture(t); await f.admit(); await f.retain(); const original = f.options.adaptiveStore.read('parent').admissionDigest;
  await f.start('medium'); assert.equal(f.status().continuation.next, 'mdd-plan'); assert.equal(f.status().task, undefined);
  await assert.rejects(f.select('mdd-apply'), /next|Plan|planning/);
  await f.select('mdd-plan'); const task = f.status().task;
  const { args } = await f.dispatch(f.report({ verificationVersion: 1, acceptance: f.contract.acceptance, decisions: [], deliverables: f.remaining() }));
  assert.match(args.prompt, /deliverables=/); assert.doesNotMatch(args.prompt, /Report no structured data/);
  assert.deepEqual(f.status().selection.completed, ['A1']); assert.equal(f.status().continuation.next, 'mdd-apply');
  assert.equal(f.options.adaptiveStore.read('parent').admissionDigest, original);
  assert.equal(f.options.adaptiveStore.read('parent').data.contract.assignments[1].dependsOn.length, 0);
  await f.select('mdd-apply'); const apply = await f.dispatch(f.report({ completed: ['A2'], changes: ['two.txt'], checks: [] }));
  assert.match(apply.args.prompt, /C2/); assert.match(apply.args.prompt, /Replace text 2 after/);
  assert.equal(f.status().continuation.next, 'mdd-verify');
  await assert.rejects(f.select('mdd-plan'), /next|Verify/);
  await assert.rejects(f.runner.closeAdaptiveInternal({ handle: f.status().selection.handle, outcome: 'verified' }, f.runtime), /Verify|evidence|snapshot/);
  assert.notEqual(task.prompt, f.status().selection.handle);
});

test('AL-04c: high permits only the frozen real Propose Spec Design Tasks sequence', async t => {
  const f = fixture(t); await f.admit(); await f.retain(); await f.start('high');
  for (const [actor, data] of [['mdd-propose', {}], ['mdd-spec', { domain: 'project', acceptance: f.contract.acceptance }],
    ['mdd-design', { decisions: [] }], ['mdd-tasks', { deliverables: f.remaining() }]]) {
    assert.equal(f.status().continuation.next, actor);
    await assert.rejects(f.select('mdd-verify'), /next|stage/);
    await f.select(actor); const { args } = await f.dispatch(f.report({ verificationVersion: 1, ...data }));
    assert.match(args.prompt, new RegExp(actor));
    assert.equal(f.status().lastReceipt.outcome, 'passed', f.status().lastReceipt.failure);
  }
  assert.deepEqual(f.status().continuation.reports.map(item => item.actor), ['mdd-propose', 'mdd-spec', 'mdd-design', 'mdd-tasks']);
  assert.throws(() => adaptiveSelection({ handle: 'unused', actor: 'mdd-design', assignmentID: 'A2', purpose: 'Not ordinary low authority.' }, f.contract), /only/);
});

test('regression: high continuation reports of any size reach the next actor, the oldest compacted first', async t => {
  const f = fixture(t); await f.admit(); await f.retain(); await f.start('high');
  const finding = actor => `${actor} finding: ${'Each stage records what it found in the declared sources and why. '.repeat(200)}`;
  assert.ok(Buffer.byteLength(finding('mdd-propose')) > 12000, 'every artifact is past the old 12000-byte cap');
  const prompts = [];
  for (const [actor, data] of [['mdd-propose', {}], ['mdd-spec', { domain: 'project', acceptance: f.contract.acceptance }],
    ['mdd-design', { decisions: [] }], ['mdd-tasks', { deliverables: f.remaining() }]]) {
    await f.select(actor);
    const { args } = await f.dispatch(f.report({ verificationVersion: 1, artifact: finding(actor), ...data }));
    prompts.push(args.prompt);
    assert.equal(f.status().lastReceipt.outcome, 'passed', f.status().lastReceipt.failure);
  }
  const held = f.options.adaptiveStore.read('parent').data;
  assert.deepEqual(held.receipts.filter(item => item.actor !== 'mdd-apply').map(item => item.artifact),
    ['mdd-propose', 'mdd-spec', 'mdd-design', 'mdd-tasks'].map(finding), 'every receipt keeps its artifact whole');
  for (const prompt of prompts) assert.ok(Buffer.byteLength(prompt) <= 38000, 'every prompt fits the dispatch budget');
  // Tasks follows three reports that cannot all be inlined: the oldest gives way first, and says so.
  assert.ok(prompts[1].includes(JSON.stringify(finding('mdd-propose'))), 'a report that fits reaches the next actor whole');
  assert.equal(prompts[1].includes('"omitted":'), false);
  const tasks = prompts[3], propose = JSON.stringify(held.continuation.reports[0].fields);
  assert.match(tasks, /earlier predecessor report\(s\) appear above as their summary plus the byte count and sha256 of the rest/);
  assert.ok(tasks.includes(createHash('sha256').update(propose).digest('hex')), 'the compacted report is named by the digest of what it left out');
  assert.equal(tasks.includes(finding('mdd-propose')), false);
  assert.ok(tasks.includes(JSON.stringify(finding('mdd-design'))), 'the newest report still reaches Tasks whole');
  await f.select('mdd-apply'); await f.dispatch(f.report({ completed: ['A2'], changes: ['two.txt'], checks: [] }));
  assert.equal(f.status().continuation.next, 'mdd-verify');
  const cold = new PhaseRunner(f.inspect, f.options), restored = await cold.restore(f.runtime);
  assert.equal(restored.restored, true, restored.reason);
});

for (const mutation of [
  (f, r) => { r.acceptance.goal = 'Expanded business objective'; },
  (f, r) => { r.acceptance.requirements[0].scenarios[0].then = 'Changed meaning under the same stable ID'; },
  (f, r) => { r.deliverables[0].scenarios = ['invented']; },
  (f, r) => { r.deliverables[0].parallel.writes.push('one.txt'); },
  (f, r) => { r.deliverables[0].id = 'A1'; },
]) test(`AL-04c: invalid remaining authority pauses the stage ${mutation}`, async t => {
  const f = fixture(t); await f.admit(); await f.retain(); await f.start('medium'); await f.select('mdd-plan');
  const report = f.report({ verificationVersion: 1, acceptance: structuredClone(f.contract.acceptance), decisions: [], deliverables: f.remaining() });
  mutation(f, report); await f.dispatch(report);
  assert.equal(f.status().lastReceipt.outcome, 'failed'); assert.equal(f.status().continuation.next, 'mdd-plan');
  assert.deepEqual(f.status().selection.completed, ['A1']); assert.equal(f.status().task, undefined);
});

test('AL-04c: unknown context is not positive high authority and closed runs never reopen', async t => {
  const f = fixture(t); await f.admit();
  await assert.rejects(f.runner.escalateAdaptiveInternal({ handle: f.status().selection.handle, depth: 'high',
    rationale: 'Context is unknown.', assessment: f.contract.assessment, context: f.context() }, f.runtime), /positive|high|assessment/);
  await f.runner.closeAdaptiveInternal({ handle: f.status().selection.handle, outcome: 'unverified', limits: ['Not implemented.'] }, f.runtime);
  await assert.rejects(f.start('medium'), /boundary|terminal|handle/);
});

for (const boundary of ['start', 'acceptance', 'dispatch']) test(`AL-04c: retained drift at ${boundary} cannot advance planning`, async t => {
  const f = fixture(t); await f.admit(); await f.retain();
  if (boundary !== 'start') await f.start('medium');
  if (boundary !== 'start') await f.select('mdd-plan');
  writeFileSync(join(f.root, 'one.txt'), 'drift');
  if (boundary === 'start') await assert.rejects(f.start('medium'), /stale|retained/);
  else if (boundary === 'dispatch') await assert.rejects(f.runner.before({ sessionID: 'parent', callID: 'drift' }, f.status().task), /stale|retained/);
  else {
    // Drift after actual dispatch is independently checked at report acceptance.
    writeFileSync(join(f.root, 'one.txt'), 'before');
    const call = { sessionID: 'parent', callID: 'acceptance' }, args = await f.runner.before(call, f.status().task);
    writeFileSync(join(f.root, 'one.txt'), 'drift');
    await f.runner.after(call, args, JSON.stringify(f.report({ verificationVersion: 1, acceptance: f.contract.acceptance, decisions: [], deliverables: f.remaining() })));
    assert.equal(f.status().lastReceipt.outcome, 'failed'); assert.equal(f.status().continuation.next, 'mdd-plan');
  }
});

test('AL-04c: restore revalidates actual reports, rotates handles and rejects forged advancement', async t => {
  const f = fixture(t); await f.admit(); await f.retain(); await f.start('medium'); await f.select('mdd-plan');
  await f.dispatch(f.report({ verificationVersion: 1, acceptance: f.contract.acceptance, decisions: [], deliverables: f.remaining() }));
  const data = f.options.adaptiveStore.read('parent').data, old = f.status().selection.handle;
  const restored = AdaptiveLow.restore(data, f.root); assert.notEqual(restored.status().selection.handle, old);
  assert.equal(restored.status().continuation.next, 'mdd-apply');
  const forged = structuredClone(data); forged.continuation.reports[0].fields.acceptance.goal = 'Silent rebind';
  assert.throws(() => AdaptiveLow.restore(forged, f.root), /acceptance|held|authority|report/);
});

for (const actor of ['mdd-plan', 'mdd-propose', 'mdd-spec', 'mdd-design', 'mdd-tasks', 'mdd-verify'])
  test(`AL-04c: cold pending ${actor} requires exact native stopped proof and never a fake Apply`, async t => {
    const f = fixture(t); await f.admit(); await f.retain(); await f.start(actor === 'mdd-plan' || actor === 'mdd-verify' ? 'medium' : 'high');
    if (actor === 'mdd-verify') {
      await plan(f); await applyRemaining(f); await evidence(f);
    } else if (actor !== 'mdd-plan') for (const [stage, data] of highReports(f)) {
      if (stage === actor) break;
      await f.select(stage); await f.dispatch(f.report({ verificationVersion: 1, ...data }));
    }
    await f.select(actor);
    const call = { sessionID: 'parent', callID: `pending-${actor}` }, task = f.status().task;
    const args = await f.runner.before(call, task);
    const cold = new PhaseRunner(f.inspect, f.options), restoration = await cold.restore(f.runtime);
    assert.equal(restoration.restored, false); assert.match(restoration.reason, /quarantined/);
    await assert.rejects(cold.after(call, args, '{}'), /Cold|cold|replay/);
    f.inspect.liveness = async () => ({ verdict: 'unknown', reason: 'Child not confirmed stopped.' });
    assert.equal((await cold.recoverAdaptiveInternal(f.runtime)).verdict, 'unknown');
    assert.equal(cold.status('parent').state, 'await-result');
    f.inspect.liveness = async () => ({ verdict: 'stopped', reason: 'Exact child stopped.' });
    assert.equal((await cold.recoverAdaptiveInternal(f.runtime)).verdict, 'stopped');
    const status = cold.status('parent'); assert.equal(status.lastReceipt.actor, actor); assert.equal(status.lastReceipt.outcome, 'failed');
    assert.equal(status.continuation.next, actor); assert.equal(status.task, undefined);
    await assert.rejects(f.runner.after(call, args, '{}'), /stale|authority|fenced/);
  });

function highReports(f) {
  return [['mdd-propose', {}], ['mdd-spec', { domain: 'project', acceptance: f.contract.acceptance }],
    ['mdd-design', { decisions: [] }], ['mdd-tasks', { deliverables: f.remaining() }]];
}
async function plan(f) {
  await f.select('mdd-plan');
  await f.dispatch(f.report({ verificationVersion: 1, acceptance: f.contract.acceptance, decisions: [], deliverables: f.remaining() }));
}
async function applyRemaining(f) {
  await f.select('mdd-apply'); await f.dispatch(f.report({ completed: ['A2'], changes: ['two.txt'], checks: [] }));
}
async function evidence(f, structured = true) {
  const handle = () => f.status().selection.handle;
  const p = await f.runner.prepareAdaptiveEvidenceInternal({ handle: handle() }, f.runtime);
  const finding = sources => ({ status: 'verified', sources, checks: [], assessment: 'Actual final source satisfies the held replacement.' });
  const report = { snapshotID: p.evidence.snapshot.id,
    readback: { acceptance: f.contract.acceptance, scope: f.contract.scope, exclusions: f.contract.exclusions, decisions: [] },
    inventory: [], exclusions: [{ exclusion: f.contract.exclusions[0], ...finding([]) }],
    sources: f.contract.assignments.flatMap(item => item.obligations.source.map(source => ({ id: source.id, paths: source.paths,
      status: 'verified', assessment: 'The actual bounded source was read back.' }))),
    assignments: f.contract.assignments.map(item => ({ assignmentID: item.id, ...finding(item.obligations.source.map(source => source.id)) })),
    scenarios: f.contract.assignments.map(item => ({ requirementID: 'R1', scenarioID: 'S1', assignmentID: item.id, ...finding(item.obligations.source.map(source => source.id)) })),
    decisions: [], checks: structured ? [{ id: 'X1', command: 'node --check two.txt', exit: 0 }] : [],
    checkResults: structured ? [{ checkID: 'C2', disposition: 'passed', executions: ['X1'] }] : [], supplementalChecks: [], limits: [] };
  delete report.exclusions[0].sources; delete report.exclusions[0].checks;
  await f.runner.submitAdaptiveEvidenceInternal({ handle: handle(), evidence: report }, f.runtime);
  return report;
}
function verify(f, checks) {
  const finding = { status: 'verified', checks: ['X1'], assessment: 'Actual parent check and source readback support the held behavior.' };
  return f.report({ verificationVersion: 1, checks, verification: {
    scenarios: ['A1', 'A2'].map(stepID => ({ requirementID: 'R1', scenarioID: 'S1', stepID, ...finding })),
    steps: ['A1', 'A2'].map(stepID => ({ stepID, ...finding })), decisions: [], changes: 'Both bounded texts were inspected.', limits: [],
    checkResults: [{ checkID: 'C2', disposition: 'passed', executions: ['X1'] }], supplementalChecks: [] } });
}

for (const depth of ['medium', 'high']) test(`AL-04c: real ${depth} structured Verify reviews parent checks and AL-03 readback still gates closure`, async t => {
  const f = fixture(t); await f.admit(); await f.retain(); await f.start(depth);
  if (depth === 'medium') await plan(f);
  else for (const [actor, data] of highReports(f)) { await f.select(actor); await f.dispatch(f.report({ verificationVersion: 1, ...data })); }
  await applyRemaining(f);
  await assert.rejects(f.select('mdd-verify'), /parent evidence/);
  const report = await evidence(f); await f.select('mdd-verify'); await f.dispatch(verify(f, report.checks));
  assert.equal(f.status().lastReceipt.outcome, 'passed', f.status().lastReceipt.failure);
  assert.equal(f.status().continuation.next, undefined);
  const cold = new PhaseRunner(f.inspect, f.options); assert.equal((await cold.restore(f.runtime)).restored, true);
  const closed = await cold.closeAdaptiveInternal({ handle: cold.status('parent').selection.handle, outcome: 'verified' }, f.runtime);
  assert.equal(closed.state, 'completed');
  assert.equal(closed.completion.outcome, 'verified');
});

test('AL-04c: forged Verify executions do not grant command authority or closure', async t => {
  const f = fixture(t); await f.admit(); await f.retain(); await f.start('medium'); await plan(f); await applyRemaining(f);
  const report = await evidence(f); await f.select('mdd-verify');
  await f.dispatch(verify(f, [...report.checks, { id: 'fake', command: 'invented command', exit: 0 }]));
  assert.equal(f.status().lastReceipt.outcome, 'failed'); assert.equal(f.status().continuation.next, 'mdd-verify');
  await assert.rejects(f.runner.closeAdaptiveInternal({ handle: f.status().selection.handle, outcome: 'verified' }, f.runtime), /Verify/);
});

test('AL-04c: accepted planning invalidates old current evidence but preserves its real historical binding', async t => {
  const f = fixture(t); await f.admit(); await f.retain(); await evidence(f, false); await f.start('medium'); await plan(f);
  assert.equal(f.status().lastReceipt.outcome, 'passed'); assert.equal(f.status().evidence.matched, false);
  const cold = new PhaseRunner(f.inspect, f.options), restored = await cold.restore(f.runtime);
  assert.equal(restored.restored, true, restored.reason);
  assert.equal(cold.status('parent').continuation.next, 'mdd-apply');
  await cold.selectAdaptiveInternal({ handle: cold.status('parent').selection.handle, actor: 'mdd-apply', assignmentID: 'A2', purpose: 'Continue remaining work.' }, f.runtime);
  const p = f.options.adaptiveStore.read('parent').data.priorEvidence;
  assert.deepEqual(p.report.checks, []); assert.equal(p.report.snapshotID, p.snapshot.id);
});

test('AL-04c: all retained work permits an empty remaining plan without a duplicate writer', async t => {
  const f = fixture(t); await f.admit(); await f.retain(); await applyRemaining(f); await f.start('medium');
  await f.select('mdd-plan'); await f.dispatch(f.report({ verificationVersion: 1, acceptance: f.contract.acceptance, decisions: [], deliverables: [] }));
  assert.equal(f.status().lastReceipt.outcome, 'passed', f.status().lastReceipt.failure);
  assert.equal(f.status().continuation.next, 'mdd-verify'); assert.deepEqual(f.status().selection.completed, ['A1', 'A2']);
});

test('AL-04c: changed parent check history requires another actual Verify on the same snapshot', async t => {
  const f = fixture(t); await f.admit(); await f.retain(); await f.start('medium'); await plan(f); await applyRemaining(f);
  const report = await evidence(f); await f.select('mdd-verify'); await f.dispatch(verify(f, report.checks));
  report.checks.push({ id: 'X2', command: 'node --check two.txt', exit: 0 });
  report.checkResults[0].executions.push('X2'); report.checkResults[0].reason = 'The actual check was rerun in parent tools.';
  await f.runner.submitAdaptiveEvidenceInternal({ handle: f.status().selection.handle, evidence: report }, f.runtime);
  assert.equal(f.status().continuation.next, 'mdd-verify');
  await assert.rejects(f.runner.closeAdaptiveInternal({ handle: f.status().selection.handle, outcome: 'verified' }, f.runtime), /Verify/);
});

test('AL-04c: validated remaining dependencies actually change writer readiness and pending lineage', async t => {
  const f = fixture(t); writeFileSync(join(f.root, 'three.txt'), 'before');
  f.contract.scope.reads.push('three.txt'); f.contract.scope.writes.push('three.txt');
  f.contract.context.fingerprints.push({ path: 'three.txt', digest: hash('before') });
  f.contract.assignments.push({ ...structuredClone(f.contract.assignments[1]), id: 'A3', path: 'three.txt', description: 'Replace third text',
    scope: { complete: true, reads: ['three.txt'], writes: ['three.txt'] },
    obligations: { source: [{ id: 'E3', description: 'Read third text', paths: ['three.txt'] }], checks: [] } });
  await f.admit(); await f.retain(); await f.start('medium'); await f.select('mdd-plan');
  const steps = f.remaining(); steps.push({ ...structuredClone(steps[0]), id: 'A3', path: 'three.txt', description: 'Replace third text after second',
    dependsOn: ['A2'], parallel: f.contract.assignments[2].scope, checks: [{ id: 'C3', command: 'node --check three.txt', requirement: 'required' }] });
  await f.dispatch(f.report({ verificationVersion: 1, acceptance: f.contract.acceptance, decisions: [], deliverables: steps }));
  assert.equal(f.status().lastReceipt.outcome, 'passed', f.status().lastReceipt.failure);
  assert.equal(f.status().selection.assignments.find(item => item.id === 'A3').prerequisitesComplete, false);
  await assert.rejects(f.select('mdd-apply', 'A3'), /prerequisites/);
  await applyRemaining(f); await f.select('mdd-apply', 'A3');
  const call = { sessionID: 'parent', callID: 'third' }; await f.runner.before(call, f.status().task);
  assert.deepEqual(f.options.adaptiveStore.read('parent').data.pending.dispatchPrerequisites.map(item => item.assignmentID), ['A2', 'A1']);
});

test('AL-04c: stale retained planning work requires an explicit bounded repair before stage retry', async t => {
  const f = fixture(t); await f.admit(); await f.retain(); await f.start('high');
  writeFileSync(join(f.root, 'one.txt'), 'drift');
  const cold = new PhaseRunner(f.inspect, f.options); assert.equal((await cold.restore(f.runtime)).restored, true);
  const selection = () => ({ handle: cold.status('parent').selection.handle, assignmentID: 'A1', purpose: 'Explicitly repair invalidated retained work.' });
  await assert.rejects(cold.selectAdaptiveInternal({ ...selection(), actor: 'mdd-propose' }, f.runtime), /stale/);
  const prior = f.options.adaptiveStore.read('parent').data.receipts[0];
  await cold.selectAdaptiveInternal({ ...selection(), actor: 'mdd-apply', repairOf: prior.id, context: f.context() }, f.runtime);
  const call = { sessionID: 'parent', callID: 'repair-retained' }, args = await cold.before(call, cold.status('parent').task);
  await cold.after(call, args, JSON.stringify(f.report({ completed: ['A1'], changes: ['one.txt'], checks: [] })));
  assert.deepEqual(cold.status('parent').selection.completed, ['A1']);
  assert.equal(cold.status('parent').continuation.next, 'mdd-propose');
});

for (const mutation of [
  c => { c.revision++; },
  c => { c.bindings[0].description = 'Changed meaning with retained source bytes'; },
  c => { c.reports[0].receiptID = 'invented'; },
  c => { c.reports[0].fields.callID = 'foreign-call'; },
  c => { c.context.technical = 'uncertain'; },
  c => { c.context.dependencies = 'unknown'; },
]) test(`AL-04c: relational restore rejects forged continuation ${mutation}`, async t => {
  const f = fixture(t); await f.admit(); await f.retain(); await f.start('medium'); await plan(f);
  const data = f.options.adaptiveStore.read('parent').data; mutation(data.continuation);
  assert.throws(() => AdaptiveLow.restore(data, f.root), /revision|binding|receipt|context|understood|bounded/);
});

test('AL-04c: escalation rechecks native owner epoch and source context after parent await', async t => {
  const f = fixture(t); await f.admit();
  f.inspect.parent = async () => {
    const owner = f.runner.owner('parent'), reserved = f.options.ownership.reserve(owner.runID, 'parent', 'raced', owner.epoch);
    f.options.ownership.release(owner.runID, 'parent', 'raced', reserved.epoch);
  };
  await assert.rejects(f.start('high'), /ownership changed/);
  assert.equal(f.options.adaptiveStore.read('parent').data.continuation, undefined);
  f.inspect.parent = async () => writeFileSync(join(f.root, 'two.txt'), 'await drift');
  await assert.rejects(f.start('high'), /stale/);
  assert.equal(f.options.adaptiveStore.read('parent').data.continuation, undefined);
});
