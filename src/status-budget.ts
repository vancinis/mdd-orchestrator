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
  // The derived next call and the note explaining the dispatch handle are both small and both
  // protocol: dropping either one puts the coordinator back to deriving the state machine from
  // prose, which is the guessing these fields exist to end.
  'nextAction', 'dispatch',
  // A run restated for a conversation the host just rewrote. It is a few hundred bytes and it is
  // the only description of the run that survives losing the transcript, so it is never shed.
  'runCard', 'compacted',
  // Names actor definitions that no longer match the plugin running them. Shedding a warning
  // about following the wrong instructions would leave the run doing exactly that, silently.
  'assets',
  // Both are small and both are protocol. `resultFormat` is what a phase reported inline must
  // look like, and `reportDetail` is the detail level the user chose; dropping either one puts
  // the coordinator back to guessing, which is the failure these fields exist to end.
  'resultFormat', 'reportDetail',
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
  'concerns', 'report', 'visual', 'planned', 'decisions', 'acceptance', 'verification',
  // A rejected report is the work itself, waiting to be restated. It sheds late, because dropping
  // it turns a free restatement into re-running the phase that produced it.
  'rejected',
  // A handful of refs, and it explains why the phase prompt carries summaries instead of full
  // artifacts. Shedding it early would drop the explanation exactly in the payloads that need it.
  'handoff', 'workflow',
]);

/**
 * Droppable fields the compact view still ships. The drop order exists to survive the host output
 * limit, where the only question is size; the compact view asks a different one — what the
 * coordinator acts on — and a few fields are cheap enough that dropping them saves nothing and
 * costs the run its evidence trail.
 *
 * `rejected` is the document waiting to be restated. `report` is the rendered prose the user
 * reads when a run closes. `providedContext` and `artifacts` are already reduced to labels,
 * byte counts and refs rather than content. `handoff` is a handful of refs that explains why a
 * phase prompt carries summaries. `workflow` is the state machine itself, shipped in the
 * projected form below.
 *
 * `priorRun` is kept for a different reason, and it is the one worth stating: the compact view
 * targets what a healthy run re-reads on every turn, and a preserved run is not that. It appears
 * only after a route was lost mid-run, it is already bounded on its own, and the recovery reason
 * sends the coordinator to read it. Shedding it by default would answer a recovery with a
 * pointer to evidence the same payload had just withheld.
 *
 * Everything else in the drop order is reference material that a later phase re-reports, that
 * the artifact store still holds, or that detail="full" returns.
 */
export const STATUS_COMPACT_KEEP: readonly string[] = Object.freeze([
  'rejected', 'report', 'visual', 'providedContext', 'artifacts', 'handoff', 'workflow', 'priorRun',
]);

/**
 * Where the run has got to, without the prose of how it got there. A recorded result carries an
 * `evidenceSummary` written for a person, and every one of them is re-read on every later turn:
 * in a seven-phase run they were the single largest field in the payload. The phase and its
 * outcome are what the coordinator acts on, so the compact view keeps those and drops the rest.
 * Nothing is lost — the run still holds every summary, and detail="full" returns them.
 */
function compactWorkflow(value: unknown): { workflow: unknown; omitted: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { workflow: value, omitted: false };
  const snapshot = value as Record<string, unknown>;
  if (!Array.isArray(snapshot.results) || !snapshot.results.length) return { workflow: value, omitted: false };
  let omitted = false;
  const results = snapshot.results.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const { evidenceSummary, ...rest } = item as Record<string, unknown>;
    if (evidenceSummary !== undefined) omitted = true;
    return rest;
  });
  return { workflow: { ...snapshot, results }, omitted };
}

