import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhaseRunner } from '../dist/phase-runner.js';
import { NativeIntake } from '../dist/native-intake.js';
import { ProgressGuard } from '../dist/progress.js';
import { RunOwnershipStore } from '../dist/run-ownership.js';
import { CheckpointStore } from '../dist/checkpoint.js';
import { AdaptiveStore } from '../dist/adaptive-store.js';
import { WorkerFence } from '../dist/worker-fence.js';
import { defaultSettings } from '../dist/settings.js';
import { createInspector } from '../dist/opencode-plugin.js';

async function applied(t, checks = [], durable = false) {
  const f = fixture(t); f.contract.assignments[0].obligations.checks = checks;
  if (durable) f.options.adaptiveStore = new AdaptiveStore(f.root);
  await f.admit(); await f.select();
  const args = await f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task);
  writeFileSync(join(f.root, 'own.txt'), 'after');
  await f.runner.after(f.call, args, f.report());
  f.handle = () => f.runner.status(f.runtime.sessionID).selection.handle;
  f.prepare = () => f.runner.prepareAdaptiveEvidenceInternal({ handle: f.handle() }, f.runtime);
  f.submit = evidence => f.runner.submitAdaptiveEvidenceInternal({ handle: f.handle(), evidence }, f.runtime);
  f.close = () => f.runner.closeAdaptiveInternal({ handle: f.handle(), outcome: 'verified' }, f.runtime);
  f.evidence = snapshot => ({ snapshotID: snapshot.id, readback: { acceptance: f.contract.acceptance,
    scope: f.contract.scope, exclusions: f.contract.exclusions, decisions: f.contract.decisions },
    inventory: [{ path: 'own.txt', disposition: 'assignment', reason: 'Replacement inspected in the final diff.' }],
    exclusions: [{ exclusion: f.contract.exclusions[0], status: 'verified', assessment: 'No other files belong to this change.' }],
    sources: [{ id: 'E1', paths: ['own.txt'], status: 'verified', assessment: 'The final file contains the replacement text.' }],
    assignments: [{ assignmentID: 'A1', status: 'verified', sources: ['E1'], checks: [], assessment: 'Assigned replacement is present.' }],
    scenarios: [{ requirementID: 'R1', scenarioID: 'S1', assignmentID: 'A1', status: 'verified', sources: ['E1'], checks: [], assessment: 'Updated text satisfies the held scenario.' }],
    decisions: [], checks: [], checkResults: [], supplementalChecks: [], limits: [] });
  return f;
}

test('AL-03: source-only Apply closes with parent readback and no mandatory Verify or fake commands', async t => {
  const f = await applied(t), prepared = await f.prepare();
  assert.equal(prepared.evidence.snapshot.sources[0].content, 'after');
  await f.submit(f.evidence(prepared.evidence.snapshot));
  const closed = await f.close();
  assert.equal(closed.state, 'completed'); assert.equal(closed.completion.outcome, 'verified');
  assert.equal(closed.evidence.report.checks.length, 0);
  assert.match(closed.evidence.assurance, /reported.*not independent/i);
  assert.equal(closed.task, undefined); assert.equal(closed.workflow, undefined);
  await assert.rejects(f.select(), /terminal|completed|handle/);
});

for (const disposition of ['failed', 'ran', 'blocked']) test(`AL-03: required ${disposition} evidence cannot close verified`, async t => {
  const f = await applied(t, [{ id: 'C1', command: 'npm test', requirement: 'required' }]);
  const prepared = await f.prepare(), evidence = f.evidence(prepared.evidence.snapshot);
  evidence.checks = disposition === 'blocked' ? [] : [{ id: 'X1', command: 'npm test', exit: disposition === 'ran' ? null : 1 }];
  evidence.checkResults = [{ checkID: 'C1', disposition, executions: evidence.checks.map(check => check.id), reason: 'The actual required check did not succeed.' }];
  const submitted = await f.submit(evidence);
  assert.equal(submitted.evidence.matched, false);
  await assert.rejects(f.close(), /required|verified|evidence/);
  assert.equal(f.runner.status(f.runtime.sessionID).state, 'await-selection');
});

test('AL-03: missing required check disposition is rejected, not waived', async t => {
  const f = await applied(t, [{ id: 'C1', command: 'npm test', requirement: 'required' }]);
  const prepared = await f.prepare();
  await assert.rejects(f.submit(f.evidence(prepared.evidence.snapshot)), /omits.*C1/);
  await assert.rejects(f.close(), /evidence/);
});

for (const boundary of ['prepare', 'submit', 'close']) test(`AL-03: source drift at ${boundary} refuses evidence authority`, async t => {
  const f = await applied(t);
  const prepared = boundary === 'prepare' ? undefined : await f.prepare();
  if (boundary === 'close') await f.submit(f.evidence(prepared.evidence.snapshot));
  writeFileSync(join(f.root, 'own.txt'), 'drift');
  await assert.rejects(boundary === 'prepare' ? f.prepare() : boundary === 'submit' ? f.submit(f.evidence(prepared.evidence.snapshot)) : f.close(), /stale|drift/);
  assert.equal(f.runner.status(f.runtime.sessionID).completion, undefined);
});

test('AL-03: optional failed check stays visible and retry accounting retains actual history', async t => {
  const f = await applied(t, [{ id: 'C1', command: 'npm test', requirement: 'optional' }]);
  const prepared = await f.prepare(), evidence = f.evidence(prepared.evidence.snapshot);
  evidence.checks = [{ id: 'X1', command: 'npm test', exit: 1 }];
  evidence.checkResults = [{ checkID: 'C1', disposition: 'failed', executions: ['X1'], reason: 'Optional check failed in the parent tools.' }];
  await f.submit(evidence); const closed = await f.close();
  assert.equal(closed.evidence.report.checkResults[0].disposition, 'failed');
  const g = await applied(t, [{ id: 'C1', command: 'npm test', requirement: 'required' }]);
  const p = await g.prepare(), e = g.evidence(p.evidence.snapshot);
  e.checks = [{ id: 'X1', command: 'npm test', exit: 1 }, { id: 'X2', command: 'npm test', exit: 0 }];
  e.checkResults = [{ checkID: 'C1', disposition: 'passed', executions: ['X1', 'X2'], reason: 'The failed attempt was retried after diagnosing the environment.' }];
  await g.submit(e); assert.equal((await g.close()).completion.outcome, 'verified');
});

for (const mutate of [
  e => { e.readback.scope.writes.push('other.txt'); },
  e => { e.sources[0].paths = ['other.txt']; },
  e => { e.scenarios[0].assignmentID = 'invented'; },
  e => { e.assignments[0].sources = ['invented']; },
  e => { e.inventory[0].path = 'other.txt'; },
  e => { e.exclusions = []; },
]) test(`AL-03: invalid parent readback cannot earn coverage ${mutate.toString()}`, async t => {
  const f = await applied(t), p = await f.prepare(), e = f.evidence(p.evidence.snapshot); mutate(e);
  await assert.rejects(f.submit(e)); assert.equal(f.runner.status(f.runtime.sessionID).evidence.matched, false);
});

test('AL-03: evidence boundary rejects stale handles, wrong runtime and ownership lost during inspection', async t => {
  const f = await applied(t), handle = f.handle(); await f.prepare();
  await assert.rejects(f.runner.prepareAdaptiveEvidenceInternal({ handle }, f.runtime), /handle/);
  await assert.rejects(f.runner.prepareAdaptiveEvidenceInternal({ handle: f.handle() }, { ...f.runtime, agent: 'general' }), /coordinator|workspace/);
  const owner = f.runner.owner(f.runtime.sessionID);
  f.inspect.parent = async () => { f.ownership.reserve(owner.runID, f.runtime.sessionID, 'raced-parent', owner.epoch); };
  await assert.rejects(f.prepare(), /ownership/);
});

