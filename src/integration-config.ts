import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { applyEdits, modify, parse, parseTree, type Node, type ParseError } from 'jsonc-parser';
import { installationPaths } from './installation-paths.js';
import { retryTransient } from './local-files.js';
import { scopedPath } from './safe-paths.js';

/**
 * OpenCode MCP configuration for the optional integrations: layered read-only discovery,
 * classification, narrowly planned JSONC edits and a digest-guarded atomic write.
 * This is the only module that imports `jsonc-parser`; it must never be reachable from the
 * version manager import graph (the manager copy has no node_modules).
 */

export type ServerValue = Record<string, unknown>;
export type ConfigEdit =
  | { add: ServerValue }
  | { command: { from: string[]; to: string[] } };
export type IntegrationId = 'context7' | 'engram' | 'codegraph';
export type LayerScope = 'global' | 'project' | 'system';

export const CONFIG_LIMIT = 4 * 1024 * 1024;
export const CONFIG_FILE_NAMES = Object.freeze(['opencode.json', 'opencode.jsonc'] as const);
/** Disclosed with every discovery: what an offline read cannot see. */
export const DISCOVERY_LIMITS = 'La detección es local y solo cubre el directorio actual y sus padres; no ve configuración de organización o consola ni el entorno del servicio en ejecución.';

const CANONICAL: Record<IntegrationId, string> = { context7: 'context7', engram: 'engram', codegraph: 'codegraph' };
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const FORBIDDEN_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
/** Digest convention shared with `readLayers().target.beforeDigest`: sha256 of the raw bytes, or `absent`. */
export const configDigest = (text: string | undefined): string => (text === undefined ? 'absent' : sha256(Buffer.from(text, 'utf8')));

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

type Parsed = { value: unknown; errors: ParseError[]; duplicate: boolean };

function duplicateKeys(node: Node | undefined): boolean {
  if (!node) return false;
  if (node.type === 'object') {
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value;
      if (typeof key === 'string') {
        if (seen.has(key)) return true;
        seen.add(key);
      }
      if (duplicateKeys(property.children?.[1])) return true;
    }
    return false;
  }
  return (node.children ?? []).some(duplicateKeys);
}

function parseConfig(text: string): Parsed {
  const body = stripBom(text);
  if (!body.trim()) return { value: {}, errors: [], duplicate: false };
  const errors: ParseError[] = [];
  const value = parse(body, errors, { allowTrailingComma: true, disallowComments: false });
  const treeErrors: ParseError[] = [];
  const duplicate = duplicateKeys(parseTree(body, treeErrors, { allowTrailingComma: true, disallowComments: false }));
  return { value, errors, duplicate };
}

// ---------------------------------------------------------------------------------------------
// Edit planning
// ---------------------------------------------------------------------------------------------

function formatting(body: string): { eol: string; insertSpaces: boolean; tabSize: number } {
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const indent = /^([ \t]+)"/m.exec(body)?.[1];
  if (indent?.startsWith('\t')) return { eol, insertSpaces: false, tabSize: 1 };
  return { eol, insertSpaces: true, tabSize: indent ? indent.length : 2 };
}

/**
 * Plan one targeted edit of `mcp.servers.<name>` in the global OpenCode file text. Comments,
 * unrelated entries and credentials are untouched. Anything ambiguous refuses without output.
 */
