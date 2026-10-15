# MDD product contract

**Status: routing kernel, proof CLI, protected native intake and complete main-route execution are implemented and contract-tested. Model-backed E2E remains pending.** This is passive product documentation, not an operational agent instruction file or an SDD specification. The [adapter boundary](opencode-adapter.md) distinguishes implemented capabilities from remaining product requirements.

## 1. Approved preflight inputs

### Ranked product priorities

1. A good design or plan enables useful implementation.
2. Verification compares the result with **requirements and the plan**, not merely command exits.
3. Time is as important as quality on both routes. Avoid process that does not help the outcome.
4. Human summaries stay simple even when the technical work is complex.
5. The workflow helps the user get from A to B; it is not an authority over the user.

Automatic execution continues an approved plan without redundant continuation questions.
Explicit interactive mode, native permission requests, scope checks and review boundaries
are not disabled. The preflight answers are not scored: every run starts with exploration and a
validated `mdd-risk` verdict selects the continuation.

### Acceptance and plan alignment

Low retains one compact Plan artifact and the existing three-phase path. Its structured
acceptance map records an A-to-B goal, stable requirement/scenario IDs with given/when/then
behavior, relevant decisions, and linked implementation steps/checks. High uses the same
IDs through Spec, Design and Tasks, without introducing a parallel specification system.
The adapter appends the validated map to the existing phase artifact; there are no extra
phases, approval questions, review gates, ledgers or recovery engines.

Verify must cover every held scenario-step link, step and relevant decision, using an actual
applicable planned check reference or explicit not-verified/deviation assessment. Missing,
duplicate, invented or inapplicable links cannot yield successful completion. Genuine gaps
remain visible and cannot earn 100% coverage. Only planned checks are executed.

Structural completeness does **not** prove that the agent interpreted every user requirement
correctly, that its semantic assessments are true, or that the checks are sufficient. The
agent must explain source evidence and limits; native execution provenance is independently
checked by code. The default closure describes the requested outcome, changes, requirement
and plan match, actual checks and material limits. Internal IDs and receipts stay in drilldown.

This is original MDD code/instructions using traceability patterns, not imported Gentle AI
SDD/RDD runtime, commands, dependencies or copied gate text.

The four preflight questions preserve their original order and option meanings. Field names and case-sensitive tokens below are the executable interface. A legacy fifth field, `complexity`, is still accepted on input (saved profiles, kernel requests) for backward compatibility, but it is never asked: judging complexity belongs to the risk assessment after exploration, not this intake.

| # | Question / field | Options in order: label → token | What uses it |
|---|---|---|---|
| 1 | Requirements certainty / `certainty` | Very sure → `very-sure`; Somewhat sure → `somewhat-sure`; Not sure → `not-sure` | `mdd-risk` receives it as the user's own statement of how clear the requirements are and weighs it beside the exploration findings; it never selects a route by itself |
| 2 | Workflow artifact storage / `artifactStore` | Engram → `engram`; OpenSpec → `openspec`; Engram + OpenSpec → `both`; None → `none` | Where phase artifacts are stored |
| 3 | Phase advancement / `mode` | Interactive (ask each phase) → `interactive`; Automatic (advance) → `automatic` | Whether each later phase waits for an approval |
| 4 | Phase summary level / `summary` | Detailed → `detailed`; Medium → `medium`; Low → `low` | Which report sections are shown |

All four answers are required. There are no invented answer defaults. All native phases use selected artifact storage, and reports reflect grounded current-phase evidence. No answer is scored: there are no weights, no threshold and no score.

## 2. Approved routing policy

The applied rule version is **`mdd-routing-v2`**. Version 1 scored the preflight answers against a threshold; version 2 scores nothing. Every run starts with exactly one `mdd-explore`, followed by the `mdd-risk` stop, and a validated `mdd-risk` verdict — or the user forcing the other route at its first approval, or choosing one manually after a blocked assessment — selects the continuation. Until then the run has no route, and status shows it as pending.

Phase identities use the `mdd-*` form everywhere in output:

| Route | Exact ordered phases |
|---|---|
| Low | `mdd-explore`, `mdd-plan`, `mdd-apply`, `mdd-verify` |
| High | `mdd-explore`, `mdd-propose`, `mdd-spec`, `mdd-design`, `mdd-tasks`, `mdd-apply`, `mdd-verify` |

