import { createHash } from 'node:crypto';
import { LocalFiles } from './local-files.js';
import type { ArtifactRef } from './artifacts.js';
import type { Acceptance, Decision, Verification } from './acceptance.js';
import { acceptance, decisions, validatePlan } from './acceptance.js';
import { deliverables, executed, retainedVerification, verificationVersion, type VerificationVersion } from './phase-evidence.js';
import type { Concern } from './concerns.js';
import type { Check, Deliverable, Delivered, ChangedFile } from './phase-evidence.js';
import { objectWithKeys } from './validation.js';
import type { Answers, Phase } from './policy.js';
import type { Evidence } from './reporting.js';
import type { PhaseResult } from './workflow.js';

/**
 * Everything about a run lived in process memory, while its artifacts were persisted elsewhere.
 * An interrupted `mdd-apply` therefore destroyed the index that made those artifacts reachable:
 * the exploration, plan and acceptance map were on disk and unrecoverable at the same time.
 *
 * The dossier is the missing index, written to a local file so it survives the process. It is
 * deliberately NOT a resume record. After dying mid-apply MDD does not know what reached the
 * working tree, so restoring a controller would fake a continuity that does not exist. What
 * survives is evidence, exposed as read-only data, so a new run started with new consent begins
 * holding the plan instead of starting from nothing.
 *
 * The local file is the single source of truth. Engram is deliberately not the primary home:
 * memory is optional and may be off, `save()` stops at 40000 bytes, and it offers no per-session
 * search — only `readArtifact(id, title)`. Without an observation ID held locally nothing can be
 * found at all, which is precisely the circle that caused the loss.
 */
export const DOSSIER_VERSION = 1;

/**
 * Generous enough for a full seven-phase route with typical artifacts plus contextual
 * explorations and plan data, with headroom. Over-budget writes are not an error the run can see:
 * the store sheds artifact bodies first, since refs still identify what was produced.
 */
export const DOSSIER_MAX_BYTES = 400000;

/** Discarded on purpose. Each entry names why restoring it would be wrong, not merely costly. */
export type PriorArtifact = { ref: ArtifactRef; content?: string };
export type PriorContext = { explorationID: string; outcome: 'passed' | 'failed'; summary: string; concerns: Concern[]; artifact: PriorArtifact };
/** `typed` marks an answer the user gave in their own words (in the form, or in a chat message), checked against them. */
export type PriorReceipt = { kind: 'preflight' | 'approval' | 'change' | 'clarification' | 'route' | 'risk-recovery'; phase?: Phase; callID: string; answers: string[][]; cancelled?: true;
  typed?: { source: 'form' | 'chat'; userMessageID?: string } };

export type RunDossier = {
  /** Permission to leave a failed stop, never a successful workflow transition. */
  continuation?: { kind: 'continue' | 'new-task'; userMessageID: string; userText: string;
    checkpointSequence: number; checkpointDigest: string; timestamp: number };
  verificationVersion?: VerificationVersion;
  version: typeof DOSSIER_VERSION;
  runID: string;
  parent: { sessionID: string; directory: string; worktree: string };
  userMessageID: string;
  requirements: string;
  context: { label: string; content: string; source: 'coordinator' }[];
  answers: Answers;
  route: Phase[];
  phase: Phase;
  /**
   * Transient states (`persisting-*`, `await-result`) describe operations of a process that no
   * longer exists, so they collapse here. Nothing was in flight once the process died.
   */
  lastState: 'ready' | 'blocked' | 'await-approval' | 'complete' | 'interrupted';
  results: PhaseResult[];
  evidence: Evidence;
  acceptance?: Acceptance;
  decisions: Decision[];
  planned: Deliverable[];
  verification?: Verification;
  /** Every check Verify reported, with its exit code: a failed one is evidence too. */
  executedChecks: Check[];
  changedFiles: number;
  changedList?: ChangedFile[];
  /** Apply's summary of the finished change, kept so a later reader knows what was delivered. */
  delivered?: Delivered;
  concerns: Concern[];
  artifacts: PriorArtifact[];
  contexts: PriorContext[];
  /** Consumed native call IDs. These guards only ever refuse, so carrying them over is fail-safe. */
  calls: string[];
  /** Historical record of what the user was asked. Never loaded as live consent. */
  questionReceipts: PriorReceipt[];
  usedMessages: string[];
  proposed: string[];
  /** True when artifact bodies were shed to fit the file budget; the refs still identify them. */
  artifactContentOmitted?: true;
  timestamp: number;
  /** Set only on the copy left behind by an explicit discard, which nothing reports as recoverable. */
  discardedAt?: number;
};

