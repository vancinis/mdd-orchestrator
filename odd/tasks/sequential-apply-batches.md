# Complete large changes through sequential Apply batches

Implement one bounded planned deliverable per fresh Apply actor, automatically advancing after durable success and verifying the entire change only after all deliverables finish.

## Problem and evidence

Apply currently receives the whole plan; completion IDs are discarded and a passed Apply advances directly to Verify. No changed-line ceiling was found. The cause of the reported 2,600-line interruption remains unproven. Repeated Apply artifacts, evidence aggregation and restart correlation need batch-aware handling.

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
- Running authored count: 851 for T1, excluding this progress document. No PRs created; slice boundaries follow work-unit commits.
- RDD: on, global source. Native risk and candidate consent remain provider-owned.
- TDD: no configured mode found; default applicable test-first policy. Runner: Node v26.9.0, `npm run build` then Node test runner.
- Engram mirror: `odd/sequential-apply-batches/tasks` in runtime session project `mdd` (repository detection uses `mdd-orchestrator`).

## Tasks

- [x] **T1 — Durable sequential Apply execution.** Route: delegated direct; triggers: unfamiliar preparation, multi-file state-machine/runtime implementation. Exact-ID batching, replayable completion/rework epochs, immutable artifacts, aggregate evidence and pending-write fences implemented. RED: workflow 17 passed / 1 failed; GREEN: focused 364 passed / 1 skipped; full suite 1,067 passed / 0 failed / 2 skipped. Typecheck, build and diff check passed; parent independently reran typecheck. Baseline focused run timed out after 120 seconds; no complete baseline claimed. Local locked dependencies installed without manifest changes; 9 reported dependency vulnerabilities left untouched. Skips: Windows symlink privilege and gated managed-Engram smoke. Risk: high/unassessable before commit because new files require inventory declaration; committed-candidate assessment pending. Commit pending.
- [ ] **T2 — Bounded planning guidance and execution proof.** Route: delegated direct; triggers: multi-file agent instructions and runtime harness. Teach Plan/Tasks/Apply/coordinator the bounded deliverable contract without expanding packaged asset limits. Add isolated runtime smoke coverage of automatic chaining and safe failure, or honestly record unavailable host proof. Document limitations (an oversized individual deliverable and external interruptions are not magically solved). Checks: focused asset/runtime tests, `npm run typecheck`, `npm test`, isolated host smoke if runnable, `git diff --check`. Commit and assessed review result pending.

## Verification and recovery

Dependencies are absent initially; install only locked local dependencies without changing manifests or global configuration. Source-mutating normalization precedes final checks and native candidate freeze. Parent spot-checks one reported command per task. Check off only observed outcomes and record unavailable checks explicitly.

## Progress

- Investigation completed from a clean initial worktree; T1 verified with regression tests.
- User selected a future chain directed to main; this does not authorize publication.
- T1 adds 851 authored lines because its coherent durability boundary includes restart and uncertainty tests; no artificial size split.
- Real-host/model proof remains pending T2. A huge individual deliverable and provider/context limits remain limitations.
- Next: commit T1 and assess its committed candidate, then implement T2 planning guidance and runtime proof.
