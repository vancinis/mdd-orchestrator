# Adaptive low, structured medium, deep high

## Objective and authorization

Implement the approved adaptive-low contract locally: low selects the next necessary actor, medium retains today's structured low, and high retains the deep workflow. The user authorized implementation after the analysis, contract, and minimal plan. Remote operations, push, PR creation, merge, global installation, permission expansion, and Security/Judgment Day protocol changes are not authorized.

## Problem and rationale

Fresh low currently requires Explore -> Risk -> Plan -> Apply -> Verify. Small, clear work needs a bounded adaptive lane without mandatory Plan or Verify actors, while preserving authorization, scoped assignments, evidence honesty, and recoverable progress.

## Scope and constraints

- Low eligibility depends on clarity, bounded dependencies, impact, and feasible proof, not file or line counts.
- Select Explore, Risk, Plan, Apply, or Verify by need; retain one active writer.
- Hold a compact versioned objective, acceptance, edit-scope, assignment, decisions, and evidence contract. Never fabricate omitted phase results.
- A separate Verify actor is optional; required failed or missing evidence prevents verified completion, not authorized correction or continuation.
- Preserve native tool permissions and existing structured-evidence assurance; do not add a new command-attestation subsystem.
- Preserve valid completed work on restart, transfer, or escalation; invalidate affected stale evidence.
- Historical low keeps its original semantics. Keep the current public/default workflow until final coherent activation.
- Approximately 400 authored changed lines per unit is advisory only; no code golf, omitted tests, or artificial splits.

## Repository and execution policy

- Feature branch: `feat-low-medium-high` (existing, not the default branch).
- Branch point / starting HEAD: `683c745`.
- Implementation route: delegated direct, one bounded writer per work unit.
- TDD mode: default applicable ODD test-first policy, not explicitly configured strict mode. Source: installed orchestrator instructions; relevant deterministic changes require observed RED -> GREEN -> REFACTOR. Conditional strict wording in global configuration is not activation.
- Runner: build TypeScript, then Node tests with `--import ./tests/isolate-home.mjs`.
- RDD: off, deciding source `clone_local`; do not start or enable native review. Assess each writer diff for independent verification requirements.
- Engram mirror: pending; project-scoped `mem_save` currently refuses with `session_project_mismatch`. Do not guess or rebind project/session identity.

## Delivery forecast and boundaries

- Delivery strategy: `ask-on-risk`; chain strategy: `feature-branch-chain`, explicitly selected by the user as "Integración conjunta (Recomendado)". Keep the feature isolated until coherent integration. Future tracker/child PR creation requires separate publication authorization.
- Forecast: AL-01 approximately 300-500 authored changed lines; whole feature approximately 2,200-4,000, excluding generated output. Estimates are not acceptance gates.
- Running committed work-unit authored changed lines: 486 (+467/-19), excluding generated output and tracking.
- Work-unit commit: AL-01 `9874049bf3774c45a88ce55e6c936abd1a0a8187`, based on `683c745`. Future slice boundary: this coherent unit; no PR exists. Its 486-line footprint exceeds the advisory budget because the bounded pin-preservation correction requires five regression tests; retain tests and report the overage rather than cosmetic splitting.
- Each task closes only after observed outcomes/checks and a local Conventional Commit with behavior, tests, and relevant docs. No AI attribution.

## Actionable checklist

- [x] **AL-01 — Version routing and preserve historical interpretation.** Added an explicit inactive routing-contract discriminator, preserved omitted/explicit-fixed semantics, refused unsupported/inactive execution, prevented pinned replay from falling back to legacy inference, kept historical Risk equality, and integrity-bound explicit request versioning across checkpoint/restart/transfer. Added a pure future assessment reader separating impact from complexity. Route: delegated; triggers: unfamiliar preparation, multiple non-trivial source/test files. Acceptance observed: old histories and unmarked seals remain compatible; explicit version survives recording and transfer; tampering fails closed; adaptive execution is not exposed. Commit: `9874049bf3774c45a88ce55e6c936abd1a0a8187`. Verification below.
- [ ] **AL-02 — Admit compact contracts and select one native actor.** Add guarded actorless selection and compact acceptance/scope/assignment/evidence contracts, with Apply-only and Explore -> Apply internal paths without fabricated Plan results. Route: delegated; triggers: multi-file runtime behavior and test implementation. Acceptance: invalid contracts, out-of-scope writes, premature dependencies, and duplicate writers are refused. Commit: pending.
- [ ] **AL-03 — Close low honestly without mandatory Verify.** Validate final-state scope/acceptance readback and existing structured checks supplied by permitted executors; retain optional Verify, honest gaps, failure and correction semantics. Route: delegated; triggers: multi-file evidence/completion implementation. Acceptance: applicable required failure/missing evidence and stale results cannot become verified completion; scoped-worker fences remain unchanged. Commit: pending.
- [ ] **AL-04 — Preserve recovery, transfer, and escalation.** Persist compact contract and progress; reuse only still-valid completed assignments/evidence, preserve liveness/ownership and user decisions, and avoid duplicate Apply. Route: delegated; triggers: multi-file persistence/recovery implementation. Acceptance: restart and escalation retain valid work and schedule only missing/invalidated work. Commit: pending.
- [ ] **AL-05 — Activate the coherent public contract.** Expose coordinator-only selection/close/escalation operation, new fresh-run version, medium validation, adequate status and prompts, and aligned precise-edit entry. Route: delegated; triggers: multi-file plugin/schema/assets/docs integration. Acceptance: mocked native end-to-end scenarios work, historical runs remain bound to their own semantics, and no new Security/JD permissions or arbitrary actor dispatch are introduced. Commit: pending.

