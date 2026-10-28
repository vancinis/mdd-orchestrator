# Reuse advisory project knowledge and approved skills

MDD can record candidate coordinator observations learned while handling an ordinary native user
request, then find their summaries from later sessions in the same project. An explicit checkout
catalog can also supply relevant approved skill excerpts at child dispatch. Knowledge is enabled by
default; an explicit `"knowledge": { "enabled": false }` keeps it off. Recording grants no policy,
approval, execution authority or additional actor permissions.

## Quick path

1. Update MDD, then restart the OpenCode service (`opencode service restart`) to load the new default.
   Fresh settings and legacy files that omit `knowledge` enable it; update/read preserves existing
   configuration bytes. An explicit `"knowledge": { "enabled": false }` in the **global** MDD
   configuration remains off until you change it and restart. No project setting overrides this preference.
   Memory requires an already configured `engram` backend: absent Engram stays unconfigured and knowledge
   memory is unavailable. Update does not configure a provider or create the optional `mdd/knowledge.json`
   catalog. An explicitly authored local catalog can operate without memory.
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
   supplies the structured finding; the adapter adds project identity, timestamp, provenance and
   dependency digests captured from this checkout. Caller-provided digests are rejected.
4. Query with `mdd_knowledge({ query: "validation", phase: "mdd-apply", paths: ["src/settings.ts"] })`.
   Omit filters to browse candidates. Results contain bounded summaries, `engram:<id>` refs and
   `fresh`, `stale` or `unverified` freshness; no observation body is returned.

Enabled knowledge permits candidate recording in the bound native request context. A concise
single-line summary may synthesize the finding rather than quote the body. Native grounding proves
the context in which it was learned, **not user authorship, factual truth or policy approval**.
Recording does not promote a phase/model claim into an authoritative instruction.

## Storage and retrieval contract

| Boundary | Current behavior |
|---|---|
| Configuration | `knowledge.enabled` is a strict boolean, default `true` when omitted, captured at startup. Explicit `false` remains disabled; disabled tools make no provider calls. |
| Identity | Existing native runtime binding resolves the Engram project and binds the actual parent session/directory. Tool arguments cannot choose a project or session. |
| Canonical storage | Engram `POST /observations`, type `mdd-project-knowledge`, project scope. New version-2 envelopes include native dependency digests; version-1 records remain readable but unverified. |
| Provenance | `kind: "coordinator-observation"`, native session, user and assistant message IDs, SHA-256 of canonical native request and normalized observation, and recording timestamp. The user message identifies task context, never authorship of the finding. |
| Lookup | `GET /search` supplies candidate IDs. Each candidate requires `GET /observations/:id`; preview content is never accepted as a full record. |
| Validation | Validate provider ID, project, scope, type, title, deletion state, author session, complete envelope, version, provenance, applicability, dependency coverage/digests and field bounds. Invalid entries are omitted. |
| Cross-session reuse | Knowledge belongs to the project. Operational artifacts remain bound to their original session and retain their existing read checks. |
| Applicability | Optional exact phase filter and case-sensitive path matching: an exact declared path or descendant on a `/` boundary. This is candidate filtering, not freshness validation. |
| Coordinator output | `ref`, `summary`, `status: "observation"`, `freshness`; no body, native request text or full provenance is echoed. |

## Checkout-specific freshness

Recording hashes each declared source directly from the native checkout, including dirty and
untracked files. Digests are stored in the canonical envelope and covered by its observation digest.
A missing source is recorded as `missing`, distinct from the SHA-256 of an empty file.

Every matching query reopens and hashes the target checkout's sources. Git commit identity, cached
freshness, timestamps and a shared project name never substitute for current bytes. Linked worktrees
share the cache anchor, but each uses its own checkout for source validation.

