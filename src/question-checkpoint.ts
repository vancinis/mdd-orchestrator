import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { LocalFiles } from './local-files.js';
import { objectWithKeys, ValidationError } from './validation.js';
import type { QuestionEnvelope } from './preflight.js';
import type { Phase } from './policy.js';
import { parsePartialAnswers } from './preflight.js';
import type { Answers } from './policy.js';

export const QUESTION_CHECKPOINT_VERSION = 1;
export const QUESTION_CHECKPOINT_BYTES = 160000;
/** Clarifications pending at once: new ones plus deferrals re-offered at the same boundary. */
export const CLARIFICATIONS_MAX = 16;
/** Answer history kept with the record; older answers already travelled to the run as context. */
export const CLARIFICATION_ANSWERS_MAX = 64;
/** One native interaction: preflight fields, startup doubts and the note, or every clarification. */
const QUESTIONS_MAX = 24;
/** A multi-choice answer may add the user's own words to every option; anything past this is not an answer. */
const SELECTIONS_MAX = 64;
type Kind = 'preflight' | 'approval' | 'change' | 'clarification' | 'route' | 'risk-recovery';
/**
 * A question the coordinator (or a phase, through it) needs the user to decide. `header` is the
 * short topic shown above it, `why` says what depends on the answer, `multiple` allows several
 * choices, and `note` marks the free-form note offered with preflight, which has no delegation.
 */
export type Clarification = {
  question: string; header?: string; why?: string;
  options: { label: string; description: string; recommended?: boolean }[];
  multiple?: boolean; deferrable?: boolean; note?: boolean;
};
export type QuestionRecord = {
  version: 1; parent: string; sequence: number; runID?: string;
  requirements: string; userMessageID?: string; known: Partial<Answers>; context?: { label: string; content: string };
  checkpoint?: { sequence: number; digest: string };
  /**
   * The run (and its settled state) whose durable writer this issued question holds. risk-ready
   * and risk-blocked are the two settled risk-stop boundaries, reserved exactly like a phase's
   * own ready/blocked; risk-await-result is never a settled reservation boundary.
   */
  reservation?: { runID: string; stable: 'ready' | 'await-approval' | 'blocked' | 'complete' | 'risk-ready' | 'risk-blocked' };
  state: 'prepared' | 'pending' | 'answered' | 'cancelled' | 'settled' | 'withdrawn';
  /**
   * `fields` counts the leading preflight-field questions of a preflight envelope; the questions
   * after them are clarifications (startup doubts and the note). Absent means all are fields.
   */
  slot: { kind: Kind; phase?: Phase; requirements?: string; fields?: number; args: QuestionEnvelope };
  clarifications: Clarification[]; deferred: Clarification[];
  clarificationAnswers: { question: string; answer: string; phase: Phase; disposition: 'answered' | 'deferred' }[];
  callID?: string; answer?: string[][];
  retiredCalls?: string[];
};

const PHASES = ['mdd-explore', 'mdd-plan', 'mdd-propose', 'mdd-spec', 'mdd-design', 'mdd-tasks', 'mdd-apply', 'mdd-verify'];
/** Clarification prose is nonempty, with size checked on the whole record, not each field. */
function text(value: unknown, max?: number): value is string {
  return typeof value === 'string' && !!value.trim() && (max === undefined || Buffer.byteLength(value) <= max);
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new ValidationError('Invalid native question record.');
  return value;
}
/**
 * Questions from `openFrom` on are clarifications: their prose has no individual ceiling, they may
 * allow several choices, and the user's own words answer them. Every earlier question maps to an
 * exact token, so it stays bounded and single-choice.
 */
