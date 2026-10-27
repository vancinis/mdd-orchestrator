import { readLessons } from './lessons.js';
import type { Lesson } from './lessons.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readRuns } from './run-ledger.js';
import type { RunRecord, StopCause } from './run-ledger.js';
import { FAILURE_CLASSES, telemetryRetained, telemetryTotals } from './telemetry.js';
import type { FailureClass, TelemetryRollup } from './telemetry.js';
import { PHASES } from './policy.js';

/**
 * The review MDD could not do about itself.
 *
 * Everything needed for it was already being written — runs, counters, recorded lessons — and
 * nothing read the three together, so answering "how has this been going" meant opening local
 * files by hand and correlating them from memory. That is the work this does, and it does it
 * arithmetically: every line below is a count of something recorded, and where a number invites a
 * conclusion the report names the number and leaves the conclusion to the reader. A retro that
 * guessed at causes would be a model's opinion wearing the costume of evidence.
 */
const FAILURE_LABELS: Record<FailureClass, string> = {
  'phase-failed': 'la fase falló', 'result-rejected': 'resultado rechazado',
  'result-malformed': 'reporte ilegible', 'dispatch-mismatch': 'despacho no coincidente',
  'native-error': 'error nativo', 'route-blocked': 'ruta detenida', stopped: 'detenido',
};

/** Labels for printing only; the causes stay English wherever they are recorded or compared. */
const STOP_LABELS: Record<StopCause | 'unrecorded', string> = {
  'verify-implementation': 'Verify encontró defectos de la implementación',
  'verify-design': 'Verify atribuyó la brecha al diseño',
  'verify-requirements': 'Verify atribuyó la brecha a los requisitos',
  'verify-evidence': 'Verify no reunió la evidencia (chequeos o entorno)',
  'planning-unmet': 'la planificación no puede cumplir un requisito',
  'phase-failed': 'otra fase falló',
  'report-unreadable': 'reporte ilegible tras los reintentos',
  'fallback-exhausted': 'se agotó el respaldo nativo',
  uncertain: 'estado incierto (checkpoint o progreso)',
  other: 'otra causa',
  unrecorded: 'sin causa registrada (filas anteriores a este dato)',
};
const ADAPTIVE_LABELS: Record<AdaptiveStop, string> = {
  'evidence-gaps': 'con brechas en la evidencia', 'no-evidence': 'sin evidencia presentada', other: 'por otra causa',
};

/**
 * How many runs finished, and why the others stopped. A completion rate alone says how often runs
 * stop and nothing about which part of the route to fix, so it is always broken down by the cause
 * the adapter recorded. Every ledger row counts, not only the recent ones the listing shows.
 */
export type Completion = { total: number; complete: number; blocked: number; causes: Partial<Record<StopCause | 'unrecorded', number>>;
  corrected: number; corrections: number; pending: number };
export function completionOf(runs: readonly RunRecord[]): Completion {
  const result: Completion = { total: runs.length, complete: 0, blocked: 0, causes: {}, corrected: 0, corrections: 0, pending: 0 };
  for (const run of runs) {
    if (run.state === 'complete') {
      result.complete++;
      if (run.corrections) { result.corrected++; result.corrections += run.corrections; }
      if (run.pending) result.pending++;
    } else {
      result.blocked++;
      const cause = run.stop ?? 'unrecorded';
      result.causes[cause] = (result.causes[cause] ?? 0) + 1;
    }
  }
  return result;
}

