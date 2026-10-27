# Unblock the adaptive version-3 entry

Make `mdd_adapt` entry usable in real conversations: a real global OpenCode configuration must not
refuse every admission, entry must need only the contract, an earlier confirmed request must be
admissible, and every hint must lead to version 3 instead of `mdd_start`.

Branch: `feat/adaptive-entry-unblock`. Delivery: work-unit commits on the feature branch; push and
PR remain the user's decision. Test runner: `node:test` over `dist/` (`npm test`).

## Problem and evidence

Since the adaptive route became the default (2026-10-15), no version-3 run was ever admitted in
real use. Across the eight `mdd-orchestrator` conversations from 2026-10-15 to 2026-10-27:

- `mdd_adapt` ran 30 times; 24 were status/detail reads of the 18 KB input schema.
- Three entries were attempted. One sent `args: {}` ("Native entry requires contract.") and the
  coordinator switched to `mdd_start` in the same minute. Two passed the mode question and were
  refused with `Apply scope has unproven paths or implicit runtime/instruction effects; use serial
  execution.`, which a reset could not clear.
- No `.mdd/adaptive-*.json` journal exists in any of the nine workspaces that hold `.mdd/`.

Causes:

1. **Configuration guard.** `safeApplyBootstrap` (`src/worker-batch.ts`) read the global
   `~/.config/opencode/opencode.json` and treated every string containing a control character or
   `{file:`/`{env:` as a file reference. Any multi-line agent prompt therefore refused every scoped
   Apply. The real configuration held 31 multi-line strings and 4 substitutions, none of which
   could reach a workspace file. The adaptive run calls the guard in its constructor
   (`src/adaptive-low.ts`), so admission itself failed, and the message advised a serial fallback
   that version 3 does not have. The tests isolate `HOME`, so no test ever saw a real global file.
2. **`messageID`.** Entry required the native user message ID, which the model cannot see, while
   the host could already bind it from the actual caller.
3. **Objective binding.** Entry accepted only the latest user message as the objective, so an
   "investigate, then confirm" conversation turned "si confirmo las recomendaciones" into the
   objective, and a chat reply during a question session required resending the request.
4. **Steering.** `nextAction` for an idle state without the adaptive projection (for example after
   `mdd_reset scope=run`) said "call mdd_start once"; the coordinator prompt said to pass findings
   as `mdd_start` context; the `mdd_start` description still said it starts implementation.
5. **Contract cost.** The model had to hash every footprint file (SHA-256) and spell out every
   empty list before the first entry.

Recorded improvements `01a170b4956f0000` (messageID) and `01a170c1f2220000` (scope refusal) in
`entrecuadras-mobile/.mdd/lessons.jsonl` describe causes 2 and 1.

## Specs

- **S1** A real global OpenCode configuration with multi-line prompts, `{file:./AGENTS.md}`,
  `{env:…}` secrets, `file:///` plugins and remote or unrelated `instructions` does not refuse a
  disjoint Apply scope. A `{file:}`, `{env:}`, `file:` URL, path-like value or `instructions`
  pattern that can reach a declared write still refuses it, as do JSONC, project plugins and
  implicit runtime writes. The refusal names the file, JSON location and write, never a value.
- **S2** Public entry needs only `contract`. The host binds the user message whose exact text is
  the objective; a supplied `messageID` must match it. The internal object path without a host
  caller still requires the exact identity.
- **S3** An objective carried by an earlier user message of the conversation is admitted only
  after one fresh native confirmation in the current turn (automatic mode; interactive mode keeps
  its operation approval). `Pause`, `Decline` or a dismissal admit nothing. Consumed requests and
  ambiguous identical texts stay refused.
- **S4** Omitted `exclusions`, `decisions`, `productQuestions`, assignment `decisions`/`dependsOn`,
  obligation lists and `context.fingerprints` are filled by the host; fingerprints are the current
  SHA-256 bytes of the declared footprint (`null` for a new file). Supplied values are unchanged.
