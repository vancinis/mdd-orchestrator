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

Verify blocks only on what the change causes. A held check that fails for a reason outside the
change, corroborated by a narrower rerun or a baseline run, is reported `environmental`; a scenario
declared `evidence: "external"` while planning is reported `external`, with what to check and
where. Neither is a gap, both stay visible as pending, and neither can be claimed after the fact
for something that was not declared or corroborated. Decision links between a plan and its
decisions are derived rather than refused.

In automatic mode a failed Verify of the implementation is corrected without asking, within a
bound: one Apply pass for every finding, then a Verify that rechecks only those findings (earlier
rows are kept and re-bound to its executions, a lost check becomes a regression), and a second
pass only after progress. A design or requirements cause, interactive mode or a spent bound stops
for one decision by the user. The bound is the `verify.automaticCorrections` setting (0–2).

Structural completeness does **not** prove that the agent interpreted every user requirement
correctly, that its semantic assessments are true, or that the checks are sufficient. The
agent must explain source evidence and limits; native execution provenance is independently
checked by code. The default closure describes the requested outcome, changes, requirement
and plan match, actual checks and material limits. Internal IDs and receipts stay in drilldown.

This is original MDD code/instructions using traceability patterns, not imported Gentle AI
SDD/RDD runtime, commands, dependencies or copied gate text.

New native preflight asks only missing certainty, mode and summary, in that order, plus relevant
doubts and the optional note. Storage is automatically resolved, not a user question. The complete
four-field resolved-answer schema below remains compatible with standalone/kernel callers and
old saved runs. Legacy `complexity` is accepted but ignored; risk judges complexity after exploration.

| # | Question / field | Options in order: label → token | What uses it |
|---|---|---|---|
| 1 | Requirements certainty / `certainty` | Very sure → `very-sure`; Somewhat sure → `somewhat-sure`; Not sure → `not-sure` | `mdd-risk` receives it as the user's own statement of how clear the requirements are and weighs it beside the exploration findings; it never selects a route by itself |
| Resolved only | Workflow artifact storage / `artifactStore` | New native: `engram` or `local`. Legacy: `engram`, `openspec`, `both`, `none`, `local` | Frozen backend for artifacts/progress; never a new preflight question |
| 3 | Phase advancement / `mode` | Interactive (ask each phase) → `interactive`; Automatic (advance) → `automatic` | Whether each later phase waits for an approval |
| 4 | Phase summary level / `summary` | Detailed → `detailed`; Medium → `medium`; Low → `low` | Which report sections are shown |

All four resolved values remain required by standalone APIs. Native intake resolves storage from
settings and reuses accepted mode/summary before profile defaults; any missing user field is asked,
never invented. Reports reflect grounded current-phase evidence. No answer is scored.

## 2. Approved routing policy

The applied rule version is **`mdd-routing-v2`**. Version 1 scored the preflight answers against a threshold; version 2 scores nothing. Every run starts with exactly one `mdd-explore`, followed by the `mdd-risk` stop, and a validated `mdd-risk` verdict — or the user forcing the other route at its first approval, or choosing one manually after a blocked assessment — selects the continuation. Until then the run has no route, and status shows it as pending.

Phase identities use the `mdd-*` form everywhere in output:

| Route | Exact ordered phases |
|---|---|
| Low | `mdd-explore`, `mdd-plan`, `mdd-apply`, `mdd-verify` |
| High | `mdd-explore`, `mdd-propose`, `mdd-spec`, `mdd-design`, `mdd-tasks`, `mdd-apply`, `mdd-verify` |

A run recorded before the risk stop existed keeps the route it recorded, including the older low route without exploration (`mdd-plan`, `mdd-apply`, `mdd-verify`). `explore` is still accepted on input for those saved requests but no longer changes the first phase.

### Routing-contract pins and native-only version 3

| Request discriminator | Interpretation |
|---|---|
| `routingVersion` omitted | Retains historical fixed semantics permanently. Modern histories replay their low/high Risk events; older unmarked histories may infer the single known legacy route that fits. No version is stamped. |
| `routingVersion: 2` | Explicit fixed contract with the same default evaluation and low/high tails. Recording preserves the pin; replay cannot fall back to legacy route inference. An explicitly recorded known legacy route still retains that route. |
| `routingVersion: 3` | Active native-only adaptive contract through coordinator-only `mdd_adapt({payload:string})`. Fixed evaluation, construction and replay refuse with `native-context-required`, never a fabricated fixed phase list or score. |
| Any other supplied value | Rejected, including null, strings and explicit undefined. |

