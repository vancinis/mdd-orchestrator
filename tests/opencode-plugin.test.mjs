import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLegacyPlugin as plugin, createInspector, AGENTS_MAX, PERMISSION_MAX } from '../dist/opencode-plugin.js';
import { NativeIntake } from '../dist/native-intake.js';
import { PhaseRunner } from '../dist/phase-runner.js';
import { RunOwnershipStore } from '../dist/run-ownership.js';
import { CheckpointStore, CheckpointStorageError } from '../dist/checkpoint.js';
import { ProgressGuard } from '../dist/progress.js';
import { memoryServer, request, result, riskReport, runtime, call, answers, installCleanup, isolateHome, SUMMARY_TEXT, reportDocument } from './adapter-fixture.mjs';
import { MODEL_ROLES } from '../dist/settings.js';
import { defaultSettings, saveSettings } from '../dist/settings.js';
import { saveGlobalSettings } from '../dist/global-settings.js';
import { installationPaths } from '../dist/installation-paths.js';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// SDK responses are contract fakes shaped from OpenCode 1.18.31 release sources.
function sdkFixture(text = '{}', actualRuntime = runtime) {
  const runtime = actualRuntime;
  const phase = 'mdd-explore';
  const model = { providerID: 'contract-provider', modelID: 'contract-model' };
  const permission = [{ permission: '*', pattern: '*', action: 'deny' }, { permission: 'read', pattern: '*', action: 'allow' }];
  const child = { id: 'ses_child', parentID: runtime.sessionID, directory: runtime.directory, projectID: 'proj_test', agent: phase, permission };
  const parent = { id: runtime.sessionID, directory: runtime.directory, projectID: 'proj_test', agent: 'mdd-orchestrator' };
  const parentMessages = [{
    info: { ...model, id: 'msg_parent', sessionID: runtime.sessionID, role: 'assistant', agent: 'mdd-orchestrator', path: { cwd: runtime.directory, root: runtime.worktree } },
    parts: [{ type: 'tool', tool: 'task', callID: call.callID, state: { status: 'running' } }],
  }];
  const childMessages = [{
    info: { ...model, id: 'msg_child', sessionID: child.id, role: 'assistant', agent: phase, time: { completed: 10 }, finish: 'stop', path: { cwd: runtime.directory, root: runtime.worktree } },
    parts: [{ type: 'text', text, sessionID: child.id, messageID: 'msg_child' }],
  }];
  const output = {
    title: 'MDD initial read-only phase', metadata: { model, sessionId: child.id, parentSessionId: runtime.sessionID },
    output: `<task id="${child.id}" state="completed">\n<task_result>\n${text}\n</task_result>\n</task>`,
  };
  const calls = [];
  const input = {
    directory: runtime.directory, worktree: runtime.worktree, project: { id: 'proj_test' },
    client: { app: { agents: async () => ({ data: MODEL_ROLES.map(role => ({ name: role === 'orchestrator' ? 'mdd-orchestrator' : role, mode: role === 'orchestrator' ? 'primary' : 'subagent', permission })) }) }, session: {
      get: async options => { calls.push(options); return { data: options.path.id === child.id ? child : parent }; },
      messages: async options => { calls.push(options); return { data: options.path.id === child.id ? childMessages : parentMessages }; },
    } },
  };
  return { input, parent, child, parentMessages, childMessages, output, calls, phase, runtime };
}

function addNativeUser(f, requirements) {
  f.parentMessages.unshift({ info: { id: 'msg_user', sessionID: f.runtime.sessionID, role: 'user' },
    parts: [{ type: 'text', text: requirements, sessionID: f.runtime.sessionID, messageID: 'msg_user' }] });
}

test('R04: native artifact reader verifies actual child tool and parent task identities', async () => {
  const f = sdkFixture();
  const args = { document: 'history:0', digest: 'a'.repeat(64), offset: 0, limit: 8192 };
  const task = { subagent_type: f.phase, description: 'Read retained history', prompt: 'bound prompt' };
  const part = f.parentMessages[0].parts[0];
  Object.assign(part, { sessionID: f.parent.id, messageID: 'msg_parent' });
  Object.assign(part.state, { input: task, metadata: { sessionId: f.child.id } });
  delete f.childMessages[0].info.time.completed;
  delete f.childMessages[0].info.finish;
  f.childMessages[0].parts = [{ type: 'tool', tool: 'mdd_artifact_read', callID: 'read-call',
    sessionID: f.child.id, messageID: 'msg_child', state: { status: 'running', input: args } }];
  const caller = { ...f.runtime, sessionID: f.child.id, agent: f.phase, messageID: 'msg_child', callID: 'read-call' };
  const inspector = createInspector(f.input);
  assert.deepEqual(await inspector.artifactCaller(caller, args), { parent: f.parent.id, callID: call.callID, args: task });
  const { callID: _readID, ...legacyCaller } = caller;
  assert.deepEqual(await inspector.artifactCaller(legacyCaller, args), { parent: f.parent.id, callID: call.callID, args: task });
  f.childMessages[0].parts.push({ ...f.childMessages[0].parts[0], callID: 'ambiguous' });
  await assert.rejects(inspector.artifactCaller(legacyCaller, args));
  f.childMessages[0].parts.pop();
  for (const change of [{ sessionID: f.parent.id }, { agent: 'general' }, { messageID: 'old-message' }, { callID: 'old-call' }]) {
    await assert.rejects(inspector.artifactCaller({ ...caller, ...change }, args));
  }
  await assert.rejects(inspector.artifactCaller(caller, { ...args, offset: 4 }));
  for (const status of ['completed', 'error', 'pending']) {
    part.state.status = status;
    await assert.rejects(inspector.artifactCaller(caller, args));
  }
  part.state.status = 'running'; part.state.metadata.sessionId = 'sibling';
  await assert.rejects(inspector.artifactCaller(caller, args));
});

