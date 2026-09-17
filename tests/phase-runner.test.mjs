import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PhaseRunner } from '../dist/phase-runner.js';
import { memoryServer, request, result, runtime, call, answers, installCleanup } from './adapter-fixture.mjs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function fixture(t, fault) {
  const memory = await memoryServer(t, fault);
  const inspect = { parent: async () => {}, result: async (_runtime, _call, _phase, output) => output };
  const runner = new PhaseRunner(inspect);
  return { ...memory, inspect, runner };
}

for (const explore of [false, true]) {
  test(`runner contract: bound ${explore ? 'explore' : 'plan'}, immutable state, exact next phase`, async t => {
    const { runner, endpoint, writes } = await fixture(t);
    const input = request(endpoint, explore);
    const ready = await runner.start(input, runtime);
    input.preflight.answers = { ...answers, mode: 'interactive' };
    ready.workflow.answers.summary = 'detailed';
    assert.equal(runner.status(runtime.sessionID).workflow.answers.summary, 'low');
    assert.equal(ready.phase, explore ? 'mdd-explore' : 'mdd-plan');
    const args = await runner.before(call, ready.task);
    assert.match(args.prompt, /Native callID="call_one"/);
    assert.equal(writes.length, 1);
    await runner.after(call, args, result(ready));
    const done = runner.status(runtime.sessionID);
    assert.equal(done.state, 'ready');
    assert.ok(done.artifact.content.startsWith(JSON.parse(result(ready)).artifact));
    if (!explore) assert.match(done.artifact.content, /Acceptance and plan links/);
    assert.equal(done.artifact.ref.store, 'none');
    done.artifact.content = 'changed';
    assert.notEqual(runner.status(runtime.sessionID).artifact.content, 'changed');
    assert.equal(Object.hasOwn(JSON.parse(writes[1].content), 'artifact'), false);
    assert.ok(!writes[1].content.includes(JSON.parse(result(ready)).artifact));
    assert.equal(done.workflow.results.length, 1);
    assert.equal(done.next.kind, 'execute');
    assert.equal(writes.length, 2);
    assert.equal(JSON.parse(writes[1].content).storage, 'general-workflow-context-only');
    assert.equal(JSON.parse(writes[0].content).requirements, input.requirements);
    await assert.rejects(runner.before({ ...call, callID: 'two' }, { ...args, subagent_type: 'mdd-apply' }));
    await assert.rejects(runner.start(request(endpoint), runtime), /already/);
  });
}

test('runner contract: high route starts only explore and preserves profile validation', async t => {
  const { runner, endpoint } = await fixture(t);
  const input = request(endpoint);
  input.preflight = { profile: { answers: { ...answers, certainty: 'not-sure', summary: 'detailed' } } };
  const ready = await runner.start(input, runtime);
  assert.equal(ready.workflow.evaluation.route, 'high');
  assert.equal(ready.phase, 'mdd-explore');
});

test('runner contract: invalid preflight or non-orchestrator performs no memory writes', async t => {
  const { runner, endpoint, writes } = await fixture(t);
  await assert.rejects(runner.start(request(endpoint), { ...runtime, agent: 'build' }));
  await assert.rejects(runner.start({ ...request(endpoint), preflight: { answers: {} } }, runtime));
  await assert.rejects(runner.start({ ...request(endpoint), sessionID: 'forged' }, runtime));
  assert.equal(writes.length, 0);
});

test('runner contract: unrelated tasks untouched; MDD outside registered parent rejected', async () => {
  const runner = new PhaseRunner({});
  assert.equal(await runner.before(call, { subagent_type: 'general' }), undefined);
  await runner.after(call, {}, {});
  await assert.rejects(runner.before(call, { subagent_type: 'mdd-plan' }), /registered/);
});

for (const mutate of [
  args => ({ ...args, background: false }), args => ({ ...args, task_id: 'ses_old' }),
  args => ({ ...args, command: 'x' }), args => ({ ...args, subagent_type: 'mdd-apply' }),
  args => ({ ...args, prompt: 'different' }), args => ({ ...args, description: 'different' }),
]) {
  test(`runner contract: strict native arguments reject ${mutate({}).toString()} ${JSON.stringify(mutate({}))}`, async t => {
    const { runner, endpoint, writes } = await fixture(t);
    const ready = await runner.start(request(endpoint), runtime);
    await assert.rejects(runner.before(call, mutate(ready.task)));
    assert.equal(runner.status(runtime.sessionID).state, 'ready');
    assert.deepEqual(runner.status(runtime.sessionID).task, ready.task);
    assert.equal(writes.length, 0);
  });
}

