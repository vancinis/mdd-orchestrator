# MDD run-file contract

A run is a Markdown file in the project: `.mdd/runs/<id>.md`. Artifacts produced by actors live
beside it in `.mdd/runs/<id>/`. Resume from the run file's front matter and `## Now`;
its remaining sections hold the details.
Engram may keep a copy (see Persistence); the local file wins.

The orchestrator owns the run file and is the only one that edits it. Actors read it and write
only their own artifact.

## Layout

```text
.mdd/
├── .gitignore
├── lessons.md
└── runs/
    ├── 20261102-email-validation.md
    └── 20261102-email-validation/
        ├── 01-explore.md
        ├── 02-plan.md
        ├── 03-apply-T1.md
        ├── 04-verify.md
        ├── i2-domain-check/01-plan.md
        ├── evidence/
        └── history.md
```

I1 artifacts stay at the root; later iterations use a fixed `i<n>-<slug>/` folder.
Reserve `NN-<actor>[-<suffix>].md` before dispatch: `NN` is one higher than the highest used
or reserved number in that folder (start `01`, `100` follows `99`). Gaps are fine; never
reuse, overwrite or renumber. Field-only follow-ups keep their session and path.
Save logs, probes, screenshots and audit/spike outputs under `evidence/`, traceable by
iteration/scenario. Keep heavy state (browser profiles, caches) outside `.mdd/runs/`; link it.

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

## Now

- State: ready to apply · I2 `i2-domain-check/`
- Next: dispatch `mdd-apply` for T3 with `i2-domain-check/01-plan.md`
- Blockers: None.
- Last verified: I1 at `abc1234` ([Verify](20261102-email-validation/04-verify.md)).
- Freshness: I1 syntax tests still valid; domain behavior pending I2 checks.

## Request

> Exact user text, quoted verbatim. Add later user messages that change the request.

## Acceptance

- **R1** Invalid emails are rejected before submit.
  - S1: given "a@b", when the user submits, then the form shows "Email inválido" and does not send.
- **R2** Accept any email domain. (superseded by R3, I2)
- **R3** Reject blocked email domains.

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
| T3 | Reject blocked domains | `src/lib/validation.ts` | T1 | pending |

## Log

- I1 completed 2026-11-03 — Verify passed at abc1234. [history](20261102-email-validation/history.md#i1-completed)
- I2 2026-11-04 mdd-plan passed — domain check. [plan](20261102-email-validation/i2-domain-check/01-plan.md)

## Verification

| Check | Command | Result |
|---|---|---|
| Unit tests | `npm test -- signup` | passed (12/12) |

## Limits and open items

- None yet.
```

## Rules

- Keep sections in this order. Empty sections stay, with `None yet.` or `—`.
- Rewrite **Now** on each dispatch, result, check, question/answer, decision or closure; align
  front matter status/updated. In about ten short lines give phase/state and iteration/folder;
  next owner/action and IDs/inputs (or no next action), including in-flight actor session/path;
  blockers with owner/action; last verified scope/state, revision/local edits and evidence link
  (or `not verified yet`); valid, stale and pending evidence with recheck. Link details; compaction
  uses the whole section or an explicit reread marker, never a partial copy.
- Maintain Acceptance, Plan, Decisions, Verification and Limits in place. Keep stable R/S/D/T
  IDs; append new IDs and mark replacements `(superseded by <ID>, I<n>)`. Log one linked line
  per entry, prefixed with the iteration, about 200 characters (not a cap).
- Start with I1; only one current iteration, including parallel actors. At opening allocate
  the next number (never reused), quote the change under Request as `I<n>:`, record scope,
  folder and next action, and mark affected evidence stale in Now/Verification.
- Close only once all writers are known stopped. Record outcome, checked state and gaps;
  copy the iteration's Log lines in order to `history.md` under `## I<n> <outcome>` with links
  relative to the run folder. On retry reconcile that group with the still-present Log, rather
  than append duplicates; don't archive an existing summary. Read back and confirm all entries
  before replacing them with one linked summary; leave other iterations untouched.
- Legacy runs keep their format on mere resume. When doing new work, adopt these rules:
  root artifacts count as I1, root corrections take the next number, and later iterations
  get their own folder. Leave old artifacts and legacy log lines in place.
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
- **Engram mirror.** Only the orchestrator mirrors (Engram `mem_save` or equivalent), at milestones:
  after each recorded actor result, at iteration/run close, and before proposing a new
  conversation. One save covers coincident milestones; other log edits do not trigger saves.
  Title `MDD run <id>`, `topic_key` `mdd/run/<id>`, scope
  project, type `decision`, the run file verbatim as content. Omit `project` (the session's
  applies) and do not capture the prompt. Artifacts are not mirrored.
- **Restore.** The local file wins: when it exists, read Engram only if the user says the local
  copy is stale, then show both `updated` dates and last log lines and let them choose. When it
  is missing, search (`mem_search`, "MDD run" plus slug words) and fetch the content by id.
  Restore only a 0.2 run file (front matter `id`, `status`, `level`, `mode`) of this project.
  Show where it stopped; after the user confirms, write it with the native write tool, log
  "restored from Engram (observation <id>)" and list missing artifacts under Limits. If no copy
  exists, offer a new run.
- **Finding the memory tools.** Hosts may expose Engram directly (`mem_save`, `engram_mem_save`)
  or only through Code Mode: then call `execute` with `search('engram mem_save')` and use the
  returned path (such as `tools.engram.mem_save`). Look once per conversation, before the first
  mirror or restore; a missing name in your direct tool list does not mean Engram is unavailable.
- Work continues when the memory tools are unavailable (not found by the lookup above) or any
  memory call fails (save, search or fetch): one line under Limits, tell the user once, retry at
  the next mirror point, and update or remove that Limits line when a later save succeeds. Never
  install or start Engram.
