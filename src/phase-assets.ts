import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PHASES } from './policy.js';
import type { Phase } from './policy.js';
import { fileDigest } from './safe-paths.js';

/** Rejects anything that is not one of the eight workflow phases, including actors like `mdd-risk` or `orchestrator`. */
export function phaseName(value: string): Phase {
  if (!PHASES.includes(value as Phase)) throw new Error('Unknown MDD phase.');
  return value as Phase;
}

export type PackagedSkill = { path: string; digest: string; content: string };
export type PackagedSkillName = 'mdd-cleanup' | 'mdd-doc' | 'cognitive-doc-design';
/**
 * Validates the packaged skill and returns its path. A phase actor reads this path directly with
 * its own read tool rather than receiving the body by value: the content used to be JSON-escaped
 * into every prompt that needed it, which paid its full byte cost twice — once for the
 * orchestrator handing off the task, once for the actor holding the same text in context. The
 * path costs one line and the skill stays exactly as reachable, because resolving it by name
 * would still hit the shared registry, where a same-named skill from another tool answers first.
 */
export function packagedSkillPath(name: PackagedSkillName): string {
  const path = fileURLToPath(new URL(`../assets/opencode/skills/${name}/SKILL.md`, import.meta.url));
  const digest = fileDigest(path);
  if (digest === 'absent') throw new Error(`The packaged ${name} skill is missing. Restore the MDD installation.`);
  const content = fs.readFileSync(path, 'utf8');
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
  if (Buffer.byteLength(content) > 16000 || !front || !front[1]!.split(/\r?\n/).includes(`name: ${name}`)) {
    throw new Error(`Invalid local ${name} skill.`);
  }
  return path;
}
const DOC_SKILLS: readonly PackagedSkillName[] = ['mdd-doc', 'cognitive-doc-design'];
/**
 * The packaged skills each phase may find useful, named by direct path rather than injected by
 * value. Phases whose artifact is prose a person reads get both documentation skills; Apply gets
 * the cleanup skill; Tasks carries structure only and gets none. The prompt hint and the visual
 * status both read this one map, so what the user sees is what the actor is offered.
 */
export const PHASE_SKILLS: Readonly<Record<Phase, readonly PackagedSkillName[]>> = {
  'mdd-explore': DOC_SKILLS, 'mdd-plan': DOC_SKILLS, 'mdd-propose': DOC_SKILLS, 'mdd-spec': DOC_SKILLS,
  'mdd-design': DOC_SKILLS, 'mdd-verify': DOC_SKILLS, 'mdd-tasks': [], 'mdd-apply': ['mdd-cleanup'],
};
/** The skills offered to a phase by path, as shown in the visual status. */
export function injectedSkillNames(phase: Phase): readonly string[] {
  return PHASE_SKILLS[phase];
}

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
