import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { acceptance, decisions, evidenceID, references, reportText, shortText, summaryText, assertNoTraceSection, checkAccounting } from './acceptance.js';
import type { Acceptance, Decision } from './acceptance.js';
import { applyPlan, taskIDs } from './apply-batches.js';
import { changed, plannedChecks, executed } from './phase-evidence.js';
import type { PlannedCheck } from './phase-evidence.js';
import { parsePhaseReport, parseRiskReport } from './phase-report.js';
import { parseFutureAssessment } from './risk.js';
import type { FutureAssessment } from './risk.js';
import { applyScopeFiles, explorationFiles, parseParallelScope, scopePath } from './worker-batch.js';
import { objectWithKeys } from './validation.js';
import { AdaptiveContinuation, continuationRequest } from './adaptive-continuation.js';
import type { ContinuationActor, ContinuationData } from './adaptive-continuation.js';
import { openQuestions } from './open-questions.js';
import type { OpenQuestion } from './open-questions.js';
import { validateQuestionRecord } from './question-checkpoint.js';
import type { QuestionRecord } from './question-checkpoint.js';
import type { QuestionEnvelope } from './preflight.js';

export type AdaptiveActor = 'mdd-explore' | 'mdd-risk' | 'mdd-plan' | 'mdd-apply' | 'mdd-verify' | ContinuationActor;
type Scope = { complete: true; reads: string[]; writes: string[] };
type SourceObligation = { id: string; description: string; paths: string[] };
type Assignment = { id: string; description: string; path: string; scenarios: string[]; decisions: string[];
  dependsOn: string[]; scope: Scope; obligations: { source: SourceObligation[]; checks: PlannedCheck[] } };
type Context = { technical: 'understood' | 'uncertain'; dependencies: 'bounded' | 'unknown'; reason: string;
  fingerprints: { path: string; digest: string | null }[] };
export type AdaptiveContract = { contractVersion: 1; objective: string; acceptance: Acceptance; exclusions: string[];
  decisions: Decision[]; productQuestions: string[]; scope: Scope; context: Context; assessment: FutureAssessment;
  assignments: Assignment[] };
export type AdaptiveSelection = { handle: string; actor: AdaptiveActor; assignmentID: string; purpose: string;
  context?: Context; repairOf?: string };
type Receipt = { id: string; actor: AdaptiveActor; assignmentID: string; purpose: string; outcome: 'passed' | 'failed';
  summary: string; artifact?: string; changes?: string[]; assessment?: FutureAssessment; failure?: string;
  callID?: string; proof?: { path: string; digest: string | null }[];
  accepted?: { fields: Record<string, unknown>; verifyContext?: VerifyContext }; questions?: OpenQuestion[] };
type VerifyContext = { snapshotID: string; checks: ReturnType<typeof executed> };
const ACTORS: readonly AdaptiveActor[] = ['mdd-explore', 'mdd-risk', 'mdd-plan', 'mdd-apply', 'mdd-verify'];
const CONTRACT_BYTES = 24000;
const ASSURANCE = 'Structured parent-reported consistency, not independent execution attestation. Local declared source bytes are bound; whole-worktree diff inventory is a reported observation, not comprehensive attestation.';
type Snapshot = { id: string; sources: { path: string; digest: string | null; content: string | null }[] };
type SourceAssessment = { id: string; paths: string[]; status: 'verified' | 'not-verified' | 'deviation'; assessment: string };
type SemanticAssessment = { status: SourceAssessment['status']; sources: string[]; checks: string[]; assessment: string };
type EvidenceReport = { snapshotID: string; readback: { acceptance: Acceptance; scope: Scope; exclusions: string[]; decisions: Decision[] };
  inventory: { path: string; disposition: 'assignment' | 'unrelated'; reason: string }[];
  exclusions: { exclusion: string; status: SourceAssessment['status']; assessment: string }[];
  sources: SourceAssessment[]; assignments: (SemanticAssessment & { assignmentID: string })[];
  scenarios: (SemanticAssessment & { requirementID: string; scenarioID: string; assignmentID: string })[];
  decisions: (SemanticAssessment & { decisionID: string })[]; checks: ReturnType<typeof executed>;
  checkResults: ReturnType<typeof checkAccounting>['checkResults']; supplementalChecks: ReturnType<typeof checkAccounting>['supplementalChecks']; limits: string[] };
export const ADAPTIVE_EVIDENCE_FIELDS = Object.freeze(['snapshotID', 'readback', 'inventory', 'exclusions', 'sources', 'assignments',
  'scenarios', 'decisions', 'checks', 'checkResults', 'supplementalChecks', 'limits'] as const);
type HistoricalChecks = { snapshot: Snapshot; checks: ReturnType<typeof executed> };
type PrerequisiteReceipt = { assignmentID: string; receiptID: string };
export type AdaptiveData = {
  contract: AdaptiveContract; context: Context; assessment: FutureAssessment;
  state: 'await-selection' | 'await-result' | 'completed' | 'closed-unverified';
  receipts: Receipt[]; completed: { assignmentID: string; fingerprints: { path: string; digest: string | null }[] }[];
  pending?: Omit<AdaptiveSelection, 'handle' | 'context'> & { dispatchPrerequisites: PrerequisiteReceipt[]; verifyContext?: VerifyContext };
  snapshot?: Snapshot; report?: EvidenceReport; matched: boolean;
  completion?: { outcome: 'verified' | 'unverified'; limits: string[] };
  repairs: number; invalidatedAssignments: string[];
  retainedProof: AdaptiveData['completed']; priorEvidence?: { snapshot: Snapshot; report: EvidenceReport; invalidatedAssignments: string[]; assignments?: Assignment[] };
  checkHistory: ReturnType<typeof executed>; historicalChecks: HistoricalChecks[];
  continuation?: ContinuationData;
  questionAnswers?: { receiptID: string; native: QuestionRecord }[];
};

/** Exact display mapping: every native option retains its original label and description. */
export function adaptiveQuestionsEnvelope(questions: OpenQuestion[], nonce: string): QuestionEnvelope {
  return { questions: questions.map((question, index) => ({ header: 'Product decision',
    question: `${question.question}\nWhy: ${question.why}${index === 0 ? ` [MDD adaptive ${nonce}]` : ''}`,
    multiple: question.multiple === true,
    options: question.options.length ? question.options.map(({ label, description }) => ({ label, description }))
      : [{ label: 'Pause', description: 'Leave this product decision unresolved.' }] })) };
}
const RESTORE = Symbol('validated adaptive data');

function entries(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error(`${label} requires at most 64 entries.`);
  return Array.from(value);
}
function verifyContext(value: unknown): VerifyContext {
  const input = objectWithKeys(value, 'frozen native Verify context', ['snapshotID', 'checks']);
  const checks = executed(input.checks, 1);
  if (Buffer.byteLength(JSON.stringify(checks)) > 48000) throw new Error('Frozen Verify command history exceeds its evidence budget.');
  return { snapshotID: shortText(input.snapshotID, 'native Verify snapshot', 100), checks };
}
function status(value: unknown): SourceAssessment['status'] {
  if (value !== 'verified' && value !== 'not-verified' && value !== 'deviation') throw new Error('Evidence needs explicit verified/not-verified/deviation status.');
  return value;
}
function exactCoverage(actual: string[], expected: string[], label: string): void {
  if (new Set(actual).size !== actual.length || actual.length !== expected.length || expected.some(id => !actual.includes(id)))
    throw new Error(`${label} must cover exactly the held links, without omissions or invented IDs.`);
}

/** How many entries a list of prose holds: exclusions, product questions, evidence or closure limits. */
const TEXTS_MAX = 16;
/** The most of one prose field a status shows: the old per-field cap, so nothing it accepted is cut. */
const STATUS_TEXT_MAX = 500;
/**
 * Prose as a status payload shows it. The fields it lands in are protected from the status budget,
 * so a status carries them bounded; the evidence readback and the stored data keep them whole.
 */
export function statusText(text: string): string {
  return text.length > STATUS_TEXT_MAX ? `${text.slice(0, STATUS_TEXT_MAX - 1)}…` : text;
}
function texts(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > TEXTS_MAX) throw new Error(`${label} requires at most ${TEXTS_MAX} entries.`);
  return Array.from(value, item => reportText(item, label));
}
/**
 * An actor's artifact, kept exactly as the actor wrote it. It has no size limit: a 12000-byte cap
 * here failed finished receipts while the lane's real bounds — its durable journal and the prompts
 * that carry earlier reports — are aggregate and are enforced where those are written.
 */
function artifactText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Receipt requires an actual nonempty artifact.');
  return assertNoTraceSection(value);
}
function objective(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 12000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))
    throw new Error('Native objective requires exact nonempty text of at most 12000 bytes without terminal controls.');
  return value;
}
function scope(value: unknown): Scope {
  const parsed = parseParallelScope(value);
  if (parsed.complete !== true || !parsed.reads || !parsed.writes) throw new Error('Adaptive scope requires a complete exact read/write footprint.');
  return parsed as Scope;
}
function paths(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 64) throw new Error('Source evidence requires 1–64 exact paths.');
  const result = Array.from(value, scopePath);
  if (new Set(result.map(path => path.toLowerCase())).size !== result.length) throw new Error('Source evidence repeats paths.');
  return result;
}
function context(value: unknown, footprint: Scope): Context {
  const input = objectWithKeys(value, 'adaptive context', ['technical', 'dependencies', 'reason', 'fingerprints']);
  if ((input.technical !== 'understood' && input.technical !== 'uncertain') || (input.dependencies !== 'bounded' && input.dependencies !== 'unknown'))
    throw new Error('Adaptive context needs explicit technical clarity and dependency understanding.');
  const expected = [...new Set([...footprint.reads, ...footprint.writes])];
  if (!Array.isArray(input.fingerprints) || input.fingerprints.length !== expected.length) throw new Error('Source fingerprints must cover the exact contract footprint.');
  const fingerprints = Array.from(input.fingerprints, value => {
    const item = objectWithKeys(value, 'source fingerprint', ['path', 'digest']);
    const path = scopePath(item.path);
    if (!expected.includes(path) || item.digest !== null && (typeof item.digest !== 'string' || !/^[a-f0-9]{64}$/.test(item.digest)))
      throw new Error('Invalid source fingerprint path or digest.');
    return { path, digest: item.digest as string | null };
  });
  if (new Set(fingerprints.map(item => item.path)).size !== expected.length) throw new Error('Source fingerprints repeat a path.');
  return { technical: input.technical, dependencies: input.dependencies,
    reason: reportText(input.reason, 'source context rationale'), fingerprints };
}

