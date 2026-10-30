---
name: mdd-pr-body
description: "Trigger: user PR request, pull request body. Draft an evidence-backed PR description in Spanish without granting push or PR creation authority."
license: MIT
metadata:
  author: "mdd-maintainers"
  version: "2.0"
---

## Activation Contract

Load when the user asks for a PR or a PR body. Draft only for the change they mean.

## Sources

| Situation | Where the facts come from |
|---|---|
| There is an MDD run for the change | The run file `.mdd/runs/<id>.md` (request, decisions, plan, verification, limits) and its artifacts, plus `git diff <base>...HEAD --stat` for the file list. |
| Direct edit, no run | `git diff <base>...HEAD` and `git log <base>..HEAD`, where `<base>` is the PR target branch (ask if unclear). |

Read uncommitted changes with `git status` and mention them: they are not part of the PR until
committed.

## Hard Rules

- Write the body in Spanish: a reviewer reads it. Commands, paths and identifiers stay verbatim.
- Use the template in [assets/template.md](assets/template.md). Keep its seven headings in order and
  write `No aplica.` where nothing applies.
- `Resumen` says what the change delivers and what it enables, not how it was built.
- `Cambios` has one row per changed file with why that file changed. If you do not know why, say
  so in the row; never invent a motive.
- `Verificación` lists only checks that actually ran, with their results, including the ones that
  failed or could not run. Without a run and without checks you ran, say it was not verified.
- `Bloqueos` lists failing checks, open gaps and limits from the run. Never claim readiness that the
  evidence does not support.
- Optional groups `Contexto y decisiones`, `Riesgos y limitaciones` and `Notas para revisión` may
  follow, in that order, only when they have content. Label interpretation as such.
- Never include secrets, private source excerpts or unrelated work.
- Drafting does not authorize commit, push or opening the PR. Do those only when the user asks,
  using the body unchanged.

## Output Contract

Print the final Markdown body in a single fenced block so the user can copy it, then one line
saying it has not been published.
