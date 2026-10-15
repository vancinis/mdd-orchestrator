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
- Forecast: original whole-feature estimate was 2,200-4,000 authored changed lines. Revised planning range: approximately 5,500-8,500, reflecting separately verified durability, transfer and structured-continuation boundaries and remaining public integration. Estimates exclude generated output and are not acceptance gates or authorization to expand behavior.
- Running committed work-unit authored changed lines: 6,916 (AL-01 486; AL-02 1,024; AL-03 652; AL-04a 1,150; AL-04b 1,146; AL-04c 926; AL-05a 1,532), excluding generated output and tracking.
- Work-unit commit: AL-01 `9874049bf3774c45a88ce55e6c936abd1a0a8187`, based on `683c745`. Future slice boundary: this coherent unit; no PR exists. Its 486-line footprint exceeds the advisory budget because the bounded pin-preservation correction requires five regression tests; retain tests and report the overage rather than cosmetic splitting.
- Each task closes only after observed outcomes/checks and a local Conventional Commit with behavior, tests, and relevant docs. No AI attribution.

## Actionable checklist

- [x] **AL-01 — Version routing and preserve historical interpretation.** Added an explicit inactive routing-contract discriminator, preserved omitted/explicit-fixed semantics, refused unsupported/inactive execution, prevented pinned replay from falling back to legacy inference, kept historical Risk equality, and integrity-bound explicit request versioning across checkpoint/restart/transfer. Added a pure future assessment reader separating impact from complexity. Route: delegated; triggers: unfamiliar preparation, multiple non-trivial source/test files. Acceptance observed: old histories and unmarked seals remain compatible; explicit version survives recording and transfer; tampering fails closed; adaptive execution is not exposed. Commit: `9874049bf3774c45a88ce55e6c936abd1a0a8187`. Verification below.
- [x] **AL-02 — Admit compact contracts and select one native actor.** Added guarded actorless selection and compact acceptance/scope/assignment/evidence contracts, with Apply-only and Explore -> Apply internal paths without fabricated Plan results. Uses a volatile internal admission path with genuine native objective proof, exact actor handles, existing scoped-editor fences, and non-resumable pending-child protection; no public startup or unsupported adaptive checkpoints. Route: delegated; triggers: multi-file runtime behavior and test implementation. Acceptance observed: invalid contracts, out-of-scope writes, premature dependencies, and duplicate writers are refused; settled actors return to selection without implying closure. Commit: `17cfb3a8f753659d1cb62ee642c6c6d1ae3ec451`. Verification below.
- [x] **AL-03 — Close low honestly without mandatory Verify.** Added final-state scope/acceptance readback and existing structured checks supplied by permitted parent tools; optional Verify, honest gaps, failure and correction semantics retained. Route: delegated; triggers: multi-file evidence/completion implementation. Acceptance observed: applicable required failure/missing evidence and stale results cannot become verified completion; scoped-worker fences remain unchanged. Explicit bounded completed-assignment repair invalidates affected proof without blindly duplicating successful unrelated work. Commit: `73a3073341b3625f34a4a797769e3916d1830a5e`.
- [x] **AL-04 — Preserve recovery, transfer, and escalation.** Durable recovery, native-proven transfer and executable structured continuation implemented in AL-04a/b/c. Route: delegated; triggers: multi-file persistence/recovery implementation. Acceptance observed: valid completed work and evidence retained, authority rotated/fenced, only remaining or explicitly invalidated work becomes writable. Commits: `a961ac4`, `dae9a7b`, `4833376`.
  - [x] **AL-04a — Durable recovery.** Separate bounded adaptive record/store, validated restoration and staged publication implemented. Pending attempts persist before native arguments and accepted settlement before releasing ownership. Actorless restore uses fresh handles; unknown/running-child quarantine, original admission context, valid completion, failed attempt history and stale-proof invalidation retained. Fixed checkpoints unchanged. Commit: `a961ac4015b7bf53a395f5aee8bddeb9406228ec`. Evidence below; AL-04b/04c remain pending.
  - [x] **AL-04b — Native-proven transfer.** Adaptive-specific ownership publication and interruption reconciliation implemented; fresh target proof, occupied-target/source-race protection, data-only transfer and no old dispatch/consent reuse. Commit: `dae9a7b007216fd303920c82378a14d48a91b167`. Evidence below; AL-04c remains pending.
  - [x] **AL-04c — Executable escalation.** Real medium Plan / high Propose-Spec-Design-Tasks continuation and structured Verify, retained-work validation and only missing/invalidated scoped Apply; no fabricated predecessor results or scope expansion. Commit: `4833376b03a7b4ce997155bb9a026fd1e13b038d`.