| Freshness | Meaning |
|---|---|
| `fresh` | All declared dependencies match their recorded digests or recorded absence at this check. This does not prove the observation true or dependencies complete. |
| `stale` | A dependency differs, becomes unavailable/unsafe, exceeds bounds or changes during capture. It is not eligible for reuse. |
| `unverified` | A legacy version-1 record has no historical digests. Current bytes are never backfilled as historical evidence; it is not eligible for reuse. |

Source reads reject traversal, symlinks/junctions in any ancestor or final component, hardlinks,
nonregular files and observable identity/byte races. Hidden components (including `.git`, `.mdd`,
`.env` and credential directories), common credential/secret/key names and extensions, and `~`
aliases are excluded. This conservative policy also excludes benign hidden files such as
`.github/workflows/ci.yml`. Source contents are hashed, not copied into the envelope or cache.

## Rebuildable parsing cache

`.mdd/knowledge-cache.json` is one disposable file managed by the fixed `LocalFiles` allowlist.
It stores bounded observation bodies and metadata, never source file contents or trusted freshness.
It has no offline lookup API: every result first requires a complete canonical Engram fetch and
current provider identity/deletion checks. Outage or revoked/foreign records cannot be rescued by
cached copies.

The cache has a concrete parsing reuse function:

- A cold disk hit supplies already decoded envelope data only when serializing it exactly matches
  the entire fetched canonical content; the current structural validator still runs.
- A warm exact-content hit also avoids repeating envelope normalization and observation-digest
  validation. Changed canonical bytes force new validation. Returns are detached copies.
- Source reads/hashes and canonical network requests are always performed; this cache does not
  claim to reduce either. Noncanonical JSON formatting can cause a harmless cold miss.

Entries are evicted oldest-insertion first until both entry-count and serialized-byte caps hold;
warm reads do not write recency metadata. Concurrent writers merge under the existing local lock.
Corruption, loss or write failure cannot block canonical retrieval. A cold lookup or later cache
miss rebuilds disposable storage when safe; linked or otherwise unsafe storage is left untouched.

## Selected knowledge at dispatch

With knowledge enabled, the runtime resolves observations for ordinary workflow phases, standalone
or contextual exploration, and each scoped Apply/exploration member. It uses the configured,
session-bound Engram adapter and the same canonical validation/cache path. Risk assessment remains
grounded in its existing requirements and exploration evidence; knowledge does not choose a route.

1. After admitting the native call, derive its phase, objective and actual assignment paths. Query
   at most ten canonical candidates using up to four distinct lowercase ASCII objective terms,
   with common task words removed and quoted `OR` alternatives. The entire objective is never sent
   as an implicit FTS `AND` expression. No meaningful terms means no selection.
2. Require matching phase, applicable paths when known, and at least one exact objective-term
   overlap in the summary/body. Rank by overlap count descending, then numeric observation ID.
   Legacy, stale and malformed candidates are omitted. Scoped members additionally require **all**
   declared dependencies inside that member's exact authorized footprint. Existing footprint
   validation rejects globs; knowledge introduces no new pattern or permission semantics.
3. After lookup, recheck the exact owner/reservation and pending state, inspect native parent
   authority again, then recheck state and source bytes synchronously before final dispatch.
   Optional provider failure omits observations but can retain safe explicit catalog recommendations;
   native authority failures still refuse dispatch.
4. Append at most three combined entries (catalog recommendations first, then complete observations)
   in an explicitly untrusted advisory section. Its
   entire UTF-8 size, including framing, references, source names and JSON escaping, is at most
   8 KiB and must fit the remaining prompt budget (96,000 bytes normally; 48,000 for exploration
   members). Never trim task, acceptance or verification context to fit optional knowledge.

Bodies are added only to actual child arguments inside the native hook. Prepared handles, status,
coordinator query results and phase telemetry contain no selected bodies; the existing transcript
collapse removes dispatched prompts from subsequent coordinator context. Do not copy observations
into `mdd_context`. This limits adapter-supplied context; it cannot prevent an actor from quoting a
finding in its own report.

