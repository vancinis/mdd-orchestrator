#!/usr/bin/env node
// Release tool for the MDD repository (maintenance only; it is not packaged).
//   npm run release -- <version> [--yes] [--dry-run]   routine release (stable or preview)
//   npm run release -- --bootstrap [--yes]             one-off historical tag v0.2.0
// It creates a local release commit and annotated tag. It never pushes.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

export const BASELINE = Object.freeze({ version: '0.2.0', commit: '34a93f67ba405aa50850839c7cc3405374e61544' });
const PACKAGE_NAME = 'my-driven-development';
const RELEASE_FILES = ['package.json', 'package-lock.json', 'CHANGELOG.md'];
const GRAMMAR = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.(0|[1-9]\d*))?$/;
const CONVENTIONAL = /^(?<type>[a-z]+)(?:\((?<scope>[^()\r\n]+)\))?(?<bang>!)?: (?<desc>.+)$/;
const PREAMBLE = '# Changelog\n\nTodas las novedades relevantes de MDD. Las entradas se generan a partir de Conventional Commits con `npm run release`.\n\n';

class Refusal extends Error {
  constructor(message, code = 2) { super(message); this.code = code; }
}

// Same grammar and order as src/versions.ts (kept in sync by hand; the script cannot import dist/).
export function parseVersion(text) {
  const match = GRAMMAR.exec(String(text).replace(/^v/, ''));
  if (!match) return undefined;
  const [, major, minor, patch, preview] = match;
  return { major: Number(major), minor: Number(minor), patch: Number(patch), preview: preview === undefined ? null : Number(preview), text: String(text).replace(/^v/, '') };
}

// Exact order: numeric identifiers are compared as decimal strings (length, then lexically), never as Numbers,
// because the grammar allows values above Number.MAX_SAFE_INTEGER.
function identifiers(version) {
  const match = GRAMMAR.exec(String(version.text).replace(/^v/, ''));
  return match ? match.slice(1) : undefined;
}
const compareDecimal = (x, y) => (x.length !== y.length ? (x.length < y.length ? -1 : 1) : x === y ? 0 : x < y ? -1 : 1);

export function compareVersions(a, b) {
  const x = identifiers(a);
  const y = identifiers(b);
  if (!x || !y) throw new TypeError('compareVersions requires parsed release versions');
  for (let index = 0; index < 3; index += 1) {
    const order = compareDecimal(x[index], y[index]);
    if (order !== 0) return order;
  }
  if (x[3] === undefined && y[3] === undefined) return 0;
  if (x[3] === undefined) return 1;
  if (y[3] === undefined) return -1;
  return compareDecimal(x[3], y[3]);
}

// Exact: base identity compares the original decimal components, never the rounded Numbers.
const sameBase = (a, b) => {
  const x = identifiers(a);
  const y = identifiers(b);
  return x[0] === y[0] && x[1] === y[1] && x[2] === y[2];
};

export function createGit(cwd) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE']) delete env[name];
  return (args, options = {}) => {
    try {
      return execFileSync('git', args, { cwd: options.cwd ?? cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
      const detail = String(error.stderr ?? '').trim() || error.message;
      throw Object.assign(new Error(`git ${args[0]}: ${detail}`), { cause: error });
    }
  };
}

function defaultIo() {
  return {
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    out: line => console.log(line),
    err: line => console.error(line),
    read: async prompt => {
      const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: true, historySize: 0 });
      try { return await terminal.question(prompt); } catch { return undefined; } finally { terminal.close(); }
    },
  };
}

const USAGE = [
  'Uso:',
  '  npm run release -- <versión> [--yes] [--dry-run]   versión estable (X.Y.Z, solo desde main) o preview (X.Y.Z-preview.N)',
  '  npm run release -- --bootstrap [--yes]             etiqueta histórica v0.2.0 (una sola vez)',
].join('\n');

function parseArgs(argv) {
  const flags = new Set();
  const positional = [];
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      if (!['--yes', '--dry-run', '--bootstrap'].includes(arg)) throw new Refusal(`Opción desconocida: ${arg}\n${USAGE}`);
      flags.add(arg);
    } else positional.push(arg);
  }
  if (flags.has('--bootstrap')) {
    if (positional.length || flags.has('--dry-run')) throw new Refusal(`--bootstrap no acepta versión ni --dry-run.\n${USAGE}`);
    return { mode: 'bootstrap', yes: flags.has('--yes') };
  }
  if (positional.length !== 1) throw new Refusal(USAGE);
  return { mode: 'release', raw: positional[0], yes: flags.has('--yes'), dryRun: flags.has('--dry-run') };
}

