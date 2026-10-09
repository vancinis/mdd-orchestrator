import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PhaseRunner } from '../dist/phase-runner.js';
import { NativeIntake } from '../dist/native-intake.js';
import { CheckpointStore, sealResumeData } from '../dist/checkpoint.js';
import { RunOwnershipStore } from '../dist/run-ownership.js';
import { RunDossierStore } from '../dist/run-dossier.js';
import { ProgressGuard } from '../dist/progress.js';
import { defaultSettings } from '../dist/settings.js';
import { saveGlobalSettings } from '../dist/global-settings.js';
import { recordTelemetry } from '../dist/telemetry.js';
import { captureKnowledgeDependencies, knowledgeObservation, selectKnowledge, supplementKnowledge } from '../dist/project-knowledge.js';
import { answers, memoryServer, throughRiskStop, structuredTraceFixture as traceFixture, structuredVerificationFixture, reportDocument } from './adapter-fixture.mjs';

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
    checks: base.checks.map(check => ({ ...check, id: `${name}-check` })),
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
  f.options.knowledge = async (...args) => { const found = await resolve(...args); assert.equal(found.observations.length, 1); retrieved = true; return found; };
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
  assert.equal(selected.observations.length, 1);
  assert.ok(selected.observations[0].entry.body.startsWith('VALID'));
  assert.deepEqual((await f.intake.resolveKnowledge({ phase: 'mdd-explore', objective, paths: ['other/file.ts'] }, f.runtime)).observations, []);
  assert.deepEqual((await f.intake.resolveKnowledge({ phase: 'mdd-explore', objective: 'the and please', paths: [] }, f.runtime)).observations, []);
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

function catalog(f, paths = ['src/a.ts']) {
  fs.mkdirSync(join(f.root, 'mdd'));
  fs.mkdirSync(join(f.root, 'skills'));
  fs.writeFileSync(join(f.root, 'skills/SKILL.md'), '---\nname: parser\n---\nPRIVATE_CATALOG_BODY parser validation guidance.');
  fs.writeFileSync(join(f.root, 'mdd/knowledge.json'), JSON.stringify({ version: 1, skills: [{ id: 'parser',
    path: 'skills/SKILL.md', approved: true, phases: ['mdd-explore', 'mdd-apply'], terms: ['parser'], paths,
    tools: ['mdd_worker_edit', 'bash', 'invented'] }] }));
}

for (const lane of ['ordinary', 'exploration', 'apply']) test(`PK4 actual ${lane} dispatch adds catalog excerpts and exact body-free metrics`, async t => {
  const f = await fixture(t); catalog(f, lane === 'ordinary' ? [] : ['src/a.ts']); f.seed();
  const events = [];
  f.options.telemetry = (_root, value) => { events.push(value); return { ok: true }; };
  if (lane === 'ordinary') await f.start();
  else if (lane === 'apply') await prepareApply(f);
  else await f.runner.explore({ purpose: objective, workItems: f.items }, f.runtime);
  const ready = f.runner.status(f.runtime.sessionID);
  const sent = await f.runner.before({ sessionID: f.runtime.sessionID, callID: 'catalog' }, ready.task ?? ready.tasks[0]);
  assert.ok(sent.prompt.includes('PRIVATE_CATALOG_BODY'));
  const status = f.runner.status(f.runtime.sessionID);
  assert.equal(JSON.stringify(status).includes('PRIVATE_CATALOG_BODY'), false);
  assert.deepEqual(status.knowledge.selectedSkillIDs, ['parser']);
  assert.deepEqual(status.knowledge.selectedReferences, ['engram:1']);
  const supplement = sent.prompt.slice(sent.prompt.indexOf('\n\nBEGIN UNTRUSTED ADVISORY'));
  assert.equal(status.knowledge.promptByteDelta, Buffer.byteLength(supplement));
  assert.equal(status.knowledge.selectedBytes, Buffer.byteLength(supplement.split('\n').filter(line => line.startsWith('{')).join('\n') + '\n'));
  assert.ok(supplement.length <= 8192);
  assert.equal(JSON.stringify(events).includes('PRIVATE_'), false);
  assert.deepEqual(events.findLast(event => event.event === 'knowledge-dispatch').knowledge, status.knowledge);
  const skill = JSON.parse(supplement.split('\n').find(line => line.startsWith('{') && line.includes('"skill"')));
  assert.deepEqual(skill.tools, lane === 'apply' ? ['mdd_worker_edit'] : undefined);
  if (lane === 'ordinary') assert.ok(sent.prompt.includes('mdd-doc'), 'ordinary lanes retain packaged phase skill hints');
  else assert.doesNotMatch(sent.prompt, /mdd-doc|cognitive-doc-design|mdd-cleanup/, 'scoped workers receive advisory excerpts without skill-reading instructions');
  if (lane !== 'ordinary') {
    assert.equal(JSON.stringify(f.runner.workerAssignment({ sessionID: f.runtime.sessionID, callID: 'catalog' })).includes('skills'), false);
    const second = await f.runner.before({ sessionID: f.runtime.sessionID, callID: 'other-member' }, ready.tasks[1]);
    assert.equal(second.prompt.includes('PRIVATE_CATALOG_BODY'), false);
    assert.deepEqual(f.runner.status(f.runtime.sessionID).knowledge.selectedSkillIDs, []);
  }
});

