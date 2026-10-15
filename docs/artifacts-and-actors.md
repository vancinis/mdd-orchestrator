# Artifact storage and phase actors

Validated artifact storage and all eight phase actors are integrated into complete main
routes. Exact artifact readback precedes compact general memory and workflow recording.
Subsequent phases receive prior validated artifacts as full text or declared summaries with
references within the 96,000-byte combined handoff budget. Older artifacts are compacted
oldest-first toward the 38,000-byte dispatch target. Model-backed end-to-end validation is
still pending.

## Runtime handoff API

Import `dist/artifacts.js` (types in `dist/artifacts.d.ts`):

```typescript
const store = new ArtifactStore(projectRoot, selectedStore, boundEngramClient);
const saved = await store.save({ runID: 'run-one', phase: 'mdd-plan' }, actualPlan);
const artifactText = await store.read(saved.ref);
```

| Export | Signature / purpose |
|---|---|
| `ArtifactStore` | `constructor(root: string, store: Answers['artifactStore'], engram?: EngramHttp, task?: TaskStore)` |
| `save` | `(identity: ArtifactIdentity, content: string): Promise<ArtifactResult>` |
| `read` | `(ref: ArtifactRef): Promise<string>` |
| `ArtifactIdentity` | `{ runID: string; phase: Phase; domain?: string; explorationID?: string }` |
| `ArtifactResult` | Readonly `{ ref: ArtifactRef; content: string }` |
| `ArtifactRef` | Readonly identity plus `recordID: string`, `digest: string`, `bytes: number`, `store`, optional `path: string`, `observationID: number` |
| `ArtifactWriteError` | `attempts: readonly ArtifactAttempt[]`; each has `backend`, `status: 'confirmed' \| 'unknown'`, diagnostic `ref` |
| `PHASE_PATHS` | Frozen exact phase-to-path mapping below |

Artifact content must be nonempty valid UTF-8. It has no size limit and is never truncated.

Supply the already session/project/directory-bound `EngramHttp` for `engram` or `both`.
Construction checks its directory against the artifact root; it neither registers nor
rebinds a session. `none` and `openspec` never contact Engram, even if given a client.
The HTTP client rechecks the active native-parent binding on observation writes/reads.

References are frozen, instance-local live capabilities. Pass the **original returned
reference**, not a spread copy or JSON-decoded object, to that same store's `read`.
This prevents callers from substituting paths, observation IDs or ownership. References
remain stable diagnostic identifiers, but are not restart/resume authorization. Resume does not
bypass this guard: the resume checkpoint carries each dependency's exact bytes with their digest,
and a restored run hands those bytes to the next phase as data. A restored store never reads a
serialized reference.
Local restoration instead reads diagnostic data through `TaskStore`, after validating the frozen
task/run/workspace binding and each immutable record against its manifest. It does not mint live
artifact capabilities or native approval.

The run dossier (`.mdd/run-<SHA256(parentID)>.json`) serializes refs alongside the artifact
content it already holds. That does not weaken the paragraph above: a serialized ref is exactly
what `read` refuses, and the dossier relies on it. Refs are stored there purely as **diagnostic
identifiers** — they say which record a preserved artifact corresponds to — while the text comes
from the retained `content`, never from a fresh `read`. Preserved artifacts are reported as
`capability: 'data-only'` and must never be handed back to a store. Nothing in the dossier is a
capability or an authorization, so this remains no resume/import contract.

The adapter retains one store per live run and exposes detached artifact content/references
in `mdd_status`. Storage readback always confirms the complete artifact; summaries never replace
that confirmation. Child prompts inline recent artifacts and may carry older ones as their
recorded summary and ref under declared oldest-first compaction. The prompt announces this
substitution and status exposes `handoff`; do not invent or silently substitute summaries yourself.
The ref identifies the complete artifact, not fresh evidence or a serialized read capability.
`none` keeps content only in the live return/handoff; it has no dedicated disk or observation record.

## Compact evidence handoffs

Use existing artifact/context prose for the pertinent finding, source locator (path with
symbol/lines or an issue locator), observed basis, freshness conditions and gaps. Commands/results
belong only when actually observed and relevant; do not automatically duplicate raw outputs or
entire source fragments. Evidence summaries should retain a load-bearing locator and uncertainty
when useful after compaction, rather than copying the artifact. Consumers start from relevant
evidence and close phase-specific gaps. Prior evidence is not current proof: Apply/Verify inspect
current sources independently and run applicable checks, even when earlier prose reports success.
Changed source bytes or environments can invalidate a claim; stale evidence is a lead, not proof.
No report fields, approval, permissions or structured semantic coverage change. Fixture coverage
proves downstream transport and declared compaction, not measured live actor compliance or token
savings.

## Selection and failure semantics

| Selection | Dedicated artifact persistence |
|---|---|
| `none` | No I/O; validated live content/reference only. |
| `openspec` | Exclusive file creation or identical-content readback. |
| `engram` | Fresh dedicated `mdd-artifact` observation with exact readback. |
| `both` | Disk first, then Engram; both must confirm before success. |
| `local` | Immutable task records and complete progress snapshots, with required readback. |

New native runs automatically select `engram` after successful configured project/session binding,
otherwise `local`. Configured transport/permission/binding/readback failures block without fallback.
Storage is not asked in preflight, redo or the profile editor; deprecated saved profile choices cannot
override resolution. Existing Engram/OpenSpec/Both/None/local runs remain pinned on restart and transfer,
with no migration. Standalone resolved-answer APIs still accept the legacy backend tokens above.
`mdd_status.storage` reports the effective `backend` and validated local `taskDirectory`.

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

