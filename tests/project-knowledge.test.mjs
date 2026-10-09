import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { NativeIntake } from '../dist/native-intake.js';
import { defaultSettings } from '../dist/settings.js';
import { memoryServer as fixtureMemoryServer, runtime as nativeRuntime } from './adapter-fixture.mjs';

let runtime;
beforeEach(t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'mdd-knowledge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(join(root, 'src'));
  fs.writeFileSync(join(root, 'src/settings.ts'), 'original settings');
  fs.writeFileSync(join(root, 'src/validation.ts'), 'original validation');
  runtime = { ...nativeRuntime, directory: root, worktree: root };
});
async function memoryServer(t, change) {
  const server = await fixtureMemoryServer(t, change);
  server.binding.directory = runtime.directory;
  return server;
}

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
  assert.equal(found.entries[0].freshness, 'fresh');
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
      if (fault === 'version') envelope.version = 99;
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

test('PK2 records native digests and checks changed, deleted, empty and untracked source bytes', async t => {
  const { endpoint, writes } = await memoryServer(t);
  const gate = intake(endpoint);
  const input = request({ ...draft(), sources: ['src/settings.ts', 'src/new.ts'] });
  assert.equal((await gate.recordKnowledge(input, runtime, 'assistant')).entry.freshness, 'fresh');
  const record = JSON.parse(writes[0].content);
  assert.equal(record.version, 2);
  assert.deepEqual(record.dependencies, [
    { path: 'src/settings.ts', digest: createHash('sha256').update('original settings').digest('hex') },
    { path: 'src/new.ts', digest: 'missing' },
  ]);
  const freshness = async () => (await gate.knowledge({}, runtime)).entries[0].freshness;
  assert.equal(await freshness(), 'fresh');
  const original = fs.statSync(join(runtime.directory, 'src/settings.ts'));
  fs.writeFileSync(join(runtime.directory, 'src/settings.ts'), 'modified settings');
  fs.utimesSync(join(runtime.directory, 'src/settings.ts'), original.atime, original.mtime);
  assert.equal(await freshness(), 'stale', 'same-sized dirty bytes with restored mtime are still checked');
  fs.writeFileSync(join(runtime.directory, 'src/settings.ts'), 'original settings');
  fs.writeFileSync(join(runtime.directory, 'src/new.ts'), '');
  assert.equal(await freshness(), 'stale', 'missing is not an empty untracked file');
  fs.unlinkSync(join(runtime.directory, 'src/new.ts'));
  assert.equal(await freshness(), 'fresh');
  fs.unlinkSync(join(runtime.directory, 'src/settings.ts'));
  assert.equal(await freshness(), 'stale');
  assert.ok(fs.existsSync(join(runtime.directory, '.mdd/knowledge-cache.json')));
  assert.equal(JSON.stringify(await gate.knowledge({}, runtime)).includes(body), false);
});

test('PK2 linked checkout shares cache anchor but validates its own dependency bytes', async t => {
  const { endpoint, binding } = await memoryServer(t);
  const gate = intake(endpoint);
  await gate.recordKnowledge(request(), runtime, 'assistant');
  await gate.knowledge({}, runtime);
  const linked = fs.mkdtempSync(join(tmpdir(), 'mdd-knowledge-linked-'));
  t.after(() => fs.rmSync(linked, { recursive: true, force: true }));
  const admin = join(runtime.directory, '.git/worktrees/linked');
  fs.mkdirSync(admin, { recursive: true });
  fs.writeFileSync(join(admin, 'commondir'), '../..');
  fs.writeFileSync(join(linked, '.git'), `gitdir: ${admin.replaceAll('\\', '/')}`);
  fs.mkdirSync(join(linked, 'src'));
  fs.writeFileSync(join(linked, 'src/settings.ts'), 'different checkout');
  binding.id = 'ses_linked'; binding.directory = linked;
  const other = { ...runtime, sessionID: binding.id, directory: linked, worktree: linked };
  const later = intake(endpoint);
  assert.equal((await later.knowledge({}, other)).entries[0].freshness, 'stale');
  fs.writeFileSync(join(linked, 'src/settings.ts'), 'original settings');
  assert.equal((await later.knowledge({}, other)).entries[0].freshness, 'fresh');
  assert.equal(fs.existsSync(join(linked, '.mdd/knowledge-cache.json')), false);
});

