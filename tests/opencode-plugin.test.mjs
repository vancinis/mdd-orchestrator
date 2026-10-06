import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLegacyPlugin as plugin, createInspector, AGENTS_MAX, PERMISSION_MAX } from '../dist/opencode-plugin.js';
import { NativeIntake } from '../dist/native-intake.js';
import { memoryServer, request, result, runtime, call, answers, installCleanup, isolateHome, SUMMARY_TEXT, reportDocument } from './adapter-fixture.mjs';
import { MODEL_ROLES } from '../dist/settings.js';
import { defaultSettings, saveSettings } from '../dist/settings.js';
import { saveGlobalSettings } from '../dist/global-settings.js';
import { installationPaths } from '../dist/installation-paths.js';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// SDK responses are contract fakes shaped from OpenCode 1.18.31 release sources.
function sdkFixture(text = '{}', actualRuntime = runtime) {
  const runtime = actualRuntime;
  const phase = 'mdd-plan';
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

test('setup_continuation_preserves_native_origin_across_restart', async t => {
  const f = await setupFixture(t);
  const first = JSON.stringify(legacySetup(f));
  const part = f.parentMessages.at(-1).parts[0];
  part.state = { ...part.state, status: 'completed', output: first, time: { start: 1, end: 2 } };
  f.parentMessages.push({ info: { id: 'followup', role: 'user', sessionID: f.runtime.sessionID }, parts: [{ type: 'text', text: 'Intenta continuar, reinicie opencode', sessionID: f.runtime.sessionID, messageID: 'followup' }] });
  f.parentMessages.push({ info: { ...f.parentMessages[1].info, id: 'later', parentID: 'followup' }, parts: [] });
  const restarted = await plugin(f.input);
  const context = { ...f.context, messageID: 'later' };
  const status = JSON.parse(await restarted.tool.mdd_status.execute({}, context));
  assert.deepEqual(status.pendingStart, { requirements: f.requirements });
  await assert.rejects(createInspector(f.input).setupPending(f.runtime, f.requirements, 'forged-caller'), /caller/);
  await assert.rejects(restarted.tool.mdd_start.execute({ requirements: 'Intenta continuar, reinicie opencode' }, context), /pending|original/i);
  const recovered = JSON.parse(await restarted.tool.mdd_start.execute(status.pendingStart, context));
  assert.equal(recovered.state, 'question-ready');
  assert.equal(recovered.memory, 'off');
  await assert.rejects(createInspector(f.input).intake(f.runtime, f.requirements, 'later'), /latest/);
  const configured = defaultSettings();
  configured.profiles.default.answers = { ...answers };
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push([url, options.method]);
    throw new Error('Memory off must not fetch.');
  });
  const starts = [];
  const gate = new NativeIntake({ status: () => ({ state: 'not-started' }), async start(input) { starts.push(input); } }, createInspector(f.input), configured);
  await gate.start(status.pendingStart, context, context.messageID);
  assert.equal(starts[0].requirements, f.requirements);
  assert.deepEqual(requests, []);
});