Resume checkpoint versions 2 and 3 integrity-bind an explicitly supplied routing discriminator.
Removing, inserting or altering it without a valid new seal is rejected. Unmarked checkpoints
retain the exact historical digest. Checkpoint version 1 has no seal and cannot carry a pin.
Restart and both transfer projections preserve the pin; none grants new execution authority.

The pure `parseFutureAssessment` reader in `dist/risk.js` accepts only
`{ assessmentVersion: 1, complexity, impact }`, with each level independently `low`, `medium`
or `high`. High impact with low complexity is valid in this separate future assessment; it is
not a current Risk verdict and selects no route. Current `parseRiskVerdict` still requires
equal low/high `route` and `complexity`. Native version 3 derives actual low/medium/high depth
without renaming historical routes. Summary level `medium` remains a separate presentation choice.

### Internal adaptive admission, evidence, recovery, transfer and continuation (AL-02/AL-04c)

The native lane supports `await-selection -> authorized-actor ->
await-result -> await-selection`. The parent selects one necessary Explore, Risk, Plan, Apply
or Verify actor with a purpose and assignment identity; no fixed Workflow or omitted Plan
receipt is fabricated. Selection boundaries carry no phase, workflow, phase report format
or fixed-route visual. Status retains bounded selection metadata and the last actual receipt,
not the full contract body. Public startup uses version 3; fixed version-3 entry requires native context.

| Boundary | Internal guarantee |
|---|---|
| Admission | Intake proves genuine native objective text/message; runner independently rechecks it, exact coordinator/workspace, idle ownership and current local source fingerprints. Public entry binds the actual host assistant caller to its current native user turn and binds the user message whose exact text is the objective: the current turn, or an earlier message of the conversation after one fresh native confirmation in that turn. A payload messageID is optional and, when supplied, must match that message. The legacy internal helper remains automatic-only and still requires the exact identity; the native policy bridge supports configured interactive mode. |
| Compact contract | Version 1, stable globally unique acceptance/decision/assignment/evidence IDs, exclusions, complete exact scopes, dependency-ordered assignments and source or real command obligations are validated and copied before native awaits. Contract-authored links do not claim Plan provenance. |
| Selection | Unresolved product ambiguity pauses all actors. Technical uncertainty permits a brief scoped Explore only. Apply requires low impact independently of complexity, understood bounded dependencies, current fingerprints, completed prerequisites and real scoped-editor capability. |
| Native execution | Exact issued handles are consumed once, with one actor/writer and existing native result/liveness inspection. Apply edits only through the existing single-child WorkerFence and `mdd_worker_edit`; generic editors, shell and out-of-scope writes remain denied. Unsafe bootstrap/config footprints and unsupported hosts have no serial fallback. |
| Settlement | Every confirmed stopped actual actor returns to selection. Failed, malformed or absent receipts earn no progress or automatic retry; another writer requires an explicit repair reference. Reports cannot broaden acceptance/scope or decide product questions. Internal Risk uses the independent future assessment, never a historical Risk verdict. |
| Persistence | Production injects a separate bounded adaptive record/store under the product data root, using existing LocalFiles protections. It is not a fixed checkpoint, dossier or fabricated phase artifact. Pending native intent is durable before provider arguments; an accepted receipt is durable before the settled marker and ownership release. The existing child marker remains `resumable:false` for fixed-checkpoint recovery. |

#### Native policy bridge (AL-05a, publicly activated in AL-05c)

`mdd_adapt` registers the bounded protocol through `NativeIntake.adaptiveInternal`. It wraps
admission, selection/repair, evidence, escalation, stopped-child recovery and
same-workspace transfer/recovery without executing commands or expanding native permissions.