test('PK2 legacy records stay unverified and canonical deletion, foreign records and outages override cache', async t => {
  let mode = 'normal';
  let fullReads = 0;
  const { endpoint, binding, writes } = await memoryServer(t, (req, reply) => {
    if (req.url.startsWith('/search?') && mode === 'outage') reply.status = 503;
    if (!req.url.startsWith('/observations/')) return;
    fullReads++;
    if (mode === 'deleted') reply.data = { ...reply.data, deleted_at: 'now' };
    if (mode === 'foreign') reply.data = { ...reply.data, project: 'foreign' };
  });
  const gate = intake(endpoint);
  await gate.recordKnowledge(request(), runtime, 'assistant');
  await gate.knowledge({}, runtime);
  await gate.knowledge({}, runtime);
  assert.equal(fullReads, 3, 'warm cache still reads the complete canonical record');
  mode = 'outage';
  assert.deepEqual((await gate.knowledge({}, runtime)).entries, []);
  mode = 'deleted';
  assert.deepEqual((await gate.knowledge({}, runtime)).entries, []);
  mode = 'foreign';
  assert.deepEqual((await gate.knowledge({}, runtime)).entries, []);
  mode = 'normal';
  const { knowledgeObservation } = await import('../dist/project-knowledge.js');
  writes[0].content = JSON.stringify(knowledgeObservation(draft(), binding.project, runtime.sessionID, 'msg_user', 'assistant', 'a'.repeat(64)));
  assert.equal((await gate.knowledge({}, runtime)).entries[0].freshness, 'unverified');
  assert.equal(JSON.parse(writes[0].content).dependencies, undefined, 'legacy digests are never backfilled');
});

test('PK2 rejects caller digests and private or unsafe sources before observation publication', async t => {
  const { endpoint, writes } = await memoryServer(t);
  const gate = intake(endpoint);
  for (const source of ['.env', '.env.local', '.git/config', '.mdd/knowledge-cache.json', '.ssh/id_rsa', 'keys/server.pem', 'credentials.json', 'src/secrets.json', 'ENV~1', '../escape', '/outside', 'src']) {
    await assert.rejects(gate.recordKnowledge(request({ ...draft(), sources: [source] }), runtime, 'assistant'));
  }
  await assert.rejects(gate.recordKnowledge(request({ ...draft(), dependencies: [{ path: 'src/settings.ts', digest: 'a'.repeat(64) }] }), runtime, 'assistant'));
  fs.linkSync(join(runtime.directory, 'src/settings.ts'), join(runtime.directory, 'src/alias.ts'));
  await assert.rejects(gate.recordKnowledge(request(), runtime, 'assistant'));
  assert.equal(writes.length, 0);
});

test('PK2 rejects junction source escapes and refuses reuse when safe sources become linked', async t => {
  const { endpoint } = await memoryServer(t);
  const gate = intake(endpoint);
  await gate.recordKnowledge(request(), runtime, 'assistant');
  const outside = fs.mkdtempSync(join(tmpdir(), 'mdd-knowledge-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(join(outside, 'settings.ts'), 'original settings');
  fs.rmSync(join(runtime.directory, 'src'), { recursive: true });
  fs.symlinkSync(outside, join(runtime.directory, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await gate.knowledge({}, runtime)).entries[0].freshness, 'stale');
  await assert.rejects(intake(endpoint).recordKnowledge(request(), runtime, 'assistant'));
});

test('PK2 bounds individual and aggregate source bytes before writing', async t => {
  const { endpoint, writes } = await memoryServer(t);
  const gate = intake(endpoint);
  fs.writeFileSync(join(runtime.directory, 'src/settings.ts'), Buffer.alloc(262145));
  await assert.rejects(gate.recordKnowledge(request(), runtime, 'assistant'));
  const sources = Array.from({ length: 5 }, (_, i) => `src/file${i}.ts`);
  for (const source of sources) fs.writeFileSync(join(runtime.directory, source), Buffer.alloc(262144));
  await assert.rejects(gate.recordKnowledge(request({ ...draft(), sources }), runtime, 'assistant'));
  assert.equal(writes.length, 0);
});

test('PK2 rejects source mutation during hashing without publishing an observation', async t => {
  const { endpoint, writes } = await memoryServer(t);
  const read = fs.readSync;
  let changed = false;
  t.mock.method(fs, 'readSync', (...args) => {
    const count = read(...args);
    if (!changed && count) {
      changed = true;
      fs.writeFileSync(join(runtime.directory, 'src/settings.ts'), 'modified settings');
    }
    return count;
  });
  await assert.rejects(intake(endpoint).recordKnowledge(request(), runtime, 'assistant'), /changed/);
  assert.equal(writes.length, 0);
});

test('PK2 rechecks ancestors after open and reads no bytes through a raced junction', async t => {
  const { endpoint, writes } = await memoryServer(t);
  const outside = fs.mkdtempSync(join(tmpdir(), 'mdd-knowledge-race-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(join(outside, 'settings.ts'), 'outside source');
  const file = join(runtime.directory, 'src/settings.ts');
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (name, ...args) => {
    if (name === file) {
      fs.rmSync(join(runtime.directory, 'src'), { recursive: true });
      fs.symlinkSync(outside, join(runtime.directory, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    return open(name, ...args);
  });
  t.mock.method(fs, 'readSync', () => assert.fail('outside source bytes must not be read'));
  await assert.rejects(intake(endpoint).recordKnowledge(request(), runtime, 'assistant'), /Linked|identity/);
  assert.equal(writes.length, 0);
});