test('AL-03: explicit completed repair references latest Apply, refreshes local fingerprints and does not auto-repeat', async t => {
  const f = await applied(t), p = await f.prepare(), e = f.evidence(p.evidence.snapshot);
  e.sources[0].status = 'not-verified'; e.assignments[0].status = 'not-verified'; e.scenarios[0].status = 'not-verified'; await f.submit(e);
  await assert.rejects(f.select(), /repair|completed/);
  await assert.rejects(f.select('mdd-apply', { repairOf: 'invented' }), /repair|receipt/);
  await f.select('mdd-apply', { repairOf: f.runner.status(f.runtime.sessionID).lastReceipt.id });
  assert.deepEqual(f.runner.status(f.runtime.sessionID).selection.completed, []);
  assert.equal(f.runner.status(f.runtime.sessionID).evidence.matched, false);
  const call = { ...f.call, callID: 'explicit-repair' };
  const args = await f.runner.before(call, f.runner.status(f.runtime.sessionID).task);
  await f.runner.after(call, args, f.report());
  const fresh = await f.prepare(); await f.submit(f.evidence(fresh.evidence.snapshot)); await f.close();
});

for (const mutation of [
  e => { e.checkResults[0] = { checkID: 'C1', disposition: 'not-applicable', executions: [], reason: 'Skip an unconditional check.' }; e.checks = []; },
  e => { e.checks[0].command = 'another command'; },
  e => { e.checks.unshift({ id: 'X0', command: 'npm test', exit: 1 }); },
  e => { e.checks.unshift({ id: 'X0', command: 'npm test', exit: 1 }); e.supplementalChecks = [{ id: 'extra', requirement: 'optional', disposition: 'failed', executions: ['X0'], reason: 'Hide a held retry as optional.' }]; },
  e => { e.checks[0].exit = null; },
]) test(`AL-03: required command accounting rejects waiver, mismatch, omitted retry or interrupted pass ${mutation.toString()}`, async t => {
  const f = await applied(t, [{ id: 'C1', command: 'npm test', requirement: 'required' }]), p = await f.prepare(), e = f.evidence(p.evidence.snapshot);
  e.checks = [{ id: 'X1', command: 'npm test', exit: 0 }];
  e.checkResults = [{ checkID: 'C1', disposition: 'passed', executions: ['X1'] }]; mutation(e);
  await assert.rejects(f.submit(e)); await assert.rejects(f.close(), /evidence|verified/);
});

for (const boundary of ['prepare', 'submit', 'close']) test(`AL-03: ${boundary} revalidates source after native parent await`, async t => {
  const f = await applied(t), p = boundary === 'prepare' ? undefined : await f.prepare();
  if (boundary === 'close') await f.submit(f.evidence(p.evidence.snapshot));
  f.inspect.parent = async () => writeFileSync(join(f.root, 'own.txt'), 'raced source');
  await assert.rejects(boundary === 'prepare' ? f.prepare() : boundary === 'submit' ? f.submit(f.evidence(p.evidence.snapshot)) : f.close(), /stale/);
  assert.equal(f.runner.status(f.runtime.sessionID).completion, undefined);
});

test('AL-03: completed repair invalidates dependent proof and preserves unrelated completed source proof', async t => {
  const f = await selectedDependency(t);
  const firstApply = f.runner.status(f.runtime.sessionID).lastReceipt;
  const complete = async (id, callID, content) => {
    const call = { ...f.call, callID }, args = await f.runner.before(call, f.runner.status(f.runtime.sessionID).task);
    if (content) writeFileSync(join(f.root, id === 'A2' ? 'other.txt' : 'later.txt'), content);
    await f.runner.after(call, args, f.report({ completed: [id], changes: [id === 'A2' ? 'other.txt' : 'later.txt'] }));
  };
  await complete('A2', 'finish-dependent');
  await f.select('mdd-apply', { assignmentID: 'A3' }); await complete('A3', 'finish-unrelated');
  const receipt = f.runner.status(f.runtime.sessionID).lastReceipt;
  const handle = () => f.runner.status(f.runtime.sessionID).selection.handle;
  const prepared = await f.runner.prepareAdaptiveEvidenceInternal({ handle: handle() }, f.runtime);
  const proof = assignment => ({ status: 'verified', sources: assignment.obligations.source.map(item => item.id), checks: [], assessment: 'The final assigned source and held behavior were read back.' });
  await f.runner.submitAdaptiveEvidenceInternal({ handle: handle(), evidence: {
    snapshotID: prepared.evidence.snapshot.id, readback: { acceptance: f.contract.acceptance, scope: f.contract.scope, exclusions: f.contract.exclusions, decisions: [] },
    inventory: [{ path: 'own.txt', disposition: 'assignment', reason: 'The actual final replacement diff was read back.' }],
    exclusions: [{ exclusion: f.contract.exclusions[0], status: 'verified', assessment: 'The parent found no excluded change.' }],
    sources: f.contract.assignments.flatMap(item => item.obligations.source.map(source => ({ id: source.id, paths: source.paths, status: 'verified', assessment: 'Final source was read back against its held obligation.' }))),
    assignments: f.contract.assignments.map(item => ({ assignmentID: item.id, ...proof(item) })),
    scenarios: f.contract.assignments.map(item => ({ requirementID: 'R1', scenarioID: 'S1', assignmentID: item.id, ...proof(item) })),
    decisions: [], checks: [], checkResults: [], supplementalChecks: [], limits: [],
  } }, f.runtime);
  await f.select('mdd-verify', { assignmentID: 'A1' });
  const review = { ...f.call, callID: 'read-only-review' };
  await f.runner.after(review, await f.runner.before(review, f.runner.status(f.runtime.sessionID).task), JSON.stringify({ outcome: 'passed', evidenceSummary: 'Read-only findings.', artifact: 'Source remains inspectable.' }));
  assert.equal(receipt.assignmentID, 'A3');
  writeFileSync(join(f.root, 'own.txt'), 'stale implementation');
  await f.select('mdd-apply', { assignmentID: 'A1', repairOf: firstApply.id });
  assert.deepEqual(f.runner.status(f.runtime.sessionID).selection.completed, ['A3']);
  assert.deepEqual(f.runner.status(f.runtime.sessionID).evidence.invalidatedAssignments, ['A1', 'A2']);
  assert.deepEqual(f.runner.status(f.runtime.sessionID).evidence.retainedAssignments, ['A3']);
  const repair = { ...f.call, callID: 'repair-prerequisite' };
  await f.runner.after(repair, await f.runner.before(repair, f.runner.status(f.runtime.sessionID).task), f.report());
  const fresh = await f.runner.prepareAdaptiveEvidenceInternal({ handle: handle() }, f.runtime);
  assert.deepEqual(fresh.evidence.retainedSourceProof.map(item => item.assignmentID), ['A3']);
  assert.equal(fresh.evidence.priorEvidence.report.assignments.find(item => item.assignmentID === 'A3').status, 'verified');
  assert.deepEqual(fresh.evidence.priorEvidence.invalidatedAssignments, ['A1', 'A2']);
});

test('AL-03: manual unverified close retains honest limits and never marks verified completion', async t => {
  const f = await applied(t);
  const closed = await f.runner.closeAdaptiveInternal({ handle: f.handle(), outcome: 'unverified', limits: ['Required command evidence was not collected.'] }, f.runtime);
  assert.equal(closed.state, 'closed-unverified'); assert.equal(closed.completion.outcome, 'unverified');
  assert.equal(closed.evidence.matched, false); assert.equal(closed.completion.limits.length, 1);
});

test('AL-03: evidence never bypasses a pending child or accepts caller attestation fields', async t => {
  const f = fixture(t, { stopped: async () => false }); await f.admit();
  const old = f.runner.status(f.runtime.sessionID).selection.handle; await f.select();
  const args = await f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task);
  await assert.rejects(f.runner.after(f.call, args, f.report()), /termination/);
  await assert.rejects(f.runner.prepareAdaptiveEvidenceInternal({ handle: old }, f.runtime), /ownership|actor|handle/);
  const g = await applied(t);
  await assert.rejects(g.runner.prepareAdaptiveEvidenceInternal({ handle: g.handle(), approved: true, executor: 'attested' }, g.runtime), /unknown/);
});

