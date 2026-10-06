import { ANSWER_FIELDS, answerFromLabel, questionEnvelope } from './preflight.js';
import { defaultSettings, MODEL_ROLES, parseModel, parseSettings, profileName } from './settings.js';
import { loadGlobalSettings, saveGlobalSettings } from './global-settings.js';
import { installationPaths } from './installation-paths.js';
import type { Settings } from './settings.js';
import { ValidationError } from './validation.js';
import { ask, Cancelled, choose, createTerminalIO, heading, note, rows } from './tui.js';
import type { Choice, ConfigIO } from './tui.js';
import { listModels, listVariants, providersOf } from './model-catalog.js';
import type { ModelCatalog, VariantCatalog } from './model-catalog.js';

export type { Choice, ConfigIO } from './tui.js';

const FIELD_TITLES: Record<string, string> = {
  certainty: 'Certeza sobre los requisitos',
  artifactStore: 'Dónde guardar los artefactos del flujo',
  mode: 'Cómo aprobar las fases posteriores',
  summary: 'Cuánto detalle querés en los reportes',
};
const UNANSWERED: Choice = { value: '-', label: 'Sin responder', hint: 'Se pregunta al iniciar cada run' };
const MENU: readonly Choice[] = [
  { value: 'perfiles', label: 'Perfiles', hint: 'Crear un perfil o cambiar el activo' },
  { value: 'modelos', label: 'Modelos', hint: 'Elegir el modelo de cada agente' },
  { value: 'preflight', label: 'Respuestas de preflight', hint: 'Fijar las 4 respuestas por defecto' },
  { value: 'memoria', label: 'Memoria (Engram)', hint: 'Endpoint avanzado o apagarla' },
  { value: 'telemetria', label: 'Telemetría', hint: 'Métricas locales, nunca por red' },
  { value: 'guardar', label: 'Guardar y salir', hint: 'Escribe los cambios y cierra' },
  { value: 'cancelar', label: 'Cancelar', hint: 'Sale sin escribir nada' },
];
const PROFILE_MENU: readonly Choice[] = [
  { value: 'crear', label: 'Crear perfil', hint: 'Empieza desde los valores por defecto' },
  { value: 'usar', label: 'Cambiar de perfil', hint: 'Elegir cuál queda activo' },
  { value: 'volver', label: 'Volver', hint: 'Sin cambios' },
];
const MEMORY_MENU: readonly Choice[] = [
  { value: 'endpoint', label: 'Configurar endpoint', hint: 'Avanzado: http://127.0.0.1:PUERTO' },
  { value: 'off', label: 'Apagar la memoria', hint: 'MDD funciona igual sin memoria' },
  { value: 'volver', label: 'Volver', hint: 'Sin cambios' },
];

function memoryLabel(settings: Settings): string {
  const engram = settings.engram;
  if (!engram) return 'apagada (es lo normal; no requiere instalación)';
  return 'endpoint' in engram ? `endpoint ${engram.endpoint}` : `binario local ${engram.binary}`;
}

function overview(draft: Settings): string {
  const profile = draft.profiles[draft.activeProfile]!;
  const models = MODEL_ROLES.filter(role => profile.models[role]).length;
  const answered = ANSWER_FIELDS.filter(field => profile.answers[field]).length;
  return `${heading('MDD \u00b7 Configuración global')}${rows([
    ['Archivo', installationPaths().settingsPath],
    ['Perfil activo', `${draft.activeProfile}  (${Object.keys(draft.profiles).length} en total)`],
    ['Modelos', `${models}/${MODEL_ROLES.length} asignados; el resto hereda el modelo nativo`],
    ['Preflight', `${answered}/${ANSWER_FIELDS.length} respondidas; las vacías se preguntan en cada run`],
    ['Memoria', memoryLabel(draft)],
    ['Telemetría', draft.telemetry.enabled ? 'activada (eventos locales del workspace)' : 'apagada'],
  ])}${note('Nada se escribe hasta elegir «Guardar y salir».')}`;
}

const KEEP = '\u0000keep';
const INHERIT = '\u0000inherit';
const DEFAULT_EFFORT = '\u0000default-effort';

/** `model#variant` split; a bare model has no reasoning-effort override. */
function splitVariant(model: string | undefined): readonly [string | undefined, string | undefined] {
  if (!model) return [undefined, undefined];
  const index = model.indexOf('#');
  return index < 0 ? [model, undefined] : [model.slice(0, index), model.slice(index + 1)];
}

