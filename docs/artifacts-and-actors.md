# Artifact storage and phase actors

Validated artifact storage and all eight phase actors are integrated into complete main
routes. Exact artifact readback precedes compact general memory and workflow recording.
Every subsequent phase receives all prior validated contents and references within the
96,000-byte combined handoff budget. Model-backed end-to-end validation is still pending.

## Runtime handoff API

Import `dist/artifacts.js` (types in `dist/artifacts.d.ts`):

```typescript
const store = new ArtifactStore(projectRoot, selectedStore, boundEngramClient);
const saved = await store.save({ runID: 'run-one', phase: 'mdd-plan' }, actualPlan);
const artifactText = await store.read(saved.ref);
```

| Export | Signature / purpose |
|---|---|
| `ArtifactStore` | `constructor(root: string, store: Answers['artifactStore'], engram?: EngramHttp)` |
| `save` | `(identity: ArtifactIdentity, content: string): Promise<ArtifactResult>` |
| `read` | `(ref: ArtifactRef): Promise<string>` |
| `ArtifactIdentity` | `{ runID: string; phase: Phase; domain?: string; explorationID?: string }` |
| `ArtifactResult` | Readonly `{ ref: ArtifactRef; content: string }` |
| `ArtifactRef` | Readonly identity plus `recordID: string`, `digest: string`, `bytes: number`, `store`, optional `path: string`, `observationID: number` |
| `ArtifactWriteError` | `attempts: readonly ArtifactAttempt[]`; each has `backend`, `status: 'confirmed' \| 'unknown'`, diagnostic `ref` |
| `ARTIFACT_MAX_BYTES` | 16,000 UTF-8 bytes, no truncation |
| `PHASE_PATHS` | Frozen exact phase-to-path mapping below |

Supply the already session/project/directory-bound `EngramHttp` for `engram` or `both`.
Construction checks its directory against the artifact root; it neither registers nor
rebinds a session. `none` and `openspec` never contact Engram, even if given a client.
The HTTP client rechecks the active native-parent binding on observation writes/reads.

References are frozen, instance-local live capabilities. Pass the **original returned
reference**, not a spread copy or JSON-decoded object, to that same store's `read`.
This prevents callers from substituting paths, observation IDs or ownership. References
remain stable diagnostic identifiers, but are not restart/resume authorization. A future
resume feature needs an explicit authenticated import contract; do not bypass this guard.

The adapter retains one store per live run and exposes detached artifact content/references
in `mdd_status`. Actual validated text and references are passed to subsequent child prompts.
Budget prompt space using `bytes` before dispatch.
Do not substitute a digest or summary for the actual dependency artifact. `none` keeps
content only in the live return/handoff; it has no dedicated disk or observation record.

## Selection and failure semantics

| Selection | Dedicated artifact persistence |
|---|---|
| `none` | No I/O; validated live content/reference only. |
| `openspec` | Exclusive file creation or identical-content readback. |
| `engram` | Fresh dedicated `mdd-artifact` observation with exact readback. |
| `both` | Disk first, then Engram; both must confirm before success. |

**General memory is optional and independent of artifact selection.** Engram and Both
require an opted-in backend. With memory off, the runner omits the client and receipt writes;
no placeholder IDs or persistence claims are created. When enabled, it writes compact receipts with
an evidence summary and artifact reference, never a full artifact field. The existing
`EngramHttp.save(title, content)` receipt API is unchanged. Model-generated summaries are
still task data, not independently validated claims about semantic correctness.

Dedicated observations use a unique UUID record ID, `MDD artifact v1:` title prefix,
`type: mdd-artifact`, project scope, and JSON content containing kind/version, identity,
digest, byte count, selected store and exact artifact text. No topic key/upsert is sent.
Repeated saves never overwrite an earlier observation. These low-level HTTP methods are
storage internals, not caller-authorized arbitrary observation access:

```typescript
EngramHttp.assertArtifactDirectory(directory: string): void;
EngramHttp.saveArtifact(title: string, content: string): Promise<number>;
EngramHttp.readArtifact(id: number, title: string): Promise<string>;
```

Dedicated envelopes are bounded at 100,000 bytes; HTTP remains explicit loopback only,
at most five seconds per request and 128 KiB per response. `ArtifactObservationError`
retains a known `observationID` when POST succeeded but confirmation failed.