test('AL-03: re-preparing unchanged source cannot erase previously reported failed attempts', async t => {
  const f = await applied(t, [{ id: 'C1', command: 'npm test', requirement: 'required' }]), p = await f.prepare(), e = f.evidence(p.evidence.snapshot);
  e.checks = [{ id: 'X1', command: 'npm test', exit: 1 }];
  e.checkResults = [{ checkID: 'C1', disposition: 'failed', executions: ['X1'], reason: 'Initial required check failed.' }];
  await f.submit(e); const next = await f.prepare(), retry = f.evidence(next.evidence.snapshot);
  retry.checks = [{ id: 'X2', command: 'npm test', exit: 0 }];
  retry.checkResults = [{ checkID: 'C1', disposition: 'passed', executions: ['X2'] }];
  await assert.rejects(f.submit(retry), /history|attempt|retry/);
  retry.checks.unshift(e.checks[0]); retry.checkResults[0].executions.unshift('X1'); retry.checkResults[0].reason = 'Retried with the actual initial failure retained.';
  await f.submit(retry); await f.close();
});

test('AL-03: malformed resubmission cannot leave an earlier verified match closable', async t => {
  const f = await applied(t), p = await f.prepare(), e = f.evidence(p.evidence.snapshot); await f.submit(e);
  e.scenarios[0].scenarioID = 'invented'; await assert.rejects(f.submit(e));
  await assert.rejects(f.close(), /evidence|verified/);
});

test('AL-03: command-only proof uses actual successful execution IDs without inventing source obligations', async t => {
  const f = fixture(t); f.contract.assignments[0].obligations = { source: [], checks: [{ id: 'C1', command: 'npm test', requirement: 'required' }] };
  await f.admit(); await f.select(); const args = await f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task);
  await f.runner.after(f.call, args, f.report());
  const handle = () => f.runner.status(f.runtime.sessionID).selection.handle;
  const p = await f.runner.prepareAdaptiveEvidenceInternal({ handle: handle() }, f.runtime);
  const e = { snapshotID: p.evidence.snapshot.id, readback: { acceptance: f.contract.acceptance, scope: f.contract.scope, exclusions: f.contract.exclusions, decisions: [] },
    inventory: [{ path: 'own.txt', disposition: 'assignment', reason: 'Parent inspected the actual final diff.' }],
    exclusions: [{ exclusion: f.contract.exclusions[0], status: 'verified', assessment: 'Parent readback found no exclusion breach.' }], sources: [],
    assignments: [{ assignmentID: 'A1', status: 'verified', sources: [], checks: ['X1'], assessment: 'The actual command exercised the assigned replacement.' }],
    scenarios: [{ requirementID: 'R1', scenarioID: 'S1', assignmentID: 'A1', status: 'verified', sources: [], checks: ['X1'], assessment: 'The command covered the held replacement scenario.' }], decisions: [],
    checks: [{ id: 'X1', command: 'npm test', exit: 0 }], checkResults: [{ checkID: 'C1', disposition: 'passed', executions: ['X1'] }], supplementalChecks: [], limits: [] };
  await f.runner.submitAdaptiveEvidenceInternal({ handle: handle(), evidence: e }, f.runtime);
  assert.equal((await f.runner.closeAdaptiveInternal({ handle: handle(), outcome: 'verified' }, f.runtime)).completion.outcome, 'verified');
});

test('AL-03: actorless preparation and actor selection serialize on the same consumed handle', async t => {
  const f = await applied(t), handle = f.handle();
  const results = await Promise.allSettled([f.prepare(), f.select('mdd-verify', { handle })]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(f.runner.status(f.runtime.sessionID).state, 'await-selection');
});

test('AL-03: optional read-only Verify may follow evidence without becoming command execution authority', async t => {
  const f = await applied(t), p = await f.prepare(); await f.submit(f.evidence(p.evidence.snapshot));
  await f.select('mdd-verify'); const call = { ...f.call, callID: 'optional-verify' };
  const args = await f.runner.before(call, f.runner.status(f.runtime.sessionID).task);
  assert.equal(f.runner.workerAssignment(call).phase, 'mdd-explore'); assert.equal(f.runner.workerAssignment(call).scope, undefined);
  await f.runner.after(call, args, JSON.stringify({ outcome: 'passed', evidenceSummary: 'Source-only optional review.', artifact: 'Final source readback is consistent.' }));
  assert.equal((await f.close()).completion.outcome, 'verified');
});

test('AL-03: snapshot freshness includes declared read-only context beyond the completed writer footprint', async t => {
  const f = fixture(t); f.contract.scope = structuredClone(f.contract.scope);
  f.contract.scope.reads.push('other.txt'); f.contract.context.fingerprints.push({ path: 'other.txt', digest: digest('outside') });
  await f.admit(); await f.select(); await f.runner.after(f.call, await f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task), f.report());
  const p = await f.runner.prepareAdaptiveEvidenceInternal({ handle: f.runner.status(f.runtime.sessionID).selection.handle }, f.runtime);
  assert.deepEqual(p.evidence.snapshot.sources.map(item => item.path), ['own.txt', 'other.txt']);
  writeFileSync(join(f.root, 'other.txt'), 'context drift');
  await assert.rejects(f.runner.submitAdaptiveEvidenceInternal({ handle: f.runner.status(f.runtime.sessionID).selection.handle, evidence: {} }, f.runtime), /snapshot.*stale/);
});

test('AL-03: explicit completed repairs have a finite budget and never repeat automatically', async t => {
  const f = await applied(t);
  for (let i = 0; i < 4; i++) {
    const p = await f.prepare(), e = f.evidence(p.evidence.snapshot);
    for (const row of [...e.sources, ...e.assignments, ...e.scenarios]) row.status = 'not-verified';
    await f.submit(e); await f.select('mdd-apply', { repairOf: f.runner.status(f.runtime.sessionID).lastReceipt.id });
    const call = { ...f.call, callID: `repair-${i}` };
    await f.runner.after(call, await f.runner.before(call, f.runner.status(f.runtime.sessionID).task), f.report());
  }
  const p = await f.prepare(), e = f.evidence(p.evidence.snapshot);
  for (const row of [...e.sources, ...e.assignments, ...e.scenarios]) row.status = 'not-verified';
  await f.submit(e);
  await assert.rejects(f.select('mdd-apply', { repairOf: f.runner.status(f.runtime.sessionID).lastReceipt.id }), /budget.*exhausted/);
  assert.deepEqual(f.runner.status(f.runtime.sessionID).selection.completed, ['A1']);
});

test('AL-03: pending native intake and idle ownership epoch races refuse parent evidence preparation', async t => {
  const f = await applied(t);
  f.ownership.claimIntake(f.runtime.sessionID, 'pending-intake', 'another-user');
  await assert.rejects(f.prepare(), /ownership|actor/);
  const g = await applied(t), owner = g.runner.owner(g.runtime.sessionID);
  g.inspect.parent = async () => {
    const reserved = g.ownership.reserve(owner.runID, g.runtime.sessionID, 'temporary-operation', owner.epoch);
    g.ownership.release(owner.runID, g.runtime.sessionID, 'temporary-operation', reserved.epoch);
  };
  await assert.rejects(g.prepare(), /ownership changed/);
});

test('AL-03: compact status does not repeat final source bodies, while internal preparation returns readback', async t => {
  const f = await applied(t), text = 'Final source line.\n'.repeat(10000);
  // Explicitly re-settle a genuine writer after stale proof rather than broaden source authority.
  writeFileSync(join(f.root, 'own.txt'), text);
  await f.select('mdd-apply', { repairOf: f.runner.status(f.runtime.sessionID).lastReceipt.id });
  const call = { ...f.call, callID: 'large-source-repair' };
  await f.runner.after(call, await f.runner.before(call, f.runner.status(f.runtime.sessionID).task), f.report());
  const p = await f.prepare(); assert.equal(p.evidence.snapshot.sources[0].content, text);
  const s = f.runner.status(f.runtime.sessionID);
  assert.equal(s.evidence.snapshot.sources, undefined); assert.ok(Buffer.byteLength(JSON.stringify(s)) < 46000);
});

test('AL-03: parent semantic claims without an actual completed Apply cannot earn verified closure', async t => {
  const template = await applied(t), f = fixture(t); await f.admit();
  const handle = () => f.runner.status(f.runtime.sessionID).selection.handle;
  const p = await f.runner.prepareAdaptiveEvidenceInternal({ handle: handle() }, f.runtime);
  await f.runner.submitAdaptiveEvidenceInternal({ handle: handle(), evidence: template.evidence(p.evidence.snapshot) }, f.runtime);
  await assert.rejects(f.runner.closeAdaptiveInternal({ handle: handle(), outcome: 'verified' }, f.runtime), /evidence|acceptance/);
  assert.deepEqual(f.runner.status(f.runtime.sessionID).selection.completed, []);
});

