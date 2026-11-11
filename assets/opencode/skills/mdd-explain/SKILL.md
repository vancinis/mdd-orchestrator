---
name: mdd-explain
description: "Trigger: explicit request for a readable explanation artifact (HTML) of current behavior, a plan or a before/after. Delegates to native general."
license: MIT
metadata:
  author: "mdd-maintainers"
  version: "1.0"
---

## Activation Contract

Load only when the user explicitly asks for an explanation as an artifact or HTML page. Ordinary
questions stay in chat. It creates no run and replaces neither `mdd-doc` nor run reports.
You are the **caller** unless your prompt has a handoff with `skill:` and `output:`; then you are the **writer**.

## Hard Rules

- Write only `.mdd/artifacts/<topic>/index.html`, or `.mdd/runs/<run-id>/artifacts/<topic>/index.html`
  when the user names that run or clearly means it and `.mdd/runs/<run-id>.md` exists. Never edit sources, run files, other artifacts or configuration;
  sole exception: the caller creates a new `.mdd/` with `.mdd/.gitignore` (`*`) before dispatch.
- Fresh output takes a free `<topic>`, `<topic>-2`, `-3`; `replace: yes` keeps the exact file the user
  asked to replace; a fix edits this request's own output. Overwrite nothing else. The writer rechecks the target right before writing. Inspect every
  existing path component (`.mdd`, `artifacts`, run, topic); stop on a symlink and never write through one.
- A writer never delegates again; only the caller dispatches.
- Ground claims in sources read this session. Label them `Observado`, `Propuesto` or `Supuesto`; never present a proposal as implemented.
- Output is one HTML file built from `assets/template.html`: keep its Content-Security-Policy
  meta tag, inline CSS and SVG. Load nothing remote: no scripts, fonts, images, embeds, `ping`,
  `<base>`, refresh or auto-navigation. A small `data:` image with alt text is optional.
- `href` is `#id` or an `https://` URL you confirmed this session, with a label that names the
  destination. Never use credentials in URLs. `target="_blank"` needs `rel="noopener noreferrer"`.
  Links are click-only: the page reads fully offline.
- Write for understanding in the user's language (Spanish by default). Assume no specialist
  knowledge unless the user says otherwise. Give the everyday meaning before any identifier,
  use short direct sentences, and put the answer first and theory in `<details>`.
- Research commands are read-only. Never change repositories, services or data.

## Decision Gates

| Situation | Action |
|---|---|
| Explains how it works now | mode `actual` |
| Explains a plan or proposal | mode `propuesta` |
| Compares two states | mode `antes-despues`: one scenario, same steps |
| No audience stated | Reader with no specialist knowledge |
| Asks what or how to do | Action guide: first action on top; each step gives where, action, visible success and next or stop; invent none |
| Asks how it works or why | No step list; use a short example walkthrough |
| Handoff has `style:` | Copy that approved file's `<style>` byte for byte; use its classes |
| Sources contradict the premise | Explain the verified correction; mark only what stays uncertain `Supuesto` |
| No subagent tool | Do both roles; say so |
| Unclear consent, ownership or setup | Stop; report it |

## Execution Steps

1. **Caller:** settle mode, audience, a topic slug and the target. Initialize `.mdd/` only if new.
2. **Caller:** dispatch native `general` with the handoff fields in the reference.
3. **Writer:** read this skill, the reference and the template, then the leads.
4. **Writer:** run `git rev-parse --short HEAD` and `git status --short` for the snapshot (`sin Git` if absent).
5. **Writer:** write with the native write tool, read the file back and apply the self-check.
6. **Caller:** review the HTML with the reader checks in the reference. Existence alone is not enough. If a check fails, send the findings and path to the same writer. Then reply.

## Output Contract

- Writer returns: path, mode, sources read, `Supuesto` claims, self-checks run, links verified, `delegated: no`.
- Caller replies in at most 3 lines: the path and the limits, not the explanation.
- Only a run owner may add one Log line linking its run's artifact.

## References

- [authoring.md](references/authoring.md)
- [template.html](assets/template.html)
