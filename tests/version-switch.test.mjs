import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { installationPaths } from '../dist/installation-paths.js';
import { readCurrent } from '../dist/version-manager.js';
import { discover, npmCli, prepareRelease, showAt, sourcePaths } from '../dist/version-source.js';
import { acquireLock, createBackup, listBackups, readJournal, readState, versionPaths, writeState } from '../dist/version-store.js';
import {
  RESTART_COMMAND, SwitchError, adoptInstallation, formatSwitchResult, installedPackageDigest, recover, runProbe, switchTo,
} from '../dist/version-switch.js';
import { BASELINE } from '../dist/versions.js';
import { REPO_ROOT, makeOrigin, ownedFixture, stateFor, tempDir } from './version-fixtures.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');
const hex = bytes => sha(bytes);

// ---------------------------------------------------------------- fixture packages (built once)

const read = (...parts) => readFileSync(join(REPO_ROOT, ...parts), 'utf8');

function walkText(dir, prefix = '') {
  const out = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, walkText(join(dir, entry.name), rel));
    else out[rel] = readFileSync(join(dir, entry.name), 'utf8');
  }
  return out;
}

function patched(text, from, to) {
  assert.ok(text.includes(from), `fixture patch target not found: ${from}`);
  return text.replace(from, to);
}

/** The repository's compiled probe-contract modules and real assets, as plain files (the shared fixture's own copy is overwritten). */
function realFiles(version, { dropCleanup = false, extraSkill = false, acceptX = false, manager = 0, agent = true } = {}) {
  const files = { '.gitignore': '/dist\n/node_modules\n' };
  for (const name of ['project-assets', 'settings', 'setup', 'safe-paths', 'local-files', 'validation']) files[`vendor/dist/${name}.js`] = read('dist', `${name}.js`);
  for (const [rel, text] of Object.entries(walkText(join(REPO_ROOT, 'assets', 'opencode')))) files[`assets/opencode/${rel}`] = text;
  if (agent) files['assets/opencode/agents/mdd-apply.md'] = `# apply ${version}\n`;
  let list = files['vendor/dist/project-assets.js'];
  if (dropCleanup) list = patched(list, "'assets/opencode/skills/mdd-cleanup/SKILL.md', ", '');
  if (extraSkill) {
    list = patched(list, "'assets/opencode/skills/mdd-grill/NOTICE',", "'assets/opencode/skills/mdd-grill/NOTICE', 'assets/opencode/skills/mdd-extra/SKILL.md',");
    files['assets/opencode/skills/mdd-extra/SKILL.md'] = `# extra ${version}\n`;
  }
  files['vendor/dist/project-assets.js'] = list;
  if (acceptX) files['vendor/dist/settings.js'] = patched(files['vendor/dist/settings.js'], "'verify']", "'verify', 'x']");
  if (manager) {
    files['vendor/dist/version-manager.js'] = `export const MANAGER_REVISION = ${manager};\n`;
    files['vendor/dist/version-cli.js'] = 'export async function main() { return 0; }\n';
  }
  return files;
}

const SPECS = {
  v020: { version: '0.2.0', files: realFiles('0.2.0') },
  v030: { version: '0.3.0', files: realFiles('0.3.0', { dropCleanup: true }) },
  v040: { version: '0.4.0-preview.1', files: realFiles('0.4.0-preview.1', { dropCleanup: true, extraSkill: true, acceptX: true, manager: 2 }) },
};

const cleanups = [];
const world = {};

function npmRun(args, cwd) {
  return execFileSync(process.execPath, [npmCli(), ...args], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, npm_config_offline: 'true' } });
}

before(() => {
  const t0 = { after: work => cleanups.push(work) };
  const origin = makeOrigin(t0, Object.values(SPECS).map(spec => ({ version: spec.version, marker: spec.version, files: spec.files })));
  const builder = ownedFixture(t0);
  assert.equal(discover(builder.paths, stateFor(origin.url, {})).stale, false);
  const base = tempDir(t0, 'mdd-tpl-');
  world.builder = builder;
  world.versions = {};
  for (const [key, spec] of Object.entries(SPECS)) {
    // The baseline constant pins the real 34a93f6, so fixture tags are described by hand.
    const tag = { tag: `v${spec.version}`, version: spec.version, commit: origin.commits[spec.version], status: 'eligible' };
    const prepared = prepareRelease(builder.lock, tag);
    // A pre-installed stage per version so most tests skip npm; one test runs the real default install.
    const tpl = join(base, key);
    mkdirSync(join(tpl, 'packages'), { recursive: true });
    const name = `my-driven-development-${prepared.sha256}.tgz`;
    cpSync(prepared.tarball, join(tpl, 'packages', name));
    writeFileSync(join(tpl, 'package.json'), '{"private":true}\n');
    npmRun(['install', join(tpl, 'packages', name), '--prefix', tpl, '--save-dev', '--ignore-scripts', '--no-audit', '--no-fund', '--workspaces=false'], tpl);
    world.versions[key] = {
      key, version: spec.version, commit: origin.commits[spec.version], prepared, tpl, name,
      identity: { kind: 'release', version: spec.version, commit: origin.commits[spec.version] },
    };
  }
});
after(() => { for (const work of cleanups.reverse()) { try { work(); } catch { /* best effort */ } } });

const V = key => world.versions[key];
const sourceOf = () => sourcePaths(world.builder.ownedRoot);

function targetFor(v, extra = {}) {
  return {
    identity: v.identity, channel: v.version.includes('preview') ? 'preview' : 'stable', selectedAs: v.version,
    prepare: () => v.prepared,
    packagedSource: path => showAt(sourceOf(), v.commit, path),
    ...extra,
  };
}

/** Fast stage: copies the pre-installed package of the tarball being staged. */
function templateStage(stageDir, tarball) {
  const v = Object.values(world.versions).find(item => basename(tarball) === item.name);
  assert.ok(v, 'known fixture tarball');
  cpSync(join(v.tpl, 'node_modules'), join(stageDir, 'node_modules'), { recursive: true });
  cpSync(join(v.tpl, 'package.json'), join(stageDir, 'package.json'));
  cpSync(join(v.tpl, 'package-lock.json'), join(stageDir, 'package-lock.json'));
}

function newInstall(t) {
  const home = tempDir(t, 'mdd-switch-');
  const paths = installationPaths({ home, env: { XDG_CONFIG_HOME: home } });
  mkdirSync(paths.ownedRoot, { recursive: true });
  const vp = versionPaths(paths.ownedRoot);
  const lock = acquireLock(vp, 'test');
  t.after(() => { try { lock.release(); } catch { /* already released */ } });
  return { home, paths, vp, lock, root: paths.configRoot };
}

