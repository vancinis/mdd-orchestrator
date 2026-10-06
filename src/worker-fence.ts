import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { applyScopeFiles, explorationFiles, type ParallelScope, type ReadTarget } from './worker-batch.js';
import { objectWithKeys } from './validation.js';
import { WorkerEdit, workerEdits } from './worker-edit.js';

export type ReadAssignment = { taskID: string; phase: 'mdd-explore'; reads: ReadTarget[]; ownerEpoch: number };
export type ApplyAssignment = { taskID: string; phase: 'mdd-apply'; scope: ParallelScope; ownerEpoch: number };
export type WorkerAssignment = ReadAssignment | ApplyAssignment;
export type WorkerHost = { fence: WorkerFence; protectedParent?: (sessionID: string) => boolean;
  applyEditing?: true; assignment?: (sessionID: string, callID: string) => WorkerAssignment | undefined };
type Child = { id: string; parentID?: string; projectID: string; location: { directory: string } };
type Admission = { parentSessionID: string; messageID: string; callID: string; assignment: WorkerAssignment;
  active: () => boolean; childID?: string; denied?: boolean };

/** Ephemeral progress is authority only while the exact native admission is active. Never restored. */
export class WorkerFence {
  readonly #calls = new Map<string, Admission>();
  readonly #children = new Map<string, Admission>();
  readonly #wake = new Set<() => void>();
  readonly #completed = new Map<string, string>();
  readonly #protectedChildren = new Set<string>();
  readonly #refusedChildren = new Set<string>();
  #available = true;
  constructor(readonly directory: string, readonly projectID: string, readonly timeout = 1000) {}
  admit(parentSessionID: string, messageID: string, callID: string, assignment: WorkerAssignment, active: () => boolean): void {
    if (!this.#available || !messageID || this.#calls.has(callID) || !active()) throw new Error('Read-only native admission is unavailable.');
    this.#calls.set(callID, { parentSessionID, messageID, callID, assignment: structuredClone(assignment), active });
  }
  progress(value: unknown): void {
    if (!this.#available || !value || typeof value !== 'object') return;
    const data = value as Record<string, unknown>;
    const admission = this.#calls.get(String(data.id));
    if (!admission || !admission.active() || data.sessionID !== admission.parentSessionID ||
        data.assistantMessageID !== admission.messageID) return;
    const metadata = data.metadata as Record<string, unknown> | undefined;
    if (metadata?.status !== 'running' || typeof metadata.sessionID !== 'string' || !metadata.sessionID) return;
    const childID = metadata.sessionID;
    this.observeChild(childID);
    const other = this.#children.get(childID);
    if (admission.childID && admission.childID !== childID || other && other !== admission) {
      admission.denied = true;
      if (other) other.denied = true;
    } else { admission.childID = childID; this.#children.set(childID, admission); }
    for (const wake of this.#wake) wake();
  }
  settle(callID: string): void {
    const admission = this.#calls.get(callID);
    if (admission) admission.denied = true; // Tombstones reject late progress and child actions.
    for (const wake of this.#wake) wake();
  }
  complete(parentSessionID: string, messageID: string, callID: string, childID: string): void {
    const admission = this.#calls.get(callID);
    if (!this.#available || !admission || admission.denied || this.#refusedChildren.has(childID) || !admission.active() || admission.childID !== childID ||
        admission.parentSessionID !== parentSessionID || admission.messageID !== messageID)
      throw new Error('Read-only completion does not match its exact bound native child.');
    this.#completed.set(callID, childID);
  }
  completedChild(callID: string): string | undefined { return this.#completed.get(callID); }
  observeChild(childID: string): void { this.#protectedChildren.add(childID); }
  assignment(session: Child): WorkerAssignment | undefined {
    const admission = this.#children.get(session.id);
    try {
      if (this.#available && admission && !admission.denied && !this.#refusedChildren.has(session.id) && admission.active() &&
          session.parentID === admission.parentSessionID && session.projectID === this.projectID && session.location.directory === this.directory)
        return structuredClone(admission.assignment);
    } catch { /* Lost durable owner is never live authority. */ }
    return undefined;
  }
  async edit(session: Child, input: unknown, signal?: AbortSignal): Promise<{ changed: string[] }> {
    if (!session.parentID) throw new Error('Only a bound Apply child may use the scoped editor.');
    const assignment = await this.guard(session, 'mdd_worker_edit', input, true);
    if (assignment?.phase !== 'mdd-apply') throw new Error('Only a bound Apply worker may use the scoped editor.');
    return new WorkerEdit(this.directory).execute(assignment.scope, input, () => {
      const current = this.assignment(session);
      return !signal?.aborted && current?.phase === 'mdd-apply' && current.ownerEpoch === assignment.ownerEpoch;
    });
  }
  close(): void {
    this.#available = false;
    for (const wake of this.#wake) wake();
  }
  async guard(session: Child, tool: string, input: unknown, protectedParent: boolean): Promise<WorkerAssignment | undefined> {
    if (protectedParent) this.observeChild(session.id);
    const tracked = this.#children.has(session.id) || this.#protectedChildren.has(session.id);
    if (!protectedParent && !tracked) return;
    if (!session.parentID) throw new Error('Read-only worker lost its native child-parent identity.');
    if (session.projectID !== this.projectID || session.location.directory !== this.directory)
      throw new Error('Read-only worker child moved outside its exact native location.');
    let admission = this.#children.get(session.id);
    if (!admission && this.#available && !this.#refusedChildren.has(session.id)) {
      await new Promise<void>(resolveWait => {
        const finish = () => { clearTimeout(timer); this.#wake.delete(wake); resolveWait(); };
        const wake = () => { if (!this.#available || this.#children.has(session.id)) finish(); };
        const timer = setTimeout(finish, this.timeout);
        this.#wake.add(wake);
      });
      admission = this.#children.get(session.id);
    }
    if (!this.#available || !admission || admission.denied || !admission.active() || admission.parentSessionID !== session.parentID || this.#refusedChildren.has(session.id)) {
      this.#refusedChildren.add(session.id);
      throw new Error('Read-only worker has no exact active native progress binding.');
    }
    const assignment = admission.assignment;
    if (tool === 'mdd_worker_edit' && assignment.phase === 'mdd-apply') {
      workerEdits(this.directory, assignment.scope, input);
      return structuredClone(assignment);
    }
    const files = assignment.phase === 'mdd-explore' ? explorationFiles(assignment.reads) : applyScopeFiles(this.directory, assignment.scope).reads;
    const exact = (value: unknown): string => {
      if (typeof value !== 'string' || !value || /[\x00-\x1f]|^[\\/]{2}|:\/\//.test(value) ||
          value.split(/[\\/]/).includes('..')) throw new Error('Read-only query path cannot be bounded safely.');
      const path = isAbsolute(value) ? resolve(value) : resolve(this.directory, value);
      if (!files.includes(path)) throw new Error('Read-only query exceeds its declared file scope.');
      return path;
    };
    if (tool === 'read') {
      const args = objectWithKeys(input, 'native read', ['path', 'offset', 'limit']);
      const path = exact(args.path);
      for (const key of ['offset', 'limit']) if (args[key] !== undefined && (!Number.isInteger(args[key]) || (args[key] as number) < 0))
        throw new Error('Unknown native read paging schema.');
      // Native read can load nested AGENTS.md without another tool hook. Those reads must also
      // be declared. External reads skip discovery and retain native external_directory checks.
      const root = resolve(this.directory);
      const inside = relative(root, path);
      if (!inside.startsWith('..') && !isAbsolute(inside)) for (let dir = dirname(path); dir !== root; dir = dirname(dir)) {
        const instructions = join(dir, 'AGENTS.md');
        if (existsSync(instructions) && instructions !== path && !files.includes(instructions))
          throw new Error('Native instruction discovery exceeds the declared read scope.');
      }
      return structuredClone(assignment);
    }
    if (tool === 'grep') {
      const args = objectWithKeys(input, 'native grep', ['pattern', 'path', 'include', 'literal', 'caseSensitive', 'limit']);
      exact(args.path);
      if (typeof args.pattern !== 'string' || !args.pattern || args.pattern.startsWith('-') || /[\x00-\x1f]/.test(args.pattern) ||
          args.include !== undefined || args.literal !== true || args.caseSensitive !== undefined && typeof args.caseSensitive !== 'boolean' ||
          args.limit !== undefined && (!Number.isInteger(args.limit) || (args.limit as number) < 1))
        throw new Error('Native grep query cannot be bounded safely; use literal search on one declared file.');
      return structuredClone(assignment);
    }
    // Native glob walks a directory; no directory footprint is authorized by exact-file metadata.
    throw new Error(`Read-only worker denies native ${tool}; only scoped read and literal file grep are supported.`);
  }
}
