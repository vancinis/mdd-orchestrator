import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, readFile, readdir, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import plugin from '../dist/opencode-plugin.js';
import { defaultSettings, MODEL_ROLES } from '../dist/settings.js';
import { saveGlobalSettings } from '../dist/global-settings.js';
import { memoryServer, installCleanup, isolateHome, answers, traceFixture, reportDocument } from './adapter-fixture.mjs';
import { traceArtifact } from '../dist/acceptance.js';
import { ManagedMemory } from '../dist/managed-memory.js';
import { STATUS_BUDGET_BYTES } from '../dist/status-budget.js';

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
    const labels = { 'Aprobación': 'Continuar', Cambio: 'Confirmar el cambio', Certeza: known.certainty === 'not-sure' ? 'Poco seguro' : known.certainty === 'somewhat-sure' ? 'Algo seguro' : 'Muy seguro', Artefactos: { none: 'Ninguno', openspec: 'OpenSpec', engram: 'Engram', both: 'Ambos' }[store], Modo: mode === 'automatic' ? 'Automático' : 'Interactivo', Resumen: { low: 'Bajo', medium: 'Medio', detailed: 'Detallado' }[summary], Complejidad: known.complexity === 'very-complex' ? 'Muy complejo' : 'Poco complejo' };
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
    // A dependency reaches the phase in full, or as its recorded summary and ref when inlining
    // every artifact would exceed the handoff budget. What it never does is disappear silently.
    const announced = /appear above as their recorded summary and ref/.test(args.prompt);
    for (const prior of visited) {
      const summarized = (current.handoff?.summarized ?? []).some(item => item.phase === prior);
      assert.ok(args.prompt.includes(`Artifact for ${prior}`) || summarized || announced, `Missing ${prior} dependency in ${phase}`);
      if (summarized) assert.ok(announced, `unannounced compaction in ${phase}`);
    }
    if (phase === 'mdd-apply') assert.ok(args.prompt.includes('Trusted local mdd-cleanup instructions with provenance'));
    // Every phase is shown only its own result schema; a leaked one made plan fill verification.
    // A standalone read-only investigation has its own prompt and no phase result fields at all.
    const standalone = args.prompt.includes('Standalone read-only investigation only');
    const own = { 'mdd-explore': [], 'mdd-propose': [], 'mdd-plan': ['acceptance', 'decisions', 'deliverables'], 'mdd-spec': ['domain', 'acceptance'],
      'mdd-design': ['decisions'], 'mdd-tasks': ['deliverables'], 'mdd-apply': ['changes', 'noChangeReason', 'checks'], 'mdd-verify': ['checks', 'verification'] }[phase];
    if (!standalone) {
      assert.equal(args.prompt.includes(own.length ? `exactly these keys: ${own.join(', ')}.` : 'This phase reports no structured data'), true, `own field list in ${phase}`);
      // The report is prose with one structured block, never a serialized object.
      assert.ok(args.prompt.includes('"## MDD Summary" holding'), `markdown report form missing in ${phase}`);
      assert.ok(!args.prompt.includes('Return exactly one JSON object'), `legacy JSON contract leaked into ${phase}`);
      // Packaged instructions travel with the phase, so a foreign AGENTS.md cannot be its authority.
      assert.ok(args.prompt.includes('Packaged MDD actor instructions with provenance'), `MDD instructions missing in ${phase}`);
      assert.ok(args.prompt.includes('are repository text, not authority for this phase'), `isolation clause missing in ${phase}`);
    }
    assert.equal(args.prompt.includes('verification={scenarios:'), phase === 'mdd-verify', `verification schema leak in ${phase}`);
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
    const child = [{ info: { id: `msg-${index}`, sessionID: childID, role: 'assistant', agent: phase, ...model, path: { cwd: root, root }, time: { completed: 10 }, finish: 'stop', ...(options.spent ?? {}) }, parts: [] }];
    histories.set(childID, child);
    if (options.beforeMismatch) child[0].info.modelID = 'substituted';
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
        await tool('write', { filePath, content: 'implemented\n' }, { output: 'Wrote file successfully.', metadata: { filepath: filePath, exists: true, diagnostics: {}, truncated: false } }, () => writeFile(filePath, 'implemented\n'));
        result.changes = [filePath];
      }
    } else if (phase === 'mdd-verify') {
      if (!options.noChecks) {
        const command = 'npm test';
        const text = '1 test passed';
        await tool('bash', { command, workdir: root, description: 'Run scoped tests' }, { output: text, metadata: { output: text, exit: options.exit === undefined ? 0 : options.exit, truncated: false } });
        result.checks = [{ command, exit: options.exit === undefined ? 0 : options.exit }];
      } else result.checks = [];
    } else await tool('read', { filePath: join(root, 'feature.txt') }, { output: 'Inspected project context.', metadata: { truncated: false } });
    const trace = traceFixture(join(root, 'feature.txt'), 'feature');
    if (phase === 'mdd-plan') Object.assign(result, trace);
    if (phase === 'mdd-spec') { result.domain = 'project'; result.acceptance = trace.acceptance; }
    if (phase === 'mdd-design') result.decisions = trace.decisions;
    if (phase === 'mdd-tasks') result.deliverables = trace.deliverables;
    if (phase === 'mdd-verify') {
      const assessment = { status: 'verified', checks: ['npm test'], assessment: 'The inspected boundary and planned check output support the expected behavior.' };
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
    const text = reportDocument(result);
    child[0].parts.push({ type: 'text', sessionID: childID, messageID: child[0].info.id, text });
    const output = { title: 'Native task', metadata: { sessionId: childID, parentSessionId: runtime.sessionID, model }, output: `<task id="${childID}" state="completed">\n<task_result>\n${text}\n</task_result>\n</task>` };
    if (options.badEnvelope) output.output = 'the delegated task did not finish';
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

for (const fault of [{ noChecks: true }, { coverageFault: 'missing' }]) {
  test(`memory off rejects an inconsistent report and keeps the phase runnable: ${JSON.stringify(fault)}`, async t => {
    t.mock.method(globalThis, 'fetch', () => assert.fail('Memory off fetched'));
    const f = await fixture(t, { memoryEnabled: false });
    await f.phase(); await f.phase();
    await assert.rejects(f.phase(fault));
    const after = await f.status();
    assert.equal(after.state, 'ready');
    // An inconsistent report is still a report: the checks it describes were either run or not,
    // and re-running the phase cannot change that. It comes back to be restated instead.
    assert.equal(after.attempts, 0);
    assert.equal(after.mode, 'inline');
    assert.ok(after.rejected, 'the refused report is handed back to be corrected');
    assert.ok(after.task, 'a rejected report leaves the phase runnable');
    assert.equal(after.workflow.results.length, 2);
  });
}

test('memory off contextual exploration keeps local provenance, and a restart leaves the conversation usable', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Memory off fetched'));
  const f = await fixture(t, { memoryEnabled: false });
  await f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Inspect the current feature boundary.' }, f.context);
  await f.phase();
  assert.equal((await f.status()).workflow.results.length, 0);
  await f.phase();
  const restarted = await plugin(f.input);
  // Settled work is not in flight: the conversation is free, it simply does not resume by itself.
  // Its evidence is preserved as data, which must not turn into a block on starting new work.
  const after = JSON.parse(await restarted.tool.mdd_status.execute({}, f.context));
  assert.equal(after.state, 'recoverable');
  assert.equal(after.priorRun.capability, 'data-only');
  assert.equal(after.task, undefined, 'a preserved run is never runnable');
  f.user('A different objective for this conversation.');
  const fresh = JSON.parse(await restarted.tool.mdd_start.execute({ requirements: 'A different objective for this conversation.' }, f.context));
  assert.equal(fresh.state, 'ready');
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
    // The ledger stays metadata: identities are opaque, everything else is an enum or a number,
    // and no field exists that could carry requirements, a path or any other text.
    for (const event of events) {
      assert.ok(Object.keys(event).every(key => ['timestamp', 'event', 'phase', 'duration', 'route', 'outcome', 'runID', 'attempt', 'mode', 'failure', 'usage'].includes(key)));
      assert.equal(event.runID, final.runID);
      assert.ok(!/[A-Za-z]{2}/.test(event.runID.replaceAll(/[0-9a-f-]/g, '')));
    }
  });
}

