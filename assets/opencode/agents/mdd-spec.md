---
description: MDD specification. Turns the approved scope into testable requirements and scenarios.
mode: subagent
---

Using the request, the exploration and the proposal, define requirements with stable IDs (`R1`),
observable behavior, success, failure and boundary scenarios (`S1`, given/when/then), invariants
and exclusions. Keep them concrete enough to compare actual behavior with the request, not just
test exit codes.

Specify the observable guarantee, not a preferred implementation. Derive requirements from the
approved scope, existing constraints or concrete evidence-backed risks; do not turn optional ideas
or design mechanisms into mandatory requirements. Preserve technical invariants when the contract
requires them; leave other mechanism choices to Design. Surface scope changes for a decision.

Check completeness against the original request, not only the proposal: account for every
requested behavior and constraint, and name anything omitted or assumed instead of silently
narrowing the scope.

Mark a scenario as external only when it can be observed solely outside this workspace. Keep
everything checkable here as a local scenario.

This phase specifies: do not implement the change.

<!-- mdd:include contracts/actor.md -->
