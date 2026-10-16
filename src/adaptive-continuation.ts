import { isDeepStrictEqual } from 'node:util';
import { acceptance, decisions, phaseFields, shortText, validatePlan, readVerification, raise, assertNoTraceSection, unmet, UNMET_PASS } from './acceptance.js';
import { deliverables, executed } from './phase-evidence.js';
import type { Deliverable } from './phase-evidence.js';
import { parseFutureAssessment } from './risk.js';
import { objectWithKeys } from './validation.js';
import type { AdaptiveContract, AdaptiveData } from './adaptive-low.js';

export type ContinuationActor = 'mdd-propose' | 'mdd-spec' | 'mdd-design' | 'mdd-tasks' | 'mdd-plan' | 'mdd-verify';
type Assignment = AdaptiveContract['assignments'][number];
type Report = { receiptID: string; actor: ContinuationActor; fields: Record<string, unknown>; snapshotID?: string };
export type ContinuationData = {
  depth: 'medium' | 'high'; rationale: string; assessment: AdaptiveContract['assessment'];
  context: AdaptiveContract['context']; retained: AdaptiveData['completed'];
  bindings: Assignment[]; reports: Report[]; revision: number;
};
const STAGES = { medium: ['mdd-plan'], high: ['mdd-propose', 'mdd-spec', 'mdd-design', 'mdd-tasks'] } as const;

export function continuationRequest(value: unknown, contract: AdaptiveContract): Omit<ContinuationData, 'retained' | 'bindings' | 'reports' | 'revision'> {
  const input = objectWithKeys(value, 'structured continuation', ['depth', 'rationale', 'assessment', 'context']);
  if (input.depth !== 'medium' && input.depth !== 'high') throw new Error('Continuation freezes medium or high depth.');
  const assessment = parseFutureAssessment(input.assessment);
  const levels = input.depth === 'high' ? ['high'] : ['medium', 'high'];
  if (!levels.includes(assessment.impact) && !levels.includes(assessment.complexity))
    throw new Error('Structured depth requires positive impact or complexity assessment; unknown context is not high authority.');
  if (contract.productQuestions.length) throw new Error('Unresolved business scope requires a native user decision, not escalation.');
  return { depth: input.depth, rationale: shortText(input.rationale, 'parent continuation rationale'), assessment,
    context: structuredClone(input.context) as AdaptiveContract['context'] };
}

export function assignmentDeliverable(item: Assignment): Deliverable {
  return { id: item.id, description: item.description, path: item.path, scenarios: item.scenarios, decisions: item.decisions,
    dependsOn: item.dependsOn, parallel: item.scope, checks: item.obligations.checks };
}

