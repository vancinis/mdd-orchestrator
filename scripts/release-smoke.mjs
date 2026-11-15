#!/usr/bin/env node
// Post-publication smoke for the MDD repository (maintenance only; it is not packaged).
//   node scripts/release-smoke.mjs --origin <clone> --tag <vX.Y.Z[-preview.N]> --owned-root <tmp>
// It drives the real version manager (dist/) against a published tag: discover -> resolveExact ->
// resolveAlias -> prepareRelease (real npm ci, build and pack). It uses an in-memory state and an isolated
// owned root, HOME and npm cache inside `--owned-root`; it never activates, switches, writes launchers or
// touches the user's installed MDD. Run it once per tag (stable and preview) with a fresh root each time.
//
// Exit codes: 0 success, 1 verification or preparation failure, 2 usage or unsafe argument.
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const USAGE = 'Uso: node scripts/release-smoke.mjs --origin <clon> --tag <vX.Y.Z[-preview.N]> --owned-root <directorio-temporal>';
const TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-preview\.(?:0|[1-9]\d*))?$/;
const PACKAGE_NAME = 'my-driven-development';
const ISOLATED = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'APPDATA', 'LOCALAPPDATA'];
const GIT_SELECTORS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE'];

/** A refused argument or unsafe root (exit 2) or a failed verification (exit 1). */
export class SmokeError extends Error {
  constructor(message, code = 1) { super(message); this.name = 'SmokeError'; this.code = code; }
}
const usage = message => new SmokeError(`${message}\n${USAGE}`, 2);

/** Strict parser: exactly --origin, --tag and --owned-root, each once, each with a non-empty value. */
export function parseArgs(argv) {
  const names = { '--origin': 'origin', '--tag': 'tag', '--owned-root': 'ownedRoot' };
  const values = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = String(argv[index]);
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const key = names[flag];
    if (!key) throw usage(`Argumento no reconocido: ${arg}`);
    if (key in values) throw usage(`Argumento repetido: ${flag}`);
    let value;
    if (eq !== -1) value = arg.slice(eq + 1);
    else { value = argv[++index]; if (value === undefined || String(value).startsWith('--')) throw usage(`Falta el valor de ${flag}`); }
    if (!String(value).trim()) throw usage(`Falta el valor de ${flag}`);
    values[key] = String(value);
  }
  for (const [flag, key] of Object.entries(names)) if (!(key in values)) throw usage(`Falta el argumento obligatorio ${flag}`);
  return values;
}

/** The tag must be exactly `v` plus the release grammar (no leading zeros, no build metadata, no other prerelease). */
export function validateTag(tag) {
  if (!TAG.test(tag)) throw usage(`La etiqueta «${tag}» no es válida (vX.Y.Z o vX.Y.Z-preview.N).`);
  return tag;
}

function realOrUndefined(path) {
  try { return fs.realpathSync.native(path); } catch { return undefined; }
}

/** Approved roots: the OS temp directory and RUNNER_TEMP (when set), as real paths. */
function approvedRoots(env) {
  const list = [];
  for (const candidate of [os.tmpdir(), env.RUNNER_TEMP]) {
    if (!candidate || !isAbsolute(candidate)) continue;
    const real = realOrUndefined(candidate);
    if (real) list.push({ lexical: resolve(candidate), real });
  }
  return list;
}

const inside = (base, path) => {
  const rel = relative(base, path);
  return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel : undefined;
};

/**
 * Validates the owned root before anything is written: absolute, strictly inside an approved temp root,
 * no symlink or non-directory on the way, and either absent or an empty directory (a reused or foreign root
 * is refused). Returns the resolved path. Writes nothing.
 */
export function validateOwnedRoot(value, env = process.env) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f]/.test(value)) throw usage('La raíz propia no es válida.');
  if (!isAbsolute(value)) throw usage('La raíz propia debe ser una ruta absoluta.');
  const target = resolve(value);
  for (const { lexical, real } of approvedRoots(env)) {
    const rel = inside(lexical, target) ?? inside(real, target);
    if (!rel) continue;
    let current = real;
    for (const part of rel.split(sep)) {
      current = join(current, part);
      const stat = fs.lstatSync(current, { throwIfNoEntry: false });
      if (!stat) break;
      if (stat.isSymbolicLink()) throw usage(`La raíz propia atraviesa un enlace simbólico: ${current}`);
      if (!stat.isDirectory()) throw usage(`La raíz propia atraviesa algo que no es un directorio: ${current}`);
    }
    // `current` is the target itself when it exists, or the first missing component (then nothing to list).
    if (fs.existsSync(current) && fs.readdirSync(current).length > 0) {
      throw usage(`La raíz propia ${target} ya tiene contenido; usá un directorio nuevo y vacío en cada ejecución.`);
    }
    return target;
  }
  throw usage(`La raíz propia ${target} está fuera del directorio temporal aprobado (os.tmpdir() o RUNNER_TEMP).`);
}

/** Reads `package/package.json` out of an npm-pack tarball without external tools. */
export function packageJsonOf(tarball) {
  const tar = gunzipSync(fs.readFileSync(tarball));
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8);
    offset += 512;
    if (name === 'package/package.json') return JSON.parse(tar.subarray(offset, offset + size).toString('utf8'));
    offset += Math.ceil(size / 512) * 512;
  }
  return undefined;
}

async function loadManager() {
  const base = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  try {
    const load = name => import(pathToFileURL(join(base, name)).href);
    const [store, source, versions] = await Promise.all([load('version-store.js'), load('version-source.js'), load('versions.js')]);
    return { ...store, ...source, ...versions };
  } catch (error) {
    throw new SmokeError(`No se pudo cargar el gestor compilado en ${base}; ejecutá «npm run build» primero (${error instanceof Error ? error.message : String(error)}).`);
  }
}

