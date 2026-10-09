# Project-aware knowledge reuse

## Objective

Reuse validated project knowledge and relevant skills without filling the coordinator's context. Engram remains the canonical semantic memory; MDD retains operational safeguards and only a bounded, rebuildable local knowledge cache.

## Authorization and constraints

- User approved implementation of the discussed memory, selective retrieval, contextual routing and measured feedback recommendations on 2026-10-09.
- Preserve checkpoints, ownership, consent, scope, verification requirements and worker permissions. Stored knowledge is advisory data, never execution authority.
- No remote operations, publication, installation, global configuration changes or automatic policy adoption are authorized.
- Use existing configured Engram only. Follow-up PK-5 is explicitly authorized to make knowledge enabled by default while preserving explicit `knowledge.enabled: false`. Do not edit installed configuration, configure a provider, or create a project catalog. PK-1 through PK-4 originally shipped default-off.
- Reuse requires target-checkout dependency validation, including dirty and untracked files. A shared project or commit identity alone is insufficient.
- No second canonical memory database, arbitrary skill discovery, tool installation or unbounded self-improvement loop.
- Code, tests and documentation are English; user-facing orchestration remains Spanish.

## Baseline and delivery

- Baseline: `1f4b700` on `main`; initial worktree was clean.
- Feature branch: `feat/project-knowledge`.
- Delivery strategy: `ask-on-risk`; user selected `feature-branch-chain`. Keep four reviewable work-unit boundaries on the local feature line; publication, PR branches and merges remain separate user decisions.
- Forecast: 1,850-2,900 authored changed lines across four cohesive units; generated output excluded. This is an estimate, not a size limit. Keep tests and documentation with behavior; do not compress or omit them to meet a line target.
- Completed authored work units: PK-1 650 + PK-2 571 + PK-3 690 + PK-4 855 = 2,766 changed implementation/test/doc lines, tracking excluded. Net branch diff is 2,491 additions + 39 deletions = 2,530 lines. Slices: `1f4b700..2353cbe`, `2353cbe..a3e9d4d`, `a3e9d4d..487573c`, `487573c..f5adb57`. No PRs published.
- RDD: off, decided by `clone_local`; do not start reviews or change the switch.
- Verification: assess each writer diff with native risk assessment only. High/unassessable requires writer checks plus independent verification. Parent repeats one reported command before delivery.
- TDD: no explicit strict repository setting found. Apply the ODD default: observe deterministic RED, implement GREEN, then refactor. Observed evidence is recorded per completed unit below.
- Engram mirror: pending. Full-document save under `odd/project-knowledge/tasks` was refused with `session_project_mismatch`: detected project is `mdd-orchestrator`, but the registered session belongs to `mdd`. No mirror was created or alternate project selected. Local tracking remains authoritative until synchronization succeeds.

## Tasks