test('runner contract: racing dispatches never both admit, and the phase stays runnable', async t => {
  const { runner, endpoint, inspect } = await fixture(t);
  const ready = await runner.start(request(endpoint), runtime);
  let release;
  inspect.parent = () => new Promise(resolve => { release = resolve; });
  const first = runner.before(call, ready.task);
  await assert.rejects(runner.before({ ...call, callID: 'two' }, ready.task));
  release();
  await assert.rejects(first);
  const after = runner.status(runtime.sessionID);
  assert.equal(after.state, 'ready');
  assert.equal(after.workflow.nextAction.kind, 'execute');
  assert.equal(after.workflow.results.length, 0);
  assert.deepEqual(after.task, ready.task);
});

for (const kind of ['intent-write', 'intent-read', 'result-write', 'result-read']) {
  test(`runner contract: ${kind} failure never advances the workflow but leaves the phase runnable`, async t => {
    const { runner, endpoint } = await fixture(t, (req, reply, writes) => {
      const ordinal = kind.startsWith('intent') ? 1 : 2;
      if (writes.length === ordinal && (kind.endsWith('write') ? req.method === 'POST' : req.url.startsWith('/observations/'))) reply.status = 500;
    });
    const ready = await runner.start(request(endpoint), runtime);
    if (kind.startsWith('intent')) await assert.rejects(runner.before(call, ready.task));
    else {
      const args = await runner.before(call, ready.task);
      await assert.rejects(runner.after(call, args, result(ready)));
    }
    const stopped = runner.status(runtime.sessionID);
    assert.equal(stopped.state, 'ready');
    assert.equal(stopped.attempts, 1);
    assert.equal(stopped.workflow.nextAction.kind, 'execute');
    assert.equal(stopped.workflow.results.length, 0);
    assert.deepEqual(stopped.task, ready.task);
    await assert.rejects(runner.start(request(endpoint), runtime));
  });
}

// A clean code fence is a syntactic wrapper that changes no validated field, so it is
// unwrapped instead of failing a whole phase. Anything around it stays invalid.
test('runner contract: a fenced envelope is unwrapped; prose around it is not', async t => {
  const { runner, endpoint } = await fixture(t);
  const ready = await runner.start(request(endpoint), runtime);
  const args = await runner.before(call, ready.task);
  const text = result(ready);
  await runner.after(call, args, `\`\`\`json\n${text}\n\`\`\``);
  assert.equal(runner.status(runtime.sessionID).workflow.results.length, 1);
});
for (const invalid of [
  text => `Here it is:\n\`\`\`json\n${text}\n\`\`\``, text => `\`\`\`json\n${text}\n\`\`\`\ndone`,
  () => '{}', () => 'not JSON',
  text => JSON.stringify({ ...JSON.parse(text), phase: 'mdd-apply' }),
  text => JSON.stringify({ ...JSON.parse(text), runID: 'wrong' }),
  text => JSON.stringify({ ...JSON.parse(text), callID: 'wrong' }),
  text => JSON.stringify({ ...JSON.parse(text), outcome: 'unknown' }),
  text => JSON.stringify({ ...JSON.parse(text), evidenceSummary: '' }),
  text => JSON.stringify({ ...JSON.parse(text), artifact: '' }),
  text => JSON.stringify({ ...JSON.parse(text), artifact: 'x'.repeat(16001) }),
  text => JSON.stringify({ ...JSON.parse(text), extra: true }),
]) {
  test(`runner contract: invalid bound result ${invalid.toString().slice(0, 95)}`, async t => {
    const { runner, endpoint, writes } = await fixture(t);
    const ready = await runner.start(request(endpoint), runtime);
    const args = await runner.before(call, ready.task);
    await assert.rejects(runner.after(call, args, invalid(result(ready))));
    assert.equal(runner.status(runtime.sessionID).workflow.results.length, 0);
    assert.equal(writes.length, 1);
  });
}

