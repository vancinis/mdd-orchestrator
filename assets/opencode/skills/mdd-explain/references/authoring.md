# mdd-explain authoring reference

Detail for `SKILL.md`. Read it before dispatching or writing.

## Handoff to native `general`

Send these fields in order:

```text
skill: <absolute path to this SKILL.md>
question: <the user's words, verbatim>
mode: actual | propuesta | antes-despues
audience: <reader and depth>
root: <absolute workspace root>
output: <relative target path: free for fresh output, or the exact approved file when replace: yes>
replace: no | yes
run: .mdd/runs/<run-id>.md | none
leads: <paths or commands to verify before citing>
style: <path of an approved artifact> | template   (optional; default template)
date: YYYY-MM-DD
```

Add a closing line: "You are the writer. Follow the skill, write the file yourself, do not delegate."

With `style:` set to an approved artifact, copy its `<style>` element byte for byte and use only its classes. Keep the template's Content-Security-Policy tag.

The writer returns: path, mode, sources read, `Supuesto` claims, self-checks run, links verified, `delegated: no`.

## Roles and write permissions

| Role | May write | Never |
|---|---|---|
| Caller | Only when `.mdd/` does not exist yet: `.mdd/` and `.mdd/.gitignore` containing `*` (an optional final newline is fine), before dispatch. This is the sole exception to the HTML-only rule. | Recreate an absent ignore file or change any existing one when `.mdd/` already exists; create a run; write through a symlink. |
| Writer | The selected HTML file and the child directories it needs (`artifacts`, topic). | Create or change `.mdd/.gitignore`, run files, sources or configuration; delegate again. |
| Run owner | One optional Log line in its own run file linking an artifact of that run. | Grant that edit to the writer. |

- A named run must already exist (`.mdd/runs/<run-id>.md`); neither role creates one.
- A writer that finds `.mdd/` missing or uninitialized stops and reports it to the caller; it does not
  initialize anything itself.
- Without a subagent tool, the caller initializes first, then writes under the same writer limits.
- If initialization is denied or any existing component is a symlink, stop without writing and report.

## Modes

| Mode | Shows | Rule |
|---|---|---|
| `actual` | How the code behaves now | Every `Observado` claim cites a source read this session. |
| `propuesta` | A plan or proposal | Unbuilt parts are `Propuesto`; only parts proven in the sources are `Observado`. |
| `antes-despues` | One named scenario, two states | Use the same steps in `#comparacion`. Read "Antes" from a named available revision or source (`git show <rev>:<path>`); never invent history. "Después" may be a planned state labeled `Propuesto`; use the working tree only for what is implemented. |

## Plain language

Default reader: no specialist knowledge of the topic. Keep an exact identifier when the reader
needs it to find something or act; explain its everyday meaning first. Otherwise move it to
technical details unless the user asks for a maintainer-level text. Each item is a yes/no check:

- The first screen says where things stand and what matters most, in two sentences or fewer.
- Each term, name or identifier follows its everyday meaning; a term that is not needed to act or
  understand moves to `<details>`.
- Sentences are short, active and say who acts. Headings state the point, not the topic.
- Completeness goes to `<details>` or sources; the visible text keeps what the reader needs.
- No invented UI label, owner, approval or link.

Example: "The page saves your changes (the *save step*) before it closes" beats "persistence is flushed on teardown".

## Action guides

Add one only when the request asks what or how to do something, or the answer is a sequence the reader must carry out. For a pure explanation (how it works, why), keep `#pasos` out: delete the section and its nav link, and use the walkthrough in `#escenario`.

- "Primer paso" comes before any theory and names the action, where it happens and who acts.
- Per actual step, outside `<details>`: **where** to act, **what** to do, **success signal** the reader can see, **next** step or when to **stop**. Add "Quién" when someone other than the reader acts.
- Do not invent a step, UI label, approval or link. A fact you could not confirm stays text marked `Supuesto` or "sin verificar", with what would settle it.
- Permissions, hashes, inputs and background theory go in a closing `<details>`.

## Links