| Boundary | Policy guarantee |
|---|---|
| Preferences | Freeze the actual configured profile answers. Preserve absent certainty, artifact storage and summary preferences as absent. If mode is unset, ask only the existing native mode question; a clear request does not require the four-field fixed preflight. Configured automatic mode invents neither human consent nor redundant per-operation approvals. |
| Interactive operations | The actual before/after native-question hooks inspect the exact running parent/call/envelope and parse its result. Approval binds the run, durable record generation, owner epoch, current handle, actual declared source bytes and complete canonical proposed operation. A private single-use capability connects that inspected result to the guarded runner operation; serialized flags, raw user text and caller IDs cannot replace it. |
| Question journal | Explicit question-record version 2 carries adaptive bindings, never a fabricated fixed phase or checkpoint. CAS transitions and readback precede authority changes. Actual answers remain historical receipts; interrupted prepared, pending or unapplied answered questions stay blocked and never resume as live consent. Existing fixed-question semantics remain version 1. |
| Product decisions | Ask genuine product questions before immutable admission, preserving complete offered choices and their display/answer mapping. A rebuilt draft must retain original objective, acceptance, scope, exclusions and decisions; broader business authorization needs an explicit revised native request. Actual pre-admission answers reach the scoped actor as data. Actor-raised questions retain their actual receipt/call identity and durably pause selection. Native answers add linked context, never silently amend the held business contract or earn completion. Free-text approval, pause, decline and unresolved actor questions authorize no operation. |
| Transfer policy | A target-side policy question also holds a durable source-owner fence. Other intake, actor admission and publication cannot overlap it. Source generation, handle, epoch, declared bytes and both parent boundaries are rechecked through native reply and asynchronous transfer proof. The target occupancy exception accepts only the exact consumed adaptive receipt for that operation and current source binding; pending, unrelated, stale, foreign and fixed questions remain blockers. An actual mode answer selecting automatic is a policy preference, not invented human operation approval; selecting interactive requires its own subsequent operation approval. Receipts are retained, not deleted. |
| Recovery | Frozen preferences and actual question history survive ordinary restore and transfer without restoring approval. Interrupted transfers require a fresh native decision and existing positive native idle/request proof. An unclaimed failed policy proposal can be explicitly aborted only against its own fresh inspected recovery receipt; no target publication or successful work is invented. Unknown outcomes and failed durability remain fenced rather than being retried blindly. |

These are deterministic local native/runtime guarantees, not live-host/model approval, independent
command attestation, or authentication against coordinated rewriting of all stored evidence.
The public registration adds no shell executor, arbitrary actor dispatch or permission expansion.

Transfer and transfer-recovery retain the **current consumed operation proof** across native awaits
and publication boundaries. Its source-byte/generation binding applies equally to automatic runs
with no questions and interactive runs; an old question receipt never supplies or replaces it.
Legacy internal transfers without a policy proof retain their existing selective invalidation.

#### Native JSON protocol (AL-05b, publicly activated in AL-05c)

The internal `NativeIntake.adaptiveInternal(jsonString, hostRuntime)` entry accepts exactly
`{routingVersion:3,kind,args}` as a JSON **string**, at most 160,000 UTF-8 bytes. Host runtime is
injected separately and validated against the actual native coordinator parent and exact workspace.
Agent/session identity, approval booleans, native answers and capability tokens are not request fields.
The registered tool accepts `{payload:string}`. Public `mdd_status` and settled task replies use
the same projection for adaptive parents; explicit fixed runs retain their previous status.
This grants no version-3 execution through the fixed CLI/Workflow. Internal object callers retain compatibility.

| Operation | Required `args` keys | Optional keys |
|---|---|---|
| `entry` | `contract` | `messageID`, `questions` |
| `select` (including explicit repair) | `handle`, `actor`, `assignmentID`, `purpose` | `context`, `repairOf` |
| `prepare` | `handle` | none |
| `submit` | `handle`, `evidence` | none |
| `close` | `handle`, `outcome` | `limits` |
| `escalate` | `handle`, `depth`, `rationale`, `assessment`, `context` | none |
| `recover` | none | none |
| `transfer` | `sourceSessionID`, `runID`, `operationID`, `messageID` | none |
| `transfer-recovery` | `sourceSessionID`, `runID`, `operationID`, `messageID`, `action` | none |
| `questions` (actual actor clarification) | `receiptID`, `callID` | none |
| `status` | none | none |
| `detail` | `cursor` | none |

