import { resolve } from 'node:path';
import { ValidationError } from './validation.js';
import { ask, choose, heading, note, rows } from './tui.js';
import type { Choice, ConfigIO } from './tui.js';
import type {
  ActionResult, ApplyReport, IntegrationAction, IntegrationDeps, IntegrationSnapshot, ProbeReport, ReviewItem,
} from './integrations.js';

/**
 * Terminal flow of the optional integrations. It only queues reviewed actions in memory;
 * nothing is downloaded, written, run or initialized until the caller confirms the final
 * review. The engine module is loaded lazily so the core config editor never depends on it.
 */

export interface IntegrationEngine {
  inspect(deps: IntegrationDeps): IntegrationSnapshot;
  lookupOffer(tool: 'engram' | 'codegraph', deps: IntegrationDeps): Promise<{ offer: IntegrationAction } | { rejected: string }>;
  reviewOf(action: IntegrationAction, deps: IntegrationDeps): ReviewItem;
  apply(actions: IntegrationAction[], deps: IntegrationDeps): Promise<ApplyReport>;
  probe(deps: IntegrationDeps): Promise<ProbeReport>;
  checkInitTarget(path: string, deps: IntegrationDeps, queued?: IntegrationAction): ReturnType<typeof import('./integrations.js').checkInitTarget>;
  PROBE_DISCLOSURE?: string;
}

export interface IntegrationsOptions { deps?: IntegrationDeps; engine?: Partial<IntegrationEngine> }

const LABELS: Record<string, string> = { context7: 'Context7', engram: 'Engram', codegraph: 'CodeGraph' };
const KIND: Record<IntegrationAction['kind'], string> = {
  configure: 'Configurar', install: 'Instalar', update: 'Actualizar', 'register-external': 'Registrar ejecutable externo', init: 'Inicializar índice',
};
const OUTCOME: Record<ActionResult['outcome'], string> = {
  completed: 'completado', unchanged: 'sin cambios', failed: 'falló', 'not-attempted': 'no se intentó',
};
const STATE: Record<string, string> = {
  managed: 'gestionada por MDD', external: 'externa', absent: 'ausente', disabled: 'desactivada', conflict: 'en conflicto', unknown: 'desconocida',
};
const EVIDENCE: Record<string, string> = { yes: 'sí', no: 'no', unknown: 'desconocido', 'not-tested': 'sin comprobar' };
const LOOKUP_DISCLOSURE = 'Consulta explícita: hace una solicitud HTTPS de solo lectura a los metadatos de versiones de GitHub. No descarga ni instala nada, y la integridad que informa GitHub no la revisó MDD.';
const FALLBACK_PROBE_DISCLOSURE = 'La comprobación puede iniciar el servicio de OpenCode y conectar a servidores remotos; solo se ejecuta si la pedís.';
const YES_NO: readonly Choice[] = [
  { value: 'no', label: 'Volver', hint: 'No hace nada' },
  { value: 'si', label: 'Continuar', hint: 'Ejecuta solo esta consulta' },
];

const keyOf = (action: IntegrationAction) => action.kind === 'init' ? 'init' : action.tool;
const describe = (action: IntegrationAction) => {
  const version = 'release' in action ? ` ${action.release.version}` : '';
  return `${KIND[action.kind]} ${LABELS[action.tool]}${version}`;
};

async function loadEngine(partial: Partial<IntegrationEngine> = {}): Promise<IntegrationEngine> {
  const needed = ['inspect', 'lookupOffer', 'reviewOf', 'apply', 'probe', 'checkInitTarget'] as const;
  if (needed.every(name => partial[name])) return partial as IntegrationEngine;
  try {
    const real = await import('./integrations.js');
    return { inspect: real.inspect, lookupOffer: real.lookupOffer, reviewOf: real.reviewOf, apply: real.apply, probe: real.probe,
      checkInitTarget: real.checkInitTarget, PROBE_DISCLOSURE: real.PROBE_DISCLOSURE, ...partial };
  } catch (error) {
    throw new ValidationError(`Las integraciones opcionales no están disponibles: ${error instanceof Error ? error.message : 'error desconocido'}. El resto de la configuración no depende de ellas.`);
  }
}

