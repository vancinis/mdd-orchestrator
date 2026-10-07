import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { test } from 'node:test';

const inspect = async (...args) => (await import('../dist/judgment-day.js')).inspectJudgmentTarget(...args);
function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'mdd-jd-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '--quiet'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(join(root, 'source.txt'), 'committed source\n');
  git('add', '--', 'source.txt'); git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
  const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(join(root, 'source.txt'), 'committed delta\n');
  git('add', '--', 'source.txt'); git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'delta');
  return { root, git, base, commit: git('rev-parse', 'HEAD') };
}

test('immutable inspection returns committed trees/blobs/diffs, never dirty or untracked source', async t => {
  const f = fixture(t);
  fs.writeFileSync(join(f.root, 'source.txt'), 'DIRTY LIVE CONTENT');
  fs.writeFileSync(join(f.root, 'untracked.txt'), 'UNTRACKED CONTENT');
  const blob = await inspect(f.root, { operation: 'blob', commit: f.commit, path: 'source.txt' });
  assert.equal(blob.content, 'committed delta\n'); assert.equal(blob.commit, f.commit);
  const tree = await inspect(f.root, { operation: 'tree', commit: f.commit });
  assert.match(tree.content, /source\.txt/); assert.doesNotMatch(tree.content, /untracked/);
  const diff = await inspect(f.root, { operation: 'diff', commit: f.commit, base: f.base });
  assert.match(diff.content, /-committed source/); assert.match(diff.content, /\+committed delta/);
  assert.doesNotMatch(diff.content, /DIRTY|UNTRACKED/);
  await assert.rejects(inspect(f.root, { operation: 'blob', commit: f.commit, path: 'untracked.txt' }));
});

test('immutable inspection rejects refs, flags, revision expressions, unsafe paths and unknown arguments', async t => {
  const f = fixture(t);
  assert.equal((await inspect(f.root, { operation: 'blob', commit: f.commit, path: 'source.txt' })).content, 'committed delta\n');
  for (const commit of ['HEAD', f.commit.slice(0, 12), `${f.commit}:source.txt`, `${f.commit}^`, '--help', 'a'.repeat(39), 'a'.repeat(41)]) {
    await assert.rejects(inspect(f.root, { operation: 'tree', commit }));
  }
  for (const path of ['../outside', '/absolute', 'C:/outside', 'source.txt:other', '.git/config', 'a\\b', ':(top)*', '--output=outside', 'x\nfile', 'a/../b']) {
    await assert.rejects(inspect(f.root, { operation: 'blob', commit: f.commit, path }));
  }
  for (const change of [{ operation: 'shell' }, { command: 'git status' }, { env: { GIT_EXTERNAL_DIFF: 'evil' } }, { base: 'HEAD' }]) {
    await assert.rejects(inspect(f.root, { operation: 'blob', commit: f.commit, path: 'source.txt', ...change }));
  }
  const blob = f.git('rev-parse', `${f.commit}:source.txt`);
  await assert.rejects(inspect(f.root, { operation: 'tree', commit: blob }), /commit/);
});

test('immutable inspection disables external diff, textconv, replacement objects and injected Git environment', async t => {
  const f = fixture(t);
  const trap = join(f.root, 'executed');
  const command = `node -e "require('fs').writeFileSync('${trap.replaceAll('\\', '/')}', 'executed')"`;
  f.git('config', 'diff.external', command);
  f.git('config', 'diff.evil.textconv', command);
  fs.writeFileSync(join(f.root, '.gitattributes'), 'source.txt diff=evil\n');
  f.git('add', '--', '.gitattributes'); f.git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'attributes');
  const commit = f.git('rev-parse', 'HEAD');
  const previous = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); });
  process.env.GIT_EXTERNAL_DIFF = command; process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = 'diff.external'; process.env.GIT_CONFIG_VALUE_0 = command;
  await inspect(f.root, { operation: 'diff', commit, base: f.base });
  assert.equal(fs.existsSync(trap), false);
  delete process.env.GIT_CONFIG_COUNT; delete process.env.GIT_CONFIG_KEY_0; delete process.env.GIT_CONFIG_VALUE_0;
  f.git('replace', f.commit, f.base);
  assert.equal((await inspect(f.root, { operation: 'blob', commit: f.commit, path: 'source.txt' })).content, 'committed delta\n');
});

test('immutable inspection fails closed on oversized output, binary blobs and cancellation', async t => {
  const f = fixture(t);
  assert.match((await inspect(f.root, { operation: 'tree', commit: f.commit })).content, /source\.txt/);
  fs.writeFileSync(join(f.root, 'large.txt'), 'x'.repeat(200000));
  fs.writeFileSync(join(f.root, 'binary'), Buffer.from([0xff, 0xfe, 0x00]));
  fs.writeFileSync(join(f.root, 'nul-blob'), Buffer.from([0x61, 0x00, 0x62]));
  f.git('add', '--', 'large.txt', 'binary', 'nul-blob'); f.git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'bounded');
  const commit = f.git('rev-parse', 'HEAD');
  await assert.rejects(inspect(f.root, { operation: 'blob', commit, path: 'large.txt' }));
  await assert.rejects(inspect(f.root, { operation: 'blob', commit, path: 'binary' }));
  await assert.rejects(inspect(f.root, { operation: 'blob', commit, path: 'nul-blob' }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(inspect(f.root, { operation: 'tree', commit }, controller.signal));
});

test('immutable diffs cannot hide committed text changes through dirty working-tree attributes', async t => {
  const f = fixture(t);
  fs.writeFileSync(join(f.root, '.gitattributes'), 'source.txt -diff\n');
  const diff = await inspect(f.root, { operation: 'diff', commit: f.commit, base: f.base });
  assert.match(diff.content, /-committed source/);
  assert.match(diff.content, /\+committed delta/);
});

test('immutable inspection never launches a Git executable supplied by the target checkout', async t => {
  const f = fixture(t);
  const previous = process.env.PATH;
  t.after(() => { process.env.PATH = previous; });
  // A non-Git executable would fail if lookup selected the review target instead of trusted PATH.
  fs.copyFileSync(process.execPath, join(f.root, process.platform === 'win32' ? 'git.exe' : 'git'));
  process.env.PATH = `${f.root}${delimiter}${previous}`;
  assert.equal((await inspect(f.root, { operation: 'blob', commit: f.commit, path: 'source.txt' })).content, 'committed delta\n');
});
