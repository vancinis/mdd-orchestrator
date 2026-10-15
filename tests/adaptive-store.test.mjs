import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdaptiveLow } from '../dist/adaptive-low.js';
import { AdaptiveStore } from '../dist/adaptive-store.js';
import { LocalFiles } from '../dist/local-files.js';
import { PhaseRunner } from '../dist/phase-runner.js';
import { NativeIntake } from '../dist/native-intake.js';
import { ProgressGuard } from '../dist/progress.js';
import { CheckpointStore } from '../dist/checkpoint.js';
import { RunOwnershipStore } from '../dist/run-ownership.js';
import { defaultSettings } from '../dist/settings.js';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), 'mdd-durable-adaptive-')), root = join(temp, 'source'), storage = join(temp, 'runtime');
  mkdirSync(root); mkdirSync(storage); t.after(() => rmSync(temp, { recursive: true, force: true }));
  for (const path of ['own.txt', 'dependent.txt', 'unrelated.txt', 'support.txt']) writeFileSync(join(root, path), `original ${path}`);
  const runtime = { sessionID: 'parent', agent: 'mdd-orchestrator', directory: root, worktree: root };
  const scope = { complete: true, reads: ['own.txt', 'support.txt'], writes: ['own.txt'] };
  const contract = { contractVersion: 1, objective: 'Replace the bounded source.',
    acceptance: { goal: 'Replace source', requirements: [{ id: 'R1', description: 'Bounded replacement', scenarios: [{ id: 'S1', given: 'Original source', when: 'Replaced', then: 'Updated source' }] }] },
    exclusions: [], decisions: [], productQuestions: [], scope,
    context: { technical: 'understood', dependencies: 'bounded', reason: 'Source and dependencies inspected.', fingerprints: scope.reads.map(path => ({ path, digest: hash(`original ${path}`) })) },
    assessment: { assessmentVersion: 1, complexity: 'low', impact: 'low' },
    assignments: [{ id: 'A1', path: 'own.txt', description: 'Replace source', scenarios: ['S1'], decisions: [], dependsOn: [], scope,
      obligations: { source: [{ id: 'E1', description: 'Read final source', paths: ['own.txt'] }], checks: [] } }] };
  const local = new LocalFiles(storage), fault = { mode: undefined, failRead: false, writes: 0 };
  const files = { readStrict(name, limit) { if (fault.failRead) { fault.failRead = false; throw new Error('injected readback'); } return local.readStrict(name, limit); },
    updateStrict(name, change, limit) {
      const mode = fault.mode; fault.mode = undefined; fault.writes++;
      if (mode === 'before') throw new Error('injected before write');
      local.updateStrict(name, change, limit);
      if (mode === 'after') throw new Error('injected after rename');
      if (mode === 'readback') fault.failRead = true;
    } };
  const store = new AdaptiveStore(storage, files), progress = new ProgressGuard(storage), ownership = new RunOwnershipStore(storage), checkpoint = new CheckpointStore(storage);
  let verdict = 'stopped', parentCalls = 0;
  const inspect = { parent: async () => { parentCalls++; }, intake: async (_runtime, text) => {
    assert.equal(text, contract.objective); return 'native-user';
  }, result: async (_runtime, _call, _actor, output) => output, stopped: async () => verdict === 'stopped',
  liveness: async (_runtime, call) => ({ verdict, child: `child-${call.callID}`, detail: 'Deterministic native harness.' }), abort: async () => {} };
  const options = { adaptiveStore: store, progress, ownership, checkpoint,
    workerCapability: { phase: 'mdd-explore', readOnly: true, applyEditing: true } };
  const runner = new PhaseRunner(inspect, options), settings = defaultSettings(); settings.profiles.default.answers.mode = 'automatic';
  const intake = new NativeIntake(runner, inspect, settings), call = { sessionID: runtime.sessionID, callID: 'apply-1' };
  const handle = (r = runner) => r.status(runtime.sessionID).selection.handle;
  const select = async (r = runner, extra = {}) => r.selectAdaptiveInternal({ handle: handle(r), actor: 'mdd-apply', assignmentID: 'A1', purpose: 'Perform bounded replacement.', ...extra }, runtime);
  const admit = () => intake.admitAdaptiveInternal({ contract }, runtime, 'native-message');
  const report = id => JSON.stringify({ outcome: 'passed', evidenceSummary: 'The assigned source was replaced.', artifact: 'Read back the bounded replacement.', completed: [id], changes: [contract.assignments.find(item => item.id === id).path], checks: [] });
  const apply = async (r = runner, id = 'A1', callID = 'apply-1') => {
    await select(r, { assignmentID: id, ...(id !== 'A1' ? { context: { ...contract.context, fingerprints: contract.context.fingerprints.map(item => ({ path: item.path, digest: hash(readFileSync(join(root, item.path), 'utf8')) })) } } : {}) });
    const actual = { ...call, callID }, args = await r.before(actual, r.status(runtime.sessionID).task);
    writeFileSync(join(root, contract.assignments.find(item => item.id === id).path), `updated ${id}`);
    await r.after(actual, args, report(id)); return args;
  };
  const prepare = (r = runner) => r.prepareAdaptiveEvidenceInternal({ handle: handle(r) }, runtime);
  const evidence = snapshot => ({ snapshotID: snapshot.id, readback: { acceptance: contract.acceptance, scope: contract.scope, exclusions: [], decisions: [] },
    inventory: [{ path: 'own.txt', disposition: 'assignment', reason: 'Actual source difference read back.' }], exclusions: [],
    sources: [{ id: 'E1', paths: ['own.txt'], status: 'verified', assessment: 'Source contains replacement.' }],
    assignments: [{ assignmentID: 'A1', status: 'verified', sources: ['E1'], checks: [], assessment: 'Replacement satisfies assignment.' }],
    scenarios: [{ requirementID: 'R1', scenarioID: 'S1', assignmentID: 'A1', status: 'verified', sources: ['E1'], checks: [], assessment: 'Replacement satisfies scenario.' }],
    decisions: [], checks: [], checkResults: [], supplementalChecks: [], limits: [] });
  const submit = (value, r = runner) => r.submitAdaptiveEvidenceInternal({ handle: handle(r), evidence: value }, runtime);
  const close = (r = runner) => r.closeAdaptiveInternal({ handle: handle(r), outcome: 'verified' }, runtime);
  const cold = () => new PhaseRunner(inspect, options);
  const rawPath = () => join(storage, '.mdd', readdirSync(join(storage, '.mdd')).find(name => /^adaptive-.*\.json$/.test(name)));
  const mutate = change => {
    const record = JSON.parse(readFileSync(rawPath(), 'utf8')); change(record);
    const { digest, ...body } = record; record.digest = hash(body); writeFileSync(rawPath(), JSON.stringify(record));
  };
  return { temp, root, storage, runtime, contract, runner, intake, inspect, options, store, local, progress, ownership, checkpoint,
    fault, call, handle, select, admit, apply, prepare, evidence, submit, close, cold, report, mutate, rawPath,
    verdict: value => { verdict = value; }, parentCalls: () => parentCalls };
}

