import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhaseRunner } from '../dist/phase-runner.js';
import { NativeIntake } from '../dist/native-intake.js';
import { AdaptiveStore } from '../dist/adaptive-store.js';
import { RunOwnershipStore } from '../dist/run-ownership.js';
import { ProgressGuard } from '../dist/progress.js';
import { CheckpointStore } from '../dist/checkpoint.js';
import { QuestionCheckpointStore } from '../dist/question-checkpoint.js';
import { defaultSettings } from '../dist/settings.js';
import { LocalFiles } from '../dist/local-files.js';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), 'mdd-adaptive-transfer-')), root = join(temp, 'source'), storage = join(temp, 'runtime');
  mkdirSync(root); mkdirSync(storage); writeFileSync(join(root, 'own.txt'), 'original');
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const runtime = { sessionID: 'source', agent: 'mdd-orchestrator', directory: root, worktree: root }, target = { ...runtime, sessionID: 'target' };
  const scope = { complete: true, reads: ['own.txt'], writes: ['own.txt'] };
  const contract = { contractVersion: 1, objective: 'Replace bounded source.',
    acceptance: { goal: 'Replace source', requirements: [{ id: 'R1', description: 'Replacement', scenarios: [{ id: 'S1', given: 'Original', when: 'Replaced', then: 'Updated' }] }] },
    exclusions: [], decisions: [], productQuestions: [], scope,
    context: { technical: 'understood', dependencies: 'bounded', reason: 'Inspected source.', fingerprints: [{ path: 'own.txt', digest: hash('original') }] },
    assessment: { assessmentVersion: 1, complexity: 'low', impact: 'low' },
    assignments: [{ id: 'A1', path: 'own.txt', description: 'Replace source', scenarios: ['S1'], decisions: [], dependsOn: [], scope,
      obligations: { source: [{ id: 'E1', description: 'Read source', paths: ['own.txt'] }], checks: [] } }] };
  const local = new LocalFiles(storage), fault = { boundary: undefined, mode: undefined, read: undefined };
  const files = {
    readStrict(name, limit) { if (fault.read === name) { fault.read = undefined; throw new Error('injected readback'); } return local.readStrict(name, limit); },
    updateStrict(name, change, limit) {
      let hit = false;
      local.updateStrict(name, previous => {
        const next = change(previous), parsed = next === undefined ? undefined : JSON.parse(next);
        const boundary = name.includes('parent-owner-') ? parsed?.sessionID === 'target' ? parsed.retired ? 'parent-retirement' : 'claim' : undefined
          : name.includes('/owner-') ? parsed?.recoveringTransfer ? 'abort-reserve' : parsed?.state === 'transferring' ? 'fence'
            : parsed?.adaptiveReceipt ? 'commit' : parsed?.recoveredTransfer ? 'abort-commit' : undefined
          : name.includes('/adaptive-') ? parsed?.sessionID === 'target' ? 'publication' : parsed?.sessionID === 'source' ? 'source-generation' : next === undefined ? 'retirement' : undefined : undefined;
        if (boundary !== undefined && boundary === fault.boundary) {
          hit = true; fault.boundary = undefined;
          if (fault.mode === 'before') throw new Error(`injected before ${boundary}`);
        }
        return next;
      }, limit);
      if (hit && fault.mode === 'after') throw new Error('injected after rename');
      if (hit && fault.mode === 'readback') fault.read = name;
    },
  };
  const store = new AdaptiveStore(storage, files), ownership = new RunOwnershipStore(storage, files), progress = new ProgressGuard(storage), checkpoint = new CheckpointStore(storage), questions = new QuestionCheckpointStore(storage);
  const native = { valid: true, calls: [], hook: undefined, idle: true, proofHook: undefined, idleHook: undefined,
    role: 'user', authored: true, latest: true, sessionID: 'target', text: undefined };
  const inspect = { parent: async here => { native.calls.push(here.sessionID); await native.hook?.(here); },
    intake: async (here, text, message, scope) => {
      if (!native.valid) throw new Error('Native request is stale, foreign or not authored.');
      if (scope === 'latest') {
        if (native.role !== 'user' || !native.authored || !native.latest || native.sessionID !== here.sessionID ||
            native.text !== undefined && native.text !== text) throw new Error('Latest native authored target request differs.');
        assert.ok(text === request() || text.startsWith('Recover adaptive transfer '));
      }
      else assert.equal(text, contract.objective);
      await native.proofHook?.();
      return scope === 'latest' ? 'target-user' : 'source-user';
    }, adaptiveTransferIdle: async (here, role) => { if (!native.idle) throw new Error('Native child is running or unknown.'); await native.idleHook?.(here, role); }, confirmAdaptiveTransfer: async (here, receipt) => {
      if (!native.valid || here.sessionID !== receipt.targetSessionID || receipt.requestDigest !== hash(request(receipt.sourceSessionID))) throw new Error('Native transfer provenance unavailable.');
    }, result: async (_here, _call, _actor, output) => output, stopped: async () => true };
  const options = { adaptiveStore: store, ownership, progress, checkpoint, workerCapability: { phase: 'mdd-explore', readOnly: true, applyEditing: true } };
  const runner = new PhaseRunner(inspect, options), settings = defaultSettings(); settings.profiles.default.answers.mode = 'automatic';
  const intake = new NativeIntake(runner, inspect, settings, { ownership, checkpoint, questions });
  const request = (sourceID = 'source') => {
    const saved = store.read(sourceID);
    return `Transfer sourceSessionID=${sourceID} runID=${saved.runID} admissionDigest=${saved.admissionDigest}. Continue the unchanged objective, acceptance, scope, exclusions and decisions: ${JSON.stringify(saved.data.contract.objective)}`;
  };
  const admit = () => intake.admitAdaptiveInternal({ contract }, runtime, 'source-message');
  const transfer = (operationID = 'move-1') => intake.transferAdaptiveInternal({ sourceSessionID: 'source', runID: store.read('source').runID, operationID, messageID: 'target-message' }, target);
  const cold = () => new PhaseRunner(inspect, options);
  const recover = (action, r = runner, operationID = 'move-1') => r.recoverAdaptiveTransferInternal({ sourceSessionID: 'source', runID: store.read('source').runID, operationID, action, messageID: 'recovery-message' }, target);
  const arm = (boundary, mode) => { fault.boundary = boundary; fault.mode = mode; };
  const handle = (r = runner, here = runtime) => r.status(here.sessionID).selection.handle;
  const select = async (r = runner, here = runtime, extra = {}) => r.selectAdaptiveInternal({ handle: handle(r, here), actor: 'mdd-apply', assignmentID: 'A1', purpose: 'Replace bounded source.', ...extra }, here);
  const apply = async (outcome = 'passed', callID = 'apply-1') => {
    await select(); const call = { sessionID: 'source', callID }, args = await runner.before(call, runner.status('source').task);
    if (outcome === 'passed') writeFileSync(join(root, 'own.txt'), 'updated');
    await runner.after(call, args, JSON.stringify({ outcome, evidenceSummary: 'Actual bounded result.', artifact: 'Source readback.',
      completed: outcome === 'passed' ? ['A1'] : [], changes: outcome === 'passed' ? ['own.txt'] : [], checks: [] }));
  };
  const prepare = () => runner.prepareAdaptiveEvidenceInternal({ handle: handle() }, runtime);
  const evidence = snapshot => ({ snapshotID: snapshot.id, readback: { acceptance: contract.acceptance, scope: contract.scope, exclusions: [], decisions: [] },
    inventory: [{ path: 'own.txt', disposition: 'assignment', reason: 'Read actual changed source.' }], exclusions: [],
    sources: [{ id: 'E1', paths: ['own.txt'], status: 'verified', assessment: 'Replacement present.' }],
    assignments: [{ assignmentID: 'A1', status: 'verified', sources: ['E1'], checks: [], assessment: 'Replacement satisfies assignment.' }],
    scenarios: [{ requirementID: 'R1', scenarioID: 'S1', assignmentID: 'A1', status: 'verified', sources: ['E1'], checks: [], assessment: 'Replacement satisfies scenario.' }],
    decisions: [], checks: [], checkResults: [], supplementalChecks: [], limits: [] });
  const submit = value => runner.submitAdaptiveEvidenceInternal({ handle: handle(), evidence: value }, runtime);
  const close = (outcome = 'verified') => runner.closeAdaptiveInternal({ handle: handle(), outcome, ...(outcome === 'unverified' ? { limits: ['Required proof remains missing.'] } : {}) }, runtime);
  return { root, storage, runtime, target, contract, store, ownership, progress, checkpoint, questions, native, inspect, options, runner, intake,
    request, admit, transfer, cold, recover, arm, local, handle, select, apply, prepare, evidence, submit, close };
}

