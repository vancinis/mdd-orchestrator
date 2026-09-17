import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProgressGuard } from '../dist/progress.js';
import { PhaseRunner } from '../dist/phase-runner.js';
import { memoryServer, request } from './adapter-fixture.mjs';

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
test('settled but incomplete startup cannot replay; completed startup requires fresh native input', async t => {
  const path = root(t); const guard = new ProgressGuard(path); const { endpoint, binding } = await memoryServer(t);
  binding.directory = path;
  const runtime = { sessionID: 'ses_parent', agent: 'mdd-orchestrator', directory: path, worktree: path };
  const runner = () => new PhaseRunner({ parent: async () => {}, result: async () => '{}' }, { progress: guard });
  guard.write(runtime.sessionID, { ...marker, state: 'settled' });
  assert.equal(runner().status(runtime.sessionID).state, 'recovery-blocked');
  await assert.rejects(runner().start(request(endpoint), runtime, { requirementsConfirmed: true, userMessageID: 'new-user' }));
  guard.write(runtime.sessionID, { ...marker, state: 'complete' });
  await assert.rejects(runner().start(request(endpoint), runtime, { requirementsConfirmed: true, userMessageID: marker.userMessageID }));
  assert.equal((await runner().start(request(endpoint), runtime, { requirementsConfirmed: true, userMessageID: 'new-user' })).state, 'ready');
});
test('a pending old conversation does not prevent a different native parent from starting', async t => {
  const path = root(t); const guard = new ProgressGuard(path); guard.write('old-parent', marker);
  const { endpoint, binding } = await memoryServer(t); binding.directory = path; binding.id = 'new-parent';
  const runner = new PhaseRunner({ parent: async () => {}, result: async () => '{}' }, { progress: guard });
  const runtime = { sessionID: binding.id, agent: 'mdd-orchestrator', directory: path, worktree: path };
  assert.equal((await runner.start(request(endpoint), runtime, { requirementsConfirmed: true, userMessageID: 'actual-new-user' })).state, 'ready');
  assert.deepEqual(guard.read('old-parent'), marker);
});
