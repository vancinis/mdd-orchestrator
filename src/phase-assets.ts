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
/** The prose phases inject both document skills; Tasks intentionally injects neither. */
export const DOC_PHASES: readonly Phase[] = ['mdd-explore', 'mdd-plan', 'mdd-propose', 'mdd-spec', 'mdd-design', 'mdd-verify'];
export function injectedSkillNames(phase: Phase): readonly string[] {
  return phase === 'mdd-apply' ? ['mdd-cleanup'] : DOC_PHASES.includes(phase) ? ['mdd-doc', 'cognitive-doc-design'] : [];
}
/**
 * The upstream community skill, shipped verbatim under its own Apache-2.0 notice and delivered
 * beside `mdd-doc` rather than instead of it. `mdd-doc` holds the rules that are specific to an
 * MDD artifact — the appended links section, the artifact byte limit, the read-only phases — and
 * this one holds the general cognitive-load patterns a reader of any document benefits from. Both
 * travel by value: resolving either by name would reach the shared registry, where a same-named
 * skill from another tool answers first.
 */
export function cognitiveDocInstructions(): PackagedSkill { return packagedSkill('cognitive-doc-design'); }

/**
 * MDD's own actor instructions. The host prepends whatever `AGENTS.md` and `instructions` files
 * it finds to every agent it runs, and a plugin cannot take them away. What it can do is say
 * which text governs the phase, and deliver that text itself: packaged, digested, and injected
 * by value, so the instructions an MDD phase answers to are MDD's and are the same every run.
 */
export function mddInstructions(): PackagedSkill {
  // Deliberately not named AGENTS.md. The host discovers files with that name and prepends them
  // to agents working anywhere near them, which would make MDD's own instructions leak into
  // unrelated sessions — the exact behaviour this text exists to push back against.
  const path = fileURLToPath(new URL('../assets/opencode/mdd-instructions.md', import.meta.url));
  const digest = fileDigest(path);
  if (digest === 'absent') throw new Error('The packaged MDD actor instructions are missing. Restore the MDD installation.');
  const content = fs.readFileSync(path, 'utf8');
  if (Buffer.byteLength(content) > 16000 || !content.startsWith('# MDD actor instructions')) {
    throw new Error('Invalid packaged MDD actor instructions.');
  }
  return { path, digest, content };
}
