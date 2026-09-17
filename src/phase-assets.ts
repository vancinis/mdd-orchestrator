import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Phase } from './policy.js';
import { MODEL_ROLES } from './settings.js';
import { fileDigest } from './safe-paths.js';

export function phaseName(value: string): Phase {
  if (value === 'orchestrator' || !MODEL_ROLES.includes(value as Phase)) throw new Error('Unknown MDD phase.');
  return value as Phase;
}

export type PackagedSkill = { path: string; digest: string; content: string };
/**
 * Injects the exact packaged skill text with its path and digest, so a global skill of the same
 * name cannot shadow these instructions.
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
export function cleanupInstructions(): PackagedSkill { return packagedSkill('mdd-cleanup'); }
export function docInstructions(): PackagedSkill { return packagedSkill('mdd-doc'); }
