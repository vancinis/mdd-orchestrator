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
import { RunOwnershipStore } from '../dist/run-ownership.js';
import { isolateHome, answers, reportDocument, riskReport, traceFixture } from './adapter-fixture.mjs';

test('plural task payloads map native arguments without a wrapper or single-member instruction', () => {
  const tasks = ['one', 'two'].map(prompt => ({ description: prompt, subagent_type: 'mdd-apply', prompt }));
  const payload = JSON.parse(v2Payload(JSON.stringify({ tasks, nextAction: { tool: 'task', calls: tasks, why: 'batch' } })));
  assert.deepEqual(payload.tasks, tasks.map(({ subagent_type, ...rest }) => ({ ...rest, agent: subagent_type })));
  assert.deepEqual(payload.nextAction.calls, payload.tasks); assert.equal(payload.nextAction.tool, 'subagent');
  assert.match(payload.nextAction.why, /each exact object/);
  assert.match(payload.nextAction.why, /one grouped native foreground tool-call message in provider order/);
  assert.match(payload.nextAction.why, /Never use Code Mode, Promise\.all or background/);
});

// Public host fakes follow @opencode/plugin/client/core 2.0.22, not the V1 hooks.
async function fixture(t, completeProfile = true, workersEnabled = true, version = '2.0.22', securityModel) {
  isolateHome(t);
  const root = await mkdtemp(join(tmpdir(), 'mdd-v2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = defaultSettings();
  settings.workers.enabled = workersEnabled;
  settings.profiles.default.answers = completeProfile ? { ...answers } : {};
  settings.profiles.default.models['mdd-plan'] = 'openai/test-model#high';
  if (securityModel) settings.profiles.default.models['mdd-security'] = securityModel;
  settings.profiles.default.models['mdd-jd-judge-a'] = 'openai/judge-model#high';
  saveGlobalSettings(settings);
  const sessionID = 'ses_parent';
  const sessions = new Map([[sessionID, { id: sessionID, agent: 'mdd-orchestrator', projectID: 'project', location: { directory: root }, time: { created: 1, updated: 1 } }]]);
  const messages = new Map([[sessionID, []]]);
  const tools = new Map(); const toolHooks = new Map(); const sessionHooks = new Map();
  const agents = ['mdd-orchestrator', 'mdd-explore', 'mdd-risk', 'mdd-plan', 'mdd-apply', 'mdd-verify', 'mdd-security', 'general'].map(id => ({ id, permissions: [], request: {} }));
  const queue = []; let wake;
  const ctx = {
    app: { version },
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
  let cleanup = await plugin.setup(ctx); t.after(() => cleanup());
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
    restart: async () => { await cleanup(); cleanup = await plugin.setup(ctx); },
    emit: event => new Promise(resolve => { queue.push({ event, resolve }); wake?.(); }) };
}

async function auditFixture(t, text = 'Run mdd-security', securityModel) {
  const f = await fixture(t, true, true, '2.0.22', securityModel);
  const gitPath = process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : '/usr/bin/git';
  const git = (...args) => execFileSync(gitPath, ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
    { cwd: f.root, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Audit Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(f.root, '.gitignore'), '.mdd/\n');
  await writeFile(join(f.root, 'source.ts'), 'const query = safeQuery();\n');
  git('add', '.'); git('commit', '-m', 'fixture base');
  const baseRef = git('rev-parse', 'HEAD'); git('switch', '-c', 'implementation');
  await writeFile(join(f.root, 'source.ts'), 'const query = unsafeQuery(input);\n');
  git('add', '.'); git('commit', '-m', 'fixture implementation');
  await writeFile(join(f.root, 'source.ts'), 'const query = safeQuery();\n'); git('add', '.');
  await writeFile(join(f.root, 'source.ts'), 'const query = worktreeQuery(input);\n');
  await writeFile(join(f.root, 'pending.ts'), 'export const pending = externalInput;\n');
  f.user(text);
  return { ...f, text, baseRef, git };
}

async function dispatchAudit(f) {
  const ready = await f.call('mdd_security', { userText: f.text });
  assert.equal(ready.state, 'security-ready', JSON.stringify(ready));
  assert.equal(ready.task.agent, 'mdd-security');
  const call = f.begin('subagent', ready.task);
  await f.toolHooks.get('execute.before')(call);
  const snapshot = JSON.parse(/<mdd-security-snapshot>\n([\s\S]*?)\n<\/mdd-security-snapshot>/.exec(call.input.prompt)[1]);
  const child = { ...structuredClone(f.sessions.get(f.sessionID)), id: `child-${call.id}`, parentID: f.sessionID, agent: 'mdd-security' };
  f.sessions.set(child.id, child); f.messages.set(child.id, []);
  const part = f.messages.get(f.sessionID).at(-1).content.find(part => part.id === call.id);
  part.state.metadata.sessionID = child.id;
  return { ready, call, snapshot, child, part };
}

function auditReport(snapshot) {
  const security = { snapshotID: snapshot.snapshotID, status: 'no-findings', coverage: structuredClone(snapshot.coverage),
    limitations: [...snapshot.limitations], findings: [] };
  if (security.limitations.length || security.coverage.some(item => item.status !== 'complete' || item.limitations.length)) security.status = 'inconclusive';
  return { security, render: () => ['## MDD Outcome', security.status === 'inconclusive' ? 'failed' : 'passed', '## MDD Summary', 'Bounded inspection completed.',
    '## MDD How', 'Inspected all supplied implementation layers.', '## MDD Artifact', 'Detailed security inspection with runtime coverage.',
    '## MDD Data', '```json', JSON.stringify({ security }), '```'].join('\n\n') };
}

async function finishAudit(f, audit, report) {
  f.messages.set(audit.child.id, [{ id: 'final', type: 'assistant', agent: 'mdd-security', finish: 'stop',
    time: { created: 1, completed: 2 }, content: [{ type: 'text', text: report }] }]);
  const event = { ...audit.call, status: 'completed', result: { output: { sessionID: audit.child.id, status: 'completed', output: report },
    content: `<subagent sessionID="${audit.child.id}" state="completed">\n${report}\n</subagent>` } };
  await f.toolHooks.get('execute.after')(event);
  return JSON.parse(event.result.content);
}

for (const text of ['Run mdd-security', 'Hacé una revisión de seguridad.', 'lanza el agente de seguridad', 'usa mdd-security', 'security audit', 'mdd-security',
  'Quiero que hagamos una revisión de seguridad']) {
  test(`V2 authenticated standalone audit preserves the workflow: ${text}`, async t => {
    const f = await auditFixture(t, text);
    const before = await f.call('mdd_status', {});
    assert.equal(before.state, 'not-started'); assert.equal(before.task, undefined);
    assert.equal(f.agents.find(agent => agent.id === 'mdd-security').model, undefined);
    const audit = await dispatchAudit(f);
    assert.deepEqual(audit.snapshot.coverage.map(item => item.layer), ['committed', 'index', 'worktree', 'untracked']);
    for (const layer of ['committed', 'index', 'worktree', 'untracked']) assert.ok(audit.snapshot.locations.some(item => item.layer === layer));
    assert.equal(audit.snapshot.baseCommit, f.baseRef);
    assert.match(audit.call.input.prompt, /# MDD actor instructions/);
    assert.match(audit.call.input.prompt, /name: mdd-doc/); assert.match(audit.call.input.prompt, /name: cognitive-doc-design/);
    const event = { sessionID: audit.child.id, agent: 'mdd-security', messages: [], tools: { read: {}, bash: {}, mdd_check_report: {}, mcp_secret: {}, subagent: {} } };
    await f.sessionHooks.get('context')(event);
    assert.deepEqual(Object.keys(event.tools), ['mdd_check_report']);
    const report = auditReport(audit.snapshot).render();
    const checker = await f.tools.get('mdd_check_report').execute({ phase: 'mdd-security', result: report },
      { sessionID: audit.child.id, agent: 'mdd-security', messageID: 'check', id: 'checker', signal: new AbortController().signal });
    assert.equal(JSON.parse(checker.content).ok, true);
    const result = await finishAudit(f, audit, report);
    assert.equal(result.state, 'security-complete'); assert.equal(result.status, 'no-findings');
    assert.equal(result.report, report); assert.equal(result.security.findings.length, 0);
    assert.match(result.note, /separate user authorization/);
    const after = await f.call('mdd_status', {});
    assert.equal(after.state, before.state); assert.deepEqual(after.workflow, before.workflow); assert.equal(after.task, undefined);
    assert.equal((await f.call('mdd_security', { userText: f.text })).state, 'security-refused');
    await assert.rejects(f.toolHooks.get('execute.before')(audit.call), /security/i);
    await assert.rejects(f.sessionHooks.get('context')(event), /security/i);
  });
}

test('V2 security model override is frozen and inheritance stays native', async t => {
  const f = await auditFixture(t, 'Run mdd-security', 'openai/audit-model#high');
  assert.deepEqual(f.agents.find(agent => agent.id === 'mdd-security').model, { providerID: 'openai', id: 'audit-model', variant: 'high' });
  const changed = defaultSettings(); changed.profiles.default.models['mdd-security'] = 'other/not-authorized'; saveGlobalSettings(changed);
  await dispatchAudit(f);
  assert.equal(f.agents.find(agent => agent.id === 'mdd-security').model.id, 'audit-model');
  assert.deepEqual(f.agents.find(agent => agent.id === 'mdd-security').permissions.slice(-2),
    [{ action: '*', resource: '*', effect: 'deny' }, { action: 'mdd_check_report', resource: '*', effect: 'allow' }]);
});

for (const actor of ['mdd-jd-judge-a', 'mdd-jd-fix']) {
  test(`V2 security waits for admitted ${actor} settlement, not just native completion`, async t => {
    const f = await auditFixture(t);
    const task = f.begin('subagent', { agent: actor, description: 'Standalone task', prompt: 'Explicitly authorized frozen target.' });
    await f.toolHooks.get('execute.before')(task);
    // Host completion can be visible before the plugin after-hook settles its admitted call.
    const part = f.messages.get(f.sessionID).at(-1).content.find(part => part.id === task.id);
    part.state.status = 'completed';
    f.user(f.text);
    if (actor === 'mdd-jd-fix') await assert.rejects(f.call('mdd_security', { userText: f.text }), /flight|standalone/i);
    else assert.equal((await f.call('mdd_security', { userText: f.text })).state, 'security-refused');
    await f.toolHooks.get('execute.after')({ ...task, status: 'completed', result: {
      output: { sessionID: 'standalone-child', status: 'completed', output: 'Standalone result.' },
      content: '<subagent sessionID="standalone-child" state="completed">\nStandalone result.\n</subagent>',
    } });
    assert.equal((await f.call('mdd_security', { userText: f.text })).state, 'security-ready');
  });
}

test('V2 standalone judges hold coordinator controls without losing concurrent dual admission', async t => {
  const f = await fixture(t);
  f.user('Judge the committed target.');
  const calls = ['mdd-jd-judge-a', 'mdd-jd-judge-b'].map(agent => f.begin('subagent', { agent, description: 'Judge', prompt: 'Frozen committed target.' }));
  await Promise.all(calls.map(call => f.toolHooks.get('execute.before')(call)));
  f.user('Implement a separate change.');
  await assert.rejects(f.call('mdd_start', { requirements: 'Implement a separate change.' }), /standalone.*flight/i);
  await assert.rejects(f.toolHooks.get('execute.before')(f.begin('question', {})), /standalone.*flight/i);
  await assert.rejects(f.toolHooks.get('execute.before')(f.begin('subagent', { agent: 'mdd-jd-fix', description: 'Fix', prompt: 'Authorized correction.' })), /standalone.*flight/i);
  for (const call of calls) await f.toolHooks.get('execute.after')({ ...call, status: 'error', error: {} });
  assert.equal((await f.call('mdd_start', { requirements: 'Implement a separate change.' })).task.agent, 'mdd-explore');
});

test('V2 security cannot bypass an unconfirmed durable workflow claim after restart', async t => {
  const f = await auditFixture(t);
  const owners = new RunOwnershipStore(f.root);
  owners.claimParent(f.sessionID, 'unconfirmed-run');
  owners.claim({ runID: 'unconfirmed-run', sessionID: f.sessionID, directory: f.root, worktree: f.root });
  const before = owners.read('unconfirmed-run');
  assert.equal((await f.call('mdd_security', { userText: f.text })).state, 'security-refused');
  assert.deepEqual(owners.read('unconfirmed-run'), before);
});

for (const actors of [['mdd-jd-judge-a', 'mdd-jd-fix'], ['mdd-jd-fix', 'mdd-jd-judge-a']]) {
  test(`V2 concurrent ${actors.join(' then ')} admission never overlaps review and correction`, async t => {
    const f = await fixture(t); f.user('Review and correction fixture.');
    const calls = actors.map(agent => f.begin('subagent', { agent, description: 'Standalone', prompt: 'Authorized frozen target.' }));
    const results = await Promise.allSettled(calls.map(call => f.toolHooks.get('execute.before')(call)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  });
}

test('V2 security and Judgment Day inspection privileges never substitute for each other', async t => {
  const f = await auditFixture(t); const audit = await dispatchAudit(f);
  await assert.rejects(f.toolHooks.get('execute.before')({ sessionID: audit.child.id, agent: 'mdd-jd-judge-a',
    id: 'forged-judge', tool: 'mdd_jd_inspect', input: {} }), /security/i);
  await assert.rejects(f.toolHooks.get('execute.before')(f.begin('subagent', { agent: 'mdd-jd-judge-a', description: 'Judge', prompt: 'Target' })), /security/i);
  await finishAudit(f, audit, auditReport(audit.snapshot).render());
  const judge = { ...f.sessions.get(f.sessionID), id: 'judge', parentID: f.sessionID, agent: 'mdd-jd-judge-a' };
  f.sessions.set(judge.id, judge); f.messages.set(judge.id, []);
  await assert.rejects(f.toolHooks.get('execute.before')({ sessionID: judge.id, agent: judge.agent,
    id: 'security-check', tool: 'mdd_check_report', input: { phase: 'mdd-security', result: '' } }), /judge|immutable/i);
});

for (const mutation of ['synthetic', 'wrong-text', 'wrong-agent', 'nested-parent', 'workspace', 'pending-question', 'pending-task']) {
  test(`V2 security intake rejects ${mutation} without starting a workflow`, async t => {
    const f = await auditFixture(t);
    if (mutation === 'synthetic') f.messages.get(f.sessionID)[0].type = 'synthetic';
    if (mutation === 'wrong-text') f.messages.get(f.sessionID)[0].text = 'Implement mdd-security';
    if (mutation === 'wrong-agent') f.messages.get(f.sessionID).at(-1).agent = 'general';
    if (mutation === 'nested-parent') {
      f.sessions.set('outside', { ...f.sessions.get(f.sessionID), id: 'outside', agent: 'general' });
      f.messages.set('outside', []);
      f.sessions.get(f.sessionID).parentID = 'outside';
    }
    if (mutation === 'workspace') f.sessions.get(f.sessionID).location.directory = join(f.root, 'outside');
    if (mutation === 'pending-question') f.begin('question', { questions: [] });
    if (mutation === 'pending-task') f.begin('subagent', { agent: 'general', description: 'Other task', prompt: 'Other task' });
    if (mutation === 'workspace') await assert.rejects(f.call('mdd_security', { userText: f.text }), /differs/);
    else assert.equal((await f.call('mdd_security', { userText: f.text })).state, 'security-refused');
  });
}

test('V2 security child independently rejects every non-checker tool and forged role', async t => {
  const f = await auditFixture(t); const audit = await dispatchAudit(f);
  for (const tool of ['read', 'glob', 'grep', 'write', 'edit', 'bash', 'shell', 'webfetch', 'subagent', 'skill', 'question', 'mcp_secret', 'mdd_start']) {
    await assert.rejects(f.toolHooks.get('execute.before')({ sessionID: audit.child.id, agent: 'mdd-security', messageID: 'child', id: `call-${tool}`, tool, input: {} }), /security/i);
  }
  await assert.rejects(f.toolHooks.get('execute.before')({ sessionID: audit.child.id, agent: 'general', id: 'forge', tool: 'bash', input: {} }), /security/i);
  await assert.rejects(f.toolHooks.get('execute.before')({ sessionID: audit.child.id, agent: 'mdd-security', id: 'wrong-role', tool: 'mdd_check_report', input: { phase: 'mdd-apply', result: 'text' } }), /security/i);
  await assert.rejects(f.call('mdd_transfer', { userText: f.text, sourceSessionID: 'source', runID: 'run' }), /security/i);
  await assert.rejects(f.call('mdd_reset', { scope: 'run', userText: f.text }), /security/i);
  await assert.rejects(f.toolHooks.get('execute.before')(f.begin('question', {})), /security/i);
});

test('V2 security isolation follows the authenticated child, not its current claimed or native agent name', async t => {
  const f = await auditFixture(t); const audit = await dispatchAudit(f);
  f.sessions.get(audit.child.id).agent = 'general';
  await assert.rejects(f.toolHooks.get('execute.before')({ sessionID: audit.child.id, agent: 'general', messageID: 'child', id: 'changed-agent', tool: 'bash', input: {} }), /security/i);
});

test('V2 refuses an invented baseline and preserves a user-selected baseline', async t => {
  const f = await auditFixture(t);
  assert.equal((await f.call('mdd_security', { userText: f.text, baseRef: 'HEAD' })).state, 'security-refused');
  f.user(`Run mdd-security baseRef=${f.baseRef}`);
  const ready = await f.call('mdd_security', { userText: `Run mdd-security baseRef=${f.baseRef}`, baseRef: f.baseRef });
  assert.equal(ready.state, 'security-ready');
  const call = f.begin('subagent', ready.task); await f.toolHooks.get('execute.before')(call);
  const snapshot = JSON.parse(/<mdd-security-snapshot>\n([\s\S]*?)\n<\/mdd-security-snapshot>/.exec(call.input.prompt)[1]);
  assert.equal(snapshot.baseline.kind, 'explicit'); assert.equal(snapshot.baseCommit, f.baseRef);
});

test('V2 audit keeps an existing workflow and surfaces incomplete coverage without losing findings', async t => {
  const f = await auditFixture(t);
  f.user('Implement the requested change.'); await f.call('mdd_start', { requirements: 'Implement the requested change.' });
  const before = await f.call('mdd_status', {});
  assert.equal(before.task.agent, 'mdd-explore');
  await writeFile(join(f.root, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
  f.user(f.text); const audit = await dispatchAudit(f); const report = auditReport(audit.snapshot);
  assert.equal(report.security.status, 'inconclusive');
  const location = audit.snapshot.locations.find(item => item.layer === 'committed' && item.side === 'after');
  report.security.findings.push({ id: 'F1', severity: 'high', title: 'Unsafe query boundary', location,
    evidence: 'unsafeQuery(input)', attackConditions: 'External input reaches the query.', impact: 'Query injection may cross tenant scope.',
    recommendation: 'Bind parameters and enforce tenant authorization.' });
  const result = await finishAudit(f, audit, report.render());
  assert.equal(result.state, 'security-complete'); assert.equal(result.status, 'inconclusive');
  assert.equal(result.security.findings.length, 1); assert.equal(result.security.coverage[3].status, 'partial');
  const after = await f.call('mdd_status', {});
  assert.equal(after.runID, before.runID); assert.equal(after.state, before.state);
  assert.deepEqual(after.workflow, before.workflow); assert.deepEqual(after.task, before.task);
});

test('V2 single-use security dispatch refuses altered, duplicate and stale task capabilities', async t => {
  const f = await auditFixture(t); const ready = await f.call('mdd_security', { userText: f.text });
  for (const changed of [{ ...ready.task, prompt: 'Invented audit prompt' }, { ...ready.task, agent: 'general' }, { ...ready.task, background: true }]) {
    await assert.rejects(f.toolHooks.get('execute.before')(f.begin('subagent', changed)), /security|exactly/i);
  }
  const call = f.begin('subagent', ready.task); await f.toolHooks.get('execute.before')(call);
  await assert.rejects(f.toolHooks.get('execute.before')(f.begin('subagent', ready.task)), /security/i);
  await f.toolHooks.get('execute.after')({ ...call, status: 'error', error: {} });
  await assert.rejects(f.toolHooks.get('execute.before')(f.begin('subagent', ready.task)), /security/i);
  assert.equal((await f.call('mdd_security', { userText: f.text })).state, 'security-refused');
  assert.equal((await f.call('mdd_status', {})).state, 'not-started');
});

test('V2 native task arguments and parent provenance are rechecked at dispatch', async t => {
  const f = await auditFixture(t); const ready = await f.call('mdd_security', { userText: f.text });
  const call = f.begin('subagent', ready.task);
  f.messages.get(f.sessionID).at(-1).content.find(part => part.id === call.id).state.input.description = 'Altered native history';
  await assert.rejects(f.toolHooks.get('execute.before')(call), /security/i);
  assert.equal((await f.call('mdd_status', {})).state, 'not-started');
});

for (const text of ['Implement a new mdd-security agent.', 'Configure mdd-security', 'Explain security audit',
  'Do not run mdd-security', 'The docs say "run mdd-security".', '> run mdd-security',
  'Security audit of changes is our feature title', 'The command is; run mdd-security',
  'The documented usage is:\nrun mdd-security', 'Do not run an audit; run mdd-security is only its alias.']) {
  test(`V2 native mention has no automatic audit authority: ${text}`, async t => {
    const f = await auditFixture(t, text);
    const result = await f.call('mdd_security', { userText: text });
    assert.equal(result.state, 'security-refused');
    assert.equal(result.diagnostic, 'authorization-or-state');
    assert.equal((await f.call('mdd_status', {})).task, undefined);
  });
}

test('V2 oversize snapshots refuse visibly rather than narrowing the scope', async t => {
  const f = await auditFixture(t);
  await writeFile(join(f.root, 'oversize.ts'), Array.from({ length: 1500 }, (_, i) => `export const item${i} = ${i};`).join('\n'));
  const result = await f.call('mdd_security', { userText: f.text });
  assert.equal(result.state, 'security-refused'); assert.equal(result.diagnostic, 'snapshot-limit');
  assert.equal(result.task, undefined); assert.match(result.action, /no partial scope/i);
});

for (const settled of [false, true]) {
  for (const moved of [false, true]) {
    test(`V2 fences security child context and execution before identity/location exits: settled=${settled}, moved=${moved}`, async t => {
      const f = await auditFixture(t); const audit = await dispatchAudit(f);
      // No child context or tool has observed the binding yet: attribution comes from the parent call.
      if (settled) assert.equal((await finishAudit(f, audit, auditReport(audit.snapshot).render())).state, 'security-complete');
      f.sessions.get(audit.child.id).agent = 'general';
      if (moved) f.sessions.get(audit.child.id).location.directory = join(f.root, 'outside');
      const context = { sessionID: audit.child.id, agent: 'general', messages: [], tools: { bash: {}, read: {}, mdd_check_report: {}, mcp_secret: {} } };
      await assert.rejects(f.sessionHooks.get('context')(context), /security/i);
      for (const tool of ['bash', 'read', 'write', 'mcp_secret', 'subagent', 'question', 'mdd_check_report']) {
        await assert.rejects(f.toolHooks.get('execute.before')({ sessionID: audit.child.id, agent: 'general', messageID: 'child', id: `moved-${tool}`,
          tool, input: { phase: 'mdd-security', result: 'document' } }), /security/i);
      }
      await assert.rejects(f.tools.get('mdd_check_report').execute({ phase: 'mdd-security', result: '' },
        { sessionID: audit.child.id, agent: 'general', messageID: 'child', id: 'direct-checker', signal: new AbortController().signal }), /security/i);
    });
  }
}

test('V2 keeps unrelated general context and off-location tools outside security enforcement', async t => {
  const f = await fixture(t);
  const other = { ...f.sessions.get(f.sessionID), id: 'unrelated', agent: 'general', location: { directory: join(f.root, 'outside') } };
  f.sessions.set(other.id, other); f.messages.set(other.id, []);
  const context = { sessionID: other.id, agent: 'general', messages: [], tools: { bash: {}, read: {} } };
  await f.sessionHooks.get('context')(context);
  assert.deepEqual(Object.keys(context.tools), ['bash', 'read']);
  await f.toolHooks.get('execute.before')({ sessionID: other.id, agent: 'general', id: 'ordinary', tool: 'bash', input: {} });
  const child = { ...other, id: 'unrelated-child', parentID: other.id };
  f.sessions.set(child.id, child); f.messages.set(child.id, []);
  await f.sessionHooks.get('context')({ ...context, sessionID: child.id });
  await f.toolHooks.get('execute.before')({ sessionID: child.id, agent: 'general', id: 'ordinary-child', tool: 'bash', input: {} });
});

test('V2 known security descendants remain fenced after the audit closes and native ancestry moves', async t => {
  const f = await auditFixture(t); const audit = await dispatchAudit(f);
  assert.equal((await finishAudit(f, audit, auditReport(audit.snapshot).render())).state, 'security-complete');
  const native = f.sessions.get(audit.child.id);
  native.agent = 'general'; native.location.directory = join(f.root, 'outside');
  const descendant = { ...native, id: 'security-descendant', parentID: audit.child.id };
  f.sessions.set(descendant.id, descendant); f.messages.set(descendant.id, []);
  await assert.rejects(f.sessionHooks.get('context')({ sessionID: descendant.id, agent: 'general', messages: [], tools: { bash: {} } }), /security/i);
  await assert.rejects(f.toolHooks.get('execute.before')({ sessionID: descendant.id, agent: 'general', id: 'descendant-shell', tool: 'bash', input: {} }), /security/i);
});

test('V2 independently rejects shell execution when a security child changes both actor and location', async t => {
  const f = await auditFixture(t); const audit = await dispatchAudit(f);
  f.sessions.get(audit.child.id).agent = 'general';
  f.sessions.get(audit.child.id).location.directory = join(f.root, 'outside');
  await assert.rejects(f.toolHooks.get('execute.before')({ sessionID: audit.child.id, agent: 'general', messageID: 'child', id: 'shell-outside', tool: 'bash', input: {} }), /security/i);
});

test('V2 refuses all tools and context when a security child loses native ancestry', async t => {
  const f = await auditFixture(t); const audit = await dispatchAudit(f);
  const native = f.sessions.get(audit.child.id);
  native.agent = 'general'; native.parentID = 'missing-native-parent';
  native.location.directory = join(f.root, 'outside');
  await assert.rejects(f.sessionHooks.get('context')({ sessionID: native.id, agent: 'general', messages: [], tools: { bash: {}, mdd_check_report: {} } }), /security/i);
  for (const tool of ['bash', 'mdd_check_report']) {
    await assert.rejects(f.toolHooks.get('execute.before')({ sessionID: native.id, agent: 'general', id: `missing-${tool}`, tool,
      input: { phase: 'mdd-security', result: '' } }), /security/i);
  }
});

for (const closed of ['completed', 'failed', 'restart']) {
  test(`V2 historical children stay fenced before first tool after ${closed}`, async t => {
    const f = await auditFixture(t); const audit = await dispatchAudit(f);
    if (closed === 'completed') assert.equal((await finishAudit(f, audit, auditReport(audit.snapshot).render())).state, 'security-complete');
    if (closed === 'failed') {
      await f.toolHooks.get('execute.after')({ ...audit.call, status: 'error' });
      assert.equal((await f.call('mdd_status', {})).task, undefined);
    }
    if (closed === 'restart') await f.restart();
    const history = legacyHistory(f.messages.get(f.sessionID), f.sessions.get(f.sessionID), f.root);
    const recorded = history.flatMap(message => message.parts).find(part => part.type === 'tool' && part.callID === audit.call.id);
    assert.equal(recorded.state.input.subagent_type, 'mdd-security');
    assert.equal(recorded.state.metadata.sessionId, audit.child.id);
    const native = f.sessions.get(audit.child.id);
    native.agent = 'general'; native.location.directory = join(f.root, 'outside');
    assert.equal(f.sessions.get(f.sessionID).location.directory, f.root);
    await assert.rejects(f.sessionHooks.get('context')({ sessionID: native.id, agent: 'general', messages: [], tools: { bash: {}, mdd_check_report: {} } }), /security/i);
    for (const tool of ['bash', 'mdd_check_report']) {
      await assert.rejects(f.toolHooks.get('execute.before')({ sessionID: native.id, agent: 'general', id: `${closed}-${tool}`, tool,
        input: { phase: 'mdd-security', result: '' } }), /security/i);
    }
  });
}

for (const mutation of ['snapshot', 'evidence', 'coverage', 'credentials', 'artifact-credentials', 'child', 'parent', 'call', 'stale', 'metadata', 'native-text', 'native-agent']) {
  test(`V2 security sanitizes and refuses forged or invalid result: ${mutation}`, async t => {
    const f = await auditFixture(t); const audit = await dispatchAudit(f); const report = auditReport(audit.snapshot);
    if (mutation === 'snapshot') report.security.snapshotID = 'snap_forged';
    if (mutation === 'evidence') {
      report.security.status = 'findings'; report.security.findings.push({ id: 'F1', severity: 'high', title: 'Injection risk',
        location: audit.snapshot.locations.find(item => item.layer === 'committed' && item.side === 'after'), evidence: 'SOURCE_NOT_SUPPLIED',
        attackConditions: 'External input reaches a query.', impact: 'Crosses authorization boundary.', recommendation: 'Bind query parameters.' });
    }
    if (mutation === 'coverage') report.security.coverage[0].inspected = [];
    if (mutation === 'credentials') report.security.limitations.push('Authorization: Bearer sk_test_123456789012345678901234');
    if (mutation === 'child') audit.child.id = 'forged_child';
    if (mutation === 'parent') f.sessions.get(audit.child.id).parentID = 'outside';
    if (mutation === 'call') audit.call.id = 'forged_call';
    if (mutation === 'stale') f.user('Continue with something else.');
    if (mutation === 'metadata') audit.part.state.metadata.sessionID = 'outside';
    let text = report.render();
    if (mutation === 'artifact-credentials') text = text.replace('Detailed security inspection', 'Authorization: Bearer sk_test_123456789012345678901234');
    if (mutation === 'native-text' || mutation === 'native-agent') {
      const original = f.ctx.session.context;
      f.ctx.session.context = async args => {
        const history = await original(args);
        if (args.sessionID === audit.child.id && history.length) {
          if (mutation === 'native-text') history.at(-1).content[0].text = 'Different native report';
          else history.at(-1).agent = 'mdd-apply';
        }
        return history;
      };
    }
    const result = await finishAudit(f, audit, text);
    assert.equal(result.state, 'security-invalid'); assert.equal(result.status, 'inconclusive');
    assert.equal(result.report, undefined); assert.doesNotMatch(JSON.stringify(result), /sk_test_|SOURCE_NOT_SUPPLIED/);
  });
}

test('V2 setup registers native tools, model variants and ordered isolation permissions', async t => {
  const f = await fixture(t);
  assert.equal(plugin.id, 'mdd');
  assert.ok(f.tools.has('mdd_start'));
  assert.equal(f.tools.get('mdd_start').options.codemode, false);
  assert.equal(typeof f.tools.get('mdd_start').input.safeParse, 'function');
  assert.deepEqual(f.agents.find(agent => agent.id === 'mdd-plan').model, { providerID: 'openai', id: 'test-model', variant: 'high' });
  for (const id of ['mdd-explore', 'mdd-risk'])
    assert.deepEqual(f.agents.find(agent => agent.id === id).permissions.slice(-3).map(rule => [rule.action, rule.effect]),
      [['subagent', 'deny'], ['skill', 'deny'], ['mdd_check_report', 'allow']]);
  assert.deepEqual(f.agents.find(agent => agent.id === 'mdd-apply').permissions.slice(-4).map(rule => [rule.action, rule.effect]),
    [['subagent', 'deny'], ['skill', 'deny'], ['mdd_check_report', 'allow'], ['mdd_worker_edit', 'allow']]);
  assert.equal(f.tools.get('mdd_worker_edit').options.codemode, false);
  assert.equal(f.agents.find(agent => agent.id === 'general').permissions.at(-1).effect, 'deny');
});

for (const [enabled, version] of [[true, '2.0.22'], [false, '2.0.22'], [true, '2.0.24']]) test(`production V2 captures bounded Apply capability and preference (workers=${enabled}, host=${version})`, async t => {
  const f = await fixture(t, true, enabled, version);
  f.user('Implement the requested change.');
  await f.call('mdd_start', { requirements: 'Implement the requested change.' });
  await settleExploreAndRisk(f);
  const ready = await f.call('mdd_status', {});
  const call = f.begin('subagent', ready.task);
  await f.toolHooks.get('execute.before')(call);
  const trace = traceFixture(join(f.root, 'one.txt'), 'one');
  trace.deliverables = ['one', 'two'].map(id => ({ ...trace.deliverables[0], id, path: join(f.root, `${id}.txt`),
    dependsOn: [], parallel: { complete: true, reads: [], writes: [`${id}.txt`] } }));
  const text = reportDocument({ phase: 'mdd-plan', runID: ready.runID, callID: call.id, outcome: 'passed',
    evidenceSummary: 'Two explicitly independent tasks.', artifact: 'Implement the two boundaries.', ...trace });
  await f.toolHooks.get('execute.after')({ ...call, status: 'completed', result: {
    output: { sessionID: 'plan-child', status: 'completed', output: text },
    content: `<subagent sessionID="plan-child" state="completed">\n${text}\n</subagent>`,
  } });
  const apply = await f.call('mdd_status', {});
  if (enabled) {
    assert.equal(apply.tasks?.length, 2, `Registered formatter-free editor enables the two independent Apply members on host ${version}.`);
    assert.equal(apply.task, undefined);
    assert.ok(f.tools.has('mdd_worker_edit'));
    for (const task of apply.tasks) await f.toolHooks.get('execute.before')(f.begin('subagent', task));
    f.user('Run mdd-security');
    const refused = await f.call('mdd_security', { userText: 'Run mdd-security' });
    assert.equal(refused.state, 'security-refused'); assert.equal(refused.task, undefined);
    assert.equal((await f.call('mdd_status', {})).state, 'await-result');
    await assert.rejects(f.toolHooks.get('execute.before')(f.begin('subagent', {
      agent: 'mdd-jd-judge-a', description: 'Standalone judge', prompt: 'Explicit immutable target.' })),
    /pending|flight|settle|unfinished|workflow/i);
    return;
  }
  assert.equal(apply.task.agent, 'mdd-apply');
  assert.equal(apply.tasks, undefined);
  assert.equal(apply.nextAction.calls, undefined);
  const first = f.begin('subagent', apply.task);
  await f.toolHooks.get('execute.before')(first);
  const duplicate = f.begin('subagent', apply.task);
  await assert.rejects(f.toolHooks.get('execute.before')(duplicate));
  assert.equal((await f.call('mdd_status', {})).state, 'await-result');
});

test('V2 registers opt-in security dispatch and fails closed for an unbound security session', async t => {
  const f = await fixture(t);
  assert.ok(f.tools.has('mdd_security'));
  f.sessions.set('unbound', { ...f.sessions.get(f.sessionID), id: 'unbound', agent: 'mdd-security' });
  f.messages.set('unbound', []);
  for (const tool of ['read', 'write', 'bash', 'subagent', 'skill', 'question', 'mcp_secret', 'mdd_check_report']) {
    await assert.rejects(f.toolHooks.get('execute.before')({ sessionID: 'unbound', agent: 'mdd-security', id: `call-${tool}`, tool,
      input: { phase: 'mdd-security', result: 'document' } }), /security/i);
  }
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

test('V2 native actor identity refuses readable records with neither recorded nor live actor', async t => {
  const f = await fixture(t);
  delete f.sessions.get(f.sessionID).agent;
  f.messages.set(f.sessionID, [{ id: 'nameless', type: 'assistant', content: [], time: { created: 1 } }]);
  for (const tool of ['bash', 'read', 'edit']) {
    await assert.rejects(f.toolHooks.get('execute.before')({ sessionID: f.sessionID, id: tool, tool,
      input: { agent: 'general' } }), /native actor identity/i);
  }
});

test('V2 native live ordinary identity remains usable before recorded actor history exists', async t => {
  const f = await fixture(t);
  delete f.sessions.get(f.sessionID).agent;
  assert.deepEqual(f.messages.get(f.sessionID), []);
  const event = { sessionID: f.sessionID, agent: 'general', id: 'early-edit', tool: 'edit', input: { filePath: 'not accessed' } };
  const before = structuredClone(event.input);
  await f.toolHooks.get('execute.before')(event);
  assert.deepEqual(event.input, before);
});

test('V2 native live judge identity enforces inspection-only policy without any recorded actor', async t => {
  const f = await fixture(t);
  delete f.sessions.get(f.sessionID).agent;
  for (const tool of ['bash', 'read', 'edit']) {
    await assert.rejects(f.toolHooks.get('execute.before')({ sessionID: f.sessionID, agent: 'mdd-jd-judge-a',
      id: tool, tool, input: { agent: 'general' } }), /judge.*only immutable/i);
  }
});

for (const source of ['session', 'history']) {
  test(`V2 recorded ${source} judge identity cannot be relaxed by a live ordinary actor`, async t => {
    const f = await fixture(t);
    f.sessions.get(f.sessionID).agent = source === 'session' ? 'mdd-jd-judge-a' : 'general';
    f.messages.set(f.sessionID, [{ id: 'recorded', type: 'assistant', agent: source === 'history' ? 'mdd-jd-judge-a' : 'general',
      content: [], time: { created: 1 } }]);
    await assert.rejects(f.toolHooks.get('execute.before')({ sessionID: f.sessionID, agent: 'general',
      id: 'conflicting-edit', tool: 'edit', input: {} }), /judge.*only immutable/i);
  });
}

test('V2 native live fix identity still requires an admitted parent before early-history edits', async t => {
  const f = await fixture(t);
  f.agents.push({ id: 'mdd-jd-fix', permissions: [], request: {} });
  const fix = { ...f.sessions.get(f.sessionID), id: 'early-fix', parentID: f.sessionID };
  delete fix.agent;
  f.sessions.set(fix.id, fix); f.messages.set(fix.id, []);
  const edit = { sessionID: fix.id, agent: 'mdd-jd-fix', id: 'fix-edit', tool: 'edit', input: {} };
  await assert.rejects(f.toolHooks.get('execute.before')(edit), /requires an admitted native fix task/);
  f.user('Apply the explicitly authorized bounded correction.');
  const dispatch = f.begin('subagent', { agent: 'mdd-jd-fix', description: 'Bounded fix', prompt: 'Authorized correction.' });
  await f.toolHooks.get('execute.before')(dispatch);
  await f.toolHooks.get('execute.before')(edit);
  await f.toolHooks.get('execute.after')({ ...dispatch, status: 'completed', result: {
    output: { sessionID: fix.id, status: 'completed', output: 'Correction handoff.' },
    content: `<subagent sessionID="${fix.id}" state="completed">\nCorrection handoff.\n</subagent>`,
  } });
  await assert.rejects(f.toolHooks.get('execute.before')({ ...edit, id: 'late-edit' }), /requires an admitted native fix task/);
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

/** Settles exploration and a validated low risk verdict through the real V2 foreground hooks. */
async function settleExploreAndRisk(f) {
  for (const phase of ['mdd-explore', 'mdd-risk']) {
    const ready = await f.call('mdd_status', {});
    assert.equal(ready.task.agent, phase);
    const call = f.begin('subagent', ready.task);
    await f.toolHooks.get('execute.before')(call);
    const text = phase === 'mdd-risk' ? riskReport('low', 'passed')
      : reportDocument({ phase, runID: ready.runID, callID: call.id, outcome: 'passed', evidenceSummary: 'Scoped contract evidence.', artifact: `Artifact for ${phase}.` });
    await f.toolHooks.get('execute.after')({ ...call, status: 'completed', result: {
      output: { sessionID: `child-${phase}`, status: 'completed', output: text }, content: `<subagent sessionID="child-${phase}" state="completed">\n${text}\n</subagent>`,
    } });
  }
}

test('V2 foreground phase hooks complete plan, Apply and Verify with durable motor state', async t => {
  const f = await fixture(t);
  f.user('Implement the requested change.');
  await f.call('mdd_start', { requirements: 'Implement the requested change.' });
  const trace = traceFixture(join(f.root, 'feature.txt'), 'feature');
  // Every run opens with exploration and the mdd-risk stop; only its validated low verdict
  // selects the low route's tail, so both precede the plan/apply/verify phases under test.
  for (const phase of ['mdd-explore', 'mdd-risk', 'mdd-plan', 'mdd-apply', 'mdd-verify']) {
    const ready = await f.call('mdd_status', {});
    assert.equal(ready.task.agent, phase);
    assert.equal(ready.nextAction.tool, 'subagent');
    const call = f.begin('subagent', ready.task);
    await f.toolHooks.get('execute.before')(call);
    assert.match(call.input.prompt, /Native callID=/);
    assert.equal(call.input.agent, phase);
    assert.equal(call.input.subagent_type, undefined);
    let text;
    if (phase === 'mdd-risk') {
      text = riskReport('low', 'passed');
    } else {
      const result = { phase, runID: ready.runID, callID: call.id, outcome: 'passed', evidenceSummary: 'Scoped contract evidence.', artifact: `Artifact for ${phase}.` };
      if (phase === 'mdd-plan') Object.assign(result, trace);
      if (phase === 'mdd-apply') { result.completed = ['feature']; result.changes = [{ path: join(f.root, 'feature.txt'), reason: 'Implement the planned boundary.' }]; result.delivered = { what: 'Requested behavior is implemented.', implies: 'Consumers use the new boundary.' }; }
      if (phase === 'mdd-verify') {
        result.checks = [{ command: 'npm test', exit: 0 }];
        const assessment = { status: 'verified', checks: ['npm test'], assessment: 'Scoped checks support the expected behavior.' };
        result.verification = { scenarios: ['S1', 'S2'].map(scenarioID => ({ requirementID: 'R1', scenarioID, stepID: 'feature', ...assessment })),
          steps: [{ stepID: 'feature', ...assessment }], decisions: [{ decisionID: 'D1', ...assessment }], changes: 'Planned change implemented.', limits: [] };
      }
      text = reportDocument(result);
    }
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

for (const failed of [false, true]) {
  test(`V2 sequential Apply uses fresh foreground children and ${failed ? 'blocks on failure' : 'advances only after the full plan'}`, async t => {
    const f = await fixture(t);
    f.user('Implement two dependent deliverables.');
    await f.call('mdd_start', { requirements: 'Implement two dependent deliverables.' });
    await settleExploreAndRisk(f);
    const trace = traceFixture(join(f.root, 'first.txt'), 'first');
    trace.deliverables[0].scenarios = ['S1'];
    trace.deliverables.push({ ...trace.deliverables[0], id: 'second', path: join(f.root, 'second.txt'), scenarios: ['S2'], dependsOn: ['first'] });
    const children = new Set();
    for (const [index, step] of ['plan', 'first', 'second'].entries()) {
      const ready = await f.call('mdd_status', {});
      const phase = index ? 'mdd-apply' : 'mdd-plan';
      assert.equal(ready.task.agent, phase);
      assert.deepEqual(Object.keys(ready.task).sort(), ['agent', 'description', 'prompt']);
      const call = f.begin('subagent', ready.task);
      await f.toolHooks.get('execute.before')(call);
      if (index) assert.deepEqual(JSON.parse(call.input.prompt.match(/^Applicable deliverables: (.*)$/m)[1]).map(item => item.id), [step]);
      const outcome = failed && step === 'second' ? 'failed' : 'passed';
      const text = reportDocument({ phase, runID: ready.runID, outcome, evidenceSummary: `Completed ${step}.`, artifact: `Artifact ${step}.`,
        ...(index ? { ...(outcome === 'passed' ? { completed: [step] } : {}), changes: [join(f.root, `${step}.txt`)] } : trace) });
      const child = `child-batch-${index}`;
      assert.equal(children.has(child), false);
      children.add(child);
      await f.toolHooks.get('execute.after')({ ...call, status: 'completed', result: {
        output: { sessionID: child, status: 'completed', output: text }, content: `<subagent sessionID="${child}" state="completed">\n${text}\n</subagent>`,
      } });
      if (step === 'first') {
        const next = await f.call('mdd_status', {});
        assert.equal(next.phase, 'mdd-apply');
        assert.equal(next.nextAction.tool, 'subagent');
      }
    }
    const done = await f.call('mdd_status', {});
    assert.equal(done.state, failed ? 'blocked' : 'ready');
    assert.equal(done.phase, failed ? 'mdd-apply' : 'mdd-verify');
    if (failed) assert.equal(done.task, undefined);
  });
}

test('V2 tracked native fallback children cannot recursively orchestrate', async t => {
  const f = await fixture(t); f.user('Implement the requested change.');
  await f.call('mdd_start', { requirements: 'Implement the requested change.' });
  // Settle exploration and a validated low risk verdict first, so native selection below falls
  // on a main tail phase and exercises the `general` fallback, not the `explore` prelude one.
  await settleExploreAndRisk(f);
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
  const event = { agent: 'mdd-orchestrator', messages, tools: { mdd_worker_edit: {} } };
  await f.sessionHooks.get('context')(event);
  assert.equal(event.tools.mdd_worker_edit, undefined);
  assert.match(event.messages[0].content[0].input.prompt, /mdd:dispatch:delivered/);
  assert.equal(input.prompt.length, 3000);
  assert.equal(contentText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.throws(() => contentText([{ type: 'file', uri: 'file:///a' }]), /complete text/);
  const status = JSON.parse(v2Payload(JSON.stringify({ task: { subagent_type: 'mdd-plan', description: 'Plan', prompt: 'handle' }, requirements: 'task subagent_type' })));
  assert.equal(status.requirements, 'task subagent_type');
});
