import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { LocalFiles, lockIdentity, reclaimSlot } from '../dist/local-files.js';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

function root(t) {
  const path = fs.mkdtempSync(join(tmpdir(), 'mdd-local-files-'));
  t.after(() => fs.rmSync(path, { recursive: true, force: true }));
  return path;
}
const ownerName = `.mdd/owner-${createHash('sha256').update('run-lock').digest('hex')}.json`;

/** A PID that belonged to a real process which has already exited. */
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const pid = Number(child.stdout);
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  return pid;
}

function seed(t) {
  const directory = root(t);
  const files = new LocalFiles(directory);
  files.updateStrict(ownerName, () => '{"state":"committed"}', 4096);
  return { directory, files, path: join(directory, ownerName), guard: `${join(directory, ownerName)}.lock` };
}

test('a strict lock left by a provably dead process on this host is reclaimed', t => {
  const { files, guard } = seed(t);
  fs.writeFileSync(guard, JSON.stringify({ ...lockIdentity(), pid: deadPid(), nonce: randomUUID() }));
  files.updateStrict(ownerName, previous => { assert.equal(previous, '{"state":"committed"}'); return '{"state":"next"}'; }, 4096);
  assert.equal(files.readStrict(ownerName, 4096), '{"state":"next"}');
  assert.equal(fs.existsSync(guard), false);
});

test('a strict lock held by a live process is kept, never reclaimed by age', t => {
  const { files, guard } = seed(t);
  const body = JSON.stringify({ ...lockIdentity(), nonce: randomUUID() });
  fs.writeFileSync(guard, body);
  const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  fs.utimesSync(guard, longAgo, longAgo);
  assert.throws(() => files.updateStrict(ownerName, () => '{"state":"stolen"}', 4096));
  assert.equal(fs.readFileSync(guard, 'utf8'), body);
  assert.equal(files.readStrict(ownerName, 4096), '{"state":"committed"}');
});

test('a dead PID from another host, or an unreadable lock, is never reclaimed', t => {
  const { files, guard } = seed(t);
  for (const body of [JSON.stringify({ pid: deadPid(), host: `${hostname()}-elsewhere`, nonce: randomUUID() }), 'uncertain writer', '']) {
    fs.writeFileSync(guard, body);
    assert.throws(() => files.updateStrict(ownerName, () => '{"state":"stolen"}', 4096));
    assert.equal(fs.readFileSync(guard, 'utf8'), body);
  }
});

test('a strict read returns the committed file while another writer holds the lock', t => {
  const { files, guard } = seed(t);
  fs.writeFileSync(guard, JSON.stringify({ pid: process.pid, host: hostname(), nonce: randomUUID() }));
  assert.equal(files.readStrict(ownerName, 4096), '{"state":"committed"}');
});

test('the lock names its owner while held and is removed afterwards', t => {
  const { files, guard } = seed(t);
  files.updateStrict(ownerName, previous => {
    const body = JSON.parse(fs.readFileSync(guard, 'utf8'));
    assert.equal(body.pid, process.pid);
    assert.equal(body.host, hostname());
    assert.match(body.nonce, /^[0-9a-f-]{36}$/);
    return previous;
  }, 4096);
  assert.equal(fs.existsSync(guard), false);
});

test('transient Windows EPERM/EBUSY on rename and unlock is retried, not fatal', t => {
  const { files, guard } = seed(t);
  const rename = fs.renameSync;
  const unlink = fs.unlinkSync;
  let renames = 0; let unlocks = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (++renames <= 2) throw Object.assign(new Error('busy'), { code: renames === 1 ? 'EPERM' : 'EBUSY' });
    return rename(from, to);
  });
  t.mock.method(fs, 'unlinkSync', path => {
    if (String(path) === guard && ++unlocks === 1) throw Object.assign(new Error('busy'), { code: 'EPERM' });
    return unlink(path);
  });
  files.updateStrict(ownerName, () => '{"state":"after-retry"}', 4096);
  assert.equal(files.readStrict(ownerName, 4096), '{"state":"after-retry"}');
  assert.ok(renames >= 3);
  assert.equal(fs.existsSync(guard), false);
});

test('a dead PID is never judged across platforms: WSL and Windows sharing a hostname keep each other\'s locks', t => {
  const { files, guard } = seed(t);
  const me = lockIdentity();
  const pid = deadPid();
  for (const other of [
    { ...me, pid, platform: me.platform === 'win32' ? 'linux-wsl' : 'win32' },
    { ...me, pid, host: `${me.host}-elsewhere`, boot: me.boot - 3600 },
    { pid, host: me.host },
  ]) {
    const body = JSON.stringify({ ...other, nonce: randomUUID() });
    fs.writeFileSync(guard, body);
    assert.throws(() => files.updateStrict(ownerName, () => '{"state":"stolen"}', 4096));
    assert.equal(fs.readFileSync(guard, 'utf8'), body);
  }
  assert.equal(files.readStrict(ownerName, 4096), '{"state":"committed"}');
});

test('a lock from a previous boot of this machine is reclaimed even if its pid is in use again', t => {
  const { files, guard } = seed(t);
  const me = lockIdentity();
  // The pid is alive now (it is this very process), but it cannot be the writer from an earlier boot.
  const { bootID: _bootID, ...previous } = me;
  fs.writeFileSync(guard, JSON.stringify({ ...previous, boot: me.boot - 6 * 3600, ...(me.bootID ? { bootID: 'an-earlier-boot' } : {}), nonce: randomUUID() }));
  files.updateStrict(ownerName, () => '{"state":"after-reboot"}', 4096);
  assert.equal(files.readStrict(ownerName, 4096), '{"state":"after-reboot"}');
  assert.equal(fs.existsSync(guard), false);
});