test('AL-04a store: real intake/before/after journal writes only injected runtime storage and retains original admission', async t => {
  const f = fixture(t); await f.admit(); const admission = f.store.read('parent').data.contract;
  await f.apply(); const saved = f.store.read('parent');
  assert.deepEqual(saved.data.contract, admission); assert.equal(saved.data.completed[0].fingerprints[0].digest, hash('updated A1'));
  assert.equal(saved.attempt.state, 'settled'); assert.equal(saved.data.receipts[0].callID, f.call.callID);
  assert.deepEqual(readdirSync(f.root).sort(), ['dependent.txt', 'own.txt', 'support.txt', 'unrelated.txt']);
  assert.equal(saved.data.selection, undefined); assert.equal(JSON.stringify(saved).includes('mdd-dispatch:'), false);
  const cold = f.cold(); assert.equal((await cold.restore(f.runtime)).restored, true);
  assert.equal(f.parentCalls() > 0, true); assert.deepEqual(cold.status('parent').selection.completed, ['A1']);
});

test('AL-04a store: native parent identity and exact runtime are proven before cold publication', async t => {
  const f = fixture(t); await f.admit();
  const seq = f.store.read('parent').sequence, cold = f.cold();
  assert.equal((await cold.restore({ ...f.runtime, agent: 'general' })).restored, false);
  f.inspect.parent = async () => { throw new Error('native identity unavailable'); };
  assert.match((await cold.restore(f.runtime)).reason, /native identity/);
  assert.equal(f.store.read('parent').sequence, seq);
  assert.equal(cold.status('parent').task, undefined);
});

test('AL-04a store: settled restore fences old handles and stale process authority without duplicating Apply', async t => {
  const f = fixture(t); await f.admit(); const old = f.handle(), cold = f.cold();
  assert.equal((await cold.restore(f.runtime)).restored, true);
  await assert.rejects(f.select(), /stale|unconfirmed/);
  await assert.rejects(cold.selectAdaptiveInternal({ handle: old, actor: 'mdd-apply', assignmentID: 'A1', purpose: 'Replay old selection.' }, f.runtime), /handle/);
  await f.apply(cold); const again = f.cold(); assert.equal((await again.restore(f.runtime)).restored, true);
  await assert.rejects(f.select(again), /repair/); assert.deepEqual(again.status('parent').selection.completed, ['A1']);
});

