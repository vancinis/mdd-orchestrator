# Configure MDD once globally

Global settings, named profiles, the terminal editor, preflight question construction,
evidence reports, and local telemetry are available as foundations. **The native adapter
consumes model overrides, profile answers, and Engram setup at startup. Missing answers use
one protected native question interaction. Complete main routes, evidence reports and local
runtime telemetry are integrated; model-backed end-to-end proof remains pending.**
No command here starts models, registers sessions, or writes general Engram memory.
Validated artifact storage and phase assets are documented in [Artifact storage and phase actors](artifacts-and-actors.md).
Selected artifact storage is integrated into every main-route phase.

## Quick path

Start with `npm run setup` in the source checkout (no prior build required). The single setup
wizard is the normal installation path; these advanced controls are optional:

```powershell
npm run mdd -- config
npm run mdd -- profile list
npm run mdd -- profile create work
npm run mdd -- profile use default
npm run mdd -- workers status
npm run mdd -- workers off
npm run mdd -- workers on
npm run mdd -- telemetry status
npm run mdd -- telemetry report
npm run mdd -- telemetry off
npm run mdd -- telemetry clear
```

After installation, run `node "<OpenCode root>/mdd/node_modules/my-driven-development/dist/cli.js" config`
from any directory. Projects need no MDD package, dependencies or configuration file.
The editor is a Spanish terminal UI. Its header shows the settings path, the active profile,
how many models and preflight answers are set, and the memory/telemetry/worker state. Every list is
navigated with the arrow keys plus Enter, or by pressing the option number directly; the
marked `❯` option is the current value, so Enter keeps it. Terminals without raw-mode support
fall back to the same numbered list read as one line, which also accepts an option name.
The top-level entries are **Perfiles**, **Modelos**, **Respuestas de preflight**,
**Memoria (Engram)**, **Telemetría**, **Guardar y salir**, **Cancelar** and **Workers**.
The English **Workers** entry is appended to preserve existing option numbers. Its toggle
changes only the draft until **Guardar y salir** (Save); cancel or EOF discards it.

