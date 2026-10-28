import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, linkSync, rmSync, readdirSync, utimesSync } from 'node:fs';
import { LocalFiles } from '../dist/local-files.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunDossierStore, priorRunView, DOSSIER_MAX_BYTES, DOSSIER_VERSION } from '../dist/run-dossier.js';
import { structuredTraceFixture, structuredVerificationFixture, traceFixture } from './adapter-fixture.mjs';

function root(t) { const path = mkdtempSync(join(tmpdir(), 'mdd-dossier-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path; }
function file(path, parent) { return join(path, '.mdd', `run-${createHash('sha256').update(parent).digest('hex')}.json`); }
function dossier(change = {}) {
  return {
    version: DOSSIER_VERSION, runID: 'run-one',
    parent: { sessionID: 'ses_parent', directory: '/workspace', worktree: '/workspace' },
    userMessageID: 'user-1', requirements: 'Implement a scoped feature and check it.',
    context: [], answers: { certainty: 'very-sure', artifactStore: 'none', mode: 'automatic', summary: 'low', complexity: 'not-complex' },
    route: ['mdd-plan', 'mdd-apply', 'mdd-verify'], phase: 'mdd-apply', lastState: 'ready',
    results: [{ phase: 'mdd-plan', outcome: 'passed', evidenceSummary: 'Planned the scoped change.' }],
    evidence: { requirements: 'confirmed', plan: 'confirmed', implementation: 'unearned', checks: 'unearned' },
    decisions: [], planned: [], executedChecks: [], changedFiles: 0, concerns: [],
    artifacts: [], contexts: [], calls: ['task-1'], questionReceipts: [],
    usedMessages: ['user-1'], proposed: [], timestamp: 1700000000000, ...change,
  };
}

test('a preserved run round-trips and stays confined to its own parent', t => {
  const path = root(t); const store = new RunDossierStore(path);
  assert.equal(store.read('parent'), undefined);
  assert.deepEqual(readdirSync(path), []);
  store.write('parent', dossier());
  assert.deepEqual(store.read('parent'), dossier());
  // One conversation's preserved evidence must never surface in another.
  assert.equal(store.read('unrelated'), undefined);
  store.write('unrelated', dossier({ runID: 'run-two' }));
  assert.equal(store.read('parent').runID, 'run-one');
  assert.equal(store.read('unrelated').runID, 'run-two');
  store.clear('parent');
  assert.equal(store.read('parent'), undefined);
  assert.equal(store.read('unrelated').runID, 'run-two');
});

test('SA-2: dossier retains versioned verification and rejects mixed or contradictory records', t => {
  const store = new RunDossierStore(root(t));
  const trace = structuredTraceFixture(); const report = structuredVerificationFixture(trace);
  const current = dossier({ verificationVersion: 1, acceptance: trace.acceptance, decisions: trace.decisions, planned: trace.deliverables,
    verification: { ...report.verification, matched: true }, executedChecks: report.checks,
    results: [{ phase: 'mdd-verify', outcome: 'passed', evidenceSummary: 'Verified.' }] });
  store.write('parent', current);
  assert.deepEqual(store.read('parent'), current);
  assert.equal(priorRunView(current, 'record').verificationVersion, 1);
  for (const mutate of [
    item => { delete item.verificationVersion; },
    item => { item.verificationVersion = 2; },
    item => { item.planned = traceFixture().deliverables; },
    item => { delete item.verification.checkResults; },
    item => { delete item.executedChecks[0].id; },
    item => { item.verification.matched = false; },
    item => { delete item.verification; },
    item => { item.planned = []; },
  ]) {
    const damaged = structuredClone(current); mutate(damaged);
    assert.throws(() => store.write('parent', damaged));
    assert.deepEqual(store.read('parent'), current, 'invalid evidence cannot replace the retained record');
  }
});

test('SA-2: versioned dossiers cannot omit earned planning or invent unattached execution evidence', t => {
  const store = new RunDossierStore(root(t));
  assert.throws(() => store.write('parent', dossier({ verificationVersion: 1 })), /plan|acceptance/);
  assert.throws(() => store.write('parent', dossier({ verificationVersion: 1, results: [],
    executedChecks: [{ id: 'E1', command: 'npm test', exit: 0 }] })), /verification/);
});

test('SA-2: legacy dossier retains historical matched fields without synthesized proof', t => {
  const store = new RunDossierStore(root(t));
  const legacy = dossier({ planned: traceFixture().deliverables, executedChecks: [{ command: 'npm test', exit: 1 }],
    verification: { matched: true, changes: 'Historical claim.', limits: ['Historical evidence is incomplete.'] } });
  store.write('parent', legacy);
  assert.deepEqual(store.read('parent'), legacy);
  const view = priorRunView(store.read('parent'), 'record');
  assert.match(view.verificationEvidence, /Legacy command-based/);
  assert.equal(Object.hasOwn(view, 'verificationVersion'), false);
  assert.equal(Object.hasOwn(view.executedChecks[0], 'id'), false);
});

test('a corrupt record fails closed without leaking what it held', t => {
  const path = root(t); const store = new RunDossierStore(path);
  store.write('old', dossier());
  writeFileSync(file(path, 'old'), 'private malformed content');
  assert.throws(() => store.read('old'), error => !error.message.includes('private malformed content') && /mdd_reset/.test(error.message));
  // A damaged record in one conversation cannot poison an independent one.
  assert.equal(store.read('fresh'), undefined);
  store.write('fresh', dossier());
  assert.deepEqual(store.read('fresh'), dossier());
  // A structurally wrong record is refused on the way in, not silently stored.
  assert.throws(() => store.write('fresh', dossier({ version: 99 })));
  assert.throws(() => store.write('fresh', dossier({ lastState: 'persisting-result' })));
  assert.deepEqual(store.read('fresh'), dossier());
});

test('preserved evidence never follows a linked metadata directory', t => {
  const path = root(t); const outside = root(t);
  symlinkSync(outside, join(path, '.mdd'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => new RunDossierStore(path).write('parent', dossier()));
  assert.deepEqual(readdirSync(outside), []);
});

test('an oversized record sheds artifact bodies rather than losing the plan', t => {
  const path = root(t); const store = new RunDossierStore(path);
  const artifact = index => ({ ref: { runID: 'run-one', phase: 'mdd-plan', recordID: `record-${index}`, digest: 'a'.repeat(64), bytes: 16000, store: 'none' }, content: 'x'.repeat(16000) });
  const many = Array.from({ length: 40 }, (_value, index) => artifact(index));
  store.write('parent', dossier({ artifacts: many }));
  const held = store.read('parent');
  assert.equal(held.artifactContentOmitted, true);
  // Identity survives even when the bodies do not: the refs still name what was produced.
  assert.equal(held.artifacts.length, 40);
  assert.equal(held.artifacts[0].content, undefined);
  assert.equal(held.artifacts[0].ref.recordID, 'record-0');
  assert.deepEqual(held.results, dossier().results);
  assert.ok(Buffer.byteLength(readFileSync(file(path, 'parent'), 'utf8')) <= DOSSIER_MAX_BYTES);
  // Beyond what shedding can rescue the write fails loudly; it never truncates the record.
  assert.throws(() => store.write('parent', dossier({ requirements: 'y'.repeat(DOSSIER_MAX_BYTES + 1) })));
  assert.equal(store.read('parent').artifacts.length, 40);
});

// The user's request has no size limit. A preserved run keeps it whole on disk; its view in status
// shows the opening with the size and digest once nothing else is left to shed.
test('regression: a long request is kept whole in the record and clipped with its digest only in the view', t => {
  const path = root(t); const store = new RunDossierStore(path);
  const requirements = 'Necesito este cambio con todo el detalle que escribí. '.repeat(1000);
  store.write('parent', dossier({ requirements }));
  const held = store.read('parent');
  assert.equal(held.requirements, requirements);
  const view = priorRunView(held, 'record');
  assert.ok(Buffer.byteLength(JSON.stringify(view)) <= 30000);
  assert.equal(view.requirementsClipped, true);
  assert.ok(requirements.startsWith(view.requirements.slice(0, -1)));
  assert.equal(view.requirementsBytes, Buffer.byteLength(requirements));
  assert.equal(view.requirementsSha256, createHash('sha256').update(requirements).digest('hex'));
  assert.equal(priorRunView(dossier(), 'record').requirementsClipped, undefined, 'an ordinary request is shown whole');
});

test('a stale lock from a dead process does not seal the record forever', t => {
  const path = root(t); const store = new RunDossierStore(path);
  store.write('parent', dossier());
  // A process killed mid-write leaves its `wx` lock behind. Without reclamation every later
  // write to this name would fail with EEXIST permanently, which is how a marker stopped working.
  const lock = `${file(path, 'parent')}.lock`;
  writeFileSync(lock, '');
  assert.throws(() => store.write('parent', dossier({ runID: 'run-two' })));
  const old = Date.now() - 120000;
  utimesSync(lock, new Date(old), new Date(old));
  store.write('parent', dossier({ runID: 'run-two' }));
  assert.equal(store.read('parent').runID, 'run-two');
});

function continuedDossier() {
  return dossier({ phase: 'mdd-verify', lastState: 'blocked', results: [{ phase: 'mdd-verify', outcome: 'failed', evidenceSummary: 'Checks failed.' }],
    executedChecks: [{ command: 'npm test', exit: 1 }], usedMessages: ['user-1', 'continue-1'],
    continuation: { kind: 'continue', userMessageID: 'continue-1', userText: 'Continue despite failure.',
      checkpointSequence: 4, checkpointDigest: 'a'.repeat(64), timestamp: 1700000001000 } });
}

test('SA-3: archives are parent/run-bound failed evidence, excluded from live workspace listings', t => {
  const store = new RunDossierStore(root(t)); const entry = continuedDossier();
  const saved = store.archiveContinuation('ses_parent', entry);
  assert.match(saved.file, /^\.mdd\/run-[a-f0-9]{64}\.continued\.json$/);
  assert.deepEqual(store.readContinued('ses_parent', entry.runID), entry);
  assert.equal(store.readContinued('foreign', entry.runID), undefined);
  assert.equal(store.readContinued('ses_parent', 'foreign'), undefined);
  assert.deepEqual(store.recent(10), [], 'continued evidence cannot advertise an active resumable run');
  store.write('ses_parent', dossier({ runID: 'next-run' }));
  assert.deepEqual(store.readContinued('ses_parent', entry.runID), entry);
  assert.deepEqual(store.recent(10).map(item => item.dossier.runID), ['next-run']);
  for (const change of [{ lastState: 'complete' }, { results: [{ phase: 'mdd-verify', outcome: 'passed' }] }, { usedMessages: [] }])
    assert.throws(() => store.archiveContinuation('ses_parent', { ...entry, ...change }));
  assert.deepEqual(store.read('ses_parent'), dossier({ runID: 'next-run' }));
});

test('SA-3: archive failures preserve the live record and reject hardlinks, traversal and unsupported names', t => {
  const path = root(t); const outside = root(t); const store = new RunDossierStore(path);
  const entry = continuedDossier(); store.write('ses_parent', dossier());
  const archive = join(path, '.mdd', `run-${createHash('sha256').update(JSON.stringify(['ses_parent', entry.runID])).digest('hex')}.continued.json`);
  const target = join(outside, 'target'); writeFileSync(target, 'private bytes'); linkSync(target, archive);
  assert.throws(() => store.archiveContinuation('ses_parent', entry));
  assert.equal(readFileSync(target, 'utf8'), 'private bytes');
  assert.deepEqual(store.read('ses_parent'), dossier());
  rmSync(archive);
  assert.throws(() => store.archiveContinuation('ses_parent', { ...entry, requirements: 'x'.repeat(DOSSIER_MAX_BYTES) }));
  assert.deepEqual(store.read('ses_parent'), dossier());
  const files = new LocalFiles(path);
  for (const name of ['../outside', `.mdd/run-${'a'.repeat(64)}.continued.json/../other`, '.mdd/run-short.continued.json',
    `.mdd/run-${'A'.repeat(64)}.continued.json`, `.mdd/run-${'a'.repeat(64)}.other.json`]) assert.throws(() => files.update(name, () => '{}', 100));
  const linkedRoot = root(t);
  symlinkSync(outside, join(linkedRoot, '.mdd'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => new RunDossierStore(linkedRoot).archiveContinuation('ses_parent', entry));
  assert.deepEqual(readdirSync(outside), ['target']);
});
