import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { mddDataRoot } from './engram-http.js';
import { LocalFiles, safeTaskName } from './local-files.js';
import type { TaskFileName } from './local-files.js';
import { identity, publishArtifactFile, readArtifactFile } from './artifacts.js';
import type { ArtifactRef } from './artifacts.js';
import { validateCheckpoint } from './checkpoint.js';
import type { StableCheckpoint } from './checkpoint.js';
import type { RunDossier } from './run-dossier.js';
import { objectWithKeys } from './validation.js';
import { validateExplorationRecord } from './worker-state.js';
import type { ExplorationRecord } from './worker-state.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MANIFEST_BYTES = 16 * 1024 * 1024;
export const TASK_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const identifier = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && Buffer.byteLength(value) <= 256;

/** Origin never changes on transfer; current parent/receipt provenance lives in each snapshot. */
export type TaskIdentity = Readonly<{
  version: 1; name: string; root: string; runID: string; directory: string; worktree: string;
  originSessionID: string; originUserMessageID: string; project?: string;
}>;
type Binding = { runID: string; directory: string; worktree: string; project?: string | undefined };
export function validateTaskIdentity(value: unknown, binding: Binding): TaskIdentity {
  const task = objectWithKeys(value, 'local task identity', ['version', 'name', 'root', 'runID', 'directory', 'worktree',
    'originSessionID', 'originUserMessageID', 'project']);
  if (task.version !== 1 || !safeTaskName(task.name) || !UUID.test(String(task.runID)) ||
      !(task.name as string).endsWith(`-${task.runID}`) || !identifier(task.originSessionID) || !identifier(task.originUserMessageID) ||
      typeof task.root !== 'string' || !isAbsolute(task.root) || resolve(task.root) !== task.root ||
      task.runID !== binding.runID || task.directory !== binding.directory || task.worktree !== binding.worktree ||
      task.project !== binding.project) throw new Error('Local task identity differs from its originating run or workspace.');
  return Object.freeze(structuredClone(task) as TaskIdentity);
}

export function taskArtifactRef(value: unknown, task: TaskIdentity): ArtifactRef {
  const ref = objectWithKeys(value, 'local task artifact', ['runID', 'phase', 'domain', 'explorationID', 'batchID',
    'recordID', 'digest', 'bytes', 'store', 'path']);
  identity({ runID: ref.runID, phase: ref.phase, ...(Object.hasOwn(ref, 'domain') ? { domain: ref.domain } : {}),
    ...(Object.hasOwn(ref, 'explorationID') ? { explorationID: ref.explorationID } : {}),
    ...(Object.hasOwn(ref, 'batchID') ? { batchID: ref.batchID } : {}) } as Parameters<typeof identity>[0]);
  if (ref.runID !== task.runID || ref.store !== 'local' || !UUID.test(String(ref.recordID)) ||
      ref.path !== `.mdd/tasks/${task.name}/artifact-${ref.recordID}.md` || !/^[a-f0-9]{64}$/.test(String(ref.digest)) ||
      !Number.isSafeInteger(ref.bytes) || (ref.bytes as number) <= 0) throw new Error('Invalid local task artifact reference.');
  return structuredClone(value) as ArtifactRef;
}

type RecordEntry = { id: string; kind: 'artifact' | 'snapshot' | 'exploration'; digest: string; bytes: number; ref?: ArtifactRef };
type Manifest = { version: 1; task: TaskIdentity; records: RecordEntry[]; latest?: string };
export type TaskSnapshot = { version: 1; task: TaskIdentity; checkpoint: StableCheckpoint; dossier: RunDossier };
export class TaskWriteError extends Error {
  constructor(readonly file: string) { super('Local task publication is incomplete or unknown. Do not advance or retry automatically.'); }
}

