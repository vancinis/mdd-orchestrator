import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installationPaths } from '../dist/installation-paths.js';
import {
  CATALOG, IntegrationInstallError, catalogRelease, integrationPaths, launchCommand, launchFiles, lookupLatest,
  managedCommands, managedVersionForCommand, mcpCommand, parseManifest, platformKey, preflightListing, pruneVersions,
  readManifest, recordInstalled, retainedVersions, setRegistration, stageRelease, validateTree, verifyInstalled,
} from '../dist/integration-install.js';

const PLATFORM = 'win32-x64';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const VERSION_OUTPUT = { engram: 'engram 1.2.3\n', codegraph: '1.2.3\n' };

function fixture(t) {
  const home = fs.mkdtempSync(join(tmpdir(), 'mdd-integration-install-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, paths: integrationPaths(installationPaths({ home, env: {} })) };
}

function catalogFor(archives, version = '1.2.3') {
  const catalog = structuredClone(CATALOG);
  for (const tool of ['engram', 'codegraph']) {
    catalog[tool].version = version;
    for (const key of Object.keys(catalog[tool].assets)) {
      catalog[tool].assets[key] = {
        asset: tool === 'engram' ? `engram_${version}_${key}.zip` : `codegraph-${key}.zip`,
        size: archives[tool].length, sha256: sha(archives[tool]),
      };
    }
  }
  return catalog;
}

/** Builds the injected collaborators: a routed fetch, an extract that writes fixture trees and a fake runner. */
function harness(t, { layout, versionOutput = VERSION_OUTPUT, routes = {}, archives } = {}) {
  const bytes = archives ?? { engram: Buffer.from('engram-archive'), codegraph: Buffer.from('codegraph-archive') };
  const catalog = catalogFor(bytes);
  const calls = { fetch: [], run: [], extract: [] };
  const files = layout ?? {
    engram: { 'engram.exe': 'ENGRAM-BINARY', 'tools/cloud-sync-projects.ps1': 'x' },
    codegraph: { 'codegraph-win32-x64/node.exe': 'NODE', 'codegraph-win32-x64/lib/dist/bin/codegraph.js': 'JS', 'codegraph-win32-x64/lib/other.js': 'y' },
  };
  const deps = {
    catalog, platform: 'win32', arch: 'x64', env: { PATH: 'x', SystemRoot: 'C:\\Windows', SECRET_TOKEN: 'must-not-leak' },
    id: (() => { let n = 0; return () => `stage${++n}`; })(),
    now: () => new Date('2026-11-14T12:00:00Z'),
    fetch: async (url, init) => {
      calls.fetch.push({ url, init });
      const route = routes[url] ?? (() => {
        for (const tool of ['engram', 'codegraph']) if (url === catalogRelease(tool, PLATFORM, { catalog }).url) return () => new Response(bytes[tool]);
        return () => new Response('missing', { status: 404 });
      })();
      return route();
    },
    extract: (archive, dest, kind) => {
      calls.extract.push({ archive, dest, kind });
      const tool = fs.readFileSync(archive).equals(bytes.engram) ? 'engram' : 'codegraph';
      for (const [rel, content] of Object.entries(files[tool])) {
        fs.mkdirSync(join(dest, ...rel.split('/').slice(0, -1)), { recursive: true });
        fs.writeFileSync(join(dest, ...rel.split('/')), content);
      }
    },
    run: (file, args, options) => {
      calls.run.push({ file, args, options });
      const tool = file.toLowerCase().includes('engram') ? 'engram' : 'codegraph';
      const out = typeof versionOutput === 'function' ? versionOutput(tool) : versionOutput[tool];
      return out instanceof Error ? { status: null, stdout: '', stderr: '', error: out } : { status: 0, stdout: out, stderr: '' };
    },
  };
  return { deps, calls, catalog, bytes };
}

const release = (h, tool) => catalogRelease(tool, PLATFORM, h.deps);
const stageEntries = paths => fs.existsSync(paths.stageRoot) ? fs.readdirSync(paths.stageRoot) : [];

test('catalog pins cover every platform with reviewed https GitHub sources', () => {
  assert.equal(CATALOG.engram.version, '3.7.2');
  assert.equal(CATALOG.codegraph.version, '1.6.2');
  assert.deepEqual(CATALOG.engram.mcpArgs, ['mcp', '--tools=agent']);
  assert.deepEqual(CATALOG.codegraph.mcpArgs, ['serve', '--mcp']);
  for (const tool of ['engram', 'codegraph']) {
    assert.equal(Object.keys(CATALOG[tool].assets).length, 6);
    for (const [key, asset] of Object.entries(CATALOG[tool].assets)) {
      assert.match(asset.sha256, /^[0-9a-f]{64}$/, `${tool} ${key}`);
      assert.ok(asset.size > 0 && asset.size < 200 * 1024 * 1024);
      const url = new URL(catalogRelease(tool, key, {}).url);
      assert.equal(url.protocol, 'https:');
      assert.equal(url.hostname, 'github.com');
    }
  }
  assert.equal(platformKey('win32', 'x64'), 'win32-x64');
  assert.equal(platformKey('freebsd', 'x64'), undefined);
  assert.ok(catalogRelease('engram', 'linux-arm64', {}).url.endsWith('/v3.7.2/engram_3.7.2_linux_arm64.tar.gz'));
});

test('engram install: owned directory, isolated version probe, provenance, no activation and data untouched', async t => {
  const { home, paths } = fixture(t);
  const sentinel = join(home, '.engram', 'engram.db');
  fs.mkdirSync(join(home, '.engram'));
  fs.writeFileSync(sentinel, 'MEMORY');
  const h = harness(t);
  const { record, reused } = await stageRelease(paths, release(h, 'engram'), PLATFORM, h.deps);
  assert.equal(reused, false);
  const dir = join(paths.root, 'engram', `1.2.3-${sha(h.bytes.engram).slice(0, 8)}`);
  assert.equal(record.dir, `engram/1.2.3-${sha(h.bytes.engram).slice(0, 8)}`);
  assert.equal(fs.readFileSync(join(dir, 'engram.exe'), 'utf8'), 'ENGRAM-BINARY');
  assert.deepEqual(record.launch, { 'engram.exe': sha('ENGRAM-BINARY') });
  assert.equal(record.origin, 'catalog');
  assert.equal(record.installedAt, '2026-11-14T12:00:00.000Z');
  assert.equal(verifyInstalled(paths, 'engram', record), 'intact');
  assert.deepEqual(stageEntries(paths), []);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'MEMORY');
  // The version probe ran the staged binary with an isolated environment and exact arguments.
  assert.equal(h.calls.run.length, 1);
  const { args, options, file } = h.calls.run[0];
  assert.deepEqual(args, ['version']);
  assert.ok(file.includes('stage1') && file.endsWith('engram.exe'));
  assert.equal(options.env.HOME, options.env.ENGRAM_DATA_DIR);
  assert.ok(options.env.HOME.includes('stage1'));
  assert.equal(options.env.SECRET_TOKEN, undefined);
  assert.equal(options.env.CODEGRAPH_TELEMETRY, '0');
  // Download rules: no credentials, manual redirects.
  assert.equal(h.calls.fetch[0].init.redirect, 'manual');
  assert.equal(h.calls.fetch[0].init.credentials, 'omit');
  // Recorded in the strict manifest; nothing is activated or registered.
  const state = readManifest(paths);
  assert.deepEqual(state.manifest.tools.engram.versions['1.2.3'], record);
  assert.equal(state.manifest.tools.engram.registration, null);
  assert.deepEqual(fs.readdirSync(join(paths.ownedRoot)).sort(), ['integrations']);
  assert.deepEqual(mcpCommand('engram', dir, PLATFORM, h.catalog), [join(dir, 'engram.exe'), 'mcp', '--tools=agent']);
});

test('codegraph install renames the single platform root into place; launch is bundled node, never the shim', async t => {
  const { paths } = fixture(t);
  const h = harness(t);
  const { record } = await stageRelease(paths, release(h, 'codegraph'), PLATFORM, h.deps);
  const dir = join(paths.root, record.dir);
  assert.ok(fs.existsSync(join(dir, 'node.exe')) && fs.existsSync(join(dir, 'lib', 'dist', 'bin', 'codegraph.js')));
  assert.ok(!fs.existsSync(join(dir, 'codegraph-win32-x64')));
  assert.deepEqual(Object.keys(record.launch).sort(), ['lib/dist/bin/codegraph.js', 'node.exe']);
  assert.deepEqual(launchCommand('codegraph', dir, PLATFORM), [join(dir, 'node.exe'), '--liftoff-only', '--disable-warning=ExperimentalWarning', join(dir, 'lib', 'dist', 'bin', 'codegraph.js')]);
  assert.deepEqual(mcpCommand('codegraph', dir, PLATFORM, h.catalog).slice(-2), ['serve', '--mcp']);
  assert.ok(!mcpCommand('codegraph', dir, PLATFORM, h.catalog).includes('--path'));
  assert.deepEqual(h.calls.run[0].args.slice(-1), ['--version']);
  assert.deepEqual(launchFiles('codegraph', 'linux-x64'), ['bin/codegraph', 'node']);
  assert.deepEqual(launchCommand('codegraph', dir, 'linux-x64'), [join(dir, 'bin', 'codegraph')]);
});

test('ownership: only a recorded version\'s exact launch command is managed', async t => {
  const { paths } = fixture(t);
  const h = harness(t);
  const { record } = await stageRelease(paths, release(h, 'engram'), PLATFORM, h.deps);
  const manifest = readManifest(paths).manifest;
  const dir = join(paths.root, record.dir);
  const command = mcpCommand('engram', dir, PLATFORM, h.catalog);
  assert.equal(managedVersionForCommand(paths, 'engram', manifest, command, h.catalog)?.version, '1.2.3');
  assert.equal(managedVersionForCommand(paths, 'engram', manifest, [command[0].toUpperCase(), ...command.slice(1)], h.catalog)?.version, '1.2.3', 'Windows paths compare case-insensitively');
  assert.equal(managedVersionForCommand(paths, 'engram', manifest, [command[0], 'MCP', command[2]], h.catalog), undefined, 'arguments are exact');
  assert.equal(managedVersionForCommand(paths, 'engram', manifest, [...command, '--extra'], h.catalog), undefined);
  assert.equal(managedVersionForCommand(paths, 'engram', manifest, [join(dir, '..', 'other', 'engram.exe'), 'mcp', '--tools=agent'], h.catalog), undefined);
  assert.equal(managedVersionForCommand(paths, 'engram', manifest, ['engram', 'mcp', '--tools=agent'], h.catalog), undefined);
  assert.equal(managedVersionForCommand(paths, 'codegraph', manifest, command, h.catalog), undefined);
  assert.deepEqual(managedCommands(paths, 'engram', manifest, h.catalog), [command]);
});

test('replay is idempotent: same intact version is reused without network or process; tamper and loss are detected', async t => {
  const { paths } = fixture(t);
  const h = harness(t);
  const first = await stageRelease(paths, release(h, 'engram'), PLATFORM, h.deps);
  const fetches = h.calls.fetch.length, runs = h.calls.run.length;
  const again = await stageRelease(paths, release(h, 'engram'), PLATFORM, h.deps);
  assert.equal(again.reused, true);
  assert.deepEqual(again.record, first.record);
  assert.equal(h.calls.fetch.length, fetches);
  assert.equal(h.calls.run.length, runs);
  const binary = join(paths.root, first.record.dir, 'engram.exe');
  fs.writeFileSync(binary, 'TAMPERED');
  assert.equal(verifyInstalled(paths, 'engram', first.record), 'tampered');
  fs.rmSync(binary);
  assert.equal(verifyInstalled(paths, 'engram', first.record), 'missing');
  fs.rmSync(join(paths.root, first.record.dir), { recursive: true });
  assert.equal(verifyInstalled(paths, 'engram', first.record), 'missing');
  assert.equal(verifyInstalled(paths, 'engram', { ...first.record, dir: 'engram/elsewhere' }), 'tampered');
});

test('a pre-existing destination with matching launch digests is reused; a different one is never replaced', async t => {
  const { paths } = fixture(t);
  const h = harness(t);
  const rel = release(h, 'engram');
  const dest = join(paths.root, 'engram', `1.2.3-${rel.sha256.slice(0, 8)}`);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(join(dest, 'engram.exe'), 'DIFFERENT');
  fs.writeFileSync(join(dest, 'user-note.txt'), 'keep');
  await assert.rejects(() => stageRelease(paths, rel, PLATFORM, h.deps), error => error.stage === 'place');
  assert.equal(fs.readFileSync(join(dest, 'engram.exe'), 'utf8'), 'DIFFERENT');
  assert.equal(fs.existsSync(join(dest, 'user-note.txt')), true);
  assert.deepEqual(readManifest(paths).manifest.tools, {});
  assert.deepEqual(stageEntries(paths), []);
  fs.writeFileSync(join(dest, 'engram.exe'), 'ENGRAM-BINARY');
  const { reused, record } = await stageRelease(paths, rel, PLATFORM, h.deps);
  assert.equal(reused, true);
  assert.equal(readManifest(paths).manifest.tools.engram.versions['1.2.3'].sha256, record.sha256);
});

async function assertRejected(t, mutate, stage, pattern) {
  const { paths } = fixture(t);
  const h = harness(t, mutate.options ?? {});
  mutate.change?.(h);
  const wanted = mutate.release ? mutate.release(release(h, mutate.tool ?? 'engram'), h) : release(h, mutate.tool ?? 'engram');
  await assert.rejects(() => stageRelease(paths, wanted, PLATFORM, h.deps), error => {
    assert.ok(error instanceof IntegrationInstallError);
    assert.equal(error.stage, stage);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
  assert.deepEqual(stageEntries(paths), [], 'stage removed');
  assert.equal(fs.existsSync(paths.toolRoot('engram')) && fs.readdirSync(paths.toolRoot('engram')).length > 0, false, 'no directory placed');
  assert.equal(fs.existsSync(paths.toolRoot('codegraph')) && fs.readdirSync(paths.toolRoot('codegraph')).length > 0, false);
  assert.equal(fs.existsSync(paths.manifestPath), false, 'nothing recorded');
  return h;
}

test('download failures leave no directory and no record', async t => {
  await t.test('sha256 mismatch', t2 => assertRejected(t2, { change: h => { h.deps.fetch = async () => new Response(Buffer.from('engram-archivX')); } }, 'verify', /integridad/i));
  await t.test('more bytes than the pinned size abort the stream', t2 => assertRejected(t2, {
    change: h => { h.deps.fetch = async () => new Response(Buffer.alloc(h.bytes.engram.length + 100, 1)); },
  }, 'download', /tamaño/));
  await t.test('fewer bytes than pinned fail integrity', t2 => assertRejected(t2, { change: h => { h.deps.fetch = async () => new Response(Buffer.from('short')); } }, 'verify'));
  await t.test('host outside the allowlist', t2 => assertRejected(t2, { release: rel => ({ ...rel, url: 'https://evil.example/engram.zip' }) }, 'download', /no permitido/));
  await t.test('plain http', t2 => assertRejected(t2, { release: rel => ({ ...rel, url: rel.url.replace('https:', 'http:') }) }, 'download', /no permitido/));
  await t.test('url with credentials', t2 => assertRejected(t2, { release: rel => ({ ...rel, url: rel.url.replace('https://', 'https://user:pw@') }) }, 'download', /no permitido/));
  await t.test('redirect to a disallowed host', t2 => assertRejected(t2, {
    change: h => { h.deps.fetch = async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } }); },
  }, 'download', /no permitido/));
  await t.test('redirect to http', t2 => assertRejected(t2, {
    change: h => { h.deps.fetch = async () => new Response(null, { status: 302, headers: { location: 'http://github.com/x' } }); },
  }, 'download', /no permitido/));
  await t.test('more than five redirects', t2 => assertRejected(t2, {
    change: h => { h.deps.fetch = async () => new Response(null, { status: 302, headers: { location: 'https://github.com/loop' } }); },
  }, 'download', /redirecciones/));
  await t.test('HTTP error', t2 => assertRejected(t2, { change: h => { h.deps.fetch = async () => new Response('no', { status: 503 }); } }, 'download', /503/));
  await t.test('network error', t2 => assertRejected(t2, { change: h => { h.deps.fetch = async () => { throw new Error('offline'); }; } }, 'download', /offline/));
  await t.test('redirect chain within the limit succeeds', async t2 => {
    const { paths } = fixture(t2);
    const h = harness(t2);
    const hops = ['https://github.com/a', 'https://objects.githubusercontent.com/b', 'https://release-assets.githubusercontent.com/c'];
    h.deps.fetch = async url => {
      const index = hops.indexOf(url);
      if (url === release(h, 'engram').url) return new Response(null, { status: 302, headers: { location: hops[0] } });
      return index >= 0 && index < hops.length - 1 ? new Response(null, { status: 302, headers: { location: hops[index + 1] } }) : new Response(h.bytes.engram);
    };
    assert.equal((await stageRelease(paths, release(h, 'engram'), PLATFORM, h.deps)).reused, false);
  });
});

