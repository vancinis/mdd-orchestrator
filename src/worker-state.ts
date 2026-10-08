import { objectWithKeys } from './validation.js';
import { changed, executed } from './phase-evidence.js';
import type { Deliverable } from './phase-evidence.js';
import { parsePhaseReport } from './phase-report.js';
import { scopesConflict } from './worker-batch.js';
import { isDeepStrictEqual } from 'node:util';
import { explorationItems, type ExplorationWorkItem } from './worker-batch.js';
import type { CheckpointStore } from './checkpoint.js';
import type { RunOwnershipStore } from './run-ownership.js';
import type { ReadAssignment } from './worker-fence.js';

/** Durable evidence, not live handles or authorization to replay a child. */
export type WorkerMember = {
  taskID: string; state: 'ready' | 'pending' | 'settled' | 'uncertain'; callID?: string; text?: string;
};
export type WorkerState = {
  completed: { taskID: string; callID: string; text: string }[];
  batch?: { id: string; members: WorkerMember[]; blocked?: string };
};

type ReadTask = { description: string; subagent_type: string; prompt: string };
export type ExplorationRecord = {
  version: 1; id: string; ownerRunID: string; parent: string; directory: string; worktree: string;
  kind: 'main' | 'contextual'; sequence: number; state: 'ready' | 'await-result' | 'blocked' | 'aggregating' | 'settled';
  items: ExplorationWorkItem[]; workers: { enabled: true }; workerState: WorkerState;
  tasks: { taskID: string; token: string; args: ReadTask; dispatchedArgs?: ReadTask; ownerEpoch?: number }[];
  aggregate?: string;
};

export function explorationReport(text: string, callID?: string) {
  if (!text.trim()) throw new Error('Invalid exploration worker report size.');
  const result = parsePhaseReport(text, 'mdd-explore');
  if (result.phase !== undefined && result.phase !== 'mdd-explore' || result.callID !== undefined && result.callID !== callID ||
      !['passed', 'failed'].includes(String(result.outcome)) || typeof result.evidenceSummary !== 'string' ||
      !result.evidenceSummary.trim() ||
      typeof result.artifact !== 'string' || !result.artifact.trim() ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(result.artifact + result.evidenceSummary) ||
      /## Acceptance and plan links/.test(result.artifact) || executed(result.checks).length ||
      result.changes !== undefined && (!Array.isArray(result.changes) || result.changes.length))
    throw new Error('Exploration worker report is not read-only or not bound to its exact call.');
  return result;
}