test('AL-03: malformed disposition cannot erase a newly reported failed command attempt', async t => {
  const f = await applied(t, [{ id: 'C1', command: 'npm test', requirement: 'required' }]), p = await f.prepare(), e = f.evidence(p.evidence.snapshot);
  e.checks = [{ id: 'X1', command: 'npm test', exit: 0 }]; e.checkResults = [{ checkID: 'C1', disposition: 'passed', executions: ['X1'] }];
  await f.submit(e);
  const invalid = structuredClone(e); invalid.checks.push({ id: 'X2', command: 'npm test', exit: 1 });
  invalid.checkResults[0].executions.push('X2'); invalid.checkResults[0].reason = 'A later retry failed but the disposition was incorrectly passed.';
  await assert.rejects(f.submit(invalid), /final exit/);
  await assert.rejects(f.submit(e), /history|attempt/);
  invalid.checkResults[0].disposition = 'failed'; await f.submit(invalid);
  await assert.rejects(f.close(), /evidence|verified/);
});

const digest = text => createHash('sha256').update(text).digest('hex');
test('regression: adaptive prose has no length limit and survives receipts, evidence and a cold restore', async t => {
  const long = 'The replacement keeps the surrounding format exactly as the reviewer expects it. '.repeat(12).trim();
  assert.ok(long.length > 900);
  const f = fixture(t); f.options.adaptiveStore = new AdaptiveStore(f.root);
  Object.assign(f.contract.acceptance, { goal: `Replace the text. ${long}` });
  f.contract.assignments[0].description = `Replace the text.\n${long}`;
  f.contract.exclusions = [`Do not change other files. ${long}`];
  f.contract.context.reason = long;
  await f.admit();
  const held = f.options.adaptiveStore.read(f.runtime.sessionID).data.contract;
  assert.equal(held.assignments[0].description, `Replace the text. ${long}`, 'a line break folds into one space');
  assert.equal(held.acceptance.goal, `Replace the text. ${long}`);
  await f.select('mdd-apply', { purpose: `Perform only the next necessary bounded work. ${long} ${long}` });
  const args = await f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task);
  writeFileSync(join(f.root, 'own.txt'), 'after');
  const summary = `Assigned work settled.\n\n${long}`;
  // An artifact well past the old 12000-byte cap, with a terminal escape the fixed route also keeps.
  const artifact = `The assigned source was inspected.\n${'Line by line, the replacement keeps the format. \u001b[0m\n'.repeat(400)}`;
  assert.ok(Buffer.byteLength(artifact) > 12000);
  await f.runner.after(f.call, args, f.report({ evidenceSummary: summary, artifact }));
  const receipt = f.runner.status(f.runtime.sessionID).lastReceipt;
  assert.equal(receipt.outcome, 'passed', receipt.failure);
  assert.equal(receipt.summary.length, 500, 'a status shows a long summary bounded');
  assert.ok(receipt.summary.endsWith('…'));
  assert.equal(f.options.adaptiveStore.read(f.runtime.sessionID).data.receipts[0].summary, summary, 'the receipt keeps the summary whole, paragraphs included');
  assert.equal(f.options.adaptiveStore.read(f.runtime.sessionID).data.receipts[0].artifact, artifact, 'the receipt keeps the artifact exactly');
  const handle = () => f.runner.status(f.runtime.sessionID).selection.handle;
  const prepared = await f.runner.prepareAdaptiveEvidenceInternal({ handle: handle() }, f.runtime);
  const limits = Array.from({ length: 9 }, (_, index) => `Limit ${index + 1}: ${long}`);
  await f.runner.submitAdaptiveEvidenceInternal({ handle: handle(), evidence: { snapshotID: prepared.evidence.snapshot.id,
    readback: { acceptance: held.acceptance, scope: held.scope, exclusions: held.exclusions, decisions: held.decisions },
    inventory: [{ path: 'own.txt', disposition: 'assignment', reason: long }],
    exclusions: [{ exclusion: held.exclusions[0], status: 'verified', assessment: long }],
    sources: [{ id: 'E1', paths: ['own.txt'], status: 'verified', assessment: long }],
    assignments: [{ assignmentID: 'A1', status: 'verified', sources: ['E1'], checks: [], assessment: long }],
    scenarios: [{ requirementID: 'R1', scenarioID: 'S1', assignmentID: 'A1', status: 'verified', sources: ['E1'], checks: [], assessment: long }],
    decisions: [], checks: [], checkResults: [], supplementalChecks: [], limits } }, f.runtime);
  const cold = new PhaseRunner(f.inspect, f.options);
  assert.equal((await cold.restore(f.runtime)).restored, true);
  assert.equal(cold.status(f.runtime.sessionID).lastReceipt.outcome, 'passed');
  const closed = await cold.closeAdaptiveInternal({ handle: cold.status(f.runtime.sessionID).selection.handle, outcome: 'verified' }, f.runtime);
  assert.equal(closed.completion.outcome, 'verified');
  assert.equal(closed.completion.limits.length, 9, 'every evidence limit is kept');
  assert.deepEqual(closed.evidence.report.limits, limits, 'the evidence readback keeps every limit whole');
  assert.ok(Buffer.byteLength(JSON.stringify(cold.status(f.runtime.sessionID))) < 46000);
  assert.equal(f.options.adaptiveStore.read(f.runtime.sessionID).data.receipts[0].artifact, artifact, 'a cold restore keeps the artifact exactly');
});

test('regression: a report too large for the lane record becomes a failed receipt, never a stuck lane', async t => {
  const f = fixture(t); f.options.adaptiveStore = new AdaptiveStore(f.root);
  await f.admit(); await f.select();
  const args = await f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task);
  writeFileSync(join(f.root, 'own.txt'), 'after');
  await f.runner.after(f.call, args, f.report({ artifact: 'x'.repeat(9 * 1024 * 1024) }));
  const status = f.runner.status(f.runtime.sessionID);
  assert.equal(status.state, 'await-selection', 'the stopped child is recorded and the lane moves on');
  assert.equal(status.lastReceipt.outcome, 'failed');
  assert.match(status.lastReceipt.failure, /past its 8 MiB budget/);
  const held = f.options.adaptiveStore.read(f.runtime.sessionID);
  assert.equal(held.data.receipts[0].outcome, 'failed');
  assert.equal(held.data.receipts[0].artifact, undefined, 'nothing of the oversized report is kept partially');
  assert.equal(held.attempt.state, 'settled');
  const cold = new PhaseRunner(f.inspect, f.options);
  assert.equal((await cold.restore(f.runtime)).restored, true);
});

test('AL-04a: cold restore retains changed Apply output without duplicating the completed assignment', async t => {
  const f = await applied(t, [], true), oldHandle = f.handle();
  const cold = new PhaseRunner(f.inspect, f.options);
  assert.equal((await cold.restore(f.runtime)).restored, true);
  const restored = cold.status(f.runtime.sessionID);
  assert.deepEqual(restored.selection.completed, ['A1']);
  assert.notEqual(restored.selection.handle, oldHandle);
  assert.equal(restored.task, undefined);
  await assert.rejects(cold.selectAdaptiveInternal({ handle: restored.selection.handle, actor: 'mdd-apply',
    assignmentID: 'A1', purpose: 'Do not duplicate completed work.' }, f.runtime), /repair|completed/);
  assert.equal(readFileSync(join(f.root, 'own.txt'), 'utf8'), 'after');
});