test('archive content failures: wrong root, missing launch file, extra root, version mismatch, blocked binary', async t => {
  await t.test('codegraph with two roots', t2 => assertRejected(t2, {
    tool: 'codegraph',
    options: { layout: { engram: {}, codegraph: { 'codegraph-win32-x64/node.exe': 'N', 'codegraph-win32-x64/lib/dist/bin/codegraph.js': 'J', 'extra/file': 'x' } } },
  }, 'validate', /estructura/));
  await t.test('codegraph with the wrong platform root', t2 => assertRejected(t2, {
    tool: 'codegraph',
    options: { layout: { engram: {}, codegraph: { 'codegraph-linux-x64/node.exe': 'N', 'codegraph-linux-x64/lib/dist/bin/codegraph.js': 'J' } } },
  }, 'validate', /estructura/));
  await t.test('launch file removed after extraction (antivirus)', t2 => assertRejected(t2, {
    options: { layout: { engram: { 'tools/readme.txt': 'only docs' }, codegraph: {} } },
  }, 'validate', /engram\.exe/));
  await t.test('version output differs', t2 => assertRejected(t2, { options: { versionOutput: { engram: 'engram 9.9.9\n' } } }, 'version', /1\.2\.3/));
  await t.test('version output has extra chatter', t2 => assertRejected(t2, { options: { versionOutput: { engram: 'engram 1.2.3\nupdate available\n' } } }, 'version'));
  await t.test('binary cannot run', t2 => assertRejected(t2, { options: { versionOutput: { engram: new Error('EPERM') } } }, 'version', /antivirus/));
  await t.test('oversized version output', t2 => assertRejected(t2, { options: { versionOutput: { engram: `engram 1.2.3${' '.repeat(70000)}` } } }, 'version'));
  await t.test('symbolic link in the extracted tree', async t2 => {
    const probe = fs.mkdtempSync(join(tmpdir(), 'mdd-link-probe-'));
    t2.after(() => fs.rmSync(probe, { recursive: true, force: true }));
    try { fs.symlinkSync(probe, join(probe, 'link'), 'junction'); } catch { t2.skip('links unavailable'); return; }
    fs.rmSync(join(probe, 'link'), { recursive: true });
    await assertRejected(t2, {
      change: h => {
        const extract = h.deps.extract;
        h.deps.extract = (archive, dest, kind) => {
          extract(archive, dest, kind);
          fs.symlinkSync(probe, join(dest, 'tools-link'), 'junction');
        };
      },
    }, 'validate', /enlaces/);
  });
  await t.test('hard link in the extracted tree', async t2 => {
    await assertRejected(t2, {
      change: h => {
        const extract = h.deps.extract;
        h.deps.extract = (archive, dest, kind) => {
          extract(archive, dest, kind);
          fs.linkSync(join(dest, 'engram.exe'), join(dest, 'second-name.exe'));
        };
      },
    }, 'validate', /no permitidas/);
  });
});