/** Checkpoint data never restores live native authority or permits replay. */
export function validateExplorationRecord(value: unknown): ExplorationRecord {
  const item = objectWithKeys(value, 'exploration checkpoint', ['version', 'id', 'ownerRunID', 'parent', 'directory', 'worktree',
    'kind', 'sequence', 'state', 'items', 'workers', 'workerState', 'tasks', 'aggregate']);
  if (item.version !== 1 || !['main', 'contextual'].includes(String(item.kind)) ||
      !['ready', 'await-result', 'blocked', 'aggregating', 'settled'].includes(String(item.state)) ||
      !Number.isSafeInteger(item.sequence) || (item.sequence as number) < 0 ||
      !['id', 'ownerRunID', 'parent'].every(key => id(item[key])) ||
      !['directory', 'worktree'].every(key => typeof item[key] === 'string' && (item[key] as string).length > 0 &&
        Buffer.byteLength(item[key] as string) <= 2048 && !/[\x00-\x1f]/.test(item[key] as string)) ||
      !isDeepStrictEqual(item.workers, { enabled: true })) throw new Error('Invalid exploration checkpoint identity.');
  const items = explorationItems(item.items);
  if (items.length !== 2 || new Set(items.map(item => item.id)).size !== 2 ||
      items.some(item => item.complete !== true || item.independent !== true || item.dependsOn?.length !== 0 || !item.reads))
    throw new Error('Invalid exploration declarations.');
  if (!Array.isArray(item.tasks) || item.tasks.length !== 2) throw new Error('Invalid exploration dispatch data.');
  const tasks = item.tasks.map((value, index) => {
    const task = objectWithKeys(value, 'exploration dispatch', ['taskID', 'token', 'args', 'dispatchedArgs', 'ownerEpoch']);
    if (task.taskID !== items[index]!.id || !id(task.token) || !task.token.startsWith('mdd:dispatch:') || task.args === undefined)
      throw new Error('Invalid exploration dispatch binding.');
    for (const key of ['args', 'dispatchedArgs']) if (task[key] !== undefined) {
      const args = objectWithKeys(task[key], 'exploration task', ['description', 'subagent_type', 'prompt']);
      if (args.subagent_type !== 'mdd-explore' || typeof args.description !== 'string' || typeof args.prompt !== 'string' ||
          Buffer.byteLength(args.prompt) > 48000) throw new Error('Invalid exploration task.');
    }
    if (task.ownerEpoch !== undefined && (!Number.isSafeInteger(task.ownerEpoch) || (task.ownerEpoch as number) < 0))
      throw new Error('Invalid admitted owner epoch.');
    return task;
  });
  const state = objectWithKeys(item.workerState, 'exploration workers', ['completed', 'batch']);
  if (!Array.isArray(state.completed) || state.completed.length > 2) throw new Error('Invalid exploration evidence.');
  const calls = new Set<string>();
  let ordinal = -1;
  for (const value of state.completed) {
    const member = objectWithKeys(value, 'exploration success', ['taskID', 'callID', 'text']);
    const index = items.findIndex(item => item.id === member.taskID);
    if (index <= ordinal || !id(member.callID) || calls.has(member.callID) || typeof member.text !== 'string' ||
        explorationReport(member.text, member.callID).outcome !== 'passed') throw new Error('Invalid exploration success binding.');
    ordinal = index; calls.add(member.callID);
  }
  const batch = objectWithKeys(state.batch, 'exploration batch', ['id', 'members', 'blocked']);
  if (!id(batch.id) || !Array.isArray(batch.members) || batch.members.length !== 2 ||
      batch.blocked !== undefined && !id(batch.blocked)) throw new Error('Invalid exploration batch.');
  const admitted = new Set<string>();
  for (const [index, value] of batch.members.entries()) {
    const member = objectWithKeys(value, 'exploration member', ['taskID', 'state', 'callID', 'text']);
    if (member.taskID !== items[index]!.id || !['ready', 'pending', 'settled', 'uncertain'].includes(String(member.state)) ||
        member.state === 'ready' && (member.callID !== undefined || tasks[index]!.dispatchedArgs !== undefined) ||
        member.state !== 'ready' && (!id(member.callID) || admitted.has(member.callID) || tasks[index]!.dispatchedArgs === undefined) ||
        member.text !== undefined && (typeof member.text !== 'string' || !explorationReport(member.text, member.callID as string)))
      throw new Error('Invalid exploration member binding.');
    if (member.callID) admitted.add(member.callID as string);
    const success = state.completed.find(value => (value as { taskID: string }).taskID === member.taskID) as
      { taskID: string; callID: string; text: string } | undefined;
    if (success && (member.state !== 'settled' || member.callID !== success.callID || member.text !== success.text))
      throw new Error('Exploration success contradicts its exact settled member.');
    if (member.state === 'settled' && typeof member.text !== 'string') throw new Error('Settled exploration needs its durable member outcome.');
  }
  if (['aggregating', 'settled'].includes(String(item.state)) && (state.completed.length !== 2 ||
      batch.members.some(value => (value as { state: string }).state !== 'settled') || batch.blocked || item.aggregate === undefined))
    throw new Error('Exploration aggregate cannot precede complete member settlement.');
  if (item.aggregate !== undefined && (typeof item.aggregate !== 'string' || !explorationReport(item.aggregate)))
    throw new Error('Invalid exploration aggregate.');
  return structuredClone(value) as ExplorationRecord;
}