test('AL-04a: a never-started selected actor restores actorlessly without its dispatch token', async t => {
  const f = fixture(t); f.options.adaptiveStore = new AdaptiveStore(f.root); await f.admit(); await f.select();
  const old = f.runner.status(f.runtime.sessionID).task;
  const cold = new PhaseRunner(f.inspect, f.options);
  assert.equal((await cold.restore(f.runtime)).restored, true);
  assert.equal(cold.status(f.runtime.sessionID).state, 'await-selection');
  assert.equal(cold.status(f.runtime.sessionID).task, undefined);
  await assert.rejects(cold.before(f.call, old), /ready|select|handle|dispatch/);
});

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mdd-adaptive-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'own.txt'), 'before');
  writeFileSync(join(root, 'other.txt'), 'outside');
  const runtime = { sessionID: 'adaptive-parent', agent: 'mdd-orchestrator', directory: root, worktree: root };
  const scope = { complete: true, reads: ['own.txt'], writes: ['own.txt'] };
  const contract = {
    contractVersion: 1, objective: 'Replace the bounded text.',
    acceptance: { goal: 'Replace the text', requirements: [{ id: 'R1', description: 'Bounded replacement',
      scenarios: [{ id: 'S1', given: 'Original text', when: 'Replaced', then: 'Updated text' }] }] },
    exclusions: ['Do not change other files'], decisions: [], productQuestions: [], scope,
    context: { technical: 'understood', dependencies: 'bounded', reason: 'The single source and its dependencies were inspected.',
      fingerprints: [{ path: 'own.txt', digest: digest('before') }] },
    assessment: { assessmentVersion: 1, complexity: 'low', impact: 'low' },
    assignments: [{ id: 'A1', description: 'Replace the text', path: 'own.txt', scenarios: ['S1'], decisions: [],
      dependsOn: [], scope, obligations: { source: [{ id: 'E1', description: 'Read back the replacement', paths: ['own.txt'] }], checks: [] } }],
  };
  const progress = new ProgressGuard(root), ownership = new RunOwnershipStore(root), checkpoint = new CheckpointStore(root);
  const inspections = [];
  const inspect = { parent: async () => {}, intake: async (_runtime, text, messageID) => {
    inspections.push({ text, messageID });
    if (text !== 'Replace the bounded text.' || messageID !== 'native-message') throw new Error('No exact native objective proof.');
    return 'genuine-user';
  }, result: async (_runtime, _call, _actor, output) => output, stopped: async () => true, ...overrides };
  const options = { progress, ownership, checkpoint,
    workerCapability: { phase: 'mdd-explore', readOnly: true, applyEditing: true } };
  const runner = new PhaseRunner(inspect, options);
  const settings = defaultSettings(); settings.profiles.default.answers.mode = 'automatic';
  const intake = new NativeIntake(runner, inspect, settings);
  const admit = () => intake.admitAdaptiveInternal({ contract }, runtime, 'native-message');
  const select = (actor = 'mdd-apply', extra = {}) => runner.selectAdaptiveInternal({
    handle: runner.status(runtime.sessionID).selection.handle, actor, assignmentID: 'A1',
    purpose: 'Perform only the next necessary bounded work.', ...extra,
  }, runtime);
  const call = { sessionID: runtime.sessionID, callID: 'adaptive-call' };
  const report = (extra = {}) => JSON.stringify({ outcome: 'passed', evidenceSummary: 'Assigned work settled.',
    artifact: 'The assigned source was inspected.', completed: ['A1'], changes: ['own.txt'], checks: [], ...extra });
  return { root, runtime, contract, runner, intake, inspect, options, progress, ownership, checkpoint, inspections, settings, admit, select, call, report };
}

test('AL05a: actual actor questions survive settlement and pause selection without changing admission', async t => {
  const f = fixture(t); f.options.adaptiveStore = new AdaptiveStore(f.root);
  await f.admit(); await f.select('mdd-explore');
  const args = await f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task);
  const questions = [{ question: 'Which bounded replacement?', why: 'The existing authorization leaves a choice.', options: [{ label: 'Keep format', description: 'Preserve the current format.' }] }];
  await f.runner.after(f.call, args, JSON.stringify({ outcome: 'passed', evidenceSummary: 'Found a product decision.', artifact: 'Inspected the declared source.', questions }));
  const saved = f.options.adaptiveStore.read(f.runtime.sessionID);
  assert.deepEqual(saved.data.receipts[0].questions, questions);
  assert.equal(saved.data.receipts[0].callID, f.call.callID);
  assert.deepEqual(saved.data.contract, f.contract);
  await assert.rejects(f.select(), /question|ambiguity/);
  const cold = new PhaseRunner(f.inspect, f.options); assert.equal((await cold.restore(f.runtime)).restored, true);
  await assert.rejects(cold.selectAdaptiveInternal({ handle: cold.status(f.runtime.sessionID).selection.handle, actor: 'mdd-apply', assignmentID: 'A1', purpose: 'Ignore pending decision.' }, f.runtime), /question|ambiguity/);
});

function nativeHistory(f, verdict) {
  const parent = { id: f.runtime.sessionID, directory: f.root, projectID: 'project', agent: 'mdd-orchestrator' };
  const child = { id: 'bound-native-child', parentID: parent.id, directory: f.root, projectID: 'project', agent: 'general' };
  const current = { info: { id: 'native-message', sessionID: parent.id, role: 'assistant', agent: parent.agent,
    path: { cwd: f.root, root: f.root } }, parts: [] };
  const history = [{ info: { id: 'genuine-user', sessionID: parent.id, role: 'user' },
    parts: [{ type: 'text', text: f.contract.objective, sessionID: parent.id, messageID: 'genuine-user' }] }, current];
  const terminal = { info: { id: 'child-message', sessionID: child.id, role: 'assistant', time: { completed: 1 }, finish: 'stop' }, parts: [] };
  const input = { directory: f.root, worktree: f.root, project: { id: 'project' }, client: { session: {
    get: async ({ path }) => ({ data: path.id === child.id ? child : parent }),
    messages: async ({ path }) => ({ data: path.id === child.id ? [terminal] : history }),
    status: async () => ({ data: { [child.id]: { type: verdict === 'running' ? 'busy' : verdict === 'stopped' ? 'idle' : 'unknown' } } }),
    abort: async () => ({ data: true }), // Request acknowledgment does not establish termination.
  } } };
  return { inspector: createInspector(input), dispatch(args) {
    current.parts.push({ type: 'tool', tool: 'task', sessionID: parent.id, messageID: current.info.id, callID: f.call.callID,
      state: { status: 'running', input: args, metadata: { sessionId: child.id } } });
  }, stopped() { verdict = 'stopped'; current.parts[0].state.status = 'error'; } };
}

async function selectedDependency(t) {
  const f = fixture(t);
  writeFileSync(join(f.root, 'support.txt'), 'eligibility source'); writeFileSync(join(f.root, 'later.txt'), 'unrelated source');
  f.contract.scope = { complete: true, reads: ['own.txt', 'other.txt', 'support.txt', 'later.txt'], writes: ['own.txt', 'other.txt', 'later.txt'] };
  f.contract.assignments[0].scope = { complete: true, reads: ['own.txt', 'support.txt'], writes: ['own.txt'] };
  for (const [id, path, dependsOn] of [['A2', 'other.txt', ['A1']], ['A3', 'later.txt', []]])
    f.contract.assignments.push({ id, description: 'Bounded follow-up', path, scenarios: ['S1'], decisions: [], dependsOn,
      scope: { complete: true, reads: [path], writes: [path] }, obligations: { source: [{ id: `E-${id}`, description: 'Read back the target', paths: [path] }], checks: [] } });
  f.contract.context.fingerprints = f.contract.scope.reads.map(path => ({ path, digest: digest(readFileSync(join(f.root, path))) }));
  await f.admit(); await f.select(); const args = await f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task);
  const fence = new WorkerFence(f.root, 'project');
  fence.admit(f.runtime.sessionID, 'native-message', f.call.callID, f.runner.workerAssignment(f.call), () => !!f.runner.workerAssignment(f.call));
  fence.progress({ sessionID: f.runtime.sessionID, assistantMessageID: 'native-message', id: f.call.callID,
    metadata: { status: 'running', sessionID: 'prerequisite-child' } });
  await fence.edit({ id: 'prerequisite-child', parentID: f.runtime.sessionID, projectID: 'project', location: { directory: f.root } },
    { operations: [{ kind: 'replace', path: 'own.txt', expected: 'before', content: 'after' }] });
  await f.runner.after(f.call, args, f.report());
  const context = { ...f.contract.context, fingerprints: f.contract.scope.reads.map(path => ({ path, digest: digest(readFileSync(join(f.root, path))) })) };
  await f.select('mdd-apply', { assignmentID: 'A2', context });
  return { ...f, nextCall: { ...f.call, callID: 'dependent-call' }, task: f.runner.status(f.runtime.sessionID).task };
}

