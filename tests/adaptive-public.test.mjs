import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import plugin from '../dist/opencode-plugin.js';
import { defaultSettings } from '../dist/settings.js';
import { saveGlobalSettings } from '../dist/global-settings.js';
import { isolateHome, reportDocument } from './adapter-fixture.mjs';
import { AdaptiveStore } from '../dist/adaptive-store.js';
import { AdaptiveRetirement } from '../dist/adaptive-retirement.js';
import { mddDataRoot } from '../dist/engram-http.js';
import { LocalFiles } from '../dist/local-files.js';
import { RunOwnershipStore } from '../dist/run-ownership.js';
import { adaptiveTransferRequest } from '../dist/adaptive-transfer.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const wire = (kind, args = {}) => JSON.stringify({ routingVersion: 3, kind, args });
const hash = text => createHash('sha256').update(text).digest('hex');

// The host identities and hooks match the installed V2 2.0.22 transport.
async function fixture(t, mode = 'automatic') {
  isolateHome(t);
  const root = await mkdtemp(join(tmpdir(), 'mdd-public-adaptive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'own.txt'), 'before');
  const settings = defaultSettings();
  settings.profiles.default.answers = mode ? { mode } : {};
  saveGlobalSettings(settings);
  let sessionID = 'ses_parent';
  const tools = new Map(), hooks = new Map(), sessionHooks = new Map();
  const sessions = new Map([[sessionID, { id: sessionID, agent: 'mdd-orchestrator', projectID: 'project',
    location: { directory: root }, time: { created: 1, updated: 1 } }]]);
  const messages = new Map([[sessionID, []]]);
  const agents = ['mdd-orchestrator', 'mdd-explore', 'mdd-risk', 'mdd-plan', 'mdd-propose', 'mdd-spec', 'mdd-design', 'mdd-tasks', 'mdd-apply', 'mdd-verify']
    .map(id => ({ id, permissions: [], request: {} }));
  let wake;
  const queue = [];
  const ctx = { app: { version: '2.0.22' }, location: { directory: root, project: { id: 'project', directory: root, canonical: root } },
    session: { get: async ({ sessionID }) => structuredClone(sessions.get(sessionID)),
      context: async ({ sessionID }) => structuredClone(messages.get(sessionID)),
      hook: async (name, fn) => { sessionHooks.set(name, fn); } },
    agent: { transform: async fn => { fn({ list: () => agents, update: (id, update) => update(agents.find(agent => agent.id === id)) }); return { dispose: async () => {} }; } },
    tool: { transform: async fn => fn({ add: definition => tools.set(definition.name, definition) }),
      hook: async (name, fn) => { hooks.set(name, fn); } },
    event: { subscribe: async function* ({ signal }) {
      let ownWake;
      signal.addEventListener('abort', () => ownWake?.(), { once: true });
      while (!signal.aborted) {
        if (!queue.length) await new Promise(resolve => { ownWake = resolve; wake = resolve; });
        while (queue.length && !signal.aborted) { const item = queue.shift(); yield item.event; item.resolve(); }
      }
    } } };
  let cleanup = await plugin.setup(ctx); t.after(() => cleanup());
  let count = 0, current, userID;
  const user = text => {
    userID = `user-${++count}`;
    messages.get(sessionID).push({ id: userID, type: 'user', text, time: { created: count } });
    current = { id: `assistant-${++count}`, type: 'assistant', agent: 'mdd-orchestrator',
      model: { providerID: 'openai', id: 'test' }, content: [], time: { created: count } };
    messages.get(sessionID).push(current);
    return userID;
  };
  const call = async (name, args = {}, agent = 'mdd-orchestrator') => {
    assert.ok(tools.has(name), `${name} must be registered on the actual V2 host`);
    const result = await tools.get(name).execute(args, { sessionID, agent, messageID: current.id,
      id: `call-${++count}`, signal: new AbortController().signal });
    assert.ok(Buffer.byteLength(result.content) <= 46000, 'public metadata must fit the final host budget');
    return JSON.parse(result.content);
  };
  const send = (kind, args = {}) => call('mdd_adapt', { payload: wire(kind, args) });
  const emit = event => new Promise(resolve => { queue.push({ event, resolve }); wake?.(); });
  const begin = (tool, input) => {
    const id = `native-${++count}`;
    current.content.push({ type: 'tool', id, name: tool, time: { created: count }, state: { status: 'running', input: structuredClone(input), metadata: {} } });
    return { sessionID, agent: 'mdd-orchestrator', messageID: current.id, id, tool, input: structuredClone(input) };
  };
  const answer = async (status, labels = [['Approve operation']]) => {
    const call = begin('question', status.question);
    await hooks.get('execute.before')(call);
    const content = `User has answered your questions: ${status.question.questions.map((q, i) => `"${q.question}"="${labels[i].join(', ')}"`).join(', ')}. You can now continue with the user's answers in mind.`;
    await hooks.get('execute.after')({ ...call, status: 'completed', result: { output: { answers: labels }, content } });
    const part = current.content.find(part => part.id === call.id);
    part.state = { status: 'completed', input: call.input, content: [{ type: 'text', text: content }], metadata: { answers: labels } };
    part.time.completed = ++count;
    return f.call('mdd_status');
  };
  const dispatch = async (status, fields, edit) => {
    const call = begin('subagent', status.task);
    await hooks.get('execute.before')(call);
    const childID = `child-${++count}`, actor = status.task.agent;
    sessions.set(childID, { id: childID, parentID: sessionID, agent: actor, projectID: 'project', location: { directory: root }, time: { created: count, updated: count } });
    messages.set(childID, []);
    await emit({ type: 'session.tool.progress', data: { sessionID, assistantMessageID: call.messageID, id: call.id,
      metadata: { status: 'running', sessionID: childID } } });
    for (const tool of ['shell', 'mcp_external', 'subagent']) await assert.rejects(hooks.get('execute.before')({ sessionID: childID, agent: actor,
      messageID: `child-message-${count}`, id: `denied-${tool}-${count}`, tool, input: {} }), /worker|scope|denied|allow|tool/i);
    if (edit) await tools.get('mdd_worker_edit').execute({ operations: Array.isArray(edit) ? [{ path: 'own.txt', kind: 'edit', oldString: edit[0], newString: edit[1] }] : edit.operations },
      { sessionID: childID, agent: actor, messageID: `child-message-${count}`, id: `edit-${count}`, signal: new AbortController().signal });
    const text = typeof fields === 'string' ? fields : reportDocument({ phase: actor, outcome: 'passed', evidenceSummary: 'Actual scoped actor report.', artifact: 'Read actual held source.', ...fields });
    messages.set(childID, [{ id: `final-${count}`, type: 'assistant', agent: actor, content: [{ type: 'text', text }], time: { created: count, completed: ++count }, finish: 'stop' }]);
    const content = `<subagent sessionID="${childID}" state="completed">\n${text}\n</subagent>`;
    const result = { output: { sessionID: childID, status: 'completed', output: text }, content };
    const event = { ...call, status: 'completed', result };
    await hooks.get('execute.after')(event);
    const part = current.content.find(part => part.id === call.id);
    part.state = { status: 'completed', input: call.input, content: [{ type: 'text', text: event.result.content }], metadata: { sessionID: childID } };
    part.time.completed = ++count;
    return { status: await f.call('mdd_status'), call, result: event.result };
  };
  const contract = (objective = 'Replace only the bounded source.', text = 'before') => {
    const scope = { complete: true, reads: ['own.txt'], writes: ['own.txt'] };
    return { contractVersion: 1, objective,
      acceptance: { goal: 'Replace bounded source', requirements: [{ id: 'R1', description: 'Replacement',
        scenarios: [{ id: 'S1', given: 'Original', when: 'Replaced', then: 'Updated' }] }] },
      exclusions: [], decisions: [], productQuestions: [], scope,
      context: { technical: 'understood', dependencies: 'bounded', reason: 'Inspected source.', fingerprints: [{ path: 'own.txt', digest: hash(text) }] },
      assessment: { assessmentVersion: 1, complexity: 'low', impact: 'low' },
      assignments: [{ id: 'A1', path: 'own.txt', description: 'Replace source', scenarios: ['S1'], decisions: [], dependsOn: [], scope,
        obligations: { source: [{ id: 'E1', description: 'Read actual source', paths: ['own.txt'] }], checks: [] } }] };
  };
  const entry = async draft => { user(draft.objective); return send('entry', { contract: draft, messageID: userID }); };
  const detail = async ref => {
    let text = '', cursor = ref.args.cursor;
    while (cursor) { const page = await send('detail', { cursor }); text += page.text; cursor = page.nextCursor; }
    return JSON.parse(text);
  };
  const select = (status, actor = 'mdd-apply', extra = {}) => send('select', { handle: status.handle, actor, assignmentID: 'A1', purpose: 'Perform only the held next work.', ...extra });
  const evidence = (draft, snapshotID) => ({ snapshotID,
    readback: { acceptance: draft.acceptance, scope: draft.scope, exclusions: [], decisions: [] },
    inventory: [{ path: 'own.txt', disposition: 'assignment', reason: 'Actual assigned replacement.' }], exclusions: [],
    sources: [{ id: 'E1', paths: ['own.txt'], status: 'verified', assessment: 'Read actual final replacement.' }],
    assignments: [{ assignmentID: 'A1', status: 'verified', sources: ['E1'], checks: [], assessment: 'Held replacement exists.' }],
    scenarios: [{ requirementID: 'R1', scenarioID: 'S1', assignmentID: 'A1', status: 'verified', sources: ['E1'], checks: [], assessment: 'Final source satisfies held scenario.' }],
    decisions: [], checks: [], checkResults: [], supplementalChecks: [], limits: [] });
  const switchParent = id => {
    sessionID = id;
    if (!sessions.has(id)) { sessions.set(id, { id, agent: 'mdd-orchestrator', projectID: 'project', location: { directory: root }, time: { created: 1, updated: 1 } }); messages.set(id, []); }
    current = messages.get(id).findLast(message => message.type === 'assistant');
    userID = messages.get(id).findLast(message => message.type === 'user')?.id;
  };
  const f = { root, tools, hooks, sessionHooks, messages, sessions, host: ctx, get sessionID() { return sessionID; }, contract, user, call, send, entry, answer, dispatch, detail, select, evidence, begin, emit, switchParent,
    store: new AdaptiveStore(mddDataRoot(root)), restart: async () => { await cleanup(); cleanup = await plugin.setup(ctx); } };
  return f;
}

test('AL05c public: fresh status advertises the native entry rather than fixed preflight', async t => {
  const f = await fixture(t); f.user('Replace only the bounded source.');
  const status = await f.call('mdd_status');
  assert.equal(status.routingVersion, 3);
  assert.equal(status.registration, 'active');
  assert.equal(status.nextAction.tool, 'mdd_adapt');
  assert.ok(status.operations.some(operation => operation.kind === 'entry'));
  assert.doesNotMatch(JSON.stringify(status), /adaptiveInternal|protocol-internal|future public|registration.*inactive/);
});

for (const depth of ['medium', 'high']) test(`AL05c public: fresh ${depth} runs genuine stages and requires snapshot-bound Verify`, async t => {
  const f = await fixture(t), draft = f.contract(); draft.assessment.complexity = depth;
  let status = await f.entry(draft);
  const item = draft.assignments[0], command = 'node -e "process.exit(0)"';
  const deliverables = [{ id: item.id, description: item.description, path: item.path, scenarios: item.scenarios, decisions: [], dependsOn: [], parallel: item.scope,
    checks: [{ id: 'C1', command, requirement: 'required' }] }];
  const stages = depth === 'medium' ? [['mdd-plan', { acceptance: draft.acceptance, decisions: [], deliverables }]] :
    [['mdd-propose', {}], ['mdd-spec', { domain: 'project', acceptance: draft.acceptance }], ['mdd-design', { decisions: [] }], ['mdd-tasks', { deliverables }]];
  for (const [actor, fields] of stages) {
    assert.equal(status.route, depth); assert.equal(status.continuation.next, actor);
    assert.deepEqual(status.operations.find(operation => operation.kind === 'select').ids.actor, [actor]);
    const selected = await f.select(status, actor); assert.equal(selected.task.agent, actor);
    status = (await f.dispatch(selected, { verificationVersion: 1, ...fields })).status;
    assert.equal(status.lastReceipt.outcome, 'passed');
  }
  status = (await f.dispatch(await f.select(status), { completed: ['A1'], changes: ['own.txt'], checks: [] }, ['before', 'after'])).status;
  await assert.rejects(f.send('close', { handle: status.handle, outcome: 'verified' }), /verified|evidence|Verify/);
  status = await f.send('prepare', { handle: status.handle });
  const shell = f.begin('shell', { command }); await f.hooks.get('execute.before')(shell);
  execFileSync(process.execPath, ['-e', 'process.exit(0)'], { cwd: f.root });
  const evidence = f.evidence(draft, status.evidence.snapshotID);
  evidence.checks = [{ id: 'X1', command, exit: 0 }]; evidence.checkResults = [{ checkID: 'C1', disposition: 'passed', executions: ['X1'] }];
  status = await f.send('submit', { handle: status.handle, evidence });
  const finding = { status: 'verified', checks: ['X1'], assessment: 'Actual held source and parent check reviewed.' };
  const verification = { scenarios: [{ requirementID: 'R1', scenarioID: 'S1', stepID: 'A1', ...finding }], steps: [{ stepID: 'A1', ...finding }], decisions: [],
    changes: 'Held replacement is present.', limits: [], checkResults: evidence.checkResults, supplementalChecks: [] };
  status = (await f.dispatch(await f.select(status, 'mdd-verify'), { verificationVersion: 1, checks: evidence.checks, verification })).status;
  assert.equal(status.lastReceipt.outcome, 'passed');
  assert.equal((await f.send('close', { handle: status.handle, outcome: 'verified' })).state, 'completed');
});

test('AL05c public: multiple retired runs retain consumed native identities and immutable records after restart', async t => {
  const f = await fixture(t), draft = f.contract(), identities = [], runs = [];
  for (let index = 0; index < 3; index++) {
    let status = await f.entry({ ...draft, objective: index === 2 ? 'A different new objective.' : draft.objective });
    identities.push(f.store.read(f.sessionID).userMessageID); runs.push(status.runID);
    await f.send('close', { handle: status.handle, outcome: 'unverified', limits: ['No implementation completed.'] });
    await f.restart();
  }
  const live = f.store.read(f.sessionID), history = live.history;
  assert.deepEqual(history.map(item => item.runID), runs.slice(0, 2));
  const retirement = new AdaptiveRetirement(f.store), first = retirement.read(f.sessionID, runs[0]);
  assert.equal(first.previous.userMessageID, identities[0]);
  f.user(draft.objective);
  await assert.rejects(f.send('entry', { contract: draft, messageID: identities[0] }), /current|turn|identity/);
  const native = f.messages.get(f.sessionID), currentUser = native.findLast(message => message.type === 'user');
  native.splice(native.findIndex(message => message.type === 'user' && message.id === identities[0]), 1);
  currentUser.id = identities[0];
  await assert.rejects(f.send('entry', { contract: draft, messageID: identities[0] }), /consumed/);
  assert.deepEqual(retirement.read(f.sessionID, runs[0]), first);
  assert.equal(f.store.read(f.sessionID).runID, live.runID);
});

for (const fault of ['archive', 'pointer', 'old-owner', 'live-slot', 'parent-binding', 'new-owner']) test(`AL05c public: interrupted retirement ${fault} preserves history and cold-reconciles only exact bootstrap`, async t => {
  const f = await fixture(t), draft = f.contract(); let status = await f.entry(draft);
  await f.send('close', { handle: status.handle, outcome: 'unverified', limits: ['Source remains unchanged.'] });
  const old = f.store.read(f.sessionID), files = LocalFiles.prototype, original = files.updateStrict;
  let injected = false;
  const mock = t.mock.method(files, 'updateStrict', function(name, change, limit) {
    const wrapped = source => {
      const next = change(source), parsed = next === undefined ? undefined : JSON.parse(next);
      const hit = fault === 'archive' && name.includes('adaptive-archive-') || fault === 'pointer' && name.includes('adaptive-retirement-') ||
        fault === 'old-owner' && parsed?.operation?.name === 'adaptive-retirement' ||
        fault === 'live-slot' && parsed?.runID !== old.runID && parsed?.stage === 'bootstrap' ||
        fault === 'parent-binding' && name.includes('parent-owner-') && parsed?.runID !== old.runID ||
        fault === 'new-owner' && name.includes('/owner-') && parsed?.runID !== old.runID;
      if (hit && !injected) { injected = true; throw new Error(`Injected ${fault} before publication.`); }
      return next;
    };
    return original.call(this, name, wrapped, limit);
  });
  await assert.rejects(f.entry(draft)); assert.equal(injected, true);
  mock.mock.restore();
  const current = f.store.read(f.sessionID);
  assert.ok(current.runID === old.runID || current.stage === 'bootstrap');
  if (fault === 'archive') {
    assert.equal(new AdaptiveRetirement(f.store).read(f.sessionID, old.runID), undefined);
    assert.equal(current.runID, old.runID);
    return;
  }
  await f.restart(); status = await f.call('mdd_status');
  assert.equal(status.state, 'await-selection', status.reason);
  assert.notEqual(status.runID, old.runID);
  const archived = new AdaptiveRetirement(f.store).read(f.sessionID, old.runID);
  assert.equal(archived.previous.data.state, 'closed-unverified');
  assert.equal(archived.next.runID, status.runID);
  assert.equal(new RunOwnershipStore(mddDataRoot(f.root)).read(old.runID).operation.name, 'adaptive-retirement');
});

test('AL05c public: target native proof transfers active data while former owner cannot take a fresh slot', async t => {
  const f = await fixture(t), status = await f.entry(f.contract()), source = f.store.read(f.sessionID), sourceID = f.sessionID;
  await f.emit({ type: 'session.status', data: { sessionID: sourceID, status: { type: 'idle' } } });
  f.switchParent('target'); const userID = f.user(adaptiveTransferRequest(source));
  const moved = await f.send('transfer', { sourceSessionID: sourceID, runID: status.runID, operationID: 'public-hop', messageID: userID });
  assert.equal(moved.runID, source.runID); assert.equal(moved.state, 'await-selection');
  f.switchParent(sourceID);
  await assert.rejects(f.entry(f.contract('Different source request.')), /moved|transfer|stale|fenced|owner/);
  assert.equal(f.store.read('target').runID, source.runID);
});

for (const explore of [false, true]) test(`AL05c public: ${explore ? 'Explore then Apply' : 'Apply only'} closes verified without Plan or Verify`, async t => {
  const f = await fixture(t), draft = f.contract();
  let status = await f.entry(draft);
  if (explore) {
    status = await f.select(status, 'mdd-explore');
    const settled = await f.dispatch(status, {}); status = settled.status;
    assert.equal(status.lastReceipt.outcome, 'passed');
  }
  status = await f.select(status);
  assert.equal(status.task.agent, 'mdd-apply');
  assert.equal(status.next.native, 'subagent');
  const settled = await f.dispatch(status, { completed: ['A1'], changes: ['own.txt'], checks: [] }, ['before', 'after']);
  assert.match(settled.call.input.prompt, /Packaged MDD actor instructions with provenance/);
  assert.equal(settled.status.lastReceipt.outcome, 'passed');
  assert.equal(JSON.parse(settled.result.content).lane, 'adaptive-native');
  status = await f.send('prepare', { handle: settled.status.handle });
  status = await f.send('submit', { handle: status.handle, evidence: f.evidence(draft, status.evidence.snapshotID) });
  assert.equal(status.evidence.matched, true);
  status = await f.send('close', { handle: status.handle, outcome: 'verified' });
  assert.equal(status.state, 'completed');
  const prior = f.store.read(f.sessionID);
  await f.restart();
  status = await f.entry(f.contract('Perform a different bounded objective.', 'after'));
  assert.notEqual(status.runID, prior.runID);
  const archived = new AdaptiveRetirement(f.store).read(f.sessionID, prior.runID);
  assert.equal(archived.previous.data.state, 'completed');
  assert.equal(archived.previous.data.receipts.at(-1).actor, 'mdd-apply');
  assert.equal(archived.previous.data.report.sources[0].status, 'verified');
});

for (const mode of ['interactive', undefined]) test(`AL05c public: native-only ${mode ?? 'unset'} approval preserves preferences`, async t => {
  const f = await fixture(t, mode ?? null), draft = f.contract();
  let status = await f.entry(draft);
  assert.ok(status.question);
  if (!mode) {
    assert.equal(status.question.questions.length, 1);
    assert.equal(status.question.questions[0].header, 'Modo');
    const label = status.question.questions[0].options.find(option => /utom.tico/.test(option.label)).label;
    status = await f.answer(status, [[label]]);
    assert.equal(status.mode, 'automatic');
  } else {
    assert.equal(f.store.read(f.sessionID), undefined);
    status = await f.answer(status);
    assert.equal(status.mode, mode);
    const selected = await f.select(status);
    assert.ok(selected.question);
    status = await f.answer(selected, [['Pause']]);
    assert.equal(status.task, undefined);
    assert.equal(f.store.read(f.sessionID).data.receipts.length, 0);
  }
  assert.equal(f.store.read(f.sessionID).nativePolicy.answers.mode, mode ?? 'automatic');
});

test('AL05c public: current user identity is distinct from the assistant tool message', async t => {
  const f = await fixture(t), draft = f.contract();
  const userID = f.user(draft.objective);
  const status = await f.send('entry', { contract: draft, messageID: userID });
  assert.equal(status.state, 'await-selection');
  assert.equal(status.route, 'low');
  assert.equal(status.mode, 'automatic');
  assert.equal(status.question, undefined);
  assert.ok(status.handle);
});

test('AL05c public: an earlier objective is never admitted on an unrelated current turn without fresh native confirmation', async t => {
  for (const [label, admitted] of [['Decline', false], ['Pause', false], ['Approve operation', true]]) {
    const f = await fixture(t), draft = f.contract(), oldID = f.user(draft.objective);
    const currentID = f.user('A different current objective.');
    // A supplied identity is only an assertion: the current turn is not the message carrying the objective.
    await assert.rejects(f.send('entry', { contract: draft, messageID: currentID }), /current|identity/i);
    let status = await f.send('entry', { contract: draft });
    assert.equal(status.state, 'question-ready');
    assert.equal(status.question.questions[0].header, 'Pedido anterior');
    assert.match(status.question.questions[0].question, /Replace only the bounded source\./);
    assert.equal(f.store.read(f.sessionID), undefined, 'nothing is admitted before the native answer');
    status = await f.answer(status, [[label]]);
    if (!admitted) {
      assert.equal(f.store.read(f.sessionID), undefined, `${label} admits nothing`);
      continue;
    }
    assert.equal(status.state, 'await-selection');
    assert.equal(f.store.read(f.sessionID).userMessageID, oldID, 'the run binds the message that carries the objective');
    assert.deepEqual(f.store.read(f.sessionID).nativePolicy.questions.map(item => item.adaptive.purpose), ['operation']);
  }
});

test('regression: entry needs only the contract; the host binds the current user turn and fills observable defaults', async t => {
  const f = await fixture(t), full = f.contract(), userID = f.user(full.objective);
  const { exclusions, decisions, productQuestions, ...draft } = structuredClone(full);
  delete draft.context.fingerprints;
  for (const assignment of draft.assignments) { delete assignment.decisions; delete assignment.dependsOn; delete assignment.obligations.checks; }
  const status = await f.send('entry', { contract: draft });
  assert.equal(status.state, 'await-selection', status.reason);
  assert.equal(status.question, undefined, 'the current turn needs no extra confirmation');
  const saved = f.store.read(f.sessionID);
  assert.equal(saved.userMessageID, userID);
  assert.deepEqual(saved.data.contract.context.fingerprints, full.context.fingerprints, 'the host recorded the same bytes the coordinator would have');
  assert.deepEqual([saved.data.contract.exclusions, saved.data.contract.decisions, saved.data.contract.productQuestions], [[], [], []]);
  assert.deepEqual(saved.data.contract.assignments[0].obligations.checks, []);
});

test('regression: a declared external scenario closes verified as pending, never as a gap, and survives restart', async t => {
  const f = await fixture(t), draft = f.contract();
  draft.acceptance.requirements[0].scenarios[0].evidence = 'external';
  let status = await f.entry(draft);
  const settled = await f.dispatch(await f.select(status), { completed: ['A1'], changes: ['own.txt'], checks: [] }, ['before', 'after']);
  status = await f.send('prepare', { handle: settled.status.handle });
  const evidence = f.evidence(draft, status.evidence.snapshotID);
  evidence.scenarios[0] = { ...evidence.scenarios[0], status: 'external', sources: [], checks: [], assessment: 'Open the studio on staging and confirm the replaced text renders.' };
  status = await f.send('submit', { handle: status.handle, evidence });
  assert.equal(status.evidence.matched, true);
  assert.deepEqual(status.evidence.gaps.scenarios, []);
  assert.equal(status.evidence.gaps.externalPending[0].scenarioID, 'S1');
  await f.restart();
  status = await f.call('mdd_status');
  assert.equal(status.evidence.matched, true, 'restore revalidates the external row');
  status = await f.send('close', { handle: status.handle, outcome: 'verified' });
  assert.equal(status.state, 'completed');
  // A scenario the contract did not declare external cannot be reported as pending.
  const g = await fixture(t), local = g.contract();
  status = await g.entry(local);
  const done = await g.dispatch(await g.select(status), { completed: ['A1'], changes: ['own.txt'], checks: [] }, ['before', 'after']);
  status = await g.send('prepare', { handle: done.status.handle });
  const forged = g.evidence(local, status.evidence.snapshotID);
  forged.scenarios[0] = { ...forged.scenarios[0], status: 'external', sources: [], checks: [] };
  await assert.rejects(g.send('submit', { handle: status.handle, evidence: forged }), /not declared external/);
});

test('regression: a parent check failing for a reason outside the change is environmental and still closes verified', async t => {
  const f = await fixture(t), draft = f.contract();
  draft.assignments[0].obligations.checks = [{ id: 'C1', command: 'npm test', requirement: 'required' }];
  let status = await f.entry(draft);
  const settled = await f.dispatch(await f.select(status), { completed: ['A1'], changes: ['own.txt'], checks: [] }, ['before', 'after']);
  status = await f.send('prepare', { handle: settled.status.handle });
  const evidence = f.evidence(draft, status.evidence.snapshotID);
  evidence.checks = [{ id: 'X1', command: 'npm test', exit: 1 }, { id: 'X2', command: 'node --test tests/own.test.mjs', exit: 0 }];
  evidence.checkResults = [{ checkID: 'C1', disposition: 'environmental', executions: ['X1', 'X2'],
    reason: 'Only tests/pack.test.mjs failed (npm pack timeout under load); the suites covering own.txt passed alone in X2.' }];
  for (const row of [...evidence.assignments, ...evidence.scenarios]) row.checks = ['X2'];
  status = await f.send('submit', { handle: status.handle, evidence });
  assert.equal(status.evidence.matched, true);
  assert.equal((await f.send('close', { handle: status.handle, outcome: 'verified' })).state, 'completed');
});

test('regression: omitted assignment decisions are linked to every applicable decision at entry', async t => {
  const f = await fixture(t), draft = f.contract(); f.user(draft.objective);
  draft.decisions = [{ id: 'D1', description: 'Replace the whole source file.', requirements: ['R1'] }];
  delete draft.assignments[0].decisions;
  const status = await f.send('entry', { contract: draft });
  assert.equal(status.state, 'await-selection', status.reason);
  assert.deepEqual(f.store.read(f.sessionID).data.contract.assignments[0].decisions, ['D1']);
  // A supplied link that does not apply is refused with how to avoid it.
  const g = await fixture(t), wrong = g.contract(); g.user(wrong.objective);
  wrong.acceptance.requirements.push({ id: 'R2', description: 'Other', scenarios: [{ id: 'S2', given: 'A', when: 'B', then: 'C' }] });
  wrong.decisions = [{ id: 'D1', description: 'Replace the whole source file.', requirements: ['R1'] }, { id: 'D2', description: 'Other rule.', requirements: ['R2'] }];
  wrong.assignments[0].decisions = ['D2'];
  await assert.rejects(g.send('entry', { contract: wrong }), /Assignment A1 decision D2 is not applicable to its scenarios\. Omit assignment decisions/);
});

test('regression: a fresh status carries the entry guide and a refused entry says what to correct', async t => {
  const f = await fixture(t), draft = f.contract(); f.user(draft.objective);
  const status = await f.call('mdd_status');
  assert.ok(status.entryGuide, 'entry is offered with its compact guide');
  assert.match(status.entryGuide.messageID, /Optional/);
  assert.equal(status.entryGuide.example.contractVersion, 1);
  assert.doesNotMatch(status.nextAction.why, /call mdd_start once/);
  await assert.rejects(f.send('entry', {}), /requires contract/);
  const outside = structuredClone(draft); delete outside.context.fingerprints;
  outside.scope = { complete: true, reads: ['own.txt'], writes: ['own.txt', 'package.json'] };
  outside.assignments[0].scope = structuredClone(outside.scope);
  await assert.rejects(f.send('entry', { contract: outside }), /Apply scope has unproven paths or implicit runtime\/instruction effects: the write package\.json/);
});

test('regression: a real global OpenCode configuration with multi-line prompts admits adaptive work', async t => {
  const f = await fixture(t), draft = f.contract();
  const dir = join(homedir(), '.config', 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, 'opencode.json'), JSON.stringify({ agent: {
    'gentle-orchestrator': { prompt: '# Orchestrator\n\nWork inline by default.\nDelegate only for a named reason.' },
    gentleman: { mode: 'primary', prompt: '{file:./AGENTS.md}' } }, plugins: ['opencode-gemini-auth@latest'] }));
  // The explicit identity isolates this regression to the configuration guard alone.
  const userID = f.user(draft.objective);
  const status = await f.send('entry', { contract: draft, messageID: userID });
  assert.equal(status.state, 'await-selection', status.reason);
  const selected = await f.select(status);
  assert.equal(selected.task.agent, 'mdd-apply');
});

test('AL05c public: coordinator isolation and authority-bearing payload fields fail closed', async t => {
  const f = await fixture(t); f.user('Replace only the bounded source.');
  await assert.rejects(f.call('mdd_adapt', { payload: wire('status') }, 'mdd-apply'), /coordinator|belongs/i);
  for (const field of ['runtime', 'profile', 'approved', 'stopped']) {
    const payload = JSON.stringify({ routingVersion: 3, kind: 'status', args: {}, [field]: true });
    await assert.rejects(f.call('mdd_adapt', { payload }), /unknown|unsupported|unexpected/i);
  }
});

for (const restart of [false, true]) test(`AL05c public: closed-unverified permits fresh same-parent work (restart=${restart})`, async t => {
  const f = await fixture(t), draft = f.contract();
  let status = await f.entry(draft);
  const oldRun = status.runID;
  status = await f.send('close', { handle: status.handle, outcome: 'unverified', limits: ['Implementation remains undone.'] });
  assert.equal(status.state, 'closed-unverified');
  if (restart) await f.restart();
  status = await f.entry(draft);
  assert.equal(status.state, 'await-selection');
  assert.notEqual(status.runID, oldRun);
  assert.equal(status.route, 'low');
});

test('AL05c public: malformed payload cannot mutate cold state before decoding', async t => {
  const f = await fixture(t); await f.entry(f.contract()); await f.restart();
  const before = f.store.read(f.sessionID);
  await assert.rejects(f.call('mdd_adapt', { payload: '{"routingVersion":3,"kind":"status","args":{},"approved":true}' }));
  assert.deepEqual(f.store.read(f.sessionID), before);
});

test('AL05c public: actor questions, failed receipt repair and stale source evidence remain fenced', async t => {
  const f = await fixture(t), draft = f.contract(); let status = await f.entry(draft);
  status = (await f.dispatch(await f.select(status), { outcome: 'failed', completed: [], changes: [], noChangeReason: 'A product decision remains.', checks: [],
    questions: [{ question: 'Which held presentation?', why: 'The implementation needs this choice.', options: [{ label: 'Use existing', description: 'Retain the current presentation.' }] }] })).status;
  assert.equal(status.lastReceipt.outcome, 'failed');
  assert.equal(status.operations.find(operation => operation.kind === 'questions').ids.receiptID, status.lastReceipt.id);
  const failed = status.lastReceipt.id;
  await assert.rejects(f.select(status), /question|repair/);
  status = await f.send('questions', { receiptID: status.lastReceipt.id, callID: status.lastReceipt.callID });
  status = await f.answer(status, [['Use existing']]);
  const held = await f.detail(status.details.held);
  assert.equal(held.data.questionAnswers.length, 1);
  await assert.rejects(f.select(status, 'mdd-apply', { repairOf: 'invented-receipt' }), /repair|receipt/i);
  status = (await f.dispatch(await f.select(status, 'mdd-apply', { repairOf: failed }), { completed: ['A1'], changes: ['own.txt'], checks: [] }, ['before', 'after'])).status;
  status = await f.send('prepare', { handle: status.handle });
  const snapshotID = status.evidence.snapshotID;
  await writeFile(join(f.root, 'own.txt'), 'external');
  await assert.rejects(f.send('submit', { handle: status.handle, evidence: f.evidence(draft, snapshotID) }), /source|snapshot|changed|current|stale/i);
  assert.equal(f.store.read(f.sessionID).data.completion, undefined);
});

test('AL05c public: cold stopped recovery requires actual native child state and never redispatches it', async t => {
  const f = await fixture(t); let status = await f.entry(f.contract()); status = await f.select(status);
  const call = f.begin('subagent', status.task); await f.hooks.get('execute.before')(call);
  const childID = 'interrupted-child';
  f.sessions.set(childID, { id: childID, parentID: f.sessionID, agent: 'mdd-apply', projectID: 'project', location: { directory: f.root }, time: { created: Date.now(), updated: Date.now() } });
  f.messages.set(childID, []);
  const part = f.messages.get(f.sessionID).at(-1).content.find(part => part.id === call.id);
  part.state.input = call.input; part.state.metadata = { sessionID: childID };
  await f.restart(); status = await f.call('mdd_status');
  assert.equal(status.task, undefined);
  status = await f.send('recover'); assert.equal(status.state, 'await-result');
  part.state.status = 'error';
  f.messages.set(childID, [{ id: 'stopped-final', type: 'assistant', agent: 'mdd-apply', content: [{ type: 'text', text: 'Stopped with partial work.' }],
    finish: 'stop', time: { created: Date.now(), completed: Date.now() } }]);
  await f.emit({ type: 'session.status', data: { sessionID: childID, status: { type: 'idle' } } });
  status = await f.send('recover');
  assert.equal(status.state, 'await-selection'); assert.equal(status.lastReceipt.callID, call.id); assert.equal(status.lastReceipt.outcome, 'failed');
  assert.equal(status.task, undefined);
});

for (const stage of ['archive', 'pointer', 'old-owner', 'live-slot', 'parent-binding', 'new-owner']) test(`AL05c public: ambiguous post-rename ${stage} finishes only the preserved cold candidate`, async t => {
  const f = await fixture(t), draft = f.contract(); let status = await f.entry(draft);
  await f.send('close', { handle: status.handle, outcome: 'unverified', limits: ['No implementation completed.'] });
  const previous = f.store.read(f.sessionID), original = LocalFiles.prototype.updateStrict;
  let injected = false;
  const mock = t.mock.method(LocalFiles.prototype, 'updateStrict', function(name, change, limit) {
    let hit = false;
    const returned = original.call(this, name, source => {
      const next = change(source), parsed = next && JSON.parse(next);
      hit = stage === 'archive' && name.includes('adaptive-archive-') || stage === 'pointer' && name.includes('adaptive-retirement-') ||
        stage === 'old-owner' && parsed?.operation?.name === 'adaptive-retirement' || stage === 'live-slot' && parsed?.stage === 'bootstrap' && parsed.runID !== previous.runID ||
        stage === 'parent-binding' && name.includes('parent-owner-') && parsed?.runID !== previous.runID ||
        stage === 'new-owner' && name.includes('/owner-') && parsed?.runID !== previous.runID;
      return next;
    }, limit);
    if (hit && !injected) { injected = true; throw new Error('Injected ambiguous unlock after rename.'); }
    return returned;
  });
  await assert.rejects(f.entry(draft)); assert.equal(injected, true); mock.mock.restore();
  const archive = new AdaptiveRetirement(f.store).read(f.sessionID, previous.runID);
  assert.ok(archive);
  await f.restart(); status = await f.call('mdd_status');
  assert.equal(status.state, 'await-selection', status.reason); assert.equal(status.runID, archive.next.runID);
  assert.deepEqual(new AdaptiveRetirement(f.store).read(f.sessionID, previous.runID), archive);
});

test('AL05c public: corrupt archive readback stays fenced and cannot lose the live terminal record', async t => {
  const f = await fixture(t), draft = f.contract(); let status = await f.entry(draft);
  await f.send('close', { handle: status.handle, outcome: 'unverified', limits: ['No implementation completed.'] });
  const previous = f.store.read(f.sessionID), original = LocalFiles.prototype.readStrict;
  const mock = t.mock.method(LocalFiles.prototype, 'readStrict', function(name, limit) {
    const source = original.call(this, name, limit);
    if (source && name.includes('adaptive-archive-')) return source.replace('No implementation completed.', 'Corrupt archive evidence.');
    return source;
  });
  await assert.rejects(f.entry(draft));
  assert.equal(f.store.read(f.sessionID).runID, previous.runID);
  mock.mock.restore(); await f.restart();
  status = await f.call('mdd_status'); assert.equal(status.state, 'await-selection', status.reason);
  assert.equal(new AdaptiveRetirement(f.store).read(f.sessionID, previous.runID).previous.data.completion.limits[0], 'No implementation completed.');
});

test('AL05c public: independent plugin instances race one closed parent without two new owners', async t => {
  const f = await fixture(t), draft = f.contract(); let status = await f.entry(draft);
  await f.send('close', { handle: status.handle, outcome: 'unverified', limits: ['No implementation completed.'] });
  const previous = f.store.read(f.sessionID), first = f.tools.get('mdd_adapt');
  const cleanup = await plugin.setup(f.host); t.after(cleanup);
  const second = f.tools.get('mdd_adapt'), userID = f.user(draft.objective), messageID = f.messages.get(f.sessionID).at(-1).id;
  const args = { payload: wire('entry', { contract: draft, messageID: userID }) };
  const context = { sessionID: f.sessionID, agent: 'mdd-orchestrator', messageID, id: 'racing-entry', signal: new AbortController().signal };
  const results = await Promise.allSettled([first.execute(args, context), second.execute(args, { ...context, id: 'racing-second' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const current = f.store.read(f.sessionID), archive = new AdaptiveRetirement(f.store).read(f.sessionID, previous.runID);
  assert.equal(archive.next.runID, current.runID);
  assert.equal(new RunOwnershipStore(mddDataRoot(f.root)).parent(f.sessionID), current.runID);
});

test('AL05c public: registered detail/status keep complete bounded selectors and stale cursors fail closed', async t => {
  const f = await fixture(t), draft = f.contract(), original = draft.assignments[0];
  draft.acceptance.requirements[0].scenarios = Array.from({ length: 32 }, (_, index) => ({ id: `S${index + 1}`, given: 'Original source', when: 'Held replacement', then: 'Bounded expected source' }));
  draft.assignments = Array.from({ length: 32 }, (_, index) => ({ ...structuredClone(original), id: `A${index + 1}`, scenarios: [`S${index + 1}`],
    obligations: { source: [{ id: `E${index + 1}`, description: 'Read exact final declared bytes.', paths: ['own.txt'] }], checks: [] } }));
  const status = await f.entry(draft), selection = status.operations.find(operation => operation.kind === 'select');
  assert.equal(selection.ids.assignmentID.length, 32);
  const inputs = await f.detail(selection.inputRef);
  assert.equal(inputs.bindings.assignments.length, 32); assert.equal(inputs.bindings.scenarios.length, 32);
  const cursor = selection.inputRef.args.cursor;
  const current = await f.select(status, 'mdd-explore');
  await assert.rejects(f.send('detail', { cursor }), /stale|cursor/);
  assert.equal(current.task.agent, 'mdd-explore');
});

test('AL05c public: cold transfer recovery uses the exact current public hop and fresh target-native request', async t => {
  const f = await fixture(t), started = await f.entry(f.contract()), sourceID = f.sessionID, source = f.store.read(sourceID);
  await f.emit({ type: 'session.status', data: { sessionID: sourceID, status: { type: 'idle' } } });
  f.switchParent('target'); let userID = f.user(adaptiveTransferRequest(source));
  const original = RunOwnershipStore.prototype.finishAdaptiveTransfer;
  let failed = false;
  const mock = t.mock.method(RunOwnershipStore.prototype, 'finishAdaptiveTransfer', function(...args) {
    if (!failed) { failed = true; throw new Error('Interrupted public ownership finish.'); }
    return original.apply(this, args);
  });
  await assert.rejects(f.send('transfer', { sourceSessionID: sourceID, runID: started.runID, operationID: 'current-hop', messageID: userID }));
  const oldControl = { type: 'tool', id: 'old-public-transfer', name: 'mdd_adapt', time: { created: Date.now() },
    state: { status: 'running', input: { payload: wire('transfer', { sourceSessionID: sourceID, runID: started.runID, operationID: 'current-hop', messageID: userID }) }, metadata: {} } };
  f.messages.get(f.sessionID).at(-1).content.push(oldControl);
  mock.mock.restore(); await f.restart();
  await f.emit({ type: 'session.status', data: { sessionID: sourceID, status: { type: 'idle' } } });
  const request = `Recover adaptive transfer sourceSessionID=${sourceID} runID=${started.runID} operationID=current-hop action=finish. The transfer stopped; reconcile only this operation.`;
  userID = f.user(request);
  await assert.rejects(f.send('transfer-recovery', { sourceSessionID: sourceID, runID: started.runID, operationID: 'old-hop', action: 'finish', messageID: userID }));
  await assert.rejects(f.send('transfer-recovery', { sourceSessionID: sourceID, runID: started.runID, operationID: 'current-hop', action: 'finish', messageID: userID }), /running|unsettled|control|unknown/i);
  oldControl.state.status = 'error';
  const recovered = await f.send('transfer-recovery', { sourceSessionID: sourceID, runID: started.runID, operationID: 'current-hop', action: 'finish', messageID: userID });
  assert.equal(recovered.runID, started.runID); assert.equal(recovered.state, 'await-selection');
  assert.equal(new RunOwnershipStore(mddDataRoot(f.root)).read(started.runID).adaptiveReceipt.operationID, 'current-hop');
});

test('AL05c public: escalation is public but never authorizes arbitrary high actors', async t => {
  const f = await fixture(t), draft = f.contract(); let status = await f.entry(draft);
  status = await f.send('escalate', { handle: status.handle, depth: 'high', rationale: 'Inspected impact requires deeper structured work.',
    assessment: { assessmentVersion: 1, complexity: 'low', impact: 'high' }, context: draft.context });
  assert.equal(status.route, 'high'); assert.equal(status.continuation.next, 'mdd-propose');
  await assert.rejects(f.select(status, 'mdd-tasks'), /next|actor|stage|frozen/i);
  assert.equal((await f.select(status, 'mdd-propose')).task.agent, 'mdd-propose');
});

test('AL05c public: interactive terminal replacement asks fresh native approval and never copies old consent', async t => {
  const f = await fixture(t, 'interactive'), draft = f.contract();
  let status = await f.answer(await f.entry(draft));
  status = await f.answer(await f.send('close', { handle: status.handle, outcome: 'unverified', limits: ['No implementation completed.'] }));
  const old = f.store.read(f.sessionID);
  status = await f.entry(draft); assert.ok(status.question);
  assert.equal(f.store.read(f.sessionID).runID, old.runID, 'New approval is required before any terminal archival replacement.');
  status = await f.answer(status);
  assert.notEqual(status.runID, old.runID);
  const next = f.store.read(f.sessionID);
  assert.equal(next.nativePolicy.questions.length, 1);
  assert.ok(next.nativePolicy.questions.every(question => !old.nativePolicy.questions.some(prior => prior.callID === question.callID)));
});

for (const drift of ['native-turn', 'source', 'native-control']) test(`AL05c public: automatic admission rechecks ${drift} after native awaits with zero question history`, async t => {
  const f = await fixture(t), draft = f.contract(), original = f.host.session.context;
  let reads = 0;
  t.mock.method(f.host.session, 'context', async input => {
    const snapshot = await original(input);
    if (++reads === 2) {
      if (drift === 'native-turn') f.messages.get(f.sessionID).findLast(message => message.type === 'user').text = 'A substituted native objective.';
      else if (drift === 'source') await writeFile(join(f.root, 'own.txt'), 'changed during native inspection');
      else f.messages.get(f.sessionID).at(-1).content.push({ type: 'tool', id: 'concurrent-native-task', name: 'subagent', time: { created: Date.now() },
        state: { status: 'running', input: { agent: 'general', description: 'Concurrent work', prompt: 'Unsettled native control.' }, metadata: {} } });
    }
    return snapshot;
  });
  await assert.rejects(f.entry(draft), /native|source|changed|current|match|differ/i);
  assert.ok(reads >= 2); assert.equal(f.store.read(f.sessionID), undefined);
});

test('AL05c public: native assistant actor is independently checked rather than trusted from tool arguments', async t => {
  const f = await fixture(t), draft = f.contract(), userID = f.user(draft.objective);
  f.messages.get(f.sessionID).at(-1).agent = 'general';
  await assert.rejects(f.send('entry', { contract: draft, messageID: userID }), /caller|coordinator|native/i);
  assert.equal(f.store.read(f.sessionID), undefined);
});

test('AL05c public: an uncorrelated reserved owner cannot be cleared by terminal fresh intake', async t => {
  const f = await fixture(t), draft = f.contract(); let status = await f.entry(draft);
  await f.send('close', { handle: status.handle, outcome: 'unverified', limits: ['No implementation completed.'] });
  const old = f.store.read(f.sessionID), ownership = new RunOwnershipStore(mddDataRoot(f.root)), owner = ownership.read(old.runID);
  ownership.reserve(old.runID, f.sessionID, 'unsettled-native-control', owner.epoch);
  await assert.rejects(f.entry(draft), /owner|fenced|restore|idle|authority/i);
  assert.deepEqual(f.store.read(f.sessionID), old);
  assert.equal(new AdaptiveRetirement(f.store).read(f.sessionID, old.runID), undefined);
  assert.equal(ownership.read(old.runID).state, 'reserved');
});

test('AL05c public: prior archive indexes survive transfer and terminal replacement in the target parent', async t => {
  const f = await fixture(t), draft = f.contract(); let status = await f.entry(draft);
  await f.send('close', { handle: status.handle, outcome: 'unverified', limits: ['No implementation completed.'] });
  const first = f.store.read(f.sessionID);
  await f.entry(draft); const sourceID = f.sessionID, source = f.store.read(sourceID);
  await f.emit({ type: 'session.status', data: { sessionID: sourceID, status: { type: 'idle' } } });
  f.switchParent('target'); const userID = f.user(adaptiveTransferRequest(source));
  status = await f.send('transfer', { sourceSessionID: sourceID, runID: source.runID, operationID: 'history-hop', messageID: userID });
  assert.equal(status.state, 'await-selection');
  const transferred = f.store.read(f.sessionID);
  await f.send('close', { handle: status.handle, outcome: 'unverified', limits: ['Transferred work remains unimplemented.'] });
  await f.restart(); status = await f.entry(draft);
  assert.notEqual(status.runID, source.runID);
  const archive = new AdaptiveRetirement(f.store).read('target', source.runID);
  assert.deepEqual(archive.previous.transfer, transferred.transfer);
  assert.equal(new AdaptiveRetirement(f.store).read(sourceID, first.runID).previous.digest, first.digest);
});

test('AL05c public: native Decline authorizes no actor and never overrides interactive mode', async t => {
  const f = await fixture(t, 'interactive');
  let status = await f.answer(await f.entry(f.contract()));
  status = await f.answer(await f.select(status), [['Decline']]);
  assert.equal(status.task, undefined); assert.equal(status.mode, 'interactive');
  assert.equal(f.store.read(f.sessionID).data.receipts.length, 0);
});

// Question session (mdd-grill) regressions. The session is the coordinator's own native questions
// asked before the first entry, so these prove that, on the actual V2 hooks, those questions never
// lock the parent, never become consent and leave every later admission, actor and Verify step to
// behave exactly as it does without them. They check runtime boundaries, not model compliance.
let grillCount = 0;
const grillQuestion = (labels, header = 'Sesión de preguntas') => {
  const round = ++grillCount;
  return { questions: labels.map((_, index) => ({ header, question: `Ronda ${round}, pregunta ${index + 1}: ¿qué decidimos?`, multiple: false,
    options: [{ label: 'Opción A (Recomendada)', description: 'La opción recomendada.' }, { label: 'Opción B', description: 'La alternativa.' }] })) };
};
async function ownQuestion(f, labels, input = grillQuestion(labels)) {
  const call = f.begin('question', input);
  const part = f.messages.get(f.sessionID).flatMap(message => message.content ?? []).find(item => item.id === call.id);
  try { await f.hooks.get('execute.before')(call); }
  catch (error) { part.state = { status: 'error', input: call.input, error: String(error), metadata: {} }; throw error; }
  const content = `User has answered your questions: ${input.questions.map((q, i) => `"${q.question}"="${labels[i].join(', ')}"`).join(', ')}. You can now continue with the user's answers in mind.`;
  await f.hooks.get('execute.after')({ ...call, status: 'completed', result: { output: { answers: labels }, content } });
  part.state = { status: 'completed', input: call.input, content: [{ type: 'text', text: content }], metadata: { answers: labels } };
  part.time.completed = part.time.created + 1;
  return call;
}
const offer = [['Sesión de preguntas (Recomendada)']];
const round = [['Opción A (Recomendada)'], ['Opción B']];
const confirm = [['Confirmar y seguir']];
function grilledDraft(f, objective = 'Replace only the bounded source.', text = 'before') {
  const draft = f.contract(objective, text);
  draft.assessment = { assessmentVersion: 1, complexity: 'high', impact: 'high' };
  draft.decisions = [{ id: 'D1', description: 'Settled in the question session: replace the bounded source wholesale.', requirements: ['R1'] }];
  draft.exclusions = ['No change outside the bounded source.'];
  draft.assignments[0].decisions = ['D1'];
  return draft;
}

test('grill: a complete session before entry leaves the high route, Apply and Verify unblocked', async t => {
  const f = await fixture(t), draft = grilledDraft(f), userID = f.user(draft.objective);
  await f.call('mdd_status');
  for (const labels of [offer, round, round, round, confirm]) await ownQuestion(f, labels);
  let status = await f.send('entry', { contract: draft, messageID: userID });
  assert.equal(status.state, 'await-selection'); assert.equal(status.route, 'high');
  assert.equal(status.question, undefined, 'session answers are not an MDD question still waiting');
  assert.equal(f.store.read(f.sessionID).nativePolicy.questions.length, 0, 'session answers are never recorded as MDD consent');
  assert.deepEqual(f.store.read(f.sessionID).data.contract.decisions, draft.decisions);
  assert.deepEqual(f.store.read(f.sessionID).data.contract.exclusions, draft.exclusions);
  const item = draft.assignments[0], command = 'node -e "process.exit(0)"';
  const deliverables = [{ id: item.id, description: item.description, path: item.path, scenarios: item.scenarios, decisions: ['D1'], dependsOn: [], parallel: item.scope,
    checks: [{ id: 'C1', command, requirement: 'required' }] }];
  for (const [actor, fields] of [['mdd-propose', {}], ['mdd-spec', { domain: 'project', acceptance: draft.acceptance }],
    ['mdd-design', { decisions: draft.decisions }], ['mdd-tasks', { deliverables }]]) {
    assert.equal(status.continuation.next, actor);
    status = (await f.dispatch(await f.select(status, actor), { verificationVersion: 1, ...fields })).status;
    assert.equal(status.lastReceipt.outcome, 'passed', actor);
  }
  status = (await f.dispatch(await f.select(status), { completed: ['A1'], changes: ['own.txt'], checks: [] }, ['before', 'after'])).status;
  status = await f.send('prepare', { handle: status.handle });
  const shell = f.begin('shell', { command }); await f.hooks.get('execute.before')(shell);
  execFileSync(process.execPath, ['-e', 'process.exit(0)'], { cwd: f.root });
  const evidence = f.evidence(draft, status.evidence.snapshotID);
  evidence.readback = { acceptance: draft.acceptance, scope: draft.scope, exclusions: draft.exclusions, decisions: draft.decisions };
  evidence.exclusions = [{ exclusion: draft.exclusions[0], status: 'verified', assessment: 'Only the bounded source changed.' }];
  evidence.decisions = [{ decisionID: 'D1', status: 'verified', sources: ['E1'], checks: [], assessment: 'The bounded source was replaced wholesale.' }];
  evidence.checks = [{ id: 'X1', command, exit: 0 }]; evidence.checkResults = [{ checkID: 'C1', disposition: 'passed', executions: ['X1'] }];
  status = await f.send('submit', { handle: status.handle, evidence });
  const finding = { status: 'verified', checks: ['X1'], assessment: 'Actual held source and parent check reviewed.' };
  const verification = { scenarios: [{ requirementID: 'R1', scenarioID: 'S1', stepID: 'A1', ...finding }], steps: [{ stepID: 'A1', ...finding }],
    decisions: [{ decisionID: 'D1', ...finding }], changes: 'Held replacement is present.', limits: [], checkResults: evidence.checkResults, supplementalChecks: [] };
  status = (await f.dispatch(await f.select(status, 'mdd-verify'), { verificationVersion: 1, checks: evidence.checks, verification })).status;
  assert.equal(status.lastReceipt.outcome, 'passed');
  assert.equal((await f.send('close', { handle: status.handle, outcome: 'verified' })).state, 'completed');
});

test('grill: declining the offer keeps ordinary product questions and admission unchanged', async t => {
  const f = await fixture(t), draft = grilledDraft(f), userID = f.user(draft.objective);
  await ownQuestion(f, [['Seguir sin sesión']]);
  const open = { ...structuredClone(draft), productQuestions: ['Which replacement format?'] };
  let status = await f.send('entry', { contract: open, messageID: userID });
  assert.ok(status.question, 'MDD still issues its own product question');
  assert.match(status.question.questions[0].question, /Which replacement format\?/);
  status = await f.answer(status, [['Keep the original format.']]);
  status = await f.send('entry', { contract: draft, messageID: userID });
  assert.equal(status.state, 'await-selection'); assert.equal(status.route, 'high');
  const recorded = f.store.read(f.sessionID).nativePolicy.questions;
  assert.deepEqual(recorded.map(item => item.adaptive.purpose), ['product'], 'only the MDD-issued question is recorded, never the offer');
});

test('grill: interactive and unset modes still ask MDD mode and operation approval after a session', async t => {
  for (const mode of ['interactive', null]) {
    const f = await fixture(t, mode), draft = grilledDraft(f), userID = f.user(draft.objective);
    for (const labels of [offer, round, confirm]) await ownQuestion(f, labels);
    let status = await f.send('entry', { contract: draft, messageID: userID });
    assert.ok(status.question, 'a session never stands in for MDD consent');
    if (mode) { assert.match(status.question.questions[0].question, /Authorize only this exact adaptive operation/); status = await f.answer(status); }
    else {
      assert.equal(status.question.questions[0].header, 'Modo');
      status = await f.answer(status, [[status.question.questions[0].options.find(option => /utom.tico/.test(option.label)).label]]);
    }
    assert.equal(status.state, 'await-selection'); assert.equal(status.route, 'high');
  }
});

test('grill: the documentation option admits new glossary and ADR files and Apply creates them in scope', async t => {
  const f = await fixture(t), draft = f.contract('Replace only the bounded source and record the agreed language.');
  const docs = ['GLOSSARY.md', 'docs/adr/0001-replace-bounded-source.md'];
  draft.scope = { complete: true, reads: ['own.txt'], writes: ['own.txt', ...docs] };
  draft.context.fingerprints = [{ path: 'own.txt', digest: hash('before') }, ...docs.map(path => ({ path, digest: null }))];
  draft.acceptance.requirements.push({ id: 'R2', description: 'Agreed language is documented', scenarios: [{ id: 'S2', given: 'A resolved term and decision', when: 'The run applies', then: 'The glossary and ADR record them' }] });
  draft.assignments.push({ id: 'A2', path: 'GLOSSARY.md', description: 'Write the agreed glossary term and ADR', scenarios: ['S2'], decisions: [], dependsOn: [],
    scope: { complete: true, reads: [], writes: docs }, obligations: { source: [{ id: 'E2', description: 'Read the written documentation', paths: docs }], checks: [] } });
  const userID = f.user(draft.objective);
  for (const labels of [[['Sesión con documentación (Recomendada)']], round, confirm]) await ownQuestion(f, labels);
  let status = await f.send('entry', { contract: draft, messageID: userID });
  assert.equal(status.state, 'await-selection'); assert.equal(status.route, 'low');
  status = await f.select(status, 'mdd-apply', { assignmentID: 'A2' });
  assert.equal(status.task.agent, 'mdd-apply');
  const operations = [{ path: 'GLOSSARY.md', kind: 'create', content: '# Project\n\n## Language\n\n**Bounded source**:\nThe single file this change may replace.\n_Avoid_: target file\n' },
    { path: 'docs/adr/0001-replace-bounded-source.md', kind: 'create', content: '# Replace the bounded source wholesale\n\nAgreed in the question session.\n' }];
  const settled = await f.dispatch(status, { completed: ['A2'], changes: docs, checks: [] }, { operations });
  assert.equal(settled.status.lastReceipt.outcome, 'passed');
  for (const [index, path] of docs.entries()) assert.equal(fs.readFileSync(join(f.root, path), 'utf8'), operations[index].content, path);
  assert.equal(fs.readFileSync(join(f.root, 'own.txt'), 'utf8'), 'before', 'the documentation assignment touched only its own scope');
});

test('grill: a chat reply during the session keeps the request; it is confirmed natively instead of resent', async t => {
  const f = await fixture(t), draft = grilledDraft(f), first = f.user(draft.objective);
  await ownQuestion(f, offer);
  f.user('Q1 sí, Q2 la opción B.');
  let status = await f.send('entry', { contract: draft, messageID: first });
  assert.equal(status.state, 'question-ready');
  assert.equal(status.question.questions[0].header, 'Pedido anterior');
  assert.equal(f.store.read(f.sessionID), undefined, 'nothing is admitted before the native confirmation');
  status = await f.answer(status, [['Approve operation']]);
  assert.equal(status.state, 'await-selection'); assert.equal(status.route, 'high');
  assert.equal(f.store.read(f.sessionID).userMessageID, first);
});

test('grill: a session cannot run over a pending MDD question, and the refusal leaves it answerable', async t => {
  const f = await fixture(t), draft = grilledDraft(f), userID = f.user(draft.objective);
  let status = await f.send('entry', { contract: { ...structuredClone(draft), productQuestions: ['Which replacement format?'] }, messageID: userID });
  assert.ok(status.question);
  await assert.rejects(ownQuestion(f, round), /question|pending|differs|envelope/i);
  status = await f.answer(status, [['Keep the original format.']]);
  status = await f.send('entry', { contract: draft, messageID: userID });
  assert.equal(status.state, 'await-selection');
});

test('grill: a long session within the readable native history still admits the current request', async t => {
  const f = await fixture(t), draft = grilledDraft(f), userID = f.user(draft.objective);
  const parent = f.messages.get(f.sessionID);
  for (let step = 0; step < 60; step++) {
    parent.push({ id: `grill-step-${step}`, type: 'assistant', agent: 'mdd-orchestrator', model: { providerID: 'openai', id: 'test' }, content: [], time: { created: 1000 + step } });
    f.switchParent(f.sessionID);
    await ownQuestion(f, [['Opción A (Recomendada)']]);
  }
  const status = await f.send('entry', { contract: draft, messageID: userID });
  assert.equal(status.state, 'await-selection'); assert.equal(status.route, 'high');
});

test('grill: a dismissed session question settles without holding the parent', async t => {
  const f = await fixture(t), draft = grilledDraft(f), userID = f.user(draft.objective);
  const call = f.begin('question', grillQuestion(offer));
  await f.hooks.get('execute.before')(call);
  await f.hooks.get('execute.after')({ ...call, status: 'error', error: 'The user dismissed this question' });
  f.messages.get(f.sessionID).flatMap(message => message.content ?? []).find(item => item.id === call.id).state =
    { status: 'error', input: call.input, error: 'The user dismissed this question', metadata: {} };
  const status = await f.send('entry', { contract: draft, messageID: userID });
  assert.equal(status.state, 'await-selection'); assert.equal(status.route, 'high');
});

test('grill: a session past the readable native history fails closed without creating a run', async t => {
  const f = await fixture(t), draft = grilledDraft(f), userID = f.user(draft.objective);
  for (let step = 0; step < 99; step++) {
    f.messages.get(f.sessionID).push({ id: `grill-long-${step}`, type: 'assistant', agent: 'mdd-orchestrator', model: { providerID: 'openai', id: 'test' }, content: [], time: { created: 1000 + step } });
    f.switchParent(f.sessionID);
    await ownQuestion(f, [['Opción A (Recomendada)']]);
  }
  await assert.rejects(f.send('entry', { contract: draft, messageID: userID }));
  assert.equal(f.store.read(f.sessionID), undefined);
});

// A closed version-3 run keeps its parent until a fresh request replaces it. MDD used to refuse
// every question it had not issued there, so a second session in the same conversation was
// impossible until OpenCode restarted. Both closures, with and without a restore, now host one.
async function closeRun(f, outcome) {
  const draft = f.contract();
  let status = await f.entry(draft);
  if (outcome === 'unverified') return f.send('close', { handle: status.handle, outcome, limits: ['Not implemented.'] });
  const settled = await f.dispatch(await f.select(status), { completed: ['A1'], changes: ['own.txt'], checks: [] }, ['before', 'after']);
  // The host reports the finished child idle, as OpenCode does; terminal replacement checks it.
  await f.emit({ type: 'session.status', data: { sessionID: settled.result.output.sessionID, status: { type: 'idle' } } });
  status = await f.send('prepare', { handle: settled.status.handle });
  status = await f.send('submit', { handle: status.handle, evidence: f.evidence(draft, status.evidence.snapshotID) });
  return f.send('close', { handle: status.handle, outcome });
}
for (const outcome of ['unverified', 'verified']) for (const restart of [false, true]) {
  test(`grill: after a ${outcome} closed run the same conversation can hold a session (restart=${restart})`, async t => {
    const f = await fixture(t);
    let status = await closeRun(f, outcome);
    assert.equal(status.state, outcome === 'verified' ? 'completed' : 'closed-unverified');
    const prior = status.runID;
    if (restart) await f.restart();
    const draft = grilledDraft(f, 'Add a different new capability.', outcome === 'verified' ? 'after' : 'before'), userID = f.user(draft.objective);
    await f.call('mdd_status');
    for (const labels of [offer, round, round, confirm]) await ownQuestion(f, labels);
    assert.equal(f.store.read(f.sessionID).runID, prior, 'the session leaves the closed run untouched');
    status = await f.send('entry', { contract: draft, messageID: userID });
    assert.equal(status.state, 'await-selection'); assert.equal(status.route, 'high');
    assert.notEqual(status.runID, prior);
    assert.equal(f.store.read(f.sessionID).nativePolicy.questions.length, 0, 'session answers are never recorded as MDD consent');
    assert.equal(new AdaptiveRetirement(f.store).read(f.sessionID, prior).previous.data.state, outcome === 'verified' ? 'completed' : 'closed-unverified');
  });
}

// The allowance is only for a closed run with nothing of MDD's own outstanding.
test('grill: active runs, pending MDD questions and interrupted durable questions still refuse other questions', async t => {
  const active = await fixture(t);
  await active.entry(active.contract());
  await assert.rejects(ownQuestion(active, round), /requires an idle run/);
  const f = await fixture(t);
  await closeRun(f, 'unverified');
  const draft = grilledDraft(f, 'Add a different new capability.'), userID = f.user(draft.objective);
  const open = { ...structuredClone(draft), productQuestions: ['Which replacement format?'] };
  let status = await f.send('entry', { contract: open, messageID: userID });
  assert.ok(status.question);
  await assert.rejects(ownQuestion(f, round), /question|pending|differs|envelope/i);
  await f.restart(); await f.call('mdd_status');
  await assert.rejects(ownQuestion(f, round), /question|consent|intake|interrupted/i);
});
