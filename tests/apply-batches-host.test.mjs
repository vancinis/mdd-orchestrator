import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { privateEnvironment, ScriptedProvider, checkHostEvidence, ancestorConfig, runDeterministicSmoke, fixturePluginSource, scenarioSmoke } from './apply-batches-host-smoke.mjs';

test('host harness strips ambient credentials, sessions, config and temp overrides', () => {
  const root = join(process.cwd(), 'private-fixture');
  const env = privateEnvironment(root, { PATH: 'safe-path', SystemRoot: 'system', OPENAI_API_KEY: 'secret',
    OPENCODE_SERVER: 'ambient', OPENCODE_CONFIG_CONTENT: 'ambient', SSH_AUTH_SOCK: 'ambient',
    HOME: 'ambient', TEMP: 'ambient', APPDATA: 'ambient', NODE_OPTIONS: 'ambient' });
  assert.equal(env.PATH, 'safe-path');
  for (const key of ['OPENAI_API_KEY', 'OPENCODE_SERVER', 'OPENCODE_CONFIG_CONTENT', 'SSH_AUTH_SOCK', 'NODE_OPTIONS']) {
    assert.equal(env[key], undefined, key);
  }
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
    assert.ok(env[key].startsWith(root), key);
  }
});

test('host harness refuses ancestor configuration instead of loading ambient plugins', t => {
  const root = mkdtempSync(join(tmpdir(), 'mdd-ancestor-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const privateRoot = join(root, 'isolated');
  mkdirSync(privateRoot);
  writeFileSync(join(root, 'opencode.json'), 'DO NOT READ');
  assert.equal(ancestorConfig(privateRoot), join(root, 'opencode.json'));
});

const request = (agent, messages, session = 'child') => ({ agent, session, body: { messages } });
const tool = content => ({ role: 'tool', content: JSON.stringify(content) });
test('scripted coordinator follows exact returned nextAction, never invents a batch or approval', () => {
  const provider = new ScriptedProvider('/fixture', 'success');
  const nextAction = { tool: 'subagent', args: { agent: 'mdd-apply', description: 'Second batch', prompt: 'opaque-handle' } };
  assert.deepEqual(provider.respond(request('mdd-orchestrator', [tool({ state: 'ready', nextAction })])).call,
    { name: 'subagent', input: nextAction.args });
  assert.throws(() => provider.respond(request('mdd-orchestrator', [tool({ nextAction: { tool: 'question', args: {} } })])), /approval/);
  assert.throws(() => provider.respond(request('mdd-orchestrator', [tool({ state: 'blocked', nextAction })])), /blocked.*writer/);
  assert.deepEqual(provider.respond(request('mdd-orchestrator', [tool({ state: 'blocked' })])), { text: 'STOP' });
  assert.deepEqual(provider.respond(request('mdd-orchestrator', [tool({ state: 'ready', rejected: { reason: 'Ambiguous completion' } })])), { text: 'STOP' });
});

test('scripted actor consumes expanded assigned-only handoff and runs exactly one checked workload', () => {
  const provider = new ScriptedProvider('/fixture', 'success');
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'Applicable deliverables: [{"id":"second"}]\n' }] }];
  assert.deepEqual(provider.respond(request('mdd-apply', messages)).call, { name: 'smoke_work', input: { step: 'second' } });
  messages.push(tool({ command: 'node check.mjs second', exit: 0 }));
  assert.match(provider.respond(request('mdd-apply', messages)).text, /"completed": \[\s*"second"/);
  assert.throws(() => provider.respond(request('mdd-apply', messages)), /exactly once/);
});

test('native evidence cannot pass with reused identities, speculative writes or missing Verify', () => {
  const events = ['mdd-explore', 'mdd-risk', 'mdd-plan', 'mdd-apply', 'mdd-apply', 'mdd-verify'].map((agent, i) =>
    ({ kind: 'child', agent, sessionID: `child-${i}`, parentID: 'parent', completed: true }));
  const statuses = [{ state: 'ready', phase: 'mdd-apply' }, { state: 'ready', phase: 'mdd-apply' },
    { state: 'ready', phase: 'mdd-verify' }, { state: 'complete' }];
  assert.doesNotThrow(() => checkHostEvidence(events, statuses, 'parent', 'success'));
  assert.throws(() => checkHostEvidence(events.map(e => ({ ...e, sessionID: 'same' })), statuses, 'parent', 'success'));
  assert.throws(() => checkHostEvidence(events.slice(0, 5), statuses, 'parent', 'success'));
  assert.throws(() => checkHostEvidence(events, statuses.map(s => ({ ...s, question: {} })), 'parent', 'success'));
});

for (const scenario of ['success', 'failed', 'ambiguous']) {
}

for (const failurePoint of ['setup', 'host shutdown']) {
  test(`native smoke closes its loopback provider after ${failurePoint} throws (injected host only)`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'mdd-smoke-cleanup-'));
    let provider; let hostStarts = 0; let hostStops = 0;
    // Release a leaked listener even on RED, so the regression itself never hangs the runner.
    t.after(async () => {
      if (provider?.listening) {
        provider.closeAllConnections();
        await new Promise(resolve => provider.close(resolve));
      }
      rmSync(root, { recursive: true, force: true });
    });
    const failure = new Error(`Injected ${failurePoint} failure`);
    const fakeHost = { exitCode: null, stdout: { on() { throw new Error('Injected startup interruption'); } } };
    await assert.rejects(scenarioSmoke('not-an-executable', root, 'success', {
      createProvider(handler) { provider = createServer(handler); return provider; },
      writeSetup(path, content) {
        assert.equal(provider.listening, true, 'Inject only after our loopback provider is acquired.');
        if (failurePoint === 'setup') throw failure;
        writeFileSync(path, content);
      },
      startHost() { hostStarts++; return fakeHost; },
      async stopHost(host) { assert.equal(host, fakeHost); hostStops++; throw failure; },
    }), error => error === failure, 'Cleanup must not turn the injected exception into a passing result.');
    assert.equal(hostStarts, failurePoint === 'setup' ? 0 : 1);
    assert.equal(hostStops, failurePoint === 'setup' ? 0 : 1);
    assert.equal(provider.listening, false, 'Provider must be closed before the scenario rejects.');
  });
}
