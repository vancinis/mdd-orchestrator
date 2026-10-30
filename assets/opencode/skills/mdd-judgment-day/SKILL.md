---
name: mdd-judgment-day
description: "Trigger: judgment-day, judgment day, judment-day. Coordinate explicitly requested blind dual review of a committed target."
license: MIT
metadata:
  author: "mdd-maintainers"
  version: "1.0"
---

## Activation Contract

Activate only on an explicit user request for judgment-day, judgment day or judment-day (case-insensitive) on a
concrete target. Mere mentions, ordinary review, implementation and completed Verify do not activate it.
The parent must load this installed skill and its local reference before proceeding. It is not a
run phase and starts no run; it grants no delivery authority.

## Hard Rules

- Freeze the complete committed target, base, exact file inventory, criteria and relevant standards.
  For dirty/untracked target material, stop for a separately authorized immutable snapshot;
  never silently exclude it or create a commit from review consent.
- Complete parent readiness before paired dispatch using the reference: local commit objects,
  supported paths, existing source sides and known size/output bounds. For known unavailable
  material or unconfirmable readiness, escalate without launching judges; readiness is not proof.
- Load matching project skills in the parent; provide identical standards by value with path
  provenance to both judges. Judges inspect only through mdd_jd_inspect, never load skills or run tests.
- Issue two native foreground subagent calls in one response with identical prompts except actor
  identity: mdd-jd-judge-a and mdd-jd-judge-b. Wait for both fresh results; never accept a partial pair.
- Strictly validate the neutral JSON per the reference. Missing, malformed, incomplete or unavailable
  inspection cannot produce APPROVED. Corroborate introduced severe defects; never infer agreement.
- Correct only severe introduced defects confirmed by both, after explicit correction authorization,
  with exact allowed surfaces and one writer. Do not correct files an active MDD run owns.
- Permit at most two correction rounds and two scoped rejudgments over the frozen ledger plus
  immutable fix delta. Never reset the budget or broaden scope to avoid escalation.

## Decision Gates

| Condition | Action |
|---|---|
| Target unclear or snapshot not authorized | Ask one scope/authorization question and stop. |
| Suspect, contradiction, uncertain causality or unavailable proof | Escalate; do not auto-fix. |
| WARNING/SUGGESTION | Record as informational, never correct automatically. |
| Confirmed severe introduced defect | Ask for bounded correction authorization. |
| Unresolved after round two | Escalate and stop. |

## Execution Steps

1. Follow the reference's freeze, readiness, skill-loading, native dispatch and strict validation contracts.
2. Merge both blind results into a stable ledger; corroborate proof and ask before correction.
3. Dispatch mdd-jd-fix only when authorized and no active run owns the files; freeze the complete corrected target.
4. Rejudge with both fresh judges, then obtain separate ordinary functional verification from the
   parent or an independent verifier, never from judges. Unverified material checks block approval.

## Output Contract

Report target, round, confirmed/suspect/contradiction/INFO counts, unresolved evidence, corrections,
verification and artifact references, and skill resolution. Close with exactly one
`JUDGMENT: APPROVED` or `JUDGMENT: ESCALATED`. Neither authorizes commit, push, PR or release.

## References

- [Parent protocol and neutral contracts](references/prompts-and-formats.md) — read before dispatch;
  includes the parent-only validation recipe and bounded correction/rejudgment prompts.