- Allowed `href`: `#id`, or an `https://` URL that you read this session or that a read-only query returned (for example `html_url`). `src`, `srcset` and `url(` stay `data:` or `#`.
- The label names the destination ("Pull request: add login check"); never a bare URL or "here".
- Forbidden: `javascript:`, `http:`, `data:` hrefs, userinfo, tokens or signatures in a URL, `ping`, `<base>`, meta refresh, iframe, embed, object, auto-navigation.
- `target="_blank"` requires `rel` with `noopener` and `noreferrer`.
- Add one note: external pages need a connection and may need access; the page reads fully without clicking.
- If a link gives 403, 404 or no access, or appears in no source, add no link; state the fact as text.

## Reader review

The caller (not the writer) checks the file with every `<details>` closed:

1. The question is answered in the first screen.
2. For an action request, the first action is visible before theory, and every step has the four fields.
3. Unexplained jargon, long paragraphs or invented labels count as findings; do not accept them as exceptions.
4. Claims cite consulted evidence; links are verified; no placeholder or remote load remains.

On a finding, send it to the same writer session with the exact output path; it fixes only the file it wrote for this request (a repair, see Path), in place, without a new name or new consent. A command run for research is read-only; writing or revising the artifact is allowed. List any gap that remains in the reply.

## Claims

- `Observado`: a source you read (`path:line`, a command you ran, a run artifact).
- `Propuesto`: planned and not implemented.
- `Supuesto`: not verified; say what would settle it.
- Verify each lead before citing. If sources contradict the user's premise, explain the verified correction; label `Supuesto` only what stays uncertain.
- Label meaningful claims and sections. A badge on every sentence is not needed.

## Path

1. Topic: 3 to 48 characters of `a-z0-9-`, accents removed, no leading, trailing or double hyphen.
2. Root: `.mdd/artifacts/<topic>/index.html`. Use `.mdd/runs/<run-id>/artifacts/<topic>/index.html`
   only when the user names that run or clearly means it and `.mdd/runs/<run-id>.md` exists.
   When unsure, use the standalone root.
3. Inspect every existing component (`.mdd`, `artifacts`, run directory, topic) before creating
   anything; stop on a symlink and never write through one.
4. Caller only: if `.mdd/` is new, create it with `.mdd/.gitignore` containing `*` before dispatch
   (see Roles). If `.mdd/` exists, leave it and every ignore file as they are.
5. Choose the case below. Recheck the target and its components immediately before every write,
   including a replacement or a repair.

| Case | When | Target | Limits |
|---|---|---|---|
| Fresh output | Default (`replace: no`) | The first free path among `<topic>`, `<topic>-2`, `-3`, and so on. If the recheck finds it taken, move to the next free one. Report the path actually written. | Never overwrite an existing file. |
| Approved replacement | `replace: yes`: the user explicitly asked to replace that exact file | That exact path, kept even if it is now absent; never add a suffix. | Grants nothing over sibling or other files. |
| Repair | The caller sends findings about this request's output to the same writer | The same file the writer reported for this request (in the fallback, the file the caller wrote for it), edited in place without renaming or new consent. | Only that file. If its origin cannot be traced to this request, or it changed outside this request, stop and report. |

Missing or ambiguous consent, another request's artifact, uncertain ownership, a symlink, a read
error or a denied write is never permission to replace: stop and report the gap.

## Diagrams on narrow screens

Do not trust the raw `font-size` attribute: an SVG scales with its box. A wide viewBox shrunk to a
390px phone makes 16-unit text unreadable. Use a vertical flow in a narrow viewBox (about 360 units
wide, boxes about 300 wide) with short labels, and cap the SVG width so it never scales up. Split a
long label over lines instead of shrinking it. Measure the final rendered size (font size times the
scale) at a 390px viewport; every label should render at 14px or more. The scale is the SVG's
actual content width (the smaller of the space the page leaves and its CSS `max-width`, minus
borders) divided by the viewBox width, not the viewport width alone. Adapt the layout when it does
not, for example by stacking the flows of a comparison one above the other.

## Self-check before returning

Read the file back. Remove or fix: `<script`, `<link`, `<iframe`, `<embed`, `<object`, `<base`, `@import`, any remote load
(`//` or `http(s)://` in `src`, `srcset`, `url(`; the CSP `http-equiv` is fine), any `href` that is not `#id` or a verified `https://` link
(no `javascript:`, credentials or `ping`), `target="_blank"` without `rel="noopener noreferrer"`, images without alt text or source, leftover `{{`, leftover guidance comments,
damaged text (`U+FFFD`, `Ã³`, `â€”`), and diagram labels that render under 14px at 390px. Keep the Content-Security-Policy meta tag verbatim.
