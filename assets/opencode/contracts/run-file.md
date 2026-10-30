# MDD run-file contract

A run is a Markdown file in the project: `.mdd/runs/<id>.md`. Artifacts produced by actors live
beside it in `.mdd/runs/<id>/`. The run file is the single source of truth for the run: anyone
(you after a restart, another conversation, the user) must be able to resume from it alone.

The orchestrator owns the run file and is the only one that edits it. Actors read it and write
only their own artifact.

## Layout

```text
.mdd/
├── .gitignore                 contains "*" (MDD data is local by default)
├── lessons.md                 improvements the user asked to record
└── runs/
    ├── 20261102-email-validation.md
    └── 20261102-email-validation/
        ├── 01-explore.md
        ├── 02-plan.md
        ├── 03-apply-T1.md
        └── 04-verify.md
```

## Template

```markdown
---
id: 20261102-email-validation
status: active            # active | completed | closed-unverified | abandoned
level: medium             # low | medium | high
mode: automatic           # automatic | interactive
created: 2026-11-02
updated: 2026-11-02
---

# Email validation in the sign-up form

## Request

> Exact user text, quoted verbatim. Add later user messages that change the request.

## Acceptance

- **R1** Invalid emails are rejected before submit.
  - S1: given "a@b", when the user submits, then the form shows "Email inválido" and does not send.
- **R2** ...

## Scope

- Reads: `src/forms/signup.tsx`, `src/lib/validation.ts`
- Writes: `src/forms/signup.tsx`, `src/lib/validation.ts`, `tests/signup.test.ts`
- Out of scope: server-side validation.

## Decisions

- **D1** Use the existing `validateEmail` helper. (user, 2026-11-02)

## Plan

| ID | Task | Files | Depends on | Status |
|---|---|---|---|---|
| T1 | Add client-side validation | `src/forms/signup.tsx` | — | done |
| T2 | Regression test for S1 | `tests/signup.test.ts` | T1 | pending |

## Log

- 2026-11-02 mdd-explore passed — found existing helper. [01-explore.md](20261102-email-validation/01-explore.md)
- 2026-11-02 mdd-plan passed — 2 tasks. [02-plan.md](20261102-email-validation/02-plan.md)

## Verification

| Check | Command | Result |
|---|---|---|
| Unit tests | `npm test -- signup` | passed (12/12) |

## Limits and open items

- None yet.
```

## Rules

- Keep sections in this order. Empty sections stay, with `None yet.` or `—`.
- Update `updated` and the log after every actor, question or decision.
- Acceptance IDs (`R1`, `S1`), decision IDs (`D1`) and task IDs (`T1`) are stable: never renumber.
  Actors reference them.
- Quote the user's request exactly. Everything else is written in English.
- Record only what actually happened. A check you did not run does not go in Verification.
- Do not delete a finished run. If new work follows, start a new run and link the old one in its
  Request section.