- [x] **PK-1: Record and query reusable project observations.**
  - Route: delegated direct; new behavior spans adapter, settings, tools and tests, requiring preparation and multiple non-trivial edits.
  - Implement opt-in, coordinator-only recording/query interfaces using supported Engram observation operations and native identity checks. Return bounded summaries/references rather than bodies to the coordinator.
  - Validate versioned envelopes, project identity, provenance, applicability and bounded source dependencies. Start records as observations; never promote model claims into policy.
  - Intended surfaces: `src/project-knowledge.ts` (new), `src/engram-http.ts`, `src/native-intake.ts`, `src/opencode-plugin.ts`, `src/settings.ts`; `tests/project-knowledge.test.mjs` (new), `tests/engram-http.test.mjs`, `tests/opencode-plugin.test.mjs`, `tests/settings.test.mjs`, `tests/adapter-fixture.mjs`; `docs/project-knowledge.md` (new), `docs/mdd-config.schema.json`, `assets/opencode/agents/mdd-orchestrator.md`.
  - Acceptance: same-project cross-session lookup works; foreign/deleted/malformed records are rejected; recording is natively grounded; uncertain writes are not blindly retried; disabled mode makes no provider calls; parent results omit bodies.
  - Checks: `npm run build`; `node --import ./tests/isolate-home.mjs --test tests/project-knowledge.test.mjs tests/engram-http.test.mjs tests/opencode-plugin.test.mjs tests/settings.test.mjs`; `npm run typecheck`; `npm test`.
  - Rollback: remove optional knowledge interfaces/settings without changing operational persistence.
  - Verified outcome: natural native request plus structured coordinator observation; no user-authored JSON workflow. Provenance explicitly records coordinator authorship, not user approval. Query results contain summaries/references only.
  - Proof: observed correction RED 0 passed/3 failed; focused GREEN 233 passed; full suite 1,773 passed/0 failed/3 skipped; build/typecheck passed. Independent verifier repeated 233 focused tests with no blockers; parent repeated `npm run typecheck` successfully. Previous three suite failures were not reproduced in a 52-test sequential diagnostic run or final full run; root cause not established.
  - Skips: two Windows symlink-privilege tests and optional installed-Engram smoke. Real-provider interoperability remains unverified.
  - Native assessment: high/unassessable due to new untracked files; independent verification performed. RDD off, disabled/unmanaged; no review started.
  - Authored unit: 650 changed lines (including tests/docs, excluding tracking). Kept cohesive rather than separating security checks or tests merely to meet an advisory line count. Commit: `2353cbe` (`feat(knowledge): record and query project observations`).

- [x] **PK-2: Cache knowledge with checkout-specific freshness.**
  - Route: delegated direct; persistent bounded cache, validation and multiple test surfaces.
  - Add one bounded, rebuildable `.mdd/knowledge-cache.json` using existing safe persistence. Validate declared dependency bytes against the target checkout, not the shared cache root.
  - Initial budget targets: 100 entries, 512 KiB total, 4 KiB per body; tighten if existing envelope limits require it. Missing files differ from empty files. Reject traversal and unsafe linked/nonregular source files.
  - Intended surfaces: `src/project-knowledge.ts`, `src/knowledge-cache.ts` (new), `src/local-files.ts`, `src/native-intake.ts`, `src/engram-http.ts`; `tests/project-knowledge.test.mjs`, `tests/knowledge-cache.test.mjs` (new), `tests/engram-http.test.mjs`, `tests/opencode-plugin.test.mjs`, `tests/adapter-fixture.mjs`; `docs/project-knowledge.md`. Intake/adapter surfaces connect capture and query to the actual checkout; they must not become a disconnected cache utility.
  - User approved wording-only extensions to `src/opencode-plugin.ts`, `docs/mdd-config.schema.json` and `assets/opencode/agents/mdd-orchestrator.md` so descriptions reflect fresh/stale/unverified results rather than PK-1's always-unverified state.
  - Acceptance: divergent linked-worktree bytes, dirty/untracked changes and deletions invalidate affected entries; unsafe paths cannot be read; eviction is bounded; cache corruption/loss does not block ordinary work. Provider outage omits optional knowledge rather than silently replaying revoked material.
  - Checks: `npm run build`; `node --import ./tests/isolate-home.mjs --test tests/project-knowledge.test.mjs tests/knowledge-cache.test.mjs tests/engram-http.test.mjs`; `npm run typecheck`; `npm test`.
  - Rollback: remove derived cache integration; canonical Engram observations and runtime state survive.
  - Proof: observed RED 1 passed/10 failed, final focused suite 174 passed, full suite 1,786 passed/0 failed/3 skipped; build/typecheck/diff-check passed. Independent verification repeated all 174 focused tests with no blockers. Parent repeated typecheck successfully.
  - Limits: freshness means declared source dependencies match, not semantic truth; cache avoids repeated envelope parsing but still requires canonical fetch and current source hashing. Tests simulate linked-worktree Git metadata; real-provider interoperability remains unverified. Same three documented environment-dependent skips as PK-1.
  - Risk: native assessment high/unassessable due new files; independent verifier completed. RDD remains off, disabled/unmanaged.
  - Authored unit: 571 changed lines, tests/docs included, tracking excluded. Commit: `a3e9d4d` (`feat(knowledge): validate checkout sources before cache reuse`).

