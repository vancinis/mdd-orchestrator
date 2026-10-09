import { assetText, PACKAGE_ROOT } from './project-assets.js';
import type { ChangedFile, Check, Delivered, VerificationVersion } from './phase-evidence.js';
import { checkTranslations, TranslationError, translationDigest } from './pr-translation.js';
import type { Translatable, Translation } from './pr-translation.js';
import { objectWithKeys } from './validation.js';

export type PRFacts = {
  runID: string; goal: string; delivered?: Delivered; verification: string;
  /** Missing means legacy exit-based reporting; never infer the contract from check IDs. */
  verificationVersion?: VerificationVersion;
  changedFiles: number; files: ChangedFile[]; checks: Check[]; verified: boolean; uncertain: boolean; limits: string[];
};
/**
 * The body is read by whoever reviews the pull request, so it is written in Spanish like every
 * other user-facing surface. The headings are the template's own and are matched against it, so
 * changing one here without changing the packaged template fails loudly rather than drifting.
 *
 * `Verificación` is its own section because the evidence of checking the work is not the work.
 * It used to be appended to `Cambios`, which put "verified without modifying sources" directly
 * under a table of modified sources and read as a contradiction of the section it closed.
 */
const HEADINGS = ['Resumen', 'Cambios', 'Verificación', 'Variables de entorno', 'Seguimiento', 'Bloqueos', 'Despliegue'];
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
 * A check command may be printed only when it is a plain package-manager invocation. The pattern
 * used to end at the script name, which meant that in a real repository almost every command —
 * `pnpm test -- src/orders`, `npx tsc --noEmit` — fell outside it and collapsed into the same
 * redaction notice, repeated once per command. Seven identical lines saying nothing is worse than
 * no lines at all: it looks like a malfunction and it spends the reviewer's attention. Arguments
 * are allowed here as shapes, not as trust — `safeCopy` still has the last word on the whole
 * string, so a path, a URL or a credential keeps the command out regardless of how it is written.
 */
const RUNNER = /^(?:npm|pnpm|yarn|bun|npx)(?: run)? [a-z0-9][a-z0-9:_-]*(?:\s+(?:--|--?[a-z0-9][a-z0-9:._-]*(?:=[a-z0-9._\/-]+)?|[a-z0-9][a-z0-9._\/-]*))*$/i;
function printable(check: Check): boolean {
  return check.command.length <= 120 && RUNNER.test(check.command) && safeCopy(check.command) === check.command;
}

/**
 * One aggregated account of what ran, instead of one line per command. The counts come first and
 * include every check: a command that exited nonzero is evidence, and a body that lists only the
 * successful ones describes a calmer run than the one that happened. Commands that cannot be
 * shown are counted rather than described, so the reviewer knows what is missing and how much.
 */
function commands(checks: readonly Check[]): string {
  if (!checks.length) return '- No se registró evidencia de comandos de verificación.';
  const passed = checks.filter(check => check.exit === 0);
  const failed = checks.filter(check => check.exit !== 0);
  const lines = [`- Comandos registrados: ${checks.length} en total, ${passed.length} con salida 0${failed.length ? ` y ${failed.length} con salida distinta de 0` : ''}.`];
  const shown = [...new Set(passed.filter(printable).map(check => check.command))];
  if (shown.length) lines.push(`- Con salida 0: ${shown.map(command => `\`${command}\``).join(', ')}.`);
  const broken = [...new Map(failed.filter(printable).map(check => [`${check.command}#${check.exit}`, check])).values()];
  if (broken.length) lines.push(`- Con salida distinta de 0: ${broken.map(check => `\`${check.command}\` (${check.exit === null ? 'sin salida registrada' : `salida ${check.exit}`})`).join(', ')}.`);
  const hidden = checks.filter(check => !printable(check)).length;
  if (hidden) lines.push(`- Se omiten ${hidden} comando(s) para no exponer argumentos ni rutas; revisá la evidencia local.`);
  return lines.join('\n');
}

/**
 * One row per file, with the reason that file had to change. A reviewer already has the list of
 * paths — the diff is the list of paths — so a Changes section that only repeats them spends the
 * reviewer's attention without answering the one question they opened the PR with. The reason is
 * the phase actor's own, recorded when it reported the change; where it did not give one, the row
 * says so instead of inventing a plausible motive.
 */
function changeTable(files: readonly ChangedFile[], spanish: (key: string) => string): string {
  const rows = files.map((file, index) => `| \`${cell(file.path)}\` | ${file.reason ? cell(spanish(`file.${index}`)) : 'Sin motivo registrado; revisá el diff.'} |`);
  return ['| Archivo | Por qué cambió |', '|---|---|', ...rows].join('\n');
}

/**
 * The recorded prose this body is made of, named so it can be translated and put back. Nothing
 * else in the body is actor text: the rest is MDD's own frame, already written for the reader.
 */
export function translatable(facts: PRFacts): Translatable[] {
  const entries: Translatable[] = facts.delivered
    ? [{ key: 'delivered.what', label: 'Qué quedó implementado', source: facts.delivered.what },
      ...(facts.delivered.implies ? [{ key: 'delivered.implies', label: 'Qué implica para quien lo usa', source: facts.delivered.implies }] : [])]
    : [{ key: 'goal', label: 'Objetivo registrado de la ejecución', source: facts.goal }];
  facts.files.forEach((file, index) => {
    if (file.reason) entries.push({ key: `file.${index}`, label: `Por qué cambió ${file.path}`, source: file.reason });
  });
  entries.push({ key: 'verification', label: 'Qué informó la verificación', source: facts.verification });
  facts.limits.forEach((limit, index) => entries.push({ key: `limit.${index}`, label: 'Límite informado por la verificación', source: limit }));
  return entries;
}