const deps = (extra = {}) => ({ installStage: templateStage, ...extra });
const doSwitch = (ctx, key, extra = {}, targetExtra = {}) => switchTo(ctx.lock, ctx.paths, targetFor(V(key), targetExtra), deps(extra));

/** An unmanaged installation, as the historical setup left it: package prefix, assets, ledger. No state.json. */
function seedLegacy(ctx, key = 'v020', { edit = {}, config } = {}) {
  const v = V(key);
  const owned = ctx.paths.ownedRoot;
  cpSync(join(v.tpl, 'node_modules'), join(owned, 'node_modules'), { recursive: true });
  cpSync(join(v.tpl, 'package.json'), join(owned, 'package.json'));
  cpSync(join(v.tpl, 'package-lock.json'), join(owned, 'package-lock.json'));
  mkdirSync(join(owned, 'packages'), { recursive: true });
  cpSync(join(v.tpl, 'packages', v.name), join(owned, 'packages', v.name));
  const ledger = {};
  for (const file of runProbe(ctx.paths.installedPackageRoot, 'assets').files) {
    const target = join(ctx.root, ...file.path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, edit[file.path] ?? file.content);
    ledger[file.path] = sha(file.content);
  }
  writeFileSync(join(owned, 'setup-assets.json'), `${JSON.stringify(ledger)}\n`);
  if (config !== undefined) writeFileSync(join(owned, 'mdd.config.json'), config);
  return ledger;
}

const BASE_CONFIG = `${JSON.stringify({ version: 1, activeProfile: 'default', profiles: { default: { models: {}, answers: {} } } }, null, 2)}\n`;
const X_CONFIG = `${JSON.stringify({ version: 1, activeProfile: 'default', profiles: { default: { models: {}, answers: {} } }, x: 1 }, null, 2)}\n`;

function walkFiles(dir, prefix = '') {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, walkFiles(join(dir, entry.name), rel));
    else out[rel] = entry.isFile() ? sha(readFileSync(join(dir, entry.name))) : 'link';
  }
  return out;
}

/** Everything a switch may touch: managed assets, unrelated files next to them, config, ledger, package, active identity. */
function snap(ctx) {
  const out = {};
  for (const dir of ['agents', 'skills', 'plugins']) for (const [rel, digest] of Object.entries(walkFiles(join(ctx.root, dir)))) out[`${dir}/${rel}`] = digest;
  for (const name of ['mdd.config.json', 'setup-assets.json', 'package.json', 'package-lock.json', '.gitignore']) {
    const path = join(ctx.paths.ownedRoot, name);
    out[`mdd/${name}`] = !existsSync(path) ? 'absent' : statSync(path).isDirectory() ? 'dir' : sha(readFileSync(path));
  }
  out.package = installedPackageDigest(ctx.paths) ?? 'absent';
  const active = readState(ctx.vp).active;
  out.active = JSON.stringify(active && [active.kind, active.version, active.commit, active.provenance]);
  return out;
}

