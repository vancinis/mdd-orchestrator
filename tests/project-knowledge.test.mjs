import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { NativeIntake } from '../dist/native-intake.js';
import { defaultSettings } from '../dist/settings.js';
import { memoryServer, runtime } from './adapter-fixture.mjs';

const body = 'Use boundary validation. Detailed rationale stays in canonical memory only.';
const draft = () => ({ summary: 'Use boundary validation.', body,
  applicability: { phases: ['mdd-apply'], paths: ['src'] }, sources: ['src/settings.ts'] });
const request = (observation = draft()) => ({ userText: 'Please improve input validation in the settings parser.', observation });
function intake(endpoint, enabled = true, inspect = async () => 'msg_user') {
  const settings = { ...defaultSettings(), knowledge: { enabled }, ...(endpoint ? { engram: { endpoint } } : {}) };
  return new NativeIntake({ status: () => ({ state: 'not-started' }) }, { intake: inspect }, settings);
}

test('organic recording accepts coordinator synthesis linked to an ordinary native request', async t => {
  const { endpoint, writes } = await memoryServer(t);
  const userText = 'Please simplify the settings validation and keep the existing behavior.';
  const observation = { ...draft(), summary: 'The settings boundary is the validation owner.' };
  const calls = [];
  const gate = intake(endpoint, true, async (...args) => { calls.push(args); return 'msg_ordinary'; });
  const saved = await gate.recordKnowledge({ userText, observation }, runtime, 'assistant');
  assert.equal(saved.state, 'recorded');
  assert.equal(saved.entry.summary, observation.summary);
  assert.equal(observation.body.includes(observation.summary), false);
  assert.deepEqual(calls[0], [runtime, userText, 'assistant']);
  const envelope = JSON.parse(writes[0].content);
  assert.equal(envelope.provenance.kind, 'coordinator-observation');
  assert.equal(envelope.provenance.userMessageID, 'msg_ordinary');
  assert.equal(envelope.provenance.assistantMessageID, 'assistant');
  assert.equal(envelope.provenance.requestDigest, createHash('sha256').update(userText).digest('hex'));
  assert.match(envelope.provenance.observationDigest, /^[a-f0-9]{64}$/);
  assert.equal(envelope.status, 'observation');
  assert.equal(JSON.stringify(saved).includes('Detailed rationale'), false);
});

test('distinct findings share a native task while equivalent record retries remain guarded', async t => {
  const { endpoint, writes } = await memoryServer(t);
  const gate = intake(endpoint);
  const userText = 'Improve boundary validation.';
  const first = { ...draft(), sources: ['src/settings.ts', 'src/validation.ts'] };
  const second = { ...draft(), summary: 'Unknown fields should remain explicit errors.' };
  assert.equal((await gate.recordKnowledge({ userText, observation: first }, runtime, 'assistant')).state, 'recorded');
  assert.equal((await gate.recordKnowledge({ userText, observation: second }, runtime, 'assistant')).state, 'recorded');
  const retry = { ...first, sources: [...first.sources].reverse() };
  assert.equal((await gate.recordKnowledge({ userText, observation: retry }, runtime, 'assistant')).state, 'already-attempted');
  assert.equal(writes.length, 2);
  assert.notEqual(JSON.parse(writes[0].content).provenance.observationDigest, JSON.parse(writes[1].content).provenance.observationDigest);
});

test('knowledge opt-out avoids all provider calls and enabled missing provider is explicit', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('disabled knowledge contacted provider'));
  const off = intake('http://127.0.0.1:7437', false);
  assert.equal((await off.knowledge({}, runtime)).state, 'disabled');
  assert.equal((await off.recordKnowledge(request(), runtime, 'assistant')).state, 'disabled');
  assert.equal((await intake().knowledge({}, runtime)).state, 'unavailable');
});

