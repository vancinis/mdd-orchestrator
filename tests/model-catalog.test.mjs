import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listModels, listVariants, opencodeBinary, providersOf, MODEL_LIMIT } from '../dist/model-catalog.js';

function pathWith(t, name) {
  const root = mkdtempSync(join(tmpdir(), 'mdd-catalog-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, name), 'launcher');
  return { root, env: { PATH: root } };
}

test('the launcher is resolved through PATH only, per platform', t => {
  const win = pathWith(t, 'opencode.exe');
  assert.equal(opencodeBinary(win.env, 'win32'), join(win.root, 'opencode.exe'));
  assert.equal(opencodeBinary(win.env, 'linux'), undefined);
  const posix = pathWith(t, 'opencode');
  assert.equal(opencodeBinary(posix.env, 'linux'), join(posix.root, 'opencode'));
  assert.equal(opencodeBinary({ PATH: '' }, 'linux'), undefined);
  assert.equal(opencodeBinary({}, 'linux'), undefined);
});

// Regression: a .cmd/.ps1 shim earlier in PATH used to shadow the real executable, and
// Node cannot spawn those without a shell, so the catalog silently looked unavailable.
test('an earlier shim never shadows a real executable later in PATH', t => {
  const shim = pathWith(t, 'opencode.cmd');
  const real = pathWith(t, 'opencode.exe');
  const env = { PATH: `${shim.root};${real.root}` };
  assert.equal(opencodeBinary(env, 'win32'), join(real.root, 'opencode.exe'));
  assert.equal(listModels(() => assert.fail('must not execute'), { PATH: shim.root }, 'win32').status, 'unavailable');
});

test('catalog output is parsed, de-duplicated, sorted and stripped of ANSI', t => {
  const { env, root } = pathWith(t, 'opencode');
  const calls = [];
  const execute = (binary, args, options) => {
    calls.push({ binary, args, options });
    return 'zai/glm-1\n\u001b[32mopenai/gpt-b\u001b[0m\n  openai/gpt-a  \nopenai/gpt-a\n\nnot a model\n';
  };
  const result = listModels(execute, env, 'linux');
  assert.deepEqual(result, { status: 'ok', models: ['openai/gpt-a', 'openai/gpt-b', 'zai/glm-1'] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].binary, join(root, 'opencode'));
  assert.deepEqual(calls[0].args, ['models']);
  assert.equal(calls[0].options.timeout, 30000);
  assert.equal(calls[0].options.windowsHide, true);
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'ignore']);
  assert.deepEqual(providersOf(result.models), ['openai', 'zai']);
});

for (const [name, execute] of Object.entries({
  'a failing launcher': () => { throw new Error('exit 1'); },
  'empty output': () => '',
  'output without any model line': () => 'no models configured\n',
  'an oversized list': () => Array.from({ length: MODEL_LIMIT + 1 }, (_, i) => `p/m${i}`).join('\n'),
})) {
  test(`unavailable is a normal outcome: ${name}`, t => {
    const { env } = pathWith(t, 'opencode');
    const result = listModels(execute, env, 'linux');
    assert.equal(result.status, 'unavailable');
    assert.ok(result.reason.length > 0);
  });
}

test('a missing launcher never executes anything', () => {
  const result = listModels(() => assert.fail('must not execute'), { PATH: '' }, 'linux');
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /PATH/);
});

const VERBOSE_SAMPLE = [
  'anthropic/claude-sonnet-4-5',
  '{',
  '  "id": "claude-sonnet-4-5",',
  '  "providerID": "anthropic",',
  '  "variants": {',
  '    "high": { "effort": "high" },',
  '    "low": { "effort": "low" }',
  '  }',
  '}',
  'anthropic/claude-haiku-4-5',
  '{',
  '  "id": "claude-haiku-4-5",',
  '  "providerID": "anthropic",',
  '  "variants": {}',
  '}',
].join('\n');

test('variants are parsed per model, sorted, from the verbose catalog of one provider', t => {
  const { env, root } = pathWith(t, 'opencode');
  const calls = [];
  const execute = (binary, args, options) => { calls.push({ binary, args, options }); return VERBOSE_SAMPLE; };
  const result = listVariants('anthropic', execute, env, 'linux');
  assert.deepEqual(result, {
    status: 'ok',
    variants: { 'anthropic/claude-sonnet-4-5': ['high', 'low'], 'anthropic/claude-haiku-4-5': [] },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].binary, join(root, 'opencode'));
  assert.deepEqual(calls[0].args, ['api', 'model.list']);
  assert.equal(calls[0].options.timeout, 30000);
});

test('an unknown provider token never executes anything', () => {
  const result = listVariants('../bad', () => assert.fail('must not execute'), { PATH: '' }, 'linux');
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /Proveedor/);
});

for (const [name, execute] of Object.entries({
  'a failing launcher': () => { throw new Error('exit 1'); },
  'empty output': () => '',
  'output with an unparsable block': () => 'zai/glm-1\n{\n  "variants": [\n}\n',
})) {
  test(`variants tolerate ${name} without throwing`, t => {
    const { env } = pathWith(t, 'opencode');
    const result = listVariants('zai', execute, env, 'linux');
    if (name === 'a failing launcher') { assert.equal(result.status, 'unavailable'); assert.ok(result.reason.length > 0); }
    else assert.deepEqual(result, { status: 'ok', variants: {} });
  });
}

test('a missing launcher never executes anything for variants either', () => {
  const result = listVariants('openai', () => assert.fail('must not execute'), { PATH: '' }, 'linux');
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /PATH/);
});
test('V2 API variants use IDs, filter the requested provider and never expose provider settings', t => {
  const { env } = pathWith(t, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
  const result = listVariants('openai', () => JSON.stringify({ data: [
    { providerID: 'openai', id: 'model', variants: [{ id: 'high' }, { id: 'low' }], settings: { apiKey: 'not-output' } },
    { providerID: 'other', id: 'foreign', variants: [{ id: 'foreign' }] },
  ] }), env);
  assert.deepEqual(result, { status: 'ok', variants: { 'openai/model': ['high', 'low'] } });
  assert.equal(JSON.stringify(result).includes('not-output'), false);
});
