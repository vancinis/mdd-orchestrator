import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scopedPath } from './safe-paths.js';
import { MODEL_ROLES } from './settings.js';
import { installationPaths } from './installation-paths.js';
import type { InstallationEnvironment } from './installation-paths.js';

export const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
/** Assets installed into the user's OpenCode config, where the host resolves them by name. */
export const MDD_ASSETS = Object.freeze([
  ...MODEL_ROLES.map(role => `assets/opencode/agents/${role === 'orchestrator' ? 'mdd-orchestrator' : role}.md`),
  'assets/opencode/skills/mdd-cleanup/SKILL.md', 'assets/opencode/skills/mdd-doc/SKILL.md',
  'assets/opencode/skills/mdd-pr-body/SKILL.md',
  'assets/opencode/skills/mdd-pr-body/assets/template.md',
]);
/**
 * Shipped in the package and never installed. MDD's actor instructions are read from the package
 * and injected into each phase prompt by value with their digest, so a copy in the shared config
 * directory would add nothing except a file someone could edit to change what a phase obeys.
 *
 * The upstream `cognitive-doc-design` skill is here for a second reason: it is a widely installed
 * community skill, so writing MDD's copy into the shared skills directory would either collide
 * with the user's own or be shadowed by it. A phase prompt offers its packaged path directly
 * instead, so the file an actor reads — if it reads one at all — is the one MDD ships, whatever
 * else answers to that name. Its NOTICE travels with it because the file stays verbatim
 * Apache-2.0 material inside an MIT package.
 */
export const MDD_PACKAGED_ASSETS = Object.freeze([...MDD_ASSETS, 'assets/opencode/mdd-instructions.md',
  'assets/opencode/skills/cognitive-doc-design/SKILL.md', 'assets/opencode/skills/cognitive-doc-design/NOTICE']);
export function assetText(root: string, name: string, max = 16000): { path: string; content: string; digest: string } {
  const path = scopedPath(root, name);
  const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > max) throw new Error('Asset is unsafe or too large.');
    const buffer = Buffer.alloc(max + 1);
    let size = 0;
    while (size < buffer.length) { const count = fs.readSync(fd, buffer, size, buffer.length - size, null); if (!count) break; size += count; }
    if (size > max) throw new Error('Asset exceeds its size limit.');
    const bytes = buffer.subarray(0, size);
    return { path: name, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes), digest: createHash('sha256').update(bytes).digest('hex') };
  } finally { fs.closeSync(fd); }
}

/**
 * Installed actor assets that no longer match the package running them. Setup already refuses to
 * install a mismatched package, but nothing checked the other direction at runtime: an upgraded
 * plugin next to an agent definition from an older release is a coordinator working from
 * instructions the adapter no longer speaks, and the only symptom is a run that behaves oddly for
 * reasons nobody can see. Naming the files is the whole fix; the plugin reports, and the user
 * decides whether to update.
 *
 * Only a file that exists and differs is reported. An absent one proves nothing here — running
 * from source is ordinary, and installation is setup's job, not a live run's — and an unreadable
 * one is reported as a difference, because a digest that cannot be taken cannot be trusted equal.
 */
export function staleAssets(environment?: InstallationEnvironment): string[] {
  const stale: string[] = [];
  let configRoot: string;
  try { configRoot = installationPaths(environment).configRoot; } catch { return []; }
  for (const name of MDD_ASSETS) {
    const installed = name.replace('assets/opencode/', '');
    let path: string;
    try {
      path = scopedPath(configRoot, installed);
      if (!fs.existsSync(path)) continue;
    } catch { continue; }
    try {
      if (assetText(configRoot, installed).digest !== assetText(PACKAGE_ROOT, name).digest) stale.push(installed);
    } catch { stale.push(installed); }
  }
  return stale;
}
