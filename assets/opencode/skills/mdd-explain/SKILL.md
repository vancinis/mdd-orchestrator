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
  when the user names that run or clearly means it and `.mdd/runs/<run-id>.md` exists. Never edit sources, run files, other artifacts or configuration.
- Never overwrite: if the target exists, use `<topic>-2`, `-3`. Use `replace` only when the user asked
  to replace that exact file. The writer rechecks the target right before writing. Inspect every
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
| Audience not stated | A reader with no specialist knowledge of the project |
| Asks what or how to do | Action guide: first action on top; each step gives where, action, visible success and next or stop; invent none |
| Asks how it works or why | No step list; use a short example walkthrough |
| Handoff has `style:` | Copy that approved file's `<style>` byte for byte; use its classes |
| Sources contradict the premise | Explain the verified correction; mark only what stays uncertain `Supuesto` |
| No subagent tool | Write it yourself; say so |

## Execution Steps

1. **Caller:** settle mode, audience, a topic slug and a free path. Check that the path does not exist.
2. **Caller:** dispatch native `general` with the handoff fields in `references/authoring.md`.
3. **Writer:** read this skill, `references/authoring.md` and `assets/template.html`, then the leads.
4. **Writer:** run `git rev-parse --short HEAD` and `git status --short` for the snapshot (`sin Git` if absent).
5. **Writer:** write the file with the native write tool, then read it back and apply the self-check there.
6. **Caller:** review the HTML with the reader checks in the reference. Existence alone is not enough. If a check fails, send the findings to the same writer. Then reply.

## Output Contract

- Writer returns: path, mode, sources read, `Supuesto` claims, self-checks run, links verified, `delegated: no`.
- Caller replies in at most 3 lines: the path and the limits, not the explanation.
- A run owner may add one Log line linking an artifact of its run.

## References

- [authoring.md](references/authoring.md)
- [template.html](assets/template.html)