const TEXT = (value: unknown): boolean => typeof value === 'string';
const ARRAY = (value: unknown): boolean => Array.isArray(value);

/**
 * The file is written by this module, so validation only has to fail closed on a damaged or
 * foreign file. It never quotes the content it rejected: a corrupt dossier from one conversation
 * must not leak its text through an error message read in another.
 */
function parse(value: unknown): RunDossier {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
  const item = value as Record<string, unknown>;
  const parent = item.parent as Record<string, unknown> | undefined;
  if (item.version !== DOSSIER_VERSION || !TEXT(item.runID) || !TEXT(item.requirements) || !TEXT(item.phase) ||
      !TEXT(item.userMessageID) || typeof item.timestamp !== 'number' || !Number.isFinite(item.timestamp) ||
      !parent || typeof parent !== 'object' || !TEXT(parent.sessionID) || !TEXT(parent.directory) || !TEXT(parent.worktree) ||
      !['ready', 'blocked', 'await-approval', 'complete', 'interrupted'].includes(String(item.lastState)) ||
      ![item.context, item.route, item.results, item.decisions, item.planned, item.executedChecks, item.concerns,
        item.artifacts, item.contexts, item.calls, item.questionReceipts, item.usedMessages, item.proposed].every(ARRAY) ||
      !item.answers || typeof item.answers !== 'object' || !item.evidence || typeof item.evidence !== 'object') {
    throw new Error('shape');
  }
  const version = verificationVersion(item.verificationVersion);
  if (item.continuation !== undefined) {
    const consent = objectWithKeys(item.continuation, 'failed verification continuation',
      ['kind', 'userMessageID', 'userText', 'checkpointSequence', 'checkpointDigest', 'timestamp']);
    const last = (item.results as PhaseResult[]).at(-1);
    if (!['continue', 'new-task'].includes(String(consent.kind)) ||
        typeof consent.userMessageID !== 'string' || !consent.userMessageID.trim() || consent.userMessageID.length > 256 ||
        typeof consent.userText !== 'string' || !consent.userText.trim() || consent.userText.length > 12000 ||
        !Number.isSafeInteger(consent.checkpointSequence) || (consent.checkpointSequence as number) < 0 ||
        typeof consent.checkpointDigest !== 'string' || !/^[a-f0-9]{64}$/.test(consent.checkpointDigest) ||
        typeof consent.timestamp !== 'number' || !Number.isFinite(consent.timestamp) ||
        item.lastState !== 'blocked' || item.phase !== 'mdd-verify' || last?.phase !== 'mdd-verify' || last.outcome !== 'failed' ||
        !(item.usedMessages as string[]).includes(consent.userMessageID)) throw new Error('invalid failed verification continuation');
  }
  // Older dossiers were data-only and loosely shaped. Preserve their historical fields, but
  // reject structured evidence with a missing marker rather than silently downgrading it.
  const planned = item.planned as Deliverable[];
  const checks = item.executedChecks as Check[];
  const checked = item.verification as Verification | undefined;
  if (!version) {
    if (planned.some(step => step.checks !== undefined) || checks.some(check => check.id !== undefined) ||
        checked?.checkResults !== undefined || checked?.supplementalChecks !== undefined) throw new Error('mixed verification contract');
  } else {
    const steps = planned.length ? deliverables(planned, version) : [];
    executed(checks, version);
    const results = item.results as PhaseResult[];
    if (results.some(result => result.outcome === 'passed' && ['mdd-plan', 'mdd-tasks'].includes(result.phase)) && !steps.length)
      throw new Error('missing held plan');
    if (results.some(result => result.outcome === 'passed' && ['mdd-plan', 'mdd-spec'].includes(result.phase)) && !item.acceptance)
      throw new Error('missing earned acceptance');
    if (checks.length && !checked) throw new Error('execution evidence has no verification');
    if (item.acceptance !== undefined) decisions(item.decisions, acceptance(item.acceptance));
    else if ((item.decisions as Decision[]).length) throw new Error('decisions have no acceptance');
    if (steps.length || checked) {
      const accepted = acceptance(item.acceptance);
      const choices = decisions(item.decisions, accepted);
      validatePlan(accepted, choices, steps);
      if (checked) {
        const read = retainedVerification(checked, checks, { accepted, choices, planned: steps, verificationVersion: version });
        if ((item.results as PhaseResult[]).filter(result => result.phase === 'mdd-verify').at(-1)?.outcome === 'passed' && !read.matched)
          throw new Error('inconsistent verification outcome');
      }
    }
    if ((item.results as PhaseResult[]).some(result => result.phase === 'mdd-verify') && !checked) throw new Error('missing verification');
  }
  return item as unknown as RunDossier;
}

