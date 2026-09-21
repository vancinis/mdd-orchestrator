import { DISPATCH_HANDLE_PREFIX } from './phase-runner.js';

/**
 * The second half of the dispatch handle, and the half that was missing.
 *
 * `mdd_status` hands the coordinator a short token instead of the phase prompt, and
 * `PhaseRunner.before` swaps the real text in inside the hook. That stops the coordinator from
 * *writing* a 40 KB prompt: it emits a token and nothing more, which is exactly what it was for.
 *
 * What it does not stop is the coordinator *re-reading* it. The host records a tool call with the
 * arguments it executed, and the hook rewrote those arguments in place — `tool.execute.before`
 * receives `output.args` and mutates it, so the expanded prompt is what lands in the stored part.
 * From the next turn onward that part is replayed into the conversation like any other, and the
 * prompt the handle kept out of one message is re-read in every message after it. Measured on a
 * seven-phase run: ten dispatches, 272,009 characters persisted this way, re-read often enough to
 * account for about 18% of everything the coordinator spent.
 *
 * So the prompt is collapsed again on the way out, in the transform the host applies to messages
 * before they are sent to the model. The actor already received the full text when it ran; the
 * coordinator never needed it and cannot act on it now.
 *
 * Two rules keep this safe:
 *
 * 1. Only settled calls are touched. A dispatch still in flight is the one the protocol may yet
 *    compare byte for byte, so it is left exactly as the host recorded it.
 * 2. Nothing is mutated. The parts handed here belong to the host's own records; a replacement
 *    part is built instead, so collapsing what is sent to the model can never rewrite what the
 *    run is holding.
 */

/** Prompts at or below this size cost less than the note that would replace them. */
export const COLLAPSE_MIN_BYTES = 2000;

type ToolPart = {
  sessionID?: unknown; callID?: unknown;
  type?: unknown; tool?: unknown;
  state?: { status?: unknown; input?: { prompt?: unknown; subagent_type?: unknown } | null };
};

function settled(status: unknown): boolean {
  return status === 'completed' || status === 'error';
}

/**
 * What the coordinator reads instead. It names the actor, the size and the reason, so a model
 * scanning its own history finds an explanation rather than a gap it might try to fill.
 */
export function collapsedPrompt(subagent: string, bytes: number): string {
  return `${DISPATCH_HANDLE_PREFIX}delivered [MDD phase prompt for ${subagent}, ${bytes} bytes. It was delivered to the actor in full when this task ran and is omitted from the transcript afterwards, because re-reading it on every later turn is what used to fill this conversation. It is not needed again and must not be reconstructed: the phase already reported its result, and mdd_status returns the task for whatever phase is ready now.]`;
}

/**
 * Collapses settled MDD phase prompts in the messages about to be sent to the model. Returns how
 * many were collapsed, which is what the tests assert on and what a caller may log.
 */
export function collapseDispatchPrompts(messages: unknown, agents: readonly string[], ownsNative?: (sessionID: unknown, callID: unknown, args: unknown) => boolean): number {
  if (!Array.isArray(messages)) return 0;
  let collapsed = 0;
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const parts = (message as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) continue;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index] as ToolPart | null;
      if (!part || typeof part !== 'object' || part.type !== 'tool' || part.tool !== 'task') continue;
      const state = part.state;
      if (!state || typeof state !== 'object' || !settled(state.status)) continue;
      const input = state.input;
      if (!input || typeof input !== 'object') continue;
      const { prompt, subagent_type: subagent } = input;
      if (typeof prompt !== 'string' || typeof subagent !== 'string' || (!agents.includes(subagent) && !ownsNative?.(part.sessionID, part.callID, input))) continue;
      if (prompt.startsWith(DISPATCH_HANDLE_PREFIX)) continue;
      const bytes = Buffer.byteLength(prompt);
      if (bytes <= COLLAPSE_MIN_BYTES) continue;
      // A replacement rather than an edit: these parts are the host's records, not MDD's.
      parts[index] = { ...part, state: { ...state, input: { ...input, prompt: collapsedPrompt(subagent, bytes) } } };
      collapsed += 1;
    }
  }
  return collapsed;
}