/** Complete evidence storage only. Operational ownership and dispatch fences stay outside it. */
export class TaskStore {
  readonly identity: TaskIdentity;
  readonly #files: LocalFiles;
  private constructor(task: TaskIdentity) { this.identity = task; this.#files = new LocalFiles(task.root); }

  static create(binding: Binding & { sessionID: string; userMessageID: string; requirements: string }): TaskStore {
    let readable = binding.requirements.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48).replace(/-$/g, '') || 'task';
    if (!safeTaskName(readable)) readable = `task-${readable}`;
    const task = validateTaskIdentity({ version: 1, name: `${readable}-${binding.runID}`, root: mddDataRoot(binding.directory),
      runID: binding.runID, directory: binding.directory, worktree: binding.worktree,
      originSessionID: binding.sessionID, originUserMessageID: binding.userMessageID,
      ...(binding.project ? { project: binding.project } : {}) }, binding);
    const store = new TaskStore(task);
    const file = store.#manifestName();
    try {
      const text = JSON.stringify({ version: 1, task, records: [] });
      store.#files.update(file, previous => {
        if (previous !== undefined) throw new Error('Task directory already occupied.');
        return text;
      }, MANIFEST_BYTES);
      if (store.#files.read(file, MANIFEST_BYTES) !== text) throw new Error('Task identity readback differs.');
    } catch { throw new TaskWriteError(file); }
    return store;
  }

  static open(value: unknown, binding: Binding): TaskStore {
    const task = validateTaskIdentity(value, binding);
    if (task.root !== mddDataRoot(binding.directory)) throw new Error('Local task repository anchor changed.');
    const store = new TaskStore(task);
    store.#manifest();
    return store;
  }

  #manifestName(): TaskFileName { return `.mdd/tasks/${this.identity.name}/manifest.json`; }
  artifactName(id: string): string {
    if (!UUID.test(id)) throw new Error('Invalid immutable record identity.');
    return `.mdd/tasks/${this.identity.name}/artifact-${id}.md`;
  }
  #recordName(record: RecordEntry): string {
    return record.kind === 'artifact' ? this.artifactName(record.id) : `.mdd/tasks/${this.identity.name}/snapshot-${record.id}.json`;
  }
  #parseManifest(text: string | undefined): Manifest {
    if (!text) throw new Error('Local task manifest missing.');
    const item = objectWithKeys(JSON.parse(text), 'local task manifest', ['version', 'task', 'records', 'latest']);
    if (item.version !== 1 || !isDeepStrictEqual(item.task, this.identity) || !Array.isArray(item.records)) throw new Error('Local task manifest binding differs.');
    const seen = new Set<string>();
    for (const value of item.records) {
      const entry = objectWithKeys(value, 'local task record', ['id', 'kind', 'digest', 'bytes', 'ref']);
      if (!UUID.test(String(entry.id)) || seen.has(entry.id as string) || !['artifact', 'snapshot', 'exploration'].includes(String(entry.kind)) ||
          !/^[a-f0-9]{64}$/.test(String(entry.digest)) || !Number.isSafeInteger(entry.bytes) || (entry.bytes as number) <= 0) throw new Error('Invalid local task manifest record.');
      seen.add(entry.id as string);
      if (entry.kind === 'artifact') {
        const ref = taskArtifactRef(entry.ref, this.identity);
        if (ref.recordID !== entry.id || ref.digest !== entry.digest || ref.bytes !== entry.bytes) throw new Error('Local task record identity differs.');
      } else if (entry.ref !== undefined) throw new Error('Snapshot cannot be an artifact capability.');
    }
    if (item.latest !== (item.records as RecordEntry[]).filter(record => record.kind === 'snapshot').at(-1)?.id)
      throw new Error('Local task progress reference differs.');
    return item as unknown as Manifest;
  }
  #manifest(): Manifest { return this.#parseManifest(this.#files.read(this.#manifestName(), MANIFEST_BYTES)); }
  #publish(record: RecordEntry, text: string): void {
    const file = this.#recordName(record);
    try {
      this.#manifest();
      publishArtifactFile(this.identity.root, file, text);
      let expected: string | undefined;
      this.#files.update(this.#manifestName(), previous => {
        const manifest = this.#parseManifest(previous);
        if (manifest.records.some(entry => entry.id === record.id)) throw new Error('Immutable record already indexed.');
        manifest.records.push(record);
        if (record.kind === 'snapshot') manifest.latest = record.id;
        expected = JSON.stringify(manifest);
        return expected;
      }, MANIFEST_BYTES);
      if (this.#files.read(this.#manifestName(), MANIFEST_BYTES) !== expected) throw new Error('Manifest publication readback differs.');
      if (readArtifactFile(join(this.identity.root, file)) !== text) throw new Error('Record publication readback differs.');
    } catch { throw new TaskWriteError(file); }
  }
  publishArtifact(value: ArtifactRef, content: string): void {
    const ref = taskArtifactRef(value, this.identity);
    if (digest(content) !== ref.digest || Buffer.byteLength(content) !== ref.bytes) throw new Error('Local artifact bytes differ.');
    this.#publish({ id: ref.recordID, kind: 'artifact', digest: ref.digest, bytes: ref.bytes, ref }, content);
  }
  readArtifact(value: ArtifactRef): string {
    const ref = taskArtifactRef(value, this.identity);
    const record = this.#manifest().records.find(entry => entry.kind === 'artifact' && entry.id === ref.recordID);
    if (!record || !isDeepStrictEqual(record.ref, ref)) throw new Error('Local artifact is not confirmed by the task manifest.');
    return this.#read(record);
  }
  #read(record: RecordEntry): string {
    const text = readArtifactFile(join(this.identity.root, this.#recordName(record)));
    if (digest(text) !== record.digest || Buffer.byteLength(text) !== record.bytes) throw new Error('Local task record readback differs.');
    return text;
  }
  writeSnapshot(checkpoint: StableCheckpoint, dossier: RunDossier): string {
    validateCheckpoint(checkpoint);
    if (!isDeepStrictEqual(checkpoint.data.task, this.identity) || checkpoint.runID !== this.identity.runID ||
        dossier.runID !== checkpoint.runID || dossier.parent.sessionID !== checkpoint.parent || dossier.answers.artifactStore !== 'local')
      throw new Error('Local task progress binding differs.');
    const text = JSON.stringify({ version: 1, task: this.identity, checkpoint, dossier } satisfies TaskSnapshot);
    if (Buffer.byteLength(text) > TASK_SNAPSHOT_MAX_BYTES) throw new TaskWriteError(this.#manifestName());
    const id = randomUUID();
    this.#publish({ id, kind: 'snapshot', digest: digest(text), bytes: Buffer.byteLength(text) }, text);
    return id;
  }
  /** Complete member reports survive aggregation and later exploration attempts. */
  writeExploration(value: ExplorationRecord): void {
    const exploration = validateExplorationRecord(value);
    if (exploration.ownerRunID !== this.identity.runID || exploration.directory !== this.identity.directory ||
        exploration.worktree !== this.identity.worktree) throw new Error('Local exploration binding differs.');
    const text = JSON.stringify({ version: 1, task: this.identity, exploration });
    if (Buffer.byteLength(text) > TASK_SNAPSHOT_MAX_BYTES) throw new TaskWriteError(this.#manifestName());
    this.#publish({ id: randomUUID(), kind: 'exploration', digest: digest(text), bytes: Buffer.byteLength(text) }, text);
  }
  latest(): TaskSnapshot | undefined {
    const manifest = this.#manifest();
    const record = manifest.records.find(entry => entry.id === manifest.latest);
    if (!record) return undefined;
    const snapshot = JSON.parse(this.#read(record)) as TaskSnapshot;
    if (snapshot.version !== 1 || !isDeepStrictEqual(snapshot.task, this.identity)) throw new Error('Local task snapshot binding differs.');
    validateCheckpoint(snapshot.checkpoint);
    if (!isDeepStrictEqual(snapshot.checkpoint.data.task, this.identity) || snapshot.dossier.runID !== this.identity.runID ||
        snapshot.dossier.parent.sessionID !== snapshot.checkpoint.parent) throw new Error('Local task snapshot progress binding differs.');
    return snapshot;
  }
}