test('AL-02: Apply-only uses an exact native handle and returns actorless selection, never Plan or Verify', async t => {
  const f = fixture(t); const admitted = await f.admit();
  assert.equal(admitted.state, 'await-selection');
  for (const key of ['phase', 'workflow', 'resultFormat', 'task']) assert.equal(admitted[key], undefined);
  await f.select(); const ready = f.runner.status(f.runtime.sessionID);
  const args = await f.runner.before(f.call, ready.task);
  assert.match(args.prompt, /mdd_worker_edit/);
  assert.equal(f.progress.read(f.runtime.sessionID).resumable, false);
  assert.equal(f.checkpoint.read(f.runtime.sessionID), undefined);
  assert.equal(f.runner.workerAssignment(f.call).phase, 'mdd-apply');
  await f.runner.after(f.call, args, f.report());
  const settled = f.runner.status(f.runtime.sessionID);
  assert.equal(settled.state, 'await-selection'); assert.equal(settled.task, undefined);
  assert.deepEqual(settled.selection.completed, ['A1']);
  assert.equal(settled.lastReceipt.actor, 'mdd-apply'); assert.equal(settled.lastReceipt.outcome, 'passed');
  for (const key of ['phase', 'workflow', 'resultFormat', 'visual']) assert.equal(settled[key], undefined);
});

test('AL-02: Explore resolves technical context before Apply without a Plan receipt', async t => {
  const f = fixture(t); f.contract.context.technical = 'uncertain';
  await f.admit(); await assert.rejects(f.select(), /technical/);
  await f.select('mdd-explore');
  const args = await f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task);
  await f.runner.after(f.call, args, JSON.stringify({ outcome: 'passed', evidenceSummary: 'Source understood.', artifact: 'own.txt has no indirect readers.' }));
  assert.equal(f.runner.status(f.runtime.sessionID).lastReceipt.actor, 'mdd-explore');
  await f.select('mdd-apply', { context: f.contract.context = { ...f.contract.context, technical: 'understood' } });
  const applyCall = { ...f.call, callID: 'apply-after-explore' };
  await f.runner.after(applyCall, await f.runner.before(applyCall, f.runner.status(f.runtime.sessionID).task), f.report());
  assert.deepEqual(f.runner.status(f.runtime.sessionID).selection.completed, ['A1']);
});

for (const change of [
  contract => { contract.contractVersion = 2; },
  contract => { contract.acceptance.requirements[0].scenarios[0].id = 'R1'; },
  contract => { contract.assignments.push(structuredClone(contract.assignments[0])); },
  contract => { contract.assessment.assessmentVersion = 2; },
  contract => { contract.context.technical = ['uncertain']; },
  contract => { contract.context.dependencies = ['bounded']; },
  contract => { contract.assignments[0].scope.writes = ['other.txt']; },
  contract => { contract.assignments[0].dependsOn = ['missing']; },
  contract => { contract.context.fingerprints[0].digest = digest('stale'); },
]) test(`AL-02: invalid contract ${change.toString()} creates no authority`, async t => {
  const f = fixture(t); change(f.contract);
  await assert.rejects(f.admit());
  assert.equal(f.runner.status(f.runtime.sessionID).state, 'not-started');
  assert.equal(f.ownership.parent(f.runtime.sessionID), undefined);
});

test('AL-02: native proof rejects invented text, supplied approval and provenance IDs', async t => {
  const f = fixture(t); f.contract.objective = 'Invented objective';
  await assert.rejects(f.admit(), /native objective/);
  await assert.rejects(f.intake.admitAdaptiveInternal({ contract: f.contract, approved: true, userMessageID: 'genuine-user' }, f.runtime, 'native-message'), /unknown/);
  await assert.rejects(f.runner.admitAdaptiveInternal({ contract: f.contract, messageID: 'native-message' }, f.runtime), /native objective/);
});

test('AL-02: admission and selection snapshot caller-owned objects across native inspection', async t => {
  const f = fixture(t); let release;
  f.inspect.intake = async () => { await new Promise(resolve => { release = resolve; }); return 'genuine-user'; };
  const pending = f.runner.admitAdaptiveInternal({ contract: f.contract, messageID: 'native-message' }, f.runtime);
  while (!release) await Promise.resolve();
  f.contract.assignments[0].scope.writes.push('other.txt'); release(); await pending;
  await f.select(); const args = await f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task);
  assert.deepEqual(f.runner.workerAssignment(f.call).scope.writes, ['own.txt']);
  assert.ok(!args.prompt.includes('other.txt'));
});

test('AL-02: product ambiguity pauses all actors; tiny high-impact work cannot Apply', async t => {
  const f = fixture(t); f.contract.productQuestions = ['Which behavior should replace the text?'];
  await f.admit(); await assert.rejects(f.select('mdd-explore'), /product/);
  assert.equal(f.runner.status(f.runtime.sessionID).selection.blocked, 'product-ambiguity');
  const g = fixture(t); g.runtime.sessionID = 'high-impact'; g.contract.assessment.impact = 'high';
  await g.admit(); await assert.rejects(g.select(), /impact/);
});

test('AL-02: stale context, unknown dependencies and premature prerequisites refuse Apply', async t => {
  const f = fixture(t); await f.admit(); writeFileSync(join(f.root, 'own.txt'), 'drift');
  await assert.rejects(f.select(), /fingerprint|stale/);
  const g = fixture(t); g.contract.context.dependencies = 'unknown'; await g.admit(); await assert.rejects(g.select(), /dependencies/);
  const h = fixture(t); const second = structuredClone(h.contract.assignments[0]); second.id = 'A2'; second.dependsOn = ['A1']; second.obligations.source[0].id = 'E2';
  h.contract.assignments.push(second); await h.admit(); await assert.rejects(h.select('mdd-apply', { assignmentID: 'A2' }), /prerequisites|dependencies/);
});

test('AL-02: raced selection/admission and replayed dispatch handles cannot create another writer', async t => {
  const f = fixture(t); const admissions = await Promise.allSettled([f.admit(), f.admit()]);
  assert.equal(admissions.filter(item => item.status === 'fulfilled').length, 1);
  const handle = f.runner.status(f.runtime.sessionID).selection.handle;
  const choices = await Promise.allSettled([f.select(), f.select()]);
  assert.equal(choices.filter(item => item.status === 'fulfilled').length, 1);
  const task = f.runner.status(f.runtime.sessionID).task;
  const args = await f.runner.before(f.call, task);
  await assert.rejects(f.runner.before({ ...f.call, callID: 'concurrent' }, task), /in flight|ready/);
  await f.runner.after(f.call, args, f.report({ outcome: 'failed', completed: [] }));
  await assert.rejects(f.select('mdd-apply', { handle }), /handle/);
  await assert.rejects(f.runner.before({ ...f.call, callID: 'replay' }, task), /ready|selection/);
  await assert.rejects(f.runner.after(f.call, args, f.report()), /dispatch/);
  await assert.rejects(f.select(), /repair/);
  await f.select('mdd-apply', { repairOf: f.runner.status(f.runtime.sessionID).lastReceipt.id });
  await assert.rejects(f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task), /consumed/);
});

test('AL-02: failed/malformed receipts return selection without progress or automatic writer retries', async t => {
  for (const output of ['unparseable receipt', JSON.stringify({ outcome: 'passed', evidenceSummary: 'Invalid broadening', artifact: 'Wrong', acceptance: {} }),
    JSON.stringify({ outcome: 'passed', evidenceSummary: 'Wrong completion', artifact: 'Wrong', completed: ['A2'], changes: ['own.txt'], checks: [] }),
    JSON.stringify({ outcome: 'passed', evidenceSummary: 'Invented checks', artifact: 'Wrong', completed: ['A1'], changes: ['own.txt'], checks: [{ id: 'X', command: 'npm test', exit: 0 }] })]) {
    const f = fixture(t); await f.admit(); await f.select();
    await f.runner.after(f.call, await f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task), output);
    const status = f.runner.status(f.runtime.sessionID);
    assert.equal(status.state, 'await-selection'); assert.equal(status.lastReceipt.outcome, 'failed');
    assert.deepEqual(status.selection.completed, []); assert.equal(status.task, undefined);
  }
});