test('AL-04b transfer: real internal intake moves actorless data, rotates handles and fences every old reader', async t => {
  const f = fixture(t); await f.admit(); const before = f.store.read('source'), old = f.runner.status('source').selection.handle;
  assert.equal(typeof f.intake.transferAdaptiveInternal, 'function', 'internal native transfer must exist without public registration');
  const status = await f.transfer();
  assert.equal(status.runID, before.runID); assert.notEqual(status.selection.handle, old);
  assert.deepEqual(f.store.read('target').data, before.data);
  assert.equal(f.ownership.read(before.runID).ownerSessionID, 'target');
  assert.equal(f.ownership.read(before.runID).adaptiveReceipt.operationID, 'move-1');
  assert.throws(() => f.runner.status('source'), /stale|fenced|authority/);
  assert.ok(f.native.calls.includes('source')); assert.ok(f.native.calls.includes('target'));
});

test('AL-04b transfer: missing native proof makes no claim or publication', async t => {
  const f = fixture(t); await f.admit(); f.native.valid = false;
  assert.equal(typeof f.intake.transferAdaptiveInternal, 'function', 'native transfer boundary is required');
  await assert.rejects(f.transfer(), /Native request/);
  assert.equal(f.ownership.parentClaim('target'), undefined); assert.equal(f.store.read('target'), undefined);
  assert.equal(f.ownership.read(f.store.read('source').runID).state, 'idle');
});

test('AL-04b transfer: source ownership fencing invalidates status even with unchanged record bytes', async t => {
  const f = fixture(t); await f.admit(); const saved = f.store.read('source');
  f.ownership.beginTransfer(saved.runID, 'source', f.target, saved.digest, 0);
  assert.throws(() => f.runner.status('source'), /stale|fenced|authority/, 'durable owner must fence task and selection publication');
});

test('AL-04b transfer: missing native idle capability cannot infer that no unknown child exists', async t => {
  const f = fixture(t); await f.admit(); delete f.inspect.adaptiveTransferIdle;
  await assert.rejects(f.transfer(), /native.*idle|idle.*native/i);
  assert.equal(f.ownership.parentClaim('target'), undefined);
});

test('AL-04b transfer: native running or unknown child refuses the move before any durable claim', async t => {
  const f = fixture(t); await f.admit(); f.native.idle = false;
  await assert.rejects(f.transfer(), /running|unknown/);
  assert.equal(f.ownership.parentClaim('target'), undefined);
});

