# Project skills

The active orchestrator governs work and permissions. These project-local skills provide
task instructions, not additional authority or automatic workflow dispatch.

| Skill name | Trigger | Source |
|---|---|---|
| `mdd-pr-body` | User PR request or pull request body | `assets/opencode/skills/mdd-pr-body/SKILL.md` |
| `mdd-cleanup` | Scoped cleanup, redundant abstractions or overengineering | `assets/opencode/skills/mdd-cleanup/SKILL.md` |
| `mdd-doc` | Writing a guide, report or artifact a reader must scan and verify | `assets/opencode/skills/mdd-doc/SKILL.md` |

Load the matching skill explicitly by its exported name when applicable. Drafting a PR
does not authorize commit, push or publication. Keep changes within the approved scope.
