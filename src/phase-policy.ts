import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { Phase } from './policy.js';
import { MODEL_ROLES } from './settings.js';
import { fileURLToPath } from 'node:url';

export const READ_TOOLS = ['read', 'glob', 'grep'];
export const EDIT_TOOLS = ['edit', 'write', 'apply_patch'];
export function phaseName(value: string): Phase {
  if (value === 'orchestrator' || !MODEL_ROLES.includes(value as Phase)) throw new Error('Unknown MDD phase.');
  return value as Phase;
}
export const BASH_PHASES = ['mdd-explore', 'mdd-apply', 'mdd-verify'];
/** Exploration may only look things up on GitHub; it never runs project code. */
export const LOOKUP_ONLY_PHASES = ['mdd-explore'];
export const GITHUB_READS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  issue: ['view', 'list'], pr: ['view', 'list', 'diff'], repo: ['view'], search: ['issues', 'prs'],
});
export const GITHUB_HINT = 'gh issue view|list, gh pr view|list|diff, gh repo view, gh search issues|prs';
export function allowedTool(phase: Phase, tool: string): boolean {
  return READ_TOOLS.includes(tool) || (phase === 'mdd-apply' && EDIT_TOOLS.includes(tool)) ||
    (BASH_PHASES.includes(phase) && tool === 'bash');
}
export function phasePermissions(phase: Phase, rules: Record<string, unknown>[]): void {
  const boundary = rules.findLastIndex(rule => rule.permission === '*' && rule.pattern === '*' && rule.action === 'deny');
  const outputRead = (rule: Record<string, unknown>) => rule.permission === 'external_directory' &&
    typeof rule.pattern === 'string' && isAbsolute(rule.pattern) && /[/\\]tool-output[/\\]\*$/.test(rule.pattern) &&
    !rule.pattern.slice(0, -1).includes('*') && rules.slice(0, boundary).some(prior =>
      prior.permission === rule.permission && prior.pattern === rule.pattern && prior.action === 'allow');
  if (boundary < 0 || rules.slice(boundary + 1).some(rule => {
    if (rule.action === 'deny') return false;
    if (rule.action === 'allow' && (READ_TOOLS.includes(String(rule.permission)) || outputRead(rule))) return false;
    // Lookup-only actors may skip native consent because the adapter already restricts their
    // commands to read-only GitHub lookups. Actors that run project code must stay on ask.
    if (rule.action === 'allow' && rule.permission === 'bash' && LOOKUP_ONLY_PHASES.includes(phase)) return false;
    return !(rule.action === 'ask' && ((phase === 'mdd-apply' && rule.permission === 'edit') ||
      (BASH_PHASES.includes(phase) && rule.permission === 'bash')));
  })) throw new Error('MDD phase permissions violate read-only or native-ask capability boundaries.');
}

export function scopedPath(root: string, value: unknown, directory = false): string {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f*?]/.test(value)) throw new Error('Invalid scoped path.');
  const path = resolve(root, value);
  const rel = relative(resolve(root), path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || (!directory && !rel)) throw new Error('Path is outside the approved root.');
  let current = parse(path).root;
  const parts = relative(current, path).split(sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.includes(':') || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)) throw new Error('Unsafe scoped path component.');
    current = join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) {
      if (directory) throw new Error('Working directory does not exist.');
      continue;
    }
    if (stat.isSymbolicLink() || (i < parts.length - 1 || directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) {
      throw new Error('Linked or nonregular scoped path.');
    }
  }
  return path;
}
export function fileDigest(path: string): string {
  if (!fs.existsSync(path)) return 'absent';
  const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1048576) throw new Error('Change evidence file is unsafe or exceeds 1 MiB.');
    return createHash('sha256').update(fs.readFileSync(fd)).digest('hex');
  } finally { fs.closeSync(fd); }
}
export type PackagedSkill = { path: string; digest: string; content: string };
/**
 * Injects the exact packaged skill text with its path and digest. Phases deny native skill
 * loading, so a global skill of the same name can never shadow these instructions.
 */