test('tree validation bounds entries and rejects non-regular content', t => {
  const { home } = fixture(t);
  const root = join(home, 'tree');
  fs.mkdirSync(join(root, 'a'), { recursive: true });
  fs.writeFileSync(join(root, 'a', 'f'), 'x');
  assert.equal(validateTree(root), undefined);
  assert.match(validateTree(join(root, 'missing')), /no es válida/);
  assert.match(validateTree(join(root, 'a', 'f')), /no es válida/);
});

test('archive listing preflight rejects traversal, absolute, drive, control and link entries', () => {
  const clean = ['engram.exe', 'tools/', 'tools/a.ps1'];
  const verbose = ['-rwxr-xr-x  0 0 0 10 Jan  1  2026 engram.exe', 'drwxr-xr-x  0 0 0 0 Jan  1  2026 tools/'];
  assert.equal(preflightListing(clean, verbose), undefined);
  for (const bad of ['../evil', 'a/../../evil', '/etc/passwd', 'C:\\Windows\\x', 'c:/x', '..\\evil', 'a\\..\\..\\b', 'bad\u0001name', '']) {
    assert.match(preflightListing([...clean, bad], verbose) ?? '', /ruta no permitida/, JSON.stringify(bad));
  }
  for (const kind of ['l', 'h', 'c', 'b', 'p', 's']) {
    assert.match(preflightListing(clean, [`${kind}rwxrwxrwx 0 0 0 0 Jan 1 2026 link -> /etc`]) ?? '', /enlaces/, kind);
  }
  assert.match(preflightListing(Array.from({ length: 5001 }, (_, i) => `f${i}`), []) ?? '', /demasiadas/);
});