test('PK4 catalog and observations share three slots and measured query freshness', async t => {
  const f = await fixture(t); catalog(f, []);
  for (let i = 0; i < 3; i++) f.seed();
  f.seed(['src/b.ts']); fs.writeFileSync(join(f.root, 'src/b.ts'), 'changed');
  await f.start();
  const sent = await f.runner.before({ sessionID: f.runtime.sessionID, callID: 'shared-budget' }, f.runner.status(f.runtime.sessionID).task);
  const metrics = f.runner.status(f.runtime.sessionID).knowledge;
  assert.equal(metrics.candidates, 5); assert.equal(metrics.freshHits, 4); assert.equal(metrics.staleRejects, 1);
  assert.deepEqual(metrics.selectedSkillIDs, ['parser']); assert.deepEqual(metrics.selectedReferences, ['engram:1', 'engram:2']);
  assert.equal(sent.prompt.split('\n').filter(line => line.startsWith('{') && /"skill"|"ref":"engram:/.test(line)).length, 3);
});

test('PK4 standalone exploration uses explicit catalog and reports zero selection for irrelevant entries', async t => {
  const f = await fixture(t); catalog(f, []);
  await f.runner.explore({ purpose: objective }, f.runtime);
  const sent = await f.runner.before({ sessionID: f.runtime.sessionID, callID: 'standalone-catalog' }, f.runner.status(f.runtime.sessionID).task);
  assert.ok(sent.prompt.includes('PRIVATE_CATALOG_BODY'));
  const other = await fixture(t); catalog(other, []);
  await other.runner.explore({ purpose: 'Inspect billing workflows' }, other.runtime);
  await other.runner.before({ sessionID: other.runtime.sessionID, callID: 'irrelevant-catalog' }, other.runner.status(other.runtime.sessionID).task);
  assert.deepEqual(other.runner.status(other.runtime.sessionID).knowledge, { candidates: 1, freshHits: 0, staleRejects: 0,
    selectedSkillIDs: [], selectedReferences: [], selectedBytes: 0, promptByteDelta: 0 });
});

for (const changed of ['skill', 'catalog']) for (const lane of ['ordinary', 'exploration', 'apply'])
test(`PK4 ${lane} final boundary rejects ${changed} mutations with exact stale metrics`, async t => {
  const f = await fixture(t); catalog(f, lane === 'ordinary' ? [] : ['src/a.ts']);
  if (lane === 'ordinary') await f.start();
  else if (lane === 'apply') await prepareApply(f);
  else await f.runner.explore({ purpose: objective, workItems: f.items }, f.runtime);
  let retrieved = false;
  const lookup = f.options.knowledge;
  f.options.knowledge = async (...args) => { const result = await lookup(...args); retrieved = true; return result; };
  f.inspect.parent = async () => { if (retrieved) fs.appendFileSync(join(f.root, changed === 'skill' ? 'skills/SKILL.md' : 'mdd/knowledge.json'), '\nchanged'); };
  const ready = f.runner.status(f.runtime.sessionID);
  const sent = await f.runner.before({ sessionID: f.runtime.sessionID, callID: 'catalog-stale' }, ready.task ?? ready.tasks[0]);
  assert.equal(sent.prompt.includes('PRIVATE_CATALOG_BODY'), false);
  assert.deepEqual(f.runner.status(f.runtime.sessionID).knowledge, { candidates: 1, freshHits: 1, staleRejects: 1,
    selectedReferences: [], selectedSkillIDs: [], selectedBytes: 0, promptByteDelta: 0 });
});

test('PK4 unavailable canonical provider retains safe explicit catalog, disabled feature reads neither', async t => {
  const f = await fixture(t); catalog(f, []); f.seed(); await f.start();
  f.provider.binding.id = 'foreign-session';
  const sent = await f.runner.before({ sessionID: f.runtime.sessionID, callID: 'catalog-only' }, f.runner.status(f.runtime.sessionID).task);
  assert.ok(sent.prompt.includes('PRIVATE_CATALOG_BODY'));
  assert.equal(sent.prompt.includes(secretBody), false);
  assert.deepEqual(f.runner.status(f.runtime.sessionID).knowledge.selectedReferences, []);
  const disabled = await fixture(t, false); catalog(disabled, []); await disabled.start();
  const untouched = await disabled.runner.before({ sessionID: disabled.runtime.sessionID, callID: 'disabled-catalog' }, disabled.runner.status(disabled.runtime.sessionID).task);
  assert.equal(untouched.prompt.includes('PRIVATE_CATALOG_BODY'), false);
  assert.equal(disabled.queries.length, 0);
});

test('PK4 failed final native admission records no delivered metrics', async t => {
  const f = await fixture(t); catalog(f, []); await f.start();
  const events = [];
  f.options.telemetry = (_root, value) => { events.push(value); return { ok: true }; };
  const lookup = f.options.knowledge;
  f.options.knowledge = async (...args) => {
    const found = await lookup(...args);
    f.inspect.parent = async () => { throw new Error('native authority revoked'); };
    return found;
  };
  await assert.rejects(f.runner.before({ sessionID: f.runtime.sessionID, callID: 'failed-catalog' }, f.runner.status(f.runtime.sessionID).task), /native authority/);
  assert.equal(f.runner.status(f.runtime.sessionID).knowledge, undefined);
  assert.equal(events.some(event => event.event === 'knowledge-dispatch'), false);
});

test('PK4 failed host publication after supplementation records no delivered metrics', async t => {
  const f = await fixture(t); catalog(f, []); await f.start();
  const events = [];
  f.options.telemetry = (_root, value) => { events.push(value); return { ok: true }; };
  await assert.rejects(f.runner.before({ sessionID: f.runtime.sessionID, callID: 'failed-publication' },
    f.runner.status(f.runtime.sessionID).task, args => {
      assert.ok(args.prompt.includes('PRIVATE_CATALOG_BODY'));
      throw new Error('host admission failed');
    }), /host admission failed/);
  assert.equal(f.runner.status(f.runtime.sessionID).knowledge, undefined);
  assert.equal(events.some(event => event.event === 'knowledge-dispatch'), false);
});

test('PK4 telemetry off retains only in-memory delivery metrics and no persistent counters', async t => {
  const f = await fixture(t); catalog(f, []);
  saveGlobalSettings({ ...defaultSettings(), telemetry: { enabled: false } });
  f.options.telemetry = (root, value, now) => recordTelemetry(root, value, now);
  await f.start();
  await f.runner.before({ sessionID: f.runtime.sessionID, callID: 'private-metrics' }, f.runner.status(f.runtime.sessionID).task);
  assert.deepEqual(f.runner.status(f.runtime.sessionID).knowledge.selectedSkillIDs, ['parser']);
  const files = fs.readdirSync(join(f.root, '.mdd'));
  assert.equal(files.some(name => /telemetry|stats|metrics/.test(name)), false);
  assert.equal(files.includes('knowledge-cache.json'), false, 'no observations means no cache, and no covert counters');
});

async function settleKnowledgeTask(f, callID, runtime = f.runtime) {
  const call = { sessionID: runtime.sessionID, callID };
  const sent = await f.runner.before(call, f.runner.status(call.sessionID).task);
  assert.deepEqual(f.runner.status(call.sessionID).knowledge.selectedSkillIDs, ['parser']);
  await f.runner.after(call, sent, reportDocument({ evidenceSummary: 'Inspected parser.', artifact: 'Parser boundaries inspected.' }));
  f.runner.releaseSettled(call.sessionID, callID);
}

for (const boundary of ['reset', 'new-objective', 'replacement']) test(`PK4 lifecycle isolates ${boundary} from prior delivered metrics`, async t => {
  const f = await fixture(t); catalog(f, []); await f.start();
  await settleKnowledgeTask(f, 'old-parser');
  if (boundary !== 'replacement') f.runner.reset(f.runtime.sessionID, 'run');
  if (boundary === 'reset') assert.equal(f.runner.status(f.runtime.sessionID).state, 'not-started');
  else {
    await f.runner.start({ requirements: 'Inspect billing workflows', preflight: { answers } }, f.runtime,
      { requirementsConfirmed: true, userMessageID: 'billing-user', ...(boundary === 'replacement' ? { replace: true } : {}) });
    assert.equal(f.runner.status(f.runtime.sessionID).state, 'ready');
  }
  assert.equal(f.runner.status(f.runtime.sessionID).knowledge, undefined);
});

test('PK4 lifecycle isolates successive standalone investigations', async t => {
  const f = await fixture(t); catalog(f, []);
  await f.runner.explore({ purpose: objective }, f.runtime);
  await settleKnowledgeTask(f, 'solo-parser');
  await f.runner.explore({ purpose: 'Inspect billing workflows' }, f.runtime);
  assert.equal(f.runner.status(f.runtime.sessionID).knowledge, undefined);
});

test('PK4 lifecycle isolates explicit failed-Verify continuation and fresh start from prior diagnostics', async t => {
  const f = await fixture(t), sessionID = f.runtime.sessionID;
  f.options.dossier = new RunDossierStore(f.root);
  f.seed(['src/a.ts'], secretBody, ['mdd-explore', 'mdd-verify']);
  await f.start(); await throughRiskStop(f.runner, sessionID, 'low', { release: true });
  const settle = async (callID, data) => {
    const call = { sessionID, callID };
    const sent = await f.runner.before(call, f.runner.status(sessionID).task);
    await f.runner.after(call, sent, reportDocument({ evidenceSummary: 'Recorded parser evidence.', artifact: 'Parser validation boundaries.', ...data }));
    f.runner.releaseSettled(sessionID, callID);
    return sent;
  };
  const trace = traceFixture('src/a.ts', 'parser');
  await settle('plan-parser', trace);
  await settle('apply-parser', { completed: ['parser'], changes: ['src/a.ts'] });
  const evidence = structuredVerificationFixture(trace);
  evidence.checks[0].exit = 1;
  evidence.verification.checkResults[0].disposition = 'failed';
  evidence.verification.checkResults[0].reason = 'The required parser check failed.';
  for (const row of [...evidence.verification.scenarios, ...evidence.verification.steps, ...evidence.verification.decisions]) row.status = 'not-verified';
  const dispatched = await settle('verify-parser', { ...evidence, outcome: 'failed' });
  assert.ok(dispatched.prompt.includes(secretBody));
  const failed = f.runner.status(sessionID);
  assert.equal(failed.state, 'blocked');
  assert.equal(failed.verification.matched, false);
  assert.deepEqual(failed.knowledge.selectedReferences, ['engram:1']);
  const queryCount = f.queries.length;
  await f.runner.withReset(sessionID, async () => f.runner.reset(sessionID, 'continue', {
    runID: failed.runID, userMessageID: 'continue-parser', userText: 'Continue despite the failed parser check.', kind: 'continue',
  }));
  assert.equal(f.runner.status(sessionID).state, 'continued-with-failed-verification');
  assert.equal(f.runner.status(sessionID).knowledge, undefined);
  assert.equal(f.runner.prFacts(sessionID, failed.runID).verified, false);
  assert.deepEqual(f.options.dossier.readContinued(sessionID, failed.runID).executedChecks, evidence.checks);
  f.settings.profiles.default.answers = { ...answers };
  const intake = new NativeIntake(f.runner, { intake: async (_runtime, requirements) => {
    assert.equal(requirements, objective);
    return 'fresh-parser';
  } }, f.settings);
  await intake.start({ requirements: objective }, f.runtime, 'fresh-assistant');
  const fresh = f.runner.status(sessionID);
  assert.equal(fresh.state, 'ready');
  assert.equal(fresh.verificationVersion, 1);
  assert.equal(fresh.knowledge, undefined);
  assert.equal(f.queries.length, queryCount, 'continuation and start do not reuse or resolve dispatch knowledge');
  fs.writeFileSync(join(f.root, 'src/a.ts'), 'changed after failed verification');
  const next = await f.runner.before({ sessionID, callID: 'fresh-explore' }, fresh.task);
  assert.equal(f.queries.length, queryCount + 1, 'fresh dispatch resolves knowledge again');
  assert.equal(next.prompt.includes(secretBody), false);
  assert.deepEqual(f.runner.status(sessionID).knowledge.selectedReferences, []);
  assert.equal(f.runner.status(sessionID).knowledge.staleRejects, 1);
  assert.ok(dispatched.prompt.includes(secretBody), 'historical dispatched bytes remain unchanged');
  assert.equal(f.runner.prFacts(sessionID, failed.runID).verified, false);
});

test('PK4 lifecycle isolates contextual investigation from its held workflow in both directions', async t => {
  const f = await fixture(t); catalog(f, []); await f.start();
  await settleKnowledgeTask(f, 'main-parser');
  await f.runner.explore({ purpose: objective }, f.runtime);
  assert.equal(f.runner.status(f.runtime.sessionID).knowledge, undefined, 'new contextual work has not received the workflow supplement');
  await settleKnowledgeTask(f, 'context-parser');
  assert.equal(f.runner.status(f.runtime.sessionID).knowledge, undefined, 'contextual delivery does not describe the restored main workflow');
});

test('PK4 lifecycle restored workflow cannot inherit earlier standalone metrics in the same runner', async t => {
  const f = await fixture(t); catalog(f, []);
  await f.runner.explore({ purpose: objective }, f.runtime);
  await settleKnowledgeTask(f, 'before-restore');
  const writer = new PhaseRunner(f.inspect, f.options);
  await writer.start({ requirements: 'Inspect billing workflows', preflight: { answers } }, f.runtime,
    { requirementsConfirmed: true, userMessageID: 'billing-user' });
  assert.equal((await f.runner.restore(f.runtime)).restored, true);
  assert.equal(f.runner.status(f.runtime.sessionID).knowledge, undefined);
});

test('PK4 lifecycle transfer evicts source metrics and excludes the target prior investigation', async t => {
  const f = await fixture(t); catalog(f, []);
  const targetRuntime = { ...f.runtime, sessionID: 'knowledge-target' };
  await f.runner.explore({ purpose: objective }, targetRuntime);
  await settleKnowledgeTask(f, 'target-parser', targetRuntime);
  await f.start(); await settleKnowledgeTask(f, 'source-parser');
  const sourceID = f.runtime.sessionID, targetID = targetRuntime.sessionID;
  const saved = f.checkpoint.read(sourceID).checkpoint, runID = saved.runID;
  const intent = { operationID: 'knowledge-transfer', nativeUserMessageID: 'transfer-user', requestDigest: 'b'.repeat(64) };
  const reserved = f.ownership.reserveVerifiedTransfer(runID, sourceID, targetRuntime,
    { sequence: saved.sequence, digest: saved.dataDigest }, f.ownership.read(runID).epoch, intent);
  const data = { ...saved.data, userMessageID: 'transfer-user', usedMessages: ['transfer-user'], proposed: [] };
  const target = { ...saved, parent: targetID, sequence: 0, data,
    dataDigest: sealResumeData(data, runID, targetID, saved.events, saved.stable) };
  f.checkpoint.write(targetID, target);
  f.options.progress.write(targetID, { ...f.options.progress.read(sourceID), userMessageID: 'transfer-user' });
  f.ownership.finishVerifiedTransfer(runID, sourceID, targetID, reserved.epoch,
    { sourceSequence: saved.sequence, sourceDigest: saved.dataDigest, targetSequence: target.sequence, targetDigest: target.dataDigest }, intent);
  assert.equal(f.runner.movedAway(sourceID).targetSessionID, targetID);
  assert.equal(f.runner.status(sourceID).knowledge, undefined);
  f.inspect.confirmTransfer = async () => {};
  assert.equal((await f.runner.restore(targetRuntime)).restored, true);
  assert.equal(f.runner.status(targetID).knowledge, undefined);
});

test('PK4 lifecycle preserves active member diagnostics across refused resets and unrelated parents', async t => {
  const f = await fixture(t); catalog(f);
  await f.runner.explore({ purpose: objective, workItems: f.items }, f.runtime);
  const ready = f.runner.status(f.runtime.sessionID);
  await f.runner.before({ sessionID: f.runtime.sessionID, callID: 'active-member' }, ready.tasks[0]);
  const metrics = f.runner.status(f.runtime.sessionID).knowledge;
  assert.deepEqual(metrics.selectedSkillIDs, ['parser']);
  assert.throws(() => f.runner.reset(f.runtime.sessionID, 'run'), /running/);
  await f.runner.explore({ purpose: 'Inspect billing workflows' }, { ...f.runtime, sessionID: 'unrelated-parent' });
  assert.deepEqual(f.runner.status(f.runtime.sessionID).knowledge, metrics);
  await assert.rejects(f.runner.before({ sessionID: f.runtime.sessionID, callID: 'failed-sibling' }, ready.tasks[1], () => {
    throw new Error('Sibling host publication refused');
  }), /Sibling/);
  assert.deepEqual(f.runner.status(f.runtime.sessionID).knowledge, metrics);
});
