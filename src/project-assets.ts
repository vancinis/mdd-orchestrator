import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scopedPath } from './phase-policy.js';
import { MODEL_ROLES } from './settings.js';

export const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const MDD_ASSETS = Object.freeze([
  ...MODEL_ROLES.map(role => `assets/opencode/agents/${role === 'orchestrator' ? 'mdd-orchestrator' : role}.md`),
  'assets/opencode/skills/mdd-cleanup/SKILL.md', 'assets/opencode/skills/mdd-doc/SKILL.md',
  'assets/opencode/skills/mdd-pr-body/SKILL.md',
  'assets/opencode/skills/mdd-pr-body/assets/template.md',
]);
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