for (const mutate of [
  record => { record.data.completed.push({ assignmentID: 'A1', fingerprints: record.data.contract.context.fingerprints }); },
  record => { record.data.context.technical = 'invented'; },
  record => { record.data.assessment.impact = 'high'; },
  record => { record.data.nativeApproval = true; },
  record => { record.data.state = 'completed'; record.data.completion = { outcome: 'verified', limits: [] }; },
  record => { record.data.contract.routingVersion = 3; record.admissionDigest = hash(record.data.contract); },
]) test(`AL-04a store: rehashed relational tamper refuses restoration ${mutate.toString()}`, async t => {
  const f = fixture(t); await f.admit(); f.mutate(mutate);
  const cold = f.cold(), result = await cold.restore(f.runtime);
  assert.equal(result.restored, false); assert.equal(cold.status('parent').task, undefined);
  await assert.rejects(cold.admitAdaptiveInternal({ contract: f.contract, messageID: 'native-message' }, f.runtime), /occup|unfinished/);
  assert.throws(() => cold.reset('parent', 'run'), /adaptive/i);
});

for (const version of [2, 99]) test(`AL-04a store: future version ${version} is occupancy, not absence`, async t => {
  const f = fixture(t); await f.admit(); f.mutate(record => { record.version = version; });
  assert.equal(f.store.occupied('parent'), true); assert.throws(() => f.store.read('parent'), /invalid|unsupported/i);
  const cold = f.cold(); assert.equal((await cold.restore(f.runtime)).restored, false);
  await assert.rejects(cold.start({}, f.runtime), /adaptive/i); assert.throws(() => cold.authorizeReset('parent', true), /adaptive/i);
  assert.throws(() => f.ownership.claimParent('parent', 'other-run'), /claim|occupied/i);
});

test('AL-04a store: unchanged closure survives cold restart and cannot reopen or supply native approval', async t => {
  const f = fixture(t); await f.admit(); await f.apply(); const p = await f.prepare(); await f.submit(f.evidence(p.evidence.snapshot)); await f.close();
  const cold = f.cold(); assert.equal((await cold.restore(f.runtime)).restored, true);
  assert.equal(cold.status('parent').state, 'completed'); assert.equal(cold.status('parent').approval, undefined);
  await assert.rejects(f.select(cold), /terminal|handle|completed/);
  f.mutate(record => { record.data.state = 'await-selection'; });
  assert.equal((await f.cold().restore(f.runtime)).restored, false);
});

test('AL-04a store: changed closed output invalidates verified proof without reopening execution', async t => {
  const f = fixture(t); await f.admit(); await f.apply(); const p = await f.prepare(); await f.submit(f.evidence(p.evidence.snapshot)); await f.close();
  writeFileSync(join(f.root, 'own.txt'), 'external drift'); const cold = f.cold();
  assert.equal((await cold.restore(f.runtime)).restored, true); assert.equal(cold.status('parent').state, 'closed-unverified');
  assert.equal(cold.status('parent').evidence.matched, false); await assert.rejects(f.select(cold), /handle|terminal|completed/);
});

for (const verdict of ['unknown', 'running', 'stopped']) test(`AL-04a store: cold pending ${verdict} requires exact native stopped proof before explicit recovery`, async t => {
  const f = fixture(t); await f.admit(); await f.select(); await f.runner.before(f.call, f.runner.status('parent').task);
  f.verdict(verdict); const cold = f.cold(); assert.equal((await cold.restore(f.runtime)).restored, false);
  assert.equal(cold.status('parent').task, undefined);
  await assert.rejects(cold.after(f.call, undefined, f.report('A1')), /replay|recovery/);
  const result = await cold.confirmStopped('parent', f.runtime, true, 'irrelevant-reset-id'); assert.equal(result.verdict, verdict);
  assert.equal(f.store.read('parent').attempt.state, verdict === 'stopped' ? 'settled' : 'pending');
  assert.equal(f.ownership.read(f.store.read('parent').runID).state, verdict === 'stopped' ? 'idle' : 'reserved');
  if (verdict !== 'stopped') {
    f.verdict('stopped'); await cold.recoverAdaptiveInternal(f.runtime);
  }
  assert.equal(cold.status('parent').lastReceipt.outcome, 'failed');
  assert.deepEqual(cold.status('parent').selection.completed, []);
  await assert.rejects(f.select(cold), /repair/);
});