test('organic knowledge tools are coordinator-only, disabled without provider calls, and native-grounded when enabled', async t => {
  isolateHome(t);
  const root = await mkdtemp(join(tmpdir(), 'mdd-knowledge-plugin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = sdkFixture('{}', { ...runtime, directory: root, worktree: root });
  const context = { ...f.runtime, messageID: 'msg_parent', abort: new AbortController().signal };
  const { endpoint, binding, writes } = await memoryServer(t);
  binding.directory = root;
  const settings = { ...defaultSettings(), knowledge: { enabled: false }, engram: { endpoint } };
  saveGlobalSettings(settings);
  let hooks = await plugin(f.input);
  for (const name of ['mdd_knowledge', 'mdd_knowledge_record']) {
    assert.ok(hooks.tool[name], name);
    await assert.rejects(hooks.tool[name].execute({}, { ...context, agent: 'general' }), /mdd-orchestrator/);
  }
  const config = { agent: { general: {}, 'mdd-apply': {}, 'mdd-orchestrator': {} } };
  await hooks.config(config);
  assert.equal(config.agent.general.tools.mdd_knowledge, false);
  assert.equal(config.agent['mdd-apply'].tools.mdd_knowledge_record, false);
  const blocked = t.mock.method(globalThis, 'fetch', () => assert.fail('disabled knowledge contacted provider'));
  assert.equal(JSON.parse(await hooks.tool.mdd_knowledge.execute({}, context)).state, 'disabled');
  assert.equal(JSON.parse(await hooks.tool.mdd_knowledge_record.execute({ userText: 'ignored while disabled' }, context)).state, 'disabled');
  blocked.mock.restore();
  saveGlobalSettings({ ...settings, knowledge: { enabled: true } });
  hooks = await plugin(f.input);
  const userText = 'Please improve boundary checks in this project.';
  const observation = { summary: 'Input validation belongs at the boundary.', body: 'Boundary check. Keep the complete private rationale in memory.', applicability: { phases: ['mdd-apply'], paths: ['src'] }, sources: ['src/example.ts'] };
  addNativeUser(f, userText);
  await assert.rejects(hooks.tool.mdd_knowledge_record.execute({ userText: userText + ' forged', observation }, context));
  await assert.rejects(hooks.tool.mdd_knowledge_record.execute({ userText, observation }, { ...context, messageID: 'forged' }));
  assert.equal(writes.length, 0);
  f.parent.parentID = 'foreign';
  await assert.rejects(hooks.tool.mdd_knowledge.execute({}, context), /top-level/);
  delete f.parent.parentID;
  const saved = JSON.parse(await hooks.tool.mdd_knowledge_record.execute({ userText, observation }, context));
  assert.equal(saved.state, 'recorded');
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0].content).provenance.kind, 'coordinator-observation');
  assert.equal(JSON.parse(writes[0].content).version, 2);
  assert.deepEqual(JSON.parse(writes[0].content).dependencies, [{ path: 'src/example.ts', digest: 'missing' }]);
  const found = JSON.parse(await hooks.tool.mdd_knowledge.execute({}, context));
  assert.equal(found.entries.length, 1);
  assert.equal(found.entries[0].freshness, 'fresh');
  assert.equal(JSON.stringify(found).includes('complete private rationale'), false);
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/example.ts'), '');
  assert.equal(JSON.parse(await hooks.tool.mdd_knowledge.execute({}, context)).entries[0].freshness, 'stale');
});

test('legacy security sessions cannot bypass runtime isolation with a forged claimed actor', async t => {
  isolateHome(t); saveGlobalSettings(defaultSettings());
  const f = sdkFixture(); f.child.agent = 'mdd-security';
  const hooks = await plugin(f.input);
  for (const tool of ['read', 'write', 'bash', 'task', 'question', 'mcp_secret', 'mdd_check_report']) {
    await assert.rejects(hooks['tool.execute.before']({ sessionID: f.child.id, callID: `call-${tool}`, tool },
      { args: { phase: 'mdd-security', result: 'document' } }), /security/i);
  }
});

test('legacy restart invalidates audit dispatch and historical security children stay isolated after agent changes', async t => {
  isolateHome(t); saveGlobalSettings(defaultSettings());
  const f = sdkFixture(); f.child.agent = 'general';
  const part = f.parentMessages[0].parts[0];
  part.state.input = { subagent_type: 'mdd-security', description: 'Audit implementation security', prompt: 'mdd:security:lost-handle' };
  part.state.metadata = { sessionId: f.child.id };
  const hooks = await plugin(f.input);
  await assert.rejects(hooks['tool.execute.before']({ sessionID: f.child.id, callID: 'changed-role', tool: 'bash' }, { args: {} }), /security/i);
  await assert.rejects(hooks['tool.execute.before']({ ...call, tool: 'task' }, { args: { ...part.state.input } }), /security/i);
  const output = { ...f.output, metadata: { sessionId: f.child.id } };
  await hooks['tool.execute.after']({ ...call, tool: 'task', args: part.state.input }, output);
  assert.equal(JSON.parse(output.output).state, 'security-invalid');
  assert.equal(JSON.parse(await hooks.tool.mdd_status.execute({}, { ...runtime, messageID: 'msg_parent', abort: new AbortController().signal })).state, 'not-started');
});

test('child termination requires correlated host metadata, a terminal message and idle status', async () => {
  const f = sdkFixture();
  const state = f.parentMessages[0].parts[0].state;
  state.status = 'error';
  state.metadata = { sessionId: f.child.id };
  f.input.client.session.status = async () => ({ data: {} });
  const inspector = createInspector(f.input);
  assert.equal(await inspector.stopped(runtime, call), true);
  f.input.client.session.status = async () => ({ data: { [f.child.id]: { type: 'busy' } } });
  assert.equal(await inspector.stopped(runtime, call), false);
  f.input.client.session.status = async () => ({ data: {} });
  f.childMessages[0].info.finish = 'tool-calls';
  assert.equal(await inspector.stopped(runtime, call), false);
  f.childMessages[0].info.finish = 'stop';
  state.status = 'running';
  assert.equal(await inspector.stopped(runtime, call), false, 'an executing task is not released by a snapshot');
  assert.equal(await inspector.stopped(runtime, call, f.output), true, 'after-hook execution returned and the child is terminal');
  f.child.parentID = 'unrelated';
  assert.equal(await inspector.stopped(runtime, call, f.output), false);
  delete state.metadata;
  assert.deepEqual(await inspector.liveness(runtime, call), { verdict: 'unknown', detail: 'OpenCode recorded no subagent session for this task, so its state cannot be read.' });
  assert.equal(await inspector.stopped(runtime, call, f.output), false);
});

// A restarted or interrupted OpenCode leaves the task marked running and the child's last message
// open forever, because the process that would have closed them is gone. Waiting for them to
// close locked a real conversation for good; the host's own status is the evidence that counts.
test('an orphaned task is stopped once the host has no live loop and the child went silent', async () => {
  const f = sdkFixture();
  const clock = { now: 1_000_000_000 };
  const state = f.parentMessages[0].parts[0].state;
  state.status = 'running';
  state.metadata = { sessionId: f.child.id };
  f.childMessages[0].info = { ...f.childMessages[0].info, time: { created: 5 } };
  delete f.childMessages[0].info.finish;
  f.child.time = { created: 1, updated: clock.now - 50 * 60_000 };
  f.input.client.session.status = async () => ({ data: {} });
  const aborted = [];
  f.input.client.session.abort = async options => { aborted.push(options.path.id); return { data: true }; };
  const inspector = createInspector(f.input, 5000, () => clock.now);
  const orphan = await inspector.liveness(runtime, call);
  assert.equal(orphan.verdict, 'stopped');
  assert.equal(orphan.child, f.child.id);
  assert.match(orphan.detail, /silent for 50 min/);
  // Recent activity is not silence: the instant between a dispatch and its loop stays reserved.
  f.child.time.updated = clock.now - 10_000;
  assert.equal((await inspector.liveness(runtime, call)).verdict, 'unknown');
  // A child the host reports working is running, however stale its history looks.
  f.child.time.updated = clock.now - 50 * 60_000;
  f.input.client.session.status = async () => ({ data: { [f.child.id]: { type: 'busy' } } });
  assert.deepEqual(await inspector.liveness(runtime, call), { verdict: 'running', child: f.child.id, detail: `OpenCode reports subagent session ${f.child.id} as busy.` });
  await inspector.abort(runtime, f.child.id);
  assert.deepEqual(aborted, [f.child.id]);
});