const sameRealPath = (a, b) => {
  const real = path => { try { return fs.realpathSync.native(path); } catch { return resolve(path); } };
  const [x, y] = [real(a), real(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};

function verifyRepository(root, git) {
  let top;
  try { top = git(['rev-parse', '--show-toplevel']).trim(); } catch (error) { throw new Refusal(`No se pudo usar git: ${error.message}`, 1); }
  if (!sameRealPath(top, root)) throw new Refusal(`El repositorio git (${top}) no coincide con el del script (${root}).`, 1);
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(join(root, 'package.json'), 'utf8')); } catch (error) { throw new Refusal(`No se pudo leer package.json: ${error.message}`, 1); }
  if (pkg.name !== PACKAGE_NAME) throw new Refusal(`package.json no es de ${PACKAGE_NAME}.`, 1);
  return pkg;
}

function tagCommit(git, version) {
  try { return git(['rev-parse', '-q', '--verify', `refs/tags/v${version}^{commit}`]).trim(); } catch { return undefined; }
}

function tagExists(git, version) {
  return git(['tag', '--list', `v${version}`]).split(/\r?\n/).some(line => line.trim() === `v${version}`);
}

function eligibleTags(git, merged) {
  const out = git(merged ? ['tag', '--merged', 'HEAD', '--list', 'v*'] : ['tag', '--list', 'v*']);
  return out.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    .map(name => name.startsWith('v') ? parseVersion(name) : undefined)
    .filter(version => version && compareVersions(version, parseVersion(BASELINE.version)) >= 0);
}

function currentBranch(git) {
  try { return git(['symbolic-ref', '--short', '-q', 'HEAD']).trim() || undefined; } catch { return undefined; }
}

function parseCommits(git, base) {
  const raw = git(['log', '--no-merges', '--reverse', '--format=%H%x00%s%x00%b%x1e', `${base}..HEAD`]);
  const commits = [];
  for (const chunk of raw.split('\x1e')) {
    const record = chunk.replace(/^\r?\n/, '');
    if (!record.trim()) continue;
    const [hash, subject = '', body = ''] = record.split('\x00');
    if (/^chore\(release\): v/.test(subject)) continue;
    const footer = /^BREAKING[ -]CHANGE: (.+)$/m.exec(body);
    const match = CONVENTIONAL.exec(subject);
    const breaking = Boolean(match?.groups.bang || footer);
    commits.push({
      sha: hash.slice(0, 7), subject, type: match?.groups.type, scope: match?.groups.scope,
      description: breaking && footer ? footer[1].trim() : (match ? match.groups.desc : subject), breaking, conventional: Boolean(match),
    });
  }
  return commits;
}

function renderEntry({ version, date, channel, baseTag, headShort, commits }) {
  const groups = [
    ['Cambios incompatibles', commits.filter(c => c.breaking)],
    ['Funcionalidades', commits.filter(c => !c.breaking && c.type === 'feat')],
    ['Correcciones', commits.filter(c => !c.breaking && c.type === 'fix')],
    ['Otros cambios', commits.filter(c => !c.breaking && (!c.conventional || ['perf', 'refactor', 'docs', 'revert'].includes(c.type)))],
  ];
  const lines = [
    `## [${version}] - ${date}`, '',
    `${channel === 'stable' ? 'Estable' : 'Preview'} · cambios desde \`${baseTag}\` (intervalo \`${baseTag}..${headShort}\`, ${commits.length} commits).`, '',
  ];
  let any = false;
  for (const [title, items] of groups) {
    if (!items.length) continue;
    any = true;
    lines.push(`### ${title}`);
    for (const c of items) lines.push(`- ${c.scope && c.conventional ? `**${c.scope}:** ` : ''}${c.description} (\`${c.sha}\`)`);
    lines.push('');
  }
  if (!any) lines.push('Sin cambios relevantes en este intervalo.', '');
  return lines.join('\n');
}

function insertEntry(existing, entry) {
  if (existing === undefined) return `${PREAMBLE}${entry}`;
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const text = eol === '\r\n' ? entry.replace(/\n/g, '\r\n') : entry;
  const heading = /^## \[/m.exec(existing);
  if (heading) return existing.slice(0, heading.index) + text + eol + existing.slice(heading.index);
  return existing + (existing.endsWith('\n') || existing === '' ? '' : eol) + (existing === '' ? '' : eol) + text;
}

