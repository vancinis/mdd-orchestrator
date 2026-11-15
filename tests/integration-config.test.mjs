import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { classify, configDigest, planServerEdit, readLayers, writeGlobalConfig, CONFIG_LIMIT } from '../dist/integration-config.js';

const ENGRAM = { type: 'local', command: ['C:/tools/engram.exe', 'mcp', '--tools=agent'] };
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function sandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'mdd-int-config-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const config = join(home, 'cfg', 'opencode');
  const project = join(root, 'work', 'project');
  const system = join(root, 'programdata');
  fs.mkdirSync(config, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  const env = { XDG_CONFIG_HOME: join(home, 'cfg'), ProgramData: system };
  const put = (path, text) => { fs.mkdirSync(join(path, '..'), { recursive: true }); fs.writeFileSync(path, text); return path; };
  const layers = (extra = {}) => readLayers({ cwd: project, env: { ...env, ...extra.env }, platform: 'win32', home, ...extra.rest });
  return { root, home, config, project, system, env, put, layers };
}

const ok = (result) => { assert.ok('next' in result, JSON.stringify(result)); return result.next; };

// ---- planServerEdit -------------------------------------------------------------------------

test('adding a server keeps comments, trailing commas, env references and unrelated entries', () => {
  const text = '{\n  // my models\n  "model": "a/b", // inline\n  "mcp": {\n    "servers": {\n      "other": { "type": "remote", "url": "https://x.test/mcp", "headers": { "Authorization": "Bearer {env:TOKEN}" }, },\n    },\n  },\n}\n';
  const next = ok(planServerEdit(text, 'engram', { add: ENGRAM }));
  assert.match(next, /\/\/ my models/);
  assert.match(next, /\/\/ inline/);
  assert.match(next, /Bearer \{env:TOKEN\}/);
  assert.ok(next.endsWith('\n'));
  const value = parse(next, [], { allowTrailingComma: true });
  assert.deepEqual(value.mcp.servers.engram, ENGRAM);
  assert.equal(value.mcp.servers.other.headers.Authorization, 'Bearer {env:TOKEN}');
  assert.equal(value.model, 'a/b');
});

test('BOM, CRLF and tab indentation are preserved', () => {
  const text = '\ufeff{\r\n\t"model": "a/b"\r\n}\r\n';
  const next = ok(planServerEdit(text, 'context7', { add: { type: 'remote', url: 'https://mcp.context7.com/mcp' } }));
  assert.ok(next.startsWith('\ufeff{'));
  assert.ok(!/(?<!\r)\n/.test(next), 'only CRLF line breaks');
  assert.match(next, /\n\t"model"/);
  assert.match(next, /\t"mcp"/);
  assert.equal(parse(next.slice(1)).mcp.servers.context7.url, 'https://mcp.context7.com/mcp');
});

test('a missing or blank file is created as a minimal document', () => {
  for (const text of [undefined, '', ' \n']) {
    const next = ok(planServerEdit(text, 'engram', { add: ENGRAM }));
    assert.deepEqual(parse(next), { mcp: { servers: { engram: ENGRAM } } });
    assert.ok(next.endsWith('\n'));
  }
});

test('ambiguous or unsafe input is refused and yields no text', () => {
  const cases = {
    malformed: '{ "mcp": ',
    duplicateTop: '{ "mcp": { "servers": {} }, "mcp": { "servers": { "a": {} } } }',
    duplicateNested: '{ "mcp": { "servers": { "a": {}, "a": {} } } }',
    arrayRoot: '[]',
    stringMcp: '{ "mcp": "x" }',
    arrayServers: '{ "mcp": { "servers": [] } }',
    taken: '{ "mcp": { "servers": { "engram": { "type": "local", "command": ["x"] } } } }',
    legacyTaken: '{ "mcp": { "engram": { "type": "local", "command": ["x"] } } }',
  };
  for (const [label, text] of Object.entries(cases)) {
    const result = planServerEdit(text, 'engram', { add: ENGRAM });
    assert.ok('refused' in result && result.refused, label);
    assert.ok(!('next' in result), label);
  }
  for (const name of ['', '__proto__', '../x', 'a b']) assert.ok('refused' in planServerEdit('{}', name, { add: ENGRAM }), name);
});