async function setupFixture(t) {
  isolateHome(t);
  const root = await mkdtemp(join(tmpdir(), 'mdd-setup-intake-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = sdkFixture('{}', { ...runtime, directory: root, worktree: root });
  const settings = defaultSettings();
  settings.profiles.default.models['mdd-plan'] = 'secret-provider/secret-model';
  const agents = f.input.client.app.agents;
  f.input.client.app.agents = async () => {
    const result = await agents();
    result.data.find(agent => agent.name === 'mdd-plan').model = { providerID: 'secret-provider', modelID: 'secret-model' };
    return result;
  };
  saveGlobalSettings(settings);
  const requirements = 'Explain the context-only project path without changing it';
  addNativeUser(f, requirements);
  f.parentMessages.at(-1).info.parentID = 'msg_user';
  f.parentMessages.at(-1).parts = [{ type: 'tool', tool: 'mdd_start', callID: 'setup-call', sessionID: f.runtime.sessionID, messageID: 'msg_parent', state: { status: 'running', input: { requirements } } }];
  const context = { ...f.runtime, messageID: 'msg_parent', abort: new AbortController().signal };
  return { ...f, root, context, requirements, hooks: await plugin(f.input) };
}

function legacySetup(f) {
  return { state: 'blocked', setup: { workspaceRoot: f.root, configPath: join(f.root, 'mdd.config.json'), problem: 'missing-engram', missingFields: ['engram.endpoint', 'engram.project'] },
    pendingStart: { requirements: f.requirements }, setupOrigin: { userMessageID: 'msg_user', directory: f.root, worktree: f.root, projectID: 'proj_test' }, questionReceipts: [] };
}

test('memory-off status is normal and does not expose settings values', async t => {
  const f = await setupFixture(t);
  const status = JSON.parse(await f.hooks.tool.mdd_status.execute({}, f.context));
  assert.equal(status.state, 'not-started');
  assert.equal(status.memory, 'off');
  assert.equal(status.setup, undefined);
  assert.equal(JSON.stringify(status).includes('secret-model'), false);
});

test('native instance disposal closes only its matching memory owner; startup remains lazy', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Startup must not contact memory'));
  const f = await setupFixture(t);
  const settings = defaultSettings();
  settings.engram = { mode: 'local', binary: process.execPath, dataDirectory: join(f.root, 'memory') };
  saveGlobalSettings(settings);
  let closed = 0;
  t.mock.method(NativeIntake.prototype, 'close', async () => { closed++; });
  const hooks = await plugin(f.input);
  await hooks.event({ event: { type: 'server.instance.disposed', properties: { directory: join(f.root, 'other') } } });
  assert.equal(closed, 0);
  await hooks.event({ event: { type: 'server.instance.disposed', properties: { directory: f.root } } });
  assert.equal(closed, 1);
  await assert.rejects(readFile(join(f.root, 'memory/engram.db')), /ENOENT/);
});

// Recovery of a setup-only objective is a convenience, not a guard: what keeps a start honest is
// that its requirements must equal the actual latest native user text. So history that cannot
// prove a pending setup means there is none to offer, and only two things still interrupt: a
// conversation that is not this coordinator's, and two candidates that cannot be told apart.
for (const fault of ['forged', 'legacy-error', 'execution', 'child', 'workspace', 'project', 'incomplete', 'compacted', 'compacted-tool', 'duplicate', 'synthetic', 'ownership', 'ambiguous']) {
}

test('invalid setup names actual file without exposing values or claiming tools are available', async t => {
  const f = await setupFixture(t);
  await writeFile(installationPaths().settingsPath, '{"secret":"never-print"');
  await assert.rejects(plugin(f.input), error => error.message.includes(installationPaths().settingsPath) && error.message.includes('tools are unavailable') && !error.message.includes('never-print'));
  saveGlobalSettings(defaultSettings());
});

test('informational_request_does_not_start_implementation: shipped instruction contract only', async () => {
  const asset = await readFile(new URL('../assets/opencode/agents/mdd-orchestrator.md', import.meta.url), 'utf8');
  // Free by default: an information-only request needs no run; strict mode forbids starting one.
  assert.match(asset, /Information-only requests need no run/);
  const { STRICT_COORDINATOR } = await import('../dist/guards.js');
  assert.match(STRICT_COORDINATOR, /Information-only requests MUST NOT use mdd_adapt/);
  assert.match(asset, /Follow the available safe step; when MDD is blocked, say so and keep helping the user directly/);
  assert.match(asset, /works\s+with\s+or\s+without\s+an\s+accepted\s+run/);
  assert.doesNotMatch(asset, /no standalone read-only investigation route/);
  assert.match(asset, /Never end an actor report with an approval question of your own/);
  assert.match(asset, /mdd_pr_body[\s\S]*do not hand-write one/);
  // This checks shipped instructions, not model adherence or a native E2E run.
});

async function pluginFixture(t, known = answers) {
  isolateHome(t);
  const { endpoint, writes, binding } = await memoryServer(t);
  const root = await mkdtemp(join(tmpdir(), 'mdd-plugin-intake-'));
  installCleanup(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  binding.directory = root;
  const f = sdkFixture('{}', { ...runtime, directory: root, worktree: root });
  const settings = defaultSettings();
  settings.profiles.default.answers = { ...known };
  settings.engram = { endpoint, project: 'mdd-test' };
  saveGlobalSettings(settings);
  const requirements = request(endpoint).requirements;
  addNativeUser(f, requirements);
  const hooks = await plugin(f.input);
  const context = { ...f.runtime, messageID: 'msg_parent', abort: new AbortController().signal };
  return { ...f, hooks, context, requirements, writes, settings, root };
}

function questionCall(f, args, callID = 'question_one') {
  const call = { sessionID: f.runtime.sessionID, callID, tool: 'question' };
  f.parentMessages.at(-1).parts = [{ type: 'tool', tool: 'question', callID, sessionID: f.runtime.sessionID, messageID: 'msg_parent', state: { status: 'running', input: structuredClone(args) } }];
  return call;
}

function questionOutput(args, answers) {
  return { title: `Asked ${args.questions.length} question${args.questions.length > 1 ? 's' : ''}`, metadata: { answers, truncated: false },
    output: `User has answered your questions: ${args.questions.map((q, i) => `"${q.question}"="${answers[i].join(', ')}"`).join(', ')}. You can now continue with the user's answers in mind.` };
}

test('OpenCode SDK contract: a completed delegated task yields exactly the actor text', async () => {
  const f = sdkFixture();
  const inspector = createInspector(f.input);
  await inspector.parent(runtime, call.callID);
  assert.equal(await inspector.result(runtime, call, f.phase, f.output), '{}');
});

for (const [name, change] of Object.entries({
  'an unfinished task': f => { f.output.output = '<task id="ses_child" state="running">\\n<task_result>\\n{}\\n</task_result>\\n</task>'; },
  'a wrapper mismatch': f => { f.output.output = 'task completed'; },
  'a missing result': f => { delete f.output.output; },
  'an empty result': f => { f.output.output = '<task id="ses_child" state="completed">\\n<task_result>\\n\\n</task_result>\\n</task>'; },
})) {
  test(`OpenCode SDK contract: reject ${name}`, async () => {
    const f = sdkFixture();
    change(f);
    await assert.rejects(createInspector(f.input).result(runtime, call, f.phase, f.output));
  });
}

// Capability, models and child history are the user's native concern now. MDD only confirms
// who is running it, so an unrelated agent or a nested session cannot drive someone else's run.
for (const [name, change] of Object.entries({
  'wrong parent agent': f => { f.parent.agent = 'build'; },
  'nested parent': f => { f.parent.parentID = 'other'; },
  'wrong parent workspace': f => { f.parent.directory = 'other'; },
  'wrong parent project': f => { f.parent.projectID = 'other'; },
})) {
  test(`OpenCode SDK contract: reject ${name}`, async () => {
    const f = sdkFixture(); change(f);
    await assert.rejects(createInspector(f.input).parent(runtime, call.callID));
  });
}

test('OpenCode SDK contract: bounded callback even if injected client ignores abort', async () => {
  const f = sdkFixture();
  f.input.client.session.get = () => new Promise(() => {});
  await assert.rejects(createInspector(f.input, 20).parent(runtime), /timed out/);
});
test('plugin contract: scoped tools, in-place native args, result gating, no native override', async t => {
  const f = await pluginFixture(t);
  const { hooks, context, writes } = f;
  assert.deepEqual(Object.keys(hooks.tool).sort(), ['mdd_adapt', 'mdd_artifact_read', 'mdd_check_report', 'mdd_contextual_explore', 'mdd_improve', 'mdd_improvements', 'mdd_jd_inspect', 'mdd_knowledge', 'mdd_knowledge_record', 'mdd_pr_body', 'mdd_reset', 'mdd_security', 'mdd_status']);
  assert.deepEqual(Object.keys(hooks.tool.mdd_adapt.args), ['payload']);
  assert.deepEqual(Object.keys(hooks.tool.mdd_contextual_explore.args), ['purpose', 'workItems']);
  const contextSchema = hooks.tool.mdd_pr_body.args.additionalContext;
  assert.ok(contextSchema, 'PR tool exposes bounded discriminated context');
  assert.equal(contextSchema.safeParse([{ section: 'context', source: 'recorded', ref: 'goal' }]).success, true);
  for (const entry of [
    { section: 'context', source: 'recorded', ref: 'goal', text: 'Fabricated replacement.' },
    { section: 'context', source: 'recorded', ref: 'checks' },
    { section: 'custom', source: 'interpretation', text: 'Nota.' },
    { section: 'review', source: 'user', text: 'Nota.', extra: true },
    { section: 'risks', source: 'interpretation', text: 'a'.repeat(1001) },
  ]) assert.equal(contextSchema.safeParse([entry]).success, false);
  assert.equal(contextSchema.safeParse(Array(25).fill({ section: 'review', source: 'user', text: 'Nota.' })).success, false);
  await hooks['tool.execute.before']({ tool: 'read', sessionID: 'other', callID: 'other' }, { args: {} });
});

test('plugin contract: a phase actor may check its own report, and nobody else may call in', async t => {
  const f = await pluginFixture(t);
  const { hooks, context } = f;
  const report = result({ phase: 'mdd-explore' });

  // The actor's own session is the point: it is the last place the report can still be fixed.
  const actor = { ...context, agent: 'mdd-explore', sessionID: 'ses_child' };
  const clean = JSON.parse(await hooks.tool.mdd_check_report.execute({ phase: 'mdd-explore', result: report }, actor));
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.problems, []);
  assert.match(clean.note, /not an acceptance/);

  // A summary has no size limit; only an empty one is a problem of form.
  const large = JSON.parse(await hooks.tool.mdd_check_report.execute(
    { phase: 'mdd-explore', result: report.replace(SUMMARY_TEXT, 'x'.repeat(50000)) }, actor));
  assert.equal(large.ok, true);
  const broken = JSON.parse(await hooks.tool.mdd_check_report.execute(
    { phase: 'mdd-explore', result: report.replace(SUMMARY_TEXT, '') }, actor));
  assert.equal(broken.ok, false);
  assert.ok(broken.problems.some(problem => /summary/i.test(problem)));

  // Checking spends nothing and starts nothing: the run is exactly where it was.
  assert.equal(JSON.parse(await hooks.tool.mdd_status.execute({}, context)).state, 'not-started');

  // The coordinator may check too, because a phase it takes over inline is still a phase.
  await hooks.tool.mdd_check_report.execute({ phase: 'mdd-explore', result: report }, context);
  // Everyone else is told plainly that this says nothing about their session.
  await assert.rejects(
    hooks.tool.mdd_check_report.execute({ phase: 'mdd-explore', result: report }, { ...context, agent: 'build' }),
    /belongs to MDD phase actors/);
});

const jdTask = role => ({ subagent_type: role, description: 'Standalone judgment', prompt: 'Inspect the committed target only.' });

test('standalone judges are admitted concurrently without phase before/after or intake recording', async t => {
  const f = await pluginFixture(t);
  const before = t.mock.method(PhaseRunner.prototype, 'before', () => assert.fail('not a phase'));
  const after = t.mock.method(PhaseRunner.prototype, 'after', () => assert.fail('not a phase'));
  const recorded = t.mock.method(NativeIntake.prototype, 'phaseRecorded', () => assert.fail('not a phase'));
  const initial = JSON.parse(await f.hooks.tool.mdd_status.execute({}, f.context));
  const tasks = ['mdd-jd-judge-a', 'mdd-jd-judge-b'].map(jdTask);
  await Promise.all(tasks.map((args, i) => f.hooks['tool.execute.before'](
    { sessionID: f.runtime.sessionID, callID: `jd-${i}`, tool: 'task' }, { args })));
  for (const [i, args] of tasks.entries()) {
    await f.hooks['tool.execute.after']({ sessionID: f.runtime.sessionID, callID: `jd-${i}`, tool: 'task', args },
      { title: 'Judge', output: '{"findings":[],"evidence":[]}', metadata: {} });
  }
  assert.equal(before.mock.callCount(), 0); assert.equal(after.mock.callCount(), 0); assert.equal(recorded.mock.callCount(), 0);
  assert.deepEqual(JSON.parse(await f.hooks.tool.mdd_status.execute({}, f.context)), initial);
});

test('judges deny arbitrary native/MCP tools live even when native permission is overridden', async t => {
  const f = await pluginFixture(t);
  f.child.agent = 'mdd-jd-judge-a'; f.childMessages[0].info.agent = f.child.agent;
  for (const tool of ['bash', 'edit', 'write', 'apply_patch', 'read', 'glob', 'grep', 'task', 'skill', 'question',
    'mdd_start', 'mdd_check_report', 'engram_mem_save', 'codegraph_explore', 'webfetch', 'execute', 'list_mcp_resources']) {
    await assert.rejects(f.hooks['tool.execute.before']({ tool, sessionID: f.child.id, callID: `judge-${tool}` }, { args: {} }), /immutable|judge|inspection/);
  }
  await assert.rejects(f.hooks.tool.mdd_jd_inspect.execute({ operation: 'tree', commit: 'a'.repeat(40) }, f.context), /judge/);
});

for (const [name, agent] of [['missing', undefined], ['empty', ''], ['whitespace', '   '], ['non-string', 42]]) {
  test(`native actor identity refuses ${name} names in otherwise readable legacy records`, async t => {
    const f = await pluginFixture(t);
    f.child.agent = agent;
    f.childMessages[0].info.agent = agent;
    for (const tool of ['bash', 'read', 'edit']) {
      const args = { agent: 'general', command: 'not executed', filePath: 'not accessed' };
      const before = structuredClone(args);
      await assert.rejects(f.hooks['tool.execute.before']({ sessionID: f.child.id, callID: tool, tool }, { args }),
        /native actor identity/i);
      assert.deepEqual(args, before, 'task/tool arguments cannot supply missing native identity');
    }
  });
}

test('native actor identity preserves completed assistant history fallback and known unrelated sessions', async t => {
  const f = await pluginFixture(t);
  delete f.child.agent;
  f.childMessages[0].info.agent = 'general';
  assert.equal(typeof f.childMessages[0].info.time.completed, 'number');
  const args = { command: 'not executed' };
  const before = structuredClone(args);
  await f.hooks['tool.execute.before']({ sessionID: f.child.id, callID: 'history', tool: 'bash' }, { args });
  assert.deepEqual(args, before);
  f.child.agent = 'general';
  f.childMessages.length = 0;
  await f.hooks['tool.execute.before']({ sessionID: f.child.id, callID: 'session', tool: 'edit' }, { args });
  assert.deepEqual(args, before);
});

test('native actor identity does not replace a nameless latest assistant with stale ordinary session identity', async t => {
  const f = await pluginFixture(t);
  f.child.agent = 'general';
  delete f.childMessages[0].info.agent;
  await assert.rejects(f.hooks['tool.execute.before']({ sessionID: f.child.id, callID: 'nameless', tool: 'edit' }, { args: {} }),
    /native actor identity/i);
});

test('standalone correction holds parent mutations until completion and cannot recurse through tools', async t => {
  const f = await pluginFixture(t);
  const args = jdTask('mdd-jd-fix');
  await f.hooks['tool.execute.before']({ ...call, tool: 'task' }, { args });
  await assert.rejects(f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Inspect the parser.' }, f.context), /correction.*flight/);
  await assert.rejects(f.hooks['tool.execute.before']({ ...call, callID: 'second', tool: 'task' }, { args: jdTask('mdd-jd-fix') }), /correction.*flight/);
  f.child.agent = 'mdd-jd-fix'; f.childMessages[0].info.agent = f.child.agent;
  for (const tool of ['task', 'skill', 'mdd_start', 'mdd_jd_inspect', 'engram_mem_save']) {
    await assert.rejects(f.hooks['tool.execute.before']({ sessionID: f.child.id, tool, callID: tool }, { args: {} }), /fix actor|correction/);
  }
  await f.hooks['tool.execute.before']({ sessionID: f.child.id, tool: 'edit', callID: 'edit' }, { args: {} });
  await f.hooks['tool.execute.after']({ ...call, tool: 'task', args }, { title: 'Fix', output: 'Hand off correction.', metadata: {} });
  await assert.rejects(f.hooks['tool.execute.before']({ sessionID: f.child.id, tool: 'edit', callID: 'late-edit' }, { args: {} }), /admitted|correction/);
});

test('concurrent standalone fix calls admit only one writer after native parent inspection', async t => {
  const f = await pluginFixture(t);
  const results = await Promise.allSettled(['one', 'two'].map(callID => f.hooks['tool.execute.before'](
    { ...call, callID, tool: 'task' }, { args: jdTask('mdd-jd-fix') })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
});

for (const [name, prepare, roles, reason] of [
  ['durable pending intake', f => new RunOwnershipStore(f.root).claimIntake(f.runtime.sessionID, 'pending-intake', 'native-user'),
    ['mdd-jd-judge-a', 'mdd-jd-fix'], /intake|interaction/],
  ['workflow claim without checkpoint', f => {
    const owners = new RunOwnershipStore(f.root);
    owners.claimParent(f.runtime.sessionID, 'unconfirmed-run');
    owners.claim({ runID: 'unconfirmed-run', sessionID: f.runtime.sessionID, directory: f.root, worktree: f.root });
  }, ['mdd-jd-judge-a', 'mdd-jd-fix'], /owner|workflow|checkpoint/],
  ['data-only unfinished implementation', f => new ProgressGuard(f.root).write(f.runtime.sessionID,
    { runID: 'unconfirmed-run', state: 'settled', userMessageID: 'native-user', resumable: false }),
    ['mdd-jd-fix'], /implementation|unfinished|workflow/],
]) {
  test(`standalone admission preserves ${name} after restart`, async t => {
    const f = await pluginFixture(t);
    prepare(f);
    for (const role of roles) await assert.rejects(f.hooks['tool.execute.before'](
      { ...call, callID: role, tool: 'task' }, { args: jdTask(role) }), reason);
  });
}

// mdd-risk is not one of the eight phases the coordinator dispatches, but it shares the same
// report-check tool and the same restricted call permission as every phase actor.
test('plugin contract: the risk actor may check its own report through the same tool', async t => {
  const f = await pluginFixture(t);
  const { hooks, context } = f;
  const riskDocument = reportDocument({
    outcome: 'passed', evidenceSummary: 'Low complexity; recommend the low route.',
    how: 'The symbol has one local caller, so the exploration finding grounds a low route.',
    artifact: 'A local rename with no external callers and no evidenced risk.',
    risk: { route: 'low', complexity: 'low', reason: 'No shared code is touched.',
      evidence: [{ source: 'mdd-explore finding 1', finding: 'the symbol has one local caller' }], risks: [],
      risksJustification: 'No shared code path was found to carry any risk.' },
  });
  const actor = { ...context, agent: 'mdd-risk', sessionID: 'ses_child' };
  const clean = JSON.parse(await hooks.tool.mdd_check_report.execute({ phase: 'mdd-risk', result: riskDocument }, actor));
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.problems, []);

  const broken = JSON.parse(await hooks.tool.mdd_check_report.execute(
    { phase: 'mdd-risk', result: riskDocument.replace('"route": "low"', '"route": "high"') }, actor));
  assert.equal(broken.ok, false);
  assert.ok(broken.problems.some(problem => /must agree/.test(problem)));

  // Nobody outside a phase actor, the risk actor or the coordinator may call in.
  await assert.rejects(
    hooks.tool.mdd_check_report.execute({ phase: 'mdd-risk', result: riskDocument }, { ...context, agent: 'build' }),
    /belongs to MDD phase actors/);
});

// Dispatches whatever phase the status currently asks for and completes it with the given
// report text, returning the next mdd_status. Used to settle exploration and risk before the
// main route's first tail phase, since only that validated verdict reaches review-ready.
let settleOrdinal = 0;
async function settlePhase(f, context, status, text) {
  const { hooks } = f;
  const dispatch = { ...call, callID: `settle_${++settleOrdinal}` };
  f.parentMessages.at(-1).parts = [{ type: 'tool', tool: 'task', callID: dispatch.callID, state: { status: 'running' } }];
  await hooks['tool.execute.before']({ ...dispatch, tool: 'task' }, { args: status.task });
  f.childMessages[0].parts[0].text = text;
  f.output.output = `<task id="ses_child" state="completed">\n<task_result>\n${text}\n</task_result>\n</task>`;
  await hooks['tool.execute.after']({ ...dispatch, tool: 'task', args: status.task }, f.output);
  return JSON.parse(await hooks.tool.mdd_status.execute({}, context));
}

// The history after an interrupted question: the assistant message that showed it, then what the
// user wrote, then the current caller. `beforeQuestion` placed the call in the caller; it moves
// back to the message that actually showed it.
function answeredAfterQuestion(f, text, { before = false } = {}) {
  const caller = f.parentMessages.at(-1);
  const shown = { info: { ...caller.info, id: 'msg_question' },
    parts: caller.parts.map(part => ({ ...part, messageID: 'msg_question', state: { ...part.state, status: 'error' } })) };
  const user = { info: { id: 'msg_user_answer', sessionID: f.runtime.sessionID, role: 'user' },
    parts: [{ type: 'text', text, sessionID: f.runtime.sessionID, messageID: 'msg_user_answer' }] };
  caller.parts = [];
  f.parentMessages.splice(-1, 0, ...(before ? [user, shown] : [shown, user]));
}

const PREFLIGHT_TEXT = '1. algo seguro 2. automatico 3. medio 4. nada que agregar.';
const PREFLIGHT_READING = [{ labels: ['Algo seguro'] }, { labels: ['Automático'] }, { labels: ['Medio'] }, { labels: ['Nada que agregar'] }];

// Drives a fresh run (already past preflight) through exploration and a mdd-risk assessment that
// settles at blocked-risk, through the real plugin hooks, in whichever mode `ready` was started
// in. Used by the recovery tests below for both automatic and interactive runs.
async function driveToBlockedRisk(f, context, ready) {
  const afterExplore = await settlePhase(f, context, ready, result(ready));
  assert.equal(afterExplore.stage, 'mdd-risk');
  return settlePhase(f, context, afterExplore, riskReport('low', 'failed'));
}

async function startAutomatic(t) {
  const f = await pluginFixture(t);
  const ready = JSON.parse(await f.hooks.tool.mdd_start.execute({ requirements: f.requirements }, f.context));
  assert.equal(ready.question, undefined, 'a fully known automatic profile starts without a question');
  return f;
}

async function startInteractive(t) {
  const f = await pluginFixture(t, { certainty: 'very-sure', artifactStore: 'none', summary: 'low', complexity: 'not-complex' });
  const pending = JSON.parse(await f.hooks.tool.mdd_start.execute({ requirements: f.requirements }, f.context));
  const qc = questionCall(f, pending.question);
  await f.hooks['tool.execute.before'](qc, { args: pending.question });
  await f.hooks['tool.execute.after']({ ...qc, args: pending.question }, questionOutput(pending.question, [['Interactivo'], ['Nada que agregar']]));
  return f;
}

// R1/A1, R4/A8: a settled blocked-risk (a valid failed verdict) offers exactly one native
// recovery question in both modes, and status explains the failed assessment without a verdict.
for (const [mode, start] of [['automatic', startAutomatic], ['interactive', startInteractive]]) {
  // R2/A3,A4: Ruta low / Ruta high start the chosen tail once, with manual origin, no verdict.
  for (const [label, route, firstPhase] of [['Ruta low', 'low', 'mdd-plan'], ['Ruta high', 'high', 'mdd-propose']]) {
  }

}

// A storage fault alone degrades a run to non-resumable rather than stopping it (PhaseRunner's
// documented fallback), so forcing the actual stop path this scenario needs means breaking every
// fallback the real runner tries in order: the checkpoint write, the checkpoint clear its degrade
// path falls back to, and the progress marker that degrade path would otherwise mark instead.
function faultCheckpoint(t) {
  const marks = [
    t.mock.method(CheckpointStore.prototype, 'write', function () { throw new CheckpointStorageError('Simulated runner checkpoint storage fault.'); }),
    t.mock.method(CheckpointStore.prototype, 'clear', function () { throw new Error('Simulated checkpoint clear fault.'); }),
    t.mock.method(ProgressGuard.prototype, 'write', function () { throw new Error('Simulated progress marker fault.'); }),
  ];
  return () => { for (const mark of marks) mark.mock.restore(); };
}

// An objective is the request the user made, not necessarily the last thing they said: a
// continuation message must not bury it. Consent is the opposite and still needs the latest text.
test('native intake SDK contract: an objective reaches past a continuation; consent does not', async () => {
  const f = sdkFixture(); addNativeUser(f, 'Objetivo real');
  const continuation = { info: { id: 'msg_continue', sessionID: runtime.sessionID, role: 'user' },
    parts: [{ type: 'text', text: 'te interrumpi, puedes continuar', sessionID: runtime.sessionID, messageID: 'msg_continue' }] };
  f.parentMessages.splice(1, 0, continuation);
  const inspector = createInspector(f.input);
  assert.equal(await inspector.intake(runtime, 'Objetivo real', 'msg_parent', 'objective'), 'msg_user');
  await assert.rejects(inspector.intake(runtime, 'Objetivo real', 'msg_parent'), /latest native user text/);
  await assert.rejects(inspector.intake(runtime, 'Un resumen reescrito', 'msg_parent', 'objective'), /actual native user message/);
  // Two messages carrying the same text are not a choice MDD may make on the user's behalf.
  f.parentMessages.splice(1, 0, { info: { id: 'msg_repeat', sessionID: runtime.sessionID, role: 'user' },
    parts: [{ type: 'text', text: 'Objetivo real', sessionID: runtime.sessionID, messageID: 'msg_repeat' }] });
  await assert.rejects(inspector.intake(runtime, 'Objetivo real', 'msg_parent', 'objective'), /Several native user messages/);
});

test('native intake SDK contract: exact multiple user text parts are accepted; wrong caller is not', async () => {
  const f = sdkFixture(); addNativeUser(f, 'First');
  f.parentMessages[0].parts.push({ ...f.parentMessages[0].parts[0], text: 'Second' });
  await createInspector(f.input).intake(runtime, 'First\nSecond', 'msg_parent');
  await assert.rejects(createInspector(f.input).intake(runtime, 'First\nSecond', 'wrong'));
});

// The exact-match comparison only folds line endings and trims outer edges; a near-miss is still
// refused, but the refusal now names the offset at which it actually diverges from what the user
// wrote, so the caller does not have to guess what changed.
test('native intake SDK contract: a near-miss requirement is refused with its first diverging offset', async () => {
  const f = sdkFixture(); addNativeUser(f, 'Please implement the caching layer.');
  await assert.rejects(createInspector(f.input).intake(runtime, 'Please implement the cache layer.', 'msg_parent'),
    /latest native user text[\s\S]*first differs at offset 25/);
});

// CRLF/CR are folded to LF and outer whitespace is trimmed on both sides, and nothing else is:
// the same text with different line endings and surrounding whitespace still matches exactly.
test('native intake SDK contract: line-ending and outer-whitespace differences still match exactly', async () => {
  const f = sdkFixture(); addNativeUser(f, '  Line one\r\nLine two  ');
  await createInspector(f.input).intake(runtime, 'Line one\nLine two', 'msg_parent');
});

// A full page used to be reported as "the objective is outside the readable history". The whole
// conversation is read now, so a full page is only a long conversation: a requirement that matches
// nothing the user wrote gets the ordinary mismatch refusal, never an unreadable-history one.
test('native intake SDK contract: a full history page is read whole, so a mismatch is reported as a mismatch', async () => {
  const f = sdkFixture(); addNativeUser(f, 'Please implement the caching layer.');
  const caller = f.parentMessages.at(-1);
  f.parentMessages.push(...Array.from({ length: 98 }, () => ({ info: { role: 'user' }, parts: [] })));
  f.parentMessages.splice(f.parentMessages.indexOf(caller), 1);
  f.parentMessages.push(caller);
  await assert.rejects(createInspector(f.input).intake(runtime, 'Something else entirely.', 'msg_parent'), error =>
    /must exactly match/.test(error.message) && !/outside the readable/.test(error.message));
  assert.equal(await createInspector(f.input).intake(runtime, 'Please implement the caching layer.', 'msg_parent', 'objective'), 'msg_user');
});

// A conversation longer than one page is ordinary once a route has actually run. Uniqueness is
// proof once the whole conversation is read, so a running call is consent wherever it sits, and
// a second call carrying the same identity is still refused rather than picked between.
test('native question SDK contract: a long conversation proves the uniquely readable running call', async () => {
  const f = sdkFixture();
  const args = { questions: [] };
  const call = questionCall(f, args);
  const current = f.parentMessages.at(-1);
  f.parentMessages.push(...Array.from({ length: 99 }, () => ({ info: { role: 'user' }, parts: [] })));
  await createInspector(f.input).question(runtime, call, args);
  f.parentMessages.splice(f.parentMessages.indexOf(current), 1);
  f.parentMessages.push(current);
  await createInspector(f.input).question(runtime, call, args);
  f.parentMessages[0] = { info: { ...current.info, id: 'msg_older' }, parts: [{ ...current.parts[0], messageID: 'msg_older' }] };
  await assert.rejects(createInspector(f.input).question(runtime, call, args), /not uniquely readable/);
});

for (const [name, mutate] of Object.entries({
  'wrong call': (f, args, call) => { call.callID = 'wrong'; },
  'wrong parent': f => { f.parent.parentID = 'other'; },
  'wrong tool': f => { f.parentMessages.at(-1).parts[0].tool = 'task'; },
  'changed history args': f => { f.parentMessages.at(-1).parts[0].state.input = {}; },
  'not running': f => { f.parentMessages.at(-1).parts[0].state.status = 'completed'; },
  'wrong part owner': f => { f.parentMessages.at(-1).parts[0].messageID = 'other'; },
  'duplicate part': f => { f.parentMessages.at(-1).parts.push(f.parentMessages.at(-1).parts[0]); },
})) {
  test(`native question SDK provenance rejects ${name}`, async () => {
    const f = sdkFixture();
    const args = { questions: [{ header: 'Approval', question: 'Exact question', multiple: false, options: [{ label: 'Proceed', description: 'Only this phase.' }] }] };
    const call = questionCall(f, args);
    mutate(f, args, call);
    await assert.rejects(createInspector(f.input).question(runtime, call, args));
  });
}

for (const [name, mutate] of Object.entries({
  'rewritten requirements': f => { f.parentMessages[0].parts[0].text = 'other'; },
  'synthetic user text': f => { f.parentMessages[0].parts[0].synthetic = true; },
  'ignored user text': f => { f.parentMessages[0].parts[0].ignored = true; },
  'missing native user': f => { f.parentMessages.shift(); },
  'wrong user session': f => { f.parentMessages[0].info.sessionID = 'other'; },
  'wrong text message': f => { f.parentMessages[0].parts[0].messageID = 'other'; },
})) {
  test(`native intake SDK provenance rejects ${name}`, async () => {
    const f = sdkFixture(); addNativeUser(f, 'Human requirements'); mutate(f);
    await assert.rejects(createInspector(f.input).intake(runtime, 'Human requirements', 'msg_parent'));
  });
}

// Actors are no longer policed tool by tool: their capability is the user's native decision.
// With guards on, MDD only refuses to let an unregistered session drive one of its own phases;
// with guards off (the default) an MDD actor name alone is not an MDD dispatch either.
for (const guards of [false, true]) test(`plugin contract (${guards ? 'strict' : 'free'}): ordinary tools pass through untouched; ${guards ? 'only stray MDD phases are refused' : 'so does a stray MDD actor name'}`, async t => {
  isolateHome(t);
  const settings = defaultSettings();
  settings.guards.enabled = guards;
  saveGlobalSettings(settings);
  const hooks = await plugin(sdkFixture().input);
  for (const tool of ['bash', 'edit', 'read', 'webfetch', 'list_mcp_resources', 'read_mcp_resource']) {
    await hooks['tool.execute.before']({ tool, sessionID: 'ses_child', callID: `${tool}-call` }, { args: {} });
  }
  await hooks['tool.execute.before']({ tool: 'task', sessionID: 'ses_child', callID: 'general' }, { args: { subagent_type: 'general' } });
  const stray = hooks['tool.execute.before']({ tool: 'task', sessionID: 'ses_child', callID: 'phase' }, { args: { subagent_type: 'mdd-apply' } });
  if (guards) await assert.rejects(stray, /registered parent run/);
  else await stray;
});

test('plugin config contract: settings frozen at startup; only explicit model overrides applied', async t => {
  isolateHome(t);
  const root = await mkdtemp(join(tmpdir(), 'mdd-plugin-models-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = defaultSettings();
  settings.profiles.default.models = { orchestrator: 'selected/main', 'mdd-plan': 'selected/planner' };
  // Strict mode pins the phase actors below; the free config hook has its own contract test.
  settings.guards.enabled = true;
  saveGlobalSettings(settings);
  const hooks = await plugin({ ...sdkFixture().input, directory: root, worktree: root });
  settings.profiles.default.models['mdd-plan'] = 'changed/planner';
  saveGlobalSettings(settings);
  const config = { default_agent: 'build', permission: { bash: 'ask' }, agent: { 'mdd-apply': { model: 'existing/apply' }, other: { model: 'user/choice', tools: { write: false } } } };
  await hooks.config(config);
  // Every agent but the coordinator loses the MDD tools: they are registered app-wide but are
  // meaningless, and misleading, anywhere else.
  const denied = { mdd_adapt: false, mdd_security: false, mdd_status: false, mdd_reset: false, mdd_contextual_explore: false, mdd_pr_body: false, mdd_improve: false, mdd_improvements: false, mdd_knowledge: false, mdd_knowledge_record: false, 'mdd_*': false, mdd_jd_inspect: false };
  // And every phase actor loses `task` and `skill`: it is the actor, and the skills it needs are
  // already inlined in its prompt by value, so a name lookup can only reach someone else's. It
  // gains the report checker and execution-bound reader, never workflow controls.
  const pinned = { task: false, skill: false, mdd_check_report: true, mdd_artifact_read: true };
  assert.deepEqual(config, {
    default_agent: 'build', permission: { bash: 'ask' },
    agent: {
      'mdd-apply': { model: 'existing/apply', tools: { ...denied, ...pinned } },
      other: { model: 'user/choice', tools: { write: false, ...denied } },
      'mdd-orchestrator': { model: 'selected/main' },
      general: { tools: { mdd_artifact_read: true } },
      explore: { tools: { mdd_artifact_read: true } },
      'mdd-plan': { model: 'selected/planner', tools: { ...denied, ...pinned } },
      'mdd-explore': { tools: { ...pinned } },
      'mdd-propose': { tools: { ...pinned } },
      'mdd-spec': { tools: { ...pinned } },
      'mdd-design': { tools: { ...pinned } },
      'mdd-tasks': { tools: { ...pinned } },
      'mdd-verify': { tools: { ...pinned } },
      // mdd-risk is not one of the eight phase actors, but it shares their restricted tool
      // profile, including the execution-bound reader.
      'mdd-risk': { tools: { ...pinned } },
      'mdd-security': { permission: { '*': 'deny', mdd_check_report: 'allow' }, tools: { '*': false, mdd_check_report: true } },
      'mdd-jd-judge-a': { permission: { '*': 'deny', mdd_jd_inspect: 'allow' }, tools: { '*': false, mdd_jd_inspect: true } },
      'mdd-jd-judge-b': { permission: { '*': 'deny', mdd_jd_inspect: 'allow' }, tools: { '*': false, mdd_jd_inspect: true } },
    },
  });
  // The coordinator dispatches phases, so it keeps both.
  assert.equal(config.agent['mdd-orchestrator'].tools, undefined);
});

test('plugin config contract: a stored reasoning effort is applied as a native variant, never as part of the model', async t => {
  isolateHome(t);
  const root = await mkdtemp(join(tmpdir(), 'mdd-plugin-variant-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = defaultSettings();
  settings.profiles.default.models = { orchestrator: 'anthropic/claude-opus-5#medium', 'mdd-plan': 'openai/gpt-5.6-sol' };
  saveGlobalSettings(settings);
  const hooks = await plugin({ ...sdkFixture().input, directory: root, worktree: root });
  const config = { agent: { 'mdd-plan': { variant: 'xhigh' } } };
  await hooks.config(config);
  assert.equal(config.agent['mdd-orchestrator'].model, 'anthropic/claude-opus-5');
  assert.equal(config.agent['mdd-orchestrator'].variant, 'medium');
  // An effort left over from the user's own selection must not survive an MDD model override.
  assert.equal(config.agent['mdd-plan'].model, 'openai/gpt-5.6-sol');
  assert.equal('variant' in config.agent['mdd-plan'], false);
});

test('global plugin profiles match in two private targets; conflicting legacy settings are ignored and preserved', async t => {
  isolateHome(t);
  const a = await mkdtemp(join(tmpdir(), 'mdd-global-a-'));
  const b = await mkdtemp(join(tmpdir(), 'mdd-global-b-'));
  t.after(async () => { await rm(a, { recursive: true, force: true }); await rm(b, { recursive: true, force: true }); });
  const legacy = defaultSettings(); legacy.profiles.default.models.orchestrator = 'legacy/project-a';
  saveSettings(a, legacy);
  const before = await readFile(join(a, 'mdd.config.json'));
  const global = defaultSettings(); global.profiles.default.models.orchestrator = 'global/shared';
  saveGlobalSettings(global);
  t.mock.method(globalThis, 'fetch', () => assert.fail('Memory-off startup must not contact a service'));
  for (const root of [a, b]) {
    const hooks = await plugin({ ...sdkFixture().input, directory: root, worktree: root });
    const config = { default_agent: 'build' }; await hooks.config(config);
    assert.equal(config.agent['mdd-orchestrator'].model, 'global/shared');
    assert.equal(config.default_agent, 'build');
  }
  assert.deepEqual(await readFile(join(a, 'mdd.config.json')), before);
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(a), ['mdd.config.json']);
  assert.deepEqual(await readdir(b), []);
});

// Guards are off by default: MDD keeps the bookkeeping of what it issued and refuses nothing else.
// The same conversations run strict when the settings switch the guards on.
async function modeFixture(t, guards, known = answers) {
  const f = await pluginFixture(t, known);
  if (guards) {
    f.settings.guards = { enabled: true };
    saveGlobalSettings(f.settings);
    f.hooks = await plugin(f.input);
  }
  return f;
}

for (const guards of [false, true]) {
  test(`${guards ? 'strict' : 'free'} mode: the config hook ${guards ? 'pins phase actors and appends the strict rules' : 'leaves phase actors their tools and the coordinator free'}`, async t => {
    const f = await modeFixture(t, guards);
    const config = { agent: { 'mdd-orchestrator': { prompt: 'The user decides.' }, 'mdd-apply': {} } };
    await f.hooks.config(config);
    assert.equal(config.agent['mdd-apply'].tools.task, guards ? false : undefined);
    assert.equal(config.agent['mdd-apply'].tools.skill, guards ? false : undefined);
    assert.equal(config.agent['mdd-orchestrator'].prompt.includes('STRICT MODE'), guards);
    assert.equal(f.hooks.tool.mdd_adapt.description.includes('the only route for every new implementation'), guards);
  });
}