// MDD does not re-run anything, so the one honesty it can enforce is that the report agrees
// with itself: an assessment may not lean on a check the same phase never reported running.
test('Verify rejects an assessment citing a check it never reported, keeping earned coverage', async t => {
  const f = await fixture(t);
  await f.phase(); await f.phase();
  assert.equal((await f.status()).coverage, 65);
  await assert.rejects(f.phase({ noChecks: true }), /did not report running/);
  const after = await f.status();
  assert.equal(after.state, 'ready'); assert.equal(after.coverage, 65);
  assert.equal(after.task.subagent_type, 'mdd-verify'); assert.equal(after.workflow.results.length, 2);
});

for (const [name, exit] of Object.entries({ nonzero: 1, interrupted: null })) {
  test(`a ${name} check cannot support a verified assessment`, async t => {
    const f = await fixture(t);
    await f.phase(); await f.phase();
    await assert.rejects(f.phase({ exit }), /did not pass/);
    const after = await f.status();
    assert.equal(after.state, 'ready'); assert.equal(after.coverage, 65);
    assert.equal(after.evidence.checks, 'unearned');
  });
}

test('Apply no-change result earns no implementation credit; executable checks remain required', async t => {
  const f = await fixture(t); await f.phase(); await f.phase({ noChange: true }); await f.phase();
  assert.equal((await f.status()).state, 'complete'); assert.equal((await f.status()).coverage, 75);
  assert.match((await f.status()).report, /No implementation change was recorded/);
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
    // The level the user chose is named in the payload, not buried in a droppable snapshot: the
    // coordinator cannot present the report they asked for if it has to guess which one that is.
    assert.equal(status.reportDetail, summary);
    await assert.rejects(readFile(join(f.root, '.mdd/telemetry.jsonl')), { code: 'ENOENT' });
  });
}

