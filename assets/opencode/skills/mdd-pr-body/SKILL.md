---
name: mdd-pr-body
description: "Trigger: user PR request, pull request body. Draft an evidence-backed MDD PR description without granting push or PR creation authority."
license: MIT
metadata:
  author: "mdd-maintainers"
  version: "1.0"
---

## Activation Contract

Load when the user requests a PR or PR body. Draft only for the authorized change.

## Hard Rules

- Separate drafting from permission to commit, push or create a PR; obtain explicit authority for those actions.
- Use observed changes and verification evidence. Never invent tests, deployments, configuration or issue links.
- Keep all six template headings in order. Write `Not applicable.` for absent optional information; label unknown facts as unverified.
- Do not include credentials, private source excerpts or unrelated work.

## Decision Gates

| Evidence | Action |
|---|---|
| Checks executed | Give exact commands and outcomes under Changes. |
| Checks missing or failing | State limitations under Blockers; do not claim readiness. |
| No environment or deployment changes | Use Not applicable. in the respective section. |

## Execution Steps

1. Read the authorized scope, actual diff and available check results.
2. Fill the local template, distinguishing shipped behavior from follow-ups.
3. Check that each claim is supported and blockers are visible.
4. Return the draft; execute publication only with separate explicit authority and native consent.

## Output Contract

Return a concise Markdown body with Summary, Changes, Environment variables, Follow-ups,
Blockers and Deployment. Keep evidence under Changes and never imply drafting published it.

## References

- [PR body template](assets/template.md)
