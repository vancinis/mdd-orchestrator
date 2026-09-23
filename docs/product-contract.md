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
are not disabled. Scoring weights and high >= 50 remain as previously approved. The possible
mismatch between summary-style weight and these priorities is future tuning, not a blocker.

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

The five questions preserve their original order, option meanings, and now-approved default scores. Field names and case-sensitive tokens below are the executable interface.

| # | Question / field | Options in order: label → token (default points) |
|---|---|---|
| 1 | Requirements certainty / `certainty` | Very sure → `very-sure` (**10**); Somewhat sure → `somewhat-sure` (**15**); Not sure → `not-sure` (**25**) |
| 2 | Workflow artifact storage / `artifactStore` | Engram → `engram`; OpenSpec → `openspec`; Engram + OpenSpec → `both`; None → `none` — **unscored** |
| 3 | Phase advancement / `mode` | Interactive (ask each phase) → `interactive` (**15**); Automatic (advance) → `automatic` (**5**) |
| 4 | Phase summary level / `summary` | Detailed → `detailed` (**25**); Medium → `medium` (**10**); Low → `low` (**5**) |
| 5 | Work complexity / `complexity` | Very complex → `very-complex` (**25**); Somewhat complex → `somewhat-complex` (**10**); Not complex → `not-complex` (**0**) |

All five answers are required. There are no invented answer defaults. `mode` controls lifecycle advancement. All native phases use selected artifact storage, and reports reflect grounded current-phase evidence.

The raw score is the sum of the four scored answers. Its default range is **20–90 points**, not a normalized value, probability, or confidence percentage. Changing weights may change the range. Artifact storage never contributes points.

**Known tradeoff retained by approval:** summary and interaction mode together contribute 10–40 points, versus complexity's 0–25. The proof does not silently rebalance the user's formula.

## 2. Approved routing policy

The applied rule version is **`mdd-routing-v1`**. High means **raw score ≥ threshold**, with default threshold **50**. Otherwise the route is low. The version identifies the algorithm and default policy; configurable weights and threshold do not change this identifier.

Phase identities use the `mdd-*` form everywhere in output:

| Route | Exact ordered phases |
|---|---|
| Low, without exploration | `mdd-plan`, `mdd-apply`, `mdd-verify` |
| Low, with exploration | `mdd-explore`, `mdd-plan`, `mdd-apply`, `mdd-verify` |
| High | `mdd-explore`, `mdd-propose`, `mdd-spec`, `mdd-design`, `mdd-tasks`, `mdd-apply`, `mdd-verify` |

Low-route exploration is required when **certainty is not `very-sure` OR complexity is not `not-complex`**. Otherwise it may be explicitly requested using `explore: true` in the kernel or `--explore` in the CLI. `false` or omission never suppresses required exploration. High includes exactly one explore, even when exploration is explicitly requested. No extra complexity heuristic or model inference is used.

## 3. Kernel API and validation

After `npm run build`, import `evaluate` from `dist/kernel.js`. It accepts an unknown value and validates its entire request before evaluation:

```javascript
import { evaluate } from './dist/kernel.js';

const answers = {
  certainty: 'very-sure',
  artifactStore: 'none',
  mode: 'automatic',
  summary: 'low',
  complexity: 'not-complex',
};

const direct = evaluate({ answers });
const saved = evaluate({ profile: { answers } });
// direct and saved contain identical results.
```

| Request field | Contract |
|---|---|
| `answers` | Complete five-field answer object. Mutually exclusive with `profile`. |
| `profile` | Exactly `{ answers: <complete five-field object> }`. Uses the same answer validator and evaluator. |
| `config` | Optional object containing `threshold` and/or `weights`. Omission or `{}` uses defaults. |
| `explore` | Optional boolean, default `false`. Requests additional low-route exploration, never disables required exploration. |

Complete kernel profiles bypass prompting. Partial kernel profiles fail; the proof never fills or prompts for missing answers. Separate project settings support named profiles, models, and partial answers through the terminal editor; see [configuration](configuration.md). Native model overrides and protected grouped question consent are integrated. Supply optional kernel `config` and `explore` alongside either input source; identical inputs produce identical results.

### Configuration

Configuration supports partial overrides at the field and option levels. Omitted entries retain approved defaults; **present invalid entries are rejected**, never silently replaced. This example changes one weight and produces exactly 50 points with `examples/answers.json`:

```json
{
  "threshold": 50,
  "weights": {
    "certainty": { "very-sure": 40 }
  }
}
```

