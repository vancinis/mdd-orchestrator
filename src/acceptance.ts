import { objectWithKeys } from './validation.js';
import type { Deliverable } from './phase-evidence.js';
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
/**
 * One source for the per-phase result fields: the result validator and the phase prompt both read
 * it. A prompt that described every field to every phase made mdd-plan fill verification and get
 * rejected for it, so the schema a phase is shown can no longer diverge from what it may return.
 */
export const PHASE_RESULT_FIELDS: Record<Phase, readonly string[]> = Object.freeze({
  'mdd-explore': [], 'mdd-propose': [],
  'mdd-plan': ['acceptance', 'decisions', 'deliverables'],
  'mdd-spec': ['domain', 'acceptance'],
  'mdd-design': ['decisions'],
  'mdd-tasks': ['deliverables'],
  'mdd-apply': ['changes', 'noChangeReason'],
  'mdd-verify': ['checks', 'verification'],
});
const FIELD_SCHEMA: Record<string, string> = {
  acceptance: 'acceptance={goal,requirements:[{id,description,scenarios:[{id,given,when,then}]}]}. Keep IDs stable.',
  decisions: 'decisions=[{id,description,requirements:[requirementID]}]; empty when the work needs no decision.',
  deliverables: 'deliverables=[{id,description,path,check,scenarios:[scenarioID],decisions:[decisionID],dependsOn:[earlierStepID]}]. Keep IDs stable. Every scenario and relevant decision must map to an applicable step.',
  domain: 'domain="project", the fixed storage namespace.',
  changes: 'changes=[changedPath] lists the files this phase actually changed.',
  noChangeReason: 'noChangeReason=text instead of changes when nothing needed changing.',
  checks: 'checks=[{command,exit}] reports only checks this phase actually ran.',
  verification: 'verification={scenarios:[{requirementID,scenarioID,stepID,status,checks:[command],assessment}],steps:[{stepID,status,checks,assessment}],decisions:[{decisionID,status,checks,assessment}],changes,limits:[]}. Status is verified/not-verified/deviation. Assessment explains source evidence and limits, not just a pass label. Cover all held links exactly once.',
};
/** Prompt text for exactly the fields this phase may return, and for no other field. */
export function phaseSchemaLines(phase: Phase): string[] {
  const fields = PHASE_RESULT_FIELDS[phase];
  return [
    fields.length
      ? `Phase fields for ${phase}: ${fields.join(', ')}. Any other field is rejected, so do not report fields belonging to another phase. Never emit confidence percentages.`
      : `Phase fields for ${phase}: none beyond the common result object. Any extra field is rejected. Never emit confidence percentages.`,
    ...fields.map(field => FIELD_SCHEMA[field]!),
  ];
}
export function shortText(value: unknown, label: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label} must be concise nonempty text without control characters.`);
  return value.trim();
}
/** Rejected values are echoed back bounded: an actor can only remap an ID it can see named. */
function preview(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return JSON.stringify(text.length > 64 ? `${text.slice(0, 64)}…` : text);
}
function id(value: unknown, label = 'Traceability ID'): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value)) throw new Error(`${label} ${preview(value)} must be a stable short identifier of 1–64 letters, digits, underscores or hyphens.`);
  return value;
}
function items(value: unknown, label: string, empty = false): unknown[] {
  if (!Array.isArray(value) || value.length > 64 || (!empty && !value.length)) throw new Error(`${label} requires ${empty ? '0' : '1'}–64 entries.`);
  return value;
}
export function references(value: unknown, label: string, empty = false): string[] {
  const result = items(value, label, empty).map(item => id(item, label));
  const duplicate = result.find((item, index) => result.indexOf(item) !== index);
  if (duplicate !== undefined) throw new Error(`${label} repeats the reference ${duplicate}.`);
  return result;
}
export function acceptance(value: unknown): Acceptance {
  const map = objectWithKeys(value, 'acceptance', ['goal', 'requirements']);
  const seen = new Set<string>();
  const unique = (value: unknown, label: string) => { const key = id(value, label); if (seen.has(key)) throw new Error(`Requirement/scenario ID ${key} is used more than once in the acceptance map.`); seen.add(key); return key; };
  const requirements = items(map.requirements, 'requirements').map(value => {
    const requirement = objectWithKeys(value, 'requirement', ['id', 'description', 'scenarios']);
    const requirementID = unique(requirement.id, 'requirement ID');
    return { id: requirementID, description: shortText(requirement.description, `requirement ${requirementID} description`), scenarios: items(requirement.scenarios, `scenarios of requirement ${requirementID}`).map(value => {
      const scenario = objectWithKeys(value, 'scenario', ['id', 'given', 'when', 'then']);
      const scenarioID = unique(scenario.id, `scenario ID of requirement ${requirementID}`);
      return { id: scenarioID, given: shortText(scenario.given, `given of scenario ${scenarioID}`), when: shortText(scenario.when, `when of scenario ${scenarioID}`), then: shortText(scenario.then, `then of scenario ${scenarioID}`) };
    }) };
  });
  if (requirements.flatMap(item => item.scenarios).length > 64) throw new Error('Acceptance map exceeds 64 scenarios.');
  return { goal: shortText(map.goal, 'requested outcome', 300), requirements };
}
export function decisions(value: unknown, accepted: Acceptance): Decision[] {
  const seen = new Set<string>();
  return items(value, 'decisions', true).map(value => {
    const decision = objectWithKeys(value, 'decision', ['id', 'description', 'requirements']);
    const key = id(decision.id, 'decision ID');
    if (seen.has(key)) throw new Error(`Decision ID ${key} is used more than once.`);
    seen.add(key);
    const required = references(decision.requirements, `requirements of decision ${key}`);
    const unknown = required.find(key => !accepted.requirements.some(item => item.id === key));
    if (unknown !== undefined) throw new Error(`Decision ${key} references unknown requirement ${unknown}. Accepted requirements: ${accepted.requirements.map(item => item.id).join(', ')}.`);
    return { id: key, description: shortText(decision.description, `decision ${key} description`), requirements: required };
  });
}
export function validatePlan(accepted: Acceptance, choices: Decision[], steps: Deliverable[]): void {
  const scenarios = accepted.requirements.flatMap(requirement => requirement.scenarios.map(scenario => ({ id: scenario.id, requirement: requirement.id })));
  const previous = new Set<string>();
  // Every rejection names the step, the reference and why it does not hold: a plan is remapped by
  // hand after this message, and an unnamed ID forces the actor to guess the whole remapping.
  for (const step of steps) {
    const unknownScenario = step.scenarios.find(key => !scenarios.some(item => item.id === key));
    if (unknownScenario !== undefined) throw new Error(`Plan deliverable ${step.id} references unknown scenario ${unknownScenario}. Accepted scenarios: ${scenarios.map(item => item.id).join(', ')}.`);
    const unordered = step.dependsOn.find(key => !previous.has(key));
    if (unordered !== undefined) throw new Error(`Plan deliverable ${step.id} depends on ${unordered}, which is not an earlier deliverable. Dependencies may only name steps listed before it.`);
    for (const key of step.decisions) {
      const decision = choices.find(item => item.id === key);
      if (!decision) throw new Error(`Plan deliverable ${step.id} references unknown decision ${key}. Plan decisions: ${choices.length ? choices.map(item => item.id).join(', ') : 'none'}.`);
      if (!step.scenarios.some(key => decision.requirements.includes(scenarios.find(item => item.id === key)!.requirement))) {
        throw new Error(`Plan deliverable ${step.id} references decision ${key}, which is not applicable to its scenarios (${step.scenarios.map(scenario => `${scenario} belongs to requirement ${scenarios.find(item => item.id === scenario)!.requirement}`).join('; ')}; ${key} covers ${decision.requirements.join(', ')}).`);
      }
    }
    previous.add(step.id);
  }
  if (steps.reduce((count, step) => count + step.scenarios.length, 0) > 64) throw new Error('Plan exceeds 64 scenario-to-step links.');
  const uncovered = scenarios.find(scenario => !steps.some(step => step.scenarios.includes(scenario.id)));
  if (uncovered) throw new Error(`Plan omits accepted scenario ${uncovered.id} of requirement ${uncovered.requirement}: no deliverable covers it.`);
  for (const decision of choices) {
    const missing = decision.requirements.find(required => !steps.some(step => step.decisions.includes(decision.id) && step.scenarios.some(key => scenarios.find(item => item.id === key)?.requirement === required)));
    if (missing !== undefined) throw new Error(`Plan omits decision ${decision.id} on requirement ${missing}: no deliverable both references ${decision.id} and covers a scenario of ${missing}.`);
  }
}
export function verification(value: unknown, accepted: Acceptance, choices: Decision[], planned: Deliverable[], reported: string[] = [], passed: string[] = reported): Verification {
  const input = objectWithKeys(value, 'verification', ['scenarios', 'steps', 'decisions', 'changes', 'limits']);
  const assess = (entry: Record<string, unknown>, label: string): Assessment => {
    if (!['verified', 'not-verified', 'deviation'].includes(String(entry.status))) throw new Error(`The assessment of ${label} has unknown status ${preview(entry.status)}. Use verified, not-verified or deviation.`);
    const checks = items(entry.checks, `assessment checks of ${label}`, true).map(value => shortText(value, `check reference of ${label}`, 500));
    const duplicate = checks.find((command, index) => checks.indexOf(command) !== index);
    if (duplicate !== undefined) throw new Error(`The assessment of ${label} repeats the check reference ${preview(duplicate)}.`);
    if (entry.status === 'verified' && !checks.length) throw new Error(`The verified assessment of ${label} must name the check it relies on.`);
    // The report must be internally consistent: an assessment cannot lean on a check the same
    // phase never reported running. MDD does not re-run it, so this is the honesty it can offer.
    const unreported = checks.find(command => !reported.includes(command));
    if (unreported !== undefined) throw new Error(`The assessment of ${label} cites check ${preview(unreported)}, which this phase did not report running. Reported checks: ${reported.length ? reported.map(preview).join(', ') : 'none'}.`);
    const failed = entry.status === 'verified' ? checks.find(command => !passed.includes(command)) : undefined;
    if (failed !== undefined) throw new Error(`The verified assessment of ${label} rests on check ${preview(failed)}, which did not pass.`);
    return { status: entry.status as Assessment['status'], checks, assessment: shortText(entry.assessment, `source-based assessment of ${label}`) };
  };
  const expected = planned.flatMap(step => step.scenarios.map(scenarioID => ({ step, scenarioID, requirementID: accepted.requirements.find(item => item.scenarios.some(scenario => scenario.id === scenarioID))!.id })));
  const scenarios = items(input.scenarios, 'scenario coverage').map(value => {
    const entry = objectWithKeys(value, 'scenario coverage', ['requirementID', 'scenarioID', 'stepID', 'status', 'checks', 'assessment']);
    const link = expected.find(item => item.requirementID === entry.requirementID && item.scenarioID === entry.scenarioID && item.step.id === entry.stepID);
    if (!link) throw new Error(`Verification invents the link ${preview(entry.requirementID)}/${preview(entry.scenarioID)}/${preview(entry.stepID)}. Held links: ${expected.map(item => `${item.requirementID}/${item.scenarioID}/${item.step.id}`).join(', ')}.`);
    return { requirementID: link.requirementID, scenarioID: link.scenarioID, stepID: link.step.id, ...assess(entry, `scenario ${link.scenarioID} on deliverable ${link.step.id}`) };
  });
  const missingLinks = expected.filter(item => !scenarios.some(covered => covered.scenarioID === item.scenarioID && covered.stepID === item.step.id));
  const repeatedLink = scenarios.find((item, index) => scenarios.findIndex(other => other.scenarioID === item.scenarioID && other.stepID === item.stepID) !== index);
  if (missingLinks.length) throw new Error(`Verification omits scenario coverage for ${missingLinks.map(item => `${item.scenarioID} on ${item.step.id}`).join(', ')}.`);
  if (repeatedLink) throw new Error(`Verification covers scenario ${repeatedLink.scenarioID} on deliverable ${repeatedLink.stepID} more than once.`);
  const steps = items(input.steps, 'step coverage').map(value => {
    const entry = objectWithKeys(value, 'step coverage', ['stepID', 'status', 'checks', 'assessment']);
    const step = planned.find(item => item.id === entry.stepID);
    if (!step) throw new Error(`Verification invents planned deliverable ${preview(entry.stepID)}. Planned deliverables: ${planned.map(item => item.id).join(', ')}.`);
    return { stepID: step.id, ...assess(entry, `deliverable ${step.id}`) };
  });
  const decisionCoverage = items(input.decisions, 'decision coverage', true).map(value => {
    const entry = objectWithKeys(value, 'decision coverage', ['decisionID', 'status', 'checks', 'assessment']);
    if (!choices.some(item => item.id === entry.decisionID)) throw new Error(`Verification invents plan decision ${preview(entry.decisionID)}. Plan decisions: ${choices.length ? choices.map(item => item.id).join(', ') : 'none'}.`);
    return { decisionID: id(entry.decisionID, 'decision coverage ID'), ...assess(entry, `decision ${String(entry.decisionID)}`) };
  });
  const uncoveredStep = planned.find(step => !steps.some(item => item.stepID === step.id));
  const repeatedStep = steps.find((item, index) => steps.findIndex(other => other.stepID === item.stepID) !== index);
  if (uncoveredStep) throw new Error(`Verification omits coverage of planned deliverable ${uncoveredStep.id}.`);
  if (repeatedStep) throw new Error(`Verification covers planned deliverable ${repeatedStep.stepID} more than once.`);
  const uncoveredDecision = choices.find(decision => !decisionCoverage.some(item => item.decisionID === decision.id));
  const repeatedDecision = decisionCoverage.find((item, index) => decisionCoverage.findIndex(other => other.decisionID === item.decisionID) !== index);
  if (uncoveredDecision) throw new Error(`Verification omits coverage of plan decision ${uncoveredDecision.id}.`);
  if (repeatedDecision) throw new Error(`Verification covers plan decision ${repeatedDecision.decisionID} more than once.`);
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
