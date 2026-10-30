# Independent parallel MDD workers

MDD now supports default-on, bounded independent exploration and Apply workers. Parallelism preserves file ownership, declared dependencies, durable recovery, and the sequential phase workflow.

## Problem and outcome

Before this feature, MDD owned one native dispatch per phase. Safe concurrency required batch-aware ownership, result aggregation, and checkpoint recovery. Different primary file names do not prove independence.

## Authorized scope

- Global `workers.enabled` preference, default `true`, editable through `mdd-ai config` and the settings CLI.
- At most two independent foreground workers within one exploration or Apply phase.
- Complete explicit read/write scopes and dependency declarations; unknown or conflicting scopes fall back to sequential execution.
- Read-only investigation may reference separately authorized repositories without moving the child's workspace or granting remote access.
- The user selected bounded parallelism: scoped native edits may overlap in time; shell commands, tests, and builds remain sequential.
- One implementing writer in this workspace. No isolated worktrees, global installation, or PR creation. Original implementation did not authorize publication; the subsequent explicit authorization below now permits local integration and normal direct-main push.
- Authorized delivery target: `https://github.com/vancinis/mdd-orchestrator.git`, `origin/main`, using the existing configured Git authentication only. Fetch, local integration, verification, and normal push are authorized; force push and credential changes are not.

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
- [x] PW-4 — Enable independent exploration/Apply dispatch with scoped tool confinement, coordinator instructions, integration tests, and operational documentation.
  - Route: delegated direct; runtime fences and packaged prompts must change together.
  - Checks: deterministic native-hook integration, forbidden tools/out-of-scope edits, disabled/legacy fallback, full suite, typecheck, build.
  - [x] PW-4E — Enable progress-bound, read-only exploration batches and prove actual native overlap with mutation-denying gates.
  - [x] PW-4A — Enable Apply through formatter-free scoped editing primitives, deny alternate mutation routes, and prove actual native confinement/overlap.
- [x] PW-5 — Integrate the latest authorized `origin/main`, preserve both feature sets, verify the merged candidate, and publish normally to remote `main`.
  - Route: delegated direct; nine overlapping source/asset/test conflicts and sequential-Apply/Judgment-Day/security integration require a bounded writer.
  - Checks: typecheck, build, full suite, focused integration checks, baseline native probe, seven exploration cases, eight Apply cases, whitespace/scope readback, independent verification, and confirmed normal push identity.

## Verification policy

Default deterministic test-first policy applies: observe RED, implement GREEN, then refactor with checks green. No project-specific strict-TDD configuration has been established. The runner is Node 26.9.0 with `node --import ./tests/isolate-home.mjs --test`; local prerequisites were installed with `npm ci`, with no package-lock changes.

Normalize edited files to UTF-8/LF before functional proof and candidate freeze. Use `git diff --check` and scoped `git ls-files --eol`; do not renormalize the whole tree. Parent-authorized native proof uses only isolated localhost hosts, test-owned generated tokens/providers, temporary configuration, and bounded cleanup; no ambient services, credentials, global configuration, or real provider calls.

RDD status: off, explicitly selected by the user for this clone; global preference remains on. Continue ordinary functional checks and native risk assessment without starting, retrying, or reactivating receipt reviews. Delivery is `disabled/unmanaged`, not approved.

## Work units and delivery

