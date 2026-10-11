import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collapseSupersededStatus, collapseSupersededStatusResults, supersededReplies, supersededStatus, STATUS_REPLY_TOOLS } from '../dist/status-transcript.js';
import { DISPATCH_HANDLE_PREFIX } from '../dist/phase-runner.js';

// A status the size of a real one, carrying everything a stale copy must never leak back.
const status = (state, phase, extra = {}) => JSON.stringify({
  state, phase, runID: 'run', sessionID: 'ses',
  task: { description: `MDD ${phase} phase`, subagent_type: phase, prompt: `${DISPATCH_HANDLE_PREFIX}${state}-${phase}` },
  question: { questions: [{ header: 'Aprobación', question: '¿Continuar?' }] },
  nextAction: { tool: 'task', why: 'Dispatch it.' }, report: 'x'.repeat(4000), ...extra,
});
const reply = (tool, output, status_ = 'completed') => ({ type: 'tool', tool, callID: `${tool}-${output.length}`, state: { status: status_, input: {}, output } });
const messages = (...parts) => parts.map((part, index) => ({ info: { id: `m${index}`, role: 'assistant' }, parts: [part] }));
const outputs = list => list.flatMap(message => message.parts.map(part => part.state?.output));

test('only the latest status reply stays whole; every earlier one becomes a placeholder', () => {
  const first = status('ready', 'mdd-explore'), second = status('ready', 'mdd-plan'), latest = status('ready', 'mdd-apply');
  const list = messages(reply('mdd_status', first), reply('mdd_status', second), reply('mdd_status', latest));
  assert.equal(collapseSupersededStatus(list), 2);
  const [a, b, c] = outputs(list);
  assert.equal(c, latest, 'the reply the coordinator acts on is never touched');
  assert.deepEqual(JSON.parse(a), JSON.parse(supersededStatus('mdd_status', JSON.parse(first))));
  assert.equal(JSON.parse(a).state, 'ready');
  assert.equal(JSON.parse(b).phase, 'mdd-plan');
  for (const stub of [a, b]) {
    assert.ok(Buffer.byteLength(stub) < 400, `placeholder is ${Buffer.byteLength(stub)} bytes`);
    // Nothing in a placeholder can be copied into a call: no handle, task, question or next action.
    assert.equal(stub.includes(DISPATCH_HANDLE_PREFIX), false);
    for (const key of ['task', 'tasks', 'question', 'nextAction', 'prompt']) assert.equal(Object.hasOwn(JSON.parse(stub), key), false, key);
    assert.match(stub, /act only on the latest MDD reply/);
  }
});

test('every workflow tool reply supersedes and is superseded, whichever tool wrote it', () => {
  for (const tool of STATUS_REPLY_TOOLS) {
    const list = messages(reply(tool, status('ready', 'mdd-plan')), reply('mdd_status', status('await-result', 'mdd-plan')));
    assert.equal(collapseSupersededStatus(list), 1, `${tool} is a status reply`);
    const back = messages(reply('mdd_status', status('ready', 'mdd-plan')), reply(tool, status('await-result', 'mdd-plan')));
    assert.equal(collapseSupersededStatus(back), 1, `${tool} replaces an earlier status`);
    assert.match(outputs(back)[0], /"superseded":"mdd_status"/);
  }
});

test('a failed, running or unreadable reply never hides the last status that succeeded', () => {
  const good = status('ready', 'mdd-plan');
  for (const later of [
    reply('mdd_status', 'Error: durable run owner busy.', 'error'),
    reply('mdd_status', status('ready', 'mdd-apply'), 'running'),
    reply('mdd_status', 'not json at all'),
    reply('mdd_status', JSON.stringify(['an', 'array'])),
    reply('mdd_status', JSON.stringify({ phase: 'mdd-apply', note: 'no state field' })),
  ]) {
    const list = messages(reply('mdd_status', good), later);
    assert.equal(collapseSupersededStatus(list), 0);
    assert.equal(outputs(list)[0], good);
  }
});

test('replies of other tools are never touched, even when they look like a status', () => {
  const lookalike = status('recorded', 'mdd-plan');
  for (const tool of ['mdd_pr_body', 'mdd_improve', 'mdd_improvements', 'mdd_knowledge', 'mdd_knowledge_record', 'mdd_security', 'read', 'task']) {
    const list = messages(reply(tool, lookalike), reply('mdd_status', status('ready', 'mdd-apply')));
    assert.equal(collapseSupersededStatus(list), 0, tool);
    assert.equal(outputs(list)[0], lookalike, tool);
  }
});

test('a reply smaller than its placeholder is left as it is', () => {
  const small = JSON.stringify({ state: 'not-started' });
  const list = messages(reply('mdd_status', small), reply('mdd_status', status('ready', 'mdd-explore')));
  assert.equal(collapseSupersededStatus(list), 0);
  assert.equal(outputs(list)[0], small);
});