A run recorded before the risk stop existed keeps the route it recorded, including the older low route without exploration (`mdd-plan`, `mdd-apply`, `mdd-verify`). `explore` is still accepted on input for those saved requests but no longer changes the first phase.

### Routing-contract pins and inactive future vocabulary

| Request discriminator | Interpretation |
|---|---|
| `routingVersion` omitted | Retains historical fixed semantics permanently. Modern histories replay their low/high Risk events; older unmarked histories may infer the single known legacy route that fits. No version is stamped. |
| `routingVersion: 2` | Explicit fixed contract with the same default evaluation and low/high tails. Recording preserves the pin; replay cannot fall back to legacy route inference. An explicitly recorded known legacy route still retains that route. |
| `routingVersion: 3` | Reserved, inactive future contract. Construction, evaluation and replay reject execution. |
| Any other supplied value | Rejected, including null, strings and explicit undefined. |

Resume checkpoint versions 2 and 3 integrity-bind an explicitly supplied routing discriminator.
Removing, inserting or altering it without a valid new seal is rejected. Unmarked checkpoints
retain the exact historical digest. Checkpoint version 1 has no seal and cannot carry a pin.
Restart and both transfer projections preserve the pin; none grants new execution authority.

The pure `parseFutureAssessment` reader in `dist/risk.js` accepts only
`{ assessmentVersion: 1, complexity, impact }`, with each level independently `low`, `medium`
or `high`. High impact with low complexity is valid in this separate future assessment; it is
not a current Risk verdict and selects no route. Current `parseRiskVerdict` still requires
equal low/high `route` and `complexity`. Public adaptive low and structured medium execution are
not active. Summary level `medium` remains a presentation choice, not a runtime route.

### Internal adaptive admission, evidence, recovery and transfer (AL-02/AL-04b)

An unregistered internal lane supports `await-selection -> authorized-actor ->
await-result -> await-selection`. The parent selects one necessary Explore, Risk, Plan, Apply
or Verify actor with a purpose and assignment identity; no fixed Workflow or omitted Plan
receipt is fabricated. Selection boundaries carry no phase, workflow, phase report format
or fixed-route visual. Status retains bounded selection metadata and the last actual receipt,
not the full contract body. Public startup and the inactive `routingVersion: 3` guard are unchanged.

| Boundary | Internal guarantee |
|---|---|
| Admission | Intake proves genuine native objective text/message; runner independently rechecks it, exact coordinator/workspace, idle ownership and current local source fingerprints. Caller-supplied approval or provenance IDs are not proof. The initial intake supports only explicitly automatic profiles; interactive or unspecified modes are refused rather than bypassed. |
| Compact contract | Version 1, stable globally unique acceptance/decision/assignment/evidence IDs, exclusions, complete exact scopes, dependency-ordered assignments and source or real command obligations are validated and copied before native awaits. Contract-authored links do not claim Plan provenance. |
| Selection | Unresolved product ambiguity pauses all actors. Technical uncertainty permits a brief scoped Explore only. Apply requires low impact independently of complexity, understood bounded dependencies, current fingerprints, completed prerequisites and real scoped-editor capability. |
| Native execution | Exact issued handles are consumed once, with one actor/writer and existing native result/liveness inspection. Apply edits only through the existing single-child WorkerFence and `mdd_worker_edit`; generic editors, shell and out-of-scope writes remain denied. Unsafe bootstrap/config footprints and unsupported hosts have no serial fallback. |
| Settlement | Every confirmed stopped actual actor returns to selection. Failed, malformed or absent receipts earn no progress or automatic retry; another writer requires an explicit repair reference. Reports cannot broaden acceptance/scope or decide product questions. Internal Risk uses the independent future assessment, never a historical Risk verdict. |
| Persistence | Production injects a separate bounded adaptive record/store under the product data root, using existing LocalFiles protections. It is not a fixed checkpoint, dossier or fabricated phase artifact. Pending native intent is durable before provider arguments; an accepted receipt is durable before the settled marker and ownership release. The existing child marker remains `resumable:false` for fixed-checkpoint recovery. |

