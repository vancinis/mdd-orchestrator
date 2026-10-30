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
| Chain strategy | Initially `stacked-to-main`; user subsequently authorized integration and direct-main publication without PR |
| Running authored count | 2,707 through SEC-3, including tracking: SEC-1 611, SEC-2 1,196, SEC-3 900; final passive tracking closure excluded |
| Review switch | Fresh SEC-4 read off, decided by clone-local preference; native review disabled/unmanaged |
| Last reviewed boundary | Starting boundary; no new candidate reviewed |
| Memory mirror | Full recovery copy at observation 6887 in registered `mdd`; detected `mdd-orchestrator` mirror remains pending due session mismatch |

The approximately 400-line task heuristic is advisory. Keep coherent behavior, tests and documentation together; do not compress code or omit checks to meet it. Each completed task requires a Conventional Commit on the feature branch. Push, PR creation and merge remain separate user decisions.

## Tasks and acceptance criteria

- [x] **SEC-1 — Configurable actor and report contract.** Route: delegated, multi-file writer trigger. Standalone configurable packaged actor and bounded report checker implemented. Independent verification exposed telemetry model-role coupling; corrected admission to actual phases with regression tests and an independent passing recheck. Runtime audit dispatch was intentionally deferred to SEC-2/3 and is now integrated.
- [x] **SEC-2 — Complete bounded implementation snapshot.** Route: delegated, preparation and multi-file writer triggers. Immutable capture and final report binding cover committed/index/worktree/untracked layers, cancellations, changed ranges, bounded context, omissions and detectable races. Independent review found short-line evidence and whitespace-path reporting gaps; both corrected with behavioral RED/GREEN and independently passing rechecks. Footprint +1,180/−2, exceeding the advisory forecast to preserve security behavior and tests.
- [x] **SEC-3 — Authenticated standalone dispatch and isolation.** Route: delegated, multi-file writer trigger. Explicit authenticated native-user request, single-use foreground dispatch, frozen model configuration, snapshot-bound results and runtime tool isolation implemented and documented. Independent verification exposed descriptive-consent, canonical-Spanish and changed-identity fencing gaps; all corrected with observed RED/GREEN and independent passing probes. Source/test/doc footprint +839/−44 before tracking, over the advisory forecast to preserve coherent permissions and regression coverage.
- [x] **SEC-4 — Integrate latest main and publish the verified result.** Route: delegated, reading-prepares-writing and multi-file integration triggers. Latest pinned main `6ebd3dc534d5712459789f730a1760ce6c52464c` merged into feature HEAD `decc71272928da52fee889fade423d9883b8a6bd`, retaining upstream Judgment Day/Apply and security behavior. Typecheck/build/focused/full tests and independent verification passed; normal direct-main push confirmed integration commit `3fedf3d723884fde3e6652ef17e624e1a7a3742d`. User explicitly authorized this repository's current configured Git authentication, without force or credential changes. Inherited main changes are not a new feature expansion or exact authored count.

## Verification

No configured repository TDD mode was found. Applicable default policy: observed behavioral RED → GREEN → REFACTOR using deterministic Node tests; dependency/build failures do not count as RED. Passive task-document changes receive structural readback only.

