import type { Check } from './phase-evidence.js';
import type { Answers, Phase } from './policy.js';
import { PHASES } from './policy.js';
import { objectWithKeys, ValidationError } from './validation.js';

export const EVIDENCE_WEIGHTS = Object.freeze({ requirements: 20, plan: 20, implementation: 25, checks: 35 });
export type EvidenceFlag = keyof typeof EVIDENCE_WEIGHTS;
export type EvidenceState = 'unearned' | 'confirmed' | 'invalidated';
export type Evidence = Record<EvidenceFlag, EvidenceState>;
export type ReportStatus = 'in-progress' | 'passed' | 'failed' | 'blocked';
export type ConfidenceLevel = 'high' | 'medium' | 'low';
/**
 * The prose a phase actor wrote about its own work, beyond the summary. Every actor writes all of
 * it whatever detail the user chose: the level decides what is shown, so asking for more detail
 * at an approval has something to show instead of only the summary that was already read.
 */
export type Narrative = {
  purpose?: string;
  openItems?: string;
  learnings?: string;
  confidence?: { level: ConfidenceLevel; reason: string };
};
export type PhaseReport = {
  phase: Phase;
  summary: string;
  /** How the work was carried out; rendered as "Cómo se hizo". */
  how: string[];
  status: ReportStatus;
  evidence: Evidence;
  /**
   * Present only on a report a phase actor actually wrote. Its absence (a placeholder, the risk
   * stop, an older checkpoint) means there is no narrative to show; its presence with a section
   * missing means the actor left that section out, which is shown rather than silently skipped.
   */
  narrative?: Narrative;
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
 * means the statuses and confidence levels stay the protocol's own English keys wherever they are
 * compared, matched or written to a ledger, and only the presentation is translated. Evidence
 * flags still decide whether a run may close as complete, but they are bookkeeping, not something
 * the reader is shown.
 */
const STATUS_LABELS: Record<ReportStatus, string> = {
  'in-progress': 'en curso', passed: 'completado', failed: 'fallido', blocked: 'detenido',
};
const CONFIDENCE_LABELS: Record<ConfidenceLevel, string> = { high: 'Alta', medium: 'Media', low: 'Baja' };

type NarrativeSection = 'approach' | keyof Narrative;
const SECTION_LABELS: Record<NarrativeSection, string> = {
  approach: 'Cómo se hizo', purpose: 'Propósito', openItems: 'Pendiente o incierto',
  learnings: 'Aprendizajes clave', confidence: 'Confianza',
};
/** What each detail level shows after the summary, in reading order. Detailed also adds Estado. */
const LEVEL_SECTIONS: Record<Answers['summary'], readonly NarrativeSection[]> = {
  low: [],
  medium: ['purpose', 'learnings'],
  detailed: ['approach', 'purpose', 'openItems', 'learnings', 'confidence'],
};
const UNREPORTED = 'El agente no lo informó.';

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
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) {
    throw new ValidationError('Report text must be nonempty and free of terminal control characters.');
  }
  return value.trim();
}

/** Validates a recorded narrative; a level outside the three is a claim nobody can read. */
export function parseNarrative(value: unknown): Narrative {
  const input = objectWithKeys(value, 'report narrative', ['purpose', 'openItems', 'learnings', 'confidence']);
  const result: Narrative = {};
  for (const key of ['purpose', 'openItems', 'learnings'] as const) {
    if (input[key] !== undefined) result[key] = text(input[key]);
  }
  if (input.confidence !== undefined) {
    const confidence = objectWithKeys(input.confidence, 'report confidence', ['level', 'reason']);
    if (!Object.hasOwn(CONFIDENCE_LABELS, confidence.level as string)) throw new ValidationError('Report confidence level must be high, medium or low.');
    result.confidence = { level: confidence.level as ConfidenceLevel, reason: text(confidence.reason) };
  }
  return result;
}

const DETAILS: readonly string[] = Object.keys(LEVEL_SECTIONS);