function packagedSkill(name: string): PackagedSkill {
  const path = fileURLToPath(new URL(`../assets/opencode/skills/${name}/SKILL.md`, import.meta.url));
  const digest = fileDigest(path);
  if (digest === 'absent') throw new Error(`The packaged ${name} skill is missing. Restore the MDD installation.`);
  const content = fs.readFileSync(path, 'utf8');
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
  if (Buffer.byteLength(content) > 16000 || !front || !front[1]!.split(/\r?\n/).includes(`name: ${name}`)) {
    throw new Error(`Invalid local ${name} skill.`);
  }
  return { path, digest, content };
}
export function cleanupInstructions(root: string): PackagedSkill { return packagedSkill('mdd-cleanup'); }
export function docInstructions(root: string): PackagedSkill { return packagedSkill('mdd-doc'); }
/** Shared command hygiene: one plain command, contained workdir, no composition or traversal. */
function commandWords(root: string, args: Record<string, unknown>): string[] {
  scopedPath(root, args.workdir === undefined ? root : args.workdir, true);
  const command = args.command;
  if (typeof command !== 'string' || !command.trim() || command.length > 8000 || /[\r\n;&|<>`$()]/.test(command)) {
    throw new Error('Use one plain project check command without shell composition or expansion.');
  }
  for (const raw of command.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []) {
    const token = raw.replace(/^["']|["']$/g, '').split('=').at(-1)!;
    if (/(^|[/\\])\.\.([/\\]|$)/.test(token)) throw new Error('Command path traversal is not authorized.');
    if (isAbsolute(token) || /^[a-z]:/i.test(token)) scopedPath(root, token);
  }
  return command.trim().split(/\s+/);
}
function executableOf(words: string[]): string {
  return words[0]!.replaceAll('"', '').replaceAll("'", '').split(/[/\\]/).at(-1)!.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}
/**
 * A GitHub lookup reads; it never writes. Subcommands are allowlisted and any flag that
 * could turn a query into a mutation or submit a body is refused.
 */
export function githubRead(words: string[]): boolean {
  if (executableOf(words) !== 'gh') return false;
  const verbs = GITHUB_READS[(words[1] ?? '').toLowerCase()];
  if (!verbs?.includes((words[2] ?? '').toLowerCase())) return false;
  return !words.some(word => /^(-X|--method|-F|--field|-f|--raw-field|--input|--template)$/i.test(word));
}
/** The coordinator's only command capability; it shares the phase hygiene and allowlist. */
export function assertGithubLookup(root: string, args: Record<string, unknown>): void {
  if (!githubRead(commandWords(root, args))) {
    throw new Error(`Only read-only GitHub lookups are authorized here: ${GITHUB_HINT}.`);
  }
}
export function toolTargets(root: string, phase: Phase, tool: string, args: Record<string, unknown>): string[] {
  if (!allowedTool(phase, tool)) throw new Error('MDD phase tool is not authorized; read-only phases permit only read, glob, grep.');
  if (tool === 'bash') {
    const words = commandWords(root, args);
    if (githubRead(words)) return [];
    if (LOOKUP_ONLY_PHASES.includes(phase)) {
      throw new Error(`This actor may run only read-only GitHub lookups: ${GITHUB_HINT}.`);
    }
    const command = String(args.command);
    const executable = executableOf(words);
    if (/\b(commit|push|publish|deploy|release|pr)\b/i.test(command) ||
        ['gh', 'hub', 'curl', 'wget', 'ssh', 'scp', 'powershell', 'pwsh', 'cmd', 'bash', 'sh', 'eval', 'iex', 'invoke-expression', 'invoke-webrequest', 'invoke-restmethod', 'iwr', 'irm', 'npx', 'pnpx', 'bunx', 'cd', 'chdir', 'set-location'].includes(executable) ||
        (['npm', 'pnpm', 'yarn', 'bun'].includes(executable) && words.some(word => ['install', 'add', 'update', 'upgrade', 'create', 'dlx'].includes(word.toLowerCase()))) ||
        (executable === 'git' && !['status', 'diff', 'log', 'show', 'ls-files'].includes(words[1] ?? ''))) {
      throw new Error('Delivery, network, shell wrappers, and directory-changing commands are not authorized.');
    }
    return [];
  }
  if (!EDIT_TOOLS.includes(tool)) return [];
  let paths: unknown[] = [args.filePath];
  if (tool === 'apply_patch') {
    if (typeof args.patchText !== 'string' || Buffer.byteLength(args.patchText) > 100000 ||
        !args.patchText.startsWith('*** Begin Patch\n') || !args.patchText.trimEnd().endsWith('*** End Patch')) throw new Error('Unknown patch envelope.');
    paths = [...args.patchText.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(match => match[1]);
    if (!paths.length) throw new Error('Patch has no scoped targets.');
  }
  if (paths.length > 64) throw new Error('Too many edit targets.');
  return [...new Set(paths.map(value => {
    const path = scopedPath(root, value);
    const rel = relative(root, path).replaceAll('\\', '/');
    if (/^(?:\.git|\.mdd|\.opencode)(?:\/|$)|^mdd\.config\.json$/i.test(rel)) throw new Error('Runtime control files are not phase edit targets.');
    return path;
  }))];
}
