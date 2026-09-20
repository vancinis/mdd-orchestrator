# Working on MDD

This file is for agents working **on** this repository. It is not the instruction set MDD gives
the actors it dispatches: those are packaged at `assets/opencode/mdd-instructions.md` and are
delivered inside each phase prompt by value, with a digest, so no file of any name can replace
them.

## Project skills

These project-local skills provide task instructions, not additional authority or automatic
workflow dispatch.

| Skill name | Trigger | Source |
|---|---|---|
| `mdd-pr-body` | User PR request or pull request body | `assets/opencode/skills/mdd-pr-body/SKILL.md` |
| `mdd-cleanup` | Scoped cleanup, redundant abstractions or overengineering | `assets/opencode/skills/mdd-cleanup/SKILL.md` |
| `mdd-doc` | Writing a guide, report or artifact a reader must scan and verify | `assets/opencode/skills/mdd-doc/SKILL.md` |
| `cognitive-doc-design` | General document-design patterns, alongside `mdd-doc` | `assets/opencode/skills/cognitive-doc-design/SKILL.md` |

Read the file at the path named above rather than resolving the skill by name. A bare name
resolves against the shared registry, where a same-named skill from another tool may answer
instead — which is exactly the failure MDD's own by-value injection exists to prevent.

`cognitive-doc-design` is upstream Apache-2.0 material kept verbatim under its own `NOTICE`, and
it is the one packaged skill MDD never installs into the shared skills directory: that name is
widely taken, so a copy written there would collide with the user's own. Documentary phases
receive it by value beside `mdd-doc`, which wins wherever the two disagree about an MDD artifact.

Drafting a PR does not authorize commit, push or publication. Keep changes within the approved
scope.
