import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MDD_ASSETS, MDD_PACKAGED_ASSETS } from '../dist/project-assets.js';
import { phaseName } from '../dist/phase-assets.js';
import { PHASES } from '../dist/policy.js';
import { defaultSettings, freezeProfile, MODEL_ROLES } from '../dist/settings.js';
import { applyModelOverrides } from '../dist/native-models.js';
import { PHASE_AGENTS, CHECK_AGENTS, pinPhaseAgents } from '../dist/opencode-plugin.js';
import { FIELD_SCHEMA } from '../dist/acceptance.js';

test('evidence handoff: shipped prose keeps compact locators, uncertainty and independent verification', () => {
  for (const path of ['assets/opencode/agents/mdd-orchestrator.md', 'assets/opencode/mdd-instructions.md']) {
    const text = fs.readFileSync(path, 'utf8').replace(/\s+/g, ' ');
    for (const pattern of [/finding/, /source locator/, /observed basis/, /freshness conditions and gaps/,
      /commands\/results only when actually observed and relevant/, /load-bearing locator and uncertainty/,
      /oldest-first compaction/, /Do not automatically duplicate raw outputs or entire source fragments/,
      /start planning from relevant evidence/, /close phase-specific gaps/, /Prior evidence is not current proof/,
      /Apply\/Verify must independently inspect current sources and run applicable checks/]) assert.match(text, pattern, path);
  }
});

test('evidence handoff: storage docs distinguish exact readback from declared summary compaction', () => {
  const artifacts = fs.readFileSync('docs/artifacts-and-actors.md', 'utf8').replace(/\s+/g, ' ');
  assert.doesNotMatch(artifacts, /\b8,000\b|Do not substitute a digest or summary/);
  assert.match(artifacts, /96,000 UTF-8 bytes/);
  assert.match(artifacts, /38,000-byte/);
  assert.match(artifacts, /oldest-first/);
  assert.match(artifacts, /recorded summary and ref/);
  assert.match(artifacts, /readback.*complete artifact/);
  for (const path of ['docs/artifacts-and-actors.md', 'docs/opencode-adapter.md']) {
    const text = fs.readFileSync(path, 'utf8').replace(/\s+/g, ' ');
    assert.match(text, /load-bearing locator and uncertainty/, path);
    assert.match(text, /Prior evidence is not current proof/, path);
    assert.match(text, /not measured live actor compliance or token savings/, path);
  }
});

test('checkout handoff: shipped guidance scopes negative capability observations without tool bans', () => {
  const coordinator = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8').replace(/\s+/g, ' ');
  const common = fs.readFileSync('assets/opencode/mdd-instructions.md', 'utf8').replace(/\s+/g, ' ');
  for (const text of [coordinator, common]) {
    for (const pattern of [/already-observed.*negative capability/, /capability\/provider or index location/,
      /checkout\/environment identity/, /observed failure/, /fallback/, /invalidation conditions/,
      /unchanged failed availability probes/, /restart/, /new index/, /contrary current evidence/,
      /advisory/, /blanket tool bans/, /enforced expiry/]) assert.match(text, pattern);
  }
  assert.match(coordinator, /idle boundaries/);
  assert.match(coordinator, /concise superseding observations/);
  assert.match(coordinator, /global credentials or create automatic detectors/);
  assert.match(coordinator, /Standalone investigations gain no observation storage channel/);
  assert.match(common, /runtime directory.*active checkout/);
  assert.match(common, /host worktree.*may differ/);
  assert.match(common, /Installation paths, predecessor artifacts and coordinator context cannot override/);
});