test('knowledge crosses sessions in the same project, fetches full records and never returns bodies', async t => {
  const fetched = [];
  const { endpoint, binding, writes } = await memoryServer(t, (req, reply) => {
    if (req.url.startsWith('/search?')) reply.data = reply.data.map(row => ({ ...row, content: 'truncated preview' }));
    if (req.url.startsWith('/observations/')) fetched.push(req.url);
  });
  const first = intake(endpoint);
  const saved = await first.recordKnowledge(request(), runtime, 'assistant');
  assert.equal(saved.state, 'recorded');
  assert.equal(saved.entry.ref, 'engram:1');
  assert.equal(JSON.stringify(saved).includes('Detailed rationale'), false);
  const record = JSON.parse(writes[0].content);
  assert.equal(record.body, body);
  assert.equal(record.status, 'observation');
  assert.equal(record.project, binding.project);
  assert.equal(record.provenance.userMessageID, 'msg_user');
  assert.equal(record.provenance.requestDigest, createHash('sha256').update(request().userText).digest('hex'));
  binding.id = 'ses_later';
  const later = intake(endpoint);
  const found = await later.knowledge({ query: 'validation', phase: 'mdd-apply', paths: ['src/settings.ts'] }, { ...runtime, sessionID: binding.id });
  assert.equal(found.state, 'available');
  assert.equal(found.entries.length, 1);
  assert.equal(found.entries[0].freshness, 'unverified');
  assert.equal(found.entries[0].summary, draft().summary);
  assert.equal(JSON.stringify(found).includes('Detailed rationale'), false);
  assert.ok(fetched.length >= 2, 'save and query require full readback');
  assert.deepEqual((await later.knowledge({ phase: 'mdd-plan' }, { ...runtime, sessionID: binding.id })).entries, []);
  assert.deepEqual((await later.knowledge({ paths: ['src-other/settings.ts'] }, { ...runtime, sessionID: binding.id })).entries, []);
});

for (const fault of ['foreign', 'deleted', 'malformed', 'version', 'policy', 'scope', 'provenance', 'session', 'path', 'oversized', 'extra', 'missing', 'project', 'timestamp', 'user-authored', 'record-digest', 'caller']) {
  test(`knowledge rejects full-record ${fault} even when search preview was valid`, async t => {
    let corrupt = false;
    const { endpoint } = await memoryServer(t, (req, reply) => {
      if (!corrupt || !req.url.startsWith('/observations/')) return;
      if (fault === 'foreign') reply.data.project = 'foreign';
      if (fault === 'deleted') reply.data.deleted_at = 'yesterday';
      if (fault === 'scope') reply.data.scope = 'personal';
      if (fault === 'session') reply.data.session_id = 'forged';
      if (fault === 'missing') { reply.status = 404; return; }
      if (fault === 'malformed') { reply.data.content = '{'; return; }
      const envelope = JSON.parse(reply.data.content);
      if (fault === 'version') envelope.version = 2;
      if (fault === 'policy') envelope.status = 'approved-policy';
      if (fault === 'provenance') delete envelope.provenance.userMessageID;
      if (fault === 'path') envelope.sources = ['../secret'];
      if (fault === 'oversized') envelope.body = 'x'.repeat(4097);
      if (fault === 'extra') envelope.authority = true;
      if (fault === 'project') envelope.project = 'foreign';
      if (fault === 'timestamp') envelope.recordedAt = 'yesterday';
      if (fault === 'user-authored') envelope.provenance.kind = 'native-user';
      if (fault === 'record-digest') envelope.provenance.observationDigest = 'a'.repeat(64);
      if (fault === 'caller') delete envelope.provenance.assistantMessageID;
      reply.data.content = JSON.stringify(envelope);
    });
    const gate = intake(endpoint);
    assert.equal((await gate.recordKnowledge(request(), runtime, 'assistant')).state, 'recorded');
    corrupt = true;
    assert.deepEqual((await gate.knowledge({}, runtime)).entries, []);
  });
}