/** Reconstruct validated data, including own non-enumerable fields, before any native await. */
export function adaptiveContract(value: unknown): AdaptiveContract {
  const input = objectWithKeys(value, 'adaptive contract', ['contractVersion', 'objective', 'acceptance', 'exclusions', 'decisions',
    'productQuestions', 'scope', 'context', 'assessment', 'assignments']);
  if (input.contractVersion !== 1) throw new Error('Adaptive contractVersion must be integer 1.');
  const accepted = acceptance(input.acceptance), choices = decisions(input.decisions, accepted), footprint = scope(input.scope);
  if (!footprint.writes.length) throw new Error('Adaptive contract requires a declared bounded assignment write scope.');
  if (!Array.isArray(input.assignments) || !input.assignments.length || input.assignments.length > 32) throw new Error('Adaptive contract requires 1–32 assignments.');
  const ids = new Set<string>(), obligations = new Set<string>();
  for (const item of accepted.requirements) { ids.add(item.id); item.scenarios.forEach(scenario => ids.add(scenario.id)); }
  for (const choice of choices) {
    if (ids.has(choice.id)) throw new Error('Adaptive IDs must be globally unique.');
    ids.add(choice.id);
  }
  const scenarioIDs = accepted.requirements.flatMap(item => item.scenarios.map(scenario => scenario.id));
  const assignments = Array.from(input.assignments, value => {
    const item = objectWithKeys(value, 'adaptive assignment', ['id', 'description', 'path', 'scenarios', 'decisions', 'dependsOn', 'scope', 'obligations']);
    const id = evidenceID(item.id, 'assignment ID'), own = scope(item.scope), path = scopePath(item.path);
    if (ids.has(id)) throw new Error('Adaptive IDs must be globally unique.');
    ids.add(id);
    if (!own.writes.length || !own.writes.includes(path) || own.reads.some(path => ![...footprint.reads, ...footprint.writes].includes(path)) ||
        own.writes.some(path => !footprint.writes.includes(path))) throw new Error('Assignment scope exceeds its contract or omits its implementation target.');
    const scenarios = references(item.scenarios, 'assignment scenarios'), linked = references(item.decisions, 'assignment decisions', true);
    if (scenarios.some(id => !scenarioIDs.includes(id)) || linked.some(id => !choices.some(choice => choice.id === id))) throw new Error('Assignment references unknown acceptance or decision IDs.');
    for (const id of linked) {
      const choice = choices.find(choice => choice.id === id)!;
      if (!accepted.requirements.some(requirement => choice.requirements.includes(requirement.id) && requirement.scenarios.some(scenario => scenarios.includes(scenario.id))))
        throw new Error('Assignment decision is not applicable to its scenarios.');
    }
    const evidence = objectWithKeys(item.obligations, 'evidence obligations', ['source', 'checks']);
    if (!Array.isArray(evidence.source) || evidence.source.length > 32 || !Array.isArray(evidence.checks)) throw new Error('Invalid evidence obligations.');
    const checks = evidence.checks.length ? plannedChecks(evidence.checks, obligations) : [];
    const source = Array.from(evidence.source, value => {
      const entry = objectWithKeys(value, 'source obligation', ['id', 'description', 'paths']);
      const id = evidenceID(entry.id, 'source obligation ID'), targets = paths(entry.paths);
      if (obligations.has(id)) throw new Error('Evidence obligation ID is used more than once.');
      obligations.add(id);
      if (obligations.size > 64 || targets.some(path => ![...own.reads, ...own.writes].includes(path))) throw new Error('Source obligation exceeds its assignment scope or evidence budget.');
      return { id, description: reportText(entry.description, 'source obligation'), paths: targets };
    });
    if (!source.length && !checks.length) throw new Error('Each assignment requires source or real command evidence obligations.');
    return { id, description: reportText(item.description, 'assignment description'), path, scenarios, decisions: linked,
      dependsOn: taskIDs(item.dependsOn), scope: own, obligations: { source, checks } };
  });
  applyPlan(assignments.map(({ id, dependsOn }) => ({ id, dependsOn })));
  if (assignments.reduce((count, item) => count + item.scenarios.length, 0) > 64) throw new Error('Adaptive contract exceeds 64 scenario-to-assignment links.');
  if (scenarioIDs.some(id => !assignments.some(item => item.scenarios.includes(id))) || choices.some(choice =>
    choice.requirements.some(id => !assignments.some(item => item.decisions.includes(choice.id) &&
      accepted.requirements.find(requirement => requirement.id === id)!.scenarios.some(scenario => item.scenarios.includes(scenario.id))))))
    throw new Error('Adaptive contract omits acceptance or applicable decision coverage.');
  for (const id of obligations) if (ids.has(id)) throw new Error('Adaptive IDs must be globally unique.');
  const result: AdaptiveContract = { contractVersion: 1, objective: objective(input.objective),
    acceptance: accepted, exclusions: texts(input.exclusions, 'exclusions'), decisions: choices,
    productQuestions: texts(input.productQuestions, 'product questions'), scope: footprint,
    context: context(input.context, footprint), assessment: parseFutureAssessment(input.assessment), assignments };
  if (Buffer.byteLength(JSON.stringify(result)) > CONTRACT_BYTES) throw new Error('Adaptive contract exceeds its compact 24000-byte budget.');
  return result;
}

export function adaptiveSelection(value: unknown, contract: AdaptiveContract): AdaptiveSelection {
  const input = objectWithKeys(value, 'adaptive selection', ['handle', 'actor', 'assignmentID', 'purpose', 'context', 'repairOf']);
  if (!ACTORS.includes(input.actor as AdaptiveActor)) throw new Error('Select only Explore, Risk, Plan, Apply or Verify.');
  return { handle: shortText(input.handle, 'selection handle', 200), actor: input.actor as AdaptiveActor,
    assignmentID: evidenceID(input.assignmentID, 'assignment ID'), purpose: reportText(input.purpose, 'actor purpose'),
    ...(input.context !== undefined ? { context: context(input.context, contract.scope) } : {}),
    ...(input.repairOf !== undefined ? { repairOf: shortText(input.repairOf, 'repair receipt', 100) } : {}) };
}