// Answering "medium" used to move a routing score and nothing else a person could see. The level
// now reaches the actor writing the summary, so the summary itself changes, not only its wrapper.
test('the chosen report detail reaches the actor that writes the summary', async t => {
  for (const [summary, expected] of [['low', /brief reports/], ['medium', /medium-detail reports/], ['detailed', /detailed reports/]]) {
    const f = await fixture(t, { summary, memoryEnabled: false });
    const ready = await f.status();
    assert.match(ready.task.prompt, expected, `${summary} never reached the phase prompt`);
    assert.equal(ready.reportDetail, summary);
  }
});
test('late result memory failure never completes Verify or retains checks credit', async t => {
  const f = await fixture(t, { memoryFault(req, reply, writes) {
    const last = writes.at(-1);
    if (req.method === 'POST' && last?.type === 'workflow') { const body = JSON.parse(last.content); if (body.kind === 'agent-evidence' && body.phase === 'mdd-verify') reply.status = 500; }
  } });
  await f.phase(); await f.phase(); await assert.rejects(f.phase());
  assert.equal((await f.status()).coverage, 65); assert.equal((await f.status()).state, 'ready');
  assert.equal((await f.status()).evidence.checks, 'unearned');
});

for (const fault of ['missing', 'invented', 'drift', 'partial']) {
  test(`acceptance closure cannot claim success for ${fault} coverage`, async t => {
    const f = await fixture(t); await f.phase(); await f.phase();
    if (fault === 'partial') {
      // A phase that reports failure is a recorded outcome: it closes the route and withdraws
      // the evidence it could not stand behind.
      await f.phase({ coverageFault: fault });
      const status = await f.status();
      assert.equal(status.state, 'blocked'); assert.equal(status.coverage, 40);
      assert.match(status.report, /Not complete: requirements and plan are not fully verified/);
      assert.doesNotMatch(status.report, /100%|requirements and plan matched/);
      assert.equal(status.verification.decisions[0].status, 'deviation');
      assert.match(status.report, /diverges from the planned boundary/);
      return;
    }
    await assert.rejects(f.phase({ coverageFault: fault }));
    const status = await f.status();
    assert.equal(status.state, 'ready'); assert.equal(status.coverage, 65);
    assert.doesNotMatch(status.report, /100%|requirements and plan matched/);
  });
}

// Seven phases of maximum-size artifacts outgrow the handoff budget, and the route used to die
// there: at Tasks, Apply or Verify, after everything that produced them had already been paid for.
// The oldest artifacts now travel as their own recorded summary plus the ref that still identifies
// the full text, announced in the prompt, while recent ones stay whole.
test('a long route compacts its oldest artifacts instead of dying at the handoff budget', async t => {
  const f = await fixture(t, { route: 'high' });
  let compacted;
  for (let i = 0; i < 7; i++) {
    // Verify reports its own links, which share the artifact bound, so it does not fill it.
    await f.phase({ large: i < 6 });
    const current = await f.status();
    if (current.handoff && current.task) compacted ??= current;
  }
  const final = await f.status();
  assert.equal(final.state, 'complete');
  assert.ok(f.visited.includes('mdd-verify'));
  assert.ok(compacted, 'a seven-phase route of maximum artifacts must exceed the handoff budget');
  // Oldest first, and the phase that produced each one is still named with its store record.
  assert.equal(compacted.handoff.summarized[0].phase, 'mdd-explore');
  assert.ok(compacted.handoff.summarized.every(item => item.recordID));
  assert.equal(compacted.task.prompt.includes('Artifact for mdd-explore'), false);
  assert.match(compacted.task.prompt, /appear above as their recorded summary and ref/);
  assert.ok(Buffer.byteLength(compacted.task.prompt) <= 96000);
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
// A refused native permission belongs to the user and the actor, not to MDD: the write simply
// does not happen and MDD keeps waiting for the delegated result instead of sealing the run.
test('a refused native write leaves the file untouched and the dispatch still awaits its result', async t => {
  const f = await fixture(t); await f.phase();
  await assert.rejects(f.phase({ denied: true }), /Simulated native permission denial/);
  assert.equal(await readFile(join(f.root, 'feature.txt'), 'utf8'), 'pending\n');
  const waiting = await f.status();
  assert.equal(waiting.state, 'await-result');
  assert.equal(waiting.coverage, 40);
  // When that task ends without a result, the phase is released rather than lost.
  await f.hooks.event({ event: { type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'task', sessionID: f.runtime.sessionID, callID: 'task-2', state: { status: 'error' } } } } });
  const released = await f.status();
  assert.equal(released.state, 'ready'); assert.equal(released.task.subagent_type, 'mdd-apply');
});

test('confirmed rerun asks every field once despite complete profile and preserves old run evidence', async t => {
  const f = await fixture(t); await f.phase();
  const old = await f.status();
  f.user('Please rerun the preflight for this task.');
  const confirmation = await f.change();
  assert.equal(confirmation.question.questions.length, 1);
  await f.answer();
  const preflight = await f.status(); assert.equal(preflight.question.questions.length, 5);
  assert.equal(preflight.runID, old.runID);
  await f.answer([['Muy seguro'], ['Ninguno'], ['Interactivo'], ['Bajo'], ['Poco complejo']]);
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
  await f.answer('Mantener el plan actual');
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
  // A rejected attempt used to mark the run uncertain forever, which then refused every repair
  // path. Releasing it is what keeps replanning, investigation and reset reachable after a failure.
  const unknown = await fixture(t); await assert.rejects(unknown.phase({ badEnvelope: true }));
  assert.equal((await unknown.status()).uncertain, false);
  assert.equal((await unknown.status()).state, 'ready');
  unknown.user('Try again.');
  assert.equal((await unknown.change()).question.questions.length, 1);
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
    /exactly match an actual native user message/);
  assert.equal((await f.status()).state, 'blocked');
  // A stopped standalone investigation must not keep the parent looking busy either.
  await f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Mirar el issue.' }, f.context);
  await assert.rejects(f.phase({ badEnvelope: true }));
  f.user('Trabajemos en el issue 389.');
  await f.hooks.tool.mdd_start.execute({ requirements: 'Trabajemos en el issue 389.' }, f.context);
  const started = await f.status();
  assert.equal(started.state, 'ready');
  assert.equal(started.task.subagent_type, 'mdd-plan');
});