test('a command update changes only the command and requires the reviewed value', () => {
  const from = ['C:/old/engram.exe', 'mcp', '--tools=agent'];
  const to = ['C:/new/engram.exe', 'mcp', '--tools=agent'];
  const text = `{\n  // keep\n  "mcp": { "servers": { "engram": { "type": "local", "command": ${JSON.stringify(from)}, "environment": { "K": "{env:SECRET}" }, "enabled": true } } }\n}\n`;
  const next = ok(planServerEdit(text, 'engram', { command: { from, to } }));
  assert.match(next, /\/\/ keep/);
  const entry = parse(next).mcp.servers.engram;
  assert.deepEqual(entry, { type: 'local', command: to, environment: { K: '{env:SECRET}' }, enabled: true });
  assert.ok('refused' in planServerEdit(text, 'engram', { command: { from: ['other'], to } }), 'edited since review');
  assert.ok('refused' in planServerEdit(text, 'missing', { command: { from, to } }));
  assert.ok('refused' in planServerEdit('{}', 'engram', { command: { from, to } }));
  assert.equal(ok(planServerEdit(text, 'engram', { command: { from, to: from } })), text, 'no-op keeps bytes');
});

// ---- readLayers / classify ------------------------------------------------------------------

const server = (name, value) => JSON.stringify({ mcp: { servers: { [name]: value } } });

test('layers are ordered by precedence and the target is opencode.jsonc when present', t => {
  const s = sandbox(t);
  s.put(join(s.config, 'opencode.json'), server('a', { type: 'local', command: ['a'] }));
  s.put(join(s.config, 'opencode.jsonc'), '{ /* c */ "mcp": { "servers": { "b": { "type": "local", "command": ["b"], }, }, }, }');
  s.put(join(s.project, 'opencode.json'), server('p', { type: 'local', command: ['p'] }));
  s.put(join(s.project, '.opencode', 'opencode.json'), server('q', { type: 'local', command: ['q'] }));
  s.put(join(s.system, 'opencode', 'opencode.json'), server('s', { type: 'local', command: ['s'] }));
  const layers = s.layers();
  assert.deepEqual(layers.layers.map((layer) => layer.scope), ['global', 'global', 'project', 'project', 'system']);
  assert.deepEqual(layers.layers.map((layer) => layer.rank), [1, 2, 3, 4, 5]);
  assert.equal(layers.target.path, join(s.config, 'opencode.jsonc'));
  assert.equal(layers.target.beforeDigest, sha(fs.readFileSync(layers.target.path)));
  assert.equal(layers.target.text, fs.readFileSync(layers.target.path, 'utf8'));
  assert.deepEqual(layers.blockers, []);
  assert.match(layers.limits, /directorio actual/);
});

test('absent global files target opencode.json with the absent digest', t => {
  const s = sandbox(t);
  const layers = s.layers();
  assert.equal(layers.target.path, join(s.config, 'opencode.json'));
  assert.equal(layers.target.beforeDigest, 'absent');
  assert.equal(layers.target.text, undefined);
  assert.equal(configDigest(undefined), 'absent');
  const c = classify('engram', layers, []);
  assert.equal(c.state, 'absent');
  assert.deepEqual(c.target, layers.target);
});

test('legacy V1 entries are effective and a matching enabled entry is reused without ownership', t => {
  const s = sandbox(t);
  s.put(join(s.config, 'opencode.json'), JSON.stringify({ mcp: { memory: { type: 'local', command: ['/bin/engram', 'mcp', '--tools=agent'] } } }));
  const c = classify('engram', s.layers(), []);
  assert.equal(c.state, 'reuse');
  assert.equal(c.source, 'external');
  assert.equal(c.name, 'memory');
  assert.equal(c.legacy, true);
  assert.equal(classify('engram', s.layers(), [['/bin/engram', 'mcp', '--tools=agent']]).source, 'managed');
});

