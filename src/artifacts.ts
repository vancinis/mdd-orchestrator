import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';
import { ArtifactObservationError, EngramHttp } from './engram-http.js';
import type { Answers, Phase } from './policy.js';
import type { TaskStore } from './task-store.js';

/**
 * `mdd-risk` is not a Phase, but its assessment is persisted exactly like a phase artifact so the
 * evidence that selected the route is kept in the same store as the work it routed.
 */
export const PHASE_PATHS = Object.freeze({
  'mdd-explore': 'exploration.md', 'mdd-plan': 'plan.md', 'mdd-propose': 'proposal.md',
  'mdd-spec': 'specs/{domain}/spec.md', 'mdd-design': 'design.md', 'mdd-tasks': 'tasks.md',
  'mdd-apply': 'apply-progress.md', 'mdd-verify': 'verify-report.md', 'mdd-risk': 'risk.md',
} satisfies Record<Phase | 'mdd-risk', string>);
export type ArtifactIdentity = { runID: string; phase: Phase | 'mdd-risk'; domain?: string; explorationID?: string; batchID?: string };
export type ArtifactRef = Readonly<ArtifactIdentity & {
  recordID: string; digest: string; bytes: number; store: Answers['artifactStore'];
  path?: string; observationID?: number;
}>;
export type ArtifactResult = Readonly<{ ref: ArtifactRef; content: string }>;
export type ArtifactAttempt = Readonly<{
  backend: 'openspec' | 'engram' | 'local'; status: 'confirmed' | 'unknown'; ref: ArtifactRef;
}>;
export class ArtifactWriteError extends Error {
  constructor(readonly attempts: readonly ArtifactAttempt[]) {
    super('Artifact persistence incomplete or unknown; do not advance, retry, or roll back automatically.');
  }
}

function slug(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value) ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(value)) throw new Error('Invalid artifact slug.');
}
/**
 * Exported so checkpoint restore can validate a persisted `ArtifactRef`'s identity fields with
 * the same rules the store enforces when it mints one, instead of duplicating the slug and
 * domain/explorationID shape here and risking the two drifting apart.
 */
export function identity(value: ArtifactIdentity): ArtifactIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['runID', 'phase', 'domain', 'explorationID', 'batchID'].includes(key))) {
    throw new Error('Invalid artifact identity.');
  }
  slug(value.runID);
  if (!Object.hasOwn(PHASE_PATHS, value.phase)) throw new Error('Invalid artifact phase.');
  if (value.phase === 'mdd-spec') slug(value.domain);
  else if (value.domain !== undefined) throw new Error('Only specs have a domain.');
  if (value.explorationID !== undefined) {
    if (value.phase !== 'mdd-explore') throw new Error('Only exploration has a side identity.');
    slug(value.explorationID);
  }
  if (value.batchID !== undefined) {
    if (value.phase !== 'mdd-apply') throw new Error('Only Apply has a batch identity.');
    slug(value.batchID);
  }
  return { ...value };
}
function contentCheck(content: string): void {
  if (typeof content !== 'string' || !content.trim() ||
      Buffer.from(content).toString('utf8') !== content) throw new Error('Artifact must be nonempty valid UTF-8.');
}
function digest(content: string): string { return createHash('sha256').update(content).digest('hex'); }
function artifactPath(value: ArtifactIdentity): string {
  const name = value.batchID ? `apply/${value.batchID}/apply-progress.md`
    : value.explorationID ? `explorations/${value.explorationID}/exploration.md`
    : PHASE_PATHS[value.phase].replace('{domain}', value.domain ?? '');
  return `openspec/changes/${value.runID}/${name}`;
}

export function artifactDirectories(path: string, createBelow?: string): void {
  const root = parse(path).root;
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (createBelow && current.startsWith(`${createBelow}${sep}`) && !fs.existsSync(current)) {
      try { fs.mkdirSync(current, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe artifact directory.');
  }
}
export function readArtifactFile(path: string): string {
  artifactDirectories(dirname(path));
  const before = fs.lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error('Unsafe artifact file.');
  const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 ||
        stat.ino !== before.ino || stat.dev !== before.dev) throw new Error('Unsafe artifact file.');
    const bytes = fs.readFileSync(fd);
    const content = bytes.toString('utf8');
    contentCheck(content);
    if (!bytes.equals(Buffer.from(content))) throw new Error('Invalid artifact encoding.');
    return content;
  } finally { fs.closeSync(fd); }
}