const headingCount = (text, version) => text.split(/\r?\n/).filter(line => line.startsWith(`## [${version}]`)).length;

function readLockInfo(root, version) {
  const unexpected = 'package.json/package-lock.json tienen un formato inesperado; no se reformatean.';
  let pkgRaw, lockRaw, pkg, lock;
  try {
    pkgRaw = fs.readFileSync(join(root, 'package.json'), 'utf8');
    lockRaw = fs.readFileSync(join(root, 'package-lock.json'), 'utf8');
    pkg = JSON.parse(pkgRaw); lock = JSON.parse(lockRaw);
  } catch (error) { throw new Refusal(`Formato inesperado: ${error.message}`); }
  if (JSON.stringify(pkg, null, 2) + '\n' !== pkgRaw || JSON.stringify(lock, null, 2) + '\n' !== lockRaw) throw new Refusal(`Formato inesperado: ${unexpected}`);
  if (lock.version !== pkg.version || lock.packages?.[''] === undefined || lock.packages[''].version !== pkg.version) {
    throw new Refusal(`Formato inesperado: package-lock.json no coincide con la versión ${pkg.version} de package.json.`);
  }
  const next = structuredClone(pkg); next.version = version;
  const nextLock = structuredClone(lock); nextLock.version = version; nextLock.packages[''].version = version;
  return { current: pkg.version, packageText: JSON.stringify(next, null, 2) + '\n', lockText: JSON.stringify(nextLock, null, 2) + '\n' };
}

async function confirm(io, yes, word) {
  if (yes) return true;
  if (!io.isTTY) throw new Refusal('Se necesita una terminal interactiva o --yes para confirmar. No se hizo ningún cambio.');
  const answer = await io.read(`Escribí ${word} para continuar; Enter cancela.\n> `);
  return typeof answer === 'string' && answer.trim() === word;
}

async function bootstrap({ root, io, git, baseline, yes }) {
  verifyRepository(root, git);
  try { git(['cat-file', '-e', `${baseline.commit}^{commit}`]); } catch { throw new Refusal(`No existe el commit base ${baseline.commit} en este repositorio.`, 1); }
  let baseVersion;
  try { baseVersion = JSON.parse(git(['show', `${baseline.commit}:package.json`])).version; } catch (error) { throw new Refusal(`No se pudo leer package.json de la base: ${error.message}`, 1); }
  if (baseVersion !== baseline.version) throw new Refusal(`El commit base declara la versión ${baseVersion}, se esperaba ${baseline.version}.`, 1);
  const short = baseline.commit.slice(0, 7);
  const tag = `v${baseline.version}`;
  const existing = tagCommit(git, baseline.version);
  if (existing === baseline.commit) { io.out(`${tag} ya existe en ${short}; sin cambios.`); return 0; }
  if (existing || tagExists(git, baseline.version)) throw new Refusal(`${tag} apunta a ${existing?.slice(0, 7) ?? 'otro objeto'}; nunca se mueve.`, 1);
  io.out([`Bootstrap histórico: ${tag} → ${short} (${baseline.commit})`, 'No crea commits, no modifica archivos y no hace push.'].join('\n'));
  if (!await confirm(io, yes, 'tag')) { io.out('Cancelado. No se hizo ningún cambio.'); return 0; }
  git(['tag', '-a', tag, '-m', `MDD ${baseline.version} (línea base)`, baseline.commit]);
  if (tagCommit(git, baseline.version) !== baseline.commit) throw new Refusal(`La etiqueta ${tag} no resuelve a ${short}; revisala.`, 1);
  io.out(`Listo: ${tag} creada en ${short}.\nPara publicar: git push origin refs/tags/${tag}`);
  return 0;
}

