import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { MDD_ASSETS, MDD_PACKAGED_ASSETS, installedAsset, installedName } from '../dist/project-assets.js';
import { LOADER_PATH, PRIVATE_IGNORE_PATH } from '../dist/setup.js';

function assertPack(output, started) {
  const token = value => typeof value === 'string' && /^[A-Z_0-9]{1,40}$/.test(value) ? value : null;
  const diagnostic = `npm pack elapsedMs=${Math.round(performance.now() - started)} code=${token(output.error?.code)} status=${Number.isInteger(output.status) ? output.status : null} signal=${token(output.signal)}`;
  assert.ok(!output.error && output.status === 0 && output.signal === null, diagnostic);
}

test('R06: pack failures report bounded subprocess metadata', () => {
  const output = { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' }, stderr: 'PRIVATE stderr' };
  assert.throws(() => assertPack(output, performance.now()), error => {
    assert.match(error.message, /elapsedMs=\d+ code=ETIMEDOUT status=null signal=SIGTERM/);
    assert.doesNotMatch(error.message, /PRIVATE/);
    return true;
  });
});

test('package dry-run includes runnable build and exact owned assets without private runtime data', () => {
  const started = performance.now();
  const output = spawnSync(process.platform === 'win32' ? 'cmd.exe' : 'npm', process.platform === 'win32' ? ['/d', '/s', '/c', 'npm pack --dry-run --json --ignore-scripts'] : ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, npm_config_update_notifier: 'false' },
  });
  assertPack(output, started);
  const files = JSON.parse(output.stdout)[0].files.map(file => file.path);
  for (const role of ['mdd-jd-judge-a', 'mdd-jd-judge-b', 'mdd-jd-fix']) {
    const file = `assets/opencode/agents/${role}.md`;
    assert.ok(MDD_ASSETS.includes(file), file);
    assert.ok(files.includes(file), file);
  }
  for (const suffix of ['SKILL.md', 'references/prompts-and-formats.md']) {
    const file = `assets/opencode/skills/mdd-judgment-day/${suffix}`;
    assert.ok(MDD_ASSETS.includes(file), file); assert.ok(files.includes(file), file);
  }
  for (const suffix of ['SKILL.md', 'assets/template.html', 'references/authoring.md']) {
    const file = `assets/opencode/skills/mdd-explain/${suffix}`;
    assert.ok(MDD_ASSETS.includes(file), file); assert.ok(files.includes(file), file);
  }
  const setupScripts = ['scripts/setup.mjs'];
  for (const file of [...MDD_PACKAGED_ASSETS, ...setupScripts, 'dist/cli.js', 'dist/opencode-plugin.js', 'dist/judgment-day.js', 'dist/setup.js', 'dist/setup-ui.js', 'dist/doctor.js', 'dist/version-probe.js', 'package.json', 'README.md']) assert.ok(files.includes(file), file);
  assert.ok(files.every(file => file === 'package.json' || file === 'README.md' || MDD_PACKAGED_ASSETS.includes(file) || setupScripts.includes(file) || /^dist\/[^/]+\.(?:js|d\.ts)$/.test(file)), files.join('\n'));
  assert.ok(files.every(file => !/node_modules|\.mdd\/|mdd\.config\.json|\.env|^tests\/|^src\//.test(file)));
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(pkg.bin.mdd, 'dist/cli.js'); assert.equal(pkg.exports['./opencode-plugin'], './dist/opencode-plugin.js');
  assert.ok(fs.readFileSync('dist/cli.js', 'utf8').startsWith('#!/usr/bin/env node\n'));
});

const PROBE = fileURLToPath(new URL('../dist/version-probe.js', import.meta.url));
const probe = (root, ...args) => {
  const output = spawnSync(process.execPath, [PROBE, root, ...args], { encoding: 'utf8', timeout: 60000 });
  return { status: output.status, stderr: output.stderr, json: output.status === 0 ? JSON.parse(output.stdout) : undefined };
};
const listing = dir => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => `${e.parentPath}/${e.name}:${fs.readFileSync(`${e.parentPath}/${e.name}`, 'utf8')}`).sort().join('\n');

