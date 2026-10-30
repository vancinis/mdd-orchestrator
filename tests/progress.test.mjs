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