/**
 * Share of the 46000-byte tool budget a preserved run may occupy. Above it the artifact bodies
 * are dropped from the *view* only: the file keeps them, so nothing is lost by reporting less.
 */
export const DOSSIER_STATUS_BYTES = 30000;

/**
 * The read-only projection of a preserved run. `capability: 'data-only'` is the whole contract:
 * every ref here is a diagnostic identifier, never a live artifact capability, and nothing in it
 * authorizes a phase. `questionReceipts` is history — what the user was once asked — and must
 * never be loaded into a live intake's receipts, where the call IDs act as anti-reuse guards.
 */
export function priorRunView(dossier: RunDossier, file: string): Record<string, unknown> {
  const base = {
    capability: 'data-only' as const, file, runID: dossier.runID, preservedAt: dossier.timestamp,
    requirements: dossier.requirements, providedContext: dossier.context, answers: dossier.answers,
    route: dossier.route, phase: dossier.phase, lastState: dossier.lastState, results: dossier.results,
    evidence: dossier.evidence, acceptance: dossier.acceptance, decisions: dossier.decisions,
    planned: dossier.planned, verification: dossier.verification, executedChecks: dossier.executedChecks,
    ...(dossier.verificationVersion ? { verificationVersion: dossier.verificationVersion } : {}),
    verificationEvidence: dossier.verificationVersion ? 'Structured actor-reported evidence; execution is not independently attested.' : 'Legacy command-based evidence; requiredness and execution identity were not recorded.',
    changedFiles: dossier.changedFiles, delivered: dossier.delivered, concerns: dossier.concerns, contexts: dossier.contexts,
    ...(dossier.continuation ? { continuation: dossier.continuation } : {}),
    artifacts: dossier.artifacts, questionReceipts: dossier.questionReceipts,
    ...(dossier.artifactContentOmitted ? { artifactContentOmitted: true as const } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(base) ?? '') <= DOSSIER_STATUS_BYTES) return base;
  const reduced = { ...base, artifactContentOmitted: true as const,
    artifacts: base.artifacts.map(item => ({ ref: item.ref })),
    contexts: base.contexts.map(item => ({ ...item, artifact: { ref: item.artifact.ref } })) };
  if (Buffer.byteLength(JSON.stringify(reduced) ?? '') <= DOSSIER_STATUS_BYTES) return reduced;
  // Still over budget: the larger context entries this view now allows are the remaining cost, so
  // they are reduced to a label and byte count rather than dropped from the view silently.
  return { ...reduced, providedContext: reduced.providedContext.map(item => ({ label: item.label, bytes: Buffer.byteLength(item.content) })) };
}

export class RunDossierStore {
  readonly #files: LocalFiles;
  constructor(root: string) { this.#files = new LocalFiles(root); }

  #name(parent: string): `.mdd/run-${string}.json` {
    return `.mdd/run-${createHash('sha256').update(parent).digest('hex')}.json`;
  }