- [x] **PK-3: Deliver selected knowledge at real dispatch boundaries.**
  - Route: delegated direct; stateful single/parallel dispatch integration and regression coverage.
  - Resolve by objective, phase and actual assignment paths. Revalidate state/ownership after asynchronous retrieval and source freshness before dispatch. Keep parent output compact and preserve mandatory scope/acceptance/verification context.
  - Cover ordinary phases, Apply workers and exploration workers. Scoped workers receive only knowledge within their declared footprint; do not expand their tools or file access.
  - Initial supplemental budget: at most three entries and 8 KiB, subordinate to existing prompt limits. Do not route selected bodies through accumulating `mdd_context`.
  - Intended surfaces: `src/project-knowledge.ts`, `src/native-intake.ts`, `src/opencode-plugin.ts`, `src/phase-runner.ts`, `src/worker-state.ts`; `tests/project-knowledge-runtime.test.mjs` (new), `tests/project-knowledge.test.mjs`, `tests/opencode-v2.test.mjs`, `tests/worker-state.test.mjs`, `tests/workers-native.test.mjs`, `tests/checkpoint.test.mjs`, `tests/adapter-fixture.mjs`; `docs/project-knowledge.md`, `assets/opencode/agents/mdd-orchestrator.md`. Worker fences and checkpoint schemas are not authorized edit surfaces.
  - Confirmed correction surfaces: `src/opencode-v2.ts`, and if required the existing `src/dispatch-transcript.ts` / `tests/dispatch-transcript.test.mjs`, only to close MDD-bound native-fallback transcript leakage. Preserve unrelated native tasks' context.
  - Acceptance: actual child prompts contain relevant fresh bodies; parent does not; assignments filter separately; stale/provider-failed retrieval is omitted; resume and dispatch correlation remain correct; worker restrictions remain unchanged.
  - Checks: `npm run build`; `node --import ./tests/isolate-home.mjs --test tests/project-knowledge-runtime.test.mjs tests/opencode-v2.test.mjs tests/worker-state.test.mjs tests/workers-native.test.mjs tests/checkpoint.test.mjs tests/worker-fence.test.mjs tests/full-native.test.mjs`; `npm run typecheck`; `npm test`.
  - Rollback: remove optional dispatch resolver while retaining original phase context and execution semantics.
  - Writer proof before independent check: retained RED 0 passed/3 failed; focused 408 passed; full 1,813 passed/0 failed/3 skips; build/typecheck/diff-check passed. Parent repeated typecheck. An earlier focused attempt timed out after 240 seconds; resumed identical command completed with timeout disabled.
  - Initial independent verification: 408 focused tests passed but an added actual-hook reproduction failed (0 passed/1 failed): native `explore` fallback receives the supplement and V2 parent transcript fails to collapse it because only named phase actors were handled. This blocked acceptance until the scoped correction below.
  - Correction resolved: exact parent/call/dispatched-argument correlation now collapses native `explore` and `general` fallbacks without changing unrelated/altered/unsettled prompts. Observed RED 4 passed/2 failed; GREEN 6 passed. Final focused 412 passed, shared transcript 8 passed, full 1,819 passed/0 failed/3 skips; build/typecheck/diff-check passed. Independent recheck repeated 412+8 tests and two actual-hook reproductions with eight negative controls; no residual blocker. Parent repeated typecheck after correction.
  - Limits: native fallback transcript correlation is process-local; restart without live binding does not infer ownership of historical prompts. This limitation is documented. Real-host/provider behavior and actual token savings remain unmeasured.
  - Authored unit: 690 changed lines, tests/docs included, tracking excluded. Commit: `487573c` (`feat(knowledge): deliver scoped context at child dispatch`).
  - Risk: high/unassessable due new test; independent verification required. RDD remains off.