Scoped actors cannot execute commands. Real planned checks retain their requiredness and
applicability as unexecuted obligations; source-only work uses a separate small source-obligation
variant, not fake commands. The coordinator executes actual checks through its existing permitted
tools; the internal evidence operations do not execute commands, expand permissions or attest
SDK/host execution. Optional Verify is still a fenced, read-only source reviewer, not an executor.

#### Final evidence and honest closure

The guarded internal sequence is **prepare source snapshot → execute permitted checks → submit
parent readback → close**. Each operation is serialized with actor selection and rechecks exact
native coordinator/runtime/workspace, the current single-use handle, idle ownership (including its
epoch), absence of pending intake/child admission, and native parent inspection after any await.

| Evidence boundary | Guarantee and limitation |
|---|---|
| Preparation | Locally inspect the complete declared read/write footprint before checks. Exact-file alias checks, credential exclusions, fingerprints, UTF-8 readback, 256 KiB per-file and 1 MiB total byte budgets apply. Completed assignment inputs/outputs must still match. Preparation returns bounded source bodies; ordinary status retains only compact metadata. |
| Parent readback | Repeat exact held acceptance criteria, scope, exclusions and decisions. Supply final diff inventory with assignment/unrelated dispositions and reasons, one finding per exclusion, every source obligation with its exact paths, and every scenario-assignment, assignment and decision assessment. Apply summaries do not supply this readback. Locally changed declared bytes cannot be omitted; whole-worktree inventory remains a reported observation, not comprehensive diff attestation. |
| Commands | Reuse structured chronological execution and held-check accounting. Required applicable failed, interrupted or blocked checks prevent verified closure; missing dispositions are rejected. Optional failures remain visible. Unconditional checks cannot be waived, command mismatches require an explicit supported replacement, and retries retain complete attempts and reasons. Supplemental entries cannot hide a held command retry. Re-preparing unchanged source cannot erase execution history; a malformed disposition does not erase an otherwise readable reported attempt. |
| Source-only proof | Separate obligation readback and linked source assessments can support verified semantic rows without invented command IDs. Command-backed rows cite actual reported successful final execution IDs. All held source and semantic links must be covered exactly; exit codes alone do not prove acceptance. |
| Freshness and assurance | Submission and verified closure independently recheck the prepared local fingerprints and completed prerequisites. This is structured parent-reported consistency, **not independent execution or applicability attestation**. Any malformed resubmission removes the current match until corrected. |
| Closure | All assignments must have actual accepted Apply completion and all required evidence/semantic links must match. No Plan or Verify receipt is mandatory. `completed` records snapshot-bound reported verification; `closed-unverified` requires explicit remaining limits and never earns verified completion. Terminal status retains coverage, failed/optional dispositions, limits and assurance; next-action grants no new work or review authority. |
| Explicit repair | A completed writer can be selected again only for failed or stale evidence, referencing its latest actual Apply receipt. Reinspect only its existing footprint, invalidate overlap/dependency-sensitive completion and proof, and retain unrelated completed fingerprints and prior evidence. Old command proof is invalidated conservatively; checks must follow a fresh final snapshot. There are at most four completed-assignment repairs and 64 actor receipts, with no automatic retry or new scope. Overlapping prerequisites must be explicitly repaired first. |

#### Durable same-parent recovery

Adaptive record version 1 carries immutable original admission bytes, current context and
assessment, actual correlated receipts, completed output and unchanged-input fingerprints,
source snapshots and evidence matches, historical failed checks, invalidation/repair counts,
closure, consumed call IDs and a sequence/digest. Ordinary status is not the serialization
contract. Bounds and relational validation reject unsupported versions, contradictory completion,
tampered proof and unsafe storage rather than treating them as empty.

