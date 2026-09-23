---
name: mdd-pr-body
description: "Trigger: user PR request, pull request body. Draft an evidence-backed MDD PR description without granting push or PR creation authority."
license: MIT
metadata:
  author: "mdd-maintainers"
  version: "1.0"
---

## Activation Contract

Load when the user requests a PR or PR body. Draft only for the authorized change.

## Hard Rules

- The body is written in Spanish: it is read by a reviewer, not by MDD. Quoted commands, paths and identifiers stay verbatim.
- Recorded prose is English, so drafting takes two calls: ask for the text, translate it, send it back. Translate only — keep every number, path, identifier and command exactly, add no fact and drop none.
- Separate drafting from permission to commit, push or create a PR; obtain explicit authority for those actions.
- Use observed changes and verification evidence. Never invent tests, deployments, configuration or issue links.
- Keep all seven template headings in order. Write `No aplica.` for absent optional information; label unknown facts as unverified.
- `Resumen` says what the change delivers and what it enables. It never describes how the work was done: the per-file reasons already carry that.
- `Cambios` is one table row per changed file, saying why that file changed. The diff already lists the paths; the reason is what a reviewer cannot reconstruct.
- `Verificación` holds the check evidence, aggregated: what ran, what exited nonzero, what could not be shown. Verification prose belongs here and never under `Cambios`.
- Never add a notice saying the body is only a draft. Publication authority is reported to the caller, not to the reviewer, who needs the space for the change itself.
- Do not include credentials, private source excerpts or unrelated work.

## Decision Gates

| Evidence | Action |
|---|---|
| A file changed | One row: the path, and why that file had to change. |
| A changed file has no recorded reason | Say so in its row; never invent a plausible motive. |
| Checks executed | Report them aggregated under `Verificación`, counting the ones that cannot be printed. |
| A check exited nonzero | Name it under `Verificación` and block on it; never report only the successful ones. |
| Checks missing or failing | State limitations under `Bloqueos`; do not claim readiness. |
| Apply recorded no change summary | Fall back to the recorded goal and say that is what it is. |
| No environment or deployment changes | Use `No aplica.` in the respective section. |

## Execution Steps

1. Ask for the recorded text: call the draft tool without translations.
2. Translate each returned entry into Spanish, preserving every number, path, identifier and command.
3. Send the translations back with the digest you were given; a rejected set names each fault, so fix them together.
4. Return the rendered body as it is; execute publication only with separate explicit authority and native consent.

## Output Contract

Return the rendered Markdown body with Resumen, Cambios, Verificación, Variables de entorno,
Seguimiento, Bloqueos and Despliegue. Check evidence lives under `Verificación`. Print it verbatim:
it is rendered from recorded evidence, and never imply drafting published it.

## References

- [PR body template](assets/template.md)
