import { ValidationError } from './validation.js';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type MemoryBinding = { id: string; project: string; directory: string };
class MissingSession extends Error {}

/**
 * Windows resolves paths case-insensitively and Engram stores them lowercased, so comparing the
 * exact strings rejected the very session MDD had just registered: the readback of `C:\Users\...`
 * came back as `c:\users\...`. Path identity is compared the way the platform defines it.
 */
function pathKey(value: string): string {
  const absolute = resolve(value);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

export function samePath(a: string, b: string): boolean { return pathKey(a) === pathKey(b); }

/**
 * The repository a linked git worktree belongs to, or nothing when this directory is not one.
 * A linked worktree keeps `gitdir: <repository>/.git/worktrees/<name>` in a `.git` file, and that
 * administrative directory names its shared git directory in `commondir`. MDD reads that layout
 * itself instead of trusting a provider field: it is what proves the native root is a checkout of
 * the same repository the memory project points at.
 */
export function worktreeRepository(directory: string): string | undefined {
  try {
    const marker = join(resolve(directory), '.git');
    const stat = lstatSync(marker, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size > 4096) return undefined;
    const link = /^gitdir:[ \t]*(\S.*?)[ \t]*$/m.exec(readFileSync(marker, 'utf8'));
    if (!link) return undefined;
    const administrative = resolve(dirname(marker), link[1]!);
    const shared = readFileSync(join(administrative, 'commondir'), 'utf8').trim();
    return shared ? dirname(resolve(administrative, shared)) : undefined;
  } catch { return undefined; }
}

/**
 * Whether the native root actually belongs to the resolved memory project. Engram reports the
 * project root, which is the repository root: a worktree and a subdirectory are ordinary places
 * to work from and resolve to that same project, so requiring an identical path blocked them for
 * no gain. A project root below the native root, or an unrelated one, still fails — those are the
 * resolutions that would file this workspace's work under another project.
 */
export function partOfProject(projectRoot: string, directory: string): boolean {
  if (!isAbsolute(projectRoot)) return false;
  if (samePath(projectRoot, directory)) return true;
  const inside = relative(pathKey(projectRoot), pathKey(directory));
  if (inside && !isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`)) return true;
  const repository = worktreeRepository(directory);
  return repository !== undefined && samePath(repository, projectRoot);
}

export class ArtifactObservationError extends Error {
  constructor(readonly observationID?: number) {
    super('Engram artifact write outcome is unknown; do not retry automatically.');
  }
}

export class EngramHttp {
  readonly #endpoint: string;
  readonly #binding: MemoryBinding;
  readonly #timeout: number;
  #registrationAttempted = false;

  constructor(endpoint: string, binding: MemoryBinding, timeout = 5000) {
    if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/?$/.test(endpoint) || Number(new URL(endpoint).port) > 65535) {
      throw new ValidationError('Engram endpoint must be an explicit http://127.0.0.1:PORT loopback origin.');
    }
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 5000) throw new ValidationError('Invalid timeout.');
    this.#endpoint = new URL(endpoint).origin;
    this.#binding = { ...binding };
    this.#timeout = timeout;
  }

  async #request(path: string, status: number, body?: unknown): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeout);
    try {
      const response = await fetch(`${this.#endpoint}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: { 'content-type': 'application/json' },
        redirect: 'error', signal: controller.signal,
      });
      if (response.status !== status) {
        if (response.status === 404 && path.startsWith('/sessions/')) {
          throw new MissingSession('Engram session is not registered.');
        }
        throw new Error(`Unexpected HTTP status ${response.status}.`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Missing response body.');
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 131072) throw new Error('Response exceeds 128 KiB.');
        chunks.push(value);
      }
      const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid response object.');
      return data as Record<string, unknown>;
    } catch (error) {
      if (error instanceof MissingSession) throw error;
      const detail = error instanceof SyntaxError ? 'Invalid JSON response.'
        : error instanceof Error && !controller.signal.aborted ? error.message : 'Request timed out.';
      throw new Error(`Engram: ${detail}`);
    } finally {
      controller.abort();
      clearTimeout(timer);
    }
  }

  async bootstrap(): Promise<void> {
    if (!this.#binding.id?.trim() || !this.#binding.directory || !isAbsolute(this.#binding.directory)) throw new Error('Native memory binding requires the actual parent ID and absolute directory.');
    const health = await this.#request('/health', 200);
    if (health.service !== 'engram' || health.status !== 'ok') throw new Error('Engram health capability mismatch.');
    const project = await this.#request(`/project/current?cwd=${encodeURIComponent(this.#binding.directory)}`, 200);
    if (project.error_hint || project.error || project.code || typeof project.project !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(project.project) || (this.#binding.project && project.project !== this.#binding.project) ||
        typeof project.cwd !== 'string' || !samePath(project.cwd, this.#binding.directory) || typeof project.project_path !== 'string' ||
        !partOfProject(project.project_path, this.#binding.directory) ||
        (Array.isArray(project.available_projects) && project.available_projects.length > 1)) {
      throw new Error('Engram project resolution is ambiguous, or the native root is not part of the resolved project: it is neither that project root, a directory inside it, nor a linked worktree of the same repository. Resolve this workspace in the memory provider before restarting MDD; no basename fallback is used.');
    }
    this.#binding.project = project.project;
    try { await this.checkBinding(); return; }
    catch (error) { if (!(error instanceof MissingSession)) throw error; }
    if (this.#registrationAttempted) throw new Error('Engram registration was already attempted; no second POST is safe.');
    this.#registrationAttempted = true;
    try { await this.#request('/sessions', 201, this.#binding); }
    catch { /* Reconcile one uncertain creation without repeating the mutation. */ }
    await this.checkBinding();
  }

  get project(): string { return this.#binding.project; }

  async checkBinding(): Promise<void> {
    const session = await this.#request(`/sessions/${encodeURIComponent(this.#binding.id)}`, 200);
    if (session.id !== this.#binding.id || session.project !== this.#binding.project ||
        typeof session.directory !== 'string' || !samePath(session.directory, this.#binding.directory) || session.ended_at != null) {
      throw new Error('Engram session binding mismatch or ended session; MDD never rebinds existing sessions.');
    }
  }

  async save(title: string, content: string): Promise<number> {
    if (Buffer.byteLength(content) > 40000) throw new Error('Engram receipt exceeds 40,000 bytes.');
    await this.checkBinding();
    const body = {
      session_id: this.#binding.id, project: this.#binding.project,
      scope: 'project', type: 'workflow', title, content,
    };
    const saved = await this.#request('/observations', 201, body);
    if (!Number.isSafeInteger(saved.id) || (saved.id as number) <= 0 || saved.status !== 'saved') {
      throw new Error('Engram returned an unknown save outcome; no retry is safe.');
    }
    const readback = await this.#request(`/observations/${saved.id}`, 200);
    if (readback.id !== saved.id || readback.deleted_at != null ||
        Object.entries(body).some(([key, value]) => readback[key] !== value)) {
      throw new Error('Engram observation readback mismatch; no retry is safe.');
    }
    return saved.id as number;
  }

  async saveArtifact(title: string, content: string): Promise<number> {
    if (!title.startsWith('MDD artifact v1:') || Buffer.byteLength(content) > 100000) {
      throw new Error('Invalid artifact observation.');
    }
    await this.checkBinding();
    let id: number | undefined;
    try {
      const saved = await this.#request('/observations', 201, {
        session_id: this.#binding.id, project: this.#binding.project,
        scope: 'project', type: 'mdd-artifact', title, content,
      });
      if (Number.isSafeInteger(saved.id) && (saved.id as number) > 0) id = saved.id as number;
      if (id === undefined || saved.status !== 'saved') throw new Error('Unknown outcome.');
      if (await this.readArtifact(id, title) !== content) throw new Error('Readback mismatch.');
      return id;
    } catch { throw new ArtifactObservationError(id); }
  }

  assertArtifactDirectory(directory: string): void {
    if (!samePath(directory, this.#binding.directory)) throw new Error('Artifact directory binding mismatch.');
  }

  async readArtifact(id: number, title: string): Promise<string> {
    if (!Number.isSafeInteger(id) || id <= 0 || !title.startsWith('MDD artifact v1:')) {
      throw new Error('Invalid artifact observation reference.');
    }
    await this.checkBinding();
    const value = await this.#request(`/observations/${id}`, 200);
    if (value.id !== id || value.deleted_at != null || value.session_id !== this.#binding.id ||
        value.project !== this.#binding.project || value.scope !== 'project' ||
        value.type !== 'mdd-artifact' || value.title !== title || typeof value.content !== 'string' ||
        Buffer.byteLength(value.content) > 100000) throw new Error('Artifact observation binding mismatch.');
    return value.content;
  }
}
