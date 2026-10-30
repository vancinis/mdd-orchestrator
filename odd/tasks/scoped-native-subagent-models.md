# Scoped native subagent models

## Objective

Allow each MDD profile to optionally choose models for native OpenCode `explore` and `general` calls originating from `mdd-orchestrator`, without changing those agents for other callers.

## Problem and rationale

Native subagents without configured models inherit the caller's model. Updating their global agent definitions would affect non-MDD callers. A small caller-scoped dispatch hook extends the plugin's existing model-configuration responsibility without recreating the retired workflow engine.

## Authorized scope and constraints

- Add optional per-profile native model configuration and expose it in `mdd-ai config`.
- Support only `explore` and `general` as configuration targets; do not restrict which agents may be launched.
- Preserve existing profiles, native permissions, prompts, agent identities, and explicit invocation models.
- Leave other callers and unconfigured targets unchanged; preserve existing child models on resume.
- No aliases, new runtime tools, workflow gates, routing registry, persistent dispatch state, dependency updates, global configuration edits, remote operations, push, or PR creation.
- Keep user-facing documentation and CLI copy in Spanish; code and comments in English.

## Work unit

- [x] **T01 — Add scoped native model settings, dispatch policy, profile editor support, regression tests, and documentation.**
  - Route: delegated direct; multi-file implementation and reading-to-write require one bounded writer.
  - Acceptance: optional settings round-trip through profiles; only fresh native `explore`/`general` dispatches from `mdd-orchestrator` receive configured defaults; explicit overrides, resumed children, unrelated targets and callers retain existing behavior; actual plugin-hook wiring is tested.
  - Test-first policy: default ODD policy, sourced from orchestrator instructions; observe relevant deterministic regression tests RED, implement GREEN, then refactor with checks green.
  - Checks: `npm run typecheck`, `npm run build`, `npm test`, and `git diff --check`. Use the existing deterministic runner and add focused commands after inspecting package scripts.
  - Commit: `a7cecce1c9d25b27f6ca539211d33a073e2a351c` — `feat(models): scope native subagent defaults to MDD orchestrator`, on `redesign/contracts`; code, tests, and user documentation form one work unit.

## Delivery and verification

- Base commit: `76854340ef152c92018312c3f295f83c70902214`.
- Delivery strategy: `ask-on-risk`; forecast approximately 350 authored changed lines, generated files excluded. Running count: 310 (258 behavior changes plus this 52-line tracking document). No PR slices created.
- Receipt-driven development: off, decided by clone-local preference; `disabled/unmanaged`. No native review was started or enabled.
- After the writer returns, run native risk assessment and use the resulting tier for independent verification; failed or unrecognized assessment is high/unassessable, never passive.
- Parent reruns one reported focused check before delivery and structurally reads back the changes.
- Rollback boundary: the optional native-model configuration, scoped hook, associated editor entries, regression tests, and documentation in this work unit only.

## Progress and evidence

- Exploration complete: current model transforms are target-based; OpenCode V2 tool-before hooks expose the real calling agent and mutable subagent input.
- Installed-host end-to-end behavior is not yet verified; deterministic plugin tests are required, and any live-model limitation must be disclosed.
- Recovery: the server restart interrupted the parent transport, not all original worker activity. A recovery worker detected changes and made no edits. The original writer was identified through parent-scoped session metadata, returned its evidence, and confirmed no source writes remain pending.
- Test-first evidence: focused Node tests observed RED (70 passed, 6 failed), then GREEN (76 passed, 0 failed); the original writer reran all 76 successfully after refactoring.
- Writer checks: `npm run typecheck` and `npm run build` passed. `npm test` was interrupted without a completion result; `git diff --check` remained pending.
- Independent checks: typecheck and whitespace checks passed. The full suite first exceeded a 120-second timeout; one retained bounded retry completed with 217 passed, 0 failed/cancelled/skipped/todo in 223.5 seconds, including a successful build. Unchanged heavyweight offline-install fixtures were identified, but the exact timeout operation was not isolated; no test assertions failed.
- Independent inspection found no actionable candidate defect. SHA-256 snapshots of all nine changed source/test/documentation files matched before and after verification.
- Parent spot check: the exact focused runner passed all 76 tests, with no failures or skips; structural readback confirmed settings, schema, UI, hook guards, and user documentation match the authorized boundary.
- Exact focused runner: `node --import ./tests/isolate-home.mjs --test tests/settings.test.mjs tests/opencode-plugin.test.mjs tests/config-ui.test.mjs`.
- Native assessment: `gentle-ai.review-assessment/v1`, high/unassessable because the untracked task document required explicit scope declaration. High-tier independent verification completed; native review stayed disabled/unmanaged.
- Candidate source/tests/docs: 233 additions and 25 deletions (258 authored changed lines), excluding this tracking document.
- Engram mirror `odd/scoped-native-subagent-models/tasks`: pending; prior proactive saves reported `session_project_mismatch`, so local tracking remains authoritative until synchronized.
- Next step: user may choose installation/update and configure models under `mdd-ai config` → `Subagentes nativos`. Installed-host/live-model dispatch remains explicitly unrun; no installed configuration was changed. No push or PR was performed.