function assertInstalled(ctx, key) {
  const v = V(key);
  const pkg = JSON.parse(readFileSync(join(ctx.paths.installedPackageRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.version, v.version);
  const files = runProbe(ctx.paths.installedPackageRoot, 'assets').files;
  const ledger = JSON.parse(readFileSync(join(ctx.paths.ownedRoot, 'setup-assets.json'), 'utf8'));
  assert.deepEqual(Object.keys(ledger).sort(), files.map(file => file.path).sort());
  for (const file of files) {
    assert.equal(readFileSync(join(ctx.root, ...file.path.split('/')), 'utf8'), file.content, file.path);
    assert.equal(ledger[file.path], sha(file.content), `ledger ${file.path}`);
  }
  const active = readState(ctx.vp).active;
  assert.equal(active.version, v.version);
  assert.equal(active.commit, v.commit);
  assert.equal(active.packageDigest, installedPackageDigest(ctx.paths));
  assert.equal(readJournal(ctx.vp), undefined);
  assert.ok(!existsSync(ctx.vp.txRoot) || readdirSync(ctx.vp.txRoot).length === 0, 'transaction directory cleaned');
}

const throwsSwitch = async (work, code) => {
  await assert.rejects(Promise.resolve().then(work), error => error instanceof SwitchError && error.code === code, `expected SwitchError ${code}`);
};

// ---------------------------------------------------------------- switching

test('S1/S2/S3/S35: switch backs up before the first change, replaces edited and removed files, keeps unrelated ones, prints the restart line', async t => {
  const ctx = newInstall(t);
  const outcome0 = await doSwitch(ctx, 'v020');
  assert.equal(outcome0.status, 'switched');
  assertInstalled(ctx, 'v020');

  // Hand edits: one replaced agent, one removed skill file, one unrelated file.
  const edited = join(ctx.root, 'agents', 'mdd-apply.md');
  const removedSkill = join(ctx.root, 'skills', 'mdd-cleanup', 'SKILL.md');
  writeFileSync(edited, 'hand edited agent\n');
  writeFileSync(removedSkill, 'hand edited skill\n');
  writeFileSync(join(ctx.root, 'agents', 'custom.md'), 'mine\n');
  writeFileSync(join(ctx.paths.ownedRoot, 'mdd.config.json'), BASE_CONFIG);
  const before = snap(ctx);

  const seen = {};
  const outcome = await doSwitch(ctx, 'v030', {
    fault: point => {
      if (point !== 'journal:activating') return;
      // First active mutation: the backup must already be complete and the installation untouched.
      seen.untouched = JSON.stringify(snap(ctx)) === JSON.stringify(before);
      const sets = listBackups(ctx.vp).valid;
      seen.backup = sets[0];
      seen.configBytes = sets[0] && readFileSync(join(sets[0].dir, 'mdd.config.json'), 'utf8');
      seen.editedBytes = sets[0] && readFileSync(join(sets[0].dir, 'assets', 'agents', 'mdd-apply.md'), 'utf8');
      seen.journal = readJournal(ctx.vp)?.phase;
    },
  });
  assert.equal(outcome.status, 'switched');
  assert.ok(seen.untouched, 'installation untouched when the first mutation starts');
  assert.equal(seen.journal, 'activating');
  assert.equal(seen.configBytes, BASE_CONFIG);
  assert.equal(seen.editedBytes, 'hand edited agent\n');
  assertInstalled(ctx, 'v030');
  assert.equal(readFileSync(join(ctx.root, 'agents', 'custom.md'), 'utf8'), 'mine\n');
  assert.ok(!existsSync(join(ctx.root, 'skills', 'mdd-cleanup')), 'removed skill and its empty directory are gone');
  assert.equal(readFileSync(join(ctx.paths.ownedRoot, 'mdd.config.json'), 'utf8'), BASE_CONFIG, 'compatible config untouched');

  const result = outcome.result;
  const manifest = JSON.parse(readFileSync(join(result.backup, 'backup.json'), 'utf8'));
  assert.equal(manifest.complete, true);
  const editedFlags = Object.fromEntries(manifest.assets.map(asset => [asset.path, [asset.edited, asset.action]]));
  assert.deepEqual(editedFlags['agents/mdd-apply.md'], [true, 'replace']);
  assert.deepEqual(editedFlags['skills/mdd-cleanup/SKILL.md'], [true, 'remove']);
  assert.deepEqual(result.edited.map(item => item.path).sort(), ['agents/mdd-apply.md', 'skills/mdd-cleanup/SKILL.md']);
  for (const item of result.edited) assert.ok(existsSync(item.backup), item.backup);
  const text = formatSwitchResult(result).join('\n');
  assert.match(text, /Listo: 0\.3\.0 activa/);
  assert.ok(text.includes(result.backup));
  assert.ok(text.includes(RESTART_COMMAND));
  assert.equal(RESTART_COMMAND, 'opencode service restart');
  assert.ok(existsSync(join(ctx.paths.ownedRoot, 'bin')), 'launcher routing re-asserted');
});

test('S32: an already installed exact version changes nothing; an adopted 0.2.0 is reinstalled with backups', async t => {
  const ctx = newInstall(t);
  await doSwitch(ctx, 'v030');
  const before = snap(ctx);
  const backups = listBackups(ctx.vp).valid.length;
  let prepared = false;
  const again = await switchTo(ctx.lock, ctx.paths, targetFor(V('v030'), { prepare: () => { prepared = true; return V('v030').prepared; } }), deps());
  assert.equal(again.status, 'already');
  assert.equal(prepared, false, 'nothing is built or staged for an active version');
  assert.deepEqual(snap(ctx), before);
  assert.equal(listBackups(ctx.vp).valid.length, backups);

  const adopted = newInstall(t);
  seedLegacy(adopted);
  const adoption = adoptInstallation(adopted.lock, adopted.paths, { readBaselineFile: path => showAt(sourceOf(), V('v020').commit, path) });
  assert.equal(adoption.status, 'adopted');
  const outcome = await doSwitch(adopted, 'v020');
  assert.equal(outcome.status, 'switched', 'adopted provenance is not "installed": explicit reinstall');
  assert.equal(readState(adopted.vp).active.provenance, 'installed');
  assert.equal(outcome.result.backupName.length > 0, true);
});

test('S1: the default npm stage install (no seam) produces the 0.2.0 layout and a coherent activation', async t => {
  const ctx = newInstall(t);
  const outcome = await switchTo(ctx.lock, ctx.paths, targetFor(V('v030')), { });
  assert.equal(outcome.status, 'switched');
  assertInstalled(ctx, 'v030');
  const pkg = JSON.parse(readFileSync(join(ctx.paths.ownedRoot, 'package.json'), 'utf8'));
  assert.match(pkg.devDependencies['my-driven-development'], /^file:packages\/my-driven-development-[0-9a-f]{64}\.tgz$/);
  assert.ok(existsSync(join(ctx.paths.packagesRoot, basename(pkg.devDependencies['my-driven-development']))));
});

test('S4/S22/S33: incompatible config restores the newest valid exact-source backup, or the switch is refused unchanged', async t => {
  const ctx = newInstall(t);
  await doSwitch(ctx, 'v020');
  writeFileSync(join(ctx.paths.ownedRoot, 'mdd.config.json'), BASE_CONFIG);
  const v040 = await doSwitch(ctx, 'v040');
  assert.equal(v040.status, 'switched');
  assert.equal(v040.result.config.decision, 'keep');
  // The 0.4.0-preview.1 settings accept `x`; 0.2.0 does not.
  writeFileSync(join(ctx.paths.ownedRoot, 'mdd.config.json'), X_CONFIG);
  const back = await doSwitch(ctx, 'v020');
  assert.equal(back.status, 'switched');
  assert.equal(back.result.config.decision, 'restore');
  assert.equal(readFileSync(join(ctx.paths.ownedRoot, 'mdd.config.json'), 'utf8'), BASE_CONFIG);
  assertInstalled(ctx, 'v020');
  const outgoing = readFileSync(join(back.result.backup, 'mdd.config.json'), 'utf8');
  assert.equal(outgoing, X_CONFIG, 'the outgoing config is backed up before the restore');
  assert.match(formatSwitchResult(back.result).join('\n'), /se restaur/);

  // No candidate: a backup made with another version does not qualify.
  const other = newInstall(t);
  await doSwitch(other, 'v040');
  writeFileSync(join(other.paths.ownedRoot, 'mdd.config.json'), X_CONFIG);
  createBackup(other.lock, { source: V('v030').identity, target: V('v040').identity, config: { bytes: Buffer.from(BASE_CONFIG), sha256: sha(BASE_CONFIG) }, assets: [] });
  const before = snap(other);
  await assert.rejects(doSwitch(other, 'v020'), error => error instanceof SwitchError && error.code === 'config' && /no hay un respaldo hecho con 0\.2\.0/.test(error.message));
  assert.deepEqual(snap(other), before);
  assert.equal(readJournal(other.vp), undefined);
});

test('S22: newest valid exact candidate wins; wrong-version, corrupt and incompatible sets are skipped', async t => {
  const ctx = newInstall(t);
  await doSwitch(ctx, 'v040');
  writeFileSync(join(ctx.paths.ownedRoot, 'mdd.config.json'), X_CONFIG);
  const exact = V('v020').identity;
  const configOf = name => `${JSON.stringify({ version: 1, activeProfile: name, profiles: { [name]: { models: {}, answers: {} } } })}\n`;
  const make = (source, name, now) => createBackup(ctx.lock, { source, target: V('v040').identity, config: { bytes: Buffer.from(configOf(name)), sha256: sha(configOf(name)) }, assets: [], now: () => new Date(now) });
  make(exact, 'older', '2026-11-01T00:00:00Z');
  const newest = make(exact, 'newest', '2026-11-02T00:00:00Z');
  const corrupt = make(exact, 'corrupt', '2026-11-03T00:00:00Z');
  make(V('v030').identity, 'wrong', '2026-11-04T00:00:00Z');
  writeFileSync(join(corrupt.dir, 'mdd.config.json'), 'tampered');
  const outcome = await doSwitch(ctx, 'v020');
  assert.equal(outcome.status, 'switched');
  assert.equal(readFileSync(join(ctx.paths.ownedRoot, 'mdd.config.json'), 'utf8'), configOf('newest'));
  assert.equal(outcome.result.config.detail.includes(newest.name), true);
});

test('S33: an absent config is recorded as absent; an absent candidate removes an incompatible config after backing it up', async t => {
  const ctx = newInstall(t);
  await doSwitch(ctx, 'v020');
  const first = await doSwitch(ctx, 'v040');
  const manifest = JSON.parse(readFileSync(join(first.result.backup, 'backup.json'), 'utf8'));
  assert.deepEqual(manifest.config, { present: false });
  assert.ok(!existsSync(join(first.result.backup, 'mdd.config.json')));
  assert.ok(!existsSync(join(ctx.paths.ownedRoot, 'mdd.config.json')), 'defaults stay implicit');

  writeFileSync(join(ctx.paths.ownedRoot, 'mdd.config.json'), X_CONFIG);
  const back = await doSwitch(ctx, 'v020');
  assert.equal(back.result.config.decision, 'remove');
  assert.ok(!existsSync(join(ctx.paths.ownedRoot, 'mdd.config.json')));
  assert.equal(readFileSync(join(back.result.backup, 'mdd.config.json'), 'utf8'), X_CONFIG);
});

test('S34: unrecorded collisions, links in managed paths and an unsafe ledger fail closed with nothing changed', async t => {
  const ctx = newInstall(t);
  await doSwitch(ctx, 'v020');
  // Collision: a file the target installs, not in the ledger, different bytes.
  mkdirSync(join(ctx.root, 'skills', 'mdd-extra'), { recursive: true });
  writeFileSync(join(ctx.root, 'skills', 'mdd-extra', 'SKILL.md'), 'user wrote this\n');
  let before = snap(ctx);
  await assert.rejects(doSwitch(ctx, 'v040'), error => error instanceof SwitchError && error.code === 'collision' && error.message.includes('skills/mdd-extra/SKILL.md'));
  assert.deepEqual(snap(ctx), before);
  assert.equal(readJournal(ctx.vp), undefined);
  rmSync(join(ctx.root, 'skills', 'mdd-extra'), { recursive: true });

  // Link in a managed path.
  const outside = tempDir(t, 'mdd-outside-');
  const dir = join(ctx.root, 'skills', 'mdd-cleanup');
  rmSync(dir, { recursive: true });
  let linked = true;
  try { symlinkSync(outside, dir, 'junction'); } catch { linked = false; }
  if (linked) {
    before = snap(ctx);
    await throwsSwitch(() => doSwitch(ctx, 'v030'), 'unsafe');
    assert.deepEqual(snap(ctx), before);
    rmSync(dir, { recursive: true, force: true });
  }

  // Ledger naming something MDD never installs.
  const ledgerPath = join(ctx.paths.ownedRoot, 'setup-assets.json');
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  ledger['agents/not-mdd.md'] = sha('x');
  mkdirSync(dirname(dir), { recursive: true });
  writeFileSync(ledgerPath, JSON.stringify(ledger));
  await throwsSwitch(() => doSwitch(ctx, 'v030'), 'unsafe');
});

test('S24: an unsafe config (directory, hardlink) or an unusable backup area refuses before any active change', async t => {
  const dirCase = newInstall(t);
  await doSwitch(dirCase, 'v020');
  mkdirSync(join(dirCase.paths.ownedRoot, 'mdd.config.json'));
  let before = snap(dirCase);
  await throwsSwitch(() => doSwitch(dirCase, 'v030'), 'backup');
  assert.equal(readJournal(dirCase.vp), undefined);

  const linkCase = newInstall(t);
  await doSwitch(linkCase, 'v020');
  writeFileSync(join(linkCase.paths.ownedRoot, 'mdd.config.json'), BASE_CONFIG);
  linkSync(join(linkCase.paths.ownedRoot, 'mdd.config.json'), join(linkCase.paths.ownedRoot, 'config.alias'));
  before = snap(linkCase);
  await throwsSwitch(() => doSwitch(linkCase, 'v030'), 'backup');
  assert.deepEqual(snap(linkCase), before);

  const area = newInstall(t);
  await doSwitch(area, 'v020');
  writeFileSync(join(area.paths.ownedRoot, 'mdd.config.json'), BASE_CONFIG);
  rmSync(area.vp.backupsRoot, { recursive: true, force: true });
  writeFileSync(area.vp.backupsRoot, 'not a directory');
  before = snap(area);
  await throwsSwitch(() => doSwitch(area, 'v030'), 'backup');
  assert.deepEqual(snap(area), before);
  assert.equal(readJournal(area.vp), undefined, 'a backup failure leaves no journal');
});

test('S37: a change during the review aborts before backup; an edit during the backup window aborts and the backup holds the real bytes', async t => {
  const review = newInstall(t);
  await doSwitch(review, 'v020');
  writeFileSync(join(review.paths.ownedRoot, 'mdd.config.json'), BASE_CONFIG);
  const backupsBefore = listBackups(review.vp).valid.length;
  await throwsSwitch(() => doSwitch(review, 'v030', { afterReview: () => writeFileSync(join(review.paths.ownedRoot, 'mdd.config.json'), `${BASE_CONFIG}\n`) }), 'changed');
  assert.equal(readFileSync(join(review.paths.ownedRoot, 'mdd.config.json'), 'utf8'), `${BASE_CONFIG}\n`, 'the owner edit is preserved');
  assert.equal(listBackups(review.vp).valid.length, backupsBefore, 'no backup made after a refused review');
  assert.equal(readJournal(review.vp), undefined);
  assert.equal(readState(review.vp).active.version, '0.2.0');

  const window = newInstall(t);
  await doSwitch(window, 'v020');
  writeFileSync(join(window.root, 'agents', 'mdd-apply.md'), 'edited before backup\n');
  const agent = join(window.root, 'agents', 'mdd-apply.md');
  await throwsSwitch(() => doSwitch(window, 'v030', { fault: point => { if (point === 'backup:written') writeFileSync(agent, 'edited during backup\n'); } }), 'changed');
  assert.equal(readFileSync(agent, 'utf8'), 'edited during backup\n', 'installation untouched');
  assert.equal(readState(window.vp).active.version, '0.2.0');
  const set = listBackups(window.vp).valid[0];
  assert.equal(readFileSync(join(set.dir, 'assets', 'agents', 'mdd-apply.md'), 'utf8'), 'edited before backup\n', 'the backup holds the bytes that were actually there');
  assert.equal(readJournal(window.vp), undefined);
});

test('S35: a cancelled switch changes nothing, leaves no journal or staging, and has no success text', async t => {
  const ctx = newInstall(t);
  await doSwitch(ctx, 'v020');
  const before = snap(ctx);
  const outcome = await doSwitch(ctx, 'v030', { confirm: plan => { assert.ok(plan.review.length > 0); return false; } });
  assert.deepEqual(outcome, { status: 'cancelled' });
  assert.deepEqual(snap(ctx), before);
  assert.equal(readJournal(ctx.vp), undefined);
  assert.ok(!existsSync(ctx.vp.txRoot) || readdirSync(ctx.vp.txRoot).length === 0);
});

test('S17/S38/S40: staging, identity and packaged-file failures name the problem and leave the installation unchanged', async t => {
  const ctx = newInstall(t);
  await doSwitch(ctx, 'v020');
  const before = snap(ctx);
  const check = async (work, pattern, code) => {
    await assert.rejects(work(), error => (code ? error instanceof SwitchError && error.code === code : true) && pattern.test(error.message));
    assert.deepEqual(snap(ctx), before);
    assert.equal(readJournal(ctx.vp), undefined);
    assert.ok(!existsSync(ctx.vp.txRoot) || readdirSync(ctx.vp.txRoot).length === 0, 'staging removed');
  };
  await check(() => doSwitch(ctx, 'v030', { installStage: () => { throw new SwitchError('stage', 'Fall\u00f3 la instalaci\u00f3n en la etapa de preparaci\u00f3n: sin red'); } }), /etapa de preparaci/, 'stage');
  // Tag/package mismatch: the identity says 0.3.9, the staged package says 0.3.0.
  const wrongIdentity = { ...V('v030'), identity: { ...V('v030').identity, version: '0.3.9' } };
  await check(() => switchTo(ctx.lock, ctx.paths, targetFor(wrongIdentity), deps()), /declara my-driven-development@0\.3\.0, no my-driven-development@0\.3\.9/, 'verify');
  // Packaged file differs from the tag's source.
  await check(() => doSwitch(ctx, 'v030', {}, { packagedSource: path => (path.endsWith('mdd-apply.md') ? Buffer.from('other') : showAt(sourceOf(), V('v030').commit, path)) }), /distintos de la fuente/, 'verify');
  await check(() => doSwitch(ctx, 'v030', {}, { packagedSource: () => undefined }), /distintos de la fuente/, 'verify');
  // A tarball that does not match its recorded digest is never installed (S40).
  const bad = { ...V('v030').prepared, sha256: 'f'.repeat(64) };
  await check(() => doSwitch(ctx, 'v030', {}, { prepare: () => bad }), /no coincide con su digest/, 'stage');
});

test('S19: a failure after the backup rolls back to the previous installation; the backup is complete and a retry succeeds', async t => {
  const ctx = newInstall(t);
  await doSwitch(ctx, 'v020');
  writeFileSync(join(ctx.paths.ownedRoot, 'mdd.config.json'), BASE_CONFIG);
  writeFileSync(join(ctx.root, 'agents', 'mdd-apply.md'), 'edited\n');
  const before = snap(ctx);
  for (const point of ['package-in', 'asset-remove', 'ledger']) {
    await assert.rejects(doSwitch(ctx, 'v030', { fault: p => { if (p === point) throw new Error(`injected ${point}`); } }),
      error => error instanceof SwitchError && error.code === 'activation' && error.message.includes(`injected ${point}`), point);
    assert.deepEqual(snap(ctx), before, `rolled back after ${point}`);
    assert.equal(readJournal(ctx.vp), undefined, `journal cleared after ${point}`);
  }
  const sets = listBackups(ctx.vp);
  assert.ok(sets.valid.length >= 1 && sets.invalid.length === 0, 'backups are complete');
  const retry = await doSwitch(ctx, 'v030');
  assert.equal(retry.status, 'switched');
  assertInstalled(ctx, 'v030');
});

// ---------------------------------------------------------------- crash injection (child processes)

const CHILD = `
import { cpSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const c = JSON.parse(process.env.MDD_CASE);
const load = name => import(pathToFileURL(join(c.dist, name)).href);
const { installationPaths } = await load('installation-paths.js');
const store = await load('version-store.js');
const sw = await load('version-switch.js');
const src = await load('version-source.js');
const paths = installationPaths({ home: c.home, env: { XDG_CONFIG_HOME: c.home } });
const lock = store.acquireLock(store.versionPaths(paths.ownedRoot), 'child');
const target = {
  identity: c.identity, channel: c.channel, selectedAs: c.identity.version,
  prepare: () => c.prepared, packagedSource: p => src.showAt(src.sourcePaths(c.builderOwned), c.identity.commit, p),
};
await sw.switchTo(lock, paths, target, {
  installStage: (stage) => {
    cpSync(join(c.tpl, 'node_modules'), join(stage, 'node_modules'), { recursive: true });
    cpSync(join(c.tpl, 'package.json'), join(stage, 'package.json'));
    cpSync(join(c.tpl, 'package-lock.json'), join(stage, 'package-lock.json'));
  },
  fault: point => {
    if (point !== c.at) return;
    if (c.hold) {
      // Hold the in-progress switch (and the lock) until the parent kills this process.
      writeFileSync(join(c.hold, 'held'), String(process.pid));
      for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    process.exit(7);
  },
});
process.exit(0);
`;

let childFile;
const caseFor = (ctx, key, at, extra = {}) => {
  const v = V(key);
  childFile ??= (() => { const dir = tempDir({ after: work => cleanups.push(work) }, 'mdd-child-'); const file = join(dir, 'child.mjs'); writeFileSync(file, CHILD); return file; })();
  return JSON.stringify({
    dist: join(REPO_ROOT, 'dist'), home: ctx.home, identity: v.identity, channel: v.version.includes('preview') ? 'preview' : 'stable',
    prepared: v.prepared, tpl: v.tpl, builderOwned: world.builder.ownedRoot, at, ...extra,
  });
};
function crash(ctx, key, at) {
  const spec = caseFor(ctx, key, at);
  ctx.lock.release(); // the child takes the lock itself
  const result = spawnSync(process.execPath, [childFile], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, MDD_CASE: spec },
  });
  assert.equal(result.status, 7, `child must crash at ${at}: ${result.stderr}`);
  return acquireLock(ctx.vp, 'recovery'); // the dead child's lock is taken over
}