`weights` permits only `certainty`, `mode`, `summary`, and `complexity`, each keyed by that field's tokens in section 1. Empty override objects are valid no-ops. `artifactStore` weights are invalid.

**Numeric constraints:** all weights and the threshold must be numbers that are nonnegative safe integers, from `0` through `Number.MAX_SAFE_INTEGER` (`9007199254740991`). Fractions, numeric strings, negative numbers, NaN, and infinities fail. The sum of the maximum weight in each scored field must also remain within that safe range, even when the selected answers would produce a smaller score. This keeps every possible configured sum exact. A threshold outside the configured score range is allowed: it intentionally makes every answer set high or low. Zero is valid and is not replaced with a default.

Unknown fields/options, missing required answers, nulls, arrays, non-plain objects, and incorrectly typed optional fields fail with `ValidationError`. Explicit `undefined` is invalid for optional fields; omission is different. Exactly one input source is required. Callers receive fresh defaults from `getDefaultConfig()` in `dist/policy.js`; mutating returned defaults or evaluation results does not affect future calls. Evaluation does not mutate its inputs.

### Deterministic result

| Field | Meaning |
|---|---|
| `policyVersion` | Applied rule identifier, currently `mdd-routing-v1`. |
| `score` | Raw configured points sum. |
| `threshold` | Effective high-route threshold. |
| `route` | `low` or `high`. |
| `phases` | Exact ordered `mdd-*` phase identities. |
| `contributions` | Four entries in question order, excluding artifact storage: field, selected answer, and configured points. |
| `reasons` | Fixed-order explanations of the comparison, unscored storage, and exploration decision. |

The kernel does not emit timestamps, random identifiers, model inference, confidence, or persistence metadata. Identical validated inputs produce structurally identical output; equivalent CLI sources also produce byte-identical JSON. The version is not a configuration fingerprint, and the output is not a persisted lifecycle receipt.

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

Controller results are **caller-supplied claims, not independent verification**. The OpenCode adapter separately checks native child invocation/result/history evidence and Engram readbacks before recording results. Explicit native-confirmed changes create a new planned run in the same conversation, retaining old evidence. Contextual exploration uses a separate execution slot without advancing the main controller. Automatic crash recovery remains unsupported: a run is never resumed after process loss, because MDD cannot know what an interrupted implementation phase wrote to the working tree. What it now offers instead is evidence preservation with an explicit restart — the plan, acceptance map, artifacts and reported evidence of a lost run survive locally and are reported as read-only data, so new work begins holding them while still earning its own preflight and its own approvals.

## 4. Runnable proof and verification boundaries

The [README](../README.md) provides working PowerShell commands and exit codes. `examples/answers.json` and `examples/profile.json` are equivalent complete sources. `examples/config.json` demonstrates the equality boundary. The CLI reads UTF-8 JSON files, accepts a leading BOM, validates input, and prints a decision. It never executes the returned phases or creates artifact folders.

The stack is TypeScript compiled to Node.js ESM with native Node tests. Node 24.6+ within 24.x remains the declared proof runtime. The adapter adds the pinned local runtime package `@opencode-ai/plugin@1.18.31`; its SDK and schema dependencies do not enter the pure kernel.

The focused suite covers default contributions and extrema, every scored-answer combination, unscored stores, threshold boundaries, override validation, exploration, safe arithmetic, and CLI subprocess behavior. Lifecycle tests cover exact phase order, live preflight reuse, mutation isolation, phase-scoped approvals, failure blocking, and invalid operations. These tests are **kernel, lifecycle, and CLI verification, not full harness integration or independent review**. The runnable `examples/workflow-demo.mjs` uses simulated results and approvals only.

## 5. Finished harness direction — confirmed, deferred

MDD means **my-driven-development**. The finished product is OpenCode-first; eventual Claude Code, Pi, and Codex support are goals. One orchestrator coordinates phase-specific `mdd-*` subagents. The low path prioritizes fast, clear execution; the high path prioritizes quality. Non-linear contextual exploration and revisiting issues are allowed in the future harness; transition mechanics remain open.

### Grouped preflight and lifecycle

Native intake now uses one grouped preflight after verified native requirements and before
routing; a complete frozen profile bypasses it. Missing fields alone are asked in original
order, with no guessing. Native before/after question metadata authorizes first execution;
subsequent interactive Proceed/Stop receipts authorize only the waiting phase. Automatic mode
does not ask phase approval questions. Complete native contract tests cover low/high routes,
all artifact stores and exact approval slots through Apply/Verify. Answers are reused. Explicit
reruns and material changes use the same native gate: confirmation, then one fresh grouped
five-field preflight. Rejection preserves the current plan. In-flight/uncertain work cannot
be reset. Ordinary implementation choices and automatic progression add no change questions.