/** Adaptive (version 3) runs keep their own records; only their terminal facts are read here. */
type AdaptiveStop = 'evidence-gaps' | 'no-evidence' | 'other';
export type AdaptiveCompletion = { closed: number; verified: number; unverified: Partial<Record<AdaptiveStop, number>>; active: number; repairs: number; pending: number };
const ADAPTIVE_FILE = /^adaptive-(?:archive-)?[a-f0-9]{64}\.json$/;
const ADAPTIVE_FILE_MAX = 20 * 1024 * 1024;
const ADAPTIVE_FILES_MAX = 512;
export function adaptiveCompletionOf(records: readonly unknown[]): AdaptiveCompletion {
  const result: AdaptiveCompletion = { closed: 0, verified: 0, unverified: {}, active: 0, repairs: 0, pending: 0 };
  for (const record of records) {
    const data = record && typeof record === 'object' ? (record as { data?: Record<string, unknown> }).data : undefined;
    if (!data || typeof data.state !== 'string') continue;
    if (Number.isSafeInteger(data.repairs)) result.repairs += data.repairs as number;
    const report = data.report && typeof data.report === 'object' ? data.report as { scenarios?: { status?: unknown }[]; checkResults?: { disposition?: unknown }[] } : undefined;
    if (data.state === 'completed') {
      result.closed++; result.verified++;
      if ((report?.scenarios ?? []).some(row => row?.status === 'external') || (report?.checkResults ?? []).some(row => row?.disposition === 'environmental')) result.pending++;
    } else if (data.state === 'closed-unverified') {
      result.closed++;
      const cause: AdaptiveStop = !report ? 'no-evidence' : data.matched !== true ? 'evidence-gaps' : 'other';
      result.unverified[cause] = (result.unverified[cause] ?? 0) + 1;
    } else result.active++;
  }
  return result;
}
/** Read-only and bounded: a file that cannot be read is skipped, never repaired or reported as a run. */
function adaptiveRecords(root: string): unknown[] {
  const directory = join(root, '.mdd');
  let names: string[];
  try { names = readdirSync(directory).filter(name => ADAPTIVE_FILE.test(name)).slice(0, ADAPTIVE_FILES_MAX); } catch { return []; }
  return names.flatMap(name => {
    try {
      const path = join(directory, name);
      if (statSync(path).size > ADAPTIVE_FILE_MAX) return [];
      const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      // An archive holds the closed run it replaced; the live record holds the current one.
      return [name.startsWith('adaptive-archive-') ? value.previous : value];
    } catch { return []; }
  });
}

export type RetroSources = { runs: RunRecord[]; runTotal: number; rollup?: TelemetryRollup; lessons: Lesson[]; lessonTotal: number; events?: number;
  completion?: Completion; adaptive?: AdaptiveCompletion };

export function retroSources(root: string, limit = 20, now = Date.now()): RetroSources {
  const runs = readRuns(root, { limit });
  const every = readRuns(root);
  const lessons = readLessons(root, { state: 'open' });
  const rollup = telemetryTotals(root);
  const adaptive = adaptiveCompletionOf(adaptiveRecords(root));
  return {
    runs: runs.ok ? runs.runs : [], runTotal: runs.ok ? runs.total : 0,
    ...(rollup ? { rollup } : {}),
    lessons: lessons.ok ? lessons.lessons : [], lessonTotal: lessons.ok ? lessons.total : 0,
    events: telemetryRetained(root, now),
    ...(every.ok && every.runs.length ? { completion: completionOf(every.runs) } : {}),
    ...(adaptive.closed || adaptive.active ? { adaptive } : {}),
  };
}

const percent = (part: number, whole: number) => `${Math.round(part * 100 / whole)}%`;
/** Causes from most to least frequent, each with its count. */
function ranked<Key extends string>(counts: Partial<Record<Key, number>>, labels: Record<Key, string>): string {
  return (Object.entries(counts) as [Key, number][]).sort((a, b) => b[1] - a[1]).map(([key, count]) => `${labels[key]} ${count}`).join(', ');
}

/**
 * The share of runs that finished, per route, and why the rest stopped. It is the number the
 * Verify changes were made to move, so it is read first; each line is still a count, not a cause.
 */
