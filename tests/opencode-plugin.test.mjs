import assert from 'node:assert/strict';
import { test } from 'node:test';
import plugin, { createInspector, AGENTS_MAX, PERMISSION_MAX } from '../dist/opencode-plugin.js';
import { NativeIntake } from '../dist/native-intake.js';
import { memoryServer, request, result, runtime, call, answers, installCleanup, isolateHome } from './adapter-fixture.mjs';
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

for (const fault of ['forged', 'legacy-error', 'execution', 'child', 'workspace', 'project', 'incomplete', 'compacted', 'compacted-tool', 'duplicate', 'synthetic', 'ownership', 'ambiguous']) {
  test(`setup_recovery_rejects_forged_ambiguous_or_execution_started_history: ${fault}`, async t => {
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
    await assert.rejects(inspector.setupPending(f.runtime));
    const restarted = await plugin(f.input);
    const status = JSON.parse(await restarted.tool.mdd_status.execute({}, f.context));
    assert.equal(status.recovery, 'unavailable');
    assert.equal(status.pendingStart, undefined);
    await assert.rejects(restarted.tool.mdd_start.execute({ requirements: 'Continue' }, f.context));
  });
}

test('invalid setup names actual file without exposing values or claiming tools are available', async t => {
  const f = await setupFixture(t);
  await writeFile(installationPaths().settingsPath, '{"secret":"never-print"');
  await assert.rejects(plugin(f.input), error => error.message.includes(installationPaths().settingsPath) && error.message.includes('tools are unavailable') && !error.message.includes('never-print'));
  saveGlobalSettings(defaultSettings());
});