/** A package copy that exposes the v0.2.0 exports and, like that release, has no dist/version-manager.js. */
function fixturePackage(t, { manager } = {}) {
  const root = fs.mkdtempSync(`${os.tmpdir()}/mdd-probe-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync('assets', `${root}/assets`, { recursive: true });
  fs.mkdirSync(`${root}/dist`);
  for (const name of ['project-assets', 'settings', 'setup', 'safe-paths', 'local-files', 'validation']) fs.copyFileSync(`dist/${name}.js`, `${root}/dist/${name}.js`);
  fs.writeFileSync(`${root}/package.json`, JSON.stringify({ type: 'module' }));
  if (manager !== undefined) fs.writeFileSync(`${root}/dist/version-manager.js`, `export const MANAGER_REVISION = ${manager};\n`);
  return root;
}

test('probe contract: assets and packaged operations expose the managed set from a v0.2.0-style package', t => {
  const root = fixturePackage(t);
  const before = listing(root);
  const assets = probe(root, 'assets').json.files;
  const expected = MDD_ASSETS.map(name => installedName(name));
  assert.deepEqual(assets.slice(0, expected.length).map(file => file.path), expected);
  assert.deepEqual(assets.slice(expected.length).map(file => file.path), [LOADER_PATH, PRIVATE_IGNORE_PATH]);
  for (const name of MDD_ASSETS) assert.equal(assets.find(file => file.path === installedName(name)).content, installedAsset(root, name).content);
  assert.ok(assets.every(file => typeof file.content === 'string') && !assets.some(file => file.path === 'cli.json'));
  assert.doesNotMatch(assets.find(file => file.path.startsWith('agents/')).content, /mdd:include/);
  assert.deepEqual(probe(root, 'packaged').json.files, [...MDD_PACKAGED_ASSETS]);
  assert.equal(listing(root), before);
});

test('probe contract: config validates the directory without writing, and absence is valid', t => {
  const root = fixturePackage(t);
  const dir = fs.mkdtempSync(`${os.tmpdir()}/mdd-probe-cfg-`);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(probe(root, 'config', dir).json, { ok: true });
  fs.writeFileSync(`${dir}/mdd.config.json`, '\uFEFF{"version":1,"activeProfile":"default","profiles":{"default":{"models":{}}}}');
  const before = listing(dir);
  assert.equal(probe(root, 'config', dir).json.ok, true);
  fs.writeFileSync(`${dir}/mdd.config.json`, '{ nope');
  const broken = fs.readFileSync(`${dir}/mdd.config.json`, 'utf8');
  const result = probe(root, 'config', dir).json;
  assert.equal(result.ok, false); assert.match(result.message, /malformed JSON/);
  assert.equal(fs.readFileSync(`${dir}/mdd.config.json`, 'utf8'), broken);
  assert.deepEqual(fs.readdirSync(dir), ['mdd.config.json']);
  assert.ok(before.length > 0);
});

test('probe contract: manager reports null for a legacy package and the revision when present', t => {
  assert.deepEqual(probe(fixturePackage(t), 'manager').json, { revision: null });
  assert.deepEqual(probe(fixturePackage(t, { manager: 3 }), 'manager').json, { revision: 3 });
});

test('probe contract: failures exit non-zero without a JSON result', t => {
  const root = fixturePackage(t);
  assert.notEqual(probe(root, 'bogus').status, 0);
  assert.notEqual(probe(root, 'config').status, 0);
  fs.rmSync(`${root}/dist/settings.js`);
  const missing = probe(root, 'config', root);
  assert.notEqual(missing.status, 0); assert.equal(missing.json, undefined);
});

test('the current package also answers the probe contract', () => {
  assert.deepEqual(probe('.', 'packaged').json.files, [...MDD_PACKAGED_ASSETS]);
  assert.ok(probe('.', 'assets').json.files.some(file => file.path === LOADER_PATH));
});