- Existing feature branch: `feat-add-workers`.
- Branch point / initial review boundary: `57b0857c9374204dd2ddfc745f62b229107a5f10`.
- Final behavior work-unit footprint: 4,223 authored changed lines, including tests, docs, and earlier recovery updates; generated files excluded. The final passive tracking closeout is included in the running total below. Native safety and real-host proof increased the initial estimate; the user-selected single-branch strategy remained in effect.
- Delivery strategy remains one branch, not stacked branches. The user subsequently requested direct-main publication instead of a PR; normal push is now explicitly authorized through the captured Git channel. Keep integration on `feat-add-workers`; do not open a PR, force push, change credentials, or install globally.
- Original feature work-unit footprint: 4,253 authored changed lines including its passive tracking closeout. PW-5 merge adds 6,891 changed lines against the feature parent, including incoming main changes; combined history footprint before this final passive delivery record is 11,144, not a feature-only diff size.
- PW-1 work-unit commit: `2aeb1661224f6f5ac85d35ad79b392e1e8ec5916`, `feat(config): expose default-on independent worker preference`.
- PW-1 native tier/outcome: medium, `under_budget`; review slice remains pending against the initial boundary. No review receipt or approval is claimed.
- PW-2 work-unit commit: `892946c96ed9fca6a5f25eb047ad90216a4b15f8`, `feat(workers): select only explicitly independent task batches`.
- PW-2 native tier/outcome: medium; review was granted but returned no admitted result. The user then disabled RDD for this clone. Outcome: `disabled/unmanaged`, ordinary writer verification plus parent spot check; no review receipt. Initial reviewed boundary remains unchanged.
- PW-3 work-unit commit: `2abf2e7b4ba4e8183ad157a7a8fd7b10ac7d1351`, `feat(workers): preserve durable authority across task batches`.
- PW-3 native tier/outcome: medium, RDD `disabled/unmanaged`; writer functional proof and parent typecheck/structural spot checks passed. No receipt review ran.
- PW-4E work-unit commit: `938c58c07a62156c9069f649807e679bb65294bb`, `feat(workers): run confined independent exploration in parallel`.
- PW-4E native tier/outcome: high, RDD `disabled/unmanaged`; writer checks, independent verifier, actual native exploration proof, and parent spot checks passed. No receipt review ran.
- PW-4A work-unit commit: `2e28cd246fafeefa4b536fe6c30c845aaf96b5e1`, `feat(workers): enable formatter-free independent Apply`.
- PW-4A native tier/outcome: medium, RDD `disabled/unmanaged`; writer full/native checks, independent verification and fault recheck, and final parent typecheck/staged-whitespace spot checks passed. No receipt review ran.
- PW-5 merge commit: `8d659ceb986a2a512121eea1e711933bac3766eb`, `chore(workers): integrate latest main with scoped parallel Apply`; parents are original feature `8bb11ca7f830822bbb4bdec33610ea3b62d7e5a7` and fetched main `e1f3ff6bbd13f4bc8ee484d4661de27150b48542`.
- PW-5 native tier/outcome: high, RDD `disabled/unmanaged`; writer full/native checks, independent verification and parent spot checks passed, with the known sequential native isolation refusal disclosed. Normal push of this merge and exact remote identity were confirmed.
- Delivery slice: one branch directly to `main`, containing PW-1 through PW-4 plus the authorized PW-5 integration. No PR is requested; normal publication is now authorized.
- The approximately 400-line heuristic is advisory: no minification, cosmetic compression, omitted tests, or artificial task splits.

## Progress and next step

Initial mapping established that concurrent native calls were available and MDD's previously singular authority required batch-aware extension. Completed implementation and proof are recorded per unit below.

PW-1 is complete and committed. Changed eight allowed configuration/schema/docs/test files, 223 additions and 10 deletions, plus the recovery document. `freezeProfile(...).workers` exposes a detached immutable preference. At PW-1 closure runtime dispatch was still sequential; later PW-4E enabled confined exploration.

### PW-1 observed checks

- Writer RED: focused settings/UI/CLI tests, 107 passed and 7 failed before production changes.
- Writer GREEN: `npm run typecheck`, `npm run build`, and focused tests passed, 114 passed and zero failed.
- Writer `npm test`: 1,055 passed, two skipped, zero failed, approximately 330 seconds. An earlier run exceeded its 120-second timeout; the completed rerun is the reported proof.
- Writer and parent `git diff --check`: passed. Edited files are UTF-8/LF; lockfile and HEAD unchanged.
- Dependency installation reported nine vulnerabilities; no remediation or scope expansion was attempted.
- Native risk assessment initially failed because the untracked task file required declaration. After staging the intended files, assessment and committed-only assessment both returned medium/`under_budget` (315 authored lines). No review started, consent requested, or receipt claimed.
- Independent verifier passed typecheck, build, 114 focused tests, and diff checks after explicit user continuation. Its earlier DNS launch failure remains historical, not a passing attempt.
- Parent spot check: `npm run typecheck` passed before the work-unit commit.
- CLI discoverability follow-up resolved in PW-4E: top-level help lists the workers command, with test coverage.
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
- At PW-3 closure production dispatch remained serial until native confinement was supplied. `status.tasks`, `nextAction.calls`, and `workerAssignment` are the integration seams; PW-4E subsequently enabled read-only exploration, not Apply.

### PW-4 partial evidence and resolved uncertainties

- Earlier partial changes added CLI discoverability, grouped native-call guidance, truthful serial-fallback documentation, and an isolated pinned-host probe. Tests at that stage: 1,150 passed, two skipped. These earlier checks alone did not prove production concurrency.
- Trusted linkage exists: native `session.tool.progress` supplies the exact parent session, assistant message, native call, and child session before child prompting. Running transcript metadata is empty and is not authority.
- Progress is ephemeral and consumption asynchronous: missing/delayed/stale/conflicting events require a bounded fail-closed pre-action gate, not reconstruction from history or prompt text.
- A controlled native formatter-boundary probe returned the expected safety RED: editing triggered a formatter without a shell-hook call. Denying shell alone cannot confine concurrent native editors.
- The formatter gap does not block read-only exploration. PW-4 is split into two coherent internal work units so independent read-only value can be delivered without enabling unsafe writes.
- Bounded Apply needs a formatter-free scoped editor owned by the adapter, with native generic editors, shell, formatters, wrappers, and alternate mutation tools denied. This is within the selected bounded-edit scope; it does not authorize worktrees, global formatter changes, or arbitrary execution.