| Recovery boundary | Guarantee |
|---|---|
| Publication | Parent-locked bootstrap intent precedes parent binding and owner claim. Every journal change uses staged CAS and exact readback before in-memory authority changes. An ambiguous outcome fences authority until reconciliation, never a blind retry. Fixed admission/reset/transfer cannot bypass occupied adaptive data, including unreadable records. |
| Fresh authority | Restoration proves the native parent, exact workspace and current ownership after asynchronous inspection. Settled or unstarted records restore actorlessly with fresh selection handles; dispatch tokens, provider arguments, native approvals and selected actor capabilities are never deserialized. CAS generation changes fence old-process callbacks and handles. |
| Pending children | Unknown or running attempts retain quarantine and reservation. Even a stopped child requires explicit recovery with actual native stopped proof; user attestation or abort acknowledgment alone is insufficient. Recovery records a failed interrupted receipt before release, preserves partial source, and never automatically retries Apply. |
| Dispatch-time prerequisites | Pending Apply retains exact successful receipt links for its complete prerequisite chain. These validated historical admission links survive current proof invalidation, so an interrupted child can roundtrip and settle as failed after native stopped proof. They never restore completion or authorize a new writer; fresh Apply still requires current completed prerequisites and explicit repair. |
| Retained work | Changed settled output is compared with its settled proof, not its original admission digest. Stale output, unchanged eligibility input, overlap and dependent proof invalidate affected completion without refreshing stale context or redoing unrelated work. Original admission bytes remain the final diff baseline. |
| Evidence and closure | Failed attempts remain snapshot-bound historical evidence, not current PASS. Stale proof loses its match; verified closure becomes closed-unverified without reopening execution. Repair still requires the latest actual Apply receipt, current source context and the finite repair budget. |

The injected-store path has deterministic native/runtime fault tests, not live-host or model
attestation. Legacy in-process test hosts without a store remain volatile. An uncorrelated
reservation or unsafe record remains fenced rather than granting automatic takeover.
Public version 3 remains inactive. Executable escalation belongs to AL-04c, and public activation
belongs to AL-05.

#### Internal native-proven transfer

The unregistered intake/runner transfer moves adaptive **data**, not fixed checkpoints or a phase
history. It requires the same exact workspace/worktree; there is no cross-worktree execution or
new public tool. Both native parents are inspected before claims. The latest target-authored
request must name the exact source/run, bind the immutable admission digest and objective, and
explicitly preserve acceptance, scope, exclusions and decisions. Raw IDs, approval flags and
caller-supplied text are not provenance.

| Transfer boundary | Guarantee |
|---|---|
| Idle proof | Source is actorless with no pending child, intake, question or writer. Complete native control history and positive child termination are required; truncated/compacted history and unknown/running children fail closed, with no age-based release. Target durable and volatile state is checked, including unreadable/future records and closed legacy claims. Native intake admission is excluded throughout asynchronous transfer inspection. |
| Projection | `AdaptiveLow.restore` validates real receipts and selectively invalidates stale proof. Original admission, actual completion, failed checks and closure survive; invalidated verified closure stays closed-unverified. No omitted phase, PASS, consent, selection or dispatch capability is manufactured or reused. |
| Publication | Target parent claim binds exact projected bytes; source owner epoch CAS fences the old parent; target publication/readback precedes a distinct adaptive ownership receipt. Receipt binds operation, source/target generations/digests, admission, native request and epoch. Fixed receipts and historical checkpoint digests retain their original interpretation. |
| Authority | Adaptive record updates share the owner lock with transfer fencing. Status, selection, evidence, restore fast paths and callbacks also verify durable owner/parent/lineage and record generation. Fresh target runtime handles appear only after ownership commit and native parent/request readback. Cold target restore re-proves native provenance before exposing new handles. |
| Interruption | There is no cross-file atomicity assumption or blind retry. Explicit exact-operation finish/abort requires fresh latest native recovery proof and rechecks after asynchronous inspection. Abort reserves durable cleanup authority before conditionally retiring only the exact unfinished target record and claim, then rotates the source generation before release. Late finish callbacks lose their CAS; committed target ownership cannot be aborted. |

Divergent bytes, changed projection proof, unknown native state or failed readback stay fenced.
Operation IDs may repeat across transfers: completed-receipt selection also requires the exact
source/target endpoints and confirmed claim, epoch and generation/digest lineage. An earlier hop's
receipt never substitutes for the current hop's native authorization during cold finish.
An aborted target's retired claim is not treated as an empty transfer destination. Verification
uses deterministic local native/runtime harnesses, not a live host, model or native approval.

## 3. Kernel API and validation

After `npm run build`, import `evaluate` from `dist/kernel.js`. It accepts an unknown value and validates its entire request before evaluation:

