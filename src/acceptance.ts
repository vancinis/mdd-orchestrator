import { objectWithKeys } from './validation.js';
import type { Deliverable, NativeEvidence } from './phase-evidence.js';
import type { Phase } from './policy.js';

export type Acceptance = { goal: string; requirements: { id: string; description: string; scenarios: { id: string; given: string; when: string; then: string }[] }[] };
export type Decision = { id: string; description: string; requirements: string[] };
type Assessment = { status: 'verified' | 'not-verified' | 'deviation'; checks: string[]; assessment: string };
export type Verification = {
  scenarios: (Assessment & { requirementID: string; scenarioID: string; stepID: string })[];
  steps: (Assessment & { stepID: string })[];
  decisions: (Assessment & { decisionID: string })[];
  changes: string; limits: string[]; matched: boolean;
};
export function shortText(value: unknown, label: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label} must be concise nonempty text without control characters.`);
  return value.trim();
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value)) throw new Error('Traceability IDs must be stable short identifiers.');
  return value;
}
function items(value: unknown, label: string, empty = false): unknown[] {
  if (!Array.isArray(value) || value.length > 64 || (!empty && !value.length)) throw new Error(`${label} requires ${empty ? '0' : '1'}–64 entries.`);
  return value;
}
export function references(value: unknown, label: string, empty = false): string[] {
  const result = items(value, label, empty).map(id);
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicate references.`);
  return result;
}
export function acceptance(value: unknown): Acceptance {
  const map = objectWithKeys(value, 'acceptance', ['goal', 'requirements']);
  const seen = new Set<string>();
  const unique = (value: unknown) => { const key = id(value); if (seen.has(key)) throw new Error('Duplicate requirement/scenario ID.'); seen.add(key); return key; };
  const requirements = items(map.requirements, 'requirements').map(value => {
    const requirement = objectWithKeys(value, 'requirement', ['id', 'description', 'scenarios']);
    return { id: unique(requirement.id), description: shortText(requirement.description, 'requirement'), scenarios: items(requirement.scenarios, 'scenarios').map(value => {
      const scenario = objectWithKeys(value, 'scenario', ['id', 'given', 'when', 'then']);
      return { id: unique(scenario.id), given: shortText(scenario.given, 'given'), when: shortText(scenario.when, 'when'), then: shortText(scenario.then, 'then') };
    }) };
  });
  if (requirements.flatMap(item => item.scenarios).length > 64) throw new Error('Acceptance map exceeds 64 scenarios.');
  return { goal: shortText(map.goal, 'requested outcome', 300), requirements };
}
export function decisions(value: unknown, accepted: Acceptance): Decision[] {
  const seen = new Set<string>();
  return items(value, 'decisions', true).map(value => {
    const decision = objectWithKeys(value, 'decision', ['id', 'description', 'requirements']);
    const key = id(decision.id);
    if (seen.has(key)) throw new Error('Duplicate decision ID.');
    seen.add(key);
    const required = references(decision.requirements, 'decision requirements');
    if (required.some(key => !accepted.requirements.some(item => item.id === key))) throw new Error('Decision references an unknown requirement.');
    return { id: key, description: shortText(decision.description, 'decision'), requirements: required };
  });
}
export function validatePlan(accepted: Acceptance, choices: Decision[], steps: Deliverable[]): void {
  const scenarios = accepted.requirements.flatMap(requirement => requirement.scenarios.map(scenario => ({ id: scenario.id, requirement: requirement.id })));
  const previous = new Set<string>();
  for (const step of steps) {
    if (step.scenarios.some(key => !scenarios.some(item => item.id === key)) || step.dependsOn.some(key => !previous.has(key))) throw new Error('Plan references an unknown scenario or a nonpreceding dependency.');
    for (const key of step.decisions) {
      const decision = choices.find(item => item.id === key);
      if (!decision || !step.scenarios.some(key => decision.requirements.includes(scenarios.find(item => item.id === key)!.requirement))) throw new Error('Plan decision is unknown or inapplicable to the step.');
    }
    previous.add(step.id);
  }
  if (steps.reduce((count, step) => count + step.scenarios.length, 0) > 64) throw new Error('Plan exceeds 64 scenario-to-step links.');
  if (scenarios.some(scenario => !steps.some(step => step.scenarios.includes(scenario.id)))) throw new Error('Plan omits an accepted scenario.');
  if (choices.some(decision => decision.requirements.some(required => !steps.some(step => step.decisions.includes(decision.id) && step.scenarios.some(key => scenarios.find(item => item.id === key)?.requirement === required))))) throw new Error('Plan omits a relevant decision requirement.');
}
export function verification(value: unknown, accepted: Acceptance, choices: Decision[], planned: Deliverable[], native: NativeEvidence | undefined): Verification {
  const input = objectWithKeys(value, 'verification', ['scenarios', 'steps', 'decisions', 'changes', 'limits']);
  const assess = (entry: Record<string, unknown>, commands: string[]): Assessment => {
    if (!['verified', 'not-verified', 'deviation'].includes(String(entry.status))) throw new Error('Unknown acceptance assessment status.');
    const checks = items(entry.checks, 'assessment checks', true).map(value => shortText(value, 'native check reference', 256));
    if (new Set(checks).size !== checks.length) throw new Error('Duplicate assessment check reference.');
    if (entry.status === 'verified' && !checks.length) throw new Error('Verified acceptance requires actual check references.');
    if (checks.some(key => !native?.checks.some(check => check.callID === key && commands.includes(check.command) && check.exit === 0))) throw new Error('Acceptance evidence is not an actual applicable planned check.');
    return { status: entry.status as Assessment['status'], checks, assessment: shortText(entry.assessment, 'source-based assessment') };
  };
  const expected = planned.flatMap(step => step.scenarios.map(scenarioID => ({ step, scenarioID, requirementID: accepted.requirements.find(item => item.scenarios.some(scenario => scenario.id === scenarioID))!.id })));
  const scenarios = items(input.scenarios, 'scenario coverage').map(value => {
    const entry = objectWithKeys(value, 'scenario coverage', ['requirementID', 'scenarioID', 'stepID', 'status', 'checks', 'assessment']);
    const link = expected.find(item => item.requirementID === entry.requirementID && item.scenarioID === entry.scenarioID && item.step.id === entry.stepID);
    if (!link) throw new Error('Verification invents a requirement/scenario/step link.');
    return { requirementID: link.requirementID, scenarioID: link.scenarioID, stepID: link.step.id, ...assess(entry, [link.step.check]) };
  });
  if (scenarios.length !== expected.length || new Set(scenarios.map(item => `${item.scenarioID}/${item.stepID}`)).size !== expected.length) throw new Error('Verification has missing or duplicate scenario coverage.');
  const steps = items(input.steps, 'step coverage').map(value => {
    const entry = objectWithKeys(value, 'step coverage', ['stepID', 'status', 'checks', 'assessment']);
    const step = planned.find(item => item.id === entry.stepID);
    if (!step) throw new Error('Verification invents a planned step.');
    return { stepID: step.id, ...assess(entry, [step.check]) };
  });
  const decisionCoverage = items(input.decisions, 'decision coverage', true).map(value => {
    const entry = objectWithKeys(value, 'decision coverage', ['decisionID', 'status', 'checks', 'assessment']);
    if (!choices.some(item => item.id === entry.decisionID)) throw new Error('Verification invents a plan decision.');
    return { decisionID: id(entry.decisionID), ...assess(entry, planned.filter(step => step.decisions.includes(String(entry.decisionID))).map(step => step.check)) };
  });
  if (steps.length !== planned.length || new Set(steps.map(item => item.stepID)).size !== planned.length || decisionCoverage.length !== choices.length || new Set(decisionCoverage.map(item => item.decisionID)).size !== choices.length) throw new Error('Verification has missing or duplicate plan coverage.');
  const limits = items(input.limits, 'remaining limits', true).map(value => shortText(value, 'remaining limit', 250));
  if (limits.length > 4) throw new Error('Summarize material limits in at most four concise items.');
  return { scenarios, steps, decisions: decisionCoverage, changes: shortText(input.changes, 'what changed'), limits, matched: [...scenarios, ...steps, ...decisionCoverage].every(item => item.status === 'verified') };
}
export const TRACE_HEADING = '## Acceptance and plan links';
/** The canonical trace section is adapter-owned; an actor writing it would fabricate links. */
export function assertNoTraceSection(artifact: string): string {
  if (artifact.includes(TRACE_HEADING)) {
    throw new Error('The artifact must not contain the adapter-owned acceptance and plan links section.');
  }
  return artifact;
}
export function traceArtifact(phase: Phase, text: string, accepted: Acceptance | undefined, choices: Decision[], planned: Deliverable[], checked?: Verification): string {
  const trace = phase === 'mdd-plan' ? { acceptance: accepted, decisions: choices, steps: planned } : phase === 'mdd-spec' ? { acceptance: accepted } : phase === 'mdd-design' ? { decisions: choices } : phase === 'mdd-tasks' ? { steps: planned } : phase === 'mdd-verify' ? { verification: checked } : undefined;
  return trace ? `${text}\n\n${TRACE_HEADING}\n\n\`\`\`json\n${JSON.stringify(trace, null, 2)}\n\`\`\`\n` : text;
}