function envelope(value: unknown, kind: Kind, fields: unknown): { args: QuestionEnvelope; openFrom: number } {
  const item = objectWithKeys(value, 'question envelope', ['questions']);
  const questions = array(item.questions, QUESTIONS_MAX);
  if (!questions.length) throw new ValidationError('Empty native question envelope.');
  let openFrom = kind === 'clarification' ? 0 : questions.length;
  if (fields !== undefined) {
    if (kind !== 'preflight' || !Number.isSafeInteger(fields) || (fields as number) < 0 || (fields as number) > questions.length) throw new ValidationError('Invalid preflight field count.');
    openFrom = fields as number;
  }
  questions.forEach((raw, index) => {
    const open = index >= openFrom;
    const question = objectWithKeys(raw, 'native question', ['header', 'question', 'multiple', 'options']);
    if (!text(question.header, 200) || !text(question.question, open ? undefined : 4000) || typeof question.multiple !== 'boolean' ||
        (!open && question.multiple)) throw new ValidationError('Invalid native question.');
    const options = array(question.options, 8);
    if (!options.length) throw new ValidationError('Native question needs choices.');
    const labels = options.map(rawOption => {
      const option = objectWithKeys(rawOption, 'native question option', ['label', 'description']);
      if (!text(option.label, open ? undefined : 120) || !text(option.description, open ? undefined : 500)) throw new ValidationError('Invalid native question choice.');
      return option.label;
    });
    if (new Set(labels).size !== labels.length) throw new ValidationError('Duplicate native question choice.');
  });
  return { args: item as QuestionEnvelope, openFrom };
}
function clarification(value: unknown): void {
  const item = objectWithKeys(value, 'clarification', ['question', 'header', 'why', 'options', 'multiple', 'deferrable', 'note']);
  if (!text(item.question) || (item.header !== undefined && !text(item.header, 200)) || (item.why !== undefined && !text(item.why)) ||
      (['multiple', 'deferrable', 'note'] as const).some(key => item[key] !== undefined && typeof item[key] !== 'boolean')) throw new ValidationError('Invalid clarification.');
  const options = array(item.options, 6);
  if (!options.length && item.note) throw new ValidationError('Missing clarification choices.');
  for (const raw of options) {
    const option = objectWithKeys(raw, 'clarification choice', ['label', 'description', 'recommended']);
    if (!text(option.label) || !text(option.description) || (option.recommended !== undefined && typeof option.recommended !== 'boolean')) throw new ValidationError('Invalid clarification choice.');
  }
}