function completionLines(sources: RetroSources): string[] {
  const lines: string[] = [];
  const fixed = sources.completion;
  if (fixed?.total) {
    lines.push(`- Ruta fija: ${fixed.complete} de ${fixed.total} ejecución(es) registradas terminaron completas (${percent(fixed.complete, fixed.total)}); ${fixed.blocked} detenida(s).`);
    if (fixed.blocked) lines.push(`  Detenidas por causa: ${ranked(fixed.causes, STOP_LABELS)}.`);
    if (fixed.corrected || fixed.pending) lines.push(`  ${fixed.corrected} de las completas pasaron por corrección (${fixed.corrections} pasada(s) en total); ${fixed.pending} quedaron con pendientes externos o ajenos al cambio.`);
  }
  const adaptive = sources.adaptive;
  if (adaptive && (adaptive.closed || adaptive.active)) {
    const unverified = adaptive.closed - adaptive.verified;
    lines.push(`- Ruta adaptativa: ${adaptive.verified} de ${adaptive.closed} ejecución(es) cerradas terminaron verificadas${adaptive.closed ? ` (${percent(adaptive.verified, adaptive.closed)})` : ''}; ${unverified} cerrada(s) sin verificar${unverified ? ` (${ranked(adaptive.unverified, ADAPTIVE_LABELS)})` : ''}; ${adaptive.active} en curso.`);
    if (adaptive.repairs || adaptive.pending) lines.push(`  ${adaptive.repairs} reparación(es) en total; ${adaptive.pending} verificada(s) con pendientes externos o ajenos al cambio.`);
  }
  const rollup = sources.rollup;
  if (rollup && (rollup.runs.started || rollup.runs.corrected)) {
    const ended = fixed ? fixed.total : 0;
    lines.push(`- La telemetría de la ruta fija cuenta ${rollup.runs.started} iniciada(s)${rollup.runs.started > ended ? `, de las que ${rollup.runs.started - ended} no tienen fila de final registrada` : ''}, y ${rollup.runs.corrected ?? 0} corrección(es) automática(s) tras un Verify fallido.`);
  }
  return lines;
}

/**
 * The part worth reading first: counts that tend to mean something is worth looking at. Each one
 * states what was counted and what it is a sign of, never what caused it — MDD does not know why
 * eleven explorations stopped, only that they did, and the difference matters when the next person
 * decides where to spend an afternoon.
 */
function signals(sources: RetroSources): string[] {
  const found: string[] = [];
  const rollup = sources.rollup;
  if (rollup) {
    const { started, completed, blocked, reset, compacted } = rollup.runs;
    const unfinished = Math.max(0, started - completed - blocked);
    if (unfinished) {
      found.push(`${unfinished} de ${started} ejecución(es) iniciadas no llegaron a ningún final registrado: ni completas ni detenidas. Una ejecución abandonada a mitad de camino no deja cierre ni cuerpo de PR, así que conviene mirar dónde se cortaron.`);
    }
    if (blocked) found.push(`${blocked} ejecución(es) terminaron detenidas sobre ${started} iniciadas.`);
    if (reset) found.push(`${reset} ejecución(es) se reiniciaron con mdd_reset.`);
    if (compacted) {
      found.push(`El entorno compactó la conversación del coordinador ${compacted} vez/veces en mitad de una ejecución. Cada compactación le cuesta el estado que estaba sosteniendo.`);
    }
    const failures = FAILURE_CLASSES.map(name => [name, rollup.failures[name]] as const).filter(([, count]) => count);
    const worst = failures.slice().sort((a, b) => b[1] - a[1])[0];
    if (worst) {
      const total = failures.reduce((sum, [, count]) => sum + count, 0);
      found.push(`El fallo más frecuente es "${FAILURE_LABELS[worst[0]]}": ${worst[1]} de ${total} intento(s) fallidos.`);
    }
    // A phase that is retried far more than the others is the cheapest thing in the route to fix.
    const retried = PHASES.map(phase => [phase, rollup.phases[phase]?.retries ?? 0] as const)
      .filter(([, count]) => count).sort((a, b) => b[1] - a[1])[0];
    if (retried) found.push(`La fase que más se reintentó es ${retried[0]}: ${retried[1]} reintento(s).`);
    const stopped = PHASES.map(phase => {
      const entry = rollup.phases[phase];
      return [phase, entry ? entry.failed + entry.blocked : 0, entry?.starts ?? 0] as const;
    }).filter(([, count]) => count).sort((a, b) => b[1] - a[1])[0];
    if (stopped) found.push(`La fase que más se cortó es ${stopped[0]}: ${stopped[1]} de ${stopped[2]} ejecución(es) de esa fase.`);
  }
  const ledgered = sources.runs;
  if (ledgered.length) {
    const noChange = ledgered.filter(run => !run.changedFiles).length;
    if (noChange) found.push(`${noChange} de las últimas ${ledgered.length} ejecución(es) registradas no cambiaron ningún archivo.`);
    const failedChecks = ledgered.filter(run => run.checks.failed).length;
    if (failedChecks) found.push(`${failedChecks} de las últimas ${ledgered.length} ejecución(es) registradas terminaron con algún comando de verificación en salida distinta de 0.`);
    const partial = ledgered.filter(run => run.state === 'complete' && run.coverage < 100).length;
    if (partial) found.push(`${partial} ejecución(es) se dieron por completas con menos de 100% de cobertura de evidencia.`);
    // Post-anchoring a repository sees its worktrees together, which is the point of the anchor.
    const checkouts = new Set(ledgered.map(run => run.directory));
    if (checkouts.size > 1) found.push(`Las últimas ${ledgered.length} ejecución(es) vinieron de ${checkouts.size} checkout(s) distintos de este repositorio.`);
  }
  if (sources.lessons.length) found.push(`Hay ${sources.lessons.length} automejora(s) anotada(s) sin revisar, sobre ${sources.lessonTotal} en total.`);
  return found;
}