- [ ] **AL-05 — Activate the coherent public contract.** Expose coordinator-only selection/close/escalation operation, new fresh-run version, medium validation, adequate status and prompts, and aligned precise-edit entry. Route: delegated; triggers: multi-file plugin/schema/assets/docs integration. Acceptance: mocked native end-to-end scenarios work under configured automatic/interactive approval policies without silently changing the user's mode; historical runs remain bound to their own semantics; no new Security/JD permissions or arbitrary actor dispatch are introduced. Commit: pending.
  - [x] **AL-05a — Native policy bridge, inactive.** Configured mode/preferences frozen; unset mode asks only the existing native mode question. Durable single-use interactive approval binds actual question result, exact operation, current run/generation/handle/source bytes. Product questions resolve before immutable admission or pause via actual actor receipt links; no raw approval flag/user-text provenance. Public registration unchanged. Commit: `553d944c85103be09067040ded3e60d493d09d78`.
  - [ ] **AL-05b — Usable versioned protocol, inactive.** Strict operation-specific request decoding, bounded protected operation descriptors and detail readback, honest version-3 native-context-required kernel/CLI projection, legacy semantics unchanged.
  - [ ] **AL-05c — Atomic public activation.** Register coordinator-only native tool once complete, update version-specific agents/shared instructions, replace untracked precise-edit implementation policy, and prove actual registered-tool/hook scenarios before declaring active.

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

AL-01 through AL-04 and subunit AL-05a implementation, applicable checks and local work-unit commits are complete. AL-05 stays open for AL-05b/05c. Internal adaptive work includes native interactive policy, but no public adaptive execution or medium route is active yet.

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

### AL-02 boundary rationale

- Reuse real runner dispatch, native objective inspection, report inspection, ownership/liveness checks, and scoped WorkerFence editing rather than construct a fake fixed Workflow or unused scheduling engine.
- Keep the initial adaptive lane process-local and unregistered. Persist only existing non-resumable pending-child protection; AL-04 owns full recoverable adaptive contracts. Public routingVersion 3 remains rejected until coherent activation.
- Scoped Apply stores honest unexecuted check obligations; AL-03 must provide permitted evidence execution without relaxing its command fence or making Verify mandatory.
- New modules planned: `src/adaptive-low.ts`, `tests/adaptive-low.test.mjs`; bounded integration spans runner/intake/next-action/status/check-parser and their tests. Forecast approximately 650-1,000 authored changed lines for the coherent native boundary, advisory only.
- Fresh exact runner: build, then Node tests for adaptive-low, phase-runner, native-intake, next-action, status-budget, and worker-fence; typecheck and full suite at closure. Preserve all AL-01 compatibility guards.

### AL-02 observed evidence