const OMITTED_NOTE = 'These fields were left out to keep this payload under the host output limit, so that task and question stay readable and copyable. Nothing was deleted: artifacts remain in the configured artifact store and every omitted field is still held by the run.';
const COMPACT_NOTE = 'This is the compact view: the state machine, the next call, and what that call needs. Nothing was deleted — reference material the run still holds, such as acceptance, decisions, the plan, concerns, recorded evidence summaries, run history and the inline brief, was left out because a long run re-reads every payload on every later turn, and each phase re-reports what it needs. Call mdd_status with detail="full" to get any of it, including brief when a phase is yours to carry out.';

/**
 * A brief short enough to cost less than the pointer replacing it is simply shipped. The threshold
 * is deliberately low: anything above it is a composed phase prompt, not a sentence.
 */
const BRIEF_POINTER_BYTES = 2000;

for (const key of STATUS_DROP_ORDER) {
  if (STATUS_PROTECTED_FIELDS.includes(key)) throw new Error(`Status field ${key} cannot be both protected and droppable.`);
}
for (const key of STATUS_COMPACT_KEEP) {
  if (!STATUS_DROP_ORDER.includes(key)) throw new Error(`Compact-kept status field ${key} must be droppable under budget pressure.`);
}

function bytes(text: string): number { return Buffer.byteLength(text); }

/**
 * Which view of a run a payload carries. `full` is the whole snapshot and stays the answer for a
 * coordinator that explicitly asks to inspect one; `compact` is the state machine plus what the
 * next call needs.
 *
 * The budget below already proved these fields are sheddable: it drops them whenever a payload
 * would be truncated, and the run keeps holding them either way. What it could not see is the
 * cost they carry when nothing is oversized — a status is read once but re-read on every later
 * turn, so a 40 KB snapshot returned thirteen times is paid for hundreds of times over. The
 * compact view spends the same classification on that, rather than only on the host limit.
 */
export type StatusView = 'full' | 'compact';

/** Serialize an MDD tool payload, degrading in a fixed order rather than letting the host truncate it. */
export function statusPayload(value: unknown, view: StatusView = 'full'): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value) ?? 'null';
  const payload: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  const omitted: string[] = [];
  const render = () => JSON.stringify(omitted.length
    ? { ...payload, omitted, omittedNote: view === 'compact' ? COMPACT_NOTE : OMITTED_NOTE }
    : payload) ?? 'null';
  if (view === 'compact') {
    const whole = JSON.stringify(payload) ?? 'null';
    for (const key of STATUS_DROP_ORDER) {
      if (STATUS_COMPACT_KEEP.includes(key) || !Object.hasOwn(payload, key) || payload[key] === undefined) continue;
      delete payload[key];
      omitted.push(key);
    }
    if (Object.hasOwn(payload, 'workflow') && payload.workflow !== undefined) {
      const projected = compactWorkflow(payload.workflow);
      payload.workflow = projected.workflow;
      if (projected.omitted) omitted.push('workflow.results[].evidenceSummary');
    }
    // `brief` is the whole phase prompt again, shipped once a phase becomes the coordinator's own.
    // It is protected against the budget because an inline phase cannot be carried out without it,
    // but it is needed once — to do the work — and not on every later read of a run that stays in
    // inline mode. Measured on a real seven-phase run it was 27-30 KB, four fifths of the payload,
    // re-read on every turn after the handover. The compact view names it and its size; the
    // derived next action sends the coordinator to detail="full" to fetch it.
    if (typeof payload.brief === 'string' && bytes(payload.brief) > BRIEF_POINTER_BYTES) {
      payload.briefBytes = bytes(payload.brief);
      delete payload.brief;
      omitted.push('brief');
    }
    // Declaring what was left out costs a few hundred bytes of note, which is more than a run
    // holding almost no reference material had to shed in the first place. A view that makes the
    // payload bigger is not a compact view, so that case answers with the whole thing instead.
    if (omitted.length && bytes(render()) >= bytes(whole)) {
      return bytes(whole) <= STATUS_BUDGET_BYTES ? whole : statusPayload(value, 'full');
    }
  }
  const first = render();
  if (bytes(first) <= STATUS_BUDGET_BYTES) return first;
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
