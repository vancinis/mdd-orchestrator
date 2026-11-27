import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const SINCE = 1792800000000;
const AGENT = 'mdd-orchestrator';
const VIEWS = ['agg', 'ctx2', 'layout'];
const MDD = /\.mdd[\\/]+runs/;
const RUNFILE = /\.mdd[\\/]+runs[\\/]+[^\\/"']+\.md(?![\\/\w-])/;
const countVolume = () => ({ count: 0, volume: 0 });
const share = (n, total) => total ? n / total : null;
const len = (v) => v == null ? 0 : (typeof v === 'string' ? v.length : JSON.stringify(v).length);
const outText = (st) => (st?.content ?? []).map(c => c.text ?? '').join('');
const toolPath = (p) => p.state?.input?.path || p.state?.input?.filePath || '';

export function parseArgs(argv) {
  const names = {
    '--db': 'db',
    '--view': 'view',
    '--since': 'since',
    '--until': 'until',
    '--min-messages': 'minMessages',
    '--sessions-file': 'sessionsFile',
  };
  const options = {
    db: join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode', 'opencode.db'),
    view: 'all', since: SINCE, until: null, minMessages: null, sessionsFile: null,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!Object.hasOwn(names, flag)) throw new Error(`Unknown argument: ${flag}`);
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (['--since', '--until', '--min-messages'].includes(flag)) {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error(`${flag} requires a non-negative safe integer`);
      }
      options[names[flag]] = Number(value);
    } else {
      options[names[flag]] = value;
    }
  }
  if (![...VIEWS, 'all'].includes(options.view)) throw new Error('--view must be agg, ctx2, layout or all');
  if (options.until !== null && options.until < options.since) throw new Error('--until must not precede --since');
  options.db = resolve(options.db);
  if (options.sessionsFile) options.sessionsFile = resolve(options.sessionsFile);
  return options;
}

function sessionIds(db, path) {
  if (!path) return null;
  let ids;
  try {
    const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').trim();
    ids = text.startsWith('[') ? JSON.parse(text) : text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  } catch {
    throw new Error('Cannot read --sessions-file: expected a JSON array or one session id per line');
  }
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id.trim())) {
    throw new Error('Invalid --sessions-file: expected non-empty string IDs');
  }
  const exists = db.prepare('SELECT 1 FROM session_v2 WHERE id = ?');
  for (const id of new Set(ids)) {
    if (!exists.get(id)) throw new Error(`Unknown session id in --sessions-file: ${id}`);
  }
  return new Set(ids);
}

export function openAuditDb(path) {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (error) {
    throw new Error(`Cannot open OpenCode database at ${path}: ${error.message}`);
  }
  try {
    for (const [table, required] of [
      ['session_v2', ['id', 'parent_id', 'agent', 'time_created']],
      ['session_message', ['session_id', 'type', 'seq', 'data']],
    ]) {
      const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
      const missing = required.filter(column => !columns.has(column));
      if (missing.length) throw new Error(`${table} missing required columns: ${missing.join(', ')}`);
    }
    return db;
  } catch (error) {
    db.close();
    throw new Error(`Unsupported schema: ${error.message}`);
  }
}

export function classifyRunPath(path) {
  const normalized = path.replace(/[\\/]+/g, '/');
  const match = normalized.match(/(?:^|\/)\.mdd\/runs(?:\/(.*))?$/);
  if (!match) return null;
  const [run, ...children] = (match[1] ?? '').split('/');
  if (/^\d{8}-[a-z0-9-]+\.md$/.test(run) && !children.length) return { kind: 'run-file' };
  if (/^\d{8}-[a-z0-9-]+$/.test(run)) {
    if (children.length === 1 && children[0] === 'history.md') return { kind: 'history' };
    if (children[0] === 'evidence') return { kind: 'evidence' };
    const iteration = children.length === 2 && children[0].match(/^i([2-9]|[1-9]\d+)-[a-z0-9-]+$/);
    if (children.length === 1 || iteration) {
      const artifact = children.at(-1).match(/^\d{2,}[a-z]?-([a-z0-9]+)(?:[-.]|$)/);
      if (artifact) return { kind: 'artifact', iteration: iteration ? `I${iteration[1]}` : 'I1', actor: artifact[1] };
    }
  }
  return { kind: 'other-mdd' };
}

