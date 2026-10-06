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
- [x] PW-2 — Add explicit complete task scopes and conservative deterministic batch eligibility, preserving legacy sequential behavior.
  - Route: delegated direct; parsing, acceptance, path validation, and scheduling tests require multi-file implementation.
  - Checks: scope/dependency/path-alias tests, acceptance and phase-report tests, typecheck, build.
- [x] PW-3 — Make native ownership, result aggregation, and recovery batch-aware without advancing a phase early.
  - Route: delegated direct; shared runner/hooks/checkpoints require one bounded writer.
  - Checks: overlapping call admission, reverse completion, duplicates, sibling failures, persistence faults, pending restart, transfer, no completed-member replay.
- [ ] PW-4 — Enable independent exploration/Apply dispatch with scoped tool confinement, coordinator instructions, integration tests, and operational documentation.
  - Route: delegated direct; runtime fences and packaged prompts must change together.
  - Checks: deterministic native-hook integration, forbidden tools/out-of-scope edits, disabled/legacy fallback, full suite, typecheck, build.
  - [ ] PW-4E — Enable progress-bound, read-only exploration batches and prove actual native overlap with mutation-denying gates.
  - [ ] PW-4A — Enable Apply through formatter-free scoped editing primitives, deny alternate mutation routes, and prove actual native confinement/overlap.

## Verification policy

Default deterministic test-first policy applies: observe RED, implement GREEN, then refactor with checks green. No project-specific strict-TDD configuration has been established. The runner is Node 26.9.0 with `node --import ./tests/isolate-home.mjs --test`; local prerequisites were installed with `npm ci`, with no package-lock changes.

Normalize edited files to UTF-8/LF before functional proof and candidate freeze. Use `git diff --check` and scoped `git ls-files --eol`; do not renormalize the whole tree. Native host-service smoke is pending explicit authorization and is not replaced by a registration-only smoke.

RDD status: off, explicitly selected by the user for this clone; global preference remains on. Continue ordinary functional checks and native risk assessment without starting, retrying, or reactivating receipt reviews. Delivery is `disabled/unmanaged`, not approved.

## Work units and delivery

- Existing feature branch: `feat-add-workers`.
- Branch point / initial review boundary: `57b0857c9374204dd2ddfc745f62b229107a5f10`.
- Updated forecast: approximately 2,300–3,200 authored changed lines across four coherent units, tests and docs included; generated files excluded. Durable authority and recovery coverage made PW-3 larger than the initial estimate. The user-selected single-branch strategy remains in effect.
- Delivery strategy: `single-pr`, explicitly selected by the user: one branch against `main`. Keep all coherent local work-unit commits on `feat-add-workers`; do not create stacked branches, publish, push, or open a PR.
- Running committed authored lines: 1,661 across three work-unit commits (includes recovery-document updates).
- PW-1 work-unit commit: `2aeb1661224f6f5ac85d35ad79b392e1e8ec5916`, `feat(config): expose default-on independent worker preference`.
- PW-1 native tier/outcome: medium, `under_budget`; review slice remains pending against the initial boundary. No review receipt or approval is claimed.
- PW-2 work-unit commit: `892946c96ed9fca6a5f25eb047ad90216a4b15f8`, `feat(workers): select only explicitly independent task batches`.
- PW-2 native tier/outcome: medium; review was granted but returned no admitted result. The user then disabled RDD for this clone. Outcome: `disabled/unmanaged`, ordinary writer verification plus parent spot check; no review receipt. Initial reviewed boundary remains unchanged.
- PW-3 work-unit commit: `2abf2e7b4ba4e8183ad157a7a8fd7b10ac7d1351`, `feat(workers): preserve durable authority across task batches`.
- PW-3 native tier/outcome: medium, RDD `disabled/unmanaged`; writer functional proof and parent typecheck/structural spot checks passed. No receipt review ran.
- Delivery slice: one eventual branch/PR against `main`, currently contains PW-1 through PW-3. No publication authorized.
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

### PW-2 observed checks

PW-2 is complete and committed under ordinary policy after the user disabled reviews. Eight behavior/docs/test files changed, 410 additions and five deletions. The work-unit commit also includes prior PW-1 tracking updates.