### PW-4E observed checks

PW-4E is complete and committed: 25 files, 1,495 additions and 66 deletions, including preserved earlier partial guidance/probe changes and tracking updates.

- Main `mdd_start({ requirements, exploration: { workItems } })` and `mdd_contextual_explore({ purpose, workItems })` support two complete independent read-only items, with explicit roots/files and preserved external-directory permission.
- At PW-4E closure, exact native progress binding gated every child action and failed closed for lost/delayed/conflicting/stale/manual identities. Production capability was read-only and phase-scoped to exploration; Apply was still serial until PW-4A.
- Writer proof: typecheck/build, 500 focused tests, 61 plugin contract tests, and full suite 1,195 passed, zero failed, two skipped.
- Independent proof: typecheck/build, 247 focused tests, baseline pinned-native probe, and seven actual native scenarios passed. Main/contextual/delayed/dropped/conflicting/external-denied showed two simultaneously live foreground children with reverse completion; disabled stayed singular.
- Synthetic-only coverage, not actual-host claims: literal grep, implicit `AGENTS.md`, alias/schema rejection, stale/manual quarantine, persistence failures, and restart recovery.
- Low inaccurate disabled-case output was corrected. Syntax check and actual disabled case passed; no production logic or assertions changed, and the full suite was not rerun for that console-only correction.
- Parent typecheck/whitespace and final syntax/staged-whitespace spot checks passed. Two skips remain Windows symlink privileges and opt-in installed Engram smoke.
- Scope deviation preserved and reviewed: the writer changed three lines in `tests/opencode-plugin.test.mjs` beyond its initial allowlist. The parent added that derived integration-test path to verification and future writer surfaces; original-scope compliance is not claimed.

### PW-4A final verification

- PW-4A implementation and one scoped correction are verified and committed: a formatter-free scoped `mdd_worker_edit` primitive and production Apply activation, with strict live child/ownership/path authorization and alternate-tool denial.
- Final writer checks: 1,227 full-suite tests passed, two skipped, zero failed; 342 focused tests; typecheck/build; baseline native probe, seven exploration cases and eight actual Apply cases passed after the correction.
- Independent initial verification passed 340 focused tests and the same native matrices, and identified a medium create-publication reporting defect plus low serial/scoped documentation ambiguity. Both were corrected within the existing task scope.
- Correction RED: 28 passed, two failed before the fix; GREEN: all 30 editor tests passed. Successful publication is recorded before cleanup; cleanup failures cannot mask retained changes or publication errors. Partial publication is reported, without blind rollback over human changes.
- Independent targeted recheck: typecheck/build, 30 editor tests, whitespace checks, and three isolated fault probes passed; newer human bytes and accurate retained-file diagnostics were preserved. No finding remains within the targeted scope.
- Native Apply proof: two live foreground children, reverse edits/completion, real file bytes, ordered aggregate once, 24 refused attacks per parallel scenario, MCP catalog connection without mutation calls, and absent formatter markers. Disabled/dependent/overlap/missing-metadata/implicit-bootstrap cases retain ordinary serial editing and formatting.
- Proof limits: native scenarios stop at singular Verify readiness, not Verify command execution. Create/delete, encoding/modes, drift, partial publication, restart and transfer are unit proof, not native-host claims. Persistent cleanup failures may leave reported adapter temporaries; there is no arbitrary-script sandbox or all-files atomicity claim.
- RDD remains off. Native risk assessment is medium; independent verification was also run because file confinement is critical. No review continuation or receipt is claimed.

## Outcome and next step

Feature implementation PW-1 through PW-4 and PW-5 main integration/publication are complete. Eligible declared-independent exploration and Apply tasks run as at most two native foreground workers; incomplete, dependent, overlapping, unsupported, or unsafe-bootstrap work remains serial. `workers.enabled` defaults on and is configurable through `mdd-ai config` or `mdd-ai workers status|on|off`. Settings are startup-frozen and captured for runs; no hot-reload claim is made.

Ordinary functional verification is complete within the proof limits above. The merged suite's three skipped tests, dedicated sequential native isolation refusal, and correct-project memory resynchronization remain disclosed, not fabricated as passing. No final source check failed. Receipt reviews remain explicitly disabled for this clone, and the historical pending review state was preserved.

### PW-5 initial evidence

