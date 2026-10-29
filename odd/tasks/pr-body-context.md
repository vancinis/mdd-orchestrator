# Flexible PR body context

## Objective

Keep useful reviewer context inside the generated PR body instead of publishing supplementary comments to work around its fixed format.

## Problem and rationale

The current tool accepts only fixed evidence translations and three narrowly sourced notes, renders exactly seven sections, and requires verbatim delivery. Recorded goals and decisions, reviewer guidance, risks, and attributed interpretations need an optional in-body channel without weakening verification evidence.

## Authorized scope and constraints

- User authorized implementation after a read-only analysis, then selected one coherent local work unit despite the estimated 600–850 authored changed lines.
- Implementation delivery strategy: `exception-ok`; one coherent implementation commit on `feat/pr-body-context`. The user's subsequent request explicitly authorizes committing this tracking document, fetching `origin/main`, integrating it, and pushing directly to `origin/main` on `https://github.com/vancinis/mdd-orchestrator.git` using the existing Git authentication. No force-push or PR publication is authorized.
- Base boundary: `6a1eb90026c728b23ea165e27507bf59765dc052`.
- RDD is `off`, decided by `clone_local`; do not enable it or start reviews.
- Preserve existing seven base sections, legacy output without context, final verbatim delivery, Spanish PR prose, check failures, and independent publication authority.
- Optional sections: context/decisions, risks/limitations, and review notes. Distinguish recorded actor context, authenticated user quotes, and unverified agent interpretations. Supplemental content must not replace verification or authorize comments.
- Exclude unrelated sanitizer, adaptive-evidence, check-history, and phase/checkpoint-schema redesigns.

## Tasks

- [x] **T1 — Add sourced optional PR context end to end.** Route: delegated direct. Trigger: four non-trivial production files plus tests, assets and documentation; preparation and implementation belonged to one bounded writer. Behavioral RED/GREEN, projection/schema/binding/rendering, aligned instructions/docs, independent verification and parent checks observed. Work-unit commit: `9f89cdd5d10b7cccefafa28592e62d5389301f61` (`feat(pr): support sourced optional context in PR bodies`).

## Allowed edit surfaces

- `src/pr-body.ts`
- `src/pr-translation.ts`
- `src/opencode-plugin.ts`
- `src/phase-runner.ts`
- `tests/pr-body.test.mjs`
- `tests/full-native.test.mjs`
- `tests/phase-assets.test.mjs`
- `tests/opencode-plugin.test.mjs`
- `assets/opencode/agents/mdd-orchestrator.md`
- `assets/opencode/skills/mdd-pr-body/SKILL.md`
- `README.md`
- `docs/opencode-adapter.md`
- `odd/tasks/pr-body-context.md`
- Ignored `dist/` compiler outputs only; never force-add generated files.

## Acceptance criteria

1. Without additional context, the legacy body and protocol remain unchanged.
2. Optional context appears in deterministic in-body groups with visible source attribution.
3. Recorded goal/decisions resolve from held evidence, not caller-authored replacements; recorded does not imply independently verified.
4. User quotes are authenticated; useful agent synthesis is explicitly unverified and cannot override check results, blockers, or readiness.
5. Translation binding includes optional context, provenance, section, and resolved recorded text; stale or altered submissions fail.
6. Direct edits support additional context without claiming MDD verification; recorded selectors require recorded evidence.
7. Unknown/oversize inputs and heading/secret injection are handled safely; expanded translation requests respect the existing submission bound.
8. Instructions require incorporating relevant context before final rendering and prohibit automatic supplementary comments as a formatting workaround.

## Verification

