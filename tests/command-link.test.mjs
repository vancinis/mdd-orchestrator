import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { COMMAND, commandPlan, launcherFiles, launcherTarget, registerPath, writeLaunchers } from '../dist/command-link.js';
import { installationPaths } from '../dist/installation-paths.js';
import { isolateHome } from './adapter-fixture.mjs';

function fixture(t) {
  const home = isolateHome(t);
  const paths = installationPaths({ home, env: { ...process.env, XDG_CONFIG_HOME: home } });
  fs.mkdirSync(paths.ownedRoot, { recursive: true });
  return { home, paths };
}

test('the launcher resolves the CLI relative to itself, not to a pinned interpreter', () => {
  const files = launcherFiles();
  assert.deepEqual(files.map(file => file.name).sort(), [COMMAND, `${COMMAND}.cmd`].sort());
  for (const file of files) {
    assert.match(file.content, /node_modules[\\/]my-driven-development[\\/]dist[\\/]cli\.js/);
    assert.doesNotMatch(file.content, /[A-Za-z]:\\/, 'no absolute install path is baked in');
    assert.ok(file.content.endsWith('\n') || file.content.endsWith('\r\n'));
  }
  assert.match(files.find(file => file.name.endsWith('.cmd')).content, /%\*/);
  assert.match(files.find(file => file.name === COMMAND).content, /^#!\/bin\/sh/);
});

test('planning reports what is missing without writing anything', t => {
  const { paths } = fixture(t);
  const plan = commandPlan({ PATH: '/somewhere/else' }, paths);
  assert.equal(plan.binRoot, paths.binRoot);
  assert.equal(plan.onPath, false);
  assert.deepEqual(plan.files.map(file => file.action), ['create', 'create']);
  assert.equal(fs.existsSync(paths.binRoot), false, 'planning writes nothing');
  assert.match(plan.manual, new RegExp(plan.binRoot.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
});

test('an already listed directory is recognised, case-insensitively on Windows', t => {
  const { paths } = fixture(t);
  const listed = commandPlan({ PATH: ['/first', paths.binRoot, '/last'].join(delimiter) }, paths);
  assert.equal(listed.onPath, true);
  const trailing = commandPlan({ PATH: `${paths.binRoot}${process.platform === 'win32' ? '\\' : '/'}` }, paths);
  assert.equal(trailing.onPath, true);
  if (process.platform === 'win32') {
    assert.equal(commandPlan({ PATH: paths.binRoot.toUpperCase() }, paths).onPath, true);
  }
});

test('writing launchers is idempotent and repairs a modified launcher', t => {
  const { paths } = fixture(t);
  const written = writeLaunchers(paths);
  assert.deepEqual(written.map(file => file.action), ['keep', 'keep']);
  for (const file of written) assert.ok(fs.existsSync(file.path), file.path);
  const cmd = join(paths.binRoot, `${COMMAND}.cmd`);
  const original = fs.readFileSync(cmd, 'utf8');
  fs.writeFileSync(cmd, 'echo stale\r\n');
  assert.equal(commandPlan(process.env, paths).files.find(file => file.name === `${COMMAND}.cmd`).action, 'update');
  writeLaunchers(paths);
  assert.equal(fs.readFileSync(cmd, 'utf8'), original);
  assert.equal(launcherTarget(paths.binRoot), paths.cliPath);
});

test('PATH registration only appends its own folder to the user scope', t => {
  const { paths } = fixture(t);
  if (process.platform !== 'win32') {
    assert.equal(registerPath(paths.binRoot, () => assert.fail('no shell on this platform')), 'manual');
    return;
  }
  let call;
  assert.equal(registerPath(paths.binRoot, (file, args, options) => { call = { file, args, options }; }), 'registered');
  assert.equal(call.file, 'powershell');
  assert.ok(call.args.includes('-NoProfile') && call.args.includes('-NonInteractive'));
  const script = call.args.at(-1);
  // The path travels in the environment, never interpolated into the script text.
  assert.doesNotMatch(script, /[A-Za-z]:\\/);
  assert.equal(call.options.env.MDD_BIN_PATH, paths.binRoot);
  assert.match(script, /'User'/);
  assert.doesNotMatch(script, /'Machine'/);
  assert.match(script, /if \(\$entries -contains \$bin\) \{ exit 0 \}/);
});

test('the wizard installs the launcher and the command runs the real CLI', async t => {
  const { paths } = fixture(t);
  const { runSetupUI } = await import('../dist/setup-ui.js');
  const answers = ['', 'apply'];
  const io = { isTTY: true, read: async () => answers.shift(), write: () => {} };
  const root = join(paths.configRoot);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(join(root, 'package.json'), '{"name":"consumer","private":true,"type":"module"}\n');
  const pkg = join(paths.ownedRoot, 'node_modules/my-driven-development');
  fs.mkdirSync(pkg, { recursive: true });
  fs.cpSync('dist', join(pkg, 'dist'), { recursive: true });
  fs.copyFileSync('package.json', join(pkg, 'package.json'));
  fs.cpSync('assets', join(pkg, 'assets'), { recursive: true });
  fs.writeFileSync(join(paths.ownedRoot, 'package.json'), '{"private":true}');
  await runSetupUI(root, io, {
    detect: () => ({ status: 'not-found' }),
    installMemory: () => { throw new Error('Unexpected download'); },
    installPackage: () => { throw new Error('Unexpected package install'); },
    check: async () => ({ ready: true, checks: [] }),
    registerPath: () => assert.fail('installing must never edit PATH by itself'),
  });
  for (const file of launcherFiles()) assert.ok(fs.existsSync(join(paths.binRoot, file.name)), file.name);
  const { execFileSync } = await import('node:child_process');
  const windows = process.platform === 'win32';
  const launcher = join(paths.binRoot, windows ? `${COMMAND}.cmd` : COMMAND);
  const output = windows
    ? execFileSync('cmd', ['/d', '/c', launcher, '--help'], { encoding: 'utf8', timeout: 60000, windowsHide: true })
    : execFileSync(launcher, ['--help'], { encoding: 'utf8', timeout: 60000 });
  assert.match(output, /MDD global setup and routing proof/);
  assert.match(output, new RegExp(`${COMMAND} link`));
});