/** Uses PW-3 member states and owner CAS; only the aggregate touches the sequential workflow. */
export class ExplorationWorkers {
  constructor(readonly record: ExplorationRecord, readonly checkpoint: CheckpointStore, readonly ownership: RunOwnershipStore) {}
  persist(): void { this.record.sequence++; this.checkpoint.writeExploration(this.record.parent, this.record); }
  status() {
    const record = this.record;
    return { state: record.state === 'aggregating' ? 'await-result' : record.state, phase: 'mdd-explore',
      explorationID: record.id, contextual: record.kind === 'contextual', workers: record.workers,
      workerProgress: { completed: record.workerState.completed.map(member => member.taskID),
        members: record.workerState.batch!.members.map(({ text: _text, ...member }) => member), blocked: record.workerState.batch!.blocked },
      tasks: ['ready', 'await-result'].includes(record.state) && !record.workerState.batch!.blocked
        ? record.tasks.filter(task => !task.dispatchedArgs).map(task => ({ ...task.args, prompt: task.token })) : undefined };
  }
  assignment(callID: string): ReadAssignment | undefined {
    const member = this.record.workerState.batch!.members.find(member => member.callID === callID);
    const task = this.record.tasks.find(task => task.taskID === member?.taskID);
    const owner = this.ownership.read(this.record.ownerRunID);
    if (!member || member.state !== 'pending' || !task || task.ownerEpoch === undefined ||
        owner?.ownerSessionID !== this.record.parent || owner.state !== 'reserved' || owner.directory !== this.record.directory ||
        owner.worktree !== this.record.worktree || owner.epoch < task.ownerEpoch || owner.callID !== this.record.workerState.batch!.id ||
        owner.workers?.find(member => member.callID === callID)?.state !== 'pending') return undefined;
    return { phase: 'mdd-explore', taskID: member.taskID, ownerEpoch: task.ownerEpoch,
      reads: structuredClone(this.record.items.find(item => item.id === member.taskID)!.reads!) };
  }
  async before(callID: string, args: unknown, inspect: () => Promise<void>, start: (batchID: string) => void): Promise<ReadTask> {
    const record = this.record, batch = record.workerState.batch!;
    const task = record.tasks.find(task => isDeepStrictEqual(args, { ...task.args, prompt: task.token }));
    if (!['ready', 'await-result'].includes(record.state) || batch.blocked || !id(callID) || !task || task.dispatchedArgs ||
        batch.members.some(member => member.callID === callID)) throw new Error('Exploration call does not match an unconsumed native handle.');
    try {
      let owner = this.ownership.read(record.ownerRunID)!;
      if (!batch.members.some(member => member.callID)) {
        owner = this.ownership.reserveWorkers(record.ownerRunID, record.parent, batch.id, record.items.map(item => item.id), owner.epoch);
        start(batch.id);
      }
      owner = this.ownership.admitWorker(record.ownerRunID, record.parent, batch.id, task.taskID, callID, owner.epoch);
      const member = batch.members.find(member => member.taskID === task.taskID)!;
      member.callID = callID; member.state = 'pending'; task.ownerEpoch = owner.epoch;
      task.dispatchedArgs = { ...task.args, prompt: `${task.args.prompt}\nNative callID=${JSON.stringify(callID)}` };
      record.state = 'await-result'; this.persist();
      await inspect();
      if (!this.assignment(callID)) throw new Error('Exploration admission lost its exact owner.');
      return structuredClone(task.dispatchedArgs);
    } catch (error) { this.block(error); throw error; }
  }
  block(error: unknown): void {
    this.record.state = 'blocked';
    this.record.workerState.batch!.blocked = String(error instanceof Error ? error.message : error).slice(0, 256);
    this.persist();
  }
  async after(callID: string, args: unknown, inspect: () => Promise<string>, stopped: () => Promise<boolean>): Promise<string | undefined> {
    const record = this.record, batch = record.workerState.batch!;
    const member = batch.members.find(member => member.callID === callID);
    const task = record.tasks.find(task => task.taskID === member?.taskID);
    if (!member || member.state !== 'pending' || !task || !isDeepStrictEqual(task.dispatchedArgs, args))
      throw new Error('Exploration result does not match a pending exact dispatch.');
    try {
      const text = await inspect();
      if (!await stopped()) throw new Error('Exploration child termination is unknown.');
      const report = explorationReport(text, callID);
      if (report.runID !== undefined && report.runID !== record.ownerRunID) throw new Error('Exploration report names another run.');
      if (!this.assignment(callID)) throw new Error('Exploration owner changed before result admission.');
      member.text = text; member.state = 'settled';
      if (report.outcome === 'passed') {
        record.workerState.completed.push({ taskID: member.taskID, callID, text });
        record.workerState.completed.sort((a, b) => record.items.findIndex(item => item.id === a.taskID) - record.items.findIndex(item => item.id === b.taskID));
      } else { record.state = 'blocked'; batch.blocked = 'A member failed; successful evidence is retained. No automatic replay.'; }
      this.persist();
      const owner = this.ownership.read(record.ownerRunID)!;
      this.ownership.settleWorker(record.ownerRunID, record.parent, batch.id, callID, owner.epoch);
    } catch (error) {
      if (member.state === 'pending') member.state = 'uncertain';
      this.block(error); throw error;
    }
    if (batch.members.some(member => member.state !== 'settled') || batch.blocked) return;
    const parts = record.items.map(item => {
      const member = record.workerState.completed.find(member => member.taskID === item.id)!;
      return { item, report: explorationReport(member.text, member.callID) };
    });
    const artifact = parts.map(({ item, report }) => `## ${item.purpose}\n\n${report.artifact}`).join('\n\n');
    record.aggregate = JSON.stringify({ outcome: 'passed', evidenceSummary: 'Completed both independent read-only investigations.', artifact,
      concerns: parts.flatMap(({ report }) => Array.isArray(report.concerns) ? report.concerns : []).slice(0, 8) });
    record.state = 'aggregating'; this.persist();
    return record.aggregate;
  }
  finish(): void {
    this.record.state = 'settled'; this.persist();
    const owner = this.ownership.read(this.record.ownerRunID)!;
    this.ownership.release(this.record.ownerRunID, this.record.parent, this.record.workerState.batch!.id, owner.epoch);
  }
}