for (const boundary of ['claim', 'fence', 'publication', 'commit']) for (const mode of ['before', 'after', 'readback']) {
  test(`AL-04b transfer: ${mode} ${boundary} interruption supports exact cold finish without dual writers`, async t => {
    const f = fixture(t); await f.admit(); f.arm(boundary, mode);
    if (boundary === 'publication' && mode === 'after') await f.transfer();
    else await assert.rejects(f.transfer(), /injected|unconfirmed|cannot be confirmed|commit|publication/i);
    const owner = f.ownership.read(f.store.read('source').runID), claim = f.ownership.parentClaim('target');
    if (!claim) {
      assert.equal(boundary, 'claim'); assert.equal(mode, 'before'); assert.equal(owner.ownerSessionID, 'source');
      assert.ok(f.runner.status('source').selection.handle); return;
    }
    if (owner.state === 'transferring' || owner.ownerSessionID === 'target') assert.throws(() => f.runner.status('source'), /fenced|authority|stale/);
    await assert.rejects(f.recover('finish', f.cold(), 'wrong-operation'), /exact|claimed/);
    const cold = f.cold(), status = await f.recover('finish', cold);
    assert.equal(status.runID, owner.runID); assert.equal(f.ownership.read(owner.runID).ownerSessionID, 'target');
    await f.recover('finish', cold);
    assert.equal(f.store.read('target').transfer.operationID, 'move-1');
    await assert.rejects(f.recover('abort', f.cold()), /cannot be aborted/);
  });
}

for (const initial of ['claim', 'fence', 'publication', 'commit']) {
  test(`AL-04b transfer: explicit abort after before ${initial} preserves source and never revives stale handles`, async t => {
    const f = fixture(t); await f.admit(); const original = f.store.read('source'), handle = f.handle(); f.arm(initial, 'before');
    await assert.rejects(f.transfer());
    if (!f.ownership.parentClaim('target')) return;
    const result = await f.recover('abort', f.cold()); assert.equal(result.state, 'adaptive-transfer-aborted');
    assert.equal(f.store.read('target'), undefined); assert.equal(f.ownership.parentClaim('target').retired, true);
    assert.equal(f.store.read('source').sequence, original.sequence + 1);
    assert.throws(() => f.runner.status('source'), /stale|authority|fenced/);
    assert.equal((await f.cold().restore(f.target)).restored, false);
    const cold = f.cold(); assert.equal((await cold.restore(f.runtime)).restored, true);
    await assert.rejects(cold.selectAdaptiveInternal({ handle, actor: 'mdd-apply', assignmentID: 'A1', purpose: 'Old handle cannot return.' }, f.runtime), /handle/);
    await f.recover('abort', f.cold());
    await assert.rejects(f.recover('finish', f.cold()), /exact|claimed/);
  });
}

for (const boundary of ['abort-reserve', 'retirement', 'parent-retirement', 'source-generation', 'abort-commit']) for (const mode of ['before', 'after', 'readback']) {
  test(`AL-04b transfer: ${mode} ${boundary} abort interruption reserves cleanup and cold-reconciles exact bytes`, async t => {
    const f = fixture(t); await f.admit(); const original = f.store.read('source');
    f.arm('commit', 'before'); await assert.rejects(f.transfer()); assert.ok(f.store.read('target'));
    f.arm(boundary, mode);
    if (boundary === 'source-generation' && mode === 'after') await f.recover('abort', f.cold());
    else await assert.rejects(f.recover('abort', f.cold()));
    if (boundary === 'abort-reserve' && mode === 'before') {
      assert.equal(f.ownership.read(original.runID).state, 'transferring'); assert.ok(f.store.read('target'));
    } else await assert.rejects(f.recover('finish', f.cold()), /fenced|exact|claimed|operation|abort|reservation|unconfirmed/);
    await f.recover('abort', f.cold());
    assert.equal(f.store.read('target'), undefined); assert.equal(f.ownership.parentClaim('target').retired, true);
    assert.equal(f.ownership.read(original.runID).ownerSessionID, 'source');
    assert.equal((await f.cold().restore(f.runtime)).restored, true);
  });
}

for (const occupancy of ['parent', 'retired-parent', 'intake', 'retired-intake', 'progress', 'question-bytes', 'adaptive-bytes', 'fixed-bytes', 'volatile-intake', 'volatile-run']) {
  test(`AL-04b transfer: target ${occupancy} never looks empty`, async t => {
    const f = fixture(t); await f.admit();
    if (occupancy === 'parent' || occupancy === 'retired-parent') {
      f.ownership.claimParent('target', 'legacy'); if (occupancy === 'retired-parent') f.ownership.retireParent('target', 'legacy');
    } else if (occupancy === 'intake' || occupancy === 'retired-intake') {
      f.ownership.claimIntake('target', 'legacy-token', 'legacy-user');
      if (occupancy === 'retired-intake') f.ownership.retireIntake('target', 'legacy-token');
    } else if (occupancy === 'progress') f.progress.write('target', { runID: 'legacy', userMessageID: 'legacy-user', state: 'settled' });
    else if (occupancy === 'adaptive-bytes') f.local.updateStrict(`.mdd/adaptive-${hash('target')}.json`, () => '{"version":999}', 10000);
    else if (occupancy === 'fixed-bytes') { mkdirSync(join(f.storage, '.mdd'), { recursive: true }); writeFileSync(join(f.storage, '.mdd', `checkpoint-${hash('target')}.json`), '{"version":999}'); }
    else if (occupancy === 'question-bytes') { const name = `.mdd/question-${hash('target')}.json`; f.local.update(name, () => '{"version":999}', 10000); }
    else if (occupancy === 'volatile-intake') {
      // A real starting intake has volatile occupancy even before a durable run exists.
      const nativeIntake = f.inspect.intake;
      f.inspect.intake = async () => 'different-target-user';
      await f.intake.start({ requirements: 'A different target objective.' }, f.target, 'target-message');
      f.inspect.intake = nativeIntake;
    } else {
      await f.runner.explore({ purpose: 'Inspect the target.' }, f.target);
    }
    await assert.rejects(f.transfer(), /occup|unconfirmed|native|requires|invalid|cannot|Unsupported/i);
    assert.equal(f.ownership.read(f.store.read('source').runID).ownerSessionID, 'source');
    assert.equal(f.store.read('source').transfer, undefined);
  });
}

