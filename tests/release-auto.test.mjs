import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RELEASE_FILES, releaseSource } from '../scripts/release.mjs';
import {
  ApiError, PublishError, annotate, bumpLevel, bumpVersion, createAutoGit, createGitHubClient, createReleaseCommit, findPublished, hasSkipMarker,
  highestStable, isMetadataRelease, main, nextPreview, nextStable, parseTagMessage, planVersion, previewIneligibility, publishRelease, publishTag,
  previewWork, publishedTagNames, readTagProvenance, remoteTagState, renderTagMessage, runPlan, runPublish, stableWork, syncReleaseTags,
  validationVerdict, verifyReleaseCommit,
} from '../scripts/release-auto.mjs';

const json = value => JSON.stringify(value, null, 2) + '\n';
const slash = path => path.replaceAll('\\', '/');

function sh(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

let counter = 0;
function commit(cwd, subject, body = '') {
  writeFileSync(join(cwd, 'work.txt'), `${subject}\n${++counter}\n`);
  sh(cwd, 'add', '--', 'work.txt');
  sh(cwd, 'commit', '-q', '-m', body ? `${subject}\n\n${body}` : subject);
  return sh(cwd, 'rev-parse', 'HEAD');
}

function identify(root) {
  for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false'], ['core.autocrlf', 'false']]) sh(root, 'config', key, value);
}

const PACKAGE = { name: 'my-driven-development', version: '0.3.2', private: true };
const LOCK = { name: 'my-driven-development', version: '0.3.2', lockfileVersion: 3, requires: true, packages: { '': { name: 'my-driven-development', version: '0.3.2' } } };

/** Disposable repository (stable v0.3.2 on `main`) plus a local bare origin. Nothing outside a temp directory is touched. */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mdd-auto-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  const origin = join(dir, 'origin.git');
  mkdirSync(root);
  sh(root, 'init', '-q', '-b', 'main');
  identify(root);
  writeFileSync(join(root, 'package.json'), json(PACKAGE));
  writeFileSync(join(root, 'package-lock.json'), json(LOCK));
  sh(root, 'add', '.');
  sh(root, 'commit', '-q', '-m', 'feat: baseline');
  sh(root, 'tag', '-a', 'v0.3.2', '-m', 'MDD 0.3.2 (línea base)');
  mkdirSync(origin);
  sh(origin, 'init', '-q', '--bare', '-b', 'main');
  sh(root, 'remote', 'add', 'origin', origin);
  sh(root, 'push', '-q', 'origin', 'main', 'v0.3.2');
  return { dir, root, origin, git: createAutoGit(root) };
}

function clone(context, name) {
  const root = join(context.dir, name);
  sh(context.dir, 'clone', '-q', context.origin, root);
  identify(root);
  return { root, git: createAutoGit(root) };
}

