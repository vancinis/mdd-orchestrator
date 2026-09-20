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
/**
 * The rendered report is the one MDD artefact the user reads directly, so its scaffolding is
 * Spanish like the installer, the config wizard and the preflight. The prose inside it is written
 * by the phase actor in English and translated by the coordinator; only the frame is fixed here,
 * which is what keeps the sections the user chose from being rewritten into whatever a model felt
 * like producing. `phaseLabel` is part of that frame and is therefore Spanish too.
 */
export function phaseLabel(phase: Phase): string {
  return { 'mdd-explore': 'Exploración', 'mdd-plan': 'Planificación', 'mdd-propose': 'Alcance', 'mdd-spec': 'Requisitos',
    'mdd-design': 'Diseño', 'mdd-tasks': 'Pasos de implementación', 'mdd-apply': 'Implementación', 'mdd-verify': 'Verificación' }[phase];
}

/**
 * The vocabulary of the rendered frame. Keeping these as labels rather than inlining the words
 * means the flag names, the states and the statuses stay the protocol's own English keys wherever
 * they are compared, matched or written to a ledger, and only the presentation is translated.
 */
const EVIDENCE_LABELS: Record<EvidenceFlag, string> = {
  requirements: 'requisitos', plan: 'plan', implementation: 'implementación', checks: 'chequeos',
};
const STATE_LABELS: Record<EvidenceState, string> = {
  unearned: 'sin acreditar', confirmed: 'confirmada', invalidated: 'invalidada',
};
const STATUS_LABELS: Record<ReportStatus, string> = {
  'in-progress': 'en curso', passed: 'completado', failed: 'fallido', blocked: 'detenido',
};

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

/** The adapter, not model output, decides which flags a phase earned and which it withdrew. */
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
  const heading = `Resumen (${phaseLabel(input.phase as Phase)})\n${summary}`;
  if (detail === 'low') return `${heading}\n`;
  const medium = `${heading}\n\nCómo\n${how.length ? how.map(item => `- ${item}`).join('\n') : 'No se informaron detalles del trabajo realizado.'}`;
  if (detail === 'medium') return `${medium}\n`;
  if (detail !== 'detailed') throw new ValidationError('Unknown report detail.');
  const breakdown = (Object.keys(EVIDENCE_WEIGHTS) as EvidenceFlag[]).map(flag =>
    `- ${EVIDENCE_LABELS[flag]}: ${STATE_LABELS[evidence[flag]]} (${evidence[flag] === 'confirmed' ? EVIDENCE_WEIGHTS[flag] : 0}/${EVIDENCE_WEIGHTS[flag]})`,
  ).join('\n');
  return `${medium}\n\nEstado\n${STATUS_LABELS[input.status as ReportStatus]}\n\nCobertura\n${evidenceCoverage(evidence)}% de cobertura de evidencia (no es una probabilidad de acierto).\n${breakdown}\n`;
}

export function renderClosure(detail: Answers['summary'], input: { goal: string; changes: string; matched: boolean; checks: string[]; limits: string[]; status: ReportStatus; evidence: Evidence }): string {
  if (input.status === 'passed' && (!input.matched || !input.checks.length || input.evidence.checks !== 'confirmed')) throw new ValidationError('Successful closure requires matched acceptance and confirmed executed checks.');
  if (input.matched && input.status !== 'passed') throw new ValidationError('An incomplete closure cannot claim requirements and plan matched.');
  const summary = `${text(input.goal)} ${text(input.changes)} ${input.matched ? 'Evaluación del agente: los requisitos y el plan coinciden con lo implementado.' : 'Sin completar: los requisitos y el plan no están verificados del todo.'} Se registraron ${input.checks.length} comando(s) de chequeo.${input.limits.length ? `\nPendiente: ${input.limits.map(text).join(' ')}` : ''}`;
  return renderReport(detail, { phase: 'mdd-verify', summary, how: [
    ...input.checks.map(command => `Se ejecutó ${text(command)}.`),
    'Que los requisitos y el plan coincidan es la interpretación del agente a partir de las fuentes; la ejecución de los comandos la verifica el adaptador por su cuenta.',
  ], status: input.status, evidence: input.evidence }).replace(`Resumen (${phaseLabel('mdd-verify')})`, 'Resumen');
}
