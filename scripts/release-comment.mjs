// Trusted checkout only. Git reads candidate objects as data; no checkout, build or publication.
import { appendFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAutoGit, createGitHubClient, DEFAULT_AUTHOR, fetchMain, fetchPullHead, planVersion,
  previewIneligibility, readTagProvenance, stableWork, syncReleaseTags, trustedRun, validationVerdict,
} from './release-auto.mjs';
import { compareVersions, parseVersion } from './release.mjs';

const MARKER = '<!-- mdd-release-preview -->';
const VOLATILE = '<!-- mdd-release-preview:volatil -->';
const SHA = /^[0-9a-f]{40}$/;
const POSITIVE = /^[1-9]\d*$/;
const USAGE = `Uso: node scripts/release-comment.mjs [--help]

Actualiza el comentario de versiones en los PR elegibles.
Requiere GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT y GITHUB_TOKEN.
`;
const STATUS = {
  pending: 'Pendiente de validación',
  failed: 'Validación fallida',
  success: 'Validada, publicación pendiente',
};

const short = sha => sha.slice(0, 7);
const tagLink = (repositoryUrl, tag) => `[\`${tag}\`](${repositoryUrl}/tree/${tag})`;

export function renderComment({
  repositoryUrl, previous, base, baseVersion, head, preview, olderPreview, verdict,
  estimate, pendingIntegrations, runId, updatedAt,
}) {
  const basePackage = baseVersion ? `\`${baseVersion}\`` : 'Versión no disponible';
  return [
    MARKER, '## Versiones de este PR', '',
    '| Concepto | Estado |', '| --- | --- |',
    `| Versión anterior | \`${previous}\` |`,
    `| \`package.json\` en la base | ${basePackage} (base común: \`${short(base)}\`) |`,
    `| Preview de este head | ${preview ? `Publicada: ${tagLink(repositoryUrl, preview)}` : STATUS[verdict]} |`,
    `| Estable prevista si se fusiona ahora | \`${estimate.tag}\` (nivel \`${estimate.level}\`; estimación) |`,
    `| Commit del PR | \`${short(head)}\` |`,
    ...(olderPreview ? [`| Última preview publicada de esta PR | ${tagLink(repositoryUrl, olderPreview)} |`] : []),
    ...(pendingIntegrations ? ['', `> Hay ${pendingIntegrations === 1 ? '1 integración pendiente' : `${pendingIntegrations} integraciones pendientes`} de publicar en \`main\`. La versión estable real puede ser mayor.`] : []),
    '', VOLATILE,
    `- Ejecución: [ver en GitHub](${repositoryUrl}/actions/runs/${runId})`,
    `- Última actualización: \`${updatedAt}\``,
    '',
  ].join('\n');
}

function packageVersion(git, base) {
  try {
    // The blob is read directly; Git does not run filters or interpret a path from the PR.
    const { version } = JSON.parse(git(['cat-file', 'blob', `${base}:package.json`]));
    return typeof version === 'string' ? parseVersion(version)?.text : undefined;
  } catch {
    return undefined;
  }
}

function previewIndex(git, tags) {
  // Parse each remotely verified preview once, rather than walking every tag for each open PR.
  const previews = tags.filter(tag => tag.startsWith('v') && parseVersion(tag)?.preview != null)
    .map(tag => readTagProvenance(git, tag));
  return previews.sort((a, b) => compareVersions(parseVersion(b.version), parseVersion(a.version)));
}

export function describePull(git, pr, { tip, tags, work, previews, jobs, runId, attempt }) {
  const head = pr.head.sha;
  const base = git(['merge-base', tip, head]).trim();
  if (!SHA.test(base)) throw new Error('No se pudo determinar la base común con main.');
  return {
    previous: work.baseTag, base, baseVersion: packageVersion(git, base), head,
    preview: previews.find(info => info.source === head)?.tag,
    olderPreview: previews.find(info => info.source !== head && info.meta?.pullRequest === String(pr.number))?.tag,
    verdict: validationVerdict(jobs, head, { runId, attempt }),
    estimate: planVersion(git, { source: head, channel: 'stable', tags }),
    pendingIntegrations: work.candidates.length,
  };
}

function stableBody(body) {
  const lines = body.split(/\r?\n/);
  const footer = lines.indexOf(VOLATILE);
  return (footer < 0 ? lines : lines.slice(0, footer)).join('\n').trimEnd();
}

