import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BASELINE, RELEASE_FILES, changelogBaseline, compareVersions, createGit, headingCount, insertEntry, parseCommits, parseVersion,
  release, releaseMetadata, releaseSource, renderEntry,
} from '../scripts/release.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const json = value => JSON.stringify(value, null, 2) + '\n';

function sh(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

let counter = 0;
function commit(cwd, subject, body = '') {
  writeFileSync(join(cwd, 'work.txt'), `${subject}\n${++counter}\n`);
  sh(cwd, 'add', '--', 'work.txt');
  sh(cwd, 'commit', '-q', '-m', body ? `${subject}\n\n${body}` : subject);
}

/** Isolated repository plus bare origin; its first commit plays the historical baseline. */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mdd-release-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  const origin = join(dir, 'origin.git');
  mkdirSync(root);
  sh(root, 'init', '-q', '-b', 'main');
  for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false'], ['core.autocrlf', 'false']]) sh(root, 'config', key, value);
  writeFileSync(join(root, 'package.json'), json({ name: 'my-driven-development', version: '0.2.0', private: true }));
  writeFileSync(join(root, 'package-lock.json'), json({ name: 'my-driven-development', version: '0.2.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'my-driven-development', version: '0.2.0' } } }));
  writeFileSync(join(root, '.gitignore'), 'dist/\n');
  sh(root, 'add', '.');
  sh(root, 'commit', '-q', '-m', 'feat: baseline');
  mkdirSync(origin);
  sh(origin, 'init', '-q', '--bare');
  sh(root, 'remote', 'add', 'origin', origin);
  sh(root, 'push', '-q', 'origin', 'main');
  return { dir, root, origin, baseline: { version: '0.2.0', commit: sh(root, 'rev-parse', 'HEAD') } };
}

function makeIo({ tty = false, answer } = {}) {
  const out = []; const err = [];
  return { isTTY: tty, out: line => out.push(line), err: line => err.push(line), read: async prompt => { out.push(prompt); return answer; }, outText: () => out.join('\n'), errText: () => err.join('\n') };
}

async function run(context, argv, options = {}) {
  const io = options.io ?? makeIo();
  const code = await release({ root: context.root, argv, io, baseline: context.baseline, git: options.git, writeFile: options.writeFile });
  return { code, io };
}

const originRefs = context => sh(context.origin, 'for-each-ref', '--format=%(refname) %(objectname)');
const snapshot = context => ({
  head: sh(context.root, 'rev-parse', 'HEAD'), tags: sh(context.root, 'tag', '--list'), status: sh(context.root, 'status', '--porcelain=v1', '--untracked-files=all'),
  pkg: readFileSync(join(context.root, 'package.json'), 'utf8'), lock: readFileSync(join(context.root, 'package-lock.json'), 'utf8'),
  changelog: existsSync(join(context.root, 'CHANGELOG.md')) ? readFileSync(join(context.root, 'CHANGELOG.md'), 'utf8') : null,
});

/** Fixture with the baseline tag and a few Conventional Commits on main. */
async function ready(t, { commits = true } = {}) {
  const context = fixture(t);
  assert.equal((await run(context, ['--bootstrap', '--yes'])).code, 0);
  if (commits) {
    commit(context.root, 'feat(settings): add profile selector');
    commit(context.root, 'fix: handle empty config');
    commit(context.root, 'refactor(core)!: drop legacy field', 'Body text\n\nBREAKING CHANGE: the legacy field is gone');
    commit(context.root, 'chore: housekeeping');
    commit(context.root, 'tweak the wording');
  }
  return context;
}

test('version grammar and ordering are numeric and strict', () => {
  for (const bad of ['0.3', 'main', 'HEAD', '1.0.0-rc.1', '0.3.0-preview', '0.3.0-preview.01', '01.2.3', '1.2.3-preview.1+x', '']) assert.equal(parseVersion(bad), undefined, bad);
  assert.equal(parseVersion('v0.3.0-preview.10').preview, 10);
  const ordered = ['0.3.0', '0.3.0-preview.10', '0.2.1', '0.3.0-preview.9', '1.0.0', '0.3.0-preview.2'].map(parseVersion).sort(compareVersions).map(v => v.text);
  assert.deepEqual(ordered, ['0.2.1', '0.3.0-preview.2', '0.3.0-preview.9', '0.3.0-preview.10', '0.3.0', '1.0.0']);
});

test('ordering is exact above Number.MAX_SAFE_INTEGER regardless of input order', () => {
  const list = ['0.3.0-preview.9007199254740993', '0.3.0-preview.9007199254740992', '0.3.0-preview.123456789012345678901234567890', '0.3.0-preview.9'];
  const expected = ['0.3.0-preview.9', '0.3.0-preview.9007199254740992', '0.3.0-preview.9007199254740993', '0.3.0-preview.123456789012345678901234567890'];
  assert.equal(compareVersions(parseVersion(list[1]), parseVersion(list[0])), -1);
  assert.equal(compareVersions(parseVersion(list[0]), parseVersion(list[1])), 1);
  for (const order of [list, [...list].reverse(), [list[1], list[3], list[2], list[0]], [list[2], list[0], list[3], list[1]]]) {
    assert.deepEqual(order.map(parseVersion).sort(compareVersions).map(v => v.text), expected);
  }
});

test('the real baseline constant and npm wiring match the design', () => {
  assert.deepEqual({ ...BASELINE }, { version: '0.2.0', commit: '34a93f67ba405aa50850839c7cc3405374e61544' });
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.release, 'node scripts/release.mjs');
  assert.ok(!pkg.files.some(entry => entry.includes('release')), 'the release script is not packaged');
});

test('CLI entry rejects bad arguments before touching any repository', () => {
  for (const args of [[], ['abc'], ['--nope'], ['--bootstrap', '0.3.0'], ['0.3.0', '0.4.0']]) {
    const result = (() => { try { execFileSync(process.execPath, [join(repoRoot, 'scripts/release.mjs'), ...args], { encoding: 'utf8', stdio: 'pipe' }); return 0; } catch (error) { return error.status; } })();
    assert.equal(result, 2, args.join(' '));
  }
});

test('S6: stable release from clean main updates metadata, changelog, commit and annotated tag; never pushes', async t => {
  const context = await ready(t);
  const before = originRefs(context);
  const base = sh(context.root, 'rev-parse', 'HEAD');
  const { code, io } = await run(context, ['0.3.0', '--yes']);
  assert.equal(code, 0, io.errText());
  assert.equal(JSON.parse(readFileSync(join(context.root, 'package.json'), 'utf8')).version, '0.3.0');
  const lock = JSON.parse(readFileSync(join(context.root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, '0.3.0');
  assert.equal(lock.packages[''].version, '0.3.0');
  assert.equal(sh(context.root, 'status', '--porcelain=v1'), '');
  assert.equal(sh(context.root, 'log', '-1', '--format=%s'), 'chore(release): v0.3.0');
  assert.deepEqual(sh(context.root, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n').sort(), ['CHANGELOG.md', 'package-lock.json', 'package.json']);
  assert.equal(sh(context.root, 'cat-file', '-t', 'v0.3.0'), 'tag', 'annotated');
  assert.equal(sh(context.root, 'rev-parse', 'v0.3.0^{commit}'), sh(context.root, 'rev-parse', 'HEAD'));
  assert.equal(sh(context.root, 'rev-parse', 'HEAD~1'), base);
  assert.equal(JSON.parse(sh(context.root, 'show', 'v0.3.0:package.json')).version, '0.3.0');
  const date = sh(context.root, 'log', '-1', '--format=%cs', 'HEAD');
  const changelog = readFileSync(join(context.root, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /^# Changelog/);
  assert.ok(changelog.includes(`## [0.3.0] - ${date}`));
  assert.ok(changelog.includes(`Estable · cambios desde \`v0.2.0\` (intervalo \`v0.2.0..${base.slice(0, 7)}\`, 5 commits).`));
  assert.match(changelog, /### Cambios incompatibles\n- \*\*core:\*\* the legacy field is gone \(`[0-9a-f]{7}`\)/);
  assert.match(changelog, /### Funcionalidades\n- \*\*settings:\*\* add profile selector/);
  assert.match(changelog, /### Correcciones\n- handle empty config/);
  assert.match(changelog, /### Otros cambios\n- tweak the wording/);
  assert.ok(!changelog.includes('housekeeping'), 'chore is omitted');
  assert.ok(io.outText().includes('Para publicar: git push origin main refs/tags/v0.3.0'));
  assert.equal(originRefs(context), before, 'origin refs unchanged');
  assert.equal(sh(context.origin, 'tag', '--list'), '');
});

test('S7: stable from another branch, dirty trees and detached HEAD are refused without mutation', async t => {
  const context = await ready(t);
  sh(context.root, 'checkout', '-q', '-b', 'feature');
  let before = snapshot(context);
  let result = await run(context, ['0.3.0', '--yes']);
  assert.equal(result.code, 2);
  assert.match(result.io.errText(), /main/);
  assert.deepEqual(snapshot(context), before);

  sh(context.root, 'checkout', '-q', 'main');
  for (const mutate of [
    () => writeFileSync(join(context.root, 'work.txt'), 'edited\n'),
    () => writeFileSync(join(context.root, 'untracked.txt'), 'new\n'),
  ]) {
    mutate();
    before = snapshot(context);
    for (const version of ['0.3.0', '0.3.0-preview.1']) {
      result = await run(context, [version, '--yes']);
      assert.equal(result.code, 2, version);
      assert.match(result.io.errText(), /limpio/);
      assert.deepEqual(snapshot(context), before);
    }
    sh(context.root, 'checkout', '-q', '--', 'work.txt');
    rmSync(join(context.root, 'untracked.txt'), { force: true });
  }

  // Ignored build output does not count as uncommitted source.
  mkdirSync(join(context.root, 'dist'));
  writeFileSync(join(context.root, 'dist/cli.js'), 'x');
  assert.equal((await run(context, ['0.3.0-preview.1', '--dry-run'])).code, 0);

  sh(context.root, 'checkout', '-q', '--detach');
  before = snapshot(context);
  result = await run(context, ['0.3.0-preview.1', '--yes']);
  assert.equal(result.code, 2);
  assert.match(result.io.errText(), /desacoplado/);
  assert.deepEqual(snapshot(context), before);
});

test('S9: preview from a feature branch succeeds; stable afterwards includes previewed changes and still needs main', async t => {
  const context = await ready(t);
  sh(context.root, 'checkout', '-q', '-b', 'feature');
  let result = await run(context, ['0.3.0-preview.1', '--yes']);
  assert.equal(result.code, 0, result.io.errText());
  assert.match(result.io.outText(), /Para publicar: git push origin feature refs\/tags\/v0\.3\.0-preview\.1/);
  assert.equal(sh(context.root, 'rev-parse', 'v0.3.0-preview.1^{commit}'), sh(context.root, 'rev-parse', 'HEAD'));
  assert.match(readFileSync(join(context.root, 'CHANGELOG.md'), 'utf8'), /Preview · cambios desde `v0\.2\.0`/);

  commit(context.root, 'feat: second preview feature');
  result = await run(context, ['0.3.0-preview.2', '--yes']);
  assert.equal(result.code, 0, result.io.errText());
  let changelog = readFileSync(join(context.root, 'CHANGELOG.md'), 'utf8');
  const second = changelog.slice(changelog.indexOf('## [0.3.0-preview.2]'), changelog.indexOf('## [0.3.0-preview.1]'));
  assert.match(second, /cambios desde `v0\.3\.0-preview\.1`/);
  assert.ok(second.includes('second preview feature'));
  assert.ok(!second.includes('add profile selector'), 'preview interval is the previous preview');
  assert.ok(changelog.indexOf('## [0.3.0-preview.2]') < changelog.indexOf('## [0.3.0-preview.1]'), 'newest entry first');

  const before = snapshot(context);
  result = await run(context, ['0.3.0', '--yes']);
  assert.equal(result.code, 2, 'stable still refused off main');
  assert.deepEqual(snapshot(context), before);

  sh(context.root, 'checkout', '-q', 'main');
  sh(context.root, 'merge', '-q', '--ff-only', 'feature');
  result = await run(context, ['0.3.0', '--yes']);
  assert.equal(result.code, 0, result.io.errText());
  changelog = readFileSync(join(context.root, 'CHANGELOG.md'), 'utf8');
  const stable = changelog.slice(changelog.indexOf('## [0.3.0] '), changelog.indexOf('## [0.3.0-preview.2]'));
  assert.match(stable, /cambios desde `v0\.2\.0`/, 'stable interval starts at the previous stable');
  assert.ok(stable.includes('add profile selector') && stable.includes('second preview feature'));
  assert.ok(!stable.includes('chore(release)'), 'release commits are not listed');
  assert.match(stable, /\(intervalo `v0\.2\.0\.\.[0-9a-f]{7}`, 6 commits\)/);
});

test('S10: invalid versions, 0.1, bootstrap-reserved and existing tags are refused before mutation', async t => {
  const context = await ready(t);
  let before = snapshot(context);
  for (const version of ['0.1.0', '0.3', 'main', 'HEAD', '1.0.0-rc.1', '0.3.0-preview.01', '0.2.0', '0.2.0-preview.1', '0.0.9']) {
    const { code, io } = await run(context, [version, '--yes']);
    assert.equal(code, 2, version);
    assert.ok(io.errText().length > 0);
    assert.deepEqual(snapshot(context), before, version);
  }
  assert.match((await run(context, ['0.1.0', '--yes'])).io.errText(), /0\.1 no es instalable/);

  sh(context.root, 'tag', 'v0.3.0', 'HEAD');
  before = snapshot(context);
  let result = await run(context, ['0.3.0', '--yes']);
  assert.equal(result.code, 2);
  assert.match(result.io.errText(), /nunca se sobrescribe/);
  sh(context.root, 'tag', '-d', 'v0.3.0');
  sh(context.root, 'tag', 'v0.3.0', 'HEAD~1');
  const different = sh(context.root, 'rev-parse', 'v0.3.0');
  result = await run(context, ['v0.3.0', '--yes']);
  assert.equal(result.code, 2);
  assert.equal(sh(context.root, 'rev-parse', 'v0.3.0'), different, 'existing tag untouched');
  assert.equal(sh(context.root, 'rev-parse', 'HEAD'), before.head);
});

test('releases must be monotonic and previews order numerically', async t => {
  const context = await ready(t);
  for (const version of ['0.3.0-preview.9', '0.3.0-preview.10']) {
    const { code, io } = await run(context, [version, '--yes']);
    assert.equal(code, 0, `${version}: ${io.errText()}`);
  }
  for (const version of ['0.3.0-preview.9', '0.3.0-preview.2', '0.3.0-preview.10']) assert.equal((await run(context, [version, '--yes'])).code, 2, version);
  assert.equal((await run(context, ['0.3.0-preview.11', '--yes'])).code, 0);
  assert.equal((await run(context, ['v0.3.0', '--yes'])).code, 0, 'leading v accepted');
  assert.equal((await run(context, ['0.3.0-preview.12', '--yes'])).code, 2, 'no preview for an already-stable base');
  assert.equal((await run(context, ['0.2.5', '--yes'])).code, 2, 'stable must exceed the highest stable');
  assert.equal(sh(context.root, 'tag', '--list', 'v0.3.0*').split('\n').length, 4);
});

test('base equality is exact: distinct large major, minor and patch bases are not the same base', async t => {
  const context = await ready(t, { commits: false });
  const cases = [
    ['0.3.9007199254740992', '0.3.9007199254740993-preview.1'],
    ['0.9007199254740992.0', '0.9007199254740993.0-preview.1'],
    ['9007199254740992.0.0', '9007199254740993.0.0-preview.1'],
  ];
  for (const [stable, preview] of cases) {
    sh(context.root, 'tag', `v${stable}`);
    const { code, io } = await run(context, [preview, '--dry-run']);
    assert.equal(code, 0, `${preview}: ${io.errText()}`);
  }
});

test('the true same base still refuses a preview, including with large components', async t => {
  const context = await ready(t, { commits: false });
  for (const stable of ['0.3.0', '0.3.9007199254740993', '9007199254740993.9007199254740993.9007199254740993']) {
    sh(context.root, 'tag', `v${stable}`);
    const { code, io } = await run(context, [`${stable}-preview.1`, '--dry-run']);
    assert.equal(code, 2, stable);
    assert.match(io.errText(), new RegExp(`Ya existe la estable ${stable.replaceAll('.', '\\.')};`));
  }
});

test('confirmation: non-TTY needs --yes, a wrong answer cancels, dry-run prints the entry', async t => {
  const context = await ready(t);
  const before = snapshot(context);
  let result = await run(context, ['0.3.0']);
  assert.equal(result.code, 2);
  assert.deepEqual(snapshot(context), before);

  result = await run(context, ['0.3.0'], { io: makeIo({ tty: true, answer: 'si' }) });
  assert.equal(result.code, 0);
  assert.match(result.io.outText(), /Cancelado/);
  assert.deepEqual(snapshot(context), before);

  result = await run(context, ['0.3.0', '--dry-run']);
  assert.equal(result.code, 0);
  assert.match(result.io.outText(), /## \[0\.3\.0\]/);
  assert.match(result.io.outText(), /Dry run/);
  assert.deepEqual(snapshot(context), before);

  result = await run(context, ['0.3.0'], { io: makeIo({ tty: true, answer: 'release' }) });
  assert.equal(result.code, 0, result.io.errText());
  assert.equal(sh(context.root, 'tag', '--list', 'v0.3.0'), 'v0.3.0');
});

test('metadata safety: lockfile mismatch, unexpected formatting and existing changelog section are refused', async t => {
  let context = await ready(t);
  const lockPath = join(context.root, 'package-lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  lock.packages[''].version = '0.1.9';
  writeFileSync(lockPath, json(lock)); sh(context.root, 'commit', '-q', '-am', 'chore: skew lock');
  let before = snapshot(context);
  let result = await run(context, ['0.3.0', '--yes']);
  assert.equal(result.code, 2);
  assert.match(result.io.errText(), /formato inesperado/i);
  assert.deepEqual(snapshot(context), before);

  context = await ready(t);
  writeFileSync(join(context.root, 'package.json'), readFileSync(join(context.root, 'package.json'), 'utf8').replace('{\n', '{\n\n')); sh(context.root, 'commit', '-q', '-am', 'chore: reformat');
  result = await run(context, ['0.3.0', '--yes']);
  assert.equal(result.code, 2);
  assert.match(result.io.errText(), /formato inesperado/i);

  context = await ready(t);
  writeFileSync(join(context.root, 'CHANGELOG.md'), '# Changelog\n\n## [0.3.0] - 2026-01-01\n\nstale\n');
  sh(context.root, 'add', '.'); sh(context.root, 'commit', '-q', '-m', 'docs: changelog');
  before = snapshot(context);
  result = await run(context, ['0.3.0', '--yes']);
  assert.equal(result.code, 2);
  assert.match(result.io.errText(), /ya hay una sección|ya tiene una sección/);
  assert.deepEqual(snapshot(context), before);
});

test('an existing CHANGELOG keeps its preamble and older entries; the new entry goes first', async t => {
  const context = await ready(t);
  writeFileSync(join(context.root, 'CHANGELOG.md'), '# Changelog\n\nPreámbulo propio.\n\n## [0.2.0] - 2026-10-30\n\nHistórico.\n');
  sh(context.root, 'add', '.'); sh(context.root, 'commit', '-q', '-m', 'docs: add changelog');
  const { code, io } = await run(context, ['0.3.0', '--yes']);
  assert.equal(code, 0, io.errText());
  const text = readFileSync(join(context.root, 'CHANGELOG.md'), 'utf8');
  assert.ok(text.startsWith('# Changelog\n\nPreámbulo propio.\n\n## [0.3.0]'));
  assert.ok(text.endsWith('## [0.2.0] - 2026-10-30\n\nHistórico.\n'));
  assert.equal(text.match(/^## \[/gm).length, 2);
  assert.match(text, /\(intervalo `v0\.2\.0\.\./);
});

test('routine release requires the v0.2.0 baseline tag', async t => {
  const context = fixture(t);
  const before = snapshot(context);
  const { code, io } = await run(context, ['0.3.0', '--yes']);
  assert.equal(code, 2);
  assert.match(io.errText(), /--bootstrap/);
  assert.deepEqual(snapshot(context), before);
  commit(context.root, 'fix: later');
  sh(context.root, 'tag', 'v0.2.0', 'HEAD');
  assert.equal((await run(context, ['0.3.0', '--yes'])).code, 2, 'v0.2.0 elsewhere than the baseline is not accepted');
});

test('S11: bootstrap creates the baseline tag only, is idempotent and never moves a conflicting tag', async t => {
  const context = fixture(t);
  commit(context.root, 'feat: after baseline');
  writeFileSync(join(context.root, 'untracked.txt'), 'dirty tree is fine for bootstrap\n');
  sh(context.root, 'checkout', '-q', '-b', 'other');
  const before = snapshot(context);
  const refs = originRefs(context);

  let result = await run(context, ['--bootstrap'], { io: makeIo({ tty: true, answer: 'no' }) });
  assert.equal(result.code, 0);
  assert.match(result.io.outText(), /Cancelado/);
  assert.equal(sh(context.root, 'tag', '--list'), '');

  result = await run(context, ['--bootstrap', '--yes']);
  assert.equal(result.code, 0, result.io.errText());
  assert.equal(sh(context.root, 'cat-file', '-t', 'v0.2.0'), 'tag');
  assert.equal(sh(context.root, 'rev-parse', 'v0.2.0^{commit}'), context.baseline.commit);
  const after = snapshot(context);
  assert.deepEqual({ ...after, tags: '' }, { ...before, tags: '' }, 'no commit, no file or changelog writes');
  assert.ok(!existsSync(join(context.root, 'CHANGELOG.md')));
  assert.match(result.io.outText(), /git push origin refs\/tags\/v0\.2\.0/);
  assert.equal(originRefs(context), refs);

  const tagObject = sh(context.root, 'rev-parse', 'v0.2.0');
  result = await run(context, ['--bootstrap', '--yes']);
  assert.equal(result.code, 0);
  assert.match(result.io.outText(), /ya existe/);
  assert.equal(sh(context.root, 'rev-parse', 'v0.2.0'), tagObject, 'idempotent: tag object unchanged');

  sh(context.root, 'tag', '-d', 'v0.2.0');
  sh(context.root, 'tag', 'v0.2.0', 'HEAD');
  result = await run(context, ['--bootstrap', '--yes']);
  assert.equal(result.code, 1);
  assert.match(result.io.errText(), /nunca se mueve/);
  assert.equal(sh(context.root, 'rev-parse', 'v0.2.0^{commit}'), sh(context.root, 'rev-parse', 'HEAD'), 'conflicting tag not moved');
});

test('bootstrap validates the baseline commit and package version, and rejects extra arguments', async t => {
  const context = fixture(t);
  let result = await run({ ...context, baseline: { version: '0.2.0', commit: '0123456789abcdef0123456789abcdef01234567' } }, ['--bootstrap', '--yes']);
  assert.equal(result.code, 1);
  result = await run({ ...context, baseline: { version: '9.9.9', commit: context.baseline.commit } }, ['--bootstrap', '--yes']);
  assert.equal(result.code, 1);
  assert.equal(sh(context.root, 'tag', '--list'), '');
  assert.equal((await run(context, ['--bootstrap', '0.3.0'])).code, 2);
  assert.equal((await run(context, ['--bootstrap', '--dry-run'])).code, 2);
});

test('S12: a failed metadata write restores everything; retry regenerates the same entry once', async t => {
  const context = await ready(t);
  const before = snapshot(context);
  const preview = await run(context, ['0.3.0', '--dry-run']);
  const failing = (path, data) => { if (String(path).endsWith('package-lock.json')) throw new Error('disk full'); writeFileSync(path, data); };
  const result = await run(context, ['0.3.0', '--yes'], { writeFile: failing });
  assert.equal(result.code, 1);
  assert.match(result.io.errText(), /el árbol quedó como estaba/);
  assert.ok(!result.io.outText().includes('Listo'));
  assert.ok(!result.io.outText().includes('Para publicar'));
  assert.deepEqual(snapshot(context), before);

  const retry = await run(context, ['0.3.0', '--yes']);
  assert.equal(retry.code, 0, retry.io.errText());
  const changelog = readFileSync(join(context.root, 'CHANGELOG.md'), 'utf8');
  assert.equal(changelog.match(/^## \[0\.3\.0\]/gm).length, 1);
  const entry = preview.io.outText().split('\n').filter(l => l.startsWith('## [0.3.0]') || l.startsWith('Estable'));
  for (const line of entry) assert.ok(changelog.includes(line), line);
});

test('S12: a failed commit restores files and index; retry works', async t => {
  const context = await ready(t);
  const before = snapshot(context);
  const real = createGit(context.root);
  const git = (args, options) => { if (args[0] === 'commit') throw new Error('hook rejected'); return real(args, options); };
  const result = await run(context, ['0.3.0', '--yes'], { git });
  assert.equal(result.code, 1);
  assert.match(result.io.errText(), /el árbol quedó como estaba/);
  assert.deepEqual(snapshot(context), before);
  assert.equal(sh(context.root, 'diff', '--cached', '--name-only'), '', 'index reset');
  assert.equal((await run(context, ['0.3.0', '--yes'])).code, 0);
});

test('S12: a failed tag keeps the commit, reports it truthfully, and retry creates only the tag', async t => {
  const context = await ready(t);
  const real = createGit(context.root);
  const git = (args, options) => { if (args[0] === 'tag' && args[1] === '-a') throw new Error('tag refused'); return real(args, options); };
  let result = await run(context, ['0.3.0', '--yes'], { git });
  assert.equal(result.code, 1);
  assert.match(result.io.errText(), /falta la etiqueta/);
  assert.match(result.io.errText(), /git reset --keep HEAD~1/);
  assert.ok(!result.io.outText().includes('Listo'));
  assert.ok(!result.io.outText().includes('Para publicar'));
  assert.equal(sh(context.root, 'tag', '--list', 'v0.3.0'), '', 'no tag over incomplete metadata');
  assert.equal(sh(context.root, 'log', '-1', '--format=%s'), 'chore(release): v0.3.0');
  const head = sh(context.root, 'rev-parse', 'HEAD');
  const changelog = readFileSync(join(context.root, 'CHANGELOG.md'), 'utf8');

  result = await run(context, ['0.3.0'], { io: makeIo({ tty: false }) });
  assert.equal(result.code, 2, 'resume still needs confirmation');
  result = await run(context, ['0.3.0', '--yes']);
  assert.equal(result.code, 0, result.io.errText());
  assert.match(result.io.outText(), /Reanudación/);
  assert.equal(sh(context.root, 'rev-parse', 'HEAD'), head, 'no second release commit');
  assert.equal(sh(context.root, 'rev-parse', 'v0.3.0^{commit}'), head);
  assert.equal(readFileSync(join(context.root, 'CHANGELOG.md'), 'utf8'), changelog, 'changelog not duplicated');
  assert.equal((await run(context, ['0.3.0', '--yes'])).code, 2, 'now the tag exists and is never overwritten');
});

/**
 * Simulates an automatic tag-only release: a release commit rooted at `source` (default HEAD) that no branch contains,
 * plus an annotated tag. `trailers` replaces the default provenance line; `extraFile` also touches work.txt.
 */
function tagOnly(context, version, { source, trailers, extraFile = false } = {}) {
  const { root } = context;
  const branch = sh(root, 'symbolic-ref', '--short', 'HEAD');
  const src = source ?? sh(root, 'rev-parse', 'HEAD');
  sh(root, 'checkout', '-q', '--detach', src);
  const meta = releaseMetadata(readFileSync(join(root, 'package.json'), 'utf8'), readFileSync(join(root, 'package-lock.json'), 'utf8'), version, { requireLower: false });
  writeFileSync(join(root, 'package.json'), meta.packageText);
  writeFileSync(join(root, 'package-lock.json'), meta.lockText);
  const changelogPath = join(root, 'CHANGELOG.md');
  const entry = renderEntry({ version, date: '2026-01-02', channel: version.includes('preview') ? 'preview' : 'stable', baseTag: 'v0.2.0', headShort: src.slice(0, 7), commits: [] });
  writeFileSync(changelogPath, insertEntry(existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : undefined, entry));
  if (extraFile) writeFileSync(join(root, 'work.txt'), 'sneaky\n');
  sh(root, 'add', '--', ...RELEASE_FILES, ...(extraFile ? ['work.txt'] : []));
  sh(root, 'commit', '-q', '-m', `chore(release): v${version}`);
  const lines = trailers ?? [`Source-Commit: ${src}`];
  sh(root, 'tag', '-a', `v${version}`, '-m', `MDD ${version}\n\nChannel: stable\n${lines.join('\n')}`);
  sh(root, 'checkout', '-q', branch);
  return { tag: `v${version}`, source: src, commit: sh(root, 'rev-parse', `v${version}^{commit}`) };
}

test('S13: a valid tag-only release off main is a base by source ancestry and its CHANGELOG stays cumulative', async t => {
  const context = await ready(t);
  const before = originRefs(context);
  const published = tagOnly(context, '0.3.0');
  assert.equal(sh(context.root, 'branch', '--contains', published.commit), '', 'the release commit is on no branch');
  assert.equal(sh(context.root, 'tag', '--merged', 'HEAD', '--list', 'v0.3.0'), '', 'the old --merged HEAD rule would not see it');
  const git = createGit(context.root);
  assert.equal(releaseSource(git, 'v0.3.0'), published.source);
  commit(context.root, 'feat: after the tag-only release');
  const base = sh(context.root, 'rev-parse', 'HEAD');
  assert.ok(!existsSync(join(context.root, 'CHANGELOG.md')), 'main stays stale: no CHANGELOG on main');

  const { code, io } = await run(context, ['0.3.1', '--yes']);
  assert.equal(code, 0, io.errText());
  const changelog = readFileSync(join(context.root, 'CHANGELOG.md'), 'utf8');
  assert.ok(changelog.indexOf('## [0.3.1]') >= 0 && changelog.indexOf('## [0.3.1]') < changelog.indexOf('## [0.3.0]'), 'new entry first, published entry kept');
  assert.equal(headingCount(changelog, '0.3.0'), 1);
  assert.equal(headingCount(changelog, '0.3.1'), 1);
  assert.ok(changelog.includes(`Estable · cambios desde \`v0.3.0\` (intervalo \`v0.3.0..${base.slice(0, 7)}\`, 1 commits).`));
  assert.ok(changelog.includes('after the tag-only release'));
  assert.ok(!changelog.includes('add profile selector'), 'the interval starts at the recorded source, not at the beginning');
  assert.equal(JSON.parse(sh(context.root, 'show', 'v0.3.1:package.json')).version, '0.3.1');
  assert.equal(sh(context.root, 'rev-parse', 'v0.3.1^'), base);
  assert.equal(releaseSource(git, 'v0.3.1'), base, 'manual tags record their source');
  const message = sh(context.root, 'for-each-ref', '--format=%(contents)', 'refs/tags/v0.3.1');
  assert.match(message, new RegExp(`^MDD 0\\.3\\.1\\n\\nChannel: stable\\nSource-Commit: ${base}$`, 'm'));
  assert.equal(originRefs(context), before, 'origin refs unchanged');
  assert.equal(sh(context.origin, 'tag', '--list'), '');
});

test('S13: a tag-only preview is the base of the next preview and a no-trailer legacy tag still resolves to its commit', async t => {
  const context = await ready(t);
  tagOnly(context, '0.3.0-preview.1');
  commit(context.root, 'fix: later fix');
  const dry = await run(context, ['0.3.0-preview.2', '--dry-run']);
  assert.equal(dry.code, 0, dry.io.errText());
  assert.match(dry.io.outText(), /Intervalo v0\.3\.0-preview\.1\.\.[0-9a-f]{7} \(1 commits\)/);
  const git = createGit(context.root);
  assert.equal(releaseSource(git, 'v0.2.0'), context.baseline.commit, 'legacy annotated tag: its own commit');
  sh(context.root, 'tag', 'v0.2.1', 'HEAD');
  assert.equal(releaseSource(git, 'v0.2.1'), sh(context.root, 'rev-parse', 'HEAD'), 'lightweight tag: its own commit');
});

test('S13: a release whose source is not an ancestor of HEAD is not chosen as the base', async t => {
  const context = await ready(t);
  sh(context.root, 'checkout', '-q', '-b', 'side');
  commit(context.root, 'feat: only on side');
  const sideHead = sh(context.root, 'rev-parse', 'HEAD');
  sh(context.root, 'checkout', '-q', 'main');
  tagOnly(context, '0.2.5', { source: sideHead });
  commit(context.root, 'fix: on main');
  const dry = await run(context, ['0.3.0', '--dry-run']);
  assert.equal(dry.code, 0, dry.io.errText());
  assert.match(dry.io.outText(), /Intervalo v0\.2\.0\.\./, 'falls back to the highest release reachable by source');
  assert.match(dry.io.outText(), /\(6 commits\)/);
});

test('S13: malformed, duplicate or mismatched Source-Commit provenance is refused before any change', async t => {
  const cases = [
    ['malformed', () => ['Source-Commit: not-a-sha']],
    ['short', ctx => [`Source-Commit: ${sh(ctx.root, 'rev-parse', '--short', 'HEAD')}`]],
    ['empty', () => ['Source-Commit:']],
    ['duplicate', ctx => { const head = sh(ctx.root, 'rev-parse', 'HEAD'); return [`Source-Commit: ${head}`, `Source-Commit: ${head}`]; }],
    ['not the only parent', ctx => [`Source-Commit: ${sh(ctx.root, 'rev-parse', 'HEAD~1')}`]],
    ['unknown commit', () => [`Source-Commit: ${'f'.repeat(40)}`]],
  ];
  for (const [name, trailers] of cases) {
    const context = await ready(t);
    tagOnly(context, '0.3.0', { trailers: trailers(context) });
    const git = createGit(context.root);
    assert.throws(() => releaseSource(git, 'v0.3.0'), /Source-Commit/, name);
    const before = snapshot(context); const refs = originRefs(context);
    const { code, io } = await run(context, ['0.4.0', '--yes']);
    assert.equal(code, 2, name);
    assert.match(io.errText(), /Procedencia inválida/, name);
    assert.deepEqual(snapshot(context), before, name);
    assert.equal(originRefs(context), refs, name);
  }
  const context = await ready(t);
  tagOnly(context, '0.3.0', { extraFile: true });
  assert.throws(() => releaseSource(createGit(context.root), 'v0.3.0'), /exactamente package\.json, package-lock\.json, CHANGELOG\.md/);
  assert.equal((await run(context, ['0.4.0', '--yes'])).code, 2, 'a release commit with an extra file');
  assert.throws(() => releaseSource(createGit(context.root), 'v9.9.9'), /no existe/);
});

test('S13: manual safeguards still hold with tag-only releases around: named branch, clean tree, no push', async t => {
  const context = await ready(t);
  tagOnly(context, '0.3.0');
  const refs = originRefs(context);
  sh(context.root, 'checkout', '-q', '-b', 'feature');
  let before = snapshot(context);
  let result = await run(context, ['0.3.1', '--yes']);
  assert.equal(result.code, 2);
  assert.match(result.io.errText(), /main/);
  assert.deepEqual(snapshot(context), before);
  sh(context.root, 'checkout', '-q', 'main');
  writeFileSync(join(context.root, 'untracked.txt'), 'x\n');
  before = snapshot(context);
  result = await run(context, ['0.3.1', '--yes']);
  assert.equal(result.code, 2);
  assert.match(result.io.errText(), /limpio/);
  assert.deepEqual(snapshot(context), before);
  rmSync(join(context.root, 'untracked.txt'));
  assert.equal((await run(context, ['0.3.0', '--yes'])).code, 2, 'the published tag is never overwritten');
  assert.equal((await run(context, ['0.2.9', '--yes'])).code, 2, 'stable must exceed the published stable');
  assert.equal(originRefs(context), refs);
});

test('shared helpers: RELEASE_FILES, parseCommits(head), headingCount, insertEntry', async t => {
  assert.deepEqual([...RELEASE_FILES], ['package.json', 'package-lock.json', 'CHANGELOG.md']);
  assert.ok(Object.isFrozen(RELEASE_FILES));
  const context = await ready(t);
  const git = createGit(context.root);
  const all = parseCommits(git, 'v0.2.0');
  assert.equal(all.length, 5);
  assert.equal(all[0].hash.length, 40);
  assert.equal(all[0].sha, all[0].hash.slice(0, 7));
  assert.deepEqual(parseCommits(git, 'v0.2.0', 'HEAD~3').map(c => c.type), ['feat', 'fix']);
  assert.deepEqual(parseCommits(git, 'HEAD', 'HEAD'), []);
  assert.equal(headingCount('## [1.0.0] - x\n## [1.0.0-preview.1] - y\n', '1.0.0'), 1);
  const entry = renderEntry({ version: '1.0.0', date: '2026-01-01', channel: 'stable', baseTag: 'v0.2.0', headShort: 'abcdef0', commits: [] });
  assert.match(entry, /Sin cambios relevantes/);
  const text = insertEntry('# T\r\n\r\n## [0.9.0] - a\r\n', entry);
  assert.ok(text.indexOf('## [1.0.0]') < text.indexOf('## [0.9.0]'));
  assert.ok(!/[^\r]\n/.test(text), 'CRLF preserved');
});

test('releaseMetadata is pure and strict', () => {
  const pkg = { name: 'my-driven-development', version: '0.3.0', private: true };
  const lock = { name: 'my-driven-development', version: '0.3.0', lockfileVersion: 3, packages: { '': { name: 'my-driven-development', version: '0.3.0' } } };
  const result = releaseMetadata(json(pkg), json(lock), '0.4.0');
  assert.equal(result.current, '0.3.0');
  assert.equal(JSON.parse(result.packageText).version, '0.4.0');
  assert.equal(JSON.parse(result.lockText).packages[''].version, '0.4.0');
  assert.throws(() => releaseMetadata(json(pkg), json(lock), '0.3.0'), /no es menor/);
  assert.throws(() => releaseMetadata(json(pkg), json(lock), '0.2.0'), /no es menor/);
  assert.equal(JSON.parse(releaseMetadata(json(pkg), json(lock), '0.2.0', { requireLower: false }).packageText).version, '0.2.0', 'automatic engine: no lower-version rule');
  assert.throws(() => releaseMetadata(json(pkg), json(lock), 'v0.4.0'), /no soportada/);
  assert.throws(() => releaseMetadata(json(pkg), json(lock), '0.4.0-rc.1'), /no soportada/);
  assert.throws(() => releaseMetadata(json({ ...pkg, name: 'other' }), json(lock), '0.4.0'), /nombre del paquete/);
  assert.throws(() => releaseMetadata(json(pkg), json({ ...lock, name: 'other' }), '0.4.0'), /nombre del paquete/);
  assert.throws(() => releaseMetadata(json(pkg), json({ ...lock, version: '0.1.0' }), '0.4.0'), /no coincide/);
  assert.throws(() => releaseMetadata(JSON.stringify(pkg), json(lock), '0.4.0'), /formato inesperado/i);
  assert.throws(() => releaseMetadata('{', json(lock), '0.4.0'), /Formato inesperado/);
});

test('changelogBaseline: working text when the base tag is an ancestor, the tag copy when it is not', async t => {
  const context = await ready(t);
  const git = createGit(context.root);
  assert.equal(changelogBaseline(git, 'v0.2.0', 'HEAD', 'working'), 'working', 'ancestor tag');
  assert.equal(changelogBaseline(git, 'v0.2.0', 'HEAD', undefined), undefined);
  tagOnly(context, '0.3.0');
  const tagCopy = execFileSync('git', ['show', 'v0.3.0:CHANGELOG.md'], { cwd: context.root, encoding: 'utf8' }); // untrimmed
  assert.match(tagCopy, /## \[0\.3\.0\]/);
  assert.equal(changelogBaseline(git, 'v0.3.0', 'HEAD', 'stale working'), tagCopy);
  assert.equal(changelogBaseline(git, 'v0.3.0', 'HEAD', undefined), tagCopy);
  assert.throws(() => changelogBaseline(git, 'v7.7.7', 'HEAD', 'x'), /no existe/);
  // An off-main tag whose tree has no CHANGELOG falls back to the working copy.
  sh(context.root, 'checkout', '-q', '-b', 'side');
  commit(context.root, 'fix: side only');
  sh(context.root, 'tag', 'v0.2.2');
  sh(context.root, 'checkout', '-q', 'main');
  commit(context.root, 'fix: advance main');
  assert.equal(changelogBaseline(git, 'v0.2.2', 'HEAD', 'w'), 'w');
  assert.equal(changelogBaseline(git, 'v0.3.0', 'HEAD', 'w'), tagCopy);
});