for (const stage of ['source-parent', 'target-parent', 'source-idle', 'target-idle', 'native-request']) {
  test(`AL-04b transfer: source generation race during ${stage} is rejected before claims`, async t => {
    const f = fixture(t); await f.admit(); let changed = false;
    const mutate = () => {
      if (changed) return; changed = true;
      const previous = f.store.read('source'), { version, sequence, digest, admissionDigest, ...body } = previous;
      f.store.commit('source', previous, body);
    };
    if (stage === 'native-request') f.native.proofHook = mutate;
    else if (stage.endsWith('-idle')) f.native.idleHook = async (_here, role) => { if (role === stage.split('-')[0]) mutate(); };
    else f.native.hook = async here => { if (here.sessionID === (stage === 'source-parent' ? 'source' : 'target')) mutate(); };
    await assert.rejects(f.transfer(), /changed|stale/); assert.equal(f.ownership.parentClaim('target'), undefined);
  });
}

test('AL-04b transfer: source pending actor or unconsumed selection never transfers', async t => {
  const f = fixture(t); await f.admit(); await f.select(); await assert.rejects(f.transfer(), /actorless|changed|pending/);
  const args = await f.runner.before({ sessionID: 'source', callID: 'pending' }, f.runner.status('source').task);
  await assert.rejects(f.transfer(), /pending|changed/); assert.equal(f.ownership.parentClaim('target'), undefined);
  assert.ok(args.prompt); assert.equal(f.store.read('source').attempt.state, 'pending');
});

test('AL-04b transfer: actual failed attempt history survives and new target Apply requires selected repair', async t => {
  const f = fixture(t); await f.admit(); await f.apply('failed'); const before = f.store.read('source');
  const status = await f.transfer(); assert.deepEqual(f.store.read('target').data.receipts, before.data.receipts);
  assert.equal(status.lastReceipt.outcome, 'failed'); await assert.rejects(f.select(f.runner, f.target), /repair/);
  await f.select(f.runner, f.target, { repairOf: status.lastReceipt.id });
  assert.ok(f.runner.status('target').task); assert.equal(f.store.read('source').data.receipts.length, 1);
});

for (const outcome of ['verified', 'unverified']) {
  test(`AL-04b transfer: ${outcome} closed state and actual completion proof survive without reopening`, async t => {
    const f = fixture(t); await f.admit(); await f.apply();
    if (outcome === 'verified') { const p = await f.prepare(); await f.submit(f.evidence(p.evidence.snapshot)); }
    await f.close(outcome); const before = f.store.read('source'), status = await f.transfer();
    assert.deepEqual(f.store.read('target').data, before.data); assert.equal(status.state, outcome === 'verified' ? 'completed' : 'closed-unverified');
    assert.equal(status.task, undefined); assert.equal(status.approval, undefined);
    const cold = f.cold(); assert.equal((await cold.restore(f.target)).restored, true);
    await assert.rejects(f.select(cold, f.target), /handle|terminal|completed/);
  });
}

test('AL-04b transfer: failed check history remains historical under selective proof drift', async t => {
  const f = fixture(t); f.contract.assignments[0].obligations.checks = [{ id: 'C1', command: 'npm test', requirement: 'required' }];
  await f.admit(); await f.apply(); const p = await f.prepare(), e = f.evidence(p.evidence.snapshot);
  e.checks = [{ id: 'X1', command: 'npm test', exit: 1 }]; e.checkResults = [{ checkID: 'C1', disposition: 'failed', executions: ['X1'], reason: 'Actual command failed.' }];
  await f.submit(e); writeFileSync(join(f.root, 'own.txt'), 'external drift');
  const status = await f.transfer(), data = f.store.read('target').data;
  assert.deepEqual(status.selection.completed, []); assert.equal(data.matched, false);
  assert.equal(data.historicalChecks[0].checks[0].exit, 1); assert.deepEqual(data.contract, f.store.read('source').data.contract);
  assert.equal(data.receipts[0].outcome, 'passed'); await assert.rejects(f.select(f.runner, f.target), /repair/);
});

test('AL-04b transfer: cold target restoration requires original native provenance and rotates process handles', async t => {
  const f = fixture(t); await f.admit(); const status = await f.transfer(), old = status.selection.handle;
  f.native.valid = false; const refused = f.cold(); assert.equal((await refused.restore(f.target)).restored, false);
  assert.equal(refused.status('target').task, undefined);
  f.native.valid = true; const cold = f.cold(); assert.equal((await cold.restore(f.target)).restored, true);
  assert.notEqual(cold.status('target').selection.handle, old); assert.throws(() => f.runner.status('target'), /stale/);
  await assert.rejects(cold.selectAdaptiveInternal({ handle: old, actor: 'mdd-apply', assignmentID: 'A1', purpose: 'Do not reuse old handles.' }, f.target), /handle/);
});