- **S5** A status offering entry carries `entryGuide`. An idle reply without the adaptive
  projection points `nextAction` at the exact version-3 status call; preserved data-only work keeps
  its fixed path. Coordinator prompt, `mdd-grill` and tool descriptions no longer send fresh work
  or refusals to `mdd_start`, and never ask to resend a request.

## Tasks

| ID | Specs | Route | Status |
|---|---|---|---|
| T1 Configuration guard with exact reasons (`worker-batch.ts`) | S1 | inline | done |
| T2 Optional `messageID`, earlier-objective binding and confirmation (`adaptive-native.ts`, `adaptive-protocol.ts`, `opencode-plugin.ts`, `phase-runner.ts`, `native-intake.ts`) | S2, S3 | inline | done |
| T3 Entry defaults, fingerprints and `entryGuide` (`adaptive-protocol.ts`, `adaptive-low.ts`) | S4, S5 | inline | done |
| T4 Steering: `next-action.ts`, coordinator prompt, `mdd-grill`, tool descriptions | S5 | inline | done |
| T5 Docs: README, adapter guide, configuration, product contract | S1–S5 | inline | done |

Route: inline. One understood change across known files; no writer reason (no parallel units).
Risk: item 3 (contracts others consume: the adaptive entry protocol and coordinator instructions)
and item 2 (the configuration guard is a safety boundary). Verification below.

## Verification

```powershell
npm run build
node --import ./tests/isolate-home.mjs --test tests/worker-edit.test.mjs tests/adaptive-public.test.mjs tests/adaptive-native.test.mjs tests/next-action.test.mjs tests/workspace-runs.test.mjs tests/phase-assets.test.mjs
npm run typecheck
git diff --check
npm test
```

## Log

- **L1** (2026-10-27, user): "Hagamos eso, mejoremoslo. Implementa todas esas mejoras y avanza
  automaticamente." — referring to the four recommendations: fix the configuration guard, resolve
  `messageID` in the host, steer everything to version 3, and make the contract cheaper (draft help
  and an objective that can be the original confirmed request).
- Baseline (`60dc129`, separate worktree): `npm test` 2,763 tests, 2,752 passed, 8 failed, 3
  skipped. All eight are environmental: `setup-ui` copies a junctioned `node_modules` (EPERM),
  `apply-batches-host` deterministic smoke, `cli` and `pack` spawn timeouts under load.
- RED on the baseline build with the new tests: `worker-edit` 9 of 38 failed (the realistic global
  configuration was refused with the production message); `adaptive-public` + `next-action` 7 of
  80 failed. The end-to-end regression reproduced the production refusal verbatim with an explicit
  `messageID`: "Apply scope has unproven paths or implicit runtime/instruction effects; use serial
  execution."
- GREEN: focused suites above, 124/124 and 188/188 in two batches after the changes.
- Real environment, read-only: the new guard evaluated against the user's actual global
  configuration and the entrecuadras-mobile, entrecuadras-backend, app-vibepeak and mdd
  workspaces reports every scope as provable (the old guard refused all of them).
- First full run: 2,777 tests, 2,772 passed, 2 failed, 3 skipped. `pack` was an `npm pack`
  timeout (passes alone). `setup-ui` "source first run" failed because `src/worker-batch.ts` was
  edited during the run, so the repository `dist/` no longer matched a fresh build of `src/`; after
  rebuilding, `worker-edit`, `setup-ui`, `settings` and `pack` passed 166/166.
- Follow-up in that edit: a multi-line value under `mcp`, `formatter` or `lsp` is executable, not
  prose, so it still refuses a write it names (new `worker-edit` case).
- The independent read-only reviewer could not run (subagent authentication error); no review
  findings exist for this change.
- Final full run on the finished source: `npm test` 2,778 tests, 2,775 passed, 0 failed, 3 skipped
  (the usual environmental skips). `npm run typecheck` exit 0. `git diff --check` exit 0.
- Not yet observed: a live model run through the new entry. The installed plugin in
  `~/.config/opencode/mdd` is still the 2026-10-24 build until `mdd-ai update` and an OpenCode
  service restart; that is the user's decision and was not done here.