test('AL-02: report receipt cannot release a child with unknown termination', async t => {
  const f = fixture(t, { stopped: async () => false }); await f.admit(); await f.select();
  const args = await f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task);
  await assert.rejects(f.runner.after(f.call, args, f.report()), /termination|stopped/);
  assert.equal(f.runner.status(f.runtime.sessionID).state, 'await-result');
  assert.equal(f.progress.read(f.runtime.sessionID).state, 'pending');
  assert.deepEqual(f.runner.status(f.runtime.sessionID).selection.completed, []);
  await assert.rejects(f.select(), /selection|in flight/);
});

test('AL-02: real native scoped edit succeeds; generic editor, shell and broadened writes remain fenced', async t => {
  const f = fixture(t); await f.admit(); await f.select(); await f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task);
  const fence = new WorkerFence(f.root, 'project');
  fence.admit(f.runtime.sessionID, 'native-message', f.call.callID, f.runner.workerAssignment(f.call), () => !!f.runner.workerAssignment(f.call));
  fence.progress({ sessionID: f.runtime.sessionID, assistantMessageID: 'native-message', id: f.call.callID, metadata: { status: 'running', sessionID: 'apply-child' } });
  const child = { id: 'apply-child', parentID: f.runtime.sessionID, projectID: 'project', location: { directory: f.root } };
  for (const tool of ['edit', 'shell']) await assert.rejects(fence.guard(child, tool, {}, f.runner.scopedWorkers(f.runtime.sessionID)));
  await assert.rejects(fence.edit(child, { operations: [{ kind: 'replace', path: 'other.txt', expected: 'outside', content: 'bad' }] }), /writes/);
  await fence.edit(child, { operations: [{ kind: 'replace', path: 'own.txt', expected: 'before', content: 'after' }] });
  assert.equal(readFileSync(join(f.root, 'own.txt'), 'utf8'), 'after');
  assert.equal(readFileSync(join(f.root, 'other.txt'), 'utf8'), 'outside');
});

test('AL-02: no synthetic capability or unsafe config footprint gets an unfenced serial fallback', async t => {
  const f = fixture(t); f.options.workerCapability = { confined: true };
  await assert.rejects(f.admit(), /capability|scoped/);
  const g = fixture(t); writeFileSync(join(g.root, 'package.json'), '{}');
  g.contract.scope.writes = ['package.json']; g.contract.assignments[0].path = 'package.json';
  g.contract.assignments[0].obligations.source[0].paths = ['package.json'];
  g.contract.context.fingerprints.push({ path: 'package.json', digest: digest('{}') });
  await assert.rejects(g.admit(), /scope|runtime|instruction/);
});

test('AL-02: restart preserves pending non-resumable child protection but never replays the contract', async t => {
  const f = fixture(t); await f.admit(); await f.select(); await f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task);
  const cold = new PhaseRunner(f.inspect, f.options);
  assert.equal((await cold.restore(f.runtime)).restored, false);
  assert.equal(cold.status(f.runtime.sessionID).state, 'recovery-blocked');
  assert.equal(cold.scopedWorkers(f.runtime.sessionID), true, 'lost adaptive authority must still quarantine the old native child');
  const fence = new WorkerFence(f.root, 'project', 1);
  const child = { id: 'lost-child', parentID: f.runtime.sessionID, projectID: 'project', location: { directory: f.root } };
  await assert.rejects(fence.guard(child, 'edit', {}, cold.scopedWorkers(f.runtime.sessionID)), /binding/);
  await assert.rejects(cold.admitAdaptiveInternal({ contract: f.contract, messageID: 'native-message' }, f.runtime), /pending|previous|occup|unfinished/);
  await cold.withReset(f.runtime.sessionID, async resetID => {
    assert.equal((await cold.confirmStopped(f.runtime.sessionID, f.runtime, false, resetID)).verdict, 'stopped');
    cold.reset(f.runtime.sessionID, 'run');
  }, true);
  assert.equal(cold.status(f.runtime.sessionID).state, 'not-started');
  assert.equal(f.checkpoint.read(f.runtime.sessionID), undefined);
  await assert.rejects(fence.guard(child, 'shell', {}, cold.scopedWorkers(f.runtime.sessionID)), /binding/);
});

test('AL-02: a stopped native transport failure records honest failure and requires selected repair', async t => {
  const f = fixture(t); await f.admit(); await f.select();
  await f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task);
  await f.runner.nativeError(f.runtime.sessionID, 'unrelated');
  assert.equal(f.runner.status(f.runtime.sessionID).state, 'await-result');
  await f.runner.nativeError(f.runtime.sessionID, f.call.callID);
  const status = f.runner.status(f.runtime.sessionID);
  assert.equal(status.state, 'await-selection'); assert.equal(status.lastReceipt.outcome, 'failed');
  assert.deepEqual(status.selection.completed, []); assert.equal(status.task, undefined);
  await assert.rejects(f.select(), /repair/);
});

test('AL-02: post-selection drift and lost ownership never admit a writer', async t => {
  const f = fixture(t); await f.admit(); await f.select();
  const task = f.runner.status(f.runtime.sessionID).task;
  writeFileSync(join(f.root, 'own.txt'), 'changed after selection');
  await assert.rejects(f.runner.before(f.call, task), /stale/);
  assert.equal(f.progress.read(f.runtime.sessionID), undefined);
  assert.equal(f.runner.status(f.runtime.sessionID).lastReceipt, undefined, 'no actor actually ran');
  const g = fixture(t); await g.admit(); await g.select();
  const issued = g.runner.status(g.runtime.sessionID).task;
  const owner = g.runner.owner(g.runtime.sessionID);
  g.ownership.reserve(owner.runID, g.runtime.sessionID, 'other-process', owner.epoch);
  assert.throws(() => g.runner.status(g.runtime.sessionID), /ownership/);
  await assert.rejects(g.runner.before(g.call, issued), /ownership/);
});

test('AL-02: Risk uses independent future assessment and retains real command obligations without execution claims', async t => {
  const f = fixture(t); f.contract.assignments[0].obligations.checks = [{ id: 'C1', command: 'npm test', requirement: 'required' }];
  await f.admit(); await f.select('mdd-risk');
  const args = await f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task);
  assert.match(args.prompt, /assessmentVersion/); assert.match(args.prompt, /NOT a historical Risk verdict/);
  assert.match(args.prompt, /"command":"npm test","requirement":"required"/);
  await f.runner.after(f.call, args, JSON.stringify({ outcome: 'passed', evidenceSummary: 'Impact exceeds low.', artifact: 'External readers were found.',
    assessment: { assessmentVersion: 1, complexity: 'low', impact: 'high' } }));
  assert.equal(f.runner.status(f.runtime.sessionID).lastReceipt.outcome, 'passed');
  await assert.rejects(f.select(), /impact/);
});

test('AL-02: genuine multiline objective text is preserved exactly through both native proof checks', async t => {
  const f = fixture(t); const objective = '  Replace the bounded text.\nPreserve the surrounding content.  ';
  f.contract.objective = objective;
  f.inspect.intake = async (_runtime, text, messageID) => {
    assert.equal(text, objective); assert.equal(messageID, 'native-message'); f.inspections.push(text); return 'genuine-user';
  };
  await f.admit(); await f.select();
  assert.equal(f.inspections.length, 2);
  const args = await f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task);
  assert.equal(JSON.parse(args.prompt.split('Contract-authored links (no Plan actor is implied): ')[1].split('\n')[0]).objective, objective);
});

test('AL-02: interactive and unspecified native profiles cannot admit a valid internal contract', async t => {
  for (const mode of ['interactive', undefined]) {
    const f = fixture(t); const settings = defaultSettings();
    if (mode) settings.profiles.default.answers.mode = mode;
    const intake = new NativeIntake(f.runner, f.inspect, settings);
    await assert.rejects(intake.admitAdaptiveInternal({ contract: f.contract }, f.runtime, 'native-message'), /automatic|interactive/);
    assert.equal(f.inspections.length, 0); assert.equal(f.ownership.parent(f.runtime.sessionID), undefined);
  }
});

