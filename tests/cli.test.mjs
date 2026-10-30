import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function isolated(t) {
  const home = mkdtempSync(join(tmpdir(), 'mdd-cli-home-'));
  const workspace = mkdtempSync(join(tmpdir(), 'mdd-cli-workspace-'));
  t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(workspace, { recursive: true, force: true }); });
  const run = (...args) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: workspace, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home },
    });
    assert.ifError(result.error);
    return result;
  };
  return { home, workspace, run };
}

test('help lists every command and the exit codes', t => {
  const { run } = isolated(t);
  const result = run('--help');
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  for (const command of ['setup', 'update', 'link', 'doctor', 'config', 'profile list']) assert.match(result.stdout, new RegExp(`mdd-ai ${command}`));
  assert.match(result.stdout, /Códigos de salida: 0/);
});

test('profile create, use and list change only the global settings file', t => {
  const { home, workspace, run } = isolated(t);
  assert.equal(run('profile', 'create', 'work').status, 0);
  assert.equal(run('profile', 'use', 'default').status, 0);
  const list = run('profile', 'list');
  assert.equal(list.status, 0);
  assert.equal(list.stdout, '* default\n  work\n');
  assert.deepEqual(readdirSync(join(home, 'opencode', 'mdd')), ['mdd.config.json']);
  assert.deepEqual(readdirSync(workspace), []);
});

for (const args of [[], ['--unknown'], ['workers', 'status'], ['telemetry', 'status'], ['retro'], ['--answers', 'x.json'], ['doctor', 'extra'], ['config', 'extra'], ['profile', 'use']]) {
  test(`invalid or retired arguments exit with 2: ${JSON.stringify(args)}`, t => {
    const { run } = isolated(t);
    const result = run(...args);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Error de MDD:/);
  });
}

test('doctor prints a JSON report and exits 1 when MDD is not installed', t => {
  const { run } = isolated(t);
  const result = run('doctor');
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ready, false);
  assert.ok(report.checks.some(check => check.check === 'installed-package' && check.status === 'action'));
});
