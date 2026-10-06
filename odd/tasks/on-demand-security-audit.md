# On-demand security auditing of the complete implementation

Add a configurable, read-only `mdd-security` actor that runs only on an explicit user request and reports security findings for the current implementation, including committed and pending changes. Findings never authorize fixes or delivery.

## Objective and authorized scope

The user requested the actor, configuration in `mdd-ai config`, detailed findings for the orchestrator, and separately authorized corrections through `mdd-apply`. The user explicitly confirmed that auditing must include already committed work and pending staged, unstaged and untracked implementation changes.

- Keep security separate from workflow phases and automatic verification.
- Restrict runtime permissions, not just prompt wording: no source mutation, shell, delegation, network, or unrestricted live reads.
- Derive a trustworthy change baseline or request clarification; never default to HEAD-only or audit unrelated history.
- Use explicit baseline or a verified unique merge-base with an established target branch when no recorded implementation start exists.
- Capture bounded immutable audit input, including changed locations and relevant context; reject detected capture races.
- Report severity, location, evidence, attack conditions, impact, recommendation, coverage and limitations.
- Distinguish no findings from incomplete inspection; never guarantee absence of vulnerabilities.
- Do not launch fixes, commit, publish, advance workflow, or approve delivery as an audit consequence.

## Implementation and delivery

| Item | Value |
|---|---|
| Feature branch | `feat-mdd-security` |
| Starting boundary | `963895886e5786fb3af62ccb34ada3ecba4a9f51` |
| Implementation route | Delegated direct, one writer at a time |
| Trigger evidence | Multi-file behavior changes; reading prepares writes; snapshot and dispatch require bounded design |
| Forecast | 1,430–2,090 authored additions plus deletions, excluding generated output |
| Delivery strategy | `ask-on-risk` |
| Chain strategy | `stacked-to-main`, explicitly selected by user; no publication authorized |
| Running authored count | SEC-1 commit +543/−15 (558 total, including tracking); corrective commit pending |
| Review switch | On, decided by global preference; candidate consent remains separate |
| Last reviewed boundary | Starting boundary; no new candidate reviewed |
| Memory mirror | Pending in detected project `mdd-orchestrator`; registered session uses `mdd` |

The approximately 400-line task heuristic is advisory. Keep coherent behavior, tests and documentation together; do not compress code or omit checks to meet it. Each completed task requires a Conventional Commit on the feature branch. Push, PR creation and merge remain separate user decisions.

## Tasks and acceptance criteria

- [x] **SEC-1 — Configurable actor and report contract.** Route: delegated, multi-file writer trigger. Standalone configurable packaged actor and bounded report checker implemented. Independent verification exposed telemetry model-role coupling; corrected admission to actual phases with regression tests and an independent passing recheck. Runtime audit dispatch remains intentionally unavailable until SEC-2/3.
- [ ] **SEC-2 — Complete bounded implementation snapshot.** Route: delegated, preparation and multi-file writer triggers. Capture committed, staged, unstaged and untracked layers against a trustworthy base, including changes cancelled by later layers. Bound paths, bytes and evidence; expose omissions and reject detected races or unsafe reads. Verify committed-only scope, additions/deletions/renames, dirty layers, limits, unsafe paths and capture races. Forecast: +550–750 / −0.
- [ ] **SEC-3 — Authenticated standalone dispatch and isolation.** Route: delegated, multi-file writer trigger. Admit only an explicit authenticated native-user audit request, dispatch one bound foreground actor, enforce tool isolation and validate its snapshot-bound report. Document natural-language usage and separately authorized fixes. Verify bilingual requests, forged/synthetic/stale inputs, replay, forbidden tools, evidence binding, redaction, no automatic launch and unchanged workflow state. Forecast: +500–750 / −20–60.

## Verification

No configured repository TDD mode was found. Applicable default policy: observed behavioral RED → GREEN → REFACTOR using deterministic Node tests; dependency/build failures do not count as RED. Passive task-document changes receive structural readback only.