// --- Real system tar: hand-built tar.gz archives exercise the real extraction path -------------

function tarEntry(name, body = '', type = '0', link = '') {
  const header = Buffer.alloc(512);
  const put = (text, offset, length) => header.write(text, offset, length, 'latin1');
  put(name, 0, 100); put('0000755\0', 100, 8); put('0000000\0', 108, 8); put('0000000\0', 116, 8);
  put(`${Buffer.byteLength(body).toString(8).padStart(11, '0')}\0`, 124, 12); put('00000000000\0', 136, 12);
  put('        ', 148, 8); put(type, 156, 1); put(link, 157, 100); put('ustar\0', 257, 6); put('00', 263, 2);
  const sum = header.reduce((total, byte) => total + byte, 0);
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  const data = Buffer.from(body);
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
const tarGz = entries => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));

function hostTar() {
  const path = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
  return fs.existsSync(path) ? path : undefined;
}

async function realTar(t, entries) {
  const key = platformKey(process.platform, process.arch);
  if (!hostTar() || !key) { t.skip('system tar or host platform unavailable'); return undefined; }
  const { paths } = fixture(t);
  const archive = tarGz(entries);
  const catalog = structuredClone(CATALOG);
  const engram = catalog.engram;
  engram.version = '1.2.3';
  engram.assets[key] = { asset: 'engram_1.2.3_host.tar.gz', size: archive.length, sha256: sha(archive) };
  const calls = [];
  const deps = {
    catalog, platform: process.platform, arch: process.arch, env: process.env, id: () => 'realtar1',
    fetch: async () => new Response(archive),
    run: (file, args, options) => {
      calls.push(args);
      if (file === hostTar()) return spawnSync(file, args, { cwd: options.cwd, env: options.env, encoding: 'utf8' });
      return { status: 0, stdout: 'engram 1.2.3\n', stderr: '' };
    },
  };
  return { paths, deps, calls, key, release: catalogRelease('engram', key, deps) };
}

