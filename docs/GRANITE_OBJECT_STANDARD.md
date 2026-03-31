# Granite Object Standard (GOS)

> A simple, powerful standard for agent-first note and object management.
> Informed by: MCP resources/tools, gh CLI field selection, Mem0 agent memory,
> Schema.org typed relationships, Logseq class-based schemas, CRDT identity patterns.

---

## 1. Design Principles

### 1.1 Markdown is truth, everything else is derived
Files on disk are the source of truth. The SQLite index, backlinks graph, and search
results are materialized views — rebuilt anytime from the files.

### 1.2 Agent-first, human-friendly
Every command returns structured JSON by default when piped (`!isTTY`).
Human-readable output is a presentation layer on top of the same data.

### 1.3 Stable identity survives renames
Notes are identified by UUID (`id` in frontmatter), not by slug or title.
Slugs are human-friendly aliases. Wikilinks resolve through: slug → title → alias → id.

### 1.4 Type = Schema
Each note type defines expected fields. The type system is the schema system.
Types are constrained to ~10 max (Johnny Decimal principle: discoverable at a glance).

### 1.5 Links are typed
Not all connections are equal. `[[wikilinks]]` carry semantic meaning through
frontmatter fields that define the relationship type.

### 1.6 Agents operate via Extract → Compare → Decide
Following the Mem0 pattern: extract facts from conversation, compare against existing
notes via search, then ADD / UPDATE / NOOP. Never blindly append.

---

## 2. Note Object Schema

### 2.1 Universal frontmatter (all note types)

```yaml
---
id: "uuid-v4"                    # Stable identity (survives renames)
title: "Note Title"              # Human-readable name
type: "permanent"                # Schema selector
created: "2026-03-30T10:00:00Z"  # ISO 8601
modified: "2026-03-30T10:00:00Z" # ISO 8601
tags: [architecture, active]     # Flat taxonomy, lowercase
aliases: [alt-name, abbrev]      # Resolve wikilinks by alias
status: active                   # Lifecycle: inbox | active | archived
source: human                    # Provenance: human | agent | extraction
---
```

**New fields (vs current Granite):**
- `status` — lifecycle state, orthogonal to type. Enables PARA-style workflow:
  `inbox` (raw capture) → `active` (in use) → `archived` (done, kept for reference).
- `source` — who created this note. Critical for trust: an agent reading a `human`
  permanent note trusts it more than an `agent` fleeting note.

### 2.2 Type-specific schemas (defined in granite.yml)

Each note type declares expected fields and their types:

```yaml
note_types:
  meeting:
    folder: notes/meetings
    description: Meeting notes with attendees, decisions, and actions
    fields:
      attendees:
        type: list
        of: wikilink
        description: People present
      date:
        type: date
        required: true
      project:
        type: wikilink
        description: Related project
    template: |
      ## Attendees

      ## Agenda

      ## Notes

      ## Decisions

      ## Actions
    line_limit: 300

  decision:
    folder: notes/decisions
    fields:
      context_for:
        type: wikilink
        description: Project or area this decision belongs to
      decision_status:
        type: enum
        options: [active, superseded, revisit]
        default: active
        description: Decision lifecycle (distinct from universal note status)
      superseded_by:
        type: wikilink
        description: If superseded, link to replacement decision
    template: |
      ## Context

      ## Options Considered

      1.
      2.

      ## Decision

      ## Rationale

      ## Status

      Active
    line_limit: 200

  person:
    folder: notes/people
    fields:
      role:
        type: text
      org:
        type: text
      contact:
        type: text
    template: |
      ## Role

      ## Context

      ## Contact

      ## Notes

      ## Links
    line_limit: 150
```

**Field types:** `text`, `date`, `number`, `boolean`, `wikilink`, `list`, `enum`.
Type-specific fields appear in frontmatter and are indexed in SQLite for structured queries.

### 2.3 Typed relationships via frontmatter

Instead of all `[[wikilinks]]` being untyped, key relationships are declared in frontmatter:

```yaml
---
id: "abc-123"
title: "Sprint review 2026-03-30"
type: meeting
attendees: ["[[jane-smith]]", "[[bob-chen]]"]
project: "[[project-granite]]"
---
```

The body still uses `[[wikilinks]]` for inline mentions, but frontmatter relationships
are **structured, queryable, and carry semantic meaning**:
- `attendees` links are of type "person attended meeting"
- `project` links are of type "meeting about project"

This enables queries like: `granite search --field attendees:jane-smith` or
`granite list --type meeting --field project:project-granite`.

---

## 3. CLI Output Standard

### 3.1 Format detection

```
TTY (human typing)  →  human-readable tables/text
Piped / --json      →  structured JSON with envelope
--format ndjson     →  streaming, one JSON object per line
```

### 3.2 JSON envelope (every command)

**Success:**
```json
{
  "success": true,
  "data": { ... },
  "meta": {
    "count": 5,
    "vault": "/home/user/notes"
  }
}
```

**Error:**
```json
{
  "success": false,
  "error": {
    "code": "NOTE_NOT_FOUND",
    "message": "No note with slug 'nonexistent'",
    "suggestion": "Did you mean 'decision-api-format'?"
  }
}
```

### 3.3 Field selection (gh CLI pattern)

```bash
granite list --json slug,title,type,tags
granite show note-slug --json title,body,backlinks
granite search "query" --json slug,title,score
```

`--json` without field names = list available fields (self-documenting):
```
$ granite list --json
Available fields: slug, title, type, created, modified, tags, aliases, status, source, filepath
```