- Source commit: `17cfb3a8f753659d1cb62ee642c6c6d1ae3ec451`, Conventional Commit `feat(low): admit scoped adaptive actors internally`, based on `aef163b`. Future slice boundary: this coherent internal native unit; no PR exists.
- Initial behavioral RED: focused 268 total, 247 passed, 21 failed (missing internal admission/selection and actorless metadata). Subsequent focused RED cases covered stopped transport failure, exact multiline objectives, cold restart quarantine, and strict context enums; all GREEN in final runs. One stale-dist intermediate run was rebuilt and not counted as proof.
- Initial writer checks: build/typecheck/diffcheck passed; focused 280 passed; full suite 2,033 total, 2,030 passed, 0 failed, 3 baseline skips.
- Native assessment returned high/unassessable because new source/test files were untracked. RDD remained off; ordinary independent verification was applied, with no lifecycle start or approval claim.
- Independent original probes confirmed two defects: cold attestation released adaptive quarantine while native child liveness remained unknown, and prerequisite fingerprints were not rechecked between selection and dispatch.
- One bounded correction requires native stopped proof for cold adaptive recovery without changing historical non-adaptive attestation; shared readiness checks revalidate completed outputs and unchanged dependency inputs before/after asynchronous admission and at begin. No global permission changes or progress-schema changes.
- Correction RED: focused 288 total, 283 passed, 5 failed. Eight new regression/control tests cover recovery/freshness findings, historical controls, and unrelated drift.
- Final writer build/typecheck/diffcheck passed; focused 288 passed, 0 failed/skipped; full `npm test` 2,041 total, 2,038 passed, 0 failed, 3 baseline skips.
- Independent same-findings recheck: build/focused 288/diffcheck passed and nine original/direct-control probes passed. Unknown/running children remain reserved/pending/scoped; confirmed stopped recovery works; dependency drift refuses dispatch safely; unrelated future-assignment drift does not block A2. Replay/generic editor/shell/out-of-scope writes remain denied.
- Parent final `npm run typecheck`, diff check, and targeted source-readback passed.
- Candidate: 12 authored files, +1,018/-6 (1,024 changed lines), excluding generated output/tracking. Required trust-boundary integration and correction/control tests explain the coherent overage; retain proof rather than cosmetic splitting. Future PR slicing/size-exception policy remains unresolved until publication is requested.
- Limits: process-local unregistered lane, automatic-profile admission only, no completed-assignment repair yet, no executed command obligations, no closure/escalation/full resume, and no live model/host proof. These are explicit AL-03/04/05 obligations, not claims of a complete public feature.
- Post-commit status showed only the parent task document modified; commit hooks did not change the verified source candidate. RDD outcome: off/unmanaged, ordinary independent verification, not native approval.

### AL-03 implementation boundary

Preparation complete. Ordinary coordinator tools already permit parent checks; no new executor, permissions, or command-attestation subsystem is required. Add serialized internal evidence preparation/submission/closure bound to the native coordinator, current handle, idle ownership, and final local source snapshot. Reuse command accounting without fabricating command executions for source-only obligations. Keep final diff/scope/acceptance readback explicitly reported evidence, not independently attested whole-worktree proof. Retain optional read-only Verify and explicit bounded completed-assignment repair with affected-proof invalidation. Public activation and full durable replay remain AL-05/AL-04 responsibilities.

### AL-03 observed evidence

- Source commit: `73a3073341b3625f34a4a797769e3916d1830a5e`, `feat(low): close adaptive work with scoped final evidence`; eight files +635/-17 (652 authored changed lines). Necessary failure-path tests retained despite advisory overage.
- Behavioral RED: initial 54 total/37 passed/17 failed; further regression runs 65/63/2, 67/65/2, and 76/75/1 covered attempt-history retention, malformed resubmission/disposition, hidden supplemental retries, and repair invalidation. Compiler/fixture issues and stale builds are not RED proof.
- Final writer: build passed; focused seven-file command 441 passed, zero failures/skips; typecheck passed; full npm test 2,083 total, 2,080 passed, zero failed, three unchanged baseline skips; diff check passed.
- Parent: final typecheck, diff check and structural source/API/doc readback passed. Native assessment schema v1 risk medium, executable-change reason. RDD off/unmanaged; normal-profile writer self-verification plus parent spot check applies, no separate verifier required or launched.
- Guarantees: exact coordinator/handle/ownership checks after native awaits; snapshot preparation before commands; source drift rejected at submission and closure; source-only links separate from command execution; required failure/missing proof blocks verified closure; malformed resubmission removes the prior current match; retries/failures remain visible; explicit bounded repair preserves unrelated work.
- Limits: structured parent-reported command/applicability and diff consistency, not independent execution or comprehensive whole-worktree attestation. Internal contracts and closure remain volatile, no live host/model proof, no public activation or full resume/escalation. No new command executor or relaxed child permissions.
- Commit hooks did not alter the verified source candidate; only parent tracking remained modified after the source commit. Task mirror remains pending known project/session mismatch.

