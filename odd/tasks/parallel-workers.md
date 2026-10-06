# Independent parallel MDD workers

Add a default-on configuration switch for independent exploration and Apply workers. Parallelism must not bypass file ownership, task dependencies, durable recovery, or the sequential phase workflow.

## Problem and outcome

MDD currently owns one native dispatch per phase. A second call loses authority unless ownership, result aggregation, and checkpoint recovery become batch-aware. Different primary file names do not prove independence.

## Authorized scope

- Global `workers.enabled` preference, default `true`, editable through `mdd-ai config` and the settings CLI.
- At most two independent foreground workers within one exploration or Apply phase.
- Complete explicit read/write scopes and dependency declarations; unknown or conflicting scopes fall back to sequential execution.
- Read-only investigation may reference separately authorized repositories without moving the child's workspace or granting remote access.
- The user selected bounded parallelism: scoped native edits may overlap in time; shell commands, tests, and builds remain sequential.
- One implementing writer in this workspace. No isolated worktrees, publishing, global installation, push, PR creation, or merge.

## Constraints and acceptance

- Omitted settings default on; old plans/checkpoints without complete parallel metadata remain sequential.
- No write/write or write/read intersection, path alias overlap, or dependency between simultaneously running members.
- Native calls remain foreground and provider-issued; no background execution or Code Mode wrapper substitution.
- Capture effective policy per run. Keep workflow transitions sequential and aggregate only settled members.
- Preserve completed member evidence after failure or interruption; uncertain pending work blocks, never silently replays.
- File boundaries must be enforced at the native edit boundary; uncontrolled tools must not execute concurrently.
- Tests use deterministic barriers rather than sleeps. Existing serial flows remain covered.

## Tasks

- [x] PW-1 — Add and expose the captured worker preference with legacy/default/invalid-value coverage and configuration documentation.
  - Route: delegated direct; configuration, CLI, UI, schema, and tests require preparation and multiple non-trivial files.
  - Checks: focused settings/UI/CLI tests, typecheck, build, diff whitespace check.
- [ ] PW-2 — Add explicit complete task scopes and conservative deterministic batch eligibility, preserving legacy sequential behavior.
  - Route: delegated direct; parsing, acceptance, path validation, and scheduling tests require multi-file implementation.
  - Checks: scope/dependency/path-alias tests, acceptance and phase-report tests, typecheck, build.
- [ ] PW-3 — Make native ownership, result aggregation, and recovery batch-aware without advancing a phase early.
  - Route: delegated direct; shared runner/hooks/checkpoints require one bounded writer.
  - Checks: overlapping call admission, reverse completion, duplicates, sibling failures, persistence faults, pending restart, transfer, no completed-member replay.
- [ ] PW-4 — Enable independent exploration/Apply dispatch with scoped tool confinement, coordinator instructions, integration tests, and operational documentation.
  - Route: delegated direct; runtime fences and packaged prompts must change together.
  - Checks: deterministic native-hook integration, forbidden tools/out-of-scope edits, disabled/legacy fallback, full suite, typecheck, build.

## Verification policy

Default deterministic test-first policy applies: observe RED, implement GREEN, then refactor with checks green. No project-specific strict-TDD configuration has been established. The runner is Node 26.9.0 with `node --import ./tests/isolate-home.mjs --test`; local prerequisites were installed with `npm ci`, with no package-lock changes.

Normalize edited files to UTF-8/LF before functional proof and candidate freeze. Use `git diff --check` and scoped `git ls-files --eol`; do not renormalize the whole tree. Native host-service smoke is pending explicit authorization and is not replaced by a registration-only smoke.

RDD status: on, global. Native risk assessment and candidate-scoped consent remain separate from ordinary functional verification. Do not change the user's mode.

## Work units and delivery

- Existing feature branch: `feat-add-workers`.
- Branch point / initial review boundary: `57b0857c9374204dd2ddfc745f62b229107a5f10`.
- Forecast: approximately 1,100–1,600 authored changed lines across four coherent units, tests and docs included; generated files excluded.
- Delivery strategy: `single-pr`, explicitly selected by the user: one branch against `main`. Keep all coherent local work-unit commits on `feat-add-workers`; do not create stacked branches, publish, push, or open a PR.
- Running committed authored lines: 315 (including the recovery document; behavior/docs/tests alone: 233).
- PW-1 work-unit commit: `2aeb1661224f6f5ac85d35ad79b392e1e8ec5916`, `feat(config): expose default-on independent worker preference`.
- PW-1 native tier/outcome: medium, `under_budget`; review slice remains pending against the initial boundary. No review receipt or approval is claimed.
- Delivery slice: one eventual branch/PR against `main`, currently contains PW-1. No publication authorized.
- The approximately 400-line heuristic is advisory: no minification, cosmetic compression, omitted tests, or artificial task splits.

## Progress and next step

Read-only repository mapping and a bounded native-concurrency feasibility challenge are complete. Pinned V2 supports concurrent foreground calls, but MDD's existing singular authority needs explicit extension.

PW-1 is complete and committed. Changed eight allowed configuration/schema/docs/test files, 223 additions and 10 deletions, plus the recovery document. `freezeProfile(...).workers` exposes a detached immutable preference; runtime dispatch remains sequential until PW-2 through PW-4 are implemented.

### PW-1 observed checks

- Writer RED: focused settings/UI/CLI tests, 107 passed and 7 failed before production changes.
- Writer GREEN: `npm run typecheck`, `npm run build`, and focused tests passed, 114 passed and zero failed.
- Writer `npm test`: 1,055 passed, two skipped, zero failed, approximately 330 seconds. An earlier run exceeded its 120-second timeout; the completed rerun is the reported proof.
- Writer and parent `git diff --check`: passed. Edited files are UTF-8/LF; lockfile and HEAD unchanged.
- Dependency installation reported nine vulnerabilities; no remediation or scope expansion was attempted.
- Native risk assessment initially failed because the untracked task file required declaration. After staging the intended files, assessment and committed-only assessment both returned medium/`under_budget` (315 authored lines). No review started, consent requested, or receipt claimed.
- Independent verifier passed typecheck, build, 114 focused tests, and diff checks after explicit user continuation. Its earlier DNS launch failure remains historical, not a passing attempt.
- Parent spot check: `npm run typecheck` passed before the work-unit commit.
- Nonblocking follow-up: top-level CLI help does not list the new workers command; configuration docs do. Consider discoverability alongside final operational documentation, without broadening unrelated behavior.
- Runtime parallel-dispatch proof and local host smoke remain pending in later tasks; current tests establish configuration behavior only.

Next: implement PW-2 scope metadata and conservative batch eligibility on the same branch. PW-3 and PW-4 remain pending; no parallel execution is claimed yet.

## Recovery mirror

Engram topic: `odd/parallel-workers/tasks`. Initial full mirror was read back as observation 6817, but its stored project is `mdd` while root detection reports `mdd-orchestrator`. Correct-project synchronization remains pending; preserve the local document as the authoritative recovery copy.