const SCENARIOS = [
  { name: 'replace+remove', from: 'v020', to: 'v030', points: ['journal:backing-up', 'package-out', 'package-in', 'package-done', 'asset-replace', 'asset-remove', 'ledger', 'state'] },
  { name: 'create', from: 'v030', to: 'v040', points: ['asset-create'] },
];

for (const scenario of SCENARIOS) {
  test(`S20: a crash at each point of ${scenario.name} recovers to the previous installation and a later switch works`, async t => {
    for (const point of scenario.points) {
      const ctx = newInstall(t);
      await doSwitch(ctx, scenario.from);
      writeFileSync(join(ctx.root, 'agents', 'mdd-apply.md'), 'edited\n');
      writeFileSync(join(ctx.root, 'agents', 'custom.md'), 'mine\n');
      writeFileSync(join(ctx.paths.ownedRoot, 'mdd.config.json'), BASE_CONFIG);
      const before = snap(ctx);
      const lock = crash(ctx, scenario.to, point);
      assert.ok(readJournal(ctx.vp), `journal left by the crash at ${point}`);
      const result = recover(lock, ctx.paths, deps());
      assert.equal(result.status, 'rolled-back', `${point}: ${result.message}`);
      assert.deepEqual(snap(ctx), before, `coherent previous installation after a crash at ${point}`);
      assert.equal(readJournal(ctx.vp), undefined);
      if (point === scenario.points.at(-1)) {
        const next = await switchTo(lock, ctx.paths, targetFor(V(scenario.to)), deps());
        assert.equal(next.status, 'switched', point);
        assertInstalled({ ...ctx, lock }, scenario.to);
      }
      lock.release();
    }
  });
}