async function routine({ root, io, git, baseline, writeFile, raw, yes, dryRun }) {
  const target = parseVersion(raw);
  if (!target) throw new Refusal(`Versión no soportada: ${raw}. Usá X.Y.Z o X.Y.Z-preview.N.`);
  const base = parseVersion(baseline.version);
  if (compareVersions(target, base) < 0) throw new Refusal(`${target.text}: 0.1 no es instalable con este sistema; las versiones empiezan en ${baseline.version}.`);
  if (compareVersions(target, base) === 0) throw new Refusal(`${baseline.version} está reservada para el bootstrap histórico: npm run release -- --bootstrap.`);
  const version = target.text;
  const channel = target.preview === null ? 'stable' : 'preview';
  const tag = `v${version}`;
  verifyRepository(root, git);

  // Resume detection: release commit exists but its tag does not.
  let resume = false;
  if (!tagExists(git, version)) {
    try {
      const subject = git(['log', '-1', '--format=%s', 'HEAD']).trim();
      if (subject === `chore(release): ${tag}`
        && JSON.parse(git(['show', 'HEAD:package.json'])).version === version
        && headingCount(git(['show', 'HEAD:CHANGELOG.md']), version) === 1) resume = true;
    } catch { /* not a resumable state */ }
  }
  if (tagExists(git, version)) throw new Refusal(`La etiqueta ${tag} ya existe; nunca se sobrescribe.`);
  const baselineTag = tagCommit(git, baseline.version);
  if (baselineTag !== baseline.commit) throw new Refusal(`Falta ${`v${baseline.version}`} en ${baseline.commit.slice(0, 7)}. Ejecutá primero npm run release -- --bootstrap.`);

  const branch = currentBranch(git);
  if (!branch) throw new Refusal('HEAD está desacoplado (detached); cambiá a una rama antes de hacer un release.');
  if (channel === 'stable' && branch !== 'main') throw new Refusal(`Un release estable solo se crea desde main (rama actual: ${branch}). Usá una versión preview o cambiá a main.`);
  const dirty = git(['status', '--porcelain=v1', '--untracked-files=all']).split(/\r?\n/).filter(Boolean);
  if (dirty.length) throw new Refusal(`El árbol de trabajo no está limpio; confirmá o descartá estos cambios primero:\n${dirty.map(line => `  ${line}`).join('\n')}`);

  const all = eligibleTags(git, false);
  const stables = all.filter(v => v.preview === null);
  const highestStable = stables.sort(compareVersions).at(-1);
  if (channel === 'stable') {
    if (highestStable && compareVersions(target, highestStable) <= 0) throw new Refusal(`La versión estable debe ser mayor que la última estable (v${highestStable.text}).`);
  } else {
    if (stables.some(v => sameBase(v, target))) throw new Refusal(`Ya existe la estable ${identifiers(target).slice(0, 3).join('.')}; no se publican previews de esa base.`);
    const previews = all.filter(v => v.preview !== null && sameBase(v, target)).sort(compareVersions);
    if (previews.length && compareVersions(target, previews.at(-1)) <= 0) throw new Refusal(`El preview debe ser mayor que el último de su base (v${previews.at(-1).text}).`);
  }

  const headShort = git(['rev-parse', '--short=7', 'HEAD']).trim();
  const push = `git push origin ${branch} refs/tags/${tag}`;
  if (resume) {
    io.out([`Reanudación: el commit de release de ${tag} ya existe en ${headShort}; solo falta la etiqueta.`, `Se creará la etiqueta ${tag} (anotada) en HEAD. No se hace push.`].join('\n'));
    if (dryRun) return 0;
    if (!await confirm(io, yes, 'release')) { io.out('Cancelado. No se hizo ningún cambio.'); return 0; }
    return createTag({ io, git, version, tag, headShort, push });
  }

  const info = readLockInfo(root, version);
  if (compareVersions(parseVersion(info.current) ?? target, target) >= 0) throw new Refusal(`package.json ya está en ${info.current}, que no es menor que ${version}.`);
  const changelogPath = join(root, 'CHANGELOG.md');
  const originalChangelog = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : undefined;
  if (originalChangelog !== undefined && headingCount(originalChangelog, version) > 0) throw new Refusal(`CHANGELOG.md ya tiene una sección ${version} sin commit de release; revisala.`);

  const candidates = eligibleTags(git, true).filter(v => compareVersions(v, target) < 0 && (channel === 'preview' || v.preview === null));
  const baseVersion = candidates.sort(compareVersions).at(-1);
  if (!baseVersion) throw new Refusal('No hay una etiqueta de versión anterior alcanzable desde HEAD para calcular el intervalo.');
  const baseTag = `v${baseVersion.text}`;
  const commits = parseCommits(git, baseTag);
  const date = git(['log', '-1', '--format=%cs', 'HEAD']).trim();
  const entry = renderEntry({ version, date, channel, baseTag, headShort, commits });

  io.out([
    `Release ${version} (${channel === 'stable' ? 'estable' : 'preview'}) en la rama ${branch}, HEAD ${headShort}`,
    `Intervalo ${baseTag}..${headShort} (${commits.length} commits)`,
    `Archivos que cambian: ${RELEASE_FILES.join(', ')}`,
    `Commit: chore(release): ${tag}`, `Etiqueta: ${tag} (anotada)`,
    `Después se imprimirá (no se ejecuta): ${push}`,
  ].join('\n'));
  if (dryRun) { io.out(`\n${entry}\nDry run: no se hizo ningún cambio.`); return 0; }
  if (!await confirm(io, yes, 'release')) { io.out('Cancelado. No se hizo ningún cambio.'); return 0; }

  const originals = new Map([
    ['package.json', fs.readFileSync(join(root, 'package.json'))],
    ['package-lock.json', fs.readFileSync(join(root, 'package-lock.json'))],
  ]);
  try {
    writeFile(join(root, 'package.json'), info.packageText);
    writeFile(join(root, 'package-lock.json'), info.lockText);
    writeFile(changelogPath, insertEntry(originalChangelog, entry));
    git(['add', '--', ...RELEASE_FILES]);
    git(['commit', '-m', `chore(release): ${tag}`, '--', ...RELEASE_FILES]);
  } catch (error) {
    const failed = [];
    for (const [name, bytes] of originals) { try { fs.writeFileSync(join(root, name), bytes); } catch { failed.push(name); } }
    try { if (originalChangelog === undefined) fs.rmSync(changelogPath, { force: true }); else fs.writeFileSync(changelogPath, originalChangelog); } catch { failed.push('CHANGELOG.md'); }
    try { git(['reset', '-q', '--', ...RELEASE_FILES]); } catch { failed.push('(índice)'); }
    throw new Refusal([
      `Falló la preparación del release: ${error.message}`,
      failed.length ? `No se pudo restaurar todo (${failed.join(', ')}). Revisá con: git checkout -- ${RELEASE_FILES.join(' ')}` : 'No se creó commit ni etiqueta; el árbol quedó como estaba.',
    ].join('\n'), 1);
  }
  const sha = git(['rev-parse', '--short=7', 'HEAD']).trim();
  const partial = reason => new Refusal([
    `${reason}`, `Commit de release ${sha} creado; falta la etiqueta.`,
    `Repetí \`npm run release -- ${version}\` para crear solo la etiqueta, o descartalo con \`git reset --keep HEAD~1\`.`,
  ].join('\n'), 1);
  try {
    if (JSON.parse(git(['show', 'HEAD:package.json'])).version !== version || headingCount(git(['show', 'HEAD:CHANGELOG.md']), version) !== 1) {
      throw new Error('el commit de release no contiene la versión o la sección esperadas');
    }
  } catch (error) { throw partial(`Falló la verificación del commit: ${error.message}`); }
  return createTag({ io, git, version, tag, headShort: sha, push, onFailure: partial });
}