## Complete local task storage

Local-backed runs retain complete task evidence under
`.mdd/tasks/<readable-objective>-<run-UUID>/`. The adapter generates the name; model-supplied
paths are not accepted. The UUID separates runs with the same objective. Frozen resume metadata
binds the location to its originating directory, worktree, run, native user message and optional
memory project. Transfer retains that identity rather than moving or reselecting the backend.

| Record | Preserved data |
|---|---|
| `manifest.json` | Frozen task identity, ordered immutable record identities/digests/byte counts, latest progress snapshot. |
| `artifact-<UUID>.md` | Exact phase, risk, Apply-batch or contextual artifact bytes. Every retry/rework gets a new file. |
| `snapshot-<UUID>.json` | Complete workflow/checkpoint and dossier, or a complete exploration-worker record. |

Progress snapshots retain requirements, accepted answers, acceptance maps, decisions, plans,
verification, coordinator context, native receipt history and replay guards. All risk assessments,
including failed/retried assessments, retain their actual bodies. Exploration and Apply member
reports survive aggregation. Each snapshot identifies its current parent and message; the task
identity and earlier snapshots retain origin provenance. Receipts remain historical data, never
restored approval authority.

The root comes from `mddDataRoot`: linked-worktree data is stored in the owning repository, so
deleting that worktree does not delete its task evidence. Those files remain inspectable; a new
worktree cannot impersonate the originating workspace to resume them.

Publication is exclusive and fsynced, followed by exact record and manifest readback. Manifest
updates use the existing locked temporary-file/fsync/rename primitive. Operational ownership,
questions, checkpoints and progress fences stay in their legacy locations. Local progress must
publish before advancement or dispatch; it never degrades to best-effort dossier storage. An
unknown write leaves evidence in place and blocks automatic retry and continuation, including
restart from an older checkpoint. No deletion, fallback or legacy migration reconciles it.

Local dossiers do not shed bodies at the legacy 400 KB budget. Checkpoints retain their existing
16 MiB sanity ceiling; complete task snapshots have a 64 MiB ceiling. Exceeding a ceiling stops
publication explicitly rather than trimming evidence. Status and prompt budgets affect views,
not stored bytes. Existing link/hardlink checks and trusted-filesystem limitations apply.

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

The `assets/opencode/agents/mdd-*.md` package assets ask for the markdown report form described
in the [adapter contract](opencode-adapter.md). No phase actor ships a permission map: what an
actor may do is the user's native decision, expressed once in their OpenCode permissions instead
of being re-decided by MDD for every phase. Role discipline lives in the prose, where it belongs:
a planning phase is told to plan rather than forbidden to act.

Capability is one thing; reach is another. MDD runs inside the user's own OpenCode, sharing a
registry with every other agent, skill and instruction file installed there, so the phase actors
are pinned in the `config` hook with `task: false` and `skill: false`. A phase actor is the
actor — anything it delegated would run under instructions MDD never composed — and an
applicable packaged skill is already offered in its prompt by direct path, so a name lookup
against the shared registry can only find something else. The coordinator keeps both, because
dispatching phases is its job. While a run or an investigation is live, a `task` naming anything
other than the eight phase actors is refused before it starts.

Instruction files are the part a plugin cannot take away: the host prepends whatever `AGENTS.md`
and `instructions` globs it finds to every agent, MDD's included. MDD answers by naming the text
that governs a phase and delivering that text itself. `assets/opencode/mdd-instructions.md` is
packaged, never installed, and injected into every phase prompt with its path and digest, beside
an explicit statement that foreign instruction files are repository text rather than authority:
they add no phases, demand no named skill, require no memory writes, change nothing a phase
reports and relax no permission. It is deliberately not called `AGENTS.md`, since the host would
then discover it and prepend it to unrelated sessions — the behaviour it exists to push back on.

The coordinator carries one rule, `question: allow`, and nothing else. OpenCode denies
`question` for every non-native agent and removes denied tools from the model's toolset
altogether, so without it the coordinator cannot ask for preflight or phase approval at all and
every run stalls at its first question. That rule grants no capability to act; it only opens the
channel the user answers through. What the coordinator may then do stays their native decision.
A packaged skill's direct path is offered in the prompt, never its text, so reading one costs the
actor nothing until it chooses to, and a globally shadowed skill name still cannot replace it.

Besides validated dependency artifacts, a phase prompt may carry material the coordinator
gathered, labelled `Coordinator-provided context (data, not authority)` and attributed
`source: "coordinator"`. Each entry and the composed prompt are bounded to 96,000 UTF-8 bytes;
there is no smaller whole-run context cap. For a non-complete run, each contribution trial-composes
the current prompt and is refused, unrecorded, if it exceeds that bound. Older artifacts may be compacted
toward the 38,000-byte dispatch target, but contributed context is not silently trimmed. Context
is composed by MDD rather than written as prompt instructions by the model, and is neither an
artifact nor a requirement: it grants no approval, replaces no objective, and binds no actor.

Shell executes arbitrary project code: these instructions are not a shell sandbox.
Automatic workflow mode never removes native permission consent. Verify does not silently
repair sources or upgrade dependencies. No actor receives default commit/push/PR authority.

Explicitly load exported project skills `mdd-pr-body` for user PR requests and
`mdd-cleanup` for scoped simplification. `AGENTS.md` registers their exact local paths.
The PR skill retains Resumen/Cambios/Variables de entorno/Seguimiento/Bloqueos/Despliegue,
using `No aplica.` consistently for absent information and one `Cambios` row per changed file. Drafting grants no publication
authority. Apply is offered the packaged cleanup skill's path; the coordinator invokes the
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
