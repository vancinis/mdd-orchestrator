import type { Phase } from './policy.js';
import { injectedSkillNames } from './phase-assets.js';

export type VisualStatus = {
  phase?: Phase; state?: string; workflow?: { evaluation?: { route?: string; phases?: Phase[] }; results?: { phase: Phase; outcome: string }[] };
};

/** Presentation preferences are opt-in overrides, never workflow inputs. */
export function presentationSettings(environment: NodeJS.ProcessEnv = process.env): { ascii: boolean; toasts: boolean } {
  return { ascii: environment.MDD_ASCII === '1', toasts: environment.MDD_TOASTS !== '0' };
}

/** Display only: never use these strings to authorize dispatch or infer evidence. */
export function phaseVisual(status: VisualStatus, ascii = false): { route: string; progress: string; skills: string[] } | undefined {
  const evaluation = status.workflow?.evaluation;
  if (!evaluation?.phases?.length) return undefined;
  const completed = new Map(status.workflow?.results?.map(result => [result.phase, result.outcome]));
  const icons = ascii ? { passed: '[x]', failed: '[!]', active: '[>]', pending: '[ ]' } :
    { passed: '✅', failed: '❌', active: '🔵', pending: '○' };
  const progress = evaluation.phases.map(phase => {
    const outcome = completed.get(phase);
    const icon = outcome === 'passed' ? icons.passed : outcome ? icons.failed :
      phase === status.phase && status.state !== 'complete' ? icons.active : icons.pending;
    return `${icon} ${phase.replace('mdd-', '')}`;
  }).join('  ');
  return { route: evaluation.route ?? 'unknown', progress, skills: status.phase ? [...injectedSkillNames(status.phase)] : [] };
}

export function visualTitle(phase: Phase, ascii = false): string {
  const skills = injectedSkillNames(phase);
  return `${ascii ? '[MDD]' : '◆'} ${phase.replace('mdd-', '')}${skills?.length ? ` · ${skills.join(' + ')}` : ''}`;
}