async function editModels(io: ConfigIO, profile: Settings['profiles'][string], catalog: () => ModelCatalog, variantsOf: (provider: string) => VariantCatalog): Promise<void> {
  io.write(`${heading('Modelos por agente')}${rows(MODEL_ROLES.map(role =>
    [role, profile.models[role] ?? 'hereda el modelo nativo'] as const))}`);
  io.write(note('Consultando los modelos instalados en OpenCode\u2026'));
  const available = catalog();
  const models = { ...profile.models };
  if (available.status === 'unavailable') {
    io.write(`${note(available.reason)}${note('Vas a escribirlos a mano y no se pueden verificar. Un modelo inexistente hace que OpenCode descarte el agente al arrancar.')}`);
    for (const role of MODEL_ROLES) {
      const value = await ask(io, `Modelo para ${role}`,
        `actual: ${models[role] ?? 'hereda el nativo'}  \u00b7  formato proveedor/modelo[#esfuerzo]  \u00b7  Enter mantiene  \u00b7  «-» lo borra`);
      if (value === '-') delete models[role];
      else if (value) models[role] = parseModel(value);
    }
    profile.models = models;
    return;
  }
  const unknown = MODEL_ROLES.filter(role => models[role] && !available.models.includes(splitVariant(models[role])[0]!));
  io.write(note(`${available.models.length} modelos disponibles en ${providersOf(available.models).length} proveedores.`));
  if (unknown.length) io.write(note(`Atención: ${unknown.map(role => `${role}=${models[role]}`).join(', ')} no está entre los modelos instalados; OpenCode descartaría ese agente al arrancar.`));
  const providers = providersOf(available.models);
  // The verbose catalog is one call per provider; fetched at most once each, only when used.
  const variantCache = new Map<string, VariantCatalog>();
  const variantsFor = (provider: string): VariantCatalog => {
    if (!variantCache.has(provider)) variantCache.set(provider, variantsOf(provider));
    return variantCache.get(provider)!;
  };
  for (const role of MODEL_ROLES) {
    const current = models[role];
    const [currentModel, currentVariant] = splitVariant(current);
    const choice = await choose(io, `Modelo para ${role}`, [
      { value: KEEP, label: 'Mantener lo actual', hint: current ?? 'hereda el modelo nativo' },
      ...(current ? [{ value: INHERIT, label: 'Heredar el modelo nativo', hint: 'quita el override de este agente' }] : []),
      ...providers.map(provider => ({ value: provider, label: provider,
        hint: `${available.models.filter(model => model.startsWith(`${provider}/`)).length} modelos` })),
    ]);
    if (choice === KEEP) continue;
    if (choice === INHERIT) { delete models[role]; continue; }
    const options = available.models.filter(model => model.startsWith(`${choice}/`));
    const selected = await choose(io, `Modelo de ${choice} para ${role}`,
      options.map(model => ({ value: model, label: model.slice(choice.length + 1), hint: currentModel === model ? 'actual' : '' })),
      { initial: Math.max(options.indexOf(currentModel ?? ''), 0) });
    const variantResult = variantsFor(choice);
    const variantIds = variantResult.status === 'ok' ? (variantResult.variants[selected] ?? []) : [];
    let effort: string | undefined;
    if (variantIds.length) {
      const effortChoice = await choose(io, `Esfuerzo (opcional) para ${selected}`, [
        { value: DEFAULT_EFFORT, label: 'Por defecto del modelo', hint: 'sin nivel de esfuerzo fijo' },
        ...variantIds.map(id => ({ value: id, label: id, hint: currentModel === selected && currentVariant === id ? 'actual' : '' })),
      ], { initial: currentModel === selected ? variantIds.indexOf(currentVariant ?? '') + 1 : 0 });
      if (effortChoice !== DEFAULT_EFFORT) effort = effortChoice;
    } else if (variantResult.status === 'unavailable') {
      io.write(note(`No se pudieron consultar los niveles de esfuerzo de ${choice}: ${variantResult.reason}`));
    }
    models[role] = parseModel(effort ? `${selected}#${effort}` : selected);
  }
  profile.models = models;
}

async function editAnswers(io: ConfigIO, profile: Settings['profiles'][string]): Promise<void> {
  const answers = { ...profile.answers };
  const questions = questionEnvelope().questions;
  io.write(heading('Respuestas de preflight por defecto'));
  for (const [index, field] of ANSWER_FIELDS.entries()) {
    // The envelope already carries the user-facing Spanish label; a second copy here could drift.
    const options = questions[index]!.options.map(option => ({ value: option.label, label: option.label, hint: option.description }));
    const current = options.findIndex(option => answerFromLabel(field, option.value) === answers[field]);
    const choice = await choose(io, `${FIELD_TITLES[field] ?? field}  (${index + 1}/${ANSWER_FIELDS.length})`,
      [...options, UNANSWERED], { initial: current < 0 ? options.length : current });
    if (choice === UNANSWERED.value) delete answers[field];
    else Object.assign(answers, { [field]: answerFromLabel(field, choice) });
  }
  profile.answers = answers;
}