// Recovery of a setup-only objective is a convenience, not a guard: what keeps a start honest is
// that its requirements must equal the actual latest native user text. So history that cannot
// prove a pending setup means there is none to offer, and only two things still interrupt: a
// conversation that is not this coordinator's, and two candidates that cannot be told apart.
for (const fault of ['forged', 'legacy-error', 'execution', 'child', 'workspace', 'project', 'incomplete', 'compacted', 'compacted-tool', 'duplicate', 'synthetic', 'ownership', 'ambiguous']) {
  test(`setup_recovery_never_invents_or_guesses_an_objective: ${fault}`, async t => {
    const f = await setupFixture(t);
    const output = legacySetup(f);
    const part = f.parentMessages[1].parts[0];
    part.state = { ...part.state, status: 'completed', output: JSON.stringify(output), time: { start: 1, end: 2 } };
    if (fault === 'forged') { output.setupOrigin.userMessageID = 'forged'; part.state.output = JSON.stringify(output); }
    if (fault === 'legacy-error') part.state = { status: 'error', error: 'Configure Engram and restart', input: { requirements: f.requirements } };
    if (fault === 'execution') f.parentMessages[1].parts.push({ ...part, callID: 'execution', tool: 'task' });
    if (fault === 'child') f.parent.parentID = 'another-parent';
    if (fault === 'workspace') f.parentMessages[1].info.path.cwd = 'another-workspace';
    if (fault === 'project') { f.input.project.id = 'another-project'; f.parent.projectID = 'another-project'; }
    if (fault === 'incomplete') while (f.parentMessages.length < 100) f.parentMessages.push(structuredClone(f.parentMessages[0]));
    if (fault === 'compacted') f.parentMessages[0].parts.push({ type: 'compaction' });
    if (fault === 'compacted-tool') part.state.time.compacted = 3;
    if (fault === 'duplicate') f.parentMessages[1].parts.push(structuredClone(part));
    if (fault === 'synthetic') f.parentMessages[0].parts[0].synthetic = true;
    if (fault === 'ownership') part.messageID = 'forged';
    if (fault === 'ambiguous') {
      const user = structuredClone(f.parentMessages[0]); user.info.id = 'second-user'; user.parts[0].messageID = 'second-user'; user.parts[0].text = 'A different objective';
      const assistant = structuredClone(f.parentMessages[1]); assistant.info.id = 'second-assistant'; assistant.info.parentID = 'second-user';
      const second = assistant.parts[0]; second.callID = 'second-start'; second.messageID = 'second-assistant'; second.state.input.requirements = user.parts[0].text;
      output.setupOrigin.userMessageID = 'second-user'; output.pendingStart.requirements = user.parts[0].text; second.state.output = JSON.stringify(output);
      f.parentMessages.push(user, assistant);
    }
    const inspector = createInspector(f.input);
    // A conversation that is not this coordinator's, and an ambiguous pair of real candidates,
    // are the only faults worth stopping for. Everything else simply proves no pending setup.
    const interrupts = ['child', 'ambiguous'].includes(fault);
    if (interrupts) await assert.rejects(inspector.setupPending(f.runtime));
    else assert.equal(await inspector.setupPending(f.runtime), undefined);
    const restarted = await plugin(f.input);
    const status = JSON.parse(await restarted.tool.mdd_status.execute({}, f.context));
    assert.equal(status.recovery, interrupts ? 'unavailable' : undefined);
    assert.equal(status.pendingStart, undefined);
    // Continuation text is never an objective, whatever the history around it looks like.
    await assert.rejects(restarted.tool.mdd_start.execute({ requirements: 'Continue' }, f.context));
  });
}

// One successful start used to poison its own conversation: every later mdd_start failed on an
// unreadable structure error, so mdd_reset with scope run promised a restart it could not deliver
// and the only way to keep working was abandoning the conversation with its evidence in it.
test('a conversation that already ran can start a second objective after a reset', async t => {
  const f = await setupFixture(t);
  const first = JSON.parse(await f.hooks.tool.mdd_start.execute({ requirements: f.requirements }, f.context));
  assert.equal(first.state, 'question-ready');
  const caller = f.parentMessages.at(-1);
  caller.parts[0].state = { ...caller.parts[0].state, status: 'completed', output: JSON.stringify(first), time: { start: 1, end: 2 } };
  caller.parts.push({ type: 'tool', tool: 'task', callID: 'phase-call', sessionID: f.runtime.sessionID, messageID: caller.info.id,
    state: { status: 'completed', output: 'phase output', time: { start: 3, end: 4 } } });
  assert.equal(await createInspector(f.input).setupPending(f.runtime), undefined);
  assert.deepEqual(JSON.parse(await f.hooks.tool.mdd_reset.execute({ scope: 'run' }, f.context)).reset, { scope: 'run' });
  const second = 'Ahora el aviso tiene que quedar siempre centrado';
  f.parentMessages.splice(-1, 0, { info: { id: 'msg_user_2', sessionID: f.runtime.sessionID, role: 'user' },
    parts: [{ type: 'text', text: second, sessionID: f.runtime.sessionID, messageID: 'msg_user_2' }] });
  const restarted = JSON.parse(await f.hooks.tool.mdd_start.execute({ requirements: second }, f.context));
  assert.equal(restarted.state, 'question-ready');
});

