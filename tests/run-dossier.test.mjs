import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunDossierStore, DOSSIER_MAX_BYTES, DOSSIER_VERSION } from '../dist/run-dossier.js';

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