## Applicable checks

Per unit: meaningful deterministic RED before implementation, focused GREEN and refactor checks, `npm run typecheck`, `npm test`, structural diff/scope readback, native risk assessment with RDD off, independent verifier if high/unassessable, and one parent command spot check. Tests import `dist`; build before focused tests. Full suite is not proof of live-model execution.

AL-01 focused commands:

```text
npm run build
node --import ./tests/isolate-home.mjs --test tests/workflow.test.mjs tests/checkpoint.test.mjs tests/phase-runner.test.mjs tests/transfer.test.mjs tests/report-check.test.mjs
npm run typecheck
npm test
git diff --check
```

## Observed baseline

- `npm ci --offline --ignore-scripts --no-audit --no-fund`: passed; 396 cached packages installed, no network fallback.
- `npm run typecheck`: passed on starting HEAD.
- `npm test`: passed; 1,973 total, 1,970 passed, 0 failed, 3 skipped. Suite took approximately 259 seconds; initial 120-second command timeout was followed by a completed foreground run without timeout.
- Skips: `artifacts: rejects a symlink artifact file without modifying its target` and `symlink content is never followed or emitted` require unavailable Windows symlink privileges; `isolated installed Engram managed smoke: bootstrap, reuse, readback, owned shutdown` was skipped without a reported reason.
- No baseline test failures observed; tracked files unchanged after setup.
- Pre-write risk assessment refused because no pending candidate existed; result was high/unassessable, not a low-risk finding. Reassess the actual writer diff.

## Progress and next action

AL-01 implementation, applicable checks, and local work-unit commit are complete. AL-02 through AL-05 have not started. No adaptive execution or public medium route is active yet.

### AL-01 observed evidence

- Initial meaningful RED: focused 254 total, 234 passed, 20 failed; failures covered explicit pin admission/persistence/seals, inactive versions, replay fencing, and independent future assessment. Existing historical guards passed. Initial GREEN: 255 passed.
- Independent verification reproduced a contract defect: non-enumerable own routing pins were accepted but lost by object rest/structured cloning, allowing saved requests to lose pin integrity and invalid pins with legacy routes to evade rejection. No JSON-wire or high-severity exploit was established.
- One bounded correction validates own pins before lossy extraction and materializes the accepted pin on recording. Correction RED: 260 total, 255 passed, 5 failed; GREEN: 260 passed. No global cloning or permission changes.
- Final writer checks: `npm run build` passed; focused five-file command 260 passed, 0 failed, 0 skipped; `npm run typecheck` passed; `npm test` 2,000 total, 1,997 passed, 0 failed, 3 baseline skips; `git diff --check` passed.
- Native assessment of the pending writer diff returned high/unassessable because the untracked task file requires an explicit inventory declaration. No RDD lifecycle was started; the off-state high/unassessable verification path was applied.
- Independent targeted recheck: build and focused 260 tests passed; three original probes passed (own-pin persistence/seal/restart and legacy fencing, 20 invalid-pin combinations, directly affected caller-mutation and legacy-array compatibility). Same finding resolved, no direct regression confirmed. Authored files remained read-only.
- Parent spot check after final correction: `npm run typecheck` passed; structural workflow diff and `git diff --check` passed.
- Authored candidate: 13 files, +467/-19. The increase beyond the advisory estimate includes five necessary own-property regression tests; no size-only rework or omitted proof.
- Limits: no model-backed/real-host execution, no active adaptive lane yet, and three baseline skips retained. Checkpoint v1 cannot carry explicit pins because it has no seal; v2/v3 preserve unmarked digests while binding explicit pins.
- Work-unit commit: `9874049bf3774c45a88ce55e6c936abd1a0a8187`, Conventional Commit `feat(routing): pin fixed contracts and preserve replay integrity`. RDD outcome: off/unmanaged; native assessment high/unassessable with ordinary independent verification, not native approval. Post-commit status showed only the untracked task document; no commit hook mutated the verified authored candidate.

Next: persist this tracking update, then begin AL-02 under the selected feature-branch-chain strategy with exact bounded edit surfaces and deterministic checks. No push, PR creation, merge, or global installation is authorized. Mirror remains pending after the attempted full-document save refused with the existing project/session binding mismatch.