// A pending question is a healthy run: probing native history there once told the user that a
// perfectly recoverable objective could not be recovered, which is the opposite of the truth.
test('a live intake is never reported as unrecoverable', async t => {
  const f = await setupFixture(t);
  const started = JSON.parse(await f.hooks.tool.mdd_start.execute({ requirements: f.requirements }, f.context));
  assert.equal(started.state, 'question-ready');
  const message = f.parentMessages.at(-1);
  const part = message.parts[0];
  part.state = { ...part.state, status: 'completed', output: JSON.stringify(started), time: { start: 1, end: 2 } };
  message.parts.push({ type: 'tool', tool: 'question', callID: 'question-1', sessionID: f.runtime.sessionID, messageID: message.info.id, state: { status: 'running', input: started.question } });
  assert.equal(await createInspector(f.input).setupPending(f.runtime), undefined);
  const status = JSON.parse(await f.hooks.tool.mdd_status.execute({}, f.context));
  assert.equal(status.state, 'question-ready');
  assert.ok(status.question);
  assert.equal(Object.hasOwn(status, 'recovery'), false);
  assert.equal(status.pendingStart, undefined);
});

test('invalid setup names actual file without exposing values or claiming tools are available', async t => {
  const f = await setupFixture(t);
  await writeFile(installationPaths().settingsPath, '{"secret":"never-print"');
  await assert.rejects(plugin(f.input), error => error.message.includes(installationPaths().settingsPath) && error.message.includes('tools are unavailable') && !error.message.includes('never-print'));
  saveGlobalSettings(defaultSettings());
});

test('informational_request_does_not_start_implementation: shipped instruction contract only', async () => {
  const asset = await readFile(new URL('../assets/opencode/agents/mdd-orchestrator.md', import.meta.url), 'utf8');
  assert.match(asset, /Information-only requests[\s\S]*MUST NOT use mdd_start/);
  assert.match(asset, /Follow the available safe step; surface a blocked state/);
  assert.match(asset, /works with or without an\naccepted run/);
  assert.doesNotMatch(asset, /no standalone read-only investigation route/);
  assert.match(asset, /Never end a phase report with an approval question of your own/);
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
  assert.deepEqual(Object.keys(hooks.tool).sort(), ['mdd_change_request', 'mdd_check_report', 'mdd_context', 'mdd_contextual_explore', 'mdd_improve', 'mdd_improvements', 'mdd_phase_result', 'mdd_pr_body', 'mdd_prepare_advance', 'mdd_reset', 'mdd_revisit', 'mdd_security', 'mdd_start', 'mdd_status', 'mdd_transfer', 'mdd_transfer_recover']);
  assert.deepEqual(Object.keys(hooks.tool.mdd_start.args), ['requirements', 'context']);
  const ready = JSON.parse(await hooks.tool.mdd_start.execute({ requirements: f.requirements }, context));
  const nativeArgs = ready.task;
  const output = { args: nativeArgs };
  await hooks['tool.execute.before']({ ...call, tool: 'task' }, output);
  assert.equal(output.args, nativeArgs);
  assert.match(nativeArgs.prompt, /Native callID=/);
  const text = result(ready);
  f.childMessages[0].parts[0].text = text;
  f.output.output = `<task id="ses_child" state="completed">\n<task_result>\n${text}\n</task_result>\n</task>`;
  await hooks['tool.execute.after']({ ...call, tool: 'task', args: nativeArgs }, f.output);
  const status = JSON.parse(await hooks.tool.mdd_status.execute({}, context));
  assert.equal(status.state, 'ready');
  assert.equal(status.workflow.results.length, 1);
  assert.equal(writes.length, 2);
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

  const broken = JSON.parse(await hooks.tool.mdd_check_report.execute(
    { phase: 'mdd-explore', result: report.replace(SUMMARY_TEXT, 'x'.repeat(2100)) }, actor));
  assert.equal(broken.ok, false);
  assert.ok(broken.problems.some(problem => /summary must be nonempty text/.test(problem)));

  // Checking spends nothing and starts nothing: the run is exactly where it was.
  assert.equal(JSON.parse(await hooks.tool.mdd_status.execute({}, context)).state, 'not-started');

  // The coordinator may check too, because a phase it takes over inline is still a phase.
  await hooks.tool.mdd_check_report.execute({ phase: 'mdd-explore', result: report }, context);
  // Everyone else is told plainly that this says nothing about their session.
  await assert.rejects(
    hooks.tool.mdd_check_report.execute({ phase: 'mdd-explore', result: report }, { ...context, agent: 'build' }),
    /belongs to MDD phase actors/);
});

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