```javascript
import { evaluate } from './dist/kernel.js';

const answers = {
  certainty: 'very-sure',
  artifactStore: 'none',
  mode: 'automatic',
  summary: 'low',
};

const direct = evaluate({ answers });
const saved = evaluate({ profile: { answers } });
// direct and saved contain identical results.
```

| Request field | Contract |
|---|---|
| `answers` | Complete four-field answer object. Mutually exclusive with `profile`. The legacy `complexity` key is accepted and ignored if present. |
| `profile` | Exactly `{ answers: <complete four-field object> }`. Uses the same answer validator and evaluator. |
| `explore` | Optional boolean, accepted for saved requests; it no longer changes the first phase. |
| `routingVersion` | Optional integer `2` pins the fixed contract; omission keeps historical semantics. Reserved `3` is inactive and rejected. Output remains `mdd-routing-v2`. |

A request that still carries `config` (the old threshold and weights) is rejected with a `ValidationError` that says scoring was removed, rather than having its weights silently ignored; the CLI's `--config` flag is refused the same way.

Complete kernel profiles bypass prompting. Partial kernel profiles fail; the proof never fills or prompts for missing answers. Separate project settings support named profiles, models, and partial answers through the terminal editor; see [configuration](configuration.md). Native model overrides and protected grouped question consent are integrated. Identical inputs produce identical results.

Unknown fields/options, missing required answers, nulls, arrays, non-plain objects, and incorrectly typed optional fields fail with `ValidationError`. Explicit `undefined` is invalid for optional fields; omission is different. Exactly one input source is required. Mutating evaluation results does not affect future calls. Evaluation does not mutate its inputs.

### Deterministic result

| Field | Meaning |
|---|---|
| `policyVersion` | Applied rule identifier, currently `mdd-routing-v2`. |
| `route` | Absent from a fresh evaluation. A workflow sets it to `low` or `high` only once `mdd-risk`, an override or a manual recovery choice selects the continuation. |
| `phases` | Exact ordered `mdd-*` phase identities: `mdd-explore` until a continuation is selected. |
| `reasons` | Fixed-order explanations of how the first phase and the continuation are decided. |

The kernel does not emit timestamps, random identifiers, model inference, confidence, or persistence metadata. Identical validated inputs produce structurally identical output; equivalent CLI sources also produce byte-identical JSON. The output is not a persisted lifecycle receipt.

### In-memory workflow API

Import `Workflow` from `dist/workflow.js`. Construction accepts the same validated request as `evaluate`; both share `preflight` from `dist/kernel.js`, which returns resolved answers and evaluation in one pass. The controller privately captures that result once. Caller inputs and returned snapshots cannot change held answers, route, mode, or results.

| Operation | Contract |
|---|---|
| `nextAction()` | Detached action: `execute`, `approve`, `await-result`, or `blocked`, each with `phase`; terminal `finished` has no phase. Never advances. |
| `snapshot()` | Detached `{ answers, evaluation, nextAction, results }`; repeated reads reuse the live preflight and do not advance. |
| `start(phase)` | Only the exact ready phase may become running (`await-result`). |
| `recordResult({ phase, outcome, evidenceSummary })` | Only the running phase accepts a result. Outcome must be `passed` or `failed`; evidence must be a non-whitespace string. Unknown fields and malformed results fail. |
| `approve(phase)` | Only the exact phase awaiting approval becomes ready; approval cannot authorize later phases. |

The first phase is ready after construction. A pass makes the next phase ready in automatic mode or awaits its approval in interactive mode. Final Verify success finishes without another approval. Failure, including Verify failure, blocks permanently: no retries, fabricated success, or confidence values. Invalid operations throw `ValidationError` without changing state.

Controller results are **caller-supplied claims, not independent verification**. The OpenCode adapter separately checks native child invocation/result/history evidence and Engram readbacks before recording results. Explicit native-confirmed changes create a new planned run in the same conversation, retaining old evidence. Contextual exploration uses a separate execution slot without advancing the main controller. A run resumes after process loss only from a validated checkpoint of a *settled* state, in the same conversation or — on the user's explicit request naming the source conversation and run — in a new one: a ready phase is dispatchable again, an approval is asked again, and nothing in flight is ever replayed, because MDD cannot know what an interrupted implementation phase wrote to the working tree; such an attempt is released only when the host confirms it stopped or the user says so in their own latest message. When no usable checkpoint exists (for example after a checkpoint write kept failing), the plan, acceptance map, artifacts and reported evidence of the lost run are reported as read-only data, so new work begins holding them while still earning its own preflight and its own approvals.

