/**
 * The status half of what the coordinator re-reads.
 *
 * Every workflow tool answers with the run's current state, and each answer replaces the one
 * before it: `mdd_status` after a settled phase, `mdd_prepare_advance` after a review,
 * `mdd_context` after a contribution. The host still replays every one of them into each later
 * model call, so a run that reads its status thirty times carries thirty snapshots of which only
 * the last is true. Measured on fifteen real coordinator conversations (1,174 model calls),
 * `mdd_status` replies alone were 44% of everything the coordinator re-sent, and the replies of
 * the other workflow tools another 15%. The compact view made each snapshot smaller; it could not
 * stop them from piling up. `src/dispatch-transcript.ts` does the same for phase prompts.
 *
 * So a status reply that a later one replaced is collapsed into a short placeholder in the
 * messages the host sends to the model. MDD's state never lived in the transcript, and the reply
 * the coordinator acts on is always the latest one, which is never touched.
 *
 * The rules that keep this safe:
 *
 * 1. Only a completed reply that parses as an MDD status (a JSON object with a string `state`)
 *    supersedes or is superseded. An error, a reply still running, or any other tool's output does
 *    neither, so a failed call never hides the last status that did succeed.
 * 2. The placeholder depends only on the reply it replaces: no counts, no positions. Once a reply is
 *    collapsed every later call sends the same bytes for it, so the provider's prefix cache keeps
 *    hitting from there on and each reply costs one cache miss, once.
 * 3. The placeholder carries nothing copyable: no task, question, dispatch handle or next action. A
 *    collapsed dispatch prompt was once replayed as the next task's prompt (see
 *    docs/opencode-adapter.md); a stale handle or question left in an old snapshot is the same trap,
 *    and collapsing removes it.
 * 4. While a restatement is pending and the latest reply had to leave the rejected text out, the
 *    most recent reply that still carries that same text stays whole: it is the document waiting to
 *    be restated.
 * 5. Nothing is mutated. Parts belong to the host; replacements are built instead.
 */

/**
 * Tools whose reply is the run's status. Tools that answer with something else — a PR body, an
 * improvement report, a knowledge record, a security task — are never collapsed by this rule.
 */
export const STATUS_REPLY_TOOLS: readonly string[] = Object.freeze([
  'mdd_adapt', 'mdd_status', 'mdd_start', 'mdd_prepare_advance', 'mdd_revisit', 'mdd_answer', 'mdd_phase_result',
  'mdd_reset', 'mdd_change_request', 'mdd_context', 'mdd_contextual_explore', 'mdd_transfer', 'mdd_transfer_recover',
]);

const SUPERSEDED_NOTE = 'Replaced by a later MDD reply in this conversation, so its text is omitted here. Any task, question or handle it carried is stale: act only on the latest MDD reply.';

type Status = Record<string, unknown>;

function bytes(text: string): number { return Buffer.byteLength(text); }

function record(value: unknown): Status | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Status : undefined;
}
const candidate = (tool: string): boolean => STATUS_REPLY_TOOLS.includes(tool) || tool === 'task' || tool === 'subagent';

/** A status reply, or undefined for anything that must neither supersede nor be superseded. */
function statusOf(tool: string, text: string): Status | undefined {
  if (!candidate(tool)) return undefined;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  const status = record(value);
  if (!status || typeof status.state !== 'string' || Object.hasOwn(status, 'superseded')) return undefined;
  if ((tool === 'task' || tool === 'subagent') &&
      (status.lane !== 'adaptive-native' || status.routingVersion !== 3 || status.registration !== 'active')) return undefined;
  return status;
}

/** What the coordinator reads instead: where the run stood then, and that it no longer does. */
export function supersededStatus(tool: string, status: Status): string {
  return JSON.stringify({
    superseded: tool,
    state: status.state,
    ...(typeof status.phase === 'string' ? { phase: status.phase } : {}),
    ...(typeof status.stage === 'string' ? { stage: status.stage } : {}),
    note: SUPERSEDED_NOTE,
  });
}

/**
 * Decides, for replies in conversation order, which ones to collapse and into what. Returns the
 * placeholder for each superseded reply and undefined for every reply that must stay as it is.
 */