export function renderReport(detail: Answers['summary'], value: PhaseReport): string {
  if (!DETAILS.includes(detail)) throw new ValidationError('Unknown report detail.');
  const input = objectWithKeys(value, 'report', ['phase', 'summary', 'how', 'status', 'evidence', 'narrative']);
  if (typeof input.phase !== 'string' || !PHASES.includes(input.phase as Phase)) {
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
  const narrative = input.narrative === undefined ? undefined : parseNarrative(input.narrative);
  const body = (section: NarrativeSection): string | undefined => {
    const reported = section === 'approach' ? (how.length > 1 ? how.map(item => `- ${item}`).join('\n') : how[0])
      : section === 'confidence' ? narrative?.confidence && `${CONFIDENCE_LABELS[narrative.confidence.level]} — ${narrative.confidence.reason}`
      : narrative?.[section];
    // A section the actor left out of its own report is said to be missing; one that no actor was
    // ever asked for (a placeholder, the risk stop) is simply not there.
    return reported ?? (narrative ? UNREPORTED : undefined);
  };
  const parts = [`Resumen (${phaseLabel(input.phase as Phase)})\n${summary}`];
  for (const section of LEVEL_SECTIONS[detail]) {
    const content = body(section);
    if (content !== undefined) parts.push(`${SECTION_LABELS[section]}\n${content}`);
  }
  if (detail === 'detailed') parts.push(`Estado\n${STATUS_LABELS[input.status as ReportStatus]}`);
  return `${parts.join('\n\n')}\n`;
}

export function renderClosure(detail: Answers['summary'], input: { goal: string; changes: string; how?: string[]; narrative?: Narrative; matched: boolean; checks: Check[]; limits: string[]; status: ReportStatus; evidence: Evidence }): string {
  if (input.status === 'passed' && (!input.checks.length || input.evidence.checks !== 'confirmed' || !input.matched)) throw new ValidationError('Successful closure requires matched acceptance and confirmed executed checks.');
  if (input.matched && input.status !== 'passed') throw new ValidationError('An incomplete closure cannot claim requirements and plan matched.');
  // A command that exited nonzero is evidence, and a closure that counts it among the others
  // reports a calmer run than the one that happened. It is counted apart and named apart.
  const failed = input.checks.filter(check => check.exit !== 0);
  const changes = text(input.changes);
  const summary = `${text(input.goal)} ${changes} ${input.matched ? 'Evaluación del agente: los requisitos y el plan coinciden con lo implementado.' : 'Sin completar: los requisitos y el plan no están verificados del todo.'}${input.limits.length ? `\nPendiente: ${input.limits.map(text).join(' ')}` : ''}${input.matched ? '' : '\nPodés pedir una mejora, rechazar el resultado o solicitar una nueva implementación con correcciones según las brechas indicadas.'}`;
  const report = renderReport(detail, { phase: 'mdd-verify', summary, how: input.how ?? [], status: input.status, evidence: input.evidence,
    ...(input.narrative ? { narrative: input.narrative } : {}) }).replace(`Resumen (${phaseLabel('mdd-verify')})`, 'Resumen');
  if (detail === 'low') return report;
  const verification = input.checks.length
    ? input.checks.map(check => `- ${text(check.command)}: salida ${check.exit ?? 'desconocida'}${check.exit === 0 ? ' (informada; no demuestra por sí sola el comportamiento)' : ' (no confirma el resultado)'}.`).join('\n')
    : 'No se informaron comprobaciones ejecutadas; el resultado no está confirmado.';
  const section = `\n\nVerificación\n${verification}${failed.length ? `\n${failed.length} comprobación(es) no concluyeron satisfactoriamente.` : ''}`;
  if (detail !== 'detailed') return `${report.trimEnd()}${section}\n`;
  // Estado is always the last section, so the last occurrence is the frame's own heading even if
  // a narrative happened to contain the same word on a line of its own.
  const status = report.lastIndexOf('\n\nEstado\n');
  return `${report.slice(0, status)}${section}${report.slice(status)}`;
}