- User authorized fetch, local integration and normal direct-main push via the existing configured Git authentication after the interrupted confirmation was re-presented. No remote action preceded that confirmation.
- Starting feature HEAD: `8bb11ca7f830822bbb4bdec33610ea3b62d7e5a7`, clean worktree. Fetched remote main: `e1f3ff6bbd13f4bc8ee484d4661de27150b48542`; six feature commits versus 24 incoming main commits.
- The initial Git-object-only preview found nine conflicts: two packaged agents, configuration docs, three source adapters/runner files, and three integration/asset test files. These were subsequently resolved in the local integration below.
- Preserve incoming sequential Apply, native Judgment Day and standalone security changes. Keep receipt reviews off for this clone, and do not touch other worktrees or the historical pending review authority.

### PW-5 local integration proof

- The pinned main merge is present without a commit; all nine textual conflicts are resolved and the index has no unmerged entries. Fourteen manual integration paths preserve ordered singleton Apply results, exact worker reports, durable progress and native standalone security/Judgment Day boundaries. Coordinator prompt fits its 16,000-byte bound.
- Typecheck/build and both whitespace checks passed. Actual pinned-host baseline, seven exploration cases and eight Apply cases passed. The dedicated sequential smoke remains unavailable because ancestor host configuration prevents isolation; three deterministic scenarios passed, not native proof.
- Focused tests: 483 passed, three failed. Full suite: 1,558 passed, three failed, three skipped (two Windows symlink cases and opt-in installed Engram smoke). No final overall GREEN or publication is claimed.
- One callback-ordering defect must preserve the durable Apply refusal before reading unavailable exploration storage. Two remaining assertion mismatches concern coordinator line wrapping and main's newest-first changed-file ordering; preserve behavior and update only justified expectations.
- One bounded correction is authorized for the runner and those exact tests, followed by complete writer proof and independent verification. The sequential host refusal is preserved unless fixture isolation can be safely established without ambient configuration or credentials.

- Follow-up correction evidence: callback refusal and both assertion mismatches are fixed. Status still consults missing exploration storage and masks the retained Apply block; complete the same phase-specific guard in status. Latest focused/full results were 485/1,560 passed with two failures and three full-suite skips.
- The subsequent exploration matrix completed two cases, then refused the delayed case with `service_starting`; remaining four were unrun. One explicit complete-matrix rerun is authorized after the status correction, not a claim that the interrupted run passed. Apply's eight native cases still passed.

### PW-5 final pre-publication proof

- Phase-specific callback and status guards are corrected; actual main/contextual exploration retains its storage and ownership failures. Held Apply no longer reads unrelated exploration storage. Justified whitespace and newest-first evidence assertions preserve their original semantic checks.
- Final writer checks: typecheck/build, 487 focused tests, and full suite 1,562 passed, zero failed, three skipped. Baseline native probe, all seven exploration cases and all eight Apply cases passed after the final correction. The earlier interrupted matrix remains failed historical evidence, not a passing attempt.
- Independent verifier repeated typecheck/build, all 487 focused tests, the baseline and both full native matrices successfully. Three additional contextual-above-held-Apply probes passed, including retained failure and missing exploration storage. No introduced blocker was established.
- Pinned main's strict workflow, Apply batch selection, Judgment Day and standalone security implementations remain unchanged where no conflict required adaptation. Worker reports publish ordered singleton Apply results with distinct batch/artifact identities only after all siblings settle; successful work is not replayed.
- A pre-existing inactive-concurrency paragraph was corrected as a passive documentation follow-up. Structural readback and both whitespace checks passed; no executable bytes or test assertions changed after final independent verification.
- Native risk assessment is high; the independent gate and parent typecheck/whitespace spot checks passed with RDD still off. Dedicated sequential native smoke remains unavailable due to ancestor configuration, not passed. Two Windows symlink tests and opt-in Engram smoke remain skipped. Native matrices stop at Verify readiness; no live Judgment Day/security or final native Verify execution is claimed.

### PW-5 confirmed delivery

- Immediately before committing, a fresh authorized fetch confirmed remote main still matched the pinned merge target. Parent typecheck, working/staged whitespace checks and unresolved-index checks passed; merge commit `8d659ceb986a2a512121eea1e711933bac3766eb` contains both histories.
- Normal `HEAD:refs/heads/main` push succeeded from `e1f3ff6` to `8d659ce`, without force. Authorized remote readback confirmed the exact merge identity at `refs/heads/main`.
- Source worktree was clean after delivery. This final passive tracking closeout records the observed publication; its own commit is delivered normally without reopening unchanged functional proof.
- Other worktrees and their checked-out local `main` branch were not altered. No PR, global installation, credential change, real-provider call or receipt-review reactivation occurred.

Next: no implementation or requested source publication remains. Global installation and PR creation remain unauthorized.

## Recovery mirror

Engram topic: `odd/parallel-workers/tasks`. Initial full mirror was read back as observation 6817, but its stored project is `mdd` while root detection reports `mdd-orchestrator`. Correct-project synchronization remains pending; preserve the local document as the authoritative recovery copy.
