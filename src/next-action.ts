/**
 * Every MDD tool answers with a state, and for a long time turning that state into the next call
 * was the coordinator's job. The rules for doing it were written as prose in the agent definition
 * and grew a paragraph after every incident: dispatch this, but not while a question is pending;
 * restate a rejected report instead of re-running it; a phase becomes inline only once it has
 * spent all of its dispatches; a stopped run needs scope phase before scope run. That is a state
 * machine, and asking a
 * model to re-derive it from prose on every turn is asking it to be wrong occasionally — which is
 * exactly what the two worst sessions on record turned out to be.
 *
 * So the state machine moves here, and the answer travels with the state it was computed from.
 * `args` is present only when the call is literally dispatchable as written; otherwise the caller
 * is told which tool to use and what it has to compose, because inventing arguments on behalf of
 * the user is the one thing this must never do.
 *
 * It is derived, never authoritative: it adds no permission, approves nothing, and every guard
 * that refused a call before refuses it still. A coordinator that ignores it is not broken, only
 * slower. But a coordinator whose conversation was just compacted now has one field to read.
 */
/**
 * The form is how MDD asks; a person who answered in their own words anyway has still answered.
 * Said wherever an MDD question is waiting, closed or not, so that answer is recorded, not asked again.
 */
const WRITTEN = 'Only the native form records an answer. If the user answered in their own words instead, acknowledge it and show the same form once more so they can choose there.';
/**
 * The native form cannot scroll, so MDD keeps its questions short and publishes their context as
 * questionBrief. The user reads it only if the coordinator writes it in the chat before the form.
 */
const BRIEF_FIRST = 'First write questionBrief in the chat, in this same turn and exactly as it is (it is Spanish Markdown): it is the detail the short form leaves out, and the user reads it there.';
const BRIEF_REF_FIRST = 'First read questionBriefRef with the detail operation, reassemble its JSON-text pages into the brief text, and write that text in the chat, in this same turn and exactly as it is: it is the detail the short form leaves out.';
/** The read-only version-3 status call, exact as a coordinator dispatches it. */
export const ADAPTIVE_STATUS = JSON.stringify({ routingVersion: 3, kind: 'status', args: {} });

export type NextAction = {
  tool: 'question' | 'task' | 'mdd_adapt' | 'mdd_status' | 'mdd_reset';
  args?: Record<string, unknown>;
  calls?: Record<string, unknown>[];
  why: string;
};

/**
 * Read as a copy, never as a reference: the arguments handed over here are dispatched by someone
 * else, and an action that aliased the live status would let that caller edit the run's own task.
 */
function object(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try { return structuredClone(value) as Record<string, unknown>; } catch { return undefined; }
}

/**
 * The order is the protocol, not a preference. A pending question outranks everything because it
 * is the only thing the user can act on; a rejected report outranks the ready task because the
 * work behind it is already done and dispatching would pay for it twice; and the inline route
 * outranks delegation because reaching it at all means this phase already spent every dispatch it
 * had.
 */