Native `explore` and `general` fallbacks use the same bound-dispatch collapse check in V2 and the
shared V1 transform: parent session, native call and exact dispatched arguments must match. Settled
fallback prompts are replaced only in outgoing context; child arguments remain immutable. Unrelated,
altered or unsettled native tasks remain untouched. Native fallback correlation is process-local;
unbound historical native prompts after a restart are not inferred to belong to MDD.

Each admission resolves once; duplicate admission cannot repeat the lookup. A newly authorized
retry or restored ready phase resolves again instead of reusing a prepared supplement. Final
`dispatchedArgs` retain exact result correlation. Exploration checkpoints retain those dispatched
arguments through their existing fields; ordinary/Apply checkpoints retain their existing pending
call fences. Unconfirmed work is never replayed after restart, and retained exploration authority
remains subject to its existing recovery restrictions. No resumable knowledge state is added.

Matching recorded absence can be `fresh` and selected for an otherwise eligible assignment. It
proves only that the declared file remains absent, not that the observation's assertion is true.

## Explicit approved skill catalog

When knowledge is enabled, the runtime optionally reads **this checkout's** `mdd/knowledge.json`.
Maintainers author and approve this policy explicitly. MDD never creates it, changes approvals,
crawls skill directories or installs tools. The following is an example, not repository policy:

```json
{
  "version": 1,
  "skills": [{
    "id": "parser-validation",
    "path": "skills/parser-validation/SKILL.md",
    "approved": true,
    "phases": ["mdd-explore", "mdd-apply"],
    "terms": ["parser", "validation"],
    "paths": ["src/parser"],
    "tools": ["read", "mdd_worker_edit"]
  }]
}
```

- Require a listed phase, at least one lowercase ASCII literal term found in the lowercased objective
  (substring matching, no expressions), and an assigned path equal to or beneath a listed path prefix.
  `paths: []` explicitly removes the path filter. A nonempty filter cannot match unknown assignment
  paths, such as an initial ordinary exploration. Matching skills sort by ASCII ID ascending.
- Require `approved: true`, a unique lowercase ID and exact relative `SKILL.md` path, and plain
  frontmatter `name: <id>`. Unknown fields, invalid versions, unapproved entries, duplicate IDs/paths
  or malformed schema omit the catalog. Missing, unsafe or invalid skill sources omit that entry.
- The catalog is at most 32 KiB and 32 entries; each source is at most 64 KiB. Each entry has 1–8
  phases, 1–8 distinct terms of at most 64 ASCII characters, 0–16 path prefixes and 0–16 tool names.
  IDs/tool names are at most 64 characters. Shared source validation rejects private paths, traversal,
  links/junctions, hardlinks, nonregular files and observable read races. Both catalog and skill
  digests must still match at final dispatch; deletion or policy edits invalidate prior selections.
- Deliver at most the first 4 KiB of each skill, on a UTF-8 boundary, plus a truncation marker when
  needed. JSON escaping, excerpts, tool preferences and framing all share the existing three-entry,
  8 KiB supplement budget with memory. No separate unbounded skill allowance exists.
- Scoped members receive excerpts by value, including when the skill source lies outside their
  footprint. They receive no skill read instruction or extra file rights. Applicability uses the
  receiving member's assignment. Packaged `PHASE_SKILLS` and mandatory instructions remain intact.
- Advisory tools must intersect both known lane-supported tools and adapter-proven availability.
  The current production adapter proves only its installed `mdd_worker_edit` for scoped Apply.
  Ordinary and exploration preferences are omitted because no native tool inventory is supplied;
  even a catalog `read` name or a permission rule is not proof of availability. Unknown tools are
  ignored. Tools cannot be installed, executed or authorized by this catalog.

## Measured dispatch feedback

