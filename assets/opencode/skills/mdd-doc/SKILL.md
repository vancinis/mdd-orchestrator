---
name: mdd-doc
description: "Trigger: writing a phase artifact, plan, proposal, specification, design or verification report that a reader must scan and verify quickly."
license: MIT
metadata:
  author: "mdd-maintainers"
  version: "2.0"
---

## Activation Contract

Load when writing an MDD artifact (`.mdd/runs/<id>/NN-<actor>.md`) or any guide or report a
reader must scan and verify. It shapes prose only: it never changes the report format, the
evidence rules, the requested scope or the actor's permissions. Cognitive-load principles are
adapted from the Apache-2.0 `cognitive-doc-design` skill by gentleman-programming; this is an
independent rewrite for MDD artifacts.

## Hard Rules

- Lead with the outcome. The first paragraph states what was decided, found or changed, and
  why it matters. Background comes after, never before.
- Disclose progressively: happy path first, then details, then edge cases and limitations.
- Prefer tables, short lists and concrete examples over paragraphs a reader must remember.
- Signpost with `##` headings so a reader can locate a section without reading the whole file.
- Write for a reviewer who must verify intent without reconstructing the whole story.
- Keep unknowns visible. Never present an assumption, an unrun check or an unverified claim as
  a result; say what is not known and what would settle it.
- Reference requirement, scenario, decision and task IDs (`R1`, `S1`, `D1`, `T1`) from the run
  file instead of restating them; never invent new IDs for existing items.
- Do not copy the artifact into the short report; the report points to it.

## Decision Gates

| Situation | Action |
|---|---|
| The reader needs one answer | Put it in the first line; move rationale to a later section. |
| The document exceeds one screen | Split into headed sections, each holding one decision. |
| A list is growing past roughly seven items | Group it into a table with a named column. |
| Evidence is partial | State the gap and its impact explicitly, in its own section. |
| A repo template already exists | Follow that template instead of this default shape. |
| Content repeats the run file or an earlier artifact | Link it instead of copying it. |

## Execution Steps

1. Identify the single outcome the reader must take away, and write it first.
2. Draft the quick path: the shortest ordered sequence that reaches that outcome.
3. Move supporting decisions, constraints and alternatives into a details section.
4. Convert any dense paragraph into a table, checklist or example where it fits naturally.
5. Close with limitations and unknowns.

## Output Contract

Use this shape unless the phase or repository provides a stronger one:

```markdown
# <Outcome-oriented title>

<One paragraph: what this phase determined, for whom, and why it matters.>

## Quick path

1. <First step or finding>
2. <Second step or finding>
3. <Expected result or how it was checked>

## Details

| Topic | Decision |
|---|---|
| <area> | <concise explanation> |

## Limitations

- <What is not verified, and what would settle it>
```

The document must remain readable on its own, without the conversation that produced it.
