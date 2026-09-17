import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeTools } from '../dist/native-tools.js';
import { toolTargets } from '../dist/phase-policy.js';
import { corroborate } from '../dist/phase-evidence.js';

function root(t) { const root = mkdtempSync(join(tmpdir(), 'mdd-native-tool-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
for (const tool of ['edit', 'write', 'apply_patch']) {
  test(`native ${tool} evidence requires actual scoped byte changes and exact history`, t => {
    const path = root(t); const filePath = join(path, 'file.txt'); writeFileSync(filePath, 'before');
    const args = tool === 'apply_patch' ? { patchText: '*** Begin Patch\n*** Update File: file.txt\n@@\n-before\n+after\n*** End Patch' } : { filePath, oldString: 'before', newString: 'after', content: 'after' };
    const tools = new NativeTools();
    tools.before('child', 'call', path, 'mdd-apply', tool, args);
    writeFileSync(filePath, 'after');
    const output = { output: 'Native edit completed', metadata: { truncated: false } };
    tools.after('child', 'call', tool, args, output);
    const parts = [{ callID: 'call', tool, state: { status: 'completed', input: args, ...output } }];
    assert.deepEqual(tools.evidence('child', parts).changes, [{ callID: 'call', paths: [filePath] }]);
    parts[0].state.output = 'forged'; assert.throws(() => tools.evidence('child', parts));
  });
}
test('unchanged native write earns no implementation credit; invented result cannot replace execution', t => {
  const path = root(t); const filePath = join(path, 'file.txt'); writeFileSync(filePath, 'same');
  const tools = new NativeTools(); const args = { filePath, content: 'same' }; const output = { output: 'success', metadata: {} };
  assert.throws(() => tools.after('child', 'forged', 'write', args, output));
  tools.before('child', 'call', path, 'mdd-apply', 'write', args); tools.after('child', 'call', 'write', args, output);
  const evidence = tools.evidence('child', [{ callID: 'call', tool: 'write', state: { status: 'completed', input: args, ...output } }]);
  assert.equal(evidence.changes.length, 0);
  assert.throws(() => corroborate('mdd-apply', { changes: ['call'] }, evidence, []));
});
test('linked edit directories and hardlinked files never become write targets', t => {
  const path = root(t); const actual = join(path, 'actual'); mkdirSync(actual);
  const linked = join(path, 'linked'); symlinkSync(actual, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => toolTargets(path, 'mdd-apply', 'write', { filePath: join(linked, 'file.txt') }));
  const file = join(actual, 'file.txt'); writeFileSync(file, 'same'); const hard = join(path, 'hard.txt'); linkSync(file, hard);
  assert.throws(() => toolTargets(path, 'mdd-apply', 'write', { filePath: hard }));
});
test('nonzero or unknown native bash result blocks before further executions', t => {
  const path = root(t);
  for (const exit of [1, null, undefined, '0']) {
    const tools = new NativeTools(); const args = { command: 'npm test' };
    tools.before('child', 'call', path, 'mdd-verify', 'bash', args);
    assert.throws(() => tools.after('child', 'call', 'bash', args, { output: 'check', metadata: { output: 'check', exit, truncated: false } }));
  }
});
test('Verify cannot omit planned commands or turn empty references into a check', () => {
  const evidence = { childID: 'child', readCalls: [], changes: [], checks: [{ callID: 'check', command: 'npm test', exit: 0, output: 'passed' }] };
  assert.throws(() => corroborate('mdd-verify', { checks: [] }, evidence, [{ id: 'task', path: 'file', check: 'npm test' }]));
  assert.throws(() => corroborate('mdd-verify', { checks: [{ callID: 'check', command: 'npm test' }] }, evidence, [{ id: 'task', path: 'file', check: 'npm run lint' }]));
});

test('native edits fully reverted in the same phase earn no net implementation evidence', t => {
  const rootPath = root(t); const filePath = join(rootPath, 'file.txt'); writeFileSync(filePath, 'original');
  const tools = new NativeTools(); const parts = [];
  for (const [callID, content] of [['change', 'changed'], ['revert', 'original']]) {
    const args = { filePath, content }; const output = { output: 'Native write completed.', metadata: {} };
    tools.before('child', callID, rootPath, 'mdd-apply', 'write', args);
    writeFileSync(filePath, content); tools.after('child', callID, 'write', args, output);
    parts.push({ tool: 'write', callID, state: { status: 'completed', input: args, ...output } });
  }
  assert.equal(tools.evidence('child', parts).changes.length, 0);
});