Operation-specific known keys, required fields, types and bounded data are checked before policy
questions or durable mutation. Held-model validators run on an isolated copy rather than duplicating
business rules. A malformed protocol request cannot revoke a previous match or erase history;
accepted failed evidence remains visible and blocks verified closure as before. No preference is
inferred: unset mode still asks only the existing native mode question. Interactive authorization and
product answers still pass through the actual `beforeQuestion`/`afterQuestion` hooks, never this JSON API.
The contract and the evidence have no byte ceiling of their own; the 160,000-byte request bound
applies to both. Every evidence field, including an empty `checks` array, must be supplied.

Public projection uses `routingVersion:3`, `registration:"active"`, actual `low`/`medium`/`high` continuation
depth, frozen mode when known, current handle/generation, permitted-operation descriptors, evidence
gaps and assurance limits. Every operation has an `inputRef` for complete nested required/optional
keys, types, held readback, linked IDs and command history. `next` names a public operation/input
contract or an exact native question/task (V2 `subagent`). Historical
fixed `route:"low"` remains low; summary level `medium` and historical Risk equality are unchanged.

At a structured Verify boundary with unmatched parent evidence, ordinary Verify remains unavailable.
A separate `select` descriptor with `variant:"repair"` exposes only completed Apply repairs accepted
by the existing model's selection guards on isolated copies. Each published assignment/`repairOf`
pair names its latest actual Apply receipt; healthy unrelated retained writers are not reopened.
This wire variant additionally requires explicit current `context`. Its guarded `contextRef` carries
current declared fingerprints and held technical/dependency facts; the coordinator supplies the
reason for actual reinspection. Missing/forged receipt or missing/stale context is refused before
authority mutation. Repair still requires refreshed parent snapshot/checks/readback and a new real
structured Verify before verified closure; neither the descriptor nor an older Verify authorizes it.

Native protocol results stay within the existing 46,000-byte status budget. `details` references
provide canonical validated journal, effective held contract/continuation, prepared snapshot and
policy readback. Large questions, tasks or operation descriptors use explicit references rather than
truncating labels, choices, handlers or selectors. A `detail` result contains JSON-text `text` and,
when necessary, `nextCursor`: concatenate all pages before `JSON.parse`, then pass the complete exact
question/task object to its native tool. Pages contain at most 6,000 UTF-16 code units, including when
a page boundary splits a Unicode surrogate pair; reassembly preserves the original JSON text.

Cursors are held-document IDs with validated page offsets, scoped to the native parent, exact
workspace, current record/ownership generation, question lifecycle, snapshot and actual declared
source bytes. These bindings are rechecked after native awaits. Pending transfer readback also
validates the exact durable source-policy fence; stale, foreign or altered cursors fail without
consuming consent or mutating the journal. Ordinary readback reports stale proof honestly without
silently reconciling it. Unloaded sources have declared-byte proof, not reconstructed selection
capabilities. Exact partially published transfer data can expose only its guarded recovery contract,
not a task or selection handle; fresh native finish/abort proof remains mandatory.
If an abort retires the target claim and rotates the source before owner settlement, only the exact
reserved adaptive abort may propose a fresh native question. The reservation, endpoints, run,
source generation, owner/fence epochs and consumed actual abort receipt must all agree. A retired
claim is not empty occupancy; an older transfer/recovery receipt cannot bypass a different current
reservation. Recognizing this proposal neither consumes approval nor releases the reserved owner.

