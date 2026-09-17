import type { Answers, Phase } from './policy.js';
import { MODEL_ROLES } from './settings.js';
import { objectWithKeys, ValidationError } from './validation.js';

export const EVIDENCE_WEIGHTS = Object.freeze({ requirements: 20, plan: 20, implementation: 25, checks: 35 });
export type EvidenceFlag = keyof typeof EVIDENCE_WEIGHTS;
export type EvidenceState = 'unearned' | 'confirmed' | 'invalidated';
export type Evidence = Record<EvidenceFlag, EvidenceState>;
export type ReportStatus = 'in-progress' | 'passed' | 'failed' | 'blocked';
export type PhaseReport = {
  phase: Phase;
  summary: string;
  how: string[];
  status: ReportStatus;
  evidence: Evidence;
};
export function phaseLabel(phase: Phase): string {
  return { 'mdd-explore': 'Exploration', 'mdd-plan': 'Planning', 'mdd-propose': 'Scope', 'mdd-spec': 'Requirements',
    'mdd-design': 'Design', 'mdd-tasks': 'Implementation steps', 'mdd-apply': 'Implementation', 'mdd-verify': 'Verification' }[phase];
}

export function emptyEvidence(): Evidence {
  return { requirements: 'unearned', plan: 'unearned', implementation: 'unearned', checks: 'unearned' };
}

function parseEvidence(value: unknown): Evidence {
  const input = objectWithKeys(value, 'evidence', Object.keys(EVIDENCE_WEIGHTS));
  const result = emptyEvidence();
  for (const key of Object.keys(result) as EvidenceFlag[]) {
    const state = input[key];
    if (state !== 'unearned' && state !== 'confirmed' && state !== 'invalidated') {
      throw new ValidationError('Every evidence flag requires an explicit earned/invalidation state.');
    }
    result[key] = state;
  }
  return result;
}

/** The adapter, not model output, must corroborate confirmations and affected flags. */
export function invalidateEvidence(value: Evidence, affected: readonly EvidenceFlag[]): Evidence {
  const result = parseEvidence(value);
  if (!Array.isArray(affected) || affected.length === 0) throw new ValidationError('Name the evidence affected by the failure.');
  for (const flag of affected) {
    if (!Object.hasOwn(EVIDENCE_WEIGHTS, flag)) throw new ValidationError('Unknown evidence flag.');
    result[flag as EvidenceFlag] = 'invalidated';
  }
  return result;
}

export function evidenceCoverage(value: Evidence): number {
  const evidence = parseEvidence(value);
  return (Object.keys(EVIDENCE_WEIGHTS) as EvidenceFlag[]).reduce(
    (total, flag) => total + (evidence[flag] === 'confirmed' ? EVIDENCE_WEIGHTS[flag] : 0), 0,
  );
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 8000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) {
    throw new ValidationError('Report text must be nonempty, bounded, and free of terminal control characters.');
  }
  return value.trim();
}

export function renderReport(detail: Answers['summary'], value: PhaseReport): string {
  const input = objectWithKeys(value, 'report', ['phase', 'summary', 'how', 'status', 'evidence']);
  if (typeof input.phase !== 'string' || input.phase === 'orchestrator' || !MODEL_ROLES.includes(input.phase as Phase)) {
    throw new ValidationError('Report requires a known phase.');
  }
  if (!['in-progress', 'passed', 'failed', 'blocked'].includes(input.status as string)) throw new ValidationError('Unknown report status.');
  const summary = text(input.summary);
  if (!Array.isArray(input.how) || input.how.length > 32) throw new ValidationError('Report how must be a bounded list of actual work.');
  const how = input.how.map(text);
  const evidence = parseEvidence(input.evidence);
  if ((input.status === 'failed' || input.status === 'blocked') && !Object.values(evidence).includes('invalidated')) {
    throw new ValidationError('Failed or blocked work must invalidate affected evidence before reporting.');
  }
  const heading = `Summary (${phaseLabel(input.phase as Phase)})\n${summary}`;
  if (detail === 'low') return `${heading}\n`;
  const medium = `${heading}\n\nHow\n${how.length ? how.map(item => `- ${item}`).join('\n') : 'No performed-work details supplied.'}`;
  if (detail === 'medium') return `${medium}\n`;
  if (detail !== 'detailed') throw new ValidationError('Unknown report detail.');
  const breakdown = (Object.keys(EVIDENCE_WEIGHTS) as EvidenceFlag[]).map(flag =>
    `- ${flag}: ${evidence[flag]} (${evidence[flag] === 'confirmed' ? EVIDENCE_WEIGHTS[flag] : 0}/${EVIDENCE_WEIGHTS[flag]})`,
  ).join('\n');
  return `${medium}\n\nStatus\n${input.status}\n\nConfidence\n${evidenceCoverage(evidence)}% evidence coverage (not probability).\n${breakdown}\n`;
}

export function renderClosure(detail: Answers['summary'], input: { goal: string; changes: string; matched: boolean; checks: string[]; limits: string[]; status: ReportStatus; evidence: Evidence }): string {
  if (input.status === 'passed' && (!input.matched || !input.checks.length || input.evidence.checks !== 'confirmed')) throw new ValidationError('Successful closure requires matched acceptance and confirmed executed checks.');
  if (input.matched && input.status !== 'passed') throw new ValidationError('An incomplete closure cannot claim requirements and plan matched.');
  const summary = `${text(input.goal)} ${text(input.changes)} ${input.matched ? 'Agent assessment: requirements and plan matched.' : 'Not complete: requirements and plan are not fully verified.'} ${input.checks.length} check command(s) recorded.${input.limits.length ? `\nRemaining: ${input.limits.map(text).join(' ')}` : ''}`;
  return renderReport(detail, { phase: 'mdd-verify', summary, how: [
    ...input.checks.map(command => `Executed ${text(command)}.`),
    'Requirement and plan matching is the agent’s source-based interpretation; command executions are checked independently by the adapter.',
  ], status: input.status, evidence: input.evidence }).replace('Summary (Verification)', 'Summary');
}
