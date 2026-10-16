import { objectWithKeys, ValidationError } from './validation.js';

export type ApplyStep = { id: string; dependsOn: string[] };
export type ApplyProgress = { epoch: number; planned: ApplyStep[]; completed: string[] };

export function taskIDs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32 || Array.from(value).some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) ||
      new Set(value).size !== value.length) throw new ValidationError('Completed task IDs must be unique planned identifiers (at most 32).');
  return [...value] as string[];
}

/** Plans are already dependency-ordered; selection never guesses or reorders a broken plan. */
export function applyPlan(value: unknown): ApplyStep[] {
  if (!Array.isArray(value) || !value.length || value.length > 32) throw new ValidationError('Apply requires 1–32 planned deliverables.');
  const seen = new Set<string>();
  return Array.from(value).map(value => {
    const item = objectWithKeys(value, 'Apply step', ['id', 'dependsOn']);
    const [id] = taskIDs([item.id]);
    const dependsOn = taskIDs(item.dependsOn);
    if (seen.has(id!) || dependsOn.some(key => !seen.has(key))) throw new ValidationError('Apply plan IDs must be unique with dependencies listed earlier.');
    seen.add(id!);
    return { id: id!, dependsOn };
  });
}

export function selectedStep(progress: ApplyProgress): ApplyStep | undefined {
  const step = progress.planned.find(step => !progress.completed.includes(step.id));
  if (step && step.dependsOn.some(id => !progress.completed.includes(id))) throw new ValidationError('Apply dependencies have not completed.');
  return step;
}

export function completeStep(progress: ApplyProgress, value: unknown): ApplyProgress {
  const completed = taskIDs(value);
  const selected = selectedStep(progress);
  if (!selected || completed.length !== 1 || completed[0] !== selected.id) {
    throw new ValidationError(`Successful Apply must complete exactly its assigned task ${selected?.id ?? '(none)'}; no empty, repeated or unassigned progress is accepted.`);
  }
  return { ...structuredClone(progress), completed: [...progress.completed, selected.id] };
}

/** The steps still owed, in plan order: what one correction pass has to close together. */
export function remainingSteps(progress: ApplyProgress): string[] {
  return progress.planned.filter(step => !progress.completed.includes(step.id)).map(step => step.id);
}

/**
 * A correction pass after failed Verify is one actor owning every finding, so it completes every
 * remaining step at once, in plan order. Partial correction earns nothing: report it as failed.
 */
export function completeRemaining(progress: ApplyProgress, value: unknown): ApplyProgress {
  const completed = taskIDs(value);
  const remaining = remainingSteps(progress);
  if (!remaining.length || completed.length !== remaining.length || completed.some((id, index) => id !== remaining[index])) {
    throw new ValidationError(`A correction pass must complete every remaining deliverable in plan order (${remaining.join(', ') || 'none'}) or report outcome failed; partial correction earns no progress.`);
  }
  return { ...structuredClone(progress), completed: [...progress.completed, ...completed] };
}