/** File evidence is read locally under existing exact-file alias checks; credentials are excluded. */
function fingerprint(root: string, path: string): string | null {
  if (/(?:^|\/)(?:\.[^/]+|[^/]*(?:credential|secret|token|password)[^/]*|id_rsa|id_ed25519)(?:\/|$)/i.test(path))
    throw new Error('Credential or hidden source evidence is not admitted.');
  const absolute = resolve(root, path), stat = lstatSync(absolute, { throwIfNoEntry: false });
  if (!stat) return null;
  explorationFiles([{ root, files: [path] }]);
  if (stat.size > 256 * 1024) throw new Error('Source fingerprint exceeds the bounded file inspection budget.');
  const bytes = readFileSync(absolute), after = lstatSync(absolute);
  if (stat.ino !== after.ino || stat.dev !== after.dev || stat.size !== after.size || bytes.length !== stat.size ||
      stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs || !after.isFile() || after.isSymbolicLink() || after.nlink !== 1)
    throw new Error('Source changed during fingerprint inspection.');
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Current SHA-256 bytes of an exact footprint (null for a file that does not exist yet), under the
 * same alias and credential exclusions as every later freshness check. Used when a coordinator lets
 * the host record the sources it inspected instead of hashing them itself.
 */
export function sourceFingerprints(root: string, footprint: { reads: string[]; writes: string[] }): { path: string; digest: string | null }[] {
  return [...new Set([...footprint.reads, ...footprint.writes])].map(path => ({ path: scopePath(path), digest: fingerprint(root, path) }));
}

/** Compact actor receipts, never a Workflow, a Plan artifact, or native execution authority. */
export class AdaptiveLow {
  readonly #contract: AdaptiveContract;
  readonly #receipts: Receipt[] = [];
  readonly #completed = new Map<string, { path: string; digest: string | null }[]>();
  #context: Context;
  #assessment: FutureAssessment;
  #state: 'await-selection' | 'authorized-actor' | 'await-result' | 'completed' | 'closed-unverified' = 'await-selection';
  #snapshot: Snapshot | undefined;
  #report: EvidenceReport | undefined;
  #matched = false;
  #completion: { outcome: 'verified' | 'unverified'; limits: string[] } | undefined;
  #repairs = 0;
  #invalidatedAssignments: string[] = [];
  #retainedProof: { assignmentID: string; fingerprints: { path: string; digest: string | null }[] }[] = [];
  #priorEvidence: AdaptiveData['priorEvidence'];
  #checkHistory: ReturnType<typeof executed> = [];
  #historicalChecks: HistoricalChecks[] = [];
  #validating = false;
  #evidenceAssignments: Assignment[] | undefined;
  #continuation: AdaptiveContinuation | undefined;
  #verifyContext: VerifyContext | undefined;
  #selection: AdaptiveSelection | undefined;
  #dispatchPrerequisites: PrerequisiteReceipt[] = [];
  #handle = randomUUID();
  #questionAnswers: NonNullable<AdaptiveData['questionAnswers']> = [];
  constructor(value: unknown, readonly root: string, restoration?: typeof RESTORE) {
    this.#contract = adaptiveContract(value); this.#context = this.#contract.context; this.#assessment = this.#contract.assessment;
    applyScopeFiles(root, this.#contract.scope); if (restoration !== RESTORE) this.assertCurrent();
  }
  /** Explicit data contract: status and native dispatch capabilities are deliberately excluded. */
  serialize(): AdaptiveData {
    const pending = this.#state === 'await-result' ? this.#selection : undefined;
    return structuredClone({ contract: this.#contract, context: this.#context, assessment: this.#assessment,
      state: this.#state === 'authorized-actor' ? 'await-selection' : this.#state,
      receipts: this.#receipts, completed: [...this.#completed].map(([assignmentID, fingerprints]) => ({ assignmentID, fingerprints })),
      ...(pending ? { pending: { actor: pending.actor, assignmentID: pending.assignmentID, purpose: pending.purpose,
        ...(pending.repairOf ? { repairOf: pending.repairOf } : {}), dispatchPrerequisites: this.#dispatchPrerequisites,
        ...(this.#verifyContext ? { verifyContext: this.#verifyContext } : {}) } } : {}),
      ...(this.#snapshot ? { snapshot: this.#snapshot } : {}), ...(this.#report ? { report: this.#report } : {}), matched: this.#matched,
      ...(this.#completion ? { completion: this.#completion } : {}), repairs: this.#repairs,
      invalidatedAssignments: this.#invalidatedAssignments, retainedProof: this.#retainedProof,
      ...(this.#priorEvidence ? { priorEvidence: this.#priorEvidence } : {}), checkHistory: this.#checkHistory, historicalChecks: this.#historicalChecks,
      ...(this.#continuation ? { continuation: this.#continuation.serialize() } : {}),
      ...(this.#questionAnswers.length ? { questionAnswers: this.#questionAnswers } : {}) });
  }
  /** In-process transactional copy only. No serialized record can retain a handle or authorization. */
  copy(): AdaptiveLow {
    const low = AdaptiveLow.restore(this.serialize(), this.root, false);
    low.#state = this.#state; low.#selection = structuredClone(this.#selection); low.#handle = this.#handle;
    return low;
  }
  static restore(value: unknown, root: string, reconcile = true): AdaptiveLow {
    if (Buffer.byteLength(JSON.stringify(value)) > 8 * 1024 * 1024) throw new Error('Adaptive data exceeds its bounded restore budget.');
    const data = objectWithKeys(value, 'adaptive data', ['contract', 'context', 'assessment', 'state', 'receipts', 'completed', 'pending',
      'snapshot', 'report', 'matched', 'completion', 'repairs', 'invalidatedAssignments', 'retainedProof', 'priorEvidence', 'checkHistory', 'historicalChecks', 'continuation', 'questionAnswers']);
    const low = new AdaptiveLow(data.contract, root, RESTORE), contract = low.#contract;
    low.#context = context(data.context, contract.scope); low.#assessment = parseFutureAssessment(data.assessment);
    if (!['await-selection', 'await-result', 'completed', 'closed-unverified'].includes(String(data.state)) || typeof data.matched !== 'boolean' ||
        !Number.isInteger(data.repairs) || (data.repairs as number) < 0 || (data.repairs as number) > 4) throw new Error('Invalid adaptive state or repair count.');
    const assignmentIDs = contract.assignments.map(item => item.id);
    const ids = (value: unknown): string[] => {
      const result = taskIDs(value);
      if (result.some(id => !assignmentIDs.includes(id))) throw new Error('Adaptive progress invents an assignment.');
      return result;
    };
    const proofs = (value: unknown): AdaptiveData['completed'] => entries(value, 'completed proofs').map(value => {
      const item = objectWithKeys(value, 'completed proof', ['assignmentID', 'fingerprints']);
      const own = contract.assignments.find(assignment => assignment.id === item.assignmentID);
      if (!own) throw new Error('Completed proof invents an assignment.');
      const parsed = context({ ...low.#context, fingerprints: item.fingerprints }, own.scope);
      return { assignmentID: own.id, fingerprints: parsed.fingerprints };
    });
    low.#invalidatedAssignments = ids(data.invalidatedAssignments); low.#repairs = data.repairs as number;
    const receipts = entries(data.receipts, 'actual actor receipts').map(value => {
      const item = objectWithKeys(value, 'actual actor receipt', ['id', 'actor', 'assignmentID', 'purpose', 'outcome', 'summary', 'artifact', 'changes', 'assessment', 'failure', 'callID', 'proof', 'accepted', 'questions']);
      const assignment = contract.assignments.find(assignment => assignment.id === item.assignmentID);
      if (!assignment || ![...ACTORS, ...(data.continuation ? ['mdd-propose', 'mdd-spec', 'mdd-design', 'mdd-tasks'] : [])].includes(item.actor as AdaptiveActor) || !['passed', 'failed'].includes(String(item.outcome))) throw new Error('Invalid actual actor receipt.');
      const receipt: Receipt = { id: shortText(item.id, 'receipt ID', 100), actor: item.actor as AdaptiveActor,
        assignmentID: assignment.id, purpose: reportText(item.purpose, 'receipt purpose'), outcome: item.outcome as Receipt['outcome'], summary: summaryText(item.summary, 'receipt summary'),
        callID: shortText(item.callID, 'actual call ID', 256) };
      if (item.artifact !== undefined) receipt.artifact = artifactText(item.artifact);
      if (item.failure !== undefined) receipt.failure = shortText(item.failure, 'receipt failure', 500);
      if (receipt.outcome === 'passed' && (!receipt.artifact || receipt.failure)) throw new Error('Passed receipt contradicts actual failure or lacks an artifact.');
      if (item.changes !== undefined) {
        if (!Array.isArray(item.changes) || item.changes.length > 64) throw new Error('Invalid receipt changes.');
        receipt.changes = Array.from(item.changes, scopePath);
        if (receipt.actor !== 'mdd-apply' || receipt.changes.some(path => !assignment.scope.writes.includes(path))) throw new Error('Receipt changes exceed its assignment.');
      }
      if (item.assessment !== undefined) {
        if (receipt.actor !== 'mdd-risk') throw new Error('Only an actual Risk receipt may update assessment.');
        receipt.assessment = parseFutureAssessment(item.assessment);
      }
      if (item.proof !== undefined) {
        if (receipt.actor !== 'mdd-apply' || receipt.outcome !== 'passed' || !receipt.changes) throw new Error('Completion lacks a successful actual Apply receipt.');
        receipt.proof = proofs([{ assignmentID: assignment.id, fingerprints: item.proof }])[0]!.fingerprints;
      }
      if (item.accepted !== undefined) {
        const accepted = objectWithKeys(item.accepted, 'accepted native structured payload', ['fields', 'verifyContext']);
        if (!data.continuation || receipt.actor === 'mdd-apply' || receipt.actor === 'mdd-risk' || receipt.outcome !== 'passed' ||
            !accepted.fields || typeof accepted.fields !== 'object' || Array.isArray(accepted.fields))
          throw new Error('Accepted native payload contradicts its actual structured receipt.');
        receipt.accepted = { fields: structuredClone(accepted.fields) as Record<string, unknown>,
          ...(accepted.verifyContext !== undefined ? { verifyContext: verifyContext(accepted.verifyContext) } : {}) };
        if ((receipt.actor === 'mdd-verify') !== !!receipt.accepted.verifyContext) throw new Error('Accepted Verify requires its frozen native dispatch context only.');
      }
      if (receipt.actor === 'mdd-apply' && receipt.outcome === 'passed' && !receipt.proof || receipt.actor === 'mdd-risk' && receipt.outcome === 'passed' && !receipt.assessment)
        throw new Error('Passed actor receipt omits its actual result.');
      if (item.questions !== undefined) receipt.questions = openQuestions(item.questions);
      if (receipt.accepted && !isDeepStrictEqual(openQuestions(receipt.accepted.fields.questions), receipt.questions ?? []))
        throw new Error('Actor questions contradict the accepted native payload.');
      return receipt;
    });
    if (new Set(receipts.map(item => item.id)).size !== receipts.length || new Set(receipts.map(item => item.callID)).size !== receipts.length)
      throw new Error('Adaptive receipts repeat identities.');
    low.#receipts.push(...receipts);
    for (const value of entries(data.questionAnswers ?? [], 'native product answers')) {
      const answer = objectWithKeys(value, 'native product answer', ['receiptID', 'native']);
      low.answerQuestions(shortText(answer.receiptID, 'question receipt ID', 100), validateQuestionRecord(answer.native));
    }
    if (data.continuation !== undefined) {
      low.#continuation = AdaptiveContinuation.restore(data.continuation, contract, receipts);
      const continuation = low.#continuation.serialize();
      const frozenContext = context(continuation.context, contract.scope);
      if (frozenContext.technical !== 'understood' || frozenContext.dependencies !== 'bounded')
        throw new Error('Frozen continuation context must retain understood technical context and bounded dependencies.');
      proofs(continuation.retained);
      adaptiveContract({ ...contract, assignments: low.#assignments() });
      for (const receipt of receipts.filter(item => !ACTORS.includes(item.actor) && item.outcome === 'passed'))
        if (!continuation.reports.some(item => item.receiptID === receipt.id)) throw new Error('High actor receipt lacks its actual frozen continuation stage.');
      for (const receipt of receipts.filter(item => item.accepted))
        if (!continuation.reports.some(item => item.receiptID === receipt.id)) throw new Error('Accepted native receipt lacks its actual continuation report.');
    }
    const expectedAssessment = receipts.findLast(item => item.actor === 'mdd-risk' && item.outcome === 'passed')?.assessment ?? contract.assessment;
    if (!isDeepStrictEqual(low.#assessment, expectedAssessment)) throw new Error('Current assessment contradicts actual Risk receipts.');
    const completed = proofs(data.completed), retained = proofs(data.retainedProof);
    for (const group of [completed, retained]) {
      if (new Set(group.map(item => item.assignmentID)).size !== group.length) throw new Error('Duplicate completion proof.');
      for (const item of group) {
        const last = receipts.findLast(receipt => receipt.actor === 'mdd-apply' && receipt.assignmentID === item.assignmentID);
        if (last?.outcome !== 'passed' || !isDeepStrictEqual(last.proof, item.fingerprints))
          throw new Error('Completion contradicts the last actual Apply receipt or invalidation.');
      }
    }
    for (const item of completed) {
      const assignment = low.#assignments().find(assignment => assignment.id === item.assignmentID)!;
      if (assignment.dependsOn.some(id => !completed.some(item => item.assignmentID === id))) throw new Error('Completed assignment lacks completed prerequisites.');
      low.#completed.set(item.assignmentID, item.fingerprints);
    }
    low.#retainedProof = retained;
    const snapshot = (value: unknown): Snapshot => {
      const item = objectWithKeys(value, 'source snapshot', ['id', 'sources']);
      const sources = entries(item.sources, 'snapshot sources').map(value => {
        const file = objectWithKeys(value, 'snapshot source', ['path', 'digest', 'content']);
        if (file.content !== null && typeof file.content !== 'string' || file.digest !== (file.content === null ? null : createHash('sha256').update(file.content as string).digest('hex')))
          throw new Error('Snapshot source bytes contradict their digest.');
        return { path: scopePath(file.path), digest: file.digest as string | null, content: file.content as string | null };
      });
      exactCoverage(sources.map(item => item.path), [...new Set([...contract.scope.reads, ...contract.scope.writes])], 'Snapshot source paths');
      if (sources.reduce((bytes, item) => bytes + Buffer.byteLength(item.content ?? ''), 0) > 1024 * 1024) throw new Error('Snapshot exceeds the 1 MiB budget.');
      return { id: shortText(item.id, 'snapshot identity', 100), sources };
    };
    const history = (value: unknown) => { const result = executed(value, 1); if (Buffer.byteLength(JSON.stringify(result)) > 48000) throw new Error('Execution history exceeds budget.'); return result; };
    low.#historicalChecks = entries(data.historicalChecks, 'historical checks').map(value => {
      const item = objectWithKeys(value, 'historical command evidence', ['snapshot', 'checks']);
      return { snapshot: snapshot(item.snapshot), checks: history(item.checks) };
    });
    low.#validating = true;
    const report = (value: unknown, source: Snapshot): { report: EvidenceReport; matched: boolean } => {
      low.#snapshot = source; low.#checkHistory = []; low.#state = 'await-selection';
      low.submitEvidence(low.#handle, value);
      return { report: structuredClone(low.#report!), matched: low.#matched };
    };
    if (data.priorEvidence !== undefined) {
      const prior = objectWithKeys(data.priorEvidence, 'prior evidence', ['snapshot', 'report', 'invalidatedAssignments', 'assignments']);
      const source = snapshot(prior.snapshot);
      const assignments = adaptiveContract({ ...contract, assignments: prior.assignments ?? contract.assignments }).assignments;
      low.#evidenceAssignments = assignments;
      low.#priorEvidence = { snapshot: source, report: report(prior.report, source).report, invalidatedAssignments: ids(prior.invalidatedAssignments), assignments };
      low.#evidenceAssignments = undefined;
    }
    low.#snapshot = data.snapshot === undefined ? undefined : snapshot(data.snapshot);
    if (low.#snapshot) for (const item of completed) for (const file of item.fingerprints)
      if (low.#snapshot.sources.find(source => source.path === file.path)?.digest !== file.digest)
        throw new Error('Current snapshot contradicts completed source proof.');
    low.#report = undefined; low.#matched = false;
    if (data.report !== undefined) {
      if (!low.#snapshot) throw new Error('Evidence report lacks its actual source snapshot.');
      const validated = report(data.report, low.#snapshot); low.#report = validated.report;
      if (data.matched && !validated.matched) throw new Error('Stored evidence match contradicts actual check accounting.');
    } else if (data.matched) throw new Error('Stored match lacks an evidence report.');
    low.#matched = data.matched; low.#checkHistory = history(data.checkHistory);
    if (low.#checkHistory.length && !low.#snapshot || low.#report && !isDeepStrictEqual(low.#checkHistory.slice(0, low.#report.checks.length), low.#report.checks))
      throw new Error('Execution history contradicts the held report or snapshot.');
    const histories = [...low.#historicalChecks,
      ...(low.#priorEvidence ? [{ snapshot: low.#priorEvidence.snapshot, checks: low.#priorEvidence.report.checks }] : []),
      ...(low.#snapshot ? [{ snapshot: low.#snapshot, checks: low.#checkHistory }] : [])];
    for (const [index, held] of histories.entries()) for (const other of histories.slice(index + 1)) {
      if (held.snapshot.id !== other.snapshot.id) continue;
      const shared = Math.min(held.checks.length, other.checks.length);
      if (!isDeepStrictEqual(held.snapshot, other.snapshot) || !isDeepStrictEqual(held.checks.slice(0, shared), other.checks.slice(0, shared)))
        throw new Error('Historical command evidence contradicts the same source snapshot or execution history.');
    }
    for (const receipt of receipts) {
      const frozen = receipt.accepted?.verifyContext;
      if (frozen && !histories.some(held => held.snapshot.id === frozen.snapshotID && held.checks.length >= frozen.checks.length &&
          isDeepStrictEqual(held.checks.slice(0, frozen.checks.length), frozen.checks)))
        throw new Error('Accepted native Verify context lacks its actual parent snapshot and command history.');
    }
    low.#validating = false; low.#state = data.state as AdaptiveData['state'];
    if (low.#state === 'await-result') {
      const pending = objectWithKeys(data.pending, 'pending adaptive actor', ['actor', 'assignmentID', 'purpose', 'repairOf', 'dispatchPrerequisites', 'verifyContext']);
      const { dispatchPrerequisites, verifyContext: frozenVerify, ...selection } = pending;
      low.#selection = low.selectionInput({ ...selection, handle: low.#handle });
      if (low.#continuation && low.#selection.actor === 'mdd-verify') {
        low.#verifyContext = verifyContext(frozenVerify);
        if (!histories.some(held => held.snapshot.id === low.#verifyContext!.snapshotID && isDeepStrictEqual(held.checks, low.#verifyContext!.checks)))
          throw new Error('Pending Verify context lacks its actual parent snapshot and command history.');
      } else if (frozenVerify !== undefined) throw new Error('Only structured Verify may freeze native verification context.');
      if (!assignmentIDs.includes(low.#selection.assignmentID)) throw new Error('Pending actor invents an assignment.');
      const own = low.assignment()!, previous = receipts.findLast(item => item.actor === 'mdd-apply' && item.assignmentID === own.id);
      low.#dispatchPrerequisites = entries(dispatchPrerequisites, 'pending prerequisite receipts').map(value => {
        const item = objectWithKeys(value, 'pending prerequisite receipt', ['assignmentID', 'receiptID']);
        const assignmentID = evidenceID(item.assignmentID, 'prerequisite assignment'), receiptID = shortText(item.receiptID, 'prerequisite receipt', 100);
        const actual = receipts.findLast(receipt => receipt.actor === 'mdd-apply' && receipt.assignmentID === assignmentID);
        if (actual?.id !== receiptID || actual.outcome !== 'passed' || !actual.proof ||
            !low.#completed.has(assignmentID) && !low.#invalidatedAssignments.includes(assignmentID))
          throw new Error('Pending prerequisite lacks its actual successful dispatch-time receipt or current invalidation.');
        return { assignmentID, receiptID };
      });
      exactCoverage(low.#dispatchPrerequisites.map(item => item.assignmentID),
        low.#selection.actor === 'mdd-apply' ? low.#prerequisiteIDs(own) : [], 'Pending dispatch prerequisites');
      if (contract.productQuestions.length || low.pendingQuestions() || receipts.length >= 64 || low.#context.technical === 'uncertain' && low.#selection.actor !== 'mdd-explore')
        throw new Error('Pending actor contradicts selection eligibility.');
      if (low.#selection.actor === 'mdd-apply' && (!low.#continuation && low.#assessment.impact !== 'low' || low.#context.dependencies !== 'bounded' ||
          low.#completed.has(own.id) ||
          (previous ? low.#selection.repairOf !== previous.id : low.#selection.repairOf !== undefined)))
        throw new Error('Pending Apply contradicts completed work, prerequisites or explicit repair authority.');
    } else if (data.pending !== undefined) throw new Error('Unstarted or settled state cannot retain a pending actor.');
    if (data.completion !== undefined) {
      const completion = objectWithKeys(data.completion, 'adaptive closure', ['outcome', 'limits']);
      const limits = entries(completion.limits, 'closure limits').map(item => reportText(item, 'closure limit'));
      // Evidence limits followed by the manual ones close added, each list bounded on its own.
      if (limits.length > 2 * TEXTS_MAX) throw new Error('Closure exceeds its bounded limits.');
      if (completion.outcome === 'verified' ? low.#state !== 'completed' || !low.#matched || completed.length !== low.#assignments().length || !low.#snapshot || !isDeepStrictEqual(limits, low.#report?.limits) || !!low.#continuation?.next(completed.map(item => item.assignmentID), low.#snapshot?.id, low.#checkHistory)
        : completion.outcome !== 'unverified' || low.#state !== 'closed-unverified' || !limits.length || low.#matched)
        throw new Error('Adaptive closure contradicts completion or evidence.');
      low.#completion = { outcome: completion.outcome as 'verified' | 'unverified', limits };
    } else if (['completed', 'closed-unverified'].includes(low.#state)) throw new Error('Closed adaptive state lacks its closure.');
    low.#handle = randomUUID();
    if (reconcile) low.#reconcile();
    return low;
  }
  #archiveChecks(): void {
    if (this.#snapshot && this.#checkHistory.length && !this.#historicalChecks.some(item => item.snapshot.id === this.#snapshot!.id && isDeepStrictEqual(item.checks, this.#checkHistory))) {
      if (this.#historicalChecks.length >= 64) throw new Error('Historical command evidence budget is exhausted.');
      this.#historicalChecks.push({ snapshot: structuredClone(this.#snapshot), checks: structuredClone(this.#checkHistory) });
    }
  }
  #reconcile(): void {
    const invalid = new Set<string>();
    for (const [id, files] of this.#completed) if (files.some(file => fingerprint(this.root, file.path) !== file.digest)) invalid.add(id);
    let size = -1;
    while (size !== invalid.size) {
      size = invalid.size;
      const writes = this.#assignments().filter(item => invalid.has(item.id)).flatMap(item => item.scope.writes);
      for (const item of this.#assignments()) if (item.dependsOn.some(id => invalid.has(id)) || [...item.scope.reads, ...item.scope.writes].some(path => writes.includes(path))) invalid.add(item.id);
    }
    const staleSnapshot = this.#snapshot?.sources.some(item => fingerprint(this.root, item.path) !== item.digest);
    if (invalid.size || staleSnapshot) {
      this.#archiveChecks();
      if (this.#report && this.#snapshot) this.#priorEvidence = { snapshot: this.#snapshot, report: this.#report, invalidatedAssignments: [...invalid], assignments: this.#assignments() };
      this.#invalidatedAssignments = [...new Set([...this.#invalidatedAssignments, ...invalid])];
      for (const id of invalid) this.#completed.delete(id);
      this.#retainedProof = [...this.#completed].map(([assignmentID, fingerprints]) => ({ assignmentID, fingerprints: structuredClone(fingerprints) }));
      this.#snapshot = undefined; this.#report = undefined; this.#matched = false; this.#checkHistory = [];
      // Closure is irrevocable: drift removes verified proof, never reopens native execution.
      if (this.#completion?.outcome === 'verified') {
        this.#completion = { outcome: 'unverified', limits: ['Source changed after closure; prior evidence is historical only.'] };
        this.#state = 'closed-unverified';
      }
    }
  }
  get state() { return this.#state; }
  #assignments(): Assignment[] { return this.#evidenceAssignments ?? this.#continuation?.assignments() ?? this.#contract.assignments; }
  contract(): AdaptiveContract { return structuredClone({ ...this.#contract, assignments: this.#assignments(), context: this.#context, assessment: this.#assessment }); }
  selection(): AdaptiveSelection | undefined { return structuredClone(this.#selection); }
  assignment(): Assignment | undefined { return structuredClone(this.#assignments().find(item => item.id === this.#selection?.assignmentID)); }
  /** Read-only candidates, not authorization: the same selection guards run on isolated copies. */
  continuationRepairs() {
    if (!this.#continuation || this.#state !== 'await-selection') return undefined;
    const current = { technical: this.#context.technical, dependencies: this.#context.dependencies, fingerprints: this.policySources() };
    const repairs: { assignmentID: string; repairOf: string }[] = [];
    for (const assignment of this.#assignments().filter(item => this.#completed.has(item.id))) {
      const receipt = this.#receipts.findLast(item => item.actor === 'mdd-apply' && item.assignmentID === assignment.id);
      if (!receipt) continue;
      try {
        const candidate = this.copy();
        candidate.select(candidate.selectionInput({ handle: candidate.#handle, actor: 'mdd-apply', assignmentID: assignment.id,
          purpose: 'Inspect bounded repair eligibility without authorizing work.', repairOf: receipt.id,
          context: { ...current, reason: this.#context.reason } }));
        repairs.push({ assignmentID: assignment.id, repairOf: receipt.id });
      } catch { /* Failed/stale proof, prerequisites, repair budget and frozen-stage guards remain authoritative. */ }
    }
    return { repairs, current };
  }
  selectionInput(value: unknown): AdaptiveSelection {
    if (!this.#continuation) return adaptiveSelection(value, this.#contract);
    const input = objectWithKeys(value, 'continuation selection', ['handle', 'actor', 'assignmentID', 'purpose', 'context', 'repairOf']);
    const next = this.#continuation.next([...this.#completed.keys()], this.#snapshot?.id, this.#checkHistory);
    const interruptedRetained = this.#continuation.serialize().retained.some(item => item.assignmentID === input.assignmentID) &&
      this.#invalidatedAssignments.includes(String(input.assignmentID)) && !this.#completed.has(String(input.assignmentID));
    if (input.actor === 'mdd-apply' && input.repairOf !== undefined && (!this.#continuation.planningNext() || interruptedRetained))
      return adaptiveSelection(input, this.#contract);
    if (input.actor !== next) throw new Error(`Only the frozen next continuation stage ${next ?? 'closure'} may be selected.`);
    // Ordinary selection retains its five-actor allowlist. Only this held next-stage gate can
    // mint a high actor; it does not become a generic high-role dispatch surface.
    return { ...adaptiveSelection({ ...input, actor: next === 'mdd-apply' ? next : 'mdd-plan' }, this.#contract), actor: next! };
  }
  startContinuation(handle: string, value: unknown): void {
    this.assertBoundary(handle);
    if (this.#continuation) throw new Error('Continuation depth is already frozen; no automatic second workflow or escalation.');
    const request = continuationRequest(value, this.#contract), current = context(request.context, this.#contract.scope);
    if (current.technical !== 'understood' || current.dependencies !== 'bounded') throw new Error('Inspect uncertain context before structured continuation; it grants no scope authority.');
    this.#assertCompleted(); this.assertCurrent(this.#contract.scope, current);
    if (this.#report && this.#snapshot) this.#priorEvidence = { snapshot: structuredClone(this.#snapshot), report: structuredClone(this.#report),
      invalidatedAssignments: this.#assignments().filter(item => !this.#completed.has(item.id)).map(item => item.id), assignments: this.#assignments() };
    this.#archiveChecks(); this.#snapshot = undefined; this.#report = undefined; this.#matched = false; this.#checkHistory = [];
    this.#continuation = new AdaptiveContinuation({ ...request, context: current }, this.#contract,
      [...this.#completed].map(([assignmentID, fingerprints]) => ({ assignmentID, fingerprints })));
    this.#context = current; this.#handle = randomUUID();
  }
  continuation(): ContinuationData | undefined { return this.#continuation?.serialize(); }
  #assertContinuationCurrent(current = this.#context): void {
    if (!this.#continuation || this.#validating) return;
    adaptiveContract({ ...this.#contract, assignments: this.#assignments() });
    this.#assertCompleted();
    const expected = structuredClone(current);
    for (const files of this.#completed.values()) for (const file of files)
      expected.fingerprints.find(item => item.path === file.path)!.digest = file.digest;
    this.assertCurrent(this.#contract.scope, expected);
  }
  readFiles(): string[] {
    const own = this.#continuation && this.#selection?.actor !== 'mdd-apply' ? this.#contract.scope : this.assignment()!.scope;
    const files = [...new Set([...own.reads, ...own.writes])].filter(path => lstatSync(resolve(this.root, path), { throwIfNoEntry: false }));
    explorationFiles([{ root: this.root, files }]);
    return files;
  }
  assertCurrent(footprint = this.#contract.scope, evidence = this.#context): void {
    applyScopeFiles(this.root, footprint);
    for (const path of new Set([...footprint.reads, ...footprint.writes])) {
      if (footprint.reads.includes(path)) explorationFiles([{ root: this.root, files: [path] }]);
      if (fingerprint(this.root, path) !== evidence.fingerprints.find(item => item.path === path)?.digest)
        throw new Error(`Source fingerprint is stale for ${path}; inspect current source context before Apply.`);
    }
  }
  #assertPrerequisites(assignment: Assignment): void {
    if (assignment.dependsOn.some(id => !this.#completed.has(id))) throw new Error('Apply prerequisites have not completed.');
    for (const id of assignment.dependsOn) for (const item of this.#completed.get(id)!)
      if (fingerprint(this.root, item.path) !== item.digest) throw new Error('Completed prerequisite source is stale.');
  }
  #prerequisiteIDs(assignment: Assignment): string[] {
    const ids = new Set<string>();
    const visit = (item: Assignment): void => {
      for (const id of item.dependsOn) if (!ids.has(id)) {
        ids.add(id); visit(this.#assignments().find(item => item.id === id)!);
      }
    };
    visit(assignment); return [...ids];
  }
  assertBoundary(handle: string): void {
    if (handle !== this.#handle) throw new Error('Evidence or selection handle is stale or consumed.');
    if (this.#state !== 'await-selection') throw new Error('Evidence requires an actorless nonterminal boundary, not a completed or pending actor.');
    if (this.pendingQuestions()) throw new Error('Actual actor questions pause this boundary.');
  }
  pendingQuestions(): { receiptID: string; callID: string; questions: OpenQuestion[] } | undefined {
    const receipt = this.#receipts.find(item => item.questions?.length && !this.#questionAnswers.some(answer => answer.receiptID === item.id));
    return receipt ? structuredClone({ receiptID: receipt.id, callID: receipt.callID!, questions: receipt.questions! }) : undefined;
  }
  /** Answers provide context only. Held acceptance, scope, decisions and successful work never change. */
  answerQuestions(receiptID: string, native: QuestionRecord): void {
    const pending = this.pendingQuestions();
    if (!pending || pending.receiptID !== receiptID || native.version !== 2 || native.state !== 'answered' ||
        native.adaptive?.purpose !== 'product' || native.adaptive.operation.kind !== 'questions' ||
        native.adaptive.operation.args.receiptID !== receiptID || native.adaptive.operation.args.callID !== pending.callID ||
        !isDeepStrictEqual(native.slot.args, adaptiveQuestionsEnvelope(pending.questions, native.adaptive.nonce)) ||
        !native.answer || native.answer.some((answers, index) => !answers.length ||
          answers.some(answer => /^(pause|decline|stop)$/i.test(answer.trim()) || !pending.questions[index]!.options.some(option => option.label === answer))))
      throw new Error('Product answers require the exact actual actor receipt and complete native selections; free text or pause leaves questions unresolved.');
    this.#questionAnswers.push({ receiptID, native: structuredClone(native) });
    this.#handle = randomUUID();
  }
  questionContext(): NonNullable<AdaptiveData['questionAnswers']> { return structuredClone(this.#questionAnswers); }
  /** A native policy proposal binds the actual local footprint, not a claim of whole-file authentication. */
  policySources(): { path: string; digest: string | null }[] {
    applyScopeFiles(this.root, this.#contract.scope);
    return [...new Set([...this.#contract.scope.reads, ...this.#contract.scope.writes])].map(path => ({ path, digest: fingerprint(this.root, path) }));
  }
  #assertCompleted(): void {
    if (this.#validating) return;
    for (const files of this.#completed.values()) for (const file of files)
      if (fingerprint(this.root, file.path) !== file.digest) throw new Error(`Completed assignment source is stale for ${file.path}.`);
  }
  assertPreparationCurrent(): void {
    if (this.#continuation?.planningNext() && !this.#validating) throw new Error('Finish actual structured planning before preparing final parent evidence.');
    this.#assertContinuationCurrent();
    this.#assertCompleted(); applyScopeFiles(this.root, this.#contract.scope);
    explorationFiles([{ root: this.root, files: this.#contract.scope.reads }]);
  }
  assertEvidenceCurrent(): void {
    if (this.#validating) return;
    this.#assertCompleted();
    if (!this.#snapshot) throw new Error('Prepare a final source snapshot before checks and evidence submission.');
    applyScopeFiles(this.root, this.#contract.scope);
    for (const file of this.#snapshot.sources)
      if (fingerprint(this.root, file.path) !== file.digest) throw new Error(`Final source snapshot is stale for ${file.path}.`);
  }
  prepareEvidence(handle: string): void {
    this.assertBoundary(handle); this.assertPreparationCurrent();
    if (this.#continuation) this.#archiveChecks();
    let bytes = 0;
    const sources = [...new Set([...this.#contract.scope.reads, ...this.#contract.scope.writes])].map(path => {
      const digest = fingerprint(this.root, path);
      const data = digest === null ? null : readFileSync(resolve(this.root, path));
      bytes += data?.length ?? 0;
      if (bytes > 1024 * 1024) throw new Error('Final source snapshot exceeds the 1 MiB inspection budget.');
      if (data && createHash('sha256').update(data).digest('hex') !== digest || fingerprint(this.root, path) !== digest)
        throw new Error('Final source snapshot changed during inspection.');
      if (data && !Buffer.from(data.toString('utf8'), 'utf8').equals(data)) throw new Error('Final source readback requires UTF-8 source, not lossy binary decoding.');
      return { path, digest, content: data?.toString('utf8') ?? null };
    });
    const drift = this.#snapshot?.sources.filter(previous => sources.find(item => item.path === previous.path)!.digest !== previous.digest).map(item => item.path) ?? [];
    if (this.#report) this.#priorEvidence = { snapshot: structuredClone(this.#snapshot!), report: structuredClone(this.#report), invalidatedAssignments: drift.length ? this.#assignments().map(item => item.id) : [], assignments: this.#assignments() };
    if (drift.length) { this.#archiveChecks(); this.#checkHistory = []; }
    this.#snapshot = { id: randomUUID(), sources }; this.#report = undefined; this.#matched = false;
    this.#handle = randomUUID();
  }
  submitEvidence(handle: string, value: unknown): void {
    this.assertBoundary(handle); this.assertEvidenceCurrent();
    this.#matched = false;
    const input = objectWithKeys(value, 'adaptive evidence', ADAPTIVE_EVIDENCE_FIELDS);
    if (input.snapshotID !== this.#snapshot!.id) throw new Error('Evidence belongs to another prepared snapshot.');
    const readback = objectWithKeys(input.readback, 'parent contract readback', ['acceptance', 'scope', 'exclusions', 'decisions']);
    const expected = { acceptance: this.#contract.acceptance, scope: this.#contract.scope, exclusions: this.#contract.exclusions, decisions: this.#contract.decisions };
    if (!isDeepStrictEqual(readback, expected)) throw new Error('Parent readback must repeat exact held acceptance, scope, exclusions and decisions.');
    const checks = executed(input.checks, 1);
    if (checks.length < this.#checkHistory.length || !isDeepStrictEqual(checks.slice(0, this.#checkHistory.length), this.#checkHistory))
      throw new Error('Evidence must preserve the chronological reported execution history, including failed attempts and retries.');
    if (Buffer.byteLength(JSON.stringify(checks)) > 48000) throw new Error('Adaptive reported executions exceed the bounded evidence budget.');
    // A malformed disposition cannot erase an otherwise readable reported failed attempt.
    this.#checkHistory = structuredClone(checks);
    const accounting = checkAccounting(input, { planned: this.#assignments().map(item => ({ checks: item.obligations.checks })) }, checks);
    for (const held of this.#assignments().flatMap(item => item.obligations.checks)) {
      const result = accounting.checkResults.find(item => item.checkID === held.id)!;
      const replacement = result.disposition === 'replaced' ? checks.find(item => item.id === result.executions.at(-1))!.command : held.command;
      const attempts = checks.filter(item => item.command === held.command || item.command === replacement).map(item => item.id!);
      if (result.executions.length && !isDeepStrictEqual(result.executions, attempts))
        throw new Error(`Held check ${held.id} must retain every reported command attempt; supplemental evidence cannot hide or downgrade a retry.`);
    }
    const inventory = entries(input.inventory, 'final diff inventory').map(value => {
      const item = objectWithKeys(value, 'final diff path', ['path', 'disposition', 'reason']);
      const path = scopePath(item.path);
      if (item.disposition !== 'assignment' && item.disposition !== 'unrelated') throw new Error('Final diff needs assignment/unrelated disposition.');
      if (item.disposition === 'assignment' && !this.#contract.scope.writes.includes(path) ||
          item.disposition === 'unrelated' && this.#contract.scope.writes.includes(path)) throw new Error('Final diff scope claim contradicts held writes.');
      return { path, disposition: item.disposition as 'assignment' | 'unrelated', reason: reportText(item.reason, 'final diff rationale') };
    });
    if (new Set(inventory.map(item => item.path)).size !== inventory.length) throw new Error('Final diff repeats a path.');
    // This is parent readback, never independent discovery of the whole worktree diff.
    const observed = new Set<string>();
    for (const path of this.#contract.scope.writes)
      if ((this.#validating ? this.#snapshot!.sources.find(file => file.path === path)!.digest : fingerprint(this.root, path)) !== this.#contract.context.fingerprints.find(file => file.path === path)!.digest) observed.add(path);
    if ([...observed].some(path => !inventory.some(item => item.path === path && item.disposition === 'assignment')))
      throw new Error('Final diff inventory omits locally changed declared assignment paths.');
    const exclusions = entries(input.exclusions, 'exclusion findings').map(value => {
      const item = objectWithKeys(value, 'exclusion finding', ['exclusion', 'status', 'assessment']);
      return { exclusion: reportText(item.exclusion, 'held exclusion'), status: status(item.status), assessment: reportText(item.assessment, 'exclusion assessment') };
    });
    exactCoverage(exclusions.map(item => item.exclusion), this.#contract.exclusions, 'Exclusion findings');
    const obligations = this.#assignments().flatMap(item => item.obligations.source);
    const sources = entries(input.sources, 'source readback').map(value => {
      const item = objectWithKeys(value, 'source readback', ['id', 'paths', 'status', 'assessment']);
      const id = evidenceID(item.id), obligation = obligations.find(item => item.id === id), targets = paths(item.paths);
      if (!obligation || !isDeepStrictEqual(targets, obligation.paths)) throw new Error('Source readback paths contradict held obligation links.');
      return { id, paths: targets, status: status(item.status), assessment: reportText(item.assessment, 'source readback assessment') };
    });
    exactCoverage(sources.map(item => item.id), obligations.map(item => item.id), 'Source readback');
    const assess = (item: Record<string, unknown>, assignments: Assignment[]): SemanticAssessment => {
      const result = { status: status(item.status), sources: references(item.sources, 'source evidence references', true),
        checks: references(item.checks, 'execution references', true), assessment: reportText(item.assessment, 'semantic source assessment') };
      const allowedSource = assignments.flatMap(item => item.obligations.source.map(item => item.id));
      const allowedExecutions = assignments.flatMap(item => item.obligations.checks.flatMap(check => accounting.checkResults.find(result => result.checkID === check.id)!.executions));
      if (result.sources.some(id => !allowedSource.includes(id)) || result.checks.some(id => !allowedExecutions.includes(id)))
        throw new Error('Semantic assessment cites evidence outside its held assignment links.');
      if (result.status === 'verified' && (!result.sources.length && !result.checks.length ||
          result.sources.some(id => sources.find(item => item.id === id)!.status !== 'verified') || result.checks.some(id => !accounting.usable.includes(id))))
        throw new Error('Verified assessment needs successful final command or separately verified source evidence.');
      return result;
    };
    const assignments = entries(input.assignments, 'assignment coverage').map(value => {
      const item = objectWithKeys(value, 'assignment coverage', ['assignmentID', 'status', 'sources', 'checks', 'assessment']);
      const assignment = this.#assignments().find(assignment => assignment.id === item.assignmentID);
      if (!assignment) throw new Error('Assignment assessment invents a held link.');
      return { assignmentID: assignment.id, ...assess(item, [assignment]) };
    });
    exactCoverage(assignments.map(item => item.assignmentID), this.#assignments().map(item => item.id), 'Assignment coverage');
    const scenarios = entries(input.scenarios, 'scenario coverage').map(value => {
      const item = objectWithKeys(value, 'scenario coverage', ['requirementID', 'scenarioID', 'assignmentID', 'status', 'sources', 'checks', 'assessment']);
      const assignment = this.#assignments().find(assignment => assignment.id === item.assignmentID);
      const requirement = this.#contract.acceptance.requirements.find(requirement => requirement.id === item.requirementID && requirement.scenarios.some(scenario => scenario.id === item.scenarioID));
      if (!assignment || !requirement || !assignment.scenarios.includes(String(item.scenarioID))) throw new Error('Scenario assessment invents a held link.');
      return { requirementID: requirement.id, scenarioID: String(item.scenarioID), assignmentID: assignment.id, ...assess(item, [assignment]) };
    });
    exactCoverage(scenarios.map(item => `${item.assignmentID}/${item.scenarioID}`), this.#assignments().flatMap(item => item.scenarios.map(id => `${item.id}/${id}`)), 'Scenario coverage');
    const choices = entries(input.decisions, 'decision coverage').map(value => {
      const item = objectWithKeys(value, 'decision coverage', ['decisionID', 'status', 'sources', 'checks', 'assessment']);
      const decision = this.#contract.decisions.find(decision => decision.id === item.decisionID);
      if (!decision) throw new Error('Decision assessment invents a held link.');
      return { decisionID: decision.id, ...assess(item, this.#assignments().filter(assignment => assignment.decisions.includes(decision.id))) };
    });
    exactCoverage(choices.map(item => item.decisionID), this.#contract.decisions.map(item => item.id), 'Decision coverage');
    const limits = texts(input.limits, 'evidence limits');
    const report: EvidenceReport = { snapshotID: this.#snapshot!.id, readback: structuredClone(expected), inventory, exclusions, sources,
      assignments, scenarios, decisions: choices, checks, checkResults: accounting.checkResults, supplementalChecks: accounting.supplementalChecks, limits };
    if (Buffer.byteLength(JSON.stringify(report)) > 48000) throw new Error('Adaptive evidence exceeds its 48000-byte budget.');
    this.assertEvidenceCurrent(); this.#report = report; this.#checkHistory = structuredClone(checks);
    this.#matched = accounting.complete && [...sources, ...assignments, ...scenarios, ...choices, ...exclusions].every(item => item.status === 'verified');
    this.#handle = randomUUID();
  }
  close(handle: string, outcome: unknown, limits: unknown): void {
    this.assertBoundary(handle);
    if (outcome !== 'verified' && outcome !== 'unverified') throw new Error('Close must explicitly select verified or unverified.');
    const remaining = limits === undefined ? [] : texts(limits, 'manual unverified limits');
    if (outcome === 'verified') {
      if (this.#continuation?.next([...this.#completed.keys()], this.#snapshot?.id, this.#checkHistory)) throw new Error('Structured continuation requires all real planning, remaining Apply and Verify stages before closure.');
      this.assertEvidenceCurrent();
      if (!this.#report || !this.#matched || this.#assignments().some(item => !this.#completed.has(item.id)))
        throw new Error('Required evidence and all held acceptance links must be verified before completion.');
      if (remaining.length) throw new Error('Manual unverified limits never earn verified completion.');
    } else {
      if (!remaining.length) throw new Error('Unverified close needs explicit remaining limits.');
      this.#matched = false;
    }
    this.#completion = { outcome, limits: [...(this.#report?.limits ?? []), ...remaining] };
    this.#state = outcome === 'verified' ? 'completed' : 'closed-unverified'; this.#handle = randomUUID();
  }
  select(value: AdaptiveSelection): void {
    if (value.handle !== this.#handle) throw new Error('Selection handle is stale or was consumed.');
    if (this.#state !== 'await-selection') throw new Error('Selection requires an actorless boundary; a task is already authorized or in flight.');
    if (this.#receipts.length >= 64) throw new Error('Volatile receipt budget is exhausted; no automatic closure or escalation.');
    if (this.#contract.productQuestions.length) throw new Error('Unresolved product ambiguity pauses actor selection.');
    if (this.pendingQuestions()) throw new Error('Actual actor questions pause selection until a native answer is linked.');
    if (this.#continuation) {
      this.selectionInput(value);
      if (!(value.actor === 'mdd-apply' && value.repairOf)) this.#assertContinuationCurrent(value.context ?? this.#context);
      if (value.actor === 'mdd-verify' && (!this.#snapshot || !this.#report || !this.#matched))
        throw new Error('Structured Verify requires current matched parent evidence and real command history, not command permission for a scoped child.');
    } else if (!ACTORS.includes(value.actor)) throw new Error('High actors require a frozen continuation next stage.');
    const assignment = this.#assignments().find(item => item.id === value.assignmentID);
    if (!assignment) throw new Error('Unknown adaptive assignment.');
    let current = value.context ?? this.#context;
    if (current.technical === 'uncertain' && value.actor !== 'mdd-explore') throw new Error('Uncertain technical context permits only a brief Explore, never writes.');
    if (value.context) this.assertCurrent(this.#contract.scope, current);
    if (value.actor === 'mdd-apply') {
      if (!this.#continuation && this.#assessment.impact !== 'low') throw new Error('Apply requires low impact independent of complexity or scope size.');
      if (current.dependencies !== 'bounded') throw new Error('Apply requires understood bounded dependencies.');
      const prior = this.#receipts.findLast(receipt => receipt.actor === 'mdd-apply' && receipt.assignmentID === assignment.id);
      if (prior && value.repairOf !== prior.id) throw new Error('A repeated writer requires an explicit repairOf the last actual Apply receipt.');
      if (value.repairOf && !prior) throw new Error('Repair receipt is not an actual Apply attempt.');
      if (this.#completed.has(assignment.id)) {
        const stale = this.#completed.get(assignment.id)!.some(item => fingerprint(this.root, item.path) !== item.digest);
        const failed = this.#report && (this.#report.assignments.find(item => item.assignmentID === assignment.id)!.status !== 'verified' ||
          assignment.obligations.source.some(item => this.#report!.sources.find(source => source.id === item.id)!.status !== 'verified') ||
          assignment.obligations.checks.some(item => !['passed', 'replaced', 'not-applicable'].includes(this.#report!.checkResults.find(check => check.checkID === item.id)!.disposition)) ||
          this.#report.scenarios.some(item => item.assignmentID === assignment.id && item.status !== 'verified') ||
          this.#report.decisions.some(item => assignment.decisions.includes(item.decisionID) && item.status !== 'verified'));
        if (!stale && !failed) throw new Error('Completed Apply cannot repeat without failed or stale evidence requiring explicit repair.');
        if (this.#repairs >= 4) throw new Error('Explicit completed-assignment repair budget is exhausted.');
        // Reinspection only refreshes the authorized footprint; it never grants new paths.
        const refreshed = structuredClone(current);
        for (const path of new Set([...assignment.scope.reads, ...assignment.scope.writes]))
          refreshed.fingerprints.find(item => item.path === path)!.digest = fingerprint(this.root, path);
        this.assertCurrent(assignment.scope, refreshed);
        this.#assertPrerequisites(assignment);
        const invalid = new Set([assignment.id]);
        let count = -1;
        while (count !== invalid.size) {
          count = invalid.size;
          const writes = this.#assignments().filter(item => invalid.has(item.id)).flatMap(item => item.scope.writes);
          for (const item of this.#assignments()) if (item.dependsOn.some(id => invalid.has(id)) ||
            [...item.scope.reads, ...item.scope.writes].some(path => writes.includes(path))) invalid.add(item.id);
        }
        if (assignment.dependsOn.some(id => invalid.has(id))) throw new Error('Repair overlaps a prerequisite; explicitly repair the prerequisite first.');
        this.#invalidatedAssignments = [...invalid];
        this.#retainedProof = [...this.#completed].filter(([id]) => !invalid.has(id)).map(([assignmentID, fingerprints]) => ({ assignmentID, fingerprints: structuredClone(fingerprints) }));
        if (this.#report) this.#priorEvidence = { snapshot: structuredClone(this.#snapshot!), report: structuredClone(this.#report), invalidatedAssignments: [...invalid], assignments: this.#assignments() };
        for (const id of invalid) this.#completed.delete(id);
        this.#archiveChecks(); this.#snapshot = undefined; this.#report = undefined; this.#matched = false; this.#checkHistory = []; this.#repairs++;
        current = refreshed;
      } else if (prior?.outcome === 'passed') {
        // Restore invalidates stale completion, not the finite repair budget. Reinspection is
        // explicit through the supplied current context; never refresh historical proof here.
        if (this.#repairs >= 4) throw new Error('Explicit completed-assignment repair budget is exhausted.');
        this.#repairs++;
      }
      this.#assertPrerequisites(assignment);
      this.assertCurrent(assignment.scope, current);
    }
    this.#context = structuredClone(current);
    this.#assertContinuationCurrent();
    if (value.actor === 'mdd-apply') { this.#archiveChecks(); this.#snapshot = undefined; this.#report = undefined; this.#matched = false; this.#checkHistory = []; }
    this.#selection = structuredClone(value); this.#state = 'authorized-actor';
  }
  assertReady(): void {
    if (this.#state !== 'authorized-actor') throw new Error('Adaptive actor is not ready.');
    this.#assertContinuationCurrent();
    if (this.#selection!.actor === 'mdd-apply') {
      const assignment = this.assignment()!;
      this.#assertPrerequisites(assignment); this.assertCurrent(assignment.scope);
    }
  }
  begin(): void {
    this.assertReady();
    if (this.#continuation && this.#selection!.actor === 'mdd-verify') {
      this.assertEvidenceCurrent();
      if (!this.#matched) throw new Error('Structured Verify dispatch requires matched current parent evidence.');
      this.#verifyContext = { snapshotID: this.#snapshot!.id, checks: structuredClone(this.#checkHistory) };
    }
    // Historical dispatch admission is data, not current completion or a reusable capability.
    // Preserve exact prerequisite receipts so later drift can revoke eligibility without
    // making an already dispatched child impossible to recover after confirmed termination.
    this.#dispatchPrerequisites = this.#selection!.actor === 'mdd-apply' ? this.#prerequisiteIDs(this.assignment()!).map(assignmentID => ({
      assignmentID, receiptID: this.#receipts.findLast(item => item.actor === 'mdd-apply' && item.assignmentID === assignmentID)!.id,
    })) : [];
    this.#state = 'await-result';
  }
  cancelAuthorization(): void {
    if (this.#state !== 'authorized-actor') throw new Error('An executed actor cannot be cancelled as an unstarted selection.');
    this.#selection = undefined; this.#handle = randomUUID(); this.#state = 'await-selection';
  }
  settle(text: string | undefined, runID: string, callID: string, failure?: string): void {
    if (this.#state !== 'await-result') throw new Error('Receipt does not match an active adaptive dispatch.');
    const selected = this.#selection!, assignment = this.assignment()!;
    let receipt: Receipt = { id: randomUUID(), actor: selected.actor, assignmentID: assignment.id, purpose: selected.purpose, callID,
      outcome: 'failed', summary: 'The actual actor did not produce an accepted receipt.' };
    try {
      if (failure || text === undefined) throw new Error(failure ?? 'Native result inspection failed.');
      const fields = selected.actor === 'mdd-risk' ? parseRiskReport(text) : parsePhaseReport(text, selected.actor);
      const questions = openQuestions(fields.questions);
      if (questions.length) receipt.questions = questions;
      if (this.#continuation && selected.actor !== 'mdd-apply') {
        receipt.summary = summaryText(fields.evidenceSummary, 'actual phase summary');
        if (typeof fields.artifact === 'string' && fields.artifact.trim()) receipt.artifact = artifactText(fields.artifact);
        this.#assertContinuationCurrent();
        if (fields.phase !== undefined && fields.phase !== selected.actor || fields.runID !== undefined && fields.runID !== runID ||
            fields.callID !== undefined && fields.callID !== callID) throw new Error('Continuation report belongs to another native phase, run or call.');
        if (selected.actor === 'mdd-verify') {
          this.assertEvidenceCurrent();
          if (!this.#matched || this.#verifyContext?.snapshotID !== this.#snapshot?.id ||
              !isDeepStrictEqual(this.#verifyContext?.checks, this.#checkHistory) || !isDeepStrictEqual(executed(fields.checks, 1), this.#verifyContext?.checks))
            throw new Error('Scoped Verify must review exact actual parent checks, never claim newly executed commands.');
        }
        const continuation = AdaptiveContinuation.restore(this.#continuation.serialize(), this.#contract, this.#receipts);
        continuation.accept(selected.actor as ContinuationActor, fields, receipt.id, selected.actor === 'mdd-verify' ? this.#snapshot?.id : undefined);
        adaptiveContract({ ...this.#contract, assignments: continuation.assignments() });
        this.#continuation = continuation;
        receipt = { ...receipt, outcome: 'passed', summary: summaryText(fields.evidenceSummary, 'actual phase summary'), artifact: fields.artifact as string,
          accepted: { fields: structuredClone(fields), ...(this.#verifyContext ? { verifyContext: structuredClone(this.#verifyContext) } : {}) } };
        this.#verifyContext = undefined;
        this.#receipts.push(receipt); this.#selection = undefined; this.#handle = randomUUID(); this.#state = 'await-selection';
        return;
      }
      const input = objectWithKeys(fields, 'adaptive actor receipt', ['outcome', 'evidenceSummary', 'artifact', 'phase', 'runID', 'callID',
        'how', 'purpose', 'openItems', 'learnings', 'confidence', 'questions', ...(selected.actor === 'mdd-apply' ? ['completed', 'changes', 'noChangeReason', 'checks'] : []),
        ...(selected.actor === 'mdd-risk' ? ['assessment'] : [])]);
      if (input.phase !== undefined && input.phase !== selected.actor || input.runID !== undefined && input.runID !== runID ||
          input.callID !== undefined && input.callID !== callID) throw new Error('Receipt is bound to another actor, run or native call.');
      if (input.outcome !== 'passed' && input.outcome !== 'failed') throw new Error('Receipt outcome must be passed or failed.');
      const artifact = artifactText(input.artifact);
      receipt = { ...receipt, outcome: input.outcome, summary: summaryText(input.evidenceSummary, 'actor summary'), artifact };
      if (selected.actor === 'mdd-risk') {
        receipt.assessment = parseFutureAssessment(input.assessment);
        if (input.outcome === 'passed') this.#assessment = receipt.assessment;
      }
      if (selected.actor === 'mdd-apply') {
        if (input.checks !== undefined && (!Array.isArray(input.checks) || input.checks.length)) throw new Error('Scoped Apply cannot execute commands or claim check results.');
        const files = changed(input.changes, input.noChangeReason);
        if (files.paths.some(path => !assignment.scope.writes.includes(scopePath(path)))) throw new Error('Reported changes exceed the assigned writes.');
        receipt.changes = files.paths;
        const completed = taskIDs(input.completed);
        if (input.outcome === 'passed' && (completed.length !== 1 || completed[0] !== assignment.id) || input.outcome === 'failed' && completed.length)
          throw new Error('Apply must complete exactly its assigned ID on success, and none on failure.');
        if (input.outcome === 'passed') {
          receipt.proof = [...new Set([...assignment.scope.reads, ...assignment.scope.writes])].map(path => ({ path,
            // Outputs use their settled bytes; unchanged eligibility inputs retain admission evidence.
            digest: assignment.scope.writes.includes(path) ? fingerprint(this.root, path)
              : this.#context.fingerprints.find(item => item.path === path)!.digest }));
          this.#completed.set(assignment.id, structuredClone(receipt.proof));
        }
      }
    } catch (error) {
      receipt = { ...receipt, outcome: 'failed', failure: String(error instanceof Error ? error.message : error).slice(0, 500) };
    }
    this.#receipts.push(receipt); this.#selection = undefined; this.#verifyContext = undefined; this.#handle = randomUUID(); this.#state = 'await-selection';
  }
  status() {
    const last = this.#receipts.at(-1);
    return { lane: 'adaptive-low-internal' as const, state: this.#state, volatile: true,
      selection: { ...(this.#state === 'await-selection' ? { handle: this.#handle } : {}), actors: [...ACTORS],
        completed: [...this.#completed.keys()], receipts: this.#receipts.length,
        context: { technical: this.#context.technical, dependencies: this.#context.dependencies, ...this.#assessment },
        assignments: this.#assignments().map(item => ({ id: item.id, description: item.description.slice(0, 150),
          prerequisitesComplete: item.dependsOn.every(id => this.#completed.has(id)),
          obligations: { source: item.obligations.source.length, checks: item.obligations.checks.length,
            executed: this.#report ? item.obligations.checks.filter(check => this.#report!.checkResults.find(result => result.checkID === check.id)!.executions.length).length : 0 } })),
        ...(this.#contract.productQuestions.length || this.pendingQuestions() ? { blocked: 'product-ambiguity' } : {}) },
      ...(this.pendingQuestions() ? { productQuestions: this.pendingQuestions() } : {}),
      ...(this.#selection ? { actor: this.#selection.actor, assignmentID: this.#selection.assignmentID } : {}),
      ...(last ? { lastReceipt: { id: last.id, actor: last.actor, assignmentID: last.assignmentID, outcome: last.outcome,
        summary: statusText(last.summary), ...(last.failure ? { failure: last.failure } : {}) } } : {}),
      evidence: { matched: this.#matched, assurance: ASSURANCE, invalidatedAssignments: [...this.#invalidatedAssignments],
        retainedAssignments: this.#retainedProof.map(item => item.assignmentID),
        executionHistory: this.#checkHistory.map(({ id, exit }) => ({ id, exit })),
        ...(this.#snapshot ? { snapshot: { id: this.#snapshot.id, paths: this.#snapshot.sources.map(item => item.path) } } : {}),
        ...(this.#report ? { coverage: { sources: this.#report.sources.map(({ id, status }) => ({ id, status })),
          assignments: this.#report.assignments.map(({ assignmentID, status }) => ({ assignmentID, status })),
          scenarios: this.#report.scenarios.map(({ assignmentID, scenarioID, status }) => ({ assignmentID, scenarioID, status })),
          decisions: this.#report.decisions.map(({ decisionID, status }) => ({ decisionID, status })) },
          exclusions: this.#report.exclusions.map(({ exclusion, status }) => ({ exclusion: exclusion.slice(0, 150), status })),
          checkResults: this.#report.checkResults.map(({ checkID, disposition, executions, reason }) => ({ checkID, disposition, executions, ...(reason ? { reason: reason.slice(0, 150) } : {}) })),
          supplementalChecks: this.#report.supplementalChecks.map(({ id, requirement, disposition }) => ({ id, requirement, disposition })),
          limits: this.#report.limits.map(statusText) } : {}),
        ...(this.#priorEvidence ? { priorEvidence: { snapshotID: this.#priorEvidence.report.snapshotID,
          invalidatedAssignments: [...this.#priorEvidence.invalidatedAssignments], commandEvidenceInvalidated: this.#priorEvidence.invalidatedAssignments.length > 0,
          checkResults: this.#priorEvidence.report.checkResults.map(({ checkID, disposition }) => ({ checkID, disposition })) } } : {}) },
      ...(this.#completion ? { completion: { outcome: this.#completion.outcome, limits: this.#completion.limits.map(statusText) } } : {}),
      ...(this.#continuation ? { continuation: this.#continuation.status([...this.#completed.keys()], this.#snapshot?.id, this.#checkHistory) } : {}),
      reason: this.#completion ? 'Internal closure grants no further actor, review authority, public activation or durable resume.'
        : 'Select the next necessary actor or prepare final evidence internally. No automatic phase, verification, completion, reset or escalation is implied.' };
  }
  /** Explicit bounded internal readback, separate from compact status. No execution authority. */
  evidence() {
    return { ...this.status().evidence,
      ...(this.#snapshot ? { snapshot: structuredClone(this.#snapshot) } : {}),
      ...(this.#report ? { report: structuredClone(this.#report) } : {}),
      historicalChecks: structuredClone(this.#historicalChecks),
      retainedSourceProof: structuredClone(this.#retainedProof),
      ...(this.#priorEvidence ? { priorEvidence: structuredClone(this.#priorEvidence) } : {}) };
  }
}