test('real tar extraction: a clean archive installs', async t => {
  const exe = process.platform === 'win32' ? 'engram.exe' : 'engram';
  const setup = await realTar(t, [tarEntry(exe, 'REAL-BINARY'), tarEntry('tools/', '', '5'), tarEntry('tools/a.sh', 'echo')]);
  if (!setup) return;
  const { record } = await stageRelease(setup.paths, setup.release, setup.key, setup.deps);
  assert.equal(fs.readFileSync(join(setup.paths.root, record.dir, exe), 'utf8'), 'REAL-BINARY');
  assert.ok(setup.calls.some(args => args.includes('-xf') || args.includes('-zxf') || args.some(a => /x/.test(a) && a.startsWith('-'))));
});

for (const [label, entries] of [
  ['traversal name', [tarEntry('../escape.txt', 'x'), tarEntry('engram', 'B')]],
  ['symbolic link entry', [tarEntry('engram', 'B'), tarEntry('lnk', '', '2', '/etc/passwd')]],
  ['hard link entry', [tarEntry('engram', 'B'), tarEntry('hard', '', '1', 'engram')]],
]) {
  test(`real tar preflight rejects ${label} before anything is extracted`, async t => {
    const setup = await realTar(t, entries);
    if (!setup) return;
    await assert.rejects(() => stageRelease(setup.paths, setup.release, setup.key, setup.deps), error => error.stage === 'extract');
    assert.deepEqual(stageEntries(setup.paths), []);
    assert.equal(fs.existsSync(join(setup.paths.root, '..', 'escape.txt')), false);
    assert.equal(setup.calls.some(args => args.some(a => /^-z?xf$/.test(a))), false, 'no extraction command ran');
    assert.equal(fs.existsSync(setup.paths.toolRoot('engram')) && fs.readdirSync(setup.paths.toolRoot('engram')).length > 0, false);
  });
}