### AL-04 boundary rationale

Read-only preparation found fixed checkpoint/ownership transfer and dossiers cannot directly represent adaptive records without invented Workflow events. Use a separate bounded adaptive store/schema, keeping old checkpoint digests and public version-3 refusal intact. Restore must distinguish original admission fingerprints from settled output/eligibility evidence. Current settlement ordering also needs accepted-receipt persistence before reservation release. Implement three coherent local subunits under AL-04, each with tests/docs and a work-unit commit; AL-04 stays unchecked until all pass. This trust-boundary integration increases the original rough estimate; revise the total forecast as observed work becomes available rather than omitting proof or adding a generic workflow framework.

### AL-04a observed evidence

- Source commit: `a961ac4015b7bf53a395f5aee8bddeb9406228ec`, `feat(low): persist adaptive work and recover interrupted actors`. Nine authored files +1,104/-46 (1,150 changed lines), including 503 lines of store/recovery fault and regression tests. No size-only code reduction.
- An interrupted writer invocation left partial edits despite an incomplete error result. Parent captured Git state and delegated read-only diagnosis before resuming. All nine dirty paths were retained; no destructive recovery. Original implementation RED history is unavailable, not inferred from authored tests.
- Resumed writer observed eight additional behavioral regression failures before corrective patches; focused 463 passed and typecheck/build/diff check passed. Initial full suite timed out at 600 seconds without final totals; no full-pass claim was made for that run.
- Native risk assessment high/unassessable due new untracked source/test files; RDD stayed off. Ordinary independent verifier reproduced a P1: stale prerequisite invalidation left a pending dependent record that its own validator rejected, stranding stopped recovery.
- One bounded correction retains validated successful receipt links for historical transitive dispatch prerequisites, separate from current writer eligibility. Three new liveness-control regressions observed RED then GREEN, plus a transitive control. Missing/forged links remain rejected; new Apply still requires current proof and explicit repair.
- Final writer commands: build passed; focused eight-file command 467 passed, no failures/skips; typecheck passed; full `npm test` 2,138 total, 2,135 passed, zero failed, three unchanged baseline skips, 674.2 seconds in one 900-second bounded attempt; diff check passed. Original 600-second timeout is superseded by completed final-candidate proof, not hidden.
- Independent targeted recheck: build/focused 467/diff check passed; four original runtime probes passed covering pending prerequisite drift with repeated restore and native stopped recovery, bootstrap readback fault, pending readback fault, settlement readback fault and old-process callback fencing. Accepted or interrupted receipts were durable before release; no provider arguments escaped failed pending publication.
- Parent final typecheck/diff check and structural source/doc readback passed. Post-source-commit state showed only parent tracking modified; no commit-hook source mutations. No live host/model or native review approval claimed.
- Production store is injected through existing product data-root wiring. Fixed checkpoint/transfer exclusion guards remain intact. Unsafe/uncorrelated reservations remain fenced, not automatically reclaimed. Adaptive transfer and executable escalation are intentionally still pending.
- Mirror remains pending due known project/session mismatch; local progress is canonical.

### AL-04b implementation boundary

Preparation complete. Reuse ownership locks, epoch CAS, parent claims and former-owner fencing, with a distinct bounded adaptive projection/publication validator and exact-operation receipt. Never feed adaptive data into fixed checkpoint transfer or manufacture Workflow events. Prove both native parents plus fresh latest target-authored source/run/objective authorization before claims; recheck occupancy and authority after awaits. Transfer validated data only, preserve or selectively invalidate proof, rotate handles, and fence source readers/writers before publication. Correlated target claim, source transfer fence, target publication/readback and ownership receipt must support exact explicit finish/abort after interruption, never blind retries or dual writers. Public tools and cross-worktree execution are not part of this unit.

### AL-04b observed evidence

