import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProgressGuard } from '../dist/progress.js';
import { PhaseRunner } from '../dist/phase-runner.js';
import { memoryServer, request } from './adapter-fixture.mjs';

test('plural progress round-trips exact member calls and rejects duplicate/cross-batch identities', t => {
  const directory = mkdtempSync(join(tmpdir(), 'mdd-worker-progress-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const guard = new ProgressGuard(directory);
  const marker = { runID: 'run', callID: 'batch', attemptID: 'batch', workerCalls: ['one', 'two'], state: 'pending', userMessageID: 'user' };
  guard.write('parent', marker); assert.deepEqual(guard.read('parent'), marker);
  for (const workerCalls of [['one', 'one'], ['batch'], ['one', 'two', 'three']]) assert.throws(() => guard.write('parent', { ...marker, workerCalls }));
  assert.throws(() => guard.write('parent', { ...marker, attemptID: 'wrong' }));
});

const marker = { runID: 'run', callID: 'call', state: 'pending', userMessageID: 'native-user' };
function root(t) { const path = mkdtempSync(join(tmpdir(), 'mdd-progress-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path; }
function file(path, parent) { return join(path, '.mdd', `progress-${createHash('sha256').update(parent).digest('hex')}.json`); }
test('progress stores only minimal correlation; pending unrelated parents are independent', t => {
  const path = root(t); const guard = new ProgressGuard(path);
  assert.equal(guard.read('parent'), undefined); assert.deepEqual(readdirSync(path), []);
  guard.write('parent', marker);
  assert.deepEqual(JSON.parse(readFileSync(file(path, 'parent'), 'utf8')), marker);
  assert.equal(guard.read('independent'), undefined);
  assert.throws(() => guard.write('parent', { ...marker, prompt: 'must not be written' }));
  assert.deepEqual(guard.read('parent'), marker);
});
test('corrupt old-parent marker does not poison a new independent parent', t => {
  const path = root(t); const guard = new ProgressGuard(path); guard.write('old', marker);
  writeFileSync(file(path, 'old'), 'private malformed content');
  assert.throws(() => guard.read('old'), error => !error.message.includes('private malformed content'));
  assert.equal(guard.read('new'), undefined); guard.write('new', marker); assert.deepEqual(guard.read('new'), marker);
});
test('progress never follows a linked metadata directory', t => {
  const path = root(t); const outside = root(t);
  symlinkSync(outside, join(path, '.mdd'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => new ProgressGuard(path).write('parent', marker)); assert.deepEqual(readdirSync(outside), []);
});
test('work that ended frees the conversation; only the same request cannot silently replay', async t => {
  const path = root(t); const guard = new ProgressGuard(path); const { endpoint, binding } = await memoryServer(t);
  binding.directory = path;
  const runtime = { sessionID: 'ses_parent', agent: 'mdd-orchestrator', directory: path, worktree: path };
  const runner = () => new PhaseRunner({ parent: async () => {}, result: async () => '{}' }, { progress: guard });
  for (const state of ['settled', 'complete']) {
    guard.write(runtime.sessionID, { ...marker, state });
    assert.equal(runner().status(runtime.sessionID).state, 'not-started');
    await assert.rejects(runner().start(request(endpoint), runtime, { requirementsConfirmed: true, userMessageID: marker.userMessageID }));
    assert.equal((await runner().start(request(endpoint), runtime, { requirementsConfirmed: true, userMessageID: 'new-user' })).state, 'ready');
  }
});
test('reset after restart requires host evidence that the previous child stopped', async t => {
  const path = root(t); const guard = new ProgressGuard(path); const { endpoint, binding } = await memoryServer(t);
  binding.directory = path;
  const runtime = { sessionID: 'ses_parent', agent: 'mdd-orchestrator', directory: path, worktree: path };
  let stopped = false;
  const runner = new PhaseRunner({ parent: async () => {}, result: async () => '{}', stopped: async () => stopped }, { progress: guard });
  guard.write(runtime.sessionID, marker);
  const status = runner.status(runtime.sessionID);
  assert.equal(status.state, 'recovery-blocked');
  assert.equal(status.recoverable, true);
  await assert.rejects(runner.start(request(endpoint), runtime, { requirementsConfirmed: true, userMessageID: 'new-user' }), /mdd_reset/);
  await runner.confirmStopped(runtime.sessionID, runtime);
  assert.throws(() => runner.reset(runtime.sessionID, 'run'), /unconfirmed liveness/);
  await assert.rejects(runner.explore({ purpose: 'Inspect while a writer may still be live.' }, runtime), /unconfirmed liveness/);
  assert.deepEqual(guard.read(runtime.sessionID), marker);
  stopped = true;
  await runner.confirmStopped(runtime.sessionID, runtime);
  assert.deepEqual(runner.reset(runtime.sessionID, 'run'), { scope: 'run' });
  assert.equal(guard.read(runtime.sessionID), undefined);
  assert.equal(runner.status(runtime.sessionID).state, 'not-started');
  assert.equal((await runner.start(request(endpoint), runtime, { requirementsConfirmed: true, userMessageID: 'new-user' })).state, 'ready');
});
test('pending inline work without a call ID has unknown liveness and needs explicit user release', async t => {
  const path = root(t); const guard = new ProgressGuard(path);
  const runtime = { sessionID: 'ses_parent', agent: 'mdd-orchestrator', directory: path, worktree: path };
  const runner = new PhaseRunner({ parent: async () => {}, result: async () => '{}',
    liveness: async () => { throw new Error('No child may be probed for inline work.'); } }, { progress: guard });
  guard.write(runtime.sessionID, { runID: 'run', state: 'pending', userMessageID: 'native-user' });
  assert.equal((await runner.confirmStopped(runtime.sessionID, runtime)).verdict, 'unknown');
  assert.equal(guard.read(runtime.sessionID).state, 'pending');
  assert.throws(() => runner.reset(runtime.sessionID, 'run'), /unconfirmed liveness/);
  const released = await runner.confirmStopped(runtime.sessionID, runtime, true);
  assert.equal(released.verdict, 'unknown');
  assert.match(released.detail, /user attestation/);
  assert.equal(guard.read(runtime.sessionID).state, 'settled');
  assert.deepEqual(runner.reset(runtime.sessionID, 'run'), { scope: 'run' });
});
// The user interrupted the subagent and knows it stopped; OpenCode kept no trace that proves it.
// Their own latest message releases it, after MDD asks OpenCode to stop it for certain. Only
// positive evidence that it still works outranks their word.
test('the user who interrupted a subagent can release it; a busy host still refuses', async t => {
  const path = root(t); const guard = new ProgressGuard(path);
  const runtime = { sessionID: 'ses_parent', agent: 'mdd-orchestrator', directory: path, worktree: path };
  let verdict = 'unknown';
  const aborted = [];
  const inspect = {
    parent: async () => {}, result: async () => '{}',
    liveness: async () => ({ verdict, child: 'ses_child', detail: `host says ${verdict}` }),
    abort: async (_runtime, child) => { aborted.push(child); },
  };
  const runner = new PhaseRunner(inspect, { progress: guard });
  guard.write(runtime.sessionID, marker);
  assert.deepEqual(await runner.probe(runtime.sessionID, runtime), { verdict: 'unknown', child: 'ses_child', detail: 'host says unknown' });
  // Without the user's word, unknown still reserves the writer, and the refusal says how to go on.
  await runner.confirmStopped(runtime.sessionID, runtime);
  assert.throws(() => runner.reset(runtime.sessionID, 'run'), /unconfirmed liveness[\s\S]*userText/);
  // A host that reports the child working is not overruled, even after being asked to stop it.
  verdict = 'running';
  assert.equal((await runner.confirmStopped(runtime.sessionID, runtime, true)).verdict, 'running');
  assert.deepEqual(aborted, ['ses_child']);
  assert.deepEqual(guard.read(runtime.sessionID), marker);
  // Once the host no longer reports it busy, the user's word releases it.
  verdict = 'unknown';
  assert.equal((await runner.confirmStopped(runtime.sessionID, runtime, true)).verdict, 'unknown');
  assert.equal(guard.read(runtime.sessionID).state, 'settled');
  assert.deepEqual(runner.reset(runtime.sessionID, 'run'), { scope: 'run' });
});

test('a live dispatch interrupted in this process is released by the user and keeps its run', async t => {
  const path = root(t); const { endpoint, binding } = await memoryServer(t);
  binding.directory = path;
  const runtime = { sessionID: 'ses_parent', agent: 'mdd-orchestrator', directory: path, worktree: path };
  let verdict = 'unknown';
  const inspect = { parent: async () => {}, result: async () => '{}', liveness: async () => ({ verdict, detail: `host says ${verdict}` }) };
  const runner = new PhaseRunner(inspect, { progress: new ProgressGuard(path) });
  const ready = await runner.start(request(endpoint), runtime, { requirementsConfirmed: true, userMessageID: 'native-user' });
  const call = { sessionID: runtime.sessionID, callID: 'interrupted' };
  await runner.before(call, ready.task);
  assert.equal(runner.status(runtime.sessionID).state, 'await-result');
  assert.throws(() => runner.reset(runtime.sessionID, 'phase'), /may still be running[\s\S]*userText/);
  await runner.confirmStopped(runtime.sessionID, runtime, true);
  const released = runner.status(runtime.sessionID);
  assert.equal(released.state, 'blocked');
  assert.match(released.reason, /user confirmed the interrupted subagent stopped/);
  const again = runner.reset(runtime.sessionID, 'phase');
  assert.equal(again.scope, 'phase');
  assert.equal(runner.status(runtime.sessionID).state, 'ready');
  assert.equal(runner.status(runtime.sessionID).runID, ready.runID);
});

test('a pending old conversation does not prevent a different native parent from starting', async t => {
  const path = root(t); const guard = new ProgressGuard(path); guard.write('old-parent', marker);
  const { endpoint, binding } = await memoryServer(t); binding.directory = path; binding.id = 'new-parent';
  const runner = new PhaseRunner({ parent: async () => {}, result: async () => '{}' }, { progress: guard });
  const runtime = { sessionID: binding.id, agent: 'mdd-orchestrator', directory: path, worktree: path };
  assert.equal((await runner.start(request(endpoint), runtime, { requirementsConfirmed: true, userMessageID: 'actual-new-user' })).state, 'ready');
  assert.deepEqual(guard.read('old-parent'), marker);
});
