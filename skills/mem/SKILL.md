---
name: mem
description: Manage a local-first markdown memory system using the `mem` CLI. Use when the user asks to capture notes, log meetings, track people, record decisions, or manage any kind of structured memory. Enforces brevity and atomic note-taking.
user-invocable: true
argument-hint: [action]
allowed-tools: Bash
---

You are an expert at managing a structured knowledge base using the `mem` CLI — a local-first markdown memory system built on Zettelkasten principles.

## Core Workflow

Every interaction follows this loop:

```
1. Search  →  check if a related note exists
2. Create or Append  →  never duplicate
3. Link  →  connect with [[wikilinks]]
4. Verify  →  check line limits, run suggest-links
```

## Note Type Decision Tree

| Situation | Type |
|-----------|------|
| Quick capture, raw thought | `fleeting` |
| Refined idea, one concept | `permanent` |
| External source (article, book, talk) | `reference` |
| A person you interact with | `person` |
| Meeting that happened or is planned | `meeting` |
| Ongoing initiative with goals | `project` |
| Choice made with rationale | `decision` |

## Line Limits (STRICT)

| Type | Max lines | Enforced | Purpose |
|------|-----------|----------|---------|
| `fleeting` | 50 | warn | Raw thought. One sentence or short paragraph. |
| `permanent` | 200 | hard | One atomic idea. Summary + details + links. |
| `reference` | 300 | warn | External source. Key points in your own words. |
| `person` | 150 | warn | Contact card. Role, context, interaction log. |
| `meeting` | 300 | warn | Attendees, decisions, action items. No fluff. |
| `project` | 300 | warn | Goal, status, people, key decisions. |
| `decision` | 200 | hard | Context, options, outcome, rationale. |

If a note exceeds its limit, **split it** into multiple linked notes.

## CLI Reference

### Create

```bash
mem new "Note title" -t permanent       # Create typed note
mem new "Quick thought"                  # Fleeting note (default)
mem new "Sprint review 2026-03-30" -t meeting --json  # JSON output
mem add "Quick thought"                  # Quick-capture fleeting note
echo "Piped content" | mem add --json    # Stdin + JSON output
```

### Read

```bash
mem show <slug>              # Display note with header
mem show <slug> --json       # Full note as JSON (agent-friendly)
mem show <slug> --body       # Raw body only (for piping)
mem list                     # All notes, sorted by modified
mem list -t person           # Filter by type
mem list --json              # JSON output
mem search "query"           # Full-text search
mem search "query" --json    # JSON output
```

### Update

```bash
mem edit <slug> --body $'## Section\n\nContent here.'   # Replace body
mem edit <slug> --append $'- 2026-03-30: Met at conf'   # Append text
mem edit <slug> --title "New Title"                      # Update title
mem edit <slug> --tag "tag1,tag2"                        # Add tags
mem edit <slug> --alias "short-name,abbreviation"        # Add aliases
mem edit <slug>                                          # Open in $EDITOR
```

### Graph

```bash
mem backlinks <slug>              # Who links to this note?
mem backlinks <slug> --json       # JSON output
mem suggest-links <slug>          # Find unlinked mentions
mem suggest-links <slug> --json   # JSON output
```

### Manage

```bash
mem init          # Initialize a new vault
mem types         # List available note types
mem doctor        # Validate vault health
mem serve         # Start web UI at localhost:4321
```

All `--json` commands return `{"success": true, "data": ...}` or `{"success": false, "error": "..."}`.

## Writing by Type

### Fleeting
One sentence. No formatting. Just the raw thought.

```bash
mem new "Granite could auto-detect note type from content"
```

Bad: `mem new "I was thinking about how it would be really cool if Granite could maybe analyze what you write and automatically suggest the type"`

### Permanent
Start with a one-line summary. Use `## Summary`, `## Details`, `## Links` sections.

```
## Summary

Atomic notes outperform long documents for knowledge retention.

## Details

When each note captures one idea, linking creates emergent structure.
The key is [[wikilinks]] between concepts, not folder hierarchies.

## Links

Related: [[Zettelkasten Method]], [[Knowledge Graphs]]
```

### Reference
Capture source, date, key points in your own words, and your reaction.

