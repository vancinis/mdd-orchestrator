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
  // Apply is told to report the commands it ran, and for a long time reporting them was what got
  // it rejected: the field belonged to Verify alone. Implementation checks are evidence the phase
  // genuinely produced, so it keeps them. They are recorded as its claim; only Verify's checks
  // earn the checks evidence flag.
  'mdd-apply': ['changes', 'noChangeReason', 'checks', 'delivered', 'completed'],
  'mdd-verify': ['checks', 'verification'],
});
export const FIELD_SCHEMA: Record<string, string> = {
  completed: 'completed=[assignedStepID] lists exactly the one assigned deliverable actually finished. A failed or partial batch earns no completion; report outcome failed, never guess or claim another step.',
  acceptance: 'acceptance={goal,requirements:[{id,description,scenarios:[{id,given,when,then}]}]}. Keep IDs stable.',
  decisions: 'decisions=[{id,description,requirements:[requirementID]}]; empty when the work needs no decision.',
  deliverables: 'deliverables=[{id,description,path,check,scenarios:[scenarioID],decisions:[decisionID],dependsOn:[earlierStepID],parallel?:{complete:true,reads:[filePath],writes:[filePath]}}]. Keep IDs stable. Every scenario and relevant decision must map to an applicable step. Optional parallel metadata requires explicit dependsOn (including [] when independent) and complete exact root-relative file scopes, including shared outputs/tests/docs/lockfiles; include every task/code/data dependency, never guess independence. Use slash-separated portable ASCII paths without traversal, aliases, directories or globs. Apply eligibility needs nonempty writes; missing/incomplete scopes or omitted dependencies remain sequential. This records eligibility only; concurrency is not active.',
  domain: 'domain="project", the fixed storage namespace.',
  changes: 'changes=[{path,reason}] lists the files this phase actually changed and why each one had to change. A bare path string is accepted where there is nothing to add.',
  noChangeReason: 'noChangeReason=text instead of changes when nothing needed changing.',
  delivered: 'delivered={what,implies} summarises the finished change for whoever reviews the pull request: what is now possible or different (what), and what that enables or requires of them (implies). Describe the outcome, never the mechanics — the per-file reasons already say how.',
  checks: 'checks=[{command,exit}] reports only checks this phase actually ran, at most 32. command is the exact command on one line, of any length, with no line breaks, tabs or other control characters; exit is its integer exit code, or null when it did not finish.',
  verification: 'verification={scenarios:[{requirementID,scenarioID,stepID,status,checks:[command],assessment}],steps:[{stepID,status,checks,assessment}],decisions:[{decisionID,status,checks,assessment}],changes,limits:[]}. Status is verified/not-verified/deviation. Each checks entry repeats a command exactly as reported in checks; a verified row names at least one, and every one it names exited 0. Assessment explains source evidence and limits, not just a pass label. assessment and changes are one line of at most 500 characters; limits holds at most four one-line items of at most 250 characters each. Cover all held links exactly once.',
};
/**
 * Fields a phase reported that belong to no phase. They are dropped rather than fatal: a finished
 * phase must not be discarded over a key it added in good faith, and the actor is told which ones
 * were ignored so the next report is cleaner. Fields that carry meaning are still validated.
 */