test('native entries win over legacy ones with the same name in one file', t => {
  const s = sandbox(t);
  s.put(join(s.config, 'opencode.json'), JSON.stringify({
    mcp: { engram: { type: 'local', command: ['legacy'] }, servers: { engram: { type: 'local', command: ['E:/engram.exe', 'mcp'] } } },
  }));
  const c = classify('engram', s.layers(), []);
  assert.equal(c.state, 'reuse');
  assert.equal(c.legacy, false);
});

test('equivalent entries under another name, remote Context7 and CodeGraph forms are recognized', t => {
  const s = sandbox(t);
  s.put(join(s.config, 'opencode.json'), JSON.stringify({ mcp: { servers: {
    docs: { type: 'remote', url: 'https://mcp.context7.com/mcp' },
    graph: { type: 'local', command: ['C:/x/node.exe', '--liftoff-only', 'C:\\x\\lib\\dist\\bin\\codegraph.js', 'serve', '--mcp'] },
  } } }));
  const layers = s.layers();
  assert.equal(classify('context7', layers, []).name, 'docs');
  assert.equal(classify('codegraph', layers, []).name, 'graph');
  assert.equal(classify('engram', layers, []).state, 'absent');
  const npx = { type: 'local', command: ['npx', '-y', '@colbymchenry/codegraph', 'serve', '--mcp'] };
  s.put(join(s.config, 'opencode.json'), server('cg', npx));
  assert.equal(classify('codegraph', s.layers(), []).name, 'cg');
  s.put(join(s.config, 'opencode.json'), server('ctx', { type: 'local', command: ['npx', '@upstash/context7-mcp'] }));
  assert.equal(classify('context7', s.layers(), []).name, 'ctx');
  s.put(join(s.config, 'opencode.json'), server('context7', { type: 'remote', url: 'https://evil.test/mcp.context7.com' }));
  assert.equal(classify('context7', s.layers(), []).why, 'conflict');
});

test('a disabled equivalent entry blocks and is never enabled or aliased', t => {
  const s = sandbox(t);
  s.put(join(s.config, 'opencode.json'), server('engram', { ...ENGRAM, disabled: true }));
  const c = classify('engram', s.layers(), []);
  assert.deepEqual([c.state, c.why], ['blocked', 'disabled']);
  s.put(join(s.config, 'opencode.json'), JSON.stringify({ mcp: { mem: { ...ENGRAM, enabled: false } } }));
  assert.equal(classify('engram', s.layers(), []).why, 'disabled');
});

test('a project override of the canonical name is a visible conflict', t => {
  const s = sandbox(t);
  s.put(join(s.config, 'opencode.json'), server('engram', ENGRAM));
  s.put(join(s.project, 'opencode.json'), server('engram', { type: 'local', command: ['/other/tool'] }));
  const c = classify('engram', s.layers(), []);
  assert.equal(c.state, 'blocked');
  assert.equal(c.why, 'conflict');
  assert.equal(c.scope, 'project');
  assert.equal(c.file, join(s.project, 'opencode.json'));
  // A system layer wins over the project layer too.
  s.put(join(s.system, 'opencode', 'opencode.json'), server('engram', ENGRAM));
  assert.equal(classify('engram', s.layers(), []).state, 'reuse');
});

test('unresolved references make the identity unknown and conflict on the canonical name', t => {
  const s = sandbox(t);
  s.put(join(s.config, 'opencode.json'), server('engram', { type: 'local', command: ['{env:ENGRAM_BIN}', 'mcp'] }));
  const c = classify('engram', s.layers(), []);
  assert.deepEqual([c.state, c.why], ['blocked', 'conflict']);
  assert.match(c.reason, /identidad/);
  s.put(join(s.config, 'opencode.json'), server('context7', { type: 'remote', url: '{env:C7_URL}' }));
  assert.equal(classify('context7', s.layers(), []).why, 'conflict');
});