/** Exclusive evidence publication. An existing file is never reused or overwritten. */
export function publishArtifactFile(root: string, name: string, content: string): void {
  contentCheck(content);
  const path = join(root, name);
  const inside = relative(root, resolve(path));
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || parse(inside).root) throw new Error('Unsafe artifact destination.');
  artifactDirectories(dirname(path), root);
  const fd = fs.openSync(path, 'wx', 0o600);
  try { fs.writeFileSync(fd, content, 'utf8'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  if (readArtifactFile(path) !== content) throw new Error('Artifact publication readback differs.');
}

/** Live references are capabilities of this instance, not arbitrary paths or observation IDs. */
export class ArtifactStore {
  readonly #root: string;
  readonly #store: Answers['artifactStore'];
  readonly #engram: EngramHttp | undefined;
  readonly #task: TaskStore | undefined;
  readonly #issued = new WeakMap<ArtifactRef, { content: string; envelope: string; title: string }>();

  constructor(root: string, store: Answers['artifactStore'], engram?: EngramHttp, task?: TaskStore) {
    if (!['engram', 'openspec', 'both', 'none', 'local'].includes(store)) throw new Error('Invalid artifact store.');
    if ((store === 'engram' || store === 'both') && !engram) throw new Error('Bound Engram client required.');
    this.#root = resolve(root);
    if (store === 'engram' || store === 'both') engram!.assertArtifactDirectory(this.#root);
    this.#store = store;
    this.#engram = engram;
    if (store === 'local' && (!task || task.identity.directory !== root)) throw new Error('Bound local task store required.');
    this.#task = task;
  }

  async save(value: ArtifactIdentity, content: string): Promise<ArtifactResult> {
    const key = identity(value);
    contentCheck(content);
    const base: ArtifactRef = { ...key, recordID: randomUUID(), digest: digest(content),
      bytes: Buffer.byteLength(content), store: this.#store };
    const title = `MDD artifact v1:${key.runID}:${key.phase}:${base.recordID}`;
    const envelope = JSON.stringify({ kind: 'mdd-artifact', version: 1, ...base, content });
    let ref = base;
    const attempts: ArtifactAttempt[] = [];
    if (this.#store === 'local') {
      ref = { ...ref, path: this.#task!.artifactName(ref.recordID) };
      try {
        this.#task!.publishArtifact(ref, content);
        attempts.push(Object.freeze({ backend: 'local', status: 'confirmed', ref: Object.freeze({ ...ref }) }));
      } catch {
        attempts.push(Object.freeze({ backend: 'local', status: 'unknown', ref: Object.freeze({ ...ref }) }));
        throw new ArtifactWriteError(Object.freeze(attempts));
      }
    }
    if (this.#store === 'openspec' || this.#store === 'both') {
      ref = { ...ref, path: artifactPath(key) };
      try {
        const path = join(this.#root, ref.path!);
        artifactDirectories(dirname(path), this.#root);
        if (!fs.lstatSync(path, { throwIfNoEntry: false })) {
          const fd = fs.openSync(path, 'wx', 0o600);
          try { fs.writeFileSync(fd, content, 'utf8'); fs.fsyncSync(fd); }
          finally { fs.closeSync(fd); }
        }
        if (readArtifactFile(path) !== content) throw new Error('Existing artifact differs.');
        attempts.push(Object.freeze({ backend: 'openspec', status: 'confirmed', ref: Object.freeze({ ...ref }) }));
      } catch {
        attempts.push(Object.freeze({ backend: 'openspec', status: 'unknown', ref: Object.freeze({ ...ref }) }));
        throw new ArtifactWriteError(Object.freeze(attempts));
      }
    }
    if (this.#store === 'engram' || this.#store === 'both') {
      try {
        ref = { ...ref, observationID: await this.#engram!.saveArtifact(title, envelope) };
        attempts.push(Object.freeze({ backend: 'engram', status: 'confirmed', ref: Object.freeze({ ...ref }) }));
      } catch (error) {
        if (error instanceof ArtifactObservationError && error.observationID !== undefined) {
          ref = { ...ref, observationID: error.observationID };
        }
        attempts.push(Object.freeze({ backend: 'engram', status: 'unknown', ref: Object.freeze({ ...ref }) }));
        throw new ArtifactWriteError(Object.freeze(attempts));
      }
    }
    ref = Object.freeze(ref);
    this.#issued.set(ref, { content, envelope, title });
    return Object.freeze({ ref, content });
  }

  async read(ref: ArtifactRef): Promise<string> {
    const issued = this.#issued.get(ref);
    if (!issued) throw new Error('Unissued artifact reference; serialized or modified references are not capabilities.');
    if (ref.store === 'local' && this.#task!.readArtifact(ref) !== issued.content) throw new Error('Artifact disk readback mismatch.');
    if (ref.store !== 'local' && ref.path && readArtifactFile(join(this.#root, ref.path)) !== issued.content) throw new Error('Artifact disk readback mismatch.');
    if (ref.observationID !== undefined &&
        await this.#engram!.readArtifact(ref.observationID, issued.title) !== issued.envelope) {
      throw new Error('Artifact Engram readback mismatch.');
    }
    if (digest(issued.content) !== ref.digest) throw new Error('Artifact digest mismatch.');
    return issued.content;
  }
}