const remoteRefs = context => sh(context.origin, 'for-each-ref', '--format=%(refname) %(objectname)');
const remoteTags = context => sh(context.origin, 'tag', '--list').split('\n').filter(Boolean);
const localState = context => ({
  head: sh(context.root, 'rev-parse', 'HEAD'), heads: sh(context.root, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'),
  status: sh(context.root, 'status', '--porcelain=v1', '--untracked-files=all'), pkg: readFileSync(join(context.root, 'package.json'), 'utf8'),
});
const wrap = (git, intercept) => (args, options) => intercept(args, options, git);

test('bump level: breaking > feat > patch fallback, exact numeric arithmetic', () => {
  const c = (type, breaking = false) => ({ type, breaking });
  assert.equal(bumpLevel([c('fix'), c('feat'), c('refactor', true)]), 'major');
  assert.equal(bumpLevel([c('fix'), c('feat'), c('docs')]), 'minor');
  for (const only of [[c('fix')], [c('docs'), c('chore'), c('test'), c('ci'), c('revert')], [c(undefined)], []]) assert.equal(bumpLevel(only), 'patch');
  assert.equal(bumpVersion('0.3.2', 'major'), '1.0.0');
  assert.equal(bumpVersion('0.3.2', 'minor'), '0.4.0');
  assert.equal(bumpVersion('0.3.2', 'patch'), '0.3.3');
  assert.equal(bumpVersion('9007199254740993.0.9007199254740993', 'patch'), '9007199254740993.0.9007199254740994');
  assert.equal(bumpVersion('1.99999999999999999999.3', 'major'), '2.0.0');
  assert.equal(bumpVersion('1.99999999999999999999.3', 'minor'), '1.100000000000000000000.0');
  assert.throws(() => bumpVersion('0.4.0-preview.1', 'patch'), /inválida/);
  assert.throws(() => bumpVersion('0.3.2', 'huge'), /desconocido/);
});

test('allocation: stable and global-highest-preview previews', () => {
  const tags = ['v0.3.2', 'v0.4.0-preview.1'];
  assert.equal(highestStable(tags), '0.3.2');
  assert.equal(nextPreview(tags, 'patch'), '0.4.0-preview.2');
  assert.equal(nextPreview(tags, 'minor'), '0.4.0-preview.2');
  assert.equal(nextPreview(tags, 'major'), '1.0.0-preview.1');
  assert.equal(nextStable(tags, 'patch'), '0.3.3');
  const released = [...tags, 'v0.4.0'];
  assert.equal(nextPreview(released, 'patch'), '0.4.1-preview.1');
  assert.equal(nextPreview(released, 'major'), '1.0.0-preview.1');
  assert.equal(nextStable(released, 'minor'), '0.5.0');
  // The global highest preview wins over a lower predicted base, even across several previews and numeric order.
  const many = ['v0.3.2', 'v0.5.0-preview.9', 'v0.5.0-preview.10', 'v0.4.0-preview.30'];
  assert.equal(nextPreview(many, 'patch'), '0.5.0-preview.11');
  assert.equal(nextPreview(['v0.3.2', 'v0.3.3-preview.1'], 'patch'), '0.3.3-preview.2');
  assert.equal(nextPreview(['v0.3.2', 'v0.5.0-preview.9007199254740993'], 'patch'), '0.5.0-preview.9007199254740994');
  // Invalid names and previews at or below the highest stable never affect the result.
  assert.equal(nextPreview(['v0.3.2', 'v0.3.0-preview.7', 'vx', 'v1.0.0-rc.1', 'v01.0.0'], 'patch'), '0.3.3-preview.1');
  assert.throws(() => nextStable(['v1.0.0-preview.1'], 'patch'), /estable previa/);
});

test('tag provenance renders and parses strictly', () => {
  const sha = 'a'.repeat(40);
  const full = { version: '0.4.0-preview.1', channel: 'preview', source: sha, pullRequest: '12', mainCommit: 'b'.repeat(40), previousStable: 'v0.3.2', workflowRun: '99' };
  const message = renderTagMessage(full);
  assert.equal(message, `MDD 0.4.0-preview.1\n\nChannel: preview\nSource-Commit: ${sha}\nPull-Request: 12\nMain-Commit: ${'b'.repeat(40)}\nPrevious-Stable: v0.3.2\nWorkflow-Run: 99\n`);
  assert.deepEqual(parseTagMessage(message, '0.4.0-preview.1'), { version: '0.4.0-preview.1', channel: 'preview', source: sha, pullRequest: '12', mainCommit: 'b'.repeat(40), previousStable: 'v0.3.2', workflowRun: '99' });
  assert.equal(parseTagMessage(renderTagMessage({ version: '0.3.3', channel: 'stable', source: sha }), '0.3.3').pullRequest, undefined);
  const base = `MDD 0.3.3\n\nChannel: stable\nSource-Commit: ${sha}`;
  const bad = {
    'header version': base.replace('MDD 0.3.3', 'MDD v0.3.3'), 'no blank': base.replace('\n\n', '\n'), 'unknown key': `${base}\nExtra: 1`,
    duplicate: `${base}\nSource-Commit: ${sha}`, 'short sha': base.replace(sha, 'abc123'), 'upper sha': base.replace(sha, 'A'.repeat(40)),
    'wrong channel': base.replace('stable', 'preview'), 'bad channel': base.replace('stable', 'beta'), 'blank in trailers': `${base}\n\nWorkflow-Run: 1`,
    'bad run': `${base}\nWorkflow-Run: 0`, 'preview previous stable': `${base}\nPrevious-Stable: v0.4.0-preview.1`, 'extra space': `${base}\nWorkflow-Run:  5`,
    missing: 'MDD 0.3.3\n\nChannel: stable', 'wrong expected': base,
  };
  for (const [name, text] of Object.entries(bad)) assert.throws(() => parseTagMessage(text, name === 'wrong expected' ? '0.3.4' : '0.3.3'), Error, name);
  assert.throws(() => renderTagMessage({ ...full, pullRequest: '1\nChannel: stable' }), /duplicado|inválido|reconocida/);
});

test('publishes a preview from a PR head tag-only and leaves branches, worktree and index alone', async t => {
  const context = fixture(t);
  const main = commit(context.root, 'fix: main fix');
  sh(context.root, 'checkout', '-q', '-b', 'pr');
  commit(context.root, 'feat(settings): add selector');
  const head = sh(context.root, 'rev-parse', 'HEAD');
  sh(context.root, 'checkout', '-q', 'main');
  sh(context.root, 'push', '-q', 'origin', 'main', 'pr');
  const before = localState(context);
  const refsBefore = remoteRefs(context);

  const result = await publishRelease(context.git, { source: head, channel: 'preview', trailers: { pullRequest: '7', mainCommit: main, workflowRun: '5' }, date: '2026-11-13' });
  assert.equal(result.status, 'published');
  assert.equal(result.tag, 'v0.4.0-preview.1');
  assert.equal(result.attempts, 1);
  assert.deepEqual(localState(context), before);

  // Remote: exactly one new ref, an annotated tag whose peeled commit is the release commit.
  const added = remoteRefs(context).split('\n').filter(line => !refsBefore.split('\n').includes(line));
  assert.equal(added.length, 1);
  assert.match(added[0], /^refs\/tags\/v0\.4\.0-preview\.1 /);
  assert.equal(sh(context.origin, 'cat-file', '-t', 'refs/tags/v0.4.0-preview.1'), 'tag');
  assert.equal(sh(context.origin, 'rev-parse', 'refs/tags/v0.4.0-preview.1^{commit}'), result.commit);
  assert.equal(sh(context.origin, 'rev-parse', 'refs/tags/v0.4.0-preview.1'), result.object);

  // Release commit: sole parent is the exact source; only the three metadata files changed; everything else is intact.
  assert.equal(sh(context.root, 'rev-list', '--parents', '-n', '1', result.commit), `${result.commit} ${head}`);
  assert.deepEqual(sh(context.root, 'diff-tree', '--no-commit-id', '--name-only', '-r', result.commit).split('\n').sort(), [...RELEASE_FILES].sort());
  assert.equal(sh(context.root, 'rev-parse', `${result.commit}:work.txt`), sh(context.root, 'rev-parse', `${head}:work.txt`));
  assert.equal(JSON.parse(sh(context.root, 'show', `${result.commit}:package.json`)).version, '0.4.0-preview.1');
  const lock = JSON.parse(sh(context.root, 'show', `${result.commit}:package-lock.json`));
  assert.equal(lock.version, '0.4.0-preview.1');
  assert.equal(lock.packages[''].version, '0.4.0-preview.1');
  const changelog = sh(context.root, 'show', `${result.commit}:CHANGELOG.md`);
  assert.equal(changelog.split('\n').filter(line => line.startsWith('## [0.4.0-preview.1]')).length, 1);
  assert.match(changelog, /\*\*settings:\*\* add selector/);
  assert.equal(releaseSource(context.git, 'v0.4.0-preview.1'), head);

  const info = readTagProvenance(context.git, 'v0.4.0-preview.1');
  assert.deepEqual(info.meta, { version: '0.4.0-preview.1', channel: 'preview', source: head, pullRequest: '7', mainCommit: main, previousStable: 'v0.3.2', workflowRun: '5' });
  assert.equal(sh(context.root, 'log', '-1', '--format=%an <%ae>', result.commit), 'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>');
  assert.equal(sh(context.root, 'log', '-1', '--format=%s', result.commit), 'chore(release): v0.4.0-preview.1');
});

test('is idempotent per source and channel; channels are independent; cumulative CHANGELOG survives tag-only releases', async t => {
  const context = fixture(t);
  const first = commit(context.root, 'fix: first');
  sh(context.root, 'push', '-q', 'origin', 'main');
  const one = await publishRelease(context.git, { source: first, channel: 'stable' });
  assert.equal(one.tag, 'v0.3.3');
  const again = await publishRelease(context.git, { source: first, channel: 'stable' });
  assert.equal(again.status, 'exists');
  assert.equal(again.tag, 'v0.3.3');
  assert.deepEqual(remoteTags(context), ['v0.3.2', 'v0.3.3']);

  // Same source, other channel: independent tag; preview base is above the stable.
  const preview = await publishRelease(context.git, { source: first, channel: 'preview' });
  assert.equal(preview.status, 'published');
  assert.equal(preview.tag, 'v0.3.4-preview.1');
  assert.equal((await publishRelease(context.git, { source: first, channel: 'preview' })).status, 'exists');

  // A rerun from a fresh clone (no local tags) recognizes the same source through the remote.
  const other = clone(context, 'other');
  sh(other.root, 'tag', '-d', 'v0.3.3', 'v0.3.4-preview.1');
  assert.equal((await publishRelease(other.git, { source: first, channel: 'stable' })).status, 'exists');

  // The next stable keeps the previous entry although main never carried a CHANGELOG (tag-only baseline).
  const second = commit(context.root, 'feat: second');
  sh(context.root, 'push', '-q', 'origin', 'main');
  const two = await publishRelease(context.git, { source: second, channel: 'stable' });
  assert.equal(two.tag, 'v0.4.0');
  const changelog = sh(context.root, 'show', `${two.commit}:CHANGELOG.md`);
  assert.ok(changelog.indexOf('## [0.4.0]') >= 0 && changelog.indexOf('## [0.4.0]') < changelog.indexOf('## [0.3.3]'));
  assert.match(changelog, /first/);
  assert.equal(sh(context.root, 'ls-tree', 'main', '--', 'CHANGELOG.md'), '');
  assert.equal(releaseSource(context.git, 'v0.4.0'), second);
  assert.deepEqual(findPublished(context.git, { source: second, channel: 'stable' }).map(info => info.tag), ['v0.4.0']);
});

test('pre-push race with another source: the foreign tag is untouched and the version is recomputed', async t => {
  const context = fixture(t);
  const mine = commit(context.root, 'fix: mine');
  sh(context.root, 'push', '-q', 'origin', 'main');
  const rival = clone(context, 'rival');
  const theirs = commit(rival.root, 'fix: theirs');
  sh(rival.root, 'push', '-q', 'origin', 'main');
  const attempts = [];
  let theirTag;
  const result = await publishRelease(context.git, {
    source: mine, channel: 'stable',
    beforePush: async info => {
      attempts.push(info.tag);
      if (info.attempt === 1) theirTag = await publishRelease(rival.git, { source: theirs, channel: 'stable' });
    },
  });
  assert.equal(theirTag.tag, 'v0.3.3');
  assert.deepEqual(attempts, ['v0.3.3', 'v0.3.4']);
  assert.equal(result.tag, 'v0.3.4');
  assert.equal(result.attempts, 2);
  assert.equal(sh(context.origin, 'rev-parse', 'refs/tags/v0.3.3'), theirTag.object);
  assert.equal(sh(context.origin, 'rev-parse', 'refs/tags/v0.3.3^{commit}'), theirTag.commit);
  assert.equal(sh(context.origin, 'rev-parse', 'refs/tags/v0.3.4^{commit}'), result.commit);
  assert.equal(releaseSource(context.git, 'v0.3.4'), mine);
  const changelog = sh(context.root, 'show', `${result.commit}:CHANGELOG.md`);
  assert.ok(changelog.includes('## [0.3.4]') && changelog.includes('## [0.3.3]'));
  assert.deepEqual(remoteTags(context), ['v0.3.2', 'v0.3.3', 'v0.3.4']);
});

test('pre-push race with the same source and channel: the existing tag is recognized, nothing duplicates', async t => {
  const context = fixture(t);
  const source = commit(context.root, 'fix: shared');
  sh(context.root, 'push', '-q', 'origin', 'main');
  const rival = clone(context, 'rival');
  let theirTag;
  const result = await publishRelease(context.git, {
    source, channel: 'stable',
    beforePush: async info => { if (info.attempt === 1) theirTag = await publishRelease(rival.git, { source, channel: 'stable' }); },
  });
  assert.equal(result.status, 'exists');
  assert.equal(result.tag, 'v0.3.3');
  assert.deepEqual(remoteTags(context), ['v0.3.2', 'v0.3.3']);
  assert.equal(sh(context.origin, 'rev-parse', 'refs/tags/v0.3.3'), theirTag.object);
  assert.equal(sh(context.root, 'rev-parse', 'refs/tags/v0.3.3'), theirTag.object);
});

test('a differing lightweight tag on the remote is never overwritten; retries are bounded', async t => {
  const context = fixture(t);
  const source = commit(context.root, 'fix: contested');
  sh(context.root, 'push', '-q', 'origin', 'main');
  const baseline = sh(context.root, 'rev-parse', 'v0.3.2^{commit}');
  const contested = [];
  await assert.rejects(
    publishRelease(context.git, {
      source, channel: 'stable',
      beforePush: info => { contested.push(info.tag); sh(context.root, 'push', '-q', 'origin', `${baseline}:refs/tags/${info.tag}`); },
    }),
    error => error instanceof PublishError && error.reason === 'exhausted',
  );
  assert.deepEqual(contested, ['v0.3.3', 'v0.3.4', 'v0.3.5']);
  for (const tag of contested) {
    assert.equal(sh(context.origin, 'cat-file', '-t', `refs/tags/${tag}`), 'commit');
    assert.equal(sh(context.origin, 'rev-parse', `refs/tags/${tag}`), baseline);
  }
  assert.deepEqual(remoteTags(context), ['v0.3.2', ...contested]);
  assert.equal(sh(context.root, 'tag', '--list', '--format=%(objecttype) %(refname:short)', 'v0.3.5'), '');
  const direct = sh(context.root, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads');
  assert.equal(direct, sh(context.origin, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'));
});

test('rejected push leaves the remote alone and the next attempt publishes; lost response is verified through ls-remote', async t => {
  const rejected = fixture(t);
  const source = commit(rejected.root, 'fix: retry');
  sh(rejected.root, 'push', '-q', 'origin', 'main');
  let pushes = 0;
  const refsBefore = remoteRefs(rejected);
  const flaky = wrap(rejected.git, (args, options, git) => {
    if (args[0] === 'push' && ++pushes === 1) {
      assert.deepEqual(remoteRefs(rejected).split('\n'), refsBefore.split('\n'));
      throw new Error('git push: ! [remote rejected] simulated');
    }
    return git(args, options);
  });
  const result = await publishRelease(flaky, { source, channel: 'stable' });
  assert.equal(result.status, 'published');
  assert.equal(result.attempts, 2);
  assert.equal(pushes, 2);
  assert.equal(sh(rejected.origin, 'rev-parse', 'refs/tags/v0.3.3^{commit}'), result.commit);
  assert.equal(sh(rejected.root, 'tag', '--list', 'v0.3.3'), 'v0.3.3');

  const lost = fixture(t);
  const lostSource = commit(lost.root, 'fix: lost');
  sh(lost.root, 'push', '-q', 'origin', 'main');
  const lossy = wrap(lost.git, (args, options, git) => {
    const out = git(args, options);
    if (args[0] === 'push') throw new Error('git push: connection reset after the remote accepted the update');
    return out;
  });
  const done = await publishRelease(lossy, { source: lostSource, channel: 'stable' });
  assert.equal(done.status, 'published');
  assert.equal(done.attempts, 1);
  assert.equal(sh(lost.origin, 'rev-parse', 'refs/tags/v0.3.3'), done.object);
  assert.deepEqual(remoteTags(lost), ['v0.3.2', 'v0.3.3']);
});

test('unknown push result: ls-remote retries are bounded and the outcome fails closed', async t => {
  const stuck = fixture(t);
  const source = commit(stuck.root, 'fix: unknown');
  sh(stuck.root, 'push', '-q', 'origin', 'main');
  let probes = 0;
  let sent = false; // the outage starts after the push; the tag listing that precedes it still works
  const blind = wrap(stuck.git, (args, options, git) => {
    if (args[0] === 'push') sent = true;
    if (args[0] === 'ls-remote' && sent) { probes += 1; throw new Error('git ls-remote: network down'); }
    return git(args, options);
  });
  await assert.rejects(publishRelease(blind, { source, channel: 'stable' }), error => error instanceof PublishError && error.reason === 'unknown');
  assert.equal(probes, 3);
  assert.equal(sh(stuck.root, 'tag', '--list', 'v0.3.3'), 'v0.3.3'); // kept: it may have been published
  assert.deepEqual(remoteTags(stuck), ['v0.3.2', 'v0.3.3']); // no duplicate, no other tag

  const flaky = fixture(t);
  const second = commit(flaky.root, 'fix: transient');
  sh(flaky.root, 'push', '-q', 'origin', 'main');
  let failures = 0;
  let sentOnce = false;
  const transient = wrap(flaky.git, (args, options, git) => {
    if (args[0] === 'push') sentOnce = true;
    if (args[0] === 'ls-remote' && sentOnce && failures < 2) { failures += 1; throw new Error('git ls-remote: timeout'); }
    return git(args, options);
  });
  const result = await publishRelease(transient, { source: second, channel: 'stable' });
  assert.equal(result.status, 'published');
  assert.equal(result.attempts, 1);
  assert.equal(failures, 2);
});

test('publishTag and remoteTagState classify absent, published and conflicting remotes', t => {
  const context = fixture(t);
  const source = commit(context.root, 'fix: classify');
  const releaseCommit = createReleaseCommit(context.git, { source, version: '0.3.3', channel: 'stable', baseTag: 'v0.3.2', commits: [], date: '2026-11-13' });
  annotate(context.git, { version: '0.3.3', commit: releaseCommit, message: renderTagMessage({ version: '0.3.3', channel: 'stable', source }) });
  const object = sh(context.root, 'rev-parse', 'refs/tags/v0.3.3');
  assert.deepEqual(remoteTagState(context.git, 'origin', 'v0.3.3', { object, commit: releaseCommit }), { state: 'absent' });
  assert.throws(() => annotate(context.git, { version: '0.3.3', commit: releaseCommit, message: renderTagMessage({ version: '0.3.3', channel: 'stable', source }) }), /tag/);
  // The unpublished source commit is not on the remote; the push carries it with the tag.
  const pushed = publishTag(context.git, { tag: 'v0.3.3' });
  assert.equal(pushed.status, 'published');
  assert.equal(pushed.object, object);
  assert.equal(pushed.peeled, releaseCommit);
  // Same name, other object -> conflict; a lightweight local tag is refused before any push.
  assert.equal(remoteTagState(context.git, 'origin', 'v0.3.3', { object: 'f'.repeat(40), commit: releaseCommit }).state, 'conflict');
  assert.equal(remoteTagState(context.git, 'origin', 'v0.3.3', { object, commit: 'f'.repeat(40) }).state, 'conflict');
  sh(context.root, 'tag', 'v0.9.9', releaseCommit);
  assert.throws(() => publishTag(context.git, { tag: 'v0.9.9' }), /anotada/);
  assert.deepEqual(remoteTags(context), ['v0.3.2', 'v0.3.3']);
  const rejected = publishTag(context.git, { remote: join(context.dir, 'missing.git'), tag: 'v0.3.3' });
  assert.equal(rejected.status, 'unknown');
  assert.ok(rejected.pushError);
});

test('metadata and structure are strict: nothing is tagged or pushed when the source is not releasable', async t => {
  const context = fixture(t);
  const good = sh(context.root, 'rev-parse', 'HEAD');
  const refsBefore = remoteRefs(context);
  const tagsBefore = sh(context.root, 'tag', '--list');
  const variants = {
    'wrong package name': (pkg, lock) => [json({ ...JSON.parse(pkg), name: 'other' }), lock],
    'non-canonical formatting': (pkg, lock) => [JSON.stringify(JSON.parse(pkg)), lock],
    'lock disagrees': (pkg, lock) => [pkg, json({ ...JSON.parse(lock), version: '9.9.9' })],
  };
  for (const [name, edit] of Object.entries(variants)) {
    sh(context.root, 'checkout', '-q', '-b', `bad-${name.replaceAll(' ', '-')}`, good);
    const [pkg, lock] = edit(readFileSync(join(context.root, 'package.json'), 'utf8'), readFileSync(join(context.root, 'package-lock.json'), 'utf8'));
    writeFileSync(join(context.root, 'package.json'), pkg);
    writeFileSync(join(context.root, 'package-lock.json'), lock);
    sh(context.root, 'commit', '-q', '-a', '-m', `fix: ${name}`);
    const source = sh(context.root, 'rev-parse', 'HEAD');
    sh(context.root, 'push', '-q', 'origin', 'HEAD');
    sh(context.root, 'checkout', '-q', 'main');
    await assert.rejects(publishRelease(context.git, { source, channel: 'stable' }), /Formato inesperado/, name);
  }
  // A CHANGELOG that already has the section for the allocated version is refused too.
  sh(context.root, 'checkout', '-q', '-b', 'dup', good);
  writeFileSync(join(context.root, 'CHANGELOG.md'), '# Changelog\n\n## [0.3.3] - 2026-01-01\n\nx\n');
  sh(context.root, 'add', 'CHANGELOG.md');
  sh(context.root, 'commit', '-q', '-m', 'docs: stale section');
  const dup = sh(context.root, 'rev-parse', 'HEAD');
  sh(context.root, 'push', '-q', 'origin', 'HEAD');
  sh(context.root, 'checkout', '-q', 'main');
  await assert.rejects(publishRelease(context.git, { source: dup, channel: 'stable' }), /ya tiene una sección/);
  assert.equal(sh(context.root, 'tag', '--list'), tagsBefore);
  assert.equal(remoteTags(context).join(','), 'v0.3.2');
  assert.equal(remoteRefs(context).split('\n').filter(line => line.startsWith('refs/tags/')).length, 1);
  assert.ok(refsBefore.includes('refs/tags/v0.3.2'));
  // A non-full source is refused before anything else.
  await assert.rejects(publishRelease(context.git, { source: 'main', channel: 'stable' }), /SHA completo/);
  await assert.rejects(publishRelease(context.git, { source: good, channel: 'beta' }), /Canal desconocido/);
});

test('structure verification rejects extra files, extra parents and a foreign parent', t => {
  const context = fixture(t);
  const source = commit(context.root, 'fix: structural');
  const releaseCommit = createReleaseCommit(context.git, { source, version: '0.3.3', channel: 'stable', baseTag: 'v0.3.2', commits: [], date: '2026-11-13' });
  verifyReleaseCommit(context.git, { commit: releaseCommit, source, version: '0.3.3' });
  assert.throws(() => verifyReleaseCommit(context.git, { commit: releaseCommit, source, version: '0.3.4' }), /Formato inesperado|no coinciden|versiones/);
  const sibling = commit(context.root, 'fix: sibling');
  assert.throws(() => verifyReleaseCommit(context.git, { commit: releaseCommit, source: sibling, version: '0.3.3' }), /único padre/);
  assert.throws(() => verifyReleaseCommit(context.git, { commit: sibling, source, version: '0.3.3' }), /exactamente/);
  const tree = sh(context.root, 'rev-parse', `${releaseCommit}^{tree}`);
  const twoParents = sh(context.root, 'commit-tree', tree, '-p', source, '-p', sibling, '-m', 'merge');
  assert.throws(() => verifyReleaseCommit(context.git, { commit: twoParents, source, version: '0.3.3' }), /único padre/);
  // Changing a fourth file as well as the three is refused.
  const extra = sh(context.root, 'commit-tree', sh(context.root, 'rev-parse', `${sibling}^{tree}`), '-p', releaseCommit, '-m', 'extra');
  assert.throws(() => verifyReleaseCommit(context.git, { commit: extra, source: releaseCommit, version: '0.3.3' }), /exactamente/);
});

test('malformed existing provenance fails closed before any release is built', async t => {
  const context = fixture(t);
  const source = commit(context.root, 'fix: guarded');
  sh(context.root, 'push', '-q', 'origin', 'main');
  const other = clone(context, 'other');
  const odd = sh(other.root, 'rev-parse', 'HEAD');
  sh(other.root, 'tag', '-a', 'v0.3.3', '-m', `MDD 0.3.3\n\nChannel: stable\nSource-Commit: ${odd}\nSource-Commit: ${odd}`, odd);
  sh(other.root, 'push', '-q', 'origin', 'v0.3.3');
  const tagsBefore = remoteTags(context);
  await assert.rejects(publishRelease(context.git, { source, channel: 'stable' }), /más de un Source-Commit/);
  assert.deepEqual(remoteTags(context), tagsBefore);
  assert.equal(sh(context.root, 'tag', '--list', 'v0.3.4'), '');
});

test('planVersion reports level, base and previous stable', t => {
  const context = fixture(t);
  commit(context.root, 'feat(core)!: breaking change');
  const source = sh(context.root, 'rev-parse', 'HEAD');
  assert.deepEqual(planVersion(context.git, { source, channel: 'stable' }), { version: '1.0.0', tag: 'v1.0.0', level: 'major', baseTag: 'v0.3.2', previousStable: 'v0.3.2' });
  assert.equal(planVersion(context.git, { source, channel: 'preview' }).version, '1.0.0-preview.1');
  assert.throws(() => planVersion(context.git, { source, channel: 'beta' }), /Canal desconocido/);
});

test('no candidate hook, filter, textconv or external diff runs while publishing', async t => {
  const context = fixture(t);
  const marker = join(context.dir, 'executed.txt');
  const evil = join(context.dir, 'evil.mjs');
  writeFileSync(evil, `import { writeFileSync, appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(marker)}, 'ran\\n');\nprocess.stdin.on('error', () => {});\nprocess.stdin.pipe(process.stdout);\n`);
  const command = `node "${slash(evil)}"`;
  sh(context.root, 'config', 'filter.evil.clean', command);
  sh(context.root, 'config', 'filter.evil.smudge', command);
  sh(context.root, 'config', 'diff.evil.textconv', command);
  sh(context.root, 'config', 'diff.external', command);
  writeFileSync(join(context.root, '.git', 'info', 'attributes'), 'package.json filter=evil diff=evil\npackage-lock.json filter=evil diff=evil\nCHANGELOG.md filter=evil diff=evil\n');
  for (const hook of ['pre-push', 'pre-commit', 'reference-transaction', 'post-commit']) {
    writeFileSync(join(context.root, '.git', 'hooks', hook), `#!/bin/sh\necho ${hook} >> "${slash(marker)}"\n`, { mode: 0o755 });
  }
  // Sanity: the same configuration does run for ordinary git commands, so a silent marker means the engine avoided it.
  sh(context.root, 'hash-object', 'package.json');
  assert.ok(existsSync(marker), 'the filter fixture must be effective');
  rmSync(marker);
  sh(context.root, 'checkout', '-q', '-b', 'probe');
  writeFileSync(join(context.root, 'probe.txt'), 'x\n');
  sh(context.root, 'add', 'probe.txt');
  sh(context.root, 'commit', '-q', '-m', 'chore: probe');
  assert.ok(existsSync(marker), 'the hook fixture must be effective');
  sh(context.root, 'reset', '-q', '--hard', 'main');
  sh(context.root, 'checkout', '-q', 'main');
  sh(context.root, 'branch', '-q', '-D', 'probe');
  rmSync(marker);

  const source = commit(context.root, 'fix: plain');
  rmSync(marker, { force: true });
  const result = await publishRelease(context.git, { source, channel: 'preview' });
  assert.equal(result.status, 'published');
  assert.equal(existsSync(marker), false, existsSync(marker) ? readFileSync(marker, 'utf8') : '');
  assert.equal(sh(context.origin, 'rev-parse', 'refs/tags/v0.3.3-preview.1^{commit}'), result.commit);
  assert.equal(releaseSource(context.git, 'v0.3.3-preview.1'), source);
  // A tag-only stable as base forces the baseline CHANGELOG to be read from the tag object.
  const stable = await publishRelease(context.git, { source, channel: 'stable' });
  const next = commit(context.root, 'feat: after');
  rmSync(marker, { force: true });
  const later = await publishRelease(context.git, { source: next, channel: 'stable' });
  assert.equal(stable.tag, 'v0.3.3');
  assert.equal(later.tag, 'v0.4.0');
  assert.ok(sh(context.root, 'show', '--no-textconv', `${later.commit}:CHANGELOG.md`).includes('## [0.3.3]'));
  assert.equal(existsSync(marker), false, existsSync(marker) ? readFileSync(marker, 'utf8') : '');
});

// ---------------------------------------------------------------------------------------------------------------------
// T2 uncertainty edge: a local tag cannot establish remote publication
// ---------------------------------------------------------------------------------------------------------------------

// The outage starts with the push: the reconciliation reads (fetch, ls-remote of the tag listing) before it still work, then
// the push is lost and every later ls-remote fails. (A listing failure BEFORE any push is covered by its own test below.)
const blindPush = (git, { applyPush = false } = {}) => {
  let pushed = false;
  return wrap(git, (args, options, inner) => {
    if (args[0] === 'push') { pushed = true; if (applyPush) inner(args, options); throw new Error('git push: connection lost'); }
    if (args[0] === 'ls-remote' && pushed) throw new Error('git ls-remote: network down');
    return inner(args, options);
  });
};

test('retry in the SAME clone after an unknown outcome with an absent remote publishes instead of reporting exists', async t => {
  const c = fixture(t);
  const source = commit(c.root, 'fix: unknown then retry');
  sh(c.root, 'push', '-q', 'origin', 'main');
  await assert.rejects(publishRelease(blindPush(c.git), { source, channel: 'stable' }), error => error instanceof PublishError && error.reason === 'unknown');
  assert.equal(sh(c.root, 'tag', '--list', 'v0.3.3'), 'v0.3.3'); // kept locally...
  assert.deepEqual(remoteTags(c), ['v0.3.2']); // ...but never published
  // A plain local lookup sees the leftover; the remote-verified one does not.
  assert.equal(findPublished(c.git, { source, channel: 'stable' }).length, 1);
  assert.deepEqual(findPublished(c.git, { source, channel: 'stable', remote: 'origin' }), []);
  const result = await publishRelease(c.git, { source, channel: 'stable' });
  assert.equal(result.status, 'published');
  assert.equal(result.tag, 'v0.3.3');
  assert.deepEqual(remoteTags(c), ['v0.3.2', 'v0.3.3']);
  assert.equal(sh(c.origin, 'rev-parse', 'refs/tags/v0.3.3'), result.object);
  assert.equal(sh(c.origin, 'rev-parse', 'refs/tags/v0.3.3^{commit}'), result.commit);
  assert.equal(sh(c.root, 'rev-parse', 'refs/tags/v0.3.3'), result.object);
});

test('retry after an unknown outcome that DID reach the remote recognizes the exact remote tag and publishes nothing new', async t => {
  const c = fixture(t);
  const source = commit(c.root, 'fix: applied but unknown');
  sh(c.root, 'push', '-q', 'origin', 'main');
  await assert.rejects(publishRelease(blindPush(c.git, { applyPush: true }), { source, channel: 'stable' }), error => error.reason === 'unknown');
  const object = sh(c.origin, 'rev-parse', 'refs/tags/v0.3.3');
  const result = await publishRelease(c.git, { source, channel: 'stable' });
  assert.equal(result.status, 'exists');
  assert.equal(result.tag, 'v0.3.3');
  assert.equal(sh(c.origin, 'rev-parse', 'refs/tags/v0.3.3'), object);
  assert.deepEqual(remoteTags(c), ['v0.3.2', 'v0.3.3']);
});

test('retry after an unknown outcome when someone else took the version: the remote tag is untouched and a new version is allocated', async t => {
  const c = fixture(t);
  const mine = commit(c.root, 'fix: mine');
  sh(c.root, 'push', '-q', 'origin', 'main');
  const rival = clone(c, 'rival');
  const theirs = commit(rival.root, 'fix: theirs');
  sh(rival.root, 'push', '-q', 'origin', 'main');
  await assert.rejects(publishRelease(blindPush(c.git), { source: mine, channel: 'stable' }), error => error.reason === 'unknown');
  const their = await publishRelease(rival.git, { source: theirs, channel: 'stable' });
  assert.equal(their.tag, 'v0.3.3');
  const result = await publishRelease(c.git, { source: mine, channel: 'stable' });
  assert.equal(result.status, 'published');
  assert.equal(result.tag, 'v0.3.4');
  assert.equal(sh(c.origin, 'rev-parse', 'refs/tags/v0.3.3'), their.object);
  assert.equal(sh(c.root, 'rev-parse', 'refs/tags/v0.3.3'), their.object); // our unpublished copy was replaced by the real one
  assert.equal(releaseSource(c.git, 'v0.3.4'), mine);
  assert.deepEqual(remoteTags(c), ['v0.3.2', 'v0.3.3', 'v0.3.4']);
});

test('a local-only tag is never published evidence; a differing remote tag for the same source fails closed and is not overwritten', async t => {
  const c = fixture(t);
  const source = commit(c.root, 'fix: local only');
  sh(c.root, 'push', '-q', 'origin', 'main');
  const local = createReleaseCommit(c.git, { source, version: '0.3.3', channel: 'stable', baseTag: 'v0.3.2', commits: [], date: '2026-11-13' });
  annotate(c.git, { version: '0.3.3', commit: local, message: renderTagMessage({ version: '0.3.3', channel: 'stable', source, previousStable: 'v0.3.2' }) });
  assert.equal(findPublished(c.git, { source, channel: 'stable' }).length, 1);
  assert.deepEqual(findPublished(c.git, { source, channel: 'stable', remote: 'origin' }), []);
  const localObject = sh(c.root, 'rev-parse', 'refs/tags/v0.3.3');
  const result = await publishRelease(c.git, { source, channel: 'stable' });
  // Contract amendment (D10): a local-only tag never counts as published or as the allocation base, so the next stable is
  // still v0.3.3. Because that pending tag is strictly the release for this very source it is REUSED (same object), not
  // skipped over and not rebuilt; it is published only now, by the push that the remote then confirms.
  assert.equal(result.status, 'published'); // not "exists"
  assert.equal(result.tag, 'v0.3.3');
  assert.equal(result.object, localObject);
  assert.deepEqual(remoteTags(c), ['v0.3.2', 'v0.3.3']);
  assert.equal(sh(c.origin, 'rev-parse', 'refs/tags/v0.3.3'), localObject);

  // The remote carries a DIFFERENT object for the same name and source: fail closed, remote untouched.
  const d = fixture(t);
  const shared = commit(d.root, 'fix: differing');
  sh(d.root, 'push', '-q', 'origin', 'main');
  const rival = clone(d, 'rival');
  const theirs = await publishRelease(rival.git, { source: shared, channel: 'stable', date: '2026-01-01' });
  const mine = createReleaseCommit(d.git, { source: shared, version: '0.3.3', channel: 'stable', baseTag: 'v0.3.2', commits: [], date: '2026-02-02' });
  annotate(d.git, { version: '0.3.3', commit: mine, message: renderTagMessage({ version: '0.3.3', channel: 'stable', source: shared, previousStable: 'v0.3.2' }) });
  assert.deepEqual(findPublished(d.git, { source: shared, channel: 'stable', remote: 'origin' }), []);
  await assert.rejects(publishRelease(d.git, { source: shared, channel: 'stable' }), error => error instanceof PublishError && error.reason === 'fetch');
  assert.equal(sh(d.origin, 'rev-parse', 'refs/tags/v0.3.3'), theirs.object);
  assert.deepEqual(remoteTags(d), ['v0.3.2', 'v0.3.3']);
});

// ---------------------------------------------------------------------------------------------------------------------
// T3: GitHub client, verdicts, fake-API reconciliation
// ---------------------------------------------------------------------------------------------------------------------

const REPO = 'owner/repo';
const RUN = 4242;
const settings = { repo: REPO, author: 'vancinis' };
const publishSettings = (extra = {}) => ({ ...settings, runId: RUN, attempt: 1, ...extra });

const job = (sha, conclusion = 'success', options = {}) => ({
  name: `validate ${sha}`, status: options.status ?? 'completed', conclusion, run_id: options.runId ?? RUN, run_attempt: options.attempt ?? 1,
});
const green = shas => shas.map(sha => job(sha));

const pr = (number, sha, extra = {}) => ({
  number, state: 'open', draft: false, user: { login: 'vancinis', type: 'User' }, base: { ref: 'main', repo: { full_name: REPO } },
  head: { sha, repo: { full_name: REPO } }, ...extra,
});

/** In-memory GitHub: `state.pulls`, `state.jobs` and `state.run` are plain data the tests mutate between runs. */
function fakeApi({ pulls = [], jobs = [], run = { id: RUN, run_attempt: 1 }, onGetPull } = {}) {
  const state = { pulls, jobs, run, calls: { getPull: [], listJobs: 0, listOpenPulls: 0, getRun: 0 } };
  return Object.assign(state, {
    listOpenPulls: async () => { state.calls.listOpenPulls += 1; return structuredClone(state.pulls); },
    getPull: async number => {
      state.calls.getPull.push(number);
      const found = structuredClone(state.pulls.find(item => item.number === number));
      return onGetPull ? onGetPull(number, state.calls.getPull.length, found) : found;
    },
    // `run_number` defaults to 1; a test passes `run_number: undefined` (or another value) explicitly to override it.
    getRun: async () => { state.calls.getRun += 1; return structuredClone({ run_number: 1, ...state.run }); },
    listJobs: async () => { state.calls.listJobs += 1; return structuredClone(state.jobs); },
  });
}

function integrate(context, kind, subject) {
  const root = context.root;
  if (kind === 'merge') {
    const name = `pr-${++counter}`;
    sh(root, 'checkout', '-q', '-b', name, 'main');
    writeFileSync(join(root, `${name}.txt`), `${subject}\n`);
    sh(root, 'add', '--', `${name}.txt`);
    sh(root, 'commit', '-q', '-m', subject);
    sh(root, 'checkout', '-q', 'main');
    sh(root, 'merge', '-q', '--no-ff', '-m', `Merge pull request #${counter} from owner/${name}`, name);
  } else commit(root, subject);
  sh(root, 'push', '-q', 'origin', 'main');
  return sh(root, 'rev-parse', 'HEAD');
}

function prHead(context, number, subject) {
  const root = context.root;
  const name = `prh-${number}-${++counter}`;
  sh(root, 'checkout', '-q', '-b', name, 'main');
  writeFileSync(join(root, `${name}.txt`), `${subject}\n`);
  sh(root, 'add', '--', `${name}.txt`);
  sh(root, 'commit', '-q', '-m', subject);
  const sha = sh(root, 'rev-parse', 'HEAD');
  sh(root, 'checkout', '-q', 'main');
  sh(root, 'push', '-q', '--force', 'origin', `${sha}:refs/pull/${number}/head`);
  return sha;
}

const ownerSkip = (context, sha) => {
  sh(context.root, 'tag', '-a', `release-skip/${sha}`, '-m', 'omitir por decisión del propietario', sha);
  sh(context.root, 'push', '-q', 'origin', `refs/tags/release-skip/${sha}`);
};
const releaseTags = context => remoteTags(context).filter(name => name.startsWith('v'));

test('GitHub client: pagination, auth, fail-closed responses and no token leak to foreign links', async t => {
  const requests = [];
  const link = url => ({ get: name => (name.toLowerCase() === 'link' ? `<${url}>; rel="next", <https://api.github.com/x>; rel="last"` : null) });
  const reply = (data, { status = 200, next } = {}) => ({ ok: status < 400, status, headers: next ? link(next) : { get: () => null }, json: async () => data });
  const routes = new Map();
  const fetch = async (url, init) => { requests.push({ url, init }); const route = routes.get(url); if (!route) throw new Error(`unexpected ${url}`); return route(); };
  const client = createGitHubClient({ repo: REPO, token: 'secret', fetch });
  const base = 'https://api.github.com/repos/owner/repo';

  routes.set(`${base}/pulls?state=open&per_page=100`, () => reply([{ number: 1 }], { next: `${base}/pulls?state=open&per_page=100&page=2` }));
  routes.set(`${base}/pulls?state=open&per_page=100&page=2`, () => reply([{ number: 2 }]));
  assert.deepEqual((await client.listOpenPulls()).map(item => item.number), [1, 2]);
  assert.equal(requests[0].init.headers.Authorization, 'Bearer secret');
  assert.equal(requests[0].init.headers['X-GitHub-Api-Version'], '2022-11-28');

  const jobsUrl = `${base}/actions/runs/7/attempts/2/jobs?per_page=100`;
  routes.set(jobsUrl, () => reply({ total_count: 3, jobs: [{ name: 'a' }, { name: 'b' }] }, { next: `${jobsUrl}&page=2` }));
  routes.set(`${jobsUrl}&page=2`, () => reply({ total_count: 3, jobs: [{ name: 'c' }] }));
  assert.deepEqual((await client.listJobs(7, 2)).map(item => item.name), ['a', 'b', 'c']);

  routes.set(jobsUrl, () => reply({ total_count: 3, jobs: [{ name: 'a' }, { name: 'b' }] })); // a page is missing: incomplete
  await assert.rejects(client.listJobs(7, 2), /incompleta/);

  const before = requests.length;
  routes.set(jobsUrl, () => reply({ total_count: 1, jobs: [{ name: 'a' }] }, { next: 'https://evil.example/steal' }));
  await assert.rejects(client.listJobs(7, 2), error => error instanceof ApiError && /fuera de la API/.test(error.message));
  assert.equal(requests.slice(before).every(request => request.url.startsWith('https://api.github.com/')), true);

  routes.set(`${base}/pulls/9`, () => reply({ message: 'Not Found' }, { status: 404 }));
  await assert.rejects(client.getPull(9), error => error instanceof ApiError && error.status === 404);
  routes.set(`${base}/actions/runs/7`, () => reply({ id: 7, run_attempt: 2 }));
  assert.deepEqual(await client.getRun(7), { id: 7, run_attempt: 2 });
  routes.set(`${base}/pulls?state=open&per_page=100`, () => reply({ not: 'an array' }));
  await assert.rejects(client.listOpenPulls(), /inesperada/);
  const loop = createGitHubClient({ repo: REPO, token: 'x', maxPages: 2, fetch: async () => reply([{ number: 1 }], { next: `${base}/pulls?state=open&per_page=100` }) });
  await assert.rejects(loop.listOpenPulls(), /Demasiadas/);
  assert.throws(() => createGitHubClient({ repo: 'bad', token: 'x' }), /inválido/);
  assert.throws(() => createGitHubClient({ repo: REPO, token: '' }), /token/);
});

test('validation verdict trusts only one completed job with the exact name in this run and attempt', () => {
  const sha = 'a'.repeat(40);
  const other = 'b'.repeat(40);
  const ctx = { runId: RUN, attempt: 2 };
  const verdict = jobs => validationVerdict(jobs, sha, ctx);
  assert.equal(verdict([job(sha, 'success', { attempt: 2 })]), 'success');
  assert.equal(verdict([job(sha, 'failure', { attempt: 2 })]), 'failed');
  assert.equal(verdict([job(sha, 'timed_out', { attempt: 2 })]), 'failed');
  for (const conclusion of ['cancelled', 'skipped', null, 'neutral', 'action_required']) assert.equal(verdict([job(sha, conclusion, { attempt: 2 })]), 'pending', String(conclusion));
  assert.equal(verdict([job(sha, null, { attempt: 2, status: 'in_progress' })]), 'pending');
  assert.equal(verdict([job(sha, 'success', { attempt: 2, status: 'queued' })]), 'pending');
  assert.equal(verdict([]), 'pending');
  assert.equal(verdict([job(other, 'success', { attempt: 2 })]), 'pending'); // another SHA
  assert.equal(verdict([job(sha, 'success', { attempt: 1 })]), 'pending'); // previous attempt
  assert.equal(verdict([job(sha, 'success', { attempt: 2, runId: 1 })]), 'pending'); // another run
  assert.equal(verdict([{ name: `validate ${sha}`, status: 'completed', conclusion: 'success' }]), 'pending'); // no run or attempt recorded
  assert.equal(verdict([{ ...job(sha, 'success', { attempt: 2 }), name: `Validate ${sha}` }]), 'pending');
  assert.equal(verdict([{ ...job(sha, 'success', { attempt: 2 }), name: `validate ${sha.slice(0, 12)}` }]), 'pending');
  assert.equal(verdict([job(sha, 'success', { attempt: 2 }), job(sha, 'failure', { attempt: 2 })]), 'pending'); // ambiguous
  assert.equal(verdict([job(sha, 'failure', { attempt: 1 }), job(sha, 'success', { attempt: 2 })]), 'success'); // an old failure is not current
});

test('preview eligibility: ready, owner User, same repository, base main, open', () => {
  const sha = 'c'.repeat(40);
  const ok = pr(1, sha);
  assert.equal(previewIneligibility(ok, settings), undefined);
  assert.equal(previewIneligibility({ ...ok, user: { login: 'VanCinis', type: 'User' } }, settings), undefined);
  const cases = {
    draft: { draft: true }, 'draft missing': { draft: undefined }, closed: { state: 'closed' }, 'other author': { user: { login: 'mallory', type: 'User' } },
    'bot with the same login': { user: { login: 'vancinis', type: 'Bot' } }, 'other base': { base: { ref: 'dev', repo: { full_name: REPO } } },
    fork: { head: { sha, repo: { full_name: 'fork/repo' } } }, 'deleted fork': { head: { sha, repo: null } }, 'short sha': { head: { sha: 'abc', repo: { full_name: REPO } } },
    'base repo elsewhere': { base: { ref: 'main', repo: { full_name: 'fork/repo' } } },
  };
  for (const [name, patch] of Object.entries(cases)) assert.ok(previewIneligibility({ ...ok, ...patch }, settings), name);
  assert.ok(previewIneligibility(null, settings));
});

test('legacy v0.3.2 merged through a side branch: cursor is the merge, nothing is pending, metadata releases are not integrations', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'mdd-legacy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  const origin = join(dir, 'origin.git');
  mkdirSync(root); mkdirSync(origin);
  sh(root, 'init', '-q', '-b', 'main'); identify(root);
  const at = version => { writeFileSync(join(root, 'package.json'), json({ ...PACKAGE, version })); writeFileSync(join(root, 'package-lock.json'), json({ ...LOCK, version, packages: { '': { name: PACKAGE.name, version } } })); };
  at('0.3.1');
  sh(root, 'add', '.'); sh(root, 'commit', '-q', '-m', 'feat: baseline');
  sh(root, 'checkout', '-q', '-b', 'side');
  at('0.3.2'); writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## [0.3.2] - 2026-01-01\n\nx\n');
  sh(root, 'add', '.'); sh(root, 'commit', '-q', '-m', 'chore(release): v0.3.2');
  const released = sh(root, 'rev-parse', 'HEAD');
  sh(root, 'tag', '-a', 'v0.3.2', '-m', 'MDD 0.3.2'); // legacy: no Source-Commit trailer
  sh(root, 'checkout', '-q', 'main');
  commit(root, 'fix: main moved on meanwhile');
  sh(root, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #4 from owner/side', 'side');
  const merge = sh(root, 'rev-parse', 'HEAD');
  sh(origin, 'init', '-q', '--bare', '-b', 'main');
  sh(root, 'remote', 'add', 'origin', origin);
  sh(root, 'push', '-q', 'origin', 'main', 'v0.3.2');
  const git = createAutoGit(root);
  assert.equal(releaseSource(git, 'v0.3.2'), released);
  assert.deepEqual(stableWork(git, merge), { baseTag: 'v0.3.2', cursor: merge, candidates: [] });

  const context = { dir, root, origin, git };
  const m1 = integrate(context, 'merge', 'feat: after the legacy release');
  writeFileSync(join(root, 'package.json'), json({ ...PACKAGE, version: '0.9.9' }));
  writeFileSync(join(root, 'package-lock.json'), json({ ...LOCK, version: '0.9.9', packages: { '': { name: PACKAGE.name, version: '0.9.9' } } }));
  writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## [0.9.9] - 2026-01-02\n\ny\n');
  sh(root, 'add', '.'); sh(root, 'commit', '-q', '-m', 'chore(release): v0.9.9');
  const metadata = sh(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'extra.txt'), 'x\n'); writeFileSync(join(root, 'package.json'), json({ ...PACKAGE, version: '0.9.8' }));
  writeFileSync(join(root, 'package-lock.json'), json({ ...LOCK, version: '0.9.8', packages: { '': { name: PACKAGE.name, version: '0.9.8' } } }));
  sh(root, 'add', '.'); sh(root, 'commit', '-q', '-m', 'chore(release): v0.9.8 but not pure');
  const impure = sh(root, 'rev-parse', 'HEAD');
  const m2 = integrate(context, 'squash', 'fix: squashed (#12)');
  assert.equal(isMetadataRelease(git, metadata), true);
  assert.equal(isMetadataRelease(git, impure), false);
  assert.equal(isMetadataRelease(git, m2), false);
  assert.equal(isMetadataRelease(git, merge), false);
  const tip = sh(root, 'rev-parse', 'HEAD');
  assert.deepEqual(stableWork(git, tip).candidates, [m1, impure, m2]);
  assert.equal(stableWork(git, tip).cursor, merge);
  // The first stable's interval is v0.3.2's recorded commit..M1 (includes main's earlier fix, never released).
  const ci = clone(context, 'ci');
  const api = fakeApi({ jobs: green([m1, impure, m2]) });
  const result = await runPublish(ci.git, api, publishSettings());
  assert.deepEqual(result.published.map(item => `${item.tag}:${item.source}`), [`v0.4.0:${m1}`, `v0.4.1:${impure}`, `v0.4.2:${m2}`]);
  assert.equal(result.exitCode, 0);
});

test('merge and squash integrations publish in source order; a failed validation blocks, a missing one waits, nothing is bundled or reordered', async t => {
  const c = fixture(t);
  const m1 = integrate(c, 'merge', 'feat: first merge');
  const m2 = integrate(c, 'squash', 'fix: second squash (#9)');
  const m3 = integrate(c, 'squash', 'fix: third');
  const ci = clone(c, 'ci');
  const tagsBefore = remoteTags(c);

  const api = fakeApi({ jobs: [job(m1), job(m2, 'failure'), job(m3)] });
  const blocked = await runPublish(ci.git, api, publishSettings());
  assert.deepEqual(blocked.published.map(item => item.tag), ['v0.4.0']);
  assert.deepEqual(blocked.blocked, { source: m2, reason: 'la validación falló' });
  assert.equal(blocked.exitCode, 1);
  assert.equal(blocked.backlog, 2);
  assert.equal(blocked.continue, false);
  assert.deepEqual(releaseTags(c), ['v0.3.2', 'v0.4.0']);
  assert.equal(releaseSource(ci.git, 'v0.4.0'), m1);
  assert.equal(remoteTags(c).some(name => name.startsWith('release-skip/')), false); // the automation never creates markers
  assert.ok(tagsBefore.length >= 1);

  // M2 pending (not recorded at all): M3 must wait even though its own validation succeeded. Exit stays 0.
  api.jobs = [job(m1), job(m3)];
  const pending = await runPublish(ci.git, api, publishSettings());
  assert.deepEqual(pending.published, []);
  assert.deepEqual(pending.pending, [{ channel: 'stable', source: m2 }]);
  assert.equal(pending.blocked, undefined);
  assert.equal(pending.exitCode, 0);
  assert.equal(pending.progress, false);
  assert.equal(pending.backlog, 2);
  assert.deepEqual(releaseTags(c), ['v0.3.2', 'v0.4.0']);

  // Still running or cancelled counts as pending too.
  for (const state of [{ status: 'in_progress', conclusion: null }, { status: 'completed', conclusion: 'cancelled' }]) {
    api.jobs = [{ ...job(m2), ...state }, job(m3)];
    assert.deepEqual((await runPublish(ci.git, api, publishSettings())).published, []);
  }

  // Once M2 is green both publish, strictly M2 then M3 (patch fixes, previous stable is the base for each interval).
  api.jobs = green([m1, m2, m3]);
  const done = await runPublish(ci.git, api, publishSettings());
  assert.deepEqual(done.published.map(item => `${item.tag}:${item.source}`), [`v0.4.1:${m2}`, `v0.4.2:${m3}`]);
  assert.equal(done.backlog, 0);
  assert.equal(done.continue, false);
  assert.deepEqual(releaseTags(c), ['v0.3.2', 'v0.4.0', 'v0.4.1', 'v0.4.2']);
  assert.equal(sh(ci.root, 'cat-file', '-t', 'refs/tags/v0.4.2'), 'tag');
  const meta = readTagProvenance(ci.git, 'v0.4.2').meta;
  assert.deepEqual([meta.channel, meta.source, meta.previousStable, meta.workflowRun], ['stable', m3, 'v0.4.1', String(RUN)]);
  // No branch moved on the remote.
  assert.equal(sh(c.origin, 'rev-parse', 'refs/heads/main'), m3);

  // No-op loop: nothing derived, nothing pushed, exit 0, no progress.
  const again = await runPublish(ci.git, api, publishSettings());
  assert.deepEqual([again.published, again.progress, again.backlog, again.continue, again.exitCode], [[], false, 0, false, 0]);
});

test('forged outputs, other SHAs, other attempts and other runs authorize nothing; the run attempt must be the current one', async t => {
  const c = fixture(t);
  const m1 = integrate(c, 'squash', 'fix: only a forged verdict');
  const ci = clone(c, 'ci');
  const forgedOutput = join(c.dir, 'forged-output.txt');
  const summary = join(c.dir, 'summary.md');
  writeFileSync(forgedOutput, `matrix={"include":[{"source":"${m1}"}]}\npublished=["v9.9.9"]\nprogress=true\n`);
  const env = { GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: String(RUN), GITHUB_RUN_ATTEMPT: '2', GITHUB_OUTPUT: forgedOutput, GITHUB_STEP_SUMMARY: summary };
  const wrong = [job(m1, 'success', { attempt: 1 }), job(m1, 'success', { attempt: 2, runId: 99 }), job('f'.repeat(40), 'success', { attempt: 2 }), { ...job(m1, 'success', { attempt: 2 }), name: `validate ${m1} ` }];
  const api = fakeApi({ jobs: wrong, run: { id: RUN, run_attempt: 2 } });
  const out = { text: '', err: '' };
  const code = await main(['publish'], { env, git: ci.git, client: api, stdout: text => { out.text += text; }, stderr: text => { out.err += text; } });
  assert.equal(code, 0);
  assert.deepEqual(releaseTags(c), ['v0.3.2']);
  assert.match(out.text, /Nada publicado/);
  assert.match(out.text, /Pendiente de validación/);
  const written = readFileSync(forgedOutput, 'utf8');
  assert.ok(written.endsWith('published=[]\npublished_count=0\nsmoke_matrix={"include":[]}\nbacklog=1\nprogress=false\nblocked=false\ncontinue=false\nexit_code=0\n'), written);
  assert.ok(readFileSync(summary, 'utf8').includes('## Release: publicación'));

  // The run is not the current attempt according to GitHub: refuse, publish nothing, exit 1.
  const stale = fakeApi({ jobs: [job(m1, 'success', { attempt: 2 })], run: { id: RUN, run_attempt: 3 } });
  const err = { text: '' };
  assert.equal(await main(['publish'], { env: { ...env, GITHUB_OUTPUT: '' }, git: ci.git, client: stale, stdout: () => {}, stderr: text => { err.text += text; } }), 1);
  assert.match(err.text, /no está en el intento/);
  assert.deepEqual(releaseTags(c), ['v0.3.2']);

  // The right job in the right attempt does publish, and writes only validated tokens to GITHUB_OUTPUT.
  const real = fakeApi({ jobs: [job(m1, 'success', { attempt: 2 })], run: { id: RUN, run_attempt: 2 } });
  const fresh = join(c.dir, 'fresh-output.txt');
  assert.equal(await main(['publish'], { env: { ...env, GITHUB_OUTPUT: fresh }, git: ci.git, client: real, stdout: () => {}, stderr: () => {} }), 0);
  const outputs = Object.fromEntries(readFileSync(fresh, 'utf8').trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  assert.deepEqual(outputs, {
    published: '["v0.3.3"]', published_count: '1', smoke_matrix: '{"include":[{"tag":"v0.3.3"}]}', backlog: '0', progress: 'true', blocked: 'false', continue: 'false', exit_code: '0',
  });
});

test('blocked and failure exit 1, pending and no-op exit 0, and the summary is Spanish', async t => {
  const c = fixture(t);
  const m1 = integrate(c, 'squash', 'fix: blocked one');
  const ci = clone(c, 'ci');
  const out = join(c.dir, 'out.txt');
  const env = { GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: String(RUN), GITHUB_RUN_ATTEMPT: '1', GITHUB_OUTPUT: out };
  const logs = { text: '', err: '' };
  const run = (api, extra = {}) => main(['publish'], { env: { ...env, ...extra }, git: ci.git, client: api, stdout: text => { logs.text += text; }, stderr: text => { logs.err += text; } });
  assert.equal(await run(fakeApi({ jobs: [job(m1, 'failure')] })), 1);
  assert.match(logs.text, new RegExp(`Estable bloqueado en \`${m1}\``));
  assert.match(logs.text, new RegExp(`release-skip/${m1}`));
  assert.match(readFileSync(out, 'utf8'), /blocked=true/);
  assert.match(readFileSync(out, 'utf8'), /exit_code=1/);
  assert.equal(await run(fakeApi({ jobs: [] })), 0);
  const failing = fakeApi({ jobs: [job(m1)] });
  failing.listJobs = async () => { throw new ApiError('GitHub API respondió 502', 502); };
  logs.err = '';
  assert.equal(await run(failing), 1);
  assert.match(logs.err, /Error: GitHub API respondió 502/);
  assert.deepEqual(releaseTags(c), ['v0.3.2']);
  assert.equal(await run(fakeApi({ jobs: [job(m1)] })), 0);
  assert.equal(await run(fakeApi({ jobs: [job(m1)] })), 0); // no-op rerun
  assert.deepEqual(releaseTags(c), ['v0.3.2', 'v0.3.3']);
});

test('batches: at most 5 stables and 5 previews per run, continuation only with progress, then a no-op', async t => {
  const c = fixture(t);
  const stables = [];
  for (let index = 0; index < 7; index += 1) stables.push(integrate(c, 'squash', `fix: stable ${index + 1}`));
  const heads = [];
  for (let number = 1; number <= 7; number += 1) heads.push(prHead(c, number, `fix: preview ${number}`));
  const pulls = heads.map((sha, index) => pr(index + 1, sha));
  const ci = clone(c, 'ci');
  const api = fakeApi({ pulls });

  const plan = await runPlan(ci.git, api, settings);
  assert.deepEqual(plan.stables, stables.slice(0, 5));
  assert.equal(plan.stableRemaining, 2);
  assert.deepEqual(plan.previews.map(item => item.number), [1, 2, 3, 4, 5]);
  assert.equal(plan.previewRemaining, 2);
  assert.deepEqual(plan.sources, [...stables.slice(0, 5), ...heads.slice(0, 5)]);

  api.jobs = green(plan.sources);
  const first = await runPublish(ci.git, api, publishSettings());
  assert.equal(first.published.filter(item => item.channel === 'stable').length, 5);
  assert.equal(first.published.filter(item => item.channel === 'preview').length, 5);
  assert.deepEqual(first.published.filter(item => item.channel === 'stable').map(item => item.tag), ['v0.3.3', 'v0.3.4', 'v0.3.5', 'v0.3.6', 'v0.3.7']);
  assert.equal(first.backlog, 4);
  assert.equal(first.progress, true);
  assert.equal(first.continue, true);
  assert.equal(first.exitCode, 0);

  // Jobs from the FIRST attempt for the rest do not exist yet; the continuation validates them in its own run.
  api.jobs = green([...stables, ...heads]);
  const second = await runPublish(ci.git, api, publishSettings());
  assert.deepEqual(second.published.filter(item => item.channel === 'stable').map(item => item.tag), ['v0.3.8', 'v0.3.9']);
  assert.equal(second.published.filter(item => item.channel === 'preview').length, 2);
  assert.equal(second.backlog, 0);
  assert.equal(second.continue, false);

  const before = remoteTags(c);
  const third = await runPublish(ci.git, api, publishSettings());
  assert.deepEqual([third.published, third.progress, third.backlog, third.continue, third.exitCode], [[], false, 0, false, 0]);
  assert.deepEqual(remoteTags(c), before);
  // Every preview is the global highest at its time, tied to its own PR head.
  const previews = before.filter(name => name.includes('-preview.'));
  assert.equal(previews.length, 7);
  for (const [index, head] of heads.entries()) assert.equal(findPublished(ci.git, { source: head, channel: 'preview', remote: 'origin' }).length, 1, `PR ${index + 1}`);
});

test('previews: ready draft/retarget/reopen are caught by a fresh inventory; drafts, forks, other authors and stale heads publish nothing', async t => {
  const c = fixture(t);
  const heads = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map(number => [number, prHead(c, number, `fix: pr ${number}`)]));
  const fork = { head: { sha: heads[3], repo: { full_name: 'fork/repo' } } };
  const pulls = [
    pr(1, heads[1]), pr(2, heads[2], { draft: true }), pr(3, heads[3], fork), pr(4, heads[4], { user: { login: 'mallory', type: 'User' } }),
    pr(5, heads[5], { base: { ref: 'dev', repo: { full_name: REPO } } }), pr(6, heads[6], { state: 'closed' }), pr(7, heads[7], { user: { login: 'vancinis', type: 'Bot' } }),
    pr(8, 'd'.repeat(40)), // API head differs from refs/pull/8/head: stale
    pr(9, heads[9], { draft: true }),
  ];
  sh(c.root, 'push', '-q', '--force', 'origin', `${heads[8]}:refs/pull/8/head`);
  const ci = clone(c, 'ci');
  const api = fakeApi({ pulls, jobs: green([...Object.values(heads), 'd'.repeat(40)]) });
  const tip = sh(c.root, 'rev-parse', 'main');

  const plan = await runPlan(ci.git, api, settings);
  assert.deepEqual(plan.previews, [{ number: 1, source: heads[1] }]);
  assert.deepEqual(plan.ignored.map(item => item.number).sort((a, b) => a - b), [2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(plan.ignored.find(item => item.number === 8).reason, 'el head cambió');
  assert.deepEqual(plan.stables, []);

  const first = await runPublish(ci.git, api, publishSettings());
  assert.deepEqual(first.published.map(item => `${item.tag}#${item.number}`), ['v0.3.3-preview.1#1']);
  assert.deepEqual(releaseTags(c), ['v0.3.2', 'v0.3.3-preview.1']);
  assert.deepEqual(readTagProvenance(ci.git, 'v0.3.3-preview.1').meta, {
    version: '0.3.3-preview.1', channel: 'preview', source: heads[1], pullRequest: '1', mainCommit: tip, previousStable: 'v0.3.2', workflowRun: String(RUN),
  });

  // Draft -> ready without any push; retarget dev -> main; reopen. Previews ascend by PR number.
  api.pulls.find(item => item.number === 2).draft = false;
  api.pulls.find(item => item.number === 5).base.ref = 'main';
  api.pulls.find(item => item.number === 6).state = 'open';
  const second = await runPublish(ci.git, api, publishSettings());
  assert.deepEqual(second.published.map(item => `${item.tag}#${item.number}`), ['v0.3.3-preview.2#2', 'v0.3.3-preview.3#5', 'v0.3.3-preview.4#6']);

  // Ready -> draft again: published tags stay, nothing new, and a draft that never was ready never publishes.
  api.pulls.find(item => item.number === 1).draft = true;
  const third = await runPublish(ci.git, api, publishSettings());
  assert.deepEqual([third.published, third.progress, third.exitCode], [[], false, 0]);
  assert.deepEqual(releaseTags(c), ['v0.3.2', 'v0.3.3-preview.1', 'v0.3.3-preview.2', 'v0.3.3-preview.3', 'v0.3.3-preview.4']);
  assert.equal(findPublished(ci.git, { source: heads[9], channel: 'preview', remote: 'origin' }).length, 0);
});

test('superseded head, failed preview validation and missing validation publish nothing; a failed preview never blocks another', async t => {
  const c = fixture(t);
  const oldHead = prHead(c, 1, 'fix: old head');
  const newHead = prHead(c, 1, 'fix: new head'); // the ref now points at the new head
  const bad = prHead(c, 2, 'fix: fails validation');
  const good = prHead(c, 3, 'fix: passes');
  const ci = clone(c, 'ci');
  const api = fakeApi({ pulls: [pr(1, newHead), pr(2, bad), pr(3, good)], jobs: [job(oldHead), job(bad, 'failure'), job(good)] });
  const result = await runPublish(ci.git, api, publishSettings());
  assert.deepEqual(result.published.map(item => `${item.number}:${item.tag}`), ['3:v0.3.3-preview.1']);
  assert.deepEqual(result.pending, [{ channel: 'preview', source: newHead, number: 1 }]);
  assert.deepEqual(result.skipped.map(item => [item.number, item.reason]), [[2, 'la validación falló']]);
  assert.equal(result.exitCode, 0);
  assert.equal(findPublished(ci.git, { source: oldHead, channel: 'preview', remote: 'origin' }).length, 0);
  assert.equal(findPublished(ci.git, { source: newHead, channel: 'preview', remote: 'origin' }).length, 0);
});

test('a PR that turns draft, closes or moves between retry attempts is skipped on the next attempt and never published', async t => {
  const cases = {
    'becomes a draft': found => ({ ...found, draft: true }),
    'is closed': found => ({ ...found, state: 'closed' }),
    'head moves': found => ({ ...found, head: { ...found.head, sha: 'e'.repeat(40) } }),
  };
  for (const [name, change] of Object.entries(cases)) {
    const c = fixture(t);
    const head = prHead(c, 1, 'fix: raced');
    const other = prHead(c, 9, 'fix: rival preview');
    const ci = clone(c, 'ci');
    let pushes = 0;
    // Before the first push a squatter takes the same version on the remote, so the push is rejected and the engine retries.
    const raced = wrap(ci.git, (args, options, git) => {
      if (args[0] === 'push' && ++pushes === 1) sh(c.origin, 'update-ref', 'refs/tags/v0.3.3-preview.1', other);
      return git(args, options);
    });
    const api = fakeApi({ pulls: [pr(1, head)], jobs: green([head]), onGetPull: (number, call, found) => (call >= 2 ? change(found) : found) });
    const result = await runPublish(raced, api, publishSettings());
    assert.equal(api.calls.getPull.length, 2, name); // revalidated before EVERY push attempt
    assert.deepEqual(result.published, [], name);
    assert.equal(result.skipped.length, 1, name);
    assert.equal(result.skipped[0].number, 1, name);
    assert.equal(findPublished(ci.git, { source: head, channel: 'preview', remote: 'origin' }).length, 0, name);
    assert.deepEqual(releaseTags(c), ['v0.3.2', 'v0.3.3-preview.1'], name); // only the squatter, which was never touched
    assert.equal(sh(c.origin, 'cat-file', '-t', 'refs/tags/v0.3.3-preview.1'), 'commit', name);
    assert.equal(sh(ci.root, 'tag', '--list', 'v0.3.3-preview.2'), '', name); // no unpublished leftover
    assert.equal(result.exitCode, 0, name);
  }
});

test('a ready PR whose state changes just before the first push is skipped (no retry needed)', async t => {
  const c = fixture(t);
  const head = prHead(c, 1, 'fix: late draft');
  const ci = clone(c, 'ci');
  const api = fakeApi({ pulls: [pr(1, head)], jobs: green([head]), onGetPull: (number, call, found) => ({ ...found, draft: true }) });
  const result = await runPublish(ci.git, api, publishSettings());
  assert.equal(result.skipped[0].reason, '#1: es borrador');
  assert.deepEqual(releaseTags(c), ['v0.3.2']);
  assert.equal(sh(ci.root, 'tag', '--list', 'v0.3.3-preview.1'), '');
});

test('owner skip markers: only an annotated tag whose direct target is exactly the pending source unblocks it', async t => {
  const c = fixture(t);
  const m1 = integrate(c, 'merge', 'feat: skipped integration');
  const m2 = integrate(c, 'squash', 'fix: follows');
  const ci = clone(c, 'ci');
  const api = fakeApi({ jobs: [job(m1, 'failure'), job(m2)] });

  // Markers that must NOT count: lightweight, annotated tag of another commit, tag of a tag, other name.
  sh(c.root, 'tag', `release-skip/${m1}`, m1);
  sh(c.root, 'push', '-q', 'origin', `refs/tags/release-skip/${m1}`);
  assert.equal((await runPublish(ci.git, api, publishSettings())).blocked?.source, m1);
  assert.equal(hasSkipMarker(ci.git, m1), false);
  sh(c.root, 'push', '-q', 'origin', `:refs/tags/release-skip/${m1}`);
  sh(c.root, 'tag', '-d', `release-skip/${m1}`);
  sh(ci.root, 'tag', '-d', `release-skip/${m1}`);

  sh(c.root, 'tag', '-a', `release-skip/${m1}`, '-m', 'wrong target', m2);
  sh(c.root, 'tag', '-a', 'inner', '-m', 'inner', m1);
  sh(c.root, 'tag', '-a', `release-skip/${m2}`, '-m', 'nested', 'inner');
  sh(c.root, 'push', '-q', 'origin', `refs/tags/release-skip/${m1}`, `refs/tags/release-skip/${m2}`);
  const wrongTarget = await runPublish(ci.git, api, publishSettings());
  assert.equal(hasSkipMarker(ci.git, m1), false);
  assert.equal(hasSkipMarker(ci.git, m2), false);
  assert.equal(wrongTarget.blocked?.source, m1);
  assert.deepEqual(releaseTags(c), ['v0.3.2']);
  sh(c.root, 'push', '-q', 'origin', `:refs/tags/release-skip/${m1}`, `:refs/tags/release-skip/${m2}`);
  sh(c.root, 'tag', '-d', `release-skip/${m1}`, `release-skip/${m2}`);
  sh(ci.root, 'tag', '-d', `release-skip/${m1}`, `release-skip/${m2}`);

  // The owner's marker: M1 is skipped, M2 publishes with M1's commits inside its interval (feat -> minor).
  ownerSkip(c, m1);
  const done = await runPublish(ci.git, api, publishSettings());
  assert.deepEqual(done.skipped.map(item => item.source), [m1]);
  assert.deepEqual(done.published.map(item => `${item.tag}:${item.source}`), [`v0.4.0:${m2}`]);
  assert.equal(done.exitCode, 0);
  const changelog = sh(c.origin, 'show', 'refs/tags/v0.4.0:CHANGELOG.md');
  assert.match(changelog, /skipped integration/);
  assert.deepEqual(remoteTags(c).filter(name => name.startsWith('release-skip/')), [`release-skip/${m1}`]); // only the owner's
  // A skipped candidate is still skipped on rerun, and is not a plan validation target.
  assert.deepEqual((await runPlan(ci.git, api, settings)).stables, []);
});

test('main moving during validation or push stays safe; a rewritten main fails closed without publishing', async t => {
  const c = fixture(t);
  const m1 = integrate(c, 'squash', 'fix: validated');
  const ci = clone(c, 'ci');
  let m3;
  let fetches = 0;
  const growing = wrap(ci.git, (args, options, git) => {
    if (args[0] === 'fetch' && args.includes('refs/heads/main') && ++fetches === 2) m3 = integrate(c, 'squash', 'fix: arrived during the push');
    return git(args, options);
  });
  const api = fakeApi({ jobs: green([m1]) });
  const first = await runPublish(growing, api, publishSettings());
  assert.deepEqual(first.published.map(item => item.source), [m1]);
  assert.equal(first.backlog, 0);
  // The new merge is picked up by the next run (its own push event) and is never bundled into M1's tag.
  api.jobs = green([m1, m3]);
  const second = await runPublish(ci.git, api, publishSettings());
  assert.deepEqual(second.published.map(item => `${item.tag}:${item.source}`), [`v0.3.4:${m3}`]);
  assert.equal(releaseSource(ci.git, 'v0.3.3'), m1);

  // Force-pushed main between the derivation and the push: the stable is not published.
  const d = fixture(t);
  const source = integrate(d, 'squash', 'fix: about to vanish');
  const ci2 = clone(d, 'ci');
  const emptyTree = execFileSync('git', ['hash-object', '-t', 'tree', '-w', '--stdin'], { cwd: d.root, input: '' }).toString().trim();
  let seen = 0;
  const rewriting = wrap(ci2.git, (args, options, git) => {
    if (args[0] === 'fetch' && args.includes('refs/heads/main') && ++seen === 2) {
      const orphan = sh(d.root, 'commit-tree', emptyTree, '-m', 'rewritten history');
      sh(d.root, 'push', '-q', '--force', 'origin', `${orphan}:refs/heads/main`);
    }
    return git(args, options);
  });
  const rewritten = await runPublish(rewriting, fakeApi({ jobs: green([source]) }), publishSettings());
  assert.deepEqual(rewritten.published, []);
  assert.match(rewritten.failures[0].message, /ya no pertenece a main/);
  assert.equal(rewritten.exitCode, 1);
  assert.deepEqual(releaseTags(d), ['v0.3.2']);
  assert.equal(sh(ci2.root, 'tag', '--list', 'v0.3.3'), '');

  // A main that no longer contains the recorded source of the highest stable refuses up front.
  await assert.rejects(runPublish(ci2.git, fakeApi({ jobs: green([source]) }), publishSettings()), /no es ancestro de main/);
  await assert.rejects(runPlan(ci2.git, fakeApi(), settings), /no es ancestro de main/);
  assert.deepEqual(releaseTags(d), ['v0.3.2']);
});

test('provenance problems fail closed: a malformed highest stable tag publishes nothing', async t => {
  const c = fixture(t);
  const m1 = integrate(c, 'squash', 'fix: pending');
  sh(c.root, 'tag', '-a', 'v0.3.3', '-m', `MDD 0.3.3\n\nChannel: stable\nSource-Commit: ${m1}\nSource-Commit: ${m1}`, m1);
  sh(c.root, 'push', '-q', 'origin', 'v0.3.3');
  const ci = clone(c, 'ci');
  const out = { err: '' };
  assert.equal(await main(['publish'], {
    env: { GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: String(RUN), GITHUB_RUN_ATTEMPT: '1' }, git: ci.git, client: fakeApi({ jobs: green([m1]) }), stdout: () => {}, stderr: text => { out.err += text; },
  }), 1);
  assert.match(out.err, /más de un Source-Commit/);
  assert.deepEqual(releaseTags(c), ['v0.3.2', 'v0.3.3']);
});

test('CLI: usage errors exit 2, plan writes the matrix output, and importing the module has no side effects', async t => {
  const logs = { out: '', err: '' };
  const io = { stdout: text => { logs.out += text; }, stderr: text => { logs.err += text; } };
  const withToken = { GITHUB_TOKEN: 't' };
  const cases = [
    [[], {}], [['bogus'], { ...withToken, GITHUB_REPOSITORY: REPO }], [['plan'], withToken], [['plan'], { GITHUB_REPOSITORY: REPO }],
    [['plan', '--repo', 'no-slash'], withToken], [['plan', '--repo'], withToken], [['plan', '--wat', 'x'], { ...withToken, GITHUB_REPOSITORY: REPO }],
    [['publish'], { ...withToken, GITHUB_REPOSITORY: REPO }], [['publish'], { ...withToken, GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: '1' }],
    [['publish'], { ...withToken, GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: '0', GITHUB_RUN_ATTEMPT: '1' }],
    [['publish', '--run-id', 'x', '--attempt', '1'], { ...withToken, GITHUB_REPOSITORY: REPO }],
  ];
  for (const [argv, env] of cases) {
    logs.err = '';
    assert.equal(await main(argv, { env, git: () => { throw new Error('must not touch git on a usage error'); }, ...io }), 2, argv.join(' '));
    assert.match(logs.err, /Uso:/);
  }
  assert.equal(await main(['--help'], { env: {}, ...io }), 0);
  assert.equal(await main(['plan', '--help'], { env: {}, ...io }), 0);
  assert.match(logs.out, /Códigos de salida/);

  const script = fileURLToPath(new URL('../scripts/release-auto.mjs', import.meta.url));
  const bare = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: '', GITHUB_TOKEN: '' } });
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /Uso:/);
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../scripts/release-auto.mjs', import.meta.url).href)});`], { encoding: 'utf8' });
  assert.equal(imported.status, 0);
  assert.equal(imported.stdout + imported.stderr, '');

  // plan through the CLI: output file, summary file, Spanish text, git/read-only.
  const c = fixture(t);
  const m1 = integrate(c, 'squash', 'fix: planned');
  const head = prHead(c, 3, 'fix: planned preview');
  const ci = clone(c, 'ci');
  const outputFile = join(c.dir, 'plan-output.txt');
  const summaryFile = join(c.dir, 'plan-summary.md');
  logs.out = '';
  const code = await main(['plan'], { env: { GITHUB_REPOSITORY: REPO, GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: summaryFile }, git: ci.git, client: fakeApi({ pulls: [pr(3, head)] }), ...io });
  assert.equal(code, 0);
  const outputs = Object.fromEntries(readFileSync(outputFile, 'utf8').trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  assert.deepEqual(outputs, {
    has_work: 'true', matrix: JSON.stringify({ include: [{ source: m1 }, { source: head }] }), stable_count: '1', preview_count: '1', stable_remaining: '0', preview_remaining: '0',
  });
  assert.match(readFileSync(summaryFile, 'utf8'), /## Release: plan/);
  assert.match(logs.out, /Estables a validar: 1/);
  assert.deepEqual(releaseTags(c), ['v0.3.2']); // plan publishes nothing
  const empty = fixture(t);
  const idle = join(empty.dir, 'idle.txt');
  assert.equal(await main(['plan'], { env: { GITHUB_REPOSITORY: REPO, GITHUB_OUTPUT: idle }, git: clone(empty, 'ci').git, client: fakeApi(), ...io }), 0);
  assert.match(readFileSync(idle, 'utf8'), /has_work=false\nmatrix=\{"include":\[\]\}/);
});

test('more authorized skips than the batch size never starve forward progress', async t => {
  const c = fixture(t);
  const skipped = [];
  for (let index = 0; index < 7; index += 1) skipped.push(integrate(c, 'squash', `fix: skipped ${index + 1}`));
  const valid = integrate(c, 'squash', 'fix: finally valid');
  for (const sha of skipped) ownerSkip(c, sha);
  const ci = clone(c, 'ci');
  const api = fakeApi({ jobs: green([valid]) });
  const plan = await runPlan(ci.git, api, settings);
  assert.deepEqual(plan.stables, [valid]); // skips are neither validated nor counted
  assert.equal(plan.stableRemaining, 0);
  const result = await runPublish(ci.git, api, publishSettings());
  assert.deepEqual(result.skipped.map(item => item.source), skipped);
  assert.deepEqual(result.published.map(item => `${item.tag}:${item.source}`), [`v0.3.3:${valid}`]);
  assert.equal(result.progress, true);
  assert.equal(result.backlog, 0);
  assert.equal(releaseSource(ci.git, 'v0.3.3'), valid);
  assert.deepEqual(remoteTags(c).filter(name => name.startsWith('release-skip/')).sort(), skipped.map(sha => `release-skip/${sha}`).sort()); // only the owner's
  // Real validations still honor the batch size after the skips: 6 valid sources, only 5 are planned.
  const d = fixture(t);
  const marked = integrate(d, 'squash', 'fix: skipped alone');
  const real = [];
  for (let index = 0; index < 6; index += 1) real.push(integrate(d, 'squash', `fix: real ${index + 1}`));
  ownerSkip(d, marked);
  const plan2 = await runPlan(clone(d, 'ci').git, fakeApi(), settings);
  assert.deepEqual(plan2.stables, real.slice(0, 5));
  assert.equal(plan2.stableRemaining, 1);
});

test('a stable tag that appears on the remote while validating or retrying is rechecked before the push; nothing goes out of order', async t => {
  const stableSync = (git, source, version) => {
    const releaseCommit = createReleaseCommit(git, { source, version, channel: 'stable', baseTag: 'v0.3.2', commits: [], date: '2026-11-13' });
    annotate(git, { version, commit: releaseCommit, message: renderTagMessage({ version, channel: 'stable', source, previousStable: 'v0.3.2' }) });
    assert.equal(publishTag(git, { tag: `v${version}` }).status, 'published');
  };
  const scenarios = {
    'a higher stable rooted at a LATER source': { version: '0.4.0', pattern: /Apareció la estable v0\.4\.0/, rivalSource: 'later' },
    'a manual stable rooted at an EARLIER source, higher than our base': { version: '0.4.0', pattern: /Apareció la estable v0\.4\.0/, rivalSource: 'earlier' },
    'the same version name taken for another source': { version: '0.3.3', pattern: /traer las etiquetas/, rivalSource: 'later' },
  };
  for (const [name, scenario] of Object.entries(scenarios)) {
    const c = fixture(t);
    const m0 = integrate(c, 'squash', 'fix: earlier, owner-skipped');
    const m1 = integrate(c, 'squash', 'fix: ours');
    const m2 = integrate(c, 'squash', 'feat: later');
    ownerSkip(c, m0);
    const ci = clone(c, 'ci');
    const rival = clone(c, 'rival');
    let fetches = 0;
    const racing = wrap(ci.git, (args, options, git) => {
      if (args[0] === 'fetch' && args.some(arg => String(arg).startsWith('refs/tags/v*')) && ++fetches === 3) stableSync(rival.git, scenario.rivalSource === 'later' ? m2 : m0, scenario.version);
      return git(args, options);
    });
    // Our candidate is M1 (M0 carries the owner's marker, M2 waits behind M1 and is never validated here).
    const api = fakeApi({ jobs: green([m1]) });
    const result = await runPublish(racing, api, publishSettings());
    assert.deepEqual(result.published, [], name);
    assert.equal(result.exitCode, 1, name);
    assert.ok(result.failures.length >= 1, name);
    assert.match(result.failures[0].message, scenario.pattern, name);
    assert.equal(sh(ci.root, 'tag', '--list', '--format=%(refname:short) %(objecttype)', 'v0.3.*'), 'v0.3.2 tag', name); // no unpublished leftover of ours
    const remote = releaseTags(c);
    assert.deepEqual(remote, ['v0.3.2', `v${scenario.version}`], name);
    assert.equal(releaseSource(rival.git, `v${scenario.version}`), scenario.rivalSource === 'later' ? m2 : m0, name);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Correction round 1 / F1: published cursor and allocation are remote-authoritative at the WHOLE reconciliation boundary
// ---------------------------------------------------------------------------------------------------------------------

/** A fresh instance of the engine module: its in-memory `leftovers` map is empty, like a restarted process. */
const restarted = () => import(`../scripts/release-auto.mjs?restart=${++counter}`);

/** The state a lost/unknown push leaves: one validated integration, local `v0.3.3` retained, remote untouched or applied. */
async function unknownOutcome(t, { applyPush = false } = {}) {
  const c = fixture(t);
  const m1 = integrate(c, 'squash', 'fix: outcome unknown');
  const ci = clone(c, 'ci');
  const api = fakeApi({ jobs: green([m1]) });
  const first = await runPublish(blindPush(ci.git, { applyPush }), api, publishSettings());
  assert.equal(first.exitCode, 1);
  assert.deepEqual(first.published, []);
  assert.match(first.failures[0].message, /No se pudo confirmar si v0\.3\.3/);
  assert.equal(sh(ci.root, 'tag', '--list', 'v0.3.3'), 'v0.3.3'); // retained locally
  return { c, m1, ci, api, localObject: sh(ci.root, 'rev-parse', 'refs/tags/v0.3.3') };
}

/** The recovered stable is v0.3.3 for `source`, built from the PUBLISHED base v0.3.2 and published exactly once. */
function assertRecovered(c, ci, source, result, localObject) {
  assert.deepEqual(result.published.map(item => `${item.tag}:${item.source}`), [`v0.3.3:${source}`]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.backlog, 0);
  assert.deepEqual(releaseTags(c), ['v0.3.2', 'v0.3.3']);
  assert.equal(releaseSource(ci.git, 'v0.3.3'), source);
  assert.equal(readTagProvenance(ci.git, 'v0.3.3').meta.previousStable, 'v0.3.2');
  const changelog = sh(c.origin, 'show', 'refs/tags/v0.3.3:CHANGELOG.md');
  assert.match(changelog, /cambios desde `v0\.3\.2`/);
  assert.equal(changelog.split('\n').filter(line => line.startsWith('## [0.3.3]')).length, 1);
  assert.equal(sh(c.origin, 'rev-parse', 'refs/tags/v0.3.3'), sh(ci.root, 'rev-parse', 'refs/tags/v0.3.3'));
  if (localObject) assert.equal(sh(c.origin, 'rev-parse', 'refs/tags/v0.3.3'), localObject);
}

test('F1 same process: an unknown push with an absent remote keeps the source in plan, then publish publishes it from the published base', async t => {
  const { c, m1, ci, api } = await unknownOutcome(t);
  assert.deepEqual(releaseTags(c), ['v0.3.2']);
  const plan = await runPlan(ci.git, api, settings);
  assert.deepEqual(plan.stables, [m1]); // the source did not vanish from the cursor
  assert.equal(plan.baseTag, 'v0.3.2');
  assert.deepEqual(releaseTags(c), ['v0.3.2']);
  assertRecovered(c, ci, m1, await runPublish(ci.git, api, publishSettings()));
});

test('F1 restarted process: a retained local tag (empty in-memory state) is neither a cursor nor lost; plan, publish and a rerun reuse it exactly once', async t => {
  const { c, m1, ci, api, localObject } = await unknownOutcome(t);
  const fresh = await restarted();
  const plan = await fresh.runPlan(ci.git, api, settings);
  assert.deepEqual(plan.stables, [m1]);
  assert.equal(plan.baseTag, 'v0.3.2');
  assert.equal(sh(ci.root, 'rev-parse', 'refs/tags/v0.3.3'), localObject); // plan never touches local refs
  // Direct cursor analysis shows the contrast: the raw local list advances past the source, the remote-authoritative one does not.
  const tip = sh(c.root, 'rev-parse', 'main');
  assert.deepEqual(stableWork(ci.git, tip).candidates, []);
  assert.deepEqual(stableWork(ci.git, tip, { tags: fresh.publishedTagNames(ci.git, 'origin') }).candidates, [m1]);

  const result = await fresh.runPublish(ci.git, api, publishSettings());
  assertRecovered(c, ci, m1, result, localObject); // the pending tag was reused, not rebuilt
  const again = await fresh.runPublish(ci.git, api, publishSettings());
  assert.deepEqual([again.published, again.progress, again.backlog, again.exitCode], [[], false, 0, 0]);
  assert.deepEqual(releaseTags(c), ['v0.3.2', 'v0.3.3']);
});

test('F1 restarted process: when the lost push had actually reached the remote nothing is published twice and nothing turns red', async t => {
  const { c, m1, ci, api, localObject } = await unknownOutcome(t, { applyPush: true });
  assert.equal(sh(c.origin, 'rev-parse', 'refs/tags/v0.3.3'), localObject);
  const fresh = await restarted();
  assert.deepEqual((await fresh.runPlan(ci.git, api, settings)).stables, []);
  const result = await fresh.runPublish(ci.git, api, publishSettings());
  assert.deepEqual([result.published, result.exitCode, result.backlog], [[], 0, 0]);
  assert.deepEqual(releaseTags(c), ['v0.3.2', 'v0.3.3']);
  assert.equal(releaseSource(ci.git, 'v0.3.3'), m1);
});

function apiServer(t, { run, jobs, pulls = [] }) {
  const base = '/repos/owner/repo';
  const routes = new Map([
    [`${base}/pulls?state=open&per_page=100`, pulls],
    [`${base}/actions/runs/${run.id}`, run],
    [`${base}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`, { total_count: jobs.length, jobs }],
  ]);
  const server = createServer((request, response) => {
    const body = routes.get(request.url);
    response.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body ?? { message: 'Not Found' }));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => { t.after(() => server.close()); resolve(`http://127.0.0.1:${server.address().port}`); }));
}

const cli = (command, cwd, env) => new Promise(resolve => {
  const script = fileURLToPath(new URL('../scripts/release-auto.mjs', import.meta.url));
  execFile(process.execPath, [script, command], { cwd, env: { ...process.env, ...env }, encoding: 'utf8' }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
});

test('F1 real CLI processes: plan and publish after an unknown outcome are separate OS processes and still recover the source', async t => {
  const { c, m1, ci, localObject } = await unknownOutcome(t);
  const run = { id: RUN, run_attempt: 1, run_number: 3 };
  const url = await apiServer(t, { run, jobs: [job(m1)] });
  const env = { GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: 't', GITHUB_API_URL: url, GITHUB_RUN_ID: String(RUN), GITHUB_RUN_ATTEMPT: '1', GITHUB_ACTIONS: 'true' };
  const planOut = join(c.dir, 'plan.out');
  const planned = await cli('plan', ci.root, { ...env, GITHUB_OUTPUT: planOut });
  assert.equal(planned.code, 0, planned.stderr);
  const plannedOutputs = Object.fromEntries(readFileSync(planOut, 'utf8').trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  assert.deepEqual([plannedOutputs.has_work, plannedOutputs.matrix], ['true', JSON.stringify({ include: [{ source: m1 }] })]);
  assert.equal(sh(ci.root, 'rev-parse', 'refs/tags/v0.3.3'), localObject);
  assert.deepEqual(releaseTags(c), ['v0.3.2']);
  const publishOut = join(c.dir, 'publish.out');
  const published = await cli('publish', ci.root, { ...env, GITHUB_OUTPUT: publishOut });
  assert.equal(published.code, 0, published.stderr);
  assert.match(readFileSync(publishOut, 'utf8'), /published=\["v0\.3\.3"\]\npublished_count=1\n/);
  assertRecovered(c, ci, m1, { published: [{ tag: 'v0.3.3', source: m1 }], exitCode: 0, backlog: 0 }, localObject);
});

test('F1 foreign local refs are preserved: only a strictly valid pending tag for the exact source is reused, anything else fails visibly and untouched', async t => {
  const c = fixture(t);
  const m1 = integrate(c, 'squash', 'fix: first pending');
  const m2 = integrate(c, 'squash', 'fix: second pending');
  const ci = clone(c, 'ci');
  const api = fakeApi({ jobs: green([m1, m2]) });
  const base = sh(ci.root, 'rev-parse', 'v0.3.2^{commit}');
  // Local-only refs that must never become a cursor, an allocation base or a published tag.
  sh(ci.root, 'tag', 'v9.9.9', base); // lightweight, much higher
  sh(ci.root, 'tag', '-a', 'v0.5.0', '-m', 'MDD 0.5.0\n\nChannel: stable\nSource-Commit: nope', base); // malformed provenance
  const refs = () => sh(ci.root, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/tags');
  // v0.3.3 is a valid pending release, but for ANOTHER source (m2): foreign for the m1 candidate.
  const foreign = createReleaseCommit(ci.git, { source: m2, version: '0.3.3', channel: 'stable', baseTag: 'v0.3.2', commits: [], date: '2026-11-13' });
  annotate(ci.git, { version: '0.3.3', commit: foreign, message: renderTagMessage({ version: '0.3.3', channel: 'stable', source: m2, previousStable: 'v0.3.2' }) });
  const before = refs();
  const plan = await runPlan(ci.git, api, settings);
  assert.deepEqual(plan.stables, [m1, m2]); // none of the local-only tags moved the cursor, malformed ones did not even get read
  assert.equal(plan.baseTag, 'v0.3.2');
  const blocked = await runPublish(ci.git, api, publishSettings());
  assert.deepEqual(blocked.published, []);
  assert.equal(blocked.exitCode, 1);
  assert.match(blocked.failures[0].message, /Existe una etiqueta local v0\.3\.3 que no es el release pendiente/);
  assert.equal(blocked.failures[0].source, m1);
  assert.equal(refs(), before); // no ref moved or deleted
  assert.deepEqual(releaseTags(c), ['v0.3.2']);
  assert.deepEqual((await runPlan(ci.git, api, settings)).stables, [m1, m2]); // still pending, not hidden

  // Foreign names that are not in the way (v9.9.9, v0.5.0) are simply ignored once the conflicting ref is resolved by its owner.
  sh(ci.root, 'tag', '-d', 'v0.3.3');
  const done = await runPublish(ci.git, api, publishSettings());
  assert.deepEqual(done.published.map(item => `${item.tag}:${item.source}`), [`v0.3.3:${m1}`, `v0.3.4:${m2}`]);
  assert.equal(done.exitCode, 0);
  assert.match(sh(c.origin, 'show', 'refs/tags/v0.3.3:CHANGELOG.md'), /cambios desde `v0\.3\.2`/);
  assert.match(sh(c.origin, 'show', 'refs/tags/v0.3.4:CHANGELOG.md'), /cambios desde `v0\.3\.3`/);
  assert.equal(sh(ci.root, 'cat-file', '-t', 'refs/tags/v0.5.0'), 'tag');
  assert.equal(sh(ci.root, 'rev-parse', 'refs/tags/v9.9.9'), base);
  assert.deepEqual(releaseTags(c), ['v0.3.2', 'v0.3.3', 'v0.3.4']); // the foreign refs never reached the remote
});

test('F1 a conflicting remote tag for a retained local name fails visibly from a restarted process and neither side is changed', async t => {
  const { c, ci, api, localObject } = await unknownOutcome(t);
  const rival = clone(c, 'rival');
  const theirs = commit(rival.root, 'fix: theirs');
  sh(rival.root, 'push', '-q', 'origin', 'main');
  const their = await publishRelease(rival.git, { source: theirs, channel: 'stable' });
  assert.equal(their.tag, 'v0.3.3');
  const fresh = await restarted();
  await assert.rejects(fresh.runPlan(ci.git, api, settings), error => error.reason === 'fetch' && /traer las etiquetas/.test(error.message));
  await assert.rejects(fresh.runPublish(ci.git, api, publishSettings()), error => error.reason === 'fetch');
  assert.equal(sh(ci.root, 'rev-parse', 'refs/tags/v0.3.3'), localObject); // never forced
  assert.equal(sh(c.origin, 'rev-parse', 'refs/tags/v0.3.3'), their.object);
  assert.deepEqual(releaseTags(c), ['v0.3.2', 'v0.3.3']);
  assert.notEqual(localObject, their.object);
});

test('F1 same process knows its own retained tag, drops the lost copy and plans against the real remote state', async t => {
  const { c, ci, api } = await unknownOutcome(t);
  const rival = clone(c, 'rival');
  const theirs = commit(rival.root, 'fix: theirs');
  sh(rival.root, 'push', '-q', 'origin', 'main');
  const their = await publishRelease(rival.git, { source: theirs, channel: 'stable' });
  const plan = await runPlan(ci.git, api, settings);
  assert.equal(plan.baseTag, 'v0.3.3');
  assert.equal(sh(ci.root, 'rev-parse', 'refs/tags/v0.3.3'), their.object); // our unpublished copy was replaced by the real one
  assert.deepEqual(plan.stables, []); // their release already covers our earlier commit
});

test('F1 an outage of the remote tag listing fails the whole reconciliation closed before anything is built or derived', async t => {
  const c = fixture(t);
  const m1 = integrate(c, 'squash', 'fix: listing outage');
  const ci = clone(c, 'ci');
  const api = fakeApi({ jobs: green([m1]) });
  const down = wrap(ci.git, (args, options, git) => {
    if (args[0] === 'ls-remote') throw new Error('git ls-remote: network down');
    return git(args, options);
  });
  await assert.rejects(publishRelease(down, { source: m1, channel: 'stable' }), error => error instanceof PublishError && error.reason === 'fetch');
  await assert.rejects(runPlan(down, api, settings), error => error.reason === 'fetch');
  await assert.rejects(runPublish(down, api, publishSettings()), error => error.reason === 'fetch');
  const out = join(c.dir, 'down.out');
  assert.equal(await main(['publish'], { env: { GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: String(RUN), GITHUB_RUN_ATTEMPT: '1', GITHUB_OUTPUT: out }, git: down, client: api, stdout: () => {}, stderr: () => {} }), 1);
  assert.match(readFileSync(out, 'utf8'), /published=\[\]\n.*\nexit_code=1\n$/s);
  assert.equal(sh(ci.root, 'tag', '--list', 'v0.3.3'), '');
  assert.deepEqual(releaseTags(c), ['v0.3.2']);
});

test('publishedTagNames: only exact remote object and peeled commit count; syncReleaseTags is the shared boundary', async t => {
  const c = fixture(t);
  const source = commit(c.root, 'fix: names');
  sh(c.root, 'push', '-q', 'origin', 'main');
  const ci = clone(c, 'ci');
  assert.deepEqual(publishedTagNames(ci.git, 'origin'), ['v0.3.2']);
  sh(ci.root, 'tag', 'v0.3.3', source); // lightweight, local only
  sh(ci.root, 'tag', '-a', 'v0.3.4', '-m', 'local only', source);
  sh(ci.root, 'tag', 'vnot-a-release', source);
  sh(c.root, 'tag', 'v0.4.0', source); // lightweight on the remote ...
  sh(c.root, 'push', '-q', 'origin', 'refs/tags/v0.4.0');
  sh(ci.root, 'tag', '-a', 'v0.4.0', '-m', 'annotated here, lightweight there', source); // ... annotated locally: differs
  assert.deepEqual(publishedTagNames(ci.git, 'origin'), ['v0.3.2']);
  assert.throws(() => syncReleaseTags(ci.git, 'origin'), error => error.reason === 'fetch'); // differing v0.4.0 is never forced
  sh(ci.root, 'tag', '-d', 'v0.4.0');
  assert.deepEqual(syncReleaseTags(ci.git, 'origin'), ['v0.3.2', 'v0.4.0']); // the lightweight remote tag is fetched and matches
  assert.deepEqual(findPublished(ci.git, { source, channel: 'stable', remote: 'origin' }).map(info => info.tag), ['v0.4.0']);
  assert.throws(() => publishedTagNames(ci.git, 'missing-remote'), error => error instanceof PublishError && error.reason === 'fetch');
});

// ---------------------------------------------------------------------------------------------------------------------
// Correction round 1 / F2: fair preview windows rotated by GitHub's per-workflow run counter
// ---------------------------------------------------------------------------------------------------------------------

function previewFixture(t, count) {
  const c = fixture(t);
  const heads = [];
  for (let number = 1; number <= count; number += 1) heads.push(prHead(c, number, `fix: window ${number}`));
  return { c, heads, pulls: heads.map((sha, index) => pr(index + 1, sha)), ci: clone(c, 'ci') };
}
const runNumber = (api, number, attempt = 1) => { api.run = { id: RUN, run_attempt: attempt, run_number: number }; };
const planSettings = (attempt = 1) => ({ ...settings, runId: RUN, attempt });
const previewTags = c => releaseTags(c).filter(name => name.includes('-preview.'));

test('F2 windows rotate with the run counter, tile the list, are stable per run and attempt, and recompute from a fresh inventory', async t => {
  const { c, heads, pulls, ci } = previewFixture(t, 8);
  const api = fakeApi({ pulls });
  const windows = [];
  for (let number = 1; number <= 5; number += 1) {
    runNumber(api, number);
    const plan = await runPlan(ci.git, api, planSettings());
    windows.push(plan.previews.map(item => item.number));
    assert.equal(plan.previewRemaining, 3);
    assert.deepEqual(plan.previewWindow, { runNumber: number, start: ((number - 1) * 5) % 8, size: 8 });
  }
  assert.deepEqual(windows, [[1, 2, 3, 4, 5], [6, 7, 8, 1, 2], [3, 4, 5, 6, 7], [8, 1, 2, 3, 4], [5, 6, 7, 8, 1]]);
  // Fairness: any ceil(8/5)=2 consecutive runs include every pull request.
  for (let index = 0; index + 1 < windows.length; index += 1) assert.deepEqual([...new Set([...windows[index], ...windows[index + 1]])].sort(), [1, 2, 3, 4, 5, 6, 7, 8]);

  // A re-run of the same run (attempt 2) keeps its window; so does repeating the plan; getRun is the only source of the counter.
  runNumber(api, 3, 2);
  const rerun = await runPlan(ci.git, api, planSettings(2));
  assert.deepEqual(rerun.previews.map(item => item.number), [3, 4, 5, 6, 7]);
  assert.deepEqual((await runPlan(ci.git, api, planSettings(2))).previews, rerun.previews);

  // Without a run id (local dry run) the window starts at the lowest number, as before.
  assert.deepEqual((await runPlan(ci.git, fakeApi({ pulls }), settings)).previews.map(item => item.number), [1, 2, 3, 4, 5]);
  assert.deepEqual((await previewWork(ci.git, fakeApi({ pulls }), { repo: REPO, author: 'vancinis', batch: 3, runNumber: 4 })).candidates.map(item => item.number), [2, 3, 4]); // start (3 * 3) mod 8 = 1

  // Publication selects the SAME window as the plan of that run (own getRun, never plan outputs) and authorizes only successes.
  runNumber(api, 2);
  api.jobs = green([heads[5], heads[6]]); // PRs 6 and 7 passed; 8, 1 and 2 have no verdict, PR 8 first in the window order
  const result = await runPublish(ci.git, api, publishSettings());
  assert.deepEqual(result.published.map(item => `${item.number}:${item.tag}`), ['6:v0.3.3-preview.1', '7:v0.3.3-preview.2']);
  assert.deepEqual(result.pending.map(item => item.number), [8, 1, 2]);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(previewTags(c), ['v0.3.3-preview.1', 'v0.3.3-preview.2']);
});

test('F2 five failed previews no longer starve a later ready PR; failed or missing verdicts never authorize; no spin without progress', async t => {
  const { c, heads, pulls, ci } = previewFixture(t, 6);
  const api = fakeApi({ pulls, jobs: [...[1, 2, 3, 4].map(n => job(heads[n - 1], 'failure')), job(heads[5])] }); // 1-4 fail, 5 has no job, 6 is green
  runNumber(api, 1);
  const plan1 = await runPlan(ci.git, api, planSettings());
  assert.deepEqual(plan1.previews.map(item => item.number), [1, 2, 3, 4, 5]);
  const first = await runPublish(ci.git, api, publishSettings());
  assert.deepEqual(first.published, []);
  assert.deepEqual(first.skipped.map(item => item.number), [1, 2, 3, 4]);
  assert.deepEqual(first.pending.map(item => item.number), [5]);
  assert.deepEqual([first.progress, first.continue, first.exitCode], [false, false, 0]); // nothing authorized, nothing re-dispatched
  assert.equal(first.backlog, 2); // PR 5 pending plus PR 6 outside the window
  assert.deepEqual(previewTags(c), []);

  // Next scheduled run: the window moves on and the ready PR is validated and published.
  runNumber(api, 2);
  const plan2 = await runPlan(ci.git, api, planSettings());
  assert.deepEqual(plan2.previews.map(item => item.number), [6, 1, 2, 3, 4]);
  assert.deepEqual(plan2.sources, [heads[5], heads[0], heads[1], heads[2], heads[3]]);
  const second = await runPublish(ci.git, api, publishSettings());
  assert.deepEqual(second.published.map(item => `${item.number}:${item.tag}`), ['6:v0.3.3-preview.1']);
  assert.deepEqual(second.skipped.map(item => item.number), [1, 2, 3, 4]);
  assert.deepEqual([second.progress, second.exitCode], [true, 0]);
  assert.equal(second.backlog, 1); // PR 5, still unvalidated and outside this window: continuation may rotate to it
  assert.equal(second.continue, true);
  assert.equal(readTagProvenance(ci.git, 'v0.3.3-preview.1').meta.pullRequest, '6');
  assert.deepEqual(previewTags(c), ['v0.3.3-preview.1']);

  // Only failing/unvalidated heads remain: each run still publishes nothing, and does not ask to continue.
  for (const number of [3, 4, 5]) {
    runNumber(api, number);
    const run = await runPublish(ci.git, api, publishSettings());
    assert.deepEqual([run.published, run.progress, run.continue, run.exitCode], [[], false, false, 0], `run ${number}`);
  }
  assert.deepEqual(previewTags(c), ['v0.3.3-preview.1']);

  // Eligibility and head membership changes recompute the window from the fresh inventory: a draft is never planned, a moved
  // head is a new source, and a PR published for its current head leaves the waiting list.
  runNumber(api, 2);
  api.pulls.find(item => item.number === 3).draft = true;
  const newHead = prHead(c, 5, 'fix: window 5, new head');
  api.pulls.find(item => item.number === 5).head.sha = newHead;
  api.jobs = [...api.jobs, job(newHead)];
  const changed = await runPlan(ci.git, api, planSettings());
  assert.deepEqual(changed.previews.map(item => item.number), [2, 4, 5, 1]); // 6 is published, 3 is a draft: n = 4, start (1 * 5) mod 4 = 1
  assert.equal(changed.previews.find(item => item.number === 5).source, newHead);
  const third = await runPublish(ci.git, api, publishSettings());
  assert.deepEqual(third.published.map(item => `${item.number}:${item.tag}`), ['5:v0.3.3-preview.2']);
  assert.equal(third.continue, false); // no backlog left that could be validated: 1, 2, 4 failed
});

test('F2 more previews than a batch with every validation green: continuation while progress and backlog, then done', async t => {
  const { c, heads, pulls, ci } = previewFixture(t, 7);
  const api = fakeApi({ pulls, jobs: green(heads) });
  runNumber(api, 1);
  const first = await runPublish(ci.git, api, publishSettings());
  assert.deepEqual(first.published.map(item => item.number), [1, 2, 3, 4, 5]);
  assert.deepEqual([first.backlog, first.continue], [2, true]);
  runNumber(api, 2); // the continuation is a new run: 6 and 7 remain, start (1*5) mod 2 = 1
  assert.deepEqual((await runPlan(ci.git, api, planSettings())).previews.map(item => item.number), [7, 6]);
  const second = await runPublish(ci.git, api, publishSettings());
  assert.deepEqual(second.published.map(item => item.number), [7, 6]);
  assert.deepEqual([second.backlog, second.continue], [0, false]);
  runNumber(api, 3);
  const third = await runPublish(ci.git, api, publishSettings());
  assert.deepEqual([third.published, third.progress, third.continue], [[], false, false]);
  assert.equal(previewTags(c).length, 7);
});

test('F2 the run counter must come from GitHub for exactly this run: identity, attempt and number are validated and fail closed before any Git work', async t => {
  const untouched = () => { throw new Error('must not touch git before the run is trusted'); };
  const planWith = run => runPlan(untouched, fakeApi({ run }), planSettings());
  await assert.rejects(planWith({ id: 999, run_attempt: 1, run_number: 5 }), /no está en el intento 1/);
  await assert.rejects(runPlan(untouched, fakeApi({ run: { id: 999, run_attempt: 1, run_number: 5 } }), { ...settings, runId: RUN }), /no coincide con la respuesta de GitHub/); // attempt not given
  await assert.rejects(planWith({ id: RUN, run_attempt: 2, run_number: 5 }), /no está en el intento 1/);
  for (const bad of [undefined, 0, -1, 1.5, '5', null, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(planWith({ id: RUN, run_attempt: 1, run_number: bad }), /run_number válido/, String(bad));
    await assert.rejects(runPublish(untouched, fakeApi({ run: { id: RUN, run_attempt: 1, run_number: bad } }), publishSettings()), /run_number válido/, String(bad));
  }
  await assert.rejects(runPublish(untouched, fakeApi({ run: { id: 999, run_attempt: 1, run_number: 5 } }), publishSettings()), /no está en el intento 1/);

  // CLI wiring: Actions must provide the run id; malformed ids are usage errors; the real client reads run_number from the API
  // over every page of pull requests, whatever their order.
  const logs = { err: '' };
  const io = { stdout: () => {}, stderr: text => { logs.err += text; } };
  const guard = { git: untouched, client: fakeApi(), ...io };
  assert.equal(await main(['plan'], { env: { GITHUB_REPOSITORY: REPO, GITHUB_ACTIONS: 'true' }, ...guard }), 2);
  assert.match(logs.err, /requiere GITHUB_RUN_ID/);
  for (const env of [{ GITHUB_RUN_ID: 'x' }, { GITHUB_RUN_ID: '0' }, { GITHUB_RUN_ID: '5', GITHUB_RUN_ATTEMPT: 'x' }]) {
    assert.equal(await main(['plan'], { env: { GITHUB_REPOSITORY: REPO, ...env }, ...guard }), 2, JSON.stringify(env));
  }

  const { heads, ci, c } = previewFixture(t, 6);
  const base = 'https://api.github.com/repos/owner/repo';
  const requests = [];
  const reply = (data, next) => ({ ok: true, status: 200, headers: { get: name => (name.toLowerCase() === 'link' && next ? `<${next}>; rel="next"` : null) }, json: async () => data });
  const fetch = async url => {
    requests.push(url);
    if (url === `${base}/actions/runs/${RUN}`) return reply({ id: RUN, run_attempt: 1, run_number: 2 });
    if (url === `${base}/pulls?state=open&per_page=100`) return reply([5, 6, 4].map(n => pr(n, heads[n - 1])), `${base}/pulls?state=open&per_page=100&page=2`);
    if (url === `${base}/pulls?state=open&per_page=100&page=2`) return reply([3, 1, 2].map(n => pr(n, heads[n - 1])));
    throw new Error(`unexpected ${url}`);
  };
  const out = join(c.dir, 'rotated.out');
  const code = await main(['plan'], { env: { GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: 't', GITHUB_RUN_ID: String(RUN), GITHUB_RUN_ATTEMPT: '1', GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: out }, git: ci.git, fetch, ...io });
  assert.equal(code, 0);
  const outputs = Object.fromEntries(readFileSync(out, 'utf8').trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  assert.deepEqual(JSON.parse(outputs.matrix).include.map(item => item.source), [heads[5], heads[0], heads[1], heads[2], heads[3]]); // window [6,1,2,3,4]
  assert.equal(outputs.preview_remaining, '1');
  assert.equal(requests.filter(url => url.endsWith(`/actions/runs/${RUN}`)).length, 1);
  assert.ok(requests.every(url => url.startsWith(base)));
});
