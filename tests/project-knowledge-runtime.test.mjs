import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PhaseRunner } from '../dist/phase-runner.js';
import { NativeIntake } from '../dist/native-intake.js';
import { CheckpointStore } from '../dist/checkpoint.js';
import { RunOwnershipStore } from '../dist/run-ownership.js';
import { ProgressGuard } from '../dist/progress.js';
import { defaultSettings } from '../dist/settings.js';
import { captureKnowledgeDependencies, knowledgeObservation, selectKnowledge, supplementKnowledge } from '../dist/project-knowledge.js';
import { answers, memoryServer, throughRiskStop, traceFixture, reportDocument } from './adapter-fixture.mjs';

const objective = 'Inspect parser validation boundaries';
const secretBody = 'PRIVATE_REUSABLE_BODY: parser validation rejects unknown fields.';
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

async function fixture(t, enabled = true) {
  const root = fs.mkdtempSync(join(tmpdir(), 'mdd-knowledge-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(join(root, 'src'));
  for (const name of ['a', 'b']) fs.writeFileSync(join(root, `src/${name}.ts`), `export const ${name} = 1;`);
  const queries = [];
  const provider = await memoryServer(t, (req, reply) => {
    if (!req.url.startsWith('/search?')) return;
    const query = new URLSearchParams(req.url.split('?')[1]).get('q');
    queries.push(query);
    // Contract fake for FTS terms: whitespace ANDs; explicit OR alternatives match independently.
    const alternatives = query.split(' OR ').map(part => part.replaceAll('"', '').toLowerCase().split(/\s+/));
    reply.data = reply.data.filter(row => alternatives.some(terms => terms.every(term =>
      `${row.title} ${row.content}`.toLowerCase().includes(term))));
  });
  provider.binding.directory = root;
  const runtime = { sessionID: provider.binding.id, agent: 'mdd-orchestrator', directory: root, worktree: root };
  const inspect = { parent: async () => {}, result: async (_r, _c, _p, output) => output, stopped: async () => true };
  const checkpoint = new CheckpointStore(root), ownership = new RunOwnershipStore(root);
  const settings = { ...defaultSettings(), knowledge: { enabled }, engram: { endpoint: provider.endpoint } };
  let intake;
  const options = { checkpoint, ownership, progress: new ProgressGuard(root), workers: { enabled: true },
    workerCapability: { phase: 'mdd-explore', readOnly: true, applyEditing: true },
    knowledge: (runtime, request, memory) => intake.resolveKnowledge(request, runtime, memory) };
  const runner = new PhaseRunner(inspect, options);
  intake = new NativeIntake(runner, { intake: async () => 'user' }, settings);
  const seed = (sources = ['src/a.ts'], body = secretBody, phases = ['mdd-explore', 'mdd-apply']) => {
    const observation = knowledgeObservation({ summary: 'Parser validation boundaries', body, sources,
      applicability: { phases, paths: ['src'] } }, provider.binding.project, 'earlier-session', 'user', 'assistant', 'a'.repeat(64),
    captureKnowledgeDependencies(root, sources));
    provider.writes.push({ session_id: 'earlier-session', project: provider.binding.project, scope: 'project',
      type: 'mdd-project-knowledge', title: 'MDD project knowledge v1', content: JSON.stringify(observation) });
    return observation;
  };
  const start = () => runner.start({ requirements: objective, preflight: { answers } }, runtime,
    { requirementsConfirmed: true, userMessageID: 'user' });
  const items = ['a', 'b'].map(name => ({ id: name, purpose: `Inspect parser validation in ${name}`, independent: true,
    complete: true, dependsOn: [], reads: [{ root, files: [`src/${name}.ts`] }] }));
  return { root, runtime, runner, intake, settings, options, inspect, checkpoint, ownership, provider, queries, seed, start, items };
}

async function prepareApply(f) {
  await f.start(); await throughRiskStop(f.runner, f.runtime.sessionID, 'low', { release: true });
  const trace = traceFixture(), base = trace.deliverables[0];
  trace.deliverables = ['a', 'b'].map((name, i) => ({ ...base, id: `T${i + 1}`, description: `Implement parser validation ${name}`,
    path: `src/${name}.ts`, parallel: { complete: true, reads: [], writes: [`src/${name}.ts`] } }));
  const planCall = { sessionID: f.runtime.sessionID, callID: 'plan' };
  await f.runner.after(planCall, await f.runner.before(planCall, f.runner.status(planCall.sessionID).task),
    reportDocument({ evidenceSummary: 'Planned parser', artifact: 'Implement parser validation.', ...trace }));
  f.runner.releaseSettled(planCall.sessionID, planCall.callID);
  return f.runner.status(planCall.sessionID);
}

test('PK3 ordinary dispatch resolves grounded cross-session bodies inside child args only', async t => {
  const f = await fixture(t); f.seed();
  await f.start();
  const ready = f.runner.status(f.runtime.sessionID);
  assert.equal(JSON.stringify(ready).includes(secretBody), false);
  const call = { sessionID: f.runtime.sessionID, callID: 'knowledge-one' };
  const sent = await f.runner.before(call, ready.task);
  assert.ok(sent.prompt.includes(secretBody));
  assert.match(sent.prompt, /untrusted advisory/i);
  assert.equal(f.queries.length, 1);
  assert.ok(f.queries[0].includes(' OR '), 'bounded alternatives must not AND the entire objective');
  assert.equal(JSON.stringify(f.runner.status(call.sessionID)).includes(secretBody), false);
  await assert.rejects(f.runner.before(call, ready.task));
  assert.equal(f.queries.length, 1, 'duplicate native admission never repeats lookup');
  await assert.rejects(f.runner.after(call, { ...sent, prompt: ready.task.prompt }, 'invented'), /match/);
  await f.runner.after(call, sent, reportDocument({ evidenceSummary: 'Inspected parser', artifact: 'Parser boundary inspected.' }));
});

test('PK3 exploration members only receive observations wholly inside their exact footprints', async t => {
  const f = await fixture(t);
  f.seed(['src/a.ts'], 'BODY_A parser validation');
  f.seed(['src/b.ts'], 'BODY_B parser validation');
  f.seed(['src/a.ts', 'src/b.ts'], 'BODY_CROSS parser validation');
  await f.runner.explore({ purpose: objective, workItems: f.items }, f.runtime);
  const ready = f.runner.status(f.runtime.sessionID);
  const calls = ['a', 'b'].map(callID => ({ sessionID: f.runtime.sessionID, callID }));
  const sent = await Promise.all(ready.tasks.map((task, i) => f.runner.before(calls[i], task)));
  for (const [i, args] of sent.entries()) {
    assert.ok(args.prompt.includes(i ? 'BODY_B' : 'BODY_A'));
    assert.equal(args.prompt.includes(i ? 'BODY_A' : 'BODY_B'), false);
    assert.equal(args.prompt.includes('BODY_CROSS'), false);
  }
  const saved = f.checkpoint.readExploration(f.runtime.sessionID);
  assert.deepEqual(saved.tasks.map(task => task.dispatchedArgs), sent);
  assert.equal(JSON.stringify(f.runner.status(f.runtime.sessionID)).includes('BODY_'), false);
});

test('PK3 Apply members receive selected bodies and correlate exact dispatched arguments', async t => {
  const f = await fixture(t);
  f.seed(['src/a.ts'], 'BODY_A parser validation'); f.seed(['src/b.ts'], 'BODY_B parser validation');
  const ready = await prepareApply(f), sessionID = f.runtime.sessionID;
  assert.equal(ready.tasks.length, 2);
  const sent = [];
  for (const [i, task] of ready.tasks.entries()) {
    sent.push(await f.runner.before({ sessionID, callID: `apply-${i}` }, task));
    assert.ok(sent[i].prompt.includes(i ? 'BODY_B' : 'BODY_A'));
    assert.equal(sent[i].prompt.includes(i ? 'BODY_A' : 'BODY_B'), false);
  }
  assert.deepEqual(f.checkpoint.read(sessionID).checkpoint.data.workerState.batch.members.map(member => member.callID), ['apply-0', 'apply-1']);
  assert.equal(JSON.stringify(f.runner.status(sessionID)).includes('BODY_'), false);
  for (const [i, args] of sent.entries()) {
    const call = { sessionID, callID: `apply-${i}` };
    const report = reportDocument({ evidenceSummary: 'Implemented parser', artifact: 'Parser validation implemented.',
      completed: [`T${i + 1}`], changes: [`src/${i ? 'b' : 'a'}.ts`], checks: [] });
    await assert.rejects(f.runner.after(call, { ...args, prompt: args.prompt + 'forged' }, report), /match/);
    await f.runner.after(call, args, report);
  }
});

for (const lane of ['ordinary', 'exploration', 'apply']) test(`PK3 ${lane} drops source bytes changed during final native inspection`, async t => {
  const f = await fixture(t); f.seed();
  if (lane === 'ordinary') await f.start();
  else if (lane === 'apply') await prepareApply(f);
  else await f.runner.explore({ purpose: objective, workItems: f.items }, f.runtime);
  let retrieved = false;
  const resolve = f.options.knowledge;
  f.options.knowledge = async (...args) => { const found = await resolve(...args); assert.equal(found.length, 1); retrieved = true; return found; };
  f.inspect.parent = async () => { if (retrieved) fs.writeFileSync(join(f.root, 'src/a.ts'), 'dirty change'); };
  const ready = f.runner.status(f.runtime.sessionID);
  const sent = await f.runner.before({ sessionID: f.runtime.sessionID, callID: 'stale' }, ready.task ?? ready.tasks[0]);
  assert.equal(sent.prompt.includes(secretBody), false);
  assert.equal(sent.prompt.includes('BEGIN UNTRUSTED ADVISORY'), false);
});

for (const failure of ['state', 'reservation', 'native']) test(`PK3 ${failure} changes during optional await never dispatch`, async t => {
  const f = await fixture(t); f.seed(); await f.start();
  const entered = deferred(), release = deferred();
  f.options.knowledge = async () => { entered.resolve(); await release.promise; return []; };
  const call = { sessionID: f.runtime.sessionID, callID: 'racing' };
  const pending = f.runner.before(call, f.runner.status(call.sessionID).task);
  const rejected = assert.rejects(pending, /changed|reservation|native authority|uncertain|stale/i);
  await entered.promise;
  if (failure === 'state') f.runner.block(call.sessionID, 'native state changed');
  if (failure === 'reservation') {
    const owner = f.runner.owner(call.sessionID);
    f.ownership.release(owner.runID, call.sessionID, call.callID, owner.epoch);
  }
  if (failure === 'native') f.inspect.parent = async () => { throw new Error('native authority revoked'); };
  release.resolve(); await rejected;
  assert.notEqual(f.runner.status(call.sessionID).state, 'await-result');
});

test('PK3 pending optional lookup refuses a competing dispatch without another provider call', async t => {
  const f = await fixture(t); await f.start();
  const entered = deferred(), release = deferred(); let lookups = 0;
  f.options.knowledge = async () => { lookups++; entered.resolve(); await release.promise; return []; };
  const ready = f.runner.status(f.runtime.sessionID).task;
  const first = f.runner.before({ sessionID: f.runtime.sessionID, callID: 'one' }, ready);
  await entered.promise;
  await assert.rejects(f.runner.before({ sessionID: f.runtime.sessionID, callID: 'two' }, ready), /not ready/);
  release.resolve(); await first;
  assert.equal(lookups, 1);
});

for (const mode of ['disabled', 'unbound', 'failure']) test(`PK3 ${mode} optional provider omits bodies without blocking valid work`, async t => {
  const f = await fixture(t, mode !== 'disabled'); f.seed(); await f.start();
  if (mode === 'unbound') f.provider.binding.id = 'foreign-session';
  if (mode === 'failure') f.options.knowledge = async () => { throw new Error('provider failure with private details'); };
  const sent = await f.runner.before({ sessionID: f.runtime.sessionID, callID: mode }, f.runner.status(f.runtime.sessionID).task);
  assert.equal(sent.prompt.includes(secretBody), false);
  assert.equal(JSON.stringify(f.runner.status(f.runtime.sessionID)).includes('private details'), false);
  assert.equal(f.queries.length, 0);
});

test('PK3 deterministic selection excludes unrelated phase, paths and objective even if provider returns them', async t => {
  const f = await fixture(t);
  f.seed(['src/a.ts'], 'VALID parser validation');
  f.seed(['src/b.ts'], 'WRONG_PHASE parser validation', ['mdd-verify']);
  f.seed(['src/b.ts'], 'UNRELATED accounting invoicing');
  const last = JSON.parse(f.provider.writes.at(-1).content);
  // Recreate a valid observation with no objective overlap instead of corrupting its integrity digest.
  f.provider.writes.at(-1).content = JSON.stringify(knowledgeObservation({ summary: 'Accounting invoices', body: last.body,
    sources: last.sources, applicability: last.applicability }, last.project, 'earlier-session', 'user', 'assistant', 'a'.repeat(64), last.dependencies));
  const ignoringProvider = { project: f.provider.binding.project, searchKnowledge: async () => f.provider.writes.map((row, i) =>
    ({ id: i + 1, content: row.content, sessionID: row.session_id })) };
  assert.deepEqual((await selectKnowledge(ignoringProvider, { phase: 'mdd-explore', objective, paths: [] }, f.root)).map(row => row.id), [1]);
  const selected = await f.intake.resolveKnowledge({ phase: 'mdd-explore', objective, paths: ['src/a.ts'], files: [join(f.root, 'src/a.ts')] }, f.runtime);
  assert.equal(selected.length, 1);
  assert.ok(selected[0].entry.body.startsWith('VALID'));
  assert.deepEqual(await f.intake.resolveKnowledge({ phase: 'mdd-explore', objective, paths: ['other/file.ts'] }, f.runtime), []);
  assert.deepEqual(await f.intake.resolveKnowledge({ phase: 'mdd-explore', objective: 'the and please', paths: [] }, f.runtime), []);
});

for (const bodySize of [50, 4000]) test(`PK3 actual dispatch obeys three-entry and encoded 8 KiB budgets (${bodySize})`, async t => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) f.seed(['src/a.ts'], `BODY_${i} parser validation ` + 'é'.repeat(Math.floor(bodySize / 2)));
  await f.start();
  const sent = await f.runner.before({ sessionID: f.runtime.sessionID, callID: 'budget' }, f.runner.status(f.runtime.sessionID).task);
  const index = sent.prompt.indexOf('\n\nBEGIN UNTRUSTED ADVISORY');
  assert.ok(index > 0);
  const supplement = sent.prompt.slice(index);
  assert.ok(Buffer.byteLength(supplement) <= 8192);
  const selected = [...supplement.matchAll(/"ref":"engram:/g)].length;
  assert.equal(selected, bodySize === 50 ? 3 : 1);
  assert.ok(sent.prompt.includes(objective));
  assert.match(sent.prompt, /verification|Verification/);
  assert.ok(Buffer.byteLength(sent.prompt) <= 96000);
});

test('PK3 tight total budget preserves mandatory text byte-for-byte and drops optional data', async t => {
  const f = await fixture(t), entry = f.seed();
  const mandatory = 'Required task and acceptance verification. ' + 'x'.repeat(95900);
  const selection = { phase: 'mdd-explore', objective, paths: [] };
  assert.equal(supplementKnowledge(mandatory, [{ id: 1, entry }], selection, f.root, 96000), mandatory);
  const encoded = f.seed(['src/a.ts'], 'parser ' + '\t'.repeat(4000));
  const sent = supplementKnowledge('mandatory', [{ id: 2, entry: encoded }], selection, f.root, 96000);
  assert.equal(sent, 'mandatory', 'escaped bytes and framing count, not just logical body length');
});

test('PK3 restored ready work queries current sources and pending dispatch cannot replay after restart', async t => {
  const f = await fixture(t); f.seed(); await f.start();
  const restored = new PhaseRunner(f.inspect, f.options);
  assert.equal((await restored.restore(f.runtime)).restored, true);
  fs.writeFileSync(join(f.root, 'src/a.ts'), 'changed after ready checkpoint');
  const call = { sessionID: f.runtime.sessionID, callID: 'restored' };
  const ready = restored.status(call.sessionID).task;
  const args = await restored.before(call, ready);
  assert.equal(f.queries.length, 1);
  assert.equal(args.prompt.includes(secretBody), false);
  const restarted = new PhaseRunner(f.inspect, f.options);
  assert.equal((await restarted.restore(f.runtime)).restored, false);
  await assert.rejects(restarted.before({ ...call, callID: 'replay' }, ready));
  assert.equal(f.queries.length, 1);
});

test('PK3 authorized phase retry resolves again instead of reusing a prepared supplement', async t => {
  const f = await fixture(t); f.seed(); await f.start();
  const call = { sessionID: f.runtime.sessionID, callID: 'attempt-one' };
  const first = await f.runner.before(call, f.runner.status(call.sessionID).task);
  assert.ok(first.prompt.includes(secretBody));
  f.inspect.result = async () => { throw new Error('Native result rejected'); };
  await assert.rejects(f.runner.after(call, first, 'unreadable result'), /Native result rejected/);
  f.runner.releaseSettled(call.sessionID, call.callID);
  fs.writeFileSync(join(f.root, 'src/a.ts'), 'different retry source');
  const next = await f.runner.before({ ...call, callID: 'attempt-two' }, f.runner.status(call.sessionID).task);
  assert.equal(next.prompt.includes(secretBody), false);
  assert.equal(first.prompt.includes(secretBody), true, 'already dispatched bytes remain immutable');
  assert.equal(f.queries.length, 2);
});

for (const lane of ['exploration', 'apply']) test(`PK3 ${lane} loses native authority during lookup without swallowing the failure`, async t => {
  const f = await fixture(t); f.seed();
  if (lane === 'apply') await prepareApply(f);
  else await f.runner.explore({ purpose: objective, workItems: f.items }, f.runtime);
  const ready = f.runner.status(f.runtime.sessionID);
  const entered = deferred(), release = deferred();
  f.options.knowledge = async () => { entered.resolve(); await release.promise; throw new Error('provider unavailable'); };
  const pending = f.runner.before({ sessionID: f.runtime.sessionID, callID: 'lost-authority' }, ready.tasks[0]);
  const rejected = assert.rejects(pending, /native authority revoked/);
  await entered.promise;
  f.inspect.parent = async () => { throw new Error('native authority revoked'); };
  release.resolve(); await rejected;
  assert.equal(f.runner.status(f.runtime.sessionID).state, 'blocked');
});

test('PK3 restored ready Apply members rebuild selections while already admitted workers stay fenced', async t => {
  const f = await fixture(t); f.seed();
  await prepareApply(f);
  const restarted = new PhaseRunner(f.inspect, f.options);
  assert.equal((await restarted.restore(f.runtime)).restored, true);
  const before = f.queries.length;
  const ready = restarted.status(f.runtime.sessionID);
  fs.writeFileSync(join(f.root, 'src/a.ts'), 'new checkout bytes');
  const call = { sessionID: f.runtime.sessionID, callID: 'restored-apply' };
  const sent = await restarted.before(call, ready.tasks[0]);
  assert.equal(sent.prompt.includes(secretBody), false);
  assert.equal(f.queries.length, before + 1);
  const again = new PhaseRunner(f.inspect, f.options);
  assert.equal((await again.restore(f.runtime)).restored, false);
  await assert.rejects(again.before({ ...call, callID: 'replay' }, ready.tasks[0]));
  assert.equal(f.queries.length, before + 1);
});

test('PK3 dispatched exploration bytes survive restart unchanged and never grant replay', async t => {
  const f = await fixture(t); f.seed();
  await f.runner.explore({ purpose: objective, workItems: f.items }, f.runtime);
  const ready = f.runner.status(f.runtime.sessionID);
  const sent = await f.runner.before({ sessionID: f.runtime.sessionID, callID: 'read-one' }, ready.tasks[0]);
  assert.ok(sent.prompt.includes(secretBody));
  fs.writeFileSync(join(f.root, 'src/a.ts'), 'changed after dispatch');
  const restarted = new PhaseRunner(f.inspect, f.options);
  assert.equal((await restarted.restore(f.runtime)).restored, false);
  assert.deepEqual(f.checkpoint.readExploration(f.runtime.sessionID).tasks[0].dispatchedArgs, sent);
  await assert.rejects(restarted.before({ sessionID: f.runtime.sessionID, callID: 'new-read' }, ready.tasks[0]));
  assert.equal(f.queries.length, 1);
});

test('PK3 optional bodies never enter phase telemetry or status after dispatch', async t => {
  const f = await fixture(t); f.seed();
  const events = [];
  f.options.telemetry = (_root, event) => { events.push(event); return { ok: true }; };
  await f.start();
  const call = { sessionID: f.runtime.sessionID, callID: 'telemetry' };
  const sent = await f.runner.before(call, f.runner.status(call.sessionID).task);
  assert.ok(sent.prompt.includes(secretBody));
  assert.ok(events.length > 0);
  assert.equal(JSON.stringify(events).includes(secretBody), false);
  assert.equal(JSON.stringify(f.runner.status(call.sessionID)).includes(secretBody), false);
});