test('S20/R9: a crash after the commit point finishes forward; the switch is complete', async t => {
  const ctx = newInstall(t);
  await doSwitch(ctx, 'v020');
  const lock = crash(ctx, 'v030', 'committed');
  const result = recover(lock, ctx.paths, deps());
  assert.equal(result.status, 'finished', result.message);
  assertInstalled({ ...ctx, lock }, 'v030');
  lock.release();
});

test('S20: a crash after the config restore recovers the outgoing config and the previous installation', async t => {
  const ctx = newInstall(t);
  await doSwitch(ctx, 'v020');
  writeFileSync(join(ctx.paths.ownedRoot, 'mdd.config.json'), BASE_CONFIG);
  await doSwitch(ctx, 'v040');
  writeFileSync(join(ctx.paths.ownedRoot, 'mdd.config.json'), X_CONFIG);
  const before = snap(ctx);
  const lock = crash(ctx, 'v020', 'config');
  assert.equal(readFileSync(join(ctx.paths.ownedRoot, 'mdd.config.json'), 'utf8'), BASE_CONFIG, 'the child had already restored the config');
  const result = recover(lock, ctx.paths, deps());
  assert.equal(result.status, 'rolled-back', result.message);
  assert.deepEqual(snap(ctx), before);
  assert.equal(readFileSync(join(ctx.paths.ownedRoot, 'mdd.config.json'), 'utf8'), X_CONFIG);
  assert.equal(readJournal(ctx.vp), undefined);
  lock.release();
});

