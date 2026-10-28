---
name: mdd-grill
description: "Trigger: high-assessment new capability with open decisions before mdd_adapt entry, or an explicit request to be grilled or questioned first. Resolve decisions in rounds before the contract."
license: MIT
metadata:
  author: "mdd-maintainers"
  version: "1.0"
---

## Activation Contract

Coordinator-only, before the first `mdd_adapt` entry of a fresh implementation request, with no
task in flight, no MDD question pending and no active MDD run in this conversation; a closed one
is fine: MDD refuses questions it did not issue while a run is active. Offer it when your own draft
assessment has complexity or impact `high` for a new capability and the draft would still carry
more than three `productQuestions` or `context.technical: "uncertain"`. An explicit user request
to be grilled or questioned first also activates it. Never for information-only requests,
delivery, continuing recorded work, failed-Verify recovery or an admitted run. Adapted from the
mattpocock/skills `grilling` and `domain-modeling` skills under MIT; see `NOTICE`.

## Hard Rules

- The session is clarification. It grants no mode, approval, operation consent or implementation
  authority and writes no file; MDD still validates and approves the contract it shapes.
- Run every round with the native question tool in this same turn: entry binds the latest native
  user message without an extra question. After a chat reply the request is earlier, and MDD
  confirms it once natively before admission. Entry reads only the latest 100 native messages, so
  keep the session to a few rounds.
- Facts are yours, decisions are the user's. Read sources, or settle a foreground
  `mdd_contextual_explore` first, for anything the repository can answer; never ask the user for
  it, and never ask while a task is in flight.
- Every question, option, description and summary is Spanish; the contract stays English; the
  user's own words are quoted verbatim.
- Declining or cancelling leaves the ordinary entry and its `productQuestions` unchanged.

## Decision Gates

| Condition | Action |
|---|---|
| Activation met, no explicit request | Ask the offer once. |
| This conversation holds an active MDD run | No session; suggest a new conversation for one. |
| A session question is refused | Stop without retrying or rephrasing; continue with the ordinary entry. |
| Explicit request | Skip the offer; ask only whether to add documentation. |
| `Seguir sin sesión` or `Cancelar` | Continue with the ordinary entry. |
| User leaves the form and writes in chat | Keep what was resolved and the original request as the objective; never ask them to resend it. MDD asks one native confirmation at entry. |
| Five rounds done, or answers ask to stop | Ask whether to continue or close with the rest as `productQuestions` or stated assumptions. |
| Decisions reveal several independent objectives | Propose splitting before entry; the user chooses. |

## Execution Steps

1. Offer once with header `Sesión de preguntas` and three options: `Sesión de preguntas`,
   `Sesión con documentación` (also records glossary terms and ADRs) and `Seguir sin sesión`.
   Append ` (Recomendada)` to the documentation option when the repository already keeps
   `GLOSSARY.md`, `GLOSSARY-MAP.md` or ADRs, otherwise to `Sesión de preguntas`.
2. Map the request as a design tree: each decision branches into the decisions that depend on it.
   The frontier is every open decision whose prerequisites are settled.
3. Ask the whole frontier in one native question call, at most eight questions. The form cannot
   scroll, so first write each question's context in the chat, then ask: a header of at most 30
   characters, one direct question, two to six options with a one-sentence description, the
   recommended one first with ` (Recomendada)`, and `multiple` only when choices combine. Word it
   so choosing the recommendation accepts it. A question that depends on another open one waits.
4. Recompute the frontier from the answers, including branches a free-text answer opens, and ask
   the next round. Stop when the frontier is empty: no branch unvisited, nothing silently assumed.
5. Write a Spanish summary of the decisions, exclusions, acceptance scenarios and any
   documentation in the chat, then ask briefly: `Confirmar y seguir`, `Corregir algo` or
   `Cancelar`. Draft the contract only after confirmation.

## Output Contract

Draft the ordinary `mdd_adapt` entry from the confirmed summary, in complete Spanish sentences the
user will read, and without a transcript:

- each decision → `decisions[]`, linked to the requirements it shapes;
- out of scope → `exclusions[]`, one entry per exclusion;
- behaviour → `acceptance.requirements[].scenarios` as given/when/then;
- `productQuestions` → only what stays genuinely open.

MDD then asks mode when unset and, in interactive mode, operation approval, as usual.

## Documentation Option

Only when chosen. Read the existing glossary and ADR directory first and follow their location,
format and numbering; without them use a root `GLOSSARY.md` and `docs/adr/NNNN-slug.md`.

- Ask in the rounds: challenge a term that conflicts with the glossary, propose one canonical term
  for a fuzzy or overloaded word, probe boundaries with concrete edge-case scenarios, and name
  contradictions between the user's statements and the code.
- Glossary entry: a project-specific term, one or two sentences of what it is, and `_Avoid_:`
  synonyms; no implementation details.
- ADR: only when the decision is hard to reverse, surprising without context and the result of a
  real trade-off. One paragraph: context, decision and why.
- When something qualifies, the contract adds one requirement with its scenarios, the exact paths
  in `scope.writes` (MDD fingerprints them, `null` for a new file) and an assignment that writes
  them: Apply writes, Verify checks. When nothing qualifies, create nothing.