export function validateQuestionRecord(value: unknown): QuestionRecord {
  const item = objectWithKeys(value, 'native question record', ['version', 'parent', 'sequence', 'runID', 'requirements', 'userMessageID', 'known', 'context', 'checkpoint', 'reservation', 'state', 'slot',
    'clarifications', 'deferred', 'clarificationAnswers', 'callID', 'answer', 'retiredCalls']);
  if (item.version !== QUESTION_CHECKPOINT_VERSION || !text(item.parent, 256) ||
      !Number.isSafeInteger(item.sequence) || (item.sequence as number) < 0 ||
      Buffer.byteLength(JSON.stringify(value) ?? '') > QUESTION_CHECKPOINT_BYTES ||
      !['prepared', 'pending', 'answered', 'cancelled', 'settled', 'withdrawn'].includes(String(item.state))) throw new ValidationError('Invalid native question record.');
  const slot = objectWithKeys(item.slot, 'native question slot', ['kind', 'phase', 'requirements', 'fields', 'args']);
  if (!text(item.requirements, 12000) || (item.userMessageID !== undefined && !text(item.userMessageID, 256)) ||
      !isDeepStrictEqual(parsePartialAnswers(item.known), item.known)) throw new ValidationError('Invalid native question objective.');
  if (item.context !== undefined) {
    const context = objectWithKeys(item.context, 'native question context', ['label', 'content']);
    if (!text(context.label, 200) || !text(context.content, 96000)) throw new ValidationError('Invalid native question context.');
  }
  if (!['preflight', 'approval', 'change', 'clarification', 'route', 'risk-recovery'].includes(String(slot.kind))) throw new ValidationError('Invalid native question kind.');
  const { args, openFrom } = envelope(slot.args, slot.kind as Kind, slot.fields);
  if (slot.phase !== undefined && !PHASES.includes(String(slot.phase))) throw new ValidationError('Invalid question phase.');
  if ((slot.kind === 'approval' || slot.kind === 'clarification' || slot.kind === 'route') !== (slot.phase !== undefined) ||
      (slot.kind === 'change') !== (slot.requirements !== undefined) ||
      (slot.requirements !== undefined && !text(slot.requirements, 12000))) throw new ValidationError('Question slot does not match its kind.');
  if ((slot.kind === 'preflight') !== (item.runID === undefined) ||
      (item.runID !== undefined && !text(item.runID, 256))) throw new ValidationError('Question run binding is missing.');
  if (item.reservation !== undefined) {
    const reservation = objectWithKeys(item.reservation, 'question reservation', ['runID', 'stable']);
    if (!text(reservation.runID, 256) || (item.runID !== undefined && reservation.runID !== item.runID) ||
        !['ready', 'await-approval', 'blocked', 'complete', 'risk-ready', 'risk-blocked'].includes(String(reservation.stable)) ||
        ['prepared', 'withdrawn'].includes(String(item.state))) throw new ValidationError('Invalid question reservation.');
  }
  if (item.checkpoint !== undefined) {
    const checkpoint = objectWithKeys(item.checkpoint, 'question checkpoint binding', ['sequence', 'digest']);
    if ((item.runID === undefined && item.reservation === undefined) || !Number.isSafeInteger(checkpoint.sequence) || (checkpoint.sequence as number) < 0 ||
        typeof checkpoint.digest !== 'string' || !/^[a-f0-9]{64}$/.test(checkpoint.digest)) throw new ValidationError('Invalid question checkpoint binding.');
  }
  if (['prepared', 'withdrawn'].includes(String(item.state)) ? item.callID !== undefined || item.answer !== undefined : !text(item.callID, 256)) throw new ValidationError('Invalid native question call correlation.');
  if (item.state === 'answered') {
    const answer = array(item.answer, QUESTIONS_MAX);
    if (answer.length !== args.questions.length || answer.some((selection, index) => {
      if (!Array.isArray(selection)) return true;
      const question = args.questions[index]!;
      // A clarification may be left unanswered, answered in the user's own words, or (when it
      // allows it) answered with several choices; a token question takes exactly one listed label.
      if (index >= openFrom) return selection.length > (question.multiple ? SELECTIONS_MAX : 1) || selection.some(entry => !text(entry));
      return selection.length !== 1 || !text(selection[0], 12000) || !question.options.some(option => option.label === selection[0]);
    })) throw new ValidationError('Invalid native answer.');
  } else if (item.answer !== undefined) throw new ValidationError('Historical answer cannot authorize another question.');
  if (item.retiredCalls !== undefined) {
    const retired = array(item.retiredCalls, 64);
    if (retired.some(call => !text(call, 256)) || new Set(retired).size !== retired.length || retired.includes(item.callID)) throw new ValidationError('Invalid retired native call IDs.');
  }
  for (const raw of [...array(item.clarifications, CLARIFICATIONS_MAX), ...array(item.deferred, CLARIFICATIONS_MAX)]) clarification(raw);
  for (const raw of array(item.clarificationAnswers, CLARIFICATION_ANSWERS_MAX)) {
    const answer = objectWithKeys(raw, 'clarification answer', ['question', 'answer', 'phase', 'disposition']);
    if (!text(answer.question) || !text(answer.answer) || !PHASES.includes(String(answer.phase)) ||
        !['answered', 'deferred'].includes(String(answer.disposition))) throw new ValidationError('Invalid clarification answer.');
  }
  return structuredClone(value) as QuestionRecord;
}

/** An issued question whose outcome is not settled yet. */
export function unresolvedQuestion(record: QuestionRecord | undefined): record is QuestionRecord {
  return !!record && ['prepared', 'pending', 'answered'].includes(record.state);
}

/**
 * The only unresolved question a transfer may retire: a risk-recovery question bound to exactly
 * this run and source checkpoint (run, sequence and digest, and a reservation for the same run when
 * present). A stale, foreign or unbound record is not provably this run's own and keeps fencing.
 */
export function retirableRiskRecovery(record: QuestionRecord | undefined,
  source: { runID: string; sequence: number; dataDigest: string }): boolean {
  return unresolvedQuestion(record) && record.slot.kind === 'risk-recovery' && record.runID === source.runID &&
    record.checkpoint?.sequence === source.sequence && record.checkpoint.digest === source.dataDigest &&
    (record.reservation === undefined || record.reservation.runID === source.runID);
}

