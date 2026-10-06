import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

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
  assert.equal(JSON.parse(explicit.stdout).score, 20);
});

test('CLI applies configured threshold boundary and optional exploration', () => {
  const boundary = invoke('--answers', answers, '--config', 'examples/config.json');
  const saved = invoke('--profile', profile, '--config', 'examples/config.json');
  assert.equal(boundary.status, 0);
  assert.equal(saved.status, 0);
  assert.equal(boundary.stdout, saved.stdout);
  const result = JSON.parse(boundary.stdout);
  assert.equal(result.score, 50);
  assert.equal(result.route, 'high');
  const explored = invoke('--explore', '--answers', answers);
  assert.equal(explored.status, 0);
  assert.equal(JSON.parse(explored.stdout).phases[0], 'mdd-explore');
});

test('help is standalone, succeeds, and identifies dry-run and exit semantics', () => {
  const result = invoke('--help');
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /simulación: la CLI no ejecuta ninguna fase/);
  assert.match(result.stdout, /Códigos de salida: 0/);
});

for (const args of [
  [], ['--answers'], ['--answers', '--explore'], ['--answers', ''],
  ['--answers', answers, '--profile', profile],
  ['--answers', answers, '--answers', answers],
  ['--answers', answers, '--config', 'examples/config.json', '--config', 'examples/config.json'],
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

test('CLI rejects malformed config/profile and incomplete profiles without prompting', (t) => {
  const malformed = temporaryFile(t, '{');
  const partial = temporaryFile(t, '{"answers":{"certainty":"very-sure"}}');
  for (const args of [
    ['--profile', malformed], ['--answers', answers, '--config', malformed],
    ['--profile', partial],
  ]) {
    const result = invoke(...args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
  }
  assert.match(invoke('--profile', partial).stderr, /answers.artifactStore.*complete answer set/);
});

test('CLI rejects nonfinite and invalid config values parsed from JSON', (t) => {
  for (const contents of ['{"threshold":1e309}', '{"threshold":-1}', '{"weights":{"mode":{"automatic":"5"}}}']) {
    const result = invoke('--answers', answers, '--config', temporaryFile(t, contents));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /nonnegative safe integer/);
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
  assert.equal(JSON.parse(result.stdout).score, 20);
});
