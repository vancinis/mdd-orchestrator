import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, readFile, readdir, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import plugin from '../dist/opencode-plugin.js';
import { defaultSettings, MODEL_ROLES } from '../dist/settings.js';
import { saveGlobalSettings } from '../dist/global-settings.js';
import { memoryServer, installCleanup, isolateHome, answers, traceFixture } from './adapter-fixture.mjs';
import { traceArtifact } from '../dist/acceptance.js';
import { ManagedMemory } from '../dist/managed-memory.js';

// Native SDK/hook contract fixtures. No model or real shell execution is performed.
async function fixture(t, { mode = 'automatic', route = 'low', store = 'none', partial = false, summary = 'low', telemetry = true, memoryEnabled = true, memoryFault, start = true } = {}) {
  isolateHome(t);
  const root = await mkdtemp(join(tmpdir(), 'mdd-full-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  installCleanup(root);
  await writeFile(join(root, 'feature.txt'), 'pending\n');
  const memory = memoryEnabled ? await memoryServer(t, memoryFault) : { binding: {}, writes: [] };
  memory.binding.directory = root;
  const settings = defaultSettings();
  const known = { ...answers, mode, summary, artifactStore: store, ...(route === 'high' ? { certainty: 'not-sure', complexity: 'very-complex' } : route === 'low-explore' ? { certainty: 'somewhat-sure' } : {}) };
  settings.profiles.default.answers = partial ? { ...known, mode: undefined } : known;
  if (partial) delete settings.profiles.default.answers.mode;
  if (memoryEnabled) settings.engram = { endpoint: memory.endpoint, project: 'mdd-test' };
  settings.telemetry.enabled = telemetry;
  saveGlobalSettings(settings);
  const runtime = { sessionID: 'ses_parent', agent: 'mdd-orchestrator', directory: root, worktree: root };
  const model = { providerID: 'contract-only', modelID: 'model' };
  const requirements = 'Implement a scoped feature and check it.';
  const agents = MODEL_ROLES.map(role => ({ name: role === 'orchestrator' ? 'mdd-orchestrator' : role, mode: role === 'orchestrator' ? 'primary' : 'subagent', permission: [
    { permission: '*', pattern: '*', action: 'deny' }, ...['read', 'glob', 'grep'].map(permission => ({ permission, pattern: '*', action: 'allow' })),
    ...(role === 'mdd-apply' ? [{ permission: 'edit', pattern: '*', action: 'ask' }] : []),
    ...(['mdd-apply', 'mdd-verify'].includes(role) ? [{ permission: 'bash', pattern: '*', action: 'ask' }] : []),
  ] }));
  const sessions = new Map([[runtime.sessionID, { id: runtime.sessionID, agent: runtime.agent, directory: root, projectID: 'project' }]]);
  const info = { id: 'msg_parent', sessionID: runtime.sessionID, agent: runtime.agent, role: 'assistant', ...model, path: { cwd: root, root } };
  const parent = [{ info: { id: 'user', sessionID: runtime.sessionID, role: 'user' }, parts: [{ type: 'text', text: requirements, sessionID: runtime.sessionID, messageID: 'user' }] }, { info, parts: [] }];
  const histories = new Map([[runtime.sessionID, parent]]);
  const input = { directory: root, worktree: root, project: { id: 'project' }, client: {
    app: { agents: async () => ({ data: agents }) }, session: {
      get: async ({ path }) => ({ data: sessions.get(path.id) }), messages: async ({ path }) => ({ data: histories.get(path.id) }),
    },
  } };
  const hooks = await plugin(input);
  const context = { ...runtime, messageID: 'msg_parent', abort: new AbortController().signal };
  const status = async () => JSON.parse(await hooks.tool.mdd_status.execute({}, context));
  let questionCount = 0;
  async function answer(selection) {
    const current = await status();
    const args = current.question;
    const call = { sessionID: runtime.sessionID, callID: `question-${++questionCount}`, tool: 'question' };
    parent[1].parts = [{ type: 'tool', tool: 'question', callID: call.callID, sessionID: runtime.sessionID, messageID: context.messageID, state: { status: 'running', input: structuredClone(args) } }];
    await hooks['tool.execute.before'](call, { args });
    const labels = { Approval: 'Proceed', Change: 'Confirm change', Certainty: known.certainty === 'not-sure' ? 'Not sure' : known.certainty === 'somewhat-sure' ? 'Somewhat sure' : 'Very sure', Artifacts: { none: 'None', openspec: 'OpenSpec', engram: 'Engram', both: 'Both' }[store], Mode: mode === 'automatic' ? 'Automatic' : 'Interactive', Summary: { low: 'Low', medium: 'Medium', detailed: 'Detailed' }[summary], Complexity: known.complexity === 'very-complex' ? 'Very complex' : 'Not complex' };
    const selections = Array.isArray(selection) ? selection : args.questions.map(q => [typeof selection === 'string' ? selection : labels[q.header]]);
    const formatted = args.questions.map((q, i) => `"${q.question}"="${selections[i].join(', ')}"`).join(', ');
    await hooks['tool.execute.after']({ ...call, args }, { title: `Asked ${args.questions.length} question${args.questions.length > 1 ? 's' : ''}`, output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`, metadata: { answers: selections, truncated: false } });
    return { call, args };
  }
  let userIndex = 0;
  function user(text) {
    const id = `user-${++userIndex}`;
    parent[0] = { info: { id, sessionID: runtime.sessionID, role: 'user' }, parts: [{ type: 'text', text, sessionID: runtime.sessionID, messageID: id }] };
    context.messageID = `msg-parent-${userIndex}`;
    parent[1] = { info: { ...info, id: context.messageID }, parts: [] };
  }
  async function change(kind = 'rerun', requirements) {
    return JSON.parse(await hooks.tool.mdd_change_request.execute({ kind, userText: parent[0].parts[0].text,
      ...(kind === 'material' ? { requirements, concerns: [{ category: 'integrations', evidence: 'The user requested a new integration.', impact: 'The approved acceptance map must be replanned.' }] } : {}) }, context));
  }
  let index = 0;
  const visited = [];
  async function phase(options = {}) {
    const current = await status();
    const args = current.task;
    assert.ok(args, `Expected task, got ${current.state}`);
    const phase = args.subagent_type;
    for (const prior of visited) assert.ok(args.prompt.includes(`Artifact for ${prior}`), `Missing ${prior} dependency in ${phase}`);
    if (phase === 'mdd-apply') assert.ok(args.prompt.includes('Trusted local mdd-cleanup instructions with provenance'));
    // Prose phases carry the documentation guide; structural ones do not pay for it.
    assert.equal(args.prompt.includes('Trusted local mdd-doc instructions with provenance'),
      !['mdd-tasks', 'mdd-apply'].includes(phase), `mdd-doc injection for ${phase}`);
    const callID = `task-${++index}`;
    const call = { sessionID: runtime.sessionID, callID, tool: 'task' };
    parent[1].parts = [{ type: 'tool', tool: 'task', callID, state: { status: 'running', input: args } }];
    await hooks['tool.execute.before'](call, { args });
    const childID = `child-${index}`;
    parent[1].parts[0].state.metadata = { sessionId: childID, parentSessionId: runtime.sessionID, model };
    sessions.set(childID, { id: childID, parentID: runtime.sessionID, directory: root, projectID: 'project', agent: phase, permission: [{ permission: 'task', pattern: '*', action: 'deny' }] });
    const child = [{ info: { id: `msg-${index}`, sessionID: childID, role: 'assistant', agent: phase, ...model, path: { cwd: root, root }, time: { completed: 10 }, finish: 'stop' }, parts: [] }];
    histories.set(childID, child);
    if (options.beforeMismatch) child[0].info.modelID = 'substituted';
    await hooks['chat.message']({ sessionID: childID }, { message: { agent: phase }, parts: [] });
    async function tool(name, input, output, execute = async () => {}) {
      const tc = { sessionID: childID, callID: `${name}-${index}`, tool: name };
      const part = { type: 'tool', tool: name, callID: tc.callID, sessionID: childID, messageID: child[0].info.id, state: { status: 'running', input: structuredClone(input) } };
      child[0].parts.push(part);
      await hooks['tool.execute.before'](tc, { args: input });
      if (options.denied) {
        await hooks.event({ event: { type: 'message.part.updated', properties: { part: { ...part, state: { status: 'error', input, error: 'Permission denied.' } } } } });
        throw new Error('Simulated native permission denial.');
      }
      await execute();
      if (!options.missingAfter) await hooks['tool.execute.after']({ ...tc, args: input }, output);
      part.state = { status: 'completed', input: structuredClone(input), ...output };
      return tc.callID;
    }
    const result = { phase, runID: current.runID ?? current.explorationID, callID, outcome: options.outcome ?? 'passed', evidenceSummary: `Actual contract evidence for ${phase}.`, artifact: `Artifact for ${phase}: scoped requirements, changes and executable check plan.` };
    if (options.concerns) result.concerns = options.concerns;
    if (options.unauthorized) await tool('write', { filePath: join(root, 'feature.txt'), content: 'not permitted' }, { output: 'write', metadata: {} }, () => writeFile(join(root, 'feature.txt'), 'not permitted'));
    if (phase === 'mdd-apply') {
      if (options.noChange) {
        await tool('read', { filePath: join(root, 'feature.txt') }, { output: 'Inspected existing implementation.', metadata: { truncated: false } });
        result.noChangeReason = 'Inspected implementation already satisfies the scoped task.';
      }
      else {
        const filePath = options.external ? join(root, '../escape.txt') : join(root, 'feature.txt');
        const id = await tool('write', { filePath, content: 'implemented\n' }, { output: 'Wrote file successfully.', metadata: { filepath: filePath, exists: true, diagnostics: {}, truncated: false } }, () => writeFile(filePath, 'implemented\n'));
        result.changes = [id];
      }
    } else if (phase === 'mdd-verify') {
      if (!options.noChecks) {
        const command = 'npm test';
        const text = options.empty ? '(no output)' : options.skippedOnly ? '3 skipped' : '1 test passed';
        const id = await tool('bash', { command, workdir: root, description: 'Run scoped tests' }, { output: text, metadata: { output: text, exit: options.exit === undefined ? 0 : options.exit, truncated: options.truncated ?? false } });
        result.checks = [{ callID: options.forged ? 'invented' : id, command }];
      } else result.checks = [];
    } else await tool('read', { filePath: join(root, 'feature.txt') }, { output: 'Inspected project context.', metadata: { truncated: false } });
    const trace = traceFixture(join(root, 'feature.txt'), 'feature');
    if (phase === 'mdd-plan') Object.assign(result, trace);
    if (phase === 'mdd-spec') { result.domain = 'project'; result.acceptance = trace.acceptance; }
    if (phase === 'mdd-design') result.decisions = trace.decisions;
    if (phase === 'mdd-tasks') result.deliverables = trace.deliverables;
    if (phase === 'mdd-verify') {
      const assessment = { status: 'verified', checks: [`bash-${index}`], assessment: 'The inspected boundary and planned check output support the expected behavior.' };
      result.verification = { scenarios: ['S1', 'S2'].map(scenarioID => ({ requirementID: 'R1', scenarioID, stepID: 'feature', ...assessment })),
        steps: [{ stepID: 'feature', ...assessment }], decisions: [{ decisionID: 'D1', ...assessment }], changes: options.noChange ? 'No implementation change was needed.' : 'The requested input handling is implemented.', limits: [] };
      if (options.coverageFault === 'missing') result.verification.scenarios.pop();
      if (options.coverageFault === 'invented') result.verification.scenarios[0].requirementID = 'invented';
      if (options.coverageFault === 'drift' || options.coverageFault === 'partial') {
        result.verification.decisions[0].status = 'deviation';
        result.verification.decisions[0].assessment = 'Input handling diverges from the planned boundary.';
        result.verification.limits = ['Boundary behavior still needs alignment with the plan.'];
        if (options.coverageFault === 'partial') result.outcome = 'failed';
      }
    }
    if (options.large) {
      const suffix = traceArtifact(phase, '', trace.acceptance, trace.decisions, trace.deliverables, result.verification);
      result.artifact += 'x'.repeat(16000 - Buffer.byteLength(result.artifact) - Buffer.byteLength(suffix));
    }
    if (options.mismatch) child[0].info.modelID = 'substituted';
    const text = JSON.stringify(result);
    child[0].parts.push({ type: 'text', sessionID: childID, messageID: child[0].info.id, text });
    const output = { title: 'Native task', metadata: { sessionId: childID, parentSessionId: runtime.sessionID, model }, output: `<task id="${childID}" state="completed">\n<task_result>\n${text}\n</task_result>\n</task>` };
    await hooks['tool.execute.after']({ ...call, args }, output);
    visited.push(phase);
    return status();
  }
  if (start) await hooks.tool.mdd_start.execute({ requirements }, context);
  return { root, settings, hooks, status, phase, answer, user, change, input, context, parent, runtime, visited, requirements, writes: memory.writes, questions: () => questionCount };
}

for (const route of ['low', 'high']) for (const store of ['none', 'openspec']) for (const mode of ['automatic', 'interactive']) {
  test(`memory off complete native route: ${route}/${store}/${mode}, no transport or service`, async t => {
    t.mock.method(globalThis, 'fetch', () => { assert.fail('Memory off fetched'); });
    t.mock.method(ManagedMemory.prototype, 'endpoint', () => { assert.fail('Memory off started a service'); });
    const f = await fixture(t, { route, store, mode, memoryEnabled: false, partial: true });
    await f.answer();
    const phases = (await f.status()).workflow.evaluation.phases;
    for (const phase of phases) {
      assert.equal((await f.status()).task.subagent_type, phase);
      await f.phase();
      if ((await f.status()).question) await f.answer();
    }
    const status = await f.status();
    assert.equal(status.state, 'complete');
    assert.equal(status.memory, 'off');
    assert.equal(status.coverage, 100);
    assert.equal(f.writes.length, 0);
    for (const artifact of status.artifacts) {
      assert.equal(artifact.ref.observationID, undefined);
      if (store === 'openspec') assert.ok(artifact.ref.path);
    }
    await f.hooks.event({ event: { type: 'server.instance.disposed', properties: { directory: f.root } } });
  });
}

for (const fault of [{ forged: true }, { coverageFault: 'missing' }, { exit: 1 }]) {
  test(`memory off retains native command and acceptance rejection: ${JSON.stringify(fault)}`, async t => {
    t.mock.method(globalThis, 'fetch', () => assert.fail('Memory off fetched'));
    const f = await fixture(t, { memoryEnabled: false });
    await f.phase(); await f.phase();
    await assert.rejects(f.phase(fault));
    assert.equal((await f.status()).state, 'blocked');
    assert.equal((await f.status()).task, undefined);
  });
}

test('memory off contextual exploration and restart guard retain local provenance without HTTP', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Memory off fetched'));
  const f = await fixture(t, { memoryEnabled: false });
  await f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Inspect the current feature boundary.' }, f.context);
  await f.phase();
  assert.equal((await f.status()).workflow.results.length, 0);
  await f.phase();
  const restarted = await plugin(f.input);
  assert.equal(JSON.parse(await restarted.tool.mdd_status.execute({}, f.context)).state, 'recovery-blocked');
});

for (const route of ['low', 'high']) for (const mode of ['automatic', 'interactive']) for (const store of ['none', 'openspec', 'engram', 'both']) {
  test(`complete native contract: ${route}/${mode}/${store} exact route and grounded coverage`, async t => {
    const f = await fixture(t, { route, mode, store, partial: mode === 'interactive' });
    const initial = await f.status();
    if (initial.question) await f.answer();
    const phases = (await f.status()).workflow.evaluation.phases;
    assert.equal(phases.length, route === 'low' ? 3 : 7);
    for (const phase of phases) {
      assert.equal((await f.status()).task.subagent_type, phase);
      await f.phase();
      const current = await f.status();
      const completed = current.workflow.results.map(result => result.phase);
      const expectedCoverage = completed.includes('mdd-verify') ? 100 : completed.includes('mdd-apply') ? 65 : completed.some(phase => ['mdd-plan', 'mdd-tasks'].includes(phase)) ? 40 : 20;
      assert.equal(current.coverage, expectedCoverage);
      if (current.question) await f.answer();
    }
    const final = await f.status();
    assert.equal(final.state, 'complete'); assert.equal(final.coverage, 100);
    assert.deepEqual(f.visited, phases); assert.equal(final.artifacts.length, phases.length);
    if (route === 'low') assert.equal(final.artifacts.filter(item => item.ref.phase === 'mdd-plan').length, 1);
    assert.equal(f.questions(), mode === 'interactive' ? phases.length : 0);
    assert.equal(final.workflow.results.length, phases.length);
    final.evidence.checks = 'invalidated'; final.acceptance.requirements[0].id = 'changed'; final.verification.matched = false;
    assert.equal((await f.status()).coverage, 100); assert.equal((await f.status()).acceptance.requirements[0].id, 'R1');
    const general = f.writes.filter(write => write.type === 'workflow');
    assert.equal(general.length, phases.length * 2);
    assert.ok(general.every(write => !write.content.includes('Artifact for')));
    const events = (await readFile(join(f.root, '.mdd/telemetry.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(events.filter(event => event.event === 'phase-start').length, phases.length);
    assert.equal(events.filter(event => event.event === 'preflight').length, 1);
    for (const event of events) assert.ok(Object.keys(event).every(key => ['timestamp', 'event', 'phase', 'duration', 'route', 'outcome'].includes(key)));
  });
}

for (const [name, fault] of Object.entries({ nonzero: { exit: 1 }, interrupted: { exit: null }, empty: { empty: true }, truncated: { truncated: true }, forged: { forged: true }, skipped: { noChecks: true }, skippedOnly: { skippedOnly: true }, missingHistory: { missingAfter: true }, model: { mismatch: true } })) {
  test(`Verify rejects ${name} evidence and withdraws affected coverage`, async t => {
    const f = await fixture(t);
    await f.phase(); await f.phase();
    assert.equal((await f.status()).coverage, 65);
    await assert.rejects(f.phase(fault));
    const blocked = await f.status();
    assert.equal(blocked.state, 'blocked'); assert.equal(blocked.coverage, 40);
    assert.equal(blocked.task, undefined); assert.equal(blocked.workflow.results.length, 2);
  });
}

test('Apply no-change result earns no implementation credit; executable checks remain required', async t => {
  const f = await fixture(t); await f.phase(); await f.phase({ noChange: true }); await f.phase();
  assert.equal((await f.status()).state, 'complete'); assert.equal((await f.status()).coverage, 75);
  assert.match((await f.status()).report, /No implementation change was recorded/);
});
test('Apply external edit is rejected before writes and no later task becomes available', async t => {
  const f = await fixture(t); await f.phase(); await assert.rejects(f.phase({ external: true }));
  assert.equal((await f.status()).state, 'blocked');
});
for (const summary of ['low', 'medium', 'detailed']) {
  test(`live report ${summary} and disabled telemetry`, async t => {
    const f = await fixture(t, { summary, telemetry: false });
    for (let current = await f.status(); current.task; current = await f.status()) await f.phase();
    const status = await f.status();
    assert.match(status.report, /Make the requested feature usable/);
    assert.match(status.report, /requirements and plan matched/);
    assert.doesNotMatch(status.report, /mdd-|task-\d|bash-\d|receipt/i);
    assert.equal(status.report.includes('\nHow\n'), summary !== 'low');
    assert.equal(status.report.includes('evidence coverage (not probability)'), summary === 'detailed');
    await assert.rejects(readFile(join(f.root, '.mdd/telemetry.jsonl')), { code: 'ENOENT' });
  });
}
test('late result memory failure never completes Verify or retains checks credit', async t => {
  const f = await fixture(t, { memoryFault(req, reply, writes) {
    const last = writes.at(-1);
    if (req.method === 'POST' && last?.type === 'workflow') { const body = JSON.parse(last.content); if (body.kind === 'agent-evidence' && body.phase === 'mdd-verify') reply.status = 500; }
  } });
  await f.phase(); await f.phase(); await assert.rejects(f.phase());
  assert.equal((await f.status()).coverage, 40); assert.equal((await f.status()).state, 'blocked');
});

for (const fault of ['missing', 'invented', 'drift', 'partial']) {
  test(`acceptance closure cannot claim success for ${fault} coverage`, async t => {
    const f = await fixture(t); await f.phase(); await f.phase();
    if (fault === 'partial') await f.phase({ coverageFault: fault });
    else await assert.rejects(f.phase({ coverageFault: fault }));
    const status = await f.status();
    assert.equal(status.state, 'blocked'); assert.equal(status.coverage, 40);
    assert.match(status.report, /Not complete: requirements and plan are not fully verified/);
    assert.doesNotMatch(status.report, /100%|requirements and plan matched/);
    if (fault === 'drift' || fault === 'partial') {
      assert.equal(status.verification.decisions[0].status, 'deviation');
      assert.match(status.report, /diverges from the planned boundary/);
    }
  });
}

test('combined dependency budget fails explicitly without truncation or Verify dispatch', async t => {
  const f = await fixture(t, { route: 'high' });
  let blocked = false;
  for (let i = 0; i < 7; i++) {
    try { await f.phase({ large: true }); }
    catch (error) { assert.match(error.message, /combined phase handoff/); blocked = true; break; }
  }
  assert.equal(blocked, true); assert.equal((await f.status()).state, 'blocked');
  assert.ok(!f.visited.includes('mdd-verify'));
});
test('telemetry storage failure is bounded and does not fabricate a failed phase', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, '.mdd/telemetry.jsonl'), 'malformed private content');
  await f.phase(); await f.phase(); await f.phase();
  const status = await f.status();
  assert.equal(status.state, 'complete');
  assert.equal(status.telemetryDiagnostic, 'telemetry-unavailable');
  assert.ok(!JSON.stringify(status).includes('malformed private content'));
});
test('low route with exploration preserves all four native phases', async t => {
  const f = await fixture(t, { route: 'low-explore' });
  for (let current = await f.status(); current.task; current = await f.status()) await f.phase();
  assert.deepEqual(f.visited, ['mdd-explore', 'mdd-plan', 'mdd-apply', 'mdd-verify']);
  assert.equal((await f.status()).coverage, 100);
});
for (const fault of [{ denied: true }, { beforeMismatch: true }]) {
  test(`Apply native refusal or model mismatch prevents writes: ${JSON.stringify(fault)}`, async t => {
    const f = await fixture(t); await f.phase(); await assert.rejects(f.phase(fault));
    assert.equal(await readFile(join(f.root, 'feature.txt'), 'utf8'), 'pending\n');
    const status = await f.status(); assert.equal(status.state, 'blocked'); assert.equal(status.coverage, 40);
  });
}

test('confirmed rerun asks every field once despite complete profile and preserves old run evidence', async t => {
  const f = await fixture(t); await f.phase();
  const old = await f.status();
  f.user('Please rerun the preflight for this task.');
  const confirmation = await f.change();
  assert.equal(confirmation.question.questions.length, 1);
  await f.answer();
  const preflight = await f.status(); assert.equal(preflight.question.questions.length, 5);
  assert.equal(preflight.runID, old.runID);
  await f.answer([['Very sure'], ['None'], ['Interactive'], ['Low'], ['Not complex']]);
  const next = await f.status();
  assert.notEqual(next.runID, old.runID); assert.equal(next.task.subagent_type, 'mdd-plan');
  assert.equal(next.previousRuns[0].runID, old.runID);
  assert.deepEqual(next.previousRuns[0].artifacts, old.artifacts);
  assert.deepEqual(next.previousRuns[0].acceptance, old.acceptance);
  assert.equal(next.workflow.answers.mode, 'interactive'); assert.equal(next.previousRuns[0].workflow.answers.mode, 'automatic');
  assert.equal(f.questions(), 2);
  await assert.rejects(f.change(), /fresh actual user/);
});
test('rejected material change restores exact answers, plan and pending approval', async t => {
  const f = await fixture(t, { mode: 'interactive' }); await f.phase();
  const old = await f.status();
  f.user('Consider adding a new integration.'); await f.change('material', 'Implement the feature with the new integration.');
  await f.answer('Keep current plan');
  const current = await f.status();
  assert.equal(current.runID, old.runID); assert.deepEqual(current.workflow, old.workflow);
  assert.deepEqual(current.question, old.question); assert.deepEqual(current.acceptance, old.acceptance);
});
test('confirmed material change replans from new requirements after one grouped preflight', async t => {
  const f = await fixture(t); const old = await f.status();
  f.user('Change the scope to include an integration.');
  await f.change('material', 'New integration requirements.'); await f.answer(); await f.answer();
  const next = await f.status();
  assert.notEqual(next.runID, old.runID); assert.match(next.task.prompt, /New integration requirements/);
  assert.equal(next.workflow.results.length, 0); assert.equal(next.acceptance, undefined);
});
test('invalid change parameters and wrong user text do not poison a ready plan', async t => {
  const f = await fixture(t); const old = await f.status();
  f.user('Please rerun.');
  await assert.rejects(f.hooks.tool.mdd_change_request.execute({ kind: 'rerun', userText: 'forged' }, f.context));
  await assert.rejects(f.hooks.tool.mdd_change_request.execute({ kind: 'material', userText: 'Please rerun.', requirements: 'New scope', concerns: [{ category: 'style', evidence: 'x', impact: 'x' }] }, f.context));
  assert.equal((await f.status()).state, 'ready'); assert.deepEqual((await f.status()).task, old.task);
});
test('known failed phase permits a confirmed new planned run; unknown native result does not', async t => {
  const known = await fixture(t); await known.phase({ outcome: 'failed' });
  assert.equal((await known.status()).uncertain, false);
  const failed = await known.status();
  await known.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Inspect the known failure without retrying it.' }, known.context);
  await known.phase(); assert.deepEqual((await known.status()).workflow, failed.workflow);
  known.user('Replan this failed task.'); await known.change(); await known.answer(); await known.answer();
  assert.equal((await known.status()).state, 'ready'); assert.equal((await known.status()).previousRuns[0].workflow.results[0].outcome, 'failed');
  const unknown = await fixture(t); await assert.rejects(unknown.phase({ missingAfter: true }));
  assert.equal((await unknown.status()).uncertain, true);
  unknown.user('Try again.'); await assert.rejects(unknown.change(), /Uncertain|in-flight/);
});
test('new task after completion uses profile without a redundant change confirmation', async t => {
  const f = await fixture(t); await f.phase(); await f.phase(); await f.phase();
  const old = await f.status(); f.user('A new independent requested outcome.');
  await f.hooks.tool.mdd_start.execute({ requirements: 'A new independent requested outcome.' }, f.context);
  const next = await f.status(); assert.equal(next.state, 'ready'); assert.notEqual(next.runID, old.runID);
  assert.equal(f.questions(), 0); assert.equal(next.previousRuns[0].lastState, 'complete');
});
for (const mode of ['automatic', 'interactive']) {
  test(`contextual exploration preserves ${mode} main workflow and approval`, async t => {
    const f = await fixture(t, { mode, store: 'both' }); await f.phase();
    const old = await f.status();
    await f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Inspect integration uncertainty without changing the plan.' }, f.context);
    const side = await f.status(); assert.equal(side.contextual, true); assert.equal(side.task.subagent_type, 'mdd-explore'); assert.equal(side.question, undefined);
    await assert.rejects(f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Duplicate side task' }, f.context));
    await f.phase({ concerns: [{ category: 'integrations', evidence: 'An integration assumption needs inspection.', impact: 'May affect a later explicit scope request.' }] });
    const current = await f.status();
    assert.deepEqual(current.workflow, old.workflow); assert.deepEqual(current.evidence, old.evidence); assert.deepEqual(current.acceptance, old.acceptance);
    assert.equal(current.contexts.length, 1); assert.match(current.contexts[0].artifact.ref.path, /explorations/);
    assert.equal(current.contexts[0].artifact.ref.explorationID, current.contexts[0].explorationID);
    assert.deepEqual(current.question, old.question);
    if (current.question) await f.answer();
    assert.match((await f.status()).task.prompt, /Contextual findings/);
    assert.match((await f.status()).task.prompt, /integration assumption needs inspection/);
    await f.phase();
    assert.equal((await f.status()).contextualReport, undefined);
    assert.equal((await f.status()).contexts.length, 1);
  });
}
test('side exploration does not expose Apply capabilities and invalid purpose leaves main ready', async t => {
  const f = await fixture(t); const old = await f.status();
  await assert.rejects(f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'x'.repeat(2001) }, f.context));
  assert.deepEqual((await f.status()).task, old.task);
  await f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Inspect only.' }, f.context);
  assert.match((await f.status()).task.prompt, /Contextual exploration only/);
  await f.phase({ outcome: 'failed' });
  assert.deepEqual((await f.status()).workflow, old.workflow); assert.equal((await f.status()).contexts[0].outcome, 'failed');
});
// Regression: one grep refused outside the workspace used to block the whole investigation,
// and every later tool call then reported a misleading dispatch error.
test('a refused read lets the investigation continue instead of ending it', async t => {
  const f = await fixture(t, { start: false, memoryEnabled: false });
  await f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Buscar el issue 389.' }, f.context);
  // phase({denied}) dispatches the task, runs a child read through the hooks, then reports the
  // native permission denial exactly as OpenCode does. Apply's write denial still blocks; see
  // "Apply native refusal or model mismatch prevents writes".
  await assert.rejects(f.phase({ denied: true }), /Simulated native permission denial/);
  const after = await f.status();
  assert.equal(after.state, 'await-result', 'a refused read must not end the investigation');
  assert.equal(after.contextual, true);
});

// Regression: a rewritten mdd_start blocked the intake, and because no run existed the
// change request could never settle it. With a stopped investigation also reporting itself
// as in flight, the conversation had no way out at all.
test('a failed intake can be replaced by a fresh request instead of stranding the parent', async t => {
  const f = await fixture(t, { start: false, memoryEnabled: false });
  f.user('Trabajemos en el issue 389.');
  await assert.rejects(f.hooks.tool.mdd_start.execute({ requirements: 'Un resumen reescrito del issue.' }, f.context),
    /exactly match the latest native user text/);
  assert.equal((await f.status()).state, 'blocked');
  // A stopped standalone investigation must not keep the parent looking busy either.
  await f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Mirar el issue.' }, f.context);
  await assert.rejects(f.phase({ unauthorized: true }));
  f.user('Trabajemos en el issue 389.');
  await f.hooks.tool.mdd_start.execute({ requirements: 'Trabajemos en el issue 389.' }, f.context);
  const started = await f.status();
  assert.equal(started.state, 'ready');
  assert.equal(started.task.subagent_type, 'mdd-plan');
});

test('read-only investigation answers without an accepted run and leaves implementation available', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Read-only investigation fetched'));
  const f = await fixture(t, { start: false, memoryEnabled: false });
  assert.equal((await f.status()).state, 'not-started');
  await f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Explain what this project is about.' }, f.context);
  const ready = await f.status();
  assert.equal(ready.contextual, true);
  assert.equal(ready.task.subagent_type, 'mdd-explore');
  assert.match(ready.task.prompt, /Standalone read-only investigation only/);
  assert.match(ready.task.prompt, /No MDD run is accepted/);
  await assert.rejects(f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'A concurrent investigation.' }, f.context), /already in progress/);
  await f.phase();
  const done = await f.status();
  assert.equal(done.task, undefined);
  assert.equal(done.contextual, false);
  assert.equal(done.contexts.length, 1);
  assert.match(done.contextualReport, /Read-only investigation completed/);
  assert.match(done.contextualReport, /Artifact for mdd-explore/);
  assert.equal(f.writes.length, 0);
  assert.ok(!(await readdir(join(f.root, '.mdd')).catch(() => [])).some(name => name.startsWith('progress-')));
  f.user(f.requirements);
  await f.hooks.tool.mdd_start.execute({ requirements: f.requirements }, f.context);
  const started = await f.status();
  assert.equal(started.state, 'ready');
  assert.equal(started.task.subagent_type, 'mdd-plan');
  assert.equal(started.contextual, false);
});
for (const fault of [{ unauthorized: true }, { beforeMismatch: true }]) {
  test(`read-only investigation without a run keeps capability and model boundaries: ${JSON.stringify(fault)}`, async t => {
    const f = await fixture(t, { start: false, memoryEnabled: false });
    await f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Read project context only.' }, f.context);
    await assert.rejects(f.phase(fault));
    const stopped = await f.status();
    // A stopped investigation is finished, not in flight: it must not look like main work.
    assert.equal(stopped.state, 'not-started');
    assert.equal(stopped.contextual, false);
    assert.ok(stopped.contextualReason, 'the rejection stays visible');
    assert.equal(await readFile(join(f.root, 'feature.txt'), 'utf8'), 'pending\n');
    await f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Ask a different read-only question.' }, f.context);
    assert.equal((await f.status()).task.subagent_type, 'mdd-explore');
  });
}
test('a recovery-blocked conversation still answers read-only investigation', async t => {
  const f = await fixture(t, { memoryEnabled: false });
  await f.phase();
  const restarted = await plugin(f.input);
  assert.equal(JSON.parse(await restarted.tool.mdd_status.execute({}, f.context)).state, 'recovery-blocked');
  await restarted.tool.mdd_contextual_explore.execute({ purpose: 'Explain the recorded project state.' }, f.context);
  const ready = JSON.parse(await restarted.tool.mdd_status.execute({}, f.context));
  assert.equal(ready.contextual, true);
  assert.equal(ready.task.subagent_type, 'mdd-explore');
  await assert.rejects(restarted.tool.mdd_start.execute({ requirements: 'Continue the old work.' }, f.context));
});

test('restart detects pending work without repeating memory writes', async t => {
  const f = await fixture(t, { partial: true }); await f.answer(); const ready = await f.status();
  const call = { sessionID: f.runtime.sessionID, callID: 'uncertain-task', tool: 'task' };
  f.parent[1].parts = [{ type: 'tool', tool: 'task', callID: call.callID, state: { status: 'running', input: ready.task } }];
  await f.hooks['tool.execute.before'](call, { args: ready.task });
  f.user('Rerun while still pending.'); await assert.rejects(f.change(), /Uncertain|in-flight/);
  const restarted = await plugin(f.input);
  const status = JSON.parse(await restarted.tool.mdd_status.execute({}, f.context));
  assert.equal(status.state, 'recovery-blocked');
  assert.equal(status.question, undefined);
  const writes = f.writes.length;
  await assert.rejects(restarted.tool.mdd_start.execute({ requirements: 'Rerun while still pending.' }, f.context), /restart|repeated/);
  assert.equal(f.writes.length, writes);
});

for (const stage of ['confirmation', 'preflight']) {
  test(`dismissed change ${stage} restores the original pending approval`, async t => {
    const f = await fixture(t, { mode: 'interactive' }); await f.phase(); const old = await f.status();
    f.user('Rerun preflight.'); await f.change(); if (stage === 'preflight') await f.answer();
    const current = await f.status();
    const call = { sessionID: f.runtime.sessionID, callID: `cancel-${stage}`, tool: 'question' };
    f.parent[1].parts = [{ type: 'tool', tool: 'question', callID: call.callID, sessionID: f.runtime.sessionID, messageID: f.context.messageID, state: { status: 'running', input: current.question } }];
    await f.hooks['tool.execute.before'](call, { args: current.question });
    await f.hooks.event({ event: { type: 'message.part.updated', properties: { part: { ...call, type: 'tool', state: { status: 'error' } } } } });
    const restored = await f.status(); assert.equal(restored.runID, old.runID); assert.deepEqual(restored.workflow, old.workflow); assert.deepEqual(restored.question, old.question);
  });
}
test('stale change confirmation cannot approve a later phase or erase the old run', async t => {
  const f = await fixture(t); await f.phase(); f.user('Rerun preflight.'); await f.change();
  const used = await f.answer(); await f.answer(); const next = await f.status();
  await assert.rejects(f.hooks['tool.execute.after']({ ...used.call, args: used.args }, { title: 'Approved', output: 'approved', metadata: { answers: [['Confirm change']], truncated: false } }));
  const blocked = await f.status(); assert.equal(blocked.runID, next.runID); assert.equal(blocked.previousRuns.length, 1); assert.equal(blocked.workflow.results.length, 0);
});
for (const fault of [{ unauthorized: true }, { beforeMismatch: true }]) {
  test(`side exploration retains read-only/model boundaries ${JSON.stringify(fault)}`, async t => {
    const f = await fixture(t); const main = await f.status();
    await f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Read context only.' }, f.context);
    await assert.rejects(f.phase(fault));
    const status = await f.status(); assert.deepEqual(status.workflow, main.workflow); assert.deepEqual(status.evidence, main.evidence);
    assert.equal(await readFile(join(f.root, 'feature.txt'), 'utf8'), 'pending\n');
  });
}
test('advisory concerns alone do not change routing or create a confirmation question', async t => {
  const f = await fixture(t); const initial = await f.status();
  await f.phase({ concerns: [{ category: 'sensitive-data', evidence: 'A data handling assumption needs review.', impact: 'May matter if scope changes.' }] });
  const status = await f.status(); assert.equal(status.question, undefined); assert.deepEqual(status.workflow.answers, initial.workflow.answers);
  assert.equal(status.concerns[0].category, 'sensitive-data'); assert.equal(f.questions(), 0);
});
test('a recorded material concern can be proposed once without inventing new human input', async t => {
  const f = await fixture(t);
  const concern = { category: 'integrations', evidence: 'The inspected integration assumption differs from the original scope.', impact: 'A new integration would require replanning.' };
  await f.phase({ concerns: [concern] }); const old = await f.status();
  const args = { kind: 'material', userText: f.parent[0].parts[0].text, requirements: 'Implement a different integration.', concerns: [concern] };
  await f.hooks.tool.mdd_change_request.execute(args, f.context);
  await f.answer('Keep current plan');
  await assert.rejects(f.hooks.tool.mdd_change_request.execute(args, f.context), /already presented/);
  assert.deepEqual((await f.status()).workflow, old.workflow);
});
test('context accumulation is bounded without truncating results or advancing the main workflow', async t => {
  const f = await fixture(t); await f.phase(); const main = await f.status();
  let stopped = false;
  for (let i = 0; i < 8; i++) {
    try {
      await f.hooks.tool.mdd_contextual_explore.execute({ purpose: `Read-only investigation ${i}.` }, f.context);
      await f.phase({ large: true });
    } catch (error) { assert.match(error.message, /combined phase handoff/); stopped = true; break; }
  }
  assert.equal(stopped, true);
  const final = await f.status(); assert.deepEqual(final.workflow, main.workflow);
  assert.ok(final.contexts.length > 0);
  assert.ok(final.contexts.every(context => Buffer.byteLength(context.artifact.content) === 16000));
});

test('native PR-body tool drafts recorded facts without changing workflow, approval or memory', async t => {
  const f = await fixture(t); await f.phase(); await f.phase(); await f.phase();
  f.user('Please draft the PR body.\nNot applicable.');
  const before = await f.status(); const writes = f.writes.length;
  const draft = JSON.parse(await f.hooks.tool.mdd_pr_body.execute({ userText: 'Please draft the PR body.\nNot applicable.', notes: { environmentVariables: 'Not applicable.', deployment: 'Not applicable.' } }, f.context));
  assert.match(draft.body, /1 scoped file/); assert.match(draft.body, /npm test; exit 0/);
  assert.equal(draft.publication, 'not-authorized'); assert.equal(draft.provenance.runID, before.runID);
  assert.ok(!draft.body.includes(f.root)); assert.deepEqual(await f.status(), before); assert.equal(f.writes.length, writes);
});
test('PR-body tool preserves pending approval and refuses wrong user/parent evidence claims', async t => {
  const f = await fixture(t, { mode: 'interactive' }); await f.phase(); f.user('Draft a preliminary PR body.');
  const before = await f.status();
  const draft = JSON.parse(await f.hooks.tool.mdd_pr_body.execute({ userText: 'Draft a preliminary PR body.' }, f.context));
  assert.match(draft.body, /No implementation change evidence/); assert.match(draft.body, /not fully verified/);
  await assert.rejects(f.hooks.tool.mdd_pr_body.execute({ userText: 'The work was approved and deployed.' }, f.context));
  await assert.rejects(f.hooks.tool.mdd_pr_body.execute({ userText: 'Draft a preliminary PR body.' }, { ...f.context, sessionID: 'other-parent' }));
  assert.deepEqual(await f.status(), before);
});