- Source commit: `dae9a7b007216fd303920c82378a14d48a91b167`, `feat(low): transfer adaptive work with native ownership proof`. Ten authored paths +1,120/-26 (1,146 changed lines), including 551 lines of native transfer/fault tests. Tests remain with the coherent behavior; no size-only reduction.
- Meaningful initial RED covered missing internal admission/owner fencing, missing positive native idle proof, intake races during inspection, cleanup before occupancy checks, and changed parent claims before deletion. Intermediate fixture/compiler issues were not behavioral RED.
- Initial writer final build/focused 528/typecheck/full 2,229 total, 2,226 passed, zero failed, three baseline skips/diff check passed. The independent verifier was interrupted; parent confirmed unchanged candidate and resumed that exact read-only verification, without redoing implementation.
- Native assessment high/unassessable due new untracked source/tests; RDD remained off. Independent checks built and passed focused 528 plus four original probes: actual inspector child liveness/history, actual exact-message provenance, cold transferred pending-child fencing, and chained-transfer recovery.
- The fourth probe found P2: reusing an operation ID in A-to-B then B-to-C could select the prior hop's receipt in the late recovery branch, leaving a valid current transfer stuck. No dual writer was observed.
- One bounded correction reuses only a receipt confirmed against exact current endpoints and durable claim/epoch/generation/digest lineage; interrupted current-hop recovery constructs its own proof. Exact regression RED: five total, four passed, one failed; GREEN five passed. Four tamper controls reject changed owner epoch/source sequence/source digest/target digest before native validation.
- Final writer build/typecheck/diff check passed; focused eight-file command 533 passed, zero failed/skipped; full npm test 2,234 total, 2,231 passed, zero failed, three unchanged baseline skips, 362.62 seconds.
- Independent targeted recheck passed build/focused 533/diff check, exact original chained cold-finish reproduction, old receipt refusal, repeated cold finish, and four lineage-tamper controls. No direct correction regression observed. Parent final typecheck/diff check and structural source/doc readback passed.
- Limits: deterministic local native/runtime harness and synthetic SDK proof, not live host/model or native approval. No actual conversation transfer, cross-worktree execution, public tool registration or escalation. Incomplete native history/divergent state remains fenced. Existing fixed transfer interpretation and AL-04a recovery remain unchanged.
- Post-source-commit state showed only parent tracking modified; no source-changing commit hooks. Mirror remains pending known project/session binding mismatch.

### AL-04c implementation boundary

Preparation complete. Add one bounded durable continuation controller alongside the immutable admission contract, not a second Workflow/graph. Medium executes genuine Plan, remaining scoped Apply and Verify; high executes genuine Propose, Spec, Design, Tasks, remaining scoped Apply and Verify. Parent selects each authorized next stage; no automatic dispatch or fabricated predecessor results. Keep valid retained assignment IDs/bindings, validate actual remaining-work reports against full held acceptance/decisions/scope, and use the effective retained-plus-remaining assignment view for execution and AL-03 closure. Preserve journal/transfer/recovery and original admission digest; high roles are selectable only as the frozen sequence's next stage. Store bounded real report artifacts in the adaptive journal without expanding external fixed-phase artifact identities. Public activation remains AL-05.

### AL-04c observed evidence

- Source commit: `4833376b03a7b4ce997155bb9a026fd1e13b038d`, seven files +877/-49 (926 authored changed lines). Actual sequence, effective assignment execution, structured Verify and durable/transfer controls remain one coherent unit with their tests.
- Behavioral RED included eleven missing native escalation cases, three historical-evidence/empty-plan/check-history cases, retained repair, and two forged frozen-context cases; subsequent checks passed. Compiler/fixture corrections were not RED proof.
- Initial writer build/focused 486/typecheck/full 2,277 total, 2,274 passed, zero failed, three baseline skips/diff check passed. Native assessment high/unassessable due new untracked helper/tests; RDD stayed off, independent verification applied.
- Independent original probes found P1 snapshot rebinding could substitute a fresh Verify snapshot during cold restore, and P2 mutable stored planning fields could change actual Apply instructions/checks without changing its actual receipt.
- One bounded correction separately retains accepted structured payload in actual native receipts, plus Verify snapshot and exact parent command history frozen before dispatch and checked on acceptance/restore. Both original runner-level repros observed RED then GREEN; seven additional regressions cover swaps, history, stale Verify and transfer.
- Final writer build/typecheck/diff check passed; focused eight-file command 493 passed, no failures/skips; full npm test 2,284 total, 2,281 passed, zero failed, three unchanged baseline skips, 355.56 seconds.
- Independent targeted recheck passed build/focused 493/diff check and both original corrupt-projection repros; cold legitimate stale/current history, fresh Verify context and transfer controls passed. Parent final typecheck/diff check and structural source/doc readback passed.
- Limits: relational consistency, not authentication against coordinated rewriting of every receipt/evidence source or independent command attestation. Native/runtime proof uses local synthetic harnesses, not live host/model. Historical non-continuation receipts remain compatible; missing accepted structured payload fails closed. Public activation remains pending.
- Post-source-commit state showed only tracking modified; no commit hook changed verified bytes. Mirror remains pending known project/session mismatch.

