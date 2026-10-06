# Complete large changes through sequential Apply batches

Implement one bounded planned deliverable per fresh Apply actor, automatically advancing after durable success and verifying the entire change only after all deliverables finish.

## Problem and evidence

Before T1, Apply received the whole plan; completion IDs were discarded and a passed Apply advanced directly to Verify. No changed-line ceiling was found. The cause of the reported 2,600-line interruption remains unproven. T1 implements batch-aware artifacts, evidence aggregation and restart correlation.

## Scope and constraints

- Preserve the existing phase/tool architecture and manual approval semantics.
- Persist exact task completion, immutable batch artifacts and aggregate changed-file evidence.
- Stop on failed, interrupted or ambiguous substantive writes; never auto-retry an uncertain writer.
- Preserve settled legacy records and support explicit rework without stale completion authority.
- Split large plans into bounded deliverables; do not impose a changed-line cap.
- No global installation, PR creation or remote execution. Latest explicit user authorization allows fetching origin/main, local integration and normal direct push to origin/main using configured Git authentication; no force push.
- Technical artifacts are English. Keep tests/docs with behavior.

## Delivery

- Branch: `feat-apply-improvements`; initial reviewed boundary: `57b0857c9374204dd2ddfc745f62b229107a5f10`.
- Strategy: initially `stacked-to-main`; latest explicit user instruction selects direct normal delivery to main without PRs.
- Forecast: approximately 1,100–1,650 authored changed lines, mostly regression tests; generated output excluded.
- Running authored count: 1,523 (T1: 851; T2: 609; T3 compatibility fix/tests: 63), excluding this progress document and pre-existing upstream changes. No PRs created.
- RDD: latest read-only status is off (clone-local source; global remains on). This session did not toggle it. User explicitly deferred review; preserve the existing T1 transaction without approval, decline or abandonment. No native review actors are invoked; ordinary checks and delivery remain disabled/unmanaged with respect to receipts.
- TDD: no configured mode found; default applicable test-first policy. Runner: Node v26.9.0, `npm run build` then Node test runner.
- Engram mirror: `odd/sequential-apply-batches/tasks` in runtime session project `mdd` (repository detection uses `mdd-orchestrator`).

## Tasks

- [x] **T1 — Durable sequential Apply execution.** Route: delegated direct; triggers: unfamiliar preparation, multi-file state-machine/runtime implementation. Exact-ID batching, replayable completion/rework epochs, immutable artifacts, aggregate evidence and pending-write fences implemented. RED: workflow 17 passed / 1 failed; GREEN: focused 364 passed / 1 skipped; full suite 1,067 passed / 0 failed / 2 skipped. Typecheck, build and diff check passed; parent independently reran typecheck. Baseline focused run timed out after 120 seconds; no complete baseline claimed. Local locked dependencies installed without manifest changes; 9 reported dependency vulnerabilities left untouched. Skips: Windows symlink privilege and gated managed-Engram smoke. Commit: `0b4f5b896c9502309d5d4c05e09dc6107a3cba8e`, first future PR slice. Committed native assessment: medium, review due (`slice_budget_reached`), 895 lines including progress document. User granted review; initial and user-authorized retry returned no valid result. Review is deferred, not approved; reviewed boundary remains the original branch point.
- [x] **T2 — Bounded planning guidance and execution proof.** Commit: `584c84df7811719b2ecf5f82e5c71c49def3d431`.
  - Route: delegated direct; triggers: multi-file agent instructions and runtime harness.
  - Outcome: Plan/Tasks require bounded dependency-ordered deliverables; Apply reports only its exact assignment; coordinator continues durable successful batches automatically while preserving phase approvals. Coordinator stays at 15,921/16,000 bytes.
  - RED: asset tests 28 passed / 4 failed; harness missing-module failure; cleanup regressions 9 passed / 2 failed.
  - GREEN: focused 69 passed / 0 failed; full suite 1,082 passed / 0 failed / 2 known skips; typecheck, build and diff checks passed. Parent reran smoke and final diff check; independent verifier confirmed exception-safe cleanup.
  - Proof: three deterministic scenarios passed (success, failure, ambiguous completion), using real motor/checkpoints/files/commands with host/identity doubles. Native smoke unavailable because ancestor configuration would defeat isolation; no native host/provider started, credentials or running service reused. External paid-model execution not run.
  - Risk: medium; review deferred per user. See committed assessment and slice evidence below.
- [ ] **T3 — Integrate current main and deliver.** Route: delegated direct; triggers: multi-file merge and compatibility verification. Integrated upstream `f8962d2b3750f8a86bc4c1e3e11c0772dae7d1e6`, resolving conflicts in adapter documentation and workflow tests while preserving both behaviors. Fixed restored interrupted batches to invalidate affected evidence without discarding completed task IDs/prior results. RED: 49 passed / 1 failed; GREEN: 50 passed / 0 failed. Final focused suite: 481 passed / 0 failed / 1 skipped; full suite: 1,098 passed / 0 failed / 2 known skips. Typecheck, build, both diff checks, empty unmerged index and marker search passed; parent reran typecheck. Native risk: medium. Integration commit and authorized normal push still pending; review and native-host proof remain deferred/unavailable.

## Verification and recovery

Dependencies are absent initially; install only locked local dependencies without changing manifests or global configuration. Source-mutating normalization precedes final checks and native candidate freeze. Parent spot-checks one reported command per task. Check off only observed outcomes and record unavailable checks explicitly.

## Progress

- Investigation completed from a clean initial worktree; T1 verified with regression tests.
- User initially selected a future PR chain, then explicitly authorized fetching origin/main and direct normal push to main using existing Git authentication.
- T1 adds 851 authored lines because its coherent durability boundary includes restart and uncertainty tests; no artificial size split.
- T2 adds 609 authored lines to keep isolation, failure cleanup, smoke scenarios and regression tests together; no artificial size split.
- Real-host/model proof remains unavailable; passing doubles is not native proof. A huge individual deliverable and provider/context limits remain limitations.
- T2 commit: `584c84df7811719b2ecf5f82e5c71c49def3d431`, second future PR slice, based on T1. Committed native assessment: medium, 624 lines including progress-document changes, review due (`slice_budget_reached`) but explicitly deferred. No START or capture was invoked for T2.
- Both implementation tasks are committed. Upstream fetch completed: four incoming commits, three local commits; common base `57b0857c9374204dd2ddfc745f62b229107a5f10`.
- T3 compatibility coverage includes retained completion across interruption, complete Spanish context, stale-result rejection and final full-plan Verify.
- Next: commit the verified merge and perform the authorized normal direct push. Deferred review/native-host validation remain separate; no publication performed yet.