- Added `Deliverable.parallel` with complete read/write footprints and a conservative, filesystem-validated `selectWorkerBatch` helper selecting zero, one, or two ready tasks.
- Missing explicitly declared dependencies discard opt-in metadata before normalization; legacy and incomplete plans remain sequential across JSON/checkpoint reconstruction.
- Writer meaningful RED: 108 passed and 25 failed, including additive metadata rejection before implementation.
- Writer GREEN: typecheck/build and 164 focused tests passed. Full suite: 1,120 passed, two skipped, zero failed, approximately 105 seconds.
- Writer and parent diff checks passed; parent typecheck spot check passed. Edited files are UTF-8/LF.
- Current and committed-only native assessments returned medium with review due (`slice_budget_reached`). The committed slice has 734 authored changed lines.
- Native consent was granted once. The reviewer returned no admitted result; one target-bound read-only STATUS preserved the pending slot. The user explicitly disabled RDD for this clone; no further review operation, approval, acknowledgement, authority deletion, or retry followed.
- Path validation is a read-only snapshot, not an edit fence; native tool confinement and revalidation remain mandatory in PW-3/PW-4.

### PW-3 observed checks

PW-3 is complete and committed. Sixteen behavior/docs/test files changed, 870 additions and 18 deletions, plus prior tracking updates in the work-unit commit.

- Added durable member evidence and exact-call batch reservations, serialized admission/results/recovery, deterministic aggregation, and all-member recovery.
- Successful reports persist before the next batch is offered; the first completion cannot release a live sibling or advance the phase. Unknown pending work fails closed; completed work is not replayed.
- Effective worker preferences are captured. Missing legacy checkpoint policy restores serial behavior. Apply records one aggregate phase result; Verify remains singular.
- Writer RED: worker-state/ownership tests, 17 passed and three failed before production edits.
- Writer GREEN: typecheck/build and 223 focused tests passed. Full suite: 1,147 passed, two skipped, zero failed, approximately 155 seconds.
- Skipped checks: Windows symlink-privilege test and opt-in installed Engram smoke. Authenticated host smoke was not run.
- Writer and parent diff checks passed; parent typecheck spot check passed. Edited files are UTF-8/LF; HEAD was unchanged until the parent work-unit commit.
- Native risk assessment returned medium; RDD remains off for this clone and no returned review continuation was executed.
- Production dispatch remains serial: `workerCapability: { confined: true }` is not supplied until PW-4 establishes native child binding and file/tool fences. `status.tasks`, `nextAction.calls`, and `workerAssignment` are the integration seams.

### PW-4 partial evidence and resolved uncertainties

- Current uncommitted partial changes add CLI discoverability, grouped native-call guidance, truthful serial-fallback documentation, and an isolated pinned-host probe. Tests: 1,150 passed, two skipped; typecheck/build/diff checks passed. These checks do not prove production concurrency.
- Trusted linkage exists: native `session.tool.progress` supplies the exact parent session, assistant message, native call, and child session before child prompting. Running transcript metadata is empty and is not authority.
- Progress is ephemeral and consumption asynchronous: missing/delayed/stale/conflicting events require a bounded fail-closed pre-action gate, not reconstruction from history or prompt text.
- A controlled native formatter-boundary probe returned the expected safety RED: editing triggered a formatter without a shell-hook call. Denying shell alone cannot confine concurrent native editors.
- The formatter gap does not block read-only exploration. PW-4 is split into two coherent internal work units so independent read-only value can be delivered without enabling unsafe writes.
- Bounded Apply needs a formatter-free scoped editor owned by the adapter, with native generic editors, shell, formatters, wrappers, and alternate mutation tools denied. This is within the selected bounded-edit scope; it does not authorize worktrees, global formatter changes, or arbitrary execution.

Next: implement PW-4E read-only exploration and trustworthy child binding, then PW-4A formatter-free confined edits with local native proof. Reviews remain disabled; no production parallel execution is claimed yet.

## Recovery mirror

Engram topic: `odd/parallel-workers/tasks`. Initial full mirror was read back as observation 6817, but its stored project is `mdd` while root detection reports `mdd-orchestrator`. Correct-project synchronization remains pending; preserve the local document as the authoritative recovery copy.