test('checkout handoff: retained phase and risk briefs compose the same workspace data', () => {
  const source = fs.readFileSync('src/phase-runner.ts', 'utf8');
  const risk = source.slice(source.indexOf('#riskPrompts(run: Run)'), source.indexOf('/** Change executor'));
  const phase = source.slice(source.indexOf('#phasePrompts(run: Run'), source.indexOf('#riskRecoveryReport(run: Run)'));
  for (const builder of [risk, phase]) {
    assert.match(builder, /workspaceData\(run\.runtime\)/);
    assert.match(builder, /const compose = .*closing/s);
    assert.match(builder, /\.\.\.data/);
    assert.match(builder, /brief = compose\(/);
  }
});

test('SA-1: packaged handoffs ground each planning role without new report fields', () => {
  const expectations = {
    explore: [/searched scope/, /file paths\s+and symbols or line ranges/, /coverage gaps/, /existing artifact prose/],
    risk: [/identifiable Explore findings/, /does not validate the truth/],
    propose: [/Separate observed evidence, constraints and assumptions/, /Do not repeat the exploration/],
    spec: [/original user request/, /omitted behavior, exclusions and unresolved assumptions/],
    design: [/existing implementation seams/, /compatibility, security and operational constraints/],
    plan: [/assigned completion checks/, /deferred integration verification/, /scoped worker cannot run commands/],
    tasks: [/assigned completion checks/, /deferred integration verification/, /scoped worker cannot run commands/],
    apply: [/optional packaged mdd-cleanup path/, /integration assumptions/, /deferred integration checks/],
  };
  for (const [role, patterns] of Object.entries(expectations)) {
    const text = fs.readFileSync(`assets/opencode/agents/mdd-${role}.md`, 'utf8');
    for (const pattern of patterns) assert.match(text, pattern, role);
  }
  const apply = fs.readFileSync('assets/opencode/agents/mdd-apply.md', 'utf8');
  assert.doesNotMatch(apply, /instructions and digest injected/);
});

test('SA-1: common source, skill and checker rules explicitly honor restricted lanes', () => {
  const text = fs.readFileSync('assets/opencode/mdd-instructions.md', 'utf8');
  assert.match(text, /Planning and Verify are read-only for project sources/);
  assert.match(text, /ordinary generated test\/build outputs/);
  assert.match(text, /never repair sources/);
  assert.match(text, /Native fallback skips skill reads and the report checker/);
  assert.match(text, /Scoped workers receive no packaged skill hints/);
  assert.match(text, /Otherwise, outside native fallback, before you return it/);
});

test('SA-1: deliverable guidance keeps conservative eligibility without denying active concurrency', () => {
  assert.doesNotMatch(FIELD_SCHEMA.deliverables, /concurrency is not active/);
  assert.match(FIELD_SCHEMA.deliverables, /never guess independence/);
  assert.match(FIELD_SCHEMA.deliverables, /missing\/incomplete scopes or omitted dependencies remain sequential/);
  assert.match(FIELD_SCHEMA.deliverables, /runtime selects eligible worker batches/);
});

test('assets: worker instructions preserve exact grouped dispatch and bounded member authority', () => {
  const coordinator = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8');
  assert.match(coordinator, /tasks or nextAction\.calls/);
  assert.match(coordinator, /one grouped native foreground tool-call message in provider order/);
  assert.match(coordinator, /Never use Code Mode, Promise\.all or background/);
  assert.match(coordinator, /Apply batches use mdd_worker_edit; Verify stays singular/);
  assert.doesNotMatch(coordinator, /Production Apply and Verify stay singular/);
  for (const role of ['plan', 'tasks']) {
    const text = fs.readFileSync(`assets/opencode/agents/mdd-${role}.md`, 'utf8');
    assert.match(text, /complete read\/write footprints/);
    assert.match(text, /uncertainty keeps execution serial/);
    assert.match(text, /implicit instruction\/bootstrap reads and shared effects/);
    assert.match(text, /formatter-free mdd_worker_edit/);
  }
  for (const path of ['assets/opencode/mdd-instructions.md', 'assets/opencode/agents/mdd-apply.md', 'assets/opencode/agents/mdd-explore.md']) {
    const text = fs.readFileSync(path, 'utf8');
    assert.match(text, /scoped worker/);
    assert.match(text, /shell/);
    assert.match(text, /singular Verify/);
  }
  const apply = fs.readFileSync('assets/opencode/agents/mdd-apply.md', 'utf8');
  assert.match(apply, /automatically supplies mdd_worker_edit/);
  assert.match(apply, /never built-in edit\/write\/patch/);
  assert.match(apply, /exact whole file, oldString must match exactly once/);
  assert.match(apply, /Do not call mdd_check_report in this lane/);
  assert.match(apply, /Return checks=\[\]/);
  const common = fs.readFileSync('assets/opencode/mdd-instructions.md', 'utf8');
  assert.match(common, /For any scoped worker, return the report directly/);
  assert.match(common, /Read-only workers cannot use mdd_worker_edit/);
});

const JD_ROLES = ['mdd-jd-judge-a', 'mdd-jd-judge-b', 'mdd-jd-fix'];

for (const role of ['plan', 'tasks']) {
  test(`assets: ${role} sizes dependency-ordered deliverables for fresh Apply actors`, () => {
    const text = fs.readFileSync(`assets/opencode/agents/mdd-${role}.md`, 'utf8');
    assert.match(text, /1–32 dependency-ordered, bounded coherent deliverables/);
    assert.match(text, /fresh Apply actor/);
    assert.match(text, /own checks and handoff/);
    assert.match(text, /line count is not a hard stop or arbitrary cap/);
    assert.match(text, /single deliverable remains too large/);
  });
}

test('assets: Apply completes only its assignment and reports genuine blockers without a diff ceiling', () => {
  const text = fs.readFileSync('assets/opencode/agents/mdd-apply.md', 'utf8');
  assert.match(text, /completed=\[assignedStepID\]/);
  assert.match(text, /Never stop the whole feature just because its total diff is large/);
  assert.match(text, /missing decision, failed checks, environment failure or uncertain writes/);
  assert.match(text, /Never silently add scope or task IDs/);
  assert.match(text, /preserved filesystem progress/);
});

test('assets: coordinator follows durable same-phase success without speculative dispatch', () => {
  const text = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8');
  assert.match(text, /durable success.*same-phase Apply nextAction/s);
  assert.match(text, /no per-batch approval/);
  assert.match(text, /Never dispatch speculatively/);
  assert.match(text, /Verify checks the full plan after the final batch/);
});

// Phase capability is the user's native decision, not MDD's. No packaged phase may ship its own
// permission map: a phase that cannot act is exactly what made the workflow unusable.
for (const role of ['explore', 'propose', 'spec', 'design', 'tasks', 'apply', 'verify']) {
  test(`assets: ${role} ships no permission map and keeps a strict handoff`, () => {
    const text = fs.readFileSync(`assets/opencode/agents/mdd-${role}.md`, 'utf8');
    const front = text.split('---')[1];
    assert.match(front, /\nmode: subagent\n/);
    assert.doesNotMatch(front, /permission|model:|tools:/);
    assert.deepEqual(Object.keys(Object.fromEntries([...front.matchAll(/^\s*("\*"|\w+): (allow|ask|deny)$/gm)].map(m => [m[1], m[2]]))), []);
    // Every actor is told to answer in prose under MDD headings, never as a serialized object.
    assert.match(text, /"## MDD Outcome", "## MDD Summary"/);
    assert.match(text, /"## MDD Artifact"/);
    assert.doesNotMatch(text, /strict result schema|JSON object/);
    assert.match(text, /outcome failed/);
    // One half of the run speaks to the user and the other half speaks to MDD. An actor is on the
    // second half, and a report half-translated into the user's language is worse input, not a
    // courtesy: the coordinator is the one that translates, and it translates whole sections.
    assert.match(text, /Write your report in English/);
    if (['apply', 'verify'].includes(role)) {
      assert.match(text, /not a sandbox/);
      assert.match(text, /commit/);
    }
  });
}

for (const name of ['mdd-pr-body', 'mdd-cleanup', 'mdd-doc', 'mdd-judgment-day', 'mdd-grill']) {
  test(`assets: ${name} trigger metadata, structure and explicit registry`, () => {
    const text = fs.readFileSync(`assets/opencode/skills/${name}/SKILL.md`, 'utf8');
    assert.match(text, new RegExp(`name: ${name}\\n`));
    const description = text.match(/^description: "(.+)"$/m)?.[1];
    assert.ok(description?.startsWith('Trigger:'));
    assert.ok(description.length <= 250);
    assert.match(text, /license: \w+/);
    assert.match(text, /metadata:\n  author: "mdd-maintainers"\n  version: "1.0"/);
    assert.deepEqual([...text.matchAll(/^## (.+)$/gm)].map(m => m[1]).slice(0, 5),
      ['Activation Contract', 'Hard Rules', 'Decision Gates', 'Execution Steps', 'Output Contract']);
    assert.match(fs.readFileSync('AGENTS.md', 'utf8'), new RegExp(`skills/${name}/SKILL.md`));
  });
}

// phaseName accepts only the eight workflow phases. Neither the coordinator nor an actor with a
// configurable model but no stop on the route is a Phase, whatever else it is.
test('phaseName accepts only the eight workflow phases, not configurable standalone actors', () => {
  for (const phase of ['mdd-explore', 'mdd-plan', 'mdd-propose', 'mdd-spec', 'mdd-design', 'mdd-tasks', 'mdd-apply', 'mdd-verify']) {
    assert.equal(phaseName(phase), phase);
  }
  for (const bad of ['orchestrator', 'mdd-risk', 'mdd-security', ...JD_ROLES, 'mdd-unknown', '']) {
    assert.throws(() => phaseName(bad), /Unknown MDD phase/);
  }
});

test('security actor is packaged with deny-all permissions and no standalone dispatch authority', () => {
  assert.ok(MDD_ASSETS.includes('assets/opencode/agents/mdd-security.md'));
  assert.ok(MDD_PACKAGED_ASSETS.includes('assets/opencode/agents/mdd-security.md'));
  const text = fs.readFileSync('assets/opencode/agents/mdd-security.md', 'utf8');
  assert.match(text, /mode: subagent/);
  assert.match(text, /permission:\n {2}"\*": deny/);
  assert.match(text, /authenticated.*dispatch/i);
  assert.match(text, /committed, index, worktree and untracked/);
  assert.match(text, /SQL, command and template injection/);
  assert.match(text, /XSS.*SSRF/);
  assert.match(text, /tenant isolation/);
  assert.match(text, /no-findings.*not.*secure/i);
  assert.match(text, /separate user authorization.*mdd-apply/);
  assert.match(text, /Write your report in English/);
});

test('Judgment Day model roles and installation do not expand phase or report-check membership', () => {
  assert.deepEqual(PHASE_AGENTS, [...PHASES]);
  assert.deepEqual(CHECK_AGENTS, [...PHASES, 'mdd-risk', 'mdd-security']);
  const settings = defaultSettings();
  const config = { agent: {} };
  for (const role of JD_ROLES) {
    assert.ok(MODEL_ROLES.includes(role), role);
    assert.ok(MDD_ASSETS.includes(`assets/opencode/agents/${role}.md`), role);
    assert.equal(PHASES.includes(role), false);
    settings.profiles.default.models[role] = 'provider/judge#high';
    config.agent[role] = { mode: 'subagent', permission: { '*': 'deny', read: 'allow' } };
  }
  applyModelOverrides(config, freezeProfile(settings));
  pinPhaseAgents(config);
  for (const role of JD_ROLES) {
    assert.deepEqual(config.agent[role], { mode: 'subagent', permission: { '*': 'deny', read: 'allow' },
      model: 'provider/judge', variant: 'high' });
  }
  // V2 model selection shares roles, but phase instruction/tool pinning remains a separate list.
  const v2 = fs.readFileSync('src/opencode-v2.ts', 'utf8');
  assert.match(v2, /MODEL_AGENTS = MODEL_ROLES\.filter/);
  assert.match(v2, /PINNED_AGENTS = Object\.freeze\(\[\.\.\.PHASES, 'mdd-risk'\] as const\)/);
});

test('Judgment Day judges share a neutral standalone JSON contract and allow only immutable inspection', () => {
  const bodies = [];
  for (const role of ['mdd-jd-judge-a', 'mdd-jd-judge-b']) {
    const text = fs.readFileSync(`assets/opencode/agents/${role}.md`, 'utf8');
    const front = text.split('---')[1];
    assert.match(front, /\nmode: subagent\n/);
    assert.doesNotMatch(front, /model:|tools:/);
    const permissions = Object.fromEntries([...front.matchAll(/^  ("\*"|\w+): (allow|ask|deny)$/gm)].map(m => [m[1], m[2]]));
    assert.deepEqual(permissions, { '"*"': 'deny', mdd_jd_inspect: 'allow' });
    assert.match(text, /Never use live read\/glob\/grep/);
    assert.match(text, /full lowercase commit object IDs/);
    assert.match(text, /immutable/);
    assert.match(text, /blind/);
    assert.match(text, /frozen ledger/);
    assert.match(text, /fix-caused defects/);
    assert.match(text, /Return one JSON object and no prose/);
    assert.doesNotMatch(text, /mdd_check_report|## MDD Outcome/);
    const example = JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)[1]);
    assert.deepEqual(Object.keys(example), ['findings', 'evidence']);
    assert.deepEqual(Object.keys(example.findings[0]), ['location', 'severity', 'claim', 'evidence_class', 'causal_disposition', 'proof_refs']);
    bodies.push(text.split('---').slice(2).join('---'));
  }
  assert.equal(bodies[0], bodies[1], 'blind judges receive identical criteria and output contracts');
});

test('Judgment Day fix actor requires correction authorization and a bounded severe ledger', () => {
  const text = fs.readFileSync('assets/opencode/agents/mdd-jd-fix.md', 'utf8');
  const front = text.split('---')[1];
  assert.match(front, /\nmode: subagent\n/);
  assert.doesNotMatch(front, /model:|tools:/);
  assert.deepEqual(Object.fromEntries([...front.matchAll(/^  ("\*"|\w+): (allow|ask|deny)$/gm)].map(m => [m[1], m[2]])),
    { '"*"': 'deny', read: 'allow', glob: 'allow', grep: 'allow', edit: 'ask', bash: 'ask' });
  assert.match(text, /explicit correction authorization/);
  assert.match(text, /confirmed severe ledger IDs/);
  assert.match(text, /at most two correction rounds/);
  assert.match(text, /rollback boundary/);
  assert.match(text, /Do not commit, push/);
  assert.match(text, /not a sandbox/);
  assert.doesNotMatch(text, /mdd_check_report|## MDD Outcome/);
});

const jdSkillPath = 'assets/opencode/skills/mdd-judgment-day/SKILL.md';
const jdReferencePath = 'assets/opencode/skills/mdd-judgment-day/references/prompts-and-formats.md';
const jdText = () => fs.readFileSync(jdSkillPath, 'utf8');
const jdReference = () => fs.readFileSync(jdReferencePath, 'utf8');

// These assertions verify shipped instruction contracts, not model compliance or review execution.
test('SA-4: security treats redaction as an assessment limit rather than credential-exposure proof', () => {
  const text = fs.readFileSync('assets/opencode/agents/mdd-security.md', 'utf8');
  assert.match(text, /redaction marker alone is not proof of credential exposure/);
  assert.match(text, /unredacted, runtime-bound evidence/);
  assert.match(text, /redaction or access limits prevent assessment[\s\S]*inconclusive/);
  assert.match(text, /Never claim omitted or redacted material was inspected/);
  assert.match(text, /do not reconstruct secrets or widen live access/);
});

test('SA-4: parent readiness precedes paired dispatch and remains a protocol obligation', () => {
  const skill = jdText(); const reference = jdReference();
  const readiness = reference.slice(reference.indexOf('## Parent readiness before paired dispatch'), reference.indexOf('## Blind foreground dispatch'));
  assert.ok(readiness.length > 0, 'readiness must precede either judge launch');
  for (const pattern of [/local commit objects/, /40 or 64 lowercase/, /1024/, /base-only deletions/, /target-only additions/,
    /all existing relevant sides/, /128 KiB/, /five-second/, /binary/, /invalid UTF-8/, /diff.*output/s,
    /Do not launch either judge/, /never truncate/, /fetch/, /create snapshots/, /execute target code/,
    /parent must not call mdd_jd_inspect/, /already authorized/, /not inspection evidence or approval/,
    /cannot guarantee.*timeout/s, /no structured target input/, /no new manifest or runtime gate/]) assert.match(readiness, pattern);
  assert.match(skill, /Complete parent readiness before paired dispatch/);
  assert.match(skill, /known unavailable.*[\s\S]*escalate/i);
  const prompt = reference.match(/```text\nPerform one blind[\s\S]*?```/)?.[0];
  assert.match(prompt, /Parent readiness is not inspection evidence/);
  assert.match(prompt, /Independently inspect/);
  assert.match(prompt, /residual unavailability/);
});

test('SA-4: identical judges independently report residual unavailable evidence', () => {
  const bodies = ['a', 'b'].map(role => fs.readFileSync(`assets/opencode/agents/mdd-jd-judge-${role}.md`, 'utf8').split('---').slice(2).join('---'));
  assert.equal(bodies[0], bodies[1]);
  for (const pattern of [/Parent readiness is not inspection evidence/, /independently inspect/, /timeout/, /binary/,
    /invalid UTF-8/, /oversized/, /incomplete or unavailable/, /only successful reads/, /never partial output/,
    /commit, path, side and failed operation/, /Do not substitute live reads/]) assert.match(bodies[0], pattern);
});

test('SA-4: fix instructions separate runtime admission from ledger, path and consent obligations', () => {
  const fix = fs.readFileSync('assets/opencode/agents/mdd-jd-fix.md', 'utf8');
  for (const text of [fix, jdReference()]) {
    for (const pattern of [/Runtime admission/, /tool categories/, /protocol obligations/,
      /consent, severe ledger IDs, allowed edit paths and the two-round limit/,
      /not mechanically validated/, /not a path sandbox/]) assert.match(text, pattern);
  }
  assert.match(fix, /Do not interpret admission or native tool permission as correction consent/);
  assert.match(fix, /return a blocked handoff/);
});

test('SA-4: adapter guide discloses readiness and redaction limits without promising model behavior', () => {
  const text = fs.readFileSync('docs/opencode-adapter.md', 'utf8');
  assert.match(text, /Redaction alone does not prove credential exposure/);
  assert.match(text, /Parent readiness before paired dispatch/);
  assert.match(text, /no structured target input/);
  assert.match(text, /not inspection evidence or approval/);
  assert.match(text, /protocol obligations,\s+not mechanically validated/);
  assert.match(text, /not live-model behavior/);
});

test('Judgment Day routing is explicit, namespaced and precedes generic phase routing within the size cap', () => {
  const text = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8');
  assert.match(text, /Standalone override:.*explicit request/);
  for (const trigger of ['judgment-day', 'judgment day', 'judment-day']) assert.ok(text.includes(trigger));
  assert.match(text, /skills\/mdd-judgment-day\/SKILL\.md/);
  assert.ok(text.indexOf('Standalone override:') < text.indexOf('Information-only requests'));
  assert.ok(text.indexOf('Standalone override:') < text.indexOf('Fresh implementation, including precise edits'));
  assert.match(text, /no mdd_start or automatic review after Verify/);
  assert.match(text, /instead of phase\/status routing/);
  assert.match(text, /exceptions to phase-only dispatch/);
});

test('Judgment Day protocol is self-contained and preserves snapshot, blindness, causality and authorization gates', () => {
  const skill = jdText(); const reference = jdReference();
  assert.ok(MDD_ASSETS.includes(jdSkillPath)); assert.ok(MDD_ASSETS.includes(jdReferencePath));
  assert.match(skill, /\[.*\]\(references\/prompts-and-formats\.md\)/);
  assert.ok(Buffer.byteLength(skill) < 6000, 'keep the protocol detail in its local reference');
  for (const text of [skill, reference]) {
    assert.match(text, /explicit user request/);
    assert.match(text, /dirty\/untracked/);
    assert.match(text, /separately authorized.*snapshot/s);
    assert.match(text, /both fresh results/);
    assert.match(text, /two native.*one response/s);
    assert.match(text, /standards by value/);
    assert.match(text, /at most two correction/);
    assert.match(text, /live.*workflow.*ownership/s);
    assert.match(text, /no receipt or delivery authority/i);
  }
  assert.match(reference, /CRITICAL.*ERROR/);
  assert.match(reference, /WARNING.*SUGGESTION/);
  assert.match(reference, /suspect/);
  assert.match(reference, /contradiction/);
  assert.match(reference, /uncertain/);
  assert.match(reference, /introduced/);
  assert.match(reference, /independent ordinary verifier/);
  assert.match(reference, /not model-run proof/);
  assert.match(reference, /128 KiB.*five seconds/s);
  assert.match(reference, /40 or 64 lowercase/);
  assert.match(reference, /Never ask judges to read skills/);
  assert.match(reference, /no background, sessionID or inline model/);
  assert.match(reference, /no refuter or RDD dependency/i);
  for (const role of JD_ROLES) assert.ok(reference.includes(role), role);
  assert.doesNotMatch(skill + reference, /\.\.\/_shared|review-ledger-contract\.md|receipt-driven.*required/i);
});

test('both judge assets consume parent-loaded standards only and share the strict neutral result contract', () => {
  const examples = [];
  for (const role of ['mdd-jd-judge-a', 'mdd-jd-judge-b']) {
    const text = fs.readFileSync(`assets/opencode/agents/${role}.md`, 'utf8');
    assert.match(text, /parent loads matching project skills/);
    assert.match(text, /standards by value with path provenance/);
    assert.match(text, /Never read SKILL\.md/);
    assert.doesNotMatch(text, /inspect their exact committed paths|Load applicable skills|Read matching skills/);
    const example = JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)[1]);
    assert.deepEqual(Object.keys(example.evidence), ['target', 'scope', 'standards', 'status', 'inspected', 'limitations']);
    examples.push(example);
  }
  assert.deepEqual(examples[0], examples[1]);
});

// Exercise the shipped parent-only validation recipe, not an LLM or a native review launch.
function judgeValidator() {
  const code = jdReference().match(/```javascript\n([\s\S]*?)\n```/)[1];
  return new Function(`${code}\nreturn validateJudgeResult;`)();
}
function judgeFixture() {
  const target = { base: '1'.repeat(40), commit: '2'.repeat(40) };
  const expected = { target, scope: ['src/example.ts'], standards: ['AGENTS.md#sha256:' + 'a'.repeat(64)] };
  const result = { findings: [], evidence: { ...structuredClone(expected), status: 'complete', inspected: [
    { operation: 'diff', commit: target.commit, base: target.base, path: 'src/example.ts' },
    { operation: 'blob', commit: target.commit, path: 'src/example.ts' },
  ], limitations: [] } };
  return { expected, result };
}

test('parent JSON validation accepts complete neutral results and committed severe proof without granting a verdict', () => {
  const validate = judgeValidator(); const { expected, result } = judgeFixture();
  assert.deepEqual(validate(JSON.stringify(result), expected), result);
  result.findings.push({ location: 'src/example.ts:3', severity: 'ERROR', claim: 'Introduced null dereference.',
    evidence_class: 'deterministic', causal_disposition: 'introduced', proof_refs: [`${expected.target.commit}:src/example.ts:3`] });
  assert.deepEqual(validate(JSON.stringify(result), expected), result);
  for (const role of ['mdd-jd-judge-a', 'mdd-jd-judge-b']) {
    const example = JSON.parse(fs.readFileSync(`assets/opencode/agents/${role}.md`, 'utf8').match(/```json\n([\s\S]*?)\n```/)[1]);
    assert.deepEqual(validate(JSON.stringify(example), example.evidence), example);
  }
});

for (const [name, mutate] of Object.entries({
  'unknown top-level field': r => { r.verdict = 'APPROVED'; },
  'missing findings': r => { delete r.findings; },
  'unknown evidence field': r => { r.evidence.complete = true; },
  'missing inspection': r => { r.evidence.inspected = []; },
  'tree-only source proof': r => { r.evidence.inspected[1].operation = 'tree'; },
  'wrong target': r => { r.evidence.target.commit = '3'.repeat(40); },
  'omitted scope': r => { r.evidence.scope = []; },
  'different standards': r => { r.evidence.standards = []; },
  'unavailable inspection': r => { r.evidence.status = 'unavailable'; },
  'incomplete inspection': r => { r.evidence.status = 'incomplete'; },
  'hidden limitations': r => { r.evidence.limitations = ['Source was unreadable.']; },
  'unsafe path': r => { r.evidence.inspected[1].path = '../outside'; },
  'ref rather than full object': r => { r.evidence.inspected[1].commit = 'HEAD'; },
  'wrong diff base': r => { r.evidence.inspected[0].base = '4'.repeat(40); },
  'incomplete finding': r => { r.findings = [{ severity: 'ERROR' }]; },
  'unread claimed proof': r => { r.findings = [{ location: 'src/example.ts:3', severity: 'ERROR', claim: 'Bad behavior.',
    evidence_class: 'deterministic', causal_disposition: 'introduced', proof_refs: [`${'3'.repeat(40)}:src/example.ts:3`] }]; },
  'out-of-scope finding': r => { r.findings = [{ location: 'src/other.ts:3', severity: 'ERROR', claim: 'Bad behavior.',
    evidence_class: 'inference', causal_disposition: 'uncertain', proof_refs: [`${r.evidence.target.commit}:src/example.ts:3`] }]; },
})) {
  test(`parent JSON validation refuses ${name} instead of accepting a clean judgment`, () => {
    const validate = judgeValidator(); const { expected, result } = judgeFixture();
    assert.deepEqual(validate(JSON.stringify(result), expected), result);
    mutate(result);
    assert.throws(() => validate(JSON.stringify(result), expected));
  });
}
test('parent JSON validation rejects markdown, malformed JSON and duplicate members, including escaped names', () => {
  const { expected, result } = judgeFixture(); const json = JSON.stringify(result); const validate = judgeValidator();
  for (const raw of ['{}', '{broken', `\`\`\`json\n${json}\n\`\`\``, json.replace('"findings":[]', '"findings":[],"findings":[]'),
    json.replace('"findings":[]', '"findings":[],"find\\u0069ngs":[]'),
    json.replace('"status":"complete"', '"status":"unavailable","status":"complete"')]) assert.throws(() => validate(raw, expected));
});

test('parent JSON validation supports full SHA-256 targets and base-only deleted source without issuing a verdict', () => {
  const { expected, result } = judgeFixture();
  expected.target = { base: 'a'.repeat(64), commit: 'b'.repeat(64) };
  result.evidence.target = expected.target;
  result.evidence.inspected[0] = { operation: 'diff', ...expected.target, path: expected.scope[0] };
  result.evidence.inspected[1].commit = expected.target.base;
  assert.deepEqual(judgeValidator()(JSON.stringify(result), expected), result);
  assert.equal(Object.hasOwn(result, 'verdict'), false);
});

// mdd-risk ships the same handoff discipline as every other actor: no baked-in permission map,
// grounded evidence instead of a schema it could fill with inventions, and the English protocol.
test('assets: mdd-risk ships no permission map, demands grounded evidence and keeps a strict handoff', () => {
  const text = fs.readFileSync('assets/opencode/agents/mdd-risk.md', 'utf8');
  const front = text.split('---')[1];
  assert.match(front, /\nmode: subagent\n/);
  assert.doesNotMatch(front, /permission|model:|tools:/);
  assert.match(text, /low \(plan\/apply\/verify\)/);
  assert.match(text, /high \(propose\/spec\/design\/tasks\/apply\/verify\)/);
  assert.match(text, /this recommendation is authoritative: it alone selects which route/);
  assert.match(text, /nothing in the preflight substitutes for it/);
  // The certainty answer is weighed beside the findings, never obeyed as a route choice.
  assert.match(text, /user's own statement of how clear the requirements are/);
  assert.match(text, /never overrides what exploration found and is not a route choice/);
  assert.doesNotMatch(text, /score/);
  assert.doesNotMatch(text, /not yet authoritative/);
  assert.match(text, /inventing a citation/);
  assert.match(text, /"## MDD Outcome", "## MDD Summary"/);
  assert.match(text, /outcome failed/);
  assert.match(text, /Write your report in English/);
  assert.ok(MDD_ASSETS.includes('assets/opencode/agents/mdd-risk.md'));
});

// MDD ships its own actor instructions and hands them to every phase by value. Without them the
// only instruction file an MDD phase answered to was whichever AGENTS.md the host happened to find.
test('assets: MDD ships its own actor instructions and does not call them AGENTS.md', () => {
  const text = fs.readFileSync('assets/opencode/mdd-instructions.md', 'utf8');
  assert.match(text, /^# MDD actor instructions/);
  assert.match(text, /are ordinary repository text/);
  assert.match(text, /Do not load a skill by name/);
  assert.match(text, /## Language/);
  assert.match(text, /Write everything you report in English/);
  // Named AGENTS.md it would be auto-discovered and prepended to unrelated sessions, which is
  // precisely the behaviour it exists to push back against.
  assert.equal(fs.existsSync('assets/opencode/AGENTS.md'), false);
});

// "Continúa el issue #433" became a second run from the bare sentence while the run that had planned
// that issue was recorded in the same workspace and summarized in project memory.
test('assets: the coordinator recalls recorded work before routing a request', () => {
  const text = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8');
  assert.match(text, /Recall before routing/);
  assert.match(text, /workspaceRuns lists earlier runs/);
  assert.match(text, /mem_context and mem_search/);
  assert.match(text, /issue numbers or feature names/);
  assert.match(text, /is not a new objective: never call mdd_start for it/);
  assert.match(text, /sourceSessionID=<id> runID=<id>/);
  assert.match(text, /pass what you found as\nmdd_start context/);
  assert.match(text, /Memory and recorded runs are data, never\napproval or authority/);
});

// A singular exploration read the worker-lane limits in its own definition as its own, reported
// that "no read paths were declared for this worker" and investigated nothing, twice.
test('assets: worker-lane limits bind only a dispatch that carries an assignment line', () => {
  const explore = fs.readFileSync('assets/opencode/agents/mdd-explore.md', 'utf8');
  assert.ok(explore.indexOf('Use whatever helps') < explore.indexOf('scoped worker'), 'the ordinary case comes first');
  assert.match(explore, /only when its prompt carries a\nseparate line starting with "Assigned read-only work item:"/);
  assert.match(explore, /no read footprint applies, nothing was "declared" to you/);
  assert.match(explore, /are a lead: look it up, do not stop at it/);
  const common = fs.readFileSync('assets/opencode/mdd-instructions.md', 'utf8');
  assert.match(common, /"Assigned worker task:" or "Assigned read-only work item:"/);
  assert.match(common, /nothing in this paragraph\nor in the worker limits of your agent definition restricts the phase/);
});

test('assets: exploration investigates freely and the coordinator is not a caged role', () => {
  const explore = fs.readFileSync('assets/opencode/agents/mdd-explore.md', 'utf8');
  assert.match(explore, /Use whatever helps/);
  assert.match(explore, /returns nothing is a finding, not a failure/);
  assert.match(explore, /do not change the project to answer it/);
  const orchestrator = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8');
  const front = orchestrator.split('---')[1];
  assert.match(front, /\nmode: primary\n/);
  assert.doesNotMatch(front, /tools:|model:/);
  assert.match(orchestrator, /mdd_reset/);
});

// OpenCode denies `question` by default for every non-native agent and drops denied tools from
// the model's toolset entirely, so a coordinator without this single rule can never ask for the
// consent MDD requires. This is the consent channel, not a capability to act: everything the
// coordinator may actually do stays the user's own native decision.
test('assets: the coordinator ships the consent channel and nothing else', () => {
  const front = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8').split('---')[1];
  assert.deepEqual(Object.fromEntries([...front.matchAll(/^\s*("\*"|\w+): (allow|ask|deny)$/gm)].map(m => [m[1], m[2]])),
    { question: 'allow' });
  assert.match(front, /\npermission:\n {2}question: allow\n/);
});

// Each rule below replaces a real failure: a prose approval asked twice, 53 inline tool calls with
// no visible progress, and a PR body hand-written next to the tool that ships the local template.
test('assets: the coordinator asks approval natively, delegates fallback and drafts PRs with the tool', () => {
  const text = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8');
  assert.match(text, /Never end a phase report with an approval question of your own/);
  assert.match(text, /only approval is the native question[\s\S]*same turn as the report/);
  assert.match(text, /A message the\s+user wrote before the question was shown approves nothing/);
  // A person who answered the shown question in their own words has answered it; MDD checks it.
  assert.match(text, /Record that with mdd_answer/);
  assert.match(text, /Never use it to skip asking/);
  assert.match(text, /one tracked fallback: explore for/);
  assert.match(text, /Never do\n  substantive phase work in this conversation/);
  assert.match(text, /call mdd_pr_body with the user's exact latest text; do not hand-write one/);
  // A quick edit records no run, and its PR was left unopened because the body tool refused it.
  assert.match(text, /Without a recorded run\n\(a quick edit\), pass baseRef, the PR target branch/);
  assert.match(text, /one reason per listed file, never invented checks/);
});

// MDD asks its questions in Spanish and its actors answer in English, so the coordinator sits on
// the seam. Leaving that unsaid is how a Spanish installation kept reporting its results in the
// language of the subagent that happened to produce them.
test('regression: clarification shipped coordinator requires Spanish visible tool prose and English artifacts', () => {
  const text = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8');
  assert.match(text, /User-visible question text, option labels and descriptions must be Spanish/);
  assert.match(text, /including inside mdd_prepare_advance and native question tool arguments/);
  assert.match(text, /Technical artifacts, phase task prompts, phase reports and protocol keys remain English/);
  assert.doesNotMatch(text, /tool\narguments and tool payloads are English/);
});

test('assets: the coordinator writes to the user in Spanish and keeps the protocol in English', () => {
  const text = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8');
  assert.match(text, /Write to the user in Spanish, always/);
  assert.match(text, /Technical artifacts, phase task prompts, phase reports and protocol keys remain English/);
  assert.match(text, /translate its prose into Spanish and keep\nits structure exactly/);
  assert.match(text, /quoted verbatim and never translated/);
});

// The record of what MDD does badly only works if both halves are reachable: the one that writes
// an entry when the user says so, and the one that finds them again later.
test('assets: the coordinator records improvements and reviews them without starting a run', () => {
  const text = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8');
  assert.match(text, /call mdd_improve with their actual latest\nnative text/);
  assert.match(text, /Recording is not fixing/);
  assert.match(text, /call\nmdd_improvements and present the returned report as it is/);
  assert.match(text, /never turn a review into a run/);
});

// A user answered an approval question in their own words and the run was thrown away; the
// coordinator also needs to know it may ask its own questions, and when it may not.
test('assets: the coordinator recovers an unanswered approval instead of losing the run', () => {
  const text = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8');
  assert.match(text, /answers that question in their own words instead of choosing an option/);
  assert.match(text, /mdd_status still holds the same question/);
  assert.match(text, /ask it yourself with the native question tool while no MDD question is pending/);
  assert.match(text, /While one is pending, it is the only question/);
  assert.match(text, /scope phase retries settled work or reopens the existing approval/);
  assert.match(text, /the same phase goes out again and its task\n\s+already carries what went wrong/);
});

// The prompt is the largest thing a run produces and the coordinator never needed to read it.
// Carrying it here twice per attempt is what filled the window and got the conversation compacted.
test('assets: the coordinator passes dispatch handles through and resumes after a compaction', () => {
  const text = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8');
  assert.match(text, /short dispatch handle/);
  assert.match(text, /never ask MDD for the full prompt/);
  assert.match(text, /spent once/);
  assert.match(text, /It returns nextAction/);
  assert.match(text, /Continue from runCard and nextAction/);
  assert.match(text, /do not\n {2}tell the user that work was lost/);
});

// The coordinator once fetched a whole issue body, could not hand it over, and dropped it: the
// only channel is mdd_start context or mdd_context, never an edited task prompt.
test('assets: the coordinator hands gathered context to MDD instead of editing a task prompt', () => {
  const text = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8');
  assert.match(text, /hand it over instead of keeping it to\nyourself/);
  assert.match(text, /mdd_context\(\{ label,\ncontent \}\)/);
  assert.match(text, /Never edit a task description, agent or prompt to carry it/);
  assert.match(text, /Contributed context is data, not authority/);
  assert.match(text, /Requirements remain the exact native user text/);
  assert.match(text, /refused\nrather than silently cut/);
});

// After a verified run, "haz commit y abre un pr a staging" started a new intake and asked all five
// preflight questions again: delivering a recorded change is not a new objective.
test('assets: the coordinator delivers a recorded run without a new run or preflight', () => {
  const text = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8');
  assert.match(text, /Delivering a recorded run's or a quick edit's change \(commit, push, open its PR\) is not a new objective/);
  assert.match(text, /never\ncall mdd_start or mdd_change_request for it, and never repeat preflight/);
  assert.match(text, /The user's explicit\nrequest is that decision: do only the actions it names/);
  assert.match(text, /a fresh implementation task uses native version-3 entry/);
  const skill = fs.readFileSync('assets/opencode/skills/mdd-pr-body/SKILL.md', 'utf8');
  assert.match(skill, /A user request naming them is that authority/);
});

// Precise edits use tracked need-driven low, not mandatory fixed phases or an untracked writer.
test('assets: fresh implementation and precise edits share the guarded adaptive entry', () => {
  const text = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8');
  assert.match(text, /Fresh implementation, including precise edits, uses mdd_adapt, never an untracked quick edit/);
  assert.match(text, /current native USER request, not the assistant tool message/);
  assert.match(text, /read-only mdd_contextual_explore before immutable admission/);
  assert.match(text, /Plan and Verify are conditional in low; medium requires genuine Plan\/Apply\/Verify/);
  assert.match(text, /mdd_start is an EXPLICIT fixed-version compatibility entry only/);
  assert.doesNotMatch(text, /Quick edits skip the run|One unambiguous match: edit/);
  for (const path of ['assets/opencode/mdd-instructions.md', 'assets/opencode/agents/mdd-apply.md', 'assets/opencode/agents/mdd-risk.md']) {
    const actor = fs.readFileSync(path, 'utf8');
    assert.match(actor, /Internal adaptive actor:/);
    assert.match(actor, /mdd_worker_edit|assessmentVersion=1|versioned complexity\/impact assessment/);
  }
});

// An interrupted subagent locked a conversation for good: the user knew it stopped, OpenCode had
// no trace proving it, and the coordinator was told no reset could ever pass.
test('assets: the coordinator releases an interrupted subagent on the user\'s own word', () => {
  const text = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8');
  assert.match(text, /status\.liveness says what OpenCode sees/);
  assert.match(text, /call\nmdd_reset once with userText equal to their exact latest message/);
  assert.match(text, /releases it unless OpenCode reports it busy/);
  assert.doesNotMatch(text, /refuses while termination remains unknown/);
});

test('assets: mdd-doc shapes prose only and never widens a read-only phase', () => {
  const text = fs.readFileSync('assets/opencode/skills/mdd-doc/SKILL.md', 'utf8');
  assert.match(text, /never\n?changes the result schema/);
  assert.match(text, /Acceptance and plan links/);
  assert.match(text, /Do not propose, quote or imply running commands/);
  assert.match(text, /cognitive-doc-design.*gentleman-programming/s);
  // Injected into read-only phases: it must not name a command runner or a delivery verb.
  assert.doesNotMatch(text, /\b(gh|git|npm|curl|bash) \w/);
  assert.ok(Buffer.byteLength(text) < 6000, 'stays a small share of the phase context budget');
});

// Shipped verbatim on purpose: it is upstream Apache-2.0 material, and the whole point of carrying
// it by value is that the text a phase reads is this one rather than whatever else owns that name.
test('assets: cognitive-doc-design stays verbatim upstream, attributed, and is never installed', () => {
  const text = fs.readFileSync('assets/opencode/skills/cognitive-doc-design/SKILL.md', 'utf8');
  assert.match(text, /^---\nname: cognitive-doc-design\n/);
  assert.match(text, /license: Apache-2\.0/);
  assert.match(text, /author: gentleman-programming/);
  assert.match(text, /## Critical Patterns/);
  assert.ok(Buffer.byteLength(text) < 6000, 'stays a small share of the phase context budget');
  const notice = fs.readFileSync('assets/opencode/skills/cognitive-doc-design/NOTICE', 'utf8');
  assert.match(notice, /Apache License, Version 2\.0/);
  assert.match(notice, /redistributed verbatim/);
  // Installing it would either overwrite a copy the user already keeps under that name or be
  // refused by setup, which is why it is packaged and injected instead.
  assert.equal(MDD_ASSETS.some(name => name.includes('cognitive-doc-design')), false);
  for (const name of ['assets/opencode/skills/cognitive-doc-design/SKILL.md', 'assets/opencode/skills/cognitive-doc-design/NOTICE']) {
    assert.ok(MDD_PACKAGED_ASSETS.includes(name), name);
  }
  assert.match(fs.readFileSync('AGENTS.md', 'utf8'), /skills\/cognitive-doc-design\/SKILL\.md/);
});

// A large, undecided request used to reach admission with one batch of at most eight product
// questions, and the contract froze whatever that batch could not settle. The session runs before
// the contract exists, through the native question tool, because entry binds the latest user text.
// These assertions check shipped instructions, not model adherence or a native E2E run.
test('assets: mdd-grill offers a pre-admission question session with optional documentation', () => {
  const skill = fs.readFileSync('assets/opencode/skills/mdd-grill/SKILL.md', 'utf8');
  const flat = skill.replace(/\s+/g, ' ');
  for (const name of ['assets/opencode/skills/mdd-grill/SKILL.md', 'assets/opencode/skills/mdd-grill/NOTICE']) {
    assert.ok(MDD_ASSETS.includes(name), name);
  }
  assert.ok(Buffer.byteLength(skill) < 6000, 'stays a small share of the coordinator context');
  for (const pattern of [/before the first `mdd_adapt` entry of a fresh implementation request/,
    /complexity or impact `high` for a new capability/, /more than three `productQuestions` or `context\.technical: "uncertain"`/,
    /explicit user request to be grilled or questioned first/, /native question tool in this same turn/,
    /entry binds the latest native user message/, /grants no mode, approval, operation consent or implementation authority/,
    /writes no file/, /never ask the user for it/, /never ask while a task is in flight/,
    /Declining or cancelling leaves the ordinary entry and its `productQuestions` unchanged/,
    /`Sesión de preguntas`, `Sesión con documentación` .* `Seguir sin sesión`/, / \(Recomendada\)/,
    /design tree/, /frontier is empty/, /`Confirmar y seguir`, `Corregir algo` or `Cancelar`/,
    /only after confirmation/, /`decisions\[\]`/, /`exclusions\[\]`/, /`acceptance\.requirements\[\]\.scenarios`/,
    /24000-byte budget/, /hard to reverse, surprising without context and the result of a real trade-off/,
    /Apply writes, Verify checks/, /When nothing qualifies, create nothing/,
    /no active MDD run in this conversation; a closed one is fine/, /MDD refuses questions it did not issue while a run is active/,
    /A session question is refused \| Stop without retrying or rephrasing; continue with the ordinary entry/,
    /latest 100 native messages/]) assert.match(flat, pattern);
  // The adapter suffixes recommended clarification options this way; the coordinator matches it.
  assert.doesNotMatch(skill, /\(Recomendado\)/);
  const notice = fs.readFileSync('assets/opencode/skills/mdd-grill/NOTICE', 'utf8');
  assert.match(notice, /MIT License/);
  assert.match(notice, /Copyright \(c\) 2026 Matt Pocock/);
  assert.match(notice, /The above copyright notice and this permission notice shall be included/);
  assert.match(notice, /not a verbatim copy/);
  const coordinator = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8').replace(/\s+/g, ' ');
  assert.match(coordinator, /Grilling offer: before the first mdd_adapt entry of a fresh request/);
  assert.match(coordinator, /load the installed skills\/mdd-grill\/SKILL\.md by exact path/);
  assert.match(coordinator, /offers the session once, in either mode; declining keeps the ordinary entry unchanged/);
  assert.match(coordinator, /native question tool in this same turn, because entry binds the latest native user message/);
  assert.match(coordinator, /never mode, approval or operation consent/);
  assert.match(coordinator, /Only while this conversation holds no active MDD run, a closed one being fine; a refused session question ends the session without retry/);
  assert.ok(coordinator.indexOf('Grilling offer:') > coordinator.indexOf('Fresh implementation, including precise edits'));
  const guide = fs.readFileSync('docs/opencode-adapter.md', 'utf8').replace(/\s+/g, ' ');
  assert.match(guide, /### Question session before admission/);
  assert.match(guide, /not measured model compliance; model-backed E2E is pending/);
});

// The body is read by a reviewer, so it is Spanish like every other user-facing surface, and the
// Changes section leads with a table because a list of paths repeats what the diff already says.
test('assets: PR template consistently retains all seven sections and the per-file table', () => {
  const text = fs.readFileSync('assets/opencode/skills/mdd-pr-body/assets/template.md', 'utf8');
  assert.deepEqual([...text.matchAll(/^## (.+)$/gm)].map(m => m[1]),
    ['Resumen', 'Cambios', 'Verificación', 'Variables de entorno', 'Seguimiento', 'Bloqueos', 'Despliegue']);
  assert.equal(text.match(/No aplica\./g).length, 4);
  assert.match(text, /\| Archivo \| Por qué cambió \|/);
  const skill = fs.readFileSync('assets/opencode/skills/mdd-pr-body/SKILL.md', 'utf8');
  assert.match(skill, /The body is written in Spanish/);
  assert.match(skill, /one table row per changed file/);
  // Check evidence under its own heading: appended to Cambios it denied the table above it.
  assert.match(skill, /Verification prose belongs here and never under `Cambios`/);
  // Translated before rendering, because recorded prose is English and the reviewer is not.
  assert.match(skill, /drafting takes two calls/);
  // The draft-only notice said something about MDD's permissions, not about the change.
  assert.match(skill, /Never add a notice saying the body is only a draft/);
});

// Setup refuses to install a package that does not match its assets, but nothing checked the
// other direction while a run was live: an upgraded plugin next to an agent definition from an
// older release is a coordinator reading instructions this adapter no longer speaks.
test('assets: an installed actor definition that differs from the running package is named', async t => {
  const { staleAssets } = await import('../dist/project-assets.js');
  const home = fs.mkdtempSync(join(tmpdir(), 'mdd-stale-assets-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const environment = { home, env: {} };
  const agents = join(home, '.config', 'opencode', 'agents');
  fs.mkdirSync(agents, { recursive: true });
  // Nothing installed proves nothing: running from source is ordinary, and installing is setup's job.
  assert.deepEqual(staleAssets(environment), []);
  fs.copyFileSync('assets/opencode/agents/mdd-plan.md', join(agents, 'mdd-plan.md'));
  assert.deepEqual(staleAssets(environment), []);
  fs.writeFileSync(join(agents, 'mdd-orchestrator.md'), '---\nmode: primary\n---\n\nAn older release.\n');
  assert.deepEqual(staleAssets(environment), ['agents/mdd-orchestrator.md']);
});
