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

test('PK3 tight total budget preserves mandatory text byte-for-byte and drops optional data', async t => {
  const f = await fixture(t), entry = f.seed();
  const mandatory = 'Required task and acceptance verification. ' + 'x'.repeat(95900);
  const selection = { phase: 'mdd-explore', objective, paths: [] };
  assert.equal(supplementKnowledge(mandatory, [{ id: 1, entry }], selection, f.root, 96000), mandatory);
  const encoded = f.seed(['src/a.ts'], 'parser ' + '\t'.repeat(4000));
  const sent = supplementKnowledge('mandatory', [{ id: 2, entry: encoded }], selection, f.root, 96000);
  assert.equal(sent, 'mandatory', 'escaped bytes and framing count, not just logical body length');
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

function catalog(f, paths = ['src/a.ts']) {
  fs.mkdirSync(join(f.root, 'mdd'));
  fs.mkdirSync(join(f.root, 'skills'));
  fs.writeFileSync(join(f.root, 'skills/SKILL.md'), '---\nname: parser\n---\nPRIVATE_CATALOG_BODY parser validation guidance.');
  fs.writeFileSync(join(f.root, 'mdd/knowledge.json'), JSON.stringify({ version: 1, skills: [{ id: 'parser',
    path: 'skills/SKILL.md', approved: true, phases: ['mdd-explore', 'mdd-apply'], terms: ['parser'], paths,
    tools: ['mdd_worker_edit', 'bash', 'invented'] }] }));
}

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

async function settleKnowledgeTask(f, callID, runtime = f.runtime) {
  const call = { sessionID: runtime.sessionID, callID };
  const sent = await f.runner.before(call, f.runner.status(call.sessionID).task);
  assert.deepEqual(f.runner.status(call.sessionID).knowledge.selectedSkillIDs, ['parser']);
  await f.runner.after(call, sent, reportDocument({ evidenceSummary: 'Inspected parser.', artifact: 'Parser boundaries inspected.' }));
  f.runner.releaseSettled(call.sessionID, callID);
}

test('PK4 lifecycle isolates successive standalone investigations', async t => {
  const f = await fixture(t); catalog(f, []);
  await f.runner.explore({ purpose: objective }, f.runtime);
  await settleKnowledgeTask(f, 'solo-parser');
  await f.runner.explore({ purpose: 'Inspect billing workflows' }, f.runtime);
  assert.equal(f.runner.status(f.runtime.sessionID).knowledge, undefined);
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
