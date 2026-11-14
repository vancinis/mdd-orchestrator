// Automatic release engine (maintenance only; it is not packaged).
// Foundation used by the release workflow: bump level, version allocation, strict tag provenance, a tag-only release
// commit built with Git plumbing, and an immutable annotated-tag publication verified against the remote.
//
// Safety model: the engine never checks out, merges, rebases or resets anything and never writes a branch. The release
// commit is built in a temporary index with `hash-object --no-filters`, so no candidate script, clean/smudge filter,
// textconv, external diff or hook runs (hooks are disabled for every command through `core.hooksPath`).
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RELEASE_FILES, Refusal, changelogBaseline, compareVersions, headingCount, insertEntry, parseCommits, parseVersion,
  releaseMetadata, releaseSource, renderEntry,
} from './release.mjs';

const FULL_SHA = /^[0-9a-f]{40}$/;
const IDENTIFIERS = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.(0|[1-9]\d*))?$/;
const POSITIVE = /^[1-9]\d*$/;
const TAG_KEYS = Object.freeze(['Channel', 'Source-Commit', 'Pull-Request', 'Main-Commit', 'Previous-Stable', 'Workflow-Run']);
const BOT = Object.freeze({ name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' });
export const DEFAULT_ATTEMPTS = 3;

export class PublishError extends Error {
  constructor(message, reason) { super(message); this.reason = reason; }
}

// ---------------------------------------------------------------------------------------------------------------------
// Git runner: same call shape as createGit(cwd) in release.mjs, plus `{ input, env }` and hardened configuration.
// ---------------------------------------------------------------------------------------------------------------------

/** `git(args, { cwd, input, env })` -> stdout. Hooks are disabled; inherited repository-selecting variables are dropped. */
export function createAutoGit(cwd) {
  const base = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_EXTERNAL_DIFF']) delete base[name];
  // A directory that does not exist: git finds no hooks there.
  const noHooks = join(tmpdir(), `mdd-no-hooks-${process.pid}-${Date.now()}`);
  const config = ['-c', `core.hooksPath=${noHooks}`, '-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never'];
  return (args, options = {}) => {
    try {
      return execFileSync('git', [...config, ...args], {
        cwd: options.cwd ?? cwd, env: { ...base, ...options.env }, encoding: 'utf8', input: options.input,
        stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
      });
    } catch (error) {
      const detail = String(error.stderr ?? '').trim() || error.message;
      throw Object.assign(new Error(`git ${args[0]}: ${detail}`), { cause: error, stderr: String(error.stderr ?? '') });
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Bump level and exact version arithmetic
// ---------------------------------------------------------------------------------------------------------------------

/** 'major' if any commit is breaking, else 'minor' if any is `feat`, else 'patch' (also for an empty interval). */
export function bumpLevel(commits) {
  if (commits.some(commit => commit.breaking)) return 'major';
  if (commits.some(commit => commit.type === 'feat')) return 'minor';
  return 'patch';
}

const identifiersOf = text => IDENTIFIERS.exec(text)?.slice(1);

/** Exact (BigInt) bump of a stable `X.Y.Z` text. Preview or invalid inputs throw. */
export function bumpVersion(stable, level) {
  const ids = identifiersOf(stable);
  if (!ids || ids[3] !== undefined) throw new Refusal(`Versión estable inválida: ${stable}.`);
  const [major, minor, patch] = ids.slice(0, 3).map(BigInt);
  if (level === 'major') return `${major + 1n}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1n}.0`;
  if (level === 'patch') return `${major}.${minor}.${patch + 1n}`;
  throw new Refusal(`Nivel de versión desconocido: ${level}.`);
}

/** Version texts (without `v`) of the grammar-valid `v*` names in `tagNames`; everything else is ignored. */
export function releaseVersions(tagNames) {
  return tagNames.filter(name => name.startsWith('v') && IDENTIFIERS.test(name.slice(1))).map(name => name.slice(1));
}

const sortVersions = versions => [...versions].sort((a, b) => compareVersions(parseVersion(a), parseVersion(b)));

/** Highest stable version text among `tagNames`, or undefined. */
export function highestStable(tagNames) {
  const stables = releaseVersions(tagNames).filter(text => identifiersOf(text)[3] === undefined);
  return stables.length ? sortVersions(stables).at(-1) : undefined;
}

/** Next stable: bump of the highest stable. Always greater than it. */
export function nextStable(tagNames, level) {
  const stable = highestStable(tagNames);
  if (!stable) throw new Refusal('No hay ninguna versión estable previa para calcular la siguiente.');
  return bumpVersion(stable, level);
}

/**
 * Next preview: base = max(bump(S, level), base(P)) when base(P) > S (P = global highest preview), else bump(S, level);
 * N = one more than the highest N already used with that base. Never a base that already has a stable.
 */
export function nextPreview(tagNames, level) {
  const stable = highestStable(tagNames);
  if (!stable) throw new Refusal('No hay ninguna versión estable previa para calcular la siguiente.');
  const predicted = bumpVersion(stable, level);
  const previews = releaseVersions(tagNames).filter(text => identifiersOf(text)[3] !== undefined);
  let base = predicted;
  if (previews.length) {
    const highest = sortVersions(previews).at(-1);
    const highestBase = highest.split('-')[0];
    if (compareVersions(parseVersion(highestBase), parseVersion(stable)) > 0 && compareVersions(parseVersion(highestBase), parseVersion(predicted)) > 0) base = highestBase;
  }
  let used = -1n;
  for (const text of previews) {
    const ids = identifiersOf(text);
    if (`${ids[0]}.${ids[1]}.${ids[2]}` === base && BigInt(ids[3]) > used) used = BigInt(ids[3]);
  }
  return `${base}-preview.${used + 1n < 1n ? 1n : used + 1n}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Tag provenance (strict render/parse)
// ---------------------------------------------------------------------------------------------------------------------

const channelOf = version => (identifiersOf(version)[3] === undefined ? 'stable' : 'preview');

const VALIDATORS = {
  Channel: value => value === 'stable' || value === 'preview',
  'Source-Commit': value => FULL_SHA.test(value),
  'Pull-Request': value => POSITIVE.test(value),
  'Main-Commit': value => FULL_SHA.test(value),
  'Previous-Stable': value => /^v/.test(value) && IDENTIFIERS.test(value.slice(1)) && channelOf(value.slice(1)) === 'stable',
  'Workflow-Run': value => POSITIVE.test(value),
};

/**
 * Tag message for a release: `MDD <version>`, a blank line and trailers
 * (Channel, Source-Commit, Pull-Request, Main-Commit, Previous-Stable, Workflow-Run; the last four are optional).
 */
export function renderTagMessage({ version, channel, source, pullRequest, mainCommit, previousStable, workflowRun }) {
  const lines = [`MDD ${version}`, '', `Channel: ${channel}`, `Source-Commit: ${source}`];
  if (pullRequest !== undefined) lines.push(`Pull-Request: ${pullRequest}`);
  if (mainCommit !== undefined) lines.push(`Main-Commit: ${mainCommit}`);
  if (previousStable !== undefined) lines.push(`Previous-Stable: ${previousStable}`);
  if (workflowRun !== undefined) lines.push(`Workflow-Run: ${workflowRun}`);
  const message = `${lines.join('\n')}\n`;
  parseTagMessage(message, version); // refuse to emit anything the strict parser would reject
  return message;
}

/**
 * Strict parser: exact header, blank line, then only known `Key: value` trailers, each at most once, valid values, and a
 * channel consistent with the version. Throws Error on any deviation. Returns the parsed fields.
 */
export function parseTagMessage(text, expectedVersion) {
  const lines = String(text).replace(/(\r?\n)+$/, '').split(/\r?\n/);
  const header = /^MDD (\S+)$/.exec(lines[0] ?? '');
  if (!header || !IDENTIFIERS.test(header[1])) throw new Error('El mensaje de la etiqueta no empieza con "MDD <versión>".');
  const version = header[1];
  if (expectedVersion !== undefined && version !== expectedVersion) throw new Error(`El mensaje de la etiqueta declara ${version} y se esperaba ${expectedVersion}.`);
  if (lines[1] !== '') throw new Error('El mensaje de la etiqueta debe separar la cabecera de los trailers con una línea vacía.');
  const fields = {};
  for (const line of lines.slice(2)) {
    const match = /^([A-Za-z][A-Za-z-]*): (\S.*)$/.exec(line);
    if (!match || !TAG_KEYS.includes(match[1])) throw new Error(`Línea de procedencia no reconocida: ${line || '(vacía)'}.`);
    const [, key, value] = match;
    if (key in fields) throw new Error(`Trailer duplicado: ${key}.`);
    if (value !== value.trim() || !VALIDATORS[key](value)) throw new Error(`Valor inválido para ${key}: ${value}.`);
    fields[key] = value;
  }
  if (!fields.Channel || !fields['Source-Commit']) throw new Error('Faltan los trailers Channel o Source-Commit.');
  if (fields.Channel !== channelOf(version)) throw new Error(`El canal ${fields.Channel} no corresponde a la versión ${version}.`);
  return {
    version, channel: fields.Channel, source: fields['Source-Commit'], pullRequest: fields['Pull-Request'], mainCommit: fields['Main-Commit'],
    previousStable: fields['Previous-Stable'], workflowRun: fields['Workflow-Run'],
  };
}

/** Local `v*` tag names (any grammar). */
export const listTagNames = git => git(['tag', '--list', 'v*']).split(/\r?\n/).map(line => line.trim()).filter(Boolean);

/**
 * Validated provenance of a published tag name: { tag, version, channel, source, annotated, meta }.
 * `source` comes from releaseSource (structure checked); `meta` is the strictly parsed message when it has trailers.
 * Throws Error on malformed provenance (fail closed). Legacy and lightweight tags report their own commit as source.
 */
export function readTagProvenance(git, tag) {
  const version = tag.slice(1);
  if (!tag.startsWith('v') || !IDENTIFIERS.test(version)) throw new Error(`La etiqueta ${tag} no es una versión de release.`);
  const source = releaseSource(git, tag);
  const annotated = git(['cat-file', '-t', `refs/tags/${tag}`]).trim() === 'tag';
  let meta;
  if (annotated) {
    const message = git(['for-each-ref', '--format=%(contents)', `refs/tags/${tag}`]);
    if (/^Source-Commit:/m.test(message)) {
      try { meta = parseTagMessage(message, version); } catch (error) { throw new Error(`La etiqueta ${tag} tiene procedencia inválida: ${error.message}`); }
      if (meta.source !== source) throw new Error(`La etiqueta ${tag} tiene procedencia inconsistente.`);
    }
  }
  return { tag, version, channel: channelOf(version), source, annotated, meta };
}

/**
 * Existing tags (ascending by version) whose validated source and channel are the given ones.
 * Without `remote` these are LOCAL tags only, which cannot establish publication. With `remote`, a local match counts only
 * when the remote has exactly the same tag object and peeled commit (ls-remote; throws if it fails): a local-only leftover
 * or a differing remote tag is never reported as published.
 */
export function findPublished(git, { source, channel, remote, tags }) {
  // With `remote`, only tags the remote carries with the exact same object and peeled commit are even read, so a foreign
  // or malformed local-only tag can neither count as published nor break the lookup. `tags` reuses a computed listing.
  const names = tags ?? (remote === undefined ? listTagNames(git) : publishedTagNames(git, remote));
  const found = [];
  for (const version of sortVersions(releaseVersions(names))) {
    const info = readTagProvenance(git, `v${version}`);
    if (info.source === source && info.channel === channel) found.push(info);
  }
  return found;
}

/**
 * Names of the local `v*` tags that the remote ALSO carries with exactly the same tag object and peeled commit (one
 * ls-remote; throws PublishError 'fetch' if it fails). This is the only authority for "published": a local-only tag, a
 * foreign local tag or a differently targeted one is never in the list, whichever process created it.
 */
export function publishedTagNames(git, remote = 'origin') {
  let listing;
  try { listing = git(['ls-remote', remote, 'refs/tags/v*']); } catch (error) {
    throw new PublishError(`No se pudo leer el estado remoto de las etiquetas de ${remote}: ${error.message}`, 'fetch');
  }
  const remoteRefs = new Map();
  for (const line of listing.split(/\r?\n/)) {
    const match = /^([0-9a-f]{40})\t(refs\/tags\/\S+)$/.exec(line);
    if (match) remoteRefs.set(match[2], match[1]);
  }
  const local = git(['for-each-ref', '--format=%(refname)\t%(objectname)\t%(*objectname)', 'refs/tags/v*']);
  const names = [];
  for (const line of local.split(/\r?\n/)) {
    const [ref, object, peeledObject] = line.split('\t');
    if (!ref || !object) continue;
    const peeled = peeledObject || object; // lightweight tag: the object is the commit
    const remoteObject = remoteRefs.get(ref);
    if (remoteObject === object && (remoteRefs.get(`${ref}^{}`) ?? remoteObject) === peeled) names.push(ref.slice('refs/tags/'.length));
  }
  return names;
}

// Local tags this process kept after an unknown push outcome, per repository (git dir). They are unpublished until a
// remote check proves otherwise; the next publishRelease in the same clone resolves them before anything else.
const leftovers = new Map();
const gitDirOf = git => git(['rev-parse', '--absolute-git-dir']).trim();

function resolveLeftovers(git, remote) {
  const key = gitDirOf(git);
  const tags = leftovers.get(key);
  if (!tags) return;
  for (const tag of [...tags]) {
    let object; let commit;
    try {
      object = git(['rev-parse', '--verify', `refs/tags/${tag}`]).trim();
      commit = git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]).trim();
    } catch { tags.delete(tag); continue; }
    let state;
    try { state = remoteTagState(git, remote, tag, { object, commit }).state; } catch (error) {
      throw new PublishError(`No se pudo confirmar si ${tag} quedó publicada: ${error.message}. La etiqueta local se conserva.`, 'unknown');
    }
    if (state !== 'published') git(['tag', '--delete', tag]); // absent or replaced by someone else: our local copy is unpublished
    tags.delete(tag);
  }
  if (!tags.size) leftovers.delete(key);
}

// ---------------------------------------------------------------------------------------------------------------------
// Allocation against the repository
// ---------------------------------------------------------------------------------------------------------------------

/** Fetches remote release tags without force. A local tag that differs from the remote one makes the fetch fail. */
export function fetchTags(git, remote = 'origin') {
  try { git(['fetch', '--no-tags', '--no-recurse-submodules', remote, 'refs/tags/v*:refs/tags/v*']); } catch (error) {
    throw new PublishError(`No se pudieron traer las etiquetas de ${remote}: ${error.message}`, 'fetch');
  }
}

/**
 * Reconciliation boundary for release tags: resolves tags this process kept after an unknown push, fetches the remote tags
 * (no force) and returns the names of the tags the remote really carries (see publishedTagNames). Cursor and allocation
 * must be derived from THIS list, never from the raw local tag list, so a retained or foreign local tag (also one left by
 * an earlier process) can never stand in for a published release.
 */
export function syncReleaseTags(git, remote = 'origin') {
  resolveLeftovers(git, remote);
  fetchTags(git, remote);
  return publishedTagNames(git, remote);
}

/** Conventional-commit level of `releaseSource(baseTag)..head`. */
export function releaseLevel(git, baseTag, head) {
  return bumpLevel(parseCommits(git, releaseSource(git, baseTag), head));
}

/**
 * Allocation for `source` over the local tags: { version, tag, level, baseTag, previousStable }.
 * Callers fetch remote tags first (publishRelease does). `tags` (names of remotely published tags) replaces the raw local
 * tag list; the reconciliation always passes it.
 */
export function planVersion(git, { source, channel, tags }) {
  const names = tags ?? listTagNames(git);
  const stable = highestStable(names);
  if (!stable) throw new Refusal('No hay ninguna versión estable previa en el repositorio.');
  const baseTag = `v${stable}`;
  const level = releaseLevel(git, baseTag, source);
  const version = channel === 'stable' ? nextStable(names, level) : channel === 'preview' ? nextPreview(names, level) : undefined;
  if (!version) throw new Refusal(`Canal desconocido: ${channel}.`);
  return { version, tag: `v${version}`, level, baseTag, previousStable: baseTag };
}

// ---------------------------------------------------------------------------------------------------------------------
// Release commit (plumbing only)
// ---------------------------------------------------------------------------------------------------------------------

const blob = (git, source, path) => git(['cat-file', 'blob', `${source}:${path}`]);

function fileMode(git, source, path) {
  const entry = git(['ls-tree', source, '--', path]).trim();
  if (!entry) return undefined;
  const match = /^(\d{6}) blob [0-9a-f]{40}\t/.exec(entry);
  if (!match || !['100644', '100755'].includes(match[1])) throw new Refusal(`${path} no es un archivo regular en el commit fuente.`);
  return match[1];
}

function identityEnv(identity) {
  return {
    GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email,
  };
}

/**
 * Release commit whose only parent is `source` and whose tree differs from the source tree in exactly RELEASE_FILES.
 * Built in a temporary index; the worktree, index, HEAD and branches are untouched. No filters run (`--no-filters`).
 * `commits` are the changelog inputs (parseCommits of the interval); `baseTag` labels the interval. Returns the commit.
 */
export function createReleaseCommit(git, { source, version, channel, baseTag, commits, date = new Date().toISOString().slice(0, 10), identity = BOT }) {
  if (!FULL_SHA.test(source)) throw new Refusal(`El commit fuente debe ser un SHA completo: ${source}.`);
  if (git(['rev-parse', '--verify', `${source}^{commit}`]).trim() !== source) throw new Refusal(`El commit fuente ${source} no existe.`);
  const metadata = releaseMetadata(blob(git, source, 'package.json'), blob(git, source, 'package-lock.json'), version, { requireLower: false });
  const modes = Object.fromEntries(RELEASE_FILES.map(path => [path, fileMode(git, source, path) ?? '100644']));
  let workingChangelog;
  if (fileMode(git, source, 'CHANGELOG.md')) workingChangelog = blob(git, source, 'CHANGELOG.md');
  const baseline = changelogBaseline(git, baseTag, source, workingChangelog);
  if (baseline !== undefined && headingCount(baseline, version) > 0) throw new Refusal(`CHANGELOG.md ya tiene una sección para ${version}.`);
  const entry = renderEntry({ version, date, channel, baseTag, headShort: source.slice(0, 7), commits });
  const changelog = insertEntry(baseline, entry);
  const contents = { 'package.json': metadata.packageText, 'package-lock.json': metadata.lockText, 'CHANGELOG.md': changelog };

  const scratch = mkdtempSync(join(tmpdir(), 'mdd-release-index-'));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, 'index') };
    git(['read-tree', source], { env });
    for (const path of RELEASE_FILES) {
      const object = git(['hash-object', '-w', '--stdin', '--no-filters'], { input: contents[path], env }).trim();
      git(['update-index', '--add', '--cacheinfo', `${modes[path]},${object},${path}`], { env });
    }
    const tree = git(['write-tree'], { env }).trim();
    return git(['commit-tree', tree, '-p', source, '-m', `chore(release): v${version}`], { env: { ...env, ...identityEnv(identity) } }).trim();
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

/**
 * Structural checks of a release commit: only parent is `source`, diff is exactly RELEASE_FILES, both package files carry
 * `version` with the expected formatting, and the CHANGELOG has exactly one `## [version]` section. Throws Error.
 */
export function verifyReleaseCommit(git, { commit, source, version }) {
  const parents = git(['rev-list', '--parents', '-n', '1', commit]).trim().split(/\s+/).slice(1);
  if (parents.length !== 1 || parents[0] !== source) throw new Error(`El commit de release ${commit} debe tener como único padre a ${source}.`);
  const changed = git(['diff-tree', '--no-commit-id', '--no-renames', '--no-ext-diff', '--no-textconv', '--name-only', '-r', commit]).split(/\r?\n/).filter(Boolean).sort();
  if (JSON.stringify(changed) !== JSON.stringify([...RELEASE_FILES].sort())) throw new Error(`El commit de release debe cambiar exactamente ${RELEASE_FILES.join(', ')} (cambia: ${changed.join(', ') || 'nada'}).`);
  const metadata = releaseMetadata(blob(git, commit, 'package.json'), blob(git, commit, 'package-lock.json'), version, { requireLower: false });
  if (metadata.current !== version) throw new Error(`Las versiones del commit de release (${metadata.current}) no coinciden con ${version}.`);
  const sections = headingCount(blob(git, commit, 'CHANGELOG.md'), version);
  if (sections !== 1) throw new Error(`CHANGELOG.md debe tener exactamente una sección ${version} (tiene ${sections}).`);
}

/** Annotated local tag `v<version>` on `commit` with the strict provenance message. Never replaces an existing tag. */
export function annotate(git, { version, commit, message, identity = BOT }) {
  git(['tag', '--annotate', '--cleanup=verbatim', '-F', '-', `v${version}`, commit], { input: message, env: identityEnv(identity) });
}

// ---------------------------------------------------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Remote state of one tag via ls-remote (throws if ls-remote fails):
 * { state: 'absent' | 'published' | 'conflict', object, peeled } where `published` means the remote tag object equals
 * `object` and its peeled commit equals `commit`; `conflict` is any other existing tag with that name.
 */
export function remoteTagState(git, remote, tag, { object, commit }) {
  const refs = new Map();
  for (const line of git(['ls-remote', remote, `refs/tags/${tag}*`]).split(/\r?\n/)) {
    const match = /^([0-9a-f]{40})\t(\S+)$/.exec(line);
    if (match) refs.set(match[2], match[1]);
  }
  const remoteObject = refs.get(`refs/tags/${tag}`);
  const peeled = refs.get(`refs/tags/${tag}^{}`);
  if (!remoteObject) return { state: 'absent' };
  return { state: remoteObject === object && peeled === commit ? 'published' : 'conflict', object: remoteObject, peeled };
}

/**
 * Pushes the local annotated tag (`refs/tags/T:refs/tags/T`; no force, no branch, no --tags) and lets ls-remote decide.
 * Returns { status: 'published' | 'absent' | 'conflict' | 'unknown', pushError?, object, peeled }:
 * `published` even when the push reported an error but the exact object and peeled commit are on the remote;
 * `unknown` when the verification itself failed.
 */
export function publishTag(git, { remote = 'origin', tag }) {
  const ref = `refs/tags/${tag}`;
  if (git(['cat-file', '-t', ref]).trim() !== 'tag') throw new PublishError(`La etiqueta ${tag} no es anotada.`, 'lightweight');
  const object = git(['rev-parse', '--verify', ref]).trim();
  const commit = git(['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  let pushError;
  try { git(['push', '--no-verify', '--no-recurse-submodules', remote, `${ref}:${ref}`]); } catch (error) { pushError = error; }
  try {
    return { ...verifyState(git, remote, tag, object, commit), pushError, local: { object, commit } };
  } catch (error) {
    return { status: 'unknown', pushError, verifyError: error, local: { object, commit } };
  }
}

function verifyState(git, remote, tag, object, commit) {
  const state = remoteTagState(git, remote, tag, { object, commit });
  return { status: state.state, object: state.object, peeled: state.peeled };
}

/**
 * Commit of an existing LOCAL-ONLY tag `tag` when it is exactly the pending release for this source: annotated, strict
 * provenance, same source, channel, Previous-Stable and pull request, and a structurally valid tag-only release commit.
 * Returns undefined when there is no such local ref. Any other local ref with that name is not ours: PublishError
 * 'local-conflict' (nothing is moved or deleted).
 */
function pendingRelease(git, { tag, version, source, channel, previousStable, trailers }) {
  let commit;
  try { commit = git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]).trim(); } catch {
    try { git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]); } catch { return undefined; }
    commit = undefined; // the ref exists but does not peel to a commit
  }
  try {
    if (!commit) throw new Error('no apunta a un commit');
    const info = readTagProvenance(git, tag);
    const meta = info.meta;
    if (!info.annotated || !meta) throw new Error('no es una etiqueta anotada con procedencia');
    if (info.source !== source || info.channel !== channel || meta.previousStable !== previousStable) throw new Error('corresponde a otra fuente, canal o base');
    if (trailers.pullRequest !== undefined && meta.pullRequest !== trailers.pullRequest) throw new Error('corresponde a otra pull request');
    verifyReleaseCommit(git, { commit, source, version });
    return commit;
  } catch (error) {
    throw new PublishError(`Existe una etiqueta local ${tag} que no es el release pendiente de ${source} (${error.message}). No se modifica ni se publica.`, 'local-conflict');
  }
}

/**
 * Builds and publishes one release for `source` and `channel`. Stable signature for the workflow layer:
 *   publishRelease(git, { remote, source, channel, trailers, date, identity, maxAttempts, beforePush, fetch })
 * - `trailers`: { pullRequest, mainCommit, workflowRun } (optional provenance); Previous-Stable is added automatically.
 * - `beforePush({ attempt, tag, commit, version })`: awaited just before each push (race injection point).
 * Allocation and "already published" use only the tags the remote really carries (publishedTagNames); a local-only tag with
 * the planned name is reused when strictly the pending release of this source, else the publication fails visibly (see
 * pendingRelease). Each attempt: fetch tags (no force) -> same source/channel already tagged? -> allocate -> commit -> annotate -> verify
 * -> push -> ls-remote decides. A rejected push, an absent tag or a conflicting tag deletes the unpublished local tag and
 * recomputes; an unknown outcome re-verifies up to `maxAttempts` times and then fails closed.
 * Returns { status: 'published' | 'exists', tag, version, source, channel, commit?, object?, attempts }.
 */
export async function publishRelease(git, {
  remote = 'origin', source, channel, trailers = {}, date, identity = BOT, maxAttempts = DEFAULT_ATTEMPTS, beforePush, fetch = true,
}) {
  if (!FULL_SHA.test(source)) throw new Refusal(`El commit fuente debe ser un SHA completo: ${source}.`);
  if (channel !== 'stable' && channel !== 'preview') throw new Refusal(`Canal desconocido: ${channel}.`);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    resolveLeftovers(git, remote);
    if (fetch) fetchTags(git, remote);
    const tags = publishedTagNames(git, remote);
    const existing = findPublished(git, { source, channel, tags });
    if (existing.length) return { status: 'exists', tag: existing[0].tag, version: existing[0].version, source, channel, attempts: attempt };

    const plan = planVersion(git, { source, channel, tags });
    // A local-only tag with the planned name (an unknown outcome of an earlier process) is reused when it is strictly the
    // release we would build; anything else is a foreign local ref: it is left untouched and the publication fails visibly.
    let commit = pendingRelease(git, { tag: plan.tag, version: plan.version, source, channel, previousStable: plan.previousStable, trailers });
    if (!commit) {
      const commits = parseCommits(git, releaseSource(git, plan.baseTag), source);
      commit = createReleaseCommit(git, { source, version: plan.version, channel, baseTag: plan.baseTag, commits, date, identity });
      verifyReleaseCommit(git, { commit, source, version: plan.version });
      const message = renderTagMessage({ version: plan.version, channel, source, ...trailers, previousStable: plan.previousStable });
      annotate(git, { version: plan.version, commit, message, identity });
    }
    const discard = () => { try { git(['tag', '--delete', plan.tag]); } catch { /* already gone */ } };
    try {
      if (beforePush) await beforePush({ attempt, tag: plan.tag, commit, version: plan.version });
      let result = publishTag(git, { remote, tag: plan.tag });
      for (let check = 1; result.status === 'unknown' && check < maxAttempts; check += 1) {
        try { result = { ...result, ...verifyState(git, remote, plan.tag, result.local.object, result.local.commit) }; } catch { /* still unknown */ }
      }
      if (result.status === 'published') return { status: 'published', tag: plan.tag, version: plan.version, source, channel, commit, object: result.local.object, attempts: attempt };
      if (result.status === 'unknown') {
        let key; try { key = gitDirOf(git); } catch { /* cannot register; the tag is still kept */ }
        if (key) leftovers.set(key, (leftovers.get(key) ?? new Set()).add(plan.tag));
        throw new PublishError(`No se pudo confirmar si ${plan.tag} quedó publicada: ${result.verifyError?.message ?? 'resultado desconocido'}. La etiqueta local se conserva.`, 'unknown');
      }
    } catch (error) {
      if (!(error instanceof PublishError && error.reason === 'unknown')) discard();
      throw error;
    }
    discard(); // absent (push rejected or not applied) or conflicting remote tag: recompute from the fetched state
  }
  throw new PublishError(`No se pudo publicar ${channel} para ${source} tras ${maxAttempts} intentos.`, 'exhausted');
}

// ---------------------------------------------------------------------------------------------------------------------
// GitHub REST client (fetch-based, injectable). The workflow layer only needs these four calls:
//   listOpenPulls() -> every open pull request (all pages); getPull(number); getRun(runId);
//   listJobs(runId, attempt) -> every job of exactly that attempt (all pages).
// ---------------------------------------------------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

const nextLink = header => {
  for (const part of String(header ?? '').split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="next"\s*$/.exec(part);
    if (match) return match[1];
  }
  return undefined;
};

/** `fetch` is injectable. A `next` link outside `apiUrl` is refused, so the token is never sent to another host. */
export function createGitHubClient({ repo, token, fetch: fetchImpl = globalThis.fetch, apiUrl = 'https://api.github.com', maxPages = 100 }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Refusal(`Repositorio inválido: ${repo}.`);
  if (!token) throw new Refusal('Falta el token de GitHub.');
  const root = apiUrl.replace(/\/+$/, '');
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'mdd-release-auto' };
  async function request(url) {
    if (url !== root && !url.startsWith(`${root}/`)) throw new ApiError(`URL fuera de la API de GitHub: ${url}`, 0);
    let response;
    try { response = await fetchImpl(url, { headers }); } catch (error) { throw new ApiError(`GitHub API no respondió (${url}): ${error.message}`, 0); }
    if (!response.ok) throw new ApiError(`GitHub API respondió ${response.status} en ${url}`, response.status);
    return { data: await response.json(), next: nextLink(response.headers?.get?.('link')) };
  }
  async function pages(path, pick) {
    const items = []; let total; let url = `${root}${path}`;
    for (let page = 1; url; page += 1) {
      if (page > maxPages) throw new ApiError(`Demasiadas páginas en ${path}.`, 0);
      const { data, next } = await request(url);
      const batch = pick(data);
      if (!Array.isArray(batch)) throw new ApiError(`Respuesta inesperada en ${path}.`, 0);
      items.push(...batch);
      if (data && typeof data.total_count === 'number') total = data.total_count;
      url = next;
    }
    if (total !== undefined && items.length < total) throw new ApiError(`Respuesta incompleta en ${path}: ${items.length} de ${total}.`, 0);
    return items;
  }
  const base = `/repos/${repo}`;
  return {
    listOpenPulls: () => pages(`${base}/pulls?state=open&per_page=100`, data => data),
    getPull: async number => (await request(`${root}${base}/pulls/${number}`)).data,
    getRun: async runId => (await request(`${root}${base}/actions/runs/${runId}`)).data,
    listJobs: (runId, attempt) => pages(`${base}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`, data => data?.jobs),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reconciliation: candidates are always re-derived from repository state and GitHub; nothing from another job is trusted.
// ---------------------------------------------------------------------------------------------------------------------

export const STABLE_BATCH = 5;
export const PREVIEW_BATCH = 5;
export const DEFAULT_AUTHOR = 'vancinis';
const TAG_NAME = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-preview\.(0|[1-9]\d*))?$/;
const METADATA_SUBJECT = /^chore\(release\): v\d/;

const isAncestor = (git, ancestor, descendant) => {
  try { git(['merge-base', '--is-ancestor', ancestor, descendant]); return true; } catch { return false; }
};

/** Fetches `refs/heads/<branch>` into FETCH_HEAD only (no ref is written) and returns its commit. */
export function fetchMain(git, remote = 'origin', branch = 'main') {
  try {
    git(['fetch', '--no-tags', '--no-recurse-submodules', remote, `refs/heads/${branch}`]);
    const tip = git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}']).trim();
    if (!FULL_SHA.test(tip)) throw new Error(`commit inesperado ${tip}`);
    return tip;
  } catch (error) { throw new PublishError(`No se pudo traer ${branch} de ${remote}: ${error.message}`, 'fetch'); }
}

/** Fetches owner skip markers (`refs/tags/release-skip/*`) without force. */
export function fetchSkipMarkers(git, remote = 'origin') {
  try { git(['fetch', '--no-tags', '--no-recurse-submodules', remote, 'refs/tags/release-skip/*:refs/tags/release-skip/*']); } catch (error) {
    throw new PublishError(`No se pudieron traer los marcadores de omisión de ${remote}: ${error.message}`, 'fetch');
  }
}

/**
 * True only for an ANNOTATED tag `release-skip/<sha>` whose direct target is exactly the commit `sha`
 * (not a nested tag, not another object). Who may create it is enforced by the repository ruleset (owner only,
 * immutable); the tagger identity in the object is spoofable and is never consulted. The automation never creates one.
 */
export function hasSkipMarker(git, sha) {
  const ref = `refs/tags/release-skip/${sha}`;
  try {
    if (git(['cat-file', '-t', ref]).trim() !== 'tag') return false;
    const header = git(['cat-file', '-p', ref]).split(/\r?\n/);
    return header[0] === `object ${sha}` && header[1] === 'type commit' && header[2] === `tag release-skip/${sha}`;
  } catch { return false; }
}

/** A pure metadata release commit: `chore(release): v…`, one parent and a diff of exactly RELEASE_FILES. Anything else is an integration. */
export function isMetadataRelease(git, sha) {
  try {
    if (!METADATA_SUBJECT.test(git(['log', '-1', '--format=%s', sha]).trim())) return false;
    if (git(['rev-list', '--parents', '-n', '1', sha]).trim().split(/\s+/).length !== 2) return false;
    const changed = git(['diff-tree', '--no-commit-id', '--no-renames', '--no-ext-diff', '--no-textconv', '--name-only', '-r', sha]).split(/\r?\n/).filter(Boolean).sort();
    return JSON.stringify(changed) === JSON.stringify([...RELEASE_FILES].sort());
  } catch { return false; }
}

/**
 * Pending stable integrations after the cursor: { baseTag, cursor, candidates }. The cursor is the earliest first-parent
 * commit of `tip` that contains the recorded source of the highest stable tag (legacy tags: the tag commit itself, so a
 * release merged through a side branch resolves to the merge commit). Candidates are the later first-parent commits in
 * source order without pure metadata release commits. A source that is not an ancestor of `tip` (force push) refuses.
 * `tags` are the names of remotely published tags (syncReleaseTags): the reconciliation always passes them, so a local-only
 * tag can never move the cursor. Without it the raw local list is used (offline analysis and tests).
 */
export function stableWork(git, tip, { tags } = {}) {
  const stable = highestStable(tags ?? listTagNames(git));
  if (!stable) throw new Refusal('No hay ninguna versión estable previa en el repositorio.');
  const baseTag = `v${stable}`;
  const source = releaseSource(git, baseTag);
  if (!isAncestor(git, source, tip)) throw new Refusal(`El origen ${source} de ${baseTag} no es ancestro de main (${tip}): historial reescrito o procedencia inconsistente. No se publica nada.`);
  const chain = git(['rev-list', '--first-parent', '--reverse', tip]).split(/\r?\n/).filter(Boolean);
  let low = 0; let high = chain.length - 1;
  while (low < high) { const mid = (low + high) >> 1; if (isAncestor(git, source, chain[mid])) high = mid; else low = mid + 1; }
  return { baseTag, cursor: chain[low], candidates: chain.slice(low + 1).filter(sha => !isMetadataRelease(git, sha)) };
}

/** Reason a pull request is NOT eligible for a preview, or undefined when it is (ready, owner, same repository, base main). */
export function previewIneligibility(pr, { repo, author, branch = 'main' }) {
  const same = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  if (!pr || !Number.isSafeInteger(pr.number) || pr.number < 1) return 'número inválido';
  if (pr.state !== 'open') return 'no está abierta';
  if (pr.draft !== false) return 'es borrador';
  if (!same(pr.user?.login, author) || pr.user?.type !== 'User') return 'autor no autorizado';
  if (pr.base?.ref !== branch || !same(pr.base?.repo?.full_name, repo)) return `no apunta a ${branch}`;
  if (!same(pr.head?.repo?.full_name, repo)) return 'la rama viene de otro repositorio';
  if (!FULL_SHA.test(pr.head?.sha ?? '')) return 'head inválido';
  return undefined;
}

/** Fetches `refs/pull/<n>/head` and returns its commit (FETCH_HEAD only; no ref is written). */
export function fetchPullHead(git, remote, number) {
  git(['fetch', '--no-tags', '--no-recurse-submodules', remote, `refs/pull/${number}/head`]);
  return git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}']).trim();
}

/**
 * Previews still to publish: eligible PRs (fresh open-PR inventory), ascending by number, without a remotely verified
 * preview for their current head, whose `refs/pull/N/head` matches the API head. At most `batch` verified PRs are
 * returned; `remaining` counts the unpublished eligible ones beyond them. Ignored PRs carry the reason.
 *
 * Fairness: the unpublished eligible PRs form a circular list by number and the window starts at
 * `((runNumber - 1) * batch) mod n` (run 1 starts at the lowest number). `runNumber` is GitHub's per-workflow monotonic run counter (identical for every attempt of a
 * run, so plan, publish and re-runs agree), hence consecutive runs tile the list and every eligible PR is inside some window
 * within ceil(n / batch) consecutive runs, however many earlier PRs keep failing. Without `runNumber` the window starts at
 * the first PR (local analysis). The window never authorizes anything: publication still needs a successful validation.
 * `tags`: names of remotely published tags (computed when omitted).
 */
export async function previewWork(git, client, { repo, author, remote = 'origin', batch = PREVIEW_BATCH, runNumber, tags }) {
  const pulls = await client.listOpenPulls();
  const eligible = []; const ignored = [];
  for (const pr of pulls) {
    const reason = previewIneligibility(pr, { repo, author });
    if (reason) ignored.push({ number: pr?.number, reason }); else eligible.push(pr);
  }
  eligible.sort((a, b) => a.number - b.number);
  let published = new Set();
  if (eligible.length) {
    const names = tags ?? publishedTagNames(git, remote);
    published = new Set(names.filter(name => IDENTIFIERS.test(name.slice(1)) && channelOf(name.slice(1)) === 'preview').map(name => readTagProvenance(git, name).source));
  }
  const waiting = eligible.filter(pr => !published.has(pr.head.sha));
  const size = waiting.length;
  const start = runNumber === undefined || !size ? 0 : Number((BigInt(runNumber - 1) * BigInt(batch)) % BigInt(size));
  const candidates = []; let remaining = 0;
  for (let index = 0; index < size; index += 1) {
    const pr = waiting[(start + index) % size];
    if (candidates.length >= batch) { remaining += 1; continue; }
    let fetched;
    try { fetched = fetchPullHead(git, remote, pr.number); } catch { ignored.push({ number: pr.number, reason: 'no se pudo traer refs/pull/N/head' }); continue; }
    if (fetched !== pr.head.sha) { ignored.push({ number: pr.number, reason: 'el head cambió' }); continue; }
    candidates.push({ number: pr.number, source: pr.head.sha });
  }
  return { candidates, remaining, ignored, window: { runNumber, start, size } };
}

/**
 * Verdict of `validate <sha>` for the CURRENT attempt of the run, from GitHub's job records only:
 * 'success' (exactly one completed successful job), 'failed' (exactly one failure or timed_out), otherwise 'pending'
 * (missing, ambiguous, still running, cancelled, skipped, or belonging to another run or attempt).
 */
export function validationVerdict(jobs, sha, { runId, attempt }) {
  const name = `validate ${sha}`;
  const own = jobs.filter(job => job?.name === name && String(job.run_id) === String(runId) && Number(job.run_attempt) === Number(attempt));
  if (own.length !== 1) return 'pending';
  const [job] = own;
  if (job.status !== 'completed') return 'pending';
  if (job.conclusion === 'success') return 'success';
  if (job.conclusion === 'failure' || job.conclusion === 'timed_out') return 'failed';
  return 'pending';
}

/**
 * Prefix of `candidates` to process in one run: owner-authorized skips never use the batch budget, so any number of
 * consecutive skip markers is followed by up to `size` real validations (durable forward progress).
 */
export function stableBatchOf(git, candidates, size) {
  const batch = []; let real = 0;
  for (const sha of candidates) {
    if (!hasSkipMarker(git, sha)) { if (real >= size) break; real += 1; }
    batch.push(sha);
  }
  return batch;
}

/** `plan`: read-only derivation of the validation matrix (at most `stableBatch` stables and `previewBatch` previews). */
export async function runPlan(git, client, { repo, author = DEFAULT_AUTHOR, remote = 'origin', stableBatch = STABLE_BATCH, previewBatch = PREVIEW_BATCH, runId, attempt }) {
  // With a run id (always the case in Actions) the preview window rotates by GitHub's run counter, read from the API.
  const runNumber = runId === undefined ? undefined : (await trustedRun(client, runId, attempt)).runNumber;
  const tags = syncReleaseTags(git, remote); fetchSkipMarkers(git, remote);
  const tip = fetchMain(git, remote);
  const work = stableWork(git, tip, { tags });
  const batch = stableBatchOf(git, work.candidates, stableBatch);
  const stables = batch.filter(sha => !hasSkipMarker(git, sha));
  const previews = await previewWork(git, client, { repo, author, remote, batch: previewBatch, runNumber, tags });
  const sources = [...new Set([...stables, ...previews.candidates.map(item => item.source)])];
  return {
    tip, baseTag: work.baseTag, cursor: work.cursor, stables, previews: previews.candidates, sources,
    stableRemaining: work.candidates.length - batch.length, previewRemaining: previews.remaining, ignored: previews.ignored,
    previewWindow: previews.window,
  };
}

class PreviewStale extends Error {}

/** The run's trusted identity from the API: id (and attempt, when given) must match; `run_number` is a positive integer. */
async function trustedRun(client, runId, attempt) {
  const run = await client.getRun(runId);
  if (String(run?.id) !== String(runId) || (attempt !== undefined && Number(run?.run_attempt) !== Number(attempt))) {
    throw new Refusal(attempt === undefined
      ? `La ejecución ${runId} no coincide con la respuesta de GitHub; no se confía en datos de otra ejecución.`
      : `La ejecución ${runId} no está en el intento ${attempt}; no se confía en trabajos de otro intento.`);
  }
  if (!Number.isSafeInteger(run.run_number) || run.run_number < 1) throw new Refusal(`La ejecución ${runId} no informa un run_number válido.`);
  return { run, runNumber: run.run_number };
}

/**
 * `publish`: re-derives everything, trusts only GitHub's job records for the current attempt, publishes stables in source
 * order (blocked on a failed validation, pending on a missing one, never reordering or bundling) and then previews.
 * Result: { published, skipped, pending, blocked, failures, backlog, progress, continue, ... }.
 */
export async function runPublish(git, client, {
  repo, runId, attempt, author = DEFAULT_AUTHOR, remote = 'origin', stableBatch = STABLE_BATCH, previewBatch = PREVIEW_BATCH,
}) {
  // Same trusted source as `plan`: the run counter comes from the API for this run id, never from plan outputs.
  const { runNumber } = await trustedRun(client, runId, attempt);
  const jobs = await client.listJobs(runId, attempt);
  const tags = syncReleaseTags(git, remote); fetchSkipMarkers(git, remote);
  const tip = fetchMain(git, remote);
  const work = stableWork(git, tip, { tags });
  const result = { tip, published: [], skipped: [], pending: [], blocked: undefined, failures: [], ignored: [], baseTag: work.baseTag };
  const verdict = sha => validationVerdict(jobs, sha, { runId, attempt });

  // Stables, strictly in source order.
  const batch = stableBatchOf(git, work.candidates, stableBatch);
  let resolved = 0;
  for (const source of batch) {
    if (hasSkipMarker(git, source)) { result.skipped.push({ channel: 'stable', source, reason: 'marcador release-skip del propietario' }); resolved += 1; continue; }
    const state = verdict(source);
    if (state === 'failed') { result.blocked = { source, reason: 'la validación falló' }; break; }
    if (state !== 'success') { result.pending.push({ channel: 'stable', source }); break; }
    try {
      const done = await publishRelease(git, {
        remote, source, channel: 'stable', trailers: { workflowRun: String(runId) },
        beforePush: async ({ tag }) => {
          const current = fetchMain(git, remote);
          if (!isAncestor(git, source, current)) throw new Refusal(`${source} ya no pertenece a main (historial reescrito). No se publica.`);
          // Source order: re-read the remote stable tags right before the push. A newer stable (for example a manual one)
          // must still be exactly the base this tag was allocated from, and its recorded source must precede ours.
          fetchTags(git, remote);
          const others = publishedTagNames(git, remote).filter(name => name !== tag);
          const latest = highestStable(others);
          const planned = readTagProvenance(git, tag).meta?.previousStable;
          const newest = `v${latest}`;
          if (newest !== planned) throw new Refusal(`Apareció la estable ${newest} mientras se publicaba ${tag} (base prevista ${planned}). No se publica fuera de orden.`);
          const newestSource = releaseSource(git, newest);
          if (newestSource === source || !isAncestor(git, newestSource, source)) throw new Refusal(`La estable ${newest} está enraizada en ${newestSource}, que no precede a ${source}. No se publica fuera de orden.`);
        },
      });
      if (done.status === 'published') result.published.push({ channel: 'stable', tag: done.tag, source });
      resolved += 1;
    } catch (error) { result.failures.push({ channel: 'stable', source, message: error.message }); break; }
  }
  result.stableBacklog = work.candidates.length - resolved;

  // Previews: independent of each other and never blocked by a stable.
  let previewBacklog = 0;
  try {
    // Re-read the remote tags: stables published above are part of the state the previews are allocated against.
    const previews = await previewWork(git, client, { repo, author, remote, batch: previewBatch, runNumber, tags: publishedTagNames(git, remote) });
    result.ignored = previews.ignored;
    previewBacklog = previews.remaining;
    for (const { number, source } of previews.candidates) {
      const state = verdict(source);
      if (state === 'failed') { result.skipped.push({ channel: 'preview', source, number, reason: 'la validación falló' }); continue; }
      if (state !== 'success') { result.pending.push({ channel: 'preview', source, number }); previewBacklog += 1; continue; }
      try {
        const done = await publishRelease(git, {
          remote, source, channel: 'preview', trailers: { pullRequest: String(number), mainCommit: tip, workflowRun: String(runId) },
          // Runs before EVERY push, including each retry attempt: a stale head, draft or closed PR is never published.
          beforePush: async () => {
            const pr = await client.getPull(number);
            const reason = previewIneligibility(pr, { repo, author });
            if (reason) throw new PreviewStale(`#${number}: ${reason}`);
            if (pr.head.sha !== source) throw new PreviewStale(`#${number}: el head ya no es ${source}`);
            let fetched; try { fetched = fetchPullHead(git, remote, number); } catch { throw new PreviewStale(`#${number}: no se pudo verificar refs/pull/${number}/head`); }
            if (fetched !== source) throw new PreviewStale(`#${number}: refs/pull/${number}/head ya no es ${source}`);
          },
        });
        if (done.status === 'published') result.published.push({ channel: 'preview', tag: done.tag, source, number });
      } catch (error) {
        if (error instanceof PreviewStale) result.skipped.push({ channel: 'preview', source, number, reason: error.message });
        else { result.failures.push({ channel: 'preview', source, message: error.message }); break; }
      }
    }
  } catch (error) { result.failures.push({ channel: 'preview', message: error.message }); }

  result.backlog = result.stableBacklog + previewBacklog;
  result.progress = result.published.length > 0;
  result.continue = result.progress && result.backlog > 0 && !result.blocked && result.failures.length === 0;
  result.exitCode = result.blocked || result.failures.length ? 1 : 0;
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// GitHub outputs, summary and CLI
// ---------------------------------------------------------------------------------------------------------------------

const USAGE = `Uso: node scripts/release-auto.mjs <plan|publish> [opciones]

Comandos:
  plan      Deriva (solo lectura) las fuentes a validar: matriz de hasta ${STABLE_BATCH} estables y ${PREVIEW_BATCH} previews.
  publish   Vuelve a derivar los candidatos y publica solo lo que GitHub registró como "validate <sha>" exitoso en este intento.

Opciones:
  --repo <dueño/nombre>   Repositorio (o GITHUB_REPOSITORY).
  --run-id <n>            Ejecución actual (o GITHUB_RUN_ID). publish: obligatorio; plan: obligatorio en Actions, y
                          fija la ventana rotatoria de previews con el run_number que informa GitHub.
  --attempt <n>           Intento actual (o GITHUB_RUN_ATTEMPT). publish: obligatorio.
  --author <login>        Autor de previews (o RELEASE_PREVIEW_AUTHOR; por defecto ${DEFAULT_AUTHOR}).
  --remote <nombre>       Remoto Git (por defecto origin).
  --help                  Muestra esta ayuda.

El token de GitHub se lee solo de GITHUB_TOKEN. Salidas: GITHUB_OUTPUT y GITHUB_STEP_SUMMARY si existen.
Códigos de salida: 0 hecho, sin cambios o pendiente; 1 bloqueo o fallo; 2 uso incorrecto.
`;

const clean = value => {
  const text = String(value);
  if (/[\r\n]/.test(text)) throw new Error('Valor de salida inválido.');
  return text;
};

/** Appends `name=value` lines to the GITHUB_OUTPUT file. Only validated tokens (SHAs, tags, counts, booleans, fixed JSON) are emitted. */
export function writeOutputs(file, values) {
  if (!file) return;
  appendFileSync(file, Object.entries(values).map(([name, value]) => `${name}=${clean(value)}\n`).join(''), 'utf8');
}

export const planOutputs = plan => ({
  has_work: String(plan.sources.length > 0),
  matrix: JSON.stringify({ include: plan.sources.map(source => ({ source })) }),
  stable_count: String(plan.stables.length), preview_count: String(plan.previews.length),
  stable_remaining: String(plan.stableRemaining), preview_remaining: String(plan.previewRemaining),
});

export const publishOutputs = result => {
  const tags = result.published.map(item => item.tag).filter(tag => TAG_NAME.test(tag));
  return {
    published: JSON.stringify(tags), published_count: String(tags.length),
    smoke_matrix: JSON.stringify({ include: tags.map(tag => ({ tag })) }),
    backlog: String(result.backlog), progress: String(result.progress), blocked: String(Boolean(result.blocked)),
    continue: String(result.continue), exit_code: String(result.exitCode),
  };
};

export function planSummary(plan) {
  const lines = ['## Release: plan', '', `- Commit de main: \`${plan.tip}\``, `- Base estable: \`${plan.baseTag}\` (cursor \`${plan.cursor.slice(0, 7)}\`)`,
    `- Estables a validar: ${plan.stables.length} (pendientes tras el lote: ${plan.stableRemaining})`,
    `- Previews a validar: ${plan.previews.length} (pendientes tras el lote: ${plan.previewRemaining})`];
  for (const sha of plan.stables) lines.push(`  - estable \`${sha}\``);
  for (const item of plan.previews) lines.push(`  - preview de #${item.number} \`${item.source}\``);
  if (!plan.sources.length) lines.push('', 'No hay nada que validar.');
  return `${lines.join('\n')}\n`;
}

export function publishSummary(result) {
  const lines = ['## Release: publicación', ''];
  if (!result.published.length) lines.push('- Nada publicado en esta ejecución.');
  for (const item of result.published) lines.push(`- Publicado \`${item.tag}\` (${item.channel === 'stable' ? 'estable' : 'preview'}) desde \`${item.source}\`.`);
  for (const item of result.skipped) lines.push(`- Omitido ${item.channel === 'stable' ? 'estable' : `preview #${item.number}`} \`${item.source}\`: ${item.reason}.`);
  for (const item of result.pending) lines.push(`- Pendiente de validación: ${item.channel === 'stable' ? 'estable' : `preview #${item.number}`} \`${item.source}\`. Se espera sin reordenar.`);
  if (result.blocked) lines.push(`- **Estable bloqueado en \`${result.blocked.source}\`**: ${result.blocked.reason}. No se omite automáticamente; el propietario puede crear el marcador anotado \`release-skip/${result.blocked.source}\` o corregir hacia adelante.`);
  for (const item of result.failures) lines.push(`- **Fallo** (${item.channel}${item.source ? ` \`${item.source}\`` : ''}): ${item.message}`);
  lines.push('', `- Pendientes (backlog): ${result.backlog}`, `- Hubo avance: ${result.progress ? 'sí' : 'no'}`, `- Continuación: ${result.continue ? 'sí' : 'no'}`);
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  const known = new Set(['--repo', '--run-id', '--attempt', '--author', '--remote']);
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--help') options.help = true;
    else if (known.has(flag) && index + 1 < rest.length && !rest[index + 1].startsWith('--')) { options[flag.slice(2)] = rest[index + 1]; index += 1; } else return { error: `Opción no válida o sin valor: ${flag}` };
  }
  return { command, options };
}

/**
 * CLI entry (import-safe). Returns the exit code: 0 done, no-op or pending; 1 blocked or failure; 2 usage.
 * Injectable: `env`, `cwd`, `git`, `client`, `fetch`, `stdout`, `stderr`, `writeFile(path, text)` for the step summary.
 */
export async function main(argv, {
  env = process.env, cwd = process.cwd(), git, client, fetch: fetchImpl, stdout = text => process.stdout.write(text), stderr = text => process.stderr.write(text),
  summaryWriter = (file, text) => appendFileSync(file, text, 'utf8'),
} = {}) {
  if (argv[0] === '--help') { stdout(USAGE); return 0; }
  const parsed = parseArgs(argv);
  const usage = message => { stderr(`${message ? `${message}\n\n` : ''}${USAGE}`); return 2; };
  if (parsed.error) return usage(parsed.error);
  if (parsed.options.help) { stdout(USAGE); return 0; }
  const { command, options } = parsed;
  if (command !== 'plan' && command !== 'publish') return usage(command ? `Comando desconocido: ${command}` : 'Falta el comando.');
  const repo = options.repo ?? env.GITHUB_REPOSITORY;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return usage('Falta --repo <dueño/nombre> o GITHUB_REPOSITORY válido.');
  const author = options.author ?? env.RELEASE_PREVIEW_AUTHOR ?? DEFAULT_AUTHOR;
  let runId; let attempt;
  if (command === 'publish') {
    runId = options['run-id'] ?? env.GITHUB_RUN_ID; attempt = options.attempt ?? env.GITHUB_RUN_ATTEMPT;
    if (!/^[1-9]\d*$/.test(runId ?? '') || !/^[1-9]\d*$/.test(attempt ?? '')) return usage('publish requiere --run-id y --attempt (o GITHUB_RUN_ID y GITHUB_RUN_ATTEMPT) positivos.');
  } else {
    // plan: the run id selects the fair preview window. Optional for a local dry run, mandatory inside GitHub Actions.
    runId = options['run-id'] ?? env.GITHUB_RUN_ID; attempt = options.attempt ?? env.GITHUB_RUN_ATTEMPT;
    if (runId === undefined || runId === '') {
      if (env.GITHUB_ACTIONS === 'true') return usage('plan en GitHub Actions requiere GITHUB_RUN_ID (o --run-id).');
      runId = undefined; attempt = undefined;
    } else if (!/^[1-9]\d*$/.test(runId) || (attempt !== undefined && attempt !== '' && !/^[1-9]\d*$/.test(attempt))) {
      return usage('plan: --run-id y --attempt (o GITHUB_RUN_ID y GITHUB_RUN_ATTEMPT) deben ser enteros positivos.');
    }
    if (attempt === '') attempt = undefined;
  }
  if (!client && !env.GITHUB_TOKEN) return usage('Falta GITHUB_TOKEN.');
  try {
    client ??= createGitHubClient({ repo, token: env.GITHUB_TOKEN, fetch: fetchImpl, apiUrl: env.GITHUB_API_URL || undefined });
    git ??= createAutoGit(cwd);
    const settings = { repo, author, remote: options.remote ?? 'origin' };
    let outputs; let summary; let exitCode = 0;
    if (command === 'plan') {
      const plan = await runPlan(git, client, { ...settings, runId, attempt });
      outputs = planOutputs(plan); summary = planSummary(plan);
    } else {
      const result = await runPublish(git, client, { ...settings, runId, attempt });
      outputs = publishOutputs(result); summary = publishSummary(result); exitCode = result.exitCode;
    }
    writeOutputs(env.GITHUB_OUTPUT, outputs);
    if (env.GITHUB_STEP_SUMMARY) summaryWriter(env.GITHUB_STEP_SUMMARY, summary);
    stdout(summary);
    if (exitCode) stderr('Release terminó con bloqueo o fallo.\n');
    return exitCode;
  } catch (error) {
    stderr(`Error: ${error.message}\n`);
    try {
      writeOutputs(env.GITHUB_OUTPUT, command === 'plan'
        ? { has_work: 'false', matrix: '{"include":[]}', stable_count: '0', preview_count: '0', stable_remaining: '0', preview_remaining: '0' }
        : { published: '[]', published_count: '0', smoke_matrix: '{"include":[]}', backlog: '0', progress: 'false', blocked: 'false', continue: 'false', exit_code: '1' });
    } catch { /* outputs are best effort on failure */ }
    return 1;
  }
}

const isEntry = () => {
  try { return Boolean(process.argv[1]) && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (isEntry()) process.exitCode = await main(process.argv.slice(2));