for (const point of ['post-commit:routing', 'post-commit:routed']) {
  test(`S20: a crash at the launcher boundary (${point}) after the commit finishes forward with the target intact`, async t => {
    const ctx = newInstall(t);
    await doSwitch(ctx, 'v020');
    const lock = crash(ctx, 'v030', point);
    assert.equal(readJournal(ctx.vp).phase, 'committed');
    const result = recover(lock, ctx.paths, deps());
    assert.equal(result.status, 'finished', result.message);
    assertInstalled({ ...ctx, lock }, 'v030');
    lock.release();
  });
}

// Faults at the committed boundary, after state.json names the target but before cleanup (probe P1 of the verification).
test('G1/R9: foreign bytes in the committed package block recovery, keep the journal and evidence, and report the target as active', async t => {
  const ctx = newInstall(t);
  await doSwitch(ctx, 'v020');
  let seen;
  const interrupt = deps({
    fault: point => {
      if (point !== 'committed') return;
      writeFileSync(join(ctx.paths.installedPackageRoot, 'dist', 'opencode-plugin.js'), 'foreign corrupt module\n');
      throw new Error('interrupted after state commit');
    },
  });
  await assert.rejects(switchTo(ctx.lock, ctx.paths, targetFor(V('v030')), interrupt), error => {
    seen = error;
    return error instanceof SwitchError && error.code === 'blocked';
  });
  assert.doesNotMatch(seen.message, /se restaur\u00f3 la instalaci\u00f3n anterior/);
  assert.match(seen.message, /registrada como activa/);
  assert.match(seen.message, /NO se restaur\u00f3/);
  assert.equal(readState(ctx.vp).active.version, '0.3.0');
  assert.equal(readJournal(ctx.vp).phase, 'blocked', 'journal kept as evidence');
  assert.ok(readdirSync(ctx.vp.txRoot).length > 0, 'recovery material kept');
  assert.equal(readFileSync(join(ctx.paths.installedPackageRoot, 'dist', 'opencode-plugin.js'), 'utf8'), 'foreign corrupt module\n', 'foreign bytes untouched');
  const again = recover(ctx.lock, ctx.paths, deps());
  assert.equal(again.status, 'blocked');
  assert.match(again.message, /bytes ajenos/);
  assert.equal(readJournal(ctx.vp).phase, 'blocked');
});

test('G1/R9: a retained config incompatible with the committed target blocks recovery and keeps the journal', async t => {
  const ctx = newInstall(t);
  await doSwitch(ctx, 'v020');
  const lock = ctx.lock;
  // A compatible config switches to 0.3.0; an edit at the boundary then makes it incompatible with 0.3.0.
  writeFileSync(join(ctx.paths.ownedRoot, 'mdd.config.json'), BASE_CONFIG);
  const interrupt = deps({
    fault: point => {
      if (point !== 'committed') return;
      writeFileSync(join(ctx.paths.ownedRoot, 'mdd.config.json'), X_CONFIG); // 0.3.0 rejects `x`
      throw new Error('interrupted after state commit');
    },
  });
  await assert.rejects(switchTo(lock, ctx.paths, targetFor(V('v030')), interrupt), error => error instanceof SwitchError && error.code === 'blocked' && !/se restaur\u00f3 la instalaci\u00f3n anterior/.test(error.message));
  assert.equal(readState(ctx.vp).active.version, '0.3.0');
  assert.equal(readJournal(ctx.vp).phase, 'blocked');
  assert.match(readJournal(ctx.vp).blocked.reason, /configuraci\u00f3n conservada/);
  assert.equal(readFileSync(join(ctx.paths.ownedRoot, 'mdd.config.json'), 'utf8'), X_CONFIG, 'the config is never rewritten silently');
});

