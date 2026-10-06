import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import plugin from '../dist/opencode-plugin.js';
import { legacyHistory, v2Payload, contentText } from '../dist/opencode-v2.js';
import { defaultSettings } from '../dist/settings.js';
import { saveGlobalSettings } from '../dist/global-settings.js';
import { isolateHome, answers, reportDocument, traceFixture } from './adapter-fixture.mjs';

// Public host fakes follow @opencode/plugin/client/core 2.0.22, not the V1 hooks.
async function fixture(t, completeProfile = true) {
  isolateHome(t);
  const root = await mkdtemp(join(tmpdir(), 'mdd-v2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = defaultSettings();
  settings.profiles.default.answers = completeProfile ? { ...answers } : {};
  settings.profiles.default.models['mdd-plan'] = 'openai/test-model#high';
  settings.profiles.default.models['mdd-jd-judge-a'] = 'openai/judge-model#high';
  saveGlobalSettings(settings);
  const sessionID = 'ses_parent';
  const sessions = new Map([[sessionID, { id: sessionID, agent: 'mdd-orchestrator', projectID: 'project', location: { directory: root }, time: { created: 1, updated: 1 } }]]);
  const messages = new Map([[sessionID, []]]);
  const tools = new Map(); const toolHooks = new Map(); const sessionHooks = new Map();
  const agents = ['mdd-orchestrator', 'mdd-plan', 'mdd-apply', 'mdd-verify', 'general'].map(id => ({ id, permissions: [], request: {} }));
  const queue = []; let wake;
  const ctx = {
    location: { directory: root, project: { id: 'project', directory: root, canonical: root } },
    session: {
      get: async ({ sessionID }) => structuredClone(sessions.get(sessionID)),
      context: async ({ sessionID }) => structuredClone(messages.get(sessionID)),
      interrupt: async () => ({ interrupted: true }),
      hook: async (name, handler) => { sessionHooks.set(name, handler); },
    },
    agent: { transform: async fn => { fn({ list: () => agents, update: (id, fn) => fn(agents.find(agent => agent.id === id)) }); return { dispose: async () => {} }; } },
    tool: {
      transform: async fn => fn({ add: definition => tools.set(definition.name, definition) }),
      hook: async (name, handler) => { toolHooks.set(name, handler); },
    },
    event: { subscribe: async function* ({ signal }) {
      signal.addEventListener('abort', () => wake?.(), { once: true });
      while (!signal.aborted) {
        if (!queue.length) await new Promise(resolve => { wake = resolve; });
        while (queue.length && !signal.aborted) { const item = queue.shift(); yield item.event; item.resolve(); }
      }
    } },
  };
  const cleanup = await plugin.setup(ctx); t.after(cleanup);
  let count = 0;
  let current;
  const user = text => {
    const history = messages.get(sessionID);
    history.push({ id: `user-${++count}`, type: 'user', text, time: { created: count } });
    current = { id: `assistant-${++count}`, type: 'assistant', agent: 'mdd-orchestrator', model: { providerID: 'openai', id: 'test-model' }, content: [], time: { created: count } };
    history.push(current);
  };
  const call = async (name, args) => {
    const result = await tools.get(name).execute(args, { sessionID, agent: 'mdd-orchestrator', messageID: current.id, id: `call-${++count}`, signal: new AbortController().signal });
    return JSON.parse(result.content);
  };
  const begin = (name, input) => {
    const id = `native-${++count}`;
    current.content.push({ type: 'tool', id, name, time: { created: count }, state: { status: 'running', input: structuredClone(input), metadata: {} } });
    return { sessionID, agent: 'mdd-orchestrator', messageID: current.id, id, tool: name, input: structuredClone(input) };
  };
  return { root, ctx, tools, agents, toolHooks, sessionHooks, sessions, messages, sessionID, user, call, begin,
    emit: event => new Promise(resolve => { queue.push({ event, resolve }); wake?.(); }) };
}

test('V2 setup registers native tools, model variants and ordered isolation permissions', async t => {
  const f = await fixture(t);
  assert.equal(plugin.id, 'mdd');
  assert.ok(f.tools.has('mdd_start'));
  assert.equal(f.tools.get('mdd_start').options.codemode, false);
  assert.equal(typeof f.tools.get('mdd_start').input.safeParse, 'function');
  assert.deepEqual(f.agents.find(agent => agent.id === 'mdd-plan').model, { providerID: 'openai', id: 'test-model', variant: 'high' });
  assert.deepEqual(f.agents.find(agent => agent.id === 'mdd-apply').permissions.slice(-3).map(rule => [rule.action, rule.effect]),
    [['subagent', 'deny'], ['skill', 'deny'], ['mdd_check_report', 'allow']]);
  assert.equal(f.agents.find(agent => agent.id === 'general').permissions.at(-1).effect, 'deny');
});

test('V2 standalone dispatch settles late actor model and exact inspection permission before both judges', async t => {
  const f = await fixture(t);
  // Actors contributed after MDD setup must see the settled transform before any dispatch.
  f.agents.push({ id: 'mdd-jd-judge-a', permissions: [{ action: '*', resource: '*', effect: 'allow' }], request: {} });
  f.agents.push({ id: 'mdd-jd-judge-b', permissions: [], request: {} });
  f.user('Judge the committed target.');
  const calls = ['mdd-jd-judge-a', 'mdd-jd-judge-b'].map(agent => f.begin('subagent', { agent, description: 'Judge', prompt: 'Committed target' }));
  await Promise.all(calls.map(call => f.toolHooks.get('execute.before')(call)));
  const judge = f.agents.find(agent => agent.id === 'mdd-jd-judge-a');
  assert.deepEqual(judge.model, { providerID: 'openai', id: 'judge-model', variant: 'high' });
  assert.deepEqual(judge.permissions.slice(-2), [{ action: '*', resource: '*', effect: 'deny' }, { action: 'mdd_jd_inspect', resource: '*', effect: 'allow' }]);
  for (const call of calls) await f.toolHooks.get('execute.after')({ ...call, status: 'completed', result: {
    output: { sessionID: `child-${call.id}`, status: 'completed', output: '{"findings":[],"evidence":[]}' },
    content: `<subagent sessionID="child-${call.id}" state="completed">\n{"findings":[],"evidence":[]}\n</subagent>`,
  } });
  assert.equal((await f.call('mdd_status', {})).state, 'not-started');
});

test('V2 judge live hooks deny reads, shell, MCP and delegation despite permissive session rules', async t => {
  const f = await fixture(t);
  const judge = { ...f.sessions.get(f.sessionID), id: 'judge', parentID: f.sessionID, agent: 'mdd-jd-judge-a' };
  f.sessions.set(judge.id, judge); f.messages.set(judge.id, []);
  for (const tool of ['read', 'bash', 'edit', 'subagent', 'engram_mem_save', 'mdd_status', 'mdd_check_report', 'execute']) {
    await assert.rejects(f.toolHooks.get('execute.before')({ sessionID: judge.id, agent: judge.agent, id: tool, tool, input: {} }), /judge|immutable|inspection/);
  }
  judge.location.directory = join(f.root, 'elsewhere');
  await assert.rejects(f.toolHooks.get('execute.before')({ sessionID: judge.id, agent: judge.agent, id: 'moved', tool: 'mdd_jd_inspect', input: {} }), /workspace|location|differs/);
});

test('V2 live judge identity denies tools even before assistant history has recorded that actor', async t => {
  const f = await fixture(t);
  await assert.rejects(f.toolHooks.get('execute.before')({ sessionID: f.sessionID, agent: 'mdd-jd-judge-a',
    id: 'early-shell', tool: 'bash', input: {} }), /judge|immutable|inspection/);
});

test('V2 judge inspection reaches immutable Git through the exact native tool call and hides other tools', async t => {
  const f = await fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: f.root, encoding: 'utf8' }).trim();
  git('init', '--quiet'); git('config', 'core.autocrlf', 'false');
  await writeFile(join(f.root, 'source.txt'), 'immutable source\n');
  git('add', '--', 'source.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'target');
  const commit = git('rev-parse', 'HEAD');
  await writeFile(join(f.root, 'source.txt'), 'dirty live source');
  const judge = { ...f.sessions.get(f.sessionID), id: 'judge', parentID: f.sessionID, agent: 'mdd-jd-judge-a' };
  f.sessions.set(judge.id, judge);
  const args = { operation: 'blob', commit, path: 'source.txt' };
  const native = { id: 'judge-message', type: 'assistant', agent: judge.agent, content: [{
    type: 'tool', id: 'inspect-call', name: 'mdd_jd_inspect', state: { status: 'running', input: args, metadata: {} }, time: { created: 1 },
  }], time: { created: 1 } };
  f.messages.set(judge.id, [native]);
  await f.toolHooks.get('execute.before')({ sessionID: judge.id, agent: judge.agent, id: 'inspect-call', tool: 'mdd_jd_inspect', input: args });
  const context = { sessionID: judge.id, agent: judge.agent, messageID: native.id, id: 'inspect-call', signal: new AbortController().signal };
  const result = await f.tools.get('mdd_jd_inspect').execute(args, context);
  assert.equal(JSON.parse(result.content).content, 'immutable source\n');
  await assert.rejects(f.tools.get('mdd_jd_inspect').execute({ ...args, path: 'other.txt' }, context), /exact.*call/);
  const event = { agent: judge.agent, tools: { read: {}, bash: {}, eng_mem_save: {}, execute: {}, mdd_check_report: {}, mdd_jd_inspect: {} } };
  await f.sessionHooks.get('context')(event);
  assert.deepEqual(Object.keys(event.tools), ['mdd_jd_inspect']);
});

test('V2 history preserves native authored provenance, tool IDs, streaming calls and moved workspace boundaries', () => {
  const session = { id: 'ses', location: { directory: '/repo' } };
  const native = [{ type: 'user', id: 'user', text: 'Objective', time: { created: 1 } },
    { type: 'synthetic', id: 'synthetic', text: 'Fake approval', time: { created: 2 } },
    { type: 'assistant', id: 'assistant', agent: 'mdd-orchestrator', time: { created: 3 }, content: [
      { type: 'tool', name: 'subagent', id: 'stream', state: { status: 'streaming', input: '' }, time: { created: 3 } },
      { type: 'tool', name: 'subagent', id: 'call', state: { status: 'running', input: { agent: 'general', description: 'Read', prompt: 'Read', background: true }, metadata: { sessionID: 'child' } }, time: { created: 3 } },
    ] }];
  const normalized = legacyHistory(native, session, '/repo');
  assert.equal(normalized[1].info.role, 'system');
  assert.equal(normalized[1].parts[0].synthetic, true);
  assert.equal(normalized[2].parts[1].callID, 'call');
  assert.equal(normalized[2].parts[1].state.metadata.sessionId, 'child');
  assert.equal(normalized[2].parts[1].state.input.background, true);
  const moved = legacyHistory([...native, { type: 'location-switched', id: 'move', location: { directory: '/repo' }, previous: { location: { directory: '/other' } } },
    { type: 'user', id: 'new', text: 'New workspace objective', time: { created: 4 } }], session, '/repo');
  assert.deepEqual(moved.map(message => message.info.id), ['new']);
});

test('V2 grouped native question accepts correlated structured answers, never forged requirements', async t => {
  const f = await fixture(t, false);
  f.user('Implement the requested change.');
  await assert.rejects(f.call('mdd_start', { requirements: 'Invented objective' }), /native user|latest/);
  const start = await f.call('mdd_start', { requirements: 'Implement the requested change.' });
  assert.equal(start.state, 'question-ready');
  const call = f.begin('question', start.question);
  await f.toolHooks.get('execute.before')(call);
  const selections = start.question.questions.map(question => [question.options[0].label]);
  const formatted = start.question.questions.map((q, i) => `"${q.question}"="${selections[i].join(', ')}"`).join(', ');
  await f.toolHooks.get('execute.after')({ ...call, status: 'completed', result: {
    output: { answers: selections }, content: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
  } });
  assert.equal((await f.call('mdd_status', {})).state, 'ready');
});

test('V2 foreground phase hooks complete plan, Apply and Verify with durable motor state', async t => {
  const f = await fixture(t);
  f.user('Implement the requested change.');
  await f.call('mdd_start', { requirements: 'Implement the requested change.' });
  const trace = traceFixture(join(f.root, 'feature.txt'), 'feature');
  for (const phase of ['mdd-plan', 'mdd-apply', 'mdd-verify']) {
    const ready = await f.call('mdd_status', {});
    assert.equal(ready.task.agent, phase);
    assert.equal(ready.nextAction.tool, 'subagent');
    const call = f.begin('subagent', ready.task);
    await f.toolHooks.get('execute.before')(call);
    assert.match(call.input.prompt, /Native callID=/);
    assert.equal(call.input.agent, phase);
    assert.equal(call.input.subagent_type, undefined);
    const result = { phase, runID: ready.runID, callID: call.id, outcome: 'passed', evidenceSummary: 'Scoped contract evidence.', artifact: `Artifact for ${phase}.` };
    if (phase === 'mdd-plan') Object.assign(result, trace);
    if (phase === 'mdd-apply') { result.changes = [{ path: join(f.root, 'feature.txt'), reason: 'Implement the planned boundary.' }]; result.delivered = { what: 'Requested behavior is implemented.', implies: 'Consumers use the new boundary.' }; }
    if (phase === 'mdd-verify') {
      result.checks = [{ command: 'npm test', exit: 0 }];
      const assessment = { status: 'verified', checks: ['npm test'], assessment: 'Scoped checks support the expected behavior.' };
      result.verification = { scenarios: ['S1', 'S2'].map(scenarioID => ({ requirementID: 'R1', scenarioID, stepID: 'feature', ...assessment })),
        steps: [{ stepID: 'feature', ...assessment }], decisions: [{ decisionID: 'D1', ...assessment }], changes: 'Planned change implemented.', limits: [] };
    }
    const text = reportDocument(result);
    await f.toolHooks.get('execute.after')({ ...call, status: 'completed', result: {
      output: { sessionID: `child-${phase}`, status: 'completed', output: text }, content: `<subagent sessionID="child-${phase}" state="completed">\n${text}\n</subagent>`,
    } });
  }
  assert.equal((await f.call('mdd_status', {})).state, 'complete');
});

test('V2 dispatch rejects extra capabilities and fabricated completion envelopes', async t => {
  const f = await fixture(t); f.user('Implement the requested change.');
  await f.call('mdd_start', { requirements: 'Implement the requested change.' });
  const ready = await f.call('mdd_status', {});
  const extra = f.begin('subagent', { ...ready.task, background: true });
  await assert.rejects(f.toolHooks.get('execute.before')(extra), /exactly/);
  const call = f.begin('subagent', ready.task);
  await f.toolHooks.get('execute.before')(call);
  await assert.rejects(f.toolHooks.get('execute.after')({ ...call, status: 'completed', result: {
    output: { sessionID: 'child', status: 'running', output: 'Not complete' }, content: 'Not complete',
  } }), /completed foreground/);
  assert.equal((await f.call('mdd_status', {})).state, 'await-result');
});

test('V2 tracked native fallback children cannot recursively orchestrate', async t => {
  const f = await fixture(t); f.user('Implement the requested change.');
  await f.call('mdd_start', { requirements: 'Implement the requested change.' });
  await f.call('mdd_phase_result', { result: 'Select native execution instead of coordinator work.' });
  const ready = await f.call('mdd_status', {});
  assert.equal(ready.mode, 'native');
  assert.equal(ready.task.agent, 'general');
  const fallback = f.begin('subagent', ready.task);
  await f.toolHooks.get('execute.before')(fallback);
  const child = { ...f.sessions.get(f.sessionID), id: 'ses_child', parentID: f.sessionID, agent: 'general' };
  f.sessions.set(child.id, child); f.messages.set(child.id, []);
  await f.emit({ type: 'session.created', location: { directory: f.root }, data: { ...child, sessionID: child.id } });
  for (const tool of ['subagent', 'skill', 'mdd_start', 'mdd_check_report', 'mdd_jd_inspect']) {
    await assert.rejects(f.toolHooks.get('execute.before')({ sessionID: child.id, agent: 'general', id: `child-${tool}`, tool, input: {} }), /tracked native fallback/);
  }
});

test('V2 rejects moved tool contexts and ignores late native completions outside its workspace', async t => {
  const f = await fixture(t); f.user('Implement the requested change.');
  await f.call('mdd_start', { requirements: 'Implement the requested change.' });
  const ready = await f.call('mdd_status', {});
  const call = f.begin('subagent', ready.task);
  await f.toolHooks.get('execute.before')(call);
  f.sessions.get(f.sessionID).location.directory = join(f.root, 'other');
  await assert.rejects(f.call('mdd_status', {}), /differs/);
  await f.toolHooks.get('execute.after')({ ...call, status: 'error', error: {} });
  f.sessions.get(f.sessionID).location.directory = f.root;
  assert.equal((await f.call('mdd_status', {})).state, 'await-result');
});

test('V2 child recovery never treats missing or foreign status events as idle', async t => {
  const f = await fixture(t); f.user('Implement the requested change.');
  await f.call('mdd_start', { requirements: 'Implement the requested change.' });
  const ready = await f.call('mdd_status', {});
  const call = f.begin('subagent', ready.task);
  await f.toolHooks.get('execute.before')(call);
  const child = { ...f.sessions.get(f.sessionID), id: 'ses_child', parentID: f.sessionID };
  f.sessions.set(child.id, child); f.messages.set(child.id, []);
  f.messages.get(f.sessionID).at(-1).content.find(part => part.id === call.id).state.metadata.sessionID = child.id;
  await f.toolHooks.get('execute.after')({ ...call, status: 'error', error: {} });
  assert.equal((await f.call('mdd_status', {})).liveness.verdict, 'unknown');
  await f.emit({ type: 'session.status', location: { directory: join(f.root, 'elsewhere') }, data: { sessionID: child.id, status: { type: 'idle' } } });
  assert.equal((await f.call('mdd_status', {})).liveness.verdict, 'unknown');
  await f.emit({ type: 'session.status', location: { directory: f.root }, data: { sessionID: child.id, status: { type: 'busy' } } });
  assert.equal((await f.call('mdd_status', {})).liveness.verdict, 'running');
  await f.emit({ type: 'session.status', location: { directory: f.root }, data: { sessionID: child.id, status: { type: 'idle' } } });
  assert.equal((await f.call('mdd_status', {})).liveness.verdict, 'stopped');
});

test('V2 model context collapse uses native messages and never mutates persisted input', async t => {
  const f = await fixture(t);
  const input = { agent: 'mdd-plan', description: 'Plan', prompt: 'x'.repeat(3000) };
  const messages = [{ role: 'assistant', content: [{ type: 'tool-call', id: 'call', name: 'subagent', input }] },
    { role: 'tool', content: [{ type: 'tool-result', id: 'call', name: 'subagent', result: { type: 'text', value: 'Done' } }] }];
  const event = { agent: 'mdd-orchestrator', messages };
  await f.sessionHooks.get('context')(event);
  assert.match(event.messages[0].content[0].input.prompt, /mdd:dispatch:delivered/);
  assert.equal(input.prompt.length, 3000);
  assert.equal(contentText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.throws(() => contentText([{ type: 'file', uri: 'file:///a' }]), /complete text/);
  const status = JSON.parse(v2Payload(JSON.stringify({ task: { subagent_type: 'mdd-plan', description: 'Plan', prompt: 'handle' }, requirements: 'task subagent_type' })));
  assert.equal(status.requirements, 'task subagent_type');
});
