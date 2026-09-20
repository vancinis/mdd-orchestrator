import { assetText, PACKAGE_ROOT } from './project-assets.js';
import type { ChangedFile } from './phase-evidence.js';
import { objectWithKeys } from './validation.js';

export type PRFacts = { runID: string; goal: string; changes: string; changedFiles: number; files: ChangedFile[]; checks: string[]; verified: boolean; uncertain: boolean; limits: string[] };
/**
 * The body is read by whoever reviews the pull request, so it is written in Spanish like every
 * other user-facing surface. The headings are the template's own and are matched against it, so
 * changing one here without changing the packaged template fails loudly rather than drifting.
 */
const HEADINGS = ['Resumen', 'Cambios', 'Variables de entorno', 'Seguimiento', 'Bloqueos', 'Despliegue'];
/** Text a reader must not be shown: credentials, URLs, absolute paths, control characters. */
const UNSAFE = /[\x00-\x1f\x7f`]|\b[a-z][a-z0-9+.-]*:\/\/|[a-z]:[\\/]|(?:^|[\s('"=])(?:\/|~[\\/])|\\\\/i;
/**
 * Case matters in the assignment pattern. Run case-insensitively it matched ordinary prose like
 * "count = 5" and replaced a whole legitimate summary with a redaction notice, which reads as a
 * bug in the draft rather than as the protection it is. Only a SHOUTING_NAME= is a variable.
 */
const SECRET = /\b(?:password|secret|token|api[-_ ]?key|authorization)\s*[:=]|\b[A-Z][A-Z0-9_]{2,}\s*=|\b(?:sk-|ghp_|github_pat_|AIza)[A-Za-z0-9_-]{8,}/;
const OVERSIZE = 1000;
const REDACTED = 'Sin verificar: se omitió texto sensible, con rutas o no soportado.';
function safeCopy(value: string): string {
  // Oversize text is shortened rather than discarded: losing a long goal entirely tells the
  // reader less than the first part of it plus an explicit note that it was cut.
  const bounded = value.length > OVERSIZE ? `${value.slice(0, OVERSIZE).trimEnd()}… (recortado)` : value;
  if (!bounded.trim() || UNSAFE.test(bounded) || SECRET.test(bounded)) return REDACTED;
  return bounded.trim().replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('[', '\\[').replaceAll(']', '\\]').replaceAll('#', '\\#');
}
/**
 * A table cell cannot carry a pipe or a line break without breaking the row that holds it. The
 * line breaks are collapsed before the safety check rather than after: a reason written across two
 * lines is ordinary prose, and running it through a rule that treats every control character as
 * hostile redacted the entire reason for writing the table.
 */
function cell(value: string): string {
  return safeCopy(value.replace(/\s*\r?\n\s*/g, ' ')).replaceAll('|', '\\|');
}

/**
 * One row per file, with the reason that file had to change. A reviewer already has the list of
 * paths — the diff is the list of paths — so a Changes section that only repeats them spends the
 * reviewer's attention without answering the one question they opened the PR with. The reason is
 * the phase actor's own, recorded when it reported the change; where it did not give one, the row
 * says so instead of inventing a plausible motive.
 */
function changeTable(files: readonly ChangedFile[]): string {
  const rows = files.map(file => `| \`${cell(file.path)}\` | ${file.reason ? cell(file.reason) : 'Sin motivo registrado; revisá el diff.'} |`);
  return ['| Archivo | Por qué cambió |', '|---|---|', ...rows].join('\n');
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
    // about deployment. The template, the skill and the docs all answer that with "No aplica."
    // Answering it with "unverified" instead made every normal draft look like it had lost data.
    if (!Object.hasOwn(notes, key)) return 'No aplica.';
    const note = notes[key];
    if (typeof note !== 'string' || !note.trim()) throw new Error(`PR note ${key} must be nonempty text, or be omitted entirely to render "No aplica.".`);
    if (!userText.split(/\r?\n/).some(line => line.trim() === note.trim())) throw new Error(`PR note ${key} must quote a complete line of the actual latest user text; MDD does not author these sections.`);
    const safe = safeCopy(note);
    // The user writing exactly "No aplica." is answering the section, not supplying a fact about
    // it, so attributing it back to them would read as evidence where there is none.
    if (safe === REDACTED || safe === 'No aplica.') return safe;
    return `Lo aportó el usuario, sin verificación independiente: ${safe}`;
  };
  const commands = facts.checks.map(command => /^(?:npm|pnpm|yarn|bun) (?:test|run (?:test|typecheck|lint|check|build)(?:[:_-][a-z0-9_-]+)?)$/i.test(command) && safeCopy(command) === command
    ? `- Comando registrado: ${command}; salida 0.` : '- Comando registrado: se omite para no exponer argumentos ni rutas; salida 0. Revisá la evidencia local.');
  const blockers = [
    ...(facts.changedFiles ? [] : ['No se registró evidencia de cambios de implementación; puede no haber nada para proponer.']),
    ...(facts.verified ? [] : ['Los requisitos y el plan no están verificados del todo. Que un comando termine en 0 no establece que el trabajo esté completo.']),
    ...(facts.uncertain ? ['La ejecución o la persistencia quedaron inciertas; no reintentes ni declares que está listo.'] : []),
    ...facts.limits.map(safeCopy),
  ];
  const sections: Record<string, string> = {
    // No boilerplate about this being a draft: the tool returns `publication: not-authorized` to
    // the caller, which is where that fact belongs. Repeating it at the top of every body told the
    // reviewer something about MDD's permissions instead of about the change they have to review.
    Resumen: `${safeCopy(facts.goal)}\n\n${facts.verified ? 'La ejecución registrada terminó; que los requisitos y el plan coincidan sigue siendo la evaluación del agente, no una revisión independiente.' : 'Los requisitos y el plan de esta ejecución no están verificados del todo.'}`,
    Cambios: `${facts.changedFiles
      ? `${changeTable(facts.files)}\n\n${safeCopy(facts.changes)}`
      : 'No se registró ningún cambio de implementación.'}\n\n${commands.length ? commands.join('\n') : '- No se registró evidencia de comandos de verificación.'}`,
    'Variables de entorno': human('environmentVariables'), Seguimiento: human('followUps'),
    Bloqueos: blockers.length ? blockers.map(item => `- ${item}`).join('\n') : 'No aplica.', Despliegue: human('deployment'),
  };
  const body = template.content.replace(/^## (.+)\r?\n[\s\S]*?(?=^## |$(?![\s\S]))/gm, (_section, heading: string) => `## ${heading}\n\n${sections[heading]}\n\n`).trimEnd() + '\n';
  return {
    body,
    // The body is rendered here from recorded facts, not drafted by a model, so reformatting it
    // downstream can only move it away from the template it was built to satisfy.
    render: 'final', instruction: 'Print body verbatim. Do not rewrite, summarize, reorder, reformat or translate it; it is already written for the reader. Keep provenance in drilldown evidence.',
    publication: 'not-authorized',
    provenance: { runID: facts.runID, skill: { path: skill.path, digest: skill.digest }, template: { path: template.path, digest: template.digest } },
  };
}