export async function upsertComment(client, number, body, isCurrent) {
  const comments = await client.listIssueComments(number);
  const sticky = comments.filter(comment => Number.isSafeInteger(comment?.id) && comment.id > 0
    && comment.user?.type === 'Bot' && comment.user.login === 'github-actions[bot]'
    && typeof comment.body === 'string' && comment.body.split(/\r?\n/, 1)[0] === MARKER)
    .sort((a, b) => a.id - b.id)[0];
  if (sticky && stableBody(sticky.body) === stableBody(body)) return { status: 'sin cambios' };
  if (!isCurrent(await client.getPull(number))) return { status: 'omitido', detail: 'el PR cambió de head o dejó de ser elegible' };
  if (sticky) {
    await client.updateIssueComment(sticky.id, body);
    return { status: 'actualizado' };
  }
  await client.createIssueComment(number, body);
  return { status: 'creado' };
}

export async function runComments(git, client, {
  repo, runId, attempt, author = DEFAULT_AUTHOR, remote = 'origin',
  serverUrl = 'https://github.com', now = () => new Date(),
}) {
  const repositoryUrl = `${serverOrigin(serverUrl)}/${repo}`;
  await trustedRun(client, runId, attempt);
  const jobs = await client.listJobs(runId, attempt);
  const tags = syncReleaseTags(git, remote);
  const tip = fetchMain(git, remote);
  const work = stableWork(git, tip, { tags });
  const previews = previewIndex(git, tags);
  const pulls = await client.listOpenPulls();
  const settings = { repo, author };
  const results = [];
  const updatedAt = now().toISOString();
  for (const pr of pulls) {
    if (previewIneligibility(pr, settings)) continue;
    const { number } = pr;
    try {
      let fetched;
      try { fetched = fetchPullHead(git, remote, number); } catch {
        results.push({ number, status: 'omitido', detail: 'no se pudo traer refs/pull/N/head' });
        continue;
      }
      if (fetched !== pr.head.sha) {
        results.push({ number, status: 'omitido', detail: 'refs/pull/N/head no coincide con la API' });
        continue;
      }
      const state = describePull(git, pr, { tip, tags, work, previews, jobs, runId, attempt });
      const body = renderComment({ ...state, repositoryUrl, runId, updatedAt });
      const result = await upsertComment(client, number, body, current => current?.number === number
        && current.head?.sha === fetched && !previewIneligibility(current, settings));
      results.push({ number, ...result });
    } catch (error) {
      results.push({ number, status: 'falló', detail: error.message });
    }
  }
  return results;
}

function serverOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !/^[\w.-]+$/.test(url.hostname) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new Error('GITHUB_SERVER_URL no es un origen HTTPS válido.');
  return url.origin;
}

const oneLine = text => String(text).replace(/[\r\n\u2028\u2029]+/g, ' ');
const safeDetail = text => oneLine(text).replace(/[&<>"'`[\]_*\\]/g, char => `&#${char.codePointAt(0)};`);

export async function main(argv, {
  env = process.env, git, client, fetch, stdout = text => process.stdout.write(text),
  stderr = text => process.stderr.write(text), summaryWriter = (file, text) => appendFileSync(file, text, 'utf8'), now,
} = {}) {
  if (argv.length === 1 && argv[0] === '--help') { stdout(USAGE); return 0; }
  const usage = message => { stderr(`${message}\n\n${USAGE}`); return 2; };
  if (argv.length) return usage('Opción no válida.');
  const { GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: attempt } = env;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || repo.split('/').some(part => part === '.' || part === '..')) return usage('Falta GITHUB_REPOSITORY válido.');
  if (!POSITIVE.test(runId ?? '') || !POSITIVE.test(attempt ?? '')) return usage('GITHUB_RUN_ID y GITHUB_RUN_ATTEMPT deben ser enteros positivos.');
  if (!client && !env.GITHUB_TOKEN) return usage('Falta GITHUB_TOKEN.');
  try {
    client ??= createGitHubClient({ repo, token: env.GITHUB_TOKEN, apiUrl: env.GITHUB_API_URL || undefined, fetch });
    git ??= createAutoGit(process.cwd());
    const results = await runComments(git, client, {
      repo, runId, attempt, author: env.RELEASE_PREVIEW_AUTHOR || DEFAULT_AUTHOR,
      serverUrl: env.GITHUB_SERVER_URL || undefined, now,
    });
    const lines = results.map(({ number, status, detail }) => `- PR #${number}: ${status}${detail ? ` (${safeDetail(detail)})` : ''}`);
    const summary = `## Comentarios de versiones\n\n${lines.join('\n') || 'No hay PR elegibles.'}\n`;
    if (env.GITHUB_STEP_SUMMARY) summaryWriter(env.GITHUB_STEP_SUMMARY, summary);
    stdout(summary);
    return 0;
  } catch (error) {
    stderr(`Error: ${oneLine(error.message)}\n`);
    return 1;
  }
}

const isEntry = () => {
  try { return Boolean(process.argv[1]) && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (isEntry()) process.exitCode = await main(process.argv.slice(2));