// --- Manifest --------------------------------------------------------------------------------

function sampleManifest() {
  const sha256 = 'a'.repeat(64);
  return {
    schema: 1,
    tools: {
      engram: {
        registration: { file: 'opencode.jsonc', name: 'engram' },
        versions: {
          '3.7.2': {
            version: '3.7.2', dir: 'engram/3.7.2-aaaaaaaa', platform: 'win32-x64', source: 'https://github.com/x/y/releases/download/v3.7.2/a.zip',
            sha256, format: 'engram-store-schema:1', launch: { 'engram.exe': 'b'.repeat(64) }, installedAt: '2026-11-14T00:00:00.000Z', origin: 'catalog',
          },
        },
      },
    },
  };
}

test('manifest parser is strict about every field', () => {
  assert.ok('manifest' in parseManifest(JSON.stringify(sampleManifest())));
  const mutations = {
    'unknown top key': m => { m.active = 'x'; },
    'schema 2': m => { m.schema = 2; },
    'unknown tool': m => { m.tools.other = { versions: {}, registration: null }; },
    'unknown tool key': m => { m.tools.engram.active = '3.7.2'; },
    'version key mismatch': m => { m.tools.engram.versions['3.7.3'] = m.tools.engram.versions['3.7.2']; delete m.tools.engram.versions['3.7.2']; },
    'non canonical dir': m => { m.tools.engram.versions['3.7.2'].dir = '../outside'; },
    'dir for another tool': m => { m.tools.engram.versions['3.7.2'].dir = 'codegraph/3.7.2-aaaaaaaa'; },
    'bad platform': m => { m.tools.engram.versions['3.7.2'].platform = 'plan9-x64'; },
    'bad sha': m => { m.tools.engram.versions['3.7.2'].sha256 = 'zz'; },
    'http source': m => { m.tools.engram.versions['3.7.2'].source = 'http://github.com/x'; },
    'bad format': m => { m.tools.engram.versions['3.7.2'].format = 'schema'; },
    'traversal launch key': m => { m.tools.engram.versions['3.7.2'].launch = { '../x': 'b'.repeat(64) }; },
    'bad launch digest': m => { m.tools.engram.versions['3.7.2'].launch['engram.exe'] = 'short'; },
    'bad date': m => { m.tools.engram.versions['3.7.2'].installedAt = 'yesterday'; },
    'bad origin': m => { m.tools.engram.versions['3.7.2'].origin = 'user'; },
    'extra version key': m => { m.tools.engram.versions['3.7.2'].extra = 1; },
    'bad registration file': m => { m.tools.engram.registration.file = 'config.json'; },
    'bad registration name': m => { m.tools.engram.registration.name = 'A B'; },
    'registration extra key': m => { m.tools.engram.registration.scope = 'g'; },
    'array tools': m => { m.tools = []; },
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    const manifest = sampleManifest();
    mutate(manifest);
    assert.ok('unreadable' in parseManifest(JSON.stringify(manifest)), label);
  }
  assert.ok('unreadable' in parseManifest('not json'));
  assert.ok('unreadable' in parseManifest('null'));
});

test('an unreadable manifest blocks installs, is reported and its bytes are never rewritten', async t => {
  const { paths } = fixture(t);
  fs.mkdirSync(join(paths.root), { recursive: true });
  const bytes = '{"schema":1,"tools":{},"active":"x"}';
  fs.writeFileSync(paths.manifestPath, bytes);
  const h = harness(t);
  assert.ok('unreadable' in readManifest(paths));
  await assert.rejects(() => stageRelease(paths, release(h, 'engram'), PLATFORM, h.deps), error => error.stage === 'preflight');
  assert.equal(h.calls.fetch.length, 0);
  assert.throws(() => setRegistration(paths, 'engram', null), error => error instanceof IntegrationInstallError);
  assert.throws(() => recordInstalled(paths, 'engram', sampleManifest().tools.engram.versions['3.7.2']), IntegrationInstallError);
  assert.equal(fs.readFileSync(paths.manifestPath, 'utf8'), bytes);
  assert.equal(pruneVersions(paths, 'engram', []).removed.length, 0);
});

test('manifest through a linked directory is unreadable and writes are refused', t => {
  const { home, paths } = fixture(t);
  fs.mkdirSync(paths.ownedRoot, { recursive: true });
  fs.mkdirSync(join(home, 'elsewhere'));
  try { fs.symlinkSync(join(home, 'elsewhere'), paths.root, 'junction'); } catch { t.skip('links unavailable'); return; }
  assert.ok('unreadable' in readManifest(paths));
  assert.throws(() => setRegistration(paths, 'engram', { file: 'opencode.json', name: 'engram' }), IntegrationInstallError);
  assert.deepEqual(fs.readdirSync(join(home, 'elsewhere')), []);
});

