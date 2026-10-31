# Working on MDD

This file is for agents working **on** this repository. It is not what MDD's own agents follow:
those read the contracts in `assets/opencode/contracts/`, which the installer composes into each
agent file under `assets/opencode/agents/`.

## Orientation

- Read [docs/architecture.md](docs/architecture.md) first. MDD 0.2 is agents plus Markdown
  contracts; the only runtime tool is `mdd_jd_inspect` (Judgment Day judges).
- Behavior lives in `assets/opencode/contracts/*.md` and `assets/opencode/agents/*.md`. Most
  improvements are edits to those files, not code.
- `src/` holds only the plugin (`opencode-plugin.ts`, `judgment-day.ts`) and the installer/CLI.
  Do not add a tool unless it guarantees something a contract cannot; say why in the PR.
- `docs/history/` is historical. Do not update it to describe current behavior.

## Project skills

These project-local skills provide task instructions, not additional authority.

| Skill name | Trigger | Source |
|---|---|---|
| `mdd-pr-body` | User PR request, pull request body, branch name or commit message | `assets/opencode/skills/mdd-pr-body/SKILL.md` |
| `mdd-cleanup` | Scoped cleanup, redundant abstractions or overengineering | `assets/opencode/skills/mdd-cleanup/SKILL.md` |
| `mdd-doc` | Writing a guide, report or artifact a reader must scan and verify | `assets/opencode/skills/mdd-doc/SKILL.md` |
| `mdd-judgment-day` | Explicit request for judgment-day, judgment day or judment-day on a concrete target | `assets/opencode/skills/mdd-judgment-day/SKILL.md` |
| `mdd-grill` | Explicit request to be questioned first, or a large change with many open decisions | `assets/opencode/skills/mdd-grill/SKILL.md` |

Read the file at the path named above rather than resolving the skill by name: a bare name can
resolve to a same-named skill from another tool.

## Checks

```powershell
npm run typecheck
npm test
```

User-facing text (README, docs, CLI, installer) is Spanish; contracts, agent prompts and code
comments are English. Drafting a PR does not authorize commit, push or publication. Keep changes
within the approved scope.
