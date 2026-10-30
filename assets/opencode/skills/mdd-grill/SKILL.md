---
name: mdd-grill
description: "Trigger: large new capability with many open decisions before an MDD run, or an explicit request to be questioned first. Resolve decisions in rounds before writing the run file."
license: MIT
metadata:
  author: "mdd-maintainers"
  version: "2.0"
---

## Activation Contract

Coordinator only, before starting a fresh MDD run. Offer it once when your own assessment is high
complexity or impact for a new capability and many decisions are still open (more than three, or
the technical approach is uncertain). An explicit request to be questioned first activates it
directly. Never for information requests, delivery, continuing recorded work or an active run.
Adapted from the mattpocock/skills `grilling` and `domain-modeling` skills under MIT; see `NOTICE`.

## Hard Rules

- The session clarifies; it writes no project file and grants no approval by itself.
- Facts are yours, decisions are the user's. Read the sources (or dispatch `mdd-explore`) for
  anything the repository can answer; never ask the user for it.
- Every question, option, description and summary is in Spanish; the run file stays in English;
  the user's own words are quoted verbatim.
- Native question forms cannot scroll: put each question's context in the chat first, then ask.
- If the user leaves the form and answers in chat, take the answer and carry on.
- Declining or cancelling leaves the ordinary run start unchanged.

## Decision Gates

| Condition | Action |
|---|---|
| Activation met, no explicit request | Ask the offer once. |
| Explicit request | Skip the offer; ask only whether to add documentation. |
| `Seguir sin sesión` or `Cancelar` | Start the run normally. |
| Five rounds done, or the user wants to stop | Ask whether to continue or close with the rest as open questions or stated assumptions. |
| Decisions reveal several independent objectives | Propose splitting into several runs; the user chooses. |

## Execution Steps

1. Offer once with header `Sesión de preguntas` and three options: `Sesión de preguntas`,
   `Sesión con documentación` (also records glossary terms and ADRs) and `Seguir sin sesión`.
   Mark ` (Recomendada)` on the documentation option when the repository already keeps a glossary
   or ADRs, otherwise on `Sesión de preguntas`.
2. Map the request as a decision tree: each decision branches into the decisions that depend on
   it. The frontier is every open decision whose prerequisites are settled.
3. Ask the whole frontier in one native question call, at most eight questions: header of at most
   30 characters, one direct question, two to six options with a one-sentence description, the
   recommended one first with ` (Recomendada)`, `multiple` only when choices combine.
4. Recompute the frontier from the answers, including branches a free-text answer opens, and ask
   the next round. Stop when nothing is open and nothing was silently assumed.
5. Write a Spanish summary of decisions, exclusions, acceptance scenarios and any documentation,
   then ask: `Confirmar y seguir`, `Corregir algo` or `Cancelar`.

## Output Contract

After confirmation, create the run file from the summary:

- each decision → `## Decisions` (`D1`, `D2`, ...), noting which requirements it shapes;
- out of scope → `Out of scope` in `## Scope`;
- behavior → `## Acceptance` requirements with given/when/then scenarios;
- anything still open → `## Limits and open items`.

## Documentation Option

Only when chosen. Read the existing glossary and ADR directory first and follow their location,
format and numbering; without them use a root `GLOSSARY.md` and `docs/adr/NNNN-slug.md`.

- In the rounds: challenge terms that conflict with the glossary, propose one canonical term for a
  fuzzy word, probe boundaries with concrete edge cases, name contradictions with the code.
- Glossary entry: a project-specific term, one or two sentences, and `_Avoid_:` synonyms.
- ADR: only for a decision that is hard to reverse, surprising without context and the result of a
  real trade-off. One paragraph: context, decision and why.
- When something qualifies, add a requirement and a plan task that writes those files: Apply writes
  them, Verify checks them. When nothing qualifies, create nothing.