for (const boundary of ['bootstrap', 'pending', 'settlement', 'selection']) for (const mode of ['before', 'after', 'readback'])
  test(`AL-04a store: ${mode} fault at ${boundary} keeps one durable writer and reconciles readback`, async t => {
    const f = fixture(t); let action, before, args;
    if (boundary === 'bootstrap') action = () => f.admit();
    else {
      await f.admit();
      if (boundary === 'selection') action = () => f.select();
      else {
        await f.select();
        if (boundary === 'pending') action = () => f.runner.before(f.call, f.runner.status('parent').task);
        else { args = await f.runner.before(f.call, f.runner.status('parent').task); action = () => f.runner.after(f.call, args, f.report('A1')); }
      }
      before = f.store.read('parent');
    }
    const oldHandle = boundary === 'selection' ? f.handle() : undefined;
    f.fault.mode = mode;
    if (mode === 'after') await action(); else await assert.rejects(action(), /write|publication|unconfirmed/);
    if (mode === 'before') {
      assert.deepEqual(f.store.read('parent'), before);
      if (boundary === 'selection') assert.equal(f.handle(), oldHandle);
      if (boundary === 'bootstrap') { assert.equal(f.ownership.parent('parent'), undefined); await f.admit(); }
      else if (boundary === 'settlement') { assert.equal(f.progress.read('parent').state, 'pending'); await action(); }
    }
    const saved = f.store.read('parent');
    if (saved) {
      const cold = f.cold(), result = await cold.restore(f.runtime);
      if (saved.attempt?.state === 'pending') {
        assert.equal(result.restored, false); await cold.recoverAdaptiveInternal(f.runtime);
      } else assert.equal(result.restored, true, result.reason);
      await assert.rejects(f.cold().start({}, f.runtime), /adaptive/i);
    }
  });

test('AL-04a store: accepted receipt is durable before settled marker and ownership release', async t => {
  const f = fixture(t); await f.admit(); await f.select(); const args = await f.runner.before(f.call, f.runner.status('parent').task);
  const write = f.progress.write.bind(f.progress); let fail = true;
  f.progress.write = (session, value) => {
    if (value.state === 'settled') {
      assert.equal(f.store.read(session).data.receipts.length, 1); assert.equal(f.store.read(session).attempt.state, 'settled');
      assert.equal(f.ownership.read(value.runID).state, 'reserved');
      if (fail) { fail = false; throw new Error('injected marker settlement failure'); }
    }
    write(session, value);
  };
  await assert.rejects(f.runner.after(f.call, args, f.report('A1')), /marker settlement/);
  const cold = f.cold(); assert.equal((await cold.restore(f.runtime)).restored, true);
  assert.equal(f.store.read('parent').data.receipts.length, 1); assert.equal(f.ownership.read(f.store.read('parent').runID).state, 'idle');
});

test('AL-04a store: source and dependent drift invalidate affected completion without refreshing stale admission context', async t => {
  const f = fixture(t), own = f.contract.assignments[0];
  f.contract.scope = { complete: true, reads: ['own.txt', 'support.txt', 'dependent.txt', 'unrelated.txt'], writes: ['own.txt', 'dependent.txt', 'unrelated.txt'] };
  for (const [id, path, dependsOn] of [['A2', 'dependent.txt', ['A1']], ['A3', 'unrelated.txt', []]])
    f.contract.assignments.push({ ...structuredClone(own), id, path, dependsOn, scope: { complete: true, reads: [path], writes: [path] }, obligations: { source: [{ id: `E-${id}`, description: 'Read final source', paths: [path] }], checks: [] } });
  f.contract.context.fingerprints = f.contract.scope.reads.map(path => ({ path, digest: hash(`original ${path}`) }));
  await f.admit(); await f.apply(); await f.apply(f.runner, 'A2', 'apply-2'); await f.apply(f.runner, 'A3', 'apply-3');
  const originalContext = f.store.read('parent').data.context;
  writeFileSync(join(f.root, 'support.txt'), 'stale eligibility source'); const cold = f.cold();
  assert.equal((await cold.restore(f.runtime)).restored, true);
  assert.deepEqual(cold.status('parent').selection.completed, ['A3']);
  assert.deepEqual(cold.status('parent').evidence.invalidatedAssignments, ['A1', 'A2']);
  assert.deepEqual(f.store.read('parent').data.context, originalContext);
  await assert.rejects(f.select(cold), /repair/);
});

test('AL-04a store: source-bound failed command history survives drift as historical evidence, not stale PASS', async t => {
  const f = fixture(t); f.contract.assignments[0].obligations.checks = [{ id: 'C1', command: 'npm test', requirement: 'required' }];
  await f.admit(); await f.apply(); const p = await f.prepare(), e = f.evidence(p.evidence.snapshot);
  e.checks = [{ id: 'X1', command: 'npm test', exit: 1 }]; e.checkResults = [{ checkID: 'C1', disposition: 'failed', executions: ['X1'], reason: 'The actual required command failed.' }];
  await f.submit(e); writeFileSync(join(f.root, 'support.txt'), 'drift'); const cold = f.cold();
  assert.equal((await cold.restore(f.runtime)).restored, true);
  const data = f.store.read('parent').data;
  assert.equal(data.matched, false); assert.equal(data.historicalChecks[0].checks[0].exit, 1);
  assert.equal(data.historicalChecks[0].snapshot.sources.find(item => item.path === 'support.txt').content, 'original support.txt');
  await assert.rejects(f.close(cold), /snapshot|evidence|verified/);
  f.mutate(record => { record.data.priorEvidence.report.checks[0].exit = 0; });
  assert.equal((await f.cold().restore(f.runtime)).restored, false);
});