test('knowledge recording requires native context proof and bounded structured fields before writes', async t => {
  const { endpoint, writes } = await memoryServer(t);
  const forged = intake(endpoint, true, async () => { throw new Error('not native'); });
  await assert.rejects(forged.recordKnowledge(request(), runtime, 'assistant'), /native/);
  const gate = intake(endpoint);
  await assert.rejects(gate.recordKnowledge({ userText: 'Please implement something.' }, runtime, 'assistant'), /draft/);
  for (const value of [
    { ...draft(), summary: 'Multiline\nclaim' }, { ...draft(), body: 'x'.repeat(4097) },
    { ...draft(), sources: [] }, { ...draft(), sources: Array(17).fill('src/a') },
    { ...draft(), applicability: { phases: ['invented'], paths: ['src'] } },
    { ...draft(), applicability: { phases: ['mdd-apply'], paths: [] } },
    ...['../secret', '/absolute', 'C:/secret', 'src\\a', 'src/../secret', 'src//a', 'src/*', 'src/CON', 'src/a:stream', 'src/a.'].map(path => ({ ...draft(), sources: [path] })),
  ]) await assert.rejects(gate.recordKnowledge(request(value), runtime, 'assistant'));
  assert.equal(writes.length, 0);
});

test('unknown write outcomes are explicit, issue one POST, and refuse repeat native messages', async t => {
  const { endpoint, writes } = await memoryServer(t, (req, reply) => {
    if (req.method === 'POST') reply.data.status = 'unknown';
  });
  const gate = intake(endpoint);
  const result = await gate.recordKnowledge(request(), runtime, 'assistant');
  assert.equal(result.state, 'write-unknown');
  assert.match(result.note, /never retry/i);
  assert.equal((await gate.recordKnowledge(request(), runtime, 'assistant')).state, 'already-attempted');
  assert.equal(writes.length, 1);
});

for (const failure of ['post', 'readback']) {
  test(`knowledge ${failure} failure never retries an uncertain observation`, async t => {
    const { endpoint, writes } = await memoryServer(t, (req, reply) => {
      if (failure === 'post' && req.method === 'POST') reply.status = 500;
      if (failure === 'readback' && req.url.startsWith('/observations/')) reply.data.content = 'different body';
    });
    const result = await intake(endpoint).recordKnowledge(request(), runtime, 'assistant');
    assert.equal(result.state, 'write-unknown');
    assert.equal(JSON.stringify(result).includes('different body'), false);
    assert.equal(writes.length, 1);
  });
}

test('knowledge concurrent recording admits one POST for the exact native user message', async t => {
  const { endpoint, writes } = await memoryServer(t);
  const gate = intake(endpoint);
  const results = await Promise.all([1, 2].map(() => gate.recordKnowledge(request(), runtime, 'assistant')));
  assert.deepEqual(results.map(result => result.state).sort(), ['already-attempted', 'recorded']);
  assert.equal(writes.length, 1);
});

test('provider outage returns unavailable, and query bounds prevent provider work', async t => {
  const { endpoint } = await memoryServer(t, (req, reply) => { if (req.url.startsWith('/search?')) reply.status = 503; });
  const gate = intake(endpoint);
  assert.equal((await gate.knowledge({}, runtime)).state, 'unavailable');
  t.mock.method(globalThis, 'fetch', () => assert.fail('invalid query must not reach provider'));
  for (const input of [{ limit: 0 }, { limit: 11 }, { limit: null }, { query: 'x'.repeat(201) }, { phase: 'invented' }, { paths: ['../secret'] }]) {
    await assert.rejects(gate.knowledge(input, runtime));
  }
});

test('knowledge results are capped even if provider ignores requested limit and duplicates rows', async t => {
  const { endpoint } = await memoryServer(t, (req, reply) => {
    if (req.url.startsWith('/search?')) reply.data = Array(30).fill(reply.data[0]);
  });
  const gate = intake(endpoint);
  await gate.recordKnowledge(request(), runtime, 'assistant');
  assert.equal((await gate.knowledge({ limit: 1 }, runtime)).entries.length, 1);
});