Option labels are display-only Spanish; the preflight answer tokens stored in
`mdd.config.json` and exchanged with the native question tool are unchanged. When the
installed OpenCode catalog is reachable, **Modelos** walks each configurable role through
**proveedor → modelo → esfuerzo**: pick a provider, pick one of its models, then optionally
pick a reasoning-effort variant declared for that exact model (`Por defecto del modelo` keeps
none). Effort is always optional and per-model; models without declared variants skip that
step. A chosen effort is stored as a `provider/model#variant` selector. If the catalog (or one
provider's variant list) is unavailable, models fall back to free text, where Enter keeps the
value and `-` clears it; the same `#variant` suffix can still be typed by hand. The Engram
endpoint is always free text. Preflight answers include an explicit **Sin responder** entry.
Use `mdd setup` for automatic binary detection and managed local memory. `:cancel`, Esc, EOF,
or Ctrl+C discards the entire draft. No writes occur before Save.
Non-TTY input fails immediately instead of waiting. Profile `create` creates an empty
profile and makes it active; it never copies another profile's answers.

Proof exit codes are unchanged. `--profile` still takes the narrow `{ "answers": { ... } }`
file; it is not a named-profile selector. `--config` was removed with the scoring it configured
and is refused with an explanation. `--help` remains standalone.

## Version-1 settings

The only automatic runtime location is `$XDG_CONFIG_HOME/opencode/mdd/mdd.config.json`,
or `~/.config/opencode/mdd/mdd.config.json` when XDG is unset. `OPENCODE_CONFIG_DIR` is
an extra native configuration directory, not MDD's standard installation destination.
Legacy workspace settings are ignored and preserved. See [migration](setup.md#legacy-project-migration).
See the [JSON schema](mdd-config.schema.json). Runtime validation additionally enforces
active-profile existence, safe names, explicit valid ports, and a 128 KiB file limit.

```json
{
  "version": 1,
  "activeProfile": "work",
  "profiles": {
    "work": {
      "models": { "orchestrator": "provider/model", "mdd-apply": "provider/team/model" },
      "answers": {
        "certainty": "very-sure",
        "artifactStore": "none",
        "mode": "interactive",
        "summary": "low",
        "complexity": "not-complex"
      }
    }
  },
  "engram": { "endpoint": "http://127.0.0.1:7437" },
  "telemetry": { "enabled": true },
  "workers": { "enabled": true }
}
```

These model strings and answers are examples, **not automatically chosen defaults**.
An absent file resolves in memory to an empty `default` profile, no answers/models,
no Engram setup, and telemetry/workers enabled. Reading never creates a settings file.

| Setting | Contract |
|---|---|
| `version`, `activeProfile`, `profiles` | Required. Version exactly 1; active name must exist; 1–64 profiles. Unknown keys rejected at every level. |
| Names | 1–64 ASCII letters/digits/underscores/hyphens, starting alphanumeric; prototype/device names rejected. |
| Profile `models` | Optional `orchestrator`, all eight exact phase mappings, `mdd-risk`, `mdd-security`, `mdd-jd-judge-a`, `mdd-jd-judge-b`, and `mdd-jd-fix`. `provider/model`, nested model paths allowed, an optional trailing `#variant` reasoning-effort suffix, at most 256 characters. No whitespace/traversal. Omitted role inherits native selection, not the orchestrator override. |
| Profile `answers` | Optional partial/complete canonical answers for the four preflight fields (`certainty`, `artifactStore`, `mode`, `summary`); a legacy `complexity` value is accepted and ignored. Missing fields remain missing. |
| `engram` | Omitted means memory off. `{ endpoint }` opts into an explicit loopback service; `{ mode: 'local', binary, dataDirectory }` opts into a managed installed binary. Legacy `project` is deprecated and ignored with a runtime notice. No secrets or session IDs in settings. |
| `telemetry` | Optional `{ "enabled": boolean }`, default enabled. No external destination. |
| `workers` | Optional `{ "enabled": boolean }`, default enabled when the whole field is omitted. Global, not per profile. If present, `enabled` is required; strings, numbers, null, arrays, and unknown keys are rejected. |

Capture active profile/model mappings and worker preference **once at runtime startup** with `freezeProfile`.
Restart after changing them; never replace an in-flight workflow's answers. General
Engram memory stays independent of artifacts, including `none`. The adapter verifies the
exact registered runtime session/project/directory; it never fabricates a session.

## Worker preference and safe fallback

Use `mdd-ai workers status` to read `{ "enabled": true }` or `{ "enabled": false }`
without writing settings or workspace files. `mdd-ai workers on` and `mdd-ai workers off`
save the global preference immediately, preserving other validated settings. The same
toggle is available in `mdd-ai config`, where persistence requires Save. Restart OpenCode
after saving: `freezeProfile` exposes a detached, immutable `workers` policy, so an existing
startup snapshot does not change when the settings file changes.

Existing version-1 files without `workers` remain valid and default to enabled in memory;
reads never rewrite legacy files. An explicit save materializes the effective preference.
**Production OpenCode 2.0.22 supports bounded independent exploration and Apply workers.**
The default-on preference permits at most two explicitly declared independent exploration items,
both for `mdd_start.exploration.workItems` (when the route begins with exploration) and
`mdd_contextual_explore.workItems`. It never invents a split or adds an exploration phase.
Each item needs a distinct `id` and `purpose`, `dependsOn: []`, `independent: true`,
`complete: true`, and `reads: [{ root: <local absolute root>, files: <exact relative files> }]`.
Missing, incomplete, dependent, disabled or unsupported declarations retain singular dispatch.
Native progress binds each exact admitted call before action; running transcript metadata is not
authority. The read-only fence permits exact-file reads and literal file grep only. It denies
directories, glob traversal, mutations, shell, execution, controls, recursive agents and custom/MCP
tools. Unknown schemas or paths deny rather than widen the scope. Nested native `AGENTS.md`
discovery must also fit declared files. Native user permissions remain in force.

Apply uses held-plan/task declarations: `dependsOn: []` and
`parallel: { complete: true, reads: [<exact relative files>], writes: [<exact relative files>] }`.
Include tests/docs, implicit reads and shared effects, not just different main files. Eligible Apply
children automatically receive the registered **formatter-free `mdd_worker_edit`** tool; there is
no additional human workflow step. It supports bounded UTF-8 create, exact replace/edit and delete
within declared writes. Generic native editing, patches and all alternate execution routes are denied.
Runtime/config/instruction writes, aliases and unproven effects stay serial. Bootstrap file/env
substitutions, instruction declarations, overlapping local config paths, opaque JSONC and project-local
plugin effects also stay serial; the adapter does not guess their dependency footprint. Unproven host versions
also stay serial; the scoped editor capability is attested only on pinned 2.0.22. A refused operation
reports its blocker and retained work rather than switching editors or replaying a sibling.

The internal capable-host contract caps each phase batch at **two** independent foreground
members. Explicit complete scopes and dependencies are mandatory; disabled, unsupported,
legacy, incomplete, overlapping or dependent work stays serial. Scope selection is not an edit
fence. Scoped workers cannot run shell, installers, formatters, tests/builds, other custom/MCP
tools or recursive subagents; `checks=[]` and checks belong to after-batch singular Verify.
Completed member evidence survives failure/restart; uncertain live siblings block and successful
tasks are never replayed implicitly. Each settled member earns exactly its assigned completed task
and a distinct Apply artifact, published in held-plan order only after all siblings settle. Ordinary
serial Apply selects one held-plan task per fresh child and keeps native editing/checks and consent.
See [worker authority and native proof](opencode-adapter.md#bounded-worker-authority-internal-host-capability).

A separately authorized repository remains a read-only target, not a new child workspace.
Native `external_directory` approval is still required; enabling workers grants neither mutation
nor remote access. Neither a quoted path nor a read scope replaces the user's authorization.

### Standalone Judgment Day model roles

`mdd-ai config` includes three independently configurable actors:

| Role | Packaged contract |
|---|---|
| `mdd-jd-judge-a` | Blind, read-only judge returning neutral JSON findings. |
| `mdd-jd-judge-b` | A second blind judge with identical criteria and output contract. |
| `mdd-jd-fix` | Bounded correction actor requiring explicit authorization and confirmed severe ledger IDs. |

Choose models and optional variants through **Modelos**, Save, then restart OpenCode. Each
omitted mapping retains native selection independently; existing version-1 profiles need no
migration. Setup derives agent installation from the configurable role list and preserves
foreign assets rather than overwriting conflicting content.

These actors are **not workflow phases**. They do not extend the eight-phase route, submit
phase reports, require `mdd_check_report`, or receive phase-instruction policy just because
their models are configurable. Phase telemetry accepts only workflow phases and their existing
fallback executors, never the standalone actors.

Exact standalone foreground native tasks can dispatch these actor IDs without becoming workflow
phases. Both judge calls may be admitted before either finishes. Models and the judge inspection
permission settle before native dispatch. Moved parents, unresolved transfers, unfinished native
tasks, pending durable intake and unconfirmed workflow claims still block admission. Standalone correction cannot bypass
an unfinished workflow's implementation ownership; starting a workflow while that correction is
in flight is also refused.

Security auditing and Judgment Day share idle-parent admission, not actor capabilities. An
admitted standalone call remains pending until the adapter settles its result/error, even if
native history already says completed. Dual judges may run together; audits, correction writers,
workflow controls and questions wait for that pair to settle. Unconfirmed durable workflow claims
and pending intake still block security auditing after restart. The security checker never grants
judge inspection, and judge inspection never grants security checking or workflow authority.

Judges can invoke only `mdd_jd_inspect`: `tree` lists committed paths, `blob` reads an exact committed
path, and `diff` compares full base/target commit IDs. It accepts local commits identified by 40 or
64 lowercase hexadecimal characters, never refs or revision expressions. Paths are validated exact
repository-relative paths. Diff attributes are pinned to the target commit and text changes cannot
be hidden by dirty binary/submodule attributes. Fixed argv execution disables shell, external diff,
textconv, pager, replacement objects and lazy fetching; inherited Git configuration variables are not forwarded.
Git resolves to an absolute native executable on the host PATH outside the target checkout; relative
PATH entries and checkout-supplied executables are never launched.
Each Git command is bounded to 128 KiB and five seconds; binary/invalid UTF-8, missing or oversized
material fails without partial evidence. Git must support `--no-lazy-fetch` and `--attr-source`
(unsupported versions fail closed). Live source reads, shell, delegation, memory, MCP and all other tools are denied in
native hooks as well as actor permissions. The parent loads matching project skills before dispatch
and supplies identical relevant standards by value with path/digest provenance. Judges never read
skill/reference documents themselves; the inspection tool cannot load arbitrary live skill documents.

#### Explicit activation and installed protocol

In `mdd-orchestrator`, ask: **"Run judgment-day on the complete committed delta from <base commit>
to <target commit>, including tests and relevant dependencies."** Natural-language `judgment day`
and the spelling `judment-day` also activate only on an explicit request, never an incidental mention,
ordinary review, implementation request or completed Verify.

Existing setup/update installs the namespaced pair under the OpenCode config root:

- `skills/mdd-judgment-day/SKILL.md`
- `skills/mdd-judgment-day/references/prompts-and-formats.md`

The source copies are under `assets/opencode/skills/mdd-judgment-day/`. The parent loads those
installation-owned files by exact path; a different registry skill is not a substitute. See
[setup](setup.md) for consent-driven installation; configuration alone installs or launches nothing.

The parent freezes the complete target and standards, issues both foreground judge calls in one
response, waits for both fresh results, strictly validates neutral JSON and corroborates causality.
Malformed/incomplete/inspection-unavailable outputs, unresolved suspects, contradictions or unknown
causality cannot produce APPROVED. Warnings are informational. The packaged reference includes a
parent-only validation recipe; it is not a new native tool, semantic proof or an automatic runner.
Functional checks belong to the parent or an independent ordinary verifier, never the read-only judges.

Dirty/untracked target material requires a separately authorized complete committed snapshot;
never quietly drop it from scope. Snapshot authorization is separate from review and correction
consent. Confirmed severe introduced defects may be corrected only after explicit authorization,
within exact allowed surfaces, with one writer and at most two correction/scoped rejudgment rounds.
An unfinished workflow still owns implementation; no review result overrides native ownership guards.
The fix actor requests native consent for edits and shell, which is not a sandbox. No refuter or
RDD dependency, and no receipt/delivery approval: configuration or judgment never authorizes commit,
push, PR creation or release. Native-host model/concurrency/permission smoke remains unverified and
requires separate authorization; packaging/contract tests are not model-run proof.

## Optional memory

Omit `engram` entirely to disable memory. OpenSpec and None then remain available in their
original relative order. A saved Engram/Both choice is explained and reasked with any other
missing fields, without rewriting the profile. All native safety and local progress checks
remain active. None retains full artifacts in the live run only, not on disk or in memory observations.

Existing version-1 `{ "endpoint": "http://127.0.0.1:7437", "project": "mdd" }` settings
remain readable and are never rewritten on read. The native runtime ignores the deprecated
project field with a notice and resolves each actual workspace through the provider. Re-enter
the endpoint in `mdd config` and explicitly Save to remove the old field. A resolution failure
blocks actionably; it never uses a basename or another project's configured identity.

The additional managed variant is `engram: { mode: 'local', binary, dataDirectory }`.
Both paths must be absolute. `binary` identifies an already installed, approved Engram 1.20.0
executable; the runtime never installs or upgrades it. `mdd setup` detects and offers to reuse
a compatible binary, or offers an explicit pinned Windows installation when missing.
`<OpenCode root>/mdd/memory` is the default managed directory, separate from the user's
existing Engram database. Records are namespaced by resolved project and actual parent.
Both installation and use can be skipped.

`ManagedMemory.endpoint(): Promise<string>` lazily chooses a loopback port and starts or
reuses only its own child. Readiness is bounded and tied to that child's listening signal;
unrelated listeners are never reused or killed. `close(): Promise<void>` shuts down only the
owned child. `NativeIntake.close()` is wired to the native `server.instance.disposed` event
for the matching directory; an owned process-exit handler also requests child termination.
Neither closure ends the native parent session. The managed environment strips inherited
credentials and disables cloud autosync. An exclusive empty database seed prevents upstream
1.20.0's orphan-database migration from importing unrelated drive-root data.

`EngramHttp.bootstrap()` checks health, resolves the actual native root with `/project/current`,
and validates an existing active session or performs one 404-triggered create/readback. The native
root binds when it is the resolved project root, a directory inside it, or a linked worktree of the
same repository, so worktree-based workflows need no separate memory project.
`project` exposes only the validated resolved project. No synthetic coding-session IDs are used.
See [binding safety](opencode-adapter.md#bootstrap-the-actual-parent) for conflict and race limits.
Do not use the health response's hardcoded `0.1.0` as binary version evidence. A CLI version
probe may perform an update check; it is not advertised as network-free.

## API handoff

Import built `dist/*.js` modules. Full types are also emitted in `dist/*.d.ts`.
The local package exposes the kernel and `my-driven-development/opencode-plugin`, plus the
`mdd` executable. `mdd setup` handles installation/configuration with explicit consent.
`mdd init` installs only global owned assets; `mdd doctor` performs
read-only setup checks. See [installation and prerequisites](setup.md).

### Settings (`settings.ts`)

```typescript
type ModelRole = typeof MODEL_ROLES[number];
type NamedProfile = { models: Partial<Record<ModelRole, string>>; answers: Partial<Answers> };
type WorkerPolicy = Readonly<{ enabled: boolean }>;
type Settings = {
  version: 1; activeProfile: string; profiles: Record<string, NamedProfile>;
   engram?: { endpoint: string; project?: string } | { mode: 'local'; binary: string; dataDirectory: string }; telemetry: { enabled: boolean };
  workers: { enabled: boolean };
};
type StartupProfile = Readonly<{
  name: string; models: Readonly<Partial<Record<ModelRole, string>>>;
  answers: Readonly<Partial<Answers>>;
  workers: WorkerPolicy;
}>;
function defaultSettings(): Settings;
function parseSettings(value: unknown): Settings;
function loadSettings(root: string): Settings;
function saveSettings(root: string, value: unknown): Settings;
function freezeProfile(value: unknown): StartupProfile;
function modelFor(profile: StartupProfile, role: ModelRole): string | undefined;
function profileName(value: unknown): string;
function parseModel(value: unknown): string;
```

`MODEL_ROLES` is the readonly fourteen-role list shared by the editor and installer: the coordinator,
eight workflow phases, risk assessment, security auditing, and three standalone Judgment Day actors.
The native config hook sets agent
models only when `modelFor` returns a string. `undefined` leaves native selection intact.
Settings parsing detaches data; the startup profile, nested maps, and worker policy are frozen.

The plugin does not modify the default agent, top-level model, other agents, or permissions.
At run initialization the coordinator and eight phase actors must exist in their expected modes. Resolved
agent models and the actual parent assistant model are captured per parent. Subsequent
inspection rejects changes, missing identities, and disagreement between task metadata
and any child assistant model. An omitted override preserves any native phase model;
otherwise OpenCode inherits the actual parent model. There is no task-level model parameter,
provider API, substitution, or mid-run model switch. Restart after settings changes.

### Standalone security report foundation

Set the optional **mdd-security** model under **Modelos** in `mdd-ai config`, then Save and
restart OpenCode. An omitted override inherits native selection. This actor is **not a phase**:
configuration and the packaged deny-all actor do not enable audit dispatch. Authenticated
on-demand dispatch, immutable snapshot capture and final evidence binding are separate integration
requirements. No automatic audit, source fixes, phase advancement or delivery approval is added here.
Corrections require separate user authorization through `mdd-apply`.

The pure API is available from `dist/security.js`, `dist/phase-report.js` and `dist/report-check.js`:

| Export | Contract |
|---|---|
| `SECURITY_LAYERS` | `committed`, `index`, `worktree`, `untracked`; all four are required, including empty layers. |
| `SecurityAssessment`, `parseSecurityAssessment(value)` | Detached bounded structured claims: `{snapshotID,status,coverage,limitations,findings}`. Form validation only. |
| `SecurityLocation` | `{locationID,layer,side,path,startLine,endLine}`; identifies one runtime snapshot location, including revision and before/after side. |
| `SecurityFinding` | `{id,severity,title,location,evidence,attackConditions,impact,recommendation}`; severity critical/high/medium/low. |
| `SecurityCoverage` | `{layer,status,inspected:[locationID],limitations:[text]}`; status complete/partial/unavailable. Runtime manifest supplies coverage and omissions; actor adds inspection gaps. |
| `parseSecurityReport(text)` | Existing Markdown envelope, with exactly `security` in the MDD Data block; never phase fields. |
| `checkSecurityReportForm(text)` | `{ok,problems,resultFormat,note,security?}`; returns parsed assessment only if all form checks pass. No I/O or workflow state changes. |
| `SECURITY_FIELD_SCHEMA`, `securityReportFormatLines()` | Explicit bounded schema and actor report instructions from the same module. |

Reports retain the MDD Outcome/Summary/How/Artifact/Data headings. Outcome `passed` means completed
inspection, even when findings exist; `failed` means inconclusive. Assessment `findings` requires
1–32 detailed findings; `no-findings` requires none and **does not certify code secure**.
`inconclusive` preserves known findings and requires an explicit limitation. Any partial/unavailable
coverage or reported limitation prevents a complete assessment. Missing coverage or missing finding
evidence, attack conditions, impact or recommendation is rejected, not silently accepted.

Summary, how, the artifact and the total report have no size limit.
Snapshot/location/finding IDs allow 1–128 ASCII letters, digits, underscores or hyphens. Each layer
allows at most 256 inspected IDs, globally unique across layers; unavailable layers cannot claim
inspection. Layer/overall limitations allow 16 entries of 1–1,000 characters each. Findings allow
300-character titles and 2,000 characters for each detailed text field, all nonempty single-line
text. Paths are repository-relative forward-slash paths of at most 1,000 characters; line ranges
are inclusive positive safe integers. Untracked locations have only an after side. Unknown keys,
duplicate finding IDs and citations outside the reported inspected layer are rejected.

Snapshot IDs and coverage are still **claims** in this foundation. A clean form check neither
authenticates the snapshot nor verifies that a cited path, side, line or evidence matches its bytes.
Final dispatch integration must bind every location ID and coverage statement to runtime input;
different revisions or sides of one path must have distinct location IDs. Do not treat this API as
an audit result acceptance or as permission to read the live workspace.

### Preflight (`preflight.ts`)

```typescript
type QuestionEnvelope = { questions: {
  header: string; question: string;
  options: { label: string; description: string }[]; multiple: false;
}[] };
function parsePartialAnswers(value: unknown): Partial<Answers>;
function questionEnvelope(known?: unknown): QuestionEnvelope;
function answerFromLabel<K extends keyof Answers>(field: K, label: unknown): Answers[K];
function answersFromLabels(known: unknown, selections: unknown): Answers;
function resolvePreflight(known: unknown, selections: unknown, explore?: boolean):
  { answers: Answers; evaluation: Evaluation };
```

`ANSWER_FIELDS` exports the original order. Issue **one** native question call containing
all missing fields. A complete profile yields `questions: []`; skip the tool and resolve
using `[]`. Native responses are ordered `string[][]`, exactly one known label per missing
question. Unknown/custom text, extra selections, wrong order, and wrong counts fail.
There are no invented `custom` or option `value` fields.

Pass resolved answers to `new Workflow({ answers })`, not the rich named profile. These pure
helpers do not establish human consent. The native `NativeIntake` gate now owns the exact
question before/after correlation, validates ordered native answer metadata, and starts the
runner only after accepted preflight. Complete frozen profiles skip the question. All starts
require requirements matching the actual latest nonsynthetic native user text.

Public `mdd_start` accepts only `{ requirements }`; model-supplied profiles, answers, scoring
overrides, endpoints, and project keys are not accepted. Configure those supported settings
through the global file/editor and restart. Absent Engram settings mean memory off; opted-in
memory automatically bootstraps the actual native parent. Unavailable configured memory is not silently disabled.

Interactive phase approval uses one native Proceed/Stop question bound to the run and exact
next phase. No public approval setter exists. `mdd_status.question` is the exact question
argument object, and `questionReceipts` retains consumed native call IDs and labels. Pending,
failed, dismissed, stale, or duplicate calls cannot authorize work. Automatic mode adds no
phase approval questions. Valid approval prepares only the corresponding next task.

### Evidence reporting (`reporting.ts`)

```typescript
type EvidenceFlag = 'requirements' | 'plan' | 'implementation' | 'checks';
type EvidenceState = 'unearned' | 'confirmed' | 'invalidated';
type Evidence = Record<EvidenceFlag, EvidenceState>;
type ReportStatus = 'in-progress' | 'passed' | 'failed' | 'blocked';
type ConfidenceLevel = 'high' | 'medium' | 'low';
type Narrative = {
  purpose?: string; openItems?: string; learnings?: string;
  confidence?: { level: ConfidenceLevel; reason: string };
};
type PhaseReport = {
  phase: Phase; summary: string; how: string[]; status: ReportStatus; evidence: Evidence;
  narrative?: Narrative;
};
function emptyEvidence(): Evidence;
function invalidateEvidence(value: Evidence, affected: readonly EvidenceFlag[]): Evidence;
function evidenceCoverage(value: Evidence): number;
function parseNarrative(value: unknown): Narrative;
function renderReport(detail: Answers['summary'], value: PhaseReport): string;
```

`EVIDENCE_WEIGHTS`: **20 confirmed requirements + 20 validated applicable plan/design +
25 scoped implementation done + 35 actual checks verified**. Only confirmed flags earn
points. The adapter corroborates them, never accepts model-selected percentages or
infers confidence from phase counts. Failures invalidate affected flags; failed/blocked
reports without invalidation are rejected. Unrelated confirmed evidence can remain earned.
Coverage still decides whether a run may close as complete, and `mdd_status` still reports it,
but it is not rendered in any report. Every phase actor writes all of its prose sections —
`## MDD Approach`, `## MDD Purpose`, `## MDD Open Items`, `## MDD Learnings` and
`## MDD Confidence` beside `## MDD Summary` — whatever detail the user chose; the level decides
only what is shown, so asking for more detail at an approval has more to show:

| Level | Rendered sections, in order |
|---|---|
| Low | `Resumen` |
| Medium | `Resumen`, `Propósito`, `Aprendizajes clave` |
| Detailed | `Resumen`, `Cómo se hizo`, `Propósito`, `Pendiente o incierto`, `Aprendizajes clave`, `Confianza`, `Estado` |

`Confianza` is the actor's own stated level, `Alta`/`Media`/`Baja`, followed by the evidence it
gives for it; it is a claim, never a measured probability, and a report whose confidence does
not start with High, Medium or Low, or gives no reason, is returned to be restated. A section an
actor left out of its report is shown as `El agente no lo informó.` rather than skipped; reports
no actor wrote (placeholders, the risk stop, checkpoints from before narratives) show only what
they hold. `## MDD How` is still read as the approach. Those headings, the phase labels, the
confidence levels and the statuses are rendered in Spanish for the reader; the keys they are
stored and compared under stay the protocol's English ones.
Reports generate neither receipts nor invented claims about implementation/checks.

### Local telemetry (`telemetry.ts`)

The preference is global. `telemetry on/off` changes only global settings. Status, retention,
`report` and `clear` address the repository's `.mdd/telemetry.jsonl` and
`.mdd/telemetry-rollup.json` — resolved from a linked worktree to the repository it belongs to, so
a run's metrics accumulate with the repository's rather than dying with the worktree — and there is
no cross-project archive or deletion. Telemetry and
progress lazily create private `.mdd` storage with its own ignore file on first runtime write,
never during installation. API helpers accept an optional final `InstallationEnvironment`
argument for isolated global preference tests.

```typescript
type TelemetryUsage = {
  input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number;
  cost: number; messages: number; partial?: true;
};
type TelemetryEvent = {
  timestamp: number;
  event: 'preflight' | 'phase-start' | 'phase-end' | 'approval' | 'report' | 'retry' | 'handover' | 'reset';
  phase?: Phase; duration?: number; route?: 'low' | 'high';
  outcome?: 'passed' | 'failed' | 'blocked' | 'cancelled';
  runID?: string; attempt?: number; mode?: 'delegate' | 'inline';
  failure?: 'phase-failed' | 'result-rejected' | 'dispatch-mismatch' | 'native-error' | 'route-blocked' | 'stopped';
  usage?: TelemetryUsage;
};
type TelemetryResult =
  | { ok: true; enabled: boolean; count: number; retentionDays: 30; rollup?: 'unavailable' }
  | { ok: false; diagnostic: 'telemetry-unavailable' | 'invalid-event' };
function recordTelemetry(root: string, value: unknown, now?: number): TelemetryResult;
function telemetryStatus(root: string, now?: number): TelemetryResult;
function telemetryReport(root: string, now?: number): { ok: true; text: string } | { ok: false; diagnostic: 'telemetry-unavailable' };
function clearTelemetry(root: string): TelemetryResult;
```

`RETENTION_MS` is 30 days. Timestamp is integer Unix milliseconds; duration is integer
milliseconds, 0–86,400,000. Only listed fields/values are allowed: no source, prompts, raw
errors, paths, identifiers, credentials, model/provider, environment, network, or export.
`runID` is validated as a UUID and nothing else, so no free text enters through it; `attempt`
is which try at that phase the row belongs to, counted per phase and restored when the route
reaches the next one, so `attempt: 3` means that phase was dispatched three times rather than
that the run had already failed twice elsewhere. `failure` is assigned by the adapter at
the point where it already knows, never proposed by an actor. The native runner records accepted
preflight, phase start/end, approval, report, retry, handover and reset events using its clock.
Imports and startup settings reads never record events. Status and report reads do not append
events. Failed writes yield a bounded telemetry diagnostic without changing the execution
outcome. Telemetry off is checked on each record, independently of frozen model/profile
selections.

`usage` is what the provider reported for the child session the completed task envelope names,
summed over that session's assistant messages. A phase carried out by the coordinator has no
separate child and records no usage; a result whose envelope is malformed names no session and
is charged to nobody. `partial` marks an undercount — a history longer than the 1,000-message
read window, a message that had not settled, or a host that reported no usage at all — because
an undercount presented as a measurement is worse than none. Measurement never fails a phase:
an unreadable session yields a `usage-unavailable` diagnostic and the run continues.

`.mdd/telemetry-rollup.json` holds fixed-key counters that outlive event retention: runs
started/completed/blocked/reset/compacted, runs per route, failures per class, and per phase the starts,
outcomes, retries, handovers, timed duration and summed usage. It contains no identity and no
text, and nothing in it expires. A `retry` or `handover` row repeats the class of the attempt
it follows, so only `phase-end` and `report` rows increment a failure counter. A rollup that
cannot be updated is reported as `rollup: 'unavailable'` while the event itself is still
recorded, and a damaged rollup is never overwritten. `telemetry clear` deletes the rollup with
the events it summarizes. `telemetry report` renders both locally with plain arithmetic: no
model is asked what the numbers mean, and a workspace whose events predate its rollup is told
exactly that instead of being reported as empty.

A `compaction` row records that the host replaced a coordinator conversation with a summary
mid-run. It is not a failure and costs MDD nothing directly, but it is the event behind a whole
class of them — a coordinator that no longer remembers which phase it is on redispatches,
re-reports or stops — and it was invisible until it was counted. A counter added after a
workspace started keeping totals is read as zero rather than rejected, so an older rollup keeps
the runs it had already counted.

`.mdd/sessions.jsonl` is the earliest record in the workspace: one line the first time an
`mdd-orchestrator` conversation calls any MDD tool here, holding the session identity, the agent,
the workspace and a timestamp. It exists because the ledger used to learn that MDD had been used
at all only once a phase had already produced an event, so every conversation that died earlier —
at a question the host never delivered, at a stale marker, at setup — left the directory exactly
as it found it. It is metadata only, never read by a run, written once per conversation, bounded
to the most recent 500 rows, and governed by the same telemetry preference: with telemetry off,
nothing is written. A damaged row is skipped rather than repaired, and a workspace that cannot be
written to degrades silently, because instrumentation that can fail a run gets removed.

`.mdd/telemetry.jsonl` is Git-ignored. Append/status prune rows at or older than 30 days;
there is no background deletion for unused projects. Future timestamps are rejected on
recording and pruned from stored data. Limits are 5,000 rows and 1 MiB. Disable prevents
new writes; clear deletes even malformed logs. Disabled record returns count 0 without
reading retained rows; status reports their retained count. Invalid settings/unsafe storage
fail closed with bounded diagnostics, never raw data.

### Recorded improvements (`lessons.ts`)

```typescript
type Lesson = {
  id: string; timestamp: number;
  source: 'user' | 'failure'; kind?: FailureClass; phase?: Phase;
  title: string; detail: string;
  state: 'open' | 'reviewed' | 'applied';
};
function recordLesson(root: string, value: LessonInput, now?: number): LessonResult;
function recordLessonQuietly(root: string, value: LessonInput, now?: number): void;
function readLessons(root: string, query?: { text?: string; state?: LessonState; limit?: number }): ...;
function markLessons(root: string, ids: readonly string[], state: LessonState, now?: number): ...;
function renderLessonsReport(lessons: readonly Lesson[], total: number): string;
```

What MDD has been told it does badly, in words. Telemetry counts what happened and holds no text
by design, which is exactly what makes it useless for deciding what to change; this is the other
half and it holds text on purpose. Two things write here: `PhaseRunner` records an entry from the
failure path of every ended attempt, where the reason is still exact, and the coordinator records
one deliberately through `mdd_improve` when the user says something should be remembered. An
automatic entry carries the adapter's own `FailureClass` and phase; a deliberate one carries the
user's words and is accepted only after `inspector.intake` proves they wrote them.

`.mdd/lessons.jsonl` is Git-ignored with the rest of `.mdd`, is never exported, and holds at most
500 entries within 512 KiB. When it fills, entries already `reviewed` or `applied` fall off first,
oldest first, and only then an untouched `open` one. Nothing expires by time: a lesson from March
is still what MDD learned. Marking changes state and never deletes. Recording is best-effort from
the failure path — a route that broke must never break twice because its own record could not be
written — and an unreadable file is reported rather than read as half a list.

With optional memory enabled, each entry is additionally saved as an Engram observation of type
`mdd-lesson` titled `MDD lesson v1: …`, and `mdd_improvements` searches that type through
`GET /search`, which is the one provider read that answers with an array. Memory is an index over
the local record, never the record: with memory off, or unavailable, the local file still answers
and the tool reports `memory: 'off' | 'unavailable'` instead of claiming a complete review.

### Run ledger and retrospective (`run-ledger.ts`, `retro.ts`)

```typescript
type RunRecord = {
  version: 1; runID: string; timestamp: number;
  state: 'complete' | 'blocked'; directory: string;
  route: Phase[]; phase: Phase; coverage: number; evidence: Evidence;
  changedFiles: number; checks: { total: number; passed: number; failed: number };
  concerns: number; goal?: string; limits: string[];
};
function recordRun(root: string, value: RunLedgerInput, now?: number): RunLedgerResult;
function recordRunQuietly(root: string, value: RunLedgerInput, now?: number): void;
function readRuns(root: string, query?: { limit?: number }): ...;
function retroReport(root: string, limit?: number): { ok: true; text: string };
```

One compact row per finished run, written where the dossier is replaced. The dossier preserves a
run in full but keeps a single slot per conversation and is overwritten by that conversation's next
objective, so it answers "can this run be picked up again" and nothing about the repository. The
rollup survives but counts events without saying which run they belonged to or what it was trying
to do. Between them sat the question nobody could ask — how the work has been going — and its
evidence was being deleted on every new start.

`PhaseRunner` writes a row when a run reaches `complete` or `blocked`, replacing that run's own row
if it reaches a further state, so one run occupies one row and a blocked-then-finished run is not
counted twice. Rows hold outcome, route, phase reached, evidence coverage, changed-file count,
check totals with the failed ones counted apart, concern count, the recorded goal and up to four
verification limits — no artifacts, prompts or source. `.mdd/runs.jsonl` is Git-ignored with the
rest of `.mdd`, bounded to 200 rows within 512 KiB, dropping oldest first. Overlong prose is
trimmed rather than refused: losing the record that a run happened, because its goal was long,
would trade the fact for the footnote. Recording is best-effort and never fails a run.

`mdd retro` reads the three records that already existed and were never read together — the run
ledger, the accumulated counters and the improvements nobody reviewed — and renders one Spanish
report. It leads with **Señales**: runs started that reached no recorded ending, blocked and reset
counts, mid-run compactions, the most frequent failure class, the most retried and most interrupted
phase, runs that changed nothing, runs whose checks exited nonzero, runs called complete below full
coverage, and how many checkouts of the repository the recent runs came from. Every line is a count
of something recorded; the report names the number and leaves the cause to the reader, because MDD
knows that eleven explorations stopped and not why. It is strictly read-only — it uses a
non-pruning event count rather than `telemetryStatus`, which rewrites the file it reads — and a
workspace holding events but no aggregate is reported as exactly that rather than as an empty
record.

### Terminal seams (`config-ui.ts`, `settings-cli.ts`)

```typescript
type ConfigIO = {
  isTTY: boolean;
  read(prompt: string): Promise<string | undefined>;
  write(text: string): void;
};
function runConfigUI(root: string, io: ConfigIO): Promise<'saved' | 'cancelled'>;
function runTerminalConfig(root: string): Promise<'saved' | 'cancelled'>;
function changeProfile(settings: Settings, action: 'create' | 'use', name: string): Settings;
function settingsCommand(args: string[], root: string, write: (text: string) => void): Promise<boolean>;
```

`settingsCommand` returns false for legacy proof parsing. `ConfigIO` is the scripted
test seam, without a terminal framework or unbounded automated stdin reads.

## Storage boundary and verification

Validated writes use same-directory exclusive temporary files (`0600`), fsync contents,
and atomic rename under a cooperating-writer lock. Private telemetry directories use
`0700`; Windows ACLs ultimately control permissions. Existing symlinks/junctions, hard
links, nonregular targets, and linked root ancestors are rejected. Fixed destinations
prevent filename traversal. Failed replacement preserves old bytes and removes owned
temporaries, never a competing lock. Crashes may leave ignored lock/temp files: inspect
and remove only when no writer is active. Human editor drafts are not merged.

This is **not a sandbox against a hostile process able to rename project directories
during an operation**. Portable Node path checks cannot atomically protect every ancestor.
Directory fsync/power-loss durability is not guaranteed across platforms.

Run `npm run typecheck` and `npm test`. Tests use temporary fixtures for save/cancel,
non-TTY and CLI smoke, strict settings, all partial preflight subsets, evidence weights,
atomic failure, link confinement, and telemetry retention/disable/delete. The optional managed
smoke uses only an explicitly supplied installed binary and an isolated temporary database;
it is skipped by default. No paid model smoke is used. Functional verification is not independent review.

The foundation modules are now dependencies of native intake, models, and artifact integration.
Do not remove them independently. Configuring a profile alone does not execute a run:
protected native requirements intake is still required. Actual-parent memory registration is
automatic only when the optional backend is enabled.