function slotFiles(directory) {
  return fs.readdirSync(join(directory, '.mdd')).filter(name => name.includes('.reclaim'));
}

test('reclaim is serialized by an exclusive slot named for the dead lock, so a live reclaimer is never overtaken', t => {
  const { directory, files, guard } = seed(t);
  const dead = randomUUID();
  const body = JSON.stringify({ ...lockIdentity(), pid: deadPid(), nonce: dead });
  fs.writeFileSync(guard, body);
  // A live reclaimer is mid-reclaim of this exact dead lock: this one backs off.
  fs.writeFileSync(reclaimSlot(guard, dead), JSON.stringify({ ...lockIdentity(), nonce: randomUUID() }));
  assert.throws(() => files.updateStrict(ownerName, () => '{"state":"stolen"}', 4096));
  assert.equal(fs.readFileSync(guard, 'utf8'), body);
  fs.unlinkSync(reclaimSlot(guard, dead));
  files.updateStrict(ownerName, () => '{"state":"after"}', 4096);
  assert.deepEqual(slotFiles(directory), []);
});

test('a reclaim slot orphaned by a dead reclaimer is itself reclaimed by the same rule', t => {
  const { directory, files, guard } = seed(t);
  for (const holder of [{ ...lockIdentity(), pid: deadPid() }, { ...lockIdentity(), boot: lockIdentity().boot - 6 * 3600, bootID: 'an-earlier-boot' }]) {
    const dead = randomUUID();
    fs.writeFileSync(guard, JSON.stringify({ ...lockIdentity(), pid: deadPid(), nonce: dead }));
    fs.writeFileSync(reclaimSlot(guard, dead), JSON.stringify({ ...holder, nonce: randomUUID() }));
    files.updateStrict(ownerName, () => JSON.stringify({ state: 'recovered', dead }), 4096);
    assert.equal(JSON.parse(files.readStrict(ownerName, 4096)).dead, dead);
    assert.equal(fs.existsSync(guard), false);
    assert.deepEqual(slotFiles(directory), []);
  }
});

test('a reclaim slot that cannot be removed is reported, not silently left behind', t => {
  const { directory, files, guard } = seed(t);
  fs.writeFileSync(guard, JSON.stringify({ ...lockIdentity(), pid: deadPid(), nonce: randomUUID() }));
  const unlink = fs.unlinkSync;
  let refused = 0;
  t.mock.method(fs, 'unlinkSync', path => {
    if (String(path).includes('.reclaim')) { refused++; throw Object.assign(new Error('held by scanner'), { code: 'EPERM' }); }
    return unlink(path);
  });
  assert.throws(() => files.updateStrict(ownerName, () => '{"state":"blocked"}', 4096));
  assert.ok(refused > 1, 'the slot removal was retried before being reported');
  t.mock.restoreAll();
  // The leftover slot is named for a lock that no longer exists, so it blocks nothing.
  files.updateStrict(ownerName, () => '{"state":"next"}', 4096);
  assert.equal(files.readStrict(ownerName, 4096), '{"state":"next"}');
  assert.equal(slotFiles(directory).length, 1);
});

test('processes racing to reclaim one dead lock never both hold it', async t => {
  const { directory, guard } = seed(t);
  const files = new LocalFiles(directory);
  files.updateStrict(ownerName, () => JSON.stringify({ n: 0 }), 4096);
  fs.writeFileSync(guard, JSON.stringify({ ...lockIdentity(), pid: deadPid(), nonce: randomUUID() }));
  const moduleURL = pathToFileURL(join(process.cwd(), 'dist', 'local-files.js')).href;
  const script = `import { LocalFiles } from ${JSON.stringify(moduleURL)};
    const files = new LocalFiles(process.argv[1]);
    try { files.updateStrict(process.argv[2], previous => { const n = JSON.parse(previous).n;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40); return JSON.stringify({ n: n + 1 }); }, 4096); process.stdout.write('won'); }
    catch { process.stdout.write('busy'); }`;
  const launch = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, directory, ownerName], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', () => resolve(output));
  });
  const results = await Promise.all(Array.from({ length: 6 }, launch));
  const won = results.filter(item => item === 'won').length;
  assert.ok(won >= 1);
  assert.equal(JSON.parse(files.readStrict(ownerName, 4096)).n, won, 'no winner overwrote another winner');
  assert.equal(fs.existsSync(guard), false);
  assert.equal(fs.existsSync(`${guard}.reclaim`), false);
});

test('a rename that keeps failing leaves the committed file and no temporary behind', t => {
  const { directory, files, guard } = seed(t);
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('locked'), { code: 'EACCES' }); });
  assert.throws(() => files.updateStrict(ownerName, () => '{"state":"lost"}', 4096));
  t.mock.restoreAll();
  assert.equal(files.readStrict(ownerName, 4096), '{"state":"committed"}');
  assert.deepEqual(fs.readdirSync(join(directory, '.mdd')).filter(name => name.endsWith('.tmp')), []);
  assert.equal(fs.existsSync(guard), false);
});