test('AL-04a store: immutable admission CAS, oversized data and fake pins are refused without replacing bytes', async t => {
  const f = fixture(t); await f.admit(); const previous = f.store.read('parent'), changed = structuredClone(previous);
  changed.data.contract.objective = 'Changed authorization';
  const { version, sequence, digest, admissionDigest, ...body } = changed;
  assert.throws(() => f.store.commit('parent', previous, body), /immutable/);
  assert.deepEqual(f.store.read('parent'), previous);
  const data = structuredClone(previous.data); data.context.nativeApproved = true;
  assert.throws(() => AdaptiveLow.restore(data, f.root), /unknown/i);
  data.contract.objective = 'x'.repeat(9 * 1024 * 1024);
  assert.throws(() => AdaptiveLow.restore(data, f.root), /budget/);
});

test('AL-04a correction: cold pending publication fences the original process callback', async t => {
  const f = fixture(t); await f.admit(); await f.select();
  const args = await f.runner.before(f.call, f.runner.status('parent').task), sequence = f.store.read('parent').sequence;
  const cold = f.cold(); assert.equal((await cold.restore(f.runtime)).restored, false);
  assert.ok(f.store.read('parent').sequence > sequence);
  await assert.rejects(f.runner.after(f.call, args, f.report('A1')), /stale|unconfirmed/);
  assert.equal(f.store.read('parent').attempt.state, 'pending');
  await cold.recoverAdaptiveInternal(f.runtime);
  assert.equal(cold.status('parent').lastReceipt.outcome, 'failed');
});

test('AL-04a correction: second pending intent reconciles the prior settled marker after marker failure', async t => {
  const f = fixture(t); await f.admit(); await f.select();
  const args = await f.runner.before(f.call, f.runner.status('parent').task);
  await f.runner.after(f.call, args, '{}');
  await f.select(f.runner, { repairOf: f.runner.status('parent').lastReceipt.id });
  const write = f.progress.write.bind(f.progress);
  f.progress.write = (session, value) => { if (value.state === 'pending') throw new Error('injected pending marker'); write(session, value); };
  await assert.rejects(f.runner.before({ ...f.call, callID: 'apply-2' }, f.runner.status('parent').task), /pending marker/);
  f.progress.write = write;
  const cold = f.cold(), result = await cold.restore(f.runtime);
  assert.equal(result.restored, false); assert.match(result.reason, /quarantined/);
  assert.equal(f.progress.read('parent').callID, 'apply-2');
  await cold.recoverAdaptiveInternal(f.runtime);
  assert.equal(f.store.read('parent').data.receipts.length, 2);
});

test('AL-04a P1: dispatch prerequisite receipts cover transitive dependencies without restoring current proof', async t => {
  const f = fixture(t), own = f.contract.assignments[0];
  f.contract.scope = { complete: true, reads: ['own.txt', 'support.txt', 'dependent.txt', 'unrelated.txt'], writes: ['own.txt', 'dependent.txt', 'unrelated.txt'] };
  for (const [id, path, dependsOn] of [['A2', 'dependent.txt', ['A1']], ['A3', 'unrelated.txt', ['A2']]])
    f.contract.assignments.push({ ...structuredClone(own), id, path, dependsOn, scope: { complete: true, reads: [path], writes: [path] },
      obligations: { source: [{ id: `E-${id}`, description: 'Read assigned source', paths: [path] }], checks: [] } });
  f.contract.context.fingerprints = f.contract.scope.reads.map(path => ({ path, digest: hash(`original ${path}`) }));
  await f.admit(); await f.apply(); await f.apply(f.runner, 'A2', 'apply-2');
  const context = { ...f.contract.context, fingerprints: f.contract.context.fingerprints.map(item => ({ path: item.path, digest: hash(readFileSync(join(f.root, item.path), 'utf8')) })) };
  await f.select(f.runner, { assignmentID: 'A3', context });
  await f.runner.before({ ...f.call, callID: 'apply-3' }, f.runner.status('parent').task);
  const before = f.store.read('parent');
  assert.deepEqual(before.data.pending.dispatchPrerequisites, ['A2', 'A1'].map(assignmentID => ({ assignmentID,
    receiptID: before.data.receipts.find(receipt => receipt.assignmentID === assignmentID).id })));
  writeFileSync(join(f.root, 'support.txt'), 'transitive prerequisite drift');
  for (const cold of [f.cold(), f.cold()]) {
    const result = await cold.restore(f.runtime); assert.equal(result.restored, false); assert.match(result.reason, /quarantined/);
  }
  const cold = f.cold(); await cold.restore(f.runtime); await cold.recoverAdaptiveInternal(f.runtime);
  const settled = f.store.read('parent');
  assert.deepEqual(settled.data.completed, []); assert.deepEqual(settled.data.invalidatedAssignments, ['A1', 'A2', 'A3']);
  assert.equal(settled.data.receipts.at(-1).outcome, 'failed');
  assert.equal((await f.cold().restore(f.runtime)).restored, true);
});