function statusView(snapshot: IntegrationSnapshot, queue: readonly IntegrationAction[]): string {
  const dim = (d: { value: string; detail: string }) => `${EVIDENCE[d.value] ?? d.value} · ${d.detail}`;
  let text = heading('Integraciones opcionales');
  for (const tool of snapshot.tools) {
    text += rows([
      [tool.label, `${STATE[tool.state] ?? tool.state}${tool.version ? ` (${tool.version})` : ''} — ${tool.reason}`],
      ['  instalado', dim(tool.installed)], ['  configurado', dim(tool.configured)],
      ['  conectado', dim(tool.connected)], ['  usable', dim(tool.usable)],
    ]);
    for (const notice of tool.notices) text += note(`Aviso: ${notice}`);
  }
  for (const blocker of snapshot.blockers) text += note(`Bloqueado: ${blocker}`);
  for (const line of snapshot.notes) text += note(line);
  text += note(snapshot.limits);
  text += note(queue.length ? `En cola (${queue.length}): ${queue.map(describe).join('; ')}` : 'La cola está vacía.');
  return `${text}${note('Nada se descarga, escribe ni ejecuta hasta Guardar y salir → revisión → Aplicar.')}`;
}

function reviewView(items: readonly ReviewItem[]): string {
  let text = heading('Revisión final de integraciones');
  for (const item of items) {
    text += `\n  ${KIND[item.kind]} ${LABELS[item.tool]}\n`;
    text += rows(([
      ['versión', item.version], ['origen', item.source], ['sha256', item.sha256], ['destino', item.destination],
      ['archivo de config', item.configFile], ['servidor', item.server], ['comando', item.command?.join(' ')],
    ] as [string, string | undefined][]).filter((row): row is [string, string] => row[1] !== undefined).map(([k, v]) => [`  ${k}`, v] as const));
    for (const line of item.notes) text += note(`  · ${line}`);
  }
  return text;
}

function resultView(report: ApplyReport): string {
  let text = heading('Resultado de las integraciones');
  for (const r of report.results) {
    text += `  ${LABELS[r.tool]} · ${KIND[r.kind]}: ${OUTCOME[r.outcome]}${r.reason ? ` — ${r.reason}` : ''}\n`;
    for (const line of r.effects) text += note(`  efecto: ${line}`);
    for (const line of r.residual) text += note(`  pendiente/residuo: ${line}`);
  }
  if (report.restartNote) text += note(report.restartNote);
  return text;
}

function probeView(report: ProbeReport): string {
  let text = heading('Comprobación de integraciones');
  text += note(`OpenCode: ${report.opencode.ran ? 'consultado' : 'no consultado'} — ${report.opencode.detail}`);
  for (const [id, tool] of Object.entries(report.tools)) {
    text += rows([[LABELS[id] ?? id, ''], ['  versión', `${EVIDENCE[tool.version.value]} · ${tool.version.detail}`],
      ['  conectado', `${EVIDENCE[tool.connected.value]} · ${tool.connected.detail}`], ['  usable', `${EVIDENCE[tool.usable.value]} · ${tool.usable.detail}`]]);
  }
  return text;
}

export interface IntegrationsSession {
  /** Interactive browsing; may only queue in memory or run an explicitly confirmed lookup/probe. */
  browse(io: ConfigIO): Promise<void>;
  pending(): boolean;
  /** Final review. Resolves `apply` only after an explicit confirmation; any cancellation throws `Cancelled`. */
  review(io: ConfigIO): Promise<'apply' | 'back'>;
  /** Runs the confirmed queue and prints the honest per-action outcome. */
  apply(io: ConfigIO): Promise<void>;
}