Dependencies were initially absent and installed locally with `npm ci --ignore-scripts --no-audit --no-fund`, without lifecycle scripts, provider authentication, global setup or live-model calls. The writer inspected package/lockfile trust and isolated npm cache/config; no package or lockfile edits.

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
- SEC-1 implemented: standalone model role and packaged actor, detailed bounded report schema and pure form checking. Runtime snapshot binding and dispatch were intentionally deferred and subsequently completed in SEC-2/3.
- SEC-1 observed RED: successful build then 38 behavioral failures; missing-module failure excluded from RED. GREEN after refactor: 166/166 focused tests. Parent independently reran the identical focused command: 166/166.
- SEC-1 writer checks: `npm run typecheck`, `npm run build`, `npm test` (1,083 passed, 2 intentional skips), `git diff --check`, and `git diff --cached --check` succeeded. Independent verifier reproduced both skips: artifact symlink rejection lacks Windows symlink privilege, and installed Engram managed smoke is disabled without `MDD_SMOKE_ENGRAM`.
- Dependencies installed locally with ignored scripts, isolated cache and empty user/global npm configs; package and lockfile unchanged. No source-mutating normalizer was required.
- SEC-1 initial native risk assessment returned `high/unassessable` because new files were not declared. The exact committed work unit was subsequently assessed high; native outcome stopped disabled/unmanaged, not approval.
- SEC-1 work-unit commit: `c592348b462e55c73a9ebf22325265251d982096`. Committed range assessed high (`hot_path/security`). Exact native preflight returned terminal `rdd_disabled`; no START, approval or mode toggle. Native outcome disabled/unmanaged; ordinary high-tier independent verification used, not native approval.
- Independent verifier reran typecheck/build, focused 166/166 and diff checks. Medium candidate-caused finding: telemetry accepted `mdd-security` through `MODEL_ROLES`, but rollup parsing accepted only `PHASES`. A probe demonstrated accepted event followed by unreadable rollup.
- Targeted correction +36/−3: telemetry phase admission now uses `PHASES`. Observed behavioral RED 24 passed/2 failed, GREEN/refactor 192/192; typecheck/build/full suite 1,085 passed/2 known skips/diff checks succeeded. Parent spot check 192/192. Independent re-verifier confirmed resolution, retained all eight valid phases and rejected standalone roles before any writes; its typecheck/build/192-test/diff checks passed. Corrective commit: `96dedc16e5489091b1ef1e3274dd4360a911e8ac`.
- No known baseline test failures have been established.
- Future slice 1 contains SEC-1 commit `c592348` and correction `96dedc1` (611 authored lines including tracking; coherent unit over advisory heuristic). No PR created or published.
- SEC-2 observed initial behavioral RED 17 failures after successful stub build; initial GREEN 37 passed/1 Windows-native-symlink skip. Typecheck/build/full suite 1,122 passed/3 skips/diff checks succeeded. Parent repeated snapshot runner 37 passed/1 skip; independent verifier repeated checks and found two deterministic reportability gaps.
- SEC-2 correction observed RED 13 passed/8 failed, GREEN 21 passed. Final typecheck/build/full suite 1,131 passed/3 known skips and security+snapshot 85 passed/1 skip succeeded. Independent re-verifier reproduced both fixes and eight negative probes, with typecheck/build/21 targeted tests/diff check passed. Parent spot check repeated the exact targeted runner: 21 passed.
- SEC-2 omitted coverage is explicit: ignored untracked files, unsupported binary/link/submodule inputs, nearby context only, heuristic credential redaction and detectable rather than globally atomic races. Oversized scope refuses, never silently narrows. Snapshot 24,000 bytes; composed prompt 38,000 bytes. Inferred HEAD-only baseline refuses.
- SEC-2 committed work-unit: `cf064477f6c3327834fc5081594b4c55c827afd3`, 1,196 authored changed lines including tracking. Committed assessment high (`process_boundary/shell_process`); ordinary independent high-tier verification completed. Future slice 2 holds this commit; no PR created. Native lifecycle remains stopped disabled/unmanaged without automatic retries or mode toggles.
- SEC-3 initial observed behavioral RED 83 passed/8 failed plus targeted provenance/descriptive failures; GREEN 136 focused. Typecheck/build/full suite 1,197 passed/3 known skips/diff checks passed. Parent spot check 136 passed. Independent verifier reproduced three admission/isolation defects despite those passing tests.
- SEC-3 correction observed RED 6 passed/5 failed, targeted GREEN 18/18. Final typecheck/build/full suite 1,228 passed/3 known skips and focused 167/167 passed. Independent recheck repeated typecheck/build/focused 167/diff checks plus 15 owned-fixture probes; all passed. Parent repeated exact final focused command: 167 passed.
- Whole-message conservative consent accepts the exact user example `Quiero que hagamos una revisión de seguridad`, `lanza el agente de seguridad`, `usa mdd-security` and supported English aliases, rejecting descriptive/negated/quoted examples. Complex requests may require restatement. Explicit `baseRef` must come from authenticated native text.
- Security runtime permissions expose only the pure standalone `mdd_check_report`; independent execution/ancestry guards precede role/workspace exits and fence altered, relocated, descendant, closed and restarted security sessions. No actor writes, shell, file reads, network, delegation, coordination or implicit fix authority.
- Final native completion-envelope production and metadata timing were verified using OpenCode 2.0.22 deterministic host fakes, not live-model execution. No actual audit of this repository or global installation update was authorized or performed. These checks prove tested adapter behavior, not absence of vulnerabilities or native approval.
- SEC-3 commit: `99d543059997cc7be331f9e5d8a6cb2263b42f92`, 900 authored changed lines including tracking. Committed assessment high (`hot_path/security`), independent high-tier verification passed; native outcome disabled/unmanaged, no approval asserted. Future slice 3 holds this commit; no PR created. Coordinator asset 15,687/16,000 bytes.
- One cohesive work-unit slicing pass retained actor/report, snapshot/binding and dispatch/isolation units with their tests/docs. Units exceed 400 authored lines; do not publish oversized PRs without further authorized reviewable slicing or explicit maintainer size exception. No PRs have been prepared or opened.
- SEC-4 authorized by user: fetch/integrate latest main and send changes directly to main. User explicitly consented to existing configured Git authentication only for `https://github.com/vancinis/mdd-orchestrator.git`; no force-push or credential changes. Fetch completed; upstream is `6ebd3dc534d5712459789f730a1760ce6c52464c`, feature ahead 5/behind 15, initially clean. Fresh RDD mode status is off, decided by clone-local preference; do not start native reviews or reactivate it. Task/mirror recovery metadata remains local until reconciled after integration.
- SEC-4 local merge resolved 13 conflict paths, preserving all upstream Judgment Day/sequential Apply and security behavior. Final roster: 14 model roles, 8 phases; coordinator 15,972/16,000 bytes. Seven behavioral regressions cover adapter call settlement, durable unknown workflow claims, competing controls/questions/corrections, parallel judges and post-await exclusivity. Pure inherited merge has no artificial RED; meaningful corrective regressions observed RED before fixes.
- SEC-4 writer verification passed: typecheck/build, exact nine-file focused runner 417/417, full suite 1,361 passed/3 known environment skips, both whitespace checks and no unresolved paths. Parent repeated `npm run typecheck` successfully. Fresh assessment high (`security/hot_path`, `shell_process`); RDD off, ordinary independent verification applied.
- SEC-4 independent verifier passed typecheck/build, exact focused 417/417, installation/config/package/telemetry parity 71/71, both whitespace checks and empty unresolved list. No concrete candidate-caused regression found in checked scope. Actual host/model smoke remains unrun; no native approval asserted. Staged integration against feature HEAD +3,424/−171 across 51 files; inherited upstream +3,335/−172, so simple subtraction is not an exact authored count.
- SEC-4 integration commit: `3fedf3d723884fde3e6652ef17e624e1a7a3742d`. Latest main re-fetched immediately before publication and unchanged; both upstream and complete feature histories verified as ancestors. Commit tree matched the verified staged tree, and worktree was clean. Normal push advanced main `6ebd3dc` → `3fedf3d`; read-only remote ref check confirmed the exact commit. Final passive tracking receipt follows separately; no source bytes changed after functional verification.

## Next step

All four tasks are complete; source integration is published to main. Commit/publish this passive tracking closure and update/read back its full recovery mirror. No PR requested. Live-model smoke and global installation remain unrun and require separate authorization. RDD remains clone-local off; native review disabled/unmanaged, ordinary independent checks complete.
