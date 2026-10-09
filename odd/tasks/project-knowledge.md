# Project-aware knowledge reuse

## Objective

Reuse validated project knowledge and relevant skills without filling the coordinator's context. Engram remains the canonical semantic memory; MDD retains operational safeguards and only a bounded, rebuildable local knowledge cache.

## Authorization and constraints

- User approved implementation of the discussed memory, selective retrieval, contextual routing and measured feedback recommendations on 2026-10-09.
- Preserve checkpoints, ownership, consent, scope, verification requirements and worker permissions. Stored knowledge is advisory data, never execution authority.
- No remote operations, publication, installation, global configuration changes or automatic policy adoption are authorized.
- Use existing configured Engram only. New optional knowledge configuration defaults off for compatibility; tests explicitly enable it. Do not enable the user's memory configuration.
- Reuse requires target-checkout dependency validation, including dirty and untracked files. A shared project or commit identity alone is insufficient.
- No second canonical memory database, arbitrary skill discovery, tool installation or unbounded self-improvement loop.
- Code, tests and documentation are English; user-facing orchestration remains Spanish.

## Baseline and delivery

- Baseline: `1f4b700` on `main`; initial worktree was clean.
- Feature branch: `feat/project-knowledge`.
- Delivery strategy: `ask-on-risk`; user selected `feature-branch-chain`. Keep four reviewable work-unit boundaries on the local feature line; publication, PR branches and merges remain separate user decisions.
- Forecast: 1,850-2,900 authored changed lines across four cohesive units; generated output excluded. This is an estimate, not a size limit. Keep tests and documentation with behavior; do not compress or omit them to meet a line target.
- Running authored changes in work-unit commits: 0. No implementation commits yet; slice boundaries pending.
- RDD: off, decided by `clone_local`; do not start reviews or change the switch.
- Verification: assess each writer diff with native risk assessment only. High/unassessable requires writer checks plus independent verification. Parent repeats one reported command before delivery.
- TDD: no explicit strict repository setting found. Apply the ODD default: observe deterministic RED, implement GREEN, then refactor. No RED/GREEN evidence exists yet.
- Engram mirror: pending. Full-document save under `odd/project-knowledge/tasks` was refused with `session_project_mismatch`: detected project is `mdd-orchestrator`, but the registered session belongs to `mdd`. No mirror was created or alternate project selected. Local tracking remains authoritative until synchronization succeeds.

## Tasks

- [ ] **PK-1: Record and query reusable project observations.**
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
  - Authored unit: 650 changed lines (including tests/docs, excluding tracking). Kept cohesive rather than separating security checks or tests merely to meet an advisory line count. Commit pending immediately after verified task update.

- [ ] **PK-2: Cache knowledge with checkout-specific freshness.**
  - Route: delegated direct; persistent bounded cache, validation and multiple test surfaces.
  - Add one bounded, rebuildable `.mdd/knowledge-cache.json` using existing safe persistence. Validate declared dependency bytes against the target checkout, not the shared cache root.
  - Initial budget targets: 100 entries, 512 KiB total, 4 KiB per body; tighten if existing envelope limits require it. Missing files differ from empty files. Reject traversal and unsafe linked/nonregular source files.
  - Intended surfaces: `src/project-knowledge.ts`, `src/knowledge-cache.ts` (new), `src/local-files.ts`; `tests/project-knowledge.test.mjs`, `tests/knowledge-cache.test.mjs` (new), `tests/engram-http.test.mjs`; `docs/project-knowledge.md`.
  - Acceptance: divergent linked-worktree bytes, dirty/untracked changes and deletions invalidate affected entries; unsafe paths cannot be read; eviction is bounded; cache corruption/loss does not block ordinary work. Provider outage omits optional knowledge rather than silently replaying revoked material.
  - Checks: `npm run build`; `node --import ./tests/isolate-home.mjs --test tests/project-knowledge.test.mjs tests/knowledge-cache.test.mjs tests/engram-http.test.mjs`; `npm run typecheck`; `npm test`.
  - Rollback: remove derived cache integration; canonical Engram observations and runtime state survive.
  - Commit, assessed risk and proof: pending.