### Clarification conversation boundary

User-facing conversation is always Spanish, including clarification/question text, option labels
and descriptions inside tool arguments. Technical artifacts, phase reports and protocol keys stay
English. Exact native user text is never translated or rewritten.

Clarification prose has no individual question, option or answer byte ceiling. Full question and
answer strings are durable and become attributed context content under a short stable label,
not phase approval. Nonempty/type validation, choice counts, distinct/reserved labels, exact host
answer matching and parent/call ownership checks remain unchanged. Aggregate storage and transport
safety limits remain explicit; no truncation or automatic re-asking substitutes for an answer.

All pending clarifications are asked together in one native interaction. Each may name a short
topic, say why it matters, allow several choices, or offer no choices for an open-ended answer;
delegation to the agent and free text are always available. They come from three places: doubts
the coordinator passes to `mdd_start` (asked with preflight), decisions a phase reports under
`## MDD Questions` (asked at the next boundary, in automatic mode too), and the coordinator's own
questions before a ready phase is dispatched. Answers are context, never approval.

## 4. Runnable proof and verification boundaries

The [README](../README.md) provides working PowerShell commands and exit codes. `examples/answers.json` and `examples/profile.json` are equivalent complete sources. The CLI reads UTF-8 JSON files, accepts a leading BOM, validates input, and prints the evaluation. It never executes the returned phases or creates artifact folders.

The stack is TypeScript compiled to Node.js ESM with native Node tests. Node 24.6+ within 24.x, or 26.4+ within 26.x, remains the declared proof runtime (Node 25 is not supported). The host adapter pins `@opencode/plugin@2.0.22` and `@opencode/client@2.0.22`; `@opencode-ai/plugin@1.18.31` remains an internal motor/regression dependency. Host SDK and schema dependencies do not enter the pure kernel.

The focused suite covers that no answer is scored, that a request still carrying the removed `config` is refused, answer and profile validation, and CLI subprocess behavior. Lifecycle tests cover exact phase order, live preflight reuse, mutation isolation, phase-scoped approvals, failure blocking, and invalid operations. These tests are **kernel, lifecycle, and CLI verification, not full harness integration or independent review**. The runnable `examples/workflow-demo.mjs` uses simulated results and approvals only.

## 5. Finished harness direction — confirmed, deferred

MDD means **my-driven-development**. The finished product is OpenCode-first; eventual Claude Code, Pi, and Codex support are goals. One orchestrator coordinates phase-specific `mdd-*` subagents. The low path prioritizes fast, clear execution; the high path prioritizes quality. Non-linear contextual exploration and revisiting issues are allowed in the future harness; transition mechanics remain open.

### Grouped preflight and lifecycle

Native intake now uses one grouped preflight after verified native requirements and before
routing; a complete frozen profile bypasses it unless the coordinator has doubts about the
request. Missing fields alone are asked in original order, with no guessing, followed by an
optional free-form note. Native before/after question metadata authorizes first execution;
subsequent interactive Proceed/Stop receipts authorize only the waiting phase. Automatic mode
does not ask phase approval questions. Complete native contract tests cover low/high routes,
all artifact stores and exact approval slots through Apply/Verify. Answers are reused. Explicit
reruns and material changes use the same native gate: confirmation, then one fresh grouped
preflight. Rejection preserves the current plan. In-flight/uncertain work cannot
be reset. Ordinary implementation choices and automatic progression add no change questions.

Stable explicit inputs and versioned routing are implemented here. Any future automated complexity classifier must not be confused with deterministic scoring; classifier evidence/reconciliation and non-linear transitions still need design. Deterministic routing does not imply deterministic model output or statistical certainty.

### Engram and workflow artifact storage