export function planServerEdit(text: string | undefined, name: string, change: ConfigEdit): { next: string } | { refused: string } {
  if (!SERVER_NAME.test(name) || FORBIDDEN_NAMES.has(name)) return { refused: 'Nombre de servidor no válido; no se escribió nada.' };
  const bom = text !== undefined && text.charCodeAt(0) === 0xfeff;
  const original = text === undefined ? '' : stripBom(text);
  const base = original.trim() ? original : '{}';
  const finalNewline = text === undefined || !original.trim() || /\n$/.test(original);
  const parsed = parseConfig(base);
  if (parsed.errors.length) return { refused: 'El archivo de configuración tiene errores de sintaxis; no se escribió nada.' };
  if (parsed.duplicate) return { refused: 'Estructura ambigua (claves duplicadas); no se escribió nada.' };
  const root = parsed.value;
  if (!isObject(root)) return { refused: 'La raíz de la configuración no es un objeto; no se escribió nada.' };
  const mcp = root.mcp;
  if (mcp !== undefined && !isObject(mcp)) return { refused: '«mcp» no es un objeto; no se escribió nada.' };
  const servers = mcp?.servers;
  if (servers !== undefined && !isObject(servers)) return { refused: '«mcp.servers» no es un objeto; no se escribió nada.' };
  if (mcp && isObject(mcp[name])) return { refused: `Ya existe una entrada heredada «mcp.${name}»; MDD no la modifica.` };

  const expected = structuredClone(root) as Record<string, any>;
  let path: string[];
  let value: unknown;
  if ('add' in change) {
    if (!isObject(change.add)) return { refused: 'El servidor a agregar no es un objeto; no se escribió nada.' };
    if (servers && Object.hasOwn(servers, name)) return { refused: `«mcp.servers.${name}» ya existe; MDD no lo sobrescribe.` };
    path = ['mcp', 'servers', name];
    value = change.add;
    expected.mcp ??= {};
    expected.mcp.servers ??= {};
    expected.mcp.servers[name] = structuredClone(change.add);
  } else {
    const current = servers && Object.hasOwn(servers, name) ? servers[name] : undefined;
    if (!isObject(current)) return { refused: `«mcp.servers.${name}» no existe; no hay nada que actualizar.` };
    const { from, to } = change.command;
    if (!strings(from) || !strings(to) || !to.length) return { refused: 'Comando no válido; no se escribió nada.' };
    if (!isDeepStrictEqual(current.command, from)) return { refused: `El comando de «mcp.servers.${name}» cambió desde la revisión; no se escribió nada.` };
    if (isDeepStrictEqual(from, to)) return { next: text ?? '' };
    path = ['mcp', 'servers', name, 'command'];
    value = to;
    expected.mcp.servers[name].command = [...to];
  }

  const format = formatting(base);
  let body: string;
  try {
    body = applyEdits(base, modify(base, path, value, { formattingOptions: { ...format, insertFinalNewline: false } }));
  } catch {
    return { refused: 'No se pudo planificar la edición; no se escribió nada.' };
  }
  if (finalNewline && !/\n$/.test(body)) body += format.eol;
  const after = parseConfig(body);
  if (after.errors.length || after.duplicate || !isDeepStrictEqual(after.value, expected)) {
    return { refused: 'Estructura ambigua (por ejemplo claves duplicadas); no se escribió nada.' };
  }
  return { next: (bom ? '\ufeff' : '') + body };
}

// ---------------------------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------------------------

export interface LayerEntry {
  name: string;
  value: ServerValue;
  legacy: boolean;
  disabled: boolean;
  scope: LayerScope;
  file: string;
  rank: number;
}

export interface ConfigLayer {
  path: string;
  scope: LayerScope;
  rank: number;
  exists: boolean;
  digest: string;
  entries: LayerEntry[];
  /** Why the file contributes nothing (OpenCode ignores it); only a blocker for the global file. */
  ignored?: string;
}

export interface LayerTarget {
  path: string;
  beforeDigest: string;
  /** Raw file text (BOM included) or undefined when the file does not exist yet. */
  text?: string;
}

export interface Layers {
  /** Ascending precedence: later layers win per server name. */
  layers: ConfigLayer[];
  /** Reasons that forbid any write (never reasons to hide what was found). */
  blockers: string[];
  notes: string[];
  target: LayerTarget;
  limits: string;
}

export interface ReadLayersInput {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}

type Read = { exists: false } | { exists: true; text: string; digest: string };

function readFile(path: string, strictLinks: boolean, root?: string): Read {
  if (strictLinks) scopedPath(root!, basename(path));
  const stat = fs.statSync(path, { throwIfNoEntry: false });
  if (!stat) return { exists: false };
  if (!stat.isFile()) throw new Error('no es un archivo regular');
  if (stat.size > CONFIG_LIMIT) throw new Error('supera el límite de 4 MiB');
  const fd = fs.openSync(path, fs.constants.O_RDONLY | (strictLinks ? (fs.constants.O_NOFOLLOW ?? 0) : 0));
  try {
    const bytes = fs.readFileSync(fd);
    if (bytes.length > CONFIG_LIMIT) throw new Error('supera el límite de 4 MiB');
    return { exists: true, text: bytes.toString('utf8'), digest: sha256(bytes) };
  } finally { fs.closeSync(fd); }
}

function extract(root: unknown, scope: LayerScope, file: string, rank: number): { entries: LayerEntry[]; problem?: string } {
  if (!isObject(root)) return { entries: [], problem: 'la raíz no es un objeto' };
  const mcp = root.mcp;
  if (mcp === undefined) return { entries: [] };
  if (!isObject(mcp)) return { entries: [], problem: '«mcp» no es un objeto' };
  const servers = mcp.servers;
  if (servers !== undefined && !isObject(servers)) return { entries: [], problem: '«mcp.servers» no es un objeto' };
  const entries = new Map<string, LayerEntry>();
  const make = (name: string, value: unknown, legacy: boolean): void => {
    if (!isObject(value)) return;
    entries.set(name, { name, value, legacy, disabled: value.disabled === true || value.enabled === false, scope, file, rank });
  };
  for (const [name, value] of Object.entries(mcp)) if (name !== 'servers' && isObject(value) && 'type' in value) make(name, value, true);
  // Native entries win over legacy ones with the same name inside the same file.
  for (const [name, value] of Object.entries(servers ?? {})) make(name, value, false);
  return { entries: [...entries.values()] };
}