The proof CLI accepts `--routing-version 2|3` beside either existing input flag. Omission and explicit
2 produce the same fixed `mdd-routing-v2` output. Explicit 3 exits with the native-context-required
diagnostic and no result. Neither CLI evaluation nor fixed Workflow can execute adaptive version 3.
Local deterministic native/runtime tests are not live host/model execution or independent command
attestation. Public registration, SDK wiring and packaged agent changes remain AL-05c work.

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
| Preparation | Locally inspect the complete declared read/write footprint before checks. Exact-file alias checks, credential exclusions and fingerprints apply; no per-file or total byte budget does. The snapshot names each file by path, SHA-256 digest and byte size and keeps no file text: the files stay on disk, the digest proves they did not change, and the coordinator and actors read them with their own tools. Snapshots recorded earlier with file text still restore. Completed assignment inputs/outputs must still match. Ordinary status retains only compact metadata. |
| Parent readback | Repeat exact held acceptance criteria, scope, exclusions and decisions. Supply final diff inventory with assignment/unrelated dispositions and reasons, one finding per exclusion, every source obligation with its exact paths, and every scenario-assignment, assignment and decision assessment. Apply summaries do not supply this readback. Locally changed declared bytes cannot be omitted; whole-worktree inventory remains a reported observation, not comprehensive diff attestation. |
| Commands | Reuse structured chronological execution and held-check accounting. Required applicable failed, interrupted or blocked checks prevent verified closure; missing dispositions are rejected. Optional failures remain visible. Unconditional checks cannot be waived, command mismatches require an explicit supported replacement, and retries retain complete attempts and reasons. Supplemental entries cannot hide a held command retry. Re-preparing unchanged source cannot erase execution history; a malformed disposition does not erase an otherwise readable reported attempt. |
| Source-only proof | Separate obligation readback and linked source assessments can support verified semantic rows without invented command IDs. Command-backed rows cite actual reported successful final execution IDs. All held source and semantic links must be covered exactly; exit codes alone do not prove acceptance. |
| Freshness and assurance | Submission and verified closure independently recheck the prepared local fingerprints and completed prerequisites. This is structured parent-reported consistency, **not independent execution or applicability attestation**. Any malformed resubmission removes the current match until corrected. |
| Closure | All effective assignments must have actual accepted Apply completion and all required evidence/semantic links must match. Un-escalated low requires neither Plan nor Verify; structured continuation additionally requires its actual planning sequence and current structured Verify. `completed` records snapshot-bound reported verification; `closed-unverified` requires explicit remaining limits and never earns verified completion. Terminal status grants no new work or review authority. |
| Explicit repair | A completed writer can be selected again only for failed or stale evidence, referencing its latest actual Apply receipt. Reinspect only its existing footprint, invalidate overlap/dependency-sensitive completion and proof, and retain unrelated completed fingerprints and prior evidence. Old command proof is invalidated conservatively; checks must follow a fresh final snapshot. There are at most four completed-assignment repairs, with no automatic retry or new scope; the number of actor receipts in a run is not capped. Overlapping prerequisites must be explicitly repaired first. |

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
Public version-3 registration exposes these same guarded operations through mdd_adapt.
Terminal replacement preserves immutable archives and consumed user identities under parent/run locks;
only exact closed current ownership can retire, and uncertain publication requires exact cold reconciliation.

#### Internal native-proven transfer

The intake/runner transfer exposed through mdd_adapt moves adaptive **data**, not fixed checkpoints or a phase
history. It requires the same exact workspace/worktree; there is no cross-worktree execution.
Both native parents are inspected before claims. The latest target-authored
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

#### Internal executable structured continuation

The coordinator may freeze **medium: Plan → remaining scoped Apply → Verify**, or **high:
Propose → Spec → Design → Tasks → remaining scoped Apply → Verify**. Each stage still requires
an explicit parent selection and a fresh native dispatch handle. Nothing dispatches automatically.
Closed runs cannot reopen, and ordinary low selection retains its five-actor allowlist.

| Boundary | Guarantee |
|---|---|
| Freeze | The internal escalation operation serializes with selection/evidence, proves the exact native parent/workspace, checks idle ownership and its epoch after inspection, and validates current source and retained completion. Positive impact or complexity, explicit parent rationale and understood bounded context are required. Unknown context alone is neither high classification nor expanded authorization. |
| Immutable authority | Depth, actual reports, remaining-work revision, retained source proof and semantic bindings live outside the original admission contract. Its digest and diff baseline never change. Acceptance, exclusions, business decisions, assignment IDs, scenario/decision links, exact footprints and source obligations remain held. Scope or business expansion requires a native user decision, never an approval flag. |
| Real planning | Actors receive their actual structured phase format and real predecessor reports. Plan/Spec must preserve held acceptance; Plan/Design must preserve held decisions. Plan/Tasks report only unfinished held IDs, preserving source bindings, dependencies and checks while refining technical descriptions or adding dependencies/checks. The combined real retained-plus-remaining plan must cover every scenario and applicable decision. An empty remaining plan is valid only when all work is retained. |
| Effective execution | Validated remaining deliverables replace the remaining assignment view, rather than merely summarize it. Readiness, scoped editing, transitive dispatch prerequisites, evidence coverage and closure all use that view. Retained valid writers cannot repeat or overlap remaining outputs. Changed proof requires explicit reinspection and bounded repair, never silent PASS or automatic redo. |
| Verify and closure | Structured Verify is mandatory and checks every effective assignment, scenario and decision using the existing structured verification contract. Its reported executions must exactly match actual parent-reported check history; scoped children still cannot execute commands. Parent final snapshot/readback/check accounting remain separately necessary. A changed snapshot or command history requires another actual Verify. Source-only low closure remains unchanged; structured verified rows require real successful command references, not invented checks. |
| Recovery and transfer | Reports are journal data, not external fixed-phase artifact identities. Restoration revalidates actual chronological receipt links, stage-specific fields, full held semantics and effective work before exposing fresh handles. Pending Plan/high/Verify actors remain quarantined until exact native stopped proof, then receive an interrupted failure, never a fake Apply. Existing CAS/readback, former-owner fences and exact-hop transfer lineage apply unchanged. |