test('informational_request_does_not_start_implementation: shipped instruction contract only', async () => {
  const asset = await readFile(new URL('../assets/opencode/agents/mdd-orchestrator.md', import.meta.url), 'utf8');
  assert.match(asset, /Information-only requests[\s\S]*MUST NOT use mdd_start/);
  assert.match(asset, /Never stall the conversation/);
  assert.match(asset, /works with or without an\naccepted run/);
  assert.doesNotMatch(asset, /no standalone read-only investigation route/);
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

test('OpenCode SDK contract: nested v1 reads bind actual parent, child, assistant and wrapper', async () => {
  const f = sdkFixture();
  const inspector = createInspector(f.input);
  await inspector.parent(runtime, call.callID);
  assert.equal((await inspector.result(runtime, call, f.phase, f.output)).text, '{}');
  assert.equal(f.calls.length, 4);
  for (const options of f.calls) {
    assert.equal(options.query.directory, runtime.directory);
    assert.ok(options.path.id);
    assert.equal(options.throwOnError, true);
    assert.ok(options.signal instanceof AbortSignal);
  }
});

for (const [name, change] of Object.entries({
  'child parent': f => { f.child.parentID = 'other'; },
  'child workspace': f => { f.child.directory = 'other'; },
  'child project': f => { f.child.projectID = 'other'; },
  'child agent': f => { f.child.agent = 'mdd-apply'; },
  'child permission widened': f => { f.child.permission = [...f.child.permission, { permission: 'bash', pattern: '*', action: 'allow' }]; },
  'agent permission widened': f => { f.input.client.app.agents = async () => ({ data: [{ name: 'mdd-plan', mode: 'subagent', permission: [] }] }); },
  'metadata parent': f => { f.output.metadata.parentSessionId = 'other'; },
  'metadata model missing': f => { delete f.output.metadata.model; },
  'metadata model mismatch': f => { f.output.metadata.model = { providerID: 'other', modelID: 'other' }; },
  'assistant model missing': f => { delete f.childMessages[0].info.modelID; },
  'assistant model mismatch': f => { f.childMessages[0].info.modelID = 'other'; },
  'earlier assistant model mismatch': f => { f.childMessages.unshift({ info: { ...f.childMessages[0].info, modelID: 'other' }, parts: [] }); },
  background: f => { f.output.metadata.background = true; },
  'wrapper mismatch': f => { f.output.output = 'task completed'; },
  'empty history': f => { f.childMessages.length = 0; },
  'not assistant': f => { f.childMessages[0].info.role = 'user'; },
  'wrong assistant agent': f => { f.childMessages[0].info.agent = 'general'; },
  'wrong assistant workspace': f => { f.childMessages[0].info.path.root = 'other'; },
  'wrong assistant session': f => { f.childMessages[0].info.sessionID = 'other'; },
  'assistant failure': f => { f.childMessages[0].info.error = { name: 'UnknownError' }; },
  'incomplete assistant': f => { delete f.childMessages[0].info.time.completed; },
  'unknown finish': f => { f.childMessages[0].info.finish = 'unknown'; },
  'missing parts': f => { f.childMessages[0].parts = []; },
  'empty text': f => { f.childMessages[0].parts[0].text = ''; },
  'wrong text message': f => { f.childMessages[0].parts[0].messageID = 'other'; },
  'synthetic text': f => { f.childMessages[0].parts[0].synthetic = true; },
  'failed tool': f => { f.childMessages[0].parts.push({ type: 'tool', sessionID: 'ses_child', messageID: 'msg_child', state: { status: 'error' } }); },
  'unknown response': f => { f.input.client.session.get = async () => ({ data: null }); },
  'unknown part': f => { f.childMessages[0].parts.push({ type: 'mystery', sessionID: 'ses_child', messageID: 'msg_child' }); },
  'earlier failed tool': f => { f.childMessages.unshift({ info: { sessionID: 'ses_child', role: 'assistant', agent: 'mdd-plan' }, parts: [{ type: 'tool', tool: 'read', state: { status: 'error' } }] }); },
})) {
  test(`OpenCode SDK contract: reject ${name}`, async () => {
    const f = sdkFixture();
    const inspector = createInspector(f.input);
    await inspector.parent(runtime, call.callID);
    change(f);
    await assert.rejects(inspector.result(runtime, call, f.phase, f.output));
  });
}

for (const [name, change] of Object.entries({
  'wrong parent agent': f => { f.parent.agent = 'build'; },
  'nested parent': f => { f.parent.parentID = 'other'; },
  'wrong parent workspace': f => { f.parent.directory = 'other'; },
  'wrong native call': f => { f.parentMessages[0].parts[0].callID = 'other'; },
  'wrong invoking agent': f => { f.parentMessages[0].info.agent = 'build'; },
  'missing parent model': f => { delete f.parentMessages[0].info.providerID; },
})) {
  test(`OpenCode SDK contract: reject ${name}`, async () => {
    const f = sdkFixture(); change(f);
    await assert.rejects(createInspector(f.input).parent(runtime, call.callID));
  });
}

// Regression: a real installation resolved 127 agents and 140-239 permission rules each,
// which the former shared 100-entry history cap rejected before any MDD work could start.
function crowdedFixture(agentCount = 127, noiseRules = 140) {
  const f = sdkFixture();
  const noise = Array.from({ length: noiseRules }, (_, index) =>
    ({ permission: 'external_directory', pattern: `${runtime.directory}/skills/s${index}/*`, action: 'allow' }));
  const permission = [...noise, { permission: '*', pattern: '*', action: 'deny' },
    ...['read', 'glob', 'grep'].map(name => ({ permission: name, pattern: '*', action: 'allow' })),
    { permission: 'task', pattern: '*', action: 'deny' }];
  const mdd = MODEL_ROLES.map(role => ({ name: role === 'orchestrator' ? 'mdd-orchestrator' : role, mode: role === 'orchestrator' ? 'primary' : 'subagent', permission }));
  const others = Array.from({ length: Math.max(0, agentCount - mdd.length) }, (_, index) =>
    ({ name: `unrelated-agent-${index}`, mode: 'subagent', permission }));
  f.input.client.app.agents = async () => ({ data: [...mdd, ...others] });
  f.child.permission = permission;
  return f;
}

test('crowded real installations pass inspection: many agents and large resolved rulesets', async () => {
  const f = crowdedFixture();
  const agents = (await f.input.client.app.agents()).data;
  assert.equal(agents.length, 127);
  assert.ok(agents[0].permission.length > 100);
  const inspector = createInspector(f.input);
  await inspector.parent(runtime, call.callID);
  assert.equal((await inspector.result(runtime, call, f.phase, f.output)).text, '{}');
});

test('an absent child session permission overlay is no overlay, not an unknown structure', async () => {
  const f = crowdedFixture();
  delete f.child.permission;
  const inspector = createInspector(f.input);
  await inspector.parent(runtime, call.callID);
  assert.equal((await inspector.result(runtime, call, f.phase, f.output)).text, '{}');
});

for (const [name, build] of Object.entries({
  'agent registry': () => crowdedFixture(AGENTS_MAX + 1, 4),
  'permission rules': () => crowdedFixture(12, PERMISSION_MAX + 1),
})) {
  test(`oversized ${name} still fails closed and names its own subject`, async () => {
    const f = build();
    const inspector = createInspector(f.input);
    await assert.rejects(inspector.parent(runtime, call.callID), error =>
      /inspection limit/.test(error.message) && !/history/.test(error.message));
  });
}

test('OpenCode SDK contract: bounded callback even if injected client ignores abort', async () => {
  const f = sdkFixture();
  f.input.client.session.get = () => new Promise(() => {});
  await assert.rejects(createInspector(f.input, 20).parent(runtime), /timed out/);
});

test('OpenCode SDK contract: native tool-output read exception does not enable other directories', async () => {
  const f = sdkFixture();
  const rule = { permission: 'external_directory', pattern: `${runtime.directory}/tool-output/*`, action: 'allow' };
  f.child.permission.unshift(rule);
  f.child.permission.push(rule);
  const inspector = createInspector(f.input);
  await inspector.parent(runtime, call.callID);
  await inspector.result(runtime, call, f.phase, f.output);
  f.child.permission.push({ ...rule, pattern: '*' });
  await assert.rejects(inspector.result(runtime, call, f.phase, f.output), /read-only/);
});

test('OpenCode SDK contract: child session deny overlay combines with resolved agent permissions', async () => {
  const f = sdkFixture();
  f.child.permission = [{ permission: 'task', pattern: '*', action: 'deny' }];
  const inspector = createInspector(f.input);
  await inspector.parent(runtime, call.callID);
  assert.equal((await inspector.result(runtime, call, f.phase, f.output)).text, '{}');
});

test('plugin contract: scoped tools, in-place native args, result gating, no native override', async t => {
  const f = await pluginFixture(t);
  const { hooks, context, writes } = f;
  assert.deepEqual(Object.keys(hooks.tool).sort(), ['mdd_change_request', 'mdd_contextual_explore', 'mdd_pr_body', 'mdd_start', 'mdd_status']);
  assert.deepEqual(Object.keys(hooks.tool.mdd_start.args), ['requirements']);
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

test('native plugin contract: partial profile question receipt starts actual runner; exact approval prepares only next dispatch', async t => {
  const f = await pluginFixture(t, { certainty: 'very-sure', artifactStore: 'none', summary: 'low', complexity: 'not-complex' });
  const { hooks, context } = f;
  const pending = JSON.parse(await hooks.tool.mdd_start.execute({ requirements: f.requirements }, context));
  assert.equal(pending.question.questions.length, 1);
  assert.equal(pending.task, undefined);
  const qc = questionCall(f, pending.question);
  await hooks['tool.execute.before'](qc, { args: pending.question });
  await hooks['tool.execute.after']({ ...qc, args: pending.question }, questionOutput(pending.question, [['Interactive']]));
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
  assert.equal(approval.state, 'question-ready');
  assert.equal(approval.next.phase, 'mdd-apply');
  assert.equal(approval.task, undefined);
  const ac = questionCall(f, approval.question, 'approval_one');
  await hooks['tool.execute.before'](ac, { args: approval.question });
  await hooks['tool.execute.after']({ ...ac, args: approval.question }, questionOutput(approval.question, [['Proceed']]));
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

test('native intake SDK contract: exact multiple user text parts are accepted; wrong caller is not', async () => {
  const f = sdkFixture(); addNativeUser(f, 'First');
  f.parentMessages[0].parts.push({ ...f.parentMessages[0].parts[0], text: 'Second' });
  await createInspector(f.input).intake(runtime, 'First\nSecond', 'msg_parent');
  await assert.rejects(createInspector(f.input).intake(runtime, 'First\nSecond', 'wrong'));
});

test('native question SDK contract: incomplete history is never accepted as consent', async () => {
  const f = sdkFixture();
  const args = { questions: [] };
  const call = questionCall(f, args);
  f.parentMessages.push(...Array.from({ length: 99 }, () => ({ info: { role: 'user' }, parts: [] })));
  await assert.rejects(createInspector(f.input).question(runtime, call, args), /completeness/);
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

test('plugin contract: read-only child hook denies network resource tools even if they ask for read permission', async () => {
  const hooks = await plugin(sdkFixture().input);
  await hooks['chat.message']({ sessionID: 'ses_child' }, { message: { agent: 'mdd-plan' }, parts: [] });
  for (const tool of ['bash', 'edit', 'task', 'webfetch', 'list_mcp_resources', 'read_mcp_resource', 'mdd_start']) {
    await assert.rejects(hooks['tool.execute.before']({ tool, sessionID: 'ses_child', callID: 'child-call' }, { args: {} }), /read-only|matching active/);
  }
  await assert.rejects(hooks['tool.execute.before']({ tool: 'read', sessionID: 'ses_child', callID: 'read-call' }, { args: {} }), /matching active/);
  await hooks['tool.execute.before']({ tool: 'webfetch', sessionID: 'unrelated', callID: 'other' }, { args: {} });
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
  const config = { default_agent: 'build', permission: { bash: 'ask' }, agent: { 'mdd-apply': { model: 'existing/apply' } } };
  await hooks.config(config);
  assert.deepEqual(config, {
    default_agent: 'build', permission: { bash: 'ask' },
    agent: { 'mdd-apply': { model: 'existing/apply' }, 'mdd-orchestrator': { model: 'selected/main' }, 'mdd-plan': { model: 'selected/planner' } },
  });
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
