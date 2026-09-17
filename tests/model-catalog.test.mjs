import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listModels, opencodeBinary, providersOf, MODEL_LIMIT } from '../dist/model-catalog.js';

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