test('AL-04b transfer: divergent target and competing abort reservation never permit late finish', async t => {
  const f = fixture(t); await f.admit(); f.arm('commit', 'before'); await assert.rejects(f.transfer());
  const source = f.store.read('source'), target = f.store.read('target');
  f.arm('retirement', 'before'); await assert.rejects(f.recover('abort', f.cold()));
  assert.equal(f.ownership.read(source.runID).state, 'reserved');
  assert.throws(() => f.ownership.finishAdaptiveTransfer(f.store, source, target), /fenced|operation|unconfirmed/);
  await f.recover('abort', f.cold()); assert.equal(f.store.read('target'), undefined);
  assert.throws(() => f.ownership.finishAdaptiveTransfer(f.store, source, target), /source|claim|fenced|generation|unconfirmed/);
});

test('AL-04b transfer: a later target generation cannot be silently overwritten or retired', async t => {
  const f = fixture(t); await f.admit(); f.arm('commit', 'before'); await assert.rejects(f.transfer());
  const previous = f.store.read('target'), { version, sequence, digest, admissionDigest, ...body } = previous;
  f.store.commit('target', previous, body);
  await assert.rejects(f.recover('finish', f.cold()), /Divergent|projection|publication/);
  await assert.rejects(f.recover('abort', f.cold()), /Divergent/);
  assert.equal(f.store.read('target').sequence, 1); assert.equal(f.ownership.read(previous.runID).state, 'reserved');
});

test('AL-04b transfer: native intake cannot start in either parent during asynchronous transfer proof', async t => {
  const f = fixture(t); await f.admit(); let checked = false;
  f.native.hook = async here => {
    if (checked || here.sessionID !== 'target') return; checked = true;
    await assert.rejects(f.intake.start({ requirements: f.contract.objective }, f.target, 'competing-message'), /transfer/i);
    await assert.rejects(f.intake.admitAdaptiveInternal({ contract: f.contract }, f.target, 'competing-message'), /transfer/i);
  };
  await f.transfer(); assert.equal(checked, true);
});

for (const bad of ['assistant', 'synthetic', 'stale', 'foreign', 'wrong-source', 'wrong-run', 'wrong-objective', 'wrong-admission']) {
  test(`AL-04b transfer: ${bad} native request cannot authorize a claim`, async t => {
    const f = fixture(t); await f.admit();
    if (bad === 'assistant') f.native.role = 'assistant';
    else if (bad === 'synthetic') f.native.authored = false;
    else if (bad === 'stale') f.native.latest = false;
    else if (bad === 'foreign') f.native.sessionID = 'foreign-parent';
    else f.native.text = f.request().replace(bad === 'wrong-source' ? 'sourceSessionID=source' : bad === 'wrong-run' ? `runID=${f.store.read('source').runID}`
      : bad === 'wrong-admission' ? `admissionDigest=${f.store.read('source').admissionDigest}` : JSON.stringify(f.contract.objective), 'different-binding');
    await assert.rejects(f.transfer(), /native|request/i); assert.equal(f.ownership.parentClaim('target'), undefined);
  });
}

for (const extra of [{ approved: true }, { userText: 'Transfer this run.' }, { provenance: { authored: true, latest: true } }]) {
  test(`AL-04b transfer: caller-supplied ${Object.keys(extra)[0]} is not native proof`, async t => {
    const f = fixture(t); await f.admit();
    await assert.rejects(f.intake.transferAdaptiveInternal({ sourceSessionID: 'source', runID: f.store.read('source').runID,
      operationID: 'move-1', messageID: 'target-message', ...extra }, f.target), /unknown|unexpected/i);
    assert.equal(f.ownership.parentClaim('target'), undefined);
  });
}

for (const pending of ['intake', 'question', 'marker', 'foreign-writer']) {
  test(`AL-04b transfer: source ${pending} prevents every durable target claim`, async t => {
    const f = fixture(t); await f.admit();
    if (pending === 'intake') f.ownership.claimIntake('source', 'pending-intake', 'source-user');
    else if (pending === 'question') f.local.update(`.mdd/question-${hash('source')}.json`, () => '{"version":999}', 10000);
    else if (pending === 'marker') f.progress.write('source', { runID: f.store.read('source').runID, userMessageID: 'source-user', state: 'pending', callID: 'unknown-call' });
    else f.ownership.reserve(f.store.read('source').runID, 'source', 'foreign-call', 0);
    await assert.rejects(f.transfer(), /native|pending|source|changed|question|fenced/i); assert.equal(f.ownership.parentClaim('target'), undefined);
  });
}

test('AL-04b transfer: target occupancy and source idle epoch are rechecked after native user proof', async t => {
  const f = fixture(t); await f.admit(); f.native.proofHook = () => f.ownership.claimIntake('target', 'raced-intake', 'new-user');
  await assert.rejects(f.transfer(), /occupied/); assert.equal(f.ownership.parentClaim('target'), undefined);
  const g = fixture(t); await g.admit(); g.native.proofHook = () => {
    const id = g.store.read('source').runID, reserved = g.ownership.reserve(id, 'source', 'raced-writer', 0);
    g.ownership.release(id, 'source', 'raced-writer', reserved.epoch);
  };
  await assert.rejects(g.transfer(), /changed/); assert.equal(g.ownership.parentClaim('target'), undefined);
});