const normal = (path: string, platform: NodeJS.Platform): string => (platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));

function systemDirectory(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === 'darwin') return '/Library/Application Support/opencode';
  if (platform === 'win32') return join(env.ProgramData || 'C:\\ProgramData', 'opencode');
  return '/etc/opencode';
}

/** File reads only, no subprocess. A layer that cannot be read is reported, never silently skipped. */
export function readLayers({ cwd, env = process.env, platform = process.platform, home }: ReadLayersInput): Layers {
  const paths = installationPaths(home === undefined ? { env } : { home, env });
  const configRoot = paths.configRoot;
  const layers: ConfigLayer[] = [];
  const blockers: string[] = [];
  const notes: string[] = [];
  let rank = 0;

  const load = (path: string, scope: LayerScope, strict: boolean): ConfigLayer => {
    // Only files that exist consume a precedence rank.
    const layer: ConfigLayer = { path, scope, rank: rank + 1, exists: false, digest: 'absent', entries: [] };
    let read: Read;
    try { read = readFile(path, strict, strict ? configRoot : undefined); }
    catch (error) {
      rank++;
      layer.exists = true;
      layer.digest = 'unreadable';
      layer.ignored = `No se pudo leer de forma segura (${(error as Error).message}).`;
      return layer;
    }
    if (!read.exists) return layer;
    rank++;
    layer.exists = true;
    layer.digest = read.digest;
    const parsed = parseConfig(read.text);
    if (parsed.errors.length) { layer.ignored = 'Sintaxis no válida; OpenCode lo ignora.'; return layer; }
    if (parsed.duplicate) { layer.ignored = 'Claves duplicadas; estructura ambigua.'; return layer; }
    const { entries, problem } = extract(parsed.value, scope, path, layer.rank);
    if (problem) layer.ignored = `Estructura no esperada: ${problem}.`;
    layer.entries = entries;
    return layer;
  };

  // Global files (lowest precedence among the files MDD may edit): opencode.json, then opencode.jsonc.
  const globalLayers: ConfigLayer[] = CONFIG_FILE_NAMES.map((name) => load(join(configRoot, name), 'global', true));
  for (const layer of globalLayers) {
    layers.push(layer);
    if (layer.ignored) blockers.push(`${layer.path}: ${layer.ignored}`);
  }
  const jsonc = globalLayers[1]!;
  const picked = jsonc.exists ? jsonc : globalLayers[0]!;
  const target: LayerTarget = { path: picked.path, beforeDigest: picked.digest };
  if (picked.exists && !picked.ignored) {
    try { const read = readFile(picked.path, true, configRoot); if (read.exists) target.text = read.text; } catch { /* the layer already carries the blocker */ }
  }

  // Project files: the current directory chain, farthest first; direct files before `.opencode/`.
  const system = systemDirectory(platform, env);
  const skip = new Set([normal(configRoot, platform), normal(system, platform)]);
  let start: string | undefined;
  try { start = fs.realpathSync(cwd); } catch { notes.push('No se pudo resolver el directorio actual; no se leyó configuración de proyecto.'); }
  const chain: string[] = [];
  for (let dir = start; dir; ) {
    chain.unshift(dir);
    const parent = dirname(dir);
    dir = parent === dir ? undefined : parent;
  }
  const projectFiles: string[] = [];
  for (const dir of chain) if (!skip.has(normal(dir, platform))) for (const name of CONFIG_FILE_NAMES) projectFiles.push(join(dir, name));
  for (const dir of chain) {
    const nested = join(dir, '.opencode');
    if (!skip.has(normal(nested, platform))) for (const name of CONFIG_FILE_NAMES) projectFiles.push(join(nested, name));
  }
  for (const path of projectFiles) {
    const layer = load(path, 'project', false);
    if (!layer.exists) continue;
    layers.push(layer);
    if (layer.ignored) notes.push(`${path}: ${layer.ignored}`);
  }

  // System files (highest precedence among files).
  for (const name of CONFIG_FILE_NAMES) {
    const layer = load(join(system, name), 'system', false);
    if (!layer.exists) continue;
    layers.push(layer);
    if (layer.ignored) notes.push(`${layer.path}: ${layer.ignored}`);
  }

  // Environment inputs that make the effective configuration unknowable from files alone.
  const envDir = env.OPENCODE_CONFIG_DIR;
  if (envDir && normal(envDir, platform) !== normal(configRoot, platform)) blockers.push('OPENCODE_CONFIG_DIR apunta a otro directorio; la configuración efectiva depende de variables de entorno.');
  if (env.OPENCODE_CONFIG) blockers.push('OPENCODE_CONFIG está definida; la configuración efectiva depende de variables de entorno.');
  if (env.OPENCODE_CONFIG_CONTENT) blockers.push('OPENCODE_CONFIG_CONTENT está definida; la configuración efectiva depende de variables de entorno.');
  if (platform === 'darwin') {
    const user = env.USER;
    const plists = ['/Library/Managed Preferences/ai.opencode.managed.plist', ...(user ? [`/Library/Managed Preferences/${user}/ai.opencode.managed.plist`] : [])];
    if (plists.some((plist) => fs.existsSync(plist))) blockers.push('Existe una configuración administrada (MDM) de OpenCode; no se puede evaluar sin ejecutarlo.');
  }
  return { layers, blockers, notes, target, limits: DISCOVERY_LIMITS };
}

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

