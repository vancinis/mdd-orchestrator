import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyScopeFiles, scopePath, type ParallelScope } from './worker-batch.js';
import { objectWithKeys } from './validation.js';

// Neither the edited file nor an operation has a byte size of its own. A 256 KiB cap here made
// ordinary large source files impossible to edit through the scoped editor at all.
type Snapshot = { bytes: Buffer; stat: fs.Stats; text: string };
type Operation = { path: string; kind: 'create' | 'replace' | 'edit' | 'delete'; expected?: string;
  content?: string; oldString?: string; newString?: string };
const queues = new Map<string, Promise<unknown>>();

function text(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0') ||
      Buffer.from(value).toString('utf8') !== value) throw new Error('Scoped edits require exact UTF-8 text.');
  return value;
}

/** Pure schema/scope validation for the entire request, before creating even a parent or temporary. */
export function workerEdits(root: string, scope: ParallelScope, value: unknown): Operation[] {
  const args = objectWithKeys(value, 'worker edit', ['operations']);
  if (!Array.isArray(args.operations) || !args.operations.length || args.operations.length > 16)
    throw new Error('Scoped editor requires 1–16 operations.');
  const files = applyScopeFiles(root, scope);
  const operations = args.operations.map(value => {
    const op = objectWithKeys(value, 'worker edit operation', ['path', 'kind', 'expected', 'content', 'oldString', 'newString']);
    const path = scopePath(op.path);
    if (!files.writes.includes(resolve(root, path))) throw new Error('Scoped edit exceeds the assigned writes.');
    const fields = op.kind === 'create' ? ['path', 'kind', 'content'] : op.kind === 'replace' ? ['path', 'kind', 'expected', 'content'] :
      op.kind === 'delete' ? ['path', 'kind', 'expected'] : op.kind === 'edit' ? ['path', 'kind', 'oldString', 'newString'] : undefined;
    if (!fields || Object.keys(op).length !== fields.length || fields.some(key => !(key in op)))
      throw new Error('Unknown or incomplete scoped edit operation.');
    for (const key of fields.filter(key => !['path', 'kind'].includes(key))) text(op[key]);
    if (op.kind === 'edit' && !op.oldString) throw new Error('Exact-match edit requires nonempty oldString.');
    return { ...op, path } as Operation;
  });
  if (new Set(operations.map(op => op.path.toLowerCase())).size !== operations.length)
    throw new Error('One operation per exact file is required.');
  return operations;
}

function snapshot(path: string): Snapshot | undefined {
  const before = fs.lstatSync(path, { throwIfNoEntry: false });
  if (!before) return;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.mode & 0o7000)
    throw new Error('Scoped edit refuses nonregular, linked or special-mode files.');
  const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (stat.ino !== before.ino || stat.dev !== before.dev || stat.nlink !== 1)
      throw new Error('Scoped edit target changed while opening.');
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) { const n = fs.readSync(fd, bytes, size, bytes.length - size, null); if (!n) break; size += n; }
    if (size !== stat.size) throw new Error('Scoped edit target changed while reading.');
    const content = bytes.subarray(0, size);
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
    text(decoded);
    return { bytes: content, stat, text: decoded };
  } finally { fs.closeSync(fd); }
}

function same(a: Snapshot | undefined, b: Snapshot | undefined): boolean {
  return !a || !b ? a === b : a.stat.dev === b.stat.dev && a.stat.ino === b.stat.ino &&
    a.stat.mode === b.stat.mode && a.stat.mtimeMs === b.stat.mtimeMs && a.stat.ctimeMs === b.stat.ctimeMs && a.bytes.equals(b.bytes);
}