for (const state of ['pending', 'settled']) test(`AL-04a correction: silent ${state} marker loss never publishes arguments or releases ownership`, async t => {
  const f = fixture(t); await f.admit(); await f.select();
  let args;
  if (state === 'settled') args = await f.runner.before(f.call, f.runner.status('parent').task);
  const write = f.progress.write.bind(f.progress);
  f.progress.write = (session, value) => { if (value.state !== state) write(session, value); };
  await assert.rejects(state === 'pending' ? f.runner.before(f.call, f.runner.status('parent').task)
    : f.runner.after(f.call, args, f.report('A1')), /marker|readback/);
  assert.equal(f.ownership.read(f.store.read('parent').runID).state, 'reserved');
  f.progress.write = write;
  const cold = f.cold(), result = await cold.restore(f.runtime);
  if (state === 'pending') { assert.equal(result.restored, false); await cold.recoverAdaptiveInternal(f.runtime); }
  else assert.equal(result.restored, true, result.reason);
});

test('AL-04a correction: historical failed checks cannot contradict a rewritten prior report', async t => {
  const f = fixture(t); f.contract.assignments[0].obligations.checks = [{ id: 'C1', command: 'npm test', requirement: 'required' }];
  await f.admit(); await f.apply(); const prepared = await f.prepare(), e = f.evidence(prepared.evidence.snapshot);
  e.checks = [{ id: 'X1', command: 'npm test', exit: 1 }];
  e.checkResults = [{ checkID: 'C1', disposition: 'failed', executions: ['X1'], reason: 'Actual failure.' }];
  await f.submit(e); writeFileSync(join(f.root, 'support.txt'), 'drift');
  assert.equal((await f.cold().restore(f.runtime)).restored, true);
  f.mutate(record => { record.data.priorEvidence.report.checks[0].exit = 0; record.data.priorEvidence.report.checkResults[0].disposition = 'passed'; });
  assert.equal((await f.cold().restore(f.runtime)).restored, false);
});

for (const mode of ['before', 'after']) test(`AL-04a store: ${mode} owner claim failure preserves bootstrap recovery intent`, async t => {
  const f = fixture(t), claim = f.ownership.claim.bind(f.ownership);
  f.ownership.claim = value => { if (mode === 'after') claim(value); throw new Error('injected owner claim'); };
  await assert.rejects(f.admit(), /owner claim/);
  assert.equal(f.store.read('parent').stage, 'bootstrap');
  assert.equal(f.runner.status('parent').task, undefined);
  await assert.rejects(f.admit(), /occup|unfinished/);
  f.ownership.claim = claim;
  const cold = f.cold(); assert.equal((await cold.restore(f.runtime)).restored, true);
  await assert.rejects(f.cold().start({}, f.runtime), /adaptive/i);
  await f.apply(cold);
  assert.equal(f.store.read('parent').data.receipts.length, 1);
});

for (const mode of ['before', 'after']) test(`AL-04a store: ${mode} owner release failure reconciles only the accepted durable receipt`, async t => {
  const f = fixture(t); await f.admit(); await f.select();
  const args = await f.runner.before(f.call, f.runner.status('parent').task), release = f.ownership.release.bind(f.ownership);
  f.ownership.release = (...values) => { if (mode === 'after') release(...values); throw new Error('injected owner release'); };
  await assert.rejects(f.runner.after(f.call, args, f.report('A1')), /owner release/);
  assert.equal(f.store.read('parent').attempt.state, 'settled');
  await assert.rejects(f.select(), /in flight|ownership/);
  f.ownership.release = release;
  assert.equal((await f.cold().restore(f.runtime)).restored, true);
  assert.equal(f.store.read('parent').data.receipts.length, 1);
  assert.equal(f.ownership.read(f.store.read('parent').runID).state, 'idle');
});

test('AL-04a store: competing cold restorers expose only the latest CAS generation', async t => {
  const f = fixture(t); await f.admit(); const first = f.cold(), second = f.cold();
  const results = await Promise.all([first.restore(f.runtime), second.restore(f.runtime)]);
  assert.equal(results.filter(result => result.restored).length, 1);
  const winner = results[0].restored ? first : second;
  await f.apply(winner); assert.equal(f.store.read('parent').data.receipts.length, 1);
});

test('AL-04a store: changed native ownership during restore await cannot expose source authority', async t => {
  const f = fixture(t); await f.admit(); const saved = f.store.read('parent');
  f.inspect.parent = async () => { f.ownership.reserve(saved.runID, 'parent', 'foreign-call', f.ownership.read(saved.runID).epoch); };
  const cold = f.cold(); assert.equal((await cold.restore(f.runtime)).restored, false);
  assert.equal(cold.status('parent').task, undefined);
  assert.equal(f.ownership.read(saved.runID).callID, 'foreign-call');
});