test('G1/R9: an interruption at the committed boundary with intact bytes reports the target as active with a warning and finishes cleanly', async t => {
  const ctx = newInstall(t);
  await doSwitch(ctx, 'v020');
  const outcome = await switchTo(ctx.lock, ctx.paths, targetFor(V('v030')), deps({
    fault: point => { if (point === 'committed') throw new Error('interrupted after state commit'); },
  }));
  assert.equal(outcome.status, 'switched');
  assert.ok(outcome.result.warnings.some(warning => /sigue activa/.test(warning) && !/se restaur\u00f3 la instalaci\u00f3n anterior/.test(warning)));
  assertInstalled(ctx, 'v030');
});

test('S20: a crash with foreign changes in touched files blocks; a blocked journal refuses new switches and keeps the evidence', async t => {
  const ctx = newInstall(t);
  await doSwitch(ctx, 'v020');
  const lock = crash(ctx, 'v030', 'asset-replace');
  writeFileSync(join(ctx.root, 'agents', 'mdd-apply.md'), 'someone else wrote this\n');
  const result = recover(lock, ctx.paths, deps());
  assert.equal(result.status, 'blocked');
  assert.match(result.message, /Cambio de versi\u00f3n incompleto/);
  assert.equal(readJournal(ctx.vp).phase, 'blocked');
  assert.equal(readFileSync(join(ctx.root, 'agents', 'mdd-apply.md'), 'utf8'), 'someone else wrote this\n', 'foreign bytes are never overwritten');
  await throwsSwitch(() => switchTo(lock, ctx.paths, targetFor(V('v030')), deps()), 'blocked');
  assert.ok(readdirSync(ctx.vp.txRoot).length > 0, 'recovery material kept');
  lock.release();
});

const COMPETITOR = `
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const c = JSON.parse(process.env.MDD_CASE);
const load = name => import(pathToFileURL(join(c.dist, name)).href);
const { installationPaths } = await load('installation-paths.js');
const store = await load('version-store.js');
const paths = installationPaths({ home: c.home, env: { XDG_CONFIG_HOME: c.home } });
try {
  const lock = store.acquireLock(store.versionPaths(paths.ownedRoot), 'competitor-' + c.kind);
  // Reaching this line means the owner's lock was not honoured.
  lock.release();
  console.log('ACQUIRED');
  process.exit(0);
} catch (error) {
  console.log('REFUSED:' + error.code + ':' + error.message);
  process.exit(3);
}
`;