test('non-matching entries under other names leave the tool absent', t => {
  const s = sandbox(t);
  s.put(join(s.config, 'opencode.json'), server('other', { type: 'local', command: ['x'] }));
  assert.equal(classify('engram', s.layers(), []).state, 'absent');
});

test('environment overrides block writes but still allow reuse', t => {
  const s = sandbox(t);
  for (const env of [{ OPENCODE_CONFIG: join(s.root, 'x.json') }, { OPENCODE_CONFIG_CONTENT: '{}' }, { OPENCODE_CONFIG_DIR: join(s.root, 'elsewhere') }]) {
    const layers = s.layers({ env });
    assert.equal(layers.blockers.length, 1, JSON.stringify(env));
    const c = classify('engram', layers, []);
    assert.deepEqual([c.state, c.why], ['blocked', 'unknown']);
  }
  const same = s.layers({ env: { OPENCODE_CONFIG_DIR: s.config } });
  assert.deepEqual(same.blockers, []);
  s.put(join(s.config, 'opencode.json'), server('engram', ENGRAM));
  assert.equal(classify('engram', s.layers({ env: { OPENCODE_CONFIG: 'x' } }), []).state, 'reuse');
});

test('malformed, duplicate-key or wrongly shaped global files block; project ones are only noted', t => {
  const s = sandbox(t);
  const global = join(s.config, 'opencode.json');
  for (const text of ['{ "mcp": ', '{ "mcp": {}, "mcp": {} }', '[]', '{ "mcp": 1 }', '{ "mcp": { "servers": 1 } }']) {
    s.put(global, text);
    const layers = s.layers();
    assert.equal(layers.blockers.length, 1, text);
    assert.deepEqual([classify('engram', layers, []).state, classify('engram', layers, []).why], ['blocked', 'unknown'], text);
  }
  fs.rmSync(global);
  s.put(join(s.project, 'opencode.json'), '{ broken');
  const layers = s.layers();
  assert.deepEqual(layers.blockers, []);
  assert.equal(layers.notes.length, 1);
  assert.match(layers.notes[0], /ignora/);
  assert.equal(classify('engram', layers, []).state, 'absent');
});

test('a hardlinked or oversized global file is a blocker and is never read as data', t => {
  const s = sandbox(t);
  const global = join(s.config, 'opencode.json');
  const outside = s.put(join(s.root, 'outside.json'), server('engram', ENGRAM));
  fs.linkSync(outside, global);
  let layers = s.layers();
  assert.equal(layers.blockers.length, 1);
  assert.equal(classify('engram', layers, []).state, 'blocked');
  fs.rmSync(global);
  fs.rmSync(outside);
  s.put(global, ' '.repeat(CONFIG_LIMIT + 1));
  layers = s.layers();
  assert.equal(layers.blockers.length, 1);
  assert.match(layers.blockers[0], /4 MiB/);
});

test('a symbolic link as global file is a blocker', t => {
  const s = sandbox(t);
  const outside = s.put(join(s.root, 'outside.json'), '{}');
  try { fs.symlinkSync(outside, join(s.config, 'opencode.json')); }
  catch (error) { t.skip(`symlinks unavailable: ${error.code}`); return; }
  assert.equal(s.layers().blockers.length, 1);
});

// ---- writeGlobalConfig ----------------------------------------------------------------------

const accepts = (name) => (parsed) => parsed?.mcp?.servers?.[name] !== undefined;

test('writes atomically, returns the digest and leaves no temporary file', async t => {
  const s = sandbox(t);
  const path = s.put(join(s.config, 'opencode.jsonc'), '{\n  // keep\n  "model": "a/b"\n}\n');
  const layers = s.layers();
  const next = ok(planServerEdit(layers.target.text, 'engram', { add: ENGRAM }));
  const result = await writeGlobalConfig(layers.target, next, accepts('engram'));
  assert.equal(result.status, 'written');
  assert.equal(fs.readFileSync(path, 'utf8'), next);
  assert.equal(result.digest, sha(fs.readFileSync(path)));
  assert.deepEqual(fs.readdirSync(s.config).filter((name) => name.endsWith('.tmp')), []);
  assert.equal(classify('engram', s.layers(), []).state, 'reuse');
});