/** No shell, generic native editor, formatter, rollback, or actor-provided identity. */
export class WorkerEdit {
  constructor(readonly root: string) {}
  async execute(scope: ParallelScope, value: unknown, authorized: () => boolean): Promise<{ changed: string[] }> {
    const key = resolve(this.root), prior = queues.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(() => this.#edit(scope, value, authorized));
    queues.set(key, next);
    try { return await next; }
    finally { if (queues.get(key) === next) queues.delete(key); }
  }
  #edit(scope: ParallelScope, value: unknown, authorized: () => boolean): { changed: string[] } {
    const authority = () => { if (!authorized()) throw new Error('Scoped edit lost its exact live worker authority.'); };
    authority();
    const operations = workerEdits(this.root, scope, value);
    // Validate all existing-file preconditions and edits before ANY filesystem mutation.
    const plans = operations.map(op => {
      const path = resolve(this.root, op.path), old = snapshot(path);
      if (op.kind === 'create' ? !!old : !old) throw new Error('Scoped edit existence precondition failed.');
      if (op.expected !== undefined && old!.text !== op.expected) throw new Error('Scoped edit expected content does not match.');
      let content = op.content;
      if (op.kind === 'edit') {
        const first = old!.text.indexOf(op.oldString!);
        if (first < 0 || old!.text.indexOf(op.oldString!, first + 1) >= 0) throw new Error('Scoped edit requires exactly one match.');
        const replacement = old!.text.includes('\r\n') ? op.newString!.replace(/\r?\n/g, '\r\n') : op.newString!;
        content = old!.text.slice(0, first) + replacement + old!.text.slice(first + op.oldString!.length);
      } else if (content !== undefined && old) {
        if (old.text.includes('\r\n')) content = content.replace(/\r?\n/g, '\r\n');
        if (old.text.startsWith('\ufeff') && !content.startsWith('\ufeff')) content = '\ufeff' + content;
      }
      if (content !== undefined) text(content);
      return { op, path, old, content, temporary: undefined as string | undefined };
    });
    const changed: string[] = [];
    const failures: string[] = [];
    try {
      authority(); applyScopeFiles(this.root, scope);
      for (const plan of plans) {
        if (plan.content === undefined) continue;
        const parent = dirname(plan.path);
        // mkdir is convergent, but every ancestor is verified by the scope helper first and after.
        fs.mkdirSync(parent, { recursive: true });
        applyScopeFiles(this.root, scope); authority();
        plan.temporary = join(parent, `.mdd-worker-${randomUUID()}.tmp`);
        const fd = fs.openSync(plan.temporary, 'wx', plan.old ? plan.old.stat.mode & 0o777 : 0o644);
        try {
          if (plan.old) fs.fchmodSync(fd, plan.old.stat.mode & 0o777);
          fs.writeFileSync(fd, plan.content, 'utf8'); fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
      }
      // Human/external drift never triggers a blind rollback over newer bytes.
      for (const plan of plans) if (!same(plan.old, snapshot(plan.path))) throw new Error('Scoped edit target changed before publication.');
      for (const plan of plans) {
        authority(); applyScopeFiles(this.root, scope);
        if (!same(plan.old, snapshot(plan.path))) throw new Error('Scoped edit target changed before publication.');
        if (plan.op.kind === 'delete') fs.unlinkSync(plan.path);
        else if (plan.op.kind === 'create') fs.linkSync(plan.temporary!, plan.path);
        else fs.renameSync(plan.temporary!, plan.path);
        // Publication is retained even if removing the create's temporary link fails.
        changed.push(plan.op.path);
        if (plan.op.kind === 'create') fs.unlinkSync(plan.temporary!);
        plan.temporary = undefined;
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : 'Publication failed.');
    } finally {
      for (const plan of plans) if (plan.temporary) {
        try { fs.unlinkSync(plan.temporary); }
        catch (error) {
          failures.push(`Temporary cleanup failed for ${plan.op.path}: ${error instanceof Error ? error.message : 'Cleanup failed.'}`);
        }
      }
    }
    if (failures.length) throw new Error(`Scoped edit refused; retained changed files=${JSON.stringify(changed)}. ${failures.join(' ')}`);
    return { changed };
  }
}