test('AL-04b transfer: actual target writer uses fresh native handles and retains immutable transfer lineage', async t => {
  const f = fixture(t); await f.admit(); const before = f.handle(), status = await f.transfer();
  await assert.rejects(f.runner.selectAdaptiveInternal({ handle: before, actor: 'mdd-apply', assignmentID: 'A1', purpose: 'Old source selection.' }, f.target), /handle/);
  await f.select(f.runner, f.target); const issued = f.runner.status('target').task;
  const args = await f.runner.before({ sessionID: 'target', callID: 'target-apply' }, issued);
  writeFileSync(join(f.root, 'own.txt'), 'updated in target');
  await f.runner.after({ sessionID: 'target', callID: 'target-apply' }, args, JSON.stringify({ outcome: 'passed', evidenceSummary: 'Actual target replacement.',
    artifact: 'Read back target source.', completed: ['A1'], changes: ['own.txt'], checks: [] }));
  assert.deepEqual(f.runner.status('target').selection.completed, ['A1']);
  assert.equal(f.store.read('target').transfer.operationID, 'move-1');
  assert.equal(f.store.read('source').data.receipts.length, 0); assert.equal(status.task, undefined);
  const cold = f.cold(); assert.equal((await cold.restore(f.target)).restored, true);
  assert.equal(f.store.read('target').data.receipts.at(-1).callID, 'target-apply');
  assert.equal(cold.status('target').lastReceipt.id, f.store.read('target').data.receipts.at(-1).id);
});

test('AL-04b transfer: selective input drift preserves unrelated actual completion and invalidates only affected proof', async t => {
  const f = fixture(t); writeFileSync(join(f.root, 'support.txt'), 'support'); writeFileSync(join(f.root, 'other.txt'), 'other');
  const own = f.contract.assignments[0]; own.scope = structuredClone(own.scope); own.scope.reads.push('support.txt');
  f.contract.scope = structuredClone(f.contract.scope); f.contract.scope.reads.push('support.txt', 'other.txt'); f.contract.scope.writes.push('other.txt');
  f.contract.context.fingerprints.push({ path: 'support.txt', digest: hash('support') }, { path: 'other.txt', digest: hash('other') });
  f.contract.assignments.push({ ...structuredClone(own), id: 'A2', path: 'other.txt', scope: { complete: true, reads: ['other.txt'], writes: ['other.txt'] },
    obligations: { source: [{ id: 'E2', description: 'Read other source', paths: ['other.txt'] }], checks: [] } });
  await f.admit(); await f.apply();
  await f.select(f.runner, f.runtime, { assignmentID: 'A2', context: { ...f.contract.context, fingerprints: f.contract.context.fingerprints.map(file => ({ path: file.path, digest: hash(readFileSync(join(f.root, file.path), 'utf8')) })) } });
  const call = { sessionID: 'source', callID: 'other-apply' }, args = await f.runner.before(call, f.runner.status('source').task);
  writeFileSync(join(f.root, 'other.txt'), 'updated other');
  await f.runner.after(call, args, JSON.stringify({ outcome: 'passed', evidenceSummary: 'Other source replaced.', artifact: 'Other source readback.', completed: ['A2'], changes: ['other.txt'], checks: [] }));
  writeFileSync(join(f.root, 'support.txt'), 'drifted support');
  const status = await f.transfer(); assert.deepEqual(status.selection.completed, ['A2']);
  assert.deepEqual(f.store.read('target').data.invalidatedAssignments, ['A1']); assert.equal(f.store.read('target').data.receipts.length, 2);
});

test('AL-04b transfer: verified closure drift invalidates proof without reopening execution', async t => {
  const f = fixture(t); await f.admit(); await f.apply(); const p = await f.prepare(); await f.submit(f.evidence(p.evidence.snapshot)); await f.close();
  writeFileSync(join(f.root, 'own.txt'), 'drift after closure'); const status = await f.transfer();
  assert.equal(status.state, 'closed-unverified'); assert.equal(status.task, undefined); assert.equal(status.selection.handle, undefined);
  assert.equal(f.store.read('target').data.completion.outcome, 'unverified'); assert.equal(f.store.read('target').data.matched, false);
});

for (const mode of ['before', 'after', 'silent']) {
  test(`AL-04b transfer: ${mode} target runtime marker failure never restores source ownership`, async t => {
    const f = fixture(t); await f.admit(); await f.apply(); const write = f.progress.write.bind(f.progress); let fail = true;
    f.progress.write = (sessionID, marker) => {
      if (sessionID === 'target' && fail) {
        fail = false;
        if (mode === 'before') throw new Error('injected target marker before');
        if (mode === 'silent') return;
        write(sessionID, marker); throw new Error('injected target marker after');
      }
      write(sessionID, marker);
    };
    await assert.rejects(f.transfer(), /restore.*fenced/);
    assert.equal(f.ownership.read(f.store.read('source').runID).ownerSessionID, 'target');
    assert.throws(() => f.runner.status('source'), /fenced|stale|authority/);
    assert.equal((await f.cold().restore(f.target)).restored, true);
    assert.equal(f.progress.read('target').userMessageID, 'target-user');
  });
}

for (const field of ['operationID', 'ownerEpoch', 'sourceSessionID', 'sourceSequence', 'requestDigest']) {
  test(`AL-04b transfer: rehashed ${field} lineage tamper cannot revive cold target authority`, async t => {
    const f = fixture(t); await f.admit(); await f.transfer();
    f.local.updateStrict(`.mdd/adaptive-${hash('target')}.json`, previous => {
      const item = JSON.parse(previous); item.transfer[field] = typeof item.transfer[field] === 'number' ? item.transfer[field] + 1 : field === 'requestDigest' ? 'a'.repeat(64) : 'foreign';
      const { digest, ...body } = item; return JSON.stringify({ ...body, digest: hash(body) });
    }, 8 * 1024 * 1024);
    const cold = f.cold(); assert.equal((await cold.restore(f.target)).restored, false); assert.equal(cold.status('target').task, undefined);
    assert.throws(() => f.runner.status('target'), /stale|authority/);
  });
}