**Engram installation and use are optional.** Absent `engram` settings mean memory is off, not a setup failure or degraded run. Native identity, approvals, scope, acceptance, commands and local progress guards remain enforced. With memory off, preflight offers OpenSpec then None. An incompatible saved Engram/Both choice is explained and reasked alongside other missing fields without changing the stored profile. With an opted-in backend all four choices remain available. Enabled memory persists compact intent/result receipts independently of artifact selection; `none` retains full artifacts only in the live run. An unavailable opted-in backend blocks rather than silently disabling memory.

OpenSpec is used only when requested; no automatic folders are authorized. The user approved building this iteration directly without SDD phases or artifacts. Future high-route phase names do not authorize an SDD development process for this project.

### Phase reporting

| Level | Implemented report fields |
|---|---|
| Detailed | `Resumen`, `Cómo se hizo`, `Propósito`, `Pendiente o incierto`, `Aprendizajes clave`, `Confianza` (the actor's stated High/Medium/Low level and its reason), `Estado` |
| Medium | `Resumen`, `Propósito`, `Aprendizajes clave` |
| Low | `Resumen` only |

Every phase actor writes all of these sections whatever level the user chose, so the level only
decides what is shown and an approval's request for more detail has more to show. `Confianza` is
a claim the actor makes about its own result, not a probability MDD measured.

The rendered frame is Spanish because it is read by the user. The prose inside it is written by
the phase actor in English and translated by the coordinator, which keeps the sections intact.
That applies to the closure report the coordinator presents and to the PR body alike; the body
differs only in that its translation is checked against the recorded text before it is rendered,
because nobody reading a pull request is in a position to notice a paragraph that drifted.

Reports evolve with evidence rather than phase counts. Coverage is internal bookkeeping that
decides whether a run may close as complete; it is reported by `mdd_status` but no longer
rendered in any report. **Implemented:** coverage is 20 points for accepted native requirements/profile intake, 20 for validated planning deliverables, 25 for reported implementation changes, and 35 for reported Verify checks that passed. The flags describe what each phase reported; MDD records the claim as a claim and never re-runs a command, so coverage is not correctness probability. A recorded failure loses its points; an attempt that never completed loses nothing because it claimed nothing. A no-change Apply earns no implementation points. No confidence is fabricated in the kernel.

### Configuration, telemetry, and contextual skills

- The terminal editor configures nine model roles, named profiles, partial answers, and Engram setup. Native startup applies only explicit model overrides and preserves all unrelated config. A model-only profile is not complete preflight.
- A finished run appends one compact row to a bounded local run ledger, and `mdd retro` reads that ledger together with the accumulated counters and the unreviewed improvements to report signals as counts, never as diagnosed causes. Everything MDD persists locally is anchored at the repository, so a linked worktree's records outlive the worktree instead of being deleted with it.
- Approved local metadata-only telemetry defaults on, retains 30 days, supports off/delete, and never exports. Native lifecycle event wiring is implemented with bounded failure diagnostics. Events additionally carry run identity, attempt, delegate/inline mode, an adapter-assigned failure class and provider-reported usage for the delegated child, all still metadata; fixed-key counters outlive retention in a local rollup, and `telemetry report` reads both with plain arithmetic. Measurement never gates execution, and an undercount is marked rather than presented as a measurement.
- Project-local cleanup and PR-body skills are wired. Apply is offered the packaged cleanup skill's direct path rather than its text; the coordinator drafts requested PR bodies from recorded facts using the local skill/template. Both retain provenance and grant no additional execution rights. Apply comments stay minimal.
- The PR-body skill uses **Resumen / Cambios / Verificación / Variables de entorno / Seguimiento / Bloqueos / Despliegue**, in Spanish, with one `Cambios` table row per changed file stating why that file changed. `Resumen` states what the change delivers and what it enables, never how it was built; `Verificación` holds the state, Verify's account and the aggregated check counts including the commands that exited nonzero. Recorded prose is translated by the coordinator and machine-checked against the source before rendering. Drafting grants no publication authority. No PR or commit is part of this unit.

Confirmed reruns/material changes, contextual exploration and a minimal per-parent startup
guard, global initialization, read-only diagnostics and PR-body drafting are implemented. Existing
policies above are approved; they do not need to be asked again. Additional provider adapters
and robust recovery are separate future work. Final model-backed end-to-end authorization,
output-quality validation and user-owned review remain unverified; contract tests do not replace them.
