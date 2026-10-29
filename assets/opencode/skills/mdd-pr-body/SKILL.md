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
- Separate drafting from permission to commit, push or create a PR; obtain explicit authority for those actions. A user request naming them is that authority: deliver the recorded run as it is, without a new run or preflight.
- Use observed changes and verification evidence. Never invent tests, deployments, configuration or issue links.
- Keep all seven template headings in order. Write `No aplica.` for absent optional information; label unknown facts as unverified.
- `Resumen` says what the change delivers and what it enables. It never describes how the work was done: the per-file reasons already carry that.
- `Cambios` is one table row per changed file, saying why that file changed. The diff already lists the paths; the reason is what a reviewer cannot reconstruct.
- `Verificación` holds the check evidence, aggregated: what ran, what exited nonzero, what could not be shown. Verification prose belongs here and never under `Cambios`.
- Never add a notice saying the body is only a draft. Publication authority is reported to the caller, not to the reviewer, who needs the space for the change itself.
- Do not include credentials, private source excerpts or unrelated work.
- Incorporate relevant additional information through `additionalContext` before the final tool rendering, not by editing its output. Keep the seven base sections unchanged; only nonempty Contexto y decisiones, Riesgos y limitaciones and Notas para revisión groups may follow, in that order.
- Never auto-publish supplementary comments to bypass formatting restrictions. An explicitly requested comment remains a separate authorized action; drafting the body does not authorize one.
- Agent interpretation is useful Spanish motivation, tradeoffs, scope, reviewer guidance or followups, explicitly without independent verification. Attribution does not verify prose: never claim unobserved tests or deployments, override verification/blockers/readiness, or infer publication permission from context.

## Decision Gates

| Evidence | Action |
|---|---|
| A file changed | One row: the path, and why that file had to change. |
| A changed file has no recorded reason | Say so in its row; never invent a plausible motive. |
| Checks executed | Report them aggregated under `Verificación`, counting the ones that cannot be printed. |
| A check exited nonzero | Name it under `Verificación` and block on it; never report only the successful ones. |
| Checks missing or failing | State limitations under `Bloqueos`; do not claim readiness. |
| Apply recorded no change summary | Fall back to the recorded goal and say that is what it is. |
| No recorded run (a direct edit) | Pass the PR target branch as `baseRef`; git lists the files. Write the summary and one reason per listed file in Spanish; `Verificación` says MDD did not verify it. |
| No environment or deployment changes | Use `No aplica.` in the respective section. |
| Relevant goal or decisions already recorded | Select `source: 'recorded'` with `ref: 'goal'` or `'decisions'`; MDD resolves held text and decision IDs. Do not supply replacement text or imply independent verification. |
| A user supplied reviewer context | Use `source: 'user'` with `text` quoting a complete line of the authenticated latest user message. It stays unchanged, attributed and unverified. |
| Useful synthesis is not a recorded fact | Use `source: 'interpretation'` with one Spanish line of bounded, unverified interpretation; do not disguise it as user or recorded evidence. |

### Additional context input

`additionalContext` is an ordered array of at most 24 entries. Each uses `section: 'context'`,
`'risks'` or `'review'` and exactly one source shape:

```json
[
  {"section":"context","source":"recorded","ref":"decisions"},
  {"section":"review","source":"interpretation","text":"Revisar primero la validación del borde; la migración queda fuera del alcance."}
]
```

User and interpretation entries accept only `text` (1–1000 characters, one nonempty line), not
selectors. Recorded entries accept only `ref`, never `text`; they require a recorded run and
resolve its goal or all held decisions. Unknown fields, sources, selectors and sections fail.
No arbitrary Markdown appendix or new heading is accepted. Rendering applies the existing safety
filter to context too; do not include sensitive or unrelated content even with a source label.
The expanded request cannot exceed 128 translation keys: omit recorded selectors if it does.

## Execution Steps

1. Gather relevant context before final rendering. Ask for the recorded text: call the draft tool without translations, including any `additionalContext`. Without a recorded run, call it with `baseRef` instead; only user/interpretation context is allowed there.
2. Translate each returned entry into Spanish, preserving every number, path, identifier and command. For a direct edit, write the summary and one reason per listed file instead.
3. Send the translations back with the digest you were given and the original `additionalContext` unchanged, or the direct text with the same `baseRef`. With direct context, repeat its digest too. The returned normalized context is read-only metadata, not replacement input. A rejected set names each fault, so fix them together; changed context requires a fresh request.
4. Return the rendered body as it is; execute publication only with separate explicit authority and native consent.

## Output Contract

Return the rendered Markdown body with Resumen, Cambios, Verificación, Variables de entorno,
Seguimiento, Bloqueos and Despliegue. Check evidence lives under `Verificación`. Print it verbatim:
it is rendered from recorded evidence, and never imply drafting published it.
Optional nonempty context groups follow those base sections, retaining their source labels.
Without context the body and two-call protocol are unchanged. In direct mode the context digest
binds metadata and git target identity/file list, not file contents, prose truth or test evidence.

## References

- [PR body template](assets/template.md)