/** One frozen sequence. Reports are actual bounded journal data, never fixed-phase artifact paths. */
export class AdaptiveContinuation {
  readonly #data: ContinuationData;
  #effective: Assignment[];
  constructor(request: ReturnType<typeof continuationRequest>, readonly contract: AdaptiveContract,
    retained: AdaptiveData['completed'], bindings = contract.assignments) {
    this.#data = { ...structuredClone(request), retained: structuredClone(retained), bindings: structuredClone(bindings), reports: [], revision: 0 };
    this.#effective = structuredClone(bindings);
    this.#validateBindings();
    validatePlan(contract.acceptance, contract.decisions, this.#effective.map(assignmentDeliverable));
  }
  #validateBindings(): void {
    if (!isDeepStrictEqual(this.#data.bindings, this.contract.assignments)) throw new Error('Continuation source bindings contradict admission authority.');
    if (new Set(this.#data.retained.map(item => item.assignmentID)).size !== this.#data.retained.length ||
        this.#data.retained.some(item => !this.#data.bindings.some(own => own.id === item.assignmentID)))
      throw new Error('Continuation retained work invents or repeats an assignment.');
  }
  static restore(value: unknown, contract: AdaptiveContract, receipts: AdaptiveData['receipts']): AdaptiveContinuation {
    const input = objectWithKeys(value, 'durable continuation', ['depth', 'rationale', 'assessment', 'context', 'retained', 'bindings', 'reports', 'revision']);
    const request = continuationRequest({ depth: input.depth, rationale: input.rationale, assessment: input.assessment, context: input.context }, contract);
    if (!Array.isArray(input.retained) || !Array.isArray(input.bindings) || !Array.isArray(input.reports) || input.reports.length > 64)
      throw new Error('Continuation requires bounded actual reports and retained bindings.');
    const result = new AdaptiveContinuation(request, contract, input.retained as AdaptiveData['completed'], input.bindings as Assignment[]);
    for (const held of result.#data.retained) {
      const receipt = receipts.findLast(item => item.actor === 'mdd-apply' && item.assignmentID === held.assignmentID &&
        item.outcome === 'passed' && isDeepStrictEqual(item.proof, held.fingerprints));
      if (!receipt) throw new Error('Continuation retained binding lacks actual successful source proof.');
    }
    let lastIndex = -1;
    for (const value of input.reports) {
      const report = objectWithKeys(value, 'actual continuation report', ['receiptID', 'actor', 'fields', 'snapshotID']);
      const index = receipts.findIndex(item => item.id === report.receiptID), receipt = receipts[index];
      const fields = report.fields as Record<string, unknown>;
      if (!receipt || index <= lastIndex || receipt.outcome !== 'passed' || receipt.actor !== report.actor ||
          !fields || fields.artifact !== receipt.artifact || fields.evidenceSummary !== receipt.summary || fields.outcome !== 'passed' ||
          fields.phase !== undefined && fields.phase !== receipt.actor || fields.callID !== undefined && fields.callID !== receipt.callID)
        throw new Error('Continuation advancement lacks its chronological actual native receipt.');
      // The receipt retains what native result inspection actually accepted. A continuation
      // projection and its recomputable journal checksum are not independent report evidence.
      if (!receipt.accepted || !isDeepStrictEqual(fields, receipt.accepted.fields) ||
          (report.actor === 'mdd-verify' ? report.snapshotID !== receipt.accepted.verifyContext?.snapshotID ||
            !isDeepStrictEqual(fields.checks, receipt.accepted.verifyContext?.checks) : report.snapshotID !== undefined || receipt.accepted.verifyContext !== undefined))
        throw new Error('Continuation report or Verify context differs from the accepted native receipt payload.');
      if (report.actor === 'mdd-verify') for (const assignment of result.#effective) {
        const actual = receipts.slice(0, index).findLast(item => item.actor === 'mdd-apply' && item.assignmentID === assignment.id);
        if (actual?.outcome !== 'passed' || !actual.proof) throw new Error('Structured Verify precedes actual successful effective work.');
      }
      result.accept(report.actor as ContinuationActor, fields, receipt.id,
        report.snapshotID === undefined ? undefined : shortText(report.snapshotID, 'Verify snapshot', 100));
      lastIndex = index;
    }
    if (input.revision !== result.#data.revision) throw new Error('Continuation revision contradicts actual planning reports.');
    return result;
  }
  serialize(): ContinuationData { return structuredClone(this.#data); }
  assignments(): Assignment[] { return structuredClone(this.#effective); }
  planningNext(): ContinuationActor | undefined {
    return STAGES[this.#data.depth][this.#data.reports.filter(item => item.actor !== 'mdd-verify').length];
  }
  next(completed: string[], snapshotID?: string, checks?: unknown): ContinuationActor | 'mdd-apply' | undefined {
    const stage = this.planningNext();
    if (stage) return stage;
    if (this.#effective.some(item => !completed.includes(item.id))) return 'mdd-apply';
    const verify = this.#data.reports.findLast(item => item.actor === 'mdd-verify');
    return snapshotID && verify?.snapshotID === snapshotID && (checks === undefined || isDeepStrictEqual(checks, verify.fields.checks)) ? undefined : 'mdd-verify';
  }
  #remaining(value: unknown): Assignment[] {
    const parsed = Array.isArray(value) && !value.length ? [] : deliverables(value, 1), retainedIDs = this.#data.retained.map(item => item.assignmentID);
    const retained = this.#data.bindings.filter(item => retainedIDs.includes(item.id));
    const remaining = this.#data.bindings.filter(item => !retainedIDs.includes(item.id));
    if (parsed.length !== remaining.length || remaining.some(item => !parsed.some(step => step.id === item.id)))
      throw new Error('Remaining planning must cover exactly the unfinished held IDs, never reopen valid writers.');
    const revised = parsed.map(step => {
      const original = remaining.find(item => item.id === step.id)!;
      // Business links and source obligations remain held. Only technical ordering, explanation,
      // and additional real check obligations can change without invalidating semantic authority.
      if (step.path !== original.path || !isDeepStrictEqual(step.scenarios, original.scenarios) ||
          !isDeepStrictEqual(step.decisions, original.decisions) || !isDeepStrictEqual(step.parallel, original.scope))
        throw new Error('Remaining plan changes a held semantic or source binding; explicit invalidation/reinspection or native user decision is required.');
      if (original.dependsOn.some(id => !step.dependsOn.includes(id)) || original.obligations.checks.some(check =>
        !step.checks?.some(actual => isDeepStrictEqual(check, actual)))) throw new Error('Remaining plan cannot remove held dependencies or evidence obligations.');
      if (retained.some(item => item.scope.writes.some(path => step.parallel!.writes!.includes(path))))
        throw new Error('Remaining plan overlaps retained valid writer outputs.');
      return { ...structuredClone(original), description: step.description, dependsOn: step.dependsOn,
        obligations: { source: structuredClone(original.obligations.source), checks: step.checks! } };
    });
    const combined = [...retained, ...revised];
    validatePlan(this.contract.acceptance, this.contract.decisions, combined.map(assignmentDeliverable));
    return combined;
  }
  accept(actor: ContinuationActor, fields: Record<string, unknown>, receiptID: string, snapshotID?: string): void {
    if (this.#data.reports.length >= 64) throw new Error('Continuation actual report budget is exhausted.');
    if (actor !== (this.planningNext() ?? 'mdd-verify')) throw new Error('Only the frozen next continuation stage may advance.');
    if (fields.verificationVersion !== 1 || fields.outcome !== 'passed') throw new Error('Continuation requires the actual structured phase contract version 1 and passed outcome.');
    if (Buffer.byteLength(JSON.stringify(fields)) > 48000) throw new Error('Actual continuation report exceeds the bounded 48000-byte journal budget.');
    const checked = phaseFields(actor, fields);
    if (checked.ignored.length) throw new Error('Continuation report contains fields outside its actual phase contract.');
    // Continuation accepts only passed reports, so a planning stage naming an unmet requirement is refused, as on the fixed route.
    if ((actor === 'mdd-plan' || actor === 'mdd-design' || actor === 'mdd-tasks') && unmet(fields.unmet, this.contract.acceptance).length) throw new Error(UNMET_PASS);
    if (typeof fields.artifact !== 'string' || !fields.artifact.trim() || Buffer.byteLength(fields.artifact) > 12000)
      throw new Error('Continuation requires a bounded actual report artifact.');
    assertNoTraceSection(fields.artifact); shortText(fields.evidenceSummary, 'actual phase summary');
    let effective: Assignment[] | undefined;
    if (actor === 'mdd-plan' || actor === 'mdd-spec') {
      if (!isDeepStrictEqual(acceptance(fields.acceptance), this.contract.acceptance))
        throw new Error('Structured acceptance must preserve the full held business authority; expansion requires a native user decision.');
      if (actor === 'mdd-spec' && fields.domain !== 'project') throw new Error('Spec must retain the project storage namespace.');
    }
    if (actor === 'mdd-plan' || actor === 'mdd-design') {
      if (!isDeepStrictEqual(decisions(fields.decisions, this.contract.acceptance), this.contract.decisions))
        throw new Error('Structured decisions must preserve the full held business authority.');
    }
    if (actor === 'mdd-plan' || actor === 'mdd-tasks') effective = this.#remaining(fields.deliverables);
    if (actor === 'mdd-verify') {
      if (!snapshotID) throw new Error('Structured Verify requires its real final parent evidence snapshot.');
      const checks = executed(fields.checks, 1);
      const read = readVerification(fields.verification, { accepted: this.contract.acceptance, choices: this.contract.decisions,
        planned: this.#effective.map(assignmentDeliverable), verificationVersion: 1 }, checks.map(item => item.id!),
      checks.filter(item => item.exit === 0).map(item => item.id!), 1, checks);
      raise(read.problems, 'The structured continuation Verify');
      if (!read.verification?.matched) throw new Error('Structured Verify does not verify all held acceptance, decisions and effective work.');
    }
    this.#data.reports.push({ receiptID, actor, fields: structuredClone(fields), ...(snapshotID ? { snapshotID } : {}) });
    if (effective) { this.#effective = effective; this.#data.revision++; }
  }
  status(completed: string[], snapshotID?: string, checks?: unknown) {
    return { depth: this.#data.depth, rationale: this.#data.rationale, assessment: structuredClone(this.#data.assessment),
      next: this.next(completed, snapshotID, checks), revision: this.#data.revision,
      retained: this.#data.retained.map(item => item.assignmentID), reports: this.#data.reports.map(({ receiptID, actor }) => ({ receiptID, actor })) };
  }
}