export function nextAction(status: unknown): NextAction | undefined {
  const value = object(status);
  if (!value) return undefined;
  const state = typeof value.state === 'string' ? value.state : '';
  const nativeProtocol = value.lane === 'adaptive-native-protocol-internal';
  if (value.checkpointFailed === true) return { tool: 'mdd_status',
    why: 'Checkpoint or progress durability is unconfirmed. Inspect retained records and the blocked reason; no phase retry, result replay or dispatch is authorized. Do not clear uncertainty flags.' };
  const successor = object(value.next);
  const results = object(value.workflow)?.results;
  // Accepted context can precede every main result. It authorizes inspection of a
  // preparation failure, not a fabricated phase outcome or an automatic reset.
  const contextualPreparation = Array.isArray(results) && results.length === 0 && value.contextual === false &&
    Array.isArray(value.contexts) && value.contexts.length > 0;
  if (state === 'blocked' && value.uncertain === false && Array.isArray(results) &&
      (object(results.at(-1))?.outcome === 'passed' || contextualPreparation) &&
      successor && ['execute', 'execute-risk'].includes(String(successor.kind)))
    return { tool: 'mdd_status', why: 'Successor preparation is blocked. Present the original diagnostic and inspect its cause. Only after the cause is corrected, explicitly use mdd_reset with scope phase to prepare the successor; never replay the accepted result. A persistent oversized handoff is not fixed by retrying.' };

  if (value.lane === 'adaptive-low-internal' && ['completed', 'closed-unverified'].includes(state)) return { tool: 'mdd_status',
    why: 'Internal closure retains reported coverage, failures and assurance limits. It grants no Plan, Verify, review authority, new work, public activation or durable resume; unverified closure is not verified completion.' };

  if (value.lane === 'adaptive-low-internal' && state === 'await-selection') return { tool: 'mdd_status',
    why: 'An actorless internal selection boundary is waiting. Select only the next necessary authorized actor or prepare and submit final evidence through the guarded internal caller; no public startup, reset, mandatory Plan or Verify, review authority or automatic completion is implied.' };

  const question = object(value.question);
  if (question) {
    const present = typeof value.questionBrief === 'string' ? `${BRIEF_FIRST} ` : object(value.questionBriefRef) ? `${BRIEF_REF_FIRST} ` : '';
    return { tool: 'question', args: question,
      why: nativeProtocol ? `${present}Ask this exact native envelope once. Only the actual native before/after question hooks can supply its answer; payload approval flags or raw text cannot authorize an operation.`
        : `A native question is pending. ${present}Ask it once, exactly as it is here, and answer nothing on the user's behalf. While it is pending it is the only question the user should see. ${WRITTEN}` };
  }

  // A failed verification is the one stop whose useful next step is not the same phase again:
  // re-checking an unchanged implementation reproduces the same failure. It outranks the exhausted
  // fallback notice because the findings are recorded, whatever route produced them.
  if (state === 'blocked' && typeof value.reworkable === 'string') {
    const targets = Array.isArray(value.reworkTargets) && value.reworkTargets.length ? value.reworkTargets.join(', ') : value.reworkable;
    const reason = typeof value.reworkReason === 'string' ? ` MDD recommends ${value.reworkable}: ${value.reworkReason}` : '';
    const offer = `Present every rework target with what it means and the recommendation, and let the user choose. scope rework with exact latest userText and phase set to their choice (${targets}) sends the run back to it; the route then runs again from there.${reason}`;
    if (value.reworkFrom === 'mdd-design' || value.reworkFrom === 'mdd-tasks') return { tool: 'mdd_reset',
      why: `${value.reworkFrom} reported failure and named the held requirements it cannot satisfy (its artifact says why). Implementation must not start on that plan. ${offer} Revising the specification is also how a gap the user accepts becomes an explicit exclusion. Alternatively scope phase retries ${value.reworkFrom}. Never choose or continue automatically.` };
    return { tool: 'mdd_reset',
      why: `Verification reported failure and its findings are recorded. Follow the user's explicit choice. ${offer} Without phase, scope rework returns to mdd-apply. scope phase retries Verify; scope continue with this runID and exact latest userText preserves the failed result and releases the stop without PASS. Verify has no next phase. For a clear new objective, use a fresh mdd_adapt entry with the exact latest request. Never choose or continue automatically, and never treat continuation as stopped-child attestation.` };
  }

  if (state === 'continued-with-failed-verification') return { tool: 'mdd_status',
    why: 'The failed verification remains recorded and no work is authorized by releasing its stop. Follow a separately explicit request; a fresh mdd_adapt entry handles a new objective. There is no next phase to dispatch and no PASS to claim.' };

  if (value.fallbackExhausted === true) return { tool: 'mdd_status', why: 'Native fallback is exhausted. Present the blocked reason and request explicit recovery; do not automatically reset, redispatch, or perform the work inline.' };
  if (value.reportRepairExhausted === true) return { tool: 'mdd_status', why: 'Report repair is exhausted. Present the retained report and request explicit recovery; never rerun substantive work to repair its wording.' };

  const workerProgress = object(value.workerProgress);
  if (workerProgress?.blocked && Array.isArray(workerProgress.members) && workerProgress.members.some(member => {
    const item = object(member); return item && ['pending', 'uncertain'].includes(String(item.state));
  })) return { tool: 'mdd_status', why: 'A worker batch is blocked while a sibling may still run. Retain all successful evidence, wait for or explicitly stop every pending member, and never redispatch completed tasks or release only the last call.' };

  const task = object(value.task);
  if (Array.isArray(value.tasks) && value.tasks.length > 0 && value.tasks.length <= 2 && value.tasks.every(task => object(task))) {
    return { tool: 'task', calls: value.tasks.map(task => object(task)!),
      why: 'Dispatch each exact issued object once as a native foreground call. These are members of one bounded batch, not separate phases. Wait for every member; one result never releases a sibling or advances the phase.' };
  }
  if (task) {
    // A correction after a failed Verify is already chosen: by the user, or by MDD's bounded
    // automatic correction in automatic mode. Asking again only stalled the run it was meant to finish.
    const rework = object(value.rework);
    const correction = rework?.after === 'mdd-verify' && rework.target === undefined
      ? ' This is a correction pass after a failed Verify, chosen by the user or started by MDD\'s automatic correction (automatic mode only: at most two passes, each followed by a Verify that rechecks only the findings). Tell the user in a few lines what Verify found and that the correction is running, then dispatch it without asking for confirmation.' : '';
    return { tool: 'task', args: task,
      why: `This phase is ready to delegate. Call the native task tool once, foreground, with exactly this object and no extra arguments. The prompt may be a single-use MDD dispatch handle; pass it through unchanged.${correction}` };
  }

  // Failed evidence of completed work carries its own bounded correction rule; it comes first.
  const correction = object(value.correction);
  if (value.lane === 'adaptive-native' && typeof correction?.instruction === 'string') return { tool: 'mdd_adapt',
    why: `Evidence failed for completed work. ${correction.instruction} Use the published select repair descriptor exactly; when the user chooses to stop, close unverified with every remaining gap as an explicit limit.` };
  if (value.lane === 'adaptive-native') return { tool: 'mdd_adapt',
    why: 'Read workspaceRuns for relevant existing work before fresh entry; do not start a fresh entry for continuation. Use the published version-3 operation descriptors, entryGuide and exact input/detail references. Compose only required data; never invent identity, preferences, approval, stopped proof or dispatch authority. When an operation is refused, correct exactly what the refusal names and retry. Closed work stays closed; entry requires a genuine native user request in this conversation, answered from the current turn.' };

  // Its explicit internal next/input contract owns continuation. There is no public adapter yet.
  if (nativeProtocol) return undefined;

  if (value.lane === 'adaptive-low-internal') return { tool: 'mdd_status',
    why: 'An internal adaptive actor is authorized or in flight. Wait for its exact stopped-child receipt; never enter fixed-phase reset, redispatch, start or complete automatically.' };

  // What OpenCode says about a subagent that never reported, when status could ask it.
  const liveness = object(value.liveness);
  const verdict = typeof liveness?.verdict === 'string' ? liveness.verdict : undefined;
  const attest = 'If the user says the subagent is stopped or was interrupted, call mdd_reset with userText set to their exact latest message; MDD stops it through OpenCode when it can and releases it.';

  // An interrupted attempt is released with scope phase: it restores the run, keeps every phase
  // already recorded and readies the interrupted one again. Scope run threw all of that away,
  // which is how "it was interrupted, continue" used to end in a fresh preflight and a second
  // exploration and plan. It stays the fallback only for a run that cannot be restored.
  const keep = 'Scope phase keeps the run: completed phases are not repeated and no new preflight is asked. Inspect partial changes before the phase runs again. Only if MDD refuses scope phase because the run cannot be restored, scope run discards it (its evidence is preserved) and a new objective needs a new start.';
  if (state === 'recovery-blocked') {
    if (verdict === 'running') return { tool: 'mdd_status',
      why: 'A previous attempt here never reported an outcome and OpenCode still reports its subagent busy. Wait for it or stop it in OpenCode, then read mdd_status again. Never reset or start new work while it runs.' };
    if (verdict === 'stopped') return { tool: 'mdd_reset', args: { scope: 'phase' },
      why: `A previous attempt here never reported an outcome, and OpenCode confirms its subagent stopped. ${keep}` };
    return { tool: 'mdd_reset',
      why: `A previous attempt here never reported an outcome, so it is not resumed automatically. When the user says it was interrupted or stopped (for example "te interrumpí, continúa"), call mdd_reset with scope phase and userText set to their exact latest message; MDD stops it through OpenCode when it can and releases it. ${keep}` };
  }

  if (state === 'await-result' && verdict === 'stopped') {
    return { tool: 'mdd_reset', args: { scope: 'phase' },
      why: 'The dispatched subagent never reported, and OpenCode confirms it stopped. Scope phase releases that attempt and keeps the run; inspect partial changes before the phase runs again.' };
  }
  if (state === 'await-result' && verdict === 'unknown') {
    return { tool: 'mdd_status',
      why: `The dispatched subagent has not reported and OpenCode cannot confirm whether it stopped. Never redispatch it while it may run. ${attest} Use scope phase to keep the run.` };
  }

  if (state === 'blocked' || state === 'stopped') {
    return { tool: 'mdd_reset', args: { scope: 'phase' },
      why: `This run stopped without finishing. Scope phase releases the current attempt, and re-opens the exact question when it stopped at one, so reach for it before scope run, which throws the run away. Nothing is locked and read-only investigation stays available.${state === 'stopped' ? ` When it stopped at a question whose form was closed: ${WRITTEN}` : ''}` };
  }

  if (state === 'await-result' || state === 'await-answer') {
    return { tool: 'mdd_status',
      why: 'Work is in flight. Wait for its outcome and read mdd_status again; never redispatch a task that has not reported, and never infer an answer from prose.' };
  }

  // "Continúa el issue #433" reached a fresh start as a new objective because this was the whole
  // answer: start with the user's text. The run that had already planned that issue was recorded
  // in this workspace all along; recalling it is the step that has to come first.
  if (state === 'not-started' || state === 'recoverable') {
    const recorded = Array.isArray(value.workspaceRuns) && value.workspaceRuns.length > 0;
    const recall = `No run is active here. Before starting anything, recall where the project stands: ${recorded ? 'workspaceRuns lists earlier runs recorded in this workspace; compare the request with them, and also ' : ''}search project memory when memory tools are available (recent project context, plus the request's own terms such as issue numbers or feature names). If the request continues recorded work, it is not a new objective: do not start a fresh entry. Tell the user where that run stopped and how it resumes${recorded ? ' (its resume field: transfer only after the user\'s own message names sourceSessionID=<id> runID=<id>; source-conversation means it continues in its own conversation)' : ''}, and let them choose.`;
    const information = 'For an information-only question, answer directly or use mdd_contextual_explore instead: that route needs no run.';
    // Every implementation enters through the version-3 adaptive entry; it is the only route.
    return { tool: 'mdd_adapt', args: { payload: ADAPTIVE_STATUS },
      why: `${recall} For a new implementation request, including a precise edit, read this version-3 status (exact arguments) and follow its entry and entryGuide; when an operation is refused, correct what the refusal names and retry it. ${information}` };
  }

  return undefined;
}

/** Attaches the derived action without touching anything the tools already decided. */
export function withNextAction<Value>(status: Value): Value {
  const action = nextAction(status);
  return action ? { ...status, nextAction: action } : status;
}