// Regression: interrupting the coordinator and then writing "continue" made the continuation the
// latest user text, and the objective it continued could never be started in that conversation.
test('an interrupted objective still starts after the user writes a continuation message', async t => {
  const f = await fixture(t, { start: false, memoryEnabled: false });
  const objective = 'Corrige el bind de memoria cuando la raíz nativa es un worktree.';
  f.user(objective);
  const requested = f.parent[0];
  f.user('te interrumpi, puedes continuar');
  f.parent.unshift(requested);
  // Continuation text is not an objective, and inventing one from it is still refused.
  await assert.rejects(f.hooks.tool.mdd_start.execute({ requirements: 'Un resumen reescrito del objetivo.' }, f.context),
    /exactly match an actual native user message/);
  await f.hooks.tool.mdd_start.execute({ requirements: objective }, f.context);
  const started = await f.status();
  assert.equal(started.state, 'ready');
  assert.equal(started.task.subagent_type, 'mdd-plan');
});

// A ledger that cannot say what a phase cost cannot answer the question it exists for. The child
// session the task envelope names is the only place that price is reported.
test('a delegated phase records the tokens its own child session reported', async t => {
  const f = await fixture(t, { memoryEnabled: false });
  await f.phase({ spent: { tokens: { input: 1200, output: 340, reasoning: 20, cache: { read: 90, write: 10 } }, cost: 0.0125 } });
  const rows = (await readFile(join(f.root, '.mdd/telemetry.jsonl'), 'utf8')).trim().split('\n').map(row => JSON.parse(row));
  const ended = rows.findLast(row => row.event === 'phase-end');
  assert.deepEqual(ended.usage, { input: 1200, output: 340, reasoning: 20, cacheRead: 90, cacheWrite: 10, cost: 0.0125, messages: 1 });
  assert.equal(ended.phase, 'mdd-plan');
  assert.equal(ended.mode, 'delegate');
  assert.equal(ended.attempt, 1);
  assert.match(ended.runID, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(new Set(rows.map(row => row.runID)).size, 1);
  const rollup = JSON.parse(await readFile(join(f.root, '.mdd/telemetry-rollup.json'), 'utf8'));
  assert.equal(rollup.phases['mdd-plan'].input, 1200);
  assert.equal(rollup.phases['mdd-plan'].cost, 0.0125);
  assert.equal(rollup.phases['mdd-plan'].measured, 1);
  assert.equal(rollup.phases['mdd-plan'].partial, 0);
  // A host that reports no usage produces a run without numbers, never a failed phase.
  await f.phase();
  const quiet = (await readFile(join(f.root, '.mdd/telemetry.jsonl'), 'utf8')).trim().split('\n').map(row => JSON.parse(row)).findLast(row => row.event === 'phase-end');
  assert.equal(quiet.phase, 'mdd-apply');
  assert.equal(quiet.usage, undefined);
  assert.equal((await f.status()).telemetryDiagnostic, undefined);
});

test('a failed attempt is filed under the class that ended it, with what it spent getting there', async t => {
  const f = await fixture(t, { memoryEnabled: false });
  const spent = { tokens: { input: 900, output: 120, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.004 };
  await f.phase({ outcome: 'failed', spent });
  const rows = (await readFile(join(f.root, '.mdd/telemetry.jsonl'), 'utf8')).trim().split('\n').map(row => JSON.parse(row));
  const ended = rows.findLast(row => row.event === 'phase-end');
  assert.equal(ended.outcome, 'failed');
  assert.equal(ended.failure, 'phase-failed');
  assert.equal(ended.usage.input, 900);
  const rollup = JSON.parse(await readFile(join(f.root, '.mdd/telemetry-rollup.json'), 'utf8'));
  assert.equal(rollup.failures['phase-failed'], 1);
  assert.equal(rollup.phases['mdd-plan'].failed, 1);
  assert.equal(rollup.phases['mdd-plan'].input, 900);
  assert.equal(rollup.runs.blocked, 1);
});

test('a result that names no session is charged to nobody rather than to a guess', async t => {
  const f = await fixture(t, { memoryEnabled: false });
  await assert.rejects(f.phase({ badEnvelope: true, spent: { tokens: { input: 900, output: 120, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.004 } }));
  const rows = (await readFile(join(f.root, '.mdd/telemetry.jsonl'), 'utf8')).trim().split('\n').map(row => JSON.parse(row));
  const ended = rows.findLast(row => row.event === 'phase-end');
  assert.equal(ended.outcome, 'blocked');
  assert.equal(ended.failure, 'result-rejected');
  // The envelope that would name the child is exactly what was malformed, so the spending is
  // real but unattributable. Recording it against this phase anyway would be inventing evidence.
  assert.equal(ended.usage, undefined);
  assert.equal(rows.findLast(row => row.event === 'retry').failure, 'result-rejected');
  const rollup = JSON.parse(await readFile(join(f.root, '.mdd/telemetry-rollup.json'), 'utf8'));
  assert.equal(rollup.failures['result-rejected'], 1);
  assert.equal(rollup.phases['mdd-plan'].retries, 1);
  assert.equal(rollup.phases['mdd-plan'].blocked, 1);
  assert.equal(rollup.phases['mdd-plan'].measured, 0);
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
  // Standalone investigation leaves no local trace at all: neither a marker nor a preserved run.
  const traces = await readdir(join(f.root, '.mdd')).catch(() => []);
  assert.ok(!traces.some(name => name.startsWith('progress-')));
  assert.ok(!traces.some(name => name.startsWith('run-')));
  f.user(f.requirements);
  await f.hooks.tool.mdd_start.execute({ requirements: f.requirements }, f.context);
  const started = await f.status();
  assert.equal(started.state, 'ready');
  assert.equal(started.task.subagent_type, 'mdd-plan');
  assert.equal(started.contextual, false);
});
{
  test('a standalone investigation that does not complete is finished, not in flight', async t => {
    const f = await fixture(t, { start: false, memoryEnabled: false });
    await f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Read project context only.' }, f.context);
    await assert.rejects(f.phase({ badEnvelope: true }));
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
test('a restarted conversation still answers read-only investigation', async t => {
  const f = await fixture(t, { memoryEnabled: false });
  await f.phase();
  const restarted = await plugin(f.input);
  // The lost run is reported as recoverable data, and that must not occupy the dispatch slot:
  // read-only investigation stays reachable exactly as it was when nothing had been preserved.
  assert.equal(JSON.parse(await restarted.tool.mdd_status.execute({}, f.context)).state, 'recoverable');
  await restarted.tool.mdd_contextual_explore.execute({ purpose: 'Explain the recorded project state.' }, f.context);
  const ready = JSON.parse(await restarted.tool.mdd_status.execute({}, f.context));
  assert.equal(ready.contextual, true);
  assert.equal(ready.task.subagent_type, 'mdd-explore');
  await assert.rejects(restarted.tool.mdd_start.execute({ requirements: 'Continue the old work.' }, f.context));
});

test('a run lost mid-route keeps its plan reachable as read-only data', async t => {
  // The actual incident: the process died during mdd-apply after ~40 minutes. Artifacts were
  // persisted in Engram, but the index naming them lived only in memory, so nothing was findable.
  const f = await fixture(t, { route: 'low-explore', store: 'engram' });
  const phases = (await f.status()).workflow.evaluation.phases;
  assert.deepEqual(phases.slice(0, 2), ['mdd-explore', 'mdd-plan']);
  await f.phase(); await f.phase();
  const live = await f.status();
  assert.equal(live.state, 'ready');
  assert.equal(live.task.subagent_type, 'mdd-apply');
  // Fresh instances over the same directory hold empty maps, exactly like a restarted plugin.
  const restarted = await plugin(f.input);
  const status = JSON.parse(await restarted.tool.mdd_status.execute({}, f.context));
  assert.equal(status.state, 'recoverable');
  assert.equal(status.recovery, 'data-only');
  assert.equal(status.priorRun.capability, 'data-only');
  assert.equal(status.priorRun.runID, live.runID);
  assert.equal(status.priorRun.phase, 'mdd-apply');
  assert.deepEqual(status.priorRun.results.map(item => item.phase), ['mdd-explore', 'mdd-plan']);
  assert.equal(status.priorRun.requirements, f.requirements);
  // What the lost time actually bought: the acceptance map, the plan and the artifact bodies.
  assert.equal(status.priorRun.acceptance.goal, traceFixture().acceptance.goal);
  assert.equal(status.priorRun.planned.length, 1);
  assert.equal(status.priorRun.artifacts.length, 2);
  assert.match(status.priorRun.artifacts[1].content, /Artifact for mdd-plan/);
  // The Engram observation ID is retained as a diagnostic identifier, not as a live capability.
  assert.ok(status.priorRun.artifacts[1].ref.observationID);
  // It is evidence, never something runnable, and it says plainly what it cannot know.
  assert.equal(status.task, undefined);
  assert.equal(status.workflow, undefined);
  assert.ok(status.limits.some(limit => /git status/.test(limit)), 'the working tree must be declared unknown');
  assert.ok(status.limits.some(limit => /approval/i.test(limit)));
  assert.match(status.reason, /does not resume/i);
  // A preserved run informs the restart; it never blocks it. New consent starts new work.
  f.user('Retomemos el objetivo original con consentimiento nuevo.');
  const fresh = JSON.parse(await restarted.tool.mdd_start.execute({ requirements: 'Retomemos el objetivo original con consentimiento nuevo.' }, f.context));
  assert.equal(fresh.state, 'ready');
  assert.notEqual(fresh.runID, live.runID);
  // The new run earns its own evidence: nothing is inherited from the record.
  assert.equal(fresh.workflow.results.length, 0);
  assert.equal(fresh.acceptance, undefined);
  assert.equal(fresh.priorRun, undefined);
});

test('a preserved run restores no approval and no live consent receipt', async t => {
  const f = await fixture(t, { mode: 'interactive', partial: true, memoryEnabled: false });
  await f.answer();
  await f.phase();
  assert.equal((await f.status()).question.questions[0].header, 'Aprobación');
  await f.answer();
  const live = await f.status();
  assert.ok(live.questionReceipts.some(item => item.kind === 'approval'));
  const restarted = await plugin(f.input);
  const status = JSON.parse(await restarted.tool.mdd_status.execute({}, f.context));
  assert.equal(status.state, 'recoverable');
  // Receipts are a historical record of what the user was asked, never live consent: their call
  // IDs are anti-reuse guards, so loading them would both fake approval and cause false refusals.
  assert.deepEqual(status.questionReceipts, []);
  assert.ok(status.priorRun.questionReceipts.some(item => item.kind === 'approval'));
  // There is no restored workflow for an approval to authorize, so no phase is dispatchable.
  assert.equal(status.task, undefined);
  assert.equal(status.next, undefined);
  assert.equal(status.question, undefined);
  // The new run wins its own preflight; the old confirmed requirements flag is not inherited.
  f.user('Empecemos de nuevo con este objetivo.');
  const fresh = JSON.parse(await restarted.tool.mdd_start.execute({ requirements: 'Empecemos de nuevo con este objetivo.' }, f.context));
  assert.equal(fresh.state, 'question-ready');
  assert.deepEqual(fresh.questionReceipts, []);
});

test('mdd_reset with scope run frees the conversation and sets the record aside, memory off', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Memory off fetched'));
  const f = await fixture(t, { memoryEnabled: false });
  await f.phase();
  const names = async () => readdir(join(f.root, '.mdd')).catch(() => []);
  assert.ok((await names()).some(name => name.startsWith('run-')), 'evidence is preserved without memory');
  const restarted = await plugin(f.input);
  const status = JSON.parse(await restarted.tool.mdd_status.execute({}, f.context));
  assert.equal(status.state, 'recoverable');
  assert.equal(status.memory, 'off');
  assert.equal(status.priorRun.results.length, 1);
  JSON.parse(await restarted.tool.mdd_reset.execute({ scope: 'run' }, f.context));
  // The live record is gone, so nothing holds the conversation or offers a recovery it cleared.
  assert.ok(!(await names()).some(name => /^run-[a-f0-9]{64}\.json$/.test(name)), 'the live record no longer occupies the conversation');
  // What the run produced is not destroyed by the request to start something else.
  assert.ok((await names()).some(name => name.endsWith('.discarded.json')), 'the evidence is set aside, not deleted');
  assert.equal(JSON.parse(await restarted.tool.mdd_status.execute({}, f.context)).state, 'not-started');
  // A second discard replaces that slot instead of filling the directory with one file per reset.
  await f.phase();
  JSON.parse(await restarted.tool.mdd_reset.execute({ scope: 'run' }, f.context));
  assert.equal((await names()).filter(name => name.endsWith('.discarded.json')).length, 1);
});

test('restart detects pending work without repeating memory writes', async t => {
  const f = await fixture(t, { partial: true }); await f.answer(); const ready = await f.status();
  const call = { sessionID: f.runtime.sessionID, callID: 'uncertain-task', tool: 'task' };
  f.parent[1].parts = [{ type: 'tool', tool: 'task', callID: call.callID, state: { status: 'running', input: ready.task } }];
  await f.hooks['tool.execute.before'](call, { args: ready.task });
  f.user('Rerun while still pending.'); await assert.rejects(f.change(), /in flight/);
  const restarted = await plugin(f.input);
  const status = JSON.parse(await restarted.tool.mdd_status.execute({}, f.context));
  assert.equal(status.state, 'recovery-blocked');
  assert.equal(status.recoverable, true);
  assert.equal(status.question, undefined);
  const writes = f.writes.length;
  await assert.rejects(restarted.tool.mdd_start.execute({ requirements: 'Rerun while still pending.' }, f.context), /mdd_reset/);
  assert.equal(f.writes.length, writes);
  // The conversation is not sealed: an explicit reset releases it in place.
  JSON.parse(await restarted.tool.mdd_reset.execute({ scope: 'run' }, f.context));
  assert.equal(JSON.parse(await restarted.tool.mdd_status.execute({}, f.context)).state, 'not-started');
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
  await assert.rejects(f.hooks['tool.execute.after']({ ...used.call, args: used.args }, { title: 'Approved', output: 'approved', metadata: { answers: [['Confirmar el cambio']], truncated: false } }));
  const blocked = await f.status(); assert.equal(blocked.runID, next.runID); assert.equal(blocked.previousRuns.length, 1); assert.equal(blocked.workflow.results.length, 0);
});
test('a side exploration that does not complete restores the main plan untouched', async t => {
  const f = await fixture(t); const main = await f.status();
  await f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Read context only.' }, f.context);
  await assert.rejects(f.phase({ badEnvelope: true }));
  const status = await f.status();
  assert.deepEqual(status.workflow, main.workflow); assert.deepEqual(status.evidence, main.evidence);
  assert.equal(status.contextual, false);
  assert.deepEqual(status.task, main.task);
});
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
  await f.answer('Mantener el plan actual');
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
  // The status reports the ref only; the bytes it records still prove nothing was truncated.
  assert.ok(final.contexts.every(context => context.artifact.content === undefined && context.artifact.ref.bytes === 16000));
});

// The observed failure: mdd_status grew past the host output limit, the host truncated it and
// saved the rest to a file, the coordinator could no longer copy the exact task, and it
// abandoned delegation to implement the phase itself. The status must stay copyable instead.
test('a large history keeps mdd_status within budget and the task byte-identical for dispatch', async t => {
  const f = await fixture(t, { route: 'high' });
  await f.phase({ large: true });
  // A superseded run leaves its own history and contexts behind in previousRuns.
  f.user('Please rerun the preflight for this task.');
  await f.change(); await f.answer();
  await f.answer([['Poco seguro'], ['Ninguno'], ['Automático'], ['Bajo'], ['Muy complejo']]);
  f.visited.length = 0;
  await f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Inspect the current feature boundary.' }, f.context);
  await f.phase({ large: true });
  await f.phase({ large: true });
  const previous = await f.status();
  assert.ok(previous.previousRuns === undefined || previous.previousRuns.length === 1);
  const raw = await f.hooks.tool.mdd_status.execute({}, f.context);
  assert.ok(Buffer.byteLength(raw) <= STATUS_BUDGET_BYTES, `mdd_status was ${Buffer.byteLength(raw)} bytes`);
  const status = JSON.parse(raw);
  assert.equal(status.budget, undefined, 'the task fits without an unresolved budget problem');
  // Compacting the oldest artifacts keeps the handoff deliverable in the first place, so a large
  // history no longer has to shed reportable fields; when it still does, it declares them.
  if (status.omitted !== undefined) {
    assert.ok(status.omitted.length > 0, 'what was left out is declared, not silently missing');
    assert.match(status.omittedNote, /Nothing was deleted/);
    for (const key of status.omitted) assert.equal(status[key], undefined);
  }
  assert.ok(status.task && status.state === 'ready');
  // The invariant the bug broke: the task read back from a budgeted status still satisfies the
  // byte-for-byte check in PhaseRunner.before, so delegation survives a large history.
  await f.phase({ large: true });
  const after = await f.status();
  assert.notEqual(after.phase, status.phase, 'the delegated phase actually advanced');
  assert.ok(after.task, 'the next phase stays dispatchable');
});

// Delegation is the default route, never the only one: a subagent that cannot finish the work
// must not be able to stop the user. The phase comes back to the coordinator instead.
test('a failed delegation hands the phase to the coordinator, which finishes it inline', async t => {
  const f = await fixture(t);
  const initial = await f.status();
  assert.equal(initial.mode, 'delegate');
  assert.ok(initial.task, 'delegation is offered first');
  assert.equal(initial.attemptsLeft, 3, 'the phase is told how many dispatches it has');
  // A failure buys another delegated attempt that knows what went wrong: handing the phase over
  // immediately spends the parent's context on work that was delegated to keep it out of there.
  for (const left of [2, 1]) {
    await assert.rejects(f.phase({ badEnvelope: true }), /dispatch that updated task once more/);
    const retry = await f.status();
    assert.equal(retry.state, 'ready');
    assert.equal(retry.mode, 'delegate');
    assert.equal(retry.attemptsLeft, left);
    assert.equal(retry.brief, undefined);
    assert.match(retry.task.prompt, /previous attempt at this exact phase did not complete/);
  }
  await assert.rejects(f.phase({ badEnvelope: true }), /is yours/);
  const handed = await f.status();
  assert.equal(handed.state, 'ready');
  assert.equal(handed.mode, 'inline');
  assert.equal(handed.attempts, 3);
  assert.equal(handed.attemptsLeft, 0);
  assert.match(handed.brief, /carrying this phase out yourself/);
  assert.match(handed.brief, /Perform only mdd-plan/);
  assert.match(handed.brief, /Requirements data/);
  assert.ok(handed.task, 'delegating again stays allowed');
  const done = JSON.parse(await f.hooks.tool.mdd_phase_result.execute({ result: {
    phase: 'mdd-plan', runID: handed.runID, outcome: 'passed',
    evidenceSummary: 'The coordinator planned the work directly after the subagent failed.',
    artifact: 'Plan: implement the scoped feature and check it.',
    ...traceFixture(join(f.root, 'feature.txt'), 'feature'),
  } }, f.context));
  assert.equal(done.workflow.results.length, 1);
  assert.equal(done.workflow.results[0].phase, 'mdd-plan');
  assert.equal(done.evidence.plan, 'confirmed');
  assert.equal(done.task.subagent_type, 'mdd-apply');
  assert.equal(done.mode, 'delegate', 'the next phase starts from delegation again');
  // The failures belonged to the phase that spent them. Carrying them into the next phase is what
  // made one struggling phase send the whole rest of the route into the coordinator's context.
  assert.equal(done.attempts, 0, 'the next phase starts with its own count');
  assert.equal(done.attemptsLeft, 3);
  assert.equal(done.runAttempts, 3, 'the run-wide total still records what was spent');
  assert.equal(JSON.parse(await f.hooks.tool.mdd_status.execute({}, f.context)).artifacts.length, 1);
});

test('an inline report is refused when no phase is waiting for one', async t => {
  const f = await fixture(t, { start: false, memoryEnabled: false });
  await assert.rejects(f.hooks.tool.mdd_phase_result.execute({ result: { phase: 'mdd-plan', runID: 'invented', outcome: 'passed', evidenceSummary: 'x', artifact: 'y' } }, f.context),
    /No MDD run is waiting/);
  f.user(f.requirements);
  await f.hooks.tool.mdd_start.execute({ requirements: f.requirements }, f.context);
  const ready = await f.status();
  await assert.rejects(f.hooks.tool.mdd_phase_result.execute({ result: { phase: 'mdd-apply', runID: ready.runID, outcome: 'passed', evidenceSummary: 'x', artifact: 'y' } }, f.context),
    /names a different phase, run or call/);
  // A report MDD could not read costs no attempt: the work it describes may already be done, so
  // the phase stays runnable, the text comes back, and the coordinator restates it.
  const after = await f.status();
  assert.equal(after.state, 'ready');
  assert.equal(after.attempts, 0, 'a malformed report must not spend an attempt');
  assert.equal(after.mode, 'inline', 'restating a report is the coordinator\'s, not a fresh dispatch');
  assert.match(after.rejected.text, /mdd-apply/);
  assert.equal(after.rejected.restatementsLeft, 2);
  assert.ok(after.resultFormat.some(line => line.includes('## MDD Summary')), 'the form to restate in must travel with the rejection');
});

test('a phase whose report only needs restating is not run again', async t => {
  const f = await fixture(t, { memoryEnabled: false });
  const ready = await f.status();
  // The actor did the work and described it in a shape MDD cannot read.
  await assert.rejects(f.hooks.tool.mdd_phase_result.execute({ result: 'I finished the plan. Everything looks good.' }, f.context), /needs the headings/);
  const held = await f.status();
  assert.equal(held.attempts, 0);
  assert.equal(held.workflow.results.length, 0);
  // Restating the same work in the right form records it, without dispatching anything.
  const restated = JSON.parse(await f.hooks.tool.mdd_phase_result.execute({ result: reportDocument({
    outcome: 'passed', evidenceSummary: 'Planned the CLI boundary change.',
    artifact: 'Plan: validate at the CLI boundary; run npm test afterwards.',
    ...traceFixture(join(f.root, 'feature.txt'), 'feature'),
  }) }, f.context));
  assert.equal(restated.workflow.results[0].phase, ready.phase);
  assert.equal(restated.evidence.plan, 'confirmed');
  assert.equal(restated.rejected, undefined, 'a recorded result clears the report it replaced');
});

test('an MDD run dispatches only its own phase actors', async t => {
  const f = await fixture(t, { memoryEnabled: false });
  const ready = await f.status();
  await assert.rejects(
    f.hooks['tool.execute.before']({ sessionID: f.runtime.sessionID, callID: 'foreign-1', tool: 'task' },
      { args: { description: 'Do the thing', subagent_type: 'gentle-ai', prompt: 'anything' } }),
    /dispatches only its own phase actors/);
  // The refusal changes nothing: the real phase is still exactly where it was.
  const held = await f.status();
  assert.equal(held.state, 'ready');
  assert.equal(held.attempts, 0);
  assert.equal(held.task.subagent_type, ready.phase);
});

test('MDD tools belong to the coordinator and are withdrawn from every other agent', async t => {
  const f = await fixture(t, { start: false });
  const foreign = { ...f.context, agent: 'gentle-ai' };
  const args = { requirements: 'x', userText: 'x', purpose: 'x', kind: 'rerun', scope: 'run' };
  for (const name of ['mdd_status', 'mdd_start', 'mdd_phase_result', 'mdd_reset', 'mdd_change_request', 'mdd_contextual_explore', 'mdd_pr_body']) {
    await assert.rejects(f.hooks.tool[name].execute(args, foreign), /mdd-orchestrator/, `${name} answered a foreign agent`);
  }
  const config = { agent: { 'gentle-ai': {}, 'mdd-orchestrator': {} } };
  await f.hooks.config(config);
  assert.equal(config.agent['gentle-ai'].tools.mdd_status, false);
  assert.equal(config.agent['gentle-ai'].tools['mdd_*'], false);
  assert.equal(config.agent['mdd-orchestrator'].tools, undefined);
});

test('mdd_reset releases a stopped phase and a whole run without a new conversation', async t => {
  const f = await fixture(t);
  await assert.rejects(f.phase({ badEnvelope: true }));
  assert.equal((await f.status()).attempts, 1);
  const released = JSON.parse(await f.hooks.tool.mdd_reset.execute({ scope: 'phase' }, f.context));
  assert.deepEqual(released.reset, { scope: 'phase', phase: 'mdd-plan' });
  assert.equal(released.state, 'ready');
  assert.equal(released.attempts, 0);
  assert.equal(released.attemptsLeft, 3, 'releasing a phase restores its dispatches');
  assert.equal(released.reason, '');
  await f.phase();
  assert.equal((await f.status()).workflow.results.length, 1);
  const cleared = JSON.parse(await f.hooks.tool.mdd_reset.execute({ scope: 'run' }, f.context));
  assert.equal(cleared.reset.scope, 'run');
  assert.equal(cleared.state, 'not-started');
  // Freeing the conversation is not destroying what it produced: the record is set aside, named,
  // and no longer reported as recoverable, so the recorded plan survives the reset that frees it.
  assert.match(cleared.reset.preserved.file, /\.mdd\/run-[a-f0-9]{64}\.discarded\.json$/);
  const preserved = JSON.parse(await readFile(join(f.root, cleared.reset.preserved.file), 'utf8'));
  assert.equal(preserved.runID, cleared.reset.preserved.runID);
  assert.equal(preserved.results.length, 1);
  assert.ok(preserved.discardedAt > 0);
  f.user('An entirely different objective.');
  assert.equal(JSON.parse(await f.hooks.tool.mdd_start.execute({ requirements: 'An entirely different objective.' }, f.context)).state, 'ready');
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