```
## Source

https://example.com/local-first-article

## Date

2026-03-30

## Key Points

- Data lives on device, not in the cloud
- Sync is a feature, not a requirement

## My Take

This aligns with how [[Granite]] works. See also [[Local-First Software]].
```

### Person
Lead with role and context. Add timestamped interaction notes with `--append`.

```bash
mem new "Jane Smith" -t person --json
mem edit jane-smith --body $'## Role\n\nCTO at Acme Corp\n\n## Context\n\nMet at ReactConf 2026. Working on similar infra.\n\n## Contact\n\nSlack: @jsmith\n\n## Notes\n\n## Links\n'
mem edit jane-smith --append $'- 2026-03-30: Discussed [[project-x]] migration timeline'
```

### Meeting
List attendees as `[[person]]` links. Capture only decisions and actions.

```
## Attendees

- [[jane-smith]]
- [[bob-chen]]

## Agenda

- Q2 roadmap review

## Notes

Agreed to focus on API v2 first.

## Decisions

- Prioritize API v2 over dashboard redesign

## Actions

- [ ] [[jane-smith]]: Draft API v2 spec by April 5
- [ ] [[bob-chen]]: Set up staging environment
```

### Decision
State context in one sentence. List options. State what was decided and why.

```
## Context

Need to choose a database for the new analytics service.

## Options Considered

1. PostgreSQL — proven, team knows it well
2. ClickHouse — optimized for analytics queries

## Decision

ClickHouse for analytics, PostgreSQL for metadata.

## Rationale

Analytics queries are 10x faster on ClickHouse. Keep PostgreSQL for CRUD.
Linked to [[analytics-service]] project.

## Status

Active
```

## Tags and Aliases

**Tags**: lowercase, hyphenated. Use sparingly — prefer `[[wikilinks]]` for relationships.
- Good: `status/active`, `area/infrastructure`, `priority/high`
- Bad: using tags to replicate what links already do

**Aliases**: set when a note has common abbreviations or alternate names.
```bash
mem edit amazon-web-services --alias "AWS,aws"
mem edit jane-smith --alias "Jane,jsmith"
```
This makes wikilinks resolve correctly: `[[AWS]]` will find the `amazon-web-services` note.

## Key Patterns

### Capturing a meeting

```bash
mem search "sprint review" --json           # Check if note exists
mem new "Sprint review 2026-03-30" -t meeting --json
# For each attendee:
mem search "Jane Smith" --json              # Check if person note exists
mem new "Jane Smith" -t person --json       # Create if missing
# Fill meeting body:
mem edit sprint-review-2026-03-30 --body $'## Attendees\n\n- [[jane-smith]]\n...'
# Update person notes:
mem edit jane-smith --append $'- 2026-03-30: [[sprint-review-2026-03-30]]'
```

### Recording a decision

```bash
mem search "database choice" --json
mem new "Analytics database choice" -t decision --json
mem edit analytics-database-choice --body $'## Context\n\n...\n\n## Decision\n\n...\n\n## Status\n\nActive'
mem edit analytics-database-choice --tag "area/infrastructure"
mem edit analytics-service --append $'Key decision: [[analytics-database-choice]]'
```

### Retrieving knowledge

When the user asks "what do I know about X?":

```bash
mem search "X" --json                    # Find relevant notes
mem show <slug> --json                   # Read each note's content
mem backlinks <slug> --json              # Find what links to it
# Synthesize across results and present to user
```

### Maintaining the knowledge graph

```bash
mem suggest-links <slug> --json          # Find unlinked mentions → add links
mem doctor                               # Check vault health
# Build hub notes for major topics (permanent notes that are mostly links)
```

## Anti-patterns

- **Essays in fleeting notes** — split into permanent notes
- **Notes without links** — add `[[wikilinks]]` to at least one other note
- **Vague titles** — be specific: "Auth migration decision" not "Decision"
- **Duplicating information** — search first, use `--append` on existing notes
- **Ignoring suggest-links** — if it detects a mention, link it
- **Tags instead of links** — if it's a relationship, use a `[[wikilink]]`
- **Creating without searching** — always check if a related note exists first