### 3.4 Structured filtering

```bash
granite list --type meeting --tag project-x --status active --since 2026-03-01
granite list --field attendees:jane-smith          # Type-specific field query
granite search "api design" --type decision        # Full-text + type filter
```

### 3.5 Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Usage/argument error |
| 4 | Not found (empty result, distinct from error) |

### 3.6 NDJSON streaming (for large vaults)

```bash
granite list --format ndjson
```
```jsonl
{"slug":"note-1","title":"First","type":"fleeting","status":"inbox"}
{"slug":"note-2","title":"Second","type":"decision","status":"active"}
```

---

## 4. Agent Interaction Standard

### 4.1 The ECDA loop (Extract → Compare → Decide → Act)

Every agent interaction with the vault follows this pattern:

```
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
│ EXTRACT │───▶│ COMPARE │───▶│ DECIDE  │───▶│  ACT    │
│ facts   │    │ search  │    │ ADD?    │    │ create/ │
│ from    │    │ vault   │    │ UPDATE? │    │ update/ │
│ context │    │ for     │    │ NOOP?   │    │ link    │
│         │    │ matches │    │         │    │         │
└─────────┘    └─────────┘    └─────────┘    └─────────┘
```

**Step 1 — Extract:** Identify atomic facts, entities, and relationships from conversation.

**Step 2 — Compare:** Search the vault for existing notes about the same entities.
```bash
granite search "Jane Smith" --json slug,title,type
granite list --type person --json slug,title --field role:CTO
```

**Step 3 — Decide:**
- If no match → `ADD` (create new note)
- If match and new info → `UPDATE` (append or edit existing)
- If match and no new info → `NOOP` (skip)

**Step 4 — Act:**
```bash
granite new "Jane Smith" -t person --json               # ADD
granite edit jane-smith --append $'- 2026-03-30: ...'    # UPDATE
# NOOP = do nothing
```

### 4.2 Trust levels by source and type

When an agent reads notes to inform its responses, trust varies:

| Source × Type | Trust | Use |
|---|---|---|
| human + permanent | Highest | Authoritative knowledge |
| human + decision | High | Established choices |
| human + reference | High | Verified external sources |
| agent + permanent | Medium | Agent-refined insights (verify) |
| human + fleeting | Low | Raw, unprocessed capture |
| agent + fleeting | Lowest | Agent speculation (needs review) |

### 4.3 MCP resource/tool mapping

If Granite exposes an MCP server, the split is:

**Resources (reads, application-controlled):**
- `granite://vault/notes/{slug}` — read a note
- `granite://vault/search?q={query}` — search results
- `granite://vault/backlinks/{slug}` — backlink graph
- `granite://vault/types` — available note types with schemas

**Tools (writes, model-controlled):**
- `create_note(title, type, body, fields)` — create a note
- `update_note(slug, body?, append?, title?, tags?, aliases?)` — edit a note
- `link_notes(source, target, relationship?)` — add a wikilink

---

## 5. Knowledge Graph Patterns

### 5.1 Hub notes (Maps of Content)

For major topics, create permanent notes that are mostly links:

```yaml
---
title: "Knowledge Map: Infrastructure"
type: permanent
tags: [hub, area/infrastructure]
---

## Active Projects
- [[project-granite]] — Memory system for agents
- [[project-api-v2]] — API redesign

## Key Decisions
- [[decision-use-sqlite]] — Database choice
- [[decision-markdown-first]] — File format

## People
- [[jane-smith]] — Infrastructure lead
- [[bob-chen]] — Backend engineer

## Reference
- [[local-first-software]] — Architecture pattern
```

### 5.2 Temporal chains

Meeting and decision notes form temporal chains through wikilinks:

```
[[sprint-review-2026-03-23]] → [[sprint-review-2026-03-30]] → [[sprint-review-2026-04-06]]
```

Each links to the previous and next. Agents can traverse the chain to build context.

### 5.3 The promotion flow

```
fleeting (inbox)  ──refine──▶  permanent (active)  ──archive──▶  permanent (archived)
     │                              ▲
     └──────extract──────▶  reference (active)
```

Fleeting notes are raw captures. During review, atomic insights are extracted
into permanent notes, and source material goes into reference notes.
The fleeting note is then archived (not deleted — it's the provenance chain).

---

## 6. Implementation Priorities for Granite

### Phase 1 (shipped): Agent-readable CLI
✅ `granite show` command
✅ `--json` on all commands
✅ Consistent JSON envelope
✅ `--alias` on edit
✅ Improved templates

### Phase 2 (next): Schema and filtering
- Add `status` and `source` to universal frontmatter
- Add `fields` definition to `granite.yml` note types
- Index type-specific fields in SQLite
- Add `--field` filter to `list` and `search`
- Field selection on `--json` (gh-style)

### Phase 3 (future): Advanced agent patterns
- Auto-detect TTY for format switching
- NDJSON streaming output
- Exit code 4 for "not found" (distinct from error)
- `granite --capabilities` for agent discovery
- Fuzzy suggestions on "not found" errors
- MCP server exposing resources + tools

### Phase 4 (later): Knowledge graph intelligence
- Typed relationship indexing (frontmatter wikilinks stored with relationship type)
- `granite graph` command for traversing the link graph
- `granite promote <slug> --to permanent` for lifecycle transitions
- `granite orphans` to find unlinked notes
- Hub note auto-generation from tag clusters