  #discarded(parent: string): `.mdd/run-${string}.json` {
    return `.mdd/run-${createHash('sha256').update(parent).digest('hex')}.discarded.json`;
  }

  /** The local file backing a conversation, so a report can point the user at the real source. */
  name(parent: string): string { return this.#name(parent); }

  #continued(parent: string, runID: string): `.mdd/run-${string}.json` {
    return `.mdd/run-${createHash('sha256').update(JSON.stringify([parent, runID])).digest('hex')}.continued.json`;
  }

  readContinued(parent: string, runID: string): RunDossier | undefined {
    const text = this.#files.read(this.#continued(parent, runID), DOSSIER_MAX_BYTES);
    if (text === undefined) return undefined;
    const entry = parse(JSON.parse(text));
    if (!entry.continuation || entry.runID !== runID || entry.parent.sessionID !== parent) throw new Error('Continued run binding differs.');
    return entry;
  }

  /** Strict preservation precedes ownership retirement. Unlike discard, failure must propagate. */
  archiveContinuation(parent: string, dossier: RunDossier): { file: string; runID: string } {
    const entry = parse(dossier);
    if (!entry.continuation || entry.parent.sessionID !== parent) throw new Error('Missing continuation provenance.');
    const file = this.#continued(parent, entry.runID);
    const text = JSON.stringify(entry);
    this.#files.update(file, () => text, DOSSIER_MAX_BYTES);
    if (JSON.stringify(this.readContinued(parent, entry.runID)) !== text) throw new Error('Continuation archive readback differs.');
    // Keep the latest failed target discoverable until a fresh run replaces this live index.
    this.#files.update(this.#name(parent), () => text, DOSSIER_MAX_BYTES);
    if (JSON.stringify(this.read(parent)) !== text) throw new Error('Continuation index readback differs.');
    return { file, runID: entry.runID };
  }

  read(parent: string): RunDossier | undefined {
    try {
      const text = this.#files.read(this.#name(parent), DOSSIER_MAX_BYTES);
      return text === undefined ? undefined : parse(JSON.parse(text));
    } catch {
      throw new Error('A preserved run record exists for this conversation but cannot be read safely. Do not assume prior work was lost or completed; inspect the .mdd directory, and use mdd_reset to discard it.');
    }
  }

  /**
   * The newest live records across every conversation of this workspace, at most `limit` files.
   * A conversation only ever read its own record, so a new conversation asked to "continue issue
   * #433" saw nothing at all while the run that had already planned it sat one file away. Damaged
   * or foreign files are skipped without quoting them, exactly as `read` refuses to.
   */
  recent(limit: number): { file: string; dossier: RunDossier }[] {
    const found: { file: string; dossier: RunDossier }[] = [];
    for (const { name } of this.#files.runRecords().slice(0, Math.max(0, limit))) {
      try {
        const text = this.#files.read(name, DOSSIER_MAX_BYTES);
        if (text !== undefined) {
          const dossier = parse(JSON.parse(text));
          if (!dossier.continuation) found.push({ file: name, dossier });
        }
      } catch { /* Another conversation's unreadable record is not this conversation's problem. */ }
    }
    return found;
  }

  /** Explicit discard. Preserved evidence never keeps a conversation occupied once the user clears it. */
  clear(parent: string): void { this.#files.remove(this.#name(parent)); }

  /**
   * Freeing the conversation is not the same as destroying what it produced. The record is moved
   * aside instead of deleted: nothing reports a set-aside run as recoverable, so a new objective
   * starts clean, while a user who discarded a run after forty minutes of exploration can still
   * be pointed at their own plan. One slot per conversation, so a later discard replaces it and
   * the directory never grows with every reset.
   */
  discard(parent: string, now: number): { file: string; runID: string } | undefined {
    let moved: { file: string; runID: string } | undefined;
    try {
      const dossier = this.read(parent);
      if (dossier) {
        const name = this.#discarded(parent);
        const text = JSON.stringify({ ...dossier, discardedAt: now });
        this.#files.update(name, () => text, DOSSIER_MAX_BYTES);
        moved = { file: name, runID: dossier.runID };
      }
      // A record that cannot be read or copied must never hold up the reset that frees the
      // conversation: the live file below is still removed, and nothing claims it was preserved.
    } catch { moved = undefined; }
    this.#files.remove(this.#name(parent));
    return moved;
  }

  write(parent: string, dossier: RunDossier): void {
    const entry = parse(dossier);
    let text = JSON.stringify(entry);
    // Plan, acceptance and refs are what make a restart useful; artifact bodies are the bulk and
    // the most replaceable part, since every ref still names a record in the artifact store.
    if (Buffer.byteLength(text) > DOSSIER_MAX_BYTES) {
      text = JSON.stringify({ ...entry, artifactContentOmitted: true,
        artifacts: entry.artifacts.map(item => ({ ref: item.ref })),
        contexts: entry.contexts.map(item => ({ ...item, artifact: { ref: item.artifact.ref } })) });
    }
    this.#files.update(this.#name(parent), () => text, DOSSIER_MAX_BYTES);
  }
}
