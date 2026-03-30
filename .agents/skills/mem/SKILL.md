---
name: mem
description: Manage a local-first markdown memory system using the `mem` CLI. Use when the user asks to capture notes, log meetings, track people, record decisions, or manage any kind of structured memory. Enforces brevity and atomic note-taking.
user-invocable: true
argument-hint: [action]
allowed-tools: Bash
---

You are an expert at managing a structured knowledge base using the `mem` CLI — a local-first markdown memory system built on Zettelkasten principles.

## Core Principles

1. **One idea per note.** Never cram multiple concepts into a single note.
2. **Be brutally concise.** Every word must earn its place.
3. **Link aggressively.** Use `[[wikilinks]]` to connect ideas. Isolated notes are dead notes.
4. **Capture now, refine later.** Fleeting notes are raw — don't overthink them.

## Word Limits (STRICT)

| Type | Max words | Purpose |
|------|-----------|---------|
| `fleeting` | **30 words** | Raw thought, single sentence. Inbox item. |
| `permanent` | **150 words** | One refined idea. Summary + details + links. |
| `reference` | **200 words** | External source notes. Key points in your own words. |
| `person` | **100 words** | Contact card. Role, context, interaction log. |
| `meeting` | **200 words** | Attendees, decisions, action items. No fluff. |
| `project` | **150 words** | Goal, status, people, key decisions. |
| `decision` | **150 words** | Context, options, outcome, rationale. |

If a note exceeds its limit, split it into multiple linked notes.

## CLI Reference

### Create notes

```bash
# Fleeting note (default type) — title becomes the body
mem new "Raw thought or observation"

# Typed note — gets the type's template
mem new "Note title" -t permanent
mem new "John Doe" -t person
mem new "Sprint planning 2026-03-30" -t meeting

# Quick capture (also accepts stdin)
mem add "Quick thought"
echo "Piped content" | mem add
```

### Edit notes

```bash
# Open in $EDITOR (human)
mem edit <slug>

# Programmatic edits (agent-friendly)
mem edit <slug> --body $'## Section\n\nContent here.'
mem edit <slug> --append $'- 2026-03-30: New interaction'
mem edit <slug> --title "New Title"
mem edit <slug> --tag "tag1,tag2"
```

### Browse and search

```bash
# List notes
mem list                    # all notes, sorted by modified
mem list -t person          # filter by type
mem list --json             # JSON output (agent-friendly)
mem ls                      # alias

# Search
mem search "query"          # full-text search

# Relationships
mem backlinks <slug>        # who links to this note?
mem suggest-links <slug>    # find unlinked mentions
```

### Vault management

```bash
mem init                    # initialize a new vault
mem types                   # list available note types
mem doctor                  # validate vault health
mem serve                   # start web UI at localhost:4321
```

## Writing Guidelines

When creating or editing notes:

- **Fleeting notes**: One sentence. No formatting. Just the raw thought.
  - Good: `mem new "Granite could auto-suggest note type based on content"`
  - Bad: `mem new "I was thinking today about how it would be really cool if Granite could maybe look at what you're writing and suggest what type of note it should be"`

- **Permanent notes**: Start with a one-line summary. Use `## Summary`, `## Details`, `## Links` sections. Link to related notes with `[[wikilinks]]`.

- **Person notes**: Lead with role and context. Add timestamped interaction notes with `--append`. Always link to projects and meetings.
  ```bash
  mem new "Jane Smith" -t person
  mem edit jane-smith --body $'## Role\n\nCTO at Acme Corp\n\n## Context\n\nMet at ReactConf 2026. Working on similar infra problems.\n\n## Notes\n\n## Links\n'
  mem edit jane-smith --append $'- 2026-03-30: Discussed [[project-x]] migration timeline'
  ```

- **Meeting notes**: List attendees as `[[person]]` links. Capture decisions and action items as bullet points. Skip everything that isn't actionable.

- **Decisions**: State the context in one sentence. List options briefly. State what was decided and why. Link to the project.

## Agent Workflow

When an agent needs to capture information:

1. **Check if a related note exists**: `mem search "topic"` or `mem list --json | jq`
2. **Create or append**: Don't duplicate — append to existing notes when possible
3. **Link**: Always reference related notes with `[[slug]]`
4. **Stay under word limits**: Count words. Split if needed.

When an agent needs to retrieve information:

1. `mem search "query"` for full-text search
2. `mem list --json -t <type>` for structured listing
3. `mem backlinks <slug>` to understand relationships

## Anti-patterns

- Writing essays in fleeting notes → split into permanent notes
- Notes without links → add `[[wikilinks]]` to at least one other note
- Vague titles → be specific: "Auth migration decision" not "Decision"
- Duplicating information → use `--append` on existing notes
- Ignoring `suggest-links` output → if it detects a mention, link it
