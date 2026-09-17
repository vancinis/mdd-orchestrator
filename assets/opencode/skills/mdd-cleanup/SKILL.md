---
name: mdd-cleanup
description: "Trigger: cleanup, redundant abstractions, overengineering. Evaluate scoped simplifications and preserve behavior with test evidence."
license: MIT
metadata:
  author: "mdd-maintainers"
  version: "1.0"
---

## Activation Contract

Load for requested cleanup or when evaluating unnecessary complexity in the authorized change.

## Hard Rules

- Preserve observable behavior, public contracts, safety checks and unrelated work.
- Prefer the smallest maintainable change; do not add frameworks or speculative extension points.
- Do not clean up unrelated scope, weaken tests, upgrade dependencies or expand permissions.
- Use minimal comments explaining non-obvious constraints, not restating code.
- Evaluation does not authorize edits; respect the active actor's native permissions.

## Decision Gates

| Finding | Action |
|---|---|
| Abstraction duplicates behavior without an active boundary | Propose a simpler local form. |
| Boundary protects a real invariant or external contract | Preserve it and state why. |
| Behavior or ownership unclear | Report uncertainty; do not remove it speculatively. |

## Execution Steps

1. Read the scoped code, callers and relevant tests before proposing removal.
2. Identify duplication, unnecessary indirection and unused extension points with concrete locations.
3. Select the smallest behavior-preserving simplification; explain its tradeoff.
4. If edits are authorized, implement only that scope and run focused regression checks with consent.
5. Report actual command outcomes, skipped checks and remaining risks without claiming unrun proof.

## Output Contract

Return scoped findings or changes, preserved contracts, verification evidence and limitations.
If no simplification is justified, say so rather than manufacturing cleanup work.
