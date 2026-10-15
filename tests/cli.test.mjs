import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { defaultSettings } from '../dist/settings.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const answers = 'examples/answers.json';
const profile = 'examples/profile.json';
const invoke = (...args) => {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
};

function temporaryFile(t, contents) {
  const directory = mkdtempSync(join(tmpdir(), 'mdd-proof-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'input with spaces.json');
  writeFileSync(path, contents, 'utf8');
  return path;
}

test('CLI emits JSON for explicit answers and byte-identical complete profile output', () => {
  const explicit = invoke('--answers', answers);
  const saved = invoke('--profile', profile);
  assert.equal(explicit.status, 0);
  assert.equal(saved.status, 0);
  assert.equal(explicit.stderr, '');
  assert.equal(saved.stderr, '');
  assert.equal(explicit.stdout, saved.stdout);
  const result = JSON.parse(explicit.stdout);
  assert.deepEqual(result.phases, ['mdd-explore']);
  assert.equal('score' in result, false);
  assert.equal('route' in result, false);
});

test('AL05b CLI: explicit version two preserves output; version three requires native context without fixed execution', () => {
  const ordinary = invoke('--answers', answers);
  assert.equal(invoke('--answers', answers, '--routing-version', '2').stdout, ordinary.stdout);
  assert.equal(invoke('--profile', profile, '--routing-version', '2').stdout, ordinary.stdout);
  const native = invoke('--answers', answers, '--routing-version', '3');
  assert.equal(native.status, 2); assert.equal(native.stdout, '');
  assert.match(native.stderr, /native-context-required/);
  for (const args of [['--routing-version'], ['--routing-version', '3', '--routing-version', '2'], ['--routing-version', '3.0'], ['--routing-version', '4']]) {
    const result = invoke('--answers', answers, ...args);
    assert.equal(result.status, 2); assert.equal(result.stdout, '');
  }
});

test('CLI accepts the legacy explore flag and refuses the removed scoring config', t => {
  const explored = invoke('--explore', '--answers', answers);
  assert.equal(explored.status, 0);
  assert.equal(explored.stdout, invoke('--answers', answers).stdout);
  const config = invoke('--answers', answers, '--config', temporaryFile(t, '{"threshold":50}'));
  assert.equal(config.status, 2);
  assert.equal(config.stdout, '');
  assert.match(config.stderr, /--config ya no existe: las respuestas del preflight no se puntúan/);
});

test('help is standalone, succeeds, and identifies dry-run and exit semantics', () => {
  const result = invoke('--help');
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /simulación: la CLI no ejecuta ninguna fase/);
  assert.match(result.stdout, /Códigos de salida: 0/);
  assert.match(result.stdout, /mdd-ai workers status \| on \| off/);
});

for (const args of [
  [], ['--answers'], ['--answers', '--explore'], ['--answers', ''],
  ['--answers', answers, '--profile', profile],
  ['--answers', answers, '--answers', answers],
  ['--answers', answers, '--config', answers],
  ['--answers', answers, '--explore', '--explore'],
  ['--unknown'], [answers], ['--help', '--answers', answers],
  ['--answers', answers, '--explore', 'false'],
]) {
  test(`CLI rejects invalid arguments: ${JSON.stringify(args)}`, () => {
    const result = invoke(...args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Error de MDD:/);
  });
}

for (const contents of ['{', '', '{"certainty":}', 'null', '[]', '{}', '{"certainty":"very-sure"}']) {
  test(`CLI rejects malformed or incomplete answer JSON: ${JSON.stringify(contents)}`, (t) => {
    const result = invoke('--answers', temporaryFile(t, contents));
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /malformed JSON|answers/);
  });
}

test('CLI rejects malformed profiles and incomplete profiles without prompting', (t) => {
  const malformed = temporaryFile(t, '{');
  const partial = temporaryFile(t, '{"answers":{"certainty":"very-sure"}}');
  for (const args of [
    ['--profile', malformed], ['--profile', partial],
  ]) {
    const result = invoke(...args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
  }
  assert.match(invoke('--profile', partial).stderr, /answers.artifactStore.*complete answer set/);
});

test('CLI refuses --config whatever it holds, before reading it', (t) => {
  for (const contents of ['{"threshold":1e309}', '{"threshold":-1}', '{', '{}']) {
    const result = invoke('--answers', answers, '--config', temporaryFile(t, contents));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--config ya no existe/);
    assert.equal(result.stdout, '');
  }
});

test('CLI file I/O failure is distinct from invalid input and never emits a result', (t) => {
  const existing = temporaryFile(t, '{}');
  const result = invoke('--answers', `${existing}.missing`);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /ENOENT/);
});

test('CLI accepts UTF-8 BOM and spaces in file paths', (t) => {
  const contents = '\uFEFF' + JSON.stringify({
    certainty: 'very-sure', artifactStore: 'none', mode: 'automatic',
    summary: 'low',
  });
  const result = invoke('--answers', temporaryFile(t, contents));
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout).phases, ['mdd-explore']);
});

function workerCLI(t) {
  const home = mkdtempSync(join(tmpdir(), 'mdd-workers-cli-'));
  const workspace = mkdtempSync(join(tmpdir(), 'mdd-workers-workspace-'));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });
  const settingsPath = join(home, 'opencode/mdd/mdd.config.json');
  return { home, workspace, settingsPath, run: (...args) => {
    const result = spawnSync(process.execPath, [cli, 'workers', ...args], {
      cwd: workspace, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home },
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  } };
}

test('workers CLI status is read-only; on/off persist only the global preference', t => {
  const { home, workspace, settingsPath, run } = workerCLI(t);
  const status = run('status');
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout), { enabled: true });
  assert.deepEqual(readdirSync(home), []);
  assert.equal(run('off').status, 0);
  assert.deepEqual(JSON.parse(run('status').stdout), { enabled: false });
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.deepEqual(settings, { ...defaultSettings(), workers: { enabled: false } });
  settings.telemetry.enabled = false;
  settings.profiles.work = { models: { 'mdd-apply': 'provider/model' }, answers: { mode: 'interactive' } };
  settings.activeProfile = 'work';
  writeFileSync(settingsPath, JSON.stringify(settings));
  const on = run('on');
  assert.equal(on.status, 0, on.stderr);
  assert.match(on.stdout, /Restart OpenCode/);
  assert.match(on.stdout, /dispatch remains sequential/);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), { ...settings, workers: { enabled: true } });
  const before = readFileSync(settingsPath, 'utf8');
  assert.deepEqual(JSON.parse(run('status').stdout), { enabled: true });
  assert.equal(readFileSync(settingsPath, 'utf8'), before);
  assert.deepEqual(readdirSync(workspace), []);
});

test('workers CLI rejects invalid actions and invalid settings without writes', t => {
  const { settingsPath, run } = workerCLI(t);
  for (const args of [[], ['enable'], ['status', 'extra'], ['off', 'extra'], ['on', 'extra'], ['--help']]) {
    const result = run(...args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /workers status \| on \| off/);
    assert.equal(existsSync(settingsPath), false);
  }
  assert.equal(run('off').status, 0);
  const invalid = JSON.stringify({ ...defaultSettings(), workers: { enabled: 'false' } });
  writeFileSync(settingsPath, invalid);
  for (const action of ['status', 'on', 'off']) {
    const result = run(action);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /workers.enabled must be boolean/);
    assert.equal(readFileSync(settingsPath, 'utf8'), invalid);
  }
});
