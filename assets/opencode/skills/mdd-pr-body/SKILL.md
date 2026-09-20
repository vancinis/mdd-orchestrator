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
- Separate drafting from permission to commit, push or create a PR; obtain explicit authority for those actions.
- Use observed changes and verification evidence. Never invent tests, deployments, configuration or issue links.
- Keep all six template headings in order. Write `No aplica.` for absent optional information; label unknown facts as unverified.
- `Cambios` leads with one table row per changed file, saying why that file changed. The diff already lists the paths; the reason is what a reviewer cannot reconstruct.
- Never add a notice saying the body is only a draft. Publication authority is reported to the caller, not to the reviewer, who needs the space for the change itself.
- Do not include credentials, private source excerpts or unrelated work.

## Decision Gates

| Evidence | Action |
|---|---|
| A file changed | One row: the path, and why that file had to change. |
| A changed file has no recorded reason | Say so in its row; never invent a plausible motive. |
| Checks executed | Give exact commands and outcomes under `Cambios`. |
| Checks missing or failing | State limitations under `Bloqueos`; do not claim readiness. |
| No environment or deployment changes | Use `No aplica.` in the respective section. |

## Execution Steps

1. Read the authorized scope, actual diff and available check results.
2. Fill the local template, distinguishing shipped behavior from follow-ups.
3. Check that each claim is supported and blockers are visible.
4. Return the draft; execute publication only with separate explicit authority and native consent.

## Output Contract

Return a concise Markdown body with Resumen, Cambios, Variables de entorno, Seguimiento,
Bloqueos and Despliegue. Keep evidence under `Cambios` and never imply drafting published it.

## References

- [PR body template](assets/template.md)