export function phaseFields(phase: Phase, result: Record<string, unknown>): { fields: Record<string, unknown>; ignored: string[] } {
  const allowed = new Set(['phase', 'runID', 'callID', 'outcome', 'evidenceSummary', 'how', 'purpose', 'openItems', 'learnings', 'confidence', 'artifact', 'concerns', 'questions', ...PHASE_RESULT_FIELDS[phase]]);
  const fields: Record<string, unknown> = {};
  const ignored: string[] = [];
  for (const [key, value] of Object.entries(result)) {
    if (allowed.has(key)) fields[key] = value; else ignored.push(key);
  }
  return { fields, ignored: ignored.slice(0, 16) };
}
/** A control character named so it can be found: its code point, and what it usually is. */
function controlName(character: string): string {
  const code = character.codePointAt(0)!;
  const usual: Record<number, string> = { 9: 'a tab', 10: 'a line break', 13: 'a carriage return' };
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}${usual[code] ? ` (${usual[code]})` : ''}`;
}
/**
 * One-line report text. The rejection says which rule failed, where, and on what value: a message
 * that listed every rule at once once sent a coordinator looking for a control character in a
 * command whose only problem was its length, with no way to tell which of twelve commands it was.
 * `max` may be `Infinity` where a length limit protects nothing, as for an executed command.
 */
export function shortText(value: unknown, label: string, max = 500): string {
  if (value === undefined) throw new Error(`${label} is missing.`);
  if (typeof value !== 'string') throw new Error(`${label} must be text; it read ${preview(value)}.`);
  if (!value.trim()) throw new Error(`${label} is empty; give nonempty text.`);
  const control = /[\x00-\x1f\x7f]/.exec(value);
  const problems = [
    ...(control ? [`contains the control character ${controlName(control[0])} at character ${control.index + 1}`] : []),
    ...(value.length > max ? [`is ${value.length} characters, above its ${max}-character limit`] : []),
  ];
  if (problems.length) {
    const fixes = [...(control ? ['keep it on one line without control characters'] : []), ...(value.length > max ? ['shorten it'] : [])];
    throw new Error(`${label} ${preview(value)} ${problems.join(' and ')}. To fix it, ${fixes.join(' and ')}.`);
  }
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
/**
 * How many problems one rejection carries. Enough that a plan is normally fixed in a single pass;
 * bounded because a message the actor cannot hold is no more useful than the one-at-a-time
 * rejections this replaces.
 */
export const MAX_REPORTED_PROBLEMS = 8;
/**
 * Raises everything wrong with a report at once.
 *
 * These checks are independent: none of them depends on an earlier one holding, so stopping at
 * the first only hid the rest. What that cost is not abstract — a plan rejected for an unlinked
 * decision was rewritten in full, re-sent, and rejected for the next unlinked decision, three
 * times in a row on one observed run, each round re-emitting the whole document. Reporting them
 * together turns that into one correction.
 *
 * A single problem is still phrased exactly as it always was: it is the common case, and wrapping
 * one complaint in a list of one makes the message harder to act on, not easier.
 */
export function raise(problems: readonly string[], subject: string): void {
  if (!problems.length) return;
  if (problems.length === 1) throw new Error(problems[0]!);
  const shown = problems.slice(0, MAX_REPORTED_PROBLEMS);
  const more = problems.length - shown.length;
  throw new Error(`${subject} has ${problems.length} problem(s), and they are all in the report rather than in the work. Fix them together and restate the report once: ${shown.map((problem, index) => `(${index + 1}) ${problem}`).join(' ')}${more ? ` ...and ${more} more of the same kind.` : ''}`);
}
export function validatePlan(accepted: Acceptance, choices: Decision[], steps: Deliverable[]): void {
  const scenarios = accepted.requirements.flatMap(requirement => requirement.scenarios.map(scenario => ({ id: scenario.id, requirement: requirement.id })));
  const previous = new Set<string>();
  const problems: string[] = [];
  // Every rejection names the step, the reference and why it does not hold: a plan is remapped by
  // hand after this message, and an unnamed ID forces the actor to guess the whole remapping.
  for (const step of steps) {
    const unknownScenario = step.scenarios.find(key => !scenarios.some(item => item.id === key));
    if (unknownScenario !== undefined) problems.push(`Plan deliverable ${step.id} references unknown scenario ${unknownScenario}. Accepted scenarios: ${scenarios.map(item => item.id).join(', ')}.`);
    const unordered = step.dependsOn.find(key => !previous.has(key));
    if (unordered !== undefined) problems.push(`Plan deliverable ${step.id} depends on ${unordered}, which is not an earlier deliverable. Dependencies may only name steps listed before it.`);
    for (const key of step.decisions) {
      const decision = choices.find(item => item.id === key);
      if (!decision) { problems.push(`Plan deliverable ${step.id} references unknown decision ${key}. Plan decisions: ${choices.length ? choices.map(item => item.id).join(', ') : 'none'}.`); continue; }
      // Applicability is only answerable once every scenario on this step is one that exists.
      // Asking it of an unknown scenario would report a second, invented problem for one mistake.
      if (unknownScenario !== undefined) continue;
      if (!step.scenarios.some(key => decision.requirements.includes(scenarios.find(item => item.id === key)!.requirement))) {
        problems.push(`Plan deliverable ${step.id} references decision ${key}, which is not applicable to its scenarios (${step.scenarios.map(scenario => `${scenario} belongs to requirement ${scenarios.find(item => item.id === scenario)!.requirement}`).join('; ')}; ${key} covers ${decision.requirements.join(', ')}).`);
      }
    }
    previous.add(step.id);
  }
  if (steps.reduce((count, step) => count + step.scenarios.length, 0) > 64) problems.push('Plan exceeds 64 scenario-to-step links.');
  for (const scenario of scenarios) {
    if (!steps.some(step => step.scenarios.includes(scenario.id))) problems.push(`Plan omits accepted scenario ${scenario.id} of requirement ${scenario.requirement}: no deliverable covers it.`);
  }
  for (const decision of choices) {
    for (const required of decision.requirements) {
      if (!steps.some(step => step.decisions.includes(decision.id) && step.scenarios.some(key => scenarios.find(item => item.id === key)?.requirement === required))) {
        problems.push(`Plan omits decision ${decision.id} on requirement ${required}: no deliverable both references ${decision.id} and covers a scenario of ${required}.`);
      }
    }
  }
  raise(problems, 'The plan');
}
/** The plan a verification answers to. Without it, only the report's own consistency is checked. */
export type HeldPlan = { accepted: Acceptance; choices: Decision[]; planned: Deliverable[] };
/** One wording for a passed Verify whose own assessments do not support a match, wherever it is checked. */
export const UNMATCHED_PASS = 'Requirements or plan remain not verified or deviate from the held plan. Report outcome failed, or close the gaps, rather than claiming a match the assessments do not support.';
/** Runs one independent check and keeps its complaint, instead of stopping the whole reading at it. */
function attempt<T>(problems: string[], read: () => T): T | undefined {
  try { return read(); }
  catch (error) { problems.push(error instanceof Error ? error.message : String(error)); return undefined; }
}
/**
 * Reads a verification report and collects everything wrong with it, rather than the first thing.
 *
 * A Verify report is the most expensive document a run restates: it arrives after every check has
 * run, and on one observed run it was 33 KB. Stopping at the first problem there meant a command
 * that was too long was fixed, re-sent, and then rejected again for a fifth limit that had been in
 * the same report all along. Every check below is independent of the others, so they all run.
 *
 * `reported` and `passed` are the commands the same report says it ran, and which of them exited
 * 0. They are undefined when the checks list itself could not be read: that list is reported once,
 * not once more for every assessment that cites it. Without `held`, IDs are checked as IDs only —
 * which links exist is state the run holds — and that is the form `mdd_check_report` can answer.
 */
export function readVerification(value: unknown, held: HeldPlan | undefined, reported: readonly string[] | undefined, passed: readonly string[] | undefined): { verification?: Verification; problems: string[] } {
  const problems: string[] = [];
  const input = attempt(problems, () => objectWithKeys(value, 'verification', ['scenarios', 'steps', 'decisions', 'changes', 'limits']));
  if (!input) return { problems };
  const assess = (entry: Record<string, unknown>, label: string): Assessment | undefined => {
    const own: string[] = [];
    const status = ['verified', 'not-verified', 'deviation'].includes(String(entry.status)) ? entry.status as Assessment['status'] : undefined;
    if (!status) own.push(`The assessment of ${label} has unknown status ${preview(entry.status)}. Use verified, not-verified or deviation.`);
    const checks = attempt(own, () => items(entry.checks, `assessment checks of ${label}`, true).map((value, index) => shortText(value, `check reference ${index + 1} of ${label}`, Infinity)));
    if (checks) {
      const duplicate = checks.find((command, index) => checks.indexOf(command) !== index);
      if (duplicate !== undefined) own.push(`The assessment of ${label} repeats the check reference ${preview(duplicate)}.`);
      if (status === 'verified' && !checks.length) own.push(`The verified assessment of ${label} must name the check it relies on.`);
      // The report must be internally consistent: an assessment cannot lean on a check the same
      // phase never reported running. MDD does not re-run it, so this is the honesty it can offer.
      const unreported = reported && checks.find(command => !reported.includes(command));
      const failed = status === 'verified' && passed ? checks.find(command => !passed.includes(command)) : undefined;
      if (unreported !== undefined) own.push(`The assessment of ${label} cites check ${preview(unreported)}, which this phase did not report running. Reported checks: ${reported!.length ? reported!.map(preview).join(', ') : 'none'}.`);
      else if (failed !== undefined) own.push(`The verified assessment of ${label} rests on check ${preview(failed)}, which did not pass.`);
    }
    const assessment = attempt(own, () => shortText(entry.assessment, `source-based assessment of ${label}`));
    problems.push(...own);
    return own.length ? undefined : { status: status!, checks: checks!, assessment: assessment! };
  };
  // A row whose assessment is malformed still covers its link: counting it as missing too would
  // report one mistake twice.
  const expected = held ? held.planned.flatMap(step => step.scenarios.map(scenarioID => ({ step, scenarioID, requirementID: held.accepted.requirements.find(item => item.scenarios.some(scenario => scenario.id === scenarioID))!.id }))) : [];
  const scenarios: Verification['scenarios'] = [];
  const coveredLinks: { scenarioID: string; stepID: string }[] = [];
  for (const value of attempt(problems, () => items(input.scenarios, 'scenario coverage')) ?? []) {
    const entry = attempt(problems, () => objectWithKeys(value, 'scenario coverage', ['requirementID', 'scenarioID', 'stepID', 'status', 'checks', 'assessment']));
    if (!entry) continue;
    let link: { requirementID: string; scenarioID: string; stepID: string } | undefined;
    if (held) {
      const found = expected.find(item => item.requirementID === entry.requirementID && item.scenarioID === entry.scenarioID && item.step.id === entry.stepID);
      if (!found) { problems.push(`Verification invents the link ${preview(entry.requirementID)}/${preview(entry.scenarioID)}/${preview(entry.stepID)}. Held links: ${expected.map(item => `${item.requirementID}/${item.scenarioID}/${item.step.id}`).join(', ')}.`); continue; }
      link = { requirementID: found.requirementID, scenarioID: found.scenarioID, stepID: found.step.id };
    } else {
      link = attempt(problems, () => ({ requirementID: id(entry.requirementID, 'scenario coverage requirementID'), scenarioID: id(entry.scenarioID, 'scenario coverage scenarioID'), stepID: id(entry.stepID, 'scenario coverage stepID') }));
      if (!link) continue;
    }
    coveredLinks.push(link);
    const checked = assess(entry, `scenario ${link.scenarioID} on deliverable ${link.stepID}`);
    if (checked) scenarios.push({ ...link, ...checked });
  }
  const missingLinks = expected.filter(item => !coveredLinks.some(covered => covered.scenarioID === item.scenarioID && covered.stepID === item.step.id));
  const repeatedLink = coveredLinks.find((item, index) => coveredLinks.findIndex(other => other.scenarioID === item.scenarioID && other.stepID === item.stepID) !== index);
  if (missingLinks.length) problems.push(`Verification omits scenario coverage for ${missingLinks.map(item => `${item.scenarioID} on ${item.step.id}`).join(', ')}.`);
  if (repeatedLink) problems.push(`Verification covers scenario ${repeatedLink.scenarioID} on deliverable ${repeatedLink.stepID} more than once.`);
  const steps: Verification['steps'] = [];
  const coveredSteps: string[] = [];
  for (const value of attempt(problems, () => items(input.steps, 'step coverage')) ?? []) {
    const entry = attempt(problems, () => objectWithKeys(value, 'step coverage', ['stepID', 'status', 'checks', 'assessment']));
    if (!entry) continue;
    const stepID = held ? held.planned.find(item => item.id === entry.stepID)?.id : attempt(problems, () => id(entry.stepID, 'step coverage stepID'));
    if (stepID === undefined) {
      if (held) problems.push(`Verification invents planned deliverable ${preview(entry.stepID)}. Planned deliverables: ${held.planned.map(item => item.id).join(', ')}.`);
      continue;
    }
    coveredSteps.push(stepID);
    const checked = assess(entry, `deliverable ${stepID}`);
    if (checked) steps.push({ stepID, ...checked });
  }
  const decisions: Verification['decisions'] = [];
  const coveredDecisions: string[] = [];
  for (const value of attempt(problems, () => items(input.decisions, 'decision coverage', true)) ?? []) {
    const entry = attempt(problems, () => objectWithKeys(value, 'decision coverage', ['decisionID', 'status', 'checks', 'assessment']));
    if (!entry) continue;
    const decisionID = held ? held.choices.find(item => item.id === entry.decisionID)?.id : attempt(problems, () => id(entry.decisionID, 'decision coverage ID'));
    if (decisionID === undefined) {
      if (held) problems.push(`Verification invents plan decision ${preview(entry.decisionID)}. Plan decisions: ${held.choices.length ? held.choices.map(item => item.id).join(', ') : 'none'}.`);
      continue;
    }
    coveredDecisions.push(decisionID);
    const checked = assess(entry, `decision ${decisionID}`);
    if (checked) decisions.push({ decisionID, ...checked });
  }
  for (const step of held?.planned ?? []) if (!coveredSteps.includes(step.id)) problems.push(`Verification omits coverage of planned deliverable ${step.id}.`);
  const repeatedStep = coveredSteps.find((item, index) => coveredSteps.indexOf(item) !== index);
  if (repeatedStep !== undefined) problems.push(`Verification covers planned deliverable ${repeatedStep} more than once.`);
  for (const decision of held?.choices ?? []) if (!coveredDecisions.includes(decision.id)) problems.push(`Verification omits coverage of plan decision ${decision.id}.`);
  const repeatedDecision = coveredDecisions.find((item, index) => coveredDecisions.indexOf(item) !== index);
  if (repeatedDecision !== undefined) problems.push(`Verification covers plan decision ${repeatedDecision} more than once.`);
  const listed = attempt(problems, () => items(input.limits, 'remaining limits', true)) ?? [];
  const limits = listed.map((value, index) => attempt(problems, () => shortText(value, `remaining limit ${index + 1}`, 250)));
  if (listed.length > 4) problems.push(`Summarize material limits in at most four concise items; this report lists ${listed.length}. Merge or drop the least material ones.`);
  const changes = attempt(problems, () => shortText(input.changes, 'what changed'));
  if (problems.length) return { problems };
  return { problems, verification: { scenarios, steps, decisions, changes: changes!, limits: limits as string[], matched: [...scenarios, ...steps, ...decisions].every(item => item.status === 'verified') } };
}
export function verification(value: unknown, accepted: Acceptance, choices: Decision[], planned: Deliverable[], reported: string[] = [], passed: string[] = reported): Verification {
  const read = readVerification(value, { accepted, choices, planned }, reported, passed);
  raise(read.problems, 'The verification report');
  return read.verification!;
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
