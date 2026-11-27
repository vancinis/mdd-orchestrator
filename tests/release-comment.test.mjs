import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { annotate, createAutoGit, createReleaseCommit, renderTagMessage } from '../scripts/release-auto.mjs';
import { main, upsertComment } from '../scripts/release-comment.mjs';

const repo = 'owner/project';
const marker = '<!-- mdd-release-preview -->';
const bot = { login: 'github-actions[bot]', type: 'Bot' };
const number = 9;
const env = {
  GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2',
  RELEASE_PREVIEW_AUTHOR: 'owner', GITHUB_STEP_SUMMARY: 'summary',
};

test('the CLI reconciles all eligible PRs from remote Git state and current-attempt jobs', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mdd-comment-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin.git');
  const git = createAutoGit(root);
  git(['init', '-q', '--bare', '-b', 'main', origin]);
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['remote', 'add', 'origin', origin]);
  const pkg = { name: 'my-driven-development', version: '0.3.1' };
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(join(root, 'package-lock.json'), `${JSON.stringify({ ...pkg, lockfileVersion: 3, packages: { '': pkg } }, null, 2)}\n`);
  git(['add', '--', 'package.json', 'package-lock.json']);
  const commit = subject => {
    git(['commit', '-qm', subject, '--allow-empty']);
    return git(['rev-parse', 'HEAD']).trim();
  };
  const base = commit('feat: initial');
  git(['tag', 'v0.3.2']);
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ ...pkg, version: '0.3.3' }, null, 2)}\n`);
  git(['add', '--', 'package.json']);
  const tip = commit('fix: main integration');
  git(['checkout', '--detach', base]);
  const older = commit('feat: older head');
  const makePreview = (source, version) => {
    const release = createReleaseCommit(git, { source, version, channel: 'preview', baseTag: 'v0.3.2', commits: [] });
    annotate(git, { version, commit: release, message: renderTagMessage({
      version, channel: 'preview', source, pullRequest: String(number), mainCommit: tip,
      previousStable: 'v0.3.2', workflowRun: '41',
    }) });
  };
  makePreview(older, '0.4.0-preview.1');
  const head = commit('feat: current head');
  const next = commit('fix: changed head');
  makePreview(head, '0.4.0-preview.2'); // Initially local-only.
  const pull = (number, sha = head, extras = {}) => ({
    number, state: 'open', draft: false, user: { login: 'owner', type: 'User' },
    base: { ref: 'main', repo: { full_name: repo } },
    head: { sha, ref: '| injected branch |', repo: { full_name: repo } },
    title: 'injected title', body: 'injected body', ...extras,
  });
  const pulls = [
    ...[1, 2, 3, 4, 5, 6, number, 10].map(n => pull(n)),
    pull(11, head, { draft: true }),
    pull(12, head, { user: { login: 'someone-else', type: 'User' } }),
    pull(13, head, { head: { sha: head, repo: { full_name: 'owner/fork' } } }),
    pull(14, head, { base: { ref: 'develop', repo: { full_name: repo } } }),
  ];
  git(['push', '-q', 'origin', 'main', 'v0.3.2', 'v0.4.0-preview.1',
    ...[1, 2, 3, 4, 5, 6, number, 10].map(n => `${n === 1 ? older : head}:refs/pull/${n}/head`)]);
  const refs = () => git(['--git-dir', origin, 'for-each-ref', '--format=%(refname) %(objectname)']);
  const comments = new Map(); const writes = []; const summaries = []; const errors = [];
  let inventory = pulls; let conclusion = 'failure'; let jobAttempt = 1; let runAttempt = 2;
  let live = n => pulls.find(pr => pr.number === n);
  const client = {
    listOpenPulls: async () => inventory,
    getRun: async id => ({ id, run_attempt: runAttempt, run_number: 12 }),
    listJobs: async () => [{ name: `validate ${head}`, run_id: 42, run_attempt: jobAttempt, status: 'completed', conclusion }],
    getPull: async n => live(n),
    listIssueComments: async n => {
      if (n === 2) throw new Error('GitHub API respondió 503');
      return comments.has(n) ? [comments.get(n)] : [];
    },
    createIssueComment: async (n, body) => {
      writes.push(['POST', n]);
      comments.set(n, { id: 100 + n, body, user: bot });
    },
    updateIssueComment: async (id, body) => {
      writes.push(['PATCH', id]);
      [...comments.values()].find(comment => comment.id === id).body = body;
    },
  };
  const run = (overrides = {}) => main([], {
    env, git, client, stdout: () => {}, stderr: text => errors.push(text),
    summaryWriter: (file, text) => { assert.equal(file, 'summary'); summaries.push(text); },
    now: () => new Date('2026-11-24T12:00:00Z'), ...overrides,
  });
  const body = () => comments.get(number).body;
  const before = refs();
  assert.equal(await run(), 0);
  assert.deepEqual(writes, [3, 4, 5, 6, number, 10].map(n => ['POST', n]));
  assert.equal(refs(), before);
  assert.equal(git(['rev-parse', 'HEAD']).trim(), next);
  assert.match(summaries.at(-1), /#1\b.*omitid|omitid.*#1/i);
  assert.match(summaries.at(-1), /#2\b.*503/);
  assert.match(body(), /^<!-- mdd-release-preview -->\n/);
  assert.match(body(), /\| Versión anterior \| `v0\.3\.2` \|/);
  assert.match(body(), new RegExp(`\\| .*package\\.json.* \\| .*0\\.3\\.1.*${base.slice(0, 7)}`));
  assert.match(body(), /pendiente de validación/i);
  assert.match(body(), /\[.*v0\.4\.0-preview\.1.*\]\(https:\/\/github\.com\/owner\/project\/tree\/v0\.4\.0-preview\.1\)/);
  assert.match(body(), /\| Estable prevista.*v0\.4\.0.*minor/);
  assert.match(body(), /1 integraci[oó]n/);
  assert.ok(body().includes(head.slice(0, 7)));
  assert.match(body(), /https:\/\/github\.com\/owner\/project\/actions\/runs\/42/);
  assert.match(body(), /2026-11-24T12:00:00\.000Z/);
  assert.doesNotMatch(body(), /injected/);

  inventory = pulls.filter(pr => pr.number === number);
  jobAttempt = 2;
  assert.equal(await run(), 0);
  assert.match(body(), /validación fallida/i);
  conclusion = 'success';
  assert.equal(await run(), 0);
  assert.match(body(), /validada, publicación pendiente/i);
  git(['push', '-q', 'origin', 'v0.4.0-preview.2']);
  assert.equal(await run(), 0);
  assert.match(body(), /publicada.*\]\(https:\/\/github\.com\/owner\/project\/tree\/v0\.4\.0-preview\.2\)/i);
  writes.length = 0;
  assert.equal(await run({ env: { ...env, GITHUB_RUN_ID: '43' }, now: () => new Date('2026-11-25') }), 0);
  assert.deepEqual(writes, []);
  assert.match(body(), /\/runs\/42/);

  git(['push', '-q', 'origin', `${next}:refs/pull/${number}/head`]);
  pulls.find(pr => pr.number === number).head.sha = next;
  const snapshot = body();
  live = n => n === number ? pull(n, head) : pulls.find(pr => pr.number === n);
  assert.equal(await run(), 0);
  assert.equal(body(), snapshot);
  assert.match(summaries.at(-1), /#9\b.*omitid|omitid.*#9/i);
  live = n => n === number ? pull(n, next, { draft: true }) : pulls.find(pr => pr.number === n);
  assert.equal(await run(), 0);
  assert.deepEqual(writes, []);
  live = n => pulls.find(pr => pr.number === n);
  assert.equal(await run(), 0);
  assert.deepEqual(writes, [['PATCH', 109]]);
  assert.ok(body().includes(next.slice(0, 7)));
  assert.match(body(), /pendiente de validación/i);
  assert.match(body(), /última preview publicada de esta PR.*v0\.4\.0-preview\.2/i);

  runAttempt = 3;
  assert.equal(await run(), 1);
  assert.match(errors.at(-1), /intento 2/);
});

test('sticky identity requires the first-line marker and exact bot author; the lowest matching id wins', async () => {
  const body = `${marker}\nnew content`;
  const others = [
    { id: 1, body: marker, user: { ...bot, type: 'User' } },
    { id: 2, body: marker, user: { ...bot, login: 'different[bot]' } },
    { id: 3, body: `other text\n${marker}`, user: bot },
  ];
  let existing = others;
  const writes = [];
  const client = {
    listIssueComments: async () => existing,
    getPull: async () => ({ number }),
    createIssueComment: async (...args) => writes.push(['POST', ...args]),
    updateIssueComment: async (...args) => writes.push(['PATCH', ...args]),
  };
  await upsertComment(client, number, body, () => true);
  existing = [...others, { id: 7, body: marker, user: bot }, { id: 4, body: marker, user: bot }];
  await upsertComment(client, number, body, () => true);
  assert.deepEqual(writes, [['POST', number, body], ['PATCH', 4, body]]);
});

test('CLI help does not need environment or dependencies; bad usage exits 2', async () => {
  const messages = [];
  const bindings = { env: {}, stdout: text => messages.push(text), stderr: text => messages.push(text) };
  assert.equal(await main(['--help'], bindings), 0);
  assert.match(messages.at(-1), /Uso: node scripts\/release-comment\.mjs/);
  assert.equal(await main(['--unknown'], bindings), 2);
  assert.equal(await main([], bindings), 2);
  assert.match(messages.at(-1), /GITHUB_REPOSITORY/);
});
