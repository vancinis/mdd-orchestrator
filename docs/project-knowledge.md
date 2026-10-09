# Record advisory project observations

MDD can record candidate coordinator observations learned while handling an ordinary native user
request, then find their summaries from later sessions in the same project. This optional feature
defaults off. Recording grants no policy, approval, execution authority or additional actor permissions.

## Quick path

1. In the existing **global** MDD configuration, explicitly set `"knowledge": { "enabled": true }`
   alongside an already configured `engram` backend, then restart OpenCode. No project setting
   overrides this preference. Omitted `knowledge` remains disabled without rewriting legacy files.
2. Ask for normal project work, for example: “Improve input validation in the settings parser.”
   The user needs no recording command, special syntax or technical metadata.
3. When the coordinator learns a reusable finding in that context, it can call:

   ```json
   {
     "userText": "Improve input validation in the settings parser.",
     "observation": {
       "summary": "The settings parser owns boundary validation.",
       "body": "Unknown fields are rejected before persistence in the settings parsing path.",
       "applicability": { "phases": ["mdd-apply", "mdd-verify"], "paths": ["src"] },
       "sources": ["src/settings.ts"]
     }
   }
   ```

   These are `mdd_knowledge_record` tool arguments, not a form the user must write. The native
   inspector proves the latest user message, actual caller and workspace context. The coordinator
   supplies the structured finding; the adapter adds project identity, timestamp and provenance.
4. Query with `mdd_knowledge({ query: "validation", phase: "mdd-apply", paths: ["src/settings.ts"] })`.
   Omit filters to browse candidates. Results contain only bounded summaries and `engram:<id>` refs.

Enabled knowledge permits candidate recording in the bound native request context. A concise
single-line summary may synthesize the finding rather than quote the body. Native grounding proves
the context in which it was learned, **not user authorship, factual truth or policy approval**.
Recording does not promote a phase/model claim into an authoritative instruction.

## Storage and retrieval contract

| Boundary | Current behavior |
|---|---|
| Configuration | `knowledge.enabled` is a strict boolean, default `false`, captured at startup. Disabled tools make no provider calls. |
| Identity | Existing native runtime binding resolves the Engram project and binds the actual parent session/directory. Tool arguments cannot choose a project or session. |
| Canonical storage | Engram `POST /observations`, type `mdd-project-knowledge`, project scope, version-1 JSON envelope. There is no second knowledge database. |
| Provenance | `kind: "coordinator-observation"`, native session, user and assistant message IDs, SHA-256 of canonical native request and normalized observation, and recording timestamp. The user message identifies task context, never authorship of the finding. |
| Lookup | `GET /search` supplies candidate IDs. Each candidate requires `GET /observations/:id`; preview content is never accepted as a full record. |
| Validation | Validate provider ID, project, scope, type, title, deletion state, author session, complete envelope, version, provenance, applicability and field bounds. Invalid entries are omitted. |
| Cross-session reuse | Knowledge belongs to the project. Operational artifacts remain bound to their original session and retain their existing read checks. |
| Applicability | Optional exact phase filter and case-sensitive path matching: an exact declared path or descendant on a `/` boundary. This is candidate filtering, not freshness validation. |
| Coordinator output | `ref`, `summary`, `status: "observation"`, `freshness: "unverified"`; no body, native request text or full provenance is echoed. |

## Bounds and outcomes

| Field | Limit |
|---|---|
| Body / summary | 4,096 / 320 UTF-8 bytes |
| Serialized stored envelope / native request | 16,384 / 12,000 UTF-8 bytes |
| Applicability | 1–8 distinct workflow phases; 1–16 distinct relative path scopes |
| Sources | 1–16 distinct declared relative file references |
| Path | 256 UTF-8 bytes; portable `/` separators; no whitespace, traversal, absolute paths, backslashes, wildcards, device names or alternate streams |
| Query / result limit | 200 UTF-8 bytes; default 5, maximum 10 candidates and summaries |
| Transport reads | Each complete HTTP response is capped at 128 KiB, including JSON encoding and provider metadata; a search list accepts at most 200 rows before selecting at most the requested number of distinct IDs |
| Attempt guard | At most 512 attempted request/observation keys per plugin instance; no eviction or durable replay ledger |

Field limits measure UTF-8 content bytes; the envelope and transport caps independently measure
serialized bytes, including escaping. Therefore a combination of individually valid fields can
still exceed a physical cap and be refused. HTTP timeouts are per request (5 seconds by default),
not a single deadline for the entire multi-request lookup.

Lookup reports `available`, `disabled` or `unavailable`. `available` with no entries means no valid
matching observation among the bounded candidates, not proof that all project memory is empty.
Transport or binding failures return `unavailable` with no partial results or offline fallback.

Recording reports `recorded` only after exact full readback. An uncertain POST or readback reports
`write-unknown`, with the observation reference when known. **Never retry blindly.** Inspect canonical
Engram records before deciding whether a separate user recording request is needed. The adapter
does not retry writes. It refuses repeated attempts for the same native request and normalized
observation digest during the current plugin instance, including concurrent calls and reordered
reference lists. Distinct findings in the same task remain recordable. The bounded guard is not
durable across restart, and changed wording is a different digest, not proof of a different finding.
Never rephrase an uncertain write to bypass the guard.

## Current limitations

- Source references are declarations only. PK-1 does **not read source files or compute source
  digests**, verify their existence, or check that they support the observation. No entry is fresh.
- Checkout-specific validation, dirty/untracked dependency invalidation, safe source reads and a
  bounded rebuildable cache are planned for PK-2; none is implemented here.
- Automatic dispatch injection, per-worker selection, approved skill catalogs, routing and metrics
  are later work. These tools neither change phase prompts nor accumulate bodies in `mdd_context`.
- Engram remains trusted canonical storage, not a cryptographic authority. Envelopes validate shape
  and binding; they cannot prove a claim is correct or that declared dependencies are complete.
- Tests use isolated homes and loopback fixture HTTP servers. They establish adapter contracts,
  not real-host Engram/OpenCode interoperability or token savings.