test('placeholders are byte-stable as the conversation grows, so the prompt cache keeps hitting', () => {
  // The same earlier replies, seen on two consecutive turns: the second turn appends a new status.
  const turn = extra => messages(reply('mdd_status', status('ready', 'mdd-explore')), reply('mdd_prepare_advance', status('ready', 'mdd-plan')),
    reply('mdd_status', status('await-result', 'mdd-plan')), ...extra);
  const before = turn([]); collapseSupersededStatus(before);
  const after = turn([reply('mdd_status', status('ready', 'mdd-apply'))]); collapseSupersededStatus(after);
  // Whatever was already a placeholder is still exactly the same placeholder.
  assert.deepEqual(outputs(after).slice(0, 2), outputs(before).slice(0, 2));
  // A placeholder is never mistaken for a status on a later pass.
  assert.equal(collapseSupersededStatus(after), 0, 'collapsing is idempotent');
});

test('a pending restatement keeps the reply that still carries the rejected text', () => {
  const text = 'r'.repeat(30000);
  const rejected = { reason: 'checks[9].command is too long.', text, restatementsLeft: 2 };
  const withText = status('ready', 'mdd-verify', { rejected });
  const omitted = status('ready', 'mdd-verify', { rejected: { reason: rejected.reason, restatementsLeft: 2, textOmitted: true, textBytes: 30000 } });
  const older = status('ready', 'mdd-verify', { rejected: { ...rejected, text: 'o'.repeat(500) } });
  const list = messages(reply('mdd_status', older), reply('mdd_status', withText), reply('mdd_status', omitted));
  assert.equal(collapseSupersededStatus(list), 1);
  const [a, b, c] = outputs(list);
  assert.match(a, /"superseded"/, 'a different rejected report is not the one waiting');
  assert.equal(b, withText, 'the document waiting to be restated stays readable');
  assert.equal(c, omitted);
  // Once the restatement is no longer pending, the text goes like any other superseded reply.
  const done = messages(reply('mdd_status', withText), reply('mdd_phase_result', status('ready', 'mdd-apply')));
  assert.equal(collapseSupersededStatus(done), 1);
});

test('collapsing replaces parts instead of mutating the records it was handed', () => {
  const part = reply('mdd_status', status('ready', 'mdd-plan'));
  const held = part.state;
  const original = held.output;
  const list = messages(part, reply('mdd_status', status('ready', 'mdd-apply')));
  collapseSupersededStatus(list);
  assert.equal(part.state.output, original);
  assert.equal(held.output, original);
  assert.notEqual(list[0].parts[0], part);
  assert.equal(list[0].parts[0].callID, part.callID, 'everything but the output is the same call');
});

test('malformed or empty input is survivable, because a transform must never fail a turn', () => {
  for (const value of [undefined, null, 'text', 42, {}, [], [null], [{ parts: null }], [{ parts: [null, 'x', {}, { type: 'tool', tool: 'mdd_status', state: null }] }]]) {
    assert.equal(collapseSupersededStatus(value), 0);
  }
  assert.deepEqual(supersededReplies([]), []);
});

const call = (id, name) => ({ role: 'assistant', content: [{ type: 'tool-call', id, name, input: {} }] });
const result = (id, name, value) => ({ role: 'tool', content: [{ type: 'tool-result', id, name, result: value }] });

test('V2: superseded tool results collapse in the shape they arrived in', () => {
  const latest = status('ready', 'mdd-apply');
  const list = [
    call('a', 'mdd_status'), result('a', 'mdd_status', { type: 'text', value: status('ready', 'mdd-explore') }),
    call('b', 'mdd_context'), result('b', 'mdd_context', { type: 'content', value: [{ type: 'text', text: status('ready', 'mdd-plan') }] }),
    call('c', 'mdd_start'), result('c', 'mdd_start', { type: 'json', value: JSON.parse(status('question-ready', 'mdd-explore')) }),
    call('d', 'mdd_status'), result('d', 'mdd_status', { type: 'error', value: 'Error: refused.' }),
    call('e', 'read'), result('e', 'read', { type: 'text', value: status('ready', 'mdd-plan') }),
    call('f', 'mdd_status'), result('f', 'mdd_status', { type: 'text', value: latest }),
  ];
  const before = structuredClone(list);
  const { messages: sent, collapsed } = collapseSupersededStatusResults(list);
  assert.equal(collapsed, 3);
  assert.deepEqual(list, before, 'the messages handed in are left exactly as they were');
  const value = index => sent[index].content[0].result;
  assert.equal(value(1).type, 'text');
  assert.match(value(1).value, /"superseded":"mdd_status"/);
  assert.equal(value(3).type, 'content');
  assert.match(value(3).value[0].text, /"superseded":"mdd_context"/);
  assert.equal(value(5).type, 'json');
  assert.equal(value(5).value.superseded, 'mdd_start');
  assert.deepEqual(value(7), before[7].content[0].result, 'an error result is never touched');
  assert.deepEqual(value(9), before[9].content[0].result, 'another tool is never touched');
  assert.equal(value(11).value, latest, 'the latest status is never touched');
  for (const index of [0, 2, 4, 6, 8, 10]) assert.equal(sent[index], list[index], 'messages without a collapse are passed through');
});

test('V2: nothing to collapse returns the same messages', () => {
  const list = [call('a', 'mdd_status'), result('a', 'mdd_status', { type: 'text', value: status('ready', 'mdd-plan') })];
  const { messages: sent, collapsed } = collapseSupersededStatusResults(list);
  assert.equal(collapsed, 0);
  assert.deepEqual(sent, list);
});
