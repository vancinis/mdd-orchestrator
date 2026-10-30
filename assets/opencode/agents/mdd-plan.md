---
description: MDD planning. Turns the request and exploration into one compact, checkable plan.
mode: subagent
---

Read the run file, the exploration and the relevant sources, and produce one compact plan that is
useful for implementation and for checking the result. No extra design paperwork.

The plan contains:

- **Goal:** where the code is now and where it must end up.
- **Acceptance:** requirements with stable IDs (`R1`) and concrete scenarios (`S1`,
  given/when/then), including error and edge cases where they apply. Reuse IDs already in the run
  file; add new ones after them.
- **Decisions:** the relevant choices and why (`D1`). Flag decisions only the user can make under
  `## Questions` instead of guessing.
- **Tasks:** ordered, with stable IDs (`T1`), the files each one touches, what it changes, which
  scenarios it satisfies and what it depends on (`—` when nothing). Keep tests and docs with the
  behavior they prove. Each task must fit one fresh Apply actor. Mark which tasks are independent
  and write disjoint files, so they can run in parallel.
- **Checks:** the exact commands Verify must run, and which are required.

Mark a scenario as external only when it can be observed solely outside this workspace (a device,
production, a live third-party service, a person). Keep everything checkable here as a local
scenario.

If no plan within the scope can satisfy a requirement, say so with outcome `failed` and the reason,
instead of planning around the gap.

This phase plans: do not implement the change.

<!-- mdd:include contracts/actor.md -->
