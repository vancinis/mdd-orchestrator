import fs from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { scopedPath } from './safe-paths.js';

export const RUN_ID = /^\d{8}-[a-z0-9][a-z0-9-]*$/;
export const RUN_FILE_READ_LIMIT = 4 * 1024 * 1024;
export const NOW_INJECT_LIMIT = 32_000;

type Candidate = { id: string; position: number };
export type RunRead =
  | { state: 'active'; now: string | null }
  | { state: 'closed' }
  | { state: 'unknown'; reason: string };
type Resolution =
  | { kind: 'none' }
  | { kind: 'run'; id: string; others: string[] }
  | { kind: 'unreadable'; id: string; reason: string }
  | { kind: 'ambiguous'; ids: string[] };

type Message = {
  readonly role: string;
  readonly content: readonly {
    readonly type: string;
    readonly name?: string;
    readonly input?: unknown;
  }[];
};

const runPath = (id: string) => `.mdd/runs/${id}.md`;
const CHECKPOINT_HEADER = 'MDD run checkpoint, read from disk at compaction. Reproduce this block verbatim near the top of the summary:';
const FALLBACK_INSTRUCTION = 'MDD run checkpoint from compaction. Reproduce the preceding marker and this line verbatim near the top of the summary.';

export function runFileTargets(name: string, input: unknown, directory: string): string[] {
  if (!input || typeof input !== 'object') return [];
  const args = input as Record<string, unknown>;
  let targets: unknown[];
  if (name === 'write' || name === 'edit' || name === 'multiedit') {
    targets = [args.path ?? args.filePath];
  } else if ((name === 'patch' || name === 'apply_patch') && typeof args.patchText === 'string') {
    targets = [...args.patchText.matchAll(/^\*\*\* (?:Add File|Update File|Move to): (.+)$/gm)].map((match) => match[1]);
  } else {
    return [];
  }
  const runs = resolve(directory, '.mdd/runs');
  const ids = new Set<string>();
  for (const target of targets) {
    if (typeof target !== 'string' || !target || /[\x00-\x1f*?]/.test(target)) continue;
    const absolute = resolve(directory, target);
    if (relative(runs, dirname(absolute))) continue;
    const entry = relative(runs, absolute);
    if (!entry.endsWith('.md')) continue;
    const id = entry.slice(0, -3);
    if (RUN_ID.test(id)) ids.add(id);
  }
  return [...ids];
}

export function runCandidates(messages: readonly Message[], directory: string): Candidate[] {
  const positions = new Map<string, number>();
  messages.forEach(({ role, content }, position) => {
    for (const part of content) {
      const ids = part.type === 'tool-call' && role === 'assistant' && typeof part.name === 'string'
        ? runFileTargets(part.name, part.input, directory)
        : [];
      for (const id of ids) positions.set(id, position);
    }
  });
  return [...positions].map(([id, position]) => ({ id, position }));
}

export function extractCheckpoint(text: string): { status?: string; now?: string } {
  const frontMatter = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(text);
  const header = frontMatter?.index === 0 ? frontMatter : undefined;
  const status = /^status:[ \t]*([a-z-]+)[ \t]*(?:#[^\r\n]*)?\r?$/m.exec(header?.[1] ?? '')?.[1];
  const body = text.slice(header?.[0].length ?? 0);
  const heading = /^## Now[ \t]*\r?$/m.exec(body);
  const result: { status?: string; now?: string } = status ? { status } : {};
  if (heading) {
    const afterHeading = heading.index + heading[0].length;
    const end = /^## /m.exec(body.slice(afterHeading));
    result.now = body.slice(heading.index, end ? afterHeading + end.index : undefined);
  }
  return result;
}

export function readRun(directory: string, id: string): RunRead {
  if (!RUN_ID.test(id)) return { state: 'unknown', reason: 'invalid run id' };
  try {
    const path = scopedPath(directory, runPath(id));
    const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) return { state: 'unknown', reason: 'unsafe run file' };
      if (stat.size > RUN_FILE_READ_LIMIT) return { state: 'unknown', reason: 'run file exceeds 4 MiB' };
      // Do not read to EOF unbounded: the file can grow after the size check.
      const bytes = Buffer.alloc(stat.size);
      let count = 0;
      while (count < bytes.length) {
        const read = fs.readSync(fd, bytes, count, bytes.length - count, null);
        if (!read) break;
        count += read;
      }
      const after = fs.fstatSync(fd);
      if (count !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
        return { state: 'unknown', reason: 'run file changed during read' };
      }
      const { status, now } = extractCheckpoint(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)));
      if (status === 'active') return { state: 'active', now: now ?? null };
      if (status === 'completed' || status === 'closed-unverified' || status === 'abandoned') return { state: 'closed' };
      return { state: 'unknown', reason: 'missing or unrecognized front matter status' };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { state: 'unknown', reason: 'run file missing, unsafe, or unreadable' };
  }
}

export function resolveActiveRun(
  candidates: readonly (Candidate & { state: RunRead['state']; reason?: string })[],
): Resolution {
  const remaining = candidates.filter(({ state }) => state !== 'closed');
  const [first] = remaining;
  if (!first) return { kind: 'none' };
  if (remaining.length === 1 && first.state === 'unknown') {
    return { kind: 'unreadable', id: first.id, reason: first.reason ?? 'unknown run status' };
  }
  const newest = remaining.reduce((position, candidate) => Math.max(position, candidate.position), first.position);
  const atNewest = remaining.filter(({ position }) => position === newest);
  const [selected] = atNewest;
  if (atNewest.length === 1 && selected?.state === 'active') {
    return { kind: 'run', id: selected.id, others: remaining.filter((item) => item !== selected).map(({ id }) => id) };
  }
  return { kind: 'ambiguous', ids: remaining.map(({ id }) => id) };
}

export function checkpointText(resolution: Resolution, run?: RunRead): string | undefined {
  if (resolution.kind === 'none') return undefined;
  if (resolution.kind === 'ambiguous') {
    return `MDD candidate runs: ${resolution.ids.join(', ')}\n${FALLBACK_INSTRUCTION}\n`
      + 'The current MDD run is not certain; no `## Now` is included. After compaction, reread these run files and confirm with the user which run continues.';
  }
  const path = `\`${runPath(resolution.id)}\``;
  const marker = `MDD active run: ${resolution.id}`;
  if (resolution.kind === 'unreadable' || run?.state !== 'active') {
    const reason = resolution.kind === 'unreadable' ? resolution.reason
      : run?.state === 'unknown' ? run.reason : 'active checkpoint unavailable';
    return `${marker}\n${FALLBACK_INSTRUCTION}\nIts run file could not be read safely at compaction (${reason}); reread ${path} before continuing.`;
  }
  const others = resolution.others.length
    ? `\nOther run candidates in this session: ${resolution.others.join(', ')}` : '';
  if (run.now === null) return `${marker}\n${FALLBACK_INSTRUCTION}\nThis run has no \`## Now\`; resume from its sections and log.${others}`;
  if (run.now.length > NOW_INJECT_LIMIT) {
    return `${marker}\n${FALLBACK_INSTRUCTION}\nIts \`## Now\` is ${run.now.length} characters, above MDD's ${NOW_INJECT_LIMIT}-character safety bound, so it is not included; reread ${path} before continuing.${others}`;
  }
  return `${CHECKPOINT_HEADER}\n${marker} (${path})\n${run.now}${run.now.endsWith('\n') ? '' : '\n'}`
    + (others ? `${others.trimStart()}\n` : '')
    + "After compaction, reread the run file's front matter and `## Now`, then rewrite `## Now`, before continuing.";
}