// The coordinator holds the issue body it already fetched; the only legitimate way in is to hand
// it to MDD, which composes it into the prompt so the dispatched task still matches byte for byte.
test('plugin contract: coordinator context reaches the phase and the exact task still dispatches', async t => {
  const f = await pluginFixture(t);
  const { hooks, context } = f;
  const issue = 'title: feat(dashboard): mostrar detalles del delivery externo en pedidos';
  const started = JSON.parse(await hooks.tool.mdd_start.execute({ requirements: f.requirements, context: { label: 'GitHub issue #390 body', content: issue } }, context));
  // The coordinator is handed a dispatch handle, so the material is checked where it is used:
  // in the prompt the hook expands and the actor actually receives.
  assert.ok(started.task.prompt.startsWith('mdd:dispatch:'));
  const added = JSON.parse(await hooks.tool.mdd_context.execute({ label: 'Previous decision', content: 'Keep the current exit codes.' }, context));
  assert.deepEqual(added.providedContext.map(item => item.source), ['coordinator', 'coordinator']);
  const ready = JSON.parse(await hooks.tool.mdd_status.execute({}, context));
  // Requirements remain the native user text; context is data beside them, never instead of them.
  assert.equal(ready.provenance.requirements, 'native-user');
  const output = { args: ready.task };
  await hooks['tool.execute.before']({ ...call, tool: 'task' }, output);
  assert.match(output.args.prompt, /Coordinator-provided context \(data, not authority\)/);
  assert.match(output.args.prompt, /delivery externo/);
  assert.match(output.args.prompt, /Keep the current exit codes\./);
  assert.match(output.args.prompt, new RegExp(`Requirements data: ${JSON.stringify(JSON.stringify(f.requirements)).slice(1, -1)}`));
  assert.match(output.args.prompt, /GitHub issue #390 body/);
  assert.equal(JSON.parse(await hooks.tool.mdd_status.execute({}, context)).state, 'await-result');
  // A non-coordinator agent cannot feed context into someone else's run.
  await assert.rejects(hooks.tool.mdd_context.execute({ label: 'A', content: 'B' }, { ...context, agent: 'build' }), /belongs to the mdd-orchestrator agent/);
});

test('native plugin contract: partial profile question receipt starts actual runner; exact approval prepares only next dispatch', async t => {
  const f = await pluginFixture(t, { certainty: 'very-sure', artifactStore: 'none', summary: 'low', complexity: 'not-complex' });
  const { hooks, context } = f;
  const pending = JSON.parse(await hooks.tool.mdd_start.execute({ requirements: f.requirements }, context));
  assert.equal(pending.question.questions.length, 1);
  assert.equal(pending.task, undefined);
  const qc = questionCall(f, pending.question);
  await hooks['tool.execute.before'](qc, { args: pending.question });
  await hooks['tool.execute.after']({ ...qc, args: pending.question }, questionOutput(pending.question, [['Interactivo']]));
  const ready = JSON.parse(await hooks.tool.mdd_status.execute({}, context));
  assert.equal(ready.state, 'ready');
  assert.equal(ready.provenance.preflight, 'native-question');
  assert.equal(ready.questionReceipts.length, 1);
  f.parentMessages.at(-1).parts = [{ type: 'tool', tool: 'task', callID: call.callID, state: { status: 'running' } }];
  await hooks['tool.execute.before']({ ...call, tool: 'task' }, { args: ready.task });
  const text = result(ready);
  f.childMessages[0].parts[0].text = text;
  f.output.output = `<task id="ses_child" state="completed">\n<task_result>\n${text}\n</task_result>\n</task>`;
  await hooks['tool.execute.after']({ ...call, tool: 'task', args: ready.task }, f.output);
  const approval = JSON.parse(await hooks.tool.mdd_status.execute({}, context));
  assert.equal(approval.state, 'review-ready');
  assert.equal(approval.question, undefined);
  const pendingApproval = JSON.parse(await hooks.tool.mdd_prepare_advance.execute({ questions: [] }, context));
  assert.equal(approval.workflow.nextAction.phase, 'mdd-apply');
  assert.equal(approval.task, undefined);
  const ac = questionCall(f, pendingApproval.question, 'approval_one');
  await hooks['tool.execute.before'](ac, { args: pendingApproval.question });
  await hooks['tool.execute.after']({ ...ac, args: pendingApproval.question }, questionOutput(pendingApproval.question, [['Continuar']]));
  const approved = JSON.parse(await hooks.tool.mdd_status.execute({}, context));
  assert.deepEqual(approved.workflow.nextAction, { kind: 'execute', phase: 'mdd-apply' });
  assert.equal(approved.task.subagent_type, 'mdd-apply');
  assert.equal(approved.next.kind, 'execute');
  assert.equal(approved.questionReceipts.length, 2);
});

test('native plugin contract: question error event blocks only matching intake without memory writes', async t => {
  const f = await pluginFixture(t, {});
  const pending = JSON.parse(await f.hooks.tool.mdd_start.execute({ requirements: f.requirements }, f.context));
  const call = questionCall(f, pending.question);
  await f.hooks['tool.execute.before'](call, { args: pending.question });
  const event = { type: 'message.part.updated', properties: { part: { ...call, type: 'tool', state: { status: 'error' } } } };
  await f.hooks.event({ event: { ...event, properties: { part: { ...event.properties.part, callID: 'unrelated' } } } });
  assert.equal(JSON.parse(await f.hooks.tool.mdd_status.execute({}, f.context)).state, 'await-answer');
  await f.hooks.event({ event });
  const status = JSON.parse(await f.hooks.tool.mdd_status.execute({}, f.context));
  assert.equal(status.state, 'stopped');
  assert.equal(status.provenance, undefined);
  assert.equal(status.task, undefined);
  assert.equal(f.writes.length, 0);
});

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

// A full page of history proves nothing about what came before it, so a caller reading the error
// learns that the objective cannot be read here at all, not that it failed to match.
test('native intake SDK contract: a full history page reports the objective as unreadable, not unmatched', async () => {
  const f = sdkFixture(); addNativeUser(f, 'Please implement the caching layer.');
  const caller = f.parentMessages.at(-1);
  // The read itself is capped at exactly HISTORY_MAX (100) entries; one more than that fails
  // earlier, as "exceeds the inspection limit", which is a different and unrelated refusal.
  f.parentMessages.push(...Array.from({ length: 98 }, () => ({ info: { role: 'user' }, parts: [] })));
  f.parentMessages.splice(f.parentMessages.indexOf(caller), 1);
  f.parentMessages.push(caller);
  await assert.rejects(createInspector(f.input).intake(runtime, 'Something else entirely.', 'msg_parent'), /outside the readable native history/);
});

// A conversation longer than one page is ordinary once a route has actually run, so refusing to
// read it at all stopped approvals exactly where they were needed most. What an incomplete history
// cannot do is prove that some older call is the one being answered: only the running call of the
// current message qualifies, which is a tighter correlation than the full scan it replaces.
test('native question SDK contract: an incomplete history proves only the current running call', async () => {
  const f = sdkFixture();
  const args = { questions: [] };
  const call = questionCall(f, args);
  const current = f.parentMessages.at(-1);
  f.parentMessages.push(...Array.from({ length: 99 }, () => ({ info: { role: 'user' }, parts: [] })));
  await assert.rejects(createInspector(f.input).question(runtime, call, args), /incomplete history/);
  // The same full page, with the call belonging to the message that is running it, is consent.
  f.parentMessages.splice(f.parentMessages.indexOf(current), 1);
  f.parentMessages.push(current);
  await createInspector(f.input).question(runtime, call, args);
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
// MDD only refuses to let an unregistered session drive one of its own phases.
test('plugin contract: ordinary tools pass through untouched; only stray MDD phases are refused', async () => {
  const hooks = await plugin(sdkFixture().input);
  for (const tool of ['bash', 'edit', 'read', 'webfetch', 'list_mcp_resources', 'read_mcp_resource']) {
    await hooks['tool.execute.before']({ tool, sessionID: 'ses_child', callID: `${tool}-call` }, { args: {} });
  }
  await hooks['tool.execute.before']({ tool: 'task', sessionID: 'ses_child', callID: 'general' }, { args: { subagent_type: 'general' } });
  await assert.rejects(hooks['tool.execute.before']({ tool: 'task', sessionID: 'ses_child', callID: 'phase' },
    { args: { subagent_type: 'mdd-apply' } }), /registered parent run/);
});

test('plugin config contract: settings frozen at startup; only explicit model overrides applied', async t => {
  isolateHome(t);
  const root = await mkdtemp(join(tmpdir(), 'mdd-plugin-models-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = defaultSettings();
  settings.profiles.default.models = { orchestrator: 'selected/main', 'mdd-plan': 'selected/planner' };
  saveGlobalSettings(settings);
  const hooks = await plugin({ ...sdkFixture().input, directory: root, worktree: root });
  settings.profiles.default.models['mdd-plan'] = 'changed/planner';
  saveGlobalSettings(settings);
  const config = { default_agent: 'build', permission: { bash: 'ask' }, agent: { 'mdd-apply': { model: 'existing/apply' }, other: { model: 'user/choice', tools: { write: false } } } };
  await hooks.config(config);
  // Every agent but the coordinator loses the MDD tools: they are registered app-wide but are
  // meaningless, and misleading, anywhere else.
  const denied = { mdd_security: false, mdd_start: false, mdd_status: false, mdd_prepare_advance: false, mdd_revisit: false, mdd_phase_result: false, mdd_reset: false, mdd_change_request: false, mdd_contextual_explore: false, mdd_context: false, mdd_pr_body: false, mdd_improve: false, mdd_improvements: false, mdd_transfer: false, mdd_transfer_recover: false, 'mdd_*': false };
  // And every phase actor loses `task` and `skill`: it is the actor, and the skills it needs are
  // already inlined in its prompt by value, so a name lookup can only reach someone else's. It
  // gains exactly one MDD tool back, which reads nothing and only tells it whether the report it
  // is about to return can be read — the question its own session is the last place to answer.
  const pinned = { task: false, skill: false, mdd_check_report: true };
  assert.deepEqual(config, {
    default_agent: 'build', permission: { bash: 'ask' },
    agent: {
      'mdd-apply': { model: 'existing/apply', tools: { ...denied, ...pinned } },
      other: { model: 'user/choice', tools: { write: false, ...denied } },
      'mdd-orchestrator': { model: 'selected/main' },
      'mdd-plan': { model: 'selected/planner', tools: { ...denied, ...pinned } },
      'mdd-explore': { tools: { ...pinned } },
      'mdd-propose': { tools: { ...pinned } },
      'mdd-spec': { tools: { ...pinned } },
      'mdd-design': { tools: { ...pinned } },
      'mdd-tasks': { tools: { ...pinned } },
      'mdd-verify': { tools: { ...pinned } },
      // mdd-risk is not one of the eight phase actors, but it shares their restricted tool
      // profile: it may call only mdd_check_report, the same as every phase actor above.
      'mdd-risk': { tools: { ...pinned } },
      'mdd-security': { permission: { '*': 'deny', mdd_check_report: 'allow' }, tools: { '*': false, mdd_check_report: true } },
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
