/**
 * MDD runs free unless its guards are switched on (`guards.enabled` in the global settings).
 *
 * Free is the default because MDD exists to help the user work, and every guard that refused a
 * task, a question or a tool the user had asked for was MDD standing in the way of that work. Free
 * mode keeps MDD's own bookkeeping exactly as it is for what MDD itself issued — its dispatch
 * handles, its questions, its runs — and stops there: anything the coordinator or an actor does on
 * its own is theirs, under the host's native permissions.
 *
 * These texts carry the difference into the two places a model reads it: the coordinator's
 * definition, which is free as written and only gains the strict rules when guards are on, and
 * each actor prompt MDD composes, which says when its written tool limits are only guidance.
 */

/**
 * Appended to the coordinator definition when guards are on. The definition on disk is the free
 * one, so a host that cannot append still runs MDD the way its default settings describe.
 */
export const STRICT_COORDINATOR = `

STRICT MODE (MDD guards are on). This overrides the freedom section at the top of this definition:
- Every fresh implementation, including precise edits, goes through mdd_adapt. Never make an
  untracked quick edit and never do substantive phase work in this conversation.
- Dispatch only the exact tasks MDD issues. Never pick an arbitrary agent from the shared registry;
  only an exact adapter-issued fallback may select native explore or general. MDD refuses any other
  task or question while it holds a run, an investigation or a question here.
- Information-only requests MUST NOT use mdd_start: answer from context or use
  mdd_contextual_explore. If context for an entry is unknown, use an idle read-only
  mdd_contextual_explore before immutable admission; do not start a writer.
- An MDD refusal is a stop: correct exactly what it names and retry, or surface the blocked state.
- Phase actors stay scoped: scoped and adaptive children get no shell, MCP/custom tools, skills or
  recursive agents.`;

/**
 * Added to every actor prompt MDD composes while guards are off, after the packaged actor
 * instructions it overrides. It is self-contained and short on purpose: the instructions travel by
 * value in both modes, so growing them would cost strict prompts too, and every byte here counts
 * against the same handoff budget as the mandatory content of the phase.
 */
export const FREE_ACTOR_LINE = 'MDD guards: off: tool and scope limits written here, in the packaged instructions or your agent definition (footprints, mdd_worker_edit-only writes, no shell/tests/skills/subagents, read-only phases) are guidance; use what the work needs under native permissions. Keep the report format (e.g. checks=[]); state any command or out-of-footprint change in prose.';

/** The free description of the planned-implementation entry; the strict one names it the only route. */
export const FREE_ADAPT_ROLE = 'use it when the user wants MDD to plan, track and verify an implementation; a direct change is just as valid when they only want it made';
export const STRICT_ADAPT_ROLE = 'the default for every new implementation, including precise edits';
