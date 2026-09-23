import { readLessons } from './lessons.js';
import type { Lesson } from './lessons.js';
import { readRuns } from './run-ledger.js';
import type { RunRecord } from './run-ledger.js';
import { FAILURE_CLASSES, telemetryRetained, telemetryTotals } from './telemetry.js';
import type { FailureClass, TelemetryRollup } from './telemetry.js';
import { MODEL_ROLES } from './settings.js';
import type { Phase } from './policy.js';

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
const PHASES = MODEL_ROLES.filter((role): role is Phase => role !== 'orchestrator');
const FAILURE_LABELS: Record<FailureClass, string> = {
  'phase-failed': 'la fase falló', 'result-rejected': 'resultado rechazado',
  'result-malformed': 'reporte ilegible', 'dispatch-mismatch': 'despacho no coincidente',
  'native-error': 'error nativo', 'route-blocked': 'ruta detenida', stopped: 'detenido',
};

export type RetroSources = { runs: RunRecord[]; runTotal: number; rollup?: TelemetryRollup; lessons: Lesson[]; lessonTotal: number; events?: number };

export function retroSources(root: string, limit = 20, now = Date.now()): RetroSources {
  const runs = readRuns(root, { limit });
  const lessons = readLessons(root, { state: 'open' });
  const rollup = telemetryTotals(root);
  return {
    runs: runs.ok ? runs.runs : [], runTotal: runs.ok ? runs.total : 0,
    ...(rollup ? { rollup } : {}),
    lessons: lessons.ok ? lessons.lessons : [], lessonTotal: lessons.ok ? lessons.total : 0,
    events: telemetryRetained(root, now),
  };
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
  return `${date} · ${state} en ${run.phase} · ${run.coverage}% de cobertura · ${run.changedFiles} archivo(s) · ${checks}`;
}

export function renderRetroReport(sources: RetroSources): string {
  const lines = ['Retrospectiva de MDD en este repositorio — local, nunca se exporta.'];
  if (!sources.runTotal && !sources.rollup && !sources.lessonTotal) {
    // Events without an aggregate are the ordinary state of a workspace that ran MDD before it
    // kept totals. Reporting that as "nothing happened" would be wrong about its own record.
    lines.push('', sources.events
      ? `Todavía no hay ejecuciones terminadas ni totales acumulados en este repositorio, y hay ${sources.events} evento(s) sueltos en el registro de los últimos 30 días. Las filas se escriben cuando una ejecución se completa o se detiene; para ver esos eventos, \`mdd telemetry report\`.`
      : 'Todavía no hay nada que revisar acá: ninguna ejecución registrada, ningún total acumulado y ninguna automejora anotada.');
    return `${lines.join('\n')}\n`;
  }
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