export type Classification =
  | { state: 'reuse'; source: 'managed' | 'external'; name: string; scope: LayerScope; file: string; legacy: boolean; reason: string }
  | { state: 'absent'; target: LayerTarget; name: string; reason: string }
  | { state: 'blocked'; why: 'disabled' | 'conflict' | 'unknown'; name?: string; scope?: LayerScope; file?: string; reason: string };

type Identity = 'match' | 'no' | 'unknown';
const UNRESOLVED = /\{(?:env|file):/;
const exeName = (path: string): string => (path.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '');
const normalizeSlashes = (value: string): string => value.replace(/\\/g, '/').toLowerCase();

function identify(id: IntegrationId, value: ServerValue): Identity {
  const type = value.type;
  if (type === 'remote') {
    if (typeof value.url !== 'string') return 'no';
    if (UNRESOLVED.test(value.url)) return 'unknown';
    if (id !== 'context7') return 'no';
    try { const url = new URL(value.url); return url.protocol === 'https:' && url.hostname.toLowerCase() === 'mcp.context7.com' ? 'match' : 'no'; }
    catch { return 'no'; }
  }
  if (type !== 'local' || !strings(value.command) || !value.command.length) return 'no';
  const command = value.command;
  if (command.some((part) => UNRESOLVED.test(part))) return 'unknown';
  if (id === 'context7') return command.some((part) => part.includes('@upstash/context7-mcp')) ? 'match' : 'no';
  if (id === 'engram') return exeName(command[0]!) === 'engram' && command[1] === 'mcp' ? 'match' : 'no';
  const serves = command.includes('serve') && command.includes('--mcp');
  const form = exeName(command[0]!) === 'codegraph'
    || command.some((part) => normalizeSlashes(part).endsWith('lib/dist/bin/codegraph.js'))
    || command.some((part) => part.includes('@colbymchenry/codegraph'));
  return serves && form ? 'match' : 'no';
}

/** Decide reuse / absent / blocked from the effective (highest-rank) entry per name. */
export function classify(id: IntegrationId, layers: Layers, managedCommands: string[][]): Classification {
  const canonical = CANONICAL[id];
  const effective = new Map<string, LayerEntry>();
  for (const layer of [...layers.layers].sort((a, b) => a.rank - b.rank)) for (const entry of layer.entries) effective.set(entry.name, entry);

  const matches: LayerEntry[] = [];
  for (const entry of effective.values()) if (identify(id, entry.value) === 'match') matches.push(entry);
  const order = (entry: LayerEntry): number => (entry.name === canonical ? 1e6 : 0) + entry.rank;
  matches.sort((a, b) => order(b) - order(a));

  const enabled = matches.find((entry) => !entry.disabled);
  if (enabled) {
    const command = enabled.value.command;
    const managed = strings(command) && managedCommands.some((candidate) => isDeepStrictEqual(candidate, command));
    return {
      state: 'reuse', source: managed ? 'managed' : 'external', name: enabled.name, scope: enabled.scope, file: enabled.file, legacy: enabled.legacy,
      reason: `Ya configurado en «${enabled.name}» (${enabled.scope}, ${enabled.file}); MDD no escribe ni toma propiedad${managed ? '' : ' de una configuración externa'}.`,
    };
  }
  const disabled = matches[0];
  if (disabled) {
    return {
      state: 'blocked', why: 'disabled', name: disabled.name, scope: disabled.scope, file: disabled.file,
      reason: `La entrada «${disabled.name}» (${disabled.scope}, ${disabled.file}) está desactivada; MDD no la activa ni agrega un alias.`,
    };
  }
  const taken = effective.get(canonical);
  if (taken) {
    const unknown = identify(id, taken.value) === 'unknown';
    return {
      state: 'blocked', why: 'conflict', name: taken.name, scope: taken.scope, file: taken.file,
      reason: `El nombre «${canonical}» ya lo usa otra entrada (${taken.scope}, ${taken.file})${unknown ? ' cuya identidad no se puede resolver sin variables o archivos externos' : ''}; MDD no la sobrescribe.`,
    };
  }
  if (layers.blockers.length) {
    return { state: 'blocked', why: 'unknown', reason: `No se puede modificar la configuración con seguridad: ${layers.blockers.join(' ')}` };
  }
  return { state: 'absent', target: layers.target, name: canonical, reason: `No hay entrada para ${id}; se puede agregar «mcp.servers.${canonical}».` };
}

// ---------------------------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------------------------

type WriteResult = { status: 'written'; digest: string } | { status: 'failed'; reason: string; residual?: string };

function currentDigest(path: string, root: string): string {
  scopedPath(root, basename(path));
  const stat = fs.lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return 'absent';
  if (stat.size > CONFIG_LIMIT) throw new Error('supera el límite de 4 MiB');
  const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try { return sha256(fs.readFileSync(fd)); } finally { fs.closeSync(fd); }
}

/**
 * Atomic replace of the global OpenCode file, guarded by the reviewed digest before and after the
 * temporary file is prepared. No backup copy is made (the file may hold credentials). After the
 * rename, a divergent re-read is reported, never rolled back over another writer.
 */
export async function writeGlobalConfig(
  target: { path: string; beforeDigest: string }, next: string, verify: (parsed: unknown) => boolean,
): Promise<WriteResult> {
  const name = basename(target.path);
  const root = dirname(resolve(target.path));
  if (!(CONFIG_FILE_NAMES as readonly string[]).includes(name)) return { status: 'failed', reason: 'El destino no es opencode.json ni opencode.jsonc; no se escribió nada.' };
  const bytes = Buffer.from(next, 'utf8');
  if (bytes.length > CONFIG_LIMIT) return { status: 'failed', reason: 'El resultado supera el límite de 4 MiB; no se escribió nada.' };
  const path = join(root, name);
  const changed = 'El archivo cambió desde la revisión (otro programa lo modificó); no se escribió nada.';
  let temporary: string | undefined;
  const cleanup = (): void => { if (temporary) try { fs.rmSync(temporary, { force: true }); } catch { /* leftover temp is hidden and harmless */ } };
  try {
    fs.mkdirSync(root, { recursive: true });
    scopedPath(root, name);
    if (currentDigest(path, root) !== target.beforeDigest) return { status: 'failed', reason: changed };
    const mode = target.beforeDigest === 'absent' ? 0o600 : fs.statSync(path).mode & 0o777;
    temporary = join(root, `.${name}.mdd-${randomBytes(6).toString('hex')}.tmp`);
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (process.platform !== 'win32') fs.chmodSync(temporary, mode);
    if (currentDigest(path, root) !== target.beforeDigest) { cleanup(); return { status: 'failed', reason: changed }; }
    const from = temporary;
    try { retryTransient(() => fs.renameSync(from, path)); }
    catch (error) { cleanup(); return { status: 'failed', reason: `No se pudo reemplazar el archivo (${(error as Error).message}); el original no cambió.` }; }
    temporary = undefined;
  } catch (error) {
    cleanup();
    return { status: 'failed', reason: `No se escribió nada: ${(error as Error).message}.` };
  }

  const expected = sha256(bytes);
  try {
    const actual = currentDigest(path, root);
    if (actual !== expected) return { status: 'failed', reason: 'Otro programa modificó el archivo tras la escritura; MDD no revierte para no pisar ese cambio.', residual: `${path} ya no coincide con lo escrito por MDD.` };
    const parsed = parseConfig(next);
    if (parsed.errors.length || !verify(parsed.value)) {
      return { status: 'failed', reason: 'La verificación posterior a la escritura falló; revisá el archivo.', residual: `${path} fue reemplazado y no pasó la verificación.` };
    }
  } catch (error) {
    return { status: 'failed', reason: `No se pudo verificar tras la escritura (${(error as Error).message}).`, residual: `${path} fue reemplazado.` };
  }
  return { status: 'written', digest: expected };
}