test('AL-04b transfer: a second fresh native transfer keeps every former parent fenced', async t => {
  const f = fixture(t); await f.admit(); await f.transfer(); const runID = f.store.read('target').runID;
  const third = { ...f.target, sessionID: 'third' };
  f.inspect.intake = async (here, text, messageID, scope) => {
    assert.equal(here.sessionID, 'third'); assert.equal(text, f.request('target')); assert.equal(scope, 'latest'); return 'third-user';
  };
  await f.runner.transferAdaptiveInternal({ sourceSessionID: 'target', runID, operationID: 'move-2', messageID: 'third-message' }, third);
  const owner = f.ownership.read(runID); assert.deepEqual(owner.formerOwners, ['source', 'target']);
  assert.equal(owner.adaptiveReceipt.sourceSessionID, 'target'); assert.equal(owner.adaptiveReceipt.nativeUserMessageID, 'third-user');
  assert.equal(owner.adaptiveReceipt.verifiedEpoch, 4); assert.equal(f.store.read('third').transfer.operationID, 'move-2');
  for (const sessionID of ['source', 'target']) {
    assert.throws(() => f.runner.status(sessionID), /fenced|stale|authority/);
    assert.equal((await f.cold().restore({ ...f.runtime, sessionID })).restored, false);
  }
  assert.equal((await f.cold().restore(third)).restored, true);
});

test('AL-04b transfer: interrupted abort rechecks native occupancy before retiring any target bytes', async t => {
  const f = fixture(t); await f.admit(); f.arm('commit', 'before'); await assert.rejects(f.transfer());
  f.arm('retirement', 'before'); await assert.rejects(f.recover('abort', f.cold()));
  const target = f.store.read('target');
  f.progress.write('target', { runID: 'foreign-native-work', userMessageID: 'foreign-user', state: 'pending', callID: 'foreign-call' });
  await assert.rejects(f.recover('abort', f.cold()), /occupied|native|fenced/);
  assert.deepEqual(f.store.read('target'), target, 'unknown native occupancy must be noticed before exact-record deletion');
  assert.equal(f.ownership.read(target.runID).state, 'reserved');
});

test('AL-04b transfer: abort ownership validator checks parent claim before deleting exact target bytes', async t => {
  const f = fixture(t); await f.admit(); f.arm('commit', 'before'); await assert.rejects(f.transfer());
  const source = f.store.read('source'), target = f.store.read('target');
  f.arm('retirement', 'before'); await assert.rejects(f.recover('abort', f.cold()));
  f.local.updateStrict(`.mdd/parent-owner-${hash('target')}.json`, () => JSON.stringify({ sessionID: 'target', runID: 'foreign-run' }), 4096);
  assert.throws(() => f.ownership.abortAdaptiveTransfer(f.store, source, 'target', 'move-1'), /claim/);
  assert.deepEqual(f.store.read('target'), target, 'an old cleanup reservation cannot discard bytes under a different parent claim');
});

test('AL-04b transfer: proof drift between publication and commit refuses frozen projection finish but permits exact abort', async t => {
  const f = fixture(t); await f.admit(); await f.apply(); const p = await f.prepare(); await f.submit(f.evidence(p.evidence.snapshot));
  const finish = f.ownership.finishAdaptiveTransfer.bind(f.ownership); let drift = true;
  f.ownership.finishAdaptiveTransfer = (...args) => {
    if (drift) { drift = false; writeFileSync(join(f.root, 'own.txt'), 'new drift at commit'); }
    return finish(...args);
  };
  await assert.rejects(f.transfer(), /unconfirmed/); const published = f.store.read('target');
  assert.equal(f.ownership.read(published.runID).state, 'transferring');
  await assert.rejects(f.recover('finish', f.cold()), /projection|Divergent|changed/);
  assert.deepEqual(f.store.read('target'), published);
  await f.recover('abort', f.cold()); const cold = f.cold(); assert.equal((await cold.restore(f.runtime)).restored, true);
  assert.deepEqual(cold.status('source').selection.completed, []); assert.equal(f.store.read('source').data.matched, false);
});