- Test-first policy: default deterministic RED → GREEN → REFACTOR, applicable because Node behavioral tests and clear expected results exist. No separate repository TDD-mode configuration was found.
- RED/GREEN focused runner: `npm run build`, then `node --import ./tests/isolate-home.mjs --test tests/pr-body.test.mjs tests/full-native.test.mjs tests/phase-assets.test.mjs tests/opencode-plugin.test.mjs`.
- Required closure: `npm run typecheck`, `git diff --check`, and `npm test`.
- No configured source-mutating formatter; preserve repository style and LF. Build output is ignored.
- Writer boundary: do not run native RDD review/lifecycle commands while RDD is off. Parent runs read-only risk assessment for the delegated verification gate; high or unassessable requires independent verification and a parent rerun of one reported check.
- Full suite forecast: thousands of Node tests; actual elapsed time unknown; local CPU/process work and ignored build output only, no intended remote effects.

## Progress and evidence

- Exploration completed; current repo was clean on main and a feature branch was created.
- Planned authored change forecast: 600–850 lines, advisory only. Preserve clarity and coverage rather than shrinking the diff artificially.
- Running implementation committed authored count: 493 (460 additions, 33 deletions across 12 files). Slice: T1 only, commit `9f89cdd5d10b7cccefafa28592e62d5389301f61`. The user subsequently authorized a tracking commit and direct publication to `origin/main` after integration of its latest changes.
- Implementation and behavioral RED/GREEN are recorded below. The default parallel suite failed; complete independent serial verification subsequently passed. Parent spot checks and the single work-unit commit completed. Original failures and three skipped tests remain disclosed.
- Behavioral RED observed before production edits: `npm run build` passed; exact focused runner ran 465 tests, 452 passed and 13 failed in 643948.0331 ms (exit 1). Missing optional context/schema/binding caused the failures; no compile/dependency failure counted as RED.
- RED failed names: `SA-3: explicit continuation archives failure without PASS or new work (restart=false)`; same `(restart=true)`; `native optional PR context authenticates user text, projects live decisions and leaves workflow untouched`; `a quick edit with no recorded run still drafts its PR body from git and the coordinator's Spanish`; `plugin contract: scoped tools, in-place native args, result gating, no native override`; `assets: PR instructions incorporate context before final rendering without publishing workaround comments`; `optional PR context translates held prose and groups attributed content in fixed order`; `optional PR context binds source, section, text, held IDs and descriptions to translations`; `optional PR context rejects fabricated recorded selectors and unknown fields`; `optional PR context bounds caller entries, authored prose and expanded translations`; `optional PR context authenticates exact whole user lines before requesting translations`; `optional PR context cannot create headings, leak secrets or structurally override failures`; `direct PR context binds metadata and target inventory but never claims MDD verification`.
- Engram mirror: pending; previous explicit project save failed with `session_project_mismatch` despite omitting `session_id`. Preserve this local document if the mismatch persists.
- Implementation now covers the four authorized production files, four test files, orchestrator/skill instructions, README and adapter guide. No phase/checkpoint schema, cache, publication action or RDD lifecycle was added.
- Intermediate checks: first implementation build exposed exact-optional-property/narrowing errors, fixed before behavioral verification. A 243-test subset then passed 241 and failed 2 (`assets: mdd-pr-body trigger metadata, structure and explicit registry`; `optional PR context cannot create headings, leak secrets or structurally override failures`) in 49390.4784 ms. Fixed the skill's extra heading level and made the injection fixture valid Spanish; no acceptance requirement was removed.
- Targeted GREEN: `node --import ./tests/isolate-home.mjs --test tests/pr-body.test.mjs tests/phase-assets.test.mjs` passed 124/124 in 1068.9021 ms; native retained/live/direct context selection passed 4/4 in 17485.2574 ms. Full focused command and required closure checks follow after final edits.
- Engram decision save attempted once with resolved project `mdd-orchestrator`, no supplied session ID; server returned `session_project_mismatch` (runtime session belongs to `mdd`). No blind retry; this document preserves recovery evidence. The required final session summary subsequently saved successfully under `mdd-orchestrator`.

### Final writer checks