test('creates the file and its directory when absent', async t => {
  const s = sandbox(t);
  fs.rmSync(s.config, { recursive: true });
  const layers = s.layers();
  const result = await writeGlobalConfig(layers.target, ok(planServerEdit(undefined, 'engram', { add: ENGRAM })), accepts('engram'));
  assert.equal(result.status, 'written');
  assert.deepEqual(parse(fs.readFileSync(join(s.config, 'opencode.json'), 'utf8')).mcp.servers.engram, ENGRAM);
});

test('a changed digest fails without touching the file', async t => {
  const s = sandbox(t);
  const path = s.put(join(s.config, 'opencode.json'), '{ "model": "a/b" }');
  const layers = s.layers();
  const next = ok(planServerEdit(layers.target.text, 'engram', { add: ENGRAM }));
  const edited = '{ "model": "edited-by-user" }';
  fs.writeFileSync(path, edited);
  const result = await writeGlobalConfig(layers.target, next, accepts('engram'));
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /cambió/);
  assert.equal(fs.readFileSync(path, 'utf8'), edited);
  assert.deepEqual(fs.readdirSync(s.config), ['opencode.json']);
  // A file that appeared after an "absent" review is also refused.
  fs.rmSync(path);
  const absent = s.layers();
  s.put(path, '{}');
  assert.equal((await writeGlobalConfig(absent.target, next, accepts('engram'))).status, 'failed');
  assert.equal(fs.readFileSync(path, 'utf8'), '{}');
});

test('a failing semantic verification is reported with the residual state', async t => {
  const s = sandbox(t);
  const path = s.put(join(s.config, 'opencode.json'), '{}');
  const layers = s.layers();
  const next = ok(planServerEdit(layers.target.text, 'engram', { add: ENGRAM }));
  const result = await writeGlobalConfig(layers.target, next, () => false);
  assert.equal(result.status, 'failed');
  assert.ok(result.residual);
  assert.equal(fs.readFileSync(path, 'utf8'), next, 'no rollback over what was written');
});

test('only the OpenCode config files are writable targets and the size cap applies', async t => {
  const s = sandbox(t);
  const path = s.put(join(s.config, 'settings.json'), '{}');
  assert.equal((await writeGlobalConfig({ path, beforeDigest: configDigest('{}') }, '{}', () => true)).status, 'failed');
  const target = { path: join(s.config, 'opencode.json'), beforeDigest: 'absent' };
  assert.equal((await writeGlobalConfig(target, ' '.repeat(CONFIG_LIMIT + 1), () => true)).status, 'failed');
  assert.ok(!fs.existsSync(target.path));
});

test('a hardlinked target is refused and the other name stays unchanged', async t => {
  const s = sandbox(t);
  const outside = s.put(join(s.root, 'outside.json'), '{"keep":true}');
  const path = join(s.config, 'opencode.json');
  fs.linkSync(outside, path);
  const result = await writeGlobalConfig({ path, beforeDigest: sha(fs.readFileSync(path)) }, '{}', () => true);
  assert.equal(result.status, 'failed');
  assert.equal(fs.readFileSync(outside, 'utf8'), '{"keep":true}');
});

test('a refused plan leaves the file bytes unchanged', t => {
  const s = sandbox(t);
  const text = '{ "mcp": { "servers": { "a": {}, "a": {} } } }';
  const path = s.put(join(s.config, 'opencode.json'), text);
  const before = fs.readFileSync(path);
  assert.ok('refused' in planServerEdit(text, 'engram', { add: ENGRAM }));
  assert.deepEqual(fs.readFileSync(path), before);
});