Stable explicit inputs and versioned routing are implemented here. Any future automated complexity classifier must not be confused with deterministic scoring; classifier evidence/reconciliation and non-linear transitions still need design. Deterministic routing does not imply deterministic model output or statistical certainty.

### Engram and workflow artifact storage

**Engram installation and use are optional.** Absent `engram` settings mean memory is off, not a setup failure or degraded run. Native identity, approvals, scope, acceptance, commands and local progress guards remain enforced. With memory off, preflight offers OpenSpec then None. An incompatible saved Engram/Both choice is explained and reasked alongside other missing fields without changing the stored profile. With an opted-in backend all four choices remain available. Enabled memory persists compact intent/result receipts independently of artifact selection; `none` retains full artifacts only in the live run. An unavailable opted-in backend blocks rather than silently disabling memory.

OpenSpec is used only when requested; no automatic folders are authorized. The user approved building this iteration directly without SDD phases or artifacts. Future high-route phase names do not authorize an SDD development process for this project.

### Phase reporting

| Level | Implemented report fields |
|---|---|
| Detailed | `Resumen` (understood request/current phase outcome), `Cómo`, `Estado`, `Cobertura` percentage |
| Medium | `Resumen`, `Cómo` |
| Low | Completed-work summary only |

The rendered frame is Spanish because it is read by the user. The prose inside it is written by
the phase actor in English and translated by the coordinator, which keeps the sections intact.
That applies to the closure report the coordinator presents and to the PR body alike; the body
differs only in that its translation is checked against the recorded text before it is rendered,
because nobody reading a pull request is in a position to notice a paragraph that drifted.

Reports evolve with evidence rather than phase counts. **Implemented:** coverage is 20 points for accepted native requirements/profile intake, 20 for validated planning deliverables, 25 for reported implementation changes, and 35 for reported Verify checks that passed. The flags describe what each phase reported; MDD records the claim as a claim and never re-runs a command, so coverage is not correctness probability. A recorded failure loses its points; an attempt that never completed loses nothing because it claimed nothing. A no-change Apply earns no implementation points. No confidence is fabricated in the kernel.

### Configuration, telemetry, and contextual skills

- The terminal editor configures nine model roles, named profiles, partial answers, and Engram setup. Native startup applies only explicit model overrides and preserves all unrelated config. A model-only profile is not complete preflight.
- A finished run appends one compact row to a bounded local run ledger, and `mdd retro` reads that ledger together with the accumulated counters and the unreviewed improvements to report signals as counts, never as diagnosed causes. Everything MDD persists locally is anchored at the repository, so a linked worktree's records outlive the worktree instead of being deleted with it.
- Approved local metadata-only telemetry defaults on, retains 30 days, supports off/delete, and never exports. Native lifecycle event wiring is implemented with bounded failure diagnostics. Events additionally carry run identity, attempt, delegate/inline mode, an adapter-assigned failure class and provider-reported usage for the delegated child, all still metadata; fixed-key counters outlive retention in a local rollup, and `telemetry report` reads both with plain arithmetic. Measurement never gates execution, and an undercount is marked rather than presented as a measurement.
- Project-local cleanup and PR-body skills are wired. Apply receives exact local cleanup instructions; the coordinator drafts requested PR bodies from recorded facts using the local skill/template. Both retain provenance and grant no additional execution rights. Apply comments stay minimal.
- The PR-body skill uses **Resumen / Cambios / Verificación / Variables de entorno / Seguimiento / Bloqueos / Despliegue**, in Spanish, with one `Cambios` table row per changed file stating why that file changed. `Resumen` states what the change delivers and what it enables, never how it was built; `Verificación` holds the state, Verify's account and the aggregated check counts including the commands that exited nonzero. Recorded prose is translated by the coordinator and machine-checked against the source before rendering. Drafting grants no publication authority. No PR or commit is part of this unit.

Confirmed reruns/material changes, contextual exploration and a minimal per-parent startup
guard, global initialization, read-only diagnostics and PR-body drafting are implemented. Existing
policies above are approved; they do not need to be asked again. Additional provider adapters
and robust recovery are separate future work. Final model-backed end-to-end authorization,
output-quality validation and user-owned review remain unverified; contract tests do not replace them.
