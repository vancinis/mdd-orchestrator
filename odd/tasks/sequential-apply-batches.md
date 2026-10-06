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
- No global installation, push, PR creation, merge or remote execution.
- Technical artifacts are English. Keep tests/docs with behavior.

## Delivery

- Branch: `feat-apply-improvements`; initial reviewed boundary: `57b0857c9374204dd2ddfc745f62b229107a5f10`.
- Strategy: `ask-on-risk`, resolved by user: `stacked-to-main` (future dependent PR slices directed to main).
- Forecast: approximately 1,100–1,650 authored changed lines, mostly regression tests; generated output excluded.
- Running authored count: 1,460 (T1: 851; T2: 609), excluding this progress document. No PRs created; slice boundaries follow work-unit commits.
- RDD: on, global source. User explicitly deferred review until later and authorized continuing T2. Preserve the existing T1 transaction without approval, decline, abandonment or mode changes; do not retry it automatically. T2 is a separate implementation work unit with ordinary functional checks.
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

## Verification and recovery

Dependencies are absent initially; install only locked local dependencies without changing manifests or global configuration. Source-mutating normalization precedes final checks and native candidate freeze. Parent spot-checks one reported command per task. Check off only observed outcomes and record unavailable checks explicitly.

## Progress

- Investigation completed from a clean initial worktree; T1 verified with regression tests.
- User selected a future chain directed to main; this does not authorize publication.
- T1 adds 851 authored lines because its coherent durability boundary includes restart and uncertainty tests; no artificial size split.
- T2 adds 609 authored lines to keep isolation, failure cleanup, smoke scenarios and regression tests together; no artificial size split.
- Real-host/model proof remains unavailable; passing doubles is not native proof. A huge individual deliverable and provider/context limits remain limitations.
- T2 commit: `584c84df7811719b2ecf5f82e5c71c49def3d431`, second future PR slice, based on T1. Committed native assessment: medium, 624 lines including progress-document changes, review due (`slice_budget_reached`) but explicitly deferred. No START or capture was invoked for T2.
- Both implementation tasks are committed. Next: resume the deferred review and native-host validation later under explicit user authorization and a safely isolated host. No publication performed.