function id(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && Buffer.byteLength(value) <= 256 && !/[\x00-\x1f]/.test(value);
}

/** Bind the existing sealed report to the task assigned by the adapter, never by actor claims. */
export function workerReport(text: string, task: Deliverable, callID: string, runID?: string) {
  if (!text.trim()) throw new Error('Invalid worker report size.');
  const result = parsePhaseReport(text, 'mdd-apply');
  if ((result.phase !== undefined && result.phase !== 'mdd-apply') ||
      (runID !== undefined && result.runID !== undefined && result.runID !== runID) ||
      (result.callID !== undefined && result.callID !== callID) || !['passed', 'failed'].includes(String(result.outcome)) ||
      typeof result.evidenceSummary !== 'string' || !result.evidenceSummary.trim() ||
      typeof result.artifact !== 'string' || !result.artifact.trim())
    throw new Error('Worker report does not match its exact assigned dispatch.');
  const files = changed(result.changes, result.noChangeReason);
  if (result.outcome === 'passed' ? !Array.isArray(result.completed) || result.completed.length !== 1 || result.completed[0] !== task.id
      : result.completed !== undefined && (!Array.isArray(result.completed) || result.completed.length !== 0))
    throw new Error('Worker completion must name exactly its assigned task on success, and none on failure.');
  if (task.parallel?.complete === true && files.paths.some(path => !task.parallel!.writes?.includes(path)))
    throw new Error('Worker report changes exceed the assigned write scope.');
  // Workers never earn independently executed checks, and commands cannot overlap a sibling.
  if (executed(result.checks).length) throw new Error('Worker checks must remain empty; Verify runs singularly.');
  return { result, files };
}