test('AL-04a correction: restored invalidated completion still consumes the bounded repair budget', async t => {
  const f = fixture(t); await f.admit(); await f.apply();
  writeFileSync(join(f.root, 'own.txt'), 'external drift'); const cold = f.cold();
  assert.equal((await cold.restore(f.runtime)).restored, true);
  const context = { ...f.contract.context, fingerprints: f.contract.context.fingerprints.map(item => ({ path: item.path, digest: hash(readFileSync(join(f.root, item.path), 'utf8')) })) };
  await f.select(cold, { repairOf: cold.status('parent').lastReceipt.id, context });
  assert.equal(f.store.read('parent').data.repairs, 1);
});

test('AL-04a correction: forged pending Apply cannot retain a completed assignment without authorized repair', async t => {
  const f = fixture(t); await f.admit(); await f.apply();
  const data = f.store.read('parent').data;
  data.state = 'await-result'; data.pending = { actor: 'mdd-apply', assignmentID: 'A1', purpose: 'Forged repeat.', dispatchPrerequisites: [] };
  assert.throws(() => AdaptiveLow.restore(data, f.root), /pending|repair|completed/);
});

test('AL-04a correction: cold stopped confirmation cannot bypass durable receipt recovery', async t => {
  const f = fixture(t); await f.admit(); await f.select();
  await f.runner.before(f.call, f.runner.status('parent').task);
  const cold = f.cold(); await cold.confirmStopped('parent', f.runtime, true, 'reset-call');
  const saved = f.store.read('parent');
  assert.equal(saved.attempt.state, 'settled'); assert.equal(saved.data.receipts.length, 1);
  assert.equal(saved.data.receipts[0].outcome, 'failed');
  assert.equal(f.ownership.read(saved.runID).state, 'idle');
});

for (const bytes of ['{invalid JSON', 'x'.repeat(8 * 1024 * 1024 + 1)]) test(`AL-04a store: ${bytes.length} unsafe bytes remain occupied across both lanes`, async t => {
  const f = fixture(t); await f.admit(); writeFileSync(f.rawPath(), bytes);
  const cold = f.cold();
  await assert.rejects(cold.start({}, f.runtime));
  await assert.rejects(cold.admitAdaptiveInternal({ contract: f.contract, messageID: 'native-message' }, f.runtime));
  assert.throws(() => cold.authorizeReset('parent', true));
  assert.throws(() => f.ownership.claimParent('parent', 'fixed-run'));
  assert.equal(cold.status('parent').task, undefined);
});

test('AL-04a store: historical fixed checkpoint occupancy refuses adaptive bootstrap without touching bytes', async t => {
  const f = fixture(t);
  const request = { answers: { certainty: 'very-sure', artifactStore: 'none', mode: 'automatic', summary: 'low', complexity: 'not-complex' } };
  const fixed = { version: 1, runID: 'historical-fixed', parent: 'parent', sequence: 0, request, events: [] };
  f.checkpoint.write('parent', fixed);
  await assert.rejects(f.admit(), /occup|unfinished/);
  assert.deepEqual(f.checkpoint.read('parent').checkpoint, fixed);
  assert.equal(f.store.occupied('parent'), false);
});

