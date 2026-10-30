import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scopedPath } from './safe-paths.js';
import { MODEL_ROLES, agentFor } from './settings.js';

export const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Shared guides composed into the agents at install time. They are never installed on their own. */
export const MDD_CONTRACTS = Object.freeze([
  'assets/opencode/contracts/workflow.md',
  'assets/opencode/contracts/run-file.md',
  'assets/opencode/contracts/actor.md',
]);

/** Assets installed into the user's OpenCode config, where the host resolves them by name. */
export const MDD_ASSETS = Object.freeze([
  ...MODEL_ROLES.map(role => `assets/opencode/agents/${agentFor(role)}.md`),
  'assets/opencode/skills/mdd-cleanup/SKILL.md', 'assets/opencode/skills/mdd-doc/SKILL.md',
  'assets/opencode/skills/mdd-pr-body/SKILL.md',
  'assets/opencode/skills/mdd-pr-body/assets/template.md',
  'assets/opencode/skills/mdd-judgment-day/SKILL.md',
  'assets/opencode/skills/mdd-judgment-day/references/prompts-and-formats.md',
  'assets/opencode/skills/mdd-grill/SKILL.md', 'assets/opencode/skills/mdd-grill/NOTICE',
]);

export const MDD_PACKAGED_ASSETS = Object.freeze([...MDD_ASSETS, ...MDD_CONTRACTS]);

type Asset = { path: string; content: string; digest: string };
const digestOf = (text: string) => createHash('sha256').update(text).digest('hex');

/** `max` is optional: without it the asset is read whole, with no size limit. */
export function assetText(root: string, name: string, max?: number): Asset {
  const path = scopedPath(root, name);
  const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) throw new Error(`Asset is not a safe regular file: ${name}.`);
    if (max !== undefined && info.size > max) throw new Error(`Asset exceeds its size limit: ${name} (${info.size} bytes; maximum ${max}).`);
    const bytes = fs.readFileSync(fd);
    if (max !== undefined && bytes.length > max) throw new Error(`Asset exceeds its size limit: ${name} (maximum ${max} bytes).`);
    return { path: name, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes), digest: createHash('sha256').update(bytes).digest('hex') };
  } finally { fs.closeSync(fd); }
}

const INCLUDE = /<!-- mdd:include (contracts\/[a-z0-9-]+\.md) -->/g;

/**
 * The exact text MDD installs for a packaged asset: agent files have their contract markers
 * replaced by the contract text, so each installed agent is self-contained and readable.
 */
export function installedAsset(packageRoot: string, name: string): Asset {
  const source = assetText(packageRoot, name);
  if (!name.startsWith('assets/opencode/agents/')) return source;
  const content = source.content.replace(INCLUDE, (_marker, contract: string) => {
    const path = `assets/opencode/${contract}`;
    if (!MDD_CONTRACTS.includes(path)) throw new Error(`Unknown MDD contract in ${name}: ${contract}`);
    return assetText(packageRoot, path).content.trimEnd();
  });
  return { path: name, content, digest: digestOf(content) };
}

/** Where a packaged asset lives under the OpenCode config root. */
export function installedName(name: string): string {
  return name.replace('assets/opencode/', '');
}
