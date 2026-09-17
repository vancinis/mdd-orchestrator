import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, parse, relative, resolve, sep } from 'node:path';
import type { EngramSettings } from './settings.js';

type Local = Extract<EngramSettings, { mode: 'local' }>;
type Dependencies = { spawn: typeof spawn; port: () => Promise<number> };

async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => error ? reject(error) : done((address as { port: number }).port));
    });
  });
}

function prepare(directory: string): void {
  const root = parse(directory).root;
  let current = root;
  for (const part of relative(root, directory).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!lstatSync(current, { throwIfNoEntry: false })) mkdirSync(current, { mode: 0o700 });
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe managed memory directory.');
  }
  for (const name of readdirSync(directory)) {
    const stat = lstatSync(join(directory, name));
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) throw new Error('Unsafe managed memory file.');
  }
  // v1.20.0 otherwise searches drive roots and migrates unrelated orphan databases.
  try { closeSync(openSync(join(directory, 'engram.db'), 'wx', 0o600)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}

export class ManagedMemory {
  #child?: ChildProcess;
  #ready?: Promise<string>;
  #closed = false;
  readonly #exit = () => { this.#child?.kill(); };
  constructor(readonly settings: Local, readonly dependencies: Dependencies = { spawn, port: freePort }) {}

  endpoint(): Promise<string> {
    if (this.#closed) return Promise.reject(new Error('Managed memory is closed.'));
    return this.#ready ??= this.#start();
  }

  async #start(): Promise<string> {
    const { binary } = this.settings;
    const stat = lstatSync(binary);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The approved Engram binary is unavailable.');
    const directory = resolve(this.settings.dataDirectory);
    prepare(directory);
    const port = await this.dependencies.port();
    if (this.#closed) throw new Error('Managed memory is closed.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid managed memory port.');
    const endpoint = `http://127.0.0.1:${port}`;
    const env: NodeJS.ProcessEnv = { ENGRAM_DATA_DIR: directory, ENGRAM_CLOUD_AUTOSYNC: '0', HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory, TMP: directory, TEMP: directory };
    for (const key of ['PATH', 'SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key];
    const child = this.dependencies.spawn(binary, ['serve', String(port)], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    this.#child = child;
    process.once('exit', this.#exit);
    try {
      await new Promise<void>((done, reject) => {
        let output = '';
        const finish = (error?: Error) => { clearTimeout(timer); child.stderr?.off('data', read); error ? reject(error) : done(); };
        const read = (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-4096);
          if (output.includes(`HTTP server listening on 127.0.0.1:${port}`)) finish();
        };
        const timer = setTimeout(() => finish(new Error('Managed Engram readiness timed out.')), 5000);
        child.stderr?.on('data', read);
        child.once('error', () => finish(new Error('Managed Engram failed to start.')));
        child.once('exit', () => { this.#closed = true; process.off('exit', this.#exit); finish(new Error('Managed Engram exited.')); });
      });
      child.stderr?.resume();
      if (this.#closed || child.exitCode !== null) throw new Error('Managed Engram exited before readiness.');
      return endpoint;
    } catch (error) { await this.close(); throw error; }
  }

  async close(): Promise<void> {
    this.#closed = true;
    process.off('exit', this.#exit);
    const child = this.#child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(done => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); done(); }, 1000);
      child.once('exit', () => { clearTimeout(timer); done(); });
      child.kill();
    });
  }
}