export class QuestionCheckpointStore {
  readonly #files: LocalFiles;
  constructor(root: string) { this.#files = new LocalFiles(root); }
  #name(parent: string): `.mdd/question-${string}.json` {
    if (!text(parent, 256)) throw new ValidationError('Invalid question parent.');
    return `.mdd/question-${createHash('sha256').update(parent).digest('hex')}.json`;
  }
  read(parent: string): QuestionRecord | undefined {
    try {
      const content = this.#files.read(this.#name(parent), QUESTION_CHECKPOINT_BYTES);
      if (content === undefined) return undefined;
      const record = validateQuestionRecord(JSON.parse(content));
      if (record.parent !== parent) throw new Error('Parent mismatch.');
      return record;
    } catch { throw new Error('Native question record cannot be read safely; do not ask or approve.'); }
  }
  write(parent: string, value: QuestionRecord): void {
    try {
      const record = validateQuestionRecord(value);
      if (record.parent !== parent) throw new Error('Parent mismatch.');
      this.#files.update(this.#name(parent), previous => {
        if (previous !== undefined) {
          const old = validateQuestionRecord(JSON.parse(previous));
          if (old.parent !== parent || old.sequence >= record.sequence ||
              (old.runID !== record.runID && !['answered', 'settled', 'cancelled'].includes(old.state)) ||
              (old.state === 'pending' && !['answered', 'cancelled', 'prepared'].includes(record.state)) ||
              (old.state === 'prepared' && !['prepared', 'pending', 'withdrawn'].includes(record.state)) ||
              (old.state === 'answered' && !['settled', 'prepared'].includes(record.state)) ||
              (['cancelled', 'withdrawn'].includes(old.state) && record.state !== 'prepared') ||
              (old.state === 'settled' && !['prepared', 'settled'].includes(record.state)) ||
              (['prepared', 'pending'].includes(old.state) && record.state !== 'prepared' &&
                (!isDeepStrictEqual(old.slot, record.slot) || old.runID !== record.runID ||
                  old.requirements !== record.requirements || old.userMessageID !== record.userMessageID ||
                  !isDeepStrictEqual(old.known, record.known) || !isDeepStrictEqual(old.context, record.context))) ||
              // Issuing a prepared question binds it to the checkpoint as it is now, never an older one.
              (old.state === 'prepared' && record.state !== 'prepared' && old.checkpoint && record.checkpoint &&
                record.checkpoint.sequence < old.checkpoint.sequence) ||
              // An issued question's outcome keeps exactly the binding and reservation it was issued with.
              (old.state === 'pending' && record.state !== 'prepared' &&
                (!isDeepStrictEqual(old.checkpoint, record.checkpoint) || !isDeepStrictEqual(old.reservation, record.reservation))) ||
              (old.state === 'answered' && record.state === 'settled' &&
                (!isDeepStrictEqual(old.slot, record.slot) || old.callID !== record.callID || old.runID !== record.runID)) ||
              (old.state === 'pending' && record.state === 'prepared' &&
                (old.runID !== record.runID || old.slot.kind !== record.slot.kind || old.slot.phase !== record.slot.phase ||
                  isDeepStrictEqual(old.slot.args, record.slot.args) || !record.retiredCalls?.includes(old.callID!))) ||
              (old.state === 'answered' && record.state === 'prepared' && !record.retiredCalls?.includes(old.callID!)) ||
              (old.state === 'settled' && record.state === 'settled' &&
                (!isDeepStrictEqual(old.slot, record.slot) || old.callID !== record.callID || old.runID !== record.runID)) ||
              (old.state === 'pending' && record.state !== 'prepared' && record.callID !== old.callID)) throw new Error('Question record conflict.');
        }
        return JSON.stringify(record);
      }, QUESTION_CHECKPOINT_BYTES);
      if (!isDeepStrictEqual(this.read(parent), record)) throw new Error('Question readback mismatch.');
    } catch { throw new Error('Native question durability is unconfirmed; do not ask or approve.'); }
  }
  clear(parent: string): void {
    try { this.#files.remove(this.#name(parent)); }
    catch { throw new Error('Native question record cannot be cleared.'); }
  }
  /**
   * Compare-and-delete under the record's own lock: removes the record only while it is still
   * exactly `expected`. A record answered, re-issued or replaced since `expected` was read is left
   * untouched and the call fails, so a concurrent outcome is never discarded silently.
   */
  clearIf(parent: string, expected: QuestionRecord): void {
    let changed = false;
    try {
      this.#files.update(this.#name(parent), previous => {
        const current = previous === undefined ? undefined : validateQuestionRecord(JSON.parse(previous));
        if (!current || current.parent !== parent || !isDeepStrictEqual(current, expected)) { changed = true; return previous; }
        return undefined;
      }, QUESTION_CHECKPOINT_BYTES);
    } catch { throw new Error('Native question record cannot be cleared.'); }
    if (changed) throw new Error('Native question record changed since it was read; it was not cleared.');
  }
}