/** Environment for the run: HOME, config, npm and git all live under the owned root. Returns a restore function. */
function isolate(root) {
  const home = join(root, 'home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(join(home, 'empty.npmrc'), '');
  fs.writeFileSync(join(home, 'empty-global.npmrc'), '');
  fs.writeFileSync(join(home, 'empty.gitconfig'), '');
  const saved = { ...process.env };
  for (const name of ISOLATED) process.env[name] = home;
  process.env.npm_config_cache = join(home, 'npm-cache');
  process.env.npm_config_userconfig = join(home, 'empty.npmrc');
  process.env.npm_config_globalconfig = join(home, 'empty-global.npmrc');
  process.env.npm_config_update_notifier = 'false';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = join(home, 'empty.gitconfig');
  process.env.GIT_TERMINAL_PROMPT = '0';
  for (const name of GIT_SELECTORS) delete process.env[name];
  return () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  };
}

const fail = message => new SmokeError(message, 1);

/**
 * Verifies one published tag through the real manager. `log` receives Spanish progress lines.
 * Returns { tag, version, channel, commit, tarball, sha256, size }.
 */
export async function runSmoke({ origin, tag, ownedRoot }, log = () => {}) {
  validateTag(tag);
  const root = validateOwnedRoot(ownedRoot);
  const manager = await loadManager();
  try { manager.validateOrigin(origin); }
  catch (error) { throw usage(error instanceof Error ? error.message : String(error)); }
  const parsed = manager.parseReleaseTag(tag);
  if (!parsed || `v${parsed.text}` !== tag) throw usage(`La etiqueta «${tag}» no es una versión de MDD válida.`);
  const channel = manager.channelOf(parsed);

  const restore = isolate(root);
  let lock;
  try {
    const paths = manager.sourcePaths(root);
    lock = manager.acquireLock(paths, 'release-smoke');
    const state = manager.emptyState();
    state.origin = origin;
    log(`Verificando ${tag} (${channel}) contra ${origin}`);

    const discovery = manager.discover(paths, state);
    if (discovery.stale) throw fail(`No se pudo consultar el origen: ${discovery.error ?? 'sin detalle'}`);
    const exact = manager.resolveExact(discovery, state, tag);
    if (!exact.ok) throw fail(`El gestor rechaza ${tag}: ${exact.message}`);
    if (exact.tag.tag !== tag || exact.tag.status !== 'eligible' || !exact.tag.commit) throw fail(`La etiqueta ${tag} no quedó elegible.`);
    log(`  descubrimiento: elegible (${exact.tag.commit.slice(0, 7)})`);

    const alias = manager.resolveAlias(discovery, channel);
    if (!alias.ok) throw fail(`El alias ${channel} no resuelve: ${alias.message}`);
    // One reconcile can publish several releases before the smoke runs, so the alias may be newer than the
    // requested tag. It must still be an eligible same-channel version at least as new; an equal one is the same commit.
    const aliasVersion = manager.parseReleaseTag(String(alias.tag.version));
    const order = aliasVersion ? manager.compareVersions(aliasVersion, parsed) : -1;
    if (!aliasVersion || manager.channelOf(aliasVersion) !== channel || order < 0 || (order === 0 && alias.tag.commit !== exact.tag.commit)) {
      throw fail(`El alias ${channel} apunta a ${alias.tag.version ?? alias.tag.tag}, que no es ${parsed.text} ni una versión posterior del mismo canal.`);
    }
    log(`  alias ${channel}: ${alias.tag.version}`);

    const prepared = manager.prepareRelease(lock, exact.tag);
    if (prepared.cached) throw fail('La preparación reutilizó una caché en lugar de compilar la etiqueta.');
    if (prepared.identity.kind !== 'release' || prepared.identity.version !== parsed.text || prepared.identity.commit !== exact.tag.commit) {
      throw fail('La identidad preparada no coincide con la etiqueta.');
    }
    const bytes = fs.readFileSync(prepared.tarball);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (!bytes.length || bytes.length !== prepared.size || sha256 !== prepared.sha256) throw fail('El paquete empaquetado no coincide con su suma de verificación.');
    const pkg = packageJsonOf(prepared.tarball);
    if (!pkg || pkg.name !== PACKAGE_NAME || pkg.version !== parsed.text) {
      throw fail(`El paquete empaquetado declara ${String(pkg?.name)}@${String(pkg?.version)}, no ${PACKAGE_NAME}@${parsed.text}.`);
    }
    log(`  paquete: ${PACKAGE_NAME}@${parsed.text} (${bytes.length} bytes, sha256 ${sha256.slice(0, 12)})`);
    return { tag, version: parsed.text, channel, commit: exact.tag.commit, tarball: prepared.tarball, sha256, size: bytes.length };
  } catch (error) {
    if (error instanceof SmokeError) throw error;
    throw fail(error instanceof Error ? error.message : String(error));
  } finally {
    try { lock?.release(); } catch { /* the lock is released with the temporary root */ }
    restore();
  }
}

/** CLI entry: returns the exit code and never throws. */
export async function main(argv = process.argv.slice(2), io = { out: line => console.log(line), err: line => console.error(line) }) {
  try {
    const args = parseArgs(argv);
    const result = await runSmoke(args, io.out);
    io.out(`Humo correcto: ${result.tag} (${result.channel}) se descubre, se resuelve y se empaqueta.`);
    return 0;
  } catch (error) {
    io.err(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return error instanceof SmokeError ? error.code : 1;
  }
}

const entry = process.argv[1] ? realOrUndefined(process.argv[1]) : undefined;
if (entry && entry === realOrUndefined(fileURLToPath(import.meta.url))) process.exitCode = await main();