### AL-05 boundary rationale

Public registration alone would leave automatic-only internal admission and fixed-phase question bindings. Implement inactive policy and protocol prerequisites first, then activate once all paths are usable. Reuse native question inspection/lifecycle with an explicit adaptive binding rather than a fake fixed checkpoint. Honor configured interactive/automatic preferences without auto-switching; missing mode uses the existing mode question alone, not mandatory four-field preflight. New low remains need-driven; structured medium/high retain genuine sequences. Legacy fixed entry/replay stays compatibility-only, new native context owns version 3. No telemetry/dossier/config rewrite merely to rename route labels; derive only functional surfaces.

### AL-05a observed evidence

- Source commit: `553d944c85103be09067040ded3e60d493d09d78`, `feat(low): bind adaptive policy to native operation approvals`. Eleven authored paths +1,485/-47 (1,532 changed lines). Native approval, durable source fencing, compatibility and failure-path tests retained as a coherent unit.
- Initial allowlist gaps were resolved by parent-authorized exact adaptive-low/test and run-ownership/test surfaces; no business scope expansion. Behavioral RED covered configured interactive admission, automatic preference without consent, unset-mode-only question, actual actor-question persistence, asynchronous intake/clarification and source-fence matching.
- A pre-final suite exposed interactive transfer blocked by its own settled target approval. This was corrected using exact consumed adaptive receipts and a durable source-policy fence; no receipt deletion or general occupancy bypass. The failed result was not treated as environmental.
- Initial writer candidate final focused 477/full 2,343 total, 2,340 passed, zero failed, three baseline skips passed. Native assessment high/unassessable due new bridge/tests; RDD remained off and ordinary independent verification applied.
- Independent original probe found P1: automatic transfers with no question history skipped declared-byte checks during asynchronous transfer proof. One bounded correction retains the current consumed proof rather than relying on historical question generations. RED: eight total, four passed, four failed; GREEN nine passed with claim/fence/history/epoch controls.
- Final writer build/typecheck/diff check passed; focused eight-file command 486 passed, zero failed/skipped; full npm test 2,352 total, 2,349 passed, zero failed, three unchanged baseline skips, 242.18 seconds.
- Independent targeted recheck passed build/focused 486/diff check and four original probe groups: automatic current-proof races plus irrelevant history, native operation/call/replay/cold-generation substitution, answered-unapplied question restart without consent, and actor/pre-admission product-answer authority. Parent final typecheck/diff check and structural source/doc readback passed.
- Frozen interactive preferences survive transfer; actual mode answers selecting automatic remain preferences, not invented approval. Interrupted questions do not resume as live consent. Actor answers add linked context without changing held business authority or earning completion.
- Limits: internal unregistered bridge only; local runtime/synthetic SDK evidence, not live host/model approval, command attestation or coordinated whole-file rewrite authentication. Public protocol/projection and registration are still AL-05b/05c obligations. Post-commit state showed only tracking modified; no source-changing hooks. Mirror pending known binding mismatch.

Next: AL-05b strict protocol/status/detail readback, then AL-05c atomic public activation. Continue cached feature-branch-chain without asking again. No push, PR creation, merge, or global installation authorized. Mirror remains pending after the full-document save refused with the existing project/session binding mismatch.