function runLine(run: RunRecord): string {
  const date = new Date(run.timestamp).toISOString().slice(0, 10);
  const state = run.state === 'complete' ? 'completa' : 'detenida';
  const checks = run.checks.total
    ? `${run.checks.total} chequeo(s), ${run.checks.failed} con salida distinta de 0`
    : 'sin chequeos registrados';
  return `${date} · ${state} en ${run.phase}${run.stop ? ` (${STOP_LABELS[run.stop]})` : ''} · ${run.coverage}% de cobertura · ${run.changedFiles} archivo(s) · ${checks}` +
    `${run.corrections ? ` · ${run.corrections} corrección(es)` : ''}${run.pending ? ` · ${run.pending} pendiente(s) externo(s)` : ''}`;
}

export function renderRetroReport(sources: RetroSources): string {
  const lines = ['Retrospectiva de MDD en este repositorio — local, nunca se exporta.'];
  if (!sources.runTotal && !sources.rollup && !sources.lessonTotal && !sources.adaptive) {
    // Events without an aggregate are the ordinary state of a workspace that ran MDD before it
    // kept totals. Reporting that as "nothing happened" would be wrong about its own record.
    lines.push('', sources.events
      ? `Todavía no hay ejecuciones terminadas ni totales acumulados en este repositorio, y hay ${sources.events} evento(s) sueltos en el registro de los últimos 30 días. Las filas se escriben cuando una ejecución se completa o se detiene; para ver esos eventos, \`mdd telemetry report\`.`
      : 'Todavía no hay nada que revisar acá: ninguna ejecución registrada, ningún total acumulado y ninguna automejora anotada.');
    return `${lines.join('\n')}\n`;
  }
  const finished = completionLines(sources);
  if (finished.length) lines.push('', 'Finalización', ...finished);
  const found = signals(sources);
  lines.push('', 'Señales', ...(found.length
    ? found.map(item => `- ${item}`)
    : ['- Nada se destaca en lo registrado. Son conteos, no un certificado de que todo esté bien.']));

  lines.push('', `Últimas ejecuciones (${sources.runs.length} de ${sources.runTotal})`);
  if (!sources.runs.length) {
    lines.push('- Todavía no se registró ninguna ejecución terminada. Las filas se escriben cuando una ejecución se completa o se detiene.');
  } else {
    for (const run of sources.runs) {
      lines.push(`- ${runLine(run)}`);
      if (run.goal) lines.push(`  ${run.goal}`);
      for (const limit of run.limits) lines.push(`  Pendiente: ${limit}`);
    }
  }

  if (sources.lessons.length) {
    lines.push('', `Automejoras sin revisar (${sources.lessons.length} de ${sources.lessonTotal})`);
    for (const lesson of sources.lessons) lines.push(`- [${lesson.id}] ${lesson.title}`);
  }

  lines.push('',
    'Los números son conteos de lo que quedó registrado: dicen qué pasó, no por qué. Para trabajar sobre una automejora, nombrá su identificador. El detalle por fase y el consumo están en `mdd telemetry report`.');
  return `${lines.join('\n')}\n`;
}

export function retroReport(root: string, limit = 20): { ok: true; text: string } {
  return { ok: true, text: renderRetroReport(retroSources(root, limit)) };
}