- [x] **PK-4: Route approved skills and expose measurable feedback.**
  - Route: delegated direct; catalog parsing, prompt selection, metrics and integration tests.
  - Support an optional explicit, versioned per-checkout `mdd/knowledge.json` catalog with exact relative skill references and bounded deterministic applicability rules. Preserve packaged phase skills; do not crawl or install global skills.
  - Advisory tool choices may only reference capabilities available to that execution lane. Unknown tools are omitted; catalog content cannot grant permissions.
  - Expose compact candidates/fresh hits/stale rejects/selection and byte-volume diagnostics. Respect telemetry preference for persistent counters. Distinguish candidate observations, validated recommendations and explicit project policy; never auto-promote or rewrite policy.
  - Intended surfaces: `src/knowledge-catalog.ts` (new), `src/project-knowledge.ts`, `src/knowledge-cache.ts`, `src/phase-assets.ts`, `src/phase-runner.ts`, `src/local-files.ts`, `src/native-intake.ts`, `src/opencode-plugin.ts`, `src/worker-state.ts`, `src/telemetry.ts`; `tests/knowledge-catalog.test.mjs` (new), `tests/project-knowledge-runtime.test.mjs`, `tests/phase-assets.test.mjs`, `tests/project-knowledge.test.mjs`, `tests/knowledge-cache.test.mjs`, `tests/opencode-plugin.test.mjs`, `tests/telemetry.test.mjs`, `tests/adapter-fixture.mjs`; `docs/project-knowledge.md`, `docs/mdd-config.schema.json`, `assets/opencode/agents/mdd-orchestrator.md`. Additional intake/worker/telemetry paths connect compact diagnostics to actual dispatch, not a standalone unused module; permissions remain unchanged.
  - Acceptance: appropriate skills selected deterministically; unrelated/missing/unsafe entries excluded; no parent skill-body duplication; counters reflect observed retrieval/bytes without claiming token or productivity savings.
  - Checks: `npm run build`; `node --import ./tests/isolate-home.mjs --test tests/knowledge-catalog.test.mjs tests/project-knowledge-runtime.test.mjs tests/phase-assets.test.mjs`; `npm run typecheck`; `npm test`.
  - Rollback: remove optional catalog/routing/diagnostics while retaining canonical observations and operational state.
  - Implementation: explicit checkout catalog routes bounded skill excerpts to real child dispatch, sharing the three-entry/8-KiB budget with observations. Only proven available tool preferences are emitted; production currently proves `mdd_worker_edit` for scoped Apply, omitting unproven ordinary/exploration preferences. No catalog installed into this repository.
  - Initial proof: observed RED 0 passed/10 failed; focused 292 passed, compatibility 200 passed, full 1,846 passed/0 failed/3 skips. Independent verifier reproduced stale prior-task diagnostics across reset/new objective despite passing suites.
  - Correction: diagnostics bind to workflow-instance/investigation identity, not only session. Observed lifecycle RED 1 passed/7 failed, GREEN 8 passed. Final focused 300 passed, compatibility 200 passed, full 1,854 passed/0 failed/3 skips; build/typecheck/diff-check passed. Independent recheck repeated 300+200 tests and original reset/new-objective reproduction, with no residual findings. Parent repeated typecheck after correction.
  - Metrics represent latest successful delivery within the current workflow, not model consumption or delivery to an undispatched next phase. Persistent diagnostics follow telemetry opt-out; no knowledge/skill bodies in metrics. Existing real-host/token-savings limits remain.
  - Risk: high/unassessable due new files; independent verification and bounded recheck completed. RDD off, disabled/unmanaged; no review started.
  - Authored unit: 855 changed lines, tests/docs included, tracking excluded. Kept coherent with real dispatch and lifecycle tests rather than an unused catalog utility. Commit: `f5adb57` (`feat(knowledge): route project skills and measure delivered context`).