// Historical ctx2 categories. Keep their regexes and accounting separate from current layout.
function classify(p) {
  const inp = p.state?.input || {};
  const s = JSON.stringify(inp);
  const name = p.name;
  if (name === 'subagent' || name === 'task') return ['actor-report', 'subagent:' + (inp.agent || inp.subagent_type || '?')];
  if (name === 'execute') {
    const c = inp.code || '';
    if (/mem_save|mem_update/.test(c)) return ['mdd-bookkeeping', 'engram-save'];
    if (/mem_/.test(c)) return ['mdd-bookkeeping', 'engram-read'];
    return ['direct-work', 'execute'];
  }
  if (/^read$/i.test(name)) {
    const path = toolPath(p);
    if (RUNFILE.test(path) || /\.mdd[\\/]+runs[\\/]+[^\\/]+\.md$/.test(path)) return ['mdd-bookkeeping', 'read-run-file'];
    if (MDD.test(path)) return ['mdd-bookkeeping', 'read-artifact'];
    return ['direct-work', 'read-source'];
  }
  if (/edit|write|patch/i.test(name) && name !== 'todowrite') {
    if (MDD.test(s)) return ['mdd-bookkeeping', RUNFILE.test(s) ? 'write-run-file' : 'write-artifact'];
    return ['direct-work', 'edit-source'];
  }
  if (/shell|bash/i.test(name)) return MDD.test(s) ? ['mdd-bookkeeping', 'shell-mdd'] : ['direct-work', 'shell'];
  if (/grep|glob|list/i.test(name)) return MDD.test(s) ? ['mdd-bookkeeping', 'search-mdd'] : ['direct-work', 'search'];
  if (/web/i.test(name)) return ['direct-work', 'web'];
  if (name === 'skill') return ['host-overhead', 'skill-load'];
  if (name === 'question' || name === 'todowrite') return ['conversation', name];
  return ['other', 'tool:' + name];
}

function addTo(target, volume) {
  target.count++;
  target.volume += volume;
}

function measureCtx2(ctx, { type }, d) {
  const add = (bucket, kind, n) => {
    const key = `${bucket}/${kind}`;
    ctx.buckets[bucket].volume += n;
    ctx.total += n;
    addTo(ctx.subBuckets[key] ??= countVolume(), n);
  };
  if (type === 'compaction' && d.status === 'completed') add('conversation', 'compaction-summary', len(d.summary));
  if (type === 'user') add('conversation', 'user', len(d.text));
  if (type === 'system') add('host-overhead', 'system-notice', len(d.text));
  if (type === 'synthetic') {
    const t = d.text ?? '';
    if (/^<subagent/.test(t) || d.metadata?.source === 'subagent') add('actor-report', 'subagent-notice', t.length);
    else if (d.metadata?.instruction) add('host-overhead', 'instruction-file', t.length);
    else if (d.metadata?.source === 'shell') add(MDD.test(t.slice(0, 600)) ? 'mdd-bookkeeping' : 'direct-work', 'bg-shell', t.length);
    else add('other', 'synthetic', t.length);
  }
  if (type === 'assistant') {
    for (const p of d.content ?? []) {
      if (p.type === 'text') add('conversation', 'assistant-text', len(p.text));
      if (p.type === 'tool') add(...classify(p), len(p.state?.input) + outText(p.state).length);
    }
  }
}