test('manifest is written through LocalFiles: atomic, lock-free afterwards and registration is independent of versions', async t => {
  const { paths } = fixture(t);
  setRegistration(paths, 'codegraph', { file: 'opencode.json', name: 'codegraph' });
  const manifest = readManifest(paths).manifest;
  assert.deepEqual(manifest.tools.codegraph, { versions: {}, registration: { file: 'opencode.json', name: 'codegraph' } });
  assert.deepEqual(fs.readdirSync(paths.root), ['manifest.json']);
  assert.match(fs.readFileSync(paths.manifestPath, 'utf8'), /\n$/);
  setRegistration(paths, 'codegraph', null);
  assert.equal(readManifest(paths).manifest.tools.codegraph.registration, null);
});

// --- Update retention and prune --------------------------------------------------------------

async function installVersions(t, versions) {
  const { paths } = fixture(t);
  const records = [];
  let clock = 0;
  for (const version of versions) {
    const archive = Buffer.from(`engram-${version}`);
    const catalog = catalogFor({ engram: archive, codegraph: Buffer.from('c') }, version);
    const deps = {
      catalog, id: () => `s${version.replaceAll('.', '')}x`, now: () => new Date(Date.UTC(2026, 10, 14, 0, 0, ++clock)),
      fetch: async () => new Response(archive),
      extract: (_a, dest) => fs.writeFileSync(join(dest, 'engram.exe'), `BIN-${version}`),
      run: () => ({ status: 0, stdout: `engram ${version}\n`, stderr: '' }),
    };
    records.push((await stageRelease(paths, catalogRelease('engram', PLATFORM, deps), PLATFORM, deps)).record);
  }
  return { paths, records };
}

test('versions coexist; the previous one stays usable and retention keeps the referenced plus the actual previous launch', async t => {
  const { paths, records } = await installVersions(t, ['1.2.3', '1.2.4', '1.2.5']);
  for (const record of records) assert.equal(verifyInstalled(paths, 'engram', record), 'intact');
  const manifest = readManifest(paths).manifest;
  // The previous version is the one the registration actually launched, never inferred from time or order.
  assert.deepEqual(retainedVersions(manifest, 'engram', '1.2.5', '1.2.3'), ['1.2.5', '1.2.3']);
  assert.deepEqual(retainedVersions(manifest, 'engram', '1.2.5'), ['1.2.5']);
  assert.deepEqual(retainedVersions(manifest, 'engram', undefined), []);
  assert.deepEqual(retainedVersions(manifest, 'engram', '1.2.3', '1.2.3'), ['1.2.3']);
  assert.deepEqual(retainedVersions(manifest, 'engram', '1.2.5', '9.9.9'), ['1.2.5'], 'an unrecorded previous version is not invented');
});

test('prune removes only recorded unreferenced versions, tolerates EBUSY and spares unrecorded directories', async t => {
  const { paths, records } = await installVersions(t, ['1.2.3', '1.2.4', '1.2.5']);
  const unrecorded = join(paths.toolRoot('engram'), 'handmade');
  fs.mkdirSync(unrecorded);
  fs.writeFileSync(join(unrecorded, 'keep.txt'), 'mine');
  const busy = join(paths.root, records[0].dir);
  const result = pruneVersions(paths, 'engram', ['1.2.5', '1.2.4'], {
    remove: path => { if (path === busy) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); fs.rmSync(path, { recursive: true }); },
  });
  assert.deepEqual(result.removed, []);
  assert.ok(result.kept.some(entry => entry.version === '1.2.3' && /EBUSY/.test(entry.reason)));
  assert.ok(fs.existsSync(busy));
  assert.ok('1.2.3' in readManifest(paths).manifest.tools.engram.versions, 'still recorded because it is still there');
  // Once nothing holds it, the next prune removes it and its record.
  const second = pruneVersions(paths, 'engram', ['1.2.5', '1.2.4']);
  assert.deepEqual(second.removed, ['1.2.3']);
  assert.equal(fs.existsSync(busy), false);
  assert.deepEqual(Object.keys(readManifest(paths).manifest.tools.engram.versions).sort(), ['1.2.4', '1.2.5']);
  assert.equal(fs.readFileSync(join(unrecorded, 'keep.txt'), 'utf8'), 'mine');
  for (const record of records.slice(1)) assert.equal(verifyInstalled(paths, 'engram', record), 'intact');
});

test('stale stage directories older than an hour are removed at the next install; fresh ones are kept', async t => {
  const { paths } = fixture(t);
  fs.mkdirSync(paths.stageRoot, { recursive: true });
  const old = join(paths.stageRoot, 'engram-old'), fresh = join(paths.stageRoot, 'engram-fresh');
  fs.mkdirSync(old); fs.mkdirSync(fresh);
  const past = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(old, past, past);
  const h = harness(t);
  h.deps.now = () => new Date();
  await stageRelease(paths, release(h, 'engram'), PLATFORM, h.deps);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
});

// --- Explicit lookup -------------------------------------------------------------------------

