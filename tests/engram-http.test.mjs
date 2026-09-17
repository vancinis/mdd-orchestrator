import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { EngramHttp } from '../dist/engram-http.js';
import { memoryServer } from './adapter-fixture.mjs';

test('Engram HTTP: exact bound observation round trip on real loopback transport', async t => {
  const { endpoint, binding, writes } = await memoryServer(t);
  const store = new EngramHttp(endpoint, binding);
  await store.checkBinding();
  assert.equal(await store.save('MDD intent', '{"run":"one"}'), 1);
  assert.equal(writes[0].session_id, binding.id);
  assert.equal(writes[0].scope, 'project');
});

for (const endpoint of ['https://127.0.0.1:7437', 'http://example.com', 'http://localhost:7437',
  'http://127.0.0.1:7437/path', 'http://user:secret@127.0.0.1:7437', 'http://127.0.0.1:7437?x=1']) {
  test(`Engram HTTP: reject noncanonical endpoint ${endpoint.replace('user:secret@', '')}`, () => {
    assert.throws(() => new EngramHttp(endpoint, {}), /loopback/);
  });
}

for (const fault of ['missing', 'project', 'directory', 'id', 'ended', 'write', 'readback', 'redirect']) {
  test(`Engram HTTP: fail closed on ${fault}`, async t => {
    const { endpoint, binding, writes } = await memoryServer(t, (req, reply) => {
      if (req.url.startsWith('/sessions/')) {
        if (fault === 'missing') reply.status = 404;
        if (['project', 'directory', 'id'].includes(fault)) reply.data = { ...reply.data, [fault]: 'wrong' };
        if (fault === 'ended') reply.data = { ...reply.data, ended_at: 'yesterday' };
      }
      if (fault === 'write' && req.method === 'POST') reply.status = 500;
      if (fault === 'readback' && req.url.startsWith('/observations/')) reply.data.content = 'wrong';
      if (fault === 'redirect') { reply.status = 302; reply.headers.location = 'https://example.com'; }
    });
    const store = new EngramHttp(endpoint, binding);
    await assert.rejects(store.save('MDD intent', 'content'));
    if (['missing', 'project', 'directory', 'id', 'ended', 'redirect'].includes(fault)) assert.equal(writes.length, 0);
  });
}

test('Engram HTTP: bounded timeout including unread response body', async t => {
  const server = createServer((_req, res) => { res.writeHead(200); res.write('{'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const store = new EngramHttp(`http://127.0.0.1:${server.address().port}`, {}, 30);
  await assert.rejects(store.checkBinding(), /Engram/);
});

for (const fault of ['unknown-save', 'noninteger-id', 'wrong-scope', 'wrong-session', 'deleted', 'oversized']) {
  test(`Engram HTTP: reject ${fault} response without retry`, async t => {
    const { endpoint, binding, writes } = await memoryServer(t, (req, reply) => {
      if (req.method === 'POST') {
        if (fault === 'unknown-save') reply.data.status = 'pending';
        if (fault === 'noninteger-id') reply.data.id = '1';
      }
      if (req.url.startsWith('/observations/')) {
        if (fault === 'wrong-scope') reply.data.scope = 'personal';
        if (fault === 'wrong-session') reply.data.session_id = 'other';
        if (fault === 'deleted') reply.data.deleted_at = 'yesterday';
        if (fault === 'oversized') reply.data.padding = 'x'.repeat(131073);
      }
    });
    await assert.rejects(new EngramHttp(endpoint, binding).save('MDD intent', 'content'));
    assert.equal(writes.length, 1);
  });
}