test('S21: a child holding an in-progress switch blocks a competing switch and prune with busy (no interleaving); killing the owner lets recovery restore everything', async t => {
  const ctx = newInstall(t);
  await doSwitch(ctx, 'v020');
  writeFileSync(join(ctx.root, 'agents', 'mdd-apply.md'), 'edited\n');
  writeFileSync(join(ctx.paths.ownedRoot, 'mdd.config.json'), BASE_CONFIG);
  const before = snap(ctx);
  const hold = tempDir(t, 'mdd-hold-');
  const spec = caseFor(ctx, 'v030', 'asset-replace', { hold });
  ctx.lock.release();
  const child = spawn(process.execPath, [childFile], { env: { ...process.env, MDD_CASE: spec }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
  const deadline = Date.now() + 60000;
  while (!existsSync(join(hold, 'held')) && Date.now() < deadline) {
    assert.equal(child.exitCode, null, `child ended early: ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(existsSync(join(hold, 'held')), 'the child reached the held point');
  assert.equal(readJournal(ctx.vp).phase, 'activating');
  const midway = snap(ctx);

  // In-process competitors: another switch and a prune both need the lock.
  for (const command of ['use', 'prune']) {
    assert.throws(() => acquireLock(ctx.vp, command), error => error.code === 'busy' && /Otra operaci\u00f3n de MDD est\u00e1 en curso/.test(error.message) && error.message.includes(`pid ${child.pid}`));
  }
  // A competing process (setup/update style) is refused the same way.
  const rival = spawnSync(process.execPath, ['--input-type=module', '-e', COMPETITOR], { encoding: 'utf8', windowsHide: true, env: { ...process.env, MDD_CASE: JSON.stringify({ dist: join(REPO_ROOT, 'dist'), home: ctx.home, kind: 'switch' }) } });
  assert.equal(rival.status, 3, `${rival.stdout}${rival.stderr}`);
  assert.match(rival.stdout, /REFUSED:busy:Otra operaci\u00f3n de MDD est\u00e1 en curso/);
  assert.deepEqual(snap(ctx), midway, 'nothing interleaved with the held switch');
  assert.equal(readJournal(ctx.vp).phase, 'activating');

  // Kill the owner; the next lock-taking command takes the stale lock and recovers.
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  const lock = acquireLock(ctx.vp, 'recovery');
  const result = recover(lock, ctx.paths, deps());
  assert.equal(result.status, 'rolled-back', result.message);
  assert.deepEqual(snap(ctx), before);
  assert.equal(readJournal(ctx.vp), undefined);
  const next = await switchTo(lock, ctx.paths, targetFor(V('v030')), deps());
  assert.equal(next.status, 'switched');
  lock.release();
});

test('R9: when rollback material is gone but the target is complete, recovery rolls forward and commits', async t => {
  const ctx = newInstall(t);
  await doSwitch(ctx, 'v020');
  writeFileSync(join(ctx.root, 'agents', 'mdd-apply.md'), 'edited\n');
  const lock = crash(ctx, 'v030', 'state');
  const set = listBackups(ctx.vp).valid[0];
  rmSync(set.dir, { recursive: true, force: true });
  const result = recover(lock, ctx.paths, deps());
  assert.equal(result.status, 'rolled-forward', result.message);
  assertInstalled({ ...ctx, lock }, 'v030');
  lock.release();
});

test('R9: with material gone and a half-applied target, recovery blocks instead of guessing', async t => {
  const ctx = newInstall(t);
  await doSwitch(ctx, 'v020');
  writeFileSync(join(ctx.root, 'agents', 'mdd-apply.md'), 'edited\n');
  const lock = crash(ctx, 'v030', 'asset-replace');
  rmSync(listBackups(ctx.vp).valid[0].dir, { recursive: true, force: true });
  const result = recover(lock, ctx.paths, deps());
  assert.equal(result.status, 'blocked');
  assert.equal(readJournal(ctx.vp).phase, 'blocked');
  lock.release();
});

// ---------------------------------------------------------------- manager survival and retention

test('R8/DD5: a release target with a higher manager revision upgrades the manager after the commit; a legacy target leaves it alone', async t => {
  const ctx = newInstall(t);
  await doSwitch(ctx, 'v020');
  assert.equal(readCurrent(ctx.paths), undefined);
  const up = await doSwitch(ctx, 'v040');
  assert.equal(up.status, 'switched');
  assert.equal(readCurrent(ctx.paths).revision, 2);
  assert.ok(up.result.warnings.some(warning => /revisi\u00f3n 2/.test(warning)));
  const down = await doSwitch(ctx, 'v020');
  assert.equal(down.status, 'switched');
  assert.equal(readCurrent(ctx.paths).revision, 2, 'forward-only: a legacy package cannot downgrade the manager');
  assertInstalled(ctx, 'v020');
});

test('retention: ten backups kept after a switch; a stale transaction directory is swept by recovery', async t => {
  const ctx = newInstall(t);
  await doSwitch(ctx, 'v020');
  for (let n = 0; n < 12; n++) {
    createBackup(ctx.lock, { source: V('v030').identity, target: V('v020').identity, config: null, assets: [], now: () => new Date(Date.UTC(2026, 10, 1, 0, n)) });
  }
  mkdirSync(join(ctx.vp.txRoot, 'deadbeef', 'stage'), { recursive: true });
  const outcome = await doSwitch(ctx, 'v030');
  assert.equal(outcome.status, 'switched');
  assert.equal(listBackups(ctx.vp).valid.length, 10);
  assert.ok(listBackups(ctx.vp).valid.some(set => set.name === outcome.result.backupName), 'the new backup is retained');
  assert.ok(!existsSync(join(ctx.vp.txRoot, 'deadbeef')));
});

// ---------------------------------------------------------------- adoption

const baseline = () => path => showAt(sourceOf(), V('v020').commit, path);

test('S27: an existing 0.2.0 installation is adopted as stable 0.2.0 with edits kept and disclosed; repeating changes nothing', t => {
  const ctx = newInstall(t);
  seedLegacy(ctx, 'v020', { edit: { 'agents/mdd-apply.md': 'my edit\n' }, config: BASE_CONFIG });
  const before = snap(ctx);
  const result = adoptInstallation(ctx.lock, ctx.paths, { readBaselineFile: baseline() });
  assert.equal(result.status, 'adopted', result.message);
  assert.deepEqual(result.editedAssets, ['agents/mdd-apply.md']);
  assert.match(result.message, /estable 0\.2\.0 \(adoptada\)/);
  assert.match(result.message, /build no verificado/);
  assert.deepEqual(result.verified, { packageJson: true, packagedAssets: true, dist: false });
  assert.equal(result.configValid, true);
  const state = readState(ctx.vp);
  assert.equal(state.active.provenance, 'adopted');
  assert.equal(state.active.channel, 'stable');
  assert.notEqual(state.active.kind, 'dev');
  assert.equal(state.active.commit, BASELINE.commit, 'adoption pins the baseline commit');
  assert.equal(state.releases['0.2.0'].commit, BASELINE.commit);
  assert.equal(state.active.packageDigest, installedPackageDigest(ctx.paths));
  const after = snap(ctx);
  delete before.active; delete after.active;
  assert.deepEqual(after, before, 'nothing but state.json changed (edited bytes preserved)');

  const stateBytes = readFileSync(ctx.vp.statePath);
  const again = adoptInstallation(ctx.lock, ctx.paths, { readBaselineFile: baseline() });
  assert.equal(again.status, 'already');
  assert.match(again.message, /ya est\u00e1 adoptada/);
  assert.ok(readFileSync(ctx.vp.statePath).equals(stateBytes), 'no history written on repeat');
});

test('S28: a different version, foreign leftovers or packaged-content drift refuse adoption with guidance and write nothing but the refusal', t => {
  const wrongVersion = newInstall(t);
  seedLegacy(wrongVersion);
  const pkgPath = join(wrongVersion.paths.installedPackageRoot, 'package.json');
  writeFileSync(pkgPath, readFileSync(pkgPath, 'utf8').replace('"version": "0.2.0"', '"version": "0.2.1"'));
  const before = snap(wrongVersion);
  const refused = adoptInstallation(wrongVersion.lock, wrongVersion.paths, { readBaselineFile: baseline() });
  assert.equal(refused.status, 'refused');
  assert.match(refused.message, /my-driven-development@0\.2\.1/);
  assert.match(refused.message, /mdd-ai use 0\.2\.0/);
  assert.match(refused.message, /mdd-ai use dev/);
  assert.equal(readState(wrongVersion.vp).active, null);
  assert.equal(readState(wrongVersion.vp).adoption.status, 'refused');
  const after = snap(wrongVersion); assert.deepEqual(after, before);

  const leftovers = newInstall(t);
  mkdirSync(join(leftovers.paths.ownedRoot, 'node_modules', 'my-driven-development'), { recursive: true });
  const broken = adoptInstallation(leftovers.lock, leftovers.paths, { readBaselineFile: baseline() });
  assert.equal(broken.status, 'refused');
  assert.match(broken.message, /Hay restos de un paquete MDD que no resuelven/);

  const drift = newInstall(t);
  seedLegacy(drift);
  const result = adoptInstallation(drift.lock, drift.paths, { readBaselineFile: path => (path.endsWith('mdd-apply.md') ? Buffer.from('not the baseline') : baseline()(path)) });
  assert.equal(result.status, 'refused');
  assert.deepEqual(result.differing, ['assets/opencode/agents/mdd-apply.md']);
  assert.equal(readState(drift.vp).active, null);

  const empty = newInstall(t);
  const absent = adoptInstallation(empty.lock, empty.paths, { readBaselineFile: baseline() });
  assert.equal(absent.status, 'absent');
  assert.equal(readState(empty.vp).adoption, null);
});

test('S28: edited deployed assets alone do not stop adoption; an unreadable baseline is disclosed as unverified, not as verified', t => {
  const ctx = newInstall(t);
  seedLegacy(ctx, 'v020', { edit: { 'plugins/mdd.ts': '// changed\n' } });
  rmSync(join(ctx.paths.ownedRoot, 'setup-assets.json'));
  const result = adoptInstallation(ctx.lock, ctx.paths, {});
  assert.equal(result.status, 'adopted');
  assert.equal(result.ledgerMissing, true);
  assert.deepEqual(result.verified, { packageJson: true, packagedAssets: false, dist: false });
  assert.match(result.message, /sin verificar/);
  assert.match(result.message, /falta el registro de activos/);
  assert.deepEqual(result.editedAssets, ['plugins/mdd.ts']);
});

test('R10: ordinary state reads and writes by other commands stay compatible with a switch (state round-trips unknown fields)', async t => {
  const ctx = newInstall(t);
  await doSwitch(ctx, 'v030');
  const state = readState(ctx.vp);
  writeState(ctx.lock, state);
  assert.deepEqual(readState(ctx.vp), state);
  assert.equal(state.active.selectedAs, '0.3.0');
  assert.equal(state.active.tarballSha256, V('v030').prepared.sha256);
  assert.equal(statSync(ctx.vp.statePath).isFile(), true);
});