test('AL-02: uncertain native termination retains the writer through errors and explicit probes', async t => {
  const f = fixture(t, { stopped: async () => false }); await f.admit(); await f.select();
  await f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task);
  await f.runner.nativeError(f.runtime.sessionID, f.call.callID);
  assert.equal((await f.runner.probe(f.runtime.sessionID)).verdict, 'unknown');
  assert.equal((await f.runner.confirmStopped(f.runtime.sessionID, f.runtime, true)).verdict, 'unknown');
  assert.equal(f.runner.status(f.runtime.sessionID).state, 'await-result');
  f.inspect.stopped = async () => true;
  assert.equal((await f.runner.confirmStopped(f.runtime.sessionID, f.runtime)).verdict, 'stopped');
  const status = f.runner.status(f.runtime.sessionID);
  assert.equal(status.state, 'await-selection'); assert.equal(status.lastReceipt.outcome, 'failed');
  assert.equal(status.task, undefined); assert.deepEqual(status.selection.completed, []);
});

test('AL-02: optional Plan and Verify are fenced source readers, not fabricated planning or completion', async t => {
  const f = fixture(t); await f.admit();
  for (const actor of ['mdd-plan', 'mdd-verify']) {
    await f.select(actor); const call = { ...f.call, callID: actor };
    const args = await f.runner.before(call, f.runner.status(f.runtime.sessionID).task);
    const assigned = f.runner.workerAssignment(call);
    assert.equal(assigned.phase, 'mdd-explore'); assert.equal(assigned.scope, undefined);
    assert.deepEqual(assigned.reads, [{ root: f.root, files: ['own.txt'] }]);
    await f.runner.after(call, args, JSON.stringify({ outcome: 'passed', evidenceSummary: 'Only source findings.', artifact: 'own.txt was inspected.' }));
    const status = f.runner.status(f.runtime.sessionID);
    assert.equal(status.lastReceipt.actor, actor); assert.equal(status.state, 'await-selection');
    assert.equal(status.workflow, undefined); assert.deepEqual(status.selection.completed, []);
  }
});

test('AL-02: duplicate evidence IDs and credential read footprints are refused without authority', async t => {
  const f = fixture(t); f.contract.assignments[0].obligations.checks = [{ id: 'E1', command: 'npm test', requirement: 'required' }];
  await assert.rejects(f.admit(), /more than once/);
  const g = fixture(t); writeFileSync(join(g.root, 'credentials.txt'), 'private');
  g.contract.scope.reads.push('credentials.txt'); g.contract.context.fingerprints.push({ path: 'credentials.txt', digest: digest('private') });
  await assert.rejects(g.admit(), /Credential/);
  assert.equal(g.ownership.parent(g.runtime.sessionID), undefined);
});

test('AL-02: positive running liveness outranks a receipt and a synthetic stopped flag', async t => {
  const f = fixture(t, { liveness: async () => ({ verdict: 'running', detail: 'The bound child is busy.' }) });
  await f.admit(); await f.select(); const args = await f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task);
  await assert.rejects(f.runner.after(f.call, args, f.report()), /termination/);
  assert.equal(f.runner.status(f.runtime.sessionID).state, 'await-result');
  assert.equal(f.progress.read(f.runtime.sessionID).state, 'pending');
  assert.equal(f.runner.owner(f.runtime.sessionID).state, 'reserved');
});

for (const verdict of ['unknown', 'running']) test(`AL-02 correction P1: cold ${verdict} native termination cannot be released by attestation`, async t => {
  const f = fixture(t), native = nativeHistory(f, verdict);
  const runner = new PhaseRunner(native.inspector, f.options), intake = new NativeIntake(runner, native.inspector, f.settings);
  await intake.admitAdaptiveInternal({ contract: f.contract }, f.runtime, 'native-message');
  await runner.selectAdaptiveInternal({ handle: runner.status(f.runtime.sessionID).selection.handle,
    actor: 'mdd-apply', assignmentID: 'A1', purpose: 'Bounded native work.' }, f.runtime);
  native.dispatch(await runner.before(f.call, runner.status(f.runtime.sessionID).task));
  const marker = f.progress.read(f.runtime.sessionID), owner = f.ownership.read(marker.runID);
  const cold = new PhaseRunner(native.inspector, f.options);
  assert.equal(await native.inspector.stopped(f.runtime, f.call), false);
  await cold.withReset(f.runtime.sessionID, async resetID => {
    assert.equal((await cold.confirmStopped(f.runtime.sessionID, f.runtime, true, resetID)).verdict, verdict);
  }, true);
  assert.deepEqual(f.ownership.read(marker.runID), owner, 'attestation must not release or rewrite the reserved native owner');
  assert.deepEqual(f.progress.read(f.runtime.sessionID), marker, 'unknown/running termination must preserve the exact pending marker');
  assert.equal(cold.scopedWorkers(f.runtime.sessionID), true);
  assert.equal(cold.status(f.runtime.sessionID).state, 'recovery-blocked');
  assert.equal(cold.workerAssignment(f.call), undefined, 'a cold marker is quarantine, never editing authority');
  native.stopped();
  assert.equal(await native.inspector.stopped(f.runtime, f.call), true);
  await cold.withReset(f.runtime.sessionID, async resetID => {
    assert.equal((await cold.confirmStopped(f.runtime.sessionID, f.runtime, false, resetID)).verdict, 'stopped');
  }, true);
  assert.equal(f.ownership.read(marker.runID).state, 'idle');
  assert.deepEqual(f.progress.read(f.runtime.sessionID), { ...marker, state: 'settled' });
  assert.equal(cold.scopedWorkers(f.runtime.sessionID), false);
  assert.equal(f.checkpoint.read(f.runtime.sessionID), undefined);
});

for (const path of ['own.txt', 'support.txt']) for (const timing of ['before-hook', 'during-inspection'])
  test(`AL-02 correction P2: dependent admission rejects ${path} drift ${timing}`, async t => {
    const f = await selectedDependency(t);
    const marker = f.progress.read(f.runtime.sessionID), owner = f.runner.owner(f.runtime.sessionID);
    let published = false;
    const drift = () => writeFileSync(join(f.root, path), 'changed after dependent selection');
    if (timing === 'before-hook') drift();
    else f.inspect.parent = async (_runtime, callID) => { if (callID === f.nextCall.callID) drift(); };
    await assert.rejects(f.runner.before(f.nextCall, f.task, () => { published = true; }), /prerequisite.*stale|fingerprint.*stale/);
    assert.equal(published, false, 'no native child arguments may be published');
    assert.equal(f.runner.workerAssignment(f.nextCall), undefined);
    assert.equal(f.runner.nativePending(f.runtime.sessionID), false);
    const after = f.ownership.read(owner.runID);
    assert.equal(after.state, 'idle'); assert.equal(after.callID, undefined);
    if (timing === 'before-hook') assert.deepEqual(after, owner, 'preexisting drift must be refused before reserving');
    assert.deepEqual(f.progress.read(f.runtime.sessionID), marker, 'the settled prerequisite marker must not become a dependent intent');
    const status = f.runner.status(f.runtime.sessionID);
    assert.equal(status.state, 'await-selection'); assert.equal(status.task, undefined);
    assert.equal(status.lastReceipt.actor, 'mdd-apply'); assert.equal(status.lastReceipt.assignmentID, 'A1');
    assert.deepEqual(status.selection.completed, ['A1']);
  });

test('AL-02 correction P2: unrelated future assignment drift does not invalidate the selected dependency', async t => {
  const f = await selectedDependency(t); writeFileSync(join(f.root, 'later.txt'), 'unrelated newer source');
  const args = await f.runner.before(f.nextCall, f.task);
  assert.equal(f.runner.workerAssignment(f.nextCall).taskID, 'A2');
  await f.runner.after(f.nextCall, args, f.report({ completed: ['A2'], changes: ['other.txt'] }));
  assert.deepEqual(f.runner.status(f.runtime.sessionID).selection.completed, ['A1', 'A2']);
});