function createTag({ io, git, version, tag, headShort, push, onFailure }) {
  const fail = reason => { throw onFailure ? onFailure(reason) : new Refusal(`${reason}\nNo se creó la etiqueta; repetí el comando.`, 1); };
  try {
    git(['tag', '-a', tag, '-m', `MDD ${version}`, 'HEAD']);
    if (tagCommit(git, version) !== git(['rev-parse', 'HEAD']).trim()) fail(`La etiqueta ${tag} no apunta a HEAD.`);
  } catch (error) {
    if (error instanceof Refusal) throw error;
    fail(`Falló la creación de la etiqueta: ${error.message}`);
  }
  io.out(`Listo: ${tag} creada en ${headShort}.\nPara publicar: ${push}`);
  return 0;
}

export async function release({ root, argv, io = defaultIo(), git = createGit(root), writeFile = fs.writeFileSync, baseline = BASELINE } = {}) {
  try {
    const args = parseArgs(argv);
    const context = { root: resolve(root), io, git, baseline, writeFile, yes: args.yes };
    if (args.mode === 'bootstrap') return await bootstrap(context);
    return await routine({ ...context, raw: args.raw, dryRun: args.dryRun });
  } catch (error) {
    if (error instanceof Refusal) { io.err(error.message); return error.code; }
    io.err(`Error inesperado: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && resolveEntry(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await release({ root: fileURLToPath(new URL('../', import.meta.url)), argv: process.argv.slice(2) });
}

function resolveEntry(path) { try { return fs.realpathSync(path); } catch { return path; } }
