/**
 * OpenCode truncates a tool result near 51200 bytes and saves the remainder to a file the
 * coordinator can no longer copy verbatim. `task` and `question` are the only fields the
 * protocol requires byte-for-byte, so a truncated status silently destroys delegation: the
 * coordinator cannot satisfy the `isDeepStrictEqual` check in PhaseRunner.before and falls back
 * to doing the phase itself. Every MDD tool serializes through this budget instead of calling
 * JSON.stringify directly, so no tool can bypass it.
 *
 * 46000 sits ~10% below the observed 51200-byte host limit, leaving room for the envelope the
 * host wraps around a tool result. A tighter budget would be worse, not safer: a phase prompt
 * may legitimately reach tens of kilobytes, so anything much lower would keep reporting a
 * problem for payloads the host can actually deliver intact.
 */
export const STATUS_BUDGET_BYTES = 46000;

/**
 * Fields the protocol depends on. They are never dropped: without them the coordinator cannot
 * dispatch, answer, recover, or tell the user what happened.
 */
export const STATUS_PROTECTED_FIELDS: readonly string[] = Object.freeze([
  'task', 'brief', 'question', 'state', 'phase', 'next', 'mode', 'reason', 'runID', 'sessionID',
  'runtime', 'questionReceipts', 'recovery', 'pendingStart', 'notice', 'provenance', 'reset',
  'evidence', 'coverage', 'recoverable',
]);

/**
 * Fixed degradation order, most expendable first. A preserved run from a dead process goes first
 * of all: it is already bounded on its own and the local file behind it stays complete, so the
 * `reason` and `limits` that explain the recovery survive even when its body does not. History of
 * superseded runs goes before the current run's history; advisory material before plan material;
 * rendered prose before the structured data it was rendered from. Everything here is still
 * available: artifacts live in the configured store, plan data is re-reported by each phase, and
 * the next phase prompt already carries the dependency artifacts it needs.
 */
export const STATUS_DROP_ORDER: readonly string[] = Object.freeze([
  'priorRun', 'previousRuns', 'contexts', 'contextualReport', 'providedContext', 'artifacts', 'artifactAttempts', 'artifact',
  'concerns', 'report', 'planned', 'decisions', 'acceptance', 'verification', 'workflow',
]);

const OMITTED_NOTE = 'These fields were left out to keep this payload under the host output limit, so that task and question stay readable and copyable. Nothing was deleted: artifacts remain in the configured artifact store and every omitted field is still held by the run.';

for (const key of STATUS_DROP_ORDER) {
  if (STATUS_PROTECTED_FIELDS.includes(key)) throw new Error(`Status field ${key} cannot be both protected and droppable.`);
}

function bytes(text: string): number { return Buffer.byteLength(text); }

/** Serialize an MDD tool payload, degrading in a fixed order rather than letting the host truncate it. */
export function statusPayload(value: unknown): string {
  const first = JSON.stringify(value) ?? 'null';
  if (bytes(first) <= STATUS_BUDGET_BYTES || !value || typeof value !== 'object' || Array.isArray(value)) return first;
  const payload: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  const omitted: string[] = [];
  const render = () => JSON.stringify(omitted.length ? { ...payload, omitted, omittedNote: OMITTED_NOTE } : payload) ?? 'null';
  let text = first;
  for (const key of STATUS_DROP_ORDER) {
    if (bytes(text) <= STATUS_BUDGET_BYTES) break;
    if (!Object.hasOwn(payload, key) || payload[key] === undefined) continue;
    delete payload[key];
    omitted.push(key);
    text = render();
  }
  // Truncating the task would be the one failure this module exists to prevent, so an oversized
  // payload is reported as an explicit, actionable problem instead of being silently cut.
  if (bytes(text) > STATUS_BUDGET_BYTES) {
    const taskBytes = payload.task === undefined ? undefined : bytes(JSON.stringify(payload.task) ?? '');
    payload.budget = {
      bytes: bytes(text), limit: STATUS_BUDGET_BYTES, ...(taskBytes === undefined ? {} : { taskBytes }),
      problem: `This payload is ${bytes(text)} bytes after dropping every expendable field, above the ${STATUS_BUDGET_BYTES}-byte budget, so the host may truncate it and the exact ${taskBytes === undefined ? 'fields' : 'task'} may be unreadable. Nothing was truncated here. Do not reconstruct the task by hand: reduce accumulated context (contextual explorations add to every later phase prompt), or carry this phase out yourself and report it with mdd_phase_result.`,
    };
    text = render();
  }
  return text;
}