/** Injected line input and catalog allow deterministic tests; all edits remain drafts until Save. */
export async function runConfigUI(root: string, io: ConfigIO, dependencies: { models?: () => ModelCatalog; variants?: (provider: string) => VariantCatalog } = {}): Promise<'saved' | 'cancelled'> {
  // The catalog and its variants are read lazily, only when the models menu is opened.
  const catalog = dependencies.models ?? (() => listModels());
  const variantsOf = dependencies.variants ?? ((provider: string) => listVariants(provider));
  if (!io.isTTY) {
    throw new ValidationError('mdd config necesita una terminal interactiva. Usá los comandos mdd profile list/create/use, o editá el archivo global mdd/mdd.config.json y validalo con mdd profile list.');
  }
  let draft = loadGlobalSettings();
  try {
    for (;;) {
      io.write(overview(draft));
      try {
        const action = await choose(io, '¿Qué querés hacer?', MENU);
        const profile = draft.profiles[draft.activeProfile]!;
        if (action === 'cancelar') throw new Cancelled();
        if (action === 'perfiles') {
          const sub = await choose(io, `Perfiles  (activo: ${draft.activeProfile})`, PROFILE_MENU);
          if (sub === 'crear') {
            const name = profileName(await ask(io, 'Nombre del perfil nuevo', 'letras, dígitos, guion y guion bajo; 1-64 caracteres'));
            if (Object.hasOwn(draft.profiles, name)) throw new ValidationError('Ese perfil ya existe.');
            draft.profiles[name] = defaultSettings().profiles.default!;
            draft.activeProfile = name;
          } else if (sub === 'usar') {
            const names = Object.keys(draft.profiles).sort();
            draft.activeProfile = await choose(io, 'Perfil activo',
              names.map(name => ({ value: name, label: name, hint: name === draft.activeProfile ? 'activo ahora' : '' })),
              { initial: Math.max(names.indexOf(draft.activeProfile), 0) });
          }
        } else if (action === 'modelos') await editModels(io, profile, catalog, variantsOf);
        else if (action === 'preflight') await editAnswers(io, profile);
        else if (action === 'memoria') {
          const sub = await choose(io, `Memoria (Engram)  \u00b7  ahora: ${memoryLabel(draft)}`, MEMORY_MENU);
          if (sub === 'off') delete draft.engram;
          else if (sub === 'endpoint') {
            const endpoint = await ask(io, 'Endpoint de Engram', 'http://127.0.0.1:PUERTO  \u00b7  para memoria administrada usá mdd setup');
            if (endpoint) draft = parseSettings({ ...draft, engram: { endpoint } });
          }
        } else if (action === 'telemetria') {
          draft.telemetry.enabled = await choose(io, 'Telemetría local', [
            { value: 'on', label: 'Activada', hint: 'Eventos de ciclo de vida en el workspace, sin red' },
            { value: 'off', label: 'Apagada', hint: 'No se registra ningún evento' },
          ], { initial: draft.telemetry.enabled ? 0 : 1 }) === 'on';
        } else if (action === 'guardar') {
          saveGlobalSettings(draft);
          io.write('\n  Listo: configuración global guardada.\n  Reiniciá OpenCode para cargar el perfil en cualquier proyecto.\n');
          return 'saved';
        }
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        io.write(`\n  ! ${error.message}\n`);
      }
    }
  } catch (error) {
    if (!(error instanceof Cancelled)) throw error;
    io.write('\n  Cancelado. No se escribió ninguna configuración.\n');
    return 'cancelled';
  }
}

export async function runTerminalConfig(root: string): Promise<'saved' | 'cancelled'> {
  const { io, close } = createTerminalIO();
  if (!io.isTTY) {
    throw new ValidationError('mdd config necesita una terminal interactiva. Usá mdd profile list/create/use, o editá el archivo global mdd/mdd.config.json.');
  }
  try { return await runConfigUI(root, io); } finally { close(); }
}

export function changeProfile(settings: Settings, action: 'create' | 'use', name: string): Settings {
  const draft = parseSettings(settings);
  profileName(name);
  if (action === 'create') {
    if (Object.hasOwn(draft.profiles, name)) throw new ValidationError('Profile already exists.');
    draft.profiles[name] = { models: {}, answers: {} };
  } else if (!Object.hasOwn(draft.profiles, name)) throw new ValidationError('Unknown profile.');
  draft.activeProfile = name;
  return parseSettings(draft);
}