| Command | Observed result |
|---|---|
| `npm run build` | Passed, exit 0, after final production edits; regenerated ignored `dist/*.js` and `dist/*.d.ts`. |
| `node --import ./tests/isolate-home.mjs --test tests/pr-body.test.mjs tests/full-native.test.mjs tests/phase-assets.test.mjs tests/opencode-plugin.test.mjs` | GREEN: 465 passed, 0 failed/skipped, 672138.2154 ms, exit 0. |
| `npm run typecheck` | Passed, exit 0 (`tsc --noEmit`). |
| `git diff --check` | Passed, exit 0; Git warned that the existing CRLF working copy of `tests/opencode-plugin.test.mjs` will normalize to LF on its next Git write. No source-mutating formatter was run. |
| `npm test` | PARTIAL: build passed; 2861 tests, 2853 passed, 5 failed, 3 skipped, 842960.023 ms, exit 1. |
| `node --import ./tests/isolate-home.mjs --test --test-concurrency=1 tests/apply-batches-host.test.mjs tests/config-ui.test.mjs tests/judgment-day.test.mjs tests/pack.test.mjs` | Diagnostic rerun only: all 40 passed, 0 failed/skipped, 23684.3944 ms, exit 0. This does not turn the full-suite failure into PASS. |

Full-suite failed names and observed diagnostics:

1. `fixture plugin matches installed V2 hooks and keeps all workload effects private (context double)` — workload Node subprocess status `null` versus expected `0`, at `tests/apply-batches-host-smoke.mjs:164`; the subprocess uses a 5000 ms timeout. This assertion did not expose an error classification.
2. `isolated CLI smoke: profile create/use/list and telemetry on/off/status/clear` — `ETIMEDOUT`, elapsed 5049 ms, status 0.
3. `new command validation and help are deterministic and preserve exit semantics` — `ETIMEDOUT`, elapsed 5653 ms, status null, SIGTERM.
4. `immutable inspection returns committed trees/blobs/diffs, never dirty or untracked source` — Git immutable inspection classification `timeout`, elapsed 5173 ms, 5-second bound.
5. `package dry-run includes runnable build and exact owned assets without private runtime data` — npm pack dry-run `ETIMEDOUT`, elapsed 30240 ms, status null, SIGTERM.

All failing files are outside the authorized edit surfaces and passed unchanged in the serial diagnostic rerun. Contention is plausible, not proven; no baseline run was fabricated, no timeout was weakened, and no unrelated source/test file was edited. At writer handoff the complete full-suite recheck was pending; its successful independent serial result is recorded below.

### Handoff boundary

- `skill_resolution: paths-injected` for all four requested paths. CodeGraph served current source; no index mutation was performed.
- Context binds source/group/order/text and held decision IDs/descriptions. Only recorded prose is translated; original user/interpretation text remains digest-bound without translation. Direct mode binds context and Git target/file inventory, not content truth. Labels are attribution, not semantic verification.
- Runtime boundary evidence: the exact focused runner includes actual plugin/native-intake fixture tests for live and retained decisions, authenticated user text, direct Git inventory, unchanged workflow/memory/publication authority and retained failure classification. This is deterministic fixture evidence, not a live remote/GUI proof.
- Rollback boundary: the four production files, four test files, two packaged instruction files, README and adapter-guide context changes form one coherent feature; remove this unit together, not by file type. Parent owns the existing task document and final commit.
- No staging, commits, branch changes, publishing, remote operations, dependency installs, RDD toggles/reviews or delegation were performed by the writer. Existing test harnesses exercised isolated local/mocked setup and Git fixtures as part of the explicitly required suite.
- At writer handoff: 12 tracked files, 460 insertions + 33 deletions = 493 changed lines; this preexisting untracked task document had 108 lines (72 before writer work). The local work unit then totalled 601 authored changed lines including the task document; writer-only delta was 535 lines including 42 task-document changes. Committed count was 0. Writer `git diff --check` passed; only the 12 authorized tracked files and this task document were dirty. Dist stays ignored and is never force-added.

## Next step

