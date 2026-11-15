import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The repository has no YAML dependency, so this file parses the restricted YAML subset the two workflows use
// (block maps and lists, flow lists, quoted and plain scalars, `#` comments, `|` block scalars). Anything outside that
// subset (tabs, anchors, duplicate keys, bad indentation) throws, so a workflow edit cannot silently escape the checks.

const read = name => readFileSync(fileURLToPath(new URL(`../.github/workflows/${name}`, import.meta.url)), 'utf8');

function scalar(text, where) {
  const quoted = /^(["'])(.*)\1$/.exec(text);
  if (quoted) return quoted[2];
  if (/^[&*!|>]/.test(text) || text.startsWith('{') && text !== '{}') throw new Error(`${where}: unsupported YAML ${text}`);
  if (text === '{}') return {};
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) throw new Error(`${where}: unterminated flow list`);
    const inner = text.slice(1, -1).trim();
    return inner ? inner.split(',').map(item => scalar(item.trim(), where)) : [];
  }
  const plain = text.replace(/\s+#.*$/, '');
  if (plain === 'true') return true;
  if (plain === 'false') return false;
  if (plain === 'null' || plain === '~') return null;
  if (/^\d+$/.test(plain)) return Number(plain);
  return plain;
}

export function parseYaml(source) {
  if (source.includes('\t')) throw new Error('tabs are not valid YAML indentation');
  const lines = source.split(/\r?\n/).map((raw, index) => ({ raw, number: index + 1, indent: raw.length - raw.trimStart().length, text: raw.trim() }));
  let pos = 0;
  const skip = () => { while (pos < lines.length && (!lines[pos].text || lines[pos].text.startsWith('#'))) pos += 1; };
  const peek = () => { skip(); return lines[pos]; };
  const isDash = line => line.text === '-' || line.text.startsWith('- ');
  const keyPattern = /^("[^"]+"|'[^']+'|[^\s:#'"[{-][^:]*?|-[^\s:][^:]*?):(?:\s+(.*))?$/;

  function node(indent) {
    const line = peek();
    if (!line || line.indent < indent) return null;
    return isDash(line) ? list(line.indent) : map(line.indent);
  }

  function map(indent) {
    const result = {};
    for (let line = peek(); line && line.indent === indent && !isDash(line); line = peek()) {
      const match = keyPattern.exec(line.text);
      if (!match) throw new Error(`line ${line.number}: cannot parse "${line.text}"`);
      const key = match[1].replace(/^["']|["']$/g, '');
      if (Object.hasOwn(result, key)) throw new Error(`line ${line.number}: duplicate key ${key}`);
      const value = match[2]?.trim() ?? '';
      pos += 1;
      if (/^[|>][+-]?$/.test(value)) {
        const body = [];
        while (pos < lines.length && (!lines[pos].text || lines[pos].indent > indent)) { body.push(lines[pos]); pos += 1; }
        const first = body.find(item => item.text);
        const strip = first ? first.indent : 0;
        result[key] = body.map(item => item.raw.slice(strip)).join('\n').replace(/\n+$/, '\n');
      } else if (value === '') {
        const next = peek();
        result[key] = next && (next.indent > indent || (next.indent === indent && isDash(next))) ? node(next.indent) : null;
      } else {
        result[key] = scalar(value, `line ${line.number}`);
      }
    }
    const stray = peek();
    if (stray && stray.indent > indent) throw new Error(`line ${stray.number}: unexpected indentation`);
    return result;
  }

  function list(indent) {
    const result = [];
    for (let line = peek(); line && line.indent === indent && isDash(line); line = peek()) {
      const rest = line.text.slice(1).trim();
      if (!rest) { pos += 1; result.push(node(indent + 1)); continue; }
      if (keyPattern.test(rest) && !/^["'[]/.test(rest)) {
        // `- key: value` is a map item whose keys sit two columns further in.
        lines[pos] = { ...line, indent: indent + 2, text: rest };
        result.push(map(indent + 2));
      } else { pos += 1; result.push(scalar(rest, `line ${line.number}`)); }
    }
    return result;
  }

  const document = node(0);
  const rest = peek();
  if (rest) throw new Error(`line ${rest.number}: trailing content`);
  return document;
}

const ciText = read('ci.yml');
const releaseText = read('release.yml');
const ci = parseYaml(ciText);
const release = parseYaml(releaseText);

// Pins verified on 2026-11-13 through the GitHub API (tag -> commit, lightweight tags).
const PINS = {
  'actions/checkout': { sha: '3d3c42e5aac5ba805825da76410c181273ba90b1', tag: 'v7.0.1' },
  'actions/setup-node': { sha: '949feb2413d6458794dcd2491c4babbbce0c15c1', tag: 'v7.1.0' },
};
const TRUSTED_REF = '${{ github.workflow_sha }}';
const REPOSITORY_GUARD = "github.repository == 'vancinis/mdd-orchestrator' && github.ref == 'refs/heads/main'";

const uses = job => job.steps.filter(step => step.uses);
const checkouts = job => uses(job).filter(step => step.uses.startsWith('actions/checkout@'));
const runs = job => job.steps.filter(step => typeof step.run === 'string').map(step => step.run);
const allSteps = workflow => Object.values(workflow.jobs).flatMap(job => job.steps);
const compact = text => String(text).replace(/\s+/g, ' ').trim();

/** Evaluates the small `a && b && !c` boolean grammar of job conditions over a set of named atoms. */
function evaluate(condition, atoms) {
  const expression = compact(condition).replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  return expression.split('&&').map(part => part.trim()).every(part => {
    const negated = part.startsWith('!');
    const atom = negated ? part.slice(1) : part;
    if (!Object.hasOwn(atoms, atom)) throw new Error(`condition atom not modelled: ${atom}`);
    return negated ? !atoms[atom] : atoms[atom];
  });
}

test('the YAML subset parser reads the two workflows and rejects unsupported syntax', () => {
  assert.equal(ci.name, 'CI');
  assert.equal(release.name, 'Release');
  assert.deepEqual(parseYaml('a:\n  - b: 1\n    c: [x, y]\n  - d\n'), { a: [{ b: 1, c: ['x', 'y'] }, 'd'] });
  assert.throws(() => parseYaml('a: 1\na: 2\n'), /duplicate key/);
  assert.throws(() => parseYaml('a:\n\t- b\n'), /tabs/);
  assert.throws(() => parseYaml('a: &anchor x\n'), /unsupported/);
});

test('both workflows deny all permissions at the top level and grant them per job', () => {
  for (const workflow of [ci, release]) {
    assert.deepEqual(workflow.permissions, {});
    for (const [name, job] of Object.entries(workflow.jobs)) {
      assert.ok(job.permissions && typeof job.permissions === 'object' && Object.keys(job.permissions).length > 0, `${name} declares its own permissions`);
      assert.equal(job['runs-on'], 'ubuntu-latest', `${name} runs on a GitHub-hosted runner`);
      assert.ok(Number.isInteger(job['timeout-minutes']), `${name} has a timeout`);
    }
  }
  assert.deepEqual(ci.jobs.validate.permissions, { contents: 'read' });
  const { jobs } = release;
  // actions: read is read-only and only lets plan fetch this run's own record (run_number) for the fair preview window.
  assert.deepEqual(jobs.prepare.permissions, { contents: 'read', 'pull-requests': 'read', actions: 'read' });
  assert.deepEqual(jobs.validate.permissions, { contents: 'read' });
  assert.deepEqual(jobs.publish.permissions, { contents: 'write', actions: 'read', 'pull-requests': 'read' });
  assert.deepEqual(jobs.smoke.permissions, { contents: 'read' });
  assert.deepEqual(jobs.continue.permissions, { actions: 'write' });
  const writers = Object.entries(jobs).filter(([, job]) => Object.values(job.permissions).includes('write')).map(([name]) => name);
  assert.deepEqual(writers, ['publish', 'continue'], 'only publish (contents) and continue (actions) can write');
});

test('CI gives PR feedback for every relevant event, drafts included, and publishes nothing', () => {
  const trigger = ci.on;
  assert.deepEqual(Object.keys(trigger), ['pull_request']);
  assert.deepEqual(trigger.pull_request.branches, ['main']);
  for (const type of ['opened', 'synchronize', 'reopened', 'ready_for_review', 'edited']) {
    assert.ok(trigger.pull_request.types.includes(type), `CI reacts to ${type}`);
  }
  assert.equal(ci.jobs.validate.if, undefined, 'drafts still get feedback');
  const [checkout] = checkouts(ci.jobs.validate);
  assert.equal(checkout.with.ref, '${{ github.event.pull_request.head.sha }}');
  assert.equal(checkout.with['persist-credentials'], false);
  assert.deepEqual(runs(ci.jobs.validate), ['npm ci', 'npm run typecheck', 'npm test']);
  assert.equal(ci.concurrency['cancel-in-progress'], true);
  assert.doesNotMatch(ciText, /scripts\/release|git push|gh workflow|secrets\./);
});

test('Release wakes on push to main, finished CI, dispatch and an hourly schedule, nothing else', () => {
  const trigger = release.on;
  assert.deepEqual(Object.keys(trigger).sort(), ['push', 'schedule', 'workflow_dispatch', 'workflow_run']);
  assert.deepEqual(trigger.push.branches, ['main']);
  assert.deepEqual(trigger.workflow_run.workflows, ['CI']);
  assert.deepEqual(trigger.workflow_run.types, ['completed']);
  assert.equal(trigger.workflow_dispatch, null);
  assert.equal(trigger.schedule.length, 1);
  assert.match(trigger.schedule[0].cron, /^\d{1,2} \* \* \* \*$/, 'hourly');
  assert.deepEqual(release.concurrency, { group: 'mdd-release', 'cancel-in-progress': false });
  // The event is only a wake-up: no job or step reads the event payload.
  assert.doesNotMatch(releaseText, /github\.event\b/);
  assert.doesNotMatch(releaseText, /workflow_run\./);
});

test('job graph, identities and the trusted branch and repository guard', () => {
  const { jobs } = release;
  assert.deepEqual(Object.keys(jobs), ['prepare', 'validate', 'publish', 'smoke', 'continue']);
  assert.equal(compact(jobs.prepare.if), REPOSITORY_GUARD);
  assert.equal(jobs.prepare.needs, undefined);
  assert.deepEqual(jobs.validate.needs, ['prepare']);
  assert.deepEqual(jobs.publish.needs, ['prepare', 'validate']);
  assert.deepEqual(jobs.smoke.needs, ['prepare', 'publish']);
  assert.deepEqual(jobs.continue.needs, ['prepare', 'publish']);
  // The authorization name is exactly `validate <40-hex sha>` per leg, and each leg is isolated.
  assert.equal(jobs.validate.name, 'validate ${{ matrix.source }}');
  assert.equal(jobs.validate.strategy['fail-fast'], false);
  assert.equal(jobs.validate.strategy.matrix, '${{ fromJSON(needs.prepare.outputs.matrix) }}');
  assert.equal(jobs.smoke.strategy['fail-fast'], false);
  assert.equal(jobs.smoke.strategy.matrix, '${{ fromJSON(needs.publish.outputs.smoke_matrix) }}');
  assert.equal(jobs.smoke.name, 'smoke ${{ matrix.tag }}');
  // Other jobs must not collide with the `validate <sha>` prefix.
  for (const name of ['prepare', 'publish', 'smoke', 'continue']) assert.ok(!String(jobs[name].name).startsWith('validate'), name);
});

test('every documented script output is exposed and wired to the right consumer', () => {
  const { jobs } = release;
  const prepareOutputs = ['has_work', 'matrix', 'stable_count', 'preview_count', 'stable_remaining', 'preview_remaining'];
  const publishOutputs = ['published', 'published_count', 'smoke_matrix', 'backlog', 'progress', 'blocked', 'continue', 'exit_code'];
  assert.deepEqual(Object.keys(jobs.prepare.outputs), prepareOutputs);
  assert.deepEqual(Object.keys(jobs.publish.outputs), publishOutputs);
  for (const name of prepareOutputs) assert.equal(jobs.prepare.outputs[name], `\${{ steps.plan.outputs.${name} }}`);
  for (const name of publishOutputs) assert.equal(jobs.publish.outputs[name], `\${{ steps.publish.outputs.${name} }}`);
  assert.ok(jobs.prepare.steps.some(step => step.id === 'plan' && step.run === 'node scripts/release-auto.mjs plan'));
  assert.ok(jobs.publish.steps.some(step => step.id === 'publish' && step.run === 'node scripts/release-auto.mjs publish'));
  for (const job of [jobs.prepare, jobs.publish]) {
    const step = job.steps.find(item => item.id);
    assert.equal(step.env.GITHUB_TOKEN, '${{ github.token }}', 'the token is read from the environment only');
    assert.doesNotMatch(step.run, /--token|secrets\./);
  }
});

test('plan and publish derive the preview window from the runner-provided run id, never from outputs or the event', () => {
  const { jobs } = release;
  for (const [name, id] of [['prepare', 'plan'], ['publish', 'publish']]) {
    const step = jobs[name].steps.find(item => item.id === id);
    // GITHUB_RUN_ID / GITHUB_RUN_ATTEMPT / GITHUB_ACTIONS come from the runner: the step must neither override nor forge them,
    // and the script reads run_number from the API for that id (no `needs.*.outputs`, no `github.run_number` text bridge).
    assert.deepEqual(Object.keys(step.env), ['GITHUB_TOKEN'], name);
    assert.doesNotMatch(step.run, /--run-id|--attempt|run_number|needs\./, name);
  }
  assert.doesNotMatch(releaseText, /run_number|RUN_ID:|RUN_ATTEMPT:|RUN_NUMBER/, 'no workflow expression can feed the rotation');
  // Read access to Actions is the only extra the planner gets; it cannot write or dispatch anything.
  const readers = Object.entries(jobs).filter(([, job]) => job.permissions.actions === 'read').map(([name]) => name);
  assert.deepEqual(readers, ['prepare', 'publish']);
  assert.ok(!Object.values(jobs.prepare.permissions).includes('write'));
});

test('conditional status paths: empty matrices skip, publish runs after any validate result, smoke follows publication', () => {
  const { jobs } = release;
  // validate: only with work from a successful prepare, so an empty matrix is never evaluated.
  const validate = (prepareOk, hasWork) => evaluate(jobs.validate.if, { "needs.prepare.result == 'success'": prepareOk, "needs.prepare.outputs.has_work == 'true'": hasWork });
  assert.equal(validate(true, true), true);
  assert.equal(validate(true, false), false);
  assert.equal(validate(false, true), false);
  // publish: `!cancelled()` plus prepare success, regardless of the validate matrix (success, failure or skipped).
  assert.equal(compact(jobs.publish.if), "${{ !cancelled() && needs.prepare.result == 'success' }}");
  assert.doesNotMatch(String(jobs.publish.if), /needs\.validate/);
  const publish = (cancelled, prepareOk) => evaluate(jobs.publish.if, { 'cancelled()': cancelled, "needs.prepare.result == 'success'": prepareOk });
  assert.equal(publish(false, true), true);
  assert.equal(publish(true, true), false);
  assert.equal(publish(false, false), false);
  // smoke: runs even when publish exits 1, as long as tags were already published; empty or missing counts skip.
  assert.doesNotMatch(String(jobs.smoke.if), /needs\.publish\.result/);
  const smoke = (cancelled, count) => evaluate(jobs.smoke.if, {
    'cancelled()': cancelled,
    "needs.publish.outputs.published_count != ''": count !== '',
    "needs.publish.outputs.published_count != '0'": count !== '0',
  });
  assert.equal(smoke(false, '2'), true);
  assert.equal(smoke(false, '0'), false);
  assert.equal(smoke(false, ''), false);
  assert.equal(smoke(true, '2'), false);
  // continue: only a fully successful publish with progress, backlog and no block.
  const atoms = ({ cancelled = false, ok = true, progress = true, backlog = '3', blocked = 'false', again = true } = {}) => ({
    'cancelled()': cancelled,
    "needs.publish.result == 'success'": ok,
    "needs.publish.outputs.progress == 'true'": progress,
    "needs.publish.outputs.backlog != ''": backlog !== '',
    "needs.publish.outputs.backlog != '0'": backlog !== '0',
    "needs.publish.outputs.blocked != 'true'": blocked !== 'true',
    "needs.publish.outputs.continue == 'true'": again,
  });
  assert.equal(evaluate(jobs.continue.if, atoms()), true);
  for (const change of [{ cancelled: true }, { ok: false }, { progress: false }, { backlog: '0' }, { backlog: '' }, { blocked: 'true' }, { again: false }]) {
    assert.equal(evaluate(jobs.continue.if, atoms(change)), false, JSON.stringify(change));
  }
  // A partially failed publish keeps its tags: they are job outputs of the failing step, read by smoke through `needs`.
  assert.equal(jobs.publish.outputs.published, '${{ steps.publish.outputs.published }}');
  assert.equal(jobs.publish.outputs.smoke_matrix, '${{ steps.publish.outputs.smoke_matrix }}');
  assert.ok(jobs.publish.steps.find(step => step.id === 'publish').if === undefined, 'the publish step itself is never made conditional');
});

test('trusted scripts come from one immutable default-branch revision, never from PR source', () => {
  const { jobs } = release;
  for (const name of ['prepare', 'publish', 'smoke']) {
    const [checkout, ...others] = checkouts(jobs[name]);
    assert.equal(others.length, 0, `${name} checks out once`);
    assert.equal(checkout.with.ref, TRUSTED_REF, `${name} uses the single trusted revision`);
    assert.equal(checkout.with['fetch-depth'], 0, `${name} keeps full history`);
    assert.equal(checkout.with['fetch-tags'], true, `${name} keeps tags`);
  }
  assert.doesNotMatch(releaseText, /ref:\s*(main|refs\/heads\/main|\$\{\{ github\.(ref|sha|head_ref|base_ref))/);
  assert.doesNotMatch(releaseText, /pull_request|head_ref|\.head\.sha/);
  // The only candidate checkout is the read-only, credential-less validate leg of the exact matrix SHA.
  const [candidate] = checkouts(jobs.validate);
  assert.equal(candidate.with.ref, '${{ matrix.source }}');
  assert.equal(candidate.with['persist-credentials'], false);
  for (const name of ['prepare', 'smoke']) assert.equal(checkouts(jobs[name])[0].with['persist-credentials'], false, name);
  // Only publish keeps a credential, and only after checking out the trusted revision it then runs.
  assert.equal(checkouts(jobs.publish)[0].with['persist-credentials'], true);
  assert.equal(jobs.continue.steps.filter(step => step.uses).length, 0, 'continue checks out nothing');
});

test('publish is data-only: no npm, no candidate code, no artifacts, no secrets beyond the job token', () => {
  const publish = release.jobs.publish;
  assert.deepEqual(runs(publish), ['node scripts/release-auto.mjs publish']);
  const serialized = JSON.stringify(publish).replaceAll('package-manager-cache', '');
  assert.doesNotMatch(serialized, /npm|npx|yarn|pnpm|artifact|cache|\$\{\{ matrix|secrets\./);
  assert.deepEqual(uses(publish).map(step => step.uses.split('@')[0]), ['actions/checkout', 'actions/setup-node']);
  assert.equal(publish.steps.find(step => step.uses.startsWith('actions/setup-node')).with['package-manager-cache'], false);
  // Same for prepare and continue: no install step can run package scripts with a token.
  for (const name of ['prepare', 'continue']) assert.doesNotMatch(runs(release.jobs[name]).join('\n'), /\bnpm\b|\bnpx\b/);
});

test('candidate code only runs in read-only jobs without persisted credentials or secrets', () => {
  const { jobs } = release;
  for (const name of ['validate', 'smoke']) {
    assert.deepEqual(jobs[name].permissions, { contents: 'read' });
    assert.ok(runs(jobs[name]).some(run => /\bnpm (ci|test)\b/.test(run)), `${name} installs and builds`);
    assert.doesNotMatch(JSON.stringify(jobs[name]), /secrets\.|github\.token|GITHUB_TOKEN|GH_TOKEN/);
  }
  assert.deepEqual(runs(jobs.validate), ['npm ci', 'npm run typecheck', 'npm test', 'npm pack --dry-run --ignore-scripts']);
});

test('smoke checks the published tag through a fresh remote snapshot and a fresh owned root', () => {
  const smoke = release.jobs.smoke;
  const step = smoke.steps.find(item => typeof item.run === 'string' && item.run.includes('release-smoke.mjs'));
  assert.deepEqual(step.env, { TAG: '${{ matrix.tag }}' });
  assert.doesNotMatch(step.run, /\$\{\{/, 'the tag reaches the shell only through the environment');
  assert.match(step.run, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\(-preview\\\.\[0-9\]\+\)\?\$/, 'the tag is re-validated before use');
  assert.match(step.run, /git clone --bare --quiet "https:\/\/github\.com\/\$GITHUB_REPOSITORY\.git" "\$origin"/);
  assert.match(step.run, /fetch --quiet --no-recurse-submodules origin '\+refs\/tags\/\*:refs\/tags\/\*'/);
  assert.match(step.run, /origin="\$RUNNER_TEMP\//);
  assert.match(step.run, /owned="\$RUNNER_TEMP\//);
  assert.match(step.run, /node scripts\/release-smoke\.mjs --origin "\$origin" --tag "\$TAG" --owned-root "\$owned"$/m);
  const order = runs(smoke);
  assert.ok(order.indexOf('npm ci') < order.indexOf('npm run build'), 'dist is built before the smoke runs');
  assert.ok(order.findIndex(run => run.includes('release-smoke.mjs')) > order.indexOf('npm run build'));
  assert.doesNotMatch(releaseText, /npm (install|i)\b|npm update|npm link|\bmdd update\b|scripts\/setup\.mjs/);
});

test('continue only redispatches Release on main and never writes contents', () => {
  const step = release.jobs.continue.steps;
  assert.equal(step.length, 1);
  assert.equal(step[0].run, 'gh workflow run release.yml --ref main');
  assert.deepEqual(step[0].env, { GH_TOKEN: '${{ github.token }}', GH_REPO: '${{ github.repository }}' });
  assert.doesNotMatch(String(release.jobs.continue.if), /schedule|workflow_run|github\.event/);
});

test('trust boundary: no pull_request_target, cache, artifacts, secrets, self-hosted runners or branch writes', () => {
  for (const [text, workflow] of [[ciText, ci], [releaseText, release]]) {
    assert.doesNotMatch(text, /pull_request_target/);
    assert.doesNotMatch(text, /actions\/cache|actions\/(upload|download)-artifact|(^|\s)cache:|cache-dependency-path|restore-keys/m);
    assert.doesNotMatch(text, /secrets\./);
    assert.doesNotMatch(text, /self-hosted/);
    assert.doesNotMatch(text, /git push|--force|--tags\b|git tag |gh release|gh pr|gh api/);
    for (const step of allSteps(workflow).filter(item => item.uses?.startsWith('actions/setup-node@'))) {
      assert.equal(step.with['package-manager-cache'], false, 'no automatic package manager cache');
      assert.equal(step.with['node-version'], 24);
      assert.equal(step.with.cache, undefined);
    }
  }
  // Expressions never reach shell code: `run` blocks only read the environment.
  for (const workflow of [ci, release]) {
    for (const step of allSteps(workflow).filter(item => typeof item.run === 'string')) assert.doesNotMatch(step.run, /\$\{\{/, step.run);
  }
  // Only the trusted Release scripts perform Git writes, and only through the engine.
  assert.equal(Object.values(release.jobs).flatMap(runs).filter(run => /release-auto\.mjs/.test(run)).length, 2);
});

test('every action is pinned to a full verified upstream commit SHA', () => {
  const seen = new Set();
  const usesLines = `${ciText}\n${releaseText}`.split('\n').filter(line => /^\s*(- )?uses:/.test(line));
  const parsed = [...allSteps(ci), ...allSteps(release)].filter(item => item.uses);
  assert.equal(usesLines.length, parsed.length, 'every uses line belongs to a parsed step');
  for (const line of usesLines) {
    const match = /uses: ([\w.-]+\/[\w.-]+)@([0-9a-f]{40}) # (v\d+\.\d+\.\d+)$/.exec(line.trimEnd());
    assert.ok(match, `${line.trim()} is pinned by a 40-hex SHA with a version comment`);
    const [, action, sha, tag] = match;
    assert.ok(PINS[action], `${action} is a known action`);
    assert.equal(sha, PINS[action].sha);
    assert.equal(tag, PINS[action].tag);
    seen.add(action);
  }
  assert.deepEqual([...seen].sort(), Object.keys(PINS));
});