After a successful adapter admission/publication, `mdd_status.knowledge` exposes the latest snapshot
for the current workflow incarnation or investigation in that parent. It contains no bodies,
objectives or source paths. Snapshots are bound to that origin: reset, replacement, restoration,
transfer eviction and new standalone/contextual work cannot inherit another origin's delivery.
Returning from contextual work does not report its metrics as main-workflow delivery. Within one
workflow, the snapshot describes its latest successful delivery, not an undispatched next phase.
Rejected resets and unsuccessful sibling publication preserve the current origin's snapshot.
Snapshots are process-local,
bounded to 128 parents, replaced rather than accumulated, and not checkpointed. Failed native,
checkpoint or host-publication checks publish no delivery snapshot for that attempt.

| Metric | Measurement |
|---|---|
| `candidates` | Canonical search rows received (at most 10) plus structurally valid catalog entries (at most 32), before applicability filtering. |
| `freshHits` | Applicable candidates passing source checks during retrieval; these are eligible hits, not delivered entries. |
| `staleRejects` | Applicable candidates rejected for stale/unverified/unsafe sources at retrieval, plus previously fresh candidates invalidated at final dispatch. A late invalidation can also have counted as a fresh hit earlier. |
| `selectedReferences`, `selectedSkillIDs` | Only entries actually emitted, sharing at most three slots. |
| `selectedBytes` | UTF-8 bytes of emitted JSON entry lines, including escaping and line separators. |
| `promptByteDelta` | Exact added UTF-8 bytes, including the shared framing; zero when nothing fits or matches. |

The same bounded metadata is a `knowledge-dispatch` event in existing telemetry, under its existing
retention and opt-out. With telemetry disabled, only in-memory/per-response diagnostics remain;
there is no persistent metrics store or cache counter. A dispatch measurement means the adapter
published arguments, not that a model consumed them or achieved a useful outcome. Byte counts are
not token savings. Native observations, source-validated skill recommendations and explicit catalog
policy remain distinct. Record useful outcomes through the existing `mdd_knowledge_record` tool;
it still creates observations and never rewrites or self-approves project policy.

## Bounds and outcomes

| Field | Limit |
|---|---|
| Body / summary | 4,096 / 320 UTF-8 bytes |
| Serialized stored envelope / native request | 16,384 UTF-8 bytes / no limit (only its digest is stored) |
| Applicability | 1–8 distinct workflow phases; 1–16 distinct relative path scopes |
| Sources | 1–16 distinct declared relative file references; accepted contents at most 256 KiB/file and 1 MiB total per observation (bounded reads include a one-byte growth probe) |
| Path | 256 UTF-8 bytes; portable `/` separators; no whitespace, traversal, absolute paths, backslashes, wildcards, device names or alternate streams |
| Query / result limit | 200 UTF-8 bytes; default 5, maximum 10 candidates and summaries |
| Transport reads | Each complete HTTP response is capped at 128 KiB, including JSON encoding and provider metadata; a search list accepts at most 200 rows before selecting at most the requested number of distinct IDs |
| Attempt guard | At most 512 attempted request/observation keys per plugin instance; no eviction or durable replay ledger |
| Cache | At most 100 entries and 512 KiB serialized JSON, including metadata and escaping; each validated body remains at most 4,096 UTF-8 bytes |
| Dispatch supplement | At most 3 entries and 8,192 UTF-8 bytes including framing, subordinate to the existing total prompt limit |

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

- Freshness covers only declared dependencies at the time of checking. Files can change after the
  final dispatch check. This is not an atomic
  filesystem snapshot, and source-name exclusions cannot identify every possible embedded secret.
- Selection is bounded lexical matching, not semantic search: non-ASCII objectives or candidates outside the provider's
  first ten matches can be missed. No extra search attempts are made to fill the supplement.
- Engram remains trusted canonical storage, not a cryptographic authority. Envelopes validate shape
  and binding; they cannot prove a claim is correct or that declared dependencies are complete.
- Tests use isolated homes and loopback fixture HTTP servers. They establish adapter contracts,
  not real-host Engram/OpenCode interoperability or token savings.