export function supersededReplies(replies: readonly { tool: string; text: string }[]): (string | undefined)[] {
  const statuses = replies.map(reply => statusOf(reply.tool, reply.text));
  let latest = -1;
  for (let index = statuses.length - 1; index >= 0; index -= 1) if (statuses[index]) { latest = index; break; }
  if (latest < 0) return replies.map(() => undefined);
  // Rule 4: the latest reply names a pending report it could not carry; keep the one that did.
  let rejected = -1;
  const pending = record(statuses[latest]!.rejected);
  if (pending && typeof pending.text !== 'string' && typeof pending.textBytes === 'number') {
    for (let index = latest - 1; index >= 0; index -= 1) {
      const held = record(statuses[index]?.rejected);
      if (typeof held?.text === 'string' && bytes(held.text) === pending.textBytes &&
          (held.reason === undefined || pending.reason === undefined || held.reason === pending.reason)) { rejected = index; break; }
    }
  }
  return replies.map((reply, index) => {
    const status = statuses[index];
    if (!status || index === latest || index === rejected) return undefined;
    const stub = supersededStatus(reply.tool, status);
    return bytes(stub) < bytes(reply.text) ? stub : undefined;
  });
}

type ToolPart = { type?: unknown; tool?: unknown; state?: { status?: unknown; output?: unknown } | null };

/**
 * V1 host messages (`experimental.chat.messages.transform`): `{ info, parts }`, where a tool part
 * carries `state.output` as text. Returns how many replies were collapsed.
 */
export function collapseSupersededStatus(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  const found: { parts: unknown[]; index: number; part: ToolPart & { state: { output: string } }; tool: string; text: string }[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const parts = (message as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) continue;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index] as ToolPart | null;
      if (!part || typeof part !== 'object' || part.type !== 'tool' || typeof part.tool !== 'string' || !candidate(part.tool)) continue;
      const state = part.state;
      if (!state || typeof state !== 'object' || state.status !== 'completed' || typeof state.output !== 'string') continue;
      found.push({ parts, index, part: part as ToolPart & { state: { output: string } }, tool: part.tool, text: state.output });
    }
  }
  let collapsed = 0;
  supersededReplies(found).forEach((stub, position) => {
    if (stub === undefined) return;
    const { parts, index, part } = found[position]!;
    // A replacement rather than an edit: these parts are the host's records, not MDD's.
    parts[index] = { ...part, state: { ...part.state, output: stub } };
    collapsed += 1;
  });
  return collapsed;
}

type ResultValue = { type?: unknown; value?: unknown };
type ResultPart = { type?: unknown; name?: unknown; result?: ResultValue | null };

/** The text of a V2 tool result, or undefined when it is not plain text MDD could have written. */
function resultText(result: ResultValue | null | undefined): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  if (result.type === 'text') return typeof result.value === 'string' ? result.value : undefined;
  if (result.type === 'json') return record(result.value) ? JSON.stringify(result.value) : undefined;
  if (result.type === 'content' && Array.isArray(result.value) && result.value.length &&
      result.value.every(item => record(item)?.type === 'text' && typeof record(item)!.text === 'string'))
    return result.value.map(item => (item as { text: string }).text).join('\n');
  return undefined;
}

/** The same placeholder in the shape the result arrived in, so the host serializes it unchanged. */
function resultStub(result: ResultValue, stub: string): ResultValue {
  if (result.type === 'json') return { ...result, value: JSON.parse(stub) };
  if (result.type === 'content') return { ...result, value: [{ type: 'text', text: stub }] };
  return { ...result, value: stub };
}

/**
 * V2 model messages (the session `context` hook): status replies arrive as `tool-result` parts.
 * Returns a new message list; the list and parts handed in are left exactly as they were.
 */
export function collapseSupersededStatusResults<Message>(messages: readonly Message[]): { messages: Message[]; collapsed: number } {
  const found: { message: number; part: number; result: ResultValue; tool: string; text: string }[] = [];
  messages.forEach((message, messageIndex) => {
    const content = record(message)?.content;
    if (!Array.isArray(content)) return;
    content.forEach((value, partIndex) => {
      const part = record(value) as ResultPart | undefined;
      if (!part || part.type !== 'tool-result' || typeof part.name !== 'string' || !candidate(part.name)) return;
      const text = resultText(part.result);
      if (text === undefined) return;
      found.push({ message: messageIndex, part: partIndex, result: part.result!, tool: part.name, text });
    });
  });
  const replacements = new Map<number, Map<number, ResultValue>>();
  let collapsed = 0;
  supersededReplies(found).forEach((stub, position) => {
    if (stub === undefined) return;
    const item = found[position]!;
    if (!replacements.has(item.message)) replacements.set(item.message, new Map());
    replacements.get(item.message)!.set(item.part, resultStub(item.result, stub));
    collapsed += 1;
  });
  if (!collapsed) return { messages: [...messages], collapsed };
  return {
    collapsed,
    messages: messages.map((message, messageIndex) => {
      const parts = replacements.get(messageIndex);
      if (!parts) return message;
      const content = (record(message)!.content as unknown[]).map((part, partIndex) =>
        parts.has(partIndex) ? { ...(part as object), result: parts.get(partIndex) } : part);
      return { ...(message as object), content } as Message;
    }),
  };
}
