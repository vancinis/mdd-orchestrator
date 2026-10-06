import { objectWithKeys } from './validation.js';
import { changed, executed } from './phase-evidence.js';
import type { Deliverable } from './phase-evidence.js';
import { parsePhaseReport } from './phase-report.js';
import { scopesConflict } from './worker-batch.js';
import { createHash } from 'node:crypto';

/** Durable evidence, not live handles or authorization to replay a child. */
export type WorkerMember = {
  taskID: string; state: 'ready' | 'pending' | 'settled' | 'uncertain'; callID?: string; text?: string;
};
export type WorkerState = {
  completed: { taskID: string; callID: string; text: string }[];
  batch?: { id: string; members: WorkerMember[]; blocked?: string };
};

function id(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && Buffer.byteLength(value) <= 256 && !/[\x00-\x1f]/.test(value);
}

/** Bind the existing sealed report to the task assigned by the adapter, never by actor claims. */
export function workerReport(text: string, task: Deliverable, callID: string, runID?: string) {
  if (!text.trim() || Buffer.byteLength(text) > 20000) throw new Error('Invalid worker report size.');
  const result = parsePhaseReport(text, 'mdd-apply');
  if ((result.phase !== undefined && result.phase !== 'mdd-apply') ||
      (runID !== undefined && result.runID !== undefined && result.runID !== runID) ||
      (result.callID !== undefined && result.callID !== callID) || !['passed', 'failed'].includes(String(result.outcome)) ||
      typeof result.evidenceSummary !== 'string' || !result.evidenceSummary.trim() || result.evidenceSummary.length > 2000 ||
      typeof result.artifact !== 'string' || !result.artifact.trim() || Buffer.byteLength(result.artifact) > 16000)
    throw new Error('Worker report does not match its exact assigned dispatch.');
  const files = changed(result.changes, result.noChangeReason);
  if (task.parallel?.complete === true && files.paths.some(path => !task.parallel!.writes?.includes(path)))
    throw new Error('Worker report changes exceed the assigned write scope.');
  // Workers never earn independently executed checks, and commands cannot overlap a sibling.
  if (executed(result.checks).length) throw new Error('Worker checks must remain empty; Verify runs singularly.');
  return { result, files };
}

export function validateWorkerState(value: unknown, planned: readonly Deliverable[], calls: readonly string[]): WorkerState {
  const item = objectWithKeys(value, 'worker state', ['completed', 'batch']);
  if (!Array.isArray(item.completed) || item.completed.length > planned.length) throw new Error('Invalid completed worker evidence.');
  const done = new Set<string>(); const seenCalls = new Set<string>();
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
  const full = ordered.map(({ task, result }) => `## ${task.id}\n\n${result.artifact}`).join('\n\n');
  const artifact = Buffer.byteLength(full) <= 16000 ? full : ordered.map(({ task, result }) =>
    `## ${task.id}\n\n${String(result.evidenceSummary).slice(0, 200)}\n\nComplete member evidence is retained in the checkpoint; artifact sha256=${createHash('sha256').update(String(result.artifact)).digest('hex')}.`).join('\n\n');
  return JSON.stringify({ outcome: 'passed', evidenceSummary: 'Completed all assigned implementation tasks.', artifact,
    changes: ordered.flatMap(({ files }) => files.files), checks: [],
    ...(ordered.every(({ files }) => !files.paths.length) ? { noChangeReason: 'Every assigned task reported that no change was needed.' } : {}) });
}