Requested implementation and latest-main integration are complete and verified. Publish the integrated result directly to `origin/main` using an ordinary fast-forward push, as explicitly authorized; no force-push or PR publication. This document is a pre-publication snapshot; the actual remote mutation outcome is reported in the session summary and final user reply. Engram task mirror remains pending because of the known session/project mismatch; no unsupported recovery or project reassignment was attempted.

### Parent and independent verification

- Read-only `gentle-ai review assess --cwd <repo> --json` returned `gentle-ai.review-assessment/v1`, risk `high`, reason `unassessable`: the untracked task document requires an explicit inventory declaration. No low-risk inference, review STATUS, consent, or review lifecycle was invoked. RDD remains off.
- A fresh independent verifier inspected the implementation and reported no actionable findings, including request-to-render usability, live/retained recorded sources, optional-section ordering, legacy behavior and preserved publication/check boundaries.
- Independent `npm run build`: exit 0, 3755 ms.
- Independent `node --import ./tests/isolate-home.mjs --test --test-concurrency=1 tests/*.test.mjs`: exit 0; 2861 tests, 2858 passed, 0 failed, 3 skipped; 2562387.4987 ms. All five previously failing parallel-suite cases passed in this complete serial run. Concurrency as the original failure cause remains unproven; the original `npm test` failure is not relabelled PASS.
- Independent `npm run typecheck`: exit 0, 3302 ms; `git diff --check`: exit 0, existing CRLF normalization warning only. No source edits were made by the verifier.
- Parent reran `npm run typecheck` and `git diff --check`: both exit 0. Parent checked explicit changed paths and the 493 authored tracked-line delta; only the planned 12 tracked files and this local task document are dirty.
- Three full-suite tests remain skipped; no skip or timeout was introduced or weakened by this feature.
- Functional verification is ordinary repository checking, not an RDD approval receipt. Direct-main publication was separately authorized in the subsequent user request and confirmation.
- Work-unit commit created: `9f89cdd5d10b7cccefafa28592e62d5389301f61` on `feat/pr-body-context`. Post-commit status shows no tracked source changes and only this untracked local task document. Main and remote repositories were not modified.

### Subsequent delivery authorization

- User requested commit, latest main integration and direct push, then selected `Directamente en main` after confirmation of the exact origin URL, operations and existing Git authentication.
- Tracking commit: `b262cd6dfdcca340afca3f35656eed36d5f23e49` (`docs(odd): record PR context implementation and checks`).
- Fetched latest `origin/main`: `e16776b3ecd7a8674f4890e009654cb40dde5c04`, three upstream commits. Integrated automatically without conflicts as merge `af6b327307690f7a6f93e0a174dfc97a0f85bbb9`; parents are the tracking commit and the fetched main tip.
- Integration added nine upstream files (197 additions, 14 deletions), preserving both PR context and adaptive-incident changes. No manual production edits or test timeout changes were required.
- Integrated checks: `npm run build` exit 0 (3406 ms); `npm run typecheck` exit 0 (2656 ms); `node --import ./tests/isolate-home.mjs --test --test-concurrency=1 tests/pr-body.test.mjs tests/phase-assets.test.mjs tests/adaptive-continuation.test.mjs tests/adaptive-low.test.mjs tests/adaptive-native.test.mjs tests/report-check.test.mjs` exit 0, 414 passed, no failures or skips (120390.52 ms); `git diff --check` exit 0.
- Native read-only committed integration assessment against `b262cd6dfdcca340afca3f35656eed36d5f23e49`: risk `medium`, nine paths, 211 authored changed lines, executable Apply-instruction change. Under the RDD-off medium-tier rule, writer verification plus parent spot check applies; no reviewer or review lifecycle was started.
- Complete integrated full-suite rerun was not performed; the earlier feature serial full-suite evidence and initial parallel failures remain recorded without claiming they ran on the merged candidate.
- Direct-main publication follows these checks and the user's exact destination/authentication authorization. No remote mutation success is claimed by this pre-publication entry.
