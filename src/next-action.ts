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
export type NextAction = {
  tool: 'question' | 'task' | 'mdd_start' | 'mdd_status' | 'mdd_prepare_advance' | 'mdd_phase_result' | 'mdd_reset';
  args?: Record<string, unknown>;
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

  const question = object(value.question);
  if (question) {
    return { tool: 'question', args: question,
      why: 'A native question is pending. Ask it once, exactly as it is here, and answer nothing on the user\'s behalf. While it is pending it is the only question the user should see.' };
  }

  if (state === 'review-ready') return { tool: 'mdd_prepare_advance',
    why: 'Present the finished phase and identify all necessary uncertainties before asking to advance. Supply their detailed choices together; mark a recommended choice, allow free text and agent delegation, and offer deferral only when safe. Pass [] only once none remain. This call does not approve the next phase.' };
  if (state === 'paused') return { tool: 'mdd_prepare_advance',
    why: 'The user paused without rejecting the phase. Wait for their request to resume, then prepare remaining clarifications (or []) and ask for a fresh native approval; never advance automatically.' };

  // A failed verification is the one stop whose useful next step is not the same phase again:
  // re-checking an unchanged implementation reproduces the same failure. It outranks the exhausted
  // fallback notice because the findings are recorded, whatever route produced them.
  if (state === 'blocked' && typeof value.reworkable === 'string') {
    return { tool: 'mdd_reset',
      why: `Verification reported failure and its findings are recorded. Present them and let the user choose: to correct them, call mdd_reset with scope rework and userText set to their exact latest message asking for it, which sends the run back to ${value.reworkable} with the findings; to re-check without changes, scope phase. Never choose for them.` };
  }

  if (value.fallbackExhausted === true) return { tool: 'mdd_status', why: 'Native fallback is exhausted. Present the blocked reason and request explicit recovery; do not automatically reset, redispatch, or perform the work inline.' };
  if (value.reportRepairExhausted === true) return { tool: 'mdd_status', why: 'Report repair is exhausted. Present the retained report and request explicit recovery; never rerun substantive work to repair its wording.' };

  const rejected = object(value.rejected);
  if (rejected) {
    return { tool: 'mdd_phase_result',
      why: 'The work is done and only its wording was refused. Take rejected.text, fix exactly what rejected.reason names, and send it back with mdd_phase_result. Do not re-dispatch and do not redo the work: this costs no attempt.' };
  }

  const task = object(value.task);
  if (task) {
    return { tool: 'task', args: task,
      why: 'This phase is ready to delegate. Call the native task tool once, foreground, with exactly this object and no extra arguments. The prompt may be a single-use MDD dispatch handle; pass it through unchanged.' };
  }

  const pending = object(value.pendingStart);
  if (pending && typeof pending.requirements === 'string') {
    return { tool: 'mdd_start', args: { requirements: pending.requirements },
      why: 'An earlier objective in this conversation never got past setup. Use these exact arguments only if the user is continuing that same objective; for a different goal, start from their actual latest text instead.' };
  }

  // What OpenCode says about a subagent that never reported, when status could ask it.
  const liveness = object(value.liveness);
  const verdict = typeof liveness?.verdict === 'string' ? liveness.verdict : undefined;
  const attest = 'If the user says the subagent is stopped or was interrupted, call mdd_reset with userText set to their exact latest message; MDD stops it through OpenCode when it can and releases it.';

  if (state === 'recovery-blocked') {
    return { tool: 'mdd_reset', args: { scope: 'run' },
      why: `A previous attempt here never reported an outcome, so it is not resumed automatically. Releasing it frees this conversation; the evidence it produced is preserved and is never deleted by a reset. ${verdict === 'stopped' ? 'OpenCode confirms its subagent stopped, so this reset releases it.' : verdict === 'running' ? 'OpenCode still reports its subagent busy: wait for it or stop it in OpenCode first.' : attest}` };
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
      why: 'This run stopped without finishing. Scope phase releases the current attempt, and re-opens the exact question when it stopped at one, so reach for it before scope run, which throws the run away. Nothing is locked and read-only investigation stays available.' };
  }

  if (state === 'await-result' || state === 'await-answer') {
    return { tool: 'mdd_status',
      why: 'Work is in flight. Wait for its outcome and read mdd_status again; never redispatch a task that has not reported, and never infer an answer from prose.' };
  }

  if (state === 'not-started' || state === 'recoverable') {
    return { tool: 'mdd_start',
      why: 'No run is active here. For an implementation request, call mdd_start once with requirements equal to the exact latest native user text. For an information-only question, answer directly or use mdd_contextual_explore instead: that route needs no run.' };
  }

  return undefined;
}

/** Attaches the derived action without touching anything the tools already decided. */
export function withNextAction<Value>(status: Value): Value {
  const action = nextAction(status);
  return action ? { ...status, nextAction: action } : status;
}