export function createIntegrationsSession(options: IntegrationsOptions = {}): IntegrationsSession {
  const deps: IntegrationDeps = { cwd: process.cwd(), ...options.deps };
  const cwd = deps.cwd ?? process.cwd();
  const queue = new Map<string, IntegrationAction>();
  let engine: IntegrationEngine | undefined;
  const get = async () => engine ??= await loadEngine(options.engine);

  const toggle = (io: ConfigIO, action: IntegrationAction) => {
    const key = keyOf(action);
    // The queued init was reviewed against a specific CodeGraph launcher; changing it invalidates that approval.
    if (action.tool === 'codegraph' && queue.delete('init')) io.write(note('Se quitó la inicialización en cola: dependía de la selección anterior de CodeGraph. Volvé a ponerla en cola.'));
    if (queue.has(key) && queue.get(key) === action) { queue.delete(key); io.write(note(`Quitado de la cola: ${describe(action)}.`)); }
    else { queue.set(key, action); io.write(note(`En cola: ${describe(action)}. Todavía no se hizo nada.`)); }
  };

  async function lookup(io: ConfigIO, e: IntegrationEngine, snapshot: IntegrationSnapshot, found: Map<string, IntegrationAction>) {
    const managed = snapshot.tools.filter(tool => tool.state === 'managed' && (tool.id === 'engram' || tool.id === 'codegraph'));
    if (!managed.length) { io.write(note('No hay una instalación gestionada por MDD para buscar versiones nuevas.')); return; }
    const id = await choose(io, 'Buscar versión más nueva', [...managed.map(tool => ({ value: tool.id, label: tool.label, hint: tool.version ?? '' })),
      { value: '', label: 'Volver', hint: '' }]);
    if (!id) return;
    io.write(note(LOOKUP_DISCLOSURE));
    if (await choose(io, 'Confirmar consulta de metadatos', YES_NO) !== 'si') return;
    const result = await e.lookupOffer(id as 'engram' | 'codegraph', deps);
    if ('rejected' in result) { io.write(note(`Sin oferta: ${result.rejected}`)); return; }
    found.set(keyOf(result.offer), result.offer);
    io.write(note(`Disponible: ${describe(result.offer)} (aún no está en la cola).`));
  }

  async function probeFlow(io: ConfigIO, e: IntegrationEngine) {
    io.write(note(e.PROBE_DISCLOSURE ?? FALLBACK_PROBE_DISCLOSURE));
    if (await choose(io, 'Confirmar comprobación de conexión', YES_NO) !== 'si') return;
    io.write(probeView(await e.probe(deps)));
  }

  async function initFlow(io: ConfigIO, e: IntegrationEngine) {
    io.write(note('La inicialización indexa todo el checkout y solo se acepta la raíz exacta del repositorio Git (nunca un subdirectorio). Es una selección aparte de la instalación.'));
    const answer = await ask(io, 'Raíz exacta del checkout a indexar', `Enter usa el directorio actual: ${cwd}`);
    const result = e.checkInitTarget(resolve(cwd, answer || cwd), deps, queue.get('codegraph'));
    if ('refused' in result) { io.write(note(`Rechazado: ${result.refused}`)); return; }
    const action: IntegrationAction = { kind: 'init', tool: 'codegraph', target: result.ok };
    queue.set('init', action);
    io.write(note(`En cola: inicializar el índice en ${result.ok.root}. Se ejecuta después de instalar o registrar CodeGraph, y solo si eso termina bien.`));
  }

  return {
    pending: () => queue.size > 0,
    async browse(io) {
      const e = await get();
      const snapshot = e.inspect(deps);
      const found = new Map<string, IntegrationAction>();
      for (;;) {
        io.write(statusView(snapshot, [...queue.values()]));
        const offers = new Map<string, IntegrationAction>();
        for (const tool of snapshot.tools) for (const offer of tool.offers) offers.set(keyOf(offer), offer);
        for (const [key, offer] of found) offers.set(key, offer);
        const list = [...offers.values()];
        const pick = await choose(io, 'Integraciones', [
          ...list.map((offer, index) => ({ value: `o${index}`, label: `${queue.get(keyOf(offer)) === offer ? '[x]' : '[ ]'} ${describe(offer)}`, hint: 'Poner en cola o quitar' })),
          { value: 'buscar', label: 'Buscar versión más nueva', hint: 'Consulta opcional a GitHub' },
          { value: 'probar', label: 'Comprobar conexión', hint: 'Opcional; puede iniciar OpenCode' },
          { value: 'init', label: 'Inicializar índice de CodeGraph', hint: 'Selección aparte, raíz exacta' },
          ...(queue.size ? [{ value: 'vaciar', label: 'Vaciar la cola', hint: 'Descarta lo pendiente' }] : []),
          { value: 'volver', label: 'Volver', hint: 'Mantiene la cola, sin efectos' },
        ]);
        if (pick === 'volver') return;
        try {
          if (pick === 'buscar') await lookup(io, e, snapshot, found);
          else if (pick === 'probar') await probeFlow(io, e);
          else if (pick === 'init') await initFlow(io, e);
          else if (pick === 'vaciar') { queue.clear(); io.write(note('Cola vaciada.')); }
          else toggle(io, list[Number(pick.slice(1))]!);
        } catch (error) {
          if (!(error instanceof ValidationError)) throw error;
          io.write(`\n  ! ${error.message}\n`);
        }
      }
    },
    async review(io) {
      const e = await get();
      io.write(reviewView([...queue.values()].map(action => e.reviewOf(action, deps))));
      io.write(note('Al aplicar, primero se guarda el perfil y después se ejecutan estas acciones; cada resultado se informa por separado.'));
      const decision = await choose(io, 'Aplicar integraciones', [
        { value: 'back', label: 'Volver', hint: 'No guarda ni cambia nada' },
        { value: 'apply', label: 'Aplicar', hint: 'Guarda el perfil y ejecuta la cola' },
      ]);
      return decision === 'apply' ? 'apply' : 'back';
    },
    async apply(io) {
      const e = await get();
      const actions = [...queue.values()];
      queue.clear();
      try { io.write(resultView(await e.apply(actions, deps))); }
      catch (error) {
        io.write(`\n  ! La aplicación de integraciones terminó con un error inesperado: ${error instanceof Error ? error.message : 'error desconocido'}. Revisá el estado antes de reintentar; el perfil ya quedó guardado.\n`);
      }
    },
  };
}