## Follow-up

- [ ] **PK-5: Enable knowledge by default without overriding explicit opt-out.**
  - User explicitly requested default activation after delivery of PK-1 through PK-4. Route: delegated direct because settings, update regression tests and documentation need coordinated edits. Forecast: 50-90 authored changed lines; retain the existing feature identity and local chain strategy.
  - Surfaces: `src/settings.ts`, `tests/settings.test.mjs`, `tests/opencode-plugin.test.mjs`, `tests/setup-ui.test.mjs`, `docs/project-knowledge.md`, `docs/mdd-config.schema.json`.
  - User explicitly approved `tests/full-native.test.mjs` telemetry assertion updates after default activation exposed sixteen unknown-field checks and one run-ID accounting assumption. Preserve metadata and per-phase usage validation; do not disable knowledge in the fixtures to hide these failures.
  - Acceptance: fresh and omitted-field legacy settings default to enabled; explicit false remains disabled; update/read preserves existing configuration bytes; no provider is configured or contacted solely because its setting is absent. Preserve meaningful explicit-disabled test coverage, do not blanket-disable integration fixtures.
  - TDD/checks: observe RED for fresh/legacy defaults and update preservation, then GREEN. Run `npm run build`; `node --import ./tests/isolate-home.mjs --test tests/settings.test.mjs tests/setup-ui.test.mjs tests/project-knowledge.test.mjs tests/project-knowledge-runtime.test.mjs tests/opencode-plugin.test.mjs tests/opencode-v2.test.mjs tests/full-native.test.mjs tests/optional-memory.test.mjs`; `npm run typecheck`; `npm test`; `git diff --check`.
  - Rollback: restore previous default and corresponding tests/docs, leaving explicit user settings untouched.
  - Evidence: deterministic RED 2 passed/4 failed; initial integration 588 passed/17 failed/1 skipped exposed outdated telemetry assertions, corrected only after explicit scope approval. Final focused 605 passed/0 failed/1 skipped; full suite 1,859 passed/0 failed/3 skipped. Build/typecheck/diff-check passed; parent independently repeated typecheck and inspected the actual default/update/telemetry regression diff.
  - Skips remain two Windows file-symlink privilege tests and optional installed-Engram smoke. Native assessment returned `medium` (`configuration_change`), `under_budget`; writer verification plus parent spot check is the applicable gate. No separate verifier required at this tier; RDD remains off.
  - Authored unit: 104 changed lines across seven implementation/test/doc files, tracking excluded. Existing installed configuration and provider/catalog setup remain untouched. Commit pending; no new publication is authorized by this follow-up request.

## Verification and limitations

Tests use existing isolated-home fixtures, temporary files and local fixture HTTP servers. No installed Engram service, real model calls or credentials are needed for these contract tests. Builds write generated `dist` output. Task-level builds and automated checks are recorded above. No real-host smoke has run. Real-host testing, if needed later, requires a separate bounded action and explicit disclosure of its processes and effects.

Source digest checks validate declared dependencies, not the completeness of a claim. Reused text remains untrusted advisory data and cannot override actor instructions. Actual token savings require actual usage measurements; byte-volume diagnostics alone are not token counts.

## Progress and next step

Initial four tasks are complete and independently verified: `2353cbe`, `a3e9d4d`, `487573c`, `f5adb57`. They were published through `8d329dd`. PK-5 default-on implementation and applicable verification are complete; local commit pending, publication not authorized by this follow-up.

No installed settings, installation or project catalog will be changed by PK-5; only the shipped default changes. Real-host trials and token-savings evidence remain pending. Three environment-dependent test skips and the native-fallback post-restart limitation remain documented. Engram's full task mirror remains pending due to session/project mismatch; separate progress observations and session summaries were saved without changing the binding.