for (const verdict of ['unknown', 'running', 'stopped']) test(`AL-04a P1: prerequisite drift during pending Apply roundtrips and recovers only after ${verdict} control`, async t => {
  const f = fixture(t), own = f.contract.assignments[0];
  own.obligations.checks = [{ id: 'C1', command: 'npm test', requirement: 'required' }];
  f.contract.scope = { complete: true, reads: ['own.txt', 'support.txt', 'dependent.txt'], writes: ['own.txt', 'dependent.txt'] };
  f.contract.assignments.push({ ...structuredClone(own), id: 'A2', path: 'dependent.txt', dependsOn: ['A1'],
    scope: { complete: true, reads: ['dependent.txt'], writes: ['dependent.txt'] },
    obligations: { source: [{ id: 'E2', description: 'Read dependent source', paths: ['dependent.txt'] }], checks: [] } });
  f.contract.context.fingerprints = f.contract.scope.reads.map(path => ({ path, digest: hash(`original ${path}`) }));
  await f.admit(); await f.apply(); const prepared = await f.prepare(), e = f.evidence(prepared.evidence.snapshot);
  e.sources.push({ id: 'E2', paths: ['dependent.txt'], status: 'not-verified', assessment: 'Dependent work is still pending.' });
  const unfinished = { status: 'not-verified', sources: ['E2'], checks: [], assessment: 'Dependent work is still pending.' };
  e.assignments.push({ assignmentID: 'A2', ...unfinished });
  e.scenarios.push({ requirementID: 'R1', scenarioID: 'S1', assignmentID: 'A2', ...unfinished });
  e.checks = [{ id: 'X1', command: 'npm test', exit: 1 }];
  e.checkResults = [{ checkID: 'C1', disposition: 'failed', executions: ['X1'], reason: 'Actual failed command remains historical.' }];
  await f.submit(e);
  const currentContext = () => ({ ...f.contract.context, fingerprints: f.contract.context.fingerprints.map(item => ({ path: item.path, digest: hash(readFileSync(join(f.root, item.path), 'utf8')) })) });
  await f.select(f.runner, { assignmentID: 'A2', context: currentContext() });
  const call = { ...f.call, callID: 'apply-2' }, args = await f.runner.before(call, f.runner.status('parent').task);
  const before = f.store.read('parent');
  writeFileSync(join(f.root, 'support.txt'), 'changed prerequisite eligibility');
  writeFileSync(join(f.root, 'dependent.txt'), 'partial dependent output');
  const first = f.cold(), restored = await first.restore(f.runtime);
  assert.equal(restored.restored, false); assert.match(restored.reason, /quarantined/);
  const saved = f.store.read('parent');
  assert.deepEqual(saved.data.completed, []); assert.deepEqual(saved.data.invalidatedAssignments, ['A1', 'A2']);
  assert.deepEqual(saved.data.context, before.data.context);
  assert.deepEqual(saved.data.pending.dispatchPrerequisites, [{ assignmentID: 'A1', receiptID: before.data.receipts[0].id }]);
  if (verdict === 'stopped') for (const mutate of [
    data => { data.pending.dispatchPrerequisites = []; },
    data => { data.pending.dispatchPrerequisites[0].receiptID = 'invented-receipt'; },
    data => { data.pending.dispatchPrerequisites.push(data.pending.dispatchPrerequisites[0]); },
    data => { data.invalidatedAssignments = []; },
  ]) {
    const forged = structuredClone(saved.data); mutate(forged);
    assert.throws(() => AdaptiveLow.restore(forged, f.root), /prerequisite/i);
  }
  const validated = AdaptiveLow.restore(saved.data, f.root);
  assert.deepEqual(validated.copy().serialize(), validated.serialize());
  const cold = f.cold(), again = await cold.restore(f.runtime);
  assert.equal(again.restored, false); assert.match(again.reason, /quarantined/);
  await assert.rejects(f.runner.after(call, args, f.report('A2')), /stale|unconfirmed/);
  f.verdict(verdict);
  if (verdict !== 'stopped') {
    const unchanged = f.store.read('parent');
    assert.equal((await cold.recoverAdaptiveInternal(f.runtime)).verdict, verdict);
    assert.deepEqual(f.store.read('parent'), unchanged);
    assert.equal(f.ownership.read(saved.runID).state, 'reserved');
    assert.equal(f.progress.read('parent').state, 'pending');
    f.verdict('stopped');
  }
  const write = f.progress.write.bind(f.progress);
  f.progress.write = (session, marker) => {
    if (marker.state === 'settled') {
      const accepted = f.store.read(session);
      assert.equal(accepted.attempt.state, 'settled');
      assert.equal(accepted.data.receipts.at(-1).callID, 'apply-2');
      assert.equal(accepted.data.receipts.at(-1).outcome, 'failed');
      assert.equal(f.ownership.read(saved.runID).state, 'reserved');
    }
    write(session, marker);
  };
  assert.equal((await cold.recoverAdaptiveInternal(f.runtime)).verdict, 'stopped');
  f.progress.write = write;
  const settled = f.store.read('parent');
  assert.equal(settled.data.receipts.length, 2); assert.deepEqual(settled.data.completed, []);
  assert.deepEqual(settled.data.invalidatedAssignments, ['A1', 'A2']); assert.equal(settled.data.matched, false);
  assert.deepEqual(settled.data.historicalChecks, before.data.historicalChecks);
  assert.equal(settled.data.historicalChecks[0].checks[0].exit, 1);
  assert.deepEqual(settled.data.context, before.data.context);
  assert.equal(f.ownership.read(saved.runID).state, 'idle');
  assert.equal(cold.status('parent').task, undefined);
  assert.equal(readFileSync(join(f.root, 'dependent.txt'), 'utf8'), 'partial dependent output');
  const final = f.cold(); assert.equal((await final.restore(f.runtime)).restored, true);
  assert.deepEqual(AdaptiveLow.restore(settled.data, f.root).copy().serialize(), settled.data);
  await assert.rejects(f.select(final, { assignmentID: 'A2', repairOf: settled.data.receipts[1].id, context: currentContext() }), /prerequisite/);
  await assert.rejects(f.select(final, { repairOf: settled.data.receipts[0].id }), /stale/);
  await f.select(final, { repairOf: settled.data.receipts[0].id, context: currentContext() });
  assert.equal(final.status('parent').assignmentID, 'A1');
  assert.equal(f.store.read('parent').data.receipts.length, 2);
});
