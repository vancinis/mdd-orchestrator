import { defaultSettings, MODEL_ROLES, NATIVE_SUBAGENTS, parseModel, parseSettings, profileName } from './settings.js';
import type { ModelRole, NativeSubagent, Mode, Preferences, Summary } from './settings.js';
import { loadGlobalSettings, saveGlobalSettings } from './global-settings.js';
import { installationPaths } from './installation-paths.js';
import type { Settings } from './settings.js';
import { ValidationError } from './validation.js';
import { ask, Cancelled, choose, createTerminalIO, heading, note, rows } from './tui.js';
import type { Choice, ConfigIO } from './tui.js';
import { listModels, listVariants, providersOf } from './model-catalog.js';
import type { ModelCatalog, VariantCatalog } from './model-catalog.js';

export type { Choice, ConfigIO } from './tui.js';

const UNSET = '-';
const MODE_CHOICES: readonly Choice[] = [
  { value: 'automatic', label: 'Automático', hint: 'Avanza de un agente al siguiente sin preguntar' },
  { value: 'interactive', label: 'Interactivo', hint: 'Pregunta antes de cada agente' },
  { value: UNSET, label: 'Sin fijar', hint: 'El orquestador lo pregunta en cada run' },
];
const SUMMARY_CHOICES: readonly Choice[] = [
  { value: 'low', label: 'Bajo', hint: 'Un párrafo corto por agente' },
  { value: 'medium', label: 'Medio', hint: 'Agrega propósito y aprendizajes clave (por defecto)' },
  { value: 'detailed', label: 'Detallado', hint: 'Agrega enfoque, pendientes, confianza y estado' },
  { value: UNSET, label: 'Sin fijar', hint: 'Usa el valor por defecto: medio' },
];
const MENU: readonly Choice[] = [
  { value: 'perfiles', label: 'Perfiles', hint: 'Crear un perfil o cambiar el activo' },
  { value: 'modelos', label: 'Modelos', hint: 'Elegir el modelo de cada agente' },
  { value: 'preferencias', label: 'Preferencias', hint: 'Modo de avance y nivel de detalle' },
  { value: 'guardar', label: 'Guardar y salir', hint: 'Escribe los cambios y cierra' },
  { value: 'cancelar', label: 'Cancelar', hint: 'Sale sin escribir nada' },
  { value: 'subagentes', label: 'Subagentes nativos', hint: 'Modelos de explore y general solo desde mdd-orchestrator' },
];
const PROFILE_MENU: readonly Choice[] = [
  { value: 'crear', label: 'Crear perfil', hint: 'Empieza desde los valores por defecto' },
  { value: 'usar', label: 'Cambiar de perfil', hint: 'Elegir cuál queda activo' },
  { value: 'volver', label: 'Volver', hint: 'Sin cambios' },
];

const label = (choices: readonly Choice[], value: string | undefined) => choices.find(choice => choice.value === (value ?? UNSET))!.label;

function overview(draft: Settings): string {
  const profile = draft.profiles[draft.activeProfile]!;
  const models = MODEL_ROLES.filter(role => profile.models[role]).length;
  return `${heading('MDD \u00b7 Configuración global')}${rows([
    ['Archivo', installationPaths().settingsPath],
    ['Perfil activo', `${draft.activeProfile}  (${Object.keys(draft.profiles).length} en total)`],
    ['Modelos', `${models}/${MODEL_ROLES.length} asignados; el resto hereda el modelo nativo`],
    ['Subagentes nativos', NATIVE_SUBAGENTS.map(agent => `${agent}: ${profile.subagentModels?.[agent] ?? 'sin fijar'}`).join('; ')],
    ['Modo', label(MODE_CHOICES, profile.answers.mode)],
    ['Detalle', label(SUMMARY_CHOICES, profile.answers.summary)],
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

async function editModels(io: ConfigIO, profile: Settings['profiles'][string], catalog: () => ModelCatalog, variantsOf: (provider: string) => VariantCatalog, native = false): Promise<void> {
  const roles = native ? NATIVE_SUBAGENTS : MODEL_ROLES;
  const models: Partial<Record<ModelRole | NativeSubagent, string>> = { ...(native ? profile.subagentModels : profile.models) };
  io.write(`${heading(native ? 'Subagentes nativos' : 'Modelos por agente')}${rows(roles.map(role =>
    [role, models[role] ?? 'hereda el modelo nativo'] as const))}`);
  if (native) io.write(note('Solo llamadas nuevas desde mdd-orchestrator. No reemplaza modelos explícitos ni cambia sesiones reanudadas.'));
  io.write(note('Consultando los modelos instalados en OpenCode\u2026'));
  const available = catalog();
  if (available.status === 'unavailable') {
    io.write(`${note(available.reason)}${note(native
      ? 'Vas a escribirlos a mano y no se pueden verificar. Un modelo inexistente hará fallar la llamada al subagente.'
      : 'Vas a escribirlos a mano y no se pueden verificar. Un modelo inexistente hace que OpenCode descarte el agente al arrancar.')}`);
    for (const role of roles) {
      const value = await ask(io, `Modelo para ${role}`,
        `actual: ${models[role] ?? 'hereda el nativo'}  \u00b7  formato proveedor/modelo[#esfuerzo]  \u00b7  Enter mantiene  \u00b7  «-» lo borra`);
      if (value === '-') delete models[role];
      else if (value) models[role] = parseModel(value);
    }
    if (native) profile.subagentModels = models; else profile.models = models;
    return;
  }
  const unknown = roles.filter(role => models[role] && !available.models.includes(splitVariant(models[role])[0]!));
  io.write(note(`${available.models.length} modelos disponibles en ${providersOf(available.models).length} proveedores.`));
  if (unknown.length) io.write(note(`Atención: ${unknown.map(role => `${role}=${models[role]}`).join(', ')} no está entre los modelos instalados; ${native ? 'la llamada al subagente fallaría' : 'OpenCode descartaría ese agente al arrancar'}.`));
  const providers = providersOf(available.models);
  // The verbose catalog is one call per provider; fetched at most once each, only when used.
  const variantCache = new Map<string, VariantCatalog>();
  const variantsFor = (provider: string): VariantCatalog => {
    if (!variantCache.has(provider)) variantCache.set(provider, variantsOf(provider));
    return variantCache.get(provider)!;
  };
  for (const role of roles) {
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
  if (native) profile.subagentModels = models; else profile.models = models;
}

async function editPreferences(io: ConfigIO, profile: Settings['profiles'][string]): Promise<void> {
  const answers: Preferences = { ...profile.answers };
  io.write(heading('Preferencias del orquestador'));
  const index = (choices: readonly Choice[], value: string | undefined) => choices.findIndex(choice => choice.value === (value ?? UNSET));
  const mode = await choose(io, 'Modo de avance  (1/2)', MODE_CHOICES, { initial: index(MODE_CHOICES, answers.mode) });
  if (mode === UNSET) delete answers.mode; else answers.mode = mode as Mode;
  const summary = await choose(io, 'Nivel de detalle de los reportes  (2/2)', SUMMARY_CHOICES, { initial: index(SUMMARY_CHOICES, answers.summary) });
  if (summary === UNSET) delete answers.summary; else answers.summary = summary as Summary;
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
  const draft = loadGlobalSettings();
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
        else if (action === 'subagentes') await editModels(io, profile, catalog, variantsOf, true);
        else if (action === 'preferencias') await editPreferences(io, profile);
        else if (action === 'guardar') {
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