function measureAgg(agg, { id }, messages, valid) {
  let prev = '', comp = 0;
  const runs = new Set();
  for (const [m, d] of valid) {
    for (const r of m.data.matchAll(/\.mdd[\\/]+runs[\\/]+(\d{8}-[a-z0-9-]+?)(?:\.md|[\\/])/g)) runs.add(r[1]);
    if (m.type === 'compaction' && m.data.includes('"completed"')) comp++;
    if (m.type === 'user') prev = 'user';
    if (m.type !== 'assistant') continue;
    for (const p of d.content ?? []) {
      if (p.type !== 'tool') continue;
      const path = toolPath(p);
      if (/^read$/i.test(p.name) && MDD.test(path)) {
        const rel = path.replace(/.*\.mdd[\\/]+runs[\\/]+/, '');
        const volume = outText(p.state).length;
        if (!/[\\/]/.test(rel)) addTo(agg.runFileReads, volume);
        else if (/[\\/]\d\d[a-z]?-/.test(rel)) {
          const kind = rel.replace(/^[^\\/]+[\\/]\d\d[a-z]?-/, '').split(/[-.]/)[0];
          const reads = agg.artifactReads;
          reads.count++;
          reads.byKind[kind] = (reads.byKind[kind] ?? 0) + volume;
          if (prev.startsWith('subagent')) reads.afterSubagent += volume;
          else reads.other += volume;
        }
      }
      prev = p.name;
    }
  }
  agg.runsPerSession[runs.size >= 4 ? '4+' : runs.size]++;
  if (runs.size >= 3) agg.sessionsWith3PlusRuns++;
  if (comp) agg.completedCompactions.push({ id, count: comp, runs: runs.size, messages: messages.length });
}

