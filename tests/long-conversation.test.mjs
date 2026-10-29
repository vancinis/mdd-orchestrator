// Proofs about a conversation read all of it. Every MDD tool used to read one 100-message page and
// refuse once it was full, so an ordinary long conversation (or a compacted one) could never prove
// itself idle again and every later admission, retirement or transfer in it failed with "Complete
// native idle history is unavailable; unknown children remain fenced". These tests pin the root
// fix against a host fake that honours `limit` exactly like the real one, so a regression to tail
// reads would hide the old messages these proofs depend on.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInspector, HISTORY_MAX } from '../dist/opencode-plugin.js';
import { recordedStatus } from '../dist/opencode-v2.js';

async function host(t) {
  const root = await mkdtemp(join(tmpdir(), 'mdd-long-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = new Map([['parent', { id: 'parent', directory: root, projectID: 'project', agent: 'mdd-orchestrator' }]]);
  const histories = new Map([['parent', []]]);
  const statuses = {};
  const reads = [];
  const input = { directory: root, worktree: root, project: { id: 'project' }, client: { session: {
    get: async ({ path }) => ({ data: structuredClone(sessions.get(path.id)) }),
    messages: async ({ path, query }) => {
      reads.push({ id: path.id, limit: query.limit });
      const all = structuredClone(histories.get(path.id) ?? []);
      return { data: query.limit === undefined ? all : all.slice(-query.limit) };
    },
    status: async () => ({ data: structuredClone(statuses) }),
  } } };
  const runtime = { sessionID: 'parent', agent: 'mdd-orchestrator', directory: root, worktree: root };
  const parent = histories.get('parent');
  let count = 0;
  const user = text => {
    const id = `user-${++count}`;
    parent.push({ info: { id, sessionID: 'parent', role: 'user' }, parts: [{ type: 'text', text, sessionID: 'parent', messageID: id }] });
    return id;
  };
  const assistant = (...parts) => {
    const id = `assistant-${++count}`;
    parent.push({ info: { id, sessionID: 'parent', role: 'assistant', agent: 'mdd-orchestrator', path: { cwd: root, root }, parentID: parent.findLast(m => m.info.role === 'user')?.info.id },
      parts: parts.map(part => ({ ...part, sessionID: 'parent', messageID: id })) });
    return id;
  };
  const settled = (tool, status = 'completed') => ({ type: 'tool', tool, callID: `call-${++count}`, state: { status, input: {} } });
  /** A finished foreground child the conversation names in its task part. */
  const child = (id, finish = 'stop') => {
    sessions.set(id, { id, parentID: 'parent', directory: root, projectID: 'project', agent: 'mdd-explore' });
    histories.set(id, [{ info: { id: `${id}-last`, sessionID: id, role: 'assistant', time: { completed: 1 }, finish }, parts: [] }]);
    return { type: 'tool', tool: 'task', callID: `task-${id}`, state: { status: 'completed', input: {}, metadata: { sessionId: id } } };
  };
  /** Ordinary turns: what a few completed routes leave behind. */
  const turns = n => { for (let index = 0; index < n; index++) { user(`turn ${index}`); assistant(settled('mdd_status')); } };
  return { root, input, runtime, sessions, histories, statuses, reads, parent, user, assistant, settled, child, turns };
}

test('LC-01: a settled conversation far past one page proves itself idle', async t => {
  const h = await host(t);
  h.user('Arma la documentación'); h.assistant(h.child('explore-1')); h.assistant(h.settled('question'), h.child('apply-1'));
  h.turns(150);
  h.user('Ya deberiamos estar desbloqueados y deberias poder continuar');
  h.assistant({ type: 'tool', tool: 'mdd_adapt', callID: 'current-adapt', state: { status: 'running', input: {} } });
  assert.ok(h.parent.length > 3 * HISTORY_MAX, 'the conversation must be well past one page');
  await createInspector(h.input).adaptiveTransferIdle(h.runtime, 'target');
  assert.ok(h.reads.some(read => read.id === 'parent' && read.limit === undefined), 'a full page must be followed by a whole read');
});

test('LC-02: a running control older than the tail page still fences', async t => {
  const h = await host(t);
  h.user('first'); h.assistant(h.settled('question', 'running'));
  h.turns(150);
  await assert.rejects(createInspector(h.input).adaptiveTransferIdle(h.runtime, 'target'), /Native control is running/);
});

test('LC-03: a named child beyond the tail page that the host reports busy still fences', async t => {
  const h = await host(t);
  h.user('first'); h.assistant(h.child('old-child'));
  h.turns(150);
  h.statuses['old-child'] = { type: 'busy' };
  await assert.rejects(createInspector(h.input).adaptiveTransferIdle(h.runtime, 'target'), /Native child is running/);
  h.statuses['old-child'] = { type: 'idle' };
  h.histories.get('old-child')[0].info.finish = 'tool-calls';
  await assert.rejects(createInspector(h.input).adaptiveTransferIdle(h.runtime, 'target'), /termination is unknown/);
});

test('LC-04: a compacted conversation proves idleness; a running child of it fences whether named or not', async t => {
  const h = await host(t);
  // What V2 returns after a compaction: the compaction itself, then everything after it.
  h.parent.push({ info: { id: 'compaction-1', sessionID: 'parent', role: 'system', summary: true }, parts: [{ type: 'compaction', sessionID: 'parent', messageID: 'compaction-1' }] });
  h.user('after the summary'); h.assistant(h.child('visible'));
  h.turns(3);
  const inspector = createInspector(h.input);
  await inspector.adaptiveTransferIdle(h.runtime, 'target');
  // A child summarized away is still this conversation's: the host's own status decides.
  h.sessions.set('hidden', { id: 'hidden', parentID: 'parent', directory: h.root, projectID: 'project', agent: 'general' });
  h.statuses.hidden = { type: 'idle' };
  await inspector.adaptiveTransferIdle(h.runtime, 'target');
  for (const type of ['busy', 'unknown']) {
    h.statuses.hidden = { type };
    await assert.rejects(inspector.adaptiveTransferIdle(h.runtime, 'target'), /native child of this conversation is running or unknown/);
  }
  // Someone else's running child is not this conversation's to wait for.
  h.sessions.set('hidden', { id: 'hidden', parentID: 'another-parent', directory: h.root, projectID: 'project', agent: 'general' });
  h.statuses.hidden = { type: 'busy' };
  await inspector.adaptiveTransferIdle(h.runtime, 'target');
});

test('LC-05: a conversation shorter than one page is still read once, with the page limit', async t => {
  const h = await host(t);
  h.user('short'); h.assistant(h.child('only'));
  await createInspector(h.input).adaptiveTransferIdle(h.runtime, 'target');
  const parentReads = h.reads.filter(read => read.id === 'parent');
  assert.deepEqual(parentReads, [{ id: 'parent', limit: HISTORY_MAX }]);
});

test('LC-06: intake reaches an objective older than one page without making recent matches ambiguous', async t => {
  const h = await host(t);
  const old = h.user('Objetivo original'); h.assistant(h.settled('mdd_status'));
  h.turns(150);
  const caller = h.assistant(h.settled('mdd_status'));
  const inspector = createInspector(h.input);
  assert.equal(await inspector.intake(h.runtime, 'Objetivo original', caller, 'objective'), old);
  await assert.rejects(inspector.intake(h.runtime, 'Nunca lo escribí', caller, 'objective'), /must exactly match an actual native user message/);
  // A recent unique message wins over an identical one beyond the page, exactly as when only the
  // page was readable; reading further never turns a unique recent match into an ambiguity.
  h.parent.pop();
  const recent = h.user('turn 3');
  const next = h.assistant(h.settled('mdd_status'));
  assert.equal(await inspector.intake(h.runtime, 'turn 3', next, 'objective'), recent);
  // Two identical recent messages are still refused rather than picked between.
  h.parent.pop(); h.user('turn 3'); const again = h.assistant(h.settled('mdd_status'));
  await assert.rejects(inspector.intake(h.runtime, 'turn 3', again, 'objective'), /Several native user messages/);
});

test('LC-07: a turn longer than one page keeps its own user message readable', async t => {
  const h = await host(t);
  const request = h.user('Implementa la entrega 1');
  for (let index = 0; index < 2 * HISTORY_MAX; index++) h.assistant(h.settled('read'));
  const caller = h.parent.at(-1).info.id;
  const inspector = createInspector(h.input);
  assert.equal(await inspector.currentUser(h.runtime, caller), request);
  assert.equal(await inspector.intake(h.runtime, 'Implementa la entrega 1', caller), request);
});

test('LC-08: a child that finished before a restart reads as idle from the host record, nothing else does', () => {
  assert.deepEqual(recordedStatus({ updated: 10, idle: 10 }), { type: 'idle' });
  assert.deepEqual(recordedStatus({ updated: 10, idle: 12 }), { type: 'idle' });
  for (const time of [{ updated: 12, idle: 10 }, { updated: 10 }, { updated: 10, idle: '10' }, { idle: 10 }, { updated: 10, idle: Number.NaN }, undefined])
    assert.deepEqual(recordedStatus(time), { type: 'unknown' }, JSON.stringify(time));
});