/**
 * The first half of drafting: the recorded text, and the digest that binds a translation to it.
 * No body is rendered here, because a body rendered from English prose is the defect being fixed.
 */
export function prBodyRequest(facts: PRFacts): Record<string, unknown> {
  const entries = translatable(facts);
  return {
    render: 'pending-translation',
    digest: translationDigest(facts.runID, entries),
    entries: entries.map(entry => ({ key: entry.key, label: entry.label, text: entry.source })),
    instruction: 'Translate every entry into Spanish for the reviewer who reads the PR, then call mdd_pr_body again with the same userText, this digest and one translation per key. Translate only: keep numbers, paths, identifiers, quoted code and command names exactly as they are, add no fact the entry does not state, and drop none it does. Do not draft sections, headings or prose of your own; MDD renders the body.',
    publication: 'not-authorized',
  };
}

export function renderPRBody(root: string, facts: PRFacts, userText: string, value: unknown = {}, supplied: { digest: string; translations: readonly Translation[] }) {
  const skill = assetText(PACKAGE_ROOT, 'assets/opencode/skills/mdd-pr-body/SKILL.md');
  if (!/^---\r?\n(?:[^\n]*\n)*?name: mdd-pr-body\r?\n/.test(skill.content)) throw new Error('The exact packaged mdd-pr-body skill is required.');
  const template = assetText(PACKAGE_ROOT, 'assets/opencode/skills/mdd-pr-body/assets/template.md');
  const headings = [...template.content.matchAll(/^## (.+)$/gm)].map(match => match[1]);
  if (JSON.stringify(headings) !== JSON.stringify(HEADINGS)) throw new Error('The packaged PR template must retain the seven approved sections in order.');
  const entries = translatable(facts);
  if (supplied.digest !== translationDigest(facts.runID, entries)) {
    throw new TranslationError('Esa traducción no corresponde a la evidencia registrada ahora; la ejecución cambió mientras se redactaba. Pedí de nuevo los textos con mdd_pr_body sin traducciones y traducí los que devuelva.');
  }
  const translated = checkTranslations(entries, supplied.translations);
  const spanish = (key: string): string => translated.get(key) ?? '';
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
  const failed = facts.checks.filter(check => check.exit !== 0).length;
  // For structured runs, the runner's settled `verified` result already includes required
  // dispositions and semantic coverage. Historical exits cannot reconstruct that decision.
  const verificationBlockers = facts.verificationVersion === 1
    ? (facts.verified ? [] : ['Los requisitos, el plan o las comprobaciones requeridas siguen sin verificarse por completo.'])
    : (failed ? [`${failed} comando(s) de verificación terminaron con salida distinta de 0.`] : []);
  const blockers = [
    ...(facts.changedFiles ? [] : ['No se registró evidencia de cambios de implementación; puede no haber nada para proponer.']),
    ...verificationBlockers,
    ...(facts.uncertain ? ['La ejecución o la persistencia quedaron inciertas; no reintentes ni declares que está listo.'] : []),
    ...facts.limits.map((_limit, index) => safeCopy(spanish(`limit.${index}`))),
  ];
  const sections: Record<string, string> = {
    // What changed and what it enables, in that order, and nothing about how it was built: the
    // per-file table already answers "how", and a summary that repeats it tells the reviewer
    // about the diff they are already reading instead of about the change they have to judge.
    // No boilerplate about this being a draft either: the tool returns `publication:
    // not-authorized` to the caller, which is where that fact belongs.
    Resumen: facts.delivered
      ? [safeCopy(spanish('delivered.what')), ...(facts.delivered.implies ? [safeCopy(spanish('delivered.implies'))] : [])].join('\n\n')
      : `${safeCopy(spanish('goal'))}\n\nNo se registró un resumen del cambio: este texto es el objetivo que se pidió, no lo que quedó implementado.`,
    Cambios: facts.changedFiles ? changeTable(facts.files, spanish) : 'No se registró ningún cambio de implementación.',
    Verificación: `${facts.verified
      ? 'La ejecución registrada terminó; que los requisitos y el plan coincidan sigue siendo la evaluación del agente, no una revisión independiente.'
      : 'Los requisitos y el plan de esta ejecución no están verificados del todo.'}\n\n${safeCopy(spanish('verification'))}\n\n${commands(facts.checks)}`,
    'Variables de entorno': human('environmentVariables'), Seguimiento: human('followUps'),
    Bloqueos: blockers.length ? blockers.map(item => `- ${item}`).join('\n') : 'No aplica.', Despliegue: human('deployment'),
  };
  const body = template.content.replace(/^## (.+)\r?\n[\s\S]*?(?=^## |$(?![\s\S]))/gm, (_section, heading: string) => `## ${heading}\n\n${sections[heading]}\n\n`).trimEnd() + '\n';
  return {
    body,
    // The body is assembled here from recorded facts against a fixed template, so reformatting it
    // downstream can only move it away from the template it was built to satisfy. The prose was
    // translated before it got here, which is why nothing may translate it now.
    render: 'final', instruction: 'Print body verbatim. Do not rewrite, summarize, reorder, reformat or translate it; it is already written for the reader. Keep provenance in drilldown evidence.',
    publication: 'not-authorized',
    provenance: { runID: facts.runID, skill: { path: skill.path, digest: skill.digest }, template: { path: template.path, digest: template.digest },
      // Named so the record shows which sentences reached the reviewer through a translation
      // rather than straight from the phase that recorded them.
      translated: entries.map(entry => entry.key) },
  };
}