test('AL-04b P2: reused operation ID cold-finishes the current hop using strict native transaction binding', async t => {
  const f = fixture(t); await f.admit(); await f.apply();
  const runID = f.store.read('source').runID, operationID = 'move-1', proofs = new Map(), inspected = [];
  proofs.set('target-user', { source: f.store.read('source'), target: f.target, text: f.request(), epoch: f.ownership.read(runID).epoch });
  f.inspect.confirmAdaptiveTransfer = async (here, receipt, actualRunID) => {
    inspected.push(structuredClone(receipt));
    const native = proofs.get(receipt.nativeUserMessageID);
    assert.ok(native, 'receipt must name an actual authored native request');
    assert.equal(actualRunID, runID); assert.deepEqual(here, native.target, 'strict native transaction binding requires current target endpoints');
    const published = f.store.read(here.sessionID);
    assert.equal(published.runID, runID); assert.equal(published.sessionID, native.target.sessionID);
    native.projection ??= published;
    assert.deepEqual(receipt, { sourceSessionID: native.source.sessionID, sourceSequence: native.source.sequence,
      sourceDigest: native.source.digest, ownerEpoch: native.epoch, operationID, nativeUserMessageID: [...proofs].find(([, proof]) => proof === native)[0],
      requestDigest: hash(native.text), targetSessionID: native.target.sessionID, targetSequence: 0,
      targetDigest: native.projection.digest, admissionDigest: native.source.admissionDigest, verifiedEpoch: native.epoch + 2 },
    'strict native transaction binding includes generations, digests, epoch and original user authorization');
    assert.equal(published.admissionDigest, native.source.admissionDigest);
    assert.deepEqual(published.transfer, native.projection.transfer);
  };
  await f.transfer(operationID); const previousReceipt = f.ownership.read(runID).adaptiveReceipt;
  const third = { ...f.target, sessionID: 'third' }, source = f.store.read('target');
  proofs.set('third-user', { source, target: third, text: f.request('target'), epoch: f.ownership.read(runID).epoch });
  const recoveryText = `Recover adaptive transfer sourceSessionID=target runID=${runID} operationID=${operationID} action=finish. The transfer stopped; reconcile only this operation.`;
  f.inspect.intake = async (here, text, messageID, scope) => {
    assert.deepEqual(here, third); assert.equal(scope, 'latest');
    if (messageID === 'third-message') { assert.equal(text, proofs.get('third-user').text); return 'third-user'; }
    assert.equal(messageID, 'third-recovery-message'); assert.equal(text, recoveryText); return 'third-recovery-user';
  };
  f.arm('commit', 'before');
  await assert.rejects(f.runner.transferAdaptiveInternal({ sourceSessionID: 'target', runID, operationID, messageID: 'third-message' }, third), /unconfirmed/);
  const fenced = f.ownership.read(runID), projected = f.store.read('third');
  assert.equal(fenced.state, 'transferring'); assert.deepEqual(fenced.adaptiveReceipt, previousReceipt);
  assert.equal(projected.sequence, 0); assert.equal(projected.transfer.sourceDigest, source.digest);
  assert.equal(f.progress.read('third'), undefined, 'runtime progress is not exposed before ownership finish');
  await assert.rejects(f.inspect.confirmAdaptiveTransfer(third, previousReceipt, runID), /strict native transaction binding/);
  assert.deepEqual(f.ownership.read(runID), fenced); assert.deepEqual(f.store.read('third'), projected);
  inspected.length = 0;
  const cold = f.cold(), recovery = { sourceSessionID: 'target', runID, operationID, action: 'finish', messageID: 'third-recovery-message' };
  const status = await cold.recoverAdaptiveTransferInternal(recovery, third);
  const owner = f.ownership.read(runID), receipt = owner.adaptiveReceipt;
  assert.equal(status.runID, runID); assert.deepEqual(status.selection.completed, ['A1']); assert.equal(status.task, undefined);
  assert.equal(owner.state, 'idle'); assert.equal(owner.ownerSessionID, 'third'); assert.equal(owner.epoch, fenced.epoch + 1);
  assert.equal(receipt.sourceSequence, source.sequence); assert.equal(receipt.sourceDigest, source.digest);
  assert.equal(receipt.targetDigest, projected.digest); assert.equal(receipt.ownerEpoch, source.transfer.ownerEpoch + 2);
  assert.ok(inspected.length >= 2, 'finish and cold target restore independently inspect native provenance');
  assert.ok(inspected.every(item => item.sourceSessionID === 'target' && item.targetSessionID === 'third' && item.nativeUserMessageID === 'third-user'));
  assert.deepEqual(f.ownership.confirmAdaptiveReceipt(runID, 'third', f.store), receipt);
  assert.deepEqual(f.ownership.parentClaim('third').transfer, { ...projected.transfer,
    adaptive: { targetDigest: projected.digest, admissionDigest: projected.admissionDigest } });
  assert.deepEqual(f.progress.read('third'), { ...f.progress.read('target'), userMessageID: 'third-user' });
  assert.deepEqual(f.store.read('third').data.receipts, source.data.receipts);
  await cold.recoverAdaptiveTransferInternal(recovery, third);
  assert.deepEqual(f.ownership.read(runID).adaptiveReceipt, receipt, 'exact repeated finish retains the current committed receipt');
});

for (const field of ['ownerEpoch', 'sourceSequence', 'sourceDigest', 'targetDigest']) {
  test(`AL-04b P2: repeated endpoint recovery refuses a prior receipt against changed ${field} binding`, async t => {
    const f = fixture(t); await f.admit(); await f.transfer(); const runID = f.store.read('source').runID;
    const owner = f.ownership.read(runID), target = f.store.read('target'), parent = f.ownership.parentClaim('target');
    if (field === 'targetDigest') parent.transfer.adaptive.targetDigest = 'a'.repeat(64);
    else parent.transfer[field] = typeof parent.transfer[field] === 'number' ? parent.transfer[field] + 1 : 'a'.repeat(64);
    f.local.updateStrict(`.mdd/parent-owner-${hash('target')}.json`, () => JSON.stringify(parent), 4096);
    let nativeInspections = 0;
    f.inspect.confirmAdaptiveTransfer = async (here, receipt, actualRunID) => {
      nativeInspections++; assert.deepEqual(here, f.target); assert.equal(actualRunID, runID); assert.deepEqual(receipt, owner.adaptiveReceipt);
      throw new Error('An old receipt cannot approve a changed transaction binding.');
    };
    await assert.rejects(f.recover('finish', f.cold()), /receipt|lineage/i);
    assert.equal(nativeInspections, 0, 'epoch and generation/digest lineage must be confirmed before selecting a completed receipt');
    assert.deepEqual(f.ownership.read(runID), owner); assert.deepEqual(f.store.read('target'), target);
    assert.equal(f.progress.read('target'), undefined);
  });
}