Dependencies are absent. Authorized local dependency preparation, without lifecycle scripts, provider authentication, global setup or live-model calls: `npm ci --ignore-scripts --no-audit --no-fund`. The writer must inspect lockfile/script trust and isolate npm cache/config before installation.

Exact unit runners, after `npm run build`:

```text
node --import ./tests/isolate-home.mjs --test tests/security.test.mjs tests/settings.test.mjs tests/phase-report.test.mjs tests/report-check.test.mjs tests/phase-assets.test.mjs
node --import ./tests/isolate-home.mjs --test tests/security-snapshot.test.mjs
node --import ./tests/isolate-home.mjs --test tests/security-audit.test.mjs tests/opencode-plugin.test.mjs tests/opencode-v2.test.mjs
```

Closure checks: `npm run typecheck`, `npm run build`, `npm test`, `git diff --check`, `git diff --cached --check`. Required failures produce partial status. Parent repeats a reported focused command; independent verification follows native risk/RDD state. Normalize before candidate freeze, then only check-only operations during review.

## Progress and evidence

- Exploration complete: model roles are separate from phases; existing permissions are insufficient for a read-only audit; workflow does not retain a trustworthy Git implementation-start baseline.
- Current coordinator asset is near its 16,000-byte cap. Replace/consolidate wording rather than blindly appending.
- CodeGraph was attempted but no index exists; scoped filesystem fallback used, no index initialization.
- SEC-1 implemented: standalone model role and packaged actor, detailed bounded report schema and pure form checking. Runtime snapshot binding and dispatch remain SEC-2/3; the actor cannot yet perform an admitted audit.
- SEC-1 observed RED: successful build then 38 behavioral failures; missing-module failure excluded from RED. GREEN after refactor: 166/166 focused tests. Parent independently reran the identical focused command: 166/166.
- SEC-1 writer checks: `npm run typecheck`, `npm run build`, `npm test` (1,083 passed, 2 intentional skips), `git diff --check`, and `git diff --cached --check` succeeded. Independent verifier reproduced both skips: artifact symlink rejection lacks Windows symlink privilege, and installed Engram managed smoke is disabled without `MDD_SMOKE_ENGRAM`.
- Dependencies installed locally with ignored scripts, isolated cache and empty user/global npm configs; package and lockfile unchanged. No source-mutating normalizer was required.
- SEC-1 native risk assessment returned `high/unassessable` because new files were not declared. Do not infer low risk; assess the exact committed work unit after its commit. Review outcome pending.
- SEC-1 work-unit commit: `c592348b462e55c73a9ebf22325265251d982096`. Committed range assessed high (`hot_path/security`). Exact native preflight returned terminal `rdd_disabled`; no START, approval or mode toggle. Native outcome disabled/unmanaged; ordinary high-tier independent verification used, not native approval.
- Independent verifier reran typecheck/build, focused 166/166 and diff checks. Medium candidate-caused finding: telemetry accepted `mdd-security` through `MODEL_ROLES`, but rollup parsing accepted only `PHASES`. A probe demonstrated accepted event followed by unreadable rollup.
- Targeted correction +36/−3: telemetry phase admission now uses `PHASES`. Observed behavioral RED 24 passed/2 failed, GREEN/refactor 192/192; typecheck/build/full suite 1,085 passed/2 known skips/diff checks succeeded. Parent spot check 192/192. Independent re-verifier confirmed resolution, retained all eight valid phases and rejected standalone roles before any writes; its typecheck/build/192-test/diff checks passed. Corrective commit pending.
- No known baseline test failures have been established.
- Future slice 1 contains SEC-1 commit and its pending targeted correction. No PR created or published.

## Next step

Commit the independently verified SEC-1 correction, then delegate SEC-2 bounded snapshot capture with exact allowed paths. User selected `stacked-to-main`; no publication. Native review stopped disabled; do not reactivate automatically. Reconcile tracking and mirror after each observed task outcome.
