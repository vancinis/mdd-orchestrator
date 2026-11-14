# MDD run-file contract

A run is a Markdown file in the project: `.mdd/runs/<id>.md`. Artifacts produced by actors live
beside it in `.mdd/runs/<id>/`. The run file is the single source of truth for the run: anyone
(you after a restart, another conversation, the user) must be able to resume from it alone.
Engram may keep a copy (see Persistence); the local file wins.

The orchestrator owns the run file and is the only one that edits it. Actors read it and write
only their own artifact.

## Layout

```text
.mdd/
├── .gitignore                 a Persistence template (local by default)
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
- Skills: `/home/me/.agents/skills/ts-testing/SKILL.md` (mdd-plan, mdd-apply)   # or: none
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
- Record only what actually happened. Never list an unrun check as executed or passed.
- Record the checked revision and relevant uncommitted changes under Verification, with command
  working directories and links to detailed evidence. Distinguish executed checks from explicitly
  cited reused evidence and explain why reuse is still valid. Reuse is not a new execution.
  Keep required checks that were not run visible as blocked/omitted, never as passed evidence.
- After later edits or merges, identify which earlier evidence remains valid and which affected
  checks must run again. Keep required evidence gaps and approved external checks under Limits;
  do not let `completed` imply an unchecked later state or silently waive required coverage.
- Do not delete a finished run. If new work follows, start a new run and link the old one in its
  Request section.

## Persistence

`.mdd/.gitignore` is the switch; its first line is the marker. Copy the templates exactly:

```gitignore
# mdd: local
# MDD runs stay on this machine. Ask MDD to version them to share them through git.
*
```

```gitignore
# mdd: versioned
# MDD runs are shared through git. Ask MDD to make them local again.
*
!.gitignore
!runs/
!runs/**
```

- Before writing under `.mdd/`, create the `local` template if the file is missing (v0.1 too).
  A bare `*` counts as local. Any other content is user-managed: leave it and let git decide.
- Switch only on request (workflow section 8). To version, show non-template content and ask
  before replacing it, write `versioned`, then run `git check-ignore -v` on a run file. If
  another rule such as `.mdd/` in the root `.gitignore` still ignores it, name its `file:line`
  and ask before editing that file. Outside git, say the switch has no effect. To go local
  again, write `local` and say tracked files stay tracked until the user runs
  `git rm -r --cached .mdd` (only on request). Never stage or commit unless asked. `lessons.md`
  stays local. Log the switch in the active run, if any.
- **Engram mirror.** Only the orchestrator mirrors, with the memory save tool (Engram `mem_save`
  or equivalent), after every log update: title `MDD run <id>`, `topic_key` `mdd/run/<id>`, scope
  project, type `decision`, the run file verbatim as content. Omit `project` (the session's
  applies) and do not capture the prompt. Artifacts are not mirrored.
- **Restore.** The local file wins: when it exists, read Engram only if the user says the local
  copy is stale, then show both `updated` dates and last log lines and let them choose. When it
  is missing, search (`mem_search`, "MDD run" plus slug words) and fetch the content by id.
  Restore only a 0.2 run file (front matter `id`, `status`, `level`, `mode`) of this project.
  Show where it stopped; after the user confirms, write it with the native write tool, log
  "restored from Engram (observation <id>)" and list missing artifacts under Limits. If no copy
  exists, offer a new run.
- Work continues when the memory tools are unavailable or any memory call fails
  (save, search or fetch): one line under Limits, tell the user once, retry at the next mirror
  point, and update or remove that Limits line when a later save succeeds. Never install or
  start Engram.