function measureLayout(layout, { type }, d) {
  if (type !== 'assistant') return;
  for (const p of d.content ?? []) {
    if (p.type !== 'tool' || !/^read$/i.test(p.name)) continue;
    const path = classifyRunPath(toolPath(p));
    if (!path) continue;
    const volume = outText(p.state).length;
    addTo(layout.reads[path.kind], volume);
    if (path.kind === 'artifact') {
      addTo(layout.artifactByIteration[path.iteration] ??= countVolume(), volume);
      addTo(layout.byKind[path.actor] ??= countVolume(), volume);
    }
  }
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isString = value => typeof value === 'string';
const optional = (value, check) => value === undefined || check(value);
const contentOf = (content, check) => optional(content, items => Array.isArray(items) && items.every(check));
const textEntry = entry => isRecord(entry) && optional(entry.text, isString);

function validAssistantPart(part) {
  if (!isRecord(part) || !isString(part.type)) return false;
  if (part.type === 'text') return textEntry(part);
  if (part.type !== 'tool') return true;
  if (!isString(part.name) || !optional(part.state, isRecord) ||
      !contentOf(part.state?.content, textEntry)) return false;

  // Input volume intentionally supports arbitrary JSON. Only fields used as
  // strings by the tool classifiers need a string shape.
  const input = part.state?.input;
  if (/^read$/i.test(part.name)) return optional(input?.path, isString) && optional(input?.filePath, isString);
  if (part.name === 'execute') return optional(input?.code, isString);
  if (part.name === 'subagent' || part.name === 'task') {
    return optional(input?.agent, isString) && optional(input?.subagent_type, isString);
  }
  return true;
}

function parseMessage({ type, data }) {
  const d = JSON.parse(data);
  if (!isString(data) || !isString(type) || !isRecord(d)) {
    throw new Error('Invalid message');
  }
  if ((['user', 'system', 'synthetic'].includes(type) && !textEntry(d)) ||
      (type === 'synthetic' && !optional(d.metadata, metadata =>
        isRecord(metadata) && optional(metadata.source, isString))) ||
      (type === 'compaction' && (!optional(d.status, isString) || !optional(d.summary, isString))) ||
      (type === 'assistant' && !contentOf(d.content, validAssistantPart))) {
    throw new Error('Invalid message content');
  }
  return d;
}

export function audit(db, options) {
  const ids = sessionIds(db, options.sessionsFile);
  const stat = statSync(options.db);
  const has = name => options.view === 'all' || options.view === name;
  const cohort = (min, excludesLegacyTools) => ({
    minMessages: options.minMessages ?? min,
    excludesLegacyTools, baseline: options.minMessages == null, count: 0, ids: [],
  });
  const views = {};
  if (has('agg')) views.agg = {
    cohort: cohort(40, true),
    artifactReads: { count: 0, afterSubagent: 0, other: 0, afterSubagentShare: null, byKind: Object.create(null) },
    runFileReads: countVolume(),
    runsPerSession: { 0: 0, 1: 0, 2: 0, 3: 0, '4+': 0 },
    sessionsWith3PlusRuns: 0, completedCompactions: [],
  };
  if (has('ctx2')) views.ctx2 = {
    cohort: cohort(120, false),
    total: 0,
    buckets: Object.fromEntries(['direct-work', 'mdd-bookkeeping', 'actor-report', 'host-overhead', 'conversation', 'other']
      .map(key => [key, { volume: 0, share: null }])),
    subBuckets: {},
  };
  if (has('layout')) views.layout = {
    label: 'current-layout classification (not a historical baseline)',
    cohort: { ...cohort(40, true), baseline: false },
    reads: Object.fromEntries(['run-file', 'artifact', 'history', 'evidence', 'other-mdd'].map(kind => [kind, countVolume()])),
    artifactByIteration: {},
    byKind: Object.create(null),
  };

  const sessions = db.prepare(`SELECT id FROM session_v2
    WHERE parent_id IS NULL AND agent = ? AND time_created > ? AND time_created <= ?
    ORDER BY id`).all(AGENT, options.since, options.until ?? Number.MAX_SAFE_INTEGER);
  const selectMessages = db.prepare('SELECT type, data FROM session_message WHERE session_id = ? ORDER BY seq');
  let skipped = 0;
  for (const session of sessions) {
    if (ids && !ids.has(session.id)) continue;
    const messages = selectMessages.all(session.id);
    const meetsThreshold = Object.entries(views).filter(([, view]) => messages.length >= view.cohort.minMessages);
    if (!meetsThreshold.length) continue;
    const legacy = messages.some(m => typeof m.data === 'string' &&
      (m.data.includes('"name":"mdd_status"') || m.data.includes('"name":"mdd_adapt"')));
    const selected = meetsThreshold.filter(([, view]) => !view.cohort.excludesLegacyTools || !legacy);
    if (!selected.length) continue;
    const valid = [];
    for (const message of messages) {
      try {
        valid.push([message, parseMessage(message)]);
      } catch {
        skipped++;
      }
    }
    for (const [name, view] of selected) {
      view.cohort.ids.push(session.id);
      view.cohort.count++;
      if (name === 'agg') measureAgg(view, session, messages, valid);
      else if (name === 'ctx2') for (const [m, d] of valid) measureCtx2(view, m, d);
      else for (const [m, d] of valid) measureLayout(view, m, d);
    }
  }
  if (views.agg) {
    const a = views.agg.artifactReads;
    a.afterSubagentShare = share(a.afterSubagent, a.afterSubagent + a.other);
    a.byKind = { ...a.byKind };
  }
  if (views.ctx2) {
    for (const bucket of Object.values(views.ctx2.buckets)) bucket.share = share(bucket.volume, views.ctx2.total);
  }
  if (views.layout) views.layout.byKind = { ...views.layout.byKind };
  return {
    definition: 'context-audit/1',
    units: 'utf16-code-units',
    provenance: {
      dbPath: options.db, dbSize: stat.size, dbMtimeMs: stat.mtimeMs, generatedAt: new Date().toISOString(),
      agent: AGENT, rootOnly: true, since: options.since, until: options.until, minMessages: options.minMessages,
      sessionsFile: options.sessionsFile, requestedIds: ids && [...ids], complete: skipped === 0, skipped,
    },
    views,
    limits: [
      'Filesystem metrics are unavailable from the DB (run size, log count, NN collisions, directory size).',
      'Volumes are not bytes, tokens, live occupancy or a measure of token savings.',
      'afterSubagent means the preceding tool, not a proven purpose. Mentions do not prove runs were active.',
      'agg and ctx2 use distinct historical cohorts. layout uses the agg cohort rules with current path classification.',
      'Live data is not the original frozen historical cohort.',
    ],
  };
}

export function main(argv, io = process) {
  let db;
  let result;
  try {
    const options = parseArgs(argv);
    db = openAuditDb(options.db);
    result = audit(db, options);
  } catch (error) {
    io.stderr.write(`Context audit: ${error.message}\n`);
    return 2;
  } finally {
    db?.close();
  }
  io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.provenance.complete) {
    io.stderr.write(`Context audit: partial results; skipped ${result.provenance.skipped} malformed message row(s)\n`);
    return 1;
  }
  return 0;
}

const isEntry = () => {
  try {
    return Boolean(process.argv[1]) && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isEntry()) process.exitCode = main(process.argv.slice(2));
