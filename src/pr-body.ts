import { assetText, PACKAGE_ROOT } from './project-assets.js';
import { objectWithKeys } from './validation.js';

export type PRFacts = { runID: string; goal: string; changes: string; changedFiles: number; checks: string[]; verified: boolean; uncertain: boolean; limits: string[] };
const HEADINGS = ['Summary', 'Changes', 'Environment variables', 'Follow-ups', 'Blockers', 'Deployment'];
/** Text a reader must not be shown: credentials, URLs, absolute paths, control characters. */
const UNSAFE = /[\x00-\x1f\x7f`]|\b[a-z][a-z0-9+.-]*:\/\/|[a-z]:[\\/]|(?:^|[\s('"=])(?:\/|~[\\/])|\\\\/i;
/**
 * Case matters in the assignment pattern. Run case-insensitively it matched ordinary prose like
 * "count = 5" and replaced a whole legitimate summary with a redaction notice, which reads as a
 * bug in the draft rather than as the protection it is. Only a SHOUTING_NAME= is a variable.
 */
const SECRET = /\b(?:password|secret|token|api[-_ ]?key|authorization)\s*[:=]|\b[A-Z][A-Z0-9_]{2,}\s*=|\b(?:sk-|ghp_|github_pat_|AIza)[A-Za-z0-9_-]{8,}/;
const OVERSIZE = 1000;
function safeCopy(value: string): string {
  // Oversize text is shortened rather than discarded: losing a long goal entirely tells the
  // reader less than the first part of it plus an explicit note that it was cut.
  const bounded = value.length > OVERSIZE ? `${value.slice(0, OVERSIZE).trimEnd()}… (truncated)` : value;
  if (!bounded.trim() || UNSAFE.test(bounded) || SECRET.test(bounded)) return 'Unverified: sensitive, path-bearing or unsupported text was omitted.';
  return bounded.trim().replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('[', '\\[').replaceAll(']', '\\]').replaceAll('#', '\\#');
}
export function renderPRBody(root: string, facts: PRFacts, userText: string, value: unknown = {}) {
  const skill = assetText(PACKAGE_ROOT, 'assets/opencode/skills/mdd-pr-body/SKILL.md');
  if (!/^---\r?\n(?:[^\n]*\n)*?name: mdd-pr-body\r?\n/.test(skill.content)) throw new Error('The exact packaged mdd-pr-body skill is required.');
  const template = assetText(PACKAGE_ROOT, 'assets/opencode/skills/mdd-pr-body/assets/template.md');
  const headings = [...template.content.matchAll(/^## (.+)$/gm)].map(match => match[1]);
  if (JSON.stringify(headings) !== JSON.stringify(HEADINGS)) throw new Error('The packaged PR template must retain the six approved sections in order.');
  const notes = objectWithKeys(value, 'PR notes', ['environmentVariables', 'followUps', 'deployment']);
  const human = (key: string): string => {
    // An absent optional note is the ordinary case: the user asked for a body and said nothing
    // about deployment. The template, the skill and the docs all answer that with "Not applicable."
    // Answering it with "Unverified" instead made every normal draft look like it had lost data.
    if (!Object.hasOwn(notes, key)) return 'Not applicable.';
    const note = notes[key];
    if (typeof note !== 'string' || !note.trim()) throw new Error(`PR note ${key} must be nonempty text, or be omitted entirely to render "Not applicable.".`);
    if (!userText.split(/\r?\n/).some(line => line.trim() === note.trim())) throw new Error(`PR note ${key} must quote a complete line of the actual latest user text; MDD does not author these sections.`);
    const safe = safeCopy(note);
    return safe === 'Not applicable.' ? safe : `User-provided, not independently verified: ${safe}`;
  };
  const commands = facts.checks.map(command => /^(?:npm|pnpm|yarn|bun) (?:test|run (?:test|typecheck|lint|check|build)(?:[:_-][a-z0-9_-]+)?)$/i.test(command) && safeCopy(command) === command
    ? `- Recorded command: ${command}; exit 0.` : '- Recorded command: omitted to avoid exposing arguments or paths; exit 0. Inspect local evidence.');
  const blockers = [
    ...(facts.changedFiles ? [] : ['No implementation change evidence was recorded; there may be nothing to propose.']),
    ...(facts.verified ? [] : ['Requirements and plan are not fully verified. Command exits alone do not establish completion.']),
    ...(facts.uncertain ? ['Execution or persistence is uncertain; do not retry or claim readiness.'] : []),
    ...facts.limits.map(safeCopy),
  ];
  const sections: Record<string, string> = {
    Summary: `Draft only. Nothing was committed, pushed or published. Publication requires a separate explicit decision.\n\n${safeCopy(facts.goal)}\n\n${facts.verified ? 'The recorded run completed; requirement/plan matching remains an agent assessment, not independent review.' : 'Unverified draft of the current run, not a completion claim.'}`,
    Changes: `- ${facts.changedFiles} scoped file(s) had recorded net changes.\n- ${facts.changedFiles ? safeCopy(facts.changes) : 'No implementation change was recorded.'}\n${commands.length ? commands.join('\n') : '- No verification command evidence was recorded.'}`,
    'Environment variables': human('environmentVariables'), 'Follow-ups': human('followUps'),
    Blockers: blockers.length ? blockers.map(item => `- ${item}`).join('\n') : 'Not applicable.', Deployment: human('deployment'),
  };
  const body = template.content.replace(/^## (.+)\r?\n[\s\S]*?(?=^## |$(?![\s\S]))/gm, (_section, heading: string) => `## ${heading}\n\n${sections[heading]}\n\n`).trimEnd() + '\n';
  return {
    body,
    // The body is rendered here from recorded facts, not drafted by a model, so reformatting it
    // downstream can only move it away from the template it was built to satisfy.
    render: 'final', instruction: 'Print body verbatim. Do not rewrite, summarize, reorder or reformat it; keep provenance in drilldown evidence.',
    publication: 'not-authorized',
    provenance: { runID: facts.runID, skill: { path: skill.path, digest: skill.digest }, template: { path: template.path, digest: template.digest } },
  };
}