This internal controller is not a second Workflow, graph scheduler, public tool, command executor,
permission expansion, Security/Judgment Day entry point or live-model assurance claim. A receipt's
artifact and a continuation report have no size limit of their own, and neither has the next
actor's prompt: it travels only as a single-use handle, so every predecessor report reaches the
next actor whole, and Verify receives snapshot files by path, digest and size instead of their
text. A report that would take the lane's durable record past its 8 MiB bound
is recorded as a failed receipt, not written partially.

Each successful structured native receipt separately retains the accepted parsed report payload.
Verify also freezes its snapshot identity and exact parent command history before native arguments
are exposed, rechecks that context at acceptance, and retains it in the accepted receipt. Restore
requires continuation projections to equal those receipt payloads and contexts, with parent snapshot
and execution-history links preserved. Recomputing a journal checksum cannot make a projection-only
Plan rewrite or moved Verify snapshot agree with the unchanged native receipt. Historical ordinary
low receipts remain compatible; structured receipts lacking the accepted payload fail closed.
These are relational consistency checks, not cryptographic authentication against an attacker who
rewrites every receipt and evidence source, nor independent command-execution attestation.

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
| `routingVersion` | Optional integer `2` pins the fixed contract; omission keeps historical semantics. Native-only `3` is refused with native-context-required here. Output remains `mdd-routing-v2`. |

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
all artifact stores and exact approval slots through Apply/Verify. Applied mode/summary are
reusable same-parent, exact-worktree-bound preferences, persisted locally across process restart.
Current accepted choices win over session preferences, which win over the frozen startup profile;
missing fields require a question. Preferences never replay approval authority or write global
settings, and another parent (including a transfer target) inherits no source defaults.
Explicit reruns ask all three user fields after confirmation, never storage. Material changes require
the same fresh scope confirmation but retain applied preferences, refresh objective certainty (configured
profile certainty may supply it), and discard old context/doubts rather than repeating preferences.
Same-objective continuation, phase reset, rework and context edits retain certainty. Rejection or
cancellation preserves defaults and the current plan; stale/unapplied answers cannot publish them.
Failed preference publication/readback cannot be reported as durable. In-flight/uncertain work cannot
be reset. Ordinary implementation choices and automatic progression add no change questions.

Stable explicit inputs and versioned routing are implemented here. Any future automated complexity classifier must not be confused with deterministic scoring; classifier evidence/reconciliation and non-linear transitions still need design. Deterministic routing does not imply deterministic model output or statistical certainty.

### Engram and workflow artifact storage

**Engram installation and use are optional.** New native runs automatically select Engram only
after configured project/session binding succeeds; absent/disabled integration selects complete local
TaskStore persistence at `.mdd/tasks/<safe-objective-slug>-<run-UUID>/` under the repository anchor.
Configured failures block while remaining enabled, never silently select local or claim a save succeeded.
Ambient MCP tools activate nothing. Legacy profile storage choices are parseable/deprecated but cannot
override new-run resolution. Backend and local location appear in `mdd_status.storage`; doctor explains
resolution without activation. Existing runs restore/transfer their pinned backend without migration.
Pending historical question vectors remain frozen and recovery-blocked until explicit recovery/discard;
their old labels and unapplied answers are never shifted into the new question schema or replayed as consent.

OpenSpec remains a legacy reader/backend, not a routine choice for new native runs. Automatic local
task directories preserve evidence only; they authorize no implementation, SDD process or native approval.

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