export function validateWorkerState(value: unknown, planned: readonly Deliverable[], calls: readonly string[], completed: readonly string[] = []): WorkerState {
  const item = objectWithKeys(value, 'worker state', ['completed', 'batch']);
  if (!Array.isArray(item.completed) || item.completed.length > planned.length) throw new Error('Invalid completed worker evidence.');
  const retained = (item.completed as WorkerState['completed']).map(member => member?.taskID);
  const done = new Set(completed.filter(id => !retained.includes(id))); const seenCalls = new Set<string>();
  let ordinal = -1;
  for (const entry of item.completed) {
    const member = objectWithKeys(entry, 'completed worker', ['taskID', 'callID', 'text']);
    const index = planned.findIndex(task => task.id === member.taskID);
    const task = planned[index];
    if (!task || index <= ordinal || done.has(task.id) || !id(member.callID) || !calls.includes(member.callID) ||
        seenCalls.has(member.callID) || typeof member.text !== 'string' || task.dependsOn.some(id => !done.has(id)) ||
        workerReport(member.text, task, member.callID).result.outcome !== 'passed') throw new Error('Invalid completed worker binding.');
    ordinal = index; done.add(task.id); seenCalls.add(member.callID);
  }
  if (item.batch !== undefined) {
    const batch = objectWithKeys(item.batch, 'worker batch', ['id', 'members', 'blocked']);
    if (!id(batch.id) || !Array.isArray(batch.members) || !batch.members.length || batch.members.length > 2 ||
        (batch.blocked !== undefined && (typeof batch.blocked !== 'string' || !batch.blocked.trim() || batch.blocked.length > 2000)))
      throw new Error('Invalid worker batch.');
    const tasks: Deliverable[] = [];
    for (const entry of batch.members) {
      const member = objectWithKeys(entry, 'worker member', ['taskID', 'state', 'callID', 'text']);
      const task = planned.find(task => task.id === member.taskID);
      const earned = (item.completed as WorkerState['completed']).find(entry => entry.taskID === task?.id);
      if (!task || tasks.includes(task) || (tasks.length > 0 && planned.indexOf(task) <= planned.indexOf(tasks.at(-1)!)) ||
          !['ready', 'pending', 'settled', 'uncertain'].includes(String(member.state)) ||
          task.dependsOn.some(id => !done.has(id)) ||
          (member.state === 'ready' ? member.callID !== undefined || done.has(task.id) : !id(member.callID) || !calls.includes(member.callID)) ||
          (earned && (member.state !== 'settled' || member.callID !== earned.callID || member.text !== earned.text)) ||
          (!earned && member.callID !== undefined && seenCalls.has(member.callID as string)))
        throw new Error('Invalid worker member binding.');
      if (member.callID !== undefined && tasks.some(other => (batch.members as WorkerMember[]).find(entry => entry.taskID === other.id)?.callID === member.callID))
        throw new Error('Duplicate worker call.');
      if (member.text !== undefined && (member.state !== 'settled' || typeof member.text !== 'string')) throw new Error('Unsettled worker report.');
      if (typeof member.text === 'string') {
        const report = workerReport(member.text, task, member.callID as string);
        if ((report.result.outcome === 'passed') !== !!earned) throw new Error('Worker report contradicts retained completion.');
      }
      tasks.push(task);
    }
    if (tasks.length === 2 && (scopesConflict(tasks[0]!.parallel, tasks[1]!.parallel) ||
        tasks.some(task => task.dependsOn.some(id => tasks.some(other => other.id === id))))) throw new Error('Conflicting worker batch.');
  }
  return structuredClone(value) as WorkerState;
}

/** Completion order cannot change aggregation or the held-plan ordering of durable evidence. */
export function aggregateWorkerReports(state: WorkerState, planned: readonly Deliverable[]) {
  const ordered = planned.map(task => {
    const member = state.completed.find(member => member.taskID === task.id);
    if (!member) throw new Error('Cannot aggregate an incomplete worker phase.');
    return { task, ...workerReport(member.text, task, member.callID) };
  });
  const artifact = ordered.map(({ task, result }) => `## ${task.id}\n\n${result.artifact}`).join('\n\n');
  return JSON.stringify({ outcome: 'passed', evidenceSummary: 'Completed all assigned implementation tasks.', artifact,
    changes: ordered.flatMap(({ files }) => files.files), checks: [],
    ...(ordered.every(({ files }) => !files.paths.length) ? { noChangeReason: 'Every assigned task reported that no change was needed.' } : {}) });
}