test('runner contract: failed agent phase is saved before recording and blocks', async t => {
  const { runner, endpoint, writes } = await fixture(t);
  const ready = await runner.start(request(endpoint), runtime);
  const args = await runner.before(call, ready.task);
  await runner.after(call, args, result(ready, 'failed'));
  assert.equal(runner.status(runtime.sessionID).workflow.nextAction.kind, 'blocked');
  assert.equal(writes.length, 2);
});

test('runner contract: missing after remains pending; only the matching native error releases it', async t => {
  const { runner, endpoint } = await fixture(t);
  const ready = await runner.start(request(endpoint), runtime);
  await runner.before(call, ready.task);
  runner.nativeError('other', call.callID);
  runner.nativeError(call.sessionID, 'other');
  assert.equal(runner.status(runtime.sessionID).state, 'await-result');
  runner.nativeError(call.sessionID, call.callID);
  const released = runner.status(runtime.sessionID);
  assert.equal(released.state, 'ready');
  assert.equal(released.uncertain, false);
  assert.equal(released.workflow.results.length, 0);
});

test('runner contract: mismatched and duplicate after cannot record a result', async t => {
  const { runner, endpoint } = await fixture(t);
  const ready = await runner.start(request(endpoint), runtime);
  const args = await runner.before(call, ready.task);
  await runner.after({ ...call, sessionID: 'other' }, args, result(ready));
  assert.equal(runner.status(runtime.sessionID).state, 'await-result');
  await assert.rejects(runner.after({ ...call, callID: 'other' }, args, result(ready)));
  await assert.rejects(runner.after(call, args, result(ready)));
  assert.equal(runner.status(runtime.sessionID).workflow.results.length, 0);
});

test('runner contract: failed initialization remains blocked and repeated start cannot reset it', async t => {
  const { runner, endpoint, inspect, writes } = await fixture(t);
  inspect.parent = async () => { throw new Error('Permission or binding changed.'); };
  await assert.rejects(runner.start(request(endpoint), runtime));
  await assert.rejects(runner.start(request(endpoint), runtime), /already/);
  assert.equal(runner.status(runtime.sessionID).state, 'blocked');
  assert.equal(writes.length, 0);
});

test('runner contract: concurrent result callbacks cannot both persist or advance', async t => {
  const { runner, endpoint, inspect, writes } = await fixture(t);
  const ready = await runner.start(request(endpoint), runtime);
  const args = await runner.before(call, ready.task);
  let release;
  inspect.result = () => new Promise(resolve => { release = resolve; });
  const first = runner.after(call, args, result(ready));
  await assert.rejects(runner.after(call, args, result(ready)));
  release(result(ready));
  await assert.rejects(first);
  assert.equal(runner.status(runtime.sessionID).workflow.results.length, 0);
  assert.equal(writes.length, 1);
});

for (const store of ['none', 'engram', 'openspec', 'both']) {
  test(`runner artifact contract: ${store} uses independent compact memory and selected artifact backend`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'mdd-runner-artifacts-'));
    installCleanup(root);
    t.after(() => rm(root, { recursive: true, force: true }));
    const { runner, endpoint, writes, binding } = await fixture(t);
    binding.directory = root;
    const input = request(endpoint);
    input.preflight.answers = { ...answers, artifactStore: store };
    const ready = await runner.start(input, { ...runtime, directory: root, worktree: root });
    const args = await runner.before(call, ready.task);
    await runner.after(call, args, result(ready));
    const status = runner.status(runtime.sessionID);
    assert.equal(status.state, 'ready');
    assert.equal(status.artifact.ref.store, store);
    assert.ok(status.artifact.content.startsWith(JSON.parse(result(ready)).artifact));
    assert.match(status.artifact.content, /Acceptance and plan links/);
    const general = writes.filter(write => write.type === 'workflow');
    assert.equal(general.length, 2);
    assert.ok(general.every(write => !write.content.includes(status.artifact.content)));
    assert.equal(JSON.parse(general[1].content).artifactRef.digest, status.artifact.ref.digest);
    assert.equal(writes.filter(write => write.type === 'mdd-artifact').length, ['engram', 'both'].includes(store) ? 1 : 0);
    if (['openspec', 'both'].includes(store)) assert.ok((await stat(join(root, 'openspec'))).isDirectory());
    else await assert.rejects(stat(join(root, 'openspec')), { code: 'ENOENT' });
  });
}