function lookupHarness(overrides = {}) {
  const catalog = catalogFor({ engram: Buffer.from('e'), codegraph: Buffer.from('c') });
  const asset = (version, extra = {}) => ({ name: `engram_${version}_${PLATFORM}.zip`, size: 1234, digest: `sha256:${sha(version)}`, ...extra });
  const releases = overrides.releases ?? [
    { tag_name: 'pi-v9.0.0', draft: false, prerelease: false, assets: [asset('9.0.0')] },
    { tag_name: 'v2.0.0', draft: false, prerelease: false, assets: [asset('2.0.0')] },
    { tag_name: 'v1.9.0', draft: false, prerelease: true, assets: [asset('1.9.0')] },
    { tag_name: 'v1.8.0', draft: true, prerelease: false, assets: [asset('1.8.0')] },
    { tag_name: 'v1.7.0-rc1', draft: false, prerelease: false, assets: [asset('1.7.0')] },
    { tag_name: 'v1.2.5', draft: false, prerelease: false, assets: [asset('1.2.5')] },
    { tag_name: 'v1.2.4', draft: false, prerelease: false, assets: [asset('1.2.4')] },
    { tag_name: 'v1.2.3', draft: false, prerelease: false, assets: [asset('1.2.3')] },
  ];
  const calls = [];
  const deps = {
    catalog,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.startsWith('https://api.github.com/repos/Gentleman-Programming/engram/releases')) return new Response(JSON.stringify(releases));
      if (url.endsWith('/v1.2.5/checksums.txt')) return new Response(overrides.checksums ?? `${sha('1.2.5')}  engram_1.2.5_${PLATFORM}.zip\n${'0'.repeat(64)}  other.zip\n`);
      if (url.includes('raw.githubusercontent.com') && url.includes('/v1.2.5/internal/store/store.go')) return new Response(overrides.source ?? 'package store\nconst schemaVersion = 1\n');
      return new Response('no', { status: 404 });
    },
  };
  return { deps, calls };
}

test('lookup picks the newest stable same-major release and verifies digest, checksums and data format', async () => {
  const { deps, calls } = lookupHarness();
  const candidate = await lookupLatest('engram', PLATFORM, deps);
  assert.deepEqual(candidate, {
    tool: 'engram', version: '1.2.5', asset: `engram_1.2.5_${PLATFORM}.zip`,
    url: `https://github.com/Gentleman-Programming/engram/releases/download/v1.2.5/engram_1.2.5_${PLATFORM}.zip`,
    size: 1234, sha256: sha('1.2.5'), format: 'engram-store-schema:1', kind: 'zip', origin: 'lookup',
  });
  for (const call of calls) { assert.equal(call.init.credentials, 'omit'); assert.equal(call.init.redirect, 'manual'); }
  assert.equal(calls.some(call => call.url.endsWith('.zip')), false, 'no binary was downloaded');
});

test('lookup reports a changed data format and honours the installed floor', async () => {
  const changed = await lookupLatest('engram', PLATFORM, lookupHarness({ source: 'const schemaVersion = 2' }).deps);
  assert.equal(changed.format, 'engram-store-schema:2');
  assert.deepEqual(await lookupLatest('engram', PLATFORM, lookupHarness().deps, '1.2.5'), { rejected: 'No hay una versión estable más nueva compatible.' });
});

test('lookup rejects incomplete or inconsistent metadata', async () => {
  const cases = {
    'no digest': { releases: [{ tag_name: 'v1.2.5', draft: false, prerelease: false, assets: [{ name: `engram_1.2.5_${PLATFORM}.zip`, size: 5 }] }], match: /digest/ },
    'host asset missing': { releases: [{ tag_name: 'v1.2.5', draft: false, prerelease: false, assets: [] }], match: /no publica/ },
    'oversized asset': { releases: [{ tag_name: 'v1.2.5', draft: false, prerelease: false, assets: [{ name: `engram_1.2.5_${PLATFORM}.zip`, size: 999999999, digest: `sha256:${sha('1.2.5')}` }] }], match: /tamaño/ },
    'checksum line differs': { checksums: `${'1'.repeat(64)}  engram_1.2.5_${PLATFORM}.zip\n`, match: /sumas/ },
    'checksum line absent': { checksums: `${sha('1.2.5')}  other.zip\n`, match: /sumas/ },
    'format unknown': { source: 'package store', match: /formato de datos/ },
    'only older or foreign releases': { releases: [{ tag_name: 'v1.2.3', draft: false, prerelease: false, assets: [] }, { tag_name: 'v3.0.0', draft: false, prerelease: false, assets: [] }], match: /más nueva/ },
    'not a list': { releases: { message: 'rate limited' }, match: /formato esperado/ },
  };
  for (const [label, overrides] of Object.entries(cases)) {
    const result = await lookupLatest('engram', PLATFORM, lookupHarness(overrides).deps);
    assert.ok('rejected' in result, label);
    assert.match(result.rejected, overrides.match, label);
  }
});

test('lookup is bounded: oversized responses, hostile redirects and failures are rejections, never throws', async () => {
  const { deps } = lookupHarness();
  const bad = async fetch => lookupLatest('engram', PLATFORM, { ...deps, fetch });
  assert.match((await bad(async () => new Response('x'.repeat(1024 * 1024 + 10)))).rejected, /tamaño/);
  assert.match((await bad(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }))).rejected, /no permitido/);
  assert.match((await bad(async () => { throw new Error('offline'); })).rejected, /offline/);
  assert.match((await bad(async () => new Response('{broken'))).rejected, /./);
  assert.ok('rejected' in await lookupLatest('engram', 'plan9-x64', deps));
});
