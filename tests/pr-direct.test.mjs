import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { directChanges } from '../dist/pr-direct.js';

/**
 * A real repository, because what is under test is what git reports: a fake would only restate
 * the assumptions the reader was written with.
 */
function repository(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'mdd-pr-direct-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=MDD', '-c', 'user.email=mdd@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (name, text) => { fs.mkdirSync(join(root, name, '..'), { recursive: true }); fs.writeFileSync(join(root, name), text); };
  git('init', '-q', '-b', 'staging');
  write('src/title.ts', 'export const title = "Hola";\n');
  write('.gitignore', 'build/\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  return { root, git, write };
}

test('a direct edit lists committed, unstaged and untracked work against the PR target branch', async t => {
  const { root, git, write } = repository(t);
  git('checkout', '-q', '-b', 'feature');
  write('src/title.ts', 'export const title = "Buen día";\n');
  git('commit', '-q', '-am', 'title');
  write('.gitignore', 'build/\ncoverage/\n');
  write('src/new.ts', 'export {};\n');
  // Ignored output is not part of any PR and must never demand a reason.
  write('build/out.js', 'ignored\n');
  const changes = await directChanges(root, 'staging');
  assert.equal(changes.baseRef, 'staging');
  assert.match(changes.baseCommit, /^[a-f0-9]{40}$/);
  assert.deepEqual(changes.files, ['.gitignore', 'src/new.ts', 'src/title.ts']);
});

// A stale local copy of the target branch would sweep work other people already merged into the
// table, so the remote branch the PR is opened against wins over a local one of the same name.
test('the remote target branch wins over a stale local branch of the same name', async t => {
  const { root, git, write } = repository(t);
  write('src/merged.ts', 'export const merged = true;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'merged by someone else');
  git('update-ref', 'refs/remotes/origin/staging', 'HEAD');
  git('reset', '-q', '--hard', 'HEAD~1');
  git('checkout', '-q', '-b', 'feature', 'origin/staging');
  write('src/title.ts', 'export const title = "Buen día";\n');
  const changes = await directChanges(root, 'staging');
  assert.equal(changes.baseRef, 'origin/staging');
  assert.deepEqual(changes.files, ['src/title.ts']);
  assert.deepEqual((await directChanges(root, 'origin/staging')).files, ['src/title.ts']);
});

test('a direct edit with nothing to describe, or an unknown or malformed target, is refused', async t => {
  const { root, git } = repository(t);
  git('checkout', '-q', '-b', 'feature');
  await assert.rejects(directChanges(root, 'staging'), /Nothing differs from staging/);
  await assert.rejects(directChanges(root, 'release'), /origin\/release \/ release is not a branch/);
  await assert.rejects(directChanges(root, '--output=x'), /plain ref/);
  await assert.rejects(directChanges(root, 'staging..main'), /plain ref/);
});

test('a workspace that is not a git checkout says so instead of listing nothing', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'mdd-pr-direct-plain-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(directChanges(root, 'staging'), /not a readable Git checkout/);
});