test('runner artifact contract: both partial failure exposes attempts without general result or advancement', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mdd-runner-partial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { runner, endpoint, binding, writes } = await fixture(t, (req, reply, writes) => {
    if (req.method === 'POST' && writes.at(-1)?.type === 'mdd-artifact') reply.status = 500;
  });
  binding.directory = root;
  const input = request(endpoint);
  input.preflight.answers = { ...answers, artifactStore: 'both' };
  const ready = await runner.start(input, { ...runtime, directory: root, worktree: root });
  const args = await runner.before(call, ready.task);
  await assert.rejects(runner.after(call, args, result(ready)));
  const status = runner.status(runtime.sessionID);
  assert.equal(status.state, 'ready');
  assert.equal(status.workflow.results.length, 0);
  assert.equal(status.artifactAttempts[0].backend, 'openspec');
  assert.equal(status.artifactAttempts[0].status, 'confirmed');
  assert.equal(status.artifactAttempts[1].backend, 'engram');
  assert.equal(status.artifactAttempts[1].status, 'unknown');
  assert.equal(writes.filter(write => write.type === 'workflow').length, 1);
  await assert.rejects(runner.before(call, ready.task));
});

test('runner telemetry uses controlled timestamps/duration and never marks the next phase passed', async t => {
  const { endpoint } = await memoryServer(t);
  const events = [];
  let clock = 100;
  const runner = new PhaseRunner({ parent: async () => {}, result: async (_r, _c, _p, output) => output }, {
    now: () => clock, telemetry: (_root, event) => { events.push(event); return { ok: true, enabled: true, count: events.length, retentionDays: 30 }; },
  });
  const ready = await runner.start(request(endpoint), runtime, { requirementsConfirmed: true });
  clock = 110; const args = await runner.before(call, ready.task);
  clock = 125; await runner.after(call, args, result(ready));
  assert.deepEqual(events.find(event => event.event === 'phase-end'), { timestamp: 125, event: 'phase-end', phase: 'mdd-plan', route: 'low', outcome: 'passed', duration: 15 });
  assert.ok(!events.some(event => event.phase === 'mdd-apply' && event.outcome === 'passed'));
  const count = events.length; runner.status(runtime.sessionID); runner.status(runtime.sessionID); assert.equal(events.length, count);
});
test('runner telemetry exceptions remain bounded diagnostics without changing successful state', async t => {
  const { endpoint } = await memoryServer(t);
  const runner = new PhaseRunner({ parent: async () => {}, result: async (_r, _c, _p, output) => output }, { telemetry: () => { throw new Error('secret raw storage error'); } });
  const ready = await runner.start(request(endpoint), runtime, { requirementsConfirmed: true });
  assert.equal(ready.state, 'ready'); assert.equal(ready.telemetryDiagnostic, 'telemetry-unavailable');
  assert.ok(!JSON.stringify(ready).includes('secret raw storage error'));
});

test('a stopped investigation names its real reason and can be asked again', async t => {
  const { runner } = await fixture(t);
  await runner.explore({ purpose: 'Buscar el issue 389.' }, runtime);
  await runner.before(call, runner.status(runtime.sessionID).task);
  runner.block(runtime.sessionID, 'A tool in the delegated phase failed or was interrupted.');
  // A stopped investigation is finished, not in flight: it must not make the parent look busy.
  const stopped = runner.status(runtime.sessionID);
  assert.equal(stopped.state, 'not-started');
  assert.match(stopped.contextualReason, /failed or was interrupted/);
  await runner.explore({ purpose: 'Preguntar otra cosa.' }, runtime);
  assert.equal(runner.status(runtime.sessionID).task.subagent_type, 'mdd-explore');
});

test('the adapter-owned trace section cannot be written by the actor', async t => {
  const { acceptance } = await import('../dist/acceptance.js');
  const { assertNoTraceSection, TRACE_HEADING } = await import('../dist/acceptance.js');
  assert.equal(assertNoTraceSection('# Report\n\nAll good.\n'), '# Report\n\nAll good.\n');
  assert.throws(() => assertNoTraceSection(`# Report\n\n${TRACE_HEADING}\n\n{"accepted": false}\n`),
    /adapter-owned acceptance and plan links/);
  assert.equal(typeof acceptance, 'function');
});