- [ ] **PK-3: Deliver selected knowledge at real dispatch boundaries.**
  - Route: delegated direct; stateful single/parallel dispatch integration and regression coverage.
  - Resolve by objective, phase and actual assignment paths. Revalidate state/ownership after asynchronous retrieval and source freshness before dispatch. Keep parent output compact and preserve mandatory scope/acceptance/verification context.
  - Cover ordinary phases, Apply workers and exploration workers. Scoped workers receive only knowledge within their declared footprint; do not expand their tools or file access.
  - Initial supplemental budget: at most three entries and 8 KiB, subordinate to existing prompt limits. Do not route selected bodies through accumulating `mdd_context`.
  - Intended surfaces: `src/project-knowledge.ts`, `src/native-intake.ts`, `src/opencode-plugin.ts`, `src/phase-runner.ts`, `src/worker-state.ts`; `tests/project-knowledge-runtime.test.mjs` (new), `tests/opencode-v2.test.mjs`, `tests/worker-state.test.mjs`, `tests/workers-native.test.mjs`, `tests/checkpoint.test.mjs`; `docs/project-knowledge.md`.
  - Acceptance: actual child prompts contain relevant fresh bodies; parent does not; assignments filter separately; stale/provider-failed retrieval is omitted; resume and dispatch correlation remain correct; worker restrictions remain unchanged.
  - Checks: `npm run build`; `node --import ./tests/isolate-home.mjs --test tests/project-knowledge-runtime.test.mjs tests/opencode-v2.test.mjs tests/worker-state.test.mjs tests/workers-native.test.mjs tests/checkpoint.test.mjs tests/worker-fence.test.mjs tests/full-native.test.mjs`; `npm run typecheck`; `npm test`.
  - Rollback: remove optional dispatch resolver while retaining original phase context and execution semantics.
  - Commit, assessed risk and proof: pending.

- [ ] **PK-4: Route approved skills and expose measurable feedback.**
  - Route: delegated direct; catalog parsing, prompt selection, metrics and integration tests.
  - Support an optional explicit, versioned per-checkout `mdd/knowledge.json` catalog with exact relative skill references and bounded deterministic applicability rules. Preserve packaged phase skills; do not crawl or install global skills.
  - Advisory tool choices may only reference capabilities available to that execution lane. Unknown tools are omitted; catalog content cannot grant permissions.
  - Expose compact candidates/fresh hits/stale rejects/selection and byte-volume diagnostics. Respect telemetry preference for persistent counters. Distinguish candidate observations, validated recommendations and explicit project policy; never auto-promote or rewrite policy.
  - Intended surfaces: `src/knowledge-catalog.ts` (new), `src/project-knowledge.ts`, `src/knowledge-cache.ts`, `src/phase-assets.ts`, `src/phase-runner.ts`, `src/local-files.ts`; `tests/knowledge-catalog.test.mjs` (new), `tests/project-knowledge-runtime.test.mjs`, `tests/phase-assets.test.mjs`; `docs/project-knowledge.md`.
  - Acceptance: appropriate skills selected deterministically; unrelated/missing/unsafe entries excluded; no parent skill-body duplication; counters reflect observed retrieval/bytes without claiming token or productivity savings.
  - Checks: `npm run build`; `node --import ./tests/isolate-home.mjs --test tests/knowledge-catalog.test.mjs tests/project-knowledge-runtime.test.mjs tests/phase-assets.test.mjs`; `npm run typecheck`; `npm test`.
  - Rollback: remove optional catalog/routing/diagnostics while retaining canonical observations and operational state.
  - Commit, assessed risk and proof: pending.

## Verification and limitations

Tests use existing isolated-home fixtures, temporary files and local fixture HTTP servers. No installed Engram service, real model calls or credentials are needed for these contract tests. Builds write generated `dist` output. No test, build or runtime smoke has run for this feature yet. Real-host testing, if needed later, requires a separate bounded action and explicit disclosure of its processes and effects.

Source digest checks validate declared dependencies, not the completeness of a claim. Reused text remains untrusted advisory data and cannot override actor instructions. Actual token savings require actual usage measurements; byte-volume diagnostics alone are not token counts.

## Progress and next step

PK-1 implementation and independent verification complete; first work-unit commit next, then PK-2. Source freshness, cache, dispatch integration, skills and metrics are not yet delivered. Engram mirror remains pending due to session/project mismatch.