A persistence exception exposes attempted backends and their references without source
content or raw transport/filesystem errors. `unknown` is deliberately conservative:
it includes rejected preconditions as well as possibly committed writes. The next backend
is not attempted after a failure. No rollback, deletion, retry or workflow advance occurs.
A partial disk write may remain after I/O failure. Inspect known references and reconcile
explicitly; never claim that failure means nothing was written. Both-mode reads recheck
both backends and fail on either mismatch; they never select whichever copy still works.

## Exact OpenSpec layout

All paths below are relative to `openspec/changes/<runID>/`. Folders are created only
when disk storage is selected and a save is attempted; construction/read never creates them.
No OpenSpec CLI or SDD build workflow is required.

| Phase | Path | Deliverable and dependency handoff |
|---|---|---|
| `mdd-explore` | `exploration.md` | Findings, relevant code, uncertainty and constraints for proposal/plan. |
| `mdd-plan` | `plan.md` | Scoped files, changes, checks and risks for low-route apply. |
| `mdd-propose` | `proposal.md` | Intent, scope/exclusions and acceptance criteria for specification. |
| `mdd-spec` | `specs/<domain>/spec.md` | Requirement IDs, invariants and scenarios for design/tasks/verify. |
| `mdd-design` | `design.md` | Boundaries, interfaces, tradeoffs and test seams for tasks/apply. |
| `mdd-tasks` | `tasks.md` | Ordered task IDs, dependencies and completion checks for apply. |
| `mdd-apply` | `apply-progress.md` | Actual changed files, task state, checks and limitations for verify. |
| `mdd-verify` | `verify-report.md` | Actual commands/exit outcomes, skips, uncovered requirements and blockers. |

Optional side exploration uses `explorations/<explorationID>/exploration.md` instead.
`domain` is required only for spec; `explorationID` is accepted only for explore.
All slugs are 1–64 lowercase ASCII alphanumerics/hyphens, first character alphanumeric;
Windows device names are rejected. Unknown identity keys/phases and traversal are rejected.
Runtime generates the Markdown; storage validates nonempty, lossless UTF-8 and size,
not phase prose quality. It retains exact bytes with a SHA-256 digest, without wrappers.

Files are exclusive (`wx`, mode `0600`) and fsynced, never replaced with different bytes.
Directories use `0700`; Windows ACLs still apply. Existing links/junctions, hardlinks,
nonregular files, linked root ancestors and oversized files are rejected. Fixed validated
paths stay project-contained. No file is deleted, even on failure. Portable path checks
are **not a sandbox against a hostile process renaming ancestors concurrently**; directory
fsync/power-loss durability is not guaranteed. Use a trusted project filesystem.

## Native assets and permissions

The `assets/opencode/agents/mdd-*.md` package assets require the provider-generated strict
result schema and exact phase/runID/native callID bindings. None of them ships a permission
map: what an actor may do is the user's native decision, expressed once in their OpenCode
permissions instead of being re-decided by MDD for every phase. Role discipline lives in the
prose, where it belongs: a planning phase is told to plan rather than forbidden to act.
Packaged skill text, path and digest are injected in the prompt so a globally shadowed skill
name cannot replace them.

Shell executes arbitrary project code: these instructions are not a shell sandbox.
Automatic workflow mode never removes native permission consent. Verify does not silently
repair sources or upgrade dependencies. No actor receives default commit/push/PR authority.

Explicitly load exported project skills `mdd-pr-body` for user PR requests and
`mdd-cleanup` for scoped simplification. `AGENTS.md` registers their exact local paths.
The PR skill retains Summary/Changes/Environment variables/Follow-ups/Blockers/Deployment,
using `Not applicable.` consistently for absent information. Drafting grants no publication
authority. Apply receives the local cleanup instructions; the coordinator invokes the
`mdd_pr_body` renderer when the user asks for a body. No publication is performed.
Quit and restart OpenCode to discover changed agent/skill configuration.

## Completion boundary

Run `npm run typecheck`, `npm run build`, `npm test`, and the bounded isolated smoke:
`node --test --test-name-pattern="bounded isolated storage smoke" tests/artifacts.test.mjs`.
Tests use temporary files and a fake loopback HTTP service, never real Engram or models.

Protected intake/approval, full-route dispatch, artifact handoff, evidence reports and local
metadata telemetry, confirmed reruns/material changes, contextual exploration and a minimal
startup replay guard, PR-body drafting and global setup are integrated. Coverage remains
20/20/25/35, not score overrides. Final model-backed proof and native review belong to the parent.

The runner now depends on ArtifactStore. Rollback of its native integration must remove
the store initialization, save/readback/status wiring and related runner tests together.
The standalone storage module and actor assets can remain independently available.
